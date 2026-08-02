// ════════════════════════════════════════════════════════════════════
// MYTHOS — CRM de clientes. FUENTE ÚNICA para todos los paneles.
// ────────────────────────────────────────────────────────────────────
// POR QUÉ EXISTE ESTE MÓDULO
//   Hasta la mig 196 no había forma de dar de alta un cliente: los datos se
//   escribían sueltos en cada `orders` (customer_name / customer_phone / …) y
//   el "CRM" del Admin era una vista derivada que agrupaba pedidos POR NOMBRE.
//   Un mismo cliente que tipeaba su nombre distinto eran dos clientes, y no se
//   podía marcar a nadie como VIP (VIP/Frecuente se calculaban por monto y
//   cantidad de pedidos). Ahora existe la tabla `customers` y esto es lo único
//   que la toca; ningún panel arma sus propias queries de cliente.
//
// LA IDENTIDAD DEL CLIENTE ES EL TELÉFONO
//   Un cliente escribe su nombre de diez maneras, pero su número es el mismo.
//   `phone_digits` es una columna GENERATED en la DB (solo dígitos) con índice
//   único parcial por local, y `phoneKey()` acá replica esa normalización para
//   poder comparar del lado del cliente sin ir a la base.
//
// DOS CAMINOS DE ESCRITURA, A PROPÓSITO
//   · staff (caja/mozo/admin, rol authenticated) → escribe la tabla directo,
//     con RLS tenant-scoped. Puede todo: crear, editar, borrar, clasificar.
//   · comensal (QR/delivery, rol anon) → NO tiene acceso a la tabla; usa la RPC
//     `upsert_customer_self`, que solo rellena campos vacíos de su propia ficha
//     y nunca toca notas, estado ni tipos. Si no fuera así, cualquiera con la
//     anon key listaría la base de clientes del local (PII).
// ════════════════════════════════════════════════════════════════════

// ── Normalización ────────────────────────────────────────────────────

/**
 * Clave de identidad del cliente: solo los dígitos del teléfono.
 * Espeja `customers.phone_digits` (GENERATED en la DB). Devuelve '' si el
 * número no llega a 6 dígitos — por debajo de eso el match es basura
 * (un interno de 3 cifras haría colisionar a media ciudad).
 */
export function phoneKey(phone) {
  const d = String(phone == null ? '' : phone).replace(/\D/g, '');
  return d.length >= 6 ? d : '';
}

/** ¿Este teléfono sirve para identificar a alguien? */
export function isValidPhone(phone) { return phoneKey(phone) !== ''; }

/** Nombre completo tal como lo arma la DB (columna generada `full_name`). */
export function fullName(c) {
  if (!c) return '';
  if (c.full_name) return c.full_name;
  return `${(c.first_name || '').trim()} ${(c.last_name || '').trim()}`.trim();
}

/**
 * Parte un nombre tipeado de una sola caja ("Juan Carlos Pérez") en
 * nombre + apellido. Se usa para migrar datos viejos y en los formularios
 * donde solo hay un campo (caja mostrador). La primera palabra es el nombre;
 * el resto, el apellido.
 */
export function splitName(nombre) {
  const s = String(nombre || '').trim().replace(/\s+/g, ' ');
  if (!s) return { first_name: '', last_name: '' };
  const i = s.indexOf(' ');
  if (i < 0) return { first_name: s, last_name: '' };
  return { first_name: s.slice(0, i), last_name: s.slice(i + 1) };
}

