-- ════════════════════════════════════════════════════════════════════
-- 151 · FIX — superadmin_delete_restaurant borra TODAS las dependencias
--        (no sólo orders/user_profiles/staff_broadcasts) + limpieza de
--        huérfanos residuales, una sola vez.
-- ────────────────────────────────────────────────────────────────────
-- BUG (mig 146): la RPC borraba explícito sólo orders, user_profiles y
-- staff_broadcasts y confiaba en ON DELETE CASCADE para el resto. Pero hay
-- FKs a restaurants SIN cascade que BLOQUEAN el borrado (confirmado en prod
-- vía pg_constraint, 2026-07-06):
--   • delivery_zones    · restaurant_id NOT NULL · NO ACTION   ← el bug reportado
--   • delivery_channels · restaurant_id NOT NULL · NO ACTION
--   • delivery_riders   · restaurant_id NOT NULL · NO ACTION
--   • orders            · restaurant_id NOT NULL · RESTRICT     (ya se borraba)
-- Al borrar un restaurante con zonas de delivery => "violates foreign key
-- constraint delivery_zones_restaurant_id_fkey" y ROLLBACK (no borra nada).
--
-- Además hay columnas restaurant_id SIN FK (no bloquean, pero dejan filas
-- huérfanas al borrar): availability_log, delivery_orders, staff_broadcasts.
--
-- ORDEN de llaves foráneas (del grafo de FKs en vivo):
--   delivery_orders referencia delivery_zones/delivery_channels (NO ACTION) y
--   delivery_riders (SET NULL) → se borra delivery_orders PRIMERO, después
--   zones/channels/riders. orders va primero (RESTRICT) y su cascada limpia
--   order_items ANTES de que restaurants cascade menu_items (order_items ->
--   menu_items es RESTRICT). turnos_caja -> cajas es NO ACTION pero ambos
--   cascadean desde restaurants y NO ACTION se chequea al final del statement,
--   así que la cascada final los borra juntos sin bloquear.
--
-- Se dejan como están (ON DELETE SET NULL, intencional): platform_events,
-- marketplace_events, marketplace_reports.reporter_restaurant_id,
-- terms_acceptance, y restaurants.parent_company_id (sucursales hijas se
-- desvinculan, no se borran).
--
-- SEGURIDAD (sin cambios respecto de 146): SECURITY DEFINER + SET
-- search_path=public + fail-closed (superadmin O service_role) + REVOKE ALL
-- FROM PUBLIC, anon + GRANT acotado. NO toca auth.users (eso lo hace el
-- endpoint api/delete-restaurant.js con la Admin API, que además protege la
-- cuenta oficial, superadmins y usuarios con acceso a otro local). Todo el
-- borrado ocurre en UNA transacción (atómico: todo o nada). Idempotente.
--
-- Aplicar en el SQL Editor de Supabase (idioma en INGLÉS).
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ── PARTE 1 — Borrado seguro y COMPLETO del restaurante ──────────────
CREATE OR REPLACE FUNCTION public.superadmin_delete_restaurant(p_restaurant_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name              text;
  v_orders            int := 0;
  v_users             int := 0;
  v_children          int := 0;
  v_delivery_orders   int := 0;
  v_delivery_zones    int := 0;
  v_delivery_channels int := 0;
  v_delivery_riders   int := 0;
  v_availability      int := 0;
  v_broadcasts        int := 0;
  v_jwt_role          text;
BEGIN
  -- Fail-closed: superadmin autenticado O service_role (el endpoint api/ ya
  -- valida al llamador; la RPC vuelve a exigirlo por defensa en profundidad).
  v_jwt_role := COALESCE(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  IF NOT (COALESCE(public.get_my_role() = 'superadmin', false) OR v_jwt_role = 'service_role') THEN
    RAISE EXCEPTION 'Solo el superadmin puede eliminar restaurantes' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT name INTO v_name FROM public.restaurants WHERE id = p_restaurant_id;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Restaurante inexistente';
  END IF;

  -- Resumen previo (conteos de referencia).
  SELECT count(*) INTO v_orders   FROM public.orders      WHERE restaurant_id = p_restaurant_id;
  SELECT count(*) INTO v_users    FROM public.user_roles  WHERE restaurant_id = p_restaurant_id;
  SELECT count(*) INTO v_children FROM public.restaurants WHERE parent_company_id = p_restaurant_id AND id <> p_restaurant_id;

  -- 1) orders (RESTRICT). Cascada: order_items, order_item_extras,
  --    order_status_history, order_item_station_log y delivery_orders con order_id.
  --    SET NULL en cancelaciones/movimientos_caja, ratings, waiter_calls/debts,
  --    quejas_sugerencias, manager_approvals, documentos_electronicos.order_id...
  DELETE FROM public.orders WHERE restaurant_id = p_restaurant_id;

  -- 2) Cluster delivery — NINGUNO cascada desde restaurants. delivery_orders va
  --    PRIMERO porque referencia zones/channels (NO ACTION) y riders (SET NULL).
  --    Se barren también los delivery_orders "sueltos" (order_id NULL) por
  --    restaurant_id o por pertenencia de zona/canal/rider del restaurante.
  IF to_regclass('public.delivery_orders') IS NOT NULL THEN
    DELETE FROM public.delivery_orders d
     WHERE d.restaurant_id = p_restaurant_id
        OR d.zone_id    IN (SELECT id FROM public.delivery_zones    WHERE restaurant_id = p_restaurant_id)
        OR d.channel_id IN (SELECT id FROM public.delivery_channels WHERE restaurant_id = p_restaurant_id)
        OR d.rider_id   IN (SELECT id FROM public.delivery_riders   WHERE restaurant_id = p_restaurant_id);
    GET DIAGNOSTICS v_delivery_orders = ROW_COUNT;
  END IF;

  IF to_regclass('public.delivery_zones') IS NOT NULL THEN
    DELETE FROM public.delivery_zones WHERE restaurant_id = p_restaurant_id;
    GET DIAGNOSTICS v_delivery_zones = ROW_COUNT;
  END IF;

  IF to_regclass('public.delivery_channels') IS NOT NULL THEN
    DELETE FROM public.delivery_channels WHERE restaurant_id = p_restaurant_id;
    GET DIAGNOSTICS v_delivery_channels = ROW_COUNT;
  END IF;

  IF to_regclass('public.delivery_riders') IS NOT NULL THEN
    DELETE FROM public.delivery_riders WHERE restaurant_id = p_restaurant_id;
    GET DIAGNOSTICS v_delivery_riders = ROW_COUNT;
  END IF;

  -- 3) availability_log — restaurant_id SIN FK (cascada indirecta vía
  --    menu_item_id, pero se borra explícito por si menu_item_id fuese NULL).
  IF to_regclass('public.availability_log') IS NOT NULL THEN
    DELETE FROM public.availability_log WHERE restaurant_id = p_restaurant_id;
    GET DIAGNOSTICS v_availability = ROW_COUNT;
  END IF;

  -- 4) user_profiles (tabla PIN legacy, NO ACTION) — sólo si existe.
  IF to_regclass('public.user_profiles') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.user_profiles WHERE restaurant_id = $1' USING p_restaurant_id;
  END IF;

  -- 5) staff_broadcasts — restaurant_id SIN FK (no cascada).
  IF to_regclass('public.staff_broadcasts') IS NOT NULL THEN
    DELETE FROM public.staff_broadcasts WHERE restaurant_id = p_restaurant_id;
    GET DIAGNOSTICS v_broadcasts = ROW_COUNT;
  END IF;

  -- 6) restaurants — cascada TODO el resto (tables/menu/subs/turnos/cajas/stock/
  --    fiscal/marketplace/reservations/kitchen/overrides/settings/personal...).
  --    SET NULL en platform_events, marketplace_events,
  --    marketplace_reports.reporter_restaurant_id, terms_acceptance y en las
  --    sucursales hijas (parent_company_id).
  DELETE FROM public.restaurants WHERE id = p_restaurant_id;

  RETURN jsonb_build_object(
    'restaurant_id',             p_restaurant_id,
    'name',                      v_name,
    'orders_deleted',            v_orders,
    'user_roles_deleted',        v_users,
    'children_detached',         v_children,
    'delivery_orders_deleted',   v_delivery_orders,
    'delivery_zones_deleted',    v_delivery_zones,
    'delivery_channels_deleted', v_delivery_channels,
    'delivery_riders_deleted',   v_delivery_riders,
    'availability_log_deleted',  v_availability,
    'staff_broadcasts_deleted',  v_broadcasts
  );
