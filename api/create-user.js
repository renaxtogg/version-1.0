// Vercel serverless function — gestión segura de usuarios con Supabase Admin API
const https = require('https');
const { checkRateLimit } = require('./_ratelimit');

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
      // `ok` SIEMPRE por status code: un 2xx con cuerpo vacío (Prefer: return=minimal)
      // es éxito, no fallo. El parse del body es best-effort y nunca define `ok`.
      res.on('end', () => {
        let data = null;
        try { data = buf ? JSON.parse(buf) : null; } catch(_) { data = buf; }
        resolve({ ok: res.statusCode < 300, status: res.statusCode, data });
      });
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
      // `ok` SIEMPRE por status code (ver httpsPost). El parse del body no define `ok`.
      res.on('end', () => {
        let data = null;
        try { data = buf ? JSON.parse(buf) : null; } catch(_) { data = buf; }
        resolve({ ok: res.statusCode < 300, status: res.statusCode, data });
      });
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
  // Dominio de producción REAL. 'mythos-pos.vercel.app' es un alias viejo: dejarlo
  // como default hacía que, sin la env var, el header apuntara a un origen que ya no
  // es el del producto. Configurable por ALLOWED_ORIGIN.
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://mythos.com.py';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }

  // Anti-flood: cortar ANTES de gastar llamadas salientes a Supabase Auth.
  if (await checkRateLimit(req, res, { key: 'create-user', max: 10, windowSec: 60 })) return;

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

    // Verificar rol del caller en user_roles.
    // Se piden TODAS sus filas ACTIVAS y se resuelve la de mayor privilegio:
    //   • `limit=1` sin ORDER BY devolvía una fila ARBITRARIA. Una persona puede
    //     tener rol en varios locales (reuse multi-sucursal), así que un admin que
    //     además es mozo en otro local podía recibir la fila de mozo (403 espurio)
    //     o —peor— la fila de OTRO restaurante, y `finalRestaurantId` terminaba
    //     apuntando al local equivocado.
    //   • `is_active=eq.true` es lo que hace que desactivar a un admin le saque de
    //     verdad el poder de crear usuarios (mismo criterio que _staffauth.js y
    //     delete-restaurant.js, que ya filtraban).
    const roleResp = await httpsGet(
      `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${callerId}&is_active=eq.true&select=role,restaurant_id`,
      { 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY }
    );
    if (!roleResp.ok || !Array.isArray(roleResp.data) || roleResp.data.length === 0) {
      res.status(403).json({ error: 'Sin permisos para crear usuarios' });
      return;
    }
    const callerRoles = roleResp.data;
    // Si el caller es admin de VARIOS locales, se prefiere su fila del restaurante
    // pedido (si mandó uno): sin esto, un admin multi-local sólo podía dar de alta
    // en el local que la fila arbitraria hubiera elegido. El tenant guard de abajo
    // sigue siendo el que decide — acá sólo se elige entre filas propias del caller.
    const reqRest = (req.body && typeof req.body.restaurant_id === 'string' && req.body.restaurant_id) || null;
    const callerRole = callerRoles.find(r => r.role === 'superadmin')
      || callerRoles.find(r => r.role === 'admin' && reqRest && r.restaurant_id === reqRest)
      || callerRoles.find(r => r.role === 'admin')
      || callerRoles[0];

    const body = req.body || {};
    const { password, display_name, role, restaurant_id } = body;
    // Campos opcionales del perfil operativo de rider (sólo se usan si role === 'rider').
    const riderVehicle   = typeof body.vehicle === 'string' ? body.vehicle : 'moto';
    const riderCommType  = typeof body.commission_type === 'string' ? body.commission_type : 'pct';
    const riderCommValue = Number.isFinite(+body.commission_value) ? +body.commission_value : 0;
    const riderPhone     = (typeof body.phone === 'string' && body.phone.trim()) ? body.phone.trim() : null;

    if (typeof password !== 'string' || password.trim().length === 0 || password.length < 8) {
      res.status(400).json({ error: 'La contraseña es obligatoria y debe tener al menos 8 caracteres.' }); return;
    }
    if (!role) { res.status(400).json({ error: 'Rol requerido' }); return; }
    // Nombre identificatorio OBLIGATORIO: sin esto la fila queda anónima ("—") y
    // no se entiende quién es el usuario. Vale para todos los roles.
    if (typeof display_name !== 'string' || display_name.trim().length < 2) {
      res.status(400).json({ error: 'El nombre de la persona es obligatorio (para identificar quién es el usuario).' }); return;
    }

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
      // El superadmin es el único que elige el restaurante destino desde el body, y ese
      // valor se interpola en URLs de PostgREST más abajo (subscriptions/user_roles).
      // Sin esta guarda, un `restaurant_id` con `&`/`?` inyectaría parámetros en esas
      // consultas (p.ej. anular el filtro de cupo del plan). Mismo criterio que
      // delete-restaurant.js, que ya validaba el UUID.
      if (restaurant_id != null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(restaurant_id))) {
        res.status(400).json({ error: 'restaurant_id inválido' }); return;
      }
    } else {
      res.status(403).json({ error: 'Sin permisos para crear usuarios' }); return;
    }

    const finalRestaurantId = callerRole.role === 'admin' ? callerRole.restaurant_id : (restaurant_id || null);

    // ── Identidad: empleados por CÉDULA (única); admin/superadmin por username ──
    const EMPLOYEE_ROLES = ['cajero', 'mozo', 'cocina', 'rider', 'supervisor_local'];
    const isEmployee = EMPLOYEE_ROLES.includes(role);
    let cedulaDigits = null, recoveryEmail = null, usernameClean, email;
    // Correo REAL opcional para CUALQUIER rol (contacto + recuperación + confirmación
    // en el primer ingreso). NO es la identidad de Auth: el login sigue por
    // cédula/username → email sintético `@mythos.internal`. Se guarda en
    // user_roles.recovery_email y NUNCA se muestra el sintético como "su correo".
    if (body.recovery_email != null && String(body.recovery_email).trim() !== '') {
      recoveryEmail = String(body.recovery_email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recoveryEmail)) {
        res.status(400).json({ error: 'El correo no es válido.' }); return;
      }
    }
    if (isEmployee) {
      cedulaDigits = String(body.cedula || '').replace(/\D/g, '');
      if (cedulaDigits.length < 4 || cedulaDigits.length > 10) {
        res.status(400).json({ error: 'Cédula inválida' }); return;
      }
      usernameClean = cedulaDigits;
      email = `${cedulaDigits}@mythos.internal`;
    } else {
      const username = body.username;
      if (!username || typeof username !== 'string' || username.trim().length < 2) {
        res.status(400).json({ error: 'Nombre de usuario requerido (mínimo 2 caracteres)' }); return;
      }
      usernameClean = username.trim().toLowerCase();
      const localPart = usernameClean.replace(/[^a-z0-9._-]/g, '');
      if (localPart.length < 2) {
        res.status(400).json({ error: 'Nombre de usuario inválido' }); return;
      }
      // Separación de namespace del email interno: las cédulas ocupan
      // `${dígitos}@mythos.internal`. Un username cuyo local-part sea SÓLO dígitos
      // colisionaría con una cédula y haría "reuse" sobre la cuenta equivocada
      // (un empleado podría terminar con rol admin). Se reservan los números
      // para cédulas.
      if (/^\d+$/.test(localPart)) {
        res.status(400).json({ error: 'El nombre de usuario no puede ser sólo números (los números quedan reservados para cédulas).' }); return;
      }
      email = `${localPart}@mythos.internal`;
    }

    // Hard-limit por plan: rechazar antes de crear el usuario auth (evita huérfanos).
    // Aplica a CUALQUIER rol de empleado (mozo/cajero/cocina/rider/supervisor_local) —
    // se enforca solo si el plan define un tope numérico para ese rol en
    // max_users_by_role (ausente = ilimitado). El trigger DB enforce_role_user_limit
    // es el respaldo final. Para limitar un rol nuevo no hace falta tocar esto:
    // basta que sea EMPLOYEE_ROLES y que el plan le ponga un número.
    if (finalRestaurantId && EMPLOYEE_ROLES.includes(role)) {
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
          const ROLE_WORD = { mozo:'mozos', cajero:'cajeros', cocina:'cocineros', rider:'riders', supervisor_local:'gerentes' };
          const word = ROLE_WORD[role] || `${role}(s)`;
          res.status(403).json({ error: `Límite de puestos alcanzado: el plan permite ${roleLimit} ${word}. Ampliá el plan o contratá un add-on.` });
          return;
        }
      }
    }

    // ── Reuse multi-sucursal: una cédula/username = UN usuario auth ─────────────
    // La identidad (cédula para empleados, username para admin) se materializa en el
    // email sintético `${...}@mythos.internal`, único en auth.users. Si ya existe, NO
    // se crea otra cuenta: se agrega el rol en el restaurante destino (reuse). La
    // contraseña del existente NO se toca — un admin de otro local no puede resetear
    // las credenciales de una persona ya registrada. El respaldo DB es la constraint
    // EXCLUDE (mig 166): la misma cédula/username no puede caer en dos user_id.
    let existingUserId = null, existingName = null;
    const lookupResp = await httpsGet(
      `${SUPABASE_URL}/rest/v1/user_roles?email=eq.${encodeURIComponent(email)}&select=user_id,restaurant_id,role,display_name`,
      { 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY }
    );
    const existingRows = Array.isArray(lookupResp.data) ? lookupResp.data : [];
    if (existingRows.length > 0) {
      existingUserId = existingRows[0].user_id;
      existingName = (existingRows.find(r => r.display_name) || {}).display_name || null;
    }

    let newUserId, reused = false;
    if (existingUserId) {
      // Ya registrada en ESTE restaurante con ESTE rol → 409 (duplicado exacto).
      const dupHere = existingRows.some(r =>
        (r.restaurant_id || null) === (finalRestaurantId || null) && r.role === role);
      if (dupHere) {
        res.status(409).json({ error: 'Esta persona ya está registrada en este restaurante con ese rol.' }); return;
      }
      if (isEmployee) {
        // ── REUSE por CÉDULA: identidad fuerte 1:1 con la persona → se la vincula
        //    a este restaurante reusando su usuario. El email sintético
        //    `${cedula}@mythos.internal` YA identifica la cédula POR CONSTRUCCIÓN
        //    (el lookup de arriba se hizo por ese email). Antes chequeábamos la
        //    columna `user_roles.cedula`, pero en filas creadas antes de poblarla
        //    (NULL) daba un falso "Esa identidad ya está en uso" que bloqueaba, por
        //    ejemplo, agregar el mismo empleado con otro rol (mozo → gerente).
        //    Se confía en el match por email (namespace reservado a cédulas).
        newUserId = existingUserId;
        reused = true;
      } else if (body.link_existing === true) {
        // Vínculo EXPLÍCITO de un admin/owner existente a otro restaurante (futuro
        // multi-local de dueños). Requiere opt-in del caller — nunca implícito.
        newUserId = existingUserId;
        reused = true;
      } else {
        // Admin/owner: el username NO identifica unívocamente a una persona (dos
        // personas distintas podrían pedir el mismo nick). NO se reusa en silencio
        // (sería quedarse con la cuenta de otra persona) → se BLOQUEA.
        res.status(409).json({ error: 'Ese nombre de usuario ya está en uso. Elegí otro.' }); return;
      }
    } else {
      // ── Alta nueva: crear la cuenta en auth.users ──
      const createResp = await httpsPost(
        `${SUPABASE_URL}/auth/v1/admin/users`,
        { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY },
        JSON.stringify({ email, password, email_confirm: true, user_metadata: { display_name: display_name || usernameClean, username: usernameClean } })
      );
      if (!createResp.ok) {
        const msg  = createResp.data?.msg || createResp.data?.message || JSON.stringify(createResp.data);
        const code = createResp.data?.error_code || createResp.data?.code || '';
        // email_exists SIN fila en user_roles = cuenta huérfana (no debería ocurrir:
        // el alta es atómica con rollback). Mensaje claro; no reusamos a ciegas.
        if (/already.*regist|email_exists|user_already_exists/i.test(`${msg} ${code}`)) {
          res.status(409).json({ error: isEmployee ? 'Esa cédula ya tiene una cuenta pero sin rol asignado. Avisá al superadmin.' : 'Ese nombre de usuario ya está en uso. Elegí otro.' }); return;
        }
        res.status(400).json({ error: `Error al crear usuario: ${msg}` }); return;
      }
      newUserId = createResp.data.id;
    }

    // Insertar en user_roles
    const roleInsertResp = await httpsPost(
      `${SUPABASE_URL}/rest/v1/user_roles`,
      { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY, 'Prefer': 'return=representation' },
      JSON.stringify({ user_id: newUserId, username: usernameClean, display_name: display_name || usernameClean, role, restaurant_id: finalRestaurantId, email, cedula: cedulaDigits, recovery_email: recoveryEmail, is_active: true })
    );
    if (!roleInsertResp.ok) {
      const roleErr = roleInsertResp.data;
      // Rollback: si creamos la cuenta auth recién ahora, borrarla. En REUSE la
      // cuenta es compartida (existía antes) → NUNCA se borra.
      if (!reused) {
        await httpsDelete(`${SUPABASE_URL}/auth/v1/admin/users/${newUserId}`,
          { 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY });
      }
      res.status(400).json({ error: roleErr?.message || 'Error al asignar rol' }); return;
    }
    // id de la fila de rol recién creada — para rollback quirúrgico (no tocar las
    // filas de la misma persona en otros restaurantes).
    const newRoleRow = Array.isArray(roleInsertResp.data) ? roleInsertResp.data[0] : roleInsertResp.data;
    const newRoleRowId = newRoleRow && newRoleRow.id;

    // AUTH-1: forzar cambio de contraseña en el primer ingreso. El admin/superadmin
    // eligió la contraseña (genérica/temporal); el usuario debe crear la suya antes
    // de entrar al panel. Por defecto SIEMPRE se fuerza; pasar force_password_change:
    // false (explícito) lo desactiva si en el futuro se crea con contraseña final.
    // Si el flag no se puede crear, NO dejar el usuario a medias: rollback total.
    // En REUSE no se toca la seguridad de la cuenta existente (ya tiene contraseña
    // propia): sólo se fuerza el cambio en ALTAS nuevas con contraseña genérica.
    const forcePwdChange = !reused && body.force_password_change !== false;
    if (forcePwdChange) {
      const flagResp = await httpsPost(
        `${SUPABASE_URL}/rest/v1/user_security_flags`,
        { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        JSON.stringify({ user_id: newUserId, must_change_password: true, forced_reason: 'initial_generic_password' })
      );
      if (!flagResp.ok) {
        if (newRoleRowId) {
          await httpsDelete(`${SUPABASE_URL}/rest/v1/user_roles?id=eq.${newRoleRowId}`,
            { 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY });
        }
        await httpsDelete(`${SUPABASE_URL}/auth/v1/admin/users/${newUserId}`,
          { 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY });
        res.status(500).json({ error: 'No se pudo configurar la cuenta (seguridad). Intentá de nuevo.' }); return;
      }
      // Correo cargado por el jefe en un ALTA nueva → el empleado debe confirmarlo
      // en su primer ingreso. Escritura BEST-EFFORT y SEPARADA del flag crítico de
      // arriba: la fila ya existe (merge-duplicates la actualiza). Si la columna
      // must_confirm_email aún no existe (mig 172 sin aplicar), el 400 se ignora y
      // el alta NO se revierte — la confirmación simplemente no se activa hasta migrar.
      if (recoveryEmail) {
        await httpsPost(
          `${SUPABASE_URL}/rest/v1/user_security_flags`,
          { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          JSON.stringify({ user_id: newUserId, must_confirm_email: true })
        ).catch(() => {});
      }
    }

    // Riders: además de la cuenta auth + user_roles, crear su ficha operativa en
    // delivery_riders vinculada por user_id. El panel rider la resuelve con auth.uid()
    // (login por correo+contraseña, sin PIN — ver migración 101).
    if (role === 'rider') {
      const riderInsertResp = await httpsPost(
        `${SUPABASE_URL}/rest/v1/delivery_riders`,
        { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY, 'Prefer': 'return=representation' },
        JSON.stringify({
          restaurant_id: finalRestaurantId,
          user_id: newUserId,
          name: display_name || usernameClean,
          phone: riderPhone,
          vehicle: riderVehicle,
          commission_type: riderCommType,
          commission_value: riderCommValue,
          cedula: cedulaDigits,
          active: true,
          // M9: nace OFFLINE, no 'disponible'. Recién se pone en línea cuando el
          // rider entra a su panel y se activa; así el despacho (mig 156) no le
          // manda pedidos antes del primer login ("rider fantasma"). El default
          // de la columna también es 'offline' (mig 158) como respaldo API-proof.
          current_status: 'offline'
        })
      );
      if (!riderInsertResp.ok) {
        const rErr = riderInsertResp.data;
        // Rollback quirúrgico: borrar SÓLO la fila de rol recién creada (no las de la
        // misma persona en otros restaurantes). La cuenta auth se borra únicamente si
        // la creamos en esta alta (en REUSE es compartida → NO se toca).
        if (newRoleRowId) {
          await httpsDelete(`${SUPABASE_URL}/rest/v1/user_roles?id=eq.${newRoleRowId}`,
            { 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY });
        }
        if (!reused) {
          await httpsDelete(`${SUPABASE_URL}/auth/v1/admin/users/${newUserId}`,
            { 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY });
        }
        res.status(400).json({ error: (rErr && (rErr.message || rErr.msg)) || 'Error al crear la ficha del rider' });
        return;
      }
    }

    res.status(200).json({ success: true, reused, user_id: newUserId, username: usernameClean, email, must_change_password: forcePwdChange, must_confirm_email: !!(recoveryEmail && forcePwdChange), linked_name: reused ? existingName : undefined });
  } catch(e) {
    res.status(500).json({ error: e.message || 'Error interno del servidor' });
  }
};
