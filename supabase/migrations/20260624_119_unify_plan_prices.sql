-- ════════════════════════════════════════════════════════════════════
-- 119 · UNIFICAR PLANES — la vidriera (marketing_plans) refleja el operativo
--       (subscription_plans). Fuente única de precios = subscription_plans.
--       (PREPARED — NOT APPLIED: aplicar manualmente tras backup nuevo,
--        SQL Editor en INGLÉS. Claude Code NO la aplica.)
-- ────────────────────────────────────────────────────────────────────
-- Termina las DOS listas distintas (web 99/229/399 vs superadmin 200/400/800):
-- gana superadmin. La web sigue LEYENDO marketing_plans (no se expone
-- subscription_plans a anon), pero su PRECIO se sincroniza desde el plan
-- operativo vinculado, y un trigger lo mantiene sincronizado para siempre.
--
-- ALCANCE / SEGURIDAD:
--   • 100% ADITIVA: ADD COLUMN IF NOT EXISTS + backfills + 1 función/trigger
--     nuevos. NO altera/borra columnas existentes, NO toca RLS ni el CRUD de
--     planes del superadmin, NO cambia nombres ni cantidad de planes.
--   • NO sincroniza el NOMBRE: el nombre comercial de marketing_plans queda
--     editable (permite "Carta" en la web mapeado a "Starter" operativo). El
--     copy/taglines/bullets de marketing_plans NO se tocan.
--   • price_usd está en GUARANÍES a pesar del nombre (decisión de billing).
--     price_monthly_gs = price_usd ; price_annual_gs = price_usd*10 (2 meses
--     gratis, convención de la vidriera).
--   • Grandfathering: subscriptions.monthly_amount (snapshot al contratar) NO
--     se toca salvo backfill de las que estén en NULL. Cambiar el precio de un
--     plan afecta solo NUEVAS suscripciones.
--
-- NOTA: el backfill del link asume nombres operativos Starter/Pro/Enterprise
--   (estado actual confirmado por el arquitecto). Validar contra la base viva
--   antes de aplicar (regla schema-drift).
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1) Link marketing_plans → subscription_plans ─────────────────────
ALTER TABLE public.marketing_plans
  ADD COLUMN IF NOT EXISTS subscription_plan_id uuid
    REFERENCES public.subscription_plans(id) ON DELETE SET NULL;

-- ── 2) Backfill del mapeo por nivel: Carta→Starter, Servicio→Pro, Full→Enterprise ──
--    El marketing "Enterprise (a cotizar)" queda con subscription_plan_id = NULL
--    (es CTA de contacto, no self-service) → no se le sincroniza precio.
UPDATE public.marketing_plans mp
   SET subscription_plan_id = sp.id
  FROM public.subscription_plans sp
 WHERE mp.subscription_plan_id IS NULL
   AND ( (mp.slug = 'carta'    AND sp.name = 'Starter')
      OR (mp.slug = 'servicio' AND sp.name = 'Pro')
      OR (mp.slug = 'full'     AND sp.name = 'Enterprise') );

-- ── 3) Backfill inmediato del precio desde el plan vinculado ─────────
UPDATE public.marketing_plans mp
   SET price_monthly_gs = sp.price_usd::integer,
       price_annual_gs  = (sp.price_usd * 10)::integer,
       updated_at = now()
  FROM public.subscription_plans sp
 WHERE mp.subscription_plan_id = sp.id
   AND ( mp.price_monthly_gs IS DISTINCT FROM sp.price_usd::integer
      OR mp.price_annual_gs  IS DISTINCT FROM (sp.price_usd * 10)::integer );

-- ── 4) Grandfathering: congelar el snapshot donde falte (idempotente) ─
UPDATE public.subscriptions s
   SET monthly_amount = sp.price_usd
  FROM public.subscription_plans sp
 WHERE s.plan_id = sp.id
   AND s.monthly_amount IS NULL;

-- ── 5) Trigger de sincronización (editar precio operativo → vidriera sola) ──
--    SECURITY DEFINER: corre como owner para poder actualizar marketing_plans
--    sin depender del rol que disparó el cambio. NO sincroniza el nombre.
CREATE OR REPLACE FUNCTION public.sync_marketing_plan_price()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.marketing_plans
     SET price_monthly_gs = NEW.price_usd::integer,
         price_annual_gs  = (NEW.price_usd * 10)::integer,
         updated_at = now()
   WHERE subscription_plan_id = NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_marketing_plan_price ON public.subscription_plans;
CREATE TRIGGER trg_sync_marketing_plan_price
  AFTER INSERT OR UPDATE OF price_usd ON public.subscription_plans
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_marketing_plan_price();

COMMIT;

-- Recargar el cache de esquema de PostgREST (nueva columna visible).
NOTIFY pgrst, 'reload schema';

SELECT 'migration 119 applied — marketing_plans linked to subscription_plans + price sync trigger' AS status;
