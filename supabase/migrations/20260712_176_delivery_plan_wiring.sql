-- ════════════════════════════════════════════════════════════════════
-- 176 · Cablear "Emprendedor Delivery": corte por facturación + modo automático
--       (PREPARED — NOT APPLIED: aplicar manualmente tras backup nuevo,
--        Supabase SQL Editor en INGLÉS, rol postgres. Claude Code NO la aplica.)
--       ORDEN: aplicar DESPUÉS de la 173 (columna service_mode + función) y de
--       la 175 (el plan). En orden numérico normal ya queda bien.
-- ────────────────────────────────────────────────────────────────────
-- OBJETIVO (Renato, 2026-07-12 — "que todo funcione y esté bien conectado"):
-- cerrar los dos huecos que dejaba asignar el plan "Emprendedor Delivery"
-- (mig 175) sin pasos manuales frágiles:
--
--   A) CORTE POR FACTURACIÓN — restaurant_panel_enabled (la RPC anon que gatea el
--      panel público delivery-cliente) resolvía el plan por la sub MÁS NUEVA SIN
--      filtrar status, y su rama service_mode='delivery' devolvía true SIN mirar
--      ninguna suscripción. Resultado: una sub CANCELADA/SUSPENDIDA (o un trial
--      vencido) seguía sirviendo la página pública de pedidos. Acá se le agrega la
--      regla habilitante canónica (mig 163: active/past_due, o trial no vencido)
--      en AMBOS caminos. Se inlinea la regla a propósito (NO se llama a
--      resolve_entitled_plan_id) para que la migración sea autosuficiente y no
--      dependa de —ni arriesgue revertir— ese helper (160/163 pueden no estar
--      aplicadas). Fail-closed: sin sub habilitante ⇒ el panel público no sirve.
--
--   B) MODO AUTOMÁTICO — asignar el plan ya NO exige acordarse de poner el local
--      en "Delivery" a mano (Superadmin→Módulos, mig 173). Un trigger deriva
--      restaurants.service_mode del plan vigente:
--        · plan "delivery lite" (incluye delivery-cliente y NINGÚN panel de salón)
--          → service_mode='delivery' (bloquea Menú QR + mesas).
--        · plan CON salón (caja/mozo/cocina) → service_mode='salon', pero SOLO ante
--          un cambio REAL de plan (upgrade Delivery→Consolidado/Premium, para no
--          dejar el QR bloqueado); NUNCA en una renovación/reactivación (status) →
--          así un toggle delivery deliberado (mig 173) sobre un plan con salón NO
--          se pisa al facturar.
--        · plan sin salón y sin delivery-cliente (Emprendedor salón "puro",
--          allowed_panels=[]) → NO se toca → respeta el toggle manual de la 173.
--
-- ALCANCE: aditivo/correctivo. CREATE OR REPLACE de UNA función existente
-- (restaurant_panel_enabled, misma firma/grants) + 1 función trigger NUEVA + 1
-- trigger NUEVO sobre subscriptions + backfill idempotente. NO toca RLS, ni otras
-- funciones de gating (get_restaurant_capabilities/is_panel_enabled/helpers siguen
-- como los dejan 155/160/163). Idempotente / re-ejecutable.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ── A) restaurant_panel_enabled con corte por facturación ─────────────────────
--    VERBATIM de la mig 173 con DOS cambios: (1) la rama service_mode='delivery'
--    exige ahora una sub habilitante; (2) el SELECT de allowed_panels filtra por
--    status habilitante. El resto (add-ons, fail-closed, firma, grants) idéntico.
CREATE OR REPLACE FUNCTION public.restaurant_panel_enabled(p_restaurant_id uuid, p_panel text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_panels   jsonb;
  v_addon    boolean;
  v_mode     text;
  v_entitled boolean;
BEGIN
  IF p_restaurant_id IS NULL OR p_panel IS NULL OR p_panel = '' THEN
    RETURN false;
  END IF;

  -- ¿El restaurante tiene una suscripción HABILITANTE? (regla canónica mig 163:
  -- active/past_due, o trial no vencido). Inline a propósito (autosuficiencia).
  v_entitled := EXISTS (
    SELECT 1 FROM public.subscriptions s
     WHERE s.restaurant_id = p_restaurant_id
       AND ( s.status IN ('active','past_due')
             OR (s.status = 'trial' AND s.end_date >= CURRENT_DATE) )
  );

  -- Rama service_mode (mig 173): en modo delivery se desbloquea delivery-cliente
  -- sin depender del plan — PERO sólo con suscripción habilitante (cierra el corte
  -- por facturación: una sub cancelada ya no sirve la página pública de delivery).
  IF p_panel = 'delivery-cliente' THEN
    SELECT r.service_mode INTO v_mode
      FROM public.restaurants r WHERE r.id = p_restaurant_id;
    IF v_mode = 'delivery' AND v_entitled THEN
      RETURN true;
    END IF;
  END IF;

  -- allowed_panels del plan de la sub MÁS NUEVA HABILITANTE (antes: sin filtrar
  -- status ⇒ una sub cancelada/vencida seguía habilitando paneles).
  SELECT sp.allowed_panels
    INTO v_panels
    FROM public.subscriptions s
    JOIN public.subscription_plans sp ON sp.id = s.plan_id
   WHERE s.restaurant_id = p_restaurant_id
     AND ( s.status IN ('active','past_due')
           OR (s.status = 'trial' AND s.end_date >= CURRENT_DATE) )
   ORDER BY s.created_at DESC
   LIMIT 1;

  IF v_panels IS NOT NULL AND (v_panels ? p_panel) THEN
    RETURN true;
  END IF;

  -- O habilitado vía add-on contratado y activo (idéntico a 090/108/173).
  SELECT EXISTS (
    SELECT 1
      FROM public.restaurant_addons ra
      JOIN public.plan_addons pa ON pa.key = ra.addon_key
     WHERE ra.restaurant_id = p_restaurant_id
       AND ra.enabled = true
       AND pa.panel = p_panel
  ) INTO v_addon;

  RETURN COALESCE(v_addon, false);   -- fail-closed por defecto
END;
$$;

GRANT EXECUTE ON FUNCTION public.restaurant_panel_enabled(uuid, text) TO anon, authenticated;

-- ── B) Trigger: derivar restaurants.service_mode del plan vigente ─────────────
--    Se recomputa SIEMPRE desde la sub más nueva habilitante (no se confía en NEW)
--    para manejar bien múltiples subs. SECURITY DEFINER: actualiza restaurants
--    aunque el INSERT/UPDATE de la sub venga de superadmin (authenticated) o del
--    alta (service_role) — la RLS de restaurants no aplica al dueño postgres.
CREATE OR REPLACE FUNCTION public.sync_service_mode_from_plan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_panels       jsonb;
  -- ¿Cambió REALMENTE el plan? (alta = INSERT, o cambio de plan_id). Un mero
  -- renew/reactivar toca solo status → NO cuenta como cambio de plan.
  v_plan_changed boolean := (TG_OP = 'INSERT') OR (NEW.plan_id IS DISTINCT FROM OLD.plan_id);
