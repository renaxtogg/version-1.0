-- ════════════════════════════════════════════════════════════════════
-- 126 · cajas · MULTI-CAJA por restaurante (Fase 1: DB + CRUD admin + gating)
-- ────────────────────────────────────────────────────────────────────
-- Hoy un restaurante tiene una sola caja implícita (turnos_caja sin
-- referencia a una "caja" física). Esta migración introduce la tabla
-- `cajas` para que un local pueda tener varias cajas (POS) y, en Fase 2,
-- el cajero elija con cuál abre turno y se hagan arqueos/reportes por caja.
--
-- FASE 1 (este cambio): tabla `cajas`, FK opcional turnos_caja.caja_id,
-- límite por plan (subscription_plans.max_cajas) + override del superadmin
-- (restaurants.extra_cajas), backfill de "Caja Principal" para los locales
-- existentes y una RPC tenant-safe para leer el límite efectivo en el admin.
-- NO toca el panel caja ni los cobros (eso es Fase 2).
--
--   Límite efectivo de cajas activas:
--     · subscription_plans.max_cajas IS NULL          → ILIMITADO
--     · si no, max_cajas + COALESCE(restaurants.extra_cajas, 0)
--   Seed: Starter=1, Pro=2, Enterprise=NULL (ilimitado). Ajustables.
--
-- 100% ADITIVA + IDEMPOTENTE. anon SIN acceso a `cajas` (RLS deny + sin
-- GRANT). Escritura de `cajas` sólo admin (o superadmin) del restaurante;
-- lectura para cualquier usuario activo del local (el cajero la necesita
-- en Fase 2). Mismo aislamiento por restaurante que turnos_caja.
--
-- ⚠ PREPARED — aplicar manualmente en el SQL Editor (en INGLÉS) tras backup;
--   Claude Code NO aplica migraciones.
-- ════════════════════════════════════════════════════════════════════

-- ─── 1. Tabla cajas ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cajas (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  nombre        TEXT NOT NULL,
  activa        BOOLEAN NOT NULL DEFAULT true,
  sort_order    INT NOT NULL DEFAULT 0,
  zona          TEXT,                       -- opcional, agrupar por área ("Terraza") — uso futuro
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cajas_restaurant ON public.cajas(restaurant_id, sort_order);

-- ─── 2. turnos_caja.caja_id (nullable, compatibilidad) ───────────────
ALTER TABLE public.turnos_caja
  ADD COLUMN IF NOT EXISTS caja_id UUID REFERENCES public.cajas(id);
CREATE INDEX IF NOT EXISTS idx_turnos_caja_caja ON public.turnos_caja(caja_id);

-- ─── 3. Límite por plan + override del superadmin ────────────────────
ALTER TABLE public.subscription_plans
  ADD COLUMN IF NOT EXISTS max_cajas INT;          -- NULL = sin tope (ilimitado)
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS extra_cajas INT NOT NULL DEFAULT 0;   -- cajas extra vendidas sin cambiar de plan

-- Seed de límites por plan (ajustables). Solo planes canónicos; el resto
-- queda NULL = ilimitado. Guardado con `max_cajas IS NULL` para que sea
-- una SIEMBRA (no un re-asentamiento destructivo): si el superadmin ajusta
-- un límite después, una re-ejecución de la migración NO lo pisa.
UPDATE public.subscription_plans SET max_cajas = 1
  WHERE id = '10000000-0000-0000-0000-000000000001' AND max_cajas IS NULL;   -- Starter
UPDATE public.subscription_plans SET max_cajas = 2
  WHERE id = '10000000-0000-0000-0000-000000000002' AND max_cajas IS NULL;   -- Pro
-- Enterprise: ilimitado = max_cajas NULL (default tras ADD COLUMN). Sin UPDATE.

-- ─── 4. Backfill: "Caja Principal" para locales con datos de caja ────
-- Por cada restaurante que ya tiene turnos, creamos una caja activa si no
-- tiene ninguna; luego asignamos sus turnos huérfanos a esa caja.
INSERT INTO public.cajas (restaurant_id, nombre, activa, sort_order)
SELECT DISTINCT t.restaurant_id, 'Caja Principal', true, 0
  FROM public.turnos_caja t
 WHERE NOT EXISTS (SELECT 1 FROM public.cajas c WHERE c.restaurant_id = t.restaurant_id);

UPDATE public.turnos_caja t
   SET caja_id = sub.id
  FROM (
    SELECT DISTINCT ON (restaurant_id) restaurant_id, id
      FROM public.cajas
     ORDER BY restaurant_id, sort_order, created_at
  ) sub
 WHERE sub.restaurant_id = t.restaurant_id
   AND t.caja_id IS NULL;

-- ─── 5. RLS ──────────────────────────────────────────────────────────
-- anon: sin GRANT y sin policy → acceso denegado por completo.
ALTER TABLE public.cajas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cajas FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cajas TO authenticated;

DROP POLICY IF EXISTS cajas_select ON public.cajas;
DROP POLICY IF EXISTS cajas_write  ON public.cajas;

-- SELECT: cualquier usuario activo del restaurante (el cajero las lista en Fase 2).
CREATE POLICY cajas_select ON public.cajas
  FOR SELECT USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id = (
      SELECT restaurant_id FROM public.user_roles
       WHERE user_id = auth.uid() AND is_active = true LIMIT 1
    )
  );

