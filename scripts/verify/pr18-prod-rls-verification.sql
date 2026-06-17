-- PR-18 read-only verification script.
-- DO NOT modify data.
-- DO NOT run as a migration.
-- SELECT-only catalog inspection.
-- ════════════════════════════════════════════════════════════════════
-- PR-18 · VERIFICACIÓN RLS EN PRODUCCIÓN — SOLO LECTURA
-- ────────────────────────────────────────────────────────────────────
-- Objetivo: confirmar en Supabase prod (proyecto ocwzupmamfojvdywavqi)
-- el estado real de las migraciones 105/106/107/108 y de las políticas
-- RLS / RPCs SECURITY DEFINER, SIN modificar nada.
--
-- Cómo correr (manual, seguro):
--   1. Supabase Dashboard → SQL Editor. Cambiar idioma a INGLÉS
--      (el español auto-traduce keywords y rompe el SQL).
--   2. Pegar este archivo COMPLETO y ejecutar (o sección por sección).
--   3. Copiar la salida al informe docs/audits/pr18-prod-rls-verification.md
--      (NO pegar connection strings, tokens ni claves — esto no las pide).
--
-- Complementa (no reemplaza) docs/security/RLS_SPRINT_1_VERIFICATION.sql,
-- que tiene el detalle profundo de Sprint 1 (103/104) y 1B (105),
-- Q1–Q15. Corré AMBOS para cobertura total.
--
-- Cada bloque indica el resultado esperado (PASS). Todo es SELECT.
-- ════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════
-- SECCIÓN 1 — MIGRACIONES APLICADAS (mejor esfuerzo + efecto autoritativo)
-- ════════════════════════════════════════════════════════════════════

-- 1.0 ¿Existe la tabla de tracking de Supabase? (NULL = no accesible →
--     este proyecto aplica migraciones a mano; usar los checks de EFECTO
--     de la sección 2, que son la fuente de verdad).
SELECT to_regclass('supabase_migrations.schema_migrations') AS migrations_table;

-- 1.1 Si existe, filtrar las versiones de interés (105/106/107/108).
--     Si devuelve 0 filas pero la tabla existe, probablemente se aplicaron
--     fuera del tracker (SQL Editor manual) → confiar en la sección 2.
SELECT version, name
FROM supabase_migrations.schema_migrations
WHERE version ~ '10[5-8]'
   OR name ILIKE '%drift%'
   OR name ILIKE '%admin_list%'
   OR name ILIKE '%capabil%'
ORDER BY version;


-- ════════════════════════════════════════════════════════════════════
-- SECCIÓN 2 — VERIFICACIÓN POR EFECTO (autoritativa, independiente del
--             tracker de migraciones). Cada fila trae su esperado.
-- ════════════════════════════════════════════════════════════════════

-- 2.1 MIG 105 — drift hotfix. PASS = todos 0.
SELECT
  (SELECT count(*) FROM information_schema.role_table_grants
     WHERE table_schema='public' AND table_name='delivery_channels'
       AND grantee='anon')                                          AS dc_anon_grants_left,   -- 0
  (SELECT count(*) FROM pg_policies WHERE schemaname='public'
     AND policyname IN ('public_all_channels','public_read_channels',
        'public_all_riders','public_read_riders',
        'public_all_zones','public_read_zones'))                    AS drift_policies_left,   -- 0
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname LIKE 'admin\_%' ESCAPE '\'
       AND has_function_privilege('anon', p.oid,'EXECUTE'))         AS anon_admin_rpcs_left,  -- 0
  (SELECT count(*) FROM information_schema.role_table_grants
     WHERE grantee='anon' AND table_schema='public'
       AND privilege_type IN ('TRUNCATE','REFERENCES','TRIGGER'))   AS anon_residual_grants;  -- 0

-- 2.2 MIG 105 — las 3 RPCs de stock/menu NO deben ser ejecutables por anon.
--     PASS = 0 filas.
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public'
  AND p.proname IN ('admin_load_stock','admin_set_item_availability',
                    'admin_complete_stock_session')
  AND has_function_privilege('anon', p.oid,'EXECUTE');

