-- ============================================================
-- Mesa App v1.0 — SETUP COMPLETO (migraciones 001→008)
-- Ejecutar una sola vez en Supabase SQL Editor (inglés)
-- ============================================================

-- ── EXTENSIONS ──────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── HELPER: auto-update updated_at ──────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- ── TABLAS BASE ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS restaurants (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name            TEXT NOT NULL,
  address         TEXT, phone TEXT, instagram TEXT, website TEXT,
  logo_initials   TEXT DEFAULT 'LH',
  cover_style     TEXT DEFAULT 'dark',
  timezone        TEXT DEFAULT 'America/Asuncion',
  is_active       BOOLEAN DEFAULT true,
  status          TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','inactive','suspended','trial')),
  owner_name      TEXT, owner_email TEXT, owner_phone TEXT,
  country         TEXT DEFAULT 'Paraguay', city TEXT, notes TEXT,
  onboarding_date DATE DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
DROP TRIGGER IF EXISTS trg_restaurants_updated_at ON restaurants;
CREATE TRIGGER trg_restaurants_updated_at
  BEFORE UPDATE ON restaurants FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS tables (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  number        INTEGER NOT NULL,
  qr_token      TEXT UNIQUE DEFAULT gen_random_uuid()::TEXT,
  capacity      INTEGER DEFAULT 4,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(restaurant_id, number)
);

CREATE TABLE IF NOT EXISTS menu_categories (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  sort_order    INTEGER DEFAULT 0,
  is_active     BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS menu_items (
  id            SERIAL PRIMARY KEY,
  category_id   UUID NOT NULL REFERENCES menu_categories(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL, description TEXT,
  price_guarani INTEGER NOT NULL CHECK (price_guarani > 0),
  promo_tag     TEXT, image_url TEXT,
  is_available  BOOLEAN DEFAULT true,
  sort_order    INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
DROP TRIGGER IF EXISTS trg_menu_items_updated_at ON menu_items;
CREATE TRIGGER trg_menu_items_updated_at
  BEFORE UPDATE ON menu_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS menu_item_extras (
  id            SERIAL PRIMARY KEY,
  item_id       INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  price_guarani INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS coupons (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id    UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  code             TEXT NOT NULL,
  discount_type    TEXT NOT NULL CHECK (discount_type IN ('percentage','fixed')),
  discount_value   INTEGER NOT NULL CHECK (discount_value > 0),
  min_order_amount INTEGER DEFAULT 0,
  is_active        BOOLEAN DEFAULT true,
  used_count       INTEGER DEFAULT 0,
  max_uses         INTEGER, valid_until TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(restaurant_id, code)
);

CREATE TABLE IF NOT EXISTS orders (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  table_id        UUID REFERENCES tables(id) ON DELETE RESTRICT,
  order_number    TEXT UNIQUE NOT NULL,
  order_type      TEXT NOT NULL DEFAULT 'local' CHECK (order_type IN ('local','llevar')),
  status          TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','confirmed','paid','kitchen_received','cooking','ready','delivered','cancelled')),
  subtotal        INTEGER NOT NULL DEFAULT 0,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  coupon_code     TEXT, total INTEGER NOT NULL DEFAULT 0,
  payment_method  TEXT CHECK (payment_method IN ('efectivo','tarjeta','qr','pos')),
  customer_name   TEXT, customer_ruc TEXT, customer_email TEXT,
  language        TEXT DEFAULT 'es', notes TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);
DROP TRIGGER IF EXISTS trg_orders_updated_at ON orders;
CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS order_items (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id     INTEGER REFERENCES menu_items(id) ON DELETE RESTRICT,
  item_name   TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price  INTEGER NOT NULL, total_price INTEGER NOT NULL,
  observations TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_item_extras (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  extra_name    TEXT NOT NULL, extra_price INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS order_status_history (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id   UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  changed_at TIMESTAMPTZ DEFAULT NOW(),
  changed_by TEXT DEFAULT 'system'
);

CREATE TABLE IF NOT EXISTS waiter_calls (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id      UUID REFERENCES tables(id) ON DELETE CASCADE,
  order_id      UUID REFERENCES orders(id) ON DELETE SET NULL,
  status        TEXT DEFAULT 'pending' CHECK (status IN ('pending','attended')),
  created_at    TIMESTAMPTZ DEFAULT NOW(), attended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ratings (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id      UUID REFERENCES orders(id) ON DELETE SET NULL,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id      UUID REFERENCES tables(id) ON DELETE SET NULL,
  stars         INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment       TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── TABLAS SUPERADMIN ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscription_plans (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  price_usd      NUMERIC(10,2) NOT NULL DEFAULT 0,
  billing_cycle  TEXT NOT NULL DEFAULT 'monthly'
    CHECK (billing_cycle IN ('monthly','annual','free')),
  max_tables     INT DEFAULT 10, max_menu_items INT DEFAULT 50,
  features       JSONB DEFAULT '[]',
  is_active      BOOLEAN DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  plan_id        UUID NOT NULL REFERENCES subscription_plans(id),
  status         TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','trial','expired','cancelled','suspended')),
  start_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date       DATE NOT NULL,
  auto_renew     BOOLEAN DEFAULT true,
  payment_method TEXT DEFAULT 'manual', notes TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(restaurant_id)
);
DROP TRIGGER IF EXISTS subscriptions_updated_at ON subscriptions;
CREATE TRIGGER subscriptions_updated_at
  BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS platform_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE SET NULL,
  event_type    TEXT NOT NULL, description TEXT,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── TABLA user_roles ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_roles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  restaurant_id UUID REFERENCES public.restaurants(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('cocina','admin','superadmin')),
  username      TEXT, display_name TEXT, email TEXT,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, role)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_username_idx
  ON public.user_roles(username) WHERE username IS NOT NULL;

-- ── INDEXES ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tables_restaurant        ON tables(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_category      ON menu_items(category_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant    ON menu_items(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_menu_item_extras_item    ON menu_item_extras(item_id);
CREATE INDEX IF NOT EXISTS idx_orders_restaurant        ON orders(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_orders_status            ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created           ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_order        ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_item_extras_item   ON order_item_extras(order_item_id);
CREATE INDEX IF NOT EXISTS idx_status_history_order     ON order_status_history(order_id);
CREATE INDEX IF NOT EXISTS idx_waiter_calls_restaurant  ON waiter_calls(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_waiter_calls_status      ON waiter_calls(status);
CREATE INDEX IF NOT EXISTS idx_ratings_restaurant       ON ratings(restaurant_id);

-- ── ROW LEVEL SECURITY ───────────────────────────────────────
ALTER TABLE restaurants          ENABLE ROW LEVEL SECURITY;
ALTER TABLE tables               ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_categories      ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items           ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_item_extras     ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupons              ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders               ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_item_extras    ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE waiter_calls         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratings              ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_plans   ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles    ENABLE ROW LEVEL SECURITY;

-- ── POLÍTICAS RLS (con DO para evitar duplicados) ────────────
DO $$ BEGIN

  -- Lectura pública
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='read_restaurants')      THEN CREATE POLICY "read_restaurants"      ON restaurants      FOR SELECT USING (is_active=true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='read_tables')           THEN CREATE POLICY "read_tables"           ON tables           FOR SELECT USING (is_active=true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='read_menu_categories')  THEN CREATE POLICY "read_menu_categories"  ON menu_categories  FOR SELECT USING (is_active=true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='read_menu_items')       THEN CREATE POLICY "read_menu_items"       ON menu_items       FOR SELECT USING (is_available=true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='read_menu_extras')      THEN CREATE POLICY "read_menu_extras"      ON menu_item_extras FOR SELECT USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='read_coupons')          THEN CREATE POLICY "read_coupons"          ON coupons          FOR SELECT USING (is_active=true); END IF;

  -- Pedidos
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='insert_orders')         THEN CREATE POLICY "insert_orders"         ON orders           FOR INSERT WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='read_orders')           THEN CREATE POLICY "read_orders"           ON orders           FOR SELECT USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='update_orders')         THEN CREATE POLICY "update_orders"         ON orders           FOR UPDATE USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='insert_order_items')    THEN CREATE POLICY "insert_order_items"    ON order_items      FOR INSERT WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='read_order_items')      THEN CREATE POLICY "read_order_items"      ON order_items      FOR SELECT USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='insert_order_extras')   THEN CREATE POLICY "insert_order_extras"   ON order_item_extras FOR INSERT WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='read_order_extras')     THEN CREATE POLICY "read_order_extras"     ON order_item_extras FOR SELECT USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='insert_status_history') THEN CREATE POLICY "insert_status_history" ON order_status_history FOR INSERT WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='read_status_history')   THEN CREATE POLICY "read_status_history"   ON order_status_history FOR SELECT USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='insert_waiter_calls')   THEN CREATE POLICY "insert_waiter_calls"   ON waiter_calls     FOR INSERT WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='read_waiter_calls')     THEN CREATE POLICY "read_waiter_calls"     ON waiter_calls     FOR SELECT USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='update_waiter_calls')   THEN CREATE POLICY "update_waiter_calls"   ON waiter_calls     FOR UPDATE USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='insert_ratings')        THEN CREATE POLICY "insert_ratings"        ON ratings          FOR INSERT WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='read_ratings')          THEN CREATE POLICY "read_ratings"          ON ratings          FOR SELECT USING (true); END IF;

  -- Admin panel
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_read_all_menu_items')  THEN CREATE POLICY "admin_read_all_menu_items"  ON menu_items       FOR SELECT USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_read_all_categories')  THEN CREATE POLICY "admin_read_all_categories"  ON menu_categories  FOR SELECT USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_read_all_tables')      THEN CREATE POLICY "admin_read_all_tables"      ON tables           FOR SELECT USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_insert_categories')    THEN CREATE POLICY "admin_insert_categories"    ON menu_categories  FOR INSERT WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_update_categories')    THEN CREATE POLICY "admin_update_categories"    ON menu_categories  FOR UPDATE USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_insert_menu_items')    THEN CREATE POLICY "admin_insert_menu_items"    ON menu_items       FOR INSERT WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_update_menu_items')    THEN CREATE POLICY "admin_update_menu_items"    ON menu_items       FOR UPDATE USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_insert_extras')        THEN CREATE POLICY "admin_insert_extras"        ON menu_item_extras FOR INSERT WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_update_extras')        THEN CREATE POLICY "admin_update_extras"        ON menu_item_extras FOR UPDATE USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_delete_extras')        THEN CREATE POLICY "admin_delete_extras"        ON menu_item_extras FOR DELETE USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_insert_coupons')       THEN CREATE POLICY "admin_insert_coupons"       ON coupons          FOR INSERT WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_update_coupons')       THEN CREATE POLICY "admin_update_coupons"       ON coupons          FOR UPDATE USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='admin_update_restaurant')    THEN CREATE POLICY "admin_update_restaurant"    ON restaurants      FOR UPDATE USING (true); END IF;

  -- Superadmin
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='sa_plans_all')        THEN CREATE POLICY "sa_plans_all"        ON subscription_plans FOR ALL USING (true) WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='sa_subs_all')         THEN CREATE POLICY "sa_subs_all"         ON subscriptions      FOR ALL USING (true) WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='sa_events_all')       THEN CREATE POLICY "sa_events_all"       ON platform_events    FOR ALL USING (true) WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='sa_restaurants_all')  THEN CREATE POLICY "sa_restaurants_all"  ON restaurants        FOR ALL USING (true) WITH CHECK (true); END IF;

  -- user_roles
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='user_read_own_role')       THEN CREATE POLICY "user_read_own_role"       ON public.user_roles FOR SELECT USING (user_id=auth.uid()); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='superadmin_manage_roles')  THEN
    CREATE POLICY "superadmin_manage_roles" ON public.user_roles FOR ALL
      USING (EXISTS (SELECT 1 FROM public.user_roles me WHERE me.user_id=auth.uid() AND me.role='superadmin' AND me.is_active=true))
      WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles me WHERE me.user_id=auth.uid() AND me.role='superadmin' AND me.is_active=true));
  END IF;

