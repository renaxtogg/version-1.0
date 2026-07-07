-- ════════════════════════════════════════════════════════════════════════
-- 165 · BLINDAR SUBIDAS DE IMÁGENES (server-side, no salteable)
-- ────────────────────────────────────────────────────────────────────────
-- [PARA PEGAR EN SUPABASE]  ·  rol postgres, SQL Editor en INGLÉS.
--
-- Problema (QA): las fotos (producto, portada, logo/perfil) tenían el tope de
-- "5 MB + compresión" SOLO en el cliente (src/admin/main.jsx ImageUploader) →
-- salteable subiendo directo al bucket por la API de Storage (mismo patrón que
-- el límite de ítems/mesas que estaba solo en cliente). Además, la RLS de
-- storage.objects (migs 011/015) daba ESCRITURA a CUALQUIER autenticado sobre
-- CUALQUIER carpeta → un restaurante podía escribir/pisar el path de otro.
--
-- Buckets afectados (los usa el ImageUploader con path `<restaurant_id>/archivo.webp`):
--   • menu-images       (mig 011) — foto de producto del menú
--   • restaurant-images (mig 015) — portada + logo/foto de perfil del local
-- (Los buckets supplier-images/supplier-files del marketplace ya están
--  folder-scoped por supplier_id en la mig 142 — acá NO se tocan.)
--
-- Esta migración:
--   1) RE-ASEGURA server-side en cada bucket: file_size_limit = 5 MB y
--      allowed_mime_types = image/jpeg,image/png,image/webp (idempotente y
--      AUTORITATIVO — corrige cualquier drift de config hecho desde el dashboard).
--   2) TENANT-SCOPING en storage.objects: INSERT/UPDATE/DELETE solo si la primera
--      carpeta del path == un restaurant_id de MI empresa (get_my_company_
--      restaurant_ids, mig 092) o soy superadmin. Se DROPEAN las policies viejas
--      que daban escritura amplia (si no, al ser permisivas se OR-earían y
--      anularían el scoping). `anon` NO tiene policy de escritura → no escribe.
--   3) LECTURA sigue PÚBLICA a propósito: son buckets `public` y las fotos del
--      menú/portada/logo se muestran a comensales anónimos (QR/delivery). El
--      valor de seguridad está en acotar la ESCRITURA + el tope de tamaño/mime,
--      no en esconder fotos que son públicas por diseño.
--
-- Idempotente (DROP POLICY IF EXISTS + CREATE; INSERT ... ON CONFLICT DO UPDATE).
-- No cambia el modelo de datos ni otras tablas.
--
-- Nota anti-drift: `storage.foldername(text)` y `get_my_role()` /
-- `get_my_company_restaurant_ids()` (SETOF uuid, mig 092) ya existen en prod.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1) Config server-side de los buckets (5 MB + solo imágenes) ──────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('menu-images',       'menu-images',       true, 5242880, ARRAY['image/jpeg','image/png','image/webp']),
  ('restaurant-images', 'restaurant-images', true, 5242880, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET
  public             = true,
  file_size_limit    = 5242880,
  allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp'];

-- ── 2) Fuera las policies viejas (lectura pública + escritura AMPLIA) ─────
-- menu-images (mig 011)
DROP POLICY IF EXISTS "menu_images_public_read"  ON storage.objects;
DROP POLICY IF EXISTS "menu_images_auth_insert"  ON storage.objects;
DROP POLICY IF EXISTS "menu_images_auth_update"  ON storage.objects;
DROP POLICY IF EXISTS "menu_images_auth_delete"  ON storage.objects;
-- restaurant-images (mig 015)
DROP POLICY IF EXISTS "restaurant_images_public_read"  ON storage.objects;
DROP POLICY IF EXISTS "restaurant_images_auth_insert"  ON storage.objects;
DROP POLICY IF EXISTS "restaurant_images_auth_update"  ON storage.objects;
DROP POLICY IF EXISTS "restaurant_images_auth_delete"  ON storage.objects;
-- por si alguna corrida previa ya creó las nuevas (re-idempotencia)
DROP POLICY IF EXISTS "img_buckets_public_read"    ON storage.objects;
DROP POLICY IF EXISTS "img_buckets_tenant_insert"  ON storage.objects;
DROP POLICY IF EXISTS "img_buckets_tenant_update"  ON storage.objects;
DROP POLICY IF EXISTS "img_buckets_tenant_delete"  ON storage.objects;

