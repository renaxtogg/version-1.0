-- ============================================================
-- Migración 181: Fix de conversión de unidades en Stock
-- ============================================================
-- BUG (reportado 2026-07-19): pedir 1 empanada cuya receta usa 100 g de carne
-- vaciaba 10 kg de stock de carne. Causa raíz: el modelo "unidad base" era
-- INCOHERENTE. El stock se guardaba nominalmente en base (g/ml), pero los puntos
-- de ENTRADA manual (crear ingrediente, toma de inventario) guardaban el número
-- crudo en la unidad elegida SIN convertir. Así "carne = 10 kg" quedaba como
-- stock_quantity = 10, y el descuento hacía 10 - to_base_unit(100,'g')=100 → 0.
--
-- FIX: modelo intuitivo y coherente → el stock se guarda EN LA UNIDAD DEL PROPIO
-- INGREDIENTE (10 kg = 10). Las recetas y cargas se convierten A ESA unidad al
-- descontar / cargar / proyectar. Con esto:
--   • crear ingrediente y toma de inventario quedan CORRECTOS sin conversión
--     (el número ya está en la unidad del ingrediente),
--   • el descuento, la carga, la proyección, las alertas (stock vs umbral) y la
--     disponibilidad quedan todos en la misma unidad → comparaciones válidas.
--
-- Unidades y dimensiones: masa {g,kg}, volumen {ml,l}, conteo {unit}, {portion}.
-- Conversión entre dimensiones distintas = INCOMPATIBLE → convert_units devuelve
-- NULL y las funciones NO descuentan (evita vaciar stock por receta mal armada).
--
-- NOTA DE DATOS: ingredientes existentes en g/ml/unit/portion no cambian de
-- significado. Los que estén en kg/l y hayan sido CARGADOS con el modelo viejo
-- (que guardaba base = gramos) pueden mostrar un número inflado: corregirlos con
-- una Toma de inventario (conteo físico) o recargando. No se mutan datos aquí.
-- ============================================================

-- ── Función: convertir entre unidades compatibles ────────────
-- Devuelve qty expresada en to_unit. NULL si las unidades son de dimensiones
-- distintas (incompatibles) o si qty es NULL.
CREATE OR REPLACE FUNCTION public.convert_units(qty DECIMAL, from_unit stock_unit, to_unit stock_unit)
RETURNS DECIMAL
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  IF qty IS NULL THEN RETURN NULL; END IF;
  IF from_unit = to_unit THEN RETURN qty; END IF;
  -- masa
  IF from_unit = 'g'  AND to_unit = 'kg' THEN RETURN qty / 1000; END IF;
  IF from_unit = 'kg' AND to_unit = 'g'  THEN RETURN qty * 1000; END IF;
  -- volumen
  IF from_unit = 'ml' AND to_unit = 'l'  THEN RETURN qty / 1000; END IF;
  IF from_unit = 'l'  AND to_unit = 'ml' THEN RETURN qty * 1000; END IF;
  -- distinta dimensión (masa↔volumen, conteo↔masa, portion, etc.) → incompatible
  RETURN NULL;
END;
$$;
GRANT EXECUTE ON FUNCTION public.convert_units(DECIMAL, stock_unit, stock_unit) TO anon, authenticated;

