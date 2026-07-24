-- ════════════════════════════════════════════════════════════════════
-- 189 · Rescate de pedidos delivery HUÉRFANOS al conectarse un rider
-- ════════════════════════════════════════════════════════════════════
-- BUG (crítico): si entran pedidos de delivery cuando NO hay ningún rider
-- conectado (todos offline), assign_delivery_order (mig 156) / create_order
-- (mig 131) devuelven "no_rider" y el pedido queda HUÉRFANO:
--     rider_id IS NULL, rider_status = 'pending'.
-- Cuando después un rider se pone EN LÍNEA (disponible), el único despacho que
-- corría era rebalance_delivery_dispatch — pero ese SÓLO mueve pedidos ya
-- asignados (confirmed + rider en ruta). Los huérfanos (sin rider) NO los
-- tocaba nunca → el pedido quedaba "en la nada", sin repartidor, para siempre.
--
-- FIX (server-side, autoritativo, sin depender del frontend):
--   1) _sweep_unassigned_delivery(restaurant): barre los pedidos de delivery
--      sin rider (más antiguo primero) y los pasa por assign_delivery_order,
--      que elige rider DISPONIBLE (y sólo si no hay, encola al EN RUTA).
--   2) TRIGGER en delivery_riders: al transicionar current_status → 'disponible'
--      (ponerse "En línea" o terminar una ruta), dispara el barrido. Como el
--      recién conectado suele ser el único disponible, se lleva la cola huérfana
--      → "el primero en conectarse recibe los pedidos". Best-effort: nunca
--      bloquea el ponerse en línea si el despacho falla.
--   3) rebalance_delivery_dispatch: barre huérfanos ANTES de rebalancear, para
--      que el botón "Rebalancear" del admin también los rescate.
--   4) claim_unassigned_delivery_orders(restaurant): RPC con chequeo de auth,
--      por si algún panel quiere forzar el rescate a mano.
--
-- Sin cambios de frontend: el panel de pedidos ya muestra "Sin asignar"
-- mientras rider_id es NULL; sólo faltaba que el rescate ocurriera en el
-- servidor al conectarse el rider.
-- ════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────
-- _sweep_unassigned_delivery(restaurant) — INTERNA (sin chequeo de auth)
-- ────────────────────────────────────────────────────────────────────
-- Reasignación real. NO se otorga a ningún rol: sólo la llaman el trigger y
-- los wrappers con autorización (claim_… y rebalance_…). Idempotente y
-- atómica: cada assign_delivery_order hace SELECT ... FOR UPDATE del pedido.
CREATE OR REPLACE FUNCTION public._sweep_unassigned_delivery(p_restaurant_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_oid     uuid;
  v_res     jsonb;
  v_claimed int := 0;
BEGIN
  -- Sólo pedidos de DELIVERY realmente huérfanos y aún repartibles.
  -- (pickup/llevar no llevan rider; delivered/cancelled/on_way se excluyen.)
  FOR v_oid IN
    SELECT o.id
      FROM delivery_orders o
     WHERE o.restaurant_id = p_restaurant_id
       AND o.rider_id IS NULL
       AND o.order_type = 'delivery'
       AND o.rider_status IN ('pending', 'confirmed')
     ORDER BY o.created_at ASC
  LOOP
    v_res := public.assign_delivery_order(v_oid);
    IF COALESCE((v_res->>'ok')::boolean, false) THEN
      v_claimed := v_claimed + 1;
    ELSIF (v_res->>'reason') = 'no_rider' THEN
      -- Ya no queda ningún rider elegible: el resto sigue huérfano (toma manual).
      EXIT;
    END IF;
    -- Otros motivos ('not_assignable', 'not_found'): saltar ese pedido y seguir.
  END LOOP;

  RETURN v_claimed;
END;
$$;

-- ────────────────────────────────────────────────────────────────────
-- Trigger: rescatar huérfanos cuando un rider se pone DISPONIBLE
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._claim_orphans_on_rider_online()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Best-effort: ponerse "En línea" NUNCA debe fallar por un problema de despacho.
  BEGIN
    PERFORM public._sweep_unassigned_delivery(NEW.restaurant_id);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL; -- AFTER trigger
END;
$$;

DROP TRIGGER IF EXISTS trg_claim_orphans_on_rider_online ON public.delivery_riders;
CREATE TRIGGER trg_claim_orphans_on_rider_online
AFTER UPDATE OF current_status ON public.delivery_riders
FOR EACH ROW
WHEN (
  NEW.current_status = 'disponible'
  AND NEW.current_status IS DISTINCT FROM OLD.current_status
  AND NEW.active IS NOT FALSE
)
EXECUTE FUNCTION public._claim_orphans_on_rider_online();

-- ────────────────────────────────────────────────────────────────────
-- claim_unassigned_delivery_orders(restaurant) — RPC con auth (uso manual)
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_unassigned_delivery_orders(p_restaurant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Autorización: superadmin, admin del local, o un rider de ese local.
  IF NOT (
    public.get_my_role() = 'superadmin'
    OR public.get_my_restaurant_id() = p_restaurant_id
    OR EXISTS (SELECT 1 FROM delivery_riders
                 WHERE user_id = auth.uid() AND restaurant_id = p_restaurant_id)
  ) THEN
    RETURN jsonb_build_object('claimed', 0, 'reason', 'forbidden');
  END IF;

  RETURN jsonb_build_object('claimed', public._sweep_unassigned_delivery(p_restaurant_id));
END;
$$;

-- ────────────────────────────────────────────────────────────────────
-- rebalance_delivery_dispatch(restaurant) — ahora RESCATA antes de mover
-- ────────────────────────────────────────────────────────────────────
-- Idéntico a mig 156, con un paso previo: reclamar los huérfanos. Así el
-- botón "Rebalancear" del admin también los rescata.
CREATE OR REPLACE FUNCTION public.rebalance_delivery_dispatch(p_restaurant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_moved      int := 0;
  v_claimed    int := 0;
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
    RETURN jsonb_build_object('moved', 0, 'claimed', 0, 'reason', 'forbidden');
  END IF;

  -- PASO 0 (NUEVO): rescatar pedidos huérfanos (sin rider) antes de rebalancear.
  v_claimed := public._sweep_unassigned_delivery(p_restaurant_id);

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

  RETURN jsonb_build_object('moved', v_moved, 'claimed', v_claimed);
END;
$$;

-- ── Grants ──
-- claim: riders (al conectarse) y admin — nunca anon (es un barrido masivo).
GRANT EXECUTE ON FUNCTION public.claim_unassigned_delivery_orders(uuid) TO authenticated;
-- _sweep_… es interna: la usan el trigger y los wrappers. Sin grant a anon/authenticated.
REVOKE ALL ON FUNCTION public._sweep_unassigned_delivery(uuid) FROM PUBLIC;

-- Refrescar el esquema de PostgREST para exponer la RPC de inmediato.
NOTIFY pgrst, 'reload schema';
