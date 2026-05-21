-- Migración 057: Flujo Delivery v2
-- Auto-asignación de rider por round-robin cuando cocina marca el pedido como listo.
-- El cliente ve "En camino" solo cuando el rider inicia su ruta.
-- El cliente ve "Entregado" solo cuando el rider confirma la entrega.

-- 1. Asegurar columna assigned_at antes de crear el índice
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

-- 2. Índice para consulta round-robin (último pedido asignado por rider)
CREATE INDEX IF NOT EXISTS idx_delivery_orders_rider_assigned
  ON delivery_orders(rider_id, assigned_at);

-- 3. Seed riders demo para La Huaca si aún no tiene ninguno
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM delivery_riders
    WHERE restaurant_id = '00000000-0000-0000-0000-000000000001'
      AND active = true
  ) THEN
    INSERT INTO delivery_riders
      (restaurant_id, name, phone, vehicle, commission_type, commission_value, current_status, active, rider_pin)
    VALUES
      ('00000000-0000-0000-0000-000000000001', 'Joel Ramírez',  '+595 981 111 111', 'moto', 'fixed', 5000, 'disponible', true, '1111'),
      ('00000000-0000-0000-0000-000000000001', 'Juan Méndez',   '+595 982 222 222', 'moto', 'fixed', 5000, 'disponible', true, '2222'),
      ('00000000-0000-0000-0000-000000000001', 'Carlos García', '+595 983 333 333', 'moto', 'fixed', 5000, 'disponible', true, '3333');
  END IF;
END $$;

-- 4. Comentario: rider_status flow
-- pending   → orden creada, sin rider
-- confirmed → rider asignado por cocina, esperando retiro en local
-- on_way    → rider inició ruta, cliente ve "En camino"
-- delivered → rider entregó, cliente ve "Entregado"
-- cancelled → orden cancelada
