-- ═══════════════════════════════════════════════════════════════════
-- 102 · Blindaje anti-fuga para el rol ANÓNIMO (anon)
-- ───────────────────────────────────────────────────────────────────
-- Problema: la anon key es pública (va en el frontend). Con SELECT a nivel
-- tabla + RLS USING(true), cualquiera podía volcar PII de clientes de TODOS
-- los locales (GET /rest/v1/delivery_orders?select=* → nombres, teléfonos,
-- direcciones) y manipular pedidos ajenos.
--
-- Solución (defensa en profundidad, a nivel de PRIVILEGIO, independiente de RLS):
--   1) anon pierde el SELECT de columnas con PII en orders/delivery_orders/restaurants;
--      se le re-otorga SELECT SOLO de columnas operativas/branding (las que usa
--      el flujo del cliente QR / delivery). INSERT/UPDATE de sus propios datos
--      se mantienen (privilegios separados del SELECT).
--   2) anon pierde UPDATE de orders y UPDATE/DELETE de order_items, y DELETE de
--      delivery_orders (el cliente nunca los usa) → no puede alterar pedidos ajenos.
--
-- Los paneles de staff (caja/cocina/mozo/admin/gerente/rider) usan el rol
-- `authenticated` (login) → NO se ven afectados; siguen viendo todo, aislados
-- por restaurante (mig. 086).
-- ═══════════════════════════════════════════════════════════════════
BEGIN;

-- ── orders ──────────────────────────────────────────────────────────
REVOKE SELECT ON public.orders FROM anon;
GRANT  SELECT (id, restaurant_id, table_id, order_number, order_type, status, subtotal, discount_amount, coupon_code, total, payment_method, language, created_at, updated_at, completed_at, channel, external_order_id, waiter_id, paid_by, paid_at, paid_by_name, waiter_name, payment_status, delivered_to_table_at, requires_invoice, invoice_delivery_method, invoice_requested_at, invoice_status, payment_provider, payment_ref)
  ON public.orders TO anon;
DROP POLICY IF EXISTS orders_anon_update ON public.orders;   -- el cliente nunca actualiza pedidos
REVOKE UPDATE, DELETE ON public.orders FROM anon;            -- privilegio: imposible alterar/borrar pedidos
REVOKE UPDATE, DELETE ON public.order_items FROM anon;

-- ── delivery_orders ─────────────────────────────────────────────────
REVOKE SELECT ON public.delivery_orders FROM anon;
GRANT  SELECT (id, order_id, rider_id, zone_id, channel_id, delivery_fee, channel_commission, rider_status, order_type_detail, confirmed_at, picked_up_at, delivered_at, estimated_delivery_at, created_at, assigned_at, order_total, order_number, channel, canal, restaurant_id, order_type, zone_name, estimated_minutes, status, rider_name, requires_invoice, invoice_delivery_method, invoice_requested_at, invoice_status)
  ON public.delivery_orders TO anon;
DROP POLICY IF EXISTS dord_anon_all ON public.delivery_orders;
CREATE POLICY dord_anon_select ON public.delivery_orders FOR SELECT TO anon USING (true);
CREATE POLICY dord_anon_insert ON public.delivery_orders FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY dord_anon_update ON public.delivery_orders FOR UPDATE TO anon USING (true) WITH CHECK (true); -- auto-asignación de rider

-- ── order_items ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS oi_anon_all ON public.order_items;
CREATE POLICY oi_anon_select ON public.order_items FOR SELECT TO anon USING (true);
CREATE POLICY oi_anon_insert ON public.order_items FOR INSERT TO anon WITH CHECK (true);

-- ── restaurants (oculta datos del dueño: owner_email/ruc/legal_name/caja) ──
REVOKE SELECT ON public.restaurants FROM anon;
GRANT  SELECT (id, name, address, phone, instagram, website, logo_initials, cover_style, timezone, is_active, created_at, updated_at, status, country, city, cover_image_url, logo_url, currency, maintenance_mode, maintenance_message, lat, lng, reservation_window_hours, reservation_alert_minutes, opening_hours, is_open, auto_provisioned, parent_company_id)
  ON public.restaurants TO anon;

COMMIT;

-- Recargar el cache de esquema de PostgREST para que tome los nuevos privilegios
NOTIFY pgrst, 'reload schema';

SELECT 'migracion 102 aplicada' AS status;
