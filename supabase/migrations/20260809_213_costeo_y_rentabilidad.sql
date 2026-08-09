-- ============================================================
-- Migración 213: Costeo de productos y rentabilidad
-- ============================================================
-- Cierra el módulo de costos, que hasta hoy estaba roto de punta a punta:
--
--   1. `ingredients` tenía DOS columnas de costo — `cost_per_unit` (mig 017) y
--      `unit_cost` (mig 034). Todo lo que ESCRIBE escribe `cost_per_unit`; el
--      reporte "Rentabilidad por producto" LEE `unit_cost`, que en todo el repo
--      aparece 3 veces y las 3 son lecturas. Nadie la escribió nunca → el reporte
--      mostraba Costo "—" y Margen "—" en todas las filas desde que existe.
--      Acá se unifica en `cost_per_unit` (la que graban los formularios y la RPC)
--      con backfill desde `unit_cost`, y `unit_cost` queda marcada como obsoleta.
--
--   2. El costo se PISABA en cada compra (`admin_load_stock` hacía COALESCE sobre
--      `cost_per_unit`) y no quedaba historia: comprar carne más cara reescribía
--      el margen de todos los meses anteriores. Acá el costo pasa a ser PROMEDIO
--      PONDERADO móvil (`avg_cost`), `cost_per_unit` queda como "última compra"
--      y cada carga deja su precio asentado en `stock_movements`.
--
--   3. No existía merma: 1 kg de papa cruda no da 1 kg de papa frita, así que el
--      costo quedaba subestimado siempre. Acá `ingredients.waste_pct`.
--
--   4. No existían sub-recetas: una salsa usada en 8 platos había que cargarla
--      ingrediente por ingrediente 8 veces. Acá `prep_recipes`.
--
--   5. Los extras vendían a precio y costaban ₲0. Acá `extra_recipes`.
--
--   6. El costo no se congelaba en la venta, así que el margen histórico se
--      recalculaba con los precios de hoy. Acá `order_items.unit_cost`.
--
-- DECISIONES DE NEGOCIO (Renato, 2026-08-09):
--   • Método de costeo: PROMEDIO PONDERADO móvil. No es configurable a propósito
--     — dos métodos conviviendo es la misma trampa de las dos columnas de costo.
--   • Merma y sub-recetas: incluidas. Ambas son OPCIONALES (waste_pct default 0,
--     preparaciones vacías) → un local que no las carga ve el comportamiento de
--     siempre, exactamente igual.
--   • Costos visibles para Admin siempre; para Gerente sólo si el dueño lo
--     habilita (`restaurant_settings.costs_visible_to_gerente`, default false).
--
-- CONVENCIÓN DE MERMA (importante, define cómo se cargan las recetas):
--   La receta se escribe con el peso que VA AL PLATO (neto). La merma dice cuánto
--   se pierde al limpiar/preparar. El sistema agrega la merma solo, con factor
--   1/(1-merma), y lo hace en la MISMA función que usa el descuento de stock —
--   así costo y stock nunca pueden discrepar. Con waste_pct = 0 (el default y el
--   valor de todos los ingredientes existentes) el factor es 1 y el descuento de
--   stock se comporta EXACTAMENTE como antes de esta migración.
--
-- IDEMPOTENTE: se puede re-correr entera sin efectos secundarios.
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- §1 · Unificación de la columna de costo
-- ════════════════════════════════════════════════════════════
-- `cost_per_unit` (mig 017) es la canónica: es la que graban el alta de
-- ingrediente, `admin_load_stock` y la que devuelve `admin_list_ingredients`.
-- `unit_cost` (mig 034) se rellena por única vez y queda obsoleta.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ingredients' AND column_name='unit_cost'
  ) THEN
    -- Backfill: si alguien cargó un costo a mano en la columna huérfana, se rescata.
    EXECUTE $q$
      UPDATE public.ingredients
         SET cost_per_unit = unit_cost
       WHERE cost_per_unit IS NULL
         AND unit_cost IS NOT NULL
    $q$;
    EXECUTE $q$
      COMMENT ON COLUMN public.ingredients.unit_cost IS
        'OBSOLETA (mig 213). La columna de costo canónica es cost_per_unit (última
         compra) y avg_cost (promedio ponderado, el que se usa para costear).
         Se conserva sin dropear porque hay datos de clientes reales en prod; no
         la lee ni la escribe nada. No usar en código nuevo.'
    $q$;
  END IF;
END $$;

COMMENT ON COLUMN public.ingredients.cost_per_unit IS
  'Precio de la ÚLTIMA compra, por unidad del ingrediente. Informativo y base del
   historial de precios. Para costear se usa avg_cost (promedio ponderado).';


-- ════════════════════════════════════════════════════════════
-- §2 · Promedio ponderado + merma
-- ════════════════════════════════════════════════════════════

ALTER TABLE public.ingredients
  ADD COLUMN IF NOT EXISTS avg_cost   DECIMAL(14,4),
  ADD COLUMN IF NOT EXISTS waste_pct  DECIMAL(5,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ingredients_waste_pct_range'
  ) THEN
    ALTER TABLE public.ingredients
      ADD CONSTRAINT ingredients_waste_pct_range CHECK (waste_pct >= 0 AND waste_pct < 100);
  END IF;
END $$;

COMMENT ON COLUMN public.ingredients.avg_cost IS
  'Costo promedio ponderado móvil, por unidad del ingrediente. Es el costo con el
   que se valorizan las recetas. Se recalcula en cada carga de stock:
   nuevo = (stock_previo*avg_previo + cantidad_cargada*costo_compra) / (stock_previo+cantidad).';

COMMENT ON COLUMN public.ingredients.waste_pct IS
  'Merma %: cuánto se pierde entre lo que se compra y lo que llega al plato
   (limpieza, hueso, cocción, evaporación). Las recetas se cargan con el peso NETO
   y el sistema agrega la merma con factor 1/(1-merma/100). 0 = sin merma.';

-- Arranque: los ingredientes que ya tienen un costo cargado empiezan con ese
-- mismo valor como promedio, así ninguna ficha muestra costo 0 el día uno.
UPDATE public.ingredients
   SET avg_cost = cost_per_unit
 WHERE avg_cost IS NULL
   AND cost_per_unit IS NOT NULL;


-- ════════════════════════════════════════════════════════════
-- §3 · Historial de precios de compra
-- ════════════════════════════════════════════════════════════
-- `stock_movements` ya es inmutable y ya registra cada carga con su cantidad y
-- unidad. Agregarle el precio evita una tabla nueva que duplicaría el mismo
-- hecho (regla "un dato se pide una sola vez", CLAUDE.md).

ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS unit_cost  DECIMAL(14,4),
  ADD COLUMN IF NOT EXISTS total_cost DECIMAL(14,2);

COMMENT ON COLUMN public.stock_movements.unit_cost IS
  'Precio de compra por unidad DEL INGREDIENTE (ya convertido) en este movimiento.
   Sólo tiene sentido en movement_type = load. Es el historial de precios.';
COMMENT ON COLUMN public.stock_movements.total_cost IS
  'Costo total de la carga (unit_cost * cantidad convertida).';

CREATE INDEX IF NOT EXISTS idx_stock_movements_cost_history
  ON public.stock_movements(ingredient_id, created_at DESC)
  WHERE movement_type = 'load' AND unit_cost IS NOT NULL;


