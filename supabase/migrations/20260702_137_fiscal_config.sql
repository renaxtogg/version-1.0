-- ════════════════════════════════════════════════════════════════════
-- 137 · fiscal_config — configuración fiscal por restaurante (SIFEN/FacturaSend)
-- ────────────────────────────────────────────────────────────────────
-- PR-FE-1. Una fila por restaurante. NO incluye documentos_electronicos ni
-- emisión (eso es PR-FE-2). 1 PR = 1 causa.
--
-- La API key del proveedor se guarda CIFRADA (AES-256-GCM a nivel serverless):
-- la DB sólo ve api_key_ciphertext + api_key_iv + api_key_tag. El descifrado
-- ocurre SÓLO en el server con la master key FACTURASEND_ENC_KEY (env de Vercel,
-- NUNCA en la DB ni en el repo).
--
-- RLS: DENY total para anon y authenticated (ni admin/gerente/superadmin-cliente
-- leen esta tabla desde el frontend). El único acceso es service_role, que
-- bypassa RLS y opera SÓLO desde el server (endpoints en api/facturasend/*).
--
-- Idempotente. Revertir: DROP TABLE public.fiscal_config;  (borra tabla+RLS+grants)
-- ════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS public.fiscal_config (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL UNIQUE REFERENCES public.restaurants(id) ON DELETE CASCADE,
  provider            text NOT NULL DEFAULT 'facturasend',
  tenant              text,
  environment         text NOT NULL DEFAULT 'sandbox'
                        CHECK (environment IN ('sandbox','test','production')),
  -- API key CIFRADA (AES-256-GCM). Nunca en claro en la DB.
  api_key_ciphertext  text,
  api_key_iv          text,
  api_key_tag         text,
  -- Datos fiscales del emisor (protegidos por RLS; sólo service_role los ve)
  ruc                 text,
  razon_social        text,
  timbrado            text,
  establecimiento     text,
  punto_expedicion    text,
  actividad_economica text,
  csc_id              text,
  csc                 text,
  auto_email          boolean NOT NULL DEFAULT true,
  kude_format         text NOT NULL DEFAULT 'ticket',
  active              boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ── RLS: sólo service_role. anon/authenticated quedan sin acceso ────────────
ALTER TABLE public.fiscal_config ENABLE ROW LEVEL SECURITY;

-- Quitar cualquier privilegio por defecto que Supabase conceda a los roles de
-- cliente al crear la tabla. Sin privilegio + RLS sin policies = doble negación.
REVOKE ALL ON public.fiscal_config FROM PUBLIC, anon, authenticated;

-- service_role bypassa RLS, pero igual necesita el privilegio de tabla explícito.
GRANT ALL ON public.fiscal_config TO service_role;

-- Intencionalmente SIN policies para anon/authenticated → RLS default-deny para
-- ellos. La tabla NO se agrega a la publicación supabase_realtime.

COMMIT;

-- Recargar el cache de esquema de PostgREST para exponer la tabla al service_role.
NOTIFY pgrst, 'reload schema';

SELECT 'migracion 137 aplicada (fiscal_config + RLS service_role-only)' AS status;
