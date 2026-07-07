-- ════════════════════════════════════════════════════════════════════
-- 163 · Sumar el TRIAL en curso al set habilitante (con corte por fecha)
-- ════════════════════════════════════════════════════════════════════
-- [PARA PEGAR EN SUPABASE]  ·  rol postgres, SQL Editor en INGLÉS.
--
-- La mig 160 fijó la regla canónica en status IN ('active','past_due'), pero el
-- ALTA crea las suscripciones con status='trial' (14 días):
--   · api/onboarding.js:155-156  → status:'trial', end_date = hoy+14
--   · src/superadmin/main.jsx     → wizard "+ Nuevo cliente" / edición de sub
-- Con la 160 sola, un local EN PRUEBA resolvía NULL → sin capabilities → todos
-- los paneles fail-closed. Prod no lo sufría (solo había 'active'), pero rompería
-- apenas entrara un trial.
--
-- DECISIÓN (Renato): el trial HABILITA mientras NO venció; el trial vencido se
-- corta solo (cierra el "Riesgo comercial #1": un trial vencido conservaba los
-- paneles para siempre porque no hay flip trial→expired). Aprovecha que el alta
-- ya setea end_date.
--
-- Regla canónica final:
--   entitled = sub MÁS NUEVA con  status IN ('active','past_due')
--                                 OR (status='trial' AND end_date >= CURRENT_DATE)
--
-- SOLO redefine el helper resolve_entitled_plan_id; las 5 funciones de la mig 160
-- ya resuelven por él → no hay que tocarlas. Idempotente. active/past_due quedan
-- incondicionales (solo el trial mira la fecha). Nota: un trial con end_date NULL
-- (no debería existir — el alta siempre lo setea) quedaría fuera; es lo correcto
-- para no reabrir el agujero del "trial sin vencimiento = para siempre".
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.resolve_entitled_plan_id(p_restaurant_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.plan_id
  FROM public.subscriptions s
  WHERE s.restaurant_id = p_restaurant_id
    AND ( s.status IN ('active','past_due')
          OR (s.status = 'trial' AND s.end_date >= CURRENT_DATE) )
  ORDER BY s.created_at DESC
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.resolve_entitled_plan_id(uuid) FROM PUBLIC;

-- ── Verificación (correr aparte) ─────────────────────────────────────────────
-- (a) Los 3 QA (active) siguen resolviendo su plan igual:
--   SELECT r.name, public.resolve_entitled_plan_id(r.id)
--   FROM public.restaurants r
--   WHERE r.id IN ('38827cf0-6187-413f-91c0-02c98e56671d',
--                  '1b09382e-c30c-41e9-91b7-dcb9c47086dd',
--                  'eb3dbf48-26d0-4d16-b5ef-e25056e1f9b2');
-- (b) La definición viva ya contempla el trial con fecha:
--   SELECT position('trial' in pg_get_functiondef(oid)) > 0 AS incluye_trial
--   FROM pg_proc WHERE proname='resolve_entitled_plan_id' AND pronamespace='public'::regnamespace;
SELECT 'migration 163 applied — trial (not expired) now enables entitlements' AS status;
