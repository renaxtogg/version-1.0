-- ════════════════════════════════════════════════════════════════════
-- 144 · marketplace_superadmin_public — Marketplace B2B FASE 3 (cierre)
-- ────────────────────────────────────────────────────────────────────
-- PR-MKT-3. Lo mínimo que la RLS de la mig 142 no cubre para (a) el
-- formulario público de captación y (b) la gestión total del superadmin:
--
--   1. anon SELECT de categorías ACTIVAS (catálogo público del formulario).
--      La mig 142 dejó marketplace_categories con REVOKE ALL FROM anon +
--      policy solo TO authenticated → el formulario público no podía listar
--      categorías. Patrón "catálogo global sin PII" de la mig 134: GRANT
--      SELECT a anon + policy USING (activa = true). Nada más se abre a anon.
--
--   2. superadmin_marketplace_stats() → jsonb. El tab "Resumen" del panel
--      necesita agregaciones (conteos por estado, leads del mes por tipo,
--      top-5 categorías y proveedores por leads) que PostgREST no resuelve
--      en 1 request (GROUP BY + ORDER BY + LIMIT). RPC DEFINER fail-closed
--      superadmin (patrón mig 135). Solo lee; no muta nada.
--
--   3. superadmin_set_supplier_estado(p_supplier_id, p_estado). Suspender/
--      reactivar un proveedor + registrar el evento en marketplace_events
--      de forma ATÓMICA. Necesaria porque marketplace_events es append-only:
--      la mig 142 revocó INSERT incluso a authenticated (eventos solo por
--      funciones DEFINER/service_role). El superadmin YA puede editar estado
--      directo (pasa el guard), pero el evento de auditoría exige esta vía.
--
-- ⚠️ GUARD TRIGGER (verificado, SIN cambios): marketplace_suppliers_guard
--    (mig 142) permite al superadmin editar TODOS los campos administrados
--    (slug/nombre/ruc/plan/verificado/destacado/estado) porque su primera
--    rama es `current_user IN ('postgres','supabase_admin','service_role')
--    OR get_my_role() = 'superadmin' → RETURN NEW`. No bloquea al superadmin;
--    no se toca. Esta migración NO altera tablas, policies existentes ni el
--    trigger — solo agrega 1 policy anon nueva y 2 funciones.
--
-- PREPARED — NOT APPLIED: aplicar A MANO en el SQL Editor (inglés) tras
-- backup, DESPUÉS de la 142 y la 143. Idempotente (re-ejecutable).
-- Revertir:
--   DROP FUNCTION public.superadmin_set_supplier_estado(uuid, text);
--   DROP FUNCTION public.superadmin_marketplace_stats();
--   DROP POLICY "mkp_categories_anon_select" ON public.marketplace_categories;
--   REVOKE SELECT ON public.marketplace_categories FROM anon;
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. Catálogo público de categorías para el formulario anon ──────
-- Defensa en 2 capas (patrón mig 132/134): privilegio + policy. La policy
-- filtra a activa=true; sin PII (slug/nombre/orden). El resto de las tablas
-- marketplace_* siguen con CERO acceso anon.
GRANT SELECT ON public.marketplace_categories TO anon;

DROP POLICY IF EXISTS "mkp_categories_anon_select" ON public.marketplace_categories;
CREATE POLICY "mkp_categories_anon_select" ON public.marketplace_categories
  FOR SELECT TO anon
  USING (activa = true);

-- ─── 2. superadmin_marketplace_stats ────────────────────────────────
CREATE OR REPLACE FUNCTION public.superadmin_marketplace_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  -- Inicio del mes en curso en hora de Paraguay (el navegador del superadmin
  -- puede estar en otra zona). Instante exacto como timestamptz.
  v_ms timestamptz := timezone('America/Asuncion', date_trunc('month', timezone('America/Asuncion', now())));
  v_out jsonb;
