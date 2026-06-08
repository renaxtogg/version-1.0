/* ============================================================
 * Mythos Session — cierre automático por inactividad.
 *
 * Tras 1 hora sin actividad del usuario, cierra la sesión (Supabase Auth +
 * claves mythos_*) y redirige al login. Aplica a TODOS los paneles de personal
 * (mozo, caja, cocina, gerente, admin, superadmin, rider).
 *
 * La sesión en sí persiste entre cierres de pestaña (comportamiento por defecto
 * de Supabase, localStorage) — este módulo sólo la corta por inactividad, no por
 * cerrar la pestaña. La marca de "última actividad" vive en localStorage y se
 * comparte entre pestañas del mismo navegador: mientras el usuario esté activo en
 * CUALQUIER pestaña, ninguna se cierra; cuando todas quedan ociosas 1h, se cierran.
 *
 * Uso: incluir <script src="mythos-session.js"></script> DESPUÉS de config.js y
 * del SDK de Supabase. Auto-arranca. No hace nada si no hay sesión activa
 * (paneles públicos como index.html / delivery-cliente.html quedan intactos).
 *
 * El login (login.html) siembra mythos_last_activity al autenticar, de modo que
 * cada inicio de sesión arranca el reloj de cero.
 * ============================================================ */
(function () {
  'use strict';

  var IDLE_MS  = 60 * 60 * 1000;   // 1 hora de inactividad → cierre
  var CHECK_MS = 30 * 1000;        // frecuencia de chequeo
  var THROTTLE_MS = 5 * 1000;      // no escribir actividad más de 1×/5s
  var ACT_KEY = 'mythos_last_activity';
  var MYTHOS_KEYS = ['mythos_role', 'mythos_restaurant_id', 'mythos_user_id', 'mythos_display_name'];

  function now() { return Date.now(); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (_) {} }

  // Última actividad conocida. Si no hay marca, asumimos "ahora" (no cerramos a ciegas).
  function lastActivity() {
    var v = parseInt(lsGet(ACT_KEY) || '', 10);
    return isNaN(v) ? now() : v;
  }

  // ¿Hay un token de Supabase Auth en localStorage? Sin sesión no forzamos nada.
  // Prefijo (sin ancla final) para tolerar tokens "chunked": sb-<ref>-auth-token, .0, .1…
  var TOKEN_RE = /^sb-.*-auth-token/;

  function hasAuthToken() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && TOKEN_RE.test(k)) return true;
      }
    } catch (_) {}
    return false;
  }

  function clearAuthTokens() {
    try {
      var del = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && TOKEN_RE.test(k)) del.push(k);
      }
      del.forEach(lsDel);
    } catch (_) {}
  }

  var cfg = window.SUPABASE_CONFIG || {};
  var url = String(cfg.url || '').replace(/^﻿/, '').trim();
  var key = String(cfg.anonKey || '').replace(/^﻿/, '').trim();

  var signingOut = false;
  function logout(reason) {
    if (signingOut) return;
    signingOut = true;

    // 1) Registrar el cierre en presencia (si el panel lo usa).
    try { if (window.MythosPresence && window.MythosPresence.stop) window.MythosPresence.stop(reason || 'inactividad'); } catch (_) {}

    // 2) Cerrar sesión en Supabase (revoca server-side). Best-effort.
    var done = function () {
      clearAuthTokens();                 // respaldo: garantizar que el token local se va
      MYTHOS_KEYS.forEach(lsDel);
      lsDel(ACT_KEY);
      var here = (location.pathname.split('/').pop() || '');
      var next = here ? ('?next=' + encodeURIComponent(here)) : '';
      location.replace('login.html' + next);
    };

    try {
      if (window.supabase && url && key) {
        var sb = window.supabase.createClient(url, key);
        var p = sb.auth.signOut();
        if (p && typeof p.then === 'function') {
          var settled = false;
          var fin = function () { if (settled) return; settled = true; done(); };
          p.then(fin, fin);
          setTimeout(fin, 1500);         // no quedarnos colgados si la red no responde
          return;
        }
      }
    } catch (_) {}
    done();
  }

  function check() {
    if (!hasAuthToken()) return;                     // no logueado → nada que cerrar
    // Sin red no podemos cerrar sesión ni volver al login (caja offline imprime tickets):
    // diferimos el cierre hasta recuperar conexión, cuando un próximo check lo concretará.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (now() - lastActivity() >= IDLE_MS) logout('inactividad');
  }

  var lastTouch = 0;
  function onActivity() {
    if (document.visibilityState === 'hidden') return;
    var t = now();
    if (t - lastTouch < THROTTLE_MS) return;
    lastTouch = t;
    lsSet(ACT_KEY, String(t));
  }

  ['mousedown', 'mousemove', 'keydown', 'touchstart', 'scroll', 'wheel', 'click'].forEach(function (ev) {
    try { window.addEventListener(ev, onActivity, { passive: true, capture: true }); } catch (_) {}
  });

  // Al volver a primer plano, chequear de inmediato (la pestaña pudo estar 1h+ en background).
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') check();
  });
  // Al recuperar conexión, concretar un cierre que quedó diferido por estar offline.
  try { window.addEventListener('online', check); } catch (_) {}

  // Chequeo inicial (atrapa reapertura de pestaña con sesión vieja) + periódico.
  // NO sembramos actividad al cargar: respetamos la inactividad acumulada entre cierres.
  check();
  setInterval(check, CHECK_MS);

  window.MythosSession = { logout: logout, check: check };
})();
