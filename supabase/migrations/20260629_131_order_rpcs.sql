-- ═══════════════════════════════════════════════════════════════════
-- 131 · RPCs SECURITY DEFINER para crear y seguir pedidos (anon)
-- ───────────────────────────────────────────────────────────────────
-- ETAPA 1 de 3 del cierre final del leak de orders (Fase 2+3, Nivel 2).
-- ADITIVA y SEGURA DE APLICAR YA: solo crea funciones; no cambia ningún
-- privilegio ni policy. El lockdown (ETAPA 3) va en una migración aparte,
-- DESPUÉS de deployar y verificar los clientes (ETAPA 2).
--
-- Mueve crear+seguir pedido a funciones con derechos del DEFINER (postgres),
-- para poder sacarle a anon el acceso DIRECTO a orders/order_items/
-- delivery_orders (que hoy filtran total/payment_status/precios cross-tenant
-- por REST y por realtime) sin romper el flujo del cliente.
--
-- Replica EXACTAMENTE los inserts de src/index/main.jsx (dbSubmitOrder) y
-- src/delivery-cliente/main.jsx (dbSubmitDeliveryOrder + dbAutoAssignRider).
-- Staff (authenticated) NO se toca.
-- ═══════════════════════════════════════════════════════════════════
BEGIN;

-- ── create_order(payload jsonb) ─────────────────────────────────────
-- Inserta orders + order_items + order_item_extras (+ delivery_orders y
-- auto-asignación best-effort de rider en el flujo delivery) de forma atómica.
-- Devuelve {id, order_number, status}. Valida coherencia restaurant_id/table_id.
CREATE OR REPLACE FUNCTION public.create_order(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rid        uuid    := NULLIF(payload->>'restaurant_id','')::uuid;
  v_table_id   uuid    := NULLIF(payload->>'table_id','')::uuid;
  v_order_type text    := COALESCE(NULLIF(payload->>'order_type',''),'local');
  v_order_num  text    := NULLIF(payload->>'order_number','');
  v_status     text    := COALESCE(NULLIF(payload->>'status',''),'paid');
  v_total      numeric := COALESCE((payload->>'total')::numeric, 0);
  v_subtotal   numeric := COALESCE((payload->>'subtotal')::numeric, 0);
  v_req_inv    boolean := COALESCE((payload->>'requires_invoice')::boolean, false);
  v_email      text    := NULLIF(payload->>'customer_email','');
  v_items      jsonb   := COALESCE(payload->'items','[]'::jsonb);
  v_delivery   jsonb   := payload->'delivery';
  v_order_id   uuid;
  v_item       jsonb;
  v_oi_id      uuid;
  v_extra      jsonb;
  v_deliv_id   uuid;
  v_rider      record;
BEGIN
  -- Validaciones de coherencia (fail-closed).
  IF v_rid IS NULL THEN RAISE EXCEPTION 'restaurant_id requerido' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = v_rid) THEN
    RAISE EXCEPTION 'restaurante inexistente' USING ERRCODE='22023';
  END IF;
  IF v_table_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.tables t WHERE t.id = v_table_id AND t.restaurant_id = v_rid) THEN
    RAISE EXCEPTION 'la mesa no pertenece al restaurante' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'el pedido no tiene items' USING ERRCODE='22023';
  END IF;
  IF v_total <= 0 THEN RAISE EXCEPTION 'total invalido' USING ERRCODE='22023'; END IF;

  -- order_number: lo genera el cliente; si falta, lo armamos con el mismo formato.
  IF v_order_num IS NULL THEN
    v_order_num := CASE WHEN v_order_type IN ('delivery','pickup','llevar') THEN 'D-' ELSE 'T-' END
                   || (10000 + floor(random()*90000))::int::text;
  END IF;

  -- 1) orders
  INSERT INTO public.orders (
    restaurant_id, table_id, order_number, order_type, status,
    subtotal, discount_amount, coupon_code, total, payment_method,
    customer_name, customer_ruc, customer_email, requires_invoice, language,
    invoice_delivery_method, invoice_requested_at, invoice_status
  ) VALUES (
    v_rid, v_table_id, v_order_num, v_order_type, v_status,
    v_subtotal, COALESCE((payload->>'discount_amount')::numeric, 0), NULLIF(payload->>'coupon_code',''),
    v_total, NULLIF(payload->>'payment_method',''),
    NULLIF(payload->>'customer_name',''), NULLIF(payload->>'customer_ruc',''), v_email,
    v_req_inv, COALESCE(NULLIF(payload->>'language',''), 'es'),  -- delivery no manda language → default 'es' (igual que la columna)
    CASE WHEN v_req_inv THEN COALESCE(NULLIF(payload->>'invoice_delivery_method',''),
                                      CASE WHEN v_email IS NOT NULL THEN 'email' ELSE 'print' END) END,
    CASE WHEN v_req_inv THEN now() END,
    CASE WHEN v_req_inv THEN 'pending' END
  ) RETURNING id INTO v_order_id;

  -- 2) order_items + order_item_extras
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items)
  LOOP
    INSERT INTO public.order_items (order_id, item_id, item_name, quantity, unit_price, total_price, observations)
    VALUES (
      v_order_id,
      NULLIF(v_item->>'item_id','')::int,
      v_item->>'item_name',
      COALESCE((v_item->>'quantity')::int, 1),
      COALESCE((v_item->>'unit_price')::numeric, 0),
      COALESCE((v_item->>'total_price')::numeric, 0),
      NULLIF(v_item->>'observations','')
    ) RETURNING id INTO v_oi_id;

    IF jsonb_typeof(v_item->'extras') = 'array' THEN
      FOR v_extra IN SELECT * FROM jsonb_array_elements(v_item->'extras')
      LOOP
        INSERT INTO public.order_item_extras (order_item_id, extra_name, extra_price)
        VALUES (v_oi_id, v_extra->>'extra_name', COALESCE((v_extra->>'extra_price')::numeric, 0));
      END LOOP;
    END IF;
  END LOOP;

  -- 3) delivery_orders (+ auto-assign best-effort) para el flujo delivery/pickup
  IF v_delivery IS NOT NULL AND jsonb_typeof(v_delivery) = 'object' THEN
    INSERT INTO public.delivery_orders (
      order_id, restaurant_id, order_type, order_number, order_total,
      customer_name, customer_phone, delivery_address, delivery_detail, delivery_references,
      zone_id, zone_name, delivery_fee, estimated_minutes, canal, status, cash_amount,
      delivery_corner, delivery_lat, delivery_lng
    ) VALUES (
      v_order_id, v_rid, NULLIF(v_delivery->>'order_type',''), v_order_num,
      COALESCE((v_delivery->>'order_total')::numeric, v_total),
      NULLIF(v_delivery->>'customer_name',''), NULLIF(v_delivery->>'customer_phone',''),
      NULLIF(v_delivery->>'delivery_address',''), NULLIF(v_delivery->>'delivery_detail',''),
      NULLIF(v_delivery->>'delivery_references',''),
      NULLIF(v_delivery->>'zone_id','')::uuid, NULLIF(v_delivery->>'zone_name',''),
      COALESCE((v_delivery->>'delivery_fee')::numeric, 0), NULLIF(v_delivery->>'estimated_minutes','')::int,
      COALESCE(NULLIF(v_delivery->>'canal',''),'web'), 'pending', NULLIF(v_delivery->>'cash_amount','')::numeric,
      NULLIF(v_delivery->>'delivery_corner',''),
      NULLIF(v_delivery->>'delivery_lat','')::numeric,
      NULLIF(v_delivery->>'delivery_lng','')::numeric
    ) RETURNING id INTO v_deliv_id;

    -- Auto-asignación de rider (round-robin: el menos-recientemente-asignado).
    -- Best-effort: NUNCA aborta el pedido (igual que el cliente actual).
    IF (v_delivery->>'order_type') = 'delivery' THEN
      BEGIN
        SELECT dr.id, dr.name INTO v_rider
          FROM public.delivery_riders dr
         WHERE dr.restaurant_id = v_rid AND dr.active = true AND dr.current_status <> 'offline'
         ORDER BY (SELECT max(d2.assigned_at) FROM public.delivery_orders d2
                    WHERE d2.rider_id = dr.id AND d2.restaurant_id = v_rid) ASC NULLS FIRST
         LIMIT 1;
        IF FOUND THEN
          UPDATE public.delivery_orders
             SET rider_id = v_rider.id, rider_name = v_rider.name,
                 rider_status = 'confirmed', status = 'assigned', assigned_at = now()
           WHERE id = v_deliv_id;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        NULL; -- best-effort
      END;
    END IF;
  END IF;

  -- 4) order_status_history (al final, igual que el cliente)
  INSERT INTO public.order_status_history (order_id, status, changed_by)
  VALUES (v_order_id, v_status, 'customer');

  RETURN jsonb_build_object('id', v_order_id, 'order_number', v_order_num, 'status', v_status);
