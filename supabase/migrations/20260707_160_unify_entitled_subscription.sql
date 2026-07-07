-- ════════════════════════════════════════════════════════════════════
-- 160 · Regla canónica de "suscripción habilitante" (con días de gracia)
-- ════════════════════════════════════════════════════════════════════
-- [PARA PEGAR EN SUPABASE]  ·  rol postgres, SQL Editor en INGLÉS, tras backup.
--
-- PROBLEMA (QA): la UI (topes/paneles) y los triggers de límite resolvían la
-- suscripción/plan de formas DISTINTAS → divergían. Introspección viva 2026-07-07:
--   · get_restaurant_capabilities (mig 155)  → última sub por created_at, SIN status
--   · is_panel_enabled            (mig 155)  → última sub por created_at, SIN status
--   · enforce_role_user_limit     (mig 090)  → última sub por created_at, SIN status
--   · fn_enforce_table_limit      (mig 159)  → AND s.status='active'
--   · enforce_menu_item_limit     (VIVO)     → SIN status  ⟵ la mig 157 (que lo
--       agregaba) NO quedó aplicada sobre esta función; M10 "pasó" en QA sólo
--       porque la sub más nueva del local de prueba era la activa (coincidencia).
-- Es decir: 5 resolvers, 5 criterios mezclados. Un local con la sub más nueva NO
-- activa mostraba un plan en la UI y otro en el enforcement.
--
-- DECISIÓN DE NEGOCIO (Renato): habrá DÍAS DE GRACIA. Estados que HABILITAN =
--   status IN ('active','past_due')  (un pago vencido sigue operando durante la
-- gracia; el corte a cancelled/suspended lo hace Renato a mano hasta automatizar
-- el cobro). El corte, entonces, es "no tener ninguna sub active/past_due".
--
-- FIX (anti-drift): UNA sola fuente de la regla — el helper
--   resolve_entitled_plan_id(restaurant_id) = plan_id de la sub MÁS NUEVA con
--   status IN ('active','past_due')  (NULL si no hay ninguna).
-- Los 5 resolvers pasan a resolver el plan por ESE helper. Cambia SOLO la
-- resolución de la suscripción; se preserva TODO lo demás de cada función
-- (guards, overrides, multi-sucursal, mensajes, grants). CREATE OR REPLACE
-- idempotente; los triggers existentes siguen apuntando a la misma función.
--
-- IMPACTO esperado:
--   · Los 3 planes activos (Emprendedor/Consolidado/Premium) gatean IDÉNTICO:
--     para un local cuya sub más nueva ES activa, "más nueva" == "más nueva
--     entitled" → mismo plan que antes.
--   · Sub más nueva en past_due → sigue habilitado en UI y en límites (gracia).
--   · Sin sub active/past_due (cancelled/suspended/nada) → helper NULL →
--     capabilities sin plan, triggers no limitan (RETURN NEW), paneles fail-closed
--     (solo 'admin'). Es el corte.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 0. Helper canónico: la sub habilitante (más nueva active/past_due) ──────
CREATE OR REPLACE FUNCTION public.resolve_entitled_plan_id(p_restaurant_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.plan_id
  FROM public.subscriptions s
  WHERE s.restaurant_id = p_restaurant_id
    AND s.status IN ('active','past_due')
  ORDER BY s.created_at DESC
  LIMIT 1;
$$;
-- Interno: lo llaman funciones SECURITY DEFINER (dueño postgres). Nadie más.
REVOKE ALL ON FUNCTION public.resolve_entitled_plan_id(uuid) FROM PUBLIC;

-- ── 1. get_restaurant_capabilities (mig 155) — resuelve por el helper ───────
-- Verbatim de la mig 155, con UN solo cambio: el SELECT de la sub/plan pasa a
-- WHERE sp.id = resolve_entitled_plan_id(...). Todo el resto es idéntico.
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
  -- GUARD tenant-safe (mig 108): superadmin global; el resto solo su cuenta
  -- corporativa; anon/sin rol/cross-tenant → NULL (fail-closed).
  IF NOT COALESCE(
       public.get_my_role() = 'superadmin'
       OR p_restaurant_id IN (SELECT public.get_my_company_restaurant_ids()),
       false)
  THEN
    RETURN NULL;
  END IF;

  -- Plan vigente = plan de la sub HABILITANTE (regla canónica mig 160).
  SELECT sp.allowed_panels, sp.allowed_features, sp.max_users_by_role, sp.max_tables, sp.max_menu_items
    INTO v_plan
    FROM public.subscription_plans sp
   WHERE sp.id = public.resolve_entitled_plan_id(p_restaurant_id);

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

  -- Base de paneles = plan ∪ add-ons ∪ 'admin'  (FAIL-CLOSED).
  -- Lista vacía/null (p.ej. Emprendedor, 0 POS) ⇒ base = ['admin']: solo el panel
  -- del dueño + el Menú QR del cliente (que no es un panel gateado). NUNCA "todos".
  SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb)
    INTO v_base_panels
    FROM (
      SELECT jsonb_array_elements_text(v_panels)       AS p
      UNION SELECT jsonb_array_elements_text(v_addon_panels)
      UNION SELECT 'admin'
    ) u;

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

  -- Multi-sucursal (idéntico a la mig 146/155).
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

