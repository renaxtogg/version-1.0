-- Agregar columna metadata a waiter_calls para almacenar datos extra
-- como notificaciones de transferencia de mesas entre mozos.
ALTER TABLE waiter_calls ADD COLUMN IF NOT EXISTS metadata jsonb;
