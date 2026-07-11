-- ============================================================================
-- Migración 171 — Limpieza del rol fantasma 'delivery'
-- Fecha: 2026-07-11
--
-- PROBLEMA
--   El rol 'delivery' NO forma parte del pipeline de reparto. El rol REAL de
--   repartidor es 'rider': /api/create-user crea su ficha en delivery_riders,
--   login.html lo enruta a delivery-rider.html y el despacho (mig 156) lo
--   alcanza. Un user_roles.role='delivery' quedaba HUÉRFANO:
--     · sin ficha en delivery_riders  → invisible en Delivery → Riders
--     · sin caso en homeForRole        → no podía iniciar sesión
--     · rechazado por /api/create-user  → nunca debió crearse por esa vía
--   …pero el RPC admin_update_user_role (mig 142) SÍ aceptaba 'delivery' y lo
--   escribía verbatim (sin crear ficha), y el modal "Editar usuario" del
--   superadmin lo ofrecía en su dropdown. Ese era el mecanismo que fabricaba el
--   fantasma. El front ya dejó de ofrecer 'delivery' (ALL_ROLES/NEW_USER_ROLES)
--   y login.html ya lo enruta como 'rider' (red de seguridad transitoria).
--
-- ESTA MIGRACIÓN (idempotente; no-op si no hay filas role='delivery')
--   1. Endurece admin_update_user_role: 'delivery' deja de ser un rol válido.
--   2. Backfill: crea la ficha delivery_riders faltante para cada persona con
--      role='delivery' (vinculada por user_id, scoped por restaurante).
--   3. Normaliza: user_roles.role 'delivery' → 'rider'.
--
-- ⚠️  ANTES DE APLICAR — DRIFT DE ESQUEMA (ver memoria "validar contra base viva"):
--   delivery_riders en prod puede tener columnas de DRIFT NOT NULL que NO están
--   en ninguna migración (status, is_active, vehicle_type — vistas en el seed
--   _simulacion/00_RESET_AND_BUILD.sql). Si existen y son NOT NULL sin default, el
--   INSERT del paso 2 fallará. Validar PRIMERO:
--     SELECT column_name, is_nullable, column_default
--       FROM information_schema.columns
--      WHERE table_schema='public' AND table_name='delivery_riders'
--      ORDER BY ordinal_position;
--   Si aparecen esas columnas NOT NULL, agregarlas al INSERT del paso 2
--   (status→'offline', is_active→true, vehicle_type→'moto').
--
-- ⚠️  REQUIERE APROBACIÓN DE RENATO (toca user_roles + crea filas): NO aplicar a
--   prod sin backup + revisión. Reversible: las fichas backfilleadas se
--   identifican por su created_at (esta corrida) y user_id.
--
-- VERIFICACIÓN PREVIA (¿existen filas fantasma?):
--   SELECT count(*) AS delivery_rows FROM public.user_roles WHERE role='delivery';
--   -- huérfanas (sin ficha):
--   SELECT ur.user_id, ur.email, ur.restaurant_id
--     FROM public.user_roles ur
--    WHERE ur.role='delivery'
--      AND NOT EXISTS (SELECT 1 FROM public.delivery_riders dr WHERE dr.user_id=ur.user_id);
-- ============================================================================

-- ── 1. Endurecer el RPC: 'delivery' ya no es un rol válido ───────────────────
--    (cuerpo idéntico a mig 142, sólo se quita 'delivery' del allow-list)
CREATE OR REPLACE FUNCTION public.admin_update_user_role(
  p_user_id       UUID,
  p_role          TEXT,
  p_restaurant_id UUID DEFAULT NULL,
  p_display_name  TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.get_my_role() <> 'superadmin' THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  -- 'delivery' eliminado del allow-list (mig 171): el rol de reparto es 'rider'.
  IF p_role NOT IN ('cocina','admin','superadmin','cajero','mozo','rider','supervisor_local','supplier') THEN
    RAISE EXCEPTION 'Rol inválido: %', p_role;
  END IF;

  UPDATE public.user_roles
  SET    role          = p_role,
         restaurant_id = p_restaurant_id,
         display_name  = COALESCE(p_display_name, display_name)
  WHERE  user_id = p_user_id;

  RETURN json_build_object('user_id', p_user_id, 'role', p_role);
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_update_user_role TO authenticated;

-- ── 2. Backfill de fichas para los 'delivery' huérfanos ──────────────────────
-- Una ficha por (user_id, restaurante): respeta uniq_delivery_riders_user_rest
-- (mig 166) y no choca con delivery_riders_cedula_one_identity (misma cédula +
-- mismo user_id). Nace 'offline' (M9/mig 158): el despacho no la toca hasta el
-- primer login del rider. Sólo filas con user_id y restaurant_id (el panel rider
-- resuelve su ficha por auth.uid()). vehículo/comisión por defecto, editables en
-- Delivery → Riders.
INSERT INTO public.delivery_riders
  (restaurant_id, user_id, name, phone, vehicle, commission_type, commission_value, cedula, active, current_status)
SELECT ur.restaurant_id,
       ur.user_id,
       COALESCE(NULLIF(btrim(ur.display_name), ''), NULLIF(btrim(ur.username), ''), 'Rider'),
       NULL,
       'moto',
       'pct',
       0,
       ur.cedula,
       true,
       'offline'
FROM public.user_roles ur
WHERE ur.role = 'delivery'
  AND ur.user_id IS NOT NULL
  AND ur.restaurant_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.delivery_riders dr
     WHERE dr.user_id = ur.user_id
       AND dr.restaurant_id = ur.restaurant_id
  );

-- ── 3. Normalizar el rol: 'delivery' → 'rider' ───────────────────────────────
UPDATE public.user_roles
SET    role = 'rider'
WHERE  role = 'delivery';

-- ── Verificación post-migración (debe devolver 0) ────────────────────────────
-- SELECT count(*) FROM public.user_roles WHERE role = 'delivery';
