-- ============================================================
-- Migración 086 — Multi-tenant RLS Hardening (Sprint 1)
-- Reemplaza políticas USING(true) en tablas operativas por
-- políticas estrictas que filtran por restaurant_id del usuario.
--
-- Depende de: 029_fix_user_roles_rls_recursion
--   → ya existe: public.get_my_restaurant_id() SECURITY DEFINER
--   → ya existe: public.get_my_role()           SECURITY DEFINER
--
-- Estrategia:
--   • authenticated: filtro estricto por get_my_restaurant_id()
--   • anon:          SELECT permitido en tablas públicas (menú, mesas)
--                    INSERT/UPDATE limitado a flujo QR cliente
--   • order_items:   sin restaurant_id propio → subquery a orders
--
-- EJECUTAR EN SUPABASE SQL EDITOR (dashboard en inglés)
-- ============================================================

-- ── 0. Asegurar que la función helper existe ─────────────────
-- (creada en 029; recreada aquí como respaldo idempotente)
CREATE OR REPLACE FUNCTION public.get_my_restaurant_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT restaurant_id FROM public.user_roles
  WHERE user_id = auth.uid() AND is_active = true
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_restaurant_id() TO authenticated;

-- ════════════════════════════════════════════════════════════
-- 1. ORDERS
-- ════════════════════════════════════════════════════════════
-- Eliminar todas las políticas abiertas heredadas
DO $$
DECLARE pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE tablename = 'orders' AND schemaname = 'public'
      AND (qual LIKE '%true%' OR qual IS NULL OR qual = 'true')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.orders', pol.policyname);
  END LOOP;
END$$;

-- Authenticated: solo ve / opera órdenes de su restaurante
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='orders' AND policyname='orders_auth_select') THEN
    EXECUTE $p$
      CREATE POLICY "orders_auth_select" ON public.orders
        FOR SELECT TO authenticated
        USING (restaurant_id = public.get_my_restaurant_id())
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='orders' AND policyname='orders_auth_insert') THEN
    EXECUTE $p$
      CREATE POLICY "orders_auth_insert" ON public.orders
        FOR INSERT TO authenticated
        WITH CHECK (restaurant_id = public.get_my_restaurant_id())
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='orders' AND policyname='orders_auth_update') THEN
    EXECUTE $p$
      CREATE POLICY "orders_auth_update" ON public.orders
        FOR UPDATE TO authenticated
        USING  (restaurant_id = public.get_my_restaurant_id())
        WITH CHECK (restaurant_id = public.get_my_restaurant_id())
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='orders' AND policyname='orders_auth_delete') THEN
    EXECUTE $p$
      CREATE POLICY "orders_auth_delete" ON public.orders
        FOR DELETE TO authenticated
        USING (restaurant_id = public.get_my_restaurant_id())
    $p$;
  END IF;
  -- Anon: cliente QR crea y hace seguimiento de su propia orden
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='orders' AND policyname='orders_anon_select') THEN
    EXECUTE $p$
      CREATE POLICY "orders_anon_select" ON public.orders
        FOR SELECT TO anon
        USING (true)
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='orders' AND policyname='orders_anon_insert') THEN
    EXECUTE $p$
      CREATE POLICY "orders_anon_insert" ON public.orders
        FOR INSERT TO anon
        WITH CHECK (true)
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='orders' AND policyname='orders_anon_update') THEN
    EXECUTE $p$
      CREATE POLICY "orders_anon_update" ON public.orders
        FOR UPDATE TO anon
        USING (true) WITH CHECK (true)
    $p$;
  END IF;
END$$;

