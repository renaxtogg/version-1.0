-- ════════════════════════════════════════════════════════════════════
-- 186 · Toggle de CIERRE DE CAJA CIEGO (por restaurante)
-- ────────────────────────────────────────────────────────────────────
-- El cierre de caja del cajero es un "arqueo ciego": declara su conteo
-- físico SIN ver los totales del sistema (la diferencia se registra en DB
-- pero no se le muestra). Este flag permite al ADMIN desactivarlo:
--   • cash_cierre_ciego = true  (DEFAULT) → comportamiento actual: ciego.
--   • cash_cierre_ciego = false          → el cajero ve el total esperado
--                                          por el sistema y la diferencia
--                                          al momento de cerrar.
-- Default TRUE preserva el comportamiento vigente en toda la plataforma.
-- Sólo agrega una columna (aditivo, deploy-safe). La RLS de restaurants no
-- cambia: el admin ya actualiza estas columnas de config de caja.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS cash_cierre_ciego boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.restaurants.cash_cierre_ciego IS
  'true = cierre de caja ciego (el cajero no ve totales del sistema al cerrar). false = muestra total esperado + diferencia. Config del admin (panel Caja).';

COMMIT;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

SELECT 'migration 186 applied — restaurants.cash_cierre_ciego' AS status;
