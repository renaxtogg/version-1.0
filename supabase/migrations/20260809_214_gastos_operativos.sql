-- ============================================================
-- Migración 214: Gastos operativos en el precio
-- ============================================================
-- La 213 dejó el costeo de INSUMOS resuelto. Pero fijar precio mirando sólo los
-- insumos es la forma más común de fundirse vendiendo: un plato con 70% de
-- "margen" sobre insumos puede estar perdiendo plata una vez que pagás sueldos,
-- alquiler, luz y gas.
--
-- Esta migración agrega la segunda mitad de la cuenta: los gastos que NO son
-- insumos, expresados como PORCENTAJE DE LA VENTA, que es como se prorratean en
-- gastronomía (el alquiler no se puede repartir "por hamburguesa" de otra forma
-- honesta sin inventar un volumen de ventas).
--
-- LA FÓRMULA
--   Si los insumos cuestan C, los gastos operativos se llevan g% de cada venta y
--   querés que te quede m% limpio, el precio tiene que ser:
--
--        precio = C / (1 − g/100 − m/100)
--
--   Con g = 0 se reduce EXACTAMENTE a la fórmula de la 213, así que un local que
--   no cargue gastos ve el mismo número que hoy. Nada cambia sin que lo pidan.
--
-- POR QUÉ EL DESGLOSE SE GUARDA Y NO SÓLO EL TOTAL
--   `overhead_items` guarda las filas ("personal 30%", "alquiler 8%"…) y
--   `overhead_pct` el total. Un porcentaje suelto es un número mágico que en seis
--   meses nadie sabe de dónde salió ni cómo actualizar; con el desglose a la
--   vista, subir el alquiler es editar una fila. Mismo criterio que
--   `data_retention_targets` en la 212: el alcance se guarda para poder mirarlo.
--
-- El total lo mantiene un TRIGGER a partir de las filas: si el panel calculara el
-- total y lo mandara aparte, el día que alguien escriba por otra vía quedarían
-- dos verdades distintas del mismo dato.
--
-- IDEMPOTENTE: se puede re-correr entera.
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- §1 · Columnas
-- ════════════════════════════════════════════════════════════

ALTER TABLE public.restaurant_settings
  ADD COLUMN IF NOT EXISTS overhead_pct   DECIMAL(5,2) NOT NULL DEFAULT 0
    CHECK (overhead_pct >= 0 AND overhead_pct < 100),
  ADD COLUMN IF NOT EXISTS overhead_items JSONB        NOT NULL DEFAULT '[]'::JSONB;

COMMENT ON COLUMN public.restaurant_settings.overhead_pct IS
  'Gastos que NO son insumos (sueldos, alquiler, luz, gas, comisiones), como
   porcentaje de la venta. Lo mantiene el trigger sync_overhead_total a partir de
   overhead_items — no escribirlo a mano. 0 = el local no los cargó y el costeo
   se comporta como antes de la mig 214.';

COMMENT ON COLUMN public.restaurant_settings.overhead_items IS
  'Desglose: [{"label":"Personal","pct":30},{"label":"Alquiler","pct":8}].
   Se guarda el detalle y no sólo el total para que dentro de seis meses se pueda
   saber de dónde salió el número y actualizar una línea sin rehacerlo todo.';


-- ── El total sale SIEMPRE de las filas ──
CREATE OR REPLACE FUNCTION public.sync_overhead_total()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE v_total DECIMAL;
BEGIN
  IF NEW.overhead_items IS NULL OR jsonb_typeof(NEW.overhead_items) <> 'array' THEN
    NEW.overhead_items := '[]'::JSONB;
  END IF;

  SELECT COALESCE(SUM( GREATEST(0, (it->>'pct')::DECIMAL) ), 0)
    INTO v_total
    FROM jsonb_array_elements(NEW.overhead_items) it
   WHERE (it->>'pct') ~ '^[0-9]+(\.[0-9]+)?$';

  -- Tope duro: con gastos ≥ 100% de la venta la fórmula del precio se va a
  -- infinito o a negativo. Se recorta y el panel avisa.
  NEW.overhead_pct := LEAST(v_total, 95);
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_sync_overhead_total ON public.restaurant_settings;
CREATE TRIGGER trg_sync_overhead_total
  BEFORE INSERT OR UPDATE OF overhead_items ON public.restaurant_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_overhead_total();


