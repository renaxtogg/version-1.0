-- ════════════════════════════════════════════════════════════════════
-- 156 · Despacho + rebalanceo de riders (delivery propio)
-- ════════════════════════════════════════════════════════════════════
-- Centraliza la asignación pedido→rider en el servidor (antes había 3
-- implementaciones cliente que competían: delivery-cliente, cocina, admin).
-- SECURITY DEFINER + FOR UPDATE = atómico, sin doble asignación.
--
-- CONSERVA el comportamiento verificado en vivo:
--   (a) pedido nuevo → rider DISPONIBLE.
--   (b) si no hay disponible → se acumula al rider EN RUTA en su cola
--       "próximo viaje" (rider_status='confirmed'), SIN inyectarse en la
--       ruta activa (la ruta activa son los 'on_way', que no se tocan).
--
-- Reglas:
--   1. ≥1 rider DISPONIBLE → asignar; desempate = menos pedidos HOY.
--   2. Sin disponible → al rider EN RUTA (cola próximo viaje); mismo desempate.
--   3. Nunca dividir un pedido; nunca asignar a un rider Offline/inactivo.
--
-- Rebalanceo (cuando un rider se pone DISPONIBLE):
--   - Mueve pedidos TRANSFERIBLES (confirmed + NO recogidos) de riders en
--     ruta hacia el/los recién disponible(s), equilibrando la carga.
--   - BLOQUEADO = ya recogido / en ruta activa (on_way) → jamás se transfiere.
--
-- Scope: todo por restaurant_id. Los riders sólo reciben pedidos de SU local.
-- ════════════════════════════════════════════════════════════════════

-- ── Config admin: máximo de pedidos en cola por rider (alerta) ──
-- Vive en delivery_settings (mig 124). NULL / 0 = sin límite.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'delivery_settings'
  ) THEN
    ALTER TABLE public.delivery_settings
      ADD COLUMN IF NOT EXISTS max_orders_per_rider integer;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- assign_delivery_order(order) — asignación al entrar un pedido
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.assign_delivery_order(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ord    delivery_orders%ROWTYPE;
  v_rid    uuid;
  v_rname  text;
  v_reason text := 'disponible';
BEGIN
  SELECT * INTO v_ord FROM delivery_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- Idempotente: si ya tiene rider, no reasignar (cierra la carrera entre
  -- los 3 puntos de entrada que llaman esta RPC para el mismo pedido).
  IF v_ord.rider_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_assigned',
                              'rider_id', v_ord.rider_id, 'rider_name', v_ord.rider_name);
  END IF;

  -- Sólo se auto-asigna un pedido aún sin repartir (no entregado/cancelado).
  IF v_ord.rider_status NOT IN ('pending', 'confirmed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_assignable',
                              'rider_status', v_ord.rider_status);
  END IF;

  -- 1) Preferir un rider DISPONIBLE. Desempate: menos pedidos HOY, luego menor
  --    carga activa, luego id (determinista). Hora local de Paraguay para el "hoy".
  SELECT r.id, r.name INTO v_rid, v_rname
  FROM delivery_riders r
  WHERE r.restaurant_id = v_ord.restaurant_id
    AND r.active IS NOT FALSE
    AND COALESCE(r.current_status, 'disponible') = 'disponible'
  ORDER BY
    (SELECT count(*) FROM delivery_orders o2
       WHERE o2.rider_id = r.id AND o2.assigned_at IS NOT NULL
         AND (o2.assigned_at AT TIME ZONE 'America/Asuncion')::date
             = (now() AT TIME ZONE 'America/Asuncion')::date) ASC,
    (SELECT count(*) FROM delivery_orders o3
       WHERE o3.rider_id = r.id AND o3.rider_status IN ('confirmed', 'on_way')) ASC,
    r.id ASC
  LIMIT 1;

  -- 2) Sin disponible → al rider EN RUTA (cola "próximo viaje"). Mismo desempate.
  IF v_rid IS NULL THEN
    v_reason := 'en_ruta';
    SELECT r.id, r.name INTO v_rid, v_rname
    FROM delivery_riders r
    WHERE r.restaurant_id = v_ord.restaurant_id
      AND r.active IS NOT FALSE
      AND COALESCE(r.current_status, 'disponible') = 'en_ruta'
    ORDER BY
      (SELECT count(*) FROM delivery_orders o2
         WHERE o2.rider_id = r.id AND o2.assigned_at IS NOT NULL
           AND (o2.assigned_at AT TIME ZONE 'America/Asuncion')::date
               = (now() AT TIME ZONE 'America/Asuncion')::date) ASC,
      (SELECT count(*) FROM delivery_orders o3
         WHERE o3.rider_id = r.id AND o3.rider_status IN ('confirmed', 'on_way')) ASC,
      r.id ASC
    LIMIT 1;
  END IF;

  -- 3) Nadie elegible (todos offline / inactivos): queda sin asignar (toma manual).
  IF v_rid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_rider');
  END IF;

  UPDATE delivery_orders SET
    rider_id     = v_rid,
    rider_name   = v_rname,
    rider_status = 'confirmed',   -- entra en la cola "próximo viaje" del rider
    status       = 'assigned',
    assigned_at  = now()
  WHERE id = p_order_id;

  RETURN jsonb_build_object('ok', true, 'reason', v_reason,
                            'rider_id', v_rid, 'rider_name', v_rname);
END;
$$;

