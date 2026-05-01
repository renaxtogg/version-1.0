-- ============================================================
-- Migración 004: Tablas de plataforma (SuperAdmin)
-- ============================================================

-- Columnas adicionales en restaurants para gestión de plataforma
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS status        TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','inactive','suspended','trial')),
  ADD COLUMN IF NOT EXISTS owner_name    TEXT,
  ADD COLUMN IF NOT EXISTS owner_email   TEXT,
  ADD COLUMN IF NOT EXISTS owner_phone   TEXT,
  ADD COLUMN IF NOT EXISTS country       TEXT DEFAULT 'Paraguay',
  ADD COLUMN IF NOT EXISTS city          TEXT,
  ADD COLUMN IF NOT EXISTS notes         TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_date DATE DEFAULT CURRENT_DATE;

-- ── Planes de suscripción ────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscription_plans (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  price_usd      NUMERIC(10,2) NOT NULL DEFAULT 0,
  billing_cycle  TEXT NOT NULL DEFAULT 'monthly'
    CHECK (billing_cycle IN ('monthly','annual','free')),
  max_tables     INT  DEFAULT 10,
  max_menu_items INT  DEFAULT 50,
  features       JSONB DEFAULT '[]',
  is_active      BOOLEAN DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Suscripciones (una por restaurante) ─────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  plan_id        UUID NOT NULL REFERENCES subscription_plans(id),
  status         TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','trial','expired','cancelled','suspended')),
  start_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date       DATE NOT NULL,
  auto_renew     BOOLEAN DEFAULT true,
  payment_method TEXT DEFAULT 'manual',
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(restaurant_id)
);

CREATE TRIGGER subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION auto_updated_at();

-- ── Log de eventos de plataforma ────────────────────────────
CREATE TABLE IF NOT EXISTS platform_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE SET NULL,
  event_type    TEXT NOT NULL,
  description   TEXT,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── RLS ─────────────────────────────────────────────────────
ALTER TABLE subscription_plans  ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_events      ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sa_plans_all"   ON subscription_plans  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "sa_subs_all"    ON subscriptions        FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "sa_events_all"  ON platform_events      FOR ALL USING (true) WITH CHECK (true);

-- También permitir SELECT/UPDATE de las nuevas columnas de restaurants
CREATE POLICY "sa_restaurants_all" ON restaurants FOR ALL USING (true) WITH CHECK (true);

-- ── Seed: planes ────────────────────────────────────────────
INSERT INTO subscription_plans (id, name, price_usd, billing_cycle, max_tables, max_menu_items, features)
VALUES
  ('10000000-0000-0000-0000-000000000001',
   'Starter', 29.00, 'monthly', 5, 30,
   '["Pedidos QR","KDS cocina","Analytics básico"]'),
  ('10000000-0000-0000-0000-000000000002',
   'Pro', 59.00, 'monthly', 15, 100,
   '["Pedidos QR","KDS cocina","Analytics completo","Cupones","Calificaciones"]'),
  ('10000000-0000-0000-0000-000000000003',
   'Enterprise', 119.00, 'monthly', 50, 500,
   '["Pedidos QR","KDS cocina","Analytics completo","Cupones","Calificaciones","Soporte prioritario","Branding propio"]')
ON CONFLICT DO NOTHING;

-- ── Seed: restaurantes demo ──────────────────────────────────
UPDATE restaurants SET
  status         = 'active',
  owner_name     = 'Carlos Gómez',
  owner_email    = 'carlos@lahuaca.com.py',
  owner_phone    = '+595 981 123 456',
  country        = 'Paraguay',
  city           = 'Asunción',
  onboarding_date = '2026-01-15'
WHERE id = '00000000-0000-0000-0000-000000000001';

INSERT INTO restaurants (id, name, address, phone, timezone, status, owner_name, owner_email, owner_phone, country, city, onboarding_date)
VALUES
  ('00000000-0000-0000-0000-000000000002',
   'El Mercado', 'Av. Santa Teresa 1230, Lambaré', '+595 21 555 0200',
   'America/Asuncion', 'active',
   'Sofía Benítez', 'sofia@elmercadopy.com', '+595 982 200 100',
   'Paraguay', 'Lambaré', '2026-02-10'),
  ('00000000-0000-0000-0000-000000000003',
   'Don Julio Parrilla', 'Mcal. López 4590, Asunción', '+595 21 600 8800',
   'America/Asuncion', 'trial',
   'Julio Fernández', 'julio@donjulio.com.py', '+595 991 330 220',
   'Paraguay', 'Asunción', '2026-04-20'),
  ('00000000-0000-0000-0000-000000000004',
   'Café Central', 'Palma 580, Ciudad del Este', '+595 61 777 3300',
   'America/Asuncion', 'suspended',
   'Andrea Sosa', 'andrea@cafecentral.py', '+595 985 440 330',
   'Paraguay', 'Ciudad del Este', '2025-11-01')
ON CONFLICT (id) DO NOTHING;

-- ── Seed: suscripciones ──────────────────────────────────────
INSERT INTO subscriptions (restaurant_id, plan_id, status, start_date, end_date, auto_renew, payment_method)
VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002',
   'active', '2026-04-01', '2026-05-01', true, 'transferencia'),
  ('00000000-0000-0000-0000-000000000002',
   '10000000-0000-0000-0000-000000000002',
   'active', '2026-04-10', '2026-05-10', true, 'tarjeta'),
  ('00000000-0000-0000-0000-000000000003',
   '10000000-0000-0000-0000-000000000001',
   'trial',  '2026-04-20', '2026-05-04', false, 'manual'),
  ('00000000-0000-0000-0000-000000000004',
   '10000000-0000-0000-0000-000000000002',
   'suspended','2025-11-01','2026-04-30', false, 'transferencia')
ON CONFLICT (restaurant_id) DO NOTHING;

-- ── Seed: eventos de plataforma ──────────────────────────────
INSERT INTO platform_events (restaurant_id, event_type, description, created_at)
VALUES
  ('00000000-0000-0000-0000-000000000001','onboarding',            'Alta en plataforma — Plan Pro',              '2026-01-15 10:00:00'),
  ('00000000-0000-0000-0000-000000000001','subscription_renewed',  'Renovación automática — Plan Pro',           '2026-04-01 08:00:00'),
  ('00000000-0000-0000-0000-000000000002','onboarding',            'Alta en plataforma — Plan Pro',              '2026-02-10 11:30:00'),
  ('00000000-0000-0000-0000-000000000002','subscription_renewed',  'Renovación automática — Plan Pro',           '2026-04-10 08:00:00'),
  ('00000000-0000-0000-0000-000000000003','onboarding',            'Alta en plataforma — Trial 14 días Starter','2026-04-20 09:15:00'),
  ('00000000-0000-0000-0000-000000000004','onboarding',            'Alta en plataforma — Plan Pro',              '2025-11-01 14:00:00'),
  ('00000000-0000-0000-0000-000000000004','status_changed',        'Cuenta suspendida por falta de pago',        '2026-04-30 09:00:00');
