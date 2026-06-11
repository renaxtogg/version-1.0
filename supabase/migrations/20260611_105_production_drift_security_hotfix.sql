-- ════════════════════════════════════════════════════════════════════
-- 105 · PRODUCTION DRIFT SECURITY HOTFIX — Sprint 1B (PREPARED — DO
--       NOT APPLY UNTIL THE ARCHITECT GIVES THE APPLY ORDER)
-- ────────────────────────────────────────────────────────────────────
-- Closes the drift found by the post-apply verification of 103/104
-- (2026-06-11). These objects exist in production with names/state the
-- repo migrations never created, so 103/104 could not target them:
--
--   1. `delivery_channels` — PHANTOM table (no CREATE TABLE in any
--      migration; flagged in MYTHOS_SYSTEM_REPORT §tablas-fantasma).
--      anon holds FULL grants + `public_all_channels FOR ALL
--      USING(true)` → anonymous read/write/delete of every tenant's
--      channels (commission_pct included).
--   2. Drift policies `public_all_riders` / `public_read_riders` /
--      `public_all_zones` / `public_read_zones` (FOR ALL / SELECT,
--      USING(true), TO public) — they OR around the tenant-scoped
--      policies 103 created, leaving cross-tenant access for any
--      authenticated user (anon writes were already cut by grants).
--   3. SECURITY DEFINER RPCs callable by anon (functions default
--      EXECUTE to PUBLIC). Three have NO internal role guard:
--      admin_load_stock / admin_set_item_availability /
--      admin_complete_stock_session → anon could mutate stock and menu
--      availability cross-tenant with the public key.
--   4. Residual anon TRUNCATE/REFERENCES/TRIGGER grants on 23 tables
--      (legacy blanket GRANT ALL) — not reachable via PostgREST, but
--      dead privilege mass that keeps tripping audits.
--
-- Frontend facts verified by grep on 2026-06-11:
--   * NO panel (public or staff) queries `delivery_channels` — zero
--     hits in public/ and api/. Lockdown has no UI impact.
--   * delivery-cliente.html (anon) reads delivery_zones with
--     .eq('is_active', true) and benign columns (lines 160-164) →
--     the narrow anon SELECT policy below preserves that flow 1:1.
--   * /api/create-user uses the Auth Admin REST API with service_role
--     (raw HTTPS, no RPC). `admin_create_user` and
--     `admin_set_item_availability` are called by NO panel → they
--     drop to service_role-only (they keep existing; Sprint 2 decides
--     their future).
--
-- Helpers used (must exist): get_my_role() [029],
-- get_my_company_restaurant_ids() [092].
-- Idempotent: safe to re-run. Phantom objects are guarded with
-- to_regclass / to_regprocedure so the file also runs on fresh
-- environments built only from migrations.
-- Run docs/security/RLS_SPRINT_1_VERIFICATION.sql (incl. the new
-- Sprint 1B section) before and after.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- 1. DELIVERY_CHANNELS — full anon lockdown; tenant-scoped staff access
--    Schema found in prod: id uuid, restaurant_id uuid, name text,
--    commission_pct numeric, color text, is_active boolean.
--    No public read is required (no anon panel touches it) → anon
--    loses SELECT too. Security over availability, zero expected
--    degradation.
-- ════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regclass('public.delivery_channels') IS NULL THEN
    RAISE NOTICE 'delivery_channels does not exist - skipping section 1 (phantom prod-only table)';
    RETURN;
  END IF;

  REVOKE ALL ON public.delivery_channels FROM anon;

  DROP POLICY IF EXISTS "public_all_channels"    ON public.delivery_channels; -- FOR ALL USING(true)
  DROP POLICY IF EXISTS "public_read_channels"   ON public.delivery_channels; -- SELECT USING(true)
  DROP POLICY IF EXISTS "delivery_channels_auth" ON public.delivery_channels;
  CREATE POLICY "delivery_channels_auth" ON public.delivery_channels
    FOR ALL TO authenticated
    USING (
      public.get_my_role() = 'superadmin'
      OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
    WITH CHECK (
      public.get_my_role() = 'superadmin'
      OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    );
END $$;

-- ════════════════════════════════════════════════════════════════════
-- 2. DELIVERY_RIDERS / DELIVERY_ZONES — drop the USING(true) drift
--    policies that OR around the tenant scoping created in 103.
-- ════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "public_all_riders"  ON public.delivery_riders; -- FOR ALL USING(true), drift
DROP POLICY IF EXISTS "public_read_riders" ON public.delivery_riders; -- SELECT USING(true), drift
-- Effective access after this (all created/kept by 103, verified live):
--   delivery_riders_anon_select  (SELECT TO anon, active=true,
--                                 column-limited grant: no phone/commission)
--   delivery_riders_auth_all     (tenant-scoped, superadmin OR company ids)
--   delivery_riders_superadmin_all
-- anon write grants were revoked in 103 §5 and are NOT re-granted here.

DROP POLICY IF EXISTS "public_all_zones"  ON public.delivery_zones; -- FOR ALL USING(true), drift
DROP POLICY IF EXISTS "public_read_zones" ON public.delivery_zones; -- SELECT USING(true), drift
-- 103 §6 assumed the open read policy was named "delivery_zones_read";
-- the real prod name is public_read_zones (dropped above). The anon
-- coverage check in delivery-cliente.html still needs zone reads, so
-- recreate it NARROW instead of USING(true): active zones only.
DROP POLICY IF EXISTS "delivery_zones_anon_select" ON public.delivery_zones;
CREATE POLICY "delivery_zones_anon_select" ON public.delivery_zones
  FOR SELECT TO anon
  USING (is_active = true);
-- delivery_zones_auth_all / delivery_zones_superadmin_all (103) remain
-- the staff path. anon write grants were revoked in 103 §6.

-- ════════════════════════════════════════════════════════════════════
-- 3. RPC EXECUTE LOCKDOWN — admin_* family loses anon/PUBLIC EXECUTE.
--    Exact signatures taken from pg_get_function_identity_arguments
--    in production (2026-06-11). Guarded: missing functions are
--    skipped with a NOTICE (fresh envs / future cleanups).
--    Panel usage verified by grep:
--      admin.html      → admin_list_restaurant_users, admin_update_user_role,
--                        admin_list_ingredients, admin_load_stock,
--                        admin_create_stock_session, admin_complete_stock_session
--      superadmin.html → admin_list_users, admin_update_user_role,
--                        admin_toggle_user
--      (no panel)      → admin_create_user, admin_set_item_availability
--    The two unused ones become service_role-only: they are SECURITY
--    DEFINER (admin_set_item_availability has NO internal guard) and
--    nothing legitimate calls them with a user token.
-- ════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  fn text;
  -- Used by staff panels → authenticated keeps EXECUTE (service_role too)
  fns_panel CONSTANT text[] := ARRAY[
    'public.admin_complete_stock_session(uuid, jsonb)',
    'public.admin_create_stock_session(uuid, text, text)',
    'public.admin_list_ingredients(uuid)',
    'public.admin_list_restaurant_users(uuid)',
    'public.admin_list_users()',
    'public.admin_load_stock(uuid, numeric, public.stock_unit, date, text, numeric, text)',
    'public.admin_toggle_user(uuid, boolean)',
    'public.admin_update_user_role(uuid, text, uuid, text)'
  ];
  -- Called by NO panel (verified by grep) → service_role only
  fns_backend_only CONSTANT text[] := ARRAY[
    'public.admin_create_user(text, text, text, text, uuid, text)',
    'public.admin_set_item_availability(integer, boolean, text)'
  ];
BEGIN
  FOREACH fn IN ARRAY fns_panel LOOP
    IF to_regprocedure(fn) IS NULL THEN
      RAISE NOTICE 'function % not found - skipping', fn;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
  END LOOP;

  FOREACH fn IN ARRAY fns_backend_only LOOP
    IF to_regprocedure(fn) IS NULL THEN
      RAISE NOTICE 'function % not found - skipping', fn;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;
-- NOT touched here (intended public QR/delivery surface, Sprint 2):
-- join_table_session, get_table_upcoming_reservation,
-- get_restaurant_capabilities, check_menu_item_availability.
-- KNOWN RESIDUAL (Sprint 2): admin_load_stock and
-- admin_complete_stock_session are SECURITY DEFINER without an internal
-- role guard; any authenticated user can still call them cross-tenant.
-- Fixing that requires editing function bodies (out of Sprint 1B scope).

-- ════════════════════════════════════════════════════════════════════
-- 4. RESIDUAL anon GRANTS — schema-wide sweep.
--    TRUNCATE/REFERENCES/TRIGGER are never used by PostgREST clients;
--    the verification found them left on 23 tables (incl.
--    delivery_orders and reservations) from legacy GRANT ALL. The
--    sweep removes the privilege class everywhere without touching
--    SELECT/INSERT (the intended anon surface is unchanged).
-- ════════════════════════════════════════════════════════════════════
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon;

COMMIT;

-- Reload PostgREST's schema cache so privilege changes take effect
NOTIFY pgrst, 'reload schema';

SELECT 'migration 105 applied — production drift security hotfix' AS status;
