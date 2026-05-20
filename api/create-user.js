// Vercel serverless function — gestión segura de usuarios con Supabase Admin API
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  try { return await _handler(req, res); }
  catch(e) { return res.status(500).json({ error: e.message || 'Error interno del servidor' }); }
}

async function _handler(req, res) {

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Servidor no configurado — falta SUPABASE_SERVICE_ROLE_KEY' });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'No autenticado' });

  // Verificar sesión del caller
  const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'Authorization': authHeader, 'apikey': ANON_KEY }
  });
  if (!userResp.ok) return res.status(401).json({ error: 'Sesión inválida' });
  const caller = await userResp.json();
  const callerId = caller.id;
  if (!callerId) return res.status(401).json({ error: 'Sesión inválida' });

  // Verificar rol del caller
  const roleResp = await fetch(
    `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${callerId}&select=role,restaurant_id&limit=1`,
    { headers: { 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY } }
  );
  const roles = await roleResp.json();
  if (!Array.isArray(roles) || roles.length === 0) {
    return res.status(403).json({ error: 'Sin permisos para crear usuarios' });
  }
  const callerRole = roles[0];

  const { username, password, display_name, role, restaurant_id } = req.body || {};

  if (!username || typeof username !== 'string' || username.trim().length < 2) {
    return res.status(400).json({ error: 'Nombre de usuario requerido (mínimo 2 caracteres)' });
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Contraseña requerida (mínimo 6 caracteres)' });
  }
  if (!role) return res.status(400).json({ error: 'Rol requerido' });

  const ADMIN_ROLES = ['cajero', 'mozo', 'cocina', 'rider', 'supervisor_local'];
  const ALL_ROLES = ['superadmin', 'admin', 'cajero', 'mozo', 'cocina', 'rider', 'supervisor_local'];

  if (callerRole.role === 'admin') {
    if (!ADMIN_ROLES.includes(role)) {
      return res.status(403).json({ error: 'Solo podés asignar roles de empleado (cajero, mozo, cocina, rider, supervisor_local)' });
    }
    const targetRestaurant = restaurant_id || callerRole.restaurant_id;
    if (targetRestaurant !== callerRole.restaurant_id) {
      return res.status(403).json({ error: 'Solo podés crear usuarios para tu restaurante' });
    }
  } else if (callerRole.role === 'superadmin') {
    if (!ALL_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }
  } else {
    return res.status(403).json({ error: 'Sin permisos para crear usuarios' });
  }

  const usernameClean = username.trim().toLowerCase();
  const email = `${usernameClean.replace(/[^a-z0-9._-]/g, '')}@mythos.internal`;

  // Crear usuario en auth.users
  const createResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      'apikey': SERVICE_ROLE_KEY
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: display_name || username, username: usernameClean }
    })
  });

  const created = await createResp.json();
  if (!createResp.ok) {
    const msg = created.msg || created.message || JSON.stringify(created);
    return res.status(400).json({ error: `Error al crear usuario: ${msg}` });
  }

  const newUserId = created.id;

  // Asignar rol en user_roles
  const finalRestaurantId = (callerRole.role === 'admin')
    ? callerRole.restaurant_id
    : (restaurant_id || null);

  const roleInsertResp = await fetch(`${SUPABASE_URL}/rest/v1/user_roles`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      'apikey': SERVICE_ROLE_KEY,
      'Prefer': 'return=representation'
    },
    body: JSON.stringify({
      user_id: newUserId,
      username: usernameClean,
      display_name: display_name || username,
      role,
      restaurant_id: finalRestaurantId,
      email,
      is_active: true
    })
  });

  if (!roleInsertResp.ok) {
    const roleErr = await roleInsertResp.json();
    // Rollback: borrar usuario auth
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${newUserId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY }
    });
    return res.status(400).json({ error: roleErr.message || 'Error al asignar rol' });
  }

  return res.status(200).json({ success: true, user_id: newUserId, username: usernameClean, email });
}
