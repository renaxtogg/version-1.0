-- Políticas RLS completas para panel Admin — idempotente (seguro re-ejecutar)
-- Cubre TODAS las operaciones CRUD que admin.html necesita.

DO $$
BEGIN

  -- ── RESTAURANTS ──────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_read_restaurants' AND tablename='restaurants') THEN
    CREATE POLICY "admin_read_restaurants" ON restaurants FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_update_restaurant' AND tablename='restaurants') THEN
    CREATE POLICY "admin_update_restaurant" ON restaurants FOR UPDATE USING (true);
  END IF;

  -- ── TABLES (mesas) ───────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_read_all_tables' AND tablename='tables') THEN
    CREATE POLICY "admin_read_all_tables" ON tables FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_insert_tables' AND tablename='tables') THEN
    CREATE POLICY "admin_insert_tables" ON tables FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_update_tables' AND tablename='tables') THEN
    CREATE POLICY "admin_update_tables" ON tables FOR UPDATE USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_delete_tables' AND tablename='tables') THEN
    CREATE POLICY "admin_delete_tables" ON tables FOR DELETE USING (true);
  END IF;

  -- ── MENU CATEGORIES ──────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_read_all_categories' AND tablename='menu_categories') THEN
    CREATE POLICY "admin_read_all_categories" ON menu_categories FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_insert_categories' AND tablename='menu_categories') THEN
    CREATE POLICY "admin_insert_categories" ON menu_categories FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_update_categories' AND tablename='menu_categories') THEN
    CREATE POLICY "admin_update_categories" ON menu_categories FOR UPDATE USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_delete_menu_categories' AND tablename='menu_categories') THEN
    CREATE POLICY "admin_delete_menu_categories" ON menu_categories FOR DELETE USING (true);
  END IF;

  -- ── MENU ITEMS ───────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_read_all_menu_items' AND tablename='menu_items') THEN
    CREATE POLICY "admin_read_all_menu_items" ON menu_items FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_insert_menu_items' AND tablename='menu_items') THEN
    CREATE POLICY "admin_insert_menu_items" ON menu_items FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_update_menu_items' AND tablename='menu_items') THEN
    CREATE POLICY "admin_update_menu_items" ON menu_items FOR UPDATE USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_delete_menu_items' AND tablename='menu_items') THEN
    CREATE POLICY "admin_delete_menu_items" ON menu_items FOR DELETE USING (true);
  END IF;

  -- ── MENU ITEM EXTRAS ─────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_insert_extras' AND tablename='menu_item_extras') THEN
    CREATE POLICY "admin_insert_extras" ON menu_item_extras FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_update_extras' AND tablename='menu_item_extras') THEN
    CREATE POLICY "admin_update_extras" ON menu_item_extras FOR UPDATE USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_delete_extras' AND tablename='menu_item_extras') THEN
    CREATE POLICY "admin_delete_extras" ON menu_item_extras FOR DELETE USING (true);
  END IF;

  -- ── COUPONS ──────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_read_coupons' AND tablename='coupons') THEN
    CREATE POLICY "admin_read_coupons" ON coupons FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_insert_coupons' AND tablename='coupons') THEN
    CREATE POLICY "admin_insert_coupons" ON coupons FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_update_coupons' AND tablename='coupons') THEN
    CREATE POLICY "admin_update_coupons" ON coupons FOR UPDATE USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_delete_coupons' AND tablename='coupons') THEN
    CREATE POLICY "admin_delete_coupons" ON coupons FOR DELETE USING (true);
  END IF;

END $$;