END $$;

-- ── FUNCIONES ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_user_email(p_username TEXT)
RETURNS TEXT LANGUAGE sql SECURITY DEFINER AS $$
  SELECT email FROM public.user_roles
  WHERE username=p_username AND is_active=true AND email IS NOT NULL
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_user_email TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_my_profile()
RETURNS JSON LANGUAGE sql SECURITY DEFINER AS $$
  SELECT row_to_json(t) FROM (
    SELECT ur.role, ur.username, ur.display_name, ur.restaurant_id, ur.is_active
    FROM public.user_roles ur
    WHERE ur.user_id=auth.uid() AND ur.is_active=true
    LIMIT 1
  ) t;
$$;
GRANT EXECUTE ON FUNCTION public.get_my_profile TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_create_user(
  p_email TEXT, p_username TEXT, p_display_name TEXT,
  p_role TEXT, p_restaurant_id UUID DEFAULT NULL
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_user_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=auth.uid() AND role='superadmin' AND is_active=true)
    THEN RAISE EXCEPTION 'No autorizado'; END IF;
  IF p_role NOT IN ('cocina','admin','superadmin') THEN RAISE EXCEPTION 'Rol inválido: %', p_role; END IF;
  UPDATE auth.users SET email_confirmed_at=COALESCE(email_confirmed_at,NOW()), updated_at=NOW()
    WHERE email=p_email RETURNING id INTO v_user_id;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Usuario no encontrado en auth: %', p_email; END IF;
  INSERT INTO public.user_roles (user_id, email, username, display_name, role, restaurant_id, is_active)
  VALUES (v_user_id, p_email, p_username, p_display_name, p_role, p_restaurant_id, true)
  ON CONFLICT (user_id, role) DO UPDATE SET
    email=EXCLUDED.email, username=EXCLUDED.username, display_name=EXCLUDED.display_name,
    role=EXCLUDED.role, restaurant_id=EXCLUDED.restaurant_id, is_active=true;
  RETURN v_user_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_create_user TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_toggle_user(p_user_id UUID, p_active BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=auth.uid() AND role='superadmin' AND is_active=true)
    THEN RAISE EXCEPTION 'No autorizado'; END IF;
  UPDATE public.user_roles SET is_active=p_active WHERE user_id=p_user_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_toggle_user TO authenticated;

