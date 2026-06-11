-- ════════════════════════════════════════════════════════════════════
-- 104 · AUTHENTICATED TENANT SCOPING — Sprint 1A (PREPARED — DO NOT
--       APPLY UNTIL A DATABASE BACKUP IS CONFIRMED; apply AFTER 103)
-- ────────────────────────────────────────────────────────────────────
-- Replaces the remaining `USING (true)` policies for authenticated
-- users with tenant-scoped policies (pattern of migs 086/092):
--     get_my_role() = 'superadmin'
--     OR restaurant_id IN (SELECT get_my_company_restaurant_ids())
-- The superadmin clause is explicit because
-- get_my_company_restaurant_ids() returns an EMPTY set for superadmin
-- (restaurant_id IS NULL in user_roles) — verified in mig 092.
--
-- Tables scoped here: suppliers, supplier_contacts, supplier_purchases,
-- shift_logs, manager_approvals, item_86_list, support_tickets,
-- support_messages, staff_sessions, staff_broadcasts, staff_requests,
-- expenses, ingredients, recipes, stock_movements, stock_alerts,
-- availability_log, stock_sessions, stock_session_items,
-- kitchen_messages, user_profiles, coupons (writes),
-- menu_item_extras (writes).
--
-- Already scoped elsewhere (NOT touched): orders / order_items /
-- delivery_orders / tables / menu_* (086+092+102), turnos_caja /
-- movimientos_caja / cancelaciones_caja / quejas_sugerencias (024),
-- user_roles (029), subscriptions (103), restaurants / payments /
-- payroll / stations / riders / zones / settings / calendar /
-- platform_* / plan tables (103).
--
-- Deliberately NOT touched — part of the anon QR/delivery flow,
-- redesigned in Sprint 2: waiter_calls, ratings, order_status_history,
-- order_item_extras (anon select/insert), table_scan_sessions,
-- coupons SELECT (code redemption), menu_item_extras SELECT (public
-- menu). reservations is handled in 103 §12 (Sprint 1A.1 correction).
--
-- Idempotent: safe to re-run. Run the verification SQL before/after.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- 1. GERENTE / SUPPLIER DOMAIN (mig 072 — all were USING(true))
-- ════════════════════════════════════════════════════════════════════
-- anon never needed these tables:
REVOKE ALL ON public.suppliers          FROM anon;
REVOKE ALL ON public.supplier_contacts  FROM anon;
REVOKE ALL ON public.supplier_purchases FROM anon;
REVOKE ALL ON public.shift_logs         FROM anon;
REVOKE ALL ON public.manager_approvals  FROM anon;
REVOKE ALL ON public.item_86_list       FROM anon;

DROP POLICY IF EXISTS "suppliers_all"  ON public.suppliers;
DROP POLICY IF EXISTS "suppliers_auth" ON public.suppliers;
CREATE POLICY "suppliers_auth" ON public.suppliers
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

-- supplier_contacts has no restaurant_id → scope through its supplier
DROP POLICY IF EXISTS "supplier_contacts_all"  ON public.supplier_contacts;
DROP POLICY IF EXISTS "supplier_contacts_auth" ON public.supplier_contacts;
CREATE POLICY "supplier_contacts_auth" ON public.supplier_contacts
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.suppliers s
      WHERE s.id = supplier_id
        AND s.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.suppliers s
      WHERE s.id = supplier_id
        AND s.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  );

DROP POLICY IF EXISTS "supplier_purchases_all"  ON public.supplier_purchases;
DROP POLICY IF EXISTS "supplier_purchases_auth" ON public.supplier_purchases;
CREATE POLICY "supplier_purchases_auth" ON public.supplier_purchases
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

DROP POLICY IF EXISTS "shift_logs_all"  ON public.shift_logs;
DROP POLICY IF EXISTS "shift_logs_auth" ON public.shift_logs;
CREATE POLICY "shift_logs_auth" ON public.shift_logs
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

DROP POLICY IF EXISTS "manager_approvals_all"  ON public.manager_approvals;
DROP POLICY IF EXISTS "manager_approvals_auth" ON public.manager_approvals;
CREATE POLICY "manager_approvals_auth" ON public.manager_approvals
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

DROP POLICY IF EXISTS "item_86_list_all"  ON public.item_86_list;
DROP POLICY IF EXISTS "item_86_list_auth" ON public.item_86_list;
CREATE POLICY "item_86_list_auth" ON public.item_86_list
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
-- 2. SUPPORT CHAT (mig 073 — restaurant ↔ Mythos). Restaurant side
--    sees only its own tickets; superadmin (support desk) sees all.
-- ════════════════════════════════════════════════════════════════════
REVOKE ALL ON public.support_tickets  FROM anon;
REVOKE ALL ON public.support_messages FROM anon;

DROP POLICY IF EXISTS "support_tickets_all"  ON public.support_tickets;
DROP POLICY IF EXISTS "support_tickets_auth" ON public.support_tickets;
CREATE POLICY "support_tickets_auth" ON public.support_tickets
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

