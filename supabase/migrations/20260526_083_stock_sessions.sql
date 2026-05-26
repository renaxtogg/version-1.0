-- ============================================================
-- Migración 083: Tomas de inventario (control de turno) +
--               fix deduct_stock_for_order respeta auto_stock_discount
-- ============================================================

-- ── Tabla: stock_sessions ─────────────────────────────────────
-- Una sesión de toma de inventario (apertura o cierre de turno)
CREATE TABLE IF NOT EXISTS public.stock_sessions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   UUID        NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  session_type    TEXT        NOT NULL CHECK (session_type IN ('apertura','cierre')),
  status          TEXT        NOT NULL DEFAULT 'en_curso' CHECK (status IN ('en_curso','completado')),
  notes           TEXT,
  created_by      UUID        REFERENCES auth.users(id),
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Tabla: stock_session_items ────────────────────────────────
-- Conteo físico de cada ingrediente en la toma
CREATE TABLE IF NOT EXISTS public.stock_session_items (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID          NOT NULL REFERENCES public.stock_sessions(id) ON DELETE CASCADE,
  ingredient_id     UUID          NOT NULL REFERENCES public.ingredients(id) ON DELETE CASCADE,
  system_quantity   DECIMAL(12,3) NOT NULL,   -- stock del sistema al momento de la toma
  counted_quantity  DECIMAL(12,3),            -- lo que contó físicamente (NULL = no contado)
  apply_adjustment  BOOLEAN       NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, ingredient_id)
);

