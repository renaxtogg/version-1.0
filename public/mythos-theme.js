/* ═══════════════════════════════════════════
   MYTHOS THEME — modo fijo por panel
   El toggle global está deshabilitado por ahora.
   Cada panel decide su modo via MythosTheme.init('light'|'dark').
   No se persiste en localStorage ni hay botón de toggle.
═══════════════════════════════════════════ */
(function () {
  'use strict';

  var ATTR = 'data-theme';
  var current = 'light';

  function apply(mode) {
    current = (mode === 'dark') ? 'dark' : 'light';
    var root = document.documentElement;
    root.setAttribute(ATTR, current);
    root.style.colorScheme = current;
    try {
      localStorage.removeItem('mythos_theme');
      localStorage.removeItem('mesa_theme');
    } catch (e) {}
    try {
      var ev = new CustomEvent('mythos:themechange', { detail: { mode: current } });
      document.dispatchEvent(ev);
    } catch (e) {}
  }

  var Theme = {
    init: function (mode) { apply(mode); return current; },
    get: function () { return current; },
    set: function () { /* deshabilitado */ },
    toggle: function () { return current; },
    onChange: function () { /* noop */ },
    mountButton: function () { return null; },
  };

  window.MythosTheme = Theme;
})();
