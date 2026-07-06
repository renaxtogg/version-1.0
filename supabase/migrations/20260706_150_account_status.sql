-- ════════════════════════════════════════════════════════════════════════
-- 150 · ESTADO DE LA CUENTA (mantenimiento · suspensión · vencimiento)
-- ────────────────────────────────────────────────────────────────────────
-- (PREPARED — NOT APPLIED: aplicar manualmente tras backup nuevo, SQL Editor
--  en INGLÉS. Claude Code NO la aplica.)
--
-- Una única RPC que resuelve, para el restaurante del usuario logueado, los 3
-- estados que hoy existen en datos pero NINGÚN panel consultaba al entrar:
--   • Modo mantenimiento     (restaurants.maintenance_mode/message, mig 031)
--   • Cuenta suspendida/inactiva (restaurants.status / is_active)
--   • Mensualidad vencida    (subscriptions.status / end_date, días restantes)
--
-- La consume public/mythos-auth-guard.js (común a los paneles de staff) para
-- bloquear (suspensión) o avisar (mantenimiento / vencida). El superadmin NUNCA
-- se bloquea (no tiene restaurante propio → la RPC responde no-bloqueante).
--
-- Diseño fail-closed en permisos, fail-OPEN en el cliente:
--   • SECURITY DEFINER + search_path=public. Identidad por auth.uid().
--   • anon → NULL (el guard no bloquea ante NULL/error → nunca deja afuera por error).
--   • Solo devuelve el estado del PROPIO restaurante (o de una sucursal de la
--     misma cuenta, validada contra get_my_company_restaurant_ids()). No lee
--     datos de otros locales.
--   • Los flags derivados (suspended / expired) se calculan server-side: el
--     cliente no decide, solo pinta.
-- 100% ADITIVA / idempotente. No toca RLS ni tablas existentes.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE OR REPLACE FUNCTION public.get_my_account_status(p_restaurant_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_role       text;
  v_rid        uuid;
  v_name       text;
  v_status     text;
  v_is_active  boolean;
  v_maint      boolean;
  v_maint_msg  text;
  v_sub_status text;
  v_sub_end    date;
  v_days       int;
BEGIN
  -- anon / sin sesión → sin estado (el guard interpreta NULL como "no bloquear").
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  v_role := public.get_my_role();

  -- Superadmin: nunca se bloquea ni recibe avisos (no tiene restaurante propio).
  IF v_role = 'superadmin' THEN
    RETURN jsonb_build_object(
      'role', 'superadmin', 'restaurant_id', NULL,
      'maintenance_mode', false, 'suspended', false, 'expired', false
    );
  END IF;

  -- Restaurante del usuario: por defecto el primero activo de user_roles; si el
  -- panel indica uno (p_restaurant_id) y pertenece a la misma cuenta, ese.
  SELECT restaurant_id INTO v_rid
    FROM public.user_roles
   WHERE user_id = v_uid AND is_active = true AND restaurant_id IS NOT NULL
   ORDER BY created_at ASC
   LIMIT 1;

  IF p_restaurant_id IS NOT NULL
     AND p_restaurant_id IN (SELECT public.get_my_company_restaurant_ids()) THEN
    v_rid := p_restaurant_id;
  END IF;

  -- Usuario sin restaurante (p. ej. proveedor del marketplace) → no-bloqueante.
  IF v_rid IS NULL THEN
    RETURN jsonb_build_object(
      'role', COALESCE(v_role, 'unknown'), 'restaurant_id', NULL,
      'maintenance_mode', false, 'suspended', false, 'expired', false
    );
  END IF;

  SELECT name, status, COALESCE(is_active, true),
         COALESCE(maintenance_mode, false), maintenance_message
    INTO v_name, v_status, v_is_active, v_maint, v_maint_msg
    FROM public.restaurants
   WHERE id = v_rid;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'role', v_role, 'restaurant_id', v_rid,
      'maintenance_mode', false, 'suspended', false, 'expired', false
    );
  END IF;

  -- Suscripción más reciente del restaurante.
  SELECT status, end_date
    INTO v_sub_status, v_sub_end
    FROM public.subscriptions
   WHERE restaurant_id = v_rid
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_sub_end IS NOT NULL THEN
    v_days := (v_sub_end - CURRENT_DATE);
  END IF;

  RETURN jsonb_build_object(
    'role',                  v_role,
    'restaurant_id',         v_rid,
    'restaurant_name',       v_name,
    'restaurant_status',     v_status,
    'is_active',             v_is_active,
    'maintenance_mode',      v_maint,
    'maintenance_message',   v_maint_msg,
    'subscription_status',   v_sub_status,
    'subscription_end_date', v_sub_end,
    'days_left',             v_days,
    -- Flags derivados (el cliente no recalcula, solo pinta):
    --  • suspended = bloqueo duro: lo controla el superadmin en el RESTAURANTE
    --    (status/is_active). La suspensión de la SUSCRIPCIÓN no bloquea (solo avisa).
    --  • expired = aviso de mensualidad (período de gracia, sin bloqueo): vencida por
    --    fecha, o con un estado de cobranza no vigente ('expired'/'past_due'/'suspended').
    --    'cancelled' con end_date futura = pagado hasta fin de período → NO se avisa
    --    (si ya pasó la fecha, cae igual por el chequeo de end_date).
    'suspended', (v_status IN ('suspended', 'inactive') OR v_is_active = false),
    'expired',   (v_sub_status IN ('expired', 'past_due', 'suspended')
                  OR (v_sub_end IS NOT NULL AND v_sub_end < CURRENT_DATE))
  );
END;
$$;

-- Permisos fail-closed: nunca PUBLIC/anon; solo authenticated. La función
-- responde NULL a anon de todos modos (auth.uid() IS NULL).
REVOKE ALL     ON FUNCTION public.get_my_account_status(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_my_account_status(uuid) TO authenticated;

COMMIT;

-- Recargar el cache de esquema de PostgREST (nueva función visible).
NOTIFY pgrst, 'reload schema';

SELECT 'migration 150 applied — get_my_account_status RPC' AS status;
