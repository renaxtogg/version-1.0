-- ════════════════════════════════════════════════════════════════════════════
-- 195 · HARDENING: search_path fijo en TODA función SECURITY DEFINER
--       (PREPARED — NOT APPLIED: aplicar manualmente tras backup nuevo,
--        Supabase SQL Editor en INGLÉS, rol postgres. Claude Code NO la aplica.)
-- ────────────────────────────────────────────────────────────────────────────
-- PROBLEMA
--   Una función `SECURITY DEFINER` corre con los privilegios de su DUEÑO (acá
--   `postgres`, que es superusuario). Si además tiene el `search_path` MUTABLE
--   —es decir, hereda el del que la llama— cualquier rol que pueda crear objetos
--   en un esquema que entre antes que `public` puede *shadowear* una tabla o una
--   función que el cuerpo referencia sin calificar, y lograr que su propio código
--   se ejecute como `postgres`. Es la escalada de privilegios clásica de Postgres
--   y es exactamente lo que reporta el linter de Supabase como
--   `function_search_path_mutable`.
--
--   Auditoría del repo: la mayoría de las funciones NUEVAS (mig. 145 en adelante)
--   ya declaran `SET search_path`, pero las viejas NO. Sin ir más lejos quedaron
--   mutables funciones que son núcleo de auth y de datos:
--     · public.get_my_profile()                (mig 007/019/024)
--     · public.get_user_email(text)            (mig 007/008)  ← la usa el LOGIN
--     · public.admin_create_user(...)          (mig 008)
--     · public.admin_toggle_user(uuid,bool)    (mig 007)
--     · public.fn_occupy_table_on_order()      (mig 021/026)  ← TRIGGER
--     · public.fn_auto_release_table_on_delivered() (mig 026) ← TRIGGER
--     · public._assert_superadmin()            (mig 068)
--     · public.superadmin_reset_operation_data()    (mig 068/069b)
--     · public.superadmin_seed_simulated_environment() (mig 068)
--     · public.support_message_after_insert()  (mig 073)
--     · … y el resto que el bloque de abajo detecte.
--
--   Los TRIGGERS son el vector más incómodo: corren solos ante un INSERT/UPDATE
--   normal de un mozo o del cliente anónimo, sin que nadie llame a ninguna RPC.
--
-- QUÉ HACE
--   A) Recorre pg_proc y le pone `search_path` FIJO a toda función/procedimiento
--      SECURITY DEFINER de `public` a la que hoy le falte. No enumera nombres a
--      mano: opera sobre lo que REALMENTE está en la base, así que también cubre
--      funciones creadas fuera de estas migraciones (drift de producción).
--   B) Revoca CREATE sobre el esquema `public` a `anon` y `authenticated`. Esto
--      es la otra mitad: sin poder crear objetos en `public`, el shadowing no es
--      posible ni siquiera contra una función que se nos escape. `postgres` y
--      `service_role` conservan todo (las migraciones siguen corriendo igual).
--
-- POR QUÉ `public, extensions, pg_temp`
--   · `public`     — donde viven todas las tablas y funciones del producto.
--   · `extensions` — Supabase instala ahí pgcrypto; `crypt()` y `gen_salt()` se
--                    usan sin calificar en las migs 016, 020 y 166. Sin este
--                    esquema, esas funciones se romperían al fijar el search_path.
--   · `pg_temp`    — SIEMPRE al final. Si va primero (o se omite y Postgres lo
--                    pone al principio), un atacante puede crear una tabla
--                    temporal que shadowee una real, que es justo el ataque.
--
-- SEGURIDAD / ALCANCE
--   NO cambia la lógica de ninguna función: sólo fija cómo resuelve nombres.
--   NO toca RLS, policies ni datos. Idempotente y re-ejecutable: si se agregan
--   funciones nuevas más adelante, volver a correrla las cubre.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── A) search_path fijo en toda función SECURITY DEFINER de `public` ─────────
DO $migration$
DECLARE
  r            RECORD;
  v_fixed      INT := 0;
  v_already    INT := 0;
BEGIN
  FOR r IN
    SELECT p.oid,
           p.oid::regprocedure::text AS sig,
           p.prokind,
           -- ¿ya tiene un search_path propio en proconfig?
           EXISTS (
             SELECT 1
             FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS cfg
             WHERE cfg LIKE 'search_path=%'
           ) AS has_sp
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef                 -- SOLO SECURITY DEFINER
      AND p.prokind IN ('f', 'p')     -- funciones y procedimientos (no agregados)
    ORDER BY 2
  LOOP
    IF r.has_sp THEN
      v_already := v_already + 1;
      CONTINUE;
    END IF;

    -- `pg_temp` va SIEMPRE último: si quedara primero, una tabla temporal del
    -- atacante podría shadowear una tabla real dentro de la función definer.
    IF r.prokind = 'p' THEN
      EXECUTE format('ALTER PROCEDURE %s SET search_path = public, extensions, pg_temp', r.sig);
    ELSE
      EXECUTE format('ALTER FUNCTION %s SET search_path = public, extensions, pg_temp', r.sig);
    END IF;

    v_fixed := v_fixed + 1;
    RAISE NOTICE '[195] search_path fijado en %', r.sig;
  END LOOP;

  RAISE NOTICE '[195] SECURITY DEFINER en public — corregidas: %, ya estaban bien: %',
    v_fixed, v_already;
END
$migration$;

-- ── B) Sin CREATE en `public` para los roles del cliente ────────────────────
--    Complemento real del punto A: si `anon`/`authenticated` no pueden crear
--    objetos en `public`, no hay dónde plantar el objeto que shadowee. Es además
--    el default de PostgreSQL 15+; acá se hace explícito por si el proyecto
--    arrastra los grants permisivos de una versión anterior.
--    `postgres` y `service_role` NO se tocan: las migraciones y los endpoints
--    server-side siguen funcionando igual.
REVOKE CREATE ON SCHEMA public FROM anon;
REVOKE CREATE ON SCHEMA public FROM authenticated;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- USAGE se conserva: sin él, anon/authenticated no podrían ni leer las tablas.
GRANT USAGE ON SCHEMA public TO anon, authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN (correr después; debe devolver 0 filas)
-- ────────────────────────────────────────────────────────────────────────────
-- SELECT p.oid::regprocedure AS funcion_sin_search_path
-- FROM pg_proc p
-- JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public'
--   AND p.prosecdef
--   AND p.prokind IN ('f','p')
--   AND NOT EXISTS (
--     SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) cfg
--     WHERE cfg LIKE 'search_path=%'
--   );
--
-- Y que anon/authenticated ya no puedan crear en public (debe dar false):
-- SELECT has_schema_privilege('anon','public','CREATE') AS anon_create,
--        has_schema_privilege('authenticated','public','CREATE') AS auth_create;
-- ════════════════════════════════════════════════════════════════════════════
