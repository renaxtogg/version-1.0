-- ════════════════════════════════════════════════════════════════════
-- ⛔ NO EJECUTAR SIN APROBACIÓN EXPLÍCITA DE RENATO + BACKUP CONFIRMADO ⛔
-- ────────────────────────────────────────────────────────────────────
-- Teardown de datos de SIMULACIÓN (PR-14). PREPARADO, NO EJECUTADO.
--
-- Este script está BLOQUEADO por triple guarda:
--   1) Requiere el GUC `mythos.teardown_confirm = 'RENATO_APPROVED_BACKUP_DONE'`
--      (debe setearse a mano; NO está en este archivo a propósito).
--   2) Aborta si Terrapizza aparece en la allowlist o si la allowlist no
--      resuelve exactamente a los 3 restaurantes de simulación.
--   3) Aborta si el set de usuarios a borrar supera el umbral esperado.
--   + Termina en `ROLLBACK`: aunque pase las guardas, NO aplica nada hasta
--     que un humano cambie `ROLLBACK` por `COMMIT` deliberadamente.
--
-- PARA EJECUTAR DE VERDAD (solo tras backup nuevo + aprobación + dry-run):
--   1) Correr primero scripts/teardown/dry-run-simulation-data.sql y revisar.
--   2) En la MISMA sesión:  SET mythos.teardown_confirm = 'RENATO_APPROVED_BACKUP_DONE';
--   3) Pegar este script.   4) Revisar la salida del post-check.
--   5) Solo si todo OK: cambiar la última línea `ROLLBACK;` por `COMMIT;`.
-- Dashboard Supabase en INGLÉS (el español rompe keywords). Corre como rol
-- con permisos sobre auth.* (postgres / SQL editor del dashboard).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── GUARDA 1: confirmación explícita ────────────────────────────────
DO $$
BEGIN
  IF current_setting('mythos.teardown_confirm', true) IS DISTINCT FROM 'RENATO_APPROVED_BACKUP_DONE' THEN
    RAISE EXCEPTION
      'ABORTADO: falta confirmacion. Ejecuta primero:  SET mythos.teardown_confirm = ''RENATO_APPROVED_BACKUP_DONE'';  (solo tras backup nuevo + aprobacion de Renato).';
  END IF;
END $$;

-- ── GUARDA 2: allowlist sana + Terrapizza fuera ─────────────────────
DO $$
DECLARE v_sim int; v_terra int;
BEGIN
  SELECT count(*) INTO v_sim FROM public.restaurants
   WHERE id IN ('a1a10000-0000-4000-8000-000000000001',
                'b2b20000-0000-4000-8000-000000000002',
                'c3c30000-0000-4000-8000-000000000003');
  SELECT count(*) INTO v_terra FROM public.restaurants
   WHERE id IN ('a1a10000-0000-4000-8000-000000000001',
                'b2b20000-0000-4000-8000-000000000002',
                'c3c30000-0000-4000-8000-000000000003')
     AND name ILIKE '%terrapizza%';
  IF v_terra > 0 THEN
    RAISE EXCEPTION 'ABORTADO: Terrapizza aparece en la allowlist (% filas). NO continuar.', v_terra;
  END IF;
  IF v_sim > 3 THEN
    RAISE EXCEPTION 'ABORTADO: la allowlist resolvio % restaurantes (esperado <= 3).', v_sim;
  END IF;
END $$;

-- ── Set de usuarios a borrar (TEMP): sim-anchored MINUS protegidos ──
-- Protegido = tiene rol en algún restaurante NO-sim (staff real / Terrapizza).
-- Captura el dominio @mythos.internal de QA sin un wildcard de dominio peligroso.
CREATE TEMP TABLE _sim_users ON COMMIT DROP AS
WITH sim(id) AS (
  VALUES ('a1a10000-0000-4000-8000-000000000001'::uuid),
         ('b2b20000-0000-4000-8000-000000000002'::uuid),
         ('c3c30000-0000-4000-8000-000000000003'::uuid)
),
cand AS (
  SELECT u.id, u.email
  FROM auth.users u
  WHERE u.email LIKE '%@mythos.test'
     OR EXISTS (SELECT 1 FROM public.user_roles ur
                WHERE ur.user_id = u.id AND ur.restaurant_id IN (SELECT id FROM sim))
),
protegidos AS (
  SELECT DISTINCT ur.user_id
  FROM public.user_roles ur
  WHERE ur.restaurant_id IS NOT NULL
    AND ur.restaurant_id NOT IN (SELECT id FROM sim)
)
SELECT c.id, c.email
FROM cand c
WHERE c.id NOT IN (SELECT user_id FROM protegidos);

