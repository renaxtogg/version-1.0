-- ============================================================
-- 085 — Solicitud de factura desde paneles cliente
--   Agrega:
--     - invoice_delivery_method  ('print' | 'email' | NULL)
--     - invoice_requested_at     TIMESTAMPTZ (cuándo el cliente pidió)
--     - invoice_status           ('pending' | 'issued' | NULL)
--   Idempotente y compatible con migración 084.
-- ============================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS invoice_delivery_method TEXT,
  ADD COLUMN IF NOT EXISTS invoice_requested_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invoice_status          TEXT;

-- Mismo set de campos para delivery_orders (algunos flujos usan esa tabla)
ALTER TABLE public.delivery_orders
  ADD COLUMN IF NOT EXISTS requires_invoice         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS invoice_delivery_method  TEXT,
  ADD COLUMN IF NOT EXISTS invoice_customer_name    TEXT,
  ADD COLUMN IF NOT EXISTS invoice_customer_ruc     TEXT,
  ADD COLUMN IF NOT EXISTS invoice_customer_email   TEXT,
  ADD COLUMN IF NOT EXISTS invoice_requested_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invoice_status           TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_invoice_pending
  ON public.orders(restaurant_id, invoice_requested_at)
  WHERE requires_invoice = true AND (invoice_status IS NULL OR invoice_status = 'pending');

CREATE INDEX IF NOT EXISTS idx_delivery_orders_invoice_pending
  ON public.delivery_orders(restaurant_id, invoice_requested_at)
  WHERE requires_invoice = true AND (invoice_status IS NULL OR invoice_status = 'pending');

GRANT SELECT, UPDATE ON public.orders TO authenticated, anon;
GRANT SELECT, UPDATE ON public.delivery_orders TO authenticated, anon;
