/* ============================================================
 * Mythos Auth Guard — bloqueo por cambio de contraseña obligatorio (AUTH-1)
 *
 * Red anti-bypass: si el usuario tiene una sesión activa Y
 * user_security_flags.must_change_password = true, lo redirige a
 * /cambiar-password antes de que pueda usar el panel. El enforcement
 * PRIMARIO está en login.html (redirige al autenticar); este guard cubre la
 * navegación DIRECTA por URL a un panel con una sesión que aún tiene el flag.
 *
 * Aplica a los 7 paneles de personal (superadmin, admin, gerente, caja,
 * cocina, mozo, delivery-rider). NO se incluye en `/` (cliente QR),
 * delivery-cliente ni en las páginas públicas de marketing.
 *
 * Uso: <script src="mythos-auth-guard.js"></script> DESPUÉS de config.js y del
 * SDK de Supabase (mismo punto que mythos-session.js). Auto-arranca.
 *
 * Diseño (defensa en profundidad, sin penalizar a todos):
 *   • Sin token de sesión en localStorage → no hace nada (el guard propio del
 *     panel redirige al login). No interfiere con el flujo no-logueado.
 *   • Con token → consulta el flag (lectura RLS: el usuario solo ve su fila) y
 *     redirige si está en true. Lee el token de localStorage directamente (no
 *     crea un segundo cliente Supabase → sin warning "Multiple GoTrueClient").
 *   • FAIL-OPEN ante error/red/tabla-inexistente: NO bloquea (login ya
 *     enforcea; el guard es una red secundaria). Inofensivo si la migración
 *     113 todavía no está aplicada (la consulta falla → no redirige).
 *   • NO loguea datos sensibles.
 * ============================================================ */
(function () {
  'use strict';

  var cfg = window.SUPABASE_CONFIG || {};
  var url = String(cfg.url || '').replace(/^﻿/, '').trim();
  var key = String(cfg.anonKey || '').replace(/^﻿/, '').trim();
  if (!url || !key || url.indexOf('YOUR_') !== -1) return;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }

  // sub del JWT (fallback para el user id si el objeto de sesión no lo trae).
  function jwtSub(t) {
    try {
      var p = t.split('.')[1];
      var s = atob(p.replace(/-/g, '+').replace(/_/g, '/'));
      return JSON.parse(s).sub || null;
    } catch (_) { return null; }
  }

  // Lee la sesión persistida por supabase-js (sb-<ref>-auth-token, posible
  // base64- y/o "chunked" en .0/.1…). Devuelve { token, uid } o null.
  function readSession() {
    try {
      var ref = (url.match(/^https?:\/\/([a-z0-9-]+)\.supabase\./i) || [])[1];
      var base = ref ? ('sb-' + ref + '-auth-token') : null;
      var raw = null;

      if (base && lsGet(base) != null) {
        raw = lsGet(base);
      } else if (base) {
        var parts = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(base + '.') === 0) parts.push(k);
        }
        if (parts.length) { parts.sort(); raw = parts.map(function (kk) { return lsGet(kk) || ''; }).join(''); }
      }
      if (!raw) {
        for (var j = 0; j < localStorage.length; j++) {
          var k2 = localStorage.key(j);
          if (k2 && /^sb-.*-auth-token$/.test(k2)) { raw = lsGet(k2); break; }
        }
      }
      if (!raw) return null;
      if (raw.indexOf('base64-') === 0) raw = atob(raw.slice(7));

      var obj = JSON.parse(raw);
      var sess = obj.currentSession || obj;
      var token = sess.access_token;
      var uid = (sess.user && sess.user.id) || (token ? jwtSub(token) : null);
      if (!token || !uid) return null;
      return { token: token, uid: uid };
    } catch (_) { return null; }
  }

  var s = readSession();
  if (!s) return;   // no logueado → no interferir; el panel redirige al login

  try {
    fetch(url + '/rest/v1/user_security_flags?user_id=eq.' + encodeURIComponent(s.uid) + '&select=must_change_password&limit=1', {
      headers: { 'apikey': key, 'Authorization': 'Bearer ' + s.token }
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        if (rows && rows[0] && rows[0].must_change_password === true) {
          // Evitar redirigir si ya estamos en la página de cambio (defensivo).
          if (!/cambiar-password/.test(location.pathname)) {
            location.replace('cambiar-password.html?reason=required');
          }
        }
      })
      .catch(function () { /* fail-open */ });
  } catch (_) { /* fail-open */ }

  window.MythosAuthGuard = { readSession: readSession };
})();
