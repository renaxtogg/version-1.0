-- ════════════════════════════════════════════════════════════════════
-- 122 · get_my_subscription(p_restaurant_id) — lectura tenant-safe de la
--       suscripción del restaurante para el panel Admin (dueño).
-- ────────────────────────────────────────────────────────────────────
-- Causa: `subscriptions` tiene RLS superadmin-only (mig 103: sa_subs_all =
-- get_my_role()='superadmin'), así que el rol admin/dueño NO puede leer su
-- propia suscripción para el widget "Estado de suscripción" del dashboard.
--
-- Esta RPC SECURITY DEFINER expone SOLO la fila del propio restaurante, con
-- el MISMO guard tenant-safe de la mig 108 (fail-closed):
--   • superadmin: cualquier restaurante.
--   • autenticado: solo restaurantes de su cuenta corporativa.
--   • anon / sin rol / cross-tenant → NULL.
-- NO relaja RLS, NO usa USING(true), NO escribe, NO toca pricing/planes.
--
-- ⚠ PREPARED — NOT APPLIED: aplicar manualmente en el SQL Editor (en INGLÉS)
-- tras backup nuevo; Claude Code NO aplica migraciones. Hasta aplicarla, el
-- widget muestra el estado vacío "Sin suscripción activa registrada".
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_my_subscription(p_restaurant_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  -- Guard tenant-safe (mismo patrón que mig 108): fail-closed.
  IF NOT COALESCE(
       public.get_my_role() = 'superadmin'
       OR p_restaurant_id IN (SELECT public.get_my_company_restaurant_ids()),
       false)
  THEN
    RETURN NULL;
  END IF;

  SELECT s.status, s.start_date, s.end_date, s.auto_renew, sp.name AS plan_name
    INTO r
    FROM public.subscriptions s
    JOIN public.subscription_plans sp ON sp.id = s.plan_id
   WHERE s.restaurant_id = p_restaurant_id
   ORDER BY s.created_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'plan_name',      r.plan_name,
    'status',         r.status,
    'start_date',     r.start_date,
    'end_date',       r.end_date,
    'auto_renew',     r.auto_renew,
    'days_remaining', (r.end_date - CURRENT_DATE)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_subscription(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
