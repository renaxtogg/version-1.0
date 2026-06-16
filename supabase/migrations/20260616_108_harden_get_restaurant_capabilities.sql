-- ════════════════════════════════════════════════════════════════════
-- 108 — Hardening tenant-safe de get_restaurant_capabilities
-- ────────────────────────────────────────────────────────────────────
-- Causa raíz: la RPC get_restaurant_capabilities(p_restaurant_id) es
-- SECURITY DEFINER y NO validaba el tenant del parámetro. Cualquier
-- usuario (incluido anon, por el GRANT de la mig 092) podía leer
-- metadata de plan / capabilities / sucursales (nombres, ciudades) de
-- CUALQUIER restaurante pasando un UUID ajeno → fuga de lectura
-- cross-tenant (p.ej. Don Carlos leyendo el plan de Terrapizza).
--
-- Fix (ESTE archivo): CREATE OR REPLACE con el MISMO cuerpo funcional de
-- la mig 092, agregando al inicio un guard tenant-safe:
--   • superadmin: puede consultar cualquier restaurante.
--   • autenticado: solo restaurantes dentro de get_my_company_restaurant_ids().
--   • cualquier otro (anon, sin rol activo, cross-tenant): RETURN NULL.
-- El guard usa COALESCE(...,false) para que la lógica trivaluada de SQL
-- (get_my_role() = NULL para anon/sin-rol) FALLE CERRADO y devuelva NULL,
-- en vez de colarse al cuerpo.
--
-- NO relaja RLS. NO usa USING(true)/WITH CHECK(true). NO toca pricing,
-- planes, allowed_features, ni ninguna otra función o tabla. Solo
-- reescribe esta función. El GRANT se mantiene idéntico a la mig 092
-- (authenticated, anon): anon conserva EXECUTE pero el guard le devuelve
-- NULL → sin datos útiles, sin metadata de tenants.
-- ════════════════════════════════════════════════════════════════════

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
  v_parent       UUID;
  v_root         UUID;
  v_branches     JSONB;
  v_branch_count INT;
  v_extra        INT;
  v_max_branches INT;
BEGIN
  -- ── GUARD tenant-safe (108) ──────────────────────────────────────
  -- Fail-closed: superadmin global; el resto solo su cuenta corporativa.
  -- anon / sin rol activo / cross-tenant → NULL (sin metadata ajena).
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

  -- ── Multi-sucursal: cuenta corporativa de p_restaurant_id ──
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

  -- Casa central (1) + sucursales 'sucursal_extra' contratadas en la raíz
  SELECT COALESCE(SUM(COALESCE(ra.quantity, 1)), 0)
    INTO v_extra
    FROM public.restaurant_addons ra
   WHERE ra.restaurant_id = v_root AND ra.addon_key = 'sucursal_extra' AND ra.enabled = true;
  v_max_branches := 1 + COALESCE(v_extra, 0);

  RETURN jsonb_build_object(
    'allowed_panels', (
      SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb)
      FROM (
        SELECT jsonb_array_elements_text(v_panels)       AS p
        UNION
        SELECT jsonb_array_elements_text(v_addon_panels) AS p
      ) u
    ),
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

-- GRANT idéntico a la mig 092 (no se relaja ni se amplía nada).
GRANT EXECUTE ON FUNCTION public.get_restaurant_capabilities(UUID) TO authenticated, anon;
