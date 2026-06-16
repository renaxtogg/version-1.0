-- ════════════════════════════════════════════════════════════════════
-- DRY-RUN — Inventario de datos de simulación (SOLO LECTURA)
-- ────────────────────────────────────────────────────────────────────
-- PR-14. Este archivo SOLO hace SELECT/count(*). NO modifica nada.
-- Es SEGURO de correr en producción (dashboard SQL en inglés, o psql/pooler).
-- Su salida es el insumo para decidir el teardown. NO ejecuta teardown.
--
-- Allowlist de restaurantes de simulación (única fuente de verdad):
--   a1a10000-0000-4000-8000-000000000001  (Bella Napoli)
--   b2b20000-0000-4000-8000-000000000002  (Sushi Sakura)
--   c3c30000-0000-4000-8000-000000000003  (Parrilla Don Carlos)
-- Terrapizza NO está en la allowlist → fuera de alcance por construcción.
-- ════════════════════════════════════════════════════════════════════

-- ── 1) Prueba de exclusión de Terrapizza + panorama de restaurantes ──
-- Lista TODOS los restaurantes marcando cuáles caerían (sim) y cuáles sobreviven.
-- Terrapizza DEBE aparecer con sim=false (sobreviviente).
SELECT
  r.id,
  r.name,
  (r.id IN (
     'a1a10000-0000-4000-8000-000000000001',
     'b2b20000-0000-4000-8000-000000000002',
     'c3c30000-0000-4000-8000-000000000003'
  )) AS es_simulacion,
  (r.name ILIKE '%terrapizza%') AS es_terrapizza
FROM public.restaurants r
ORDER BY es_simulacion DESC, r.name;

-- ── 2) Chequeo de umbrales / sanidad (lo que el teardown exige) ──
SELECT
  (SELECT count(*) FROM public.restaurants) AS restaurants_total,
  (SELECT count(*) FROM public.restaurants
     WHERE id IN ('a1a10000-0000-4000-8000-000000000001',
                  'b2b20000-0000-4000-8000-000000000002',
                  'c3c30000-0000-4000-8000-000000000003')) AS sim_restaurants,        -- DEBE ser 3
  (SELECT count(*) FROM public.restaurants
     WHERE id IN ('a1a10000-0000-4000-8000-000000000001',
                  'b2b20000-0000-4000-8000-000000000002',
                  'c3c30000-0000-4000-8000-000000000003')
       AND name ILIKE '%terrapizza%') AS terrapizza_en_allowlist,                     -- DEBE ser 0
  (SELECT count(*) FROM public.restaurants WHERE name ILIKE '%terrapizza%') AS terrapizza_present; -- DEBE ser >= 1

-- ── 3) Usuarios candidatos (LISTADO para revisión humana) ──
-- Marcador seguro: @mythos.test  OR  con rol en restaurante sim,
-- MINUS cualquiera con rol en restaurante NO-sim (protege staff real / Terrapizza / Renato).
WITH sim AS (
  SELECT unnest(ARRAY[
    'a1a10000-0000-4000-8000-000000000001',
    'b2b20000-0000-4000-8000-000000000002',
    'c3c30000-0000-4000-8000-000000000003'
  ]::uuid[]) AS id
),
cand AS (
  SELECT u.id, u.email
  FROM auth.users u
  WHERE u.email LIKE '%@mythos.test'
     OR EXISTS (SELECT 1 FROM public.user_roles ur
                WHERE ur.user_id = u.id AND ur.restaurant_id IN (SELECT id FROM sim))
),
protegidos AS (  -- usuarios con rol en algún restaurante NO-sim → NO borrar
  SELECT DISTINCT ur.user_id
  FROM public.user_roles ur
  WHERE ur.restaurant_id IS NOT NULL
    AND ur.restaurant_id NOT IN (SELECT id FROM sim)
)
SELECT
  c.email,
  (c.id IN (SELECT user_id FROM protegidos)) AS protegido_no_borrar,
  (c.email LIKE '%@mythos.internal') AS dominio_internal
FROM cand c
ORDER BY protegido_no_borrar DESC, c.email;

