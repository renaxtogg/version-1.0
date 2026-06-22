-- ════════════════════════════════════════════════════════════════════
-- 116 · PAYWALL — diferenciar allowed_features por plan (revive el gating)
--       (PREPARED — NOT APPLIED: aplicar manualmente tras backup nuevo,
--        Supabase SQL Editor en INGLÉS. Claude Code NO la aplica.)
-- ────────────────────────────────────────────────────────────────────
-- PROBLEMA (PAYWALL-1): la migración 091 sembró el MISMO allowed_features
-- en los 3 planes (Starter/Pro/Enterprise):
--   ["admin:delivery_zones","admin:inventory","admin:crm",
--    "caja:sifen","caja:digital_payments","mozo:digital_qr_pay"]
-- Resultado: el paywall está muerto — un comercio en Starter recibe TODO
-- (CRM, zonas de delivery, SIFEN, pasarelas digitales, QR-pay de mesa).
-- El gating del frontend (mythos-gating.js) ya consulta allowed_features
-- en admin/caja/mozo, pero al ser idéntico para los 3 planes nunca filtra.
--
-- FIX (esta migración): redefine allowed_features por plan para que cada
-- nivel entregue algo distinto. SOLO ADITIVA: UPDATE de seeds; sin DROP,
-- sin cambios de esquema, sin tocar allowed_panels ni la RPC
-- get_restaurant_capabilities (que ya devuelve allowed_features).
--
-- ⚠️ CORRECCIÓN DE CONTEXTO: subscription_plans NO tiene columna `code`
--    (el prompt original asumía `WHERE code = 'starter'`). El esquema real
--    (mig 004) identifica los planes por `name` ('Starter'/'Pro'/
--    'Enterprise') y por id fijo (…0001/…0002/…0003). Igual que las
--    migraciones 097 (pricing) y 111 (marketing_slug), acá keyeamos por
--    `name`. Idempotente: re-ejecutar reasienta los mismos valores.
--
-- ⚠️ MATRIZ DE PRICING — A CONFIRMAR POR EL DUEÑO. Es una propuesta
--    coherente con allowed_panels (mig 090), dejando lo premium en los
--    planes altos. Ajustá las listas de abajo si el pricing cambia.
--    Convención de keys (= las que consulta el frontend):
--      admin:inventory       — Control de Insumos / Stock
--      admin:delivery_zones  — Gestión de Mapas / Zonas Delivery
--      admin:crm             — CRM de Clientes
--      mozo:digital_qr_pay   — Cobro de Mesa con QR Digital
--      caja:digital_payments — Pasarelas Digitales (Bancard)
--      caja:sifen            — Facturación Electrónica SIFEN
--
--    Matriz aplicada:
--      Starter    → inventario básico.                 (paneles: caja/mozo/cocina)
--      Pro        → + zonas delivery, CRM, QR-pay, pagos digitales.
--                                                       (+ delivery-cliente)
--      Enterprise → todo lo de Pro + SIFEN.             (+ delivery-rider/gerente)
--
-- Semántica de gating (frontend, fail-open): allowed_features = NULL →
-- plan legacy → TODO permitido; array → solo esas features. Con esta
-- migración los 3 planes traen array → el gate filtra de verdad.
-- ════════════════════════════════════════════════════════════════════

-- ─── Starter: gestión básica (solo inventario) ──────────────────────
UPDATE public.subscription_plans
   SET allowed_features = '["admin:inventory"]'::jsonb
 WHERE name = 'Starter';

-- ─── Pro: delivery + CRM + cobros digitales (sin factura electrónica) ─
UPDATE public.subscription_plans
   SET allowed_features = '["admin:inventory","admin:delivery_zones","admin:crm","mozo:digital_qr_pay","caja:digital_payments"]'::jsonb
 WHERE name = 'Pro';

-- ─── Enterprise: todo, incluida factura electrónica SIFEN ───────────
UPDATE public.subscription_plans
   SET allowed_features = '["admin:inventory","admin:delivery_zones","admin:crm","mozo:digital_qr_pay","caja:digital_payments","caja:sifen"]'::jsonb
 WHERE name = 'Enterprise';

-- Refrescar el cache de esquema de PostgREST (consistencia con mig 111).
NOTIFY pgrst, 'reload schema';
