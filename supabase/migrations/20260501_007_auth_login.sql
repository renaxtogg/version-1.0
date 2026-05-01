-- ============================================================
-- Migración 007: Sistema de login con roles
-- ============================================================
-- NOTA: El primer usuario superadmin (Renato) debe crearse
-- ejecutando el SQL de supabase/seeds/README_primer_usuario.md
-- en el SQL Editor del Dashboard de Supabase.
-- La contraseña NUNCA debe estar en ningún archivo del repo.
-- ============================================================

-- ── Extender user_roles con username y display_name ──────────
ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS username     TEXT,
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS is_active    BOOLEAN DEFAULT true;

-- Índice único en username (case-sensitive)
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_username_idx
  ON public.user_roles(username) WHERE username IS NOT NULL;

-- ── RLS: superadmin puede gestionar todos los roles ──────────
-- (La política existente "user_read_own_role" solo permite SELECT propio)
CREATE POLICY "superadmin_manage_roles" ON public.user_roles
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles me
      WHERE me.user_id = auth.uid()
        AND me.role = 'superadmin'
        AND me.is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles me
      WHERE me.user_id = auth.uid()
        AND me.role = 'superadmin'
        AND me.is_active = true
    )
  );

-- ── Función: obtener email por username (para el login) ──────
-- Accesible sin autenticar (rol anon) para poder hacer el lookup
-- antes del signInWithPassword. Solo devuelve el email, nunca la contraseña.
CREATE OR REPLACE FUNCTION public.get_user_email(p_username TEXT)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = auth, public
AS $$
  SELECT u.email
  FROM auth.users u
  JOIN public.user_roles ur ON ur.user_id = u.id
  WHERE ur.username = p_username
    AND ur.is_active = true
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_user_email TO anon, authenticated;

-- ── Función: obtener perfil del usuario autenticado ──────────
CREATE OR REPLACE FUNCTION public.get_my_profile()
RETURNS JSON
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT row_to_json(t) FROM (
    SELECT ur.role, ur.username, ur.display_name, ur.restaurant_id, ur.is_active
    FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.is_active = true
    LIMIT 1
  ) t;
$$;
GRANT EXECUTE ON FUNCTION public.get_my_profile TO authenticated;

-- ── Función: superadmin crea un usuario nuevo ────────────────
-- Flujo: frontend llama signUp() con cliente temporal → obtiene user.id
-- Luego llama esta función con el email para confirmar + asignar rol.
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
SET search_path = auth, public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  -- Solo superadmins pueden llamar esta función
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'superadmin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  -- Validar rol
  IF p_role NOT IN ('cocina', 'admin', 'superadmin') THEN
    RAISE EXCEPTION 'Rol inválido: %', p_role;
  END IF;

  -- Confirmar email del usuario recién creado (sin depender de email de confirmación)
  UPDATE auth.users
  SET email_confirmed_at = COALESCE(email_confirmed_at, NOW()),
      updated_at = NOW()
  WHERE email = p_email
  RETURNING id INTO v_user_id;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Usuario no encontrado en auth: %', p_email;
  END IF;

  -- Insertar o actualizar el rol
  INSERT INTO public.user_roles (user_id, username, display_name, role, restaurant_id, is_active)
  VALUES (v_user_id, p_username, p_display_name, p_role, p_restaurant_id, true)
  ON CONFLICT (user_id, role) DO UPDATE SET
    username      = EXCLUDED.username,
    display_name  = EXCLUDED.display_name,
    role          = EXCLUDED.role,
    restaurant_id = EXCLUDED.restaurant_id,
    is_active     = true;

  RETURN v_user_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_create_user TO authenticated;

-- ── Función: superadmin activa/desactiva un usuario ──────────
CREATE OR REPLACE FUNCTION public.admin_toggle_user(p_user_id UUID, p_active BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'superadmin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  UPDATE public.user_roles
  SET is_active = p_active
  WHERE user_id = p_user_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_toggle_user TO authenticated;
