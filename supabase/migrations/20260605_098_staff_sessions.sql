-- ============================================================
-- Migración 098 — staff_sessions (registro de conexiones del personal)
-- (renumerada desde 097 para evitar choque con 097_plans_pricing_guarani)
--
-- Objetivo: que el módulo Personal → Turnos del admin deje de ser un
-- registro MANUAL (carga a mano de entrada/salida) y pase a reflejar las
-- conexiones REALES de cada panel (mozo, caja, cocina, gerente, rider…).
--
-- Enfoque elegido: "simple login/logout" (sin heartbeat).
--   · login_at  → se graba cuando el panel arranca con sesión válida.
--   · logout_at → se graba al desloguear (botón Salir).
--   · Una sesión que queda abierta (cierre de pestaña / deslogeo / caída)
--     se muestra como "Sin cierre" y el admin puede forzar su cierre.
--
-- Reutiliza la lógica multi-comercio: restaurant_id obligatorio.
-- employee_shifts (migración 033, manual) NO se borra: queda como traza,
-- pero la pestaña Turnos pasa a leer ESTA tabla.
-- ============================================================

CREATE TABLE IF NOT EXISTS staff_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id       uuid,                 -- auth.users.id (paneles con login email/clave). NULL en riders.
  rider_id      uuid,                 -- delivery_riders.id (login por PIN). NULL en paneles auth.
  employee_name text,                 -- nombre legible al momento del login (denormalizado)
  role          text,                 -- rol con el que inició sesión
  panel         text,                 -- 'mozo' | 'caja' | 'cocina' | 'gerente' | 'admin' | 'delivery-rider'
  login_at      timestamptz NOT NULL DEFAULT now(),
  logout_at     timestamptz,          -- NULL = sesión abierta (en línea o sin cierre)
  logout_reason text,                 -- 'manual' | 'forzado_admin' | etc.
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_staff_sessions_restaurant ON staff_sessions(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_staff_sessions_login_at   ON staff_sessions(login_at);
CREATE INDEX IF NOT EXISTS idx_staff_sessions_user       ON staff_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_staff_sessions_rider      ON staff_sessions(rider_id);
-- Para la deduplicación rápida de sesiones abiertas (reutilizar en vez de duplicar).
CREATE INDEX IF NOT EXISTS idx_staff_sessions_open       ON staff_sessions(restaurant_id, logout_at) WHERE logout_at IS NULL;

ALTER TABLE staff_sessions ENABLE ROW LEVEL SECURITY;

-- NOTA: USING(true) como el resto de las tablas (deuda conocida de RLS multi-comercio).
-- El registro lo escribe el cliente anónimo de cada panel; el filtrado real es por restaurant_id en la app.
DROP POLICY IF EXISTS "staff_sessions_all" ON staff_sessions;
CREATE POLICY "staff_sessions_all" ON staff_sessions
  USING (true) WITH CHECK (true);

-- Realtime para que el admin vea las conexiones aparecer/cerrarse en vivo.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'staff_sessions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE staff_sessions;
  END IF;
END $$;