-- 2.3 MIG 106+107 — tenant guard en admin_list_restaurant_users.
--     PASS = has_tenant_guard_107 = true.
SELECT
  p.proname,
  (pg_get_functiondef(p.oid) LIKE '%get_my_company_restaurant_ids%')  AS has_tenant_guard_107,  -- true
  (pg_get_functiondef(p.oid) LIKE '%get_my_role()%')                  AS uses_get_my_role,      -- true
  p.prosecdef                                                          AS is_security_definer,   -- true
  (p.proconfig::text LIKE '%search_path%')                            AS has_search_path_set    -- true
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='admin_list_restaurant_users';

-- 2.4 MIG 108 — tenant guard fail-closed en get_restaurant_capabilities.
--     PASS = has_tenant_guard = true AND has_failclosed_coalesce = true.
SELECT
  p.proname,
  (pg_get_functiondef(p.oid) LIKE '%get_my_company_restaurant_ids%')  AS has_tenant_guard,        -- true
  (pg_get_functiondef(p.oid) LIKE '%COALESCE%')                       AS has_failclosed_coalesce, -- true
  p.prosecdef                                                          AS is_security_definer      -- true
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='get_restaurant_capabilities';


-- ════════════════════════════════════════════════════════════════════
-- SECCIÓN 3 — TABLAS PÚBLICAS CON RLS DESHABILITADO
-- PASS = solo tablas sin datos sensibles de tenant (revisar cada una).
-- ════════════════════════════════════════════════════════════════════
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity = false
ORDER BY c.relname;


-- ════════════════════════════════════════════════════════════════════
-- SECCIÓN 4 — POLICIES CON USING(true) / WITH CHECK(true)
-- PASS = solo las "leftovers" de flujo anon documentadas en
-- RLS_SPRINT_1_VERIFICATION.sql Q3 (orders/order_items/ratings/tables/
-- menú/cupones/zonas/etc.). FAIL = payments, payroll, suppliers,
-- support, staff_*, stock, stations, settings, addons, etc.
-- ════════════════════════════════════════════════════════════════════
SELECT tablename, policyname, cmd, roles::text AS roles, qual, with_check
FROM pg_policies
WHERE schemaname='public' AND (qual = 'true' OR with_check = 'true')
ORDER BY tablename, policyname;


-- ════════════════════════════════════════════════════════════════════
-- SECCIÓN 5 — POLICIES QUE ALCANZAN A anon (revisar amplitud)
-- Clasificar como "requiere revisión" si qual no está acotado por
-- restaurant_id / auth.uid() / get_my_* / status.
-- ════════════════════════════════════════════════════════════════════
SELECT tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname='public' AND roles::text LIKE '%anon%'
ORDER BY tablename, policyname;


-- ════════════════════════════════════════════════════════════════════
-- SECCIÓN 6 — FUNCIONES SECURITY DEFINER EN public
-- Revisar: search_path fijado (PASS = true), si referencia un guard de
-- rol/tenant (heurística), y si anon puede ejecutarla (PASS = false
-- salvo el surface público aprobado: join_table_session,
-- get_table_upcoming_reservation, get_restaurant_capabilities,
-- check_menu_item_availability).
-- NO se ejecuta ninguna función; solo se leen definiciones.
-- ════════════════════════════════════════════════════════════════════
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid)                          AS args,
  (p.proconfig::text LIKE '%search_path%')                          AS has_search_path_set,
  COALESCE(array_to_string(p.proconfig,'; '),'(none)')              AS proconfig,
  (pg_get_functiondef(p.oid) ILIKE '%get_my_role%'
    OR pg_get_functiondef(p.oid) ILIKE '%get_my_company_restaurant_ids%'
    OR pg_get_functiondef(p.oid) ILIKE '%auth.uid()%')             AS references_guard_heuristic,
  has_function_privilege('anon',          p.oid,'EXECUTE')          AS anon_can_execute,
  has_function_privilege('authenticated', p.oid,'EXECUTE')          AS authenticated_can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prosecdef IS TRUE
