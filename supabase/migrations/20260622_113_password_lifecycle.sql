-- ════════════════════════════════════════════════════════════════════
-- 113 · PASSWORD LIFECYCLE — flag de cambio de contraseña (FASE AUTH-1)
--       (PREPARED — NOT APPLIED: aplicar manualmente tras backup nuevo,
--        SQL Editor en INGLÉS. Claude Code NO la aplica.)
-- ────────────────────────────────────────────────────────────────────
-- Habilita el ciclo de vida de contraseñas: recuperación ("olvidé mi
-- contraseña"), cambio estando logueado, y cambio OBLIGATORIO en el primer
-- ingreso cuando el usuario fue creado con una contraseña genérica por un
-- Admin/Superadmin.
--
-- POR QUÉ UNA TABLA PROPIA (no auth.users.raw_user_meta_data):
--   user_metadata es editable por el propio usuario desde el cliente
--   (auth.updateUser({ data })). Un flag de seguridad NUNCA debe vivir
--   donde el usuario lo pueda apagar. Esta tabla tiene RLS: el usuario
--   solo LEE su fila y NO puede escribirla; el flag se limpia SOLO
--   server-side (endpoint /api/change-password con service_role), y solo
--   DESPUÉS de cambiar la contraseña de verdad.
--
-- ALCANCE / SEGURIDAD:
--   • 100% ADITIVA: crea UNA tabla nueva + sus policies/grants. No altera
--     tablas, funciones ni datos existentes. Idempotente (IF NOT EXISTS,
--     DROP POLICY IF EXISTS).
--   • RLS obligatoria, fail-closed: sin policy aplicable = denegado.
--   • anon: sin acceso. authenticated: LEE solo su fila; escribe solo
--     superadmin (vía RLS). El server usa service_role (bypassa RLS) para
--     setear/limpiar el flag.
--   • Helper reutilizado: public.get_my_role() [mig 029].
-- ════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS public.user_security_flags (
  user_id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  must_change_password boolean NOT NULL DEFAULT false,
  password_changed_at  timestamptz,
  forced_reason        text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_security_flags ENABLE ROW LEVEL SECURITY;

-- El usuario autenticado LEE únicamente su propia fila.
DROP POLICY IF EXISTS "usf_read_own" ON public.user_security_flags;
CREATE POLICY "usf_read_own" ON public.user_security_flags
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Superadmin: gestión total (leer/forzar/limpiar). NO hay policy de
-- INSERT/UPDATE/DELETE para el usuario común → no puede apagar su propio
-- must_change_password desde el frontend (aunque tenga el GRANT, RLS lo niega).
DROP POLICY IF EXISTS "usf_superadmin_all" ON public.user_security_flags;
CREATE POLICY "usf_superadmin_all" ON public.user_security_flags
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- anon sin acceso. authenticated con GRANT amplio pero acotado por RLS
-- (SELECT propio / escritura solo superadmin). El alta y la limpieza del
-- flag las hace el server con service_role (bypassa RLS).
REVOKE ALL ON public.user_security_flags FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_security_flags TO authenticated;

-- Mantener updated_at al día (trigger helper existente, mig 001).
DROP TRIGGER IF EXISTS trg_user_security_flags_updated_at ON public.user_security_flags;
CREATE TRIGGER trg_user_security_flags_updated_at
  BEFORE UPDATE ON public.user_security_flags
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMIT;

-- Recargar el cache de esquema de PostgREST para que apliquen privilegios/policies.
NOTIFY pgrst, 'reload schema';

SELECT 'migration 113 applied — user_security_flags' AS status;
