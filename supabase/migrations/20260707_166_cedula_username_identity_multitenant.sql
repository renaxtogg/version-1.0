-- ════════════════════════════════════════════════════════════════════
-- 166 · Identidad por CÉDULA / USERNAME única POR USUARIO AUTH (multi-sucursal)
-- ────────────────────────────────────────────────────────────────────
-- REGLA DE NEGOCIO (Renato):
--   (1) Dos usuarios auth DISTINTOS no pueden compartir cédula
--       (una cédula = una persona = un user_id), PERO una misma cédula/usuario
--       SÍ puede tener rol en uno o más restaurantes.
--   (2) El username/nick no puede duplicarse entre usuarios DISTINTOS
--       (mismo criterio: username → un solo user_id).
--
-- PROBLEMA QUE CIERRA:
--   Las uniqueness previas eran GLOBALES sobre la fila de roles (una fila por
--   restaurante), así que impedían por completo el multi-sucursal:
--     · user_roles UNIQUE(user_id, role)                (mig 006)  → misma persona
--       no podía tener el mismo rol en 2 locales.
--     · user_roles_username_idx UNIQUE(username)        (mig 007)  → el username se
--       repite por fila → 2º local rebota.
--     · user_roles_cedula_unique UNIQUE(cedula)         (mig 123)  → idem cédula.
--     · uniq_delivery_riders_user UNIQUE(user_id)       (mig 101)  → un rider no podía
--       tener ficha en 2 locales.
--   Se reemplazan por la semántica correcta: la clave de FILA pasa a incluir el
--   restaurante, y la unicidad de IDENTIDAD (cédula/username → un user_id) se
--   enforcea con EXCLUDE (índice, no salteable por API, race-safe como un UNIQUE).
--
-- POR QUÉ EXCLUDE Y NO UNIQUE:
--   "cédula → un solo user_id" es una dependencia funcional sobre una columna que
--   SE REPITE (una fila por local). Un UNIQUE(cedula) prohíbe la repetición (rompe
--   multi-sucursal); un UNIQUE no puede expresar "misma cédula OK si es el mismo
--   user_id". El patrón oficial de btree_gist lo resuelve:
--     EXCLUDE USING gist (cedula WITH =, user_id WITH <>)
--   = "no puede haber dos filas con la MISMA cédula y DISTINTO user_id".
--   (Ej. textual de la doc de btree_gist: EXCLUDE (cage WITH =, animal WITH <>).)
--
-- 100% ADITIVA/IDEMPOTENTE. No relaja RLS. No toca cuentas/datos existentes
-- (sólo reemplaza índices/constraints de unicidad).
--
-- ⚠ PREPARED — aplicar manualmente en el SQL Editor (dashboard en INGLÉS) tras
--   backup. Claude Code NO aplica migraciones. Correr ANTES el bloque §0
--   (detección de conflictos) — si aborta, hay datos a reconciliar primero.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 0. PRE-FLIGHT: abortar con mensaje claro si los datos YA violan las reglas ──
-- (Si esto lanza EXCEPTION, NO sigas: primero reconciliá los duplicados listados.)
DO $$
DECLARE
  v_bad TEXT;
BEGIN
  -- 0a. Cédula asignada a más de un user_id (dos personas con la misma cédula).
  SELECT string_agg(cedula || ' → ' || n_users || ' user_id', ', ')
    INTO v_bad
    FROM (
      SELECT cedula, COUNT(DISTINCT user_id) AS n_users
        FROM public.user_roles
       WHERE cedula IS NOT NULL
       GROUP BY cedula
      HAVING COUNT(DISTINCT user_id) > 1
    ) q;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Cédulas asignadas a más de un usuario (reconciliar antes): %', v_bad;
  END IF;

  -- 0b. Username (case-insensitive) asignado a más de un user_id.
  SELECT string_agg(u || ' → ' || n_users || ' user_id', ', ')
    INTO v_bad
    FROM (
      SELECT lower(username) AS u, COUNT(DISTINCT user_id) AS n_users
        FROM public.user_roles
       WHERE username IS NOT NULL
       GROUP BY lower(username)
      HAVING COUNT(DISTINCT user_id) > 1
    ) q;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Usernames asignados a más de un usuario (reconciliar antes): %', v_bad;
  END IF;

  -- 0c. delivery_riders: misma cédula en distinto user_id.
  SELECT string_agg(cedula || ' → ' || n_users || ' user_id', ', ')
    INTO v_bad
    FROM (
      SELECT cedula, COUNT(DISTINCT user_id) AS n_users
        FROM public.delivery_riders
       WHERE cedula IS NOT NULL AND user_id IS NOT NULL
       GROUP BY cedula
      HAVING COUNT(DISTINCT user_id) > 1
    ) q;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'delivery_riders: cédulas en más de un usuario (reconciliar antes): %', v_bad;
  END IF;
