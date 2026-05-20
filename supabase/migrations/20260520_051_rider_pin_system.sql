-- Migración 050: sistema de PIN para delivery riders

-- 1. Eliminar FK incorrecta: rider_id apuntaba a auth.users pero se usa delivery_riders.id
ALTER TABLE delivery_orders DROP CONSTRAINT IF EXISTS delivery_orders_rider_id_fkey;

-- 2. Agregar delivery_pin a delivery_orders (PIN de 4 dígitos que caja da al rider)
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS delivery_pin TEXT;

-- 3. Agregar rider_pin a delivery_riders (PIN de acceso del rider al panel)
ALTER TABLE delivery_riders ADD COLUMN IF NOT EXISTS rider_pin TEXT;

-- 4. Extender commission_type para incluir 'salary' (sueldo fijo mensual)
ALTER TABLE delivery_riders DROP CONSTRAINT IF EXISTS delivery_riders_commission_type_check;
ALTER TABLE delivery_riders ADD CONSTRAINT delivery_riders_commission_type_check
  CHECK (commission_type IN ('pct','fixed','salary'));

-- 5. Generar PINs de rider para los existentes que no tienen uno
UPDATE delivery_riders
SET rider_pin = LPAD(floor(1000 + random() * 9000)::int::text, 4, '0')
WHERE rider_pin IS NULL;

-- 6. Generar delivery_pin para órdenes existentes sin PIN
UPDATE delivery_orders
SET delivery_pin = LPAD(floor(1000 + random() * 9000)::int::text, 4, '0')
WHERE delivery_pin IS NULL;

-- 7. Función para auto-generar delivery_pin en INSERT de delivery_orders
CREATE OR REPLACE FUNCTION auto_delivery_pin()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.delivery_pin IS NULL OR NEW.delivery_pin = '' THEN
    NEW.delivery_pin := LPAD(floor(1000 + random() * 9000)::int::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_delivery_pin ON delivery_orders;
CREATE TRIGGER trg_auto_delivery_pin
  BEFORE INSERT ON delivery_orders
  FOR EACH ROW EXECUTE FUNCTION auto_delivery_pin();
