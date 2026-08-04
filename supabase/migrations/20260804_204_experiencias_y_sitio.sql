-- ════════════════════════════════════════════════════════════════════════════
-- 204 — Experiencias editables + textos e imágenes de la vitrina
-- ────────────────────────────────────────────────────────────────────────────
-- Instrucción de Renato (2026-08-04): quiere CREAR las categorías de la vitrina
-- ("Pizzas", y qué locales se sugieren ahí), editar los textos del sitio y
-- poner imágenes de fondo detrás de los títulos. Nada de eso se podía: las
-- experiencias salían del `business_type` que cada dueño escribe libre en el
-- onboarding, y el copy vivía hardcodeado en el front (EXP_COPY).
--
-- Por qué una tabla y no seguir con business_type: son dos cosas distintas.
--   • `business_type` es lo que el DUEÑO declara de su negocio. Texto libre:
--     "Pizzeria", "pizzería", "Pizza & Pasta" son tres grupos distintos.
--   • Una EXPERIENCIA es una decisión editorial de Renato: cómo se le presenta
--     la red al comensal. Una experiencia puede juntar varios business_type
--     (`match_types`) y además sumar locales elegidos a mano
--     (`diner_experience_places`) que no encajan en ningún rubro.
--
-- Compatible hacia atrás: si no hay ninguna experiencia activa, la vitrina
-- sigue agrupando por business_type como hasta ahora. Se puede aplicar sin
-- cargar nada y no cambia lo que se ve.
--
-- Aplicar DESPUÉS de la 203.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Catálogo de experiencias ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.diner_experiences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL,
  label       TEXT NOT NULL,
  subtitle    TEXT,
  image_url   TEXT,
  -- business_type que esta experiencia agrupa. Vacío = sólo los locales
  -- elegidos a mano. La comparación es case-insensitive y sin espacios.
  match_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_diner_experiences_slug
  ON public.diner_experiences (lower(btrim(slug)));

COMMENT ON TABLE public.diner_experiences IS
  'Categorías editoriales de la vitrina de /clientes. Las administra Renato desde Superadmin › Comensales › Experiencias. Sin filas activas, la vitrina agrupa por business_type como antes.';

-- Locales sugeridos a mano. Es lo que pidió Renato con "dónde están sugeridos
-- los restaurantes de pizzas": un local entra a la experiencia por su rubro
-- (match_types) O porque se lo puso acá, sin depender de cómo escribió su rubro.
CREATE TABLE IF NOT EXISTS public.diner_experience_places (
  experience_id UUID NOT NULL REFERENCES public.diner_experiences(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id)       ON DELETE CASCADE,
  sort_order    INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (experience_id, restaurant_id)
);


-- ── 2. Textos e imágenes del sitio ─────────────────────────────────────────
-- Van como JSONB en la config que ya existe, no como columnas: son copy. Cada
-- texto nuevo que quiera Renato exigiría una migración si fuera una columna, y
-- ese fue exactamente el motivo por el que EXP_COPY y FORM_SPECS viven en el
-- front. Con un jsonb, agregar una frase es escribir en un formulario.
ALTER TABLE public.diner_app_config
  ADD COLUMN IF NOT EXISTS site_texts     JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS hero_image_url TEXT;

COMMENT ON COLUMN public.diner_app_config.site_texts IS
  'Copy de la vitrina de /clientes (hero, secciones, FAQ). Editable en Superadmin › Comensales › Sitio. Las claves vacías caen al texto por defecto del front.';


-- ── 3. RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE public.diner_experiences       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diner_experience_places ENABLE ROW LEVEL SECURITY;

-- Lectura: la vitrina es pública. No hay nada sensible acá — es el equivalente
-- al cartel de la puerta.
DROP POLICY IF EXISTS dexp_read ON public.diner_experiences;
CREATE POLICY dexp_read ON public.diner_experiences
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS dexpp_read ON public.diner_experience_places;
CREATE POLICY dexpp_read ON public.diner_experience_places
  FOR SELECT TO anon, authenticated USING (true);

