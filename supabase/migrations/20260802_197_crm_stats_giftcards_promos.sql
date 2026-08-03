-- ════════════════════════════════════════════════════════════════════════
-- 197 · CRM con estadísticas REALES + Marketing (gift cards y promos)
-- ────────────────────────────────────────────────────────────────────────
-- [PARA PEGAR EN SUPABASE]  ·  rol postgres, SQL Editor en INGLÉS.
--
-- Continúa la 196 (que creó la ficha de cliente). Tres problemas distintos:
--
-- 1) LAS ESTADÍSTICAS DEL CRM ERAN MENTIRA.
--    El Admin calculaba "pedidos" y "total gastado" agrupando en el navegador
--    el array `orders`, que se carga con `.limit(500)`. Un local con 500 pedidos
--    de historia ya muestra a sus clientes con menos visitas y menos gasto del
--    que tienen, y el número EMPEORA cuanto más vende el local — justo al revés
--    de lo que uno esperaría. Además `orders` no tiene columna `delivery_address`
--    (vive en `delivery_orders`), así que la columna "Dirección delivery" del
--    CRM salía vacía SIEMPRE. `crm_customer_stats()` agrega del lado de la base,
--    sobre TODO el historial, y trae la dirección del lugar donde está.
--
-- 2) NO HABÍA GIFT CARDS NI PROMOS AUTOMÁTICAS.
--    Marketing sólo tenía cupones sueltos que el dueño inventaba a mano. Ahora:
--      · `gift_cards` + `gift_card_movements` — saldo con libro mayor, canje
--        parcial, vencimiento. Las emite el local (Admin o Caja) y el comensal
--        se la regala a quien quiera.
--      · `promo_rules` + `promo_awards` — reglas por cantidad de visitas, gasto
--        acumulado, gasto en un período, cumpleaños, inactividad o primera
--        compra. Al cumplirse, `run_promo_engine()` emite un CUPÓN PERSONAL
--        (código único, un solo uso) para esa ficha.
--    TODO APAGADO POR DEFECTO: sin fila en `restaurant_marketing_config` no hay
--    gift cards ni promos, y los defaults de la tabla son `false`. Nada aparece
--    ni corre hasta que el administrador lo prende.
--
-- 3) CUALQUIER STAFF PODÍA EDITAR UNA FICHA.
--    La policy de la 196 daba FOR ALL a todo `authenticated` del local, así que
--    un cajero podía reescribir el nombre, el CI o las notas de un cliente desde
--    el mostrador. Se parte en dos: crear y consultar lo puede hacer todo el
--    staff (es lo que necesita el mostrador); MODIFICAR o dar de baja una ficha
--    ya guardada queda sólo para admin/superadmin, o sea Admin › Clientes.
--
-- REQUIERE LA 196 APLICADA (usa `customers`, `customer_types` y el helper
-- `touch_customer_updated_at`). Si la 196 no está, esta falla en el primer
-- REFERENCES y no deja nada a medias — corre entera dentro de una transacción.
--
-- Todo ADITIVO e idempotente. Sin aplicar: el CRM cae al cálculo viejo en el
-- navegador y Marketing muestra el aviso de "falta la migración 197".
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- 1) ESTADÍSTICAS REALES POR CLIENTE
-- ════════════════════════════════════════════════════════════════════════
-- SECURITY INVOKER a propósito (sin SECURITY DEFINER): así la RLS tenant-scoped
-- de `orders` (migs 086/104) sigue decidiendo qué filas ve quien llama. El
-- filtro por p_restaurant_id es comodidad, no el control de acceso.
--
-- La CLAVE DE AGRUPACIÓN respeta la misma jerarquía de identidad que el resto
-- del CRM y por el mismo motivo (mig 196): la ficha manda, después el teléfono,
-- y el nombre tipeado sólo si no hay nada mejor. Un pedido sin ninguna de las
-- tres es anónimo y cuenta como su propio "cliente" — si se agruparan todos
-- juntos, "Anónimo" aparecería como el mejor cliente del local.
CREATE OR REPLACE FUNCTION public.crm_customer_stats(
  p_restaurant_id uuid,
  p_from          timestamptz DEFAULT NULL,
  p_to            timestamptz DEFAULT NULL
)
RETURNS TABLE (
  group_key     text,
  customer_id   uuid,
  name          text,
  phone         text,
  email         text,
  anonymous     boolean,
  visits        integer,
  total_spent   numeric,
  ticket_avg    numeric,
  first_order   timestamptz,
  last_order    timestamptz,
  invoice_count integer,
  canales       jsonb,
  pagos         jsonb,
  addresses     text[],
  tables_used   text[]
)
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  -- Los alias internos EVITAN a propósito los nombres de las columnas de salida
  -- (name, phone, visits…): en una función SQL las columnas del RETURNS TABLE son
  -- parámetros OUT y una referencia sin calificar al mismo nombre da
  -- "column reference is ambiguous".
  WITH base AS (
    SELECT
      o.id                                AS o_id,
      o.customer_id                       AS c_ref,
      o.customer_name                     AS c_nom,
      o.customer_phone                    AS c_tel,
      o.customer_email                    AS c_mail,
      COALESCE(o.total, 0)                AS monto,
      o.created_at                        AS fecha,
      COALESCE(o.requires_invoice, false) AS con_factura,
      o.order_type                        AS canal,
      o.payment_method                    AS pago,
      -- La dirección de entrega NO está en `orders`: vive en delivery_orders.
      d.delivery_address                  AS dir,
      t.number                            AS mesa,
      regexp_replace(COALESCE(o.customer_phone, ''), '\D', '', 'g') AS digitos
    FROM public.orders o
    LEFT JOIN public.delivery_orders d ON d.order_id = o.id
    LEFT JOIN public.tables          t ON t.id       = o.table_id
    WHERE o.restaurant_id = p_restaurant_id
      AND o.status NOT IN ('draft', 'cancelled')
      AND (p_from IS NULL OR o.created_at >= p_from)
      AND (p_to   IS NULL OR o.created_at <= p_to)
  ),
  keyed AS (
    SELECT b.*,
      COALESCE(
        CASE WHEN b.c_ref IS NOT NULL      THEN 'c:' || b.c_ref::text END,
        CASE WHEN length(b.digitos) >= 6   THEN 'p:' || b.digitos END,
        CASE WHEN NULLIF(btrim(COALESCE(b.c_nom, '')), '') IS NOT NULL
             THEN 'n:' || lower(btrim(b.c_nom)) END,
        'a:' || b.o_id::text
      ) AS gkey
    FROM base b
  ),
  agg AS (
    SELECT
      k.gkey                                     AS gkey,
      -- Nombre/tel/mail/ficha del pedido MÁS RECIENTE que los trajo: si el
      -- cliente corrigió su dato en la última compra, gana el corregido.
      -- (Para la ficha NO sirve `max()`: **Postgres no tiene max(uuid)** — un
      -- uuid no tiene orden con sentido. Se toma el del último pedido, que es
      -- además lo semánticamente correcto.)
      (array_agg(k.c_ref  ORDER BY k.fecha DESC)
         FILTER (WHERE k.c_ref IS NOT NULL))[1]                                   AS c_ref,
      (array_agg(k.c_nom  ORDER BY k.fecha DESC)
         FILTER (WHERE NULLIF(btrim(COALESCE(k.c_nom, '')), '') IS NOT NULL))[1]  AS c_nom,
      (array_agg(k.c_tel  ORDER BY k.fecha DESC)
         FILTER (WHERE NULLIF(btrim(COALESCE(k.c_tel, '')), '') IS NOT NULL))[1]  AS c_tel,
      (array_agg(k.c_mail ORDER BY k.fecha DESC)
         FILTER (WHERE NULLIF(btrim(COALESCE(k.c_mail, '')), '') IS NOT NULL))[1] AS c_mail,
      count(*)::int                              AS n_pedidos,
      sum(k.monto)::numeric                      AS gastado,
      -- `orders.total` es INTEGER (mig 001), así que `sum()` da bigint y
      -- `bigint / bigint` es división ENTERA: sin el ::numeric, el ticket
      -- promedio se truncaría hacia abajo en vez de redondearse.
      round(sum(k.monto)::numeric / GREATEST(count(*), 1))                        AS ticket,
      min(k.fecha)                               AS primera,
      max(k.fecha)                               AS ultima,
      count(*) FILTER (WHERE k.con_factura)::int AS n_facturas,
      COALESCE(array_agg(DISTINCT k.dir)
                 FILTER (WHERE NULLIF(btrim(COALESCE(k.dir, '')), '') IS NOT NULL),
               '{}'::text[])                                                      AS dirs,
      COALESCE(array_agg(DISTINCT k.mesa::text)
                 FILTER (WHERE k.mesa IS NOT NULL),
               '{}'::text[])                                                      AS mesas
    FROM keyed k
    GROUP BY k.gkey
  ),
  -- Los mapas canal→cantidad y pago→cantidad se arman en dos pasos: primero un
  -- conteo por (cliente, canal) y recién después el jsonb_object_agg. Hacerlo de
  -- una sola vez sobre `keyed` repetiría la clave una vez por pedido y
  -- jsonb_object_agg aborta con "duplicate key".
  canales_q AS (
    SELECT q.gkey, jsonb_object_agg(q.canal, q.n) AS mapa
      FROM (SELECT k.gkey, k.canal, count(*)::int AS n
              FROM keyed k WHERE k.canal IS NOT NULL
             GROUP BY k.gkey, k.canal) q
     GROUP BY q.gkey
  ),
  pagos_q AS (
    SELECT q.gkey, jsonb_object_agg(q.pago, q.n) AS mapa
      FROM (SELECT k.gkey, k.pago, count(*)::int AS n
              FROM keyed k WHERE k.pago IS NOT NULL
             GROUP BY k.gkey, k.pago) q
     GROUP BY q.gkey
  )
  SELECT
    a.gkey, a.c_ref, a.c_nom, a.c_tel, a.c_mail,
    (a.gkey LIKE 'a:%'),
    a.n_pedidos, a.gastado, a.ticket, a.primera, a.ultima, a.n_facturas,
    COALESCE(cq.mapa, '{}'::jsonb),
    COALESCE(pq.mapa, '{}'::jsonb),
    a.dirs, a.mesas
  FROM agg a
  LEFT JOIN canales_q cq ON cq.gkey = a.gkey
  LEFT JOIN pagos_q   pq ON pq.gkey = a.gkey;
