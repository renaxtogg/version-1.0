-- ════════════════════════════════════════════════════════════════════════
-- 196 · CRM REAL — ficha de cliente + tipos configurables por local
-- ────────────────────────────────────────────────────────────────────────
-- [PARA PEGAR EN SUPABASE]  ·  rol postgres, SQL Editor en INGLÉS.
--
-- Cierra la prioridad 3 de CLAUDE.md ("customers sin tabla: la UI de CRM existe
-- pero los datos no persisten"). Hasta hoy NO había forma de dar de alta un
-- cliente: los datos se escribían sueltos en cada `orders` (customer_name /
-- customer_phone / customer_email / customer_ruc) y el CRM del Admin era una
-- VISTA derivada que agrupaba pedidos por nombre. Consecuencias que esto arregla:
--   • Un mismo cliente que escribía su nombre distinto eran dos "clientes".
--   • No se podía clasificar a nadie a mano: VIP/Frecuente se CALCULABAN
--     (≥₲500.000 gastados / ≥3 pedidos) y no se podían asignar.
--   • `frequent_customers` (mig 184) solo guarda teléfono+nombre y solo sirve
--     para habilitar efectivo en delivery — no es una ficha de cliente.
--
-- Qué agrega:
--   1) `customer_types`      — catálogo de tipos POR RESTAURANTE (editable).
--   2) `customers`           — la ficha: nombre, apellido, teléfono, CI/RUC,
--                              email, dirección, cumpleaños, notas.
--   3) `customer_type_links` — un cliente puede tener VARIOS tipos.
--   4) `orders.customer_id` + `delivery_orders.customer_id` — historial real.
--   5) `upsert_customer_self()` — RPC SECURITY DEFINER para que el comensal
--      (rol anon, QR de mesa y delivery) genere/complete SU ficha sin poder
--      listar ni leer las de nadie.
--   6) `create_order()` (mig 140) extendida: acepta `payload->'customer'` y
--      deja el pedido vinculado a la ficha en la MISMA transacción.
--   7) Backfill: reconstruye fichas desde el historial de `orders` y vincula
--      los pedidos viejos, para que el CRM no arranque vacío.
--
-- Todo ADITIVO e idempotente. Sin aplicar: los paneles degradan al flujo de hoy
-- (el alta de clientes queda inerte, el resto del sistema no cambia).
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- 1) CATÁLOGO DE TIPOS DE CLIENTE (por restaurante, editable por el dueño)
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.customer_types (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  color         TEXT NOT NULL DEFAULT '#8E8E93',
  sort_order    INT  NOT NULL DEFAULT 0,
  is_seeded     BOOLEAN NOT NULL DEFAULT false,   -- vino del set inicial del sistema
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un nombre de tipo no se repite dentro del mismo local (case/espacio-insensible).
CREATE UNIQUE INDEX IF NOT EXISTS ux_customer_types_rest_name
  ON public.customer_types (restaurant_id, lower(btrim(name)));

COMMENT ON TABLE public.customer_types IS
  'Tipos de cliente configurables por restaurante (VIP, Recurrente, Corporativo…). Se siembra un set inicial y el dueño lo edita desde Admin › Clientes.';

-- ════════════════════════════════════════════════════════════════════════
-- 2) FICHA DE CLIENTE
-- ════════════════════════════════════════════════════════════════════════
-- `phone_digits` y `full_name` son GENERATED STORED: el match por teléfono no
-- puede depender de cómo se escribió (+595 / 0981 / con guiones), y ordenar o
-- buscar por nombre completo no debe recalcularse en cada query.
CREATE TABLE IF NOT EXISTS public.customers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

  first_name    TEXT NOT NULL,
  last_name     TEXT,
  full_name     TEXT GENERATED ALWAYS AS
                  (btrim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))) STORED,

  phone         TEXT,
  phone_digits  TEXT GENERATED ALWAYS AS
                  (regexp_replace(coalesce(phone,''), '\D', '', 'g')) STORED,

  doc_type      TEXT CHECK (doc_type IS NULL OR doc_type IN ('ci','ruc')),
  doc_number    TEXT,
  email         TEXT,
  address       TEXT,
  address_reference TEXT,
  birth_date    DATE,
  notes         TEXT,

  source        TEXT,                              -- admin | caja | mozo | qr | delivery | backfill
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- El teléfono es la identidad del cliente en gastronomía: un solo registro por
-- número y por local. Parcial (>=6 dígitos) porque hay fichas sin teléfono
-- (mostrador, un nombre suelto) y esas no deben colisionar entre sí.
CREATE UNIQUE INDEX IF NOT EXISTS ux_customers_rest_phone
  ON public.customers (restaurant_id, phone_digits)
  WHERE length(phone_digits) >= 6;

