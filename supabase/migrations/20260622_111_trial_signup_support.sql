-- ════════════════════════════════════════════════════════════════════
-- 111 · TRIAL SIGNUP SUPPORT — mapeo plan + flags de config (FASE WEB-4B-1)
--       (PREPARED — NOT APPLIED: aplicar manualmente tras backup nuevo,
--        SQL Editor en INGLÉS. Claude Code NO la aplica.)
-- ────────────────────────────────────────────────────────────────────
-- Prepara el terreno para el registro público de prueba gratis (14 días)
-- SIN abrirlo. El registro público permanece APAGADO detrás del flag
-- marketing_config.trial_signup_enabled = false hasta decisión explícita
-- de Renato. Esta migración NO crea cuentas, restaurantes ni trials.
--
-- ALCANCE / SEGURIDAD:
--   • 100% ADITIVA + IDEMPOTENTE: ADD COLUMN IF NOT EXISTS, índice
--     IF NOT EXISTS, UPDATE solo donde marketing_slug IS NULL, e
--     INSERT ... ON CONFLICT DO NOTHING. Sin DROP, sin pérdida de datos.
--   • NO crea endpoint /api/signup-trial, NO crea auth users, NO inserta
--     en restaurants / subscriptions / user_roles, NO toca RLS de
--     escritura, NO agrega enforcement de expiración ni cron.
--   • Solo mapea slugs de marketing -> planes de billing para que un
--     futuro endpoint server-side (WEB-4B-2) resuelva ?plan -> plan_id
--     en el servidor (nunca confiando en el query param del cliente).
--
-- DECISIONES DE NEGOCIO (Renato, 2026-06-22):
--   • carta    -> Starter
--   • servicio -> Pro
--   • full     -> Enterprise
--   • 'enterprise' (marketing) NO se mapea: es "a cotizar" / contactar
--     ventas; no auto-provisiona ningún plan.
--   • trial_days = 14.
--   • Registro público APAGADO: trial_signup_enabled = false.
--   • Los precios de marketing NO se alinean (todavía) con el billing
--     interno: billing define capabilities/features; marketing define la
--     venta. Por eso el mapeo es por nombre de plan, no por precio.
--
-- Contexto y roadmap completo: docs/audits/web4b-trial-signup-audit.md
-- ════════════════════════════════════════════════════════════════════

-- ── PART A · mapeo slug de marketing -> plan de billing ──────────────
-- subscription_plans no tiene columna slug; sin esto /registro?plan=<slug>
-- no puede resolverse a un plan_id de forma determinística en el servidor.
ALTER TABLE public.subscription_plans
  ADD COLUMN IF NOT EXISTS marketing_slug text;

-- Único cuando está presente (un plan de billing por slug de marketing).
-- Parcial: permite múltiples NULL (planes sin slug de marketing).
CREATE UNIQUE INDEX IF NOT EXISTS subscription_plans_marketing_slug_idx
  ON public.subscription_plans (marketing_slug)
  WHERE marketing_slug IS NOT NULL;

-- Backfill idempotente: solo escribe cuando está NULL, no pisa valores
-- previos. 'enterprise' (marketing) queda SIN mapear a propósito.
UPDATE public.subscription_plans SET marketing_slug = 'carta'
  WHERE name = 'Starter'    AND marketing_slug IS NULL;
UPDATE public.subscription_plans SET marketing_slug = 'servicio'
  WHERE name = 'Pro'        AND marketing_slug IS NULL;
UPDATE public.subscription_plans SET marketing_slug = 'full'
  WHERE name = 'Enterprise' AND marketing_slug IS NULL;

-- ── PART B · flags de config pública del registro trial ──────────────
-- trial_signup_enabled = false: el registro público real permanece
--   APAGADO; el frontend y el futuro endpoint deben respetar este gate.
-- trial_days = 14: solo si no existe (mig 110 ya lo siembra → DO NOTHING
--   no lo pisa). Se re-asienta acá para que la migración sea autónoma.
INSERT INTO public.marketing_config (key, value, is_public) VALUES
  ('trial_signup_enabled', 'false'::jsonb, true),
  ('trial_days',           '14'::jsonb,    true)
ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