$$;

REVOKE ALL ON FUNCTION public.crm_customer_stats(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_customer_stats(uuid, timestamptz, timestamptz) TO authenticated;

COMMENT ON FUNCTION public.crm_customer_stats(uuid, timestamptz, timestamptz) IS
  'CRM (mig 197): visitas, gasto, ticket, canales, direcciones y mesas por cliente sobre TODO el historial. Reemplaza el cálculo en el navegador, que sólo veía los últimos 500 pedidos.';

-- ════════════════════════════════════════════════════════════════════════
-- 2) LA FICHA SE EDITA SÓLO DESDE ADMIN
-- ════════════════════════════════════════════════════════════════════════
-- La 196 dio FOR ALL a todo el staff del local. El mostrador necesita CREAR
-- (alta al vuelo mientras cobra) y LEER (buscar al cliente), pero no tiene por
-- qué reescribir una ficha ya guardada: los datos curados son del local y se
-- corrigen en un solo lugar. `upsert_customer_self` no se ve afectada — es
-- SECURITY DEFINER y sólo rellena campos vacíos.
DROP POLICY IF EXISTS customers_auth        ON public.customers;
DROP POLICY IF EXISTS customers_read        ON public.customers;
DROP POLICY IF EXISTS customers_insert      ON public.customers;
DROP POLICY IF EXISTS customers_admin_write ON public.customers;

