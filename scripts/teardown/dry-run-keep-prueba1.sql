-- ════════════════════════════════════════════════════════════════════
-- DRY-RUN / INVENTARIO — Teardown selectivo: conservar SOLO superadmin + Prueba1
-- ────────────────────────────────────────────────────────────────────
-- SOLO LECTURA. NO modifica nada. Seguro de correr en producción.
-- Ejecutar en el SQL Editor del Dashboard (en INGLÉS) — cada §N es un grid —
-- o vía el runner Management API (devuelve el último result set; correr por
-- secciones si se quiere todo). NO ejecuta ningún teardown.
--
-- OBJETIVO del teardown asociado (teardown-keep-prueba1.sql):
--   CONSERVAR  (A) superadmin  mancuellorenato@gmail.com  (restaurant_id NULL)
--              (B) el restaurante de  prueba1@gmail.com  + TODA su data +
--                  TODOS sus usuarios (staff: mozo/caja/rider/etc.)
--   BORRAR     todo el resto: Terrapizza, sims a1a1…/b2b2…/c3c3…, @mythos.test,
--              cualquier otro restaurante/usuario.
--
-- Esta salida es el INSUMO que Renato debe aprobar ANTES de habilitar el borrado.
-- Verificar a ojo: §0 superadmin_present=1 y prueba1_restaurants_resueltos=1;
-- §1 que el restaurant_id de Prueba1 es el correcto; §2/§3 que CONSERVAR/BORRAR
-- coincide con lo esperado (el oficial y el staff de Prueba1 NUNCA en BORRAR).
-- ════════════════════════════════════════════════════════════════════

-- ── §0) Sanidad / umbrales que el teardown exige ────────────────────
SELECT
  (SELECT count(*) FROM public.restaurants)                                                    AS restaurants_total,
  (SELECT count(*) FROM auth.users)                                                            AS users_total,
  (SELECT count(*) FROM auth.users WHERE lower(email) = lower('mancuellorenato@gmail.com'))    AS superadmin_present,            -- DEBE ser 1
  (SELECT count(*) FROM auth.users WHERE lower(email) = lower('prueba1@gmail.com'))            AS prueba1_user_present,          -- DEBE ser 1
  (SELECT count(DISTINCT ur.restaurant_id)
     FROM auth.users u JOIN public.user_roles ur ON ur.user_id = u.id
    WHERE lower(u.email) = lower('prueba1@gmail.com') AND ur.restaurant_id IS NOT NULL)         AS prueba1_restaurants_resueltos; -- DEBE ser 1

-- ── §1) Resolución EXPLÍCITA del restaurant_id de Prueba1 ───────────
-- DEBE devolver exactamente 1 restaurant_id (el de "Prueba1"). Si devuelve 0
-- o >1 → NO habilitar el teardown (el script aborta igual, pero verificar acá).
SELECT u.id AS user_id, u.email, ur.role, ur.restaurant_id, r.name AS restaurant_name, r.created_at
FROM auth.users u
JOIN public.user_roles ur ON ur.user_id = u.id
LEFT JOIN public.restaurants r ON r.id = ur.restaurant_id
WHERE lower(u.email) = lower('prueba1@gmail.com')
ORDER BY ur.restaurant_id;

-- ── §2) TODOS los restaurantes: CONSERVAR vs BORRAR ─────────────────
WITH keep AS (
  SELECT DISTINCT ur.restaurant_id AS id
  FROM auth.users u JOIN public.user_roles ur ON ur.user_id = u.id
  WHERE lower(u.email) = lower('prueba1@gmail.com') AND ur.restaurant_id IS NOT NULL
)
SELECT
  r.id,
  r.name,
  CASE WHEN r.id IN (SELECT id FROM keep) THEN 'CONSERVAR (Prueba1)' ELSE 'BORRAR' END AS accion,
  (r.name ILIKE '%terrapizza%')                                                          AS es_terrapizza,
  (r.id IN ('a1a10000-0000-4000-8000-000000000001',
            'b2b20000-0000-4000-8000-000000000002',
            'c3c30000-0000-4000-8000-000000000003'))                                     AS es_simulacion,
  r.parent_company_id,
  -- TRUE solo si Prueba1 es sucursal HIJA de un restaurante que se borrará → su
  -- parent_company_id quedará NULL (queda standalone). Idealmente FALSE (Prueba1 es standalone).
  (r.id IN (SELECT id FROM keep)
     AND r.parent_company_id IS NOT NULL
     AND r.parent_company_id NOT IN (SELECT id FROM keep))                               AS prueba1_parent_se_borra,
  (SELECT string_agg(DISTINCT au.email, ', ')
     FROM public.user_roles ur2 JOIN auth.users au ON au.id = ur2.user_id
    WHERE ur2.restaurant_id = r.id AND ur2.role = 'admin')                               AS admins
