// ════════════════════════════════════════════════════════════════════
// PR-12 — Panel Cliente Delivery (delivery-cliente) precompilado con Vite.
// Migrado 1:1 desde el script JSX inline de public/delivery-cliente.html.
// Sin cambios de comportamiento de producto.
//   - React y ReactDOM ahora se importan de npm (bundleados por Vite).
//   - Supabase sigue como UMD CDN (window.supabase) — diferido.
//   - Globales del shell siguen en window.* (config.js, MythosTheme, etc.).
// ════════════════════════════════════════════════════════════════════
import React from 'react';
import { createRoot } from 'react-dom/client';
const { useState, useEffect, useRef, createContext, useContext, useCallback } = React;

/* ── SUPABASE CLIENT ─────────────────────── */
const _initDB = () => {
  const cfg = window.SUPABASE_CONFIG;
  if (!cfg || !cfg.url || !cfg.anonKey) return null;
  const url = cfg.url.replace(/^﻿/, '').trim();
  const key = cfg.anonKey.replace(/^﻿/, '').trim();
  if (!url || url.includes('YOUR_') || !key) return null;
  // Panel cliente PÚBLICO: nunca heredar la sesión de staff persistida en localStorage
  // del mismo navegador. Sin esto, el pedido corre como ese usuario autenticado y RLS lo
  // rechaza si el restaurant_id no coincide. Forzamos cliente anónimo.
  try {
    return window.supabase.createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: 'mythos-anon-delivery-cliente' }
    });
  } catch(e) { return null; }
};
const db = _initDB();

/* ── URL PARAMS ─────────────────────────── */
const _urlParams = new URLSearchParams(window.location.search);
const RESTAURANT_ID = (
  _urlParams.get('r') ||
  _urlParams.get('rest') ||
  (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.restaurantId) ||
  ''
).replace(/^﻿/, '').trim();
const CANAL = _urlParams.get('canal') || 'web';

/* ── INTEGRACIÓN GOOGLE MAPS ───────────────────────────────────────────────
   La API key se inyecta por build.sh → window.MYTHOS_CONFIG.googleMapsApiKey
   (env var GOOGLE_MAPS_API_KEY en Vercel). Con key presente, CoverageScreen
   muestra un mapa interactivo (pin arrastrable) para marcar la ubicación.
   Sin key (MAPS_READY=false) el flujo actual (GPS + selección manual) queda
   intacto: el mapa nunca se monta. */
const MAPS_API_KEY = (window.MYTHOS_CONFIG && window.MYTHOS_CONFIG.googleMapsApiKey || '').replace(/^﻿/, '').trim();
const MAPS_READY = !!MAPS_API_KEY;

/* ── THEME ENGINE ───────────────────────── */
const ThemeCtx      = createContext({});
const MenuCtx       = createContext(null);
const RestaurantCtx = createContext(null);

function makeTheme() {
  return {
    black: '#000000', ink: 'var(--text-primary)', dark: '#2D2D2D', mid: 'var(--text-secondary)',
    gray: 'var(--text-tertiary)', silver: '#BBB', border: '#E8E8E8', light: '#F0F0F0',
    offwhite: '#F8F8F8', white: '#FFF',
    hdrBg: '#FFF', hdrText: 'var(--text-primary)', hdrSub: 'var(--text-tertiary)',
    hdrInputBg: '#F5F5F5', hdrInputBorder: '#E2E2E2', hdrInputText: 'var(--text-primary)',
    trackBg: '#F8F8F8', trackText: 'var(--text-primary)', trackSub: 'var(--text-tertiary)',
    trackLine: 'rgba(0,0,0,0.5)', trackLineDim: 'rgba(0,0,0,0.08)',
    btnPrimary: '#000000', btnPrimaryText: '#FFF', phoneBg: '#F8F8F8',
    F: {
      h: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      hW: 800, heroSz: 28, titleSz: 22, priceSz: 17,
      lCase: 'uppercase', lSpacing: '0.14em', menuTitleSz: 20
    },
    K: { imgSz: 76, imgR: 10, pad: '14px 0', showImg: true }
  };
}

const fmt = (n) => '₲ ' + Number(n).toLocaleString('es-PY');

/* ── HAVERSINE ──────────────────────────── */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function calcDeliveryFee(userLat, userLng, zones, restLat, restLng) {
  const refLat = restLat || -25.2867;
  const refLng = restLng || -57.6470;
  const dist = haversineKm(userLat, userLng, refLat, refLng);
  const sorted = [...zones].sort((a, b) => (a.radius_km||999) - (b.radius_km||999));
  const match = sorted.find(z => z.is_active !== false && dist <= (z.radius_km || 999));
  return match ? { zone: match, price: match.price_guarani || 0, minutes: match.estimated_minutes || 30, distKm: dist } : null;
}

/* ── COTIZACIÓN GENERALIZADA (mig 124) ──────────────────────────────────────
   Generaliza el costo de envío a 4 modos elegibles por el dueño en
   delivery_settings. DEFENSIVO: si settings es null (tabla aún no aplicada),
   cae al modo 'zone' (calcDeliveryFee) sin romperse. */
function roundTo(n, step) {
  const s = Number(step) || 0;
  return s > 0 ? Math.round(n / s) * s : Math.round(n);
}
// ETA aproximado por distancia cuando el modo no trae tiempo de zona.
function estMinutesFromKm(km) {
  if (!Number.isFinite(km)) return 30;
  return Math.min(90, Math.max(15, Math.round(12 + km * 4)));
}
// Distancia de manejo (km) vía Google Distance Matrix. Resuelve a null si la API
// no está disponible o falla → el caller cae a la distancia en línea recta.
function routeDistanceKm(oLat, oLng, dLat, dLng) {
  return new Promise((resolve) => {
    try {
      const g = window.google;
      if (!(g && g.maps && g.maps.DistanceMatrixService)) { resolve(null); return; }
      const svc = new g.maps.DistanceMatrixService();
      svc.getDistanceMatrix({
        origins: [{ lat: oLat, lng: oLng }],
        destinations: [{ lat: dLat, lng: dLng }],
        travelMode: g.maps.TravelMode ? g.maps.TravelMode.DRIVING : 'DRIVING',
      }, (resp, status) => {
        try {
          const el = (status === 'OK') && resp && resp.rows && resp.rows[0] && resp.rows[0].elements && resp.rows[0].elements[0];
          if (el && el.status === 'OK' && el.distance && Number.isFinite(el.distance.value)) resolve(el.distance.value / 1000);
          else resolve(null);
        } catch (_) { resolve(null); }
      });
    } catch (_) { resolve(null); }
  });
}
// Devuelve { zone, price, minutes, distKm, mode, outOfCoverage } o null (sin cobertura).
async function quoteDelivery({ userLat, userLng, zones, settings, restLat, restLng }) {
  const mode = settings?.pricing_mode || 'zone';

  // Modo por zonas (default) — comportamiento actual intacto.
  if (mode === 'zone' || !settings) {
    return calcDeliveryFee(userLat, userLng, zones, restLat, restLng);
  }

  const hasOrigin = Number.isFinite(restLat) && Number.isFinite(restLng);

  // Tarifa fija — no depende de la distancia ni de la ubicación del local.
  if (mode === 'fixed') {
    const price = roundTo(Number(settings.base_fee) || 0, settings.round_to);
    const distKm = hasOrigin ? haversineKm(userLat, userLng, restLat, restLng) : NaN;
    return { zone: null, price, minutes: estMinutesFromKm(distKm), distKm: Number.isFinite(distKm) ? distKm : null, mode };
  }

  // Por km: requiere la ubicación real del local. Sin ella NO inventamos un origen
  // (evita cotizar desde un punto arbitrario) → fuera de cobertura, se ofrece retiro.
  if (!hasOrigin) {
    return { zone: null, price: 0, minutes: null, distKm: null, mode, outOfCoverage: true };
  }

  // 'radial_km' (línea recta) o 'route_km' (manejo, con fallback a recta).
  let distKm = haversineKm(userLat, userLng, restLat, restLng);
  if (mode === 'route_km') {
    const routeKm = await routeDistanceKm(restLat, restLng, userLat, userLng);
    if (Number.isFinite(routeKm)) distKm = routeKm;
    else console.warn('[delivery] route_km: Distance Matrix no disponible — usando distancia en línea recta.');
  }
  const maxKm = (settings.max_km == null || settings.max_km === '') ? null : Number(settings.max_km);
  if (maxKm != null && distKm > maxKm) {
    return { zone: null, price: 0, minutes: null, distKm, mode, outOfCoverage: true };
  }
  const base = Number(settings.base_fee) || 0;
  const perKm = Number(settings.price_per_km) || 0;
  const minFee = Number(settings.min_fee) || 0;
  const price = roundTo(Math.max(minFee, base + perKm * distKm), settings.round_to);
  return { zone: null, price, minutes: estMinutesFromKm(distKm), distKm, mode };
}

/* ── ZONE COLORS ────────────────────────── */
const ZONE_COLOR_MAP = {
  red:    { bg: '#FEF2F2', border: '#FECACA', dot: '#EF4444', text: '#B91C1C', label: 'Roja' },
  orange: { bg: '#FFF7ED', border: '#FED7AA', dot: '#F97316', text: '#C2410C', label: 'Naranja' },
  yellow: { bg: '#FEFCE8', border: '#FDE68A', dot: '#EAB308', text: '#A16207', label: 'Amarilla' },
  green:  { bg: '#F0FDF4', border: '#BBF7D0', dot: '#22C55E', text: '#15803D', label: 'Verde' }
};
function zoneColors(z) { return ZONE_COLOR_MAP[z?.color] || ZONE_COLOR_MAP.red; }

/* ── MENU ESTÁTICO ──────────────────────── */
/* Sin menú estático/demo: el menú SIEMPRE viene de la base de datos del
   restaurante real (resuelto por ?r= / config). Si está vacío, el panel
   muestra un estado "sin menú" en vez de improvisar platos ficticios. */

/* ── SUPABASE HELPERS ────────────────────── */
async function dbLoadRestaurant() {
  if (!db) return null;
  try {
    const { data, error } = await db.from('restaurants').select('id,name,address,phone,instagram,website,logo_initials,cover_style,timezone,is_active,created_at,updated_at,status,country,city,cover_image_url,logo_url,currency,maintenance_mode,maintenance_message,lat,lng,reservation_window_hours,reservation_alert_minutes,opening_hours,is_open,auto_provisioned,parent_company_id').eq('id', RESTAURANT_ID).maybeSingle();
    if (error || !data) return null;
    // Horario estructurado (mig 125) — best-effort: si la columna aún no existe,
    // se ignora y el cliente degrada a ABIERTO (no rompe la carga del restaurante).
    try {
      const bh = await db.from('restaurants').select('business_hours,open_override').eq('id', RESTAURANT_ID).maybeSingle();
      if (bh && !bh.error && bh.data) { data.business_hours = bh.data.business_hours; data.open_override = bh.data.open_override; }
    } catch (_) {}
    return data;
  } catch(e) { return null; }
}

async function dbLoadMenu() {
  if (!db) return null;
  try {
    const { data: cats } = await db.from('menu_categories').select('id,name,sort_order').eq('restaurant_id', RESTAURANT_ID).order('sort_order');
    const { data: items } = await db.from('menu_items').select('id,category_id,name,description,price_guarani,promo_tag,image_url,menu_item_extras(id,name,price_guarani)').eq('restaurant_id', RESTAURANT_ID).eq('is_available', true).order('sort_order');
    if (!cats || !items) return null;
    const menu = {};
    for (const cat of cats) {
      menu[cat.name] = items.filter(i => i.category_id === cat.id).map(i => ({
        id: i.id, name: i.name, desc: i.description, price: i.price_guarani,
        promo: i.promo_tag ? { tag: i.promo_tag } : null,
        extras: (i.menu_item_extras || []).map(e => ({ n: e.name, p: e.price_guarani })),
        image_url: i.image_url || null, category: cat.name
      }));
    }
    return Object.keys(menu).length > 0 ? menu : null;
  } catch(e) { return null; }
}

async function dbLoadDeliveryZones() {
  if (!db) return [];
  try {
    const { data } = await db.from('delivery_zones')
      .select('id,name,radius_km,price_guarani,estimated_minutes,is_active,color')
      .eq('restaurant_id', RESTAURANT_ID)
      .eq('is_active', true)
      .order('radius_km');
    return data || [];
  } catch(e) { return []; }
}

// Modo de cotización (mig 124). Feature-detect: si la tabla no existe todavía,
// devuelve null y el cliente cotiza por zonas como hasta ahora (sin romperse).
async function dbLoadDeliverySettings() {
  if (!db) return null;
  try {
    const { data, error } = await db.from('delivery_settings')
      .select('pricing_mode,base_fee,price_per_km,min_fee,max_km,free_over_amount,round_to')
      .eq('restaurant_id', RESTAURANT_ID)
      .maybeSingle();
    if (error) return null;
    return data || null;
  } catch (e) { return null; }
}

async function dbSubmitDeliveryOrder({ orderType, cartItems, subtotal, deliveryFee, total, payMethod, customerData, zone, estimatedMinutes, canal, cashAmount, requiresInvoice, custRuc, custEmail, invoiceDeliveryMethod }) {
  const orderNum = 'D-' + String(Math.floor(Date.now() % 90000) + 10000);
  if (!db) return { id: null, order_number: orderNum };
  if (!RESTAURANT_ID) throw new Error('No se identificó el restaurante. Abrí el link de delivery con ?r=<restaurante>.');

  // order_type='delivery' para domicilio real; 'llevar' para retiro en local
  const dbOrderType = orderType === 'delivery' ? 'delivery' : 'llevar';

  // ETAPA 2 (seguridad): crear el pedido (orders + items + extras + delivery_orders +
  // auto-asignación de rider) por la RPC SECURITY DEFINER 'create_order'. Único camino
  // tras el lockdown (ETAPA 3); si la RPC no existe aún (ETAPA 1 sin aplicar), caemos al
  // insert directo de abajo (compat).
  const isDeliv = (orderType === 'delivery' || orderType === 'pickup');
  const rpcPayload = {
    restaurant_id: RESTAURANT_ID, table_id: null, order_number: orderNum,
    order_type: dbOrderType, status: 'paid', subtotal, discount_amount: 0,
    total, payment_method: payMethod,
    customer_name: customerData.name || null, customer_ruc: custRuc || null, customer_email: custEmail || null,
    requires_invoice: requiresInvoice || false,
    invoice_delivery_method: requiresInvoice ? (invoiceDeliveryMethod || (custEmail ? 'email' : 'print')) : null,
    items: cartItems.map(ci => ({
      item_id: ci.item.id || null, item_name: ci.item.name, quantity: ci.qty,
      unit_price: ci.item.price, total_price: ci.total, observations: ci.notes || null,
      extras: (ci.extras || []).map(e => ({ extra_name: e.n, extra_price: e.p })),
    })),
    delivery: isDeliv ? {
      order_type: orderType, order_total: total,
      customer_name: customerData.name || null, customer_phone: customerData.phone || null,
      delivery_address:    orderType === 'delivery' ? (customerData.address || null) : null,
      delivery_detail:     orderType === 'delivery' ? (customerData.detail || null) : null,
      delivery_references: orderType === 'delivery' ? (customerData.references || null) : null,
      zone_id: zone?.id || null, zone_name: zone?.name || null,
      delivery_fee: deliveryFee || 0, estimated_minutes: zone?.estimated_minutes || estimatedMinutes || null,
      canal: canal || 'web', cash_amount: (payMethod === 'efectivo' && cashAmount > 0) ? cashAmount : null,
      delivery_corner: orderType === 'delivery' ? (customerData.corner || null) : null,
      delivery_lat: (orderType === 'delivery' && Number.isFinite(customerData.lat)) ? customerData.lat : null,
      delivery_lng: (orderType === 'delivery' && Number.isFinite(customerData.lng)) ? customerData.lng : null,
    } : null,
  };
  {
    const { data: rpcData, error: rpcErr } = await db.rpc('create_order', { payload: rpcPayload });
    if (!rpcErr && rpcData && rpcData.id) return rpcData;
    const missing = rpcErr && /PGRST202|could not find the function|42883/i.test(`${rpcErr.message || ''} ${rpcErr.code || ''}`);
    if (rpcErr && !missing) { console.error('create_order RPC error:', rpcErr); throw new Error(rpcErr.message || 'No se pudo crear el pedido'); }
    // missing → insert directo (compat pre-ETAPA 1).
  }

  const baseInsert = {
    restaurant_id: RESTAURANT_ID,
    table_id: null,
    order_number: orderNum,
    order_type: dbOrderType,
    status: 'paid',
    subtotal,
    discount_amount: 0,
    total,
    payment_method: payMethod,
    customer_name: customerData.name || null,
    customer_ruc: custRuc || null,
    customer_email: custEmail || null,
    requires_invoice: requiresInvoice || false,
  };
  const invoiceExtras = requiresInvoice ? {
    invoice_delivery_method: invoiceDeliveryMethod || (custEmail ? 'email' : 'print'),
    invoice_requested_at: new Date().toISOString(),
    invoice_status: 'pending',
  } : {};
  let { data: order, error: orderErr } = await db.from('orders').insert({ ...baseInsert, ...invoiceExtras }).select('id,order_number,status').single();
  if (orderErr) {
    const r = await db.from('orders').insert(baseInsert).select('id,order_number,status').single();
    order = r.data; orderErr = r.error;
  }
  if (orderErr || !order) throw new Error(orderErr?.message || 'No se pudo crear el pedido');

  for (const ci of cartItems) {
    const { data: oi } = await db.from('order_items').insert({
      order_id: order.id,
      item_id: ci.item.id || null,
      item_name: ci.item.name,
      quantity: ci.qty,
      unit_price: ci.item.price,
      total_price: ci.total,
      observations: ci.notes || null
    }).select('id').single(); // RETURNING solo 'id' (no *): habilita revocar el SELECT de precios a anon (mig 130). El cliente solo usa oi.id.
    if (oi && ci.extras?.length > 0) {
      await db.from('order_item_extras').insert(ci.extras.map(e => ({ order_item_id: oi.id, extra_name: e.n, extra_price: e.p })));
    }
  }

  // Registrar en delivery_orders ANTES de order_status_history para que cocina
  // ya tenga el row de delivery cuando recibe el evento realtime
  if (orderType === 'delivery' || orderType === 'pickup') {
    const baseDelivery = {
      order_id:           order.id,
      restaurant_id:      RESTAURANT_ID,
      order_type:         orderType,
      order_number:       orderNum,
      order_total:        total,
      customer_name:      customerData.name,
      customer_phone:     customerData.phone,
      delivery_address:   orderType === 'delivery' ? customerData.address : null,
      delivery_detail:    orderType === 'delivery' ? customerData.detail : null,
      delivery_references:orderType === 'delivery' ? customerData.references : null,
      zone_id:            zone?.id || null,
      zone_name:          zone?.name || null,
      delivery_fee:       deliveryFee || 0,
      estimated_minutes:  zone?.estimated_minutes || estimatedMinutes || null,
      canal:              canal || 'web',
      status:             'pending',
      cash_amount:        (payMethod === 'efectivo' && cashAmount > 0) ? cashAmount : null,
    };
    // Geolocalización (mig. 121): el pin del cliente es la fuente de verdad.
    // Columnas nuevas → si la migración aún no se aplicó en prod, el insert con
    // extras falla por columna inexistente y reintentamos sin ellas (fix-forward).
    const geoExtras = (orderType === 'delivery') ? {
      delivery_corner: customerData.corner || null,
      delivery_lat:    Number.isFinite(customerData.lat) ? customerData.lat : null,
      delivery_lng:    Number.isFinite(customerData.lng) ? customerData.lng : null,
    } : {};
    let { data: delRow, error: delErr } = await db.from('delivery_orders').insert({ ...baseDelivery, ...geoExtras }).select('id').single();
    // Reintentar SÓLO si el fallo es por columnas geo inexistentes (migración 121 sin aplicar).
    // Acotar a ese caso evita un 2º insert ante errores no relacionados (RLS/red) — que además
    // podría duplicar la fila si el 1º se grabó pero se perdió la respuesta. Esos se loguean tal cual.
    const geoColMissing = !!delErr && Object.keys(geoExtras).length > 0 &&
      /delivery_(lat|lng|corner)|column|schema cache|PGRST204|42703/i.test(`${delErr.message || ''} ${delErr.code || ''}`);
    if (geoColMissing) {
      const r = await db.from('delivery_orders').insert(baseDelivery).select('id').single();
      delRow = r.data; delErr = r.error;
      if (!delErr) console.warn('[delivery] columnas geo (delivery_lat/lng/corner) no disponibles aún — pedido creado sin coordenadas. Aplicar migración 121.');
    }
    if (delErr) {
      console.error('[delivery] delivery_orders insert error:', delErr.message, delErr);
    } else if (delRow?.id && orderType === 'delivery') {
      await dbAutoAssignRider(delRow.id);
    }
  }

  // order_status_history va AL FINAL para que cocina reciba el evento
  // después de que delivery_orders y el rider ya estén asignados
  await db.from('order_status_history').insert({ order_id: order.id, status: 'paid', changed_by: 'customer' });

  return order;
}

