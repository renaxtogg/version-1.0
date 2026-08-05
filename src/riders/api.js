// ════════════════════════════════════════════════════════════════════
// /riders — capa de datos de la Red de Riders Mythos.
// ────────────────────────────────────────────────────────────────────
// Fuente única de acceso a Supabase para esta app (mismo criterio que
// src/clientes/api.js y src/shared/clientes.js). Ninguna pantalla arma sus
// propias queries.
//
// TODO pasa por RPC, y no es preferencia de estilo: un rider de la red NO
// tiene fila en `user_roles`, así que un .select() directo sobre
// `restaurants` o `delivery_orders` le devolvería CERO filas (tenant-scoping
// de las migs 092/103). Las RPC de la mig 206 son su única puerta.
// ════════════════════════════════════════════════════════════════════

/* ── Cliente Supabase ────────────────────────────────────────────── */
// storageKey PROPIO: con el del staff, un dueño que abre /riders en su
// celular le pisa la sesión de /admin (la arquitectura de sesión es de
// signOut global). Mismo motivo por el que /clientes usa el suyo.
function initDB() {
  const cfg = window.SUPABASE_CONFIG;
  if (!cfg || !cfg.url || !cfg.anonKey) return null;
  const url = String(cfg.url).replace(/^﻿/, '').trim();
  const key = String(cfg.anonKey).replace(/^﻿/, '').trim();
  if (!url || url.includes('YOUR_') || !key) return null;
  try {
    return window.supabase.createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'mythos-rider-app'
      }
    });
  } catch (e) { return null; }
}

export const db = initDB();

/* ── Helper de RPC ───────────────────────────────────────────────── */
// Devuelve { data, error, missing }. `missing` = la migración 206 no está
// aplicada: la app degrada con un cartel claro en vez de romperse (mismo
// patrón deploy-safe que el front de las migs 199/201).
export async function rpc(name, args) {
  if (!db) return { data: null, error: new Error('sin conexión'), missing: false };
  try {
    const { data, error } = await db.rpc(name, args || {});
    if (error) {
      const m = `${error.message || ''} ${error.code || ''}`;
      const missing = /PGRST202|could not find the function|42883|does not exist/i.test(m);
      return { data: null, error, missing };
    }
    return { data, error: null, missing: false };
  } catch (e) {
    return { data: null, error: e, missing: false };
  }
}

/* ── Mensajes de Auth en castellano ──────────────────────────────── */
// No es cosmética: "Invalid login credentials" en inglés hace creer que la app
// se rompió y no que se erró la contraseña.
export function authMsg(e) {
  const m = String(e?.message || e || '');
  if (/invalid login credentials/i.test(m))        return 'Correo o contraseña incorrectos.';
  if (/email not confirmed/i.test(m))              return 'Confirmá tu correo antes de entrar: te mandamos un enlace cuando creaste la cuenta.';
  if (/user already registered|already been reg/i.test(m)) return 'Ese correo ya tiene cuenta. Entrá con tu contraseña.';
  if (/password should be at least/i.test(m))      return 'La contraseña necesita al menos 6 caracteres.';
  if (/captcha/i.test(m))                          return 'No pudimos verificar que sos una persona. Esperá a que cargue el recuadro de seguridad y probá de nuevo.';
  if (/rate limit|too many/i.test(m))              return 'Demasiados intentos seguidos. Esperá un minuto.';
  if (/for security purposes/i.test(m))            return 'Esperá unos segundos antes de volver a intentar.';
  return m || 'No pudimos completar la operación.';
}

/* ── Sesión ──────────────────────────────────────────────────────── */
export async function getSession() {
  if (!db) return null;
  try { const { data } = await db.auth.getSession(); return data?.session || null; }
  catch (_) { return null; }
}

export function onAuthChange(cb) {
  if (!db) return () => {};
  const { data } = db.auth.onAuthStateChange((ev, s) => cb(ev, s));
  return () => { try { data?.subscription?.unsubscribe(); } catch (_) {} };
}

async function captcha() {
  try { return (await window.MythosCaptcha?.waitToken(12000)) || ''; }
  catch (_) { return ''; }
}
function resetCaptcha() { try { window.MythosCaptcha?.reset(); } catch (_) {} }

export async function signUpWithPassword(email, password) {
  const captchaToken = await captcha();
  const { data, error } = await db.auth.signUp({
    email: String(email || '').trim().toLowerCase(),
    password,
    options: { captchaToken, emailRedirectTo: window.location.origin + '/riders' }
  });
  resetCaptcha();
  if (error) throw error;
  // Sin sesión inmediata = el proyecto pide confirmar el correo.
  return { needsConfirm: !data?.session };
}

export async function signInWithPassword(email, password) {
  const captchaToken = await captcha();
  const { error } = await db.auth.signInWithPassword({
    email: String(email || '').trim().toLowerCase(), password, options: { captchaToken }
  });
  resetCaptcha();
  if (error) throw error;
}

export async function resetPassword(email) {
  const captchaToken = await captcha();
  const { error } = await db.auth.resetPasswordForEmail(
    String(email || '').trim().toLowerCase(),
    { captchaToken, redirectTo: window.location.origin + '/riders' });
  resetCaptcha();
  if (error) throw error;
}

