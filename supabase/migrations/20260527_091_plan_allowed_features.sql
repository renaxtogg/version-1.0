-- ═══════════════════════════════════════════════════════════
-- MIGRACIÓN 091 — MODULARIDAD ABSOLUTA: características granulares por plan
-- EJECUTAR EN SUPABASE SQL EDITOR (dashboard en INGLÉS)
--
-- Extiende la lógica SaaS de la 090 con "Omni-Gating por Feature":
-- sub-módulos vendibles DENTRO de un panel (no sólo el panel completo).
--
--   · subscription_plans.allowed_features: array de keys "panel:feature"
--   · get_restaurant_capabilities() ahora también devuelve allowed_features
--   · Convención de keys (mismas strings que usa el frontend):
--       admin:delivery_zones  — Gestión de Mapas / Zonas Delivery
--       admin:inventory       — Control de Insumos / Stock
--       admin:crm             — CRM de Clientes
--       caja:sifen            — Facturación Electrónica SIFEN
--       caja:digital_payments — Pasarelas Digitales Bancard
--       mozo:digital_qr_pay   — Cobro de Mesa con QR Digital
--
-- Semántica de gating (frontend, fail-open):
--   allowed_features = NULL          → plan legacy/no configurado → TODO permitido
--   allowed_features = ['k1','k2']   → sólo esas features habilitadas
--   allowed_features = []            → ninguna feature premium habilitada
-- ═══════════════════════════════════════════════════════════

-- ─── 1. Columna de features granulares (NULL = legacy, no gatea) ───
ALTER TABLE public.subscription_plans
  ADD COLUMN IF NOT EXISTS allowed_features JSONB;

-- ─── 2. Seed no disruptivo: planes existentes conservan todo ───────
-- Se otorgan todas las features a los planes ya creados para no romper
-- la operación en vivo. El superadmin tiera/recorta desde la UI nueva.
UPDATE public.subscription_plans
   SET allowed_features = '["admin:delivery_zones","admin:inventory","admin:crm","caja:sifen","caja:digital_payments","mozo:digital_qr_pay"]'::jsonb
 WHERE allowed_features IS NULL;

-- ─── 3. RPC capacidades: añade allowed_features (nivel plan) ────────
-- Mantiene el contrato de la 090 (allowed_panels ∪ add-ons, add-ons,
-- max_users_by_role, max_tables, max_menu_items) y suma allowed_features.
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
  SELECT sp.allowed_panels, sp.allowed_features, sp.max_users_by_role, sp.max_tables, sp.max_menu_items
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
    'allowed_features',  v_plan.allowed_features,   -- NULL si plan legacy → frontend no gatea
    'addons',            v_addons,
    'max_users_by_role', COALESCE(v_plan.max_users_by_role, '{}'::jsonb),
    'max_tables',        v_plan.max_tables,
    'max_menu_items',    v_plan.max_menu_items
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_restaurant_capabilities(UUID) TO authenticated, anon;
