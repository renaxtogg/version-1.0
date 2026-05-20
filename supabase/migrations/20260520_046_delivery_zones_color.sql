-- Migración 046: agregar columna color a delivery_zones
-- Permite asociar cada zona con un color visual (red, orange, yellow, green)

ALTER TABLE delivery_zones
  ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT 'red'
    CHECK (color IN ('red','orange','yellow','green'));

-- Actualizar zonas existentes con colores por orden de radio (más cercana = red)
DO $$
DECLARE
  r RECORD;
  colors TEXT[] := ARRAY['red','orange','yellow','green'];
  idx INT := 1;
BEGIN
  FOR r IN
    SELECT id FROM delivery_zones
    ORDER BY restaurant_id, COALESCE(radius_km, 99999), id
  LOOP
    UPDATE delivery_zones SET color = colors[LEAST(idx, 4)] WHERE id = r.id;
    idx := idx + 1;
    IF idx > 4 THEN idx := 4; END IF;
  END LOOP;
END $$;