FROM public.restaurants r
ORDER BY accion, es_terrapizza DESC, r.name;

-- ── §3) TODOS los auth.users: CONSERVAR vs BORRAR ───────────────────
WITH keep_rest AS (
  SELECT DISTINCT ur.restaurant_id AS id
  FROM auth.users u JOIN public.user_roles ur ON ur.user_id = u.id
  WHERE lower(u.email) = lower('prueba1@gmail.com') AND ur.restaurant_id IS NOT NULL
),
keep_users AS (
  SELECT id FROM auth.users WHERE lower(email) = lower('mancuellorenato@gmail.com')
  UNION
  SELECT DISTINCT ur.user_id FROM public.user_roles ur WHERE ur.restaurant_id IN (SELECT id FROM keep_rest)
)
SELECT
  u.email,
  CASE
    WHEN lower(u.email) = lower('mancuellorenato@gmail.com') THEN 'CONSERVAR (superadmin)'
    WHEN u.id IN (SELECT id FROM keep_users)                 THEN 'CONSERVAR (staff Prueba1)'
    ELSE 'BORRAR'
  END AS accion,
  (SELECT string_agg(DISTINCT ur3.role || COALESCE(' @ ' || r3.name, ''), ', ')
     FROM public.user_roles ur3 LEFT JOIN public.restaurants r3 ON r3.id = ur3.restaurant_id
    WHERE ur3.user_id = u.id)                                AS roles,
  (u.email LIKE '%@mythos.test')                             AS dominio_test,
  (u.email LIKE '%@mythos.internal')                         AS dominio_internal,
  u.created_at
FROM auth.users u
ORDER BY accion, u.email;

-- ── §4) Conteo de filas A BORRAR por tabla tenant (ghost-safe) ──────
-- Para cada tabla: si no existe → 'no existe'; si tiene restaurant_id → cuenta
-- filas de restaurantes ≠ Prueba1 (lo que caerá por CASCADE al borrar esos
-- restaurantes); si no tiene restaurant_id → 'cascada (via padre)'.
DO $$
DECLARE
  t text; c bigint; has_rid boolean; keep_rid uuid;
  tbls text[] := ARRAY[
    'orders','order_items','order_item_extras','order_status_history','order_item_station_log',
    'payments','delivery_orders','delivery_riders','delivery_zones','delivery_channels',
    'tables','table_scan_sessions','menu_items','menu_categories','menu_item_extras','coupons',
    'ratings','reservations','waiter_calls','invoice_request',
    'turnos_caja','movimientos_caja','cancelaciones_caja','caja_config','cajas','quejas_sugerencias',
    'expenses','ingredients','recipes','stock_movements','stock_alerts','stock_sessions',
    'staff_sessions','staff_requests','staff_broadcasts','staff_payroll_adjustments',
    'employee_shifts','kitchen_stations','calendar_events',
    'support_tickets','support_chat','restaurant_settings','restaurant_addons','subscriptions',
    'user_profiles','platform_events'
  ];
BEGIN
  SELECT id INTO keep_rid FROM (
    SELECT DISTINCT ur.restaurant_id AS id
    FROM auth.users u JOIN public.user_roles ur ON ur.user_id = u.id
    WHERE lower(u.email) = lower('prueba1@gmail.com') AND ur.restaurant_id IS NOT NULL
  ) k LIMIT 1;

  CREATE TEMP TABLE IF NOT EXISTS _inv(tabla text, a_borrar bigint, nota text) ON COMMIT DROP;
  DELETE FROM _inv;
  FOREACH t IN ARRAY tbls LOOP
    IF to_regclass('public.'||t) IS NULL THEN
      INSERT INTO _inv VALUES (t, NULL, 'no existe');
    ELSE
      SELECT EXISTS(
        SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name=t AND column_name='restaurant_id'
      ) INTO has_rid;
      IF has_rid THEN
        EXECUTE format('SELECT count(*) FROM public.%I WHERE restaurant_id <> $1', t) INTO c USING keep_rid;
        INSERT INTO _inv VALUES (t, c, 'restaurant_id <> Prueba1');
      ELSE
        INSERT INTO _inv VALUES (t, NULL, 'cascada (via padre)');
      END IF;
    END IF;
  END LOOP;

  -- auth.* y user_roles a borrar (todos los que NO están en el keep-set)
  EXECUTE $q$
    SELECT count(*) FROM auth.users WHERE id NOT IN (
      SELECT id FROM auth.users WHERE lower(email) = lower('mancuellorenato@gmail.com')
      UNION
      SELECT DISTINCT ur.user_id FROM public.user_roles ur WHERE ur.restaurant_id = $1
    )$q$ INTO c USING keep_rid;
  INSERT INTO _inv VALUES ('auth.users (a borrar)', c, 'NO en keep-set');

  EXECUTE $q$
    SELECT count(*) FROM public.user_roles WHERE user_id NOT IN (
      SELECT id FROM auth.users WHERE lower(email) = lower('mancuellorenato@gmail.com')
      UNION
      SELECT DISTINCT ur.user_id FROM public.user_roles ur WHERE ur.restaurant_id = $1
    )$q$ INTO c USING keep_rid;
  INSERT INTO _inv VALUES ('user_roles (a borrar)', c, 'NO en keep-set');
