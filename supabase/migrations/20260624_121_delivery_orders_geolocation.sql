-- Migración 121: coordenadas geográficas + esquina para delivery_orders.
-- ─────────────────────────────────────────────────────────────────────────
-- Captura del cliente (panel delivery-cliente). El pin del mapa es la FUENTE
-- DE VERDAD de la ubicación: el cliente lo posiciona por GPS / Places Autocomplete
-- / arrastre. Estas columnas dejan la coordenada lista para que admin/rider/ticket
-- la consuman (eso es un prompt posterior — acá sólo se persiste).
--
-- Columnas NULLABLE e idempotentes (ADD COLUMN IF NOT EXISTS) — bajo riesgo.
-- NO toca RLS ni grants: el INSERT del cliente anónimo en delivery_orders ya
-- existe (mig. 063); acá sólo se agregan columnas a esa misma fila.

ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS delivery_lat    NUMERIC;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS delivery_lng    NUMERIC;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS delivery_corner TEXT;

NOTIFY pgrst, 'reload schema';

-- Verificación
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'delivery_orders'
  AND column_name IN ('delivery_lat', 'delivery_lng', 'delivery_corner')
ORDER BY column_name;