-- Escritura: SÓLO superadmin. Una experiencia mal cargada reordena la portada
-- de toda la red, no la de un local.
DROP POLICY IF EXISTS dexp_write ON public.diner_experiences;
CREATE POLICY dexp_write ON public.diner_experiences
  FOR ALL TO authenticated
  USING (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

DROP POLICY IF EXISTS dexpp_write ON public.diner_experience_places;
CREATE POLICY dexpp_write ON public.diner_experience_places
  FOR ALL TO authenticated
  USING (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

GRANT SELECT ON public.diner_experiences, public.diner_experience_places TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.diner_experiences, public.diner_experience_places TO authenticated;


-- ── 4. Bucket de imágenes de la vitrina ────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('vitrina', 'vitrina', true, 5242880,
        ARRAY['image/jpeg','image/png','image/webp','image/avif'])
ON CONFLICT (id) DO UPDATE
  SET public             = true,
      file_size_limit    = 5242880,
      allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/avif'];

DROP POLICY IF EXISTS vitrina_public_read ON storage.objects;
CREATE POLICY vitrina_public_read ON storage.objects
  FOR SELECT TO anon, authenticated USING (bucket_id = 'vitrina');

DROP POLICY IF EXISTS vitrina_superadmin_write ON storage.objects;
CREATE POLICY vitrina_superadmin_write ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'vitrina' AND public.get_my_role() = 'superadmin');

DROP POLICY IF EXISTS vitrina_superadmin_update ON storage.objects;
CREATE POLICY vitrina_superadmin_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'vitrina' AND public.get_my_role() = 'superadmin');

DROP POLICY IF EXISTS vitrina_superadmin_delete ON storage.objects;
CREATE POLICY vitrina_superadmin_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'vitrina' AND public.get_my_role() = 'superadmin');


-- ── 5. La vitrina consume el catálogo ──────────────────────────────────────
-- `p_type` pasa a aceptar el SLUG de una experiencia. Se sigue aceptando un
-- business_type crudo para no romper links viejos ni el fallback.
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
  v_exps   jsonb;
  v_cities jsonb;
  v_exp    RECORD;
  v_has    boolean;
