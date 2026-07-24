-- ============================================================
-- Migración 190 — Reset operativo (post-bugfix ruteo de ESTACIONES en cocina)
--
-- Contexto: se corrigió el ruteo del KDS — la "cocina general" mostraba
-- también los ítems que ya prepara una estación dedicada (bar/cocina de
-- terraza, salón privado, etc.). Ahora la cocina central excluye lo que
-- reclama una estación propia. Antes de desplegar un bugfix que toca el
-- flujo de órdenes/cocina se limpian los datos operativos de prueba para
-- empezar impecable (regla del CLAUDE.md).
--
-- CONSERVA (NO se borra):
--   ✓ restaurants · user_roles + auth.users · carta (menu_*)
--   ✓ tables · delivery_zones · delivery_riders · kitchen_stations (+ cat/zonas)
--   ✓ caja_config (fondo fijo) · coupons · suscripciones/planes/add-ons
--   ✓ stock/ingredients/recipes · reservations · calendar · frequent_customers
--
-- BORRA (operativo de pedidos + caja, TODOS los tenants):
--   ✗ orders + order_items + order_item_extras + order_status_history (+ station_log)
--   ✗ payments · payment_reviews · delivery_orders
--   ✗ turnos_caja · movimientos_caja · cancelaciones_caja
--   ✗ waiter_calls · waiter_debts · ratings · table_scan_sessions
--
-- Patrón idéntico a 099/100: IF EXISTS + TRUNCATE ... CASCADE (el rol del
-- Management API no puede SET session_replication_role). El reset NO toca
-- el ruteo por estación (kitchen_stations/kitchen_station_categories/
-- kitchen_station_zonas se conservan) — solo limpia órdenes de prueba.
-- ============================================================

DO $$
DECLARE
  tbl TEXT;
  tables_to_reset TEXT[] := ARRAY[
    'order_item_station_log',
    'order_status_history',
    'order_item_extras',
    'order_items',
    'payment_reviews',
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
  RAISE NOTICE '✓ Reset 190 completado — pedidos + caja eliminados; carta/usuarios/estaciones/zonas/riders conservados';
END$$;
