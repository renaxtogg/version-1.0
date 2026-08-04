-- ════════════════════════════════════════════════════════════════════════════
-- 201 — Vitrina PÚBLICA de /clientes (se ve sin iniciar sesión)
-- ────────────────────────────────────────────────────────────────────────────
-- Decisión de Renato (2026-08-04): la vitrina se navega SIN login. Descubrir
-- restaurantes, ver una experiencia y entrar a pedir es el mismo camino que
-- tiene hoy cualquiera con el QR o el link de delivery. Lo que agrega la cuenta
-- no es el permiso de pedir: es EXISTIR en el sistema — acumular XP, reseñar,
-- figurar en el ranking y, más adelante, recibir beneficios.
--
-- El problema que resuelve esta migración: `diner_discover()` (mig 200) está
-- otorgada SÓLO a `authenticated`, y `restaurants` quedó tenant-scoped para
-- `anon` en la mig 103. O sea que hoy un visitante sin cuenta no puede ver NI
-- UN restaurante — la vitrina saldría vacía. Hace falta una función propia,
-- `SECURITY DEFINER`, que devuelva únicamente lo que ya es público de un local.
--
-- QUÉ SE EXPONE Y QUÉ NO — esto es lo delicado de la migración:
--   • SÍ: nombre, ciudad, dirección, logo, portada, rubro, si está abierto,
--     coordenadas, teléfono y WhatsApp DEL LOCAL, y el promedio de reseñas.
--     Todo eso ya está en la vidriera de un restaurante y en su menú QR.
--   • NO: nada de `diners` (la tabla concentra correo y hábitos de TODOS los
--     comensales de la plataforma), nada de `customers`, ningún dato de pedidos,
--     ningún correo ni teléfono de una persona. De las reseñas sale el nombre
--     PARA MOSTRAR que el propio autor eligió y su avatar — no su correo.
--   • Se listan sólo locales activos y no suspendidos, igual que diner_discover.
--
-- El interruptor: `public_browse_enabled` arranca en FALSE. La beta cerrada
-- sigue cerrada hasta que Renato la abra desde Superadmin › Comensales. Con el
-- flag apagado estas funciones devuelven {enabled:false} y el front muestra la
-- pantalla de beta — no hay forma de ver la vitrina "por accidente".
--
-- Aplicar DESPUÉS de la 200.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Interruptor de la vitrina pública ───────────────────────────────────
ALTER TABLE public.diner_app_config
  ADD COLUMN IF NOT EXISTS public_browse_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.diner_app_config.public_browse_enabled IS
  'true = cualquiera (anon) puede ver la vitrina de /clientes sin iniciar sesión. Independiente de is_public, que gobierna quién puede CREAR perfil de comensal.';

-- Fila única de config: si no existe todavía, crearla con los defaults.
INSERT INTO public.diner_app_config (id) VALUES (true)
ON CONFLICT (id) DO NOTHING;


-- ── 2. Vitrina: listado + experiencias + ciudades ──────────────────────────
-- Una sola llamada devuelve todo lo que la portada necesita, igual que
-- `marketplace_storefront()` (mig 199): sin esto el front hace 3 consultas y
-- filtra en el navegador, que es el error que las migs 197/198/199 ya tuvieron
-- que arreglar tres veces.
CREATE OR REPLACE FUNCTION public.diner_browse_public(
  p_search text DEFAULT NULL,
  p_city   text DEFAULT NULL,
  p_type   text DEFAULT NULL,     -- business_type ("experiencia")
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

  -- Doble llave: la vitrina pública exige su propio flag Y el de descubrimiento.
  IF NOT COALESCE(v_cfg.public_browse_enabled, false)
     OR NOT COALESCE(v_cfg.discovery_enabled, false) THEN
    RETURN jsonb_build_object('enabled', false, 'rows', '[]'::jsonb,
                              'types', '[]'::jsonb, 'cities', '[]'::jsonb);
  END IF;

  WITH base AS (
    SELECT r.id, r.name, r.city, r.address, r.logo_url, r.cover_image_url,
           r.logo_initials, r.business_type, r.is_open, r.lat, r.lng,
           r.phone, r.whatsapp,
           -- `service_mode` lo agrega la mig 173, que puede no estar aplicada:
           -- vía to_jsonb una columna ausente cae al default en vez de reventar
           -- la vitrina entera con "column does not exist" (mismo truco que la 200).
           COALESCE(to_jsonb(r)->>'service_mode', 'salon') AS service_mode
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

  -- Experiencias CON CONTEO real. La portada muestra "3 lugares para esta
  -- experiencia": ese número sale de acá, no de contar filas ya recortadas por
  -- el LIMIT de arriba (que daría un número más chico cuanto más crece la red).
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

  RETURN jsonb_build_object(
    'enabled', true,
    'rows',    v_rows,
    'types',   v_types,
    'cities',  v_cities
  );
END;
$$;

REVOKE ALL ON FUNCTION public.diner_browse_public(text,text,text,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.diner_browse_public(text,text,text,int) TO anon, authenticated;


-- ── 3. Ficha pública de un local (con sus reseñas aprobadas) ───────────────
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
BEGIN
  SELECT (COALESCE(public_browse_enabled,false) AND COALESCE(discovery_enabled,false))
    INTO v_on FROM public.diner_app_config WHERE id;

  IF NOT COALESCE(v_on, false) THEN
    RETURN jsonb_build_object('enabled', false);
  END IF;

  SELECT to_jsonb(x) INTO v_r FROM (
    SELECT r.id, r.name, r.city, r.address, r.logo_url, r.cover_image_url,
           r.logo_initials, r.business_type, r.is_open, r.lat, r.lng,
           r.phone, r.whatsapp,
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

  -- Del autor sale SÓLO lo que él eligió mostrar. `diners` guarda además su
  -- correo y sus hábitos: seleccionar la fila entera acá filtraría la base de
  -- comensales de toda la plataforma a cualquiera con la anon key.
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
                            'restaurant', v_r, 'reviews', v_rev);
END;
$$;

REVOKE ALL ON FUNCTION public.diner_place_public(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.diner_place_public(uuid) TO anon, authenticated;


-- ── 4. Estado de la app para un visitante sin cuenta ───────────────────────
-- `diner_bootstrap()` (mig 200) exige sesión. El visitante anónimo también
-- necesita saber si la vitrina está abierta y con qué mensaje, sin loguearse.
CREATE OR REPLACE FUNCTION public.diner_public_config()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT jsonb_build_object(
    'public_browse', COALESCE(c.public_browse_enabled, false),
    'discovery',     COALESCE(c.discovery_enabled, false),
    'signup_open',   COALESCE(c.is_public, false),
    'reviews',       COALESCE(c.reviews_enabled, false),
    'ranking',       COALESCE(c.ranking_enabled, false),
    'closed_message',COALESCE(c.closed_message, '')
  )
  FROM public.diner_app_config c WHERE c.id;
$$;

REVOKE ALL ON FUNCTION public.diner_public_config() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.diner_public_config() TO anon, authenticated;

COMMIT;
