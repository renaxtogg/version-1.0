-- ============================================================
-- Mesa App v1.0 — Políticas para panel Admin
-- Permite CRUD en menú, cupones y config desde la anon key.
-- NOTA: En producción reemplazar por políticas con auth (Fase 2).
-- ============================================================

-- Leer TODOS los items (incluyendo is_available=false)
CREATE POLICY "admin_read_all_menu_items"
  ON menu_items FOR SELECT USING (true);

-- Leer TODAS las categorías (incluyendo is_active=false)
CREATE POLICY "admin_read_all_categories"
  ON menu_categories FOR SELECT USING (true);

-- Leer TODAS las mesas (incluyendo is_active=false)
CREATE POLICY "admin_read_all_tables"
  ON tables FOR SELECT USING (true);

-- MENU CATEGORIES — CRUD
CREATE POLICY "admin_insert_categories"
  ON menu_categories FOR INSERT WITH CHECK (true);

CREATE POLICY "admin_update_categories"
  ON menu_categories FOR UPDATE USING (true);

-- MENU ITEMS — CRUD
CREATE POLICY "admin_insert_menu_items"
  ON menu_items FOR INSERT WITH CHECK (true);

CREATE POLICY "admin_update_menu_items"
  ON menu_items FOR UPDATE USING (true);

-- MENU EXTRAS — CRUD
CREATE POLICY "admin_insert_extras"
  ON menu_item_extras FOR INSERT WITH CHECK (true);

CREATE POLICY "admin_update_extras"
  ON menu_item_extras FOR UPDATE USING (true);

CREATE POLICY "admin_delete_extras"
  ON menu_item_extras FOR DELETE USING (true);

-- COUPONS — CRUD
CREATE POLICY "admin_insert_coupons"
  ON coupons FOR INSERT WITH CHECK (true);

CREATE POLICY "admin_update_coupons"
  ON coupons FOR UPDATE USING (true);

-- RESTAURANTS — UPDATE (info del local)
CREATE POLICY "admin_update_restaurant"
  ON restaurants FOR UPDATE USING (true);