BEGIN
  SELECT sp.allowed_panels
    INTO v_panels
    FROM public.subscriptions s
    JOIN public.subscription_plans sp ON sp.id = s.plan_id
   WHERE s.restaurant_id = NEW.restaurant_id
     AND ( s.status IN ('active','past_due')
           OR (s.status = 'trial' AND s.end_date >= CURRENT_DATE) )
   ORDER BY s.created_at DESC
   LIMIT 1;

  IF v_panels IS NULL THEN
    RETURN NEW;   -- sin plan habilitante → no forzar modo (respeta estado actual)
  END IF;

  IF (v_panels ? 'delivery-cliente') AND NOT (v_panels ?| array['caja','mozo','cocina']) THEN
    -- "delivery lite": sin salón → modo delivery (bloquea Menú QR + mesas). Se
    -- aplica SIEMPRE (alta o reactivación): un plan sólo-delivery no tiene salón
    -- que preservar, así que alinear a 'delivery' es correcto.
    UPDATE public.restaurants SET service_mode = 'delivery'
     WHERE id = NEW.restaurant_id AND service_mode IS DISTINCT FROM 'delivery';
  ELSIF (v_panels ?| array['caja','mozo','cocina']) AND v_plan_changed THEN
    -- plan CON salón → normalizar a 'salon' SOLO ante un cambio REAL de plan (p.ej.
    -- upgrade Delivery→Consolidado/Premium, para no dejar el QR bloqueado). NO en
    -- renovaciones/reactivaciones (status): así un toggle delivery DELIBERADO
    -- (mig 173) en un plan con salón sobrevive a la facturación y NO se pisa en
    -- silencio. El corte por impago lo hace restaurant_panel_enabled (parte A).
    UPDATE public.restaurants SET service_mode = 'salon'
     WHERE id = NEW.restaurant_id AND service_mode IS DISTINCT FROM 'salon';
  END IF;
  -- plan sin salón y sin delivery-cliente (Emprendedor salón puro): NO se toca →
  -- respeta el toggle manual de la mig 173.
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_service_mode_from_plan ON public.subscriptions;
CREATE TRIGGER trg_sync_service_mode_from_plan
  AFTER INSERT OR UPDATE OF plan_id, status ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.sync_service_mode_from_plan();

-- ── C) Backfill idempotente: locales cuyo plan vigente es "delivery lite" ─────
--    (hoy: ninguno — el plan es nuevo; queda por si se aplica tras asignar alguno.
--    Sólo pone 'delivery'; NUNCA resetea a 'salon' para no pisar toggles manuales.)
UPDATE public.restaurants r
   SET service_mode = 'delivery'
 WHERE service_mode IS DISTINCT FROM 'delivery'
   AND (
     SELECT (sp.allowed_panels ? 'delivery-cliente')
            AND NOT (sp.allowed_panels ?| array['caja','mozo','cocina'])
       FROM public.subscriptions s
       JOIN public.subscription_plans sp ON sp.id = s.plan_id
      WHERE s.restaurant_id = r.id
        AND ( s.status IN ('active','past_due')
              OR (s.status = 'trial' AND s.end_date >= CURRENT_DATE) )
      ORDER BY s.created_at DESC
      LIMIT 1
   ) IS TRUE;

COMMIT;

-- Recargar el cache de esquema de PostgREST.
NOTIFY pgrst, 'reload schema';

-- ── Verificación (correr aparte, como postgres/superadmin) ───────────────────
--   (a) La rama service_mode ya exige sub habilitante y el SELECT filtra status:
--     SELECT position('v_entitled' in pg_get_functiondef(oid)) > 0 AS tiene_corte
--       FROM pg_proc WHERE proname='restaurant_panel_enabled'
--        AND pronamespace='public'::regnamespace;
--   (b) El trigger existe:
--     SELECT tgname FROM pg_trigger WHERE tgname='trg_sync_service_mode_from_plan';
--   (c) Un local con sub CANCELADA de un plan con delivery-cliente ya NO sirve:
--     SELECT public.restaurant_panel_enabled('<rid>','delivery-cliente');  -- false
SELECT 'migration 176 applied — corte por facturación en delivery-cliente + service_mode automático por plan' AS status;
