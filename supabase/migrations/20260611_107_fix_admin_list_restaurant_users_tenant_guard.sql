-- ════════════════════════════════════════════════════════════════════
-- 107 · TENANT GUARD for admin_list_restaurant_users(uuid)
-- ────────────────────────────────────────────────────────────────────
-- Confirmed in Sprint 1C.1 verification: the guard only checked that
-- the caller is an active admin/superadmin of SOME restaurant, so
-- admin.carlos (c3c3) calling admin_list_restaurant_users(a1a1)
-- received the other tenant's full roster (emails + roles) through
-- SECURITY DEFINER. Architect decision: close it now, before the
-- simulation teardown — do not defer to Sprint 2.
--
-- New guard (trusted helpers from migs 029/092, same pattern as the
-- 103/104/105 policies):
--   * superadmin            → any restaurant.
--   * admin / owner (active)→ only restaurants inside their own
--     company scope: p_restaurant_id IN get_my_company_restaurant_ids().
--   * everyone else         → empty result (same soft-fail style the
--     function always had: RETURN, no exception).
-- get_my_role() already enforces is_active = true and resolves
-- multi-role users with superadmin > admin priority.
--
-- Unchanged: signature, RETURNS TABLE shape, SECURITY DEFINER,
-- search_path, the RETURN QUERY (incl. the superadmin self-row OR
-- branch) and its ORDER BY. No other object is touched.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

CREATE OR REPLACE FUNCTION public.admin_list_restaurant_users(p_restaurant_id uuid)
 RETURNS TABLE(id uuid, user_id uuid, email text, username text, display_name text, role text, is_active boolean, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Tenant guard (mig 107): superadmin ve cualquier restaurante;
  -- admin/owner activos solo dentro de su scope corporativo;
  -- cualquier otro caller recibe vacio (sin excepcion).
  IF NOT (
    public.get_my_role() = 'superadmin'
    OR (
      public.get_my_role() IN ('admin', 'owner')
      AND p_restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  ) THEN
    RETURN;
  END IF;

  -- Superadmins (sin restaurant_id) ven a todos los usuarios del restaurante
  -- Admins normales tambien ven a todos los de su restaurante
  RETURN QUERY
  SELECT ur.id, ur.user_id, ur.email, ur.username, ur.display_name,
         ur.role, ur.is_active, ur.created_at
  FROM public.user_roles ur
  WHERE ur.restaurant_id = p_restaurant_id
     OR (ur.user_id = auth.uid() AND ur.role = 'superadmin')
  ORDER BY ur.created_at DESC;
END;
$function$;

-- Re-assert the 105/106 grant state (explicit, idempotent)
REVOKE EXECUTE ON FUNCTION public.admin_list_restaurant_users(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_restaurant_users(uuid) TO authenticated, service_role;

COMMIT;

-- Reload PostgREST's schema cache
NOTIFY pgrst, 'reload schema';

SELECT 'migration 107 applied — tenant guard on admin_list_restaurant_users' AS status;