ORDER BY anon_can_execute DESC, p.proname;


-- ════════════════════════════════════════════════════════════════════
-- SECCIÓN 7 — POLICIES DE TABLAS CRÍTICAS (listado completo por tabla)
-- Revisar que cada tabla tenga policies tenant-scoped y NO USING(true)
-- (salvo el flujo anon aprobado en orders/order_items/ratings).
-- ════════════════════════════════════════════════════════════════════
SELECT tablename, policyname, cmd, roles::text AS roles, qual, with_check
FROM pg_policies
WHERE schemaname='public'
  AND tablename IN (
    'orders','delivery_orders','restaurants','restaurant_settings',
    'user_profiles','user_roles','coupons','support_tickets',
    'staff_requests','delivery_channels','delivery_riders',
    'delivery_zones','ratings','payments','subscriptions',
    'restaurant_addons','staff_payroll_adjustments')
ORDER BY tablename, policyname;

-- 7.1 ¿Cuántas tablas críticas tienen RLS habilitado? (referencia)
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r'
  AND c.relname IN (
    'orders','delivery_orders','restaurants','restaurant_settings',
    'user_profiles','user_roles','coupons','support_tickets',
    'staff_requests','delivery_channels','delivery_riders',
    'delivery_zones','ratings','payments','subscriptions',
    'restaurant_addons','staff_payroll_adjustments')
ORDER BY c.relname;


-- ════════════════════════════════════════════════════════════════════
-- SECCIÓN 8 — REALTIME PUBLICATION (qué tablas se replican)
-- Revisar que no haya tablas sensibles publicadas sin necesidad
-- (payments, payroll, subscriptions, user_profiles, support_*).
-- ════════════════════════════════════════════════════════════════════
SELECT schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
ORDER BY schemaname, tablename;


-- ════════════════════════════════════════════════════════════════════
-- SECCIÓN 9 — GAUGE CONSOLIDADO PR-18 (una fila PASS/FAIL)
-- PASS global = anon_admin_rpcs=0, dc_anon_grants=0, drift_policies=0,
-- anon_residual=0, list_users_guarded=true, capabilities_guarded=true,
-- y rls_disabled_critical = 0.
-- ════════════════════════════════════════════════════════════════════
SELECT
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname LIKE 'admin\_%' ESCAPE '\'
       AND has_function_privilege('anon', p.oid,'EXECUTE'))               AS anon_admin_rpcs,        -- 0
  (SELECT count(*) FROM information_schema.role_table_grants
     WHERE table_schema='public' AND table_name='delivery_channels'
       AND grantee='anon')                                               AS dc_anon_grants,         -- 0
  (SELECT count(*) FROM pg_policies WHERE schemaname='public'
     AND policyname IN ('public_all_channels','public_read_channels',
        'public_all_riders','public_read_riders',
        'public_all_zones','public_read_zones'))                         AS drift_policies,         -- 0
  (SELECT count(*) FROM information_schema.role_table_grants
     WHERE grantee='anon' AND table_schema='public'
       AND privilege_type IN ('TRUNCATE','REFERENCES','TRIGGER'))        AS anon_residual_grants,   -- 0
  (SELECT bool_or(pg_get_functiondef(p.oid) LIKE '%get_my_company_restaurant_ids%')
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='admin_list_restaurant_users') AS list_users_guarded,   -- true
  (SELECT bool_or(pg_get_functiondef(p.oid) LIKE '%get_my_company_restaurant_ids%')
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='get_restaurant_capabilities') AS capabilities_guarded, -- true
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=false
       AND c.relname IN ('orders','delivery_orders','restaurants','payments',
         'subscriptions','user_profiles','user_roles','restaurant_settings',
         'delivery_channels','staff_payroll_adjustments'))              AS rls_disabled_critical;  -- 0

-- FIN — todo SELECT. Nada fue modificado.
