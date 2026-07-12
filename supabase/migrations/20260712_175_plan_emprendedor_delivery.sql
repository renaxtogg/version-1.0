-- ════════════════════════════════════════════════════════════════════
-- 175 · PLAN "Emprendedor Delivery" (versión a domicilio del Emprendedor)
--       (PREPARED — NOT APPLIED: aplicar manualmente tras backup nuevo,
--        Supabase SQL Editor en INGLÉS, rol postgres. Claude Code NO la aplica.)
-- ────────────────────────────────────────────────────────────────────
-- OBJETIVO (Renato, 2026-07-12): ofrecer un tercer plan de ENTRADA, gemelo del
-- Emprendedor (₲150.000) pero para negocios que atienden SOLO por delivery:
--   · Emprendedor            → salón: Menú QR + gestión (Admin). allowed_panels=[]
--   · Emprendedor Delivery   → domicilio: panel de pedidos del cliente
--                              (delivery-cliente, "lite") + gestión (Admin).
--                              allowed_panels=['delivery-cliente']
-- Es el equivalente "plan" del modo delivery de la mig 173 (service_mode). La 173
-- resolvía el mismo negocio con un TOGGLE por restaurante; acá se materializa como
-- PLAN vendible/visible (en Superadmin→Planes y en la web /precios), a pedido de
-- Renato. Ambos mecanismos conviven: al ASIGNAR este plan a un local, seguí
-- poniéndolo en modo 'delivery' (Superadmin→[restaurante]→Módulos, mig 173) para
-- que el Menú QR de salón se auto-bloquee — el plan habilita el panel; el
-- service_mode bloquea el QR anónimo (index corre anon y no ve el plan).
--
-- QUÉ INCLUYE "Emprendedor Delivery" (delivery "lite", igual criterio que mig 173):
--   · Panel delivery-cliente: el cliente arma su pedido (menú + ubicación).
--   · El dueño gestiona los pedidos desde Admin → Pedidos (ya muestran dirección
--     y "Ver detalle").
--   · Control de Insumos (admin:inventory), igual que el Emprendedor.
--   · 30 ítems de menú (mismo tier que Emprendedor).
--   · SIN mesas/QR de salón (max_tables=0) · SIN flota de riders ni tracking en
--     mapa (eso sigue siendo diferencial del Premium).
--
-- ALCANCE (100% ADITIVO · idempotente · NO toca planes existentes · NO toca RLS):
--   1. subscription_plans: INSERT del plan operativo (si no existe, por nombre).
--   2. marketing_plans: UPSERT de la tarjeta pública (slug 'emprendedor-delivery'),
--      vinculada al plan operativo (subscription_plan_id) para que precio/config
--      queden sincronizados por los triggers de las migs 119/154. Se reordena la
--      vidriera para dejarla adyacente al Emprendedor (carta=1, delivery=2,
--      servicio=3, full=4, enterprise=5) — solo cambia sort_order de filas propias.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1) Plan operativo "Emprendedor Delivery" (idempotente por nombre) ─────────
--    price_usd = guaraníes (convención histórica, mig 097). status/allowed_* según
--    esquema vivo (migs 090/091/152). marketing_slug único (mig 111) para que
--    /registro?plan=emprendedor-delivery resuelva server-side a este plan_id.
INSERT INTO public.subscription_plans
  (name, price_usd, billing_cycle, max_tables, max_menu_items,
   features, max_users_by_role, allowed_panels, allowed_features, marketing_slug, status, is_active)
SELECT
  'Emprendedor Delivery', 150000, 'monthly', 0, 30,
  '["Pedidos a domicilio (menú digital para tus clientes)","Gestión de pedidos desde Admin (con dirección del cliente)","Control de Insumos","30 ítems de menú","Sin salón: sin mesas ni QR","Sin flota de riders ni mapa (eso es Premium)"]'::jsonb,
  '{}'::jsonb,
  '["delivery-cliente"]'::jsonb,
  '["admin:inventory"]'::jsonb,
  'emprendedor-delivery', 'active', true
WHERE NOT EXISTS (
  -- Guardar por la columna con UNIQUE real (marketing_slug, índice parcial mig 111),
  -- NO por `name`: el nombre puede cambiarse desde la UI (patrón demostrado en el
  -- repo, p.ej. Starter→Emprendedor) mientras el slug persiste; keyear por name haría
  -- que una re-corrida tomara el INSERT y chocara con el UNIQUE del slug (23505).
  SELECT 1 FROM public.subscription_plans WHERE marketing_slug = 'emprendedor-delivery'
);

