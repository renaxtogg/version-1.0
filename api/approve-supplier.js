// Vercel serverless function — aprobación de proveedores del marketplace B2B
// (PR-MKT-1). Convierte una marketplace_application en: cuenta Auth del
// proveedor + user_roles (role='supplier', restaurant_id=NULL) +
// marketplace_suppliers + marketplace_supplier_contacts +
// marketplace_supplier_users (owner). Atómico con rollback total (patrón
// create-user): si un paso falla se borra todo lo creado.
const https = require('https');
const crypto = require('crypto');
const { checkRateLimit } = require('./_ratelimit');

function httpsRequest(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: data == null ? headers : { ...headers, 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      // `ok` SIEMPRE por status code: un 2xx con cuerpo vacío (Prefer: return=minimal)
      // es éxito, no fallo. El parse del body es best-effort y nunca define `ok`.
      res.on('end', () => {
        let parsed = null;
        try { parsed = buf ? JSON.parse(buf) : null; } catch(_) { parsed = buf; }
        resolve({ ok: res.statusCode < 300, status: res.statusCode, data: parsed });
      });
    });
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}
const httpsGet    = (url, headers)       => httpsRequest('GET', url, headers, null);
const httpsPost   = (url, headers, body) => httpsRequest('POST', url, headers, body);
const httpsPatch  = (url, headers, body) => httpsRequest('PATCH', url, headers, body);
const httpsDelete = (url, headers)       => httpsRequest('DELETE', url, headers, null);

// slug URL-safe desde el nombre comercial: minúsculas, sin acentos ni
// corchetes de simulacro, no-alfanumérico → '-'.
function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'proveedor';
}

