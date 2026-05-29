-- ============================================================
-- Migración 088 — Superadmin RLS bypass
-- Agrega políticas BYPASS para el rol 'superadmin' en las
-- tablas operativas bloqueadas por la migración 086.
--
-- Estrategia: si get_my_role() = 'superadmin' → acceso total.
-- Las políticas existentes (por restaurant_id) se mantienen;
-- las nuevas se agregan como OR implícito (RLS usa OR entre
-- políticas del mismo comando).
--
-- EJECUTAR EN SUPABASE SQL EDITOR (dashboard en inglés)
-- ============================================================

-- ── Tablas a parchear ────────────────────────────────────────
-- orders, order_items, tables, movimientos_caja, turnos_caja,
-- waiter_calls, ratings, reservations, kitchen_stations,
-- delivery_orders, delivery_riders, stock_movements,
-- ingredients, recipes, stock_alerts, stock_sessions,
-- expenses, employee_shifts, staff_requests, staff_broadcasts,
-- calendar_events, support_chat, table_scan_sessions,
-- invoice_request, cancelaciones_caja, quejas_sugerencias

DO $$
DECLARE
  tbl TEXT;
  tables_list TEXT[] := ARRAY[
    'orders','order_items','tables','movimientos_caja','turnos_caja',
    'waiter_calls','ratings','reservations','kitchen_stations',
    'delivery_orders','delivery_riders','stock_movements',
    'ingredients','recipes','stock_alerts','stock_sessions',
    'expenses','employee_shifts','staff_requests','staff_broadcasts',
    'calendar_events','support_chat','table_scan_sessions',
    'invoice_request','cancelaciones_caja','quejas_sugerencias',
    'caja_config','delivery_zones','menu_categories','menu_items',
    'menu_item_extras','coupons'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables_list LOOP
    -- Verificar que la tabla existe antes de operar sobre ella
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      -- SELECT
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = tbl AND schemaname = 'public'
          AND policyname = tbl || '_superadmin_all'
      ) THEN
        EXECUTE format(
          $p$CREATE POLICY %I ON public.%I
            FOR ALL TO authenticated
            USING  (public.get_my_role() = 'superadmin')
            WITH CHECK (public.get_my_role() = 'superadmin')$p$,
          tbl || '_superadmin_all', tbl
        );
      END IF;
    END IF;
  END LOOP;
END$$;

-- Confirmar
DO $$
BEGIN
  RAISE NOTICE 'Migración 088 aplicada — superadmin bypass activo en tablas operativas';
END$$;