END $$;

-- ─── 1. Extensión para EXCLUDE sobre tipos escalares (=/<>) ──────────────────────
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ─── 2. Quitar las uniqueness GLOBALES (demasiado estrictas para multi-sucursal) ─
-- Por drift de prod, los nombres autogenerados podrían haber cambiado (p.ej.
-- user_roles_user_id_role_key). Si un DROP ... IF EXISTS por nombre fuera un no-op
-- silencioso, la unique global SOBREVIVE y el multi-sucursal (caso A) seguiría
-- bloqueado SIN error al aplicar. Por eso se dropea por INTROSPECCIÓN de columnas.
-- Notas de matching (para no tocar los objetos NUEVOS de esta migración):
--   · Los EXCLUDE de §4 son sobre (cedula,user_id) y (lower(username),user_id) →
--     2 columnas / expresión → NUNCA matchean {cedula}, {username} ni {user_id,role}.
--   · Los índices parciales de §3 se crean DESPUÉS de este bloque; en un re-run,
--     el de {user_id,role} es PARCIAL → se excluye del drop/verify de {user_id,role}
--     con indpred IS NULL. Los de §3/§4 tampoco son índices simples sobre {username}
--     o {cedula}, así que incluir parciales para ESAS dos columnas es seguro.
DO $$
DECLARE
  r RECORD;
BEGIN
  -- 2a. Constraints UNIQUE sobre EXACTAMENTE {user_id,role}, {username} o {cedula}
  --     (cubre el auto-nombrado user_roles_user_id_role_key aunque esté renombrado).
  FOR r IN
    SELECT con.conname,
           (SELECT array_agg(att.attname::text ORDER BY att.attname)
              FROM unnest(con.conkey) AS k(attnum)
              JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
           ) AS cols
      FROM pg_constraint con
     WHERE con.conrelid = 'public.user_roles'::regclass
       AND con.contype = 'u'
  LOOP
    IF r.cols IN (ARRAY['role','user_id'], ARRAY['username'], ARRAY['cedula']) THEN
      EXECUTE format('ALTER TABLE public.user_roles DROP CONSTRAINT %I', r.conname);
    END IF;
  END LOOP;

  -- 2b. Índices únicos SIMPLES (no-expresión, sin constraint) sobre EXACTAMENTE
  --     {username} o {cedula} — INCLUYENDO PARCIALES: user_roles_username_idx
  --     (mig 007) y user_roles_cedula_unique (mig 123) son índices PARCIALES
  --     (WHERE ... IS NOT NULL). Ningún objeto nuevo es un índice simple sobre
  --     esas columnas, así que incluir parciales acá es seguro.
  FOR r IN
    SELECT i.indexrelid::regclass AS iname,
           (SELECT array_agg(att.attname::text ORDER BY att.attname)
              FROM unnest(i.indkey) AS k(attnum)
              JOIN pg_attribute att ON att.attrelid = i.indrelid AND att.attnum = k.attnum
              WHERE k.attnum <> 0
           ) AS cols
      FROM pg_index i
     WHERE i.indrelid = 'public.user_roles'::regclass
       AND i.indisunique
       AND i.indexprs IS NULL           -- excluir índices por expresión (EXCLUDE §4)
       AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
  LOOP
    IF r.cols IN (ARRAY['username'], ARRAY['cedula']) THEN
      EXECUTE format('DROP INDEX IF EXISTS %s', r.iname);
    -- {user_id,role} sólo si es NO parcial (nunca el índice parcial nuevo de §3):
    ELSIF r.cols = ARRAY['role','user_id']
          AND (SELECT indpred FROM pg_index x WHERE x.indexrelid = r.iname::regclass) IS NULL THEN
      EXECUTE format('DROP INDEX IF EXISTS %s', r.iname);
    END IF;
  END LOOP;
END $$;

