-- ════════════════════════════════════════════════════════════════════════
-- 194 · COBRO AUTOSERVICIO DE LA SUSCRIPCIÓN (el dueño paga desde el panel)
--       (PREPARED — NOT APPLIED: aplicar manualmente tras backup nuevo,
--        Supabase SQL Editor en INGLÉS, rol postgres. Claude Code NO la aplica.)
-- ────────────────────────────────────────────────────────────────────────
-- PROBLEMA (pedido de Renato, 2026-07-30): dentro del panel NO hay forma práctica
-- de contratar ni de renovar. Todo termina en un `wa.me/...`:
--   · src/admin/main.jsx → UpgradeModal: lista los planes y el único botón es WhatsApp.
--   · Dashboard → tarjeta "Estado de suscripción": informa "vence en 3 días", sin CTA.
--   · Configuración → Mi cuenta: perfil y datos del dueño; cero facturación.
-- Y la mig 193 está por meter CORTE DE SERVICIO real a los 5 días de vencer. Sin
-- esta migración, el corte deja al dueño sin ninguna salida autoservicio: panel
-- bloqueado y "escribinos por WhatsApp". Esta migración es el prerrequisito
-- funcional de la 193.
--
-- DECISIÓN DE DISEÑO
--   Paraguay, y Bancard todavía NO está integrado (`caja:digital_payments` sigue
--   fuera de las capacidades vivas). El carril real hoy es TRANSFERENCIA BANCARIA
--   + comprobante. Eso ya está resuelto en el producto para que el COMENSAL le
--   pague al RESTAURANTE (migs 180/181/182/183). Acá se reusa exactamente el mismo
--   patrón, un nivel más arriba: el RESTAURANTE le paga a MYTHOS.
--     · Los datos bancarios de destino son los de Mythos (tabla nueva, editable
--       desde Superadmin) en vez de los del comercio.
--     · El comprobante va al MISMO bucket privado `comprobantes`, bajo la ruta
--       `<restaurant_id>/subs/<archivo>` → las policies de la 183 ya lo cubren
--       (foldername[1] = restaurant_id). No hace falta bucket nuevo.
--     · La validación aprobar/rechazar es la misma idea que `payment_reviews`,
--       pero sobre `payments` (que hoy está HUÉRFANA: ningún panel la lee).
--
-- QUÉ HACE
--   A) `platform_billing_config` — singleton con los datos de cobro de MYTHOS
--      (banco, titular, cuenta, alias, QR, instrucciones) + los knobs de negocio.
--      Escribe solo el superadmin; el dueño la lee por RPC (nunca por tabla).
--   B) `payments` se completa como tabla de pagos de suscripción (período, plan,
--      comprobante, estado de revisión, quién lo subió/validó).
--   C) **RLS de `payments` CERRADA**. Hoy es `sa_payments_all USING(true)` con
--      privilegios para `anon` — uno de los agujeros CONFIRMADOS en prod del bug
--      crítico #1 (`MYTHOS_PRESPRINT_REPORT.md`). Como ningún frontend la usa
--      todavía, se puede cerrar sin romper nada. Queda: superadmin ve todo, el
--      dueño ve SOLO los de su empresa, anon no ve ni escribe nada, y el alta
--      pasa exclusivamente por RPC.
--   D) `get_billing_overview()` — todo lo que necesita la pantalla del dueño en
--      UNA llamada: plan vigente, estado/gracia, catálogo de planes, datos de
--      cobro e historial. Tenant-scoped.
--   E) `submit_subscription_payment()` — el dueño declara la transferencia y sube
--      el comprobante. Queda `pending` para que Renato la valide.
--   F) ACTIVACIÓN PROVISIONAL (opcional, `provisional_days`, default 3): si el
--      local está cortado (o a punto), al enviar el comprobante el servicio se
--      reactiva EN EL ACTO por N días, marcado `past_due`, y Renato valida
--      después. Un sábado a la noche sin caja cuesta más caro que un comprobante
--      trucho ocasional — y si es trucho, el rechazo revierte la fecha y corta.
--      Poner `provisional_days = 0` desactiva la función por completo.
--   G) `review_subscription_payment()` — el superadmin aprueba (extiende de verdad
--      el período y aplica el cambio de plan si lo hubo) o rechaza (revierte la
--      activación provisional). Todo queda en `platform_events`.
--   H) `request_plan_change()` — "quiero cambiar de plan" sin pagar todavía: deja
--      constancia para el superadmin en vez de abrir WhatsApp.
--
-- ⚠ RELACIÓN CON LA 193
--   Independientes pero complementarias: la 193 pone el corte, la 194 la salida.
--   Aplicar 194 ANTES o JUNTO con la 193 — nunca la 193 sola.
--   No se pisan: la 194 no redefine ninguna función de la 193 (solo la INVOCA:
--   `resolve_entitled_plan_id` y `billing_grace_days`). Si la 193 no está
--   aplicada, la 194 degrada sola (ver el bloque de compatibilidad más abajo).
--
-- 100% ADITIVA en esquema (1 tabla + columnas nuevas + 4 RPCs). El único cambio
-- RESTRICTIVO es la RLS de `payments`, que hoy no consume ningún panel.
-- Idempotente / re-ejecutable.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── A) Datos de cobro de MYTHOS + knobs de negocio ──────────────────────────
--    Singleton: una sola fila, forzada por un PK constante. Así el superadmin
--    edita "los datos de cobro" sin manejar ids ni riesgo de filas duplicadas.
CREATE TABLE IF NOT EXISTS public.platform_billing_config (
  id                 BOOLEAN PRIMARY KEY DEFAULT true CHECK (id = true),
  -- Datos que ve el dueño para transferir
  bank_holder        TEXT,          -- Titular de la cuenta
  bank_name          TEXT,          -- Banco / financiera
  bank_account       TEXT,          -- Nº de cuenta
  bank_doc           TEXT,          -- RUC / CI del titular
  bank_alias         TEXT,          -- Alias o teléfono para billetera
  qr_url             TEXT,          -- URL de una imagen QR (pago por billetera)
  instructions       TEXT,          -- Texto libre ("enviá el comprobante…")
  -- Knobs de negocio
  provisional_days   INT     NOT NULL DEFAULT 3
    CHECK (provisional_days BETWEEN 0 AND 30),
  accepts_transfer   BOOLEAN NOT NULL DEFAULT true,
  accepts_cash       BOOLEAN NOT NULL DEFAULT false,
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_by         UUID
);