// ETAPA 2: estado del pedido por la RPC get_order_status (status + rider_status, sin
// columnas financieras). Fallback a reads directos si la RPC no existe (ETAPA 1 sin aplicar).
async function dbGetOrderStatus(orderNumber) {
  if (!db || !orderNumber) return null;
  try {
    const { data, error } = await db.rpc('get_order_status', { p_order_number: orderNumber, p_restaurant_id: RESTAURANT_ID });
    if (!error) { const row = Array.isArray(data) ? data[0] : data; return row || null; }
    const missing = /PGRST202|could not find the function|42883/i.test(`${error.message || ''} ${error.code || ''}`);
    if (!missing) return null;
  } catch(e) {}
  try {
    const { data: ord } = await db.from('orders').select('id,status,order_number').eq('order_number', orderNumber).maybeSingle();
    if (!ord) return null;
    let rider_status = null;
    try { const { data: d } = await db.from('delivery_orders').select('rider_status').eq('order_id', ord.id).maybeSingle(); rider_status = d?.rider_status || null; } catch(e) {}
    return { order_number: ord.order_number, status: ord.status, rider_status };
  } catch(e) { return null; }
}

async function dbAutoAssignRider(deliveryOrderId) {
  if (!db || !deliveryOrderId) return;
  try {
    const { data: riders, error: ridersErr } = await db.from('delivery_riders')
      .select('id,name')
      .eq('restaurant_id', RESTAURANT_ID)
      .eq('active', true)
      .neq('current_status', 'offline');
    if (ridersErr) { console.warn('[delivery] auto-assign (best-effort) no pudo buscar riders:', ridersErr.message); return; }
    if (!riders?.length) { console.warn('[delivery] auto-assign: no hay riders disponibles para', RESTAURANT_ID); return; }

    const riderIds = riders.map(r => r.id);
    const { data: lastAssignments } = await db.from('delivery_orders')
      .select('rider_id,assigned_at')
      .eq('restaurant_id', RESTAURANT_ID)
      .in('rider_id', riderIds)
      .not('assigned_at', 'is', null)
      .order('assigned_at', { ascending: false });

    const lastTs = {};
    for (const r of riders) lastTs[r.id] = 0;
    for (const a of (lastAssignments || [])) {
      if (!lastTs[a.rider_id]) lastTs[a.rider_id] = new Date(a.assigned_at).getTime();
    }

    const selected = [...riders].sort((a, b) => lastTs[a.id] - lastTs[b.id])[0];
    const { error: updErr } = await db.from('delivery_orders').update({
      rider_id:    selected.id,
      rider_name:  selected.name,
      rider_status:'confirmed',
      status:      'assigned',
      assigned_at: new Date().toISOString(),
    }).eq('id', deliveryOrderId);
    if (updErr) {
      // Best-effort: el pedido YA está creado. Si RLS no deja al cliente anónimo
      // asignar rider (permission denied), no es fatal: rider/caja/cocina lo toman.
      console.warn('[delivery] auto-assign no disponible (best-effort), el pedido queda sin rider asignado:', updErr.message);
    } else {
      console.info('[delivery] auto-assign: rider asignado OK →', selected.name, 'a orden', deliveryOrderId);
    }
  } catch(e) {
    console.warn('[delivery] auto-assign (best-effort) excepción, el pedido queda creado igual:', e?.message || e);
  }
}

async function dbSubmitRating(orderId, stars, comment) {
  if (!db) return;
  try { await db.from('ratings').insert({ restaurant_id: RESTAURANT_ID, order_id: orderId || null, table_id: null, stars, comment: comment || null }); } catch(e) {}
}

async function dbSaveReservation(res) {
  if (db) {
    try {
      const { error } = await db.from('reservations').insert({
        restaurant_id:    res.restaurant_id,
        confirm_num:      res.confirm_num,
        customer_name:    res.name,
        customer_phone:   res.phone,
        reservation_date: res.date,
        reservation_time: res.time,
        guests:           res.guests,
        table_id:         res.table_id || null,
        occasion:         res.occasion || null,
        notes:            res.notes || null,
        status:           'pending',
      });
      if (!error) return { ok: true };
    } catch(e) {}
  }
  try {
    const reservas = JSON.parse(localStorage.getItem('reservations') || '[]');
    reservas.push({ ...res, id: Date.now(), created_at: new Date().toISOString() });
    localStorage.setItem('reservations', JSON.stringify(reservas));
  } catch(e) {}
  return { ok: true };
}

async function dbLoadTables() {
  if (!db) return [];
  try {
    const { data } = await db.from('tables').select('id,number,capacity')
      .eq('restaurant_id', RESTAURANT_ID).order('number');
    return data || [];
  } catch(e) { return []; }
}

const OCCASIONS = [
  { id: 'birthday',    label: 'Cumpleaños' },
  { id: 'anniversary', label: 'Aniversario' },
  { id: 'business',    label: 'Reunión' },
  { id: 'celebration', label: 'Celebración' },
  { id: 'other',       label: 'Otro motivo' },
];

/* ── ICON ────────────────────────────────── */
const Icon = ({ name, size = 20, color = 'currentColor', sw = 1.5 }) => {
  const paths = {
    back:     <path d="M19 12H5M12 5l-7 7 7 7" />,
    search:   <><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></>,
    plus:     <path d="M12 5v14M5 12h14" />,
    minus:    <path d="M5 12h14" />,
    x:        <path d="M18 6L6 18M6 6l12 12" />,
    check:    <path d="M20 6L9 17l-5-5" />,
    clock:    <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
    map:      <><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" /><circle cx="12" cy="10" r="3" /></>,
    phone:    <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.12 1.18 2 2 0 012.11 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />,
    card:     <><rect x="1" y="4" width="22" height="16" rx="2" /><line x1="1" y1="10" x2="23" y2="10" /></>,
    utensils: <><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 002-2V2" /><path d="M7 2v20M21 15V2a5 5 0 00-5 5v6c0 1.1.9 2 2 2h3zm0 0v7" /></>,
    star:     <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />,
    tag:      <><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" /><line x1="7" y1="7" x2="7.01" y2="7" /></>,
    chevdown: <path d="M6 9l6 6 6-6" />,
    trash:    <><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" /></>,
    fire:     <path d="M12 2c0 0-4.8 5-4.8 9.5a4.8 4.8 0 009.6 0C16.8 7 12 2 12 2zm0 0c0 0 2.5 3 2.5 5.5a2.5 2.5 0 01-5 0C9.5 5 12 2 12 2z" />,
    award:    <><circle cx="12" cy="8" r="6" /><path d="M15.477 12.89L17 22l-5-3-5 3 1.523-9.11" /></>,
    moto:     <><path d="M5 17H3a2 2 0 01-2-2v-4l2-5h10l4 5h3a2 2 0 012 2v2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M13 7l2 5"/></>,
    walk:     <><circle cx="12" cy="4" r="2"/><path d="M12 6l-2 5 3 3-2 5M12 6l2 5-3 3 1.5 4.5M8 7h4M16 7h-2"/></>,
    location: <><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" /><circle cx="12" cy="10" r="3" /></>,
    img:      <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></>,
    shield:   <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
    home:     <><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></>,
    bag:      <><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" /><line x1="3" y1="6" x2="21" y2="6" /><path d="M16 10a4 4 0 01-8 0" /></>,
    calendar: <><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></>,
    alert:    <><path d="M10.29 3.86 1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>,
    building: <><rect x="4" y="2" width="16" height="20" rx="2" /><path d="M9 22v-4h6v4M8 6h.01M16 6h.01M8 10h.01M16 10h.01M8 14h.01M16 14h.01" /></>,
    link:     <><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" /></>,
    store:    <><path d="M3 9l1.5-6h15L21 9" /><path d="M3 9v11a2 2 0 002 2h14a2 2 0 002-2V9" /><path d="M3 9h18" /><path d="M9 22V12h6v10" /></>
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
};

/* ── TOAST ───────────────────────────────── */
function Toast({ msg, onHide }) {
  const T = useContext(ThemeCtx);
  useEffect(() => { const t = setTimeout(onHide, 2400); return () => clearTimeout(t); }, []);
  return (
    <div style={{ position: 'fixed', top: 60, left: '50%', transform: 'translateX(-50%)', background: T.ink, color: T.white, borderRadius: 9999, padding: '10px 20px', fontSize: 13, fontWeight: 600, zIndex: 9999, whiteSpace: 'nowrap', boxShadow: '0 8px 32px rgba(0,0,0,0.4)', animation: 'fadeIn 200ms' }}>
      {msg}
    </div>
  );
}

/* ── INPUT STYLE ─────────────────────────── */
const inputStyle = (T) => ({
  width: '100%', height: 50, border: `1.5px solid ${T.border}`, borderRadius: 12,
  padding: '0 14px', fontSize: 15, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
  color: T.ink, background: T.white, outline: 'none', transition: 'border-color 150ms'
});

/* ══ PANTALLA 1 — BIENVENIDA ════════════ */
/* ── ESTADO ABIERTO/CERRADO (horario estructurado + override manual) ─────────
   business_hours: { "0":[{start:"HH:MM",end:"HH:MM"}], … "6":[…] } (0=Dom…6=Sáb).
   open_override: 'auto' | 'open' | 'closed' (override del dueño; gana al horario).
   Defensivo: sin business_hours válido en 'auto' → ABIERTO (no bloquear ventas).
   Calcula la hora en la zona horaria del local (restaurants.timezone) vía Intl.
   ⚠ Mantener IDÉNTICO a src/index/main.jsx. */
const _DOW_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
function _hhmmToMin(s) { const p = String(s || '').split(':'); const h = parseInt(p[0], 10), m = parseInt(p[1], 10); return (isFinite(h) ? h : 0) * 60 + (isFinite(m) ? m : 0); }
function _nowInTz(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Asuncion', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
    const map = {}; parts.forEach(p => { map[p.type] = p.value; });
    const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    let h = parseInt(map.hour, 10); if (h === 24) h = 0;
    const dow = (map.weekday in wd) ? wd[map.weekday] : new Date().getDay();
    return { dow, min: (isFinite(h) ? h : 0) * 60 + (parseInt(map.minute, 10) || 0) };
  } catch (_) { const d = new Date(); return { dow: d.getDay(), min: d.getHours() * 60 + d.getMinutes() }; }
}
function _bhHasHours(bh) { try { return !!bh && typeof bh === 'object' && Object.keys(bh).some(k => Array.isArray(bh[k]) && bh[k].length > 0); } catch (_) { return false; } }
function _bhRanges(bh, d) { const r = bh && bh[String(d)]; return Array.isArray(r) ? r : []; }
function _openNow(bh, dow, min) {
  for (const r of _bhRanges(bh, dow)) {
    const s = _hhmmToMin(r.start), e = _hhmmToMin(r.end);
    if (e > s) { if (min >= s && min < e) return true; }
    else if (e < s) { if (min >= s) return true; }            // cruza medianoche → abierto hasta 24:00
  }
  const prev = (dow + 6) % 7;
  for (const r of _bhRanges(bh, prev)) {
    const s = _hhmmToMin(r.start), e = _hhmmToMin(r.end);
    if (e < s && min < e) return true;                         // cola del turno que cruzó medianoche
  }
  return false;
}
function _nextOpen(bh, dow, min) {
  for (let off = 0; off < 8; off++) {
    const d = (dow + off) % 7;
    const ranges = _bhRanges(bh, d).slice().sort((a, b) => _hhmmToMin(a.start) - _hhmmToMin(b.start));
    for (const r of ranges) {
      const s = _hhmmToMin(r.start);
      if (off === 0 && s <= min) continue;
      const lbl = off === 0 ? 'hoy' : off === 1 ? 'mañana' : _DOW_ES[d];
      return `${lbl} ${r.start}`;
    }
  }
  return null;
}
function restaurantOpenState(restaurant) {
  const ov = (restaurant && restaurant.open_override) || 'auto';
  const tz = (restaurant && restaurant.timezone) || 'America/Asuncion';
  const bh = restaurant && restaurant.business_hours;
  if (ov === 'open') return { open: true, manual: true, next: null };
  const { dow, min } = _nowInTz(tz);
  if (ov === 'closed') return { open: false, manual: true, next: _bhHasHours(bh) ? _nextOpen(bh, dow, min) : null };
  if (!_bhHasHours(bh)) return { open: true, noSchedule: true, next: null };   // defensivo: sin horario → abierto
  const open = _openNow(bh, dow, min);
  return { open, next: open ? null : _nextOpen(bh, dow, min) };
}
function openBadgeLabel(st) { return st.open ? 'Abierto ahora' : (st.next ? `Cerrado · Abre ${st.next}` : 'Cerrado'); }