END $$;

SELECT tabla, a_borrar, nota FROM _inv ORDER BY a_borrar DESC NULLS LAST, tabla;

-- ── §4b) Bloqueadores NO-ACTION a auth.users (DEBEN ser 0) ──────────
-- 3 FKs a auth.users SIN ON DELETE (expenses.created_by, staff_requests.reviewed_by,
-- stock_sessions.created_by): si una fila SUPERVIVIENTE de Prueba1 fue creada/revisada
-- por un usuario que se borrará, el DELETE de auth.users abortaría. El teardown ya las
-- NUL-ea (paso 4.5), pero conviene verlo acá. DEBE ser 0; si no, revisar esas filas.
DO $$
DECLARE keep_rid uuid; n bigint;
BEGIN
  SELECT id INTO keep_rid FROM (
    SELECT DISTINCT ur.restaurant_id AS id FROM auth.users u JOIN public.user_roles ur ON ur.user_id = u.id
    WHERE lower(u.email) = lower('prueba1@gmail.com') AND ur.restaurant_id IS NOT NULL
  ) k LIMIT 1;
  CREATE TEMP TABLE IF NOT EXISTS _blockers(tabla_col text, filas bigint) ON COMMIT DROP;
  DELETE FROM _blockers;
  IF to_regclass('public.expenses') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.expenses WHERE restaurant_id = $1 AND created_by IS NOT NULL AND created_by NOT IN (
               SELECT id FROM auth.users WHERE lower(email)=lower(''mancuellorenato@gmail.com'')
               UNION SELECT user_id FROM public.user_roles WHERE restaurant_id = $1)' INTO n USING keep_rid;
    INSERT INTO _blockers VALUES ('expenses.created_by', n);
  END IF;
  IF to_regclass('public.staff_requests') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.staff_requests WHERE restaurant_id = $1 AND reviewed_by IS NOT NULL AND reviewed_by NOT IN (
               SELECT id FROM auth.users WHERE lower(email)=lower(''mancuellorenato@gmail.com'')
               UNION SELECT user_id FROM public.user_roles WHERE restaurant_id = $1)' INTO n USING keep_rid;
    INSERT INTO _blockers VALUES ('staff_requests.reviewed_by', n);
  END IF;
  IF to_regclass('public.stock_sessions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.stock_sessions WHERE restaurant_id = $1 AND created_by IS NOT NULL AND created_by NOT IN (
               SELECT id FROM auth.users WHERE lower(email)=lower(''mancuellorenato@gmail.com'')
               UNION SELECT user_id FROM public.user_roles WHERE restaurant_id = $1)' INTO n USING keep_rid;
    INSERT INTO _blockers VALUES ('stock_sessions.created_by', n);
  END IF;
END $$;

SELECT tabla_col, filas FROM _blockers ORDER BY filas DESC, tabla_col;

-- ── §5) Catálogo/estructura que se PRESERVA (NO se borra) ───────────
SELECT 'subscription_plans' AS preservado, count(*) AS filas FROM public.subscription_plans
UNION ALL SELECT 'plan_addons',     count(*) FROM public.plan_addons
UNION ALL SELECT 'platform_config', count(*) FROM public.platform_config
ORDER BY preservado;

-- NOTAS:
--  · superadmin_present DEBE ser 1 y prueba1_restaurants_resueltos DEBE ser 1
--    ANTES de habilitar el teardown. Si no, parar y revisar.
--  · El restaurante de Prueba1 + su staff + su data NUNCA aparecen como BORRAR.
--  · subscription_plans / plan_addons / platform_config NO se tocan (catálogo).
--  · Schema, funciones, policies (RLS) y migraciones NO se tocan.
