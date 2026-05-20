-- mozo v2: waiter_id, paid_by, paid_at en orders + user_profiles con PIN

-- Registrar qué mozo creó la orden
ALTER TABLE orders ADD COLUMN IF NOT EXISTS waiter_id UUID REFERENCES auth.users(id);

-- Registrar quién cobró y cuándo
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_by UUID REFERENCES auth.users(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

-- Tabla de perfiles de usuarios de piso (mozo, cajero, etc.)
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  role TEXT DEFAULT 'mozo',
  pin VARCHAR(4),
  restaurant_id UUID REFERENCES restaurants(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- RLS básica: cualquier usuario autenticado puede leer perfiles de su restaurante
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_profiles' AND policyname = 'profiles_select') THEN
    CREATE POLICY "profiles_select" ON user_profiles FOR SELECT USING (true);
  END IF;
END $$;

-- Índice para búsqueda por PIN (login rápido)
CREATE INDEX IF NOT EXISTS idx_user_profiles_pin ON user_profiles(pin);
CREATE INDEX IF NOT EXISTS idx_orders_waiter_id ON orders(waiter_id);
