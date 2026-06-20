-- ════════════════════════════════════════════════════════════════════
-- 110 · MARKETING SITE — tablas del sitio web comercial (FASE WEB-2)
--       (PREPARED — NOT APPLIED: aplicar manualmente tras backup nuevo)
-- ────────────────────────────────────────────────────────────────────
-- Base dinámica del sitio público MYTHOS (ver public/web.html y resto del
-- shell estático de WEB-1). En WEB-3 el sitio leerá estas tablas (planes,
-- add-ons, secciones, FAQs, testimonios, config) y desde el módulo
-- Superadmin "Sitio web" (WEB-6) se editarán; los leads/eventos del sitio
-- se verán desde Superadmin.
--
-- ALCANCE / SEGURIDAD:
--   • 100% ADITIVA: solo CREATE TABLE IF NOT EXISTS de tablas NUEVAS
--     (prefijo marketing_*) + sus policies/grants/seeds. NO altera ninguna
--     tabla, policy, grant, función o dato existente → NO destructiva.
--   • NO toca Auth core, Login, paneles, `/` (cliente QR) ni datos demo.
--   • RLS obligatoria en las 8 tablas (fail-closed: sin policy = denegado).
--   • Lectura pública (anon + authenticated) SOLO de filas activas de los
--     catálogos; marketing_config solo donde is_public=true.
--   • anon puede INSERT en marketing_leads / marketing_events; NO SELECT.
--   • Escritura/edición total y lectura de leads/eventos: SOLO superadmin.
--
-- Helper reutilizado (ya existe): public.get_my_role()  [mig 029]
--   → devuelve el rol del usuario autenticado ('superadmin', 'admin', …)
--     o NULL para anon. Mismo criterio que migs 103/104. No se crea ningún
--     helper nuevo de superadmin (no hace falta).
--
-- Idempotente: CREATE TABLE IF NOT EXISTS + DROP POLICY IF EXISTS + CREATE,
-- seeds con ON CONFLICT DO NOTHING / WHERE NOT EXISTS. Seguro de re-correr.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- 1. marketing_plans — planes de la vidriera (catálogo público)
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.marketing_plans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  slug              text UNIQUE NOT NULL,
  headline          text,
  description       text,
  price_monthly_gs  integer,
  price_annual_gs   integer,
  currency          text NOT NULL DEFAULT 'PYG',
  features          jsonb NOT NULL DEFAULT '[]'::jsonb,
  badge             text,
  is_recommended    boolean NOT NULL DEFAULT false,
  is_enterprise     boolean NOT NULL DEFAULT false,
  is_active         boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketing_plans_active
  ON public.marketing_plans (sort_order) WHERE is_active = true;

ALTER TABLE public.marketing_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_plans_public_read" ON public.marketing_plans;
CREATE POLICY "marketing_plans_public_read" ON public.marketing_plans
  FOR SELECT TO anon, authenticated
  USING (is_active = true);

DROP POLICY IF EXISTS "marketing_plans_superadmin_all" ON public.marketing_plans;
CREATE POLICY "marketing_plans_superadmin_all" ON public.marketing_plans
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

