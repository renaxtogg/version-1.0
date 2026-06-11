-- ════════════════════════════════════════════════════════════════════
-- RLS SPRINT 1 — READ-ONLY VERIFICATION QUERIES
-- Run BEFORE applying 103/104 (record the baseline) and AFTER applying
-- (confirm the lockdown). Every query is a SELECT — nothing is changed.
-- Run via the guarded runner (_simulacion/run.ps1) or the SQL Editor
-- (dashboard in ENGLISH).
-- ════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────
-- Q1. Anon TABLE-LEVEL write grants on critical tables
-- BEFORE: rows for restaurants (UPDATE/DELETE/INSERT...), payments,
--         staff_payroll_adjustments, kitchen_stations, etc.
-- AFTER (PASS): 0 rows. Column-level grants (orders/delivery_orders/
--         restaurants SELECT, delivery_orders UPDATE) do NOT appear
--         here — they live in role_column_grants (see Q2).
-- ────────────────────────────────────────────────────────────────────
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'anon'
  AND table_schema = 'public'
  AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
  AND table_name IN (
    'restaurants','payments','subscriptions','staff_payroll_adjustments',
    'waiter_debts','employee_shifts','kitchen_stations',
    'kitchen_station_categories','kitchen_station_zonas',
    'order_item_station_log','platform_config','platform_events',
    'delivery_riders','delivery_zones','restaurant_settings',
    'calendar_events','subscription_plans','plan_addons','restaurant_addons',
    'suppliers','supplier_contacts','supplier_purchases','shift_logs',
    'manager_approvals','item_86_list','support_tickets','support_messages',
    'staff_sessions','staff_broadcasts','staff_requests','expenses',
    'ingredients','recipes','stock_movements','stock_alerts',
    'availability_log','stock_sessions','stock_session_items',
    'kitchen_messages','user_profiles','coupons','menu_item_extras'
  )
ORDER BY table_name, privilege_type;

-- ────────────────────────────────────────────────────────────────────
-- Q1b. delivery_orders + reservations anon grants (special cases)
-- AFTER (PASS): delivery_orders → INSERT only (UPDATE fully revoked —
--   Sprint 1A.1; no column-level UPDATE either, see Q2).
--   reservations → INSERT only (SELECT/UPDATE/DELETE revoked).
-- FAIL: any UPDATE/DELETE/SELECT(table-level) row for either table.
-- ────────────────────────────────────────────────────────────────────
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'anon'
  AND table_schema = 'public'
  AND table_name IN ('delivery_orders','reservations')
ORDER BY table_name, privilege_type;

-- ────────────────────────────────────────────────────────────────────
-- Q2. Anon COLUMN-LEVEL grants (the intentional narrow surface)
-- AFTER (PASS): NO UPDATE rows at all (anon UPDATE on delivery_orders
--   was fully revoked in Sprint 1A.1 — table- and column-level);
--   SELECT column lists on orders/delivery_orders/restaurants/
--   delivery_riders contain NO PII columns (no customer_*, owner_*,
--   phone, commission_*, rider_pin, user_id).
-- ────────────────────────────────────────────────────────────────────
SELECT table_name, privilege_type, string_agg(column_name, ', ' ORDER BY column_name) AS columns
FROM information_schema.role_column_grants
WHERE grantee = 'anon'
  AND table_schema = 'public'
  AND table_name IN ('orders','delivery_orders','restaurants','delivery_riders')
GROUP BY table_name, privilege_type
ORDER BY table_name, privilege_type;

