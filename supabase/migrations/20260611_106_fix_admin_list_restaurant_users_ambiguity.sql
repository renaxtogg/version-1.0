-- ════════════════════════════════════════════════════════════════════
-- 106 · FIX admin_list_restaurant_users(uuid) — 42702 ambiguity
-- ────────────────────────────────────────────────────────────────────
-- Bug (pre-existing, surfaced during Sprint 1C verification): the
-- guard clause referenced user_id / is_active / role unqualified.
-- All three are simultaneously columns of public.user_roles AND OUT
-- parameters of the RETURNS TABLE, so plpgsql aborts with
-- 42702 "column reference user_id is ambiguous" on every call →
-- admin.html → Personal roster was broken.
--
-- Fix: alias the guard's user_roles as `g` and qualify the three
-- references. NOTHING else changes: same signature, same return
-- shape, same SECURITY DEFINER + search_path, same role checks, same
-- RETURN QUERY (already correctly aliased as `ur`). Body taken
-- verbatim from production pg_get_functiondef on 2026-06-11.
--
-- NOT changed (Sprint 2 backlog, architect-decided minimal scope):
-- the guard verifies the caller is an active admin/superadmin of
-- SOME restaurant, not of p_restaurant_id specifically — an admin of
-- restaurant A can list restaurant B's roster (same class as the
-- unguarded stock RPCs already in the Sprint 2 security backlog).
--
-- Grants: CREATE OR REPLACE preserves existing privileges (105 state:
-- no PUBLIC/anon, authenticated + service_role only). Re-asserted
-- below anyway so fresh environments converge deterministically.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

CREATE OR REPLACE FUNCTION public.admin_list_restaurant_users(p_restaurant_id uuid)
 RETURNS TABLE(id uuid, user_id uuid, email text, username text, display_name text, role text, is_active boolean, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Si no es admin/superadmin, retornar vacio (no lanzar excepcion)
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles g
    WHERE g.user_id = auth.uid()
      AND g.is_active = true
      AND g.role IN ('admin', 'superadmin')
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

-- Re-assert the 105 grant state (idempotent; CREATE OR REPLACE already
-- preserved it on environments where 105 ran)
REVOKE EXECUTE ON FUNCTION public.admin_list_restaurant_users(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_restaurant_users(uuid) TO authenticated, service_role;

COMMIT;

-- Reload PostgREST's schema cache
NOTIFY pgrst, 'reload schema';

SELECT 'migration 106 applied — admin_list_restaurant_users ambiguity fixed' AS status;
