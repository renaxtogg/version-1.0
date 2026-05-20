-- Migración 048: agregar columna active a delivery_riders si no existe
-- El CREATE TABLE IF NOT EXISTS de 035 no la agrega si la tabla ya existía antes

ALTER TABLE delivery_riders
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

-- Índice si aún no existe
CREATE INDEX IF NOT EXISTS idx_delivery_riders_active ON delivery_riders(active);

-- También agregar lat/lng a restaurants por si la migración 047 no se ejecutó
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;

UPDATE restaurants
  SET lat = -25.2867, lng = -57.6470
  WHERE id = '00000000-0000-0000-0000-000000000001'
    AND (lat IS NULL OR lat = 0);
