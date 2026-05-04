-- ============================================================
-- Migración 013: Fix robusto — secuencia SERIAL + FK dinámico
-- Usar si la 012 no surtió efecto.
-- ============================================================

-- ── 1. Resetear secuencia de menu_items (con schema explícito) ─
SELECT setval(
  pg_get_serial_sequence('public.menu_items', 'id'),
  COALESCE((SELECT MAX(id) FROM public.menu_items), 1)
);

SELECT setval(
  pg_get_serial_sequence('public.menu_item_extras', 'id'),
  COALESCE((SELECT MAX(id) FROM public.menu_item_extras), 1)
);

-- ── 2. Eliminar TODOS los FK de order_items.item_id (por nombre dinámico) ─
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.order_items'::regclass
      AND contype = 'f'
      AND conkey @> ARRAY[(
        SELECT attnum FROM pg_attribute
        WHERE attrelid = 'public.order_items'::regclass
          AND attname = 'item_id'
      )]
  LOOP
    EXECUTE format('ALTER TABLE public.order_items DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

-- ── 3. Agregar FK con ON DELETE SET NULL ──────────────────────
ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_item_id_fkey
  FOREIGN KEY (item_id)
  REFERENCES public.menu_items(id)
  ON DELETE SET NULL;

-- ── Verificación: mostrar secuencia actual y constraint resultante ─
SELECT
  pg_get_serial_sequence('public.menu_items', 'id') AS seq_name,
  last_value AS seq_current
FROM menu_items_id_seq;

SELECT conname, confdeltype
FROM pg_constraint
WHERE conrelid = 'public.order_items'::regclass
  AND contype = 'f'
  AND conname = 'order_items_item_id_fkey';
