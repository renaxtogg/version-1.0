-- staff_requests: solicitudes de incorporación de personal creadas por el gerente
-- El admin revisa, aprueba (y crea el usuario) o rechaza la solicitud.

CREATE TABLE IF NOT EXISTS staff_requests (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  requested_by    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  requested_by_name text      NOT NULL DEFAULT '',
  full_name       text        NOT NULL,
  username        text        NOT NULL DEFAULT '',
  role            text        NOT NULL DEFAULT 'mozo',
  dni             text        NOT NULL DEFAULT '',
  phone           text        NOT NULL DEFAULT '',
  email           text        NOT NULL DEFAULT '',
  notes           text        NOT NULL DEFAULT '',
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','approved','rejected')),
  reviewed_by     uuid        REFERENCES auth.users(id),
  reviewed_at     timestamptz,
  review_notes    text        NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE staff_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "staff_requests_all" ON staff_requests
  FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX idx_staff_requests_restaurant ON staff_requests(restaurant_id, status, created_at DESC);