-- ── Descontar stock al confirmarse el pedido (unidad del ingrediente) ──
CREATE OR REPLACE FUNCTION public.deduct_stock_for_order(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r               RECORD;
  v_conv          DECIMAL;
  v_qty_to_deduct DECIMAL;
  v_restaurant_id UUID;
  v_auto_discount BOOLEAN;
BEGIN
  SELECT restaurant_id INTO v_restaurant_id FROM public.orders WHERE id = p_order_id;

  SELECT COALESCE(auto_stock_discount, false) INTO v_auto_discount
  FROM public.restaurant_settings WHERE restaurant_id = v_restaurant_id;

  IF NOT COALESCE(v_auto_discount, false) THEN RETURN; END IF;

  FOR r IN
    SELECT oi.item_id, oi.quantity AS order_qty,
           rec.ingredient_id, rec.quantity_required, rec.unit AS rec_unit,
           ing.unit AS ing_unit
    FROM public.order_items oi
    JOIN public.recipes rec     ON rec.menu_item_id = oi.item_id
    JOIN public.ingredients ing ON ing.id = rec.ingredient_id
    WHERE oi.order_id = p_order_id
      AND oi.item_id IS NOT NULL
  LOOP
    -- Convertir la cantidad de la receta a la unidad del ingrediente.
    v_conv := public.convert_units(r.quantity_required, r.rec_unit, r.ing_unit);

    -- Unidad de receta incompatible con el ingrediente → NO descontar (dato mal
    -- configurado; nunca vaciar stock por esto).
    IF v_conv IS NULL THEN CONTINUE; END IF;

    v_qty_to_deduct := v_conv * r.order_qty;

    UPDATE public.ingredients
    SET stock_quantity = GREATEST(0, stock_quantity - v_qty_to_deduct),
        updated_at     = NOW()
    WHERE id = r.ingredient_id
      AND stock_quantity > 0;

    IF FOUND THEN
      INSERT INTO public.stock_movements (
        restaurant_id, ingredient_id, movement_type, quantity, unit, related_order_id
      ) VALUES (
        v_restaurant_id, r.ingredient_id, 'deduct', v_qty_to_deduct, r.ing_unit, p_order_id
      );

      PERFORM public.check_stock_alert(r.ingredient_id, v_restaurant_id);
      PERFORM public.refresh_availability_for_ingredient(r.ingredient_id);
    END IF;
  END LOOP;
END;
$$;

-- ── Verificar disponibilidad de un ítem (unidad del ingrediente) ──
CREATE OR REPLACE FUNCTION public.check_menu_item_availability(p_menu_item_id INT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r      RECORD;
  v_need DECIMAL;
BEGIN
  FOR r IN
    SELECT rec.quantity_required, rec.unit AS rec_unit,
           ing.name, ing.stock_quantity, ing.unit AS ing_unit
    FROM public.recipes rec
    JOIN public.ingredients ing ON ing.id = rec.ingredient_id
    WHERE rec.menu_item_id = p_menu_item_id
      AND ing.is_active = true
  LOOP
    v_need := public.convert_units(r.quantity_required, r.rec_unit, r.ing_unit);
    -- Solo bloquea si la unidad es compatible y no alcanza el stock.
    IF v_need IS NOT NULL AND v_need > r.stock_quantity THEN
      RETURN json_build_object('available', false, 'reason', 'Sin stock: ' || r.name);
    END IF;
  END LOOP;
  RETURN json_build_object('available', true, 'reason', NULL);
END;
$$;
GRANT EXECUTE ON FUNCTION public.check_menu_item_availability(INT) TO anon, authenticated;

-- ── Cargar stock (convierte la carga a la unidad del ingrediente) ──
CREATE OR REPLACE FUNCTION public.admin_load_stock(
  p_ingredient_id UUID,
  p_quantity      DECIMAL,
  p_unit          stock_unit,
  p_expiry_date   DATE    DEFAULT NULL,
  p_batch_id      TEXT    DEFAULT NULL,
  p_cost_per_unit DECIMAL DEFAULT NULL,
  p_notes         TEXT    DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_qty           DECIMAL;
  v_restaurant_id UUID;
  v_ing_unit      stock_unit;
BEGIN
  SELECT restaurant_id, unit INTO v_restaurant_id, v_ing_unit
  FROM public.ingredients WHERE id = p_ingredient_id;

  IF v_ing_unit IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Ingrediente no encontrado');
  END IF;

  v_qty := public.convert_units(p_quantity, p_unit, v_ing_unit);
  IF v_qty IS NULL THEN
    RETURN json_build_object('success', false,
      'error', 'La unidad de carga no es compatible con la del ingrediente');
  END IF;

  UPDATE public.ingredients
  SET stock_quantity = stock_quantity + v_qty,
      expiry_date    = COALESCE(p_expiry_date, expiry_date),
      batch_id       = COALESCE(p_batch_id, batch_id),
      cost_per_unit  = COALESCE(p_cost_per_unit, cost_per_unit),
      updated_at     = NOW()
  WHERE id = p_ingredient_id;

  INSERT INTO public.stock_movements (
    restaurant_id, ingredient_id, movement_type, quantity, unit, notes
  ) VALUES (
    v_restaurant_id, p_ingredient_id, 'load', v_qty, v_ing_unit, p_notes
  );

  UPDATE public.stock_alerts SET resolved_at = NOW()
  WHERE ingredient_id = p_ingredient_id AND resolved_at IS NULL;

  PERFORM public.refresh_availability_for_ingredient(p_ingredient_id);

  RETURN json_build_object('success', true, 'loaded_qty', v_qty, 'unit', v_ing_unit);
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_load_stock(UUID, DECIMAL, stock_unit, DATE, TEXT, DECIMAL, TEXT) TO authenticated;

-- ── Stock proyectado (consumo de pedidos activos, unidad del ingrediente) ──
CREATE OR REPLACE FUNCTION public.get_projected_stock(p_ingredient_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current    DECIMAL;
  v_ing_unit   stock_unit;
  v_to_consume DECIMAL := 0;
BEGIN
  SELECT stock_quantity, unit INTO v_current, v_ing_unit
  FROM public.ingredients WHERE id = p_ingredient_id;

  SELECT COALESCE(SUM(public.convert_units(rec.quantity_required, rec.unit, v_ing_unit) * oi.quantity), 0)
  INTO v_to_consume
  FROM public.order_items oi
  JOIN public.orders o    ON o.id = oi.order_id
  JOIN public.recipes rec ON rec.menu_item_id = oi.item_id
  WHERE rec.ingredient_id = p_ingredient_id
    AND o.status IN ('paid','kitchen_received','cooking');

  RETURN json_build_object(
    'current',    v_current,
    'to_consume', v_to_consume,
    'projected',  v_current - v_to_consume
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_projected_stock(UUID) TO authenticated;

-- ── Listar ingredientes con proyección (unidad del ingrediente) ──
CREATE OR REPLACE FUNCTION public.admin_list_ingredients(p_restaurant_id UUID)
RETURNS TABLE (
  id              UUID,
  name            TEXT,
  category        TEXT,
  stock_quantity  DECIMAL,
  unit            stock_unit,
  min_threshold   DECIMAL,
  expiry_date     DATE,
  cost_per_unit   DECIMAL,
  is_active       BOOLEAN,
  stock_level     TEXT,
  projected_qty   DECIMAL,
  alert_count     BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ing.id,
    ing.name,
    ing.category,
    ing.stock_quantity,
    ing.unit,
    ing.min_threshold,
    ing.expiry_date,
    ing.cost_per_unit,
    ing.is_active,
    CASE
      WHEN ing.stock_quantity = 0 THEN 'sin_stock'
      WHEN ing.min_threshold > 0 AND ing.stock_quantity < ing.min_threshold * 0.5 THEN 'critico'
      WHEN ing.min_threshold > 0 AND ing.stock_quantity < ing.min_threshold * 1.5 THEN 'bajo'
      ELSE 'ok'
    END AS stock_level,
    ing.stock_quantity - COALESCE((
      SELECT SUM(public.convert_units(rec.quantity_required, rec.unit, ing.unit) * oi.quantity)
      FROM public.order_items oi
      JOIN public.orders o    ON o.id = oi.order_id
      JOIN public.recipes rec ON rec.menu_item_id = oi.item_id
      WHERE rec.ingredient_id = ing.id
        AND o.status IN ('paid','kitchen_received','cooking')
    ), 0) AS projected_qty,
    (SELECT COUNT(*) FROM public.stock_alerts sa
     WHERE sa.ingredient_id = ing.id AND sa.resolved_at IS NULL) AS alert_count
  FROM public.ingredients ing
  WHERE ing.restaurant_id = p_restaurant_id
    AND ing.is_active = true
  ORDER BY
    CASE
      WHEN ing.stock_quantity = 0 THEN 0
      WHEN ing.min_threshold > 0 AND ing.stock_quantity < ing.min_threshold * 0.5 THEN 1
      WHEN ing.min_threshold > 0 AND ing.stock_quantity < ing.min_threshold * 1.5 THEN 2
      ELSE 3
    END,
    ing.name;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_list_ingredients(UUID) TO authenticated;
