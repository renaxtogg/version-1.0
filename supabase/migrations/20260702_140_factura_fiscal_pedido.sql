-- ═══════════════════════════════════════════════════════════════════
-- 140 · Factura fiscal solicitada por el cliente (QR) → emitida por caja
-- ───────────────────────────────────────────────────────────────────
-- PR-FE-4. Conecta el botón "Factura fiscal" del cliente (index.html) con la
-- emisión autenticada desde caja. El cliente SÓLO deja registrada la SOLICITUD
-- + sus datos fiscales en el pedido; la EMISIÓN la dispara el STAFF (endpoint
-- /api/facturasend/emitir-caja, autorizado por sesión, no por secret).
--
-- POR QUÉ COLUMNAS EN orders (y no una tabla 1:1 factura_pedido):
--   • orders ya lleva la relación 1:1 con el pedido y su RLS multi-tenant
--     (orders_auth_* scoped por get_my_company_restaurant_ids, mig 086) ya
--     protege exactamente a quién queremos: el staff del restaurante. No hay
--     que crear policies nuevas ni un JOIN extra en caja.
--   • anon NO tiene NINGÚN acceso directo a orders (REVOKE + sin policies anon,
--     mig 132): crea el pedido SOLO por create_order (SECURITY DEFINER). Por
--     ende las columnas fiscales NO se exponen a anon por construcción — sin
--     GRANT nuevo, sin policy nueva. PII fiscal cerrada a anon de entrada.
--   • Se usan columnas fiscales DEDICADAS (no se reutiliza customer_*) porque el
--     flujo delivery escribe customer_name con el contacto de entrega: mezclar
--     eso con el receptor fiscal arriesgaría emitir la factura a un nombre que
--     no es el contribuyente. factura_* es, sin ambigüedad, el receptor SIFEN.
--
-- Estados de la factura a nivel pedido (coarse, distinto del ciclo detallado de
-- documentos_electronicos.estado): SOLICITADA → EMITIDA | ERROR. Lo setea:
--   • SOLICITADA: create_order, cuando el cliente pide factura fiscal.
--   • EMITIDA/ERROR: el endpoint emitir-caja, según el resultado de la emisión.
--
-- Idempotente y seguro de re-correr. Revertir:
--   ALTER TABLE public.orders DROP COLUMN IF EXISTS factura_solicitada, ... ;
--   (y restaurar create_order a la versión de la mig 131).
--
-- ⚠ PREPARED — aplicar manualmente en el SQL Editor (en INGLÉS) tras backup nuevo.
--   Claude Code NO aplica migraciones.
-- ═══════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1) Columnas fiscales en orders (aditivo, defaults seguros) ──────────────
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS factura_solicitada   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS factura_estado       text,
  ADD COLUMN IF NOT EXISTS factura_razon_social text,
  ADD COLUMN IF NOT EXISTS factura_ruc_ci       text,
  ADD COLUMN IF NOT EXISTS factura_email        text,
  ADD COLUMN IF NOT EXISTS factura_formato      text;

-- CHECKs (NULL permitido; el set nuevo no puede violar filas viejas que son NULL).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_factura_estado_chk') THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_factura_estado_chk
      CHECK (factura_estado IS NULL OR factura_estado IN ('SOLICITADA','EMITIDA','ERROR'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_factura_formato_chk') THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_factura_formato_chk
      CHECK (factura_formato IS NULL OR factura_formato IN ('impreso','email'));
  END IF;
END $$;

-- Índice parcial: caja filtra "facturas solicitadas pendientes de emitir".
CREATE INDEX IF NOT EXISTS orders_factura_pendiente_idx
  ON public.orders (restaurant_id, created_at DESC)
  WHERE factura_solicitada = true AND factura_estado = 'SOLICITADA';

-- RLS: NADA que agregar. anon no toca orders (mig 132); staff lee/gestiona por
-- orders_auth_* (mig 086, scoped por get_my_company_restaurant_ids). Las columnas
-- nuevas heredan esa protección. service_role (server) bypassa RLS.

-- ── 2) create_order: acepta y persiste los campos fiscales (OPCIONALES) ─────
-- CREATE OR REPLACE fiel a la mig 131 + los 5 campos fiscales nuevos (todos con
-- default null/false → NO rompe ninguna llamada actual: los payloads sin campos
-- fiscales se comportan igual que antes). Cuando factura_solicitada=true, el
-- estado arranca en 'SOLICITADA'.
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
  -- PR-FE-4: campos fiscales (opcionales; default null/false).
  v_fact_sol   boolean := COALESCE((payload->>'factura_solicitada')::boolean, false);
  v_fact_rs    text    := NULLIF(payload->>'factura_razon_social','');
  v_fact_ruc   text    := NULLIF(payload->>'factura_ruc_ci','');
  v_fact_email text    := NULLIF(payload->>'factura_email','');
  v_fact_fmt   text    := NULLIF(payload->>'factura_formato','');
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

  -- Normalizar formato fiscal: sólo 'impreso'|'email' (default 'impreso' si vino sucio).
  IF v_fact_fmt IS NOT NULL AND v_fact_fmt NOT IN ('impreso','email') THEN
    v_fact_fmt := 'impreso';
  END IF;

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
    invoice_delivery_method, invoice_requested_at, invoice_status,
    factura_solicitada, factura_estado, factura_razon_social, factura_ruc_ci,
    factura_email, factura_formato
  ) VALUES (
    v_rid, v_table_id, v_order_num, v_order_type, v_status,
    v_subtotal, COALESCE((payload->>'discount_amount')::numeric, 0), NULLIF(payload->>'coupon_code',''),
    v_total, NULLIF(payload->>'payment_method',''),
    NULLIF(payload->>'customer_name',''), NULLIF(payload->>'customer_ruc',''), v_email,
    v_req_inv, COALESCE(NULLIF(payload->>'language',''), 'es'),  -- delivery no manda language → default 'es'
    CASE WHEN v_req_inv THEN COALESCE(NULLIF(payload->>'invoice_delivery_method',''),
                                      CASE WHEN v_email IS NOT NULL THEN 'email' ELSE 'print' END) END,
    CASE WHEN v_req_inv THEN now() END,
    CASE WHEN v_req_inv THEN 'pending' END,
    v_fact_sol,
    CASE WHEN v_fact_sol THEN 'SOLICITADA' END,
    v_fact_rs, v_fact_ruc, v_fact_email, v_fact_fmt
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

-- Los GRANT EXECUTE (anon, authenticated) de la mig 131 se conservan (CREATE OR
-- REPLACE no los revoca). No re-otorgamos nada nuevo.

COMMIT;

-- Recargar el cache de esquema de PostgREST.
NOTIFY pgrst, 'reload schema';

SELECT 'migracion 140 aplicada (orders.factura_* + create_order con campos fiscales)' AS status;
