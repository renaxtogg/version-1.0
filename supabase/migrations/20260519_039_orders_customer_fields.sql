-- Migración 039: campos de cliente en orders para marketing y CRM
-- customer_phone: teléfono del cliente
-- requires_invoice: si el cliente pidió factura
-- delivery_notes: notas de entrega (para pickup y delivery)

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS customer_phone  TEXT,
  ADD COLUMN IF NOT EXISTS requires_invoice BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS delivery_notes  TEXT;

-- Asegurar que mesa también sea un order_type válido
-- (mozo inserta 'local' pero index.html puede insertar 'mesa')
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_type_check;
ALTER TABLE orders
  ADD CONSTRAINT orders_order_type_check
  CHECK (order_type IN ('local', 'llevar', 'delivery', 'pickup', 'mesa', 'counter'));

-- Índice para búsquedas por teléfono de cliente
CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders(customer_phone);
CREATE INDEX IF NOT EXISTS idx_orders_requires_invoice ON orders(requires_invoice) WHERE requires_invoice = true;
