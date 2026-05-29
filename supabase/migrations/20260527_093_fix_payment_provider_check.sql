-- ============================================================
-- Migración 093 — Fix CHECK de orders.payment_provider
-- Corrige el constraint roto de la migración 087:
--   CHECK (payment_provider IN ('bancard','tigo_money', NULL))
-- Meter NULL dentro del IN(...) hace que un valor inválido
-- evalúe a NULL (no FALSE), y Postgres ACEPTA los CHECK que dan
-- NULL → el constraint no rechazaba nada.
--
-- Forma correcta:
--   CHECK (payment_provider IN ('bancard','tigo_money')
--          OR payment_provider IS NULL)
--
-- Idempotente: funciona se haya ejecutado o no la 087.
-- EJECUTAR EN SUPABASE SQL EDITOR (dashboard en inglés)
-- ============================================================

-- ── 1. Garantizar que la columna exista (por si la 087 no corrió) ──
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS payment_provider TEXT,
  ADD COLUMN IF NOT EXISTS payment_ref TEXT;

-- ── 2. Eliminar cualquier CHECK previo sobre payment_provider ──────
-- Cubre el constraint auto-nombrado por la 087 y cualquier variante.
DO $$
DECLARE con RECORD;
BEGIN
  FOR con IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class       t ON t.oid = c.conrelid
      JOIN pg_namespace   n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'orders'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%payment_provider%'
  LOOP
    EXECUTE format('ALTER TABLE public.orders DROP CONSTRAINT %I', con.conname);
    RAISE NOTICE 'Dropped CHECK: %', con.conname;
  END LOOP;
END$$;

-- ── 3. Recrear el constraint con la semántica correcta ─────────────
ALTER TABLE public.orders
  ADD CONSTRAINT orders_payment_provider_check
  CHECK (payment_provider IN ('bancard', 'tigo_money')
         OR payment_provider IS NULL);

DO $$
BEGIN
  RAISE NOTICE '✓ Migración 093 aplicada — CHECK de payment_provider corregido';
END$$;
