-- ═══════════════════════════════════════════════════════════════════
-- 130 · Lockdown de PRECIOS de order_items / order_item_extras para anon
-- ───────────────────────────────────────────────────────────────────
-- Problema (CONFIRMADO en vivo): con la anon key pública,
--     GET /rest/v1/order_items?select=unit_price,total_price → 200 (todos los locales)
-- → se reconstruye el total de cualquier pedido de cualquier restaurante sumando
-- ítems. Misma fuga financiera que cerramos en orders (mig 129), por otra puerta.
--
-- ⚠ ORDEN CRÍTICO: esta migración va DESPUÉS de deployar y verificar el cambio de
-- código que pasó el INSERT del cliente de  .insert(...).select()  (RETURNING *)  a
-- .insert(...).select('id')  en src/index/main.jsx y src/delivery-cliente/main.jsx.
-- Con el código viejo (RETURNING *), este REVOKE rompería la creación de pedidos
-- (el RETURNING exigiría SELECT de unit_price/total_price, ya revocadas).
--
-- order_item_extras: el cliente lo inserta SIN .select() (sin RETURNING) y no lo
-- lee, así que NO requiere cambio de código previo; se blinda acá mismo.
--
-- NO se toca: la RLS de fila (oi_anon_select / read_order_extras quedan), el INSERT
-- de anon (sigue creando pedidos), ni el rol authenticated (staff sigue viendo
-- precios, aislado por restaurante — mig. 086/092). Es solo un ajuste de GRANT de
-- columnas para anon.
--
-- Nombres reales de columnas (verificados contra el esquema, NO inferidos):
--   • order_items: el id de menú es `item_id` (NO `menu_item_id`); el estado por
--     ítem es `kitchen_status` (NO existe una columna `status`). Financieras que
--     quedan FUERA: unit_price, total_price (precios) y paid_quantity (mig 128,
--     estado de cobro). production_station/started_at/ready_at tampoco se conceden
--     (el cliente anon no las necesita; tras el Paso 1 solo lee el RETURNING `id`).
--   • order_item_extras: el precio es `extra_price` → queda FUERA.
-- ═══════════════════════════════════════════════════════════════════
BEGIN;

-- ── order_items: revocar TODO el SELECT de anon y re-conceder SOLO columnas
--    operativas NO financieras.
REVOKE SELECT ON public.order_items FROM anon;
GRANT  SELECT (
  id,
  order_id,
  item_id,
  item_name,
  quantity,
  kitchen_status,
  observations,
  created_at
) ON public.order_items TO anon;

-- ── order_item_extras: misma idea; queda FUERA `extra_price`. El cliente solo
--    inserta (sin RETURNING) y no lo lee → no hace falta tocar código.
REVOKE SELECT ON public.order_item_extras FROM anon;
GRANT  SELECT (
  id,
  order_item_id,
  extra_name
) ON public.order_item_extras TO anon;

COMMIT;

-- Recargar el cache de esquema de PostgREST para que tome los nuevos privilegios.
NOTIFY pgrst, 'reload schema';

SELECT 'migracion 130 aplicada (anon order_items/extras price lockdown)' AS status;
