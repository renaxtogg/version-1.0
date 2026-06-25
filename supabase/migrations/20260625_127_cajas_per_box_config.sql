-- ════════════════════════════════════════════════════════════════════
-- 127 · cajas · CONFIG POR CAJA + un turno abierto por caja (Fase 2)
-- ────────────────────────────────────────────────────────────────────
-- Fase 1 (mig 126) creó la tabla `cajas`. Fase 2: cada caja tiene su propia
-- apertura/cierre/fondo. Movemos a `cajas` los settings que hoy viven en
-- `restaurants` (mig 071): modo, fondo fijo, umbral, retiro de excedente.
--
--   · Columnas NULLABLE → NULL = HEREDAR del restaurante (fallback).
--     El panel/admin leen con COALESCE(caja, restaurante).
--   · Backfill: las cajas existentes (la "Caja Principal" de Fase 1) heredan
--     la config ACTUAL del restaurante, para que el comportamiento no cambie.
--
-- Además, un índice único PARCIAL como respaldo server-side de
-- "una caja = un turno abierto a la vez" (sólo cuando caja_id NO es NULL;
-- los turnos legacy con caja_id NULL no se ven afectados y pueden coexistir).
-- El cajero ya queda en turnos_caja.cajero_id/cajero_nombre y en
-- movimientos_caja.usuario_id/usuario_nombre (trazabilidad — sin cambios).
--
-- 100% ADITIVA + IDEMPOTENTE. No toca RLS ni grants (las columnas heredan los
-- de `cajas`, mig 126: anon sin acceso, escritura admin, lectura del local).
--
-- ⚠ PREPARED — aplicar manualmente en el SQL Editor (en INGLÉS) tras backup;
--   Claude Code NO aplica migraciones.
-- ════════════════════════════════════════════════════════════════════

-- ─── 1. Config por caja (NULL = heredar del restaurante) ─────────────
ALTER TABLE public.cajas
  ADD COLUMN IF NOT EXISTS cash_mode_default          text,
  ADD COLUMN IF NOT EXISTS cash_fondo_fijo            numeric,
  ADD COLUMN IF NOT EXISTS cash_diff_umbral           numeric,
  ADD COLUMN IF NOT EXISTS cash_auto_retiro_excedente boolean;

-- CHECK del modo (idempotente; permite NULL = heredar).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cajas_cash_mode_default_chk') THEN
    ALTER TABLE public.cajas
      ADD CONSTRAINT cajas_cash_mode_default_chk
      CHECK (cash_mode_default IS NULL OR cash_mode_default IN ('libre','fijo'));
  END IF;
END $$;

-- ─── 2. Backfill: cajas existentes heredan la config del restaurante ──
UPDATE public.cajas c
   SET cash_mode_default          = COALESCE(c.cash_mode_default,          r.cash_mode_default),
       cash_fondo_fijo            = COALESCE(c.cash_fondo_fijo,            r.cash_fondo_fijo),
       cash_diff_umbral           = COALESCE(c.cash_diff_umbral,           r.cash_diff_umbral),
       cash_auto_retiro_excedente = COALESCE(c.cash_auto_retiro_excedente, r.cash_auto_retiro_excedente)
  FROM public.restaurants r
 WHERE r.id = c.restaurant_id
   AND (c.cash_mode_default IS NULL OR c.cash_fondo_fijo IS NULL
        OR c.cash_diff_umbral IS NULL OR c.cash_auto_retiro_excedente IS NULL);

-- ─── 3. Backstop: un turno ABIERTO por caja (caja_id no nulo) ─────────
-- Permite varias cajas con turno abierto a la vez (cajeros distintos), pero
-- no dos turnos abiertos en la MISMA caja. Los NULL no chocan entre sí.
-- Defensivo: si hubiera una anomalía de datos (>1 abierto en una caja), no
-- abortamos la migración — se omite el índice con un NOTICE para revisión.
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_turno_abierto_por_caja
    ON public.turnos_caja (caja_id)
    WHERE estado = 'abierto' AND caja_id IS NOT NULL;
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'uniq_turno_abierto_por_caja NO creado: hay >1 turno abierto en una misma caja. Cerrá/reasigná esos turnos y reintentá.';
END $$;

NOTIFY pgrst, 'reload schema';
