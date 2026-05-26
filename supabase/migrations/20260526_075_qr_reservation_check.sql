-- ═══════════════════════════════════════════════════════════
-- MIGRACIÓN 075 — QR: verificar reserva activa al escanear
-- Función SECURITY DEFINER para que clientes anónimos puedan
-- consultar si su mesa tiene una reserva próxima.
-- Solo expone primer nombre y hora; nunca apellido ni teléfono.
-- EJECUTAR EN SUPABASE SQL EDITOR (dashboard en inglés)
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_table_upcoming_reservation(
  p_table_id      UUID,
  p_window_before INT DEFAULT 30,   -- minutos antes de la reserva
  p_window_after  INT DEFAULT 90    -- minutos después (tolerancia llegada tarde)
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_row        RECORD;
  v_now_local  TIMESTAMPTZ := NOW() AT TIME ZONE 'America/Asuncion';
  v_today      DATE        := (v_now_local)::DATE;
  v_time_now   TIME        := (v_now_local)::TIME;
  v_first_name TEXT;
BEGIN
  SELECT id, customer_name, reservation_time, guests
  INTO v_row
  FROM public.reservations
  WHERE table_id       = p_table_id
    AND restaurant_id  = (SELECT restaurant_id FROM public.tables WHERE id = p_table_id)
    AND reservation_date = v_today
    AND status IN ('confirmed', 'pending')
    AND reservation_time >= (v_time_now - (p_window_after  || ' minutes')::INTERVAL)
    AND reservation_time <= (v_time_now + (p_window_before || ' minutes')::INTERVAL)
  ORDER BY reservation_time
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Solo primer nombre (sin apellido)
  v_first_name := TRIM(SPLIT_PART(v_row.customer_name, ' ', 1));

  RETURN jsonb_build_object(
    'reservation_id', v_row.id,
    'first_name',     v_first_name,
    'time',           v_row.reservation_time,
    'guests',         v_row.guests
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_table_upcoming_reservation(UUID, INT, INT) TO anon, authenticated;
