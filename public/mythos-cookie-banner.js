/* ═══════════════════════════════════════════════════════════════════════
   MYTHOS — Banner de consentimiento de cookies (WEB-8)
   ─────────────────────────────────────────────────────────────────────
   Script standalone (sin dependencias) para el sitio público y la carta del
   cliente. Informa el uso de cookies/almacenamiento, ofrece Aceptar o Rechazar
   las NO esenciales, y recuerda la elección en localStorage (no se vuelve a
   mostrar). Enlaza a /cookies.

   Hoy MYTHOS solo usa almacenamiento esencial + terceros necesarios (Turnstile,
   Maps), así que el banner INFORMA y REGISTRA la elección. Queda preparado para
   que, si más adelante se agrega analítica, se respete el rechazo:
     window.MythosCookieConsent.accepted('analytics')  // false si rechazó

   Autocontenido: inyecta su propio <style> con colores que se adaptan al tema
   (prefers-color-scheme + [data-theme]) — no depende del CSS de la página.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var KEY = 'mythos_cookie_consent';   // 'all' | 'essential'
  var VER = 'v1';

  function read() {
    try { return localStorage.getItem(KEY); } catch (_) { return null; }
  }
  function write(v) {
    try { localStorage.setItem(KEY, v); } catch (_) {}
  }

  // API pública para futuras integraciones (gating de analítica, etc.).
  window.MythosCookieConsent = {
    get: function () { return read(); },
    // Las esenciales siempre están permitidas; las demás categorías solo si
    // el usuario aceptó todo.
    accepted: function (category) {
      if (!category || category === 'essential' || category === 'necessary') return true;
      return read() === 'all';
    },
    reset: function () { try { localStorage.removeItem(KEY); } catch (_) {} render(); }
  };

  function choose(value) {
    write(value);
    var el = document.getElementById('mythos-cookie-banner');
    if (el && el.parentNode) el.parentNode.removeChild(el);
    try {
      document.dispatchEvent(new CustomEvent('mythos:cookieconsent', { detail: { choice: value } }));
    } catch (_) {}
  }

  function injectStyles() {
    if (document.getElementById('mythos-cookie-styles')) return;
    var css =
      '#mythos-cookie-banner{position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483000;' +
      'max-width:560px;margin:0 auto;background:#ffffff;color:#1d1d1f;border:1px solid #e5e5e7;' +
      'border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.18);padding:18px 20px;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
      'font-size:13.5px;line-height:1.55;animation:mcbIn .28s ease both}' +
      '@keyframes mcbIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}' +
      '#mythos-cookie-banner .mcb-title{font-weight:700;font-size:14.5px;margin:0 0 6px}' +
      '#mythos-cookie-banner p{margin:0 0 14px;color:#494950}' +
      '#mythos-cookie-banner a{color:inherit;text-decoration:underline;text-underline-offset:2px}' +
      '#mythos-cookie-banner .mcb-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}' +
      '#mythos-cookie-banner button{font:inherit;font-weight:600;cursor:pointer;border-radius:10px;' +
      'padding:9px 16px;border:1px solid transparent}' +
      '#mythos-cookie-banner .mcb-accept{background:#1d1d1f;color:#fff;border-color:#1d1d1f}' +
      '#mythos-cookie-banner .mcb-reject{background:transparent;color:#1d1d1f;border-color:#d2d2d7}' +
      '#mythos-cookie-banner .mcb-more{margin-left:auto;font-size:12.5px}' +
      '@media (prefers-color-scheme: dark){' +
        '#mythos-cookie-banner{background:#1c1c1e;color:#f5f5f7;border-color:#38383a;box-shadow:0 12px 40px rgba(0,0,0,.5)}' +
        '#mythos-cookie-banner p{color:#c7c7cc}' +
        '#mythos-cookie-banner .mcb-accept{background:#f5f5f7;color:#1d1d1f;border-color:#f5f5f7}' +
        '#mythos-cookie-banner .mcb-reject{color:#f5f5f7;border-color:#48484a}}' +
      // El toggle explícito de tema (data-theme) gana sobre el del sistema.
      'html[data-theme="dark"] #mythos-cookie-banner{background:#1c1c1e;color:#f5f5f7;border-color:#38383a;box-shadow:0 12px 40px rgba(0,0,0,.5)}' +
      'html[data-theme="dark"] #mythos-cookie-banner p{color:#c7c7cc}' +
      'html[data-theme="dark"] #mythos-cookie-banner .mcb-accept{background:#f5f5f7;color:#1d1d1f;border-color:#f5f5f7}' +
      'html[data-theme="dark"] #mythos-cookie-banner .mcb-reject{color:#f5f5f7;border-color:#48484a}' +
      'html[data-theme="light"] #mythos-cookie-banner{background:#fff;color:#1d1d1f;border-color:#e5e5e7}' +
      'html[data-theme="light"] #mythos-cookie-banner p{color:#494950}' +
      'html[data-theme="light"] #mythos-cookie-banner .mcb-accept{background:#1d1d1f;color:#fff;border-color:#1d1d1f}' +
      'html[data-theme="light"] #mythos-cookie-banner .mcb-reject{color:#1d1d1f;border-color:#d2d2d7}';
    var st = document.createElement('style');
    st.id = 'mythos-cookie-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function render() {
    if (read()) return;                                   // ya eligió → no mostrar
    if (document.getElementById('mythos-cookie-banner')) return;
    injectStyles();
    var box = document.createElement('div');
    box.id = 'mythos-cookie-banner';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-live', 'polite');
    box.setAttribute('aria-label', 'Aviso de cookies');
    box.innerHTML =
      '<div class="mcb-title">Cookies y privacidad</div>' +
      '<p>Usamos almacenamiento del navegador para que la app funcione, sea segura y recuerde tus preferencias. ' +
      'Hoy solo usamos lo <strong>necesario</strong> y algunos servicios de terceros esenciales (seguridad y mapas). ' +
      'Podés aceptar o rechazar las no esenciales. <a href="/cookies">Más información</a>.</p>' +
      '<div class="mcb-actions">' +
        '<button type="button" class="mcb-accept">Aceptar</button>' +
        '<button type="button" class="mcb-reject">Rechazar no esenciales</button>' +
        '<a class="mcb-more" href="/cookies">Política de cookies</a>' +
      '</div>';
    box.querySelector('.mcb-accept').addEventListener('click', function () { choose('all'); });
    box.querySelector('.mcb-reject').addEventListener('click', function () { choose('essential'); });
    (document.body || document.documentElement).appendChild(box);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
