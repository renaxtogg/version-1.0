-- Migración 059: Corregir FK de delivery_orders.rider_id
-- El FK apuntaba a auth.users(id) pero los delivery_riders tienen su propio UUID.
-- Esto causaba que autoAssignRider fallara silenciosamente al intentar el UPDATE.
-- Como el FK viejo impedía asignar, rider_id ya es NULL en todos los registros —
-- no hace falta limpiar nada, solo reemplazar el constraint.

-- 1. Eliminar FK viejo (auth.users)
ALTER TABLE delivery_orders DROP CONSTRAINT IF EXISTS delivery_orders_rider_id_fkey;

-- 2. Agregar FK correcto apuntando a delivery_riders
ALTER TABLE delivery_orders
  ADD CONSTRAINT delivery_orders_rider_id_fkey
  FOREIGN KEY (rider_id) REFERENCES delivery_riders(id) ON DELETE SET NULL;

NOTIFY pgrst, 'reload schema';