-- ── Helper: convertir un PRECIO entre unidades ────────────────
-- Ojo con la dirección: si 1 kg = 1000 g, entonces el precio POR GRAMO es el
-- precio por kilo DIVIDIDO 1000. O sea el precio se convierte con el factor
-- inverso al de la cantidad. Invertirlo acá multiplicaría los costos por 1.000.
CREATE OR REPLACE FUNCTION public.convert_unit_cost(
  p_cost DECIMAL, p_from_unit stock_unit, p_to_unit stock_unit
)
RETURNS DECIMAL
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_factor DECIMAL;   -- cuántas unidades destino entran en 1 unidad origen
BEGIN
  IF p_cost IS NULL THEN RETURN NULL; END IF;
  IF p_from_unit = p_to_unit THEN RETURN p_cost; END IF;
  v_factor := public.convert_units(1, p_from_unit, p_to_unit);
  IF v_factor IS NULL OR v_factor = 0 THEN RETURN NULL; END IF;
  RETURN p_cost / v_factor;
END;
$$;

GRANT EXECUTE ON FUNCTION public.convert_unit_cost(DECIMAL, stock_unit, stock_unit) TO authenticated;


-- ════════════════════════════════════════════════════════════
-- §4 · Preparaciones intermedias (sub-recetas)
-- ════════════════════════════════════════════════════════════
-- Una salsa, una masa, un caldo: se cargan UNA vez con su rendimiento y después
-- los platos consumen una parte. Cambiar el proveedor del tomate re-costea los 8
-- platos solo, en vez de obligar a editar 8 recetas.

