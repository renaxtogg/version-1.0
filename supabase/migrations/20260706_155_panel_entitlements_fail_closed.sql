-- ════════════════════════════════════════════════════════════════════
-- 155 · ENFORCEMENT DE PANELES: FAIL-CLOSED (lista vacía = 0 paneles POS)
-- ────────────────────────────────────────────────────────────────────
-- BUG (prod): get_restaurant_capabilities e is_panel_enabled (mig 146) trataban
-- "plan sin paneles" (allowed_panels vacío/null y sin add-ons) como FAIL-OPEN →
-- concedían TODOS los paneles. El plan "Emprendedor" (allowed_panels = []) es un
-- plan REAL de 0 paneles POS, así que sus restaurantes recibían Caja, Mozo,
-- Cocina, Delivery Cliente, Rider y Gerente en ON (fuente "Plan"). Confirmado en
-- Superadmin → Restaurantes → Módulos.
--
-- FIX: la base de paneles pasa a ser SIEMPRE  plan ∪ add-ons ∪ 'admin'  (FAIL-
-- CLOSED). Una lista vacía/null concede SOLO 'admin' (el dueño) + el Menú Cliente
-- (QR), que NO es un panel gateado. Caja/Mozo/Cocina/Delivery/Rider/Gerente → OFF
-- salvo que el plan los liste, un add-on los aporte, o haya un override explícito.
-- Planes con lista NO vacía (Consolidado, Premium) quedan EXACTAMENTE igual.
--
-- ALCANCE: solo cambia el fallback de lista-vacía en las DOS funciones. Se
-- conserva todo lo demás de la mig 146 (guard tenant-safe, overrides, features,
-- add-ons, multi-sucursal, grants). SECURITY DEFINER + search_path=public.
-- IDEMPOTENTE (CREATE OR REPLACE). Aplicar en SQL Editor (INGLÉS), rol postgres.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ── get_restaurant_capabilities — base de paneles FAIL-CLOSED ────────
CREATE OR REPLACE FUNCTION public.get_restaurant_capabilities(p_restaurant_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan          RECORD;
  v_panels        JSONB;
  v_addon_panels  JSONB;
  v_addons        JSONB;
  v_base_panels   JSONB;
  v_eff_panels    JSONB;
  v_overrides     JSONB;
  v_parent        UUID;
  v_root          UUID;
  v_branches      JSONB;
  v_branch_count  INT;
  v_extra         INT;
  v_max_branches  INT;
BEGIN
  -- GUARD tenant-safe (mig 108): superadmin global; el resto solo su cuenta
  -- corporativa; anon/sin rol/cross-tenant → NULL (fail-closed).
  IF NOT COALESCE(
       public.get_my_role() = 'superadmin'
       OR p_restaurant_id IN (SELECT public.get_my_company_restaurant_ids()),
       false)
  THEN
    RETURN NULL;
  END IF;

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

  -- Overrides crudos del restaurante (mapa key→enabled), '{}' si no hay.
  SELECT COALESCE(jsonb_object_agg(key, enabled), '{}'::jsonb)
    INTO v_overrides
    FROM public.restaurant_feature_overrides
   WHERE restaurant_id = p_restaurant_id;

  -- Base de paneles = plan ∪ add-ons ∪ 'admin'  (FAIL-CLOSED).
  -- Lista vacía/null (p.ej. Emprendedor, 0 POS) ⇒ base = ['admin']: solo el panel
  -- del dueño + el Menú QR del cliente (que no es un panel gateado). NUNCA "todos".
  SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb)
    INTO v_base_panels
    FROM (
      SELECT jsonb_array_elements_text(v_panels)       AS p
      UNION SELECT jsonb_array_elements_text(v_addon_panels)
      UNION SELECT 'admin'
    ) u;

  -- Efectivo = base − overrides(false) + overrides(true).
  SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb)
    INTO v_eff_panels
    FROM (
      SELECT b.p
        FROM (SELECT jsonb_array_elements_text(v_base_panels) AS p) b
       WHERE NOT EXISTS (
         SELECT 1 FROM public.restaurant_feature_overrides o
          WHERE o.restaurant_id = p_restaurant_id
            AND o.key = 'panel:' || b.p AND o.enabled = false)
      UNION
      SELECT substring(o.key FROM 7)
        FROM public.restaurant_feature_overrides o
       WHERE o.restaurant_id = p_restaurant_id
         AND o.key LIKE 'panel:%' AND o.enabled = true
    ) e;

  -- Multi-sucursal (idéntico a la mig 146).
  SELECT r.parent_company_id, COALESCE(r.parent_company_id, r.id)
    INTO v_parent, v_root
    FROM public.restaurants r WHERE r.id = p_restaurant_id;

  SELECT COALESCE(jsonb_agg(
            jsonb_build_object('id', b.id, 'name', b.name, 'city', b.city,
                               'is_root', (b.id = v_root))
            ORDER BY (b.id = v_root) DESC, b.name
         ), '[]'::jsonb),
         COUNT(*)
    INTO v_branches, v_branch_count
    FROM public.restaurants b
   WHERE b.id = v_root OR b.parent_company_id = v_root;

  SELECT COALESCE(SUM(COALESCE(ra.quantity, 1)), 0)
    INTO v_extra
    FROM public.restaurant_addons ra
   WHERE ra.restaurant_id = v_root AND ra.addon_key = 'sucursal_extra' AND ra.enabled = true;
  v_max_branches := 1 + COALESCE(v_extra, 0);

  RETURN jsonb_build_object(
    'allowed_panels',      v_eff_panels,          -- EFECTIVO (con overrides)
    'plan_panels',         v_base_panels,         -- base sin overrides (para UI "fuente")
    'overrides',           v_overrides,           -- mapa crudo key→enabled
    'allowed_features',    v_plan.allowed_features,
    'addons',              v_addons,
    'max_users_by_role',   COALESCE(v_plan.max_users_by_role, '{}'::jsonb),
    'max_tables',          v_plan.max_tables,
    'max_menu_items',      v_plan.max_menu_items,
    'parent_company_id',   v_parent,
    'company_root_id',     v_root,
    'is_root',             (p_restaurant_id = v_root),
    'branches',            v_branches,
    'branch_count',        v_branch_count,
    'max_branches',        v_max_branches,
    'branches_over_limit', (v_branch_count > v_max_branches)
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_restaurant_capabilities(UUID) TO authenticated, anon;

-- ── is_panel_enabled — membresía FAIL-CLOSED ────────────────────────
CREATE OR REPLACE FUNCTION public.is_panel_enabled(p_restaurant_id UUID, p_panel TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_ovr    BOOLEAN;
  v_panels JSONB;
  v_addons JSONB;
BEGIN
  IF p_restaurant_id IS NULL OR COALESCE(p_panel, '') = '' THEN
    RETURN true;                          -- sin dato suficiente → fail-open
  END IF;

  -- 1) Override explícito manda (ON u OFF).
  SELECT enabled INTO v_ovr
    FROM public.restaurant_feature_overrides
   WHERE restaurant_id = p_restaurant_id AND key = 'panel:' || p_panel;
  IF FOUND THEN RETURN v_ovr; END IF;

  -- 2) admin: panel del dueño, siempre activo salvo override.
  IF p_panel = 'admin' THEN RETURN true; END IF;

  -- 3) Plan + add-ons.
  SELECT sp.allowed_panels INTO v_panels
    FROM public.subscriptions s
    JOIN public.subscription_plans sp ON sp.id = s.plan_id
   WHERE s.restaurant_id = p_restaurant_id
   ORDER BY s.created_at DESC
   LIMIT 1;
  SELECT COALESCE(jsonb_agg(pa.panel), '[]'::jsonb) INTO v_addons
    FROM public.restaurant_addons ra
    JOIN public.plan_addons pa ON pa.key = ra.addon_key
   WHERE ra.restaurant_id = p_restaurant_id AND ra.enabled = true;

  -- 4) Membresía en (plan ∪ add-ons)  (FAIL-CLOSED). Lista vacía/null ⇒ ningún
  --    panel POS (solo 'admin', ya resuelto arriba). NUNCA fail-open a "todos".
  RETURN (COALESCE(v_panels, '[]'::jsonb) ? p_panel) OR (v_addons ? p_panel);
END;
$$;
REVOKE ALL     ON FUNCTION public.is_panel_enabled(UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.is_panel_enabled(UUID, TEXT) TO anon, authenticated;

COMMIT;

-- Verificación rápida (correr aparte, como superadmin/service_role):
--   SELECT (public.get_restaurant_capabilities('38827cf0-6187-413f-91c0-02c98e56671d')->'plan_panels');
--   -- Esperado para Emprendedor: ["admin"]  (sin caja/mozo/cocina/gerente/delivery-*)

SELECT 'migration 155 applied — panel entitlements are now fail-closed (empty plan panel list = admin only)' AS status;
