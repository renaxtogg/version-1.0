-- ════════════════════════════════════════════════════════════════════
-- 153 · DESCRIPCIONES DE PLANES + CONFIG PÚBLICA PARA LA LISTA "INCLUYE"
-- ────────────────────────────────────────────────────────────────────
-- El sitio público (web.html / precios.html) lee SOLO marketing_plans (anon
-- no tiene acceso a subscription_plans, mig 103). Para que la lista "incluye"
-- de cada plan se GENERE desde la config real (allowed_panels + allowed_features
-- + límites) y SIEMPRE coincida con lo configurado en el superadmin, espejamos
-- esa config en una columna pública `marketing_plans.plan_config` (jsonb, no
-- sensible: solo flags de capacidad), mantenida por triggers.
--
-- Además cargamos las descripciones comerciales de los 3 planes (fuente única
-- editable en Superadmin → Sitio → Planes, y mostrada por el sitio). Se mapean
-- por SLUG estable (mig 110): carta→Emprendedor, servicio→Consolidado,
-- full→Premium. También se alinea el NOMBRE público a esas 3 marcas para que
-- las descripciones ("Todo lo de Emprendedor…") sean coherentes con las tarjetas.
--
-- SEGURIDAD / ALCANCE:
--   • 100% aditiva: ADD COLUMN IF NOT EXISTS + funciones/triggers nuevos + UPDATE
--     de contenido. No toca RLS (marketing_plans ya expone filas activas a anon),
--     ni precios (los sigue sincronizando mig 119), ni subscription_plans.
--   • plan_config NO incluye nada sensible (ni precios de costo, ni PII): solo
--     panels/features/límites, que ya se muestran en la vidriera.
--   • Triggers SECURITY DEFINER + search_path=public (patrón mig 119).
-- IDEMPOTENTE: reejecutable. Aplicar en SQL Editor (INGLÉS), rol postgres, backup.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1) Columna pública con la config del plan (espejo del operativo) ──
ALTER TABLE public.marketing_plans
  ADD COLUMN IF NOT EXISTS plan_config jsonb;

-- ── 2) Constructor del espejo desde una fila de subscription_plans ────
CREATE OR REPLACE FUNCTION public.mkt_build_plan_config(sp public.subscription_plans)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'panels',         COALESCE(sp.allowed_panels,     '[]'::jsonb),
    'features',       COALESCE(sp.allowed_features,    '[]'::jsonb),
    'max_tables',     sp.max_tables,
    'max_menu_items', sp.max_menu_items,
    'max_users',      COALESCE(sp.max_users_by_role,  '{}'::jsonb)
  );
$$;

-- ── 3) Backfill inmediato desde el plan vinculado ────────────────────
UPDATE public.marketing_plans mp
   SET plan_config = public.mkt_build_plan_config(sp),
       updated_at  = now()
  FROM public.subscription_plans sp
 WHERE mp.subscription_plan_id = sp.id;

-- ── 4) Sync continuo: cambio en el plan operativo → espejo en la vidriera ──
CREATE OR REPLACE FUNCTION public.sync_marketing_plan_config()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.marketing_plans
     SET plan_config = public.mkt_build_plan_config(NEW),
         updated_at  = now()
   WHERE subscription_plan_id = NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_marketing_plan_config ON public.subscription_plans;
CREATE TRIGGER trg_sync_marketing_plan_config
  AFTER INSERT OR UPDATE ON public.subscription_plans
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_marketing_plan_config();

-- ── 5) Al (re)vincular un marketing_plan, jalar la config del plan operativo ──
CREATE OR REPLACE FUNCTION public.mkt_pull_plan_config()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_sp public.subscription_plans;
BEGIN
  IF NEW.subscription_plan_id IS NOT NULL THEN
    SELECT * INTO v_sp FROM public.subscription_plans WHERE id = NEW.subscription_plan_id;
    IF FOUND THEN NEW.plan_config := public.mkt_build_plan_config(v_sp); END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mkt_pull_plan_config ON public.marketing_plans;
CREATE TRIGGER trg_mkt_pull_plan_config
  BEFORE INSERT OR UPDATE OF subscription_plan_id ON public.marketing_plans
  FOR EACH ROW
  EXECUTE FUNCTION public.mkt_pull_plan_config();

-- ── 6) Descripciones comerciales + marcas de los 3 planes (por slug) ─
--    Fuente única: editable luego en Superadmin → Sitio → Planes.
UPDATE public.marketing_plans SET
    name        = 'Emprendedor',
    description = 'Tu carta, en digital. Da el primer paso: menú digital con QR, sin papel y actualizable al instante, más el panel de gestión para cargar tu carta, ver pedidos y controlar tus insumos.',
    updated_at  = now()
 WHERE slug = 'carta';

UPDATE public.marketing_plans SET
    name        = 'Consolidado',
    description = 'Operá todo tu salón. Todo lo de Emprendedor más el sistema completo en tiempo real: caja, mozos y pantalla de cocina conectados, y CRM para conocer a tus clientes.',
    updated_at  = now()
 WHERE slug = 'servicio';

UPDATE public.marketing_plans SET
    name        = 'Premium',
    description = 'Sumá delivery y escalá. Todo lo de Consolidado más delivery completo (pedido a domicilio con seguimiento en mapa y panel del repartidor), zonas de reparto y supervisión con el panel de Gerente.',
    updated_at  = now()
 WHERE slug = 'full';

COMMIT;

-- Recargar el cache de esquema de PostgREST (nueva columna plan_config visible).
NOTIFY pgrst, 'reload schema';

SELECT 'migration 153 applied — marketing_plans.plan_config (public capability mirror) + descriptions/names seeded' AS status;
