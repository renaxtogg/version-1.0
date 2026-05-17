-- ═══════════════════════════════════════════════════════════
-- MIGRACIÓN 028 — SUPERADMIN: columnas, roles, funciones, pagos
-- EJECUTAR EN SUPABASE SQL EDITOR (dashboard en inglés)
-- ═══════════════════════════════════════════════════════════

-- ─── 1. RESTAURANTS: columnas adicionales ──────────────────
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS email       TEXT,
  ADD COLUMN IF NOT EXISTS ruc         TEXT,
  ADD COLUMN IF NOT EXISTS legal_name  TEXT,
  ADD COLUMN IF NOT EXISTS currency    TEXT DEFAULT 'PYG';

-- ─── 2. SUBSCRIPTIONS: columna monthly_amount ──────────────
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS monthly_amount NUMERIC(10,2);

-- Rellenar monthly_amount con el precio del plan si está vacío
UPDATE public.subscriptions s
SET    monthly_amount = sp.price_usd
FROM   public.subscription_plans sp
WHERE  s.plan_id = sp.id
  AND  s.monthly_amount IS NULL;

-- ─── 3. USER_ROLES: ampliar roles permitidos ───────────────
-- Eliminar constraint viejo y reemplazar con uno que incluya cajero/mozo/delivery
ALTER TABLE public.user_roles
  DROP CONSTRAINT IF EXISTS user_roles_role_check;

ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_role_check
  CHECK (role IN ('cocina','admin','superadmin','cajero','mozo','delivery'));

-- ─── 4. TABLA PAYMENTS ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   UUID REFERENCES public.restaurants(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE SET NULL,
  amount          NUMERIC(10,2) NOT NULL,
  currency        TEXT DEFAULT 'USD',
  method          TEXT DEFAULT 'manual'
    CHECK (method IN ('manual','transferencia','tarjeta','efectivo','qr')),
  status          TEXT DEFAULT 'paid'
    CHECK (status IN ('paid','pending','failed','refunded')),
  paid_at         TIMESTAMPTZ DEFAULT NOW(),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sa_payments_all" ON public.payments FOR ALL USING (true) WITH CHECK (true);

-- ─── 5. FUNCIÓN admin_toggle_user ──────────────────────────
-- Eliminar TODAS las sobrecargas que existan con ese nombre
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT oid::regprocedure AS sig FROM pg_proc WHERE proname = 'admin_toggle_user' AND pronamespace = 'public'::regnamespace LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig;
  END LOOP;
END$$;
CREATE OR REPLACE FUNCTION public.admin_toggle_user(
  p_user_id UUID,
  p_active  BOOLEAN
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Solo superadmins pueden togglear usuarios
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'superadmin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'No autorizado: se requiere rol superadmin';
  END IF;

  UPDATE public.user_roles
  SET    is_active = p_active
  WHERE  user_id = p_user_id;

  RETURN json_build_object('user_id', p_user_id, 'is_active', p_active);
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_toggle_user TO authenticated;

-- ─── 6. FUNCIÓN admin_update_user_role ─────────────────────
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT oid::regprocedure AS sig FROM pg_proc WHERE proname = 'admin_update_user_role' AND pronamespace = 'public'::regnamespace LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig;
  END LOOP;
END$$;
CREATE OR REPLACE FUNCTION public.admin_update_user_role(
  p_user_id       UUID,
  p_role          TEXT,
  p_restaurant_id UUID DEFAULT NULL,
  p_display_name  TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'superadmin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  IF p_role NOT IN ('cocina','admin','superadmin','cajero','mozo','delivery') THEN
    RAISE EXCEPTION 'Rol inválido: %', p_role;
  END IF;

  UPDATE public.user_roles
  SET    role          = p_role,
         restaurant_id = p_restaurant_id,
         display_name  = COALESCE(p_display_name, display_name)
  WHERE  user_id = p_user_id;

  RETURN json_build_object('user_id', p_user_id, 'role', p_role);
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_update_user_role TO authenticated;

-- ─── 7. ÍNDICES DE PERFORMANCE ─────────────────────────────
CREATE INDEX IF NOT EXISTS idx_payments_restaurant ON public.payments(restaurant_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_subscription ON public.payments(subscription_id);
CREATE INDEX IF NOT EXISTS idx_platform_events_type ON public.platform_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON public.subscriptions(status);
