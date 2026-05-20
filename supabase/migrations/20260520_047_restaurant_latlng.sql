-- Migración 047: lat/lng en restaurants para calcular zonas de delivery desde el mapa

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;

-- Coordenadas default = La Huaca, Asunción
UPDATE restaurants
  SET lat = -25.2867, lng = -57.6470
  WHERE id = '00000000-0000-0000-0000-000000000001'
    AND (lat IS NULL OR lat = 0);
