-- ============================================================
-- 068 — Superadmin dev tools: reset operativo + ambiente simulado
-- Funciones RPC SECURITY DEFINER que sólo superadmin puede ejecutar.
-- Permite testear todo el flujo (cliente→cocina→mozo→caja) y
-- limpiar la base sin pasar por el dashboard de Supabase.
-- ============================================================

-- ── Helper: verifica que el caller sea superadmin ────────────
CREATE OR REPLACE FUNCTION public._assert_superadmin()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND role = 'superadmin'
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'No autorizado: solo superadmin';
  END IF;
END;
$$;

-- ── superadmin_reset_operation_data ──────────────────────────
-- Limpia órdenes, items, historial, llamadas, ratings, caja y delivery.
-- Resetea mesas a libre y riders a disponible.
-- Mantiene intacto: restaurantes, menú, mesas, usuarios, riders, zonas, planes.
CREATE OR REPLACE FUNCTION public.superadmin_reset_operation_data()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rid UUID := '00000000-0000-0000-0000-000000000001';
BEGIN
  PERFORM public._assert_superadmin();

  -- delivery_orders tiene FK a orders → debe ir primero
  DELETE FROM public.delivery_orders;
  DELETE FROM public.order_item_extras;
  DELETE FROM public.order_items;
  DELETE FROM public.order_status_history;
  DELETE FROM public.orders;
  DELETE FROM public.waiter_calls;
  DELETE FROM public.ratings;
  DELETE FROM public.cancelaciones_caja;
  DELETE FROM public.movimientos_caja;
  DELETE FROM public.turnos_caja;
  DELETE FROM public.quejas_sugerencias;

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

-- ── superadmin_seed_simulated_environment ────────────────────
-- Crea ~15 pedidos en distintos estados (cocina, listo, cobro pte,
-- entregado) usando mesas y menú reales de La Huaca.
-- Ocupa las mesas con pedidos en curso, deja waiter_calls pendientes,
-- ratings recientes y un turno de caja abierto.
CREATE OR REPLACE FUNCTION public.superadmin_seed_simulated_environment()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rid UUID := '00000000-0000-0000-0000-000000000001';
  v_now TIMESTAMPTZ := NOW();
  v_mesas UUID[];
  v_items_id  INT[];
  v_items_nm  TEXT[];
  v_items_pr  INT[];
  v_items_len INT;
  v_mesas_len INT;
  i INT;
  v_order_id   UUID;
  v_mesa_id    UUID;
  v_status     TEXT;
  v_paystatus  TEXT;
  v_paymethod  TEXT;
  v_min_ago    INT;
  v_subtotal   INT;
  v_qty        INT;
  v_n_items    INT;
  v_idx        INT;
  v_waiter     BOOLEAN;
  v_rating     INT;
  v_ocupar     BOOLEAN;
  v_completed  TIMESTAMPTZ;
  v_paidat     TIMESTAMPTZ;
  v_ocupados   UUID[];
  v_created    INT := 0;
  v_customer   TEXT;
  v_nombres    TEXT[] := ARRAY['Carlos','Andrea','Sofía','Diego','Luis','María','Rocío','Pablo','Lucía','Javier'];
