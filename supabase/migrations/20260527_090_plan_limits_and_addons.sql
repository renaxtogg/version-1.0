-- ═══════════════════════════════════════════════════════════
-- MIGRACIÓN 090 — PLANES: hard-limits, paneles permitidos y add-ons modulares
-- EJECUTAR EN SUPABASE SQL EDITOR (dashboard en INGLÉS)
--
-- Gobierna la lógica SaaS multi-comercio:
--   · Límite estricto de usuarios por rol y por plan
--   · allowed_panels: qué paneles incluye cada plan
--   · plan_addons: catálogo global de paneles vendibles como extra
--   · restaurant_addons: add-ons contratados por cada restaurante
--   · get_restaurant_capabilities(): paneles efectivos = plan ∪ add-ons
--   · trigger backstop: no permite crear usuarios por encima del límite
-- ═══════════════════════════════════════════════════════════

-- ─── 1. subscription_plans: límites por rol + paneles permitidos ───
ALTER TABLE public.subscription_plans
  ADD COLUMN IF NOT EXISTS max_users_by_role JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS allowed_panels    JSONB DEFAULT '[]'::jsonb;

-- ─── 2. restaurants: marca de aprovisionamiento demo automático ───
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS auto_provisioned BOOLEAN DEFAULT false;

-- ─── 3. plan_addons: catálogo global de add-ons vendibles ──────────
CREATE TABLE IF NOT EXISTS public.plan_addons (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key        TEXT UNIQUE NOT NULL,        -- 'delivery_cliente','delivery_rider','kds_cocina'
  name       TEXT NOT NULL,
  panel      TEXT NOT NULL,               -- panel que desbloquea (mismo string que allowed_panels)
  price_usd  NUMERIC(10,2) NOT NULL DEFAULT 0,
  is_active  BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 4. restaurant_addons: add-ons contratados por restaurante ─────
CREATE TABLE IF NOT EXISTS public.restaurant_addons (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  addon_key     TEXT NOT NULL,
  price_usd     NUMERIC(10,2) NOT NULL DEFAULT 0,   -- precio acordado (puede diferir del de lista)
  enabled       BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(restaurant_id, addon_key)
);

CREATE INDEX IF NOT EXISTS idx_restaurant_addons_rest ON public.restaurant_addons(restaurant_id) WHERE enabled = true;

-- ─── 5. RLS (patrón actual USING(true) — endurecer en tarea de RLS) ─
ALTER TABLE public.plan_addons       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_addons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sa_plan_addons_all"       ON public.plan_addons;
DROP POLICY IF EXISTS "sa_restaurant_addons_all" ON public.restaurant_addons;
CREATE POLICY "sa_plan_addons_all"       ON public.plan_addons       FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "sa_restaurant_addons_all" ON public.restaurant_addons FOR ALL USING (true) WITH CHECK (true);

-- ─── 6. Seed: catálogo de add-ons ──────────────────────────────────
INSERT INTO public.plan_addons (key, name, panel, price_usd) VALUES
  ('delivery_cliente', 'Delivery Cliente', 'delivery-cliente', 15.00),
  ('delivery_rider',   'Rider Delivery',   'delivery-rider',   10.00),
  ('kds_cocina',       'KDS Cocina',        'cocina',           12.00)
ON CONFLICT (key) DO NOTHING;

-- ─── 7. Seed: límites y paneles de los planes existentes ───────────
UPDATE public.subscription_plans SET
  allowed_panels    = '["caja","mozo","cocina"]'::jsonb,
  max_users_by_role = '{"mozo":2,"cajero":1,"cocina":1}'::jsonb
WHERE id = '10000000-0000-0000-0000-000000000001';   -- Starter

UPDATE public.subscription_plans SET
  allowed_panels    = '["caja","mozo","cocina","delivery-cliente"]'::jsonb,
  max_users_by_role = '{"mozo":5,"cajero":2,"cocina":3}'::jsonb
WHERE id = '10000000-0000-0000-0000-000000000002';   -- Pro

UPDATE public.subscription_plans SET
  allowed_panels    = '["caja","mozo","cocina","delivery-cliente","delivery-rider","gerente"]'::jsonb,
  max_users_by_role = '{}'::jsonb   -- {} = sin límite
WHERE id = '10000000-0000-0000-0000-000000000003';   -- Enterprise

-- ─── 8. RPC: capacidades efectivas (plan ∪ add-ons) ────────────────
-- Devuelve allowed_panels (unión de plan + add-ons contratados),
-- la lista de add-ons activos, y los hard-limits del plan.
CREATE OR REPLACE FUNCTION public.get_restaurant_capabilities(p_restaurant_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan         RECORD;
  v_panels       JSONB;
  v_addon_panels JSONB;
  v_addons       JSONB;
BEGIN
  SELECT sp.allowed_panels, sp.max_users_by_role, sp.max_tables, sp.max_menu_items
    INTO v_plan
    FROM public.subscriptions s
    JOIN public.subscription_plans sp ON sp.id = s.plan_id
   WHERE s.restaurant_id = p_restaurant_id
   ORDER BY s.created_at DESC
   LIMIT 1;

  v_panels := COALESCE(v_plan.allowed_panels, '[]'::jsonb);

  SELECT COALESCE(jsonb_agg(pa.panel), '[]'::jsonb)
    INTO v_addon_panels
    FROM public.restaurant_addons ra
    JOIN public.plan_addons pa ON pa.key = ra.addon_key
   WHERE ra.restaurant_id = p_restaurant_id AND ra.enabled = true;

  SELECT COALESCE(jsonb_agg(ra.addon_key), '[]'::jsonb)
    INTO v_addons
    FROM public.restaurant_addons ra
   WHERE ra.restaurant_id = p_restaurant_id AND ra.enabled = true;

  RETURN jsonb_build_object(
    'allowed_panels', (
      SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb)
      FROM (
        SELECT jsonb_array_elements_text(v_panels)       AS p
        UNION
        SELECT jsonb_array_elements_text(v_addon_panels) AS p
      ) u
    ),
    'addons',            v_addons,
    'max_users_by_role', COALESCE(v_plan.max_users_by_role, '{}'::jsonb),
    'max_tables',        v_plan.max_tables,
    'max_menu_items',    v_plan.max_menu_items
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_restaurant_capabilities(UUID) TO authenticated, anon;

-- ─── 9. Trigger backstop: límite de usuarios por rol/plan ──────────
-- Respaldo server-side: aunque la UI o /api/create-user fallen, la DB
-- rechaza el INSERT que exceda el límite del plan. Permisivo cuando
-- no hay límite numérico configurado (rol ausente del JSON = ilimitado).
CREATE OR REPLACE FUNCTION public.enforce_role_user_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit INT;
  v_count INT;
BEGIN
  IF NEW.restaurant_id IS NULL
     OR NEW.role NOT IN ('mozo','cajero','cocina','rider')
     OR COALESCE(NEW.is_active, true) = false THEN
    RETURN NEW;
  END IF;

  SELECT (sp.max_users_by_role ->> NEW.role)::INT
    INTO v_limit
    FROM public.subscriptions s
    JOIN public.subscription_plans sp ON sp.id = s.plan_id
   WHERE s.restaurant_id = NEW.restaurant_id
   ORDER BY s.created_at DESC
   LIMIT 1;

  IF v_limit IS NULL THEN
    RETURN NEW;   -- plan sin límite para este rol → ilimitado
  END IF;

  SELECT COUNT(*) INTO v_count
    FROM public.user_roles
   WHERE restaurant_id = NEW.restaurant_id
     AND role = NEW.role
     AND is_active = true;

  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'Límite de % alcanzado para el plan actual (máx %)', NEW.role, v_limit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_role_user_limit ON public.user_roles;
CREATE TRIGGER trg_enforce_role_user_limit
  BEFORE INSERT ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_role_user_limit();
