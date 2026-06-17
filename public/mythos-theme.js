/* ═══════════════════════════════════════════
   MYTHOS THEME — foundation de tema (PR-B1, FASE B)
   ─────────────────────────────────────────────
   Fuente única de verdad para `data-theme` en <html> + persistencia local.

   • Preferencia del usuario en localStorage['mythos-theme']: 'light' | 'dark' | 'system'.
     'system' (o sin preferencia) → window.matchMedia('(prefers-color-scheme: dark)').
   • init('light'|'dark')  → PIN por panel (compat hacia atrás). NO persiste y NO
     cambia la apariencia actual: todos los paneles siguen fijando su modo, así que
     PR-B1 no libera dark global ni rediseña nada.
   • init() (sin argumento) → modo guiado por preferencia/sistema (lo usará PR-B4
     cuando cada panel pase el checklist de dark).
   • set('light'|'dark'|'system') / toggle() → elección EXPLÍCITA del usuario:
     persiste, quita el pin y aplica. Pensado para el toggle real de PR-B4.

   Clave de storage previa: la versión anterior NO persistía y limpiaba las claves
   legacy 'mythos_theme'/'mesa_theme' (con guion bajo). La clave oficial nueva es
   'mythos-theme' (con guion); las legacy se siguen limpiando por higiene.
═══════════════════════════════════════════ */
(function () {
  'use strict';

  var ATTR = 'data-theme';
  var STORAGE_KEY = 'mythos-theme';                 // 'light' | 'dark' | 'system'
  var VALID = { light: 1, dark: 1, system: 1 };

  var current = 'light';   // tema EFECTIVO aplicado ('light' | 'dark')
  var pinnedMode = null;   // modo fijado por un panel via init('light'|'dark')

  function mql() {
    try { return window.matchMedia('(prefers-color-scheme: dark)'); }
    catch (e) { return null; }
  }

  function systemTheme() {
    var m = mql();
    return (m && m.matches) ? 'dark' : 'light';
  }

  function readPreference() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      return VALID[v] ? v : 'system';               // ausente / inválido → 'system'
    } catch (e) { return 'system'; }
  }

  function writePreference(pref) {
    try { localStorage.setItem(STORAGE_KEY, pref); } catch (e) {}
  }

  // pref ('light'|'dark'|'system') → tema efectivo ('light'|'dark')
  function resolve(pref) {
    var p = VALID[pref] ? pref : 'system';
    return (p === 'system') ? systemTheme() : p;
  }

  function apply(theme) {
    current = (theme === 'dark') ? 'dark' : 'light';
    var root = document.documentElement;
    root.setAttribute(ATTR, current);
    root.style.colorScheme = current;
    try {
      // Higiene: claves legacy de la convención vieja (con guion bajo).
      localStorage.removeItem('mythos_theme');
      localStorage.removeItem('mesa_theme');
    } catch (e) {}
    try {
      document.dispatchEvent(new CustomEvent('mythos:themechange', { detail: { mode: current } }));
    } catch (e) {}
    return current;
  }

  function applyResolved() {
    return apply(resolve(readPreference()));
  }

  // Reaccionar a cambios del SO SOLO cuando la preferencia es 'system' y ningún
  // panel fijó su modo. Hoy todos los paneles pinnean → no afecta su apariencia.
  var media = mql();
  if (media) {
    var onSystemChange = function () {
      if (pinnedMode === null && readPreference() === 'system') applyResolved();
    };
    if (media.addEventListener) media.addEventListener('change', onSystemChange);
    else if (media.addListener) media.addListener(onSystemChange); // Safari/WebKit viejo
  }

  var Theme = {
    // Con 'light'|'dark' = pin por panel (compat; NO persiste, NO cambia el look actual).
    // Sin argumento = modo guiado por preferencia/sistema (camino de PR-B4).
    init: function (mode) {
      if (mode === 'light' || mode === 'dark') {
        pinnedMode = mode;
        return apply(mode);
      }
      pinnedMode = null;
      return applyResolved();
    },
    get: function () { return current; },             // tema efectivo aplicado
    getPreference: readPreference,                    // 'light' | 'dark' | 'system'
    resolve: resolve,
    // Elección explícita del usuario: persiste, quita el pin y aplica.
    set: function (pref) {
      var p = VALID[pref] ? pref : 'system';
      writePreference(p);
      pinnedMode = null;
      return applyResolved();
    },
    toggle: function () {
      return Theme.set(current === 'dark' ? 'light' : 'dark');
    },
    onChange: function (cb) {
      if (typeof cb !== 'function') return function () {};
      var handler = function (e) { cb((e && e.detail && e.detail.mode) || current); };
      document.addEventListener('mythos:themechange', handler);
      return function () { document.removeEventListener('mythos:themechange', handler); };
    },
    // El wiring de un botón de toggle se hace en PR-B4 (no liberar dark parcial aún).
    mountButton: function () { return null; },
  };

  window.MythosTheme = Theme;

  // Estado inicial del foundation: data-theme en <html> desde preferencia/sistema.
  // Cada panel ejecuta luego MythosTheme.init('light'|'dark') y fija su modo, por lo
  // que en PR-B1 no hay cambio visual respecto del comportamiento previo.
  applyResolved();
})();
