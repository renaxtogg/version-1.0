-- ════════════════════════════════════════════════════════════════════════════
-- 205 — Rankings PÚBLICOS: restaurantes mejor calificados + exploradores
-- ────────────────────────────────────────────────────────────────────────────
-- Instrucción de Renato (2026-08-04): el ranking tiene que verse SIN cuenta, y
-- además del de comensales hace falta uno de RESTAURANTES mejor calificados —
-- general y por ciudad, histórico y del mes. Todo visible desde la portada de
-- /clientes, con la invitación a sumarse: el ranking es el anzuelo.
--
-- Por qué funciones nuevas y no abrir las que ya están: `diner_leaderboard`
-- (mig 200) está otorgada sólo a `authenticated` y devuelve `is_me` y el puesto
-- propio, que sin sesión no significan nada. Abrirla a `anon` sería exponer una
-- función pensada para alguien identificado.
--
-- ⚠ EL PROMEDIO CRUDO NO SIRVE PARA RANKEAR. Un local con UNA reseña de 5★ le
-- ganaría a uno con 200 reseñas y 4,8 — y el primer puesto se compraría con un
-- solo amigo. Se usa el promedio bayesiano (el mismo criterio de IMDb):
--
--     score = (v/(v+m))·R + (m/(v+m))·C
--
--   R = promedio del local, v = cuántas reseñas tiene,
--   C = promedio de TODA la red, m = piso de reseñas para "pesar" completo.
--
-- En castellano: un local arranca parecido al promedio de la red y se despega
-- a medida que ACUMULA reseñas. Con m = 5, cinco reseñas ya pesan la mitad.
-- El promedio crudo igual se devuelve aparte, porque es lo que la gente espera
-- ver junto a las estrellas.
--
-- Qué se expone: nombre, ciudad, rubro, logo, portada y la nota. Nada de
-- `diners` más allá del nombre para mostrar y el avatar que el propio comensal
-- eligió — nunca correo, teléfono ni hábitos.
--
-- Aplicar DESPUÉS de la 204.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Ranking de restaurantes ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.restaurant_leaderboard_public(
  p_scope  text DEFAULT 'country',   -- country | city
  p_period text DEFAULT 'all',       -- all | month
  p_city   text DEFAULT NULL,
  p_limit  int  DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_on    boolean;
  v_from  timestamptz;
  v_city  text := NULLIF(btrim(COALESCE(p_city, '')), '');
  v_c     numeric;   -- promedio de la red
  v_m     int := 5;  -- piso de reseñas
  v_rows  jsonb;
  v_total int;
BEGIN
  SELECT (COALESCE(public_browse_enabled,false)
          AND COALESCE(discovery_enabled,false)
          AND COALESCE(reviews_enabled,false))
    INTO v_on FROM public.diner_app_config WHERE id;

  IF NOT COALESCE(v_on, false) THEN
    RETURN jsonb_build_object('enabled', false, 'rows', '[]'::jsonb);
  END IF;

  -- "Del mes" = mes calendario en curso. El huso sale de Paraguay y no de UTC:
  -- con UTC, a las 21:00 del último día del mes el ranking ya cambiaría de mes
  -- en plena cena (misma trampa que la regla del día comercial en CLAUDE.md).
  v_from := CASE WHEN p_period = 'month'
                 THEN date_trunc('month', (now() AT TIME ZONE 'America/Asuncion'))
                        AT TIME ZONE 'America/Asuncion'
                 ELSE '-infinity'::timestamptz END;

  SELECT avg(rv.stars) INTO v_c
    FROM public.diner_reviews rv
   WHERE rv.status = 'approved' AND rv.created_at >= v_from;
  v_c := COALESCE(v_c, 4.0);

  WITH board AS (
    SELECT r.id, r.name, r.city, r.business_type, r.logo_url, r.logo_initials,
           r.cover_image_url, r.is_open,
           count(rv.id)::int                       AS reviews,
           round(avg(rv.stars)::numeric, 2)        AS rating
      FROM public.restaurants r
      JOIN public.diner_reviews rv
        ON rv.restaurant_id = r.id
       AND rv.status = 'approved'
       AND rv.created_at >= v_from
     WHERE COALESCE(r.is_active, true) = true
       AND COALESCE(r.status, 'active') NOT IN ('deleted', 'suspended')
       AND (p_scope <> 'city'
            OR (v_city IS NOT NULL AND lower(COALESCE(r.city,'')) = lower(v_city)))
     GROUP BY r.id
  ), scored AS (
    SELECT b.*,
           round(((b.reviews::numeric / (b.reviews + v_m)) * b.rating
                + (v_m::numeric      / (b.reviews + v_m)) * v_c)::numeric, 3) AS score
      FROM board b
  ), ranked AS (
    SELECT s.*, row_number() OVER (ORDER BY s.score DESC, s.reviews DESC, s.name) AS pos
      FROM scored s
  )
  SELECT
    (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'position', t.pos, 'restaurant_id', t.id, 'name', t.name, 'city', t.city,
        'business_type', t.business_type, 'logo_url', t.logo_url,
        'logo_initials', t.logo_initials, 'cover_image_url', t.cover_image_url,
        'is_open', t.is_open, 'rating', t.rating, 'reviews', t.reviews,
        'score', t.score) ORDER BY t.pos), '[]'::jsonb)
       FROM (SELECT * FROM ranked ORDER BY pos LIMIT GREATEST(COALESCE(p_limit,30),1)) t),
    (SELECT count(*) FROM ranked)
  INTO v_rows, v_total;

  RETURN jsonb_build_object('enabled', true, 'scope', p_scope, 'period', p_period,
                            'city', v_city, 'rows', COALESCE(v_rows, '[]'::jsonb),
                            'total', COALESCE(v_total, 0));
