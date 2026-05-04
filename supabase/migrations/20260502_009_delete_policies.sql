-- Políticas RLS faltantes para operaciones admin
-- Sin estas, Supabase devuelve {error:null, data:[]} y el panel mostraba
-- toast de éxito falso aunque el registro no se modificó/eliminó.

-- MENU ITEMS — DELETE
CREATE POLICY "admin_delete_menu_items"
  ON menu_items FOR DELETE USING (true);

-- MENU CATEGORIES — DELETE
CREATE POLICY "admin_delete_menu_categories"
  ON menu_categories FOR DELETE USING (true);

-- COUPONS — DELETE
CREATE POLICY "admin_delete_coupons"
  ON coupons FOR DELETE USING (true);

-- TABLES — INSERT, UPDATE, DELETE (solo tenía SELECT)
CREATE POLICY "admin_insert_tables"
  ON tables FOR INSERT WITH CHECK (true);

CREATE POLICY "admin_update_tables"
  ON tables FOR UPDATE USING (true);

CREATE POLICY "admin_delete_tables"
  ON tables FOR DELETE USING (true);
