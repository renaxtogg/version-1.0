-- ════════════════════════════════════════════════════════════════════
-- 178 · supplier_limits_enforcement — Gating server-side de planes (PR-SP1)
-- ────────────────────────────────────────────────────────────────────
-- Enforcement fail-closed de los límites del plan de proveedor (mig 177), en la
-- capa DB para que NO sea salteable por la API (lección M10 de restaurantes: el
-- tope tiene que vivir en un trigger, no solo en el cliente). Espeja
-- enforce_menu_item_limit (mig 157/160).
--
-- Contenido:
--   1. resolve_supplier_entitlement(p_supplier_id) — RESOLVER CANÓNICO ÚNICO de
--      los límites efectivos de un proveedor. Devuelve limits||meta del plan de
--      la sub habilitante (status IN ('trial','active')), o el PISO fail-closed
--      (todo 0 / lead_contact 'oculto' / entitled=false) si no hay sub válida.
--      Evita el drift de "N resolvers, N criterios" que costó la mig 160: los
--      triggers, el gating de leads y get_supplier_capabilities leen TODOS de acá.
--   2. get_supplier_capabilities() — pasa a ser wrapper delgado del resolver
--      (MISMA forma de retorno que la mig 177 → cero cambio de comportamiento).
--   3. enforce_supplier_product_limit — BEFORE INSERT OR UPDATE en
--      marketplace_products. Solo actúa en la TRANSICIÓN a 'publicado' (alta
--      publicada o borrador→publicado); editar un producto ya publicado NO cuenta.
--      Cuenta los publicados del proveedor (excluye la propia fila) y respeta
--      max_products (-1 = ilimitado).
--   4. enforce_supplier_user_limit — BEFORE INSERT OR UPDATE en
--      marketplace_supplier_users. Actúa cuando un vínculo pasa a activo (alta
--      activa o reactivación inactivo→activo — se extiende a UPDATE respecto del
--      blueprint para cerrar el bypass de reactivación). Respeta max_users.
--   5. get_my_supplier_leads_info() — se envuelve para honrar lead_contact:
--      'inmediato' = nombre/dirección como hoy; 'demorado' = solo revela leads de
--      +24 h (los recientes van con nombre/dirección NULL = señal de upsell);
--      'oculto' = devuelve el lead_id pero nombre/dirección NULL. MISMA firma de
--      3 columnas → CREATE OR REPLACE sin romper el panel proveedor (src/proveedor
--      /main.jsx:944 mapea lead_id→{name,address}; NULL = blanco, no crashea).
--      request_supplier_contact() (lado restaurante/demanda) NO se toca.
--
-- ⚠️ CONSECUENCIA FAIL-CLOSED (a tener en cuenta al aplicar): un proveedor SIN sub
--    habilitante (trial/active) cae al piso → max_products=0, max_users=0,
--    lead_contact='oculto'. Los proveedores de QA existentes (incl. el [SIM] de la
--    mig 142) NO tienen sub (la 177 no backfilleó) → tras esta mig no pueden
--    publicar productos nuevos ni sumar usuarios, y sus leads muestran nombre en
--    blanco. Sus productos/usuarios YA existentes NO se tocan (los triggers solo
--    disparan en INSERT/transición). Para dejar operativo a un proveedor, asignarle
--    plan con superadmin_set_supplier_plan (mig 177). Onboarding nuevo ya crea la
--    sub trial ANTES del vínculo owner (api/approve-supplier.js, commit e9193c6),
--    así que el 1er usuario pasa el tope; no hay bug de orden.
--
-- ⚠️ SUPERADMIN NO saltea el tope: los triggers actúan por supplier_id sin chequear
--    rol (igual que enforce_menu_item_limit). Un superadmin operando productos de un
--    proveedor tampoco puede pasar el límite (QA punto a). Para ampliar, cambia el
--    plan (sube el tope), no saltea el trigger.
--
-- PREPARED — NOT APPLIED: aplicar A MANO en el SQL Editor (INGLÉS) tras backup,
--    DESPUÉS de la 177. Idempotente (CREATE OR REPLACE / DROP TRIGGER IF EXISTS).
-- Revertir (en orden — primero los consumidores, después el resolver):
--   DROP TRIGGER trg_enforce_supplier_product_limit ON public.marketplace_products;
--   DROP FUNCTION public.enforce_supplier_product_limit();
--   DROP TRIGGER trg_enforce_supplier_user_limit ON public.marketplace_supplier_users;
--   DROP FUNCTION public.enforce_supplier_user_limit();
--   -- restaurar get_my_supplier_leads_info() a la versión de la mig 142 (sin gating)
--   -- restaurar get_supplier_capabilities() a la versión inline de la mig 177 (el
--   --   wrapper es equivalente; opcional)
--   DROP FUNCTION public.resolve_supplier_entitlement(uuid);
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. Resolver canónico de límites efectivos del proveedor ────────
-- SECURITY DEFINER: lee sub/plan sin depender de la RLS del invocador. Interno:
-- lo llaman funciones/triggers DEFINER (dueño postgres). REVOKE FROM PUBLIC como
-- resolve_entitled_plan_id (mig 160). Forma de retorno = la de get_supplier_capabilities
-- (mig 177): limits ∪ {plan_slug,status,entitled,trial_ends_at}, o piso ∪ meta null.
CREATE OR REPLACE FUNCTION public.resolve_supplier_entitlement(p_supplier_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limits jsonb;
  v_slug   text;
  v_status text;
  v_trial  timestamptz;
  v_floor  jsonb := jsonb_build_object(
    'max_products', 0, 'max_users', 0, 'max_catalog_files', 0,
    'max_categorias', 0, 'max_zonas', 0, 'featured_slots', 0,
    'lead_contact', 'oculto', 'lead_priority', false,
    'analytics', 'none', 'branding_banner', false
  );
BEGIN
  IF p_supplier_id IS NULL THEN
    RETURN v_floor || jsonb_build_object(
      'plan_slug', NULL, 'status', NULL, 'entitled', false, 'trial_ends_at', NULL);
  END IF;

  SELECT p.limits, p.slug, s.status, s.trial_ends_at
    INTO v_limits, v_slug, v_status, v_trial
    FROM public.marketplace_supplier_subscriptions s
    JOIN public.marketplace_supplier_plans p ON p.slug = s.plan_slug
   WHERE s.supplier_id = p_supplier_id
     AND s.status IN ('trial','active')
   LIMIT 1;

  IF v_limits IS NULL THEN
    RETURN v_floor || jsonb_build_object(
      'plan_slug', NULL, 'status', NULL, 'entitled', false, 'trial_ends_at', NULL);
  END IF;

  RETURN v_limits || jsonb_build_object(
    'plan_slug', v_slug, 'status', v_status, 'entitled', true, 'trial_ends_at', v_trial);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_supplier_entitlement(uuid) FROM PUBLIC, anon;

-- ─── 2. get_supplier_capabilities → wrapper del resolver (sin cambio de forma) ──
CREATE OR REPLACE FUNCTION public.get_supplier_capabilities()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT public.resolve_supplier_entitlement(public.get_my_supplier_id());
$$;

REVOKE ALL    ON FUNCTION public.get_supplier_capabilities() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_supplier_capabilities() TO authenticated;

-- ─── 3. Límite de productos publicados ──────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_supplier_product_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_max   int;
  v_count int;
BEGIN
  -- Solo la TRANSICIÓN a 'publicado' consume cupo.
  IF NEW.estado <> 'publicado' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.estado = 'publicado' THEN
    RETURN NEW;   -- ya estaba publicado: es edición, no nueva publicación
  END IF;

  v_max := COALESCE((public.resolve_supplier_entitlement(NEW.supplier_id) ->> 'max_products')::int, 0);
  IF v_max = -1 THEN
    RETURN NEW;   -- ilimitado
  END IF;

  SELECT count(*) INTO v_count
    FROM public.marketplace_products
   WHERE supplier_id = NEW.supplier_id
     AND estado = 'publicado'
     AND id <> NEW.id;

  IF v_count >= v_max THEN
    RAISE EXCEPTION 'Alcanzaste el máximo de productos publicados de tu plan (%). Mejorá tu plan para publicar más.', v_max
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_supplier_product_limit ON public.marketplace_products;
CREATE TRIGGER trg_enforce_supplier_product_limit
  BEFORE INSERT OR UPDATE ON public.marketplace_products
  FOR EACH ROW EXECUTE FUNCTION public.enforce_supplier_product_limit();

-- ─── 4. Límite de usuarios del proveedor ────────────────────────────
-- BEFORE INSERT OR UPDATE (el blueprint pedía solo INSERT; se extiende a UPDATE
-- para que reactivar un vínculo inactivo→activo tampoco saltee el tope).
CREATE OR REPLACE FUNCTION public.enforce_supplier_user_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_max   int;
  v_count int;
BEGIN
  -- Solo un vínculo que PASA a activo consume cupo.
  IF COALESCE(NEW.is_active, true) = false THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND COALESCE(OLD.is_active, true) = true THEN
    RETURN NEW;   -- ya estaba activo: edición, no nuevo cupo
  END IF;

  v_max := COALESCE((public.resolve_supplier_entitlement(NEW.supplier_id) ->> 'max_users')::int, 0);
  IF v_max = -1 THEN
    RETURN NEW;   -- ilimitado
  END IF;

  SELECT count(*) INTO v_count
    FROM public.marketplace_supplier_users
   WHERE supplier_id = NEW.supplier_id
     AND is_active = true
     AND id <> NEW.id;

  IF v_count >= v_max THEN
    RAISE EXCEPTION 'Alcanzaste el máximo de usuarios de tu plan (%). Mejorá tu plan para sumar más.', v_max
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_supplier_user_limit ON public.marketplace_supplier_users;
CREATE TRIGGER trg_enforce_supplier_user_limit
  BEFORE INSERT OR UPDATE ON public.marketplace_supplier_users
  FOR EACH ROW EXECUTE FUNCTION public.enforce_supplier_user_limit();

-- ─── 5. Gating del contacto de lead por lead_contact ────────────────
-- Envuelve la RPC de la mig 142 (línea 1156) para honrar el plan. MISMA firma
-- (lead_id, restaurant_name, restaurant_address). El proveedor sigue viendo QUE
-- tiene el lead (la fila se devuelve); lo que se acota es QUIÉN es. NULL = gated.
CREATE OR REPLACE FUNCTION public.get_my_supplier_leads_info()
RETURNS TABLE (lead_id uuid, restaurant_name text, restaurant_address text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  WITH me AS (
    SELECT public.get_my_supplier_id() AS sid
  ),
  cap AS (
    SELECT public.resolve_supplier_entitlement((SELECT sid FROM me)) ->> 'lead_contact' AS lc
  )
  SELECT
    l.id AS lead_id,
    CASE
      WHEN (SELECT lc FROM cap) = 'inmediato' THEN r.name
      WHEN (SELECT lc FROM cap) = 'demorado'
           AND l.created_at <= now() - interval '24 hours' THEN r.name
      ELSE NULL
    END AS restaurant_name,
    CASE
      WHEN (SELECT lc FROM cap) = 'inmediato' THEN r.address
      WHEN (SELECT lc FROM cap) = 'demorado'
           AND l.created_at <= now() - interval '24 hours' THEN r.address
      ELSE NULL
    END AS restaurant_address
  FROM public.marketplace_leads l
  JOIN public.restaurants r ON r.id = l.restaurant_id
  WHERE l.supplier_id = (SELECT sid FROM me);
$$;

REVOKE ALL    ON FUNCTION public.get_my_supplier_leads_info() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_my_supplier_leads_info() TO authenticated;

COMMIT;

-- Recargar el cache de esquema de PostgREST (funciones nuevas/cambiadas).
NOTIFY pgrst, 'reload schema';

SELECT 'migracion 178 aplicada (supplier limits enforcement: resolver canónico + triggers productos/usuarios + gating de leads)' AS status;
