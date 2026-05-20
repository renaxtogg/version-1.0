-- ============================================================
-- 044 — Campos faltantes en orders: waiter_id, paid_by, paid_at
-- La migración 038 no se aplicó en producción; esta los agrega
-- de forma idempotente con ADD COLUMN IF NOT EXISTS.
-- ============================================================

-- Mozo que creó la orden
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS waiter_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Quién registró el cobro y cuándo (mozo o cajero)
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS paid_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

-- Nombre snapshot del mozo/cajero que cobró (para historial sin JOIN)
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS paid_by_name TEXT;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS waiter_name TEXT;

-- Índices útiles para reportes de turno
CREATE INDEX IF NOT EXISTS idx_orders_waiter_id ON public.orders(waiter_id);
CREATE INDEX IF NOT EXISTS idx_orders_paid_by   ON public.orders(paid_by);

-- Ampliar el CHECK de payment_method para incluir pos_mesa y transferencia
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_payment_method_check
  CHECK (payment_method IN ('efectivo','tarjeta','qr','pos','pos_mesa','transferencia'));

-- Ampliar CHECK de status para incluir pending_payment
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN (
    'draft','confirmed','paid','pending_payment',
    'kitchen_received','cooking','ready','delivered','cancelled'
  ));

-- Grants
GRANT SELECT, UPDATE ON public.orders TO authenticated, anon;
