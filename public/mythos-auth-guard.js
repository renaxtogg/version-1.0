/* ============================================================
 * Mythos Auth Guard — enforcement común post-login de los paneles de staff
 *
 * Corre en los 8 paneles de personal (superadmin, admin, gerente, caja, cocina,
 * mozo, delivery-rider, proveedor) DESPUÉS de config.js y del SDK de Supabase.
 * Auto-arranca. NO se incluye en `/` (cliente QR), delivery-cliente ni en las
 * páginas públicas de marketing.
 *
 * Hace DOS cosas, en orden:
 *   1) Cambio de contraseña obligatorio (AUTH-1): si la sesión tiene
 *      user_security_flags.must_change_password = true, redirige a
 *      /cambiar-password ANTES de dejar usar el panel. Tiene prioridad sobre
 *      todo lo demás (el usuario primero regulariza su clave).
 *   2) Estado de la cuenta (mig 150): tras confirmar que NO hay que cambiar la
 *      clave, llama get_my_account_status() y aplica, para el restaurante del
 *      usuario:
 *        • SUSPENDIDA / INACTIVA → pantalla de bloqueo a pantalla completa
 *          ("Tu cuenta está suspendida"), con el WhatsApp de contacto
 *          (marketing_config). No deja operar. El superadmin NUNCA se bloquea.
 *        • MANTENIMIENTO → banner prominente arriba ("Modo mantenimiento
 *          activo" + mensaje). Se ve, pero deja operar.
 *        • VENCIDA (end_date < hoy o status expired) → banner de advertencia +
 *          modal una-sola-vez-por-día. No bloquea (período de gracia).
 *
 * Diseño (defensa en profundidad, FAIL-OPEN — nunca dejar a nadie afuera por un
 * error):
 *   • Sin token de sesión → no hace nada (el guard propio del panel redirige al
 *     login). No interfiere con el flujo no-logueado.
 *   • Con token → lee el token de localStorage directamente (no crea un segundo
 *     cliente Supabase → sin warning "Multiple GoTrueClient").
 *   • Ante error/red/RPC-inexistente/NULL → NO bloquea ni avisa. Inofensivo si
 *     las migraciones 113/150 todavía no están aplicadas.
 *   • El bloqueo de suspensión es una barrera de PRESENTACIÓN (UX), no de
 *     seguridad: la frontera real de datos es la RLS. No construir suposiciones
 *     de seguridad sobre este gate.
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
  // Exponer SIEMPRE de forma síncrona (mythos-panel-gate.js lo consume).
  window.MythosAuthGuard = { readSession: readSession };
  if (!s) return;   // no logueado → no interferir; el panel redirige al login

  // ── 1) Cambio de contraseña obligatorio; si NO aplica, sigue con estado de cuenta ──
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
          return;   // clave primero; no seguimos con el estado de cuenta
        }
        applyAccountStatus();   // sin cambio de clave pendiente → chequear cuenta
      })
      .catch(function () { applyAccountStatus(); });   // fail-open: el flag no bloquea, pero igual chequeamos la cuenta
  } catch (_) { /* fail-open */ }

  // ── 2) Estado de la cuenta (mantenimiento / suspensión / vencimiento) ──
  function applyAccountStatus() {
    // El superadmin nunca se bloquea ni recibe avisos de cuenta.
    var role = (lsGet('mythos_role') || '').trim();
    if (role === 'superadmin') return;

    var rid = (lsGet('mythos_restaurant_id') || cfg.restaurantId || '').replace(/^﻿/, '').trim();

    try {
      fetch(url + '/rest/v1/rpc/get_my_account_status', {
        method: 'POST',
        headers: { 'apikey': key, 'Authorization': 'Bearer ' + s.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_restaurant_id: rid || null })
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (st) {
          if (!st || typeof st !== 'object') return;        // NULL / error → fail-open
          if (st.role === 'superadmin') return;             // doble red
          if (st.suspended === true) { showSuspendedBlock(); return; }  // bloqueo total
          if (st.maintenance_mode === true) showMaintenanceBanner(st.maintenance_message);
          if (st.expired === true) { showExpiredBanner(st); showExpiredModalOnce(st); }
          // Los paneles con header propio position:fixed (p. ej. mozo) ignoran el
          // padding-top del body → correrlos hacia abajo para que el banner no los tape.
          if (_bannerH > 0) nudgeFixedHeaders(_bannerH);
        })
        .catch(function () { /* fail-open */ });
    } catch (_) { /* fail-open */ }
  }

  // ── Helpers de UI (vanilla; overlays anexados a <body> con z-index máximo) ──
  function el(tag, style, text) {
    var n = document.createElement(tag);
    if (style) n.setAttribute('style', style);
    if (text != null) n.textContent = text;
    return n;
  }

  // Empuja el contenido hacia abajo lo suficiente para no quedar tapado por los
  // banners fijos superiores (suma de alturas). Idempotente.
  var _bannerH = 0;
  function bumpBody(px) {
    _bannerH += px;
    try { document.body.style.paddingTop = _bannerH + 'px'; } catch (_) {}
  }

  // El padding-top del body NO mueve elementos position:fixed. Los paneles con
  // header propio fijo al tope (top:0) quedarían tapados por el banner → los
  // corremos hacia abajo `offset` px. Acotado y defensivo: solo tira de tiras
  // pequeñas fijas al tope (headers), nunca de overlays a pantalla completa ni de
  // los propios nodos del guard. Idempotente (marca data-mythos-nudged).
  function nudgeFixedHeaders(offset) {
    try {
      var vh = window.innerHeight || 800;
      var all = document.body.getElementsByTagName('*');
      var n = Math.min(all.length, 4000);   // backstop anti-runaway
      for (var i = 0; i < n; i++) {
        var node = all[i];
        if (!node || (node.id && node.id.indexOf('mythos-') === 0)) continue;
        if (node.getAttribute('data-mythos-nudged')) continue;
        var cs = window.getComputedStyle(node);
        if (cs.position !== 'fixed' || parseInt(cs.top, 10) !== 0) continue;
        var h = node.offsetHeight || 0;
        if (h === 0 || h > vh * 0.5) continue;   // headers, no modales/overlays
        node.style.top = offset + 'px';
        node.setAttribute('data-mythos-nudged', '1');
      }
    } catch (_) { /* cosmético; nunca romper */ }
  }

  function showMaintenanceBanner(msg) {
    if (document.getElementById('mythos-maint-banner')) return;
    var bar = el('div', 'position:fixed;top:0;left:0;right:0;z-index:2147483000;background:#FF9500;color:#fff;padding:9px 16px;font:600 13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.18)');
    bar.id = 'mythos-maint-banner';
    var txt = 'Modo mantenimiento activo';
    if (msg && String(msg).trim()) txt += ' — ' + String(msg).trim();
    bar.textContent = txt;
    document.body.appendChild(bar);
    bumpBody(bar.offsetHeight || 38);
  }

  function fmtDate(d) {
    try {
      if (!d) return '';
      var parts = String(d).slice(0, 10).split('-');
      if (parts.length !== 3) return String(d);
      return parts[2] + '/' + parts[1] + '/' + parts[0];
    } catch (_) { return String(d || ''); }
  }

  function showExpiredBanner(st) {
    if (document.getElementById('mythos-expired-banner')) return;
    var bar = el('div', 'position:fixed;top:0;left:0;right:0;z-index:2147483001;background:#D70015;color:#fff;padding:9px 16px;font:600 13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.18)');
    bar.id = 'mythos-expired-banner';
    var fecha = fmtDate(st && st.subscription_end_date);
    bar.textContent = 'Tu suscripción venció' + (fecha ? ' el ' + fecha : '') + '. Regularizá para no perder el servicio.';
    // Va DEBAJO del de mantenimiento si ambos existen.
    document.body.appendChild(bar);
    var maint = document.getElementById('mythos-maint-banner');
    if (maint) bar.style.top = (maint.offsetHeight || 38) + 'px';
    bumpBody(bar.offsetHeight || 38);
  }

  function showExpiredModalOnce(st) {
    // Una vez por día (por navegador). No bloquea: se puede cerrar.
    var today = fmtDate(new Date().toISOString());
    var flagKey = 'mythos_expired_notice_' + today;
    try { if (lsGet(flagKey) === '1') return; } catch (_) {}

    var overlay = el('div', 'position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:24px');
    var card = el('div', 'max-width:420px;width:100%;background:#fff;border-radius:16px;padding:28px 26px;box-shadow:0 30px 80px rgba(0,0,0,.4);font-family:system-ui,-apple-system,Segoe UI,sans-serif;text-align:center');
    card.appendChild(el('div', 'font-size:40px;line-height:1;margin-bottom:12px', '⚠️'));
    card.appendChild(el('div', 'font-size:19px;font-weight:800;color:#1c1c1e;margin-bottom:8px', 'Tu suscripción venció'));
    var fecha = fmtDate(st && st.subscription_end_date);
    card.appendChild(el('div', 'font-size:14px;color:#555;line-height:1.6;margin-bottom:20px',
      (fecha ? 'Venció el ' + fecha + '. ' : '') + 'Regularizá el pago para no perder el servicio. Por ahora podés seguir operando.'));
    var btn = el('button', 'width:100%;border:none;border-radius:10px;background:#1c1c1e;color:#fff;font-size:14px;font-weight:700;padding:12px;cursor:pointer', 'Entendido');
    btn.onclick = function () {
      try { localStorage.setItem(flagKey, '1'); } catch (_) {}
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };
    card.appendChild(btn);
    overlay.appendChild(card);
    // No cerrar por click en el overlay (misma regla que los modales del panel).
    document.body.appendChild(overlay);
  }

  function showSuspendedBlock() {
    if (document.getElementById('mythos-suspended-block')) return;
    try { document.body.style.overflow = 'hidden'; } catch (_) {}

    var overlay = el('div', 'position:fixed;inset:0;z-index:2147483647;background:#0b0b0c;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif');
    overlay.id = 'mythos-suspended-block';
    var card = el('div', 'max-width:440px;width:100%;text-align:center;color:#fff');
    card.appendChild(el('div', 'font-size:52px;line-height:1;margin-bottom:16px', '🔒'));
    card.appendChild(el('div', 'font-size:23px;font-weight:800;margin-bottom:10px', 'Tu cuenta está suspendida'));
    card.appendChild(el('div', 'font-size:15px;color:#c7c7cc;line-height:1.65;margin-bottom:24px',
      'El acceso a los paneles está pausado. Contactá a MYTHOS para reactivar tu cuenta y volver a operar.'));

    var btnRow = el('div', 'display:flex;flex-direction:column;gap:10px;align-items:stretch');
    card.appendChild(btnRow);

    // Botón WhatsApp (si hay número configurado en marketing_config).
    var waBtn = el('a', 'display:none;text-decoration:none;background:#25D366;color:#fff;border-radius:10px;font-size:15px;font-weight:700;padding:13px;text-align:center', 'Contactar a MYTHOS por WhatsApp');
    waBtn.id = 'mythos-suspended-wa';
    btnRow.appendChild(waBtn);

    // "Cerrar sesión": limpia el token ANTES de ir a login (si no, login.html ve
    // la sesión viva y redirige de vuelta al panel → loop). Borra los sb-*-auth-token
    // y las claves mythos_*.
    var out = el('button', 'background:none;border:none;text-decoration:underline;color:#8e8e93;font-size:13px;font-weight:600;padding:8px;cursor:pointer', 'Cerrar sesión');
    out.onclick = function () {
      try {
        var kill = [];
        for (var i = 0; i < localStorage.length; i++) {
          var kk = localStorage.key(i);
          if (kk && (/^sb-.*-auth-token/.test(kk) || kk.indexOf('mythos_') === 0)) kill.push(kk);
        }
        kill.forEach(function (kk) { try { localStorage.removeItem(kk); } catch (_) {} });
      } catch (_) {}
      location.replace('login.html');
    };
    btnRow.appendChild(out);

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // WhatsApp de contacto: lectura anon-safe de marketing_config (is_public).
    try {
      fetch(url + '/rest/v1/marketing_config?key=eq.whatsapp&select=value&limit=1', {
        headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (rows) {
          var num = rows && rows[0] ? String(rows[0].value || '') : '';
          var digits = num.replace(/[^0-9]/g, '');
          if (digits.length >= 6) {
            waBtn.href = 'https://wa.me/' + digits;
            waBtn.target = '_blank';
            waBtn.rel = 'noreferrer';
            waBtn.style.display = 'block';
          }
        })
        .catch(function () { /* sin número → queda solo el "Cerrar sesión" */ });
    } catch (_) {}
  }
})();
