/* ═══════════════════════════════════════════════════════════════════════
   MYTHOS — SITIO WEB COMERCIAL  ·  comportamiento compartido (WEB-1)
   ─────────────────────────────────────────────────────────────────────
   Chrome compartido (header + footer) + interacciones del sitio público:
   toggle de tema (reusa MythosTheme), menú móvil, toggle de precios,
   animación de aparición al scroll, año del footer y enlaces de contacto.

   Sin dependencias de paneles ni de Supabase. Las páginas del sitio son
   estáticas: este archivo inyecta el header/footer en placeholders para
   mantener una sola fuente de verdad de la navegación. El contenido único
   de cada página vive en su HTML (SEO) + <noscript> de respaldo.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── Configuración del sitio ──────────────────────────────────────────
     TODO(WEB-5): reemplazar por el número de WhatsApp de ventas real de
     MYTHOS. Formato wa.me: código de país + número, sin "+" ni espacios.
     TODO(WEB-2/3): estos enlaces y textos pasarán a `marketing_config`
     (editable desde Superadmin → "Sitio web"). */
  var CONFIG = {
    whatsapp: '595000000000',                 // ← placeholder, cambiar en WEB-5
    whatsappMsg: 'Hola, quiero probar MYTHOS para mi restaurante.',
    email: 'hola@mythos.com.py',              // ← placeholder
    loginUrl: '/login',
    demoUrl: '/demo'
  };

  function waLink(msg) {
    var text = encodeURIComponent(msg || CONFIG.whatsappMsg);
    return 'https://wa.me/' + CONFIG.whatsapp + '?text=' + text;
  }

  function icon(name, opts) {
    return (window.MythosIcons && window.MythosIcons.html) ? window.MythosIcons.html(name, opts) : '';
  }

  /* ── Navegación (fuente única) ────────────────────────────────────────
     Enlaces a rutas limpias resueltas por rewrites en vercel.json. */
  var NAV = [
    { id: 'modulos',  label: 'Módulos',  href: '/inicio#modulos' },
    { id: 'demo',     label: 'Demo',     href: '/demo' },
    { id: 'precios',  label: 'Precios',  href: '/precios' },
    { id: 'contacto', label: 'Contacto', href: '/contacto' }
  ];

  /* ── Header ───────────────────────────────────────────────────────────── */
  function headerHTML(active) {
    var links = NAV.map(function (n) {
      var cur = (n.id === active) ? ' aria-current="page"' : '';
      return '<a href="' + n.href + '"' + cur + '>' + n.label + '</a>';
    }).join('');

    var mobileLinks = NAV.map(function (n) {
      return '<a href="' + n.href + '">' + n.label + '</a>';
    }).join('');

    return '' +
      '<header class="site-header">' +
        '<div class="wrap site-nav">' +
          '<a class="logo" href="/inicio" aria-label="MYTHOS — inicio">MYTHOS</a>' +
          '<nav class="nav-links" aria-label="Principal">' + links + '</nav>' +
          '<div class="nav-right">' +
            '<a class="btn btn-ghost btn-sm" href="' + CONFIG.loginUrl + '">Iniciar sesión</a>' +
            '<a class="btn btn-primary btn-sm btn-cta-desktop" href="/registro">Probar gratis</a>' +
            '<button class="icon-btn" type="button" id="mktTheme" aria-label="Cambiar tema">' + icon('moon') + '</button>' +
            '<button class="icon-btn nav-toggle" type="button" id="mktNavToggle" aria-label="Abrir menú" aria-expanded="false">' + icon('menu') + '</button>' +
          '</div>' +
        '</div>' +
        '<nav class="mobile-menu" id="mktMobile" aria-label="Menú móvil">' +
          mobileLinks +
          '<a href="' + CONFIG.loginUrl + '">Iniciar sesión</a>' +
          '<a class="btn btn-primary" href="/registro">Probar gratis</a>' +
        '</nav>' +
      '</header>';
  }

  /* ── Footer ───────────────────────────────────────────────────────────── */
  function footerHTML() {
    return '' +
      '<footer class="site-footer">' +
        '<div class="wrap">' +
          '<div class="foot-grid">' +
            '<div>' +
              '<div class="foot-logo">MYTHOS</div>' +
              '<p class="foot-about">El sistema operativo de tu restaurante. Menú, caja, cocina, delivery y más — en una sola plataforma.</p>' +
            '</div>' +
            '<div>' +
              '<h5>Producto</h5>' +
              '<a href="/precios">Precios</a>' +
              '<a href="/inicio#modulos">Módulos</a>' +
              '<a href="/demo">Demo</a>' +
              '<a href="/registro">Probar gratis</a>' +
            '</div>' +
            '<div>' +
              '<h5>Empresa</h5>' +
              '<a href="/contacto">Contacto</a>' +
              '<a href="/inicio#faq">Preguntas frecuentes</a>' +
              '<a href="' + CONFIG.loginUrl + '">Iniciar sesión</a>' +
            '</div>' +
            '<div>' +
              '<h5>Legal</h5>' +
              '<a href="/terminos">Términos</a>' +
              '<a href="/privacidad">Privacidad</a>' +
            '</div>' +
          '</div>' +
          '<div class="foot-bottom">' +
            '<span>© <span id="mktYear">2026</span> MYTHOS · Asunción, Paraguay</span>' +
            '<span class="t-item">' + icon('pin') + ' Hecho en Paraguay · Cobrá con Bancard</span>' +
          '</div>' +
        '</div>' +
      '</footer>';
  }

  /* ── Tema: light por defecto; toggle persistente vía MythosTheme ──────── */
  function syncThemeIcon() {
    var btn = document.getElementById('mktTheme');
    if (!btn || !window.MythosTheme) return;
    var isDark = window.MythosTheme.get() === 'dark';
    btn.innerHTML = icon(isDark ? 'sun' : 'moon');
  }

  function wireTheme() {
    var btn = document.getElementById('mktTheme');
    if (!btn || !window.MythosTheme) return;
    btn.addEventListener('click', function () {
      window.MythosTheme.set(window.MythosTheme.get() === 'dark' ? 'light' : 'dark');
      syncThemeIcon();
    });
    window.MythosTheme.onChange(syncThemeIcon);
    syncThemeIcon();
  }

  /* ── Menú móvil ───────────────────────────────────────────────────────── */
  function wireMobileMenu() {
    var toggle = document.getElementById('mktNavToggle');
    var menu = document.getElementById('mktMobile');
    if (!toggle || !menu) return;
    toggle.addEventListener('click', function () {
      var open = menu.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.innerHTML = icon(open ? 'x' : 'menu');
    });
    menu.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        menu.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.innerHTML = icon('menu');
      }
    });
  }

  /* ── Animación de aparición al scroll ─────────────────────────────────── */
  function wireReveal() {
    var els = document.querySelectorAll('.reveal');
    if (!els.length) return;
    if (!('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add('in'); io.unobserve(entry.target); }
      });
    }, { threshold: 0.12 });
    els.forEach(function (el) { io.observe(el); });
  }

  /* ── Toggle de precios mensual/anual ──────────────────────────────────── */
  function wirePricingToggle() {
    var tg = document.getElementById('priceToggle');
    if (!tg) return;
    var lblM = document.getElementById('lblMensual');
    var lblA = document.getElementById('lblAnual');
    var note = document.getElementById('saveNote');
    var annual = false;
    tg.addEventListener('click', function () {
      annual = !annual;
      tg.classList.toggle('on', annual);
      if (lblM) lblM.classList.toggle('act', !annual);
      if (lblA) lblA.classList.toggle('act', annual);
      document.querySelectorAll('.price span[data-m]').forEach(function (el) {
        el.textContent = annual ? el.dataset.a : el.dataset.m;
      });
      if (note) note.textContent = annual
        ? '2 meses gratis pagando anual — ahorrás hasta Gs 798.000/año'
        : '';
    });
  }

  /* ── Hidratación de íconos en HTML estático ───────────────────────────
     Permite usar el set SVG de mythos-icons.js desde HTML estático:
       <span data-icon="pin"></span>  ó  <span data-icon="check" data-icon-size="18"></span>
     Sin JS, queda vacío (el texto adyacente sigue siendo legible). */
  function hydrateIcons() {
    document.querySelectorAll('[data-icon]').forEach(function (el) {
      var name = el.getAttribute('data-icon');
      var size = el.getAttribute('data-icon-size');
      el.innerHTML = icon(name, size ? { size: parseInt(size, 10) } : undefined);
    });
  }

  /* ── Enlaces de WhatsApp/contacto ─────────────────────────────────────── */
  function wireContactLinks() {
    document.querySelectorAll('[data-wa]').forEach(function (a) {
      a.setAttribute('href', waLink(a.getAttribute('data-wa') || ''));
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
    });
    document.querySelectorAll('[data-email]').forEach(function (a) {
      a.setAttribute('href', 'mailto:' + CONFIG.email);
    });
  }

  /* ── Render del chrome + wiring ───────────────────────────────────────── */
  function renderChrome(opts) {
    opts = opts || {};
    var head = document.getElementById('site-header');
    var foot = document.getElementById('site-footer');
    if (head) head.innerHTML = headerHTML(opts.active || '');
    if (foot) foot.innerHTML = footerHTML();
    var y = document.getElementById('mktYear');
    if (y) { try { y.textContent = String(new Date().getFullYear()); } catch (e) {} }
    wireTheme();
    wireMobileMenu();
  }

  function init(opts) {
    renderChrome(opts);
    hydrateIcons();
    wirePricingToggle();
    wireContactLinks();
    wireReveal();
  }

  window.MythosWeb = {
    init: init,
    renderChrome: renderChrome,
    waLink: waLink,
    config: CONFIG
  };
})();