-- ── REALTIME ─────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE orders;
ALTER PUBLICATION supabase_realtime ADD TABLE waiter_calls;
ALTER PUBLICATION supabase_realtime ADD TABLE order_status_history;
ALTER PUBLICATION supabase_realtime ADD TABLE restaurants;
ALTER PUBLICATION supabase_realtime ADD TABLE subscriptions;
ALTER PUBLICATION supabase_realtime ADD TABLE platform_events;
ALTER PUBLICATION supabase_realtime ADD TABLE menu_items;
ALTER PUBLICATION supabase_realtime ADD TABLE menu_categories;

-- ── SEED DATA ────────────────────────────────────────────────
INSERT INTO restaurants (id,name,address,phone,instagram,website,logo_initials,status,owner_name,owner_email,owner_phone,country,city,onboarding_date)
VALUES ('00000000-0000-0000-0000-000000000001','La Huaca','Av. España 1840, Asunción, Paraguay','+595 21 000 000','@lahuaca.py','lahuaca.com.py','LH','active','Carlos Gómez','carlos@lahuaca.com.py','+595 981 123 456','Paraguay','Asunción','2026-01-15')
ON CONFLICT (id) DO NOTHING;

INSERT INTO restaurants (id,name,address,phone,timezone,status,owner_name,owner_email,owner_phone,country,city,onboarding_date)
VALUES
  ('00000000-0000-0000-0000-000000000002','El Mercado','Av. Santa Teresa 1230, Lambaré','+595 21 555 0200','America/Asuncion','active','Sofía Benítez','sofia@elmercadopy.com','+595 982 200 100','Paraguay','Lambaré','2026-02-10'),
  ('00000000-0000-0000-0000-000000000003','Don Julio Parrilla','Mcal. López 4590, Asunción','+595 21 600 8800','America/Asuncion','trial','Julio Fernández','julio@donjulio.com.py','+595 991 330 220','Paraguay','Asunción','2026-04-20'),
  ('00000000-0000-0000-0000-000000000004','Café Central','Palma 580, Ciudad del Este','+595 61 777 3300','America/Asuncion','suspended','Andrea Sosa','andrea@cafecentral.py','+595 985 440 330','Paraguay','Ciudad del Este','2025-11-01')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tables (restaurant_id, number, qr_token, capacity) VALUES
  ('00000000-0000-0000-0000-000000000001',1,'lahuaca-mesa-1',4),('00000000-0000-0000-0000-000000000001',2,'lahuaca-mesa-2',4),
  ('00000000-0000-0000-0000-000000000001',3,'lahuaca-mesa-3',6),('00000000-0000-0000-0000-000000000001',4,'lahuaca-mesa-4',4),
  ('00000000-0000-0000-0000-000000000001',5,'lahuaca-mesa-5',2),('00000000-0000-0000-0000-000000000001',6,'lahuaca-mesa-6',4),
  ('00000000-0000-0000-0000-000000000001',7,'lahuaca-mesa-7',8),('00000000-0000-0000-0000-000000000001',8,'lahuaca-mesa-8',4),
  ('00000000-0000-0000-0000-000000000001',9,'lahuaca-mesa-9',6),('00000000-0000-0000-0000-000000000001',10,'lahuaca-mesa-10',4)
