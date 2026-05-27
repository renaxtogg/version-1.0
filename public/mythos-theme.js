/* ═══════════════════════════════════════════
   MYTHOS THEME — toggle claro/oscuro reutilizable
   Uso:
     <script src="mythos-theme.js"></script>
     <script>MythosTheme.init('light');</script>
     ...
     <span id="themeSlot"></span>
     <script>MythosTheme.mountButton('#themeSlot');</script>

   Eventos:
     document.addEventListener('mythos:themechange', e => e.detail.mode)
═══════════════════════════════════════════ */
(function () {
  'use strict';

  var STORAGE_KEY = 'mythos_theme';
  var LEGACY_KEY = 'mesa_theme'; // compat con paneles previos
  var ATTR = 'data-theme';

  function readStored() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      if (v === 'light' || v === 'dark') return v;
      var legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy === 'light' || legacy === 'dark') {
        localStorage.setItem(STORAGE_KEY, legacy);
        return legacy;
      }
    } catch (e) {}
    return null;
  }

  function writeStored(mode) {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
      localStorage.setItem(LEGACY_KEY, mode);
    } catch (e) {}
  }

  function apply(mode) {
    var root = document.documentElement;
    root.setAttribute(ATTR, mode);
    root.style.colorScheme = mode;
    var ev;
    try {
      ev = new CustomEvent('mythos:themechange', { detail: { mode: mode } });
    } catch (e) {
      ev = document.createEvent('CustomEvent');
      ev.initCustomEvent('mythos:themechange', false, false, { mode: mode });
    }
    document.dispatchEvent(ev);
  }

  var SVG_SUN =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="4"/>' +
    '<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>' +
    '</svg>';
  var SVG_MOON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>' +
    '</svg>';

  var Theme = {
    init: function (defaultMode) {
      var saved = readStored();
      var mode = saved || defaultMode || 'light';
      apply(mode);
      return mode;
    },
    get: function () {
      return document.documentElement.getAttribute(ATTR) || 'light';
    },
    set: function (mode) {
      if (mode !== 'light' && mode !== 'dark') return;
      apply(mode);
      writeStored(mode);
    },
    toggle: function () {
      var next = Theme.get() === 'dark' ? 'light' : 'dark';
      Theme.set(next);
      return next;
    },
    onChange: function (cb) {
      document.addEventListener('mythos:themechange', function (e) {
        cb(e.detail.mode);
      });
    },
    mountButton: function (target, opts) {
      var el = typeof target === 'string' ? document.querySelector(target) : target;
      if (!el) return null;
      opts = opts || {};
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ds-theme-btn' + (opts.className ? ' ' + opts.className : '');
      btn.title = 'Cambiar tema';
      btn.setAttribute('aria-label', 'Cambiar tema');
      function render() {
        // Muestra el ícono del modo al que se cambiaría (sol si está en dark, luna si está en light)
        btn.innerHTML = Theme.get() === 'dark' ? SVG_SUN : SVG_MOON;
      }
      render();
      btn.addEventListener('click', function () {
        Theme.toggle();
      });
      document.addEventListener('mythos:themechange', render);
      el.appendChild(btn);
      return btn;
    },
  };

  // Pre-init inmediato si hay valor guardado: evita flash al cargar
  var saved = readStored();
  if (saved) apply(saved);

  window.MythosTheme = Theme;
})();
