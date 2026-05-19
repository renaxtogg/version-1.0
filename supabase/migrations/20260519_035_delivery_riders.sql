-- Migración 035: tabla delivery_riders (riders de delivery)

CREATE TABLE IF NOT EXISTS delivery_riders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  phone            text,
  vehicle          text NOT NULL DEFAULT 'moto',
  commission_type  text NOT NULL DEFAULT 'pct' CHECK (commission_type IN ('pct','fixed')),
  commission_value numeric(10,2) NOT NULL DEFAULT 0,
  current_status   text NOT NULL DEFAULT 'disponible'
    CHECK (current_status IN ('disponible','en_ruta','offline')),
  active           boolean NOT NULL DEFAULT true,
  photo_url        text,
  created_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_riders_restaurant ON delivery_riders(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_delivery_riders_active     ON delivery_riders(active);

ALTER TABLE delivery_riders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "delivery_riders_all" ON delivery_riders
  USING (true) WITH CHECK (true);

ALTER PUBLICATION supabase_realtime ADD TABLE delivery_riders;

-- Extender delivery_orders con campos que usa el frontend
ALTER TABLE delivery_orders
  ADD COLUMN IF NOT EXISTS order_total       integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS order_number      text,
  ADD COLUMN IF NOT EXISTS channel           text DEFAULT 'propio',
  ADD COLUMN IF NOT EXISTS channel_commission integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rider_status      text NOT NULL DEFAULT 'pending'
    CHECK (rider_status IN ('pending','confirmed','picked_up','on_way','delivered','cancelled')),
  ADD COLUMN IF NOT EXISTS delivery_notes    text;
