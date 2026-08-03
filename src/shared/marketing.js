// ════════════════════════════════════════════════════════════════════
// MYTHOS — Marketing: gift cards y promos automáticas. FUENTE ÚNICA.
// ────────────────────────────────────────────────────────────────────
// Mismo criterio que `clientes.js`: ningún panel arma sus propias queries de
// gift cards ni de promos. Admin las configura y emite, Caja las canjea, y el
// día que haya que sumar un canal más (el comensal comprándola desde el QR)
// se toca acá y no en cinco lugares.
//
// APAGADO POR DEFECTO — es el requisito, no un detalle
//   `restaurant_marketing_config` no se siembra: un local SIN FILA tiene todo
//   apagado, y los defaults de las columnas son `false`. Por eso `loadConfig()`
//   devuelve `DEFAULT_CONFIG` (todo en false) cuando no hay fila, y por eso
//   `enabled` nunca se infiere de "existe la tabla": se lee el flag.
//   La base repite el chequeo (`issue_gift_card` y `run_promo_engine` abortan
//   si el flag está en false), así que esconder el botón no es la única defensa.
//
// EL SALDO NO SE TOCA A MANO
//   Emitir y canjear pasan SIEMPRE por RPC (`issue_gift_card` / `redeem_gift_card`).
//   Un UPDATE de `balance` desde el navegador tendría dos problemas: dos cajas
//   canjeando a la vez pisarían el saldo (la RPC hace SELECT … FOR UPDATE), y el
//   libro mayor `gift_card_movements` quedaría desincronizado del saldo.
// ════════════════════════════════════════════════════════════════════

/** Config con todo apagado — lo que ve un local que nunca prendió nada. */
export const DEFAULT_CONFIG = {
  gift_cards_enabled: false,
  promos_enabled: false,
  gift_card_min_amount: 50000,
  gift_card_max_amount: 2000000,
  gift_card_valid_days: 365,
  gift_card_prefix: 'GC',
  gift_card_terms: '',
  promo_coupon_valid_days: 30,
};

/**
 * ¿Falta aplicar la migración 197? Mismo truco que `isMissingCrm` de
 * clientes.js: PostgREST devuelve PGRST205/42P01 mientras la tabla no exista,
 * y el panel prefiere decirlo con todas las letras antes que mostrar un error
 * críptico o —peor— hacer de cuenta que el módulo está apagado.
 */
export function isMissingMarketing(error) {
  if (!error) return false;
  const s = `${error.message || ''} ${error.code || ''} ${error.details || ''}`;
  return /PGRST20[45]|42P01|42883|does not exist|schema cache/i.test(s);
}

export const MARKETING_MISSING_MSG =
  'El módulo de Marketing (gift cards y promos) todavía no está activo en la base — falta aplicar la migración 197.';

// ── Configuración ────────────────────────────────────────────────────

export async function loadConfig(db, restaurantId) {
  if (!db || !restaurantId) return { config: { ...DEFAULT_CONFIG }, missing: false, error: null };
  const { data, error } = await db.from('restaurant_marketing_config')
    .select('*').eq('restaurant_id', restaurantId).maybeSingle();
  if (error) {
    return { config: { ...DEFAULT_CONFIG }, missing: isMissingMarketing(error), error };
  }
  // Sin fila = nunca se prendió nada. NO es un error: es el estado inicial.
  return { config: { ...DEFAULT_CONFIG, ...(data || {}) }, missing: false, error: null };
}

export async function saveConfig(db, restaurantId, patch) {
  const { data, error } = await db.from('restaurant_marketing_config')
    .upsert({ restaurant_id: restaurantId, ...patch }, { onConflict: 'restaurant_id' })
    .select('*').single();
  return { config: data ? { ...DEFAULT_CONFIG, ...data } : null, error };
}

// ── Gift cards ───────────────────────────────────────────────────────

export const GIFT_CARD_STATUS = {
  active:    { label: 'Activa',   color: '#34C759' },
  used:      { label: 'Usada',    color: '#8E8E93' },
  expired:   { label: 'Vencida',  color: '#FF9500' },
  cancelled: { label: 'Anulada',  color: '#FF3B30' },
};

/**
 * Una tarjeta con fecha de vencimiento pasada sigue con `status='active'` en la
 * base hasta que alguien la intenta canjear (ahí la RPC la marca `expired`).
 * Para la UI eso sería mentir, así que el vencimiento se resuelve al leer.
 */
export function effectiveStatus(card) {
  if (!card) return 'cancelled';
  if (card.status === 'active' && card.expires_at && card.expires_at < todayISO()) return 'expired';
  return card.status;
}

