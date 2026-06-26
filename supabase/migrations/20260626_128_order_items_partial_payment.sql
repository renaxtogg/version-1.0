-- ════════════════════════════════════════════════════════════════════
-- 128 · order_items.paid_quantity · PAGO PARCIAL POR ÍTEM (cobro por mesa)
-- ────────────────────────────────────────────────────────────────────
-- Permite que cada comensal pague lo suyo: la caja cobra ítems sueltos de
-- una mesa. `paid_quantity` lleva cuántas unidades de cada ítem ya se cobraron.
--   · Ítem saldado  cuando paid_quantity = quantity.
--   · Pedido saldado cuando TODOS sus ítems lo están → recién ahí orders.payment_status='paid'.
--   · Mesa saldada   cuando todos sus pedidos lo están.
--
-- Backfill: los pedidos YA pagados (payment_status='paid') quedan con sus
-- ítems 100% saldados, para no reabrir cobros viejos.
--
-- 100% ADITIVA + IDEMPOTENTE. order_items NO tiene restaurant_id propio: su
-- RLS/multi-tenant se hereda del pedido padre (oi_auth_* en mig 092, scoped a
-- get_my_company_restaurant_ids()). La columna nueva hereda esos permisos —
-- no se otorga nada nuevo a anon. No toca otras tablas.
--
-- ⚠ PREPARED — aplicar manualmente en el SQL Editor (en INGLÉS) tras backup;
--   Claude Code NO aplica migraciones.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS paid_quantity int NOT NULL DEFAULT 0;

-- Backfill: ítems de pedidos ya cobrados quedan saldados (idempotente: sólo los
-- que aún están en 0). Debe ir ANTES del CHECK (deja paid_quantity ≤ quantity).
UPDATE public.order_items oi
   SET paid_quantity = oi.quantity
  FROM public.orders o
 WHERE o.id = oi.order_id
   AND o.payment_status = 'paid'
   AND oi.paid_quantity = 0;

