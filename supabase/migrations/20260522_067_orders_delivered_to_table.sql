-- ============================================================
-- 067 — orders.delivered_to_table_at
-- Marca el momento exacto en que el mozo confirma la entrega
-- física del pedido a la mesa. Distinto de:
--   * status='ready' / pending_payment sin delivered_to_table_at
--     = cocina ya despachó pero el mozo aún no llevó la comida.
--   * delivered_to_table_at IS NOT NULL = el cliente ya tiene
--     la comida; lo único que puede quedar pendiente es el cobro.
-- Esto separa el paso de cocina ("DESPACHAR / ENTREGADO") del
-- paso del mozo ("entrega física a la mesa") que antes estaban
-- conflados en el estado 'pending_payment'.
-- ============================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delivered_to_table_at TIMESTAMPTZ;

-- Índice por table_id ya existe; este ayuda al mozo a filtrar
-- mesas con entrega física pendiente.
CREATE INDEX IF NOT EXISTS idx_orders_delivered_to_table_at
  ON public.orders(delivered_to_table_at)
  WHERE delivered_to_table_at IS NOT NULL;

GRANT SELECT, UPDATE ON public.orders TO authenticated, anon;
