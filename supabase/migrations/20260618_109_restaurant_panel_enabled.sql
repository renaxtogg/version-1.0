-- ════════════════════════════════════════════════════════════════════
-- 109 — restaurant_panel_enabled(): chequeo anon-safe de panel por plan
-- ────────────────────────────────────────────────────────────────────
-- WS1-B. Necesario para gatear el panel CLIENTE de delivery (delivery-cliente),
-- que es PÚBLICO/anónimo (sin login): el cliente lo abre con ?r=<idRest>.
--
-- Por qué una RPC nueva (y no get_restaurant_capabilities):
--   get_restaurant_capabilities es SECURITY DEFINER con guard tenant-safe
--   (mig 108) → devuelve NULL a un caller anon. Útil para los paneles de
--   staff (autenticados), pero INVÁLIDO para el panel cliente anónimo: con
--   fail-closed bloquearía el delivery de TODOS los restaurantes. anon, además,
--   NO puede leer public.subscriptions (cerrado en mig 103/104). Sin una RPC
--   dedicada no hay forma anon-safe de saber si el plan incluye el panel.
--
-- Qué expone: SOLO un boolean por (restaurant_id, panel) = "¿el plan/add-ons
--   de este restaurante habilitan este panel?". No revela PII, ni metadata de
--   tenant, ni datos del plan. Riesgo de divulgación mínimo y aceptable para
--   un panel público. Fail-closed: si no hay suscripción/plan → false.
--
-- NO toca RLS, ni allowed_features, ni planes, ni ninguna otra función.
-- Espeja la unión "plan.allowed_panels ∪ add-ons habilitados" de la mig 090/108.
--
-- ⚠️ ORDEN DE DESPLIEGUE: aplicar ESTA migración ANTES de desplegar el front
--    de WS1-B. El gate de delivery-cliente es fail-closed: si la función no
--    existe todavía, bloquea el panel para TODOS los planes. Migración primero,
--    deploy después.
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.restaurant_panel_enabled(p_restaurant_id uuid, p_panel text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_panels jsonb;
  v_addon  boolean;
BEGIN
  -- Fail-closed ante parámetros incompletos.
  IF p_restaurant_id IS NULL OR p_panel IS NULL OR p_panel = '' THEN
    RETURN false;
  END IF;

  -- allowed_panels del plan de la suscripción más reciente del restaurante.
  SELECT sp.allowed_panels
    INTO v_panels
    FROM public.subscriptions s
    JOIN public.subscription_plans sp ON sp.id = s.plan_id
   WHERE s.restaurant_id = p_restaurant_id
   ORDER BY s.created_at DESC
   LIMIT 1;

  -- jsonb `?` = ¿el string es elemento del array? (allowed_panels es array).
  IF v_panels IS NOT NULL AND (v_panels ? p_panel) THEN
    RETURN true;
  END IF;

  -- O habilitado vía add-on contratado y activo (mismo criterio que la 090/108).
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

-- anon: lo usa el panel cliente público. authenticated: por si se reusa en staff.
GRANT EXECUTE ON FUNCTION public.restaurant_panel_enabled(uuid, text) TO anon, authenticated;