-- ── 2. is_panel_enabled (mig 155) — resuelve por el helper ──────────────────
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

  -- 3) Plan HABILITANTE (regla canónica mig 160) + add-ons.
  SELECT sp.allowed_panels INTO v_panels
    FROM public.subscription_plans sp
   WHERE sp.id = public.resolve_entitled_plan_id(p_restaurant_id);
  SELECT COALESCE(jsonb_agg(pa.panel), '[]'::jsonb) INTO v_addons
    FROM public.restaurant_addons ra
    JOIN public.plan_addons pa ON pa.key = ra.addon_key
   WHERE ra.restaurant_id = p_restaurant_id AND ra.enabled = true;

  -- 4) Membresía en (plan ∪ add-ons)  (FAIL-CLOSED). Lista vacía/null ⇒ ningún
  --    panel POS (solo 'admin', ya resuelto arriba). NUNCA fail-open a "todos".
  RETURN (COALESCE(v_panels, '[]'::jsonb) ? p_panel) OR (v_addons ? p_panel);
END;
$$;
REVOKE ALL     ON FUNCTION public.is_panel_enabled(UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.is_panel_enabled(UUID, TEXT) TO anon, authenticated;

-- ── 3. enforce_menu_item_limit — resuelve por el helper ─────────────────────
-- (El vivo NO filtraba status; la mig 157 no quedó aplicada. Acá se canoniza.)
CREATE OR REPLACE FUNCTION public.enforce_menu_item_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_limit INT;
  v_count INT;
BEGIN
  IF NEW.restaurant_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT sp.max_menu_items
    INTO v_limit
    FROM public.subscription_plans sp
   WHERE sp.id = public.resolve_entitled_plan_id(NEW.restaurant_id);

  IF v_limit IS NULL THEN
    RETURN NEW;   -- sin plan habilitante con tope → ilimitado
  END IF;

  SELECT COUNT(*) INTO v_count
    FROM public.menu_items
   WHERE restaurant_id = NEW.restaurant_id;

  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'Alcanzaste el máximo de ítems de tu plan (%). Ampliá tu plan para cargar más productos.', v_limit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- ── 4. fn_enforce_table_limit — resuelve por el helper ──────────────────────
CREATE OR REPLACE FUNCTION public.fn_enforce_table_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_max int; v_cnt int;
BEGIN
  SELECT sp.max_tables INTO v_max
  FROM public.subscription_plans sp
  WHERE sp.id = public.resolve_entitled_plan_id(NEW.restaurant_id);
  IF v_max IS NULL THEN RETURN NEW; END IF;            -- sin plan habilitante → no limita
  SELECT count(*) INTO v_cnt FROM public.tables WHERE restaurant_id = NEW.restaurant_id;
  IF v_cnt >= v_max THEN
    RAISE EXCEPTION 'Límite de mesas del plan alcanzado (% mesas).', v_max
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ── 5. enforce_role_user_limit — resuelve por el helper ─────────────────────
CREATE OR REPLACE FUNCTION public.enforce_role_user_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_limit INT;
  v_count INT;
BEGIN
  IF NEW.restaurant_id IS NULL
     OR NEW.role NOT IN ('mozo','cajero','cocina','rider')
     OR COALESCE(NEW.is_active, true) = false THEN
    RETURN NEW;
  END IF;

  SELECT (sp.max_users_by_role ->> NEW.role)::INT
    INTO v_limit
    FROM public.subscription_plans sp
   WHERE sp.id = public.resolve_entitled_plan_id(NEW.restaurant_id);

  IF v_limit IS NULL THEN
    RETURN NEW;   -- plan sin límite para este rol → ilimitado
  END IF;

  SELECT COUNT(*) INTO v_count
    FROM public.user_roles
   WHERE restaurant_id = NEW.restaurant_id
     AND role = NEW.role
     AND is_active = true;

  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'Límite de % alcanzado para el plan actual (máx %)', NEW.role, v_limit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;

-- ── Verificación (correr aparte, como postgres/superadmin) ───────────────────
-- (a) El helper existe y resuelve la sub habilitante:
--   SELECT public.resolve_entitled_plan_id('<restaurant_uuid>');
-- (b) Los 5 ahora resuelven por el helper (ninguno arma su propio SELECT de subs):
--   SELECT p.proname, (position('resolve_entitled_plan_id' in pg_get_functiondef(p.oid)) > 0) AS usa_helper
--   FROM pg_proc p
--   WHERE p.pronamespace='public'::regnamespace
--     AND p.proname IN ('get_restaurant_capabilities','is_panel_enabled',
--                       'enforce_role_user_limit','enforce_menu_item_limit','fn_enforce_table_limit')
--   ORDER BY p.proname;   -- esperado: las 5 en true
SELECT 'migration 160 applied — entitled subscription unified: status IN (active, past_due)' AS status;