CREATE POLICY customers_read ON public.customers
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

CREATE POLICY customers_insert ON public.customers
  FOR INSERT TO authenticated
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

-- UPDATE y DELETE: sólo el dueño (admin) o el superadmin.
CREATE POLICY customers_admin_write ON public.customers
  FOR UPDATE TO authenticated
  USING (
    public.get_my_role() IN ('admin', 'superadmin')
    AND (public.get_my_role() = 'superadmin'
         OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  )
  WITH CHECK (
    public.get_my_role() IN ('admin', 'superadmin')
    AND (public.get_my_role() = 'superadmin'
         OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  );

DROP POLICY IF EXISTS customers_admin_delete ON public.customers;
CREATE POLICY customers_admin_delete ON public.customers
  FOR DELETE TO authenticated
  USING (
    public.get_my_role() IN ('admin', 'superadmin')
    AND (public.get_my_role() = 'superadmin'
         OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  );

-- El catálogo de tipos también es una decisión del dueño, no del mostrador.
DROP POLICY IF EXISTS customer_types_auth  ON public.customer_types;
DROP POLICY IF EXISTS customer_types_read  ON public.customer_types;
DROP POLICY IF EXISTS customer_types_admin ON public.customer_types;

CREATE POLICY customer_types_read ON public.customer_types
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

CREATE POLICY customer_types_admin ON public.customer_types
  FOR ALL TO authenticated
  USING (
    public.get_my_role() IN ('admin', 'superadmin')
    AND (public.get_my_role() = 'superadmin'
         OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  )
  WITH CHECK (
    public.get_my_role() IN ('admin', 'superadmin')
    AND (public.get_my_role() = 'superadmin'
         OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  );

-- ════════════════════════════════════════════════════════════════════════
-- 3) CONFIGURACIÓN DE MARKETING — APAGADO POR DEFECTO
-- ════════════════════════════════════════════════════════════════════════
-- NO se siembra ninguna fila y NO hay trigger de alta: un local sin fila tiene
-- todo apagado. Es la forma más difícil de equivocarse — para que aparezca algo
-- alguien tiene que haber prendido el interruptor a mano.
CREATE TABLE IF NOT EXISTS public.restaurant_marketing_config (
  restaurant_id          UUID PRIMARY KEY REFERENCES public.restaurants(id) ON DELETE CASCADE,

  gift_cards_enabled     BOOLEAN NOT NULL DEFAULT false,
  promos_enabled         BOOLEAN NOT NULL DEFAULT false,

  -- Gift cards
  gift_card_min_amount   NUMERIC NOT NULL DEFAULT 50000,
  gift_card_max_amount   NUMERIC NOT NULL DEFAULT 2000000,
  gift_card_valid_days   INT     NOT NULL DEFAULT 365,   -- 0 = sin vencimiento
  gift_card_prefix       TEXT    NOT NULL DEFAULT 'GC',
  gift_card_terms        TEXT,

  -- Promos
  promo_coupon_valid_days INT    NOT NULL DEFAULT 30,

  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.restaurant_marketing_config IS
  'Marketing por restaurante (mig 197). SIN FILA = todo apagado. Gift cards y promos automáticas arrancan en false y sólo las prende el administrador desde Admin › Clientes › Marketing.';

ALTER TABLE public.restaurant_marketing_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.restaurant_marketing_config FROM anon;

DROP POLICY IF EXISTS rmc_read  ON public.restaurant_marketing_config;
DROP POLICY IF EXISTS rmc_admin ON public.restaurant_marketing_config;

-- Lectura para todo el staff: Caja necesita saber si las gift cards están
-- prendidas antes de mostrar el botón de canje.
CREATE POLICY rmc_read ON public.restaurant_marketing_config
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

CREATE POLICY rmc_admin ON public.restaurant_marketing_config
  FOR ALL TO authenticated
  USING (
    public.get_my_role() IN ('admin', 'superadmin')
    AND (public.get_my_role() = 'superadmin'
         OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  )
  WITH CHECK (
    public.get_my_role() IN ('admin', 'superadmin')
    AND (public.get_my_role() = 'superadmin'
         OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  );

GRANT SELECT, INSERT, UPDATE ON public.restaurant_marketing_config TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 4) GIFT CARDS
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.gift_cards (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  code           TEXT NOT NULL,

  initial_amount NUMERIC NOT NULL CHECK (initial_amount > 0),
  balance        NUMERIC NOT NULL CHECK (balance >= 0),
  status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'used', 'expired', 'cancelled')),

  -- Quién la compró (opcional: se puede vender a alguien sin ficha)
  purchaser_customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  purchaser_name  TEXT,
  purchaser_phone TEXT,

  -- A quién se la regala. El teléfono es lo único que hace falta para mandarla.
  recipient_name  TEXT,
  recipient_phone TEXT,
  recipient_email TEXT,
  message         TEXT,

  -- Cómo se pagó la tarjeta al emitirla (efectivo, transferencia…)
  paid_method     TEXT,
  paid_reference  TEXT,

  expires_at      DATE,
  issued_channel  TEXT NOT NULL DEFAULT 'admin',   -- admin | caja | promo
  issued_by       UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- El código es lo que el comensal muestra en el mostrador: único por local.
CREATE UNIQUE INDEX IF NOT EXISTS ux_gift_cards_rest_code
  ON public.gift_cards (restaurant_id, upper(btrim(code)));
CREATE INDEX IF NOT EXISTS idx_gift_cards_rest_status ON public.gift_cards (restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_gift_cards_purchaser   ON public.gift_cards (purchaser_customer_id)
  WHERE purchaser_customer_id IS NOT NULL;

COMMENT ON TABLE public.gift_cards IS
  'Gift cards digitales (mig 197). El saldo vive acá y el detalle en gift_card_movements. Sólo se emiten/canjean con gift_cards_enabled = true en restaurant_marketing_config.';

-- Libro mayor: cada movimiento de saldo deja rastro. `balance` de gift_cards es
-- el saldo vigente (rápido de leer); esta tabla es la que permite auditar.
CREATE TABLE IF NOT EXISTS public.gift_card_movements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gift_card_id  UUID NOT NULL REFERENCES public.gift_cards(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  order_id      UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('issue', 'redeem', 'refund', 'cancel', 'adjust')),
  amount        NUMERIC NOT NULL,          -- negativo = consume saldo
  balance_after NUMERIC NOT NULL,
  note          TEXT,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gcm_card ON public.gift_card_movements (gift_card_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gcm_rest ON public.gift_card_movements (restaurant_id, created_at DESC);

ALTER TABLE public.gift_cards          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gift_card_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gift_cards          FROM anon;
REVOKE ALL ON public.gift_card_movements FROM anon;

-- Todo el staff del local ve y opera gift cards (Caja tiene que poder canjear).
-- El borrado no existe a propósito: una tarjeta se cancela, no se hace desaparecer.
DROP POLICY IF EXISTS gift_cards_staff ON public.gift_cards;
CREATE POLICY gift_cards_staff ON public.gift_cards
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

DROP POLICY IF EXISTS gcm_staff ON public.gift_card_movements;
CREATE POLICY gcm_staff ON public.gift_card_movements
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

GRANT SELECT, INSERT, UPDATE ON public.gift_cards          TO authenticated;
GRANT SELECT, INSERT         ON public.gift_card_movements TO authenticated;

-- ── Emisión ─────────────────────────────────────────────────────────────
-- SECURITY INVOKER: la RLS de arriba decide si quien llama puede emitir en ese
-- local. Lo que aporta la función es lo que el cliente NO puede hacer bien solo:
-- generar un código único (con reintento ante colisión) y dejar el asiento del
-- libro mayor en la MISMA transacción que el alta.
CREATE OR REPLACE FUNCTION public.issue_gift_card(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_rid     uuid    := NULLIF(payload->>'restaurant_id', '')::uuid;
  v_amount  numeric := COALESCE((payload->>'amount')::numeric, 0);
  v_cfg     record;
  v_prefix  text;
  v_code    text;
  v_expires date;
  v_id      uuid;
  v_try     int := 0;
BEGIN
  IF v_rid IS NULL THEN RAISE EXCEPTION 'restaurant_id requerido' USING ERRCODE = '22023'; END IF;

  SELECT * INTO v_cfg FROM public.restaurant_marketing_config c WHERE c.restaurant_id = v_rid;

  -- Sin config o con el interruptor en off no se emite nada. Es el mismo
  -- criterio que la UI, pero acá no se puede saltear tocando el DOM.
  IF v_cfg IS NULL OR v_cfg.gift_cards_enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'Las gift cards están desactivadas para este local' USING ERRCODE = '22023';
  END IF;
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'El monto de la gift card debe ser mayor a cero' USING ERRCODE = '22023';
  END IF;
  IF v_amount < v_cfg.gift_card_min_amount OR v_amount > v_cfg.gift_card_max_amount THEN
    RAISE EXCEPTION 'El monto debe estar entre % y %', v_cfg.gift_card_min_amount, v_cfg.gift_card_max_amount
      USING ERRCODE = '22023';
  END IF;

  v_prefix  := upper(COALESCE(NULLIF(btrim(v_cfg.gift_card_prefix), ''), 'GC'));
  v_expires := CASE WHEN v_cfg.gift_card_valid_days > 0
                    THEN (current_date + v_cfg.gift_card_valid_days) END;

  -- Reintento por colisión de código: 8 dígitos hex sobre un espacio de 16^8
  -- casi nunca chocan, pero "casi nunca" con un índice único es un error 23505
  -- en la cara del cajero en medio de una venta.
  LOOP
    v_try := v_try + 1;
    v_code := v_prefix || '-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
    BEGIN
      INSERT INTO public.gift_cards (
        restaurant_id, code, initial_amount, balance,
        purchaser_customer_id, purchaser_name, purchaser_phone,
        recipient_name, recipient_phone, recipient_email, message,
        paid_method, paid_reference, expires_at, issued_channel, issued_by
      ) VALUES (
        v_rid, v_code, v_amount, v_amount,
        NULLIF(payload->>'purchaser_customer_id', '')::uuid,
        NULLIF(btrim(payload->>'purchaser_name'), ''),
        NULLIF(btrim(payload->>'purchaser_phone'), ''),
        NULLIF(btrim(payload->>'recipient_name'), ''),
        NULLIF(btrim(payload->>'recipient_phone'), ''),
        NULLIF(btrim(payload->>'recipient_email'), ''),
        NULLIF(btrim(payload->>'message'), ''),
        NULLIF(btrim(payload->>'paid_method'), ''),
        NULLIF(btrim(payload->>'paid_reference'), ''),
        COALESCE(NULLIF(payload->>'expires_at', '')::date, v_expires),
        COALESCE(NULLIF(payload->>'issued_channel', ''), 'admin'),
        auth.uid()
      ) RETURNING id INTO v_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_try >= 6 THEN RAISE; END IF;
    END;
  END LOOP;

  INSERT INTO public.gift_card_movements (gift_card_id, restaurant_id, kind, amount, balance_after, note, created_by)
  VALUES (v_id, v_rid, 'issue', v_amount, v_amount,
          NULLIF(btrim(payload->>'note'), ''), auth.uid());

  RETURN jsonb_build_object('id', v_id, 'code', v_code, 'balance', v_amount, 'expires_at', v_expires);
END;
$$;

REVOKE ALL ON FUNCTION public.issue_gift_card(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_gift_card(jsonb) TO authenticated;

-- ── Canje ───────────────────────────────────────────────────────────────
-- Devuelve cuánto SE PUDO aplicar, no cuánto se pidió: en el mostrador lo
-- normal es que la tarjeta no cubra todo el pedido y el resto se cobre aparte.
-- El SELECT ... FOR UPDATE es lo que evita que dos cajas canjeen el mismo saldo.
--
-- `p_allow_partial = false` es TODO O NADA, y es lo que usa Caja al cobrar.
-- Motivo: entre que el cajero verifica el código y aprieta "Confirmar", otra caja
-- puede haber consumido saldo. Con canje parcial la tarjeta quedaría debitada por
-- un monto que ya no alcanza y el cobro habría que rehacerlo con la plata a medio
-- descontar — un lío imposible de deshacer desde el mostrador. Con todo-o-nada,
-- ante una carrera no se toca un guaraní y el cajero simplemente reintenta.
CREATE OR REPLACE FUNCTION public.redeem_gift_card(
  p_restaurant_id uuid,
  p_code          text,
  p_amount        numeric,
  p_order_id      uuid DEFAULT NULL,
  p_note          text DEFAULT NULL,
  p_allow_partial boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_card    record;
  v_enabled boolean;
  v_apply   numeric;
  v_after   numeric;
BEGIN
  SELECT c.gift_cards_enabled INTO v_enabled
    FROM public.restaurant_marketing_config c WHERE c.restaurant_id = p_restaurant_id;
  IF v_enabled IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Las gift cards están desactivadas para este local');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Monto a canjear inválido');
  END IF;

  SELECT * INTO v_card
    FROM public.gift_cards g
   WHERE g.restaurant_id = p_restaurant_id
     AND upper(btrim(g.code)) = upper(btrim(COALESCE(p_code, '')))
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No existe una gift card con ese código');
  END IF;
  IF v_card.status = 'cancelled' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Esta gift card fue anulada');
  END IF;
  IF v_card.expires_at IS NOT NULL AND v_card.expires_at < current_date THEN
    UPDATE public.gift_cards SET status = 'expired', updated_at = now() WHERE id = v_card.id;
    RETURN jsonb_build_object('ok', false, 'error',
      'Esta gift card venció el ' || to_char(v_card.expires_at, 'DD/MM/YYYY'));
  END IF;
  IF v_card.balance <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Esta gift card ya no tiene saldo');
  END IF;
  IF p_allow_partial IS NOT TRUE AND v_card.balance < p_amount THEN
    -- No se debita nada: el llamador vuelve a intentar con el saldo real.
    RETURN jsonb_build_object('ok', false, 'balance', v_card.balance,
      'error', 'La gift card ya sólo tiene ' || to_char(v_card.balance, 'FM999G999G999')
               || ' de saldo. Verificá el código de nuevo.');
  END IF;

  v_apply := LEAST(p_amount, v_card.balance);
  v_after := v_card.balance - v_apply;

  UPDATE public.gift_cards
     SET balance    = v_after,
         status     = CASE WHEN v_after <= 0 THEN 'used' ELSE 'active' END,
         updated_at = now()
   WHERE id = v_card.id;

  INSERT INTO public.gift_card_movements (gift_card_id, restaurant_id, order_id, kind, amount, balance_after, note, created_by)
  VALUES (v_card.id, p_restaurant_id, p_order_id, 'redeem', -v_apply, v_after, p_note, auth.uid());

  RETURN jsonb_build_object('ok', true, 'id', v_card.id, 'code', v_card.code,
                            'applied', v_apply, 'balance', v_after,
                            'partial', v_apply < p_amount);
END;
$$;

-- La firma vieja (sin p_allow_partial) quedaría como sobrecarga y PostgREST no
-- sabría cuál llamar → "could not choose the best candidate function".
DROP FUNCTION IF EXISTS public.redeem_gift_card(uuid, text, numeric, uuid, text);

REVOKE ALL ON FUNCTION public.redeem_gift_card(uuid, text, numeric, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_gift_card(uuid, text, numeric, uuid, text, boolean) TO authenticated;

-- ── Consulta de saldo ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.lookup_gift_card(p_restaurant_id uuid, p_code text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT jsonb_build_object(
        'ok', true, 'id', g.id, 'code', g.code, 'balance', g.balance,
        'initial_amount', g.initial_amount, 'status', g.status,
        'expires_at', g.expires_at, 'recipient_name', g.recipient_name,
        'expired', (g.expires_at IS NOT NULL AND g.expires_at < current_date))
       FROM public.gift_cards g
      WHERE g.restaurant_id = p_restaurant_id
        AND upper(btrim(g.code)) = upper(btrim(COALESCE(p_code, '')))),
    jsonb_build_object('ok', false, 'error', 'No existe una gift card con ese código'));
$$;

REVOKE ALL ON FUNCTION public.lookup_gift_card(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lookup_gift_card(uuid, text) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 5) PROMOS AUTOMÁTICAS
-- ════════════════════════════════════════════════════════════════════════
-- El cupón generado queda atado a la ficha: sirve para saber a quién mandárselo
-- y para no premiar dos veces al mismo cliente por la misma regla.
ALTER TABLE public.coupons
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_coupons_customer ON public.coupons (customer_id)
  WHERE customer_id IS NOT NULL;

COMMENT ON COLUMN public.coupons.customer_id IS
  'Cupón PERSONAL emitido por una promo automática (mig 197). NULL = cupón público cargado a mano por el dueño.';

CREATE TABLE IF NOT EXISTS public.promo_rules (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT,

  -- Arranca APAGADA aunque el módulo de promos esté prendido: crear una regla
  -- no puede ser lo mismo que soltarla sobre toda la base de clientes.
  is_active      BOOLEAN NOT NULL DEFAULT false,

  trigger_type   TEXT NOT NULL CHECK (trigger_type IN
                   ('visits', 'spend_total', 'spend_period', 'birthday', 'inactive', 'first_order')),
  threshold      NUMERIC NOT NULL DEFAULT 0,     -- visitas o ₲ según trigger_type
  period_days    INT     NOT NULL DEFAULT 30,    -- ventana de spend_period / inactive / birthday

  reward_type    TEXT NOT NULL CHECK (reward_type IN ('percent', 'fixed', 'gift_card')),
  reward_value   NUMERIC NOT NULL CHECK (reward_value > 0),
  min_order_amount NUMERIC NOT NULL DEFAULT 0,

  coupon_prefix     TEXT NOT NULL DEFAULT 'PROMO',
  coupon_valid_days INT  NOT NULL DEFAULT 30,
  per_customer_limit INT NOT NULL DEFAULT 1,     -- 0 = sin límite
  max_awards        INT,                          -- tope global de la regla

  valid_from     DATE,
  valid_to       DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_promo_rules_rest ON public.promo_rules (restaurant_id, is_active);

COMMENT ON TABLE public.promo_rules IS
  'Reglas de promo automática por restaurante (mig 197): visitas, gasto acumulado, gasto en un período, cumpleaños, inactividad o primera compra. Cada regla nace desactivada.';

CREATE TABLE IF NOT EXISTS public.promo_awards (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  rule_id        UUID NOT NULL REFERENCES public.promo_rules(id) ON DELETE CASCADE,
  customer_id    UUID NOT NULL REFERENCES public.customers(id)   ON DELETE CASCADE,
  coupon_id      UUID REFERENCES public.coupons(id)     ON DELETE SET NULL,
  gift_card_id   UUID REFERENCES public.gift_cards(id)  ON DELETE SET NULL,
  code           TEXT NOT NULL,
  reward_type    TEXT NOT NULL,
  reward_value   NUMERIC NOT NULL,
  status         TEXT NOT NULL DEFAULT 'issued'
                   CHECK (status IN ('issued', 'redeemed', 'expired', 'cancelled')),
  expires_at     DATE,
  awarded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  redeemed_at    TIMESTAMPTZ,
  notified_at    TIMESTAMPTZ                              -- cuándo se le avisó al cliente
);

CREATE INDEX IF NOT EXISTS idx_promo_awards_rest ON public.promo_awards (restaurant_id, awarded_at DESC);
CREATE INDEX IF NOT EXISTS idx_promo_awards_cust ON public.promo_awards (customer_id);
CREATE INDEX IF NOT EXISTS idx_promo_awards_rule ON public.promo_awards (rule_id);

ALTER TABLE public.promo_rules  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promo_awards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.promo_rules  FROM anon;
REVOKE ALL ON public.promo_awards FROM anon;

-- Las reglas las define el dueño; los premios los ve todo el staff (caja tiene
-- que poder decirle al cliente "tenés un cupón de bienvenida").
DROP POLICY IF EXISTS promo_rules_read  ON public.promo_rules;
DROP POLICY IF EXISTS promo_rules_admin ON public.promo_rules;

CREATE POLICY promo_rules_read ON public.promo_rules
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

CREATE POLICY promo_rules_admin ON public.promo_rules
  FOR ALL TO authenticated
  USING (
    public.get_my_role() IN ('admin', 'superadmin')
    AND (public.get_my_role() = 'superadmin'
         OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  )
  WITH CHECK (
    public.get_my_role() IN ('admin', 'superadmin')
    AND (public.get_my_role() = 'superadmin'
         OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  );

DROP POLICY IF EXISTS promo_awards_staff ON public.promo_awards;
CREATE POLICY promo_awards_staff ON public.promo_awards
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.promo_rules  TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.promo_awards TO authenticated;

-- ── Motor ───────────────────────────────────────────────────────────────
-- Recorre las reglas activas, busca a QUIÉN le corresponde y le emite el premio.
-- Idempotente por diseño: antes de premiar cuenta los premios vigentes que ese
-- cliente ya tiene por esa regla, así correrlo dos veces seguidas no duplica
-- nada. Devuelve un resumen para mostrarle al dueño qué pasó.
--
-- SECURITY INVOKER: quien lo corre necesita poder escribir cupones y premios en
-- ese local, y la RLS ya sabe quién puede.
CREATE OR REPLACE FUNCTION public.run_promo_engine(p_restaurant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_enabled   boolean;
  v_rule      record;
  v_cand      record;
  v_awarded   int := 0;
  v_skipped   int := 0;
  v_rules     int := 0;
  v_detail    jsonb := '[]'::jsonb;
  v_rule_cnt  int;
  v_total_cnt int;
  v_code      text;
  v_coupon_id uuid;
  v_gc        jsonb;
  v_gc_id     uuid;
  v_expires   date;
  v_try       int;
BEGIN
  SELECT c.promos_enabled INTO v_enabled
    FROM public.restaurant_marketing_config c WHERE c.restaurant_id = p_restaurant_id;
  IF v_enabled IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Las promos automáticas están desactivadas para este local');
  END IF;

  FOR v_rule IN
    SELECT * FROM public.promo_rules r
     WHERE r.restaurant_id = p_restaurant_id
       AND r.is_active = true
       AND (r.valid_from IS NULL OR r.valid_from <= current_date)
       AND (r.valid_to   IS NULL OR r.valid_to   >= current_date)
     ORDER BY r.created_at
  LOOP
    v_rules := v_rules + 1;
    v_rule_cnt := 0;

    -- Tope global de la regla: si ya se repartieron todos, no se sigue.
    IF v_rule.max_awards IS NOT NULL THEN
      SELECT count(*) INTO v_total_cnt FROM public.promo_awards a
       WHERE a.rule_id = v_rule.id AND a.status <> 'cancelled';
      IF v_total_cnt >= v_rule.max_awards THEN
        CONTINUE;
      END IF;
    END IF;

    v_expires := CASE WHEN v_rule.coupon_valid_days > 0
                      THEN current_date + v_rule.coupon_valid_days END;

    -- Sólo se premia a clientes CON FICHA activa: un cupón personal hay que
    -- poder entregárselo a alguien, y sin ficha no hay a quién.
    FOR v_cand IN
      SELECT c.id, c.first_name, c.phone, c.birth_date,
             COALESCE(s.visits, 0)      AS visits,
             COALESCE(s.total_spent, 0) AS total_spent,
             s.last_order
        FROM public.customers c
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS visits, sum(COALESCE(o.total, 0)) AS total_spent, max(o.created_at) AS last_order
            FROM public.orders o
           WHERE o.customer_id = c.id
             AND o.status NOT IN ('draft', 'cancelled')
             AND (v_rule.trigger_type <> 'spend_period'
                  OR o.created_at >= now() - make_interval(days => GREATEST(v_rule.period_days, 1)))
        ) s ON true
       WHERE c.restaurant_id = p_restaurant_id
         AND c.is_active = true
    LOOP
      -- ¿Cumple la condición de la regla?
      IF NOT (
        CASE v_rule.trigger_type
          WHEN 'visits'       THEN v_cand.visits      >= v_rule.threshold
          WHEN 'spend_total'  THEN v_cand.total_spent >= v_rule.threshold
          WHEN 'spend_period' THEN v_cand.total_spent >= v_rule.threshold AND v_cand.visits > 0
          WHEN 'first_order'  THEN v_cand.visits = 1
          WHEN 'inactive'     THEN v_cand.last_order IS NOT NULL
                                   AND v_cand.last_order < now() - make_interval(days => GREATEST(v_rule.period_days, 1))
          WHEN 'birthday'     THEN v_cand.birth_date IS NOT NULL
                                   -- "faltan N días o menos para el cumpleaños",
                                   -- calculado sobre el día del año para que
                                   -- diciembre→enero no quede afuera.
                                   AND ((date_part('doy', make_date(date_part('year', current_date)::int,
                                                                    date_part('month', v_cand.birth_date)::int,
                                                                    LEAST(date_part('day', v_cand.birth_date)::int, 28)))
                                         - date_part('doy', current_date) + 365)::int % 365)
                                       <= GREATEST(v_rule.period_days, 0)
          ELSE false
        END
      ) THEN
        CONTINUE;
      END IF;

      -- ¿Ya lo premiamos por esta regla? (0 = sin límite)
      IF v_rule.per_customer_limit > 0 THEN
        SELECT count(*) INTO v_total_cnt FROM public.promo_awards a
         WHERE a.rule_id = v_rule.id AND a.customer_id = v_cand.id
           AND a.status IN ('issued', 'redeemed');
        IF v_total_cnt >= v_rule.per_customer_limit THEN
          v_skipped := v_skipped + 1;
          CONTINUE;
        END IF;
      END IF;

      v_coupon_id := NULL; v_gc_id := NULL; v_code := NULL;

      IF v_rule.reward_type = 'gift_card' THEN
        -- El premio es saldo en una gift card a nombre del cliente.
        BEGIN
          v_gc := public.issue_gift_card(jsonb_build_object(
            'restaurant_id', p_restaurant_id,
            'amount',        v_rule.reward_value,
            'purchaser_customer_id', v_cand.id,
            'recipient_name',  v_cand.first_name,
            'recipient_phone', v_cand.phone,
            'issued_channel',  'promo',
            'message',         v_rule.name
          ));
          v_gc_id := (v_gc->>'id')::uuid;
          v_code  := v_gc->>'code';
        EXCEPTION WHEN OTHERS THEN
          -- Típico: el monto de la regla queda fuera del min/max de gift cards,
          -- o las gift cards están apagadas. Se saltea ese premio, no la corrida.
          v_skipped := v_skipped + 1;
          CONTINUE;
        END;
      ELSE
        -- Cupón personal de un solo uso.
        v_try := 0;
        LOOP
          v_try  := v_try + 1;
          v_code := upper(COALESCE(NULLIF(btrim(v_rule.coupon_prefix), ''), 'PROMO'))
                    || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 5));
          BEGIN
            INSERT INTO public.coupons (
              restaurant_id, code, discount_type, discount_value,
              min_order_amount, is_active, max_uses, valid_until, customer_id
            ) VALUES (
              p_restaurant_id, v_code,
              CASE WHEN v_rule.reward_type = 'percent' THEN 'percentage' ELSE 'fixed' END,
              round(v_rule.reward_value)::int,
              round(v_rule.min_order_amount)::int, true, 1,
              CASE WHEN v_expires IS NOT NULL THEN (v_expires + 1)::timestamptz END,
              v_cand.id
            ) RETURNING id INTO v_coupon_id;
            EXIT;
          EXCEPTION WHEN unique_violation THEN
            IF v_try >= 6 THEN EXIT; END IF;
          END;
        END LOOP;
        IF v_coupon_id IS NULL THEN
          v_skipped := v_skipped + 1;
          CONTINUE;
        END IF;
      END IF;

      INSERT INTO public.promo_awards (
        restaurant_id, rule_id, customer_id, coupon_id, gift_card_id,
        code, reward_type, reward_value, expires_at
      ) VALUES (
        p_restaurant_id, v_rule.id, v_cand.id, v_coupon_id, v_gc_id,
        v_code, v_rule.reward_type, v_rule.reward_value, v_expires
      );

      v_awarded  := v_awarded + 1;
      v_rule_cnt := v_rule_cnt + 1;

      IF v_rule.max_awards IS NOT NULL THEN
        SELECT count(*) INTO v_total_cnt FROM public.promo_awards a
         WHERE a.rule_id = v_rule.id AND a.status <> 'cancelled';
        IF v_total_cnt >= v_rule.max_awards THEN EXIT; END IF;
      END IF;
    END LOOP;

    v_detail := v_detail || jsonb_build_object('rule', v_rule.name, 'awarded', v_rule_cnt);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'rules', v_rules, 'awarded', v_awarded,
                            'skipped', v_skipped, 'detail', v_detail);
END;
$$;

REVOKE ALL ON FUNCTION public.run_promo_engine(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.run_promo_engine(uuid) TO authenticated;

COMMENT ON FUNCTION public.run_promo_engine(uuid) IS
  'Motor de promos (mig 197): evalúa las reglas activas y emite cupones personales o gift cards. Idempotente — respeta per_customer_limit y max_awards, así que correrlo de nuevo no duplica premios.';

-- ════════════════════════════════════════════════════════════════════════
-- 6) CONSUMO DE CUPONES — `used_count` no se incrementaba NUNCA
-- ════════════════════════════════════════════════════════════════════════
-- Bug preexistente que sale a la luz recién ahora: `coupons.used_count` estaba
-- en la tabla desde la mig 001 y la columna `max_uses` se mostraba en el Admin,
-- pero NADIE los tocaba — ni el checkout del QR, ni delivery, ni caja, ni mozo.
-- O sea que "USOS MÁX. 1" no limitaba nada: el mismo código servía para siempre.
-- Con cupones públicos escritos a mano era un descuido tolerable; con cupones
-- PERSONALES de una promo automática sería un agujero de plata — un código que
-- se pasa por WhatsApp y lo usa medio barrio.
--
-- Se arregla en la BASE y no en cada panel a propósito: los pedidos entran por
-- cinco caminos distintos (RPC create_order, insert directo del QR, caja, mozo,
-- delivery manual del Admin) y arreglarlo en el front dejaría cuatro sin cubrir.
--
-- SECURITY DEFINER porque el que inserta el pedido suele ser `anon` (comensal),
-- que no tiene —ni debe tener— UPDATE sobre `coupons`. Y TODO el cuerpo va
-- envuelto en EXCEPTION: contabilizar un cupón jamás puede impedir que entre un
-- pedido pago (misma regla que el CRM en create_order).
CREATE OR REPLACE FUNCTION public.consume_coupon_on_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_coupon_id uuid;
BEGIN
  IF NULLIF(btrim(COALESCE(NEW.coupon_code, '')), '') IS NULL THEN RETURN NEW; END IF;
  IF NEW.status IN ('draft', 'cancelled') THEN RETURN NEW; END IF;

  BEGIN
    UPDATE public.coupons c
       SET used_count = COALESCE(c.used_count, 0) + 1,
           -- Al agotar los usos se apaga sola: el checkout ya filtra por
           -- is_active = true, así que el cupón deja de aceptarse sin tocar
           -- una línea de los paneles.
           is_active  = CASE WHEN c.max_uses IS NOT NULL
                              AND COALESCE(c.used_count, 0) + 1 >= c.max_uses
                             THEN false ELSE c.is_active END
     WHERE c.restaurant_id = NEW.restaurant_id
       AND upper(btrim(c.code)) = upper(btrim(NEW.coupon_code))
    RETURNING c.id INTO v_coupon_id;

    -- Si el cupón venía de una promo automática, el premio pasa a "canjeado".
    -- Sin esto, "entregados" y "canjeados" serían el mismo número para siempre
    -- y el dueño no sabría si la promo sirvió de algo.
    IF v_coupon_id IS NOT NULL THEN
      UPDATE public.promo_awards a
         SET status = 'redeemed', redeemed_at = now()
       WHERE a.coupon_id = v_coupon_id AND a.status = 'issued';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;   -- best-effort: nunca frenar el pedido
  END;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_coupon_on_order() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_orders_consume_coupon ON public.orders;
CREATE TRIGGER trg_orders_consume_coupon
  AFTER INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.consume_coupon_on_order();

-- Nota deliberada: cancelar un pedido DESPUÉS de creado no devuelve el uso del
-- cupón. Es el criterio conservador (un cupón "devuelto" se puede volver a usar
-- y el local pierde dos veces); si algún día hace falta, se agrega en su propia
-- migración con su propia decisión de negocio.

-- Limpieza de una versión anterior de esta misma migración, que resolvía lo de
-- arriba con un trigger sobre `coupons` en vez de sobre `orders`.
DROP TRIGGER  IF EXISTS trg_promo_award_coupon_use ON public.coupons;
DROP FUNCTION IF EXISTS public.sync_promo_award_on_coupon_use();

-- ── updated_at automático (mismo helper que la 196) ─────────────────────
DROP TRIGGER IF EXISTS trg_gift_cards_touch ON public.gift_cards;
CREATE TRIGGER trg_gift_cards_touch
  BEFORE UPDATE ON public.gift_cards
  FOR EACH ROW EXECUTE FUNCTION public.touch_customer_updated_at();

DROP TRIGGER IF EXISTS trg_promo_rules_touch ON public.promo_rules;
CREATE TRIGGER trg_promo_rules_touch
  BEFORE UPDATE ON public.promo_rules
  FOR EACH ROW EXECUTE FUNCTION public.touch_customer_updated_at();

DROP TRIGGER IF EXISTS trg_rmc_touch ON public.restaurant_marketing_config;
CREATE TRIGGER trg_rmc_touch
  BEFORE UPDATE ON public.restaurant_marketing_config
  FOR EACH ROW EXECUTE FUNCTION public.touch_customer_updated_at();

COMMIT;

-- Recargar el cache de esquema de PostgREST para que tome tablas/columnas/grants.
NOTIFY pgrst, 'reload schema';

SELECT 'migración 197 aplicada — CRM con estadísticas reales + gift cards y promos (apagadas por defecto)' AS status;
