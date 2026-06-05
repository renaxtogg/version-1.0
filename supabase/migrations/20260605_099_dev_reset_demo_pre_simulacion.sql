-- ============================================================
-- Migración 099 — Reset de datos DEMO/operativos pre-simulación
--
-- Contexto: tras el reset de fábrica 096 se cargaron datos reales
-- (restaurante, usuarios, rider, suscripción). Durante las pruebas
-- quedaron rastros DEMO/operativos sueltos (p. ej. un pedido fantasma
-- T-67455 de ₲12.000 sin items, generado por el menú demo viejo del
-- panel cliente — ya corregido). Esta migración deja la base IMPECABLE
-- para la primera simulación, SIN tocar nada creado por el dueño.
--
-- CONSERVA (NO se borra):
--   ✓ restaurants            (el/los locales creados)
--   ✓ user_roles + auth.users (TODOS los usuarios creados)
--   ✓ menu_categories / menu_items / menu_item_extras (la carta)
--   ✓ tables (mesas)         · delivery_zones · delivery_riders
--   ✓ kitchen_stations · coupons · ingredients · recipes · suppliers
--   ✓ caja_config (fondo fijo) · restaurant_settings · reservation_settings
--   ✓ subscription_plans · plan_addons · subscriptions · restaurant_addons
--   ✓ platform_config
--
-- BORRA (operativo/demo, TODOS los tenants):
--   ✗ orders + order_items + order_item_extras + order_status_history (+ station_log)
--   ✗ payments · delivery_orders
--   ✗ turnos_caja · movimientos_caja · cancelaciones_caja · waiter_debts
--   ✗ waiter_calls · ratings · reservations
--   ✗ stock_movements · stock_session_items · stock_sessions · stock_alerts
--   ✗ expenses · employee_shifts · shift_logs
--   ✗ staff_sessions (logins de prueba) · staff_requests · staff_broadcasts
--   ✗ table_scan_sessions · calendar_events · quejas_sugerencias · platform_events
--   ✗ manager_approvals · staff_payroll_adjustments · availability_log · kitchen_messages
--
-- Cada TRUNCATE va guardado con IF EXISTS (Management API: una tabla
-- inexistente en un TRUNCATE devuelve 400). TRUNCATE ... CASCADE resuelve
-- las FK sin necesitar session_replication_role (no permitido vía API).
-- ============================================================

DO $$
DECLARE
  tbl TEXT;
  tables_to_reset TEXT[] := ARRAY[
    'order_item_station_log',
    'order_status_history',
    'order_item_extras',
    'order_items',
    'orders',
    'payments',
    'delivery_orders',
    'cancelaciones_caja',
    'movimientos_caja',
    'turnos_caja',
    'waiter_debts',
    'waiter_calls',
    'ratings',
    'reservations',
    'stock_movements',
    'stock_session_items',
    'stock_sessions',
    'stock_alerts',
    'expenses',
    'shift_logs',
    'employee_shifts',
    'staff_sessions',
    'staff_requests',
    'staff_broadcasts',
    'table_scan_sessions',
    'calendar_events',
    'quejas_sugerencias',
    'platform_events',
    'manager_approvals',
    'staff_payroll_adjustments',
    'availability_log',
    'kitchen_messages'
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

-- Liberar TODAS las mesas (por si alguna quedó ocupada en pruebas)
UPDATE public.tables
SET is_occupied          = false,
    occupied_since       = NULL,
    assigned_waiter_name = NULL;

DO $$
BEGIN
  RAISE NOTICE '✓ Reset 099 completado — demo/operativo eliminado, restaurante/usuarios/carta/suscripción conservados';
END$$;
