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
    whatsapp: '595000000000',
    whatsappMsg: 'Hola, quiero probar MYTHOS para mi restaurante.',
    email: 'hola@mythos.com.py',
    loginUrl: '/login',
    founderLimit: 10
  };

  var _config = null;        // marketing_config público (cacheado)
  var _plans = null;         // planes (DB o fallback)
  var _addons = null;        // add-ons (DB o fallback)
  var _annual = false;       // estado del toggle mensual/anual
  var _calcStarted = false;  // para disparar pricing_calculator_start una vez

  /* ── Utilidades ───────────────────────────────────────────────────────── */
  function waLink(msg) {
    return 'https://wa.me/' + CONFIG.whatsapp + '?text=' + encodeURIComponent(msg || CONFIG.whatsappMsg);
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
    { id: 'modulos',  label: 'Módulos',  href: '/inicio#modulos' },
    { id: 'demo',     label: 'Demo',     href: '/demo' },
    { id: 'precios',  label: 'Precios',  href: '/precios' },
    { id: 'contacto', label: 'Contacto', href: '/contacto' }
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
            '</div>' +
            '<div><h5>Producto</h5><a href="/precios">Precios</a><a href="/inicio#modulos">Módulos</a><a href="/demo">Demo</a><a href="/registro">Probar gratis</a></div>' +
            '<div><h5>Empresa</h5><a href="/contacto">Contacto</a><a href="/inicio#faq">Preguntas frecuentes</a><a href="' + CONFIG.loginUrl + '" data-track="login_entry_click">Iniciar sesión</a></div>' +
            '<div><h5>Legal</h5><a href="/terminos">Términos</a><a href="/privacidad">Privacidad</a></div>' +
          '</div>' +
          '<div class="foot-bottom">' +
            '<span>© <span id="mktYear">2026</span> MYTHOS · Asunción, Paraguay</span>' +
            '<span class="t-item">' + icon('pin') + ' Hecho en Paraguay · Cobrá con Bancard</span>' +
          '</div>' +
        '</div>' +
      '</footer>';
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

  /* ── Enlaces de WhatsApp/email (idempotente; re-aplica el número actual) ─ */
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

  function planCardHTML(p) {
    var quote = planIsQuote(p);
    var priceInner;
    if (quote) priceInner = 'A cotizar';
    else if (_annual && p.price_annual_gs != null)
      priceInner = '<span class="gs">Gs</span>' + formatMiles(p.price_annual_gs) + '<small>/año</small>';
    else
      priceInner = '<span class="gs">Gs</span>' + formatMiles(p.price_monthly_gs) + '<small>/mes</small>';

    var save = (_annual && !quote && planSavings(p) > 0)
      ? '<div class="plan-save">Ahorrás ' + formatGs(planSavings(p)) + ' al año</div>' : '';
    var feats = (p.features || []).map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('');
    var cta = quote
      ? '<a class="btn btn-secondary" data-wa="' + esc('Hola, me interesa el plan ' + p.name + ' de MYTHOS para mi cadena.') + '" data-track="pricing_plan_click" data-plan="' + esc(p.slug) + '">Contactar ventas</a>'
      : '<a class="btn ' + (p.is_recommended ? 'btn-primary' : 'btn-secondary') + '" href="/registro?plan=' + encodeURIComponent(p.slug) + '" data-track="pricing_plan_click" data-plan="' + esc(p.slug) + '">Probar gratis</a>';

    return '<div class="plan' + (p.is_recommended ? ' feat' : '') + '">' +
      (p.badge ? '<div class="tag">' + esc(p.badge) + '</div>' : '') +
      '<h3>' + planTitle(p) + '</h3>' +
      '<div class="frase">' + esc(p.headline || '') + '</div>' +
      '<div class="price">' + priceInner + '</div>' + save +
      '<ul>' + feats + '</ul>' + cta + '</div>';
  }

  function renderPlans() {
    var grid = document.getElementById('plansGrid');
    if (!grid || !_plans) return;
    grid.innerHTML = _plans.map(planCardHTML).join('');
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
      _plans = res[0]; _addons = res[1];
      try {
        if (hasPlans) { renderPlans(); updateSaveNote(); wireDynamicToggle(); }
        if (hasCalc) buildCalculator();
        track('pricing_view', {});
      } catch (e) { console.warn('[MythosWeb] pricing render', e); wireStaticPricingToggle(); }
    }).catch(function (e) { console.warn('[MythosWeb] pricing load', e); wireStaticPricingToggle(); });
  }

  /* ── Carga de datos públicos (config) + WhatsApp/founder dinámicos ─────── */
  function loadDynamic() {
    if (window.MythosWebData && MythosWebData.getPublicConfig) {
      MythosWebData.getPublicConfig().then(function (cfg) {
        _config = cfg || {};
        if (_config.sales_whatsapp) CONFIG.whatsapp = String(_config.sales_whatsapp);
        if (_config.founder_offer_limit != null) CONFIG.founderLimit = _config.founder_offer_limit;
        wireContactLinks();   // re-aplica el número de DB a los enlaces ya pintados
        updateFounder();
      }).catch(function () { updateFounder(); });
    } else {
      updateFounder();
    }
    initPricing();
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
    wireContactLinks();   // inmediato (placeholder) — luego se re-aplica con DB
    wireTracking();
    wireReveal();
    loadDynamic();
  }

  window.MythosWeb = {
    init: init,
    renderChrome: renderChrome,
    waLink: waLink,
    formatGs: formatGs,
    formatMiles: formatMiles,
    track: track,
    config: CONFIG
  };
})();
