-- ════════════════════════════════════════════════════════════════════
-- ⛔ NO EJECUTAR SIN APROBACIÓN EXPLÍCITA DE RENATO + BACKUP NUEVO CONFIRMADO ⛔
-- ────────────────────────────────────────────────────────────────────
-- TEARDOWN SELECTIVO. PREPARADO, NO EJECUTADO.
--
-- Conserva ÚNICAMENTE:
--   (A) superadmin  mancuellorenato@gmail.com  (restaurant_id NULL)  — NUNCA se toca.
--   (B) el restaurante de  prueba1@gmail.com  (resuelto por email+user_roles)
--       con TODA su data y TODOS sus usuarios (staff: mozo/caja/rider/etc.).
-- Borra TODO el resto: Terrapizza, sims a1a1…/b2b2…/c3c3…, @mythos.test, y
-- cualquier otro restaurante/usuario. Preserva el catálogo/estructura global.
--
-- LO QUE **NO** TOCA (se preserva):
--   · auth.users / auth.identities / user_roles del superadmin y del staff de Prueba1
--   · El restaurante de Prueba1 y TODA su data tenant (cascada NO aplica: se EXCLUYE por id)
--   · subscription_plans, plan_addons, platform_config  (catálogo global)
--   · schema, funciones, policies (RLS), migraciones
--
-- BLOQUEADO por guardas + ROLLBACK:
--   1) GUC  mythos.keep_prueba1_confirm = 'RENATO_KEEP_PRUEBA1_BACKUP_DONE'
--      (setear a mano en la MISMA sesión; NO está en este archivo a propósito).
--   2) Aborta si el superadmin no resuelve a exactamente 1 fila.
--   3) Aborta si Prueba1 no resuelve a exactamente 1 restaurant_id.
--   4) Aborta si el keep-set no contiene al superadmin Y al usuario de Prueba1.
--   5) Post-check in-transacción: aborta si quedó algo fuera del keep-set.
--   + Termina en ROLLBACK: aunque pase TODAS las guardas, NO aplica nada hasta
--     que un humano cambie deliberadamente la última línea ROLLBACK; por COMMIT;.
--
-- PARA EJECUTAR DE VERDAD (solo tras backup NUEVO + aprobación del inventario):
--   1) Correr antes  scripts/teardown/dry-run-keep-prueba1.sql  y revisar
--      (superadmin_present=1, prueba1_restaurants_resueltos=1, listas CONSERVAR/BORRAR).
--   2) En la MISMA sesión:  SET mythos.keep_prueba1_confirm = 'RENATO_KEEP_PRUEBA1_BACKUP_DONE';
--   3) Pegar este script.   4) Revisar la salida del POST-CHECK (NOTICE).
--   5) Solo si todo OK: cambiar la última línea ROLLBACK; por COMMIT; y re-ejecutar.
-- Dashboard Supabase en INGLÉS. Rol con permisos sobre auth.* (postgres / SQL editor).
-- Idempotente / re-ejecutable.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── GUARDA 1: confirmación explícita ────────────────────────────────
DO $$
BEGIN
  IF current_setting('mythos.keep_prueba1_confirm', true) IS DISTINCT FROM 'RENATO_KEEP_PRUEBA1_BACKUP_DONE' THEN
    RAISE EXCEPTION
      'ABORTADO: falta confirmacion. Ejecuta primero:  SET mythos.keep_prueba1_confirm = ''RENATO_KEEP_PRUEBA1_BACKUP_DONE'';  (solo tras backup nuevo + aprobacion del inventario).';
  END IF;
END $$;

-- ── Restaurante a PRESERVAR (resuelto por EMAIL + user_roles, no por UUID) ──
CREATE TEMP TABLE _keep_restaurant ON COMMIT DROP AS
SELECT DISTINCT ur.restaurant_id AS id
FROM auth.users u
JOIN public.user_roles ur ON ur.user_id = u.id
WHERE lower(u.email) = lower('prueba1@gmail.com')
  AND ur.restaurant_id IS NOT NULL;

-- ── Usuarios a PRESERVAR: superadmin + TODO el staff de Prueba1 ─────
CREATE TEMP TABLE _keep_user ON COMMIT DROP AS
SELECT id FROM auth.users WHERE lower(email) = lower('mancuellorenato@gmail.com')
UNION
SELECT DISTINCT ur.user_id
FROM public.user_roles ur
WHERE ur.restaurant_id IN (SELECT id FROM _keep_restaurant);

-- ── Snapshot de metadata de Prueba1 (para detectar mutaciones colaterales) ──
CREATE TEMP TABLE _keep_meta ON COMMIT DROP AS
SELECT id, parent_company_id
FROM public.restaurants
WHERE id IN (SELECT id FROM _keep_restaurant);

