// ════════════════════════════════════════════════════════════════════
// MYTHOS — Costeo de productos y rentabilidad. FUENTE ÚNICA.
// ────────────────────────────────────────────────────────────────────
// Mismo criterio que `clientes.js` y `marketing.js`: ningún panel arma sus
// propias queries de costos. Admin costea y define márgenes, Gerente mira (si el
// dueño lo habilitó) y Reportes consume — todo por acá.
//
// TODO NÚMERO SALE DE LA BASE, NUNCA DE UN ARRAY DEL PANEL
//   Es la quinta vez que esta nota hace falta en el proyecto (migs 197, 198, 200
//   y 211 tuvieron que arreglar lo mismo). El reporte de Rentabilidad agrupaba en
//   el navegador sobre `orders` cargado con `.limit(500)` y los primeros 500 ids
//   de pedido: el margen que mostraba empeoraba cuanto MÁS vendía el local. Acá
//   todo pasa por `profitability_report()` / `menu_costing_report()`, que agregan
//   server-side sobre todo el historial del período.
//
// EL COSTO ES EL PROMEDIO PONDERADO, NO LA ÚLTIMA COMPRA
//   `ingredients.avg_cost` (mig 213) se recalcula en cada carga de stock con el
//   promedio móvil. `cost_per_unit` quedó como "precio de la última compra":
//   sirve para el historial y para detectar aumentos, NO para costear. Antes de
//   la 213 el costo se pisaba con cada compra y eso reescribía retroactivamente
//   el margen de todos los meses anteriores.
//
// LA MERMA YA VIENE APLICADA
//   Las recetas se cargan con el peso NETO (lo que va al plato) y la base agrega
//   la merma con factor 1/(1-merma) dentro de `explode_menu_item()`, que es la
//   MISMA función que usa el descuento de stock. Por eso el panel nunca vuelve a
//   multiplicar por la merma: hacerlo la aplicaría dos veces.
//
// EL PORTERO ESTÁ EN LA BASE
//   `can_see_costs()` decide quién ve costos (admin/owner siempre; gerente sólo
//   si `restaurant_settings.costs_visible_to_gerente`), y TODAS las RPC lo
//   consultan antes de devolver una fila. Esconder el botón nunca es la única
//   defensa: con una sesión válida cualquiera llama una RPC a mano.
// ════════════════════════════════════════════════════════════════════

/**
 * ¿Falta aplicar la migración 213? Mismo truco que `isMissingCrm` de
 * clientes.js: PostgREST devuelve PGRST202/205 o 42883 mientras la función no
 * exista. El panel lo dice con todas las letras en vez de mostrar un cero que se
 * leería como "este plato no cuesta nada".
 */
export function isMissingCosting(error) {
  if (!error) return false;
  const s = `${error.message || ''} ${error.code || ''} ${error.details || ''}`;
  return /PGRST20[245]|42P01|42883|does not exist|schema cache/i.test(s);
}

export const COSTING_MISSING_MSG =
  'El módulo de Costos todavía no está activo en la base — falta aplicar la migración 213.';

/** Estados que devuelve `menu_costing_report.status`, con su lectura humana. */
export const COST_STATUS = {
  ok:               { label: 'En objetivo',      tone: 'green',  hint: 'El margen llega al objetivo fijado.' },
  bajo_objetivo:    { label: 'Bajo objetivo',    tone: 'yellow', hint: 'Deja ganancia, pero menos de la que definiste.' },
  perdida:          { label: 'Pierde plata',     tone: 'red',    hint: 'Los insumos cuestan igual o más que el precio de venta.' },
  sin_receta:       { label: 'Sin receta',       tone: 'dim',    hint: 'Cargá su receta para poder costearlo.' },
  costo_incompleto: { label: 'Costo incompleto', tone: 'orange', hint: 'Algún insumo de la receta no tiene precio de compra cargado.' },
  sin_precio:       { label: 'Sin precio',       tone: 'dim',    hint: 'El ítem no tiene precio de venta.' },
};

/**
 * Ingeniería de menú (matriz de Kasavana-Smith): cruza cuánto se vende contra
 * cuánto deja cada unidad, cada uno comparado con el promedio del propio local.
 * Las claves las calcula la base; las etiquetas viven acá a propósito, igual que
 * `FORM_SPECS` (mig 198) y `EXP_COPY` (mig 204): reescribir un texto no puede
 * exigir una migración.
 */
export const MENU_CLASS = {
  estrella:  { label: 'Estrella',  tone: 'green',  hint: 'Se vende mucho y deja mucho. Cuidalo: no lo cambies ni le bajes la calidad.' },
  caballo:   { label: 'Caballo',   tone: 'yellow', hint: 'Se vende mucho pero deja poco. Subí el precio de a poco o bajá su costo.' },
  enigma:    { label: 'Enigma',    tone: 'orange', hint: 'Deja mucho pero casi no se vende. Promocionalo o dale mejor lugar en la carta.' },
  perro:     { label: 'Perro',     tone: 'red',    hint: 'Ni se vende ni deja. Candidato a salir de la carta.' },
  sin_datos: { label: 'Sin datos', tone: 'dim',    hint: 'Todavía no hay ventas o costos suficientes.' },
};

