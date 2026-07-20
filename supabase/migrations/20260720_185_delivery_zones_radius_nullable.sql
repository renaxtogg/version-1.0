-- Migración 185: radius_km de delivery_zones pasa a ser NULLABLE.
--
-- La UI del panel admin ("+ Agregar zona" → "RADIO (km — vacío = sin límite)")
-- y el cliente delivery ya tratan un radio vacío como "sin límite / zona
-- extendida" (banda catch-all más externa: `dist <= (z.radius_km || 999)`),
-- pero la columna estaba declarada NOT NULL desde la mig 030. Resultado: una
-- zona "sin límite" nunca podía persistirse en la DB. Este cambio alinea el
-- esquema con la intención del producto. NULL = sin límite de radio.
--
-- Cambio aditivo y reversible; no toca datos existentes ni RLS.

ALTER TABLE delivery_zones ALTER COLUMN radius_km DROP NOT NULL;

COMMENT ON COLUMN delivery_zones.radius_km IS
  'Radio de cobertura en km desde el local. NULL = sin límite (zona extendida / banda catch-all más externa).';
