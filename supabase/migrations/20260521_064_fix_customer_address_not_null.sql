-- Migración 064: eliminar NOT NULL de customer_address
-- La tabla delivery_orders tiene customer_address NOT NULL creado directamente en Supabase
-- (sin migración local). El código inserta delivery_address, no customer_address.
-- Esta migración hace customer_address nullable para que el INSERT no falle.

ALTER TABLE delivery_orders ALTER COLUMN customer_address DROP NOT NULL;
ALTER TABLE delivery_orders ALTER COLUMN customer_address SET DEFAULT NULL;

-- Por las dudas, también garantizar que delivery_address sea nullable
-- (el código ya la usa correctamente)
ALTER TABLE delivery_orders ALTER COLUMN delivery_address DROP NOT NULL;

NOTIFY pgrst, 'reload schema';

-- Verificación
SELECT
  column_name,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_name = 'delivery_orders'
  AND column_name IN ('customer_address', 'delivery_address', 'customer_name', 'customer_phone')
ORDER BY column_name;