BEGIN
  PERFORM public._assert_superadmin();

  -- 1. Cargar mesas activas
  SELECT array_agg(id ORDER BY number)
    INTO v_mesas
    FROM public.tables
   WHERE restaurant_id = v_rid AND is_active = true;

  v_mesas_len := COALESCE(array_length(v_mesas,1),0);
  IF v_mesas_len = 0 THEN
    RAISE EXCEPTION 'No hay mesas activas en La Huaca';
  END IF;

  -- 2. Cargar ítems de menú disponibles
  SELECT array_agg(id), array_agg(name), array_agg(price_guarani)
    INTO v_items_id, v_items_nm, v_items_pr
    FROM (
      SELECT id, name, price_guarani
        FROM public.menu_items
       WHERE restaurant_id = v_rid AND is_available = true
       ORDER BY id
       LIMIT 40
    ) sub;

  v_items_len := COALESCE(array_length(v_items_id,1),0);
  IF v_items_len = 0 THEN
    RAISE EXCEPTION 'No hay ítems de menú disponibles';
  END IF;

  -- 3. Generar 15 pedidos en escenarios variados
  FOR i IN 1..15 LOOP
    -- Asignar escenario por índice
    IF    i <= 1 THEN v_status:='paid';             v_paystatus:='paid';   v_min_ago:=1;   v_paymethod:='efectivo';  v_ocupar:=true; v_waiter:=false; v_rating:=NULL;
    ELSIF i <= 3 THEN v_status:='kitchen_received'; v_paystatus:='paid';   v_min_ago:=3+i; v_paymethod:='tarjeta';   v_ocupar:=true; v_waiter:=false; v_rating:=NULL;
    ELSIF i <= 6 THEN v_status:='cooking';          v_paystatus:='paid';   v_min_ago:=8+i; v_paymethod:='qr';        v_ocupar:=true; v_waiter:=false; v_rating:=NULL;
    ELSIF i <= 8 THEN v_status:='ready';            v_paystatus:='paid';   v_min_ago:=15+i;v_paymethod:='efectivo';  v_ocupar:=true; v_waiter:=false; v_rating:=NULL;
    ELSIF i <= 10 THEN v_status:='pending_payment';v_paystatus:='unpaid'; v_min_ago:=25+i;v_paymethod:=NULL;        v_ocupar:=true; v_waiter:=true;  v_rating:=NULL;
    ELSE              v_status:='delivered';        v_paystatus:='paid';   v_min_ago:=40+i*15; v_paymethod:=(ARRAY['efectivo','tarjeta','qr'])[1+(i%3)]; v_ocupar:=false; v_waiter:=false; v_rating:=3+(i%3);
    END IF;

    v_mesa_id := v_mesas[1 + ((i-1) % v_mesas_len)];
    v_completed := CASE WHEN v_status='delivered' THEN v_now - make_interval(mins => GREATEST(1,v_min_ago-5)) ELSE NULL END;
    v_paidat    := CASE WHEN v_paystatus='paid' THEN v_now - make_interval(mins => GREATEST(1,v_min_ago-2)) ELSE NULL END;
    v_customer  := v_nombres[1 + (i % array_length(v_nombres,1))];

    -- Cantidad de items en el pedido (1-3)
    v_n_items := 1 + ((i*7) % 3);
    v_subtotal := 0;

    INSERT INTO public.orders (
      restaurant_id, table_id, order_number, order_type, status, payment_status,
      subtotal, total, payment_method, customer_name, created_at, completed_at, paid_at
    ) VALUES (
      v_rid, v_mesa_id,
      'SIM-' || to_char(v_now,'HH24MISS') || '-' || lpad(i::text,2,'0'),
      'local', v_status, v_paystatus,
      0, 0, v_paymethod, v_customer,
      v_now - make_interval(mins => v_min_ago),
      v_completed, v_paidat
    )
    RETURNING id INTO v_order_id;

    -- Insertar items
    FOR j IN 1..v_n_items LOOP
      v_idx := 1 + ((i*j*13) % v_items_len);
      v_qty := 1 + ((i+j) % 2);
      v_subtotal := v_subtotal + (v_items_pr[v_idx] * v_qty);
      INSERT INTO public.order_items (order_id, item_id, item_name, quantity, unit_price, total_price)
      VALUES (v_order_id, v_items_id[v_idx], v_items_nm[v_idx], v_qty, v_items_pr[v_idx], v_items_pr[v_idx]*v_qty);
    END LOOP;

    -- Actualizar totales del pedido
    UPDATE public.orders SET subtotal = v_subtotal, total = v_subtotal WHERE id = v_order_id;

    -- Historial mínimo
    INSERT INTO public.order_status_history (order_id, status, changed_at, changed_by)
    VALUES (v_order_id, v_status, v_now - make_interval(mins => v_min_ago), 'system');

    -- waiter_call para los pendientes de cobro
    IF v_waiter THEN
      INSERT INTO public.waiter_calls (restaurant_id, table_id, order_id, status)
      VALUES (v_rid, v_mesa_id, v_order_id, 'pending');
    END IF;

    -- rating para entregados
    IF v_rating IS NOT NULL THEN
      INSERT INTO public.ratings (order_id, restaurant_id, table_id, stars, comment)
      VALUES (v_order_id, v_rid, v_mesa_id, v_rating,
              CASE WHEN v_rating >= 4 THEN 'Excelente, volveremos.' ELSE 'Demoraron un poco.' END);
    END IF;

    -- Acumular mesa ocupada
    IF v_ocupar THEN
      v_ocupados := array_append(v_ocupados, v_mesa_id);
    END IF;

    v_created := v_created + 1;
  END LOOP;

  -- 4. Ocupar mesas
  IF v_ocupados IS NOT NULL THEN
    UPDATE public.tables
       SET is_occupied = true,
           occupied_since = v_now
     WHERE id = ANY(v_ocupados);
  END IF;

  RETURN json_build_object(
    'ok', true,
    'orders_created', v_created,
    'mesas_ocupadas', COALESCE(array_length(v_ocupados,1),0)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.superadmin_seed_simulated_environment TO authenticated;