ON CONFLICT (restaurant_id, number) DO NOTHING;

INSERT INTO menu_categories (id, restaurant_id, name, sort_order) VALUES
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Entrantes',1),
  ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','Hamburguesas',2),
  ('10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','Lomito',3),
  ('10000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','Bebidas',4)
ON CONFLICT (id) DO NOTHING;

INSERT INTO menu_items (id,category_id,restaurant_id,name,description,price_guarani,promo_tag,sort_order) VALUES
  (1,'10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Empanada de carne','Masa crujiente, carne molida, cebolla, huevo duro',15000,NULL,1),
  (2,'10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Provoleta parrilla','Queso provolone, orégano fresco, tomate cherry',22000,'2×1',2),
  (3,'10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Tabla de fiambres','Jamón serrano, salami, queso, aceitunas, tostadas',38000,NULL,3),
  (4,'10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Sopa paraguaya','Torta de maíz, queso Paraguay, cebolla',12000,NULL,4),
  (5,'10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','Clásica Comanda','200g res, lechuga, tomate, cebolla morada, cheddar',28000,NULL,1),
  (6,'10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','BBQ Smokey','200g, cheddar ahumado, cebolla caramelizada, salsa BBQ',32000,'−10%',2),
  (7,'10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','Doble Black','2×160g angus, queso americano, brioche negro',42000,NULL,3),
  (8,'10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','Veggie','Base de poroto negro, aguacate, brotes, tahini',30000,NULL,4),
  (9,'10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','Lomito simple','Lomo fino, pan casero tostado, lechuga, tomate',30000,NULL,1),
  (10,'10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','Lomito completo','Lomo, huevo, jamón, queso, lechuga, tomate, mayo',38000,NULL,2),
  (11,'10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','Lomito americano','Lomo, cheddar fundido, bacon, salsa americana',35000,'Chef ★',3),
  (12,'10000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','Coca-Cola','Lata 350ml bien fría',8000,NULL,1),
  (13,'10000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','Cerveza Pilsen','Botella 500ml importada',15000,'2×1',2),
  (14,'10000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','Jugo natural','Naranja, mango o maracuyá. 400ml al momento',12000,NULL,3),
  (15,'10000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','Agua mineral','500ml con o sin gas',5000,NULL,4),
  (16,'10000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','Tereré especial','Con hierbas medicinales, limón y menta fresca',10000,NULL,5)
