/* ═══════════════════════════════════════════
   MYTHOS OFFLINE — overlay "Sin conexión" + Reintentar
   Se incluye en TODOS los paneles EXCEPTO:
     · caja.html  → tiene modo offline propio (imprime comandas sin internet)
     · diag.html  → herramienta de diagnóstico de conexión
   Vanilla JS, sin dependencias: funciona aunque React/Babel no hayan cargado.
   Opt-out: definir window.MYTHOS_OFFLINE_DISABLED = true antes de cargar el script.
═══════════════════════════════════════════ */
(function () {
  'use strict';

  if (window.MYTHOS_OFFLINE_DISABLED) return;
  if (window.__mythosOffline) return;       // evitar doble init
  window.__mythosOffline = true;

  var OVERLAY_ID = 'mythos-offline-overlay';
  var checking = false;     // hay un reintento en curso
  var wasOffline = false;   // estuvimos offline en esta sesión de página

  function isDark() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }

  function iconWifiOff(color) {
    return '<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="' + color +
      '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block;margin:0 auto;">' +
      '<path d="M1 1l22 22"/>' +
      '<path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>' +
      '<path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>' +
      '<path d="M10.71 5.05A16 16 0 0 1 22.58 9"/>' +
      '<path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/>' +
      '<path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>' +
      '<line x1="12" y1="20" x2="12.01" y2="20"/>' +
      '</svg>';
  }

  function buildOverlay() {
    var existing = document.getElementById(OVERLAY_ID);
    if (existing) return existing;

    var dark = isDark();
    var bg            = dark ? 'rgba(0,0,0,0.92)'      : 'rgba(245,245,247,0.94)';
    var card          = dark ? '#1C1C1E'              : '#FFFFFF';
    var border        = dark ? '#38383A'              : '#D2D2D7';
    var textPrimary   = dark ? '#F5F5F7'              : '#1D1D1F';
    var textSecondary = dark ? '#AEAEB2'              : '#6E6E73';
    var accent        = dark ? '#F5F5F7'              : '#1D1D1F';
    var accentText    = dark ? '#000000'              : '#FFFFFF';
    var warning       = dark ? '#FF9F0A'              : '#FF9500';

    var el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-live', 'assertive');
    el.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'display:none', 'align-items:center', 'justify-content:center',
      'background:' + bg,
      'backdrop-filter:blur(8px)', '-webkit-backdrop-filter:blur(8px)',
      'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif',
      'padding:24px', 'box-sizing:border-box'
    ].join(';');

    el.innerHTML =
      '<div style="max-width:360px;width:100%;background:' + card + ';border:1px solid ' + border +
        ';border-radius:20px;padding:32px 28px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.35);">' +
        iconWifiOff(warning) +
        '<div style="font-size:19px;font-weight:700;color:' + textPrimary +
          ';margin:18px 0 8px;letter-spacing:-0.01em;">Sin conexión a internet</div>' +
        '<div style="font-size:14px;line-height:1.5;color:' + textSecondary +
          ';margin-bottom:24px;">Revisá el WiFi o los datos móviles. Cuando vuelva la conexión, tocá Reintentar.</div>' +
        '<button id="mythos-offline-retry" type="button" style="width:100%;border:none;border-radius:12px;background:' +
          accent + ';color:' + accentText +
          ';font-size:15px;font-weight:600;padding:14px;cursor:pointer;font-family:inherit;transition:opacity .15s;">Reintentar</button>' +
        '<div id="mythos-offline-status" style="font-size:12px;color:' + textSecondary +
          ';margin-top:14px;min-height:16px;"></div>' +
      '</div>';

    (document.body || document.documentElement).appendChild(el);
    el.querySelector('#mythos-offline-retry').addEventListener('click', retry);
    return el;
  }

  function setStatus(msg) {
    var s = document.getElementById('mythos-offline-status');
    if (s) s.textContent = msg || '';
  }

  function show() {
    wasOffline = true;
    buildOverlay().style.display = 'flex';
  }

  function hide() {
    var el = document.getElementById(OVERLAY_ID);
    if (el) el.style.display = 'none';
  }

  /* Verificación activa real: navigator.onLine a veces miente.
     Pedimos un recurso propio con cache-busting; si responde, hay internet. */
  function ping() {
    return fetch('design-system.css?_ping=' + Date.now(), { method: 'GET', cache: 'no-store' })
      .then(function (r) { return !!(r && (r.ok || r.status)); })
      .catch(function () { return false; });
  }

  function reloadSoon(msg) {
    setStatus(msg || 'Conexión restablecida. Recargando…');
    setTimeout(function () { location.reload(); }, 500);
  }

  function retry() {
    if (checking) return;
    checking = true;
    var btn = document.getElementById('mythos-offline-retry');
    if (btn) { btn.style.opacity = '0.6'; btn.disabled = true; btn.textContent = 'Comprobando…'; }
    setStatus('');
    ping().then(function (ok) {
      checking = false;
      if (ok || navigator.onLine) {
        reloadSoon();
      } else {
        if (btn) { btn.style.opacity = '1'; btn.disabled = false; btn.textContent = 'Reintentar'; }
        setStatus('Seguís sin conexión. Probá de nuevo.');
      }
    });
  }

  /* Navegador detecta que volvió la red por su cuenta → recargar para resincronizar
     (realtime, sesiones, etc.). Solo si veníamos de un estado offline. */
  function onOnline() {
    if (wasOffline) {
      buildOverlay().style.display = 'flex';
      reloadSoon();
    } else {
      hide();
    }
  }

  window.addEventListener('offline', show);
  window.addEventListener('online', onOnline);

  function start() {
    if (!navigator.onLine) show();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // API mínima para depurar / forzar desde consola
  window.MythosOffline = { show: show, hide: hide, retry: retry };
})();
