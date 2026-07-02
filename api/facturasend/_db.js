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
