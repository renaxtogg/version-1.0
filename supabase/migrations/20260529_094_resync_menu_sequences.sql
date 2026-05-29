-- ============================================================
-- Migración 094: Re-sincronizar secuencias SERIAL del menú
-- ------------------------------------------------------------
-- El admin asignaba menu_items.id a mano (MAX(id)+1 visible).
-- Con RLS multi-restaurante (mig. 086) el SELECT sólo ve el
-- propio local → en un local nuevo daba nextId=1 → choque pkey
-- contra ítems de otro restaurante. Además, los inserts con id
-- explícito NO avanzaban la secuencia SERIAL, dejándola atrasada.
--
-- Ahora el frontend omite el id (deja que SERIAL lo asigne).
-- Esta migración resincroniza la secuencia con el MAX(id) real
-- para que el primer nextval() no colisione con filas existentes.
-- ============================================================

SELECT setval(
  pg_get_serial_sequence('public.menu_items', 'id'),
  GREATEST(COALESCE((SELECT MAX(id) FROM public.menu_items), 1), 1)
);

SELECT setval(
  pg_get_serial_sequence('public.menu_item_extras', 'id'),
  GREATEST(COALESCE((SELECT MAX(id) FROM public.menu_item_extras), 1), 1)
);
