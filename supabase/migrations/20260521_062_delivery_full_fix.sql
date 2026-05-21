-- Migración 062: fix completo e idempotente del flujo delivery
-- Cubre: columnas faltantes, FK correcta, riders activos, seed si vacío.
-- Segura para ejecutar aunque 030-061 ya estén aplicadas.

-- ── 1. COLUMNAS delivery_orders ──────────────────────────────────────
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS order_total        INTEGER     DEFAULT 0;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS order_number       TEXT;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS channel            TEXT        DEFAULT 'propio';
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS channel_commission INTEGER     DEFAULT 0;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS delivery_notes     TEXT;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS delivery_pin       TEXT;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS assigned_at        TIMESTAMPTZ;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS picked_up_at       TIMESTAMPTZ;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS delivered_at       TIMESTAMPTZ;

-- rider_status: si no existe la columna se crea; si existe pero sin CHECK no hay conflicto
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'delivery_orders' AND column_name = 'rider_status'
  ) THEN
    ALTER TABLE delivery_orders
      ADD COLUMN rider_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (rider_status IN ('pending','confirmed','picked_up','on_way','delivered','cancelled'));
  END IF;
END $$;

-- ── 2. COLUMNAS delivery_riders ───────────────────────────────────────
ALTER TABLE delivery_riders ADD COLUMN IF NOT EXISTS active        BOOLEAN      NOT NULL DEFAULT true;
ALTER TABLE delivery_riders ADD COLUMN IF NOT EXISTS photo_url     TEXT;
ALTER TABLE delivery_riders ADD COLUMN IF NOT EXISTS rider_pin     TEXT;
ALTER TABLE delivery_riders ADD COLUMN IF NOT EXISTS current_status TEXT        NOT NULL DEFAULT 'disponible';

-- ── 3. FK rider_id → delivery_riders (no auth.users) ─────────────────
ALTER TABLE delivery_orders DROP CONSTRAINT IF EXISTS delivery_orders_rider_id_fkey;
ALTER TABLE delivery_orders
  ADD CONSTRAINT delivery_orders_rider_id_fkey
  FOREIGN KEY (rider_id) REFERENCES delivery_riders(id) ON DELETE SET NULL;

-- ── 4. ACTIVAR todos los riders de La Huaca ───────────────────────────
UPDATE delivery_riders
SET active         = true,
    current_status = 'disponible'
WHERE restaurant_id = '00000000-0000-0000-0000-000000000001';

-- ── 5. SEED riders demo si no hay ninguno activo ──────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM delivery_riders
    WHERE restaurant_id = '00000000-0000-0000-0000-000000000001'
      AND active = true
  ) THEN
    INSERT INTO delivery_riders
      (restaurant_id, name, phone, vehicle, commission_type, commission_value, current_status, active, rider_pin)
    VALUES
      ('00000000-0000-0000-0000-000000000001', 'Joel Ramírez',  '+595 981 111 111', 'moto', 'fixed', 5000, 'disponible', true, '1111'),
      ('00000000-0000-0000-0000-000000000001', 'Juan Méndez',   '+595 982 222 222', 'moto', 'fixed', 5000, 'disponible', true, '2222'),
      ('00000000-0000-0000-0000-000000000001', 'Carlos García', '+595 983 333 333', 'moto', 'fixed', 5000, 'disponible', true, '3333');
  END IF;
END $$;

-- ── 6. PINs a riders que no tienen ───────────────────────────────────
UPDATE delivery_riders
SET rider_pin = LPAD(floor(1000 + random() * 9000)::int::text, 4, '0')
WHERE rider_pin IS NULL
  AND restaurant_id = '00000000-0000-0000-0000-000000000001';

-- ── 7. RLS delivery_orders (idempotente) ─────────────────────────────
ALTER TABLE delivery_orders ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='delivery_orders' AND policyname='delivery_orders_read_restaurant') THEN
    CREATE POLICY "delivery_orders_read_restaurant" ON delivery_orders FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='delivery_orders' AND policyname='delivery_orders_insert_customer') THEN
    CREATE POLICY "delivery_orders_insert_customer" ON delivery_orders FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='delivery_orders' AND policyname='delivery_orders_update_rider') THEN
    CREATE POLICY "delivery_orders_update_rider" ON delivery_orders FOR UPDATE USING (true);
  END IF;
END $$;

-- ── 8. RLS delivery_riders (idempotente) ─────────────────────────────
ALTER TABLE delivery_riders ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='delivery_riders' AND policyname='delivery_riders_all') THEN
    CREATE POLICY "delivery_riders_all" ON delivery_riders USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ── 9. Recargar schema cache ──────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- ── Verificación final ────────────────────────────────────────────────
SELECT
  (SELECT COUNT(*) FROM delivery_riders WHERE restaurant_id='00000000-0000-0000-0000-000000000001' AND active=true)  AS riders_activos,
  (SELECT COUNT(*) FROM delivery_riders WHERE restaurant_id='00000000-0000-0000-0000-000000000001' AND rider_pin IS NOT NULL) AS riders_con_pin,
  (SELECT conname FROM pg_constraint WHERE conname='delivery_orders_rider_id_fkey') AS fk_nombre;
