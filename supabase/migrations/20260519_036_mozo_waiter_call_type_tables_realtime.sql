-- ═══════════════════════════════════════════════════════════
-- MIGRACIÓN 036 — MOZO: tipo de llamada + realtime tables
-- 1. Agrega columna type a waiter_calls (payment_request / assistance)
-- 2. Habilita realtime para la tabla tables
-- EJECUTAR EN SUPABASE SQL EDITOR (dashboard en inglés)
-- ═══════════════════════════════════════════════════════════

-- ─── 1. COLUMNA TYPE EN WAITER_CALLS ─────────────────────────
ALTER TABLE public.waiter_calls
  ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'assistance'
    CHECK (type IN ('assistance', 'payment_request'));

-- ─── 2. REALTIME PARA TABLES ─────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'tables'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tables;
  END IF;
END $$;
