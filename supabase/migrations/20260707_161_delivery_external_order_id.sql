-- ════════════════════════════════════════════════════════════════════
-- 161 · Nº de pedido de la plataforma externa en delivery_orders
-- ════════════════════════════════════════════════════════════════════
-- [PARA PEGAR EN SUPABASE]
--
-- Parte 2 del bloque Delivery. `orders` ya tiene `external_order_id` (mig 037),
-- pero `delivery_orders` NO — y la lista/detalle de Admin→Delivery lee de
-- delivery_orders. Esta migración agrega la columna ahí para poder mostrar el
-- Nº de pedido de PedidosYa/Monchis/etc. en la ficha de dispatch.
--
-- Idempotente (IF NOT EXISTS). Solo agrega columnas; no toca RLS ni datos.
-- El defensive ADD sobre orders es no-op en prod (037 ya lo creó) y cubre una
-- DB fresca donde 037 no corrió.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.delivery_orders ADD COLUMN IF NOT EXISTS external_order_id TEXT;
ALTER TABLE public.orders          ADD COLUMN IF NOT EXISTS external_order_id VARCHAR;

NOTIFY pgrst, 'reload schema';

-- Verificación
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema='public'
  AND column_name='external_order_id'
  AND table_name IN ('orders','delivery_orders')
ORDER BY table_name;
