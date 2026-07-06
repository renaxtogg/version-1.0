-- ════════════════════════════════════════════════════════════════════
-- 146 · CONTROL DE MÓDULOS POR RESTAURANTE + ELIMINACIÓN SEGURA
--       (PREPARED — NOT APPLIED: aplicar manualmente tras backup, SQL Editor
--        en INGLÉS. Claude Code NO aplica migraciones.)
-- ────────────────────────────────────────────────────────────────────
-- PARTE A — overrides de paneles/features POR restaurante que aplican de verdad:
--   • Tabla restaurant_feature_overrides (key = 'panel:<x>' | 'feature:<x>',
--     enabled bool). RLS: solo superadmin LEE; la escritura es por RPC.
--   • get_restaurant_capabilities: aplica overrides SOBRE el plan
--     (enabled=true agrega, enabled=false quita aunque el plan lo traiga).
--     'admin' se trata como panel siempre-activo por defecto (base), y puede
--     apagarse con un override. Se agregan al JSON: plan_panels (base) y
--     overrides (mapa crudo) para que el superadmin muestre "plan vs override".
--   • is_panel_enabled(rid, panel) → boolean, callable por anon+authenticated
--     (el gate de acceso corre en cada panel, incluido delivery-cliente que es
--     anónimo). Fail-OPEN: sin plan/sin dato → true; solo bloquea con un
--     override enabled=false o cuando el plan define paneles y no lo incluye.
--   • RPCs superadmin-only fail-closed para setear/limpiar overrides.
--
-- PARTE B — borrado seguro de un restaurante (usado por api/delete-restaurant.js):
--   • superadmin_delete_restaurant(rid): DEFINER, fail-closed (superadmin o
--     service_role), borra en UNA transacción en el orden correcto de FKs
--     (orders → user_profiles → restaurants; el resto es CASCADE/SET NULL) y
--     devuelve un resumen. NO toca auth.users (eso lo hace el endpoint con la
--     Admin API). NO borra sucursales hijas (parent_company_id es SET NULL).
--
-- SEGURIDAD: toda RPC nueva es SECURITY DEFINER + SET search_path=public +
--   REVOKE ALL FROM PUBLIC, anon (salvo is_panel_enabled que sí necesita anon)
--   + GRANT acotado. Idempotente (IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS).
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ── PARTE A.1 — Tabla de overrides por restaurante ───────────────────
CREATE TABLE IF NOT EXISTS public.restaurant_feature_overrides (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  key           text NOT NULL,          -- 'panel:<x>' | 'feature:<x>'
  enabled       boolean NOT NULL,
  updated_by    uuid,                   -- auth.uid() del superadmin que lo tocó
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, key)
);
CREATE INDEX IF NOT EXISTS idx_rfo_restaurant ON public.restaurant_feature_overrides(restaurant_id);

ALTER TABLE public.restaurant_feature_overrides ENABLE ROW LEVEL SECURITY;

-- Solo el superadmin LEE la tabla directamente (para pintar el estado en el panel).
-- La escritura NO tiene policy → solo pasa por las RPCs DEFINER de abajo.
DROP POLICY IF EXISTS "rfo_superadmin_read" ON public.restaurant_feature_overrides;
CREATE POLICY "rfo_superadmin_read" ON public.restaurant_feature_overrides
  FOR SELECT TO authenticated
  USING (public.get_my_role() = 'superadmin');

REVOKE ALL ON public.restaurant_feature_overrides FROM anon;
GRANT SELECT ON public.restaurant_feature_overrides TO authenticated;