-- ── 3) Lectura pública (comensal anónimo ve fotos de menú/portada/logo) ──
CREATE POLICY "img_buckets_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id IN ('menu-images','restaurant-images'));

-- ── 4) Escritura acotada al tenant (carpeta = un restaurant_id propio) ───
-- INSERT: la NUEVA fila debe caer bajo la carpeta de un local de mi empresa.
CREATE POLICY "img_buckets_tenant_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id IN ('menu-images','restaurant-images')
    AND (
      public.get_my_role() = 'superadmin'
      OR (storage.foldername(name))[1] IN (
        SELECT rid::text FROM public.get_my_company_restaurant_ids() AS rid
      )
    )
  );

-- UPDATE: la fila ACTUAL (USING) y la RESULTANTE (WITH CHECK) deben ser mías
-- → no puedo mover/renombrar un objeto hacia la carpeta de otro tenant.
CREATE POLICY "img_buckets_tenant_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id IN ('menu-images','restaurant-images')
    AND (
      public.get_my_role() = 'superadmin'
      OR (storage.foldername(name))[1] IN (
        SELECT rid::text FROM public.get_my_company_restaurant_ids() AS rid
      )
    )
  )
  WITH CHECK (
    bucket_id IN ('menu-images','restaurant-images')
    AND (
      public.get_my_role() = 'superadmin'
      OR (storage.foldername(name))[1] IN (
        SELECT rid::text FROM public.get_my_company_restaurant_ids() AS rid
      )
    )
  );

-- DELETE: solo objetos bajo la carpeta de un local de mi empresa.
CREATE POLICY "img_buckets_tenant_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id IN ('menu-images','restaurant-images')
    AND (
      public.get_my_role() = 'superadmin'
      OR (storage.foldername(name))[1] IN (
        SELECT rid::text FROM public.get_my_company_restaurant_ids() AS rid
      )
    )
  );

COMMIT;

-- ── Verificación (correr aparte) ─────────────────────────────────────────
-- (a) Config server-side de los buckets:
--   SELECT id, public, file_size_limit, allowed_mime_types
--   FROM storage.buckets WHERE id IN ('menu-images','restaurant-images');
--   Esperado: public=t · file_size_limit=5242880 · {image/jpeg,image/png,image/webp}.
-- (b) TODAS las policies vivas de storage.objects (para cazar drift: no debe
--     quedar NINGUNA policy de escritura amplia sobre estos buckets fuera de las
--     img_buckets_*; ojo con qual/with_check = true o roles={anon}):
--   SELECT policyname, cmd, roles, qual, with_check FROM pg_policies
--   WHERE schemaname='storage' AND tablename='objects' ORDER BY policyname;
--   Esperado p/ menu-images/restaurant-images: solo img_buckets_public_read
--   (SELECT) + img_buckets_tenant_insert/update/delete (authenticated, con el
--   filtro de carpeta). Si aparece otra INSERT/UPDATE/DELETE permisiva sobre
--   estos bucket_id (p.ej. una policy creada a mano en el dashboard con USING
--   true) → DROPEARLA: al ser permisiva se OR-ea y anula el tenant-scoping.
-- (c) Bypass por API (lo prueba Renato con la anon/authed key, como ítems/mesas):
--   • subir > 5 MB              → 413 / "Payload too large" (file_size_limit)
--   • subir application/pdf     → 400 / "mime type ... is not supported"
--   • authed del local A subiendo a `B/<archivo>` → 403 RLS ("new row violates")
--   • anon subiendo cualquier cosa → 403 (sin policy de escritura para anon)
SELECT 'migration 165 applied — image uploads hardened server-side (size+mime+tenant RLS)' AS status;
