-- ════════════════════════════════════════════════════════════════════════════
-- 206 — Arregla el ranking público de exploradores (bug de la 205)
-- ────────────────────────────────────────────────────────────────────────────
-- Síntoma: "Exploradores" salía SIEMPRE vacío, incluso con cuentas que tienen
-- XP y aparecen bien en su propio perfil.
--
-- Dos errores, los dos en `diner_leaderboard_public` de la mig 205:
--
--   1. Sumaba `x.points`. La columna de `xp_ledger` se llama **`xp`** (mig 200).
--      PL/pgSQL no valida los nombres al crear la función, así que la 205 se
--      aplicó sin quejarse y recién falló al ejecutarse: "column x.points does
--      not exist". Peor todavía, el front trata ese mensaje como "la migración
--      no está aplicada" y degrada en silencio a una tabla vacía — por eso se
--      veía el cartel de "todavía no hay reseñas" en vez de un error.
--
--   2. Contaba sólo `x.diner_id`. El XP de una persona puede estar atado a su
--      ficha de cliente de un local (`customer_id`) y llegarle por el vínculo
--      de `diner_customer_links` — así es como vincular absorbe el historial
--      viejo. `diner_total_xp` y `diner_leaderboard` (mig 200) ya lo cuentan
--      con ese OR; el ranking público no, y por eso mostraba MENOS XP que el
--      perfil de la misma persona. Dos números distintos para el mismo dato es
--      justo el drift que hay que evitar.
--
-- Se corrigen los dos. El de restaurantes de la 205 no se toca: sus columnas
-- (rv.stars / rv.status / rv.created_at) sí existen.
--
-- Aplicar DESPUÉS de la 205.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

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

  WITH board AS (
    SELECT d.id AS diner_id,
           COALESCE(d.display_name, 'Comensal') AS name,
           d.avatar_url AS avatar, d.city,
           -- MISMA definición de XP que `diner_total_xp` y `diner_leaderboard`:
           -- lo propio MÁS lo que quedó atado a las fichas de cliente que esta
           -- persona vinculó. Sin el OR, el ranking mostraría menos XP que el
           -- perfil de la misma persona.
           COALESCE((SELECT sum(x.xp) FROM public.xp_ledger x
                      WHERE (x.diner_id = d.id
                             OR x.customer_id IN (SELECT l.customer_id
                                                    FROM public.diner_customer_links l
                                                   WHERE l.diner_id = d.id))
                        AND x.created_at >= v_from), 0)::int AS xp,
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