-- ── 4) Conteo de filas a borrar por tabla (resumen) ──
WITH sim(id) AS (
  VALUES ('a1a10000-0000-4000-8000-000000000001'::uuid),
         ('b2b20000-0000-4000-8000-000000000002'::uuid),
         ('c3c30000-0000-4000-8000-000000000003'::uuid)
),
simord AS (SELECT id FROM public.orders WHERE restaurant_id IN (SELECT id FROM sim)),
simoi  AS (SELECT id FROM public.order_items WHERE order_id IN (SELECT id FROM simord))
SELECT t.tabla, t.filas FROM (
  -- Núcleo de pedidos (por restaurant_id o vía padre)
  SELECT 'orders'                AS tabla, (SELECT count(*) FROM simord) AS filas
  UNION ALL SELECT 'order_items',          (SELECT count(*) FROM simoi)
  UNION ALL SELECT 'order_item_extras',    (SELECT count(*) FROM public.order_item_extras WHERE order_item_id IN (SELECT id FROM simoi))
  UNION ALL SELECT 'order_status_history', (SELECT count(*) FROM public.order_status_history WHERE order_id IN (SELECT id FROM simord))
  UNION ALL SELECT 'order_item_station_log',(SELECT count(*) FROM public.order_item_station_log WHERE order_item_id IN (SELECT id FROM simoi))
  UNION ALL SELECT 'payments',             (SELECT count(*) FROM public.payments WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'delivery_orders',      (SELECT count(*) FROM public.delivery_orders WHERE restaurant_id IN (SELECT id FROM sim))
  -- Tenant directo (restaurant_id) — todas CASCADE salvo nota
  UNION ALL SELECT 'delivery_riders',      (SELECT count(*) FROM public.delivery_riders WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'delivery_zones',       (SELECT count(*) FROM public.delivery_zones WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'tables',               (SELECT count(*) FROM public.tables WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'menu_items',           (SELECT count(*) FROM public.menu_items WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'menu_categories',      (SELECT count(*) FROM public.menu_categories WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'menu_item_extras',     (SELECT count(*) FROM public.menu_item_extras WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'coupons',              (SELECT count(*) FROM public.coupons WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'ratings',              (SELECT count(*) FROM public.ratings WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'reservations',         (SELECT count(*) FROM public.reservations WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'waiter_calls',         (SELECT count(*) FROM public.waiter_calls WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'turnos_caja',          (SELECT count(*) FROM public.turnos_caja WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'movimientos_caja',     (SELECT count(*) FROM public.movimientos_caja WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'cancelaciones_caja',   (SELECT count(*) FROM public.cancelaciones_caja WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'quejas_sugerencias',   (SELECT count(*) FROM public.quejas_sugerencias WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'expenses',             (SELECT count(*) FROM public.expenses WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'ingredients',          (SELECT count(*) FROM public.ingredients WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'stock_alerts',         (SELECT count(*) FROM public.stock_alerts WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'stock_sessions',       (SELECT count(*) FROM public.stock_sessions WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'staff_sessions',       (SELECT count(*) FROM public.staff_sessions WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'staff_requests',       (SELECT count(*) FROM public.staff_requests WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'staff_broadcasts',     (SELECT count(*) FROM public.staff_broadcasts WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'support_tickets',      (SELECT count(*) FROM public.support_tickets WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'calendar_events',      (SELECT count(*) FROM public.calendar_events WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'employee_shifts',      (SELECT count(*) FROM public.employee_shifts WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'kitchen_stations',     (SELECT count(*) FROM public.kitchen_stations WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'table_scan_sessions',  (SELECT count(*) FROM public.table_scan_sessions WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'restaurant_settings',  (SELECT count(*) FROM public.restaurant_settings WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'restaurant_addons',    (SELECT count(*) FROM public.restaurant_addons WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'subscriptions',        (SELECT count(*) FROM public.subscriptions WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'user_profiles (BLOQUEADOR)',(SELECT count(*) FROM public.user_profiles WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'platform_events (SET NULL)',(SELECT count(*) FROM public.platform_events WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'user_roles @mythos.test',(SELECT count(*) FROM public.user_roles WHERE email LIKE '%@mythos.test')
  UNION ALL SELECT 'auth.users @mythos.test',(SELECT count(*) FROM auth.users WHERE email LIKE '%@mythos.test')
) t
ORDER BY t.filas DESC, t.tabla;

-- NOTA: si alguna tabla no existiera en este entorno, comentá esa línea.
-- NOTA: este dry-run NO incluye tablas globales (subscription_plans, plan_addons,
--       platform_config) porque NO se tocan.
