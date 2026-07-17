-- ════════════════════════════════════════════════════════════════════
-- 177 · supplier_plans — Monetización del marketplace de proveedores (PR-SP0)
-- ────────────────────────────────────────────────────────────────────
-- Espeja el patrón de planes de restaurante (subscription_plans / subscriptions
-- / marketing_plans) para los PROVEEDORES del marketplace B2B. NO toca la RLS de
-- restaurantes ni migra paneles. Fundaciones DB del sprint de planes de proveedor.
--
-- Contenido:
--   1. Tabla public.marketplace_supplier_plans (catálogo de planes de proveedor)
--      + trigger sync_supplier_plan_is_active (is_active = status='active').
--   2. Seed de 3 tiers: basico / profesional / premium (precios en ₲ enteros).
--   3. Tabla public.marketplace_supplier_subscriptions (1 sub por proveedor).
--   4. Migración del CHECK de marketplace_suppliers.plan
--         ('fundador','basico','pro') → ('basico','profesional','premium')
--      con remapeo de los valores de QA (fundador→basico, basico→profesional,
--      pro→premium) y default nuevo 'basico'. GATED por la presencia del CHECK
--      viejo → re-ejecutable sin doble-migrar (ver nota de idempotencia abajo).
--   5. RLS fail-closed (patrón migs 142/144): anon CERO acceso; superadmin ALL;
--      supplier SELECT de su propia sub; authenticated SELECT del catálogo de planes.
--   6. RPC superadmin_set_supplier_plan(p_supplier_id, p_plan, p_trial_days)
--      — DEFINER fail-closed (modelo superadmin_set_supplier_estado, mig 144).
--   7. RPC get_supplier_capabilities() — DEFINER, resuelve el proveedor con
--      get_my_supplier_id(); límites efectivos si la sub está en ('trial','active'),
--      fail-closed a límites mínimos (todo 0 / lead_contact 'oculto') si no.
--
-- ⚠️ IDEMPOTENCIA DEL REMAPEO (punto 4): un CASE ciego NO es re-ejecutable porque
--    'basico' vive en el set viejo Y en el nuevo (fundador→basico crea un 'basico'
--    que, en una 2ª corrida, se re-mapearía a 'profesional'). Por eso el bloque de
--    remapeo se ejecuta SOLO si el CHECK viejo (que menciona 'fundador') sigue
--    presente; una vez migrado, se saltea. Todo va en 1 transacción (BEGIN/COMMIT):
--    un fallo a mitad revierte entero, así que no puede quedar estado parcial.
--
-- ⚠️ NO backfillea suscripciones para los proveedores de QA existentes (fuera de
--    alcance). Hasta que el superadmin les asigne plan (RPC) o entren por el
--    onboarding (approve-supplier.js, 2º prompt de PR-SP0), get_supplier_capabilities
--    devuelve límites mínimos para ellos (fail-closed correcto).
--
-- GUARD marketplace_suppliers_guard (mig 142, SIN cambios): trata 'plan' como campo
--    administrado, pero su 1ª rama es `current_user IN ('postgres','supabase_admin',
--    'service_role') OR get_my_role()='superadmin' → RETURN NEW`. La RPC del punto 6
--    es DEFINER (owner postgres) → current_user='postgres' → pasa el guard, igual que
--    superadmin_set_supplier_estado ya actualiza 'estado'.
--
-- PREPARED — NOT APPLIED: aplicar A MANO en el SQL Editor (idioma en INGLÉS) tras
--    backup, DESPUÉS de la 142/143/144/167. Idempotente (re-ejecutable).
-- Revertir:
--   DROP FUNCTION public.get_supplier_capabilities();
--   DROP FUNCTION public.superadmin_set_supplier_plan(uuid, text, int);
--   DROP TABLE public.marketplace_supplier_subscriptions;
--   DROP TRIGGER trg_sync_supplier_plan_is_active ON public.marketplace_supplier_plans;
--   DROP FUNCTION public.sync_supplier_plan_is_active();
--   DROP TABLE public.marketplace_supplier_plans;
--   -- y (manual) revertir marketplace_suppliers.plan al CHECK viejo + remapeo inverso
--   --   premium→pro, profesional→basico, basico→fundador (ambiguo: hacer a mano).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. Catálogo de planes de proveedor ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.marketplace_supplier_plans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,
  price_gs      bigint NOT NULL DEFAULT 0,
  billing_cycle text NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly','annual','free')),
  trial_days    int NOT NULL DEFAULT 30,
  limits        jsonb NOT NULL DEFAULT '{}'::jsonb,
  features      jsonb NOT NULL DEFAULT '[]'::jsonb,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  is_active     boolean NOT NULL DEFAULT true,
  sort_order    int NOT NULL DEFAULT 0,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