REVOKE ALL ON public.marketing_plans FROM anon;
GRANT SELECT ON public.marketing_plans TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_plans TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- 2. marketing_add_ons — add-ons modulares (catálogo público)
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.marketing_add_ons (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  slug         text UNIQUE NOT NULL,
  description  text,
  price_gs     integer,
  price_type   text NOT NULL DEFAULT 'cuota'
                 CHECK (price_type IN ('cuota','comision','cotizar')),
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketing_add_ons_active
  ON public.marketing_add_ons (sort_order) WHERE is_active = true;

ALTER TABLE public.marketing_add_ons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_add_ons_public_read" ON public.marketing_add_ons;
CREATE POLICY "marketing_add_ons_public_read" ON public.marketing_add_ons
  FOR SELECT TO anon, authenticated
  USING (is_active = true);

DROP POLICY IF EXISTS "marketing_add_ons_superadmin_all" ON public.marketing_add_ons;
CREATE POLICY "marketing_add_ons_superadmin_all" ON public.marketing_add_ons
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

REVOKE ALL ON public.marketing_add_ons FROM anon;
GRANT SELECT ON public.marketing_add_ons TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_add_ons TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- 3. marketing_site_sections — bloques editables de contenido del sitio
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.marketing_site_sections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_key  text UNIQUE NOT NULL,
  title        text,
  subtitle     text,
  body         text,
  items        jsonb NOT NULL DEFAULT '[]'::jsonb,
  cta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketing_site_sections_active
  ON public.marketing_site_sections (sort_order) WHERE is_active = true;

ALTER TABLE public.marketing_site_sections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_site_sections_public_read" ON public.marketing_site_sections;
CREATE POLICY "marketing_site_sections_public_read" ON public.marketing_site_sections
  FOR SELECT TO anon, authenticated
  USING (is_active = true);

DROP POLICY IF EXISTS "marketing_site_sections_superadmin_all" ON public.marketing_site_sections;
CREATE POLICY "marketing_site_sections_superadmin_all" ON public.marketing_site_sections
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

REVOKE ALL ON public.marketing_site_sections FROM anon;
GRANT SELECT ON public.marketing_site_sections TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_site_sections TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- 4. marketing_faqs — preguntas frecuentes (catálogo público)
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.marketing_faqs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question     text NOT NULL,
  answer       text NOT NULL,
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketing_faqs_active
  ON public.marketing_faqs (sort_order) WHERE is_active = true;

ALTER TABLE public.marketing_faqs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_faqs_public_read" ON public.marketing_faqs;
CREATE POLICY "marketing_faqs_public_read" ON public.marketing_faqs
  FOR SELECT TO anon, authenticated
  USING (is_active = true);

DROP POLICY IF EXISTS "marketing_faqs_superadmin_all" ON public.marketing_faqs;
CREATE POLICY "marketing_faqs_superadmin_all" ON public.marketing_faqs
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

REVOKE ALL ON public.marketing_faqs FROM anon;
GRANT SELECT ON public.marketing_faqs TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_faqs TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- 5. marketing_testimonials — testimonios reales (catálogo público)
--    (sin seeds: no inventar prueba social; se cargan reales en WEB-6)
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.marketing_testimonials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_name    text NOT NULL,
  business_name  text,
  role           text,
  quote          text NOT NULL,
  avatar_url     text,
  is_active      boolean NOT NULL DEFAULT true,
  sort_order     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketing_testimonials_active
  ON public.marketing_testimonials (sort_order) WHERE is_active = true;

ALTER TABLE public.marketing_testimonials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_testimonials_public_read" ON public.marketing_testimonials;
CREATE POLICY "marketing_testimonials_public_read" ON public.marketing_testimonials
  FOR SELECT TO anon, authenticated
  USING (is_active = true);

DROP POLICY IF EXISTS "marketing_testimonials_superadmin_all" ON public.marketing_testimonials;
CREATE POLICY "marketing_testimonials_superadmin_all" ON public.marketing_testimonials
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

REVOKE ALL ON public.marketing_testimonials FROM anon;
GRANT SELECT ON public.marketing_testimonials TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_testimonials TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- 6. marketing_config — config del sitio (key/value); lectura pública
--    SOLO de filas is_public=true
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.marketing_config (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_public   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.marketing_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_config_public_read" ON public.marketing_config;
CREATE POLICY "marketing_config_public_read" ON public.marketing_config
  FOR SELECT TO anon, authenticated
  USING (is_public = true);

DROP POLICY IF EXISTS "marketing_config_superadmin_all" ON public.marketing_config;
CREATE POLICY "marketing_config_superadmin_all" ON public.marketing_config
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

REVOKE ALL ON public.marketing_config FROM anon;
GRANT SELECT ON public.marketing_config TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_config TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- 7. marketing_leads — captación del sitio (anon INSERT-only; lee superadmin)
--    anon NO puede SELECT/UPDATE/DELETE (sin grant + sin policy = denegado).
--    El frontend (WEB-5) debe insertar SIN encadenar .select() (return=minimal),
--    igual que reservations en mig 103 §12.
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.marketing_leads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type             text NOT NULL DEFAULT 'contact'
                     CHECK (type IN ('contact','demo','trial_interest','whatsapp','pricing')),
  name             text,
  business_name    text,
  email            text,
  whatsapp         text,
  message          text,
  plan_slug        text,
  selected_addons  jsonb NOT NULL DEFAULT '[]'::jsonb,
  source           text,
  utm              jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new','contacted','qualified','won','lost','spam')),
  internal_notes   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketing_leads_status
  ON public.marketing_leads (status, created_at DESC);

ALTER TABLE public.marketing_leads ENABLE ROW LEVEL SECURITY;

-- anon: SOLO crear leads nuevos; no puede prefijar estado ni notas internas.
DROP POLICY IF EXISTS "marketing_leads_anon_insert" ON public.marketing_leads;
CREATE POLICY "marketing_leads_anon_insert" ON public.marketing_leads
  FOR INSERT TO anon
  WITH CHECK (status = 'new' AND internal_notes IS NULL);

-- superadmin: gestión total (leer, triagear, marcar estado, notas).
DROP POLICY IF EXISTS "marketing_leads_superadmin_all" ON public.marketing_leads;
CREATE POLICY "marketing_leads_superadmin_all" ON public.marketing_leads
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- anon: SOLO INSERT (sin SELECT/UPDATE/DELETE). authenticated: gestión (RLS la
-- limita a superadmin). Sin GRANT SELECT a anon → no puede leer ni con bug.
REVOKE ALL ON public.marketing_leads FROM anon;
GRANT INSERT ON public.marketing_leads TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_leads TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- 8. marketing_events — analítica de actividad del sitio (anon INSERT-only)
--    append-only (sin updated_at). anon NO puede SELECT.
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.marketing_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name   text NOT NULL,
  page_path    text,
  plan_slug    text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  session_id   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketing_events_created
  ON public.marketing_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_events_name
  ON public.marketing_events (event_name, created_at DESC);

ALTER TABLE public.marketing_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_events_anon_insert" ON public.marketing_events;
CREATE POLICY "marketing_events_anon_insert" ON public.marketing_events
  FOR INSERT TO anon
  WITH CHECK (true);

DROP POLICY IF EXISTS "marketing_events_superadmin_all" ON public.marketing_events;
CREATE POLICY "marketing_events_superadmin_all" ON public.marketing_events
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

REVOKE ALL ON public.marketing_events FROM anon;
GRANT INSERT ON public.marketing_events TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_events TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- 9. SEMILLAS INICIALES (idempotentes — no pisan ediciones de Superadmin)
-- ════════════════════════════════════════════════════════════════════

-- ── Planes (vidriera) ────────────────────────────────────────────────
INSERT INTO public.marketing_plans
  (name, slug, headline, price_monthly_gs, price_annual_gs, features, badge, is_recommended, is_enterprise, sort_order)
VALUES
  ('MYTHOS Carta', 'carta', 'Tu carta, siempre lista', 99000, 990000,
   '["Menú digital QR","Productos ilimitados","Pedidos por WhatsApp","Analytics básico","1 sucursal incluida"]'::jsonb,
   NULL, false, false, 1),
  ('MYTHOS Servicio', 'servicio', 'Sala y cocina, sincronizadas', 229000, 2290000,
   '["Todo lo de Carta","Caja/POS","Cocina/KDS","Mesas y Mozos","Gestión de equipo","Soporte prioritario"]'::jsonb,
   'Recomendado', true, false, 2),
  ('MYTHOS Full', 'full', 'Control total', 399000, 3990000,
   '["Todo lo de Servicio","Delivery con tracking","Reservas","Analytics avanzado","Multi-usuario","Soporte 24/7"]'::jsonb,
   NULL, false, false, 3),
  ('MYTHOS Enterprise', 'enterprise', 'Cadenas y multi-local', NULL, NULL,
   '["Todo lo de Full","Multi-sucursal avanzado","Módulos a medida","Onboarding dedicado","SLA"]'::jsonb,
   NULL, false, true, 4)
ON CONFLICT (slug) DO NOTHING;

-- ── Add-ons ──────────────────────────────────────────────────────────
INSERT INTO public.marketing_add_ons
  (name, slug, description, price_gs, price_type, sort_order)
VALUES
  ('Cobro online con Bancard', 'bancard', 'Pagos online locales integrados.', 100000, 'cuota', 1),
  ('Facturación electrónica', 'facturacion-electronica', 'Comprobantes legales con tu RUC.', 150000, 'cuota', 2),
  ('Inventario y Recetas', 'inventario-recetas', 'Stock, costeo y proveedores.', 250000, 'cuota', 3),
  ('Delivery', 'delivery', 'Zonas, tarifas y tracking en vivo.', 350000, 'cuota', 4),
  ('Fidelización', 'fidelizacion', 'Puntos y recompensas.', 250000, 'cuota', 5),
  ('Sucursal adicional', 'sucursal-adicional', 'Cada sede extra, en un solo panel.', 150000, 'cuota', 6)
ON CONFLICT (slug) DO NOTHING;

-- ── Config pública (placeholders editables luego desde Superadmin) ───
INSERT INTO public.marketing_config (key, value, is_public) VALUES
  ('trial_days',          '14'::jsonb,                true),
  ('founder_offer_active','true'::jsonb,              true),
  ('founder_offer_limit', '10'::jsonb,                true),
  ('sales_whatsapp',      '"595000000000"'::jsonb,    true),
  ('site_home_path',      '"/inicio"'::jsonb,         true)
ON CONFLICT (key) DO NOTHING;

-- ── Secciones mínimas del sitio ──────────────────────────────────────
INSERT INTO public.marketing_site_sections (section_key, title, subtitle, items, cta, sort_order)
VALUES
  ('hero',
   'El sistema operativo de tu restaurante.',
   'Menú QR, caja, cocina, mesas y delivery en una sola plataforma. Cobrás con Bancard, facturás legal, y operás todo desde un solo lugar.',
   '["Menú digital con QR","Caja y cocina en tiempo real","Cobro con Bancard","Factura electrónica","Delivery con tracking"]'::jsonb,
   '{"primary":{"label":"Probar gratis","href":"/registro"},"secondary":{"label":"Ver demo en vivo","href":"/demo"}}'::jsonb,
   1),
  ('trust_strip', NULL, NULL,
   '["Hecho en Paraguay","Cobrá con Bancard","Factura electrónica","Soporte por WhatsApp","Demo en vivo, no maqueta"]'::jsonb,
   '{}'::jsonb, 2),
  ('local_bancard',
   'Cobrá con Bancard. Facturá legal. Sin vueltas.',
   'Lo que ningún software internacional te da fácil en Paraguay: pagos y facturación locales, de verdad.',
   '[{"title":"Pagos con Bancard","body":"Cobrá online con la pasarela local que tus clientes ya conocen."},{"title":"Factura electrónica","body":"Emití comprobantes legales con tu RUC, integrado al sistema."},{"title":"Soporte que contesta","body":"WhatsApp directo, en español, del equipo que hizo el producto."}]'::jsonb,
   '{}'::jsonb, 3),
  ('final_cta',
   'Llevá tu restaurante al siguiente nivel.',
   'Probá MYTHOS gratis por 14 días. Sin tarjeta. Sin compromiso.',
   '[]'::jsonb,
   '{"primary":{"label":"Probar gratis","href":"/registro"},"secondary":{"label":"Hablar por WhatsApp","href":"whatsapp"}}'::jsonb,
   4)
ON CONFLICT (section_key) DO NOTHING;

-- ── FAQs (las mismas de WEB-1) ───────────────────────────────────────
INSERT INTO public.marketing_faqs (question, answer, sort_order)
SELECT q, a, n FROM (VALUES
  ('¿Necesito conocimientos técnicos?', 'No. Creás tu cuenta, cargás tu menú y empezás. Y si te trabás, te ayudamos por WhatsApp.', 1),
  ('¿Puedo probar antes de pagar?', 'Sí. 14 días gratis, sin tarjeta de crédito. Cancelás cuando quieras.', 2),
  ('¿Cómo cobro a mis clientes?', 'Con Bancard, la pasarela local. Pagos online integrados, sin depender de Stripe ni cuentas en dólares.', 3),
  ('¿Emiten factura?', 'Sí. MYTHOS integra facturación electrónica con tu RUC para que emitas comprobantes legales.', 4),
  ('¿Y si tengo más de una sucursal?', 'Sumás sucursales y las administrás todas desde un solo panel. Para cadenas está el plan Enterprise.', 5),
  ('¿Mis clientes descargan una app?', 'No. Escanean el QR y listo, funciona en el navegador. Cero fricción.', 6),
  ('¿Puedo cancelar cuando quiera?', 'Sí. No hay permanencia: cancelás desde tu panel cuando quieras.', 7)
) AS seed(q, a, n)
WHERE NOT EXISTS (SELECT 1 FROM public.marketing_faqs);

COMMIT;

-- Recargar el cache de esquema de PostgREST para que apliquen privilegios/policies.
NOTIFY pgrst, 'reload schema';

SELECT 'migration 110 applied — marketing site tables' AS status;