COMMENT ON TABLE public.platform_billing_config IS
  'Singleton: datos bancarios de MYTHOS para cobrar suscripciones + knobs (días de activación provisional, métodos aceptados). Lo edita SOLO el superadmin; el dueño lo lee por get_billing_overview().';
COMMENT ON COLUMN public.platform_billing_config.provisional_days IS
  'Días de servicio que se otorgan EN EL ACTO al enviar un comprobante, antes de que el superadmin lo valide. 0 = desactivar la activación provisional.';

-- Fila única (no pisa los datos si ya existe).
INSERT INTO public.platform_billing_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.platform_billing_config ENABLE ROW LEVEL SECURITY;

-- Nadie lee esta tabla directo (ni el dueño): los datos salen por la RPC, que
-- devuelve solo los campos de cobro. Escritura: superadmin.
DROP POLICY IF EXISTS pbc_superadmin_all ON public.platform_billing_config;
CREATE POLICY pbc_superadmin_all ON public.platform_billing_config
  FOR ALL TO authenticated
  USING (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

REVOKE ALL ON public.platform_billing_config FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.platform_billing_config TO authenticated;

-- ── B) `payments` se completa como tabla de pagos de suscripción ────────────
--    La creó la mig 028 y quedó huérfana (ningún panel la lee). Se le suman las
--    columnas del flujo de comprobante + revisión.
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS plan_id           UUID REFERENCES public.subscription_plans(id),
  ADD COLUMN IF NOT EXISTS months            INT,
  ADD COLUMN IF NOT EXISTS period_start      DATE,
  ADD COLUMN IF NOT EXISTS period_end        DATE,
  ADD COLUMN IF NOT EXISTS reference         TEXT,        -- Nº de comprobante de la transferencia
  ADD COLUMN IF NOT EXISTS proof_url         TEXT,        -- path dentro del bucket `comprobantes`
  ADD COLUMN IF NOT EXISTS review_status     TEXT,        -- pending | approved | rejected (NULL = carga manual del superadmin)
  ADD COLUMN IF NOT EXISTS submitted_by      UUID,
  ADD COLUMN IF NOT EXISTS reviewed_by       UUID,
  ADD COLUMN IF NOT EXISTS reviewed_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_notes      TEXT,
  ADD COLUMN IF NOT EXISTS provisional_until DATE,        -- hasta cuándo llega la activación provisional
  ADD COLUMN IF NOT EXISTS prev_end_date     DATE;        -- end_date previo, para revertir si se rechaza

