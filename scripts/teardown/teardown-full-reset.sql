-- ════════════════════════════════════════════════════════════════════
-- ⛔ NO EJECUTAR SIN APROBACIÓN EXPLÍCITA DE RENATO + BACKUP NUEVO CONFIRMADO ⛔
-- ────────────────────────────────────────────────────────────────────
-- RESET TOTAL de datos demo/QA. PREPARADO, NO EJECUTADO.
--
-- Borra TODOS los datos tenant + TODAS las cuentas, preservando ÚNICAMENTE
-- la cuenta oficial `mancuellorenato@gmail.com` y el catálogo/estructura.
-- Incluye Terrapizza, los 3 restaurantes de simulación y cualquier otro.
--
-- LO QUE **NO** TOCA (se preserva):
--   · auth.users / auth.identities / user_roles de mancuellorenato@gmail.com
--   · subscription_plans, plan_addons, platform_config  (catálogo global)
--   · schema, funciones, policies (RLS), migraciones
--
-- Está BLOQUEADO por guardas + ROLLBACK:
--   1) Requiere el GUC `mythos.full_reset_confirm = 'RENATO_FULL_RESET_BACKUP_DONE'`
--      (debe setearse a mano en la MISMA sesión; NO está en este archivo a propósito).
--   2) Aborta si la cuenta oficial NO se resuelve a exactamente 1 fila
--      (anti "DB equivocada" / email cambiado): si no encuentra al oficial, NO borra nada.
--   3) Post-check in-transacción: aborta si quedaron restaurantes, si el oficial
--      desapareció, o si quedaron usuarios no-oficiales.
--   + Termina en `ROLLBACK`: aunque pase todas las guardas, NO aplica nada hasta
--     que un humano cambie deliberadamente la última línea `ROLLBACK;` por `COMMIT;`.
--
-- PARA EJECUTAR DE VERDAD (solo tras backup NUEVO + aprobación + dry-run revisado):
--   1) Correr antes  scripts/teardown/dry-run-full-reset.sql  y revisar
--      (official_present DEBE ser 1; revisar conteos y listados).
--   2) En la MISMA sesión:  SET mythos.full_reset_confirm = 'RENATO_FULL_RESET_BACKUP_DONE';
--   3) Pegar este script.   4) Revisar la salida del POST-CHECK (NOTICE).
--   5) Solo si todo OK: cambiar la última línea `ROLLBACK;` por `COMMIT;` y re-ejecutar.
-- Dashboard Supabase en INGLÉS. Correr como rol con permisos sobre auth.*
-- (postgres / SQL editor del dashboard).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── GUARDA 1: confirmación explícita ────────────────────────────────
DO $$
BEGIN
  IF current_setting('mythos.full_reset_confirm', true) IS DISTINCT FROM 'RENATO_FULL_RESET_BACKUP_DONE' THEN
    RAISE EXCEPTION
      'ABORTADO: falta confirmacion. Ejecuta primero:  SET mythos.full_reset_confirm = ''RENATO_FULL_RESET_BACKUP_DONE'';  (solo tras backup nuevo + aprobacion de Renato).';
  END IF;
END $$;

-- ── Cuenta oficial a PRESERVAR (resuelta por EMAIL, no por UUID) ─────
CREATE TEMP TABLE _keep_user ON COMMIT DROP AS
SELECT id, email FROM auth.users
WHERE lower(email) = lower('mancuellorenato@gmail.com');

-- ── GUARDA 2: la cuenta oficial DEBE existir (exactamente 1) ────────
-- Si no aparece (DB equivocada / email distinto), NO se borra nada.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM _keep_user;
  IF n <> 1 THEN
    RAISE EXCEPTION
      'ABORTADO: la cuenta oficial mancuellorenato@gmail.com se resolvio a % filas (esperado 1). No se borra nada.', n;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- BORRADO en orden de dependencias. Las ~51 FKs CASCADE a restaurants se
-- limpian solas en el paso (4). Acá se borran los BLOQUEADORES primero.
-- ════════════════════════════════════════════════════════════════════

-- 1) Árbol de pedidos COMPLETO. orders.restaurant_id es ON DELETE RESTRICT →
--    debe vaciarse ANTES de restaurants. Cascada: order_items → order_item_extras,
--    order_status_history, order_item_station_log, payments, delivery_orders.
DELETE FROM public.orders;

