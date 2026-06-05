// Vercel serverless function — gestión segura de usuarios con Supabase Admin API
const https = require('https');

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve({ ok: res.statusCode < 300, status: res.statusCode, data: JSON.parse(buf) }); } catch(e) { resolve({ ok: false, status: res.statusCode, data: buf }); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve({ ok: res.statusCode < 300, status: res.statusCode, data: JSON.parse(buf) }); } catch(e) { resolve({ ok: false, status: res.statusCode, data: buf }); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpsDelete(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'DELETE', headers }, res => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode < 300 }));
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }

  try {
    const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/^[﻿\s]+|[\s]+$/g, '');
    const SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').replace(/^[﻿\s]+|[\s]+$/g, '');

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      res.status(500).json({ error: 'Servidor no configurado: falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY' });
      return;
    }

    const authHeader = (req.headers['authorization'] || '').trim();
    if (!authHeader) { res.status(401).json({ error: 'No autenticado' }); return; }

    // Validar el token del caller contra Supabase Auth (verifica firma criptográfica
    // + expiración). NO se decodifica el JWT localmente: un payload sin verificar la
    // firma es trivialmente falsificable y permitiría a cualquiera con un UUID de
    // admin/superadmin escalar privilegios usando el service_role de abajo.
    const bearer = /^Bearer\s+/i.test(authHeader) ? authHeader : `Bearer ${authHeader}`;
    const authedResp = await httpsGet(
      `${SUPABASE_URL}/auth/v1/user`,
      { 'Authorization': bearer, 'apikey': SERVICE_ROLE_KEY }
    );
    if (!authedResp.ok || !authedResp.data || !authedResp.data.id) {
      res.status(401).json({ error: 'Token inválido o expirado' }); return;
    }

    const callerId = authedResp.data.id;

    // Verificar rol del caller en user_roles
    const roleResp = await httpsGet(
      `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${callerId}&select=role,restaurant_id&limit=1`,
      { 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY }
    );
    if (!roleResp.ok || !Array.isArray(roleResp.data) || roleResp.data.length === 0) {
      res.status(403).json({ error: 'Sin permisos para crear usuarios' });
      return;
    }
    const callerRole = roleResp.data[0];

    const body = req.body || {};
    const { username, password, display_name, role, restaurant_id } = body;

    if (!username || typeof username !== 'string' || username.trim().length < 2) {
      res.status(400).json({ error: 'Nombre de usuario requerido (mínimo 2 caracteres)' }); return;
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      res.status(400).json({ error: 'Contraseña requerida (mínimo 6 caracteres)' }); return;
    }
    if (!role) { res.status(400).json({ error: 'Rol requerido' }); return; }

    const ADMIN_ROLES = ['cajero', 'mozo', 'cocina', 'rider', 'supervisor_local'];
    const ALL_ROLES   = ['superadmin', 'admin', 'cajero', 'mozo', 'cocina', 'rider', 'supervisor_local'];

    if (callerRole.role === 'admin') {
      if (!ADMIN_ROLES.includes(role)) {
        res.status(403).json({ error: 'Solo podés asignar roles de empleado' }); return;
      }
      const targetRest = restaurant_id || callerRole.restaurant_id;
      if (targetRest !== callerRole.restaurant_id) {
        res.status(403).json({ error: 'Solo podés crear usuarios para tu restaurante' }); return;
      }
    } else if (callerRole.role === 'superadmin') {
      if (!ALL_ROLES.includes(role)) { res.status(400).json({ error: 'Rol inválido' }); return; }
    } else {
      res.status(403).json({ error: 'Sin permisos para crear usuarios' }); return;
    }

    const finalRestaurantId = callerRole.role === 'admin' ? callerRole.restaurant_id : (restaurant_id || null);

    // Hard-limit por plan: rechazar antes de crear el usuario auth (evita huérfanos).
    // El trigger DB enforce_role_user_limit es el respaldo final.
    const LIMITED_ROLES = ['mozo', 'cajero', 'cocina', 'rider'];
    if (finalRestaurantId && LIMITED_ROLES.includes(role)) {
      const subResp = await httpsGet(
        `${SUPABASE_URL}/rest/v1/subscriptions?restaurant_id=eq.${finalRestaurantId}&select=plan:subscription_plans(max_users_by_role)&order=created_at.desc&limit=1`,
        { 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY }
      );
      const limitsMap = (Array.isArray(subResp.data) && subResp.data[0]?.plan?.max_users_by_role) || {};
      const roleLimit = limitsMap[role];
      if (typeof roleLimit === 'number') {
        const countResp = await httpsGet(
          `${SUPABASE_URL}/rest/v1/user_roles?restaurant_id=eq.${finalRestaurantId}&role=eq.${role}&is_active=eq.true&select=id`,
          { 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY, 'Prefer': 'count=exact' }
        );
        const current = Array.isArray(countResp.data) ? countResp.data.length : 0;
        if (current >= roleLimit) {
          res.status(403).json({ error: `Límite de puestos alcanzado: el plan permite ${roleLimit} ${role}(s). Ampliá el plan o contratá un add-on.` });
          return;
        }
      }
    }

    const usernameClean = username.trim().toLowerCase();
    const email = `${usernameClean.replace(/[^a-z0-9._-]/g, '')}@mythos.internal`;

    // Crear usuario en auth.users
    const createResp = await httpsPost(
      `${SUPABASE_URL}/auth/v1/admin/users`,
      { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY },
      JSON.stringify({ email, password, email_confirm: true, user_metadata: { display_name: display_name || username, username: usernameClean } })
    );
    if (!createResp.ok) {
      const msg = createResp.data?.msg || createResp.data?.message || JSON.stringify(createResp.data);
      res.status(400).json({ error: `Error al crear usuario: ${msg}` }); return;
    }

    const newUserId = createResp.data.id;

    // Insertar en user_roles
    const roleInsertResp = await httpsPost(
      `${SUPABASE_URL}/rest/v1/user_roles`,
      { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY, 'Prefer': 'return=representation' },
      JSON.stringify({ user_id: newUserId, username: usernameClean, display_name: display_name || username, role, restaurant_id: finalRestaurantId, email, is_active: true })
    );
    if (!roleInsertResp.ok) {
      const roleErr = roleInsertResp.data;
      await httpsDelete(`${SUPABASE_URL}/auth/v1/admin/users/${newUserId}`,
        { 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY });
      res.status(400).json({ error: roleErr?.message || 'Error al asignar rol' }); return;
    }

    res.status(200).json({ success: true, user_id: newUserId, username: usernameClean, email });
  } catch(e) {
    res.status(500).json({ error: e.message || 'Error interno del servidor' });
  }
};