-- ════════════════════════════════════════════════════════════
-- 2. ORDER_ITEMS (sin restaurant_id propio — join a orders)
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE tablename = 'order_items' AND schemaname = 'public'
      AND (qual LIKE '%true%' OR qual IS NULL OR qual = 'true')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.order_items', pol.policyname);
  END LOOP;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='order_items' AND policyname='oi_auth_select') THEN
    EXECUTE $p$
      CREATE POLICY "oi_auth_select" ON public.order_items
        FOR SELECT TO authenticated
        USING (EXISTS (
          SELECT 1 FROM public.orders o
          WHERE o.id = order_id
            AND o.restaurant_id = public.get_my_restaurant_id()
        ))
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='order_items' AND policyname='oi_auth_insert') THEN
    EXECUTE $p$
      CREATE POLICY "oi_auth_insert" ON public.order_items
        FOR INSERT TO authenticated
        WITH CHECK (EXISTS (
          SELECT 1 FROM public.orders o
          WHERE o.id = order_id
            AND o.restaurant_id = public.get_my_restaurant_id()
        ))
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='order_items' AND policyname='oi_auth_update') THEN
    EXECUTE $p$
      CREATE POLICY "oi_auth_update" ON public.order_items
        FOR UPDATE TO authenticated
        USING (EXISTS (
          SELECT 1 FROM public.orders o
          WHERE o.id = order_id
            AND o.restaurant_id = public.get_my_restaurant_id()
        ))
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='order_items' AND policyname='oi_auth_delete') THEN
    EXECUTE $p$
      CREATE POLICY "oi_auth_delete" ON public.order_items
        FOR DELETE TO authenticated
        USING (EXISTS (
          SELECT 1 FROM public.orders o
          WHERE o.id = order_id
            AND o.restaurant_id = public.get_my_restaurant_id()
        ))
    $p$;
  END IF;
  -- Anon: puede insertar/leer ítems de sus propias órdenes
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='order_items' AND policyname='oi_anon_all') THEN
    EXECUTE $p$
      CREATE POLICY "oi_anon_all" ON public.order_items
        FOR ALL TO anon
        USING (true) WITH CHECK (true)
    $p$;
  END IF;
END$$;

-- ════════════════════════════════════════════════════════════
-- 3. DELIVERY_ORDERS
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE tablename = 'delivery_orders' AND schemaname = 'public'
      AND (qual LIKE '%true%' OR qual IS NULL OR qual = 'true')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.delivery_orders', pol.policyname);
  END LOOP;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='delivery_orders' AND policyname='dord_auth_select') THEN
    EXECUTE $p$
      CREATE POLICY "dord_auth_select" ON public.delivery_orders
        FOR SELECT TO authenticated
        USING (restaurant_id = public.get_my_restaurant_id())
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='delivery_orders' AND policyname='dord_auth_insert') THEN
    EXECUTE $p$
      CREATE POLICY "dord_auth_insert" ON public.delivery_orders
        FOR INSERT TO authenticated
        WITH CHECK (restaurant_id = public.get_my_restaurant_id())
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='delivery_orders' AND policyname='dord_auth_update') THEN
    EXECUTE $p$
      CREATE POLICY "dord_auth_update" ON public.delivery_orders
        FOR UPDATE TO authenticated
        USING  (restaurant_id = public.get_my_restaurant_id())
        WITH CHECK (restaurant_id = public.get_my_restaurant_id())
    $p$;
  END IF;
  -- Anon: cliente delivery crea y sigue su propia orden
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='delivery_orders' AND policyname='dord_anon_all') THEN
    EXECUTE $p$
      CREATE POLICY "dord_anon_all" ON public.delivery_orders
        FOR ALL TO anon
        USING (true) WITH CHECK (true)
    $p$;
  END IF;
END$$;

-- ════════════════════════════════════════════════════════════
-- 4. TABLES (mesas) — lectura pública limitada a SELECT
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE tablename = 'tables' AND schemaname = 'public'
      AND (qual LIKE '%true%' OR qual IS NULL OR qual = 'true')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.tables', pol.policyname);
  END LOOP;
END$$;

DO $$
BEGIN
  -- Anon solo puede leer (cliente QR necesita ver info de su mesa)
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tables' AND policyname='tables_anon_select') THEN
    EXECUTE $p$
      CREATE POLICY "tables_anon_select" ON public.tables
        FOR SELECT TO anon
        USING (true)
    $p$;
  END IF;
  -- Authenticated: opera solo mesas de su restaurante
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tables' AND policyname='tables_auth_select') THEN
    EXECUTE $p$
      CREATE POLICY "tables_auth_select" ON public.tables
        FOR SELECT TO authenticated
        USING (restaurant_id = public.get_my_restaurant_id())
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tables' AND policyname='tables_auth_insert') THEN
    EXECUTE $p$
      CREATE POLICY "tables_auth_insert" ON public.tables
        FOR INSERT TO authenticated
        WITH CHECK (restaurant_id = public.get_my_restaurant_id())
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tables' AND policyname='tables_auth_update') THEN
    EXECUTE $p$
      CREATE POLICY "tables_auth_update" ON public.tables
        FOR UPDATE TO authenticated
        USING  (restaurant_id = public.get_my_restaurant_id())
        WITH CHECK (restaurant_id = public.get_my_restaurant_id())
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tables' AND policyname='tables_auth_delete') THEN
    EXECUTE $p$
      CREATE POLICY "tables_auth_delete" ON public.tables
        FOR DELETE TO authenticated
        USING (restaurant_id = public.get_my_restaurant_id())
    $p$;
  END IF;
