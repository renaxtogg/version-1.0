-- ════════════════════════════════════════════════════════════════════
-- 162 · Canales de delivery en la DB (tenant-scoped) — Parte 3
-- ════════════════════════════════════════════════════════════════════
-- [PARA PEGAR EN SUPABASE]
--
-- La tabla public.delivery_channels YA EXISTE en prod como DRIFT (nunca quedó en
-- una migración; introspección 2026-07-07). Estructura REAL confirmada:
--     id uuid PK default gen_random_uuid()
--     restaurant_id uuid NOT NULL
--     name text NOT NULL
--     commission_pct numeric default 0        ← NO se llama "commission"
--     color text default '#000000'
--     is_active boolean default true
-- FK viva: delivery_orders_channel_id_fkey (delivery_orders.channel_id → delivery_channels.id).
-- La tabla estaba VACÍA (el front usaba localStorage). Hay 7 pedidos, todos
-- channel='propio' (texto), channel_id NULL.
--
-- Esta migración NO hace CREATE TABLE (respeta la estructura viva) — sólo:
--   1) agrega `slug` (identidad de texto estable = lo que el pedido congela en
--      delivery_orders.channel; así los pedidos 'propio' existentes siguen mapeando
--      y la lista/dashboard que keyean por texto no se rompen),
--   2) unique (restaurant_id, slug),
--   3) siembra Propio/PedidosYa/Monchis por restaurante que no tenga canales,
--   4) RLS tenant-scoped (molde delivery_settings mig 124) + lockdown anon,
--      dropeando ANTES cualquier policy drift para no dejar un USING(true) OR-eado.
--
-- NOTA de diseño: el front congela channel(slug)+channel_commission(int) por pedido,
-- NO usa channel_id. Por eso borrar/editar un canal nunca choca con el FK ni orfana
-- el histórico (la comisión queda congelada al momento del pedido).
--
-- 100% ADITIVA + IDEMPOTENTE. El front es DEFENSIVO: si esta migración no está
-- aplicada, cae a los canales por defecto en memoria (no rompe).
-- ⚠ Aplicar en el SQL Editor en INGLÉS, tras backup. Claude Code NO aplica migraciones.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. Columna slug (identidad de texto estable) ─────────────────────────────
ALTER TABLE public.delivery_channels ADD COLUMN IF NOT EXISTS slug text;

-- Backfill: derivar slug del nombre para filas existentes sin slug (idempotente).
UPDATE public.delivery_channels
   SET slug = lower(regexp_replace(trim(name), '\s+', '_', 'g'))
 WHERE slug IS NULL OR slug = '';

-- ── 2. Unicidad por tenant (necesaria para el ON CONFLICT del seed) ──────────
CREATE UNIQUE INDEX IF NOT EXISTS delivery_channels_rid_slug_uidx
  ON public.delivery_channels(restaurant_id, slug);

-- ── 3. Seed Propio/PedidosYa/Monchis por restaurante SIN canales ─────────────
INSERT INTO public.delivery_channels (restaurant_id, name, slug, commission_pct, color, is_active)
SELECT r.id, v.name, v.slug, v.commission_pct, v.color, true
FROM public.restaurants r
CROSS JOIN (VALUES
  ('Propio',    'propio',    0,  '#8E8E93'),
  ('PedidosYa', 'pedidosya', 18, '#FF6000'),
  ('Monchis',   'monchis',   15, '#00B04F')
) AS v(name, slug, commission_pct, color)
WHERE NOT EXISTS (SELECT 1 FROM public.delivery_channels dc WHERE dc.restaurant_id = r.id)
ON CONFLICT (restaurant_id, slug) DO NOTHING;

-- ── 4. RLS tenant-scoped ─────────────────────────────────────────────────────
ALTER TABLE public.delivery_channels ENABLE ROW LEVEL SECURITY;

-- Dropear TODA policy pre-existente (drift) para no dejar un USING(true) OR-eado.
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies
           WHERE schemaname='public' AND tablename='delivery_channels'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.delivery_channels', p.policyname);
  END LOOP;
END $$;

-- Una sola policy FOR ALL: superadmin o el propio tenant (staff incluido).
CREATE POLICY delivery_channels_tenant ON public.delivery_channels
  FOR ALL
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

-- ── 5. Privilegios: anon NADA, authenticated CRUD (acotado por RLS) ──────────
REVOKE ALL ON public.delivery_channels FROM anon;
REVOKE ALL ON public.delivery_channels FROM PUBLIC;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.delivery_channels TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ── Verificación ─────────────────────────────────────────────────────────────
SELECT restaurant_id, slug, name, commission_pct, is_active
FROM public.delivery_channels
ORDER BY restaurant_id, slug;
