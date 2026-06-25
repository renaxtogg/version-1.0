-- ════════════════════════════════════════════════════════════════════
-- 124 · delivery_settings · Modo de cotización de delivery por restaurante
-- ────────────────────────────────────────────────────────────────────
-- Hoy el costo de envío sale SOLO por zonas (delivery_zones: radius_km +
-- price_guarani + estimated_minutes). Esta tabla generaliza la tarifa a 4
-- modos elegibles por el dueño, conservando 'zone' como default (= comportamiento
-- actual, cero cambios para quien no toca nada).
--
--   pricing_mode:
--     'fixed'     → tarifa plana (base_fee)
--     'radial_km' → base_fee + price_per_km × distancia en línea recta (Haversine)
--     'route_km'  → ídem pero con distancia de manejo (Google Distance Matrix);
--                   el cliente cae a 'radial_km' si la API no está disponible
--     'zone'      → bandas por radio (delivery_zones) — lo actual, default
--
-- El CLIENTE (anon, restaurante en contexto) lee esta fila para cotizar el envío
-- ANTES de pagar. Sólo el admin del restaurante puede escribirla. No expone PII:
-- son parámetros de tarifa públicos. delivery_zones queda intacta (modo 'zone').
--
-- 100% ADITIVA + IDEMPOTENTE (CREATE TABLE IF NOT EXISTS, policies con DROP/CREATE).
-- El código cliente es DEFENSIVO: si esta tabla aún no existe, cae al modo 'zone'
-- sin romperse (feature-detect). Por eso aplicar esta migración es opcional para
-- mantener el comportamiento actual, y obligatorio sólo para habilitar los modos nuevos.
--
-- ⚠ PREPARED — aplicar manualmente en el SQL Editor (en INGLÉS) tras backup;
--   Claude Code NO aplica migraciones.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.delivery_settings (
  restaurant_id    UUID PRIMARY KEY REFERENCES public.restaurants(id) ON DELETE CASCADE,
  pricing_mode     TEXT NOT NULL DEFAULT 'zone'
                     CHECK (pricing_mode IN ('fixed','radial_km','route_km','zone')),
  base_fee         NUMERIC NOT NULL DEFAULT 0,     -- cargo base / tarifa fija
  price_per_km     NUMERIC NOT NULL DEFAULT 0,     -- ₲ por km (radial_km / route_km)
  min_fee          NUMERIC NOT NULL DEFAULT 0,     -- piso de cobro
  max_km           NUMERIC,                        -- NULL = sin límite de cobertura
  free_over_amount NUMERIC,                        -- NULL = nunca gratis; si subtotal ≥ → envío gratis
  round_to         NUMERIC NOT NULL DEFAULT 500,   -- redondeo del costo (₲)
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.delivery_settings ENABLE ROW LEVEL SECURITY;

-- ── Lectura: pública (anon incluido) para que el cliente cotice ──────────────
-- Sólo parámetros de tarifa, sin PII. Acotado a SELECT a nivel de privilegios.
DROP POLICY IF EXISTS delivery_settings_read ON public.delivery_settings;
CREATE POLICY delivery_settings_read ON public.delivery_settings
  FOR SELECT USING (true);

-- ── Escritura: sólo admin/superadmin del restaurante (tenant-safe, mig 092) ──
DROP POLICY IF EXISTS delivery_settings_write ON public.delivery_settings;
CREATE POLICY delivery_settings_write ON public.delivery_settings
  FOR ALL
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

-- ── Privilegios de tabla ─────────────────────────────────────────────────────
-- anon: SOLO lectura (cotizar). Nada de escritura (alineado al lockdown anon).
REVOKE ALL ON public.delivery_settings FROM anon;
GRANT  SELECT ON public.delivery_settings TO anon;
-- authenticated: CRUD acotado por RLS de arriba.
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.delivery_settings TO authenticated;

NOTIFY pgrst, 'reload schema';
