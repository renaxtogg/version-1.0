/* ═══════════════════════════════════════════════════════════════════════
   MYTHOS — SITIO WEB COMERCIAL · capa de datos (WEB-2, opcional)
   ─────────────────────────────────────────────────────────────────────
   Helper de LECTURA del sitio público contra las tablas `marketing_*`
   (migración 110). Expuesto como `window.MythosWebData`.

   ESTADO: preparado para WEB-3, **todavía NO cableado** a ninguna página
   (las páginas de WEB-1 siguen siendo estáticas). Es seguro incluirlo o no:
   si no hay `window.supabase` (UMD) o `window.SUPABASE_CONFIG`, todas las
   lecturas devuelven null/[] y las escrituras resuelven false SIN romper.

   Para activarlo en WEB-3, la página debe cargar antes:
     <script src="https://.../@supabase/supabase-js@2"></script>   (UMD)
     <script src="config.js"></script>                            (SUPABASE_CONFIG)
   y luego `await MythosWebData.getPlans()`, etc.

   Seguridad: usa la anon key (igual que los paneles). RLS (mig 110) garantiza
   que anon solo lee filas activas de los catálogos y que los INSERT de
   leads/events no son legibles por anon. Los INSERT NO encadenan .select()
   (return=minimal), igual que reservations en mig 103 §12.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

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

  // Lectura de un catálogo ordenado por sort_order (RLS filtra is_active).
  function readOrdered(table) {
    var c = db();
    if (!c) return Promise.resolve([]);
    return c.from(table).select('*').order('sort_order', { ascending: true })
      .then(function (r) { return (r && !r.error && r.data) ? r.data : []; })
      .catch(function () { return []; });
  }

  function getPlans()        { return readOrdered('marketing_plans'); }
  function getAddOns()       { return readOrdered('marketing_add_ons'); }
  function getSections()     { return readOrdered('marketing_site_sections'); }
  function getFaqs()         { return readOrdered('marketing_faqs'); }
  function getTestimonials() { return readOrdered('marketing_testimonials'); }

  // Config pública → objeto plano { key: value } (RLS filtra is_public=true).
  function getConfig() {
    var c = db();
    if (!c) return Promise.resolve({});
    return c.from('marketing_config').select('key,value')
      .then(function (r) {
        var out = {};
        if (r && !r.error && r.data) r.data.forEach(function (row) { out[row.key] = row.value; });
        return out;
      })
      .catch(function () { return {}; });
  }

  // Registrar un evento de actividad (anon INSERT-only; nunca bloquea la UI).
  function logEvent(eventName, meta) {
    var c = db();
    if (!c || !eventName) return Promise.resolve(false);
    var row = {
      event_name: String(eventName),
      page_path: (location && location.pathname) || null,
      plan_slug: (meta && meta.plan_slug) || null,
      metadata: (meta && meta.metadata) || {},
      session_id: (meta && meta.session_id) || null
    };
    return c.from('marketing_events').insert(row, { returning: 'minimal' })
      .then(function (r) { return !!(r && !r.error); })
      .catch(function () { return false; });
  }

  // Crear un lead desde el sitio (anon INSERT-only; sin .select()).
  function submitLead(payload) {
    var c = db();
    if (!c || !payload) return Promise.resolve({ ok: false, reason: 'no-client' });
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
      // status/internal_notes los maneja la BD/superadmin (RLS impide setearlos desde anon).
    };
    return c.from('marketing_leads').insert(row, { returning: 'minimal' })
      .then(function (r) { return { ok: !(r && r.error), error: r && r.error ? r.error.message : null }; })
      .catch(function (e) { return { ok: false, error: String(e) }; });
  }

  window.MythosWebData = {
    available: function () { return !!db(); },
    getPlans: getPlans,
    getAddOns: getAddOns,
    getSections: getSections,
    getFaqs: getFaqs,
    getTestimonials: getTestimonials,
    getConfig: getConfig,
    logEvent: logEvent,
    submitLead: submitLead
  };
})();