CREATE INDEX IF NOT EXISTS idx_customers_rest_name   ON public.customers (restaurant_id, full_name);
CREATE INDEX IF NOT EXISTS idx_customers_rest_active ON public.customers (restaurant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_customers_doc         ON public.customers (restaurant_id, doc_number)
  WHERE doc_number IS NOT NULL;

COMMENT ON TABLE public.customers IS
  'Ficha de cliente por restaurante (CRM). Se da de alta desde Admin, Caja, Mozo, el QR de mesa y el delivery. El match entre canales es por phone_digits.';

-- updated_at automático
-- Trigger simple: NO va SECURITY DEFINER (no necesita privilegios ajenos), pero
-- sí lleva search_path fijo por la regla de la mig 195.
CREATE OR REPLACE FUNCTION public.touch_customer_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customers_touch ON public.customers;
CREATE TRIGGER trg_customers_touch
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.touch_customer_updated_at();

-- ════════════════════════════════════════════════════════════════════════
-- 3) TIPOS ASIGNADOS (N a N — un cliente puede ser VIP *y* Corporativo)
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.customer_type_links (
  customer_id UUID NOT NULL REFERENCES public.customers(id)      ON DELETE CASCADE,
  type_id     UUID NOT NULL REFERENCES public.customer_types(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, type_id)
);

CREATE INDEX IF NOT EXISTS idx_ctl_type ON public.customer_type_links (type_id);

-- ════════════════════════════════════════════════════════════════════════
-- 4) VÍNCULO CON EL PEDIDO — el historial deja de depender del nombre tipeado
-- ════════════════════════════════════════════════════════════════════════
-- ON DELETE SET NULL: borrar una ficha NUNCA puede borrar ni bloquear pedidos
-- (son datos contables). El pedido queda con su customer_name histórico.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL;
ALTER TABLE public.delivery_orders
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON public.orders (customer_id)
  WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_orders_customer_id ON public.delivery_orders (customer_id)
  WHERE customer_id IS NOT NULL;

COMMENT ON COLUMN public.orders.customer_id IS
  'Ficha de cliente (mig 196). NULL = pedido sin identificar. customer_name/phone se conservan como snapshot histórico del pedido.';

-- ════════════════════════════════════════════════════════════════════════
-- 5) RLS — mismo criterio tenant-scoped de las migs 086/104
-- ════════════════════════════════════════════════════════════════════════
ALTER TABLE public.customers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_types      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_type_links ENABLE ROW LEVEL SECURITY;

-- anon NO toca estas tablas directamente: la lista de clientes de un local es
-- PII y no puede quedar a un fetch de distancia de cualquiera con la anon key.
-- El comensal solo escribe SU ficha por la RPC del punto 6.
REVOKE ALL ON public.customers           FROM anon;
REVOKE ALL ON public.customer_types      FROM anon;
REVOKE ALL ON public.customer_type_links FROM anon;

DROP POLICY IF EXISTS customers_auth ON public.customers;
CREATE POLICY customers_auth ON public.customers
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

DROP POLICY IF EXISTS customer_types_auth ON public.customer_types;
CREATE POLICY customer_types_auth ON public.customer_types
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

-- links: no tiene restaurant_id propio → se scopea por su cliente.
DROP POLICY IF EXISTS customer_type_links_auth ON public.customer_type_links;
CREATE POLICY customer_type_links_auth ON public.customer_type_links
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.customers c
       WHERE c.id = customer_type_links.customer_id
         AND c.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.customers c
       WHERE c.id = customer_type_links.customer_id
         AND c.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.customers           TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_types      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_type_links TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 6) RPC anon — el comensal crea/completa SU ficha (nunca lee las de otros)
