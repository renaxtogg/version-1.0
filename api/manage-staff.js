// Vercel serverless function — gestión segura de personal (editar rol/estado, quitar del local)
// Complemento de create-user.js: permite a un admin del restaurante EDITAR el rol/estado de
// un empleado y QUITARLO del local (libera la cédula y el cupo del puesto), sin exponer el
// service_role al frontend ni tocar RLS. Guardas:
//   • token del caller verificado criptográficamente contra Supabase Auth,
//   • caller debe ser admin/owner del restaurante destino (o superadmin),
//   • el objetivo debe ser un rol de EMPLEADO (nunca admin/superadmin/owner),
//   • todo scopeado al restaurante del caller (tenant guard).
const https = require('https');
const { checkRateLimit } = require('./_ratelimit');

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
const httpsGet    = (url, h)       => httpsReq('GET', url, h);
const httpsPatch  = (url, h, b)    => httpsReq('PATCH', url, h, b);
const httpsDelete = (url, h)       => httpsReq('DELETE', url, h);

// Roles que un admin puede gestionar. Nunca admin/superadmin/owner.
const EMPLOYEE_ROLES = ['cajero', 'mozo', 'cocina', 'rider', 'supervisor_local'];
// Palabra legible por rol para los mensajes de cupo (evita mostrar 'supervisor_local(s)').
const ROLE_WORD = { mozo:'mozos', cajero:'cajeros', cocina:'cocineros', rider:'riders', supervisor_local:'gerentes' };