-- is_active espeja el ciclo de vida (única fuente de verdad = status).
CREATE OR REPLACE FUNCTION public.sync_supplier_plan_is_active()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.is_active := (NEW.status = 'active');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_supplier_plan_is_active ON public.marketplace_supplier_plans;
CREATE TRIGGER trg_sync_supplier_plan_is_active
  BEFORE INSERT OR UPDATE ON public.marketplace_supplier_plans
  FOR EACH ROW EXECUTE FUNCTION public.sync_supplier_plan_is_active();

-- updated_at automático (helper set_updated_at, mig 001).
DROP TRIGGER IF EXISTS trg_mkp_supplier_plans_updated_at ON public.marketplace_supplier_plans;
CREATE TRIGGER trg_mkp_supplier_plans_updated_at
  BEFORE UPDATE ON public.marketplace_supplier_plans
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 2. Seed de los 3 tiers (₲ enteros; -1 = ilimitado) ─────────────
-- ON CONFLICT DO NOTHING: siembra 1 vez y NUNCA pisa ediciones vivas del panel
-- (SP2) en una re-corrida. is_active lo setea el trigger según status='active'.
INSERT INTO public.marketplace_supplier_plans
  (slug, name, price_gs, billing_cycle, trial_days, sort_order, limits, features)
VALUES
  ('basico', 'Básico', 99000, 'monthly', 30, 1,
   '{"max_products":10,"max_users":1,"max_catalog_files":0,"max_categorias":1,"max_zonas":1,"featured_slots":0,"lead_contact":"demorado","lead_priority":false,"analytics":"none","branding_banner":false}'::jsonb,
   '["Perfil de proveedor en el marketplace","Hasta 10 productos","1 usuario","1 categoría y 1 zona de cobertura","Contacto de leads con demora (24 h)"]'::jsonb),

  ('profesional', 'Profesional', 199000, 'monthly', 30, 2,
   '{"max_products":50,"max_users":3,"max_catalog_files":3,"max_categorias":3,"max_zonas":3,"featured_slots":1,"lead_contact":"inmediato","lead_priority":false,"analytics":"basico","branding_banner":false}'::jsonb,
   '["Hasta 50 productos","Hasta 3 usuarios","3 categorías y 3 zonas de cobertura","Contacto de leads inmediato","1 espacio destacado","Analítica básica","Hasta 3 catálogos PDF"]'::jsonb),

  ('premium', 'Premium', 349000, 'monthly', 30, 3,
   '{"max_products":-1,"max_users":-1,"max_catalog_files":-1,"max_categorias":-1,"max_zonas":-1,"featured_slots":-1,"lead_contact":"inmediato","lead_priority":true,"analytics":"completo","branding_banner":true}'::jsonb,
   '["Productos ilimitados","Usuarios ilimitados","Categorías y zonas ilimitadas","Contacto de leads inmediato y prioritario","Destacados ilimitados","Analítica completa","Banner de marca personalizado","Catálogos PDF ilimitados"]'::jsonb)
ON CONFLICT (slug) DO NOTHING;

