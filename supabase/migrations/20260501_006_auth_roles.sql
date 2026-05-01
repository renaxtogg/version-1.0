-- ============================================================
-- Migración 006: Roles de usuario + Realtime para menú
-- ============================================================

-- ── Tabla de roles ───────────────────────────────────────────
-- user_id referencia auth.users (manejado por Supabase Auth).
-- Nunca guardar contraseñas aquí — eso lo hace Supabase Auth internamente.
-- Para superadmin: restaurant_id = NULL (accede a todo).
-- Para admin/cocina: restaurant_id = UUID del restaurante asignado.
CREATE TABLE IF NOT EXISTS public.user_roles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  restaurant_id UUID REFERENCES public.restaurants(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('cocina', 'admin', 'superadmin')),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, role)
);

-- RLS: cada usuario solo ve su propio rol
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_read_own_role" ON public.user_roles
  FOR SELECT USING (user_id = auth.uid());

-- ── Realtime para menú (fix sync admin → cliente) ────────────
-- El cliente (index.html) se suscribe a estos cambios para
-- actualizar el menú en tiempo real sin necesidad de recargar.
ALTER PUBLICATION supabase_realtime ADD TABLE menu_items;
ALTER PUBLICATION supabase_realtime ADD TABLE menu_categories;
