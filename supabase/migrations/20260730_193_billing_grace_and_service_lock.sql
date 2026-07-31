-- ════════════════════════════════════════════════════════════════════════
-- 193 · PERÍODO DE GRACIA + CORTE DE SERVICIO POR FACTURACIÓN
--       (PREPARED — NOT APPLIED: aplicar manualmente tras backup nuevo,
--        Supabase SQL Editor en INGLÉS, rol postgres. Claude Code NO la aplica.)
-- ────────────────────────────────────────────────────────────────────────
-- PROBLEMA (obs. Renato 2026-07-30, con evidencia en vivo): la suscripción de su
-- local venció el 24/07 — el panel muestra la barra roja "Tu suscripción venció"
-- (public/mythos-auth-guard.js) — y SIN EMBARGO se pudo cargar un pedido desde el
-- Menú QR, entró a cocina y llegó a Admin. O sea: **el período de gracia era
-- INFINITO y no había ningún corte**.
--
-- CAUSA RAÍZ (tres cosas, ninguna es un bug suelto):
--   1. La regla canónica viva `resolve_entitled_plan_id` (mig 160) dice
--      "habilitado = sub más nueva con status IN ('active','past_due')" — SIN
--      mirar `end_date`. Una sub 'active' vencida hace un mes sigue habilitando.
--   2. NADA flipea `active → expired`: no hay cron ni trigger de facturación
--      (los únicos crons de vercel.json son keep-alive y purge-comprobantes).
--   3. El aviso de vencimiento es 100% cosmético (banner + modal 1 vez por día,
--      documentado como "No bloquea (período de gracia)").
--   Nota adicional: `past_due` ni siquiera era un estado válido — el CHECK de la
--   mig 004 solo admite active/trial/expired/cancelled/suspended, aunque el
--   selector del superadmin lo ofrece (guardarlo fallaba).
--
-- DECISIÓN (Renato, 2026-07-30):
--   · GRACIA = 5 días corridos después de `end_date`, configurable.
--   · Pasada la gracia se CORTA el servicio: paneles de staff bloqueados y el
--     local deja de recibir pedidos nuevos.
--   · Al dueño (admin) se le dice la verdad: venció, regularizá, contactá soporte.
--     Al resto del personal NO se le menciona el pago: mensaje neutro
--     ("servicio no disponible, hablá con la administración del local").
--
-- QUÉ HACE ESTA MIGRACIÓN
--   A) `past_due` pasa a ser un estado válido de `subscriptions` (mora explícita).
--   B) Dos knobs de gracia, en tablas que el superadmin YA edita:
--        · `subscription_plans.grace_days`  (default del plan, arranca en 5)
--        · `subscriptions.grace_days`       (override para un cliente puntual)
--      Resolución: COALESCE(sub, plan, 5). No hace falta tabla nueva.
--   C) `resolve_entitled_plan_id` (LA regla canónica, mig 160/163) ahora exige que
--      la sub esté DENTRO de la ventana `end_date + gracia`. Como los 5 resolvers
--      de la mig 160 ya cuelgan de este helper, el corte se propaga solo a
--      capabilities, paneles y triggers de límite. **Absorbe la mig 163** (trial
--      no vencido habilita) → si la 163 nunca se aplicó, esta la deja aplicada.
--   D) `restaurant_panel_enabled` (la RPC anon que gatea delivery-cliente) pasa a
--      resolver por el helper → corte por facturación también en la página pública.
--      **Absorbe la parte A de la mig 176** (ver ORDEN DE APLICACIÓN abajo).
--   E) `get_public_capabilities` suma el flag `ordering` para que el Menú QR y el
--      delivery muestren una pantalla neutra ANTES de que el comensal arme el
--      carrito. **Autosuficiente: incluye la mig 192 entera** (si la 192 no está
--      aplicada, esta la crea).
--   F) DIENTES REALES: trigger `BEFORE INSERT ON orders` que rechaza pedidos
--      nuevos cuando no hay suscripción habilitante. Se hace con TRIGGER y no
--      tocando `create_order` a propósito: cubre TODOS los caminos de alta de
--      pedido (RPC del cliente QR, delivery, caja, mozo, API) y no depende de la
--      versión viva de esa función (menos riesgo de drift).
--   G) `get_my_account_status` (la que consumen los 8 paneles vía
--      mythos-auth-guard.js) devuelve ahora `grace_days`, `days_overdue`,
--      `grace_ends_on`, `in_grace` y `locked` — el cliente no recalcula nada,
--      solo pinta.
--
-- ⚠ ORDEN DE APLICACIÓN / CONVIVENCIA CON MIGRACIONES PENDIENTES
--   Esta migración es autosuficiente: puede aplicarse con 163 / 176 / 192 sin
--   aplicar. PERO redefine funciones que esas tres también redefinen. Si algún día
--   se aplica una de ellas DESPUÉS de esta, hay que volver a correr la 193 (que es
--   idempotente) para no revertir el corte por gracia.
--
-- ⚠ ALCANCE DEL CORTE — CORRER EL DRY-RUN ANTES DE APLICAR
--   Después de aplicar, un local queda CORTADO si no tiene ninguna suscripción
--   habilitante (incluye: sin fila de suscripción, o cancelled/suspended/expired,
--   o vencida hace más de `grace_days`, o trial vencido). Para ver EXACTAMENTE a
--   quién corta, correr esto ANTES (no modifica nada):
--
--     SELECT r.name, s.status, s.end_date,
--            COALESCE(s.grace_days, 5) AS gracia,
--            (CURRENT_DATE - s.end_date) AS dias_vencida,
--            CASE
--              WHEN s.id IS NULL THEN 'CORTADO (sin suscripción)'
--              WHEN s.status = 'trial' AND s.end_date <  CURRENT_DATE THEN 'CORTADO (trial vencido)'
--              WHEN s.status = 'trial' THEN 'OK (trial en curso)'
--              WHEN s.status NOT IN ('active','past_due') THEN 'CORTADO (' || s.status || ')'
--              WHEN s.end_date >= CURRENT_DATE THEN 'OK (al día)'
--              WHEN s.end_date >= CURRENT_DATE - COALESCE(s.grace_days, 5) THEN 'EN GRACIA'
--              ELSE 'CORTADO (gracia vencida)'
--            END AS veredicto
--       FROM public.restaurants r
--       LEFT JOIN public.subscriptions s ON s.restaurant_id = r.id
--      ORDER BY veredicto, r.name;
--
--   Para darle aire a un local puntual sin tocar a nadie más:
--     UPDATE public.subscriptions SET grace_days = 30 WHERE restaurant_id = '<uuid>';
--   Para reactivar (lo que ya hace el botón "Renovar" del superadmin):
--     UPDATE public.subscriptions SET status='active', end_date='<fecha futura>'
--      WHERE restaurant_id = '<uuid>';
--
--   El superadmin NUNCA se corta (get_my_account_status lo excluye) y el panel
--   'admin' sigue abriendo siempre — para que el dueño pueda VER la pantalla de
--   "contactá a soporte" en vez de una redirección muda.
--
-- 100% ADITIVA en esquema (2 columnas nuevas + 1 CHECK ampliado + 1 trigger).
-- Idempotente / re-ejecutable. NO toca RLS ni políticas.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── A) `past_due` (mora) pasa a ser un estado válido ────────────────────────
--    Se dropea el CHECK por INTROSPECCIÓN (no por nombre): en prod puede tener
--    otro nombre por drift. Se identifica por su definición, que menciona
--    'cancelled' y aplica sobre subscriptions.status.
DO $$
DECLARE
  r RECORD;