-- 2) Bloqueadores no-cascade del DELETE de restaurants (ghost-safe vía to_regclass):
--    user_profiles es tabla FANTASMA en prod (no existe) → se salta sin romper.
--    platform_events: log de plataforma — se vacía para dejar el sistema limpio.
DO $$
BEGIN
  IF to_regclass('public.user_profiles')  IS NOT NULL THEN EXECUTE 'DELETE FROM public.user_profiles';  END IF;
  IF to_regclass('public.platform_events') IS NOT NULL THEN EXECUTE 'DELETE FROM public.platform_events'; END IF;
END $$;

-- 3) Roles de TODOS los usuarios MENOS la cuenta oficial:
DELETE FROM public.user_roles
 WHERE user_id NOT IN (SELECT id FROM _keep_user);

-- 4) TODOS los restaurantes (Terrapizza + sims + cualquier otro) →
--    CASCADE limpia las ~51 tablas tenant restantes (menú, mesas, zonas, riders,
--    caja, ratings, reservas, stock, staff_sessions, soporte, settings, addons,
--    subscriptions, etc.).
DELETE FROM public.restaurants;

-- 4.5) Salvaguarda anti schema-drift: ningún back-ref NO-ACTION/RESTRICT a
--      auth.users debe SOBREVIVIR apuntando a un usuario a borrar (bloquearía el
--      DELETE de auth.users del paso 5). Las 3 FKs conocidas (expenses.created_by,
--      staff_requests.reviewed_by, stock_sessions.created_by) ya quedaron vacías
--      por CASCADE en el paso 4; este detector genérico aborta con DETALLE si
--      ALGUNA otra tabla global referencia a un usuario a borrar, en vez de fallar
--      con un error FK críptico recién en el COMMIT.
DO $$
DECLARE r record; n int; blockers text := '';
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f'
      AND c.confrelid = 'auth.users'::regclass
      AND c.confdeltype IN ('a','r')           -- a = NO ACTION, r = RESTRICT
      AND array_length(c.conkey, 1) = 1
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %s WHERE %I IS NOT NULL AND %I NOT IN (SELECT id FROM _keep_user)',
      r.tbl, r.col, r.col) INTO n;
    IF n > 0 THEN blockers := blockers || format('%s.%s=%s; ', r.tbl, r.col, n); END IF;
  END LOOP;
  IF blockers <> '' THEN
    RAISE EXCEPTION 'ABORTADO: filas con FK NO-ACTION/RESTRICT a un usuario a borrar (bloquearian el DELETE de auth.users): %  — vaciar/NUL-ear esas filas antes de continuar.', blockers;
  END IF;
END $$;

-- 5) Cuentas auth de TODOS menos la oficial (identities antes que users):
DELETE FROM auth.identities WHERE user_id NOT IN (SELECT id FROM _keep_user);
DELETE FROM auth.users      WHERE id      NOT IN (SELECT id FROM _keep_user);

-- ── POST-CHECK in-transacción: aborta si algo quedó mal ─────────────
DO $$
DECLARE rest int; off int; others int;
BEGIN
  SELECT count(*) INTO rest FROM public.restaurants;
  IF rest <> 0 THEN RAISE EXCEPTION 'POST-CHECK: quedan % restaurantes (esperado 0).', rest; END IF;

  SELECT count(*) INTO off FROM auth.users WHERE lower(email) = lower('mancuellorenato@gmail.com');
  IF off <> 1 THEN RAISE EXCEPTION 'POST-CHECK: la cuenta oficial quedo en % filas (esperado 1) — abortar.', off; END IF;

  SELECT count(*) INTO others FROM auth.users WHERE id NOT IN (SELECT id FROM _keep_user);
  IF others <> 0 THEN RAISE EXCEPTION 'POST-CHECK: quedan % usuarios no-oficiales (esperado 0).', others; END IF;

  RAISE NOTICE 'POST-CHECK OK: restaurants=0, solo la cuenta oficial (mancuellorenato@gmail.com) sobrevive.';
END $$;

-- ════════════════════════════════════════════════════════════════════
-- DEFAULT SEGURO: NO aplica nada. Para ejecutar de verdad (tras backup
-- NUEVO + aprobación + revisión del POST-CHECK), cambiar ROLLBACK por COMMIT.
-- ════════════════════════════════════════════════════════════════════
ROLLBACK;
-- COMMIT;
