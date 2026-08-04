// ════════════════════════════════════════════════════════════════════
// /clientes — capa de datos.
// ────────────────────────────────────────────────────────────────────
// Fuente única de acceso a Supabase para la app de comensales. Ninguna
// pantalla arma sus propias queries (mismo criterio que shared/clientes.js
// y shared/marketing.js).
//
// TODO pasa por RPC, y no es una preferencia de estilo:
//   • `restaurants` está tenant-scoped para authenticated desde la mig 103.
//     Un comensal NO tiene fila en user_roles, así que un .select() directo
//     le devolvería CERO restaurantes.
//   • Agregar en el navegador sobre un .limit() es el error que las migs 197
//     y 198 ya tuvieron que arreglar dos veces: el número empeora cuanto más
//     crece el negocio.
// ════════════════════════════════════════════════════════════════════

/* ── Cliente Supabase ────────────────────────────────────────────── */
// storageKey PROPIO y persistSession:true (§8.4 del diseño).
//   • Con el storageKey por defecto compartiría la ranura del token con el
//     staff: un dueño que abre /clientes en su celular le PISA la sesión de
//     /admin, y el logout de uno cierra el otro (la arquitectura de sesión es
//     de signOut global).
//   • persistSession:true porque es el primer panel de cliente que SÍ tiene
//     cuenta. El del QR sigue con persistSession:false a propósito.
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
        storageKey: 'mythos-cliente-app'
      }
    });
  } catch (e) { return null; }
}

export const db = initDB();

/* ── Token de dispositivo (Camino A del §5.2) ────────────────────── */
// Se guarda en localStorage con una clave SIN prefijo de restaurante, porque
// identifica a la persona, no a un local. Lo leen el QR de mesa y el delivery
// para reclamar el pedido recién creado.
export const DEVICE_TOKEN_KEY = 'mythos_diner_token';

export function getDeviceToken() {
  try { return localStorage.getItem(DEVICE_TOKEN_KEY) || ''; } catch (_) { return ''; }
}
export function setDeviceToken(t) {
  try { if (t) localStorage.setItem(DEVICE_TOKEN_KEY, t); } catch (_) {}
}
export function clearDeviceToken() {
  try { localStorage.removeItem(DEVICE_TOKEN_KEY); } catch (_) {}
}

/* ── Helper de RPC ───────────────────────────────────────────────── */
// Devuelve { data, error, missing }. `missing` = la migración 200 no está
// aplicada todavía: la app degrada con un cartel claro en vez de romperse
// (mismo patrón deploy-safe que el front de la mig 199).
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

/* ── Sesión ──────────────────────────────────────────────────────── */
export async function getSession() {
  if (!db) return null;
  try { const { data } = await db.auth.getSession(); return data?.session || null; }
  catch (_) { return null; }
}

// El login con contraseña no recarga la página: sin esto la sesión queda abierta
// pero la pantalla se queda en el formulario.
export function onAuthChange(cb) {
  if (!db) return () => {};
  let sub = null;
  try { sub = db.auth.onAuthStateChange((event, session) => cb(event, session))?.data?.subscription; }
  catch (_) {}
  return () => { try { sub && sub.unsubscribe(); } catch (_) {} };
}

export async function signInWithGoogle() {
  if (!db) throw new Error('Sin conexión.');
  const redirectTo = window.location.origin + window.location.pathname;
  const { error } = await db.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
  if (error) throw error;
}

/* ── CAPTCHA ─────────────────────────────────────────────────────── */
// El proyecto tiene Turnstile PRENDIDO en Supabase Auth: sin captchaToken el
// server rebota con "captcha protection: request disallowed" y el usuario ve un
// error que no puede corregir. El widget lo monta la pantalla de acceso; acá
// sólo se espera el token. El token es de UN SOLO USO → reset() después de cada
// intento, exitoso o no, o el segundo intento se rechaza con datos correctos.
async function captcha() {
  const c = window.MythosCaptcha;
  if (!c) return undefined;                       // Turnstile no cargó: que decida el server.
  const t = await c.waitToken();
  return t || undefined;
}
function captchaReset() {
  try { window.MythosCaptcha && window.MythosCaptcha.reset(); } catch (_) {}
}

