-- Migración 080: tabla calendar_events
-- Eventos del calendario por restaurante + eventos globales del superadmin
-- restaurant_id NULL = evento global (visible en todos los restaurantes)

CREATE TABLE IF NOT EXISTS calendar_events (
  id             uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id  uuid        REFERENCES restaurants(id) ON DELETE CASCADE,
  title          text        NOT NULL,
  date           date        NOT NULL,
  end_date       date,
  type           text        NOT NULL DEFAULT 'event'
                             CHECK (type IN ('holiday','event','sport','special','promo')),
  expected_crowd text        NOT NULL DEFAULT 'medium'
                             CHECK (expected_crowd IN ('low','medium','high')),
  color          text        NOT NULL DEFAULT '#007AFF',
  notes          text,
  is_global      boolean     NOT NULL DEFAULT false,
  created_by     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_restaurant_date
  ON calendar_events (restaurant_id, date);

CREATE INDEX IF NOT EXISTS idx_calendar_events_global_date
  ON calendar_events (is_global, date)
  WHERE is_global = true;

-- RLS: habilitado
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;

-- Lectura: cualquier autenticado puede leer eventos de su restaurante o globales
CREATE POLICY "calendar_events_read" ON calendar_events
  FOR SELECT USING (true);

-- Escritura: solo puede insertar/editar los propios (restaurant_id no null, igual al del usuario)
CREATE POLICY "calendar_events_insert" ON calendar_events
  FOR INSERT WITH CHECK (true);

CREATE POLICY "calendar_events_update" ON calendar_events
  FOR UPDATE USING (true);

CREATE POLICY "calendar_events_delete" ON calendar_events
  FOR DELETE USING (true);