module.exports = async function handler(req, res) {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://mythos-pos.vercel.app';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }

  // Anti-flood: cortar ANTES de gastar llamadas salientes a Supabase.
  if (await checkRateLimit(req, res, { key: 'approve-supplier', max: 5, windowSec: 60 })) return;

  try {
    const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/^[﻿\s]+|[\s]+$/g, '');
    const SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').replace(/^[﻿\s]+|[\s]+$/g, '');
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      res.status(500).json({ error: 'Servidor no configurado: falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY' });
      return;
    }
    const SR_HEADERS = { 'Authorization': `Bearer ${SERVICE_ROLE_KEY}`, 'apikey': SERVICE_ROLE_KEY };
    const SR_JSON = { 'Content-Type': 'application/json', ...SR_HEADERS };

    const authHeader = (req.headers['authorization'] || '').trim();
    if (!authHeader) { res.status(401).json({ error: 'No autenticado' }); return; }

    // Validar el token del caller contra Supabase Auth (verifica firma + expiración).
    // NO se decodifica el JWT localmente (payload sin verificar = falsificable).
    const bearer = /^Bearer\s+/i.test(authHeader) ? authHeader : `Bearer ${authHeader}`;
    const authedResp = await httpsGet(`${SUPABASE_URL}/auth/v1/user`, { 'Authorization': bearer, 'apikey': SERVICE_ROLE_KEY });
    if (!authedResp.ok || !authedResp.data || !authedResp.data.id) {
      res.status(401).json({ error: 'Token inválido o expirado' }); return;
    }
    const callerId = authedResp.data.id;

    // SOLO superadmin puede aprobar proveedores.
    const roleResp = await httpsGet(
      `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${callerId}&select=role&is_active=eq.true&limit=1`,
      SR_HEADERS
    );
    const callerRole = Array.isArray(roleResp.data) && roleResp.data[0] ? roleResp.data[0].role : null;
    if (callerRole !== 'superadmin') {
      res.status(403).json({ error: 'Solo el superadmin puede aprobar proveedores' }); return;
    }

    const body = req.body || {};
    const applicationId = String(body.application_id || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const displayNameIn = (typeof body.display_name === 'string' && body.display_name.trim()) ? body.display_name.trim() : null;

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(applicationId)) {
      res.status(400).json({ error: 'application_id inválido' }); return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'email inválido (debe ser el correo real del proveedor)' }); return;
    }

    // Contraseña: la provista o una temporal de 12 chars que se devuelve UNA vez.
    let password = typeof body.password === 'string' ? body.password : '';
    let tempPassword = null;
    if (!password) {
      tempPassword = crypto.randomBytes(9).toString('base64url'); // 12 chars URL-safe
      password = tempPassword;
    } else if (password.length < 8) {
      res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' }); return;
    }

    // ── 1. Traer la application y validar su estado ──
    const appResp = await httpsGet(
      `${SUPABASE_URL}/rest/v1/marketplace_applications?id=eq.${applicationId}&select=*&limit=1`,
      SR_HEADERS
    );
    const app = Array.isArray(appResp.data) && appResp.data[0] ? appResp.data[0] : null;
    if (!app) { res.status(404).json({ error: 'Solicitud no encontrada' }); return; }
    if (app.estado === 'aprobada') {
      res.status(409).json({ error: 'La solicitud ya fue aprobada' }); return;
    }

    // Idempotencia: si ya hay un supplier creado desde esta application, cortar.
    const dupResp = await httpsGet(
      `${SUPABASE_URL}/rest/v1/marketplace_suppliers?application_id=eq.${applicationId}&select=id&limit=1`,
      SR_HEADERS
    );
    if (Array.isArray(dupResp.data) && dupResp.data.length > 0) {
      res.status(409).json({ error: 'Ya existe un proveedor creado desde esta solicitud' }); return;
    }

    // ── 2. Slug único (slugify + sufijo -2, -3… si colisiona) ──
    const baseSlug = slugify(app.nombre_comercial);
    let slug = baseSlug;
    for (let i = 2; i <= 20; i++) {
      const slugResp = await httpsGet(
        `${SUPABASE_URL}/rest/v1/marketplace_suppliers?slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`,
        SR_HEADERS
      );
      if (!Array.isArray(slugResp.data) || slugResp.data.length === 0) break;
      slug = `${baseSlug}-${i}`;
    }

    const displayName = displayNameIn || app.contacto_nombre || app.nombre_comercial;

    // Rollback total: borra en orden inverso todo lo creado hasta el fallo.
    const created = { userId: null, supplierId: null };
    async function rollback() {
      try {
        if (created.supplierId) {
          // supplier_users / contacts / products caen por ON DELETE CASCADE
          await httpsDelete(`${SUPABASE_URL}/rest/v1/marketplace_suppliers?id=eq.${created.supplierId}`, SR_HEADERS);
        }
        if (created.userId) {
          await httpsDelete(`${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${created.userId}`, SR_HEADERS);
          // user_security_flags cae por ON DELETE CASCADE al borrar el auth user
          await httpsDelete(`${SUPABASE_URL}/auth/v1/admin/users/${created.userId}`, SR_HEADERS);
        }
      } catch (_) { /* best-effort: no enmascarar el error original */ }
    }

    // ── 3. Crear cuenta Auth (email REAL confirmado) ──
    const createResp = await httpsPost(
      `${SUPABASE_URL}/auth/v1/admin/users`,
      SR_JSON,
      JSON.stringify({ email, password, email_confirm: true, user_metadata: { display_name: displayName } })
    );
    if (!createResp.ok) {
      const msg  = createResp.data?.msg || createResp.data?.message || JSON.stringify(createResp.data);
      const code = createResp.data?.error_code || createResp.data?.code || '';
      if (/already.*regist|email_exists|user_already_exists/i.test(`${msg} ${code}`)) {
        res.status(409).json({ error: 'Ese correo ya tiene una cuenta en Mythos.' }); return;
      }
      res.status(400).json({ error: `Error al crear usuario: ${msg}` }); return;
    }
    created.userId = createResp.data.id;

    // ── 4. user_roles: supplier de plataforma (restaurant_id = NULL) ──
    const roleInsertResp = await httpsPost(
      `${SUPABASE_URL}/rest/v1/user_roles`,
      { ...SR_JSON, 'Prefer': 'return=representation' },
      JSON.stringify({
        user_id: created.userId, username: email, display_name: displayName,
        role: 'supplier', restaurant_id: null, email, is_active: true
      })
    );
    if (!roleInsertResp.ok) {
      await rollback();
      res.status(400).json({ error: roleInsertResp.data?.message || 'Error al asignar rol supplier (¿migración 142 aplicada?)' });
      return;
    }

    // ── 5. AUTH-1: cambio de contraseña obligatorio en el primer ingreso ──
    const flagResp = await httpsPost(
      `${SUPABASE_URL}/rest/v1/user_security_flags`,
      { ...SR_JSON, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      JSON.stringify({ user_id: created.userId, must_change_password: true, forced_reason: 'supplier_approval_temp_password' })
    );
    if (!flagResp.ok) {
      await rollback();
      res.status(500).json({ error: 'No se pudo configurar la cuenta (seguridad). Intentá de nuevo.' }); return;
    }

    // ── 6. Perfil de tienda desde los datos de la application ──
    const supplierInsertResp = await httpsPost(
      `${SUPABASE_URL}/rest/v1/marketplace_suppliers`,
      { ...SR_JSON, 'Prefer': 'return=representation' },
      JSON.stringify({
        slug,
        nombre_comercial: app.nombre_comercial,
        razon_social:     app.razon_social,
        ruc:              app.ruc,
        tipo_proveedor:   app.tipo_proveedor,
        ciudad:           app.ciudad,
        departamento:     app.departamento,
        categorias:       app.categorias || [],
        zonas_entrega:    app.zonas_entrega || [],
        dias_entrega:     app.dias_entrega,
        pedido_minimo:    app.pedido_minimo,
        delivery_propio:  !!app.delivery_propio,
        retiro_local:     !!app.retiro_local,
        entrega_urgente:  !!app.entrega_urgente,
        acepta_credito:   !!app.acepta_credito,
        emite_factura:    !!app.emite_factura,
        estado:           'activo',
        application_id:   applicationId
      })
    );
    if (!supplierInsertResp.ok || !Array.isArray(supplierInsertResp.data) || !supplierInsertResp.data[0]) {
      await rollback();
      res.status(400).json({ error: supplierInsertResp.data?.message || 'Error al crear el perfil del proveedor' });
      return;
    }
    created.supplierId = supplierInsertResp.data[0].id;

    // ── 7. Contacto (tabla separada, RLS dura) + vínculo usuario-proveedor ──
    const contactResp = await httpsPost(
      `${SUPABASE_URL}/rest/v1/marketplace_supplier_contacts`,
      { ...SR_JSON, 'Prefer': 'return=minimal' },
      JSON.stringify({
        supplier_id: created.supplierId,
        telefono: app.telefono, whatsapp: app.whatsapp,
        email_comercial: app.email || email, contacto_nombre: app.contacto_nombre
      })
    );
    if (!contactResp.ok) {
      await rollback();
      res.status(400).json({ error: 'Error al crear el contacto del proveedor' }); return;
    }

    const linkResp = await httpsPost(
      `${SUPABASE_URL}/rest/v1/marketplace_supplier_users`,
      { ...SR_JSON, 'Prefer': 'return=minimal' },
      JSON.stringify({ user_id: created.userId, supplier_id: created.supplierId, rol_interno: 'owner', is_active: true })
    );
    if (!linkResp.ok) {
      await rollback();
      res.status(400).json({ error: 'Error al vincular el usuario con el proveedor' }); return;
    }

    // ── 8. Marcar la application como aprobada ──
    const patchResp = await httpsPatch(
      `${SUPABASE_URL}/rest/v1/marketplace_applications?id=eq.${applicationId}`,
      { ...SR_JSON, 'Prefer': 'return=minimal' },
      JSON.stringify({ estado: 'aprobada', reviewed_at: new Date().toISOString(), reviewed_by: callerId })
    );
    if (!patchResp.ok) {
      await rollback();
      res.status(400).json({ error: 'Error al actualizar la solicitud' }); return;
    }

    // ── 9. Evento de auditoría (best-effort: no voltea la aprobación) ──
    await httpsPost(
      `${SUPABASE_URL}/rest/v1/marketplace_events`,
      { ...SR_JSON, 'Prefer': 'return=minimal' },
      JSON.stringify({
        event_type: 'supplier_approved', supplier_id: created.supplierId,
        actor_user: callerId, metadata: { application_id: applicationId, slug }
      })
    ).catch(() => {});

    res.status(200).json({
      ok: true,
      supplier_id: created.supplierId,
      user_id: created.userId,
      email,
      slug,
      must_change_password: true,
      ...(tempPassword ? { temp_password: tempPassword } : {})
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Error interno del servidor' });
  }
};