BEGIN
  -- Fail-closed: solo superadmin (COALESCE por si get_my_role() es NULL/anon).
  IF NOT COALESCE(public.get_my_role() = 'superadmin', false) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  v_out := jsonb_build_object(
    'suppliers', (
      SELECT jsonb_build_object(
        'activo',     count(*) FILTER (WHERE estado = 'activo'),
        'pausado',    count(*) FILTER (WHERE estado = 'pausado'),
        'suspendido', count(*) FILTER (WHERE estado = 'suspendido'),
        'verificado', count(*) FILTER (WHERE verificado),
        'destacado',  count(*) FILTER (WHERE destacado),
        'total',      count(*)
      ) FROM public.marketplace_suppliers
    ),
    'products', (
      SELECT jsonb_build_object(
        'publicado',    count(*) FILTER (WHERE estado = 'publicado'),
        'borrador',     count(*) FILTER (WHERE estado = 'borrador'),
        'pausado',      count(*) FILTER (WHERE estado = 'pausado'),
        'oculto_admin', count(*) FILTER (WHERE estado = 'oculto_admin'),
        'total',        count(*)
      ) FROM public.marketplace_products
    ),
    'applications', (
      SELECT jsonb_build_object(
        'pendiente',     count(*) FILTER (WHERE estado = 'pendiente'),
        'en_revision',   count(*) FILTER (WHERE estado = 'en_revision'),
        'falta_info',    count(*) FILTER (WHERE estado = 'falta_info'),
        'aprobada',      count(*) FILTER (WHERE estado = 'aprobada'),
        'rechazada',     count(*) FILTER (WHERE estado = 'rechazada'),
        'abiertas',      count(*) FILTER (WHERE estado IN ('pendiente','en_revision','falta_info')),
        'total',         count(*)
      ) FROM public.marketplace_applications
    ),
    'leads_month', (
      SELECT jsonb_build_object(
        'contacto',   count(*) FILTER (WHERE tipo = 'contacto'),
        'cotizacion', count(*) FILTER (WHERE tipo = 'cotizacion'),
        'total',      count(*)
      ) FROM public.marketplace_leads WHERE created_at >= v_ms
    ),
    'leads_total', (
      SELECT jsonb_build_object(
        'contacto',   count(*) FILTER (WHERE tipo = 'contacto'),
        'cotizacion', count(*) FILTER (WHERE tipo = 'cotizacion'),
        'total',      count(*)
      ) FROM public.marketplace_leads
    ),
    'contacts_revealed_month', (
      SELECT count(*) FROM public.marketplace_events
      WHERE event_type = 'contact_revealed' AND created_at >= v_ms
    ),
    'quotes_month', (
      SELECT count(*) FROM public.marketplace_events
      WHERE event_type = 'quote_created' AND created_at >= v_ms
    ),
    'conversations_active', (
      SELECT count(*) FROM public.marketplace_conversations
      WHERE last_message_at >= now() - interval '30 days'
    ),
    'conversations_total', (
      SELECT count(*) FROM public.marketplace_conversations
    ),
    'reports_open', (
      SELECT count(*) FROM public.marketplace_reports
      WHERE estado IN ('abierto','en_revision')
    ),
    'reviews_total', (
      SELECT count(*) FROM public.marketplace_reviews
    ),
    -- Top 5 categorías por leads: cada lead se atribuye a TODAS las categorías
    -- de su proveedor (unnest del array categorias). "Qué rubros generan demanda".
    'top_categories', (
      SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (
        SELECT c.slug, c.nombre, count(*)::int AS leads
        FROM public.marketplace_leads l
        JOIN public.marketplace_suppliers s ON s.id = l.supplier_id
        CROSS JOIN LATERAL unnest(s.categorias) AS cat(slug)
        JOIN public.marketplace_categories c ON c.slug = cat.slug
        GROUP BY c.slug, c.nombre
        ORDER BY count(*) DESC, c.nombre ASC
        LIMIT 5
      ) t
    ),
    -- Top 5 proveedores por leads recibidos (contactos + cotizaciones).
    'top_suppliers', (
      SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (
        SELECT s.id AS supplier_id, s.nombre_comercial, s.estado, count(*)::int AS leads
        FROM public.marketplace_leads l
        JOIN public.marketplace_suppliers s ON s.id = l.supplier_id
        GROUP BY s.id, s.nombre_comercial, s.estado
        ORDER BY count(*) DESC, s.nombre_comercial ASC
        LIMIT 5
      ) t
    )
  );

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.superadmin_marketplace_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.superadmin_marketplace_stats() TO authenticated;

-- ─── 3. superadmin_set_supplier_estado ──────────────────────────────
-- Suspende/reactiva un proveedor y deja el evento de auditoría en una sola
-- transacción. DEFINER (owner postgres) → puede INSERT en marketplace_events
-- (append-only para authenticated) y pasa el guard del trigger.
CREATE OR REPLACE FUNCTION public.superadmin_set_supplier_estado(
  p_supplier_id uuid,
  p_estado      text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old   text;
  v_event text;
BEGIN
  IF NOT COALESCE(public.get_my_role() = 'superadmin', false) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_supplier_id IS NULL OR p_estado IS NULL OR p_estado NOT IN ('activo','pausado','suspendido') THEN
    RAISE EXCEPTION 'estado inválido' USING ERRCODE = '22023';
  END IF;

  SELECT estado INTO v_old FROM public.marketplace_suppliers WHERE id = p_supplier_id;
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'proveedor inexistente' USING ERRCODE = '22023';
  END IF;

  IF v_old = p_estado THEN
    RETURN jsonb_build_object('ok', true, 'estado', p_estado, 'changed', false);
  END IF;

  UPDATE public.marketplace_suppliers
     SET estado = p_estado
   WHERE id = p_supplier_id;

  -- Evento según la transición (suspender / reactivar / cambio interno).
  v_event := CASE
    WHEN p_estado = 'suspendido'                              THEN 'supplier_suspended'
    WHEN v_old   = 'suspendido' AND p_estado <> 'suspendido'  THEN 'supplier_reactivated'
    ELSE 'supplier_estado_changed'
  END;

  INSERT INTO public.marketplace_events (event_type, supplier_id, actor_user, metadata)
  VALUES (v_event, p_supplier_id, auth.uid(),
          jsonb_build_object('from', v_old, 'to', p_estado));

  RETURN jsonb_build_object('ok', true, 'estado', p_estado, 'changed', true, 'event', v_event);
END;
$$;

REVOKE ALL ON FUNCTION public.superadmin_set_supplier_estado(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.superadmin_set_supplier_estado(uuid, text) TO authenticated;

COMMIT;

-- Recargar el cache de esquema de PostgREST (policy anon + funciones nuevas)
NOTIFY pgrst, 'reload schema';

SELECT 'migracion 144 aplicada (marketplace FASE 3: anon categorías + superadmin_marketplace_stats + superadmin_set_supplier_estado)' AS status;
