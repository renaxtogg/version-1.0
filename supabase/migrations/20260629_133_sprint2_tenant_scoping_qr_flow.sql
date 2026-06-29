-- ════════════════════════════════════════════════════════════════════
-- 133 · Sprint 2 · Lote 1 — TENANT SCOPING de las tablas del flujo QR/delivery
-- ────────────────────────────────────────────────────────────────────
-- Continuación directa de la mig 104, que difirió EXPLÍCITAMENTE estas tablas
-- a "Sprint 2" (ver 104, líneas 28-32: waiter_calls, ratings,
-- order_status_history, order_item_extras, coupons SELECT). Hoy estas 7 tablas
-- tienen policies PUBLIC/authenticated con USING(true)/WITH CHECK(true), así que
-- un staff logueado de un local puede leer/tocar datos de OTRO local.
--
-- Patrón (idéntico a migs 086/092/104):
--   authenticated → public.get_my_role() = 'superadmin'
--                   OR <restaurant_id|join> IN (SELECT public.get_my_company_restaurant_ids())
--   La cláusula superadmin es explícita porque get_my_company_restaurant_ids()
--   devuelve conjunto VACÍO para el superadmin (restaurant_id NULL en user_roles).
--
-- anon: se PRESERVA SOLO lo que el QR/delivery realmente usa (insertar rating,
-- insertar llamada de mozo, leer cupones para validar, leer delivery_settings
-- para cotizar). order_status_history / order_item_extras: anon YA no tiene
-- privilegio (migs 130/132) → NO se crea policy anon para ellas.
--
-- superadmin: sus policies *_superadmin_all (migs 086/103) NO se tocan.
--
-- Idempotente (DROP POLICY IF EXISTS + CREATE). PREPARED — aplicar A MANO en el
-- SQL Editor (en inglés), DESPUÉS de las migs 104 y 132. No la aplica el deploy.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- 1. order_status_history (sin restaurant_id → join a orders por order_id)
--    anon ya sin privilegio (mig 132): no se crea policy anon. La RPC
--    create_order (mig 131, SECURITY DEFINER) inserta como owner, bypassa RLS.
-- ════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "insert_status_history"              ON public.order_status_history; -- mig 001, INSERT WCHECK(true) PUBLIC
DROP POLICY IF EXISTS "read_status_history"                ON public.order_status_history; -- mig 001, SELECT USING(true) PUBLIC
DROP POLICY IF EXISTS "cajero_order_status_history_insert" ON public.order_status_history; -- mig 027, INSERT WCHECK(true) PUBLIC
DROP POLICY IF EXISTS "cajero_order_status_history_select" ON public.order_status_history; -- mig 027, SELECT USING(true) PUBLIC

DROP POLICY IF EXISTS "osh_auth_select" ON public.order_status_history;
CREATE POLICY "osh_auth_select" ON public.order_status_history
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_status_history.order_id
        AND o.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  );

DROP POLICY IF EXISTS "osh_auth_insert" ON public.order_status_history;
CREATE POLICY "osh_auth_insert" ON public.order_status_history
  FOR INSERT TO authenticated
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_status_history.order_id
        AND o.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  );

-- ════════════════════════════════════════════════════════════════════
-- 2. order_item_extras (sin restaurant_id → join order_items → orders)
--    anon ya sin privilegio (migs 130/132): no se crea policy anon.
-- ════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "insert_order_extras"             ON public.order_item_extras; -- mig 001, INSERT WCHECK(true) PUBLIC
DROP POLICY IF EXISTS "read_order_extras"               ON public.order_item_extras; -- mig 001, SELECT USING(true) PUBLIC
DROP POLICY IF EXISTS "cajero_order_item_extras_insert" ON public.order_item_extras; -- mig 027, INSERT WCHECK(true) PUBLIC
DROP POLICY IF EXISTS "cajero_order_item_extras_select" ON public.order_item_extras; -- mig 027, SELECT USING(true) PUBLIC

DROP POLICY IF EXISTS "oie_auth_select" ON public.order_item_extras;
CREATE POLICY "oie_auth_select" ON public.order_item_extras
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      WHERE oi.id = order_item_extras.order_item_id
        AND o.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  );

DROP POLICY IF EXISTS "oie_auth_insert" ON public.order_item_extras;
CREATE POLICY "oie_auth_insert" ON public.order_item_extras
  FOR INSERT TO authenticated
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      WHERE oi.id = order_item_extras.order_item_id
        AND o.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  );

-- ════════════════════════════════════════════════════════════════════
-- 3. ratings (tiene restaurant_id NOT NULL)
--    authenticated: SELECT acotado (admin/gerente/cocina/superadmin leen; el
--    staff NO escribe ratings — los crea el cliente). anon: conserva INSERT.
-- ════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "insert_ratings" ON public.ratings; -- mig 001, INSERT WCHECK(true) PUBLIC
DROP POLICY IF EXISTS "read_ratings"   ON public.ratings; -- mig 001, SELECT USING(true) PUBLIC

