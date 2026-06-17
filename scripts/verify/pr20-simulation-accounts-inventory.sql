-- PR-20 read-only simulation/accounts inventory.
-- DO NOT modify data.
-- DO NOT run as a migration.
-- SELECT-only inventory for demo/sim accounts and data.
-- Do not output secrets or password hashes.
-- ════════════════════════════════════════════════════════════════════
-- PR-20 · INVENTARIO DE SIMULACIÓN + CUENTAS COMPARTIDAS — SOLO LECTURA
-- ────────────────────────────────────────────────────────────────────
-- Objetivo: medir qué datos/cuentas de simulación siguen vivos en prod
-- (proyecto ocwzupmamfojvdywavqi) para decidir el camino seguro
-- (rotar / desactivar / teardown / demo limpia), SIN modificar nada.
--
-- Cómo correr (manual, seguro):
--   1. Supabase Dashboard → SQL Editor. Idioma en INGLÉS.
--   2. Pegar este archivo y ejecutar (o sección por sección).
--   3. Copiar la salida al informe docs/audits/pr20-simulation-accounts-plan.md
--      (NO pegar passwords, hashes, tokens ni connection strings).
--
-- Allowlist de simulación (única fuente de verdad, igual que PR-14):
--   a1a10000-0000-4000-8000-000000000001  (Bella Napoli)
--   b2b20000-0000-4000-8000-000000000002  (Sushi Sakura)
--   c3c30000-0000-4000-8000-000000000003  (Parrilla Don Carlos)
-- Terrapizza NO está en la allowlist → solo se DETECTA, nunca se apunta.
-- Todo es SELECT. No se imprime ningún hash de contraseña.
-- ════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════
-- SECCIÓN 1 — RESTAURANTES CANDIDATOS demo/sim + detección de Terrapizza
-- Marca cuáles caen por allowlist y cuáles por nombre; Terrapizza debe
-- aparecer con es_simulacion=false (sobreviviente real).
-- ════════════════════════════════════════════════════════════════════
SELECT
  r.id,
  r.name,
  r.is_active,
  r.created_at,
  (r.id IN ('a1a10000-0000-4000-8000-000000000001',
            'b2b20000-0000-4000-8000-000000000002',
            'c3c30000-0000-4000-8000-000000000003'))          AS es_simulacion_allowlist,
  (r.name ILIKE '%terrapizza%')                               AS es_terrapizza,
  (r.name ILIKE '%demo%' OR r.name ILIKE '%sim%'
     OR r.name ILIKE '%test%' OR r.name ILIKE '%[SIM]%'
     OR r.name ILIKE '%[DEMO]%' OR r.name ILIKE '%napoli%'
     OR r.name ILIKE '%sakura%' OR r.name ILIKE '%don carlos%') AS match_nombre
FROM public.restaurants r
ORDER BY es_simulacion_allowlist DESC, r.name;


-- ════════════════════════════════════════════════════════════════════
-- SECCIÓN 2 — USUARIOS CANDIDATOS demo/sim (user_roles)
-- Marcador: email @mythos.test / @mythos.internal / demo/test/sim,
--   O rol anclado a un restaurante de la allowlist.
-- MINUS protegidos = usuarios con rol en un restaurante NO-sim (staff
--   real / Terrapizza / Renato). NO se imprime ningún hash.
-- ════════════════════════════════════════════════════════════════════
WITH sim(id) AS (
  VALUES ('a1a10000-0000-4000-8000-000000000001'::uuid),
         ('b2b20000-0000-4000-8000-000000000002'::uuid),
         ('c3c30000-0000-4000-8000-000000000003'::uuid)
),
protegidos AS (
  SELECT DISTINCT ur.user_id
  FROM public.user_roles ur
  WHERE ur.restaurant_id IS NOT NULL
    AND ur.restaurant_id NOT IN (SELECT id FROM sim)
)
SELECT
  ur.email,
  ur.role,
  ur.restaurant_id,
  ur.is_active,
  (ur.email ILIKE '%@mythos.test')        AS dominio_test,
  (ur.email ILIKE '%@mythos.internal')    AS dominio_internal,
  (ur.user_id IN (SELECT user_id FROM protegidos)) AS protegido_no_tocar
FROM public.user_roles ur
WHERE ur.email ILIKE '%@mythos.test'
   OR ur.email ILIKE '%@mythos.internal'
   OR ur.email ILIKE '%demo%'
   OR ur.email ILIKE '%test%'
   OR ur.email ILIKE '%sim%'
   OR ur.restaurant_id IN (SELECT id FROM sim)
ORDER BY protegido_no_tocar DESC, ur.restaurant_id, ur.email;