-- ════════════════════════════════════════════════════════════════════
-- rebalance_delivery_dispatch(restaurant) — al ponerse un rider DISPONIBLE
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.rebalance_delivery_dispatch(p_restaurant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_moved      int := 0;
  v_recv       uuid;
  v_recv_name  text;
  v_recv_load  int;
  v_oid        uuid;
  v_owner_load int;
  i            int;
BEGIN
  -- Autorización: superadmin, admin del local, o un rider de ese local.
  IF NOT (
    public.get_my_role() = 'superadmin'
    OR public.get_my_restaurant_id() = p_restaurant_id
    OR EXISTS (SELECT 1 FROM delivery_riders
                 WHERE user_id = auth.uid() AND restaurant_id = p_restaurant_id)
  ) THEN
    RETURN jsonb_build_object('moved', 0, 'reason', 'forbidden');
  END IF;

  -- Un movimiento por iteración: siempre al receptor disponible menos cargado,
  -- desde el rider en ruta más cargado. Se detiene al equilibrar (no vacía a uno
  -- solo). Cap de 200 = tope de seguridad ante datos inconsistentes.
  FOR i IN 1..200 LOOP
    -- Receptor: rider DISPONIBLE con menor carga activa (desempate: menos hoy).
    SELECT r.id, r.name,
           (SELECT count(*) FROM delivery_orders o
              WHERE o.rider_id = r.id AND o.rider_status IN ('confirmed', 'on_way'))
      INTO v_recv, v_recv_name, v_recv_load
    FROM delivery_riders r
    WHERE r.restaurant_id = p_restaurant_id
      AND r.active IS NOT FALSE
      AND COALESCE(r.current_status, 'disponible') = 'disponible'
    ORDER BY
      (SELECT count(*) FROM delivery_orders o
         WHERE o.rider_id = r.id AND o.rider_status IN ('confirmed', 'on_way')) ASC,
      (SELECT count(*) FROM delivery_orders o2
         WHERE o2.rider_id = r.id AND o2.assigned_at IS NOT NULL
           AND (o2.assigned_at AT TIME ZONE 'America/Asuncion')::date
               = (now() AT TIME ZONE 'America/Asuncion')::date) ASC,
      r.id ASC
    LIMIT 1;

    EXIT WHEN v_recv IS NULL;

    -- Pedido TRANSFERIBLE: confirmado, NO recogido, cuyo dueño está EN RUTA.
    SELECT o.id, ld.owner_load INTO v_oid, v_owner_load
    FROM delivery_orders o
    JOIN delivery_riders rr ON rr.id = o.rider_id
    CROSS JOIN LATERAL (
      SELECT count(*) AS owner_load FROM delivery_orders o2
       WHERE o2.rider_id = o.rider_id AND o2.rider_status IN ('confirmed', 'on_way')
    ) ld
    WHERE o.restaurant_id = p_restaurant_id
      AND o.rider_status = 'confirmed'
      AND o.picked_up_at IS NULL
      AND rr.active IS NOT FALSE
      AND COALESCE(rr.current_status, 'disponible') = 'en_ruta'
    ORDER BY ld.owner_load DESC, o.created_at ASC
    LIMIT 1;

    EXIT WHEN v_oid IS NULL;

    -- Equilibrio: no mover si el dueño no queda más cargado que el receptor
    -- (evita ping-pong y vaciar la cola de un solo rider).
    EXIT WHEN v_owner_load <= v_recv_load + 1;

    UPDATE delivery_orders SET
      rider_id    = v_recv,
      rider_name  = v_recv_name,
      assigned_at = now()
      -- rider_status sigue 'confirmed' → cola "próximo viaje" del receptor.
    WHERE id = v_oid;

    v_moved := v_moved + 1;
  END LOOP;

  RETURN jsonb_build_object('moved', v_moved);
END;
$$;

-- ════════════════════════════════════════════════════════════════════
-- transfer_delivery_order(order, rider) — transferencia manual del admin
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.transfer_delivery_order(p_order_id uuid, p_rider_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ord   delivery_orders%ROWTYPE;
  v_rname text;
BEGIN
  SELECT * INTO v_ord FROM delivery_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- Autorización: superadmin o admin del local del pedido.
  IF NOT (
    public.get_my_role() = 'superadmin'
    OR public.get_my_restaurant_id() = v_ord.restaurant_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  -- Sólo TRANSFERIBLES: en cola (confirmed) y NO recogidos. Un pedido ya en el
  -- bolsón del rider (on_way / picked_up_at) queda BLOQUEADO.
  IF v_ord.rider_status <> 'confirmed' OR v_ord.picked_up_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_transferable');
  END IF;

  -- Rider destino válido: mismo local, activo, no offline.
  SELECT name INTO v_rname
  FROM delivery_riders
  WHERE id = p_rider_id
    AND restaurant_id = v_ord.restaurant_id
    AND active IS NOT FALSE
    AND COALESCE(current_status, 'disponible') <> 'offline';
  IF v_rname IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_rider');
  END IF;

  UPDATE delivery_orders SET
    rider_id    = p_rider_id,
    rider_name  = v_rname,
    assigned_at = now()
  WHERE id = p_order_id;

  RETURN jsonb_build_object('ok', true, 'rider_id', p_rider_id, 'rider_name', v_rname);
END;
$$;

-- ── Grants ──
-- assign: lo llaman delivery-cliente (anon) al crear, cocina y admin (auth).
GRANT EXECUTE ON FUNCTION public.assign_delivery_order(uuid)          TO anon, authenticated;
-- rebalance: riders (al ponerse disponible) y admin — nunca anon.
GRANT EXECUTE ON FUNCTION public.rebalance_delivery_dispatch(uuid)    TO authenticated;
-- transfer: sólo admin/superadmin (validado adentro).
GRANT EXECUTE ON FUNCTION public.transfer_delivery_order(uuid, uuid)  TO authenticated;

-- Refrescar el esquema de PostgREST para exponer las RPCs de inmediato.
NOTIFY pgrst, 'reload schema';