END;
$$;

-- ── get_order_status(p_order_number, p_restaurant_id) ───────────────
-- Devuelve SOLO {order_number, status, rider_status}. NADA financiero.
-- Scoped por restaurant_id (evita enumerar/colisionar pedidos de otros locales).
-- 0 filas = el pedido no existe (el cliente lo usa para purgar su estado local).
CREATE OR REPLACE FUNCTION public.get_order_status(p_order_number text, p_restaurant_id uuid)
RETURNS TABLE (order_number text, status text, rider_status text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT o.order_number, o.status,
         (SELECT d.rider_status FROM public.delivery_orders d
           WHERE d.order_id = o.id ORDER BY d.created_at DESC LIMIT 1)
    FROM public.orders o
   WHERE o.order_number = p_order_number
     AND o.restaurant_id = p_restaurant_id
   LIMIT 1;
$$;

-- anon (cliente QR/delivery) y authenticated pueden ejecutarlas.
GRANT EXECUTE ON FUNCTION public.create_order(jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_order_status(text, uuid) TO anon, authenticated;

COMMIT;

-- Recargar el cache de esquema de PostgREST para exponer las RPC.
NOTIFY pgrst, 'reload schema';

SELECT 'migracion 131 aplicada (RPCs create_order + get_order_status)' AS status;
