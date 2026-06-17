-- PR-21A read-only simulation AUTH inventory.
-- READ_ONLY — SELECT-only catalog/data inspection.
-- NO AUTH CHANGES ARE PERFORMED BY THIS SCRIPT.
-- No password is ever shown. No data is touched.
-- ════════════════════════════════════════════════════════════════════
-- PR-21A · INVENTARIO DE CUENTAS DE SIMULACIÓN PARA ROTACIÓN FUTURA
-- ────────────────────────────────────────────────────────────────────
-- Objetivo: clasificar cuentas/restaurantes para una eventual rotación
-- o desactivación REVERSIBLE de cuentas sim compartidas — SIN realizar
-- ninguna acción en Auth ni en datos. Solo lectura.
--
-- Cómo correr (manual, seguro):
--   1. Supabase Dashboard -> SQL Editor. Idioma en INGLÉS.
--   2. Pegar este archivo y ejecutar (o sección por sección).
--   3. Copiar la salida al informe docs/audits/pr21a-simulation-auth-rotation-plan.md
--      (NO pegar passwords/hashes/tokens/connection strings; si una salida
--       tiene emails sensibles, manejarla con cuidado fuera de chats públicos).
--
-- Allowlist de simulación (única fuente de verdad, igual que PR-14/PR-20):
--   a1a10000-0000-4000-8000-000000000001  (Bella Napoli)
--   b2b20000-0000-4000-8000-000000000002  (Sushi Sakura)
--   c3c30000-0000-4000-8000-000000000003  (Parrilla Don Carlos)
-- Terrapizza NO está en la allowlist -> sale como PROTECTED, nunca objetivo.
-- ════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════
-- SECCIÓN 0 — guardrail_script_metadata
-- ════════════════════════════════════════════════════════════════════
SELECT
  'pr21a-simulation-auth-inventory.sql' AS script_name,
  '2026-06-16'                          AS logical_date,
  'READ_ONLY'                           AS mode,
  'NO AUTH CHANGES ARE PERFORMED BY THIS SCRIPT' AS warning;


-- ════════════════════════════════════════════════════════════════════
-- SECCIÓN 1 — restaurant_classification
-- SIM_CANDIDATE = allowlist; PROTECTED_REAL_TENANT = Terrapizza o
-- cualquier tenant fuera de la allowlist; REVIEW_REQUIRED = nombre
-- sospechoso pero NO en la allowlist (no convertir en objetivo).
-- ════════════════════════════════════════════════════════════════════
SELECT
  r.id   AS restaurant_id,
  r.name AS restaurant_name,
  (r.id IN ('a1a10000-0000-4000-8000-000000000001',
            'b2b20000-0000-4000-8000-000000000002',
            'c3c30000-0000-4000-8000-000000000003'))                       AS signal_allowlist_sim,
  (r.name ILIKE '%terrapizza%')                                            AS signal_terrapizza,
  (r.name ILIKE '%demo%' OR r.name ILIKE '%sim%' OR r.name ILIKE '%test%'
     OR r.name ILIKE '%[SIM]%' OR r.name ILIKE '%[DEMO]%')                 AS signal_name_demoish,
  CASE
    WHEN r.id IN ('a1a10000-0000-4000-8000-000000000001',
                  'b2b20000-0000-4000-8000-000000000002',
                  'c3c30000-0000-4000-8000-000000000003') THEN 'SIM_CANDIDATE'
    WHEN r.name ILIKE '%terrapizza%'                       THEN 'PROTECTED_REAL_TENANT'
    WHEN (r.name ILIKE '%demo%' OR r.name ILIKE '%sim%' OR r.name ILIKE '%test%'
          OR r.name ILIKE '%[SIM]%' OR r.name ILIKE '%[DEMO]%')
                                                            THEN 'REVIEW_REQUIRED'
    ELSE 'PROTECTED_REAL_TENANT'
  END AS classification,
  CASE
    WHEN r.id IN ('a1a10000-0000-4000-8000-000000000001',
                  'b2b20000-0000-4000-8000-000000000002',
                  'c3c30000-0000-4000-8000-000000000003') THEN 'en la allowlist de simulación'
    WHEN r.name ILIKE '%terrapizza%'                       THEN 'tenant real Terrapizza (proteger siempre)'
    WHEN (r.name ILIKE '%demo%' OR r.name ILIKE '%sim%' OR r.name ILIKE '%test%')
                                                            THEN 'nombre sospechoso pero fuera de allowlist: revisar a mano'
    ELSE 'tenant no-sim: tratar como real'
  END AS reason
FROM public.restaurants r
ORDER BY signal_allowlist_sim DESC, r.name;


