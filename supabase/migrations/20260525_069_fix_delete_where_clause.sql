-- ============================================================
-- 069 — Fix: DELETE requires a WHERE clause en Supabase
-- Las funciones de reset/seed fallan porque Supabase rechaza
-- DELETE sin WHERE dentro de funciones SECURITY DEFINER.
-- Solución: agregar WHERE 1=1 a todos los DELETE.
-- ============================================================

CREATE OR REPLACE FUNCTION public.superadmin_reset_operation_data()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rid UUID := '00000000-0000-0000-0000-000000000001';
BEGIN
  PERFORM public._assert_superadmin();

  DELETE FROM public.delivery_orders      WHERE 1=1;
  DELETE FROM public.order_item_extras    WHERE 1=1;
  DELETE FROM public.order_items          WHERE 1=1;
  DELETE FROM public.order_status_history WHERE 1=1;
  DELETE FROM public.orders               WHERE 1=1;
  DELETE FROM public.waiter_calls         WHERE 1=1;
  DELETE FROM public.ratings              WHERE 1=1;
  DELETE FROM public.cancelaciones_caja   WHERE 1=1;
  DELETE FROM public.movimientos_caja     WHERE 1=1;
  DELETE FROM public.turnos_caja          WHERE 1=1;
  DELETE FROM public.quejas_sugerencias   WHERE 1=1;

  UPDATE public.delivery_riders
     SET current_status = 'disponible'
   WHERE restaurant_id = v_rid;

  UPDATE public.tables
     SET is_occupied = false,
         occupied_since = NULL
   WHERE restaurant_id = v_rid;

  RETURN json_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.superadmin_reset_operation_data TO authenticated;