// ── Portero ──────────────────────────────────────────────────────────

/** ¿Este usuario puede ver costos en este restaurante? Lo decide la base. */
export async function canSeeCosts(db, restaurantId) {
  if (!db || !restaurantId) return { allowed: false, missing: false };
  const { data, error } = await db.rpc('can_see_costs', { p_restaurant_id: restaurantId });
  if (error) return { allowed: false, missing: isMissingCosting(error), error };
  return { allowed: !!data, missing: false, error: null };
}

// ── Tablero de costeo del menú ───────────────────────────────────────

/**
 * Todo el menú con su costo, margen, food cost % y precio sugerido.
 * Devuelve `[]` con `missing:true` si la 213 no está aplicada — nunca ceros,
 * que se leerían como "todos mis platos cuestan ₲0".
 */
export async function loadCostingReport(db, restaurantId) {
  if (!db || !restaurantId) return { rows: [], missing: false, error: null };
  const { data, error } = await db.rpc('menu_costing_report', { p_restaurant_id: restaurantId });
  if (error) return { rows: [], missing: isMissingCosting(error), error };
  return { rows: data || [], missing: false, error: null };
}

/** Desglose línea por línea de un plato — la ficha de costo. */
export async function loadBreakdown(db, menuItemId) {
  if (!db || !menuItemId) return { rows: [], missing: false, error: null };
  const { data, error } = await db.rpc('menu_item_cost_breakdown', { p_menu_item_id: menuItemId });
  if (error) return { rows: [], missing: isMissingCosting(error), error };
  return { rows: data || [], missing: false, error: null };
}

/** Costo de un solo ítem (para el editor de menú, que lo muestra en vivo). */
export async function loadItemCost(db, menuItemId) {
  if (!db || !menuItemId) return { cost: null, missing: false, error: null };
  const { data, error } = await db.rpc('menu_item_cost', { p_menu_item_id: menuItemId });
  if (error) return { cost: null, missing: isMissingCosting(error), error };
  return { cost: data === null || data === undefined ? null : Number(data), missing: false, error: null };
}

// ── Rentabilidad real del período ────────────────────────────────────

/**
 * Lo que REALMENTE dejó cada producto entre dos fechas, con el costo congelado
 * al momento de cada venta. `from`/`to` son ISO de timestamptz — usar los
 * helpers de `fecha.js` para armarlos, nunca `toISOString().slice(0,10)`.
 */
export async function loadProfitability(db, restaurantId, fromISO, toISO) {
  if (!db || !restaurantId) return { rows: [], missing: false, error: null };
  const { data, error } = await db.rpc('profitability_report', {
    p_restaurant_id: restaurantId, p_from: fromISO, p_to: toISO,
  });
  if (error) return { rows: [], missing: isMissingCosting(error), error };
  return { rows: data || [], missing: false, error: null };
}

// ── Historial y alertas de precio de insumos ─────────────────────────

export async function loadPriceHistory(db, ingredientId, limit = 24) {
  if (!db || !ingredientId) return { rows: [], missing: false, error: null };
  const { data, error } = await db.rpc('ingredient_price_history', {
    p_ingredient_id: ingredientId, p_limit: limit,
  });
  if (error) return { rows: [], missing: isMissingCosting(error), error };
  return { rows: data || [], missing: false, error: null };
}

/** "El tomate subió 22% y pega en 6 platos". Un aumento que nadie mira se come
 *  el margen en silencio. */
export async function loadPriceAlerts(db, restaurantId, days = 60, minPct = 10) {
  if (!db || !restaurantId) return { rows: [], missing: false, error: null };
  const { data, error } = await db.rpc('ingredient_price_alerts', {
    p_restaurant_id: restaurantId, p_days: days, p_min_pct: minPct,
  });
  if (error) return { rows: [], missing: isMissingCosting(error), error };
  return { rows: data || [], missing: false, error: null };
}

// ── Preparaciones intermedias (sub-recetas) ──────────────────────────

export async function loadPreps(db, restaurantId) {
  if (!db || !restaurantId) return { preps: [], missing: false, error: null };
  const { data, error } = await db.from('prep_recipes')
    .select('*, items:prep_recipe_items(*)')
    .eq('restaurant_id', restaurantId)
    .eq('is_active', true)
    .order('name');
  if (error) return { preps: [], missing: isMissingCosting(error), error };
  return { preps: data || [], missing: false, error: null };
}

export async function savePrep(db, restaurantId, prep) {
  const payload = {
    restaurant_id: restaurantId,
    name: (prep.name || '').trim(),
    yield_qty: Number(prep.yield_qty) || 1,
    yield_unit: prep.yield_unit || 'unit',
    waste_pct: Number(prep.waste_pct) || 0,
    notes: prep.notes || null,
  };
  if (prep.id) {
    const { data, error } = await db.from('prep_recipes')
      .update(payload).eq('id', prep.id).select('*').single();
    return { prep: data, error };
  }
  const { data, error } = await db.from('prep_recipes')
    .insert(payload).select('*').single();
  return { prep: data, error };
}