function todayISO() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function loadGiftCards(db, restaurantId, { limit = 300 } = {}) {
  if (!db || !restaurantId) return { cards: [], missing: false, error: null };
  const { data, error } = await db.from('gift_cards')
    .select('*').eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) return { cards: [], missing: isMissingMarketing(error), error };
  return { cards: data || [], missing: false, error: null };
}

export async function loadGiftCardMovements(db, giftCardId) {
  if (!db || !giftCardId) return { movements: [], error: null };
  const { data, error } = await db.from('gift_card_movements')
    .select('*').eq('gift_card_id', giftCardId).order('created_at', { ascending: false });
  return { movements: data || [], error };
}

/** Emisión. La RPC genera el código, valida min/max y deja el asiento contable. */
export async function issueGiftCard(db, restaurantId, form, { channel = 'admin' } = {}) {
  const amount = Number(form.amount) || 0;
  if (amount <= 0) return { card: null, error: { message: 'Ingresá el monto de la gift card' } };
  const { data, error } = await db.rpc('issue_gift_card', {
    payload: {
      restaurant_id: restaurantId,
      amount,
      purchaser_customer_id: form.purchaser_customer_id || null,
      purchaser_name:  (form.purchaser_name  || '').trim() || null,
      purchaser_phone: (form.purchaser_phone || '').trim() || null,
      recipient_name:  (form.recipient_name  || '').trim() || null,
      recipient_phone: (form.recipient_phone || '').trim() || null,
      recipient_email: (form.recipient_email || '').trim() || null,
      message:         (form.message         || '').trim() || null,
      paid_method:     (form.paid_method     || '').trim() || null,
      paid_reference:  (form.paid_reference  || '').trim() || null,
      expires_at:      form.expires_at || null,
      issued_channel:  channel,
    },
  });
  if (error) return { card: null, error };
  return { card: data || null, error: null };
}

/** Consulta de saldo sin tocar nada — lo que hace el cajero antes de canjear. */
export async function lookupGiftCard(db, restaurantId, code) {
  if (!db || !restaurantId || !String(code || '').trim()) {
    return { card: null, error: { message: 'Ingresá el código de la gift card' } };
  }
  const { data, error } = await db.rpc('lookup_gift_card', {
    p_restaurant_id: restaurantId, p_code: String(code).trim(),
  });
  if (error) return { card: null, error };
  if (!data || data.ok !== true) return { card: null, error: { message: data?.error || 'Gift card inválida' } };
  return { card: data, error: null };
}

/**
 * Canje. Devuelve `applied` (lo aplicado) y `balance` (lo que queda).
 *
 * `allowPartial:false` es TODO O NADA y es lo que usa Caja: entre que el cajero
 * verifica el código y confirma el cobro, otra caja puede haber consumido saldo.
 * Si en ese momento se debitara "lo que haya", la tarjeta quedaría descontada por
 * un monto que ya no alcanza para el pedido y no hay forma de deshacerlo desde el
 * mostrador. Con todo-o-nada, ante una carrera no se toca un guaraní.
 */
export async function redeemGiftCard(db, restaurantId, code, amount,
                                     { orderId = null, note = null, allowPartial = true } = {}) {
  const { data, error } = await db.rpc('redeem_gift_card', {
    p_restaurant_id: restaurantId,
    p_code: String(code || '').trim(),
    p_amount: Number(amount) || 0,
    p_order_id: orderId,
    p_note: note,
    p_allow_partial: allowPartial,
  });
  if (error) return { result: null, error };
  if (!data || data.ok !== true) {
    return { result: null, error: { message: data?.error || 'No se pudo canjear', balance: data?.balance } };
  }
  return { result: data, error: null };
}

/** Anula una tarjeta (no se borra: es plata cobrada, tiene que quedar rastro). */
export async function cancelGiftCard(db, card, note) {
  const { error } = await db.from('gift_cards')
    .update({ status: 'cancelled' }).eq('id', card.id);
  if (error) return { error };
  await db.from('gift_card_movements').insert({
    gift_card_id: card.id, restaurant_id: card.restaurant_id, kind: 'cancel',
    amount: -Number(card.balance || 0), balance_after: 0,
    note: note || 'Anulada desde Admin',
  });
  return { error: null };
}

