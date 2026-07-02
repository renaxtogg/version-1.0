// ════════════════════════════════════════════════════════════════════
// Acceso server-only a fiscal_config con la SERVICE_ROLE key (bypassa RLS).
// ────────────────────────────────────────────────────────────────────
// fiscal_config tiene RLS deny-all para anon/authenticated (mig 137): sólo se
// puede leer/escribir con la service_role key, y SÓLO desde el server. Este
// helper habla PostgREST directamente con esa key. Nunca se loguea la key.
// ════════════════════════════════════════════════════════════════════

function rest() {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) throw new Error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el server');
  return { url, key };
}

// Columnas que el server necesita (incluye el ciphertext, NUNCA una key en claro).
const SELECT_COLS = [
  'restaurant_id', 'provider', 'tenant', 'environment',
  'api_key_ciphertext', 'api_key_iv', 'api_key_tag',
  'ruc', 'razon_social', 'timbrado', 'establecimiento', 'punto_expedicion',
  'actividad_economica', 'csc_id', 'csc', 'auto_email', 'kude_format', 'active', 'updated_at',
].join(',');

// Lee la fila de fiscal_config de un restaurante (o null si no existe).
export async function getFiscalConfig(restaurantId) {
  const { url, key } = rest();
  const r = await fetch(
    `${url}/rest/v1/fiscal_config?restaurant_id=eq.${encodeURIComponent(restaurantId)}&select=${SELECT_COLS}&limit=1`,
    { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' } },
  );
  if (!r.ok) throw new Error(`fiscal_config: lectura falló (HTTP ${r.status}) ${await r.text()}`);
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// Upsert (por restaurant_id) de una fila de fiscal_config. Devuelve la fila guardada.
export async function upsertFiscalConfig(row) {
  const { url, key } = rest();
  const r = await fetch(`${url}/rest/v1/fiscal_config?on_conflict=restaurant_id`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`fiscal_config: upsert falló (HTTP ${r.status}) ${await r.text()}`);
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// ════════════════════════════════════════════════════════════════════
// documentos_electronicos (mig 138) — emisión de DE. Todo server-only.
// ════════════════════════════════════════════════════════════════════

function svcHeaders(extra) {
  const { key } = rest();
  return { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json', ...(extra || {}) };
}

// Orden + items + extras para armar la factura. Acota por restaurant_id (defensa
// en profundidad, aunque service_role bypassa RLS). Devuelve la fila o null.
export async function getOrderForInvoice(restaurantId, orderId) {
  const { url } = rest();
  const select =
    'id,restaurant_id,order_number,order_type,status,payment_status,payment_method,' +
    'total,subtotal,discount_amount,coupon_code,customer_name,customer_ruc,customer_email,' +
    'requires_invoice,invoice_status,' +
    'order_items(id,item_id,item_name,quantity,unit_price,total_price,order_item_extras(extra_name,extra_price))';
  const r = await fetch(
    `${url}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}` +
    `&restaurant_id=eq.${encodeURIComponent(restaurantId)}&select=${encodeURIComponent(select)}&limit=1`,
    { headers: svcHeaders() },
  );
  if (!r.ok) throw new Error(`orders: lectura falló (HTTP ${r.status}) ${await r.text()}`);
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// DE MÁS RECIENTE para (restaurant_id, order_id, tipo_de). null si no hay.
// ORDER BY created_at DESC: desde la mig 139 una orden puede tener VARIAS filas
// (intentos ERROR/RECHAZADO históricos + el DE vivo, que es siempre el más nuevo),
// así que sin el orden se podría devolver la fila ERROR vieja (sin CDC) y reportar
// una factura válida como "no emitida". Espeja el ORDER BY del RPC reclamar_o_crear_de.
export async function getDocumentoByOrder(restaurantId, orderId, tipoDe) {
  const { url } = rest();
  const r = await fetch(
    `${url}/rest/v1/documentos_electronicos?restaurant_id=eq.${encodeURIComponent(restaurantId)}` +
    `&order_id=eq.${encodeURIComponent(orderId)}&tipo_de=eq.${encodeURIComponent(tipoDe)}` +
    `&select=*&order=created_at.desc&limit=1`,
    { headers: svcHeaders() },
  );
  if (!r.ok) throw new Error(`documentos_electronicos: lectura falló (HTTP ${r.status}) ${await r.text()}`);
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// Busca un DE por su CDC (acotado al restaurante). null si no existe.
export async function getDocumentoByCdc(restaurantId, cdc) {
  const { url } = rest();
  const r = await fetch(
    `${url}/rest/v1/documentos_electronicos?restaurant_id=eq.${encodeURIComponent(restaurantId)}` +
    `&cdc=eq.${encodeURIComponent(cdc)}&select=*&limit=1`,
    { headers: svcHeaders() },
  );
  if (!r.ok) throw new Error(`documentos_electronicos: lectura falló (HTTP ${r.status}) ${await r.text()}`);
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// Inserta una fila de documentos_electronicos. Lanza con `status` en el error
// para que el caller distinga el 409 del índice UNIQUE (doble emisión concurrente).
export async function insertDocumento(row) {
  const { url } = rest();
  const r = await fetch(`${url}/rest/v1/documentos_electronicos`, {
    method: 'POST',
    headers: svcHeaders({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const err = new Error(`documentos_electronicos: insert falló (HTTP ${r.status}) ${await r.text()}`);
    err.status = r.status;
    throw err;
  }
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// Actualiza una fila de documentos_electronicos por id. Devuelve la fila actualizada.
export async function updateDocumentoById(id, patch) {
  const { url } = rest();
  const r = await fetch(`${url}/rest/v1/documentos_electronicos?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: svcHeaders({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`documentos_electronicos: update falló (HTTP ${r.status}) ${await r.text()}`);
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// Reserva ATÓMICA del siguiente número de comprobante (RPC mig 138). Devuelve bigint.
export async function reservarNumero(restaurantId, tipoDe, establecimiento, punto) {
  const { url } = rest();
  const r = await fetch(`${url}/rest/v1/rpc/siguiente_numero_de`, {
    method: 'POST',
    headers: svcHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      p_restaurant_id: restaurantId, p_tipo_de: tipoDe,
      p_establecimiento: String(establecimiento), p_punto: String(punto),
    }),
  });
  if (!r.ok) throw new Error(`siguiente_numero_de: falló (HTTP ${r.status}) ${await r.text()}`);
  const val = await r.json();
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`siguiente_numero_de: número inválido (${JSON.stringify(val)})`);
  return n;
}

// Get-or-create ATÓMICO del DE vivo de una orden (RPC mig 139, con SELECT ...
// FOR UPDATE sobre la orden → sin carrera). Devuelve { doc, created }:
//   • created=false → ya existía un DE vivo (no se consumió número): NO re-emitir.
//   • created=true  → se creó un BORRADOR nuevo (número reservado): emitir.
export async function reclamarOCrearDe(restaurantId, orderId, tipoDe, establecimiento, punto) {
  const { url } = rest();
  const r = await fetch(`${url}/rest/v1/rpc/reclamar_o_crear_de`, {
    method: 'POST',
    headers: svcHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      p_restaurant_id: restaurantId, p_order_id: orderId, p_tipo_de: tipoDe,
      p_establecimiento: String(establecimiento), p_punto: String(punto),
    }),
  });
  if (!r.ok) {
    const err = new Error(`reclamar_o_crear_de: falló (HTTP ${r.status}) ${await r.text()}`);
    err.status = r.status;
    throw err;
  }
  const val = await r.json();
  // PostgREST devuelve el escalar jsonb directo, o lo envuelve en [{...}] según versión.
  const obj = Array.isArray(val) ? val[0] : val;
  if (!obj || !obj.doc || !obj.doc.id) {
    throw new Error(`reclamar_o_crear_de: respuesta inesperada (${JSON.stringify(val)})`);
  }
  return { doc: obj.doc, created: obj.created === true };
}

// Inserta una fila de fiscal_inutilizaciones (mig 139). Devuelve la fila guardada.
export async function insertInutilizacion(row) {
  const { url } = rest();
  const r = await fetch(`${url}/rest/v1/fiscal_inutilizaciones`, {
    method: 'POST',
    headers: svcHeaders({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`fiscal_inutilizaciones: insert falló (HTTP ${r.status}) ${await r.text()}`);
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