-- Backstop server-side: paid_quantity nunca puede pasar de quantity ni ser
-- negativo. Refuerza el guard anti-doble-cobro (idempotente).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_paid_qty_chk') THEN
    ALTER TABLE public.order_items
      ADD CONSTRAINT order_items_paid_qty_chk
      CHECK (paid_quantity >= 0 AND paid_quantity <= quantity);
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- RPC cobro_mesa_parcial: cobro por mesa + pago parcial por ítem, ATÓMICO.
-- ────────────────────────────────────────────────────────────────────
-- Hace TODO en UNA transacción (evita cobros a medias o caja descuadrada):
--   1. Bloquea cada order_item (FOR UPDATE) → anti-doble-cobro real entre cajas.
--   2. Suma paid_quantity por el delta aplicable (clamp a quantity); descarta lo
--      ya cobrado por otra caja.
--   3. Por cada pedido de la mesa que quede 100% saldado → payment_status='paid',
--      transición de status (confirmed→paid / pending_payment+entregado→delivered),
--      total = mayor(total, suma con extras), factura 'issued' si requires_invoice.
--      (También salda pedidos cuyos ítems ya estaban completos — barrido defensivo.)
--   4. Inserta UN movimiento (tipo='cobro') por la suma realmente cobrada.
--   5. Si la mesa quedó saldada del todo → marca waiter_calls payment_request atendidas.
-- Dinero por unidad = total_price/quantity (incluye extras) o unit_price.
-- Tenant-safe: sólo el restaurante del usuario (o superadmin). p_items = [{item_id,qty}].
-- Devuelve { applied:[{nombre,cantidad,precio}], sub, mesa_saldada, movimiento_id }.
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cobro_mesa_parcial(
  p_restaurant_id uuid,
  p_turno_id      uuid,
  p_table_id      uuid,
  p_items         jsonb,
  p_metodo        text,
  p_monto_pagado  numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item        jsonb;
  v_iid         uuid;
  v_req         int;
  r             record;
  v_apply       int;
  v_eff         numeric;
  v_sub         numeric := 0;
  v_applied     jsonb := '[]'::jsonb;
  v_order_ids   uuid[] := '{}';
  v_oid         uuid;
  v_mov_id      uuid;
  v_mesa_ok     boolean;
  v_cajero      text;
  v_pending     int;
  v_items_total numeric;
  v_status      text;
  v_delivered   timestamptz;
  v_req_inv     boolean;
  v_inv_method  text;
  v_cur_total   numeric;
  v_order_pm    text;
BEGIN
  -- Tenant guard (fail-closed).
  IF NOT COALESCE(
       public.get_my_role() = 'superadmin'
       OR p_restaurant_id IN (SELECT public.get_my_company_restaurant_ids()),
       false) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  -- Turno abierto del restaurante.
  PERFORM 1 FROM public.turnos_caja t
   WHERE t.id = p_turno_id AND t.restaurant_id = p_restaurant_id AND t.estado = 'abierto';
  IF NOT FOUND THEN RAISE EXCEPTION 'turno_invalido' USING ERRCODE = 'check_violation'; END IF;

  SELECT display_name INTO v_cajero FROM public.user_roles WHERE user_id = auth.uid() LIMIT 1;
  -- orders.payment_method tiene su propio CHECK ('efectivo','tarjeta','qr','pos','pos_mesa','transferencia'),
  -- distinto del de movimientos_caja. Mapeamos para no abortar la transacción con tarjeta/mixto.
  v_order_pm := CASE WHEN p_metodo LIKE 'tarjeta%' THEN 'tarjeta'
                     WHEN p_metodo IN ('gift_card','cuenta_corriente','mixto') THEN 'pos'
                     ELSE p_metodo END;

  -- 1+2) Aplicar cada ítem con bloqueo de fila.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_iid := (v_item->>'item_id')::uuid;
    v_req := GREATEST(0, COALESCE((v_item->>'qty')::int, 0));
    IF v_req <= 0 THEN CONTINUE; END IF;
    SELECT oi.id, oi.order_id, oi.quantity, oi.paid_quantity, oi.unit_price, oi.total_price, oi.item_name
      INTO r
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
     WHERE oi.id = v_iid AND o.restaurant_id = p_restaurant_id AND o.table_id = p_table_id
     FOR UPDATE OF oi;
    IF NOT FOUND THEN CONTINUE; END IF;
    v_apply := LEAST(v_req, r.quantity - r.paid_quantity);
    IF v_apply <= 0 THEN CONTINUE; END IF;
    v_eff := CASE WHEN COALESCE(r.total_price,0) > 0 AND r.quantity > 0
                  THEN round(r.total_price / r.quantity)
                  ELSE COALESCE(r.unit_price,0) END;
    UPDATE public.order_items SET paid_quantity = paid_quantity + v_apply WHERE id = r.id;
    v_sub := v_sub + v_apply * v_eff;
    v_applied := v_applied || jsonb_build_object('nombre', r.item_name, 'cantidad', v_apply, 'precio', v_eff);
    IF NOT (r.order_id = ANY(v_order_ids)) THEN v_order_ids := array_append(v_order_ids, r.order_id); END IF;
  END LOOP;

  IF jsonb_array_length(v_applied) = 0 THEN
    RETURN jsonb_build_object('applied','[]'::jsonb,'sub',0,'mesa_saldada',false,'movimiento_id',NULL);
  END IF;

  -- 3) Saldar pedidos de la mesa: los tocados ahora Y cualquiera ya completo por ítems.
  FOR v_oid IN
    SELECT o.id FROM public.orders o
     WHERE o.restaurant_id = p_restaurant_id AND o.table_id = p_table_id
       AND o.payment_status IS DISTINCT FROM 'paid'
       AND o.status IN ('confirmed','paid','pending_payment','kitchen_received','cooking','ready','delivered')
       AND ( o.id = ANY(v_order_ids)
             OR NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.order_id = o.id AND oi.paid_quantity < oi.quantity) )
  LOOP
    SELECT count(*) FILTER (WHERE oi.paid_quantity < oi.quantity),
           COALESCE(SUM(CASE WHEN COALESCE(oi.total_price,0) > 0 THEN oi.total_price
                             ELSE oi.quantity * COALESCE(oi.unit_price,0) END), 0)
      INTO v_pending, v_items_total
      FROM public.order_items oi WHERE oi.order_id = v_oid;
    SELECT o.status, o.delivered_to_table_at, o.requires_invoice, o.invoice_delivery_method, COALESCE(o.total,0)
      INTO v_status, v_delivered, v_req_inv, v_inv_method, v_cur_total
      FROM public.orders o WHERE o.id = v_oid FOR UPDATE;
    IF v_pending = 0 THEN
      UPDATE public.orders SET
        payment_status = 'paid',
        payment_method = v_order_pm,
        total          = GREATEST(v_cur_total, v_items_total),
        status         = CASE WHEN v_status = 'confirmed' THEN 'paid'
                              WHEN v_status = 'pending_payment' AND v_delivered IS NOT NULL THEN 'delivered'
                              ELSE v_status END,
        completed_at   = CASE WHEN v_status = 'pending_payment' AND v_delivered IS NOT NULL THEN now() ELSE completed_at END,
        invoice_status = CASE WHEN v_req_inv THEN 'issued' ELSE invoice_status END,
        invoice_delivery_method = CASE WHEN v_req_inv THEN COALESCE(v_inv_method,'print') ELSE invoice_delivery_method END
      WHERE id = v_oid;
      IF v_status = 'confirmed' THEN
        -- order_status_history(order_id,status,changed_at,changed_by) — NO existe columna 'notes'.
        INSERT INTO public.order_status_history(order_id,status,changed_by)
        VALUES (v_oid,'paid','caja');
      END IF;
    ELSE
      UPDATE public.orders SET total = GREATEST(v_cur_total, v_items_total), payment_method = v_order_pm WHERE id = v_oid;
    END IF;
  END LOOP;

  -- 4) UN movimiento por lo realmente cobrado.
  INSERT INTO public.movimientos_caja(turno_id,restaurant_id,tipo,monto,metodo_pago,pedido_id,descripcion,usuario_id,usuario_nombre,metadata)
  VALUES (p_turno_id, p_restaurant_id, 'cobro', v_sub, p_metodo, NULL,
          'Cobro Mesa — ' || (SELECT COALESCE(SUM((e->>'cantidad')::int),0) FROM jsonb_array_elements(v_applied) e) || ' ítem(s)',
          auth.uid(), v_cajero,
          jsonb_build_object('table_id', p_table_id, 'items', v_applied, 'pedidos', to_jsonb(v_order_ids),
                             'monto_pagado', COALESCE(p_monto_pagado, v_sub)))
  RETURNING id INTO v_mov_id;

  -- 5) ¿Mesa saldada del todo? → waiter_calls payment_request atendidas.
  SELECT NOT EXISTS (
    SELECT 1 FROM public.orders o
      JOIN public.order_items oi ON oi.order_id = o.id
     WHERE o.restaurant_id = p_restaurant_id AND o.table_id = p_table_id
       AND o.payment_status IS DISTINCT FROM 'paid'
       AND o.status IN ('confirmed','paid','pending_payment','kitchen_received','cooking','ready','delivered')
       AND oi.paid_quantity < oi.quantity
  ) INTO v_mesa_ok;
  IF v_mesa_ok THEN
    UPDATE public.waiter_calls SET status = 'attended', attended_at = now()
     WHERE restaurant_id = p_restaurant_id AND table_id = p_table_id
       AND status = 'pending' AND type = 'payment_request';
  END IF;

  RETURN jsonb_build_object('applied', v_applied, 'sub', v_sub, 'mesa_saldada', v_mesa_ok, 'movimiento_id', v_mov_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.cobro_mesa_parcial(uuid,uuid,uuid,jsonb,text,numeric) TO authenticated;

NOTIFY pgrst, 'reload schema';