BEGIN
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
END $$;

ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('active','trial','past_due','expired','cancelled','suspended'));

-- ── B) Knobs de gracia ──────────────────────────────────────────────────────
--    Default de la plataforma = 5 días, materializado como default del PLAN para
--    que sea editable sin migración. `subscriptions.grace_days` (NULL por defecto)
--    es el override por cliente.
ALTER TABLE public.subscription_plans
  ADD COLUMN IF NOT EXISTS grace_days INT NOT NULL DEFAULT 5;

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS grace_days INT;

COMMENT ON COLUMN public.subscription_plans.grace_days IS
  'Días de gracia después de end_date antes de cortar el servicio (default de la plataforma: 5).';
COMMENT ON COLUMN public.subscriptions.grace_days IS
  'Override de días de gracia para este cliente. NULL = usar el del plan.';

-- Helper de lectura: los días de gracia efectivos de un restaurante.
CREATE OR REPLACE FUNCTION public.billing_grace_days(p_restaurant_id uuid)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(s.grace_days, sp.grace_days, 5)
  FROM public.subscriptions s
  LEFT JOIN public.subscription_plans sp ON sp.id = s.plan_id
  WHERE s.restaurant_id = p_restaurant_id
  ORDER BY s.created_at DESC
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.billing_grace_days(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_grace_days(uuid) TO authenticated;

-- ── C) LA regla canónica, ahora con ventana de gracia ───────────────────────
--    Reemplaza la versión de la mig 160/163. Cambio único: active/past_due dejan
--    de ser incondicionales y exigen estar dentro de `end_date + gracia`.
--    El trial sigue con corte seco el día que vence (decisión de la 163: la prueba
--    gratuita no tiene gracia).
CREATE OR REPLACE FUNCTION public.resolve_entitled_plan_id(p_restaurant_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.plan_id
  FROM public.subscriptions s
  LEFT JOIN public.subscription_plans sp ON sp.id = s.plan_id
  WHERE s.restaurant_id = p_restaurant_id
    AND (
      -- Al día, o vencida pero dentro del período de gracia.
      ( s.status IN ('active','past_due')
        AND ( s.end_date IS NULL
              OR s.end_date >= CURRENT_DATE - COALESCE(s.grace_days, sp.grace_days, 5) ) )
      -- Prueba gratuita en curso (mig 163). Sin gracia: vence y corta.
      OR ( s.status = 'trial' AND s.end_date >= CURRENT_DATE )
    )
  ORDER BY s.created_at DESC
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.resolve_entitled_plan_id(uuid) FROM PUBLIC;

-- ── D) delivery-cliente (RPC anon) resuelve por el helper ───────────────────
--    Absorbe la parte A de la mig 176: el corte por facturación ahora incluye la
--    ventana de gracia, y la regla vive en UN solo lugar (el helper) en vez de
--    estar inlineada. Se preserva la rama service_mode y la de add-ons.
CREATE OR REPLACE FUNCTION public.restaurant_panel_enabled(p_restaurant_id uuid, p_panel text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_panels   jsonb;
  v_addon    boolean;
  v_mode     text;
  v_plan     uuid;
BEGIN
  IF p_restaurant_id IS NULL OR p_panel IS NULL OR p_panel = '' THEN
    RETURN false;
  END IF;

  -- Plan HABILITANTE (regla canónica: vigente o dentro de la gracia). NULL = corte.
  v_plan := public.resolve_entitled_plan_id(p_restaurant_id);

  -- Rama service_mode (mig 173): en modo delivery se desbloquea delivery-cliente
  -- sin depender del plan — pero sólo con suscripción habilitante.
  IF p_panel = 'delivery-cliente' THEN
    SELECT r.service_mode INTO v_mode
      FROM public.restaurants r WHERE r.id = p_restaurant_id;
    IF v_mode = 'delivery' AND v_plan IS NOT NULL THEN
      RETURN true;
    END IF;
  END IF;

  SELECT sp.allowed_panels INTO v_panels
    FROM public.subscription_plans sp
   WHERE sp.id = v_plan;

  IF v_panels IS NOT NULL AND (v_panels ? p_panel) THEN
    RETURN true;
  END IF;

  -- O habilitado vía add-on contratado y activo — pero un add-on NO resucita a un
  -- local cortado: sin plan habilitante no hay servicio.
  IF v_plan IS NULL THEN
    RETURN false;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.restaurant_addons ra
      JOIN public.plan_addons pa ON pa.key = ra.addon_key
     WHERE ra.restaurant_id = p_restaurant_id
       AND ra.enabled = true
       AND pa.panel = p_panel
  ) INTO v_addon;

  RETURN COALESCE(v_addon, false);   -- fail-closed por defecto
