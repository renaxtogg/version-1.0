-- ═══════════════════════════════════════════════════════════
-- MIGRACIÓN 020 — FIX ROL CAJERO
-- Problema: admin_create_user no incluía 'cajero' como rol válido
--           → cajeros creados manualmente quedan con restaurant_id NULL
--           → RLS de turnos_caja rechaza el INSERT (NULL ≠ RID)
-- EJECUTAR EN SUPABASE SQL EDITOR (dashboard en inglés)
-- ═══════════════════════════════════════════════════════════

-- 1. Reparar cajeros existentes con restaurant_id NULL
UPDATE public.user_roles
SET restaurant_id = '00000000-0000-0000-0000-000000000001'
WHERE role = 'cajero'
  AND (restaurant_id IS NULL OR restaurant_id != '00000000-0000-0000-0000-000000000001');

-- 2. Actualizar admin_create_user para que acepte 'cajero'
DROP FUNCTION IF EXISTS public.admin_create_user(TEXT, TEXT, TEXT, TEXT, UUID);
DROP FUNCTION IF EXISTS public.admin_create_user(TEXT, TEXT, TEXT, TEXT, UUID, TEXT);

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
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'superadmin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'No autorizado: se requiere rol superadmin';
  END IF;

  IF p_role NOT IN ('cocina', 'admin', 'superadmin', 'cajero') THEN
    RAISE EXCEPTION 'Rol inválido: %', p_role;
  END IF;

  SELECT id INTO v_user_id FROM auth.users WHERE email = p_email LIMIT 1;

  IF v_user_id IS NULL THEN
    IF p_password IS NULL OR length(p_password) < 8 THEN
      RAISE EXCEPTION 'Se requiere una contraseña de al menos 8 caracteres';
    END IF;

    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      is_super_admin, created_at, updated_at
    ) VALUES (
      '00000000-0000-0000-0000-000000000000',
      gen_random_uuid(),
      'authenticated', 'authenticated',
      p_email,
      crypt(p_password, gen_salt('bf')),
      NOW(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('username', p_username, 'display_name', p_display_name),
      false, NOW(), NOW()
    ) RETURNING id INTO v_user_id;
  ELSE
    UPDATE auth.users
    SET email_confirmed_at = COALESCE(email_confirmed_at, NOW()), updated_at = NOW()
    WHERE id = v_user_id;
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

  RETURN json_build_object(
    'user_id',  v_user_id,
    'email',    p_email,
    'username', p_username,
    'role',     p_role
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_create_user TO authenticated;
