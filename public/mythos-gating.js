/* ════════════════════════════════════════════════════════════
   mythos-gating.js — Omni-Gating por Feature (modularidad absoluta)
   ────────────────────────────────────────────────────────────
   Módulo global compartido por admin / caja / mozo. SIN bundler:
   se expone en window.MythosGating y se carga como <script> normal
   (antes de Babel) para que esté disponible al evaluar los paneles.

   Convención de keys: "panel:feature" (mismas strings que el plan).
   Gating fail-open: si el restaurante no tiene allowed_features
   configurado (plan legacy / RPC ausente) NO se bloquea nada.
   ════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // Catálogo de features → etiqueta comercial (usada en el mensaje de venta)
  var FEATURE_LABELS = {
    'admin:delivery_zones': 'Gestión de Mapas (Zonas Delivery)',
    'admin:inventory':      'Control de Insumos',
    'admin:crm':            'CRM de Clientes',
    'caja:sifen':           'Facturación Electrónica SIFEN',
    'caja:digital_payments':'Pasarelas Digitales Bancard',
    'mozo:digital_qr_pay':  'Cobro de Mesa con QR Digital'
  };

  // Catálogo de PANELES → etiqueta comercial. Un panel no incluido en el plan se
  // bloquea con el mismo paywall (mig 155: caps.allowed_panels es la lista efectiva).
  var PANEL_LABELS = {
    'caja':             'Panel de Caja',
    'cocina':           'Pantalla de Cocina (KDS)',
    'mozo':             'Panel de Mozos',
    'delivery-cliente': 'Delivery Cliente',
    'delivery-rider':   'Panel del Repartidor',
    'gerente':          'Panel de Gerente'
  };

  // WhatsApp de ventas Mythos — FUENTE ÚNICA: marketing_config.whatsapp (mig 148),
  // que también alimenta el sitio público. Se cachea con un fetch REST (lectura
  // anon de la config pública). Fallbacks: SUPABASE_CONFIG.salesWhatsapp (config
  // de deploy) y, por último, un número por defecto. Nunca bloquea el render.
  var _salesWa = null;
  (function fetchSalesWa() {
    try {
      var cfg = window.SUPABASE_CONFIG || {};
      var url = String(cfg.url || '').replace(/^﻿/, '').trim();
      var key = String(cfg.anonKey || '').replace(/^﻿/, '').trim();
      if (!url || !key || url.indexOf('YOUR_') !== -1) return;
      fetch(url + '/rest/v1/marketing_config?key=eq.whatsapp&select=value', {
        headers: { apikey: key, Authorization: 'Bearer ' + key }
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (rows) {
          if (rows && rows[0] && rows[0].value != null) {
            var v = String(rows[0].value).replace(/\D/g, '');
            if (v && v !== '595000000000') _salesWa = v;   // ignora el placeholder
          }
        })
        .catch(function () {});
    } catch (_) {}
  })();

  function salesWhatsapp() {
    return _salesWa
        || (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.salesWhatsapp)
        || '595981234567';
  }

  var _caps = null;          // capacidades cacheadas del restaurante
  var _loadingPromise = null;
  var _warnedFailOpen = {};  // de-dup: avisar fail-open 1 vez por key (evita spam por render)

  function featureLabel(key) {
    return FEATURE_LABELS[key] || key;
  }
  function panelLabel(key) {
    return PANEL_LABELS[key] || key;
  }

  function waUrl(key) {
    var msg = 'Hola Mythos, solicito cotización para activar el módulo extra de '
            + featureLabel(key) + ' en mi restaurante.';
    return 'https://wa.me/' + salesWhatsapp() + '?text=' + encodeURIComponent(msg);
  }
  function waUrlPanel(key) {
    var msg = 'Hola Mythos, solicito cotización para activar el '
            + panelLabel(key) + ' en mi restaurante.';
    return 'https://wa.me/' + salesWhatsapp() + '?text=' + encodeURIComponent(msg);
  }

  function hasFeatureWith(caps, key) {
    // Override explícito por restaurante (mig 146): el superadmin puede forzar
    // ON/OFF una feature independientemente del plan. Manda sobre allowed_features.
    var ov = caps && caps.overrides;
    if (ov && Object.prototype.hasOwnProperty.call(ov, 'feature:' + key)) {
      return ov['feature:' + key] === true;
    }
    var f = caps && caps.allowed_features;
    if (!Array.isArray(f)) {
      // Fail-open: plan legacy (allowed_features NULL) o capacidades aún no
      // cargadas → permitido, pero dejamos rastro (1 warn por key, sin spam).
      // Con la migración 116 los 3 planes traen array → esto NO debería
      // dispararse para un comercio con suscripción cargada.
      if (!_warnedFailOpen[key]) {
        _warnedFailOpen[key] = true;
        console.warn('[MythosGating] fail-open: "' + key + '" permitido sin allowed_features ' +
          '(plan legacy/NULL o capabilities no cargadas). Si persiste, revisá la suscripción del restaurante.');
      }
      return true;
    }
    return f.indexOf(key) >= 0;
  }

  function hasFeature(key) { return hasFeatureWith(_caps, key); }

  // Gating por PANEL. caps.allowed_panels (mig 155) es la lista EFECTIVA (base del
  // plan ∪ add-ons ∪ 'admin', con overrides ya aplicados y FAIL-CLOSED en la BD).
  // Acá: si es un array (capabilities cargadas) → membresía estricta (lista sin el
  // panel = BLOQUEADO). Si NO es array (aún cargando / RPC ausente / tenant) →
  // fail-open para no dejar afuera a un admin legítimo por un error transitorio.
  function hasPanelWith(caps, key) {
    var p = caps && caps.allowed_panels;
    if (!Array.isArray(p)) {
      if (!_warnedFailOpen['panel:' + key]) {
        _warnedFailOpen['panel:' + key] = true;
        console.warn('[MythosGating] fail-open: panel "' + key + '" permitido sin allowed_panels ' +
          '(capabilities no cargadas / RPC ausente). Con la mig 155 un comercio con suscripción trae array.');
      }
      return true;
    }
    return p.indexOf(key) >= 0;
  }
  function hasPanel(key) { return hasPanelWith(_caps, key); }
  function getCapabilities() { return _caps; }

  // Carga (una sola vez) las capacidades del restaurante. Falla abierto.
  function loadCapabilities(db, rid) {
    if (_loadingPromise) return _loadingPromise;
    if (!db || !rid) return Promise.resolve(_caps);
    _loadingPromise = db.rpc('get_restaurant_capabilities', { p_restaurant_id: rid })
      .then(function (res) {
        // Supabase no rechaza en error de RPC: viene en res.error. Si las
        // capacidades no cargan dejamos rastro en vez de fallar en silencio
        // (el gating queda fail-open: _caps sigue null → todo permitido).
        if (res && res.error) {
          console.error('[MythosGating] get_restaurant_capabilities falló → gating fail-open:', res.error);
        } else if (res && res.data) {
          _caps = res.data;
        } else {
          console.warn('[MythosGating] get_restaurant_capabilities devolvió NULL/sin data ' +
            '(restaurant ' + rid + ') → gating fail-open. Posible plan sin suscripción, rol anon o tenant cruzado.');
        }
        return _caps;
      })
      .catch(function (err) {
        console.error('[MythosGating] error al cargar capabilities → gating fail-open:', err);
        return _caps;
      });
    return _loadingPromise;
  }

  // Hook React: carga capacidades y re-renderiza al resolver.
  function useCapabilities(db, rid) {
    var st = React.useState(_caps);
    var caps = st[0], setCaps = st[1];
    React.useEffect(function () {
      var mounted = true;
      loadCapabilities(db, rid).then(function (c) { if (mounted) setCaps(c); });
      return function () { mounted = false; };
    }, []);
    return {
      caps: caps,
      loaded: !!caps,
      hasFeature: function (k) { return hasFeatureWith(caps, k); },
      hasPanel: function (k) { return hasPanelWith(caps, k); }
    };
  }

  /* ── Paywall / Upsell B&W (CSS puro, React.createElement) ──
     props:
       featureKey : key "panel:feature" (define etiqueta y mensaje)
       variant    : 'overlay' (modal flotante) | 'inline' (reemplaza contenido)
       onClose    : callback opcional (muestra la X y permite cerrar)        */
  function FeatureLock(props) {
    return _lockCard(featureLabel(props.featureKey), waUrl(props.featureKey), props.variant, props.onClose);
  }

  // Mismo paywall B&W para un PANEL no incluido en el plan (Caja, Cocina, …).
  function PanelLock(props) {
    return _lockCard(panelLabel(props.panelKey), waUrlPanel(props.panelKey), props.variant, props.onClose);
  }

  function _lockCard(label, waHref, variant, onClose) {
    var h = React.createElement;

    var lockSvg = h('svg', {
      width: 30, height: 30, viewBox: '0 0 24 24', fill: 'none',
      stroke: '#000', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round'
    },
      h('rect', { key: 'r', x: 4, y: 11, width: 16, height: 9, rx: 2 }),
      h('path', { key: 'p', d: 'M8 11V7a4 4 0 0 1 8 0v4' })
    );

    var btn = h('a', {
      href: waHref, target: '_blank', rel: 'noopener noreferrer',
      style: {
        display: 'inline-block', background: '#000', color: '#fff',
        padding: '12px 20px', borderRadius: 10, fontSize: 13.5, fontWeight: 700,
        textDecoration: 'none', border: '1px solid #000', cursor: 'pointer',
        letterSpacing: '0.2px', transition: 'opacity .15s'
      },
      onMouseEnter: function (e) { e.currentTarget.style.opacity = '0.82'; },
      onMouseLeave: function (e) { e.currentTarget.style.opacity = '1'; }
    }, 'Consultar Precio de este Módulo');

    var card = h('div', {
      style: {
        background: '#fff', border: '1px solid #111', borderRadius: 16,
        padding: '30px 26px', maxWidth: 380, width: '100%', textAlign: 'center',
        boxShadow: '0 12px 40px rgba(0,0,0,0.18)', fontFamily: 'inherit', boxSizing: 'border-box'
      }
    },
      h('div', {
        key: 'ic',
        style: {
          width: 62, height: 62, borderRadius: '50%', border: '1.5px solid #000',
          display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px'
        }
      }, lockSvg),
      h('div', { key: 'ti', style: { fontSize: 19, fontWeight: 800, color: '#000', marginBottom: 8, letterSpacing: '-0.3px' } },
        'Módulo Exclusivo Premium'),
      h('div', {
        key: 'bd',
        style: {
          display: 'inline-block', fontSize: 11, fontWeight: 700, color: '#000',
          border: '1px solid #000', borderRadius: 20, padding: '3px 11px', marginBottom: 14,
          textTransform: 'uppercase', letterSpacing: '0.5px'
        }
      }, label),
      h('div', { key: 'de', style: { fontSize: 13, lineHeight: 1.55, color: '#444', marginBottom: 22 } },
        'Esta funcionalidad no está activa en tu plan actual. Consulta el precio de este panel o módulo extra para integrarlo de inmediato a tu suscripción.'),
      btn
    );

    if (variant === 'inline') {
      return h('div', { style: { display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '48px 16px' } }, card);
    }

    // overlay (modal flotante; clic fuera o X cierra — no hay datos que perder)
    return h('div', {
      style: {
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 10000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
      },
      onClick: onClose || undefined
    },
      h('div', { style: { position: 'relative', maxWidth: 380, width: '100%' }, onClick: function (e) { e.stopPropagation(); } },
        onClose ? h('button', {
          onClick: onClose,
          style: {
            position: 'absolute', top: -12, right: -12, width: 30, height: 30, borderRadius: '50%',
            background: '#000', color: '#fff', border: '1px solid #fff', cursor: 'pointer',
            fontSize: 14, lineHeight: '1', zIndex: 1
          }
        }, '✕') : null,
        card
      )
    );
  }

  window.MythosGating = {
    FEATURE_LABELS: FEATURE_LABELS,
    PANEL_LABELS: PANEL_LABELS,
    featureLabel: featureLabel,
    panelLabel: panelLabel,
    waUrl: waUrl,
    waUrlPanel: waUrlPanel,
    hasFeature: hasFeature,
    hasFeatureWith: hasFeatureWith,
    hasPanel: hasPanel,
    hasPanelWith: hasPanelWith,
    getCapabilities: getCapabilities,
    loadCapabilities: loadCapabilities,
    useCapabilities: useCapabilities,
    FeatureLock: FeatureLock,
    PanelLock: PanelLock
  };
})();