-- ────────────────────────────────────────────────────────────────────
-- Q3. All remaining USING(true)/WITH CHECK(true) policies
-- AFTER (PASS): ONLY the documented Sprint-2 anon-flow leftovers:
--   orders (anon select/insert), order_items (anon select/insert),
--   order_item_extras, order_status_history, waiter_calls, ratings,
--   table_scan_sessions, tables_anon_select,
--   mc_anon_select / mi_anon_select / read_menu_extras / read_coupons,
--   delivery_zones_read, delivery_orders (anon SELECT + INSERT ONLY —
--   dord_anon_update must NOT exist, see Q5),
--   platform_config_read, plans_auth_select / plan_addons_auth_select,
--   platform_events_auth_insert, admin_read_restaurants /
--   read_restaurants.
-- FAIL: any hit on payments, payroll, suppliers, support, staff_*,
--   stock, stations, settings, calendar, plan/restaurant_addons,
--   reservations (now scoped: anon insert is WITH CHECK
--   status='pending', NOT 'true'; auth policy is tenant-scoped).
-- ────────────────────────────────────────────────────────────────────
SELECT tablename, policyname, cmd, roles::text, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND (qual = 'true' OR with_check = 'true')
ORDER BY tablename, policyname;

-- ────────────────────────────────────────────────────────────────────
-- Q4. Full policy listing for the four named critical tables
-- AFTER (PASS):
--   restaurants: read_restaurants[SELECT], admin_read_restaurants[SELECT],
--     restaurants_superadmin_all[ALL], restaurants_update_own[UPDATE].
--     sa_restaurants_all and admin_update_restaurant MUST be gone.
--   payments: only payments_superadmin_all[ALL].
--   staff_payroll_adjustments: only staff_payroll_adjustments_auth[ALL].
--   delivery_orders: dord_auth_* (092), dord_anon_select / dord_anon_insert,
--     NO dord_anon_update (dropped in Sprint 1A.1),
--     delivery_orders_superadmin_all (088).
--   reservations: reservations_anon_insert (with_check status='pending'),
--     reservations_auth (tenant-scoped), reservations_superadmin_all (088).
--     reservations_anon_select / reservations_auth_all MUST be gone.
-- ────────────────────────────────────────────────────────────────────
SELECT tablename, policyname, cmd, roles::text, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('restaurants','payments','staff_payroll_adjustments',
                    'delivery_orders','reservations')
ORDER BY tablename, policyname;

-- ────────────────────────────────────────────────────────────────────
-- Q5. Targeted check: dropped policies
-- AFTER (PASS): every counter is 0.
-- ────────────────────────────────────────────────────────────────────
SELECT
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname = 'sa_restaurants_all')      AS sa_restaurants_all_left,      -- must be 0
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname = 'admin_update_restaurant') AS admin_update_restaurant_left, -- must be 0
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname = 'sa_payments_all')         AS sa_payments_all_left,         -- must be 0
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname = 'sa_events_all')           AS sa_events_all_left,           -- must be 0
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='delivery_orders'
      AND policyname = 'dord_anon_update')                                                                AS dord_anon_update_left,        -- must be 0 (1A.1)
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='reservations'
      AND policyname IN ('reservations_anon_select','reservations_auth_all'))                             AS reservations_open_left;       -- must be 0 (1A.1)

-- ────────────────────────────────────────────────────────────────────
-- Q6. Functions executable by anon
-- AFTER (PASS): the expected public RPC surface only:
--   join_table_session, get_table_upcoming_reservation,
--   get_restaurant_capabilities, check_menu_item_availability
--   (+ pg/extension internals). FAIL if present: get_user_email,
--   superadmin_reset_operation_data, superadmin_seed_simulated_environment,
--   admin_create_user.
-- ────────────────────────────────────────────────────────────────────
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND has_function_privilege('anon', p.oid, 'EXECUTE')
ORDER BY p.proname;

-- ────────────────────────────────────────────────────────────────────
-- Q7. The 068 dev RPCs are gone
-- AFTER (PASS): 0 rows.
-- ────────────────────────────────────────────────────────────────────
SELECT p.proname
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('superadmin_reset_operation_data',
                    'superadmin_seed_simulated_environment',
                    '_assert_superadmin');

