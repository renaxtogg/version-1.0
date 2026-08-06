-- ════════════════════════════════════════════════════════════════════════════
-- 210 — `anon` con el privilegio mínimo, y la canilla que lo regeneraba
-- ════════════════════════════════════════════════════════════════════════════
-- La auditoría de sólo lectura (2026-08-06) encontró la CAUSA de lo que la 209
-- venía tapando de a una tabla:
--
--   pg_default_acl, esquema public, tipo 'r' (tablas):
--     {postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres, ...}
--
-- `arwdDxtm` es TODO (insert, select, update, delete, truncate, references,
-- trigger, maintain). O sea: hay un ALTER DEFAULT PRIVILEGES vivo que le da
-- **todos los privilegios a `anon` sobre cada tabla nueva** del esquema public.
-- Por eso `mythos_riders`, `payment_reviews`, `frequent_customers` y
-- `diner_experiences` nacieron con permisos de anon aunque la mig 207 declare
-- "anon: CERO en todo lo nuevo" y sólo otorgue a `authenticated`: la tabla ya
-- venía otorgada de fábrica antes de que la migración dijera nada.
--
-- Revocar de a una era barrer con la canilla abierta. Esta migración cierra la
-- canilla (§3) y de paso limpia lo que quedó (§1 y §2).
--
-- LO QUE `anon` NECESITA DE VERDAD — medido leyendo todo `.from()` de los
-- paneles anónimos (`src/index`, `src/delivery-cliente`) y de las páginas
-- sueltas de `public/`:
--   select : coupons, menu_categories, menu_items, restaurants, tables,
--            marketplace_categories, subscription_plans, marketing_*
--   insert : orders, order_items, order_item_extras, order_status_history,
--            ratings, reservations, waiter_calls, leads_prospectos,
--            marketing_leads, marketing_events
--   +      : delivery_orders (insert/select/update — el cliente sigue su pedido)
-- Nada más. Todo lo demás que hoy tiene otorgado es arrastre del default.
--
-- ⚠️ ALCANCE DE LA MEDICIÓN: `information_schema.role_table_grants` sólo ve
-- privilegios de TABLA. Los de COLUMNA viven en `role_column_grants`, y por eso
-- `orders`/`delivery_orders`/`restaurants` no aparecían en el listado aunque el
-- cliente sí los usa (la mig 102 recortó el SELECT de anon columna por columna).
-- Esta migración NO toca nada de eso — deliberadamente. Sólo saca privilegios
-- de tabla que ningún camino de anon usa.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1) Revocar TODO: tablas que ningún camino anónimo toca ──────────────────
-- `user_roles` es la más importante de la lista: es de dónde salen el rol y el
-- restaurante de cada persona. Hoy la RLS le devuelve 0 filas a anon (probado),
-- pero el GRANT incluía INSERT/UPDATE/DELETE, así que la única cosa entre la
-- anon key y reescribir un rol era que ninguna policy de escritura la dejara
-- pasar. Eso es una capa, no dos. Lo lee `public/login.html`, pero DESPUÉS del
-- login — ahí la sesión ya es `authenticated`.
-- Caja (`turnos_caja`, `movimientos_caja`, `cancelaciones_caja`) es un panel
-- autenticado de punta a punta. `table_scan_sessions` y `quejas_sugerencias`
-- sólo los tocan admin/caja/gerente/superadmin; el QR llega a la sesión de mesa
-- por RPC (SECURITY DEFINER), que no mira estos GRANT.
REVOKE ALL ON
  public.user_roles,
  public.turnos_caja,
  public.movimientos_caja,
  public.cancelaciones_caja,
  public.table_scan_sessions,
  public.quejas_sugerencias
FROM anon;