END;
$$;
GRANT EXECUTE ON FUNCTION public.restaurant_panel_enabled(uuid, text) TO anon, authenticated;

-- ── E) Capacidades públicas (anon) + flag `ordering` ────────────────────────
--    Definición COMPLETA (absorbe la mig 192, esté aplicada o no). `ordering` es
--    lo que el Menú QR / delivery consultan para mostrar la pantalla neutra
--    ANTES de que el comensal arme el carrito.
CREATE OR REPLACE FUNCTION public.get_public_capabilities(p_restaurant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_feats     jsonb;
  v_mode      text;
  v_plan      uuid;
  v_entitled  boolean;
  v_ovr       boolean;
  v_knows_g2  boolean;
  v_agenda    boolean;
BEGIN
  IF p_restaurant_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT r.service_mode INTO v_mode
    FROM public.restaurants r WHERE r.id = p_restaurant_id;

  IF NOT FOUND THEN
    RETURN NULL;                       -- restaurante inexistente: nada que informar
  END IF;

  -- Suscripción habilitante = regla canónica única (incluye la ventana de gracia).
  v_plan     := public.resolve_entitled_plan_id(p_restaurant_id);
  v_entitled := (v_plan IS NOT NULL);

  SELECT sp.allowed_features INTO v_feats
    FROM public.subscription_plans sp
   WHERE sp.id = v_plan;

  -- ¿El plan ya conoce la 2ª generación? (mig 191). Si no, fail-open.
  v_knows_g2 := COALESCE(v_feats, '[]'::jsonb) ?| array['admin:agenda','admin:personal'];

  -- Override explícito por restaurante (mig 146) — manda sobre el plan.
  SELECT o.enabled INTO v_ovr
    FROM public.restaurant_feature_overrides o
   WHERE o.restaurant_id = p_restaurant_id
     AND o.key = 'feature:admin:agenda';

  IF FOUND THEN
    v_agenda := v_ovr;
  ELSIF NOT v_knows_g2 THEN
    v_agenda := true;                              -- transición: plan pre-191
  ELSE
    v_agenda := COALESCE(v_feats, '[]'::jsonb) ? 'admin:agenda';
  END IF;

  RETURN jsonb_build_object(
    -- LISTA BLANCA. Nada de PII / precios / topes / nombre de plan / paneles.
    -- `ordering` NO explica por qué: para el comensal es sólo "no recibe pedidos".
    'ordering',     v_entitled,
    'reservations', (v_agenda AND v_entitled AND COALESCE(v_mode,'salon') <> 'delivery'),
    'service_mode', COALESCE(v_mode, 'salon')
  );
END;
$$;
REVOKE ALL     ON FUNCTION public.get_public_capabilities(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_public_capabilities(uuid) TO anon, authenticated;

-- ── F) DIENTES: ningún pedido nuevo con el servicio cortado ─────────────────
--    Trigger en `orders` (y no dentro de create_order) para cubrir TODOS los
--    caminos de alta: RPC del Menú QR, delivery, caja, mozo y cualquier API.
--    Sólo bloquea el ALTA: los pedidos ya existentes se pueden seguir cerrando.
CREATE OR REPLACE FUNCTION public.enforce_service_active_on_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.restaurant_id IS NULL THEN
    RETURN NEW;                                   -- sin tenant: no es asunto de este trigger
  END IF;

  -- Escotilla de operación: el superadmin nunca queda encerrado.
  IF public.get_my_role() = 'superadmin' THEN
    RETURN NEW;
  END IF;

  IF public.resolve_entitled_plan_id(NEW.restaurant_id) IS NULL THEN
    -- Mensaje NEUTRO: lo puede llegar a ver un comensal. El motivo real (falta de
    -- pago) sólo se le muestra al dueño, en el panel de Admin.
    RAISE EXCEPTION 'SERVICIO_NO_DISPONIBLE: este local no está recibiendo pedidos en este momento.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_service_active_on_order ON public.orders;
CREATE TRIGGER trg_enforce_service_active_on_order
  BEFORE INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_service_active_on_order();

-- ── G) get_my_account_status: gracia y corte, resueltos server-side ─────────
--    Verbatim de la mig 150 + los campos de facturación nuevos. Los paneles no
--    recalculan nada: leen `locked` / `in_grace` y pintan.
CREATE OR REPLACE FUNCTION public.get_my_account_status(p_restaurant_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_role       text;
  v_rid        uuid;
  v_name       text;
  v_status     text;
  v_is_active  boolean;
  v_maint      boolean;
  v_maint_msg  text;
  v_sub_status text;
  v_sub_end    date;
  v_days       int;
  v_grace      int;
  v_overdue    int;
  v_entitled   boolean;
  v_expired    boolean;
BEGIN
  -- anon / sin sesión → sin estado (el guard interpreta NULL como "no bloquear").
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  v_role := public.get_my_role();

  -- Superadmin: nunca se bloquea ni recibe avisos (no tiene restaurante propio).
  IF v_role = 'superadmin' THEN
    RETURN jsonb_build_object(
      'role', 'superadmin', 'restaurant_id', NULL,
      'maintenance_mode', false, 'suspended', false, 'expired', false, 'locked', false
    );
  END IF;

  SELECT restaurant_id INTO v_rid
    FROM public.user_roles
   WHERE user_id = v_uid AND is_active = true AND restaurant_id IS NOT NULL
   ORDER BY created_at ASC
   LIMIT 1;

  IF p_restaurant_id IS NOT NULL
     AND p_restaurant_id IN (SELECT public.get_my_company_restaurant_ids()) THEN
    v_rid := p_restaurant_id;
  END IF;

  -- Usuario sin restaurante (p. ej. proveedor del marketplace) → no-bloqueante.
  IF v_rid IS NULL THEN
    RETURN jsonb_build_object(
      'role', COALESCE(v_role, 'unknown'), 'restaurant_id', NULL,
      'maintenance_mode', false, 'suspended', false, 'expired', false, 'locked', false
    );
  END IF;

  SELECT name, status, COALESCE(is_active, true),
         COALESCE(maintenance_mode, false), maintenance_message
    INTO v_name, v_status, v_is_active, v_maint, v_maint_msg
    FROM public.restaurants
   WHERE id = v_rid;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'role', v_role, 'restaurant_id', v_rid,
      'maintenance_mode', false, 'suspended', false, 'expired', false, 'locked', false
    );
  END IF;

  SELECT status, end_date
    INTO v_sub_status, v_sub_end
    FROM public.subscriptions
   WHERE restaurant_id = v_rid
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_sub_end IS NOT NULL THEN
    v_days    := (v_sub_end - CURRENT_DATE);
    v_overdue := GREATEST(0, CURRENT_DATE - v_sub_end);
  END IF;

  v_grace    := COALESCE(public.billing_grace_days(v_rid), 5);
  -- `locked` usa EXACTAMENTE la misma regla que el enforcement (el helper), así la
  -- pantalla que ve el usuario nunca miente respecto de lo que la base permite.
  v_entitled := (public.resolve_entitled_plan_id(v_rid) IS NOT NULL);
  -- Set de estados idéntico al de la mig 150 (no se suma 'cancelled' a propósito:
  -- una baja con end_date futura es "pagado hasta fin de período" y no se avisa;
  -- si además dejó de habilitar, el bloqueo lo cubre `locked`).
  v_expired  := (v_sub_status IN ('expired','past_due','suspended')
                 OR (v_sub_end IS NOT NULL AND v_sub_end < CURRENT_DATE));

  RETURN jsonb_build_object(
    'role',                  v_role,
    'restaurant_id',         v_rid,
    'restaurant_name',       v_name,
    'restaurant_status',     v_status,
    'is_active',             v_is_active,
    'maintenance_mode',      v_maint,
    'maintenance_message',   v_maint_msg,
    'subscription_status',   v_sub_status,
    'subscription_end_date', v_sub_end,
    'days_left',             v_days,
    -- Flags derivados (el cliente no recalcula, solo pinta):
    --  • suspended = bloqueo duro manual del superadmin sobre el RESTAURANTE.
    --  • expired   = la mensualidad venció (por fecha o por estado de cobranza).
    --  • in_grace  = venció PERO el servicio sigue vivo (dentro de la gracia).
    --  • locked    = CORTE: no hay suscripción habilitante. Sin servicio.
    'suspended',    (v_status IN ('suspended', 'inactive') OR v_is_active = false),
    'expired',      v_expired,
    'entitled',     v_entitled,
    'locked',       (NOT v_entitled),
    'grace_days',   CASE WHEN v_sub_status = 'trial' THEN 0 ELSE v_grace END,
    'days_overdue', COALESCE(v_overdue, 0),
    -- Último día con servicio. La prueba gratuita NO tiene gracia (mig 163): corta
    -- el mismo día que vence, así que su fecha de corte es su propio end_date.
    'grace_ends_on', CASE WHEN v_sub_end IS NULL THEN NULL
                          WHEN v_sub_status = 'trial' THEN v_sub_end
                          ELSE v_sub_end + v_grace END,
    'in_grace',     (v_expired AND v_entitled)
  );