-- ────────────────────────────────────────────────────────────────────
-- Q8. Tenant scoping is in place (policies referencing the helper)
-- AFTER (PASS): every table scoped by 103/104 appears here at least
-- once (suppliers, support_tickets, staff_sessions, expenses,
-- ingredients, kitchen_stations, delivery_riders, waiter_debts, ...).
-- ────────────────────────────────────────────────────────────────────
SELECT tablename, count(*) AS scoped_policies
FROM pg_policies
WHERE schemaname = 'public'
  AND (qual LIKE '%get_my_company_restaurant_ids%'
       OR with_check LIKE '%get_my_company_restaurant_ids%')
GROUP BY tablename
ORDER BY tablename;

-- ────────────────────────────────────────────────────────────────────
-- Q9. Tables with RLS DISABLED (defense-in-depth sweep)
-- Any row here is fully governed by grants alone — review each.
-- (reservations was confirmed RLS-ENABLED in mig 040 and is now
--  scoped by 103 §12 — it must NOT appear here.)
-- ────────────────────────────────────────────────────────────────────
SELECT c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity = false
ORDER BY c.relname;

-- ────────────────────────────────────────────────────────────────────
-- Q10. One-line summary (convenient single-row PASS/FAIL gauge)
-- AFTER (PASS): all four counters are 0 and narrowed = true.
-- ────────────────────────────────────────────────────────────────────
SELECT
  (SELECT count(*) FROM information_schema.role_table_grants
    WHERE grantee='anon' AND table_schema='public'
      AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
      AND table_name IN ('restaurants','payments','subscriptions',
        'staff_payroll_adjustments','waiter_debts','employee_shifts',
        'kitchen_stations','platform_config','calendar_events',
        'restaurant_settings','subscription_plans','plan_addons',
        'restaurant_addons','delivery_riders','delivery_zones'))      AS anon_write_grants_left,   -- 0
  (SELECT count(*) FROM pg_policies WHERE schemaname='public'
      -- only count them while still OPEN: 103 §10 recreates
      -- platform_config_write under the same name, superadmin-scoped
      AND (qual = 'true' OR with_check = 'true')
      AND policyname IN ('sa_restaurants_all','admin_update_restaurant',
        'sa_payments_all','sa_events_all','sa_plans_all',
        'sa_plan_addons_all','sa_restaurant_addons_all',
        'staff_payroll_adjustments_all','waiter_debts_all',
        'employee_shifts_all','ks_all','ksc_all','ksz_all','oisl_all',
        'delivery_riders_all','delivery_zones_admin','suppliers_all',
        'supplier_contacts_all','supplier_purchases_all','shift_logs_all',
        'manager_approvals_all','item_86_list_all','support_tickets_all',
        'support_messages_all','staff_sessions_all','staff_broadcasts_all',
        'staff_requests_all','expenses_all','auth_all_ingredients',
        'auth_all_recipes','auth_all_stock_movements','auth_all_stock_alerts',
        'auth_all_avail_log','auth_all_stock_sessions',
        'auth_all_stock_session_items','profiles_select',
        'platform_config_write','read_restaurant_settings',
        'admin_restaurant_settings'))                                  AS open_policies_left,       -- 0
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN
      ('superadmin_reset_operation_data','superadmin_seed_simulated_environment')) AS dev_rpcs_left, -- 0
  (SELECT CASE WHEN has_function_privilege('anon',
      'public.get_user_email(text)'::regprocedure, 'EXECUTE')
    THEN 1 ELSE 0 END)                                                 AS anon_get_user_email,      -- 0
  (SELECT count(*) FROM pg_policies
    WHERE schemaname='public' AND tablename='delivery_orders'
      AND policyname='dord_anon_update')                               AS dord_anon_update_left,    -- 0
  (SELECT count(*) FROM information_schema.role_table_grants
    WHERE grantee='anon' AND table_schema='public'
      AND table_name='reservations'
      AND privilege_type IN ('SELECT','UPDATE','DELETE','TRUNCATE'))   AS anon_reservations_extra,  -- 0 (INSERT only)
  (SELECT count(*) FROM information_schema.role_table_grants
    WHERE grantee='anon' AND table_schema='public'
      AND table_name='delivery_orders' AND privilege_type='UPDATE')    AS anon_dord_update_grant;   -- 0