-- ── 2) Bajar a lo mínimo: lo que anon sí usa, pero sólo para leer o crear ───
-- Menú y mesas: el cliente los LEE para armar el pedido. Editarlos es del
-- admin. Con el DELETE que tenían, la anon key podía borrar el menú entero de
-- un restaurante real si alguna policy de escritura lo dejaba pasar.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON
  public.menu_items,
  public.menu_categories,
  public.menu_item_extras,
  public.menu_item_variants,
  public.tables
FROM anon;

-- Vitrina de /clientes: anon las lee (policies `dexp_read`/`dexpp_read`, mig
-- 204). Escribirlas es del superadmin.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON
  public.diner_experiences,
  public.diner_experience_places
FROM anon;

-- El comensal deja su calificación y llama al mozo: eso es INSERT y nada más.
-- Con UPDATE/DELETE podía editar o borrar la reseña de otro.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON
  public.ratings,
  public.waiter_calls
FROM anon;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- 3) LA CANILLA — que las tablas nuevas no nazcan otorgadas a `anon`
-- ════════════════════════════════════════════════════════════════════════════
-- Sin esto, la próxima migración que cree una tabla vuelve a empezar de cero:
-- nace con arwdDxtm para anon y hay que acordarse de revocar. "Acordarse" no es
-- un control de seguridad.
--
-- Sólo se toca el default de `anon`. El de `authenticated` se deja como está a
-- propósito: los 11 paneles operan por acceso directo a tablas como
-- `authenticated`, y revocarle el default dejaría a cada tabla nueva invisible
-- para el panel que la usa hasta que alguien escriba el GRANT. Eso es un cambio
-- de flujo de trabajo, no un parche, y va en su propia migración discutida.
--
-- CONSECUENCIA A PARTIR DE ACÁ: toda migración que cree una tabla que el
-- cliente anónimo deba leer o escribir tiene que otorgarlo EXPLÍCITAMENTE
-- (`GRANT SELECT ON public.x TO anon;`). Queda anotado en CLAUDE.md.
--
-- Hay DOS entradas de default en `pg_default_acl` para public/'r': una del rol
-- `postgres` y otra de `supabase_admin`. Se corrige la de `postgres`, que es la
-- que aplica a las tablas creadas desde el SQL Editor y por las migraciones.
-- La de `supabase_admin` es de la plataforma y puede no ser alterable desde
-- acá; si el bloque falla por permisos, ejecutá igual el resto — la
-- verificación de abajo dice si quedó cubierto.
-- ════════════════════════════════════════════════════════════════════════════
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN — corré esto después y pegame la salida
-- ════════════════════════════════════════════════════════════════════════════
-- Esperado:
--   · `anon_con_escritura` → sólo las tablas donde el cliente CREA algo:
--     orders, order_items, order_item_extras, order_status_history, ratings,
--     reservations, waiter_calls, delivery_orders, leads_prospectos,
--     marketing_leads, marketing_events.  Si aparece otra, avisame.
--   · `default_anon_tablas` → false (la canilla quedó cerrada).
SELECT jsonb_pretty(jsonb_build_object(
  'anon_con_escritura', COALESCE((
     SELECT jsonb_agg(jsonb_build_object('tabla', t.table_name, 'privs', t.privs)
                      ORDER BY t.table_name)
       FROM (SELECT g.table_name,
                    string_agg(DISTINCT g.privilege_type, ',' ORDER BY g.privilege_type) AS privs
               FROM information_schema.role_table_grants g
              WHERE g.table_schema='public' AND g.grantee='anon'
                AND g.privilege_type <> 'SELECT'
              GROUP BY g.table_name) t), '[]'::jsonb),
  'anon_total_tablas', (SELECT count(DISTINCT table_name)
                          FROM information_schema.role_table_grants
                         WHERE table_schema='public' AND grantee='anon'),
  'default_anon_tablas', EXISTS (
     SELECT 1 FROM pg_default_acl d
      LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
     WHERE n.nspname='public' AND d.defaclobjtype='r'
       AND d.defaclacl::text LIKE '%anon=%')
)) AS resultado_210;