/** Formato paraguayo legible: 0981 123 456 / +595 981 123 456. */
export function formatPhone(phone) {
  const d = String(phone == null ? '' : phone).replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10 && d.startsWith('0')) return `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
  if (d.length === 12 && d.startsWith('595')) return `+595 ${d.slice(3, 6)} ${d.slice(6, 9)} ${d.slice(9)}`;
  return String(phone);
}

/**
 * Valida CI o RUC paraguayo con criterio DELIBERADAMENTE laxo: el documento es
 * OPCIONAL en toda la app y rechazar un dato real por una regla de más es peor
 * que aceptar uno raro. Solo exige dígitos suficientes; el RUC admite el guión
 * del dígito verificador (80012345-6).
 */
export function validateDoc(docType, docNumber) {
  const raw = String(docNumber || '').trim();
  if (!raw) return { ok: true };                       // opcional: vacío es válido
  if (!/^[\d.\-]+$/.test(raw)) return { ok: false, error: 'Solo números (y guión en el RUC)' };
  const d = raw.replace(/\D/g, '');
  if (docType === 'ruc') {
    if (d.length < 6 || d.length > 12) return { ok: false, error: 'El RUC tiene entre 6 y 12 dígitos' };
  } else {
    if (d.length < 5 || d.length > 10) return { ok: false, error: 'La cédula tiene entre 5 y 10 dígitos' };
  }
  return { ok: true };
}

/** Email opcional: si viene, que al menos tenga forma de email. */
export function validateEmail(email) {
  const s = String(email || '').trim();
  if (!s) return { ok: true };
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? { ok: true } : { ok: false, error: 'Correo inválido' };
}

/**
 * Valida la ficha completa antes de guardar. Único requisito duro: el nombre.
 * Todo lo demás es opcional por diseño — en un mostrador lleno nadie completa
 * ocho campos, y una ficha con nombre y teléfono ya sirve.
 */
export function validateCustomer(f) {
  if (!f || !String(f.first_name || '').trim()) return { ok: false, error: 'El nombre es obligatorio' };
  const d = validateDoc(f.doc_type, f.doc_number);
  if (!d.ok) return d;
  const e = validateEmail(f.email);
  if (!e.ok) return e;
  if (f.phone && !isValidPhone(f.phone)) return { ok: false, error: 'El teléfono necesita al menos 6 dígitos' };
  return { ok: true };
}

/**
 * Resuelve nombre/apellido según cómo los mande cada panel, que no es uniforme:
 *   · Admin/Caja → ya vienen separados en `first_name`/`last_name`.
 *   · Delivery   → un campo "nombre" + un campo "apellido" aparte.
 *   · QR/mostrador → un único campo con todo junto.
 * El caso del medio es el que hay que cuidar: si se parte `name` igual, "Juan
 * Carlos" + apellido "Pérez" terminaría como Juan / Carlos y se pierde el apellido.
 */
function nameParts(form) {
  if (form.first_name) return { first_name: form.first_name, last_name: form.last_name || '' };
  if (form.last_name)  return { first_name: form.name || '', last_name: form.last_name };
  return splitName(form.name);
}

/** Ficha en blanco para los formularios de alta. */
export function emptyCustomer(extra) {
  return {
    first_name: '', last_name: '', phone: '', doc_type: 'ci', doc_number: '',
    email: '', address: '', address_reference: '', birth_date: '', notes: '',
    type_ids: [], ...(extra || {}),
  };
}

// Campos que viajan a la tabla `customers` (el resto son de UI o calculados).
const WRITABLE = ['first_name', 'last_name', 'phone', 'doc_type', 'doc_number',
                  'email', 'address', 'address_reference', 'birth_date', 'notes', 'is_active'];

function toRow(f) {
  const row = {};
  WRITABLE.forEach(k => {
    if (f[k] === undefined) return;
    const v = typeof f[k] === 'string' ? f[k].trim() : f[k];
    row[k] = (v === '' ? null : v);
  });
  // doc_type sin número no significa nada; y un número sin tipo se asume CI.
  if (!row.doc_number) row.doc_type = null;
  else if (!row.doc_type) row.doc_type = 'ci';
  return row;
}

export const SELECT_COLS =
  'id,restaurant_id,first_name,last_name,full_name,phone,phone_digits,doc_type,doc_number,' +
  'email,address,address_reference,birth_date,notes,source,is_active,created_at,updated_at';

// ── Detección de "el CRM todavía no está" ────────────────────────────
// La mig 196 se aplica a mano en Supabase. Hasta entonces la tabla no existe y
// PostgREST devuelve PGRST205/42P01. Los paneles usan esto para mostrar un
// aviso claro en vez de un error críptico, y para no romper el flujo de cobro.
export function isMissingCrm(error) {
  if (!error) return false;
  const s = `${error.message || ''} ${error.code || ''} ${error.details || ''}`;
  return /PGRST20[45]|42P01|42883|does not exist|schema cache/i.test(s);
}

export const CRM_MISSING_MSG =
  'El módulo de clientes todavía no está activo en la base — falta aplicar la migración 196.';

// ── Tipos de cliente ─────────────────────────────────────────────────

/** Catálogo de tipos del local, en su orden configurado. */
export async function loadTypes(db, restaurantId) {
  if (!db || !restaurantId) return { types: [], error: null };
  const { data, error } = await db.from('customer_types')
    .select('id,name,color,sort_order,is_seeded')
    .eq('restaurant_id', restaurantId)
    .order('sort_order').order('name');
  if (error) return { types: [], error };
  return { types: data || [], error: null };
}

export async function createType(db, restaurantId, { name, color, sort_order }) {
  const { data, error } = await db.from('customer_types')
    .insert({ restaurant_id: restaurantId, name: String(name || '').trim(),
              color: color || '#8E8E93', sort_order: sort_order == null ? 100 : sort_order })
    .select('id,name,color,sort_order,is_seeded').single();
  return { type: data || null, error };
}

export async function updateType(db, id, patch) {
  const { data, error } = await db.from('customer_types')
    .update(patch).eq('id', id).select('id,name,color,sort_order,is_seeded').single();
  return { type: data || null, error };
}

/** Borra un tipo. Los `customer_type_links` caen solos por ON DELETE CASCADE. */
export async function deleteType(db, id) {
  const { error } = await db.from('customer_types').delete().eq('id', id);
  return { error };
}

// ── Lectura de clientes ──────────────────────────────────────────────

/**
 * Todos los clientes del local con sus tipos ya resueltos.
 * Dos queries en vez de un join anidado de PostgREST: la relación es N-a-N y el
 * embed devuelve una forma anidada distinta según haya o no FK detectada, lo que
 * obliga a normalizar igual. Así es explícito y no depende de la introspección.
 */
export async function loadCustomers(db, restaurantId, { includeInactive = false } = {}) {
  if (!db || !restaurantId) return { customers: [], error: null };
  let q = db.from('customers').select(SELECT_COLS).eq('restaurant_id', restaurantId);
  if (!includeInactive) q = q.eq('is_active', true);
  const { data, error } = await q.order('full_name');
  if (error) return { customers: [], error };

  const list = data || [];
  const byId = new Map(list.map(c => [c.id, { ...c, type_ids: [] }]));
  if (list.length) {
    const { data: links } = await db.from('customer_type_links')
      .select('customer_id,type_id')
      .in('customer_id', list.map(c => c.id));
    (links || []).forEach(l => { const c = byId.get(l.customer_id); if (c) c.type_ids.push(l.type_id); });
  }
  return { customers: Array.from(byId.values()), error: null };
}

/**
 * Buscador para el picker de caja/mozo: nombre, teléfono, documento o email.
 * `limit` chico a propósito — es un autocompletado, no un listado.
 */
export async function searchCustomers(db, restaurantId, term, { limit = 12 } = {}) {
  if (!db || !restaurantId) return { customers: [], error: null };
  const t = String(term || '').trim();
  let q = db.from('customers').select(SELECT_COLS)
    .eq('restaurant_id', restaurantId).eq('is_active', true);
  if (t) {
    const digits = t.replace(/\D/g, '');
    const like = t.replace(/[%,()]/g, ' ');
    const ors = [`full_name.ilike.%${like}%`, `email.ilike.%${like}%`, `doc_number.ilike.%${like}%`];
    if (digits.length >= 3) ors.push(`phone_digits.ilike.%${digits}%`);
    q = q.or(ors.join(','));
  }
  const { data, error } = await q.order('full_name').limit(limit);
  return { customers: data || [], error };
}

/** Busca por teléfono exacto. Es el atajo para "¿este número ya es cliente?". */
export async function findByPhone(db, restaurantId, phone) {
  const key = phoneKey(phone);
  if (!db || !restaurantId || !key) return { customer: null, error: null };
  const { data, error } = await db.from('customers').select(SELECT_COLS)
    .eq('restaurant_id', restaurantId).eq('phone_digits', key).maybeSingle();
  return { customer: data || null, error };
}

/** Historial de pedidos de una ficha (para el detalle del cliente en Admin). */
export async function loadCustomerOrders(db, customerId, { limit = 100 } = {}) {
  if (!db || !customerId) return { orders: [], error: null };
  const { data, error } = await db.from('orders')
    .select('id,order_number,order_type,status,total,created_at,requires_invoice,payment_method')
    .eq('customer_id', customerId)
    .not('status', 'in', '(draft,cancelled)')
    .order('created_at', { ascending: false }).limit(limit);
  return { orders: data || [], error };
}

// ── Escritura (staff) ────────────────────────────────────────────────

/** Reemplaza el set de tipos de un cliente por el que se pasa. */
async function syncTypes(db, customerId, typeIds) {
  if (!Array.isArray(typeIds)) return null;
  const { error: delErr } = await db.from('customer_type_links').delete().eq('customer_id', customerId);
  if (delErr) return delErr;
  if (!typeIds.length) return null;
  const { error } = await db.from('customer_type_links')
    .insert(typeIds.map(t => ({ customer_id: customerId, type_id: t })));
  return error || null;
}

/**
 * Alta desde un panel de staff. Si el teléfono ya existe en el local NO crea un
 * duplicado: devuelve la ficha existente con `existed:true` para que la UI diga
 * "este cliente ya estaba" en vez de estrellarse contra el índice único.
 */
export async function createCustomer(db, restaurantId, form, { source = 'admin', createdBy = null } = {}) {
  const v = validateCustomer(form);
  if (!v.ok) return { customer: null, error: { message: v.error } };

  const key = phoneKey(form.phone);
  if (key) {
    const { customer: dup } = await findByPhone(db, restaurantId, form.phone);
    if (dup) return { customer: dup, error: null, existed: true };
  }

  // Quién dio de alta la ficha sale de la sesión, no de lo que adivine cada
  // panel: `profile` no tiene la misma forma en caja, mozo y admin.
  let author = createdBy;
  if (!author) {
    try { const { data: u } = await db.auth.getUser(); author = u?.user?.id || null; } catch (_) { author = null; }
  }

  const { data, error } = await db.from('customers')
    .insert({ ...toRow(form), restaurant_id: restaurantId, source, created_by: author })
    .select(SELECT_COLS).single();
  if (error) return { customer: null, error };

  const tErr = await syncTypes(db, data.id, form.type_ids);
  return { customer: { ...data, type_ids: form.type_ids || [] }, error: null, typeError: tErr };
}

/** Edición desde un panel de staff. `form.type_ids` ausente = no tocar los tipos. */
export async function updateCustomer(db, id, form) {
  const v = validateCustomer(form);
  if (!v.ok) return { customer: null, error: { message: v.error } };

  const { data, error } = await db.from('customers')
    .update(toRow(form)).eq('id', id).select(SELECT_COLS).single();
  if (error) return { customer: null, error };

  const tErr = await syncTypes(db, id, form.type_ids);
  return { customer: { ...data, type_ids: form.type_ids || [] }, error: null, typeError: tErr };
}

/**
 * Baja de una ficha. Por defecto DESACTIVA (is_active=false) en vez de borrar:
 * los pedidos apuntan a la ficha y el historial del local es dato contable.
 * `hard:true` borra de verdad — los pedidos quedan con customer_id NULL
 * (ON DELETE SET NULL) y conservan su customer_name histórico.
 */
export async function deleteCustomer(db, id, { hard = false } = {}) {
  if (hard) {
    const { error } = await db.from('customers').delete().eq('id', id);
    return { error };
  }
  const { error } = await db.from('customers').update({ is_active: false }).eq('id', id);
  return { error };
}

export async function reactivateCustomer(db, id) {
  const { error } = await db.from('customers').update({ is_active: true }).eq('id', id);
  return { error };
}

/** Vincula un pedido ya creado a una ficha (caja/mozo, después del alta). */
export async function attachCustomerToOrder(db, orderId, customerId) {
  if (!db || !orderId || !customerId) return { error: null };
  const { error } = await db.from('orders').update({ customer_id: customerId }).eq('id', orderId);
  if (error) return { error };
  try { await db.from('delivery_orders').update({ customer_id: customerId }).eq('order_id', orderId); } catch (_) {}
  return { error: null };
}

// ── Escritura (comensal, rol anon) ───────────────────────────────────

/**
 * Alta/completado de la ficha DESDE EL CLIENTE (QR de mesa o delivery).
 * Pasa por la RPC `upsert_customer_self` porque anon no tiene acceso a la tabla.
 * Devuelve solo el uuid. Best-effort a propósito: el CRM nunca puede impedir
 * que entre un pedido, así que ante cualquier error devuelve null y sigue.
 */
export async function upsertSelf(db, restaurantId, form, source = 'qr') {
  if (!db || !restaurantId || !form) return null;
  const { first_name, last_name } = nameParts(form);
  if (!first_name && !phoneKey(form.phone)) return null;
  try {
    const { data, error } = await db.rpc('upsert_customer_self', {
      p_restaurant_id: restaurantId,
      p_first_name: (first_name || '').trim() || null,
      p_last_name: (last_name || '').trim() || null,
      p_phone: (form.phone || '').trim() || null,
      p_doc_type: form.doc_type || null,
      p_doc_number: (form.doc_number || '').trim() || null,
      p_email: (form.email || '').trim() || null,
      p_address: (form.address || '').trim() || null,
      p_address_reference: (form.address_reference || '').trim() || null,
      p_source: source,
    });
    if (error) return null;
    return data || null;
  } catch (_) { return null; }
}

/**
 * Bloque `customer` para el payload de `create_order`. Deja que la RPC haga el
 * upsert y el vínculo en la MISMA transacción del pedido — un round-trip menos
 * y sin ventana donde el pedido exista sin ficha.
 */
export function customerPayload(form, source) {
  if (!form) return undefined;
  const { first_name, last_name } = nameParts(form);
  if (!first_name && !phoneKey(form.phone)) return undefined;
  return {
    first_name: (first_name || '').trim() || null,
    last_name: (last_name || '').trim() || null,
    phone: (form.phone || '').trim() || null,
    doc_type: form.doc_type || null,
    doc_number: (form.doc_number || '').trim() || null,
    email: (form.email || '').trim() || null,
    address: (form.address || '').trim() || null,
    address_reference: (form.address_reference || '').trim() || null,
    source: source || 'qr',
  };
}

// ── Segmentación calculada (lo que el CRM ya mostraba) ───────────────
// Los tipos ASIGNADOS son del local; estos son los indicadores CALCULADOS que
// el Admin ya venía mostrando. Conviven: un cliente puede ser "VIP" porque el
// dueño lo marcó, y además dar "alto consumo" por su gasto del período.
export const VIP_THRESHOLD = 500000;
export const FREQUENT_MIN_ORDERS = 3;
export const INACTIVE_DAYS = 30;

/** Métricas de un cliente a partir de sus pedidos (los que ya tiene el panel). */
export function customerStats(orders) {
  const valid = (orders || []).filter(o => !['draft', 'cancelled'].includes(o.status));
  if (!valid.length) return { orders: 0, total: 0, ticket: 0, lastDate: null, firstDate: null, canalCount: {} };
  let total = 0, first = valid[0].created_at, last = valid[0].created_at;
  const canalCount = {};
  valid.forEach(o => {
    total += (o.total || 0);
    if (o.created_at < first) first = o.created_at;
    if (o.created_at > last) last = o.created_at;
    if (o.order_type) canalCount[o.order_type] = (canalCount[o.order_type] || 0) + 1;
  });
  return {
    orders: valid.length, total, ticket: Math.round(total / valid.length),
    firstDate: first, lastDate: last, canalCount,
    preferred: Object.entries(canalCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
  };
}
