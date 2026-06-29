-- ═══════════════════════════════════════════════════════════════════
-- 132 · Lockdown FINAL de orders/order_items/delivery_orders para anon
-- ───────────────────────────────────────────────────────────────────
-- ETAPA 3 de 3 (Fase 2+3, Nivel 2). SE APLICA A MANO, DESPUÉS de haber
-- aplicado la mig. 131 (RPCs) y verificado EN VIVO que crear+seguir pedido
-- funcionan POR RPC (cliente QR dine-in + delivery). Renato confirmó esa
-- verificación el 2026-06-29.
--
-- Cierra los 2 vectores residuales del leak de orders que las migs 129/130
-- (REST por GRANT de columna) NO podían cerrar:
--   (1) REALTIME full-row: postgres_changes entrega la fila COMPLETA en p.new,
--       ignorando los GRANT de columna → un suscriptor anon a orders /
--       order_items / delivery_orders recibía total / payment_status /
--       unit_price / total_price / PII / cash_amount cross-tenant.
--   (2) ENUMERACIÓN REST: aunque 129/130 recortaron columnas, anon seguía
--       teniendo SELECT (filas) + INSERT directos sobre estas tablas.
--
-- Fix: anon pierde el acceso DIRECTO (SELECT/INSERT/UPDATE/DELETE) a las 3
-- tablas. Crear y seguir pedido pasan EXCLUSIVAMENTE por las RPCs SECURITY
-- DEFINER de la mig 131 (create_order / get_order_status), que corren con los
-- derechos del owner (no de anon) → siguen funcionando sin estos privilegios.
--
-- Se cierra por DOS capas (defensa en profundidad, igual que 102/103/129):
--   • PRIVILEGIO: REVOKE SELECT/INSERT/UPDATE/DELETE a anon (cierra REST).
--   • RLS: se DROPEAN las policies anon de SELECT/INSERT → la tabla queda en
--     default-deny para anon → REST devuelve 0 filas y, sobre todo, apply_rls
--     de Realtime no entrega NINGUNA fila a un suscriptor anon (cierra (1)).
--
-- Staff (authenticated) NO se toca: las policies *_auth_* (orders_auth_*,
-- oi_auth_*, dord_auth_*) creadas en la mig 086 (tenant-scoped por
-- get_my_restaurant_id) quedan intactas. caja/cocina/mozo/admin/gerente
-- siguen viendo total/cobro/precios igual que hoy. service_role bypassa RLS.
--
-- Idempotente: REVOKE no falla si el privilegio ya no está; DROP POLICY IF
-- EXISTS y ENABLE RLS son no-ops si ya están en ese estado.
--
-- Rollback (si se necesitara revertir): re-aplicar los GRANT de columna y las
-- policies anon de las migs 102/129/130. No debería hacer falta: la 131 ya
-- cubre el flujo del cliente.
-- ═══════════════════════════════════════════════════════════════════
BEGIN;

-- Aseguramos RLS habilitada (no-op si ya lo está; mig 086 la habilitó). Es lo
-- que hace que "sin policy anon = default-deny" valga para REST y Realtime.
ALTER TABLE public.orders          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_orders ENABLE ROW LEVEL SECURITY;

-- ── orders ──────────────────────────────────────────────────────────
-- Privilegio: anon sin acceso directo. (UPDATE/DELETE ya estaban revocados
-- en mig 102; SELECT estaba recortado por columnas en mig 129.)
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.orders FROM anon;
-- RLS: sin policy de lectura anon → Realtime no entrega filas a anon.
DROP POLICY IF EXISTS orders_anon_select ON public.orders;   -- SELECT USING(true), mig 086
DROP POLICY IF EXISTS orders_anon_insert ON public.orders;   -- INSERT WITH CHECK(true), mig 086
-- (orders_anon_update ya fue dropeada en mig 102; orders_auth_* intactas)

-- ── order_items ─────────────────────────────────────────────────────
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.order_items FROM anon;
DROP POLICY IF EXISTS oi_anon_select ON public.order_items;  -- SELECT USING(true), mig 102
DROP POLICY IF EXISTS oi_anon_insert ON public.order_items;  -- INSERT WITH CHECK(true), mig 102
-- (oi_anon_all ya fue dropeada en mig 102; oi_auth_* intactas)

-- ── delivery_orders ─────────────────────────────────────────────────
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.delivery_orders FROM anon;
DROP POLICY IF EXISTS dord_anon_select ON public.delivery_orders; -- SELECT USING(true), mig 102
DROP POLICY IF EXISTS dord_anon_insert ON public.delivery_orders; -- INSERT WITH CHECK(true), mig 102
-- (dord_anon_all dropeada en 102; dord_anon_update dropeada en 103; dord_auth_* intactas)

-- ── order_item_extras (cierre de completitud) ───────────────────────
-- NO está en la publicación supabase_realtime (sin vector realtime) y
-- extra_price nunca se concedió a anon (mig 130). Solo le sacamos a anon el
-- acceso REST directo a nivel privilegio. Las policies PUBLIC read/insert_
-- order_extras (mig 001) quedan para staff (authenticated): con el privilegio
-- de anon revocado, anon recibe permission-denied aunque la policy sea USING(true).
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.order_item_extras FROM anon;

-- ── order_status_history (cierre que la revisión adversarial detectó) ─
-- Tabla hermana del flujo de tracking, en la publicación supabase_realtime
-- (mig 001) y con policies PUBLIC read_status_history(SELECT USING true) /
-- insert_status_history(INSERT WCHECK true) que aplican también a anon.
-- Dos vectores residuales que la 132 cerraría dejándola así:
--   • INTEGRIDAD (el grave): mig 018 instaló trg_deduct_stock_on_status_history
--     (AFTER INSERT, SECURITY DEFINER) → deduct_stock_for_order(NEW.order_id)
--     cuando NEW.status='paid', SIN chequeo de tenant del que inserta. Un anon
--     podía INSERT con un order_id de OTRO local + status='paid' y forzar el
--     descuento de stock ajeno (si ese local tiene auto_stock_discount=true).
--   • CONFIDENCIALIDAD: anon leía/recibía por realtime id/order_id/status/ts de
--     todos los pedidos (existencia/volumen/timing cross-tenant).
-- create_order (mig 131, DEFINER) ya inserta order_status_history por su cuenta,
-- y el cliente sigue el estado por get_order_status (NO lee esta tabla), así que
-- anon NO necesita acceso directo. Revocamos el privilegio de anon → cierra REST,
-- el INSERT (vector de integridad) y el realtime (Supabase Realtime exige el
-- privilegio SELECT del rol para entregar filas).
-- NO se dropean las policies PUBLIC (las usa staff): a diferencia de las otras
-- tablas, acá las policies anon-reachable son PUBLIC (compartidas con
-- authenticated), no policies *_anon_* propias. Sin privilegio, anon queda
-- denegado igual. Tenant-scopear esas 2 policies PUBLIC queda como cleanup
-- de Sprint 2 (lo difirieron 103/104) y requiere aprobación aparte.
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.order_status_history FROM anon;

COMMIT;

-- Recargar el cache de esquema de PostgREST para que tome los cambios de privilegio.
NOTIFY pgrst, 'reload schema';

SELECT 'migracion 132 aplicada (anon orders/order_items/delivery_orders lockdown FINAL)' AS status;
