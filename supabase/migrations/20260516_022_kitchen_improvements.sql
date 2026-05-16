-- ============================================================
-- Mesa App v1.0 — Kitchen Improvements
-- 2026-05-16
-- - production_station en menu_items y order_items
-- - kitchen_status por ítem (para futura granularidad)
-- - Asignación de estaciones a items existentes
-- ============================================================

-- 1. Estación de producción en menu_items
ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS production_station TEXT
    CHECK (production_station IN ('cocina','parrilla','bar','cafeteria','postres'));

-- 2. Campos de cocina por ítem en order_items
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS production_station TEXT;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS kitchen_status TEXT DEFAULT 'pending'
    CHECK (kitchen_status IN ('pending','cooking','ready','delivered'));

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS ready_at TIMESTAMPTZ;

-- 3. Asignar estaciones a items existentes de La Huaca
-- Entrantes
UPDATE menu_items SET production_station = 'cocina'   WHERE id = 1;  -- Empanada de carne
UPDATE menu_items SET production_station = 'parrilla' WHERE id = 2;  -- Provoleta parrilla
UPDATE menu_items SET production_station = 'cocina'   WHERE id = 3;  -- Tabla de fiambres
UPDATE menu_items SET production_station = 'cocina'   WHERE id = 4;  -- Sopa paraguaya
-- Hamburguesas
UPDATE menu_items SET production_station = 'cocina'   WHERE id IN (5,6,7,8);
-- Lomito
UPDATE menu_items SET production_station = 'cocina'   WHERE id IN (9,10,11);
-- Bebidas
UPDATE menu_items SET production_station = 'bar'      WHERE id IN (12,13,14,15,16);

-- 4. Índices
CREATE INDEX IF NOT EXISTS idx_menu_items_station   ON menu_items(production_station);
CREATE INDEX IF NOT EXISTS idx_order_items_station  ON order_items(production_station);
CREATE INDEX IF NOT EXISTS idx_order_items_kstatus  ON order_items(kitchen_status);

-- 5. Habilitar realtime para order_items (notificaciones por ítem en el futuro)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE order_items;
EXCEPTION WHEN others THEN NULL;
END$$;

-- 6. Política de actualización de order_items para cocina
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'order_items' AND policyname = 'update_order_items'
  ) THEN
    EXECUTE 'CREATE POLICY "update_order_items" ON order_items FOR UPDATE USING (true)';
  END IF;
END$$;
