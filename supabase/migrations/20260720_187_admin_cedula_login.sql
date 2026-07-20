-- ════════════════════════════════════════════════════════════════════
-- 187 · LOGIN DEL ADMIN POR CÉDULA (aditivo, no destructivo)
-- ────────────────────────────────────────────────────────────────────
-- El personal (mozo/caja/cocina/rider) entra con su cédula porque su email
-- de Auth es sintético `${cedula}@mythos.internal` y el login lo construye
-- del lado del cliente. El ADMIN/OWNER, en cambio, entra con su usuario o
-- su correo real → su email de Auth NO es `${cedula}@mythos.internal`, así
-- que la cédula sola no resuelve a su cuenta.
--
-- Esta función permite que, guardando su cédula (endpoint /api/set-admin-cedula
-- → user_roles.cedula), el admin pueda ADEMÁS entrar con su cédula: el login,
-- ante un identificador de sólo dígitos, resuelve la cédula → email de Auth
-- del admin/owner y hace signInWithPassword con ese email. La contraseña
-- sigue siendo obligatoria; esto NO cambia la identidad ni el correo del admin
-- (sigue funcionando su acceso actual).
--
-- Alcance / superficie: SECURITY DEFINER, corre SIN sesión (grant a anon,
-- necesario porque el login es previo a la auth). Devuelve SÓLO el email de
-- login de filas admin/owner activas cuya cédula coincide (los empleados ya
-- se resuelven del lado del cliente, no hace falta exponerlos aquí). Es
-- reversible: DROP de la función revierte el feature sin tocar datos.
-- ⚠ Pendiente de blindaje anon del Sprint 1 RLS (ver MYTHOS_PRESPRINT_REPORT).
-- ════════════════════════════════════════════════════════════════════
BEGIN;

CREATE OR REPLACE FUNCTION public.resolve_login_identifier(p_ident text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT ur.email
  FROM public.user_roles ur
  WHERE ur.role IN ('admin', 'owner')
    AND ur.is_active = true
    AND regexp_replace(coalesce(p_ident, ''), '\D', '', 'g') <> ''
    AND regexp_replace(coalesce(ur.cedula, ''), '\D', '', 'g')
        = regexp_replace(coalesce(p_ident, ''), '\D', '', 'g')
  ORDER BY ur.created_at
  LIMIT 1;
$function$;

REVOKE EXECUTE ON FUNCTION public.resolve_login_identifier(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.resolve_login_identifier(text) TO anon, authenticated, service_role;

COMMIT;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

SELECT 'migration 187 applied — resolve_login_identifier(text) for admin cédula login' AS status;
