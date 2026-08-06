-- ════════════════════════════════════════════════════════════════════════════
-- ¿UNA TABLA NUEVA SIGUE NACIENDO OTORGADA A `anon`?
-- ════════════════════════════════════════════════════════════════════════════
-- La verificación que venía en la 210 preguntaba "¿existe ALGUNA entrada de
-- default con anon?" y devolvía `true` aunque el REVOKE hubiera funcionado:
-- en `pg_default_acl` hay DOS entradas para public/'r', una del rol `postgres`
-- y otra de `supabase_admin`, y un EXISTS no las distingue.
--
-- Cuál importa: los defaults se aplican según QUIÉN CREA la tabla. Las
-- migraciones corren desde el SQL Editor como `postgres`, así que la entrada
-- de `postgres` es la que gobierna todo lo nuestro. La de `supabase_admin` es
-- de la plataforma y probablemente no se pueda alterar desde acá (haría falta
-- ser miembro de ese rol) — pero sólo aplica a tablas que cree la plataforma,
-- no las tuyas.
--
-- En vez de razonar sobre catálogos, esto lo PRUEBA: crea una tabla, mira con
-- qué privilegios nació, y deshace todo con ROLLBACK. **No queda nada.** El
-- CREATE TABLE vive y muere dentro de la transacción.
--
-- Correr en Supabase → SQL Editor (en inglés) → RUN → pegarme la salida.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE public._zz_prueba_canilla (id int);

SELECT jsonb_pretty(jsonb_build_object(

  -- LO QUE IMPORTA: ¿la tabla recién nacida le da algo a anon?
  -- false = la canilla quedó cerrada.
  'tabla_nueva_le_da_algo_a_anon', EXISTS (
     SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema='public' AND table_name='_zz_prueba_canilla'
        AND grantee='anon'),

  'privilegios_que_heredo_anon', COALESCE((
     SELECT string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type)
       FROM information_schema.role_table_grants
      WHERE table_schema='public' AND table_name='_zz_prueba_canilla'
        AND grantee='anon'), '(ninguno)'),

  -- De paso, control: `authenticated` SÍ tiene que seguir heredando, porque su
  -- default se dejó intacto a propósito (los 11 paneles leen tablas directo).
  'authenticated_sigue_heredando', EXISTS (
     SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema='public' AND table_name='_zz_prueba_canilla'
        AND grantee='authenticated'),

  -- Las dos entradas de default, ahora separadas por quién las puso.
  'defaults_por_grantor', COALESCE((
     SELECT jsonb_agg(jsonb_build_object(
              'grantor',     pg_get_userbyid(d.defaclrole),
              'tiene_anon',  d.defaclacl::text LIKE '%anon=%')
            ORDER BY pg_get_userbyid(d.defaclrole))
       FROM pg_default_acl d
       JOIN pg_namespace n ON n.oid = d.defaclnamespace
      WHERE n.nspname='public' AND d.defaclobjtype='r'), '[]'::jsonb)

)) AS prueba_canilla;

-- Deshace el CREATE TABLE. No persiste nada.
ROLLBACK;

-- Comprobación de que no quedó basura (tiene que devolver 0 filas):
-- SELECT tablename FROM pg_tables WHERE tablename = '_zz_prueba_canilla';