-- ════════════════════════════════════════════════════════════════════════
-- Devuelve SOLO el uuid de la ficha. Reglas anti-abuso, en orden:
--   • Sin teléfono válido (>=6 dígitos) y sin email → no se crea nada (NULL).
--   • Si ya existe la ficha, SOLO rellena campos VACÍOS. Un comensal nunca
--     puede pisar el nombre, la dirección ni el CI/RUC que ya cargó el local
--     (si no, cualquiera que conozca un teléfono reescribe esa ficha).
--   • Nunca toca notes, is_active, source ni los tipos: la clasificación es
--     una decisión del restaurante, no del cliente.
CREATE OR REPLACE FUNCTION public.upsert_customer_self(
  p_restaurant_id     uuid,
  p_first_name        text DEFAULT NULL,
  p_last_name         text DEFAULT NULL,
  p_phone             text DEFAULT NULL,
  p_doc_type          text DEFAULT NULL,
  p_doc_number        text DEFAULT NULL,
  p_email             text DEFAULT NULL,
  p_address           text DEFAULT NULL,
  p_address_reference text DEFAULT NULL,
  p_source            text DEFAULT 'qr'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_digits  text := regexp_replace(coalesce(p_phone,''), '\D', '', 'g');
  v_first   text := NULLIF(btrim(left(coalesce(p_first_name,''), 80)), '');
  v_last    text := NULLIF(btrim(left(coalesce(p_last_name ,''), 80)), '');
  v_email   text := NULLIF(lower(btrim(left(coalesce(p_email,''), 160))), '');
  v_doc_t   text := CASE WHEN lower(coalesce(p_doc_type,'')) IN ('ci','ruc')
                         THEN lower(p_doc_type) END;
  v_doc_n   text := NULLIF(btrim(left(coalesce(p_doc_number,''), 40)), '');
  v_addr    text := NULLIF(btrim(left(coalesce(p_address,''), 300)), '');
  v_addr_r  text := NULLIF(btrim(left(coalesce(p_address_reference,''), 300)), '');
  v_src     text := COALESCE(NULLIF(btrim(coalesce(p_source,'')), ''), 'qr');
  v_id      uuid;
BEGIN
  IF p_restaurant_id IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = p_restaurant_id) THEN
    RETURN NULL;
  END IF;
  -- Sin ningún identificador estable no hay ficha que crear ni que buscar.
  IF length(v_digits) < 6 AND v_email IS NULL THEN RETURN NULL; END IF;
  -- Un CI/RUC suelto sin tipo se guarda como CI (es lo que carga el 95% del salón).
  IF v_doc_n IS NOT NULL AND v_doc_t IS NULL THEN v_doc_t := 'ci'; END IF;

  -- Buscar ficha existente: primero por teléfono, si no por email.
  IF length(v_digits) >= 6 THEN
    SELECT c.id INTO v_id FROM public.customers c
     WHERE c.restaurant_id = p_restaurant_id AND c.phone_digits = v_digits
     LIMIT 1;
  END IF;
  IF v_id IS NULL AND v_email IS NOT NULL THEN
    SELECT c.id INTO v_id FROM public.customers c
     WHERE c.restaurant_id = p_restaurant_id AND lower(c.email) = v_email
     LIMIT 1;
  END IF;

  IF v_id IS NOT NULL THEN
    -- Solo rellena huecos. COALESCE(NULLIF(actual,''), nuevo) = "si ya hay algo, se respeta".
    -- Envuelto porque completar el teléfono de una ficha hallada por EMAIL puede
    -- chocar con el índice único si ese número ya es de otro cliente. En ese caso
    -- se devuelve igual la ficha encontrada: identificar al cliente no puede
    -- explotar por un dato accesorio que no se pudo completar.
    BEGIN
      UPDATE public.customers c SET
        last_name         = COALESCE(NULLIF(c.last_name,''),         v_last),
        phone             = COALESCE(NULLIF(c.phone,''),             NULLIF(p_phone,'')),
        doc_type          = COALESCE(c.doc_type,                     v_doc_t),
        doc_number        = COALESCE(NULLIF(c.doc_number,''),        v_doc_n),
        email             = COALESCE(NULLIF(c.email,''),             v_email),
        address           = COALESCE(NULLIF(c.address,''),           v_addr),
        address_reference = COALESCE(NULLIF(c.address_reference,''), v_addr_r)
      WHERE c.id = v_id;
    EXCEPTION WHEN unique_violation THEN
      NULL;
    END;
    RETURN v_id;
  END IF;

  -- Alta nueva: exige al menos un nombre (una ficha sin nombre no le sirve a nadie).
  IF v_first IS NULL THEN RETURN NULL; END IF;

  INSERT INTO public.customers (
    restaurant_id, first_name, last_name, phone, doc_type, doc_number,
    email, address, address_reference, source
  ) VALUES (
    p_restaurant_id, v_first, v_last, NULLIF(p_phone,''), v_doc_t, v_doc_n,
    v_email, v_addr, v_addr_r, v_src
  )
  -- Carrera entre dos pedidos simultáneos del mismo teléfono: gana el primero.
  ON CONFLICT (restaurant_id, phone_digits) WHERE length(phone_digits) >= 6
  DO UPDATE SET last_name = COALESCE(NULLIF(customers.last_name,''), EXCLUDED.last_name)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_customer_self(uuid,text,text,text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_customer_self(uuid,text,text,text,text,text,text,text,text,text) TO anon, authenticated;

COMMENT ON FUNCTION public.upsert_customer_self(uuid,text,text,text,text,text,text,text,text,text) IS
  'CRM (mig 196): el comensal (anon, QR o delivery) crea o completa SU ficha. Devuelve solo el uuid; sobre una ficha existente únicamente rellena campos vacíos y jamás toca notas, estado ni tipos.';

-- ════════════════════════════════════════════════════════════════════════
-- 7) SET INICIAL DE TIPOS — para los locales de hoy y para los que vengan
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.seed_customer_types(p_restaurant_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  INSERT INTO public.customer_types (restaurant_id, name, color, sort_order, is_seeded)
  VALUES
    (p_restaurant_id, 'Nuevo',       '#8E8E93', 10, true),
    (p_restaurant_id, 'Recurrente',  '#34C759', 20, true),
    (p_restaurant_id, 'VIP',         '#FF9500', 30, true),
    (p_restaurant_id, 'Corporativo', '#007AFF', 40, true),
    (p_restaurant_id, 'Mayorista',   '#AF52DE', 50, true)
  ON CONFLICT DO NOTHING;
END;
$$;

-- Locales existentes
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.restaurants LOOP
    PERFORM public.seed_customer_types(r.id);
  END LOOP;
END $$;

-- Locales nuevos
CREATE OR REPLACE FUNCTION public.seed_customer_types_on_restaurant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  PERFORM public.seed_customer_types(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_customer_types ON public.restaurants;
CREATE TRIGGER trg_seed_customer_types
  AFTER INSERT ON public.restaurants
  FOR EACH ROW EXECUTE FUNCTION public.seed_customer_types_on_restaurant();

-- ════════════════════════════════════════════════════════════════════════
-- 8) create_order — acepta payload->'customer' y vincula el pedido
-- ════════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE fiel a la mig 140 + el bloque de cliente. `customer` es
-- OPCIONAL: los payloads que no lo mandan se comportan exactamente igual.
CREATE OR REPLACE FUNCTION public.create_order(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
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
  -- mig 196: ficha de cliente (opcional).
  v_cust       jsonb   := payload->'customer';
  v_cust_id    uuid;
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

  -- 0) Ficha de cliente (mig 196). Best-effort a propósito: un problema con el
  --    CRM jamás puede impedir que entre un pedido pago.
  IF v_cust IS NOT NULL AND jsonb_typeof(v_cust) = 'object' THEN
    BEGIN
      v_cust_id := public.upsert_customer_self(
        v_rid,
        NULLIF(v_cust->>'first_name',''),
        NULLIF(v_cust->>'last_name',''),
        NULLIF(v_cust->>'phone',''),
        NULLIF(v_cust->>'doc_type',''),
        NULLIF(v_cust->>'doc_number',''),
        NULLIF(v_cust->>'email',''),
        NULLIF(v_cust->>'address',''),
        NULLIF(v_cust->>'address_reference',''),
        COALESCE(NULLIF(v_cust->>'source',''),
                 CASE WHEN v_delivery IS NOT NULL THEN 'delivery' ELSE 'qr' END)
      );
    EXCEPTION WHEN OTHERS THEN
      v_cust_id := NULL;
    END;
  END IF;

  -- 1) orders
  INSERT INTO public.orders (
    restaurant_id, table_id, order_number, order_type, status,
    subtotal, discount_amount, coupon_code, total, payment_method,
    customer_name, customer_ruc, customer_email, requires_invoice, language,
    invoice_delivery_method, invoice_requested_at, invoice_status,
    factura_solicitada, factura_estado, factura_razon_social, factura_ruc_ci,
    factura_email, factura_formato, customer_id
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
    v_fact_rs, v_fact_ruc, v_fact_email, v_fact_fmt, v_cust_id
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
      delivery_corner, delivery_lat, delivery_lng, customer_id
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
      NULLIF(v_delivery->>'delivery_lng','')::numeric,
      v_cust_id
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

  RETURN jsonb_build_object('id', v_order_id, 'order_number', v_order_num,
                            'status', v_status, 'customer_id', v_cust_id);
END;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 9) BACKFILL — reconstruye fichas desde el historial y vincula los pedidos
-- ════════════════════════════════════════════════════════════════════════
-- Sin esto el CRM del Admin arrancaría VACÍO, que sería un retroceso frente a
-- la vista derivada de hoy. Criterio conservador: solo pedidos reales (ni draft
-- ni cancelled) con un nombre de al menos 2 caracteres. El apellido sale del
-- resto del nombre tipeado; si escribieron una sola palabra, queda sin apellido.
DO $$
DECLARE v_inserted int; v_linked int;
BEGIN
  -- 9.a) Fichas por TELÉFONO (identidad fuerte). Se queda con el nombre y los
  --      datos del pedido MÁS RECIENTE de ese número.
  WITH src AS (
    SELECT DISTINCT ON (o.restaurant_id, regexp_replace(o.customer_phone, '\D', '', 'g'))
           o.restaurant_id,
           regexp_replace(o.customer_phone, '\D', '', 'g') AS digits,
           btrim(o.customer_name) AS nombre,
           o.customer_phone, o.customer_email, o.customer_ruc, o.created_at
      FROM public.orders o
     WHERE o.status NOT IN ('draft','cancelled')
       AND o.customer_name IS NOT NULL
       AND length(btrim(o.customer_name)) >= 2
       AND o.customer_phone IS NOT NULL
       AND length(regexp_replace(o.customer_phone, '\D', '', 'g')) >= 6
     ORDER BY o.restaurant_id,
              regexp_replace(o.customer_phone, '\D', '', 'g'),
              o.created_at DESC
  )
  INSERT INTO public.customers (restaurant_id, first_name, last_name, phone, email,
                                doc_type, doc_number, source, created_at)
  SELECT s.restaurant_id,
         split_part(s.nombre, ' ', 1),
         NULLIF(btrim(substr(s.nombre, length(split_part(s.nombre, ' ', 1)) + 1)), ''),
         s.customer_phone,
         NULLIF(lower(btrim(s.customer_email)), ''),
         CASE WHEN NULLIF(btrim(coalesce(s.customer_ruc,'')),'') IS NOT NULL THEN 'ruc' END,
         NULLIF(btrim(coalesce(s.customer_ruc,'')), ''),
         'backfill', s.created_at
    FROM src s
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RAISE NOTICE 'mig 196 · fichas creadas desde el historial (por teléfono): %', v_inserted;

  -- 9.b) Vincular los pedidos históricos a su ficha (por teléfono).
  UPDATE public.orders o
     SET customer_id = c.id
    FROM public.customers c
   WHERE o.customer_id IS NULL
     AND c.restaurant_id = o.restaurant_id
     AND o.customer_phone IS NOT NULL
     AND length(regexp_replace(o.customer_phone, '\D', '', 'g')) >= 6
     AND c.phone_digits = regexp_replace(o.customer_phone, '\D', '', 'g');
  GET DIAGNOSTICS v_linked = ROW_COUNT;
  RAISE NOTICE 'mig 196 · pedidos vinculados a una ficha: %', v_linked;

  UPDATE public.delivery_orders d
     SET customer_id = o.customer_id
    FROM public.orders o
   WHERE d.order_id = o.id AND d.customer_id IS NULL AND o.customer_id IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  -- El backfill es una comodidad, no un requisito: si algo del historial no
  -- encaja, la migración igual deja el CRM operativo (arranca vacío y se carga
  -- solo con el uso). No se aborta por esto.
  RAISE NOTICE 'mig 196 · backfill omitido (%). El CRM queda operativo igual.', SQLERRM;
