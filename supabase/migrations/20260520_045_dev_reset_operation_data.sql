-- ============================================================
-- 045 — DEV RESET: limpieza de datos operativos
-- Borra todo el historial de órdenes, llamadas, ratings y
-- resetea el estado de las mesas. Estructura y menú intactos.
-- EJECUTAR SOLO EN DESARROLLO.
-- ============================================================

-- 1. Limpiar extras de items de órdenes
DELETE FROM public.order_item_extras;

-- 2. Limpiar items de órdenes
DELETE FROM public.order_items;

-- 3. Limpiar historial de estados de órdenes
DELETE FROM public.order_status_history;

-- 4. Limpiar todas las órdenes
DELETE FROM public.orders;

-- 5. Limpiar llamadas al mozo
DELETE FROM public.waiter_calls;

-- 6. Limpiar ratings/reseñas
DELETE FROM public.ratings;

-- 7. Limpiar movimientos de caja y cancelaciones
DELETE FROM public.cancelaciones_caja;
DELETE FROM public.movimientos_caja;
DELETE FROM public.turnos_caja;

-- 8. Resetear todas las mesas a libre
UPDATE public.tables
SET is_occupied = false,
    occupied_since = NULL
WHERE restaurant_id = '00000000-0000-0000-0000-000000000001';

-- 9. (Opcional) Limpiar quejas/sugerencias
DELETE FROM public.quejas_sugerencias;

-- Verificación final
SELECT
  (SELECT COUNT(*) FROM public.orders) AS ordenes,
  (SELECT COUNT(*) FROM public.order_items) AS items,
  (SELECT COUNT(*) FROM public.tables WHERE is_occupied = true) AS mesas_ocupadas,
  (SELECT COUNT(*) FROM public.waiter_calls WHERE status = 'pending') AS llamadas_pendientes;
