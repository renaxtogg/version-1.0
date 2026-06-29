-- ════════════════════════════════════════════════════════════════════
-- 136 · Afinar la alerta "pedidos trabados" de superadmin_system_health()
-- ────────────────────────────────────────────────────────────────────
-- La mig 135 contaba stuck_orders con:
--   status IN ('paid','kitchen_received','cooking','ready') AND created_at < now()-2h
-- → falso positivo (26): incluía basura SIM histórica y estados que quedan
--   abiertos de forma legítima (paid sin avanzar, ready esperando retiro).
--
-- Fix: "trabado" = SOLO un pedido EN COCINA (kitchen_received / cooking) que
-- lleva +2h sin avanzar, y dentro de las últimas 24h (descarta lo histórico).
-- Estados reales (CHECK de mig 001): draft, confirmed, paid, kitchen_received,
-- cooking, ready, delivered, cancelled.
--
-- CREATE OR REPLACE IDÉNTICO a la 135 (mismo guard fail-closed, mismo
-- search_path, mismos REVOKE/GRANT) — sólo cambia el cálculo de stuck_orders.
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
    -- "Trabados": SÓLO pedidos EN COCINA (kitchen_received/cooking) atascados +2h,
    -- y de las últimas 24h (paid/ready se abren legítimamente; lo histórico no cuenta).
    'stuck_orders',     (SELECT count(*) FROM public.orders
                          WHERE status IN ('kitchen_received','cooking')
                            AND created_at <  now() - interval '2 hours'
                            AND created_at >= now() - interval '24 hours'),
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

SELECT 'migracion 136 aplicada (fix stuck_orders en superadmin_system_health)' AS status;
