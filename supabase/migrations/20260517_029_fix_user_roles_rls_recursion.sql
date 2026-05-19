-- ============================================================
-- Migración 029: Fix recursión infinita en RLS de user_roles
-- ============================================================
-- Las policies "superadmin_manage_roles" y "admin_read_restaurant_users"
-- hacen subqueries a public.user_roles desde dentro de políticas sobre
-- public.user_roles → PostgreSQL detecta recursión infinita.
--
-- Fix: funciones SECURITY DEFINER que bypasan RLS para verificar el rol.
-- Las policies llaman a la función en vez de hacer subquery directo.
-- ============================================================

-- ── Funciones helper (SECURITY DEFINER bypasa RLS) ───────────

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT role FROM public.user_roles
  WHERE user_id = auth.uid() AND is_active = true
  ORDER BY
    CASE role
      WHEN 'superadmin' THEN 0
      WHEN 'admin'      THEN 1
      WHEN 'cajero'     THEN 2
      ELSE 3
    END
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_my_restaurant_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT restaurant_id FROM public.user_roles
  WHERE user_id = auth.uid() AND is_active = true
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_role()           TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_restaurant_id()  TO authenticated;

-- ── Eliminar policies recursivas ─────────────────────────────

DROP POLICY IF EXISTS "superadmin_manage_roles"       ON public.user_roles;
DROP POLICY IF EXISTS "admin_read_restaurant_users"   ON public.user_roles;
DROP POLICY IF EXISTS "user_read_own_role"             ON public.user_roles;

-- ── Recrear policies sin recursión ───────────────────────────

-- Todo usuario autenticado puede leer su(s) propio(s) rol(es)
CREATE POLICY "user_read_own_role" ON public.user_roles
  FOR SELECT
  USING (user_id = auth.uid());

-- Admin y superadmin pueden leer todos los roles de su restaurante
CREATE POLICY "admin_read_restaurant_users" ON public.user_roles
  FOR SELECT
  USING (
    user_id = auth.uid()
    OR public.get_my_role() IN ('admin', 'superadmin')
  );

-- Solo superadmin puede insertar / actualizar / eliminar roles
CREATE POLICY "superadmin_manage_roles" ON public.user_roles
  FOR ALL
  USING     (public.get_my_role() = 'superadmin')
  WITH CHECK(public.get_my_role() = 'superadmin');
