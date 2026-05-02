-- ============================================================
-- Migración 008: Fix login — email en user_roles (sin JOIN auth.users)
-- ============================================================
-- El JOIN con auth.users desde get_user_email causaba PGRST500
-- "Database error querying schema" en Supabase Cloud.
-- Solución: guardar el email en user_roles directamente.
-- ============================================================

-- Agregar columna email a user_roles
ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS email TEXT;

-- Reescribir get_user_email sin JOIN a auth.users
CREATE OR REPLACE FUNCTION public.get_user_email(p_username TEXT)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT email
  FROM public.user_roles
  WHERE username = p_username
    AND is_active = true
    AND email IS NOT NULL
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_user_email TO anon, authenticated;

-- Reescribir admin_create_user para que también guarde el email en user_roles
CREATE OR REPLACE FUNCTION public.admin_create_user(
  p_email         TEXT,
  p_username      TEXT,
  p_display_name  TEXT,
  p_role          TEXT,
  p_restaurant_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'superadmin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  IF p_role NOT IN ('cocina', 'admin', 'superadmin') THEN
    RAISE EXCEPTION 'Rol inválido: %', p_role;
  END IF;

  -- Confirmar email del usuario recién creado
  UPDATE auth.users
  SET email_confirmed_at = COALESCE(email_confirmed_at, NOW()),
      updated_at = NOW()
  WHERE email = p_email
  RETURNING id INTO v_user_id;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Usuario no encontrado en auth: %', p_email;
  END IF;

  INSERT INTO public.user_roles (user_id, email, username, display_name, role, restaurant_id, is_active)
  VALUES (v_user_id, p_email, p_username, p_display_name, p_role, p_restaurant_id, true)
  ON CONFLICT (user_id, role) DO UPDATE SET
    email         = EXCLUDED.email,
    username      = EXCLUDED.username,
    display_name  = EXCLUDED.display_name,
    role          = EXCLUDED.role,
    restaurant_id = EXCLUDED.restaurant_id,
    is_active     = true;

  RETURN v_user_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_create_user TO authenticated;
