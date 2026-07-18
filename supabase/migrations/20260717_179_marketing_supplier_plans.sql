-- ════════════════════════════════════════════════════════════════════
-- 179 · marketing_supplier_plans — Vidriera pública de planes de proveedor (PR-SP3·A)
-- ────────────────────────────────────────────────────────────────────
-- Capa "vidriera" (lo que ve el PÚBLICO en la web), espejo de marketing_plans
-- (mig 110/153/154) pero para proveedores. El operativo (marketplace_supplier_plans,
-- mig 177) NO es legible por anon; esta tabla SÍ (solo is_active=true) y es la
-- fuente que lee public/proveedores.html. Cuando la fila está LINKEADA al operativo
-- (supplier_plan_slug), el precio y el plan_config se DERIVAN solos (trigger) —
-- "gana el panel"; el nombre/badge/headline/orden los editás aparte.
--
-- Además, para el flujo elegido por Renato ("el proveedor ELIGE el plan antes del
-- formulario y arranca con ese"), esta migración:
--   · agrega marketplace_applications.plan_slug (el plan que eligió el proveedor);
--   · actualiza submit_supplier_application (única RPC anon) para capturarlo
--     (validación blanda: si el slug no existe, se guarda NULL — no frena el alta).
-- El endpoint de aprobación (api/approve-supplier.js) usará ese plan como default.
--
-- Contenido:
--   1. Tabla public.marketing_supplier_plans (+ índice, RLS anon-read is_active).
--   2. Trigger sync_marketing_supplier_plan: deriva price/plan_config del operativo.
--   3. Seed 3 filas linkeadas a basico/profesional/premium (recomendado=profesional).
--   4. ALTER marketplace_applications ADD plan_slug.
--   5. CREATE OR REPLACE submit_supplier_application (verbatim mig 142 + plan_slug).
--
-- PREPARED — NOT APPLIED: aplicar A MANO en el SQL Editor (INGLÉS) tras backup,
--   DESPUÉS de la 177. Idempotente.
-- Revertir:
--   ALTER TABLE public.marketplace_applications DROP COLUMN IF EXISTS plan_slug;
--   -- restaurar submit_supplier_application a la versión de la mig 142 (sin plan_slug)
--   DROP TRIGGER trg_sync_marketing_supplier_plan ON public.marketing_supplier_plans;
--   DROP FUNCTION public.sync_marketing_supplier_plan();
--   DROP TABLE public.marketing_supplier_plans;
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. Tabla vidriera ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.marketing_supplier_plans (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text UNIQUE NOT NULL,
  name               text NOT NULL,
  headline           text,
  description        text,
  price_monthly_gs   bigint,
  price_annual_gs    bigint,
  currency           text NOT NULL DEFAULT 'PYG',
  features           jsonb NOT NULL DEFAULT '[]'::jsonb,
  badge              text,
  is_recommended     boolean NOT NULL DEFAULT false,
  is_active          boolean NOT NULL DEFAULT true,
  sort_order         int NOT NULL DEFAULT 0,
  supplier_plan_slug text REFERENCES public.marketplace_supplier_plans(slug),
  plan_config        jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketing_supplier_plans_active
  ON public.marketing_supplier_plans (sort_order) WHERE is_active = true;

DROP TRIGGER IF EXISTS trg_mkt_supplier_plans_updated_at ON public.marketing_supplier_plans;
CREATE TRIGGER trg_mkt_supplier_plans_updated_at
  BEFORE UPDATE ON public.marketing_supplier_plans
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 2. Sync: derivar precio + plan_config del operativo cuando está linkeado ──
-- Espejo de mkt_pull_plan_config (mig 153/154). BEFORE INSERT/UPDATE: si hay
-- supplier_plan_slug, price_monthly = price_gs, price_annual = price_gs*10, y
-- plan_config = limits del plan operativo (para armar la lista "incluye").
CREATE OR REPLACE FUNCTION public.sync_marketing_supplier_plan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sp public.marketplace_supplier_plans;
BEGIN
  IF NEW.supplier_plan_slug IS NOT NULL THEN
    SELECT * INTO v_sp FROM public.marketplace_supplier_plans WHERE slug = NEW.supplier_plan_slug;
    IF FOUND THEN
      NEW.price_monthly_gs := v_sp.price_gs;
      NEW.price_annual_gs  := v_sp.price_gs * 10;
      NEW.plan_config      := v_sp.limits;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_marketing_supplier_plan ON public.marketing_supplier_plans;
CREATE TRIGGER trg_sync_marketing_supplier_plan
  BEFORE INSERT OR UPDATE ON public.marketing_supplier_plans
  FOR EACH ROW EXECUTE FUNCTION public.sync_marketing_supplier_plan();

-- ─── 3. RLS (espejo de marketing_plans, mig 110): anon lee is_active; super ALL ──
ALTER TABLE public.marketing_supplier_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_supplier_plans_public_read" ON public.marketing_supplier_plans;
CREATE POLICY "marketing_supplier_plans_public_read" ON public.marketing_supplier_plans
  FOR SELECT TO anon, authenticated
  USING (is_active = true);

DROP POLICY IF EXISTS "marketing_supplier_plans_superadmin_all" ON public.marketing_supplier_plans;
CREATE POLICY "marketing_supplier_plans_superadmin_all" ON public.marketing_supplier_plans
  FOR ALL TO authenticated
  USING      (COALESCE(public.get_my_role() = 'superadmin', false))
  WITH CHECK (COALESCE(public.get_my_role() = 'superadmin', false));

REVOKE ALL ON public.marketing_supplier_plans FROM anon;
GRANT SELECT ON public.marketing_supplier_plans TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_supplier_plans TO authenticated;

-- ─── 4. Seed (linkeado al operativo; el trigger deriva precio/plan_config) ──
-- ON CONFLICT DO NOTHING: no pisa ediciones vivas en re-ejecución.
INSERT INTO public.marketing_supplier_plans
  (slug, name, headline, description, currency, badge, is_recommended, sort_order, supplier_plan_slug, features)
VALUES
  ('basico', 'Básico',
   'Empezá a recibir consultas',
   'Tu tienda en el marketplace, lista para recibir contactos de restaurantes.',
   'PYG', NULL, false, 1, 'basico',
   '["Perfil de proveedor en el marketplace","Hasta 10 productos","1 usuario","1 categoría y 1 zona de cobertura","Contacto de leads con demora (24 h)"]'::jsonb),

  ('profesional', 'Profesional',
   'El plan que más venden',
   'Contacto inmediato con los restaurantes y más catálogo para destacar.',
   'PYG', 'Recomendado', true, 2, 'profesional',
   '["Hasta 50 productos","Hasta 3 usuarios","3 categorías y 3 zonas","Contacto de leads inmediato","1 espacio destacado","Analítica básica","Hasta 3 catálogos PDF"]'::jsonb),

  ('premium', 'Premium',
   'Máxima visibilidad y prioridad',
   'Todo ilimitado, prioridad en los leads y tu marca destacada.',
   'PYG', NULL, false, 3, 'premium',
   '["Productos ilimitados","Usuarios ilimitados","Categorías y zonas ilimitadas","Contacto inmediato y prioritario","Destacados ilimitados","Analítica completa","Banner de marca","Catálogos PDF ilimitados"]'::jsonb)
ON CONFLICT (slug) DO NOTHING;

-- ─── 5. Solicitudes: guardar el plan elegido por el proveedor ───────
ALTER TABLE public.marketplace_applications
  ADD COLUMN IF NOT EXISTS plan_slug text;

-- ─── 6. submit_supplier_application — VERBATIM mig 142 + captura de plan_slug ──
-- Se reproduce entera (CREATE OR REPLACE) con 3 agregados marcados "-- SP3":
--   (a) v_plan en DECLARE; (b) validación blanda del slug; (c) plan_slug en el INSERT.
CREATE OR REPLACE FUNCTION public.submit_supplier_application(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_nombre text := NULLIF(btrim(COALESCE(payload->>'nombre_comercial','')),'');
  v_email  text := lower(NULLIF(btrim(COALESCE(payload->>'email','')),''));
  v_ruc    text := NULLIF(btrim(COALESCE(payload->>'ruc','')),'');
  v_tel    text := NULLIF(btrim(COALESCE(payload->>'telefono','')),'');
  v_wa     text := NULLIF(btrim(COALESCE(payload->>'whatsapp','')),'');
  v_tipo   text := NULLIF(btrim(COALESCE(payload->>'tipo_proveedor','')),'');
  v_acepta boolean := COALESCE((payload->>'acepta_terminos')::boolean, false);
  v_cats   text[];
  v_valid_cats text[];
  v_zonas  text[];
  v_plan   text := NULLIF(btrim(COALESCE(payload->>'plan_slug','')),'');   -- SP3 (a)
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload) <> 'object' THEN
    RAISE EXCEPTION 'solicitud inválida' USING ERRCODE = '22023';
  END IF;

  -- Obligatorios (fail-closed, server-side)
  IF v_nombre IS NULL OR length(v_nombre) > 120 THEN
    RAISE EXCEPTION 'nombre_comercial requerido' USING ERRCODE = '22023';
  END IF;
  IF v_email IS NULL OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' OR length(v_email) > 160 THEN
    RAISE EXCEPTION 'email inválido' USING ERRCODE = '22023';
  END IF;
  IF v_ruc IS NULL OR length(v_ruc) > 30 THEN
    RAISE EXCEPTION 'ruc requerido' USING ERRCODE = '22023';
  END IF;
  IF v_tel IS NULL AND v_wa IS NULL THEN
    RAISE EXCEPTION 'indicá teléfono o WhatsApp' USING ERRCODE = '22023';
  END IF;
  IF NOT v_acepta THEN
    RAISE EXCEPTION 'debés aceptar los términos y condiciones' USING ERRCODE = '22023';
  END IF;
  IF v_tipo IS NOT NULL AND v_tipo NOT IN
     ('productor','distribuidor','mayorista','minorista','importador','fabricante','servicio') THEN
    RAISE EXCEPTION 'tipo_proveedor inválido' USING ERRCODE = '22023';
  END IF;

  -- SP3 (b): plan elegido — validación blanda (slug inexistente → NULL, no frena el alta).
  IF v_plan IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.marketplace_supplier_plans WHERE slug = v_plan
  ) THEN
    v_plan := NULL;
  END IF;

  -- Categorías: deben venir como array JSON; se filtran contra el catálogo
  -- activo; mínimo 1 válida
  IF jsonb_typeof(COALESCE(payload->'categorias','[]'::jsonb)) <> 'array'
     OR jsonb_typeof(COALESCE(payload->'zonas_entrega','[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'categorias/zonas_entrega inválidas' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(t.v), '{}') INTO v_cats
    FROM (SELECT value AS v
            FROM jsonb_array_elements_text(COALESCE(payload->'categorias','[]'::jsonb))
           LIMIT 20) t;
  SELECT COALESCE(array_agg(c.slug), '{}') INTO v_valid_cats
    FROM public.marketplace_categories c
   WHERE c.activa = true AND c.slug = ANY(v_cats);
  IF COALESCE(array_length(v_valid_cats,1),0) < 1 THEN
    RAISE EXCEPTION 'elegí al menos una categoría válida' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(t.v), '{}') INTO v_zonas
    FROM (SELECT left(value,80) AS v
            FROM jsonb_array_elements_text(COALESCE(payload->'zonas_entrega','[]'::jsonb))
           LIMIT 20) t;

  -- Dedupe blando: misma ruc o email con una solicitud aún abierta
  IF EXISTS (
    SELECT 1 FROM public.marketplace_applications a
    WHERE a.estado IN ('pendiente','en_revision')
      AND (lower(a.email) = v_email OR a.ruc = v_ruc)
  ) THEN
    RAISE EXCEPTION 'solicitud ya registrada' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.marketplace_applications (
    nombre_comercial, razon_social, ruc, tipo_proveedor, rubro_principal,
    anhos_mercado, ciudad, departamento, direccion, web_redes,
    contacto_nombre, contacto_cargo, telefono, whatsapp, email,
    categorias, productos_principales, marcas, vende_mayor, vende_menor,
    zonas_entrega, delivery_propio, retiro_local, dias_entrega, pedido_minimo,
    entrega_urgente, acepta_credito, emite_factura, precio_visible,
    acepta_nuevos_clientes, catalogo_url, mensaje, acepta_terminos,
    plan_slug, estado, origen
  ) VALUES (
    v_nombre,
    left(NULLIF(btrim(COALESCE(payload->>'razon_social','')),''), 160),
    v_ruc,
    v_tipo,
    left(NULLIF(btrim(COALESCE(payload->>'rubro_principal','')),''), 120),
    NULLIF(btrim(COALESCE(payload->>'anhos_mercado','')),'')::int,
    left(NULLIF(btrim(COALESCE(payload->>'ciudad','')),''), 80),
    left(NULLIF(btrim(COALESCE(payload->>'departamento','')),''), 80),
    left(NULLIF(btrim(COALESCE(payload->>'direccion','')),''), 200),
    left(NULLIF(btrim(COALESCE(payload->>'web_redes','')),''), 200),
    left(NULLIF(btrim(COALESCE(payload->>'contacto_nombre','')),''), 120),
    left(NULLIF(btrim(COALESCE(payload->>'contacto_cargo','')),''), 80),
    left(v_tel, 40),
    left(v_wa, 40),
    v_email,
    v_valid_cats,
    left(NULLIF(btrim(COALESCE(payload->>'productos_principales','')),''), 1000),
    left(NULLIF(btrim(COALESCE(payload->>'marcas','')),''), 400),
    COALESCE((payload->>'vende_mayor')::boolean, false),
    COALESCE((payload->>'vende_menor')::boolean, false),
    v_zonas,
    COALESCE((payload->>'delivery_propio')::boolean, false),
    COALESCE((payload->>'retiro_local')::boolean, false),
    left(NULLIF(btrim(COALESCE(payload->>'dias_entrega','')),''), 120),
    left(NULLIF(btrim(COALESCE(payload->>'pedido_minimo','')),''), 120),
    COALESCE((payload->>'entrega_urgente')::boolean, false),
    COALESCE((payload->>'acepta_credito')::boolean, false),
    COALESCE((payload->>'emite_factura')::boolean, false),
    COALESCE((payload->>'precio_visible')::boolean, false),
    COALESCE((payload->>'acepta_nuevos_clientes')::boolean, true),
    left(NULLIF(btrim(COALESCE(payload->>'catalogo_url','')),''), 300),
    left(NULLIF(btrim(COALESCE(payload->>'mensaje','')),''), 3000),
    true,
    v_plan,          -- SP3 (c)
    'pendiente',
    'web'
  );

  INSERT INTO public.marketplace_events (event_type, metadata)
  VALUES ('application_submitted', jsonb_build_object('nombre_comercial', v_nombre, 'plan_slug', v_plan));

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_supplier_application(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_supplier_application(jsonb) TO anon, authenticated;

COMMIT;

-- Recargar el cache de esquema de PostgREST (tabla, policies, columna, función).
NOTIFY pgrst, 'reload schema';

SELECT 'migracion 179 aplicada (marketing_supplier_plans vidriera + applications.plan_slug + submit con plan elegido)' AS status;