-- ════════════════════════════════════════════════════════════════════
-- SECCIÓN 2 — auth_user_inventory
-- Un registro por cuenta auth candidata (patrón sim OR rol en restaurante
-- sim). Clasifica protegiendo a quien tenga rol en algún tenant no-sim.
-- last_sign_in_at / banned_until ayudan a saber el estado actual.
-- NO se muestra ningún hash.
-- ════════════════════════════════════════════════════════════════════
WITH sim(id) AS (
  VALUES ('a1a10000-0000-4000-8000-000000000001'::uuid),
         ('b2b20000-0000-4000-8000-000000000002'::uuid),
         ('c3c30000-0000-4000-8000-000000000003'::uuid)
),
flags AS (
  SELECT
    u.id,
    u.email,
    u.created_at,
    u.last_sign_in_at,
    (u.banned_until IS NOT NULL AND u.banned_until > now())              AS is_currently_blocked,
    EXISTS (SELECT 1 FROM public.user_roles ur
             WHERE ur.user_id = u.id AND ur.restaurant_id IN (SELECT id FROM sim)) AS has_role_in_sim,
    EXISTS (SELECT 1 FROM public.user_roles ur
             WHERE ur.user_id = u.id AND ur.restaurant_id IS NOT NULL
               AND ur.restaurant_id NOT IN (SELECT id FROM sim))         AS has_role_in_nonsim,
    EXISTS (SELECT 1 FROM public.user_roles ur
             WHERE ur.user_id = u.id AND ur.role = 'superadmin')         AS has_superadmin_role,
    (SELECT string_agg(DISTINCT ur.role, ', ' ORDER BY ur.role)
       FROM public.user_roles ur WHERE ur.user_id = u.id)               AS roles
  FROM auth.users u
)
SELECT
  f.email,
  f.created_at,
  f.last_sign_in_at,
  f.is_currently_blocked,
  f.roles,
  f.has_role_in_sim,
  f.has_role_in_nonsim,
  CASE
    WHEN f.has_role_in_nonsim                                          THEN 'PROTECTED_REAL_USER'
    WHEN f.has_superadmin_role                                        THEN 'REVIEW_REQUIRED'
    WHEN (f.email ILIKE '%@mythos.test' OR f.email ILIKE '%@mythos.internal'
          OR f.has_role_in_sim)                                       THEN 'SIM_AUTH_CANDIDATE'
    ELSE 'REVIEW_REQUIRED'
  END AS classification,
  CASE
    WHEN f.has_role_in_nonsim       THEN 'tiene rol en tenant no-sim (real) -> proteger'
    WHEN f.has_superadmin_role      THEN 'superadmin -> solo revisión manual, nunca objetivo automático'
    WHEN f.email ILIKE '%@mythos.test'     THEN 'dominio @mythos.test (sim compartida)'
    WHEN f.email ILIKE '%@mythos.internal' THEN 'dominio @mythos.internal (QA interna)'
    WHEN f.has_role_in_sim          THEN 'rol anclado a restaurante sim'
    ELSE 'sin vínculo claro -> revisar a mano'
  END AS reason
FROM flags f
WHERE f.email ILIKE '%@mythos.test'
   OR f.email ILIKE '%@mythos.internal'
   OR f.email ILIKE '%demo%'
   OR f.email ILIKE '%test%'
   OR f.email ILIKE '%sim%'
   OR f.has_role_in_sim
ORDER BY classification, f.email;


-- ════════════════════════════════════════════════════════════════════
-- SECCIÓN 3 — shared_account_risk_signals (por patrón; SIN passwords)
-- Cuántas cuentas caen por dominio o por nombre de rol genérico.
-- ════════════════════════════════════════════════════════════════════
SELECT
  count(*) FILTER (WHERE u.email ILIKE '%@mythos.test')     AS domain_test,
  count(*) FILTER (WHERE u.email ILIKE '%@mythos.internal') AS domain_internal,
  count(*) FILTER (WHERE u.email ILIKE 'admin%'   )         AS namelike_admin,
  count(*) FILTER (WHERE u.email ILIKE 'mozo%'    )         AS namelike_mozo,
  count(*) FILTER (WHERE u.email ILIKE 'caja%'    )         AS namelike_caja,
  count(*) FILTER (WHERE u.email ILIKE 'cocina%'  )         AS namelike_cocina,
  count(*) FILTER (WHERE u.email ILIKE 'gerente%' )         AS namelike_gerente,
  count(*) FILTER (WHERE u.email ILIKE 'rider%'   )         AS namelike_rider,
  count(*) FILTER (WHERE u.email ILIKE '%superadmin%')      AS namelike_superadmin
FROM auth.users u;


-- ════════════════════════════════════════════════════════════════════
-- SECCIÓN 4 — protected_users_summary
-- Usuarios vinculados a Terrapizza / tenants no-sim: NUNCA objetivo.
-- ════════════════════════════════════════════════════════════════════
WITH sim(id) AS (
  VALUES ('a1a10000-0000-4000-8000-000000000001'::uuid),
         ('b2b20000-0000-4000-8000-000000000002'::uuid),
         ('c3c30000-0000-4000-8000-000000000003'::uuid)
)
SELECT
  count(DISTINCT ur.user_id)                                            AS protected_users_count,
  'usuarios con al menos un rol en un restaurante no-sim (real)'        AS reason