function WelcomeScreen({ restaurant, onDelivery, onPickup, onReserva, onBrowse, openState }) {
  const T = useContext(ThemeCtx);
  const restName = restaurant?.name || 'Restaurante';
  const logoUrl  = restaurant?.logo_url || null;
  const initials = restaurant?.logo_initials || restName.slice(0,2).toUpperCase();
  const st = openState || restaurantOpenState(restaurant);
  const closed = !st.open;

  return (
    <div style={{ minHeight: '100%', background: T.white, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 24px 40px' }}>
      {/* Logo */}
      <div style={{ marginTop: 72, marginBottom: 20 }}>
        {logoUrl
          ? <img src={logoUrl} alt="Logo" style={{ width: 88, height: 88, borderRadius: '50%', objectFit: 'cover', border: `2px solid ${T.border}` }} />
          : <div style={{ width: 88, height: 88, borderRadius: '50%', background: T.black, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, fontWeight: 800, color: T.white }}>
              {initials}
            </div>
        }
      </div>

      <div style={{ fontSize: 22, fontWeight: 800, color: T.ink, textAlign: 'center', marginBottom: 10 }}>{restName}</div>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: closed ? 'rgba(220,38,38,0.10)' : 'rgba(22,163,74,0.10)', border: `1px solid ${closed ? 'rgba(220,38,38,0.30)' : 'rgba(22,163,74,0.30)'}`, borderRadius: 9999, padding: '5px 12px', marginBottom: 14 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: closed ? '#DC2626' : '#16A34A' }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: closed ? '#B91C1C' : '#15803D' }}>{openBadgeLabel(st)}</span>
      </div>
      <div style={{ fontSize: 14, color: T.gray, textAlign: 'center', marginBottom: 32, lineHeight: 1.6 }}>
        {closed ? 'Por ahora no estamos tomando pedidos. Podés ver el menú mientras tanto.' : '¿Cómo querés recibir tu pedido?'}
      </div>

      {/* Opciones */}
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Delivery */}
        <button onClick={closed ? undefined : onDelivery} disabled={closed} style={{ width: '100%', height: 80, background: T.black, color: T.white, border: 'none', borderRadius: 18, cursor: closed ? 'not-allowed' : 'pointer', opacity: closed ? 0.4 : 1, display: 'flex', alignItems: 'center', padding: '0 24px', gap: 18, textAlign: 'left', transition: 'opacity 150ms' }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="moto" size={22} color="#fff" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: '#fff', marginBottom: 2 }}>Delivery a domicilio</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>Te lo llevamos donde estés</div>
          </div>
          <Icon name="chevdown" size={18} color="rgba(255,255,255,0.4)" sw={2} />
        </button>

        {/* Pickup */}
        <button onClick={closed ? undefined : onPickup} disabled={closed} style={{ width: '100%', height: 80, background: T.white, color: T.ink, border: `2px solid ${T.border}`, borderRadius: 18, cursor: closed ? 'not-allowed' : 'pointer', opacity: closed ? 0.4 : 1, display: 'flex', alignItems: 'center', padding: '0 24px', gap: 18, textAlign: 'left', transition: 'border-color 150ms' }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: T.light, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="bag" size={22} color={T.ink} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: T.ink, marginBottom: 2 }}>Paso a buscar</div>
            <div style={{ fontSize: 12, color: T.gray }}>Retirá cuando esté listo</div>
          </div>
          <Icon name="chevdown" size={18} color={T.silver} sw={2} />
        </button>

        {/* Reserva */}
        <button onClick={onReserva} style={{ width: '100%', height: 80, background: T.white, color: T.ink, border: `2px solid ${T.border}`, borderRadius: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', padding: '0 24px', gap: 18, textAlign: 'left', transition: 'border-color 150ms' }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: T.light, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="calendar" size={22} color={T.ink} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: T.ink, marginBottom: 2 }}>Reservar mesa</div>
            <div style={{ fontSize: 12, color: T.gray }}>Elegí día, hora y personas</div>
          </div>
          <Icon name="chevdown" size={18} color={T.silver} sw={2} />
        </button>

        {/* Ver el menú (solo lectura) — acceso al menú SOLO con el local cerrado.
            Abierto, el menú se entra por Delivery/Pickup (que capturan datos del cliente). */}
        {closed && onBrowse && (
          <button onClick={onBrowse} style={{ width: '100%', height: 52, background: 'transparent', color: T.ink, border: `1.5px solid ${T.border}`, borderRadius: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 14, fontWeight: 700, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>
            <Icon name="bag" size={16} color={T.ink} />Ver el menú
          </button>
        )}
      </div>

      {/* Powered */}
      <div style={{ marginTop: 'auto', paddingTop: 48, fontSize: 11, color: T.silver, letterSpacing: '0.08em' }}>
        Powered by Mythos
      </div>
    </div>
  );
}

/* ── GOOGLE MAPS — loader singleton + picker ───────────────────────────────
   Carga la JS API una sola vez (libraries=places para futuras mejoras de
   autocomplete). Defensivo: si la key falla / no hay billing / sin red, el
   MapPicker no renderiza y el flujo manual de abajo sigue disponible. */
let _gmapsPromise = null;
function loadGoogleMaps(key) {
  if (!key) return Promise.reject(new Error('sin key'));
  if (window.google && window.google.maps) return Promise.resolve(window.google.maps);
  if (_gmapsPromise) return _gmapsPromise;
  _gmapsPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&libraries=places&loading=async';
    s.async = true; s.defer = true;
    s.onload = () => (window.google && window.google.maps) ? resolve(window.google.maps) : reject(new Error('maps no cargó'));
    s.onerror = () => reject(new Error('error de script maps'));
    document.head.appendChild(s);
  });
  return _gmapsPromise;
}

