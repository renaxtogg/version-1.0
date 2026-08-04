-- ════════════════════════════════════════════════════════════════════════════
-- 202 — Ficha completa del local en la vitrina + menú PDF
-- ────────────────────────────────────────────────────────────────────────────
-- Decisión de Renato (2026-08-04): en la vitrina, un local que se come EN EL
-- SALÓN no puede tener botón de "pedir". Pedir en el salón exige estar sentado
-- ahí — para eso está el QR de la mesa, que es el único que sabe QUÉ mesa es.
-- Un botón de pedido a distancia mandaría comandas a la cocina de gente que no
-- está en el local. Así que:
--
--   • comer en el local → se MUESTRA la información (carta en PDF, dirección
--     con mapa, redes, horarios, teléfono). Sin botón de pedido.
--   • delivery        → al panel de delivery, que ya sabe cobrar y despachar.
--   • retiro (pickup) → al menú QR en modo retiro.
--
-- Esta migración aporta lo que faltaba para esa ficha:
--   1. `restaurants.menu_pdf_url` + `menu_pdf_name` — la carta que el dueño
--      sube desde Admin. Es la respuesta a "quiero mostrar el menú sin que se
--      pueda pedir": un PDF se lee, no se toca.
--   2. El bucket `menus` (público, sólo PDF, 10 MB) con escritura del staff del
--      local y lectura para cualquiera. Público a propósito: es una carta, el
--      mismo papel que el local deja en la puerta.
--   3. `diner_browse_public` y `diner_place_public` (mig 201) reescritas para
--      devolver también redes, web, horarios y el PDF. Sin esto la ficha de la
--      vitrina muestra el nombre y poco más.
--   4. Enciende `public_browse_enabled`: la vitrina pública es el
--      comportamiento buscado, no un extra. El portero de las CUENTAS
--      (`is_public`) sigue cerrado — mirar es público, tener perfil no.
--
-- Aplicar DESPUÉS de la 201.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. La carta en PDF ─────────────────────────────────────────────────────
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS menu_pdf_url  TEXT,
  ADD COLUMN IF NOT EXISTS menu_pdf_name TEXT;

COMMENT ON COLUMN public.restaurants.menu_pdf_url IS
  'Carta en PDF que el dueño sube desde Admin. Se muestra en la vitrina de /clientes para los locales de salón, donde NO hay botón de pedido.';


-- ── 2. Bucket de cartas ────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('menus', 'menus', true, 10485760, ARRAY['application/pdf'])
ON CONFLICT (id) DO UPDATE
  SET public             = true,
      file_size_limit    = 10485760,
      allowed_mime_types = ARRAY['application/pdf'];

-- Lectura pública: es una carta. Escritura sólo del staff, y sólo dentro de la
-- carpeta de SU restaurante — sin el chequeo de la primera carpeta, el mozo de
-- un local podría reemplazar la carta de otro.
DROP POLICY IF EXISTS menus_public_read ON storage.objects;
CREATE POLICY menus_public_read ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (bucket_id = 'menus');

DROP POLICY IF EXISTS menus_staff_write ON storage.objects;
CREATE POLICY menus_staff_write ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'menus'
    AND (storage.foldername(name))[1] = public.get_my_restaurant_id()::text
  );

DROP POLICY IF EXISTS menus_staff_update ON storage.objects;
CREATE POLICY menus_staff_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'menus'
    AND (storage.foldername(name))[1] = public.get_my_restaurant_id()::text
  );

DROP POLICY IF EXISTS menus_staff_delete ON storage.objects;
CREATE POLICY menus_staff_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'menus'
    AND (storage.foldername(name))[1] = public.get_my_restaurant_id()::text
  );


