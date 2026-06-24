// Vercel serverless function — ONBOARDING del dueño (Bloque C, parte 1).
// Crea, para un usuario Auth recién registrado y SIN rol: su restaurante + rol
// 'admin' + suscripción trial de 14 días. Patrón de seguridad idéntico a
// api/create-user.js:
//   • Valida el Bearer del caller contra /auth/v1/user (verifica firma + expiración;
//     NO se decodifica el JWT localmente — un payload sin verificar es falsificable).
//   • SERVICE_ROLE_KEY SOLO en el server (env var), nunca en el front.
//   • Atómico con ROLLBACK si algún paso falla (no deja restaurantes/roles huérfanos).
//   • ANTI-DUPLICADO: un usuario = un restaurante (si ya tiene rol, rechaza).
// El front NO inserta nunca directo en restaurants/user_roles/subscriptions (RLS las
// limita a superadmin); TODO pasa por acá con service_role.
const https = require('https');

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
        try { parsed = buf ? JSON.parse(buf) : null; } catch (e) { parsed = buf; }
        resolve({ ok: res.statusCode < 300, status: res.statusCode, data: parsed });
      });
    });
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}
const httpsGet    = (url, h)    => httpsReq('GET', url, h);
const httpsPost   = (url, h, b) => httpsReq('POST', url, h, b);
const httpsPatch  = (url, h, b) => httpsReq('PATCH', url, h, b);
const httpsDelete = (url, h)    => httpsReq('DELETE', url, h);

function errMsg(r, fallback) {
  return (r && r.data && (r.data.message || r.data.msg || r.data.hint)) || fallback;
}

