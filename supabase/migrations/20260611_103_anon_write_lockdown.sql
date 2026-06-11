-- ════════════════════════════════════════════════════════════════════
-- 103 · ANON WRITE LOCKDOWN — Sprint 1A (PREPARED — DO NOT APPLY
--       UNTIL A DATABASE BACKUP IS CONFIRMED)
-- ────────────────────────────────────────────────────────────────────
-- Closes the CRITICAL holes confirmed in production on 2026-06-11
-- (MYTHOS_PRESPRINT_REPORT.md §2):
--   * anon holds INSERT/UPDATE/DELETE/TRUNCATE on `restaurants` and the
--     open policies `sa_restaurants_all` / `admin_update_restaurant`
--     are still active → anonymous tenant edit/deletion.
--   * anon has full read/write on `payments` and
--     `staff_payroll_adjustments` (+ SELECT on waiter_debts /
--     employee_shifts granted in mig 056).
--   * `GRANT ALL TO anon` on the 4 kitchen-station tables (mig 069).
--   * `dord_anon_update USING(true)` lets anon mutate any
--     delivery_order cross-tenant.
--   * `get_user_email` executable by anon (username enumeration).
--   * destructive dev RPCs from mig 068 still deployed (hardcode the
--     UUID …0001 deleted by the 096 factory reset).
--
-- Deliberately PRESERVED (Sprint 2 will redesign via SECURITY DEFINER
-- RPCs — do not break the QR/delivery client today):
--   * anon SELECT/INSERT on orders / order_items / order_item_extras /
--     order_status_history (QR + delivery ordering).
--   * anon SELECT on restaurants/tables/menu_* (column-limited by 102),
--     delivery_zones (coverage check), coupons (code redemption).
--   * anon INSERT on reservations (narrowed to status='pending' — §12).
--
-- Sprint 1A.1 (architect corrections):
--   * anon UPDATE on delivery_orders is fully REMOVED (no narrowing) —
--     accepted temporary degradation: instant rider auto-assign from
--     the delivery client stops; cocina assigns at kitchen-ready (§9).
--   * reservations covered: anon cross-tenant SELECT (PII) removed,
--     INSERT narrowed, authenticated tenant-scoped (§12).
--   * restaurants UPDATE restricted to admin/owner (not gerente).
--
-- Helpers used (must exist): get_my_role() [029],
-- get_my_company_restaurant_ids() [092].
-- Run docs/security/RLS_SPRINT_1_VERIFICATION.sql before and after.
-- Idempotent: safe to re-run (DROP IF EXISTS + CREATE).
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- 1. RESTAURANTS — anon loses every write; writes become role-scoped
-- ════════════════════════════════════════════════════════════════════
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.restaurants FROM anon;
-- (anon keeps the column-limited SELECT granted in mig 102 — the QR
--  client reads branding/hours of its own restaurant.)

DROP POLICY IF EXISTS "sa_restaurants_all"      ON public.restaurants; -- FOR ALL USING(true), mig 004
DROP POLICY IF EXISTS "admin_update_restaurant" ON public.restaurants; -- FOR UPDATE USING(true), mig 010
DROP POLICY IF EXISTS "update_restaurant"       ON public.restaurants; -- defensive: mig 003 variant
-- Kept: "read_restaurants" (SELECT, is_active=true) and
-- "admin_read_restaurants" (SELECT) — read paths for client + staff.

DROP POLICY IF EXISTS "restaurants_superadmin_all" ON public.restaurants;
CREATE POLICY "restaurants_superadmin_all" ON public.restaurants
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- Only admin/owner may update their own company restaurants (admin.html
-- Config / horarios / lat-lng — verified by grep: no other panel updates
-- restaurants except superadmin.html). gerente/supervisor_local does NOT
-- get UPDATE (Sprint 1A.1 architect decision): gerente.html never writes
-- restaurants; if a supervisor opens admin.html→Config, saving restaurant
-- fields will fail with 0 rows — documented in the manual test plan.
DROP POLICY IF EXISTS "restaurants_update_own" ON public.restaurants;
CREATE POLICY "restaurants_update_own" ON public.restaurants
  FOR UPDATE TO authenticated
  USING (
    public.get_my_role() IN ('admin','owner')
    AND id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() IN ('admin','owner')
    AND id IN (SELECT public.get_my_company_restaurant_ids())
  );