END$$;

-- ════════════════════════════════════════════════════════════
-- 5. MENU_CATEGORIES — lectura pública, escritura solo auth
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE tablename = 'menu_categories' AND schemaname = 'public'
      AND (qual LIKE '%true%' OR qual IS NULL OR qual = 'true')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.menu_categories', pol.policyname);
  END LOOP;
END$$;

DO $$
BEGIN
  -- Anon puede leer categorías (menú público)
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='menu_categories' AND policyname='mc_anon_select') THEN
    EXECUTE $p$
      CREATE POLICY "mc_anon_select" ON public.menu_categories
        FOR SELECT TO anon
        USING (true)
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='menu_categories' AND policyname='mc_auth_select') THEN
    EXECUTE $p$
      CREATE POLICY "mc_auth_select" ON public.menu_categories
        FOR SELECT TO authenticated
        USING (restaurant_id = public.get_my_restaurant_id())
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='menu_categories' AND policyname='mc_auth_insert') THEN
    EXECUTE $p$
      CREATE POLICY "mc_auth_insert" ON public.menu_categories
        FOR INSERT TO authenticated
        WITH CHECK (restaurant_id = public.get_my_restaurant_id())
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='menu_categories' AND policyname='mc_auth_update') THEN
    EXECUTE $p$
      CREATE POLICY "mc_auth_update" ON public.menu_categories
        FOR UPDATE TO authenticated
        USING  (restaurant_id = public.get_my_restaurant_id())
        WITH CHECK (restaurant_id = public.get_my_restaurant_id())
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='menu_categories' AND policyname='mc_auth_delete') THEN
    EXECUTE $p$
      CREATE POLICY "mc_auth_delete" ON public.menu_categories
        FOR DELETE TO authenticated
        USING (restaurant_id = public.get_my_restaurant_id())
    $p$;
  END IF;
END$$;

-- ════════════════════════════════════════════════════════════
-- 6. MENU_ITEMS — lectura pública, escritura solo auth
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE tablename = 'menu_items' AND schemaname = 'public'
      AND (qual LIKE '%true%' OR qual IS NULL OR qual = 'true')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.menu_items', pol.policyname);
  END LOOP;
END$$;

DO $$
BEGIN
  -- Anon puede leer ítems del menú (menú público)
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='menu_items' AND policyname='mi_anon_select') THEN
    EXECUTE $p$
      CREATE POLICY "mi_anon_select" ON public.menu_items
        FOR SELECT TO anon
        USING (true)
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='menu_items' AND policyname='mi_auth_select') THEN
    EXECUTE $p$
      CREATE POLICY "mi_auth_select" ON public.menu_items
        FOR SELECT TO authenticated
        USING (restaurant_id = public.get_my_restaurant_id())
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='menu_items' AND policyname='mi_auth_insert') THEN
    EXECUTE $p$
      CREATE POLICY "mi_auth_insert" ON public.menu_items
        FOR INSERT TO authenticated
        WITH CHECK (restaurant_id = public.get_my_restaurant_id())
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='menu_items' AND policyname='mi_auth_update') THEN
    EXECUTE $p$
      CREATE POLICY "mi_auth_update" ON public.menu_items
        FOR UPDATE TO authenticated
        USING  (restaurant_id = public.get_my_restaurant_id())
        WITH CHECK (restaurant_id = public.get_my_restaurant_id())
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='menu_items' AND policyname='mi_auth_delete') THEN
    EXECUTE $p$
      CREATE POLICY "mi_auth_delete" ON public.menu_items
        FOR DELETE TO authenticated
        USING (restaurant_id = public.get_my_restaurant_id())
    $p$;
  END IF;
END$$;