END;
$$;

REVOKE ALL     ON FUNCTION public.get_my_account_status(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_my_account_status(uuid) TO authenticated;

COMMIT;

-- Recargar el cache de esquema de PostgREST (funciones/columnas nuevas).
NOTIFY pgrst, 'reload schema';

-- ── Verificación (correr aparte, como postgres) ─────────────────────────────
-- (a) Veredicto por local (el mismo dry-run de la cabecera, ya con el helper vivo):
--   SELECT r.name, s.status, s.end_date,
--          public.billing_grace_days(r.id) AS gracia,
--          (public.resolve_entitled_plan_id(r.id) IS NOT NULL) AS con_servicio
--     FROM public.restaurants r
--     LEFT JOIN public.subscriptions s ON s.restaurant_id = r.id
--    ORDER BY con_servicio, r.name;
-- (b) La regla viva ya mira la fecha:
--   SELECT position('grace_days' in pg_get_functiondef(oid)) > 0 AS con_gracia
--     FROM pg_proc WHERE proname='resolve_entitled_plan_id' AND pronamespace='public'::regnamespace;
-- (c) El trigger de pedidos está cableado:
--   SELECT tgname, tgenabled FROM pg_trigger WHERE tgname='trg_enforce_service_active_on_order';
-- (d) Un local cortado ya no puede recibir pedidos (debe fallar con SERVICIO_NO_DISPONIBLE):
--   INSERT INTO public.orders (restaurant_id, order_number, order_type, status, total)
--   VALUES ('<uuid-cortado>', 'TEST-1', 'local', 'draft', 1000);
SELECT 'migration 193 applied — grace period (5d default) + service lock' AS status;
