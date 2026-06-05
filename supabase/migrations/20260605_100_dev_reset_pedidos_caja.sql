-- ============================================================
-- Migración 100 — Reset de PEDIDOS + CAJA (post-bugfix login caja)
--
-- Contexto: se corrigió el dead-end del login de caja (caja abierta sin
-- cierre por la sesión anterior → ahora el cajero puede retomar/arquear,
-- y el mismo cajero reconecta sin re-hacer la apertura). Durante las
-- pruebas quedaron PEDIDOS de prueba y TURNOS DE CAJA abiertos sueltos.
-- Esta migración limpia esos datos para empezar la simulación impecable.
--
-- Acotada a "pedidos + caja" (el reset 099 ya dejó limpio el resto).
--
-- CONSERVA (NO se borra):
--   ✓ restaurants · user_roles + auth.users · carta (menu_*) · tables
--   ✓ delivery_zones · delivery_riders · kitchen_stations · coupons
--   ✓ caja_config (fondo fijo) · suscripciones/planes/add-ons
--   ✓ stock/ingredients/recipes · staff_sessions · reservations · calendar
--
-- BORRA (operativo de pedidos + caja, TODOS los tenants):
--   ✗ orders + order_items + order_item_extras + order_status_history (+ station_log)
--   ✗ payments · delivery_orders
--   ✗ turnos_caja · movimientos_caja · cancelaciones_caja
--   ✗ waiter_calls · waiter_debts · ratings · table_scan_sessions
--
-- Patrón idéntico a 099: IF EXISTS + TRUNCATE ... CASCADE (el rol del
-- Management API no puede SET session_replication_role).
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
    'table_scan_sessions'
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
  RAISE NOTICE '✓ Reset 100 completado — pedidos + caja eliminados; resto conservado';
END$$;
