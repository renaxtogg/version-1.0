-- Migración 052: asegurar todas las columnas de delivery_riders y recargar schema cache
-- La tabla pudo haber sido creada sin algunas columnas si el IF NOT EXISTS saltó un CREATE anterior

ALTER TABLE delivery_riders ADD COLUMN IF NOT EXISTS vehicle          text         NOT NULL DEFAULT 'moto';
ALTER TABLE delivery_riders ADD COLUMN IF NOT EXISTS commission_type  text         NOT NULL DEFAULT 'pct';
ALTER TABLE delivery_riders ADD COLUMN IF NOT EXISTS commission_value numeric(10,2) NOT NULL DEFAULT 0;
ALTER TABLE delivery_riders ADD COLUMN IF NOT EXISTS current_status   text         NOT NULL DEFAULT 'disponible';
ALTER TABLE delivery_riders ADD COLUMN IF NOT EXISTS photo_url        text;
ALTER TABLE delivery_riders ADD COLUMN IF NOT EXISTS rider_pin        text;

-- Asegurar check constraint con salary incluido
ALTER TABLE delivery_riders DROP CONSTRAINT IF EXISTS delivery_riders_commission_type_check;
ALTER TABLE delivery_riders ADD CONSTRAINT delivery_riders_commission_type_check
  CHECK (commission_type IN ('pct','fixed','salary'));

-- Generar PINs para riders sin uno
UPDATE delivery_riders
SET rider_pin = LPAD(floor(1000 + random() * 9000)::int::text, 4, '0')
WHERE rider_pin IS NULL;

-- Recargar cache de PostgREST para que detecte las columnas nuevas
NOTIFY pgrst, 'reload schema';