-- ── GUARDA 3: umbral de usuarios ────────────────────────────────────
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM _sim_users;
  IF n > 40 THEN
    RAISE EXCEPTION 'ABORTADO: % usuarios candidatos a borrar (umbral 40). Revisar el dry-run.', n;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- BORRADO en orden de dependencias. Las ~51 FKs CASCADE a restaurants se
-- limpian solas en el paso (4). Acá borramos los BLOQUEADORES primero.
-- ════════════════════════════════════════════════════════════════════

-- 1) Árbol de pedidos. orders.restaurant_id es ON DELETE RESTRICT → debe
--    borrarse ANTES de restaurants. Cascada: order_items → order_item_extras,
--    order_status_history, order_item_station_log, payments, delivery_orders.
DELETE FROM public.orders
 WHERE restaurant_id IN ('a1a10000-0000-4000-8000-000000000001',
                         'b2b20000-0000-4000-8000-000000000002',
                         'c3c30000-0000-4000-8000-000000000003');

-- 2) Bloqueadores del DELETE de restaurants (no-cascade):
DELETE FROM public.user_profiles                 -- FK sin acción (NO ACTION) → bloquea
 WHERE restaurant_id IN ('a1a10000-0000-4000-8000-000000000001',
                         'b2b20000-0000-4000-8000-000000000002',
                         'c3c30000-0000-4000-8000-000000000003');

DELETE FROM public.platform_events               -- FK SET NULL → evita logs huérfanos
 WHERE restaurant_id IN ('a1a10000-0000-4000-8000-000000000001',
                         'b2b20000-0000-4000-8000-000000000002',
                         'c3c30000-0000-4000-8000-000000000003');

-- 3) Roles de simulación (email sim, o anclados a restaurante sim, o del set TEMP):
DELETE FROM public.user_roles
 WHERE email LIKE '%@mythos.test'
    OR restaurant_id IN ('a1a10000-0000-4000-8000-000000000001',
                         'b2b20000-0000-4000-8000-000000000002',
                         'c3c30000-0000-4000-8000-000000000003')
    OR user_id IN (SELECT id FROM _sim_users);

-- 4) Restaurantes sim → CASCADE borra las ~51 tablas tenant restantes
--    (menu, tables, zones, riders, caja, ratings, reservations, stock,
--     staff_sessions, support, settings, addons, subscriptions, etc.).
DELETE FROM public.restaurants
 WHERE id IN ('a1a10000-0000-4000-8000-000000000001',
              'b2b20000-0000-4000-8000-000000000002',
              'c3c30000-0000-4000-8000-000000000003');

-- 5) Cuentas auth de simulación/QA (identities antes que users):
DELETE FROM auth.identities WHERE user_id IN (SELECT id FROM _sim_users);
DELETE FROM auth.users      WHERE id      IN (SELECT id FROM _sim_users);

-- ── POST-CHECK in-transacción: aborta si algo quedó mal ─────────────
DO $$
DECLARE leftover int; terra int; orph_orders int;
BEGIN
  SELECT count(*) INTO leftover FROM public.restaurants
   WHERE id IN ('a1a10000-0000-4000-8000-000000000001',
                'b2b20000-0000-4000-8000-000000000002',
                'c3c30000-0000-4000-8000-000000000003');
  IF leftover <> 0 THEN RAISE EXCEPTION 'POST-CHECK: quedan % restaurantes sim.', leftover; END IF;

  SELECT count(*) INTO terra FROM public.restaurants WHERE name ILIKE '%terrapizza%';
  IF terra < 1 THEN RAISE EXCEPTION 'POST-CHECK: Terrapizza no esta presente (% filas) — abortar.', terra; END IF;

  SELECT count(*) INTO orph_orders FROM public.orders o
   WHERE NOT EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = o.restaurant_id);
  IF orph_orders <> 0 THEN RAISE EXCEPTION 'POST-CHECK: % orders huerfanas (cascada fallo).', orph_orders; END IF;

  RAISE NOTICE 'POST-CHECK OK: sim restaurants=0, terrapizza presente, sin orders huerfanas.';
END $$;

-- ════════════════════════════════════════════════════════════════════
-- DEFAULT SEGURO: NO aplica nada. Para ejecutar de verdad (tras backup +
-- aprobación + revisión del post-check), cambiar ROLLBACK por COMMIT.
-- ════════════════════════════════════════════════════════════════════
ROLLBACK;
-- COMMIT;
