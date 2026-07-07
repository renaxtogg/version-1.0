-- ════════════════════════════════════════════════════════════════════
-- 158 · Rider NACE offline (no fantasma antes del primer login) — M9
-- ════════════════════════════════════════════════════════════════════
-- Bug M9 (QA 2026-07-07): un rider recién creado quedaba DISPONIBLE sin
-- haber iniciado sesión, y el despacho/rebalanceo (mig 156) le asignaba
-- pedidos → "rider fantasma". Causa: delivery_riders.current_status tenía
-- DEFAULT 'disponible' (mig 035) y /api/create-user inserta la ficha sin
-- fijar el estado, heredando ese default en AMBOS paths de creación
-- (Personal rol=rider y Delivery → Riders, que convergen en el endpoint).
--
-- Fix aprobado por Renato: el rider NACE 'offline'. Pasa a 'disponible'
-- recién cuando él mismo entra al panel del repartidor y se activa (toggle
-- "En línea" o "Comenzar ruta"). Así el despacho nunca le manda pedidos a
-- alguien que no está trabajando.
--
-- Backend belt (no salteable por API): se cambia el DEFAULT de la columna a
-- 'offline'. Cubre el endpoint /api/create-user y cualquier INSERT directo
-- por PostgREST. (api/create-user.js además fija current_status:'offline'
-- explícito, para dejar la intención clara y que surta efecto aun antes de
-- aplicar esta migración.)
--
-- Seguro:
--   · NO afecta filas existentes — sólo el default de futuros INSERT.
--   · El CHECK de la columna ya admite 'offline' (mig 035); los RPC de
--     despacho (mig 156) excluyen 'offline' con COALESCE(current_status,…).
--   · current_status es NOT NULL; el nuevo default satisface la constraint.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.delivery_riders
  ALTER COLUMN current_status SET DEFAULT 'offline';