-- ── Índices ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_stock_sessions_restaurant ON public.stock_sessions(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_stock_sessions_date       ON public.stock_sessions(restaurant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_session_items       ON public.stock_session_items(session_id);

-- ── RLS ────────────────────────────────────────────────────────
ALTER TABLE public.stock_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_session_items ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "auth_all_stock_sessions"
    ON public.stock_sessions FOR ALL TO authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "auth_all_stock_session_items"
    ON public.stock_session_items FOR ALL TO authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── RPC: crear toma de inventario ────────────────────────────
-- Crea la sesión y registra el stock actual de todos los ingredientes activos.
CREATE OR REPLACE FUNCTION public.admin_create_stock_session(
  p_restaurant_id UUID,
  p_session_type  TEXT,
  p_notes         TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session_id UUID;
BEGIN
  INSERT INTO public.stock_sessions (restaurant_id, session_type, notes, created_by)
  VALUES (p_restaurant_id, p_session_type, p_notes, auth.uid())
  RETURNING id INTO v_session_id;

  -- Snapshot del stock actual para todos los ingredientes activos
  INSERT INTO public.stock_session_items (session_id, ingredient_id, system_quantity)
  SELECT v_session_id, id, stock_quantity
  FROM public.ingredients
  WHERE restaurant_id = p_restaurant_id
    AND is_active = true;

  RETURN v_session_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_create_stock_session TO authenticated;

-- ── RPC: completar toma de inventario ────────────────────────
-- Guarda los conteos físicos, aplica ajustes opcionales y cierra la sesión.
-- p_counts: [{ingredient_id, counted_quantity, apply_adjustment}]
CREATE OR REPLACE FUNCTION public.admin_complete_stock_session(
  p_session_id UUID,
  p_counts     JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_restaurant_id UUID;
  v_item          JSONB;
  v_ing_id        UUID;
  v_counted       DECIMAL;
  v_apply         BOOLEAN;
  v_system_qty    DECIMAL;
  v_diff          DECIMAL;
  v_adjusted      INT := 0;
  v_discrepancies INT := 0;
  v_ing_unit      stock_unit;
BEGIN
  SELECT restaurant_id INTO v_restaurant_id
  FROM public.stock_sessions WHERE id = p_session_id;

  IF v_restaurant_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sesión no encontrada');
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_counts)
  LOOP
    v_ing_id  := (v_item->>'ingredient_id')::UUID;
    v_counted := (v_item->>'counted_quantity')::DECIMAL;
    v_apply   := COALESCE((v_item->>'apply_adjustment')::BOOLEAN, false);

    IF v_counted IS NULL THEN CONTINUE; END IF;

    SELECT system_quantity INTO v_system_qty
    FROM public.stock_session_items
    WHERE session_id = p_session_id AND ingredient_id = v_ing_id;

    v_diff := v_counted - COALESCE(v_system_qty, 0);
    IF ABS(v_diff) > 0.001 THEN v_discrepancies := v_discrepancies + 1; END IF;

    UPDATE public.stock_session_items
    SET counted_quantity = v_counted,
        apply_adjustment  = v_apply
    WHERE session_id = p_session_id AND ingredient_id = v_ing_id;

    IF v_apply AND ABS(v_diff) > 0.001 THEN
      SELECT unit INTO v_ing_unit FROM public.ingredients WHERE id = v_ing_id;

      -- Ajustar stock al valor físico contado
      UPDATE public.ingredients
      SET stock_quantity = GREATEST(0, v_counted),
          updated_at     = NOW()
      WHERE id = v_ing_id;

      -- Registrar movimiento de ajuste
      INSERT INTO public.stock_movements (
        restaurant_id, ingredient_id, movement_type, quantity, unit, notes
      ) VALUES (
        v_restaurant_id, v_ing_id, 'adjustment', ABS(v_diff), v_ing_unit,
        'Ajuste por toma de inventario (' || p_session_id::TEXT || ')'
      );

      PERFORM public.check_stock_alert(v_ing_id, v_restaurant_id);
      PERFORM public.refresh_availability_for_ingredient(v_ing_id);

      v_adjusted := v_adjusted + 1;
    END IF;
  END LOOP;

  UPDATE public.stock_sessions
  SET status = 'completado', completed_at = NOW()
  WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'success',           true,
    'adjusted_count',    v_adjusted,
    'discrepancy_count', v_discrepancies
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_complete_stock_session TO authenticated;

-- ── Fix: deduct_stock_for_order respeta auto_stock_discount ──
-- La versión anterior siempre descontaba sin verificar el toggle.
CREATE OR REPLACE FUNCTION public.deduct_stock_for_order(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r               RECORD;
  v_qty_to_deduct DECIMAL;
  v_restaurant_id UUID;
  v_ing_unit      stock_unit;
  v_auto_discount BOOLEAN;
BEGIN
  SELECT restaurant_id INTO v_restaurant_id FROM public.orders WHERE id = p_order_id;

  -- Respetar la configuración de descuento automático
  SELECT COALESCE(auto_stock_discount, false) INTO v_auto_discount
  FROM public.restaurant_settings WHERE restaurant_id = v_restaurant_id;

  IF NOT COALESCE(v_auto_discount, false) THEN RETURN; END IF;

  FOR r IN
    SELECT oi.item_id, oi.quantity AS order_qty,
           rec.ingredient_id, rec.quantity_required, rec.unit AS rec_unit
    FROM public.order_items oi
    JOIN public.recipes rec ON rec.menu_item_id = oi.item_id
    WHERE oi.order_id = p_order_id
      AND oi.item_id IS NOT NULL
  LOOP
    v_qty_to_deduct := public.to_base_unit(r.quantity_required, r.rec_unit) * r.order_qty;

    SELECT unit INTO v_ing_unit FROM public.ingredients WHERE id = r.ingredient_id;

    -- Solo descontar si hay stock cargado (no tiene sentido descontar de 0)
    UPDATE public.ingredients
    SET stock_quantity = GREATEST(0, stock_quantity - v_qty_to_deduct),
        updated_at     = NOW()
    WHERE id = r.ingredient_id
      AND stock_quantity > 0;

    -- Solo registrar movimiento si efectivamente hubo cambio
    IF FOUND THEN
      INSERT INTO public.stock_movements (
        restaurant_id, ingredient_id, movement_type, quantity, unit, related_order_id
      ) VALUES (
        v_restaurant_id, r.ingredient_id, 'deduct', v_qty_to_deduct, v_ing_unit, p_order_id
      );

      PERFORM public.check_stock_alert(r.ingredient_id, v_restaurant_id);
      PERFORM public.refresh_availability_for_ingredient(r.ingredient_id);
    END IF;
  END LOOP;
END;
$$;
