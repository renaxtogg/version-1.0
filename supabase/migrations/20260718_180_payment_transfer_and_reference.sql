-- ════════════════════════════════════════════════════════════════════════
-- 180 · Datos de transferencia del comercio + Nº de comprobante en el cobro
-- ────────────────────────────────────────────────────────────────────────
-- Pedido de Renato (2026-07-18):
--   1) El dueño carga desde Admin → Configuración los datos de su cuenta
--      bancaria (titular, banco, nº de cuenta, alias, CI/RUC) y un QR de la
--      cuenta. Caja/Mozo los muestran al cobrar por transferencia para que el
--      cliente transfiera o escanee el QR.
--   2) Al cobrar con Tarjeta (POS) o Transferencia/QR, el cajero/mozo puede
--      digitar el Nº de comprobante/operación (OPCIONAL). Se guarda para
--      conciliar después si el pago efectivamente llegó.
--   3) Se retira el módulo NO funcional "Cobro de Mesa con QR Digital"
--      (mozo:digital_qr_pay) del catálogo de features de todos los planes.
--
-- Todo aditivo y reversible. SIN cambios de RLS: los campos de banco los
-- leen/escriben admin/caja/mozo sobre su PROPIO restaurante (tenant scoping
-- ya vigente, mig 086/104). No se abre nada al rol anon.
-- ════════════════════════════════════════════════════════════════════════

-- 1) Datos de transferencia del comercio ---------------------------------
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS bank_holder  TEXT;  -- Titular de la cuenta
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS bank_name    TEXT;  -- Banco / entidad
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS bank_account TEXT;  -- Nº de cuenta
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS bank_alias   TEXT;  -- Alias de transferencia
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS bank_doc     TEXT;  -- CI / RUC del titular
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS bank_qr_url  TEXT;  -- Imagen QR de la cuenta (Storage)

COMMENT ON COLUMN public.restaurants.bank_qr_url IS
  'URL pública del QR de la cuenta bancaria (bucket restaurant-images). El cliente lo escanea para transferir el monto.';

-- 2) Nº de comprobante / referencia de pago ------------------------------
--    Canónico en orders.payment_reference (lo tocan caja Y mozo).
--    Espejo en movimientos_caja.comprobante_nro para el arqueo/ledger de caja.
ALTER TABLE public.orders           ADD COLUMN IF NOT EXISTS payment_reference TEXT;
ALTER TABLE public.movimientos_caja ADD COLUMN IF NOT EXISTS comprobante_nro   TEXT;

COMMENT ON COLUMN public.orders.payment_reference IS
  'Nº de comprobante/operación digitado al cobrar (tarjeta POS o transferencia/QR). Opcional; para conciliar que el pago llegó.';

-- 3) Retirar el módulo no funcional del catálogo de planes ---------------
--    "Cobro de Mesa con QR Digital" (Bancard) nunca se construyó. Se saca de
--    allowed_features de todos los planes para que no aparezca en ningún lado
--    (superadmin, onboarding, sitio web). Reversible: se re-agrega cuando exista.
UPDATE public.subscription_plans
   SET allowed_features = (allowed_features::jsonb - 'mozo:digital_qr_pay')
 WHERE allowed_features IS NOT NULL
   AND allowed_features::jsonb ? 'mozo:digital_qr_pay';
