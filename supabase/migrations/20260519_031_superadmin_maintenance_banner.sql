-- Migración 031: Campos de mantenimiento en restaurants y tabla platform_config

-- Agregar campos de modo mantenimiento a restaurants
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS maintenance_mode boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS maintenance_message text;

-- Crear tabla de configuración global de plataforma
CREATE TABLE IF NOT EXISTS platform_config (
  key    text PRIMARY KEY,
  value  text,
  updated_at timestamptz DEFAULT now()
);

-- RLS: solo superadmin puede escribir, todos pueden leer (para mostrar banner en paneles)
ALTER TABLE platform_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "platform_config_read"  ON platform_config;
DROP POLICY IF EXISTS "platform_config_write" ON platform_config;

CREATE POLICY "platform_config_read"
  ON platform_config FOR SELECT
  USING (true);

CREATE POLICY "platform_config_write"
  ON platform_config FOR ALL
  USING (true);

-- Habilitar Realtime para platform_config
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'platform_config'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE platform_config;
  END IF;
END $$;

-- Seed inicial: banner inactivo
INSERT INTO platform_config (key, value, updated_at)
VALUES
  ('global_banner_active',  'false', now()),
  ('global_banner_message', '',      now())
ON CONFLICT (key) DO NOTHING;
