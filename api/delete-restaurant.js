// ════════════════════════════════════════════════════════════════════════
// Vercel serverless — ELIMINACIÓN DEFINITIVA de un restaurante (superadmin)
// ────────────────────────────────────────────────────────────────────────
// Borra un restaurante y TODAS sus dependencias en una transacción (vía la RPC
// superadmin_delete_restaurant, mig 146) y, si se pide, también las cuentas de
// acceso (auth.users) exclusivas de ese restaurante, con la Admin API.
//
// PROTECCIONES (obligatorias):
//   • Solo superadmin: se valida el token del llamador y su rol (fail-closed).
//   • NUNCA se borra la cuenta protegida mancuellorenato@gmail.com ni ningún
//     usuario que sea superadmin o que tenga acceso a OTRO restaurante.
//   • El borrado de datos es atómico (la RPC hace todo en una transacción); si
//     algo falla ahí, no se borra nada. El borrado de cuentas auth es posterior
//     y best-effort: si alguna falla, el resto sigue y se reporta.
//   • service_role SOLO server-side (env). Nunca en el front.
// ════════════════════════════════════════════════════════════════════════
const https = require('https');
const { checkRateLimit } = require('./_ratelimit');

// Cuenta oficial protegida (CLAUDE.md) — jamás se toca.
const PROTECTED_EMAIL = 'mancuellorenato@gmail.com';

function httpsRequest(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers };
    if (data != null) h['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers: h },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = buf ? JSON.parse(buf) : null; } catch (_) { parsed = buf; }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: parsed });
        });
      }
    );
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}

function clean(v) { return (v == null ? '' : String(v)).replace(/^[﻿\s]+|[\s]+$/g, ''); }