FROM public.user_roles ur
WHERE ur.restaurant_id IS NOT NULL
  AND ur.restaurant_id NOT IN (SELECT id FROM sim);


-- ════════════════════════════════════════════════════════════════════
-- SECCIÓN 5 — candidate_action_plan_input (SOLO sugerencia; nada se aplica)
-- Acción futura sujeta a aprobación explícita. Nada se ejecuta acá.
-- ════════════════════════════════════════════════════════════════════
WITH sim(id) AS (
  VALUES ('a1a10000-0000-4000-8000-000000000001'::uuid),
         ('b2b20000-0000-4000-8000-000000000002'::uuid),
         ('c3c30000-0000-4000-8000-000000000003'::uuid)
),
flags AS (
  SELECT
    u.id, u.email,
    EXISTS (SELECT 1 FROM public.user_roles ur
             WHERE ur.user_id = u.id AND ur.restaurant_id IN (SELECT id FROM sim)) AS has_role_in_sim,
    EXISTS (SELECT 1 FROM public.user_roles ur
             WHERE ur.user_id = u.id AND ur.restaurant_id IS NOT NULL
               AND ur.restaurant_id NOT IN (SELECT id FROM sim))         AS has_role_in_nonsim,
    EXISTS (SELECT 1 FROM public.user_roles ur
             WHERE ur.user_id = u.id AND ur.role = 'superadmin')         AS has_superadmin_role
  FROM auth.users u
)
SELECT
  f.email,
  CASE
    WHEN f.has_role_in_nonsim   THEN 'DO_NOT_TOUCH_PROTECTED'
    WHEN f.has_superadmin_role  THEN 'MANUAL_REVIEW_REQUIRED'
    WHEN (f.email ILIKE '%@mythos.test' OR f.email ILIKE '%@mythos.internal' OR f.has_role_in_sim)
                                THEN 'ROTATE_PASSWORD_FUTURE_APPROVAL_REQUIRED'
    ELSE 'MANUAL_REVIEW_REQUIRED'
  END AS suggested_future_action
FROM flags f
WHERE (f.email ILIKE '%@mythos.test' OR f.email ILIKE '%@mythos.internal'
       OR f.has_role_in_sim)
  AND NOT f.has_role_in_nonsim
ORDER BY suggested_future_action, f.email;


-- ════════════════════════════════════════════════════════════════════
-- SECCIÓN 6 — gauge_summary (una fila)
-- ════════════════════════════════════════════════════════════════════
WITH sim(id) AS (
  VALUES ('a1a10000-0000-4000-8000-000000000001'::uuid),
         ('b2b20000-0000-4000-8000-000000000002'::uuid),
         ('c3c30000-0000-4000-8000-000000000003'::uuid)
),
flags AS (
  SELECT
    u.id, u.email,
    EXISTS (SELECT 1 FROM public.user_roles ur
             WHERE ur.user_id = u.id AND ur.restaurant_id IN (SELECT id FROM sim)) AS has_role_in_sim,
    EXISTS (SELECT 1 FROM public.user_roles ur
             WHERE ur.user_id = u.id AND ur.restaurant_id IS NOT NULL
               AND ur.restaurant_id NOT IN (SELECT id FROM sim))         AS has_role_in_nonsim,
    EXISTS (SELECT 1 FROM public.user_roles ur
             WHERE ur.user_id = u.id AND ur.role = 'superadmin')         AS has_superadmin_role
  FROM auth.users u
)
SELECT
  (SELECT count(*) FROM public.restaurants
     WHERE id IN (SELECT id FROM sim))                                   AS sim_restaurants,
  (SELECT count(*) FROM flags f
     WHERE NOT f.has_role_in_nonsim AND NOT f.has_superadmin_role
       AND (f.email ILIKE '%@mythos.test' OR f.email ILIKE '%@mythos.internal'
            OR f.has_role_in_sim))                                       AS sim_auth_candidates,
  (SELECT count(DISTINCT ur.user_id) FROM public.user_roles ur
     WHERE ur.restaurant_id IS NOT NULL
       AND ur.restaurant_id NOT IN (SELECT id FROM sim))                 AS protected_users,
  (SELECT count(*) FROM flags f
     WHERE f.has_superadmin_role
        OR ( (f.email ILIKE '%demo%' OR f.email ILIKE '%test%' OR f.email ILIKE '%sim%')
             AND NOT f.has_role_in_sim AND NOT f.has_role_in_nonsim
             AND f.email NOT ILIKE '%@mythos.test'
             AND f.email NOT ILIKE '%@mythos.internal' ))                AS review_required,
  (SELECT count(*) FROM public.restaurants WHERE name ILIKE '%terrapizza%') AS terrapizza_present,
  'ROTATE_OR_DISABLE_SIM_AUTH_AFTER_EXPLICIT_APPROVAL'                   AS recommended_next_step;

-- FIN — todo SELECT. Nada fue modificado. No se mostró ningún secreto.
