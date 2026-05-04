-- ============================================================
-- Migración 014: Fix DEFINITIVO de secuencias
-- ============================================================
-- ALTER SEQUENCE RESTART WITH garantiza que el PRÓXIMO id sea
-- exactamente ese valor, sin importar el estado anterior.
-- MAX(id)+1000 asegura que no pisa ninguna fila existente.

DO $$
DECLARE
  next_items  INTEGER;
  next_extras INTEGER;
BEGIN
  SELECT COALESCE(MAX(id), 0) + 1000 INTO next_items  FROM public.menu_items;
  SELECT COALESCE(MAX(id), 0) + 1000 INTO next_extras FROM public.menu_item_extras;

  EXECUTE format('ALTER SEQUENCE menu_items_id_seq       RESTART WITH %s', next_items);
  EXECUTE format('ALTER SEQUENCE menu_item_extras_id_seq RESTART WITH %s', next_extras);

  RAISE NOTICE 'Secuencias fijadas: menu_items próximo=%, menu_item_extras próximo=%',
    next_items, next_extras;
END $$;

-- Verificación (lee last_value sin consumirlo)
SELECT
  'menu_items'                          AS tabla,
  (SELECT MAX(id) FROM public.menu_items)  AS max_id_existente,
  last_value                            AS secuencia_ultimo_valor,
  is_called                             AS fue_usada
FROM menu_items_id_seq

UNION ALL

SELECT
  'menu_item_extras',
  (SELECT MAX(id) FROM public.menu_item_extras),
  last_value,
  is_called
FROM menu_item_extras_id_seq;