BEGIN
  SELECT public_browse_enabled, discovery_enabled, site_texts, hero_image_url
    INTO v_cfg
    FROM public.diner_app_config WHERE id;

  IF NOT COALESCE(v_cfg.public_browse_enabled, false)
     OR NOT COALESCE(v_cfg.discovery_enabled, false) THEN
    RETURN jsonb_build_object('enabled', false, 'rows', '[]'::jsonb,
                              'experiences', '[]'::jsonb, 'cities', '[]'::jsonb);
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.diner_experiences WHERE is_active) INTO v_has;

  -- Experiencia pedida (si p_type es un slug del catálogo).
  SELECT e.* INTO v_exp
    FROM public.diner_experiences e
   WHERE e.is_active
     AND lower(btrim(e.slug)) = lower(btrim(COALESCE(p_type, '')))
   LIMIT 1;

  WITH base AS (
    SELECT r.id, r.name, r.city, r.address, r.logo_url, r.cover_image_url,
           r.logo_initials, r.business_type, r.is_open, r.lat, r.lng,
           r.phone, r.whatsapp, r.instagram, r.website, r.opening_hours,
           r.menu_pdf_url, r.menu_pdf_name,
           to_jsonb(r)->>'facebook'                                    AS facebook,
           COALESCE(to_jsonb(r)->>'service_mode', 'salon')             AS service_mode,
           COALESCE((to_jsonb(r)->>'reservations_enabled')::boolean, true) AS reservations_enabled
      FROM public.restaurants r
     WHERE COALESCE(r.is_active, true) = true
       AND COALESCE(r.status, 'active') NOT IN ('deleted', 'suspended')
  ), capped AS (
    SELECT b.* FROM base b
     WHERE (p_search IS NULL OR btrim(p_search) = ''
            OR b.name ILIKE '%'||btrim(p_search)||'%'
            OR COALESCE(b.business_type,'') ILIKE '%'||btrim(p_search)||'%'
            OR COALESCE(b.city,'') ILIKE '%'||btrim(p_search)||'%')
       AND (p_city IS NULL OR btrim(p_city) = ''
            OR lower(COALESCE(b.city,'')) = lower(btrim(p_city)))
       AND (
         p_type IS NULL OR btrim(p_type) = ''
         -- Por experiencia: entra por rubro O porque se lo eligió a mano.
         OR (v_exp.id IS NOT NULL AND (
              EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_exp.match_types) mt(v)
                       WHERE lower(btrim(mt.v)) = lower(btrim(COALESCE(b.business_type,''))))
              OR EXISTS (SELECT 1 FROM public.diner_experience_places p
                          WHERE p.experience_id = v_exp.id AND p.restaurant_id = b.id)))
         -- Compatibilidad: p_type crudo = business_type.
         OR (v_exp.id IS NULL AND lower(COALESCE(b.business_type,'')) = lower(btrim(p_type)))
       )
     ORDER BY b.name
     LIMIT GREATEST(COALESCE(p_limit, 60), 1)
  ), scored AS (
    SELECT c.*,
           (SELECT count(*) FROM public.diner_reviews rv
             WHERE rv.restaurant_id = c.id AND rv.status = 'approved')          AS review_count,
           (SELECT round(avg(rv.stars)::numeric, 2) FROM public.diner_reviews rv
             WHERE rv.restaurant_id = c.id AND rv.status = 'approved')          AS rating,
           COALESCE(
             public.get_restaurant_capabilities(c.id)->'allowed_panels' ? 'delivery-cliente',
             false)                                                             AS has_delivery
      FROM capped c
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.rating DESC NULLS LAST, s.name), '[]'::jsonb)
    INTO v_rows
    FROM scored s;

  -- Experiencias: del catálogo si hay alguna activa; si no, el agrupado por
  -- business_type de siempre, para que aplicar esta migración sin cargar nada
  -- no cambie lo que se ve.
  IF v_has THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'type', e.slug, 'label', e.label, 'sub', e.subtitle,
             'image', e.image_url, 'total', e.n) ORDER BY e.sort_order, e.label), '[]'::jsonb)
      INTO v_exps
      FROM (
        SELECT x.slug, x.label, x.subtitle, x.image_url, x.sort_order,
               (SELECT count(*) FROM public.restaurants r
                 WHERE COALESCE(r.is_active, true) = true
                   AND COALESCE(r.status,'active') NOT IN ('deleted','suspended')
                   AND (EXISTS (SELECT 1 FROM jsonb_array_elements_text(x.match_types) mt(v)
                                 WHERE lower(btrim(mt.v)) = lower(btrim(COALESCE(r.business_type,''))))
                        OR EXISTS (SELECT 1 FROM public.diner_experience_places p
                                    WHERE p.experience_id = x.id AND p.restaurant_id = r.id))) AS n
          FROM public.diner_experiences x
         WHERE x.is_active
      ) e;
  ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object('type', t, 'label', t, 'total', n)
                              ORDER BY n DESC, t), '[]'::jsonb)
      INTO v_exps
      FROM (
        SELECT NULLIF(btrim(r.business_type), '') AS t, count(*) AS n
          FROM public.restaurants r
         WHERE COALESCE(r.is_active, true) = true
           AND COALESCE(r.status, 'active') NOT IN ('deleted', 'suspended')
           AND NULLIF(btrim(r.business_type), '') IS NOT NULL
         GROUP BY 1
      ) q;
  END IF;

  SELECT COALESCE(jsonb_agg(DISTINCT c), '[]'::jsonb) INTO v_cities
    FROM (
      SELECT NULLIF(btrim(r.city), '') AS c
        FROM public.restaurants r
       WHERE COALESCE(r.is_active, true) = true
         AND COALESCE(r.status, 'active') NOT IN ('deleted', 'suspended')
         AND NULLIF(btrim(r.city), '') IS NOT NULL
    ) q;

  RETURN jsonb_build_object(
    'enabled',     true,
    'rows',        v_rows,
    -- `types` se mantiene con el mismo nombre que devolvía la 203 para que un
    -- front sin actualizar siga andando mientras Vercel recompila.
    'types',       v_exps,
    'experiences', v_exps,
    'cities',      v_cities,
    'site',        COALESCE(v_cfg.site_texts, '{}'::jsonb)
                     || jsonb_build_object('hero_image', v_cfg.hero_image_url)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.diner_browse_public(text,text,text,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.diner_browse_public(text,text,text,int) TO anon, authenticated;

COMMIT;