/* ── Login con contraseña ────────────────────────────────────────── */
// Decisión de Renato (2026-08-03): login normal, correo + contraseña. El link
// mágico quedó SÓLO para recuperar (resetPassword). Ver §3.3 del doc de diseño,
// que documenta el criterio anterior y por qué se cambió.
export async function signInWithPassword(email, password) {
  if (!db) throw new Error('Sin conexión.');
  const captchaToken = await captcha();
  const { data, error } = await db.auth.signInWithPassword({
    email: String(email || '').trim(),
    password: String(password || ''),
    options: { captchaToken }
  });
  captchaReset();
  if (error) throw error;
  return data;
}

// Devuelve { needsConfirm } — si el proyecto tiene "Confirm email" PRENDIDO,
// signUp NO devuelve sesión y hay que avisar que revise el correo. Con el ajuste
// apagado entra derecho. Los dos modos se manejan sin tocar código (mismo
// criterio que registro.html).
export async function signUpWithPassword(email, password, fullName) {
  if (!db) throw new Error('Sin conexión.');
  const captchaToken = await captcha();
  const redirectTo = window.location.origin + window.location.pathname;
  const { data, error } = await db.auth.signUp({
    email: String(email || '').trim(),
    password: String(password || ''),
    options: {
      captchaToken,
      emailRedirectTo: redirectTo,
      data: { full_name: String(fullName || '').trim() }
    }
  });
  captchaReset();
  if (error) throw error;
  return { needsConfirm: !data?.session };
}

export async function resetPassword(email) {
  if (!db) throw new Error('Sin conexión.');
  const captchaToken = await captcha();
  const redirectTo = window.location.origin + window.location.pathname;
  const { error } = await db.auth.resetPasswordForEmail(String(email || '').trim(), {
    captchaToken, redirectTo
  });
  captchaReset();
  if (error) throw error;
}

// Se usa en la pantalla a la que aterriza el enlace de recuperación: ahí Supabase
// ya dejó una sesión abierta (detectSessionInUrl), así que alcanza con updateUser.
export async function updatePassword(password) {
  if (!db) throw new Error('Sin conexión.');
  const { error } = await db.auth.updateUser({ password: String(password || '') });
  if (error) throw error;
}

export async function signOut() {
  if (!db) return;
  // scope 'local': cerrar /clientes NO debe cerrarle la sesión de /admin a un
  // dueño que tiene los dos sombreros en la misma cuenta (§8.1).
  try { await db.auth.signOut({ scope: 'local' }); } catch (_) {}
  clearDeviceToken();
}

/* ── App ─────────────────────────────────────────────────────────── */
export const bootstrap        = ()                    => rpc('diner_bootstrap');
export const ensureDiner      = (name, avatar)        => rpc('ensure_my_diner', { p_display_name: name || null, p_avatar_url: avatar || null });
export const saveProfile      = (payload)             => rpc('diner_save_profile', { p_payload: payload });
export const issueToken       = (kind)                => rpc('diner_issue_token', { p_kind: kind });
export const discover         = (f = {})              => rpc('diner_discover', {
                                                            p_search: f.search || null, p_city: f.city || null,
                                                            p_service: f.service || null, p_type: f.type || null,
                                                            p_limit: f.limit || 60 });
