-- ============================================================
-- 084 — Fix idempotente: agregar requires_invoice y campos de
--       cliente a orders si no existen (migración 039 puede
--       no haberse aplicado en prod; esto lo garantiza).
-- ============================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS requires_invoice BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS customer_phone   TEXT,
  ADD COLUMN IF NOT EXISTS delivery_notes   TEXT;

-- Índice útil para reportes de facturación
CREATE INDEX IF NOT EXISTS idx_orders_requires_invoice
  ON public.orders(requires_invoice)
  WHERE requires_invoice = true;

GRANT SELECT, UPDATE ON public.orders TO authenticated, anon;
