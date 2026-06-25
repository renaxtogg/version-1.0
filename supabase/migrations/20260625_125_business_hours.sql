-- ════════════════════════════════════════════════════════════════════
-- 125 · business_hours · Horario ESTRUCTURADO computable + override manual
-- ────────────────────────────────────────────────────────────────────
-- Hoy el "Abierto/Cerrado" del cliente es un HEURÍSTICO HARDCODEADO y el badge
-- es cosmético (no bloquea el pedido). `opening_hours` se guarda como TEXTO LIBRE
-- → no computable. Esta migración agrega un horario estructurado por día y un
-- override manual del dueño, para que el cliente (QR + delivery) pueda calcular
-- "abierto ahora" de forma confiable y BLOQUEAR el pedido fuera de horario.
--
--   business_hours JSONB:
--     { "0":[{"start":"HH:MM","end":"HH:MM"}], ... "6":[...] }   (0=Dom … 6=Sáb)
--     · varios rangos por día (turnos partidos)
--     · cruce de medianoche soportado: end < start ⇒ el turno sigue al día siguiente
--     · NULL / vacío ⇒ el cliente degrada a ABIERTO (no bloquea ventas por falta de dato)
--
--   open_override TEXT ('auto' | 'open' | 'closed'), default 'auto':
--     · 'auto'   → seguir el horario (business_hours) en la zona horaria del local
--     · 'open'   → forzar ABIERTO  (gana al horario)
--     · 'closed' → forzar CERRADO  (feriados/imprevistos; gana al horario)
--
-- `opening_hours` (texto) se mantiene SOLO para mostrar; el admin lo deriva del
-- horario estructurado. `is_open` (mig 082) queda como estaba (marca SaaS del
-- superadmin); el override real del dueño pasa a ser open_override.
-- La zona horaria sale de restaurants.timezone (default America/Asuncion).
--
-- 100% ADITIVA + IDEMPOTENTE. anon SOLO lectura (para cotizar el estado); la
-- escritura es del admin por la RLS de restaurants ya vigente. No se otorga
-- ninguna escritura nueva a anon (alineado al lockdown anon).
--
-- ⚠ PREPARED — aplicar manualmente en el SQL Editor (en INGLÉS) tras backup;
--   Claude Code NO aplica migraciones.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS business_hours JSONB;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS open_override  TEXT NOT NULL DEFAULT 'auto';

-- CHECK del override (idempotente: sólo se crea si no existe).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'restaurants_open_override_chk'
  ) THEN
    ALTER TABLE public.restaurants
      ADD CONSTRAINT restaurants_open_override_chk
      CHECK (open_override IN ('auto','open','closed'));
  END IF;
END $$;

-- Lectura pública (anon incluido): el cliente necesita estas columnas para
-- calcular "abierto ahora". No son PII. Escritura sólo authenticated (RLS manda).
GRANT SELECT (business_hours, open_override) ON public.restaurants TO anon, authenticated;
GRANT UPDATE (business_hours, open_override) ON public.restaurants TO authenticated;

NOTIFY pgrst, 'reload schema';
