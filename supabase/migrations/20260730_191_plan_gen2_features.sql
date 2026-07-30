-- ════════════════════════════════════════════════════════════════════
-- 191 · CATÁLOGO DE 2ª GENERACIÓN: Agenda y Personal pasan a ser features de plan
--       (PREPARED — NOT APPLIED: aplicar manualmente tras backup nuevo,
--        Supabase SQL Editor en INGLÉS, rol postgres. Claude Code NO la aplica.)
-- ────────────────────────────────────────────────────────────────────
-- PROBLEMA (obs. Renato 2026-07-30, sobre el plan Emprendedor):
-- el NAV del panel admin es una lista hardcodeada sin relación con el catálogo de
-- planes, así que un módulo solo queda gateado si alguien se acordó de escribir el
-- gate a mano. Resultado: 5 de 22 módulos gateados, y el plan Emprendedor
-- (allowed_panels=[], de un solo usuario) mostraba Agenda y Personal.
--
-- Esta migración incorpora al catálogo las DOS primeras keys de 2ª generación:
--   admin:agenda    — Agenda / Reservas (y, vía get_public_capabilities, el botón
--                     "Reservar mesa" del Menú QR anónimo — ver mig 192)
--   admin:personal  — Gestión de Personal
--
-- ⚠️ REGLA DE TRANSICIÓN (evita repetir el incidente de la mig 155 al revés)
-- El frontend (public/mythos-gating.js) enforza una key de 2ª generación SOLO si el
-- plan YA declara al menos una de ellas. Mientras un plan no las declare, falla
-- ABIERTO y nada cambia. Por eso esta migración es la que ACTIVA el gate, y lo hace
-- plan por plan: los planes que abajo reciben las keys quedan enforzados; los que
-- no las reciben (Emprendedor / Emprendedor Delivery) quedan SIN el módulo.
-- Deployar el frontend sin esta migración es un no-op seguro.
--
-- CRITERIO APLICADO (ajustable — es decisión comercial, no técnica):
--   · Emprendedor           → NI agenda NI personal  (dueño solo, sin empleados)
--   · Emprendedor Delivery  → NI agenda NI personal  (además no tiene salón)
--   · Consolidado / Premium → AMBAS
--   · Cualquier otro plan con panel de salón (caja/mozo/cocina) → AMBAS
-- Un restaurante puntual siempre puede recibir la feature vía
-- restaurant_feature_overrides (key 'feature:admin:agenda', enabled=true), que manda
-- sobre el plan.
--
-- ALCANCE: 100% ADITIVO sobre datos (UPDATE de subscription_plans.allowed_features y
-- max_users_by_role). NO toca esquema, NO toca RLS, NO toca funciones. Idempotente:
-- re-ejecutar deja los mismos valores (usa jsonb agregando sin duplicar).
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1) Planes CON salón (o explícitamente Consolidado/Premium) → reciben ambas ──
--    Se agregan sin pisar lo existente y sin duplicar: unión de arrays jsonb.
UPDATE public.subscription_plans sp
   SET allowed_features = (
     SELECT COALESCE(jsonb_agg(DISTINCT k), '[]'::jsonb)
       FROM (
         SELECT jsonb_array_elements_text(COALESCE(sp.allowed_features, '[]'::jsonb)) AS k
         UNION SELECT 'admin:agenda'
         UNION SELECT 'admin:personal'
       ) u
   )
 WHERE COALESCE(sp.allowed_panels, '[]'::jsonb) ?| array['caja','mozo','cocina','gerente'];

-- ── 2) Planes SIN salón y SIN puestos de staff → se aseguran SIN las keys ──────
--    (Emprendedor, Emprendedor Delivery). Si alguna quedó de una corrida previa o
--    de una edición manual, se saca: son planes de un solo usuario.
UPDATE public.subscription_plans sp
   SET allowed_features = (
     SELECT COALESCE(jsonb_agg(k), '[]'::jsonb)
       FROM (
         SELECT jsonb_array_elements_text(COALESCE(sp.allowed_features, '[]'::jsonb)) AS k
       ) u
      WHERE k NOT IN ('admin:agenda','admin:personal')
   )
 WHERE NOT (COALESCE(sp.allowed_panels, '[]'::jsonb) ?| array['caja','mozo','cocina','gerente']);

-- ── 3) Topes de rol EXPLÍCITOS en los planes de un solo usuario ───────────────
--    Convención histórica: clave AUSENTE en max_users_by_role = ILIMITADO. Por eso
--    el Emprendedor Delivery se sembró (mig 175) con '{}' = mozos/cajeros/cocineros/
--    riders ILIMITADOS. Hoy no explota porque allowed_panels=[] les impide entrar,
--    pero es fail-open esperando a romperse: lo hacemos explícito en 0.
--    Solo toca planes SIN paneles de staff, y solo las claves que falten.
UPDATE public.subscription_plans sp
   SET max_users_by_role =
       jsonb_build_object('mozo',0,'cajero',0,'cocina',0,'rider',0,'supervisor_local',0)
       || COALESCE(sp.max_users_by_role, '{}'::jsonb)   -- lo ya seteado a mano MANDA
 WHERE NOT (COALESCE(sp.allowed_panels, '[]'::jsonb) ?| array['caja','mozo','cocina','gerente','delivery-rider']);

COMMIT;

-- Recargar el cache de esquema de PostgREST.
NOTIFY pgrst, 'reload schema';

-- ── Verificación (correr aparte, como postgres/superadmin) ───────────────────
--   SELECT name, allowed_panels, allowed_features, max_users_by_role
--     FROM public.subscription_plans
--    WHERE status = 'active' ORDER BY price_usd;
--   Esperado:
--     Emprendedor / Emprendedor Delivery → allowed_features SIN admin:agenda ni
--       admin:personal, y max_users_by_role con los 5 roles en 0.
--     Consolidado / Premium              → allowed_features CON ambas.
SELECT 'migration 191 applied — admin:agenda + admin:personal incorporadas al catálogo de planes' AS status;
