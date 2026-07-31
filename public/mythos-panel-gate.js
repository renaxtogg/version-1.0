/* ============================================================
 * Mythos Panel Gate — GATE DE UX (disponibilidad de módulos), NO seguridad
 *
 * ⚠️ Esto es una barrera de PRESENTACIÓN client-side, NO un control de acceso.
 * Redirige el navegador si el panel no está habilitado, pero un token válido
 * sigue pudiendo llamar las mismas tablas/RPC (la frontera real es la RLS —
 * ver el roadmap de Sprint 1 RLS en MYTHOS_PRESPRINT_REPORT.md). No construir
 * suposiciones de seguridad sobre este gate: si "apagar un módulo" debe blindar
 * datos, hay que enforcearlo en RLS/RPC, no acá.
 *
 * Si el panel actual NO está habilitado para el restaurante (override del
 * superadmin en enabled=false, o el plan no lo incluye), redirige a
 * "modulo-no-disponible.html". El superadmin NUNCA se bloquea.
 *
 * Se carga como <script src="mythos-panel-gate.js"></script> DESPUÉS de la
 * SDK de Supabase (window.supabase) y de config.js (window.SUPABASE_CONFIG),
 * en los 7 paneles gateables: admin, caja, cocina, mozo, gerente,
 * delivery-rider (autenticados) y delivery-cliente (anónimo, rid por ?r=).
 *
 * Diseño (fail-open, defensa en profundidad):
 *   • Llama a la RPC is_panel_enabled(rid, panel) (SECURITY DEFINER, anon-ok).
 *   • Bloquea SOLO si la RPC devuelve exactamente false. null / error / red /
 *     rol superadmin / sin rid → NO bloquea (igual criterio que mythos-gating).
 *   • No crea un segundo cliente Supabase (evita "Multiple GoTrueClient"):
 *     usa fetch directo al endpoint REST de la RPC. El token del usuario (si
 *     hay sesión) sale de window.MythosAuthGuard.readSession(); si no, anon.
 * ============================================================ */
(function () {
  'use strict';

  var cfg = window.SUPABASE_CONFIG || {};
  var url = String(cfg.url || '').replace(/^﻿/, '').trim();
  var key = String(cfg.anonKey || '').replace(/^﻿/, '').trim();
  if (!url || !key || url.indexOf('YOUR_') !== -1) return;

  // Panel actual, derivado del nombre del archivo. Solo se gatean estos.
  var PANEL_BY_FILE = {
    'admin':            'admin',
    'caja':             'caja',
    'cocina':           'cocina',
    'mozo':             'mozo',
    'gerente':          'gerente',
    'delivery-rider':   'delivery-rider',
    'delivery-cliente': 'delivery-cliente'
  };
  var file = (location.pathname.split('/').pop() || '').replace(/\.html?$/i, '').toLowerCase();
  var panel = PANEL_BY_FILE[file];
  if (!panel) return;                      // página no gateable → nada que hacer
  if (/modulo-no-disponible/.test(location.pathname)) return;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }

  // El superadmin (incluye impersonación con ?r=) nunca se bloquea.
  var role = (lsGet('mythos_role') || '').trim();
  if (role === 'superadmin') return;

  // Restaurant id: delivery-cliente por URL (?r=/?rest=/config); resto por login.
  var rid = '';
  if (panel === 'delivery-cliente') {
    try {
      var p = new URLSearchParams(location.search);
      rid = (p.get('r') || p.get('rest') || cfg.restaurantId || '').replace(/^﻿/, '').trim();
    } catch (_) { rid = (cfg.restaurantId || '').trim(); }
  } else {
    rid = (lsGet('mythos_restaurant_id') || cfg.restaurantId || '').replace(/^﻿/, '').trim();
  }
  if (!rid) return;                        // sin rid no podemos verificar → fail-open

  // Token de sesión (si hay): reusa el lector de mythos-auth-guard.js. Si no
  // está cargado (delivery-cliente), va anónimo con la anon key.
  var token = key;
  try {
    if (window.MythosAuthGuard && typeof window.MythosAuthGuard.readSession === 'function') {
      var s = window.MythosAuthGuard.readSession();
      if (s && s.token) token = s.token;
    }
  } catch (_) {}

  // ── Distinguir "el plan no incluye este panel" de "el servicio está cortado" ──
  // Con la mig 193, un local con la suscripción vencida (pasado el período de
  // gracia) pierde TODOS los paneles. Redirigir en ese caso a
  // "modulo-no-disponible" sería un mensaje equivocado: no es que el módulo no
  // esté contratado, es que el servicio está suspendido. Ese caso lo explica
  // mythos-auth-guard.js (staff) o la propia pantalla del panel (cliente), así que
  // acá NO se redirige y se les deja el lugar.
  //   · Panel de staff (hay sesión) → get_my_account_status().locked
  //   · delivery-cliente (anónimo)  → get_public_capabilities().ordering
  // Fail-safe: si esta segunda consulta falla, se redirige como siempre.
  function isServiceCut() {
    if (panel === 'delivery-cliente') {
      return fetch(url + '/rest/v1/rpc/get_public_capabilities', {
        method: 'POST',
        headers: { 'apikey': key, 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_restaurant_id: rid })
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (caps) { return !!(caps && caps.ordering === false); })
        .catch(function () { return false; });
    }
    return fetch(url + '/rest/v1/rpc/get_my_account_status', {
      method: 'POST',
      headers: { 'apikey': key, 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_restaurant_id: rid })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (st) { return !!(st && st.locked === true); })
      .catch(function () { return false; });
  }

  try {
    fetch(url + '/rest/v1/rpc/is_panel_enabled', {
      method: 'POST',
      headers: { 'apikey': key, 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_restaurant_id: rid, p_panel: panel })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (val) {
        // Solo bloqueamos ante un false explícito. true/null/undefined → permitir.
        if (val !== false) return;
        return isServiceCut().then(function (cut) {
          if (cut) return;   // corte por facturación → lo explica la pantalla del panel
          location.replace('modulo-no-disponible.html?panel=' + encodeURIComponent(panel));
        });
      })
      .catch(function () { /* fail-open */ });
  } catch (_) { /* fail-open */ }
})();