CREATE TABLE IF NOT EXISTS public.prep_recipes (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID          NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  name          TEXT          NOT NULL,
  yield_qty     DECIMAL(12,3) NOT NULL CHECK (yield_qty > 0),
  yield_unit    stock_unit    NOT NULL DEFAULT 'unit',
  waste_pct     DECIMAL(5,2)  NOT NULL DEFAULT 0 CHECK (waste_pct >= 0 AND waste_pct < 100),
  notes         TEXT,
  is_active     BOOLEAN       NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.prep_recipes IS
  'Preparaciones intermedias (salsa, masa, caldo, marinada). No se venden: las
   consumen los platos y otras preparaciones. yield_qty/yield_unit = cuánto rinde
   una tanda; de ahí sale el costo por unidad de la preparación.';
COMMENT ON COLUMN public.prep_recipes.waste_pct IS
  'Merma propia de la preparación (evaporación, lo que queda en la olla), sobre el
   rendimiento nominal. Rendimiento efectivo = yield_qty * (1 - waste_pct/100).';

CREATE TABLE IF NOT EXISTS public.prep_recipe_items (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  prep_recipe_id UUID          NOT NULL REFERENCES public.prep_recipes(id) ON DELETE CASCADE,
  ingredient_id  UUID          REFERENCES public.ingredients(id)  ON DELETE CASCADE,
  child_prep_id  UUID          REFERENCES public.prep_recipes(id) ON DELETE CASCADE,
  quantity       DECIMAL(12,3) NOT NULL CHECK (quantity > 0),
  unit           stock_unit    NOT NULL DEFAULT 'unit',
  notes          TEXT,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- Exactamente uno: o es un ingrediente, o es otra preparación.
  CONSTRAINT prep_item_one_source CHECK (num_nonnulls(ingredient_id, child_prep_id) = 1),
  -- Una preparación no puede contenerse a sí misma en forma directa.
  CONSTRAINT prep_item_no_self    CHECK (child_prep_id IS NULL OR child_prep_id <> prep_recipe_id)
);

CREATE INDEX IF NOT EXISTS idx_prep_recipes_restaurant  ON public.prep_recipes(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_prep_items_prep          ON public.prep_recipe_items(prep_recipe_id);
CREATE INDEX IF NOT EXISTS idx_prep_items_ingredient    ON public.prep_recipe_items(ingredient_id);
CREATE INDEX IF NOT EXISTS idx_prep_items_child         ON public.prep_recipe_items(child_prep_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_prep_item_ingredient
  ON public.prep_recipe_items(prep_recipe_id, ingredient_id) WHERE ingredient_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_prep_item_child
  ON public.prep_recipe_items(prep_recipe_id, child_prep_id) WHERE child_prep_id IS NOT NULL;


-- ════════════════════════════════════════════════════════════
-- §5 · `recipes` admite una preparación además de un ingrediente
-- ════════════════════════════════════════════════════════════
-- OJO: la policy `recipes_auth` (mig 104) scopea la fila POR SU INGREDIENTE.
-- Al permitir líneas sin ingrediente hay que reponerla o una línea de
-- preparación quedaría invisible e ininsertable. Se repone en §12.

ALTER TABLE public.recipes
  ADD COLUMN IF NOT EXISTS prep_recipe_id UUID REFERENCES public.prep_recipes(id) ON DELETE CASCADE;

ALTER TABLE public.recipes ALTER COLUMN ingredient_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recipes_one_source') THEN
    ALTER TABLE public.recipes
      ADD CONSTRAINT recipes_one_source CHECK (num_nonnulls(ingredient_id, prep_recipe_id) = 1);
  END IF;
END $$;

-- El UNIQUE(menu_item_id, ingredient_id) original no contempla preparaciones y,
-- con ingredient_id nullable, deja de proteger. Se reemplaza por dos parciales.
ALTER TABLE public.recipes DROP CONSTRAINT IF EXISTS recipes_menu_item_id_ingredient_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_recipe_ingredient
  ON public.recipes(menu_item_id, ingredient_id) WHERE ingredient_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_recipe_prep
  ON public.recipes(menu_item_id, prep_recipe_id) WHERE prep_recipe_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_recipes_prep ON public.recipes(prep_recipe_id);


-- ════════════════════════════════════════════════════════════
-- §6 · Receta de extras
-- ════════════════════════════════════════════════════════════
-- Un "extra queso" a ₲8.000 entraba como margen 100% en todo reporte.

CREATE TABLE IF NOT EXISTS public.extra_recipes (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  extra_id       INT           NOT NULL REFERENCES public.menu_item_extras(id) ON DELETE CASCADE,
  ingredient_id  UUID          REFERENCES public.ingredients(id)  ON DELETE CASCADE,
  prep_recipe_id UUID          REFERENCES public.prep_recipes(id) ON DELETE CASCADE,
  quantity       DECIMAL(12,3) NOT NULL CHECK (quantity > 0),
  unit           stock_unit    NOT NULL DEFAULT 'unit',
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT extra_recipe_one_source CHECK (num_nonnulls(ingredient_id, prep_recipe_id) = 1)
);

CREATE INDEX IF NOT EXISTS idx_extra_recipes_extra ON public.extra_recipes(extra_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_extra_recipe_ingredient
  ON public.extra_recipes(extra_id, ingredient_id) WHERE ingredient_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_extra_recipe_prep
  ON public.extra_recipes(extra_id, prep_recipe_id) WHERE prep_recipe_id IS NOT NULL;


-- ════════════════════════════════════════════════════════════
-- §7 · Margen objetivo y permiso del gerente
-- ════════════════════════════════════════════════════════════
-- El margen objetivo cascadea: producto → categoría → local → 65% de fábrica.
-- Así el dueño fija "65% en todo, 75% en bebidas" y sólo toca las excepciones.

ALTER TABLE public.menu_items
  ADD COLUMN IF NOT EXISTS target_margin_pct DECIMAL(5,2)
    CHECK (target_margin_pct IS NULL OR (target_margin_pct >= 0 AND target_margin_pct < 100));

ALTER TABLE public.menu_categories
  ADD COLUMN IF NOT EXISTS target_margin_pct DECIMAL(5,2)
    CHECK (target_margin_pct IS NULL OR (target_margin_pct >= 0 AND target_margin_pct < 100));

ALTER TABLE public.restaurant_settings
  ADD COLUMN IF NOT EXISTS default_target_margin_pct DECIMAL(5,2) NOT NULL DEFAULT 65
    CHECK (default_target_margin_pct >= 0 AND default_target_margin_pct < 100),
  ADD COLUMN IF NOT EXISTS costs_visible_to_gerente  BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.restaurant_settings.costs_visible_to_gerente IS
  'Si el panel Gerente ve costos y márgenes. Default false: es información
   sensible del negocio y el dueño la habilita a conciencia. El gate se aplica en
   las RPC de costeo, no sólo escondiendo el botón.';


-- ════════════════════════════════════════════════════════════
-- §8 · Costo congelado en la venta
-- ════════════════════════════════════════════════════════════
-- Sin esto, el reporte de marzo se recalcula con los costos de agosto y el margen
-- histórico miente. Se congela al pasar a 'paid', independientemente de si el
-- descuento automático de stock está prendido (son cosas distintas).

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS unit_cost DECIMAL(14,4);

ALTER TABLE public.order_item_extras
  ADD COLUMN IF NOT EXISTS unit_cost DECIMAL(14,4);

COMMENT ON COLUMN public.order_items.unit_cost IS
  'Costo de insumos de UNA unidad de este ítem, congelado al cobrarse el pedido.
   NULL = el pedido es anterior a la mig 213 o el ítem no tenía receta.';


-- ════════════════════════════════════════════════════════════
-- §9 · Explosión de recetas — FUENTE ÚNICA
-- ════════════════════════════════════════════════════════════
-- "Qué insumos consume este plato" se responde en UN solo lugar. Lo usan el
-- descuento de stock, la disponibilidad, la proyección y el costeo. Si cada uno
-- tuviera su propio recorrido, el día que se agregan sub-recetas o merma alguno
-- queda viejo y el costo deja de coincidir con lo que realmente sale del depósito.

-- ── Necesidad de UN ingrediente, en su propia unidad y con su merma ──
CREATE OR REPLACE FUNCTION public._ingredient_need(
  p_ing_id UUID, p_qty DECIMAL, p_unit stock_unit
)
RETURNS TABLE (ing_id UUID, qty_needed DECIMAL)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_unit  stock_unit;
  v_waste DECIMAL;
  v_conv  DECIMAL;
BEGIN
  IF p_ing_id IS NULL OR p_qty IS NULL OR p_qty <= 0 THEN RETURN; END IF;

  SELECT i.unit, COALESCE(i.waste_pct, 0) INTO v_unit, v_waste
    FROM public.ingredients i WHERE i.id = p_ing_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Unidad incompatible (masa vs volumen, etc.) → no consume nada. Nunca vaciar
  -- stock por una receta mal armada; criterio heredado de la mig 181.
  v_conv := public.convert_units(p_qty, p_unit, v_unit);
  IF v_conv IS NULL THEN RETURN; END IF;

  -- La receta está en peso NETO; la merma se agrega acá y en un solo lugar.
  ing_id     := p_ing_id;
  qty_needed := v_conv / (1 - v_waste / 100.0);
  RETURN NEXT;
END;
$$;

-- ── Explotar una preparación a ingredientes (recursivo) ──
CREATE OR REPLACE FUNCTION public.explode_prep_recipe(
  p_prep_id UUID, p_qty DECIMAL, p_unit stock_unit, p_depth INT DEFAULT 0
)
RETURNS TABLE (ing_id UUID, qty_needed DECIMAL)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_yield_qty  DECIMAL;
  v_yield_unit stock_unit;
  v_waste      DECIMAL;
  v_active     BOOLEAN;
  v_need       DECIMAL;
  v_eff_yield  DECIMAL;
  v_factor     DECIMAL;
  it           RECORD;
BEGIN
  -- Tope de anidamiento: corta cualquier ciclo que los CHECK directos no atrapen
  -- (A dentro de B dentro de A). Sin esto, un ciclo cuelga la transacción.
  IF p_depth > 5 OR p_prep_id IS NULL OR p_qty IS NULL OR p_qty <= 0 THEN RETURN; END IF;

  SELECT pr.yield_qty, pr.yield_unit, COALESCE(pr.waste_pct,0), pr.is_active
    INTO v_yield_qty, v_yield_unit, v_waste, v_active
    FROM public.prep_recipes pr WHERE pr.id = p_prep_id;
  IF NOT FOUND OR NOT v_active THEN RETURN; END IF;

  v_need := public.convert_units(p_qty, p_unit, v_yield_unit);
  IF v_need IS NULL THEN RETURN; END IF;

  v_eff_yield := v_yield_qty * (1 - v_waste / 100.0);
  IF v_eff_yield IS NULL OR v_eff_yield <= 0 THEN RETURN; END IF;

  -- Qué proporción de una tanda hace falta.
  v_factor := v_need / v_eff_yield;

  FOR it IN
    SELECT pi.ingredient_id, pi.child_prep_id, pi.quantity, pi.unit
      FROM public.prep_recipe_items pi
     WHERE pi.prep_recipe_id = p_prep_id
  LOOP
    IF it.ingredient_id IS NOT NULL THEN
      RETURN QUERY SELECT n.ing_id, n.qty_needed
        FROM public._ingredient_need(it.ingredient_id, it.quantity * v_factor, it.unit) n;
    ELSE
      RETURN QUERY SELECT c.ing_id, c.qty_needed
        FROM public.explode_prep_recipe(it.child_prep_id, it.quantity * v_factor, it.unit, p_depth + 1) c;
    END IF;
  END LOOP;
END;
$$;

-- ── Explotar un ítem del menú (filas sin agrupar) ──
CREATE OR REPLACE FUNCTION public._explode_menu_item_raw(p_menu_item_id INT)
RETURNS TABLE (ing_id UUID, qty_needed DECIMAL)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE r RECORD;
BEGIN
  IF p_menu_item_id IS NULL THEN RETURN; END IF;
  FOR r IN
    SELECT rc.ingredient_id, rc.prep_recipe_id, rc.quantity_required, rc.unit
      FROM public.recipes rc WHERE rc.menu_item_id = p_menu_item_id
  LOOP
    IF r.ingredient_id IS NOT NULL THEN
      RETURN QUERY SELECT n.ing_id, n.qty_needed
        FROM public._ingredient_need(r.ingredient_id, r.quantity_required, r.unit) n;
    ELSE
      RETURN QUERY SELECT c.ing_id, c.qty_needed
        FROM public.explode_prep_recipe(r.prep_recipe_id, r.quantity_required, r.unit, 1) c;
    END IF;
  END LOOP;
END;
$$;

-- ── Explotar un ítem del menú (agrupado por ingrediente) ──
-- Sin CREATE TEMP TABLE: PostgreSQL rechaza DDL dentro de una función no-VOLATILE
-- (misma trampa que documentó diner_leaderboard en la mig 200).
CREATE OR REPLACE FUNCTION public.explode_menu_item(p_menu_item_id INT)
RETURNS TABLE (ing_id UUID, qty_needed DECIMAL)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT x.ing_id, SUM(x.qty_needed)::DECIMAL
    FROM public._explode_menu_item_raw(p_menu_item_id) x
   GROUP BY x.ing_id;
$$;

-- ── Explotar un extra ──
CREATE OR REPLACE FUNCTION public._explode_extra_raw(p_extra_id INT)
RETURNS TABLE (ing_id UUID, qty_needed DECIMAL)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE r RECORD;
BEGIN
  IF p_extra_id IS NULL THEN RETURN; END IF;
  FOR r IN
    SELECT er.ingredient_id, er.prep_recipe_id, er.quantity, er.unit
      FROM public.extra_recipes er WHERE er.extra_id = p_extra_id
  LOOP
    IF r.ingredient_id IS NOT NULL THEN
      RETURN QUERY SELECT n.ing_id, n.qty_needed
        FROM public._ingredient_need(r.ingredient_id, r.quantity, r.unit) n;
    ELSE
      RETURN QUERY SELECT c.ing_id, c.qty_needed
        FROM public.explode_prep_recipe(r.prep_recipe_id, r.quantity, r.unit, 1) c;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.explode_extra(p_extra_id INT)
RETURNS TABLE (ing_id UUID, qty_needed DECIMAL)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT x.ing_id, SUM(x.qty_needed)::DECIMAL
    FROM public._explode_extra_raw(p_extra_id) x
   GROUP BY x.ing_id;
$$;

-- ── Costo vigente de un ingrediente (promedio ponderado) ──
CREATE OR REPLACE FUNCTION public.ingredient_cost(p_ing_id UUID)
RETURNS DECIMAL
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT COALESCE(i.avg_cost, i.cost_per_unit)
    FROM public.ingredients i WHERE i.id = p_ing_id;
$$;

GRANT EXECUTE ON FUNCTION public._ingredient_need(UUID, DECIMAL, stock_unit)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.explode_prep_recipe(UUID, DECIMAL, stock_unit, INT)    TO authenticated;
GRANT EXECUTE ON FUNCTION public._explode_menu_item_raw(INT)                            TO authenticated;
GRANT EXECUTE ON FUNCTION public.explode_menu_item(INT)                                 TO authenticated;
GRANT EXECUTE ON FUNCTION public._explode_extra_raw(INT)                                TO authenticated;
GRANT EXECUTE ON FUNCTION public.explode_extra(INT)                                     TO authenticated;
GRANT EXECUTE ON FUNCTION public.ingredient_cost(UUID)                                  TO authenticated;


-- ════════════════════════════════════════════════════════════
-- §10 · Reponer stock sobre la explosión única
-- ════════════════════════════════════════════════════════════
-- Estas funciones vienen de la mig 181 y recorrían `recipes` a mano. Ahora pasan
-- por explode_menu_item(), así heredan sub-recetas y merma sin duplicar lógica.
-- ADVERTENCIA para el futuro: si alguna se toca por otro lado, re-aplicar esta
-- migración encima o el cambio se pierde (misma nota que dejó la 207).

-- ── Descontar stock al cobrarse el pedido ──
CREATE OR REPLACE FUNCTION public.deduct_stock_for_order(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  r               RECORD;
  v_restaurant_id UUID;
  v_auto_discount BOOLEAN;
BEGIN
  SELECT o.restaurant_id INTO v_restaurant_id FROM public.orders o WHERE o.id = p_order_id;

  SELECT COALESCE(rs.auto_stock_discount, false) INTO v_auto_discount
    FROM public.restaurant_settings rs WHERE rs.restaurant_id = v_restaurant_id;

  IF NOT COALESCE(v_auto_discount, false) THEN RETURN; END IF;

  -- Ítems del menú + extras, agregados por ingrediente en UNA pasada: si el mismo
  -- insumo aparece en el plato y en su extra, se descuenta una vez por el total.
  FOR r IN
    WITH consumo AS (
      SELECT e.ing_id, (e.qty_needed * oi.quantity) AS need
        FROM public.order_items oi
        CROSS JOIN LATERAL public.explode_menu_item(oi.item_id) e
       WHERE oi.order_id = p_order_id AND oi.item_id IS NOT NULL
      UNION ALL
      SELECT e.ing_id, (e.qty_needed * oi.quantity) AS need
        FROM public.order_items oi
        JOIN public.order_item_extras oie ON oie.order_item_id = oi.id
        JOIN public.menu_item_extras   me ON me.item_id = oi.item_id
                                         AND me.name    = oie.extra_name
        CROSS JOIN LATERAL public.explode_extra(me.id) e
       WHERE oi.order_id = p_order_id AND oi.item_id IS NOT NULL
    )
    SELECT c.ing_id AS cid, SUM(c.need) AS need, i.unit AS ing_unit
      FROM consumo c JOIN public.ingredients i ON i.id = c.ing_id
     GROUP BY c.ing_id, i.unit
    HAVING SUM(c.need) > 0
  LOOP
    UPDATE public.ingredients
       SET stock_quantity = GREATEST(0, stock_quantity - r.need),
           updated_at     = NOW()
     WHERE id = r.cid
       AND stock_quantity > 0;

    IF FOUND THEN
      INSERT INTO public.stock_movements (
        restaurant_id, ingredient_id, movement_type, quantity, unit, related_order_id
      ) VALUES (
        v_restaurant_id, r.cid, 'deduct', r.need, r.ing_unit, p_order_id
      );

      PERFORM public.check_stock_alert(r.cid, v_restaurant_id);
      PERFORM public.refresh_availability_for_ingredient(r.cid);
    END IF;
  END LOOP;
END;
$fn$;

-- ── Disponibilidad de un ítem ──
CREATE OR REPLACE FUNCTION public.check_menu_item_availability(p_menu_item_id INT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE v_name TEXT;
BEGIN
  SELECT i.name INTO v_name
    FROM public.explode_menu_item(p_menu_item_id) e
    JOIN public.ingredients i ON i.id = e.ing_id
   WHERE i.is_active = true
     AND e.qty_needed > i.stock_quantity
   LIMIT 1;

  IF v_name IS NOT NULL THEN
    RETURN json_build_object('available', false, 'reason', 'Sin stock: ' || v_name);
  END IF;
  RETURN json_build_object('available', true, 'reason', NULL);
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.check_menu_item_availability(INT) TO anon, authenticated;

-- ── Cargar stock: convierte, asienta el precio y recalcula el promedio ──
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
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_rid       UUID;
  v_ing_unit  stock_unit;
  v_stock_ant DECIMAL;
  v_avg_ant   DECIMAL;
  v_qty       DECIMAL;   -- cantidad cargada, en la unidad del ingrediente
  v_cost      DECIMAL;   -- costo de compra, por unidad del ingrediente
  v_new_avg   DECIMAL;
BEGIN
  SELECT i.restaurant_id, i.unit, i.stock_quantity, i.avg_cost
    INTO v_rid, v_ing_unit, v_stock_ant, v_avg_ant
    FROM public.ingredients i WHERE i.id = p_ingredient_id;

  -- Se conserva la clave `success` de la mig 181: es el contrato que ya devuelve
  -- esta RPC y renombrarla sería romper por gusto.
  IF v_rid IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Ingrediente no encontrado');
  END IF;

  v_qty := public.convert_units(p_quantity, p_unit, v_ing_unit);
  IF v_qty IS NULL THEN
    RETURN json_build_object('success', false,
      'error', 'La unidad de carga no es compatible con la del ingrediente');
  END IF;

  -- El costo se tipea en la unidad EN QUE SE COMPRÓ (₲/kg si cargó kg) y se lleva
  -- a la unidad del ingrediente. Sin esta conversión, comprar en kg un ingrediente
  -- medido en gramos multiplicaría el costo por 1.000.
  v_cost := public.convert_unit_cost(p_cost_per_unit, p_unit, v_ing_unit);

  -- Promedio ponderado móvil. Sin stock previo (o sin promedio previo) el costo de
  -- esta compra pasa a ser el promedio: no hay nada con qué promediar.
  IF v_cost IS NOT NULL THEN
    IF v_avg_ant IS NULL OR COALESCE(v_stock_ant, 0) <= 0 THEN
      v_new_avg := v_cost;
    ELSE
      v_new_avg := ((v_stock_ant * v_avg_ant) + (v_qty * v_cost)) / (v_stock_ant + v_qty);
    END IF;
  ELSE
    v_new_avg := v_avg_ant;
  END IF;

  UPDATE public.ingredients
     SET stock_quantity = stock_quantity + v_qty,
         expiry_date    = COALESCE(p_expiry_date, expiry_date),
         batch_id       = COALESCE(p_batch_id, batch_id),
         cost_per_unit  = COALESCE(v_cost, cost_per_unit),   -- última compra
         avg_cost       = v_new_avg,                         -- promedio ponderado
         updated_at     = NOW()
   WHERE id = p_ingredient_id;

  INSERT INTO public.stock_movements (
    restaurant_id, ingredient_id, movement_type, quantity, unit,
    unit_cost, total_cost, notes, performed_by
  ) VALUES (
    v_rid, p_ingredient_id, 'load', v_qty, v_ing_unit,
    v_cost, CASE WHEN v_cost IS NULL THEN NULL ELSE ROUND(v_cost * v_qty, 2) END,
    p_notes, auth.uid()
  );

  -- Cerrar las alertas abiertas y RE-evaluar: la mig 181 sólo las cerraba, así que
  -- una carga chica que no alcanzaba el umbral dejaba al ingrediente en falso "OK".
  -- Cerrar sin re-evaluar es peor que no cerrar.
  UPDATE public.stock_alerts SET resolved_at = NOW()
   WHERE ingredient_id = p_ingredient_id AND resolved_at IS NULL;

  PERFORM public.check_stock_alert(p_ingredient_id, v_rid);
  PERFORM public.refresh_availability_for_ingredient(p_ingredient_id);

  RETURN json_build_object(
    'success',    true,
    'loaded_qty', v_qty,
    'unit',       v_ing_unit,
    'unit_cost',  v_cost,
    'avg_cost',   v_new_avg
  );
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.admin_load_stock(UUID, DECIMAL, stock_unit, DATE, TEXT, DECIMAL, TEXT) TO authenticated;

-- ── Listar ingredientes: suma costo, merma y valorización de stock ──
-- Cambia el tipo de retorno → hay que dropear antes (CREATE OR REPLACE no puede).
DROP FUNCTION IF EXISTS public.admin_list_ingredients(UUID);
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
  avg_cost        DECIMAL,
  waste_pct       DECIMAL,
  stock_value     DECIMAL,
  is_active       BOOLEAN,
  stock_level     TEXT,
  projected_qty   DECIMAL,
  alert_count     BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
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
    ing.avg_cost,
    ing.waste_pct,
    ROUND(ing.stock_quantity * COALESCE(ing.avg_cost, ing.cost_per_unit, 0), 2) AS stock_value,
    ing.is_active,
    CASE
      WHEN ing.stock_quantity = 0 THEN 'sin_stock'
      WHEN ing.min_threshold > 0 AND ing.stock_quantity < ing.min_threshold * 0.5 THEN 'critico'
      WHEN ing.min_threshold > 0 AND ing.stock_quantity < ing.min_threshold * 1.5 THEN 'bajo'
      ELSE 'ok'
    END AS stock_level,
    ing.stock_quantity - COALESCE((
      SELECT SUM(e.qty_needed * oi.quantity)
        FROM public.order_items oi
        JOIN public.orders o ON o.id = oi.order_id
        CROSS JOIN LATERAL public.explode_menu_item(oi.item_id) e
       WHERE e.ing_id = ing.id
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
$fn$;
GRANT EXECUTE ON FUNCTION public.admin_list_ingredients(UUID) TO authenticated;


-- ════════════════════════════════════════════════════════════
-- §11 · Costeo, precio sugerido y rentabilidad
-- ════════════════════════════════════════════════════════════

-- ── Portero: quién puede ver costos y márgenes ──
-- El gate va en la BASE, no sólo escondiendo el botón del panel: cualquiera con
-- sesión puede llamar una RPC a mano. Mismo criterio que Marketing (mig 197).
CREATE OR REPLACE FUNCTION public.can_see_costs(p_restaurant_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_role TEXT;
  v_vis  BOOLEAN;
BEGIN
  v_role := public.get_my_role();
  IF v_role = 'superadmin' THEN RETURN true; END IF;
  IF p_restaurant_id IS NULL THEN RETURN false; END IF;

  IF p_restaurant_id NOT IN (SELECT public.get_my_company_restaurant_ids()) THEN
    RETURN false;
  END IF;

  IF v_role IN ('admin','owner') THEN RETURN true; END IF;

  IF v_role = 'gerente' THEN
    SELECT COALESCE(rs.costs_visible_to_gerente, false) INTO v_vis
      FROM public.restaurant_settings rs WHERE rs.restaurant_id = p_restaurant_id;
    RETURN COALESCE(v_vis, false);
  END IF;

  RETURN false;
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.can_see_costs(UUID) TO authenticated;


-- ── Costo interno (SIN portero) ──
-- Lo llaman el congelado de costos y los reportes, que ya validaron acceso. NO se
-- otorga a authenticated: la puerta pública es menu_item_cost(), que sí valida.
-- El congelado corre en el camino del pedido, donde el llamador puede ser anon.
CREATE OR REPLACE FUNCTION public._menu_item_cost(p_menu_item_id INT)
RETURNS DECIMAL
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
  SELECT COALESCE(SUM(e.qty_needed * COALESCE(i.avg_cost, i.cost_per_unit, 0)), 0)::DECIMAL
    FROM public.explode_menu_item(p_menu_item_id) e
    JOIN public.ingredients i ON i.id = e.ing_id;
$fn$;

CREATE OR REPLACE FUNCTION public._extra_cost(p_extra_id INT)
RETURNS DECIMAL
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
  SELECT COALESCE(SUM(e.qty_needed * COALESCE(i.avg_cost, i.cost_per_unit, 0)), 0)::DECIMAL
    FROM public.explode_extra(p_extra_id) e
    JOIN public.ingredients i ON i.id = e.ing_id;
$fn$;

-- ── Costo de un ítem (puerta pública, con portero) ──
CREATE OR REPLACE FUNCTION public.menu_item_cost(p_menu_item_id INT)
RETURNS DECIMAL
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE v_rid UUID;
BEGIN
  SELECT mi.restaurant_id INTO v_rid FROM public.menu_items mi WHERE mi.id = p_menu_item_id;
  IF NOT public.can_see_costs(v_rid) THEN RETURN NULL; END IF;
  RETURN public._menu_item_cost(p_menu_item_id);
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.menu_item_cost(INT) TO authenticated;


-- ── Costo de una preparación, por UNA unidad de su rendimiento ──
CREATE OR REPLACE FUNCTION public.prep_recipe_cost(p_prep_id UUID)
RETURNS DECIMAL
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_rid  UUID;
  v_unit stock_unit;
  v_cost DECIMAL;
BEGIN
  SELECT pr.restaurant_id, pr.yield_unit INTO v_rid, v_unit
    FROM public.prep_recipes pr WHERE pr.id = p_prep_id;
  IF NOT FOUND OR NOT public.can_see_costs(v_rid) THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(e.qty_needed * COALESCE(i.avg_cost, i.cost_per_unit, 0)), 0)
    INTO v_cost
    FROM public.explode_prep_recipe(p_prep_id, 1, v_unit, 0) e
    JOIN public.ingredients i ON i.id = e.ing_id;
  RETURN v_cost;
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.prep_recipe_cost(UUID) TO authenticated;


-- ── Ficha de costo: desglose línea por línea ──
-- El desglose es a nivel de LÍNEA DE RECETA (lo que el cocinero escribió), no a
-- nivel de ingrediente explotado: una preparación se muestra como una sola línea
-- con su costo, que es como se piensa un plato.
CREATE OR REPLACE FUNCTION public.menu_item_cost_breakdown(p_menu_item_id INT)
RETURNS TABLE (
  line_id     UUID,
  source_type TEXT,
  source_id   UUID,
  source_name TEXT,
  quantity    DECIMAL,
  unit        stock_unit,
  waste_pct   DECIMAL,
  gross_qty   DECIMAL,
  unit_cost   DECIMAL,
  line_cost   DECIMAL,
  is_costed   BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_rid    UUID;
  r        RECORD;
  v_gross  DECIMAL;
  v_cost   DECIMAL;
  v_missing INT;
BEGIN
  SELECT mi.restaurant_id INTO v_rid FROM public.menu_items mi WHERE mi.id = p_menu_item_id;
  IF NOT public.can_see_costs(v_rid) THEN RETURN; END IF;

  FOR r IN
    SELECT rc.id, rc.ingredient_id, rc.prep_recipe_id, rc.quantity_required, rc.unit AS rec_unit
      FROM public.recipes rc WHERE rc.menu_item_id = p_menu_item_id
     ORDER BY rc.created_at
  LOOP
    IF r.ingredient_id IS NOT NULL THEN
      SELECT n.qty_needed INTO v_gross
        FROM public._ingredient_need(r.ingredient_id, r.quantity_required, r.rec_unit) n;

      SELECT i.name, COALESCE(i.waste_pct,0), COALESCE(i.avg_cost, i.cost_per_unit)
        INTO source_name, waste_pct, unit_cost
        FROM public.ingredients i WHERE i.id = r.ingredient_id;

      line_id     := r.id;
      source_type := 'ingrediente';
      source_id   := r.ingredient_id;
      quantity    := r.quantity_required;
      unit        := r.rec_unit;
      gross_qty   := v_gross;
      line_cost   := COALESCE(v_gross, 0) * COALESCE(unit_cost, 0);
      is_costed   := (unit_cost IS NOT NULL) AND (v_gross IS NOT NULL);
      RETURN NEXT;

    ELSE
      -- Costo de la porción de preparación que consume este plato.
      SELECT COALESCE(SUM(e.qty_needed * COALESCE(i.avg_cost, i.cost_per_unit, 0)), 0),
             COUNT(*) FILTER (WHERE COALESCE(i.avg_cost, i.cost_per_unit) IS NULL)
        INTO v_cost, v_missing
        FROM public.explode_prep_recipe(r.prep_recipe_id, r.quantity_required, r.rec_unit, 1) e
        JOIN public.ingredients i ON i.id = e.ing_id;

      SELECT pr.name, COALESCE(pr.waste_pct,0) INTO source_name, waste_pct
        FROM public.prep_recipes pr WHERE pr.id = r.prep_recipe_id;

      line_id     := r.id;
      source_type := 'preparacion';
      source_id   := r.prep_recipe_id;
      quantity    := r.quantity_required;
      unit        := r.rec_unit;
      gross_qty   := NULL;   -- una preparación no sale del depósito: se explota
      unit_cost   := CASE WHEN COALESCE(r.quantity_required,0) > 0
                          THEN v_cost / r.quantity_required ELSE NULL END;
      line_cost   := v_cost;
      is_costed   := COALESCE(v_missing, 0) = 0;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.menu_item_cost_breakdown(INT) TO authenticated;


-- ── Tablero de costeo: todo el menú con margen y precio sugerido ──
-- El margen objetivo cascadea producto → categoría → local → 65%.
CREATE OR REPLACE FUNCTION public.menu_costing_report(p_restaurant_id UUID)
RETURNS TABLE (
  menu_item_id      INT,
  item_name         TEXT,
  category_name     TEXT,
  price             INT,
  cost              DECIMAL,
  food_cost_pct     DECIMAL,
  margin            DECIMAL,
  margin_pct        DECIMAL,
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
DECLARE v_default DECIMAL;
BEGIN
  IF NOT public.can_see_costs(p_restaurant_id) THEN RETURN; END IF;

  SELECT COALESCE(rs.default_target_margin_pct, 65) INTO v_default
    FROM public.restaurant_settings rs WHERE rs.restaurant_id = p_restaurant_id;
  v_default := COALESCE(v_default, 65);

  RETURN QUERY
  WITH base AS (
    SELECT
      mi.id,
      mi.name,
      mc.name AS cat_name,
      mi.price_guarani,
      public._menu_item_cost(mi.id) AS c,
      COALESCE(mi.target_margin_pct, mc.target_margin_pct, v_default) AS tgt,
      (SELECT COUNT(*) FROM public.recipes rc WHERE rc.menu_item_id = mi.id) AS lines,
      (SELECT COUNT(*)
         FROM public.explode_menu_item(mi.id) e
         JOIN public.ingredients i ON i.id = e.ing_id
        WHERE COALESCE(i.avg_cost, i.cost_per_unit) IS NULL) AS missing
    FROM public.menu_items mi
    LEFT JOIN public.menu_categories mc ON mc.id = mi.category_id
    WHERE mi.restaurant_id = p_restaurant_id
  )
  SELECT
    b.id,
    b.name,
    COALESCE(b.cat_name, 'Sin categoría'),
    b.price_guarani,
    ROUND(b.c, 2),
    CASE WHEN b.price_guarani > 0 THEN ROUND(b.c / b.price_guarani * 100, 2) END,
    ROUND(b.price_guarani - b.c, 2),
    CASE WHEN b.price_guarani > 0
         THEN ROUND((b.price_guarani - b.c) / b.price_guarani * 100, 2) END,
    ROUND(b.tgt, 2),
    -- Precio que deja exactamente el margen objetivo: costo / (1 - margen).
    CASE WHEN b.tgt < 100 AND b.c > 0 THEN ROUND(b.c / (1 - b.tgt / 100.0), 0) END,
    b.lines::INT,
    b.missing::INT,
    CASE
      WHEN b.lines = 0                              THEN 'sin_receta'
      WHEN b.missing > 0                            THEN 'costo_incompleto'
      WHEN b.price_guarani <= 0                     THEN 'sin_precio'
      WHEN b.c >= b.price_guarani                   THEN 'perdida'
      WHEN (b.price_guarani - b.c) / b.price_guarani * 100 < b.tgt THEN 'bajo_objetivo'
      ELSE 'ok'
    END
  FROM base b
  ORDER BY
    CASE
      WHEN b.lines = 0            THEN 3
      WHEN b.missing > 0          THEN 2
      WHEN b.c >= b.price_guarani THEN 0
      ELSE 1
    END,
    b.name;
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.menu_costing_report(UUID) TO authenticated;


-- ── Rentabilidad real del período (SERVER-SIDE) ──
-- El panel calculaba esto en el navegador sobre `orders` con .limit(500) y
-- order_items de los primeros 500 ids: un local que vende bien veía números que
-- empeoraban cuanto más vendía. Es el mismo error que ya arreglaron las migs 197,
-- 198, 200 y 211 — quinta vez. Acá se agrega del lado de la base sobre TODO el
-- historial del período.
--
-- Usa el costo CONGELADO en la venta (order_items.unit_cost) y cae al costo
-- vigente sólo para los pedidos anteriores a esta migración, que no lo tienen.
CREATE OR REPLACE FUNCTION public.profitability_report(
  p_restaurant_id UUID,
  p_from          TIMESTAMPTZ,
  p_to            TIMESTAMPTZ
)
RETURNS TABLE (
  menu_item_id  INT,
  item_name     TEXT,
  units         BIGINT,
  revenue       DECIMAL,
  cost          DECIMAL,
  margin        DECIMAL,
  margin_pct    DECIMAL,
  unit_margin   DECIMAL,
  cost_source   TEXT,
  menu_class    TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  IF NOT public.can_see_costs(p_restaurant_id) THEN RETURN; END IF;

  -- Sin tablas temporales: PostgreSQL rechaza DDL dentro de una función
  -- no-VOLATILE. Los promedios de la matriz salen de un CTE (`prom`).
  RETURN QUERY
  WITH lineas AS (
    SELECT
      oi.item_id,
      oi.item_name,
      oi.quantity,
      oi.total_price,
      -- Costo del ítem + el de sus extras (que hasta ahora costaban ₲0).
      COALESCE(
        oi.unit_cost,
        public._menu_item_cost(oi.item_id)
      ) AS u_cost,
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
      COALESCE(l.item_name, '—')                                     AS nm,
      SUM(l.quantity)::BIGINT                                        AS u,
      SUM(COALESCE(l.total_price, 0))::DECIMAL                       AS rev,
      SUM(COALESCE(l.u_cost,0) * l.quantity + l.extras_cost)::DECIMAL AS cst,
      BOOL_AND(l.frozen)                                             AS all_frozen,
      BOOL_OR(l.frozen)                                              AS any_frozen
    FROM lineas l
    GROUP BY l.item_id, COALESCE(l.item_name, '—')
  ),
  prom AS (
    SELECT AVG(a.u) AS au,
           AVG(CASE WHEN a.u > 0 THEN (a.rev - a.cst) / a.u END) AS am
      FROM agg a
  )
  SELECT
    a.item_id,
    a.nm,
    a.u,
    ROUND(a.rev, 2),
    ROUND(a.cst, 2),
    ROUND(a.rev - a.cst, 2),
    CASE WHEN a.rev > 0 THEN ROUND((a.rev - a.cst) / a.rev * 100, 2) END,
    CASE WHEN a.u   > 0 THEN ROUND((a.rev - a.cst) / a.u, 2) END,
    CASE WHEN a.all_frozen THEN 'congelado'
         WHEN a.any_frozen THEN 'mixto'
         ELSE 'actual' END,
    -- Ingeniería de menú (Kasavana-Smith): popularidad × margen de contribución,
    -- cada uno contra su promedio. Devuelve la clave; la etiqueta la pone el panel.
    CASE
      WHEN a.cst <= 0 AND a.rev <= 0 THEN 'sin_datos'
      WHEN a.u >= p.au AND COALESCE((a.rev - a.cst) / NULLIF(a.u,0), 0) >= COALESCE(p.am,0) THEN 'estrella'
      WHEN a.u >= p.au                                                                      THEN 'caballo'
      WHEN COALESCE((a.rev - a.cst) / NULLIF(a.u,0), 0) >= COALESCE(p.am,0)                 THEN 'enigma'
      ELSE 'perro'
    END
  FROM agg a CROSS JOIN prom p
  ORDER BY (a.rev - a.cst) DESC;
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.profitability_report(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;


-- ── Historial de precios de compra de un ingrediente ──
CREATE OR REPLACE FUNCTION public.ingredient_price_history(
  p_ingredient_id UUID, p_limit INT DEFAULT 24
)
RETURNS TABLE (
  moved_at   TIMESTAMPTZ,
  quantity   DECIMAL,
  unit       stock_unit,
  unit_cost  DECIMAL,
  total_cost DECIMAL,
  notes      TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE v_rid UUID;
BEGIN
  SELECT i.restaurant_id INTO v_rid FROM public.ingredients i WHERE i.id = p_ingredient_id;
  IF NOT public.can_see_costs(v_rid) THEN RETURN; END IF;

  RETURN QUERY
  SELECT sm.created_at, sm.quantity, sm.unit, sm.unit_cost, sm.total_cost, sm.notes
    FROM public.stock_movements sm
   WHERE sm.ingredient_id = p_ingredient_id
     AND sm.movement_type = 'load'
     AND sm.unit_cost IS NOT NULL
   ORDER BY sm.created_at DESC
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 24), 200));
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.ingredient_price_history(UUID, INT) TO authenticated;


-- ── Alerta de insumos que subieron de precio ──
-- "El tomate subió 22% este mes" + en qué platos pega. Un aumento de insumo que
-- nadie mira se come el margen en silencio.
CREATE OR REPLACE FUNCTION public.ingredient_price_alerts(
  p_restaurant_id UUID, p_days INT DEFAULT 60, p_min_pct DECIMAL DEFAULT 10
)
RETURNS TABLE (
  ingredient_id   UUID,
  ingredient_name TEXT,
  unit            stock_unit,
  old_cost        DECIMAL,
  new_cost        DECIMAL,
  change_pct      DECIMAL,
  affected_items  INT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  IF NOT public.can_see_costs(p_restaurant_id) THEN RETURN; END IF;

  RETURN QUERY
  WITH compras AS (
    SELECT sm.ingredient_id AS iid, sm.unit_cost, sm.created_at,
           ROW_NUMBER() OVER (PARTITION BY sm.ingredient_id ORDER BY sm.created_at DESC) AS rn_desc,
           ROW_NUMBER() OVER (PARTITION BY sm.ingredient_id ORDER BY sm.created_at ASC)  AS rn_asc
      FROM public.stock_movements sm
     WHERE sm.restaurant_id = p_restaurant_id
       AND sm.movement_type = 'load'
       AND sm.unit_cost IS NOT NULL
       AND sm.created_at >= NOW() - (COALESCE(p_days, 60) || ' days')::INTERVAL
  ),
  extremos AS (
    SELECT c.iid,
           MAX(CASE WHEN c.rn_asc  = 1 THEN c.unit_cost END) AS primero,
           MAX(CASE WHEN c.rn_desc = 1 THEN c.unit_cost END) AS ultimo,
           COUNT(*) AS n
      FROM compras c GROUP BY c.iid
  )
  SELECT
    e.iid,
    i.name,
    i.unit,
    ROUND(e.primero, 2),
    ROUND(e.ultimo, 2),
    ROUND((e.ultimo - e.primero) / NULLIF(e.primero, 0) * 100, 2),
    (SELECT COUNT(DISTINCT mi.id)::INT
       FROM public.menu_items mi
       JOIN public.explode_menu_item(mi.id) x ON x.ing_id = e.iid
      WHERE mi.restaurant_id = p_restaurant_id)
  FROM extremos e
  JOIN public.ingredients i ON i.id = e.iid
  WHERE e.n >= 2
    AND e.primero > 0
    AND (e.ultimo - e.primero) / e.primero * 100 >= COALESCE(p_min_pct, 10)
  ORDER BY (e.ultimo - e.primero) / NULLIF(e.primero, 0) DESC;
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.ingredient_price_alerts(UUID, INT, DECIMAL) TO authenticated;


-- ── Congelar el costo al cobrarse el pedido ──
-- Sin esto el margen histórico se recalcula con los costos de hoy: subir el precio
-- de la carne en agosto empeoraría retroactivamente el margen de marzo.
-- Se dispara SIEMPRE que el pedido pasa a 'paid', independientemente de si el
-- descuento automático de stock está prendido: son cosas distintas.
CREATE OR REPLACE FUNCTION public.freeze_order_costs(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  UPDATE public.order_items oi
     SET unit_cost = public._menu_item_cost(oi.item_id)
   WHERE oi.order_id = p_order_id
     AND oi.item_id IS NOT NULL
     AND oi.unit_cost IS NULL;

  UPDATE public.order_item_extras oie
     SET unit_cost = public._extra_cost(me.id)
    FROM public.order_items oi
    JOIN public.menu_item_extras me ON me.item_id = oi.item_id
   WHERE oie.order_item_id = oi.id
     AND me.name = oie.extra_name
     AND oi.order_id = p_order_id
     AND oie.unit_cost IS NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.trigger_freeze_costs_on_paid()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  IF NEW.status = 'paid' THEN
    -- Best-effort: un problema de costeo NUNCA puede frenar un cobro. Mismo
    -- criterio que el CRM en el camino del pedido (mig 196).
    BEGIN
      PERFORM public.freeze_order_costs(NEW.order_id);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_freeze_costs_on_paid ON public.order_status_history;
CREATE TRIGGER trg_freeze_costs_on_paid
  AFTER INSERT ON public.order_status_history
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_freeze_costs_on_paid();


-- ════════════════════════════════════════════════════════════
-- §12 · RLS y privilegios
-- ════════════════════════════════════════════════════════════
-- Recordatorio de la mig 210: desde que se cerró el ALTER DEFAULT PRIVILEGES,
-- `anon` YA NO hereda privilegios en las tablas nuevas. Acá eso es exactamente lo
-- que queremos — las recetas y los costos son el know-how y los números del
-- negocio — así que no se otorga nada a `anon` y se revoca explícito por las
-- dudas. `authenticated` sí conserva su default, que es lo que usan los paneles.

ALTER TABLE public.prep_recipes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prep_recipe_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extra_recipes     ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.prep_recipes      FROM anon;
REVOKE ALL ON public.prep_recipe_items FROM anon;
REVOKE ALL ON public.extra_recipes     FROM anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.prep_recipes      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.prep_recipe_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.extra_recipes     TO authenticated;

-- ── prep_recipes: scope por restaurante ──
DROP POLICY IF EXISTS "prep_recipes_auth" ON public.prep_recipes;
CREATE POLICY "prep_recipes_auth" ON public.prep_recipes
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

-- ── prep_recipe_items: sin restaurant_id → scope por su preparación ──
DROP POLICY IF EXISTS "prep_recipe_items_auth" ON public.prep_recipe_items;
CREATE POLICY "prep_recipe_items_auth" ON public.prep_recipe_items
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.prep_recipes pr
       WHERE pr.id = prep_recipe_id
         AND pr.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.prep_recipes pr
       WHERE pr.id = prep_recipe_id
         AND pr.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  );

-- ── extra_recipes: scope por el ítem dueño del extra ──
DROP POLICY IF EXISTS "extra_recipes_auth" ON public.extra_recipes;
CREATE POLICY "extra_recipes_auth" ON public.extra_recipes
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.menu_item_extras me
      JOIN public.menu_items mi ON mi.id = me.item_id
       WHERE me.id = extra_id
         AND mi.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.menu_item_extras me
      JOIN public.menu_items mi ON mi.id = me.item_id
       WHERE me.id = extra_id
         AND mi.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  );

-- ── REPONER recipes_auth (mig 104) ──
-- CRÍTICO: la policy original scopeaba la fila POR SU INGREDIENTE. Ahora una línea
-- de receta puede tener ingredient_id NULL y apuntar a una preparación: con la
-- policy vieja esas filas serían invisibles E ININSERTABLES, y las sub-recetas no
-- funcionarían sin un solo mensaje de error que lo explique.
DROP POLICY IF EXISTS "recipes_auth" ON public.recipes;
CREATE POLICY "recipes_auth" ON public.recipes
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.ingredients i
       WHERE i.id = ingredient_id
         AND i.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
    OR EXISTS (
      SELECT 1 FROM public.prep_recipes pr
       WHERE pr.id = prep_recipe_id
         AND pr.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  )
  WITH CHECK (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.ingredients i
       WHERE i.id = ingredient_id
         AND i.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
    OR EXISTS (
      SELECT 1 FROM public.prep_recipes pr
       WHERE pr.id = prep_recipe_id
         AND pr.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  );

-- ── Realtime ──
-- La ficha de costo tiene que reaccionar cuando alguien carga stock más caro.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'prep_recipes'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.prep_recipes;
  END IF;
END $$;


-- ════════════════════════════════════════════════════════════
-- §13 · Verificación (informativa, no falla la migración)
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_ing_sin_costo INT;
  v_items_sin_rec INT;
BEGIN
  SELECT COUNT(*) INTO v_ing_sin_costo
    FROM public.ingredients WHERE is_active AND COALESCE(avg_cost, cost_per_unit) IS NULL;
  SELECT COUNT(*) INTO v_items_sin_rec
    FROM public.menu_items mi
   WHERE NOT EXISTS (SELECT 1 FROM public.recipes r WHERE r.menu_item_id = mi.id);

  RAISE NOTICE 'Migración 213 aplicada.';
  RAISE NOTICE '  Ingredientes activos sin costo cargado: %', v_ing_sin_costo;
  RAISE NOTICE '  Ítems del menú sin receta: %', v_items_sin_rec;
  RAISE NOTICE '  (Ambos son normales el día uno: el costeo se llena cargando';
  RAISE NOTICE '   precios de compra y recetas desde Admin > Stock > Costos.)';
END $$;


-- ════════════════════════════════════════════════════════════
-- §14 · Cerrar el EXECUTE por defecto de las funciones nuevas
-- ════════════════════════════════════════════════════════════
-- OJO, esto no es una formalidad: en PostgreSQL `CREATE FUNCTION` otorga EXECUTE
-- a PUBLIC por defecto (a diferencia de las tablas, cuyo default cerró la mig
-- 210). Sin este bloque, `_menu_item_cost` sería llamable por `anon` y por un
-- gerente sin permiso, y el portero `can_see_costs` no defendería nada: alcanzaba
-- con saltear el wrapper y llamar la función interna. Los GRANT de arriba se
-- vuelven a otorgar acá después del REVOKE, en el orden correcto.

DO $$
DECLARE
  fn TEXT;
BEGIN
  -- Todo lo nuevo arranca cerrado para PUBLIC y anon.
  FOR fn IN
    SELECT p.oid::regprocedure::TEXT
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         '_ingredient_need','explode_prep_recipe','_explode_menu_item_raw',
         'explode_menu_item','_explode_extra_raw','explode_extra','ingredient_cost',
         'convert_unit_cost','can_see_costs','_menu_item_cost','_extra_cost',
         'menu_item_cost','prep_recipe_cost','menu_item_cost_breakdown',
         'menu_costing_report','profitability_report','ingredient_price_history',
         'ingredient_price_alerts','freeze_order_costs'
       )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon',   fn);
  END LOOP;

  -- Y se vuelve a abrir SÓLO lo que el panel necesita llamar directo.
  FOR fn IN
    SELECT p.oid::regprocedure::TEXT
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'explode_prep_recipe','explode_menu_item','explode_extra','ingredient_cost',
         'convert_unit_cost','can_see_costs','menu_item_cost','prep_recipe_cost',
         'menu_item_cost_breakdown','menu_costing_report','profitability_report',
         'ingredient_price_history','ingredient_price_alerts'
       )
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
  END LOOP;
END $$;

-- Las internas quedan sin EXECUTE para todos los roles del cliente. Sólo las
-- alcanzan las funciones SECURITY DEFINER de arriba, que corren como su dueño.
-- (`_ingredient_need` se usa dentro de menu_item_cost_breakdown, que ya validó.)

-- `check_menu_item_availability` es la excepción y sigue abierta a anon: la llama
-- el menú del QR para saber si un plato está disponible. No devuelve ni un costo.
GRANT EXECUTE ON FUNCTION public.check_menu_item_availability(INT) TO anon, authenticated;


-- ── Tres funciones de stock que estaban abiertas de más ──
-- No es deuda que trae esta migración, pero se agrava con ella y se cierra acá.
-- Las tres son SECURITY DEFINER, o sea corren como `postgres` y la RLS no las
-- filtra, y ninguna valida quién llama:
--
--   • `admin_list_ingredients(p_restaurant_id)` — recibe el restaurante COMO
--     PARÁMETRO. Con la anon key y un UUID de local cualquiera devolvía el
--     inventario completo de ese local; desde esta migración devuelve además el
--     costo promedio y el valor del depósito. Es el know-how del negocio.
--   • `admin_load_stock(...)` — cargar stock de cualquier ingrediente de
--     cualquier local.
--   • `deduct_stock_for_order(order_id)` — NO es idempotente: llamarla dos veces
--     descuenta dos veces. La dispara un trigger; nadie la llama desde el front.
--
-- El REVOKE es seguro: las tres se usan sólo desde el panel Admin (autenticado),
-- salvo `deduct_stock_for_order`, que la invoca `trigger_deduct_stock_on_status_history`
-- — y esa es SECURITY DEFINER, así que corre como su dueño y conserva el EXECUTE.
DO $$
DECLARE fn TEXT;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure::TEXT
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('admin_list_ingredients','admin_load_stock','deduct_stock_for_order')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon',   fn);
  END LOOP;
END $$;

-- El panel Admin las necesita; `deduct_stock_for_order` NO se otorga a nadie.
GRANT EXECUTE ON FUNCTION public.admin_list_ingredients(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_load_stock(UUID, DECIMAL, stock_unit, DATE, TEXT, DECIMAL, TEXT) TO authenticated;
