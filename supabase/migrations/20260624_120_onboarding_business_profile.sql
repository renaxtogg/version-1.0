-- ════════════════════════════════════════════════════════════════════
-- 120 · ONBOARDING — perfil de negocio + operación + comprobantes
--       (PREPARED — NOT APPLIED: aplicar manualmente tras backup nuevo,
--        SQL Editor en INGLÉS. Claude Code NO la aplica.)
-- ────────────────────────────────────────────────────────────────────
-- Columnas nuevas que captura el wizard de onboarding rediseñado
-- (UX-ONBOARDING-1). Pasos 1/4/5. TODO lo demás (contacto, redes, RUC,
-- razón social, payment_methods, einvoicing_status, logo_initials) REUSA
-- columnas que YA existen en restaurants (no se duplican acá).
--
-- ALCANCE / SEGURIDAD:
--   • 100% ADITIVA: ADD COLUMN IF NOT EXISTS. NO altera/borra columnas,
--     NO toca RLS (la policy de UPDATE de restaurants ya aísla por
--     restaurant_id → el admin puede escribir estas columnas en su local),
--     NO cambia nada del superadmin ni de otros paneles.
--   • El wizard escribe estas columnas de forma DEFENSIVA (feature-detect):
--     si la migración aún no está aplicada, simplemente NO las persiste y el
--     onboarding sigue funcionando (degradación con gracia). El pre-config
--     real de mesas usa la tabla `tables` (ya existente), no estas columnas.
--   • business_type es TEXT libre (no rompe el CHECK de leads_prospectos.
--     tipo_negocio, que es otra tabla con valores distintos).
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- Paso 1 — tipo de negocio (re-preguntado en el onboarding; valores propios,
--   independientes del CHECK de leads_prospectos): restaurante | foodpark_local
--   | delivery_dark | otro.
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS business_type text;

-- Paso 4 — cómo opera el local (preferencias para pre-configurar el Admin).
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS operation_modes jsonb NOT NULL DEFAULT '[]'::jsonb;  -- mesas_salon | retiro_local | delivery_propio | whatsapp | apps_externas
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS order_intake    jsonb NOT NULL DEFAULT '[]'::jsonb;  -- mozo | caja | qr_cliente | papel
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS kitchen_routing text;                               -- kds | tablet | impresora | manual
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS table_count     integer;                            -- cantidad aproximada de mesas (semilla de `tables`)

-- Paso 5 — qué necesita imprimir.
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS print_needs     jsonb NOT NULL DEFAULT '[]'::jsonb;  -- ticket_cliente | comanda_cocina | comanda_barra | factura_legal | ninguno

COMMIT;

-- Recargar el cache de esquema de PostgREST (columnas nuevas visibles).
NOTIFY pgrst, 'reload schema';

SELECT 'migration 120 applied — restaurants business/operation/print profile columns' AS status;
