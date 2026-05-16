-- ============================================================
-- Migración 016: Fix gestión de usuarios en SuperAdmin
-- ============================================================
-- Problema 1: RLS recursivo en user_roles (policy consulta user_roles
--             para verificar superadmin mientras ya está en user_roles).
-- Problema 2: admin_create_user depende de signUp previo — ahora crea
--             el usuario directamente en auth.users con contraseña.
-- ============================================================

-- ── Función: listar todos los usuarios (bypassa RLS) ─────────
-- Usada por el panel superadmin en vez de SELECT directo a user_roles.
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
  -- Solo superadmins pueden listar usuarios
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'superadmin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  RETURN QUERY
  SELECT ur.id, ur.user_id, ur.email, ur.username, ur.display_name,
         ur.role, ur.restaurant_id, ur.is_active, ur.created_at
  FROM public.user_roles ur
  ORDER BY ur.created_at DESC;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_list_users TO authenticated;


-- ── Función: crear usuario con contraseña (sin signUp previo) ─
-- Dropeamos todas las sobrecargas anteriores antes de recrear.
DROP FUNCTION IF EXISTS public.admin_create_user(TEXT, TEXT, TEXT, TEXT, UUID);
DROP FUNCTION IF EXISTS public.admin_create_user(TEXT, TEXT, TEXT, TEXT, UUID, TEXT);

-- Crea directamente en auth.users + user_roles en una sola llamada.
CREATE OR REPLACE FUNCTION public.admin_create_user(
  p_email         TEXT,
  p_username      TEXT,
  p_display_name  TEXT,
  p_role          TEXT,
  p_restaurant_id UUID    DEFAULT NULL,
  p_password      TEXT    DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth, public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  -- Solo superadmins pueden crear usuarios
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'superadmin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'No autorizado: se requiere rol superadmin';
  END IF;

  -- Validar rol
  IF p_role NOT IN ('cocina', 'admin', 'superadmin') THEN
    RAISE EXCEPTION 'Rol inválido: %', p_role;
  END IF;

  -- Buscar si ya existe el usuario en auth
  SELECT id INTO v_user_id FROM auth.users WHERE email = p_email LIMIT 1;

  IF v_user_id IS NULL THEN
    -- Crear nuevo usuario en auth.users directamente (sin email de confirmación)
    IF p_password IS NULL OR length(p_password) < 8 THEN
      RAISE EXCEPTION 'Se requiere una contraseña de al menos 8 caracteres';
    END IF;

    INSERT INTO auth.users (
      instance_id,
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      raw_app_meta_data,
      raw_user_meta_data,
      is_super_admin,
      created_at,
      updated_at
    ) VALUES (
      '00000000-0000-0000-0000-000000000000',
      gen_random_uuid(),
      'authenticated',
      'authenticated',
      p_email,
      crypt(p_password, gen_salt('bf')),
      NOW(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('username', p_username, 'display_name', p_display_name),
      false,
      NOW(),
      NOW()
    ) RETURNING id INTO v_user_id;

  ELSE
    -- Usuario ya existe (p.ej. de un signUp previo) — solo confirmar email
    UPDATE auth.users
    SET email_confirmed_at = COALESCE(email_confirmed_at, NOW()),
        updated_at = NOW()
    WHERE id = v_user_id;
  END IF;

  -- Insertar o actualizar rol en user_roles
  INSERT INTO public.user_roles (user_id, email, username, display_name, role, restaurant_id, is_active)
  VALUES (v_user_id, p_email, p_username, p_display_name, p_role, p_restaurant_id, true)
  ON CONFLICT (user_id, role) DO UPDATE SET
    email         = EXCLUDED.email,
    username      = EXCLUDED.username,
    display_name  = EXCLUDED.display_name,
    role          = EXCLUDED.role,
    restaurant_id = EXCLUDED.restaurant_id,
    is_active     = true;

  RETURN json_build_object(
    'user_id',  v_user_id,
    'email',    p_email,
    'username', p_username,
    'role',     p_role
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_create_user TO authenticated;
