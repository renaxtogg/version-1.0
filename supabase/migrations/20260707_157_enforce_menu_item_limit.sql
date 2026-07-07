-- ════════════════════════════════════════════════════════════════════
-- 157 · Fix del límite de ÍTEMS por plan — resolver la suscripción ACTIVA (M10)
-- ════════════════════════════════════════════════════════════════════
-- La función enforce_menu_item_limit + su trigger trg_enforce_menu_item_limit
-- (BEFORE INSERT en menu_items) YA existen y están cableados en prod, pero
-- NO bloqueaban (bug M10 / QA 2026-07-07: se cargaron 35 ítems sobre un tope
-- de 30). Causa raíz, confirmada leyendo la función VIVA (no las migraciones):
--
--   resolvía el plan con
--       WHERE s.restaurant_id = NEW.restaurant_id
--       ORDER BY s.created_at DESC LIMIT 1
--   → "la última suscripción por fecha", SIN filtrar por estado. Los cambios
--     de plan dejan filas de suscripción nuevas; si la más reciente NO es la
--     vigente y su plan tiene max_menu_items NULL, v_limit quedaba NULL →
--     RETURN NEW → nunca enforceaba.
--
-- El trigger de MESAS que SÍ funciona en prod (fn_enforce_table_limit, ver
-- migración 159) resuelve con  AND s.status = 'active'. Este fix alinea ítems
-- a ESE patrón real: agrega el filtro s.status='active'. Con eso ítems resuelve
-- la MISMA suscripción que mesas → si mesas bloquea, ítems bloquea idéntico.
--
-- CREATE OR REPLACE de la función que ya vive (mismo nombre, mismo trigger):
-- no duplica ni deja huérfanos; sólo corrige el cuerpo. Idempotente; no toca
-- filas existentes. Re-declara el trigger para que la migración sea
-- autocontenida en una DB fresca.
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.enforce_menu_item_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_limit INT;
  v_count INT;
BEGIN
  IF NEW.restaurant_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Plan vigente: la última suscripción ACTIVA del local (mismo criterio que
  -- fn_enforce_table_limit — mig 159). El filtro s.status='active' es
  -- LOAD-BEARING: sin él, "la última por created_at" podía caer en un plan con
  -- max_menu_items NULL → v_limit NULL → no enforceaba (bug M10).
  SELECT sp.max_menu_items
    INTO v_limit
    FROM public.subscriptions s
    JOIN public.subscription_plans sp ON sp.id = s.plan_id
   WHERE s.restaurant_id = NEW.restaurant_id AND s.status = 'active'
   ORDER BY s.created_at DESC
   LIMIT 1;

  IF v_limit IS NULL THEN
    RETURN NEW;   -- sin plan activo con tope → ilimitado (igual criterio que mesas)
  END IF;

  SELECT COUNT(*) INTO v_count
    FROM public.menu_items
   WHERE restaurant_id = NEW.restaurant_id;

  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'Alcanzaste el máximo de ítems de tu plan (%). Ampliá tu plan para cargar más productos.', v_limit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_menu_item_limit ON public.menu_items;
CREATE TRIGGER trg_enforce_menu_item_limit
  BEFORE INSERT ON public.menu_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_menu_item_limit();
