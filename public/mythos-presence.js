/* ============================================================
 * Mythos Presence — registro simple de conexión del personal.
 *
 * Graba en staff_sessions cuándo cada panel (mozo, caja, cocina, gerente,
 * admin, rider) inicia y cierra sesión. SIN heartbeat (decisión de diseño):
 *   · start() → graba login_at (o reutiliza una sesión abierta reciente).
 *   · stop()  → graba logout_at al desloguear explícitamente.
 *   · Si la pestaña se cierra sin desloguear, la sesión queda abierta y el
 *     admin la verá como "Sin cierre" (puede forzar el cierre).
 *
 * Uso:
 *   - Paneles con login email/clave (auth): incluir <script src="mythos-presence.js">
 *     y listo — auto-arranca en DOMContentLoaded leyendo localStorage + token Supabase.
 *     En el botón "Salir" llamar: window.MythosPresence.stop('manual').
 *   - Panel rider (login por PIN, sin auth): setear window.MYTHOS_PRESENCE_MANUAL=true
 *     ANTES de incluir el script, y llamar start()/stop() a mano.
 *
 * Requiere window.SUPABASE_CONFIG (config.js) y window.supabase cargados antes.
 * ============================================================ */
(function () {
  'use strict';

  var cfg = window.SUPABASE_CONFIG || {};
  if (!cfg.url || !cfg.anonKey || !window.supabase) {
    // Sin config o sin SDK: no rompemos el panel, sólo no registramos presencia.
    window.MythosPresence = window.MythosPresence || { start: noop, stop: noop };
    return;
  }

  function noop() {}

  var url = String(cfg.url).replace(/^﻿/, '').trim();
  var key = String(cfg.anonKey).replace(/^﻿/, '').trim();

  // Cliente propio y aislado: persistSession:false para NO interferir con la
  // sesión Auth del panel (que vive en su propio cliente / localStorage).
  var sb = null;
  try {
    sb = window.supabase.createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'mythos-presence-noauth' } });
  } catch (e) {
    window.MythosPresence = { start: noop, stop: noop };
    return;
  }

  var REUSE_WINDOW_H = 12;            // reutilizar sesión abierta dentro de esta ventana (turno con pausas)
  var SS_KEY = 'mythos_session_id';   // id de la sesión activa en esta pestaña

  function ls(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (_) {} }
  function ssDel(k) { try { sessionStorage.removeItem(k); } catch (_) {} }

  // ¿Hay un token de sesión Supabase Auth en localStorage? (clave sb-<ref>-auth-token)
  // Se usa para no registrar presencia con localStorage rancio cuando el panel
  // en realidad va a rebotar al login.
  function hasAuthToken() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && /^sb-.*-auth-token$/.test(k)) return true;
      }
    } catch (_) {}
    return false;
  }

  // Busca una sesión abierta reciente para reutilizar (evita duplicar filas en refresh/navegación).
  async function findOpen(ctx) {
    var since = new Date(Date.now() - REUSE_WINDOW_H * 3600000).toISOString();
    var q = sb.from('staff_sessions')
      .select('id')
      .eq('restaurant_id', ctx.restaurant_id)
      .is('logout_at', null)
      .gte('login_at', since)
      .order('login_at', { ascending: false })
      .limit(1);
    if (ctx.user_id) q = q.eq('user_id', ctx.user_id);
    else if (ctx.rider_id) q = q.eq('rider_id', ctx.rider_id);
    else return null;
    try {
      var r = await q;
      return (r && r.data && r.data[0]) || null;
    } catch (_) { return null; }
  }

  var MythosPresence = {
    _id: null,

    // ctx: { restaurant_id, role, panel, name, user_id? , rider_id? }
    start: async function (ctx) {
      if (!ctx || !ctx.restaurant_id) return null;
      if (!ctx.user_id && !ctx.rider_id) return null;
      try {
        // ¿Ya tenemos sesión en esta pestaña? No dupliques.
        var existing = ssGet(SS_KEY);
        if (existing) { this._id = existing; return existing; }

        var open = await findOpen(ctx);
        if (open) { this._id = open.id; ssSet(SS_KEY, open.id); return open.id; }

        var row = {
          restaurant_id: ctx.restaurant_id,
          role: ctx.role || null,
          panel: ctx.panel || null,
          employee_name: ctx.name || null,
          user_id: ctx.user_id || null,
          rider_id: ctx.rider_id || null,
          login_at: new Date().toISOString()
        };
        var ins = await sb.from('staff_sessions').insert(row).select('id').single();
        if (ins.error || !ins.data) return null;
        this._id = ins.data.id;
        ssSet(SS_KEY, ins.data.id);
        return this._id;
      } catch (_) { return null; }
    },

    stop: async function (reason) {
      var id = this._id || ssGet(SS_KEY);
      if (!id) return;
      try {
        await sb.from('staff_sessions')
          .update({ logout_at: new Date().toISOString(), logout_reason: reason || 'manual' })
          .eq('id', id)
          .is('logout_at', null);
      } catch (_) {}
      this._id = null;
      ssDel(SS_KEY);
    }
  };

  window.MythosPresence = MythosPresence;

  // ---- Auto-init para paneles con Supabase Auth (mozo/caja/cocina/gerente/admin) ----
  // El panel rider setea window.MYTHOS_PRESENCE_MANUAL=true y maneja el ciclo a mano.
  if (window.MYTHOS_PRESENCE_MANUAL) return;

  function autoStart() {
    var rid = ls('mythos_restaurant_id');
    var role = ls('mythos_role');
    var uid = ls('mythos_user_id');
    var name = ls('mythos_display_name');
    // Sin contexto de sesión → el panel va a rebotar al login: no registramos.
    if (!rid || !role || !uid) return;
    // Sin token Auth real → localStorage probablemente rancio: no registramos.
    if (!hasAuthToken()) return;
    var panel = (location.pathname.split('/').pop() || '').replace('.html', '') || role;
    MythosPresence.start({ restaurant_id: rid, role: role, user_id: uid, name: name, panel: panel });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoStart);
  } else {
    autoStart();
  }
})();