-- ── GUARDAS 2-4: el keep-set DEBE resolver correctamente ────────────
DO $$
DECLARE n_super int; n_rest int; n_prueba1 int; n_keepusers int;
BEGIN
  SELECT count(*) INTO n_super FROM auth.users WHERE lower(email) = lower('mancuellorenato@gmail.com');
  IF n_super <> 1 THEN
    RAISE EXCEPTION 'ABORTADO: superadmin mancuellorenato@gmail.com resolvio a % filas (esperado 1). No se borra nada.', n_super;
  END IF;

  SELECT count(*) INTO n_rest FROM _keep_restaurant;
  IF n_rest <> 1 THEN
    RAISE EXCEPTION 'ABORTADO: el restaurante de prueba1@gmail.com resolvio a % restaurant_id (esperado 1). No se borra nada.', n_rest;
  END IF;

  -- El restaurante a conservar DEBE existir en restaurants.
  IF NOT EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id IN (SELECT id FROM _keep_restaurant)) THEN
    RAISE EXCEPTION 'ABORTADO: el restaurant_id de Prueba1 no existe en public.restaurants. No se borra nada.';
  END IF;

  -- El usuario de Prueba1 DEBE estar en el keep-set.
  SELECT count(*) INTO n_prueba1
  FROM auth.users u WHERE lower(u.email) = lower('prueba1@gmail.com')
    AND u.id IN (SELECT id FROM _keep_user);
  IF n_prueba1 <> 1 THEN
    RAISE EXCEPTION 'ABORTADO: prueba1@gmail.com no quedo en el keep-set (% filas). No se borra nada.', n_prueba1;
  END IF;

  -- El superadmin DEBE estar en el keep-set.
  IF NOT EXISTS (
    SELECT 1 FROM auth.users u
    WHERE lower(u.email) = lower('mancuellorenato@gmail.com') AND u.id IN (SELECT id FROM _keep_user)
  ) THEN
    RAISE EXCEPTION 'ABORTADO: el superadmin no quedo en el keep-set. No se borra nada.';
  END IF;

  SELECT count(*) INTO n_keepusers FROM _keep_user;
  RAISE NOTICE 'Keep-set OK: 1 restaurante (Prueba1) + % usuarios a conservar (incluye superadmin).', n_keepusers;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- BORRADO en orden de dependencias (EXCLUYE por id el keep-set).
-- Las ~51 FKs CASCADE a restaurants limpian solas las tablas tenant de los
-- restaurantes BORRADOS; la data de Prueba1 sobrevive porque su restaurante
-- queda EXCLUIDO del DELETE de restaurants.
-- ════════════════════════════════════════════════════════════════════

-- 1) Árbol de pedidos de restaurantes ≠ Prueba1. orders.restaurant_id es
--    ON DELETE RESTRICT → vaciarlo ANTES de borrar restaurants. Cascada:
--    order_items → order_item_extras / order_status_history / station_log,
--    payments, delivery_orders.
DELETE FROM public.orders
 WHERE restaurant_id NOT IN (SELECT id FROM _keep_restaurant);

-- 2) Bloqueadores no-cascade del DELETE de restaurants (ghost-safe):
--    user_profiles (tabla fantasma en prod → se salta) y platform_events.
--    Se borran SOLO las filas de restaurantes ≠ Prueba1 (los logs globales con
--    restaurant_id NULL se conservan).
DO $$
BEGIN
  IF to_regclass('public.user_profiles') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.user_profiles WHERE restaurant_id IS NOT NULL AND restaurant_id NOT IN (SELECT id FROM _keep_restaurant)';
  END IF;
  IF to_regclass('public.platform_events') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.platform_events WHERE restaurant_id IS NOT NULL AND restaurant_id NOT IN (SELECT id FROM _keep_restaurant)';
  END IF;
END $$;

-- 3) Roles de TODOS los usuarios que NO están en el keep-set:
DELETE FROM public.user_roles
 WHERE user_id NOT IN (SELECT id FROM _keep_user);

-- 4) Restaurantes ≠ Prueba1 (Terrapizza + sims + cualquier otro) →
--    CASCADE limpia las ~51 tablas tenant restantes de esos restaurantes.
DELETE FROM public.restaurants
 WHERE id NOT IN (SELECT id FROM _keep_restaurant);

