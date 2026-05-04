-- ============================================================
-- Migración 015: bucket restaurant-images + columna logo_url
-- ============================================================

-- Agregar columna logo_url a restaurants (si no existe)
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS logo_url TEXT;

-- ── STORAGE: bucket restaurant-images ────────────────────────
-- Bucket público para portada y logo del restaurante.
-- Límite: 5 MB. Solo imágenes.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'restaurant-images',
  'restaurant-images',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = true,
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

-- ── STORAGE POLICIES ─────────────────────────────────────────
DROP POLICY IF EXISTS "restaurant_images_public_read" ON storage.objects;
CREATE POLICY "restaurant_images_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'restaurant-images');

DROP POLICY IF EXISTS "restaurant_images_auth_insert" ON storage.objects;
CREATE POLICY "restaurant_images_auth_insert"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'restaurant-images' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "restaurant_images_auth_update" ON storage.objects;
CREATE POLICY "restaurant_images_auth_update"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'restaurant-images' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "restaurant_images_auth_delete" ON storage.objects;
CREATE POLICY "restaurant_images_auth_delete"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'restaurant-images' AND auth.role() = 'authenticated');
