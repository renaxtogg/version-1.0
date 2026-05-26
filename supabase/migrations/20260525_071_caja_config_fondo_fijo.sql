-- ============================================================
-- 071 — Caja: configuración de fondo fijo + cierre con retiro automático
-- ============================================================
-- Permite al admin configurar:
--   * cash_mode_default: 'fijo' | 'libre'    (modo sugerido al abrir)
--   * cash_fondo_fijo:  monto fijo de apertura (p.ej. ₲ 500.000)
--   * cash_diff_umbral: umbral en ₲ para exigir justificación
--   * cash_auto_retiro_excedente: si al cerrar se genera retiro automático del excedente
-- Y en cada turno guardamos qué modo se usó y el monto fijo de referencia.

-- Settings por restaurante
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS cash_mode_default          text    NOT NULL DEFAULT 'libre'
    CHECK (cash_mode_default IN ('libre','fijo')),
  ADD COLUMN IF NOT EXISTS cash_fondo_fijo            numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cash_diff_umbral           numeric NOT NULL DEFAULT 50000,
  ADD COLUMN IF NOT EXISTS cash_auto_retiro_excedente boolean NOT NULL DEFAULT false;

-- Por turno: snapshot del modo y monto fijo al momento de abrir
ALTER TABLE public.turnos_caja
  ADD COLUMN IF NOT EXISTS modo_apertura      text
    CHECK (modo_apertura IN ('libre','fijo')),
  ADD COLUMN IF NOT EXISTS fondo_fijo_objetivo numeric;
