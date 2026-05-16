-- ============================================================
-- Migración 023: Admin Panel Fixes
-- 2026-05-16
-- - Tabla expenses (egresos/gastos) para Finanzas
-- - Política RLS: admins pueden leer user_roles de su restaurante
-- - Función admin_list_restaurant_users para PersonalPage
-- ============================================================

-- ── 1. Tabla expenses (reemplaza localStorage en Finanzas) ─────
CREATE TABLE IF NOT EXISTS public.expenses (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID        NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  date          DATE        NOT NULL DEFAULT CURRENT_DATE,
  category      TEXT        NOT NULL DEFAULT 'Otro',
  description   TEXT        NOT NULL,
  amount        INTEGER     NOT NULL CHECK (amount > 0),
  payment_method TEXT       DEFAULT 'efectivo',
  supplier      TEXT,
  notes         TEXT,
  created_by    UUID        REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_restaurant ON public.expenses(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date       ON public.expenses(date);

ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='expenses_all' AND tablename='expenses') THEN
    CREATE POLICY "expenses_all" ON public.expenses FOR ALL USING (true) WITH CHECK (true);
  END IF;
END$$;

-- Realtime para expenses
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.expenses;
EXCEPTION WHEN others THEN NULL;
END$$;

-- ── 2. RLS: admin puede leer user_roles de su restaurante ──────
-- Los admins (no superadmin) no podían listar el personal de su restaurante.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'admin_read_restaurant_users' AND tablename = 'user_roles'
  ) THEN
    CREATE POLICY "admin_read_restaurant_users" ON public.user_roles
      FOR SELECT
      USING (
        -- El usuario puede ver su propio rol
        user_id = auth.uid()
        OR
        -- O es admin/superadmin del mismo restaurante
        EXISTS (
          SELECT 1 FROM public.user_roles me
          WHERE me.user_id = auth.uid()
            AND me.is_active = true
            AND me.role IN ('admin', 'superadmin')
            AND (me.restaurant_id = user_roles.restaurant_id OR me.role = 'superadmin')
        )
      );
  END IF;
END$$;

-- ── 3. Función: listar usuarios de un restaurante ─────────────
-- Usada por PersonalPage (admin panel) para mostrar el personal.
-- SECURITY DEFINER bypassa RLS para garantizar acceso.
CREATE OR REPLACE FUNCTION public.admin_list_restaurant_users(p_restaurant_id UUID)
RETURNS TABLE (
  id            UUID,
  user_id       UUID,
  email         TEXT,
  username      TEXT,
  display_name  TEXT,
  role          TEXT,
  is_active     BOOLEAN,
  created_at    TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Solo admins o superadmins pueden listar usuarios
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND is_active = true
      AND role IN ('admin', 'superadmin')
  ) THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  RETURN QUERY
  SELECT ur.id, ur.user_id, ur.email, ur.username, ur.display_name,
         ur.role, ur.is_active, ur.created_at
  FROM public.user_roles ur
  WHERE ur.restaurant_id = p_restaurant_id
  ORDER BY ur.created_at DESC;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_list_restaurant_users TO authenticated;

-- ── 4. Función: admin actualiza rol de usuario ─────────────────
CREATE OR REPLACE FUNCTION public.admin_update_user_role(
  p_user_role_id UUID,
  p_role         TEXT,
  p_is_active    BOOLEAN DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND is_active = true
      AND role IN ('admin', 'superadmin')
  ) THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  UPDATE public.user_roles
  SET role      = COALESCE(NULLIF(p_role,''), role),
      is_active = COALESCE(p_is_active, is_active)
  WHERE id = p_user_role_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_update_user_role TO authenticated;

-- ── 5. Columna email en user_roles (si faltara) ───────────────
ALTER TABLE public.user_roles ADD COLUMN IF NOT EXISTS email TEXT;
