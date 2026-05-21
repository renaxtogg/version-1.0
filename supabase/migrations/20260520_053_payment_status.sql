-- Separar estado de pago del estado de elaboración del pedido
-- El campo payment_status rastrea si caja cobró el efectivo/tarjeta
-- independientemente de si el pedido está siendo preparado en cocina

ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid'
  CHECK (payment_status IN ('unpaid', 'paid'));

-- Backfill: pedidos con movimiento de cobro ya registrado → paid
UPDATE orders SET payment_status = 'paid'
WHERE id IN (
  SELECT DISTINCT pedido_id FROM movimientos_caja
  WHERE tipo = 'cobro' AND pedido_id IS NOT NULL
);

-- Backfill: pedidos delivered sin movimiento de cobro explícito → paid
-- (en el flujo anterior, delivered significaba que fue cobrado)
UPDATE orders SET payment_status = 'paid'
WHERE status = 'delivered' AND payment_status = 'unpaid';
