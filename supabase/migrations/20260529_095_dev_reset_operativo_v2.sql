-- ============================================================
-- Migración 095 — Dev Reset Operativo v2
-- Reset tras bugfix de "Pedir más" en mozo (lomito nuevo entraba
-- como entregado/cobro pte. sin pasar por cocina).
--
-- Vacía tablas de datos operativos conservando:
--   ✓  restaurants / restaurante seed (todos los tenants)
--   ✓  user_roles / usuarios
--   ✓  menu_categories / menu_items / menu_item_extras
--   ✓  tables (mesas)
--   ✓  delivery_zones / delivery_riders
--   ✓  kitchen_stations
--   ✓  caja_config / fondo fijo
--   ✓  reservation_settings
-- Borra (operativo, TODOS los tenants):
--   ✗  orders, order_items, order_item_extras, order_status_history
--   ✗  movimientos_caja, turnos_caja, cancelaciones_caja
--   ✗  waiter_calls, ratings, reservations
--   ✗  stock_movements, stock_sessions, stock_alerts
--   ✗  expenses, employee_shifts, table_scan_sessions
--   ✗  staff_requests, staff_broadcasts, calendar_events
--   ✗  quejas_sugerencias, platform_events
--
-- Difiere de la 089: libera mesas de TODOS los restaurantes
-- (no solo el seed) — el entorno tiene varios tenants de prueba.
-- No usa session_replication_role: TRUNCATE ... CASCADE resuelve
-- las FK y así corre también vía Management API (que no permite
-- ese toggle).
-- ============================================================

DO $$
DECLARE
  tbl TEXT;
  tables_to_reset TEXT[] := ARRAY[
    'order_status_history',
    'order_item_extras',
    'order_items',
    'orders',
    'movimientos_caja',
    'cancelaciones_caja',
    'turnos_caja',
    'waiter_calls',
    'ratings',
    'reservations',
    'stock_movements',
    'stock_sessions',
    'stock_alerts',
    'expenses',
    'employee_shifts',
    'support_chat',
    'table_scan_sessions',
    'invoice_request',
    'staff_requests',
    'staff_broadcasts',
    'calendar_events',
    'quejas_sugerencias',
    'platform_events'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables_to_reset LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      EXECUTE format('TRUNCATE TABLE public.%I CASCADE', tbl);
      RAISE NOTICE 'Truncated: %', tbl;
    ELSE
      RAISE NOTICE 'Skipped (no existe): %', tbl;
    END IF;
  END LOOP;
END$$;

-- Liberar TODAS las mesas (todos los tenants)
UPDATE public.tables
SET is_occupied          = false,
    occupied_since       = NULL,
    assigned_waiter_name = NULL;

DO $$
BEGIN
  RAISE NOTICE '✓ Reset operativo v2 completado — seed conservado, datos operativos eliminados';
END$$;
