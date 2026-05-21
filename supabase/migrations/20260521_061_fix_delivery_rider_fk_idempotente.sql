-- Migración 061: garantizar FK delivery_orders.rider_id → delivery_riders(id)
-- Idempotente: DROP IF EXISTS + ADD. Corrige el caso donde 059 no fue ejecutada
-- o donde el constraint antiguo (auth.users) sigue presente.
-- Sin esta FK correcta, autoAssignRider falla silenciosamente y los riders
-- nunca reciben pedidos.

ALTER TABLE delivery_orders DROP CONSTRAINT IF EXISTS delivery_orders_rider_id_fkey;

ALTER TABLE delivery_orders
  ADD CONSTRAINT delivery_orders_rider_id_fkey
  FOREIGN KEY (rider_id) REFERENCES delivery_riders(id) ON DELETE SET NULL;

NOTIFY pgrst, 'reload schema';