/** Texto listo para WhatsApp — es como llega de verdad una gift card acá. */
export function giftCardMessage(card, restaurantName, terms) {
  const monto = new Intl.NumberFormat('es-PY').format(Number(card.balance ?? card.initial_amount ?? 0));
  const vence = card.expires_at
    ? `\nVálida hasta el ${card.expires_at.split('-').reverse().join('/')}.` : '';
  const dedic = card.message ? `\n\n"${card.message}"` : '';
  return `🎁 ¡Tenés una gift card de ${restaurantName || 'nuestro local'}!\n\n`
       + `Código: *${card.code}*\nSaldo: ₲ ${monto}${vence}${dedic}\n\n`
       + `Mostrá este código al pagar.${terms ? `\n\n${terms}` : ''}`;
}

// ── Promos automáticas ───────────────────────────────────────────────

/**
 * Los disparadores, con el texto que ve el dueño. `unit` decide cómo se pide el
 * umbral en el formulario (un contador de visitas no se tipea como un monto en
 * guaraníes) y `usesPeriod` si la regla necesita una ventana de días.
 */
export const PROMO_TRIGGERS = [
  { id: 'visits',       label: 'Por cantidad de visitas',    unit: 'count', usesPeriod: false,
    help: 'Se premia al cliente cuando llega a esa cantidad de pedidos.',
    thresholdLabel: 'VISITAS NECESARIAS' },
  { id: 'spend_total',  label: 'Por monto gastado (total)',  unit: 'money', usesPeriod: false,
    help: 'Se premia cuando el gasto acumulado histórico supera ese monto.',
    thresholdLabel: 'MONTO ACUMULADO' },
  { id: 'spend_period', label: 'Por monto gastado en un período', unit: 'money', usesPeriod: true,
    help: 'Se premia cuando gasta ese monto dentro de la ventana de días indicada.',
    thresholdLabel: 'MONTO EN EL PERÍODO' },
  { id: 'first_order',  label: 'Bienvenida (primera compra)', unit: 'none',  usesPeriod: false,
    help: 'Se premia a quien hizo exactamente un pedido.',
    thresholdLabel: null },
  { id: 'inactive',     label: 'Cliente inactivo',           unit: 'none',  usesPeriod: true,
    help: 'Se premia a quien no vuelve hace más de esa cantidad de días, para traerlo de vuelta.',
    thresholdLabel: null },
  { id: 'birthday',     label: 'Cumpleaños',                 unit: 'none',  usesPeriod: true,
    help: 'Se premia a quien cumple años dentro de los próximos N días. Necesita la fecha cargada en la ficha.',
    thresholdLabel: null },
];

export const PROMO_REWARDS = [
  { id: 'percent',   label: '% de descuento',   unit: 'percent' },
  { id: 'fixed',     label: 'Descuento fijo ₲', unit: 'money' },
  { id: 'gift_card', label: 'Gift card ₲',      unit: 'money' },
];

export function triggerDef(id) { return PROMO_TRIGGERS.find(t => t.id === id) || PROMO_TRIGGERS[0]; }
export function rewardDef(id)  { return PROMO_REWARDS.find(r => r.id === id)  || PROMO_REWARDS[0]; }

/** Ficha en blanco de regla. Nace DESACTIVADA: crearla no es soltarla. */
export function emptyRule() {
  return {
    name: '', description: '', is_active: false,
    trigger_type: 'visits', threshold: 5, period_days: 30,
    reward_type: 'percent', reward_value: 10, min_order_amount: 0,
    coupon_prefix: 'PROMO', coupon_valid_days: 30,
    per_customer_limit: 1, max_awards: null,
    valid_from: '', valid_to: '',
  };
}

const RULE_COLS = ['name', 'description', 'is_active', 'trigger_type', 'threshold', 'period_days',
                   'reward_type', 'reward_value', 'min_order_amount', 'coupon_prefix',
                   'coupon_valid_days', 'per_customer_limit', 'max_awards', 'valid_from', 'valid_to'];

const NUMERIC_RULE_COLS = new Set(['threshold', 'period_days', 'reward_value', 'min_order_amount',
                                   'coupon_valid_days', 'per_customer_limit', 'max_awards']);

function ruleRow(form) {
  const row = {};
  RULE_COLS.forEach(k => {
    if (form[k] === undefined) return;
    let v = form[k];
    if (typeof v === 'string') v = v.trim();
    if (v === '') v = null;
    // `max_awards` nulo = sin tope. Los demás numéricos nunca van nulos porque
    // la columna es NOT NULL: un vacío se lee como cero.
    if (NUMERIC_RULE_COLS.has(k)) v = (v === null ? (k === 'max_awards' ? null : 0) : Number(v));
    row[k] = v;
  });
  return row;
}

