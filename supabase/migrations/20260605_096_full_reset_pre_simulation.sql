-- ============================================================
-- Migración 096 — FULL RESET pre-simulación (estado de fábrica)
--
-- ⚠️⚠️  YA EJECUTADA EN PRODUCCIÓN VÍA MANAGEMENT API (2026-06-05).
--        NO RE-EJECUTAR sobre una base poblada: BORRA TODOS los
--        restaurantes, usuarios (excepto Renato) y datos operativos.
--        Se conserva como traza documental del reset previo a la
--        primera simulación del sistema multi-comercio.
--
-- Objetivo: dejar la plataforma vacía para cargar datos desde 0,
-- conservando SOLO el catálogo SaaS y al superadmin general.
--
-- CONSERVA:
--   ✓ subscription_plans   (Starter / Pro / Enterprise)
--   ✓ plan_addons          (delivery_cliente, delivery_rider, kds_cocina, sucursal_extra)
--   ✓ platform_config      (config global del SaaS, sin restaurant_id)
--   ✓ user_roles → SOLO Renato (superadmin general, restaurant_id = NULL)
--
-- BORRA:
--   ✗ TODOS los restaurantes (incl. el histórico 00000000-…-0001 "terrapizza")
--   ✗ Todos los usuarios excepto Renato (user_roles + auth.users)
--   ✗ Las 53 tablas operativas / de contenido (menú, mesas, órdenes,
--     caja, stock, delivery, riders, zonas, suscripciones, add-ons
--     por restaurante, reservas, staff, soporte, etc.)
--
-- Nota: Renato era superadmin pero tenía restaurant_id = 01; se lo
-- desató a NULL para que borrar el restaurante 01 no lo afecte.
-- No usa session_replication_role (Management API no lo permite):
-- TRUNCATE … CASCADE resuelve las FK.
-- ============================================================

-- ─── 1. Superadmin general: desatar de cualquier restaurante ───
UPDATE public.user_roles
   SET restaurant_id = NULL
 WHERE user_id = '0bfbf282-9513-42d2-9ac2-8e562315ac7a';   -- Renato / Renaxto

-- ─── 2. Eliminar el resto de usuarios (rol app) ────────────────
DELETE FROM public.user_roles
 WHERE user_id <> '0bfbf282-9513-42d2-9ac2-8e562315ac7a';

-- ─── 3. Vaciar todas las tablas operativas / de contenido ──────
DO $$
DECLARE
  tbl  TEXT;
  wipe TEXT[] := ARRAY[
    'availability_log','calendar_events','cancelaciones_caja','coupons',
    'delivery_channels','delivery_orders','delivery_riders','delivery_zones',
    'employee_shifts','expenses','ingredients','item_86_list','kitchen_messages',
    'kitchen_station_categories','kitchen_station_zonas','kitchen_stations',
    'manager_approvals','menu_categories','menu_item_extras','menu_items',
    'movimientos_caja','order_item_extras','order_item_station_log','order_items',
    'order_status_history','orders','payments','platform_events','quejas_sugerencias',
    'ratings','recipes','reservations','restaurant_addons','restaurant_settings',
    'shift_logs','staff_broadcasts','staff_payroll_adjustments','staff_requests',
    'stock_alerts','stock_movements','stock_session_items','stock_sessions',
    'subscriptions','supplier_contacts','supplier_purchases','suppliers',
    'support_messages','support_tickets','table_scan_sessions','tables',
    'turnos_caja','waiter_calls','waiter_debts'
  ];
BEGIN
  FOREACH tbl IN ARRAY wipe LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema='public' AND table_name=tbl) THEN
      EXECUTE format('TRUNCATE TABLE public.%I CASCADE', tbl);
      RAISE NOTICE 'Truncated: %', tbl;
    END IF;
  END LOOP;
END$$;

-- ─── 4. Eliminar todos los restaurantes (incl. el 01) ──────────
DELETE FROM public.restaurants;

-- ─── 5. Eliminar usuarios de auth huérfanos (excepto Renato) ───
DELETE FROM auth.users
 WHERE id <> '0bfbf282-9513-42d2-9ac2-8e562315ac7a';

DO $$
BEGIN
  RAISE NOTICE '✓ Full reset 096 completado — plataforma vacía, planes/catálogo y superadmin conservados';
END$$;
