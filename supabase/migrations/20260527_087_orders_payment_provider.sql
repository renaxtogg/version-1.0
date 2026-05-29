-- ============================================================
-- Migración 087 — orders.payment_provider
-- Prepara la tabla orders para integraciones de pago:
--   • payment_provider  → 'bancard' | 'tigo_money' | NULL (efectivo)
--   • payment_ref       → referencia externa (transaction_id / token)
-- ============================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS payment_provider TEXT
    CHECK (payment_provider IN ('bancard', 'tigo_money', NULL)),
  ADD COLUMN IF NOT EXISTS payment_ref TEXT;

COMMENT ON COLUMN public.orders.payment_provider IS
  'Proveedor de pago electrónico: bancard | tigo_money | NULL (efectivo/sin especificar)';
COMMENT ON COLUMN public.orders.payment_ref IS
  'Referencia externa del proveedor (transaction_id, confirmation_code, etc.)';

-- Índice para reportes por proveedor
CREATE INDEX IF NOT EXISTS idx_orders_payment_provider
  ON public.orders(restaurant_id, payment_provider)
  WHERE payment_provider IS NOT NULL;
