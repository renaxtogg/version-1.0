-- Migración 033: tabla employee_shifts para control de turnos en módulo Personal

CREATE TABLE IF NOT EXISTS employee_shifts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  employee_name text,
  role          text,
  clock_in      timestamptz NOT NULL DEFAULT now(),
  clock_out     timestamptz,
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_employee_shifts_restaurant ON employee_shifts(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_employee_shifts_clock_in   ON employee_shifts(clock_in);
CREATE INDEX IF NOT EXISTS idx_employee_shifts_employee   ON employee_shifts(employee_id);

ALTER TABLE employee_shifts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "employee_shifts_all" ON employee_shifts
  USING (true) WITH CHECK (true);

ALTER PUBLICATION supabase_realtime ADD TABLE employee_shifts;
