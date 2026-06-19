-- ════════════════════════════════════════════════════════════════════
-- DRY-RUN — Reset TOTAL de datos demo/QA (SOLO LECTURA)
-- ────────────────────────────────────────────────────────────────────
-- Este archivo SOLO hace SELECT/count(*). NO modifica nada. Es SEGURO de
-- correr en producción (Dashboard SQL en INGLÉS, o psql/pooler).
--
-- DIFERENCIA CLAVE con dry-run-simulation-data.sql:
--   Aquel EXCLUÍA Terrapizza (allowlist de 3 sims). ESTE reset es TOTAL:
--   se preserva ÚNICAMENTE la cuenta oficial `mancuellorenato@gmail.com`
--   y el catálogo/estructura. TODO el resto de DATOS (los 3 sims + Terrapizza
--   + cualquier otro restaurante, todos los usuarios demo/QA, pedidos,
--   delivery, mesas, productos, staff, sesiones y datos relacionados) cae.
--
-- Lo que se PRESERVA (NO aparece como "a borrar"):
--   · auth.users + auth.identities + user_roles de mancuellorenato@gmail.com
--   · Catálogo/estructura global: subscription_plans, plan_addons,
--     platform_config  (NO son tenant; el sistema los necesita para operar).
--   · Schema, funciones, policies (RLS), migraciones  (NO se tocan).
--
-- Su salida es el insumo para decidir el teardown. NO ejecuta teardown.
-- ════════════════════════════════════════════════════════════════════

-- Cuenta oficial protegida (única). Se resuelve por EMAIL (no por UUID).
\set official_email 'mancuellorenato@gmail.com'

-- ── 1) Sanidad / umbrales (lo que el teardown exige) ────────────────
SELECT
  (SELECT count(*) FROM public.restaurants)                                              AS restaurants_total,        -- TODOS a borrar
  (SELECT count(*) FROM public.restaurants WHERE name ILIKE '%terrapizza%')              AS terrapizza_present,       -- a borrar (>=0)
  (SELECT count(*) FROM auth.users)                                                      AS users_total,
  (SELECT count(*) FROM auth.users WHERE lower(email) = lower('mancuellorenato@gmail.com')) AS official_present,      -- DEBE ser 1
  (SELECT count(*) FROM auth.users WHERE lower(email) <> lower('mancuellorenato@gmail.com')) AS users_to_delete,      -- todos menos el oficial
  (SELECT count(*) FROM public.subscription_plans)                                       AS plans_catalog_preserved,  -- se PRESERVA
  (SELECT count(*) FROM public.user_roles WHERE user_id IN
     (SELECT id FROM auth.users WHERE lower(email) = lower('mancuellorenato@gmail.com'))) AS official_roles_preserved;

-- ── 2) La cuenta oficial a preservar (verificación humana) ──────────
-- DEBE devolver exactamente la fila de Renato (superadmin, restaurant_id NULL).
-- Si devuelve 0 filas o un email distinto → NO correr el teardown.
SELECT u.id, u.email, u.created_at, ur.role, ur.restaurant_id, ur.username
FROM auth.users u
LEFT JOIN public.user_roles ur ON ur.user_id = u.id
WHERE lower(u.email) = lower('mancuellorenato@gmail.com');

-- ── 3) TODOS los restaurantes que se eliminarían (ninguno se preserva) ─
-- Se marcan Terrapizza y los 3 sims conocidos solo a título informativo;
-- TODOS caen (es_a_borrar = true para todos).
SELECT
  r.id,
  r.name,
  true AS es_a_borrar,
  (r.name ILIKE '%terrapizza%') AS es_terrapizza,
  (r.id IN ('a1a10000-0000-4000-8000-000000000001',
            'b2b20000-0000-4000-8000-000000000002',
            'c3c30000-0000-4000-8000-000000000003')) AS es_simulacion_conocida
FROM public.restaurants r
ORDER BY es_terrapizza DESC, es_simulacion_conocida DESC, r.name;

-- ── 4) Usuarios que se eliminarían (TODOS menos el oficial) ─────────
-- Listado para revisión humana. El oficial NO debe aparecer acá.
SELECT
  u.email,
  (u.email LIKE '%@mythos.test')     AS dominio_test,
  (u.email LIKE '%@mythos.internal') AS dominio_internal,
  u.created_at
