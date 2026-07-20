-- ════════════════════════════════════════════════════════════════════════
-- 184 · FASE D2 — Pago de delivery configurable + clientes frecuentes (CRM)
-- ────────────────────────────────────────────────────────────────────────
-- [PARA PEGAR EN SUPABASE]  ·  rol postgres, SQL Editor en INGLÉS.
--
-- Pedido de Renato (2026-07-20) para delivery a domicilio:
--   • Pago por TRANSFERENCIA al local + adjuntar comprobante (reusa la mig 183:
--     bucket privado `comprobantes` + attach_payment_proof; sirve igual para
--     delivery porque el pedido delivery tiene su fila en `orders`).
--   • EFECTIVO configurable por el dueño, y opcionalmente SOLO para clientes
--     frecuentes (los nuevos/anónimos van sí o sí por transferencia + comprobante).
--   • "Cliente frecuente" = REGISTRO MANUAL: el local marca a mano quién es
--     frecuente (elección de Renato). Tabla nueva `frequent_customers`.
--   • Empezar a preparar al confirmar (policy B) o al ingresar (policy A) ya es
--     configurable en restaurants.delivery_config.prep_policy (mig 182) — acá NO
--     se cambia el esquema; la cocina lo enforcea leyendo esa config (front).
--
-- Los toggles de pago de delivery viven en restaurants.delivery_config (JSONB,
-- mig 182) → NO hay cambio de esquema para eso. Claves nuevas (todas opcionales):
--   delivery_transfer (bool, default true) · delivery_cash (bool, default false)
--   · delivery_cash_frequent_only (bool, default true).
--
-- Todo ADITIVO y fail-open. Sin aplicar: el delivery degrada al flujo de hoy.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1) anon lee delivery_config (para armar los métodos en el checkout) ──
-- mig 102 dejó a anon con SELECT por lista blanca en restaurants; delivery_config
-- (mig 182) no estaba. Se concede SOLO esa columna (no PII del dueño). El cliente
-- delivery la necesita para saber qué medios mostrar y si exige comprobante.
GRANT SELECT (delivery_config) ON public.restaurants TO anon;

-- ── 2) Registro manual de clientes frecuentes (por teléfono, por local) ──
CREATE TABLE IF NOT EXISTS public.frequent_customers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL,
  phone         TEXT NOT NULL,          -- se guarda como lo escribe el staff; el match normaliza dígitos
  name          TEXT,
  note          TEXT,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, phone)
);

ALTER TABLE public.frequent_customers ENABLE ROW LEVEL SECURITY;

-- Staff del MISMO restaurante: leer/agregar/quitar (tenant-scoped, mig 086).
DROP POLICY IF EXISTS fc_auth_select ON public.frequent_customers;
CREATE POLICY fc_auth_select ON public.frequent_customers
  FOR SELECT TO authenticated USING (restaurant_id = public.get_my_restaurant_id());
DROP POLICY IF EXISTS fc_auth_insert ON public.frequent_customers;
CREATE POLICY fc_auth_insert ON public.frequent_customers
  FOR INSERT TO authenticated WITH CHECK (restaurant_id = public.get_my_restaurant_id());
DROP POLICY IF EXISTS fc_auth_delete ON public.frequent_customers;
CREATE POLICY fc_auth_delete ON public.frequent_customers
  FOR DELETE TO authenticated USING (restaurant_id = public.get_my_restaurant_id());

GRANT SELECT, INSERT, DELETE ON public.frequent_customers TO authenticated;
-- anon: SIN acceso directo a la tabla (no lista clientes). Solo consulta por la RPC de abajo.

COMMENT ON TABLE public.frequent_customers IS
  'FASE D2: clientes frecuentes marcados a mano por el local (por teléfono). Habilita el pago en efectivo para delivery si el dueño lo restringe a frecuentes.';

-- ── 3) RPC: ¿este teléfono es cliente frecuente de este local? ───────────
-- El cliente delivery (anon) la llama con su teléfono para saber si puede pagar
-- en efectivo. Devuelve SOLO un booleano (no expone la lista ni datos de nadie).
-- Normaliza a dígitos y exige ≥6 para evitar matches triviales.
CREATE OR REPLACE FUNCTION public.is_frequent_customer(p_restaurant_id uuid, p_phone text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.frequent_customers fc
     WHERE fc.restaurant_id = p_restaurant_id
       AND length(regexp_replace(COALESCE(p_phone,''), '\D', '', 'g')) >= 6
       AND regexp_replace(fc.phone, '\D', '', 'g') = regexp_replace(COALESCE(p_phone,''), '\D', '', 'g')
  );
$$;
REVOKE ALL ON FUNCTION public.is_frequent_customer(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_frequent_customer(uuid, text) TO anon, authenticated;

COMMENT ON FUNCTION public.is_frequent_customer(uuid, text) IS
  'FASE D2: booleano — si el teléfono está registrado como cliente frecuente del local. La usa el checkout de delivery (anon) para habilitar el pago en efectivo. No expone datos.';

COMMIT;

NOTIFY pgrst, 'reload schema';

SELECT 'migración 184 aplicada — pago delivery configurable + clientes frecuentes (registro manual)' AS status;
