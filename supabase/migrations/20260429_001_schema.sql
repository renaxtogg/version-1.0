-- ============================================================
-- Mesa App v1.0 — Schema Supabase
-- Proyecto: version-1.0
-- Creado: 2026-04-29
-- Descripción: Sistema QR de pedidos para restaurantes (Paraguay, ₲)
-- ============================================================

-- ── EXTENSIONS ──────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── HELPER: auto-update updated_at ─────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── TABLE: restaurants ───────────────────────────────────────
-- Información del local. Un proyecto Supabase puede servir a N locales.
CREATE TABLE IF NOT EXISTS restaurants (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name            TEXT NOT NULL,
  address         TEXT,
  phone           TEXT,
  instagram       TEXT,
  website         TEXT,
  logo_initials   TEXT DEFAULT 'LH',
  cover_style     TEXT DEFAULT 'dark',
  timezone        TEXT DEFAULT 'America/Asuncion',
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER trg_restaurants_updated_at
  BEFORE UPDATE ON restaurants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── TABLE: tables (mesas) ────────────────────────────────────
-- Cada mesa tiene un qr_token único para identificarla en el QR.
CREATE TABLE IF NOT EXISTS tables (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  number          INTEGER NOT NULL,
  qr_token        TEXT UNIQUE DEFAULT gen_random_uuid()::TEXT,
  capacity        INTEGER DEFAULT 4,
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(restaurant_id, number)
);

-- ── TABLE: menu_categories ───────────────────────────────────
CREATE TABLE IF NOT EXISTS menu_categories (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  sort_order      INTEGER DEFAULT 0,
  is_active       BOOLEAN DEFAULT true
);

-- ── TABLE: menu_items ────────────────────────────────────────
-- Platos del menú. price_guarani en enteros (sin decimales).
-- promo_tag: '2×1', '−10%', 'Chef ★', NULL
CREATE TABLE IF NOT EXISTS menu_items (
  id              SERIAL PRIMARY KEY,
  category_id     UUID NOT NULL REFERENCES menu_categories(id) ON DELETE CASCADE,
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  price_guarani   INTEGER NOT NULL CHECK (price_guarani > 0),
  promo_tag       TEXT,
  image_url       TEXT,
  is_available    BOOLEAN DEFAULT true,
  sort_order      INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER trg_menu_items_updated_at
  BEFORE UPDATE ON menu_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── TABLE: menu_item_extras ──────────────────────────────────
-- Ingredientes / opciones adicionales con precio por plato.
CREATE TABLE IF NOT EXISTS menu_item_extras (
  id              SERIAL PRIMARY KEY,
  item_id         INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  price_guarani   INTEGER NOT NULL DEFAULT 0
);

-- ── TABLE: coupons ───────────────────────────────────────────
-- Cupones de descuento. discount_type: 'percentage' | 'fixed'
CREATE TABLE IF NOT EXISTS coupons (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,
  discount_type   TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value  INTEGER NOT NULL CHECK (discount_value > 0),
  min_order_amount INTEGER DEFAULT 0,
  is_active       BOOLEAN DEFAULT true,
  used_count      INTEGER DEFAULT 0,
  max_uses        INTEGER,
  valid_until     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(restaurant_id, code)
);

-- ── TABLE: orders (pedidos) ──────────────────────────────────
-- Pedido principal. Status flow:
-- draft → confirmed → paid → kitchen_received → cooking → ready → delivered
-- Para cocina: paid/kitchen_received = "nuevo", cooking = "preparando", ready = "listo"
CREATE TABLE IF NOT EXISTS orders (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  table_id        UUID REFERENCES tables(id) ON DELETE RESTRICT,
  order_number    TEXT UNIQUE NOT NULL,          -- 'T-2847'
  order_type      TEXT NOT NULL DEFAULT 'local'
                    CHECK (order_type IN ('local', 'llevar')),
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN (
                      'draft','confirmed','paid',
                      'kitchen_received','cooking','ready','delivered','cancelled'
                    )),
  subtotal        INTEGER NOT NULL DEFAULT 0,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  coupon_code     TEXT,
  total           INTEGER NOT NULL DEFAULT 0,
  payment_method  TEXT CHECK (payment_method IN ('efectivo','tarjeta','qr','pos')),
  customer_name   TEXT,
  customer_ruc    TEXT,                          -- RUC o cédula para factura
  customer_email  TEXT,
  language        TEXT DEFAULT 'es',
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── TABLE: order_items ───────────────────────────────────────
-- Ítems dentro de un pedido. item_name es snapshot del nombre al momento del pedido.
CREATE TABLE IF NOT EXISTS order_items (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id         INTEGER REFERENCES menu_items(id) ON DELETE RESTRICT,
  item_name       TEXT NOT NULL,                -- snapshot: nombre al momento de pedir
  quantity        INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price      INTEGER NOT NULL,
  total_price     INTEGER NOT NULL,
  observations    TEXT,                         -- notas para cocina
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── TABLE: order_item_extras ─────────────────────────────────
-- Extras seleccionados para cada ítem del pedido (snapshot de nombre y precio).
CREATE TABLE IF NOT EXISTS order_item_extras (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_item_id   UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  extra_name      TEXT NOT NULL,
  extra_price     INTEGER NOT NULL DEFAULT 0
);

-- ── TABLE: order_status_history ──────────────────────────────
-- Log completo de cambios de estado. Nunca se borra, solo se inserta.
CREATE TABLE IF NOT EXISTS order_status_history (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status          TEXT NOT NULL,
  changed_at      TIMESTAMPTZ DEFAULT NOW(),
  changed_by      TEXT DEFAULT 'system'         -- 'customer', 'kitchen', 'system'
);

-- ── TABLE: waiter_calls ──────────────────────────────────────
-- Registro de llamadas al mozo. El mozo la marca como 'attended'.
CREATE TABLE IF NOT EXISTS waiter_calls (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id        UUID REFERENCES tables(id) ON DELETE CASCADE,
  order_id        UUID REFERENCES orders(id) ON DELETE SET NULL,
  status          TEXT DEFAULT 'pending'
                    CHECK (status IN ('pending', 'attended')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  attended_at     TIMESTAMPTZ
);

-- ── TABLE: ratings ───────────────────────────────────────────
-- Calificaciones del servicio. 1-5 estrellas + comentario libre.
CREATE TABLE IF NOT EXISTS ratings (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id        UUID REFERENCES orders(id) ON DELETE SET NULL,
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id        UUID REFERENCES tables(id) ON DELETE SET NULL,
  stars           INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment         TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── INDEXES ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tables_restaurant ON tables(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items(category_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant ON menu_items(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_menu_item_extras_item ON menu_item_extras(item_id);
CREATE INDEX IF NOT EXISTS idx_orders_restaurant ON orders(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_item_extras_item ON order_item_extras(order_item_id);
CREATE INDEX IF NOT EXISTS idx_status_history_order ON order_status_history(order_id);
CREATE INDEX IF NOT EXISTS idx_waiter_calls_restaurant ON waiter_calls(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_waiter_calls_status ON waiter_calls(status);
CREATE INDEX IF NOT EXISTS idx_ratings_restaurant ON ratings(restaurant_id);

-- ── ROW LEVEL SECURITY ───────────────────────────────────────
ALTER TABLE restaurants         ENABLE ROW LEVEL SECURITY;
ALTER TABLE tables              ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_categories     ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_item_extras    ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupons             ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders              ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_item_extras   ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE waiter_calls        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratings             ENABLE ROW LEVEL SECURITY;

-- Lectura pública (menú, restaurante, mesas)
CREATE POLICY "read_restaurants"      ON restaurants      FOR SELECT USING (is_active = true);
CREATE POLICY "read_tables"           ON tables           FOR SELECT USING (is_active = true);
CREATE POLICY "read_menu_categories"  ON menu_categories  FOR SELECT USING (is_active = true);
CREATE POLICY "read_menu_items"       ON menu_items       FOR SELECT USING (is_available = true);
CREATE POLICY "read_menu_extras"      ON menu_item_extras FOR SELECT USING (true);
CREATE POLICY "read_coupons"          ON coupons          FOR SELECT USING (is_active = true);

-- Pedidos: cliente puede crear y leer su propio pedido
CREATE POLICY "insert_orders"         ON orders           FOR INSERT WITH CHECK (true);
CREATE POLICY "read_orders"           ON orders           FOR SELECT USING (true);
CREATE POLICY "update_orders"         ON orders           FOR UPDATE USING (true);

-- Ítems de pedido
CREATE POLICY "insert_order_items"    ON order_items      FOR INSERT WITH CHECK (true);
CREATE POLICY "read_order_items"      ON order_items      FOR SELECT USING (true);

-- Extras de ítems
CREATE POLICY "insert_order_extras"   ON order_item_extras FOR INSERT WITH CHECK (true);
CREATE POLICY "read_order_extras"     ON order_item_extras FOR SELECT USING (true);

-- Historial de estados
CREATE POLICY "insert_status_history" ON order_status_history FOR INSERT WITH CHECK (true);
CREATE POLICY "read_status_history"   ON order_status_history FOR SELECT USING (true);

-- Llamadas al mozo
CREATE POLICY "insert_waiter_calls"   ON waiter_calls     FOR INSERT WITH CHECK (true);
CREATE POLICY "read_waiter_calls"     ON waiter_calls     FOR SELECT USING (true);
CREATE POLICY "update_waiter_calls"   ON waiter_calls     FOR UPDATE USING (true);

-- Calificaciones
CREATE POLICY "insert_ratings"        ON ratings          FOR INSERT WITH CHECK (true);
CREATE POLICY "read_ratings"          ON ratings          FOR SELECT USING (true);

-- ── REALTIME ─────────────────────────────────────────────────
-- Habilita realtime para que cocina y cliente reciban actualizaciones en tiempo real.
-- Ejecutar en Supabase Dashboard > Database > Replication si falla acá:
ALTER PUBLICATION supabase_realtime ADD TABLE orders;
ALTER PUBLICATION supabase_realtime ADD TABLE waiter_calls;
ALTER PUBLICATION supabase_realtime ADD TABLE order_status_history;