-- Verificación dura: si alguna unique global SOBREVIVIÓ, abortar con mensaje claro
-- (mejor fallar la migración que aplicar a medias y que el caso A quede roto).
DO $$
BEGIN
  IF EXISTS (   -- constraints UNIQUE {user_id,role}/{username}/{cedula}
    SELECT 1 FROM pg_constraint con
     WHERE con.conrelid = 'public.user_roles'::regclass AND con.contype = 'u'
       AND (SELECT array_agg(att.attname::text ORDER BY att.attname)
              FROM unnest(con.conkey) AS k(attnum)
              JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
           ) IN (ARRAY['role','user_id'], ARRAY['username'], ARRAY['cedula'])
  ) OR EXISTS (  -- índices simples {username}/{cedula} (parciales incluidos)
    SELECT 1 FROM pg_index i
     WHERE i.indrelid = 'public.user_roles'::regclass
       AND i.indisunique AND i.indexprs IS NULL
       AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
       AND (SELECT array_agg(att.attname::text ORDER BY att.attname)
              FROM unnest(i.indkey) AS k(attnum)
              JOIN pg_attribute att ON att.attrelid = i.indrelid AND att.attnum = k.attnum
              WHERE k.attnum <> 0
           ) IN (ARRAY['username'], ARRAY['cedula'])
  ) OR EXISTS (  -- índice simple NO parcial {user_id,role}
    SELECT 1 FROM pg_index i
     WHERE i.indrelid = 'public.user_roles'::regclass
       AND i.indisunique AND i.indexprs IS NULL AND i.indpred IS NULL
       AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
       AND (SELECT array_agg(att.attname::text ORDER BY att.attname)
              FROM unnest(i.indkey) AS k(attnum)
              JOIN pg_attribute att ON att.attrelid = i.indrelid AND att.attnum = k.attnum
              WHERE k.attnum <> 0
           ) = ARRAY['role','user_id']
  ) THEN
    RAISE EXCEPTION 'Sobrevive una uniqueness global sobre (user_id,role)/(username)/(cedula) — bloquearía el multi-sucursal. Reconciliar antes de continuar.';
  END IF;
END $$;

-- ─── 3. Nueva clave de FILA: (user_id, restaurant_id, role) ──────────────────────
-- Permite el MISMO rol para la MISMA persona en distintos restaurantes, pero
-- impide filas duplicadas exactas. Dos índices parciales (en vez de NULLS NOT
-- DISTINCT) para ser compatibles con cualquier versión de Postgres y para
-- cubrir al superadmin (restaurant_id NULL, único por (user_id, role)).
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_user_rest_role_uidx
  ON public.user_roles (user_id, restaurant_id, role)
  WHERE restaurant_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS user_roles_user_role_super_uidx
  ON public.user_roles (user_id, role)
  WHERE restaurant_id IS NULL;

-- ─── 4. Unicidad de IDENTIDAD: cédula/username → UN SOLO user_id (race-safe) ─────
-- EXCLUDE = respaldo real "no salteable por API": aunque la RLS aún sea permisiva
-- (Sprint 1 pendiente) y alguien INSERT-e directo, la DB rechaza asociar una
-- cédula/username a un segundo user_id. Permite N filas (multi-sucursal) del MISMO
-- user_id con la misma cédula/username.
ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_cedula_one_identity;
ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_cedula_one_identity
  EXCLUDE USING gist (cedula WITH =, user_id WITH <>)
  WHERE (cedula IS NOT NULL);

ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_username_one_identity;
ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_username_one_identity
  EXCLUDE USING gist ((lower(username)) WITH =, user_id WITH <>)
  WHERE (username IS NOT NULL);

-- ─── 5. delivery_riders: ficha por (user_id, restaurant_id) + cédula → un user_id ─
DROP INDEX IF EXISTS public.uniq_delivery_riders_user;          -- mig 101 UNIQUE(user_id)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_delivery_riders_user_rest
  ON public.delivery_riders (user_id, restaurant_id)
  WHERE user_id IS NOT NULL;

ALTER TABLE public.delivery_riders DROP CONSTRAINT IF EXISTS delivery_riders_cedula_one_identity;
ALTER TABLE public.delivery_riders
  ADD CONSTRAINT delivery_riders_cedula_one_identity
  EXCLUDE USING gist (cedula WITH =, user_id WITH <>)
  WHERE (cedula IS NOT NULL AND user_id IS NOT NULL);

