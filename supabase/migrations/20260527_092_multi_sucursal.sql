-- ═══════════════════════════════════════════════════════════
-- MIGRACIÓN 092 — MULTI-SUCURSAL CORPORATIVA (Add-on)
-- EJECUTAR EN SUPABASE SQL EDITOR (dashboard en INGLÉS)
--
-- Cadenas de restaurantes bajo una misma cuenta corporativa:
--   · restaurants.parent_company_id (auto-referencia Parent-Child)
--       NULL o = id   → Casa Central (raíz de la cuenta corporativa)
--       = id_raíz      → Sucursal Hija anclada a esa cuenta
--   · restaurant_addons.quantity → nº de 'sucursal_extra' contratadas
--   · get_my_company_restaurant_ids(): set de locales accesibles, ROLE-AWARE
--       staff (mozo/cajero/cocina/rider) → SOLO su sucursal (anclaje PIN)
--       dueño (admin/gerente/owner)      → casa central + todas las hijas
--   · RLS de la 086 reescrita: '= get_my_restaurant_id()' →
--       'IN (get_my_company_restaurant_ids())' (staff sigue anclado)
--   · get_restaurant_capabilities(): suma branches, max_branches y validación
--   · trigger enforce_branch_limit: backstop server-side (bypass superadmin)
-- ═══════════════════════════════════════════════════════════

-- ─── 1. Auto-referencia Parent-Child en restaurants ────────────────
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS parent_company_id UUID REFERENCES public.restaurants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_restaurants_parent_company
  ON public.restaurants(parent_company_id) WHERE parent_company_id IS NOT NULL;

-- ─── 2. Cantidad de add-ons (1 fila 'sucursal_extra' = N sucursales) ─
ALTER TABLE public.restaurant_addons
  ADD COLUMN IF NOT EXISTS quantity INT NOT NULL DEFAULT 1;

-- ─── 3. Catálogo: add-on de sucursal extra ─────────────────────────
INSERT INTO public.plan_addons (key, name, panel, price_usd) VALUES
  ('sucursal_extra', 'Sucursal Adicional (Multi-local)', 'admin', 25.00)
ON CONFLICT (key) DO NOTHING;

-- ─── 4. Helper ROLE-AWARE: locales accesibles por el usuario ───────
-- Staff (mozo/cajero/cocina/rider): anclado a su sucursal asignada.
-- Dueño (admin/gerente/owner): casa central + todas las sucursales hijas.
CREATE OR REPLACE FUNCTION public.get_my_company_restaurant_ids()
RETURNS SETOF UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rid  UUID;
  v_role TEXT;
  v_root UUID;
BEGIN
  SELECT ur.restaurant_id, ur.role
    INTO v_rid, v_role
    FROM public.user_roles ur
   WHERE ur.user_id = auth.uid() AND ur.is_active = true
   LIMIT 1;

  IF v_rid IS NULL THEN
    RETURN;   -- sin sesión válida → conjunto vacío
  END IF;

  -- Roles operativos locales: estrictamente anclados a su sucursal
  IF v_role IS NULL OR v_role NOT IN ('admin','gerente','owner') THEN
    RETURN QUERY SELECT v_rid;
    RETURN;
  END IF;

  -- Roles de dueño: toda la cuenta corporativa (raíz + hijas)
  SELECT COALESCE(r.parent_company_id, r.id) INTO v_root
    FROM public.restaurants r WHERE r.id = v_rid;

  RETURN QUERY
    SELECT r.id FROM public.restaurants r
     WHERE r.id = v_root OR r.parent_company_id = v_root;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_my_company_restaurant_ids() TO authenticated;

-- ─── 5. RLS company-scoped (reescribe políticas auth de la 086) ────
-- Reemplaza '= get_my_restaurant_id()' por 'IN (company set)'.
-- Para staff el set es {su sucursal} → comportamiento idéntico al actual.
-- Las políticas anon_* y *_superadmin_all (086/088) NO se tocan.

-- 5.1 ORDERS
DROP POLICY IF EXISTS "orders_auth_select" ON public.orders;
DROP POLICY IF EXISTS "orders_auth_insert" ON public.orders;
DROP POLICY IF EXISTS "orders_auth_update" ON public.orders;
DROP POLICY IF EXISTS "orders_auth_delete" ON public.orders;
CREATE POLICY "orders_auth_select" ON public.orders FOR SELECT TO authenticated
  USING (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));
CREATE POLICY "orders_auth_insert" ON public.orders FOR INSERT TO authenticated
  WITH CHECK (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));
CREATE POLICY "orders_auth_update" ON public.orders FOR UPDATE TO authenticated
  USING (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  WITH CHECK (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));
CREATE POLICY "orders_auth_delete" ON public.orders FOR DELETE TO authenticated
  USING (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));

-- 5.2 ORDER_ITEMS (sin restaurant_id propio → join a orders)
DROP POLICY IF EXISTS "oi_auth_select" ON public.order_items;
DROP POLICY IF EXISTS "oi_auth_insert" ON public.order_items;
DROP POLICY IF EXISTS "oi_auth_update" ON public.order_items;
DROP POLICY IF EXISTS "oi_auth_delete" ON public.order_items;
CREATE POLICY "oi_auth_select" ON public.order_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id
                 AND o.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())));
CREATE POLICY "oi_auth_insert" ON public.order_items FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id
                 AND o.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())));
CREATE POLICY "oi_auth_update" ON public.order_items FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id
                 AND o.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())));
