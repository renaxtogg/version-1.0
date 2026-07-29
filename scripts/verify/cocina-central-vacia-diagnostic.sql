-- ════════════════════════════════════════════════════════════════════
-- DIAGNÓSTICO — "la cocina no muestra pedidos que caja/mozo sí muestran"
-- SOLO LECTURA. No modifica ni borra nada. Correr en el SQL editor de
-- Supabase con el idioma del dashboard en INGLÉS (regla CLAUDE.md).
--
-- Caso que originó este script: Estampa do Sul (primer trial, 2026-07-28).
-- Dashboard/caja/mozo mostraban 3 pedidos "en cocina" y la pantalla de
-- cocina estaba vacía; el link de la estación "Bebidas" tiraba
-- 22P02 invalid input syntax for type uuid: "".
--
-- PARA OTRO LOCAL: buscar y reemplazar el UUID
--   7f5e4829-33c9-46e4-ae3a-3f4bfed0ad7b
-- por el del local a revisar (aparece 5 veces, una por consulta).
-- (No se usa \set: es un meta-comando de psql y el editor de Supabase
--  no lo soporta — tira 42601 syntax error at or near "\".)
--
-- El editor de Supabase muestra el resultado de UNA consulta por vez:
-- seleccioná el bloque que querés correr y ejecutá solo esa selección.
-- ════════════════════════════════════════════════════════════════════


-- ── 1) ¿Qué pedidos DEBERÍA ver la cocina? (mismo filtro que dbLoadTickets)
--    Si acá hay filas y la pantalla estaba vacía, el pedido se perdió en
--    alguno de los dos recortes de abajo (estaciones o política de pago).
SELECT o.order_number, o.status, o.created_at,
       o.payment_method, o.payment_review_status,
       t.number AS mesa, t.zona
  FROM orders o
  LEFT JOIN tables t ON t.id = o.table_id
 WHERE o.restaurant_id = '7f5e4829-33c9-46e4-ae3a-3f4bfed0ad7b'::uuid
   AND o.status IN ('paid','kitchen_received','cooking','ready')
 ORDER BY o.created_at;


-- ── 2) Política de preparación del local.
--    prep_policy = 'B' ⇒ los pedidos con payment_method qr/transferencia y
--    payment_review_status <> 'approved' NO se listan en cocina hasta que
--    caja valide el comprobante. Con 'A' (default) o NULL no frena nada.
SELECT name, delivery_config ->> 'prep_policy' AS prep_policy
  FROM restaurants
 WHERE id = '7f5e4829-33c9-46e4-ae3a-3f4bfed0ad7b'::uuid;


-- ── 3) Estaciones del local y su alcance real. ESTA ES LA CLAVE.
--    zonas_asignadas = {*} o vacío   ⇒ es otra PANTALLA de la misma cocina:
--                                      la cocina central sigue mostrando todo.
--    zonas_asignadas = zonas concretas ⇒ es un PUESTO APARTE (bar de terraza,
--                                      salón privado): la central no duplica
--                                      esos ítems.
--    Antes del fix, cualquier estación con categorías vaciaba la central: un
--    local con estaciones por rubro (Cocina, Bebidas, Postres…) se quedaba
--    sin ningún pedido en la pantalla general.
SELECT s.name, s.is_active,
       COALESCE(array_agg(DISTINCT mc.name) FILTER (WHERE mc.name IS NOT NULL), '{}') AS categorias,
       COALESCE(array_agg(DISTINCT z.zona)  FILTER (WHERE z.zona  IS NOT NULL), '{}') AS zonas_asignadas
  FROM kitchen_stations s
  LEFT JOIN kitchen_station_categories sc ON sc.station_id = s.id
  LEFT JOIN menu_categories mc            ON mc.id = sc.category_id
  LEFT JOIN kitchen_station_zonas z       ON z.station_id  = s.id
 WHERE s.restaurant_id = '7f5e4829-33c9-46e4-ae3a-3f4bfed0ad7b'::uuid
 GROUP BY s.id, s.name, s.is_active
 ORDER BY s.name;


-- ── 4) Ítem por ítem de los pedidos activos: categoría, zona de la mesa y qué
--    estación (si alguna, ya con la regla nueva) se lo lleva de la central.
--    lo_prepara_otro_puesto NULL en todas las filas = la central los muestra.
SELECT o.order_number, oi.item_name, mc.name AS categoria, t.zona AS zona_mesa,
       (SELECT string_agg(s2.name, ', ')
          FROM kitchen_stations s2
          JOIN kitchen_station_categories sc2 ON sc2.station_id = s2.id
          JOIN kitchen_station_zonas       z2 ON z2.station_id  = s2.id
         WHERE s2.restaurant_id = o.restaurant_id AND s2.is_active
           AND sc2.category_id = mc.id
           AND z2.zona <> '*' AND z2.zona = t.zona) AS lo_prepara_otro_puesto
  FROM orders o
  JOIN order_items oi          ON oi.order_id = o.id
  LEFT JOIN menu_items mi      ON mi.id = oi.item_id
  LEFT JOIN menu_categories mc ON mc.id = mi.category_id
  LEFT JOIN tables t           ON t.id = o.table_id
 WHERE o.restaurant_id = '7f5e4829-33c9-46e4-ae3a-3f4bfed0ad7b'::uuid
   AND o.status IN ('paid','kitchen_received','cooking','ready')
 ORDER BY o.created_at, oi.item_name;


-- ── 5) Zonas realmente usadas por las mesas del local. Una estación acotada a
--    una zona que ninguna mesa tiene nunca reclama nada (y eso está bien).
SELECT COALESCE(zona, '(sin zona)') AS zona, count(*) AS mesas
  FROM tables
 WHERE restaurant_id = '7f5e4829-33c9-46e4-ae3a-3f4bfed0ad7b'::uuid
 GROUP BY 1
 ORDER BY 1;
