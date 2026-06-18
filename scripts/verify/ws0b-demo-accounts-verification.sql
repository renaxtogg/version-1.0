-- ════════════════════════════════════════════════════════════════════
-- MYTHOS · FASE C / WS0-B — Verificación de cuentas demo (SOLO SELECT)
-- ────────────────────────────────────────────────────────────────────
-- Read-only. Seguro de correr en prod. NO modifica nada.
-- Correr DESPUÉS de _simulacion/07_ws0b_accounts.sql para confirmar que el
-- entorno demo quedó completo y que Terrapizza/Renato NO fueron tocados.
-- Dashboard Supabase en INGLÉS si se corre por SQL Editor.
-- ════════════════════════════════════════════════════════════════════

-- §1 · Las 5 cuentas nuevas: rol, restaurante, plan, panel esperado ──────
SELECT ur.email,
       ur.role,
       COALESCE(r.name,'(plataforma)')            AS restaurante,
       COALESCE(sp.name,'(sin plan / global)')    AS plan,
       CASE lower(ur.role)
         WHEN 'superadmin'       THEN 'superadmin.html'
         WHEN 'admin'            THEN 'admin.html'
         WHEN 'supervisor_local' THEN 'gerente.html'
         WHEN 'gerente'          THEN 'gerente.html'
         WHEN 'cajero'           THEN 'caja.html'
         WHEN 'caja'             THEN 'caja.html'
         WHEN 'mozo'             THEN 'mozo.html'
         WHEN 'cocina'           THEN 'cocina.html'
         WHEN 'cocinero'         THEN 'cocina.html'
         WHEN 'rider'            THEN 'delivery-rider.html'
         WHEN 'repartidor'       THEN 'delivery-rider.html'
         ELSE '(rol no reconocido)'
       END                                         AS panel_esperado,
       ur.is_active,
       (au.id IS NOT NULL)                         AS tiene_auth_user,
       (ai.user_id IS NOT NULL)                    AS tiene_identity_email
FROM public.user_roles ur
LEFT JOIN public.restaurants r        ON r.id = ur.restaurant_id
LEFT JOIN public.subscriptions s      ON s.restaurant_id = r.id AND s.status = 'active'
LEFT JOIN public.subscription_plans sp ON sp.id = s.plan_id
LEFT JOIN auth.users au               ON au.id = ur.user_id
LEFT JOIN auth.identities ai          ON ai.user_id = ur.user_id AND ai.provider = 'email'
WHERE ur.email IN ('gerente.napoli@mythos.test','rider1.napoli@mythos.test',
                   'gerente.sakura@mythos.test','rider1.sakura@mythos.test',
                   'superadmin.demo@mythos.test')
ORDER BY restaurante, ur.role;

-- §2 · Cobertura de roles por restaurante sim (debe estar completa) ──────
--    Esperado por restaurante: admin, supervisor_local, cajero, cocina, mozo, rider.
SELECT r.name AS restaurante,
       sp.name AS plan,
       string_agg(DISTINCT ur.role, ', ' ORDER BY ur.role) AS roles_presentes
FROM public.restaurants r
JOIN public.user_roles ur            ON ur.restaurant_id = r.id AND ur.email LIKE '%@mythos.test'
LEFT JOIN public.subscriptions s     ON s.restaurant_id = r.id AND s.status = 'active'
LEFT JOIN public.subscription_plans sp ON sp.id = s.plan_id
WHERE r.id IN ('a1a10000-0000-4000-8000-000000000001',
               'b2b20000-0000-4000-8000-000000000002',
               'c3c30000-0000-4000-8000-000000000003')
GROUP BY r.name, sp.name
ORDER BY r.name;

-- §3 · Riders linkeados por user_id (delivery-rider.html los resuelve) ────
SELECT dr.name, r.name AS restaurante, dr.user_id, (dr.user_id IS NOT NULL) AS linkeado, dr.rider_pin
FROM public.delivery_riders dr
JOIN public.restaurants r ON r.id = dr.restaurant_id
WHERE dr.restaurant_id IN ('a1a10000-0000-4000-8000-000000000001',
                           'b2b20000-0000-4000-8000-000000000002',
                           'c3c30000-0000-4000-8000-000000000003')
ORDER BY r.name, dr.name;

-- §4 · GUARDA: Renato (cuenta oficial) intacto y único superadmin real ───
--    Debe seguir existiendo, restaurant_id NULL, NO @mythos.test.
SELECT 'RENATO' AS check_label,
       au.email,
       (au.email = 'mancuellorenato@gmail.com') AS es_cuenta_oficial,
       ur.role,
       ur.restaurant_id
FROM auth.users au
LEFT JOIN public.user_roles ur ON ur.user_id = au.id
WHERE au.email = 'mancuellorenato@gmail.com';

-- §5 · GUARDA: Terrapizza presente y FUERA de la allowlist sim ───────────
SELECT 'TERRAPIZZA' AS check_label,
       count(*) AS filas_terrapizza,
       bool_or(id NOT IN ('a1a10000-0000-4000-8000-000000000001',
                          'b2b20000-0000-4000-8000-000000000002',
                          'c3c30000-0000-4000-8000-000000000003')) AS fuera_de_allowlist_sim
FROM public.restaurants
WHERE name ILIKE '%terrapizza%';

-- §6 · Conteo de superadmins (esperado: Renato + superadmin.demo = 2) ─────
SELECT count(*) AS superadmins_total,
       string_agg(email, ', ' ORDER BY email) AS emails
FROM public.user_roles
WHERE lower(role) = 'superadmin';