-- ── 2) Tarjeta pública de la vidriera (marketing_plans), vinculada al plan ─────
--    plan_config lo rellena el trigger mkt_pull_plan_config (mig 154) al setear
--    subscription_plan_id → la lista "incluye" del sitio se genera de la config
--    real (con la rama "delivery lite" agregada en web-marketing.js). `features`
--    queda como fallback estático coherente. UPSERT por slug (idempotente).
INSERT INTO public.marketing_plans
  (name, slug, headline, description, price_monthly_gs, price_annual_gs, currency,
   features, badge, is_recommended, is_enterprise, is_active, sort_order, subscription_plan_id)
VALUES (
  'Emprendedor Delivery', 'emprendedor-delivery', 'Tu delivery, en digital',
  'La versión a domicilio del Emprendedor: recibí pedidos de delivery con un menú digital y la ubicación del cliente, y gestionalos desde el panel de Admin. Para negocios que atienden solo por delivery, sin salón. Sin flota de repartidores ni seguimiento en mapa (eso es Premium).',
  150000, 1500000, 'PYG',
  '["Pedidos a domicilio (menú digital)","Gestión de pedidos (Admin)","Control de Insumos","30 ítems","Sin salón: sin mesas ni QR"]'::jsonb,
  NULL, false, false, true, 2,
  -- Vincular por la clave estable (marketing_slug); fallback a name para el primer
  -- apply. Así el vínculo sobrevive a un rename del plan desde la UI.
  (SELECT id FROM public.subscription_plans
    WHERE marketing_slug = 'emprendedor-delivery' OR name = 'Emprendedor Delivery'
    ORDER BY (marketing_slug = 'emprendedor-delivery') DESC, is_active DESC NULLS LAST LIMIT 1)
)
ON CONFLICT (slug) DO UPDATE SET
  name                 = EXCLUDED.name,
  headline             = EXCLUDED.headline,
  description          = EXCLUDED.description,
  price_monthly_gs     = EXCLUDED.price_monthly_gs,
  price_annual_gs      = EXCLUDED.price_annual_gs,
  currency             = EXCLUDED.currency,
  features             = EXCLUDED.features,
  is_active            = EXCLUDED.is_active,
  sort_order           = EXCLUDED.sort_order,
  -- No perder el vínculo si la resolución nueva viniera NULL (p.ej. tras un rename).
  subscription_plan_id = COALESCE(EXCLUDED.subscription_plan_id, public.marketing_plans.subscription_plan_id),
  updated_at           = now();

-- ── 3) Reordenar la vidriera: Emprendedor y Emprendedor Delivery adyacentes ───
--    Solo toca sort_order de slugs propios (estables, mig 154). Idempotente.
UPDATE public.marketing_plans SET sort_order = 1, updated_at = now() WHERE slug = 'carta';
UPDATE public.marketing_plans SET sort_order = 3, updated_at = now() WHERE slug = 'servicio';
UPDATE public.marketing_plans SET sort_order = 4, updated_at = now() WHERE slug = 'full';
UPDATE public.marketing_plans SET sort_order = 5, updated_at = now() WHERE slug = 'enterprise';

COMMIT;

-- Recargar el cache de esquema de PostgREST (fila nueva + vínculo).
NOTIFY pgrst, 'reload schema';

-- ── Verificación (correr aparte, como postgres/superadmin) ───────────────────
--   (a) El plan operativo existe con la config esperada:
--     SELECT name, price_usd, max_tables, max_menu_items, allowed_panels,
--            allowed_features, marketing_slug, status
--       FROM public.subscription_plans WHERE name = 'Emprendedor Delivery';
--   (b) La tarjeta pública está vinculada y con plan_config espejado:
--     SELECT slug, name, price_monthly_gs, is_active, sort_order,
--            (subscription_plan_id IS NOT NULL) AS linked,
--            (plan_config IS NOT NULL)          AS has_config
--       FROM public.marketing_plans ORDER BY sort_order;
SELECT 'migration 175 applied — plan Emprendedor Delivery (₲150.000) + tarjeta pública' AS status;