export function validateRule(f) {
  if (!String(f.name || '').trim()) return { ok: false, error: 'Poné un nombre a la promo' };
  const t = triggerDef(f.trigger_type);
  if (t.thresholdLabel && !(Number(f.threshold) > 0)) {
    return { ok: false, error: `Indicá ${t.thresholdLabel.toLowerCase()}` };
  }
  if (t.usesPeriod && !(Number(f.period_days) > 0)) {
    return { ok: false, error: 'El período en días tiene que ser mayor a cero' };
  }
  if (!(Number(f.reward_value) > 0)) return { ok: false, error: 'La recompensa tiene que ser mayor a cero' };
  if (f.reward_type === 'percent' && Number(f.reward_value) > 100) {
    return { ok: false, error: 'Un descuento porcentual no puede pasar de 100%' };
  }
  if (f.valid_from && f.valid_to && f.valid_from > f.valid_to) {
    return { ok: false, error: 'La fecha de fin es anterior a la de inicio' };
  }
  return { ok: true };
}

export async function loadRules(db, restaurantId) {
  if (!db || !restaurantId) return { rules: [], missing: false, error: null };
  const { data, error } = await db.from('promo_rules')
    .select('*').eq('restaurant_id', restaurantId).order('created_at');
  if (error) return { rules: [], missing: isMissingMarketing(error), error };
  return { rules: data || [], missing: false, error: null };
}

export async function createRule(db, restaurantId, form) {
  const v = validateRule(form);
  if (!v.ok) return { rule: null, error: { message: v.error } };
  const { data, error } = await db.from('promo_rules')
    .insert({ ...ruleRow(form), restaurant_id: restaurantId }).select('*').single();
  return { rule: data || null, error };
}

export async function updateRule(db, id, form) {
  const v = validateRule(form);
  if (!v.ok) return { rule: null, error: { message: v.error } };
  const { data, error } = await db.from('promo_rules')
    .update(ruleRow(form)).eq('id', id).select('*').single();
  return { rule: data || null, error };
}

export async function toggleRule(db, id, isActive) {
  const { data, error } = await db.from('promo_rules')
    .update({ is_active: isActive }).eq('id', id).select('*').single();
  return { rule: data || null, error };
}

export async function deleteRule(db, id) {
  const { error } = await db.from('promo_rules').delete().eq('id', id);
  return { error };
}

/**
 * Corre el motor. Idempotente del lado de la base (respeta per_customer_limit y
 * max_awards), así que apretar el botón dos veces no reparte dos veces.
 */
export async function runPromoEngine(db, restaurantId) {
  const { data, error } = await db.rpc('run_promo_engine', { p_restaurant_id: restaurantId });
  if (error) return { result: null, error };
  if (!data || data.ok !== true) return { result: null, error: { message: data?.error || 'No se pudo evaluar' } };
  return { result: data, error: null };
}

/** Premios entregados, con el nombre del cliente y de la regla ya resueltos. */
export async function loadAwards(db, restaurantId, { limit = 300 } = {}) {
  if (!db || !restaurantId) return { awards: [], missing: false, error: null };
  const { data, error } = await db.from('promo_awards')
    .select('*').eq('restaurant_id', restaurantId)
    .order('awarded_at', { ascending: false }).limit(limit);
  if (error) return { awards: [], missing: isMissingMarketing(error), error };
  return { awards: data || [], missing: false, error: null };
}

/** Premios vigentes de UN cliente — se muestran en su ficha del CRM. */
export async function loadCustomerAwards(db, customerId) {
  if (!db || !customerId) return { awards: [], error: null };
  const { data, error } = await db.from('promo_awards')
    .select('*').eq('customer_id', customerId).order('awarded_at', { ascending: false });
  return { awards: data || [], error };
}

export function awardMessage(award, restaurantName) {
  const vence = award.expires_at
    ? ` Válido hasta el ${award.expires_at.split('-').reverse().join('/')}.` : '';
  const premio = award.reward_type === 'percent'
    ? `${Number(award.reward_value)}% de descuento`
    : award.reward_type === 'gift_card'
      ? `una gift card de ₲ ${new Intl.NumberFormat('es-PY').format(Number(award.reward_value))}`
      : `₲ ${new Intl.NumberFormat('es-PY').format(Number(award.reward_value))} de descuento`;
  return `🎉 ¡Tenemos algo para vos en ${restaurantName || 'nuestro local'}!\n\n`
       + `Ganaste ${premio}.\nCódigo: *${award.code}*${vence}\n\n¡Te esperamos!`;
}
