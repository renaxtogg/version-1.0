/* ═══════════════════════════════════════════════════════════════════════
   MYTHOS — SITIO WEB COMERCIAL  ·  comportamiento compartido (WEB-1 → WEB-3)
   ─────────────────────────────────────────────────────────────────────
   Chrome compartido (header + footer) + interacciones del sitio público:
   tema, menú móvil, scroll-reveal, formateo de guaraníes, WhatsApp dinámico
   (desde marketing_config), tracking de eventos, y PRECIOS DINÁMICOS
   (planes/toggle/ahorro/calculadora/oferta fundador) leídos de Supabase vía
   `window.MythosWebData`, con FALLBACK estático seguro.

   Degradación: si no hay capa de datos (window.MythosWebData) ni Supabase,
   el sitio sigue funcionando con su HTML estático; las lecturas devuelven
   fallback y el tracking no-opera. Nunca muestra errores técnicos al usuario.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── Configuración (defaults; sales_whatsapp/founder se sobreescriben desde
     marketing_config en runtime). TODO(WEB-5): número de WhatsApp real. ──── */
  var CONFIG = {
    whatsapp: '595987436592',   // se sobreescribe con marketing_config.whatsapp en runtime
    whatsappMsg: 'Hola, quiero probar MYTHOS para mi restaurante.',
    email: 'mancuellorenato@gmail.com',   // se sobreescribe con marketing_config.contact_email
    loginUrl: '/login',
    founderLimit: 10
  };

  var _config = null;        // marketing_config público (cacheado)
  var _plans = null;         // planes (DB o fallback)
  var _addons = null;        // add-ons (DB o fallback)
  // Features comerciales aún NO oficiales: se excluyen de los add-ons que se
  // renderizan en el sitio (no se toca la DB ni web-marketing-data.js).
  // 'inventario-recetas' NO es add-on: los Insumos/Recetas vienen en TODOS los planes
  // (se lista acá además por si quedó una fila vieja en marketing_add_ons de la DB).
  // ► Reactivar = vaciar este array: var PENDING_ADDONS = [];
  var PENDING_ADDONS = ['bancard', 'facturacion-electronica', 'inventario-recetas'];
  var _annual = false;       // estado del toggle mensual/anual
  var _calcStarted = false;  // para disparar pricing_calculator_start una vez
  var _selectedSlug = null;  // tarjeta de plan seleccionada (se expande/destaca)

  /* ── Utilidades ───────────────────────────────────────────────────────── */
  // Número en dígitos para wa.me (tolera que CONFIG.whatsapp venga formateado).
  function waNumber() { return String(CONFIG.whatsapp || '').replace(/\D/g, ''); }
  function waLink(msg) {
    return 'https://wa.me/' + waNumber() + '?text=' + encodeURIComponent(msg || CONFIG.whatsappMsg);
  }
  function icon(name, opts) {
    return (window.MythosIcons && window.MythosIcons.html) ? window.MythosIcons.html(name, opts) : '';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  // "99000" → "99.000"
  function formatMiles(n) {
    if (n == null || isNaN(n)) return '';
    var s = String(Math.round(Math.abs(n)));
    return (n < 0 ? '-' : '') + s.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }
  // 99000 → "Gs. 99.000"
  function formatGs(n) {
    if (n == null || isNaN(n)) return 'A cotizar';
    return 'Gs. ' + formatMiles(n);
  }
  function track(name, meta) {
    if (window.MythosWebData && MythosWebData.trackEvent) {
      try { MythosWebData.trackEvent(name, meta || {}); } catch (e) {}
    }
  }

  /* ── Navegación (fuente única) ────────────────────────────────────────── */
  var NAV = [
    { id: 'modulos',     label: 'Módulos',     href: '/inicio#modulos' },
    { id: 'demo',        label: 'Demo',        href: '/inicio#demo' },
    { id: 'precios',     label: 'Precios',     href: '/precios' },
    { id: 'proveedores', label: 'Proveedores', href: '/proveedores' },
    { id: 'contacto',    label: 'Contacto',    href: '/contacto' }
  ];

  function headerHTML(active) {
    var links = NAV.map(function (n) {
      return '<a href="' + n.href + '"' + (n.id === active ? ' aria-current="page"' : '') + '>' + n.label + '</a>';
    }).join('');
    var mobileLinks = NAV.map(function (n) { return '<a href="' + n.href + '">' + n.label + '</a>'; }).join('');
    return '' +
      '<header class="site-header">' +
        '<div class="wrap site-nav">' +
          '<a class="logo" href="/inicio" aria-label="MYTHOS — inicio">MYTHOS</a>' +
          '<nav class="nav-links" aria-label="Principal">' + links + '</nav>' +
          '<div class="nav-right">' +
            '<a class="btn btn-ghost btn-sm" href="' + CONFIG.loginUrl + '" data-track="login_entry_click">Iniciar sesión</a>' +
            '<a class="btn btn-primary btn-sm btn-cta-desktop" href="/registro" data-track="trial_click">Probar gratis</a>' +
            '<button class="icon-btn" type="button" id="mktTheme" aria-label="Cambiar tema">' + icon('moon') + '</button>' +
            '<button class="icon-btn nav-toggle" type="button" id="mktNavToggle" aria-label="Abrir menú" aria-expanded="false">' + icon('menu') + '</button>' +
          '</div>' +
        '</div>' +
        '<nav class="mobile-menu" id="mktMobile" aria-label="Menú móvil">' +
          mobileLinks +
          '<a href="' + CONFIG.loginUrl + '" data-track="login_entry_click">Iniciar sesión</a>' +
          '<a class="btn btn-primary" href="/registro" data-track="trial_click">Probar gratis</a>' +
        '</nav>' +
      '</header>';
  }

  function footerHTML() {
    return '' +
      '<footer class="site-footer">' +
        '<div class="wrap">' +
          '<div class="foot-grid">' +
            '<div>' +
              '<div class="foot-logo">MYTHOS</div>' +
              '<p class="foot-about">El sistema operativo de tu restaurante. Menú, caja, cocina, delivery y más — en una sola plataforma.</p>' +
              // Redes: se pintan en updateFooterDynamic() desde marketing_config; vacías se ocultan.
              '<div class="foot-social" id="footSocial" style="display:flex;gap:8px;margin-top:12px"></div>' +
            '</div>' +
            '<div><h5>Producto</h5><a href="/precios">Precios</a><a href="/inicio#modulos">Módulos</a><a href="/inicio#demo">Demo</a><a href="/registro">Probar gratis</a></div>' +
            '<div><h5>Empresa</h5><a href="/contacto">Contacto</a><a href="/proveedores">Quiero ser proveedor</a><a href="/inicio#faq">Preguntas frecuentes</a><a href="' + CONFIG.loginUrl + '" data-track="login_entry_click">Iniciar sesión</a></div>' +
            '<div><h5>Contacto y legal</h5>' +
              '<a id="footWa" data-wa="Hola, quiero más información sobre MYTHOS." style="display:none">WhatsApp</a>' +
              '<a id="footEmail" data-email>Escribinos por email</a>' +
              '<a href="/terminos">Términos</a><a href="/privacidad">Privacidad</a><a href="/cookies">Cookies</a>' +
            '</div>' +
          '</div>' +
          '<div class="foot-bottom">' +
            '<span>© <span id="mktYear">2026</span> MYTHOS · Fernando de la Mora, Paraguay</span>' +
            /* ORIGINAL (reactivar): ' Hecho en Paraguay · Cobrá con Bancard' */
            '<span class="t-item">' + icon('pin') + ' Hecho en Paraguay</span>' +
          '</div>' +
        '</div>' +
      '</footer>';
  }

  /* ── Redes sociales (SVG inline; se ocultan si no hay URL) ─────────────── */
  var SOCIAL_SVG = {
    instagram: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>',
    facebook:  '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M22 12a10 10 0 1 0-11.5 9.9v-7H8v-2.9h2.5V9.6c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.3c-1.2 0-1.6.8-1.6 1.6v1.9h2.8l-.5 2.9h-2.3v7A10 10 0 0 0 22 12z"/></svg>',
    tiktok:    '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M16.5 3c.3 2 1.6 3.6 3.5 3.9v2.6c-1.3 0-2.6-.4-3.7-1.1v5.7a5.6 5.6 0 1 1-5.6-5.6c.3 0 .6 0 .9.1v2.7a2.9 2.9 0 1 0 2 2.8V3h2.9z"/></svg>'
  };
  function socialLink(url, name, label) {
    var u = String(url || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) {
      // Tolera "instagram.com/x" pero NO un handle suelto (@x): sin dominio no
      // hay link válido → se oculta el ícono en vez de generar un 404.
      if (!/^[\w.-]+\.[a-z]{2,}/i.test(u)) return '';
      u = 'https://' + u;
    }
    return '<a href="' + esc(u) + '" target="_blank" rel="noopener" aria-label="' + esc(label) + '" title="' + esc(label) + '"' +
      ' style="display:inline-flex;width:34px;height:34px;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:8px;color:inherit">' +
      (SOCIAL_SVG[name] || '') + '</a>';
  }

  /* ── Tema ─────────────────────────────────────────────────────────────── */
  function syncThemeIcon() {
    var btn = document.getElementById('mktTheme');
    if (!btn || !window.MythosTheme) return;
    btn.innerHTML = icon(window.MythosTheme.get() === 'dark' ? 'sun' : 'moon');
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

  /* ── Scroll-reveal ────────────────────────────────────────────────────── */
  function wireReveal() {
    var els = document.querySelectorAll('.reveal');
    if (!els.length) return;
    if (!('IntersectionObserver' in window)) { els.forEach(function (el) { el.classList.add('in'); }); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add('in'); io.unobserve(entry.target); }
      });
    }, { threshold: 0.12 });
    els.forEach(function (el) { io.observe(el); });
  }

  /* ── Hidratación de íconos en HTML estático ───────────────────────────── */
  function hydrateIcons() {
    document.querySelectorAll('[data-icon]').forEach(function (el) {
      var name = el.getAttribute('data-icon');
      var size = el.getAttribute('data-icon-size');
      el.innerHTML = icon(name, size ? { size: parseInt(size, 10) } : undefined);
    });
  }

  /* ── Enlaces de WhatsApp/email (idempotente; re-aplica el número actual) ─
     Si no hay número REAL configurado (vacío o el placeholder), el enlace de
     WhatsApp queda sin href (no clickeable) en vez de apuntar a un número falso. */
  function wireContactLinks() {
    var num = String(CONFIG.whatsapp || '').replace(/\D/g, '');
    var waOk = num && num !== '595000000000';
    document.querySelectorAll('[data-wa]').forEach(function (a) {
      if (!waOk) {
        // Sin número real: si el enlace declara un fallback (p.ej. la tarjeta
        // "A cotizar" → /contacto), lo usamos; si no, se deshabilita.
        var fb = a.getAttribute('data-wa-fallback');
        if (fb) { a.setAttribute('href', fb); a.removeAttribute('target'); a.style.cursor = ''; }
        else { a.removeAttribute('href'); a.removeAttribute('target'); a.style.cursor = 'default'; }
        return;
      }
      a.setAttribute('href', waLink(a.getAttribute('data-wa') || ''));
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
      a.style.cursor = '';
    });
    document.querySelectorAll('[data-email]').forEach(function (a) {
      a.setAttribute('href', 'mailto:' + CONFIG.email);
    });
  }

  /* ── Tracking por atributos (anti doble-binding) ──────────────────────── */
  function wireTracking() {
    document.querySelectorAll('[data-wa]').forEach(function (a) {
      if (a.__waTrack) return; a.__waTrack = true;
      a.addEventListener('click', function () {
        track('whatsapp_click', { label: (a.textContent || '').trim().slice(0, 40) });
      });
    });
    document.querySelectorAll('[data-track]').forEach(function (el) {
      if (el.__evTrack) return; el.__evTrack = true;
      el.addEventListener('click', function () {
        var meta = {};
        if (el.getAttribute('data-plan')) meta.plan_slug = el.getAttribute('data-plan');
        track(el.getAttribute('data-track'), meta);
      });
    });
  }

  /* ── Toggle de precios ESTÁTICO (fallback si no hay capa de datos) ─────── */
  function wireStaticPricingToggle() {
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
      if (note) note.textContent = annual ? '2 meses gratis pagando anual' : '';
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     PRECIOS DINÁMICOS (web.html / precios.html)
     ═══════════════════════════════════════════════════════════════════════ */
  function planTitle(p) { return esc(String(p.name || '').replace(/^MYTHOS\s+/i, '') || p.name || ''); }
  function planIsQuote(p) { return !!p.is_enterprise || p.price_monthly_gs == null; }
  function planSavings(p) {
    if (p.price_monthly_gs == null || p.price_annual_gs == null) return 0;
    return (p.price_monthly_gs * 12) - p.price_annual_gs;
  }

  /* ── Lista "incluye" AUTO-GENERADA desde la config real del plan ─────────
     Fuente: marketing_plans.plan_config (espejo de allowed_panels + allowed_
     features + límites del plan operativo, mig 153). Los labels replican la
     taxonomía del superadmin (PANEL_OPTIONS / FEATURE_GROUPS). Así la lista
     SIEMPRE coincide con lo configurado, sin editarla a mano. ───────────── */
  var PANEL_ORDER = ['caja', 'mozo', 'cocina', 'delivery-cliente', 'delivery-rider', 'gerente'];
  var PANEL_LABELS = {
    'caja': 'Caja',
    'mozo': 'Mozo',
    'cocina': 'Cocina (KDS)',
    'delivery-cliente': 'Delivery Cliente',
    'delivery-rider': 'Rider',
    'gerente': 'Gerente'
  };
  var FEATURE_ORDER = ['admin:inventory', 'admin:crm', 'admin:delivery_zones'];
  var FEATURE_LABELS = {
    'admin:inventory': 'Control de Insumos',
    'admin:crm': 'CRM',
    'admin:delivery_zones': 'Mapas/Zonas'
  };
  // Features aún NO vivas: NUNCA se listan como incluidas → van como "Próximamente".
  var PENDING_FEATURE_LABELS = {
    'caja:sifen': 'Facturación electrónica (SIFEN)',
    'caja:digital_payments': 'Pagos online con Bancard',
    'mozo:digital_qr_pay': 'Cobro en mesa por QR'
  };
  function asList(v) { return Array.isArray(v) ? v : []; }

  // Lista "incluye" desde la config real del plan operativo vinculado.
  // Base (todo plan): Carta digital + Gestión (Admin). Luego paneles POS, features
  // vivas y límites (N mesas / N ítems / N mozos). Ej. Emprendedor (sin POS):
  // Carta digital con QR · Gestión (Admin) · Control de Insumos · 5 mesas · 30 ítems.
  function planIncludes(cfg) {
    cfg = cfg || {};
    var panels = asList(cfg.panels), feats = asList(cfg.features);
    var users = (cfg.max_users && typeof cfg.max_users === 'object') ? cfg.max_users : {};
    var out = ['Carta digital con QR', 'Gestión (Admin)'];
    PANEL_ORDER.forEach(function (k) { if (panels.indexOf(k) >= 0) out.push(PANEL_LABELS[k]); });
    FEATURE_ORDER.forEach(function (k) { if (feats.indexOf(k) >= 0) out.push(FEATURE_LABELS[k]); });
    if (cfg.max_tables != null && cfg.max_tables > 0) out.push(cfg.max_tables + ' mesas');
    else if (panels.indexOf('mozo') >= 0 || panels.indexOf('caja') >= 0) out.push('Mesas ilimitadas');
    if (cfg.max_menu_items != null && cfg.max_menu_items > 0) out.push(formatMiles(cfg.max_menu_items) + ' ítems');
    else out.push('Ítems ilimitados');
    if (users.mozo != null && users.mozo > 0) out.push(users.mozo + ' mozos');
    return out;
  }
  function planPending(cfg) {
    cfg = cfg || {};
    return asList(cfg.features).map(function (k) { return PENDING_FEATURE_LABELS[k]; }).filter(Boolean);
  }

  function planCardHTML(p) {
    var priceInner;
    if (_annual && p.price_annual_gs != null)
      priceInner = '<span class="gs">Gs</span>' + formatMiles(p.price_annual_gs) + '<small>/año</small>';
    else
      priceInner = '<span class="gs">Gs</span>' + formatMiles(p.price_monthly_gs) + '<small>/mes</small>';

    var save = (_annual && planSavings(p) > 0)
      ? '<div class="plan-save">Ahorrás ' + formatGs(planSavings(p)) + ' al año</div>' : '';

    // Lista "incluye" GENERADA desde la config real; fallback a features manuales.
    var incArr = p.plan_config ? planIncludes(p.plan_config) : null;
    if (!incArr || !incArr.length) incArr = asList(p.features);
    var feats = incArr.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('');
    // Solo recortamos (y ofrecemos "ver todo") cuando la lista no entra colapsada.
    var clip = incArr.length > 5;
    var pending = planPending(p.plan_config);
    var pendHTML = pending.length
      ? '<div class="plan-soon"><span>Próximamente</span> ' + pending.map(esc).join(' · ') + '</div>' : '';
    var descHTML = p.description ? '<p class="plan-desc">' + esc(p.description) + '</p>' : '';
    var moreHTML = clip ? '<div class="plan-more" aria-hidden="true">Ver todo lo que incluye</div>' : '';
    var sel = (p.slug === _selectedSlug) ? ' is-selected' : '';

    var cta = '<a class="btn ' + (p.is_recommended ? 'btn-primary' : 'btn-secondary') +
      '" href="/registro?plan=' + encodeURIComponent(p.slug) + '" data-track="pricing_plan_click" data-plan="' + esc(p.slug) + '">Probar gratis</a>';

    return '<div class="plan' + (p.is_recommended ? ' feat' : '') + sel + '" data-plan-card data-slug="' + esc(p.slug) + '">' +
      (p.badge ? '<div class="tag">' + esc(p.badge) + '</div>' : '') +
      '<h3>' + planTitle(p) + '</h3>' +
      '<div class="frase">' + esc(p.headline || '') + '</div>' +
      '<div class="price">' + priceInner + '</div>' + save +
      descHTML +
      '<ul class="plan-incl' + (clip ? ' plan-incl--clip' : '') + '">' + feats + '</ul>' + pendHTML +
      moreHTML +
      cta + '</div>';
  }

  // 4ª tarjeta estática: "A cotizar / A medida" (reemplaza al plan Enterprise en
  // la grilla). Botón "Contactar" → WhatsApp de marketing_config; si no hay número
  // configurado, cae a /contacto (data-wa-fallback, resuelto en wireContactLinks).
  function quoteCardHTML() {
    var sel = ('a-medida' === _selectedSlug) ? ' is-selected' : '';
    var msg = 'Hola, quiero cotizar un desarrollo a medida para mi negocio.';
    return '<div class="plan plan-quote' + sel + '" data-plan-card data-slug="a-medida">' +
      '<h3>A cotizar / A medida</h3>' +
      '<div class="frase">Para cadenas y necesidades especiales</div>' +
      '<div class="price price-quote">A cotizar</div>' +
      '<p class="plan-desc">¿Necesitás algo a medida? Para cadenas o negocios con necesidades especiales: desarrollamos y adaptamos lo que tu operación pida — módulos a medida, integraciones, multi-sucursal y más.</p>' +
      '<ul class="plan-incl">' +
        '<li>Módulos y features a medida</li>' +
        '<li>Integraciones con tus sistemas</li>' +
        '<li>Multi-sucursal avanzado</li>' +
        '<li>Onboarding dedicado</li>' +
      '</ul>' +
      '<a class="btn btn-secondary" data-wa="' + esc(msg) + '" data-wa-fallback="/contacto" data-track="pricing_plan_click" data-plan="a-medida">Contactar</a>' +
      '</div>';
  }

  function selectPlan(slug) {
    if (!slug) return;
    _selectedSlug = slug;
    var grid = document.getElementById('plansGrid');
    if (!grid) return;
    [].slice.call(grid.querySelectorAll('[data-plan-card]')).forEach(function (card) {
      card.classList.toggle('is-selected', card.getAttribute('data-slug') === slug);
    });
    track('pricing_plan_select', { plan_slug: slug });
  }

  function wirePlanSelection() {
    var grid = document.getElementById('plansGrid');
    if (!grid) return;
    [].slice.call(grid.querySelectorAll('[data-plan-card]')).forEach(function (card) {
      card.addEventListener('click', function (e) {
        // No robar el click a los enlaces/botones (la CTA navega normalmente).
        if (e.target && e.target.closest && e.target.closest('a,button')) return;
        selectPlan(card.getAttribute('data-slug'));
      });
    });
  }

  function renderPlans() {
    var grid = document.getElementById('plansGrid');
    if (!grid || !_plans) return;
    // Solo planes de precio (activos ya filtrados por RLS); los "a cotizar" se
    // sustituyen por la tarjeta estática "A cotizar / A medida".
    var real = _plans.filter(function (p) { return !planIsQuote(p); });
    if (!_selectedSlug) {
      var rec = real.filter(function (p) { return p.is_recommended; })[0];
      _selectedSlug = rec ? rec.slug : (real[0] ? real[0].slug : null);
    }
    grid.innerHTML = real.map(planCardHTML).join('') + quoteCardHTML();
    wirePlanSelection();
    wireContactLinks();
    wireTracking();
  }

  function updateSaveNote() {
    var note = document.getElementById('saveNote');
    if (!note) return;
    if (!_annual || !_plans) { note.textContent = ''; return; }
    var max = 0;
    _plans.forEach(function (p) { var s = planSavings(p); if (s > max) max = s; });
    note.textContent = max > 0 ? ('Pagando anual ahorrás hasta ' + formatGs(max) + ' al año') : '';
  }

  function wireDynamicToggle() {
    var tg = document.getElementById('priceToggle');
    if (!tg || tg.__wired) return; tg.__wired = true;
    var lblM = document.getElementById('lblMensual');
    var lblA = document.getElementById('lblAnual');
    tg.addEventListener('click', function () {
      _annual = !_annual;
      tg.classList.toggle('on', _annual);
      if (lblM) lblM.classList.toggle('act', !_annual);
      if (lblA) lblA.classList.toggle('act', _annual);
      renderPlans();
      updateSaveNote();
      recalc();
      track('pricing_toggle_billing', { annual: _annual });
    });
  }

  function updateFounder() {
    var el = document.getElementById('founderBanner');
    if (!el) return;
    var cfg = _config || {};
    if (cfg.founder_offer_active === false) { el.style.display = 'none'; return; }
    var limit = (cfg.founder_offer_limit != null) ? cfg.founder_offer_limit : CONFIG.founderLimit;
    el.style.display = '';
    el.innerHTML =
      '<div><b><span data-icon="star"></span> Oferta Fundador — solo ' + esc(limit) + ' lugares</b>' +
      '<p>Precio congelado de por vida + 50% off los primeros 3 meses, a cambio de tu testimonio. Para los primeros ' + esc(limit) + ' restaurantes.</p></div>' +
      '<a class="btn btn-primary btn-sm" data-wa="' + esc('Hola, quiero uno de los ' + limit + ' lugares de la Oferta Fundador de MYTHOS.') + '" data-track="founder_click">Quiero un lugar</a>';
    hydrateIcons();
    wireContactLinks();
    wireTracking();
  }

  /* ── Armador "Calculá tu precio" (precios.html) ───────────────────────── */
  function buildCalculator() {
    var host = document.getElementById('calculator');
    if (!host || !_plans || !_addons) return;

    var planRadios = _plans.map(function (p) {
      var sub = planIsQuote(p) ? 'A cotizar' : formatGs(p.price_monthly_gs) + '/mes';
      return '<label class="calc-opt"><input type="radio" name="calcPlan" value="' + esc(p.slug) + '"' + (p.is_recommended ? ' checked' : '') + '>' +
        '<span class="calc-opt-main"><b>' + planTitle(p) + '</b><span class="calc-opt-sub">' + esc(sub) + '</span></span></label>';
    }).join('');

    var addonChecks = _addons.map(function (a) {
      var sub = a.price_type === 'cotizar' ? 'A cotizar' : '+' + formatGs(a.price_gs) + '/mes';
      return '<label class="calc-opt"><input type="checkbox" name="calcAddon" value="' + esc(a.slug) + '" data-price="' + (a.price_gs || 0) + '" data-type="' + esc(a.price_type) + '">' +
        '<span class="calc-opt-main"><b>' + esc(a.name) + '</b><span class="calc-opt-sub">' + esc(sub) + '</span></span></label>';
    }).join('');

    host.innerHTML =
      '<div class="calc">' +
        '<div class="calc-col"><div class="calc-h">Elegí tu plan</div>' + planRadios + '</div>' +
        '<div class="calc-col"><div class="calc-h">Sumá add-ons</div>' + addonChecks + '</div>' +
        '<div class="calc-summary">' +
          '<div class="calc-total-label">Total mensual</div>' +
          '<div class="calc-total" id="calcTotal">—</div>' +
          '<div class="calc-annual" id="calcAnnual"></div>' +
          '<a class="btn btn-primary" id="calcCta">Empezar prueba gratis</a>' +
        '</div>' +
      '</div>';

    host.querySelectorAll('input[name="calcPlan"]').forEach(function (r) {
      r.addEventListener('change', function () { firstInteract(); track('pricing_plan_click', { plan_slug: r.value, source: 'calculator' }); recalc(); });
    });
    host.querySelectorAll('input[name="calcAddon"]').forEach(function (ch) {
      ch.addEventListener('change', function () { firstInteract(); track('pricing_addon_toggle', { addon: ch.value, checked: ch.checked }); recalc(); });
    });
    var cta = document.getElementById('calcCta');
    if (cta) cta.addEventListener('click', function () {
      var ctx = calcContext();
      track(ctx.quote ? 'whatsapp_click' : 'trial_click', { plan_slug: ctx.plan && ctx.plan.slug, addons: ctx.addonSlugs, source: 'calculator' });
    });

    recalc();
  }

  function calcContext() {
    var host = document.getElementById('calculator');
    var sel = host && host.querySelector('input[name="calcPlan"]:checked');
    var plan = (sel && _plans) ? _plans.filter(function (p) { return p.slug === sel.value; })[0] : (_plans ? _plans[0] : null);
    var checked = host ? [].slice.call(host.querySelectorAll('input[name="calcAddon"]:checked')) : [];
    var addonSlugs = checked.map(function (c) { return c.value; });
    var anyCotizar = checked.some(function (c) { return c.getAttribute('data-type') === 'cotizar'; });
    var addonMonthly = checked.reduce(function (s, c) { return s + (parseInt(c.getAttribute('data-price'), 10) || 0); }, 0);
    return { plan: plan, checked: checked, addonSlugs: addonSlugs, anyCotizar: anyCotizar, addonMonthly: addonMonthly, quote: (plan ? planIsQuote(plan) : false) || anyCotizar };
  }

  function recalc() {
    var host = document.getElementById('calculator');
    if (!host || !_plans) return;
    var totalEl = document.getElementById('calcTotal');
    var annualEl = document.getElementById('calcAnnual');
    var cta = document.getElementById('calcCta');
    if (!totalEl || !cta) return;
    var c = calcContext();
    if (!c.plan) return;

    if (c.quote) {
      totalEl.textContent = 'A cotizar';
      if (annualEl) annualEl.textContent = '';
      cta.textContent = 'Contactar ventas';
      cta.setAttribute('href', waLink('Hola, quiero cotizar MYTHOS: plan ' + c.plan.name + (c.addonSlugs.length ? ' + add-ons ' + c.addonSlugs.join(', ') : '') + '.'));
      cta.setAttribute('target', '_blank'); cta.setAttribute('rel', 'noopener');
    } else {
      var monthly = (c.plan.price_monthly_gs || 0) + c.addonMonthly;
      totalEl.textContent = formatGs(monthly);
      if (annualEl) {
        annualEl.textContent = (c.plan.price_annual_gs != null)
          ? ('o ' + formatGs(c.plan.price_annual_gs + c.addonMonthly * 12) + ' al año') : '';
      }
      cta.textContent = 'Empezar prueba gratis';
      cta.setAttribute('href', '/registro?plan=' + encodeURIComponent(c.plan.slug) + (c.addonSlugs.length ? '&addons=' + encodeURIComponent(c.addonSlugs.join(',')) : ''));
      cta.removeAttribute('target');
    }
  }

  function firstInteract() {
    if (_calcStarted) return;
    _calcStarted = true;
    track('pricing_calculator_start', {});
  }

  function initPricing() {
    var hasPlans = !!document.getElementById('plansGrid');
    var hasCalc = !!document.getElementById('calculator');
    if (!hasPlans && !hasCalc) return;
    if (!window.MythosWebData) { wireStaticPricingToggle(); return; }
    Promise.all([MythosWebData.getPlans(), MythosWebData.getAddOns()]).then(function (res) {
      _plans = res[0];
      // Excluir add-ons pendientes (Bancard / Facturación electrónica) del render.
      _addons = (res[1] || []).filter(function (a) { return PENDING_ADDONS.indexOf(a.slug) === -1; });
      try {
        if (hasPlans) { renderPlans(); updateSaveNote(); wireDynamicToggle(); }
        if (hasCalc) buildCalculator();
        track('pricing_view', {});
      } catch (e) { console.warn('[MythosWeb] pricing render', e); wireStaticPricingToggle(); }
    }).catch(function (e) { console.warn('[MythosWeb] pricing load', e); wireStaticPricingToggle(); });
  }

  /* ── FAQ dinámico (web.html #faqList) — degrada al HTML estático ──────── */
  function renderFaqs() {
    var host = document.getElementById('faqList');
    if (!host || !window.MythosWebData || !MythosWebData.getFaqs) return;
    MythosWebData.getFaqs().then(function (rows) {
      if (!rows || !rows.length) return;   // sin datos → se mantiene el HTML estático (fallback)
      host.innerHTML = rows.map(function (f, i) {
        return '<details' + (i === 0 ? ' open' : '') + '><summary>' + esc(f.question) + '</summary><p>' + esc(f.answer) + '</p></details>';
      }).join('');
    }).catch(function () {});
  }

  // Formatea un WhatsApp (dígitos) para MOSTRARLO: "595987436592" → "+595 987 436592".
  // El enlace wa.me usa waNumber() (solo dígitos); esto es solo presentación.
  function fmtWhatsapp(v) {
    var d = String(v == null ? '' : v).replace(/\D/g, '');
    if (!d) return '';
    return (d.length > 6) ? ('+' + d.slice(0, 3) + ' ' + d.slice(3, 6) + ' ' + d.slice(6)) : ('+' + d);
  }

  /* ── Rellena spans/atributos [data-cfg="key"] desde marketing_config.
     Un campo VACÍO nunca muestra "—": si su bloque se marcó [data-cfg-optional]
     se oculta; si no, se deja el texto de respaldo del propio HTML (así no
     aparece "RUC —" ni datos rotos). El WhatsApp se muestra formateado.
     Usado por las páginas legales y el pie. ───────────────────────────────── */
  function fillCfgSpans() {
    var cfg = _config || {};
    document.querySelectorAll('[data-cfg]').forEach(function (el) {
      var key = el.getAttribute('data-cfg');
      var val = cfg[key];
      var has = !(val == null || String(val).trim() === '');
      var wrap = el.closest('[data-cfg-optional]');
      if (has) {
        el.textContent = (key === 'whatsapp') ? fmtWhatsapp(val) : String(val).trim();
        if (wrap) wrap.style.display = '';
        return;
      }
      if (wrap) wrap.style.display = 'none';   // vacío + opcional → ocultar (nada de "—")
      // vacío sin wrapper → se respeta el texto de respaldo ya presente en el HTML
    });
  }

  /* ── Pinta redes + contacto del footer desde la config (oculta vacías) ── */
  function updateFooterDynamic() {
    var cfg = _config || {};
    var host = document.getElementById('footSocial');
    if (host) {
      host.innerHTML =
        socialLink(cfg.instagram_url, 'instagram', 'Instagram') +
        socialLink(cfg.facebook_url, 'facebook', 'Facebook') +
        socialLink(cfg.tiktok_url, 'tiktok', 'TikTok');
    }
    // WhatsApp del footer: solo se muestra si hay número real configurado.
    var wa = document.getElementById('footWa');
    if (wa) {
      var num = String(CONFIG.whatsapp || '').replace(/\D/g, '');
      wa.style.display = (num && num !== '595000000000') ? '' : 'none';
    }
  }

  /* ── Completa/actualiza los meta Open Graph desde la config ───────────── */
  function updateOG() {
    var cfg = _config || {};
    var domain = String(cfg.website_domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!domain) return;
    var base = 'https://' + domain;
    function setMeta(prop, content) {
      if (!content) return;
      var m = document.querySelector('meta[property="' + prop + '"]');
      if (!m) { m = document.createElement('meta'); m.setAttribute('property', prop); document.head.appendChild(m); }
      m.setAttribute('content', content);
    }
    var path = (location && location.pathname) || '/';
    setMeta('og:url', base + (path === '/' ? '/inicio' : path));
    if (cfg.legal_name) setMeta('og:site_name', String(cfg.legal_name));
  }

  /* ── Carga de datos públicos (config) + WhatsApp/founder dinámicos ─────── */
  function loadDynamic() {
    if (window.MythosWebData && MythosWebData.getPublicConfig) {
      MythosWebData.getPublicConfig().then(function (cfg) {
        _config = cfg || {};
        // WhatsApp unificado: la clave `whatsapp` es la fuente única; `sales_whatsapp`
        // queda como respaldo por compatibilidad con configs viejas.
        var wa = _config.whatsapp || _config.sales_whatsapp;
        if (wa) CONFIG.whatsapp = String(wa);
        if (_config.contact_email) CONFIG.email = String(_config.contact_email);
        if (_config.founder_offer_limit != null) CONFIG.founderLimit = _config.founder_offer_limit;
        fillCfgSpans();       // páginas legales + pie (razón social, RUC, etc.)
        wireContactLinks();   // re-aplica el número/email de DB a los enlaces ya pintados
        updateFooterDynamic();
        updateOG();
        updateFounder();
      }).catch(function () { updateFounder(); });
    } else {
      updateFounder();
    }
    initPricing();
    renderFaqs();
  }

  /* ═══════════════════════════════════════════════════════════════════════
     LEADS (WEB-5) — formularios públicos → marketing_leads (anon INSERT-only)
     ─────────────────────────────────────────────────────────────────────
     Sin Auth, sin service_role, sin crear cuentas. Solo escribe `marketing_leads`
     vía MythosWebData.submitLead (anon key + RLS). Nunca lee leads. Degrada con
     gracia si no hay capa de datos (muestra fallback a WhatsApp, no rompe).
     ═══════════════════════════════════════════════════════════════════════ */
  function leadEventName(type) {
    return ({ contact: 'contact_submit', demo: 'demo_request_submit', trial_interest: 'trial_interest_submit' })[type] || 'contact_submit';
  }
  function emailValid(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

  // form: <form> con inputs name="name|business_name|email|whatsapp|message|type",
  //       un [data-lead-status] y un [data-lead-submit].
  // opts: { fixedType, successMsg (string|fn(type)), extra (fn→obj a fusionar) }
  function wireLeadForm(form, opts) {
    opts = opts || {};
    if (!form || form.__leadWired) return; form.__leadWired = true;
    var statusEl = form.querySelector('[data-lead-status]');
    var submitBtn = form.querySelector('[data-lead-submit]');

    function field(n) { var el = form.querySelector('[name="' + n + '"]'); return el ? String(el.value == null ? '' : el.value).trim() : ''; }
    function setStatus(msg, kind) {
      if (!statusEl) return;
      statusEl.textContent = msg || '';
      statusEl.className = 'lead-status' + (kind ? ' lead-status--' + kind : '');
      statusEl.style.display = msg ? '' : 'none';
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var type = opts.fixedType || field('type') || 'contact';
      var name = field('name'), business = field('business_name'),
          email = field('email'), wsp = field('whatsapp'), msg = field('message');

      // Validaciones (mensajes claros en español; sin tecnicismos).
      if (!name) { setStatus('Decinos tu nombre, por favor.', 'error'); return; }
      if (email && !emailValid(email)) { setStatus('Ese email no parece válido. Revisalo, por favor.', 'error'); return; }
      if (!email && !wsp) { setStatus('Dejanos al menos un WhatsApp o un email para responderte.', 'error'); return; }
      if (type === 'contact' && !msg) { setStatus('Contanos brevemente en qué te ayudamos.', 'error'); return; }

      var prev = submitBtn ? submitBtn.textContent : '';
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Enviando…'; }
      setStatus('', '');

      var payload = {
        type: type, name: name, business_name: business, email: email,
        whatsapp: wsp, message: msg, source: (location && location.pathname) || null
      };
      if (typeof opts.extra === 'function') { try { Object.assign(payload, opts.extra() || {}); } catch (x) {} }

      function finish(res) {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = prev; }
        if (res && res.ok) {
          track(leadEventName(type), { type: type, plan_slug: payload.plan_slug || null });
          var sm = (typeof opts.successMsg === 'function') ? opts.successMsg(type) : opts.successMsg;
          var box = document.createElement('div');
          box.className = 'notice lead-success';
          box.setAttribute('role', 'status');
          box.innerHTML = '<span class="lead-ok" aria-hidden="true">✓</span> <span>' + esc(sm || '¡Listo! Recibimos tus datos y te contactamos pronto.') + '</span>';
          if (form.parentNode) form.parentNode.insertBefore(box, form);
          try { form.reset(); } catch (x) {}
          form.style.display = 'none';
        } else {
          track('lead_submit_error', { type: type, error: (res && res.error) || 'unknown' });
          setStatus('No pudimos enviar tus datos ahora. Probá de nuevo o escribinos por WhatsApp.', 'error');
        }
      }

      if (window.MythosWebData && MythosWebData.submitLead) {
        MythosWebData.submitLead(payload).then(finish).catch(function (err) { finish({ ok: false, error: String(err) }); });
      } else {
        finish({ ok: false, error: 'no-data-layer' });
      }
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

  /* ── Navegación in-page (anclas: #demo, #modulos, #faq …) ─────────────────
     El header sticky se INYECTA en #site-header durante init(), así que el
     scroll-a-hash nativo (en carga o al clickear) falla: corre antes de que el
     header ocupe layout, o el navegador no re-scrollea same-page. Lo hacemos a
     mano con scrollIntoView (respeta scroll-margin-top del target). */
  function samePagePath(path) {
    if (!path) return true; // href="#demo" → misma página
    var norm = function (p) { return (p || '').replace(/\/+$/, '') || '/'; };
    return norm(path) === norm(location.pathname); // tolera trailing slash
  }
  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  // Evita que el contenido con scroll-reveal quede atascado en opacity:0 cuando
  // llegamos por scroll programático (el IntersectionObserver podría no disparar
  // a tiempo). Si el target es .reveal, lo revela; si es un ancla de altura 0
  // (p.ej. #demo / .demo-anchor), revela su primer hermano .reveal (#demoDevice).
  function revealNow(el) {
    if (!el) return;
    if (el.classList && el.classList.contains('reveal')) { el.classList.add('in'); return; }
    var sib = el.nextElementSibling, n = 0;
    while (sib && n < 3) {
      if (sib.classList && sib.classList.contains('reveal')) { sib.classList.add('in'); break; }
      sib = sib.nextElementSibling; n++;
    }
  }
  function scrollToEl(el, smooth) {
    if (!el) return;
    revealNow(el); // revelar ANTES del scroll (transform/opacity no alteran el layout)
    el.scrollIntoView({ behavior: (smooth && !prefersReducedMotion()) ? 'smooth' : 'auto', block: 'start' });
  }
  function wireInPageNav() {
    if (document.__mwInPageNav) return; document.__mwInPageNav = true;
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || (e.button && e.button !== 0) || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = (e.target && e.target.closest) ? e.target.closest('a[href]') : null;
      if (!a) return;
      var href = a.getAttribute('href') || '';
      var i = href.indexOf('#');
      if (i < 0) return;                          // sin hash → navegación normal
      var id = href.slice(i + 1);
      if (!id) return;
      if (!samePagePath(href.slice(0, i))) return; // otra página → navegación normal
      var el = document.getElementById(id);
      if (!el) return;
      e.preventDefault();
      scrollToEl(el, true);                        // smooth (auto si prefers-reduced-motion)
      try { history.pushState(null, '', '#' + id); } catch (x) { location.hash = id; }
    });
  }
  function wireInitialHashScroll() {
    var id = (location.hash || '').replace(/^#/, '');
    if (!id || !document.getElementById(id)) return;
    var userMoved = false;
    ['wheel', 'touchstart', 'keydown', 'pointerdown'].forEach(function (ev) {
      window.addEventListener(ev, function () { userMoved = true; }, { passive: true, once: true });
    });
    var go = function () {
      if (userMoved) return;
      scrollToEl(document.getElementById(id), false); // instantáneo al cargar
    };
    // Tras montar el chrome (header sticky) + asentar layout; reintento en load por íconos/fuentes.
    requestAnimationFrame(function () { requestAnimationFrame(go); });
    window.addEventListener('load', function () { setTimeout(go, 40); });
  }

  function init(opts) {
    renderChrome(opts);
    hydrateIcons();
    wireContactLinks();   // inmediato (placeholder) — luego se re-aplica con DB
    wireTracking();
    wireReveal();
    wireInPageNav();          // anclas same-page (incluye el menú "Demo" → #demo)
    wireInitialHashScroll();  // entrar directo a /inicio#demo cae en el demo
    loadDynamic();
  }

  window.MythosWeb = {
    init: init,
    renderChrome: renderChrome,
    waLink: waLink,
    formatGs: formatGs,
    formatMiles: formatMiles,
    track: track,
    wireLeadForm: wireLeadForm,
    config: CONFIG
  };
})();