-- 4.5) Neutralizar back-refs NO-ACTION a auth.users desde filas SUPERVIVIENTES
--      de Prueba1 que apunten a un usuario a borrar. Esas FKs (expenses.created_by,
--      staff_requests.reviewed_by, stock_sessions.created_by) NO tienen ON DELETE
--      → si una fila viva de Prueba1 las referencia, el DELETE de auth.users abortaría.
--      Las 3 columnas son nullable. + Detector genérico para cualquier OTRA FK
--      NO-ACTION/RESTRICT a auth.users (anti schema-drift): aborta con detalle.
DO $$
DECLARE r record; n int; blockers text := '';
BEGIN
  IF to_regclass('public.expenses') IS NOT NULL THEN
    EXECUTE 'UPDATE public.expenses SET created_by = NULL
              WHERE restaurant_id IN (SELECT id FROM _keep_restaurant)
                AND created_by IS NOT NULL AND created_by NOT IN (SELECT id FROM _keep_user)';
  END IF;
  IF to_regclass('public.staff_requests') IS NOT NULL THEN
    EXECUTE 'UPDATE public.staff_requests SET reviewed_by = NULL
              WHERE restaurant_id IN (SELECT id FROM _keep_restaurant)
                AND reviewed_by IS NOT NULL AND reviewed_by NOT IN (SELECT id FROM _keep_user)';
  END IF;
  IF to_regclass('public.stock_sessions') IS NOT NULL THEN
    EXECUTE 'UPDATE public.stock_sessions SET created_by = NULL
              WHERE restaurant_id IN (SELECT id FROM _keep_restaurant)
                AND created_by IS NOT NULL AND created_by NOT IN (SELECT id FROM _keep_user)';
  END IF;

  -- Detector genérico: FKs a auth.users con NO ACTION ('a') o RESTRICT ('r'),
  -- de una sola columna, cuyas filas SUPERVIVIENTES apunten a un usuario a borrar.
  FOR r IN
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f'
      AND c.confrelid = 'auth.users'::regclass
      AND c.confdeltype IN ('a','r')
      AND array_length(c.conkey, 1) = 1
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %s WHERE %I IS NOT NULL AND %I NOT IN (SELECT id FROM _keep_user)',
      r.tbl, r.col, r.col) INTO n;
    IF n > 0 THEN blockers := blockers || format('%s.%s=%s; ', r.tbl, r.col, n); END IF;
  END LOOP;
  IF blockers <> '' THEN
    RAISE EXCEPTION 'ABORTADO: filas supervivientes con FK NO-ACTION/RESTRICT a un usuario a borrar (bloquearian el DELETE de auth.users): %  — NUL-ealas o agregalas al manejo antes de continuar.', blockers;
  END IF;
END $$;

-- 5) Cuentas auth que NO están en el keep-set (identities antes que users):
DELETE FROM auth.identities WHERE user_id NOT IN (SELECT id FROM _keep_user);
DELETE FROM auth.users      WHERE id      NOT IN (SELECT id FROM _keep_user);

-- ── POST-CHECK in-transacción: aborta si algo quedó fuera del keep-set ──
DO $$
DECLARE rest int; rest_wrong int; super int; prueba1 int; others int; orphan int;
BEGIN
  SELECT count(*) INTO rest FROM public.restaurants;
  IF rest <> 1 THEN RAISE EXCEPTION 'POST-CHECK: quedan % restaurantes (esperado 1: Prueba1).', rest; END IF;

  SELECT count(*) INTO rest_wrong FROM public.restaurants WHERE id NOT IN (SELECT id FROM _keep_restaurant);
  IF rest_wrong <> 0 THEN RAISE EXCEPTION 'POST-CHECK: sobrevivio un restaurante que NO es Prueba1.'; END IF;

  SELECT count(*) INTO super FROM auth.users WHERE lower(email) = lower('mancuellorenato@gmail.com');
  IF super <> 1 THEN RAISE EXCEPTION 'POST-CHECK: el superadmin quedo en % filas (esperado 1).', super; END IF;

  SELECT count(*) INTO prueba1 FROM auth.users WHERE lower(email) = lower('prueba1@gmail.com');
  IF prueba1 <> 1 THEN RAISE EXCEPTION 'POST-CHECK: prueba1@gmail.com quedo en % filas (esperado 1).', prueba1; END IF;

  SELECT count(*) INTO others FROM auth.users WHERE id NOT IN (SELECT id FROM _keep_user);
  IF others <> 0 THEN RAISE EXCEPTION 'POST-CHECK: quedan % usuarios fuera del keep-set (esperado 0).', others; END IF;

  -- Huérfanos: pedidos cuyo restaurante ya no existe (debe ser 0).
  SELECT count(*) INTO orphan FROM public.orders o
   WHERE NOT EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = o.restaurant_id);
  IF orphan <> 0 THEN RAISE EXCEPTION 'POST-CHECK: % orders huerfanos (restaurante inexistente).', orphan; END IF;

  -- Mutación colateral: si Prueba1 era SUCURSAL HIJA de un restaurante borrado, su
  -- parent_company_id quedó NULL (SET NULL). No es pérdida de data (queda standalone,
  -- el end-state correcto), pero se avisa para que un humano lo confirme.
  IF EXISTS (
    SELECT 1 FROM public.restaurants r JOIN _keep_meta m ON m.id = r.id
     WHERE r.parent_company_id IS DISTINCT FROM m.parent_company_id
  ) THEN
    RAISE NOTICE 'AVISO: parent_company_id de Prueba1 cambio (su casa matriz fue borrada → ahora standalone). Confirmar que es esperado.';
  END IF;

  RAISE NOTICE 'POST-CHECK OK: 1 restaurante (Prueba1) + superadmin + staff de Prueba1 sobreviven; todo lo demas borrado; sin huerfanos.';
END $$;

-- ════════════════════════════════════════════════════════════════════
-- DEFAULT SEGURO: NO aplica nada. Para ejecutar de verdad (tras backup
-- NUEVO + aprobación del inventario + revisión del POST-CHECK), cambiar
-- la línea ROLLBACK; por COMMIT;.
-- ════════════════════════════════════════════════════════════════════
ROLLBACK;
-- COMMIT;