-- ── 3. Vitrina: ahora con la ficha completa ────────────────────────────────
CREATE OR REPLACE FUNCTION public.diner_browse_public(
  p_search text DEFAULT NULL,
  p_city   text DEFAULT NULL,
  p_type   text DEFAULT NULL,
  p_limit  int  DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_cfg    RECORD;
  v_rows   jsonb;
  v_types  jsonb;
  v_cities jsonb;
BEGIN
  SELECT public_browse_enabled, discovery_enabled
    INTO v_cfg
    FROM public.diner_app_config WHERE id;

  IF NOT COALESCE(v_cfg.public_browse_enabled, false)
     OR NOT COALESCE(v_cfg.discovery_enabled, false) THEN
    RETURN jsonb_build_object('enabled', false, 'rows', '[]'::jsonb,
                              'types', '[]'::jsonb, 'cities', '[]'::jsonb);
  END IF;

  WITH base AS (
    SELECT r.id, r.name, r.city, r.address, r.logo_url, r.cover_image_url,
           r.logo_initials, r.business_type, r.is_open, r.lat, r.lng,
           r.phone, r.whatsapp, r.instagram, r.website, r.opening_hours,
           r.menu_pdf_url, r.menu_pdf_name,
           -- Columnas que agregan migraciones posteriores y pueden NO estar
           -- aplicadas (`facebook` es de la 118, `service_mode` de la 173).
           -- Leerlas como r.<col> reventaría la vitrina entera con "column does
           -- not exist"; vía to_jsonb una columna ausente cae al default.
           to_jsonb(r)->>'facebook'                          AS facebook,
           COALESCE(to_jsonb(r)->>'service_mode', 'salon')   AS service_mode
      FROM public.restaurants r
     WHERE COALESCE(r.is_active, true) = true
       AND COALESCE(r.status, 'active') NOT IN ('deleted', 'suspended')
  ), scored AS (
    SELECT b.*,
           (SELECT count(*) FROM public.diner_reviews rv
             WHERE rv.restaurant_id = b.id AND rv.status = 'approved')          AS review_count,
           (SELECT round(avg(rv.stars)::numeric, 2) FROM public.diner_reviews rv
             WHERE rv.restaurant_id = b.id AND rv.status = 'approved')          AS rating
      FROM base b
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(f) ORDER BY f.rating DESC NULLS LAST, f.name), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT s.* FROM scored s
       WHERE (p_search IS NULL OR btrim(p_search) = ''
              OR s.name ILIKE '%'||btrim(p_search)||'%'
              OR COALESCE(s.business_type,'') ILIKE '%'||btrim(p_search)||'%'
              OR COALESCE(s.city,'') ILIKE '%'||btrim(p_search)||'%')
         AND (p_city IS NULL OR btrim(p_city) = ''
              OR lower(COALESCE(s.city,'')) = lower(btrim(p_city)))
         AND (p_type IS NULL OR btrim(p_type) = ''
              OR lower(COALESCE(s.business_type,'')) = lower(btrim(p_type)))
       ORDER BY s.rating DESC NULLS LAST, s.name
       LIMIT GREATEST(COALESCE(p_limit, 60), 1)
    ) f;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('type', t, 'total', n)
                            ORDER BY n DESC, t), '[]'::jsonb)
    INTO v_types
    FROM (
      SELECT NULLIF(btrim(r.business_type), '') AS t, count(*) AS n
        FROM public.restaurants r
       WHERE COALESCE(r.is_active, true) = true
         AND COALESCE(r.status, 'active') NOT IN ('deleted', 'suspended')
         AND NULLIF(btrim(r.business_type), '') IS NOT NULL
       GROUP BY 1
    ) q;

  SELECT COALESCE(jsonb_agg(DISTINCT c), '[]'::jsonb) INTO v_cities
    FROM (
      SELECT NULLIF(btrim(r.city), '') AS c
        FROM public.restaurants r
       WHERE COALESCE(r.is_active, true) = true
         AND COALESCE(r.status, 'active') NOT IN ('deleted', 'suspended')
         AND NULLIF(btrim(r.city), '') IS NOT NULL
    ) q;

  RETURN jsonb_build_object('enabled', true, 'rows', v_rows,
                            'types', v_types, 'cities', v_cities);
END;
$$;

