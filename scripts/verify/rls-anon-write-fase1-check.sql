-- ════════════════════════════════════════════════════════════════════
-- FASE 1 · RLS anon-write verification — focused gauge (READ-ONLY)
-- ────────────────────────────────────────────────────────────────────
-- Answers the three questions of the "Seguridad RLS" prompt directly.
-- Every statement is a SELECT against system catalogs — nothing is
-- modified. Run in the Supabase SQL Editor (dashboard in ENGLISH) or via
-- the guarded runner (_simulacion/run.ps1) with a read-only intent.
--
-- For the full Sprint-1/1B picture run docs/security/RLS_SPRINT_1_VERIFICATION.sql
-- and scripts/verify/pr18-prod-rls-verification.sql (this file is the
-- minimal subset that maps 1:1 to the prompt's three questions).
-- ════════════════════════════════════════════════════════════════════

-- ── Q1. Does `anon` still hold INSERT/UPDATE/DELETE on the 3 tables? ──
-- PASS = 0 rows.  Any row here = that hole is ABIERTO.
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'anon'
  AND table_schema = 'public'
  AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
  AND table_name IN ('restaurants','payments','staff_payroll_adjustments')
ORDER BY table_name, privilege_type;

-- ── Q2. Are the 4 named open/legacy policies still alive? ─────────────
-- PASS = 0 rows.  Any row here = that policy is still ABIERTA.
SELECT tablename, policyname, cmd, roles::text, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND policyname IN ('sa_restaurants_all','admin_update_restaurant',
                     'sa_payments_all','dord_anon_update')
ORDER BY tablename, policyname;

-- ── Q3. Are migrations 103 / 104 / 105 recorded as applied? ──────────
-- NOTE: this project applies several migrations by hand in the SQL
-- Editor, so supabase_migrations.schema_migrations may be empty or
-- incomplete and is NOT authoritative. Verification by EFFECT (Q1+Q2
-- above = 0 rows) is the source of truth. This is informational only.
SELECT version, name
FROM supabase_migrations.schema_migrations
WHERE version LIKE '%103%' OR version LIKE '%104%' OR version LIKE '%105%'
   OR name ILIKE '%anon_write_lockdown%'
   OR name ILIKE '%authenticated_tenant_scoping%'
   OR name ILIKE '%production_drift_security_hotfix%'
ORDER BY version;

-- ── One-row PASS/FAIL gauge for the three prompt questions ───────────
-- PASS = both counters 0.  (Migration tracking is informational only —
-- effect is what matters; see Q1/Q2.)
SELECT
  (SELECT count(*) FROM information_schema.role_table_grants
     WHERE grantee='anon' AND table_schema='public'
       AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
       AND table_name IN ('restaurants','payments',
                          'staff_payroll_adjustments'))        AS anon_write_grants_left,  -- expect 0
  (SELECT count(*) FROM pg_policies WHERE schemaname='public'
       AND policyname IN ('sa_restaurants_all','admin_update_restaurant',
                          'sa_payments_all','dord_anon_update'))AS open_policies_left;      -- expect 0
