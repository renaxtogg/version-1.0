-- ============================================================
-- Migración 049: Fix constraint roles + admin_list_users
-- ============================================================
-- Problema 1: user_roles_role_check no incluye supervisor_local ni rider
-- Problema 2: admin_list_users lanza excepción en vez de retornar vacío
--             → el frontend swallows el error y muestra 0 usuarios
-- ============================================================

-- ─── 1. Ampliar constraint de roles ────────────────────────
ALTER TABLE public.user_roles
  DROP CONSTRAINT IF EXISTS user_roles_role_check;

ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_role_check
  CHECK (role IN ('cocina','admin','superadmin','cajero','mozo','delivery','rider','supervisor_local'));

-- ─── 2. Actualizar admin_update_user_role para aceptar nuevos roles ──
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
  IF public.get_my_role() <> 'superadmin' THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  IF p_role NOT IN ('cocina','admin','superadmin','cajero','mozo','delivery','rider','supervisor_local') THEN
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

-- ─── 3. Recrear admin_list_users sin lanzar excepción ──────
-- Sigue el mismo patrón que admin_list_restaurant_users (migración 025):
-- si no es superadmin retorna vacío en vez de throw.
CREATE OR REPLACE FUNCTION public.admin_list_users()
RETURNS TABLE (
  id            UUID,
  user_id       UUID,
  email         TEXT,
  username      TEXT,
  display_name  TEXT,
  role          TEXT,
  restaurant_id UUID,
  is_active     BOOLEAN,
  created_at    TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.get_my_role() <> 'superadmin' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT ur.id, ur.user_id, ur.email, ur.username, ur.display_name,
         ur.role, ur.restaurant_id, ur.is_active, ur.created_at
  FROM public.user_roles ur
  ORDER BY ur.created_at DESC;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_list_users TO authenticated;