module.exports = async function handler(req, res) {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://mythos.com.py';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }

  // Acción destructiva → rate-limit estricto.
  if (await checkRateLimit(req, res, { key: 'delete-restaurant', max: 5, windowSec: 60 })) return;

  const SUPABASE_URL = clean(process.env.SUPABASE_URL);
  const SERVICE_ROLE_KEY = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Servidor no configurado' }); return;
  }
  const svc = { 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY };

  try {
    // 1. Autenticar al llamador (firma + expiración, no se decodifica local).
    const authHeader = clean(req.headers['authorization']);
    if (!authHeader) { res.status(401).json({ error: 'No autenticado' }); return; }
    const bearer = /^Bearer\s+/i.test(authHeader) ? authHeader : `Bearer ${authHeader}`;
    const me = await httpsRequest('GET', `${SUPABASE_URL}/auth/v1/user`, { 'Authorization': bearer, 'apikey': SERVICE_ROLE_KEY });
    if (!me.ok || !me.data || !me.data.id) { res.status(401).json({ error: 'Token inválido o expirado' }); return; }
    const callerId = me.data.id;

    // 2. El llamador DEBE ser superadmin.
    const roleResp = await httpsRequest('GET',
      `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${callerId}&select=role&is_active=eq.true`, svc);
    const callerIsSuper = Array.isArray(roleResp.data) && roleResp.data.some(r => r.role === 'superadmin');
    if (!callerIsSuper) { res.status(403).json({ error: 'Solo el superadmin puede eliminar restaurantes' }); return; }

    // 3. Validar entrada.
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    // UUID a minúsculas canónicas: Postgres devuelve uuids en minúscula, así las
    // comparaciones case-sensitive en JS (p.ej. detección de otro tenant) coinciden.
    const restaurantId = clean(body.restaurant_id).toLowerCase();
    const confirmName  = typeof body.confirm_name === 'string' ? body.confirm_name.trim() : '';
    const deleteUsers  = body.delete_users === true;
    if (!/^[0-9a-f-]{36}$/i.test(restaurantId)) { res.status(400).json({ error: 'restaurant_id inválido' }); return; }

    // 4. Cargar el restaurante y confirmar el nombre exacto (doble-check server-side).
    const restResp = await httpsRequest('GET',
      `${SUPABASE_URL}/rest/v1/restaurants?id=eq.${restaurantId}&select=id,name`, svc);
    const rest = Array.isArray(restResp.data) ? restResp.data[0] : null;
    if (!rest) { res.status(404).json({ error: 'Restaurante inexistente' }); return; }
    if (!confirmName || confirmName !== (rest.name || '')) {
      res.status(400).json({ error: 'El nombre de confirmación no coincide con el del restaurante.' }); return;
    }

    // 5. Enumerar usuarios del restaurante y decidir cuáles se pueden borrar.
    //    Solo se borra un usuario si: no es la cuenta protegida, no es superadmin,
    //    y NO tiene acceso a ningún otro restaurante (borrar solo lo del objetivo).
    let usersToDelete = [], usersSkipped = [];
    if (deleteUsers) {
      const urResp = await httpsRequest('GET',
        `${SUPABASE_URL}/rest/v1/user_roles?restaurant_id=eq.${restaurantId}&select=user_id,email`, svc);
      const rows = Array.isArray(urResp.data) ? urResp.data : [];
      const seen = new Set();
      for (const row of rows) {
        const uid = row.user_id;
        if (!uid || seen.has(uid)) continue;
        seen.add(uid);
        const email = clean(row.email).toLowerCase();
        if (email && email === PROTECTED_EMAIL) { usersSkipped.push({ user_id: uid, reason: 'protegida' }); continue; }
        // Todas las filas de rol de ese usuario (para detectar superadmin u otros locales).
        const allRoles = await httpsRequest('GET',
          `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${uid}&select=role,restaurant_id`, svc);
        const rlist = Array.isArray(allRoles.data) ? allRoles.data : [];
        const isSuper = rlist.some(r => r.role === 'superadmin');
        const otherTenant = rlist.some(r => r.restaurant_id && r.restaurant_id !== restaurantId);
        if (isSuper)      { usersSkipped.push({ user_id: uid, reason: 'superadmin' }); continue; }
        if (otherTenant)  { usersSkipped.push({ user_id: uid, reason: 'tiene otro restaurante' }); continue; }

        // ⚠ GUARDA DE COMENSAL (mig 200). Hasta acá el usuario se evaluaba
        // mirando SÓLO su costado laboral. Desde que existe /clientes, una
        // persona = un usuario de Auth: el dueño que además usa la app comparte
        // el mismo `auth.users` entre `user_roles` y `diners`. Con la regla
        // vieja, eliminar un restaurante le destruía la CUENTA PERSONAL —
        // experiencia, historial y gift cards de OTROS locales que no tienen
        // nada que ver con el que se borró. Y es irreversible.
        //
        // Se le quitan los roles de staff (los borra la RPC de abajo) y se lo
        // deja como comensal. Fail-CLOSED a propósito: si la consulta falla no
        // se puede saber si tiene perfil, y ante la duda no se borra a nadie.
        let isDiner = null;
        try {
          const dinerResp = await httpsRequest('GET',
            `${SUPABASE_URL}/rest/v1/diners?auth_user_id=eq.${uid}&select=id&limit=1`, svc);
          if (dinerResp.ok) isDiner = Array.isArray(dinerResp.data) && dinerResp.data.length > 0;
          else if (dinerResp.status === 404) isDiner = false;   // mig 200 sin aplicar
        } catch (_) { isDiner = null; }
        if (isDiner === true)  { usersSkipped.push({ user_id: uid, reason: 'es comensal' }); continue; }
        if (isDiner === null)  { usersSkipped.push({ user_id: uid, reason: 'no se pudo verificar si es comensal' }); continue; }

        usersToDelete.push(uid);
      }
    }

    // 6. Borrado ATÓMICO de los datos (RPC; una sola transacción).
    //    Se reenvía el token del superadmin (Authorization) con la apikey de
    //    service_role: la RPC valida get_my_role()='superadmin' (o service_role
    //    como respaldo). El borrado ocurre en una transacción dentro de la RPC.
    const del = await httpsRequest('POST',
      `${SUPABASE_URL}/rest/v1/rpc/superadmin_delete_restaurant`,
      { 'Authorization': bearer, 'apikey': SERVICE_ROLE_KEY, 'Content-Type': 'application/json' },
      { p_restaurant_id: restaurantId });
    if (!del.ok) {
      const msg = (del.data && (del.data.message || del.data.error || del.data.hint)) || 'No se pudo eliminar el restaurante';
      res.status(400).json({ error: String(msg) }); return;
    }
    const summary = del.data || {};

    // 7. Cuentas auth (best-effort; los datos ya se borraron atómicamente).
    let usersDeleted = [], usersFailed = [];
    for (const uid of usersToDelete) {
      const r = await httpsRequest('DELETE', `${SUPABASE_URL}/auth/v1/admin/users/${uid}`, svc);
      if (r.ok) usersDeleted.push(uid); else usersFailed.push(uid);
    }

    res.status(200).json({
      success: true,
      restaurant: { id: rest.id, name: rest.name },
      deleted: summary,
      users_deleted: usersDeleted,
      users_skipped: usersSkipped,
      users_failed: usersFailed
    });
  } catch (e) {
    try { console.error('[delete-restaurant] error', e && e.message ? e.message : e); } catch (_) {}
    res.status(500).json({ error: 'Error interno al eliminar el restaurante' });
  }
};
