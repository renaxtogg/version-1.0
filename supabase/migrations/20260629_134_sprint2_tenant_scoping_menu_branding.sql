-- ════════════════════════════════════════════════════════════════════
-- 134 · Sprint 2 · Lote 2 — TENANT SCOPING de menú/branding (completitud)
-- ────────────────────────────────────────────────────────────────────
-- Cierra el último cross-tenant de authenticated en las tablas de menú/branding.
-- Hoy conviven, en estas 5 tablas, policies SCOPED correctas (TO authenticated /
-- TO anon de migs 086/092/103/104) con policies LEGACY SIN ROL (PUBLIC) con
-- USING(true) de migs 001/003/009/010/021/026/027. Las PUBLIC aplican a TODOS
-- los roles → un staff logueado de un local lee/toca menú/mesas/branding de OTRO
-- local (y la lectura completa de restaurants expone owner_email/ruc, etc.).
--
-- Estado ya correcto (NO se toca, sobrevive):
--   • menu_categories/menu_items/tables: authenticated acotado por empresa
--     (mc_/mi_/tables_auth_* de mig 092, restaurant_id IN get_my_company_restaurant_ids());
--     lectura anon TO anon (mc_/mi_/tables_anon_select de mig 086).
--   • menu_item_extras: authenticated acotado por extras_auth_write (mig 104,
--     FOR ALL TO authenticated, join a menu_items).
--   • restaurants: restaurants_superadmin_all + restaurants_update_own (mig 103).
--
-- Estrategia robusta (independiente de qué policies legacy quedaron vivas tras
-- re-runs idempotentes de la mig 010): DROPear TODAS las policies SIN ROL
-- (PUBLIC) de estas 5 tablas — las TO authenticated (092/103/104) y TO anon
-- (086) NO son PUBLIC y sobreviven — y re-crear EXPLÍCITAS la lectura anon del
-- QR (para garantizar que el menú del cliente NO se rompe) y el SELECT
-- authenticated acotado de restaurants (que hoy NO existía: la 103 sólo creó
-- superadmin_all + update_own, y el admin leía su local por la PUBLIC abierta).
--
-- anon en estas 5 tablas SÓLO lee (verificado en src/index y src/delivery-cliente:
-- ninguna escritura). Catálogos globales (subscription_plans/plan_addons/
-- platform_config) NO se tocan (abiertos a propósito). onboarding usa
-- service_role (bypassa RLS) → no afectado. El GRANT de columnas de anon en
-- restaurants (mig 102) NO se toca → el branding del QR sigue column-limited.
--
-- Idempotente. PREPARED — aplicar A MANO en el SQL Editor (en inglés), DESPUÉS
-- de 092/102/103/104. No la aplica el deploy.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- 1. Quitar TODAS las policies SIN ROL (PUBLIC) de las 5 tablas.
--    Esto elimina los leaks legacy USING(true): admin_read_all_*/admin_*_*
--    (mig 010), read_* (mig 001), las de migs 003/009, cajero_tables_select
--    (027, redundante con tables_auth_select), "Staff can update table
--    occupancy"/update_tables (021/026, redundante con tables_auth_update),
--    admin_read_restaurants (010), read_restaurants/read_menu_extras (001), etc.
--    Las policies TO authenticated (086/092/103/104) y TO anon (086) NO son
--    PUBLIC → no entran en este DROP.
-- ════════════════════════════════════════════════════════════════════
DO $$
DECLARE pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname, tablename
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('menu_categories','menu_items','menu_item_extras','tables','restaurants')
       AND 'public' = ANY(roles)            -- sólo policies sin rol explícito (= PUBLIC)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END$$;

-- ════════════════════════════════════════════════════════════════════
-- 2. Re-crear la LECTURA ANON del QR (TO anon). Las de 086 (mc_/mi_/tables_
--    anon_select) sobreviven al paso 1, pero las re-aseguramos explícitas para
--    garantizar que el menú del cliente NO se rompe pase lo que pase en vivo.
-- ════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "mc_anon_select" ON public.menu_categories;
CREATE POLICY "mc_anon_select" ON public.menu_categories
  FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "mi_anon_select" ON public.menu_items;
CREATE POLICY "mi_anon_select" ON public.menu_items
  FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "tables_anon_select" ON public.tables;
CREATE POLICY "tables_anon_select" ON public.tables
  FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "menu_item_extras_anon_select" ON public.menu_item_extras;
CREATE POLICY "menu_item_extras_anon_select" ON public.menu_item_extras
  FOR SELECT TO anon USING (true);

-- restaurants: branding del QR. is_active=true como la read_restaurants original;
-- las columnas siguen limitadas por el GRANT de anon de la mig 102 (no se toca).
DROP POLICY IF EXISTS "restaurants_anon_select" ON public.restaurants;
CREATE POLICY "restaurants_anon_select" ON public.restaurants
  FOR SELECT TO anon USING (is_active = true);

-- ════════════════════════════════════════════════════════════════════
-- 3. restaurants: SELECT authenticated acotado por empresa (NUEVO).
--    Antes el admin leía su restaurante por la PUBLIC abierta (ya dropeada);
--    la 103 sólo dejó superadmin_all (FOR ALL) + update_own (UPDATE). Sin esto,
--    un admin no-superadmin no podría leer su propio restaurante. PK = id.
--    superadmin sigue viendo todo (por su rama y por restaurants_superadmin_all).
-- ════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "restaurants_auth_select" ON public.restaurants;
CREATE POLICY "restaurants_auth_select" ON public.restaurants
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR id IN (SELECT public.get_my_company_restaurant_ids())
  );

COMMIT;

-- Recargar el cache de esquema de PostgREST.
NOTIFY pgrst, 'reload schema';

SELECT 'migracion 134 aplicada (Sprint 2 Lote 2 — tenant scoping menú/branding)' AS status;
