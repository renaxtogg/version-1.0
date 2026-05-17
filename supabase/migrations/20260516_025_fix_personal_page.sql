-- ============================================================
-- Migración 025: Fix Personal Page — admin_list_restaurant_users
-- 2026-05-16
-- Problema: la función lanzaba excepción 'No autorizado' en vez de
-- retornar vacío, rompiendo la cascada de fallbacks del frontend.
-- También: incluye superadmins sin restaurant_id en los resultados.
-- ============================================================

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
  -- Si no es admin/superadmin, retornar vacío (no lanzar excepción)
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND is_active = true
      AND role IN ('admin', 'superadmin')
  ) THEN
    RETURN;
  END IF;

  -- Superadmins (sin restaurant_id) ven a todos los usuarios del restaurante
  -- Admins normales también ven a todos los de su restaurante
  RETURN QUERY
  SELECT ur.id, ur.user_id, ur.email, ur.username, ur.display_name,
         ur.role, ur.is_active, ur.created_at
  FROM public.user_roles ur
  WHERE ur.restaurant_id = p_restaurant_id
     OR (ur.user_id = auth.uid() AND ur.role = 'superadmin')
  ORDER BY ur.created_at DESC;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_list_restaurant_users TO authenticated;
