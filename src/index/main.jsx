// ════════════════════════════════════════════════════════════════════
// PR-5 — Panel index precompilado con Vite (batch de migración legacy).
// Migrado 1:1 desde el <script type="text/babel"> inline de public/index.html.
// Sin cambios de comportamiento ni de UI. React/createRoot vienen de npm
// (bundle Vite); el resto de globales del shell siguen en window.* (config.js,
// supabase UMD, MythosTheme/Icons/Presence/Session/Gating, XLSX, Leaflet, etc.).
// ════════════════════════════════════════════════════════════════════
import React from "react";
import { createRoot } from "react-dom/client";
import { useTweaks, TweaksPanel, TweakSection, TweakRow, TweakSlider, TweakToggle, TweakRadio, TweakSelect, TweakText, TweakNumber, TweakColor, TweakButton } from "./tweaks-panel.jsx";
// FASE D2 — el cliente sube la foto del comprobante al transferir (mig 183).
import { uploadComprobante } from "../shared/comprobante.jsx";
// CRM (mig 196) — el comensal deja sus datos y queda con ficha en el local.
// La escritura pasa por RPC (`upsert_customer_self`): anon NO toca la tabla.
import { customerPayload, upsertSelf } from "../shared/clientes.js";

const { useState, useEffect, useRef, createContext, useContext, useCallback } = React;

/* ── SUPABASE CLIENT ─────────────────────── */
const _initDB = () => {
  const cfg = window.SUPABASE_CONFIG;
  if (!cfg || !cfg.url || !cfg.anonKey) return null;
  const url = cfg.url.replace(/^﻿/, '').trim();
  const key = cfg.anonKey.replace(/^﻿/, '').trim();
  if (!url || url.includes('YOUR_') || !key) return null;
  // Panel cliente PÚBLICO: nunca heredar la sesión de staff (admin/mozo/caja) que
  // pudiera estar persistida en localStorage del mismo navegador. Sin esto, el pedido
  // del cliente corre como ese usuario autenticado y RLS lo rechaza si el restaurant_id
  // no coincide. Forzamos cliente anónimo (persistSession:false → storage en memoria).
  try {
    return window.supabase.createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: 'mythos-anon-cliente' }
    });
  } catch(e) { return null; }
};
const db = _initDB();
const _urlParams = new URLSearchParams(window.location.search);
// Restaurante: prioridad al parámetro URL (QR / link de admin) → multi-restaurante.
// Fallback a config.js sólo para el deploy demo de un solo local.
const _ridParam = (_urlParams.get('r') || _urlParams.get('rest') || _urlParams.get('restaurant') || '').replace(/^﻿/, '').trim();
const RESTAURANT_ID = (_ridParam || (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.restaurantId) || '').replace(/^﻿/, '').trim();
// Carrito/checkout aislado por restaurante: si el mismo navegador escanea el QR de
// dos locales, cada uno tiene su propio carrito. Sentinel '_nolocal_' sin ?r=.
const lsk = name => (RESTAURANT_ID || '_nolocal_') + ':' + name;
let TABLE_NUM = parseInt(_urlParams.get('mesa') || '0', 10);
const TABLE_TOKEN = _urlParams.get('t') || _urlParams.get('token') || null;
// Modo MOSTRADOR (QR de caja): sin mesa asignada. El QR de mesa SIEMPRE trae
// ?t=<token> o ?mesa=N; su ausencia ⇒ pedido en el mostrador, donde el cliente
// elige "comer en el local" o "para llevar". Mismo panel que el de mesa, pero
// sin número de mesa ni llamada al mozo. No confundir uno con otro.
const IS_COUNTER = !TABLE_TOKEN && !TABLE_NUM;
const tableLabel = () => TABLE_NUM ? `Mesa ${TABLE_NUM}` : 'Mostrador';
// PR-1B: un pedido "para llevar" no ocupa ni se asocia a una mesa, aunque se
// entre por el QR de una mesa. La etiqueta de servicio lo refleja en la UI del
// cliente (la persistencia table_id=null ya la hace PayScreen — PR-1A).
const serviceLabel = (orderMode) => orderMode === 'take' ? 'Para llevar' : tableLabel();

/* ── SUPABASE HELPERS ────────────────────── */
async function dbLoadMenu() {
  if (!db) return null;
  try {
    const { data: cats } = await db.from('menu_categories').select('id,name,sort_order').eq('restaurant_id', RESTAURANT_ID).order('sort_order');
    const { data: items } = await db.from('menu_items').select('id,category_id,name,description,price_guarani,discount_pct,promo_tag,promo_type,dine_in_only,allows_half_and_half,half_and_half_rule,half_and_half_fixed_price,image_url,menu_item_extras(id,name,price_guarani,is_active),menu_item_variants(id,name,price_guarani,sort_order,is_default,is_active)').eq('restaurant_id', RESTAURANT_ID).eq('is_available', true).order('sort_order');
    if (!cats || !items) return null;
    const menu = {};
    for (const cat of cats) {
      menu[cat.name] = items.filter(i => i.category_id === cat.id).map(i => ({
        id: i.id, name: i.name, desc: i.description, price: i.price_guarani,
        discount_pct: i.discount_pct || 0,
        promo: i.promo_tag ? { tag: i.promo_tag } : null,
        promo_type: i.promo_type || null,
        dine_in_only: i.dine_in_only || false,
        allows_half_and_half: i.allows_half_and_half || false,
        half_and_half_rule: i.half_and_half_rule || null,
        half_and_half_fixed_price: i.half_and_half_fixed_price || null,
        extras: (i.menu_item_extras || []).filter(e => e.is_active !== false).map(e => ({ n: e.name, p: e.price_guarani })),
        variants: (i.menu_item_variants || []).filter(v => v.is_active !== false).sort((a, b) => a.sort_order - b.sort_order).map(v => ({ id: v.id, name: v.name, price: v.price_guarani, is_default: v.is_default })),
        image_url: i.image_url || null,
        category: cat.name
      }));
    }
    return Object.keys(menu).length > 0 ? menu : null;
  } catch(e) { console.warn('Supabase menu load failed, using static data'); return null; }
}

async function dbValidateCoupon(code) {
  // Sin cupones demo: un cupón sólo es válido si existe de verdad para ESTE restaurante.
  if (!db) return null;
  try {
    const { data } = await db.from('coupons').select('*').eq('restaurant_id', RESTAURANT_ID).eq('code', code.toUpperCase()).eq('is_active', true).maybeSingle();
    if (!data) return null;
    // `valid_until` y `max_uses` estaban en la tabla desde la mig 001 y NADIE los
    // miraba: un cupón vencido o agotado se seguía aceptando. Con los cupones
    // personales de las promos automáticas (mig 197) eso deja de ser un descuido
    // y pasa a ser plata: un código de un solo uso que circula por WhatsApp.
    // El conteo lo lleva la base (trigger consume_coupon_on_order); acá se
    // rechaza antes de que el comensal vea un descuento que no le corresponde.
    if (data.valid_until && new Date(data.valid_until) < new Date()) return null;
    if (data.max_uses != null && (data.used_count || 0) >= data.max_uses) return null;
    return data;
  } catch(e) { return null; }
}

// Nombre snapshot de la línea: "1/2 A + 1/2 B" para mitad-y-mitad (1/2 en vez de
// ½ por compatibilidad con impresoras 80mm), + "(Tamaño)" si tiene variante.
function lineItemName(ci) {
  const base = ci.half ? `1/2 ${ci.item.name} + 1/2 ${ci.half.secondName}` : ci.item.name;
  return ci.variant ? `${base} (${ci.variant.name})` : base;
}

async function dbSubmitOrder({ tableId, orderType, items, subtotal, discountAmount, couponCode, total, payMethod, custName, custRuc, custEmail, requiresInvoice, invoiceDeliveryMethod, language, facturaSolicitada, facturaRazonSocial, facturaRucCi, facturaEmail, facturaFormato, paymentProofPath, paymentReference, customer }) {
  if (!items || items.length === 0) throw new Error('El carrito está vacío');
  if (!RESTAURANT_ID) throw new Error('No se identificó el restaurante. Escaneá el QR de tu mesa o abrí el link con ?r=<restaurante>.');
  const safeTotal = total > 0 ? total : items.reduce((s, ci) => s + (ci.total || 0), 0);
  if (safeTotal <= 0) throw new Error('El total del pedido es inválido (₲0)');
  total = safeTotal;
  subtotal = subtotal > 0 ? subtotal : safeTotal;
  const orderNum = 'T-' + String(Math.floor(Date.now() % 90000) + 10000);
  if (!db) return { id: null, order_number: orderNum };

  // FASE D2 (mig 183): adjuntar la foto del comprobante al pedido recién creado.
  // Best-effort: si la RPC/mig no está, el pedido igual se crea (solo no queda la foto).
  const _attachProof = async (oid) => {
    if (!oid || !paymentProofPath) return;
    try { await db.rpc('attach_payment_proof', { p_order_id: oid, p_url: paymentProofPath, p_reference: paymentReference || null }); } catch (_) {}
  };

  // Camino A del comensal (mig 200): si esta persona tiene sesión en la app
  // /clientes, su navegador guardó un token de dispositivo. Con él, el pedido
  // queda vinculado a su perfil y acredita la experiencia.
  //
  // Va por RPC DESPUÉS de crear el pedido, y no como parte de create_order,
  // por dos motivos: (1) este panel corre como `anon` a propósito y no se le
  // puede pasar la sesión de comensal —la policy mi_auth_select de menu_items
  // exige get_my_restaurant_id(), que para alguien sin fila en user_roles es
  // NULL, así que el menú saldría vacío—; (2) copiar el cuerpo de create_order
  // acá para agregarle un parámetro es la forma más fácil de pisar una versión
  // nueva con una vieja.
  // Best-effort absoluto: si falla, el pedido ya entró y sólo se pierde el XP.
  const _claimDiner = async (oid) => {
    if (!oid) return;
    let tok = '';
    try { tok = localStorage.getItem('mythos_diner_token') || ''; } catch (_) { return; }
    if (!tok) return;
    try { await db.rpc('diner_claim_my_order', { p_token: tok, p_order: oid }); } catch (_) {}
  };

  // ETAPA 2 (seguridad): crear el pedido por la RPC SECURITY DEFINER 'create_order'.
  // Es el único camino una vez aplicado el lockdown (ETAPA 3). Si la RPC todavía no
  // existe (ETAPA 1 sin aplicar), caemos al insert directo de abajo (compat).
  const rpcPayload = {
    restaurant_id: RESTAURANT_ID, table_id: tableId || null, order_number: orderNum,
    order_type: orderType, status: 'paid', subtotal, discount_amount: discountAmount || 0,
    coupon_code: couponCode || null, total, payment_method: payMethod,
    customer_name: custName || null, customer_ruc: custRuc || null, customer_email: custEmail || null,
    requires_invoice: requiresInvoice || false,
    invoice_delivery_method: requiresInvoice ? (invoiceDeliveryMethod || (custEmail ? 'email' : 'print')) : null,
    // PR-FE-4: campos fiscales (opcionales; el RPC create_order los acepta con default null).
    factura_solicitada: facturaSolicitada || false,
    factura_razon_social: facturaRazonSocial || null,
    factura_ruc_ci: facturaRucCi || null,
    factura_email: facturaEmail || null,
    factura_formato: facturaFormato || null,
    language,
    // CRM (mig 196): la RPC hace el upsert de la ficha y deja el pedido vinculado
    // en la MISMA transacción. Si el bloque no viene, se comporta como siempre.
    ...(customer ? { customer } : {}),
    items: items.map(ci => ({
      item_id: ci.item.id || null,
      item_name: lineItemName(ci),
      quantity: ci.qty,
      unit_price: ci.unitPrice != null ? ci.unitPrice : ci.item.price,
      total_price: ci.total, observations: ci.notes || null,
      extras: (ci.extras || []).map(e => ({ extra_name: e.n, extra_price: e.p })),
    })),
  };
  {
    const { data: rpcData, error: rpcErr } = await db.rpc('create_order', { payload: rpcPayload });
    if (!rpcErr && rpcData && rpcData.id) { await _attachProof(rpcData.id); await _claimDiner(rpcData.id); return rpcData; }
    const missing = rpcErr && /PGRST202|could not find the function|42883/i.test(`${rpcErr.message || ''} ${rpcErr.code || ''}`);
    if (rpcErr && !missing) { console.error('create_order RPC error:', rpcErr); throw new Error(rpcErr.message || 'No se pudo crear el pedido'); }
    // missing → insert directo (compat pre-ETAPA 1).
  }

  const baseInsert = {
    restaurant_id: RESTAURANT_ID, table_id: tableId || null, order_number: orderNum,
    order_type: orderType, status: 'paid', subtotal, discount_amount: discountAmount || 0,
    coupon_code: couponCode || null, total, payment_method: payMethod,
    customer_name: custName || null, customer_ruc: custRuc || null,
    customer_email: custEmail || null, requires_invoice: requiresInvoice || false, language
  };
  const invoiceExtras = requiresInvoice ? {
    invoice_delivery_method: invoiceDeliveryMethod || (custEmail ? 'email' : 'print'),
    invoice_requested_at: new Date().toISOString(),
    invoice_status: 'pending',
  } : {};
  // CRM en el camino de compatibilidad (bases sin la RPC create_order): la ficha
  // se crea igual por RPC —anon nunca escribe la tabla— y el id viaja como una
  // columna opcional más, para que el reintento recortado de abajo la descarte
  // sola si la mig 196 todavía no está aplicada.
  let crmExtras = {};
  if (customer) {
    const cid = await upsertSelf(db, RESTAURANT_ID, customer, customer.source || 'qr');
    if (cid) crmExtras = { customer_id: cid };
  }
  let { data: order, error: orderErr } = await db.from('orders').insert({ ...baseInsert, ...invoiceExtras, ...crmExtras }).select('id,order_number,status').single();
  // El reintento recortado es SÓLO para bases donde la mig 085 todavía no está
  // aplicada (columna inexistente). Antes se reintentaba ante CUALQUIER error, y un
  // fallo transitorio de red podía crear un pedido DUPLICADO (si el primer INSERT sí
  // había entrado del lado del servidor) o uno sin los datos de facturación.
  if (orderErr && /PGRST204|42703|schema cache|column .* does not exist/i
        .test(`${orderErr.message || ''} ${orderErr.code || ''} ${orderErr.details || ''}`)) {
    const r = await db.from('orders').insert(baseInsert).select('id,order_number,status').single();
    order = r.data; orderErr = r.error;
  }
  if (orderErr || !order) {
    console.error('Order insert error:', orderErr);
    throw new Error(orderErr?.message || 'No se pudo crear el pedido');
  }
  for (const ci of items) {
    const { data: oi, error: itemErr } = await db.from('order_items').insert({
      order_id: order.id, item_id: ci.item.id || null,
      item_name: lineItemName(ci),
      quantity: ci.qty, unit_price: ci.unitPrice != null ? ci.unitPrice : ci.item.price, total_price: ci.total,
      observations: ci.notes || null
    }).select('id').single(); // RETURNING solo 'id' (no *): habilita revocar el SELECT de precios a anon (mig 130). El cliente solo usa oi.id.
    if (itemErr) console.error('order_items insert error:', itemErr);
    if (oi && ci.extras && ci.extras.length > 0) {
      const { error: extErr } = await db.from('order_item_extras').insert(ci.extras.map(e => ({ order_item_id: oi.id, extra_name: e.n, extra_price: e.p })));
      if (extErr) console.error('order_item_extras insert error:', extErr);
    }
  }
  await db.from('order_status_history').insert({ order_id: order.id, status: 'paid', changed_by: 'customer' });
  await _attachProof(order.id);
  await _claimDiner(order.id);
  return order;
}

async function dbLoadRestaurant() {
  if (!db) return null;
  try {
    const { data, error } = await db.from('restaurants')
      .select('id,name,address,phone,instagram,website,logo_initials,cover_style,timezone,is_active,created_at,updated_at,status,country,city,cover_image_url,logo_url,currency,maintenance_mode,maintenance_message,lat,lng,reservation_window_hours,reservation_alert_minutes,opening_hours,is_open,auto_provisioned,parent_company_id,half_and_half_rule,half_and_half_fixed_price')
      .eq('id', RESTAURANT_ID).maybeSingle();
    if (error || !data) return null;
    // Horario estructurado (mig 125) — best-effort: si la columna aún no existe,
    // se ignora y el cliente degrada a ABIERTO (no rompe la carga del restaurante).
    try {
      const bh = await db.from('restaurants').select('business_hours,open_override').eq('id', RESTAURANT_ID).maybeSingle();
      if (bh && !bh.error && bh.data) { data.business_hours = bh.data.business_hours; data.open_override = bh.data.open_override; }
    } catch (_) {}
    // Modo de operación (mig 173) — best-effort: si la columna aún no existe, se
    // ignora y el cliente degrada a 'salon' (Menú QR visible, sin cambios).
    try {
      const sm = await db.from('restaurants').select('service_mode').eq('id', RESTAURANT_ID).maybeSingle();
      if (sm && !sm.error && sm.data) data.service_mode = sm.data.service_mode;
    } catch (_) {}
    // Métodos de pago habilitados (mig 181) + datos de transferencia del comercio (mig 180)
    // — best-effort: si las columnas / el GRANT anon no están, se ignora y el cliente
    // degrada a "todos los métodos, sin datos de transferencia" (no rompe la carga).
    try {
      const pm = await db.from('restaurants')
        .select('payment_methods,bank_holder,bank_name,bank_account,bank_alias,bank_doc,bank_qr_url')
        .eq('id', RESTAURANT_ID).maybeSingle();
      if (pm && !pm.error && pm.data) Object.assign(data, pm.data);
    } catch (_) {}
    return data;
  } catch(e) { return null; }
}

// La reserva vive en la tabla `reservations` (migración 040) — es lo único que ve
// el restaurante. Si el INSERT falla, esto devuelve ok:false y el que llama DEBE
// mostrar el error: antes se caía a un "fallback" de localStorage y se devolvía
// ok:true igual, así que el comensal recibía un número de confirmación por una
// reserva que NADIE recibió (ese localStorage no lo lee ningún panel). Se prefiere
// avisar "no pudimos tomar la reserva" antes que confirmar una reserva fantasma.
async function dbSaveReservation(res) {
  if (!db) return { ok: false, error: 'Sin conexión con el servidor.' };
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
      preferred_zone:   res.preferred_zone || null,
      occasion:         res.occasion || null,
      notes:            res.notes || null,
      status:           'pending',
    });
    if (error) return { ok: false, error: error.message || 'No se pudo guardar la reserva.' };
    return { ok: true };
  } catch(e) {
    return { ok: false, error: (e && e.message) || 'No se pudo guardar la reserva.' };
  }
}

async function dbLoadTables() {
  if (!db) return [];
  try {
    const { data } = await db.from('tables').select('id,number,capacity,zona')
      .eq('restaurant_id', RESTAURANT_ID).order('number');
    return data || [];
  } catch(e) { return []; }
}

// UUID de la mesa actual (cargado al inicio desde Supabase)
let _tableUUID = null;
async function _initTableUUID() {
  if (!db || _tableUUID) return;
  try {
    let q = db.from('tables').select('id,number').eq('restaurant_id', RESTAURANT_ID);
    if (TABLE_TOKEN) q = q.eq('qr_token', TABLE_TOKEN);
    else             q = q.eq('number', TABLE_NUM);
    const { data } = await q.maybeSingle();
    if (data) {
      _tableUUID = data.id;
      if (TABLE_TOKEN && data.number) TABLE_NUM = data.number;
    }
  } catch(e) {}
}
_initTableUUID();

async function dbLoadTableAssignment() {
  if (!db) return null;
  try {
    let q = db.from('tables').select('assigned_waiter_name').eq('restaurant_id', RESTAURANT_ID);
    if (TABLE_TOKEN) q = q.eq('qr_token', TABLE_TOKEN);
    else if (TABLE_NUM) q = q.eq('number', TABLE_NUM);
    else return null;
    const { data } = await q.maybeSingle();
    return data?.assigned_waiter_name || null;
  } catch(e) { return null; }
}

async function dbCallWaiter(tableId, orderId) {
  if (!db) return;
  // Usar el UUID de mesa real si está disponible
  const tid = tableId || _tableUUID || null;
  try { await db.from('waiter_calls').insert({ restaurant_id: RESTAURANT_ID, table_id: tid, order_id: orderId || null, status: 'pending' }); } catch(e) {}
}

async function dbSubmitRating(orderId, tableId, stars, comment) {
  if (!db) return;
  try { await db.from('ratings').insert({ restaurant_id: RESTAURANT_ID, order_id: orderId || null, table_id: tableId || null, stars, comment: comment || null }); } catch(e) {}
}

/* ── TWEAK DEFAULTS ─────────────────────── */
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "mood": "blanco",
  "tipo": "grotesca",
  "carta": "clasica"
} /*EDITMODE-END*/;

/* ── THEME ENGINE ───────────────────────── */
const ThemeCtx      = createContext({});
const MenuCtx       = createContext(null);
const RestaurantCtx = createContext(null);

