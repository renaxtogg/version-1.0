-- ============================================================
-- Migración 012: Corregir secuencias SERIAL + FK menu→orders
-- ============================================================

-- ── 1. Resetear secuencias SERIAL ────────────────────────────
-- El seed insertó menu_items con IDs explícitos (1-16) sin
-- actualizar la secuencia, por eso el próximo INSERT falla
-- con "duplicate key value violates unique constraint".
SELECT setval(
  'menu_items_id_seq',
  COALESCE((SELECT MAX(id) FROM menu_items), 0)
);

SELECT setval(
  'menu_item_extras_id_seq',
  COALESCE((SELECT MAX(id) FROM menu_item_extras), 0)
);

-- ── 2. Cambiar FK order_items.item_id a ON DELETE SET NULL ───
-- Con RESTRICT no se puede eliminar un item del menú si fue
-- pedido alguna vez. Con SET NULL se elimina el link pero el
-- historial (item_name snapshot) se preserva en order_items.
ALTER TABLE order_items
  DROP CONSTRAINT IF EXISTS order_items_item_id_fkey;

ALTER TABLE order_items
  ADD CONSTRAINT order_items_item_id_fkey
  FOREIGN KEY (item_id)
  REFERENCES menu_items(id)
  ON DELETE SET NULL;