-- ════════════════════════════════════════════════════════════════════
-- SECCIÓN 3 — CONTEO DE DATOS POR RESTAURANTE SIM (solo conteos)
-- Tablas que existen con seguridad. Si alguna no existe en este entorno,
-- esa línea dará error: comentala y volvé a correr. NO hay dumps.
-- ════════════════════════════════════════════════════════════════════
WITH sim(id) AS (
  VALUES ('a1a10000-0000-4000-8000-000000000001'::uuid),
         ('b2b20000-0000-4000-8000-000000000002'::uuid),
         ('c3c30000-0000-4000-8000-000000000003'::uuid)
)
SELECT t.tabla, t.filas FROM (
            SELECT 'orders'             AS tabla, (SELECT count(*) FROM public.orders             WHERE restaurant_id IN (SELECT id FROM sim)) AS filas
  UNION ALL SELECT 'delivery_orders',            (SELECT count(*) FROM public.delivery_orders   WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'ratings',                    (SELECT count(*) FROM public.ratings           WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'coupons',                    (SELECT count(*) FROM public.coupons           WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'support_tickets',            (SELECT count(*) FROM public.support_tickets   WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'staff_requests',             (SELECT count(*) FROM public.staff_requests    WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'restaurant_settings',        (SELECT count(*) FROM public.restaurant_settings WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'delivery_riders',            (SELECT count(*) FROM public.delivery_riders   WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'delivery_zones',             (SELECT count(*) FROM public.delivery_zones    WHERE restaurant_id IN (SELECT id FROM sim))
  UNION ALL SELECT 'user_roles',                 (SELECT count(*) FROM public.user_roles        WHERE restaurant_id IN (SELECT id FROM sim))
) t
ORDER BY t.filas DESC, t.tabla;

-- 3.1 Tablas posiblemente FANTASMA (user_profiles / delivery_channels).
--     Correr por separado: si la tabla no existe, este statement da
--     error → simplemente omitilo (no afecta al resto).
SELECT
  (SELECT count(*) FROM public.user_profiles
     WHERE restaurant_id IN ('a1a10000-0000-4000-8000-000000000001',
                             'b2b20000-0000-4000-8000-000000000002',
                             'c3c30000-0000-4000-8000-000000000003'))  AS user_profiles_sim;
-- (separado a propósito; comentá la siguiente si delivery_channels no existe)
SELECT
  (SELECT count(*) FROM public.delivery_channels
     WHERE restaurant_id IN ('a1a10000-0000-4000-8000-000000000001',
                             'b2b20000-0000-4000-8000-000000000002',
                             'c3c30000-0000-4000-8000-000000000003'))  AS delivery_channels_sim;


-- ════════════════════════════════════════════════════════════════════
-- SECCIÓN 4 — AUTH USERS por patrón (solo email; NO hashes/secretos)
-- Requiere permisos sobre auth.* (el SQL Editor como postgres los tiene).
-- Si no hay acceso, omitir y reportar.
-- ════════════════════════════════════════════════════════════════════
SELECT
  count(*) FILTER (WHERE u.email ILIKE '%@mythos.test')     AS auth_test_users,
  count(*) FILTER (WHERE u.email ILIKE '%@mythos.internal') AS auth_internal_users,
  count(*) FILTER (WHERE u.email ILIKE '%@mythos.test'
                       OR u.email ILIKE '%@mythos.internal') AS auth_sim_users_total
FROM auth.users u;


-- ════════════════════════════════════════════════════════════════════
-- SECCIÓN 5 — GAUGE DE DECISIÓN (una fila)
-- ════════════════════════════════════════════════════════════════════
WITH sim(id) AS (
  VALUES ('a1a10000-0000-4000-8000-000000000001'::uuid),
         ('b2b20000-0000-4000-8000-000000000002'::uuid),
         ('c3c30000-0000-4000-8000-000000000003'::uuid)
),
counts AS (
  SELECT
    (SELECT count(*) FROM public.restaurants WHERE id IN (SELECT id FROM sim))                         AS demo_restaurants_count,
    (SELECT count(*) FROM public.user_roles  WHERE email ILIKE '%@mythos.test'
        OR email ILIKE '%@mythos.internal'
        OR restaurant_id IN (SELECT id FROM sim))                                                      AS demo_users_count,
    (SELECT count(*) FROM public.orders          WHERE restaurant_id IN (SELECT id FROM sim))          AS demo_orders_count,
    (SELECT count(*) FROM public.delivery_orders WHERE restaurant_id IN (SELECT id FROM sim))          AS demo_delivery_orders_count,
    (SELECT count(*) FROM public.restaurants WHERE name ILIKE '%terrapizza%')                          AS terrapizza_present,
    (SELECT count(*) FROM public.restaurants WHERE id NOT IN (SELECT id FROM sim))                     AS real_tenant_present
)
SELECT
  demo_restaurants_count,
  demo_users_count,
  demo_orders_count,
  demo_delivery_orders_count,
  real_tenant_present,
  terrapizza_present,
  CASE
    WHEN demo_restaurants_count = 0 AND demo_users_count = 0
      THEN 'NO_DEMO_FOUND'
    WHEN demo_users_count > 0 OR demo_restaurants_count > 0
      THEN 'DEMO_PRESENT_ROTATE_OR_TEARDOWN'
    ELSE 'NEEDS_MANUAL_REVIEW'
  END AS recommended_action_hint
FROM counts;

-- FIN — todo SELECT. Nada fue modificado. No se imprimieron secretos.