-- ─── 3. Suscripción del proveedor (1 fila por proveedor) ────────────
CREATE TABLE IF NOT EXISTS public.marketplace_supplier_subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id        uuid NOT NULL UNIQUE REFERENCES public.marketplace_suppliers(id) ON DELETE CASCADE,
  plan_slug          text NOT NULL REFERENCES public.marketplace_supplier_plans(slug),
  status             text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial','active','past_due','cancelled','suspended')),
  trial_ends_at      timestamptz,
  current_period_end timestamptz,
  monthly_amount     bigint,
  auto_renew         boolean DEFAULT true,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mkp_supplier_subs_plan
  ON public.marketplace_supplier_subscriptions (plan_slug);

DROP TRIGGER IF EXISTS trg_mkp_supplier_subs_updated_at ON public.marketplace_supplier_subscriptions;
CREATE TRIGGER trg_mkp_supplier_subs_updated_at
  BEFORE UPDATE ON public.marketplace_supplier_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 4. Migrar el CHECK/valores de marketplace_suppliers.plan ───────
-- Gated: corre SOLO si el CHECK viejo (menciona 'fundador') sigue vivo. Ver la
-- nota de idempotencia del encabezado. Drop del default primero para no chocar
-- con el CHECK durante el intercambio; el remapeo es set-based (usa el valor
-- ORIGINAL de cada fila, sin cascada entre ramas del CASE).
DO $$
DECLARE
  v_conname text;
BEGIN
  SELECT c.conname INTO v_conname
    FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'marketplace_suppliers'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%fundador%'
   LIMIT 1;

  IF v_conname IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.marketplace_suppliers ALTER COLUMN plan DROP DEFAULT';
    EXECUTE format('ALTER TABLE public.marketplace_suppliers DROP CONSTRAINT %I', v_conname);

    UPDATE public.marketplace_suppliers
       SET plan = CASE plan
                    WHEN 'fundador' THEN 'basico'
                    WHEN 'basico'   THEN 'profesional'
                    WHEN 'pro'      THEN 'premium'
                    ELSE 'basico'          -- inalcanzable (el CHECK viejo garantizaba los 3)
                  END;

    ALTER TABLE public.marketplace_suppliers ALTER COLUMN plan SET DEFAULT 'basico';
    ALTER TABLE public.marketplace_suppliers
      ADD CONSTRAINT marketplace_suppliers_plan_check
      CHECK (plan IN ('basico','profesional','premium'));
  END IF;
END $$;

-- ─── 5. RLS ─────────────────────────────────────────────────────────
ALTER TABLE public.marketplace_supplier_plans         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_supplier_subscriptions ENABLE ROW LEVEL SECURITY;

-- anon: CERO acceso a ambas (el precio público vive en marketing_supplier_plans, PR-SP3).
REVOKE ALL ON public.marketplace_supplier_plans         FROM anon;
REVOKE ALL ON public.marketplace_supplier_subscriptions FROM anon;

-- El privilegio de tabla se chequea ANTES que la RLS: authenticated necesita los
-- privilegios para que el superadmin pueda escribir (la RLS lo restringe a él).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketplace_supplier_plans         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketplace_supplier_subscriptions TO authenticated;

-- 5.1 Planes: catálogo legible por cualquier authenticated (gating/UI); escritura solo superadmin.
DROP POLICY IF EXISTS "mkp_supplier_plans_authenticated_select" ON public.marketplace_supplier_plans;
CREATE POLICY "mkp_supplier_plans_authenticated_select" ON public.marketplace_supplier_plans
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "mkp_supplier_plans_superadmin_all" ON public.marketplace_supplier_plans;
CREATE POLICY "mkp_supplier_plans_superadmin_all" ON public.marketplace_supplier_plans
  FOR ALL TO authenticated
  USING      (COALESCE(public.get_my_role() = 'superadmin', false))
  WITH CHECK (COALESCE(public.get_my_role() = 'superadmin', false));

