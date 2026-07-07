-- ════════════════════════════════════════════════════════════════════
-- 159 · Trackear el trigger de límite de MESAS que ya vive en prod (anti-drift)
-- ════════════════════════════════════════════════════════════════════
-- fn_enforce_table_limit / trg_enforce_table_limit están APLICADOS en prod y
-- funcionan (probado: el INSERT de la mesa nº6 rebota con "Límite de mesas del
-- plan alcanzado"), pero se aplicaron a mano desde _simulacion/APLICAR_limite_plan.sql
-- durante el simulacro y NUNCA quedaron en una migración → drift: el repo no lo
-- reflejaba. Esta migración lo codifica para poner el control de versiones en
-- sync con la base.
--
-- Es la definición VIVA VERBATIM (obtenida con pg_get_functiondef sobre prod),
-- vía CREATE OR REPLACE + trigger idempotente: aplicarla sobre prod es un no-op
-- (no cambia comportamiento); en una DB fresca crea el control tal como existe.
--
-- Nota: a diferencia de enforce_menu_item_limit (mig 157), esta función NO fija
-- SET search_path. Se preserva tal cual está en prod (captura fiel). Unificar el
-- criterio (agregarle search_path a mesas) queda como hardening opcional aparte.
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_enforce_table_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE v_max int; v_cnt int;
BEGIN
  SELECT sp.max_tables INTO v_max
  FROM public.subscriptions s JOIN public.subscription_plans sp ON sp.id = s.plan_id
  WHERE s.restaurant_id = NEW.restaurant_id AND s.status = 'active'
  ORDER BY s.created_at DESC LIMIT 1;
  IF v_max IS NULL THEN RETURN NEW; END IF;            -- sin plan activo → no limita
  SELECT count(*) INTO v_cnt FROM public.tables WHERE restaurant_id = NEW.restaurant_id;
  IF v_cnt >= v_max THEN
    RAISE EXCEPTION 'Límite de mesas del plan alcanzado (% mesas).', v_max
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_table_limit ON public.tables;
CREATE TRIGGER trg_enforce_table_limit
  BEFORE INSERT ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_table_limit();
