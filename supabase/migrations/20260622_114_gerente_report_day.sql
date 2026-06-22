-- ════════════════════════════════════════════════════════════════════
-- 114 · get_gerente_report_day — resumen del día para el panel Gerente
-- ────────────────────────────────────────────────────────────────────
-- Reemplaza las 4 queries sueltas que ReportesDelDia agregaba en cliente por
-- una sola RPC con el scope de tenant garantizado server-side. Esto también
-- blinda G1: order_items se acota vía JOIN a orders.restaurant_id (la tabla
-- order_items no tiene columna restaurant_id).
--
-- ALCANCE / SEGURIDAD:
--   • 100% ADITIVA: solo CREATE OR REPLACE FUNCTION + GRANT/REVOKE de esa
--     función. No toca tablas, columnas, datos ni políticas existentes.
--     No hay DROP/ALTER destructivo.
--   • SECURITY DEFINER + SET search_path = public (convención del repo,
--     migs 092/107/108).
--   • Guarda de tenant fail-closed: superadmin ve todo; cualquier otro rol
--     solo restaurantes de su empresa (get_my_company_restaurant_ids).
--     anon queda revocado explícitamente.
--   • Ventana del día en America/Asuncion para alinear con el día comercial
--     paraguayo independientemente del huso del dispositivo.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

CREATE OR REPLACE FUNCTION public.get_gerente_report_day(
  p_restaurant_id uuid,
  p_date          date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz            text        := 'America/Asuncion';
  v_start         timestamptz;
  v_end           timestamptz;
  v_ystart        timestamptz;
  v_sales_today   bigint  := 0;
  v_sales_yest    bigint  := 0;
  v_tickets_today bigint  := 0;
  v_avg_service   numeric := 0;
  v_completed     bigint  := 0;
  v_appr_total    bigint  := 0;
  v_appr_ok       bigint  := 0;
  v_appr_no       bigint  := 0;
  v_by_waiter     jsonb   := '[]'::jsonb;
  v_top_items     jsonb   := '[]'::jsonb;
  v_cancels       jsonb   := '[]'::jsonb;
BEGIN
  -- ── Guarda de tenant (fail-closed) ──────────────────────────────────
  IF NOT COALESCE(
       public.get_my_role() = 'superadmin'
       OR p_restaurant_id IN (SELECT public.get_my_company_restaurant_ids()),
       false)
  THEN
    RETURN NULL;
  END IF;

  v_start  := (p_date::timestamp        AT TIME ZONE v_tz);
  v_end    := ((p_date + 1)::timestamp  AT TIME ZONE v_tz);
  v_ystart := ((p_date - 1)::timestamp  AT TIME ZONE v_tz);

  -- ── Ventas cobradas hoy / ayer ──────────────────────────────────────
  SELECT COALESCE(SUM(total),0) INTO v_sales_today
    FROM public.orders
   WHERE restaurant_id = p_restaurant_id
     AND payment_status = 'paid'
     AND created_at >= v_start AND created_at < v_end;

  SELECT COALESCE(SUM(total),0) INTO v_sales_yest
    FROM public.orders
   WHERE restaurant_id = p_restaurant_id
     AND payment_status = 'paid'
     AND created_at >= v_ystart AND created_at < v_start;

  SELECT COUNT(*) INTO v_tickets_today
    FROM public.orders
   WHERE restaurant_id = p_restaurant_id
     AND payment_status = 'paid'
     AND created_at >= v_start AND created_at < v_end;

  -- ── Tiempo medio de servicio (órdenes con paid_at hoy) ──────────────
  SELECT COUNT(*),
         COALESCE(AVG(EXTRACT(EPOCH FROM (paid_at - created_at)) / 60.0), 0)
    INTO v_completed, v_avg_service
    FROM public.orders
   WHERE restaurant_id = p_restaurant_id
     AND paid_at IS NOT NULL
     AND created_at >= v_start AND created_at < v_end;

  -- ── Aprobaciones de hoy ─────────────────────────────────────────────
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE status = 'aprobado'),
         COUNT(*) FILTER (WHERE status = 'rechazado')
    INTO v_appr_total, v_appr_ok, v_appr_no
    FROM public.manager_approvals
   WHERE restaurant_id = p_restaurant_id
     AND created_at >= v_start AND created_at < v_end;

  -- ── Ventas por mozo (todas las órdenes del día con mozo) ────────────
  SELECT COALESCE(jsonb_agg(w ORDER BY w.sales DESC), '[]'::jsonb) INTO v_by_waiter
  FROM (
    SELECT COALESCE(waiter_name, '—') AS name,
           COALESCE(SUM(total), 0)    AS sales,
           COUNT(*)                   AS count
      FROM public.orders
     WHERE restaurant_id = p_restaurant_id
       AND waiter_id IS NOT NULL
       AND created_at >= v_start AND created_at < v_end
     GROUP BY waiter_id, waiter_name
  ) w;

  -- ── Top productos del día (JOIN a orders = scope de tenant, blinda G1)
  SELECT COALESCE(jsonb_agg(ti ORDER BY ti.qty DESC), '[]'::jsonb) INTO v_top_items
  FROM (
    SELECT oi.item_name                  AS name,
           COALESCE(SUM(oi.quantity), 0)    AS qty,
           COALESCE(SUM(oi.total_price), 0) AS total
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
     WHERE o.restaurant_id = p_restaurant_id
       AND o.created_at >= v_start AND o.created_at < v_end
     GROUP BY oi.item_name
     ORDER BY qty DESC
     LIMIT 10
  ) ti;

  -- ── Cancelaciones de hoy ────────────────────────────────────────────
  SELECT COALESCE(jsonb_agg(c ORDER BY c.created_at DESC), '[]'::jsonb) INTO v_cancels
  FROM (
    SELECT created_at,
           motivo,
           monto_cancelado AS monto
      FROM public.cancelaciones_caja
     WHERE restaurant_id = p_restaurant_id
       AND created_at >= v_start AND created_at < v_end
  ) c;

  RETURN jsonb_build_object(
    'sales_today',        v_sales_today,
    'sales_yesterday',    v_sales_yest,
    'tickets_today',      v_tickets_today,
    'avg_service_min',    round(v_avg_service, 1),
    'completed_count',    v_completed,
    'approvals_total',    v_appr_total,
    'approvals_approved', v_appr_ok,
    'approvals_rejected', v_appr_no,
    'by_waiter',          v_by_waiter,
    'top_items',          v_top_items,
    'cancellations',      v_cancels
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_gerente_report_day(uuid, date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_gerente_report_day(uuid, date) TO authenticated;

COMMIT;

-- Recargar el caché de esquema de PostgREST para exponer la RPC.
NOTIFY pgrst, 'reload schema';

SELECT 'migration 114 applied — get_gerente_report_day' AS status;
