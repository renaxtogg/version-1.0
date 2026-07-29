-- ════════════════════════════════════════════════════════════════════
-- DIAGNÓSTICO — "la cocina no muestra pedidos que caja/mozo sí muestran"
--
-- SOLO LECTURA: no modifica ni borra nada. NO es una migración.
-- Copiar y pegar ENTERO en el SQL editor de Supabase y ejecutar.
-- (Dashboard en INGLÉS antes de correr SQL — regla CLAUDE.md.)
--
-- PARA OTRO LOCAL: cambiar el UUID de la primera línea. Es el único lugar.
--
-- Caso que originó el script: Estampa do Sul (primer trial, 2026-07-28).
-- Dashboard/caja/mozo mostraban 3 pedidos "en cocina", la pantalla de cocina
-- estaba vacía, y el link de la estación "Bebidas" tiraba
-- 22P02 invalid input syntax for type uuid: "". Fix en el commit 8fc7b70.
--
-- QUÉ MIRAR: las filas "3 · ESTACIÓN". La última columna dice, estación por
-- estación, si vaciaba la cocina central o no.
--
-- Nota: no se usa `\set` — es un meta-comando de psql y el editor de Supabase
-- lo rechaza con 42601 syntax error at or near "\".
-- ════════════════════════════════════════════════════════════════════

WITH r AS (SELECT '7f5e4829-33c9-46e4-ae3a-3f4bfed0ad7b'::uuid AS rid)
SELECT q.bloque, q.dato_1, q.dato_2, q.dato_3, q.dato_4, q.dato_5 FROM (

-- Lo que la cocina DEBERÍA listar (mismo filtro de estado que dbLoadTickets).
-- Si acá hay filas y la pantalla estaba vacía, el pedido se perdió en uno de
-- los dos recortes: estaciones (bloque 3) o política de pago (bloque 2).
SELECT 1 AS n, '1 · PEDIDO ACTIVO' AS bloque,
       o.order_number                             AS dato_1,
       o.status                                   AS dato_2,
       COALESCE(o.payment_method, '(sin método)') AS dato_3,
       COALESCE(o.payment_review_status, '—')     AS dato_4,
       'mesa ' || COALESCE(t.number::text,'—') || ' · zona ' || COALESCE(t.zona,'(sin zona)') AS dato_5
  FROM r
  JOIN orders o      ON o.restaurant_id = r.rid
  LEFT JOIN tables t ON t.id = o.table_id
 WHERE o.status IN ('paid','kitchen_received','cooking','ready')

UNION ALL

-- prep_policy = 'B' ⇒ los pedidos con payment_method qr/transferencia y
-- payment_review_status <> 'approved' NO se listan en cocina hasta que caja
-- valide el comprobante. Con 'A' (default) o NULL no frena nada.
-- Se lee con to_jsonb(rest) para no romper si el local no tiene delivery_config.
SELECT 2, '2 · POLÍTICA DE PAGO',
       rest.name,
       COALESCE(to_jsonb(rest) -> 'delivery_config' ->> 'prep_policy', 'A (default)'),
       'B = la cocina espera que caja valide el comprobante', '', ''
  FROM r JOIN restaurants rest ON rest.id = r.rid

UNION ALL

-- Estaciones y su alcance real. ESTE ES EL BLOQUE CLAVE.
-- Regla vigente: la cocina central solo cede ítems a estaciones ACOTADAS A
-- ZONAS (un puesto físico aparte: bar de terraza, cocina del salón privado).
-- Una estación con '*' o sin zonas es otra pantalla de la MISMA cocina, así
-- que la central la sigue mostrando. Antes del fix cualquier estación con
-- categorías reclamaba, y un local con estaciones por rubro (Cocina, Bebidas,
-- Postres…) se quedaba sin ningún pedido en la pantalla general.
SELECT 3, '3 · ESTACIÓN',
       s.name,
       CASE WHEN s.is_active THEN 'activa' ELSE 'INACTIVA' END,
       COALESCE((SELECT string_agg(mc.name, ', ' ORDER BY mc.name)
                   FROM kitchen_station_categories sc
                   JOIN menu_categories mc ON mc.id = sc.category_id
                  WHERE sc.station_id = s.id), '(sin categorías)'),
       COALESCE((SELECT string_agg(z.zona, ', ' ORDER BY z.zona)
                   FROM kitchen_station_zonas z
                  WHERE z.station_id = s.id), '(sin zonas)'),
       CASE
         WHEN NOT s.is_active THEN 'inactiva → no afecta a la cocina central'
         WHEN NOT EXISTS (SELECT 1 FROM kitchen_station_categories sc WHERE sc.station_id = s.id)
              THEN 'sin categorías → no reclama nada'
         WHEN NOT EXISTS (SELECT 1 FROM kitchen_station_zonas z WHERE z.station_id = s.id)
           OR EXISTS (SELECT 1 FROM kitchen_station_zonas z WHERE z.station_id = s.id AND z.zona = '*')
              THEN '*** TODAS LAS ZONAS → ESTA vaciaba la cocina central. Con el fix la central vuelve a mostrar sus ítems ***'
         ELSE 'acotada a zona → la central le cede estos ítems (correcto)'
       END
  FROM r JOIN kitchen_stations s ON s.restaurant_id = r.rid

UNION ALL

-- Zonas realmente usadas por las mesas. Una estación acotada a una zona que
-- ninguna mesa tiene nunca reclama nada — y eso está bien.
SELECT 4, '4 · ZONAS DE LAS MESAS',
       COALESCE(t.zona, '(sin zona)'),
       count(*)::text || ' mesas', '', '', ''
  FROM r JOIN tables t ON t.restaurant_id = r.rid
 GROUP BY t.zona

) q
ORDER BY q.n, q.dato_1;
