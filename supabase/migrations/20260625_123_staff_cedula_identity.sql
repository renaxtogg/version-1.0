-- ════════════════════════════════════════════════════════════════════
-- 123 · Identidad de staff/riders por CÉDULA + email de recuperación opcional
-- ────────────────────────────────────────────────────────────────────
-- El alta de empleados/riders deja de chocar con "usuario ocupado": la
-- identidad pasa a ser la cédula (única). El email sintético del login interno
-- se deriva de la cédula (${digitos}@mythos.internal — lo arma el backend).
-- recovery_email queda para la futura recuperación de contraseña (follow-up:
-- requiere proveedor de correo; respaldo día uno = reset por admin/superadmin).
-- Los dueños siguen con email. No se migra ninguna cuenta (fix-forward).
--
-- 100% ADITIVA + IDEMPOTENTE (ADD COLUMN IF NOT EXISTS, índice IF NOT EXISTS).
-- No relaja RLS, no toca cuentas existentes.
--
-- PII (cedula, recovery_email): NO se otorga ningún SELECT nuevo a anon. La RLS
-- vigente de user_roles (mig 029) ya bloquea a anon por completo: sus políticas
-- exigen auth.uid() (NULL para anon) → anon obtiene CERO filas. El acceso queda
-- restringido a la propia fila (user_read_own_role) y a admin/superadmin
-- (admin_read_restaurant_users). delivery_riders.cedula hereda su RLS por tenant.
--
-- ⚠ PREPARED — aplicar manualmente en el SQL Editor (en INGLÉS) tras backup;
--   Claude Code NO aplica migraciones.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.user_roles      ADD COLUMN IF NOT EXISTS cedula         TEXT;
ALTER TABLE public.user_roles      ADD COLUMN IF NOT EXISTS recovery_email TEXT;
ALTER TABLE public.delivery_riders ADD COLUMN IF NOT EXISTS cedula         TEXT;

-- Cédula única sólo donde está presente: permite múltiples NULL (cuentas legacy
-- y dueños por email que no tienen cédula). Es el respaldo del "se acaba el
-- usuario ocupado" (el email interno ${cedula}@mythos.internal ya es único en auth).
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_cedula_unique
  ON public.user_roles(cedula) WHERE cedula IS NOT NULL;

NOTIFY pgrst, 'reload schema';
