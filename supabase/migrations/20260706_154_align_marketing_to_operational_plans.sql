-- ════════════════════════════════════════════════════════════════════
-- 154 · ALINEAR LA VIDRIERA (marketing_plans) A LOS PLANES OPERATIVOS
-- ────────────────────────────────────────────────────────────────────
-- El sitio comercial (/precios + calculadora) lee marketing_plans. Hoy está
-- desalineado del catálogo operativo real (subscription_plans):
--   operativo:  Emprendedor ₲150.000 · Consolidado ₲300.000 · Premium ₲500.000
--   vidriera:   Carta ₲200.000 · Servicio ₲400.000 · Full ₲800.000 (inactivo)
-- Esta migración deja la vidriera reflejando el operativo, SIN cambiar los slugs
-- (claves estables que consumen la web y el mapeo de billing):
--   carta→Emprendedor 150.000 · servicio→Consolidado 300.000 (Recomendado) ·
--   full→Premium 500.000 (se ACTIVA) · enterprise→"A cotizar" (sin precio).
-- Cada plan de precio se VINCULA (subscription_plan_id) a su plan operativo por
-- nombre, para que el precio siga sincronizado (trigger mig 119) y la lista
-- "incluye" del sitio se genere desde la config real (plan_config, mig 153).
--
-- AUTOSUFICIENTE: reincluye idempotentemente la infra de plan_config (mig 153)
-- para poder aplicarse aunque la 153 no haya corrido. 100% aditiva, sin tocar
-- RLS ni slugs ni subscription_plans. IDEMPOTENTE (reejecutable).
-- Aplicar en SQL Editor (INGLÉS), rol postgres, tras backup.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 0) Infra de espejo de config (idempotente; ya en mig 153) ─────────
ALTER TABLE public.marketing_plans
  ADD COLUMN IF NOT EXISTS plan_config jsonb;

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
  FOR EACH ROW EXECUTE FUNCTION public.sync_marketing_plan_config();

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
  FOR EACH ROW EXECUTE FUNCTION public.mkt_pull_plan_config();

-- ── 1) Vincular cada plan de vidriera a su plan operativo (por nombre) ─
--    COALESCE preserva el vínculo existente si no se encuentra el operativo
--    (no lo desvincula). Tolerante a mayúsculas/espacios. Al setear la FK, el
--    trigger BEFORE (mkt_pull_plan_config) rellena plan_config automáticamente.
UPDATE public.marketing_plans mp
   SET subscription_plan_id = COALESCE(
        (SELECT sp.id FROM public.subscription_plans sp
          WHERE lower(btrim(sp.name)) = 'emprendedor'
          ORDER BY sp.is_active DESC NULLS LAST, sp.price_usd NULLS LAST LIMIT 1),
        mp.subscription_plan_id),
       updated_at = now()
 WHERE mp.slug = 'carta';

UPDATE public.marketing_plans mp
   SET subscription_plan_id = COALESCE(
        (SELECT sp.id FROM public.subscription_plans sp
          WHERE lower(btrim(sp.name)) = 'consolidado'
          ORDER BY sp.is_active DESC NULLS LAST, sp.price_usd NULLS LAST LIMIT 1),
        mp.subscription_plan_id),
       updated_at = now()
 WHERE mp.slug = 'servicio';

UPDATE public.marketing_plans mp
   SET subscription_plan_id = COALESCE(
        (SELECT sp.id FROM public.subscription_plans sp
          WHERE lower(btrim(sp.name)) = 'premium'
          ORDER BY sp.is_active DESC NULLS LAST, sp.price_usd NULLS LAST LIMIT 1),
        mp.subscription_plan_id),
       updated_at = now()
 WHERE mp.slug = 'full';

-- ── 2) Alinear nombre / precio / estado / descripción (por slug) ──────
UPDATE public.marketing_plans SET
    name             = 'Emprendedor',
    price_monthly_gs = 150000,
    price_annual_gs  = 1500000,
    is_active        = true,
    is_recommended   = false,
    is_enterprise    = false,
    badge            = NULL,
    description      = 'Tu carta, en digital. Da el primer paso: menú digital con QR, sin papel y actualizable al instante, más el panel de gestión para cargar tu carta, ver pedidos y controlar tus insumos.',
    updated_at       = now()
 WHERE slug = 'carta';

UPDATE public.marketing_plans SET
    name             = 'Consolidado',
    price_monthly_gs = 300000,
    price_annual_gs  = 3000000,
    is_active        = true,
    is_recommended   = true,
    is_enterprise    = false,
    badge            = 'Recomendado',
    description      = 'Operá todo tu salón. Todo lo de Emprendedor más el sistema completo en tiempo real: caja, mozos y pantalla de cocina conectados, y CRM para conocer a tus clientes.',
    updated_at       = now()
 WHERE slug = 'servicio';

UPDATE public.marketing_plans SET
    name             = 'Premium',
    price_monthly_gs = 500000,
    price_annual_gs  = 5000000,
    is_active        = true,
    is_recommended   = false,
    is_enterprise    = false,
    badge            = NULL,
    description      = 'Sumá delivery y escalá. Todo lo de Consolidado más delivery completo (pedido a domicilio con seguimiento en mapa y panel del repartidor), zonas de reparto y supervisión con el panel de Gerente.',
    updated_at       = now()
 WHERE slug = 'full';

UPDATE public.marketing_plans SET
    name             = 'A medida',
    price_monthly_gs = NULL,
    price_annual_gs  = NULL,
    is_active        = true,
    is_recommended   = false,
    is_enterprise    = true,
    badge            = NULL,
    description      = '¿Necesitás algo a medida? Para cadenas o negocios con necesidades especiales: desarrollamos y adaptamos lo que tu operación pida — módulos a medida, integraciones, multi-sucursal y más.',
    updated_at       = now()
 WHERE slug = 'enterprise';

-- ── 3) Refrescar plan_config desde el plan vinculado (belt-and-suspenders) ──
UPDATE public.marketing_plans mp
   SET plan_config = public.mkt_build_plan_config(sp),
       updated_at  = now()
  FROM public.subscription_plans sp
 WHERE mp.subscription_plan_id = sp.id;

COMMIT;

-- Recargar el cache de esquema de PostgREST.
NOTIFY pgrst, 'reload schema';

SELECT slug, name, price_monthly_gs, is_active, is_enterprise,
       (subscription_plan_id IS NOT NULL) AS linked,
       (plan_config IS NOT NULL)          AS has_config
  FROM public.marketing_plans
 ORDER BY sort_order;