-- INSERT/UPDATE/DELETE: sólo admin del restaurante (o superadmin global).
CREATE POLICY cajas_write ON public.cajas
  FOR ALL USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id = (
      SELECT restaurant_id FROM public.user_roles
       WHERE user_id = auth.uid() AND is_active = true AND role = 'admin' LIMIT 1
    )
  ) WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id = (
      SELECT restaurant_id FROM public.user_roles
       WHERE user_id = auth.uid() AND is_active = true AND role = 'admin' LIMIT 1
    )
  );

-- ─── 6. RPC tenant-safe: límite efectivo de cajas para el admin ──────
-- El rol admin no puede leer `subscriptions` directo (mig 103), así que
-- exponemos el límite efectivo y el conteo activo con el mismo guard
-- fail-closed de las migs 108/122.
CREATE OR REPLACE FUNCTION public.get_my_caja_limit(p_restaurant_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max    INT;
  v_extra  INT;
  v_eff    INT;
  v_active INT;
BEGIN
  -- Guard tenant-safe (fail-closed): superadmin global; el resto su cuenta.
  IF NOT COALESCE(
       public.get_my_role() = 'superadmin'
       OR p_restaurant_id IN (SELECT public.get_my_company_restaurant_ids()),
       false)
  THEN
    RETURN NULL;
  END IF;

  SELECT sp.max_cajas
    INTO v_max
    FROM public.subscriptions s
    JOIN public.subscription_plans sp ON sp.id = s.plan_id
   WHERE s.restaurant_id = p_restaurant_id
   ORDER BY s.created_at DESC
   LIMIT 1;

  SELECT COALESCE(r.extra_cajas, 0) INTO v_extra
    FROM public.restaurants r WHERE r.id = p_restaurant_id;

  SELECT COUNT(*) INTO v_active
    FROM public.cajas c
   WHERE c.restaurant_id = p_restaurant_id AND c.activa = true;

  -- max_cajas NULL (sin plan, o plan sin tope) → ilimitado.
  IF v_max IS NULL THEN
    v_eff := NULL;
  ELSE
    v_eff := v_max + COALESCE(v_extra, 0);
  END IF;

  RETURN jsonb_build_object(
    'max_cajas',       v_max,                 -- NULL = ilimitado
    'extra_cajas',     COALESCE(v_extra, 0),
    'effective_limit', v_eff,                 -- NULL = ilimitado
    'active_count',    COALESCE(v_active, 0)
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_my_caja_limit(UUID) TO authenticated;

-- ─── 7. Trigger backstop: límite de cajas activas por plan ───────────
-- Respaldo server-side (mismo espíritu que enforce_role_user_limit, mig 090):
-- aunque la UI falle o alguien llame al REST directo, la DB rechaza activar
-- una caja por encima del límite efectivo del plan. Permisivo cuando el plan
-- no tiene tope (max_cajas NULL) o no hay suscripción. Sólo evalúa filas que
-- quedan ACTIVAS; renombrar una caja ya activa no cuenta.
CREATE OR REPLACE FUNCTION public.enforce_caja_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max   INT;
  v_extra INT;
  v_limit INT;
  v_count INT;
BEGIN
  -- Sólo importa si la fila resultante queda activa.
  IF COALESCE(NEW.activa, true) = false THEN
    RETURN NEW;
  END IF;
  -- En UPDATE, si ya estaba activa y sigue activa, el conteo no cambia.
  IF TG_OP = 'UPDATE' AND COALESCE(OLD.activa, false) = true THEN
    RETURN NEW;
  END IF;

  SELECT sp.max_cajas
    INTO v_max
    FROM public.subscriptions s
    JOIN public.subscription_plans sp ON sp.id = s.plan_id
   WHERE s.restaurant_id = NEW.restaurant_id
   ORDER BY s.created_at DESC
   LIMIT 1;

  IF v_max IS NULL THEN
    RETURN NEW;   -- sin plan o plan sin tope → ilimitado
  END IF;

  SELECT COALESCE(r.extra_cajas, 0) INTO v_extra
    FROM public.restaurants r WHERE r.id = NEW.restaurant_id;

  v_limit := v_max + COALESCE(v_extra, 0);

  SELECT COUNT(*) INTO v_count
    FROM public.cajas
   WHERE restaurant_id = NEW.restaurant_id
     AND activa = true
     AND id <> NEW.id;   -- excluir la propia fila (UPDATE)

  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'Límite de cajas alcanzado para el plan actual (máx %)', v_limit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_caja_limit ON public.cajas;
CREATE TRIGGER trg_enforce_caja_limit
  BEFORE INSERT OR UPDATE ON public.cajas
  FOR EACH ROW EXECUTE FUNCTION public.enforce_caja_limit();

NOTIFY pgrst, 'reload schema';
