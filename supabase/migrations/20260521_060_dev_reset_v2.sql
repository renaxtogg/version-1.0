-- ============================================================
-- 060 — DEV RESET v2: limpieza operativa completa
-- Incluye delivery_orders (agregado en migración 035+).
-- Resetea mesas a libre. Mantiene menú, riders, zonas, usuarios.
-- EJECUTAR SOLO EN DESARROLLO.
-- ============================================================

-- 1. delivery_orders (FK hacia orders, va primero)
DELETE FROM public.delivery_orders;

-- 2. Extras de ítems de órdenes
DELETE FROM public.order_item_extras;

-- 3. Ítems de órdenes
DELETE FROM public.order_items;

-- 4. Historial de estados
DELETE FROM public.order_status_history;

-- 5. Órdenes
DELETE FROM public.orders;

-- 6. Llamadas al mozo
DELETE FROM public.waiter_calls;

-- 7. Ratings / reseñas
DELETE FROM public.ratings;

-- 8. Caja: cancelaciones → movimientos → turnos (orden por FK)
DELETE FROM public.cancelaciones_caja;
DELETE FROM public.movimientos_caja;
DELETE FROM public.turnos_caja;

-- 9. Quejas y sugerencias
DELETE FROM public.quejas_sugerencias;

-- 10. Resetear riders a "disponible"
UPDATE public.delivery_riders
SET current_status = 'disponible'
WHERE restaurant_id = '00000000-0000-0000-0000-000000000001';

-- 11. Resetear mesas a libre
UPDATE public.tables
SET is_occupied = false,
    occupied_since = NULL
WHERE restaurant_id = '00000000-0000-0000-0000-000000000001';

-- Verificación final
SELECT
  (SELECT COUNT(*) FROM public.orders)           AS ordenes,
  (SELECT COUNT(*) FROM public.order_items)      AS items,
  (SELECT COUNT(*) FROM public.delivery_orders)  AS delivery_orders,
  (SELECT COUNT(*) FROM public.turnos_caja)      AS turnos,
  (SELECT COUNT(*) FROM public.tables WHERE is_occupied = true) AS mesas_ocupadas,
  (SELECT COUNT(*) FROM public.waiter_calls WHERE status = 'pending') AS llamadas_pendientes;