-- support_messages has no restaurant_id → scope through the ticket
DROP POLICY IF EXISTS "support_messages_all"  ON public.support_messages;
DROP POLICY IF EXISTS "support_messages_auth" ON public.support_messages;
CREATE POLICY "support_messages_auth" ON public.support_messages
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.support_tickets t
      WHERE t.id = ticket_id
        AND t.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.support_tickets t
      WHERE t.id = ticket_id
        AND t.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  );

-- ════════════════════════════════════════════════════════════════════
-- 3. STAFF DOMAIN (migs 081/085b/098)
-- ════════════════════════════════════════════════════════════════════
REVOKE ALL ON public.staff_sessions   FROM anon;
REVOKE ALL ON public.staff_broadcasts FROM anon;
REVOKE ALL ON public.staff_requests   FROM anon;

DROP POLICY IF EXISTS "staff_sessions_all"  ON public.staff_sessions;
DROP POLICY IF EXISTS "staff_sessions_auth" ON public.staff_sessions;
CREATE POLICY "staff_sessions_auth" ON public.staff_sessions
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

DROP POLICY IF EXISTS "staff_broadcasts_all"  ON public.staff_broadcasts;
DROP POLICY IF EXISTS "staff_broadcasts_auth" ON public.staff_broadcasts;
CREATE POLICY "staff_broadcasts_auth" ON public.staff_broadcasts
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

DROP POLICY IF EXISTS "staff_requests_all"  ON public.staff_requests;
DROP POLICY IF EXISTS "staff_requests_auth" ON public.staff_requests;
CREATE POLICY "staff_requests_auth" ON public.staff_requests
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
-- 4. FINANZAS — EXPENSES (mig 023, FOR ALL USING(true))
-- ════════════════════════════════════════════════════════════════════
REVOKE ALL ON public.expenses FROM anon;

DROP POLICY IF EXISTS "expenses_all"  ON public.expenses;
DROP POLICY IF EXISTS "expenses_auth" ON public.expenses;
CREATE POLICY "expenses_auth" ON public.expenses
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
-- 5. STOCK / INVENTORY (migs 017/083)
--    The anon "public_read_*" policies are NOT needed by the client:
--    availability checks run through check_menu_item_availability(),
--    which is SECURITY DEFINER (verified, mig 017 line 155). No anon
--    panel queries these tables directly (verified by grep).
-- ════════════════════════════════════════════════════════════════════
REVOKE ALL ON public.ingredients         FROM anon;
REVOKE ALL ON public.recipes             FROM anon;
REVOKE ALL ON public.stock_movements     FROM anon;
REVOKE ALL ON public.stock_alerts        FROM anon;
REVOKE ALL ON public.availability_log    FROM anon;
REVOKE ALL ON public.stock_sessions      FROM anon;
REVOKE ALL ON public.stock_session_items FROM anon;

DROP POLICY IF EXISTS "public_read_ingredients" ON public.ingredients;
DROP POLICY IF EXISTS "auth_all_ingredients"    ON public.ingredients;
DROP POLICY IF EXISTS "ingredients_auth"        ON public.ingredients;
CREATE POLICY "ingredients_auth" ON public.ingredients
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

-- recipes has no restaurant_id → scope through its ingredient
DROP POLICY IF EXISTS "public_read_recipes" ON public.recipes;
DROP POLICY IF EXISTS "auth_all_recipes"    ON public.recipes;
DROP POLICY IF EXISTS "recipes_auth"        ON public.recipes;
CREATE POLICY "recipes_auth" ON public.recipes
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.ingredients i
      WHERE i.id = ingredient_id
        AND i.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.ingredients i
      WHERE i.id = ingredient_id
        AND i.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  );

DROP POLICY IF EXISTS "auth_all_stock_movements" ON public.stock_movements;
DROP POLICY IF EXISTS "stock_movements_auth"     ON public.stock_movements;
CREATE POLICY "stock_movements_auth" ON public.stock_movements
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

DROP POLICY IF EXISTS "public_read_stock_alerts" ON public.stock_alerts;
DROP POLICY IF EXISTS "auth_all_stock_alerts"    ON public.stock_alerts;
DROP POLICY IF EXISTS "stock_alerts_auth"        ON public.stock_alerts;
CREATE POLICY "stock_alerts_auth" ON public.stock_alerts
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

DROP POLICY IF EXISTS "public_read_avail_log" ON public.availability_log;
DROP POLICY IF EXISTS "auth_all_avail_log"    ON public.availability_log;
DROP POLICY IF EXISTS "availability_log_auth" ON public.availability_log;
CREATE POLICY "availability_log_auth" ON public.availability_log
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

-- stock_sessions / stock_session_items (mig 083, TO authenticated USING(true))
DROP POLICY IF EXISTS "auth_all_stock_sessions"  ON public.stock_sessions; -- exact name, mig 083
DROP POLICY IF EXISTS "stock_sessions_auth"      ON public.stock_sessions;
CREATE POLICY "stock_sessions_auth" ON public.stock_sessions
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