/* ── Vitrina PÚBLICA (mig 201) ───────────────────────────────────── */
// Se navega SIN sesión: descubrir y entrar a pedir es el mismo camino que ya
// tiene cualquiera con el QR o el link de delivery. La cuenta no da permiso de
// pedir, da IDENTIDAD (XP, reseñas, ranking, beneficios).
//
// Van por RPC propia y no por `discover`: `diner_discover` está otorgada sólo a
// `authenticated`, y `restaurants` quedó tenant-scoped para `anon` en la mig
// 103 — un visitante sin cuenta no vería NI UN local. `diner_browse_public` es
// SECURITY DEFINER y devuelve sólo lo que ya es público de un negocio.
export const browsePublic = (f = {}) => rpc('diner_browse_public', {
  p_search: f.search || null, p_city: f.city || null,
  p_type:   f.type   || null, p_limit: f.limit || 60
});
export const placePublic  = (id) => rpc('diner_place_public', { p_restaurant: id });
export const publicConfig = ()   => rpc('diner_public_config');

// Rankings públicos (mig 205). Van aparte de `leaderboard` porque ésa está
// otorgada sólo a `authenticated` y devuelve `is_me` y el puesto propio, que
// sin sesión no significan nada.
export const topPlaces = (scope, period, city, limit) =>
  rpc('restaurant_leaderboard_public', {
    p_scope: scope || 'country', p_period: period || 'all',
    p_city: city || null, p_limit: limit || 30
  });
export const topDiners = (scope, period, city, limit) =>
  rpc('diner_leaderboard_public', {
    p_scope: scope || 'country', p_period: period || 'all',
    p_city: city || null, p_limit: limit || 30
  });

export const myOrders         = (limit)               => rpc('diner_my_orders', { p_limit: limit || 60 });
export const submitReview     = (payload)             => rpc('diner_submit_review', { p_payload: payload });
export const voteReview       = (id, kind, on)        => rpc('diner_vote_review', { p_review: id, p_kind: kind, p_on: on !== false });
export const restaurantReviews= (id, limit)           => rpc('diner_restaurant_reviews', { p_restaurant: id, p_limit: limit || 30 });
export const profile          = ()                    => rpc('diner_profile');
export const refreshAchievements = ()                 => rpc('diner_refresh_achievements');
export const leaderboard      = (scope, period, city) => rpc('diner_leaderboard', {
                                                            p_scope: scope || 'country', p_period: period || 'all',
                                                            p_city: city || null, p_limit: 50 });
export const toggleFavorite   = (rid, item, label)    => rpc('diner_toggle_favorite', {
                                                            p_restaurant: rid, p_item: item || null, p_label: label || null });

/* ── Catálogos ───────────────────────────────────────────────────── */
export async function loadQuestions() {
  if (!db) return [];
  try {
    const { data, error } = await db.from('diner_profile_questions')
      .select('code,label,help,kind,options,is_required,step,sort_order')
      .eq('is_active', true).order('step').order('sort_order');
    return error ? [] : (data || []);
  } catch (_) { return []; }
}

export async function loadMyAnswers() {
  if (!db) return {};
  try {
    const { data, error } = await db.from('diner_profile_answers').select('code,value');
    if (error || !data) return {};
    const out = {};
    data.forEach(r => { out[r.code] = r.value; });
    return out;
  } catch (_) { return {}; }
}

export async function loadDimensions() {
  if (!db) return [];
  try {
    const { data, error } = await db.from('review_dimensions')
      .select('code,label,emoji,description,applies_to,sort_order')
      .eq('is_active', true).order('sort_order');
    return error ? [] : (data || []);
  } catch (_) { return []; }
}

/* ── Fotos de reseña ─────────────────────────────────────────────── */
// La carpeta es el auth uid: la policy del bucket exige que el primer
// segmento del path sea el uid de quien sube (si no, cualquiera pisa la foto
// de cualquiera).
export async function uploadReviewPhoto(file, reviewId) {
  if (!db || !file) return null;
  try {
    const { data: { user } } = await db.auth.getUser();
    if (!user) return null;
    const ext  = (file.name || 'foto.jpg').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const path = `${user.id}/${reviewId}-${Date.now()}.${ext}`;
    const { error } = await db.storage.from('resenas').upload(path, file, { upsert: false });
    if (error) return null;
    const { data: pub } = db.storage.from('resenas').getPublicUrl(path);
    const url = pub?.publicUrl || path;
    // La fila queda 'pending': el XP de la foto se acredita recién al aprobarla.
    await db.from('diner_review_photos').insert({
      review_id: reviewId, diner_id: (await rpc('diner_profile')).data?.diner?.id || null,
      storage_path: url
    });
    return url;
  } catch (_) { return null; }
}

