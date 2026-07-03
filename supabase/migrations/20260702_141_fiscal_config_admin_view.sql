-- ════════════════════════════════════════════════════════════════════
-- 141 · fiscal_config_admin — vista de SÓLO LECTURA para el superadmin
-- ────────────────────────────────────────────────────────────────────
-- PR-SA3. La página "Fiscal" del superadmin necesita LEER la configuración
-- fiscal por local, pero fiscal_config (mig 137) es DENY-ALL para authenticated
-- (REVOKE ALL + sin policies) porque guarda la API key CIFRADA
-- (api_key_ciphertext/iv/tag) y el CSC. Esos secretos NO deben salir NUNCA al
-- frontend — ni siquiera cifrados/parciales.
--
-- En vez de abrir un SELECT sobre la tabla (que expondría el ciphertext al
-- cliente aunque no se renderice), exponemos una VISTA que:
--   • proyecta SÓLO columnas no-sensibles (nada de api_key_*, csc, csc_id),
--   • deriva has_api_key / has_csc como BOOLEANOS (presencia sí/no, sin el valor),
--   • se filtra fail-closed a superadmin dentro de la propia vista.
--
-- La vista corre con seguridad de DEFINITOR (security_invoker=false): accede a
-- fiscal_config con los privilegios del dueño (postgres, bypassa RLS), así que
-- el ÚNICO control de acceso es el WHERE COALESCE(get_my_role()='superadmin',
-- false). get_my_role()/auth.uid() leen el JWT del request (no del dueño de la
-- vista) → un authenticated no-superadmin obtiene 0 filas; anon no tiene grant.
--
-- documentos_electronicos NO necesita cambios: su policy de_auth_select (mig 138)
-- ya deja LEER al superadmin. platform_config (tarifa fe_*) tampoco: el
-- superadmin ya lo lee/escribe (Facturación→moneda).
--
-- Idempotente. Revertir: DROP VIEW IF EXISTS public.fiscal_config_admin;
-- ════════════════════════════════════════════════════════════════════
BEGIN;

DROP VIEW IF EXISTS public.fiscal_config_admin;

CREATE VIEW public.fiscal_config_admin
  WITH (security_invoker = false) AS
SELECT
  fc.id,
  fc.restaurant_id,
  fc.provider,
  fc.tenant,
  fc.environment,
  fc.ruc,
  fc.razon_social,
  fc.timbrado,
  fc.establecimiento,
  fc.punto_expedicion,
  fc.actividad_economica,
  fc.auto_email,
  fc.kude_format,
  fc.active,
  fc.created_at,
  fc.updated_at,
  -- Presencia de secretos como booleano — NUNCA el valor.
  (fc.api_key_ciphertext IS NOT NULL AND fc.api_key_ciphertext <> '') AS has_api_key,
  (fc.csc              IS NOT NULL AND fc.csc              <> '') AS has_csc
FROM public.fiscal_config fc
-- Gate fail-closed: sólo el superadmin ve filas. COALESCE cubre el caso sin JWT.
WHERE COALESCE(public.get_my_role() = 'superadmin', false);

-- Sólo authenticated (el superadmin logueado). anon NO recibe grant.
REVOKE ALL ON public.fiscal_config_admin FROM PUBLIC, anon;
GRANT SELECT ON public.fiscal_config_admin TO authenticated;

COMMIT;

-- Recargar el cache de esquema de PostgREST para exponer la vista.
NOTIFY pgrst, 'reload schema';

SELECT 'migracion 141 aplicada (fiscal_config_admin: vista superadmin sin secretos)' AS status;
