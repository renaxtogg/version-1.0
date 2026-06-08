-- Migración 101: vincular delivery_riders con cuentas de auth (login por correo+contraseña)
--
-- El rider deja de usar PIN: ahora inicia sesión con usuario+contraseña como el resto del
-- personal (cuenta real en auth.users + fila en user_roles con rol 'rider'). La fila de
-- delivery_riders (perfil operativo: vehículo, comisión, estado) se vincula a esa cuenta vía
-- user_id. El panel rider resuelve "mi ficha" con user_id = auth.uid() — sin PIN.
--
-- rider_pin queda OBSOLETO para el login pero NO se elimina (compatibilidad con históricos /
-- migraciones de reset que lo referencian). Simplemente deja de usarse.

ALTER TABLE delivery_riders
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Un rider por cuenta auth. El índice parcial permite múltiples filas con user_id NULL
-- (riders legacy creados sólo con PIN, antes de esta migración).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_delivery_riders_user
  ON delivery_riders(user_id) WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_delivery_riders_user ON delivery_riders(user_id);

-- RLS: la política existente delivery_riders_all USING(true) ya permite que el rider
-- autenticado lea/actualice su propia fila (resuelta por user_id). No se modifica RLS aquí
-- para no afectar el resto del flujo multi-restaurante (ver CLAUDE.md).

-- Recargar el schema cache de PostgREST para exponer user_id de inmediato.
NOTIFY pgrst, 'reload schema';