REVOKE ALL ON FUNCTION public.diner_browse_public(text,text,text,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.diner_browse_public(text,text,text,int) TO anon, authenticated;


-- ── 4. Ficha de un local: info completa + categorías de la carta ───────────
CREATE OR REPLACE FUNCTION public.diner_place_public(p_restaurant uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_on   boolean;
  v_r    jsonb;
  v_rev  jsonb;
  v_cats jsonb;
BEGIN
  SELECT (COALESCE(public_browse_enabled,false) AND COALESCE(discovery_enabled,false))
    INTO v_on FROM public.diner_app_config WHERE id;

  IF NOT COALESCE(v_on, false) THEN
    RETURN jsonb_build_object('enabled', false);
  END IF;

  SELECT to_jsonb(x) INTO v_r FROM (
    SELECT r.id, r.name, r.city, r.address, r.logo_url, r.cover_image_url,
           r.logo_initials, r.business_type, r.is_open, r.lat, r.lng,
           r.phone, r.whatsapp, r.instagram, r.website, r.opening_hours,
           r.menu_pdf_url, r.menu_pdf_name,
           to_jsonb(r)->>'facebook'                        AS facebook,
           COALESCE(to_jsonb(r)->>'service_mode', 'salon') AS service_mode,
           (SELECT count(*) FROM public.diner_reviews rv
             WHERE rv.restaurant_id = r.id AND rv.status = 'approved')        AS review_count,
           (SELECT round(avg(rv.stars)::numeric, 2) FROM public.diner_reviews rv
             WHERE rv.restaurant_id = r.id AND rv.status = 'approved')        AS rating
      FROM public.restaurants r
     WHERE r.id = p_restaurant
       AND COALESCE(r.is_active, true) = true
       AND COALESCE(r.status, 'active') NOT IN ('deleted', 'suspended')
  ) x;

  IF v_r IS NULL THEN
    RETURN jsonb_build_object('enabled', true, 'found', false);
  END IF;

  -- Categorías de la carta con cuántos platos tiene cada una. Es "qué se come
  -- acá" sin exponer la carta entera con precios: para eso está el QR (salón),
  -- el panel de delivery o el PDF que subió el dueño.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('name', c.name, 'total', c.n)
                            ORDER BY c.pos, c.name), '[]'::jsonb)
    INTO v_cats
    FROM (
      SELECT mc.name,
             COALESCE(mc.sort_order, 999) AS pos,
             (SELECT count(*) FROM public.menu_items mi
               WHERE mi.category_id = mc.id
                 AND COALESCE(mi.is_available, true) = true) AS n
        FROM public.menu_categories mc
       WHERE mc.restaurant_id = p_restaurant
         AND COALESCE(mc.is_active, true) = true
    ) c
   WHERE c.n > 0;

  SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY q.helpful_count DESC, q.created_at DESC), '[]'::jsonb)
    INTO v_rev
    FROM (
      SELECT rv.id, rv.stars, rv.comment, rv.created_at, rv.service_type,
             COALESCE(rv.helpful_count, 0)  AS helpful_count,
             COALESCE(rv.detailed_count, 0) AS detailed_count,
             COALESCE(rv.decided_count, 0)  AS decided_count,
             rv.restaurant_reply, rv.replied_at,
             COALESCE(d.display_name, 'Comensal') AS author,
             d.avatar_url AS author_avatar,
             public.diner_credibility(rv.diner_id) AS author_credibility,
             (SELECT lv.name FROM public.xp_level_of(public.diner_total_xp(rv.diner_id)) lv) AS author_level_name,
             (SELECT COALESCE(jsonb_object_agg(s.dimension, s.stars), '{}'::jsonb)
                FROM public.diner_review_scores s WHERE s.review_id = rv.id) AS scores,
             (SELECT COALESCE(jsonb_agg(p.storage_path), '[]'::jsonb)
                FROM public.diner_review_photos p
               WHERE p.review_id = rv.id AND p.status = 'approved') AS photos
        FROM public.diner_reviews rv
        LEFT JOIN public.diners d ON d.id = rv.diner_id
       WHERE rv.restaurant_id = p_restaurant
         AND rv.status = 'approved'
       ORDER BY COALESCE(rv.helpful_count, 0) DESC, rv.created_at DESC
       LIMIT 20
    ) q;

  RETURN jsonb_build_object('enabled', true, 'found', true,
                            'restaurant', v_r, 'categories', v_cats, 'reviews', v_rev);
END;
$$;

REVOKE ALL ON FUNCTION public.diner_place_public(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.diner_place_public(uuid) TO anon, authenticated;


-- ── 5. Encender la vitrina pública ────────────────────────────────────────
-- Mirar es público; tener perfil sigue cerrado por `is_public` + la allowlist.
UPDATE public.diner_app_config SET public_browse_enabled = true WHERE id;

COMMIT;