-- ════════════════════════════════════════════════════════════
-- §2 · menu_costing_report con el costo completo
-- ════════════════════════════════════════════════════════════
-- Cambia el tipo de retorno (suma overhead_pct, overhead_cost, total_cost,
-- net_margin, net_margin_pct) → hay que dropear antes.
DROP FUNCTION IF EXISTS public.menu_costing_report(UUID);
CREATE OR REPLACE FUNCTION public.menu_costing_report(p_restaurant_id UUID)
RETURNS TABLE (
  menu_item_id      INT,
  item_name         TEXT,
  category_name     TEXT,
  price             INT,
  cost              DECIMAL,   -- insumos
  food_cost_pct     DECIMAL,
  overhead_pct      DECIMAL,   -- % de gastos operativos vigente
  overhead_cost     DECIMAL,   -- lo que se lleva el overhead de ESTE precio
  total_cost        DECIMAL,   -- insumos + overhead
  margin            DECIMAL,   -- margen bruto (precio − insumos)
  margin_pct        DECIMAL,
  net_margin        DECIMAL,   -- ganancia limpia (precio − insumos − overhead)
  net_margin_pct    DECIMAL,
  target_margin_pct DECIMAL,
  suggested_price   DECIMAL,
  recipe_lines      INT,
  uncosted_lines    INT,
  status            TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_default  DECIMAL;
  v_overhead DECIMAL;
BEGIN
  IF NOT public.can_see_costs(p_restaurant_id) THEN RETURN; END IF;

  SELECT COALESCE(rs.default_target_margin_pct, 65), COALESCE(rs.overhead_pct, 0)
    INTO v_default, v_overhead
    FROM public.restaurant_settings rs WHERE rs.restaurant_id = p_restaurant_id;
  v_default  := COALESCE(v_default, 65);
  v_overhead := COALESCE(v_overhead, 0);

  RETURN QUERY
  WITH base AS (
    SELECT
      mi.id,
      mi.name,
      mc.name AS cat_name,
      mi.price_guarani                                   AS pr,
      public._menu_item_cost(mi.id)                      AS c,
      COALESCE(mi.target_margin_pct, mc.target_margin_pct, v_default) AS tgt,
      (SELECT COUNT(*) FROM public.recipes rc WHERE rc.menu_item_id = mi.id) AS n_lines,
      (SELECT COUNT(*)
         FROM public.explode_menu_item(mi.id) e
         JOIN public.ingredients i ON i.id = e.ing_id
        WHERE COALESCE(i.avg_cost, i.cost_per_unit) IS NULL) AS missing
    FROM public.menu_items mi
    LEFT JOIN public.menu_categories mc ON mc.id = mi.category_id
    WHERE mi.restaurant_id = p_restaurant_id
  ),
  calc AS (
    SELECT b.*,
           (b.pr * v_overhead / 100.0)                    AS oh_cost,
           (b.pr - b.c - (b.pr * v_overhead / 100.0))     AS net
      FROM base b
  )
  SELECT
    k.id,
    k.name,
    COALESCE(k.cat_name, 'Sin categoría'),
    k.pr,
    ROUND(k.c, 2),
    CASE WHEN k.pr > 0 THEN ROUND(k.c / k.pr * 100, 2) END,
    ROUND(v_overhead, 2),
    ROUND(k.oh_cost, 2),
    ROUND(k.c + k.oh_cost, 2),
    ROUND(k.pr - k.c, 2),
    CASE WHEN k.pr > 0 THEN ROUND((k.pr - k.c) / k.pr * 100, 2) END,
    ROUND(k.net, 2),
    CASE WHEN k.pr > 0 THEN ROUND(k.net / k.pr * 100, 2) END,
    ROUND(k.tgt, 2),
    -- Precio que deja el margen objetivo LIMPIO, ya descontados los gastos
    -- operativos: costo / (1 − gastos − margen). Con gastos 0 es la fórmula de
    -- la 213. Si gastos + margen ≥ 100 no hay precio posible → NULL, y el panel
    -- lo explica en vez de mostrar un número imposible.
    CASE WHEN k.c > 0 AND (v_overhead + k.tgt) < 100
         THEN ROUND(k.c / (1 - (v_overhead + k.tgt) / 100.0), 0) END,
    k.n_lines::INT,
    k.missing::INT,
    CASE
      WHEN k.n_lines = 0                 THEN 'sin_receta'
      WHEN k.missing > 0                 THEN 'costo_incompleto'
      WHEN k.pr <= 0                     THEN 'sin_precio'
      WHEN k.net <= 0                    THEN 'perdida'
      WHEN k.pr > 0 AND (k.net / k.pr * 100) < k.tgt THEN 'bajo_objetivo'
      ELSE 'ok'
    END
  FROM calc k
  ORDER BY
    CASE
      WHEN k.n_lines = 0   THEN 3
      WHEN k.missing > 0   THEN 2
      WHEN k.net    <= 0   THEN 0
      ELSE 1
    END,
    k.name;
END;
$fn$;


-- ════════════════════════════════════════════════════════════
-- §3 · profitability_report con la ganancia limpia
-- ════════════════════════════════════════════════════════════
-- El overhead se prorratea sobre la facturación real del período, que es
-- exactamente lo que significa "X% de la venta".
DROP FUNCTION IF EXISTS public.profitability_report(UUID, TIMESTAMPTZ, TIMESTAMPTZ);
CREATE OR REPLACE FUNCTION public.profitability_report(
  p_restaurant_id UUID,
  p_from          TIMESTAMPTZ,
  p_to            TIMESTAMPTZ
)
RETURNS TABLE (
  menu_item_id   INT,
  item_name      TEXT,
  units          BIGINT,
  revenue        DECIMAL,
  cost           DECIMAL,
  margin         DECIMAL,
  margin_pct     DECIMAL,
  overhead_cost  DECIMAL,
  net_margin     DECIMAL,
  net_margin_pct DECIMAL,
  unit_margin    DECIMAL,
  cost_source    TEXT,
  menu_class     TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE v_overhead DECIMAL;
BEGIN
  IF NOT public.can_see_costs(p_restaurant_id) THEN RETURN; END IF;

  SELECT COALESCE(rs.overhead_pct, 0) INTO v_overhead
    FROM public.restaurant_settings rs WHERE rs.restaurant_id = p_restaurant_id;
  v_overhead := COALESCE(v_overhead, 0);

  RETURN QUERY
  WITH lineas AS (
    SELECT
      oi.item_id,
      oi.item_name,
      oi.quantity,
      oi.total_price,
      COALESCE(oi.unit_cost, public._menu_item_cost(oi.item_id)) AS u_cost,
      (oi.unit_cost IS NOT NULL) AS frozen,
      COALESCE((
        SELECT SUM(COALESCE(oie.unit_cost, 0))
          FROM public.order_item_extras oie WHERE oie.order_item_id = oi.id
      ), 0) AS extras_cost
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.restaurant_id = p_restaurant_id
      AND o.status NOT IN ('draft','cancelled')
      AND o.created_at >= p_from
      AND o.created_at <= p_to
  ),
  agg AS (
    SELECT
      l.item_id,
      COALESCE(l.item_name, '—')                                      AS nm,
      SUM(l.quantity)::BIGINT                                         AS u,
      SUM(COALESCE(l.total_price, 0))::DECIMAL                        AS rev,
      SUM(COALESCE(l.u_cost,0) * l.quantity + l.extras_cost)::DECIMAL AS cst,
      BOOL_AND(l.frozen)                                              AS all_frozen,
      BOOL_OR(l.frozen)                                               AS any_frozen
    FROM lineas l
    GROUP BY l.item_id, COALESCE(l.item_name, '—')
  ),
  conoh AS (
    SELECT a.*, (a.rev * v_overhead / 100.0) AS oh
      FROM agg a
  ),
  prom AS (
    -- La matriz de ingeniería de menú se ordena por la ganancia LIMPIA por
    -- unidad: un plato que se ve rentable sobre insumos puede no serlo una vez
    -- que carga su parte de sueldos y alquiler.
    SELECT AVG(k.u) AS au,
           AVG(CASE WHEN k.u > 0 THEN (k.rev - k.cst - k.oh) / k.u END) AS am
      FROM conoh k
  )
  SELECT
    k.item_id,
    k.nm,
    k.u,
    ROUND(k.rev, 2),
    ROUND(k.cst, 2),
    ROUND(k.rev - k.cst, 2),
    CASE WHEN k.rev > 0 THEN ROUND((k.rev - k.cst) / k.rev * 100, 2) END,
    ROUND(k.oh, 2),
    ROUND(k.rev - k.cst - k.oh, 2),
    CASE WHEN k.rev > 0 THEN ROUND((k.rev - k.cst - k.oh) / k.rev * 100, 2) END,
    CASE WHEN k.u   > 0 THEN ROUND((k.rev - k.cst - k.oh) / k.u, 2) END,
    CASE WHEN k.all_frozen THEN 'congelado'
         WHEN k.any_frozen THEN 'mixto'
         ELSE 'actual' END,
    CASE
      WHEN k.cst <= 0 AND k.rev <= 0 THEN 'sin_datos'
      WHEN k.u >= p.au AND COALESCE((k.rev - k.cst - k.oh) / NULLIF(k.u,0), 0) >= COALESCE(p.am,0) THEN 'estrella'
      WHEN k.u >= p.au                                                                             THEN 'caballo'
      WHEN COALESCE((k.rev - k.cst - k.oh) / NULLIF(k.u,0), 0) >= COALESCE(p.am,0)                 THEN 'enigma'
      ELSE 'perro'
    END
  FROM conoh k CROSS JOIN prom p
  ORDER BY (k.rev - k.cst - k.oh) DESC;
END;
$fn$;


-- ════════════════════════════════════════════════════════════
-- §4 · Privilegios
-- ════════════════════════════════════════════════════════════
-- Recordatorio de la 213 §14: CREATE FUNCTION otorga EXECUTE a PUBLIC por
-- defecto. Las dos funciones se acaban de RECREAR, así que volvieron a nacer
-- abiertas y hay que cerrarlas de nuevo. Es el paso que más fácil se olvida.
DO $$
DECLARE fn TEXT;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure::TEXT
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('menu_costing_report','profitability_report','sync_overhead_total')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon',   fn);
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.menu_costing_report(UUID)                             TO authenticated;
GRANT EXECUTE ON FUNCTION public.profitability_report(UUID, TIMESTAMPTZ, TIMESTAMPTZ)  TO authenticated;


-- ════════════════════════════════════════════════════════════
-- §5 · Verificación
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE v_con_gastos INT;
BEGIN
  SELECT COUNT(*) INTO v_con_gastos
    FROM public.restaurant_settings WHERE COALESCE(overhead_pct,0) > 0;
  RAISE NOTICE 'Migración 214 aplicada.';
  RAISE NOTICE '  Locales con gastos operativos cargados: %', v_con_gastos;
  RAISE NOTICE '  (0 es lo esperado el día uno: sin gastos cargados el precio';
  RAISE NOTICE '   sugerido da exactamente el mismo número que antes.)';
END $$;