-- ─── 6. admin_create_user: quitar dependencia de ON CONFLICT (user_id, role) ─────
-- Función LEGACY, service_role-only y sin panel que la llame (mig 105). Su upsert
-- usaba ON CONFLICT (user_id, role), que dejaría de existir tras §2 → se reescribe
-- a un upsert explícito por (user_id, restaurant_id, role). NO se re-otorga EXECUTE:
-- CREATE OR REPLACE preserva el lockdown a service_role de la mig 105.
CREATE OR REPLACE FUNCTION public.admin_create_user(
  p_email         TEXT,
  p_username      TEXT,
  p_display_name  TEXT,
  p_role          TEXT,
  p_restaurant_id UUID    DEFAULT NULL,
  p_password      TEXT    DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth, public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'superadmin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'No autorizado: se requiere rol superadmin';
  END IF;

  IF p_role NOT IN ('cocina', 'admin', 'superadmin', 'cajero') THEN
    RAISE EXCEPTION 'Rol inválido: %', p_role;
  END IF;

  SELECT id INTO v_user_id FROM auth.users WHERE email = p_email LIMIT 1;

  IF v_user_id IS NULL THEN
    IF p_password IS NULL OR length(p_password) < 8 THEN
      RAISE EXCEPTION 'Se requiere una contraseña de al menos 8 caracteres';
    END IF;

    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      is_super_admin, created_at, updated_at
    ) VALUES (
      '00000000-0000-0000-0000-000000000000',
      gen_random_uuid(),
      'authenticated', 'authenticated',
      p_email,
      crypt(p_password, gen_salt('bf')),
      NOW(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('username', p_username, 'display_name', p_display_name),
      false, NOW(), NOW()
    ) RETURNING id INTO v_user_id;
  ELSE
    UPDATE auth.users
    SET email_confirmed_at = COALESCE(email_confirmed_at, NOW()), updated_at = NOW()
    WHERE id = v_user_id;
  END IF;

  -- Upsert por (user_id, restaurant_id, role) sin ON CONFLICT (la clave de fila
  -- ahora es multi-sucursal). IS NOT DISTINCT FROM cubre restaurant_id NULL.
  UPDATE public.user_roles
     SET email = p_email, username = p_username, display_name = p_display_name,
         is_active = true
   WHERE user_id = v_user_id AND role = p_role
     AND restaurant_id IS NOT DISTINCT FROM p_restaurant_id;
  IF NOT FOUND THEN
    INSERT INTO public.user_roles (user_id, email, username, display_name, role, restaurant_id, is_active)
    VALUES (v_user_id, p_email, p_username, p_display_name, p_role, p_restaurant_id, true);
  END IF;

  RETURN json_build_object(
    'user_id',  v_user_id,
    'email',    p_email,
    'username', p_username,
    'role',     p_role
  );
END;
$$;
-- Lockdown explícito (idempotente): función legacy service_role-only, ningún panel
-- la llama. En prod ya estaba así (mig 105); esto lo hace determinístico también en
-- entornos frescos donde CREATE OR REPLACE la habría dejado con EXECUTE a PUBLIC.
REVOKE EXECUTE ON FUNCTION public.admin_create_user(text, text, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_create_user(text, text, text, text, uuid, text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ════════════════════════════════════════════════════════════════════
-- RE-VERIFICACIÓN (correr en el SQL Editor después de aplicar) — todo debe pasar:
--
-- -- (a) Estado de constraints/índices esperados:
-- SELECT conname FROM pg_constraint
--  WHERE conrelid = 'public.user_roles'::regclass
--    AND conname IN ('user_roles_cedula_one_identity','user_roles_username_one_identity');
-- SELECT indexname FROM pg_indexes
--  WHERE schemaname='public' AND tablename='user_roles'
--    AND indexname IN ('user_roles_user_rest_role_uidx','user_roles_user_role_super_uidx');
-- -- Deben NO existir: user_roles_cedula_unique, user_roles_username_idx, uniq_delivery_riders_user
--
-- -- (b) misma cédula, MISMO user_id, distinto restaurante → PERMITIDO (no debe fallar):
-- --     (probar con un user_id real; rollback al final)
-- -- BEGIN;
-- --   INSERT INTO public.user_roles(user_id, role, restaurant_id, cedula, username, email, is_active)
-- --   VALUES ('<UID>','mozo','<RID_A>','9999999','9999999','9999999@mythos.internal',true),
-- --          ('<UID>','mozo','<RID_B>','9999999','9999999','9999999@mythos.internal',true);
-- -- ROLLBACK;
--
-- -- (c) misma cédula, DISTINTO user_id → DEBE FALLAR (viola EXCLUDE):
-- -- BEGIN;
-- --   INSERT INTO public.user_roles(user_id, role, restaurant_id, cedula, username, email, is_active)
-- --   VALUES ('<UID1>','mozo','<RID_A>','8888888','8888888','8888888@mythos.internal',true),
-- --          ('<UID2>','mozo','<RID_B>','8888888','8888888','8888888@mythos.internal',true);
-- --   -- ERROR: conflicting key value violates exclusion constraint "user_roles_cedula_one_identity"
-- -- ROLLBACK;
-- ════════════════════════════════════════════════════════════════════
