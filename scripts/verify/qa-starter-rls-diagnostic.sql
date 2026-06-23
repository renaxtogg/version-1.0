-- ════════════════════════════════════════════════════════════════════
-- DIAGNÓSTICO (SOLO LECTURA) — RLS "new row violates row-level security
-- policy" al crear categorías/mesas desde admin.html.
--
-- Síntoma: el panel muestra "[SIM] QA Starter", las listas salen vacías
-- y crear categoría/mesa devuelve el error de RLS.
--
-- Causa raíz (verificada en código): la política de INSERT de
-- menu_categories / tables (mig 092) exige
--     restaurant_id IN (SELECT get_my_company_restaurant_ids())
--     OR get_my_role() = 'superadmin'
-- es decir, el restaurante que el panel opera (localStorage
-- mythos_restaurant_id = RID) debe pertenecer al usuario logueado.
-- El nombre del restaurante SÍ se ve aunque no tengas acceso, porque
-- restaurants tiene una política de lectura abierta (read_restaurants),
-- así que el encabezado engaña: ver el nombre ≠ poder escribir.
--
-- Ejecutar en Supabase SQL Editor (dashboard en INGLÉS). NO modifica nada.
-- QA Starter restaurant id: f1f10000-0000-4000-8000-000000000001
-- QA Starter admin user id: f1110000-0000-4000-8000-000000000001
-- ════════════════════════════════════════════════════════════════════

-- 1) ¿Existe el admin de QA Starter y a qué restaurante mapea?
--    Esperado: 1 fila admin, is_active=true, restaurant_id = f1f10000…0001,
--    r.name = '[SIM] QA Starter'.
SELECT ur.email, ur.role, ur.is_active, ur.restaurant_id, r.name AS restaurante
FROM   public.user_roles ur
LEFT   JOIN public.restaurants r ON r.id = ur.restaurant_id
WHERE  ur.email LIKE '%.starter@mythos.test'
ORDER  BY ur.role;

-- 2) ¿Existe el restaurante QA Starter + su suscripción/plan?
SELECT r.id, r.name, r.is_active, r.parent_company_id, sp.name AS plan, s.status
FROM   public.restaurants r
LEFT   JOIN public.subscriptions s        ON s.restaurant_id = r.id
LEFT   JOIN public.subscription_plans sp  ON sp.id = s.plan_id
WHERE  r.id = 'f1f10000-0000-4000-8000-000000000001';

-- 3) ¿Algún usuario con MÁS de un rol activo? Las funciones helper
--    get_my_company_restaurant_ids() / get_my_restaurant_id() usan
--    LIMIT 1 SIN ORDER BY: con >1 fila activa, login y RLS pueden elegir
--    filas distintas y producir EXACTAMENTE este síntoma.
SELECT user_id, COUNT(*) AS roles_activos,
       string_agg(role || ':' || COALESCE(restaurant_id::text,'NULL'), ', ') AS detalle
FROM   public.user_roles
WHERE  is_active = true
GROUP  BY user_id
HAVING COUNT(*) > 1;

-- 4) Qué devolvería get_my_company_restaurant_ids() para el admin de QA
--    Starter (réplica de la lógica de la mig 092, sin depender de auth.uid()).
--    Esperado: una sola fila = f1f10000-0000-4000-8000-000000000001.
WITH me AS (
  SELECT ur.restaurant_id AS v_rid, ur.role AS v_role
  FROM public.user_roles ur
  WHERE ur.user_id = 'f1110000-0000-4000-8000-000000000001'
    AND ur.is_active = true
  LIMIT 1
), root AS (
  SELECT COALESCE(r.parent_company_id, r.id) AS v_root
  FROM public.restaurants r, me
  WHERE r.id = me.v_rid
)
SELECT b.id AS restaurante_autorizado, b.name
FROM public.restaurants b, root
WHERE b.id = root.v_root OR b.parent_company_id = root.v_root;

-- ── Lectura del resultado ────────────────────────────────────────────
--  • (1) sin filas  → el seed _simulacion/08_qa_visual_plans.sql NO está
--        aplicado: aplicalo y reintentá (login admin.starter@mythos.test).
--  • (1) ok pero (4) vacía → revisá (2)/(3): restaurante inexistente,
--        parent_company_id colgado, o roles duplicados (LIMIT 1).
--  • (1) y (4) ok → el problema es el RID en el navegador (sesión
--        equivocada / localStorage viejo): cerrar sesión y volver a
--        loguear como el admin del restaurante correcto.
