/* ═══════════════════════════════════════════
   MYTHOS THEME — DESHABILITADO temporalmente
   Solo modo claro. El dark mode quedó con muchas
   fallas de contraste; se reintentará más adelante.
   API conservada para no romper paneles existentes.
═══════════════════════════════════════════ */
(function () {
  'use strict';

  var ATTR = 'data-theme';

  function applyLight() {
    var root = document.documentElement;
    root.setAttribute(ATTR, 'light');
    root.style.colorScheme = 'light';
    try {
      localStorage.removeItem('mythos_theme');
      localStorage.removeItem('mesa_theme');
    } catch (e) {}
  }

  applyLight();

  var Theme = {
    init: function () { applyLight(); return 'light'; },
    get: function () { return 'light'; },
    set: function () { applyLight(); },
    toggle: function () { applyLight(); return 'light'; },
    onChange: function () { /* noop */ },
    mountButton: function () { return null; },
  };

  window.MythosTheme = Theme;
})();