/* ── Carritos abiertos ───────────────────────────────────────────── */
// El pedido se hace en el panel del QR (index.html) / delivery-cliente, que
// guardan el carrito en localStorage con la clave `${restaurantId}:app_cart`.
// Acá NO se reimplementa el flujo de pedido: se lee lo que ya está guardado y
// se ofrece volver a donde el carrito quedó abierto.
export function openCarts() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.endsWith(':app_cart')) continue;
      const rid = k.slice(0, -':app_cart'.length);
      if (!rid || rid === '_nolocal_') continue;
      let items = [];
      try { items = JSON.parse(localStorage.getItem(k) || '[]'); } catch (_) { items = []; }
      if (!Array.isArray(items) || items.length === 0) continue;
      const count = items.reduce((s, ci) => s + (ci.qty || 1), 0);
      const total = items.reduce((s, ci) => s + (ci.total || 0), 0);
      out.push({ restaurant_id: rid, count, total });
    }
  } catch (_) {}
  return out;
}

/* ── Links a los paneles de pedido ───────────────────────────────── */
// Se sale de /clientes hacia el panel que YA sabe pedir. No se duplica menú,
// carrito ni checkout: eso vive en index.html / delivery-cliente.html y
// cualquier copia se desincronizaría al primer cambio de precios.
// UN SOLO destino para pedir de afuera, y no es una simplificación: domicilio y
// retiro son la misma pantalla. `delivery-cliente.html` abre con las dos
// opciones y hasta ofrece el retiro solo cuando la dirección queda fuera de
// cobertura. Mandar el retiro a `index.html` (el menú del QR) era el bug que
// hacía que "Pedir para retirar" cayera en el mismo lugar que el salón.
//
// OJO con `dine_in`: NO hay link de pedido para comer en el salón, y es a
// propósito. El pedido de salón necesita saber QUÉ MESA es, y eso sólo lo sabe
// el QR pegado a la mesa. Un botón de "pedir" a distancia mandaría comandas a
// la cocina de gente que no está sentada en el local. Para el salón la vitrina
// muestra información (carta en PDF, dirección, horarios), no un carrito.
export function orderUrl(restaurantId, service) {
  const r = encodeURIComponent(restaurantId);
  if (service === 'dine_in') return `/index.html?r=${r}`;
  // La reserva ya vive en el panel de delivery (pantalla de bienvenida). Se
  // entra derecho con ?reserva=1 en vez de reimplementarla acá.
  if (service === 'reserva') return `/delivery-cliente.html?r=${r}&reserva=1`;
  return `/delivery-cliente.html?r=${r}`;
}

// Mapa: si el local cargó coordenadas se abre el punto exacto; si no, la
// búsqueda por dirección. Sin ninguno de los dos no se muestra el botón —
// mandar a Google Maps con una cadena vacía deja al comensal en cualquier lado.
export function mapsUrl(r) {
  if (!r) return null;
  if (r.lat != null && r.lng != null) return `https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lng}`;
  const q = [r.name, r.address, r.city].filter(Boolean).join(', ');
  return q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : null;
}

export function socialUrl(kind, value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  const handle = v.replace(/^@/, '');
  if (kind === 'instagram') return `https://instagram.com/${handle}`;
  if (kind === 'facebook')  return `https://facebook.com/${handle}`;
  if (kind === 'whatsapp')  return `https://wa.me/${v.replace(/[^\d]/g, '')}`;
  return `https://${v}`;
}
