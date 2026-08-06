-- ════════════════════════════════════════════════════════════════════════════
-- AUDITORÍA DE RLS Y PRIVILEGIOS — SÓLO LECTURA
-- ════════════════════════════════════════════════════════════════════════════
-- No modifica NADA. No hay INSERT, UPDATE, DELETE, GRANT, ALTER ni CREATE.
-- Es un SELECT contra los catálogos del sistema. Se puede correr en producción
-- durante servicio sin ningún riesgo.
--
-- PARA QUÉ: escribir el arreglo del `USING(true)` a partir de lo que dicen las
-- migraciones es exactamente cómo se rompe un panel en producción. Las 208
-- migraciones se pisan entre sí (la 207 repone tres funciones de despacho, la
-- 195 barre `pg_proc` entero, la 104 re-escribió policies de la 017…), y lo que
-- quedó vivo es lo que dice la BASE, no lo que dice el repo. Esta consulta
-- devuelve el estado real para poder escribir el arreglo sobre hechos.
--
-- CÓMO: Supabase → SQL Editor → **cambiar el idioma del panel a inglés**
-- (el español auto-traduce keywords y rompe la consulta) → pegar → RUN →
-- copiar la única celda del resultado y mandármela.
--
-- Si la salida sale cortada por el tamaño, corré el bloque B (abajo del todo),
-- que devuelve lo mismo en filas en vez de en un JSON.
-- ════════════════════════════════════════════════════════════════════════════

-- ── BLOQUE A · todo en una celda ───────────────────────────────────────────
WITH pol AS (
  SELECT
    p.tablename,
    p.policyname,
    p.cmd,
    p.roles::text[]                                       AS roles,
    p.qual,
    p.with_check,
    -- Determina el patrón de arreglo: con `restaurant_id` va
    -- `restaurant_id IN (SELECT get_my_company_restaurant_ids())`; sin él hay
    -- que llegar por una tabla puente y eso se decide caso por caso.
    EXISTS (SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = 'public'
               AND c.table_name   = p.tablename
               AND c.column_name  = 'restaurant_id')      AS tiene_restaurant_id
  FROM pg_policies p
  WHERE p.schemaname = 'public'
),
clasificada AS (
  SELECT *,
    -- Una policy de INSERT no tiene USING: lo que la abre es el WITH CHECK.
    -- Mirar sólo `qual` daría un falso positivo en cada INSERT del esquema.
    CASE WHEN cmd = 'INSERT'
         THEN (with_check IS NULL OR btrim(with_check) IN ('true','(true)'))
         ELSE (qual       IS NULL OR btrim(qual)       IN ('true','(true)'))
    END AS sin_filtro
  FROM pol
),
abiertas AS (
  SELECT * FROM clasificada
   WHERE sin_filtro
     AND roles && ARRAY['authenticated','public']
)
SELECT jsonb_pretty(jsonb_build_object(

  'generado', now()::text,

  'resumen', jsonb_build_object(
    'tablas_public',           (SELECT count(*) FROM pg_class c
                                 JOIN pg_namespace n ON n.oid = c.relnamespace
                                WHERE n.nspname='public' AND c.relkind='r'),
    'tablas_con_rls_apagada',  (SELECT count(*) FROM pg_class c
                                 JOIN pg_namespace n ON n.oid = c.relnamespace
                                WHERE n.nspname='public' AND c.relkind='r'
                                  AND NOT c.relrowsecurity),
    'policies_total',          (SELECT count(*) FROM pg_policies WHERE schemaname='public'),
    'policies_sin_filtro',     (SELECT count(*) FROM abiertas),
    'tablas_afectadas',        (SELECT count(DISTINCT tablename) FROM abiertas)
  ),

  -- EL PLATO PRINCIPAL: las policies que dejan pasar cualquier fila a
  -- cualquier usuario autenticado. Una por línea, con lo necesario para
  -- escribir el reemplazo sin adivinar.
  'policies_sin_filtro', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'tabla',  tablename,
             'policy', policyname,
             'cmd',    cmd,
             'roles',  array_to_string(roles, ','),
             'rid',    tiene_restaurant_id)
           ORDER BY tablename, policyname)
      FROM abiertas), '[]'::jsonb),

  -- Tablas sin RLS: ahí las policies no importan, pasa todo.
  'rls_apagada', COALESCE((
    SELECT jsonb_agg(c.relname ORDER BY c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity), '[]'::jsonb),

  -- Todo lo que `anon` puede tocar a nivel de tabla. Sirve para dos cosas:
  -- confirmar que la 209 hizo efecto, y encontrar el resto del arrastre.
  'anon_grants', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('tabla', t.table_name, 'privs', t.privs)
                     ORDER BY t.table_name)
      FROM (SELECT g.table_name,
                   string_agg(DISTINCT g.privilege_type, ',' ORDER BY g.privilege_type) AS privs
              FROM information_schema.role_table_grants g
             WHERE g.table_schema='public' AND g.grantee='anon'
             GROUP BY g.table_name) t), '[]'::jsonb),

  -- LA CAUSA RAÍZ del punto anterior. Si acá aparece algo con `anon`, entonces
  -- cada tabla nueva nace con privilegios para anon y revocarlas de a una es
  -- barrer con la canilla abierta.
  'default_privileges', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'esquema', COALESCE(n.nspname,'(todos)'),
             'tipo',    d.defaclobjtype,
             'acl',     d.defaclacl::text)
           )
      FROM pg_default_acl d
      LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace), '[]'::jsonb),

  -- Los helpers de los que depende el arreglo. Si alguno no está, el patrón
  -- de reemplazo cambia.
  'helpers', COALESCE((
    SELECT jsonb_agg(p.proname ORDER BY p.proname)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public'
       AND p.proname IN ('get_my_role','get_my_restaurant_id',
                         'get_my_company_restaurant_ids','my_diner_id')), '[]'::jsonb)

)) AS auditoria_rls;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE B — sólo si el A sale cortado. Mismo dato, en filas.
-- ════════════════════════════════════════════════════════════════════════════
-- SELECT p.tablename, p.policyname, p.cmd, p.roles::text AS roles,
--        EXISTS (SELECT 1 FROM information_schema.columns c
--                 WHERE c.table_schema='public' AND c.table_name=p.tablename
--                   AND c.column_name='restaurant_id') AS tiene_restaurant_id
--   FROM pg_policies p
--  WHERE p.schemaname='public'
--    AND p.roles::text[] && ARRAY['authenticated','public']
--    AND CASE WHEN p.cmd='INSERT'
--             THEN (p.with_check IS NULL OR btrim(p.with_check) IN ('true','(true)'))
--             ELSE (p.qual       IS NULL OR btrim(p.qual)       IN ('true','(true)'))
--        END
--  ORDER BY p.tablename, p.policyname;
