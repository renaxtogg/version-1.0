-- ════════════════════════════════════════════════════════════════════════════
-- 203 — La vitrina muestra TODOS los locales, con la acción que cada uno puede
-- ────────────────────────────────────────────────────────────────────────────
-- Instrucción de Renato (2026-08-04): en /clientes se listan todos los
-- restaurantes, pero la lógica cambia según lo que cada uno ofrece.
--
--   1. El botón de pedir sale SÓLO si el local tiene delivery EN SU PLAN. Hoy
--      la vitrina lo mostraba siempre: mandaba al comensal a un panel que el
--      local no contrató, o sea a una pantalla que lo rebota. Quien manda es
--      `get_restaurant_capabilities()` (mig 091/092) — el resolver canónico. NO
--      se arma un segundo criterio acá: eso es lo que costó la mig 160 en el
--      marketplace y no se repite.
--
--   2. Las reservas se prenden o apagan POR RESTAURANTE. La tabla `reservations`
--      existe desde la mig 040 y el panel del comensal ofrecía reservar en TODOS
--      los locales, incluso los que no toman reservas. Ahora es una decisión del
--      dueño (Admin) y la vitrina la refleja.
--
-- Default `true` a propósito: hoy el panel de delivery ofrece reservar en todos
-- los locales, así que arrancar en false apagaría en silencio una función que
-- algunos ya usan. Se prende de fábrica y el que no toma reservas la apaga.
--
-- Aplicar DESPUÉS de la 202.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Interruptor de reservas por local ───────────────────────────────────
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS reservations_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.restaurants.reservations_enabled IS
  'El local toma reservas de mesa. Lo decide el dueño en Admin y la vitrina de /clientes lo refleja: en false no se muestra el botón de reservar.';

-- La mig 102 dejó a `anon` con SELECT por COLUMNA sobre `restaurants` (para que
-- no alcance la PII). Una columna nueva NO hereda ese grant: sin esto,
-- delivery-cliente.html —que lee la tabla directo como anon— no puede ver el
-- flag y seguiría ofreciendo reservar en locales que no reservan.
GRANT SELECT (reservations_enabled) ON public.restaurants TO anon, authenticated;


-- ── 2. Vitrina: sumar capacidad de delivery (del PLAN) y reservas ──────────
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
           -- Columnas de migraciones que pueden NO estar aplicadas: leerlas
           -- directo reventaría la vitrina entera con "column does not exist".
           to_jsonb(r)->>'facebook'                                    AS facebook,
           COALESCE(to_jsonb(r)->>'service_mode', 'salon')             AS service_mode,
           COALESCE((to_jsonb(r)->>'reservations_enabled')::boolean, true) AS reservations_enabled
      FROM public.restaurants r
     WHERE COALESCE(r.is_active, true) = true
       AND COALESCE(r.status, 'active') NOT IN ('deleted', 'suspended')
  ), capped AS (
    -- El corte va ANTES de resolver el plan: `get_restaurant_capabilities` es
    -- una función por fila (consulta suscripción + plan + addons), así que
    -- llamarla sobre la red entera y recién después recortar sería pagar el
    -- costo de locales que nadie va a ver.
    SELECT b.* FROM base b
     WHERE (p_search IS NULL OR btrim(p_search) = ''
            OR b.name ILIKE '%'||btrim(p_search)||'%'
            OR COALESCE(b.business_type,'') ILIKE '%'||btrim(p_search)||'%'
            OR COALESCE(b.city,'') ILIKE '%'||btrim(p_search)||'%')
       AND (p_city IS NULL OR btrim(p_city) = ''
            OR lower(COALESCE(b.city,'')) = lower(btrim(p_city)))
       AND (p_type IS NULL OR btrim(p_type) = ''
            OR lower(COALESCE(b.business_type,'')) = lower(btrim(p_type)))
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


-- ── 3. Ficha del local: lo mismo ───────────────────────────────────────────
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
           to_jsonb(r)->>'facebook'                                    AS facebook,
           COALESCE(to_jsonb(r)->>'service_mode', 'salon')             AS service_mode,
           COALESCE((to_jsonb(r)->>'reservations_enabled')::boolean, true) AS reservations_enabled,
           COALESCE(
             public.get_restaurant_capabilities(r.id)->'allowed_panels' ? 'delivery-cliente',
             false)                                                    AS has_delivery,
           (SELECT count(*) FROM public.diner_reviews rv
             WHERE rv.restaurant_id = r.id AND rv.status = 'approved')  AS review_count,
           (SELECT round(avg(rv.stars)::numeric, 2) FROM public.diner_reviews rv
             WHERE rv.restaurant_id = r.id AND rv.status = 'approved')  AS rating
      FROM public.restaurants r
     WHERE r.id = p_restaurant
       AND COALESCE(r.is_active, true) = true
       AND COALESCE(r.status, 'active') NOT IN ('deleted', 'suspended')
  ) x;

  IF v_r IS NULL THEN
    RETURN jsonb_build_object('enabled', true, 'found', false);
  END IF;

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

COMMIT;