-- INSERT/DELETE: no policy for non-superadmin → denied.

-- ════════════════════════════════════════════════════════════════════
-- 2. PAYMENTS (SaaS billing) — superadmin only
--    (no frontend panel reads `payments` outside superadmin — verified
--     by grep across public/*.html on 2026-06-11)
-- ════════════════════════════════════════════════════════════════════
REVOKE ALL ON public.payments FROM anon;

DROP POLICY IF EXISTS "sa_payments_all" ON public.payments; -- FOR ALL USING(true), mig 028
DROP POLICY IF EXISTS "payments_superadmin_all" ON public.payments;
CREATE POLICY "payments_superadmin_all" ON public.payments
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- ── subscriptions: capture the 2026-06-08 out-of-band hotfix in the
--    repo (APLICAR_seguridad.sql rescoped sa_subs_all to superadmin).
--    Re-asserting it here makes migrations the source of truth.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.subscriptions FROM anon;
DROP POLICY IF EXISTS "sa_subs_all" ON public.subscriptions;
CREATE POLICY "sa_subs_all" ON public.subscriptions
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- ════════════════════════════════════════════════════════════════════
-- 3. PAYROLL / DEBTS / SHIFTS — no anon access; tenant-scoped staff
-- ════════════════════════════════════════════════════════════════════
REVOKE ALL ON public.staff_payroll_adjustments FROM anon;
REVOKE ALL ON public.waiter_debts              FROM anon;
REVOKE ALL ON public.employee_shifts           FROM anon;

DROP POLICY IF EXISTS "staff_payroll_adjustments_all" ON public.staff_payroll_adjustments; -- mig 056
DROP POLICY IF EXISTS "staff_payroll_adjustments_auth" ON public.staff_payroll_adjustments;
CREATE POLICY "staff_payroll_adjustments_auth" ON public.staff_payroll_adjustments
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

DROP POLICY IF EXISTS "waiter_debts_all"  ON public.waiter_debts; -- mig 056
DROP POLICY IF EXISTS "waiter_debts_auth" ON public.waiter_debts;
CREATE POLICY "waiter_debts_auth" ON public.waiter_debts
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

DROP POLICY IF EXISTS "employee_shifts_all"  ON public.employee_shifts; -- migs 033 + 056 (same name)
DROP POLICY IF EXISTS "employee_shifts_auth" ON public.employee_shifts;
CREATE POLICY "employee_shifts_auth" ON public.employee_shifts
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

-- ════════════════════════════════════════════════════════════════════
-- 4. KITCHEN STATIONS (mig 069 granted ALL to anon) — staff only,
--    tenant-scoped. The KDS station link (?station=<token>) is opened
--    inside cocina.html, which requires an authenticated session.
-- ════════════════════════════════════════════════════════════════════
REVOKE ALL ON public.kitchen_stations           FROM anon;
REVOKE ALL ON public.kitchen_station_categories FROM anon;
REVOKE ALL ON public.kitchen_station_zonas      FROM anon;
REVOKE ALL ON public.order_item_station_log     FROM anon;
REVOKE ALL ON public.kitchen_station_stats      FROM anon; -- view

DROP POLICY IF EXISTS "ks_all"      ON public.kitchen_stations;
DROP POLICY IF EXISTS "ks_auth_all" ON public.kitchen_stations;
CREATE POLICY "ks_auth_all" ON public.kitchen_stations
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

DROP POLICY IF EXISTS "ksc_all"      ON public.kitchen_station_categories;
DROP POLICY IF EXISTS "ksc_auth_all" ON public.kitchen_station_categories;
CREATE POLICY "ksc_auth_all" ON public.kitchen_station_categories
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.kitchen_stations ks
      WHERE ks.id = station_id
        AND ks.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.kitchen_stations ks
      WHERE ks.id = station_id
        AND ks.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  );

DROP POLICY IF EXISTS "ksz_all"      ON public.kitchen_station_zonas;
DROP POLICY IF EXISTS "ksz_auth_all" ON public.kitchen_station_zonas;
CREATE POLICY "ksz_auth_all" ON public.kitchen_station_zonas
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.kitchen_stations ks
      WHERE ks.id = station_id
        AND ks.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.kitchen_stations ks
      WHERE ks.id = station_id
        AND ks.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  );

DROP POLICY IF EXISTS "oisl_all"      ON public.order_item_station_log;
DROP POLICY IF EXISTS "oisl_auth_all" ON public.order_item_station_log;
CREATE POLICY "oisl_auth_all" ON public.order_item_station_log
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      WHERE oi.id = order_item_id
        AND o.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      WHERE oi.id = order_item_id
        AND o.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  );

-- ════════════════════════════════════════════════════════════════════
-- 5. DELIVERY_RIDERS — anon keeps a COLUMN-LIMITED SELECT only
--    (delivery-cliente.html shows the assigned rider's name and runs
--     the round-robin query: id/name + filters on restaurant_id,
--     active, current_status). PII (phone) and pay (commission_*)
--     become staff-only.
-- ════════════════════════════════════════════════════════════════════
REVOKE ALL ON public.delivery_riders FROM anon;
GRANT SELECT (id, restaurant_id, name, vehicle, current_status, active, photo_url)
  ON public.delivery_riders TO anon;

DROP POLICY IF EXISTS "delivery_riders_all"         ON public.delivery_riders; -- migs 035/062, USING(true)
DROP POLICY IF EXISTS "delivery_riders_anon_select" ON public.delivery_riders;
CREATE POLICY "delivery_riders_anon_select" ON public.delivery_riders
  FOR SELECT TO anon
  USING (active = true);

DROP POLICY IF EXISTS "delivery_riders_auth_all" ON public.delivery_riders;
CREATE POLICY "delivery_riders_auth_all" ON public.delivery_riders
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

-- ════════════════════════════════════════════════════════════════════
-- 6. DELIVERY_ZONES — anon read stays (coverage check); writes scoped
-- ════════════════════════════════════════════════════════════════════
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.delivery_zones FROM anon;

DROP POLICY IF EXISTS "delivery_zones_admin"    ON public.delivery_zones; -- FOR ALL USING(true), mig 030
DROP POLICY IF EXISTS "delivery_zones_auth_all" ON public.delivery_zones;
CREATE POLICY "delivery_zones_auth_all" ON public.delivery_zones
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );
-- Kept: "delivery_zones_read" (SELECT USING true) — anon coverage check.

-- ════════════════════════════════════════════════════════════════════
-- 7. RESTAURANT_SETTINGS — staff only, tenant-scoped (no anon panel
--    reads it; the QR availability check uses a SECURITY DEFINER RPC)
-- ════════════════════════════════════════════════════════════════════
REVOKE ALL ON public.restaurant_settings FROM anon;

DROP POLICY IF EXISTS "read_restaurant_settings"  ON public.restaurant_settings; -- mig 037
DROP POLICY IF EXISTS "admin_restaurant_settings" ON public.restaurant_settings; -- mig 037
DROP POLICY IF EXISTS "restaurant_settings_auth"  ON public.restaurant_settings;
CREATE POLICY "restaurant_settings_auth" ON public.restaurant_settings
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

-- ════════════════════════════════════════════════════════════════════
-- 8. CALENDAR_EVENTS — staff only; globals readable by all staff,
--    writable only by superadmin
-- ════════════════════════════════════════════════════════════════════
REVOKE ALL ON public.calendar_events FROM anon;

DROP POLICY IF EXISTS "calendar_events_read"   ON public.calendar_events; -- mig 080, USING(true)
DROP POLICY IF EXISTS "calendar_events_insert" ON public.calendar_events;
DROP POLICY IF EXISTS "calendar_events_update" ON public.calendar_events;
DROP POLICY IF EXISTS "calendar_events_delete" ON public.calendar_events;

DROP POLICY IF EXISTS "ce_auth_select" ON public.calendar_events;
CREATE POLICY "ce_auth_select" ON public.calendar_events
  FOR SELECT TO authenticated
  USING (
    is_global = true
    OR public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

DROP POLICY IF EXISTS "ce_auth_insert" ON public.calendar_events;
CREATE POLICY "ce_auth_insert" ON public.calendar_events
  FOR INSERT TO authenticated
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR (COALESCE(is_global, false) = false
        AND restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  );

DROP POLICY IF EXISTS "ce_auth_update" ON public.calendar_events;
CREATE POLICY "ce_auth_update" ON public.calendar_events
  FOR UPDATE TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR (COALESCE(is_global, false) = false
        AND restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR (COALESCE(is_global, false) = false
        AND restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  );

DROP POLICY IF EXISTS "ce_auth_delete" ON public.calendar_events;
CREATE POLICY "ce_auth_delete" ON public.calendar_events
  FOR DELETE TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR (COALESCE(is_global, false) = false
        AND restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  );

-- ════════════════════════════════════════════════════════════════════
-- 9. DELIVERY_ORDERS — anon UPDATE fully REMOVED (Sprint 1A.1
--    architect decision: no cross-tenant mutation surface, narrowed
--    or otherwise). No anon UPDATE policy is recreated.
--    EXPECTED TEMPORARY DEGRADATION: delivery-cliente.html currently
--    auto-assigns the rider from the anon session right after creating
--    the order (dbAutoAssignRider); that UPDATE will now fail (the call
--    is wrapped in try/catch and only logs to console — order creation
--    is unaffected). The rider is assigned by the authenticated path
--    instead: cocina.html runs the same round-robin assignment when it
--    marks the delivery ready (verified at cocina.html:484+), or staff
--    assigns manually. Instant assignment returns with the Sprint 2
--    SECURITY DEFINER RPC.
-- ════════════════════════════════════════════════════════════════════
REVOKE UPDATE ON public.delivery_orders FROM anon;
DROP POLICY IF EXISTS "dord_anon_update" ON public.delivery_orders; -- USING(true), mig 102
-- anon keeps: column-limited SELECT (mig 102) for tracking, and
-- dord_anon_insert for order creation. Nothing else.

-- ════════════════════════════════════════════════════════════════════
-- 10. PLATFORM_CONFIG — read stays public (global maintenance banner
--     may render pre-login); WRITE becomes superadmin-only
-- ════════════════════════════════════════════════════════════════════
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.platform_config FROM anon;

DROP POLICY IF EXISTS "platform_config_write" ON public.platform_config; -- FOR ALL USING(true), mig 031
CREATE POLICY "platform_config_write" ON public.platform_config
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');
-- Kept: "platform_config_read" (SELECT USING true).

-- ════════════════════════════════════════════════════════════════════
-- 11. PLAN MASTER DATA — anon fully out (no public pricing page today;
--     gating uses the SECURITY DEFINER RPC get_restaurant_capabilities);
--     staff may read; only superadmin writes
-- ════════════════════════════════════════════════════════════════════
REVOKE ALL ON public.subscription_plans FROM anon;
REVOKE ALL ON public.plan_addons        FROM anon;
REVOKE ALL ON public.restaurant_addons  FROM anon;

DROP POLICY IF EXISTS "sa_plans_all" ON public.subscription_plans; -- mig 004
DROP POLICY IF EXISTS "plans_auth_select" ON public.subscription_plans;
CREATE POLICY "plans_auth_select" ON public.subscription_plans
  FOR SELECT TO authenticated
  USING (true);  -- catalog: admin.html shows plan names/limits
DROP POLICY IF EXISTS "plans_superadmin_all" ON public.subscription_plans;
CREATE POLICY "plans_superadmin_all" ON public.subscription_plans
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

DROP POLICY IF EXISTS "sa_plan_addons_all" ON public.plan_addons; -- mig 090
DROP POLICY IF EXISTS "plan_addons_auth_select" ON public.plan_addons;
CREATE POLICY "plan_addons_auth_select" ON public.plan_addons
  FOR SELECT TO authenticated
  USING (true);  -- catalog (prices shown in upgrade flows)
DROP POLICY IF EXISTS "plan_addons_superadmin_all" ON public.plan_addons;
CREATE POLICY "plan_addons_superadmin_all" ON public.plan_addons
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

DROP POLICY IF EXISTS "sa_restaurant_addons_all" ON public.restaurant_addons; -- mig 090
DROP POLICY IF EXISTS "restaurant_addons_auth_select" ON public.restaurant_addons;
CREATE POLICY "restaurant_addons_auth_select" ON public.restaurant_addons
  FOR SELECT TO authenticated
  USING (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));
DROP POLICY IF EXISTS "restaurant_addons_superadmin_all" ON public.restaurant_addons;
CREATE POLICY "restaurant_addons_superadmin_all" ON public.restaurant_addons
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- ── platform_events (same mig 004 family: sa_events_all USING(true)) ──
REVOKE ALL ON public.platform_events FROM anon;
DROP POLICY IF EXISTS "sa_events_all" ON public.platform_events;
DROP POLICY IF EXISTS "platform_events_superadmin_all" ON public.platform_events;
CREATE POLICY "platform_events_superadmin_all" ON public.platform_events
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');
DROP POLICY IF EXISTS "platform_events_auth_insert" ON public.platform_events;
CREATE POLICY "platform_events_auth_insert" ON public.platform_events
  FOR INSERT TO authenticated
  WITH CHECK (true);  -- any panel may append to the platform log

-- ════════════════════════════════════════════════════════════════════
-- 12. RESERVATIONS (Sprint 1A.1 architect correction)
--     State found in migs 040/041/042: RLS is ENABLED; grants: anon =
--     INSERT + SELECT, authenticated = SELECT/INSERT/UPDATE/DELETE.
--     Policies: reservations_anon_insert (WITH CHECK true),
--     reservations_anon_select (USING true → CROSS-TENANT PII LEAK:
--     customer_name + customer_phone of every restaurant readable with
--     the public key), reservations_auth_all (USING true → cross-tenant
--     staff access), reservations_superadmin_all (088, kept).
--     Public reservation creation is PRESERVED: index.html and
--     delivery-cliente.html insert with status:'pending' and never
--     chain .select() (return=minimal) → anon needs INSERT only.
-- ════════════════════════════════════════════════════════════════════
REVOKE SELECT, UPDATE, DELETE, TRUNCATE ON public.reservations FROM anon;

DROP POLICY IF EXISTS "reservations_anon_select"   ON public.reservations; -- mig 042, PII leak
DROP POLICY IF EXISTS "reservations_insert_public" ON public.reservations; -- defensive (mig 040)
DROP POLICY IF EXISTS "reservations_staff_all"     ON public.reservations; -- defensive (mig 040)

-- Anon may ONLY create pending reservations (both client panels set
-- status:'pending' explicitly; the column default is also 'pending').
DROP POLICY IF EXISTS "reservations_anon_insert" ON public.reservations;
CREATE POLICY "reservations_anon_insert" ON public.reservations
  FOR INSERT TO anon
  WITH CHECK (status = 'pending');

DROP POLICY IF EXISTS "reservations_auth_all" ON public.reservations; -- mig 042, USING(true)
DROP POLICY IF EXISTS "reservations_auth"     ON public.reservations;
CREATE POLICY "reservations_auth" ON public.reservations
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

-- ════════════════════════════════════════════════════════════════════
-- 13. RPC LOCKDOWN
-- ════════════════════════════════════════════════════════════════════
-- get_user_email(p_username TEXT) [migs 007/008] — username/email
-- enumeration via the public key. Functions default EXECUTE to PUBLIC,
-- so revoke from PUBLIC too, then re-grant to authenticated only.
REVOKE ALL ON FUNCTION public.get_user_email(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_user_email(TEXT) TO authenticated;

-- Obsolete destructive dev tools [migs 068/069b] — they hardcode the
-- factory-reset UUID …0001 and bulk-DELETE operational data.
-- Exact signatures verified in 068/069b: both take no arguments.
DROP FUNCTION IF EXISTS public.superadmin_reset_operation_data();
DROP FUNCTION IF EXISTS public.superadmin_seed_simulated_environment();
DROP FUNCTION IF EXISTS public._assert_superadmin(); -- helper used only by the two above

COMMIT;

-- Reload PostgREST's schema cache so privilege changes take effect
NOTIFY pgrst, 'reload schema';

SELECT 'migration 103 applied — anon write lockdown' AS status;
