// ════════════════════════════════════════════════════════════════════
// Autorización por SESIÓN de staff (server-only) para los endpoints fiscales
// que dispara el personal autenticado (emitir-caja, y kude/email desde caja).
// ────────────────────────────────────────────────────────────────────
// El cliente NUNCA usa esto (ni el secret). El staff manda su access_token de
// Supabase en Authorization: Bearer <token>. Acá:
//   1) verificamos el token contra /auth/v1/user (firma + expiración reales; NO
//      se decodifica el JWT localmente — un payload sin verificar es falsificable),
//   2) leemos sus roles ACTIVOS (service_role),
//   3) autorizamos para un restaurante si es superadmin, o staff (cajero/admin/
//      supervisor_local) del MISMO restaurante o de la misma EMPRESA (sucursales).
// El token nunca se loguea. Devuelve sólo un veredicto + callerId.
// ════════════════════════════════════════════════════════════════════

// Roles que pueden operar caja / emitir factura.
const STAFF_EMIT_ROLES = new Set(['cajero', 'admin', 'supervisor_local']);

function env() {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) throw new Error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el server');
  return { url, key };
}

// Extrae el token Bearer del request (o null).
export function bearerToken(req) {
  const h = (req.headers && (req.headers['authorization'] || req.headers['Authorization'])) || '';
  const s = String(h).trim();
  if (!s) return null;
  const m = /^Bearer\s+(.+)$/i.exec(s);
  return m ? m[1].trim() : s;
}

// company de un restaurante = COALESCE(parent_company_id, id).
function companyOf(row) {
  return row && (row.parent_company_id || row.id) || null;
}

/**
 * Autoriza al caller (por su access_token) para operar sobre restaurantId.
 * @returns {Promise<{authorized:boolean, callerId?:string, via?:string, reason?:string}>}
 */
export async function authorizeStaffForRestaurant(req, restaurantId) {
  if (!restaurantId) return { authorized: false, reason: 'sin_restaurant_id' };
  const token = bearerToken(req);
  if (!token) return { authorized: false, reason: 'sin_token' };

  const { url, key } = env();

  // 1) Verificar el token → callerId (firma + expiración en el server de Auth).
  let callerId = null;
  try {
    const r = await fetch(`${url}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: key },
    });
    if (!r.ok) return { authorized: false, reason: 'token_invalido' };
    const u = await r.json();
    callerId = u && u.id ? u.id : null;
  } catch (_) {
    return { authorized: false, reason: 'auth_error' };
  }
  if (!callerId) return { authorized: false, reason: 'token_invalido' };

  // 2) Roles ACTIVOS del caller.
  let roles = [];
  try {
    const r = await fetch(
      `${url}/rest/v1/user_roles?user_id=eq.${encodeURIComponent(callerId)}&is_active=eq.true&select=role,restaurant_id`,
      { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' } },
    );
    if (r.ok) roles = await r.json();
  } catch (_) { /* roles vacío → no autorizado */ }
  if (!Array.isArray(roles) || roles.length === 0) return { authorized: false, callerId, reason: 'sin_roles' };

  // superadmin → autorizado para cualquier restaurante.
  if (roles.some((r) => r.role === 'superadmin')) return { authorized: true, callerId, via: 'superadmin' };

  const staffRests = roles
    .filter((r) => STAFF_EMIT_ROLES.has(r.role) && r.restaurant_id)
    .map((r) => r.restaurant_id);
  if (staffRests.length === 0) return { authorized: false, callerId, reason: 'sin_rol_de_caja' };

  // Mismo restaurante (caso común).
  if (staffRests.includes(restaurantId)) return { authorized: true, callerId, via: 'restaurante' };

  // Misma empresa (sucursales): comparar company del pedido vs. companies del caller.
  try {
    const ids = Array.from(new Set([restaurantId, ...staffRests]));
    const r = await fetch(
      `${url}/rest/v1/restaurants?id=in.(${ids.map(encodeURIComponent).join(',')})&select=id,parent_company_id`,
      { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' } },
    );
    if (r.ok) {
      const rows = await r.json();
      const byId = new Map(rows.map((x) => [x.id, x]));
      const orderCompany = companyOf(byId.get(restaurantId));
      const callerCompanies = new Set(staffRests.map((rid) => companyOf(byId.get(rid))).filter(Boolean));
      if (orderCompany && callerCompanies.has(orderCompany)) {
        return { authorized: true, callerId, via: 'empresa' };
      }
    }
  } catch (_) { /* cae a no autorizado */ }

  return { authorized: false, callerId, reason: 'restaurante_ajeno' };
}

/**
 * Autoriza por EL SECRET de sandbox (pruebas) O por sesión de staff (caja).
 * Usado por kude/email: el cliente NUNCA los llama; el staff sí (sin el secret).
 * @returns {Promise<{authorized:boolean, via?:string, callerId?:string, reason?:string}>}
 */
export async function authorizeSecretOrStaff(req, restaurantId) {
  const secret = process.env.FACTURASEND_EMIT_SECRET;
  const auth = (req.headers && req.headers['authorization']) || '';
  if (secret && auth === `Bearer ${secret}`) return { authorized: true, via: 'secret' };
  return authorizeStaffForRestaurant(req, restaurantId);
}
