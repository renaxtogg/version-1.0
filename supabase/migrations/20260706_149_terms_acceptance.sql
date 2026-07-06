-- ════════════════════════════════════════════════════════════════════════
-- 149 · ACEPTACIÓN DE TÉRMINOS Y CONDICIONES (registro append-only por usuario)
-- ────────────────────────────────────────────────────────────────────────
-- (PREPARED — NOT APPLIED: aplicar manualmente tras backup nuevo, SQL Editor
--  en INGLÉS. Claude Code NO la aplica.)
--
-- Registra que un usuario aceptó los Términos y la Política de Privacidad, con
-- fecha e identificador de versión. Alimenta: el registro público (registro),
-- el onboarding del dueño, y un gate de una sola vez en el primer ingreso al
-- panel admin (cubre el alta hecha por el superadmin).
--
-- Diseño (tabla dedicada append-only, NO columnas en user_roles):
--   • Historial completo (cada versión nueva de ToS exige re-aceptación) → rastro
--     legal, no un único valor de estado.
--   • No abre un UPDATE propio sobre user_roles (que a propósito no lo tiene, para
--     que el usuario no toque role/restaurant_id/is_active — mig 029/145).
--   • Se puede aceptar ANTES de tener restaurante (signup) → restaurant_id nullable.
--   • RPC fail-closed: timestamp server-side (no backdatear), user_id = auth.uid()
--     (no aceptar por otro), anon denegado.
-- 100% ADITIVA / idempotente. No toca RLS ni tablas existentes.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS public.terms_acceptance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  restaurant_id uuid REFERENCES public.restaurants(id) ON DELETE SET NULL,  -- NULL en signup
  version       text NOT NULL,                       -- ej. '2026-07-05'
  accepted_at   timestamptz NOT NULL DEFAULT now(),
  source        text,                                -- 'signup' | 'onboarding' | 'first_login' | ...
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS terms_acceptance_user_idx    ON public.terms_acceptance(user_id);
CREATE INDEX IF NOT EXISTS terms_acceptance_version_idx ON public.terms_acceptance(user_id, version);

ALTER TABLE public.terms_acceptance ENABLE ROW LEVEL SECURITY;

-- El usuario LEE lo suyo; superadmin LEE todo.
DROP POLICY IF EXISTS "ta_read_own_or_superadmin" ON public.terms_acceptance;
CREATE POLICY "ta_read_own_or_superadmin" ON public.terms_acceptance
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.get_my_role() = 'superadmin');

-- SIN INSERT directo por PostgREST: TODAS las escrituras pasan por la RPC
-- SECURITY DEFINER record_terms_acceptance (estampa accepted_at server-side y
-- fuerza user_id=auth.uid()). Si se permitiera INSERT directo, un usuario podría
-- backdatear accepted_at o falsear restaurant_id/version en su fila de auditoría.
-- (Se dropea cualquier policy de INSERT por si una versión previa la creó.)
DROP POLICY IF EXISTS "ta_insert_own" ON public.terms_acceptance;

-- REVOKE ALL antes del grant estrecho: anula los privilegios por defecto que
-- Supabase concede a anon/authenticated sobre tablas nuevas (UPDATE/DELETE/
-- TRUNCATE). El usuario solo puede LEER lo suyo; escribir es exclusivo de la RPC
-- (corre como owner, RLS/grant-exempt). Auditoría inmutable.
REVOKE ALL ON public.terms_acceptance FROM anon, authenticated;   -- fail-closed
GRANT SELECT ON public.terms_acceptance TO authenticated;

-- ── RPC fail-closed: estampa accepted_at server-side y fuerza user_id=auth.uid() ──
CREATE OR REPLACE FUNCTION public.record_terms_acceptance(
  p_version text,
  p_source  text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id  uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'no auth' USING ERRCODE = '28000';           -- anon → denegado
  END IF;
  IF COALESCE(btrim(p_version), '') = '' THEN
    RAISE EXCEPTION 'version requerida' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.terms_acceptance (user_id, restaurant_id, version, source)
  VALUES (
    v_uid,
    (SELECT restaurant_id FROM public.user_roles
      WHERE user_id = v_uid AND is_active = true LIMIT 1),        -- NULL si aún no tiene
    btrim(p_version),
    NULLIF(btrim(p_source), '')
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL     ON FUNCTION public.record_terms_acceptance(text, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.record_terms_acceptance(text, text) TO authenticated;

COMMIT;

-- Recargar el cache de esquema de PostgREST (nueva tabla/función visible).
NOTIFY pgrst, 'reload schema';

SELECT 'migration 149 applied — terms_acceptance table + record_terms_acceptance RPC' AS status;
