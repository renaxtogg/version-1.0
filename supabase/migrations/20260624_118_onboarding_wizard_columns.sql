-- ════════════════════════════════════════════════════════════════════
-- 118 · ONBOARDING WIZARD — columnas de perfil/cobro/facturación en restaurants
--       (Bloque C parte 1 / Prompt 03A)
--       (PREPARED — NOT APPLIED: aplicar manualmente tras backup nuevo,
--        SQL Editor en INGLÉS. Claude Code NO la aplica.)
-- ────────────────────────────────────────────────────────────────────
-- Soporte de columnas para el wizard de onboarding del dueño (public/onboarding.html).
-- Todo el wizard es FRONT: el rol admin/owner hace UPDATE de SU restaurante
-- (RLS ya lo permite, verificado por el arquitecto). Esta migración solo agrega
-- las columnas que faltaban.
--
-- ALCANCE / SEGURIDAD:
--   • 100% ADITIVA: solo ADD COLUMN IF NOT EXISTS. NO toca datos, policies,
--     grants ni otras tablas. No destructiva. Idempotente (seguro re-correr).
--   • payment_methods: array de medios elegidos (efectivo/tarjeta/qr/bancard/dinelco).
--   • einvoicing_status: 'ya_tengo' | 'me_interesa' | 'no_por_ahora' (sin CHECK,
--     para no acoplar; el front acota los valores).
--   • onboarding_completed_at: marca el fin del wizard. El gate de login (admin
--     con esta columna NULL → retoma el wizard) la usa para no entrar al panel
--     hasta completar.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS facebook                text;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS whatsapp                text;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS payment_methods         jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS einvoicing_status       text;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;

COMMIT;

-- Recargar el cache de esquema de PostgREST para que las columnas sean visibles.
NOTIFY pgrst, 'reload schema';

SELECT 'migration 118 applied — onboarding wizard columns' AS status;