// Rollback best-effort que NO es silencioso: si un DELETE de compensación falla,
// lo logueamos (server-side) para que el huérfano sea observable y barrible luego.
async function rollbackDelete(url, headers, label) {
  try {
    const r = await httpsDelete(url, headers);
    if (!r.ok) console.error(`[onboarding] rollback fallo (${label}): ${r.status}`, r.data);
  } catch (e) {
    console.error(`[onboarding] rollback excepción (${label}):`, e && e.message);
  }
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
    const svc     = { 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY };
    const svcJson = { ...svc, 'Content-Type': 'application/json' };

    // 1. Validar el token del caller (firma + expiración) contra Supabase Auth.
    const authHeader = (req.headers['authorization'] || '').trim();
    if (!authHeader) { res.status(401).json({ error: 'No autenticado' }); return; }
    const bearer = /^Bearer\s+/i.test(authHeader) ? authHeader : `Bearer ${authHeader}`;
    const authed = await httpsGet(`${SUPABASE_URL}/auth/v1/user`, { 'Authorization': bearer, 'apikey': SERVICE_ROLE_KEY });
    if (!authed.ok || !authed.data || !authed.data.id) {
      res.status(401).json({ error: 'Token inválido o expirado' }); return;
    }
    const userId = authed.data.id;
    const email = (authed.data.email || '').trim().toLowerCase() || null;
    // owner_email sale SOLO del token (no del body) → no es falsificable. Pero si el
    // token no trae email (OAuth sin scope / signup por teléfono) no creamos un tenant
    // sin contacto de dueño: el funnel asume email verificado.
    if (!email) { res.status(400).json({ error: 'Tu cuenta no tiene un email verificado.' }); return; }

    // 2. ANTI-DUPLICADO: si el usuario YA tiene rol/restaurante, no crear nada.
    const existing = await httpsGet(
      `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${userId}&select=id,restaurant_id&limit=1`, svc);
    if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
      res.status(409).json({ error: 'Esta cuenta ya tiene un local creado.' }); return;
    }

    // 3. Validar input.
    const body = req.body || {};
    const restaurantName = (typeof body.restaurant_name === 'string' ? body.restaurant_name : '').trim();
    const planId = (typeof body.plan_id === 'string' ? body.plan_id : '').trim();
    if (restaurantName.length < 2 || restaurantName.length > 120) {
      res.status(400).json({ error: 'Decinos el nombre de tu local (entre 2 y 120 caracteres).' }); return;
    }
    if (!planId) { res.status(400).json({ error: 'Elegí un plan para tu prueba.' }); return; }

    // 4. Validar el plan SERVER-SIDE (existe + activo) y leer su precio. NO se confía
    //    en ningún precio que mande el cliente: el snapshot sale de la BD.
    // planId viene del cliente → encodeURIComponent para que no inyecte params al URL
    // de PostgREST (userId/restaurantId son UUIDs de confianza: del token / de inserts propios).
    const planResp = await httpsGet(
      `${SUPABASE_URL}/rest/v1/subscription_plans?id=eq.${encodeURIComponent(planId)}&is_active=eq.true&select=id,price_usd&limit=1`, svc);
    if (!planResp.ok || !Array.isArray(planResp.data) || planResp.data.length === 0) {
      res.status(400).json({ error: 'El plan elegido no está disponible.' }); return;
    }
    const planPrice = Number(planResp.data[0].price_usd) || 0;

    // 5. Fechas del trial (14 días) en DATE (YYYY-MM-DD).
    const today = new Date();
    const end = new Date(today.getTime());
    end.setDate(end.getDate() + 14);
    const startDate = today.toISOString().slice(0, 10);
    const endDate = end.toISOString().slice(0, 10);

    // 6a. Crear restaurante (status 'trial'). onboarding_date toma CURRENT_DATE por default.
    const restResp = await httpsPost(`${SUPABASE_URL}/rest/v1/restaurants`,
      { ...svcJson, 'Prefer': 'return=representation' },
      JSON.stringify({ name: restaurantName, owner_email: email, status: 'trial' }));
    const restRow = (restResp.ok && Array.isArray(restResp.data)) ? restResp.data[0] : null;
    if (!restRow || !restRow.id) {
      res.status(400).json({ error: errMsg(restResp, 'No se pudo crear el local. Probá de nuevo.') }); return;
    }
    const restaurantId = restRow.id;

    // 6b. Asignar rol 'admin' al dueño. Si falla → ROLLBACK del restaurante.
    const roleResp = await httpsPost(`${SUPABASE_URL}/rest/v1/user_roles`,
      { ...svcJson, 'Prefer': 'return=minimal' },
      JSON.stringify({ user_id: userId, restaurant_id: restaurantId, role: 'admin', email, is_active: true }));
    if (!roleResp.ok) {
      await rollbackDelete(`${SUPABASE_URL}/rest/v1/restaurants?id=eq.${restaurantId}`, svc, 'restaurants');
      // UNIQUE(user_id, role) (mig 006) es el backstop real del anti-duplicado: si dos
      // requests corren a la vez, el perdedor choca acá → lo tratamos como 'ya tiene local'
      // (409, el front lo manda a su panel) en vez de un 400 confuso.
      const dup = roleResp.status === 409 || (roleResp.data && roleResp.data.code === '23505');
      if (dup) { res.status(409).json({ error: 'Esta cuenta ya tiene un local creado.' }); return; }
      res.status(400).json({ error: errMsg(roleResp, 'No se pudo asignar tu rol. Probá de nuevo.') }); return;
    }

    // 6c. Crear suscripción trial (14 días). monthly_amount = snapshot del precio del plan
    //     (grandfathering). Si falla → ROLLBACK de user_roles + restaurante.
    const subResp = await httpsPost(`${SUPABASE_URL}/rest/v1/subscriptions`,
      { ...svcJson, 'Prefer': 'return=minimal' },
      JSON.stringify({ restaurant_id: restaurantId, plan_id: planId, status: 'trial',
                       start_date: startDate, end_date: endDate, monthly_amount: planPrice }));
    if (!subResp.ok) {
      await rollbackDelete(`${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${userId}&restaurant_id=eq.${restaurantId}`, svc, 'user_roles');
      await rollbackDelete(`${SUPABASE_URL}/rest/v1/restaurants?id=eq.${restaurantId}`, svc, 'restaurants');
      res.status(400).json({ error: errMsg(subResp, 'No se pudo crear tu suscripción de prueba. Probá de nuevo.') }); return;
    }

    // 6d. Best-effort: marcar el lead de este email como 'onboarding' (si existe la tabla).
    //     No bloquea el onboarding si falla (la tabla puede no estar aplicada todavía).
    if (email) {
      try {
        await httpsPatch(
          `${SUPABASE_URL}/rest/v1/leads_prospectos?email=eq.${encodeURIComponent(email)}&estado=eq.registrado`,
          { ...svcJson, 'Prefer': 'return=minimal' },
          JSON.stringify({ estado: 'onboarding' }));
      } catch (e) { /* best-effort */ }
    }

    // 6e. Best-effort: registrar el alta en platform_events (igual que el superadmin).
    try {
      await httpsPost(`${SUPABASE_URL}/rest/v1/platform_events`, { ...svcJson, 'Prefer': 'return=minimal' },
        JSON.stringify({ restaurant_id: restaurantId, event_type: 'onboarding',
                         description: 'Alta self-service (dueño) — trial 14 días' }));
    } catch (e) { /* best-effort */ }

    res.status(200).json({ success: true, restaurant_id: restaurantId, role: 'admin', trial_end: endDate });
  } catch (e) {
    // No filtrar internals al cliente; el detalle queda en los logs del server.
    console.error('[onboarding] error:', (e && e.stack) || e);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};
