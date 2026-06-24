-- ════════════════════════════════════════════════════════════════════
-- 117 · LEADS PROSPECTOS — captación de DUEÑOS desde /registro (FASE OWNER-SIGNUP-1)
--       (PREPARED — NOT APPLIED: aplicar manualmente tras backup nuevo,
--        SQL Editor en INGLÉS. Claude Code NO la aplica.)
-- ────────────────────────────────────────────────────────────────────
-- Tabla de prospectos para el registro público de DUEÑOS de local
-- (public/registro.html). Cuando un dueño crea su cuenta (Supabase
-- auth.signUp + verificación de email obligatoria) el frontend guarda
-- SIEMPRE un lead acá — aunque después no verifique, no complete el
-- onboarding ni contrate. Esta fase NO crea restaurante, NI roles, NI
-- subscription (eso es el wizard, fase siguiente).
--
-- ALCANCE / SEGURIDAD:
--   • 100% ADITIVA: solo CREATE TABLE IF NOT EXISTS de una tabla NUEVA
--     + sus policies/grants. NO altera ninguna tabla/policy/grant/dato
--     existente (incluida marketing_leads). No destructiva.
--   • RLS fail-closed: anon SOLO INSERT (estado='registrado',
--     verificado=false); NO puede SELECT/UPDATE/DELETE. Lectura/gestión:
--     SOLO superadmin (public.get_my_role() = 'superadmin', mig 029).
--   • Mismo patrón que marketing_leads (mig 110 §7): el frontend inserta
--     SIN .select() (return=minimal); anon no tiene SELECT.
--   • ⚠️ GATE DE SEGURIDAD (auditoría 2026-06-24): habilitar el registro
--     público de /registro abre `auth.signUp` a cualquiera → cualquier
--     visitante puede obtener una sesión 'authenticated'. Mientras ~25
--     tablas sigan con RLS USING(true) TO authenticated (Sprint 1, migs
--     103/104/105 PREPARADAS pero NO aplicadas), eso expone datos
--     cross-tenant. HOY es bajo impacto (prod = demo/QA, sin clientes
--     reales), pero aplicar el Sprint 1 RLS es PRERREQUISITO antes de
--     onboardear clientes reales. Kill-switch sin redeploy:
--     marketing_config.owner_signup_enabled = false (ver PART B).
--
-- NOTA `verificado`: arranca en false y se queda en false en ESTA fase.
--   Todavía no hay mecanismo (webhook / endpoint server-side) que lo
--   flipe al confirmar el email; ese flip llega con el wizard / endpoint
--   de la fase siguiente. La columna queda lista para entonces.
--
-- Idempotente: CREATE TABLE IF NOT EXISTS + DROP POLICY IF EXISTS + CREATE.
-- Seguro de re-correr.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS public.leads_prospectos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text,
  tipo_negocio  text NOT NULL
                  CHECK (tipo_negocio IN ('restaurante','foodpark_local','foodpark_owner')),
  estado        text NOT NULL DEFAULT 'registrado'
                  -- 'onboarding' lo setea el endpoint /api/onboarding (service_role) cuando
                  -- el dueño crea su local (Bloque C). anon solo puede insertar 'registrado'.
                  CHECK (estado IN ('registrado','onboarding','contactado','calificado','convertido','descartado')),
  origen        text NOT NULL DEFAULT 'web_registro',
  verificado    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leads_prospectos_created
  ON public.leads_prospectos (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_prospectos_estado
  ON public.leads_prospectos (estado, created_at DESC);

ALTER TABLE public.leads_prospectos ENABLE ROW LEVEL SECURITY;

-- anon: SOLO crear leads nuevos; no puede marcarse verificado ni prefijar
-- un estado de gestión. tipo_negocio/origen acotados a los valores del flujo.
DROP POLICY IF EXISTS "leads_prospectos_anon_insert" ON public.leads_prospectos;
CREATE POLICY "leads_prospectos_anon_insert" ON public.leads_prospectos
  FOR INSERT TO anon
  WITH CHECK (
    estado = 'registrado'
    AND verificado = false
    AND origen IN ('web_registro','interes_foodpark')
    AND tipo_negocio IN ('restaurante','foodpark_local','foodpark_owner')
  );

-- superadmin: gestión total (leer, triagear, marcar estado/verificado).
DROP POLICY IF EXISTS "leads_prospectos_superadmin_all" ON public.leads_prospectos;
CREATE POLICY "leads_prospectos_superadmin_all" ON public.leads_prospectos
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- anon: SOLO INSERT (sin SELECT/UPDATE/DELETE). authenticated: gestión (RLS la
-- limita a superadmin). Sin GRANT SELECT a anon → no puede leer ni con bug.
REVOKE ALL ON public.leads_prospectos FROM anon;
GRANT INSERT ON public.leads_prospectos TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.leads_prospectos TO authenticated;

-- ── PART B · kill-switch del registro de dueños ──────────────────────
-- Bandera pública para cerrar /registro sin redeploy (gestionable desde
-- Superadmin → Sitio web). Default 'true' = registro VIVO; ponela en
-- 'false' para cerrarlo. El frontend trata ausente/true/error como
-- habilitado (registro vivo). Guarded: solo si marketing_config (mig 110)
-- existe, así 117 NO queda acoplada a 110.
DO $$
BEGIN
  IF to_regclass('public.marketing_config') IS NOT NULL THEN
    INSERT INTO public.marketing_config (key, value, is_public)
    VALUES ('owner_signup_enabled', 'true'::jsonb, true)
    ON CONFLICT (key) DO NOTHING;
  END IF;
END $$;

COMMIT;

-- Recargar el cache de esquema de PostgREST para que apliquen privilegios/policies.
NOTIFY pgrst, 'reload schema';

SELECT 'migration 117 applied — leads_prospectos table' AS status;
