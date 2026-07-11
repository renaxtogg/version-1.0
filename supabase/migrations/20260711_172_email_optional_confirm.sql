-- ════════════════════════════════════════════════════════════════════
-- 172 · Correo OPCIONAL + confirmación en el primer ingreso (sin correo fantasma)
-- ────────────────────────────────────────────────────────────────────
-- PROBLEMA
--   El alta de empleados sin correo derivaba un correo SINTÉTICO
--   `${cedula}@mythos.internal` (identidad interna de Auth, necesaria porque
--   Supabase exige un email por cuenta). Ese sintético se MOSTRABA en la
--   columna "Email" de los paneles como si fuera el correo de la persona, y el
--   correo REAL que cargaba el jefe se guardaba en `user_roles.recovery_email`
--   pero NUNCA se mostraba ni se usaba. Resultado: correo fantasma visible +
--   correo real perdido.
--
-- DECISIÓN (Renato, 2026-07-11):
--   · El sintético queda como handle INTERNO de login (no se toca la identidad
--     de Auth ni el login por cédula) y deja de mostrarse como "el correo".
--   · El correo real es OPCIONAL. Si el jefe lo carga, el empleado lo CONFIRMA
--     en su primer ingreso (confirmación EN LA APP, sin envío de email — no hay
--     proveedor SMTP configurado todavía). Sirve como contacto + recuperación.
--
-- ESTA MIGRACIÓN (100% ADITIVA · IDEMPOTENTE · no relaja RLS)
--   1. user_security_flags: dos columnas nuevas para el gate de confirmación de
--      correo en el primer ingreso (paralelas a must_change_password).
--   2. admin_list_restaurant_users(uuid): expone `recovery_email` para que el
--      panel Personal muestre el correo REAL (antes sólo devolvía el sintético).
--
-- COMPATIBILIDAD DE DESPLIEGUE:
--   El código (create-user / change-password / cambiar-password / paneles)
--   está escrito para DEGRADAR con gracia si esta migración todavía NO está
--   aplicada (las escrituras de must_confirm_email/email_confirmed_at son
--   best-effort y separadas del flag crítico; las lecturas fallan-abierto). Se
--   puede desplegar el código antes o después de aplicar esto; la confirmación
--   de correo y el correo real en el panel Personal recién funcionan una vez
--   aplicada.
--
-- ⚠ PREREQUISITOS (ya aplicados en prod, pero explícitos para rebuilds/entornos
--   frescos — aplicar EN ORDEN):
--     · mig 113 → tabla user_security_flags (esta migración le AGREGA columnas).
--     · mig 123 → user_roles.recovery_email (los CREATE FUNCTION de abajo lo SELECT-ean;
--       con check_function_bodies=on —default— el CREATE se valida y fallaría si la
--       columna no existe → toda la transacción hace rollback, sin apply parcial).
--
-- ⚠ PREPARED — aplicar manualmente en el SQL Editor (dashboard en INGLÉS) tras
--   backup. Claude Code NO aplica migraciones. Chequeo opcional de drift antes de
--   aplicar: confirmar que ninguna VIEW/POLICY dependa de las dos funciones de listado
--   (el DROP es NON-CASCADE → si algo depende, aborta seguro en vez de romper).
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ─── 1. Flags de confirmación de correo (paralelas a must_change_password) ────
-- must_confirm_email: el usuario debe confirmar/corregir su correo en el primer
--   ingreso (lo setea /api/create-user cuando el jefe cargó un correo, sólo en
--   ALTAS nuevas; nunca en reuse multi-sucursal).
-- email_confirmed_at: sello de cuándo lo confirmó (lo escribe /api/change-password
--   junto con el cambio de contraseña del primer ingreso).
ALTER TABLE public.user_security_flags
  ADD COLUMN IF NOT EXISTS must_confirm_email boolean NOT NULL DEFAULT false;
ALTER TABLE public.user_security_flags
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz;

-- ─── 2. admin_list_restaurant_users: exponer recovery_email (correo real) ──────
-- El return type cambia (columna nueva) → hay que DROP + CREATE (CREATE OR
-- REPLACE no permite alterar el tipo de retorno). El cuerpo es IDÉNTICO al de la
-- mig 107 (tenant guard incluido); sólo se agrega ur.recovery_email al SELECT y a
-- la firma RETURNS TABLE. Los grants se re-asignan igual que en 105/106/107.
DROP FUNCTION IF EXISTS public.admin_list_restaurant_users(uuid);

CREATE FUNCTION public.admin_list_restaurant_users(p_restaurant_id uuid)
 RETURNS TABLE(id uuid, user_id uuid, email text, recovery_email text, username text, display_name text, role text, is_active boolean, created_at timestamp with time zone)
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
  SELECT ur.id, ur.user_id, ur.email, ur.recovery_email, ur.username, ur.display_name,
         ur.role, ur.is_active, ur.created_at
  FROM public.user_roles ur
  WHERE ur.restaurant_id = p_restaurant_id
     OR (ur.user_id = auth.uid() AND ur.role = 'superadmin')
  ORDER BY ur.created_at DESC;
END;
$function$;

-- Re-assert grant state (explicit, idempotent — igual que 105/106/107)
REVOKE EXECUTE ON FUNCTION public.admin_list_restaurant_users(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.admin_list_restaurant_users(uuid) TO authenticated, service_role;

-- ─── 3. admin_list_users(): exponer recovery_email (panel Superadmin → Usuarios) ─
-- Mismo motivo/patrón que §2: la grilla de usuarios del superadmin también mostraba
-- el sintético; se agrega recovery_email. Cuerpo IDÉNTICO al de la mig 049 (guard
-- superadmin → si no, RETURN vacío); sólo se agrega ur.recovery_email. DROP + CREATE
-- por cambio de tipo de retorno; grants re-asignados como en 105 (panel superadmin).
DROP FUNCTION IF EXISTS public.admin_list_users();

CREATE FUNCTION public.admin_list_users()
RETURNS TABLE (
  id             UUID,
  user_id        UUID,
  email          TEXT,
  recovery_email TEXT,
  username       TEXT,
  display_name   TEXT,
  role           TEXT,
  restaurant_id  UUID,
  is_active      BOOLEAN,
  created_at     TIMESTAMPTZ
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
  SELECT ur.id, ur.user_id, ur.email, ur.recovery_email, ur.username, ur.display_name,
         ur.role, ur.restaurant_id, ur.is_active, ur.created_at
  FROM public.user_roles ur
  ORDER BY ur.created_at DESC;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_list_users() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.admin_list_users() TO authenticated, service_role;

COMMIT;

-- Recargar el cache de esquema de PostgREST (privilegios/policies/firma nueva).
NOTIFY pgrst, 'reload schema';

SELECT 'migration 172 applied — email optional + confirm flags + recovery_email en roster' AS status;
