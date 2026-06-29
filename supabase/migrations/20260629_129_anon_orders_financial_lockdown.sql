-- ═══════════════════════════════════════════════════════════════════
-- 129 · Lockdown FINANCIERO de orders para el rol ANÓNIMO (anon)
-- ───────────────────────────────────────────────────────────────────
-- Problema (CONFIRMADO en vivo): la anon key es pública (va en el browser).
-- La mig. 102, al cerrar la PII, RE-OTORGÓ a anon el SELECT de columnas
-- financieras de orders. Resultado: con la anon key, cualquiera podía leer
-- columnas financieras de orders de TODOS los locales:
--     GET /rest/v1/orders?select=total,payment_status  → 200 (7 restaurantes).
--
-- Solución (a nivel de PRIVILEGIO, independiente de RLS): anon pierde el SELECT
-- de TODA la tabla orders y se le re-otorga SELECT SOLO de las columnas
-- operativas que el flujo del cliente realmente usa. Las financieras/sensibles
-- quedan SIN conceder → dejan de ser legibles por anon vía PostgREST.
--
-- Verificado en el código (src/index/main.jsx, src/delivery-cliente/main.jsx,
-- public/diag.html): anon SOLO lee de orders id / order_number / status, y el
-- INSERT usa RETURNING explícito .select('id,order_number,status') (NO select=*),
-- así que crear pedidos + el tracking por order_number + el realtime de estado
-- siguen funcionando.
--
-- NO se toca:
--   • La RLS de fila (orders_anon_select sigue igual).
--   • El INSERT de anon (sigue creando pedidos; privilegio separado del SELECT).
--   • El rol authenticated (staff): caja/cocina/mozo/admin/gerente siguen viendo
--     total y cobro, aislados por restaurante (mig. 086). Esto es solo un ajuste
--     de GRANT de columnas para anon.
--
-- order_items NO se toca a propósito: el cliente lo inserta con
-- .insert(...).select() (RETURNING *), que exige SELECT de TODAS las columnas
-- (incl. unit_price/total_price). Revocarlas rompería el RETURNING → rompería la
-- creación del pedido. Un lockdown de order_items requiere PRIMERO cambiar el
-- cliente a .insert(...).select('id') (PR de código aparte) y recién después
-- revocar columnas. Ver nota en la respuesta del PR.
--
-- Vector pendiente (fuera de alcance de esta migración): el realtime de orders
-- (postgres_changes, src/index/main.jsx) entrega la fila completa en p.new — los
-- payloads de realtime NO están gobernados por los GRANT de columna, así que
-- total/payment_status podrían seguir expuestos a un suscriptor anon. Esta
-- migración cierra el vector REST (GET); el realtime es un cierre separado.
-- ═══════════════════════════════════════════════════════════════════
BEGIN;

-- orders: revocar TODO el SELECT de anon y re-conceder SOLO columnas operativas.
-- Quedan FUERA (ya no legibles por anon) las que la mig. 102 había re-otorgado:
--   subtotal, discount_amount, coupon_code, total, payment_method, payment_status,
--   payment_provider, payment_ref, paid_by, paid_at, paid_by_name, waiter_id,
--   waiter_name, external_order_id, channel, language, updated_at, completed_at,
--   invoice_delivery_method, invoice_requested_at.
REVOKE SELECT ON public.orders FROM anon;
GRANT  SELECT (
  id,
  restaurant_id,
  table_id,
  order_number,
  order_type,
  status,
  created_at,
  delivered_to_table_at,
  requires_invoice,
  invoice_status
) ON public.orders TO anon;

COMMIT;

-- Recargar el cache de esquema de PostgREST para que tome los nuevos privilegios.
NOTIFY pgrst, 'reload schema';

SELECT 'migracion 129 aplicada (anon orders financial lockdown)' AS status;
