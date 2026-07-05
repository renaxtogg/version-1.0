-- ════════════════════════════════════════════════════════════════════
-- 145 · CUENTAS Y PERFILES REALES — perfil de usuario editable + dueño/encargado
--       (PREPARED — NOT APPLIED: aplicar manualmente tras backup, SQL Editor
--        en INGLÉS. Claude Code NO aplica migraciones.)
-- ────────────────────────────────────────────────────────────────────
-- Habilita 3 cosas de producto:
--   (P2) "Mi cuenta": cada usuario edita su propio NOMBRE + TELÉFONO.
--        El nombre ya vive en user_roles.display_name; el teléfono NO existía
--        → se agrega la columna user_roles.phone. Como user_roles NO tiene
--        policy de UPDATE para el usuario común (solo superadmin escribe —
--        mig 029 "superadmin_manage_roles"), NO se abre una policy self-UPDATE
--        (permitiría reescribir role/restaurant_id/is_active = escalada). En su
--        lugar, una RPC fail-closed `update_my_profile` que actualiza SOLO
--        display_name + phone de la fila del propio auth.uid().
--   (P3) Dueño/Encargado por restaurante: owner_name/owner_email/owner_phone ya
--        existen (mig 004); se agregan owner_document (C.I./RUC del dueño),
--        manager_name y manager_phone (encargado, si difiere). La escritura la
--        cubre la RLS vigente de restaurants (mig 103: admin/owner su propia
--        empresa; superadmin cualquiera) — NO se crea RPC nueva para eso.
--
-- ALCANCE / SEGURIDAD:
--   • ADITIVA + IDEMPOTENTE (ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE,
--     DROP/CREATE POLICY). NO altera datos, NO toca get_my_profile ni el login.
--   • Único cambio de RLS: ENDURECE (no relaja) la lectura de user_roles —
--     re-scopea admin_read_restaurant_users a la propia empresa (ver abajo).
--   • La RPC es SECURITY DEFINER, STABLE-safe, SET search_path=public,
--     REVOKE ALL FROM PUBLIC/anon, GRANT solo a authenticated, y filtra por
--     auth.uid() (NULL para anon → 0 filas = fail-closed). Whitelist estricta
--     de columnas (display_name, phone) — role/tenant/estado intocables.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ── (P2) Teléfono del usuario ────────────────────────────────────────
ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS phone text;

-- ── (P3) Dueño (documento) + Encargado del restaurante ───────────────
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS owner_document text;   -- C.I. o RUC del dueño
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS manager_name   text;   -- encargado (si difiere del dueño)
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS manager_phone  text;

-- ── (P2) RPC fail-closed: editar SOLO el propio nombre + teléfono ─────
-- Reemplaza (idempotente) cualquier versión previa. No hay policy self-UPDATE
-- en user_roles a propósito; esta RPC es el único camino de auto-servicio.
CREATE OR REPLACE FUNCTION public.update_my_profile(
  p_display_name text DEFAULT NULL,
  p_phone        text DEFAULT NULL
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.user_roles
     SET display_name = COALESCE(NULLIF(btrim(p_display_name), ''), display_name),
         phone        = CASE WHEN p_phone IS NULL THEN phone
                             ELSE NULLIF(btrim(p_phone), '') END
   WHERE user_id = auth.uid()
     AND is_active = true;
$$;

REVOKE ALL     ON FUNCTION public.update_my_profile(text, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.update_my_profile(text, text) TO authenticated;

-- ── (P2/seguridad) Aislar por empresa la lectura de user_roles ───────────────
-- La policy vigente admin_read_restaurant_users (mig 029) deja que CUALQUIER admin
-- lea TODAS las filas de user_roles de TODOS los restaurantes (no filtra por
-- empresa). Al agregar user_roles.phone (PII) se agranda esa fuga cross-tenant.
-- La re-escribimos con el MISMO patrón de tenant-scoping ya usado en mig 104/107:
--   • cada usuario lee su(s) propia(s) fila(s)  (user_id = auth.uid())
--   • superadmin lee todo                        (get_my_role() = 'superadmin')
--   • admin lee solo su empresa                  (restaurant_id ∈ get_my_company_restaurant_ids())
-- Impacto analizado (2026-07-05): TODAS las lecturas de user_roles del front
-- filtran por user_id (fila propia) o por restaurant_id=RID (dentro de la empresa)
-- o son superadmin → esta política no rompe ningún flujo (login, onboarding,
-- Personal del admin, Usuarios del superadmin). get_my_role()/…company_ids son
-- SECURITY DEFINER (bypass RLS) → sin recursión. Reversible (DROP/CREATE).
DROP POLICY IF EXISTS "admin_read_restaurant_users" ON public.user_roles;
CREATE POLICY "admin_read_restaurant_users" ON public.user_roles
  FOR SELECT
  USING (
    user_id = auth.uid()
    OR public.get_my_role() = 'superadmin'
    OR (public.get_my_role() = 'admin'
        AND restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  );

COMMIT;

-- Recargar el cache de esquema de PostgREST (columnas + RPC visibles).
NOTIFY pgrst, 'reload schema';

SELECT 'migration 145 applied — user_roles.phone + restaurants owner_document/manager_* + update_my_profile()' AS status;
