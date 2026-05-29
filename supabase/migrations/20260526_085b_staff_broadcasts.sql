-- Tabla para avisos internos del personal
-- Admin puede enviar a todos o grupos específicos.
-- Gerente puede enviar solo a trabajadores (no a admin ni gerente).
CREATE TABLE IF NOT EXISTS staff_broadcasts (
  id            uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id uuid        NOT NULL,
  sender_name   text        NOT NULL,
  sender_role   text        NOT NULL,
  target_roles  text[]      NOT NULL DEFAULT '{}',
  message       text        NOT NULL,
  created_at    timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE staff_broadcasts ENABLE ROW LEVEL SECURITY;

-- RLS permisiva (consistente con el resto del sistema; multi-restaurant real pendiente)
CREATE POLICY "staff_broadcasts_all" ON staff_broadcasts
  FOR ALL USING (true) WITH CHECK (true);

-- Índice para queries frecuentes
CREATE INDEX IF NOT EXISTS staff_broadcasts_restaurant_idx ON staff_broadcasts (restaurant_id, created_at DESC);
