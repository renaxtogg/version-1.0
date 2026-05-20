-- ─────────────────────────────────────────────────────────
-- Admin v2: nuevas columnas y tablas
-- ─────────────────────────────────────────────────────────

-- 1. menu_item_extras — agregar is_active
ALTER TABLE menu_item_extras
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- 2. ratings — agregar campo origin para clasificación por canal
ALTER TABLE ratings
  ADD COLUMN IF NOT EXISTS origin VARCHAR DEFAULT 'unknown';

-- 3. kitchen_messages — mensajes configurables para cocina
CREATE TABLE IF NOT EXISTS kitchen_messages (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  message       TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE kitchen_messages ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='read_kitchen_messages' AND tablename='kitchen_messages') THEN
    CREATE POLICY "read_kitchen_messages" ON kitchen_messages FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_kitchen_messages_insert' AND tablename='kitchen_messages') THEN
    CREATE POLICY "admin_kitchen_messages_insert" ON kitchen_messages FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_kitchen_messages_update' AND tablename='kitchen_messages') THEN
    CREATE POLICY "admin_kitchen_messages_update" ON kitchen_messages FOR UPDATE USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_kitchen_messages_delete' AND tablename='kitchen_messages') THEN
    CREATE POLICY "admin_kitchen_messages_delete" ON kitchen_messages FOR DELETE USING (true);
  END IF;
END $$;

-- 4. restaurant_settings — configuración por restaurante
CREATE TABLE IF NOT EXISTS restaurant_settings (
  restaurant_id              UUID PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  auto_stock_discount        BOOLEAN NOT NULL DEFAULT false,
  kitchen_message_frequency  INTEGER NOT NULL DEFAULT 10,
  settings_json              JSONB DEFAULT '{}'::JSONB
);

ALTER TABLE restaurant_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='read_restaurant_settings' AND tablename='restaurant_settings') THEN
    CREATE POLICY "read_restaurant_settings" ON restaurant_settings FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_restaurant_settings' AND tablename='restaurant_settings') THEN
    CREATE POLICY "admin_restaurant_settings" ON restaurant_settings FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Insertar fila de settings para restaurante demo si no existe
INSERT INTO restaurant_settings (restaurant_id, auto_stock_discount, kitchen_message_frequency)
VALUES ('00000000-0000-0000-0000-000000000001', false, 10)
ON CONFLICT (restaurant_id) DO NOTHING;

-- 5. orders — campos para pedidos de plataformas externas
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS channel VARCHAR,
  ADD COLUMN IF NOT EXISTS external_order_id VARCHAR;

-- 6. menu_categories — tipo de categoría para bebidas vs comida
ALTER TABLE menu_categories
  ADD COLUMN IF NOT EXISTS category_type VARCHAR DEFAULT 'food';

-- Seed de mensajes de cocina para el restaurante demo
INSERT INTO kitchen_messages (restaurant_id, message, active)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'Gracias al equipo por su dedicacion', true),
  ('00000000-0000-0000-0000-000000000001', 'Excelente trabajo hoy!', true)
ON CONFLICT DO NOTHING;