END;
$$;
REVOKE ALL     ON FUNCTION public.superadmin_delete_restaurant(UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.superadmin_delete_restaurant(UUID) TO authenticated;

-- ── PARTE 2 — LIMPIEZA DE HUÉRFANOS (una sola vez) ───────────────────
-- Huérfano = fila con restaurant_id NO NULO que ya no existe en restaurants.
-- SÓLO puede existir en tablas con columna restaurant_id SIN FK
-- (availability_log, delivery_orders, staff_broadcasts): en tablas con FK es
-- imposible; en tablas SET NULL sólo quedan NULLs (se reportan, NO se borran).
DROP TABLE IF EXISTS _mythos_151_report;
CREATE TEMP TABLE _mythos_151_report (tbl text, col text, action text, cnt bigint);

DO $cleanup$
DECLARE
  r    record;
  n    bigint;
  totd bigint := 0;   -- total borrados
  totr bigint := 0;   -- total remanentes (debe ser 0)
BEGIN
  -- (a) Borrar huérfanos SOLO donde es seguro (restaurant_id sin FK).
  FOR r IN SELECT t AS tbl
             FROM unnest(ARRAY['availability_log','delivery_orders','staff_broadcasts']) AS t
  LOOP
    IF to_regclass('public.'||r.tbl) IS NOT NULL THEN
      EXECUTE format(
        'WITH d AS (DELETE FROM public.%I x '||
        ' WHERE x.restaurant_id IS NOT NULL '||
        '   AND NOT EXISTS (SELECT 1 FROM public.restaurants rr WHERE rr.id = x.restaurant_id) '||
        ' RETURNING 1) SELECT count(*) FROM d', r.tbl) INTO n;
      INSERT INTO _mythos_151_report VALUES (r.tbl, 'restaurant_id', 'orphans_deleted', n);
      totd := totd + n;
      RAISE NOTICE '[151 cleanup] %.restaurant_id orphans_deleted = %', r.tbl, n;
    END IF;
  END LOOP;

  -- (b) Barrido de completitud: verificar que NO queden huérfanos en NINGUNA
  --     columna %restaurant_id% de public (en tablas con FK debe dar 0).
  FOR r IN
    SELECT c.table_name AS tbl, c.column_name AS col
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public'
       AND c.column_name LIKE '%restaurant_id%'
       AND NOT (c.table_name = 'restaurants' AND c.column_name = 'parent_company_id')
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I x '||
      ' WHERE x.%I IS NOT NULL '||
      '   AND NOT EXISTS (SELECT 1 FROM public.restaurants rr WHERE rr.id = x.%I)',
      r.tbl, r.col, r.col) INTO n;
    IF n > 0 THEN
      INSERT INTO _mythos_151_report VALUES (r.tbl, r.col, 'orphans_REMAINING', n);
      totr := totr + n;
      RAISE WARNING '[151 cleanup] REMAINING orphans in %.% = %', r.tbl, r.col, n;
    END IF;
  END LOOP;

  -- (c) Tablas SET NULL: reportar NULLs (informativo, NO se borran).
  FOR r IN
    SELECT v.tbl, v.col FROM (VALUES
      ('platform_events',     'restaurant_id'),
      ('marketplace_events',  'restaurant_id'),
      ('marketplace_reports', 'reporter_restaurant_id'),
      ('terms_acceptance',    'restaurant_id')
    ) AS v(tbl, col)
  LOOP
    IF to_regclass('public.'||r.tbl) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I x WHERE x.%I IS NULL', r.tbl, r.col) INTO n;
      INSERT INTO _mythos_151_report VALUES (r.tbl, r.col, 'null_left_as_is', n);
    END IF;
  END LOOP;

  INSERT INTO _mythos_151_report VALUES ('(TOTAL)', '', 'orphans_deleted',   totd);
  INSERT INTO _mythos_151_report VALUES ('(TOTAL)', '', 'orphans_REMAINING', totr);
  RAISE NOTICE '[151 cleanup] TOTAL orphans_deleted=% remaining=%', totd, totr;
END;
$cleanup$;

COMMIT;

-- Recargar el cache de esquema de PostgREST.
NOTIFY pgrst, 'reload schema';

-- Reporte de la limpieza (última sentencia => se ve en la grilla del editor).
SELECT tbl, col, action, cnt
  FROM _mythos_151_report
 ORDER BY (CASE WHEN tbl = '(TOTAL)' THEN 1 ELSE 0 END), action, tbl, col;
