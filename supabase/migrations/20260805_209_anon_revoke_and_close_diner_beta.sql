-- ════════════════════════════════════════════════════════════════════════════
-- 209 — REVOKE de `anon` donde la 207 dice "anon: CERO", y cierre de la beta
--       de comensales
-- ════════════════════════════════════════════════════════════════════════════
-- Medido contra producción el 2026-08-05 con la anon key: `mythos_riders`,
-- `mythos_rider_contracts`, `payment_reviews` y `frequent_customers` responden
-- **200 con lista vacía**, no 401. La diferencia importa: 401 es "no tenés
-- GRANT de tabla"; 200 [] es "tenés GRANT y lo único que te frena es la RLS".
--
-- Compará con `customers`, `diners` y `gift_cards`, que responden 401. Ésas
-- están bien. Las cuatro de arriba, no — y la §18 de la mig 207 declara
-- literalmente "GRANTS de tabla (anon: CERO en todo lo nuevo)" y sólo hace
-- GRANT ... TO authenticated. O sea: el GRANT de `anon` no lo puso la 207.
-- Viene de arrastre (un `GRANT ... ON ALL TABLES IN SCHEMA public TO anon`
-- viejo, o un `ALTER DEFAULT PRIVILEGES` que sigue vivo y le regala privilegios
-- a cada tabla nueva). Esta migración corrige el efecto; la causa la identifica
-- `docs/security/rls_audit_readonly.sql`, que hay que correr después.
--
-- ¿Por qué importa si hoy no filtra nada? Porque hoy la RLS tapa por dos
-- razones frágiles: las policies son correctas Y las tablas están vacías. La
-- primera policy mal escrita, o la primera tabla con datos, convierte esto en
-- una fuga. Y `mythos_riders` guarda documento de identidad, domicilio y cuenta
-- bancaria de cada repartidor de la plataforma. La defensa en capas no es
-- redundancia: es lo que hace que un error no sea un incidente.
--
-- SEGURIDAD DEL CAMBIO — verificado archivo por archivo antes de escribirlo:
--   · `mythos_*`             → sólo `src/superadmin/main.jsx` (authenticated).
--                              `/riders` es anon pero entra por RPC
--                              (`rider_public_config`), nunca por tabla.
--   · `payment_reviews`      → sólo `caja` y `mozo` vía `recordPaymentReview()`
--                              (authenticated). `index` y `delivery-cliente`
--                              importan `shared/comprobante.jsx` pero NO llaman
--                              esa función: el cliente sube su comprobante por
--                              `attach_payment_proof` (RPC, mig 183).
--   · `frequent_customers`   → sólo `src/admin/main.jsx` (authenticated).
-- Ningún camino de `anon` toca estas tablas directamente. El REVOKE no puede
-- romper el menú QR, el delivery ni la landing de riders.
--
-- NO toca policies ni RLS: eso es el sprint aparte del `USING(true)`, que es
-- donde está el riesgo de apagar paneles. Esto sólo saca privilegios que nadie
-- usa.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1) Las 15 tablas de la Red de Riders (mig 207 §18) ──────────────────────
-- Se listan TODAS, no sólo las dos que medí, porque las 15 vienen del mismo
-- arrastre y ninguna tiene un camino anon. Es idempotente: revocar lo que no
-- está otorgado no falla.
REVOKE ALL ON
  public.mythos_rider_config,
  public.mythos_rider_doc_types,
  public.mythos_rider_rating_dimensions,
  public.mythos_rider_contract_versions,
  public.mythos_riders,
  public.mythos_rider_documents,
  public.mythos_rider_contracts,
  public.mythos_delivery_partners,
  public.mythos_rider_offers,
  public.mythos_rider_ratings,
  public.mythos_rider_incidents,
  public.mythos_rider_cases,
  public.mythos_rider_case_messages,
  public.mythos_rider_notifications,
  public.mythos_rider_settlements
FROM anon;

-- ── 2) Cobros: comprobantes y clientes frecuentes ───────────────────────────
-- `payment_reviews` es el libro inmutable de aprobaciones/rechazos de pago
-- (mig 182) y `frequent_customers` es PII de clientes del local (mig 184).
REVOKE ALL ON
  public.payment_reviews,
  public.frequent_customers
FROM anon;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- 3) CIERRE DE LA BETA DE COMENSALES
-- ════════════════════════════════════════════════════════════════════════════
-- `diner_app_config.is_public` quedó en `true` en producción. Con eso,
-- `diner_access_allowed()` (mig 200) sale por su `RETURN true` ANTES de mirar
-- `diner_app_access`, así que la allowlist de la beta cerrada no filtra a
-- nadie: cualquier cuenta con sesión podía crear perfil de comensal. Fue así
-- como cuentas de restaurante terminaron en el ranking de comensales.
--
-- El código ya se arregló (commit 7af5e92: el alta dejó de ser automática),
-- pero eso es la segunda capa. Ésta es la primera.
--
-- `public_browse_enabled` NO se toca: ése es el interruptor de MIRAR la vitrina
-- sin cuenta (mig 201) y es el que Renato sí quería prendido. Son distintos, y
-- confundirlos fue el origen de todo esto.
--
-- Si por algún motivo querés dejar la beta abierta, comentá este bloque: es lo
-- único de esta migración que cambia datos y no privilegios, y se revierte con
-- un click en Superadmin › Comensales.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

UPDATE public.diner_app_config
   SET is_public = false,
       updated_at = now()
 WHERE id AND is_public IS DISTINCT FROM false;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN — corré esto después y pegame la salida
-- ════════════════════════════════════════════════════════════════════════════
-- Esperado: `anon_privs` vacío en las 17 tablas, y `beta_abierta` = false.
SELECT jsonb_pretty(jsonb_build_object(
  'anon_todavia_con_grant', COALESCE((
     SELECT jsonb_agg(DISTINCT g.table_name ORDER BY g.table_name)
       FROM information_schema.role_table_grants g
      WHERE g.table_schema = 'public'
        AND g.grantee = 'anon'
        AND (g.table_name LIKE 'mythos_rider%'
             OR g.table_name IN ('mythos_delivery_partners','payment_reviews','frequent_customers'))
  ), '[]'::jsonb),
  'beta_abierta', (SELECT is_public FROM public.diner_app_config WHERE id),
  'vitrina_publica', (SELECT public_browse_enabled FROM public.diner_app_config WHERE id)
)) AS resultado_209;
