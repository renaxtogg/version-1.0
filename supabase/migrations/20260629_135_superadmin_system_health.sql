-- ════════════════════════════════════════════════════════════════════
-- 135 · RPC superadmin_system_health() — métricas REALES de salud del sistema
-- ────────────────────────────────────────────────────────────────────
-- Alimenta el "centro de salud en vivo" del panel superadmin (semáforo,
-- alertas, actividad). Devuelve métricas reales de Postgres + operativas que
-- la anon key NO puede obtener (pg_database_size / pg_stat_activity).
--
-- SEGURIDAD: SECURITY DEFINER (corre como owner para leer las vistas de
-- sistema), pero el cuerpo aborta si el llamador NO es superadmin. Se concede
-- EXECUTE a authenticated (el chequeo interno restringe a superadmin) — NO se
-- expone pg_stat_activity ni el tamaño de la BD a otros roles.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

CREATE OR REPLACE FUNCTION public.superadmin_system_health()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  result json;
BEGIN
  -- Fail-CLOSED: get_my_role() devuelve NULL para anon / usuarios sin rol activo,
  -- y `NULL <> 'superadmin'` es NULL (que plpgsql trata como falso en un IF) →
  -- la forma negativa dejaría pasar al NULL. El COALESCE convierte ese caso en
  -- denegación (mismo idiom que las migs 114/122).
  IF NOT COALESCE(public.get_my_role() = 'superadmin', false) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;

  SELECT json_build_object(
    -- Postgres (vistas de sistema — sólo accesibles vía este DEFINER)
    'db_size_bytes',    pg_database_size(current_database()),
    'db_conn_active',   (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()),
    'db_conn_max',      current_setting('max_connections')::int,
    -- Operativo
    'concurrent_staff', (SELECT count(*) FROM public.staff_sessions WHERE logout_at IS NULL),
    'orders_24h',       (SELECT count(*) FROM public.orders WHERE created_at >= now() - interval '24 hours'),
    -- "Trabados": pedidos en estados operativos no-finales (pagado → listo) con +2h sin avanzar.
    -- (draft = carrito abandonado y confirmed = pre-pago quedan FUERA; delivered/cancelled son finales.)
    'stuck_orders',     (SELECT count(*) FROM public.orders
                          WHERE status IN ('paid','kitchen_received','cooking','ready')
                            AND created_at < now() - interval '2 hours'),
    'last_event_at',    (SELECT max(created_at) FROM public.platform_events),
    'generated_at',     now()
  ) INTO result;

  RETURN result;
END;
$$;

-- CREATE FUNCTION concede EXECUTE a PUBLIC por defecto (y PUBLIC incluye anon).
-- Lo revocamos explícitamente (patrón de migs 103/105/114) y concedemos SOLO a
-- authenticated; el chequeo interno además restringe a superadmin. Sin este
-- REVOKE, anon podría invocar la RPC vía PostgREST con la anon key pública.
REVOKE ALL ON FUNCTION public.superadmin_system_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.superadmin_system_health() TO authenticated;

COMMIT;

-- Recargar el cache de esquema de PostgREST para exponer la RPC.
NOTIFY pgrst, 'reload schema';

SELECT 'migracion 135 aplicada (superadmin_system_health)' AS status;
