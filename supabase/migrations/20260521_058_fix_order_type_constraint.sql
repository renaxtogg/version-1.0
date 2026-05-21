-- Migración 058: Asegurar que orders.order_type acepta 'delivery', 'pickup', 'mesa', 'counter'
-- Las migraciones 030 y 039 ya definían esto, pero pueden no haber sido aplicadas.
-- Esta migración es idempotente: recrea el constraint con todos los valores válidos.

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_type_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_order_type_check
  CHECK (order_type IN ('local', 'llevar', 'delivery', 'pickup', 'mesa', 'counter'));