DROP POLICY IF EXISTS "auth_all_stock_session_items" ON public.stock_session_items; -- exact name, mig 083
DROP POLICY IF EXISTS "stock_session_items_auth"     ON public.stock_session_items;
CREATE POLICY "stock_session_items_auth" ON public.stock_session_items
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.stock_sessions ss
      WHERE ss.id = session_id
        AND ss.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.stock_sessions ss
      WHERE ss.id = session_id
        AND ss.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  );

-- ════════════════════════════════════════════════════════════════════
-- 6. KITCHEN_MESSAGES (mig 037 — read was USING(true) for everyone)
-- ════════════════════════════════════════════════════════════════════
REVOKE ALL ON public.kitchen_messages FROM anon;

DROP POLICY IF EXISTS "read_kitchen_messages"          ON public.kitchen_messages;
DROP POLICY IF EXISTS "admin_kitchen_messages_insert"  ON public.kitchen_messages;
DROP POLICY IF EXISTS "admin_kitchen_messages_update"  ON public.kitchen_messages;
DROP POLICY IF EXISTS "admin_kitchen_messages_delete"  ON public.kitchen_messages;
DROP POLICY IF EXISTS "kitchen_messages_auth"          ON public.kitchen_messages;
CREATE POLICY "kitchen_messages_auth" ON public.kitchen_messages
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
-- 7. USER_PROFILES (legacy mozo-v2 PIN table; caja reads the
--    supervisor PIN — must stay same-restaurant only)
--    PHANTOM-TABLE GUARD (2026-06-11): confirmed during the Sprint 1
--    apply that public.user_profiles does NOT exist in production
--    (mig 038 table never materialized / removed by the 096 reset).
--    Guarded so 104 applies cleanly with or without the legacy table.
-- ════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regclass('public.user_profiles') IS NULL THEN
    RAISE NOTICE 'user_profiles does not exist - skipping section 7 (phantom legacy table)';
    RETURN;
  END IF;
  REVOKE ALL ON public.user_profiles FROM anon;
  DROP POLICY IF EXISTS "profiles_select"    ON public.user_profiles; -- SELECT USING(true), mig 038
  DROP POLICY IF EXISTS "user_profiles_auth" ON public.user_profiles;
  CREATE POLICY "user_profiles_auth" ON public.user_profiles
    FOR SELECT TO authenticated
    USING (
      public.get_my_role() = 'superadmin'
      OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    );
  -- No write policies existed before and none are added (table is legacy).
END $$;

-- ════════════════════════════════════════════════════════════════════
-- 8. COUPONS — writes become tenant-scoped; the open SELECT
--    ("read_coupons", is_active=true) stays for anon code redemption.
-- ════════════════════════════════════════════════════════════════════
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.coupons FROM anon;

DROP POLICY IF EXISTS "admin_insert_coupons" ON public.coupons; -- mig 010
DROP POLICY IF EXISTS "admin_update_coupons" ON public.coupons; -- mig 010
DROP POLICY IF EXISTS "admin_delete_coupons" ON public.coupons; -- mig 010
DROP POLICY IF EXISTS "update_coupons"       ON public.coupons; -- mig 003 variant
DROP POLICY IF EXISTS "delete_coupons"       ON public.coupons; -- mig 009 variant
DROP POLICY IF EXISTS "coupons_auth_write"   ON public.coupons;
CREATE POLICY "coupons_auth_write" ON public.coupons
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );
-- Kept: "read_coupons" / "admin_read_coupons" (SELECT) — client applies codes.

-- ════════════════════════════════════════════════════════════════════
-- 9. MENU_ITEM_EXTRAS — writes scoped via the parent menu item;
--    open SELECT ("read_menu_extras") stays for the public menu.
--    (086 hardened menu_items/categories but skipped extras.)
-- ════════════════════════════════════════════════════════════════════
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.menu_item_extras FROM anon;

DROP POLICY IF EXISTS "admin_insert_extras" ON public.menu_item_extras; -- mig 010
DROP POLICY IF EXISTS "admin_update_extras" ON public.menu_item_extras; -- migs 003/010
DROP POLICY IF EXISTS "admin_delete_extras" ON public.menu_item_extras; -- migs 003/010
DROP POLICY IF EXISTS "update_menu_extras"  ON public.menu_item_extras; -- mig 003 variant
DROP POLICY IF EXISTS "delete_menu_extras"  ON public.menu_item_extras; -- mig 009 variant
DROP POLICY IF EXISTS "extras_auth_write"   ON public.menu_item_extras;
CREATE POLICY "extras_auth_write" ON public.menu_item_extras
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.menu_items mi
      WHERE mi.id = item_id
        AND mi.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.menu_items mi
      WHERE mi.id = item_id
        AND mi.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  );
-- Kept: "read_menu_extras" (SELECT USING true) — public menu rendering.

COMMIT;

-- Reload PostgREST's schema cache
NOTIFY pgrst, 'reload schema';

SELECT 'migration 104 applied — authenticated tenant scoping' AS status;