module.exports = async function handler(req, res) {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://mythos-pos.vercel.app';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }

  if (await checkRateLimit(req, res, { key: 'manage-staff', max: 20, windowSec: 60 })) return;

  try {
    const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/^[﻿\s]+|[\s]+$/g, '');
    const SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').replace(/^[﻿\s]+|[\s]+$/g, '');
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      res.status(500).json({ error: 'Servidor no configurado: falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY' }); return;
    }
    const svc = { 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY };
    const svcJson = { ...svc, 'Content-Type': 'application/json' };

    // ── Autenticación del caller (firma verificada contra Auth, no decode local) ──
    const authHeader = (req.headers['authorization'] || '').trim();
    if (!authHeader) { res.status(401).json({ error: 'No autenticado' }); return; }
    const bearer = /^Bearer\s+/i.test(authHeader) ? authHeader : `Bearer ${authHeader}`;
    const authedResp = await httpsGet(`${SUPABASE_URL}/auth/v1/user`, { 'Authorization': bearer, 'apikey': SERVICE_ROLE_KEY });
    if (!authedResp.ok || !authedResp.data || !authedResp.data.id) {
      res.status(401).json({ error: 'Token inválido o expirado' }); return;
    }
    const callerId = authedResp.data.id;

    const roleResp = await httpsGet(
      `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${callerId}&select=role,restaurant_id`, svc);
    if (!roleResp.ok || !Array.isArray(roleResp.data) || roleResp.data.length === 0) {
      res.status(403).json({ error: 'Sin permisos' }); return;
    }
    // Resolver el rol de mayor privilegio del caller (superadmin > admin/owner).
    const roles = roleResp.data;
    const isSuper = roles.some(r => r.role === 'superadmin');
    const adminRow = roles.find(r => r.role === 'admin' || r.role === 'owner');
    if (!isSuper && !adminRow) { res.status(403).json({ error: 'Solo un administrador puede gestionar personal' }); return; }

    const body = req.body || {};
    const action = body.action;
    const restaurant_id = body.restaurant_id || (adminRow && adminRow.restaurant_id) || null;
    if (!restaurant_id) { res.status(400).json({ error: 'Falta el restaurante' }); return; }
    // Tenant guard: un admin solo opera dentro de su restaurante.
    if (!isSuper && adminRow.restaurant_id !== restaurant_id) {
      res.status(403).json({ error: 'Solo podés gestionar el personal de tu restaurante' }); return;
    }

    const isRider = !!body.rider_id;

    // ── Cargar el objetivo (user_roles o delivery_riders) y validar tenant + rol ──
    let target;  // { kind:'role'|'rider', roleRowId?, riderId?, user_id, role, restaurant_id }
    if (isRider) {
      const r = await httpsGet(
        `${SUPABASE_URL}/rest/v1/delivery_riders?id=eq.${body.rider_id}&select=id,user_id,restaurant_id`, svc);
      const row = Array.isArray(r.data) ? r.data[0] : null;
      if (!row) { res.status(404).json({ error: 'Rider no encontrado' }); return; }
      target = { kind: 'rider', riderId: row.id, user_id: row.user_id, role: 'rider', restaurant_id: row.restaurant_id };
    } else {
      if (!body.role_row_id) { res.status(400).json({ error: 'Falta el identificador del empleado' }); return; }
      const r = await httpsGet(
        `${SUPABASE_URL}/rest/v1/user_roles?id=eq.${body.role_row_id}&select=id,user_id,role,restaurant_id`, svc);
      const row = Array.isArray(r.data) ? r.data[0] : null;
      if (!row) { res.status(404).json({ error: 'Empleado no encontrado' }); return; }
      target = { kind: 'role', roleRowId: row.id, user_id: row.user_id, role: row.role, restaurant_id: row.restaurant_id };
    }

    if (target.restaurant_id !== restaurant_id) {
      res.status(403).json({ error: 'Ese empleado no pertenece a tu restaurante' }); return;
    }
    if (!EMPLOYEE_ROLES.includes((target.role || '').toLowerCase())) {
      res.status(403).json({ error: 'No se puede gestionar a un administrador desde aquí.' }); return;
    }
    if (target.user_id === callerId) {
      res.status(403).json({ error: 'No podés gestionar tu propia cuenta desde aquí.' }); return;
    }

    // ─────────────────────────────── DETAIL ───────────────────────────────
    // Datos completos del empleado para pre-cargar el modal de edición. El RPC de
    // listado (admin_list_restaurant_users) NO trae phone/recovery_email/cedula, y
    // leerlos por RLS es frágil (el Sprint 1 la cierra). Acá vía service_role, con el
    // tenant/rol guard ya aplicado arriba. Nunca devuelve el email sintético de Auth.
    if (action === 'detail') {
      if (target.kind === 'rider') {
        const r = await httpsGet(`${SUPABASE_URL}/rest/v1/delivery_riders?id=eq.${target.riderId}&select=name,phone,active,cedula`, svc);
        const row = Array.isArray(r.data) ? r.data[0] : null;
        res.status(200).json({ success: true, detail: {
          display_name: (row && row.name) || '', phone: (row && row.phone) || '',
          recovery_email: '', cedula: (row && row.cedula) || '', role: 'rider',
          is_active: !row || row.active !== false
        }}); return;
      }
      const r = await httpsGet(`${SUPABASE_URL}/rest/v1/user_roles?id=eq.${target.roleRowId}&select=display_name,phone,recovery_email,cedula,role,is_active`, svc);
      const row = Array.isArray(r.data) ? r.data[0] : null;
      res.status(200).json({ success: true, detail: {
        display_name: (row && row.display_name) || '', phone: (row && row.phone) || '',
        recovery_email: (row && row.recovery_email) || '', cedula: (row && row.cedula) || '',
        role: (row && row.role) || target.role, is_active: !row || row.is_active !== false
      }}); return;
    }

    // ─────────────────────────────── UPDATE ───────────────────────────────
    if (action === 'update') {
      const isActive = body.is_active !== false; // default true
      if (target.kind === 'rider') {
        // El rol del rider es fijo; se editan estado + nombre + teléfono (ficha operativa).
        // Vehículo/comisión se editan en Delivery → Riders. Solo se tocan columnas presentes.
        const rpatch = { active: isActive };
        if (typeof body.display_name === 'string') {
          const dn = body.display_name.trim();
          if (dn.length < 2) { res.status(400).json({ error: 'El nombre debe tener al menos 2 caracteres.' }); return; }
          rpatch.name = dn;
        }
        if (body.phone !== undefined) rpatch.phone = (typeof body.phone === 'string' && body.phone.trim()) ? body.phone.trim() : null;
        const u1 = await httpsPatch(`${SUPABASE_URL}/rest/v1/delivery_riders?id=eq.${target.riderId}`, svcJson, rpatch);
        if (!u1.ok) { res.status(400).json({ error: 'No se pudo actualizar el rider' }); return; }
        // Reflejar estado/nombre/teléfono en su fila de user_roles (rol 'rider'), si existe.
        const mirror = { is_active: isActive };
        if (rpatch.name) mirror.display_name = rpatch.name;
        if (body.phone !== undefined) mirror.phone = rpatch.phone;
        await httpsPatch(`${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${target.user_id}&restaurant_id=eq.${restaurant_id}&role=eq.rider`, svcJson, mirror);
        res.status(200).json({ success: true, action: 'update' }); return;
      }
      // Empleado normal: puede cambiar rol (dentro de roles de empleado) y estado.
      const patch = { is_active: isActive };
      let newRole = target.role;
      if (typeof body.new_role === 'string' && body.new_role && body.new_role !== target.role) {
        if (!EMPLOYEE_ROLES.includes(body.new_role)) { res.status(400).json({ error: 'Rol destino inválido' }); return; }
        if (body.new_role === 'rider') {
          res.status(400).json({ error: 'Para convertir a rider, quitá el empleado y creá el rider (necesita ficha de reparto).' }); return;
        }
        // Cupo del plan para el rol destino (mismo criterio que create-user): aplica a
        // cualquier rol de empleado, se enforca solo si el plan define un tope numérico.
        if (isActive && EMPLOYEE_ROLES.includes(body.new_role)) {
          const subResp = await httpsGet(
            `${SUPABASE_URL}/rest/v1/subscriptions?restaurant_id=eq.${restaurant_id}&select=plan:subscription_plans(max_users_by_role)&order=created_at.desc&limit=1`, svc);
          const limitsMap = (Array.isArray(subResp.data) && subResp.data[0]?.plan?.max_users_by_role) || {};
          const roleLimit = limitsMap[body.new_role];
          if (typeof roleLimit === 'number') {
            const countResp = await httpsGet(
              `${SUPABASE_URL}/rest/v1/user_roles?restaurant_id=eq.${restaurant_id}&role=eq.${body.new_role}&is_active=eq.true&select=id`,
              { ...svc, 'Prefer': 'count=exact' });
            const current = Array.isArray(countResp.data) ? countResp.data.length : 0;
            if (current >= roleLimit) {
              res.status(403).json({ error: `Límite de puestos alcanzado: el plan permite ${roleLimit} ${ROLE_WORD[body.new_role] || body.new_role+'(s)'}.` }); return;
            }
          }
        }
        patch.role = body.new_role; newRole = body.new_role;
      }
      // Datos editables del empleado (nombre / teléfono / correo de contacto). Solo se
      // tocan las columnas presentes en el payload → un campo omitido NO se blanquea.
      if (typeof body.display_name === 'string') {
        const dn = body.display_name.trim();
        if (dn.length < 2) { res.status(400).json({ error: 'El nombre debe tener al menos 2 caracteres.' }); return; }
        patch.display_name = dn;
      }
      if (body.phone !== undefined) {
        patch.phone = (typeof body.phone === 'string' && body.phone.trim()) ? body.phone.trim() : null;
      }
      if (body.recovery_email !== undefined) {
        const re = (typeof body.recovery_email === 'string') ? body.recovery_email.trim().toLowerCase() : '';
        if (re && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(re)) { res.status(400).json({ error: 'El correo no es válido.' }); return; }
        patch.recovery_email = re || null;
      }
      const u = await httpsPatch(`${SUPABASE_URL}/rest/v1/user_roles?id=eq.${target.roleRowId}`, { ...svcJson, 'Prefer': 'return=representation' }, patch);
      if (!u.ok || !Array.isArray(u.data) || u.data.length === 0) {
        res.status(400).json({ error: (u.data && (u.data.message || u.data.msg)) || 'No se pudo actualizar el empleado' }); return;
      }
      res.status(200).json({ success: true, action: 'update', role: newRole, is_active: isActive }); return;
    }

    // ─────────────────────────────── REMOVE ───────────────────────────────
    if (action === 'remove') {
      if (target.kind === 'rider') {
        // Borrar ficha operativa + su fila de rol 'rider' en este restaurante.
        const d1 = await httpsDelete(`${SUPABASE_URL}/rest/v1/delivery_riders?id=eq.${target.riderId}`, svc);
        if (!d1.ok) { res.status(400).json({ error: 'No se pudo quitar el rider' }); return; }
        await httpsDelete(`${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${target.user_id}&restaurant_id=eq.${restaurant_id}&role=eq.rider`, svc);
      } else {
        const d = await httpsDelete(`${SUPABASE_URL}/rest/v1/user_roles?id=eq.${target.roleRowId}`, svc);
        if (!d.ok) { res.status(400).json({ error: 'No se pudo quitar el empleado' }); return; }
      }

      // Limpieza de la cuenta auth: SOLO si a la persona no le queda NINGÚN rol en
      // NINGÚN restaurante (evita borrar a alguien que trabaja en otro local con la
      // misma cuenta — reuse multi-sucursal). Nunca borra al caller.
      let authRemoved = false;
      if (target.user_id && target.user_id !== callerId) {
        const remaining = await httpsGet(`${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${target.user_id}&select=id`, svc);
        const count = Array.isArray(remaining.data) ? remaining.data.length : -1;
        if (count === 0) {
          await httpsDelete(`${SUPABASE_URL}/rest/v1/user_security_flags?user_id=eq.${target.user_id}`, svc);
          const da = await httpsDelete(`${SUPABASE_URL}/auth/v1/admin/users/${target.user_id}`, svc);
          authRemoved = da.ok;
        }
      }
      res.status(200).json({ success: true, action: 'remove', auth_removed: authRemoved }); return;
    }

    res.status(400).json({ error: 'Acción no reconocida' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Error interno del servidor' });
  }
};
