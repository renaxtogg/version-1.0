-- ============================================================
-- Migración 089 — Dev Reset Operativo
-- Vacía tablas de datos operativos conservando:
--   ✓  restaurants / restaurante seed
--   ✓  user_roles / usuarios
--   ✓  menu_categories / menu_items / menu_item_extras
--   ✓  tables (mesas)
--   ✓  delivery_zones / delivery_riders
--   ✓  kitchen_stations
--   ✓  caja_config / fondo fijo
--   ✓  reservation_settings
-- Borra:
--   ✗  orders, order_items, order_item_extras
--   ✗  order_status_history
--   ✗  movimientos_caja, turnos_caja, cancelaciones_caja
--   ✗  waiter_calls
--   ✗  ratings
--   ✗  reservations
--   ✗  stock_movements, stock_sessions, stock_alerts
--   ✗  expenses
--   ✗  employee_shifts
--   ✗  support_chat
--   ✗  table_scan_sessions
--   ✗  invoice_request
--   ✗  staff_requests, staff_broadcasts
--   ✗  calendar_events
--   ✗  quejas_sugerencias
--   ✗  platform_events
--
-- EJECUTAR EN SUPABASE SQL EDITOR (dashboard en inglés)
-- ============================================================

SET session_replication_role = 'replica';

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

-- Liberar todas las mesas
UPDATE public.tables
SET is_occupied        = false,
    occupied_since     = NULL,
    assigned_waiter_name = NULL
WHERE restaurant_id = '00000000-0000-0000-0000-000000000001';

SET session_replication_role = 'origin';

DO $$
BEGIN
  RAISE NOTICE '✓ Reset operativo completado — seed conservado, datos operativos eliminados';
END$$;