/** Baja lógica: una preparación borrada de verdad se llevaría por CASCADE las
 *  líneas de receta de los platos que la usan. */
export async function deactivatePrep(db, prepId) {
  const { error } = await db.from('prep_recipes')
    .update({ is_active: false }).eq('id', prepId);
  return { error };
}

export async function addPrepItem(db, prepRecipeId, item) {
  const { data, error } = await db.from('prep_recipe_items').insert({
    prep_recipe_id: prepRecipeId,
    ingredient_id: item.ingredient_id || null,
    child_prep_id: item.child_prep_id || null,
    quantity: Number(item.quantity) || 0,
    unit: item.unit || 'unit',
    notes: item.notes || null,
  }).select('*').single();
  return { item: data, error };
}

export async function removePrepItem(db, itemId) {
  const { error } = await db.from('prep_recipe_items').delete().eq('id', itemId);
  return { error };
}

/** Costo de UNA unidad del rendimiento de la preparación (ej: ₲/L de salsa). */
export async function loadPrepCost(db, prepId) {
  if (!db || !prepId) return { cost: null, missing: false, error: null };
  const { data, error } = await db.rpc('prep_recipe_cost', { p_prep_id: prepId });
  if (error) return { cost: null, missing: isMissingCosting(error), error };
  return { cost: data === null || data === undefined ? null : Number(data), missing: false, error: null };
}

// ── Recetas de extras ────────────────────────────────────────────────

export async function loadExtraRecipes(db, extraIds) {
  if (!db || !extraIds || extraIds.length === 0) return { rows: [], missing: false, error: null };
  const { data, error } = await db.from('extra_recipes').select('*').in('extra_id', extraIds);
  if (error) return { rows: [], missing: isMissingCosting(error), error };
  return { rows: data || [], missing: false, error: null };
}

export async function addExtraRecipe(db, extraId, line) {
  const { data, error } = await db.from('extra_recipes').insert({
    extra_id: extraId,
    ingredient_id: line.ingredient_id || null,
    prep_recipe_id: line.prep_recipe_id || null,
    quantity: Number(line.quantity) || 0,
    unit: line.unit || 'unit',
  }).select('*').single();
  return { row: data, error };
}

export async function removeExtraRecipe(db, id) {
  const { error } = await db.from('extra_recipes').delete().eq('id', id);
  return { error };
}

// ── Configuración de costos del local ────────────────────────────────

export const DEFAULT_COST_CONFIG = {
  default_target_margin_pct: 65,
  costs_visible_to_gerente: false,
};

export async function loadCostConfig(db, restaurantId) {
  if (!db || !restaurantId) return { config: { ...DEFAULT_COST_CONFIG }, missing: false, error: null };
  const { data, error } = await db.from('restaurant_settings')
    .select('default_target_margin_pct, costs_visible_to_gerente')
    .eq('restaurant_id', restaurantId).maybeSingle();
  if (error) return { config: { ...DEFAULT_COST_CONFIG }, missing: isMissingCosting(error), error };
  return { config: { ...DEFAULT_COST_CONFIG, ...(data || {}) }, missing: false, error: null };
}

export async function saveCostConfig(db, restaurantId, patch) {
  const { error } = await db.from('restaurant_settings')
    .upsert({ restaurant_id: restaurantId, ...patch }, { onConflict: 'restaurant_id' });
  return { error };
}

// ── Cálculo puro (sin base) ──────────────────────────────────────────
// Para el simulador: el dueño mueve el precio y ve el margen ANTES de guardar.
// Es aritmética local a propósito — pedirle a la base cada tecleo sería absurdo.

/** Margen ₲ y % que deja un precio dado, para un costo dado. */
export function marginAt(price, cost) {
  const p = Number(price) || 0, c = Number(cost) || 0;
  const margin = p - c;
  return { margin, marginPct: p > 0 ? (margin / p) * 100 : null, foodCostPct: p > 0 ? (c / p) * 100 : null };
}

/** Precio que deja exactamente el margen objetivo. Es `costo / (1 - margen)`,
 *  NO `costo * (1 + margen)`: eso último es el markup y da un número más chico,
 *  y confundirlos es el error clásico al fijar precios. */
export function priceForMargin(cost, targetPct) {
  const c = Number(cost) || 0, t = Number(targetPct);
  if (!(c > 0) || !Number.isFinite(t) || t >= 100 || t < 0) return null;
  return c / (1 - t / 100);
}

/** Markup: cuántas veces el costo es el precio. Lo que muchos llaman "x3". */
export function markup(price, cost) {
  const p = Number(price) || 0, c = Number(cost) || 0;
  return c > 0 ? p / c : null;
}
