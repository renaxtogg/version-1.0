-- Add kitchen_station to menu_categories for split-view mode in KDS
ALTER TABLE menu_categories
  ADD COLUMN IF NOT EXISTS kitchen_station TEXT DEFAULT 'hot'
  CHECK (kitchen_station IN ('hot', 'cold', 'bar'));

COMMENT ON COLUMN menu_categories.kitchen_station IS 'KDS split view: hot=cocina caliente, cold=cocina fría, bar=barra';
