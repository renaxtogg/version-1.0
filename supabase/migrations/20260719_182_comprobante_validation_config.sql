-- ════════════════════════════════════════════════════════════════════════
-- 182 · FASE D2 — Comprobante (foto) + validación del pago + config de cobro
-- ────────────────────────────────────────────────────────────────────────
-- [PARA PEGAR EN SUPABASE]  ·  rol postgres, SQL Editor en INGLÉS.
--
-- Cierra la parte STAFF-SIDE del roadmap "Delivery Inteligente" (D2):
--   Módulo 2/7 — foto del comprobante: al cobrar por transferencia/QR/tarjeta,
--     caja/mozo pueden adjuntar la FOTO del comprobante (además del N°).
--   Módulo 3/6/8/11 — validación: caja/admin marcan el pago como
--     APROBADO / RECHAZADO con una observación, y queda AUDITADO (inmutable).
--   Módulo 4/5/9 — config por restaurante: exigir comprobante, política de
--     inicio de preparación (A/B/C) y umbral/cliente frecuente. JSONB extensible.
--
-- ¿Por qué STAFF-SIDE y no que el cliente suba la foto desde su casa?
--   El cliente (rol anon) NO tiene acceso directo a orders/delivery_orders:
--   crea y sigue el pedido SOLO por RPCs SECURITY DEFINER (migs 131/132). Que
--   el cliente adjunte comprobante exige reabrir escritura de anon (orders +
--   Storage), justo lo que el lockdown (102/129/132) cerró y CLAUDE.md prohíbe
--   tocar hasta el Sprint 1 de RLS. Por eso la captura/validación viven en los
--   paneles autenticados (caja/mozo/admin), que YA están tenant-scoped (mig 086)
--   y es donde HOY ocurre el cobro. El "cliente sube desde casa" (delivery a
--   domicilio) queda para una fase posterior, con RPC dedicada, tras Sprint 1.
--
-- Todo ADITIVO, idempotente (IF NOT EXISTS / DO NOTHING) y fail-open: si no se
-- aplica, el código de los paneles ya está escrito a prueba de columnas
-- faltantes (try/catch) y no rompe el cobro.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1) Config de cobro/validación/preparación por restaurante ────────────
-- delivery_config JSONB = {
--   require_proof:       bool,       -- exigir comprobante (N° o foto) al cobrar transferencia/QR
--   prep_policy:         'A'|'B'|'C' -- A: preparar YA · B: esperar validación del pago · C: inteligente
--   prep_threshold:      number,     -- (C) monto máx. que se prepara sin esperar validación
--   frequent_min_orders: number      -- (C) nº de pedidos para considerar "cliente frecuente" (prepara YA)
-- }
-- NULL / clave ausente = comportamiento actual (no exige nada, prepara ya) → fail-open.
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS delivery_config JSONB;

COMMENT ON COLUMN public.restaurants.delivery_config IS
  'FASE D2: config de cobro/preparación por restaurante { require_proof, prep_policy A|B|C, prep_threshold, frequent_min_orders }. NULL = sin exigencias (fail-open).';

-- ── 2) Comprobante (foto) + estado de revisión del pago en orders ────────
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_proof_url     TEXT;         -- foto del comprobante (bucket restaurant-images)
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_review_status TEXT;         -- NULL | 'pending' | 'approved' | 'rejected'
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_reviewed_by   UUID;         -- staff que validó (auth.users.id)
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_reviewed_at   TIMESTAMPTZ;  -- cuándo se validó
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_review_note   TEXT;         -- observación (motivo del rechazo, etc.)

COMMENT ON COLUMN public.orders.payment_review_status IS
  'FASE D2: estado de validación del cobro por transferencia/QR. NULL=no aplica · pending=esperando validación · approved=verificado · rejected=rechazado.';

-- Espejo de la foto en el ledger de caja (arqueo), opcional.
ALTER TABLE public.movimientos_caja ADD COLUMN IF NOT EXISTS comprobante_url TEXT;

-- ── 3) Auditoría INMUTABLE de validaciones (Módulo 11) ───────────────────
-- Cada aprobación/rechazo/foto deja una fila. Sin UPDATE/DELETE para nadie
-- (rol authenticated solo INSERT/SELECT de su tenant) → historial no borrable.
CREATE TABLE IF NOT EXISTS public.payment_reviews (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL,
  order_id      UUID,
  action        TEXT NOT NULL,        -- 'approved' | 'rejected' | 'proof_added'
  note          TEXT,
  reviewer_id   UUID,
  reviewer_name TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_reviews_order ON public.payment_reviews(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_reviews_rest  ON public.payment_reviews(restaurant_id, created_at DESC);

ALTER TABLE public.payment_reviews ENABLE ROW LEVEL SECURITY;

-- Solo staff del MISMO restaurante puede leer/insertar (tenant-scoped, mig 086).
-- NO se crean policies de UPDATE/DELETE → inmutable para authenticated.
DROP POLICY IF EXISTS pr_auth_select ON public.payment_reviews;
CREATE POLICY pr_auth_select ON public.payment_reviews
  FOR SELECT TO authenticated
  USING (restaurant_id = public.get_my_restaurant_id());

DROP POLICY IF EXISTS pr_auth_insert ON public.payment_reviews;
CREATE POLICY pr_auth_insert ON public.payment_reviews
  FOR INSERT TO authenticated
  WITH CHECK (restaurant_id = public.get_my_restaurant_id());

GRANT SELECT, INSERT ON public.payment_reviews TO authenticated;
-- anon: sin GRANT → sin acceso (no se abre nada al rol público).

COMMENT ON TABLE public.payment_reviews IS
  'FASE D2 · Módulo 11: bitácora inmutable de validaciones de pago (quién/cuándo/acción/observación). Solo INSERT/SELECT por staff del tenant.';

COMMIT;

-- Recargar el cache de esquema de PostgREST para que tome columnas/tabla/grants.
NOTIFY pgrst, 'reload schema';

SELECT 'migración 182 aplicada — comprobante (foto) + validación + auditoría + config de cobro (D2 staff-side)' AS status;