ON CONFLICT (id) DO NOTHING;

INSERT INTO menu_item_extras (item_id, name, price_guarani) VALUES
  (1,'Chimichurri',2000),(1,'Salsa picante',1500),
  (5,'Panceta',5000),(5,'Huevo frito',3000),(5,'Doble carne',12000),(5,'Extra queso',3000),
  (6,'Panceta',5000),(6,'Jalapeños',2000),
  (7,'Panceta',5000),(7,'Huevo frito',3000),
  (9,'Huevo frito',3000),(9,'Jamón',4000),(9,'Queso',3000),
  (10,'Extra carne',10000),(10,'Panceta',5000)
ON CONFLICT DO NOTHING;

INSERT INTO coupons (restaurant_id,code,discount_type,discount_value,min_order_amount,is_active)
VALUES ('00000000-0000-0000-0000-000000000001','MESA10','percentage',10,0,true)
ON CONFLICT (restaurant_id, code) DO NOTHING;

INSERT INTO subscription_plans (id,name,price_usd,billing_cycle,max_tables,max_menu_items,features) VALUES
  ('10000000-0000-0000-0000-000000000001','Starter',29.00,'monthly',5,30,'["Pedidos QR","KDS cocina","Analytics básico"]'),
  ('10000000-0000-0000-0000-000000000002','Pro',59.00,'monthly',15,100,'["Pedidos QR","KDS cocina","Analytics completo","Cupones","Calificaciones"]'),
  ('10000000-0000-0000-0000-000000000003','Enterprise',119.00,'monthly',50,500,'["Pedidos QR","KDS cocina","Analytics completo","Cupones","Calificaciones","Soporte prioritario","Branding propio"]')
ON CONFLICT DO NOTHING;

INSERT INTO subscriptions (restaurant_id,plan_id,status,start_date,end_date,auto_renew,payment_method) VALUES
  ('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','active','2026-04-01','2026-05-01',true,'transferencia'),
  ('00000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','active','2026-04-10','2026-05-10',true,'tarjeta'),
  ('00000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','trial','2026-04-20','2026-05-04',false,'manual'),
  ('00000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000002','suspended','2025-11-01','2026-04-30',false,'transferencia')
ON CONFLICT (restaurant_id) DO NOTHING;

-- ============================================================
-- LISTO. Ahora crear el usuario superadmin:
-- 1. Authentication > Users > Add user (email + password)
-- 2. Copiar el UUID del usuario creado
-- 3. Ejecutar en SQL Editor:
--
-- INSERT INTO public.user_roles (user_id, email, username, display_name, role, is_active)
-- VALUES ('<UUID_AQUI>', '<EMAIL_AQUI>', 'Renaxto', 'Renato', 'superadmin', true);
-- ============================================================
