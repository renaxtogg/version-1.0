/* ═══════════════════════════════════════════════════════════════════════
   MYTHOS — SITIO WEB COMERCIAL · capa de datos (WEB-3)
   ─────────────────────────────────────────────────────────────────────
   Lectura del sitio público contra las tablas `marketing_*` (migración 110),
   con FALLBACK estático seguro. Expuesto como `window.MythosWebData`.

   • Usa la anon key (igual que los paneles). RLS (mig 110) garantiza que anon
     solo lee filas activas de catálogos / config is_public=true, y que los
     INSERT de events/leads no son legibles por anon.
   • Si no hay window.supabase (UMD) o window.SUPABASE_CONFIG con credenciales,
     TODO degrada con gracia: getPlans/getAddOns devuelven el fallback estático,
     getPublicConfig los defaults, y trackEvent/submitLead resuelven sin romper.
   • Los INSERT NO encadenan .select() (return=minimal): anon no tiene SELECT
     en events/leads (mismo patrón que reservations en mig 103 §12).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── Fallback estático (precios ALINEADOS a subscription_plans, fuente única;
  //    mig 119 los sincroniza en BD — acá se replica para modo offline) ──────
  // Nombres/descripciones/plan_config ALINEADOS a la fuente única (mig 152/153).
  // `plan_config` (panels/features/límites) es lo que alimenta la lista "incluye"
  // auto-generada del sitio; acá se replica para el modo offline/fallback.
  var FALLBACK_PLANS = [
    { slug: 'carta', name: 'Emprendedor', headline: 'Tu carta, en digital',
      description: 'Tu carta, en digital. Da el primer paso: menú digital con QR, sin papel y actualizable al instante, más el panel de gestión para cargar tu carta, ver pedidos y controlar tus insumos.',
      price_monthly_gs: 150000, price_annual_gs: 1500000, currency: 'PYG',
      plan_config: { panels: [], features: ['admin:inventory'], max_tables: 5, max_menu_items: 30, max_users: {} },
      features: ['Carta digital con QR', 'Gestión (Admin)', 'Control de Insumos', '5 mesas', '30 ítems'],
      badge: null, is_recommended: false, is_enterprise: false },
    { slug: 'servicio', name: 'Consolidado', headline: 'Operá todo tu salón',
      description: 'Operá todo tu salón. Todo lo de Emprendedor más el sistema completo en tiempo real: caja, mozos y pantalla de cocina conectados, y CRM para conocer a tus clientes.',
      price_monthly_gs: 300000, price_annual_gs: 3000000, currency: 'PYG',
      plan_config: { panels: ['caja', 'mozo', 'cocina'], features: ['admin:inventory', 'admin:crm'], max_tables: null, max_menu_items: null, max_users: {} },
      features: ['Carta digital con QR', 'Gestión (Admin)', 'Caja', 'Mozo', 'Cocina (KDS)', 'Control de Insumos', 'CRM', 'Mesas ilimitadas', 'Ítems ilimitados'],
      badge: 'Recomendado', is_recommended: true, is_enterprise: false },
    { slug: 'full', name: 'Premium', headline: 'Sumá delivery y escalá',
      description: 'Sumá delivery y escalá. Todo lo de Consolidado más delivery completo (pedido a domicilio con seguimiento en mapa y panel del repartidor), zonas de reparto y supervisión con el panel de Gerente.',
      price_monthly_gs: 500000, price_annual_gs: 5000000, currency: 'PYG',
      plan_config: { panels: ['caja', 'mozo', 'cocina', 'delivery-cliente', 'delivery-rider', 'gerente'], features: ['admin:inventory', 'admin:crm', 'admin:delivery_zones'], max_tables: null, max_menu_items: null, max_users: {} },
      features: ['Carta digital con QR', 'Gestión (Admin)', 'Caja', 'Mozo', 'Cocina (KDS)', 'Delivery Cliente', 'Rider', 'Gerente', 'Control de Insumos', 'CRM', 'Mapas/Zonas', 'Mesas ilimitadas', 'Ítems ilimitados'],
      badge: null, is_recommended: false, is_enterprise: false },
    // Plan "a cotizar" (para la calculadora). En la grilla de precios se sustituye
    // por la tarjeta estática "A cotizar / A medida" (web-marketing.js).
    { slug: 'enterprise', name: 'A medida', headline: 'Cadenas y multi-local',
      description: '', price_monthly_gs: null, price_annual_gs: null, currency: 'PYG',
      plan_config: null,
      features: ['Todo lo de Premium', 'Multi-sucursal avanzado', 'Módulos a medida', 'Onboarding dedicado', 'SLA'],
      badge: null, is_recommended: false, is_enterprise: true }
  ];

  var FALLBACK_ADDONS = [
    { slug: 'bancard', name: 'Cobro online con Bancard', description: 'Pagos online locales integrados.', price_gs: 100000, price_type: 'cuota' },
    { slug: 'facturacion-electronica', name: 'Facturación electrónica', description: 'Comprobantes legales con tu RUC.', price_gs: 150000, price_type: 'cuota' },
    { slug: 'delivery', name: 'Delivery', description: 'Zonas, tarifas y tracking en vivo.', price_gs: 350000, price_type: 'cuota' },
    { slug: 'fidelizacion', name: 'Fidelización', description: 'Puntos y recompensas.', price_gs: 250000, price_type: 'cuota' },
    { slug: 'sucursal-adicional', name: 'Sucursal adicional', description: 'Cada sede extra, en un solo panel.', price_gs: 150000, price_type: 'cuota' }
  ];

  var DEFAULT_CONFIG = {
    trial_days: 14,
    founder_offer_active: true,
    founder_offer_limit: 10,
    sales_whatsapp: '595000000000',
    site_home_path: '/inicio',
    // Identidad del negocio (WEB-8, mig 148) — fuente única del sitio + legales.
    // Defaults presentables para modo offline/fallback; la DB (is_public) manda.
    legal_name: 'MYTHOS EAS',
    ruc: '',
    legal_address: 'Asunción, Paraguay',
    contact_email: 'hola@mythos.com.py',
    whatsapp: '',
    instagram_url: '',
    facebook_url: '',
    tiktok_url: '',
    website_domain: 'mythos-pos.vercel.app',
    legal_effective_date: '5 de julio de 2026'
  };

  // ── Cliente Supabase (lazy, anon key) ─────────────────────────────────
  var _client = null;
  var _tried = false;
  function db() {
    if (_tried) return _client;
    _tried = true;
    try {
      var cfg = window.SUPABASE_CONFIG;
      if (!window.supabase || !cfg || !cfg.url || !cfg.anonKey) return (_client = null);
      var url = String(cfg.url).replace(/^﻿/, '').trim();
      var key = String(cfg.anonKey).replace(/^﻿/, '').trim();
      if (!url || url.indexOf('YOUR_') !== -1 || !key) return (_client = null);
      _client = window.supabase.createClient(url, key, { auth: { persistSession: false } });
    } catch (e) { _client = null; }
    return _client;
  }

  function warn(msg, e) { try { console.warn('[MythosWebData] ' + msg, e || ''); } catch (x) {} }

  // Lee un catálogo (RLS filtra is_active). Devuelve array de filas o null si
  // no hay cliente / error / vacío (→ el caller usa fallback).
  function readOrdered(table) {
    var c = db();
    if (!c) return Promise.resolve(null);
    return c.from(table).select('*').order('sort_order', { ascending: true })
      .then(function (r) {
        if (r && r.error) { warn(table + ' query error → fallback', r.error.message); return null; }
        return (r && r.data && r.data.length) ? r.data : null;
      })
      .catch(function (e) { warn(table + ' fetch failed → fallback', e); return null; });
  }

  function normalizeFeatures(p) {
    var f = p.features;
    if (Array.isArray(f)) { /* ok */ }
    else if (typeof f === 'string') { try { p.features = JSON.parse(f); } catch (e) { p.features = []; } }
    else if (!f) p.features = [];
    // plan_config puede venir como jsonb (objeto) o string (según el driver): normalizar.
    if (typeof p.plan_config === 'string') {
      try { p.plan_config = JSON.parse(p.plan_config); } catch (e) { p.plan_config = null; }
    }
    return p;
  }

  // ── API pública ───────────────────────────────────────────────────────
  function getPlans() {
    return readOrdered('marketing_plans').then(function (rows) {
      return (rows ? rows.map(normalizeFeatures) : FALLBACK_PLANS.slice());
    });
  }

  function getAddOns() {
    return readOrdered('marketing_add_ons').then(function (rows) {
      return rows ? rows : FALLBACK_ADDONS.slice();
    });
  }

  // FAQs activas, ordenadas (RLS filtra is_active). null → el caller deja el HTML estático.
  function getFaqs() {
    var c = db();
    if (!c) return Promise.resolve(null);
    return c.from('marketing_faqs').select('question,answer').order('sort_order', { ascending: true })
      .then(function (r) {
        if (r && r.error) { warn('marketing_faqs error → estático', r.error.message); return null; }
        return (r && r.data && r.data.length) ? r.data : null;
      })
      .catch(function (e) { warn('marketing_faqs failed → estático', e); return null; });
  }

  // Config pública → objeto plano con defaults garantizados.
  function getPublicConfig() {
    var c = db();
    if (!c) return Promise.resolve(Object.assign({}, DEFAULT_CONFIG));
    return c.from('marketing_config').select('key,value').eq('is_public', true)
      .then(function (r) {
        var out = Object.assign({}, DEFAULT_CONFIG);
        if (r && r.error) { warn('marketing_config error → defaults', r.error.message); return out; }
        if (r && r.data) r.data.forEach(function (row) { out[row.key] = row.value; });
        return out;
      })
      .catch(function (e) { warn('marketing_config failed → defaults', e); return Object.assign({}, DEFAULT_CONFIG); });
  }

  // Registrar evento de actividad (anon INSERT-only; nunca bloquea ni lanza).
  function trackEvent(eventName, metadata) {
    try {
      var c = db();
      if (!c || !eventName) return Promise.resolve(false);
      metadata = metadata || {};
      var row = {
        event_name: String(eventName),
        page_path: (location && location.pathname) || null,
        plan_slug: metadata.plan_slug || null,
        metadata: metadata,
        session_id: sessionId()
      };
      return c.from('marketing_events').insert(row, { returning: 'minimal' })
        .then(function (r) { return !!(r && !r.error); })
        .catch(function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }

  // id de sesión efímero (solo para agrupar eventos; no es PII).
  function sessionId() {
    try {
      var k = 'mythos_web_sid';
      var v = sessionStorage.getItem(k);
      if (!v) { v = 's' + Math.floor(Date.now()).toString(36) + Math.floor(Math.random() * 1e6).toString(36); sessionStorage.setItem(k, v); }
      return v;
    } catch (e) { return null; }
  }

  // Crear un lead (WEB-5; anon INSERT-only, sin .select()).
  function submitLead(payload) {
    var c = db();
    if (!c || !payload) return Promise.resolve({ ok: false, error: 'no-client' });
    var row = {
      type: payload.type || 'contact',
      name: payload.name || null,
      business_name: payload.business_name || null,
      email: payload.email || null,
      whatsapp: payload.whatsapp || null,
      message: payload.message || null,
      plan_slug: payload.plan_slug || null,
      selected_addons: payload.selected_addons || [],
      source: payload.source || (location && location.pathname) || null,
      utm: payload.utm || {}
    };
    return c.from('marketing_leads').insert(row, { returning: 'minimal' })
      .then(function (r) { return { ok: !(r && r.error), error: r && r.error ? r.error.message : null }; })
      .catch(function (e) { return { ok: false, error: String(e) }; });
  }

  window.MythosWebData = {
    available: function () { return !!db(); },
    getPlans: getPlans,
    getAddOns: getAddOns,
    getFaqs: getFaqs,
    getPublicConfig: getPublicConfig,
    trackEvent: trackEvent,
    submitLead: submitLead,
    FALLBACK_PLANS: FALLBACK_PLANS,
    FALLBACK_ADDONS: FALLBACK_ADDONS,
    DEFAULT_CONFIG: DEFAULT_CONFIG
  };
})();
