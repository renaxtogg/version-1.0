-- ============================================================
-- Migración 011: Realtime para menú + bucket de imágenes
-- ============================================================

-- Habilitar Realtime en tablas de menú (condicional — no falla si ya estaban)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'menu_items'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE menu_items;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'menu_categories'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE menu_categories;
  END IF;
END $$;

-- ── STORAGE: bucket menu-images ──────────────────────────────
-- Bucket público para fotos de productos del menú.
-- Límite: 5 MB por archivo. Solo imágenes (jpg/png/webp).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'menu-images',
  'menu-images',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = true,
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

-- ── STORAGE POLICIES ─────────────────────────────────────────
-- Lectura pública (cualquier visitante puede ver las fotos)
DROP POLICY IF EXISTS "menu_images_public_read" ON storage.objects;
CREATE POLICY "menu_images_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'menu-images');

-- Solo usuarios autenticados pueden subir imágenes
DROP POLICY IF EXISTS "menu_images_auth_insert" ON storage.objects;
CREATE POLICY "menu_images_auth_insert"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'menu-images' AND auth.role() = 'authenticated');

-- Solo usuarios autenticados pueden actualizar
DROP POLICY IF EXISTS "menu_images_auth_update" ON storage.objects;
CREATE POLICY "menu_images_auth_update"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'menu-images' AND auth.role() = 'authenticated');

-- Solo usuarios autenticados pueden eliminar
DROP POLICY IF EXISTS "menu_images_auth_delete" ON storage.objects;
CREATE POLICY "menu_images_auth_delete"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'menu-images' AND auth.role() = 'authenticated');
