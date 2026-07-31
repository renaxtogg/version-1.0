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
 *   2) Estado de la cuenta (mig 150 + 193): tras confirmar que NO hay que cambiar
 *      la clave, llama get_my_account_status() y aplica, para el restaurante del
 *      usuario:
 *        • SUSPENDIDA / INACTIVA → pantalla de bloqueo a pantalla completa
 *          ("Tu cuenta está suspendida"), con el WhatsApp de contacto
 *          (marketing_config). No deja operar. El superadmin NUNCA se bloquea.
 *        • CORTADA POR FACTURACIÓN (locked, mig 193: venció y se acabó el período
 *          de gracia) → pantalla de bloqueo a pantalla completa. El texto DEPENDE
 *          DEL ROL: al dueño (admin) se le dice que la suscripción venció y que
 *          contacte a soporte; al resto del personal se le muestra un mensaje
 *          NEUTRO ("servicio no disponible, hablá con la administración del
 *          local") — el personal no se entera del tema de pago.
 *        • MANTENIMIENTO → banner prominente arriba ("Modo mantenimiento
 *          activo" + mensaje). Se ve, pero deja operar.
 *        • VENCIDA PERO EN GRACIA (in_grace) → banner de advertencia + modal
 *          una-sola-vez-por-día, SOLO para el dueño. No bloquea todavía; avisa
 *          hasta qué día opera. El resto del personal no ve nada.
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
          // Corte por facturación (mig 193): venció y se acabó la gracia. Bloquea
          // igual que la suspensión, con copy distinto según el rol. Se evalúa
          // ANTES de los banners: si no hay servicio, no hay nada que avisar.
          if (st.locked === true) { showServiceLockedBlock(st); return; }
          if (st.maintenance_mode === true) showMaintenanceBanner(st.maintenance_message);
          // El aviso de vencimiento es asunto del DUEÑO: el personal no tiene por
          // qué enterarse de la situación de pago del local (instrucción de Renato).
          if (st.expired === true && isOwner(st)) { showExpiredBanner(st); showExpiredModalOnce(st); }
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

  // ¿El usuario es el DUEÑO del local? Solo a él se le habla de plan y de pagos;
  // para el resto del personal el motivo del corte es información privada del
  // dueño. Se confía en el rol que devuelve la RPC (server-side), con el de
  // localStorage como respaldo si la RPC no lo trajera.
  function isOwner(st) {
    var r = ((st && st.role) || lsGet('mythos_role') || '').trim().toLowerCase();
    return r === 'admin' || r === 'owner';
  }

  // WhatsApp de contacto de MYTHOS: lectura anon-safe de marketing_config
  // (mismo origen que el sitio público). Muestra el botón recién cuando hay número
  // — nunca deja un enlace roto. `msg` es el texto pre-cargado del chat.
  function attachSupportWhatsapp(btn, msg) {
    try {
      fetch(url + '/rest/v1/marketing_config?key=eq.whatsapp&select=value&limit=1', {
        headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (rows) {
          var num = rows && rows[0] ? String(rows[0].value || '') : '';
          var digits = num.replace(/[^0-9]/g, '');
          if (digits.length >= 6) {
            btn.href = 'https://wa.me/' + digits + (msg ? '?text=' + encodeURIComponent(msg) : '');
            btn.target = '_blank';
            btn.rel = 'noreferrer';
            btn.style.display = 'block';
          }
        })
        .catch(function () { /* sin número → el bloque queda sin botón de WhatsApp */ });
    } catch (_) {}
  }

  // Cierra sesión de verdad: limpia el token ANTES de ir al login (si no,
  // login.html ve la sesión viva y rebota de vuelta al panel → loop).
  function hardLogout() {
    try {
      var kill = [];
      for (var i = 0; i < localStorage.length; i++) {
        var kk = localStorage.key(i);
        if (kk && (/^sb-.*-auth-token/.test(kk) || kk.indexOf('mythos_') === 0)) kill.push(kk);
      }
      kill.forEach(function (kk) { try { localStorage.removeItem(kk); } catch (_) {} });
    } catch (_) {}
    location.replace('login.html');
  }

  function showExpiredBanner(st) {
    if (document.getElementById('mythos-expired-banner')) return;
    var bar = el('div', 'position:fixed;top:0;left:0;right:0;z-index:2147483001;background:#D70015;color:#fff;padding:9px 16px;font:600 13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.18)');
    bar.id = 'mythos-expired-banner';
    var fecha = fmtDate(st && st.subscription_end_date);
    var corte = fmtDate(st && st.grace_ends_on);
    // Con la mig 193 el aviso ya no es vago: dice hasta qué día opera el local.
    bar.textContent = 'Tu suscripción venció' + (fecha ? ' el ' + fecha : '') + '. '
      + (corte ? 'Regularizá antes del ' + corte + ' o el servicio se suspende.'
               : 'Regularizá para no perder el servicio.');
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
    var corte = fmtDate(st && st.grace_ends_on);
    card.appendChild(el('div', 'font-size:14px;color:#555;line-height:1.6;margin-bottom:20px',
      (fecha ? 'Venció el ' + fecha + '. ' : '')
      + (corte ? 'Podés seguir operando hasta el ' + corte + '. Después de esa fecha el servicio se suspende para todos los paneles del local.'
               : 'Regularizá el pago para no perder el servicio. Por ahora podés seguir operando.')));
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

  /* ── Pantalla de bloqueo total (constructor común) ──────────────────────────
     Overlay opaco a pantalla completa, sin forma de cerrarlo: el panel de atrás
     queda inaccesible. Lo usan la suspensión manual (superadmin) y el corte por
     facturación. Parámetros:
       id      : id del nodo (evita duplicados si el guard corre dos veces)
       title   : título grande
       body    : texto explicativo
       note    : línea secundaria opcional (fecha de vencimiento, etc.)
       waLabel : etiqueta del botón de WhatsApp (null = sin botón)
       waMsg   : mensaje pre-cargado del chat                                  */
  function showBlockScreen(opts) {
    if (document.getElementById(opts.id)) return;
    try { document.body.style.overflow = 'hidden'; } catch (_) {}

    var overlay = el('div', 'position:fixed;inset:0;z-index:2147483647;background:#0b0b0c;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;overflow:auto');
    overlay.id = opts.id;
    var card = el('div', 'max-width:440px;width:100%;text-align:center;color:#fff');
    card.appendChild(el('div', 'font-size:52px;line-height:1;margin-bottom:16px', '🔒'));
    card.appendChild(el('div', 'font-size:23px;font-weight:800;margin-bottom:10px', opts.title));
    card.appendChild(el('div', 'font-size:15px;color:#c7c7cc;line-height:1.65;margin-bottom:' + (opts.note ? '12px' : '24px'), opts.body));
    if (opts.note) {
      card.appendChild(el('div', 'font-size:13px;color:#8e8e93;line-height:1.6;margin-bottom:24px', opts.note));
    }

    var btnRow = el('div', 'display:flex;flex-direction:column;gap:10px;align-items:stretch');
    card.appendChild(btnRow);

    // Botón WhatsApp (aparece solo si hay número en marketing_config).
    var waBtn = null;
    if (opts.waLabel) {
      waBtn = el('a', 'display:none;text-decoration:none;background:#25D366;color:#fff;border-radius:10px;font-size:15px;font-weight:700;padding:13px;text-align:center', opts.waLabel);
      btnRow.appendChild(waBtn);
    }

    var out = el('button', 'background:none;border:none;text-decoration:underline;color:#8e8e93;font-size:13px;font-weight:600;padding:8px;cursor:pointer', 'Cerrar sesión');
    out.onclick = hardLogout;
    btnRow.appendChild(out);

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    if (waBtn) attachSupportWhatsapp(waBtn, opts.waMsg);
  }

  function showSuspendedBlock() {
    showBlockScreen({
      id: 'mythos-suspended-block',
      title: 'Tu cuenta está suspendida',
      body: 'El acceso a los paneles está pausado. Contactá a MYTHOS para reactivar tu cuenta y volver a operar.',
      waLabel: 'Contactar a MYTHOS por WhatsApp',
      waMsg: 'Hola MYTHOS, mi cuenta figura suspendida y necesito reactivarla.'
    });
  }

  /* ── Corte por facturación (mig 193) ────────────────────────────────────────
     DOS textos distintos, a propósito (instrucción de Renato):
       · DUEÑO (admin): se le dice la verdad —venció la suscripción, se terminó el
         período de gracia— y se lo manda a soporte por WhatsApp.
       · RESTO DEL PERSONAL (mozo, caja, cocina, gerente, rider): mensaje NEUTRO.
         Nunca se menciona plan, pago ni vencimiento: para el empleado es un
         servicio no disponible y lo tiene que hablar con la administración del
         local. La situación de pago del comercio no es asunto de sus empleados. */
  function showServiceLockedBlock(st) {
    var fecha = fmtDate(st && st.subscription_end_date);

    if (isOwner(st)) {
      showBlockScreen({
        id: 'mythos-service-locked',
        title: 'Servicio suspendido',
        body: 'Tu suscripción a MYTHOS venció y ya pasó el período de gracia, así que el servicio quedó suspendido: los paneles del local y la toma de pedidos están detenidos. Regularizá el pago para reactivarlo — se restablece apenas se acredita.',
        note: (fecha ? 'Venció el ' + fecha + '.' : '')
              + (st && st.grace_days ? ' Período de gracia: ' + st.grace_days + ' días.' : ''),
        waLabel: 'Contactar a soporte por WhatsApp',
        waMsg: 'Hola MYTHOS, soy de ' + ((st && st.restaurant_name) || 'mi restaurante')
             + ' y quiero regularizar mi suscripción para reactivar el servicio.'
      });
      return;
    }

    showBlockScreen({
      id: 'mythos-service-locked',
      title: 'Servicio no disponible',
      body: 'En este momento el sistema no está disponible para este local. No es un problema de tu usuario ni de tu equipo.',
      note: 'Comunicate con la administración del local para más información.',
      waLabel: 'Contactar a soporte',
      waMsg: 'Hola MYTHOS, trabajo en un local y el sistema me aparece como no disponible.'
    });
  }
})();