CREATE POLICY "oi_auth_delete" ON public.order_items FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id
                 AND o.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())));

-- 5.3 DELIVERY_ORDERS
DROP POLICY IF EXISTS "dord_auth_select" ON public.delivery_orders;
DROP POLICY IF EXISTS "dord_auth_insert" ON public.delivery_orders;
DROP POLICY IF EXISTS "dord_auth_update" ON public.delivery_orders;
CREATE POLICY "dord_auth_select" ON public.delivery_orders FOR SELECT TO authenticated
  USING (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));
CREATE POLICY "dord_auth_insert" ON public.delivery_orders FOR INSERT TO authenticated
  WITH CHECK (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));
CREATE POLICY "dord_auth_update" ON public.delivery_orders FOR UPDATE TO authenticated
  USING (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  WITH CHECK (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));

-- 5.4 TABLES
DROP POLICY IF EXISTS "tables_auth_select" ON public.tables;
DROP POLICY IF EXISTS "tables_auth_insert" ON public.tables;
DROP POLICY IF EXISTS "tables_auth_update" ON public.tables;
DROP POLICY IF EXISTS "tables_auth_delete" ON public.tables;
CREATE POLICY "tables_auth_select" ON public.tables FOR SELECT TO authenticated
  USING (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));
CREATE POLICY "tables_auth_insert" ON public.tables FOR INSERT TO authenticated
  WITH CHECK (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));
CREATE POLICY "tables_auth_update" ON public.tables FOR UPDATE TO authenticated
  USING (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  WITH CHECK (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));
CREATE POLICY "tables_auth_delete" ON public.tables FOR DELETE TO authenticated
  USING (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));

-- 5.5 MENU_CATEGORIES
DROP POLICY IF EXISTS "mc_auth_select" ON public.menu_categories;
DROP POLICY IF EXISTS "mc_auth_insert" ON public.menu_categories;
DROP POLICY IF EXISTS "mc_auth_update" ON public.menu_categories;
DROP POLICY IF EXISTS "mc_auth_delete" ON public.menu_categories;
CREATE POLICY "mc_auth_select" ON public.menu_categories FOR SELECT TO authenticated
  USING (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));
CREATE POLICY "mc_auth_insert" ON public.menu_categories FOR INSERT TO authenticated
  WITH CHECK (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));
CREATE POLICY "mc_auth_update" ON public.menu_categories FOR UPDATE TO authenticated
  USING (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  WITH CHECK (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));
CREATE POLICY "mc_auth_delete" ON public.menu_categories FOR DELETE TO authenticated
  USING (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));

-- 5.6 MENU_ITEMS
DROP POLICY IF EXISTS "mi_auth_select" ON public.menu_items;
DROP POLICY IF EXISTS "mi_auth_insert" ON public.menu_items;
DROP POLICY IF EXISTS "mi_auth_update" ON public.menu_items;
DROP POLICY IF EXISTS "mi_auth_delete" ON public.menu_items;
CREATE POLICY "mi_auth_select" ON public.menu_items FOR SELECT TO authenticated
  USING (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));
CREATE POLICY "mi_auth_insert" ON public.menu_items FOR INSERT TO authenticated
  WITH CHECK (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));
CREATE POLICY "mi_auth_update" ON public.menu_items FOR UPDATE TO authenticated
  USING (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  WITH CHECK (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));
CREATE POLICY "mi_auth_delete" ON public.menu_items FOR DELETE TO authenticated
  USING (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));

-- ─── 6. RPC capacidades: + sucursales autorizadas y validación ─────
-- Mantiene el contrato de la 091 y añade el bloque multi-sucursal.
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
GRANT EXECUTE ON FUNCTION public.get_restaurant_capabilities(UUID) TO authenticated, anon;

-- ─── 7. Trigger backstop: límite de sucursales por add-ons ─────────
-- Rechaza crear una sucursal hija por encima de lo contratado.
-- Bypass para 'superadmin' (es quien vende/provisiona los locales).
CREATE OR REPLACE FUNCTION public.enforce_branch_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_root  UUID;
  v_count INT;
  v_max   INT;
BEGIN
  -- Casa central (sin padre o auto-referencia) → sin límite
  IF NEW.parent_company_id IS NULL OR NEW.parent_company_id = NEW.id THEN
    RETURN NEW;
  END IF;

  -- El vendedor (superadmin) puede aprovisionar libremente
  IF public.get_my_role() = 'superadmin' THEN
    RETURN NEW;
  END IF;

  v_root := NEW.parent_company_id;

  SELECT COUNT(*) INTO v_count
    FROM public.restaurants
   WHERE id = v_root OR parent_company_id = v_root;

  SELECT 1 + COALESCE(SUM(COALESCE(quantity, 1)), 0) INTO v_max
    FROM public.restaurant_addons
   WHERE restaurant_id = v_root AND addon_key = 'sucursal_extra' AND enabled = true;

  IF (v_count + 1) > v_max THEN
    RAISE EXCEPTION 'Límite de sucursales alcanzado (máx %). Contrate el add-on "sucursal_extra".', v_max
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_branch_limit ON public.restaurants;
CREATE TRIGGER trg_enforce_branch_limit
  BEFORE INSERT ON public.restaurants
  FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_limit();

-- ─── 8. Confirmación ───────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE 'Migración 092 aplicada — Multi-Sucursal Corporativa activa';
END$$;