END $$;

-- 9.c) Los frecuentes marcados a mano (mig 184) pasan a ser el tipo "Recurrente".
--      No se borra `frequent_customers`: el checkout de delivery sigue leyéndola
--      por RPC y sacarla acá rompería el pago en efectivo de clientes frecuentes.
--      Va en su PROPIO bloque: si la mig 184 no está aplicada, la tabla no existe
--      y el error no debe arrastrarse el backfill de 9.a/9.b.
DO $$
BEGIN
  INSERT INTO public.customer_type_links (customer_id, type_id)
  SELECT c.id, t.id
    FROM public.frequent_customers f
    JOIN public.customers c
      ON c.restaurant_id = f.restaurant_id
     AND c.phone_digits  = regexp_replace(coalesce(f.phone,''), '\D', '', 'g')
    JOIN public.customer_types t
      ON t.restaurant_id = f.restaurant_id AND lower(t.name) = 'recurrente'
   WHERE length(regexp_replace(coalesce(f.phone,''), '\D', '', 'g')) >= 6
  ON CONFLICT DO NOTHING;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'mig 196 · no se migraron los clientes frecuentes (%): ¿falta aplicar la mig 184?', SQLERRM;
END $$;

COMMIT;

-- Recargar el cache de esquema de PostgREST para que tome tablas/columnas/grants.
NOTIFY pgrst, 'reload schema';

SELECT 'migración 196 aplicada — CRM real: customers + customer_types + vínculo con pedidos' AS status;
