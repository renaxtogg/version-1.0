// ════════════════════════════════════════════════════════════════════════
// Vercel serverless function — CAMBIO SEGURO DE CONTRASEÑA (AUTH-1)
// ────────────────────────────────────────────────────────────────────────
// Cambia la contraseña del usuario AUTENTICADO (sirve para: cambio normal
// estando logueado, primer ingreso forzado, y recuperación por email — en
// los tres casos el cliente ya tiene una sesión válida, sea normal o de
// recuperación). Luego limpia el flag must_change_password.
//
// SEGURIDAD / DISEÑO:
//   • Requiere Bearer token del usuario; se valida contra Supabase Auth
//     (GET /auth/v1/user) — no se decodifica el JWT localmente.
//   • La contraseña se cambia con el TOKEN DEL USUARIO (PUT /auth/v1/user):
//     prueba que el usuario está autenticado; el service_role NO cambia
//     contraseñas de nadie.
//   • SOLO después de cambiar la contraseña con éxito, se limpia el flag
//     (must_change_password=false, password_changed_at=now(), forced_reason
//     =null) con service_role (la RLS no permite que el usuario apague su
//     propio flag — ver mig 113).
//   • Validación de contraseña server-side (mín. 8, no trivial, ≠ email).
//   • Nunca loguea la contraseña. Nunca devuelve secretos ni detalle técnico.
//   • service_role SOLO server-side (env). Igual patrón que create-user.js.
// ════════════════════════════════════════════════════════════════════════
const https = require('https');

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
          try { parsed = buf ? JSON.parse(buf) : null; } catch (e) { parsed = buf; }
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

// Bloqueo de contraseñas triviales (además de mín. 8). No es exhaustivo:
// evita las obvias, el resto lo cubre la longitud.
const TRIVIAL = [
  '1234567890', '123456789', '0123456789', 'password', 'password1', 'passw0rd',
  'contrasena', 'contraseña',
  'qwertyuiop', 'qwerty1234', 'abcdefghij', 'aaaaaaaaaa', '0000000000', '1111111111'
];
function isTrivial(pw) {
  const l = pw.toLowerCase();
  if (TRIVIAL.indexOf(l) !== -1) return true;
  if (/^(.)\1+$/.test(pw)) return true;                 // todos los caracteres iguales
  if (/password|contrasen/i.test(pw)) return true;      // términos obvios (la marca NO se bloquea)
  return false;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }

  const SUPABASE_URL = clean(process.env.SUPABASE_URL);
  const SERVICE_ROLE_KEY = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'El cambio de contraseña no está disponible en este momento.' });
    return;
  }

  try {
    const authHeader = clean(req.headers['authorization']);
    if (!authHeader) { res.status(401).json({ error: 'No autenticado' }); return; }
    const bearer = /^Bearer\s+/i.test(authHeader) ? authHeader : `Bearer ${authHeader}`;

    // 1. Validar el token del usuario contra Supabase Auth (verifica firma + exp).
    const meResp = await httpsRequest('GET', `${SUPABASE_URL}/auth/v1/user`,
      { 'Authorization': bearer, 'apikey': SERVICE_ROLE_KEY });
    if (!meResp.ok || !meResp.data || !meResp.data.id) {
      res.status(401).json({ error: 'Tu sesión expiró. Volvé a intentar desde el enlace o iniciá sesión de nuevo.' });
      return;
    }
    const userId = meResp.data.id;
    const userEmail = clean(meResp.data.email).toLowerCase();

    // 2. Validar la nueva contraseña server-side.
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 8 || password.length > 128) {
      res.status(400).json({ error: 'La contraseña debe tener entre 8 y 128 caracteres.' }); return;
    }
    if (userEmail && password.toLowerCase() === userEmail) {
      res.status(400).json({ error: 'La contraseña no puede ser igual a tu correo.' }); return;
    }
    if (isTrivial(password)) {
      res.status(400).json({ error: 'Elegí una contraseña menos predecible.' }); return;
    }

    // 3. Cambiar la contraseña con el TOKEN DEL USUARIO (no con service_role).
    const updResp = await httpsRequest('PUT', `${SUPABASE_URL}/auth/v1/user`,
      { 'Authorization': bearer, 'apikey': SERVICE_ROLE_KEY, 'Content-Type': 'application/json' },
      { password });
    if (!updResp.ok) {
      // Mensaje genérico; sin detalle técnico. (p.ej. "same password" de GoTrue.)
      res.status(400).json({ error: 'No se pudo actualizar la contraseña. Probá con otra.' });
      return;
    }

    // 4. Limpiar el flag SOLO ahora (con service_role). Si no existe la fila,
    //    el PATCH no afecta nada (el usuario no tenía cambio pendiente). No es
    //    fatal para el éxito del cambio de contraseña.
    await httpsRequest('PATCH',
      `${SUPABASE_URL}/rest/v1/user_security_flags?user_id=eq.${encodeURIComponent(userId)}`,
      { 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      { must_change_password: false, password_changed_at: new Date().toISOString(), forced_reason: null }
    ).catch(() => {});

    res.status(200).json({ success: true });
  } catch (e) {
    try { console.error('[change-password] error', e && e.message ? e.message : e); } catch (x) {}
    res.status(500).json({ error: 'No se pudo cambiar la contraseña. Intentá de nuevo más tarde.' });
  }
};