// El enlace del correo ya dejó una sesión de recuperación abierta
// (detectSessionInUrl), así que acá alcanza con updateUser — igual que en
// /clientes. Sin esta función, el enlace de "olvidé mi contraseña" te devuelve
// a la app logueado pero SIN forma de poner la contraseña nueva.
export async function updatePassword(password) {
  const { error } = await db.auth.updateUser({ password: String(password || '') });
  if (error) throw error;
}

export async function signOut() {
  try { await db?.auth.signOut(); } catch (_) {}
}

/* ── RPC de la red (mig 206) ─────────────────────────────────────── */
export const publicConfig      = ()             => rpc('rider_public_config');
export const ensureRider       = ()             => rpc('ensure_my_rider');
export const myProfile         = ()             => rpc('my_rider_profile');
export const saveDraft         = (payload)      => rpc('save_my_rider_draft', { payload });
export const submitApplication = (version, ip, ua) =>
  rpc('submit_my_rider_application', { p_contract_version: version, p_accept: true, p_ip: ip, p_user_agent: ua });
export const registerDocument  = (slug, path, mime, issued, expires) =>
  rpc('rider_register_document', { p_slug: slug, p_path: path, p_mime: mime || null,
                                   p_issued_at: issued || null, p_expires_at: expires || null });
export const setAvailability   = (s)            => rpc('rider_set_availability', { p_status: s });
export const pingLocation      = (lat, lng)     => rpc('rider_ping_location', { p_lat: lat, p_lng: lng });
export const networkPlaces     = (search)       => rpc('rider_network_places', { p_search: search || null });
export const joinPlace         = (id)           => rpc('rider_join_place', { p_restaurant_id: id });
export const leavePlace        = (id)           => rpc('rider_leave_place', { p_restaurant_id: id });
export const myHistory         = (from, to)     => rpc('rider_my_history', { p_from: from || null, p_to: to || null });
export const leaderboard       = (scope, city)  => rpc('rider_leaderboard', { p_scope: scope || 'mes', p_city: city || null, p_limit: 20 });
export const markNotifsRead    = ()             => rpc('rider_mark_notifications_read');
export const markTrainingDone  = ()             => rpc('rider_mark_training_done');
export const openCase          = (payload)      => rpc('open_rider_case', { payload });
export const caseDetail        = (id)           => rpc('rider_case_detail', { p_case_id: id });
export const addCaseMessage    = (id, body, f)  => rpc('add_rider_case_message', { p_case_id: id, p_body: body, p_file_path: f || null });

/* ── Archivos ────────────────────────────────────────────────────── */
// Los documentos van al bucket PRIVADO `rider-docs`, en la carpeta del propio
// auth.uid() — la policy de la mig 206 sólo acepta esa ruta. La foto de perfil
// va al bucket público `riders`: la ve el cliente que espera su pedido.
function ext(file) {
  const n = String(file?.name || '');
  const e = n.includes('.') ? n.split('.').pop().toLowerCase() : 'jpg';
  return e.replace(/[^a-z0-9]/g, '') || 'jpg';
}

export async function uploadDoc(file, slug) {
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new Error('sin sesión');
  const path = `${user.id}/${slug}-${Date.now()}.${ext(file)}`;
  const { error } = await db.storage.from('rider-docs')
    .upload(path, file, { upsert: false, contentType: file.type || undefined });
  if (error) throw error;
  return path;
}

export async function uploadPhoto(file) {
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new Error('sin sesión');
  const path = `${user.id}/perfil-${Date.now()}.${ext(file)}`;
  const { error } = await db.storage.from('riders')
    .upload(path, file, { upsert: true, contentType: file.type || undefined });
  if (error) throw error;
  return db.storage.from('riders').getPublicUrl(path).data.publicUrl;
}

// El bucket de documentos es privado: para verlos hace falta una URL firmada,
// que caduca. Es a propósito — un enlace de una cédula no puede quedar vivo.
export async function signedDoc(path, seconds = 300) {
  if (!path) return null;
  const { data, error } = await db.storage.from('rider-docs').createSignedUrl(path, seconds);
  if (error) return null;
  return data?.signedUrl || null;
}

/* ── IP del postulante para el comprobante del contrato ──────────── */
// Sale de /api/rider-ip (mismo origen) y NO de un servicio externo tipo
// ipify: el `connect-src` del CSP (vercel.json) sólo admite 'self', Supabase,
// Google Maps, Nominatim y Turnstile — cualquier otro host lo bloquea el
// navegador y la llamada nunca sale. El endpoint devuelve la IP que ve Vercel.
//
// Alcance honesto de este dato: la manda el navegador dentro del payload, así
// que sirve como registro de la aceptación, no como prueba forense de origen.
// Best-effort además: si falla, el contrato se registra igual — la fecha, la
// versión y el agente ya identifican la aceptación, y no se va a bloquear una
// postulación por no poder leer una IP.
export async function clientIp() {
  try {
    const r = await fetch('/api/rider-ip', { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.ip || null;
  } catch (_) { return null; }
}
