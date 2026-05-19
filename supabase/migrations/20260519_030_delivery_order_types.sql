-- Migración 030: extiende order_type para delivery y crea tabla delivery_orders

-- 1. Ampliar el CHECK constraint de orders.order_type
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_type_check;
ALTER TABLE orders
  ADD CONSTRAINT orders_order_type_check
  CHECK (order_type IN ('local', 'llevar', 'delivery', 'pickup'));

-- 2. Crear tabla delivery_orders (pendiente de versiones anteriores)
CREATE TABLE IF NOT EXISTS delivery_orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            UUID REFERENCES orders(id) ON DELETE CASCADE,
  restaurant_id       UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  order_type          TEXT NOT NULL DEFAULT 'delivery' CHECK (order_type IN ('delivery', 'pickup')),
  customer_name       TEXT,
  customer_phone      TEXT,
  delivery_address    TEXT,
  delivery_detail     TEXT,
  delivery_references TEXT,
  zone_id             UUID,
  zone_name           TEXT,
  delivery_fee        INTEGER NOT NULL DEFAULT 0,
  estimated_minutes   INTEGER,
  canal               TEXT NOT NULL DEFAULT 'web',
  status              TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'assigned', 'picked_up', 'delivered', 'cancelled')),
  rider_id            UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  rider_name          TEXT,
  assigned_at         TIMESTAMPTZ,
  picked_up_at        TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Índices
CREATE INDEX IF NOT EXISTS idx_delivery_orders_order_id       ON delivery_orders(order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_orders_restaurant_id  ON delivery_orders(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_delivery_orders_status         ON delivery_orders(status);
CREATE INDEX IF NOT EXISTS idx_delivery_orders_rider_id       ON delivery_orders(rider_id);

-- 4. Trigger updated_at
CREATE OR REPLACE FUNCTION update_delivery_orders_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_delivery_orders_updated_at ON delivery_orders;
CREATE TRIGGER trg_delivery_orders_updated_at
  BEFORE UPDATE ON delivery_orders
  FOR EACH ROW EXECUTE FUNCTION update_delivery_orders_updated_at();

-- 5. RLS
ALTER TABLE delivery_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "delivery_orders_read_restaurant" ON delivery_orders
  FOR SELECT USING (true);

CREATE POLICY "delivery_orders_insert_customer" ON delivery_orders
  FOR INSERT WITH CHECK (true);

CREATE POLICY "delivery_orders_update_rider" ON delivery_orders
  FOR UPDATE USING (true);

-- 6. Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE delivery_orders;

-- 7. Tabla delivery_zones (para cobertura)
CREATE TABLE IF NOT EXISTS delivery_zones (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id       UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  radius_km           NUMERIC(6,2) NOT NULL,
  price_guarani       INTEGER NOT NULL DEFAULT 0,
  estimated_minutes   INTEGER NOT NULL DEFAULT 30,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delivery_zones_restaurant ON delivery_zones(restaurant_id);

ALTER TABLE delivery_zones ENABLE ROW LEVEL SECURITY;
CREATE POLICY "delivery_zones_read" ON delivery_zones FOR SELECT USING (true);
CREATE POLICY "delivery_zones_admin" ON delivery_zones FOR ALL USING (true);

-- 8. Seed de zonas para el restaurante demo
INSERT INTO delivery_zones (restaurant_id, name, radius_km, price_guarani, estimated_minutes, is_active)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'Centro',         3,  10000, 20, true),
  ('00000000-0000-0000-0000-000000000001', 'Zona intermedia', 7,  18000, 35, true),
  ('00000000-0000-0000-0000-000000000001', 'Zona ampliada',  15, 28000, 50, true)
ON CONFLICT DO NOTHING;