END;
$$;

REVOKE ALL ON FUNCTION public.restaurant_leaderboard_public(text,text,text,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.restaurant_leaderboard_public(text,text,text,int) TO anon, authenticated;


-- ── 2. Ranking de comensales, versión pública ──────────────────────────────
-- Misma tabla que `diner_leaderboard` pero sin `is_me` ni el puesto propio:
-- sin sesión no hay "yo". Del comensal sale SÓLO el nombre para mostrar que él
-- eligió, su avatar y su ciudad — nunca el correo ni sus hábitos.
CREATE OR REPLACE FUNCTION public.diner_leaderboard_public(
  p_scope  text DEFAULT 'country',
  p_period text DEFAULT 'all',
  p_city   text DEFAULT NULL,
  p_limit  int  DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_on    boolean;
  v_from  timestamptz;
  v_city  text := NULLIF(btrim(COALESCE(p_city, '')), '');
  v_rows  jsonb;
  v_total int;
BEGIN
  SELECT (COALESCE(public_browse_enabled,false) AND COALESCE(ranking_enabled,false))
    INTO v_on FROM public.diner_app_config WHERE id;

  IF NOT COALESCE(v_on, false) THEN
    RETURN jsonb_build_object('enabled', false, 'rows', '[]'::jsonb);
  END IF;

  v_from := CASE WHEN p_period = 'month'
                 THEN date_trunc('month', (now() AT TIME ZONE 'America/Asuncion'))
                        AT TIME ZONE 'America/Asuncion'
                 ELSE '-infinity'::timestamptz END;

  -- CTEs y no una tabla temporal: PostgreSQL rechaza DDL dentro de una función
  -- no-VOLATILE, y es exactamente el error que la 200 ya tuvo que corregir acá.
  WITH board AS (
    SELECT d.id AS diner_id,
           COALESCE(d.display_name, 'Comensal') AS name,
           d.avatar_url AS avatar, d.city,
           COALESCE((SELECT sum(x.points)::int FROM public.xp_ledger x
                      WHERE x.diner_id = d.id AND x.created_at >= v_from), 0) AS xp,
           COALESCE((SELECT count(*) FROM public.diner_reviews r
                      WHERE r.diner_id = d.id AND r.status = 'approved'
                        AND r.created_at >= v_from), 0)::int AS reviews
      FROM public.diners d
     WHERE d.status = 'active'
       AND (p_scope <> 'city'
            OR (v_city IS NOT NULL AND lower(COALESCE(d.city,'')) = lower(v_city)))
  ), ranked AS (
    SELECT b.*, row_number() OVER (ORDER BY b.xp DESC, b.reviews DESC, b.name) AS pos
      FROM board b
     WHERE b.xp > 0     -- un ranking lleno de cuentas en cero no es un ranking
  )
  SELECT
    (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'position', t.pos, 'diner_id', t.diner_id, 'name', t.name,
        'avatar', t.avatar, 'city', t.city, 'xp', t.xp, 'reviews', t.reviews,
        'level',      (SELECT lv.level FROM public.xp_level_of(t.xp) lv),
        'level_name', (SELECT lv.name  FROM public.xp_level_of(t.xp) lv)
        ) ORDER BY t.pos), '[]'::jsonb)
       FROM (SELECT * FROM ranked ORDER BY pos LIMIT GREATEST(COALESCE(p_limit,30),1)) t),
    (SELECT count(*) FROM ranked)
  INTO v_rows, v_total;

  RETURN jsonb_build_object('enabled', true, 'scope', p_scope, 'period', p_period,
                            'city', v_city, 'rows', COALESCE(v_rows, '[]'::jsonb),
                            'total', COALESCE(v_total, 0));
END;
$$;

REVOKE ALL ON FUNCTION public.diner_leaderboard_public(text,text,text,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.diner_leaderboard_public(text,text,text,int) TO anon, authenticated;

COMMIT;