DROP POLICY IF EXISTS "ratings_auth_select" ON public.ratings;
CREATE POLICY "ratings_auth_select" ON public.ratings
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

-- anon: el cliente QR/delivery califica (restaurant_id NOT NULL y stars 1-5 los
-- fuerzan los CHECK de columna; WITH CHECK(true) preserva el flujo tal cual).
DROP POLICY IF EXISTS "ratings_anon_insert" ON public.ratings;
CREATE POLICY "ratings_anon_insert" ON public.ratings
  FOR INSERT TO anon
  WITH CHECK (true);

-- ════════════════════════════════════════════════════════════════════
-- 4. waiter_calls (tiene restaurant_id NOT NULL)
--    authenticated: FOR ALL acotado (mozo/caja/gerente leen+insertan+actualizan
--    llamadas de su local). anon: conserva INSERT, acotado a status='pending'
--    (el cliente QR siempre inserta 'pending' — patrón de mig 103 §12).
-- ════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "insert_waiter_calls" ON public.waiter_calls; -- mig 001, INSERT WCHECK(true) PUBLIC
DROP POLICY IF EXISTS "read_waiter_calls"   ON public.waiter_calls; -- mig 001, SELECT USING(true) PUBLIC
DROP POLICY IF EXISTS "update_waiter_calls" ON public.waiter_calls; -- mig 001, UPDATE USING(true) PUBLIC

DROP POLICY IF EXISTS "wc_auth_all" ON public.waiter_calls;
CREATE POLICY "wc_auth_all" ON public.waiter_calls
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

DROP POLICY IF EXISTS "wc_anon_insert" ON public.waiter_calls;
CREATE POLICY "wc_anon_insert" ON public.waiter_calls
  FOR INSERT TO anon
  WITH CHECK (status = 'pending');

-- ════════════════════════════════════════════════════════════════════
-- 5. coupons (tiene restaurant_id)
--    authenticated YA está acotado por "coupons_auth_write" (FOR ALL, mig 104),
--    que cubre el SELECT del admin a SUS cupones. Quitamos las lecturas PUBLIC
--    abiertas (admin_read_coupons = USING(true) cross-tenant + inactivos;
--    read_coupons = is_active=true PUBLIC, también cross-tenant) y dejamos UNA
--    lectura anon explícita para validar cupones (sólo activos).
-- ════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "admin_read_coupons" ON public.coupons; -- mig 010, SELECT USING(true) PUBLIC
DROP POLICY IF EXISTS "read_coupons"       ON public.coupons; -- mig 001, SELECT USING(is_active=true) PUBLIC → la reemplaza la anon-only

DROP POLICY IF EXISTS "coupons_anon_select" ON public.coupons;
CREATE POLICY "coupons_anon_select" ON public.coupons
  FOR SELECT TO anon
  USING (is_active = true);

-- ════════════════════════════════════════════════════════════════════
-- 6. delivery_settings (PK = restaurant_id)
--    authenticated YA está acotado por "delivery_settings_write" (FOR ALL,
--    mig 124), que cubre el SELECT del admin a SU fila. Quitamos la lectura
--    PUBLIC abierta y dejamos lectura anon explícita (cotizar envío; sin PII).
-- ════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "delivery_settings_read" ON public.delivery_settings; -- mig 124, SELECT USING(true) PUBLIC

DROP POLICY IF EXISTS "delivery_settings_anon_select" ON public.delivery_settings;
CREATE POLICY "delivery_settings_anon_select" ON public.delivery_settings
  FOR SELECT TO anon
  USING (true);

-- ════════════════════════════════════════════════════════════════════
-- 7. platform_events (restaurant_id NULLABLE)
--    Hoy SÓLO el superadmin inserta (vía platform_events_superadmin_all, que NO
--    se toca; cubre también eventos sin restaurant_id). El insert PUBLIC abierto
--    (WITH CHECK true) se acota a la empresa: un authenticated no-superadmin sólo
--    podría loguear eventos de SU empresa (hoy ninguno lo hace) y nunca eventos
--    de otro local ni globales (restaurant_id NULL ∉ IN(...) → sólo superadmin).
-- ════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "platform_events_auth_insert" ON public.platform_events; -- mig 103, INSERT WCHECK(true)
CREATE POLICY "platform_events_auth_insert" ON public.platform_events
  FOR INSERT TO authenticated
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

COMMIT;

-- Recargar el cache de esquema de PostgREST.
NOTIFY pgrst, 'reload schema';

SELECT 'migracion 133 aplicada (Sprint 2 Lote 1 — tenant scoping flujo QR/delivery)' AS status;