function makeTheme(mood, tipo, carta) {
  const palettes = {
    negro: {
      black: '#000000', ink: '#F5F5F7', dark: '#2D2D2D', mid: '#6E6E73',
      gray: '#86868B', silver: '#AAA', border: '#38383A', light: '#2C2C2E',
      offwhite: '#1C1C1E', white: '#FFF',
      hdrBg: '#000000', hdrText: '#FFF', hdrSub: '#86868B', hdrInputBg: 'rgba(255,255,255,0.06)', hdrInputBorder: 'rgba(255,255,255,0.1)', hdrInputText: '#FFF',
      trackBg: '#000000', trackText: '#FFF', trackSub: '#6E6E73', trackLine: 'rgba(255,255,255,0.5)', trackLineDim: 'rgba(255,255,255,0.07)',
      rateBg: '#000000', rateText: '#FFF', rateSub: '#6E6E73', rateInput: 'rgba(255,255,255,0.04)', rateInputBorder: 'rgba(255,255,255,0.08)', rateInputText: '#FFF',
      qrBg: '#000000', qrText: '#FFF', qrSub: '#6E6E73', qrGrid: 'rgba(255,255,255,0.03)', qrCorner: '#FFF',
      btnPrimary: '#FFFFFF', btnPrimaryText: '#000000', phoneBg: '#000000'
    },
    blanco: {
      black: '#000000', ink: '#1D1D1F', dark: '#2D2D2D', mid: '#6E6E73',
      gray: '#86868B', silver: '#BBB', border: '#E8E8E8', light: '#F0F0F0',
      offwhite: '#F8F8F8', white: '#FFF',
      hdrBg: '#FFF', hdrText: '#1D1D1F', hdrSub: '#86868B', hdrInputBg: '#F5F5F5', hdrInputBorder: '#E2E2E2', hdrInputText: '#1D1D1F',
      trackBg: '#F8F8F8', trackText: '#1D1D1F', trackSub: '#86868B', trackLine: 'rgba(0,0,0,0.5)', trackLineDim: 'rgba(0,0,0,0.08)',
      rateBg: '#F8F8F8', rateText: '#1D1D1F', rateSub: '#86868B', rateInput: 'rgba(0,0,0,0.03)', rateInputBorder: '#E8E8E8', rateInputText: '#1D1D1F',
      qrBg: '#FFF', qrText: '#1D1D1F', qrSub: '#86868B', qrGrid: 'rgba(0,0,0,0.03)', qrCorner: '#000000',
      btnPrimary: '#000000', btnPrimaryText: '#FFF', phoneBg: '#F8F8F8'
    },
    sepia: {
      black: '#2C1A10', ink: '#2C1A10', dark: '#3D2418', mid: '#7A5544',
      gray: '#A07060', silver: '#C4A090', border: '#E4CEBA', light: '#F0E2CC',
      offwhite: '#F9F0E2', white: '#FFF9F0',
      hdrBg: '#2C1A10', hdrText: '#FFF9F0', hdrSub: '#7A5544', hdrInputBg: 'rgba(255,249,240,0.06)', hdrInputBorder: 'rgba(255,249,240,0.12)', hdrInputText: '#FFF9F0',
      trackBg: '#2C1A10', trackText: '#FFF9F0', trackSub: '#7A5544', trackLine: 'rgba(255,249,240,0.5)', trackLineDim: 'rgba(255,249,240,0.08)',
      rateBg: '#2C1A10', rateText: '#FFF9F0', rateSub: '#7A5544', rateInput: 'rgba(255,249,240,0.04)', rateInputBorder: 'rgba(255,249,240,0.1)', rateInputText: '#FFF9F0',
      qrBg: '#2C1A10', qrText: '#FFF9F0', qrSub: '#7A5544', qrGrid: 'rgba(255,249,240,0.03)', qrCorner: '#FFF9F0',
      btnPrimary: '#2C1A10', btnPrimaryText: '#FFF9F0', phoneBg: '#F9F0E2'
    }
  };
  const fonts = {
    editorial: { h: "Georgia,'Times New Roman',serif", hW: 400, heroSz: 38, titleSz: 26, priceSz: 23, lCase: 'none', lSpacing: '-0.01em', menuTitleSz: 22 },
    grotesca: { h: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", hW: 800, heroSz: 28, titleSz: 19, priceSz: 17, lCase: 'uppercase', lSpacing: '0.14em', menuTitleSz: 18 },
    clasica: { h: "Georgia,'Times New Roman',serif", hW: 400, heroSz: 34, titleSz: 22, priceSz: 19, lCase: 'uppercase', lSpacing: '0.08em', menuTitleSz: 20 }
  };
  const cards = {
    clasica: { imgSz: 76, imgR: 10, pad: '14px 0', showImg: true },
    amplia: { imgSz: 96, imgR: 14, pad: '20px 0', showImg: true },
    lista: { imgSz: 0, imgR: 0, pad: '11px 0', showImg: false }
  };
  return { ...palettes[mood], F: fonts[tipo] || fonts.editorial, K: cards[carta] || cards.clasica };
}

const fmt = (n) => '₲ ' + Number(n).toLocaleString('es-PY');

/* ── MENU DATA ───────────────────────────
   Sin menú estático/demo: el menú SIEMPRE viene de la base de datos del
   restaurante real (resuelto por ?r= / config). Si está vacío, el panel
   muestra un estado "sin menú" en vez de improvisar platos ficticios que
   podrían terminar como pedidos reales. */

/* ── ICON ────────────────────────────────── */
const Icon = ({ name, size = 20, color = 'currentColor', sw = 1.5, style }) => {
  const paths = {
    back: <path d="M19 12H5M12 5l-7 7 7 7" />,
    search: <><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    minus: <path d="M5 12h14" />,
    x: <path d="M18 6L6 18M6 6l12 12" />,
    check: <path d="M20 6L9 17l-5-5" />,
    clock: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
    bell: <><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" /></>,
    globe: <><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" /></>,
    star: <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />,
    trash: <><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" /></>,
    tag: <><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" /><line x1="7" y1="7" x2="7.01" y2="7" /></>,
    chevdown: <path d="M6 9l6 6 6-6" />,
    map: <><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" /><circle cx="12" cy="10" r="3" /></>,
    phone: <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.12 1.18 2 2 0 012.11 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />,
    card: <><rect x="1" y="4" width="22" height="16" rx="2" /><line x1="1" y1="10" x2="23" y2="10" /></>,
    utensils: <><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 002-2V2" /><path d="M7 2v20" /><path d="M18 2a4 4 0 00-4 4v5c0 1.1.9 2 2 2h4V2z" /><path d="M18 13v9" /></>,
    instagram: <><rect x="2" y="2" width="20" height="20" rx="5" ry="5" /><path d="M16 11.37A4 4 0 1112.63 8 4 4 0 0116 11.37z" /><line x1="17.5" y1="6.5" x2="17.51" y2="6.5" /></>,
    wifi: <><path d="M5 12.55a11 11 0 0114.08 0M1.42 9a16 16 0 0121.16 0M8.53 16.11a6 6 0 016.95 0M12 20h.01" /></>,
    calendar: <><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></>,
    users: <><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" /></>,
    scissors: <><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><line x1="20" y1="4" x2="8.12" y2="15.88" /><line x1="14.47" y1="14.48" x2="20" y2="20" /><line x1="8.12" y1="8.12" x2="12" y2="12" /></>,
    fire: <path d="M12 2c0 0-4.8 5-4.8 9.5a4.8 4.8 0 009.6 0C16.8 7 12 2 12 2zm0 0c0 0 2.5 3 2.5 5.5a2.5 2.5 0 01-5 0C9.5 5 12 2 12 2z" />,
    award: <><circle cx="12" cy="8" r="6" /><path d="M15.477 12.89L17 22l-5-3-5 3 1.523-9.11" /></>,
    img: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></>,
    alert:    <><path d="M10.29 3.86 1.82 18a2 2 0 002.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>,
    mail:     <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M22 7l-10 6L2 7" /></>,
    print:    <><polyline points="6 9 6 2 18 2 18 9" /><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2" /><rect x="6" y="14" width="12" height="8" /></>,
    building: <><rect x="4" y="2" width="16" height="20" rx="2" /><path d="M9 22v-4h6v4M8 6h.01M16 6h.01M8 10h.01M16 10h.01M8 14h.01M16 14h.01" /></>,
    link:     <><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" /></>,
    store:    <><path d="M3 9l1.5-6h15L21 9" /><path d="M3 9v11a2 2 0 002 2h14a2 2 0 002-2V9" /><path d="M3 9h18" /><path d="M9 22V12h6v10" /></>,
    calendarX:<><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /><line x1="14" y1="14" x2="10" y2="18" /><line x1="10" y1="14" x2="14" y2="18" /></>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={style}>{paths[name]}</svg>;
};

/* ── QR CODE SVG ─────────────────────────── */
const QRSvg = ({ size = 200, fgColor = '#FFFFFF' }) => {
  const rows = [[1,1,1,1,1,1,1,0,1,0,1,0,0,0,1,1,1,1,1,1,1],[1,0,0,0,0,0,1,0,0,1,0,1,1,0,1,0,0,0,0,0,1],[1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,1,1,1,0,1],[1,0,1,1,1,0,1,0,0,1,0,1,0,0,1,0,1,1,1,0,1],[1,0,1,1,1,0,1,0,1,0,1,1,1,0,1,0,1,1,1,0,1],[1,0,0,0,0,0,1,0,0,1,0,0,1,0,1,0,0,0,0,0,1],[1,1,1,1,1,1,1,0,1,0,1,0,1,0,1,1,1,1,1,1,1],[0,0,0,0,0,0,0,0,1,1,0,1,0,0,0,0,0,0,0,0,0],[1,0,1,1,0,1,1,1,0,0,1,0,1,1,1,0,1,0,1,1,0],[0,1,0,0,1,1,0,1,1,0,0,1,0,1,0,1,0,1,0,0,1],[1,1,0,1,0,0,1,0,0,1,0,0,1,0,1,0,0,1,1,0,1],[0,0,1,0,1,1,0,1,1,0,1,0,0,1,0,1,1,0,0,1,0],[1,0,0,1,0,0,1,0,1,0,0,1,1,0,0,1,0,0,1,0,1],[0,0,0,0,0,0,0,0,1,0,1,1,0,0,1,0,1,1,0,0,1],[1,1,1,1,1,1,1,0,0,1,0,0,1,0,1,0,0,1,0,1,0],[1,0,0,0,0,0,1,0,1,0,0,1,0,1,0,1,0,0,1,1,0],[1,0,1,1,1,0,1,0,0,1,1,0,1,0,1,1,0,1,0,0,1],[1,0,1,1,1,0,1,1,1,0,0,1,0,1,0,0,1,0,1,1,0],[1,0,1,1,1,0,1,0,0,1,0,0,1,1,0,1,0,1,0,0,1],[1,0,0,0,0,0,1,0,1,0,1,0,0,0,1,0,0,0,1,0,0],[1,1,1,1,1,1,1,0,0,1,0,1,1,0,0,1,1,0,0,1,0]];
  const c = size / 23;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block' }}>
      <rect width={size} height={size} fill="#fff" />
      {rows.map((row, r) => row.map((v, col) => v ? <rect key={`${r}-${col}`} x={col*c+c} y={r*c+c} width={c} height={c} fill={fgColor} /> : null))}
    </svg>
  );
};

/* ── TOAST ───────────────────────────────── */
function Toast({ msg, onHide }) {
  const T = useContext(ThemeCtx);
  useEffect(() => { const t = setTimeout(onHide, 2400); return () => clearTimeout(t); }, []);
  return <div style={{ position: 'fixed', top: 60, left: '50%', transform: 'translateX(-50%)', background: T.ink, color: T.white, borderRadius: 9999, padding: '10px 20px', fontSize: 13, fontWeight: 600, zIndex: 9999, whiteSpace: 'nowrap', boxShadow: '0 8px 32px rgba(0,0,0,0.4)', animation: 'fadeIn 200ms' }}>{msg}</div>;
}

/* ── OFFLINE BANNER ──────────────────────── */
function OfflineBanner() {
  const T = useContext(ThemeCtx);
  const [offline, setOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const on = () => setOffline(false), off = () => setOffline(true);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  if (!offline) return null;
  return <div style={{ position: 'fixed', top: 0, left: '50%', transform: 'translateX(-50%)', width: 390, background: T.ink, color: T.white, textAlign: 'center', fontSize: 12, fontWeight: 600, padding: '8px', zIndex: 9998, letterSpacing: '0.04em' }}>Sin conexión — tu pedido se guardó</div>;
}

/* ══ SCREEN: QR ══════════════════════════ */
function QRScreen({ onScan }) {
  const T = useContext(ThemeCtx);
  const [scanning, setScanning] = useState(false);
  const go = () => { setScanning(true); setTimeout(() => onScan(), 1600); };
  return (
    <div style={{ minHeight: '100%', background: T.qrBg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 32px', position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, backgroundImage: `linear-gradient(${T.qrGrid} 1px,transparent 1px),linear-gradient(90deg,${T.qrGrid} 1px,transparent 1px)`, backgroundSize: '40px 40px' }} />
      <div style={{ zIndex: 1, textAlign: 'center', marginBottom: 52 }}>
        <div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.lCase === 'uppercase' ? 11 : 12, color: T.qrSub, letterSpacing: '0.28em', textTransform: 'uppercase', marginBottom: 12 }}>Comanda · Mesa</div>
        <div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.heroSz, color: T.qrText, lineHeight: 1.1, marginBottom: 10 }}>Escaneá tu mesa</div>
        <div style={{ fontSize: 13, color: T.qrSub, lineHeight: 1.7 }}>Apuntá la cámara al código QR<br />para ver el menú y hacer tu pedido</div>
      </div>
      <div style={{ zIndex: 1, position: 'relative', marginBottom: 48 }}>
        <div style={{ width: 224, height: 224, position: 'relative' }}>
          {[[{ top: 0, left: 0 }, { borderTop: `2px solid ${T.qrCorner}`, borderLeft: `2px solid ${T.qrCorner}` }],[{ top: 0, right: 0 }, { borderTop: `2px solid ${T.qrCorner}`, borderRight: `2px solid ${T.qrCorner}` }],[{ bottom: 0, left: 0 }, { borderBottom: `2px solid ${T.qrCorner}`, borderLeft: `2px solid ${T.qrCorner}` }],[{ bottom: 0, right: 0 }, { borderBottom: `2px solid ${T.qrCorner}`, borderRight: `2px solid ${T.qrCorner}` }]].map(([pos, bdr], i) =>
          <div key={i} style={{ position: 'absolute', ...pos, width: 24, height: 24, ...bdr, zIndex: 2 }} />)}
          <div style={{ margin: 8, borderRadius: 4, overflow: 'hidden', position: 'relative' }}>
            <QRSvg size={208} fgColor={T.black} />
            {scanning && <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ width: 36, height: 36, border: '3px solid rgba(255,255,255,0.15)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
            </div>}
          </div>
          {scanning && <div style={{ position: 'absolute', top: '50%', left: 8, right: 8, height: 1, background: 'rgba(255,255,255,0.6)', boxShadow: '0 0 8px rgba(255,255,255,0.8)', animation: 'blink 0.9s ease infinite' }} />}
        </div>
        <div style={{ textAlign: 'center', marginTop: 10, fontSize: 11, color: T.qrSub, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Mesa {TABLE_NUM} · QR de prueba</div>
      </div>
      <button onClick={go} disabled={scanning} style={{ zIndex: 1, width: '100%', height: 54, background: T.white, color: T.black, border: 'none', borderRadius: 12, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 15, fontWeight: 800, cursor: scanning ? 'default' : 'pointer', opacity: scanning ? .6 : 1, transition: 'opacity 200ms' }}>
        {scanning ? 'Leyendo código…' : 'Simular escaneo'}
      </button>
      <div style={{ marginTop: 12, color: T.qrSub, zIndex: 1, fontSize: "15px" }}>O apuntá tu cámara al QR de arriba</div>
    </div>
  );
}

/* ── ESTADO ABIERTO/CERRADO (horario estructurado + override manual) ─────────
   business_hours: { "0":[{start:"HH:MM",end:"HH:MM"}], … "6":[…] } (0=Dom…6=Sáb).
   open_override: 'auto' | 'open' | 'closed' (override del dueño; gana al horario).
   En 'auto' sin business_hours cargado → CERRADO (coherente con "día sin rangos = cerrado";
   el dueño debe cargar horarios o forzar "Abierto ahora"). Ver punto reportado 2026-07-20.
   Calcula la hora en la zona horaria del local (restaurants.timezone) vía Intl.
   ⚠ Mantener IDÉNTICO a src/delivery-cliente/main.jsx. */
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
  if (!_bhHasHours(bh)) return { open: false, noSchedule: true, next: null };   // 'auto' sin horario cargado → CERRADO (día sin rangos = cerrado; el dueño debe cargar horarios o forzar "Abierto ahora")
  const open = _openNow(bh, dow, min);
  return { open, next: open ? null : _nextOpen(bh, dow, min) };
}
function openBadgeLabel(st) { return st.open ? 'Abierto ahora' : (st.next ? `Cerrado · Abre ${st.next}` : 'Cerrado'); }

/* ══ SCREEN: PERFIL ══════════════════════ */
function ProfileScreen({ onEnter, orderMode, setOrderMode, lang, setLang, onCallWaiter, onReserve, canReserve = true, assignedWaiterName, openState }) {
  const T = useContext(ThemeCtx);
  const restaurant = useContext(RestaurantCtx);
  const [showHours, setShowHours] = useState(false);
  const [showLang, setShowLang] = useState(false);

  const DEFAULT_HOURS = [{ d: 'Lun–Vie', h: '12:00–15:00 · 19:00–23:00' }, { d: 'Sábados', h: '12:00 – 23:30' }, { d: 'Domingos', h: '12:00 – 16:00' }];
  const hours = (restaurant?.opening_hours && Array.isArray(restaurant.opening_hours) && restaurant.opening_hours.length > 0)
    ? restaurant.opening_hours.map(h => ({ d: h.day, h: h.hours }))
    : DEFAULT_HOURS;

  const restName     = restaurant?.name     || 'Restaurante';
  const restAddr     = restaurant?.address  || '';
  const restIg       = restaurant?.instagram || '';
  const restPhone    = restaurant?.phone    || '';
  const restInitials = restaurant?.logo_initials || (restaurant?.name ? restaurant.name.trim().slice(0,2).toUpperCase() : '·');
  const coverUrl     = restaurant?.cover_image_url || null;

  // Estado abierto/cerrado REAL: horario estructurado (business_hours) en la zona
  // horaria del local + override manual. Lo computa el App y lo pasa por prop.
  const st = openState || restaurantOpenState(restaurant);
  const isOpen = st.open;
  const badgeText = openBadgeLabel(st);

  const LANGS = [{ c: 'es', l: 'Español' }, { c: 'en', l: 'English' }, { c: 'pt', l: 'Português' }, { c: 'de', l: 'Deutsch' }];
  const COPY = {
    es: { menu: 'Ver el menú', eat: 'Comer en local', take: 'Para llevar', waiter: 'Llamar al mozo', hours: 'Horarios', reserve: 'Reservar mesa' },
    en: { menu: 'See menu', eat: 'Eat in', take: 'Takeaway', waiter: 'Call waiter', hours: 'Hours', reserve: 'Book a table' },
    pt: { menu: 'Ver cardápio', eat: 'No local', take: 'Para levar', waiter: 'Chamar garçom', hours: 'Horários', reserve: 'Reservar mesa' },
    de: { menu: 'Menü ansehen', eat: 'Vor Ort', take: 'Zum Mitnehmen', waiter: 'Kellner rufen', hours: 'Öffnungszeiten', reserve: 'Tisch reservieren' }
  };
  const tx = COPY[lang] || COPY.es;

  return (
    <div style={{ minHeight: '100%', background: T.offwhite, display: 'flex', flexDirection: 'column' }}>
      {/* ── Cover ── */}
      <div style={{ height: 200, background: T.hdrBg, position: 'relative', flexShrink: 0, overflow: 'hidden' }}>
        {coverUrl
          ? <img src={coverUrl} alt="Portada" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
          : <>
              <div style={{ position: 'absolute', inset: 0, backgroundImage: `radial-gradient(ellipse at 30% 60%,rgba(255,255,255,0.04) 0%,transparent 70%)` }} />
              <div style={{ position: 'absolute', inset: 0, backgroundImage: 'repeating-linear-gradient(45deg,rgba(255,255,255,0.015) 0,rgba(255,255,255,0.015) 1px,transparent 0,transparent 50%)', backgroundSize: '20px 20px' }} />
            </>}
        {/* Gradient overlay para legibilidad */}
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom,rgba(0,0,0,0.1) 0%,rgba(0,0,0,0.55) 100%)' }} />
        {/* Badge mesa */}
        <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 3 }}>
          <div style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(6px)', borderRadius: 20, padding: '5px 11px', fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.85)', letterSpacing: '0.07em' }}>
            {tableLabel()}
          </div>
        </div>
        {/* Badge estado */}
        <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, background: isOpen ? 'rgba(22,163,74,0.88)' : 'rgba(220,38,38,0.82)', backdropFilter: 'blur(6px)', borderRadius: 20, padding: '5px 11px' }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff', animation: isOpen ? 'pulse 2s ease infinite' : 'none' }} />
            <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', letterSpacing: '0.04em' }}>
              {badgeText}
            </span>
          </div>
        </div>
      </div>

      {/* ── Info blanca ── */}
      <div style={{ background: T.white, borderBottom: `1px solid ${T.border}`, position: 'relative' }}>
        {/* Logo superpuesto al borde cover/white */}
        <div style={{ position: 'absolute', top: -40, left: 20, width: 80, height: 80, borderRadius: '50%', background: T.black, border: `3px solid ${T.white}`, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5, boxShadow: '0 4px 20px rgba(0,0,0,0.28)', overflow: 'hidden' }}>
          {restaurant?.logo_url
            ? <img src={restaurant.logo_url} alt="Logo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            /* WS4-B: el círculo del avatar es siempre oscuro (T.black) → iniciales en
               T.white (claro) para que se lean. Antes usaba T.hdrText, que en la
               variante light es casi-negro = ilegible sobre negro. Espeja delivery-cliente. */
            : <div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: 26, color: T.white, lineHeight: 1 }}>{restInitials}</div>}
        </div>

        <div style={{ paddingTop: 50, paddingLeft: 20, paddingRight: 16, paddingBottom: 12 }}>
          {/* Nombre y dirección */}
          <div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.menuTitleSz, color: T.ink, lineHeight: 1.1 }}>{restName}</div>
          {restAddr && <div style={{ fontSize: 11, color: T.gray, marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
            <Icon name="map" size={11} color={T.silver} />{restAddr}
          </div>}

          {/* Botones de acción rápida */}
          <div style={{ display: 'flex', gap: 7, marginTop: 14, flexWrap: 'wrap' }}>
            {restPhone && (
              <a href={`tel:${restPhone.replace(/\s/g,'')}`} style={{ display: 'flex', alignItems: 'center', gap: 5, height: 34, padding: '0 12px', background: T.light, border: `1px solid ${T.border}`, borderRadius: 9999, fontSize: 12, fontWeight: 700, color: T.ink, textDecoration: 'none', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", flexShrink: 0 }}>
                <Icon name="phone" size={12} color={T.ink} />Llamar
              </a>
            )}
            {restIg && (
              <a href={`https://www.instagram.com/${restIg.replace('@','')}`} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 5, height: 34, padding: '0 12px', background: T.light, border: `1px solid ${T.border}`, borderRadius: 9999, fontSize: 12, fontWeight: 700, color: T.ink, textDecoration: 'none', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", flexShrink: 0 }}>
                <Icon name="instagram" size={12} color={T.ink} />{restIg}
              </a>
            )}
            {restAddr && (
              <a href={`https://maps.google.com/?q=${encodeURIComponent(restAddr)}`} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 5, height: 34, padding: '0 12px', background: T.light, border: `1px solid ${T.border}`, borderRadius: 9999, fontSize: 12, fontWeight: 700, color: T.ink, textDecoration: 'none', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", flexShrink: 0 }}>
                <Icon name="map" size={12} color={T.ink} />Cómo llegar
              </a>
            )}
          </div>

          {/* Horarios */}
          <div style={{ marginTop: 14 }}>
            <button onClick={() => setShowHours(v => !v)} style={{ background: 'none', border: `1px solid ${T.border}`, borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 700, color: T.dark, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>
              <Icon name="clock" size={13} color={T.dark} />{tx.hours}
              <span style={{ display: 'inline-block', transform: showHours ? 'rotate(180deg)' : 'none', transition: 'transform 200ms' }}><Icon name="chevdown" size={12} color={T.silver} /></span>
            </button>
            {showHours && <div style={{ background: T.light, borderRadius: 8, padding: '10px 12px', animation: 'fadeIn 200ms', marginTop: 8 }}>
              {hours.map((h, i) => <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: T.mid, marginBottom: i < hours.length - 1 ? 6 : 0 }}><span style={{ fontWeight: 700, color: T.dark }}>{h.d}</span><span>{h.h}</span></div>)}
            </div>}
          </div>
        </div>

        {/* Modo de servicio + Idioma + Mozo */}
        <div style={{ padding: '0 20px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {['eat', 'take'].map(m => <button key={m} onClick={() => setOrderMode(m)} style={{ flex: 1, height: 40, border: `1.5px solid ${orderMode === m ? T.black : T.border}`, borderRadius: 10, background: orderMode === m ? T.black : 'transparent', color: orderMode === m ? T.white : T.mid, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 13, fontWeight: 700, cursor: 'pointer', transition: 'all 150ms' }}>{m === 'eat' ? tx.eat : tx.take}</button>)}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <button onClick={() => setShowLang(v => !v)} style={{ width: '100%', height: 40, border: `1.5px solid ${T.border}`, borderRadius: 10, background: 'transparent', color: T.mid, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <Icon name="globe" size={14} color={T.silver} />{LANGS.find(l => l.c === lang)?.l}<Icon name="chevdown" size={12} color={T.silver} />
              </button>
              {showLang && <div style={{ position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, right: 0, background: T.white, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden', zIndex: 50, boxShadow: '0 8px 32px rgba(0,0,0,0.12)' }}>
                {LANGS.map(l => <div key={l.c} onClick={() => { setLang(l.c); setShowLang(false); }} style={{ padding: '11px 14px', fontSize: 13, fontWeight: 600, color: lang === l.c ? T.black : T.mid, background: lang === l.c ? T.light : 'transparent', cursor: 'pointer' }}>{l.l}</div>)}
              </div>}
            </div>
            {!IS_COUNTER && (
            <button onClick={onCallWaiter} style={{ flex: 1, height: 40, border: `1.5px solid ${T.border}`, borderRadius: 10, background: 'transparent', color: T.mid, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <Icon name="bell" size={14} color={T.silver} />{assignedWaiterName || tx.waiter}
            </button>
            )}
          </div>
        </div>
      </div>

      {/* ── CTAs ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', padding: '14px 20px 36px', gap: 10 }}>
        {/* Reservas: solo si el plan del local incluye Agenda (get_public_capabilities). */}
        {canReserve && (
        <button onClick={onReserve} style={{ width: '100%', height: 46, background: 'transparent', color: T.ink, border: `1.5px solid ${T.border}`, borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 14, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <Icon name="calendar" size={16} color={T.ink} />{tx.reserve}
        </button>
        )}
        <button onClick={onEnter} style={{ width: '100%', height: 54, background: T.btnPrimary, color: T.btnPrimaryText, border: 'none', borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 16, fontWeight: 800, cursor: 'pointer', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }}>{tx.menu}</button>
      </div>
    </div>
  );
}

/* ══ SCREEN: MENÚ ════════════════════════ */
function MenuScreen({ onItemSelect, cartTotal, cartCount, onViewCart, onCallWaiter, orderMode, assignedWaiterName, menuStatus, hasActiveOrder, onViewOrders, canOrder = true, openState }) {
  const T = useContext(ThemeCtx);
  const restaurant = useContext(RestaurantCtx);
  const liveMenu = useContext(MenuCtx) || {};
  const CATS = Object.keys(liveMenu);
  const ALL_ITEMS = CATS.flatMap(c => liveMenu[c]);
  const [activeCat, setActiveCat] = useState(CATS[0]);
  const [search, setSearch] = useState('');
  const catRefs = useRef({});
  const scrollRef = useRef();
  const restName = restaurant?.name || 'Restaurante';

  // Items con promo para banner superior (promo_tag, promo_type o descuento)
  const promoItems = ALL_ITEMS.filter(i => i.promo || i.promo_type || i.discount_pct > 0);
  // Item destacado (Chef ★ o primero con promo)
  const featured = ALL_ITEMS.find(i => i.promo?.tag?.includes('★')) || promoItems[0] || null;

  const filtered = search.trim() ? ALL_ITEMS.filter(i => i.name.toLowerCase().includes(search.toLowerCase()) || (i.desc||'').toLowerCase().includes(search.toLowerCase())) : null;
  const goTo = (cat) => {
    setActiveCat(cat);
    const el = catRefs.current[cat];
    if (el && scrollRef.current) scrollRef.current.scrollTo({ top: el.offsetTop - 106, behavior: 'smooth' });
  };

  return (
    <div style={{ height: '100%', background: T.offwhite, display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <div style={{ background: T.hdrBg, padding: '52px 20px 12px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: T.hdrSub, letterSpacing: T.F.lSpacing, textTransform: T.F.lCase, marginBottom: 2 }}>{orderMode === 'take' ? 'Para llevar' : (tableLabel() + ' · En el local')}</div>
            <div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.menuTitleSz, color: T.hdrText, lineHeight: 1.1 }}>{restName}</div>
          </div>
          <button onClick={onCallWaiter} style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.13)', borderRadius: 9999, padding: '7px 14px', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: T.hdrText, fontSize: 12, fontWeight: 700, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>
            <Icon name="bell" size={13} color={T.hdrText} />{assignedWaiterName || 'Mozo'}
          </button>
        </div>
        <div style={{ position: 'relative' }}>
          <div style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }}><Icon name="search" size={15} color={T.hdrSub} /></div>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar en el menú…" style={{ width: '100%', height: 40, background: T.hdrInputBg, border: `1px solid ${T.hdrInputBorder}`, borderRadius: 10, paddingLeft: 36, paddingRight: 32, color: T.hdrInputText, fontSize: 13, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", outline: 'none' }} />
          {search && <button onClick={() => setSearch('')} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer' }}><Icon name="x" size={14} color={T.hdrSub} /></button>}
        </div>
        {hasActiveOrder && onViewOrders && (
          <button onClick={onViewOrders} style={{ marginTop: 10, width: '100%', height: 40, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.13)', borderRadius: 10, color: T.hdrText, fontSize: 13, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>
            <Icon name="check" size={14} color={T.hdrText} /> Ver el estado de mi pedido
          </button>
        )}
      </div>
      <div style={{ background: T.white, borderBottom: `1px solid ${T.border}`, flexShrink: 0, overflowX: 'auto' }}>
        <div style={{ display: 'flex', minWidth: 'max-content' }}>
          {CATS.map(cat => <button key={cat} onClick={() => goTo(cat)} style={{ flexShrink: 0, background: 'none', border: 'none', borderBottom: `2px solid ${activeCat === cat ? T.black : 'transparent'}`, cursor: 'pointer', padding: '11px 18px', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 13, fontWeight: 700, color: activeCat === cat ? T.black : T.gray, whiteSpace: 'nowrap', transition: 'all 150ms' }}>{cat}</button>)}
        </div>
      </div>
      {/* Banner CERRADO: el menú queda navegable (solo lectura), sin agregar al carrito. */}
      {!canOrder && (
        <div style={{ flexShrink: 0, background: 'rgba(220,38,38,0.10)', borderBottom: '1px solid rgba(220,38,38,0.25)', padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#DC2626', flexShrink: 0 }} />
          <span style={{ fontSize: 12.5, fontWeight: 700, color: '#B91C1C' }}>
            {openState && openState.next ? `Cerrado · Abre ${openState.next}` : 'Cerrado'} — podés ver el menú, pero no pedir ahora.
          </span>
        </div>
      )}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        {CATS.length === 0 ?
          <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '60px 32px', gap: 12 }}>
            <Icon name="utensils" size={40} color={T.silver} />
            <div style={{ fontSize: 17, fontWeight: 800, color: T.ink }}>
              {menuStatus === 'empty' ? 'Menú no disponible todavía' : 'Cargando menú…'}
            </div>
            {menuStatus === 'empty' && <div style={{ fontSize: 13, color: T.gray, lineHeight: 1.7, maxWidth: 280 }}>
              {restName} todavía no publicó su carta. Volvé a intentarlo en un rato o actualizá la página.
            </div>}
          </div> :
        filtered ?
          <div style={{ padding: '16px 20px' }}>
            <div style={{ fontSize: 12, color: T.gray, marginBottom: 12 }}>{filtered.length} resultado{filtered.length !== 1 ? 's' : ''} · "{search}"</div>
            {filtered.map(item => <ProdCard key={item.id} item={item} onSelect={onItemSelect} />)}
          </div> :
          <>
            {/* ── Banner Promo del día ── */}
            {promoItems.length > 0 && (
              <div style={{ padding: '16px 20px 8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                  <Icon name="fire" size={14} color={T.ink} />
                  <span style={{ fontSize: 11, fontWeight: 800, color: T.ink, letterSpacing: '0.14em', textTransform: 'uppercase' }}>Promos de hoy</span>
                </div>
                <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 6 }}>
                  {promoItems.map(item => {
                    const discP = item.discount_pct > 0 ? Math.round(item.price * (100 - item.discount_pct) / 100) : null;
                    const badge = item.promo?.tag || (item.discount_pct > 0 ? `−${item.discount_pct}%` : null) || (item.promo_type ? PROMO_TYPE_LABEL[item.promo_type] : null);
                    return (
                      <div key={item.id} onClick={() => onItemSelect(item)} style={{ flexShrink: 0, width: 155, background: T.white, borderRadius: 14, border: `1px solid ${T.border}`, cursor: 'pointer', overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.07)' }}>
                        <div style={{ height: 88, background: item.image_url ? 'transparent' : `linear-gradient(135deg,${T.dark},${T.black})`, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {item.image_url
                            ? <img src={item.image_url} alt={item.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            : <Icon name="utensils" size={28} color="rgba(255,255,255,0.12)" />}
                          {badge && <div style={{ position: 'absolute', top: 7, right: 7, background: item.discount_pct > 0 ? '#22C55E' : T.white, color: item.discount_pct > 0 ? '#fff' : T.black, borderRadius: 5, padding: '2px 7px', fontSize: 10, fontWeight: 800, maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{badge}</div>}
                          {item.dine_in_only && <div style={{ position: 'absolute', bottom: 5, left: 5, background: 'rgba(0,0,0,0.6)', color: '#fff', borderRadius: 4, padding: '1px 5px', fontSize: 9, fontWeight: 700 }}>Solo local</div>}
                        </div>
                        <div style={{ padding: '9px 10px' }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: T.ink, lineHeight: 1.3, marginBottom: 2, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{item.name}</div>
                          {discP
                            ? <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                <span style={{ textDecoration: 'line-through', color: T.silver, fontSize: 11 }}>{fmt(item.price)}</span>
                                <span style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: 14, color: '#16A34A' }}>{fmt(discP)}</span>
                              </div>
                            : <div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: 14, color: T.ink }}>{fmt(item.price)}</div>
                          }
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── Destacado del mes ── */}
            {featured && (
              <div style={{ margin: '4px 20px 4px', background: T.white, borderRadius: 14, border: `1px solid ${T.border}`, overflow: 'hidden', cursor: 'pointer' }} onClick={() => onItemSelect(featured)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px' }}>
                  <div style={{ width: 54, height: 54, borderRadius: 10, background: featured.image_url ? 'transparent' : `linear-gradient(135deg,${T.dark},${T.black})`, flexShrink: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {featured.image_url
                      ? <img src={featured.image_url} alt={featured.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : <Icon name="award" size={22} color="rgba(255,255,255,0.2)" />}
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

            {/* ── Categorías con separadores visibles ── */}
            {CATS.map(cat => (
              <div key={cat} ref={el => catRefs.current[cat] = el}>
                <div style={{ padding: '22px 20px 10px', display: 'flex', alignItems: 'center', gap: 0 }}>
                  <div style={{ flex: 1, height: 1, background: T.border }} />
                  <div style={{ padding: '0 14px', fontSize: 13, fontWeight: 800, color: T.ink, letterSpacing: T.F.lSpacing, textTransform: 'uppercase' }}>{cat}</div>
                  <div style={{ flex: 1, height: 1, background: T.border }} />
                </div>
                <div style={{ padding: '0 20px' }}>
                  {liveMenu[cat].map(item => <ProdCard key={item.id} item={item} onSelect={onItemSelect} />)}
                </div>
              </div>
            ))}
          </>
        }
        <div style={{ height: 96 }} />
      </div>
      {cartCount > 0 && <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '12px 20px 28px', background: `linear-gradient(to top,${T.offwhite} 60%,transparent)` }}>
        <button onClick={onViewCart} style={{ width: '100%', height: 54, background: T.btnPrimary, color: T.btnPrimaryText, border: 'none', borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 15, fontWeight: 800, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', boxShadow: '0 8px 32px rgba(0,0,0,0.25)' }}>
          <div style={{ minWidth: 26, height: 26, background: 'rgba(255,255,255,0.15)', borderRadius: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, padding: '0 8px' }}>{cartCount}</div>
          <span>Mi pedido</span>
          <span style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.priceSz - 2 }}>{fmt(cartTotal)}</span>
        </button>
      </div>}
    </div>
  );
}

function ProdCard({ item, onSelect }) {
  const T = useContext(ThemeCtx);
  const discP = item.discount_pct > 0 ? Math.round(item.price * (100 - item.discount_pct) / 100) : null;
  return (
    <div onClick={() => onSelect(item)} style={{ display: 'flex', gap: T.K.showImg ? 14 : 0, padding: T.K.pad, borderBottom: `1px solid ${T.border}`, cursor: 'pointer', alignItems: 'center' }}>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>{item.name}</div>
          {item.promo && <div style={{ fontSize: 10, fontWeight: 800, background: T.black, color: T.white, borderRadius: 4, padding: '2px 7px', letterSpacing: '0.04em', flexShrink: 0 }}>{item.promo.tag}</div>}
          {item.discount_pct > 0 && <div style={{ fontSize: 10, fontWeight: 800, background: '#DCFCE7', color: '#15803D', borderRadius: 4, padding: '2px 7px', flexShrink: 0 }}>−{item.discount_pct}%</div>}
          {item.promo_type && <div style={{ fontSize: 10, fontWeight: 700, background: '#EFF6FF', color: '#1D4ED8', borderRadius: 4, padding: '2px 7px', flexShrink: 0 }}>{PROMO_TYPE_LABEL[item.promo_type]||item.promo_type}</div>}
          {item.dine_in_only && <div style={{ fontSize: 9, fontWeight: 700, background: '#F0FDF4', color: '#166534', borderRadius: 4, padding: '2px 6px', flexShrink: 0, border: '1px solid #BBF7D0' }}>Solo local</div>}
        </div>
        <div style={{ fontSize: 12, color: T.gray, lineHeight: 1.45, marginBottom: 6 }}>{item.desc}</div>
        {discP
          ? <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.priceSz, color: '#16A34A' }}>{fmt(discP)}</span>
              <span style={{ fontSize: 12, color: T.silver, textDecoration: 'line-through' }}>{fmt(item.price)}</span>
            </div>
          : <div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.priceSz, color: T.ink }}>{fmt(item.price)}</div>
        }
      </div>
      {T.K.showImg && (
        <div style={{ width: T.K.imgSz, height: T.K.imgSz, borderRadius: T.K.imgR, background: `linear-gradient(135deg,${T.dark},${T.black})`, flexShrink: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid rgba(0,0,0,0.04)`, position: 'relative' }}>
          {item.image_url
            ? <img src={item.image_url} alt={item.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { e.target.style.display = 'none'; }} />
            : <Icon name="utensils" size={T.K.imgSz * 0.28} color="rgba(255,255,255,0.15)" />}
          {item.discount_pct > 0 && <div style={{ position: 'absolute', bottom: 0, right: 0, background: '#16A34A', color: '#fff', fontSize: 9, fontWeight: 800, padding: '2px 5px', borderRadius: '4px 0 0 0' }}>−{item.discount_pct}%</div>}
        </div>
      )}
    </div>
  );
}

/* ══ MODAL: PRODUCTO ════════════════════ */
const COMBO_EXTRAS = [{ n: 'Papas fritas', p: 8000 }, { n: 'Bebida 350ml', p: 8000 }];
const PROMO_TYPE_LABEL = {pizza_corrida:'Pizza corrida',hamburgesa_corrida:'Hamburguesa corrida',tenedor_libre:'Tenedor libre',sushi_libre:'Sushi libre',bebida_libre:'Bebida libre',other:'Promo especial'};
const COMBO_PRICE  = COMBO_EXTRAS.reduce((s, e) => s + e.p, 0);
const BURGER_CATS  = ['hamburguesas', 'burger'];

// Pizza mitad-y-mitad: precio combinado de dos sabores según la regla del ancla.
function halfPrice(a, b, rule, fixed) {
  switch (rule) {
    case 'avg':        return Math.round((a + b) / 2);
    case 'sum_halves': return Math.round(a / 2 + b / 2);
    case 'fixed':      return (fixed > 0) ? fixed : Math.max(a, b); // sin precio fijo cargado → "mitad más cara"
    default:           return Math.max(a, b); // 'max'
  }
}

function ProductModal({ item, onClose, onAdd, canOrder = true, openState }) {
  const T = useContext(ThemeCtx);
  const menu = useContext(MenuCtx);
  const restaurant = useContext(RestaurantCtx);
  const [qty, setQty]         = useState(1);
  const [selEx, setSelEx]     = useState([]);
  const [notes, setNotes]     = useState('');
  const [isCombo, setIsCombo] = useState(false);
  const variants = item.variants || [];
  const hasVariants = variants.length > 0;
  const [selVariant, setSelVariant] = useState(() => variants.find(v => v.is_default) || variants[0] || null);

  // Mitad y mitad
  const canHalf = !!item.allows_half_and_half;
  const [isHalf, setIsHalf] = useState(false);
  const [second, setSecond] = useState(null);

  const isBurger  = BURGER_CATS.includes((item.category || '').toLowerCase());
  const toggleEx  = (e) => setSelEx(p => p.find(x => x.n === e.n) ? p.filter(x => x.n !== e.n) : [...p, e]);
  const allExtras = isCombo ? [...selEx, ...COMBO_EXTRAS] : selEx;
  const exTotal   = allExtras.reduce((s, e) => s + e.p, 0);
  const unitAnchor = selVariant ? selVariant.price : item.price;

  // Candidatos a 2ª mitad: misma categoría, aptos, distintos y —si hay tamaño
  // elegido— que tengan una variante activa con el MISMO nombre de tamaño.
  const halfCandidates = canHalf ? ((menu && menu[item.category]) || []).filter(x =>
    x.allows_half_and_half && x.id !== item.id &&
    (!selVariant || (x.variants || []).some(v => v.name === selVariant.name))
  ) : [];
  const priceInSize = (x) => selVariant ? ((x.variants || []).find(v => v.name === selVariant.name)?.price ?? x.price) : x.price;
  const effSecond = (isHalf && second && halfCandidates.some(c => c.id === second.id)) ? second : null;
  const halfRule  = item.half_and_half_rule || restaurant?.half_and_half_rule || 'max';
  const halfFixed = item.half_and_half_rule ? item.half_and_half_fixed_price : restaurant?.half_and_half_fixed_price;

  const isHalfMode = isHalf && !!effSecond;
  const unitBase  = isHalfMode ? halfPrice(unitAnchor, priceInSize(effSecond), halfRule, halfFixed) : unitAnchor;
  // El precio mitad-y-mitad lo fija la regla del dueño: NO se le aplica discount_pct
  // (aplicar un % sobre un precio de regla/fijo sería incorrecto y mostrado≠cobrado).
  const basePrice = (!isHalfMode && item.discount_pct > 0) ? Math.round(unitBase * (100 - item.discount_pct) / 100) : unitBase;
  const total     = (basePrice + exTotal) * qty;
  const halfIncomplete = isHalf && !effSecond;   // toggle ON pero falta elegir 2ª mitad

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'flex-end' }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)' }} />
      <div style={{ position: 'relative', width: '100%', background: T.white, borderRadius: '20px 20px 0 0', maxHeight: '92%', overflowY: 'auto', animation: 'slideUp 300ms cubic-bezier(0.16,1,0.3,1)' }}>
        <div style={{ height: 210, background: item.image_url ? 'transparent' : `linear-gradient(150deg,${T.dark},${T.black})`, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', flexShrink: 0, overflow: 'hidden' }}>
          {item.image_url
            ? <img src={item.image_url} alt={item.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <Icon name="utensils" size={52} color="rgba(255,255,255,0.1)" />}
          {item.promo && <div style={{ position: 'absolute', top: 16, left: 16, background: T.white, color: T.black, borderRadius: 6, padding: '4px 11px', fontSize: 11, fontWeight: 800, letterSpacing: '0.06em' }}>{item.promo.tag}</div>}
          {item.discount_pct > 0 && !item.promo && <div style={{ position: 'absolute', top: 16, left: 16, background: '#16A34A', color: '#fff', borderRadius: 6, padding: '4px 11px', fontSize: 11, fontWeight: 800 }}>−{item.discount_pct}%</div>}
          {item.promo_type && <div style={{ position: 'absolute', top: 16, left: item.promo || item.discount_pct > 0 ? 100 : 16, background: '#1D4ED8', color: '#fff', borderRadius: 6, padding: '4px 11px', fontSize: 10, fontWeight: 800 }}>{PROMO_TYPE_LABEL[item.promo_type]||item.promo_type}</div>}
          {item.dine_in_only && <div style={{ position: 'absolute', bottom: 12, left: 16, background: 'rgba(0,0,0,0.6)', color: '#fff', borderRadius: 5, padding: '3px 9px', fontSize: 10, fontWeight: 700 }}>Solo consumo en local</div>}
          <button onClick={onClose} style={{ position: 'absolute', top: 16, right: 16, width: 34, height: 34, borderRadius: '50%', background: 'rgba(0,0,0,0.35)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="x" size={16} color="#fff" /></button>
          <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', width: 36, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.4)' }} />
        </div>
        <div style={{ padding: '20px 20px 32px' }}>
          <div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.titleSz, color: T.ink, marginBottom: 4 }}>{item.name}</div>
          <div style={{ fontSize: 13, color: T.gray, lineHeight: 1.55, marginBottom: 18 }}>{item.desc}</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, background: T.light, borderRadius: 12, padding: '12px 16px' }}>
            <div>
              {item.discount_pct > 0 && !isHalfMode
                ? <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.priceSz + 2, color: '#16A34A' }}>{fmt(basePrice)}</span>
                    <span style={{ fontSize: 13, color: T.silver, textDecoration: 'line-through' }}>{fmt(unitBase)}</span>
                  </div>
                : <div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.priceSz + 2, color: T.ink }}>{fmt(unitBase)}</div>
              }
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button onClick={() => setQty(q => Math.max(1, q - 1))} style={{ width: 34, height: 34, borderRadius: 8, border: `1.5px solid ${T.border}`, background: T.white, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="minus" size={14} color={T.ink} /></button>
              <span style={{ fontWeight: 800, fontSize: 17, minWidth: 26, textAlign: 'center', color: T.ink }}>{qty}</span>
              <button onClick={() => setQty(q => q + 1)} style={{ width: 34, height: 34, borderRadius: 8, border: 'none', background: T.black, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="plus" size={14} color={T.white} /></button>
            </div>
          </div>

          {/* ── Tamaño / variante ── */}
          {hasVariants && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 10 }}>Tamaño</div>
              {variants.map(v => {
                const sel = selVariant && selVariant.id === v.id;
                return <div key={v.id} onClick={() => setSelVariant(v)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 14px', marginBottom: 8, background: sel ? T.black : T.light, borderRadius: 12, cursor: 'pointer', border: `2px solid ${sel ? T.black : T.border}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 20, height: 20, borderRadius: '50%', border: `2px solid ${sel ? 'rgba(255,255,255,0.5)' : T.border}`, background: sel ? 'rgba(255,255,255,0.15)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {sel && <div style={{ width: 9, height: 9, borderRadius: '50%', background: T.white }} />}
                    </div>
                    <span style={{ fontSize: 14, fontWeight: 700, color: sel ? T.white : T.ink }}>{v.name}</span>
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 700, color: sel ? 'rgba(255,255,255,0.85)' : T.gray }}>{fmt(v.price)}</span>
                </div>;
              })}
            </div>
          )}

          {/* ── Mitad y mitad ── */}
          {canHalf && (
            <div style={{ marginBottom: 20 }}>
              <div onClick={() => setIsHalf(v => !v)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 14px', background: isHalf ? T.black : T.light, borderRadius: 12, cursor: 'pointer', border: `2px solid ${isHalf ? T.black : T.border}` }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: isHalf ? T.white : T.ink }}>Mitad y mitad</div>
                  <div style={{ fontSize: 11, color: isHalf ? 'rgba(255,255,255,0.55)' : T.gray, marginTop: 2 }}>Combiná esta pizza con otro sabor</div>
                </div>
                <div style={{ width: 22, height: 22, borderRadius: 6, border: `2px solid ${isHalf ? 'rgba(255,255,255,0.4)' : T.border}`, background: isHalf ? 'rgba(255,255,255,0.15)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {isHalf && <Icon name="check" size={13} color={T.white} sw={3} />}
                </div>
              </div>
              {isHalf && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>Segunda mitad</div>
                  {halfCandidates.length === 0
                    ? <div style={{ fontSize: 12, color: T.gray, padding: '4px 0' }}>No hay otros sabores aptos {selVariant ? `en tamaño ${selVariant.name}` : ''} para combinar.</div>
                    : halfCandidates.map(c => {
                        const sel = effSecond && effSecond.id === c.id;
                        return <div key={c.id} onClick={() => setSecond(c)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 12px', marginBottom: 6, background: sel ? T.black : T.light, borderRadius: 10, cursor: 'pointer', border: `2px solid ${sel ? T.black : T.border}` }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: sel ? T.white : T.ink }}>{c.name}</span>
                          <span style={{ fontSize: 12, color: sel ? 'rgba(255,255,255,0.7)' : T.gray }}>{fmt(priceInSize(c))}</span>
                        </div>;
                      })
                  }
                </div>
              )}
            </div>
          )}

          {/* ── Opción Combo (solo hamburguesas) ── */}
          {isBurger && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 10 }}>¿En combo?</div>
              <div onClick={() => setIsCombo(v => !v)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', background: isCombo ? T.black : T.light, borderRadius: 12, cursor: 'pointer', border: `2px solid ${isCombo ? T.black : T.border}`, transition: 'all 200ms' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: isCombo ? T.white : T.ink }}>Combo completo</div>
                  <div style={{ fontSize: 11, color: isCombo ? 'rgba(255,255,255,0.55)' : T.gray, marginTop: 2 }}>Papas fritas + Bebida 350ml</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: isCombo ? 'rgba(255,255,255,0.7)' : T.gray }}>+{fmt(COMBO_PRICE)}</span>
                  <div style={{ width: 22, height: 22, borderRadius: 6, border: `2px solid ${isCombo ? 'rgba(255,255,255,0.4)' : T.border}`, background: isCombo ? 'rgba(255,255,255,0.15)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {isCombo && <Icon name="check" size={13} color={T.white} sw={3} />}
                  </div>
                </div>
              </div>
            </div>
          )}

          {item.extras?.length > 0 && <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 10 }}>Personalizar</div>
            {item.extras.map(e => {
              const sel = !!selEx.find(x => x.n === e.n);
              return <div key={e.n} onClick={() => toggleEx(e)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 0', borderBottom: `1px solid ${T.border}`, cursor: 'pointer' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 20, height: 20, borderRadius: 5, border: `2px solid ${sel ? T.black : T.border}`, background: sel ? T.black : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms', flexShrink: 0 }}>
                    {sel && <Icon name="check" size={12} color={T.white} sw={3} />}
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 500, color: T.ink }}>{e.n}</span>
                </div>
                <span style={{ fontSize: 13, color: T.gray }}>{e.p > 0 ? '+' + fmt(e.p) : 'Gratis'}</span>
              </div>;
            })}
          </div>}
          <div style={{ marginBottom: 22 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>Observaciones para cocina</div>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Sin sal, sin cebolla, término de cocción, alergia a…" style={{ width: '100%', height: 76, border: `1px solid ${T.border}`, borderRadius: 10, padding: '10px 12px', fontSize: 13, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: T.ink, resize: 'none', outline: 'none', background: T.offwhite }} />
            <div style={{ marginTop: 8, background: '#FFF7ED', border: '1px solid #FDE68A', borderRadius: 8, padding: '8px 10px', display: 'flex', gap: 7, alignItems: 'flex-start' }}>
              <span style={{ flexShrink: 0, display: 'flex' }}><Icon name="alert" size={14} color="#92400E" /></span>
              <span style={{ fontSize: 11, color: '#92400E', lineHeight: 1.5 }}>Si tenés alergias o intolerancias, indicalas arriba. El local tomará las precauciones necesarias.</span>
            </div>
          </div>
          {canOrder ? (
          <button onClick={() => { if (halfIncomplete) return; onAdd(item, qty, allExtras, notes, selVariant, (isHalf && effSecond) ? { secondName: effSecond.name, unitPrice: unitBase } : null); onClose(); }} style={{ width: '100%', height: 54, background: T.btnPrimary, color: T.btnPrimaryText, border: 'none', borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 15, fontWeight: 800, cursor: halfIncomplete ? 'default' : 'pointer', opacity: halfIncomplete ? 0.5 : 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px' }}>
            <span>{halfIncomplete ? 'Elegí la segunda mitad' : 'Agregar al pedido'}</span>
            <span style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.priceSz }}>{fmt(total)}</span>
          </button>
          ) : (
          <button disabled style={{ width: '100%', height: 54, background: T.light, color: T.gray, border: `1px solid ${T.border}`, borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 14, fontWeight: 800, cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 20px', textAlign: 'center' }}>
            {openState && openState.next ? `Cerrado · Abre ${openState.next}` : 'Local cerrado — no se puede pedir ahora'}
          </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ══ SCREEN: PEDIDO ══════════════════════ */
function CartScreen({ items, onBack, onPay, onRemove, onQty, onCouponApplied, onSplit, orderMode, canOrder = true, openState }) {
  const T = useContext(ThemeCtx);
  const [coupon, setCoupon] = useState('');
  const [applied, setApplied] = useState(false);
  const [appliedCode, setAppliedCode] = useState('');
  const [discAmount, setDiscAmount] = useState(0);
  const [validating, setValidating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const sub = items.reduce((s, ci) => s + ci.total, 0);
  const total = sub - discAmount;

  const confirmDelete = (i) => { setPendingDelete(i); };
  const doDelete = () => { onRemove(pendingDelete); setPendingDelete(null); };

  const applyCode = async () => {
    if (!coupon.trim()) return;
    setValidating(true);
    const data = await dbValidateCoupon(coupon.trim());
    setValidating(false);
    if (data) {
      const disc = data.discount_type === 'percentage' ? Math.round(sub * data.discount_value / 100) : Math.min(data.discount_value, sub);
      setApplied(true);
      setAppliedCode(coupon.trim().toUpperCase());
      setDiscAmount(disc);
      if (onCouponApplied) onCouponApplied(coupon.trim().toUpperCase(), disc);
    }
  };

  return (
    <div style={{ minHeight: '100%', background: T.offwhite, display: 'flex', flexDirection: 'column' }}>
      {/* Modal confirm delete */}
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
      <div style={{ background: T.hdrBg, padding: '52px 20px 16px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
          <button onClick={onBack} style={{ width: 38, height: 38, background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon name="back" size={17} color={T.hdrText} /></button>
          <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: T.hdrSub }}>{serviceLabel(orderMode)}</div><div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.titleSz, color: T.hdrText }}>Mi pedido</div></div>
          {items.length > 0 && onSplit && <button onClick={onSplit} style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.13)', borderRadius: 9999, padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', color: T.hdrText, fontSize: 11, fontWeight: 700, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", flexShrink: 0 }}>
            <Icon name="scissors" size={13} color={T.hdrText} />Dividir cuenta
          </button>}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        {items.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Icon name="utensils" size={40} color={T.border} />
            <div style={{ marginTop: 14, fontSize: 14, color: T.silver, marginBottom: 20 }}>Tu pedido está vacío</div>
            <button onClick={onBack} style={{ height: 44, padding: '0 20px', background: T.btnPrimary, color: T.btnPrimaryText, border: 'none', borderRadius: 12, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Ver el menú</button>
          </div>
        )}
        {items.map((ci, i) =>
        <div key={i} style={{ background: T.white, borderRadius: 12, padding: '14px', marginBottom: 10, border: `1px solid ${T.border}` }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ width: 46, height: 46, borderRadius: 8, background: T.black, flexShrink: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {ci.item.image_url
                ? <img src={ci.item.image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <Icon name="utensils" size={18} color="rgba(255,255,255,0.2)" />}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>{ci.half ? `½ ${ci.item.name} + ½ ${ci.half.secondName}` : ci.item.name}{ci.variant ? ` · ${ci.variant.name}` : ''}</div>
              {ci.extras?.length > 0 && <div style={{ fontSize: 11, color: T.gray, marginTop: 2 }}>+ {ci.extras.map(e => e.n).join(', ')}</div>}
              {ci.notes && <div style={{ fontSize: 11, color: T.silver, fontStyle: 'italic', marginTop: 2 }}>"{ci.notes}"</div>}
            </div>
            <button onClick={() => confirmDelete(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, flexShrink: 0 }}><Icon name="trash" size={15} color={T.silver} /></button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button onClick={() => onQty(i, -1)} style={{ width: 30, height: 30, background: T.light, border: `1px solid ${T.border}`, borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="minus" size={12} color={T.ink} /></button>
              <span style={{ fontSize: 15, fontWeight: 800, color: T.ink, minWidth: 22, textAlign: 'center' }}>{ci.qty}</span>
              <button onClick={() => onQty(i, 1)} style={{ width: 30, height: 30, background: T.black, border: 'none', borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="plus" size={12} color={T.white} /></button>
            </div>
            <div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.priceSz, color: T.ink }}>{fmt(ci.total)}</div>
          </div>
        </div>)}
        <div style={{ background: T.white, borderRadius: 12, padding: '14px', marginBottom: 10, border: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 5 }}><Icon name="tag" size={12} color={T.silver} />Cupón de descuento</div>
          {applied ?
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: T.ink }}>
              <div style={{ width: 22, height: 22, background: T.black, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon name="check" size={13} color={T.white} sw={3} /></div>
              {appliedCode} aplicado — <strong>−{fmt(discAmount)}</strong>
            </div> :
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={coupon} onChange={e => setCoupon(e.target.value.toUpperCase())} placeholder="Código de cupón" style={{ flex: 1, height: 40, border: `1px solid ${T.border}`, borderRadius: 8, padding: '0 12px', fontSize: 13, fontFamily: "'SF Mono',ui-monospace,monospace,monospace", letterSpacing: '0.1em', color: T.ink, outline: 'none', background: T.offwhite }} />
              <button onClick={applyCode} disabled={validating} style={{ height: 40, padding: '0 16px', background: T.black, color: T.white, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", opacity: validating ? 0.6 : 1 }}>{validating ? '…' : 'Aplicar'}</button>
            </div>
          }
        </div>
        <div style={{ background: T.white, borderRadius: 12, padding: '16px', border: `1px solid ${T.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: T.gray, marginBottom: 8 }}><span>Subtotal</span><span>{fmt(sub)}</span></div>
          {applied && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: T.dark, marginBottom: 8 }}><span>Descuento</span><span>−{fmt(discAmount)}</span></div>}
          <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>Total</span>
            <span style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.priceSz + 3, color: T.ink }}>{fmt(total)}</span>
          </div>
        </div>
        <div style={{ height: 100 }} />
      </div>
      <div style={{ padding: '12px 20px 32px', background: T.offwhite, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.length > 0 && (
          <button onClick={onBack} style={{ width: '100%', height: 44, background: 'transparent', color: T.ink, border: `1.5px solid ${T.border}`, borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 14, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Icon name="plus" size={15} color={T.ink} />Agregar más productos
          </button>
        )}
        {(() => { const blocked = items.length === 0 || !canOrder; return (
        <button onClick={() => { if (!blocked) onPay(total, sub, discAmount, applied ? appliedCode : ''); }} disabled={blocked} style={{ width: '100%', height: 54, background: blocked ? T.light : T.btnPrimary, color: blocked ? T.silver : T.btnPrimaryText, border: 'none', borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 16, fontWeight: 800, cursor: blocked ? 'default' : 'pointer', transition: 'all 200ms' }}>
          {!canOrder ? (openState && openState.next ? `Cerrado · Abre ${openState.next}` : 'Local cerrado') : 'Pasar a pagar'}
        </button>
        ); })()}
      </div>
    </div>
  );
}

/* ══ Validación fiscal (RUC paraguayo con dígito verificador, o CI numérica) ══ */
// DV del RUC por módulo 11 (algoritmo SET Paraguay): pesos 2..11 de derecha a
// izquierda; resto = suma % 11; dv = resto>1 ? 11-resto : 0.
function rucDV(base) {
  let total = 0, mult = 2;
  for (let i = base.length - 1; i >= 0; i--) {
    total += parseInt(base[i], 10) * mult;
    mult = mult >= 11 ? 2 : mult + 1;
  }
  const resto = total % 11;
  return resto > 1 ? 11 - resto : 0;
}
// Devuelve { ok, tipo?, msg? }. Acepta RUC "80012345-6" (valida DV) o CI numérica.
function validarRucCi(input) {
  const raw = String(input || '').trim().replace(/\s+/g, '');
  if (!raw) return { ok: false, msg: 'Ingresá el RUC o la cédula.' };
  if (raw.includes('-')) {
    const m = /^(\d{3,10})-(\d)$/.exec(raw);
    if (!m) return { ok: false, msg: 'RUC inválido. Formato: 80012345-6' };
    if (rucDV(m[1]) !== parseInt(m[2], 10)) return { ok: false, msg: 'El dígito verificador del RUC no coincide.' };
    return { ok: true, tipo: 'ruc' };
  }
  if (/^\d{3,10}$/.test(raw)) return { ok: true, tipo: 'ci' };
  return { ok: false, msg: 'Ingresá un RUC (ej. 80012345-6) o una cédula numérica.' };
}
const EMAIL_RE_CLIENTE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ══ SCREEN: PAGO ════════════════════════ */
function PayScreen({ total, subtotal, discountAmount, couponCode, onBack, onDone, onNewOrder, cartItems, orderMode, lang, canOrder = true, openState }) {
  const T = useContext(ThemeCtx);
  const restaurant = useContext(RestaurantCtx);
  const [step, setStep] = useState('form');
  const [method, setMethod] = useState('efectivo');
  const [invoiceType, setInvoiceType] = useState('none'); // 'none' | 'ticket' | 'fiscal'
  const [invoiceDelivery, setInvoiceDelivery] = useState('print'); // 'print' | 'email'
  const [name, setName] = useState('');
  const [ruc, setRuc] = useState('');
  const [email, setEmail] = useState('');
  const [ordNum, setOrdNum] = useState('');
  const [submitError, setSubmitError] = useState(null);
  // ── CRM (mig 196): "Mis datos" ─────────────────────────────────────
  // Hasta ahora el pedido por QR sólo guardaba el nombre si el comensal pedía
  // factura fiscal — por eso el CRM del local estaba lleno de "pedidos sin
  // identificar". Este bloque es OPCIONAL y se persiste en el dispositivo, así
  // que el habitué lo completa UNA vez y sus siguientes pedidos ya lo traen.
  const CRM_LS = 'mythos_mis_datos';
  const [crmOpen, setCrmOpen] = useState(false);
  const [crm, setCrm] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CRM_LS) || '{}') || {}; } catch (_) { return {}; }
  });
  const setCrmField = (k, v) => setCrm(p => {
    const n = { ...p, [k]: v };
    try { localStorage.setItem(CRM_LS, JSON.stringify(n)); } catch (_) {}
    return n;
  });
  // FASE D2 (mig 183): comprobante de transferencia que sube el cliente.
  const [proofPath, setProofPath] = useState('');       // path en el bucket privado
  const [proofPreview, setProofPreview] = useState(''); // objectURL local (preview)
  const [proofBusy, setProofBusy] = useState(false);
  const [proofRef, setProofRef] = useState('');         // N° de operación (opcional)
  const proofInputRef = useRef();
  const handleProof = async (file) => {
    if (!file) return;
    setSubmitError(null); setProofBusy(true);
    try {
      const path = await uploadComprobante(db, RESTAURANT_ID, file);
      try { setProofPreview(URL.createObjectURL(file)); } catch (_) {}
      setProofPath(path);
    } catch (e) {
      setSubmitError(e.message || 'No se pudo subir el comprobante');
    }
    setProofBusy(false);
  };
  const METHODS_ALL = [
    { id: 'efectivo', label: 'Efectivo', sub: 'Se cobra en mesa o caja', info: 'El pago se realiza en mesa o caja. El mozo te asistirá.' },
    { id: 'tarjeta', label: 'Tarjeta', sub: 'Visa · Mastercard · Amex', info: 'El mozo acercará la terminal de pago a tu mesa.' },
    { id: 'qr', label: 'QR / Transferencia', sub: 'Transferencia bancaria · Billetera', info: 'Transferí al alias/cuenta del local o escaneá el QR, y adjuntá la captura del comprobante para confirmar tu pedido.' },
    { id: 'pos', label: 'POS en mesa', sub: 'Terminal llega a tu mesa', info: 'El mozo acercará el POS a tu mesa en breve.' }
  ];
  // Config del restaurante (mig 181): oculta los medios que el dueño apagó. NULL/ausente = habilitado.
  const pmCfg = restaurant && restaurant.payment_methods;
  const METHODS = METHODS_ALL.filter(m => !pmCfg || pmCfg[m.id] !== false);
  // Si el método elegido quedó deshabilitado (o no está en la lista), saltar al primero disponible.
  useEffect(() => {
    if (METHODS.length && !METHODS.find(m => m.id === method)) setMethod(METHODS[0].id);
  }, [pmCfg]);
  const currentMethod = METHODS.find(m => m.id === method);

  // Comprobante de transferencia OBLIGATORIO en el cliente (pedido de Renato): no dejar
  // confirmar un pago por transferencia/QR sin subir el comprobante — así el pedido no
  // entra "sin validar" y sin llegar a cocina. Incondicional para 'qr', igual que el
  // checkout de delivery-cliente. (El toggle "Exigir comprobante" del admin sigue
  // gateando el cobro STAFF-side en caja/mozo; acá el cliente que transfiere siempre sube.)
  const mustUploadProof = method === 'qr';
  const needProof = mustUploadProof && !proofPath;   // falta el comprobante obligatorio

  const submittingRef = useRef(false);   // WS3-B · guard anti doble-submit (sincrónico, no async como `step`)
  const handleConfirm = async () => {
    if (submittingRef.current) return;   // un 2º click rápido NO dispara otro insert
    setSubmitError(null);
    // Bloqueo con el local CERRADO (cubre carrito/pantalla persistidos y cierre en vivo).
    if (!canOrder) { setSubmitError(openState && openState.next ? `El local está cerrado · Abre ${openState.next}. No se puede confirmar el pedido ahora.` : 'El local está cerrado. No se puede confirmar el pedido ahora.'); return; }
    if (!cartItems || cartItems.length === 0) { setSubmitError('Tu carrito está vacío'); return; }
    const effectiveTotal = total > 0 ? total : cartItems.reduce((s, ci) => s + (ci.total || 0), 0);
    if (effectiveTotal <= 0) { setSubmitError('El total del pedido es inválido. Volvé al carrito y revisá los precios.'); return; }
    // Transferencia/QR: exigir el comprobante ANTES de confirmar (si el local no lo desactivó).
    if (mustUploadProof && !proofPath) {
      setSubmitError(proofBusy ? 'Esperá a que termine de subir el comprobante.' : 'Subí la foto del comprobante de tu transferencia para poder confirmar el pedido.');
      return;
    }
    // Factura fiscal: validar datos del receptor ANTES de confirmar (no se puede
    // emitir una factura electrónica sin razón social + RUC/CI válido).
    if (invoiceType === 'fiscal') {
      if (!name.trim()) { setSubmitError('Ingresá el nombre o razón social para la factura.'); return; }
      const v = validarRucCi(ruc);
      if (!v.ok) { setSubmitError(v.msg); return; }
      const emailTrim = email.trim();
      if (invoiceDelivery === 'email' && !emailTrim) { setSubmitError('Ingresá un email para recibir la factura electrónica.'); return; }
      if (emailTrim && !EMAIL_RE_CLIENTE.test(emailTrim)) { setSubmitError('El email no tiene un formato válido.'); return; }
    }
    submittingRef.current = true;        // se setea ANTES del primer await → bloquea reentrada
    setStep('proc');
    try {
      // Bug-02 / R2: el pedido de mesa (QR con ?mesa=N o ?t=token) debe persistir
      // su table_id real para aparecer como "Mesa N" en cocina, mozo y caja. El QR
      // de mostrador (sin mesa) y los pedidos "para llevar" siguen SIN mesa.
      if (!IS_COUNTER && !_tableUUID) { await _initTableUUID(); }
      const isTableDineIn = !IS_COUNTER && orderMode !== 'take';
      const order = await dbSubmitOrder({
        tableId: isTableDineIn ? _tableUUID : null, orderType: orderMode === 'take' ? 'llevar' : 'local',
        items: cartItems, subtotal: subtotal || effectiveTotal, discountAmount: discountAmount || 0,
        couponCode: couponCode || null, total: effectiveTotal, payMethod: method,
        custName: (invoiceType === 'fiscal' && name) ? name.trim() : null,
        custRuc: (invoiceType === 'fiscal' && ruc) ? ruc.trim() : null,
        custEmail: (invoiceType === 'fiscal' && email) ? email.trim() : null,
        requiresInvoice: invoiceType !== 'none',
        invoiceDeliveryMethod: invoiceType !== 'none' ? invoiceDelivery : null,
        // PR-FE-4: factura fiscal (e-Kuatia) solicitada por el cliente. El receptor
        // fiscal REAL va en factura_* (separado de customer_*, que delivery reusa).
        facturaSolicitada: invoiceType === 'fiscal',
        facturaRazonSocial: invoiceType === 'fiscal' ? name.trim() : null,
        facturaRucCi: invoiceType === 'fiscal' ? ruc.trim() : null,
        facturaEmail: (invoiceType === 'fiscal' && email.trim()) ? email.trim() : null,
        facturaFormato: invoiceType === 'fiscal' ? (invoiceDelivery === 'email' ? 'email' : 'impreso') : null,
        language: lang,
        // Comprobante de transferencia subido por el cliente (mig 183) — solo método QR/transferencia.
        paymentProofPath: method === 'qr' ? (proofPath || null) : null,
        paymentReference: method === 'qr' ? (proofRef.trim() || null) : null,
        // CRM (mig 196): ficha del comensal. Se arma con lo de "Mis datos" y, si no
        // lo completó pero sí pidió factura fiscal, con el receptor de la factura —
        // que es el mismo dato y de otro modo se perdería igual que antes.
        customer: (() => {
          const esFiscal = invoiceType === 'fiscal';
          const docForm = (crm.doc_number || '').trim();
          const docNum  = docForm || (esFiscal ? ruc.trim() : '');
          return customerPayload({
            first_name: (crm.first_name || '').trim() || (esFiscal ? name.trim().split(/\s+/)[0] : ''),
            last_name:  (crm.last_name  || '').trim() || (esFiscal ? name.trim().split(/\s+/).slice(1).join(' ') : ''),
            phone: (crm.phone || '').trim(),
            // El del formulario conserva su tipo; el que viene de la factura es un RUC.
            doc_type: docForm ? (crm.doc_type || 'ci') : (docNum ? 'ruc' : null),
            doc_number: docNum,
            email: (crm.email || '').trim() || (esFiscal ? email.trim() : ''),
            address: (crm.address || '').trim(),
          }, 'qr');
        })(),
      });
      setOrdNum(order.order_number);
      setStep('ok');
    } catch(e) {
      // El servicio del local se cortó mientras el comensal armaba el pedido
      // (trigger de la mig 193): mensaje neutro, sin el prefijo técnico.
      const msg = /SERVICIO_NO_DISPONIBLE/.test(e.message || '')
        ? 'Este local no está recibiendo pedidos en este momento. Consultá con el personal del restaurante.'
        : (e.message || 'Error al enviar el pedido');
      setSubmitError(msg);
      setStep('form');
      submittingRef.current = false;     // error real → permitir reintento
    }
  };

  if (step === 'proc') return (
    <div style={{ minHeight: '100%', background: T.white, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32 }}>
      <div style={{ width: 56, height: 56, border: `3px solid ${T.border}`, borderTopColor: T.black, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.titleSz, color: T.ink }}>Enviando pedido…</div>
      <div style={{ fontSize: 12, color: T.silver }}>{fmt(total)}</div>
    </div>
  );

  if (step === 'ok') {
    const isPending = method === 'efectivo' || method === 'pos';
    const confirmTitle = isPending ? 'Pedido enviado' : 'Pedido confirmado';
    const confirmSub = method === 'efectivo' ? 'Tu pedido fue recibido. Pagás en mesa o caja.' :
                       method === 'pos' ? 'Tu pedido fue recibido. El mozo acercará el POS.' :
                       method === 'tarjeta' ? 'Tu pedido fue recibido. El mozo procesará el pago.' :
                       method === 'qr' ? (proofPath ? 'Recibimos tu comprobante. Caja lo verifica y confirma tu pago.' : 'Tu pedido fue recibido. Mostrá el comprobante al mozo o caja.') :
                       'Tu pedido fue recibido.';
    return (
      <div style={{ minHeight: '100%', background: T.black, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 28px', textAlign: 'center' }}>
        <div style={{ width: 76, height: 76, border: '1px solid rgba(255,255,255,0.2)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 28 }}>
          <Icon name="check" size={34} color={T.btnPrimaryText} sw={2} />
        </div>
        <div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.heroSz, color: T.btnPrimaryText, marginBottom: 10 }}>{confirmTitle}</div>
        <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.55)', lineHeight: 1.7, marginBottom: 4 }}>{confirmSub}</div>
        <div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.priceSz + 2, color: 'rgba(255,255,255,0.3)', marginBottom: 32 }}>{fmt(total)}</div>
        <div style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, padding: '14px 20px', width: '100%', marginBottom: 10, textAlign: 'left' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 3 }}>N° de ticket</div>
              <div style={{ fontFamily: "'SF Mono',ui-monospace,monospace,monospace", fontSize: 20, fontWeight: 500, color: T.btnPrimaryText }}>{ordNum || '#????'}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 3 }}>{(TABLE_NUM && orderMode !== 'take') ? 'Mesa' : 'Modo'}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: T.btnPrimaryText }}>{(TABLE_NUM && orderMode !== 'take') ? TABLE_NUM : (orderMode === 'take' ? 'Llevar' : 'Local')}</div>
            </div>
          </div>
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 10 }}>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 3 }}>Pago</div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.65)', fontWeight: 600 }}>{currentMethod?.label}{isPending ? ' — pendiente en mesa' : ''}</div>
          </div>
        </div>
        <button onClick={() => onDone(ordNum, method)} style={{ width: '100%', height: 52, background: T.white, color: T.black, border: 'none', borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 16, fontWeight: 800, cursor: 'pointer', marginTop: 14 }}>Seguir mi pedido</button>
        {onNewOrder && (
          <button onClick={() => onNewOrder(ordNum, method)} style={{ width: '100%', height: 50, background: 'transparent', color: T.btnPrimaryText, border: '1.5px solid rgba(255,255,255,0.25)', borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 15, fontWeight: 700, cursor: 'pointer', marginTop: 10 }}>Hacer otro pedido</button>
        )}
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100%', background: T.offwhite, display: 'flex', flexDirection: 'column' }}>
      <div style={{ background: T.hdrBg, padding: '52px 20px 16px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
          <button onClick={onBack} style={{ width: 38, height: 38, background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon name="back" size={17} color={T.hdrText} /></button>
          <div><div style={{ fontSize: 11, color: T.hdrSub }}>Total a pagar</div><div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.heroSz - 8, color: T.hdrText }}>{fmt(total)}</div></div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 10 }}>Método de pago</div>
        {METHODS.map(m => (
          <div key={m.id} onClick={() => setMethod(m.id)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', background: T.white, border: `2px solid ${method === m.id ? T.black : T.border}`, borderRadius: 12, marginBottom: 8, cursor: 'pointer', transition: 'border-color 150ms' }}>
            <div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>{m.label}</div><div style={{ fontSize: 12, color: T.gray, marginTop: 1 }}>{m.sub}</div></div>
            <div style={{ width: 20, height: 20, borderRadius: '50%', border: `2px solid ${method === m.id ? T.black : T.border}`, background: method === m.id ? T.black : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 150ms' }}>
              {method === m.id && <div style={{ width: 8, height: 8, borderRadius: '50%', background: T.white }} />}
            </div>
          </div>
        ))}
        {/* "Pagar desde el celular / Bancard" retirado — no funcional aún (2026-07-19) */}
        {/* Texto contextual por método */}
        {currentMethod && (
          <div style={{ background: method === 'qr' ? '#FFF7ED' : T.light, border: `1px solid ${method === 'qr' ? '#FDE68A' : T.border}`, borderRadius: 10, padding: '10px 14px', marginBottom: 14, fontSize: 12, color: method === 'qr' ? '#92400E' : T.mid, lineHeight: 1.5 }}>
            {method === 'qr' && <Icon name="alert" size={12} color="#92400E" style={{ marginRight: 6, verticalAlign: '-2px' }} />}{currentMethod.info}
          </div>
        )}
        {method === 'qr' && (() => {
          const b = restaurant || {};
          const hasData = b.bank_holder || b.bank_name || b.bank_account || b.bank_alias || b.bank_qr_url;
          return (
            <div style={{ background: T.white, border: `1px solid ${T.border}`, borderRadius: 12, padding: '20px', marginBottom: 14, textAlign: 'center' }}>
              <div style={{ fontSize: 12, color: T.gray, marginBottom: 14, fontWeight: 600 }}>Datos para transferir</div>
              {b.bank_qr_url
                ? <div style={{ display: 'inline-block', border: `1px solid ${T.border}`, borderRadius: 8, padding: 8, background: '#fff' }}><img src={b.bank_qr_url} alt="QR de transferencia" style={{ width: 160, height: 160, objectFit: 'contain', display: 'block' }} /></div>
                : <div style={{ display: 'inline-block', border: `1px solid ${T.border}`, borderRadius: 8, padding: 8 }}><QRSvg size={140} fgColor={T.black} /></div>}
              {hasData && (
                <div style={{ marginTop: 14, textAlign: 'left', fontSize: 13, lineHeight: 1.7, color: T.ink, wordBreak: 'break-word' }}>
                  {b.bank_holder && <div><span style={{ color: T.gray }}>Titular:</span> <strong>{b.bank_holder}</strong></div>}
                  {b.bank_name && <div><span style={{ color: T.gray }}>Banco:</span> {b.bank_name}</div>}
                  {b.bank_account && <div><span style={{ color: T.gray }}>Cuenta:</span> {b.bank_account}</div>}
                  {b.bank_alias && <div><span style={{ color: T.gray }}>Alias:</span> {b.bank_alias}</div>}
                  {b.bank_doc && <div><span style={{ color: T.gray }}>CI/RUC:</span> {b.bank_doc}</div>}
                </div>
              )}
              <div style={{ fontSize: 11, color: T.silver, marginTop: 12 }}>{hasData ? 'Transferí el total y subí la captura del comprobante abajo.' : 'El local aún no cargó sus datos de transferencia. Consultá al mozo.'}</div>
            </div>
          );
        })()}
        {/* Comprobante de transferencia que sube el CLIENTE (mig 183). Caja lo verifica
            antes de confirmar el pago. Bucket privado → solo el staff lo ve (URL firmada). */}
        {method === 'qr' && (
          <div style={{ background: T.white, border: `1px solid ${T.border}`, borderRadius: 12, padding: '14px 16px', marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.gray, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>Comprobante de transferencia{mustUploadProof && <span style={{ color: '#EF4444' }}> · obligatorio</span>}</div>
            <div style={{ fontSize: 12, color: T.silver, marginBottom: 10, lineHeight: 1.5 }}>{mustUploadProof ? 'Subí la captura de tu transferencia para poder confirmar el pedido. El local la revisa y confirma tu pago.' : 'Subí la captura de tu transferencia. Caja la revisa y confirma tu pago.'}</div>
            <input ref={proofInputRef} type="file" accept=".jpg,.jpeg,.png,.webp" style={{ display: 'none' }} onChange={e => { const f = e.target.files[0]; e.target.value = ''; handleProof(f); }} />
            {proofPreview ? (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <img src={proofPreview} alt="comprobante" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, border: `1px solid ${T.border}` }} />
                <button onClick={() => proofInputRef.current.click()} disabled={proofBusy} style={{ padding: '7px 12px', borderRadius: 8, border: `1px solid ${T.border}`, background: T.offwhite, color: T.ink, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>{proofBusy ? 'Subiendo…' : 'Cambiar'}</button>
                <button onClick={() => { setProofPath(''); setProofPreview(''); }} style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid rgba(239,68,68,0.3)', background: 'transparent', color: '#EF4444', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Quitar</button>
              </div>
            ) : (
              <button onClick={() => proofInputRef.current.click()} disabled={proofBusy} style={{ width: '100%', padding: '12px', borderRadius: 10, border: `1.5px dashed ${T.border}`, background: T.offwhite, color: T.ink, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>{proofBusy ? 'Subiendo…' : '📷  Adjuntar comprobante'}</button>
            )}
            <input value={proofRef} onChange={e => setProofRef(e.target.value)} placeholder="N° de operación (opcional)" style={{ marginTop: 10, width: '100%', height: 40, border: `1px solid ${T.border}`, borderRadius: 8, padding: '0 12px', fontSize: 13, color: T.ink, outline: 'none', background: T.offwhite, boxSizing: 'border-box', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }} />
          </div>
        )}
        {/* Mis datos (CRM · mig 196) — opcional, colapsado por defecto para no
            agregar fricción a quien sólo quiere pedir y comer. */}
        <div style={{ background: T.white, border: `1px solid ${T.border}`, borderRadius: 12, padding: '14px 16px', marginBottom: 10 }}>
          <button onClick={() => setCrmOpen(o => !o)} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>
            <span>
              <span style={{ display: 'block', fontSize: 12, fontWeight: 700, color: T.gray, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Mis datos · opcional</span>
              <span style={{ display: 'block', fontSize: 12, color: T.silver, marginTop: 3, fontWeight: 500 }}>
                {(crm.first_name || '').trim()
                  ? `${crm.first_name} ${crm.last_name || ''}`.trim() + (crm.phone ? ` · ${crm.phone}` : '')
                  : 'Dejá tu nombre para que el local te reconozca la próxima vez'}
              </span>
            </span>
            <span style={{ fontSize: 13, fontWeight: 800, color: T.ink, flexShrink: 0 }}>{crmOpen ? '−' : '+'}</span>
          </button>
          {crmOpen && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <input value={crm.first_name || ''} onChange={e => setCrmField('first_name', e.target.value)} placeholder="Nombre" autoComplete="given-name"
                  style={{ height: 42, border: `1px solid ${T.border}`, borderRadius: 8, padding: '0 12px', fontSize: 13, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: T.ink, outline: 'none', background: T.offwhite, boxSizing: 'border-box' }} />
                <input value={crm.last_name || ''} onChange={e => setCrmField('last_name', e.target.value)} placeholder="Apellido" autoComplete="family-name"
                  style={{ height: 42, border: `1px solid ${T.border}`, borderRadius: 8, padding: '0 12px', fontSize: 13, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: T.ink, outline: 'none', background: T.offwhite, boxSizing: 'border-box' }} />
              </div>
              <input value={crm.phone || ''} onChange={e => setCrmField('phone', e.target.value)} placeholder="Teléfono (0981 123 456)" type="tel" autoComplete="tel"
                style={{ height: 42, border: `1px solid ${T.border}`, borderRadius: 8, padding: '0 12px', fontSize: 13, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: T.ink, outline: 'none', background: T.offwhite, boxSizing: 'border-box' }} />
              <div style={{ display: 'grid', gridTemplateColumns: '86px 1fr', gap: 8 }}>
                <select value={crm.doc_type || 'ci'} onChange={e => setCrmField('doc_type', e.target.value)}
                  style={{ height: 42, border: `1px solid ${T.border}`, borderRadius: 8, padding: '0 8px', fontSize: 13, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: T.ink, outline: 'none', background: T.offwhite, boxSizing: 'border-box' }}>
                  <option value="ci">CI</option>
                  <option value="ruc">RUC</option>
                </select>
                <input value={crm.doc_number || ''} onChange={e => setCrmField('doc_number', e.target.value)} placeholder="CI / RUC (opcional)" inputMode="numeric"
                  style={{ height: 42, border: `1px solid ${T.border}`, borderRadius: 8, padding: '0 12px', fontSize: 13, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: T.ink, outline: 'none', background: T.offwhite, boxSizing: 'border-box' }} />
              </div>
              <input value={crm.email || ''} onChange={e => setCrmField('email', e.target.value)} placeholder="Correo (opcional)" type="email" autoComplete="email"
                style={{ height: 42, border: `1px solid ${T.border}`, borderRadius: 8, padding: '0 12px', fontSize: 13, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: T.ink, outline: 'none', background: T.offwhite, boxSizing: 'border-box' }} />
              <input value={crm.address || ''} onChange={e => setCrmField('address', e.target.value)} placeholder="Dirección (opcional)" autoComplete="street-address"
                style={{ height: 42, border: `1px solid ${T.border}`, borderRadius: 8, padding: '0 12px', fontSize: 13, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: T.ink, outline: 'none', background: T.offwhite, boxSizing: 'border-box' }} />
              <div style={{ fontSize: 11, color: T.silver, lineHeight: 1.5 }}>
                Sólo los ve este restaurante, para reconocerte y mejorar tu atención. Podés pedir igual sin completar nada.
              </div>
            </div>
          )}
        </div>

        {/* Comprobante */}
        <div style={{ background: T.white, border: `1px solid ${T.border}`, borderRadius: 12, padding: '14px 16px', marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.gray, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 }}>Comprobante</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
            {[['none','Sin comprobante'],['ticket','Ticket impreso'],['fiscal','Factura fiscal']].map(([v, lbl]) => (
              <button key={v} onClick={() => setInvoiceType(v)} style={{ padding: '9px 4px', borderRadius: 9, border: `2px solid ${invoiceType === v ? T.black : T.border}`, background: invoiceType === v ? T.black : 'transparent', color: invoiceType === v ? T.white : T.ink, fontSize: 11, fontWeight: 700, cursor: 'pointer', lineHeight: 1.3, transition: 'all 150ms', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>{lbl}</button>
            ))}
          </div>
          {invoiceType !== 'none' && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.gray, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>¿Cómo querés recibirlo?</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {[['print','Impreso'],['email','Por email']].map(([v, lbl]) => (
                  <button key={v} onClick={() => setInvoiceDelivery(v)} style={{ padding: '9px 4px', borderRadius: 9, border: `2px solid ${invoiceDelivery === v ? T.black : T.border}`, background: invoiceDelivery === v ? T.black : 'transparent', color: invoiceDelivery === v ? T.white : T.ink, fontSize: 12, fontWeight: 700, cursor: 'pointer', lineHeight: 1.3, transition: 'all 150ms', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>{lbl}</button>
                ))}
              </div>
            </div>
          )}
          {invoiceType === 'ticket' && (
            <div style={{ marginTop: 10, background: T.offwhite, borderRadius: 8, padding: '10px 12px', fontSize: 12, color: T.gray, lineHeight: 1.5 }}>
              {invoiceDelivery === 'email'
                ? 'Te enviaremos el comprobante por email cuando pagues.'
                : 'El mozo te trae el ticket impreso cuando pagás.'}
            </div>
          )}
          {invoiceType === 'fiscal' && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[{ val: name, set: setName, ph: 'Nombre o razón social' }, { val: ruc, set: setRuc, ph: 'RUC / Cédula de identidad' }, { val: email, set: setEmail, ph: invoiceDelivery === 'email' ? 'Email para factura electrónica (requerido)' : 'Email (opcional)', type: 'email' }].map((f, i) =>
                <input key={i} value={f.val} onChange={e => f.set(e.target.value)} placeholder={f.ph} type={f.type || 'text'} style={{ height: 42, border: `1px solid ${T.border}`, borderRadius: 8, padding: '0 12px', fontSize: 13, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: T.ink, outline: 'none', background: T.offwhite }} />
              )}
              <div style={{ fontSize: 11, color: T.silver, marginTop: 2 }}>Se emite tu factura electrónica (e-Kuatia / SIFEN) con estos datos. Revisá que el RUC o la cédula sean correctos.</div>
            </div>
          )}
        </div>
        <div style={{ height: 100 }} />
      </div>
      <div style={{ padding: '12px 20px 32px', background: T.offwhite }}>
        {submitError && <div style={{ background: '#FEE2E2', border: '1px solid #FECACA', borderRadius: 10, padding: '10px 14px', marginBottom: 10, fontSize: 13, color: '#B91C1C', fontWeight: 600 }}>Error: {submitError}</div>}
        {(() => { const confirmEnabled = canOrder && !needProof && !proofBusy; return (
        <button onClick={handleConfirm} disabled={!confirmEnabled} style={{ width: '100%', height: 54, background: confirmEnabled ? T.btnPrimary : T.light, color: confirmEnabled ? T.btnPrimaryText : T.silver, border: 'none', borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 16, fontWeight: 800, cursor: confirmEnabled ? 'pointer' : 'default', boxShadow: confirmEnabled ? '0 8px 24px rgba(0,0,0,0.15)' : 'none' }}>
          {!canOrder ? (openState && openState.next ? `Cerrado · Abre ${openState.next}` : 'Local cerrado') : proofBusy ? 'Subiendo comprobante…' : needProof ? 'Adjuntá el comprobante para continuar' : (method === 'efectivo' || method === 'pos' ? 'Confirmar pedido' : `Confirmar y pagar ${fmt(total)}`)}
        </button>
        ); })()}
      </div>
    </div>
  );
}

/* ══ SCREEN: SEGUIMIENTO ════════════════ */
function TrackingScreen({ onRate, orderNumber, orderMode, cartItems, onCallWaiter, assignedWaiterName, sessionOrders, onSelectOrder, onNewOrder }) {
  const T = useContext(ThemeCtx);
  const readyLabel = orderMode === 'take' ? 'Listo para retirar' : 'Listo — el mozo lo lleva';
  const readySub   = orderMode === 'take' ? 'Pasá a buscar tu pedido en caja' : 'El mozo está en camino a tu mesa';
  const STEPS = [
    { label: 'Pedido enviado', sub: 'Recibimos tu solicitud' },
    { label: 'Pedido recibido', sub: 'El local tiene tu pedido' },
    { label: 'En cola de cocina', sub: `Ticket ${orderNumber || '#????'}` },
    { label: 'Cocinando', sub: 'Tu plato está en preparación' },
    { label: readyLabel, sub: readySub },
    { label: 'Entregado', sub: '¡Buen provecho!' }
  ];
  const STATUS_MAP = { paid: 1, kitchen_received: 2, cooking: 3, ready: 4, delivered: 5, pending_payment: 5 };
  const [active, setActive] = useState(1);

  useEffect(() => {
    if (!db || !orderNumber) {
      const t = setInterval(() => setActive(a => a < STEPS.length - 1 ? a + 1 : a), 2800);
      return () => clearInterval(t);
    }

    // ETAPA 2 (seguridad): se ELIMINA la suscripción realtime a orders (el payload de
    // postgres_changes entregaba la fila completa —total/payment_status— cross-tenant,
    // ignorando los grants de columna). El seguimiento ahora va 100% por POLLING de
    // get_order_status (RPC sin columnas financieras).
    let pollInterval = null;

    const fetchStatus = () =>
      dbLoadOrder(orderNumber).then(ord => { if (ord) setActive(STATUS_MAP[ord.status] || 1); });

    // carga inicial + polling cada 6s
    fetchStatus();
    pollInterval = setInterval(fetchStatus, 6000);

    // al volver del fondo (iOS), refrescar inmediatamente
    const onVisible = () => { if (document.visibilityState === 'visible') fetchStatus(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(pollInterval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [orderNumber]);

  return (
    <div style={{ minHeight: '100%', background: T.trackBg, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '52px 24px 20px', flexShrink: 0 }}>
        <div style={{ fontSize: 11, color: T.trackSub, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>{serviceLabel(orderMode)} · {orderNumber || 'Ticket en proceso'}</div>
        <div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.heroSz, color: T.trackText, lineHeight: 1.1, marginBottom: 6 }}>Seguimiento</div>
        <div style={{ fontSize: 13, color: T.trackSub, marginBottom: 16 }}>Actualización en tiempo real</div>
        {/* Selector de pedidos de la sesión: si hay más de uno, elegí cuál seguir */}
        {sessionOrders && sessionOrders.length > 1 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, color: T.trackSub, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>Mis pedidos ({sessionOrders.length})</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {sessionOrders.map(num => {
                const sel = num === orderNumber;
                return (
                  <button key={num} onClick={() => onSelectOrder && onSelectOrder(num)} style={{ background: sel ? T.trackText : 'transparent', color: sel ? T.trackBg : T.trackText, border: `1.5px solid ${T.trackText}30`, borderRadius: 9999, padding: '5px 12px', fontFamily: "'SF Mono',ui-monospace,monospace", fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>{num}</button>
                );
              })}
            </div>
          </div>
        )}
        {/* Resumen de ítems */}
        {cartItems && cartItems.length > 0 && (
          <div style={{ background: `${T.trackText}08`, border: `1px solid ${T.trackText}12`, borderRadius: 10, padding: '10px 14px' }}>
            {cartItems.slice(0, 3).map((ci, i) => (
              <div key={i} style={{ fontSize: 12, color: T.trackSub, display: 'flex', justifyContent: 'space-between', marginBottom: i < Math.min(cartItems.length, 3) - 1 ? 4 : 0 }}>
                <span>{ci.qty}× {ci.item.name}</span>
                <span style={{ opacity: 0.6 }}>{fmt(ci.total)}</span>
              </div>
            ))}
            {cartItems.length > 3 && <div style={{ fontSize: 11, color: T.trackSub, opacity: 0.5, marginTop: 4 }}>+{cartItems.length - 3} ítem{cartItems.length - 3 > 1 ? 's' : ''} más</div>}
          </div>
        )}
      </div>
      <div style={{ flex: 1, padding: '0 24px', overflowY: 'auto' }}>
        {STEPS.map((s, i) => {
          const done = i < active, cur = i === active, pend = i > active;
          return <div key={i} style={{ display: 'flex', gap: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ width: 30, height: 30, borderRadius: '50%', background: done || cur ? T.trackText : 'rgba(128,128,128,0.1)', border: `2px solid ${done || cur ? T.trackText : 'rgba(128,128,128,0.2)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 400ms' }}>
                {done && <Icon name="check" size={14} color={T.trackBg} sw={3} />}
                {cur && <div style={{ width: 10, height: 10, borderRadius: '50%', background: T.trackBg, animation: 'pulse 1.4s ease infinite' }} />}
              </div>
              {i < STEPS.length - 1 && <div style={{ width: 1, flex: 1, minHeight: 36, background: done ? T.trackLine : T.trackLineDim, margin: '4px 0', transition: 'background 600ms' }} />}
            </div>
            <div style={{ paddingBottom: 28, flex: 1, paddingTop: 4 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: pend ? `${T.trackText}30` : T.trackText, transition: 'color 400ms' }}>{s.label}</div>
              <div style={{ fontSize: 12, color: pend ? `${T.trackSub}50` : T.trackSub, marginTop: 2, transition: 'color 400ms' }}>{s.sub}</div>
            </div>
          </div>;
        })}
        <div style={{ height: 20 }} />
      </div>
      <div style={{ padding: '12px 24px 40px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {onCallWaiter && active < STEPS.length - 1 && (
          <button onClick={onCallWaiter} style={{ width: '100%', height: 46, background: 'transparent', color: T.trackText, border: `1.5px solid ${T.trackText}30`, borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 14, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Icon name="bell" size={15} color={T.trackText} />{assignedWaiterName ? `Llamar a ${assignedWaiterName}` : 'Llamar al mozo'}
          </button>
        )}
        {active === STEPS.length - 1 && (
          <button onClick={onRate} style={{ width: '100%', height: 52, background: T.trackText, color: T.trackBg, border: 'none', borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 16, fontWeight: 800, cursor: 'pointer', animation: 'fadeIn 400ms' }}>
            Calificar el servicio
          </button>
        )}
        {onNewOrder && (
          <button onClick={onNewOrder} style={{ width: '100%', height: 46, background: 'transparent', color: T.trackText, border: `1.5px solid ${T.trackText}30`, borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
            Hacer otro pedido
          </button>
        )}
      </div>
    </div>
  );
}

async function dbLoadOrder(orderNumber) {
  if (!db || !orderNumber) return null;
  // ETAPA 2: seguir el pedido por la RPC get_order_status (no expone columnas
  // financieras). Fallback al read directo si la RPC todavía no existe (ETAPA 1 sin aplicar).
  try {
    const { data, error } = await db.rpc('get_order_status', { p_order_number: orderNumber, p_restaurant_id: RESTAURANT_ID });
    if (!error) { const row = Array.isArray(data) ? data[0] : data; return row || null; }
    const missing = /PGRST202|could not find the function|42883/i.test(`${error.message || ''} ${error.code || ''}`);
    if (!missing) return null;
  } catch(e) {}
  try { const { data } = await db.from('orders').select('id,status,order_number').eq('order_number', orderNumber).maybeSingle(); return data; } catch(e) { return null; }
}

/* ══ SCREEN: CALIFICACIÓN ════════════════ */
function RatingScreen({ onDone, orderId, tableId }) {
  const T = useContext(ThemeCtx);
  const restaurant = useContext(RestaurantCtx);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [reasons, setReasons] = useState([]);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const REASONS = ['Comida', 'Atención', 'Tiempo de espera', 'Precio', 'Limpieza'];
  const toggleReason = (r) => setReasons(prev => prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r]);
  const restIg = restaurant?.instagram || '';

  const handleSubmit = async () => {
    if (!rating) return;
    setSubmitting(true);
    const fullComment = [reasons.length ? `[${reasons.join(', ')}]` : '', comment].filter(Boolean).join(' — ');
    await dbSubmitRating(orderId, tableId, rating, fullComment || null);
    setSent(true);
    setSubmitting(false);
  };

  if (sent) return (
    <div style={{ minHeight: '100%', background: T.rateBg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 40, textAlign: 'center' }}>
      <div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.heroSz, color: T.rateText, marginBottom: 12 }}>¡Gracias!</div>
      <div style={{ fontSize: 14, color: T.rateSub, lineHeight: 1.7, marginBottom: 32 }}>Tu opinión nos ayuda<br />a ser mejores cada día.</div>
      {rating >= 4 && restIg && (
        <a href={`https://www.instagram.com/${restIg.replace('@','')}`} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 44, padding: '0 20px', background: `${T.rateText}10`, border: `1px solid ${T.rateText}20`, borderRadius: 12, fontSize: 13, fontWeight: 700, color: T.rateText, textDecoration: 'none', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", marginBottom: 16 }}>
          <Icon name="instagram" size={15} color={T.rateText} />Seguinos en Instagram
        </a>
      )}
      <button onClick={onDone} style={{ width: '100%', height: 52, background: T.rateText, color: T.rateBg, border: 'none', borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 16, fontWeight: 800, cursor: 'pointer' }}>Volver al inicio</button>
    </div>
  );

  return (
    <div style={{ minHeight: '100%', background: T.rateBg, display: 'flex', flexDirection: 'column', padding: '56px 24px 36px' }}>
      <div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.heroSz, color: T.rateText, lineHeight: 1.1, marginBottom: 6 }}>¿Cómo estuvo<br />tu experiencia?</div>
      <div style={{ fontSize: 13, color: T.rateSub, marginBottom: 32 }}>{restaurant?.name || 'Restaurante'} · {tableLabel()}</div>
      {/* Estrellas */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
        {[1,2,3,4,5].map(s => <button key={s} onMouseEnter={() => setHover(s)} onMouseLeave={() => setHover(0)} onClick={() => setRating(s)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, transition: 'transform 150ms', transform: (hover || rating) >= s ? 'scale(1.12)' : 'scale(1)' }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill={(hover || rating) >= s ? T.rateText : 'transparent'} stroke={(hover || rating) >= s ? T.rateText : `${T.rateText}25`} strokeWidth="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
        </button>)}
      </div>
      {/* Mensajes contextuales */}
      {rating > 0 && rating <= 3 && (
        <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', borderRadius: 8, padding: '8px 12px', marginBottom: 16, fontSize: 12, color: '#B91C1C', lineHeight: 1.5 }}>
          Lamentamos que no haya sido lo esperado. Contanos qué mejorar.
        </div>
      )}
      {rating >= 4 && (
        <div style={{ background: 'rgba(22,163,74,0.08)', border: '1px solid rgba(22,163,74,0.15)', borderRadius: 8, padding: '8px 12px', marginBottom: 16, fontSize: 12, color: '#15803D', fontWeight: 600, lineHeight: 1.5 }}>
          ¡Nos alegra que hayas disfrutado! Esperamos verte pronto.
        </div>
      )}
      {/* Chips de motivos */}
      {rating > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: T.rateSub, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 10 }}>¿Qué querés calificar?</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {REASONS.map(r => {
              const sel = reasons.includes(r);
              return <button key={r} onClick={() => toggleReason(r)} style={{ height: 32, padding: '0 12px', borderRadius: 9999, border: `1.5px solid ${sel ? T.rateText : `${T.rateText}25`}`, background: sel ? T.rateText : 'transparent', color: sel ? T.rateBg : `${T.rateText}65`, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", transition: 'all 150ms' }}>{r}</button>;
            })}
          </div>
        </div>
      )}
      {/* Comentario */}
      <div style={{ fontSize: 11, fontWeight: 700, color: T.rateSub, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>
        {rating > 0 && rating <= 3 ? 'Contanos qué pasó' : 'Comentario o sugerencia'}
      </div>
      <textarea value={comment} onChange={e => setComment(e.target.value)} placeholder={rating > 0 && rating <= 3 ? '¿Qué salió mal? ¿Cómo podemos mejorar?' : '¿Qué fue lo mejor? ¿Algo para mejorar?'} style={{ flex: 1, minHeight: 90, border: `1px solid ${T.rateInputBorder}`, borderRadius: 12, padding: '12px', fontSize: 13, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: T.rateInputText, background: T.rateInput, resize: 'none', outline: 'none', marginBottom: 20 }} />
      <button onClick={handleSubmit} disabled={!rating || submitting} style={{ width: '100%', height: 54, background: rating ? T.rateText : `${T.rateText}12`, color: rating ? T.rateBg : `${T.rateText}30`, border: 'none', borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 16, fontWeight: 800, cursor: rating ? 'pointer' : 'default', transition: 'all 250ms', opacity: submitting ? 0.7 : 1 }}>
        {submitting ? 'Enviando…' : 'Enviar calificación'}
      </button>
    </div>
  );
}

/* ══ SCREEN: RESERVAR MESA ══════════════ */
const OCCASIONS = [
  { id: 'birthday',     label: 'Cumpleaños' },
  { id: 'anniversary',  label: 'Aniversario' },
  { id: 'business',     label: 'Reunión' },
  { id: 'celebration',  label: 'Celebración' },
  { id: 'other',        label: 'Otro motivo' },
];

const ZONES = [
  { id: 'salon',    label: 'Salón' },
  { id: 'terraza',  label: 'Terraza' },
  { id: 'bar',      label: 'Bar' },
  { id: 'privado',  label: 'Privado' },
];

function ReservationScreen({ onBack, onDone }) {
  const T = useContext(ThemeCtx);
  const restaurant = useContext(RestaurantCtx);
  const restName = restaurant?.name || 'Restaurante';
  const [form, setForm] = useState({ name: '', phone: '', date: '', time: '', guests: 2, preferred_zone: '', table_id: '', occasion: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [done, setDone] = useState(null);
  const [tables, setTables] = useState([]);

  // Fecha del local (Paraguay = UTC-3), no UTC: con `toISOString()` el mínimo del
  // selector pasaba a ser MAÑANA desde las 21:00 y el comensal no podía reservar
  // para esa misma noche.
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: (restaurant && restaurant.timezone) || 'America/Asuncion' });

  React.useEffect(() => {
    dbLoadTables().then(setTables);
  }, []);

  // Zonas que realmente tienen mesas en este restaurante
  const availableZones = React.useMemo(() => {
    const setZ = new Set(tables.map(t => t.zona || 'salon'));
    return ZONES.filter(z => setZ.has(z.id));
  }, [tables]);

  // Mesas filtradas por la zona elegida (capacidad >= comensales)
  const tablesInZone = React.useMemo(() => {
    if (!form.preferred_zone) return [];
    return tables
      .filter(t => (t.zona || 'salon') === form.preferred_zone)
      .filter(t => !t.capacity || t.capacity >= form.guests);
  }, [tables, form.preferred_zone, form.guests]);

  const handleSubmit = async () => {
    if (!form.name || !form.phone || !form.date || !form.time || !form.preferred_zone) return;
    setSaving(true);
    setSaveErr('');
    const confirmNum = 'R-' + String(Math.floor(Date.now() % 90000) + 10000);
    const r = await dbSaveReservation({ ...form, restaurant_id: RESTAURANT_ID, confirm_num: confirmNum });
    setSaving(false);
    // Sólo se muestra el número de confirmación si la reserva REALMENTE quedó
    // guardada. Confirmar sin haber guardado deja al comensal viajando a un local
    // que no lo espera.
    if (!r || !r.ok) { setSaveErr('No pudimos tomar tu reserva. Revisá tu conexión y probá de nuevo.'); return; }
    setDone({ confirmNum, phone: form.phone });
  };

  if (done) return (
    <div style={{ minHeight: '100%', background: T.black, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 28px', textAlign: 'center' }}>
      <div style={{ width: 72, height: 72, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 24 }}><Icon name="check" size={32} color="#fff" sw={2} /></div>
      <div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.heroSz, color: '#fff', marginBottom: 10 }}>¡Reserva enviada!</div>
      <div style={{ fontSize: 13, color: '#6E6E73', lineHeight: 1.7, marginBottom: 8 }}>Tu solicitud fue recibida. Te confirmaremos pronto.</div>
      <div style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, padding: '14px 24px', width: '100%', marginBottom: 12, textAlign: 'left' }}>
        <div style={{ fontSize: 10, color: '#86868B', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>Nro. de confirmación</div>
        <div style={{ fontFamily: "'SF Mono',ui-monospace,monospace", fontSize: 20, fontWeight: 500, color: '#fff' }}>{done.confirmNum}</div>
      </div>
      <div style={{ background: '#1a1a2e', border: '1px solid #2a2a4a', borderRadius: 10, padding: '12px 16px', width: '100%', marginBottom: 12, textAlign: 'left', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#FF9500" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <div style={{ fontSize: 11, color: '#fbbf24', lineHeight: 1.6 }}>
          Tolerancia de <strong>15 minutos</strong>. Si no llegás a tiempo, la mesa queda disponible para otros clientes.
        </div>
      </div>
      <div style={{ background: '#0D1F0D', border: '1px solid #1a3a1a', borderRadius: 10, padding: '12px 16px', width: '100%', marginBottom: 32, textAlign: 'left', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="#34C759" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.12 1.18 2 2 0 012.11 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" /></svg>
        <div style={{ fontSize: 12, color: '#86efac', lineHeight: 1.6 }}>
          Te confirmaremos tu reserva por WhatsApp al <strong>{done.phone}</strong>.
        </div>
      </div>
      <button onClick={onDone} style={{ width: '100%', height: 52, background: '#fff', color: '#000', border: 'none', borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 16, fontWeight: 800, cursor: 'pointer' }}>Volver al inicio</button>
    </div>
  );

  const f = (k, v) => setForm(prev => {
    const next = { ...prev, [k]: v };
    // Si cambia la zona, resetear la mesa elegida
    if (k === 'preferred_zone' && prev.preferred_zone !== v) next.table_id = '';
    // Si cambia guests y la mesa actual no soporta, resetear
    if (k === 'guests') {
      const t = tables.find(x => x.id === prev.table_id);
      if (t && t.capacity && t.capacity < v) next.table_id = '';
    }
    return next;
  });
  const canSubmit = form.name && form.phone && form.date && form.time && form.preferred_zone;
  const inputSt = { width: '100%', height: 44, border: `1.5px solid ${T.border}`, borderRadius: 10, padding: '0 12px', fontSize: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: T.ink, background: T.offwhite, outline: 'none', boxSizing: 'border-box' };

  return (
    <div style={{ minHeight: '100%', background: T.offwhite, display: 'flex', flexDirection: 'column' }}>
      <div style={{ background: T.hdrBg, padding: '52px 20px 20px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
          <button onClick={onBack} style={{ width: 38, height: 38, background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon name="back" size={17} color={T.hdrText} /></button>
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

        {/* Motivo / ocasión */}
        <div style={{ background: T.white, borderRadius: 14, padding: '18px 16px', marginBottom: 14, border: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 14 }}>Motivo de la visita <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(opcional)</span></div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {OCCASIONS.map(occ => (
              <button key={occ.id} onClick={() => f('occasion', form.occasion === occ.id ? '' : occ.id)} style={{ padding: '8px 14px', borderRadius: 20, border: `2px solid ${form.occasion === occ.id ? T.black : T.border}`, background: form.occasion === occ.id ? T.black : 'transparent', color: form.occasion === occ.id ? T.white : T.ink, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", transition: 'all 150ms' }}>{occ.label}</button>
            ))}
          </div>
        </div>

        {/* Zona (obligatorio) */}
        {availableZones.length > 0 && (
          <div style={{ background: T.white, borderRadius: 14, padding: '18px 16px', marginBottom: 14, border: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 14 }}>¿Dónde te gustaría sentarte? <span style={{ color: '#FF3B30' }}>*</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10 }}>
              {availableZones.map(z => {
                const active = form.preferred_zone === z.id;
                return (
                  <button key={z.id} onClick={() => f('preferred_zone', z.id)}
                    style={{ padding: '16px 10px', borderRadius: 12, border: `2px solid ${active ? T.black : T.border}`, background: active ? T.black : 'transparent', color: active ? T.white : T.ink, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms' }}>
                    <span>{z.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Mesa específica (opcional, filtrada por zona) */}
        {form.preferred_zone && tablesInZone.length > 0 && (
          <div style={{ background: T.white, borderRadius: 14, padding: '18px 16px', marginBottom: 14, border: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 14 }}>Mesa preferida <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(opcional)</span></div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={() => f('table_id', '')} style={{ padding: '8px 14px', borderRadius: 20, border: `2px solid ${!form.table_id ? T.black : T.border}`, background: !form.table_id ? T.black : 'transparent', color: !form.table_id ? T.white : T.ink, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>Sin preferencia</button>
              {tablesInZone.map(t => (
                <button key={t.id} onClick={() => f('table_id', t.id)} style={{ padding: '8px 14px', borderRadius: 20, border: `2px solid ${form.table_id === t.id ? T.black : T.border}`, background: form.table_id === t.id ? T.black : 'transparent', color: form.table_id === t.id ? T.white : T.ink, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>Mesa {t.number}{t.capacity ? ` (${t.capacity}p)` : ''}</button>
              ))}
            </div>
          </div>
        )}
        {form.preferred_zone && tablesInZone.length === 0 && (
          <div style={{ background: '#1a1200', border: '1px solid #3a2800', borderRadius: 10, padding: '12px 14px', marginBottom: 14, fontSize: 11, color: '#fbbf24', lineHeight: 1.6 }}>
            No hay mesas con capacidad para {form.guests} en esta zona. El restaurante te asignará la mejor opción al confirmar.
          </div>
        )}

        {/* Datos de contacto */}
        <div style={{ background: T.white, borderRadius: 14, padding: '18px 16px', marginBottom: 14, border: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 14 }}>Datos de contacto</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input value={form.name} onChange={e => f('name', e.target.value)} placeholder="Nombre completo *" style={inputSt} />
            <div style={{ display: 'flex', alignItems: 'center', border: `1.5px solid ${T.border}`, borderRadius: 10, overflow: 'hidden', background: T.offwhite }}>
              <div style={{ padding: '0 12px', height: 44, display: 'flex', alignItems: 'center', borderRight: `1px solid ${T.border}`, flexShrink: 0 }}>
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={T.silver} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.12 1.18 2 2 0 012.11 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" /></svg>
              </div>
              <input value={form.phone} onChange={e => f('phone', e.target.value)} placeholder="+595 9XX XXX XXX *" type="tel" style={{ flex: 1, height: 44, border: 'none', padding: '0 14px', fontSize: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: T.ink, background: 'transparent', outline: 'none' }} />
            </div>
            <textarea value={form.notes} onChange={e => f('notes', e.target.value)} placeholder="Comentarios adicionales, alergias, pedidos especiales…" rows={3} style={{ border: `1.5px solid ${T.border}`, borderRadius: 10, padding: '12px 14px', fontSize: 13, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: T.ink, background: T.offwhite, outline: 'none', resize: 'none', width: '100%', boxSizing: 'border-box' }} />
          </div>
        </div>

        {/* Advertencia tolerancia */}
        <div style={{ background: '#1a1200', border: '1px solid #3a2800', borderRadius: 10, padding: '12px 14px', marginBottom: 12, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#FF9500" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <div style={{ fontSize: 11, color: '#fbbf24', lineHeight: 1.7 }}>
            <strong>Tolerancia de 15 minutos.</strong> Si no llegás dentro de los 15 minutos de la hora reservada, la mesa será liberada para otros comensales.
          </div>
        </div>

        {/* Confirmación WhatsApp */}
        <div style={{ background: '#0D1F0D', border: '1px solid #1a3a1a', borderRadius: 10, padding: '12px 14px', marginBottom: 20, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#34C759" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.12 1.18 2 2 0 012.11 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" /></svg>
          <div style={{ fontSize: 11, color: '#86efac', lineHeight: 1.7 }}>
            Te confirmaremos la reserva por <strong>WhatsApp</strong> con anticipación. No se requiere seña.
          </div>
        </div>

        {saveErr && (
          <div role="alert" style={{ background: '#2a1215', border: '1px solid #5c1f26', borderRadius: 10, padding: '12px 16px', marginBottom: 12, fontSize: 12, color: '#fca5a5', lineHeight: 1.6 }}>
            {saveErr}
          </div>
        )}
        <button onClick={handleSubmit} disabled={!canSubmit || saving} style={{ width: '100%', height: 54, background: canSubmit ? T.btnPrimary : T.light, color: canSubmit ? T.btnPrimaryText : T.silver, border: 'none', borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 16, fontWeight: 800, cursor: canSubmit ? 'pointer' : 'default', marginBottom: 32, transition: 'all 200ms', opacity: saving ? 0.7 : 1 }}>
          {saving ? 'Enviando…' : 'Confirmar reserva'}
        </button>
      </div>
    </div>
  );
}

/* ══ MODAL: DIVIDIR CUENTA ══════════════ */
function SplitBillModal({ items, total, onClose }) {
  const T = useContext(ThemeCtx);
  const [people, setPeople] = useState(2);
  const [assignments, setAssignments] = useState({});

  const personColors = ['#007AFF','#FF3B30','#34C759','#FF9500','#8b5cf6','#ec4899','#14b8a6','#FF9500'];

  const assign = (itemIdx, person) => {
    setAssignments(prev => ({ ...prev, [itemIdx]: person }));
  };

  const personTotals = Array.from({ length: people }, (_, i) => {
    const pItems = items.filter((_, idx) => assignments[idx] === i + 1);
    return pItems.reduce((s, ci) => s + ci.total, 0);
  });

  const unassignedTotal = items.reduce((s, ci, idx) => !assignments[idx] ? s + ci.total : s, 0);
  const perPersonUnassigned = unassignedTotal > 0 ? Math.round(unassignedTotal / people) : 0;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'flex-end' }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(2px)' }} />
      <div style={{ position: 'relative', width: '100%', background: T.white, borderRadius: '20px 20px 0 0', maxHeight: '88%', display: 'flex', flexDirection: 'column', animation: 'slideUp 300ms cubic-bezier(0.16,1,0.3,1)' }}>
        <div style={{ padding: '16px 20px 12px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: T.border, margin: '0 auto 14px' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: T.F.titleSz, color: T.ink }}>Dividir cuenta</div>
              <div style={{ fontSize: 11, color: T.silver, marginTop: 2 }}>Solo para uso del mozo</div>
            </div>
            <button onClick={onClose} style={{ width: 34, height: 34, borderRadius: '50%', background: T.light, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="x" size={16} color={T.ink} /></button>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
          {/* Selector de personas */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 10 }}>¿Cuántos comensales?</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {[2,3,4,5,6,7,8].map(n => (
                <button key={n} onClick={() => { setPeople(n); setAssignments({}); }} style={{ width: 38, height: 38, borderRadius: 9, border: `2px solid ${people === n ? T.black : T.border}`, background: people === n ? T.black : 'transparent', color: people === n ? T.white : T.mid, fontSize: 14, fontWeight: 800, cursor: 'pointer', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", transition: 'all 150ms' }}>{n}</button>
              ))}
            </div>
          </div>

          {/* Asignar ítems */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 10 }}>Asignar cada ítem</div>
            {items.map((ci, idx) => (
              <div key={idx} style={{ background: T.light, borderRadius: 10, padding: '10px 12px', marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: T.ink }}>{ci.item.name}</span>
                  <span style={{ fontSize: 13, color: T.gray, fontFamily: "'SF Mono',ui-monospace,monospace,monospace" }}>{fmt(ci.total)}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button onClick={() => assign(idx, null)} style={{ height: 28, padding: '0 10px', borderRadius: 7, border: `1.5px solid ${!assignments[idx] ? T.black : T.border}`, background: !assignments[idx] ? T.black : 'transparent', color: !assignments[idx] ? T.white : T.mid, fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>Dividir</button>
                  {Array.from({ length: people }, (_, i) => i + 1).map(p => (
                    <button key={p} onClick={() => assign(idx, p)} style={{ height: 28, minWidth: 28, padding: '0 10px', borderRadius: 7, border: `1.5px solid ${assignments[idx] === p ? personColors[p-1] : T.border}`, background: assignments[idx] === p ? personColors[p-1] : 'transparent', color: assignments[idx] === p ? '#fff' : T.mid, fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", transition: 'all 150ms' }}>P{p}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Resumen por persona */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.silver, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 10 }}>Resumen por comensal</div>
            {Array.from({ length: people }, (_, i) => {
              const base = personTotals[i];
              const share = base + perPersonUnassigned;
              return (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: T.light, borderRadius: 10, marginBottom: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 26, height: 26, borderRadius: '50%', background: personColors[i], display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: '#fff' }}>P{i+1}</div>
                    <span style={{ fontSize: 13, color: T.mid }}>
                      {perPersonUnassigned > 0 ? `Base + parte compartida` : `Ítems asignados`}
                    </span>
                  </div>
                  <span style={{ fontFamily: "'SF Mono',ui-monospace,monospace,monospace", fontSize: 16, fontWeight: 800, color: T.ink }}>{fmt(share)}</span>
                </div>
              );
            })}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', borderTop: `1px solid ${T.border}`, marginTop: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: T.ink }}>Total cuenta</span>
              <span style={{ fontFamily: "'SF Mono',ui-monospace,monospace,monospace", fontSize: 16, fontWeight: 800, color: T.ink }}>{fmt(total)}</span>
            </div>
          </div>
        </div>

        <div style={{ padding: '12px 20px 32px', borderTop: `1px solid ${T.border}`, flexShrink: 0 }}>
          <button onClick={onClose} style={{ width: '100%', height: 50, background: T.btnPrimary, color: T.btnPrimaryText, border: 'none', borderRadius: 14, fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 15, fontWeight: 800, cursor: 'pointer' }}>Listo</button>
        </div>
      </div>
    </div>
  );
}

/* ══ PANTALLAS QR ════════════════════════ */
function QRCheckingScreen() {
  return (
    <div style={{minHeight:'100%',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',background:'#000',gap:16}}>
      <div style={{width:40,height:40,border:'3px solid rgba(255,255,255,0.15)',borderTopColor:'#fff',borderRadius:'50%',animation:'spin 0.7s linear infinite'}}/>
      <div style={{color:'rgba(255,255,255,0.5)',fontSize:13}}>Verificando mesa…</div>
    </div>
  );
}

function MesaLlenaScreen({scanCount, maxScans}) {
  return (
    <div style={{minHeight:'100%',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',background:'#000',padding:'40px 32px',textAlign:'center',gap:16}}>
      <div style={{lineHeight:1,display:'flex'}}><Icon name="alert" size={56} color="#fff" /></div>
      <div style={{fontSize:26,fontWeight:900,color:'#fff',letterSpacing:'-0.5px'}}>Mesa llena</div>
      <div style={{fontSize:14,color:'rgba(255,255,255,0.55)',lineHeight:1.7,maxWidth:280}}>
        Esta mesa ya alcanzó el límite de {maxScans||'?'} dispositivos.
        <br/>Pedile a alguien compartir la pantalla.
      </div>
      {scanCount && maxScans && <div style={{marginTop:4,fontSize:12,color:'rgba(255,255,255,0.3)'}}>{scanCount}/{maxScans} escaneos</div>}
    </div>
  );
}

function MesaReservadaScreen({firstName, time, onConfirm, onSkip}) {
  const T = useContext(ThemeCtx);
  const timeStr = time ? String(time).slice(0,5) : '';
  return (
    <div style={{minHeight:'100%',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',background:T.qrBg,padding:'40px 28px',textAlign:'center',gap:20}}>
      <div style={{lineHeight:1,display:'flex'}}><Icon name="calendar" size={48} color={T.qrText} /></div>
      <div style={{display:'flex',flexDirection:'column',gap:6}}>
        <div style={{fontSize:22,fontWeight:900,color:T.qrText,letterSpacing:'-0.5px',lineHeight:1.2}}>Esta mesa tiene<br/>una reserva</div>
        {timeStr && <div style={{fontSize:13,color:T.qrSub}}>Hora: {timeStr}</div>}
      </div>
      <div style={{fontSize:16,color:T.qrText,fontWeight:700,lineHeight:1.5}}>
        ¿Sos <span style={{color:'#FF9500'}}>{firstName}</span>?
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:10,width:'100%',maxWidth:300}}>
        <button onClick={onConfirm} style={{width:'100%',height:52,background:T.white,color:T.black,border:'none',borderRadius:12,fontSize:15,fontWeight:800,cursor:'pointer'}}>
          Sí, soy {firstName}
        </button>
        <button onClick={onSkip} style={{width:'100%',height:44,background:'transparent',color:T.qrSub,border:`1px solid rgba(255,255,255,0.15)`,borderRadius:12,fontSize:13,fontWeight:600,cursor:'pointer'}}>
          No, no tengo reserva
        </button>
      </div>
    </div>
  );
}

/* ══ SCREEN: SIN CONTEXTO DE RESTAURANTE ══
   El panel cliente NO es genérico: siempre corresponde a un local concreto,
   resuelto por el QR de la mesa o el link que comparte el restaurante (?r=).
   Si se abre sin contexto (o el restaurante no existe), mostramos una guía
   en vez de un menú demo. */
function GateScreen({ kind, message }) {
  const T = useContext(ThemeCtx);
  const COPY = {
    'no-context': {
      icon: <Icon name="link" size={52} color={T.qrText} />,
      title: 'Escaneá el QR del local',
      body: 'Este enlace no identifica a ningún restaurante. Escaneá el código QR de tu mesa o abrí el link que te compartió el local para ver su menú y hacer tu pedido.',
    },
    'not-found': {
      icon: <Icon name="store" size={52} color={T.qrText} />,
      title: 'Restaurante no disponible',
      body: 'No encontramos este restaurante. Puede que el enlace haya cambiado o que el local todavía no esté activo. Pedí un QR o link actualizado.',
    },
    // Local en mantenimiento / suspendido / inactivo: se ve la marca pero no se puede pedir.
    'unavailable': {
      icon: <Icon name="store" size={52} color={T.qrText} />,
      title: 'Local no disponible por ahora',
      body: (message && String(message).trim())
        ? String(message).trim()
        : 'Este local no está tomando pedidos en este momento. Volvé a intentarlo más tarde.',
    },
    // Servicio del local cortado por facturación (mig 193). Copy NEUTRO a
    // propósito: al comensal no se le cuenta la situación de pago del comercio.
    'service-off': {
      icon: <Icon name="store" size={52} color={T.qrText} />,
      title: 'Pedidos no disponibles',
      body: 'Este local no está recibiendo pedidos por el momento. Consultá con el personal del restaurante.',
    },
    // Modo delivery (mig 173): el local no atiende en salón → el Menú QR se
    // reemplaza por un acceso directo al pedido a domicilio.
    'delivery-only': {
      icon: <Icon name="bike" size={52} color={T.qrText} />,
      title: 'Este local atiende por delivery',
      body: 'Este restaurante trabaja solo con pedidos a domicilio. Tocá el botón para hacer tu pedido por delivery.',
    },
  };
  const c = COPY[kind] || COPY['no-context'];
  return (
    <div style={{ minHeight: '100%', background: T.qrBg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 32px', textAlign: 'center', gap: 16 }}>
      <div style={{ fontSize: 54, lineHeight: 1 }}>{c.icon}</div>
      <div style={{ fontFamily: T.F.h, fontWeight: T.F.hW, fontSize: 22, color: T.qrText, lineHeight: 1.25 }}>{c.title}</div>
      <div style={{ fontSize: 14, color: T.qrSub, lineHeight: 1.7, maxWidth: 300 }}>{c.body}</div>
      {kind === 'delivery-only' && RESTAURANT_ID && (
        <a href={`delivery-cliente.html?r=${encodeURIComponent(RESTAURANT_ID)}`}
           style={{ marginTop: 8, background: T.qrText, color: T.qrBg, textDecoration: 'none', fontWeight: 700, fontSize: 14, padding: '12px 22px', borderRadius: 12 }}>
          Pedir por delivery
        </a>
      )}
    </div>
  );
}

/* ══ APP ROOT ════════════════════════════ */
function App() {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const theme = makeTheme(tweaks.mood, tweaks.tipo, tweaks.carta);

  // ── Sesión QR (cuando viene de ?t=TOKEN) ──
  const [scanStatus,      setScanStatus]      = useState(TABLE_TOKEN ? 'checking' : 'ok');
  const [scanData,        setScanData]        = useState({scanCount:0, maxScans:0});
  const [reservationInfo, setReservationInfo] = useState(null); // {firstName, time, guests}

  /* ── Capacidades PÚBLICAS del local (mig 192) ──
     Esta pantalla corre como `anon`, y get_restaurant_capabilities le devuelve NULL
     por el guard tenant-safe (mig 108): el Menú QR NO puede ver el plan, y por eso
     ofrecía "Reservar mesa" aunque el plan no incluyera Agenda.
     get_public_capabilities expone solo flags de cara al cliente. FAIL-OPEN: si la
     RPC no está aplicada todavía o falla, se muestra todo como antes. */
  const [canReserve, setCanReserve] = useState(true);
  // `ordering === false` (mig 193) = el local no tiene el servicio activo (suscripción
  // vencida + gracia agotada). Se corta ACÁ, antes de que el comensal arme un carrito
  // que la base va a rechazar igual. El motivo real NO se le muestra al cliente.
  const [serviceOff, setServiceOff] = useState(false);
  useEffect(() => {
    if (!db || !RESTAURANT_ID) return;
    let alive = true;
    db.rpc('get_public_capabilities', { p_restaurant_id: RESTAURANT_ID })
      .then(({ data, error }) => {
        if (!alive || error || !data) return;      // fail-open
        if (data.reservations === false) setCanReserve(false);
        if (data.ordering === false) setServiceOff(true);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!TABLE_TOKEN || !db) { setScanStatus('ok'); return; }
    (async () => {
      try {
        const { data: tbl } = await db.from('tables')
          .select('id,number,capacity')
          .eq('qr_token', TABLE_TOKEN)
          .eq('restaurant_id', RESTAURANT_ID)
          .maybeSingle();
        if (!tbl) { setScanStatus('ok'); return; }
        _tableUUID = tbl.id;
        TABLE_NUM  = tbl.number;

        const { data: res, error } = await db.rpc('join_table_session', { p_table_id: tbl.id });
        if (error || !res) { setScanStatus('ok'); return; }
        if (!res.allowed) {
          setScanData({ scanCount: res.scan_count, maxScans: res.max_scans });
          setScanStatus('full');
          return;
        }

        // Verificar si hay reserva próxima para esta mesa
        const { data: resv } = await db.rpc('get_table_upcoming_reservation', { p_table_id: tbl.id });
        if (resv && resv.first_name) {
          setReservationInfo({ firstName: resv.first_name, time: resv.time, guests: resv.guests });
          setScanStatus('reserved');
        } else {
          setScanStatus('ok');
        }
      } catch(e) { setScanStatus('ok'); }
    })();
  }, []);

  // ── Persistencia localStorage ──
  const [screen, setScreen] = useState(() => {
    try {
      const s = localStorage.getItem(lsk('app_screen'));
      const validScreens = ['menu','cart','pay','track','rate'];
      if (validScreens.includes(s)) return s;
      // El cliente llega por un QR real (mesa o mostrador): sin pantalla demo de escaneo.
      return 'profile';
    } catch { return 'profile'; }
  });
  // Si las capacidades llegan tarde y el cliente ya estaba en "reservar" (pantalla
  // persistida o link viejo), lo devolvemos al inicio en cuanto se sabe que no aplica.
  useEffect(() => {
    if (!canReserve && screen === 'reserve') setScreen('profile');
  }, [canReserve, screen]);

  const [cartItems, setCartItems] = useState(() => {
    try { return JSON.parse(localStorage.getItem(lsk('app_cart')) || '[]'); } catch { return []; }
  });
  const [currentOrderNum, setCurrentOrderNum] = useState(() => {
    try { return localStorage.getItem(lsk('app_order_num')) || null; } catch { return null; }
  });
  // Todos los N° de pedido de esta sesión/mesa → "Ver mis pedidos" sin perder el anterior
  // al hacer otro pedido. Se vacía sólo con clearSession (cierre total de la sesión).
  const [sessionOrders, setSessionOrders] = useState(() => {
    try { const a = JSON.parse(localStorage.getItem(lsk('app_session_orders')) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
  });

  useEffect(() => { try { localStorage.setItem(lsk('app_screen'), screen); } catch {} }, [screen]);
  useEffect(() => { try { localStorage.setItem(lsk('app_cart'), JSON.stringify(cartItems)); } catch {} }, [cartItems]);
  useEffect(() => { try { if (currentOrderNum) localStorage.setItem(lsk('app_order_num'), currentOrderNum); } catch {} }, [currentOrderNum]);
  useEffect(() => { try { localStorage.setItem(lsk('app_session_orders'), JSON.stringify(sessionOrders)); } catch {} }, [sessionOrders]);
  // NOTA (PR-5): los efectos que persisten payTotal/paySubtotal/payDiscount/payCoupon se movieron
  // más abajo, justo después de declarar esos estados. Antes estaban acá, ANTES de su `const … =
  // useState(…)`, y sus arrays de dependencias (evaluados en render) los leían adelantados. Babel
  // los compilaba a `var` (hoisted → undefined, sin crash); con Vite/ESM el `const` real lanza
  // "Cannot access 'payTotal' before initialization" (TDZ) y dejaba el panel cliente en blanco.

  const clearSession = () => {
    try {
      localStorage.removeItem(lsk('app_screen')); localStorage.removeItem(lsk('app_cart')); localStorage.removeItem(lsk('app_order_num'));
      localStorage.removeItem(lsk('app_session_orders'));
      localStorage.removeItem(lsk('app_pay_total')); localStorage.removeItem(lsk('app_pay_sub'));
      localStorage.removeItem(lsk('app_pay_disc')); localStorage.removeItem(lsk('app_pay_coupon'));
    } catch {}
    setCartItems([]); setCurrentOrderNum(null); setSessionOrders([]); setPayTotal(0); setPaySubtotal(0); setPayDiscount(0); setPayCoupon(''); setScreen('profile');
  };

  // Registra un pedido enviado: lo deja como "actual" y lo suma a la lista de la sesión
  // (sin duplicar). Lo llaman tanto "Seguir mi pedido" como "Hacer otro pedido".
  const registerOrder = (ordNum) => {
    if (!ordNum) return;
    setCurrentOrderNum(ordNum);
    setSessionOrders(prev => prev.includes(ordNum) ? prev : [...prev, ordNum]);
  };

  // "Hacer otro pedido": vuelve al menú a armar un nuevo pedido limpiando SOLO el carrito
  // (+ campos de pago). NO toca el seguimiento: currentOrderNum y sessionOrders se conservan.
  // ordNum/method vienen del paso 'ok' del pago (donde onDone podría no haberse llamado).
  const goNewOrder = (ordNum, method) => {
    if (ordNum) registerOrder(ordNum);
    if (method) setPayMethod(method);
    try {
      localStorage.removeItem(lsk('app_cart'));
      localStorage.removeItem(lsk('app_pay_total')); localStorage.removeItem(lsk('app_pay_sub'));
      localStorage.removeItem(lsk('app_pay_disc')); localStorage.removeItem(lsk('app_pay_coupon'));
    } catch {}
    setCartItems([]); setPayTotal(0); setPaySubtotal(0); setPayDiscount(0); setPayCoupon('');
    setScreen('menu');
  };

  // ── Estado UI ──
  const [orderMode, setOrderMode]   = useState('eat');
  const [lang, setLang]             = useState('es');
  const [selItem, setSelItem]       = useState(null);
  const [showSplit, setShowSplit]   = useState(false);
  const [payTotal, setPayTotal]     = useState(() => { try { return Number(localStorage.getItem(lsk('app_pay_total')) || 0); } catch { return 0; } });
  const [paySubtotal, setPaySubtotal] = useState(() => { try { return Number(localStorage.getItem(lsk('app_pay_sub')) || 0); } catch { return 0; } });
  const [payDiscount, setPayDiscount] = useState(() => { try { return Number(localStorage.getItem(lsk('app_pay_disc')) || 0); } catch { return 0; } });
  const [payCoupon, setPayCoupon]   = useState(() => { try { return localStorage.getItem(lsk('app_pay_coupon')) || ''; } catch { return ''; } });

  // PR-5: reubicados aquí (después de declarar los estados pay*) para evitar el TDZ que rompía el
  // panel con Vite. Comportamiento equivalente al original (persistencia de los campos de pago).
  useEffect(() => { try { localStorage.setItem(lsk('app_pay_total'), payTotal); } catch {} }, [payTotal]);
  useEffect(() => { try { localStorage.setItem(lsk('app_pay_sub'), paySubtotal); } catch {} }, [paySubtotal]);
  useEffect(() => { try { localStorage.setItem(lsk('app_pay_disc'), payDiscount); } catch {} }, [payDiscount]);
  useEffect(() => { try { localStorage.setItem(lsk('app_pay_coupon'), payCoupon); } catch {} }, [payCoupon]);

  // Si el cliente recarga en pantalla de pago con total=0, volvemos al carrito de forma segura.
  useEffect(() => {
    if (screen === 'pay' && (payTotal <= 0 || !cartItems.length)) setScreen('cart');
  }, []);

  const [toast, setToast]           = useState(null);
  const [liveMenu, setLiveMenu]     = useState(null);
  const [menuStatus, setMenuStatus] = useState('loading'); // loading | ready | empty
  const [restaurant, setRestaurant] = useState(null);
  const [restaurantStatus, setRestaurantStatus] = useState('loading'); // loading | ready | notfound
  const [lastWaiterCall, setLastWaiterCall] = useState(0);
  const [payMethod, setPayMethod]   = useState('efectivo');
  const [assignedWaiterName, setAssignedWaiterName] = useState(null);

  useEffect(() => {
    if (!RESTAURANT_ID) { setRestaurantStatus('notfound'); setMenuStatus('empty'); return; }
    dbLoadMenu().then(menu => { if (menu) { setLiveMenu(menu); setMenuStatus('ready'); } else { setMenuStatus('empty'); } });
    dbLoadRestaurant().then(r => { if (r) { setRestaurant(r); setRestaurantStatus('ready'); } else { setRestaurantStatus('notfound'); } });
    dbLoadTableAssignment().then(name => { if (name) setAssignedWaiterName(name); });
    if (!db) return;
    const reload = async () => {
      const m = await dbLoadMenu();
      if (!m) { setMenuStatus('empty'); return; }
      setMenuStatus('ready');
      setLiveMenu(m);
      // Si un ítem del carrito quedó sin stock (is_available=false),
      // ya no aparece en el menú recargado → removerlo y notificar al usuario.
      const availableIds = new Set(Object.values(m).flat().map(i => i.id));
      setCartItems(prev => {
        const removed = prev.filter(ci => ci.item && !availableIds.has(ci.item.id));
        if (removed.length > 0) {
          const names = removed.map(ci => ci.item.name).join(', ');
          setTimeout(() => setToast(`"${names}" se agotó y fue removido de tu pedido`), 100);
        }
        return prev.filter(ci => !ci.item || availableIds.has(ci.item.id));
      });
    };
    const ch = db.channel('menu-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_items', filter: `restaurant_id=eq.${RESTAURANT_ID}` }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_categories', filter: `restaurant_id=eq.${RESTAURANT_ID}` }, reload)
      .subscribe();
    return () => { db.removeChannel(ch); };
  }, []);

  const showToast = (msg) => setToast(msg);
  const cartCount = cartItems.reduce((s, ci) => s + ci.qty, 0);
  const cartTotal = cartItems.reduce((s, ci) => s + ci.total, 0);

  // Estado abierto/cerrado real. El tick re-evalúa cada 60s para que el badge y el
  // bloqueo se actualicen al cruzar un borde de horario sin recargar.
  const [, setOpenTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setOpenTick(t => t + 1), 60000); return () => clearInterval(id); }, []);
  const openState = restaurantOpenState(restaurant);
  const canOrder = openState.open;

  // Disponibilidad de la cuenta (independiente del horario): mantenimiento del
  // superadmin, o restaurante suspendido/inactivo. Si aplica, NO se puede pedir
  // ni ver el menú (pantalla "no disponible"). Solo cuando el restaurante ya cargó.
  const restUnavailable = !!restaurant && (
    restaurant.maintenance_mode === true ||
    restaurant.is_active === false ||
    ['suspended', 'inactive'].includes(restaurant.status)
  );

  // Local CERRADO con carrito/pantalla persistidos (o cierre en vivo): rebotar a 'menu'
  // (muestra el banner "Cerrado"). Evita concretar un pedido fuera de horario por una
  // sesión de pago/carrito que sobrevivió al cierre. Corre cuando se resuelve canOrder.
  useEffect(() => {
    if (!canOrder && (screen === 'pay' || screen === 'cart')) setScreen('menu');
  }, [canOrder, screen]);

  const addToCart = (item, qty, extras, notes, variant = null, half = null) => {
    // Bloqueo de venta con el local CERRADO: se puede ver el menú, pero no pedir.
    if (!canOrder) { showToast(openState.next ? `Cerrado · Abre ${openState.next}. Podés ver el menú, pero no pedir ahora.` : 'El local está cerrado. Podés ver el menú, pero no pedir ahora.'); return; }
    const et = extras.reduce((s, e) => s + e.p, 0);
    // half.unitPrice = precio combinado de las 2 mitades; si no, precio del tamaño (o único).
    const unitPrice = half ? half.unitPrice : (variant ? variant.price : item.price);
    setCartItems(prev => [...prev, { item, qty, extras, notes, variant, half: half ? { secondName: half.secondName } : null, unitPrice, total: (unitPrice + et) * qty }]);
    showToast('Agregado al pedido');
  };
  const removeItem = (i) => setCartItems(prev => prev.filter((_, idx) => idx !== i));
  const updateQty = (i, d) => setCartItems(prev => prev.map((ci, idx) => {
    if (idx !== i) return ci;
    const nq = ci.qty + d; if (nq <= 0) return null;
    const et = ci.extras.reduce((s, e) => s + e.p, 0);
    const unitPrice = ci.unitPrice != null ? ci.unitPrice : ci.item.price;   // retrocompat: carritos viejos sin unitPrice
    return { ...ci, qty: nq, total: (unitPrice + et) * nq };
  }).filter(Boolean));

  const handleCallWaiter = async () => {
    const now = Date.now();
    if (now - lastWaiterCall < 30000) {
      showToast('Ya llamaste al mozo. Esperá un momento.');
      return;
    }
    setLastWaiterCall(now);
    showToast(`El mozo fue avisado — Mesa ${TABLE_NUM}`);
    await dbCallWaiter(_tableUUID, null);
  };

  return (
    <ThemeCtx.Provider value={theme}>
      <MenuCtx.Provider value={liveMenu || {}}>
        <RestaurantCtx.Provider value={restaurant}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', position: 'relative' }}>
            <div className="phone" style={{ background: theme.phoneBg }}>
              <div className="screen">
                {!RESTAURANT_ID
                  ? <GateScreen kind="no-context" />
                  : restaurantStatus === 'notfound'
                  ? <GateScreen kind="not-found" />
                  : serviceOff
                  ? <GateScreen kind="service-off" />
                  : restUnavailable
                  ? <GateScreen kind="unavailable" message={restaurant?.maintenance_mode ? restaurant?.maintenance_message : ''} />
                  : restaurant?.service_mode === 'delivery'
                  ? <GateScreen kind="delivery-only" />
                  : <>
                {scanStatus === 'checking'  && <QRCheckingScreen />}
                {scanStatus === 'full'      && <MesaLlenaScreen scanCount={scanData.scanCount} maxScans={scanData.maxScans} />}
                {scanStatus === 'reserved'  && reservationInfo && <MesaReservadaScreen firstName={reservationInfo.firstName} time={reservationInfo.time} onConfirm={()=>setScanStatus('ok')} onSkip={()=>setScanStatus('ok')} />}
                {scanStatus === 'ok' && <>
                <OfflineBanner />
                {toast && <Toast msg={toast} onHide={() => setToast(null)} />}
                {selItem && <ProductModal item={selItem} onClose={() => setSelItem(null)} onAdd={addToCart} canOrder={canOrder} openState={openState} />}
                {showSplit && <SplitBillModal items={cartItems} total={cartTotal} onClose={() => setShowSplit(false)} />}
                {screen === 'qr'      && <QRScreen onScan={() => setScreen('profile')} />}
                {screen === 'profile' && <ProfileScreen onEnter={() => setScreen('menu')} orderMode={orderMode} setOrderMode={setOrderMode} lang={lang} setLang={setLang} onCallWaiter={handleCallWaiter} onReserve={() => setScreen('reserve')} canReserve={canReserve} assignedWaiterName={assignedWaiterName} openState={openState} />}
                {/* canReserve=false → el plan no incluye Agenda: ni botón ni pantalla. */}
                {screen === 'reserve' && canReserve && <ReservationScreen onBack={() => setScreen('profile')} onDone={() => setScreen('profile')} />}
                {screen === 'menu'    && <MenuScreen onItemSelect={setSelItem} cartTotal={cartTotal} cartCount={cartCount} onViewCart={() => setScreen('cart')} onCallWaiter={handleCallWaiter} orderMode={orderMode} assignedWaiterName={assignedWaiterName} menuStatus={menuStatus} hasActiveOrder={!!currentOrderNum} onViewOrders={() => setScreen('track')} canOrder={canOrder} openState={openState} />}
                {screen === 'cart'    && <CartScreen items={cartItems} onBack={() => setScreen('menu')} onPay={(t, sub, disc, code) => { if (!canOrder) { showToast('El local está cerrado. No se puede pedir ahora.'); return; } setPayTotal(t); setPaySubtotal(sub); setPayDiscount(disc); setPayCoupon(code); setScreen('pay'); }} onRemove={removeItem} onQty={updateQty} onCouponApplied={() => {}} onSplit={() => setShowSplit(true)} orderMode={orderMode} canOrder={canOrder} openState={openState} />}
                {screen === 'pay'     && <PayScreen total={payTotal} subtotal={paySubtotal} discountAmount={payDiscount} couponCode={payCoupon} cartItems={cartItems} orderMode={orderMode} lang={lang} onBack={() => setScreen('cart')} onDone={(ordNum, method) => { registerOrder(ordNum); if (method) setPayMethod(method); setScreen('track'); }} onNewOrder={goNewOrder} canOrder={canOrder} openState={openState} />}
                {screen === 'track'   && <TrackingScreen onRate={() => setScreen('rate')} orderNumber={currentOrderNum} orderMode={orderMode} cartItems={cartItems} onCallWaiter={handleCallWaiter} assignedWaiterName={assignedWaiterName} sessionOrders={sessionOrders} onSelectOrder={setCurrentOrderNum} onNewOrder={() => goNewOrder()} />}
                {screen === 'rate'    && <RatingScreen onDone={clearSession} orderId={null} tableId={null} />}
                </>}
                </>}
              </div>
            </div>
            <TweaksPanel>
              <TweakSection title="Ambiente">
                <TweakRadio id="mood" label="Tono de color" value={tweaks.mood} onChange={v => setTweak('mood', v)} options={[{ value: 'negro', label: 'Negro' }, { value: 'blanco', label: 'Blanco' }, { value: 'sepia', label: 'Sépia' }]} />
              </TweakSection>
              <TweakSection title="Tipografía">
                <TweakRadio id="tipo" label="Personalidad" value={tweaks.tipo} onChange={v => setTweak('tipo', v)} options={[{ value: 'editorial', label: 'Editorial' }, { value: 'clasica', label: 'Clásica' }, { value: 'grotesca', label: 'Grotesca' }]} />
              </TweakSection>
              <TweakSection title="Carta">
                <TweakRadio id="carta" label="Vista de productos" value={tweaks.carta} onChange={v => setTweak('carta', v)} options={[{ value: 'clasica', label: 'Clásica' }, { value: 'amplia', label: 'Amplia' }, { value: 'lista', label: 'Lista' }]} />
              </TweakSection>
            </TweaksPanel>
          </div>
        </RestaurantCtx.Provider>
      </MenuCtx.Provider>
    </ThemeCtx.Provider>
  );
}

createRoot(document.getElementById('app')).render(<App />);
