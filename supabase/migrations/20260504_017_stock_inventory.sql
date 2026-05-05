-- ============================================================
-- Migración 017: Módulo de Stock e Inventario
-- ============================================================
-- Crea: ingredients, recipes, stock_movements, stock_alerts,
--       availability_log. Agrega availability_reason a menu_items.
-- Triggers: descuento automático al confirmar pedido.
-- Funciones: check_menu_item_availability, admin_load_stock,
--            get_projected_stock, check_expiring_ingredients.
-- ============================================================

-- ── Enums ─────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE stock_unit AS ENUM ('g','kg','l','ml','unit','portion');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE stock_movement_type AS ENUM ('load','deduct','adjustment','waste','expired');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE stock_alert_type AS ENUM ('low_stock','critical_stock','expiring_soon','expired');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Tabla: ingredients ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ingredients (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   UUID        NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL,
  category        TEXT,
  stock_quantity  DECIMAL(12,3) NOT NULL DEFAULT 0,
  unit            stock_unit  NOT NULL DEFAULT 'unit',
  min_threshold   DECIMAL(12,3) NOT NULL DEFAULT 0,
  expiry_date     DATE,
  batch_id        TEXT,
  cost_per_unit   DECIMAL(10,2),
  supplier_id     UUID,
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Tabla: recipes ─────────────────────────────────────────────
-- menu_items usa SERIAL (INT), no UUID
CREATE TABLE IF NOT EXISTS public.recipes (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id      INT         NOT NULL REFERENCES public.menu_items(id) ON DELETE CASCADE,
  ingredient_id     UUID        NOT NULL REFERENCES public.ingredients(id) ON DELETE CASCADE,
  quantity_required DECIMAL(12,3) NOT NULL,
  unit              stock_unit  NOT NULL DEFAULT 'unit',
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(menu_item_id, ingredient_id)
);

-- ── Tabla: stock_movements (inmutable) ────────────────────────
CREATE TABLE IF NOT EXISTS public.stock_movements (
  id               UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    UUID              NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  ingredient_id    UUID              NOT NULL REFERENCES public.ingredients(id) ON DELETE CASCADE,
  movement_type    stock_movement_type NOT NULL,
  quantity         DECIMAL(12,3)     NOT NULL,
  unit             stock_unit        NOT NULL,
  related_order_id UUID,
  notes            TEXT,
  performed_by     UUID,
  created_at       TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

-- ── Tabla: stock_alerts ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stock_alerts (
  id                  UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id       UUID             NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  alert_type          stock_alert_type NOT NULL,
  ingredient_id       UUID             NOT NULL REFERENCES public.ingredients(id) ON DELETE CASCADE,
  threshold_triggered DECIMAL(12,3),
  current_value       DECIMAL(12,3),
  notified_kitchen    BOOLEAN          NOT NULL DEFAULT false,
  notified_admin      BOOLEAN          NOT NULL DEFAULT false,
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

-- ── Tabla: availability_log ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.availability_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id  INT         NOT NULL REFERENCES public.menu_items(id) ON DELETE CASCADE,
  restaurant_id UUID        NOT NULL,
  is_available  BOOLEAN     NOT NULL,
  reason        TEXT,
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Columna adicional en menu_items ───────────────────────────
ALTER TABLE public.menu_items ADD COLUMN IF NOT EXISTS availability_reason TEXT;

-- ── Índices ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_ingredients_restaurant    ON public.ingredients(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_ingredients_active        ON public.ingredients(is_active);
CREATE INDEX IF NOT EXISTS idx_recipes_menu_item         ON public.recipes(menu_item_id);
CREATE INDEX IF NOT EXISTS idx_recipes_ingredient        ON public.recipes(ingredient_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_ingredient ON public.stock_movements(ingredient_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_restaurant ON public.stock_movements(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_restaurant   ON public.stock_alerts(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_ingredient   ON public.stock_alerts(ingredient_id);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_unresolved   ON public.stock_alerts(ingredient_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_availability_log_item     ON public.availability_log(menu_item_id);

-- ── Realtime ───────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE public.ingredients;
ALTER PUBLICATION supabase_realtime ADD TABLE public.stock_alerts;

-- ── RLS ────────────────────────────────────────────────────────
ALTER TABLE public.ingredients      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_movements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_alerts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.availability_log ENABLE ROW LEVEL SECURITY;

-- Lectura pública (menú del cliente necesita saber recetas para verificar disponibilidad)
CREATE POLICY "public_read_recipes"       ON public.recipes          FOR SELECT USING (true);
CREATE POLICY "public_read_ingredients"   ON public.ingredients      FOR SELECT USING (is_active = true);
CREATE POLICY "public_read_stock_alerts"  ON public.stock_alerts     FOR SELECT USING (true);
CREATE POLICY "public_read_avail_log"     ON public.availability_log FOR SELECT USING (true);

-- Acceso completo para autenticados (cocina / admin / superadmin)
CREATE POLICY "auth_all_ingredients"     ON public.ingredients      FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_recipes"         ON public.recipes          FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_stock_movements" ON public.stock_movements  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_stock_alerts"    ON public.stock_alerts     FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_avail_log"       ON public.availability_log FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── Función auxiliar: convertir a unidad base ──────────────────
-- Almacenamiento interno: gramos para sólidos, ml para líquidos.
-- kg → g (*1000), L → ml (*1000), resto sin conversión.
CREATE OR REPLACE FUNCTION public.to_base_unit(qty DECIMAL, from_unit stock_unit)
RETURNS DECIMAL
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  CASE from_unit
    WHEN 'kg' THEN RETURN qty * 1000;
    WHEN 'l'  THEN RETURN qty * 1000;
    ELSE            RETURN qty;
  END CASE;
END;
$$;

-- ── Función: verificar disponibilidad de un ítem del menú ─────
CREATE OR REPLACE FUNCTION public.check_menu_item_availability(p_menu_item_id INT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT rec.quantity_required, rec.unit AS rec_unit,
           ing.name, ing.stock_quantity
    FROM public.recipes rec
    JOIN public.ingredients ing ON ing.id = rec.ingredient_id
    WHERE rec.menu_item_id = p_menu_item_id
      AND ing.is_active = true
  LOOP
    IF public.to_base_unit(r.quantity_required, r.rec_unit) > r.stock_quantity THEN
      RETURN json_build_object('available', false, 'reason', 'Sin stock: ' || r.name);
    END IF;
  END LOOP;
  RETURN json_build_object('available', true, 'reason', NULL);
END;
$$;
GRANT EXECUTE ON FUNCTION public.check_menu_item_availability TO anon, authenticated;

-- ── Función: crear/resolver alerta de stock ───────────────────
CREATE OR REPLACE FUNCTION public.check_stock_alert(p_ingredient_id UUID, p_restaurant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ing RECORD;
  v_alert_type stock_alert_type;
BEGIN
  SELECT stock_quantity, min_threshold INTO v_ing
  FROM public.ingredients WHERE id = p_ingredient_id;

  IF v_ing.stock_quantity = 0 OR (v_ing.min_threshold > 0 AND v_ing.stock_quantity < v_ing.min_threshold * 0.5) THEN
    v_alert_type := 'critical_stock';
  ELSIF v_ing.min_threshold > 0 AND v_ing.stock_quantity < v_ing.min_threshold * 1.5 THEN
    v_alert_type := 'low_stock';
  ELSE
    -- Resolver alertas existentes
    UPDATE public.stock_alerts SET resolved_at = NOW()
    WHERE ingredient_id = p_ingredient_id AND resolved_at IS NULL;
    RETURN;
  END IF;

  -- Insertar alerta solo si no existe una reciente del mismo tipo
  INSERT INTO public.stock_alerts (restaurant_id, alert_type, ingredient_id, threshold_triggered, current_value)
  SELECT p_restaurant_id, v_alert_type, p_ingredient_id, v_ing.min_threshold, v_ing.stock_quantity
  WHERE NOT EXISTS (
    SELECT 1 FROM public.stock_alerts
    WHERE ingredient_id = p_ingredient_id
      AND alert_type = v_alert_type
      AND resolved_at IS NULL
      AND created_at > NOW() - INTERVAL '1 hour'
  );
END;
$$;

-- ── Función: refrescar disponibilidad de ítems que usan un ingrediente ──
CREATE OR REPLACE FUNCTION public.refresh_availability_for_ingredient(p_ingredient_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_result    JSON;
  v_available BOOLEAN;
  v_reason    TEXT;
BEGIN
  FOR r IN
    SELECT DISTINCT rec.menu_item_id, mi.restaurant_id, mi.is_available AS current_avail
    FROM public.recipes rec
    JOIN public.menu_items mi ON mi.id = rec.menu_item_id
    WHERE rec.ingredient_id = p_ingredient_id
  LOOP
    v_result    := public.check_menu_item_availability(r.menu_item_id);
    v_available := (v_result->>'available')::BOOLEAN;
    v_reason    := v_result->>'reason';

    IF v_available <> r.current_avail THEN
      UPDATE public.menu_items
      SET is_available       = v_available,
          availability_reason = CASE WHEN v_available THEN NULL ELSE v_reason END,
          updated_at         = NOW()
      WHERE id = r.menu_item_id;

      INSERT INTO public.availability_log (menu_item_id, restaurant_id, is_available, reason)
      VALUES (r.menu_item_id, r.restaurant_id, v_available, v_reason);
    END IF;
  END LOOP;
END;
$$;

-- ── Función: descontar stock al confirmarse el pedido ─────────
-- Ejecuta en una sola transacción para atomicidad.
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
BEGIN
  SELECT restaurant_id INTO v_restaurant_id FROM public.orders WHERE id = p_order_id;

  FOR r IN
    SELECT oi.item_id, oi.quantity AS order_qty,
           rec.ingredient_id, rec.quantity_required, rec.unit AS rec_unit
    FROM public.order_items oi
    JOIN public.recipes rec ON rec.menu_item_id = oi.item_id
    WHERE oi.order_id = p_order_id
      AND oi.item_id IS NOT NULL
  LOOP
    -- Cantidad en unidad base (g o ml)
    v_qty_to_deduct := public.to_base_unit(r.quantity_required, r.rec_unit) * r.order_qty;

    SELECT unit INTO v_ing_unit FROM public.ingredients WHERE id = r.ingredient_id;

    -- Descontar stock (mínimo 0)
    UPDATE public.ingredients
    SET stock_quantity = GREATEST(0, stock_quantity - v_qty_to_deduct),
        updated_at     = NOW()
    WHERE id = r.ingredient_id;

    -- Registrar movimiento
    INSERT INTO public.stock_movements (
      restaurant_id, ingredient_id, movement_type, quantity, unit, related_order_id
    ) VALUES (
      v_restaurant_id, r.ingredient_id, 'deduct', v_qty_to_deduct, v_ing_unit, p_order_id
    );

    -- Verificar alertas y disponibilidad de ítems del menú
    PERFORM public.check_stock_alert(r.ingredient_id, v_restaurant_id);
    PERFORM public.refresh_availability_for_ingredient(r.ingredient_id);
  END LOOP;
END;
$$;

-- ── Trigger: disparar descuento cuando el pedido pasa a 'paid' ─
CREATE OR REPLACE FUNCTION public.trigger_deduct_stock_on_paid()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Solo cuando el status llega a 'paid' por primera vez
  IF NEW.status = 'paid' AND (TG_OP = 'INSERT' OR OLD.status <> 'paid') THEN
    PERFORM public.deduct_stock_for_order(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deduct_stock_on_paid ON public.orders;
CREATE TRIGGER trg_deduct_stock_on_paid
  AFTER INSERT OR UPDATE OF status ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_deduct_stock_on_paid();

-- ── RPC: cargar stock (llamable desde el panel admin) ─────────
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
  v_base_qty      DECIMAL;
  v_restaurant_id UUID;
  v_ing_unit      stock_unit;
BEGIN
  v_base_qty := public.to_base_unit(p_quantity, p_unit);

  SELECT restaurant_id, unit INTO v_restaurant_id, v_ing_unit
  FROM public.ingredients WHERE id = p_ingredient_id;

  -- Sumar al stock
  UPDATE public.ingredients
  SET stock_quantity = stock_quantity + v_base_qty,
      expiry_date    = COALESCE(p_expiry_date, expiry_date),
      batch_id       = COALESCE(p_batch_id, batch_id),
      cost_per_unit  = COALESCE(p_cost_per_unit, cost_per_unit),
      updated_at     = NOW()
  WHERE id = p_ingredient_id;

  -- Registrar movimiento
  INSERT INTO public.stock_movements (
    restaurant_id, ingredient_id, movement_type, quantity, unit, notes
  ) VALUES (
    v_restaurant_id, p_ingredient_id, 'load', v_base_qty, v_ing_unit, p_notes
  );

  -- Resolver alertas activas
  UPDATE public.stock_alerts SET resolved_at = NOW()
  WHERE ingredient_id = p_ingredient_id AND resolved_at IS NULL;

  -- Reactivar ítems del menú que recuperaron stock suficiente
  PERFORM public.refresh_availability_for_ingredient(p_ingredient_id);

  RETURN json_build_object('success', true, 'loaded_qty_base', v_base_qty);
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_load_stock TO authenticated;

-- ── RPC: stock proyectado (pedidos activos pendientes) ────────
CREATE OR REPLACE FUNCTION public.get_projected_stock(p_ingredient_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current   DECIMAL;
  v_to_consume DECIMAL := 0;
BEGIN
  SELECT stock_quantity INTO v_current FROM public.ingredients WHERE id = p_ingredient_id;

  SELECT COALESCE(SUM(public.to_base_unit(rec.quantity_required, rec.unit) * oi.quantity), 0)
  INTO v_to_consume
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
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
GRANT EXECUTE ON FUNCTION public.get_projected_stock TO authenticated;

-- ── RPC: verificar vencimientos (llamar diariamente) ──────────
CREATE OR REPLACE FUNCTION public.check_expiring_ingredients()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r      RECORD;
  v_type stock_alert_type;
  v_count INT := 0;
BEGIN
  FOR r IN
    SELECT id, restaurant_id, expiry_date, stock_quantity, unit
    FROM public.ingredients
    WHERE is_active = true AND expiry_date IS NOT NULL
  LOOP
    IF r.expiry_date < CURRENT_DATE THEN
      v_type := 'expired';
      -- Registrar movimiento de vencimiento si no existe uno hoy
      IF NOT EXISTS (
        SELECT 1 FROM public.stock_movements
        WHERE ingredient_id = r.id AND movement_type = 'expired'
          AND created_at::date = CURRENT_DATE
      ) THEN
        INSERT INTO public.stock_movements (
          restaurant_id, ingredient_id, movement_type, quantity, unit, notes
        ) VALUES (
          r.restaurant_id, r.id, 'expired', r.stock_quantity, r.unit,
          'Vencimiento detectado automáticamente'
        );
      END IF;
    ELSIF r.expiry_date <= CURRENT_DATE + 7 THEN
      v_type := 'expiring_soon';
    ELSE
      CONTINUE;
    END IF;

    -- Crear alerta si no existe una reciente
    INSERT INTO public.stock_alerts (restaurant_id, alert_type, ingredient_id, current_value)
    SELECT r.restaurant_id, v_type, r.id, r.stock_quantity
    WHERE NOT EXISTS (
      SELECT 1 FROM public.stock_alerts
      WHERE ingredient_id = r.id AND alert_type = v_type
        AND resolved_at IS NULL
        AND created_at > NOW() - INTERVAL '24 hours'
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.check_expiring_ingredients TO authenticated;

-- ── RPC: ajuste manual de disponibilidad de ítem ─────────────
CREATE OR REPLACE FUNCTION public.admin_set_item_availability(
  p_menu_item_id INT,
  p_available    BOOLEAN,
  p_reason       TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_restaurant_id UUID;
BEGIN
  SELECT restaurant_id INTO v_restaurant_id FROM public.menu_items WHERE id = p_menu_item_id;

  UPDATE public.menu_items
  SET is_available        = p_available,
      availability_reason = CASE WHEN p_available THEN NULL ELSE COALESCE(p_reason, 'No disponible') END,
      updated_at          = NOW()
  WHERE id = p_menu_item_id;

  INSERT INTO public.availability_log (menu_item_id, restaurant_id, is_available, reason)
  VALUES (p_menu_item_id, v_restaurant_id, p_available, p_reason);
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_set_item_availability TO authenticated;

-- ── RPC: listar ingredientes con proyección (para UI admin) ───
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
    -- Stock proyectado: actual menos lo que consumirán los pedidos activos
    ing.stock_quantity - COALESCE((
      SELECT SUM(public.to_base_unit(rec.quantity_required, rec.unit) * oi.quantity)
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      JOIN public.recipes rec ON rec.menu_item_id = oi.item_id
      WHERE rec.ingredient_id = ing.id
        AND o.status IN ('paid','kitchen_received','cooking')
    ), 0) AS projected_qty,
    -- Alertas activas
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
GRANT EXECUTE ON FUNCTION public.admin_list_ingredients TO authenticated;
