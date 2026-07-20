-- ════════════════════════════════════════════════════════════════════════
-- 181 · Métodos de pago configurables por restaurante (FASE D2 · Módulo 1)
-- ────────────────────────────────────────────────────────────────────────
-- El restaurante decide QUÉ medios de pago ve el cliente en el menú QR
-- (Efectivo, Tarjeta, QR/Transferencia, POS en mesa). Config POR restaurante,
-- nunca global. Extensible (JSONB): sumar medios futuros = sumar claves.
--
-- restaurants.payment_methods JSONB = objeto { "<id>": true|false }.
--   NULL / clave ausente = HABILITADO (fail-open, no rompe lo existente).
--   El admin lo edita en Configuración → "Métodos de pago".
--
-- Además: el cliente (rol anon) necesita LEER esta config + los datos de
-- transferencia (mig 180) para mostrar el QR/alias y filtrar los medios.
-- mig 102 dejó a anon con SELECT por LISTA BLANCA de columnas en restaurants
-- (sin bank_* ni payment_methods). Acá se le concede SELECT SOLO de esas
-- columnas de pago del comercio (NO PII del dueño: owner_email/ruc/legal_name
-- siguen ocultas). Es SOLO lectura; no se toca ninguna escritura de anon.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS payment_methods JSONB;

COMMENT ON COLUMN public.restaurants.payment_methods IS
  'Medios de pago habilitados para el cliente (menú QR): { "efectivo":true, "tarjeta":true, "qr":true, "pos":true }. NULL/ausente = habilitado.';

-- Lectura anon de la config de pago + datos de transferencia del comercio
-- (para el checkout del cliente). Columnas acotadas; sin PII del dueño.
GRANT SELECT (payment_methods, bank_holder, bank_name, bank_account, bank_alias, bank_doc, bank_qr_url)
  ON public.restaurants TO anon;