-- CHECK de review_status por introspección (idempotente ante re-ejecución).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.payments'::regclass
       AND conname  = 'payments_review_status_check'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_review_status_check
      CHECK (review_status IS NULL OR review_status IN ('pending','approved','rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payments_rest_created ON public.payments(restaurant_id, created_at DESC);
-- Un solo pago pendiente de validación por restaurante (anti-duplicado y
-- anti-abuso de la activación provisional). Índice parcial único.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_one_pending
  ON public.payments(restaurant_id) WHERE review_status = 'pending';

COMMENT ON COLUMN public.payments.proof_url IS
  'Path del comprobante dentro del bucket privado `comprobantes`, bajo <restaurant_id>/subs/. Se lee con createSignedUrl.';
COMMENT ON COLUMN public.payments.prev_end_date IS
  'subscriptions.end_date ANTES de la activación provisional. Permite revertir exactamente si el pago se rechaza.';

-- ── C) RLS de `payments`: cerrar el USING(true) heredado de la mig 028 ──────
--    Estado previo (CONFIRMADO en prod): `sa_payments_all FOR ALL USING(true)` +
--    privilegios de anon → cualquiera con la anon key leía y escribía los pagos
--    de toda la plataforma. Se cierra ahora que la tabla empieza a usarse.
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sa_payments_all      ON public.payments;
DROP POLICY IF EXISTS pay_select_scoped    ON public.payments;
DROP POLICY IF EXISTS pay_superadmin_write ON public.payments;

-- Lectura: superadmin todo; el resto, SOLO los de su empresa (el dueño ve su
-- propio historial de pagos en el panel).
CREATE POLICY pay_select_scoped ON public.payments
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

-- Escritura directa: SOLO superadmin (carga manual desde su panel). El alta del
-- dueño entra por `submit_subscription_payment` (SECURITY DEFINER), nunca por
-- INSERT directo → no puede inventarse un pago aprobado.
CREATE POLICY pay_superadmin_write ON public.payments
  FOR ALL TO authenticated
  USING (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

REVOKE ALL ON public.payments FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payments TO authenticated;   -- RLS filtra

-- ── Bucket de comprobantes (autosuficiente si la mig 183 no está aplicada) ──
--    Mismo bucket privado. Los pagos de suscripción viven en <rid>/subs/.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('comprobantes','comprobantes', false, 5242880, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET
  public             = false,
  file_size_limit    = 5242880,
  allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp'];

DROP POLICY IF EXISTS comp_auth_insert ON storage.objects;
CREATE POLICY comp_auth_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'comprobantes' AND (
      public.get_my_role() = 'superadmin'
      OR (storage.foldername(name))[1] IN (SELECT rid::text FROM public.get_my_company_restaurant_ids() AS rid)
    )
  );

DROP POLICY IF EXISTS comp_auth_select ON storage.objects;
CREATE POLICY comp_auth_select ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'comprobantes' AND (
      public.get_my_role() = 'superadmin'
      OR (storage.foldername(name))[1] IN (SELECT rid::text FROM public.get_my_company_restaurant_ids() AS rid)
    )
  );

-- ── Compatibilidad con la 193 (por si todavía no se aplicó) ─────────────────
--    Las RPCs de abajo llaman a `resolve_entitled_plan_id` y `billing_grace_days`,
--    y escriben `status = 'past_due'`. `resolve_entitled_plan_id` existe desde la
--    mig 160; lo demás lo trae la 193. Acá se replica SOLO lo imprescindible, de
--    forma idempotente, para que la 194 funcione sola y en cualquier orden.

--    (1) `past_due` como estado válido. Mismo bloque que la 193 (por introspección,
--        porque en prod el CHECK puede tener otro nombre por drift).
DO $$
DECLARE
  r RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.subscriptions'::regclass
       AND c.contype  = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%past_due%'
  ) THEN
    FOR r IN
      SELECT c.conname
        FROM pg_constraint c
       WHERE c.conrelid = 'public.subscriptions'::regclass
         AND c.contype  = 'c'
         AND pg_get_constraintdef(c.oid) ILIKE '%status%'
         AND pg_get_constraintdef(c.oid) ILIKE '%cancelled%'
    LOOP
      EXECUTE format('ALTER TABLE public.subscriptions DROP CONSTRAINT %I', r.conname);
    END LOOP;
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT subscriptions_status_check
      CHECK (status IN ('active','trial','past_due','expired','cancelled','suspended'));
  END IF;