-- 5.2 Suscripciones: el proveedor ve SU fila; el superadmin gestiona todo. La
--     escritura autoritativa pasa por la RPC (punto 6) / onboarding (DEFINER).
DROP POLICY IF EXISTS "mkp_supplier_subs_supplier_select" ON public.marketplace_supplier_subscriptions;
CREATE POLICY "mkp_supplier_subs_supplier_select" ON public.marketplace_supplier_subscriptions
  FOR SELECT TO authenticated
  USING (supplier_id = public.get_my_supplier_id());

DROP POLICY IF EXISTS "mkp_supplier_subs_superadmin_all" ON public.marketplace_supplier_subscriptions;
CREATE POLICY "mkp_supplier_subs_superadmin_all" ON public.marketplace_supplier_subscriptions
  FOR ALL TO authenticated
  USING      (COALESCE(public.get_my_role() = 'superadmin', false))
  WITH CHECK (COALESCE(public.get_my_role() = 'superadmin', false));

-- ─── 6. RPC superadmin_set_supplier_plan ────────────────────────────
-- Fail-closed superadmin (patrón mig 144). Upsert de la sub + reflejo en
-- marketplace_suppliers.plan + auditoría, ATÓMICO. DEFINER (owner postgres):
-- pasa el guard de suppliers e inserta en marketplace_events (append-only).
CREATE OR REPLACE FUNCTION public.superadmin_set_supplier_plan(
  p_supplier_id uuid,
  p_plan        text,
  p_trial_days  int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_plan       record;   -- plan destino
  v_sub        record;   -- suscripción existente (si hay)
  v_old_plan   text;
  v_new_status text;
  v_trial_ends timestamptz;
  v_days       int;
BEGIN
  -- Fail-closed: solo superadmin (COALESCE por si get_my_role() es NULL/anon).
  IF NOT COALESCE(public.get_my_role() = 'superadmin', false) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_supplier_id IS NULL OR p_plan IS NULL THEN
    RAISE EXCEPTION 'proveedor y plan requeridos' USING ERRCODE = '22023';
  END IF;

  SELECT slug, price_gs, trial_days INTO v_plan
    FROM public.marketplace_supplier_plans
   WHERE slug = p_plan;
  IF v_plan.slug IS NULL THEN
    RAISE EXCEPTION 'plan inexistente: %', p_plan USING ERRCODE = '22023';
  END IF;

  SELECT plan INTO v_old_plan
    FROM public.marketplace_suppliers
   WHERE id = p_supplier_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'proveedor inexistente' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_sub
    FROM public.marketplace_supplier_subscriptions
   WHERE supplier_id = p_supplier_id;

  IF v_sub.id IS NULL OR p_trial_days IS NOT NULL THEN
    -- Sin sub previa, o seteo/extensión explícito del trial → (re)abrir trial.
    v_days       := COALESCE(p_trial_days, v_plan.trial_days);
    v_new_status := 'trial';
    v_trial_ends := now() + make_interval(days => v_days);
  ELSE
    -- Sub ya existente y sin trial explícito → cambia de plan sin tocar el ciclo
    -- de vida (p.ej. una sub 'active' conserva su status y trial_ends_at).
    v_new_status := v_sub.status;
    v_trial_ends := v_sub.trial_ends_at;
  END IF;

  IF v_sub.id IS NULL THEN
    INSERT INTO public.marketplace_supplier_subscriptions
      (supplier_id, plan_slug, status, trial_ends_at, monthly_amount)
    VALUES
      (p_supplier_id, v_plan.slug, v_new_status, v_trial_ends, v_plan.price_gs);
  ELSE
    UPDATE public.marketplace_supplier_subscriptions
       SET plan_slug      = v_plan.slug,
           status         = v_new_status,
           trial_ends_at  = v_trial_ends,
           monthly_amount = v_plan.price_gs,
           updated_at     = now()
     WHERE supplier_id = p_supplier_id;
  END IF;

  -- Reflejo denormalizado en el proveedor (pasa el guard: DEFINER owner=postgres).
  UPDATE public.marketplace_suppliers
     SET plan = v_plan.slug
   WHERE id = p_supplier_id;

  -- Auditoría (marketplace_events append-only; el INSERT solo desde DEFINER).
  INSERT INTO public.marketplace_events (event_type, supplier_id, actor_user, metadata)
  VALUES ('supplier_plan_changed', p_supplier_id, auth.uid(),
          jsonb_build_object(
            'from',           v_old_plan,
            'to',             v_plan.slug,
            'status',         v_new_status,
            'trial_ends_at',  v_trial_ends,
            'monthly_amount', v_plan.price_gs
          ));

  RETURN jsonb_build_object(
    'ok',             true,
    'supplier_id',    p_supplier_id,
    'plan',           v_plan.slug,
    'status',         v_new_status,
    'trial_ends_at',  v_trial_ends,
    'monthly_amount', v_plan.price_gs
  );
END;
$$;

REVOKE ALL    ON FUNCTION public.superadmin_set_supplier_plan(uuid, text, int) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.superadmin_set_supplier_plan(uuid, text, int) TO authenticated;

-- ─── 7. RPC get_supplier_capabilities ───────────────────────────────
-- Límites efectivos del proveedor logueado. DEFINER: lee planes/sub sin depender
-- de la RLS del invocador. Fail-closed: sin proveedor o sin sub habilitante
-- (status IN ('trial','active')) → límites mínimos (todo 0 / lead_contact 'oculto').
CREATE OR REPLACE FUNCTION public.get_supplier_capabilities()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_supplier uuid;
  v_limits   jsonb;
  v_slug     text;
  v_status   text;
  v_trial    timestamptz;
  -- Piso fail-closed: sin acceso a nada hasta tener una sub válida.
  v_floor    jsonb := jsonb_build_object(
    'max_products', 0, 'max_users', 0, 'max_catalog_files', 0,
    'max_categorias', 0, 'max_zonas', 0, 'featured_slots', 0,
    'lead_contact', 'oculto', 'lead_priority', false,
    'analytics', 'none', 'branding_banner', false
  );
BEGIN
  v_supplier := public.get_my_supplier_id();
  IF v_supplier IS NULL THEN
    RETURN v_floor || jsonb_build_object(
      'plan_slug', NULL, 'status', NULL, 'entitled', false, 'trial_ends_at', NULL);
  END IF;

  SELECT p.limits, p.slug, s.status, s.trial_ends_at
    INTO v_limits, v_slug, v_status, v_trial
    FROM public.marketplace_supplier_subscriptions s
    JOIN public.marketplace_supplier_plans p ON p.slug = s.plan_slug
   WHERE s.supplier_id = v_supplier
     AND s.status IN ('trial','active')
   LIMIT 1;

  IF v_limits IS NULL THEN
    -- Hay proveedor pero no hay sub habilitante → piso fail-closed.
    RETURN v_floor || jsonb_build_object(
      'plan_slug', NULL, 'status', NULL, 'entitled', false, 'trial_ends_at', NULL);
  END IF;

  RETURN v_limits || jsonb_build_object(
    'plan_slug',     v_slug,
    'status',        v_status,
    'entitled',      true,
    'trial_ends_at', v_trial
  );
END;
$$;

REVOKE ALL    ON FUNCTION public.get_supplier_capabilities() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_supplier_capabilities() TO authenticated;

COMMIT;

-- Recargar el cache de esquema de PostgREST (tablas, policies y funciones nuevas).
NOTIFY pgrst, 'reload schema';

SELECT 'migracion 177 aplicada (supplier_plans: catálogo + suscripciones + set_supplier_plan + get_supplier_capabilities + remapeo plan)' AS status;