-- ── PARTE A.2 — RPCs superadmin-only para setear / limpiar overrides ─
CREATE OR REPLACE FUNCTION public.superadmin_set_feature_override(
  p_restaurant_id uuid,
  p_key           text,
  p_enabled       boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT COALESCE(public.get_my_role() = 'superadmin', false) THEN
    RAISE EXCEPTION 'Solo el superadmin puede cambiar módulos' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_key IS NULL OR p_key !~ '^(panel|feature):[a-z0-9:_-]+$' THEN
    RAISE EXCEPTION 'key inválida (usá panel:<x> o feature:<x>)';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'enabled es obligatorio';
  END IF;
  INSERT INTO public.restaurant_feature_overrides (restaurant_id, key, enabled, updated_by, updated_at)
  VALUES (p_restaurant_id, p_key, p_enabled, auth.uid(), now())
  ON CONFLICT (restaurant_id, key)
  DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now();
END;
$$;
REVOKE ALL     ON FUNCTION public.superadmin_set_feature_override(uuid, text, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.superadmin_set_feature_override(uuid, text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.superadmin_clear_feature_override(
  p_restaurant_id uuid,
  p_key           text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT COALESCE(public.get_my_role() = 'superadmin', false) THEN
    RAISE EXCEPTION 'Solo el superadmin puede cambiar módulos' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM public.restaurant_feature_overrides
   WHERE restaurant_id = p_restaurant_id AND key = p_key;
END;
$$;
REVOKE ALL     ON FUNCTION public.superadmin_clear_feature_override(uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.superadmin_clear_feature_override(uuid, text) TO authenticated;

-- ── PARTE A.3 — get_restaurant_capabilities: aplicar overrides ───────
-- CREATE OR REPLACE conservando el cuerpo de la mig 108 (guard tenant-safe +
-- multi-sucursal) y SUMANDO: 'admin' siempre-activo en la base, overrides de
-- panel aplicados sobre allowed_panels, y campos nuevos plan_panels + overrides.
CREATE OR REPLACE FUNCTION public.get_restaurant_capabilities(p_restaurant_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan          RECORD;
  v_panels        JSONB;
  v_addon_panels  JSONB;
  v_addons        JSONB;
  v_base_panels   JSONB;
  v_eff_panels    JSONB;
  v_overrides     JSONB;
  v_parent        UUID;
  v_root          UUID;
  v_branches      JSONB;
  v_branch_count  INT;
  v_extra         INT;
  v_max_branches  INT;
BEGIN
  -- GUARD tenant-safe (idéntico a la mig 108): superadmin global; el resto solo
  -- su cuenta corporativa; anon/sin rol/cross-tenant → NULL (fail-closed).
  IF NOT COALESCE(
       public.get_my_role() = 'superadmin'
       OR p_restaurant_id IN (SELECT public.get_my_company_restaurant_ids()),
       false)
  THEN
    RETURN NULL;
  END IF;

  SELECT sp.allowed_panels, sp.allowed_features, sp.max_users_by_role, sp.max_tables, sp.max_menu_items
    INTO v_plan
    FROM public.subscriptions s
    JOIN public.subscription_plans sp ON sp.id = s.plan_id
   WHERE s.restaurant_id = p_restaurant_id
   ORDER BY s.created_at DESC
   LIMIT 1;

  v_panels := COALESCE(v_plan.allowed_panels, '[]'::jsonb);

  SELECT COALESCE(jsonb_agg(pa.panel), '[]'::jsonb)
    INTO v_addon_panels
    FROM public.restaurant_addons ra
    JOIN public.plan_addons pa ON pa.key = ra.addon_key
   WHERE ra.restaurant_id = p_restaurant_id AND ra.enabled = true;

  SELECT COALESCE(jsonb_agg(ra.addon_key), '[]'::jsonb)
    INTO v_addons
    FROM public.restaurant_addons ra
   WHERE ra.restaurant_id = p_restaurant_id AND ra.enabled = true;

  -- Overrides crudos del restaurante (mapa key→enabled), '{}' si no hay.
  SELECT COALESCE(jsonb_object_agg(key, enabled), '{}'::jsonb)
    INTO v_overrides
    FROM public.restaurant_feature_overrides
   WHERE restaurant_id = p_restaurant_id;

  -- Base de paneles. Si el plan NO restringe (allowed_panels null/vacío y sin
  -- add-ons) → TODOS los conocidos (fail-open, consistente con is_panel_enabled y
  -- con los self-gates de gerente/delivery). Si restringe → plan ∪ add-ons ∪ 'admin'.
  IF (v_panels IS NULL OR jsonb_array_length(v_panels) = 0)
     AND jsonb_array_length(v_addon_panels) = 0 THEN
    v_base_panels := '["caja","mozo","cocina","gerente","delivery-cliente","delivery-rider","admin"]'::jsonb;
  ELSE
    SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb)
      INTO v_base_panels
      FROM (
        SELECT jsonb_array_elements_text(v_panels)       AS p
        UNION SELECT jsonb_array_elements_text(v_addon_panels)
        UNION SELECT 'admin'
      ) u;
  END IF;

  -- Efectivo = base − overrides(false) + overrides(true).
  SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb)
    INTO v_eff_panels
    FROM (
      SELECT b.p
        FROM (SELECT jsonb_array_elements_text(v_base_panels) AS p) b
       WHERE NOT EXISTS (
         SELECT 1 FROM public.restaurant_feature_overrides o
          WHERE o.restaurant_id = p_restaurant_id
            AND o.key = 'panel:' || b.p AND o.enabled = false)
      UNION
      SELECT substring(o.key FROM 7)
        FROM public.restaurant_feature_overrides o
       WHERE o.restaurant_id = p_restaurant_id
         AND o.key LIKE 'panel:%' AND o.enabled = true
    ) e;

  -- Multi-sucursal (idéntico a la mig 108).
  SELECT r.parent_company_id, COALESCE(r.parent_company_id, r.id)
    INTO v_parent, v_root
    FROM public.restaurants r WHERE r.id = p_restaurant_id;

  SELECT COALESCE(jsonb_agg(
            jsonb_build_object('id', b.id, 'name', b.name, 'city', b.city,
                               'is_root', (b.id = v_root))
            ORDER BY (b.id = v_root) DESC, b.name
         ), '[]'::jsonb),
         COUNT(*)
    INTO v_branches, v_branch_count
    FROM public.restaurants b
   WHERE b.id = v_root OR b.parent_company_id = v_root;

  SELECT COALESCE(SUM(COALESCE(ra.quantity, 1)), 0)
    INTO v_extra
    FROM public.restaurant_addons ra
   WHERE ra.restaurant_id = v_root AND ra.addon_key = 'sucursal_extra' AND ra.enabled = true;
  v_max_branches := 1 + COALESCE(v_extra, 0);

  RETURN jsonb_build_object(
    'allowed_panels',      v_eff_panels,          -- EFECTIVO (con overrides)
    'plan_panels',         v_base_panels,         -- base sin overrides (para UI "fuente")
    'overrides',           v_overrides,           -- mapa crudo key→enabled
    'allowed_features',    v_plan.allowed_features,
    'addons',              v_addons,
    'max_users_by_role',   COALESCE(v_plan.max_users_by_role, '{}'::jsonb),
    'max_tables',          v_plan.max_tables,
    'max_menu_items',      v_plan.max_menu_items,
    'parent_company_id',   v_parent,
    'company_root_id',     v_root,
    'is_root',             (p_restaurant_id = v_root),
    'branches',            v_branches,
    'branch_count',        v_branch_count,
    'max_branches',        v_max_branches,
    'branches_over_limit', (v_branch_count > v_max_branches)
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_restaurant_capabilities(UUID) TO authenticated, anon;

-- ── PARTE A.4 — is_panel_enabled: gate de acceso por panel (anon-safe) ─
-- Consistente con los self-gates que YA existen en gerente/delivery-rider/
-- delivery-cliente (leen allowed_panels): override manda; admin siempre activo
-- salvo override; si el plan NO tiene restricción (allowed_panels null/vacío y
-- sin add-ons) → FAIL-OPEN (true); si el plan define paneles → membresía en
-- (plan ∪ add-ons). El front interpreta null/err como permitido (mismo criterio
-- fail-open que mythos-gating.js). El empty-array fail-open evita bloquear todo
-- por un plan con allowed_panels='[]' (default de la columna).
CREATE OR REPLACE FUNCTION public.is_panel_enabled(p_restaurant_id UUID, p_panel TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_ovr    BOOLEAN;
  v_panels JSONB;
  v_addons JSONB;
BEGIN
  IF p_restaurant_id IS NULL OR COALESCE(p_panel, '') = '' THEN
    RETURN true;                          -- sin dato suficiente → fail-open
  END IF;

  -- 1) Override explícito manda (ON u OFF).
  SELECT enabled INTO v_ovr
    FROM public.restaurant_feature_overrides
   WHERE restaurant_id = p_restaurant_id AND key = 'panel:' || p_panel;
  IF FOUND THEN RETURN v_ovr; END IF;

  -- 2) admin: panel del dueño, siempre activo salvo override.
  IF p_panel = 'admin' THEN RETURN true; END IF;

  -- 3) Plan + add-ons.
  SELECT sp.allowed_panels INTO v_panels
    FROM public.subscriptions s
    JOIN public.subscription_plans sp ON sp.id = s.plan_id
   WHERE s.restaurant_id = p_restaurant_id
   ORDER BY s.created_at DESC
   LIMIT 1;
  SELECT COALESCE(jsonb_agg(pa.panel), '[]'::jsonb) INTO v_addons
    FROM public.restaurant_addons ra
    JOIN public.plan_addons pa ON pa.key = ra.addon_key
   WHERE ra.restaurant_id = p_restaurant_id AND ra.enabled = true;

  -- 4) Sin restricción (plan null/vacío y sin add-ons) → fail-open.
  IF (v_panels IS NULL OR jsonb_array_length(v_panels) = 0)
     AND jsonb_array_length(v_addons) = 0 THEN
    RETURN true;
  END IF;

  RETURN (COALESCE(v_panels, '[]'::jsonb) ? p_panel) OR (v_addons ? p_panel);
END;
$$;
REVOKE ALL     ON FUNCTION public.is_panel_enabled(UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.is_panel_enabled(UUID, TEXT) TO anon, authenticated;

-- ── PARTE B — Borrado seguro del restaurante (transacción única) ─────
-- Fail-closed: superadmin autenticado O service_role (el endpoint api/ ya
-- valida al llamador). Orden de FKs: orders (RESTRICT) → user_profiles (NO
-- ACTION, tabla legacy; sólo si existe) → restaurants (cascada el resto).
-- NO borra auth.users (lo hace el endpoint con la Admin API). NO borra las
-- sucursales hijas (parent_company_id es ON DELETE SET NULL). Devuelve resumen.
CREATE OR REPLACE FUNCTION public.superadmin_delete_restaurant(p_restaurant_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name      text;
  v_orders    int := 0;
  v_users     int := 0;
  v_children  int := 0;
  v_jwt_role  text;
BEGIN
  v_jwt_role := COALESCE(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  IF NOT (COALESCE(public.get_my_role() = 'superadmin', false) OR v_jwt_role = 'service_role') THEN
    RAISE EXCEPTION 'Solo el superadmin puede eliminar restaurantes' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT name INTO v_name FROM public.restaurants WHERE id = p_restaurant_id;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Restaurante inexistente';
  END IF;

  -- Resumen antes de borrar.
  SELECT count(*) INTO v_orders   FROM public.orders     WHERE restaurant_id = p_restaurant_id;
  SELECT count(*) INTO v_users    FROM public.user_roles WHERE restaurant_id = p_restaurant_id;
  SELECT count(*) INTO v_children FROM public.restaurants WHERE parent_company_id = p_restaurant_id AND id <> p_restaurant_id;

  -- 1) Pedidos (orders.restaurant_id RESTRICT) — cascada order_items/extras/
  --    status_history/delivery_orders; SET NULL en caja/ratings/etc.
  DELETE FROM public.orders WHERE restaurant_id = p_restaurant_id;

  -- 2) user_profiles (tabla PIN legacy, NO ACTION) — sólo si existe en el esquema.
  IF to_regclass('public.user_profiles') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.user_profiles WHERE restaurant_id = $1' USING p_restaurant_id;
  END IF;

  -- 2b) staff_broadcasts: tiene restaurant_id pero SIN FK a restaurants (mig 085b)
  --     → no cascada. Se borra explícito para no dejar avisos internos huérfanos.
  --     (availability_log SÍ cascada vía menu_item_id, no hace falta acá.)
  IF to_regclass('public.staff_broadcasts') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.staff_broadcasts WHERE restaurant_id = $1' USING p_restaurant_id;
  END IF;

  -- 3) Restaurante — cascada TODO lo demás (tables/menu/subs/turnos/stock/
  --    delivery/user_roles/reservations/kitchen/marketplace/fiscal/overrides…).
  DELETE FROM public.restaurants WHERE id = p_restaurant_id;

  RETURN jsonb_build_object(
    'restaurant_id',      p_restaurant_id,
    'name',               v_name,
    'orders_deleted',     v_orders,
    'user_roles_deleted', v_users,
    'children_detached',  v_children
  );
END;
$$;
REVOKE ALL     ON FUNCTION public.superadmin_delete_restaurant(UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.superadmin_delete_restaurant(UUID) TO authenticated;

COMMIT;

-- Recargar el cache de esquema de PostgREST.
NOTIFY pgrst, 'reload schema';

SELECT 'migration 146 applied — restaurant_feature_overrides + capabilities overrides + is_panel_enabled + superadmin_delete_restaurant' AS status;