END $$;

--    (2) `billing_grace_days`: stub SOLO si falta. Si la 193 se aplica después,
--        su CREATE OR REPLACE lo pisa con la versión buena.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'billing_grace_days' AND pronamespace = 'public'::regnamespace
  ) THEN
    EXECUTE $fn$
      CREATE FUNCTION public.billing_grace_days(p_restaurant_id uuid)
      RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
      AS 'SELECT 5';
    $fn$;
    REVOKE ALL ON FUNCTION public.billing_grace_days(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.billing_grace_days(uuid) TO authenticated;
  END IF;
END $$;

-- ── Helper: ¿el usuario manda en este restaurante? ──────────────────────────
--    Pagar y pedir cambio de plan son actos del DUEÑO. Un mozo o un cajero del
--    mismo local NO pueden hacerlo, aunque compartan tenant.
CREATE OR REPLACE FUNCTION public.is_billing_manager(p_restaurant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.get_my_role() = 'superadmin'
      OR EXISTS (
           SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
              AND ur.is_active = true
              AND ur.restaurant_id = p_restaurant_id
              AND lower(ur.role) IN ('admin','owner')
         );
$$;
REVOKE ALL ON FUNCTION public.is_billing_manager(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_billing_manager(uuid) TO authenticated;

-- ── D) Todo lo que la pantalla del dueño necesita, en una sola llamada ──────
CREATE OR REPLACE FUNCTION public.get_billing_overview(p_restaurant_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rid       uuid;
  v_sub       RECORD;
  v_plan      jsonb;
  v_plans     jsonb;
  v_bill      jsonb;
  v_pays      jsonb;
  v_entitled  boolean;
  v_grace     int;
  v_is_mgr    boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;

  -- Restaurante: el pedido (si es de mi empresa) o el primero de mi rol activo.
  IF p_restaurant_id IS NOT NULL
     AND p_restaurant_id IN (SELECT public.get_my_company_restaurant_ids()) THEN
    v_rid := p_restaurant_id;
  ELSE
    SELECT restaurant_id INTO v_rid
      FROM public.user_roles
     WHERE user_id = auth.uid() AND is_active = true AND restaurant_id IS NOT NULL
     ORDER BY created_at ASC
     LIMIT 1;
  END IF;

  IF v_rid IS NULL THEN
    RETURN jsonb_build_object('restaurant_id', NULL, 'can_manage', false);
  END IF;

  v_is_mgr := public.is_billing_manager(v_rid);

  SELECT s.* INTO v_sub
    FROM public.subscriptions s
   WHERE s.restaurant_id = v_rid
   ORDER BY s.created_at DESC
   LIMIT 1;

  v_entitled := (public.resolve_entitled_plan_id(v_rid) IS NOT NULL);
  v_grace    := COALESCE(public.billing_grace_days(v_rid), 5);

  -- Plan vigente (to_jsonb: sobrevive al drift de columnas del catálogo).
  SELECT to_jsonb(sp) INTO v_plan
    FROM public.subscription_plans sp
   WHERE sp.id = v_sub.plan_id;

  -- Catálogo de planes activos (lo que el dueño puede contratar).
  SELECT jsonb_agg(to_jsonb(sp) ORDER BY sp.price_usd ASC) INTO v_plans
    FROM public.subscription_plans sp
   WHERE sp.is_active = true;

  -- Datos de cobro: solo si el usuario es quien paga. Un cajero no ve la cuenta
  -- bancaria de Mythos ni los knobs de negocio.
  IF v_is_mgr THEN
    SELECT jsonb_build_object(
             'bank_holder',      c.bank_holder,
             'bank_name',        c.bank_name,
             'bank_account',     c.bank_account,
             'bank_doc',         c.bank_doc,
             'bank_alias',       c.bank_alias,
             'qr_url',           c.qr_url,
             'instructions',     c.instructions,
             'provisional_days', c.provisional_days,
             'accepts_transfer', c.accepts_transfer,
             'accepts_cash',     c.accepts_cash
           ) INTO v_bill
      FROM public.platform_billing_config c
     WHERE c.id = true;

    SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at DESC) INTO v_pays
      FROM (
        SELECT id, amount, currency, method, status, review_status, reference,
               proof_url, months, period_start, period_end, paid_at, created_at,
               reviewed_at, review_notes, provisional_until
          FROM public.payments
         WHERE restaurant_id = v_rid
         ORDER BY created_at DESC
         LIMIT 24
      ) p;
  END IF;

  RETURN jsonb_build_object(
    'restaurant_id',  v_rid,
    'can_manage',     v_is_mgr,
    'subscription',   CASE WHEN v_sub.id IS NULL THEN NULL ELSE jsonb_build_object(
                        'id',             v_sub.id,
                        'status',         v_sub.status,
                        'start_date',     v_sub.start_date,
                        'end_date',       v_sub.end_date,
                        'auto_renew',     v_sub.auto_renew,
                        'monthly_amount', v_sub.monthly_amount,
                        'days_left',      (v_sub.end_date - CURRENT_DATE),
                        'grace_days',     CASE WHEN v_sub.status = 'trial' THEN 0 ELSE v_grace END,
                        'grace_ends_on',  CASE WHEN v_sub.status = 'trial' THEN v_sub.end_date
                                               ELSE v_sub.end_date + v_grace END
                      ) END,
    'plan',           v_plan,
    'plans',          COALESCE(v_plans, '[]'::jsonb),
    'entitled',       v_entitled,
    'locked',         (NOT v_entitled),
    'billing',        v_bill,
    'payments',       COALESCE(v_pays, '[]'::jsonb),
    'has_pending',    EXISTS (SELECT 1 FROM public.payments
                               WHERE restaurant_id = v_rid AND review_status = 'pending')
  );
END;
$$;
REVOKE ALL     ON FUNCTION public.get_billing_overview(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_billing_overview(uuid) TO authenticated;

-- ── E+F) El dueño declara el pago (+ activación provisional) ────────────────
CREATE OR REPLACE FUNCTION public.submit_subscription_payment(
  p_restaurant_id uuid,
  p_plan_id       uuid,
  p_months        int,
  p_amount        numeric,
  p_method        text DEFAULT 'transferencia',
  p_reference     text DEFAULT NULL,
  p_proof_url     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_months    int  := GREATEST(COALESCE(p_months, 1), 1);
  v_prov_days int;
  v_sub       RECORD;
  v_prev_end  date;
  v_prov_to   date;
  v_pay_id    uuid;
  v_rejected  boolean;
  v_plan_name text;
BEGIN
  IF p_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'restaurant_id requerido' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_billing_manager(p_restaurant_id) THEN
    RAISE EXCEPTION 'Solo el dueño del local puede registrar un pago de la suscripción'
      USING ERRCODE = '42501';
  END IF;
  IF COALESCE(p_amount, 0) <= 0 THEN
    RAISE EXCEPTION 'El monto debe ser mayor a cero' USING ERRCODE = '22023';
  END IF;
  IF p_method NOT IN ('manual','transferencia','tarjeta','efectivo','qr') THEN
    RAISE EXCEPTION 'Método de pago inválido' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments
              WHERE restaurant_id = p_restaurant_id AND review_status = 'pending') THEN
    RAISE EXCEPTION 'Ya tenés un pago esperando validación. Te avisamos apenas lo revisemos.'
      USING ERRCODE = '23505';
  END IF;

  SELECT * INTO v_sub
    FROM public.subscriptions
   WHERE restaurant_id = p_restaurant_id
   ORDER BY created_at DESC
   LIMIT 1;

  v_prev_end := v_sub.end_date;

  SELECT provisional_days INTO v_prov_days FROM public.platform_billing_config WHERE id = true;
  v_prov_days := COALESCE(v_prov_days, 3);

  -- Anti-abuso: si a este local ya le rechazaron un comprobante en los últimos 30
  -- días, no hay activación provisional — que espere la validación humana.
  SELECT EXISTS (
    SELECT 1 FROM public.payments
     WHERE restaurant_id = p_restaurant_id
       AND review_status = 'rejected'
       AND COALESCE(reviewed_at, created_at) > now() - interval '30 days'
  ) INTO v_rejected;

  -- Se otorga SOLO si hace falta: si el local ya tiene servicio, no se toca nada
  -- (la extensión real la aplica el superadmin al aprobar).
  IF v_prov_days > 0
     AND NOT v_rejected
     AND v_sub.id IS NOT NULL
     AND public.resolve_entitled_plan_id(p_restaurant_id) IS NULL THEN
    v_prov_to := CURRENT_DATE + v_prov_days;
    UPDATE public.subscriptions
       SET status   = 'past_due',
           end_date = v_prov_to,
           notes    = COALESCE(notes,'') || E'\n[' || to_char(now(),'YYYY-MM-DD HH24:MI') ||
                      '] Activación provisional ' || v_prov_days || 'd por comprobante enviado (pendiente de validar).'
     WHERE id = v_sub.id;
  END IF;

  INSERT INTO public.payments (
    restaurant_id, subscription_id, plan_id, amount, currency, method, status,
    months, period_start, period_end, reference, proof_url, review_status,
    submitted_by, provisional_until, prev_end_date, paid_at, notes
  ) VALUES (
    p_restaurant_id, v_sub.id, COALESCE(p_plan_id, v_sub.plan_id), p_amount, 'PYG',
    p_method, 'pending', v_months,
    GREATEST(COALESCE(v_prev_end, CURRENT_DATE), CURRENT_DATE),
    (GREATEST(COALESCE(v_prev_end, CURRENT_DATE), CURRENT_DATE) + (v_months || ' months')::interval)::date,
    NULLIF(p_reference,''), NULLIF(p_proof_url,''), 'pending',
    auth.uid(), v_prov_to, v_prev_end, NULL,
    'Declarado por el dueño desde el panel'
  )
  RETURNING id INTO v_pay_id;

  SELECT name INTO v_plan_name FROM public.subscription_plans WHERE id = COALESCE(p_plan_id, v_sub.plan_id);

  INSERT INTO public.platform_events (restaurant_id, event_type, description)
  VALUES (p_restaurant_id, 'payment_submitted',
          'Pago declarado por el dueño: ' || p_amount::text || ' PYG · ' || v_months ||
          ' mes(es) · plan ' || COALESCE(v_plan_name,'—') || ' · método ' || p_method ||
          CASE WHEN v_prov_to IS NOT NULL THEN ' · ACTIVACIÓN PROVISIONAL hasta ' || v_prov_to::text ELSE '' END);

  RETURN jsonb_build_object(
    'payment_id',        v_pay_id,
    'provisional_until', v_prov_to,
    'reactivated',       (v_prov_to IS NOT NULL)
  );
END;
$$;
REVOKE ALL     ON FUNCTION public.submit_subscription_payment(uuid,uuid,int,numeric,text,text,text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.submit_subscription_payment(uuid,uuid,int,numeric,text,text,text) TO authenticated;

-- ── G) El superadmin valida: aprobar extiende de verdad, rechazar revierte ──
CREATE OR REPLACE FUNCTION public.review_subscription_payment(
  p_payment_id uuid,
  p_approve    boolean,
  p_notes      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pay     RECORD;
  v_sub     RECORD;
  v_base    date;
  v_new_end date;
BEGIN
  IF public.get_my_role() <> 'superadmin' THEN
    RAISE EXCEPTION 'Solo el superadmin valida pagos' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_pay FROM public.payments WHERE id = p_payment_id;
  IF v_pay.id IS NULL THEN
    RAISE EXCEPTION 'Pago inexistente' USING ERRCODE = '22023';
  END IF;
  IF v_pay.review_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'Ese pago ya fue revisado' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_sub
    FROM public.subscriptions
   WHERE restaurant_id = v_pay.restaurant_id
   ORDER BY created_at DESC
   LIMIT 1;

  IF p_approve THEN
    -- Base del nuevo período: si venció, arranca hoy (no se cobra retroactivo);
    -- si está al día, se encadena al vencimiento actual. Si hubo activación
    -- provisional, se parte del end_date PREVIO para no regalar esos días.
    v_base    := GREATEST(COALESCE(v_pay.prev_end_date, v_sub.end_date, CURRENT_DATE), CURRENT_DATE);
    v_new_end := (v_base + (COALESCE(v_pay.months,1) || ' months')::interval)::date;

    IF v_sub.id IS NULL THEN
      -- Local SIN fila de suscripción (alta manual incompleta, o borrada). Sin
      -- esto el pago se aprobaba y no habilitaba nada: plata cobrada y servicio
      -- cortado. Se crea la suscripción con el plan pagado.
      IF v_pay.plan_id IS NULL THEN
        RAISE EXCEPTION 'El pago no indica plan y el local no tiene suscripción: asignale un plan primero'
          USING ERRCODE = '22023';
      END IF;
      INSERT INTO public.subscriptions (restaurant_id, plan_id, status, start_date, end_date,
                                        monthly_amount, payment_method, notes)
      VALUES (v_pay.restaurant_id, v_pay.plan_id, 'active', CURRENT_DATE, v_new_end,
              v_pay.amount / GREATEST(COALESCE(v_pay.months,1),1), COALESCE(v_pay.method,'transferencia'),
              '[' || to_char(now(),'YYYY-MM-DD HH24:MI') || '] Creada al aprobar el primer pago autoservicio.')
      ON CONFLICT (restaurant_id) DO UPDATE
        SET status = 'active', plan_id = EXCLUDED.plan_id, end_date = EXCLUDED.end_date;
    ELSE
      UPDATE public.subscriptions
         SET status            = 'active',
             plan_id           = COALESCE(v_pay.plan_id, plan_id),
             end_date          = v_new_end,
             monthly_amount    = COALESCE(monthly_amount, v_pay.amount / GREATEST(COALESCE(v_pay.months,1),1)),
             notes             = COALESCE(notes,'') || E'\n[' || to_char(now(),'YYYY-MM-DD HH24:MI') ||
                                 '] Pago aprobado — servicio hasta ' || v_new_end::text || '.'
       WHERE id = v_sub.id;
    END IF;

    UPDATE public.payments
       SET status        = 'paid',
           review_status = 'approved',
           reviewed_by   = auth.uid(),
           reviewed_at   = now(),
           review_notes  = NULLIF(p_notes,''),
           paid_at       = COALESCE(paid_at, now()),
           period_start  = v_base,
           period_end    = v_new_end
     WHERE id = p_payment_id;

    INSERT INTO public.platform_events (restaurant_id, event_type, description)
    VALUES (v_pay.restaurant_id, 'payment_approved',
            'Pago aprobado: ' || v_pay.amount::text || ' PYG · servicio hasta ' || v_new_end::text);

    RETURN jsonb_build_object('approved', true, 'end_date', v_new_end);
  END IF;

  -- RECHAZO: revierte la activación provisional al valor exacto previo. Si el
  -- local ya estaba vencido, vuelve a estarlo (y la 193 lo corta de nuevo).
  IF v_pay.provisional_until IS NOT NULL AND v_sub.id IS NOT NULL THEN
    UPDATE public.subscriptions
       SET end_date = COALESCE(v_pay.prev_end_date, end_date),
           status   = CASE WHEN COALESCE(v_pay.prev_end_date, end_date) < CURRENT_DATE
                           THEN 'expired' ELSE status END,
           notes    = COALESCE(notes,'') || E'\n[' || to_char(now(),'YYYY-MM-DD HH24:MI') ||
                      '] Comprobante rechazado — se revierte la activación provisional.'
     WHERE id = v_sub.id;
  END IF;

  UPDATE public.payments
     SET status        = 'failed',
         review_status = 'rejected',
         reviewed_by   = auth.uid(),
         reviewed_at   = now(),
         review_notes  = NULLIF(p_notes,'')
   WHERE id = p_payment_id;

  INSERT INTO public.platform_events (restaurant_id, event_type, description)
  VALUES (v_pay.restaurant_id, 'payment_rejected',
          'Pago rechazado' || COALESCE(' — ' || NULLIF(p_notes,''), ''));

  RETURN jsonb_build_object('approved', false);
END;
$$;
REVOKE ALL     ON FUNCTION public.review_subscription_payment(uuid,boolean,text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.review_subscription_payment(uuid,boolean,text) TO authenticated;

-- ── H) "Quiero cambiar de plan" sin pagar todavía ───────────────────────────
--    Reemplaza al `wa.me/...` del UpgradeModal: deja constancia consultable en
--    vez de un mensaje suelto de WhatsApp que se pierde.
CREATE OR REPLACE FUNCTION public.request_plan_change(
  p_restaurant_id uuid,
  p_plan_id       uuid,
  p_note          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan text;
  v_rest text;
BEGIN
  IF NOT public.is_billing_manager(p_restaurant_id) THEN
    RAISE EXCEPTION 'Solo el dueño del local puede pedir un cambio de plan' USING ERRCODE = '42501';
  END IF;

  SELECT name INTO v_plan FROM public.subscription_plans WHERE id = p_plan_id;
  SELECT name INTO v_rest FROM public.restaurants        WHERE id = p_restaurant_id;

  IF v_plan IS NULL THEN
    RAISE EXCEPTION 'Plan inexistente' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.platform_events (restaurant_id, event_type, description)
  VALUES (p_restaurant_id, 'plan_change_requested',
          COALESCE(v_rest,'Un local') || ' pidió cambiar al plan ' || v_plan ||
          COALESCE(' — ' || NULLIF(p_note,''), ''));

  RETURN jsonb_build_object('ok', true, 'plan', v_plan);
END;
$$;
REVOKE ALL     ON FUNCTION public.request_plan_change(uuid,uuid,text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.request_plan_change(uuid,uuid,text) TO authenticated;

COMMIT;

-- Recargar el cache de esquema de PostgREST (funciones/columnas nuevas).
NOTIFY pgrst, 'reload schema';

-- ── Post-instalación (hacerlo SÍ o SÍ) ──────────────────────────────────────
-- Cargar los datos de cobro reales de MYTHOS, o el dueño ve la pantalla vacía.
-- Se puede hacer desde Superadmin › Facturación › "Datos de cobro", o acá:
--
--   UPDATE public.platform_billing_config SET
--     bank_holder  = 'Renato Mancuello',
--     bank_name    = 'Banco …',
--     bank_account = '…',
--     bank_doc     = 'RUC …',
--     bank_alias   = '09xx xxx xxx',
--     instructions = 'Transferí el monto y subí la foto del comprobante. Validamos en el día.',
--     provisional_days = 3
--   WHERE id = true;
--
-- ── Verificación (correr aparte, como postgres) ─────────────────────────────
-- (a) `payments` ya no está abierta a anon (debe devolver 0 filas):
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_name = 'payments' AND grantee = 'anon';
-- (b) Las policies nuevas están vivas (debe listar pay_select_scoped y pay_superadmin_write):
--   SELECT policyname FROM pg_policies WHERE tablename = 'payments';
-- (c) Las 4 RPCs existen:
--   SELECT proname FROM pg_proc
--    WHERE pronamespace='public'::regnamespace
--      AND proname IN ('get_billing_overview','submit_subscription_payment',
--                      'review_subscription_payment','request_plan_change');
-- (d) Como dueño logueado, la pantalla trae datos:
--   SELECT public.get_billing_overview(NULL);
SELECT 'migración 194 aplicada — cobro autoservicio (checkout + validación) + RLS de payments cerrada' AS status;