FROM auth.users u
WHERE lower(u.email) <> lower('mancuellorenato@gmail.com')
ORDER BY u.email;

-- ── 5) Conteo de filas a borrar por tabla (GLOBAL, ghost-safe) ──────
-- Recorre una lista de tablas tenant/operativas; si alguna no existe en
-- este entorno (p. ej. user_profiles, tabla fantasma), la marca existe=false
-- en vez de romper. Para el reset total, "a borrar" = todas las filas.
DO $$
DECLARE
  t text;
  c bigint;
  tbls text[] := ARRAY[
    -- núcleo de pedidos
    'orders','order_items','order_item_extras','order_status_history','order_item_station_log',
    'payments','delivery_orders',
    -- delivery / riders
    'delivery_riders','delivery_zones','delivery_channels',
    -- mesas / menú
    'tables','table_scan_sessions','menu_items','menu_categories','menu_item_extras','coupons',
    -- experiencia cliente
    'ratings','reservations','waiter_calls','invoice_request',
    -- caja
    'turnos_caja','movimientos_caja','cancelaciones_caja','caja_config','quejas_sugerencias',
    -- finanzas / stock
    'expenses','ingredients','recipes','stock_movements','stock_alerts','stock_sessions',
    -- staff / operación
    'staff_sessions','staff_requests','staff_broadcasts','staff_payroll_adjustments',
    'employee_shifts','kitchen_stations','calendar_events',
    -- soporte / settings / suscripción (tenant)
    'support_tickets','support_chat','restaurant_settings','restaurant_addons','subscriptions',
    -- bloqueadores / plataforma
    'user_profiles','platform_events'
  ];
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _dryrun_counts(tabla text, filas bigint, existe boolean) ON COMMIT DROP;
  DELETE FROM _dryrun_counts;
  FOREACH t IN ARRAY tbls LOOP
    IF to_regclass('public.'||t) IS NULL THEN
      INSERT INTO _dryrun_counts VALUES (t, NULL, false);
    ELSE
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO c;
      INSERT INTO _dryrun_counts VALUES (t, c, true);
    END IF;
  END LOOP;
  -- auth.* (todos menos el oficial)
  EXECUTE 'SELECT count(*) FROM auth.users WHERE lower(email) <> lower(''mancuellorenato@gmail.com'')' INTO c;
  INSERT INTO _dryrun_counts VALUES ('auth.users (no-oficiales)', c, true);
  EXECUTE 'SELECT count(*) FROM auth.identities WHERE user_id IN (SELECT id FROM auth.users WHERE lower(email) <> lower(''mancuellorenato@gmail.com''))' INTO c;
  INSERT INTO _dryrun_counts VALUES ('auth.identities (no-oficiales)', c, true);
  EXECUTE 'SELECT count(*) FROM public.user_roles WHERE user_id NOT IN (SELECT id FROM auth.users WHERE lower(email) = lower(''mancuellorenato@gmail.com''))' INTO c;
  INSERT INTO _dryrun_counts VALUES ('user_roles (no-oficiales)', c, true);
END $$;

SELECT tabla, filas, existe
FROM _dryrun_counts
ORDER BY existe DESC, filas DESC NULLS LAST, tabla;

-- ── 6) Catálogo/estructura que se PRESERVA (NO se borra) ────────────
-- Confirmación de lo que sobrevive además de la cuenta oficial.
SELECT 'subscription_plans' AS preservado, count(*) AS filas FROM public.subscription_plans
UNION ALL SELECT 'plan_addons',     count(*) FROM public.plan_addons
UNION ALL SELECT 'platform_config', count(*) FROM public.platform_config
ORDER BY preservado;

-- NOTAS:
--  · Si alguna tabla del §5 no existe, aparece con existe=false (no rompe).
--  · subscription_plans / plan_addons / platform_config NO se tocan (catálogo).
--  · Schema, funciones, policies (RLS) y migraciones NO se tocan.
--  · official_present DEBE ser 1 antes de habilitar el teardown.
