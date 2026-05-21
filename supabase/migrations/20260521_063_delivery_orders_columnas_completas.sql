-- Migración 063: agregar TODAS las columnas que delivery_orders necesita
-- Idempotente — IF NOT EXISTS en cada ALTER. Corre aunque 030-062 ya estén aplicadas.

ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS restaurant_id       UUID;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS order_type          TEXT        NOT NULL DEFAULT 'delivery';
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS order_number        TEXT;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS order_total         INTEGER     DEFAULT 0;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS customer_name       TEXT;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS customer_phone      TEXT;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS delivery_address    TEXT;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS delivery_detail     TEXT;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS delivery_references TEXT;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS zone_id             UUID;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS zone_name           TEXT;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS delivery_fee        INTEGER     DEFAULT 0;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS estimated_minutes   INTEGER;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS canal               TEXT        DEFAULT 'web';
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS status              TEXT        NOT NULL DEFAULT 'pending';
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS rider_id            UUID;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS rider_name          TEXT;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS assigned_at         TIMESTAMPTZ;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS picked_up_at        TIMESTAMPTZ;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS delivered_at        TIMESTAMPTZ;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS delivery_notes      TEXT;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS channel             TEXT        DEFAULT 'propio';
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS channel_commission  INTEGER     DEFAULT 0;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS delivery_pin        TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'delivery_orders' AND column_name = 'rider_status'
  ) THEN
    ALTER TABLE delivery_orders ADD COLUMN rider_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (rider_status IN ('pending','confirmed','picked_up','on_way','delivered','cancelled'));
  END IF;
END $$;

-- FK correcta: rider_id → delivery_riders (no auth.users)
ALTER TABLE delivery_orders DROP CONSTRAINT IF EXISTS delivery_orders_rider_id_fkey;
ALTER TABLE delivery_orders
  ADD CONSTRAINT delivery_orders_rider_id_fkey
  FOREIGN KEY (rider_id) REFERENCES delivery_riders(id) ON DELETE SET NULL;

NOTIFY pgrst, 'reload schema';

-- Verificación
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'delivery_orders'
ORDER BY ordinal_position;