function MapPicker({ center, onPick, T }) {
  const ref = useRef(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps(MAPS_API_KEY).then((maps) => {
      if (cancelled || !ref.current) return;
      const c = { lat: (center && center.lat) || -25.2867, lng: (center && center.lng) || -57.6470 };
      const map = new maps.Map(ref.current, { center: c, zoom: 15, disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy' });
      const marker = new maps.Marker({ position: c, map, draggable: true });
      const emit = () => { const p = marker.getPosition(); if (p) onPick(p.lat(), p.lng()); };
      marker.addListener('dragend', emit);
      map.addListener('click', (e) => { marker.setPosition(e.latLng); emit(); });
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);
  // Fallback silencioso: si el mapa no carga, se oculta y queda el flujo manual.
  if (failed) return null;
  return <div ref={ref} style={{ width: '100%', height: 220, borderRadius: 14, overflow: 'hidden', border: `1px solid ${T.border}`, marginBottom: 8 }} />;
}

/* ── REVERSE GEOCODING ───────────────────────────────────────────────────────
   lat/lng → dirección legible (calle + número) vía google.maps.Geocoder.
   Autocontenido y defensivo: si Maps no carga / la API está deshabilitada /
   sin red, resuelve null y el campo de dirección queda como texto manual. */
async function reverseGeocode(lat, lng) {
  if (!MAPS_API_KEY || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  try {
    const maps = await loadGoogleMaps(MAPS_API_KEY);
    return await new Promise((resolve) => {
      try {
        new maps.Geocoder().geocode({ location: { lat, lng }, language: 'es' }, (results, status) => {
          resolve((status === 'OK' && results && results[0]) ? results[0].formatted_address : null);
        });
      } catch (e) { resolve(null); }
    });
  } catch (e) { return null; }
}

/* ── MAP PICKER (captura de ubicación) ───────────────────────────────────────
   Mapa con pin ARRASTRABLE para la pantalla de dirección. A diferencia de
   MapPicker (cobertura), expone un handle imperativo (controlRef.moveTo) para
   reposicionar el pin desde GPS / Places Autocomplete sin re-montar el mapa.
   El pin es la fuente de verdad de la coordenada: drag/click → onPick(lat,lng). */
function DeliveryMapPicker({ initial, onPick, controlRef, T }) {
  const ref = useRef(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps(MAPS_API_KEY).then((maps) => {
      if (cancelled || !ref.current) return;
      const c = {
        lat: (initial && Number.isFinite(initial.lat)) ? initial.lat : -25.2867,
        lng: (initial && Number.isFinite(initial.lng)) ? initial.lng : -57.6470,
      };
      const map = new maps.Map(ref.current, { center: c, zoom: 16, disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy' });
      const marker = new maps.Marker({ position: c, map, draggable: true });
      const emit = () => { const p = marker.getPosition(); if (p) onPick(p.lat(), p.lng()); };
      marker.addListener('dragend', emit);
      map.addListener('click', (e) => { marker.setPosition(e.latLng); map.panTo(e.latLng); emit(); });
      // Handle imperativo: reposicionar el pin desde fuera (GPS / autocomplete).
      // doEmit=false cuando el llamador ya conoce la dirección (no re-geocodificar).
      if (controlRef) controlRef.current = {
        moveTo: (lat, lng, doEmit = true) => {
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
          const pos = { lat, lng };
          marker.setPosition(pos); map.panTo(pos); map.setZoom(17);
          if (doEmit) onPick(lat, lng);
        }
      };
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; if (controlRef) controlRef.current = null; };
  }, []);
  // Fallback silencioso: si el mapa no carga, se oculta y queda el flujo manual de texto.
  if (failed) return null;
  return <div ref={ref} style={{ width: '100%', height: 200, borderRadius: 14, overflow: 'hidden', border: `1px solid ${T.border}`, marginBottom: 8 }} />;
}

/* ══ PANTALLA 2A — COBERTURA ════════════ */
function CoverageScreen({ zones, restaurant, settings, onCovered, onPickupFallback, onManual, onBack }) {
  const T = useContext(ThemeCtx);
  const [status, setStatus]       = useState('idle'); // idle | loading | ok | no | denied | manual
  const [result, setResult]       = useState(null);
  const [manualZone, setManualZone] = useState(null);
  const [manualAddr, setManualAddr] = useState('');
  const [manualRef,  setManualRef]  = useState('');

  const restLat = restaurant?.lat || null;
  const restLng = restaurant?.lng || null;
  // Modo de cotización (mig 124). Sin settings → 'zone' (comportamiento actual).
  const mode = settings?.pricing_mode || 'zone';
  const zoneMode = mode === 'zone';
  // Sin zonas demo: si el local todavía no configuró cobertura, no inventamos
  // zonas/precios. La búsqueda devolverá "fuera de cobertura" y se ofrece retiro.
  const activeZones = zones;

  // Cotiza una coordenada según el modo y actualiza el estado de la pantalla.
  // Sequencer "latest-wins": en route_km la cotización es async (Distance Matrix),
  // así que descartamos respuestas viejas si llegó un pin más nuevo.
  const quoteReq = useRef(0);
  const quoteCoord = async (lat, lng) => {
    const reqId = ++quoteReq.current;
    const found = await quoteDelivery({ userLat: lat, userLng: lng, zones: activeZones, settings, restLat, restLng });
    if (reqId !== quoteReq.current) return;   // llegó una cotización más reciente → descartar ésta
    if (found && !found.outOfCoverage) {
      setResult({ ...found, userLat: lat, userLng: lng });
      setStatus('ok');
    } else {
      setStatus('no');
    }
  };

  const tryGeo = () => {
    if (!navigator.geolocation) { setStatus('manual'); return; }
    setStatus('loading');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        quoteCoord(latitude, longitude);
      },
      () => setStatus('denied'),
      { timeout: 8000 }
    );
  };

  const handleManualConfirm = () => {
    if (manualZone) {
      onCovered({ zone: manualZone, price: manualZone.price_guarani, minutes: manualZone.estimated_minutes, userLat: null, userLng: null, manualAddr: manualAddr.trim() || null, manualRef: manualRef.trim() || null });
    } else if (manualAddr.trim()) {
      // Tarifa fija: no depende de coordenadas → se cobra igual aunque la dirección
      // sea texto libre (no dejar el envío en ₲0 cuando el precio es conocido).
      if (mode === 'fixed') {
        const price = roundTo(Number(settings?.base_fee) || 0, settings?.round_to);
        onCovered({ zone: null, price, minutes: estMinutesFromKm(NaN), userLat: null, userLng: null, manualAddr: manualAddr.trim(), manualRef: manualRef.trim() || null });
      } else {
        // zone / radial_km / route_km sin coordenadas: el costo por distancia no se
        // puede calcular desde texto libre → el equipo lo confirma al despachar.
        onCovered({ zone: null, price: 0, minutes: null, userLat: null, userLng: null, pendingConfirm: true, manualAddr: manualAddr.trim(), manualRef: manualRef.trim() || null });
      }
    }
  };

  const ZoneDot = ({ color, size = 12 }) => {
    const c = zoneColors({ color });
    return <span style={{ width: size, height: size, borderRadius: '50%', background: c.dot, display: 'inline-block', flexShrink: 0, boxShadow: `0 0 0 3px ${c.dot}22` }} />;
  };

  return (
    <div style={{ minHeight: '100%', background: T.white, display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ padding: '52px 20px 20px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 12px', display: 'flex', alignItems: 'center', gap: 6, color: T.gray, fontSize: 13 }}>
          <Icon name="back" size={16} color={T.gray} />Volver
        </button>
        <div style={{ fontSize: 22, fontWeight: 800, color: T.ink }}>¿Llegamos a tu zona?</div>
        <div style={{ fontSize: 14, color: T.gray, marginTop: 6, lineHeight: 1.6 }}>
          Calculamos el costo de envío según la distancia al local.
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 20px' }}>

        {/* Estado: idle o denied → botón GPS + mapa de zonas */}
        {(status === 'idle' || status === 'denied') && (
          <>
            <button onClick={tryGeo} style={{ width: '100%', height: 54, background: T.black, color: T.white, border: 'none', borderRadius: 14, fontSize: 15, fontWeight: 800, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", marginBottom: 12 }}>
              <Icon name="location" size={18} color="#fff" />
              {status === 'denied' ? 'Reintentar con GPS' : 'Detectar mi ubicación'}
            </button>
            {status === 'denied' && (
              <div style={{ background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 10, padding: '10px 14px', marginBottom: 12, fontSize: 12, color: '#92400E', lineHeight: 1.5 }}>
                Bloqueaste el GPS. Revisá la configuración del navegador o seleccioná tu zona manualmente abajo.
              </div>
            )}

            {/* Mapa visual de zonas (sólo modo por zonas) */}
            {zoneMode && (
            <div style={{ background: T.offwhite, border: `1px solid ${T.border}`, borderRadius: 14, padding: '16px', marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.gray, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 12 }}>Zonas de cobertura desde el local</div>
              {/* Diagrama de anillos */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14, position: 'relative', height: 70 }}>
                {[...activeZones].reverse().map((z, i, arr) => {
                  const c = zoneColors(z);
                  const sz = 68 - (arr.length - 1 - i) * 16;
                  return <div key={z.id || z.name} style={{ position: 'absolute', width: sz, height: sz, borderRadius: '50%', background: c.dot + '30', border: `2px solid ${c.dot}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{i === arr.length - 1 && <Icon name="location" size={11} color={T.gray} />}</div>;
                })}
              </div>
              {activeZones.map((z) => {
                const c = zoneColors(z);
                return (
                  <div key={z.id || z.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: `1px solid ${T.border}` }}>
                    <ZoneDot color={z.color} size={10} />
                    <div style={{ flex: 1, display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: c.text }}>{z.name}</span>
                      {z.radius_km && <span style={{ fontSize: 11, color: T.gray }}>hasta {z.radius_km} km</span>}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 13, fontWeight: 800, color: T.ink }}>{fmt(z.price_guarani)}</div>
                      <div style={{ fontSize: 11, color: T.gray }}>~{z.estimated_minutes} min</div>
                    </div>
                  </div>
                );
              })}
            </div>
            )}

            {!zoneMode && (
              <div style={{ background: T.offwhite, border: `1px solid ${T.border}`, borderRadius: 14, padding: '16px', marginBottom: 14, fontSize: 13, color: T.gray, lineHeight: 1.6 }}>
                Marcá tu ubicación y te mostramos el <strong style={{ color: T.ink }}>costo exacto de envío</strong> al instante, según la distancia al local.
              </div>
            )}

            <button onClick={() => setStatus('manual')} style={{ background: 'none', border: `1.5px solid ${T.border}`, borderRadius: 12, cursor: 'pointer', width: '100%', textAlign: 'center', fontSize: 13, fontWeight: 700, color: T.ink, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", padding: '12px 0' }}>
              {zoneMode ? 'Seleccionar zona manualmente' : 'Ingresar dirección manualmente'}
            </button>
          </>
        )}

        {/* Estado: loading */}
        {status === 'loading' && (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <div style={{ width: 48, height: 48, border: `3px solid ${T.border}`, borderTopColor: T.black, borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 16px' }} />
            <div style={{ fontSize: 14, color: T.gray }}>Detectando tu ubicación…</div>
          </div>
        )}

        {/* Estado: OK — cobertura confirmada (zona o cotización por distancia) */}
        {status === 'ok' && result && (() => {
          const c = result.zone ? zoneColors(result.zone) : ZONE_COLOR_MAP.green;
          const title = result.zone ? '¡Llegamos a tu zona!' : '¡Llegamos a tu ubicación!';
          const sub = result.zone
            ? (result.zone?.name || 'Zona detectada')
            : (Number.isFinite(result.distKm) ? `~${result.distKm.toFixed(1)} km del local` : 'Dentro de cobertura');
          return (
            <div style={{ animation: 'fadeIn 300ms' }}>
              <div style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 14, padding: '20px', marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                  <ZoneDot color={result.zone?.color || 'green'} size={36} />
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 800, color: c.text }}>{title}</div>
                    <div style={{ fontSize: 13, color: c.text, fontWeight: 600 }}>{sub}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <div style={{ flex: 1, background: T.white, borderRadius: 10, padding: '12px', textAlign: 'center', border: `1px solid ${c.border}` }}>
                    <div style={{ fontSize: 11, color: c.dot, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>Envío</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: c.text }}>{fmt(result.price)}</div>
                  </div>
                  <div style={{ flex: 1, background: T.white, borderRadius: 10, padding: '12px', textAlign: 'center', border: `1px solid ${c.border}` }}>
                    <div style={{ fontSize: 11, color: c.dot, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>Tiempo</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: c.text }}>~{result.minutes} min</div>
                  </div>
                </div>
              </div>
              <button onClick={() => onCovered(result)} style={{ width: '100%', height: 54, background: T.black, color: T.white, border: 'none', borderRadius: 14, fontSize: 15, fontWeight: 800, cursor: 'pointer', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>
                Continuar con este envío
              </button>
            </div>
          );
        })()}

        {/* Estado: no cubre */}
        {status === 'no' && (
          <div style={{ animation: 'fadeIn 300ms' }}>
            <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 14, padding: '20px', marginBottom: 20, textAlign: 'center' }}>
              <div style={{ marginBottom: 10, display: 'flex', justifyContent: 'center' }}><Icon name="location" size={30} color="#DC2626" /></div>
              <div style={{ fontSize: 16, fontWeight: 800, color: '#B91C1C', marginBottom: 6 }}>Por el momento no llegamos a tu zona</div>
              <div style={{ fontSize: 13, color: '#DC2626', lineHeight: 1.6 }}>Tu dirección está fuera de nuestra área de cobertura actual.</div>
            </div>
            <button onClick={onPickupFallback} style={{ width: '100%', height: 54, background: T.black, color: T.white, border: 'none', borderRadius: 14, fontSize: 15, fontWeight: 800, cursor: 'pointer', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", marginBottom: 10 }}>
              Pero podés pasar a buscar
            </button>
            <button onClick={() => setStatus('idle')} style={{ width: '100%', height: 44, background: 'transparent', color: T.ink, border: `1.5px solid ${T.border}`, borderRadius: 14, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>
              Verificar otra dirección
            </button>
          </div>
        )}

        {/* Estado: manual — selección visual por zona */}
        {status === 'manual' && (
          <div style={{ animation: 'fadeIn 200ms' }}>
            {/* Mapa interactivo (solo si hay API key configurada). El pin arrastrable
                recalcula la zona/costo con la misma lógica de Haversine; reusa los
                estados 'ok'/'no'. Sin key, este bloque no se renderiza. */}
            {MAPS_READY && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.gray, marginBottom: 8, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  Marcá tu ubicación en el mapa
                </div>
                <MapPicker
                  center={{ lat: restLat, lng: restLng }}
                  T={T}
                  onPick={(lat, lng) => quoteCoord(lat, lng)}
                />
                <div style={{ fontSize: 12, color: T.gray, marginBottom: 16, lineHeight: 1.5 }}>
                  Arrastrá el pin o tocá el mapa para fijar tu ubicación exacta. También podés elegir la zona manualmente abajo.
                </div>
              </div>
            )}
            {!zoneMode && (
              <div style={{ fontSize: 15, fontWeight: 800, color: T.ink, marginBottom: 12 }}>Ingresá tu dirección</div>
            )}
            {zoneMode && <>
            <div style={{ fontSize: 15, fontWeight: 800, color: T.ink, marginBottom: 4 }}>Seleccioná tu zona</div>
            <div style={{ fontSize: 13, color: T.gray, marginBottom: 16, lineHeight: 1.5 }}>
              Las zonas se miden desde el local. Si no sabés cuál es, elegí la más cercana a donde estés y el repartidor confirma al salir.
            </div>

            {activeZones.map((z) => {
              const c = zoneColors(z);
              const sel = manualZone?.name === z.name;
              return (
                <div key={z.id || z.name} onClick={() => setManualZone(z)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', background: sel ? c.bg : T.white, border: `2px solid ${sel ? c.dot : T.border}`, borderRadius: 14, marginBottom: 10, cursor: 'pointer', transition: 'all 150ms' }}>
                  <ZoneDot color={z.color} size={32} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 800, color: sel ? c.text : T.ink }}>{z.name}</div>
                    <div style={{ fontSize: 12, color: T.gray, marginTop: 2 }}>
                      {z.radius_km ? `Hasta ${z.radius_km} km del local` : 'Zona extendida'}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 15, fontWeight: 800, color: sel ? c.text : T.ink }}>{fmt(z.price_guarani)}</div>
                    <div style={{ fontSize: 11, color: T.gray }}>~{z.estimated_minutes} min</div>
                  </div>
                  {sel && (
                    <div style={{ width: 22, height: 22, borderRadius: '50%', background: c.dot, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Icon name="check" size={12} color="#fff" sw={3} />
                    </div>
                  )}
                </div>
              );
            })}

            <div style={{ height: 1, background: T.border, margin: '16px 0' }} />
            </>}

            {/* Dirección libre */}
            <div style={{ fontSize: 12, fontWeight: 700, color: T.gray, marginBottom: 8, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Tu dirección o barrio
            </div>
            <input
              value={manualAddr}
              onChange={e => setManualAddr(e.target.value)}
              placeholder="Ej: Av. Mcal. López 1840, Villa Morra…"
              style={{ ...inputStyle(T), marginBottom: 10 }}
            />

            <div style={{ fontSize: 12, fontWeight: 700, color: T.gray, marginBottom: 8, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Referencias para el repartidor (opcional)
            </div>
            <input
              value={manualRef}
              onChange={e => setManualRef(e.target.value)}
              placeholder="Portón azul, al lado de la farmacia, timbre 3…"
              style={{ ...inputStyle(T), marginBottom: 12 }}
            />

            {!manualZone && manualAddr.trim() && (
              <div style={{ background: '#FFF7ED', border: '1px solid #FDE68A', borderRadius: 10, padding: '10px 12px', marginBottom: 14, fontSize: 12, color: '#92400E', lineHeight: 1.5 }}>
                Sin zona seleccionada, el equipo confirma el costo antes de salir a entregar.
              </div>
            )}

            <button onClick={handleManualConfirm} disabled={!manualZone && !manualAddr.trim()} style={{ width: '100%', height: 54, background: (manualZone || manualAddr.trim()) ? T.black : T.light, color: (manualZone || manualAddr.trim()) ? T.white : T.silver, border: 'none', borderRadius: 14, fontSize: 15, fontWeight: 800, cursor: (manualZone || manualAddr.trim()) ? 'pointer' : 'default', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", transition: 'all 200ms', marginBottom: 10 }}>
              Continuar
            </button>
            <button onClick={() => setStatus('idle')} style={{ width: '100%', height: 44, background: 'transparent', color: T.gray, border: 'none', cursor: 'pointer', fontSize: 13, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>
              Usar GPS en cambio
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ══ PANTALLA 3 — DATOS DE ENTREGA ══════ */
function CustomerDataScreen({ orderType, deliveryResult, onNext, onBack }) {
  const T = useContext(ThemeCtx);
  const restaurant = useContext(RestaurantCtx);
  const isDelivery = orderType === 'delivery';

  // Coordenada inicial: la que ya capturó CoverageScreen por GPS (deliveryResult.userLat/userLng).
  const initLat = (typeof deliveryResult?.userLat === 'number') ? deliveryResult.userLat : null;
  const initLng = (typeof deliveryResult?.userLng === 'number') ? deliveryResult.userLng : null;

  const [form, setForm] = useState({
    name: '', phone: '',
    address: deliveryResult?.manualAddr || '',
    detail: '',
    corner: '',
    references: deliveryResult?.manualRef || ''
  });
  // lat/lng viven aparte del form: el PIN del mapa es la fuente de verdad de la ubicación.
  const [lat, setLat] = useState(initLat);
  const [lng, setLng] = useState(initLng);
  const [preds, setPreds]     = useState([]);    // sugerencias de Places Autocomplete
  const [geoBusy, setGeoBusy] = useState(false); // reverse geocoding en curso
  const [gpsBusy, setGpsBusy] = useState(false); // detección GPS en curso

  const pickerCtl    = useRef(null);  // handle imperativo de DeliveryMapPicker
  const autoSvc      = useRef(null);  // google.maps.places.AutocompleteService
  const placesSvc    = useRef(null);  // google.maps.places.PlacesService
  const placesDivRef = useRef(null);  // nodo oculto requerido por PlacesService
  const predTimer    = useRef(null);
  const geoReq       = useRef(0);     // secuenciador reverse-geocode: latest-wins + no pisar lo tipeado

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));

  // Init Maps (solo delivery + key presente): servicios de Places + prefill de la
  // dirección por reverse geocoding desde la coordenada GPS inicial (si la hay).
  useEffect(() => {
    if (!isDelivery || !MAPS_READY) return;
    let on = true;
    loadGoogleMaps(MAPS_API_KEY).then((maps) => {
      if (!on) return;
      try {
        autoSvc.current   = new maps.places.AutocompleteService();
        placesSvc.current = new maps.places.PlacesService(placesDivRef.current || document.createElement('div'));
      } catch (e) {}
      if (Number.isFinite(initLat) && Number.isFinite(initLng)) {
        const reqId = ++geoReq.current;
        setGeoBusy(true);
        reverseGeocode(initLat, initLng).then(addr => {
          if (!on || reqId !== geoReq.current) return;   // el usuario tipeó / movió el pin: descartar
          if (addr) setForm(p => p.address.trim() ? p : ({ ...p, address: addr }));
          setGeoBusy(false);
        });
      }
    }).catch(() => {});
    return () => { on = false; clearTimeout(predTimer.current); };
  }, []);

  // Pin movido (arrastre/click): re-geocodificar y refrescar la dirección (editable).
  const handlePinPick = useCallback((plat, plng) => {
    setLat(plat); setLng(plng);
    setPreds([]);
    const reqId = ++geoReq.current;
    setGeoBusy(true);
    reverseGeocode(plat, plng).then(addr => {
      if (reqId !== geoReq.current) return;   // superado por otro arrastre / edición manual
      if (addr) setForm(p => ({ ...p, address: addr }));
      setGeoBusy(false);
    });
  }, []);

  // Escribir en "Dirección": pedir sugerencias a Places (debounced, restringido a PY).
  const handleAddressType = (v) => {
    geoReq.current++;     // edición manual: invalida cualquier reverse-geocode en vuelo (no pisar lo tipeado)
    setGeoBusy(false);
    setForm(p => ({ ...p, address: v }));
    clearTimeout(predTimer.current);
    if (!autoSvc.current || v.trim().length < 3) { setPreds([]); return; }
    predTimer.current = setTimeout(() => {
      autoSvc.current.getPlacePredictions(
        { input: v, language: 'es', componentRestrictions: { country: 'py' } },
        (predictions, status) => {
          if (status === 'REQUEST_DENIED') console.warn('[maps] Places (clásico) probablemente no habilitado en la API key — el autocompletado no devolverá sugerencias.');
          setPreds((status === 'OK' && predictions) ? predictions.slice(0, 5) : []);
        }
      );
    }, 350);
  };

  // Elegir una sugerencia: setea dirección + coordenada + mueve el pin (sin re-geocodificar).
  const handlePickPrediction = (p) => {
    setPreds([]);
    if (!placesSvc.current) return;
    placesSvc.current.getDetails(
      { placeId: p.place_id, fields: ['geometry', 'formatted_address'] },
      (place, status) => {
        if (status !== 'OK' || !place?.geometry) return;
        const plat = place.geometry.location.lat();
        const plng = place.geometry.location.lng();
        geoReq.current++;   // dirección elegida explícitamente: invalida geocodes en vuelo
        setLat(plat); setLng(plng);
        setGeoBusy(false);
        setForm(prev => ({ ...prev, address: place.formatted_address || prev.address }));
        if (pickerCtl.current) pickerCtl.current.moveTo(plat, plng, false);
      }
    );
  };

  // "Detectar mi ubicación" en esta pantalla (cubre GPS denegado en cobertura o reubicar).
  // navigator.geolocation NO depende de Google Maps; si Maps no cargó, igual setea lat/lng.
  const handleDetect = () => {
    if (!navigator.geolocation) return;
    setGpsBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        setLat(latitude); setLng(longitude);
        setGpsBusy(false);
        if (pickerCtl.current) pickerCtl.current.moveTo(latitude, longitude, false);
        const reqId = ++geoReq.current;
        setGeoBusy(true);
        reverseGeocode(latitude, longitude).then(addr => {
          if (reqId !== geoReq.current) return;
          if (addr) setForm(p => ({ ...p, address: addr }));
          setGeoBusy(false);
        });
      },
      () => setGpsBusy(false),
      { timeout: 8000, enableHighAccuracy: true }
    );
  };

  const zoneName = deliveryResult?.zone?.name || null;
  const zoneFee  = deliveryResult?.price != null ? deliveryResult.price : null;
  const zoneMins = deliveryResult?.minutes || null;

  const canNext = form.name.trim() && form.phone.trim() && (!isDelivery || form.address.trim());
  const submit  = () => { if (canNext) onNext({ ...form, lat, lng }); };

  // Centro inicial del mapa: coordenada GPS si la hay, si no el local, si no Asunción (default interno).
  const mapCenter = {
    lat: Number.isFinite(lat) ? lat : (typeof restaurant?.lat === 'number' ? restaurant.lat : null),
    lng: Number.isFinite(lng) ? lng : (typeof restaurant?.lng === 'number' ? restaurant.lng : null),
  };

  return (
    <div style={{ minHeight: '100%', background: T.offwhite, display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ background: T.white, padding: '52px 20px 18px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 10px', display: 'flex', alignItems: 'center', gap: 6, color: T.gray, fontSize: 13 }}>
          <Icon name="back" size={16} color={T.gray} />Volver
        </button>
        <div style={{ fontSize: 11, color: T.gray, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>
          {isDelivery ? 'Delivery' : 'Retiro en local'}
        </div>
        <div style={{ fontSize: 22, fontWeight: 800, color: T.ink }}>
          {isDelivery ? '¿A dónde te lo llevamos?' : '¿Cómo te llamamos?'}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
        {/* Zona seleccionada (solo delivery) */}
        {isDelivery && (zoneName || zoneFee != null) && (() => {
          const c = deliveryResult?.zone ? zoneColors(deliveryResult.zone) : ZONE_COLOR_MAP.green;
          return (
            <div style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 12, padding: '14px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 14, height: 14, borderRadius: '50%', background: c.dot, display: 'inline-block', flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: c.text }}>{zoneName || 'Envío a tu ubicación'}</div>
                  {deliveryResult?.pendingConfirm && <div style={{ fontSize: 11, color: '#D97706', fontWeight: 600 }}>Pendiente de confirmación</div>}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                {zoneFee != null && <div style={{ fontSize: 13, fontWeight: 800, color: c.text }}>{fmt(zoneFee)}</div>}
                {zoneMins && <div style={{ fontSize: 11, color: T.gray }}>~{zoneMins} min</div>}
              </div>
            </div>
          );
        })()}

        <div style={{ background: T.white, borderRadius: 14, padding: '20px', border: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Nombre */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 700, color: T.gray, display: 'block', marginBottom: 6, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Tu nombre *</label>
            <input value={form.name} onChange={e => f('name', e.target.value)} placeholder="¿Cómo te llamamos?" style={inputStyle(T)} />
          </div>

          {/* Teléfono */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 700, color: T.gray, display: 'block', marginBottom: 6, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Teléfono de contacto *</label>
            <input value={form.phone} onChange={e => f('phone', e.target.value)} placeholder="+595 9XX XXX XXX" type="tel" style={inputStyle(T)} />
          </div>

          {/* Solo delivery: ubicación + dirección estructurada */}
          {isDelivery && <>
            {/* Punto de entrega — mapa con pin ARRASTRABLE (si hay key de Maps).
                El pin es la fuente de verdad de la coordenada. Sin key/red, este
                bloque no se monta y queda la dirección como texto manual (defensivo). */}
            {MAPS_READY && (
              <div>
                <label style={{ fontSize: 12, fontWeight: 700, color: T.gray, display: 'block', marginBottom: 6, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Punto de entrega</label>
                <DeliveryMapPicker initial={mapCenter} onPick={handlePinPick} controlRef={pickerCtl} T={T} />
                <button onClick={handleDetect} disabled={gpsBusy} style={{ width: '100%', height: 44, background: 'transparent', color: T.ink, border: `1.5px solid ${T.border}`, borderRadius: 12, fontSize: 13, fontWeight: 700, cursor: gpsBusy ? 'default' : 'pointer', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <Icon name="location" size={15} color={T.ink} />
                  {gpsBusy ? 'Detectando…' : 'Detectar mi ubicación'}
                </button>
                <div style={{ fontSize: 11, color: T.gray, marginTop: 8, lineHeight: 1.5 }}>
                  Arrastrá el pin o tocá el mapa para fijar tu ubicación exacta.
                </div>
              </div>
            )}

            {/* Dirección — autocompletada (reverse geocoding / Places Autocomplete), editable */}
            <div style={{ position: 'relative' }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: T.gray, display: 'block', marginBottom: 6, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                Dirección *{geoBusy && <span style={{ fontWeight: 500, color: T.silver, textTransform: 'none', letterSpacing: 0 }}> · buscando…</span>}
              </label>
              <input value={form.address} onChange={e => handleAddressType(e.target.value)} onBlur={() => setTimeout(() => setPreds([]), 150)} placeholder="Calle y número — ej: Av. España 1840" autoComplete="off" style={inputStyle(T)} />
              {preds.length > 0 && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: T.white, border: `1px solid ${T.border}`, borderRadius: 12, marginTop: 4, overflow: 'hidden', boxShadow: '0 10px 30px rgba(0,0,0,0.14)' }}>
                  {preds.map(p => (
                    <div key={p.place_id} onMouseDown={() => handlePickPrediction(p)} style={{ padding: '11px 14px', cursor: 'pointer', borderBottom: `1px solid ${T.light}`, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                      <span style={{ flexShrink: 0, marginTop: 1 }}><Icon name="location" size={14} color={T.gray} /></span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: T.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.structured_formatting?.main_text || p.description}</div>
                        {p.structured_formatting?.secondary_text && <div style={{ fontSize: 11, color: T.gray, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.structured_formatting.secondary_text}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label style={{ fontSize: 12, fontWeight: 700, color: T.gray, display: 'block', marginBottom: 6, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Piso / Departamento (opcional)</label>
              <input value={form.detail} onChange={e => f('detail', e.target.value)} placeholder="Depto 5B / Casa / Piso 3" style={inputStyle(T)} />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 700, color: T.gray, display: 'block', marginBottom: 6, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Esquina (opcional)</label>
              <input value={form.corner} onChange={e => f('corner', e.target.value)} placeholder="Entre qué calles — ej: c/ Tte. Genaro Ruíz" style={inputStyle(T)} />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 700, color: T.gray, display: 'block', marginBottom: 6, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Referencias (opcional)</label>
              <input value={form.references} onChange={e => f('references', e.target.value)} placeholder="Portón verde, frente al Banco…" style={inputStyle(T)} />
            </div>

            {/* Nodo oculto requerido por google.maps.places.PlacesService */}
            <div ref={placesDivRef} style={{ display: 'none' }} />
          </>}

          {/* Solo pickup: mensaje */}
          {!isDelivery && (
            <div style={{ background: T.offwhite, borderRadius: 10, padding: '12px 14px', fontSize: 13, color: T.mid, lineHeight: 1.6, display: 'flex', gap: 8 }}>
              <Icon name="phone" size={14} color={T.gray} />
              Te avisamos por teléfono cuando tu pedido esté listo.
            </div>
          )}
        </div>

        <div style={{ height: 20 }} />
      </div>

      <div style={{ padding: '12px 20px 32px', background: T.offwhite }}>
        <button onClick={submit} disabled={!canNext} style={{ width: '100%', height: 54, background: canNext ? T.black : T.light, color: canNext ? T.white : T.silver, border: 'none', borderRadius: 14, fontSize: 15, fontWeight: 800, cursor: canNext ? 'pointer' : 'default', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", transition: 'all 200ms', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          Ver el menú
          <Icon name="chevdown" size={16} color={canNext ? '#fff' : T.silver} sw={2} />
        </button>
      </div>
    </div>
  );
}

/* ══ PROD CARD ══════════════════════════ */
function ProdCard({ item, onSelect }) {
  const T = useContext(ThemeCtx);
  return (
    <div onClick={() => onSelect(item)} style={{ display: 'flex', gap: 14, padding: '14px 0', borderBottom: `1px solid ${T.border}`, cursor: 'pointer', alignItems: 'center' }}>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>{item.name}</div>
          {item.promo && <div style={{ fontSize: 10, fontWeight: 800, background: T.black, color: T.white, borderRadius: 4, padding: '2px 7px', flexShrink: 0 }}>{item.promo.tag}</div>}
        </div>
        <div style={{ fontSize: 12, color: T.gray, lineHeight: 1.45, marginBottom: 6 }}>{item.desc}</div>
        <div style={{ fontSize: 17, fontWeight: 800, color: T.ink }}>{fmt(item.price)}</div>
      </div>
      <div style={{ width: 76, height: 76, borderRadius: 10, background: `linear-gradient(135deg,${T.dark},${T.black})`, flexShrink: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid rgba(0,0,0,0.04)` }}>
        {item.image_url
          ? <img src={item.image_url} alt={item.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { e.target.style.display = 'none'; }} />
          : <Icon name="utensils" size={21} color="rgba(255,255,255,0.15)" />}
      </div>
    </div>
  );
}

/* ══ MODAL PRODUCTO ═════════════════════ */
function ProductModal({ item, onClose, onAdd, canOrder = true, openState }) {
  const T = useContext(ThemeCtx);
  const [qty, setQty]     = useState(1);
  const [selEx, setSelEx] = useState([]);
  const [notes, setNotes] = useState('');

  const toggleEx = (e) => setSelEx(p => p.find(x => x.n === e.n) ? p.filter(x => x.n !== e.n) : [...p, e]);
  const exTotal  = selEx.reduce((s, e) => s + e.p, 0);
  const total    = (item.price + exTotal) * qty;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'flex-end' }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)' }} />
      <div style={{ position: 'relative', width: '100%', background: T.white, borderRadius: '20px 20px 0 0', maxHeight: '92%', overflowY: 'auto', animation: 'slideUp 300ms cubic-bezier(0.16,1,0.3,1)' }}>
        <div style={{ height: 200, background: item.image_url ? 'transparent' : `linear-gradient(150deg,${T.dark},${T.black})`, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', flexShrink: 0, overflow: 'hidden' }}>
          {item.image_url
            ? <img src={item.image_url} alt={item.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <Icon name="utensils" size={52} color="rgba(255,255,255,0.1)" />}
          {item.promo && <div style={{ position: 'absolute', top: 16, left: 16, background: T.white, color: T.black, borderRadius: 6, padding: '4px 11px', fontSize: 11, fontWeight: 800 }}>{item.promo.tag}</div>}
          <button onClick={onClose} style={{ position: 'absolute', top: 16, right: 16, width: 34, height: 34, borderRadius: '50%', background: 'rgba(0,0,0,0.35)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="x" size={16} color="#fff" /></button>
          <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', width: 36, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.4)' }} />
        </div>
        <div style={{ padding: '20px 20px 32px' }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: T.ink, marginBottom: 4 }}>{item.name}</div>
          <div style={{ fontSize: 13, color: T.gray, lineHeight: 1.55, marginBottom: 18 }}>{item.desc}</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, background: T.light, borderRadius: 12, padding: '12px 16px' }}>
            <div style={{ fontSize: 19, fontWeight: 800, color: T.ink }}>{fmt(item.price)}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button onClick={() => setQty(q => Math.max(1, q - 1))} style={{ width: 34, height: 34, borderRadius: 8, border: `1.5px solid ${T.border}`, background: T.white, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="minus" size={14} color={T.ink} /></button>
              <span style={{ fontWeight: 800, fontSize: 17, minWidth: 26, textAlign: 'center', color: T.ink }}>{qty}</span>
              <button onClick={() => setQty(q => q + 1)} style={{ width: 34, height: 34, borderRadius: 8, border: 'none', background: T.black, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="plus" size={14} color={T.white} /></button>
            </div>
          </div>

          {item.extras?.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 10 }}>Personalizar</div>
              {item.extras.map(e => {
                const sel = !!selEx.find(x => x.n === e.n);
                return (
                  <div key={e.n} onClick={() => toggleEx(e)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 0', borderBottom: `1px solid ${T.border}`, cursor: 'pointer' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 20, height: 20, borderRadius: 5, border: `2px solid ${sel ? T.black : T.border}`, background: sel ? T.black : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms', flexShrink: 0 }}>
                        {sel && <Icon name="check" size={12} color={T.white} sw={3} />}
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 500, color: T.ink }}>{e.n}</span>
                    </div>
                    <span style={{ fontSize: 13, color: T.gray }}>{e.p > 0 ? '+' + fmt(e.p) : 'Gratis'}</span>
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ marginBottom: 22 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>Observaciones para cocina</div>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Sin sal, sin cebolla, alergia a…" style={{ width: '100%', height: 76, border: `1px solid ${T.border}`, borderRadius: 10, padding: '10px 12px', fontSize: 13, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: T.ink, resize: 'none', outline: 'none', background: T.offwhite }} />
            <div style={{ marginTop: 8, background: '#FFF7ED', border: '1px solid #FDE68A', borderRadius: 8, padding: '8px 10px', display: 'flex', gap: 7, alignItems: 'flex-start' }}>
              <span style={{ flexShrink: 0, display: 'flex' }}><Icon name="alert" size={14} color="#92400E" /></span>
              <span style={{ fontSize: 11, color: '#92400E', lineHeight: 1.5 }}>Si tenés alergias o intolerancias, indicalas arriba.</span>
            </div>
          </div>

          {canOrder ? (
          <button onClick={() => { onAdd(item, qty, selEx, notes); onClose(); }} style={{ width: '100%', height: 54, background: T.black, color: T.white, border: 'none', borderRadius: 14, fontSize: 15, fontWeight: 800, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>
            <span>Agregar al pedido</span>
            <span style={{ fontSize: 15, fontWeight: 800 }}>{fmt(total)}</span>
          </button>
          ) : (
          <button disabled style={{ width: '100%', height: 54, background: T.light, color: T.gray, border: `1px solid ${T.border}`, borderRadius: 14, fontSize: 14, fontWeight: 800, cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 20px', textAlign: 'center', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>
            {openState && openState.next ? `Cerrado · Abre ${openState.next}` : 'Local cerrado — no se puede pedir ahora'}
          </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ══ PANTALLA 4 — MENÚ ══════════════════ */
function MenuScreen({ onItemSelect, cartTotal, cartCount, onViewCart, orderType, menuStatus, canOrder = true, openState }) {
  const T        = useContext(ThemeCtx);
  const liveMenu = useContext(MenuCtx) || {};
  const restaurant = useContext(RestaurantCtx);
  const CATS     = Object.keys(liveMenu);
  const ALL_ITEMS = CATS.flatMap(c => liveMenu[c]);
  const [activeCat, setActiveCat] = useState(CATS[0]);
  const [search, setSearch]       = useState('');
  const catRefs   = useRef({});
  const scrollRef = useRef();
  const restName  = restaurant?.name || 'Restaurante';

  const promoItems = ALL_ITEMS.filter(i => i.promo);
  const featured   = ALL_ITEMS.find(i => i.promo?.tag?.includes('★')) || promoItems[0] || null;
  const filtered   = search.trim()
    ? ALL_ITEMS.filter(i => i.name.toLowerCase().includes(search.toLowerCase()) || (i.desc||'').toLowerCase().includes(search.toLowerCase()))
    : null;

  const goTo = (cat) => {
    setActiveCat(cat);
    const el = catRefs.current[cat];
    if (el && scrollRef.current) scrollRef.current.scrollTo({ top: el.offsetTop - 106, behavior: 'smooth' });
  };

  return (
    <div style={{ height: '100%', background: T.offwhite, display: 'flex', flexDirection: 'column', position: 'relative' }}>
      {/* Header */}
      <div style={{ background: T.white, padding: '52px 20px 12px', flexShrink: 0, borderBottom: `1px solid ${T.border}` }}>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: T.gray, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 2 }}>
            {orderType === 'delivery' ? 'Pedido a domicilio' : 'Para retirar'}
          </div>
          <div style={{ fontSize: 20, fontWeight: 800, color: T.ink }}>{restName}</div>
        </div>
        <div style={{ position: 'relative' }}>
          <div style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }}><Icon name="search" size={15} color={T.gray} /></div>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar en el menú…" style={{ width: '100%', height: 40, background: T.light, border: `1px solid ${T.border}`, borderRadius: 10, paddingLeft: 36, paddingRight: 32, color: T.ink, fontSize: 13, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", outline: 'none' }} />
          {search && <button onClick={() => setSearch('')} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer' }}><Icon name="x" size={14} color={T.gray} /></button>}
        </div>
      </div>

      {/* Tabs de categoría */}
      <div style={{ background: T.white, borderBottom: `1px solid ${T.border}`, flexShrink: 0, overflowX: 'auto' }}>
        <div style={{ display: 'flex', minWidth: 'max-content' }}>
          {CATS.map(cat => (
            <button key={cat} onClick={() => goTo(cat)} style={{ flexShrink: 0, background: 'none', border: 'none', borderBottom: `2px solid ${activeCat === cat ? T.black : 'transparent'}`, cursor: 'pointer', padding: '11px 18px', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 13, fontWeight: 700, color: activeCat === cat ? T.black : T.gray, whiteSpace: 'nowrap', transition: 'all 150ms' }}>{cat}</button>
          ))}
        </div>
      </div>

      {/* Banner CERRADO: menú navegable (solo lectura), sin agregar al carrito. */}
      {!canOrder && (
        <div style={{ flexShrink: 0, background: 'rgba(220,38,38,0.10)', borderBottom: '1px solid rgba(220,38,38,0.25)', padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#DC2626', flexShrink: 0 }} />
          <span style={{ fontSize: 12.5, fontWeight: 700, color: '#B91C1C' }}>
            {openState && openState.next ? `Cerrado · Abre ${openState.next}` : 'Cerrado'} — podés ver el menú, pero no pedir ahora.
          </span>
        </div>
      )}

      {/* Scroll de items */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        {CATS.length === 0 ? (
          <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '60px 32px', gap: 12 }}>
            <Icon name="utensils" size={40} color={T.silver} />
            <div style={{ fontSize: 17, fontWeight: 800, color: T.ink }}>
              {menuStatus === 'empty' ? 'Menú no disponible todavía' : 'Cargando menú…'}
            </div>
            {menuStatus === 'empty' && <div style={{ fontSize: 13, color: T.gray, lineHeight: 1.7, maxWidth: 280 }}>
              {restName} todavía no publicó su carta. Volvé a intentarlo en un rato o actualizá la página.
            </div>}
          </div>
        ) : filtered ? (
          <div style={{ padding: '16px 20px' }}>
            <div style={{ fontSize: 12, color: T.gray, marginBottom: 12 }}>{filtered.length} resultado{filtered.length !== 1 ? 's' : ''} · "{search}"</div>
            {filtered.map(item => <ProdCard key={item.id} item={item} onSelect={onItemSelect} />)}
          </div>
        ) : (
          <>
            {promoItems.length > 0 && (
              <div style={{ padding: '16px 20px 8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                  <Icon name="fire" size={14} color={T.ink} />
                  <span style={{ fontSize: 11, fontWeight: 800, color: T.ink, letterSpacing: '0.14em', textTransform: 'uppercase' }}>Promos de hoy</span>
                </div>
                <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 6 }}>
                  {promoItems.map(item => (
                    <div key={item.id} onClick={() => onItemSelect(item)} style={{ flexShrink: 0, width: 155, background: T.white, borderRadius: 14, border: `1px solid ${T.border}`, cursor: 'pointer', overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
                      <div style={{ height: 88, background: `linear-gradient(135deg,${T.dark},${T.black})`, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {item.image_url ? <img src={item.image_url} alt={item.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Icon name="utensils" size={28} color="rgba(255,255,255,0.12)" />}
                        <div style={{ position: 'absolute', top: 7, right: 7, background: T.white, color: T.black, borderRadius: 5, padding: '2px 7px', fontSize: 10, fontWeight: 800 }}>{item.promo.tag}</div>
                      </div>
                      <div style={{ padding: '9px 10px' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: T.ink, lineHeight: 1.3, marginBottom: 2, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{item.name}</div>
                        <div style={{ fontSize: 14, fontWeight: 800, color: T.ink }}>{fmt(item.price)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {featured && (
              <div style={{ margin: '4px 20px 4px', background: T.white, borderRadius: 14, border: `1px solid ${T.border}`, overflow: 'hidden', cursor: 'pointer' }} onClick={() => onItemSelect(featured)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px' }}>
                  <div style={{ width: 54, height: 54, borderRadius: 10, background: `linear-gradient(135deg,${T.dark},${T.black})`, flexShrink: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {featured.image_url ? <img src={featured.image_url} alt={featured.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Icon name="award" size={22} color="rgba(255,255,255,0.2)" />}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, fontWeight: 800, color: T.silver, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 2 }}>★ Destacado del mes</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>{featured.name}</div>
                    <div style={{ fontSize: 12, color: T.gray }}>{fmt(featured.price)}</div>
                  </div>
                  <Icon name="chevdown" size={16} color={T.silver} sw={2} />
                </div>
              </div>
            )}

            {CATS.map(cat => (
              <div key={cat} ref={el => catRefs.current[cat] = el}>
                <div style={{ padding: '22px 20px 10px', display: 'flex', alignItems: 'center' }}>
                  <div style={{ flex: 1, height: 1, background: T.border }} />
                  <div style={{ padding: '0 14px', fontSize: 13, fontWeight: 800, color: T.ink, letterSpacing: '0.14em', textTransform: 'uppercase' }}>{cat}</div>
                  <div style={{ flex: 1, height: 1, background: T.border }} />
                </div>
                <div style={{ padding: '0 20px' }}>
                  {liveMenu[cat].map(item => <ProdCard key={item.id} item={item} onSelect={onItemSelect} />)}
                </div>
              </div>
            ))}
          </>
        )}
        <div style={{ height: 96 }} />
      </div>

      {cartCount > 0 && (
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '12px 20px 28px', background: `linear-gradient(to top,${T.offwhite} 60%,transparent)` }}>
          <button onClick={onViewCart} style={{ width: '100%', height: 54, background: T.black, color: T.white, border: 'none', borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 15, fontWeight: 800, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', boxShadow: '0 8px 32px rgba(0,0,0,0.25)' }}>
            <div style={{ minWidth: 26, height: 26, background: 'rgba(255,255,255,0.15)', borderRadius: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, padding: '0 8px' }}>{cartCount}</div>
            <span>Mi pedido</span>
            <span style={{ fontSize: 15, fontWeight: 800 }}>{fmt(cartTotal)}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/* ══ PANTALLA 5 — CARRITO ═══════════════ */
function CartScreen({ items, orderType, deliveryFee, deliveryResult, onBack, onCheckout, onRemove, onQty, canOrder = true, openState }) {
  const T = useContext(ThemeCtx);
  const [pendingDelete, setPendingDelete] = useState(null);
  const isDelivery = orderType === 'delivery';
  const subtotal   = items.reduce((s, ci) => s + ci.total, 0);
  const fee        = isDelivery ? (deliveryFee || 0) : 0;
  const total      = subtotal + fee;

  const doDelete = () => { onRemove(pendingDelete); setPendingDelete(null); };

  return (
    <div style={{ minHeight: '100%', background: T.offwhite, display: 'flex', flexDirection: 'column' }}>
      {/* Confirm delete modal */}
      {pendingDelete !== null && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div onClick={() => setPendingDelete(null)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} />
          <div style={{ position: 'relative', background: T.white, borderRadius: 16, padding: '24px 20px', width: '100%', maxWidth: 320, textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, marginBottom: 6 }}>¿Eliminar este ítem?</div>
            <div style={{ fontSize: 13, color: T.gray, marginBottom: 20 }}>{items[pendingDelete]?.item?.name}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setPendingDelete(null)} style={{ flex: 1, height: 44, border: `1.5px solid ${T.border}`, borderRadius: 10, background: 'transparent', color: T.ink, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>Cancelar</button>
              <button onClick={doDelete} style={{ flex: 1, height: 44, border: 'none', borderRadius: 10, background: '#EF4444', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>Eliminar</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ background: T.white, padding: '52px 20px 16px', flexShrink: 0, borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onBack} style={{ width: 38, height: 38, background: T.light, border: 'none', borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon name="back" size={17} color={T.ink} /></button>
          <div>
            <div style={{ fontSize: 11, color: T.gray }}>{isDelivery ? 'Pedido a domicilio' : 'Para retirar'}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: T.ink }}>Mi pedido</div>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        {items.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Icon name="utensils" size={40} color={T.border} />
            <div style={{ marginTop: 14, fontSize: 14, color: T.silver, marginBottom: 20 }}>Tu pedido está vacío</div>
            <button onClick={onBack} style={{ height: 44, padding: '0 20px', background: T.black, color: T.white, border: 'none', borderRadius: 12, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Ver el menú</button>
          </div>
        )}

        {items.map((ci, i) => (
          <div key={i} style={{ background: T.white, borderRadius: 12, padding: '14px', marginBottom: 10, border: `1px solid ${T.border}` }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ width: 46, height: 46, borderRadius: 8, background: T.black, flexShrink: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {ci.item.image_url
                  ? <img src={ci.item.image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <Icon name="utensils" size={18} color="rgba(255,255,255,0.2)" />}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>{ci.item.name}</div>
                {ci.extras?.length > 0 && <div style={{ fontSize: 11, color: T.gray, marginTop: 2 }}>+ {ci.extras.map(e => e.n).join(', ')}</div>}
                {ci.notes && <div style={{ fontSize: 11, color: T.silver, fontStyle: 'italic', marginTop: 2 }}>"{ci.notes}"</div>}
              </div>
              <button onClick={() => setPendingDelete(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, flexShrink: 0 }}><Icon name="trash" size={15} color={T.silver} /></button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={() => onQty(i, -1)} style={{ width: 30, height: 30, background: T.light, border: `1px solid ${T.border}`, borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="minus" size={12} color={T.ink} /></button>
                <span style={{ fontSize: 15, fontWeight: 800, color: T.ink, minWidth: 22, textAlign: 'center' }}>{ci.qty}</span>
                <button onClick={() => onQty(i, 1)} style={{ width: 30, height: 30, background: T.black, border: 'none', borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="plus" size={12} color={T.white} /></button>
              </div>
              <div style={{ fontSize: 17, fontWeight: 800, color: T.ink }}>{fmt(ci.total)}</div>
            </div>
          </div>
        ))}

        {/* Resumen */}
        {items.length > 0 && (
          <div style={{ background: T.white, borderRadius: 12, padding: '16px', border: `1px solid ${T.border}`, marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: T.gray, marginBottom: 8 }}>
              <span>Subtotal</span><span>{fmt(subtotal)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: T.gray, marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${T.border}` }}>
              <span>{isDelivery ? 'Delivery' : 'Retiro en local'}</span>
              <span style={{ color: isDelivery ? T.ink : '#16A34A', fontWeight: isDelivery ? 400 : 700 }}>
                {isDelivery ? fmt(fee) : 'Gratis'}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>Total</span>
              <span style={{ fontSize: 20, fontWeight: 800, color: T.ink }}>{fmt(total)}</span>
            </div>
          </div>
        )}

        {/* Zona info */}
        {isDelivery && deliveryResult?.zone?.name && (
          <div style={{ background: T.light, borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Icon name="location" size={14} color={T.gray} />
            <span style={{ fontSize: 12, color: T.mid }}>{deliveryResult.zone.name} · ~{deliveryResult.minutes} min estimados</span>
          </div>
        )}

        <div style={{ height: 100 }} />
      </div>

      <div style={{ padding: '12px 20px 32px', background: T.offwhite, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.length > 0 && (
          <button onClick={onBack} style={{ width: '100%', height: 44, background: 'transparent', color: T.ink, border: `1.5px solid ${T.border}`, borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 14, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Icon name="plus" size={15} color={T.ink} />Agregar más productos
          </button>
        )}
        {(() => { const blocked = items.length === 0 || !canOrder; return (
        <button onClick={() => { if (!blocked) onCheckout(subtotal, fee, total); }} disabled={blocked} style={{ width: '100%', height: 54, background: blocked ? T.light : T.black, color: blocked ? T.silver : T.white, border: 'none', borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 16, fontWeight: 800, cursor: blocked ? 'default' : 'pointer', transition: 'all 200ms' }}>
          {!canOrder ? (openState && openState.next ? `Cerrado · Abre ${openState.next}` : 'Local cerrado') : 'Ir a pagar'}
        </button>
        ); })()}
      </div>
    </div>
  );
}

/* ══ PANTALLA 6 — PAGO ══════════════════ */
function PayScreen({ orderType, subtotal, deliveryFee, total, customerData, deliveryResult, cartItems, onBack, onConfirmed, canOrder = true, openState }) {
  const T = useContext(ThemeCtx);
  const isDelivery = orderType === 'delivery';
  const [method, setMethod] = useState('efectivo');
  const [step, setStep]     = useState('form');
  const [submitError, setSubmitError] = useState(null);
  const [cashOption, setCashOption] = useState('exact'); // 'exact' | 'change'
  const [cashInput, setCashInput]   = useState('');
  const [invoiceType, setInvoiceType] = useState('none'); // 'none'|'ticket'|'fiscal'
  const [invoiceDelivery, setInvoiceDelivery] = useState('print'); // 'print' | 'email'
  const [invName, setInvName] = useState('');
  const [invRuc, setInvRuc] = useState('');
  const [invEmail, setInvEmail] = useState('');
  const [showBancardToast, setShowBancardToast] = useState(false);

  const METHODS = isDelivery
    ? [
        { id: 'efectivo', label: 'Efectivo al repartidor', sub: 'Pagás cuando recibís el pedido' },
        { id: 'qr', label: 'QR / Billetera digital', sub: 'Tigo Money · Personal Pay' }
      ]
    : [
        { id: 'efectivo', label: 'Efectivo al retirar', sub: 'Pagás cuando pasás a buscar' },
        { id: 'qr', label: 'QR / Billetera digital', sub: 'Tigo Money · Personal Pay' }
      ];

  const cashAmountNum = parseInt(cashInput) || 0;
  const cashChange    = cashAmountNum > 0 ? cashAmountNum - total : 0;

  const submittingRef = useRef(false);   // WS3-B · guard anti doble-submit (sincrónico, no async como `step`)
  const handleConfirm = async () => {
    if (submittingRef.current) return;   // un 2º click rápido NO dispara otro insert
    setSubmitError(null);
    // Bloqueo con el local CERRADO (cubre cierre en vivo durante el checkout).
    if (!canOrder) { setSubmitError(openState && openState.next ? `El local está cerrado · Abre ${openState.next}. No se puede confirmar el pedido ahora.` : 'El local está cerrado. No se puede confirmar el pedido ahora.'); return; }
    // WS3 · No enviar un pedido vacío ni con total inválido (alineado al cliente QR /index).
    if (!cartItems || cartItems.length === 0) { setSubmitError('Tu carrito está vacío. Volvé al menú.'); return; }
    if (!(total > 0)) { setSubmitError('El total del pedido es inválido. Volvé al carrito y revisá tu pedido.'); return; }
    submittingRef.current = true;        // se setea ANTES del primer await → bloquea reentrada
    setStep('proc');
    try {
      const order = await dbSubmitDeliveryOrder({
        orderType,
        cartItems,
        subtotal,
        deliveryFee: deliveryFee || 0,
        total,
        payMethod: method,
        customerData,
        zone: deliveryResult?.zone || null,
        estimatedMinutes: deliveryResult?.minutes || null,
        canal: CANAL,
        cashAmount: (method === 'efectivo' && cashOption === 'change' && cashAmountNum > total) ? cashAmountNum : null,
        requiresInvoice: invoiceType !== 'none',
        custRuc: invoiceType === 'fiscal' ? (invRuc || null) : null,
        custEmail: invoiceType === 'fiscal' ? (invEmail || null) : null,
        invoiceDeliveryMethod: invoiceType !== 'none' ? invoiceDelivery : null,
      });
      setStep('form');
      onConfirmed(order);
    } catch(e) {
      setSubmitError(e.message || 'No se pudo enviar el pedido');
      setStep('form');
      submittingRef.current = false;     // error real → permitir reintento
    }
  };

  if (step === 'proc') return (
    <div style={{ minHeight: '100%', background: T.white, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32 }}>
      <div style={{ width: 56, height: 56, border: `3px solid ${T.border}`, borderTopColor: T.black, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <div style={{ fontSize: 18, fontWeight: 800, color: T.ink }}>Enviando pedido…</div>
      <div style={{ fontSize: 12, color: T.silver }}>{fmt(total)}</div>
    </div>
  );

  return (
    <div style={{ minHeight: '100%', background: T.offwhite, display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ background: T.white, padding: '52px 20px 16px', flexShrink: 0, borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onBack} style={{ width: 38, height: 38, background: T.light, border: 'none', borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon name="back" size={17} color={T.ink} /></button>
          <div>
            <div style={{ fontSize: 11, color: T.gray }}>Total a pagar</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: T.ink }}>{fmt(total)}</div>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
        {/* Resumen de datos */}
        <div style={{ background: T.white, borderRadius: 14, padding: '16px', border: `1px solid ${T.border}`, marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 12 }}>Datos del pedido</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <Icon name="walk" size={14} color={T.gray} />
              <span style={{ fontSize: 13, color: T.mid }}>{customerData.name} · {customerData.phone}</span>
            </div>
            {isDelivery && customerData.address && (
              <div style={{ display: 'flex', gap: 8 }}>
                <Icon name="location" size={14} color={T.gray} />
                <span style={{ fontSize: 13, color: T.mid }}>
                  {customerData.address}{customerData.detail ? `, ${customerData.detail}` : ''}
                </span>
              </div>
            )}
            {isDelivery && deliveryResult && (deliveryResult.zone?.name || deliveryResult.price != null) && (() => {
              const c = deliveryResult.zone ? zoneColors(deliveryResult.zone) : ZONE_COLOR_MAP.green;
              const label = deliveryResult.zone?.name || 'Envío';
              return (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: c.dot, display: 'inline-block', flexShrink: 0 }} />
                  <span style={{ fontSize: 13, color: T.mid }}>
                    {label} · {fmt(deliveryFee || 0)}{deliveryResult.minutes ? ` · ~${deliveryResult.minutes} min` : ''}
                  </span>
                </div>
              );
            })()}
          </div>
        </div>

        {/* Método de pago */}
        <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 10 }}>Método de pago</div>
        {METHODS.map(m => (
          <div key={m.id} onClick={() => setMethod(m.id)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', background: T.white, border: `2px solid ${method === m.id ? T.black : T.border}`, borderRadius: 12, marginBottom: 8, cursor: 'pointer', transition: 'border-color 150ms' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>{m.label}</div>
              <div style={{ fontSize: 12, color: T.gray, marginTop: 1 }}>{m.sub}</div>
            </div>
            <div style={{ width: 20, height: 20, borderRadius: '50%', border: `2px solid ${method === m.id ? T.black : T.border}`, background: method === m.id ? T.black : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 150ms' }}>
              {method === m.id && <div style={{ width: 8, height: 8, borderRadius: '50%', background: T.white }} />}
            </div>
          </div>
        ))}

        {method === 'qr' && (
          <div style={{ background: '#FFF7ED', border: '1px solid #FDE68A', borderRadius: 10, padding: '10px 14px', marginBottom: 14, fontSize: 12, color: '#92400E', lineHeight: 1.5 }}>
            El pago digital estará disponible próximamente. Confirmá el pedido y coordinamos el pago por WhatsApp.
          </div>
        )}

        {/* ── Pago Online Bancard — Próximamente ── */}
        <div onClick={() => setShowBancardToast(true)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', background: 'rgba(255,149,0,0.05)', border: `2px dashed rgba(255,149,0,0.35)`, borderRadius: 12, marginBottom: 8, cursor: 'pointer' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#92400E', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Icon name="card" size={14} color="#92400E" /> Pago Online (Tarjeta/QR Bancard)
              <span style={{ fontSize: 9, fontWeight: 800, background: '#FF9500', color: '#fff', borderRadius: 4, padding: '2px 5px', letterSpacing: '0.05em' }}>PRÓXIMAMENTE</span>
            </div>
            <div style={{ fontSize: 12, color: '#B45309', marginTop: 1 }}>Visa · Mastercard · QR Bancard</div>
          </div>
          <div style={{ fontSize: 18, opacity: 0.5 }}>›</div>
        </div>

        {/* Vuelto — solo para efectivo */}
        {method === 'efectivo' && (
          <div style={{ background: T.white, border: `1px solid ${T.border}`, borderRadius: 12, padding: '14px 16px', marginBottom: 8, marginTop: 4 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.gray, marginBottom: 10 }}>¿Necesitás vuelto?</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: cashOption === 'change' ? 12 : 0 }}>
              {[['exact','Tengo exacto'],['change','Necesito vuelto']].map(([val,lbl])=>(
                <button key={val} onClick={()=>{setCashOption(val);if(val==='exact')setCashInput('');}} style={{
                  flex:1, padding:'10px 6px', borderRadius:9, border:`2px solid ${cashOption===val?T.black:T.border}`,
                  background: cashOption===val?T.black:'transparent', color: cashOption===val?T.white:T.ink,
                  fontSize:13, fontWeight:700, cursor:'pointer', transition:'all 150ms'
                }}>{lbl}</button>
              ))}
            </div>
            {cashOption === 'change' && (
              <div>
                <div style={{ fontSize: 12, color: T.gray, marginBottom: 6 }}>¿Con cuánto pagás? (₲)</div>
                <input
                  type="number" inputMode="numeric"
                  value={cashInput}
                  onChange={e=>setCashInput(e.target.value)}
                  placeholder={String(total)}
                  style={{ width:'100%', padding:'10px 12px', border:`1.5px solid ${cashAmountNum>0&&cashAmountNum<total?'#EF4444':T.border}`, borderRadius:9, fontSize:16, fontFamily:"'SF Mono',ui-monospace,monospace", fontWeight:700, boxSizing:'border-box', outline:'none' }}
                />
                {cashAmountNum > 0 && cashAmountNum >= total && (
                  <div style={{ marginTop:10, padding:'12px 14px', background:'rgba(34,197,94,0.08)', border:'1px solid rgba(34,197,94,0.3)', borderRadius:9 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                      <span style={{ fontSize:13, color:'#15803D', fontWeight:700 }}>Vuelto a preparar</span>
                      <span style={{ fontSize:22, fontWeight:800, color:'#16A34A', fontFamily:"'SF Mono',ui-monospace,monospace" }}>{fmt(cashChange)}</span>
                    </div>
                    <div style={{ fontSize:11, color:T.gray, marginTop:4 }}>Pagás {fmt(cashAmountNum)} − Total {fmt(total)}</div>
                  </div>
                )}
                {cashAmountNum > 0 && cashAmountNum < total && (
                  <div style={{ marginTop:10, padding:'10px 14px', background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.3)', borderRadius:9 }}>
                    <span style={{ fontSize:13, color:'#DC2626', fontWeight:700 }}>Insuficiente — faltan {fmt(total - cashAmountNum)}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Comprobante */}
        <div style={{ background: T.white, borderRadius: 12, padding: '14px 16px', border: `1px solid ${T.border}`, marginTop: 8, marginBottom: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 }}>Comprobante</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: invoiceType !== 'none' ? 12 : 0 }}>
            {[['none','Sin comp.'],['ticket','Ticket'],['fiscal','Factura fiscal']].map(([v,lbl]) => (
              <div key={v} onClick={() => setInvoiceType(v)} style={{ padding: '11px 6px', background: invoiceType === v ? T.black : T.white, border: `2px solid ${invoiceType === v ? T.black : T.border}`, borderRadius: 10, cursor: 'pointer', textAlign: 'center', transition: 'border-color 150ms' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: invoiceType === v ? T.white : T.ink }}>{lbl}</span>
              </div>
            ))}
          </div>
          {invoiceType !== 'none' && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.gray, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>¿Cómo querés recibirlo?</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {[['print','Lo recibís con el pedido'],['email','Por email']].map(([v, lbl]) => (
                  <div key={v} onClick={() => setInvoiceDelivery(v)} style={{ padding: '10px 4px', background: invoiceDelivery === v ? T.black : T.white, border: `2px solid ${invoiceDelivery === v ? T.black : T.border}`, borderRadius: 9, cursor: 'pointer', textAlign: 'center' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: invoiceDelivery === v ? T.white : T.ink }}>{lbl}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {invoiceType === 'ticket' && (
            <div style={{ padding: '10px 12px', background: T.offwhite, borderRadius: 8, fontSize: 12, color: T.gray, lineHeight: 1.5 }}>
              {invoiceDelivery === 'email' ? 'Te enviaremos el ticket por email.' : 'El repartidor te trae el ticket impreso.'}
            </div>
          )}
          {invoiceType === 'fiscal' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input value={invName} onChange={e => setInvName(e.target.value)} placeholder="Nombre o razón social" style={{ height: 42, border: `1px solid ${T.border}`, borderRadius: 9, padding: '0 12px', fontSize: 13, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: T.ink, outline: 'none', background: T.offwhite }} />
              <input value={invRuc} onChange={e => setInvRuc(e.target.value)} placeholder="RUC / Cédula de identidad" style={{ height: 42, border: `1px solid ${T.border}`, borderRadius: 9, padding: '0 12px', fontSize: 13, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: T.ink, outline: 'none', background: T.offwhite }} />
              <input type="email" value={invEmail} onChange={e => setInvEmail(e.target.value)} placeholder="Email para factura electrónica" style={{ height: 42, border: `1px solid ${T.border}`, borderRadius: 9, padding: '0 12px', fontSize: 13, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: T.ink, outline: 'none', background: T.offwhite }} />
              <div style={{ fontSize: 11, color: T.silver }}>La e-Kuatia (SIFEN) estará disponible próximamente.</div>
            </div>
          )}
        </div>

        {/* Resumen totales */}
        <div style={{ background: T.white, borderRadius: 12, padding: '16px', border: `1px solid ${T.border}`, marginTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: T.gray, marginBottom: 8 }}><span>Subtotal</span><span>{fmt(subtotal)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: T.gray, marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${T.border}` }}>
            <span>{isDelivery ? 'Delivery' : 'Retiro'}</span>
            <span style={{ color: isDelivery ? T.ink : '#16A34A', fontWeight: isDelivery ? 400 : 700 }}>{isDelivery ? fmt(deliveryFee || 0) : 'Gratis'}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>Total</span>
            <span style={{ fontSize: 20, fontWeight: 800, color: T.ink }}>{fmt(total)}</span>
          </div>
        </div>

        <div style={{ height: 100 }} />
      </div>

      <div style={{ padding: '12px 20px 32px', background: T.offwhite }}>
        {submitError && (
          <div style={{ background: '#FEE2E2', border: '1px solid #FECACA', borderRadius: 10, padding: '10px 14px', marginBottom: 10, fontSize: 13, color: '#B91C1C', fontWeight: 600 }}>
            Error: {submitError}
          </div>
        )}
        <button onClick={handleConfirm} disabled={!canOrder} style={{ width: '100%', height: 54, background: canOrder ? T.black : T.light, color: canOrder ? T.white : T.silver, border: 'none', borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 16, fontWeight: 800, cursor: canOrder ? 'pointer' : 'default', boxShadow: canOrder ? '0 8px 24px rgba(0,0,0,0.15)' : 'none' }}>
          {canOrder ? 'Confirmar pedido' : (openState && openState.next ? `Cerrado · Abre ${openState.next}` : 'Local cerrado')}
        </button>
      </div>
      {showBancardToast && (() => {
        setTimeout(() => setShowBancardToast(false), 4000);
        return (
          <div onClick={() => setShowBancardToast(false)} style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 9999, background: '#1C1C1E', color: 'var(--bg-subtle)', borderRadius: 14, padding: '14px 20px', maxWidth: 340, width: 'calc(100% - 40px)', boxShadow: '0 8px 32px rgba(0,0,0,0.4)', display: 'flex', alignItems: 'flex-start', gap: 12, cursor: 'pointer' }}>
            <span style={{ flexShrink: 0, display: 'flex' }}><Icon name="building" size={22} color="var(--bg-subtle)" /></span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 3 }}>Módulo Bancard / SIFEN en fase de certificación</div>
              <div style={{ fontSize: 11, color: '#AEAEB2', lineHeight: 1.4 }}>Esta pasarela se activará automáticamente al concluir los trámites del comercio.</div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/* ══ PANTALLA 7 — CONFIRMACIÓN / TRACKING ══ */
function ConfirmScreen({ order, orderType, customerData, deliveryResult, deliveryFee, onNewOrder }) {
  const T = useContext(ThemeCtx);
  const restaurant = useContext(RestaurantCtx);
  const isDelivery = orderType === 'delivery';
  const orderNum   = order?.order_number || 'D-?????';

  const DELIVERY_STEPS = [
    { label: 'Confirmado',  sub: 'Recibimos tu pedido' },
    { label: 'En cocina',   sub: 'Están preparando tu pedido' },
    { label: 'Listo',       sub: 'Tu pedido está listo para entregar' },
    { label: 'En camino',   sub: 'El repartidor está en ruta' },
    { label: 'Entregado',   sub: '¡A disfrutar!' }
  ];
  const PICKUP_STEPS = [
    { label: 'Confirmado', sub: 'Recibimos tu pedido' },
    { label: 'En cocina', sub: 'Están preparando tu pedido' },
    { label: 'Listo para retirar', sub: 'Pasá a buscarlo en caja' }
  ];
  const STEPS = isDelivery ? DELIVERY_STEPS : PICKUP_STEPS;

  const STATUS_MAP_PICKUP = { paid: 0, confirmed: 0, kitchen_received: 1, cooking: 1, ready: 2, delivered: 2 };

  // Para delivery: el step se calcula combinando orders.status + delivery_orders.rider_status
  const calcDeliveryStep = (orderStatus, riderStatus) => {
    if (riderStatus === 'delivered') return 4;
    if (riderStatus === 'on_way')    return 3;
    if (orderStatus === 'ready')     return 2;
    if (['kitchen_received','cooking'].includes(orderStatus)) return 1;
    return 0;
  };

  const [active, setActive] = useState(0);

  // Rating state
  const [ratingStars, setRatingStars]   = useState(0);
  const [ratingHover, setRatingHover]   = useState(0);
  const [ratingComment, setRatingComment] = useState('');
  const [ratingReasons, setRatingReasons] = useState([]);
  const [ratingSent, setRatingSent]     = useState(false);
  const [ratingSubmitting, setRatingSubmitting] = useState(false);

  const RATING_REASONS = ['Comida', 'Delivery', 'Tiempo de entrega', 'Precio', 'Atención'];
  const toggleReason = (r) => setRatingReasons(prev => prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r]);

  const isDelivered = active === STEPS.length - 1;

  const handleRatingSubmit = async () => {
    if (!ratingStars) return;
    setRatingSubmitting(true);
    const fullComment = [ratingReasons.length ? `[${ratingReasons.join(', ')}]` : '', ratingComment].filter(Boolean).join(' — ');
    await dbSubmitRating(order?.id || null, ratingStars, fullComment || null);
    setRatingSent(true);
    setRatingSubmitting(false);
  };

  useEffect(() => {
    if (!db || !order?.order_number) {
      const t = setInterval(() => setActive(a => a < STEPS.length - 1 ? a + 1 : a), 4000);
      return () => clearInterval(t);
    }

    // ETAPA 2 (seguridad): sin realtime sobre orders/delivery_orders (sus payloads
    // exponían total/order_total/delivery_fee cross-tenant, ignorando los grants de
    // columna). Seguimiento por POLLING de get_order_status (status + rider_status).
    let poll = null;

    const fetchStatus = async () => {
      try {
        const row = await dbGetOrderStatus(order.order_number);
        if (!row) {
          // El pedido ya no existe (reset/limpieza): purgar localStorage y volver al inicio.
          ['dc_order','dc_order_type','dc_customer','dc_zone'].forEach(k => localStorage.removeItem(k));
          if (typeof onNewOrder === 'function') onNewOrder();
          return;
        }
        if (!isDelivery) { setActive(STATUS_MAP_PICKUP[row.status] ?? 0); return; }
        setActive(calcDeliveryStep(row.status, row.rider_status));
      } catch(e) {}
    };

    fetchStatus();
    poll = setInterval(fetchStatus, 8000);

    const onVisible = () => { if (document.visibilityState === 'visible') fetchStatus(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [order?.order_number]);

  return (
    <div style={{ minHeight: '100%', background: T.trackBg, display: 'flex', flexDirection: 'column' }}>
      {/* Header con número de pedido */}
      <div style={{ background: T.black, padding: '52px 24px 28px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <div style={{ width: 42, height: 42, borderRadius: '50%', background: '#22C55E', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="check" size={22} color="#fff" sw={2.5} />
          </div>
          <div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', marginBottom: 2 }}>Pedido confirmado</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: '#fff', fontFamily: "'SF Mono',ui-monospace,monospace,monospace" }}>{orderNum}</div>
          </div>
        </div>
        {/* Info cliente */}
        <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 12, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {isDelivery && customerData?.address && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <Icon name="location" size={13} color="rgba(255,255,255,0.4)" />
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5 }}>{customerData.address}{customerData.detail ? `, ${customerData.detail}` : ''}</span>
            </div>
          )}
          {isDelivery && deliveryResult?.minutes && (
            <div style={{ display: 'flex', gap: 8 }}>
              <Icon name="clock" size={13} color="rgba(255,255,255,0.4)" />
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>Estimado: ~{deliveryResult.minutes} min</span>
            </div>
          )}
          {!isDelivery && customerData?.phone && (
            <div style={{ display: 'flex', gap: 8 }}>
              <Icon name="phone" size={13} color="rgba(255,255,255,0.4)" />
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>Te avisamos al {customerData.phone} cuando esté listo</span>
            </div>
          )}
        </div>
      </div>

      {/* Barra de progreso visual */}
      <div style={{ background: T.white, padding: '20px', flexShrink: 0, borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative' }}>
          {/* Línea de fondo */}
          <div style={{ position: 'absolute', top: 14, left: '10%', right: '10%', height: 2, background: T.border, zIndex: 0 }} />
          {/* Línea de progreso */}
          <div style={{ position: 'absolute', top: 14, left: '10%', height: 2, background: T.black, zIndex: 1, width: `${(active / (STEPS.length - 1)) * 80}%`, transition: 'width 600ms ease' }} />
          {STEPS.map((s, i) => {
            const done = i < active, cur = i === active;
            return (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', zIndex: 2, flex: 1 }}>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: done || cur ? T.black : T.white, border: `2px solid ${done || cur ? T.black : T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 6, transition: 'all 400ms' }}>
                  {done && <Icon name="check" size={13} color="#fff" sw={3} />}
                  {cur && <div style={{ width: 10, height: 10, borderRadius: '50%', background: T.white, animation: 'pulse 1.4s ease infinite' }} />}
                </div>
                <div style={{ fontSize: 10, fontWeight: 700, color: done || cur ? T.ink : T.silver, textAlign: 'center', lineHeight: 1.3, maxWidth: 60 }}>{s.label}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Timeline detallado */}
      <div style={{ flex: 1, padding: '24px', overflowY: 'auto' }}>
        {STEPS.map((s, i) => {
          const done = i < active, cur = i === active, pend = i > active;
          return (
            <div key={i} style={{ display: 'flex', gap: 16, marginBottom: 4 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ width: 30, height: 30, borderRadius: '50%', background: done || cur ? T.black : 'rgba(0,0,0,0.06)', border: `2px solid ${done || cur ? T.black : T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 400ms' }}>
                  {done && <Icon name="check" size={14} color="#fff" sw={3} />}
                  {cur && <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#fff', animation: 'pulse 1.4s ease infinite' }} />}
                </div>
                {i < STEPS.length - 1 && <div style={{ width: 1, flex: 1, minHeight: 36, background: done ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.08)', margin: '4px 0', transition: 'background 600ms' }} />}
              </div>
              <div style={{ paddingBottom: 28, flex: 1, paddingTop: 4 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: pend ? T.silver : T.ink, transition: 'color 400ms' }}>{s.label}</div>
                <div style={{ fontSize: 12, color: pend ? T.border : T.gray, marginTop: 2, transition: 'color 400ms' }}>{s.sub}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer / Rating */}
      {!isDelivered && (
        <div style={{ padding: '12px 24px 40px', borderTop: `1px solid ${T.border}`, background: T.white }}>
          <div style={{ fontSize: 12, color: T.gray, textAlign: 'center', lineHeight: 1.6 }}>
            {isDelivery ? 'El repartidor te contactará si hay algún inconveniente.' : 'Pasá a buscar tu pedido cuando recibas el aviso.'}
          </div>
          <button onClick={onNewOrder}
            style={{ display: 'block', margin: '14px auto 0', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: T.gray, textDecoration: 'underline', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", padding: '4px 8px' }}>
            Hacer un nuevo pedido
          </button>
        </div>
      )}

      {isDelivered && !ratingSent && (
        <div style={{ padding: '24px 24px 40px', borderTop: `2px solid ${T.border}`, background: T.white }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: T.ink, marginBottom: 4 }}>¿Cómo estuvo tu pedido?</div>
          <div style={{ fontSize: 13, color: T.gray, marginBottom: 20 }}>{restaurant?.name || 'Restaurante'} · {isDelivery ? 'Delivery' : 'Retiro en local'}</div>

          {/* Estrellas */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
            {[1,2,3,4,5].map(s => (
              <button key={s}
                onMouseEnter={() => setRatingHover(s)} onMouseLeave={() => setRatingHover(0)}
                onClick={() => setRatingStars(s)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, transition: 'transform 150ms', transform: (ratingHover || ratingStars) >= s ? 'scale(1.12)' : 'scale(1)' }}>
                <svg width="38" height="38" viewBox="0 0 24 24"
                  fill={(ratingHover || ratingStars) >= s ? '#FBBF24' : 'transparent'}
                  stroke={(ratingHover || ratingStars) >= s ? '#FBBF24' : '#D1D5DB'}
                  strokeWidth="1.5">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              </button>
            ))}
          </div>

          {ratingStars > 0 && ratingStars <= 3 && (
            <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 12, color: '#B91C1C', lineHeight: 1.5 }}>
              Lamentamos que no haya sido lo esperado. Contanos qué mejorar.
            </div>
          )}
          {ratingStars >= 4 && (
            <div style={{ background: 'rgba(22,163,74,0.08)', border: '1px solid rgba(22,163,74,0.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 12, color: '#15803D', fontWeight: 600, lineHeight: 1.5 }}>
              ¡Nos alegra que hayas disfrutado!
            </div>
          )}

          {/* Chips de razones */}
          {ratingStars > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.gray, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>¿Qué querés calificar?</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {RATING_REASONS.map(r => {
                  const sel = ratingReasons.includes(r);
                  return (
                    <button key={r} onClick={() => toggleReason(r)}
                      style={{ height: 30, padding: '0 12px', borderRadius: 9999, border: `1.5px solid ${sel ? T.ink : T.border}`, background: sel ? T.ink : 'transparent', color: sel ? T.white : T.gray, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", transition: 'all 150ms' }}>
                      {r}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Comentario */}
          <textarea value={ratingComment} onChange={e => setRatingComment(e.target.value)}
            placeholder={ratingStars > 0 && ratingStars <= 3 ? '¿Qué salió mal? ¿Cómo podemos mejorar?' : '¿Qué fue lo mejor? ¿Algo para mejorar?'}
            style={{ width: '100%', minHeight: 80, border: `1px solid ${T.border}`, borderRadius: 12, padding: '10px 12px', fontSize: 13, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: T.ink, background: '#F9FAFB', resize: 'none', outline: 'none', marginBottom: 14, boxSizing: 'border-box' }} />

          <button onClick={handleRatingSubmit} disabled={!ratingStars || ratingSubmitting}
            style={{ width: '100%', height: 52, background: ratingStars ? T.black : 'rgba(0,0,0,0.08)', color: ratingStars ? T.white : 'rgba(0,0,0,0.25)', border: 'none', borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 16, fontWeight: 800, cursor: ratingStars ? 'pointer' : 'default', transition: 'all 250ms', opacity: ratingSubmitting ? 0.7 : 1 }}>
            {ratingSubmitting ? 'Enviando…' : 'Enviar calificación'}
          </button>
        </div>
      )}

      {isDelivered && ratingSent && (
        <div style={{ padding: '32px 24px 48px', borderTop: `2px solid ${T.border}`, background: T.white, textAlign: 'center' }}>
          <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'center' }}><Icon name="star" size={46} color={T.ink} /></div>
          <div style={{ fontSize: 22, fontWeight: 800, color: T.ink, marginBottom: 8 }}>¡Gracias por tu opinión!</div>
          <div style={{ fontSize: 13, color: T.gray, lineHeight: 1.7, marginBottom: 28 }}>Tu calificación nos ayuda<br />a mejorar cada día.</div>
          <button onClick={onNewOrder}
            style={{ width: '100%', height: 52, background: T.black, color: T.white, border: 'none', borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 16, fontWeight: 800, cursor: 'pointer' }}>
            Hacer otro pedido
          </button>
        </div>
      )}
    </div>
  );
}

/* ══ PANTALLA RESERVA ════════════════════ */
function ReservaScreen({ onBack, onDone }) {
  const T = useContext(ThemeCtx);
  const restaurant = useContext(RestaurantCtx);
  const restName = restaurant?.name || 'Restaurante';
  const [form, setForm] = useState({ name: '', phone: '', date: '', time: '', guests: 2, table_id: '', occasion: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(null);
  const [tables, setTables] = useState([]);

  const todayStr = new Date().toISOString().slice(0, 10);

  React.useEffect(() => { dbLoadTables().then(setTables); }, []);

  const handleSubmit = async () => {
    if (!form.name || !form.phone || !form.date || !form.time) return;
    setSaving(true);
    const confirmNum = 'R-' + String(Math.floor(Date.now() % 90000) + 10000);
    await dbSaveReservation({ ...form, restaurant_id: RESTAURANT_ID, confirm_num: confirmNum });
    setSaving(false);
    setDone({ confirmNum, phone: form.phone });
  };

  if (done) return (
    <div style={{ minHeight: '100%', background: T.black, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 28px', textAlign: 'center' }}>
      <div style={{ width: 72, height: 72, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 24 }}><Icon name="check" size={32} color="#fff" sw={2} /></div>
      <div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.heroSz, color: '#fff', marginBottom: 10 }}>¡Reserva enviada!</div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 8 }}>Tu solicitud fue recibida. Te confirmaremos pronto.</div>
      <div style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, padding: '14px 24px', width: '100%', marginBottom: 12, textAlign: 'left' }}>
        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>Nro. de confirmación</div>
        <div style={{ fontFamily: "'SF Mono',ui-monospace,monospace", fontSize: 20, fontWeight: 500, color: '#fff' }}>{done.confirmNum}</div>
      </div>
      <div style={{ background: '#1a1a2e', border: '1px solid #2a2a4a', borderRadius: 10, padding: '12px 16px', width: '100%', marginBottom: 12, textAlign: 'left', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#FF9500" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <div style={{ fontSize: 11, color: '#fbbf24', lineHeight: 1.6 }}>Tolerancia de <strong>15 minutos</strong>. Si no llegás a tiempo, la mesa queda disponible para otros clientes.</div>
      </div>
      <div style={{ background: '#0D1F0D', border: '1px solid #1a3a1a', borderRadius: 10, padding: '12px 16px', width: '100%', marginBottom: 32, textAlign: 'left', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="#34C759" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.12 1.18 2 2 0 012.11 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" /></svg>
        <div style={{ fontSize: 12, color: '#86efac', lineHeight: 1.6 }}>Te confirmaremos tu reserva por WhatsApp al <strong>{done.phone}</strong>.</div>
      </div>
      <button onClick={onDone} style={{ width: '100%', height: 52, background: '#fff', color: '#000', border: 'none', borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 16, fontWeight: 800, cursor: 'pointer' }}>Volver al inicio</button>
    </div>
  );

  const f = (k, v) => setForm(prev => ({ ...prev, [k]: v }));
  const canSubmit = form.name && form.phone && form.date && form.time;
  const inputSt = { width: '100%', height: 44, border: `1.5px solid ${T.border}`, borderRadius: 10, padding: '0 12px', fontSize: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: T.ink, background: T.offwhite, outline: 'none', boxSizing: 'border-box' };

  return (
    <div style={{ minHeight: '100%', background: T.offwhite, display: 'flex', flexDirection: 'column' }}>
      <div style={{ background: T.hdrBg, padding: '52px 20px 20px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
          <button onClick={onBack} style={{ width: 38, height: 38, background: T.light, border: 'none', borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon name="back" size={17} color={T.hdrText} /></button>
          <div>
            <div style={{ fontSize: 11, color: T.hdrSub }}>{restName}</div>
            <div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.titleSz, color: T.hdrText }}>Reservar mesa</div>
          </div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 20px' }}>

        {/* Personas */}
        <div style={{ background: T.white, borderRadius: 14, padding: '18px 16px', marginBottom: 14, border: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 14 }}>¿Para cuántas personas?</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {[1,2,3,4,5,6,7,8].map(n => (
              <button key={n} onClick={() => f('guests', n)} style={{ width: 44, height: 44, borderRadius: 10, border: `2px solid ${form.guests === n ? T.black : T.border}`, background: form.guests === n ? T.black : 'transparent', color: form.guests === n ? T.white : T.mid, fontSize: 15, fontWeight: 800, cursor: 'pointer', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", transition: 'all 150ms' }}>{n}</button>
            ))}
          </div>
        </div>

        {/* Fecha y hora */}
        <div style={{ background: T.white, borderRadius: 14, padding: '18px 16px', marginBottom: 14, border: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 14 }}>Fecha y horario</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: T.gray, display: 'block', marginBottom: 6 }}>Fecha</label>
              <input type="date" value={form.date} min={todayStr} onChange={e => f('date', e.target.value)} style={inputSt} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: T.gray, display: 'block', marginBottom: 6 }}>Hora</label>
              <input type="time" value={form.time} onChange={e => f('time', e.target.value)} style={inputSt} />
            </div>
          </div>
        </div>

        {/* Motivo */}
        <div style={{ background: T.white, borderRadius: 14, padding: '18px 16px', marginBottom: 14, border: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 14 }}>Motivo de la visita <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(opcional)</span></div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {OCCASIONS.map(occ => (
              <button key={occ.id} onClick={() => f('occasion', form.occasion === occ.id ? '' : occ.id)} style={{ padding: '8px 14px', borderRadius: 20, border: `2px solid ${form.occasion === occ.id ? T.black : T.border}`, background: form.occasion === occ.id ? T.black : 'transparent', color: form.occasion === occ.id ? T.white : T.ink, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", transition: 'all 150ms' }}>{occ.label}</button>
            ))}
          </div>
        </div>

        {/* Mesa preferida */}
        {tables.length > 0 && (
          <div style={{ background: T.white, borderRadius: 14, padding: '18px 16px', marginBottom: 14, border: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 14 }}>Preferencia de mesa <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(opcional)</span></div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={() => f('table_id', '')} style={{ padding: '8px 14px', borderRadius: 20, border: `2px solid ${!form.table_id ? T.black : T.border}`, background: !form.table_id ? T.black : 'transparent', color: !form.table_id ? T.white : T.ink, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>Sin preferencia</button>
              {tables.map(t => (
                <button key={t.id} onClick={() => f('table_id', t.id)} style={{ padding: '8px 14px', borderRadius: 20, border: `2px solid ${form.table_id === t.id ? T.black : T.border}`, background: form.table_id === t.id ? T.black : 'transparent', color: form.table_id === t.id ? T.white : T.ink, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>Mesa {t.number}{t.capacity ? ` (${t.capacity}p)` : ''}</button>
              ))}
            </div>
          </div>
        )}

        {/* Datos de contacto */}
        <div style={{ background: T.white, borderRadius: 14, padding: '18px 16px', marginBottom: 14, border: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 14 }}>Datos de contacto</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input value={form.name} onChange={e => f('name', e.target.value)} placeholder="Nombre completo *" style={inputSt} />
            <div style={{ display: 'flex', alignItems: 'center', border: `1.5px solid ${T.border}`, borderRadius: 10, overflow: 'hidden', background: T.offwhite }}>
              <div style={{ padding: '0 12px', height: 44, display: 'flex', alignItems: 'center', borderRight: `1px solid ${T.border}`, flexShrink: 0 }}>
                <Icon name="phone" size={16} color={T.silver} />
              </div>
              <input value={form.phone} onChange={e => f('phone', e.target.value)} placeholder="+595 9XX XXX XXX *" type="tel" style={{ flex: 1, height: 44, border: 'none', padding: '0 14px', fontSize: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: T.ink, background: 'transparent', outline: 'none' }} />
            </div>
            <textarea value={form.notes} onChange={e => f('notes', e.target.value)} placeholder="Comentarios, alergias, pedidos especiales…" rows={3} style={{ border: `1.5px solid ${T.border}`, borderRadius: 10, padding: '12px 14px', fontSize: 13, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: T.ink, background: T.offwhite, outline: 'none', resize: 'none', width: '100%', boxSizing: 'border-box' }} />
          </div>
        </div>

        <div style={{ background: '#1a1200', border: '1px solid #3a2800', borderRadius: 10, padding: '12px 14px', marginBottom: 12, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#FF9500" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <div style={{ fontSize: 11, color: '#fbbf24', lineHeight: 1.7 }}><strong>Tolerancia de 15 minutos.</strong> Si no llegás dentro de los 15 minutos de la hora reservada, la mesa será liberada para otros comensales.</div>
        </div>
        <div style={{ background: '#0D1F0D', border: '1px solid #1a3a1a', borderRadius: 10, padding: '12px 14px', marginBottom: 20, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#34C759" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.12 1.18 2 2 0 012.11 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" /></svg>
          <div style={{ fontSize: 11, color: '#86efac', lineHeight: 1.7 }}>Te confirmaremos la reserva por <strong>WhatsApp</strong> con anticipación. No se requiere seña.</div>
        </div>

        <button onClick={handleSubmit} disabled={!canSubmit || saving} style={{ width: '100%', height: 54, background: canSubmit ? T.btnPrimary : T.light, color: canSubmit ? T.btnPrimaryText : T.silver, border: 'none', borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 16, fontWeight: 800, cursor: canSubmit ? 'pointer' : 'default', marginBottom: 32, transition: 'all 200ms', opacity: saving ? 0.7 : 1 }}>
          {saving ? 'Enviando…' : 'Confirmar reserva'}
        </button>
      </div>
    </div>
  );
}

/* ══ APP ROOT ════════════════════════════ */
/* El panel de delivery NO es genérico: corresponde a un local concreto, abierto
   desde el link que comparte el restaurante (?r=). Sin contexto válido mostramos
   una guía en vez de un menú/local demo con nombre y ubicación random. */
function GateScreen({ kind }) {
  const T = useContext(ThemeCtx);
  const COPY = {
    'no-context': {
      icon: <Icon name="link" size={52} color={T.ink} />,
      title: 'Abrí el delivery desde el local',
      body: 'Este enlace no identifica a ningún restaurante. Abrí el link de delivery que comparte el local para ver su menú y hacer tu pedido.',
    },
    'not-found': {
      icon: <Icon name="store" size={52} color={T.ink} />,
      title: 'Restaurante no disponible',
      body: 'No encontramos este restaurante. Puede que el enlace haya cambiado o que el local todavía no esté activo. Pedí un link actualizado.',
    },
    // WS1-B · El plan del restaurante no incluye el panel delivery-cliente.
    'plan': {
      icon: (
        <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke={T.ink} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>
        </svg>
      ),
      title: 'Delivery no disponible',
      body: 'Este restaurante no tiene pedidos a domicilio habilitados. Si creés que es un error, contactá al local.',
    },
  };
  const c = COPY[kind] || COPY['no-context'];
  return (
    <div style={{ minHeight: '100%', background: T.white, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 32px', textAlign: 'center', gap: 16 }}>
      <div style={{ fontSize: 54, lineHeight: 1 }}>{c.icon}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: T.ink, lineHeight: 1.25 }}>{c.title}</div>
      <div style={{ fontSize: 14, color: T.gray, lineHeight: 1.7, maxWidth: 300 }}>{c.body}</div>
    </div>
  );
}

function App() {
  const theme = makeTheme();

  const [confirmedOrder, setConfirmedOrder] = useState(() => {
    try { const s = localStorage.getItem('dc_order'); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [screen, setScreen] = useState(() => {
    try { return localStorage.getItem('dc_order') ? 'confirm' : 'welcome'; } catch { return 'welcome'; }
  });
  const [orderType, setOrderType] = useState(() => {
    try { return localStorage.getItem('dc_order_type') || 'delivery'; } catch { return 'delivery'; }
  });
  const [deliveryResult, setDeliveryResult] = useState(() => {
    try { const s = localStorage.getItem('dc_zone'); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [customerData, setCustomerData] = useState(() => {
    try { const s = localStorage.getItem('dc_customer'); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [zones, setZones]           = useState([]);
  const [deliverySettings, setDeliverySettings] = useState(null);  // modo de cotización (mig 124)
  const [cartItems, setCartItems]           = useState([]);
  const [selItem, setSelItem]               = useState(null);
  const [toast, setToast]                   = useState(null);
  const [payData, setPayData]               = useState({ subtotal: 0, fee: 0, total: 0 });
  const [restaurant, setRestaurant]         = useState(null);
  const [restaurantStatus, setRestaurantStatus] = useState('loading'); // loading | ready | notfound
  const [liveMenu, setLiveMenu]             = useState(null);
  const [menuStatus, setMenuStatus]         = useState('loading'); // loading | ready | empty
  // WS1-B · Gate por plan (panel público/anónimo). checking | allowed | blocked.
  const [planStatus, setPlanStatus]         = useState('checking');

  useEffect(() => {
    if (!RESTAURANT_ID) { setRestaurantStatus('notfound'); setMenuStatus('empty'); setPlanStatus('blocked'); return; }
    // Sin backend (preview sin env) → fail-closed: no hay plan que confirmar.
    if (!db) { setPlanStatus('blocked'); setRestaurantStatus('notfound'); setMenuStatus('empty'); return; }
    let on = true;
    (async () => {
      // El panel cliente es anónimo → no sirve get_restaurant_capabilities (NULL para anon).
      // Usamos la RPC anon-safe restaurant_panel_enabled (mig 109). Fail-closed: solo
      // cargamos el menú/zonas si el plan incluye 'delivery-cliente'.
      let ok = false;
      try {
        const { data, error } = await db.rpc('restaurant_panel_enabled', { p_restaurant_id: RESTAURANT_ID, p_panel: 'delivery-cliente' });
        ok = (!error && data === true);
      } catch (_) { ok = false; }
      if (!on) return;
      if (!ok) { setPlanStatus('blocked'); return; }   // no carga datos del módulo premium
      setPlanStatus('allowed');
      dbLoadRestaurant().then(r => { if (!on) return; if (r) { setRestaurant(r); setRestaurantStatus('ready'); } else { setRestaurantStatus('notfound'); } });
      dbLoadMenu().then(m => { if (!on) return; if (m) { setLiveMenu(m); setMenuStatus('ready'); } else { setMenuStatus('empty'); } });
      dbLoadDeliveryZones().then(z => { if (on) setZones(z); });
      dbLoadDeliverySettings().then(s => { if (on) setDeliverySettings(s); });
    })();
    return () => { on = false; };
  }, []);

  const showToast = (msg) => setToast(msg);

  const cartCount = cartItems.reduce((s, ci) => s + ci.qty, 0);
  const cartTotal = cartItems.reduce((s, ci) => s + ci.total, 0);
  // Envío gratis por monto (mig 124): se aplica recién acá, donde ya se conoce el
  // subtotal del carrito (la cobertura se cotiza antes de armar el pedido).
  const _freeOver = deliverySettings?.free_over_amount;
  const _rawFee = deliveryResult?.price || 0;
  const deliveryFee = orderType === 'delivery'
    ? ((_freeOver && Number(_freeOver) > 0 && cartTotal >= Number(_freeOver)) ? 0 : _rawFee)
    : 0;

  // Estado abierto/cerrado real + tick de 60s para refrescar al cruzar un borde de horario.
  const [, setOpenTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setOpenTick(t => t + 1), 60000); return () => clearInterval(id); }, []);
  const openState = restaurantOpenState(restaurant);
  const canOrder = openState.open;

  const addToCart = (item, qty, extras, notes) => {
    // Bloqueo de venta con el local CERRADO: se puede ver el menú, pero no pedir.
    if (!canOrder) { showToast(openState.next ? `Cerrado · Abre ${openState.next}. Podés ver el menú, pero no pedir ahora.` : 'El local está cerrado. Podés ver el menú, pero no pedir ahora.'); return; }
    const et = extras.reduce((s, e) => s + e.p, 0);
    setCartItems(prev => [...prev, { item, qty, extras, notes, total: (item.price + et) * qty }]);
    showToast('Agregado al pedido');
  };
  const removeItem = (i) => setCartItems(prev => prev.filter((_, idx) => idx !== i));
  const updateQty  = (i, d) => setCartItems(prev => prev.map((ci, idx) => {
    if (idx !== i) return ci;
    const nq = ci.qty + d;
    if (nq <= 0) return null;
    const et = ci.extras.reduce((s, e) => s + e.p, 0);
    return { ...ci, qty: nq, total: (ci.item.price + et) * nq };
  }).filter(Boolean));

  const handleDelivery = () => { setOrderType('delivery'); setScreen('coverage'); };
  const handlePickup   = () => { setOrderType('pickup');   setScreen('customer'); };
  const handleReserva  = () => { setScreen('reserva'); };
  // Browse: ver el menú en modo solo-lectura (addToCart bloqueado si está cerrado).
  const handleBrowse   = () => { setOrderType('pickup'); setScreen('menu'); };

  const handleCovered  = (result) => { setDeliveryResult(result); setScreen('customer'); };
  const handlePickupFallback = () => { setOrderType('pickup'); setDeliveryResult(null); setScreen('customer'); };

  const handleCustomerNext = (data) => { setCustomerData(data); setScreen('menu'); };

  const handleCheckout = (sub, fee, total) => {
    if (!canOrder) { showToast('El local está cerrado. No se puede pedir ahora.'); return; }
    setPayData({ subtotal: sub, fee, total });
    setScreen('pay');
  };

  const handleConfirmed = (order) => {
    try {
      localStorage.setItem('dc_order',    JSON.stringify(order));
      localStorage.setItem('dc_order_type', orderType);
      if (customerData)   localStorage.setItem('dc_customer', JSON.stringify(customerData));
      if (deliveryResult) localStorage.setItem('dc_zone',     JSON.stringify(deliveryResult));
    } catch {}
    setConfirmedOrder(order);
    setCartItems([]);
    setScreen('confirm');
  };

  const handleNewOrder = () => {
    ['dc_order','dc_order_type','dc_customer','dc_zone'].forEach(k => localStorage.removeItem(k));
    setConfirmedOrder(null);
    setCustomerData(null);
    setDeliveryResult(null);
    setOrderType('delivery');
    setScreen('welcome');
  };

  return (
    <ThemeCtx.Provider value={theme}>
      <MenuCtx.Provider value={liveMenu || {}}>
        <RestaurantCtx.Provider value={restaurant}>
          <div className="phone-wrap">
            <div className="phone" style={{ background: theme.phoneBg }}>
              <div className="screen">
                {!RESTAURANT_ID
                  ? <GateScreen kind="no-context" />
                  : planStatus === 'blocked'
                  ? <GateScreen kind="plan" />
                  : planStatus === 'checking'
                  ? <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: theme.white }}><div style={{ fontSize: 13, color: theme.gray }}>Cargando…</div></div>
                  : restaurantStatus === 'notfound'
                  ? <GateScreen kind="not-found" />
                  : <>
                {toast && <Toast msg={toast} onHide={() => setToast(null)} />}
                {selItem && <ProductModal item={selItem} onClose={() => setSelItem(null)} onAdd={addToCart} canOrder={canOrder} openState={openState} />}

                {screen === 'welcome' && (
                  <WelcomeScreen restaurant={restaurant} onDelivery={handleDelivery} onPickup={handlePickup} onReserva={handleReserva} onBrowse={handleBrowse} openState={openState} />
                )}
                {screen === 'reserva' && (
                  <ReservaScreen onBack={() => setScreen('welcome')} onDone={() => setScreen('welcome')} />
                )}
                {screen === 'coverage' && (
                  <CoverageScreen zones={zones} restaurant={restaurant} settings={deliverySettings} onCovered={handleCovered} onPickupFallback={handlePickupFallback} onManual={() => {}} onBack={() => setScreen('welcome')} />
                )}
                {screen === 'customer' && (
                  <CustomerDataScreen orderType={orderType} deliveryResult={deliveryResult} onNext={handleCustomerNext} onBack={() => setScreen(orderType === 'delivery' ? 'coverage' : 'welcome')} />
                )}
                {screen === 'menu' && (
                  <MenuScreen onItemSelect={setSelItem} cartTotal={cartTotal} cartCount={cartCount} onViewCart={() => setScreen('cart')} orderType={orderType} menuStatus={menuStatus} canOrder={canOrder} openState={openState} />
                )}
                {screen === 'cart' && (
                  <CartScreen items={cartItems} orderType={orderType} deliveryFee={deliveryFee} deliveryResult={deliveryResult} onBack={() => setScreen('menu')} onCheckout={handleCheckout} onRemove={removeItem} onQty={updateQty} canOrder={canOrder} openState={openState} />
                )}
                {screen === 'pay' && (
                  <PayScreen orderType={orderType} subtotal={payData.subtotal} deliveryFee={payData.fee} total={payData.total} customerData={customerData} deliveryResult={deliveryResult} cartItems={cartItems} onBack={() => setScreen('cart')} onConfirmed={handleConfirmed} canOrder={canOrder} openState={openState} />
                )}
                {screen === 'confirm' && (
                  <ConfirmScreen order={confirmedOrder} orderType={orderType} customerData={customerData} deliveryResult={deliveryResult} deliveryFee={deliveryFee} onNewOrder={handleNewOrder} />
                )}
                </>}
              </div>
            </div>
          </div>
        </RestaurantCtx.Provider>
      </MenuCtx.Provider>
    </ThemeCtx.Provider>
  );
}

const root = createRoot(document.getElementById('app'));
root.render(<App />);
