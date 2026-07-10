-- ============================================================
-- Migración 168: Habilitar borrado de menu_items con historial
-- ============================================================
-- Problema: al eliminar un producto que ya fue pedido, el DELETE
-- rebota porque order_items.item_id apunta a menu_items(id) con
-- ON DELETE RESTRICT. Las migraciones 012/013 debían dejarlo en
-- SET NULL, pero en producción la FK sigue en RESTRICT (eran
-- parches "por si acaso" y no quedaron aplicadas en esta base).
--
-- Diseño (ARCHITECTURE.md §"snapshot en order_items"): borrar un
-- plato NO debe romper el historial. order_items.item_name es un
-- snapshot del nombre al momento del pedido, así que con SET NULL
-- el pedido histórico sigue legible aunque el plato ya no exista.
--
-- Idempotente y robusta: elimina CUALQUIER FK sobre
-- order_items.item_id (sin importar su nombre) y la recrea como
-- ON DELETE SET NULL. Segura de correr aunque 012/013 sí se hayan
-- aplicado.
-- ============================================================

BEGIN;

-- ── 1. Eliminar TODOS los FK de order_items.item_id (por nombre dinámico) ─
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.order_items'::regclass
      AND contype  = 'f'
      AND conkey @> ARRAY[(
        SELECT attnum FROM pg_attribute
        WHERE attrelid = 'public.order_items'::regclass
          AND attname  = 'item_id'
      )]
  LOOP
    EXECUTE format('ALTER TABLE public.order_items DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

-- ── 2. Recrear la FK con ON DELETE SET NULL ──────────────────
--     (item_id ya es NULLABLE en el esquema — requisito de SET NULL.)
ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_item_id_fkey
  FOREIGN KEY (item_id)
  REFERENCES public.menu_items(id)
  ON DELETE SET NULL;

COMMIT;

-- ── Verificación: confdeltype debe ser 'n' (SET NULL) ────────
SELECT conname, confdeltype
FROM pg_constraint
WHERE conrelid = 'public.order_items'::regclass
  AND contype  = 'f'
  AND conname  = 'order_items_item_id_fkey';

-- Recargar el cache de esquema de PostgREST.
NOTIFY pgrst, 'reload schema';

SELECT 'migration 168 applied — order_items.item_id FK ahora ON DELETE SET NULL' AS status;
