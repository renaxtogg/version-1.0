// Vercel serverless function — guardar la CÉDULA de acceso del admin/owner.
// Permite que el admin entre ADEMÁS con su cédula (ver migración 187 +
// resolve_login_identifier). NO cambia su email ni su usuario de Auth: sólo
// guarda user_roles.cedula, de forma que el login pueda resolver cédula→cuenta.
// Guardas: token del caller verificado, caller admin/owner (no superadmin),
// cédula válida y sin colisión con otra persona. El caller sólo edita su
// propia cuenta (callerId).
const https = require('https');
const { checkRateLimit } = require('./_ratelimit');
const { applyCors } = require('./_cors');

function httpsReq(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const opts = { hostname: u.hostname, path: u.pathname + u.search, method, headers: { ...headers } };
    if (data != null) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = buf ? JSON.parse(buf) : null; } catch (_) { parsed = buf; }
        resolve({ ok: res.statusCode < 300, status: res.statusCode, data: parsed });
      });
    });
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}
const httpsGet   = (url, h)    => httpsReq('GET', url, h);
const httpsPatch = (url, h, b) => httpsReq('PATCH', url, h, b);

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }

  if (await checkRateLimit(req, res, { key: 'set-admin-cedula', max: 10, windowSec: 60 })) return;

  try {
    const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/^[﻿\s]+|[\s]+$/g, '');
    const SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').replace(/^[﻿\s]+|[\s]+$/g, '');
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      res.status(500).json({ error: 'Servidor no configurado' }); return;
    }
    const svc = { 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY };
    const svcJson = { ...svc, 'Content-Type': 'application/json' };

    const authHeader = (req.headers['authorization'] || '').trim();
    if (!authHeader) { res.status(401).json({ error: 'No autenticado' }); return; }
    const bearer = /^Bearer\s+/i.test(authHeader) ? authHeader : `Bearer ${authHeader}`;
    const authedResp = await httpsGet(`${SUPABASE_URL}/auth/v1/user`, { 'Authorization': bearer, 'apikey': SERVICE_ROLE_KEY });
    if (!authedResp.ok || !authedResp.data || !authedResp.data.id) {
      res.status(401).json({ error: 'Token inválido o expirado' }); return;
    }
    const callerId = authedResp.data.id;

    // Sólo roles ACTIVOS: un admin desactivado no debe poder darse de alta una cédula
    // de acceso (sería recuperar una vía de login tras haber sido dado de baja).
    const roleResp = await httpsGet(`${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${callerId}&is_active=eq.true&select=id,role`, svc);
    if (!roleResp.ok || !Array.isArray(roleResp.data) || roleResp.data.length === 0) {
      res.status(403).json({ error: 'Sin permisos' }); return;
    }
    const isAdmin = roleResp.data.some(r => r.role === 'admin' || r.role === 'owner');
    if (!isAdmin) {
      res.status(403).json({ error: 'Solo un administrador puede definir su cédula de acceso.' }); return;
    }

    const digits = String((req.body && req.body.cedula) || '').replace(/\D/g, '');
    if (digits.length < 4 || digits.length > 10) {
      res.status(400).json({ error: 'Ingresá una cédula válida (solo números, 4 a 10 dígitos).' }); return;
    }

    // Colisión: la cédula no puede pertenecer a OTRA persona (otro user_id).
    const dupResp = await httpsGet(
      `${SUPABASE_URL}/rest/v1/user_roles?cedula=eq.${digits}&user_id=neq.${callerId}&select=user_id`, svc);
    if (Array.isArray(dupResp.data) && dupResp.data.length > 0) {
      res.status(409).json({ error: 'Esa cédula ya está en uso por otra cuenta.' }); return;
    }

    // Guardar la cédula en TODAS las filas de rol del caller (admin en 1+ locales).
    const upd = await httpsPatch(
      `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${callerId}`,
      { ...svcJson, 'Prefer': 'return=representation' },
      { cedula: digits });
    if (!upd.ok || !Array.isArray(upd.data) || upd.data.length === 0) {
      res.status(400).json({ error: (upd.data && (upd.data.message || upd.data.msg)) || 'No se pudo guardar la cédula.' }); return;
    }

    res.status(200).json({ success: true, cedula: digits });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Error interno del servidor' });
  }
};
