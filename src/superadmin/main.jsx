// ════════════════════════════════════════════════════════════════════
// PR-5 — Panel superadmin precompilado con Vite (batch de migración legacy).
// Migrado 1:1 desde el <script type="text/babel"> inline de public/superadmin.html.
// Sin cambios de comportamiento ni de UI. React/createRoot vienen de npm
// (bundle Vite); el resto de globales del shell siguen en window.* (config.js,
// supabase UMD, MythosTheme/Icons/Presence/Session/Gating, XLSX, Leaflet, etc.).
// ════════════════════════════════════════════════════════════════════
import React from "react";
import { createRoot } from "react-dom/client";
// Helpers de día comercial compartidos. NUNCA usar toISOString().slice(0,10) para
// "hoy": ver el encabezado de fecha.js.
import { todayLocal, isoLocal } from "../shared/fecha.js";
import { formatGs, parseGs, GsInput } from "../shared/gs.jsx";
// CAPTCHA Turnstile (nativo de Supabase Auth) para el modal "Cambiar contraseña"
// (re-autentica con signInWithPassword).
import { useTurnstile } from "../shared/turnstile.js";

const { useState, useEffect, useCallback, useMemo, useRef, useReducer } = React;

// ── Paleta — reactiva al tema ────────────────────────────────
const PALETTES = {
  light: {
    bg:'var(--bg-subtle)', sidebar:'#FFFFFF', surface:'#FFFFFF', card:'#FFFFFF',
    border:'#D2D2D7', bStrong:'#86868B',
    white:'#FFFFFF', ink:'#1D1D1F', mid:'#6E6E73', dim:'#86868B',
    blue:'#1D1D1F', blueDim:'#F5F5F7',
    green:'#34C759', orange:'#FF9500', red:'#FF3B30',
  },
  dark: {
    bg:'#000000', sidebar:'#1C1C1E', surface:'#1C1C1E', card:'#2C2C2E',
    border:'#38383A', bStrong:'#636366',
    white:'#1C1C1E', ink:'#F5F5F7', mid:'#AEAEB2', dim:'#636366',
    blue:'#F5F5F7', blueDim:'#2C2C2E',
    green:'#30D158', orange:'#FF9F0A', red:'#FF453A',
  },
};
const C = Object.assign({}, PALETTES[window.MythosTheme ? window.MythosTheme.get() : 'light']);
if (window.MythosTheme) {
  document.addEventListener('mythos:themechange', function(e){
    Object.assign(C, PALETTES[e.detail.mode] || PALETTES.light);
  });
}

// ── Tintes de estado theme-adaptive (PR-B4C) ─────────────────
// color-mix sobre tokens (--success/--warning/--error/--info + surface/text):
// se resuelven por tema en cada paint → válidos en light Y dark, y NO se congelan
// aunque se usen dentro de objetos const (a diferencia de C, que es mutado).
// Mismo lenguaje visual que .my-badge. En light ≈ los tintes claros previos.
const TINT = {
  okBg:'color-mix(in srgb, var(--success) 15%, var(--surface))',
  okText:'color-mix(in srgb, var(--success) 68%, var(--text-primary))',
  warnBg:'color-mix(in srgb, var(--warning) 18%, var(--surface))',
  warnText:'color-mix(in srgb, var(--warning) 70%, var(--text-primary))',
  warnBorder:'color-mix(in srgb, var(--warning) 40%, transparent)',
  dangerBg:'color-mix(in srgb, var(--error) 15%, var(--surface))',
  dangerText:'color-mix(in srgb, var(--error) 70%, var(--text-primary))',
  infoBg:'color-mix(in srgb, var(--info) 14%, var(--surface))',
  infoText:'color-mix(in srgb, var(--info) 72%, var(--text-primary))',
  purpleBg:'color-mix(in srgb, #AF52DE 16%, var(--surface))',
  purpleText:'color-mix(in srgb, #AF52DE 72%, var(--text-primary))',
};

// ── Icon helper ──────────────────────────────────────────────
const Icon = ({name, size=14, style}) => (
  <span style={{display:'inline-flex',alignItems:'center',justifyContent:'center',lineHeight:0,...(style||{})}}
        dangerouslySetInnerHTML={{__html: window.MythosIcons ? window.MythosIcons.html(name, {size}) : ''}}/>
);

// ── Supabase ─────────────────────────────────────────────────
const _initDB = () => {
  const cfg = window.SUPABASE_CONFIG;
  if (!cfg?.url || !cfg?.anonKey) return null;
  const url = cfg.url.replace(/^﻿/,'').trim();
  const key = cfg.anonKey.replace(/^﻿/,'').trim();
  if (!url || url.includes('YOUR_') || !key) return null;
  try { return window.supabase.createClient(url, key); } catch(e){ return null; }
};
const db = _initDB();

/* ── Días de la prueba gratuita ───────────────────────────────
   FUENTE ÚNICA: marketing_config.trial_days (Sitio web → Prueba gratis). Se lee
   en cada alta en vez de cablear un número: el sitio comercial anuncia ESTE valor
   y api/onboarding.js otorga ESTE valor, así que un alta manual que diera otra
   duración sería una tercera versión de la misma promesa.
   TRIAL_DAYS_FALLBACK repite el de api/onboarding.js y web-marketing-data.js. */
const TRIAL_DAYS_FALLBACK = 7;
async function readTrialDays() {
  if (!db) return TRIAL_DAYS_FALLBACK;
  try {
    const { data, error } = await db.from('marketing_config').select('value').eq('key','trial_days').maybeSingle();
    if (error || !data) return TRIAL_DAYS_FALLBACK;
    const n = parseInt(data.value, 10);
    return (Number.isFinite(n) && n >= 1 && n <= 365) ? n : TRIAL_DAYS_FALLBACK;
  } catch (e) { return TRIAL_DAYS_FALLBACK; }
}
// Fin de un período nuevo: trial → los días configurados; alta paga → 1 mes.
async function subscriptionEndDate(status, from) {
  const end = new Date(from.getTime());
  if (status === 'trial') end.setDate(end.getDate() + await readTrialDays());
  else end.setMonth(end.getMonth() + 1);
  return end;
}

/* contador global — pausa el polling cuando hay modal abierto o input con foco */
let _modalCount = 0;
function _shouldPause() {
  if (_modalCount > 0) return true;
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return ['INPUT','TEXTAREA','SELECT'].includes(tag) || el.isContentEditable;
}

// ── Estado vacío (fallback sin conexión) ─────────────────────
// Sin datos ficticios: si no hay conexión a Supabase, los listados
// quedan vacíos en vez de mostrar restaurantes/planes inventados.
const DEMO = {
  restaurants:[],
  plans:[],
  addonCatalog:[],
  addons:[],
  subscriptions:[],
  orders:[],
  ratings:[],
  events:[],
  platformConfig:[],
};

// ── Utils ────────────────────────────────────────────────────
const daysUntil = d => d ? Math.ceil((new Date(d) - new Date()) / 86400000) : null;
const fmtDate = d => d ? new Date(d).toLocaleDateString('es-PY',{day:'2-digit',month:'short',year:'numeric'}) : '—';
const fmtDateTime = d => d ? new Date(d).toLocaleString('es-PY',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
// PR-SA1: "dd/mm/yyyy · HH:mm" siempre en hora de Paraguay (el navegador del
// superadmin puede estar en otra zona).
const fmtAlta = d => {
  if (!d) return '—';
  const x = new Date(d);
  return `${x.toLocaleDateString('es-PY',{timeZone:'America/Asuncion',day:'2-digit',month:'2-digit',year:'numeric'})} · ${x.toLocaleTimeString('es-PY',{timeZone:'America/Asuncion',hour:'2-digit',minute:'2-digit',hour12:false})}`;
};
// Día comercial: acá NO se llama initBusinessTZ a propósito. El superadmin es
// transversal a todos los locales, así que su "hoy" no puede ser el huso de uno en
// particular — es el de la PLATAFORMA, o sea el default del módulo
// (TZ_DEFAULT = America/Asuncion). Si algún día la plataforma opera desde otro huso,
// se cambia ahí y no acá. Lo que sí importa es no volver a UTC:
// `toISOString().slice(0,10)` desde las 21:00 de Paraguay ya devuelve mañana, y eso
// corría los KPIs de "hoy" y las fechas guardadas (alta, inicio/fin de suscripción).
const todayPY = todayLocal;
// ── Moneda de plataforma (configurable) ─────────────────────────
// Los importes se guardan como número "puro" (la columna price_usd es un nombre
// heredado) y se interpretan en la moneda elegida por el superadmin. No hay
// conversión FX: al cambiar de moneda, los precios se re-ingresan en ella.
const CURRENCIES = {
  PYG: {code:'PYG', symbol:'₲',   locale:'es-PY', decimals:0, step:1000, ph:'400000', label:'Guaraní (₲)'},
  USD: {code:'USD', symbol:'US$', locale:'en-US', decimals:2, step:1,    ph:'59.90',  label:'Dólar (US$)'},
  BRL: {code:'BRL', symbol:'R$',  locale:'pt-BR', decimals:2, step:1,    ph:'299.90', label:'Real (R$)'},
  ARS: {code:'ARS', symbol:'AR$', locale:'es-AR', decimals:2, step:100,  ph:'50000',  label:'Peso argentino (AR$)'},
};
let CCY = CURRENCIES.PYG;   // moneda activa — se setea desde platform_config
const setPlatformCurrency = code => { CCY = CURRENCIES[code] || CURRENCIES.PYG; };
const fmtMoney = n => `${CCY.symbol} ${Number(n||0).toLocaleString(CCY.locale,{minimumFractionDigits:CCY.decimals,maximumFractionDigits:CCY.decimals})}`;
const fmtGuarani = fmtMoney;   // alias heredado — todo el dinero de la UI pasa por aquí
// Input de dinero en la MONEDA de la plataforma (CCY). Si CCY no tiene decimales
// (guaraní) usa el <GsInput> con separador de miles (100.000) y entrega el string
// de dígitos crudos; si la moneda tiene decimales (USD/BRL/ARS) mantiene el input
// numérico con decimales. En ambos casos onChange recibe un string.
const MoneyCcyInput = ({value, onChange, ...rest}) =>
  CCY.decimals === 0
    ? <GsInput value={value} onChange={onChange} {...rest}/>
    : <input type="number" min="0" step={CCY.step} value={value==null?'':value} onChange={e=>onChange(e.target.value)} {...rest}/>;
// Escapa HTML al interpolar datos en plantillas de impresión (document.write) — evita stored XSS.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const avg = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
const fmtRelTime = d => {
  if (!d) return '—';
  const h = (Date.now() - new Date(d).getTime()) / 3600000;
  if (h < 1) return 'hace < 1h';
  if (h < 24) return `hace ${Math.floor(h)}h`;
  const days = Math.floor(h/24);
  if (days < 30) return `hace ${days}d`;
  return `hace ${Math.floor(days/30)}mes`;
};

const daysBadge = days => {
  if (days === null) return {label:'—', color:C.mid, bg:'transparent'};
  if (days < 0)   return {label:'Vencido',    color:C.red,    bg:TINT.dangerBg};
  if (days === 0) return {label:'Vence hoy',  color:C.red,    bg:TINT.dangerBg};
  if (days <= 6)  return {label:`${days}d`,   color:C.red,    bg:TINT.dangerBg};
  if (days <= 30) return {label:`${days}d`,   color:C.orange, bg:TINT.warnBg};
  return              {label:`${days}d`,   color:C.green,  bg:TINT.okBg};
};

const statusMeta = {
  active:    {label:'Activo',     color:TINT.okText,     bg:TINT.okBg},
  trial:     {label:'Trial',      color:TINT.infoText,   bg:TINT.infoBg},
  suspended: {label:'Suspendido', color:TINT.dangerText, bg:TINT.dangerBg},
  inactive:  {label:'Inactivo',   color:C.mid, bg:'var(--bg-subtle)'},
  expired:   {label:'Vencido',    color:TINT.dangerText, bg:TINT.dangerBg},
  cancelled: {label:'Cancelado',  color:C.mid, bg:'var(--bg-subtle)'},
  past_due:  {label:'Mora',       color:TINT.warnText,   bg:TINT.warnBg},
};

const eventMeta = {
  onboarding:           {label:'Alta'},
  subscription_renewed: {label:'Renovación'},
  subscription_expired: {label:'Vencimiento'},
  status_changed:       {label:'Estado'},
  note_added:           {label:'Nota'},
  plan_changed:         {label:'Plan'},
  user_created:         {label:'Usuario'},
  payment_received:     {label:'Pago'},
};

// 'delivery' NO es un rol válido: es un fantasma. El rol real de repartidor es
// 'rider' (crea ficha en delivery_riders, se enruta al panel Delivery y recibe
// despacho). Un role='delivery' quedaba huérfano —sin ficha, sin ruta de login,
// rechazado por /api/create-user— pero el RPC admin_update_user_role sí lo aceptaba,
// así que el modal Editar podía fabricarlo. Se elimina de ambas listas asignables.
const ALL_ROLES = ['superadmin','admin','supervisor_local','cajero','cocina','mozo'];
// Roles asignables al crear usuarios. 'rider' crea la ficha en delivery_riders vía
// /api/create-user (login por correo+contraseña, sin PIN).
// 'supervisor_local' es el rol manager (etiqueta "Gerente"): el login lo enruta a
// admin.html y desde ahí accede al sub-panel Gerente.
const NEW_USER_ROLES = ['admin','supervisor_local','cajero','cocina','mozo','rider','superadmin'];
// Etiquetas legibles para los dropdowns/badges (la clave es el string real en user_roles).
const ROLE_LABEL = {
  superadmin:'Superadmin', admin:'Admin', supervisor_local:'Gerente',
  cajero:'Cajero', cocina:'Cocina', mozo:'Mozo', delivery:'Rider (legacy)', rider:'Rider',
  gerente:'Gerente', repartidor:'Rider', waiter:'Mozo'
};
const roleLabel = r => ROLE_LABEL[(r||'').toLowerCase()] || r || '—';
function genRiderPin() { return String(Math.floor(1000 + Math.random() * 9000)); }

// ── SaaS multi-comercio: ciudades, paneles, límites y add-ons ──
const CITIES_PY = ['Asunción','Ciudad del Este','San Lorenzo','Luque','Fernando de la Mora','Lambaré','Encarnación','Capiatá','Mariano Roque Alonso','Ñemby','Limpio','Itauguá'];

// Paneles que un plan puede habilitar (string = key usado en allowed_panels y en login.html)
const PANEL_OPTIONS = [
  {key:'caja',             label:'Caja'},
  {key:'mozo',             label:'Mozo'},
  {key:'cocina',           label:'Cocina (KDS)'},
  {key:'delivery-cliente', label:'Delivery Cliente'},
  {key:'delivery-rider',   label:'Rider Delivery'},
  {key:'gerente',          label:'Gerente'},
];

// Roles con límite estricto por plan (hard-limits) — `key` = nombre real en user_roles.
// Vacío/ausente en max_users_by_role = ilimitado. Para hacer limitable un rol nuevo,
// basta agregarlo acá: el editor de plan (inputs, EMPTY_PLAN, openEditPlan, savePlan)
// itera esta lista. El backstop server-side (trigger enforce_role_user_limit + API
// create-user) enforca genéricamente por presencia de la clave, sin allowlist propia.
const LIMIT_ROLES = [
  {key:'mozo',             label:'Máx. Mozos',     word:'mozos'},
  {key:'cajero',           label:'Máx. Cajeros',   word:'cajeros'},
  {key:'cocina',           label:'Máx. Cocineros', word:'cocineros'},
  {key:'rider',            label:'Máx. Riders',    word:'riders'},
  {key:'supervisor_local', label:'Máx. Gerentes',  word:'gerentes'},
];

// Omni-Gating por feature: sub-módulos vendibles DENTRO de un panel.
// key "panel:feature" = misma string que lee el frontend (mythos-gating.js).
// Se persisten en subscription_plans.allowed_features (migración 091).
const FEATURE_GROUPS = [
  {group:'Admin', icon:'settings', items:[
    {key:'admin:delivery_zones', label:'Gestión de Mapas',     desc:'Zonas y tarifas de delivery'},
    {key:'admin:inventory',      label:'Control de Insumos',   desc:'Stock, recetas y toma'},
    {key:'admin:crm',            label:'CRM de Clientes',      desc:'Base y segmentación'},
  ]},
  {group:'Caja', icon:'creditCard', items:[
    {key:'caja:sifen',            label:'Facturación SIFEN',   desc:'e-Kuatia electrónica'},
    {key:'caja:digital_payments', label:'Pasarelas Bancard',   desc:'QR / VPos digital'},
  ]},
  // Módulo "Cobro Mesa por QR" (mozo:digital_qr_pay) oculto del catálogo — no funcional aún (2026-07-18).
];

// Add-ons por defecto (fallback si plan_addons aún no está migrado)
const DEFAULT_ADDONS = [
  {key:'delivery_cliente', name:'Delivery Cliente', panel:'delivery-cliente', price_usd:100000},
  {key:'delivery_rider',   name:'Rider Delivery',   panel:'delivery-rider',   price_usd:70000},
  {key:'kds_cocina',       name:'KDS Cocina',        panel:'cocina',           price_usd:90000},
  {key:'sucursal_extra',   name:'Sucursal Adicional (Multi-local)', panel:'admin', price_usd:180000},
];
const addonName = (catalog, key) => (catalog.find(a=>a.key===key)?.name) || (DEFAULT_ADDONS.find(a=>a.key===key)?.name) || key;

// Lectura robusta de columnas JSONB (pueden venir como array/objeto real o string)
const asArr = v => Array.isArray(v) ? v : (typeof v==='string' ? (()=>{try{return JSON.parse(v||'[]')}catch{return[]}})() : []);
const asObj = v => (v && typeof v==='object' && !Array.isArray(v)) ? v : (typeof v==='string' ? (()=>{try{return JSON.parse(v||'{}')}catch{return{}}})() : {});
// Parse de topes del editor de planes: '' / null → null (ilimitado); un número → ese
// número, PRESERVANDO 0 (que `|| null` convertiría a null = ilimitado). Un plan con
// max_tables=0 (Emprendedor Delivery, sin salón) debe sobrevivir a un editar+guardar.
const numOrNull = v => { if (v==='' || v==null) return null; const n = parseInt(v,10); return Number.isNaN(n) ? null : n; };

// Ciclo de vida de un plan (subscription_plans). Fuente de verdad = status
// (mig 152); si la columna aún no existe, se deriva de is_active para degradar
// con gracia. 'active' se ofrece; 'inactive' (pausado) y 'archived' se ocultan.
const PLAN_ST = p => (p && p.status) || (p && p.is_active === false ? 'inactive' : 'active');
const isPlanOffered = p => PLAN_ST(p) === 'active';

// ── Sync vidriera (marketing_plans) ⟵ panel operativo (subscription_plans) ──
// El panel MANDA; el sitio REFLEJA. Estos helpers arman el espejo de config y la
// lista "incluye" con labels humanos IDÉNTICOS a public/web-marketing.js (el sitio
// genera la lista desde plan_config; acá se materializa también en `features`).
const SITE_PANEL_ORDER  = ['caja','mozo','cocina','delivery-cliente','delivery-rider','gerente'];
const SITE_PANEL_LABELS = { caja:'Caja', mozo:'Mozo', cocina:'Cocina (KDS)', 'delivery-cliente':'Delivery Cliente', 'delivery-rider':'Rider', gerente:'Gerente' };
const SITE_FEAT_ORDER   = ['admin:inventory','admin:crm','admin:delivery_zones'];   // solo features VIVAS
const SITE_FEAT_LABELS  = { 'admin:inventory':'Control de Insumos', 'admin:crm':'CRM', 'admin:delivery_zones':'Mapas/Zonas' };
// caja:sifen, caja:digital_payments, mozo:digital_qr_pay quedan FUERA (no vivas) a propósito.
const buildMktConfig = op => ({
  panels: asArr(op.allowed_panels),
  features: asArr(op.allowed_features),
  max_tables: op.max_tables ?? null,
  max_menu_items: op.max_menu_items ?? null,
  max_users: asObj(op.max_users_by_role),
});
function buildSiteIncludes(op) {
  const panels = asArr(op.allowed_panels), feats = asArr(op.allowed_features), users = asObj(op.max_users_by_role);
  // Plan "delivery lite" (Emprendedor Delivery, mig 175): delivery-cliente SIN salón
  // → base "Pedidos a domicilio" y sin repetir "Delivery Cliente". Espeja web-marketing.js.
  const deliveryOnly = panels.includes('delivery-cliente')
    && !panels.includes('caja') && !panels.includes('mozo') && !panels.includes('cocina');
  const out = deliveryOnly
    ? ['Pedidos a domicilio (menú digital)', 'Gestión de pedidos (Admin)']
    : ['Carta digital con QR', 'Gestión (Admin)'];
  SITE_PANEL_ORDER.forEach(k => { if (panels.includes(k) && !(deliveryOnly && k === 'delivery-cliente')) out.push(SITE_PANEL_LABELS[k]); });
  SITE_FEAT_ORDER.forEach(k => { if (feats.includes(k)) out.push(SITE_FEAT_LABELS[k]); });
  if (op.max_tables != null && op.max_tables > 0) out.push(op.max_tables + ' mesas');
  else if (panels.includes('mozo') || panels.includes('caja')) out.push('Mesas ilimitadas');
  if (op.max_menu_items != null && op.max_menu_items > 0) out.push(Number(op.max_menu_items).toLocaleString('es-PY') + ' ítems');
  else out.push('Ítems ilimitados');
  if (users.mozo != null && users.mozo > 0) out.push(users.mozo + ' mozos');
  return out;
}
function slugifyPlan(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'plan';
}

const getMRRMonths = subscriptions => {
  const months = [];
  for (let i=5; i>=0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth()-i);
    const key = d.toISOString().slice(0,7);
    const label = d.toLocaleDateString('es-PY',{month:'short'});
    const total = subscriptions
      .filter(s => s.status==='active' && (s.created_at||s.start_date||'').slice(0,7)===key)
      .reduce((sum,s)=>sum+(Number(s.monthly_amount)||0),0);
    months.push({key,label,total});
  }
  return months;
};

// ── Componentes base ─────────────────────────────────────────
const Btn = ({children,onClick,variant='primary',size='md',disabled,style:sx={},title}) => {
  // PR-B3C: cableado a .my-btn + variante/tamaño. Sin cambio de props ni de la
  // semántica de onClick (disabled sigue guardado). danger/success pasan de tinte
  // suave a sólido (estándar del design system); warn→secondary (no hay variante warn).
  const vcls = {primary:'my-btn--primary',ghost:'my-btn--ghost',danger:'my-btn--danger',success:'my-btn--success'}[variant] || 'my-btn--secondary';
  const cls = `my-btn ${vcls}${size==='sm'?' my-btn--sm':''}${disabled?' is-disabled':''}`;
  return <button title={title} className={cls} style={sx} onClick={disabled?undefined:onClick}>{children}</button>;
};

const Badge = ({status}) => {
  const m = statusMeta[status]||{label:status,color:C.mid,bg:'var(--bg-subtle)'};
  return <span style={{padding:'2px 8px',borderRadius:20,fontSize:11,fontWeight:600,background:m.bg,color:m.color,whiteSpace:'nowrap'}}>{m.label}</span>;
};

const PlanBadge = ({name}) => {
  if (!name) return <span style={{color:C.dim,fontSize:11}}>—</span>;
  return <span style={{padding:'2px 10px',borderRadius:20,fontSize:11,fontWeight:700,background:C.bg,color:C.ink,whiteSpace:'nowrap'}}>{name}</span>;
};

// PR-B3C: Kpi → .my-metric-card (Opción A). Valor a var(--text-primary); sub conservado.
// PR-SA-UI: las filas de KPI pasaron de flex-wrap a la grilla .sa-kpis (columnas
// iguales, como admin) → el dimensionado ya lo da la grilla y el flex:'1 1 180px'
// inline sobra. Se suman `icon` y `onClick` opcionales para igualar el lenguaje de
// las metric-cards de admin (ícono en el label, card clickeable a su sección).
const Kpi = ({label,value,sub,icon,onClick,accent}) => (
  <div className={`my-metric-card${onClick?' my-card--interactive':''}`}
       onClick={onClick}
       style={onClick?{cursor:'pointer'}:undefined}>
    <div className="my-metric-card__label" style={{display:'flex',alignItems:'center',gap:6}}>
      {icon && <Icon name={icon} size={13}/>}<span>{label}</span>
    </div>
    <div style={{fontSize:28,fontWeight:800,color:accent||'var(--text-primary)',lineHeight:1,letterSpacing:'-0.5px'}}>{value}</div>
    {sub && <div style={{fontSize:11,color:C.mid,marginTop:6}}>{sub}</div>}
  </div>
);

const Toggle = ({checked,onChange}) => (
  <div onClick={()=>onChange(!checked)} style={{width:36,height:20,borderRadius:10,background:checked?C.ink:C.border,position:'relative',cursor:'pointer',transition:'background .15s',flexShrink:0}}>
    <div style={{position:'absolute',top:2,left:checked?18:2,width:16,height:16,borderRadius:'50%',background:C.surface,transition:'left .15s',boxShadow:'0 1px 3px rgba(0,0,0,.3)'}}/>
  </div>
);

const FlashMsg = ({msg,onClose}) => {
  useEffect(()=>{ if(msg){const t=setTimeout(onClose,3800);return()=>clearTimeout(t);} },[msg]);
  if(!msg) return null;
  const color = msg.type==='error'?C.red:msg.type==='warn'?C.orange:C.green;
  return (
    <div style={{position:'fixed',bottom:24,right:24,background:C.card,border:`1px solid ${color}`,borderRadius:8,padding:'12px 18px',color,fontSize:14,fontWeight:500,zIndex:9999,maxWidth:380,boxShadow:'0 8px 32px rgba(0,0,0,.2)',display:'flex',alignItems:'center',gap:12}}>
      <span style={{flex:1}}>{msg.text}</span>
      <span onClick={onClose} style={{opacity:.6,cursor:'pointer',flexShrink:0}}>×</span>
    </div>
  );
};

function Modal({title,onClose,children,width=540}) {
  useEffect(()=>{
    _modalCount++;
    const fn = e => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', fn);
    return ()=>{ _modalCount = Math.max(0, _modalCount - 1); window.removeEventListener('keydown', fn); };
  },[onClose]);
  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.55)',display:'flex',alignItems:'flex-start',justifyContent:'center',zIndex:1000,padding:'48px 16px 16px'}}>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,width:'100%',maxWidth:width,maxHeight:'calc(100vh - 32px)',overflowY:'auto',boxShadow:'0 24px 64px rgba(0,0,0,.25)',display:'flex',flexDirection:'column'}} className="animate-in">
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'16px 24px',borderBottom:`1px solid ${C.border}`,position:'sticky',top:0,background:C.surface,zIndex:1,flexShrink:0}}>
          <span style={{fontWeight:700,fontSize:15,color:C.ink}}>{title}</span>
          <button onClick={onClose} style={{background:'none',border:'none',color:C.mid,fontSize:20,cursor:'pointer',lineHeight:1,padding:'0 4px'}}>×</button>
        </div>
        <div style={{padding:24,overflowY:'auto'}}>{children}</div>
      </div>
    </div>
  );
}

const FormField = ({label,children,hint,col}) => (
  <div style={{marginBottom:14,gridColumn:col}}>
    <label style={{display:'block',fontSize:11,color:C.mid,fontWeight:600,marginBottom:5,textTransform:'uppercase',letterSpacing:.4}}>{label}</label>
    {children}
    {hint && <div style={{fontSize:11,color:C.dim,marginTop:4}}>{hint}</div>}
  </div>
);

/* ══════════════════════════════════════════════
   MÓDULO PANELES (superadmin) — launcher universal (Abrir directo + QR / link)
   Como superadmin tenés acceso SIN restricciones a todos los paneles (no hay
   candados). Elegís un restaurante (se recuerda; autoselección si hay uno solo)
   y "Abrir" entra al panel en 1 click con su contexto (?r=, vista total por el
   bypass de RLS mig 088). "Compartir" genera el QR/link. El panel Rider Delivery
   es por-cuenta-de-rider (noLaunch): solo se comparte, no se abre como superadmin.
══════════════════════════════════════════════ */
const SUPER_PANELS = [
  {l:'Admin Local',       h:'admin.html',            ic:'settings', desc:'Gestión completa del restaurante',       client:false},
  {l:'Caja',              h:'caja.html',             ic:'money',    desc:'Cobros, turnos y facturación',           client:false},
  {l:'Mozo',              h:'mozo.html',             ic:'coffee',   desc:'Mesas, comandas y transferencias',       client:false},
  {l:'Cocina (KDS)',      h:'cocina.html',           ic:'flame',    desc:'Tablero de comandas y despacho',         client:false},
  {l:'Gerente',           h:'gerente.html',          ic:'chart',    desc:'Reportes, personal y alertas',           client:false},
  {l:'Delivery Cliente',  h:'delivery-cliente.html', ic:'package',  desc:'App de pedidos a domicilio',             client:true},
  {l:'Rider Delivery',    h:'delivery-rider.html',   ic:'bike',     desc:'Panel del repartidor en ruta',           client:false, noLaunch:true},
  {l:'Menú Cliente (QR)', h:'index.html',            ic:'cart',     desc:'Carta digital que escanea el cliente',   client:true},
];

function SuperShareModal({panel, url, needsRest, onClose}) {
  const [copied, setCopied] = useState(false);
  const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=420x420&margin=14&data=${encodeURIComponent(url)}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(()=>setCopied(false),2000); } catch(_){}
  };
  return (
    <Modal title={`Compartir — ${panel.l}`} onClose={onClose} width={420}>
      <div style={{textAlign:'center'}}>
        {needsRest && (
          <div style={{fontSize:12,color:C.orange,fontWeight:600,lineHeight:1.5,marginBottom:14,border:`1px solid ${C.orange}`,borderRadius:9,padding:'9px 12px'}}>
            Esta app del cliente necesita un restaurante. Elegí uno en el selector para que el QR cargue su menú.
          </div>
        )}
        <div style={{fontSize:13,color:C.mid,lineHeight:1.5,marginBottom:16}}>
          Mostrá este QR o compartí el link para abrir el panel de <strong>{panel.l}</strong>.
        </div>
        <div style={{background:'#FFFFFF',border:`1px solid ${C.border}`,borderRadius:14,padding:14,display:'inline-block',marginBottom:16}}>
          <img src={qrImg} alt={`QR ${panel.l}`} width={220} height={220} style={{display:'block',width:220,height:220}}/>
        </div>
        <div style={{display:'flex',gap:8,marginBottom:10}}>
          <input readOnly value={url} onFocus={e=>e.target.select()}
            style={{flex:1,fontSize:12,fontFamily:"'SF Mono',ui-monospace,monospace",padding:'10px 12px',border:`1px solid ${C.border}`,borderRadius:9,background:C.bg,color:C.ink,minWidth:0}}/>
          <button onClick={copy} style={{background:C.ink,color:C.surface,border:'none',borderRadius:9,padding:'10px 14px',fontSize:12.5,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap'}}>{copied?'¡Copiado!':'Copiar'}</button>
        </div>
        <a href={url} target="_blank" rel="noopener noreferrer"
           style={{display:'block',background:'transparent',color:C.ink,border:`1px solid ${C.ink}`,borderRadius:9,padding:'10px 14px',fontSize:13,fontWeight:700,textDecoration:'none'}}>
          Abrir ahora ↗
        </a>
      </div>
    </Modal>
  );
}

const SUPER_PANEL_RID_LS = 'mythos_super_panel_rid';

function PageSuperPaneles({restaurants}) {
  const list = Array.isArray(restaurants) ? restaurants : [];
  const [rid, setRid] = useState('');
  const [qr, setQr]   = useState(null);

  // Restaurar el restaurante elegido la última vez / autoseleccionar si hay uno solo.
  // El superadmin no tiene local propio (restaurant_id NULL): sin esto, "Abrir" iría en
  // modo Genérico y el panel pediría crear restaurante. Conserva una elección manual válida.
  useEffect(() => {
    if (!list.length) return;
    setRid(prev => {
      if (prev && list.some(r => r.id === prev)) return prev;
      let saved = '';
      try { saved = localStorage.getItem(SUPER_PANEL_RID_LS) || ''; } catch(_) {}
      if (saved && list.some(r => r.id === saved)) return saved;
      if (list.length === 1) return list[0].id;
      return prev;
    });
  }, [list.length]);

  // Persistir la elección para la próxima visita.
  useEffect(() => { try { if (rid) localStorage.setItem(SUPER_PANEL_RID_LS, rid); } catch(_) {} }, [rid]);

  // Strip del último segmento de la ruta (sirve igual con superadmin.html o ruta limpia /superadmin)
  const base = window.location.origin + window.location.pathname.replace(/[^/]*$/,'');
  const urlFor = p => `${base}${p.h}${rid ? `?r=${encodeURIComponent(rid)}` : ''}`;
  const activeRest = list.find(r => r.id === rid);
  // "Abrir": 1 click → pestaña nueva, SIEMPRE con ?r= (nunca genérico). Sin restaurante
  // elegido no abre (el botón queda deshabilitado).
  const openPanel = p => { if (!rid) return; window.open(urlFor(p), '_blank', 'noopener'); };

  return (
    <div>
      <h1 style={{fontSize:24,fontWeight:800,letterSpacing:'-0.5px',margin:'0 0 4px',color:C.ink}}>Paneles</h1>
      <p style={{fontSize:13,color:C.mid,margin:'0 0 18px',maxWidth:660,lineHeight:1.55}}>
        Como superadmin accedés a <strong>todos los paneles sin restricciones</strong>. Elegí un restaurante y tocá <strong>Abrir</strong> para entrar directo con su contexto (vista total, bypass de RLS), o <strong>Compartir</strong> para generar su QR / link.
      </p>
      <div style={{display:'flex',flexWrap:'wrap',alignItems:'flex-end',gap:14,marginBottom:22}}>
        <div style={{flex:'1 1 300px',minWidth:280,maxWidth:420}}>
          <label style={{display:'block',fontSize:11,color:C.mid,fontWeight:600,marginBottom:5,textTransform:'uppercase',letterSpacing:.4}}>Restaurante activo (contexto de Abrir / del link)</label>
          <select value={rid} onChange={e=>setRid(e.target.value)}
            style={{width:'100%',fontSize:13,padding:'10px 12px',border:`1px solid ${C.border}`,borderRadius:9,background:C.surface,color:C.ink}}>
            <option value="">Elegí un restaurante…</option>
            {list.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        {activeRest ? (
          <div style={{display:'inline-flex',alignItems:'center',gap:8,fontSize:13,fontWeight:600,color:C.ink,border:`1px solid ${C.ink}`,borderRadius:9,padding:'9px 14px',background:C.surface}}>
            <span style={{width:8,height:8,borderRadius:'50%',background:C.green,flexShrink:0}}/>
            Activo: <strong style={{marginLeft:2}}>{activeRest.name}</strong>
          </div>
        ) : (
          <div style={{display:'inline-flex',alignItems:'center',gap:8,fontSize:12.5,fontWeight:600,color:C.orange,border:`1px solid ${C.orange}`,borderRadius:9,padding:'9px 14px'}}>
            Elegí un restaurante para abrir los paneles con su contexto.
          </div>
        )}
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(212px,1fr))',gap:14}}>
        {SUPER_PANELS.map(p => (
          <div key={p.h}
            style={{background:C.surface,border:`1px solid ${C.ink}`,borderRadius:14,padding:'18px 16px',minHeight:172,display:'flex',flexDirection:'column',transition:'transform .12s, box-shadow .12s'}}
            onMouseEnter={e=>{ e.currentTarget.style.transform='translateY(-2px)'; e.currentTarget.style.boxShadow='0 10px 28px rgba(0,0,0,0.14)'; }}
            onMouseLeave={e=>{ e.currentTarget.style.transform='none'; e.currentTarget.style.boxShadow='none'; }}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
              <div style={{width:42,height:42,borderRadius:11,background:C.ink,color:C.surface,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                <Icon name={p.ic} size={20}/>
              </div>
              <span style={{fontSize:20,color:C.dim,fontWeight:300}}>›</span>
            </div>
            <div style={{fontSize:16,fontWeight:800,color:C.ink,marginBottom:5}}>{p.l}</div>
            <div style={{fontSize:12,color:C.mid,lineHeight:1.45,flex:1,marginBottom:12}}>{p.desc}</div>
            {/* Rider Delivery es por-cuenta-de-rider (se resuelve por auth.uid → delivery_riders),
                no por ?r=: el superadmin no tiene fila de rider, así que "Abrir" no aplica.
                Se ofrece solo Compartir (el link sirve para un rider real con su login). */}
            {p.noLaunch ? (
              <div>
                <button onClick={()=>setQr(p)} title={`Compartir ${p.l} (QR / link)`}
                  style={{width:'100%',display:'inline-flex',alignItems:'center',justifyContent:'center',gap:6,background:'transparent',color:C.ink,border:`1px solid ${C.ink}`,borderRadius:9,padding:'9px 12px',fontSize:12.5,fontWeight:700,cursor:'pointer'}}>
                  <Icon name="layout" size={13}/> Compartir
                </button>
                <div style={{fontSize:10.5,color:C.dim,marginTop:6,lineHeight:1.35}}>Se abre con la cuenta propia del rider (login por correo).</div>
              </div>
            ) : (
              <div style={{display:'flex',gap:8}}>
                <button onClick={()=>openPanel(p)} disabled={!rid}
                  title={rid ? `Abrir ${p.l}` : 'Elegí un restaurante primero'}
                  style={{flex:1,display:'inline-flex',alignItems:'center',justifyContent:'center',gap:6,background:C.ink,color:C.surface,border:'none',borderRadius:9,padding:'9px 12px',fontSize:13,fontWeight:700,cursor:rid?'pointer':'not-allowed',opacity:rid?1:.45}}>
                  Abrir ↗
                </button>
                <button onClick={()=>setQr(p)} title={`Compartir ${p.l} (QR / link)`}
                  style={{display:'inline-flex',alignItems:'center',justifyContent:'center',gap:6,background:'transparent',color:C.ink,border:`1px solid ${C.ink}`,borderRadius:9,padding:'9px 12px',fontSize:12.5,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap'}}>
                  <Icon name="layout" size={13}/> Compartir
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {qr && <SuperShareModal panel={qr} url={urlFor(qr)} needsRest={qr.client && !rid} onClose={()=>setQr(null)}/>}
    </div>
  );
}

const Th = ({children,style:sx={},onClick}) => (
  <th onClick={onClick} style={{padding:'10px 14px',textAlign:'left',fontSize:11,fontWeight:600,color:C.mid,textTransform:'uppercase',letterSpacing:.5,whiteSpace:'nowrap',background:C.surface,cursor:onClick?'pointer':'default',...sx}}>{children}</th>
);
const Td = ({children,style:sx={}}) => (
  <td style={{padding:'11px 14px',fontSize:13,borderTop:`1px solid ${C.border}`,...sx}}>{children}</td>
);

const Spinner = () => (
  <div style={{width:24,height:24,border:`2px solid ${C.border}`,borderTop:`2px solid ${C.ink}`,borderRadius:'50%',flexShrink:0}} className="spin"/>
);

// PR-B3C: contenedor → .my-card (superficie/borde/radio/sombra por tokens).
// padding:0 conserva el contenido edge-to-edge (tablas); el header mantiene su padding.
const SectionCard = ({title,action,children,style:sx={}}) => (
  <div className="my-card" style={{padding:0,overflow:'hidden',...sx}}>
    {(title||action)&&<div style={{padding:'12px 18px',borderBottom:`1px solid var(--border)`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
      {title&&<span style={{fontWeight:600,fontSize:13,color:'var(--text-primary)'}}>{title}</span>}
      {action}
    </div>}
    {children}
  </div>
);

const FilterBtn = ({active,onClick,children}) => (
  <button onClick={onClick} style={{padding:'5px 14px',borderRadius:20,fontSize:12,fontWeight:600,border:`1px solid ${active?C.ink:C.border}`,background:active?C.ink:'transparent',color:active?C.surface:C.mid,cursor:'pointer',transition:'all .15s',whiteSpace:'nowrap'}}>
    {children}
  </button>
);

const MRRChart = ({subscriptions}) => {
  const months = getMRRMonths(subscriptions);
  const maxVal = Math.max(...months.map(m=>m.total), 1);
  return (
    <div style={{display:'flex',alignItems:'flex-end',gap:8,height:130,padding:'0 0 4px 0'}}>
      {months.map(m => {
        const pct = maxVal>0 ? Math.max((m.total/maxVal)*100, m.total>0?4:1) : 1;
        return (
          <div key={m.key} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:4,height:'100%',justifyContent:'flex-end'}}>
            {m.total>0 && <div style={{fontSize:9,fontWeight:700,color:C.ink,textAlign:'center',lineHeight:1.2}}>{fmtGuarani(m.total)}</div>}
            {/* WS4-B: barra en var(--info) (acento de datos, theme-adaptive) en vez de
                C.ink, que pintaba un bloque negro sólido en light / blanco en dark. */}
            <div style={{width:'100%',background:'var(--info)',borderRadius:'3px 3px 0 0',height:`${pct}%`,minHeight:m.total>0?6:2,transition:'height .5s ease',opacity:m.total>0?1:.2}}/>
            <div style={{fontSize:10,color:C.mid,textTransform:'capitalize',whiteSpace:'nowrap'}}>{m.label}</div>
          </div>
        );
      })}
    </div>
  );
};

const DeltaBadge = ({current,prev}) => {
  if (prev===0 && current===0) return <span style={{color:C.mid,fontSize:12}}>—</span>;
  if (prev===0) return <span style={{color:TINT.okText,fontWeight:600,fontSize:12}}>↑ nuevo</span>;
  const pct = ((current-prev)/Math.abs(prev))*100;
  const up = pct>=0;
  return <span style={{color:up?TINT.okText:TINT.dangerText,fontWeight:600,fontSize:12}}>{up?'↑':'↓'} {Math.abs(pct).toFixed(1)}%</span>;
};

// ══════════════════════════════════════════════════════════════
// GRÁFICOS REUTILIZABLES — SVG/CSS puro (sin librerías)
// ══════════════════════════════════════════════════════════════
const fmtNum = n => Number(n||0).toLocaleString('es-PY');
const fmtBytes = n => {
  if (n==null || isNaN(n)) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1048576) return `${(n/1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n/1048576).toFixed(1)} MB`;
  return `${(n/1073741824).toFixed(2)} GB`;
};
const capColor = pct => pct>=90 ? C.red : pct>=70 ? C.orange : C.green;

// Tanque vertical que se "llena" — metáfora de memoria/almacenamiento ocupado
const TankGauge = ({pct, label, value, sub, height=190, critAt=90, warnAt=70}) => {
  const p = Math.max(0, Math.min(100, pct||0));
  const color = capColor(p);
  return (
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:10}}>
      <div style={{position:'relative',width:96,height,borderRadius:14,border:`2px solid ${C.border}`,background:C.bg,overflow:'hidden',boxShadow:'inset 0 2px 6px rgba(0,0,0,.06)'}}>
        {[25,50,75].map(g=>(
          <div key={g} style={{position:'absolute',left:0,right:0,bottom:`${g}%`,borderTop:`1px dashed ${C.border}`,opacity:.7}}/>
        ))}
        <div style={{position:'absolute',left:0,right:0,bottom:0,height:`${p}%`,background:`linear-gradient(180deg, ${color}, ${color}cc)`,transition:'height .8s cubic-bezier(.2,.8,.2,1)'}}>
          <div style={{position:'absolute',top:0,left:0,right:0,height:5,background:'rgba(255,255,255,.45)'}}/>
        </div>
        <div style={{position:'absolute',left:0,right:0,bottom:`${critAt}%`,borderTop:`2px dashed ${C.red}`,opacity:.85}}/>
        <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center'}}>
          <span style={{fontSize:26,fontWeight:800,color:p>46?'#FFFFFF':C.ink,textShadow:p>46?'0 1px 3px rgba(0,0,0,.35)':'none',lineHeight:1}}>{p<10?p.toFixed(1):Math.round(p)}%</span>
        </div>
      </div>
      <div style={{textAlign:'center'}}>
        <div style={{fontSize:13,fontWeight:700,color:C.ink}}>{label}</div>
        {value!=null && <div style={{fontSize:12,color:C.mid,fontFamily:"'SF Mono',ui-monospace,monospace",marginTop:1}}>{value}</div>}
        {sub && <div style={{fontSize:10,color:C.dim,marginTop:2}}>{sub}</div>}
      </div>
    </div>
  );
};

// Medidor semicircular — "cuánto margen queda" (estilo aguja de tablero)
const SemiGauge = ({pct, label, value, sub, color}) => {
  const p = Math.max(0, Math.min(100, pct||0));
  const R=46, cx=60, cy=60, sw=12;
  // frac 0 = izquierda (vacío), 1 = derecha (lleno) — semicírculo superior
  const pt = frac => { const a=Math.PI*(1-frac); return [cx+R*Math.cos(a), cy-R*Math.sin(a)]; };
  const arc = (f0,f1,stroke,op=1) => {
    const [x0,y0]=pt(f0), [x1,y1]=pt(f1);
    return <path d={`M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`} fill="none" stroke={stroke} strokeWidth={sw} strokeLinecap="round" opacity={op}/>;
  };
  const col = color || capColor(p);
  const na = Math.PI*(1 - p/100);                 // ángulo de la aguja
  const nx = cx+(R-8)*Math.cos(na), ny = cy-(R-8)*Math.sin(na);
  return (
    <div style={{display:'flex',flexDirection:'column',alignItems:'center'}}>
      <svg width={120} height={78} viewBox="0 0 120 72">
        {arc(0,1,C.border,.5)}
        {arc(0, Math.max(p/100,0.001), col)}
        <line x1={cx} y1={cy} x2={nx.toFixed(2)} y2={ny.toFixed(2)} stroke={C.ink} strokeWidth={2.5} strokeLinecap="round"/>
        <circle cx={cx} cy={cy} r={4} fill={C.ink}/>
      </svg>
      <div style={{textAlign:'center',marginTop:2}}>
        <div style={{fontSize:18,fontWeight:800,color:col,lineHeight:1}}>{value}</div>
        <div style={{fontSize:12,fontWeight:600,color:C.ink,marginTop:3}}>{label}</div>
        {sub && <div style={{fontSize:10,color:C.dim,marginTop:1}}>{sub}</div>}
      </div>
    </div>
  );
};

// Dona proporcional
const Donut = ({data, size=150, thickness=22, centerLabel, centerSub}) => {
  const total = data.reduce((s,d)=>s+(d.value||0),0)||1;
  const r=(size-thickness)/2, cx=size/2, cy=size/2, circ=2*Math.PI*r;
  let off=0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={C.border} strokeWidth={thickness} opacity={.3}/>
      {data.map((d,i)=>{
        const len=(d.value/total)*circ;
        const seg=<circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={d.color} strokeWidth={thickness}
          strokeDasharray={`${len} ${circ-len}`} strokeDashoffset={-off}
          transform={`rotate(-90 ${cx} ${cy})`}/>;
        off+=len; return seg;
      })}
      {centerLabel!=null && <text x={cx} y={cy-1} textAnchor="middle" fontSize="21" fontWeight="800" fill={C.ink}>{centerLabel}</text>}
      {centerSub && <text x={cx} y={cy+16} textAnchor="middle" fontSize="10" fill={C.mid}>{centerSub}</text>}
    </svg>
  );
};

// Barras horizontales etiquetadas (desglose / "consumo por componente")
const HBars = ({rows, fmt=(v=>fmtNum(v)), barColor}) => (
  <div>
    {rows.length===0 && <div style={{fontSize:12,color:C.dim,padding:'8px 0'}}>Sin datos</div>}
    {(()=>{ const max=Math.max(...rows.map(r=>r.value),1); return rows.map((r,i)=>(
      <div key={i} style={{marginBottom:11}}>
        <div style={{display:'flex',justifyContent:'space-between',fontSize:11,marginBottom:4}}>
          <span style={{color:C.mid}}>{r.label}</span>
          <span style={{color:C.ink,fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:600}}>{fmt(r.value)}{r.note?<span style={{color:C.dim,fontWeight:400}}> {r.note}</span>:null}</span>
        </div>
        <div style={{height:9,background:C.bg,borderRadius:5,overflow:'hidden'}}>
          <div style={{height:'100%',width:`${Math.max((r.value/max)*100, r.value>0?3:0)}%`,background:r.color||barColor||C.ink,borderRadius:5,transition:'width .7s ease'}}/>
        </div>
      </div>
    )); })()}
  </div>
);

// Área/línea de tendencia
const TrendArea = ({points, height=120, color=C.ink, yFmt=(v=>fmtNum(v))}) => {
  const n=points.length;
  if (!n) return <div style={{height,display:'flex',alignItems:'center',justifyContent:'center',color:C.dim,fontSize:12}}>Sin datos</div>;
  const W=320,H=100,pad=6;
  const max=Math.max(...points.map(p=>p.value),1);
  const xs=i=> n<=1 ? W/2 : pad + i*(W-2*pad)/(n-1);
  const ys=v=> H-pad - (v/max)*(H-2*pad);
  const line=points.map((p,i)=>`${xs(i).toFixed(1)},${ys(p.value).toFixed(1)}`).join(' ');
  const area=`${pad.toFixed(1)},${(H-pad).toFixed(1)} ${line} ${(W-pad).toFixed(1)},${(H-pad).toFixed(1)}`;
  const peak=points.reduce((m,p,i)=> p.value>points[m].value?i:m, 0);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{width:'100%',height,display:'block'}}>
        {[0.25,0.5,0.75].map(g=><line key={g} x1={pad} x2={W-pad} y1={H-pad-g*(H-2*pad)} y2={H-pad-g*(H-2*pad)} stroke={C.border} strokeWidth={1} opacity={.5} vectorEffect="non-scaling-stroke"/>)}
        <polygon points={area} fill={color} opacity={.12}/>
        <polyline points={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
      </svg>
      <div style={{display:'flex',justifyContent:'space-between',marginTop:5}}>
        {points.map((p,i)=>(
          <span key={i} style={{flex:1,textAlign:'center',fontSize:9,color:i===peak?C.ink:C.dim,fontWeight:i===peak?700:400,whiteSpace:'nowrap'}}>{p.label}</span>
        ))}
      </div>
    </div>
  );
};

// ── Modelo de capacidad de infraestructura (análisis de carga) ────
// Límites aproximados por plan de Supabase (verificar en tu panel de billing).
const SUPA_PLANS = {
  free: {label:'Free',  db_mb:500,   storage_gb:1,   bandwidth_gb:5,   mau:50000,  rt_conn:200, db_conn:60,  note:'Plan gratuito · 500 MB de BD'},
  pro:  {label:'Pro',   db_mb:8192,  storage_gb:100, bandwidth_gb:250, mau:100000, rt_conn:500, db_conn:200, note:'8 GB incluidos · escala con disco'},
  team: {label:'Team',  db_mb:8192,  storage_gb:100, bandwidth_gb:250, mau:200000, rt_conn:500, db_conn:200, note:'Como Pro + colaboración'},
};
// Peso estimado por fila en bytes (datos + índices + overhead de Postgres)
const ROW_BYTES = {
  restaurants:1500, tables:300, menu_categories:250, menu_items:800, menu_item_extras:200,
  orders:600, order_items:300, order_item_extras:160, order_status_history:180,
  ratings:300, user_roles:600, turnos_caja:350, movimientos_caja:280, cancelaciones_caja:260,
  quejas_sugerencias:300, platform_events:350, ingredients:280, recipes:220, stock_movements:260,
  stock_alerts:240, expenses:240, delivery_orders:500, delivery_riders:300, reservations:320,
  coupons:260, waiter_calls:220, support_tickets:400, support_messages:350, employee_shifts:260,
  subscriptions:400, subscription_plans:500, restaurant_addons:240, platform_config:200,
  calendar_events:280, table_scan_sessions:200,
};
// Etiqueta legible por tabla
const TABLE_LABEL = {
  orders:'Pedidos', order_items:'Ítems de pedido', menu_items:'Ítems de menú', ratings:'Calificaciones',
  user_roles:'Usuarios', restaurants:'Restaurantes', platform_events:'Eventos plataforma',
  movimientos_caja:'Mov. de caja', stock_movements:'Mov. de stock', delivery_orders:'Pedidos delivery',
  support_messages:'Mensajes soporte', tables:'Mesas', reservations:'Reservas', ingredients:'Insumos',
};
// Huella estimada por restaurante·mes (modelo de "restaurante típico" en servicio)
const REST_MODEL = {
  menu_items:35, tables:14, menu_categories:8, menu_item_extras:25, user_roles:8,   // estructura (una vez)
  orders_mo:1800, order_items_mo:5200, order_item_extras_mo:1500, ratings_mo:140,    // operación (por mes)
  movimientos_caja_mo:900, order_status_history_mo:9000, platform_events_mo:120, waiter_calls_mo:600,
};
function restMonthlyBytes() {  // bytes que crecen cada mes por restaurante
  return REST_MODEL.orders_mo*ROW_BYTES.orders + REST_MODEL.order_items_mo*ROW_BYTES.order_items
    + REST_MODEL.order_item_extras_mo*ROW_BYTES.order_item_extras + REST_MODEL.ratings_mo*ROW_BYTES.ratings
    + REST_MODEL.movimientos_caja_mo*ROW_BYTES.movimientos_caja + REST_MODEL.order_status_history_mo*ROW_BYTES.order_status_history
    + REST_MODEL.platform_events_mo*ROW_BYTES.platform_events + REST_MODEL.waiter_calls_mo*ROW_BYTES.waiter_calls;
}
function restBaseBytes() {     // bytes fijos de estructura por restaurante
  return REST_MODEL.menu_items*ROW_BYTES.menu_items + REST_MODEL.tables*ROW_BYTES.tables
    + REST_MODEL.menu_categories*ROW_BYTES.menu_categories + REST_MODEL.menu_item_extras*ROW_BYTES.menu_item_extras
    + REST_MODEL.user_roles*ROW_BYTES.user_roles;
}

// ── Analytics helpers ────────────────────────────────────────
function buildAnalytics(restaurants, orders, ratings, subscriptions, plans, addons=[]) {
  const now = new Date();
  const ago30 = new Date(now - 30*86400000).toISOString();
  const todayStr = todayPY();
  return restaurants.map(r => {
    const rOrders     = orders.filter(o=>o.restaurant_id===r.id);
    const recent      = rOrders.filter(o=>(o.created_at||'')>=ago30);
    const todayOrders = rOrders.filter(o=>(o.created_at||'').slice(0,10)===todayStr);
    const revenue30   = recent.reduce((s,o)=>s+(Number(o.total)||0),0);
    const rRatings    = ratings.filter(x=>x.restaurant_id===r.id).map(x=>x.stars);
    const rSub        = subscriptions.find(s=>s.restaurant_id===r.id);
    const plan        = rSub?.plan || (rSub?plans.find(p=>p.id===rSub.plan_id):null);
    const rAddons     = addons.filter(a=>a.restaurant_id===r.id && a.enabled!==false);
    return {
      ...r,
      orders30:    recent.length,
      ordersToday: todayOrders.length,
      revenue30,
      avgRating:   rRatings.length ? +(avg(rRatings).toFixed(1)) : null,
      ratingCount: rRatings.length,
      clients:     recent.length,             // proxy de "clientes activos": pedidos últimos 30d
      addons:      rAddons,
      addonMRR:    rAddons.reduce((s,a)=>s+(Number(a.price_usd)||0),0),
      subscription:rSub,
      plan,
      daysLeft:    rSub ? daysUntil(rSub.end_date) : null,
    };
  });
}

// ── Hook de salud del sistema (RPC superadmin_system_health + latencia + cron) ──
// Métricas REALES de Postgres y operativas. Refresca ~30s respetando _shouldPause().
function useSystemHealth() {
  const [health,  setHealth]  = useState(null);
  const [latency, setLatency] = useState(null);
  const [cronOk,  setCronOk]  = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (db) {
        const t0 = performance.now();
        try {
          const { data, error } = await db.rpc('superadmin_system_health');
          if (!alive) return;
          setLatency(Math.round(performance.now() - t0));
          if (!error && data) setHealth(data);
        } catch (e) { /* conserva el último valor bueno */ }
      }
      if (alive) setLoading(false);
      // Integración externa: el cron keep-alive (mismo origen). 200 = Online.
      try {
        const r = await fetch('/api/cron/keep-alive', { method: 'GET', cache: 'no-store' });
        // 200 = fail-open (sin CRON_SECRET). 401 = el endpoint está VIVO pero gateado
        // por CRON_SECRET (el navegador no manda el Bearer) → sigue contando como online.
        if (alive) setCronOk(r.ok || r.status === 401);
      } catch (e) { if (alive) setCronOk(false); }
    };
    tick();
    const id = setInterval(() => { if (!_shouldPause()) tick(); }, 30000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return { health, latency, cronOk, loading };
}

// Reglas de alertas derivadas de la salud real (memoria/conexiones/latencia/cron/stuck/subs).
function buildHealthAlerts({ health, latency, cronOk, enriched }) {
  const alerts = [];
  const planLimit = SUPA_PLANS.free.db_mb * 1048576;
  const memPct  = health && health.db_size_bytes != null ? (Number(health.db_size_bytes) / planLimit) * 100 : null;
  const connPct = health && health.db_conn_max ? (Number(health.db_conn_active) / Number(health.db_conn_max)) * 100 : null;
  if (memPct != null && memPct >= 90)      alerts.push({ sev:'crit', t:'Memoria de BD crítica', d:`${Math.round(memPct)}% del plan Free · ${fmtBytes(Number(health.db_size_bytes))}` });
  else if (memPct != null && memPct >= 70) alerts.push({ sev:'warn', t:'Memoria de BD alta',     d:`${Math.round(memPct)}% del plan Free · ${fmtBytes(Number(health.db_size_bytes))}` });
  if (connPct != null && connPct >= 70)    alerts.push({ sev:'warn', t:'Conexiones altas',       d:`${health.db_conn_active}/${health.db_conn_max} conexiones a la BD` });
  if (latency != null && latency >= 500)   alerts.push({ sev:'warn', t:'Latencia de BD alta',    d:`${latency} ms de respuesta` });
  const expirando = (enriched||[]).filter(r=>r.daysLeft!==null && r.daysLeft>=0 && r.daysLeft<=7 && r.status!=='suspended');
  if (expirando.length>0) alerts.push({ sev:'warn', t:'Suscripciones por vencer', d: expirando.map(r=>`${r.name} (${r.daysLeft===0?'hoy':r.daysLeft+'d'})`).join(' · ') });
  if (health && Number(health.stuck_orders) > 0) alerts.push({ sev:'warn', t:'Pedidos trabados', d:`${health.stuck_orders} pedido(s) sin avanzar hace +2 h` });
  if (cronOk === false) alerts.push({ sev:'warn', t:'Integración keep-alive caída', d:'GET /api/cron/keep-alive no respondió 200' });
  return { alerts, memPct, connPct };
}

// ── Bloque "Salud en vivo" — semáforo global + alertas activas + actividad ─────
function LiveHealth({ health, latency, cronOk, loading, enriched }) {
  const { alerts, memPct, connPct } = buildHealthAlerts({ health, latency, cronOk, enriched });
  const hasCrit = alerts.some(a=>a.sev==='crit');
  const hasWarn = alerts.some(a=>a.sev==='warn');
  const sem = hasCrit ? { label:'Crítico', color:C.red }
            : hasWarn ? { label:'Atención', color:C.orange }
            : { label:'Sano', color:C.green };
  const activos = (enriched||[]).filter(r=>r.status==='active').length;
  const dot = c => <span style={{width:9,height:9,borderRadius:'50%',background:c,display:'inline-block'}}/>;
  const mini = (label, value, color) => (
    <div style={{flex:'0 0 auto',padding:'0 16px',borderLeft:`1px solid ${C.border}`}}>
      <div style={{fontSize:10,color:C.mid,fontWeight:600,textTransform:'uppercase',letterSpacing:.4}}>{label}</div>
      <div style={{fontSize:17,fontWeight:800,color:color||C.ink,lineHeight:1.4}}>{value}</div>
    </div>
  );
  const act = (label, value) => (
    <div style={{flex:'1 1 140px',padding:'12px 16px',borderRight:`1px solid ${C.border}`}}>
      <div style={{fontSize:11,color:C.mid,fontWeight:600,textTransform:'uppercase',letterSpacing:.4,marginBottom:6}}>{label}</div>
      <div style={{fontSize:20,fontWeight:800,color:C.ink,lineHeight:1}}>{value}</div>
    </div>
  );
  return (
    <SectionCard title="Salud en vivo" style={{marginBottom:20}}>
      {/* Semáforo global + métricas resumidas reales */}
      <div style={{display:'flex',alignItems:'center',flexWrap:'wrap',gap:12,padding:'16px 18px',borderBottom:`1px solid ${C.border}`}}>
        <div style={{display:'inline-flex',alignItems:'center',gap:10,background:sem.color+'1E',border:`1px solid ${sem.color}66`,borderRadius:10,padding:'10px 16px'}}>
          {dot(sem.color)}
          <span style={{fontSize:16,fontWeight:800,color:sem.color}}>{loading && !health ? 'Midiendo…' : sem.label}</span>
        </div>
        {mini('Memoria BD', memPct==null?'—':`${memPct<10?memPct.toFixed(1):Math.round(memPct)}%`, memPct==null?C.mid:capColor(memPct))}
        {mini('Conexiones', connPct==null?'—':`${health.db_conn_active}/${health.db_conn_max}`, connPct==null?C.mid:capColor(connPct))}
        {mini('Latencia', latency==null?'—':`${latency} ms`, latency==null?C.mid:latency<200?C.green:latency<500?C.orange:C.red)}
        {mini('Keep-alive', cronOk==null?'…':cronOk?'Online':'Offline', cronOk==null?C.mid:cronOk?C.green:C.red)}
      </div>
      {/* Alertas activas */}
      <div style={{padding:'14px 18px',borderBottom:`1px solid ${C.border}`}}>
        <div style={{fontSize:12,fontWeight:700,color:C.mid,marginBottom:alerts.length?10:0,textTransform:'uppercase',letterSpacing:.4}}>Alertas activas</div>
        {alerts.length===0
          ? <div style={{display:'flex',alignItems:'center',gap:8,fontSize:13,color:C.green,fontWeight:600}}>{dot(C.green)} Todo en orden</div>
          : <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {alerts.map((a,i)=>{
                const col = a.sev==='crit'?C.red:C.orange;
                return (
                  <div key={i} style={{display:'flex',alignItems:'flex-start',gap:10,background:col+'14',border:`1px solid ${col}55`,borderRadius:9,padding:'9px 13px'}}>
                    <span style={{marginTop:4}}>{dot(col)}</span>
                    <div>
                      <div style={{fontSize:13,fontWeight:700,color:col}}>{a.t}</div>
                      <div style={{fontSize:12,color:C.ink,marginTop:1}}>{a.d}</div>
                    </div>
                  </div>
                );
              })}
            </div>}
      </div>
      {/* Actividad en vivo */}
      <div style={{display:'flex',flexWrap:'wrap'}}>
        {act('Pedidos 24 h',          health?fmtNum(health.orders_24h):'—')}
        {act('Usuarios concurrentes', health?fmtNum(health.concurrent_staff):'—')}
        {act('Último evento',         health?fmtRelTime(health.last_event_at):'—')}
        {act('Restaurantes activos',  fmtNum(activos))}
      </div>
    </SectionCard>
  );
}

// ── Widget Salud del Sistema (infraestructura) — datos REALES del RPC ──────────
function SystemHealth({ health, latency, cronOk }) {
  const latColor = latency==null ? C.mid : latency<200 ? TINT.okText : latency<500 ? TINT.warnText : C.red;
  const dot = (color) => <span style={{width:8,height:8,borderRadius:'50%',background:color,display:'inline-block'}}/>;
  const connPct = health && health.db_conn_max ? (Number(health.db_conn_active)/Number(health.db_conn_max))*100 : null;
  const cell = (label, value, sub, color) => (
    <div style={{flex:'1 1 150px',padding:'14px 18px',borderRight:`1px solid ${C.border}`}}>
      <div style={{fontSize:11,color:C.mid,fontWeight:600,marginBottom:8,textTransform:'uppercase',letterSpacing:.4}}>{label}</div>
      <div style={{display:'flex',alignItems:'center',gap:8,fontSize:20,fontWeight:800,color:color||C.ink,lineHeight:1}}>{value}</div>
      <div style={{fontSize:10,color:C.dim,marginTop:6}}>{sub}</div>
    </div>
  );
  return (
    <SectionCard title="Salud del sistema">
      <div style={{display:'flex',flexWrap:'wrap'}}>
        {cell('Latencia DB',
          latency==null ? '…' : `${latency} ms`,
          'Medición en vivo (ping al RPC)', latColor)}
        {cell('Pool de conexiones',
          health==null ? '…' : <>{fmtNum(health.db_conn_active)}<span style={{fontSize:13,fontWeight:500,color:C.mid}}>/{fmtNum(health.db_conn_max)}</span></>,
          'Real — pg_stat_activity', connPct==null?C.ink:capColor(connPct))}
        {cell('Cron keep-alive',
          cronOk==null ? '…' : <>{dot(cronOk?C.green:C.red)} {cronOk?'Online':'Offline'}</>,
          'GET /api/cron/keep-alive', C.ink)}
      </div>
    </SectionCard>
  );
}

// ══════════════════════════════════════════════════════════════
// MÓDULO 1 — DASHBOARD GLOBAL
// ══════════════════════════════════════════════════════════════
function PageDashboard({enriched, orders, ratings, subscriptions, setFlash, reload, setPage}) {
  const now = new Date();
  const todayStr = todayPY();
  const ago48h = new Date(now-48*3600000).toISOString();

  const activos    = enriched.filter(r=>r.status==='active').length;
  const mrrTotal   = subscriptions.filter(s=>s.status==='active').reduce((sum,s)=>sum+(Number(s.monthly_amount)||0),0);
  const pedidosHoy = orders.filter(o=>(o.created_at||'').slice(0,10)===todayStr).length;
  const recRatings = ratings.filter(r=>(r.created_at||ago48h)>=ago48h);
  const ratingProm = recRatings.length ? +(avg(recRatings.map(r=>r.stars)).toFixed(1)) : null;

  const restSummary = [...enriched].sort((a,b)=>b.ordersToday-a.ordersToday);

  // Locales que requieren acción: suscripción caída o por vencer dentro de 7 días.
  // Ordenados por urgencia (los que menos días les quedan, primero).
  const needsAttention = enriched
    .filter(r => ['suspended','past_due','expired'].includes(r.status) || (r.daysLeft!=null && r.daysLeft<=7))
    .sort((a,b)=>(a.daysLeft==null?9999:a.daysLeft)-(b.daysLeft==null?9999:b.daysLeft));

  // Resumen rápido de restaurantes: colapsable + persistente. Ahora arranca
  // ABIERTO — arrancaba cerrado y el dashboard renderizaba una card vacía con
  // solo el título, que era la mitad del "se ve vacío".
  const [restOpen,setRestOpen] = useState(()=>{ try { return localStorage.getItem('sa_dash_rest_open')!=='0'; } catch { return true; } });
  const toggleRest = ()=> setRestOpen(v=>{ const n=!v; try{ localStorage.setItem('sa_dash_rest_open', n?'1':'0'); }catch{} return n; });
  const TOP_N = 6;
  const restTop = restOpen ? restSummary.slice(0,TOP_N) : [];

  // PR-SA1: registros web (leads_prospectos, mig 117 permite SELECT a superadmin).
  // Si la tabla/RLS falla, la card degrada a "—" sin romper el dashboard.
  const [webLeads, setWebLeads] = useState(null);
  useEffect(() => {
    if (!db) return;
    let alive = true;
    const ago7d = new Date(Date.now()-7*86400000).toISOString();
    Promise.all([
      db.from('leads_prospectos').select('id',{count:'exact',head:true}).gte('created_at',ago7d).then(r=>r.error?{count:null}:r),
      db.from('leads_prospectos').select('id',{count:'exact',head:true}).then(r=>r.error?{count:null}:r),
    ]).then(([w,t]) => { if (alive) setWebLeads({week:w.count, total:t.count}); });
    return () => { alive = false; };
  }, []);

  // PARTE C (mig 147): avisos de vencimiento de costos del sistema en el tablero.
  // Falla en silencio si la migración aún no está aplicada (la card no se muestra).
  const [finAlerts, setFinAlerts] = useState([]);
  useEffect(() => {
    if (!db) return;
    let alive = true;
    db.rpc('platform_finance_summary').then(({data,error}) => {
      if (!alive || error || !data) return;
      const up = Array.isArray(data.upcoming) ? data.upcoming : [];
      setFinAlerts(up.filter(u => u.days_remaining !== null && u.days_remaining < 15));
    });
    return () => { alive = false; };
  }, []);

  return (
    <div className="animate-in">
      {/* Fecha del día — mismo encabezado contextual que el dashboard de admin.
          El nombre de la página ya lo muestra la barra superior, no se repite. */}
      <div style={{fontSize:13,color:C.mid,marginBottom:18,textTransform:'capitalize'}}>
        {now.toLocaleDateString('es-PY',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}
      </div>

      {/* KPIs de plataforma — grilla de columnas iguales, con ícono y navegación
          a la sección correspondiente (patrón .my-metric-card de admin). */}
      <div className="sa-kpis" style={{marginBottom:18}}>
        <Kpi icon="store"   label="Restaurantes activos"   value={fmtNum(activos)}
             sub={`de ${fmtNum(enriched.length)} totales`}  onClick={()=>setPage('restaurantes')}/>
        <Kpi icon="money"   label="MRR total"              value={fmtGuarani(mrrTotal)}
             sub="ingreso recurrente mensual"               onClick={()=>setPage('facturacion')}/>
        <Kpi icon="package" label="Pedidos hoy"            value={fmtNum(pedidosHoy)}
             sub="todos los locales"                        onClick={()=>setPage('reportes')}/>
        <Kpi icon="star"    label="Rating promedio"        value={ratingProm ? String(ratingProm) : '—'}
             sub={recRatings.length ? `${fmtNum(recRatings.length)} calificaciones · 48hs` : 'últimas 48hs'}/>
        <Kpi icon="mail"    label="Registros web (7 días)" value={webLeads&&webLeads.week!=null ? fmtNum(webLeads.week) : '—'}
             sub={webLeads&&webLeads.total!=null ? `${fmtNum(webLeads.total)} en total` : 'leads del sitio'}
             onClick={()=>setPage('prospeccion')}/>
      </div>

      {/* PARTE C: avisos de vencimiento de costos del sistema (mig 147) */}
      {finAlerts.length>0 && (
        <div onClick={()=>setPage('finanzas')} title="Ir a Finanzas"
          className="my-card my-card--interactive"
          style={{borderColor:'var(--warning)',marginBottom:18,cursor:'pointer'}}>
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10}}>
            <span style={{display:'inline-flex',color:C.orange,flexShrink:0}}><Icon name="alert" size={15}/></span>
            <span style={{fontSize:13,fontWeight:800,color:C.ink}}>Vencimientos próximos</span>
            <span style={{fontSize:11,color:C.mid}}>· costos del sistema</span>
            <span style={{marginLeft:'auto',display:'inline-flex',color:C.mid,flexShrink:0}}><Icon name="chevronRight" size={14}/></span>
          </div>
          <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
            {finAlerts.map(a=>{
              const sem = dueSemaphore(a.days_remaining);
              return (
                <span key={a.id} style={{display:'inline-flex',alignItems:'center',gap:8,padding:'6px 12px',borderRadius:20,background:sem.bg,color:sem.color,fontSize:12.5,fontWeight:700}}>
                  <span style={{width:8,height:8,borderRadius:'50%',background:sem.color,flexShrink:0}}/>
                  {a.name} — {dueLabel(a.days_remaining)}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <div className="sa-split">
        {/* Columna principal */}
        <div style={{display:'flex',flexDirection:'column',gap:18,minWidth:0}}>
          <SectionCard title="Crecimiento MRR — últimos 6 meses">
            <div style={{padding:'20px 20px 12px'}}>
              <MRRChart subscriptions={subscriptions}/>
            </div>
            <div style={{padding:'0 20px 16px',fontSize:11,color:C.mid}}>Nuevas suscripciones activas por mes de alta</div>
          </SectionCard>

          {/* Cola de trabajo del superadmin: qué cuenta hay que atender hoy.
              Antes el dashboard no mostraba nada accionable — había que entrar
              a Restaurantes y leer la tabla entera para encontrarlas. */}
          <SectionCard title="Requieren atención"
            action={needsAttention.length>0
              ? <span style={{fontSize:11,fontWeight:700,color:C.red,background:TINT.dangerBg,padding:'2px 9px',borderRadius:20}}>{fmtNum(needsAttention.length)}</span>
              : null}>
            {needsAttention.length===0
              ? <div style={{padding:'28px 18px',textAlign:'center',color:C.dim,fontSize:12}}>Ninguna cuenta vencida ni por vencer esta semana.</div>
              : needsAttention.slice(0,8).map((r,i)=>{
                  const d = daysBadge(r.daysLeft);
                  return (
                    <div key={r.id} onClick={()=>setPage('restaurantes')}
                      style={{display:'flex',alignItems:'center',gap:12,padding:'11px 18px',borderTop:i?`1px solid ${C.border}`:'none',cursor:'pointer'}}
                      onMouseEnter={e=>e.currentTarget.style.background=C.bg}
                      onMouseLeave={e=>e.currentTarget.style.background=''}>
                      <span style={{flex:1,minWidth:0,fontSize:13,fontWeight:600,color:C.ink,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.name}</span>
                      <span style={{fontSize:11,color:C.mid,whiteSpace:'nowrap'}}>{r.plan?.name||'sin plan'}</span>
                      <Badge status={r.status}/>
                      <span style={{fontSize:11,fontWeight:700,color:d.color,background:d.bg,padding:'2px 9px',borderRadius:20,whiteSpace:'nowrap',minWidth:52,textAlign:'center'}}>{d.label}</span>
                    </div>
                  );
                })}
            {needsAttention.length>8 && (
              <div onClick={()=>setPage('restaurantes')} style={{padding:'10px 18px',borderTop:`1px solid ${C.border}`,fontSize:12,fontWeight:600,color:C.mid,cursor:'pointer'}}>
                Ver las {fmtNum(needsAttention.length)} cuentas en Restaurantes →
              </div>
            )}
          </SectionCard>
        </div>

        {/* Columna lateral — resumen rápido de locales */}
        <SectionCard title="Restaurantes"
          action={<button onClick={toggleRest} style={{border:`1px solid ${C.border}`,background:'transparent',color:C.mid,borderRadius:8,padding:'4px 10px',fontSize:12,fontWeight:600,cursor:'pointer'}}>{restOpen?'Ocultar':`Ver (${fmtNum(restSummary.length)})`}</button>}>
          {restOpen && restTop.map((r,i)=>(
            <div key={r.id} onClick={()=>setPage('restaurantes')} style={{padding:'12px 18px',borderTop:i?`1px solid ${C.border}`:'none',cursor:'pointer',transition:'background .1s'}}
              onMouseEnter={e=>e.currentTarget.style.background=C.bg}
              onMouseLeave={e=>e.currentTarget.style.background=''}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8,marginBottom:6}}>
                <span style={{fontWeight:600,fontSize:13,color:C.ink,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.name}</span>
                <Badge status={r.status}/>
              </div>
              <div style={{display:'flex',gap:14,fontSize:11,color:C.mid,flexWrap:'wrap'}}>
                <span>Pedidos: <strong style={{color:C.ink}}>{fmtNum(r.ordersToday)}</strong></span>
                <span>MRR: <strong style={{color:C.ink}}>{fmtGuarani(r.subscription?.monthly_amount||0)}</strong></span>
                <span>Rating: <strong style={{color:C.ink}}>{r.avgRating||'—'}</strong></span>
              </div>
            </div>
          ))}
          {restOpen && restSummary.length===0 && <div style={{padding:'28px 18px',textAlign:'center',color:C.dim,fontSize:12}}>Sin restaurantes</div>}
          {restOpen && restSummary.length>TOP_N && (
            <div onClick={()=>setPage('restaurantes')} style={{padding:'10px 18px',borderTop:`1px solid ${C.border}`,fontSize:12,fontWeight:600,color:C.mid,cursor:'pointer'}}>
              Ver los {fmtNum(restSummary.length)} locales →
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// MÓDULO — CAPACIDAD (análisis de carga de la base de datos)
// "Como el cálculo de cargas eléctricas de una obra, pero para la BD"
// ══════════════════════════════════════════════════════════════
const DONUT_RAMP = ['#1D1D1F','#FF9500','#007AFF','#34C759','#5856D6','#FF3B30','#8A4B00','#6E6E73'];

function PageCapacidad({ enriched }) {
  const [counts,   setCounts]   = useState(null);
  const [loadingC, setLoadingC] = useState(true);
  const [planKey,  setPlanKey]  = useState('free');
  const [latency,  setLatency]  = useState(null);
  const sys = useSystemHealth();                       // salud real: RPC + latencia + cron
  const sysHealth = sys.health;                        // tamaño REAL de la BD (pg_database_size)
  // Simulador "¿cuánto aguanta el tablero?" — arranca en el nº real de restaurantes,
  // no en 50 (evita el falso 100% rojo). Se sincroniza hasta que el usuario lo toca.
  const [simRest,     setSimRest]     = useState(1);
  const [simTouched,  setSimTouched]  = useState(false);
  const [simMonths,   setSimMonths]   = useState(12);
  const [connPerRest, setConnPerRest] = useState(8);

  const plan = SUPA_PLANS[planKey];

  // Conteo real de filas por tabla (HEAD + count exact — no descarga datos)
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!db) { setLoadingC(false); return; }
      setLoadingC(true);
      const tables = Object.keys(ROW_BYTES);
      const results = await Promise.all(tables.map(async t => {
        try {
          const { count, error } = await db.from(t).select('*', { count:'exact', head:true });
          return [t, error ? null : (count || 0)];
        } catch(e) { return [t, null]; }
      }));
      if (!alive) return;
      const obj = {}; results.forEach(([t,c]) => obj[t] = c);
      setCounts(obj); setLoadingC(false);
    })();
    return () => { alive = false; };
  }, []);

  // Latencia en vivo (medición real con ping)
  useEffect(() => {
    let alive = true;
    const ping = async () => {
      if (!db) return;
      const t0 = performance.now();
      const { error } = await db.from('restaurants').select('id').limit(1);
      if (alive && !error) setLatency(Math.round(performance.now() - t0));
    };
    ping();
    const id = setInterval(() => { if (!_shouldPause()) ping(); }, 15000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const cnt = counts || {};
  const hasCounts = counts !== null;
  const usedBytes  = Object.keys(ROW_BYTES).reduce((s,t)=> s + (Number(cnt[t]||0) * ROW_BYTES[t]), 0);
  const limitBytes = plan.db_mb * 1048576;
  // Memoria a MOSTRAR: tamaño REAL de la BD (pg_database_size, vía RPC). El estimado
  // filas×peso queda SOLO como fallback si el RPC no respondió.
  const realBytes      = (sysHealth && sysHealth.db_size_bytes != null) ? Number(sysHealth.db_size_bytes) : null;
  const usedBytesShown = realBytes != null ? realBytes : usedBytes;
  const usedPct        = limitBytes>0 ? (usedBytesShown/limitBytes)*100 : 0;
  const freePct        = Math.max(0, 100 - usedPct);

  const restCount  = (enriched && enriched.length) || Number(cnt.restaurants||0) || 0;
  const itemsCount = Number(cnt.menu_items||0);
  const usersCount = Number(cnt.user_roles||0);
  const ordersCount= Number(cnt.orders||0);

  // El simulador arranca proyectando TU realidad: el nº actual de restaurantes
  // (hasta que el usuario mueve el control).
  useEffect(() => { if (!simTouched && restCount > 0) setSimRest(restCount); }, [restCount, simTouched]);

  // Desglose de almacenamiento por tabla
  const breakdown = Object.keys(ROW_BYTES)
    .map(t => ({ table:t, label: TABLE_LABEL[t]||t, bytes: Number(cnt[t]||0)*ROW_BYTES[t], rows: Number(cnt[t]||0) }))
    .filter(x => x.rows>0)
    .sort((a,b)=> b.bytes-a.bytes);
  const topBreak = breakdown.slice(0,8);
  // PR-B4C: slice 0 usa C.ink (theme-reactivo) en vez del #1D1D1F fijo del ramp,
  // para que no quede near-negro invisible sobre el chart en dark.
  const donutTop = breakdown.slice(0,6).map((b,i)=>({label:b.label, value:b.bytes, color:i===0?C.ink:DONUT_RAMP[i]}));
  const donutRest = breakdown.slice(6).reduce((s,b)=>s+b.bytes,0);
  if (donutRest>0) donutTop.push({label:'Otras', value:donutRest, color:DONUT_RAMP[7]});

  // Huella por restaurante: real si hay datos, modelo si la plataforma está vacía
  const perRestFor   = months => restBaseBytes() + restMonthlyBytes()*Math.max(months,1);
  const measuredPerR = restCount>0 ? usedBytes/restCount : 0;
  const refPerR      = measuredPerR>0 ? measuredPerR : perRestFor(simMonths);

  // Capacidad teórica
  const maxRestStorage = Math.floor(limitBytes / Math.max(perRestFor(simMonths),1));
  const maxRestConn    = Math.floor(plan.rt_conn / Math.max(connPerRest,1));
  const latSec         = latency ? latency/1000 : 0.08;
  const reqPerSec      = Math.round(plan.db_conn / Math.max(latSec,0.01));

  // Simulación
  const simBytes      = restBaseBytes()*simRest + restMonthlyBytes()*simRest*simMonths;
  const simStoragePct = (simBytes/limitBytes)*100;
  const simConn       = simRest*connPerRest;
  const simConnPct    = (simConn/plan.rt_conn)*100;
  const binding       = simStoragePct>=simConnPct ? 'almacenamiento' : 'conexiones simultáneas';
  const maxRestBinding= Math.min(maxRestStorage, maxRestConn);
  const simOk         = simStoragePct<90 && simConnPct<90;

  const CapCard = ({label, value, sub, accent, pct}) => (
    <div style={{flex:'1 1 180px',background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:'16px 18px'}}>
      <div style={{fontSize:11,color:C.mid,fontWeight:600,textTransform:'uppercase',letterSpacing:.4,marginBottom:8}}>{label}</div>
      <div style={{fontSize:26,fontWeight:800,color:accent||C.ink,lineHeight:1}}>{value}</div>
      <div style={{fontSize:10,color:C.dim,marginTop:6}}>{sub}</div>
      {pct!=null && (
        <div style={{height:6,background:C.bg,borderRadius:3,overflow:'hidden',marginTop:10}}>
          <div style={{height:'100%',width:`${Math.max(0,Math.min(100,pct))}%`,background:capColor(pct),borderRadius:3,transition:'width .6s'}}/>
        </div>
      )}
    </div>
  );

  const Slider = ({label, value, min, max, step=1, onChange, fmt=(v=>v)}) => (
    <div style={{marginBottom:16}}>
      <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
        <span style={{fontSize:12,color:C.mid,fontWeight:600}}>{label}</span>
        <span style={{fontSize:13,color:C.ink,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace"}}>{fmt(value)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e=>onChange(Number(e.target.value))}
        style={{width:'100%',accentColor:C.ink,cursor:'pointer'}}/>
    </div>
  );

  const dot = c => <span style={{width:8,height:8,borderRadius:'50%',background:c,display:'inline-block'}}/>;

  return (
    <div className="animate-in">
      {/* Salud del sistema — movida desde el Dashboard (semáforo + alertas + métricas reales). */}
      <LiveHealth {...sys} enriched={enriched}/>
      <SystemHealth {...sys}/>

      {/* Intro / analogía */}
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:'16px 20px',marginBottom:18}}>
        <div style={{fontSize:15,fontWeight:700,color:C.ink,marginBottom:4}}>Análisis de carga de la base de datos</div>
        <div style={{fontSize:12,color:C.mid,lineHeight:1.5,maxWidth:760}}>
          Igual que en una obra se calcula el consumo eléctrico para dimensionar el tablero y saber cuántas cargas
          soporta, acá medimos el consumo real de la plataforma contra los límites de tu plan de Supabase:
          cuánta memoria de BD se está usando, cuántos restaurantes / ítems / usuarios entran, y cuántas conexiones
          simultáneas aguanta antes de saturarse.
        </div>
      </div>

      {/* Selector de plan + estado en vivo */}
      <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',marginBottom:18}}>
        <span style={{fontSize:12,color:C.mid,fontWeight:600}}>Plan Supabase:</span>
        {Object.keys(SUPA_PLANS).map(k=>(
          <FilterBtn key={k} active={planKey===k} onClick={()=>setPlanKey(k)}>{SUPA_PLANS[k].label}</FilterBtn>
        ))}
        <span style={{fontSize:11,color:C.dim,marginLeft:4}}>{plan.note}</span>
        <span style={{flex:1}}/>
        <span style={{display:'inline-flex',alignItems:'center',gap:6,fontSize:11,color:C.mid,background:C.bg,border:`1px solid ${C.border}`,borderRadius:20,padding:'4px 12px'}}>
          {dot(db ? (latency==null?C.mid:latency<200?C.green:latency<500?C.orange:C.red) : C.dim)}
          {db ? (latency==null?'midiendo…':`${latency} ms`) : 'modo demo'}
        </span>
      </div>

      {!db && (
        <div style={{background:C.orange+'1E',border:`1px solid ${C.orange}66`,borderRadius:10,padding:'10px 16px',marginBottom:18,fontSize:12,color:C.ink}}>
          Sin conexión a Supabase — se muestran estimaciones del modelo, no conteos reales.
        </div>
      )}

      {/* Uso actual real (lo que ya vive en la BD) */}
      <div className="sa-kpis" style={{marginBottom:18}}>
        <Kpi label="Restaurantes" value={loadingC?'…':fmtNum(restCount)} sub="activos en la plataforma"/>
        <Kpi label="Ítems de menú" value={loadingC?'…':fmtNum(itemsCount)} sub="filas en menu_items"/>
        <Kpi label="Usuarios" value={loadingC?'…':fmtNum(usersCount)} sub="roles registrados"/>
        <Kpi label="Pedidos" value={loadingC?'…':fmtNum(ordersCount)} sub="histórico en orders"/>
      </div>

      {/* Memoria de BD — tanque + capacidad */}
      <div style={{display:'grid',gridTemplateColumns:'280px 1fr',gap:18,alignItems:'stretch',marginBottom:18}}>
        <SectionCard title="Memoria de base de datos">
          <div style={{padding:'22px 20px 18px',display:'flex',flexDirection:'column',alignItems:'center'}}>
            <TankGauge pct={usedPct}
              label={`${fmtBytes(usedBytesShown)} usados`}
              value={`de ${fmtBytes(limitBytes)} (plan ${plan.label})`}
              sub={`quedan ${fmtBytes(Math.max(limitBytes-usedBytesShown,0))} libres`}/>
            <div style={{fontSize:10,color:C.dim,marginTop:8,textAlign:'center',maxWidth:220}}>
              {realBytes!=null ? 'Tamaño REAL de la BD (pg_database_size)' : 'Estimado filas × peso — el RPC de tamaño real no respondió'}
            </div>
            <div style={{display:'flex',gap:14,marginTop:16,flexWrap:'wrap',justifyContent:'center'}}>
              <span style={{display:'inline-flex',alignItems:'center',gap:5,fontSize:10,color:C.dim}}>{dot(C.green)} &lt;70% sano</span>
              <span style={{display:'inline-flex',alignItems:'center',gap:5,fontSize:10,color:C.dim}}>{dot(C.orange)} 70-90% atención</span>
              <span style={{display:'inline-flex',alignItems:'center',gap:5,fontSize:10,color:C.dim}}>{dot(C.red)} &gt;90% crítico</span>
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Capacidad estimada del plan">
          <div style={{padding:'18px 18px 6px',display:'flex',gap:12,flexWrap:'wrap'}}>
            <CapCard label="Restaurantes soportados" value={loadingC?'…':fmtNum(maxRestStorage)}
              sub={`con ~${simMonths} meses de historial · límite por memoria`} pct={restCount/Math.max(maxRestStorage,1)*100}/>
            <CapCard label="Restaurantes en simultáneo" value={fmtNum(maxRestConn)}
              sub={`${connPerRest} conexiones realtime c/u · límite ${fmtNum(plan.rt_conn)}`} accent={C.ink}/>
            <CapCard label="Usuarios concurrentes" value={fmtNum(plan.rt_conn)}
              sub={`conexiones realtime del plan · ${fmtNum(usersCount)} registrados hoy`}/>
            <CapCard label="Solicitudes / segundo" value={fmtNum(reqPerSec)}
              sub={`teórico · ${plan.db_conn} conexiones ÷ ${latency||80} ms`}/>
          </div>
          <div style={{padding:'4px 18px 16px',display:'flex',justifyContent:'center',gap:26,flexWrap:'wrap'}}>
            <SemiGauge pct={usedPct} value={`${usedPct<10?usedPct.toFixed(1):Math.round(usedPct)}%`} label="Memoria usada" sub={`${fmtBytes(usedBytesShown)} / ${fmtBytes(limitBytes)}`}/>
            <SemiGauge pct={restCount/Math.max(maxRestStorage,1)*100} value={`${fmtNum(restCount)}/${fmtNum(maxRestStorage)}`} label="Restaurantes" sub="usados / soportados" color={C.ink}/>
            <SemiGauge pct={(usersCount/Math.max(plan.rt_conn,1))*100} value={`${fmtNum(usersCount)}/${fmtNum(plan.rt_conn)}`} label="Usuarios / conexiones" sub="registrados / límite" color="#5856D6"/>
          </div>
        </SectionCard>
      </div>

      {/* Desglose de consumo por tabla */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 300px',gap:18,marginBottom:18,alignItems:'start'}}>
        <SectionCard title="Consumo de memoria por tabla">
          <div style={{padding:'18px 20px'}}>
            <HBars rows={topBreak.map(b=>({label:`${b.label}`, value:b.bytes, note:`· ${fmtNum(b.rows)} filas`}))} fmt={fmtBytes} barColor={C.ink}/>
            {topBreak.length===0 && <div style={{fontSize:12,color:C.dim,padding:'8px 0'}}>{loadingC?'Calculando conteos…':'Sin datos cargados todavía — la plataforma está vacía.'}</div>}
          </div>
          <div style={{padding:'0 20px 16px',fontSize:10,color:C.dim}}>Estimado: filas × peso medio por fila (datos + índices + overhead de Postgres).</div>
        </SectionCard>
        <SectionCard title="Proporción del almacenamiento">
          <div style={{padding:'18px',display:'flex',flexDirection:'column',alignItems:'center'}}>
            {donutTop.length>0
              ? <Donut data={donutTop} centerLabel={fmtBytes(usedBytes)} centerSub="total"/>
              : <div style={{fontSize:12,color:C.dim,padding:'30px 0'}}>{loadingC?'Calculando…':'Sin datos'}</div>}
            <div style={{marginTop:14,width:'100%'}}>
              {donutTop.map((d,i)=>(
                <div key={i} style={{display:'flex',alignItems:'center',gap:8,fontSize:11,marginBottom:5}}>
                  {dot(d.color)}<span style={{flex:1,color:C.mid}}>{d.label}</span>
                  <span style={{color:C.ink,fontFamily:"'SF Mono',ui-monospace,monospace"}}>{fmtBytes(d.value)}</span>
                </div>
              ))}
            </div>
          </div>
        </SectionCard>
      </div>

      {/* SIMULADOR de carga */}
      <SectionCard title="Simulador de carga — proyección hipotética">
        <div style={{margin:'14px 20px 0',background:TINT.infoBg,border:`1px solid ${C.border}`,borderRadius:10,padding:'10px 14px',fontSize:12,color:C.ink,lineHeight:1.5}}>
          <strong>Proyección hipotética — no es tu estado actual.</strong> Arranca en tus {fmtNum((enriched&&enriched.length)||0)} restaurantes reales; movés los controles para simular escenarios de crecimiento contra los límites del plan.
        </div>
        <div style={{padding:'20px',display:'grid',gridTemplateColumns:'320px 1fr',gap:24,alignItems:'center'}}>
          <div>
            <Slider label="Restaurantes a simular" value={simRest} min={1} max={1000} step={1} onChange={v=>{ setSimTouched(true); setSimRest(v); }} fmt={v=>fmtNum(v)}/>
            <Slider label="Meses de historial retenido" value={simMonths} min={1} max={60} onChange={setSimMonths} fmt={v=>`${v} m`}/>
            <Slider label="Conexiones simultáneas por restaurante" value={connPerRest} min={1} max={30} onChange={setConnPerRest} fmt={v=>`${v}`}/>
            <div style={{fontSize:10,color:C.dim,marginTop:4,lineHeight:1.5}}>
              Cada restaurante en servicio mantiene varias conexiones en vivo (cocina, caja, mozos, admin, clientes).
              El simulador proyecta la carga total contra los límites del plan <strong style={{color:C.mid}}>{plan.label}</strong>.
            </div>
          </div>
          <div>
            <div style={{display:'flex',gap:24,flexWrap:'wrap',marginBottom:16}}>
              <TankGauge pct={simStoragePct} height={150}
                label="Memoria proyectada"
                value={`${fmtBytes(simBytes)} / ${fmtBytes(limitBytes)}`}
                sub={`${Math.round(simStoragePct)}% del plan`}/>
              <TankGauge pct={simConnPct} height={150}
                label="Conexiones proyectadas"
                value={`${fmtNum(simConn)} / ${fmtNum(plan.rt_conn)}`}
                sub={`${Math.round(simConnPct)}% del plan`}/>
              <div style={{flex:'1 1 200px',display:'flex',flexDirection:'column',justifyContent:'center',gap:10}}>
                <div style={{background: simOk ? C.green+'1E' : C.red+'1E', border:`1px solid ${(simOk?C.green:C.red)}66`, borderRadius:10, padding:'14px 16px'}}>
                  <div style={{fontSize:12,fontWeight:700,color: simOk?C.green:C.red, marginBottom:4}}>
                    {simOk ? '✓ Dentro de capacidad' : 'Supera la capacidad'}
                  </div>
                  <div style={{fontSize:12,color:C.ink,lineHeight:1.5}}>
                    Con <strong>{fmtNum(simRest)}</strong> restaurantes y {simMonths} meses de historial, el límite que se
                    satura primero es <strong>{binding}</strong>. Tu plan {plan.label} soporta hasta
                    {' '}<strong>{fmtNum(maxRestBinding)}</strong> restaurantes en estas condiciones.
                  </div>
                </div>
                <div style={{fontSize:11,color:C.mid,display:'flex',flexDirection:'column',gap:3}}>
                  <span>{dot(capColor(simStoragePct))} Tope por memoria: <strong style={{color:C.ink}}>{fmtNum(maxRestStorage)}</strong> restaurantes</span>
                  <span>{dot(capColor(simConnPct))} Tope por conexiones: <strong style={{color:C.ink}}>{fmtNum(maxRestConn)}</strong> simultáneos</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </SectionCard>

      <div style={{marginTop:14,fontSize:10,color:C.dim,lineHeight:1.6}}>
        Los pesos por fila y el modelo de "restaurante típico" son estimaciones de ingeniería (la clave anónima del
        frontend no expone las métricas internas de disco/pool de Postgres). Para cifras exactas de disco, ancho de
        banda y conexiones, contrastá con el panel de <em>Reports → Database</em> de Supabase. Los conteos de filas
        sí son reales y medidos en vivo.
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// MÓDULO 2 — RESTAURANTES (cards grid)
// ══════════════════════════════════════════════════════════════
// ── Fila de un módulo/feature en el modal "Módulos y paneles" ────────────────
function ModRow({ label, sub, state, busy, onToggle, onRevert }) {
  return (
    <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 0',borderBottom:`1px solid ${C.border}`}}>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:13,fontWeight:600,color:C.ink,opacity:state.eff?1:.6}}>{label}</div>
        <div style={{fontSize:11,color:C.dim,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{sub}</div>
      </div>
      <span style={{fontSize:10,fontWeight:700,padding:'2px 8px',borderRadius:20,whiteSpace:'nowrap',
        background: state.source==='override'?TINT.warnBg:C.bg,
        color: state.source==='override'?TINT.warnText:C.mid,
        border: state.source==='override'?`1px solid ${TINT.warnBorder}`:`1px solid ${C.border}`}}>
        {state.source==='override'?'Override':'Plan'}
      </span>
      {onRevert && <span onClick={busy?undefined:onRevert} title="Volver al valor del plan"
        style={{fontSize:11,color:C.mid,cursor:busy?'default':'pointer',textDecoration:'underline',whiteSpace:'nowrap'}}>revertir</span>}
      <Toggle checked={state.eff} onChange={()=>{ if(!busy) onToggle(); }}/>
    </div>
  );
}

// ── Modal "Módulos y paneles" — overrides por restaurante (mig 146) ──────────
function ModulesModal({ r, onClose, setFlash, reload }) {
  const [caps, setCaps]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState(null);
  const [mode, setMode]       = useState(r.service_mode || null);   // service_mode (mig 173)
  const [modeBusy, setModeBusy] = useState(false);
  const arr = v => Array.isArray(v) ? v : [];

  const migMsg = m => /function|does not exist|schema cache/i.test(m||'') ? 'Falta aplicar la migración 146.' : ('Error: '+(m||''));
  // silent=true → refresca sin blanquear la lista a "Cargando…" (tras cada toggle).
  const load = async (silent=false) => {
    if (!silent) setLoading(true);
    try {
      const { data, error } = await db.rpc('get_restaurant_capabilities', { p_restaurant_id: r.id });
      if (error) throw error;
      setCaps(data || {});
    } catch (e) {
      setFlash({ type:'error', text: migMsg(e.message) });
      setCaps({});
    }
    if (!silent) setLoading(false);
  };
  useEffect(()=>{ load(); }, []);   // fresco al abrir

  // Modo de operación (mig 173): salón (mesas+QR) vs delivery (a domicilio). Se
  // guarda en restaurants.service_mode; degradación con gracia si falta la mig.
  useEffect(()=>{
    if (!db) return;
    db.from('restaurants').select('service_mode').eq('id', r.id).maybeSingle()
      .then(({ data })=>{ if (data) setMode(data.service_mode || 'salon'); })
      .catch(()=>{});
  }, []);
  const setServiceMode = async (m) => {
    if (!db || modeBusy || m === mode) return;
    setModeBusy(true);
    const { error } = await db.from('restaurants').update({ service_mode: m }).eq('id', r.id);
    if (error) setFlash({ type:'error', text: /service_mode|column|schema cache/i.test(error.message||'') ? 'Falta aplicar la migración 173.' : ('Error: '+error.message) });
    else { setMode(m); setFlash({ type:'ok', text:'Modo: '+(m==='delivery'?'Delivery a domicilio':'Local / Salón') }); if (reload) reload(); }
    setModeBusy(false);
  };

  const overrides  = (caps && caps.overrides) || {};
  const planPanels = arr(caps && caps.plan_panels);
  const effPanels  = arr(caps && caps.allowed_panels);
  const planFeats  = caps && caps.allowed_features;   // puede ser null (fail-open)
  // Plan "delivery lite" (Emprendedor Delivery, mig 175): sólo el panel a domicilio,
  // sin salón. Si el modo NO está en 'delivery', el Menú QR de salón sigue abierto y
  // el plan no cumple su promesa "sin salón" → nudge para activar el modo Delivery.
  const deliveryOnlyPlan = effPanels.includes('delivery-cliente')
    && !effPanels.includes('caja') && !effPanels.includes('mozo') && !effPanels.includes('cocina');

  const panelState = key => {
    const ov = 'panel:'+key, has = Object.prototype.hasOwnProperty.call(overrides, ov);
    return { hasOv:has, eff: effPanels.includes(key), source: has?'override':'plan' };
  };
  const featState = key => {
    const ov = 'feature:'+key, has = Object.prototype.hasOwnProperty.call(overrides, ov);
    const planOn = Array.isArray(planFeats) ? planFeats.includes(key) : true;   // null → on (fail-open)
    return { hasOv:has, eff: has ? overrides[ov]===true : planOn, source: has?'override':'plan' };
  };

  const setOv = async (key, enabled) => {
    if (!db) return;
    setBusyKey(key);
    const { error } = await db.rpc('superadmin_set_feature_override', { p_restaurant_id: r.id, p_key: key, p_enabled: enabled });
    if (error) setFlash({ type:'error', text: migMsg(error.message) });
    else { await load(true); if (reload) reload(); }
    setBusyKey(null);
  };
  const clearOv = async (key) => {
    if (!db) return;
    setBusyKey(key);
    const { error } = await db.rpc('superadmin_clear_feature_override', { p_restaurant_id: r.id, p_key: key });
    if (error) setFlash({ type:'error', text: migMsg(error.message) });
    else { setFlash({ type:'ok', text:'Revertido al plan' }); await load(true); if (reload) reload(); }
    setBusyKey(null);
  };

  const PANELS = [...PANEL_OPTIONS, { key:'admin', label:'Administración (dueño)' }];

  return (
    <Modal title={`Módulos y paneles — ${r.name}`} onClose={onClose} width={560}>
      {loading ? (
        <div style={{padding:'26px 0',textAlign:'center',color:C.mid,fontSize:13}}>Cargando…</div>
      ) : (
        <div>
          <div style={{fontSize:12,color:C.mid,marginBottom:16,lineHeight:1.5}}>
            El toggle define el valor <b>efectivo</b> para este restaurante. <b>Plan</b> = viene del plan/add-on; <b>Override</b> = forzado acá. Se aplica al recargar el panel del restaurante.
          </div>

          {/* Modo de operación (mig 173) — salón vs delivery a domicilio */}
          <div style={{fontSize:10,color:C.mid,fontWeight:700,textTransform:'uppercase',letterSpacing:.5,marginBottom:6}}>Modo de operación</div>
          <div style={{display:'flex',gap:8,marginBottom:6}}>
            {[{k:'salon',t:'Local / Salón',s:'Mesas + Menú QR'},{k:'delivery',t:'Delivery a domicilio',s:'Sólo delivery · sin mesas/QR'}].map(o=>{
              const on = mode===o.k;
              return (
                <button key={o.k} onClick={()=>setServiceMode(o.k)} disabled={modeBusy}
                  style={{flex:1,textAlign:'left',padding:'10px 12px',borderRadius:10,cursor:modeBusy?'default':'pointer',
                    border:`1.5px solid ${on?C.ink:C.border}`, background:on?(TINT.blueBg||C.bg):C.bg, opacity:modeBusy?.6:1}}>
                  <div style={{fontSize:12.5,fontWeight:700,color:C.ink}}>{o.t}{on?' ✓':''}</div>
                  <div style={{fontSize:10.5,color:C.mid,marginTop:2}}>{o.s}</div>
                </button>
              );
            })}
          </div>
          <div style={{fontSize:10.5,color:C.mid,marginBottom:16,lineHeight:1.45}}>
            En <b>Delivery</b> se desbloquea el pedido a domicilio (delivery-cliente) y se bloquean el Menú QR y las mesas. El dueño ve los pedidos en Admin → Pedidos.
          </div>

          {deliveryOnlyPlan && mode && mode!=='delivery' && (
            <div style={{background:TINT.warnBg,color:TINT.warnText,border:`1px solid ${TINT.warnBorder||C.orange}`,borderRadius:10,padding:'10px 12px',fontSize:11.5,lineHeight:1.45,marginBottom:16}}>
              Este restaurante tiene un <b>plan de delivery</b> (sólo panel a domicilio). Activá arriba el modo <b>Delivery a domicilio</b> para bloquear el Menú QR de salón y las mesas; si no, el QR de salón sigue abierto.
            </div>
          )}

          <div style={{fontSize:10,color:C.mid,fontWeight:700,textTransform:'uppercase',letterSpacing:.5,marginBottom:4}}>Paneles</div>
          {PANELS.map(p => {
            const s = panelState(p.key);
            return <ModRow key={p.key} label={p.label} sub={p.key} state={s} busy={busyKey==='panel:'+p.key}
              onToggle={()=>setOv('panel:'+p.key, !s.eff)} onRevert={s.hasOv?()=>clearOv('panel:'+p.key):null}/>;
          })}
          <div style={{fontSize:10,color:C.mid,fontWeight:700,textTransform:'uppercase',letterSpacing:.5,margin:'18px 0 4px'}}>Features (dentro de un panel)</div>
          {FEATURE_GROUPS.map(g => g.items.map(it => {
            const s = featState(it.key);
            return <ModRow key={it.key} label={it.label} sub={it.desc||it.key} state={s} busy={busyKey==='feature:'+it.key}
              onToggle={()=>setOv('feature:'+it.key, !s.eff)} onRevert={s.hasOv?()=>clearOv('feature:'+it.key):null}/>;
          }))}
          <div style={{display:'flex',justifyContent:'flex-end',marginTop:18}}>
            <Btn variant="ghost" onClick={onClose}>Cerrar</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Modal "Eliminar definitivamente" — Zona de peligro (mig 146 + endpoint) ──
function DeleteRestaurantModal({ r, onClose, setFlash, reload }) {
  const [typed, setTyped]     = useState('');
  const [alsoUsers, setAlso]  = useState(false);
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState('');
  const match = typed.trim() === (r.name||'').trim();

  const doDelete = async () => {
    if (!match || !db) return;
    setErr(''); setBusy(true);
    try {
      const { data:{ session } } = await db.auth.getSession();
      const token = session && session.access_token;
      if (!token) { setErr('Tu sesión expiró. Volvé a iniciar sesión.'); setBusy(false); return; }
      const resp = await fetch('/api/delete-restaurant', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+token },
        body: JSON.stringify({ restaurant_id: r.id, confirm_name: r.name, delete_users: alsoUsers })
      });
      const data = await resp.json().catch(()=>({}));
      if (resp.ok && data.success) {
        const nu = (data.users_deleted||[]).length;
        setFlash({ type:'ok', text:`"${r.name}" eliminado${nu?` (+${nu} cuenta${nu>1?'s':''})`:''}` });
        onClose(); if (reload) reload();
        return;
      }
      setErr(data.error || 'No se pudo eliminar. Probá de nuevo.');
    } catch (_) { setErr('Error de red. Probá de nuevo.'); }
    setBusy(false);
  };

  return (
    <Modal title="Eliminar restaurante" onClose={onClose} width={480}>
      <div style={{background:TINT.dangerBg,color:TINT.dangerText,border:`1px solid ${TINT.warnBorder}`,borderRadius:10,padding:'12px 14px',fontSize:12.5,lineHeight:1.55,marginBottom:16}}>
        Acción <b>irreversible</b>. Se borran TODOS los datos del restaurante (pedidos, menú, mesas, caja, stock, delivery, personal, suscripción…). Las <b>sucursales hijas NO se borran</b> (quedan independientes).
      </div>
      {err && <div style={{color:C.red,fontSize:12.5,marginBottom:12,fontWeight:600}}>{err}</div>}
      <FormField label={`Escribí el nombre exacto para confirmar`}>
        <input value={typed} onChange={e=>setTyped(e.target.value)} placeholder={r.name} autoFocus/>
      </FormField>
      <label style={{display:'flex',alignItems:'center',gap:10,fontSize:13,color:C.ink,cursor:'pointer',marginTop:4}}>
        <input type="checkbox" checked={alsoUsers} onChange={e=>setAlso(e.target.checked)} style={{width:15,height:15}}/>
        Eliminar también las cuentas de acceso de este restaurante
      </label>
      <div style={{fontSize:11,color:C.dim,margin:'6px 0 18px'}}>Nunca se toca la cuenta protegida ni usuarios con acceso a otro restaurante o superadmin.</div>
      <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="danger" onClick={doDelete} disabled={!match || busy}>{busy?'Eliminando…':'Eliminar definitivamente'}</Btn>
      </div>
    </Modal>
  );
}

/* ══════════════════════════════════════════════════════════════
   ASISTENTE "NUEVO CLIENTE" — alta guiada de punta a punta.
   4 pasos: (1) restaurante + dueño, (2) cuenta de acceso del dueño,
   (3) plan, (4) resumen con credenciales. Reusa /api/create-user
   (rol admin, must_change_password=true) — NUNCA service_role en el front.
   Tras crear, ofrece ajustar módulos (overrides, mig 146) para ese local.
══════════════════════════════════════════════════════════════ */
function genTempPassword() {
  const n = Math.floor(1000 + Math.random() * 9000);
  const syms = '!@#$%*';
  return 'Mythos' + n + syms[Math.floor(Math.random() * syms.length)];   // 11 chars: May+min+díg+símb
}
// Normaliza el usuario a lo que /api/create-user y login.html realmente aceptan
// (minúsculas, [a-z0-9._-]) → lo que se muestra = lo que funciona.
function slugUser(name) {
  return String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9._-]/g, '').slice(0, 24);
}

function NuevoClienteModal({plans, cityOptions, restHasCol, onOpenModules, onClose, setFlash, reload}) {
  const LOGIN_URL = window.location.origin + '/login';
  const STEPS = ['Restaurante', 'Acceso', 'Plan', 'Listo'];
  // Solo se ofrecen planes ACTIVOS al dar de alta un cliente nuevo.
  const offeredPlans = plans.filter(isPlanOffered);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);   // {restaurant, owner, error, partial}
  const [f, setF] = useState({
    name:'', city:'Asunción', owner_name:'', owner_email:'', owner_phone:'', owner_document:'',
    username:'', password: genTempPassword(),
    plan_id: offeredPlans[1]?.id || offeredPlans[0]?.id || '', status:'active',
  });
  const set = (k, v) => setF(s => ({...s, [k]: v}));

  const goStep2 = () => {
    if (!f.name.trim())       { setFlash({type:'error',text:'El nombre del restaurante es obligatorio'}); return; }
    if (!f.owner_name.trim()) { setFlash({type:'error',text:'El nombre del dueño es obligatorio'}); return; }
    if (f.owner_email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.owner_email.trim())) { setFlash({type:'error',text:'El email del dueño no parece válido'}); return; }
    if (!f.username) set('username', slugUser(f.name));   // sugerencia editable
    setStep(2);
  };
  const goStep3 = () => {
    const u = slugUser(f.username);
    if (u.length < 2) { setFlash({type:'error',text:'El usuario de acceso debe tener al menos 2 caracteres (letras/números)'}); return; }
    if (u !== f.username) set('username', u);
    if (!f.password || f.password.length < 8) { setFlash({type:'error',text:'La contraseña temporal debe tener al menos 8 caracteres'}); return; }
    setStep(3);
  };

  // Crea (o reintenta) la cuenta del dueño (rol admin) para un restaurante ya creado.
  const createOwner = async (restId) => {
    const { data:{ session } } = await db.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error('Sin sesión activa (volvé a iniciar sesión)');
    const resp = await fetch('/api/create-user', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${token}` },
      body: JSON.stringify({ username: f.username, password: f.password, display_name: f.owner_name.trim()||f.username, recovery_email: f.owner_email.trim()||undefined, role:'admin', restaurant_id: restId }),
    });
    const r = await resp.json();
    if (!resp.ok) throw new Error(r.error || 'No se pudo crear la cuenta del dueño');
    return r;
  };

  const create = async () => {
    if (!f.plan_id) { setFlash({type:'error',text:'Elegí un plan'}); return; }
    if (!db) { setFlash({type:'warn',text:'Sin conexión'}); return; }
    setBusy(true);
    let rest = null;
    try {
      const today = new Date(), end = await subscriptionEndDate(f.status, today);
      const payload = {
        name: f.name.trim(), city: f.city || null, country:'Paraguay',
        owner_name: f.owner_name.trim(), owner_email: f.owner_email.trim()||null, owner_phone: f.owner_phone.trim()||null,
        status: f.status, onboarding_date: isoLocal(today), timezone:'America/Asuncion', auto_provisioned:false,
      };
      if (restHasCol('owner_document') && f.owner_document.trim()) payload.owner_document = f.owner_document.trim();
      const { data:r1, error:e1 } = await db.from('restaurants').insert(payload).select().single();
      if (e1) throw new Error('No se pudo crear el restaurante: ' + e1.message);
      rest = r1;
      const plan = plans.find(p => p.id === f.plan_id);
      const { error:e2 } = await db.from('subscriptions').insert({
        restaurant_id: rest.id, plan_id: f.plan_id,
        status: f.status==='trial' ? 'trial' : 'active',
        start_date: isoLocal(today), end_date: isoLocal(end),
        monthly_amount: plan?.price_usd || 0,
      });
      if (e2) throw new Error('Restaurante creado, pero falló la suscripción: ' + e2.message);
      db.from('platform_events').insert({restaurant_id:rest.id, event_type:'onboarding', description:`Alta guiada — ${rest.name}`}).then(()=>{},()=>{});
      const owner = await createOwner(rest.id);
      setResult({ restaurant: rest, owner });
      setStep(4);
      reload();
    } catch (e) {
      setResult({ restaurant: rest, error: e.message, partial: !!rest });
      setStep(4);
      if (rest) reload();
    } finally { setBusy(false); }
  };

  const retryOwner = async () => {
    if (!result?.restaurant) return;
    setBusy(true);
    try {
      const owner = await createOwner(result.restaurant.id);
      setResult({ restaurant: result.restaurant, owner });
      setFlash({type:'success',text:'Cuenta del dueño creada'});
    } catch (e) {
      setResult({ ...result, error: e.message, partial: true });
    } finally { setBusy(false); }
  };

  const copyCreds = async () => {
    const uname = (result && result.owner && result.owner.username) || f.username;   // el que realmente creó el endpoint
    const txt = `Acceso Mythos — ${result?.restaurant?.name || f.name}\nURL: ${LOGIN_URL}\nUsuario: ${uname}\nContraseña temporal: ${f.password}\n(Se te pedirá cambiarla en el primer ingreso.)`;
    try { await navigator.clipboard.writeText(txt); setFlash({type:'success',text:'Credenciales copiadas'}); }
    catch(_) { setFlash({type:'warn',text:'No se pudo copiar automáticamente'}); }
  };

  const cred = {display:'flex',justifyContent:'space-between',gap:12,padding:'10px 0',borderBottom:`1px solid ${C.border}`,fontSize:13.5};

  return (
    <Modal title="Nuevo cliente" onClose={onClose} width={620}>
      {/* Stepper */}
      <div style={{display:'flex',gap:6,marginBottom:20}}>
        {STEPS.map((s,i)=>{
          const n=i+1, active=n===step, done=n<step;
          return (
            <div key={s} style={{flex:1,display:'flex',alignItems:'center',gap:8,opacity:active||done?1:.5}}>
              <span style={{width:22,height:22,borderRadius:'50%',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,fontWeight:800,background:active?C.ink:done?C.green:'transparent',color:active||done?C.surface:C.mid,border:`1.5px solid ${active?C.ink:done?C.green:C.border}`}}>{done?'✓':n}</span>
              <span style={{fontSize:12,fontWeight:active?700:500,color:active?C.ink:C.mid,whiteSpace:'nowrap'}}>{s}</span>
            </div>
          );
        })}
      </div>

      {/* Paso 1 — Restaurante + dueño */}
      {step===1 && (
        <div className="my-row-2" style={{gap:'0 16px'}}>
          <FormField label="Nombre del restaurante" col="1 / -1"><input value={f.name} onChange={e=>set('name',e.target.value)} placeholder="Ej. Pizzería Napoli" style={{width:'100%'}}/></FormField>
          <FormField label="Ciudad">
            <select value={f.city} onChange={e=>set('city',e.target.value)} style={{width:'100%'}}>
              {cityOptions.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
          </FormField>
          <FormField label="Estado inicial">
            <select value={f.status} onChange={e=>set('status',e.target.value)} style={{width:'100%'}}>
              <option value="active">Activo</option>
              <option value="trial">Prueba (trial)</option>
            </select>
          </FormField>
          <FormField label="Nombre del dueño / encargado" col="1 / -1"><input value={f.owner_name} onChange={e=>set('owner_name',e.target.value)} placeholder="Nombre y apellido" style={{width:'100%'}}/></FormField>
          <FormField label="Email del dueño (contacto)"><input type="email" value={f.owner_email} onChange={e=>set('owner_email',e.target.value)} placeholder="dueno@correo.com" style={{width:'100%'}}/></FormField>
          <FormField label="Teléfono del dueño"><input value={f.owner_phone} onChange={e=>set('owner_phone',e.target.value)} placeholder="09xx xxx xxx" style={{width:'100%'}}/></FormField>
          <FormField label="Documento / RUC del dueño" col="1 / -1"><input value={f.owner_document} onChange={e=>set('owner_document',e.target.value)} placeholder="C.I. o RUC" style={{width:'100%'}}/></FormField>
        </div>
      )}

      {/* Paso 2 — Cuenta de acceso del dueño */}
      {step===2 && (
        <div>
          <p style={{fontSize:12.5,color:C.mid,margin:'0 0 16px',lineHeight:1.55}}>
            Se crea la cuenta de acceso del dueño con <strong>rol Admin</strong>, ligada al restaurante. Entra con este <strong>usuario</strong> y una <strong>contraseña temporal</strong>; en el primer ingreso el sistema le pide cambiarla.
          </p>
          <FormField label="Usuario de acceso" hint="Con lo que inicia sesión. Solo minúsculas, números y . _ -">
            <input value={f.username} onChange={e=>set('username',e.target.value)} onBlur={()=>set('username',slugUser(f.username))} placeholder="napoli" style={{width:'100%'}}/>
          </FormField>
          <FormField label="Contraseña temporal" hint="Se la pasás al cliente. La cambia en su primer ingreso.">
            <div style={{display:'flex',gap:8}}>
              <input value={f.password} onChange={e=>set('password',e.target.value)} style={{flex:1,fontFamily:"'SF Mono',ui-monospace,monospace"}}/>
              <Btn variant="ghost" onClick={()=>set('password',genTempPassword())}>Regenerar</Btn>
            </div>
          </FormField>
        </div>
      )}

      {/* Paso 3 — Plan */}
      {step===3 && (
        <div>
          <FormField label="Plan de suscripción">
            <select value={f.plan_id} onChange={e=>set('plan_id',e.target.value)} style={{width:'100%'}}>
              <option value="">— Elegí un plan —</option>
              {offeredPlans.map(p=><option key={p.id} value={p.id}>{p.name}{p.price_usd!=null?` · ${fmtGs(p.price_usd)}/mes`:''}</option>)}
            </select>
          </FormField>
          <div style={{fontSize:12,color:C.dim,marginTop:6,lineHeight:1.5}}>
            Los módulos/paneles del cliente salen de su plan. Después de crear vas a poder <strong>ajustar módulos</strong> (activar/desactivar) para este local.
          </div>
        </div>
      )}

      {/* Paso 4 — Resumen */}
      {step===4 && (
        <div>
          {result?.owner ? (
            <>
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:14}}>
                <span style={{width:30,height:30,borderRadius:'50%',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',background:C.green,color:C.surface,fontWeight:800}}>✓</span>
                <div style={{fontSize:15,fontWeight:800,color:C.ink}}>Cliente creado</div>
              </div>
              <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:12,padding:'6px 16px',marginBottom:16}}>
                <div style={cred}><span style={{color:C.mid}}>Restaurante</span><strong style={{color:C.ink}}>{result.restaurant?.name}</strong></div>
                <div style={cred}><span style={{color:C.mid}}>URL de acceso</span><a href={LOGIN_URL} target="_blank" rel="noopener noreferrer" style={{color:C.ink,fontWeight:700}}>{LOGIN_URL}</a></div>
                <div style={cred}><span style={{color:C.mid}}>Usuario</span><strong style={{color:C.ink,fontFamily:"'SF Mono',ui-monospace,monospace"}}>{result.owner?.username || f.username}</strong></div>
                <div style={cred}><span style={{color:C.mid}}>Contraseña temporal</span><strong style={{color:C.ink,fontFamily:"'SF Mono',ui-monospace,monospace"}}>{f.password}</strong></div>
                {f.owner_email.trim() && <div style={cred}><span style={{color:C.mid}}>Email del dueño</span><span style={{color:C.ink}}>{f.owner_email.trim()}</span></div>}
                <div style={{...cred,borderBottom:'none'}}><span style={{color:C.mid}}>Primer ingreso</span><span style={{color:C.ink}}>Se le pedirá cambiar la contraseña</span></div>
              </div>
              <div style={{fontSize:12,color:C.dim,marginBottom:16,lineHeight:1.5}}>
                Pasale estos datos al cliente. Al entrar cambia la clave y luego acepta los Términos y la Privacidad (gate de primer ingreso).
              </div>
              <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                <Btn onClick={copyCreds}>Copiar credenciales</Btn>
                <Btn variant="ghost" onClick={()=>{ onOpenModules(result.restaurant); }}>Ajustar módulos</Btn>
              </div>
            </>
          ) : (
            <>
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
                <span style={{width:30,height:30,borderRadius:'50%',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',background:C.orange,color:C.surface,fontWeight:800}}>!</span>
                <div style={{fontSize:15,fontWeight:800,color:C.ink}}>Alta incompleta</div>
              </div>
              <div style={{border:`1px solid ${C.orange}`,background:TINT.warnBg,borderRadius:12,padding:'12px 16px',color:C.orange,fontSize:13,fontWeight:600,marginBottom:12}}>{result?.error||'Ocurrió un error'}</div>
              {result?.partial && result?.restaurant && (
                <>
                  <div style={{fontSize:13,color:C.mid,lineHeight:1.55,marginBottom:14}}>
                    El restaurante <strong style={{color:C.ink}}>{result.restaurant.name}</strong> ya quedó creado. Si el error fue por el usuario (ej. ya existía), cambialo y reintentá la cuenta del dueño.
                  </div>
                  <FormField label="Usuario de acceso" hint="Solo minúsculas, números y . _ -  ·  probá otro si el anterior estaba en uso.">
                    <input value={f.username} onChange={e=>set('username',e.target.value)} onBlur={()=>set('username',slugUser(f.username))} style={{width:'100%'}}/>
                  </FormField>
                  <FormField label="Contraseña temporal">
                    <div style={{display:'flex',gap:8}}>
                      <input value={f.password} onChange={e=>set('password',e.target.value)} style={{flex:1,fontFamily:"'SF Mono',ui-monospace,monospace"}}/>
                      <Btn variant="ghost" onClick={()=>set('password',genTempPassword())}>Regenerar</Btn>
                    </div>
                  </FormField>
                  <Btn onClick={retryOwner} disabled={busy}>{busy?'Reintentando…':'Reintentar cuenta del dueño'}</Btn>
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Navegación */}
      <div style={{display:'flex',justifyContent:'space-between',gap:10,marginTop:20,borderTop:`1px solid ${C.border}`,paddingTop:16}}>
        <div>{step>1 && step<4 && <Btn variant="ghost" onClick={()=>setStep(step-1)} disabled={busy}>Atrás</Btn>}</div>
        <div style={{display:'flex',gap:8}}>
          {step<4 && <Btn variant="ghost" onClick={onClose} disabled={busy}>Cancelar</Btn>}
          {step===1 && <Btn onClick={goStep2}>Siguiente</Btn>}
          {step===2 && <Btn onClick={goStep3}>Siguiente</Btn>}
          {step===3 && <Btn onClick={create} disabled={busy}>{busy?'Creando…':'Crear cliente'}</Btn>}
          {step===4 && <Btn onClick={onClose}>{result?.owner?'Listo':'Cerrar'}</Btn>}
        </div>
      </div>
    </Modal>
  );
}

function PageRestaurantes({enriched, plans, addonCatalog=[], setFlash, reload}) {
  const [modal,    setModal]    = useState(null);
  const [search,   setSearch]   = useState('');
  const [fPlan,    setFPlan]    = useState('all');
  const [fStatus,  setFStatus]  = useState('all');
  const [fCity,    setFCity]    = useState('all');
  const [sort,     setSort]     = useState('name');
  const [saving,   setSaving]   = useState(false);
  const emptyForm = {name:'',legal_name:'',ruc:'',city:'',country:'Paraguay',address:'',phone:'',email:'',owner_name:'',owner_email:'',owner_phone:'',owner_document:'',manager_name:'',manager_phone:'',status:'active',notes:'',plan_id:'',onboarding_date:todayPY(),maintenance_mode:false,maintenance_message:''};
  const [form, setForm] = useState(emptyForm);
  // Feature-detect de columnas nuevas (mig 145): true si CUALQUIER restaurante ya
  // trae la columna → así no mandamos owner_document/manager_* en el UPDATE/INSERT
  // si la migración aún no se aplicó (evita 400 en toda edición de restaurante).
  // Lista vacía (plataforma sin restaurantes) → asumimos que existen (optimista):
  // así el PRIMER alta no pierde los campos; el único costo sería un 400 si se crea
  // el primer local ANTES de aplicar la mig 145 (ventana mínima y con error visible).
  const restHasCol = c => enriched.length === 0 || enriched.some(r => Object.prototype.hasOwnProperty.call(r, c));
  // Multi-sucursal: modal de alta de Sucursal Hija anclada a una Casa Central
  const [branchModal, setBranchModal] = useState(null);   // {parent} | null
  const [branchForm,  setBranchForm]  = useState({name:'',phone:'',city:'Asunción'});
  // Sub-pestañas + Suscripciones (movido desde Facturación).
  const catalog = addonCatalog.length ? addonCatalog : DEFAULT_ADDONS;
  const [tab,      setTab]      = useState('restaurantes');
  const [subModal, setSubModal] = useState(null);
  const [subForm,  setSubForm]  = useState({});
  // Módulos/paneles + eliminación (mig 146)
  const [capsModal,   setCapsModal]   = useState(null);   // restaurante | null
  const [deleteModal, setDeleteModal] = useState(null);   // restaurante | null
  const [nuevoCliente, setNuevoCliente] = useState(false); // asistente de alta guiada

  // Ciudades presentes en los datos + cabeceras PY conocidas
  const cityOptions = Array.from(new Set([...CITIES_PY, ...enriched.map(r=>r.city).filter(Boolean)]));
  // Planes del filtro: derivados de los planes reales cargados (anti-drift; antes estaban
  // hardcodeados como Free/Starter/Pro/Enterprise, que ya no existen).
  const planOptions = Array.from(new Set(enriched.map(r=>r.plan?.name).filter(Boolean))).sort();

  const SORTS = {
    name:    {label:'Nombre (A-Z)',        fn:(a,b)=>a.name.localeCompare(b.name)},
    revenue: {label:'Mayor facturación',    fn:(a,b)=>b.revenue30-a.revenue30},
    clients: {label:'Más clientes',         fn:(a,b)=>b.clients-a.clients},
    mrr:     {label:'Más rentables (MRR)',   fn:(a,b)=>((b.subscription?.monthly_amount||0)+b.addonMRR)-((a.subscription?.monthly_amount||0)+a.addonMRR)},
    rating:  {label:'Mejor calificados',     fn:(a,b)=>(b.avgRating||0)-(a.avgRating||0)},
    oldest:  {label:'Más antiguos primero',  fn:(a,b)=>(a.created_at||'').localeCompare(b.created_at||'')},
    newest:  {label:'Más nuevos primero',    fn:(a,b)=>(b.created_at||'').localeCompare(a.created_at||'')},
  };

  const shown = enriched.filter(r=>{
    const q = search.toLowerCase();
    const mSearch = !q || r.name.toLowerCase().includes(q) || (r.city||'').toLowerCase().includes(q);
    const mPlan   = fPlan==='all'   || (r.plan?.name||'Sin plan')===fPlan;
    const mStatus = fStatus==='all' || (fStatus==='active'&&r.status==='active') || (fStatus==='inactive'&&['inactive','suspended','trial'].includes(r.status));
    const mCity   = fCity==='all'   || (r.city||'')===fCity;
    return mSearch && mPlan && mStatus && mCity;
  }).sort((SORTS[sort]||SORTS.name).fn);

  // Suscripciones para tabla (ordenadas por días restantes ASC) — movido desde Facturación
  const subs = [...enriched].sort((a,b)=>{
    const da = a.daysLeft??9999, db2 = b.daysLeft??9999;
    return da - db2;
  });

  const openCreate = () => { setForm({...emptyForm,plan_id:plans[1]?.id||''}); setModal('create'); };
  const openEdit   = r  => {
    setForm({name:r.name||'',legal_name:r.legal_name||'',ruc:r.ruc||'',city:r.city||'',country:r.country||'Paraguay',address:r.address||'',phone:r.phone||'',email:r.email||'',owner_name:r.owner_name||'',owner_email:r.owner_email||'',owner_phone:r.owner_phone||'',owner_document:r.owner_document||'',manager_name:r.manager_name||'',manager_phone:r.manager_phone||'',status:r.status,notes:r.notes||'',plan_id:r.subscription?.plan_id||'',onboarding_date:r.onboarding_date||todayPY(),maintenance_mode:r.maintenance_mode||false,maintenance_message:r.maintenance_message||''});
    setModal({edit:r});
  };

  const toggleStatus = async r => {
    // Desactivar (reversible): status='inactive' + is_active=false (deja de operar,
    // se oculta a clientes/QR). Reactivar: status='active' + is_active=true.
    const activating = r.status !== 'active';
    const next = activating ? 'active' : 'inactive';
    if (!db) { setFlash({type:'warn',text:'Sin conexión — operación demo'}); return; }
    const patch = { status: next };
    if (Object.prototype.hasOwnProperty.call(r, 'is_active')) patch.is_active = activating;   // feature-detect
    const {error} = await db.from('restaurants').update(patch).eq('id',r.id);
    if (error) { setFlash({type:'error',text:'Error: '+error.message}); return; }
    await db.from('platform_events').insert({restaurant_id:r.id,event_type:'status_changed',description:`Estado cambiado a ${next}`}).then(()=>{},()=>{});
    setFlash({type:'ok',text:`${r.name} → ${next}`}); reload();
  };

  const saveRestaurant = async () => {
    if (!form.name.trim()) { setFlash({type:'error',text:'El nombre es requerido'}); return; }
    if (!db) { setFlash({type:'warn',text:'Sin conexión — operación demo'}); return; }
    setSaving(true);
    try {
      const payload = {name:form.name.trim(),legal_name:form.legal_name||null,ruc:form.ruc||null,city:form.city,country:form.country,address:form.address||null,phone:form.phone||null,email:form.email||null,owner_name:form.owner_name||null,owner_email:form.owner_email||null,owner_phone:form.owner_phone||null,status:form.status,notes:form.notes||null,onboarding_date:form.onboarding_date,timezone:'America/Asuncion'};
      // Columnas de mig 145 — solo si ya existen (evita 400 pre-migración).
      if (restHasCol('owner_document')) payload.owner_document = form.owner_document||null;
      if (restHasCol('manager_name'))   payload.manager_name   = form.manager_name||null;
      if (restHasCol('manager_phone'))  payload.manager_phone  = form.manager_phone||null;
      // Modo mantenimiento (columnas mig 031) — feature-detect por robustez.
      if (restHasCol('maintenance_mode'))    payload.maintenance_mode    = !!form.maintenance_mode;
      if (restHasCol('maintenance_message')) payload.maintenance_message = form.maintenance_message||null;
      if (modal==='create') {
        const {data:rest,error} = await db.from('restaurants').insert({...payload,auto_provisioned:false}).select().single();
        if (error) throw error;
        if (form.plan_id) {
          const today=new Date(),end=await subscriptionEndDate(form.status, today);
          const plan=plans.find(p=>p.id===form.plan_id);
          await db.from('subscriptions').insert({restaurant_id:rest.id,plan_id:form.plan_id,status:form.status==='trial'?'trial':'active',start_date:isoLocal(today),end_date:isoLocal(end),monthly_amount:plan?.price_usd||0}).then(()=>{},()=>{});
        }
        await db.from('platform_events').insert({restaurant_id:rest.id,event_type:'onboarding',description:`Alta — ${form.status}`}).then(()=>{},()=>{});
        setFlash({type:'ok',text:`${form.name} dado de alta`});
      } else {
        const {error} = await db.from('restaurants').update(payload).eq('id',modal.edit.id);
        if (error) throw error;
        setFlash({type:'ok',text:`${form.name} actualizado`});
      }
      setModal(null); reload();
    } catch(e) { setFlash({type:'error',text:'Error: '+e.message}); }
    setSaving(false);
  };

  // ── Multi-sucursal: alta de Sucursal Hija ──────────────────────
  const isRoot = r => !r.parent_company_id || r.parent_company_id === r.id;
  const rootIdOf = r => r.parent_company_id || r.id;
  const parentName = r => (enriched.find(x=>x.id===r.parent_company_id)?.name) || '—';

  const openBranch = parent => {
    setBranchForm({name:'',phone:'',city:parent.city||'Asunción'});
    setBranchModal({parent});
  };

  const saveBranch = async () => {
    const parent = branchModal?.parent;
    if (!parent) return;
    if (!branchForm.name.trim()) { setFlash({type:'error',text:'El nombre de la sucursal es requerido'}); return; }
    if (!db) { setFlash({type:'warn',text:'Sin conexión — operación demo'}); return; }
    setSaving(true);
    try {
      const rootId = rootIdOf(parent);
      // 1) Registrar/incrementar el add-on 'sucursal_extra' en la cuenta raíz (facturable)
      const {data:exist} = await db.from('restaurant_addons')
        .select('id,quantity').eq('restaurant_id',rootId).eq('addon_key','sucursal_extra').maybeSingle();
      const extraPrice = (addonCatalog.find(a=>a.key==='sucursal_extra')||{}).price_usd ?? 180000;
      if (exist) {
        await db.from('restaurant_addons').update({quantity:(exist.quantity||1)+1,enabled:true}).eq('id',exist.id);
      } else {
        await db.from('restaurant_addons').insert({restaurant_id:rootId,addon_key:'sucursal_extra',price_usd:extraPrice,quantity:1,enabled:true}).then(()=>{},()=>{});
      }
      // 2) Crear la sucursal hija vinculada a la cuenta corporativa raíz
      const payload = {
        name:branchForm.name.trim(), parent_company_id:rootId,
        city:branchForm.city||parent.city||null, country:parent.country||'Paraguay',
        phone:branchForm.phone||null, status:'active', timezone:'America/Asuncion',
        owner_name:parent.owner_name||null, owner_email:parent.owner_email||null, owner_phone:parent.owner_phone||null,
        onboarding_date:todayPY(),
      };
      const {data:branch,error} = await db.from('restaurants').insert(payload).select().single();
      if (error) throw error;
      // 3) Heredar el plan base del padre (suscripción propia con mismo plan_id)
      const planId = parent.subscription?.plan_id;
      if (planId) {
        const today=new Date(),end=new Date(today);end.setMonth(end.getMonth()+1);
        const plan=plans.find(p=>p.id===planId);
        await db.from('subscriptions').insert({restaurant_id:branch.id,plan_id:planId,status:'active',start_date:isoLocal(today),end_date:isoLocal(end),monthly_amount:plan?.price_usd||0}).then(()=>{},()=>{});
      }
      await db.from('platform_events').insert({restaurant_id:branch.id,event_type:'onboarding',description:`Alta de sucursal — cuenta de ${parent.name}`}).then(()=>{},()=>{});
      setFlash({type:'ok',text:`Sucursal "${branchForm.name}" creada bajo ${parent.name}`});
      setBranchModal(null); reload();
    } catch(e) { setFlash({type:'error',text:'Error: '+e.message}); }
    setSaving(false);
  };

  const sf = v => e => setForm(f=>({...f,[v]:e.target.value}));
  const bf = v => e => setBranchForm(f=>({...f,[v]:e.target.value}));

  // ── Suscripciones (movido desde Facturación) ──────────────────
  const openEditSub = r => {
    const s = r.subscription||{};
    setSubForm({plan_id:s.plan_id||plans[0]?.id||'',status:s.status||'active',start_date:s.start_date||todayPY(),end_date:s.end_date||'',auto_renew:s.auto_renew!==false,payment_method:s.payment_method||'manual',monthly_amount:s.monthly_amount||'',grace_days:s.grace_days??'',addonKeys:(r.addons||[]).map(a=>a.addon_key)});
    setSubModal(r);
  };

  const saveSub = async () => {
    if (!db) { setFlash({type:'warn',text:'Sin conexión — operación demo'}); return; }
    setSaving(true);
    try {
      const sub = subModal.subscription;
      const payload = {plan_id:subForm.plan_id,status:subForm.status,start_date:subForm.start_date,end_date:subForm.end_date||null,auto_renew:subForm.auto_renew,payment_method:subForm.payment_method,monthly_amount:parseFloat(subForm.monthly_amount)||null};
      // Días de gracia (mig 193): override por cliente. Vacío = usar el del plan.
      // Deploy-safe: si la migración todavía no está aplicada la columna no existe,
      // así que se reintenta sin ella en vez de perder el resto de la edición.
      const graceVal = String(subForm.grace_days??'').trim()==='' ? null : Math.max(0, parseInt(subForm.grace_days,10)||0);
      const write = async body => sub?.id
        ? db.from('subscriptions').update(body).eq('id',sub.id)
        : db.from('subscriptions').insert({restaurant_id:subModal.id,...body});
      let {error} = await write({...payload, grace_days:graceVal});
      if (error && /grace_days/i.test(error.message||'')) {
        setFlash({type:'warn',text:'Días de gracia no guardados — ¿está aplicada la migración 193?'});
        ({error} = await write(payload));
      }
      if (error) throw error;
      // Reconciliar add-ons contratados por el restaurante
      const want = subForm.addonKeys||[];
      await db.from('restaurant_addons').delete().eq('restaurant_id',subModal.id);
      if (want.length) {
        const rows = want.map(k=>{ const c=catalog.find(x=>x.key===k); return {restaurant_id:subModal.id,addon_key:k,price_usd:c?.price_usd||0,enabled:true}; });
        const {error:addErr} = await db.from('restaurant_addons').insert(rows);
        if (addErr) throw addErr;
      }
      const planName = plans.find(p=>p.id===subForm.plan_id)?.name||'';
      await db.from('platform_events').insert({restaurant_id:subModal.id,event_type:'plan_changed',description:`Suscripción actualizada — ${planName}`}).then(()=>{},()=>{});
      setFlash({type:'ok',text:`Suscripción de ${subModal.name} actualizada`});
      setSubModal(null); reload();
    } catch(e) { setFlash({type:'error',text:'Error: '+e.message}); }
    setSaving(false);
  };

  const renew = async r => {
    if (!db) { setFlash({type:'warn',text:'Sin conexión — operación demo'}); return; }
    if (!r.subscription?.id) { openEditSub(r); return; }
    const base = r.subscription.end_date && new Date(r.subscription.end_date)>new Date() ? new Date(r.subscription.end_date) : new Date();
    const end = new Date(base); end.setMonth(end.getMonth()+1);
    const {error} = await db.from('subscriptions').update({status:'active',end_date:isoLocal(end)}).eq('id',r.subscription.id);
    if (error) { setFlash({type:'error',text:error.message}); return; }
    await db.from('platform_events').insert({restaurant_id:r.id,event_type:'subscription_renewed',description:`Renovación manual — ${r.plan?.name}`}).then(()=>{},()=>{});
    setFlash({type:'ok',text:`${r.name} renovado hasta ${fmtDate(end.toISOString())}`}); reload();
  };

  const ssf = v => e => setSubForm(f=>({...f,[v]:e.target.value}));
  const toggleSubAddon = key => setSubForm(f=>{const cur=f.addonKeys||[];return {...f,addonKeys:cur.includes(key)?cur.filter(k=>k!==key):[...cur,key]};});

  // Opciones de plan para asignar/cambiar: solo ACTIVOS, pero preservando el
  // plan que el restaurante YA tiene (aunque esté pausado/archivado) para no
  // perderlo silenciosamente al editar su suscripción.
  const planOpts = selectedId => {
    const offered = plans.filter(isPlanOffered);
    const sel = plans.find(p=>p.id===selectedId);
    return (sel && !isPlanOffered(sel)) ? [...offered, sel] : offered;
  };
  const planOptLabel = p => `${p.name} — ${fmtGuarani(p.price_usd)}/mes${isPlanOffered(p)?'':(PLAN_ST(p)==='archived'?' (archivado)':' (pausado)')}`;

  return (
    <div className="animate-in">
      {/* Sub-pestañas del módulo Restaurantes */}
      <div style={{display:'flex',gap:8,marginBottom:16}}>
        <FilterBtn active={tab==='restaurantes'} onClick={()=>setTab('restaurantes')}>Restaurantes</FilterBtn>
        <FilterBtn active={tab==='suscripciones'} onClick={()=>setTab('suscripciones')}>Suscripciones</FilterBtn>
      </div>

      {tab==='restaurantes' && (<>
      {/* Filtros */}
      <div style={{display:'flex',gap:8,marginBottom:18,flexWrap:'wrap',alignItems:'center'}}>
        <input placeholder="Buscar restaurante..." value={search} onChange={e=>setSearch(e.target.value)} style={{width:200,flex:'none'}}/>
        <select value={sort} onChange={e=>setSort(e.target.value)} style={{width:'auto',minWidth:170}}>
          {Object.entries(SORTS).map(([k,v])=><option key={k} value={k}>Ordenar: {v.label}</option>)}
        </select>
        <select value={fCity} onChange={e=>setFCity(e.target.value)} style={{width:'auto',minWidth:130}}>
          <option value="all">Todas las ciudades</option>
          {cityOptions.map(c=><option key={c} value={c}>{c}</option>)}
        </select>
        <select value={fPlan} onChange={e=>setFPlan(e.target.value)} style={{width:'auto',minWidth:130}}>
          <option value="all">Todos los planes</option>
          {planOptions.map(p=><option key={p} value={p}>{p}</option>)}
        </select>
        <select value={fStatus} onChange={e=>setFStatus(e.target.value)} style={{width:'auto',minWidth:110}}>
          <option value="all">Todos</option>
          <option value="active">Activos</option>
          <option value="inactive">Inactivos</option>
        </select>
        <span style={{fontSize:12,color:C.dim,marginLeft:4}}>{shown.length} resultado{shown.length!==1?'s':''}</span>
        <div style={{marginLeft:'auto',display:'flex',gap:8}}>
          <Btn onClick={()=>setNuevoCliente(true)}>+ Nuevo cliente</Btn>
          <Btn variant="ghost" onClick={openCreate}>Solo restaurante</Btn>
        </div>
      </div>

      {/* Cards grid */}
      {shown.length===0 ? (
        <div style={{textAlign:'center',padding:60,color:C.dim,fontSize:13}}>Sin resultados</div>
      ) : (
        <div className="cards-grid">
          {shown.map(r=>(
            <div key={r.id} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:20,display:'flex',flexDirection:'column',gap:0}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:10}}>
                <div>
                  <div style={{fontSize:16,fontWeight:700,color:C.ink,marginBottom:3,display:'flex',alignItems:'center',gap:6}}>
                    {r.name}
                    {!isRoot(r)&&<span title={`Sucursal de ${parentName(r)}`} style={{fontSize:9,fontWeight:800,background:C.ink,color:C.card,padding:'2px 7px',borderRadius:5,letterSpacing:.3,textTransform:'uppercase'}}>Sucursal</span>}
                    {r.auto_provisioned===true&&<span title="Registro self-service desde la web" style={{fontSize:9,fontWeight:800,background:TINT.infoBg,color:TINT.infoText,padding:'2px 7px',borderRadius:5,letterSpacing:.3,textTransform:'uppercase',whiteSpace:'nowrap'}}>Alta web</span>}
                  </div>
                  <div style={{fontSize:12,color:C.mid}}>{r.address||r.city}{r.city&&r.address?`, ${r.city}`:''}</div>
                  {r.created_at&&<div style={{fontSize:11,color:C.mid,marginTop:2}}>Alta: {fmtAlta(r.created_at)}</div>}
                  {(r.owner_name||r.manager_name)&&<div style={{fontSize:11,color:C.dim,marginTop:2}}>{r.owner_name?`Dueño: ${r.owner_name}`:''}{r.owner_name&&r.manager_name?' · ':''}{r.manager_name?`Encargado: ${r.manager_name}`:''}</div>}
                  {!isRoot(r)&&<div style={{fontSize:11,color:C.dim,marginTop:2}}>↳ {parentName(r)}</div>}
                </div>
                <div style={{display:'flex',flexDirection:'column',gap:4,alignItems:'flex-end'}}>
                  <PlanBadge name={r.plan?.name||'Sin plan'}/>
                  <Badge status={r.status}/>
                  {r.maintenance_mode===true&&<span title={r.maintenance_message||'Modo mantenimiento activo'} style={{padding:'2px 8px',borderRadius:4,background:C.orange,color:'#FFFFFF',fontSize:9,fontWeight:800,letterSpacing:'0.04em',whiteSpace:'nowrap'}}>EN MANTENIMIENTO</span>}
                </div>
              </div>
              <div style={{display:'flex',gap:0,margin:'10px 0',padding:'12px 0',borderTop:`1px solid #F5F5F7`,borderBottom:`1px solid #F5F5F7`}}>
                <div style={{flex:1,textAlign:'center'}}>
                  <div style={{fontSize:11,color:C.mid,marginBottom:2}}>Pedidos hoy</div>
                  <div style={{fontSize:18,fontWeight:700,color:C.ink}}>{r.ordersToday}</div>
                </div>
                <div style={{flex:1,textAlign:'center',borderLeft:`1px solid #F5F5F7`}}>
                  <div style={{fontSize:11,color:C.mid,marginBottom:2}}>MRR</div>
                  <div style={{fontSize:14,fontWeight:700,color:C.ink}}>{fmtGuarani(r.subscription?.monthly_amount||0)}</div>
                </div>
                <div style={{flex:1,textAlign:'center',borderLeft:`1px solid #F5F5F7`}}>
                  <div style={{fontSize:11,color:C.mid,marginBottom:2}}>Rating</div>
                  <div style={{fontSize:18,fontWeight:700,color:C.ink}}>{r.avgRating||'—'}</div>
                </div>
              </div>
              {(r.addons||[]).length>0&&(
                <div style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:4}}>
                  {r.addons.map(a=>(
                    <span key={a.addon_key} style={{fontSize:10,fontWeight:700,background:TINT.infoBg,color:TINT.infoText,padding:'2px 8px',borderRadius:5,whiteSpace:'nowrap'}}>
                      + {addonName(addonCatalog,a.addon_key)}
                    </span>
                  ))}
                </div>
              )}
              <div style={{display:'flex',gap:6,marginTop:8,flexWrap:'wrap'}}>
                <Btn size="sm" variant="ghost" onClick={()=>openEdit(r)}>Editar</Btn>
                <a href={`admin.html?r=${r.id}`} target="_blank" rel="noreferrer" style={{textDecoration:'none'}}>
                  <Btn size="sm" variant="ghost">Ver Admin</Btn>
                </a>
                {isRoot(r)&&<Btn size="sm" variant="ghost" onClick={()=>openBranch(r)}><Icon name="plus" size={12} style={{verticalAlign:'-2px',marginRight:3}}/>Añadir Sucursal Hija</Btn>}
                <Btn size="sm" variant="ghost" onClick={()=>setCapsModal(r)}>Módulos</Btn>
                <Btn size="sm" variant={r.status==='active'?'danger':'success'} onClick={()=>toggleStatus(r)}>
                  {r.status==='active'?'Desactivar':'Activar'}
                </Btn>
                <Btn size="sm" variant="danger" onClick={()=>setDeleteModal(r)}>Eliminar</Btn>
              </div>
            </div>
          ))}
        </div>
      )}
      </>)}

      {tab==='suscripciones' && (
        <SectionCard title="Suscripciones activas">
          <div className="tbl-wrap">
            <table style={{width:'100%',borderCollapse:'collapse',minWidth:820}}>
              <thead><tr>
                <Th>Restaurante</Th><Th>Plan</Th><Th>Precio</Th><Th>Inicio</Th><Th>Vencimiento</Th><Th>Estado</Th><Th>Acciones</Th>
              </tr></thead>
              <tbody>
                {subs.map(r=>{
                  const s = r.subscription;
                  const db2 = daysBadge(r.daysLeft);
                  const vencePronto = r.daysLeft!==null && r.daysLeft>=0 && r.daysLeft<=6;
                  const vencido     = r.daysLeft!==null && r.daysLeft<0;
                  return (
                    <tr key={r.id} style={{background:vencePronto?TINT.warnBg:vencido?TINT.dangerBg:'',transition:'background .1s'}}>
                      <Td><div style={{fontWeight:600}}>{r.name}</div><div style={{fontSize:11,color:C.mid}}>{r.city}</div></Td>
                      <Td><PlanBadge name={r.plan?.name}/></Td>
                      <Td style={{fontWeight:600}}>{s?fmtGuarani(s.monthly_amount||0):'—'}</Td>
                      <Td style={{fontSize:12,whiteSpace:'nowrap'}}>{fmtDate(s?.start_date)}</Td>
                      <Td style={{fontSize:12,whiteSpace:'nowrap'}}>
                        <div style={{display:'flex',flexDirection:'column',gap:3}}>
                          <span>{fmtDate(s?.end_date)}</span>
                          {vencePronto&&<span style={{padding:'2px 8px',borderRadius:4,background:C.orange,color:'#FFFFFF',fontSize:10,fontWeight:800,alignSelf:'flex-start',letterSpacing:'0.04em'}}>POR VENCER</span>}
                          {vencido&&<span style={{padding:'2px 8px',borderRadius:4,background:C.red,color:'#FFFFFF',fontSize:10,fontWeight:800,alignSelf:'flex-start',letterSpacing:'0.04em'}}>VENCIDO</span>}
                        </div>
                      </Td>
                      <Td><Badge status={s?.status||'inactive'}/></Td>
                      <Td>
                        <div style={{display:'flex',gap:4}}>
                          <Btn size="sm" variant="ghost" onClick={()=>openEditSub(r)}>Cambiar plan</Btn>
                          <Btn size="sm" variant="success" onClick={()=>renew(r)}>Renovar</Btn>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {modal&&(
        <Modal title={modal==='create'?'Nuevo restaurante':'Editar restaurante'} onClose={()=>setModal(null)} width={600}>
          <div className="my-row-2" style={{gap:'0 16px'}}>
            <FormField label="Nombre *" col="1/-1"><input value={form.name} onChange={sf('name')} placeholder="Nombre del restaurante" autoFocus/></FormField>
            <FormField label="Razón social"><input value={form.legal_name} onChange={sf('legal_name')} placeholder="Razón social S.A."/></FormField>
            <FormField label="RUC"><input value={form.ruc} onChange={sf('ruc')} placeholder="80000000-0"/></FormField>
            <FormField label="Ciudad">
              <select value={form.city} onChange={sf('city')}>
                <option value="">Seleccionar ciudad…</option>
                {cityOptions.map(c=><option key={c} value={c}>{c}</option>)}
              </select>
            </FormField>
            <FormField label="País"><input value={form.country} onChange={sf('country')}/></FormField>
            <FormField label="Dirección" col="1/-1"><input value={form.address} onChange={sf('address')} placeholder="Mcal. Estigarribia 1234"/></FormField>
            <FormField label="Teléfono"><input value={form.phone} onChange={sf('phone')} placeholder="+595 21 555 0100"/></FormField>
            <FormField label="Email del local"><input type="email" value={form.email} onChange={sf('email')} placeholder="contacto@restaurante.com"/></FormField>
            <FormField label="Plan de suscripción">
              {modal==='create' ? (
                <select value={form.plan_id} onChange={sf('plan_id')}>
                  <option value="">Sin asignar</option>
                  {planOpts(form.plan_id).map(p=><option key={p.id} value={p.id}>{planOptLabel(p)}</option>)}
                </select>
              ) : (
                <>
                  <input value={plans.find(p=>p.id===form.plan_id)?.name || 'Sin asignar'} disabled readOnly/>
                  <div style={{fontSize:11,color:C.dim,marginTop:5,lineHeight:1.45}}>El plan no se edita acá: cambialo desde <strong>Suscripciones → Cambiar plan</strong> (ahí se ajusta también el monto mensual).</div>
                </>
              )}
            </FormField>
            <FormField label="Estado">
              <select value={form.status} onChange={sf('status')}>
                <option value="active">Activo</option>
                <option value="trial">Trial</option>
                <option value="suspended">Suspendido</option>
                <option value="inactive">Inactivo</option>
              </select>
            </FormField>
            <FormField label="Fecha de alta"><input type="date" value={form.onboarding_date} onChange={sf('onboarding_date')}/></FormField>
          </div>
          <div style={{borderTop:`1px solid ${C.border}`,margin:'12px 0',paddingTop:14}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:10,textTransform:'uppercase',letterSpacing:.5}}>Dueño</div>
            <div className="my-row-2" style={{gap:'0 16px'}}>
              <FormField label="Nombre"><input value={form.owner_name} onChange={sf('owner_name')} placeholder="Nombre del dueño"/></FormField>
              <FormField label="Teléfono"><input value={form.owner_phone} onChange={sf('owner_phone')} placeholder="+595 981 123 456"/></FormField>
              <FormField label="Email"><input type="email" value={form.owner_email} onChange={sf('owner_email')} placeholder="dueno@restaurante.com"/></FormField>
              <FormField label="Documento / RUC"><input value={form.owner_document} onChange={sf('owner_document')} placeholder="C.I. o RUC"/></FormField>
            </div>
          </div>
          <div style={{borderTop:`1px solid ${C.border}`,margin:'12px 0',paddingTop:14}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:10,textTransform:'uppercase',letterSpacing:.5}}>Encargado <span style={{textTransform:'none',fontWeight:500,color:C.dim}}>(si difiere del dueño)</span></div>
            <div className="my-row-2" style={{gap:'0 16px'}}>
              <FormField label="Nombre"><input value={form.manager_name} onChange={sf('manager_name')} placeholder="Nombre del encargado"/></FormField>
              <FormField label="Teléfono"><input value={form.manager_phone} onChange={sf('manager_phone')} placeholder="+595 981 123 456"/></FormField>
            </div>
          </div>
          <div style={{borderTop:`1px solid ${C.border}`,margin:'12px 0',paddingTop:14}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:10,textTransform:'uppercase',letterSpacing:.5}}>Modo mantenimiento</div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,padding:'10px 14px',background:C.bg,borderRadius:8,border:form.maintenance_mode?`1px solid ${C.orange}`:`1px solid ${C.border}`}}>
              <div style={{fontSize:12.5,color:C.mid,lineHeight:1.5}}>
                Pausa la operación de cara al <strong>cliente</strong> (QR y delivery muestran "no disponible" y no pueden pedir) y avisa al <strong>staff</strong> con un banner. No bloquea el panel.
              </div>
              <Toggle checked={!!form.maintenance_mode} onChange={v=>setForm(f=>({...f,maintenance_mode:v}))}/>
            </div>
            {form.maintenance_mode&&(
              <div style={{marginTop:10}}>
                <FormField label="Mensaje para el cliente (opcional)">
                  <input value={form.maintenance_message} onChange={sf('maintenance_message')} placeholder="Ej: Volvemos en 30 minutos"/>
                </FormField>
              </div>
            )}
          </div>
          <FormField label="Notas internas"><textarea value={form.notes} onChange={sf('notes')} rows={2} placeholder="Observaciones internas..."/></FormField>
          <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:12}}>
            <Btn variant="ghost" onClick={()=>setModal(null)}>Cancelar</Btn>
            <Btn onClick={saveRestaurant} disabled={saving}>{saving?'Guardando…':'Guardar'}</Btn>
          </div>
        </Modal>
      )}

      {branchModal&&(
        <Modal title="Añadir Sucursal Hija" onClose={()=>setBranchModal(null)} width={520}>
          <div style={{display:'flex',alignItems:'center',gap:12,padding:'10px 14px',marginBottom:16,borderRadius:10,border:`1px solid ${C.ink}`,background:C.bg}}>
            <div style={{display:'flex',color:C.ink}}><Icon name="building" size={22}/></div>
            <div style={{flex:1}}>
              <div style={{fontSize:13,fontWeight:700,color:C.ink}}>Cuenta corporativa: {branchModal.parent.name}</div>
              <div style={{fontSize:11,color:C.mid}}>Hereda el plan <strong>{branchModal.parent.plan?.name||'base'}</strong> del local raíz y se factura como add-on “Sucursal Adicional”.</div>
            </div>
          </div>
          <div className="my-row-2" style={{gap:'0 16px'}}>
            <FormField label="Nombre de la sucursal *" col="1/-1"><input value={branchForm.name} onChange={bf('name')} placeholder={`${branchModal.parent.name} — Centro`} autoFocus/></FormField>
            <FormField label="Ciudad">
              <select value={branchForm.city} onChange={bf('city')}>
                <option value="">Seleccionar ciudad…</option>
                {Array.from(new Set([...CITIES_PY, branchForm.city].filter(Boolean))).map(c=><option key={c} value={c}>{c}</option>)}
              </select>
            </FormField>
            <FormField label="Teléfono"><input value={branchForm.phone} onChange={bf('phone')} placeholder="+595 21 555 0200"/></FormField>
          </div>
          <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:16}}>
            <Btn variant="ghost" onClick={()=>setBranchModal(null)}>Cancelar</Btn>
            <Btn onClick={saveBranch} disabled={saving}>{saving?'Creando…':'Crear sucursal'}</Btn>
          </div>
        </Modal>
      )}

      {/* Modal suscripción (movido desde Facturación) — fuera del switch de tabs, abre sobre cualquier vista */}
      {subModal&&(
        <Modal title={`Suscripción — ${subModal.name}`} onClose={()=>setSubModal(null)}>
          <FormField label="Plan">
            <select value={subForm.plan_id} onChange={e=>{
              // Al cambiar de plan, prellenar el monto mensual al precio del plan
              // nuevo (el usuario puede overridearlo luego en el campo de abajo).
              const pid = e.target.value;
              const pl = plans.find(p=>p.id===pid);
              setSubForm(f=>({...f, plan_id:pid, monthly_amount:(pl && pl.price_usd!=null) ? String(pl.price_usd) : f.monthly_amount}));
            }}>
              {planOpts(subForm.plan_id).map(p=><option key={p.id} value={p.id}>{planOptLabel(p)}</option>)}
            </select>
          </FormField>
          <div className="my-row-2" style={{gap:'0 16px'}}>
            <FormField label="Estado">
              <select value={subForm.status} onChange={ssf('status')}>
                {['active','trial','suspended','expired','cancelled','past_due'].map(s=><option key={s} value={s}>{statusMeta[s]?.label||s}</option>)}
              </select>
            </FormField>
            <FormField label="Monto mensual (₲)">
              <MoneyCcyInput value={subForm.monthly_amount} onChange={v=>setSubForm(f=>({...f,monthly_amount:v}))} placeholder="400000"/>
            </FormField>
            <FormField label="Método de pago">
              <select value={subForm.payment_method} onChange={ssf('payment_method')}>
                {['manual','transferencia','tarjeta','efectivo','qr'].map(m=><option key={m} value={m}>{m}</option>)}
              </select>
            </FormField>
            <FormField label="Auto-renovar">
              <div style={{display:'flex',alignItems:'center',gap:8,marginTop:6}}>
                <input type="checkbox" checked={subForm.auto_renew} onChange={e=>setSubForm(f=>({...f,auto_renew:e.target.checked}))} style={{width:16,height:16}}/>
                <span style={{fontSize:13,color:C.mid}}>Renovar automáticamente</span>
              </div>
            </FormField>
            <FormField label="Fecha inicio"><input type="date" value={subForm.start_date} onChange={ssf('start_date')}/></FormField>
            <FormField label="Fecha vencimiento"><input type="date" value={subForm.end_date} onChange={ssf('end_date')}/></FormField>
            {/* Gracia (mig 193): días que sigue operando después del vencimiento
                antes de cortarse el servicio. Vacío = el default del plan (5). */}
            <FormField label="Días de gracia">
              <input type="number" min="0" max="365" value={subForm.grace_days} onChange={ssf('grace_days')} placeholder="5 (del plan)"/>
            </FormField>
          </div>
          {/* Corte efectivo: lo que el dueño va a ver como fecha límite. */}
          {subForm.end_date && (() => {
            const g = String(subForm.grace_days??'').trim()==='' ? 5 : (parseInt(subForm.grace_days,10)||0);
            const corte = new Date(subForm.end_date+'T00:00:00'); corte.setDate(corte.getDate()+g);
            const cortado = corte < new Date(todayPY()+'T00:00:00');
            return (
              <div style={{fontSize:11,color:cortado?C.red:C.mid,background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:'8px 10px',marginTop:-2}}>
                {cortado
                  ? `Servicio CORTADO desde el ${fmtDate(isoLocal(corte))} — el local no puede operar ni recibir pedidos.`
                  : `Con ${g} días de gracia, el servicio se corta el ${fmtDate(isoLocal(corte))} si no se renueva.`}
              </div>
            );
          })()}

          {/* Add-ons del restaurante (cargos extra sobre el plan base) */}
          <div style={{borderTop:`1px solid ${C.border}`,marginTop:8,paddingTop:12}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:4,textTransform:'uppercase',letterSpacing:.5}}>Add-ons contratados (cargos extra)</div>
            <div style={{fontSize:11,color:C.dim,marginBottom:10}}>Habilitan un panel sin cambiar de plan. Se suman al precio base.</div>
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              {catalog.filter(a=>a.is_active!==false).map(a=>{
                const on = (subForm.addonKeys||[]).includes(a.key);
                return (
                  <label key={a.key} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 12px',borderRadius:8,cursor:'pointer',border:`1px solid ${on?C.ink:C.border}`,background:on?C.bg:'transparent'}}>
                    <input type="checkbox" checked={on} onChange={()=>toggleSubAddon(a.key)} style={{width:15,height:15}}/>
                    <span style={{flex:1,fontSize:13,fontWeight:600,color:C.ink}}>{a.name}</span>
                    <span style={{fontSize:12,color:C.mid}}>+{fmtGuarani(a.price_usd)}/mes</span>
                  </label>
                );
              })}
            </div>
            {(subForm.addonKeys||[]).length>0&&(
              <div style={{marginTop:10,fontSize:12,color:C.mid,textAlign:'right'}}>
                Extra add-ons: <strong style={{color:C.ink}}>{fmtGuarani((subForm.addonKeys||[]).reduce((s,k)=>s+(Number(catalog.find(x=>x.key===k)?.price_usd)||0),0))}/mes</strong>
              </div>
            )}
          </div>

          <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:8}}>
            <Btn variant="ghost" onClick={()=>setSubModal(null)}>Cancelar</Btn>
            <Btn onClick={saveSub} disabled={saving}>{saving?'Guardando…':'Guardar'}</Btn>
          </div>
        </Modal>
      )}

      {capsModal   && <ModulesModal          r={capsModal}   onClose={()=>setCapsModal(null)}   setFlash={setFlash} reload={reload}/>}
      {deleteModal && <DeleteRestaurantModal r={deleteModal} onClose={()=>setDeleteModal(null)} setFlash={setFlash} reload={reload}/>}
      {nuevoCliente && <NuevoClienteModal plans={plans} cityOptions={cityOptions} restHasCol={restHasCol}
        onOpenModules={r=>{ setNuevoCliente(false); setCapsModal(r); }}
        onClose={()=>setNuevoCliente(false)} setFlash={setFlash} reload={reload}/>}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// MÓDULO 3 — FACTURACIÓN (planes + suscripciones)
// ══════════════════════════════════════════════════════════════
/* ══════════════════════════════════════════════════════════════════════
   COBRO AUTOSERVICIO (mig 194) — la contraparte del checkout del dueño.
   ──────────────────────────────────────────────────────────────────────
   Los dueños ahora declaran su pago desde Admin › Plan y pagos (transferencia +
   comprobante). Acá se validan: aprobar extiende el período de verdad y aplica
   el cambio de plan; rechazar revierte la activación provisional y el local
   vuelve a quedar cortado. Toda la lógica vive en la RPC — este panel solo
   muestra y dispara.
══════════════════════════════════════════════════════════════════════ */

// Miniatura del comprobante: el bucket es privado, hay que firmar la URL.
function ProofThumb({ value, size = 44 }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!value || !db) return;
    if (/^https?:\/\//i.test(value)) { setUrl(value); return; }
    db.storage.from('comprobantes').createSignedUrl(value, 3600)
      .then(({data}) => { if (alive && data) setUrl(data.signedUrl); })
      .catch(()=>{});
    return () => { alive = false; };
  }, [value]);
  const base = {width:size,height:size,borderRadius:8,border:`1px solid ${C.border}`,flexShrink:0,objectFit:'cover'};
  if (!value) return <div style={{...base,background:C.bg,display:'inline-flex',alignItems:'center',justifyContent:'center',fontSize:11,color:C.dim}}>—</div>;
  if (!url)   return <div style={{...base,background:C.bg,display:'inline-flex',alignItems:'center',justifyContent:'center',fontSize:16}}>🧾</div>;
  return <a href={url} target="_blank" rel="noreferrer" style={{lineHeight:0,flexShrink:0}}>
    <img src={url} alt="comprobante" style={base} onError={e=>{e.target.style.display='none';}}/>
  </a>;
}

function PagosPorValidar({ restNameById, setFlash, reload }) {
  const [rows, setRows]     = useState(null);   // null=cargando · []=nada · [..]=pendientes
  const [busy, setBusy]     = useState('');
  const [reject, setReject] = useState(null);   // pago que se está rechazando
  const [note, setNote]     = useState('');
  const [unavailable, setUnavail] = useState(false);

  const load = useCallback(async () => {
    if (!db) { setRows([]); return; }
    const { data, error } = await db.from('payments')
      .select('id,restaurant_id,amount,method,reference,proof_url,months,created_at,provisional_until,plan_id,review_status')
      .eq('review_status','pending')
      .order('created_at',{ascending:true});
    // La mig 194 puede no estar aplicada → la columna review_status no existe.
    if (error) { setUnavail(/review_status|column|does not exist/i.test(error.message||'')); setRows([]); return; }
    setRows(data||[]);
  }, []);
  useEffect(()=>{ load(); },[load]);

  const review = async (pay, approve, notes) => {
    setBusy(pay.id);
    try {
      const { error } = await db.rpc('review_subscription_payment', {
        p_payment_id: pay.id, p_approve: approve, p_notes: notes || null,
      });
      if (error) throw error;
      setFlash({type:'ok', text: approve
        ? `Pago aprobado — ${restNameById[pay.restaurant_id]||'el local'} queda al día`
        : 'Pago rechazado — se revirtió la activación provisional'});
      setReject(null); setNote('');
      load(); reload && reload();
    } catch(e) {
      setFlash({type:'error', text:'Error: ' + (e.message||'no se pudo revisar el pago')});
    }
    setBusy('');
  };

  if (unavailable) return null;                       // sin mig 194: la sección no existe
  if (rows === null) return null;                     // cargando: sin parpadeo
  if (rows.length === 0) return null;                 // nada por validar: no ocupar espacio

  return (
    <div style={{border:`1px solid ${C.orange}`,borderRadius:12,background:C.card,marginBottom:24,overflow:'hidden'}}>
      <div style={{display:'flex',alignItems:'center',gap:10,padding:'13px 18px',borderBottom:`1px solid ${C.border}`,background:C.bg}}>
        <span style={{fontSize:16}}>🧾</span>
        <div style={{flex:1}}>
          <div style={{fontSize:13.5,fontWeight:800,color:C.ink}}>Pagos esperando tu validación</div>
          <div style={{fontSize:11.5,color:C.mid}}>Los dueños declararon estas transferencias desde su panel. Aprobar extiende el servicio.</div>
        </div>
        <span style={{fontSize:12,fontWeight:800,background:C.orange,color:'#FFF',padding:'2px 10px',borderRadius:12}}>{rows.length}</span>
      </div>
      {rows.map(p => (
        <div key={p.id} style={{display:'flex',alignItems:'center',gap:12,padding:'12px 18px',borderTop:`1px solid ${C.border}`,flexWrap:'wrap'}}>
          <ProofThumb value={p.proof_url}/>
          <div style={{flex:'1 1 220px',minWidth:0}}>
            <div style={{fontSize:13.5,fontWeight:700,color:C.ink}}>{restNameById[p.restaurant_id] || '—'}</div>
            <div style={{fontSize:11.5,color:C.mid}}>
              {fmtGuarani(p.amount)} · {p.months||1} {(p.months||1)===1?'mes':'meses'} · {p.method}
              {p.reference ? ` · Nº ${p.reference}` : ''} · {fmtDateTime(p.created_at)}
            </div>
            {p.provisional_until && (
              <div style={{fontSize:11,color:C.orange,fontWeight:700,marginTop:2}}>
                Activado provisionalmente hasta el {fmtDate(p.provisional_until)}
              </div>
            )}
          </div>
          <div style={{display:'flex',gap:7,flexShrink:0}}>
            <Btn size="sm" variant="success" onClick={()=>review(p,true)} disabled={busy===p.id}>
              {busy===p.id ? '…' : 'Aprobar'}
            </Btn>
            <Btn size="sm" variant="danger" onClick={()=>{setReject(p); setNote('');}} disabled={busy===p.id}>Rechazar</Btn>
          </div>
        </div>
      ))}

      {reject && (
        <Modal title="Rechazar el pago" onClose={()=>setReject(null)} width={440}>
          <div style={{fontSize:13,color:C.mid,lineHeight:1.6,marginBottom:16}}>
            Vas a rechazar el pago de <strong style={{color:C.ink}}>{restNameById[reject.restaurant_id]||'este local'}</strong> por {fmtGuarani(reject.amount)}.
            {reject.provisional_until && ' Se revierte la activación provisional: el local vuelve a quedar sin servicio.'}
          </div>
          <FormField label="Motivo (lo registra la bitácora)">
            <input value={note} onChange={e=>setNote(e.target.value)} placeholder="Ej. el comprobante no coincide con el monto" autoFocus/>
          </FormField>
          <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:16}}>
            <Btn variant="ghost" onClick={()=>setReject(null)}>Cancelar</Btn>
            <Btn variant="danger" onClick={()=>review(reject,false,note)} disabled={busy===reject.id}>
              {busy===reject.id ? 'Rechazando…' : 'Rechazar pago'}
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   HISTORIAL DE PAGOS — "dónde me llegan todos los pagos" (pedido de Renato).
   ──────────────────────────────────────────────────────────────────────
   PagosPorValidar es la BANDEJA DE ENTRADA: solo lo pendiente, y desaparece
   cuando no hay nada que hacer. Esto es el LIBRO: todo lo que entró alguna vez,
   aprobado o rechazado, con su comprobante, su período y quién lo validó.
   Los pagos con review_status NULL son cargas manuales del superadmin (el flujo
   viejo), y también se listan: es el mismo dinero.
══════════════════════════════════════════════════════════════════════ */
function HistorialPagos({ restNameById }) {
  const [rows, setRows]   = useState(null);
  const [filter, setFlt]  = useState('all');
  const [q, setQ]         = useState('');
  const [missing, setMiss]= useState(false);

  const load = useCallback(async () => {
    if (!db) { setRows([]); return; }
    const { data, error } = await db.from('payments')
      .select('id,restaurant_id,amount,method,status,review_status,reference,proof_url,months,period_start,period_end,paid_at,created_at,reviewed_at,review_notes,provisional_until')
      .order('created_at',{ascending:false})
      .limit(300);
    // Sin la mig 194 la columna review_status no existe → la sección no se muestra.
    if (error) { setMiss(/review_status|column|does not exist/i.test(error.message||'')); setRows([]); return; }
    setRows(data||[]);
  }, []);
  useEffect(()=>{ load(); },[load]);

  const META = {
    pending:  {label:'Pendiente', color:C.orange},
    approved: {label:'Aprobado',  color:C.green},
    rejected: {label:'Rechazado', color:C.red},
    manual:   {label:'Registrado',color:C.dim},
  };
  const stOf = p => p.review_status || 'manual';

  const all = rows || [];
  const shown = all.filter(p => {
    if (filter !== 'all' && stOf(p) !== filter) return false;
    if (!q.trim()) return true;
    const name = (restNameById[p.restaurant_id] || '').toLowerCase();
    return name.includes(q.trim().toLowerCase()) || String(p.reference||'').includes(q.trim());
  });

  // Cobrado = solo lo aprobado (o la carga manual del superadmin, que ya es plata
  // confirmada). Lo pendiente NO se cuenta como ingreso: todavía no se validó.
  const isIn   = p => stOf(p) === 'approved' || stOf(p) === 'manual';
  const when   = p => p.paid_at || p.reviewed_at || p.created_at;
  const mesIso = new Date().toISOString().slice(0,7);
  const cobradoMes   = all.filter(p => isIn(p) && String(when(p)||'').slice(0,7) === mesIso)
                          .reduce((s,p)=>s+Number(p.amount||0),0);
  const cobradoTotal = all.filter(isIn).reduce((s,p)=>s+Number(p.amount||0),0);
  const pendientes   = all.filter(p => stOf(p)==='pending');

  if (missing) return null;
  if (rows === null) return null;

  const KPI = ({label, value, color}) => (
    <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:'12px 18px',flex:'1 1 150px'}}>
      <div style={{fontSize:11,color:C.mid,marginBottom:4}}>{label}</div>
      <div style={{fontSize:20,fontWeight:800,color:color||C.ink}}>{value}</div>
    </div>
  );

  const TABS = [
    {id:'all',      label:`Todos (${all.length})`},
    {id:'pending',  label:`Pendientes (${pendientes.length})`},
    {id:'approved', label:'Aprobados'},
    {id:'rejected', label:'Rechazados'},
  ];

  return (
    <SectionCard title="Historial de pagos de suscripciones">
      <div style={{padding:'12px 16px 16px'}}>
        <div style={{display:'flex',gap:12,flexWrap:'wrap',marginBottom:14}}>
          <KPI label="Cobrado este mes" value={fmtGuarani(cobradoMes)}/>
          <KPI label="Cobrado histórico" value={fmtGuarani(cobradoTotal)}/>
          <KPI label="Esperando validación" value={fmtGuarani(pendientes.reduce((s,p)=>s+Number(p.amount||0),0))}
               color={pendientes.length ? C.orange : C.ink}/>
        </div>

        <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',marginBottom:12}}>
          {TABS.map(t=>(
            <button key={t.id} onClick={()=>setFlt(t.id)}
              style={{padding:'5px 12px',borderRadius:20,fontSize:12,fontWeight:700,cursor:'pointer',
                      border:`1px solid ${filter===t.id?C.ink:C.border}`,
                      background:filter===t.id?C.ink:'transparent',
                      color:filter===t.id?C.sidebar:C.mid}}>{t.label}</button>
          ))}
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Buscar local o Nº…"
                 style={{flex:'1 1 160px',minWidth:120,fontSize:12}}/>
          <Btn size="sm" variant="ghost" onClick={load}>Actualizar</Btn>
        </div>

        {shown.length === 0 ? (
          <div style={{fontSize:12.5,color:C.dim,padding:'18px 2px'}}>
            {all.length === 0
              ? 'Todavía no entró ningún pago. Cuando un dueño declare una transferencia desde su panel, aparece acá.'
              : 'Ningún pago coincide con el filtro.'}
          </div>
        ) : (
          <div style={{border:`1px solid ${C.border}`,borderRadius:10,overflow:'hidden'}}>
            {shown.map((p,i)=>{
              const m = META[stOf(p)];
              return (
                <div key={p.id} style={{display:'flex',alignItems:'center',gap:12,padding:'11px 14px',flexWrap:'wrap',
                                        borderTop:i?`1px solid ${C.border}`:'none'}}>
                  <ProofThumb value={p.proof_url}/>
                  <div style={{flex:'1 1 200px',minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:700,color:C.ink}}>{restNameById[p.restaurant_id] || '—'}</div>
                    <div style={{fontSize:11.5,color:C.mid}}>
                      {p.method || 'transferencia'}
                      {p.reference ? ` · Nº ${p.reference}` : ''}
                      {p.months ? ` · ${p.months} ${p.months===1?'mes':'meses'}` : ''}
                      {' · '}{fmtDateTime(p.created_at)}
                    </div>
                    {p.period_end && (
                      <div style={{fontSize:11,color:C.dim,marginTop:1}}>Cubre hasta el {fmtDate(p.period_end)}</div>
                    )}
                    {p.review_notes && (
                      <div style={{fontSize:11,color:C.mid,marginTop:2,fontStyle:'italic'}}>“{p.review_notes}”</div>
                    )}
                  </div>
                  <div style={{textAlign:'right',flexShrink:0}}>
                    <div style={{fontSize:14,fontWeight:800,color:C.ink}}>{fmtGuarani(p.amount)}</div>
                    <span style={{fontSize:10.5,fontWeight:800,color:m.color,letterSpacing:.3}}>{m.label.toUpperCase()}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </SectionCard>
  );
}

/* Subida de la FOTO del QR de cobro (pedido de Renato: "foto de mi qr", no una URL
   que hay que conseguir en otro lado). Va al bucket público `restaurant-images`
   bajo `platform/` — la policy de la mig 165 deja escribir ahí al superadmin
   (`get_my_role()='superadmin' OR carpeta = restaurant_id`) y la lectura del bucket
   es pública, que es justo lo que hace falta: el dueño tiene que poder verlo desde
   su panel. Se comprime a webp ≤800px (el QR tiene que quedar legible) para no
   subir una foto de 4 MB. Se mantiene el campo de URL como alternativa manual. */
function QrUploader({ value, onChange, setFlash }) {
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  const pick = async e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';                       // permite re-elegir el mismo archivo
    if (!file || !db) return;
    if (!/^image\//.test(file.type)) { setFlash({type:'error',text:'Ese archivo no es una imagen'}); return; }
    setBusy(true);
    try {
      const blob = await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => {
          const max = 800;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const cv = document.createElement('canvas');
          cv.width  = Math.round(img.width  * scale);
          cv.height = Math.round(img.height * scale);
          const cx = cv.getContext('2d');
          cx.fillStyle = '#FFFFFF';            // QR sobre fondo blanco: no confiar en el alfa
          cx.fillRect(0, 0, cv.width, cv.height);
          cx.drawImage(img, 0, 0, cv.width, cv.height);
          cv.toBlob(b => b ? res(b) : rej(new Error('No se pudo procesar la imagen')), 'image/webp', 0.92);
        };
        img.onerror = () => rej(new Error('No se pudo leer la imagen'));
        img.src = URL.createObjectURL(file);
      });

      const path = `platform/qr-${Date.now()}.webp`;
      const { error: upErr } = await db.storage.from('restaurant-images')
        .upload(path, blob, { contentType: 'image/webp', upsert: true });
      if (upErr) throw upErr;
      const { data } = db.storage.from('restaurant-images').getPublicUrl(path);
      if (!data || !data.publicUrl) throw new Error('No se pudo obtener el enlace de la imagen');
      onChange(data.publicUrl);
      setFlash({type:'ok',text:'QR cargado — acordate de Guardar para que lo vean tus clientes'});
    } catch (err) {
      setFlash({type:'error',text:'No se pudo subir el QR: ' + (err.message||'error desconocido')});
    }
    setBusy(false);
  };

  return (
    <div style={{display:'flex',gap:14,alignItems:'flex-start',flexWrap:'wrap'}}>
      <div style={{width:104,height:104,borderRadius:10,border:`1px solid ${C.border}`,background:C.bg,
                   display:'flex',alignItems:'center',justifyContent:'center',overflow:'hidden',flexShrink:0}}>
        {value
          ? <img src={value} alt="QR de cobro" style={{width:'100%',height:'100%',objectFit:'contain'}}
                 onError={e=>{e.target.style.display='none';}}/>
          : <span style={{fontSize:11,color:C.dim,textAlign:'center',padding:8}}>Sin QR<br/>cargado</span>}
      </div>
      <div style={{flex:'1 1 220px',minWidth:0}}>
        <input ref={inputRef} type="file" accept="image/*" onChange={pick} style={{display:'none'}}/>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          <Btn size="sm" variant="ghost" onClick={()=>inputRef.current && inputRef.current.click()} disabled={busy}>
            {busy ? 'Subiendo…' : (value ? 'Cambiar foto' : 'Subir foto del QR')}
          </Btn>
          {value && <Btn size="sm" variant="ghost" onClick={()=>onChange('')} disabled={busy}>Quitar</Btn>}
        </div>
        <div style={{fontSize:11,color:C.dim,margin:'8px 0 5px',lineHeight:1.5}}>
          Sacale una captura al QR de tu billetera o banco. Se comprime solo.
        </div>
        <input value={value||''} onChange={e=>onChange(e.target.value)} placeholder="…o pegá una URL"
               style={{width:'100%',fontSize:11.5}}/>
      </div>
    </div>
  );
}

/* Datos bancarios de MYTHOS: lo que ve el dueño en su checkout. Sin esto cargado,
   el modal de pago del dueño muestra "todavía no cargamos los datos de cobro". */
function DatosDeCobro({ setFlash }) {
  const EMPTY = {bank_holder:'',bank_name:'',bank_account:'',bank_doc:'',bank_alias:'',qr_url:'',instructions:'',provisional_days:3,accepts_cash:false};
  const [form, setForm]   = useState(null);   // null = cargando
  const [saving, setSav]  = useState(false);
  const [missing, setMiss]= useState(false);

  useEffect(()=>{
    let alive = true;
    if (!db) { setForm(EMPTY); return; }
    db.from('platform_billing_config').select('*').eq('id',true).maybeSingle()
      .then(({data,error})=>{
        if (!alive) return;
        if (error) { setMiss(true); setForm(EMPTY); return; }
        setForm({...EMPTY, ...(data||{})});
      })
      .catch(()=>{ if(alive){ setMiss(true); setForm(EMPTY); } });
    return ()=>{ alive = false; };
  },[]);

  const sf = k => e => setForm(f=>({...f,[k]:e.target.value}));

  const save = async () => {
    if (!db) return;
    setSav(true);
    try {
      const payload = {
        id: true,
        bank_holder: form.bank_holder||null, bank_name: form.bank_name||null,
        bank_account: form.bank_account||null, bank_doc: form.bank_doc||null,
        bank_alias: form.bank_alias||null, qr_url: form.qr_url||null,
        instructions: form.instructions||null,
        provisional_days: Math.max(0, Math.min(30, parseInt(form.provisional_days,10)||0)),
        accepts_cash: !!form.accepts_cash,
        updated_at: new Date().toISOString(),
      };
      const { error } = await db.from('platform_billing_config').upsert(payload,{onConflict:'id'});
      if (error) throw error;
      setFlash({type:'ok',text:'Datos de cobro actualizados — ya los ven tus clientes al pagar'});
    } catch(e) { setFlash({type:'error',text:'Error: '+e.message}); }
    setSav(false);
  };

  if (missing) return null;        // sin mig 194 aplicada
  if (!form)   return null;

  return (
    <SectionCard title="Datos de cobro de MYTHOS (los ve el dueño al pagar)">
      <div style={{padding:'12px 16px 16px'}}>
        <div style={{fontSize:11.5,color:C.dim,marginBottom:14,lineHeight:1.55}}>
          Es la cuenta a la que transfieren tus clientes desde Admin › Plan y pagos. Si está vacío, el checkout les dice que te contacten.
        </div>
        <div className="my-row-2" style={{gap:'0 16px'}}>
          <FormField label="Titular"><input value={form.bank_holder||''} onChange={sf('bank_holder')} placeholder="Nombre del titular"/></FormField>
          <FormField label="Banco / financiera"><input value={form.bank_name||''} onChange={sf('bank_name')} placeholder="Banco…"/></FormField>
          <FormField label="Nº de cuenta"><input value={form.bank_account||''} onChange={sf('bank_account')} placeholder="000-000000-0"/></FormField>
          <FormField label="RUC / CI"><input value={form.bank_doc||''} onChange={sf('bank_doc')} placeholder="0000000-0"/></FormField>
          <FormField label="Alias / billetera"><input value={form.bank_alias||''} onChange={sf('bank_alias')} placeholder="09xx xxx xxx"/></FormField>
          <FormField label="QR de pago" col="1/-1">
            <QrUploader value={form.qr_url} onChange={v=>setForm(f=>({...f,qr_url:v}))} setFlash={setFlash}/>
          </FormField>
          <FormField label="Instrucciones para el cliente" col="1/-1">
            <input value={form.instructions||''} onChange={sf('instructions')} placeholder="Transferí y subí la foto del comprobante. Validamos en el día."/>
          </FormField>
          <FormField label="Días de activación provisional"
                     hint="Servicio que se otorga al instante al enviar un comprobante, antes de que vos lo valides. 0 = desactivado.">
            <input type="number" min="0" max="30" value={form.provisional_days??3} onChange={sf('provisional_days')}/>
          </FormField>
          <FormField label="Aceptar efectivo">
            <div style={{display:'flex',alignItems:'center',gap:8,marginTop:6}}>
              <input type="checkbox" checked={!!form.accepts_cash} onChange={e=>setForm(f=>({...f,accepts_cash:e.target.checked}))} style={{width:16,height:16}}/>
              <span style={{fontSize:13,color:C.mid}}>Mostrar "efectivo" como método</span>
            </div>
          </FormField>
        </div>
        <div style={{display:'flex',justifyContent:'flex-end',marginTop:10}}>
          <Btn onClick={save} disabled={saving}>{saving?'Guardando…':'Guardar datos de cobro'}</Btn>
        </div>
      </div>
    </SectionCard>
  );
}

function PageFacturacion({enriched, plans, addonCatalog=[], platformConfig=[], setFlash, reload}) {
  const EMPTY_PLAN = {name:'',price_usd:'',billing_cycle:'monthly',max_tables:'',max_menu_items:'',features:'',is_active:true,...Object.fromEntries(LIMIT_ROLES.map(lr=>['max_'+lr.key,''])),panels:[],allowed_features:[]};
  const currentCcy = CURRENCIES[platformConfig.find(c=>c.key==='platform_currency')?.value] ? platformConfig.find(c=>c.key==='platform_currency').value : 'PYG';
  const [savingCcy, setSavingCcy] = useState(false);
  const saveCurrency = async (code) => {
    if (code===currentCcy || !CURRENCIES[code]) return;
    setPlatformCurrency(code);   // refleja al instante en toda la UI de dinero
    if (!db) { setFlash({type:'warn',text:'Sin conexión — operación demo'}); return; }
    setSavingCcy(true);
    const {error} = await db.from('platform_config').upsert({key:'platform_currency',value:code,updated_at:new Date().toISOString()},{onConflict:'key'});
    setSavingCcy(false);
    if (error) { setFlash({type:'error',text:'Error: '+error.message}); return; }
    setFlash({type:'ok',text:`Moneda de la plataforma: ${CURRENCIES[code].label}`}); reload();
  };
  const [planModal, setPlanModal]   = useState(null);
  const [planForm,  setPlanForm]    = useState(EMPTY_PLAN);
  const [saving,    setSaving]      = useState(false);
  const [planBusy,  setPlanBusy]    = useState(null);   // id del plan cuyo ciclo de vida se está cambiando
  const [deletePlan,setDeletePlan]  = useState(null);   // {plan, count} para el modal de eliminación
  const [showArchived,setShowArchived] = useState(false);
  const catalog = addonCatalog.length ? addonCatalog : DEFAULT_ADDONS;
  const [addonForm, setAddonForm]   = useState({});   // {key:{price_usd,is_active}}
  const [savingAddon, setSavingAddon] = useState('');
  useEffect(()=>{
    const init = {};
    catalog.forEach(a=>{ init[a.key]={price_usd:a.price_usd??'',is_active:a.is_active!==false}; });
    setAddonForm(init);
  },[addonCatalog]);

  const saveAddon = async (a) => {
    if (!db) { setFlash({type:'warn',text:'Sin conexión — operación demo'}); return; }
    setSavingAddon(a.key);
    try {
      const f = addonForm[a.key]||{};
      const payload = {key:a.key,name:a.name,panel:a.panel,price_usd:parseFloat(f.price_usd)||0,is_active:f.is_active!==false};
      const {error} = await db.from('plan_addons').upsert(payload,{onConflict:'key'});
      if (error) throw error;
      setFlash({type:'ok',text:`Add-on "${a.name}" actualizado`}); reload();
    } catch(e){ setFlash({type:'error',text:'Error: '+e.message}); }
    setSavingAddon('');
  };

  // Plan más vendido
  const subCountByPlan = {};
  enriched.forEach(r=>{ if(r.subscription?.plan_id&&r.status!=='suspended') subCountByPlan[r.subscription.plan_id]=(subCountByPlan[r.subscription.plan_id]||0)+1; });
  const popularPlanId = Object.entries(subCountByPlan).sort((a,b)=>b[1]-a[1])[0]?.[0];

  // Grandfathering: el MRR de suscripciones EXISTENTES usa el snapshot congelado
  // (subscriptions.monthly_amount), NO el precio vivo del plan (price_usd).
  const mrrTotal = enriched.filter(r=>r.status!=='suspended').reduce((s,r)=>s+(Number(r.subscription?.monthly_amount)||0),0);

  const openEditPlan = p => {
    const mubr = asObj(p.max_users_by_role);
    setPlanForm({
      name:p.name,price_usd:p.price_usd,billing_cycle:p.billing_cycle,
      max_tables:p.max_tables??'',max_menu_items:p.max_menu_items??'',
      features:Array.isArray(p.features)?p.features.join(', '):(typeof p.features==='string'?asArr(p.features).join(', '):''),
      is_active:p.is_active!==false,
      ...Object.fromEntries(LIMIT_ROLES.map(lr=>['max_'+lr.key, mubr[lr.key]??''])),
      panels:asArr(p.allowed_panels),
      allowed_features:asArr(p.allowed_features),
    });
    setPlanModal({edit:p});
  };

  const savePlan = async () => {
    if (!planForm.name.trim()) { setFlash({type:'error',text:'El nombre es requerido'}); return; }
    if (!db) { setFlash({type:'warn',text:'Sin conexión — operación demo'}); return; }
    setSaving(true);
    try {
      const feats = planForm.features ? planForm.features.split(',').map(s=>s.trim()).filter(Boolean) : [];
      const mubr = {};
      LIMIT_ROLES.forEach(lr=>{
        const v = planForm['max_'+lr.key];
        if (v!=='' && v!=null) mubr[lr.key] = parseInt(v);
      });
      // El ciclo de vida (activo/pausado/archivado) se maneja con los botones de
      // la tarjeta, NO desde este editor: por eso el payload NO envía is_active en
      // una edición (así no se re-activa un plan pausado al guardar cambios de
      // precio/nombre). Al CREAR, el plan nace 'active'.
      const base = {name:planForm.name.trim(),price_usd:parseFloat(planForm.price_usd)||0,billing_cycle:planForm.billing_cycle,max_tables:numOrNull(planForm.max_tables),max_menu_items:numOrNull(planForm.max_menu_items),features:JSON.stringify(feats),max_users_by_role:mubr,allowed_panels:planForm.panels||[],allowed_features:planForm.allowed_features||[]};
      const payload = planModal==='create' ? {...base, status:'active'} : base;
      const writePlan = async pl => planModal==='create'
        ? db.from('subscription_plans').insert(pl)
        : db.from('subscription_plans').update(pl).eq('id',planModal.edit.id);
      let degraded = false;
      let pl = {...payload};
      let {error} = await writePlan(pl);
      // Degrada con gracia si la migración 152 (columna status) aún no corrió.
      if (error && /\bstatus\b/.test(error.message||'')) {
        const {status, ...noStatus} = pl;
        pl = planModal==='create' ? {...noStatus, is_active:true} : noStatus;
        ({error} = await writePlan(pl));
      }
      // Degrada con gracia si la migración 091 (columna allowed_features) aún no corrió.
      if (error && /allowed_features/.test(error.message||'')) {
        const {allowed_features, ...legacy} = pl;
        pl = legacy;
        ({error} = await writePlan(pl));
        degraded = !error;
      }
      if (error) throw error;
      setFlash(degraded
        ? {type:'warn',text:'Plan guardado, pero las características granulares requieren la migración 091.'}
        : {type:'ok',text:`Plan "${planForm.name}" ${planModal==='create'?'creado':'actualizado'}`});
      setPlanModal(null); reload();
    } catch(e) { setFlash({type:'error',text:'Error: '+e.message}); }
    setSaving(false);
  };

  // ── Ciclo de vida del plan (status: active | inactive | archived) ──────
  //   Pausar/archivar solo cambian la DISPONIBILIDAD del plan; las
  //   suscripciones existentes NO se tocan (los restaurantes siguen operando).
  //   is_active se mantiene = (status==='active') por trigger (mig 152); acá lo
  //   enviamos también para que las lecturas legacy sean correctas aun sin la
  //   migración aplicada. La vidriera pública (marketing_plans vinculados) se
  //   espeja best-effort para que el plan también desaparezca de /precios.
  const setPlanStatus = async (p, newStatus, verb) => {
    if (!db) { setFlash({type:'warn',text:'Sin conexión — operación demo'}); return; }
    setPlanBusy(p.id);
    try {
      const active = newStatus==='active';
      let {error} = await db.from('subscription_plans').update({status:newStatus, is_active:active}).eq('id',p.id);
      if (error && /\bstatus\b/.test(error.message||'')) {
        // Migración 152 aún no aplicada: degradar a solo is_active (pausar/archivar ⇒ false).
        ({error} = await db.from('subscription_plans').update({is_active:active}).eq('id',p.id));
      }
      if (error) throw error;
      // Espejar en la vidriera pública (marketing_plans vinculados por subscription_plan_id).
      let webWarn = false;
      const {error:mErr} = await db.from('marketing_plans')
        .update({is_active:active, updated_at:new Date().toISOString()})
        .eq('subscription_plan_id',p.id);
      if (mErr) webWarn = true;
      setFlash(webWarn
        ? {type:'warn',text:`Plan "${p.name}" ${verb}, pero no se pudo actualizar el sitio público de precios.`}
        : {type:'ok',text:`Plan "${p.name}" ${verb}.`});
      reload();
    } catch(e){ setFlash({type:'error',text:'Error: '+e.message}); }
    setPlanBusy(null);
  };
  const pausePlan     = p => setPlanStatus(p,'inactive','pausado');
  const activatePlan  = p => setPlanStatus(p,'active','activado');
  const archivePlan   = p => setPlanStatus(p,'archived','archivado');
  // Desarchivar devuelve el plan a la lista principal como PAUSADO (no se
  // republica solo): el superadmin decide luego "Activar" para volver a ofrecerlo.
  const unarchivePlan = p => setPlanStatus(p,'inactive','desarchivado (queda pausado)');

  // ── Eliminar plan (definitivo, solo si ninguna suscripción lo usa) ─────
  const askDeletePlan = async (p) => {
    if (!db) { setFlash({type:'warn',text:'Sin conexión — operación demo'}); return; }
    setPlanBusy(p.id);
    try {
      const {count,error} = await db.from('subscriptions').select('id',{count:'exact',head:true}).eq('plan_id',p.id);
      if (error) throw error;
      setDeletePlan({plan:p, count:count||0});
    } catch(e){ setFlash({type:'error',text:'Error verificando uso del plan: '+e.message}); }
    setPlanBusy(null);
  };
  const confirmDeletePlan = async () => {
    const p = deletePlan?.plan;
    if (!p || (deletePlan.count||0) > 0) return;   // guard: nunca borrar un plan en uso
    setPlanBusy(p.id);
    try {
      const {error} = await db.from('subscription_plans').delete().eq('id',p.id);
      if (error) throw error;
      setFlash({type:'ok',text:`Plan "${p.name}" eliminado definitivamente.`});
      setDeletePlan(null); reload();
    } catch(e){ setFlash({type:'error',text:'Error al eliminar: '+e.message}); }
    setPlanBusy(null);
  };

  const spf = v => e => setPlanForm(f=>({...f,[v]:e.target.value}));
  const togglePanel = key => setPlanForm(f=>({...f,panels:(f.panels||[]).includes(key)?f.panels.filter(p=>p!==key):[...(f.panels||[]),key]}));
  const toggleFeature = key => setPlanForm(f=>({...f,allowed_features:(f.allowed_features||[]).includes(key)?f.allowed_features.filter(k=>k!==key):[...(f.allowed_features||[]),key]}));

  // Partición por estado para la vista (activos+pausados en la grilla principal,
  // archivados en su propia sección plegable).
  const livePlans     = plans.filter(p=>PLAN_ST(p)!=='archived');
  const archivedPlans = plans.filter(p=>PLAN_ST(p)==='archived');

  const renderPlanCard = (p) => {
    const st = PLAN_ST(p);
    const featArr = Array.isArray(p.features)?p.features:(typeof p.features==='string'?JSON.parse(p.features||'[]'):[]);
    const busy = planBusy===p.id;
    return (
      <div key={p.id} style={{background:C.card,border:`1px solid ${st==='active'?C.border:C.orange}`,borderRadius:12,padding:20,opacity:st==='active'?1:.72,position:'relative'}}>
        {p.is_recommended && st==='active' && (
          <div style={{position:'absolute',top:12,right:12,background:C.ink,color:C.surface,padding:'2px 8px',borderRadius:4,fontSize:10,fontWeight:700,letterSpacing:.5}}>RECOMENDADO</div>
        )}
        {st!=='active' && (
          <div style={{position:'absolute',top:12,right:12,background:st==='archived'?C.dim:C.orange,color:C.surface,padding:'2px 8px',borderRadius:4,fontSize:10,fontWeight:800,letterSpacing:.5,textTransform:'uppercase'}}>{st==='archived'?'Archivado':'Pausado'}</div>
        )}
        <PlanBadge name={p.name}/>
        <div style={{fontSize:22,fontWeight:800,margin:'10px 0 4px',color:C.ink}}>{fmtGuarani(p.price_usd)}<span style={{fontSize:13,fontWeight:400,color:C.mid}}>/mes</span></div>
        <div style={{display:'flex',gap:8,marginBottom:14}}>
          <div style={{background:C.bg,borderRadius:6,padding:'6px 10px',textAlign:'center',flex:1}}>
            <div style={{fontSize:15,fontWeight:700,color:C.ink}}>{p.max_tables??'∞'}</div>
            <div style={{fontSize:10,color:C.mid}}>Mesas</div>
          </div>
          <div style={{background:C.bg,borderRadius:6,padding:'6px 10px',textAlign:'center',flex:1}}>
            <div style={{fontSize:15,fontWeight:700,color:C.ink}}>{p.max_menu_items??'∞'}</div>
            <div style={{fontSize:10,color:C.mid}}>Items menú</div>
          </div>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:4,marginBottom:10}}>
          {featArr.map((f,i)=>(
            <div key={i} style={{fontSize:12,color:C.mid,display:'flex',gap:6}}>
              <span style={{fontSize:10}}>–</span>{f}
            </div>
          ))}
        </div>
        {(() => {
          const pnls = asArr(p.allowed_panels);
          const feats = asArr(p.allowed_features);
          const mubr = asObj(p.max_users_by_role);
          const limStr = LIMIT_ROLES.map(lr=>mubr[lr.key]!=null?`${mubr[lr.key]} ${lr.word||lr.key}`:null).filter(Boolean).join(' · ');
          const featLabel = k=>{ for(const g of FEATURE_GROUPS){ const it=g.items.find(i=>i.key===k); if(it) return it.label; } return k; };
          return (
            <div style={{marginBottom:14}}>
              {pnls.length>0&&(
                <div style={{display:'flex',flexWrap:'wrap',gap:4,marginBottom:6}}>
                  {pnls.map(pk=><span key={pk} style={{fontSize:10,fontWeight:600,background:C.bg,color:C.mid,padding:'2px 7px',borderRadius:5}}>{(PANEL_OPTIONS.find(o=>o.key===pk)?.label)||pk}</span>)}
                </div>
              )}
              {feats.length>0&&(
                <div style={{display:'flex',flexWrap:'wrap',gap:4,marginBottom:6}}>
                  {feats.map(fk=><span key={fk} style={{fontSize:9,fontWeight:700,background:C.ink,color:C.sidebar,padding:'2px 7px',borderRadius:5,letterSpacing:.2}}>{featLabel(fk)}</span>)}
                </div>
              )}
              <div style={{fontSize:10,color:C.dim}}>{limStr?`Límites: ${limStr}`:'Usuarios ilimitados'}</div>
            </div>
          );
        })()}
        <div style={{display:'flex',flexWrap:'wrap',gap:6,borderTop:`1px solid ${C.border}`,paddingTop:12}}>
          <Btn size="sm" variant="ghost" onClick={()=>openEditPlan(p)} disabled={busy}>Editar</Btn>
          {st==='archived' ? (
            <Btn size="sm" variant="ghost" onClick={()=>unarchivePlan(p)} disabled={busy}>{busy?'…':'Desarchivar'}</Btn>
          ) : (
            <>
              {st==='active'
                ? <Btn size="sm" variant="ghost" onClick={()=>pausePlan(p)} disabled={busy}>{busy?'…':'Pausar'}</Btn>
                : <Btn size="sm" variant="success" onClick={()=>activatePlan(p)} disabled={busy}>{busy?'…':'Activar'}</Btn>}
              <Btn size="sm" variant="ghost" onClick={()=>archivePlan(p)} disabled={busy}>Archivar</Btn>
            </>
          )}
          <Btn size="sm" variant="danger" onClick={()=>askDeletePlan(p)} disabled={busy}>Eliminar</Btn>
        </div>
      </div>
    );
  };

  // Nombre del local por id, para la cola de validación de pagos.
  const restNameById = {};
  enriched.forEach(r => { restNameById[r.id] = r.name; });

  return (
    <div className="animate-in">
      {/* Cobro autoservicio (mig 194): primero lo que requiere acción tuya. */}
      <PagosPorValidar restNameById={restNameById} setFlash={setFlash} reload={reload}/>

      {/* Planes cards */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
        <span style={{fontSize:13,color:C.mid}}>Planes disponibles</span>
        <Btn size="sm" onClick={()=>{setPlanForm(EMPTY_PLAN);setPlanModal('create')}}>+ Nuevo plan</Btn>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))',gap:16,marginBottom:28}}>
        {livePlans.map(renderPlanCard)}
      </div>

      {/* Planes archivados (retirados) — sección plegable, recuperables */}
      {archivedPlans.length>0 && (
        <div style={{marginBottom:28}}>
          <div
            onClick={()=>setShowArchived(v=>!v)}
            style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',userSelect:'none',padding:'8px 0',color:C.mid}}
          >
            <span style={{fontSize:12,transform:showArchived?'rotate(90deg)':'none',transition:'transform .15s',display:'inline-block'}}>▸</span>
            <span style={{fontSize:13,fontWeight:600}}>Archivados</span>
            <span style={{fontSize:11,fontWeight:700,background:C.bg,color:C.dim,padding:'1px 8px',borderRadius:10}}>{archivedPlans.length}</span>
          </div>
          {showArchived && (
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))',gap:16,marginTop:12}}>
              {archivedPlans.map(renderPlanCard)}
            </div>
          )}
        </div>
      )}

      {/* Add-ons disponibles (catálogo de cargos extra) */}
      <SectionCard title="Add-ons disponibles (cargos extra)">
        <div style={{padding:'4px 4px 8px'}}>
          <div style={{fontSize:11,color:C.dim,padding:'4px 16px 12px'}}>Paneles que se venden como módulo independiente (modelo "hamburguesa"). Se añaden al plan base de cada restaurante desde su suscripción.</div>
          {catalog.map(a=>{
            const f = addonForm[a.key]||{};
            return (
              <div key={a.key} style={{display:'flex',alignItems:'center',gap:14,padding:'10px 16px',borderTop:`1px solid ${C.border}`,flexWrap:'wrap'}}>
                <div style={{flex:'1 1 200px'}}>
                  <div style={{fontSize:13,fontWeight:600,color:C.ink}}>{a.name}</div>
                  <div style={{fontSize:11,color:C.mid}}>Panel: {a.panel}</div>
                </div>
                <div style={{display:'flex',alignItems:'center',gap:6}}>
                  <span style={{fontSize:12,color:C.mid}}>₲/mes</span>
                  <MoneyCcyInput value={f.price_usd??''} onChange={v=>setAddonForm(s=>({...s,[a.key]:{...s[a.key],price_usd:v}}))} style={{width:110}}/>
                </div>
                <label style={{display:'flex',alignItems:'center',gap:6,fontSize:12,color:C.mid,cursor:'pointer'}}>
                  <input type="checkbox" checked={f.is_active!==false} onChange={e=>setAddonForm(s=>({...s,[a.key]:{...s[a.key],is_active:e.target.checked}}))} style={{width:15,height:15}}/>
                  Activo
                </label>
                <Btn size="sm" variant="ghost" onClick={()=>saveAddon(a)} disabled={savingAddon===a.key}>{savingAddon===a.key?'…':'Guardar'}</Btn>
              </div>
            );
          })}
        </div>
      </SectionCard>

      {/* Datos de cobro de la plataforma (mig 194) — alimenta el checkout del dueño */}
      <DatosDeCobro setFlash={setFlash}/>

      {/* El libro completo: todo pago que entró, no solo lo que espera acción */}
      <HistorialPagos restNameById={restNameById}/>

      {/* MRR total */}
      <div style={{display:'flex',gap:12,margin:'20px 0',flexWrap:'wrap'}}>
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:'14px 20px',flex:'none'}}>
          <div style={{fontSize:11,color:C.mid,marginBottom:4}}>MRR Total</div>
          <div style={{fontSize:28,fontWeight:800,color:C.ink}}>{fmtGuarani(mrrTotal)}<span style={{fontSize:12,fontWeight:400,color:C.mid}}>/mes</span></div>
        </div>
      </div>

      {/* Modal plan */}
      {planModal&&(
        <Modal title={planModal==='create'?'Nuevo plan':'Editar plan'} onClose={()=>setPlanModal(null)}>
          <div className="my-row-2" style={{gap:'0 16px'}}>
            <FormField label="Nombre *"><input value={planForm.name} onChange={spf('name')} placeholder="Pro"/></FormField>
            <FormField label="Precio/mes (₲) *"><MoneyCcyInput value={planForm.price_usd} onChange={v=>setPlanForm(f=>({...f,price_usd:v}))} placeholder="400000"/></FormField>
            <FormField label="Ciclo">
              <select value={planForm.billing_cycle} onChange={spf('billing_cycle')}>
                <option value="monthly">Mensual</option>
                <option value="annual">Anual</option>
                <option value="free">Gratuito</option>
              </select>
            </FormField>
            <FormField label="Estado">
              {(() => {
                const st = planModal==='create' ? 'active' : PLAN_ST(planModal.edit);
                const meta = {active:{t:'Activo · se ofrece',c:C.green},inactive:{t:'Pausado · no se ofrece',c:C.orange},archived:{t:'Archivado · retirado',c:C.dim}}[st];
                return (
                  <div style={{display:'flex',flexDirection:'column',gap:3,marginTop:6}}>
                    <span style={{display:'inline-flex',alignItems:'center',gap:7,fontSize:13,fontWeight:600,color:meta.c}}>
                      <span style={{width:8,height:8,borderRadius:'50%',background:meta.c}}/>{meta.t}
                    </span>
                    <span style={{fontSize:10,color:C.dim}}>Se cambia con Pausar / Archivar en la tarjeta del plan.</span>
                  </div>
                );
              })()}
            </FormField>
            <FormField label="Máx. mesas"><input type="number" value={planForm.max_tables} onChange={spf('max_tables')} placeholder="15"/></FormField>
            <FormField label="Máx. ítems menú"><input type="number" value={planForm.max_menu_items} onChange={spf('max_menu_items')} placeholder="100"/></FormField>
          </div>

          {/* Hard-limits por rol */}
          <div style={{borderTop:`1px solid ${C.border}`,margin:'8px 0 0',paddingTop:14}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:4,textTransform:'uppercase',letterSpacing:.5}}>Límite estricto de usuarios por rol</div>
            <div style={{fontSize:11,color:C.dim,marginBottom:10}}>Vacío = ilimitado. El admin no podrá crear más usuarios de ese rol que el tope.</div>
            <div className="my-row-3" style={{gap:'0 16px'}}>
              {LIMIT_ROLES.map(lr=>(
                <FormField key={lr.key} label={lr.label}>
                  <input type="number" min="0" value={planForm['max_'+lr.key]} onChange={spf('max_'+lr.key)} placeholder="∞"/>
                </FormField>
              ))}
            </div>
          </div>

          {/* Paneles incluidos en el plan */}
          <div style={{borderTop:`1px solid ${C.border}`,margin:'4px 0 0',paddingTop:14}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:4,textTransform:'uppercase',letterSpacing:.5}}>Paneles incluidos en el plan</div>
            <div style={{fontSize:11,color:C.dim,marginBottom:10}}>Lo no incluido solo se habilita comprando el add-on correspondiente.</div>
            <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
              {PANEL_OPTIONS.map(p=>{
                const on = (planForm.panels||[]).includes(p.key);
                return (
                  <div key={p.key} onClick={()=>togglePanel(p.key)} style={{display:'flex',alignItems:'center',gap:6,padding:'6px 12px',borderRadius:20,cursor:'pointer',userSelect:'none',fontSize:12,fontWeight:600,border:`1px solid ${on?C.ink:C.border}`,background:on?C.ink:'transparent',color:on?C.sidebar:C.mid}}>
                    <span style={{fontSize:11}}>{on?'✓':'+'}</span>{p.label}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Características y módulos granulares (Omni-Gating por feature) */}
          <div style={{borderTop:`1px solid ${C.border}`,margin:'4px 0 0',paddingTop:14}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:4,textTransform:'uppercase',letterSpacing:.5}}>Características y módulos granulares</div>
            <div style={{fontSize:11,color:C.dim,marginBottom:12}}>Sub-módulos vendibles dentro de cada panel. Lo no marcado se bloquea con paywall y se ofrece como upgrade al comercio.</div>
            <div style={{display:'flex',flexDirection:'column',gap:14}}>
              {FEATURE_GROUPS.map(g=>(
                <div key={g.group}>
                  <div style={{fontSize:11,fontWeight:700,color:C.mid,marginBottom:7,display:'flex',alignItems:'center',gap:6}}>
                    <Icon name={g.icon} size={13}/>{g.group}
                  </div>
                  <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
                    {g.items.map(it=>{
                      const on = (planForm.allowed_features||[]).includes(it.key);
                      return (
                        <div key={it.key} onClick={()=>toggleFeature(it.key)} title={it.desc} style={{display:'flex',alignItems:'center',gap:6,padding:'6px 12px',borderRadius:20,cursor:'pointer',userSelect:'none',fontSize:12,fontWeight:600,border:`1px solid ${on?C.ink:C.border}`,background:on?C.ink:'transparent',color:on?C.sidebar:C.mid}}>
                          <span style={{fontSize:11}}>{on?'✓':'+'}</span>{it.label}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <FormField label="Características" hint="Separadas por coma">
            <textarea value={planForm.features} onChange={spf('features')} rows={3} placeholder="Pedidos QR, KDS cocina, Analytics completo"/>
          </FormField>
          <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:12}}>
            <Btn variant="ghost" onClick={()=>setPlanModal(null)}>Cancelar</Btn>
            <Btn onClick={savePlan} disabled={saving}>{saving?'Guardando…':'Guardar'}</Btn>
          </div>
        </Modal>
      )}

      {/* Modal eliminar plan (definitivo) — bloqueado si hay suscripciones en uso */}
      {deletePlan&&(
        <Modal title="Eliminar plan" onClose={()=>setDeletePlan(null)} width={460}>
          {deletePlan.count>0 ? (
            <>
              <div style={{display:'flex',gap:12,padding:'12px 14px',borderRadius:10,border:`1px solid ${C.orange}`,background:C.bg,marginBottom:16}}>
                <div style={{color:C.orange,flexShrink:0,marginTop:1}}><Icon name="alert" size={20}/></div>
                <div style={{fontSize:13,color:C.mid,lineHeight:1.55}}>
                  <strong style={{color:C.ink}}>{deletePlan.count}</strong> {deletePlan.count===1?'restaurante usa':'restaurantes usan'} el plan <strong style={{color:C.ink}}>“{deletePlan.plan.name}”</strong>. No se puede eliminar mientras esté en uso — <strong>archivalo o pausalo</strong> en lugar de eliminarlo (los restaurantes que ya lo tienen siguen funcionando igual).
                </div>
              </div>
              <div style={{display:'flex',gap:10,justifyContent:'flex-end',flexWrap:'wrap'}}>
                <Btn variant="ghost" onClick={()=>setDeletePlan(null)}>Cancelar</Btn>
                <Btn variant="ghost" onClick={()=>{const p=deletePlan.plan; setDeletePlan(null); pausePlan(p);}}>Pausar</Btn>
                <Btn onClick={()=>{const p=deletePlan.plan; setDeletePlan(null); archivePlan(p);}}>Archivar</Btn>
              </div>
            </>
          ) : (
            <>
              <div style={{fontSize:13,color:C.mid,lineHeight:1.55,marginBottom:16}}>
                Vas a eliminar <strong style={{color:C.ink}}>“{deletePlan.plan.name}”</strong> de forma <strong>definitiva</strong>. Ninguna suscripción usa este plan, así que es seguro. Esta acción no se puede deshacer.
              </div>
              <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
                <Btn variant="ghost" onClick={()=>setDeletePlan(null)}>Cancelar</Btn>
                <Btn variant="danger" onClick={confirmDeletePlan} disabled={planBusy===deletePlan.plan.id}>{planBusy===deletePlan.plan.id?'Eliminando…':'Eliminar definitivamente'}</Btn>
              </div>
            </>
          )}
        </Modal>
      )}

    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// MÓDULO 4 — USUARIOS
// ══════════════════════════════════════════════════════════════
function PageUsuarios({restaurants, setFlash}) {
  const [users,    setUsers]    = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [search,   setSearch]   = useState('');
  const [editModal,setEditModal]= useState(null);
  const [editForm, setEditForm] = useState({role:'admin',restaurant_id:'',display_name:''});
  const [saving,   setSaving]   = useState(false);
  const [newModal, setNewModal] = useState(false);
  const [newForm,  setNewForm]  = useState({username:'',password:'',pin:'',display_name:'',role:'admin',restaurant_id:'',email:''});
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState({}); // grupos de restaurante desplegados (acordeón)

  // El email `${usuario}@mythos.internal` es el handle interno de login, no el correo
  // real → no se muestra. Se muestra recovery_email (correo real) si existe, o "—".
  function displayEmail(u) {
    const e = (u && u.email) || '';
    if (/@mythos\.internal$/i.test(e)) return (u && u.recovery_email) || '—';
    return e || (u && u.recovery_email) || '—';
  }

  const createUser = async () => {
    if (!db) { setFlash({type:'warn',text:'Sin conexión'}); return; }
    const { username, password, pin, display_name, role, restaurant_id, email } = newForm;

    // Riders: se crean como el resto del personal (cuenta auth con usuario+contraseña).
    // /api/create-user, además de la cuenta, crea su ficha en delivery_riders vinculada por
    // user_id; el panel rider la resuelve con auth.uid() (login por correo+contraseña, sin PIN).
    if (!username.trim()) { setFlash({type:'warn',text:'Ingresá un nombre de usuario'}); return; }
    if (!display_name.trim()) { setFlash({type:'warn',text:'Ingresá el nombre de la persona (para saber quién es)'}); return; }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setFlash({type:'warn',text:'El correo no es válido.'}); return; }
    if (typeof password !== 'string' || !password.trim() || password.length < 8) { setFlash({type:'warn',text:'Ingresá una contraseña de al menos 8 caracteres para crear el usuario.'}); return; }
    // Roles operativos (todo menos superadmin) requieren restaurante: sin él, el login los rechaza.
    if (role !== 'superadmin' && !restaurant_id) { setFlash({type:'warn',text:`Asigná un restaurante al ${roleLabel(role)}`}); return; }
    setCreating(true);
    try {
      const { data: { session } } = await db.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Sin sesión activa');
      const resp = await fetch('/api/create-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ username: username.trim(), password, display_name: display_name.trim(), recovery_email: email.trim()||undefined, role, restaurant_id: restaurant_id || null })
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || 'Error desconocido');
      setFlash({type:'ok',text:`Usuario "${result.username}" creado con éxito`});
      setNewModal(false);
      setNewForm({username:'',password:'',pin:'',display_name:'',role:'admin',restaurant_id:'',email:''});
      loadUsers();
    } catch(e) { setFlash({type:'error',text:e.message}); }
    setCreating(false);
  };

  const loadUsers = useCallback(async () => {
    if (!db) { setLoading(false); return; }
    setLoading(true);
    // Riders viven en delivery_riders (perfil operativo, vinculado a la cuenta por user_id); se fusionan a la grilla.
    const ridersP = db.from('delivery_riders').select('id,restaurant_id,name,phone,rider_pin,active,created_at,user_id');
    let base = [];
    const { data, error } = await db.rpc('admin_list_users');
    if (!error && data) {
      base = data;
    } else if (error) {
      // Fallback: query directa a user_roles (funciona si las policies lo permiten)
      const { data: d2, error: e2 } = await db.from('user_roles')
        .select('id,user_id,email,recovery_email,username,display_name,role,restaurant_id,is_active,created_at')
        .order('created_at', { ascending: false });
      if (!e2 && d2) base = d2;
    }
    const { data: ridersData } = await ridersP;
    const riderRows = (ridersData||[]).map(r=>({
      id:'rider_'+r.id, _riderId:r.id, _isRider:true, user_id:r.user_id||null,
      username:r.rider_pin?('PIN '+r.rider_pin):'—', email:r.phone||'',
      display_name:r.name||'—', role:'rider', restaurant_id:r.restaurant_id,
      is_active:r.active!==false, created_at:r.created_at, last_sign_in_at:null
    }));
    // Evitar duplicar riders que también figuren en user_roles con rol rider.
    const baseNoRider = (base||[]).filter(u=>(u.role||'').toLowerCase()!=='rider'&&(u.role||'').toLowerCase()!=='repartidor');
    setUsers([...baseNoRider, ...riderRows]);
    setLoading(false);
  }, []);

  useEffect(()=>{
    loadUsers();
    if (!db) return;
    const interval = setInterval(()=>{ if(!_shouldPause()) loadUsers(); }, 30000);
    const ch = db.channel('usuarios-rt')
      .on('postgres_changes',{event:'*',schema:'public',table:'user_roles'},()=>{ if(!_shouldPause()) loadUsers(); })
      .on('postgres_changes',{event:'*',schema:'public',table:'delivery_riders'},()=>{ if(!_shouldPause()) loadUsers(); })
      .subscribe();
    return ()=>{ clearInterval(interval); db.removeChannel(ch); };
  },[loadUsers]);

  const restName = id => restaurants.find(r=>r.id===id)?.name||'—';

  const shown = users.filter(u=>{
    if (!search) return true;
    const q = search.toLowerCase();
    return (u.username||'').toLowerCase().includes(q) ||
           (u.display_name||'').toLowerCase().includes(q) ||
           (u.email||'').toLowerCase().includes(q) ||
           restName(u.restaurant_id).toLowerCase().includes(q);
  });

  // Agrupar por restaurante
  const byRest = {};
  shown.forEach(u=>{
    const key = u.restaurant_id||'__global';
    if (!byRest[key]) byRest[key] = [];
    byRest[key].push(u);
  });

  const openEdit = u => {
    setEditForm({role:u.role,restaurant_id:u.restaurant_id||'',display_name:u.display_name||''});
    setEditModal(u);
  };

  const saveEdit = async () => {
    if (!db) { setFlash({type:'warn',text:'Sin conexión'}); return; }
    setSaving(true);
    try {
      if (editModal._isRider) {
        // Rider: actualiza delivery_riders (nombre + restaurante). El rol es fijo.
        const upd = {name:editForm.display_name||editModal.display_name};
        if (editForm.restaurant_id) upd.restaurant_id = editForm.restaurant_id;
        const { error } = await db.from('delivery_riders').update(upd).eq('id',editModal._riderId);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await db.rpc('admin_update_user_role',{p_user_id:editModal.user_id,p_role:editForm.role,p_restaurant_id:editForm.restaurant_id||null,p_display_name:editForm.display_name||null});
        if (error) throw new Error(error.message);
      }
      setFlash({type:'ok',text:`${editModal.display_name||editModal.username} actualizado`});
      setEditModal(null); loadUsers();
    } catch(e) { setFlash({type:'error',text:e.message}); }
    setSaving(false);
  };

  const toggleUser = async u => {
    if (!db) return;
    if (u._isRider) {
      const { error } = await db.from('delivery_riders').update({active:!u.is_active}).eq('id',u._riderId);
      if (error) { setFlash({type:'error',text:error.message}); return; }
    } else {
      const { error } = await db.rpc('admin_toggle_user',{p_user_id:u.user_id,p_active:!u.is_active});
      if (error) { setFlash({type:'error',text:error.message}); return; }
    }
    setFlash({type:'ok',text:`${u.display_name||u.username} → ${!u.is_active?'activo':'desactivado'}`});
    loadUsers();
  };

  return (
    <div className="animate-in">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20,gap:12,flexWrap:'wrap'}}>
        <div>
          <div style={{fontSize:16,fontWeight:700}}>Usuarios del sistema</div>
          <div style={{fontSize:12,color:C.mid,marginTop:3}}>{loading?'Cargando…':`${users.length} usuario${users.length!==1?'s':''}`}</div>
        </div>
        <div style={{display:'flex',gap:10,alignItems:'center'}}>
          <input placeholder="Buscar usuario, email, restaurante..." value={search} onChange={e=>setSearch(e.target.value)} style={{width:260}}/>
          <Btn onClick={()=>{ setNewForm({username:'',password:'',pin:'',display_name:'',role:'admin',restaurant_id:'',email:''}); setNewModal(true); }} disabled={!db}>+ Nuevo usuario</Btn>
        </div>
      </div>

      {!db&&(
        <div style={{background:TINT.warnBg,border:`1px solid ${TINT.warnBorder}`,borderRadius:8,padding:'12px 18px',marginBottom:20,color:TINT.warnText,fontSize:13}}>
          Sin conexión a Supabase — gestión de usuarios no disponible en modo demo
        </div>
      )}

      {loading ? (
        <div style={{display:'flex',justifyContent:'center',alignItems:'center',height:160,gap:12}}><Spinner/><span style={{color:C.mid}}>Cargando usuarios…</span></div>
      ) : shown.length===0 ? (
        <div style={{padding:60,textAlign:'center',color:C.dim,fontSize:13}}>{users.length===0?'Sin usuarios registrados':'Sin resultados para la búsqueda'}</div>
      ) : (
        Object.entries(byRest).map(([restId, restUsers]) => {
          const groupCount = Object.keys(byRest).length;
          // Desplegado si: búsqueda activa, hay un solo grupo, o el usuario lo abrió.
          const isOpen = !!search || groupCount===1 || expanded[restId]===true;
          const activos = restUsers.filter(u=>u.is_active).length;
          return (
          <div key={restId} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:'hidden',marginBottom:12}}>
            <div onClick={()=>setExpanded(e=>({...e,[restId]:!isOpen}))} style={{padding:'12px 18px',display:'flex',justifyContent:'space-between',alignItems:'center',cursor:'pointer',borderBottom:isOpen?`1px solid ${C.border}`:'none',userSelect:'none'}}>
              <span style={{display:'flex',alignItems:'center',gap:10}}>
                <span style={{display:'inline-block',transition:'transform .15s',transform:isOpen?'rotate(90deg)':'none',color:C.mid,fontSize:12}}>▶</span>
                <span style={{fontWeight:600,fontSize:13,color:C.ink}}>{restId==='__global'?'Acceso global (superadmin)':restName(restId)}</span>
                <span style={{fontSize:11,color:C.dim,fontWeight:600}}>{restUsers.length} usuario{restUsers.length!==1?'s':''} · {activos} activo{activos!==1?'s':''}</span>
              </span>
            </div>
            {isOpen&&(
            <div className="tbl-wrap">
              <table style={{width:'100%',borderCollapse:'collapse',minWidth:620}}>
                <thead><tr>
                  <Th>Usuario</Th><Th>Nombre</Th><Th>Rol</Th><Th>Estado</Th><Th>Último acceso</Th><Th style={{textAlign:'right'}}>Acciones</Th>
                </tr></thead>
                <tbody>
                  {restUsers.map(u=>(
                    <tr key={u.id} onMouseEnter={e=>e.currentTarget.style.background=C.bg} onMouseLeave={e=>e.currentTarget.style.background=''} style={{transition:'background .1s'}}>
                      <Td>
                        <div style={{fontFamily:'monospace',fontSize:13,fontWeight:600}}>{u.username||'—'}</div>
                        <div style={{fontSize:11,color:C.dim,marginTop:2}}>{displayEmail(u)}</div>
                      </Td>
                      <Td style={{fontWeight:500}}>{u.display_name||'—'}</Td>
                      <Td>
                        <span style={{padding:'2px 8px',borderRadius:12,fontSize:11,fontWeight:700,background:C.bg,color:C.mid}}>{roleLabel(u.role)}</span>
                      </Td>
                      <Td>
                        <span style={{display:'inline-flex',alignItems:'center',gap:5,fontSize:12,fontWeight:600,color:u.is_active?C.ink:C.dim}}>
                          <span style={{width:6,height:6,borderRadius:'50%',background:u.is_active?C.green:C.dim}}/>
                          {u.is_active?'Activo':'Inactivo'}
                        </span>
                      </Td>
                      <Td style={{fontSize:12,color:C.mid}}>{fmtRelTime(u.last_sign_in_at)}</Td>
                      <Td style={{textAlign:'right'}}>
                        <div style={{display:'flex',gap:4,justifyContent:'flex-end'}}>
                          <Btn size="sm" variant="ghost" onClick={()=>openEdit(u)}>Editar</Btn>
                          <Btn size="sm" variant={u.is_active?'danger':'success'} onClick={()=>toggleUser(u)}>
                            {u.is_active?'Desactivar':'Activar'}
                          </Btn>
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}
          </div>
          );
        })
      )}

      {newModal&&(
        <Modal title="Nuevo usuario" onClose={()=>setNewModal(false)}>
          <div className="my-row-2" style={{gap:'0 16px'}}>
            <FormField label="Usuario *">
              <input
                value={newForm.username}
                onChange={e=>setNewForm(f=>({...f,username:e.target.value}))}
                placeholder={newForm.role==='rider'?'ej: juanrider':'ej: mariaperez'}
                autoFocus
              />
            </FormField>
            <FormField label={newForm.role==='rider'?'Nombre del rider *':'Nombre para mostrar *'}>
              <input
                value={newForm.display_name}
                onChange={e=>setNewForm(f=>({...f,display_name:e.target.value}))}
                placeholder={newForm.role==='rider'?'ej: Juan Repartidor':'ej: María Pérez'}
              />
            </FormField>
          </div>
          <FormField label="Contraseña * (mínimo 8 caracteres)">
            <input
              type="password"
              autoComplete="new-password"
              value={newForm.password}
              onChange={e=>setNewForm(f=>({...f,password:e.target.value}))}
              placeholder="Contraseña segura"
            />
            <div style={{fontSize:11,color:C.mid,marginTop:4}}>El usuario deberá cambiar esta contraseña en su primer ingreso.</div>
          </FormField>
          <FormField label="Correo electrónico — opcional">
            <input
              type="email"
              value={newForm.email}
              onChange={e=>setNewForm(f=>({...f,email:e.target.value}))}
              placeholder="ej: persona@correo.com"
            />
            <div style={{fontSize:11,color:C.mid,marginTop:4}}>Si lo cargás, el usuario lo confirma en su primer ingreso y queda como su correo de contacto. Si no, dejalo vacío — no se crea ningún correo.</div>
          </FormField>
          <div className="my-row-2" style={{gap:'0 16px'}}>
            <FormField label="Rol">
              <select value={newForm.role} onChange={e=>setNewForm(f=>({...f,role:e.target.value}))}>
                {NEW_USER_ROLES.map(r=><option key={r} value={r}>{roleLabel(r)}</option>)}
              </select>
            </FormField>
            <FormField label={newForm.role==='rider'?'Restaurante asignado *':'Restaurante asignado'}>
              <select value={newForm.restaurant_id} onChange={e=>setNewForm(f=>({...f,restaurant_id:e.target.value}))}>
                <option value="">{newForm.role==='rider'?'Seleccioná un restaurante…':'Sin restaurante (global)'}</option>
                {restaurants.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </FormField>
          </div>
          <div style={{padding:'10px 14px',background:C.bg,borderRadius:8,fontSize:12,color:C.mid,marginTop:4}}>
            {newForm.role==='rider'
              ? 'El rider inicia sesión con su usuario y contraseña en el panel Delivery. Su ficha (vehículo, comisión) se crea automáticamente y se edita en el módulo Delivery del restaurante.'
              : 'El usuario iniciará sesión con su nombre de usuario y contraseña. Si no cargás correo, no se crea ninguno.'}
          </div>
          <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:12}}>
            <Btn variant="ghost" onClick={()=>setNewModal(false)} disabled={creating}>Cancelar</Btn>
            <Btn onClick={createUser} disabled={creating}>{creating?'Creando…':'Crear usuario'}</Btn>
          </div>
        </Modal>
      )}

      {editModal&&(
        <Modal title={`Editar — ${editModal.display_name||editModal.username}`} onClose={()=>setEditModal(null)}>
          <FormField label="Nombre para mostrar">
            <input value={editForm.display_name} onChange={e=>setEditForm(f=>({...f,display_name:e.target.value}))}/>
          </FormField>
          <div className="my-row-2" style={{gap:'0 16px'}}>
            <FormField label="Rol">
              {editModal._isRider
                ? <input value="rider" disabled style={{opacity:.6}}/>
                : <select value={editForm.role} onChange={e=>setEditForm(f=>({...f,role:e.target.value}))}>
                    {ALL_ROLES.map(r=><option key={r} value={r}>{roleLabel(r)}</option>)}
                  </select>}
            </FormField>
            <FormField label="Restaurante asignado">
              <select value={editForm.restaurant_id} onChange={e=>setEditForm(f=>({...f,restaurant_id:e.target.value}))}>
                <option value="">{editModal._isRider?'Seleccioná un restaurante…':'Todos los restaurantes'}</option>
                {restaurants.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </FormField>
          </div>
          {editModal._isRider&&(
            <div style={{padding:'8px 14px',background:C.bg,borderRadius:8,fontSize:12,color:C.mid,marginTop:8}}>
              El rider inicia sesión en el panel Delivery con su usuario y contraseña. Su perfil (vehículo, comisión) se edita en el módulo Delivery del restaurante.
            </div>
          )}
          <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:8}}>
            <Btn variant="ghost" onClick={()=>setEditModal(null)}>Cancelar</Btn>
            <Btn onClick={saveEdit} disabled={saving}>{saving?'Guardando…':'Guardar cambios'}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// MÓDULO 5 — CONFIGURACIÓN GLOBAL
// ══════════════════════════════════════════════════════════════
function PageConfiguracion({restaurants, platformConfig, setFlash, reload}) {
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState('general');   // general (banner) | cuenta (perfil + clave)

  const bannerRow   = platformConfig.find(c=>c.key==='global_banner_active');
  const bannerMsgRow= platformConfig.find(c=>c.key==='global_banner_message');
  const [bannerActive, setBannerActive] = useState(bannerRow?.value==='true');
  const [bannerMsg,    setBannerMsg]    = useState(bannerMsgRow?.value||'');

  // NOTA: el "Modo mantenimiento" por restaurante se movió al DETALLE de cada
  // restaurante (Restaurantes → Editar). Acá solo queda el banner global del panel.

  const saveBanner = async () => {
    if (!db) { setFlash({type:'warn',text:'Sin conexión — operación demo'}); return; }
    setSaving(true);
    const now = new Date().toISOString();
    await db.from('platform_config').upsert([
      {key:'global_banner_active', value:String(bannerActive), updated_at:now},
      {key:'global_banner_message',value:bannerMsg,            updated_at:now},
    ],{onConflict:'key'});
    setFlash({type:'ok',text:'Banner actualizado'}); reload();
    setSaving(false);
  };

  return (
    <div className="animate-in">
      {/* Sub-pestañas: configuración general del panel + mi cuenta */}
      <div style={{display:'flex',gap:8,marginBottom:16}}>
        <FilterBtn active={tab==='general'} onClick={()=>setTab('general')}>General</FilterBtn>
        <FilterBtn active={tab==='cuenta'}  onClick={()=>setTab('cuenta')}>Mi cuenta</FilterBtn>
      </div>

      {tab==='general' && (
        <SectionCard title="Banner Global">
          <div style={{padding:'20px 24px'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
              <div>
                <div style={{fontWeight:600,fontSize:14,color:C.ink,marginBottom:4}}>Activar banner de aviso</div>
                <div style={{fontSize:12,color:C.mid}}>Aparece como barra fija en la parte superior del panel Superadmin</div>
              </div>
              <Toggle checked={bannerActive} onChange={setBannerActive}/>
            </div>
            <FormField label="Mensaje del banner">
              <input
                value={bannerMsg}
                onChange={e=>setBannerMsg(e.target.value)}
                placeholder="Ej: Sistema en mantenimiento programado el sábado 25 de mayo"
                disabled={!bannerActive}
              />
            </FormField>
            {bannerActive&&bannerMsg&&(
              <div style={{margin:'12px 0',background:'#FF9500',borderRadius:8,padding:'10px 16px',color:'#fff',fontSize:13,fontWeight:500}}>
                Vista previa: {bannerMsg}
              </div>
            )}
            <div style={{marginTop:16}}>
              <Btn onClick={saveBanner} disabled={saving}>{saving?'Guardando…':'Guardar configuración'}</Btn>
            </div>
          </div>
        </SectionCard>
      )}

      {tab==='general' && <RetencionDatos setFlash={setFlash}/>}

      {tab==='cuenta' && <PageMiCuenta setFlash={setFlash}/>}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   Retención de datos operativos (mig 212)
   ──────────────────────────────────────────────────────────────
   El histórico de pedidos no se borraba nunca. Acá se fija cuánto se guarda
   (60 días = los 2 meses acordados) y se prende la purga nocturna.

   POR QUÉ HAY UN BOTÓN DE ENSAYO Y NO SÓLO UN INTERRUPTOR: esto borra datos de
   restaurantes reales y no hay deshacer. El ensayo (`data_retention_report`)
   corre exactamente el mismo camino que el borrado pero sin escribir, así que
   dice fila por fila y tabla por tabla qué se va a ir. La regla de la casa es
   backup nuevo + dry-run revisado ANTES de tocar; el dry-run es este botón.
   ══════════════════════════════════════════════════════════════ */
function RetencionDatos({setFlash}) {
  const [cfg, setCfg]         = useState(null);   // null = cargando / sin migración
  const [targets, setTargets] = useState([]);
  const [dias, setDias]       = useState('60');
  const [busy, setBusy]       = useState(false);
  const [ensayo, setEnsayo]   = useState(null);   // resultado del último dry-run

  const cargar = async () => {
    if (!db) return;
    const c = await db.from('data_retention_config').select('*').limit(1).maybeSingle();
    if (c.error || !c.data) { setCfg(false); return; }   // false = migración pendiente
    setCfg(c.data);
    setDias(String(c.data.retention_days ?? 60));
    const t = await db.from('data_retention_targets').select('*').order('sort_order');
    if (!t.error) setTargets(t.data || []);
  };
  useEffect(()=>{ cargar(); }, []);

  // La migración 212 puede no estar aplicada: la sección simplemente no se dibuja
  // (mismo criterio deploy-safe que el resto del panel).
  if (cfg === false || cfg === null) return null;

  const guardar = async (patch) => {
    setBusy(true);
    const { error } = await db.from('data_retention_config')
      .update({ ...patch, updated_at:new Date().toISOString() }).eq('id', true);
    setBusy(false);
    if (error) { setFlash({type:'error',text:'No se pudo guardar la retención'}); return false; }
    setFlash({type:'success',text:'Retención actualizada'});
    await cargar();
    return true;
  };

  const guardarDias = () => {
    const n = parseInt(dias, 10);
    if (!Number.isFinite(n) || n < 30 || n > 3650) {
      setFlash({type:'error',text:'Entre 30 y 3650 días. El piso de 30 evita borrar el mes en curso por un dedazo.'});
      return;
    }
    guardar({ retention_days:n });
  };

  const correrEnsayo = async () => {
    setBusy(true);
    const { data, error } = await db.rpc('data_retention_report');
    setBusy(false);
    if (error) { setFlash({type:'error',text:'No se pudo correr el ensayo: '+error.message}); return; }
    setEnsayo(data);
    setFlash({type:'success',text:'Ensayo listo — no se borró nada'});
  };

  const togglePurga = async (val) => {
    if (val && !ensayo) {
      setFlash({type:'error',text:'Corré el ensayo primero: prender esto empieza a borrar datos de locales reales y no hay deshacer.'});
      return;
    }
    if (val && !window.confirm(
      `Vas a activar el borrado automático de datos operativos con más de ${cfg.retention_days} días.\n\n` +
      `Esto NO se puede deshacer. Confirmá que tenés un backup reciente de la base.\n\n` +
      `¿Activar?`)) return;
    await guardar({ enabled: !!val });
  };

  const toggleTarget = async (t, val) => {
    setBusy(true);
    const { error } = await db.from('data_retention_targets').update({ enabled: !!val }).eq('table_name', t.table_name);
    setBusy(false);
    if (error) { setFlash({type:'error',text:'No se pudo cambiar la tabla'}); return; }
    setEnsayo(null);   // el alcance cambió: el ensayo viejo ya no describe lo que va a pasar
    cargar();
  };

  const det = (ensayo && Array.isArray(ensayo.detalle)) ? ensayo.detalle : null;

  return (
    <div style={{marginTop:16}}>
      <SectionCard title="Retención de datos operativos">
        <div style={{padding:'18px 20px'}}>
          <div style={{fontSize:12.5,color:C.mid,lineHeight:1.6,marginBottom:16}}>
            Los pedidos no se borraban nunca. Acá se define cuánto tiempo guarda Mythos el histórico
            <strong> operativo</strong> de cada local. El aviso correspondiente ya se muestra en
            Admin › Configuración de cada restaurante, con el enlace a sus exportaciones a PDF/Excel.
            {' '}El libro de caja, los egresos y el stock <strong>no</strong> se purgan salvo que se
            prendan abajo uno por uno — son respaldo contable.
          </div>

          <FormField label="Días que se conservan" hint="60 = 2 meses. Mínimo 30.">
            <div style={{display:'flex',gap:8}}>
              <input type="number" min="30" max="3650" value={dias} onChange={e=>setDias(e.target.value)} style={{flex:1}}/>
              <Btn variant="ghost" onClick={guardarDias} disabled={busy}>Guardar</Btn>
            </div>
          </FormField>

          {/* Ensayo antes del interruptor: el orden en pantalla es el orden correcto de operación. */}
          <div style={{marginTop:14,padding:'14px 16px',border:`1px solid ${C.border}`,borderRadius:10,background:C.bg}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap'}}>
              <div>
                <div style={{fontWeight:700,fontSize:13,color:C.ink}}>Ensayo (no borra nada)</div>
                <div style={{fontSize:12,color:C.mid,marginTop:3}}>Cuenta exactamente qué filas se irían con la configuración de arriba.</div>
              </div>
              <Btn variant="ghost" onClick={correrEnsayo} disabled={busy}>{busy?'Corriendo…':'Correr ensayo'}</Btn>
            </div>
            {det && (
              <div style={{marginTop:12,overflowX:'auto'}}>
                <table style={{width:'100%',borderCollapse:'collapse',fontSize:12.5}}>
                  <thead><tr>
                    <th style={{textAlign:'left',padding:'6px 8px',color:C.mid,fontWeight:700}}>Tabla</th>
                    <th style={{textAlign:'right',padding:'6px 8px',color:C.mid,fontWeight:700}}>Filas a borrar</th>
                  </tr></thead>
                  <tbody>
                    {det.map(d=>(
                      <tr key={d.tabla} style={{borderTop:`1px solid ${C.border}`}}>
                        <td style={{padding:'6px 8px',color:C.ink}}>{d.etiqueta||d.tabla}</td>
                        <td style={{padding:'6px 8px',textAlign:'right',fontWeight:700,color:d.elegibles>0?C.orange:C.dim}}>{fmtNum(d.elegibles||0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{fontSize:11.5,color:C.dim,marginTop:8}}>Corte: más viejo que {cfg.retention_days} días. Cada corrida borra como máximo {fmtNum(cfg.max_rows_per_table)} filas por tabla.</div>
              </div>
            )}
          </div>

          {/* Interruptor */}
          <div style={{marginTop:14,padding:'14px 16px',border:`1px solid ${cfg.enabled?TINT.warnBorder:C.border}`,borderRadius:10,background:cfg.enabled?TINT.warnBg:'transparent'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12}}>
              <div>
                <div style={{fontWeight:700,fontSize:13,color:C.ink}}>Borrado automático cada noche</div>
                <div style={{fontSize:12,color:C.mid,marginTop:3,lineHeight:1.5}}>
                  {cfg.enabled
                    ? 'ACTIVO. El cron nocturno purga lo vencido. Esto no se puede deshacer.'
                    : 'Apagado. El cron corre igual pero sólo reporta lo que haría.'}
                </div>
              </div>
              <Toggle checked={!!cfg.enabled} onChange={togglePurga}/>
            </div>
            {cfg.last_run_at && (
              <div style={{fontSize:11.5,color:C.dim,marginTop:10}}>
                Última corrida real: {fmtDate(cfg.last_run_at)}
                {cfg.last_result && cfg.last_result.borradas!=null ? ` · ${fmtNum(cfg.last_result.borradas)} filas` : ''}
              </div>
            )}
          </div>

          {/* Aviso al local */}
          <div style={{marginTop:14,display:'flex',justifyContent:'space-between',alignItems:'center',gap:12}}>
            <div>
              <div style={{fontWeight:700,fontSize:13,color:C.ink}}>Mostrar el aviso en el panel de cada local</div>
              <div style={{fontSize:12,color:C.mid,marginTop:3}}>Admin › Configuración. Avisar es lo que hace legítimo el borrado — apagarlo no cambia lo que se borra.</div>
            </div>
            <Toggle checked={cfg.notice_enabled!==false} onChange={v=>guardar({notice_enabled:!!v})}/>
          </div>

          {/* Alcance */}
          <div style={{marginTop:18}}>
            <div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:.6,textTransform:'uppercase',marginBottom:8}}>Qué se purga</div>
            <div style={{display:'flex',flexDirection:'column',gap:2}}>
              {targets.map(t=>(
                <div key={t.table_name} style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,padding:'10px 0',borderTop:`1px solid ${C.border}`}}>
                  <div style={{minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:700,color:C.ink}}>{t.label}</div>
                    <div style={{fontSize:11.5,color:C.dim,marginTop:2,lineHeight:1.5}}>{t.reason}</div>
                  </div>
                  <Toggle checked={!!t.enabled} onChange={v=>toggleTarget(t, v)}/>
                </div>
              ))}
            </div>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// MÓDULO 6 — REPORTES GLOBALES
// ══════════════════════════════════════════════════════════════
function PageReportes({enriched, orders, ratings, subscriptions, plans, events}) {
  const [rType,   setRType]   = useState('');
  const [fromStr, setFromStr] = useState('');
  const [toStr,   setToStr]   = useState('');
  const [rows,    setRows]    = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [repTitle,setRepTitle]= useState('');

  useEffect(()=>{
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const pad = n => String(n).padStart(2,'0');
    setFromStr(`${pad(first.getDate())}/${pad(first.getMonth()+1)}/${first.getFullYear()}`);
    setToStr(`${pad(now.getDate())}/${pad(now.getMonth()+1)}/${now.getFullYear()}`);
  },[]);

  function parseDMY(str) {
    if(!str) return null;
    const p = str.split('/');
    if(p.length!==3) return null;
    const d = new Date(parseInt(p[2]), parseInt(p[1])-1, parseInt(p[0]));
    return isNaN(d.getTime()) ? null : d;
  }
  function dmyToISO(str) {
    if(!str) return '';
    const p = str.split('/');
    if(p.length!==3) return '';
    return `${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
  }

  const REPORT_DEFS = [
    {id:'ventas_periodo',    label:'Ventas por período',         cat:'ventas',    desc:'Ingresos, pedidos y ticket promedio de toda la plataforma'},
    {id:'ranking_rest',      label:'Ranking de restaurantes',    cat:'ventas',    desc:'Restaurantes ordenados por ventas en el período'},
    {id:'suscripciones',     label:'Estado de suscripciones',    cat:'subs',      desc:'Restaurantes, planes activos, vencimientos y MRR'},
    {id:'mrr_plan',          label:'MRR por plan',               cat:'subs',      desc:'Revenue mensual recurrente desglosado por plan'},
    {id:'restaurantes_estado',label:'Restaurantes por estado',   cat:'plataforma',desc:'Distribución activo / trial / suspendido / inactivo'},
    {id:'calificaciones',    label:'Calificaciones por restaurante', cat:'clientes', desc:'Rating promedio y cantidad de reseñas por restaurante'},
    {id:'actividad',         label:'Actividad de plataforma',    cat:'plataforma',desc:'Eventos registrados (altas, renovaciones, cambios de plan)'},
    {id:'proveedores_comunes',label:'Proveedores gastronómicos comunes', cat:'inteligencia', desc:'Distribuidoras / insumos más cargados por los restaurantes (datos de muestra)'},
    {id:'zonas_calientes',   label:'Zonas calientes de delivery',cat:'inteligencia',desc:'Focos de consumo por zona en territorio paraguayo (datos de muestra)'},
  ];

  const CATS = [
    {id:'ventas',       label:'Ventas y facturación', color:'#007AFF'},
    {id:'subs',         label:'Suscripciones',        color:'#34C759'},
    {id:'clientes',     label:'Calificaciones',       color:'#FFD60A'},
    {id:'plataforma',   label:'Plataforma',            color:'#AF52DE'},
    {id:'inteligencia', label:'Inteligencia de mercado', color:'#FF375F'},
  ];

  async function generate() {
    const from = parseDMY(fromStr);
    const to   = parseDMY(toStr);
    if(!rType){ alert('Seleccioná un tipo de reporte'); return; }
    if(!from||!to){ alert('Fechas inválidas — usá formato dd/mm/aaaa'); return; }
    to.setHours(23,59,59,999);
    setLoading(true); setRows(null); setSummary(null);
    const def = REPORT_DEFS.find(r=>r.id===rType);
    setRepTitle(def?.label||'Reporte');
    try { await _run(rType, from, to); }
    catch(e){ alert('Error: '+e.message); }
    setLoading(false);
  }

  async function _run(type, from, to) {
    const fromISO = isoLocal(from);
    const toISO   = isoLocal(to);

    if(type==='ventas_periodo') {
      let data = orders.filter(o=>['delivered','paid','ready','cooking','kitchen_received'].includes(o.status));
      if(db) {
        const {data:d} = await db.from('orders').select('id,restaurant_id,total,created_at,status').gte('created_at',from.toISOString()).lte('created_at',to.toISOString()).not('status','in','(draft,cancelled)');
        if(d&&d.length>0) data = d;
      }
      data = data.filter(o=>new Date(o.created_at)>=from&&new Date(o.created_at)<=to);
      const total = data.reduce((s,o)=>s+(Number(o.total)||0),0);
      const count = data.length;
      const avgT  = count>0?Math.round(total/count):0;
      const restMap = {};
      data.forEach(o=>{ const k=o.restaurant_id; restMap[k]=(restMap[k]||0)+(Number(o.total)||0); });
      setSummary([
        {label:'Ventas totales',  value:fmtGuarani(total), color:'#34C759'},
        {label:'Pedidos',         value:count,             color:'#007AFF'},
        {label:'Ticket promedio', value:fmtGuarani(avgT),  color:'#FF9500'},
        {label:'Restaurantes',    value:Object.keys(restMap).length, color:'#AF52DE'},
      ]);
      const byRest = Object.entries(restMap).map(([rid,rev])=>{
        const r = enriched.find(x=>x.id===rid);
        return {name:r?.name||rid, rev, cnt:data.filter(o=>o.restaurant_id===rid).length};
      }).sort((a,b)=>b.rev-a.rev);
      setRows({
        cols:['Restaurante','Pedidos','Ingresos','% del total'],
        data:byRest.map(r=>[r.name, r.cnt, fmtGuarani(r.rev), total>0?`${Math.round(r.rev/total*100)}%`:'—']),
      });
    }

    else if(type==='proveedores_comunes') {
      // Inteligencia agregada — datos de muestra (la anon key no permite agregación cross-tenant aún)
      const bar = (v,max)=>'█'.repeat(Math.max(1,Math.round(v/max*12)));
      const provs = [
        {name:'Distribuidora Avícola del Sur', cat:'Carnes y aves',   count:38, rest:12},
        {name:'Lácteos Paraguay S.A.',          cat:'Lácteos',         count:31, rest:11},
        {name:'Frutihortícola Mcal. López',     cat:'Verdulería',      count:29, rest:10},
        {name:'Bebidas Itaipú Distrib.',        cat:'Bebidas',         count:27, rest:13},
        {name:'Panificadora Central',           cat:'Panadería',       count:22, rest:8},
        {name:'Pescados del Paraná',            cat:'Pescados',        count:14, rest:5},
      ].sort((a,b)=>b.count-a.count);
      const max = provs[0].count;
      setSummary([
        {label:'Proveedores únicos', value:provs.length,                      color:'#FF375F'},
        {label:'Más usado',          value:provs[0].name,                     color:'#007AFF'},
        {label:'Cargas totales',     value:provs.reduce((s,p)=>s+p.count,0),  color:'#34C759'},
        {label:'Origen',             value:'Datos de muestra',                color:C.mid},
      ]);
      setRows({
        cols:['#','Proveedor','Categoría','Veces cargado','Restaurantes','Distribución'],
        data:provs.map((p,i)=>[i+1, p.name, p.cat, p.count, p.rest, bar(p.count,max)]),
      });
    }

    else if(type==='zonas_calientes') {
      // Mapa de calor consolidado — datos de muestra
      const bar = (v,max)=>'█'.repeat(Math.max(1,Math.round(v/max*12)));
      const zonas = [
        {zona:'Villa Morra',          city:'Asunción',          orders:142},
        {zona:'Centro / Microcentro', city:'Asunción',          orders:118},
        {zona:'Carmelitas',           city:'Asunción',          orders:97},
        {zona:'Zona Shopping del Sol',city:'Asunción',          orders:88},
        {zona:'Centro CDE',           city:'Ciudad del Este',   orders:64},
        {zona:'Centro',               city:'Encarnación',       orders:51},
        {zona:'Zona Mcal. Estigarribia',city:'San Lorenzo',     orders:43},
      ].sort((a,b)=>b.orders-a.orders);
      const max = zonas[0].orders;
      const tot = zonas.reduce((s,z)=>s+z.orders,0);
      setSummary([
        {label:'Zonas activas', value:zonas.length,        color:'#FF375F'},
        {label:'Zona top',      value:zonas[0].zona,       color:'#FF9500'},
        {label:'Pedidos totales',value:tot,                color:'#34C759'},
        {label:'Origen',        value:'Datos de muestra',  color:C.mid},
      ]);
      setRows({
        cols:['#','Zona','Ciudad','Pedidos','% del total','Intensidad'],
        data:zonas.map((z,i)=>[i+1, z.zona, z.city, z.orders, `${Math.round(z.orders/tot*100)}%`, bar(z.orders,max)]),
      });
    }

    else if(type==='ranking_rest') {
      let data = orders.filter(o=>['delivered','paid','ready','cooking','kitchen_received'].includes(o.status));
      if(db) {
        const {data:d} = await db.from('orders').select('id,restaurant_id,total,created_at,status').gte('created_at',from.toISOString()).lte('created_at',to.toISOString()).not('status','in','(draft,cancelled)');
        if(d&&d.length>0) data = d;
      }
      data = data.filter(o=>new Date(o.created_at)>=from&&new Date(o.created_at)<=to);
      const ranked = enriched.map(r=>{
        const rOrds = data.filter(o=>o.restaurant_id===r.id);
        const rev   = rOrds.reduce((s,o)=>s+(Number(o.total)||0),0);
        return {name:r.name, city:r.city||'—', cnt:rOrds.length, rev, avg:rOrds.length>0?Math.round(rev/rOrds.length):0, status:r.status};
      }).sort((a,b)=>b.rev-a.rev);
      const totRev = ranked.reduce((s,r)=>s+r.rev,0);
      setSummary([
        {label:'Ventas totales', value:fmtGuarani(totRev),             color:'#34C759'},
        {label:'Pedidos totales',value:ranked.reduce((s,r)=>s+r.cnt,0),color:'#007AFF'},
        {label:'Restaurantes',   value:ranked.length,                   color:'#AF52DE'},
      ]);
      setRows({
        cols:['#','Restaurante','Ciudad','Estado','Pedidos','Ventas','Ticket prom.','% ventas'],
        data:ranked.map((r,i)=>[i+1, r.name, r.city, statusMeta[r.status]?.label||r.status, r.cnt, fmtGuarani(r.rev), fmtGuarani(r.avg), totRev>0?`${Math.round(r.rev/totRev*100)}%`:'—']),
      });
    }

    else if(type==='suscripciones') {
      const data = subscriptions.map(s=>{
        const r   = enriched.find(x=>x.id===s.restaurant_id);
        const pl  = s.plan || plans.find(p=>p.id===s.plan_id);
        const days = daysUntil(s.end_date);
        return {rest:r?.name||'—', plan:pl?.name||'—', status:s.status||'—', start:s.start_date||'—', end:s.end_date||'—', mrr:Number(s.monthly_amount||0), days, renew:s.auto_renew?'Sí':'No'};
      });
      const activos  = data.filter(s=>s.status==='active').length;
      const trials   = data.filter(s=>s.status==='trial').length;
      const mrr      = data.filter(s=>s.status==='active').reduce((s,x)=>s+x.mrr,0);
      setSummary([
        {label:'Activas',  value:activos,          color:'#34C759'},
        {label:'Trial',    value:trials,            color:'#007AFF'},
        {label:'MRR (USD)',value:`$${mrr.toFixed(0)}`,color:'#FF9500'},
        {label:'Total',    value:data.length,       color:'#AF52DE'},
      ]);
      setRows({
        cols:['Restaurante','Plan','Estado','Inicio','Vencimiento','Días rest.','Auto-renov.','MRR (USD)'],
        data:data.map(s=>[s.rest, s.plan, statusMeta[s.status]?.label||s.status,
          s.start!=='—'?s.start.slice(0,10).split('-').reverse().join('/'):'—',
          s.end  !=='—'?s.end.slice(0,10).split('-').reverse().join('/'):'—',
          s.days!==null?(s.days>=0?`${s.days}d`:'Vencido'):'—', s.renew, `$${s.mrr.toFixed(0)}`]),
      });
    }

    else if(type==='mrr_plan') {
      const planMap = {};
      subscriptions.filter(s=>s.status==='active').forEach(s=>{
        const pl   = s.plan || plans.find(p=>p.id===s.plan_id);
        const name = pl?.name||'Sin plan';
        const mrr  = Number(s.monthly_amount||0);
        if(!planMap[name]) planMap[name]={plan:name,cnt:0,mrr:0};
        planMap[name].cnt++;
        planMap[name].mrr+=mrr;
      });
      const rows2  = Object.values(planMap).sort((a,b)=>b.mrr-a.mrr);
      const totMRR = rows2.reduce((s,p)=>s+p.mrr,0);
      setSummary([
        {label:'MRR total (USD)', value:`$${totMRR.toFixed(0)}`,  color:'#34C759'},
        {label:'Suscripciones',   value:rows2.reduce((s,p)=>s+p.cnt,0), color:'#007AFF'},
        {label:'Planes activos',  value:rows2.length,             color:'#AF52DE'},
      ]);
      setRows({
        cols:['Plan','Suscripciones','MRR (USD)','% del MRR'],
        data:rows2.map(p=>[p.plan, p.cnt, `$${p.mrr.toFixed(0)}`, totMRR>0?`${Math.round(p.mrr/totMRR*100)}%`:'—']),
      });
    }

    else if(type==='restaurantes_estado') {
      const statuses = ['active','trial','suspended','inactive'];
      const counts   = Object.fromEntries(statuses.map(s=>[s,0]));
      enriched.forEach(r=>{ if(counts[r.status]!==undefined) counts[r.status]++; else counts['inactive']=(counts['inactive']||0)+1; });
      const total = enriched.length;
      setSummary([
        {label:'Total restaurantes', value:total,              color:'#AF52DE'},
        {label:'Activos',            value:counts.active,      color:'#34C759'},
        {label:'Trial',              value:counts.trial,       color:'#007AFF'},
        {label:'Suspendidos',        value:counts.suspended,   color:'#FF3B30'},
      ]);
      const detail = enriched.map(r=>({
        name:r.name, city:r.city||'—', status:r.status||'—',
        plan:r.plan?.name||'—', onboarding:r.onboarding_date||'—', mrr:Number(r.subscription?.monthly_amount||0),
      })).sort((a,b)=>a.name.localeCompare(b.name));
      setRows({
        cols:['Restaurante','Ciudad','Estado','Plan','Alta','MRR (USD)'],
        data:detail.map(r=>[r.name, r.city, statusMeta[r.status]?.label||r.status, r.plan,
          r.onboarding!=='—'?r.onboarding.slice(0,10).split('-').reverse().join('/'):'—',
          r.mrr>0?`$${r.mrr.toFixed(0)}`:'—']),
      });
    }

    else if(type==='calificaciones') {
      let data = ratings;
      if(db) {
        const {data:d} = await db.from('ratings').select('restaurant_id,stars,created_at').gte('created_at',from.toISOString()).lte('created_at',to.toISOString());
        if(d&&d.length>0) data = d;
      }
      data = data.filter(r=>new Date(r.created_at)>=from&&new Date(r.created_at)<=to);
      const restMap = {};
      data.forEach(r=>{ const k=r.restaurant_id; if(!restMap[k])restMap[k]={id:k,total:0,count:0,pos:0}; restMap[k].total+=(r.stars||0); restMap[k].count++; if((r.stars||0)>=4)restMap[k].pos++; });
      const rows2 = Object.entries(restMap).map(([id,v])=>{
        const rest = enriched.find(r=>r.id===id);
        return {name:rest?.name||id, avg:(v.total/v.count).toFixed(1), count:v.count, pos:v.pos, pct:Math.round(v.pos/v.count*100)};
      }).sort((a,b)=>b.avg-a.avg);
      const globalAvg = data.length>0?(data.reduce((s,r)=>s+(r.stars||0),0)/data.length).toFixed(1):'—';
      setSummary([
        {label:'Calificaciones',  value:data.length,       color:'#007AFF'},
        {label:'Promedio global', value:`${globalAvg} ★`,  color:'#FFD60A'},
        {label:'Positivas (≥4★)', value:data.filter(r=>(r.stars||0)>=4).length, color:'#34C759'},
      ]);
      setRows({
        cols:['Restaurante','Promedio','Reseñas','Positivas','% positivas'],
        data:rows2.map(r=>[r.name, `${r.avg} ★`, r.count, r.pos, `${r.pct}%`]),
      });
    }

    else if(type==='actividad') {
      let data = events.filter(e=>new Date(e.created_at)>=from&&new Date(e.created_at)<=to);
      if(db&&data.length===0) {
        const {data:d} = await db.from('platform_events').select('*,restaurant:restaurants(name)').gte('created_at',from.toISOString()).lte('created_at',to.toISOString()).order('created_at',{ascending:false}).limit(300);
        if(d) data = d;
      }
      const typeCounts = {};
      data.forEach(e=>{ const k=eventMeta[e.event_type]?.label||e.event_type||'—'; typeCounts[k]=(typeCounts[k]||0)+1; });
      setSummary([
        {label:'Eventos',    value:data.length,              color:'#007AFF'},
        {label:'Tipos',      value:Object.keys(typeCounts).length, color:'#AF52DE'},
        {label:'Restaurantes',value:new Set(data.map(e=>e.restaurant_id).filter(Boolean)).size, color:'#FF9500'},
      ]);
      setRows({
        cols:['Fecha','Restaurante','Tipo','Descripción'],
        data:data.map(e=>[
          e.created_at?new Date(e.created_at).toLocaleDateString('es-PY',{day:'2-digit',month:'short',year:'numeric'}):'—',
          e.restaurant?.name||e.restaurant_id||'Plataforma',
          eventMeta[e.event_type]?.label||e.event_type||'—',
          e.description||'—',
        ]),
      });
    }
  }

  function exportCSV() {
    if(!rows) return;
    const lines=[rows.cols.join(','),...rows.data.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','))];
    const blob=new Blob(['﻿'+lines.join('\n')],{type:'text/csv;charset=utf-8;'});
    const url=URL.createObjectURL(blob); const a=document.createElement('a');
    a.href=url; a.download=`mythos_reporte_${rType}_${dmyToISO(fromStr)}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  function exportXLS() {
    if(!rows||!window.XLSX){ alert('SheetJS no disponible'); return; }
    const ws=window.XLSX.utils.aoa_to_sheet([rows.cols,...rows.data]);
    const wb=window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb,ws,(REPORT_DEFS.find(r=>r.id===rType)?.label||'Reporte').slice(0,31));
    window.XLSX.writeFile(wb,`mythos_reporte_${rType}_${dmyToISO(fromStr)}.xlsx`);
  }

  function exportPDF() {
    if(!rows) return;
    const def=REPORT_DEFS.find(r=>r.id===rType);
    const w=window.open('','_blank');
    const sumHtml=summary?summary.map(s=>`<div style="display:inline-block;margin:0 24px 12px 0"><div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.5px">${esc(s.label)}</div><div style="font-size:20px;font-weight:800;color:${esc(s.color)}">${esc(s.value)}</div></div>`).join(''):'';
    const tHead=`<tr>${rows.cols.map(c=>`<th style="background:#1D1D1F;color:#fff;padding:8px 12px;text-align:left;font-size:11px;white-space:nowrap">${esc(c)}</th>`).join('')}</tr>`;
    const tBody=rows.data.map((r,i)=>`<tr style="background:${i%2===0?'#fff':'#f9f9f9'}">${r.map(v=>`<td style="padding:7px 12px;font-size:11px;border-bottom:1px solid #eee">${esc(v)}</td>`).join('')}</tr>`).join('');
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${def?.label||'Reporte'}</title><style>body{font-family:system-ui,sans-serif;margin:32px;color:#222}@media print{button{display:none!important}}</style></head><body>
      <div style="font-size:22px;font-weight:800;color:#1D1D1F;margin-bottom:4px">Mythos — Superadmin</div>
      <div style="font-size:16px;font-weight:700;color:#000;margin-bottom:4px">${def?.label||'Reporte'}</div>
      <div style="font-size:11px;color:#888;margin-bottom:18px">Generado: ${new Date().toLocaleDateString('es-PY')} · Período: ${fromStr} al ${toStr}</div>
      <div style="margin-bottom:20px;padding:14px 0;border-top:2px solid #1D1D1F;border-bottom:1px solid #eee">${sumHtml}</div>
      <table style="width:100%;border-collapse:collapse;margin-top:4px"><thead>${tHead}</thead><tbody>${tBody}</tbody></table>
      <div style="margin-top:24px;font-size:9px;color:#bbb;text-align:right">Página 1 de 1 · Mythos Platform</div>
      <script>window.onload=function(){window.print();}<\/script>
    </body></html>`);
    w.document.close();
  }

  function limpiar() { setRType(''); setRows(null); setSummary(null); setRepTitle(''); }

  const selDef = REPORT_DEFS.find(r=>r.id===rType);

  return (
    <div className="animate-in">
      {/* Panel de configuración */}
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:20,marginBottom:20}}>
        <div style={{fontSize:15,fontWeight:700,marginBottom:16}}>Reportes personalizados</div>

        {/* Tipo de reporte */}
        <div style={{marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:600,color:C.mid,marginBottom:5,letterSpacing:.5,textTransform:'uppercase'}}>Tipo de reporte</div>
          <select value={rType} onChange={e=>{setRType(e.target.value);setRows(null);setSummary(null);}} style={{width:'100%',maxWidth:440,padding:'9px 12px',borderRadius:8,fontSize:13,border:`1px solid ${C.border}`,background:C.surface,color:C.ink}}>
            <option value="">— Seleccioná un tipo —</option>
            {CATS.map(cat=>(
              <optgroup key={cat.id} label={cat.label}>
                {REPORT_DEFS.filter(r=>r.cat===cat.id).map(r=><option key={r.id} value={r.id}>{r.label}</option>)}
              </optgroup>
            ))}
          </select>
          {selDef&&<div style={{fontSize:11,color:C.dim,marginTop:4}}>{selDef.desc}</div>}
        </div>

        {/* Fechas */}
        <div style={{display:'flex',gap:14,alignItems:'flex-end',flexWrap:'wrap',marginBottom:16}}>
          <div>
            <div style={{fontSize:11,fontWeight:600,color:C.mid,marginBottom:5,letterSpacing:.5,textTransform:'uppercase'}}>Fecha desde</div>
            <input type="text" value={fromStr} onChange={e=>setFromStr(e.target.value)} placeholder="dd/mm/aaaa" style={{padding:'8px 12px',borderRadius:8,fontSize:13,border:`1px solid ${C.border}`,width:145}}/>
          </div>
          <div>
            <div style={{fontSize:11,fontWeight:600,color:C.mid,marginBottom:5,letterSpacing:.5,textTransform:'uppercase'}}>Fecha hasta</div>
            <input type="text" value={toStr} onChange={e=>setToStr(e.target.value)} placeholder="dd/mm/aaaa" style={{padding:'8px 12px',borderRadius:8,fontSize:13,border:`1px solid ${C.border}`,width:145}}/>
          </div>
        </div>

        {/* Botones */}
        <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
          <button onClick={generate} disabled={loading} style={{display:'inline-flex',alignItems:'center',gap:6,padding:'9px 18px',background:'#1D1D1F',color:'#fff',border:'none',borderRadius:8,fontSize:13,fontWeight:700,cursor:'pointer',opacity:loading?.7:1}}>
            {loading&&<span className="spin" style={{borderTopColor:'#fff',borderColor:'rgba(255,255,255,.3)'}}/>}{loading?'Generando…':(<><Icon name="fileText" size={13}/> Generar reporte</>)}
          </button>
          {rows&&<>
            <button onClick={exportPDF} style={{display:'inline-flex',alignItems:'center',gap:6,padding:'9px 16px',background:'#FF3B30',color:'#fff',border:'none',borderRadius:8,fontSize:13,fontWeight:700,cursor:'pointer'}}><Icon name="download" size={13}/> PDF</button>
            <button onClick={exportXLS} style={{display:'inline-flex',alignItems:'center',gap:6,padding:'9px 16px',background:'#34C759',color:'#fff',border:'none',borderRadius:8,fontSize:13,fontWeight:700,cursor:'pointer'}}><Icon name="download" size={13}/> Excel</button>
            <button onClick={exportCSV} style={{display:'inline-flex',alignItems:'center',gap:6,padding:'9px 16px',background:'#6E6E73',color:'#fff',border:'none',borderRadius:8,fontSize:13,fontWeight:700,cursor:'pointer'}}><Icon name="download" size={13}/> CSV</button>
            <button onClick={limpiar} style={{display:'inline-flex',alignItems:'center',gap:6,padding:'9px 14px',background:'transparent',color:C.mid,border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,cursor:'pointer'}}><Icon name="x" size={13}/> Limpiar</button>
          </>}
        </div>

        {/* KPIs */}
        {summary&&(
          <div style={{marginTop:20,display:'flex',gap:12,flexWrap:'wrap'}}>
            {summary.map((s,i)=>(
              <div key={i} style={{flex:'1 1 160px',background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'14px 18px',borderLeft:`3px solid ${s.color}`}}>
                <div style={{fontSize:11,color:C.mid,marginBottom:4,textTransform:'uppercase',letterSpacing:.5,fontWeight:600}}>{s.label}</div>
                <div style={{fontSize:22,fontWeight:800,color:s.color}}>{s.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Tabla */}
        {rows&&(
          <div style={{marginTop:16,overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
              <thead>
                <tr>{rows.cols.map((c,i)=><th key={i} style={{background:'#1D1D1F',color:'#fff',padding:'8px 12px',textAlign:'left',fontWeight:700,fontSize:11,whiteSpace:'nowrap'}}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {rows.data.map((r,ri)=>(
                  <tr key={ri} style={{background:ri%2===0?C.surface:'var(--bg-subtle)',borderBottom:`1px solid ${C.border}`}}>
                    {r.map((v,vi)=><td key={vi} style={{padding:'8px 12px',color:C.ink}}>{v}</td>)}
                  </tr>
                ))}
                {rows.data.length===0&&<tr><td colSpan={rows.cols.length} style={{textAlign:'center',padding:28,color:C.dim,fontSize:13}}>Sin datos en el período seleccionado</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Catálogo de reportes */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))',gap:16}}>
        {CATS.map(cat=>{
          const catReps = REPORT_DEFS.filter(r=>r.cat===cat.id);
          return (
            <div key={cat.id} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:18}}>
              <div style={{fontSize:13,fontWeight:700,marginBottom:10,color:cat.color,textTransform:'uppercase',letterSpacing:.5}}>{cat.label}</div>
              {catReps.map(r=>(
                <button key={r.id} onClick={()=>{setRType(r.id);setRows(null);setSummary(null);window.scrollTo({top:0,behavior:'smooth'});}} style={{display:'block',width:'100%',textAlign:'left',padding:'8px 10px',marginBottom:4,background:'transparent',border:`1px solid transparent`,borderRadius:7,cursor:'pointer'}}>
                  <div style={{fontSize:13,fontWeight:600,color:C.ink}}>{r.label}</div>
                  <div style={{fontSize:11,color:C.dim,marginTop:1}}>{r.desc}</div>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ACTIVIDAD
// ══════════════════════════════════════════════════════════════
function PageActividad({events, restaurants, setFlash, reload}) {
  const [filterR,    setFilterR]    = useState('all');
  const [filterType, setFilterType] = useState('all');
  const [addModal,   setAddModal]   = useState(false);
  const [form,       setForm]       = useState({restaurant_id:'',event_type:'note_added',description:''});
  const [saving,     setSaving]     = useState(false);

  let shown = filterR==='all' ? events : events.filter(e=>e.restaurant_id===filterR);
  if (filterType!=='all') shown = shown.filter(e=>e.event_type===filterType);

  const addEvent = async () => {
    if (!form.description.trim()) { setFlash({type:'error',text:'La descripción es requerida'}); return; }
    if (!db) { setFlash({type:'warn',text:'Sin conexión — operación demo'}); return; }
    setSaving(true);
    try {
      const {error} = await db.from('platform_events').insert({restaurant_id:form.restaurant_id||null,event_type:form.event_type,description:form.description});
      if (error) throw error;
      setFlash({type:'ok',text:'Evento registrado'}); setAddModal(false);
      setForm({restaurant_id:'',event_type:'note_added',description:''}); reload();
    } catch(e) { setFlash({type:'error',text:'Error: '+e.message}); }
    setSaving(false);
  };

  const eventTypes = Object.entries(eventMeta).map(([k,v])=>({value:k,label:v.label}));

  return (
    <div className="animate-in">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18,flexWrap:'wrap',gap:10}}>
        <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
          <select value={filterR} onChange={e=>setFilterR(e.target.value)} style={{width:'auto',minWidth:180,fontSize:13}}>
            <option value="all">Todos los restaurantes</option>
            {restaurants.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <select value={filterType} onChange={e=>setFilterType(e.target.value)} style={{width:'auto',minWidth:160,fontSize:13}}>
            <option value="all">Todos los tipos</option>
            {eventTypes.map(t=><option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <span style={{fontSize:12,color:C.dim}}>{shown.length} evento{shown.length!==1?'s':''}</span>
        </div>
        <Btn onClick={()=>{setForm({restaurant_id:'',event_type:'note_added',description:''});setAddModal(true)}}>+ Registrar evento</Btn>
      </div>

      <SectionCard>
        {shown.length===0&&<div style={{padding:48,textAlign:'center',color:C.dim,fontSize:13}}>Sin eventos registrados con los filtros actuales</div>}
        {shown.map(ev=>{
          const m = eventMeta[ev.event_type]||{label:ev.event_type};
          return (
            <div key={ev.id} style={{padding:'14px 20px',borderBottom:`1px solid ${C.border}`,display:'flex',gap:14,alignItems:'flex-start'}}>
              <div style={{width:34,height:34,borderRadius:'50%',background:C.bg,border:`1px solid ${C.border}`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                <div style={{width:6,height:6,borderRadius:'50%',background:'#D2D2D7'}}/>
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginBottom:3}}>
                  <span style={{fontWeight:700,fontSize:13}}>{ev.restaurant?.name||'Plataforma'}</span>
                  <span style={{padding:'1px 8px',borderRadius:12,fontSize:11,fontWeight:600,background:C.bg,color:C.mid,border:`1px solid ${C.border}`}}>{m.label}</span>
                </div>
                <div style={{fontSize:13,color:C.ink}}>{ev.description}</div>
              </div>
              <div style={{fontSize:11,color:C.dim,whiteSpace:'nowrap',flexShrink:0}}>{fmtDateTime(ev.created_at)}</div>
            </div>
          );
        })}
      </SectionCard>

      {addModal&&(
        <Modal title="Registrar evento manual" onClose={()=>setAddModal(false)}>
          <FormField label="Restaurante">
            <select value={form.restaurant_id} onChange={e=>setForm(f=>({...f,restaurant_id:e.target.value}))}>
              <option value="">Plataforma (sin restaurante)</option>
              {restaurants.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </FormField>
          <FormField label="Tipo de evento">
            <select value={form.event_type} onChange={e=>setForm(f=>({...f,event_type:e.target.value}))}>
              {eventTypes.map(t=><option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </FormField>
          <FormField label="Descripción *">
            <textarea value={form.description} onChange={e=>setForm(f=>({...f,description:e.target.value}))} rows={3} placeholder="Detalle del evento..."/>
          </FormField>
          <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:8}}>
            <Btn variant="ghost" onClick={()=>setAddModal(false)}>Cancelar</Btn>
            <Btn onClick={addEvent} disabled={saving}>{saving?'Guardando…':'Registrar'}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   PAGE: PROVEEDORES — Marketplace B2B (FASE 3, PR-MKT-3)
   Gestión total del marketplace: Resumen · Solicitudes (CRM) · Proveedores ·
   Productos · Leads · Categorías · Reclamos. Superadmin tiene RLS ALL sobre las
   tablas marketplace_* (mig 142); las agregaciones pesadas del Resumen y los
   eventos de suspensión salen por RPC DEFINER (mig 144). No toca los proveedores
   internos del gerente (public.suppliers, mig 072): otro dominio.
   ════════════════════════════════════════════════════════════════════════════ */
const MKP_SUP_ESTADO = {
  activo:     {label:'Activo',     color:TINT.okText,     bg:TINT.okBg},
  pausado:    {label:'Pausado',    color:TINT.warnText,   bg:TINT.warnBg},
  suspendido: {label:'Suspendido', color:TINT.dangerText, bg:TINT.dangerBg},
};
const MKP_APP_ESTADO = {
  pendiente:   {label:'Pendiente',   color:TINT.infoText,   bg:TINT.infoBg},
  en_revision: {label:'En revisión', color:TINT.warnText,   bg:TINT.warnBg},
  falta_info:  {label:'Falta info',  color:TINT.purpleText, bg:TINT.purpleBg},
  aprobada:    {label:'Aprobada',    color:TINT.okText,     bg:TINT.okBg},
  rechazada:   {label:'Rechazada',   color:TINT.dangerText, bg:TINT.dangerBg},
};
const MKP_PROD_ESTADO = {
  publicado:    {label:'Publicado',     color:TINT.okText,     bg:TINT.okBg},
  borrador:     {label:'Borrador',      color:C.mid,           bg:'var(--bg-subtle)'},
  pausado:      {label:'Pausado',       color:TINT.warnText,   bg:TINT.warnBg},
  oculto_admin: {label:'Oculto (admin)',color:TINT.dangerText, bg:TINT.dangerBg},
};
const MKP_REPORT_ESTADO = {
  abierto:     {label:'Abierto',     color:TINT.dangerText, bg:TINT.dangerBg},
  en_revision: {label:'En revisión', color:TINT.warnText,   bg:TINT.warnBg},
  resuelto:    {label:'Resuelto',    color:TINT.okText,     bg:TINT.okBg},
  desestimado: {label:'Desestimado', color:C.mid,           bg:'var(--bg-subtle)'},
};
const MKP_LEAD_ESTADO_LBL = {
  nueva:'Nueva', respondida:'Respondida', negociando:'Negociando',
  cerrada:'Cerrada', perdida:'Perdida', archivada:'Archivada',
};
const MKP_LEAD_TIPO_LBL = { contacto:'Contacto', cotizacion:'Cotización' };
const MKP_REPORT_TIPO_LBL = {
  info_falsa:'Info falsa', precio_enganoso:'Precio engañoso', no_responde:'No responde',
  mala_calidad:'Mala calidad', no_entrego:'No entregó', trato_indebido:'Trato indebido',
  spam:'Spam', otro:'Otro',
};
const MKP_TIPO_PROV = ['productor','distribuidor','mayorista','minorista','importador','fabricante','servicio'];
// Estado de la suscripción del proveedor (mig 177) y ciclo de vida del plan.
const MKP_SUB_ESTADO = {
  trial:     {label:'Trial',      color:TINT.infoText,   bg:TINT.infoBg},
  active:    {label:'Activa',     color:TINT.okText,     bg:TINT.okBg},
  past_due:  {label:'Vencida',    color:TINT.warnText,   bg:TINT.warnBg},
  cancelled: {label:'Cancelada',  color:C.mid,           bg:'var(--bg-subtle)'},
  suspended: {label:'Suspendida', color:TINT.dangerText, bg:TINT.dangerBg},
};
const MKP_PLAN_ESTADO = {
  active:   {label:'Activo',    color:TINT.okText,     bg:TINT.okBg},
  inactive: {label:'Inactivo',  color:C.mid,           bg:'var(--bg-subtle)'},
  archived: {label:'Archivado', color:TINT.dangerText, bg:TINT.dangerBg},
};
const MKP_EVENT_LBL = {
  application_submitted:'Solicitud recibida', supplier_approved:'Proveedor aprobado',
  contact_revealed:'Contacto revelado', quote_created:'Cotización creada',
  supplier_suspended:'Proveedor suspendido', supplier_reactivated:'Proveedor reactivado',
  supplier_estado_changed:'Cambio de estado', supplier_deleted:'Proveedor eliminado',
};

const MkBadge = ({map, value}) => {
  const m = (map||{})[value] || {label:value||'—', color:C.mid, bg:'var(--bg-subtle)'};
  return <span style={{padding:'2px 9px',borderRadius:20,fontSize:11,fontWeight:600,background:m.bg,color:m.color,whiteSpace:'nowrap'}}>{m.label}</span>;
};

// Tokens CSS (no C.*) para que los inputs sigan el tema por-paint (C es un
// objeto mutado en mythos:themechange y un const literal lo congelaría).
const sField = {width:'100%',padding:'8px 11px',border:'1px solid var(--border)',borderRadius:8,background:'var(--bg-subtle)',color:'var(--text-primary)',fontSize:13,fontFamily:'inherit',boxSizing:'border-box'};
const SInp = ({value,onChange,placeholder,type='text',style={}}) =>
  <input type={type} value={value??''} placeholder={placeholder} onChange={e=>onChange(e.target.value)} style={{...sField,...style}}/>;
const SSel = ({value,onChange,children,style={}}) =>
  <select value={value??''} onChange={e=>onChange(e.target.value)} style={{...sField,cursor:'pointer',...style}}>{children}</select>;
const STa = ({value,onChange,placeholder,rows=3,style={}}) =>
  <textarea value={value??''} placeholder={placeholder} rows={rows} onChange={e=>onChange(e.target.value)} style={{...sField,resize:'vertical',...style}}/>;
// Input de guaraníes con separador de miles en vivo; entrega el entero (string de dígitos).
const MilesInput = ({value,onChange,style={}}) => {
  const digits = String(value??'').replace(/\D/g,'');
  const shown = digits==='' ? '' : Number(digits).toLocaleString('es-PY');
  return <input inputMode="numeric" value={shown} placeholder="0"
    onChange={e=>onChange(e.target.value.replace(/\D/g,''))} style={{...sField,...style}}/>;
};

// Chip de categoría seleccionable (multi) para el editor de proveedor.
const MkChip = ({on,label,onClick}) => (
  <button type="button" onClick={onClick} style={{padding:'5px 11px',borderRadius:20,fontSize:12,fontWeight:600,cursor:'pointer',
    border:`1px solid ${on?C.ink:C.border}`,background:on?C.ink:'transparent',color:on?C.surface:C.mid,transition:'all .12s'}}>{label}</button>
);

function mkDownloadCSV(filename, rows) {
  const csv = rows.map(r => r.map(cell => {
    const s = String(cell==null?'':cell);
    return /[",\n\r]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
  }).join(',')).join('\r\n');
  const blob = new Blob(['﻿'+csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1500);
}

const MkTabBar = ({tabs, active, onSelect}) => (
  <div style={{display:'flex',gap:4,flexWrap:'wrap',borderBottom:`1px solid ${C.border}`,marginBottom:18}}>
    {tabs.map(t=>{
      const on = active===t.id;
      return (
        <button key={t.id} onClick={()=>onSelect(t.id)} style={{position:'relative',display:'flex',alignItems:'center',gap:7,padding:'9px 14px',border:'none',background:'transparent',cursor:'pointer',
          fontSize:13,fontWeight:on?700:500,color:on?C.ink:C.mid,borderBottom:`2px solid ${on?C.ink:'transparent'}`,marginBottom:-1}}>
          {t.label}
          {t.badge>0 && <span style={{background:C.red,color:'#fff',fontSize:10,fontWeight:800,padding:'1px 6px',borderRadius:9,minWidth:16,textAlign:'center'}}>{t.badge}</span>}
        </button>
      );
    })}
  </div>
);

const MkEmpty = ({text}) => (
  <div style={{padding:'40px 16px',textAlign:'center',color:C.dim,fontSize:13}}>{text}</div>
);

/* ─── Tab RESUMEN ─── */
function MkResumen({stats, events, supNameById, restNameById}) {
  if (!stats) return <MkEmpty text="Sin datos del marketplace todavía."/>;
  const s = stats;
  const sup = s.suppliers||{}, pr = s.products||{}, ap = s.applications||{}, lm = s.leads_month||{};
  const topCat = s.top_categories||[], topSup = s.top_suppliers||[];
  const maxCat = Math.max(1, ...topCat.map(c=>c.leads||0));
  const maxSup = Math.max(1, ...topSup.map(c=>c.leads||0));
  return (
    <div className="animate-in">
      <div className="sa-kpis" style={{marginBottom:18}}>
        <Kpi label="Proveedores activos" value={fmtNum(sup.activo||0)} sub={`${fmtNum(sup.pausado||0)} pausados · ${fmtNum(sup.suspendido||0)} suspendidos`}/>
        <Kpi label="Productos publicados" value={fmtNum(pr.publicado||0)} sub={`${fmtNum(pr.total||0)} en total`}/>
        <Kpi label="Solicitudes abiertas" value={fmtNum(ap.abiertas||0)} sub={`${fmtNum(ap.pendiente||0)} pendientes`}/>
        <Kpi label="Leads del mes" value={fmtNum(lm.total||0)} sub={`${fmtNum(lm.contacto||0)} contactos · ${fmtNum(lm.cotizacion||0)} cotizaciones`}/>
        <Kpi label="Contactos revelados (mes)" value={fmtNum(s.contacts_revealed_month||0)} sub={`${fmtNum(s.quotes_month||0)} cotizaciones`}/>
        <Kpi label="Conversaciones activas" value={fmtNum(s.conversations_active||0)} sub={`${fmtNum(s.reports_open||0)} reclamos abiertos`}/>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(320px,1fr))',gap:16,marginBottom:18}}>
        <SectionCard title="Top categorías por leads">
          <div style={{padding:'14px 18px'}}>
            {topCat.length===0 ? <div style={{color:C.dim,fontSize:12}}>Sin leads todavía.</div> :
              topCat.map(c=>(
                <div key={c.slug} style={{marginBottom:10}}>
                  <div style={{display:'flex',justifyContent:'space-between',fontSize:12.5,marginBottom:4}}><span style={{color:C.ink,fontWeight:600}}>{c.nombre}</span><span style={{color:C.mid}}>{fmtNum(c.leads)}</span></div>
                  <div style={{height:6,borderRadius:4,background:C.bg,overflow:'hidden'}}><div style={{height:'100%',width:`${Math.round((c.leads/maxCat)*100)}%`,background:C.ink}}/></div>
                </div>
              ))}
          </div>
        </SectionCard>
        <SectionCard title="Proveedores más contactados">
          <div style={{padding:'14px 18px'}}>
            {topSup.length===0 ? <div style={{color:C.dim,fontSize:12}}>Sin leads todavía.</div> :
              topSup.map(c=>(
                <div key={c.supplier_id} style={{marginBottom:10}}>
                  <div style={{display:'flex',justifyContent:'space-between',fontSize:12.5,marginBottom:4}}><span style={{color:C.ink,fontWeight:600}}>{c.nombre_comercial}</span><span style={{color:C.mid}}>{fmtNum(c.leads)}</span></div>
                  <div style={{height:6,borderRadius:4,background:C.bg,overflow:'hidden'}}><div style={{height:'100%',width:`${Math.round((c.leads/maxSup)*100)}%`,background:C.ink}}/></div>
                </div>
              ))}
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Actividad reciente del marketplace">
        {events.length===0 ? <MkEmpty text="Sin eventos registrados."/> : (
          <div>
            {events.slice(0,20).map(ev=>(
              <div key={ev.id} style={{display:'flex',alignItems:'center',gap:12,padding:'10px 18px',borderTop:`1px solid ${C.border}`}}>
                <span style={{fontSize:12.5,fontWeight:600,color:C.ink,minWidth:170}}>{MKP_EVENT_LBL[ev.event_type]||ev.event_type}</span>
                <span style={{flex:1,fontSize:12,color:C.mid}}>
                  {ev.supplier_id && (supNameById[ev.supplier_id]||'proveedor') }
                  {ev.restaurant_id && ` · ${restNameById[ev.restaurant_id]||'restaurante'}`}
                </span>
                <span style={{fontSize:11.5,color:C.dim,whiteSpace:'nowrap'}}>{fmtRelTime(ev.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

/* ─── Tab SOLICITUDES (CRM) ─── */
function MkSolicitudes({apps, load, setFlash}) {
  const [fEstado, setFEstado] = useState('abiertas');
  const [expanded, setExpanded] = useState(null);
  const [notas, setNotas] = useState('');
  const [savingNota, setSavingNota] = useState(false);
  const [approveApp, setApproveApp] = useState(null);
  const [rejectApp, setRejectApp] = useState(null);

  const shown = apps.filter(a=>{
    if (fEstado==='abiertas') return ['pendiente','en_revision','falta_info'].includes(a.estado);
    if (fEstado==='all') return true;
    return a.estado===fEstado;
  });

  const openRow = a => { setExpanded(expanded===a.id?null:a.id); setNotas(a.notas_internas||''); };

  const saveNota = async (a) => {
    setSavingNota(true);
    const { error } = await db.from('marketplace_applications').update({notas_internas:notas}).eq('id',a.id);
    setSavingNota(false);
    if (error) { setFlash({type:'error',text:error.message}); return; }
    setFlash({type:'ok',text:'Notas guardadas'}); load();
  };

  return (
    <div className="animate-in">
      <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:14,flexWrap:'wrap'}}>
        <SSel value={fEstado} onChange={setFEstado} style={{width:200}}>
          <option value="abiertas">Abiertas (pendiente/revisión)</option>
          <option value="pendiente">Pendientes</option>
          <option value="en_revision">En revisión</option>
          <option value="falta_info">Falta info</option>
          <option value="aprobada">Aprobadas</option>
          <option value="rechazada">Rechazadas</option>
          <option value="all">Todas</option>
        </SSel>
        <span style={{fontSize:12,color:C.mid}}>{shown.length} solicitud{shown.length===1?'':'es'}</span>
      </div>

      <SectionCard>
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',minWidth:720}}>
            <thead><tr>
              <Th>Empresa</Th><Th>Contacto</Th><Th>Ciudad</Th><Th>Categorías</Th><Th>Estado</Th><Th>Recibida</Th><Th style={{textAlign:'right'}}>Acciones</Th>
            </tr></thead>
            <tbody>
              {shown.length===0 && <tr><Td style={{textAlign:'center',color:C.dim}} colSpan={7}>Sin solicitudes.</Td></tr>}
              {shown.map(a=>(
                <React.Fragment key={a.id}>
                  <tr style={{cursor:'pointer'}} onClick={()=>openRow(a)}>
                    <Td><span style={{fontWeight:600,color:C.ink}}>{a.nombre_comercial}</span>{a.ruc && <div style={{fontSize:11,color:C.dim}}>RUC {a.ruc}</div>}</Td>
                    <Td>{a.contacto_nombre||'—'}<div style={{fontSize:11,color:C.dim}}>{a.email||a.telefono||a.whatsapp||''}</div></Td>
                    <Td>{a.ciudad||'—'}</Td>
                    <Td><span style={{fontSize:11,color:C.mid}}>{(a.categorias||[]).slice(0,3).join(', ')}{(a.categorias||[]).length>3?'…':''}</span></Td>
                    <Td><MkBadge map={MKP_APP_ESTADO} value={a.estado}/></Td>
                    <Td><span style={{fontSize:12,color:C.mid}}>{fmtAlta(a.created_at)}</span></Td>
                    <Td style={{textAlign:'right'}}><span style={{fontSize:11,color:C.dim}}>{expanded===a.id?'▲':'▼'}</span></Td>
                  </tr>
                  {expanded===a.id && (
                    <tr><Td colSpan={7} style={{background:C.bg}}>
                      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:'8px 20px',padding:'6px 2px 14px',fontSize:12.5}}>
                        {[['Razón social',a.razon_social],['RUC',a.ruc],['Tipo',a.tipo_proveedor],['Rubro',a.rubro_principal],['Años en el mercado',a.anhos_mercado],
                          ['Departamento',a.departamento],['Dirección',a.direccion],['Web / redes',a.web_redes],['Cargo contacto',a.contacto_cargo],
                          ['Teléfono',a.telefono],['WhatsApp',a.whatsapp],['Email',a.email],
                          ['Vende mayorista',a.vende_mayor?'Sí':'No'],['Vende minorista',a.vende_menor?'Sí':'No'],
                          ['Zonas de entrega',(a.zonas_entrega||[]).join(', ')],['Delivery propio',a.delivery_propio?'Sí':'No'],['Retiro en local',a.retiro_local?'Sí':'No'],
                          ['Días de entrega',a.dias_entrega],['Pedido mínimo',a.pedido_minimo],['Entrega urgente',a.entrega_urgente?'Sí':'No'],
                          ['Acepta crédito',a.acepta_credito?'Sí':'No'],['Emite factura',a.emite_factura?'Sí':'No'],['Categorías',(a.categorias||[]).join(', ')],
                          ['Marcas',a.marcas],['Productos principales',a.productos_principales],['Mensaje',a.mensaje],['Origen',a.origen]
                        ].filter(([,v])=>v!==null&&v!==undefined&&v!=='').map(([k,v])=>(
                          <div key={k}><div style={{fontSize:10.5,color:C.dim,textTransform:'uppercase',letterSpacing:.4,marginBottom:2}}>{k}</div>
                            {/* El WhatsApp es el canal de contacto del proveedor: se abre el chat
                                desde acá en vez de copiar el número a mano. */}
                            <div style={{color:C.ink}}>{k==='WhatsApp' ? <WaLink phone={v}/> : String(v)}</div></div>
                        ))}
                      </div>
                      <div style={{marginTop:6}}>
                        <div style={{fontSize:10.5,color:C.dim,textTransform:'uppercase',letterSpacing:.4,marginBottom:4}}>Notas internas</div>
                        <STa value={notas} onChange={setNotas} rows={2} placeholder="Notas del equipo (no visibles para el proveedor)…"/>
                        <div style={{display:'flex',gap:8,justifyContent:'space-between',flexWrap:'wrap',marginTop:10}}>
                          <Btn variant="ghost" size="sm" onClick={()=>saveNota(a)} disabled={savingNota}>{savingNota?'Guardando…':'Guardar notas'}</Btn>
                          {a.estado!=='aprobada' && (
                            <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                              <Btn variant="ghost" size="sm" onClick={()=>setRejectApp({app:a,modo:'falta_info'})}>Pedir info</Btn>
                              <Btn variant="danger" size="sm" onClick={()=>setRejectApp({app:a,modo:'rechazada'})}>Rechazar</Btn>
                              <Btn variant="success" size="sm" onClick={()=>setApproveApp(a)}>Aprobar</Btn>
                            </div>
                          )}
                        </div>
                      </div>
                    </Td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {approveApp && <MkApproveModal app={approveApp} onClose={()=>setApproveApp(null)} onDone={()=>{setApproveApp(null);load();}} setFlash={setFlash}/>}
      {rejectApp && <MkRejectModal ctx={rejectApp} onClose={()=>setRejectApp(null)} onDone={()=>{setRejectApp(null);load();}} setFlash={setFlash}/>}
    </div>
  );
}

function MkApproveModal({app, onClose, onDone, setFlash}) {
  const [email, setEmail] = useState(app.email||'');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // {temp_password, slug, email}
  const [copied, setCopied] = useState(false);

  const approve = async () => {
    const e = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { setFlash({type:'warn',text:'Ingresá el email real del proveedor'}); return; }
    setBusy(true);
    try {
      const { data:{session} } = await db.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Sin sesión activa');
      const resp = await fetch('/api/approve-supplier', {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
        body: JSON.stringify({ application_id: app.id, email: e })
      });
      const r = await resp.json();
      if (!resp.ok) throw new Error(r.error || 'Error al aprobar');
      setResult(r);
    } catch(err) { setFlash({type:'error',text:err.message}); }
    setBusy(false);
  };
  const copyPwd = async () => {
    try { await navigator.clipboard.writeText(result.temp_password); setCopied(true); setTimeout(()=>setCopied(false),2000); } catch(_){}
  };

  return (
    <Modal title={result?'Proveedor aprobado':'Aprobar proveedor'} onClose={result?onDone:onClose} width={460}>
      {!result ? (
        <div>
          <div style={{fontSize:13,color:C.mid,lineHeight:1.5,marginBottom:14}}>
            Se creará la cuenta del proveedor <strong style={{color:C.ink}}>{app.nombre_comercial}</strong> y su tienda quedará activa en el marketplace.
          </div>
          <FormField label="Email real del proveedor" hint="Se usa como usuario de acceso. La contraseña temporal se muestra al aprobar.">
            <SInp value={email} onChange={setEmail} type="email" placeholder="proveedor@empresa.com"/>
          </FormField>
          <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:10}}>
            <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
            <Btn variant="success" onClick={approve} disabled={busy}>{busy?'Aprobando…':'Aprobar y crear cuenta'}</Btn>
          </div>
        </div>
      ) : (
        <div>
          <div style={{fontSize:13,color:C.ink,lineHeight:1.55,marginBottom:14}}>
            Cuenta creada para <strong>{result.email}</strong>. Tienda: <strong>{result.slug}</strong>.
          </div>
          {result.temp_password ? (
            <div style={{border:`1px solid ${C.border}`,borderRadius:10,padding:'14px 16px',background:C.bg,marginBottom:12}}>
              <div style={{fontSize:11,color:C.dim,textTransform:'uppercase',letterSpacing:.4,marginBottom:6}}>Contraseña temporal (se muestra una sola vez)</div>
              <div style={{display:'flex',gap:8,alignItems:'center'}}>
                <code style={{flex:1,fontSize:15,fontWeight:700,color:C.ink,fontFamily:"'SF Mono',ui-monospace,monospace",letterSpacing:.5,wordBreak:'break-all'}}>{result.temp_password}</code>
                <Btn size="sm" onClick={copyPwd}>{copied?'¡Copiado!':'Copiar'}</Btn>
              </div>
              <div style={{fontSize:11.5,color:C.orange,fontWeight:600,marginTop:10,lineHeight:1.5}}>
                Compartila con el proveedor por WhatsApp. Al primer ingreso deberá cambiarla. No queda registrada en ningún lado.
              </div>
            </div>
          ) : (
            <div style={{fontSize:12.5,color:C.mid,marginBottom:12}}>Se usó la contraseña provista. El proveedor deberá cambiarla al ingresar.</div>
          )}
          <div style={{display:'flex',justifyContent:'flex-end'}}><Btn onClick={onDone}>Listo</Btn></div>
        </div>
      )}
    </Modal>
  );
}

function MkRejectModal({ctx, onClose, onDone, setFlash}) {
  const {app, modo} = ctx;
  const [motivo, setMotivo] = useState('');
  const [busy, setBusy] = useState(false);
  const esRechazo = modo==='rechazada';
  const save = async () => {
    setBusy(true);
    const stamp = new Date().toLocaleDateString('es-PY',{day:'2-digit',month:'2-digit',year:'numeric'});
    const linea = `[${stamp}] ${esRechazo?'RECHAZADA':'FALTA INFO'}${motivo.trim()?': '+motivo.trim():''}`;
    const notas = [app.notas_internas, linea].filter(Boolean).join('\n');
    const { error } = await db.from('marketplace_applications')
      .update({ estado: modo, notas_internas: notas, reviewed_at: new Date().toISOString() })
      .eq('id', app.id);
    setBusy(false);
    if (error) { setFlash({type:'error',text:error.message}); return; }
    setFlash({type:'ok',text:esRechazo?'Solicitud rechazada':'Marcada como “falta info”'});
    onDone();
  };
  return (
    <Modal title={esRechazo?'Rechazar solicitud':'Pedir más información'} onClose={onClose} width={440}>
      <div style={{fontSize:13,color:C.mid,lineHeight:1.5,marginBottom:12}}>
        {esRechazo ? 'La solicitud se marca como rechazada.' : 'La solicitud queda en espera de más datos del proveedor.'} El motivo se guarda en las notas internas.
      </div>
      <FormField label="Motivo (opcional)">
        <STa value={motivo} onChange={setMotivo} rows={3} placeholder={esRechazo?'Ej. datos incompletos / rubro fuera de alcance…':'Ej. falta RUC / falta detalle de productos…'}/>
      </FormField>
      <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:8}}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant={esRechazo?'danger':'primary'} onClick={save} disabled={busy}>{busy?'Guardando…':(esRechazo?'Rechazar':'Marcar falta info')}</Btn>
      </div>
    </Modal>
  );
}

/* ─── Tab PROVEEDORES ─── */
function MkProveedores({suppliers, prodCountBySup, leadCountBySup, categories, supPlans, subBySupplier, load, setFlash, gotoProducts}) {
  const [search, setSearch] = useState('');
  const [fEstado, setFEstado] = useState('all');
  const [editSup, setEditSup] = useState(null);
  const [contactSup, setContactSup] = useState(null);
  const [deleteSup, setDeleteSup] = useState(null);
  const [planSup, setPlanSup] = useState(null);
  const planBySlug = {}; (supPlans||[]).forEach(p=>{ planBySlug[p.slug]=p; });

  const setEstado = async (sup, estado) => {
    const { error } = await db.rpc('superadmin_set_supplier_estado', {p_supplier_id:sup.id, p_estado:estado});
    if (error) { setFlash({type:'error',text:error.message}); return; }
    setFlash({type:'ok',text:`Proveedor ${estado==='suspendido'?'suspendido':estado==='activo'?'reactivado':'pausado'}`}); load();
  };
  const setField = async (sup, patch) => {
    const { error } = await db.from('marketplace_suppliers').update(patch).eq('id',sup.id);
    if (error) { setFlash({type:'error',text:error.message}); return; }
    load();
  };
  const viewContact = async (sup) => {
    setContactSup({supplier:sup, contact:null, loading:true});
    const { data } = await db.from('marketplace_supplier_contacts').select('*').eq('supplier_id',sup.id).maybeSingle();
    setContactSup({supplier:sup, contact:data||null, loading:false});
  };

  const shown = suppliers.filter(s=>{
    if (fEstado!=='all' && s.estado!==fEstado) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (s.nombre_comercial||'').toLowerCase().includes(q) || (s.ruc||'').toLowerCase().includes(q) || (s.ciudad||'').toLowerCase().includes(q) || (s.slug||'').toLowerCase().includes(q);
  });

  return (
    <div className="animate-in">
      <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:14,flexWrap:'wrap'}}>
        <SInp value={search} onChange={setSearch} placeholder="Buscar por nombre, RUC, ciudad…" style={{width:280}}/>
        <SSel value={fEstado} onChange={setFEstado} style={{width:160}}>
          <option value="all">Todos los estados</option>
          <option value="activo">Activos</option>
          <option value="pausado">Pausados</option>
          <option value="suspendido">Suspendidos</option>
        </SSel>
        <span style={{fontSize:12,color:C.mid}}>{shown.length} proveedor{shown.length===1?'':'es'}</span>
      </div>

      <SectionCard>
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',minWidth:900}}>
            <thead><tr>
              <Th>Proveedor</Th><Th>Estado</Th><Th>Plan</Th><Th style={{textAlign:'center'}}>Verif.</Th><Th style={{textAlign:'center'}}>Dest.</Th><Th>Ciudad</Th><Th style={{textAlign:'center'}}>Prod.</Th><Th style={{textAlign:'center'}}>Leads</Th><Th>Alta</Th><Th style={{textAlign:'right'}}>Acciones</Th>
            </tr></thead>
            <tbody>
              {shown.length===0 && <tr><Td style={{textAlign:'center',color:C.dim}} colSpan={10}>Sin proveedores.</Td></tr>}
              {shown.map(s=>(
                <tr key={s.id}>
                  <Td><span style={{fontWeight:600,color:C.ink}}>{s.nombre_comercial}</span>{s.ruc && <div style={{fontSize:11,color:C.dim}}>RUC {s.ruc}</div>}</Td>
                  <Td><MkBadge map={MKP_SUP_ESTADO} value={s.estado}/></Td>
                  <Td>
                    {(() => {
                      const sub = (subBySupplier||{})[s.id];
                      const pl = planBySlug[s.plan];
                      return (
                        <button type="button" onClick={()=>setPlanSup(s)} title="Cambiar plan / trial"
                          style={{display:'flex',flexDirection:'column',alignItems:'flex-start',gap:3,background:'transparent',border:'none',padding:0,cursor:'pointer'}}>
                          <span style={{fontWeight:600,color:C.ink,fontSize:12.5}}>{pl?.name || s.plan || '—'}</span>
                          {sub
                            ? <span style={{display:'inline-flex',alignItems:'center',gap:5}}>
                                <MkBadge map={MKP_SUB_ESTADO} value={sub.status}/>
                                {sub.status==='trial' && sub.trial_ends_at && <span style={{fontSize:10,color:C.dim}}>{fmtDate(sub.trial_ends_at)}</span>}
                              </span>
                            : <span style={{fontSize:10.5,color:C.dim}}>sin suscripción</span>}
                        </button>
                      );
                    })()}
                  </Td>
                  <Td style={{textAlign:'center'}}><div style={{display:'inline-flex'}}><Toggle checked={s.verificado} onChange={v=>setField(s,{verificado:v})}/></div></Td>
                  <Td style={{textAlign:'center'}}><div style={{display:'inline-flex'}}><Toggle checked={s.destacado} onChange={v=>setField(s,{destacado:v})}/></div></Td>
                  <Td>{s.ciudad||'—'}</Td>
                  <Td style={{textAlign:'center'}}>{fmtNum(prodCountBySup[s.id]||0)}</Td>
                  <Td style={{textAlign:'center'}}>{fmtNum(leadCountBySup[s.id]||0)}</Td>
                  <Td><span style={{fontSize:12,color:C.mid}}>{fmtDate(s.created_at)}</span></Td>
                  <Td style={{textAlign:'right'}}>
                    <div style={{display:'inline-flex',gap:6,flexWrap:'wrap',justifyContent:'flex-end'}}>
                      <Btn variant="ghost" size="sm" onClick={()=>setEditSup(s)}>Editar</Btn>
                      <Btn variant="ghost" size="sm" onClick={()=>viewContact(s)}>Contacto</Btn>
                      <Btn variant="ghost" size="sm" onClick={()=>gotoProducts(s.id)}>Productos</Btn>
                      {/* On/off Activo↔Inactivo (un solo toggle): activo→Suspender; */}
                      {/* pausado o suspendido→Activar (ambos son "Inactivo" para el super). */}
                      {s.estado==='activo'
                        ? <Btn variant="ghost" size="sm" style={{color:TINT.warnText}} onClick={()=>setEstado(s,'suspendido')}>Suspender</Btn>
                        : <Btn variant="success" size="sm" onClick={()=>setEstado(s,'activo')}>Activar</Btn>}
                      <Btn variant="danger" size="sm" onClick={()=>setDeleteSup(s)}>Eliminar</Btn>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {editSup && <MkEditSupplierModal sup={editSup} categories={categories} onClose={()=>setEditSup(null)} onDone={()=>{setEditSup(null);load();}} setFlash={setFlash}/>}
      {planSup && <MkSupplierPlanModal sup={planSup} sub={(subBySupplier||{})[planSup.id]} plans={supPlans||[]} onClose={()=>setPlanSup(null)} onDone={()=>{setPlanSup(null);load();}} setFlash={setFlash}/>}
      {deleteSup && <MkDeleteSupplierModal sup={deleteSup} prodCount={prodCountBySup[deleteSup.id]||0} leadCount={leadCountBySup[deleteSup.id]||0} onClose={()=>setDeleteSup(null)} onDone={()=>{setDeleteSup(null);load();}} setFlash={setFlash}/>}
      {contactSup && (
        <Modal title={`Contacto — ${contactSup.supplier.nombre_comercial}`} onClose={()=>setContactSup(null)} width={420}>
          {contactSup.loading ? <div style={{display:'flex',gap:10,alignItems:'center',color:C.mid}}><Spinner/> Cargando…</div> :
            !contactSup.contact ? <div style={{color:C.mid,fontSize:13}}>Sin datos de contacto cargados.</div> : (
            <div style={{display:'grid',gap:'10px 0',fontSize:13}}>
              {[['Contacto',contactSup.contact.contacto_nombre],['Teléfono',contactSup.contact.telefono],['WhatsApp',contactSup.contact.whatsapp],['Email comercial',contactSup.contact.email_comercial]].map(([k,v])=>(
                <div key={k}><span style={{fontSize:11,color:C.dim,textTransform:'uppercase',letterSpacing:.4}}>{k}</span><div style={{color:C.ink,fontWeight:600}}>{v||'—'}</div></div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

// ── Modal "Eliminar proveedor definitivamente" — Zona de peligro ──
// Borrado permanente vía RPC superadmin_delete_supplier (mig 167). Confirmación
// por nombre exacto (patrón DeleteRestaurantModal). Muestra el blast radius
// (productos + leads) antes de borrar. La cuenta Auth del proveedor NO se toca.
function MkDeleteSupplierModal({sup, prodCount, leadCount, onClose, onDone, setFlash}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState('');
  const match = typed.trim() === (sup.nombre_comercial||'').trim();

  const doDelete = async () => {
    if (!match || busy) return;
    setErr(''); setBusy(true);
    const { data, error } = await db.rpc('superadmin_delete_supplier', {p_supplier_id:sup.id});
    setBusy(false);
    if (error) { setErr(error.message||'No se pudo eliminar.'); return; }
    const c = (data && data.counts) || {};
    const extras = [];
    if (c.products>0) extras.push(`${c.products} producto${c.products>1?'s':''}`);
    if (c.leads>0)    extras.push(`${c.leads} lead${c.leads>1?'s':''}`);
    setFlash({type:'ok', text:`"${sup.nombre_comercial}" eliminado${extras.length?` (+${extras.join(', ')})`:''}`});
    onDone();
  };

  return (
    <Modal title="Eliminar proveedor" onClose={onClose} width={480}>
      <div style={{background:TINT.dangerBg,color:TINT.dangerText,border:`1px solid ${TINT.warnBorder}`,borderRadius:10,padding:'12px 14px',fontSize:12.5,lineHeight:1.55,marginBottom:16}}>
        Acción <b>irreversible</b>. Se borran el proveedor y TODOS sus datos: productos, leads, conversaciones, guardados y reseñas. Los reclamos/eventos quedan (sin vínculo). La <b>cuenta de acceso</b> del proveedor no se borra: queda inerte.
      </div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:14}}>
        <span style={{padding:'4px 10px',borderRadius:8,fontSize:12,fontWeight:600,background:'var(--bg-subtle)',color:C.mid}}>{fmtNum(prodCount)} producto{prodCount===1?'':'s'}</span>
        <span style={{padding:'4px 10px',borderRadius:8,fontSize:12,fontWeight:600,background:'var(--bg-subtle)',color:C.mid}}>{fmtNum(leadCount)} lead{leadCount===1?'':'s'}</span>
      </div>
      {err && <div style={{color:C.red,fontSize:12.5,marginBottom:12,fontWeight:600}}>{err}</div>}
      <FormField label="Escribí el nombre comercial exacto para confirmar">
        <input value={typed} onChange={e=>setTyped(e.target.value)} placeholder={sup.nombre_comercial} autoFocus/>
      </FormField>
      <div style={{fontSize:11,color:C.dim,margin:'6px 0 18px'}}>Si sólo querés ocultarlo del marketplace de forma reversible, usá <b>Suspender</b> en vez de eliminar.</div>
      <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="danger" onClick={doDelete} disabled={!match || busy}>{busy?'Eliminando…':'Eliminar definitivamente'}</Btn>
      </div>
    </Modal>
  );
}

function MkEditSupplierModal({sup, categories, onClose, onDone, setFlash}) {
  const [f, setF] = useState({
    nombre_comercial:sup.nombre_comercial||'', razon_social:sup.razon_social||'', ruc:sup.ruc||'',
    tipo_proveedor:sup.tipo_proveedor||'', descripcion:sup.descripcion||'', ciudad:sup.ciudad||'', departamento:sup.departamento||'',
    dias_entrega:sup.dias_entrega||'', horario_atencion:sup.horario_atencion||'', pedido_minimo:sup.pedido_minimo||'',
    condiciones_comerciales:sup.condiciones_comerciales||'',
    verificado:!!sup.verificado, destacado:!!sup.destacado, emite_factura:!!sup.emite_factura,
    delivery_propio:!!sup.delivery_propio, retiro_local:!!sup.retiro_local, acepta_credito:!!sup.acepta_credito,
    categorias:Array.isArray(sup.categorias)?[...sup.categorias]:[],
  });
  const [busy, setBusy] = useState(false);
  const set = (k,v) => setF(o=>({...o,[k]:v}));
  const toggleCat = slug => setF(o=>({...o, categorias: o.categorias.includes(slug)?o.categorias.filter(c=>c!==slug):[...o.categorias,slug]}));
  const save = async () => {
    if (!f.nombre_comercial.trim()) { setFlash({type:'warn',text:'El nombre comercial es obligatorio'}); return; }
    setBusy(true);
    const { error } = await db.from('marketplace_suppliers').update({
      nombre_comercial:f.nombre_comercial.trim(), razon_social:f.razon_social.trim()||null, ruc:f.ruc.trim()||null,
      tipo_proveedor:f.tipo_proveedor||null, descripcion:f.descripcion.trim()||null, ciudad:f.ciudad.trim()||null, departamento:f.departamento.trim()||null,
      dias_entrega:f.dias_entrega.trim()||null, horario_atencion:f.horario_atencion.trim()||null, pedido_minimo:f.pedido_minimo.trim()||null,
      condiciones_comerciales:f.condiciones_comerciales.trim()||null,
      verificado:f.verificado, destacado:f.destacado, emite_factura:f.emite_factura,
      delivery_propio:f.delivery_propio, retiro_local:f.retiro_local, acepta_credito:f.acepta_credito,
      categorias:f.categorias,
    }).eq('id',sup.id);
    setBusy(false);
    if (error) { setFlash({type:'error',text:error.message}); return; }
    setFlash({type:'ok',text:'Proveedor actualizado'}); onDone();
  };
  const flag = (k,label) => (
    <label style={{display:'flex',alignItems:'center',gap:8,fontSize:12.5,color:C.ink,cursor:'pointer'}}>
      <Toggle checked={f[k]} onChange={v=>set(k,v)}/> {label}
    </label>
  );
  return (
    <Modal title={`Editar — ${sup.nombre_comercial}`} onClose={onClose} width={620}>
      <div className="my-row-2" style={{gap:'0 16px'}}>
        <FormField label="Nombre comercial *"><SInp value={f.nombre_comercial} onChange={v=>set('nombre_comercial',v)}/></FormField>
        <FormField label="Razón social"><SInp value={f.razon_social} onChange={v=>set('razon_social',v)}/></FormField>
        <FormField label="RUC"><SInp value={f.ruc} onChange={v=>set('ruc',v)}/></FormField>
        <FormField label="Tipo de proveedor">
          <SSel value={f.tipo_proveedor} onChange={v=>set('tipo_proveedor',v)}>
            <option value="">—</option>
            {MKP_TIPO_PROV.map(t=><option key={t} value={t}>{t}</option>)}
          </SSel>
        </FormField>
        <FormField label="Ciudad"><SInp value={f.ciudad} onChange={v=>set('ciudad',v)}/></FormField>
        <FormField label="Departamento"><SInp value={f.departamento} onChange={v=>set('departamento',v)}/></FormField>
        <FormField label="Días de entrega"><SInp value={f.dias_entrega} onChange={v=>set('dias_entrega',v)}/></FormField>
        <FormField label="Horario de atención"><SInp value={f.horario_atencion} onChange={v=>set('horario_atencion',v)}/></FormField>
        <FormField label="Pedido mínimo"><SInp value={f.pedido_minimo} onChange={v=>set('pedido_minimo',v)}/></FormField>
        <FormField label="Plan">
          <div style={{...sField,display:'flex',alignItems:'center',color:C.mid,fontSize:12.5}}>{sup.plan||'—'} · se gestiona en la columna “Plan”</div>
        </FormField>
      </div>
      <FormField label="Descripción"><STa value={f.descripcion} onChange={v=>set('descripcion',v)} rows={2}/></FormField>
      <FormField label="Condiciones comerciales"><STa value={f.condiciones_comerciales} onChange={v=>set('condiciones_comerciales',v)} rows={2}/></FormField>
      <FormField label="Categorías">
        <div style={{display:'flex',gap:7,flexWrap:'wrap'}}>
          {categories.filter(c=>c.activa).map(c=><MkChip key={c.slug} on={f.categorias.includes(c.slug)} label={c.nombre} onClick={()=>toggleCat(c.slug)}/>)}
        </div>
      </FormField>
      <div style={{display:'flex',gap:'12px 24px',flexWrap:'wrap',margin:'6px 0 14px'}}>
        {flag('verificado','Verificado')}{flag('destacado','Destacado')}{flag('emite_factura','Emite factura')}
        {flag('delivery_propio','Delivery propio')}{flag('retiro_local','Retiro en local')}{flag('acepta_credito','Acepta crédito')}
      </div>
      <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn onClick={save} disabled={busy}>{busy?'Guardando…':'Guardar cambios'}</Btn>
      </div>
    </Modal>
  );
}

/* ─── Tab PRODUCTOS ─── */
function MkProductos({products, supNameById, categories, reportsByProduct, reportsBySupplier, filterSupplier, setFilterSupplier, load, setFlash}) {
  const [fCat, setFCat] = useState('all');
  const [fEstado, setFEstado] = useState('all');
  const [soloReportes, setSoloReportes] = useState(false);
  const [catModal, setCatModal] = useState(null);
  const [reportModal, setReportModal] = useState(null);

  const catName = slug => (categories.find(c=>c.slug===slug)?.nombre) || slug || '—';

  const setEstado = async (p, estado) => {
    const { error } = await db.from('marketplace_products').update({estado}).eq('id',p.id);
    if (error) { setFlash({type:'error',text:error.message}); return; }
    setFlash({type:'ok',text:estado==='oculto_admin'?'Producto ocultado':'Producto restaurado'}); load();
  };
  const setCat = async (p, slug) => {
    const { error } = await db.from('marketplace_products').update({categoria_slug:slug}).eq('id',p.id);
    if (error) { setFlash({type:'error',text:error.message}); return; }
    setFlash({type:'ok',text:'Categoría corregida'}); setCatModal(null); load();
  };

  const shown = products.filter(p=>{
    if (filterSupplier && p.supplier_id!==filterSupplier) return false;
    if (fCat!=='all' && p.categoria_slug!==fCat) return false;
    if (fEstado!=='all' && p.estado!==fEstado) return false;
    if (soloReportes && !(reportsByProduct[p.id]?.length)) return false;
    return true;
  });

  return (
    <div className="animate-in">
      <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:14,flexWrap:'wrap'}}>
        {filterSupplier && (
          <span style={{display:'inline-flex',alignItems:'center',gap:8,fontSize:12,fontWeight:600,color:C.ink,background:C.bg,border:`1px solid ${C.border}`,borderRadius:20,padding:'5px 12px'}}>
            {supNameById[filterSupplier]||'Proveedor'} <button onClick={()=>setFilterSupplier(null)} style={{background:'none',border:'none',color:C.mid,cursor:'pointer',fontSize:14,lineHeight:1}}>×</button>
          </span>
        )}
        <SSel value={fCat} onChange={setFCat} style={{width:170}}>
          <option value="all">Todas las categorías</option>
          {categories.map(c=><option key={c.slug} value={c.slug}>{c.nombre}</option>)}
        </SSel>
        <SSel value={fEstado} onChange={setFEstado} style={{width:150}}>
          <option value="all">Todos los estados</option>
          <option value="publicado">Publicados</option>
          <option value="borrador">Borradores</option>
          <option value="pausado">Pausados</option>
          <option value="oculto_admin">Ocultos (admin)</option>
        </SSel>
        <label style={{display:'flex',alignItems:'center',gap:7,fontSize:12.5,color:C.ink,cursor:'pointer'}}>
          <Toggle checked={soloReportes} onChange={setSoloReportes}/> Con reportes
        </label>
        <span style={{fontSize:12,color:C.mid}}>{shown.length} producto{shown.length===1?'':'s'}</span>
      </div>

      <SectionCard>
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',minWidth:820}}>
            <thead><tr>
              <Th>Producto</Th><Th>Proveedor</Th><Th>Categoría</Th><Th>Precio</Th><Th>Estado</Th><Th style={{textAlign:'center'}}>Reportes</Th><Th style={{textAlign:'right'}}>Acciones</Th>
            </tr></thead>
            <tbody>
              {shown.length===0 && <tr><Td style={{textAlign:'center',color:C.dim}} colSpan={7}>Sin productos.</Td></tr>}
              {shown.map(p=>{
                // Solo reportes puntuales del producto: los reportes a nivel
                // proveedor se gestionan en la pestaña Reclamos (atribuirlos a
                // cada producto del proveedor inflaría el badge de todos).
                const nrep = (reportsByProduct[p.id]?.length||0);
                return (
                  <tr key={p.id}>
                    <Td><span style={{fontWeight:600,color:C.ink}}>{p.nombre}</span>{p.marca && <div style={{fontSize:11,color:C.dim}}>{p.marca}</div>}</Td>
                    <Td><span style={{fontSize:12.5}}>{supNameById[p.supplier_id]||'—'}</span></Td>
                    <Td><span style={{fontSize:12}}>{catName(p.categoria_slug)}</span></Td>
                    <Td><span style={{fontSize:12}}>{p.precio_tipo==='cotizar'?'A cotizar':(p.precio!=null?fmtMoney(p.precio)+(p.precio_tipo==='desde'?' (desde)':''):'—')}</span></Td>
                    <Td><MkBadge map={MKP_PROD_ESTADO} value={p.estado}/></Td>
                    <Td style={{textAlign:'center'}}>{nrep>0 ? <button onClick={()=>setReportModal(p)} style={{background:TINT.dangerBg,color:TINT.dangerText,border:'none',borderRadius:12,padding:'2px 9px',fontSize:11,fontWeight:700,cursor:'pointer'}}>{nrep}</button> : <span style={{color:C.dim}}>—</span>}</Td>
                    <Td style={{textAlign:'right'}}>
                      <div style={{display:'inline-flex',gap:6,flexWrap:'wrap',justifyContent:'flex-end'}}>
                        <Btn variant="ghost" size="sm" onClick={()=>setCatModal(p)}>Categoría</Btn>
                        {p.estado==='oculto_admin'
                          ? <Btn variant="success" size="sm" onClick={()=>setEstado(p,'publicado')}>Restaurar</Btn>
                          : p.estado==='publicado'
                            ? <Btn variant="danger" size="sm" onClick={()=>setEstado(p,'oculto_admin')}>Ocultar</Btn>
                            : null}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {catModal && (
        <Modal title={`Categoría — ${catModal.nombre}`} onClose={()=>setCatModal(null)} width={380}>
          <FormField label="Categoría del producto">
            <SSel value={catModal.categoria_slug||''} onChange={v=>setCat(catModal,v)}>
              <option value="">— sin categoría —</option>
              {categories.map(c=><option key={c.slug} value={c.slug}>{c.nombre}</option>)}
            </SSel>
          </FormField>
          <div style={{fontSize:11.5,color:C.dim}}>Se guarda al elegir.</div>
        </Modal>
      )}
      {reportModal && (
        <Modal title={`Reportes — ${reportModal.nombre}`} onClose={()=>setReportModal(null)} width={480}>
          {(reportsByProduct[reportModal.id]||[]).map(r=>(
            <div key={r.id} style={{borderTop:`1px solid ${C.border}`,padding:'10px 0'}}>
              <div style={{display:'flex',justifyContent:'space-between',gap:10}}>
                <span style={{fontWeight:600,fontSize:12.5,color:C.ink}}>{MKP_REPORT_TIPO_LBL[r.tipo]||r.tipo}</span>
                <MkBadge map={MKP_REPORT_ESTADO} value={r.estado}/>
              </div>
              {r.detalle && <div style={{fontSize:12,color:C.mid,marginTop:4}}>{r.detalle}</div>}
              <div style={{fontSize:11,color:C.dim,marginTop:4}}>{fmtAlta(r.created_at)}</div>
            </div>
          ))}
          <div style={{fontSize:11.5,color:C.dim,marginTop:10}}>La gestión de reclamos se hace en la pestaña “Reclamos”.</div>
        </Modal>
      )}
    </div>
  );
}

/* ─── Tab LEADS (solo lectura + CSV) ─── */
function MkLeads({leads, supNameById, restNameById}) {
  const [fTipo, setFTipo] = useState('all');
  const [fEstado, setFEstado] = useState('all');
  const [fCanal, setFCanal] = useState('all');
  const [fSup, setFSup] = useState('all');
  const [fDesde, setFDesde] = useState('');
  const [fHasta, setFHasta] = useState('');

  const canales = Array.from(new Set(leads.map(l=>l.canal).filter(Boolean)));
  const sups = Array.from(new Set(leads.map(l=>l.supplier_id))).map(id=>({id,name:supNameById[id]||'—'})).sort((a,b)=>a.name.localeCompare(b.name));

  const shown = leads.filter(l=>{
    if (fTipo!=='all' && l.tipo!==fTipo) return false;
    if (fEstado!=='all' && l.estado!==fEstado) return false;
    if (fCanal!=='all' && l.canal!==fCanal) return false;
    if (fSup!=='all' && l.supplier_id!==fSup) return false;
    if (fDesde && new Date(l.created_at) < new Date(fDesde+'T00:00:00')) return false;
    if (fHasta && new Date(l.created_at) > new Date(fHasta+'T23:59:59')) return false;
    return true;
  });

  const exportCSV = () => {
    const header = ['Fecha','Tipo','Estado','Canal','Proveedor','Restaurante','Producto','Cantidad','Frecuencia','Mensaje'];
    const rows = shown.map(l=>[
      fmtAlta(l.created_at), MKP_LEAD_TIPO_LBL[l.tipo]||l.tipo, MKP_LEAD_ESTADO_LBL[l.estado]||l.estado, l.canal||'',
      supNameById[l.supplier_id]||'', restNameById[l.restaurant_id]||'', l.producto_texto||'', l.cantidad||'', l.frecuencia||'', l.mensaje||''
    ]);
    mkDownloadCSV(`mythos_leads_${todayPY()}.csv`, [header,...rows]);
  };

  return (
    <div className="animate-in">
      <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:14,flexWrap:'wrap'}}>
        <SSel value={fTipo} onChange={setFTipo} style={{width:130}}><option value="all">Todo tipo</option><option value="contacto">Contacto</option><option value="cotizacion">Cotización</option></SSel>
        <SSel value={fEstado} onChange={setFEstado} style={{width:140}}><option value="all">Todo estado</option>{Object.keys(MKP_LEAD_ESTADO_LBL).map(k=><option key={k} value={k}>{MKP_LEAD_ESTADO_LBL[k]}</option>)}</SSel>
        <SSel value={fCanal} onChange={setFCanal} style={{width:130}}><option value="all">Todo canal</option>{canales.map(c=><option key={c} value={c}>{c}</option>)}</SSel>
        <SSel value={fSup} onChange={setFSup} style={{width:180}}><option value="all">Todo proveedor</option>{sups.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</SSel>
        <SInp type="date" value={fDesde} onChange={setFDesde} style={{width:150}}/>
        <SInp type="date" value={fHasta} onChange={setFHasta} style={{width:150}}/>
        <span style={{fontSize:12,color:C.mid}}>{shown.length} lead{shown.length===1?'':'s'}</span>
        <Btn variant="ghost" size="sm" onClick={exportCSV} style={{marginLeft:'auto'}}>Exportar CSV</Btn>
      </div>

      <SectionCard>
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',minWidth:900}}>
            <thead><tr>
              <Th>Fecha</Th><Th>Tipo</Th><Th>Estado</Th><Th>Canal</Th><Th>Proveedor</Th><Th>Restaurante</Th><Th>Producto</Th>
            </tr></thead>
            <tbody>
              {shown.length===0 && <tr><Td style={{textAlign:'center',color:C.dim}} colSpan={7}>Sin leads.</Td></tr>}
              {shown.slice(0,500).map(l=>(
                <tr key={l.id}>
                  <Td><span style={{fontSize:12,color:C.mid}}>{fmtAlta(l.created_at)}</span></Td>
                  <Td>{MKP_LEAD_TIPO_LBL[l.tipo]||l.tipo}</Td>
                  <Td><span style={{fontSize:12}}>{MKP_LEAD_ESTADO_LBL[l.estado]||l.estado}</span></Td>
                  <Td><span style={{fontSize:12,color:C.mid}}>{l.canal||'—'}</span></Td>
                  <Td><span style={{fontSize:12.5,fontWeight:600,color:C.ink}}>{supNameById[l.supplier_id]||'—'}</span></Td>
                  <Td><span style={{fontSize:12.5}}>{restNameById[l.restaurant_id]||'—'}</span></Td>
                  <Td><span style={{fontSize:12,color:C.mid}}>{l.producto_texto||'—'}</span></Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {shown.length>500 && <div style={{padding:'10px 16px',fontSize:11.5,color:C.dim}}>Mostrando los primeros 500 en pantalla; el CSV exporta los {shown.length} filtrados.</div>}
      </SectionCard>
    </div>
  );
}

/* ─── Tab CATEGORÍAS (CRUD) ─── */
function MkCategorias({categories, load, setFlash}) {
  const [edit, setEdit] = useState(null); // fila o {} para nueva

  const toggleActiva = async (c) => {
    const { error } = await db.from('marketplace_categories').update({activa:!c.activa}).eq('id',c.id);
    if (error) { setFlash({type:'error',text:error.message}); return; }
    load();
  };
  const remove = async (c) => {
    if (!window.confirm(`¿Eliminar la categoría “${c.nombre}”? Los productos que la usan quedan sin categoría.`)) return;
    const { error } = await db.from('marketplace_categories').delete().eq('id',c.id);
    if (error) { setFlash({type:'error',text:error.message}); return; }
    setFlash({type:'ok',text:'Categoría eliminada'}); load();
  };

  return (
    <div className="animate-in">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
        <span style={{fontSize:12,color:C.mid}}>{categories.length} categorías</span>
        <Btn size="sm" onClick={()=>setEdit({nombre:'',slug:'',orden:(categories.length+1)*1,activa:true,parent_slug:''})}>Nueva categoría</Btn>
      </div>
      <SectionCard>
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',minWidth:620}}>
            <thead><tr><Th style={{width:60,textAlign:'center'}}>Orden</Th><Th>Nombre</Th><Th>Slug</Th><Th>Padre</Th><Th style={{textAlign:'center'}}>Activa</Th><Th style={{textAlign:'right'}}>Acciones</Th></tr></thead>
            <tbody>
              {[...categories].sort((a,b)=>(a.orden||0)-(b.orden||0)).map(c=>(
                <tr key={c.id}>
                  <Td style={{textAlign:'center',color:C.mid}}>{c.orden}</Td>
                  <Td><span style={{fontWeight:600,color:C.ink}}>{c.nombre}</span></Td>
                  <Td><code style={{fontSize:12,color:C.mid}}>{c.slug}</code></Td>
                  <Td><span style={{fontSize:12,color:C.dim}}>{c.parent_slug||'—'}</span></Td>
                  <Td style={{textAlign:'center'}}><div style={{display:'inline-flex'}}><Toggle checked={c.activa} onChange={()=>toggleActiva(c)}/></div></Td>
                  <Td style={{textAlign:'right'}}>
                    <div style={{display:'inline-flex',gap:6}}>
                      <Btn variant="ghost" size="sm" onClick={()=>setEdit(c)}>Editar</Btn>
                      <Btn variant="danger" size="sm" onClick={()=>remove(c)}>Eliminar</Btn>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
      {edit && <MkCategoriaModal cat={edit} categories={categories} onClose={()=>setEdit(null)} onDone={()=>{setEdit(null);load();}} setFlash={setFlash}/>}
    </div>
  );
}

function MkCategoriaModal({cat, categories, onClose, onDone, setFlash}) {
  const esNueva = !cat.id;
  const [f, setF] = useState({nombre:cat.nombre||'', slug:cat.slug||'', orden:cat.orden??0, activa:cat.activa!==false, parent_slug:cat.parent_slug||''});
  const [busy, setBusy] = useState(false);
  const set = (k,v)=>setF(o=>({...o,[k]:v}));
  const slugify = s => String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40);
  const save = async () => {
    const nombre = f.nombre.trim();
    const slug = (f.slug.trim() || slugify(nombre));
    if (!nombre || !slug) { setFlash({type:'warn',text:'Nombre y slug obligatorios'}); return; }
    setBusy(true);
    const payload = {nombre, slug, orden:Number(f.orden)||0, activa:f.activa, parent_slug:f.parent_slug.trim()||null};
    const q = esNueva
      ? db.from('marketplace_categories').insert(payload)
      : db.from('marketplace_categories').update(payload).eq('id',cat.id);
    const { error } = await q;
    setBusy(false);
    if (error) { setFlash({type:'error',text:/duplicate|unique/i.test(error.message)?'Ese slug ya existe':error.message}); return; }
    setFlash({type:'ok',text:esNueva?'Categoría creada':'Categoría actualizada'}); onDone();
  };
  return (
    <Modal title={esNueva?'Nueva categoría':`Editar — ${cat.nombre}`} onClose={onClose} width={420}>
      <FormField label="Nombre *"><SInp value={f.nombre} onChange={v=>set('nombre',v)} placeholder="Ej. Bebidas"/></FormField>
      <FormField label="Slug *" hint={esNueva?'Se genera del nombre si lo dejás vacío. Minúsculas, sin espacios.':'Cambiarlo afecta a productos/proveedores que lo referencian.'}>
        <SInp value={f.slug} onChange={v=>set('slug',v)} placeholder="bebidas"/>
      </FormField>
      <div className="my-row-2" style={{gap:'0 16px'}}>
        <FormField label="Orden"><SInp type="number" value={f.orden} onChange={v=>set('orden',v)}/></FormField>
        <FormField label="Categoría padre (opcional)">
          <SSel value={f.parent_slug} onChange={v=>set('parent_slug',v)}>
            <option value="">— ninguna —</option>
            {categories.filter(c=>c.slug!==cat.slug).map(c=><option key={c.slug} value={c.slug}>{c.nombre}</option>)}
          </SSel>
        </FormField>
      </div>
      <label style={{display:'flex',alignItems:'center',gap:8,fontSize:12.5,color:C.ink,cursor:'pointer',margin:'2px 0 14px'}}>
        <Toggle checked={f.activa} onChange={v=>set('activa',v)}/> Activa (visible en el catálogo público)
      </label>
      <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn onClick={save} disabled={busy}>{busy?'Guardando…':(esNueva?'Crear':'Guardar')}</Btn>
      </div>
    </Modal>
  );
}

/* ─── Modal: cambiar plan / trial de un proveedor (vía RPC auditada) ─── */
// Único camino para cambiar el tier: superadmin_set_supplier_plan (mig 177),
// que hace upsert de la suscripción + refleja marketplace_suppliers.plan +
// registra el evento. Trial vacío = no toca el ciclo; con valor = (re)abre trial.
function MkSupplierPlanModal({sup, sub, plans, onClose, onDone, setFlash}) {
  const [slug, setSlug] = useState(sub?.plan_slug || sup.plan || (plans.find(p=>p.status==='active')||{}).slug || (plans[0]||{}).slug || 'basico');
  const [trialDays, setTrialDays] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const raw = String(trialDays).trim();
    let td = null;
    if (raw !== '') { td = parseInt(raw,10); if (isNaN(td) || td < 0) { setFlash({type:'warn',text:'Días de trial inválidos'}); return; } }
    if (!slug) { setFlash({type:'warn',text:'Elegí un plan'}); return; }
    setBusy(true);
    const { error } = await db.rpc('superadmin_set_supplier_plan', {p_supplier_id:sup.id, p_plan:slug, p_trial_days:td});
    setBusy(false);
    if (error) { setFlash({type:'error',text:error.message}); return; }
    setFlash({type:'ok',text:'Plan del proveedor actualizado'}); onDone();
  };
  return (
    <Modal title={`Plan — ${sup.nombre_comercial}`} onClose={onClose} width={440}>
      <div style={{fontSize:12.5,color:C.mid,marginBottom:14,lineHeight:1.5}}>
        Cambia el tier y, opcional, setea o extiende el trial. Queda registrado en la auditoría del marketplace.
      </div>
      {sub && <div style={{fontSize:12,color:C.dim,marginBottom:12}}>
        Suscripción actual: <b style={{color:C.mid}}>{(MKP_SUB_ESTADO[sub.status]||{}).label||sub.status}</b>
        {sub.trial_ends_at ? ` · trial hasta ${fmtDate(sub.trial_ends_at)}` : ''}
      </div>}
      <FormField label="Plan">
        <SSel value={slug} onChange={setSlug}>
          {plans.length===0 && <option value="">— sin planes (aplicá la mig 177) —</option>}
          {plans.map(p=><option key={p.slug} value={p.slug}>{p.name} · {fmtGuarani(p.price_gs)}{p.status!=='active'?` (${p.status})`:''}</option>)}
        </SSel>
      </FormField>
      <FormField label="Días de trial (opcional)" hint="Vacío = no toca el ciclo (si ya está activa, solo cambia el tier). Con valor = reinicia a trial por esos días.">
        <SInp type="number" value={trialDays} onChange={setTrialDays} placeholder="ej. 30"/>
      </FormField>
      <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:6}}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn onClick={save} disabled={busy}>{busy?'Guardando…':'Guardar'}</Btn>
      </div>
    </Modal>
  );
}

/* ─── Tab PLANES (proveedor) — CRUD de marketplace_supplier_plans (mig 177) ─── */
function MkPlanes({plans, load, setFlash}) {
  const [edit, setEdit] = useState(null); // fila existente o {} para nuevo
  return (
    <div className="animate-in">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
        <span style={{fontSize:12,color:C.mid}}>{plans.length} plan{plans.length===1?'':'es'} de proveedor</span>
        <Btn size="sm" onClick={()=>setEdit({})}>Nuevo plan</Btn>
      </div>
      <SectionCard>
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',minWidth:760}}>
            <thead><tr>
              <Th style={{width:56,textAlign:'center'}}>Orden</Th><Th>Plan</Th><Th>Precio</Th><Th style={{textAlign:'center'}}>Trial</Th><Th>Contacto lead</Th><Th style={{textAlign:'center'}}>Productos</Th><Th style={{textAlign:'center'}}>Estado</Th><Th style={{textAlign:'right'}}>Acciones</Th>
            </tr></thead>
            <tbody>
              {plans.length===0 && <tr><Td colSpan={8} style={{textAlign:'center',color:C.dim}}>Sin planes. Creá el primero (o aplicá la migración 177).</Td></tr>}
              {[...plans].sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)).map(p=>{
                const lim = p.limits||{};
                const cycle = p.billing_cycle==='annual'?'/año':p.billing_cycle==='free'?'':'/mes';
                const cap = v => v===-1 ? '∞' : fmtNum(v||0);
                return (
                  <tr key={p.id}>
                    <Td style={{textAlign:'center',color:C.mid}}>{p.sort_order}</Td>
                    <Td><span style={{fontWeight:600,color:C.ink}}>{p.name}</span><div><code style={{fontSize:11,color:C.dim}}>{p.slug}</code></div></Td>
                    <Td>{fmtGuarani(p.price_gs)}<span style={{fontSize:11,color:C.dim}}>{cycle}</span></Td>
                    <Td style={{textAlign:'center'}}>{p.trial_days} d</Td>
                    <Td><span style={{fontSize:12,color:C.mid}}>{lim.lead_contact||'—'}</span></Td>
                    <Td style={{textAlign:'center'}}>{cap(lim.max_products)}</Td>
                    <Td style={{textAlign:'center'}}><MkBadge map={MKP_PLAN_ESTADO} value={p.status}/></Td>
                    <Td style={{textAlign:'right'}}><Btn variant="ghost" size="sm" onClick={()=>setEdit(p)}>Editar</Btn></Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>
      {edit && <MkPlanModal plan={edit} onClose={()=>setEdit(null)} onDone={()=>{setEdit(null);load();}} setFlash={setFlash}/>}
    </div>
  );
}

function MkPlanModal({plan, onClose, onDone, setFlash}) {
  const esNueva = !plan.id;
  const lim0 = plan.limits || {};
  const [f, setF] = useState({
    name: plan.name||'', slug: plan.slug||'', price_gs: plan.price_gs??0,
    billing_cycle: plan.billing_cycle||'monthly', trial_days: plan.trial_days??30,
    grace_days: plan.grace_days??5,
    status: plan.status||'active', sort_order: plan.sort_order??0,
    features: Array.isArray(plan.features) ? plan.features.join('\n') : '',
    max_products: lim0.max_products??0, max_users: lim0.max_users??0, max_catalog_files: lim0.max_catalog_files??0,
    max_categorias: lim0.max_categorias??0, max_zonas: lim0.max_zonas??0, featured_slots: lim0.featured_slots??0,
    lead_contact: lim0.lead_contact||'oculto', lead_priority: !!lim0.lead_priority,
    analytics: lim0.analytics||'none', branding_banner: !!lim0.branding_banner,
  });
  const [busy, setBusy] = useState(false);
  const set = (k,v)=>setF(o=>({...o,[k]:v}));
  const slugify = s => String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40);
  const intOr = (v,d)=>{ const n=parseInt(v,10); return isNaN(n)?d:n; };
  const save = async () => {
    const name = f.name.trim();
    const slug = (f.slug.trim() || slugify(name));
    if (!name || !slug) { setFlash({type:'warn',text:'Nombre y slug obligatorios'}); return; }
    setBusy(true);
    const limits = {
      max_products: intOr(f.max_products,0), max_users: intOr(f.max_users,0), max_catalog_files: intOr(f.max_catalog_files,0),
      max_categorias: intOr(f.max_categorias,0), max_zonas: intOr(f.max_zonas,0), featured_slots: intOr(f.featured_slots,0),
      lead_contact: f.lead_contact, lead_priority: !!f.lead_priority, analytics: f.analytics, branding_banner: !!f.branding_banner,
    };
    const features = f.features.split('\n').map(x=>x.trim()).filter(Boolean);
    const payload = {
      name, slug, price_gs: intOr(f.price_gs,0), billing_cycle: f.billing_cycle,
      trial_days: intOr(f.trial_days,30), grace_days: intOr(f.grace_days,5),
      status: f.status, sort_order: intOr(f.sort_order,0), limits, features,
    };
    const run = pl => esNueva
      ? db.from('marketplace_supplier_plans').insert(pl)
      : db.from('marketplace_supplier_plans').update(pl).eq('id',plan.id);
    let { error } = await run(payload);
    // Deploy-safe: si la mig 199 todavía no se aplicó, `grace_days` no existe.
    // Se reintenta sin esa columna en vez de bloquear la edición del plan.
    if (error && /grace_days/.test(error.message||'')) {
      const { grace_days, ...legacy } = payload;
      ({ error } = await run(legacy));
    }
    setBusy(false);
    if (error) { setFlash({type:'error',text:/duplicate|unique/i.test(error.message)?'Ese slug ya existe':error.message}); return; }
    setFlash({type:'ok',text:esNueva?'Plan creado':'Plan actualizado'}); onDone();
  };
  const numField = (k,label) => <FormField label={label}><SInp type="number" value={f[k]} onChange={v=>set(k,v)}/></FormField>;
  return (
    <Modal title={esNueva?'Nuevo plan de proveedor':`Editar — ${plan.name}`} onClose={onClose} width={640}>
      <div className="my-row-2" style={{gap:'0 16px'}}>
        <FormField label="Nombre *"><SInp value={f.name} onChange={v=>set('name',v)} placeholder="Ej. Profesional"/></FormField>
        <FormField label="Slug *" hint={esNueva?'Se genera del nombre si lo dejás vacío.':'Cambiarlo puede romper suscripciones que lo referencian.'}><SInp value={f.slug} onChange={v=>set('slug',v)} placeholder="profesional"/></FormField>
        <FormField label="Precio (₲)"><MilesInput value={f.price_gs} onChange={v=>set('price_gs',v)}/></FormField>
        <FormField label="Ciclo de facturación">
          <SSel value={f.billing_cycle} onChange={v=>set('billing_cycle',v)}>
            <option value="monthly">Mensual</option><option value="annual">Anual</option><option value="free">Gratis</option>
          </SSel>
        </FormField>
        <FormField label="Días de trial"><SInp type="number" value={f.trial_days} onChange={v=>set('trial_days',v)}/></FormField>
        <FormField label="Días de gracia" hint="Tras vencer, cuántos días sigue operando antes de que se le pause la tienda.">
          <SInp type="number" value={f.grace_days} onChange={v=>set('grace_days',v)}/>
        </FormField>
        <FormField label="Orden"><SInp type="number" value={f.sort_order} onChange={v=>set('sort_order',v)}/></FormField>
        <FormField label="Estado (ciclo de vida)">
          <SSel value={f.status} onChange={v=>set('status',v)}>
            <option value="active">Activo</option><option value="inactive">Inactivo</option><option value="archived">Archivado</option>
          </SSel>
        </FormField>
      </div>

      <div style={{fontSize:12,fontWeight:700,color:C.ink,margin:'14px 0 8px'}}>Límites del plan <span style={{fontWeight:400,color:C.dim}}>(−1 = ilimitado)</span></div>
      <div className="my-row-3" style={{gap:'0 16px'}}>
        {numField('max_products','Máx. productos')}
        {numField('max_users','Máx. usuarios')}
        {numField('max_catalog_files','Máx. catálogos')}
        {numField('max_categorias','Máx. categorías')}
        {numField('max_zonas','Máx. zonas')}
        {numField('featured_slots','Espacios destacados')}
      </div>
      <div className="my-row-2" style={{gap:'0 16px'}}>
        <FormField label="Contacto de lead">
          <SSel value={f.lead_contact} onChange={v=>set('lead_contact',v)}>
            <option value="inmediato">Inmediato</option><option value="demorado">Demorado (24 h)</option><option value="oculto">Oculto</option>
          </SSel>
        </FormField>
        <FormField label="Analítica">
          <SSel value={f.analytics} onChange={v=>set('analytics',v)}>
            <option value="none">Ninguna</option><option value="basico">Básica</option><option value="completo">Completa</option>
          </SSel>
        </FormField>
      </div>
      <div style={{display:'flex',gap:'12px 24px',flexWrap:'wrap',margin:'6px 0 14px'}}>
        <label style={{display:'flex',alignItems:'center',gap:8,fontSize:12.5,color:C.ink,cursor:'pointer'}}><Toggle checked={f.lead_priority} onChange={v=>set('lead_priority',v)}/> Prioridad en leads</label>
        <label style={{display:'flex',alignItems:'center',gap:8,fontSize:12.5,color:C.ink,cursor:'pointer'}}><Toggle checked={f.branding_banner} onChange={v=>set('branding_banner',v)}/> Banner de marca</label>
      </div>
      <FormField label="Características (una por línea)"><STa value={f.features} onChange={v=>set('features',v)} rows={5} placeholder={'Hasta 50 productos\nContacto de leads inmediato\n…'}/></FormField>
      <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn onClick={save} disabled={busy}>{busy?'Guardando…':(esNueva?'Crear':'Guardar')}</Btn>
      </div>
    </Modal>
  );
}

/* ─── Tab FACTURACIÓN (proveedores) — mig 199 ───
   Hasta la 199 el marketplace no cobraba: el trial no vencía nunca y los
   proveedores no aparecían en ninguna métrica de ingresos (Facturación y
   Finanzas solo cuentan restaurantes). Esta pestaña es el otro lado del cron
   nocturno (`/api/cron/nightly`, paso `proveedores`): mirar quién vence,
   registrar el cobro y reactivar.
   Los totales salen de superadmin_supplier_billing_overview() — agregados
   SERVER-SIDE: sumar el MRR sobre un array con `.limit()` daría un número que
   empeora cuanto más crece el negocio (misma lección que la mig 197). */
const MKP_BILL_FILTERS = [
  ['todos',     'Todos'],
  ['por_vencer','Vencen en 7 días'],
  ['vencidos',  'Vencidos / en mora'],
  ['sin_sub',   'Sin suscripción'],
];

function MkFacturacion({setFlash}) {
  const [ov, setOv]           = useState(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);   // mig 199 sin aplicar
  const [filtro, setFiltro]   = useState('todos');
  const [search, setSearch]   = useState('');
  const [payFor, setPayFor]   = useState(null);

  const load = useCallback(async () => {
    if (!db) { setLoading(false); return; }
    const { data, error } = await db.rpc('superadmin_supplier_billing_overview');
    if (error) { setMissing(true); setLoading(false); return; }
    setMissing(false); setOv(data || null); setLoading(false);
  }, []);
  useEffect(()=>{ load(); }, [load]);

  if (loading) return <div style={{display:'flex',justifyContent:'center',alignItems:'center',height:160,gap:12}}><Spinner/><span style={{color:C.mid}}>Cargando facturación…</span></div>;
  if (missing) return (
    <MkEmpty text="Facturación de proveedores no disponible: falta aplicar la migración 199 en Supabase."/>
  );

  const rows = Array.isArray(ov?.rows) ? ov.rows : [];
  const byStatus = ov?.by_status || {};
  // Días hasta el vencimiento — calculado sobre la fecha que ya trae la RPC.
  const daysLeft = r => {
    if (!r.expires_on) return null;
    return Math.ceil((new Date(r.expires_on).getTime() - Date.now()) / 86400000);
  };

  const shown = rows.filter(r => {
    if (search) {
      const q = search.toLowerCase();
      if (!(r.nombre_comercial||'').toLowerCase().includes(q)) return false;
    }
    const d = daysLeft(r);
    if (filtro==='sin_sub')    return !r.status;
    if (filtro==='por_vencer') return !!r.status && d !== null && d >= 0 && d <= 7;
    if (filtro==='vencidos')   return !!r.status && ((d !== null && d < 0) || r.status==='past_due' || r.auto_paused);
    return true;
  });

  return (
    <div className="animate-in">
      <div className="sa-kpis" style={{marginBottom:18}}>
        <Kpi label="MRR activo" value={fmtGuarani(ov?.mrr_active||0)} sub={`${fmtNum(byStatus.active||0)} suscripciones al día`}/>
        <Kpi label="MRR potencial" value={fmtGuarani(ov?.mrr_potential||0)} sub="incluye trials y mora"/>
        <Kpi label="Cobrado este mes" value={fmtGuarani(ov?.collected_month||0)} sub={`${fmtGuarani(ov?.collected_total||0)} histórico`}/>
        <Kpi label="En prueba" value={fmtNum(byStatus.trial||0)} sub={`${fmtNum(byStatus.past_due||0)} en mora`} accent={(byStatus.past_due||0)>0?TINT.warnText:undefined}/>
        <Kpi label="Sin suscripción" value={fmtNum(ov?.no_subscription||0)} sub="asignales un plan"/>
      </div>

      <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:14,flexWrap:'wrap'}}>
        <SInp value={search} onChange={setSearch} placeholder="Buscar proveedor…" style={{width:240}}/>
        <SSel value={filtro} onChange={setFiltro} style={{width:200}}>
          {MKP_BILL_FILTERS.map(([k,l])=><option key={k} value={k}>{l}</option>)}
        </SSel>
        <span style={{fontSize:12,color:C.mid}}>{shown.length} de {rows.length}</span>
      </div>

      <SectionCard>
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',minWidth:900}}>
            <thead><tr>
              <Th>Proveedor</Th><Th>Plan</Th><Th>Suscripción</Th><Th>Vence</Th>
              <Th style={{textAlign:'right'}}>Mensual</Th><Th>Último pago</Th>
              <Th style={{textAlign:'right'}}>Cobrado</Th><Th style={{textAlign:'right'}}>Acciones</Th>
            </tr></thead>
            <tbody>
              {shown.length===0 && <tr><Td colSpan={8} style={{textAlign:'center',color:C.dim}}>Sin proveedores con ese filtro.</Td></tr>}
              {shown.map(r=>{
                const d = daysLeft(r);
                const vencido = d !== null && d < 0;
                return (
                  <tr key={r.supplier_id}>
                    <Td>
                      <span style={{fontWeight:600,color:C.ink}}>{r.nombre_comercial}</span>
                      {r.auto_paused && <div style={{fontSize:11,color:TINT.dangerText,fontWeight:600}}>Tienda pausada por impago</div>}
                      {!r.auto_paused && r.estado!=='activo' && <div style={{fontSize:11,color:C.dim}}>Tienda {r.estado}</div>}
                    </Td>
                    <Td>{r.plan_name || r.plan_slug || <span style={{color:C.dim}}>—</span>}</Td>
                    <Td>{r.status ? <MkBadge map={MKP_SUB_ESTADO} value={r.status}/> : <span style={{fontSize:11.5,color:C.dim}}>sin suscripción</span>}</Td>
                    <Td>
                      {r.expires_on
                        ? <span style={{fontSize:12,color:vencido?TINT.dangerText:(d<=7?TINT.warnText:C.mid),fontWeight:vencido||d<=7?700:400}}>
                            {fmtDate(r.expires_on)}
                            <div style={{fontSize:10.5,fontWeight:400}}>
                              {vencido ? `hace ${Math.abs(d)} d (gracia ${r.grace_days} d)` : `en ${d} d`}
                            </div>
                          </span>
                        : <span style={{color:C.dim}}>—</span>}
                    </Td>
                    <Td style={{textAlign:'right'}}>{r.status?fmtGuarani(r.monthly_amount||0):'—'}</Td>
                    <Td><span style={{fontSize:12,color:C.mid}}>{r.last_payment_at?fmtDate(r.last_payment_at):'nunca'}</span></Td>
                    <Td style={{textAlign:'right'}}>{fmtGuarani(r.paid_total||0)}</Td>
                    <Td style={{textAlign:'right'}}>
                      {r.status
                        ? <Btn variant={vencido?'success':'ghost'} size="sm" onClick={()=>setPayFor(r)}>Registrar pago</Btn>
                        : <span style={{fontSize:11,color:C.dim}}>Asignale un plan en Proveedores</span>}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {payFor && <MkSupplierPaymentModal row={payFor} onClose={()=>setPayFor(null)}
                   onDone={()=>{setPayFor(null);load();}} setFlash={setFlash}/>}
    </div>
  );
}

/* Registrar un cobro de proveedor. La RPC (mig 199) asienta el pago, extiende el
   período y reactiva la tienda si estaba auto-pausada por mora — todo atómico. */
function MkSupplierPaymentModal({row, onClose, onDone, setFlash}) {
  const [amount, setAmount] = useState(String(row.monthly_amount||''));
  const [months, setMonths] = useState('1');
  const [method, setMethod] = useState('transferencia');
  const [ref, setRef]       = useState('');
  const [notes, setNotes]   = useState('');
  const [busy, setBusy]     = useState(false);

  const save = async () => {
    const m = parseInt(months,10);
    if (isNaN(m) || m < 1 || m > 36) { setFlash({type:'warn',text:'Meses: entre 1 y 36'}); return; }
    const a = String(amount).replace(/\D/g,'');
    setBusy(true);
    const { data, error } = await db.rpc('superadmin_register_supplier_payment', {
      p_supplier_id: row.supplier_id,
      p_amount_gs:   a === '' ? null : Number(a),
      p_months:      m,
      p_method:      method,
      p_reference:   ref.trim() || null,
      p_notes:       notes.trim() || null,
    });
    setBusy(false);
    if (error) { setFlash({type:'error',text:error.message}); return; }
    setFlash({type:'ok',text: data?.reactivated
      ? `Pago registrado — la tienda de ${row.nombre_comercial} volvió a estar activa`
      : `Pago registrado — vence ${fmtDate(data?.period_end)}`});
    onDone();
  };

  return (
    <Modal title={`Registrar pago — ${row.nombre_comercial}`} onClose={onClose} width={460}>
      <div style={{fontSize:12.5,color:C.mid,lineHeight:1.5,marginBottom:14}}>
        El período nuevo arranca del vencimiento vigente si todavía no pasó, así no se
        pierde ni se regala tiempo pagado.
        {row.auto_paused && <b style={{color:C.ink}}> La tienda está pausada por impago: al registrar el pago se reactiva sola.</b>}
      </div>
      <div className="my-row-2" style={{gap:'0 16px'}}>
        <FormField label="Monto (₲)" hint="Vacío = la mensualidad del plan">
          <MilesInput value={amount} onChange={setAmount}/>
        </FormField>
        <FormField label="Meses que cubre"><SInp type="number" value={months} onChange={setMonths}/></FormField>
        <FormField label="Método">
          <SSel value={method} onChange={setMethod}>
            <option value="transferencia">Transferencia</option>
            <option value="efectivo">Efectivo</option>
            <option value="tarjeta">Tarjeta</option>
            <option value="qr">QR</option>
            <option value="manual">Manual</option>
            <option value="otro">Otro</option>
          </SSel>
        </FormField>
        <FormField label="Nº de comprobante"><SInp value={ref} onChange={setRef} placeholder="opcional"/></FormField>
      </div>
      <FormField label="Notas"><STa value={notes} onChange={setNotes} rows={2} placeholder="Opcional (no lo ve el proveedor)"/></FormField>
      <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:6}}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="success" onClick={save} disabled={busy}>{busy?'Registrando…':'Registrar pago'}</Btn>
      </div>
    </Modal>
  );
}

/* ─── Tab RECLAMOS ─── */
function MkReclamos({reports, reviews, supNameById, prodNameById, restNameById, onSuspend, load, setFlash}) {
  const [fEstado, setFEstado] = useState('abiertos');
  const [resolveModal, setResolveModal] = useState(null);

  const shown = reports.filter(r=>{
    if (fEstado==='abiertos') return ['abierto','en_revision'].includes(r.estado);
    if (fEstado==='all') return true;
    return r.estado===fEstado;
  });

  const setEstado = async (r, estado) => {
    const { error } = await db.from('marketplace_reports').update({estado}).eq('id',r.id);
    if (error) { setFlash({type:'error',text:error.message}); return; }
    load();
  };

  return (
    <div className="animate-in">
      <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:14,flexWrap:'wrap'}}>
        <SSel value={fEstado} onChange={setFEstado} style={{width:180}}>
          <option value="abiertos">Abiertos / en revisión</option>
          <option value="abierto">Abiertos</option>
          <option value="en_revision">En revisión</option>
          <option value="resuelto">Resueltos</option>
          <option value="desestimado">Desestimados</option>
          <option value="all">Todos</option>
        </SSel>
        <span style={{fontSize:12,color:C.mid}}>{shown.length} reclamo{shown.length===1?'':'s'}</span>
      </div>

      <SectionCard title="Reclamos" style={{marginBottom:20}}>
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',minWidth:820}}>
            <thead><tr><Th>Tipo</Th><Th>Proveedor</Th><Th>Producto</Th><Th>Detalle</Th><Th>Estado</Th><Th>Fecha</Th><Th style={{textAlign:'right'}}>Acciones</Th></tr></thead>
            <tbody>
              {shown.length===0 && <tr><Td style={{textAlign:'center',color:C.dim}} colSpan={7}>Sin reclamos.</Td></tr>}
              {shown.map(r=>(
                <tr key={r.id}>
                  <Td><span style={{fontWeight:600,color:C.ink}}>{MKP_REPORT_TIPO_LBL[r.tipo]||r.tipo}</span></Td>
                  <Td><span style={{fontSize:12.5}}>{r.target_supplier_id?(supNameById[r.target_supplier_id]||'—'):'—'}</span></Td>
                  <Td><span style={{fontSize:12,color:C.mid}}>{r.target_product_id?(prodNameById[r.target_product_id]||'—'):'—'}</span></Td>
                  <Td><span style={{fontSize:12,color:C.mid}}>{r.detalle?String(r.detalle).slice(0,60)+(r.detalle.length>60?'…':''):'—'}</span></Td>
                  <Td><MkBadge map={MKP_REPORT_ESTADO} value={r.estado}/></Td>
                  <Td><span style={{fontSize:12,color:C.mid}}>{fmtDate(r.created_at)}</span></Td>
                  <Td style={{textAlign:'right'}}>
                    <div style={{display:'inline-flex',gap:6,flexWrap:'wrap',justifyContent:'flex-end'}}>
                      {r.estado==='abierto' && <Btn variant="ghost" size="sm" onClick={()=>setEstado(r,'en_revision')}>Revisar</Btn>}
                      {['abierto','en_revision'].includes(r.estado) && <Btn variant="ghost" size="sm" onClick={()=>setResolveModal(r)}>Resolver</Btn>}
                      {r.target_supplier_id && <Btn variant="danger" size="sm" onClick={()=>onSuspend(r.target_supplier_id)}>Suspender prov.</Btn>}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="Reseñas privadas (solo lectura)">
        <div style={{padding:'8px 0'}}>
          {reviews.length===0 ? <MkEmpty text="Sin reseñas todavía."/> :
            reviews.map(rv=>(
              <div key={rv.id} style={{display:'flex',alignItems:'center',gap:12,padding:'10px 18px',borderTop:`1px solid ${C.border}`}}>
                <span style={{fontSize:13,fontWeight:700,color:C.ink,whiteSpace:'nowrap'}}>{'★'.repeat(rv.rating)}<span style={{color:C.border}}>{'★'.repeat(5-rv.rating)}</span></span>
                <span style={{flex:1,fontSize:12.5,color:C.mid}}>
                  <strong style={{color:C.ink}}>{supNameById[rv.supplier_id]||'Proveedor'}</strong>
                  {rv.comentario?` — ${rv.comentario}`:''}
                  <span style={{color:C.dim}}> · {restNameById[rv.restaurant_id]||'restaurante'}</span>
                </span>
                <span style={{fontSize:11.5,color:C.dim,whiteSpace:'nowrap'}}>{fmtDate(rv.created_at)}</span>
                <span title="Moderación pública: próximamente" style={{opacity:.4,cursor:'not-allowed',display:'inline-flex'}}><Toggle checked={rv.visible} onChange={()=>{}}/></span>
              </div>
            ))}
        </div>
      </SectionCard>

      {resolveModal && <MkResolveModal report={resolveModal} onClose={()=>setResolveModal(null)} onDone={()=>{setResolveModal(null);load();}} setFlash={setFlash}/>}
    </div>
  );
}

function MkResolveModal({report, onClose, onDone, setFlash}) {
  const [estado, setEstado] = useState('resuelto');
  const [resolucion, setResolucion] = useState(report.resolucion||'');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const { error } = await db.from('marketplace_reports').update({estado, resolucion:resolucion.trim()||null}).eq('id',report.id);
    setBusy(false);
    if (error) { setFlash({type:'error',text:error.message}); return; }
    setFlash({type:'ok',text:'Reclamo actualizado'}); onDone();
  };
  return (
    <Modal title="Resolver reclamo" onClose={onClose} width={440}>
      <FormField label="Resultado">
        <SSel value={estado} onChange={setEstado}>
          <option value="resuelto">Resuelto</option>
          <option value="desestimado">Desestimado</option>
          <option value="en_revision">En revisión</option>
        </SSel>
      </FormField>
      <FormField label="Resolución / nota">
        <STa value={resolucion} onChange={setResolucion} rows={3} placeholder="Qué se resolvió y cómo…"/>
      </FormField>
      <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:6}}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn onClick={save} disabled={busy}>{busy?'Guardando…':'Guardar'}</Btn>
      </div>
    </Modal>
  );
}

function PageProveedores({restaurants, setFlash}) {
  const [tab, setTab] = useState('resumen');
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [apps, setApps] = useState([]);
  const [products, setProducts] = useState([]);
  const [leads, setLeads] = useState([]);
  const [categories, setCategories] = useState([]);
  const [reports, setReports] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [events, setEvents] = useState([]);
  const [supPlans, setSupPlans] = useState([]);
  const [supSubs, setSupSubs] = useState([]);
  const [prodFilterSup, setProdFilterSup] = useState(null);

  const load = useCallback(async () => {
    if (!db) { setLoading(false); return; }
    const [st, su, ap, pr, le, ca, re, rv, ev, sp, ss] = await Promise.all([
      db.rpc('superadmin_marketplace_stats').then(r=>r.error?{data:null}:r),
      db.from('marketplace_suppliers').select('*').order('created_at',{ascending:false}).then(r=>r.error?{data:[]}:r),
      db.from('marketplace_applications').select('*').order('created_at',{ascending:false}).then(r=>r.error?{data:[]}:r),
      db.from('marketplace_products').select('*').order('created_at',{ascending:false}).limit(3000).then(r=>r.error?{data:[]}:r),
      db.from('marketplace_leads').select('*').order('created_at',{ascending:false}).limit(5000).then(r=>r.error?{data:[]}:r),
      db.from('marketplace_categories').select('*').order('orden',{ascending:true}).then(r=>r.error?{data:[]}:r),
      db.from('marketplace_reports').select('*').order('created_at',{ascending:false}).limit(2000).then(r=>r.error?{data:[]}:r),
      db.from('marketplace_reviews').select('*').order('created_at',{ascending:false}).limit(2000).then(r=>r.error?{data:[]}:r),
      db.from('marketplace_events').select('*').order('created_at',{ascending:false}).limit(50).then(r=>r.error?{data:[]}:r),
      db.from('marketplace_supplier_plans').select('*').order('sort_order',{ascending:true}).then(r=>r.error?{data:[]}:r),
      db.from('marketplace_supplier_subscriptions').select('*').then(r=>r.error?{data:[]}:r),
    ]);
    setStats(st.data||null); setSuppliers(su.data||[]); setApps(ap.data||[]); setProducts(pr.data||[]);
    setLeads(le.data||[]); setCategories(ca.data||[]); setReports(re.data||[]); setReviews(rv.data||[]); setEvents(ev.data||[]);
    setSupPlans(sp.data||[]); setSupSubs(ss.data||[]);
    setLoading(false);
  }, []);
  useEffect(()=>{ load(); if(!db) return;
    const id = setInterval(()=>{ if(!_shouldPause()) load(); }, 45000);
    return ()=>clearInterval(id);
  }, [load]);

  // Mapas de nombres (superadmin ve todo; restaurants viene por prop).
  const supNameById = {}; suppliers.forEach(s=>{ supNameById[s.id]=s.nombre_comercial; });
  const prodNameById = {}; products.forEach(p=>{ prodNameById[p.id]=p.nombre; });
  const restNameById = {}; (restaurants||[]).forEach(r=>{ restNameById[r.id]=r.name; });

  // Conteos por proveedor.
  const prodCountBySup = {}; products.forEach(p=>{ prodCountBySup[p.supplier_id]=(prodCountBySup[p.supplier_id]||0)+1; });
  const leadCountBySup = {}; leads.forEach(l=>{ leadCountBySup[l.supplier_id]=(leadCountBySup[l.supplier_id]||0)+1; });
  const subBySupplier = {}; supSubs.forEach(x=>{ subBySupplier[x.supplier_id]=x; });

  // Reportes indexados por producto y por proveedor.
  const reportsByProduct = {}, reportsBySupplier = {};
  reports.forEach(r=>{
    if (r.target_product_id) (reportsByProduct[r.target_product_id]=reportsByProduct[r.target_product_id]||[]).push(r);
    else if (r.target_supplier_id) (reportsBySupplier[r.target_supplier_id]=reportsBySupplier[r.target_supplier_id]||[]).push(r);
  });

  const pendientes = apps.filter(a=>a.estado==='pendiente').length;
  const reclamosAbiertos = reports.filter(r=>['abierto','en_revision'].includes(r.estado)).length;

  const gotoProducts = (supId) => { setProdFilterSup(supId); setTab('productos'); };
  const suspendFromReport = async (supId) => {
    const { error } = await db.rpc('superadmin_set_supplier_estado', {p_supplier_id:supId, p_estado:'suspendido'});
    if (error) { setFlash({type:'error',text:error.message}); return; }
    setFlash({type:'ok',text:'Proveedor suspendido'}); load();
  };

  const TABS = [
    {id:'resumen', label:'Resumen'},
    {id:'solicitudes', label:'Solicitudes', badge:pendientes},
    {id:'proveedores', label:'Proveedores'},
    {id:'productos', label:'Productos'},
    {id:'leads', label:'Leads'},
    {id:'categorias', label:'Categorías'},
    {id:'planes', label:'Planes'},
    {id:'facturacion', label:'Facturación'},
    {id:'reclamos', label:'Reclamos', badge:reclamosAbiertos},
  ];

  if (loading) return <div style={{display:'flex',justifyContent:'center',alignItems:'center',height:200,gap:14}}><Spinner/><span style={{color:C.mid}}>Cargando marketplace…</span></div>;

  return (
    <div>
      <MkTabBar tabs={TABS} active={tab} onSelect={setTab}/>
      {tab==='resumen'     && <MkResumen stats={stats} events={events} supNameById={supNameById} restNameById={restNameById}/>}
      {tab==='solicitudes' && <MkSolicitudes apps={apps} load={load} setFlash={setFlash}/>}
      {tab==='proveedores' && <MkProveedores suppliers={suppliers} prodCountBySup={prodCountBySup} leadCountBySup={leadCountBySup} categories={categories} supPlans={supPlans} subBySupplier={subBySupplier} load={load} setFlash={setFlash} gotoProducts={gotoProducts}/>}
      {tab==='productos'   && <MkProductos products={products} supNameById={supNameById} categories={categories} reportsByProduct={reportsByProduct} reportsBySupplier={reportsBySupplier} filterSupplier={prodFilterSup} setFilterSupplier={setProdFilterSup} load={load} setFlash={setFlash}/>}
      {tab==='leads'       && <MkLeads leads={leads} supNameById={supNameById} restNameById={restNameById}/>}
      {tab==='categorias'  && <MkCategorias categories={categories} load={load} setFlash={setFlash}/>}
      {tab==='planes'      && <MkPlanes plans={supPlans} load={load} setFlash={setFlash}/>}
      {tab==='facturacion' && <MkFacturacion setFlash={setFlash}/>}
      {tab==='reclamos'    && <MkReclamos reports={reports} reviews={reviews} supNameById={supNameById} prodNameById={prodNameById} restNameById={restNameById} onSuspend={suspendFromReport} load={load} setFlash={setFlash}/>}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   MÓDULO PROSPECCIÓN — CRM outbound de restaurantes + proveedores a contactar.
   El equipo de Mythos carga prospectos, los ubica en un mapa (Leaflet + tiles
   Carto, gratis, sin API key), clasifica por ciudad/zona/estado y registra la
   bitácora de contacto. Cuando un prospecto se gana, se enlaza al restaurante
   real (converted_restaurant_id) y queda como "Cliente activo". Tabla: prospects
   (mig 174, SOLO-superadmin). NO confundir con los leads INBOUND del Sitio web.
   ════════════════════════════════════════════════════════════════════════════ */
const PROSPECT_ORDER = ['nuevo','contactado','en_conversacion','negociacion','activo','descartado'];
// pin = color fijo del marker (hex, válido en ambos temas). color/bg del badge:
// TINT.* son theme-adaptive; 'nuevo' usa C.mid como el resto de badges neutros.
const PROSPECT_ESTADO = {
  nuevo:           {label:'Nuevo',           color:C.mid,           bg:'var(--bg-subtle)', pin:'#9CA3AF'},
  contactado:      {label:'Contactado',      color:TINT.infoText,   bg:TINT.infoBg,        pin:'#3B82F6'},
  en_conversacion: {label:'En conversación', color:TINT.warnText,   bg:TINT.warnBg,        pin:'#F59E0B'},
  negociacion:     {label:'Negociación',     color:TINT.purpleText, bg:TINT.purpleBg,      pin:'#A855F7'},
  activo:          {label:'Cliente activo',  color:TINT.okText,     bg:TINT.okBg,          pin:'#22C55E'},
  descartado:      {label:'Descartado',      color:TINT.dangerText, bg:TINT.dangerBg,      pin:'#EF4444'},
};

// ── Helpers de mapa (Leaflet global window.L; tiles Carto con fallback OSM) ──
const PROS_CARTO_LIGHT = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
const PROS_CARTO_DARK  = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const _prosDark = () => {
  try { if (window.MythosTheme && window.MythosTheme.get) return window.MythosTheme.get() === 'dark'; } catch(_) {}
  return document.documentElement.getAttribute('data-theme') === 'dark';
};
function _prosBaseTiles(map, dark) {
  const L = window.L;
  const base = L.tileLayer(dark ? PROS_CARTO_DARK : PROS_CARTO_LIGHT, {
    subdomains:'abcd', maxZoom:20, detectRetina:true, attribution:'© OpenStreetMap · © CARTO',
  });
  let loaded = false, errs = 0;
  base.on('load', () => { loaded = true; });
  base.on('tileerror', () => {
    if (!loaded && ++errs >= 3) {
      try { base.off(); map.removeLayer(base); } catch(_) {}
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19}).addTo(map);
    }
  });
  return base.addTo(map);
}
const _prosPinSvg = (dark) => {
  const body = dark ? '#FFFFFF' : '#111111', hole = dark ? '#111111' : '#FFFFFF';
  return '<svg width="30" height="40" viewBox="0 0 30 40" fill="none" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M15 0C6.7 0 0 6.7 0 15c0 10.5 13.2 23.4 13.8 24a1.7 1.7 0 0 0 2.4 0C16.8 38.4 30 25.5 30 15 30 6.7 23.3 0 15 0z" fill="' + body + '"/>'
    + '<circle cx="15" cy="15" r="5.5" fill="' + hole + '"/></svg>';
};
function _prosEnsurePinCss() {
  if (typeof document === 'undefined' || document.getElementById('mythos-pros-css')) return;
  const s = document.createElement('style');
  s.id = 'mythos-pros-css';
  s.textContent =
    '.mythos-cpin{position:absolute;left:50%;top:50%;z-index:600;pointer-events:none;transform:translate(-50%,-100%);transition:transform .18s cubic-bezier(.2,.8,.3,1)}'
    + '.mythos-cpin.lift{transform:translate(-50%,-100%) translateY(-14px)}'
    + '.mythos-cpin svg{display:block;filter:drop-shadow(0 4px 6px rgba(0,0,0,.35))}'
    + '.mythos-cpin-sh{position:absolute;left:50%;top:50%;width:16px;height:6px;border-radius:50%;background:rgba(0,0,0,.45);transform:translate(-50%,-50%);pointer-events:none;z-index:599;transition:all .18s cubic-bezier(.2,.8,.3,1);filter:blur(1.5px)}'
    + '.mythos-cpin-sh.lift{width:9px;height:5px;opacity:.55}'
    + '.mythos-pros-marker{background:transparent;border:none}';
  document.head.appendChild(s);
}
const _prosMarkerIcon = (statusKey) => {
  const color = (PROSPECT_ESTADO[statusKey] || {}).pin || '#9CA3AF';
  const html = '<svg width="28" height="38" viewBox="0 0 30 40" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 2px 3px rgba(0,0,0,.4))">'
    + '<path d="M15 0C6.7 0 0 6.7 0 15c0 10.5 13.2 23.4 13.8 24a1.7 1.7 0 0 0 2.4 0C16.8 38.4 30 25.5 30 15 30 6.7 23.3 0 15 0z" fill="' + color + '"/>'
    + '<circle cx="15" cy="15" r="5.2" fill="#fff"/></svg>';
  return window.L.divIcon({ html, className:'mythos-pros-marker', iconSize:[28,38], iconAnchor:[14,38], tooltipAnchor:[0,-30] });
};
const _prosCoord = (r) => {
  const la = Number(r.lat), ln = Number(r.lng);
  return (Number.isFinite(la) && Number.isFinite(ln) && (la !== 0 || ln !== 0)) ? [la, ln] : null;
};
const _prosEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const _prosEmptyNull = (v) => { const s = (v == null ? '' : String(v)).trim(); return s ? s : null; };
const _prosFollowup = (d) => {
  if (!d) return '—';
  try { const t = new Date(d + 'T00:00:00'); const today = new Date(); today.setHours(0,0,0,0); return t < today ? `${d} · vencido` : d; }
  catch(_) { return d; }
};

/* ── Mapa con PIN FIJO al centro (arrastrar = mover el punto). Para el modal. ── */
function ProsCenterMap({ initial, onPick, controlRef, height = 240 }) {
  const elRef = useRef(null), pinRef = useRef(null), shRef = useRef(null);
  const readyRef = useRef(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!window.L || !elRef.current) { setFailed(true); return; }
    _prosEnsurePinCss();
    const L = window.L;
    const hasInit = initial && Number.isFinite(initial.lat) && Number.isFinite(initial.lng);
    const c = { lat: hasInit ? initial.lat : -25.2867, lng: hasInit ? initial.lng : -57.6470 };
    let dark = _prosDark();
    const map = L.map(elRef.current, { zoomControl:true, attributionControl:false }).setView([c.lat, c.lng], hasInit ? 16 : 12);
    let base = _prosBaseTiles(map, dark);
    if (pinRef.current) pinRef.current.innerHTML = _prosPinSvg(dark);
    const lift = (on) => {
      if (pinRef.current) pinRef.current.classList.toggle('lift', on);
      if (shRef.current)  shRef.current.classList.toggle('lift', on);
    };
    map.on('movestart', () => lift(true));
    // El moveend inicial (por setView) NO emite: solo la interacción real del usuario.
    map.on('moveend', () => { lift(false); if (!readyRef.current) return; const p = map.getCenter(); onPick(p.lat, p.lng); });
    if (controlRef) controlRef.current = {
      moveTo: (lat, lng) => {
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        readyRef.current = true;
        map.setView([lat, lng], Math.max(map.getZoom(), 16), { animate:true });
        onPick(lat, lng);
      }
    };
    const off = (e) => {
      dark = e.detail.mode === 'dark';
      try { map.removeLayer(base); } catch(_) {}
      base = _prosBaseTiles(map, dark);
      if (pinRef.current) pinRef.current.innerHTML = _prosPinSvg(dark);
    };
    document.addEventListener('mythos:themechange', off);
    const t1 = setTimeout(() => { try { map.invalidateSize({pan:false}); } catch(_) {} }, 150);
    const t2 = setTimeout(() => { readyRef.current = true; }, 400);
    return () => { clearTimeout(t1); clearTimeout(t2); document.removeEventListener('mythos:themechange', off); try { map.remove(); } catch(_) {} if (controlRef) controlRef.current = null; };
  }, []);
  if (failed) return <div style={{padding:'22px 16px',textAlign:'center',color:C.dim,fontSize:12.5,border:`1px dashed ${C.border}`,borderRadius:12,marginBottom:8}}>El mapa no cargó (Leaflet no disponible). Podés registrar el prospecto igual, sin ubicación.</div>;
  return (
    <div style={{position:'relative',width:'100%',height,borderRadius:14,overflow:'hidden',border:`1px solid ${C.border}`,marginBottom:8,background:C.bg}}>
      <div ref={elRef} style={{position:'absolute',inset:0}}/>
      <div ref={shRef} className="mythos-cpin-sh"/>
      <div ref={pinRef} className="mythos-cpin"/>
    </div>
  );
}

/* ── Mapa overview: TODOS los prospectos como markers de color por estado. ── */
function ProspectOverviewMap({ rows, onSelect, height = 460 }) {
  const elRef = useRef(null), mapRef = useRef(null), layerRef = useRef(null), baseRef = useRef(null), sigRef = useRef('');
  const onSelRef = useRef(onSelect); onSelRef.current = onSelect;
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const rebuild = () => {
    const map = mapRef.current, layer = layerRef.current, L = window.L;
    if (!map || !layer || !L) return;
    const items = [], sigParts = [];
    rowsRef.current.forEach(r => {
      const c = _prosCoord(r); if (!c) return;
      items.push([r, c]);
      sigParts.push(`${r.id}:${r.status}:${c[0].toFixed(5)}:${c[1].toFixed(5)}`);
    });
    const sig = sigParts.join('|');
    if (sig === sigRef.current) return;   // sin cambios reales → no reconstruir (evita re-fit en cada render)
    sigRef.current = sig;
    layer.clearLayers();
    const pts = [];
    items.forEach(([r, c]) => {
      const m = L.marker(c, { icon: _prosMarkerIcon(r.status) });
      m.on('click', () => onSelRef.current && onSelRef.current(r));
      const est = (PROSPECT_ESTADO[r.status] || {}).label || r.status;
      m.bindTooltip(`<strong>${_prosEsc(r.name)}</strong><br>${_prosEsc(est)}${r.city ? ' · ' + _prosEsc(r.city) : ''}`, {direction:'top'});
      m.addTo(layer); pts.push(c);
    });
    if (pts.length) { try { pts.length === 1 ? map.setView(pts[0], 15) : map.fitBounds(pts, {padding:[40,40], maxZoom:15}); } catch(_) {} }
  };
  useEffect(() => {
    if (!window.L || !elRef.current) return;
    const L = window.L;
    let dark = _prosDark();
    const map = L.map(elRef.current, { zoomControl:true, attributionControl:false }).setView([-25.2867, -57.6470], 12);
    mapRef.current = map; baseRef.current = _prosBaseTiles(map, dark); layerRef.current = L.layerGroup().addTo(map);
    sigRef.current = '';
    const off = (e) => { dark = e.detail.mode === 'dark'; try { map.removeLayer(baseRef.current); } catch(_) {} baseRef.current = _prosBaseTiles(map, dark); };
    document.addEventListener('mythos:themechange', off);
    const t = setTimeout(() => { try { map.invalidateSize(); } catch(_) {} sigRef.current = ''; rebuild(); }, 150);
    return () => { clearTimeout(t); document.removeEventListener('mythos:themechange', off); try { map.remove(); } catch(_) {} mapRef.current = null; };
  }, []);
  useEffect(() => { rebuild(); });   // cada render; la guarda de firma evita trabajo redundante
  if (typeof window !== 'undefined' && !window.L) {
    return <div style={{height,display:'flex',alignItems:'center',justifyContent:'center',border:`1px dashed ${C.border}`,borderRadius:14,color:C.dim,fontSize:13,textAlign:'center',padding:16}}>El mapa no cargó (Leaflet no disponible). Usá la vista Lista.</div>;
  }
  return <div ref={elRef} style={{height,borderRadius:14,overflow:'hidden',border:`1px solid ${C.border}`}}/>;
}

/* ── Vista MAPA (overview + leyenda + conteo sin ubicación) ── */
function ProspectMapView({ rows, onSelect }) {
  const withGeo = rows.filter(_prosCoord);
  return (
    <div>
      <ProspectOverviewMap rows={withGeo} onSelect={onSelect}/>
      <div style={{display:'flex',gap:14,flexWrap:'wrap',marginTop:12,alignItems:'center'}}>
        {PROSPECT_ORDER.map(s => (
          <span key={s} style={{display:'inline-flex',alignItems:'center',gap:6,fontSize:12,color:C.mid}}>
            <span style={{width:11,height:11,borderRadius:'50%',background:PROSPECT_ESTADO[s].pin,display:'inline-block'}}/>{PROSPECT_ESTADO[s].label}
          </span>
        ))}
      </div>
      {rows.length > withGeo.length && <div style={{fontSize:12,color:C.dim,marginTop:8}}>{rows.length - withGeo.length} sin ubicación (no aparecen en el mapa — editalos para marcar su pin).</div>}
      {withGeo.length === 0 && <div style={{fontSize:13,color:C.dim,marginTop:10,textAlign:'center',padding:16}}>Ningún prospecto con ubicación todavía. Tocá “+ Nuevo” y marcá su punto en el mapa.</div>}
    </div>
  );
}

/* ── Vista LISTA (tabla filtrable) ── */
function ProspectListView({ rows, restNameById, onSelect }) {
  if (!rows.length) return <SectionCard><MkEmpty text="Sin prospectos para este filtro."/></SectionCard>;
  return (
    <SectionCard>
      <div className="tbl-wrap">
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead><tr>
            <Th>Nombre</Th><Th>Ciudad / Zona</Th><Th>Contacto</Th><Th>Estado</Th><Th>Últ. contacto</Th><Th>Próx. seguim.</Th><Th style={{textAlign:'right'}}>Acción</Th>
          </tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} style={{cursor:'pointer'}} onClick={()=>onSelect(r)}>
                <Td>
                  <div style={{fontWeight:600,color:C.ink}}>{r.name}</div>
                  {r.owner_name && <div style={{fontSize:11,color:C.dim}}>{r.owner_name}</div>}
                </Td>
                <Td>{r.city || '—'}{r.zone ? <span style={{color:C.dim}}> · {r.zone}</span> : ''}</Td>
                <Td style={{fontSize:12,color:C.mid}}>{r.contact_phone || r.contact_email || '—'}</Td>
                <Td>
                  <MkBadge map={PROSPECT_ESTADO} value={r.status || 'nuevo'}/>
                  {r.status === 'activo' && r.converted_restaurant_id && restNameById[r.converted_restaurant_id] &&
                    <div style={{fontSize:10.5,color:C.green,marginTop:3}}>→ {restNameById[r.converted_restaurant_id]}</div>}
                </Td>
                <Td style={{fontSize:12,color:C.mid}}>{r.last_contact_at || '—'}</Td>
                <Td style={{fontSize:12,color:C.mid}}>{_prosFollowup(r.next_followup_at)}</Td>
                <Td style={{textAlign:'right'}}><Btn variant="ghost" size="sm" onClick={(e)=>{e.stopPropagation();onSelect(r);}}>Editar</Btn></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

/* ── Modal crear/editar prospecto (datos + ubicación en mapa + bitácora) ── */
function ProspectModal({ row, restaurants, onClose, onDone, setFlash }) {
  const isNew = !row.id;
  const [f, setF] = useState({
    kind: row.kind || 'restaurant', name: row.name || '', owner_name: row.owner_name || '',
    contact_phone: row.contact_phone || '', contact_email: row.contact_email || '',
    city: row.city || '', zone: row.zone || '', address: row.address || '',
    lat: (row.lat != null) ? Number(row.lat) : null, lng: (row.lng != null) ? Number(row.lng) : null,
    status: row.status || 'nuevo', notes: row.notes || '',
    last_contact_at: row.last_contact_at || '', next_followup_at: row.next_followup_at || '',
    discard_reason: row.discard_reason || '', converted_restaurant_id: row.converted_restaurant_id || '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(o => ({...o, [k]: v}));
  const mapCtrl = useRef(null);
  const _ic0 = _prosCoord(row);   // rechaza null y (0,0): evita centrar el pin en el Atlántico
  const initialCoordRef = useRef(_ic0 ? {lat:_ic0[0], lng:_ic0[1]} : null);

  // Buscador de direcciones — Nominatim/OSM (sesgo a Paraguay), sin API key.
  const [q, setQ] = useState(''); const [res, setRes] = useState([]); const [searching, setSearching] = useState(false);
  const timer = useRef(null);
  const doSearch = (val) => {
    setQ(val); clearTimeout(timer.current);
    if (!val.trim()) { setRes([]); return; }
    timer.current = setTimeout(() => {
      setSearching(true);
      fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(val)}&format=json&limit=6&accept-language=es&addressdetails=1&countrycodes=py`)
        .then(r => r.json())
        .then(d => {
          setRes((Array.isArray(d) ? d : []).map(x => ({
            main: x.display_name.split(',').slice(0,2).join(',').trim(),
            secondary: x.display_name.split(',').slice(2,4).join(',').trim(),
            lat: parseFloat(x.lat), lng: parseFloat(x.lon),
          })));
          setSearching(false);
        })
        .catch(() => { setRes([]); setSearching(false); });
    }, 450);
  };
  const pickAddr = (item) => {
    if (mapCtrl.current) mapCtrl.current.moveTo(item.lat, item.lng);
    setF(o => ({...o, lat:item.lat, lng:item.lng, address: o.address || item.main}));
    setRes([]); setQ(item.main);
  };
  const useMyLoc = () => {
    if (!navigator.geolocation) { setFlash({type:'warn', text:'Tu navegador no permite ubicación automática'}); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { const la = p.coords.latitude, ln = p.coords.longitude; if (mapCtrl.current) mapCtrl.current.moveTo(la, ln); setF(o => ({...o, lat:la, lng:ln})); },
      () => setFlash({type:'warn', text:'No pudimos acceder a tu ubicación'}),
      { timeout:8000, enableHighAccuracy:true }
    );
  };

  const save = async () => {
    if (!f.name.trim()) { setFlash({type:'warn', text:'El nombre es obligatorio'}); return; }
    if (!db) { setFlash({type:'error', text:'Sin conexión a Supabase'}); return; }
    setBusy(true);
    const fc = _prosCoord(f);   // [lat,lng] o null (null-safe: null/'' y (0,0) → sin ubicación)
    const payload = {
      kind: f.kind, name: f.name.trim(), owner_name: _prosEmptyNull(f.owner_name),
      contact_phone: _prosEmptyNull(f.contact_phone), contact_email: _prosEmptyNull(f.contact_email),
      city: _prosEmptyNull(f.city), zone: _prosEmptyNull(f.zone), address: _prosEmptyNull(f.address),
      lat: fc ? fc[0] : null,
      lng: fc ? fc[1] : null,
      status: f.status, notes: _prosEmptyNull(f.notes),
      last_contact_at: f.last_contact_at || null, next_followup_at: f.next_followup_at || null,
      discard_reason: f.status === 'descartado' ? _prosEmptyNull(f.discard_reason) : null,
      converted_restaurant_id: (f.status === 'activo' && f.converted_restaurant_id) ? f.converted_restaurant_id : null,
    };
    const { error } = isNew
      ? await db.from('prospects').insert(payload)
      : await db.from('prospects').update(payload).eq('id', row.id);
    setBusy(false);
    if (error) { setFlash({type:'error', text:error.message}); return; }
    setFlash({type:'ok', text: isNew ? 'Prospecto creado' : 'Prospecto actualizado'}); onDone();
  };
  const del = async () => {
    if (isNew || !db) return;
    if (!window.confirm('¿Eliminar este prospecto? Esta acción no se puede deshacer.')) return;
    setBusy(true);
    const { error } = await db.from('prospects').delete().eq('id', row.id);
    setBusy(false);
    if (error) { setFlash({type:'error', text:error.message}); return; }
    setFlash({type:'ok', text:'Prospecto eliminado'}); onDone();
  };

  const _fc = _prosCoord(f);
  const hasCoord = !!_fc;
  const coordTxt = hasCoord ? `${_fc[0].toFixed(5)}, ${_fc[1].toFixed(5)}` : 'sin ubicación';

  return (
    <Modal title={isNew ? `Nuevo ${f.kind === 'restaurant' ? 'restaurante' : 'proveedor'}` : f.name} onClose={onClose} width={600}>
      <div className="my-row-2" style={{gap:12}}>
        <FormField label="Nombre *" col="1 / -1"><SInp value={f.name} onChange={v=>set('name',v)} placeholder={f.kind === 'restaurant' ? 'Ej: Pizzería Napoli' : 'Ej: Distribuidora XYZ'}/></FormField>
        <FormField label="Tipo"><SSel value={f.kind} onChange={v=>set('kind',v)}><option value="restaurant">Restaurante</option><option value="supplier">Proveedor</option></SSel></FormField>
        <FormField label="Estado"><SSel value={f.status} onChange={v=>set('status',v)}>{PROSPECT_ORDER.map(s=><option key={s} value={s}>{PROSPECT_ESTADO[s].label}</option>)}</SSel></FormField>
        <FormField label="Contacto (persona)"><SInp value={f.owner_name} onChange={v=>set('owner_name',v)} placeholder="Dueño / encargado"/></FormField>
        <FormField label="Teléfono / WhatsApp"><SInp value={f.contact_phone} onChange={v=>set('contact_phone',v)} placeholder="09xx xxx xxx"/></FormField>
        <FormField label="Email" col="1 / -1"><SInp type="email" value={f.contact_email} onChange={v=>set('contact_email',v)}/></FormField>
        <FormField label="Ciudad">
          <input value={f.city} onChange={e=>set('city',e.target.value)} placeholder="Asunción" list="pros-cities" style={sField}/>
        </FormField>
        <FormField label="Zona / Barrio"><SInp value={f.zone} onChange={v=>set('zone',v)} placeholder="Villa Morra"/></FormField>
      </div>
      <datalist id="pros-cities">{CITIES_PY.map(c=><option key={c} value={c}/>)}</datalist>

      <div style={{marginTop:4,marginBottom:6,fontSize:11,color:C.mid,fontWeight:600,textTransform:'uppercase',letterSpacing:.4}}>Ubicación en el mapa</div>
      <div style={{position:'relative',marginBottom:8}}>
        <input value={q} onChange={e=>doSearch(e.target.value)} placeholder="Buscar dirección o lugar…" style={sField}/>
        {(res.length > 0 || searching) && (
          <div style={{position:'absolute',top:'100%',left:0,right:0,zIndex:20,background:C.surface,border:`1px solid ${C.border}`,borderRadius:9,marginTop:4,boxShadow:'0 8px 24px rgba(0,0,0,.18)',overflow:'hidden',maxHeight:220,overflowY:'auto'}}>
            {searching && <div style={{padding:'10px 12px',fontSize:12,color:C.dim}}>Buscando…</div>}
            {res.map((item,i) => (
              <div key={i} onClick={()=>pickAddr(item)} style={{padding:'9px 12px',cursor:'pointer',borderTop:i?`1px solid ${C.border}`:'none'}}
                   onMouseEnter={e=>e.currentTarget.style.background=C.bg} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                <div style={{fontSize:13,color:C.ink,fontWeight:600}}>{item.main}</div>
                {item.secondary && <div style={{fontSize:11,color:C.dim}}>{item.secondary}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:8,flexWrap:'wrap'}}>
        <Btn variant="ghost" size="sm" onClick={useMyLoc}>📍 Mi ubicación</Btn>
        <span style={{fontSize:12,color:C.mid}}>Arrastrá el mapa: el pin marca el punto · <strong style={{color:hasCoord?C.ink:C.orange}}>{coordTxt}</strong></span>
      </div>
      <ProsCenterMap initial={initialCoordRef.current} onPick={(la,ln)=>setF(o=>({...o,lat:la,lng:ln}))} controlRef={mapCtrl} height={240}/>

      <div className="my-row-2" style={{gap:12,marginTop:6}}>
        <FormField label="Últ. contacto"><SInp type="date" value={f.last_contact_at} onChange={v=>set('last_contact_at',v)}/></FormField>
        <FormField label="Próx. seguimiento"><SInp type="date" value={f.next_followup_at} onChange={v=>set('next_followup_at',v)}/></FormField>
        <FormField label="Notas de la conversación" col="1 / -1"><STa value={f.notes} onChange={v=>set('notes',v)} rows={4} placeholder="Qué se habló, próximos pasos, objeciones…"/></FormField>
      </div>

      {f.status === 'descartado' && <FormField label="Motivo de descarte"><SInp value={f.discard_reason} onChange={v=>set('discard_reason',v)} placeholder="Ej: ya usa otro sistema"/></FormField>}
      {f.status === 'activo' && (
        <FormField label="Restaurante en Mythos (enlazar)" hint="Creá el restaurante en la pestaña Restaurantes y enlazalo acá para marcarlo como cliente activo.">
          <SSel value={f.converted_restaurant_id} onChange={v=>set('converted_restaurant_id',v)}>
            <option value="">— Sin enlazar todavía —</option>
            {(restaurants || []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </SSel>
        </FormField>
      )}

      <div style={{display:'flex',gap:10,justifyContent:'space-between',marginTop:16,alignItems:'center'}}>
        {!isNew ? <Btn variant="danger" onClick={del} disabled={busy}>Eliminar</Btn> : <span/>}
        <div style={{display:'flex',gap:10}}>
          <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
          <Btn onClick={save} disabled={busy}>{busy ? 'Guardando…' : (isNew ? 'Crear prospecto' : 'Guardar cambios')}</Btn>
        </div>
      </div>
    </Modal>
  );
}

/* ── PÁGINA PROSPECCIÓN — sub-tabs (Restaurantes / Proveedores) + mapa/lista ── */
function PageProspeccion({ setFlash, restaurants }) {
  const [kind, setKind] = useState('restaurant');
  const [view, setView] = useState('mapa');
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [edit, setEdit] = useState(null);   // row (o {kind} para nuevo); null = cerrado
  const [fStatus, setFStatus] = useState('todos');
  const [fCity, setFCity] = useState('');
  const [q, setQ] = useState('');
  const [loadErr, setLoadErr] = useState(null);

  const load = useCallback(async () => {
    if (!db) { setLoading(false); return; }
    const { data, error } = await db.from('prospects').select('*').order('created_at', {ascending:false});
    if (error) { setLoadErr(error.message || 'Error de carga'); }
    else { setLoadErr(null); setRows(data || []); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); if (!db) return;
    const id = setInterval(() => { if (!_shouldPause()) load(); }, 45000);
    return () => clearInterval(id);
  }, [load]);

  const kindRows = React.useMemo(() => rows.filter(r => (r.kind || 'restaurant') === kind), [rows, kind]);
  const cities   = React.useMemo(() => Array.from(new Set(kindRows.map(r => r.city).filter(Boolean))).sort(), [kindRows]);
  const filtered = React.useMemo(() => {
    const ql = q.trim().toLowerCase();
    return kindRows.filter(r => {
      if (fStatus !== 'todos' && (r.status || 'nuevo') !== fStatus) return false;
      if (fCity && (r.city || '') !== fCity) return false;
      if (ql) {
        const hay = `${r.name||''} ${r.owner_name||''} ${r.zone||''} ${r.city||''} ${r.contact_phone||''}`.toLowerCase();
        if (!hay.includes(ql)) return false;
      }
      return true;
    });
  }, [kindRows, fStatus, fCity, q]);
  const counts = React.useMemo(() => {
    const c = {total:kindRows.length, activo:0, pipeline:0, sinUbic:0};
    kindRows.forEach(r => {
      const s = r.status || 'nuevo';
      if (s === 'activo') c.activo++;
      if (['contactado','en_conversacion','negociacion'].includes(s)) c.pipeline++;
      if (!_prosCoord(r)) c.sinUbic++;
    });
    return c;
  }, [kindRows]);

  const restNameById = {}; (restaurants || []).forEach(r => { restNameById[r.id] = r.name; });
  const TABS = [{id:'restaurant', label:'Restaurantes'}, {id:'supplier', label:'Proveedores'}];
  const vbtn = (on) => ({padding:'7px 14px',fontSize:12.5,fontWeight:700,border:'none',background:on?C.ink:'transparent',color:on?C.surface:C.mid,cursor:'pointer'});

  if (loading) return <div style={{display:'flex',justifyContent:'center',alignItems:'center',height:200,gap:14}}><Spinner/><span style={{color:C.mid}}>Cargando prospección…</span></div>;

  return (
    <div>
      <MkTabBar tabs={TABS} active={kind} onSelect={k => { setKind(k); setFStatus('todos'); setFCity(''); }}/>

      {loadErr && (
        <div style={{border:`1px solid ${C.orange}`,background:TINT.warnBg,color:TINT.warnText,borderRadius:10,padding:'11px 14px',marginBottom:14,fontSize:12.5,lineHeight:1.5}}>
          No se pudo cargar Prospección: <strong>{loadErr}</strong>. Si es la primera vez, aplicá la <strong>migración 174</strong> (tabla <strong>prospects</strong>) en el SQL Editor de Supabase y recargá la página.
        </div>
      )}

      <div className="sa-kpis" style={{marginBottom:16}}>
        <Kpi label="Total" value={counts.total}/>
        <Kpi label="Clientes activos" value={counts.activo}/>
        <Kpi label="En pipeline" value={counts.pipeline} sub="contactado · en charla · negociación"/>
        <Kpi label="Sin ubicación" value={counts.sinUbic} sub="no aparecen en el mapa"/>
      </div>

      <div style={{display:'flex',flexWrap:'wrap',gap:10,alignItems:'center',marginBottom:14}}>
        <div style={{display:'inline-flex',border:`1px solid ${C.border}`,borderRadius:9,overflow:'hidden'}}>
          <button onClick={()=>setView('mapa')}  style={vbtn(view==='mapa')}>🗺️ Mapa</button>
          <button onClick={()=>setView('lista')} style={vbtn(view==='lista')}>📋 Lista</button>
        </div>
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Buscar nombre, contacto, zona…" style={{...sField,width:'auto',flex:'1 1 200px',minWidth:180}}/>
        <select value={fCity} onChange={e=>setFCity(e.target.value)} style={{...sField,width:'auto',cursor:'pointer'}}>
          <option value="">Todas las ciudades</option>
          {cities.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <Btn onClick={()=>setEdit({kind})}>+ Nuevo {kind === 'restaurant' ? 'restaurante' : 'proveedor'}</Btn>
      </div>

      <div style={{display:'flex',gap:7,flexWrap:'wrap',marginBottom:16}}>
        <FilterBtn active={fStatus==='todos'} onClick={()=>setFStatus('todos')}>Todos</FilterBtn>
        {PROSPECT_ORDER.map(s => <FilterBtn key={s} active={fStatus===s} onClick={()=>setFStatus(s)}>{PROSPECT_ESTADO[s].label}</FilterBtn>)}
      </div>

      {view === 'mapa'
        ? <ProspectMapView rows={filtered} onSelect={setEdit}/>
        : <ProspectListView rows={filtered} restNameById={restNameById} onSelect={setEdit}/>}

      {edit && <ProspectModal row={edit} restaurants={restaurants} onClose={()=>setEdit(null)} onDone={()=>{ setEdit(null); load(); }} setFlash={setFlash}/>}
    </div>
  );
}

// ── Navegación ───────────────────────────────────────────────
// PR-SA-UI: alineado al patrón de sidebar de admin/gerente — cada ítem lleva
// ícono de mythos-icons.js y la lista se agrupa por dominio con encabezados +
// separadores (`null`). Antes era una lista plana de 16 entradas sin íconos:
// el único panel de Mythos que no seguía la línea de diseño.
const NAV = [
  {id:'dashboard',      label:'Dashboard',     icon:'dashboard'},
  {id:'paneles',        label:'Paneles',       icon:'layout'},
  null,
  {id:'restaurantes',   label:'Restaurantes',  icon:'store',    group:'CLIENTES'},
  {id:'prospeccion',    label:'Prospección',   icon:'pin'},
  {id:'usuarios',       label:'Usuarios',      icon:'users'},
  {id:'proveedores',    label:'Proveedores',   icon:'building'},
  // "Comensales" son las PERSONAS que comen (app /clientes), no los
  // restaurantes: acá "Clientes" es el grupo comercial de Mythos.
  {id:'comensales',     label:'Comensales',    icon:'star'},
  // Los riders NO son "clientes" de Mythos ni personal de un local: son la
  // tercera pata de la red, con su propio ciclo de alta, documentación y
  // disciplina. Por eso tienen entrada propia y no una pestaña dentro de otro.
  {id:'riders',         label:'Riders',        icon:'bike'},
  null,
  {id:'facturacion',    label:'Facturación',   icon:'receipt',  group:'NEGOCIO'},
  {id:'finanzas',       label:'Finanzas',      icon:'money'},
  {id:'fiscal',         label:'Fiscal',        icon:'fileText'},
  null,
  {id:'reportes',       label:'Reportes',      icon:'chart',    group:'ANÁLISIS'},
  {id:'actividad',      label:'Actividad',     icon:'activity'},
  {id:'capacidad',      label:'Capacidad',     icon:'boxes'},
  null,
  {id:'soporte',        label:'Soporte',       icon:'chat',     group:'SISTEMA'},
  {id:'sitio_web',      label:'Sitio web',     icon:'home'},
  {id:'horarios',       label:'Horarios',      icon:'calendar'},
  {id:'configuracion',  label:'Configuración', icon:'settings'},
];
// "Calendario" ahora vive como pestaña dentro de Horarios; "Mi cuenta" como
// pestaña dentro de Configuración (consolidación de menú, sin perder nada).

/* ─── Soporte: constantes compartidas ─── */
const SUPPORT_CATS = {
  problema_tecnico:'Problema técnico',
  consulta:'Consulta',
  facturacion:'Facturación',
  sugerencia:'Sugerencia',
  urgente:'Urgente',
  otro:'Otro'
};
const SUPPORT_STATUS = {
  abierto:           {label:'Abierto',              color:TINT.infoText,   bg:TINT.infoBg},
  en_curso:          {label:'En curso',             color:TINT.warnText,   bg:TINT.warnBg},
  esperando_cliente: {label:'Esperando cliente',    color:C.mid, bg:'var(--bg-subtle)'},
  resuelto:          {label:'Resuelto',             color:TINT.okText,     bg:TINT.okBg},
  cerrado:           {label:'Cerrado',              color:C.mid, bg:'var(--bg-subtle)'}
};
const SUPPORT_PRIO = {
  baja:    {label:'Baja',    color:C.mid},
  normal:  {label:'Normal',  color:TINT.infoText},
  alta:    {label:'Alta',    color:C.orange},
  urgente: {label:'Urgente', color:C.red}
};

/* ════════════════════════════════════════════════════════════════════════════
   PAGE: SOPORTE — Bandeja de tickets de Gerentes / Admins
   ════════════════════════════════════════════════════════════════════════════ */
function PageSoporte({setFlash}) {
  const [tickets, setTickets] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState('open');  // 'all' | 'open' | 'unread' | 'cerrado' …
  const [filterText, setFilterText] = useState('');
  const scrollRef = useRef(null);
  const profile = window._userProfile||{};
  const myName = profile.display_name||profile.username||'Mythos';

  const loadTickets = useCallback(async () => {
    if (!db) return;
    const { data } = await db.from('support_tickets')
      .select('*')
      .order('last_message_at', {ascending:false})
      .limit(200);
    setTickets(data||[]);
    setLoading(false);
  }, []);

  const loadMessages = useCallback(async (ticketId) => {
    if (!db || !ticketId) return;
    const { data } = await db.from('support_messages')
      .select('*')
      .eq('ticket_id', ticketId)
      .order('created_at', {ascending:true});
    setMessages(data||[]);
    await db.rpc('support_mark_read', {p_ticket_id: ticketId, p_side: 'support'});
    loadTickets();
  }, [loadTickets]);

  useEffect(() => { loadTickets(); }, [loadTickets]);

  useEffect(() => {
    if (!db) return;
    const ch = db.channel('support-super-rt')
      .on('postgres_changes',{event:'*',schema:'public',table:'support_tickets'}, () => loadTickets())
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'support_messages'}, (payload) => {
        if (selected && payload.new?.ticket_id === selected.id) loadMessages(selected.id);
        else loadTickets();
      })
      .subscribe();
    const poll = setInterval(() => { if (!_shouldPause()) loadTickets(); }, 25000);
    return () => { db.removeChannel(ch); clearInterval(poll); };
  }, [selected, loadTickets, loadMessages]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  function openTicket(t) { setSelected(t); loadMessages(t.id); }

  async function sendReply(body) {
    if (!db || !selected || !body.trim()) return;
    const { error } = await db.from('support_messages').insert({
      ticket_id: selected.id,
      author_user_id: profile.id||null,
      author_name: myName,
      author_role: 'superadmin',
      author_side: 'support',
      body: body.trim()
    });
    if (error) { setFlash({type:'error', text:'Error al enviar: '+error.message}); return; }
    loadMessages(selected.id);
  }

  async function changeStatus(newStatus, withSystemNote) {
    if (!db || !selected) return;
    const patch = {status: newStatus, updated_at: new Date().toISOString()};
    if (newStatus === 'cerrado' || newStatus === 'resuelto') {
      patch.closed_at = new Date().toISOString();
      patch.closed_by_user_id = profile.id||null;
      patch.closed_by_name = myName;
    }
    if (!selected.assigned_to_user_id && newStatus === 'en_curso') {
      patch.assigned_to_user_id = profile.id||null;
      patch.assigned_to_name = myName;
    }
    const { error } = await db.from('support_tickets').update(patch).eq('id', selected.id);
    if (error) { setFlash({type:'error', text:'Error: '+error.message}); return; }
    if (withSystemNote) {
      await db.from('support_messages').insert({
        ticket_id: selected.id,
        author_name:'Mythos',
        author_role:'superadmin',
        author_side:'system',
        system_event:'status_change',
        body: `Estado cambiado a: ${SUPPORT_STATUS[newStatus]?.label||newStatus}`
      });
    }
    setFlash({type:'success', text:`Ticket marcado como ${SUPPORT_STATUS[newStatus]?.label||newStatus}`});
    setSelected({...selected, ...patch});
    loadTickets();
    loadMessages(selected.id);
  }

  async function assignToMe() {
    if (!db || !selected) return;
    const { error } = await db.from('support_tickets').update({
      assigned_to_user_id: profile.id||null,
      assigned_to_name: myName,
      status: selected.status==='abierto' ? 'en_curso' : selected.status,
      updated_at: new Date().toISOString()
    }).eq('id', selected.id);
    if (error) { setFlash({type:'error', text:'Error: '+error.message}); return; }
    await db.from('support_messages').insert({
      ticket_id: selected.id,
      author_name:'Mythos',
      author_role:'superadmin',
      author_side:'system',
      system_event:'assigned',
      body: `${myName} tomó el ticket`
    });
    setFlash({type:'success', text:'Ticket asignado a vos'});
    loadTickets();
    loadMessages(selected.id);
    const { data: fresh } = await db.from('support_tickets').select('*').eq('id', selected.id).single();
    if (fresh) setSelected(fresh);
  }

  // Filtrado
  const filtered = tickets.filter(t => {
    if (filterStatus === 'open' && ['resuelto','cerrado'].includes(t.status)) return false;
    if (filterStatus === 'unread' && !(t.unread_for_super > 0)) return false;
    if (filterStatus === 'cerrado' && !['resuelto','cerrado'].includes(t.status)) return false;
    if (filterStatus !== 'all' && filterStatus !== 'open' && filterStatus !== 'unread' && filterStatus !== 'cerrado') {
      if (t.status !== filterStatus) return false;
    }
    if (filterText.trim()) {
      const q = filterText.toLowerCase();
      const hay = `${t.subject||''} ${t.restaurant_name||''} ${t.created_by_name||''} ${t.last_message_preview||''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // KPIs
  const kpis = {
    open:    tickets.filter(t => !['resuelto','cerrado'].includes(t.status)).length,
    unread:  tickets.filter(t => t.unread_for_super > 0).length,
    urgent:  tickets.filter(t => t.priority === 'urgente' && !['resuelto','cerrado'].includes(t.status)).length,
    today:   tickets.filter(t => new Date(t.created_at).toDateString() === new Date().toDateString()).length
  };

  return (
    <div className="animate-in">
      <div className="sa-kpis" style={{marginBottom:18}}>
        <Kpi label="Abiertos" value={kpis.open} sub={`${kpis.unread} con mensajes sin leer`}/>
        <Kpi label="Sin leer" value={kpis.unread} sub="Esperan tu respuesta"/>
        <Kpi label="Urgentes" value={kpis.urgent} sub="Prioridad alta"/>
        <Kpi label="Hoy" value={kpis.today} sub="Tickets creados hoy"/>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'380px 1fr',gap:14,height:'calc(100vh - 290px)',minHeight:560}}>
        {/* LISTA */}
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,display:'flex',flexDirection:'column',overflow:'hidden'}}>
          <div style={{padding:'10px 12px',borderBottom:`1px solid ${C.border}`}}>
            <input
              value={filterText}
              onChange={e => setFilterText(e.target.value)}
              placeholder="Buscar por restaurante, asunto…"
              style={{width:'100%',marginBottom:8}}
            />
            <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
              <FilterBtn active={filterStatus==='open'}    onClick={()=>setFilterStatus('open')}>Abiertos</FilterBtn>
              <FilterBtn active={filterStatus==='unread'}  onClick={()=>setFilterStatus('unread')}>Sin leer</FilterBtn>
              <FilterBtn active={filterStatus==='cerrado'} onClick={()=>setFilterStatus('cerrado')}>Cerrados</FilterBtn>
              <FilterBtn active={filterStatus==='all'}     onClick={()=>setFilterStatus('all')}>Todos</FilterBtn>
            </div>
          </div>
          <div style={{flex:1,overflowY:'auto'}}>
            {loading ? <div style={{padding:30,textAlign:'center'}}><Spinner/></div>
              : filtered.length === 0
                ? <div style={{padding:30,textAlign:'center',color:C.dim,fontSize:13}}>Sin tickets con esos filtros</div>
                : filtered.map(t => {
                    const s = SUPPORT_STATUS[t.status]||{label:t.status,color:C.mid,bg:'var(--bg-subtle)'};
                    const p = SUPPORT_PRIO[t.priority];
                    const isSel = selected?.id === t.id;
                    return (
                      <div key={t.id} onClick={() => openTicket(t)} style={{
                        padding:'12px 14px',borderBottom:`1px solid ${C.border}`,cursor:'pointer',
                        background: isSel ? TINT.infoBg : (t.unread_for_super>0 ? TINT.warnBg : 'transparent'),
                        borderLeft: isSel ? `3px solid ${C.ink}` : (t.unread_for_super>0 ? `3px solid ${C.orange}` : '3px solid transparent'),
                        transition:'background .15s'
                      }}>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:6,marginBottom:5}}>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:13,fontWeight:700,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{t.subject}</div>
                            <div style={{fontSize:11,color:C.mid,marginTop:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                              <strong style={{color:C.ink}}>{t.restaurant_name||'—'}</strong> · {t.created_by_name||'—'} ({t.created_by_role||'—'})
                            </div>
                          </div>
                          {t.unread_for_super > 0 && (
                            <span style={{background:C.red,color:'#fff',fontSize:10,fontWeight:800,padding:'1px 6px',borderRadius:8,flexShrink:0}}>{t.unread_for_super}</span>
                          )}
                        </div>
                        <div style={{fontSize:11,color:C.mid,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginBottom:6}}>
                          {t.last_message_by_side==='client' ? <span style={{color:C.orange,fontWeight:700}}>↗ </span> : <span style={{color:C.green,fontWeight:700}}>↙ </span>}
                          {t.last_message_preview||'—'}
                        </div>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:6}}>
                          <div style={{display:'flex',gap:6,alignItems:'center'}}>
                            <span style={{padding:'2px 7px',borderRadius:10,fontSize:10,fontWeight:700,background:s.bg,color:s.color}}>{s.label}</span>
                            {p && <span style={{fontSize:10,fontWeight:700,color:p.color}}>● {p.label}</span>}
                          </div>
                          <span style={{fontSize:10,color:C.dim}}>{fmtRelTime(t.last_message_at)}</span>
                        </div>
                      </div>
                    );
                  })
            }
          </div>
        </div>

        {/* DETALLE + CHAT */}
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,display:'flex',flexDirection:'column',overflow:'hidden'}}>
          {!selected ? (
            <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:12,padding:40,color:C.dim}}>
              <div style={{opacity:.3,color:C.mid}}><Icon name="chat" size={36}/></div>
              <div style={{fontSize:14,fontWeight:600,color:C.mid}}>Seleccioná un ticket para ver la conversación</div>
              <div style={{fontSize:12,maxWidth:380,textAlign:'center'}}>Vas a ver toda la información del restaurante y del usuario que abrió el ticket, junto con la conversación completa.</div>
            </div>
          ) : (
            <SoporteSuperChat
              ticket={selected}
              messages={messages}
              onSend={sendReply}
              onStatusChange={changeStatus}
              onAssign={assignToMe}
              onClose={() => setSelected(null)}
              myName={myName}
              myUserId={profile.id}
              scrollRef={scrollRef}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SoporteSuperChat({ticket, messages, onSend, onStatusChange, onAssign, onClose, myName, myUserId, scrollRef}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [showInfo, setShowInfo] = useState(true);
  const s = SUPPORT_STATUS[ticket.status]||{label:ticket.status,color:C.mid,bg:'var(--bg-subtle)'};
  const p = SUPPORT_PRIO[ticket.priority];
  const isMine = ticket.assigned_to_user_id === myUserId;
  const closed = ['resuelto','cerrado'].includes(ticket.status);

  async function submit() {
    if (!draft.trim() || sending) return;
    setSending(true);
    await onSend(draft);
    setDraft('');
    setSending(false);
  }

  return (
    <>
      {/* HEADER */}
      <div style={{padding:'12px 18px',borderBottom:`1px solid ${C.border}`}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:15,fontWeight:700,color:C.ink}}>{ticket.subject}</div>
            <div style={{display:'flex',gap:8,marginTop:5,alignItems:'center',flexWrap:'wrap'}}>
              <span style={{padding:'2px 8px',borderRadius:10,fontSize:11,fontWeight:700,background:s.bg,color:s.color}}>{s.label}</span>
              <span style={{fontSize:11,color:C.mid}}>{SUPPORT_CATS[ticket.category]||ticket.category}</span>
              {p && <span style={{fontSize:11,color:p.color,fontWeight:700}}>· {p.label}</span>}
              {ticket.assigned_to_name && <span style={{fontSize:11,color:C.mid}}>· Asignado a <strong style={{color:C.ink}}>{ticket.assigned_to_name}</strong></span>}
            </div>
          </div>
          <button onClick={onClose} style={{background:'none',color:C.mid,fontSize:22,padding:'2px 8px',border:'none',cursor:'pointer'}}>×</button>
        </div>

        {/* Acciones */}
        <div style={{display:'flex',gap:6,marginTop:10,flexWrap:'wrap'}}>
          {!isMine && !closed && <Btn size="sm" variant="ghost" onClick={onAssign}>Tomar ticket</Btn>}
          {ticket.status === 'abierto' && <Btn size="sm" variant="ghost" onClick={()=>onStatusChange('en_curso', true)}>Marcar en curso</Btn>}
          {!closed && <Btn size="sm" variant="ghost" onClick={()=>onStatusChange('esperando_cliente', true)}>Esperando cliente</Btn>}
          {!closed && <Btn size="sm" variant="success" onClick={()=>onStatusChange('resuelto', true)}>Marcar resuelto</Btn>}
          {ticket.status === 'resuelto' && <Btn size="sm" variant="ghost" onClick={()=>onStatusChange('cerrado', true)}>Cerrar definitivamente</Btn>}
          {closed && <Btn size="sm" variant="ghost" onClick={()=>onStatusChange('abierto', true)}>Reabrir</Btn>}
        </div>
      </div>

      {/* INFO CLIENTE (colapsable) */}
      <div style={{background:'var(--bg-subtle)',borderBottom:`1px solid ${C.border}`}}>
        <button onClick={() => setShowInfo(!showInfo)} style={{width:'100%',padding:'8px 18px',background:'none',border:'none',textAlign:'left',cursor:'pointer',display:'flex',justifyContent:'space-between',alignItems:'center',fontSize:11,fontWeight:700,color:C.mid,textTransform:'uppercase',letterSpacing:.5}}>
          <span>Datos del cliente</span>
          <span>{showInfo?'▾':'▸'}</span>
        </button>
        {showInfo && (
          <div style={{padding:'4px 18px 12px',display:'grid',gridTemplateColumns:'repeat(2, 1fr)',gap:'6px 18px',fontSize:12}}>
            <div><span style={{color:C.mid}}>Restaurante: </span><strong>{ticket.restaurant_name||'—'}</strong></div>
            <div><span style={{color:C.mid}}>ID restaurante: </span><code style={{fontSize:11,color:C.dim}}>{ticket.restaurant_id?.slice(0,8)}…</code></div>
            <div><span style={{color:C.mid}}>Usuario: </span><strong>{ticket.created_by_name||'—'}</strong></div>
            <div><span style={{color:C.mid}}>Rol: </span><strong>{ticket.created_by_role||'—'}</strong></div>
            {ticket.created_by_username && <div><span style={{color:C.mid}}>Username: </span><code style={{fontSize:11}}>{ticket.created_by_username}</code></div>}
            {ticket.created_by_email && <div><span style={{color:C.mid}}>Email: </span><a href={`mailto:${ticket.created_by_email}`} style={{color:C.ink}}>{ticket.created_by_email}</a></div>}
            {ticket.created_by_phone && <div><span style={{color:C.mid}}>Teléfono: </span>{ticket.created_by_phone}</div>}
            <div><span style={{color:C.mid}}>Creado: </span>{fmtDateTime(ticket.created_at)}</div>
            <div><span style={{color:C.mid}}>Última actividad: </span>{fmtDateTime(ticket.last_message_at)}</div>
            <div><span style={{color:C.mid}}>Mensajes: </span>{ticket.total_messages||0}</div>
          </div>
        )}
      </div>

      {/* MENSAJES */}
      <div ref={scrollRef} style={{flex:1,overflowY:'auto',padding:'18px 20px',background:'var(--bg-subtle)',display:'flex',flexDirection:'column',gap:10}}>
        {messages.length === 0 && <div style={{textAlign:'center',color:C.dim,fontSize:12,padding:20}}>Sin mensajes aún…</div>}
        {messages.map(m => {
          if (m.author_side === 'system') {
            return <div key={m.id} style={{textAlign:'center',fontSize:11,color:C.dim,padding:'4px 8px'}}>— {m.body} · {fmtDateTime(m.created_at)} —</div>;
          }
          const mine = m.author_side === 'support';
          return (
            <div key={m.id} style={{display:'flex',justifyContent: mine?'flex-end':'flex-start'}}>
              <div style={{maxWidth:'78%'}}>
                <div style={{
                  background: mine ? C.ink : C.surface,
                  color: mine ? C.surface : C.ink,
                  border: mine ? `1px solid ${C.ink}` : `1px solid ${C.border}`,
                  padding:'9px 13px',borderRadius:12,
                  borderBottomRightRadius: mine?4:12,
                  borderBottomLeftRadius:  mine?12:4,
                  fontSize:13,lineHeight:1.45,whiteSpace:'pre-wrap',wordBreak:'break-word'
                }}>{m.body}</div>
                <div style={{fontSize:10,color:C.dim,marginTop:3,textAlign: mine?'right':'left'}}>
                  {mine ? `${m.author_name||myName} (Mythos)` : (m.author_name||'Cliente')} · {fmtDateTime(m.created_at)}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* COMPOSER */}
      <div style={{padding:12,borderTop:`1px solid ${C.border}`,background:C.surface}}>
        {closed && (
          <div style={{fontSize:11,color:C.mid,marginBottom:8,textAlign:'center'}}>
            Este ticket está cerrado. Cualquier mensaje del cliente lo reabrirá automáticamente.
          </div>
        )}
        <div style={{display:'flex',gap:8,alignItems:'flex-end'}}>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            rows={2}
            placeholder="Respondé al cliente…"
            onKeyDown={e => { if (e.key==='Enter' && (e.metaKey||e.ctrlKey)) submit(); }}
            style={{flex:1,minHeight:50,resize:'none',fontFamily:'inherit'}}
          />
          <Btn onClick={submit} disabled={sending || !draft.trim()} style={{flexShrink:0,height:46}}>{sending?'Enviando…':'Enviar'}</Btn>
        </div>
        <div style={{fontSize:10,color:C.dim,marginTop:5,textAlign:'right'}}>Ctrl/Cmd + Enter para enviar</div>
      </div>
    </>
  );
}

/* ══════════════════════════════════════════════
   CALENDARIO — Superadmin
══════════════════════════════════════════════ */
// WS5: emoji → bullet geométrico monocromo '●' (U+25CF), hereda color del span.
const SA_CAL_TYPES = {
  holiday: {label:'Feriado',    color:'#FF3B30', icon:'●'},
  event:   {label:'Evento',     color:'#007AFF', icon:'●'},
  sport:   {label:'Deportivo',  color:'#34C759', icon:'●'},
  special: {label:'Especial',   color:'#AF52DE', icon:'●'},
  promo:   {label:'Promoción',  color:'#FF9500', icon:'●'},
};
const SA_CAL_CROWD = {
  low:    {label:'Afluencia baja',  color:'#34C759', dot:'●'},
  medium: {label:'Afluencia media', color:'#FF9500', dot:'●'},
  high:   {label:'Afluencia alta',  color:'#FF3B30', dot:'●'},
};
const SA_WEEK   = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
const SA_MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function saCalGridDays(year, month) {
  const first    = new Date(year, month, 1);
  const last     = new Date(year, month + 1, 0);
  const startDow = (first.getDay() + 6) % 7;
  const days = [];
  for (let i = 0; i < startDow; i++) days.push(null);
  for (let d = 1; d <= last.getDate(); d++) days.push(d);
  return days;
}

// ── Horarios & Estado — vista de apertura/cierre por restaurante ─
function PageHorarios({restaurants, setFlash, reload}) {
  const [toggling, setToggling] = useState(null);
  const [tab, setTab] = useState('estados');   // estados (apertura/cierre) | calendario

  const toggleOpen = async (r) => {
    if (!db) { setFlash({type:'warn', text:'Sin conexión — operación demo'}); return; }
    setToggling(r.id);
    const next = !r.is_open;
    const {error} = await db.from('restaurants').update({is_open: next}).eq('id', r.id);
    setToggling(null);
    if (error) { setFlash({type:'error', text:'Error: '+error.message}); return; }
    setFlash({type:'ok', text:`${r.name} marcado como ${next ? 'abierto' : 'cerrado'}`});
    reload();
  };

  const openCount   = restaurants.filter(r => r.is_open).length;
  const closedCount = restaurants.length - openCount;
  const allClosed   = openCount === 0 && restaurants.length > 0;

  // Extrae texto de horarios del campo opening_hours (JSONB: [{day,hours}])
  const renderHours = (oh) => {
    if (!oh || (Array.isArray(oh) && oh.length === 0)) return <span style={{color:C.mid,fontSize:12}}>Sin horario cargado</span>;
    const arr = Array.isArray(oh) ? oh : (typeof oh === 'string' ? JSON.parse(oh) : []);
    return (
      <div style={{fontSize:12,lineHeight:1.6}}>
        {arr.map((h,i) => (
          <div key={i}><span style={{color:C.mid}}>{h.day}:</span> {h.hours}</div>
        ))}
      </div>
    );
  };

  return (
    <div className="animate-in">
      {/* Sub-pestañas: estado de apertura + calendario de eventos */}
      <div style={{display:'flex',gap:8,marginBottom:16}}>
        <FilterBtn active={tab==='estados'}    onClick={()=>setTab('estados')}>Horarios y estados</FilterBtn>
        <FilterBtn active={tab==='calendario'} onClick={()=>setTab('calendario')}>Calendario</FilterBtn>
      </div>

      {tab==='calendario' && <PageCalendario restaurants={restaurants}/>}

      {tab==='estados' && (<>
      <div style={{marginBottom:24}}>
        <div style={{fontSize:22,fontWeight:800,color:C.ink,letterSpacing:'-0.5px'}}>Horarios y estados</div>
        <div style={{fontSize:13,color:C.mid,marginTop:4}}>Estado de apertura en tiempo real y ventana de mantenimiento</div>
      </div>

      {/* Tarjetas resumen */}
      <div style={{display:'flex',gap:12,marginBottom:24,flexWrap:'wrap'}}>
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:'16px 24px',minWidth:140}}>
          <div style={{fontSize:28,fontWeight:800,color:'#34C759'}}>{openCount}</div>
          <div style={{fontSize:12,color:C.mid,marginTop:2}}>Abiertos ahora</div>
        </div>
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:'16px 24px',minWidth:140}}>
          <div style={{fontSize:28,fontWeight:800,color:C.red}}>{closedCount}</div>
          <div style={{fontSize:12,color:C.mid,marginTop:2}}>Cerrados ahora</div>
        </div>
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:'16px 24px',minWidth:140}}>
          <div style={{fontSize:28,fontWeight:800,color:C.ink}}>{restaurants.length}</div>
          <div style={{fontSize:12,color:C.mid,marginTop:2}}>Total restaurantes</div>
        </div>
        <div style={{
          background: allClosed ? '#34C75915' : '#FF3B3015',
          border: `1px solid ${allClosed ? '#34C759' : C.red}`,
          borderRadius:12,padding:'16px 24px',flex:1,minWidth:200,display:'flex',alignItems:'center',gap:12
        }}>
          <div style={{color:allClosed ? C.green : C.orange}}><Icon name={allClosed ? 'checkCircle' : 'clock'} size={20}/></div>
          <div>
            <div style={{fontSize:13,fontWeight:700,color: allClosed ? '#1a7a3a' : '#b02020'}}>
              {allClosed ? 'Ventana disponible' : 'Aún hay restaurantes abiertos'}
            </div>
            <div style={{fontSize:11,color:C.mid,marginTop:2}}>
              {allClosed
                ? 'Todos los restaurantes están cerrados — momento ideal para actualizaciones'
                : `${openCount} restaurante${openCount > 1 ? 's' : ''} en operación — esperá a que cierren todos`}
            </div>
          </div>
        </div>
      </div>

      {/* Tabla de restaurantes */}
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,overflow:'hidden'}}>
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead>
            <tr style={{background:C.bg}}>
              <th style={{padding:'10px 16px',textAlign:'left',fontSize:11,fontWeight:600,color:C.mid,textTransform:'uppercase',letterSpacing:.4}}>Restaurante</th>
              <th style={{padding:'10px 16px',textAlign:'left',fontSize:11,fontWeight:600,color:C.mid,textTransform:'uppercase',letterSpacing:.4}}>Ciudad</th>
              <th style={{padding:'10px 16px',textAlign:'left',fontSize:11,fontWeight:600,color:C.mid,textTransform:'uppercase',letterSpacing:.4}}>Horarios</th>
              <th style={{padding:'10px 16px',textAlign:'center',fontSize:11,fontWeight:600,color:C.mid,textTransform:'uppercase',letterSpacing:.4}}>Estado</th>
              <th style={{padding:'10px 16px',textAlign:'center',fontSize:11,fontWeight:600,color:C.mid,textTransform:'uppercase',letterSpacing:.4}}>Toggle</th>
            </tr>
          </thead>
          <tbody>
            {restaurants.length === 0 && (
              <tr><td colSpan={5} style={{padding:32,textAlign:'center',color:C.mid,fontSize:13}}>Sin restaurantes</td></tr>
            )}
            {restaurants.map((r, i) => (
              <tr key={r.id} style={{borderTop: i > 0 ? `1px solid ${C.border}` : 'none', background: r.is_open ? '#34C75908' : 'transparent'}}>
                <td style={{padding:'12px 16px'}}>
                  <div style={{fontWeight:600,fontSize:13,color:C.ink}}>{r.name}</div>
                  <div style={{fontSize:11,color:C.mid}}>{r.status === 'active' ? 'Activo' : r.status === 'trial' ? 'Trial' : r.status === 'suspended' ? 'Suspendido' : r.status}</div>
                </td>
                <td style={{padding:'12px 16px',fontSize:13,color:C.mid}}>{r.city || '—'}</td>
                <td style={{padding:'12px 16px'}}>{renderHours(r.opening_hours)}</td>
                <td style={{padding:'12px 16px',textAlign:'center'}}>
                  <span style={{
                    display:'inline-block',padding:'3px 10px',borderRadius:20,fontSize:11,fontWeight:700,
                    background: r.is_open ? '#34C75920' : '#F5F5F7',
                    color: r.is_open ? '#1a7a3a' : C.mid
                  }}>
                    {r.is_open ? 'Abierto' : 'Cerrado'}
                  </span>
                </td>
                <td style={{padding:'12px 16px',textAlign:'center'}}>
                  <button
                    disabled={toggling === r.id}
                    onClick={() => toggleOpen(r)}
                    style={{
                      padding:'5px 14px',borderRadius:6,border:'none',cursor:'pointer',fontSize:12,fontWeight:600,
                      background: r.is_open ? C.red : '#34C759',
                      color:'#fff',opacity: toggling === r.id ? .5 : 1,
                      transition:'all .15s'
                    }}
                  >
                    {toggling === r.id ? '…' : r.is_open ? 'Marcar cerrado' : 'Marcar abierto'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{marginTop:16,fontSize:11,color:C.mid}}>
        El estado se actualiza manualmente. Los horarios mostrados son los cargados en cada restaurante desde el panel admin.
      </div>
      </>)}
    </div>
  );
}

function PageCalendario({restaurants}) {
  const now = new Date();
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [filterRest, setFilterRest] = useState('global'); // 'global' | 'all' | uuid
  const [form, setForm] = useState({title:'', type:'event', end_date:'', expected_crowd:'medium', notes:'', is_global:true, restaurant_id:''});
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);

  const loadEvents = useCallback(async () => {
    if (!db) return;
    setLoading(true);
    const mm    = String(month + 1).padStart(2,'0');
    const lastD = new Date(year, month + 1, 0).getDate();
    let q = db.from('calendar_events').select('*,restaurant:restaurants(name)')
      .gte('date', `${year}-${mm}-01`)
      .lte('date', `${year}-${mm}-${lastD}`)
      .order('date');
    if (filterRest === 'global')      q = q.eq('is_global', true);
    else if (filterRest !== 'all')    q = q.or(`restaurant_id.eq.${filterRest},is_global.eq.true`);
    const {data} = await q;
    setEvents(data || []);
    setLoading(false);
  }, [year, month, filterRest]);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  const prevMonth = () => { if (month===0){setYear(y=>y-1);setMonth(11);}else setMonth(m=>m-1); setSelected(null); };
  const nextMonth = () => { if (month===11){setYear(y=>y+1);setMonth(0);}else setMonth(m=>m+1); setSelected(null); };

  const days    = saCalGridDays(year, month);
  const today   = new Date();
  const isToday = d => d===today.getDate() && month===today.getMonth() && year===today.getFullYear();

  const evtsForDay = d => {
    if (!d) return [];
    const ds = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    return events.filter(e => e.date <= ds && (e.end_date ? e.end_date >= ds : e.date === ds));
  };

  const selDate = selected ? `${year}-${String(month+1).padStart(2,'0')}-${String(selected).padStart(2,'0')}` : null;
  const selEvts = selected ? evtsForDay(selected) : [];

  const resetForm = () => { setForm({title:'', type:'event', end_date:'', expected_crowd:'medium', notes:'', is_global:true, restaurant_id:''}); setEditId(null); };
  const startEdit = e => { setForm({title:e.title, type:e.type, end_date:e.end_date||'', expected_crowd:e.expected_crowd||'medium', notes:e.notes||'', is_global:e.is_global, restaurant_id:e.restaurant_id||''}); setEditId(e.id); };

  const save = async () => {
    if (!form.title.trim() || !selDate || !db) return;
    setSaving(true);
    const payload = {
      restaurant_id:  form.is_global ? null : (form.restaurant_id || null),
      title:          form.title.trim(),
      type:           form.type,
      date:           selDate,
      end_date:       form.end_date || null,
      expected_crowd: form.expected_crowd,
      notes:          form.notes || null,
      color:          SA_CAL_TYPES[form.type]?.color || '#007AFF',
      is_global:      form.is_global,
    };
    if (editId) await db.from('calendar_events').update(payload).eq('id', editId);
    else        await db.from('calendar_events').insert(payload);
    setSaving(false);
    resetForm();
    loadEvents();
  };

  const del = async id => {
    if (!db) return;
    await db.from('calendar_events').delete().eq('id', id);
    loadEvents();
  };

  const upcoming = [...events]
    .filter(e => { const d = new Date(); d.setHours(0,0,0,0); return new Date(e.date + 'T12:00:00') >= d; })
    .sort((a,b) => a.date.localeCompare(b.date))
    .slice(0, 7);

  const globalCount = events.filter(e => e.is_global).length;
  const highCount   = events.filter(e => e.expected_crowd === 'high').length;

  return (
    <div>
      {/* Header */}
      <div style={{marginBottom:20}}>
        <h1 style={{fontSize:22,fontWeight:800,color:C.ink,margin:0}}>Calendario de Eventos</h1>
        <div style={{fontSize:12,color:C.mid,marginTop:3}}>Feriados globales y eventos por restaurante</div>
      </div>

      {/* Stats bar */}
      <div style={{display:'flex',gap:10,marginBottom:18,flexWrap:'wrap'}}>
        {[
          {label:'Eventos este mes', value:events.length, color:C.blue},
          {label:'Globales',         value:globalCount,   color:'#AF52DE'},
          {label:'Alta afluencia',   value:highCount,     color:'#FF3B30'},
        ].map(s => (
          <div key={s.label} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'10px 16px',display:'flex',gap:10,alignItems:'center'}}>
            <div style={{fontSize:20,fontWeight:900,color:s.color}}>{s.value}</div>
            <div style={{fontSize:11,color:C.mid,fontWeight:500}}>{s.label}</div>
          </div>
        ))}

        {/* Filtro restaurante */}
        <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:6}}>
          <span style={{fontSize:11,color:C.mid,fontWeight:600}}>Ver:</span>
          <select value={filterRest} onChange={e=>{setFilterRest(e.target.value);setSelected(null);}}
            style={{padding:'6px 10px',fontSize:12,borderRadius:7,border:`1px solid ${C.border}`,background:C.surface,color:C.ink}}>
            <option value="global">Solo globales</option>
            <option value="all">Todos</option>
            {(restaurants||[]).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
      </div>

      <div style={{display:'flex',gap:20,alignItems:'flex-start'}}>
        {/* Grilla */}
        <div style={{flex:'1 1 0',minWidth:0}}>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:14}}>
            <button onClick={prevMonth} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:7,width:34,height:34,fontSize:17,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}}>‹</button>
            <div style={{flex:1,textAlign:'center',fontWeight:800,fontSize:16,color:C.ink}}>{SA_MONTHS[month]} {year}</div>
            <button onClick={nextMonth} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:7,width:34,height:34,fontSize:17,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}}>›</button>
            <button onClick={()=>{setYear(today.getFullYear());setMonth(today.getMonth());setSelected(null);}} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:7,padding:'5px 10px',fontSize:11,fontWeight:700,cursor:'pointer',color:C.mid}}>Hoy</button>
          </div>

          <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:2,marginBottom:3}}>
            {SA_WEEK.map(d => <div key={d} style={{textAlign:'center',fontSize:10,fontWeight:800,color:C.mid,padding:'3px 0',textTransform:'uppercase',letterSpacing:.4}}>{d}</div>)}
          </div>

          {loading ? <div style={{textAlign:'center',padding:50}}><Spinner/></div> : (
            <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:2}}>
              {days.map((d, i) => {
                const dayEvts = evtsForDay(d);
                const sel     = d && selected === d;
                const isTdy   = isToday(d);
                const hasHigh = dayEvts.some(e => e.expected_crowd === 'high');
                const hasGlobal = dayEvts.some(e => e.is_global);
                return (
                  <div key={i}
                    onClick={() => { if (d) { setSelected(sel ? null : d); resetForm(); } }}
                    style={{
                      minHeight:70, padding:'6px 7px', borderRadius:8,
                      cursor:d?'pointer':'default',
                      background: sel?C.ink:isTdy?TINT.infoBg:hasHigh&&d?TINT.warnBg:hasGlobal&&d?TINT.purpleBg:d?C.surface:'transparent',
                      border: sel?`1.5px solid ${C.ink}`:isTdy?`1.5px solid var(--info)`:hasHigh&&d?`1px solid ${TINT.warnBorder}`:hasGlobal&&d?`1px solid ${TINT.purpleText}`:`1px solid ${C.border}`,
                      transition:'all .1s',
                    }}>
                    {d && <>
                      <div style={{fontSize:12,fontWeight:isTdy?800:500,color:sel?C.surface:isTdy?'var(--info)':C.ink,lineHeight:1,marginBottom:4}}>{d}</div>
                      <div style={{display:'flex',flexWrap:'wrap',gap:2}}>
                        {dayEvts.slice(0,4).map(e => (
                          <div key={e.id} style={{width:7,height:7,borderRadius:e.is_global?2:'50%',background:SA_CAL_TYPES[e.type]?.color||'#007AFF',flexShrink:0,opacity:sel?.8:1}}/>
                        ))}
                        {dayEvts.length > 4 && <div style={{fontSize:9,color:sel?'#ccc':C.mid}}>+{dayEvts.length-4}</div>}
                      </div>
                    </>}
                  </div>
                );
              })}
            </div>
          )}

          <div style={{display:'flex',flexWrap:'wrap',gap:14,marginTop:14,paddingTop:12,borderTop:`1px solid ${C.border}`}}>
            {Object.entries(SA_CAL_TYPES).map(([k,v]) => (
              <div key={k} style={{display:'flex',alignItems:'center',gap:5,fontSize:11,color:C.mid}}>
                <div style={{width:8,height:8,borderRadius:'50%',background:v.color}}/>
                {v.label}
              </div>
            ))}
            <div style={{display:'flex',alignItems:'center',gap:5,fontSize:11,color:TINT.warnText}}>
              <div style={{width:8,height:8,borderRadius:2,background:TINT.warnBorder}}/>
              Alta afluencia
            </div>
            <div style={{display:'flex',alignItems:'center',gap:5,fontSize:11,color:TINT.purpleText}}>
              <div style={{width:8,height:8,borderRadius:2,background:'#AF52DE'}}/>
              Global
            </div>
          </div>
        </div>

        {/* Panel lateral */}
        <div style={{width:320,flexShrink:0}}>
          {selected ? (
            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:16}}>
              <div style={{fontWeight:800,fontSize:13,marginBottom:12,color:C.ink,display:'flex',justifyContent:'space-between'}}>
                <span>{String(selected).padStart(2,'0')} {SA_MONTHS[month].substring(0,3)} {year}</span>
                <span style={{fontSize:11,color:C.mid,fontWeight:400}}>{selEvts.length} evento{selEvts.length!==1?'s':''}</span>
              </div>

              {selEvts.map(e => (
                <div key={e.id} style={{background:C.bg,borderRadius:8,padding:'10px 12px',marginBottom:6,borderLeft:`3px solid ${SA_CAL_TYPES[e.type]?.color||'#007AFF'}`}}>
                  <div style={{display:'flex',alignItems:'flex-start',gap:8}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:600,fontSize:13,color:C.ink,marginBottom:3}}>{SA_CAL_TYPES[e.type]?.icon} {e.title}</div>
                      <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
                        <span style={{fontSize:10,padding:'1px 5px',borderRadius:4,background:SA_CAL_TYPES[e.type]?.color+'22',color:SA_CAL_TYPES[e.type]?.color,fontWeight:700}}>{SA_CAL_TYPES[e.type]?.label}</span>
                        <span style={{fontSize:10,padding:'1px 5px',borderRadius:4,background:SA_CAL_CROWD[e.expected_crowd]?.color+'22',color:SA_CAL_CROWD[e.expected_crowd]?.color,fontWeight:700}}>{SA_CAL_CROWD[e.expected_crowd]?.dot} {SA_CAL_CROWD[e.expected_crowd]?.label}</span>
                        {e.is_global
                          ? <span style={{fontSize:10,padding:'1px 5px',borderRadius:4,background:TINT.purpleBg,color:TINT.purpleText,fontWeight:700,display:'inline-flex',alignItems:'center',gap:3}}><Icon name="sparkles" size={10}/> Global</span>
                          : <span style={{fontSize:10,padding:'1px 5px',borderRadius:4,background:'#F0F0F5',color:C.mid,fontWeight:700}}>{e.restaurant?.name||'Local'}</span>
                        }
                      </div>
                      {e.notes && <div style={{fontSize:11,color:C.mid,marginTop:3}}>{e.notes}</div>}
                    </div>
                    <div style={{display:'flex',gap:3,flexShrink:0}}>
                      <button onClick={()=>startEdit(e)} title="Editar" style={{background:'none',border:`1px solid ${C.border}`,borderRadius:5,padding:'3px 7px',fontSize:11,cursor:'pointer',color:C.mid,display:'inline-flex',alignItems:'center'}}><Icon name="edit" size={12}/></button>
                      <button onClick={()=>del(e.id)} title="Eliminar" style={{background:'none',border:`1px solid rgba(239,68,68,.3)`,borderRadius:5,padding:'3px 7px',fontSize:11,cursor:'pointer',color:C.red,display:'inline-flex',alignItems:'center'}}><Icon name="trash" size={12}/></button>
                    </div>
                  </div>
                </div>
              ))}

              <div style={{borderTop:selEvts.length?`1px solid ${C.border}`:'none',paddingTop:selEvts.length?12:0,marginTop:selEvts.length?4:0}}>
                <div style={{fontSize:10,fontWeight:800,color:C.mid,textTransform:'uppercase',letterSpacing:.5,marginBottom:8,display:'flex',alignItems:'center',gap:5}}>
                  <Icon name={editId ? 'edit' : 'plus'} size={11}/> {editId ? 'Editar evento' : 'Nuevo evento'}
                </div>
                <div style={{display:'flex',flexDirection:'column',gap:7}}>
                  <input value={form.title} onChange={e=>setForm(f=>({...f,title:e.target.value}))} placeholder="Título del evento" style={{padding:'8px 10px',fontSize:13,borderRadius:7,border:`1px solid ${C.border}`,width:'100%'}}/>
                  <select value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value}))} style={{padding:'8px 10px',fontSize:13,borderRadius:7,border:`1px solid ${C.border}`}}>
                    {Object.entries(SA_CAL_TYPES).map(([k,v])=><option key={k} value={k}>{v.icon} {v.label}</option>)}
                  </select>
                  <select value={form.expected_crowd} onChange={e=>setForm(f=>({...f,expected_crowd:e.target.value}))} style={{padding:'8px 10px',fontSize:13,borderRadius:7,border:`1px solid ${C.border}`}}>
                    {Object.entries(SA_CAL_CROWD).map(([k,v])=><option key={k} value={k}>{v.dot} {v.label}</option>)}
                  </select>

                  {/* Alcance */}
                  <div style={{background:C.bg,borderRadius:7,padding:'8px 10px',border:`1px solid ${C.border}`}}>
                    <div style={{fontSize:10,fontWeight:800,color:C.mid,marginBottom:6,textTransform:'uppercase',letterSpacing:.4}}>Alcance</div>
                    <label style={{display:'flex',alignItems:'center',gap:7,cursor:'pointer',marginBottom:6}}>
                      <input type="radio" checked={form.is_global} onChange={()=>setForm(f=>({...f,is_global:true,restaurant_id:''}))}/>
                      <span style={{fontSize:12,fontWeight:600,color:C.ink,display:'inline-flex',alignItems:'center',gap:5}}><Icon name="sparkles" size={12}/> Global — visible en todos los restaurantes</span>
                    </label>
                    <label style={{display:'flex',alignItems:'center',gap:7,cursor:'pointer'}}>
                      <input type="radio" checked={!form.is_global} onChange={()=>setForm(f=>({...f,is_global:false}))}/>
                      <span style={{fontSize:12,fontWeight:600,color:C.ink}}>Local — restaurante específico</span>
                    </label>
                    {!form.is_global && (
                      <select value={form.restaurant_id} onChange={e=>setForm(f=>({...f,restaurant_id:e.target.value}))}
                        style={{marginTop:6,padding:'6px 8px',fontSize:12,borderRadius:6,border:`1px solid ${C.border}`,width:'100%'}}>
                        <option value="">— Seleccioná restaurante —</option>
                        {(restaurants||[]).map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    )}
                  </div>

                  <div>
                    <div style={{fontSize:10,color:C.mid,marginBottom:3}}>Hasta (multi-día, opcional)</div>
                    <input type="date" value={form.end_date} onChange={e=>setForm(f=>({...f,end_date:e.target.value}))} style={{padding:'7px 10px',fontSize:12,borderRadius:7,border:`1px solid ${C.border}`,width:'100%'}}/>
                  </div>
                  <textarea value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} placeholder="Notas (opcional)" rows={2} style={{padding:'8px 10px',fontSize:12,borderRadius:7,border:`1px solid ${C.border}`,resize:'none',fontFamily:'inherit'}}/>
                  <div style={{display:'flex',gap:6}}>
                    {editId && <Btn variant="ghost" size="sm" onClick={resetForm} style={{flex:1}}>Cancelar</Btn>}
                    <Btn size="sm" onClick={save} disabled={saving||!form.title.trim()||(!form.is_global&&!form.restaurant_id)} style={{flex:1}}>
                      {saving ? 'Guardando…' : editId ? 'Guardar cambios' : 'Crear evento'}
                    </Btn>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:16}}>
              <div style={{fontWeight:800,fontSize:13,marginBottom:12,color:C.ink}}>Próximos eventos — {SA_MONTHS[month]}</div>
              {upcoming.length === 0 ? (
                <div style={{fontSize:12,color:C.mid,textAlign:'center',padding:'24px 0',lineHeight:1.6}}>
                  Sin eventos este mes.<br/>
                  <span style={{fontSize:11}}>Hacé clic en un día para agregar.</span>
                </div>
              ) : upcoming.map(e => {
                const d = new Date(e.date + 'T12:00:00');
                return (
                  <div key={e.id} style={{display:'flex',gap:10,alignItems:'flex-start',padding:'8px 0',borderBottom:`1px solid ${C.border}`,cursor:'pointer'}}
                    onClick={()=>{setSelected(d.getDate());resetForm();}}>
                    <div style={{width:38,textAlign:'center',flexShrink:0}}>
                      <div style={{fontSize:20,fontWeight:900,color:SA_CAL_TYPES[e.type]?.color||C.ink,lineHeight:1}}>{String(d.getDate()).padStart(2,'0')}</div>
                      <div style={{fontSize:9,color:C.mid,textTransform:'uppercase',letterSpacing:.3}}>{SA_MONTHS[d.getMonth()].substring(0,3)}</div>
                    </div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:12,fontWeight:600,color:C.ink,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{SA_CAL_TYPES[e.type]?.icon} {e.title}</div>
                      <div style={{display:'flex',gap:4,marginTop:2,alignItems:'center'}}>
                        <span style={{fontSize:10,color:SA_CAL_CROWD[e.expected_crowd]?.color,fontWeight:700}}>{SA_CAL_CROWD[e.expected_crowd]?.dot} {SA_CAL_CROWD[e.expected_crowd]?.label}</span>
                        {e.is_global
                          ? <span style={{fontSize:9,color:TINT.purpleText,background:TINT.purpleBg,padding:'1px 5px',borderRadius:3,fontWeight:700}}>Global</span>
                          : <span style={{fontSize:9,color:C.mid,background:C.bg,padding:'1px 5px',borderRadius:3,fontWeight:700}}>{e.restaurant?.name||'Local'}</span>
                        }
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// MÓDULO SITIO WEB (WEB-6A) — gestión de la web comercial
//   Lee/edita tablas de la migración 110 (marketing_*) + leads_prospectos
//   (mig 117, PR-SA2) vía el cliente autenticado (anon key + sesión
//   superadmin); RLS superadmin-only protege. Sin service_role, sin endpoint.
//   Pestañas: Resumen · Registros · Leads · Actividad · Planes · Add-ons · FAQ · Config.
// ══════════════════════════════════════════════════════════════
const LEAD_STATUSES = ['new','contacted','qualified','won','lost','spam'];
const LEAD_STATUS_META = {
  new:       {label:'Nuevo',       color:TINT.infoText,   bg:TINT.infoBg},
  contacted: {label:'Contactado',  color:TINT.warnText,   bg:TINT.warnBg},
  qualified: {label:'Calificado',  color:TINT.purpleText, bg:TINT.purpleBg},
  won:       {label:'Ganado',      color:TINT.okText,     bg:TINT.okBg},
  lost:      {label:'Perdido',     color:TINT.dangerText, bg:TINT.dangerBg},
  spam:      {label:'Spam',        color:C.mid,           bg:'var(--bg-subtle)'},
};
const LEAD_TYPE_LABEL = {contact:'Contacto', demo:'Demo', trial_interest:'Interés trial', whatsapp:'WhatsApp', pricing:'Precios'};
const leadTypeLabel = t => LEAD_TYPE_LABEL[t] || t || '—';

const LeadStatusBadge = ({status}) => {
  const m = LEAD_STATUS_META[status] || {label:status||'—',color:C.mid,bg:'var(--bg-subtle)'};
  return <span style={{padding:'2px 8px',borderRadius:20,fontSize:11,fontWeight:600,background:m.bg,color:m.color,whiteSpace:'nowrap'}}>{m.label}</span>;
};
const TypePill = ({type}) => (
  <span style={{padding:'2px 8px',borderRadius:12,fontSize:11,fontWeight:600,background:C.bg,color:C.mid,border:`1px solid ${C.border}`,whiteSpace:'nowrap'}}>{leadTypeLabel(type)}</span>
);

// ── PR-SA2 · Registros de la prueba gratuita (leads_prospectos, mig 117) ──
const REG_ESTADOS = ['registrado','onboarding','contactado','calificado','convertido','descartado'];
const REG_ESTADO_META = {
  registrado: {label:'Registrado', color:TINT.infoText,   bg:TINT.infoBg},
  onboarding: {label:'Onboarding', color:TINT.warnText,   bg:TINT.warnBg},
  contactado: {label:'Contactado', color:C.ink,           bg:C.bg},
  calificado: {label:'Calificado', color:TINT.purpleText, bg:TINT.purpleBg},
  convertido: {label:'Convertido', color:TINT.okText,     bg:TINT.okBg},
  descartado: {label:'Descartado', color:C.mid,           bg:'var(--bg-subtle)'},
};
const REG_TIPO_LABEL = {restaurante:'Restaurante', foodpark_local:'Local en foodpark', foodpark_owner:'Dueño de foodpark'};
const regTipoLabel = t => REG_TIPO_LABEL[t] || t || '—';

const RegEstadoBadge = ({estado}) => {
  const m = REG_ESTADO_META[estado] || {label:estado||'—',color:C.mid,bg:'var(--bg-subtle)'};
  return <span style={{padding:'2px 8px',borderRadius:20,fontSize:11,fontWeight:600,background:m.bg,color:m.color,whiteSpace:'nowrap'}}>{m.label}</span>;
};
const VerifBadge = ({ok}) => (
  <span style={{padding:'2px 8px',borderRadius:20,fontSize:11,fontWeight:600,background:ok?TINT.okBg:'var(--bg-subtle)',color:ok?TINT.okText:C.mid,whiteSpace:'nowrap'}}>{ok?'Verificado':'Sin verificar'}</span>
);

// Duración legible entre registro y creación del local. Negativa = el local
// existía antes del registro (match espurio o alta manual previa) → '—'.
const fmtDur = ms => {
  if (ms == null || isNaN(ms) || ms < 0) return '—';
  const min = Math.round(ms/60000);
  if (min < 60) return `${min} min`;
  const h = Math.round(ms/3600000);
  if (h < 48) return `${h} h`;
  return `${Math.round(ms/86400000)} d`;
};

function RegistroDetailModal({registro, onClose, setFlash, reload}) {
  const [estado, setEstado] = useState(registro.estado||'registrado');
  const [saving, setSaving] = useState(false);
  const local = registro.local;
  const localPrevio = registro.localPrevio;

  const Row = ({label,children}) => (
    <div style={{display:'flex',gap:12,padding:'8px 0',borderBottom:`1px solid ${C.border}`}}>
      <div style={{width:140,flexShrink:0,fontSize:12,color:C.mid,fontWeight:600}}>{label}</div>
      <div style={{flex:1,fontSize:13,color:C.ink,minWidth:0,wordBreak:'break-word'}}>{children}</div>
    </div>
  );

  const save = async () => {
    if (!db) { setFlash({type:'warn',text:'Sin conexión'}); return; }
    if (!REG_ESTADOS.includes(estado)) { setFlash({type:'error',text:'Estado inválido'}); return; }
    setSaving(true);
    const { error } = await db.from('leads_prospectos').update({ estado }).eq('id', registro.id);
    setSaving(false);
    if (error) { setFlash({type:'error',text:'No se pudo guardar el registro'}); return; }
    setFlash({type:'success',text:'Registro actualizado'});
    onClose(); reload();
  };

  return (
    <Modal title="Detalle del registro" onClose={onClose} width={560}>
      <div style={{marginBottom:18}}>
        <Row label="Fecha">{fmtAlta(registro.created_at)}</Row>
        <Row label="Nombre">{registro.nombre||'—'}</Row>
        <Row label="Email">{registro.email||'—'}</Row>
        <Row label="WhatsApp"><WaLink phone={registro.whatsapp}/></Row>
        <Row label="Tipo de negocio">{regTipoLabel(registro.tipo_negocio)}</Row>
        <Row label="Origen">{registro.origen||'—'}</Row>
        <Row label="Verificado"><VerifBadge ok={registro.verificado}/></Row>
        <Row label="Estado actual"><RegEstadoBadge estado={registro.estado}/></Row>
        <Row label="Local creado">{local
          ? <>{local.name} <Badge status={local.status}/></>
          : localPrevio
            ? <>{localPrevio.name} <Badge status={localPrevio.status}/> <span style={{fontSize:11,color:C.mid}}>(existía antes de este registro — no cuenta como conversión)</span></>
            : '— (no creó local todavía)'}</Row>
        {local && <Row label="Alta del local">{fmtAlta(local.created_at)}</Row>}
        {local && <Row label="Tiempo hasta crear local">{fmtDur(new Date(local.created_at)-new Date(registro.created_at))}</Row>}
      </div>
      <FormField label="Estado" hint="Estado de gestión del prospecto (triage manual).">
        <select value={estado} onChange={e=>setEstado(e.target.value)}>
          {REG_ESTADOS.map(s=><option key={s} value={s}>{REG_ESTADO_META[s].label}</option>)}
        </select>
      </FormField>
      <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:8}}>
        <Btn variant="ghost" onClick={onClose}>Cerrar</Btn>
        <Btn onClick={save} disabled={saving}>{saving?'Guardando…':'Guardar'}</Btn>
      </div>
    </Modal>
  );
}

/* Número de contacto → enlace de WhatsApp, para escribirle desde el panel sin
   copiar y pegar. La normalización asume Paraguay (es a quien le vendemos y lo
   que pide el placeholder de los formularios): 0981… → 595981…, y un número
   corto sin prefijo también se asume paraguayo. Un número que YA trae código de
   país largo (13+ dígitos) se deja intacto para no romperlo. Si no hay número
   contactable se muestra un guion, no un enlace roto. */
const waHref = s => {
  let d = String(s||'').replace(/\D/g,'');
  if (d.length < 8) return null;
  if (d.startsWith('595')) return `https://wa.me/${d}`;
  if (d.startsWith('0'))   return `https://wa.me/595${d.slice(1)}`;
  if (d.length <= 10)      return `https://wa.me/595${d}`;
  return `https://wa.me/${d}`;
};
const WaLink = ({phone}) => {
  const href = waHref(phone);
  if (!href) return <span style={{color:C.dim}}>{phone ? phone : '—'}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={e=>e.stopPropagation()}
       title="Abrir chat de WhatsApp"
       style={{color:C.green,fontWeight:600,textDecoration:'none',whiteSpace:'nowrap'}}>{phone}</a>
  );
};

function SitioRegistros({registros, restaurants, totalExact, setFlash, reload}) {
  const [fEstado, setFEstado]         = useState('all');
  const [fTipo, setFTipo]             = useState('all');
  const [soloSinLocal, setSoloSinLocal] = useState(false);
  const [selected, setSelected]       = useState(null);

  // Cruce registro→local por email del dueño (case-insensitive + trim, null =
  // sin match). Solo cuenta como conversión un local creado DESPUÉS del registro;
  // si el local ya existía (alta manual previa / dueño re-registrándose) queda
  // como "localPrevio": se muestra de referencia pero NO suma a los KPIs ni saca
  // el lead del filtro "sin local".
  const restsOk = Array.isArray(restaurants);
  const byEmail = {};
  (restsOk ? restaurants : []).forEach(r => {
    const k = (r.owner_email||'').trim().toLowerCase();
    if (!k) return;
    (byEmail[k] = byEmail[k] || []).push(r);
  });
  const matchFor = lead => {
    const k = (lead.email||'').trim().toLowerCase();
    const cands = k ? byEmail[k] : null;
    if (!cands || !cands.length) return {local:null, localPrevio:null};
    const sorted = [...cands].sort((a,b)=>(a.created_at||'').localeCompare(b.created_at||''));
    const post = sorted.find(r => (r.created_at||'') >= (lead.created_at||''));
    return post ? {local:post, localPrevio:null} : {local:null, localPrevio:sorted[0]};
  };
  const enriched = registros.map(l => ({...l, ...matchFor(l)}));

  // KPIs de conversión sobre EMAILS ÚNICOS: el form público permite filas
  // duplicadas (doble submit / reintento), y contarlas 1:1 inflaría el funnel.
  // verificado = true si ALGUNA fila del email lo está.
  const byKey = new Map();
  enriched.forEach(l => {
    const k = (l.email||'').trim().toLowerCase() || `__id_${l.id}`;
    const cur = byKey.get(k);
    if (!cur) byKey.set(k, {verif:!!l.verificado, local:l.local});
    else { cur.verif = cur.verif || !!l.verificado; cur.local = cur.local || l.local; }
  });
  const uniq = [...byKey.values()];

  const since7   = Date.now() - 7*86400000;
  const total    = enriched.length;
  const totalTxt = totalExact!=null ? totalExact : total;   // count exacto: la lista se capa a 500
  const capped   = totalExact!=null && totalExact > total;
  const last7    = enriched.filter(l => l.created_at && new Date(l.created_at).getTime() >= since7).length;
  const verifPct = uniq.length ? Math.round(uniq.filter(u=>u.verif).length/uniq.length*100) : 0;
  const conLocal = uniq.filter(u=>u.local).length;
  const convPct  = uniq.length ? Math.round(conLocal/uniq.length*100) : 0;
  const activos  = uniq.filter(u=>u.local && u.local.status==='active').length;

  let shown = enriched;
  if (fEstado!=='all')  shown = shown.filter(l=>l.estado===fEstado);
  if (fTipo!=='all')    shown = shown.filter(l=>l.tipo_negocio===fTipo);
  if (soloSinLocal)     shown = shown.filter(l=>!l.local);

  return (
    <div>
      {!restsOk && <div style={{background:TINT.warnBg,color:TINT.warnText,padding:'10px 14px',borderRadius:10,fontSize:12,fontWeight:600,marginBottom:14}}>
        No se pudieron leer los restaurantes en esta carga: el cruce registro→local y las métricas de conversión no están disponibles (los registros sí).
      </div>}
      {capped && <div style={{fontSize:11,color:C.mid,marginBottom:10}}>
        Mostrando los últimos {fmtNum(total)} registros de {fmtNum(totalTxt)}; porcentajes y funnel calculados sobre los cargados.
      </div>}
      <div className="sa-kpis" style={{marginBottom:18}}>
        <Kpi label="Total registros"  value={fmtNum(totalTxt)} sub={`${fmtNum(uniq.length)} email${uniq.length!==1?'s':''} únicos${capped?' (cargados)':''}`}/>
        <Kpi label="Últimos 7 días"   value={fmtNum(last7)}/>
        <Kpi label="Verificados"      value={uniq.length ? `${verifPct}%` : '—'} sub="confirmaron su email"/>
        <Kpi label="Crearon local"    value={restsOk ? fmtNum(conLocal) : '—'} sub="match por email del dueño"/>
        <Kpi label="Conversión"       value={restsOk && uniq.length ? `${convPct}%` : '—'} sub="crearon local / registros"/>
      </div>

      {restsOk && <SectionCard title="Funnel: registro → local → pagando" style={{marginBottom:18}}>
        <div style={{padding:'16px 20px'}}>
          <HBars rows={[
            {label:'Registrados',     value: uniq.length, note:'emails únicos'},
            {label:'Crearon local',   value: conLocal},
            {label:'Activos pagando', value: activos},
          ]}/>
        </div>
      </SectionCard>}

      <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',marginBottom:16}}>
        <select value={fEstado} onChange={e=>setFEstado(e.target.value)} style={{width:'auto',minWidth:150,fontSize:13}}>
          <option value="all">Todos los estados</option>
          {REG_ESTADOS.map(s=><option key={s} value={s}>{REG_ESTADO_META[s].label}</option>)}
        </select>
        <select value={fTipo} onChange={e=>setFTipo(e.target.value)} style={{width:'auto',minWidth:170,fontSize:13}}>
          <option value="all">Todos los tipos</option>
          {Object.keys(REG_TIPO_LABEL).map(t=><option key={t} value={t}>{REG_TIPO_LABEL[t]}</option>)}
        </select>
        <div style={{display:'flex',alignItems:'center',gap:6,fontSize:12,color:C.ink}}>
          <Toggle checked={soloSinLocal} onChange={setSoloSinLocal}/>
          <span onClick={()=>setSoloSinLocal(v=>!v)} style={{cursor:'pointer'}} title="Abandonos del wizard: se registraron pero no crearon su local">Solo sin local creado</span>
        </div>
        <span style={{fontSize:12,color:C.dim}}>{shown.length} registro{shown.length!==1?'s':''}</span>
      </div>

      <SectionCard>
        {shown.length===0
          ? <div style={{padding:48,textAlign:'center',color:C.dim,fontSize:13}}>
              {registros.length===0 ? 'Sin registros todavía (o la tabla no está accesible)' : 'Sin registros con los filtros actuales'}
            </div>
          : <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse'}}>
                <thead><tr>
                  <Th>Fecha</Th><Th>Nombre</Th><Th>Email</Th><Th>WhatsApp</Th><Th>Tipo negocio</Th><Th>Origen</Th><Th>Verificado</Th><Th>Estado</Th><Th>Local creado</Th><Th>Tiempo hasta local</Th>
                </tr></thead>
                <tbody>
                  {shown.map(l=>(
                    <tr key={l.id} onClick={()=>setSelected(l)} style={{cursor:'pointer'}}
                        onMouseEnter={e=>e.currentTarget.style.background='var(--bg-subtle)'}
                        onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                      <Td style={{whiteSpace:'nowrap',color:C.mid,fontSize:12}}>{fmtAlta(l.created_at)}</Td>
                      <Td style={{fontSize:12}}>{l.nombre||'—'}</Td>
                      <Td style={{fontSize:12}}>{l.email||'—'}</Td>
                      <Td style={{fontSize:12}}><WaLink phone={l.whatsapp}/></Td>
                      <Td style={{fontSize:12,whiteSpace:'nowrap'}}>{regTipoLabel(l.tipo_negocio)}</Td>
                      <Td style={{fontSize:12,color:C.mid}}>{l.origen||'—'}</Td>
                      <Td><VerifBadge ok={l.verificado}/></Td>
                      <Td><RegEstadoBadge estado={l.estado}/></Td>
                      <Td style={{fontSize:12}}>{l.local ? l.local.name : l.localPrevio ? <span style={{color:C.mid}}>{l.localPrevio.name} <span style={{fontSize:10}}>(previo)</span></span> : '—'}</Td>
                      <Td style={{fontSize:12,color:C.mid,whiteSpace:'nowrap'}}>{l.local ? fmtDur(new Date(l.local.created_at)-new Date(l.created_at)) : '—'}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}
      </SectionCard>
      {selected && <RegistroDetailModal registro={selected} onClose={()=>setSelected(null)} setFlash={setFlash} reload={reload}/>}
    </div>
  );
}

function SitioResumen({leads, events, registros=[], registrosTotal=null}) {
  const since = Date.now() - 7*86400000;
  const inWindow = arr => arr.filter(x => x.created_at && new Date(x.created_at).getTime() >= since);
  const rl = inWindow(leads), re = inWindow(events);
  const kDemos = rl.filter(l => l.type==='demo').length;
  const kTrial = rl.filter(l => l.type==='trial_interest').length;
  const pendingNew = leads.filter(l => l.status==='new').length;
  return (
    <div>
      <div className="sa-kpis" style={{marginBottom:18}}>
        <Kpi label="Leads (7 días)" value={rl.length} sub={`${leads.length} en total`}/>
        <Kpi label="Registros (7 días)" value={inWindow(registros).length} sub={`${fmtNum(registrosTotal!=null?registrosTotal:registros.length)} en total`}/>
        <Kpi label="Solicitudes demo (7 días)" value={kDemos}/>
        <Kpi label="Intereses trial (7 días)" value={kTrial}/>
        <Kpi label="Eventos (7 días)" value={re.length}/>
      </div>
      <SectionCard title="Leads pendientes">
        {leads.length===0
          ? <div style={{padding:48,textAlign:'center',color:C.dim,fontSize:13}}>Sin leads todavía</div>
          : <div style={{padding:'16px 20px',fontSize:13,color:C.ink}}>
              {pendingNew===0
                ? 'No hay leads sin contactar.'
                : <>Hay <strong>{pendingNew}</strong> lead{pendingNew!==1?'s':''} con estado “Nuevo”. Revisalos en la pestaña <strong>Leads</strong>.</>}
            </div>}
      </SectionCard>
      {/* Estos KPIs cuentan CUÁNTOS se registraron; para ver QUÉ contestaron
          está la pestaña Formularios (conteo por cada opción de cada pregunta). */}
      <div style={{fontSize:12,color:C.mid,marginTop:12,lineHeight:1.5}}>
        Para ver <strong>qué contestó</strong> cada uno —opción por opción, con la forma del formulario original— entrá en la pestaña <strong>Formularios</strong>.
      </div>
    </div>
  );
}

function LeadDetailModal({lead, onClose, setFlash, reload}) {
  const [status, setStatus] = useState(lead.status||'new');
  const [notes, setNotes]   = useState(lead.internal_notes||'');
  const [saving, setSaving] = useState(false);
  const addons = asArr(lead.selected_addons);

  const Row = ({label,children}) => (
    <div style={{display:'flex',gap:12,padding:'8px 0',borderBottom:`1px solid ${C.border}`}}>
      <div style={{width:120,flexShrink:0,fontSize:12,color:C.mid,fontWeight:600}}>{label}</div>
      <div style={{flex:1,fontSize:13,color:C.ink,minWidth:0,wordBreak:'break-word'}}>{children}</div>
    </div>
  );

  const save = async () => {
    if (!db) { setFlash({type:'warn',text:'Sin conexión'}); return; }
    if (!LEAD_STATUSES.includes(status)) { setFlash({type:'error',text:'Estado inválido'}); return; }
    setSaving(true);
    const { error } = await db.from('marketing_leads')
      .update({ status, internal_notes: notes.trim() ? notes.trim() : null, updated_at: new Date().toISOString() })
      .eq('id', lead.id);
    setSaving(false);
    if (error) { setFlash({type:'error',text:'No se pudo guardar el lead'}); return; }
    setFlash({type:'success',text:'Lead actualizado'});
    onClose(); reload();
  };

  return (
    <Modal title="Detalle del lead" onClose={onClose} width={560}>
      <div style={{marginBottom:18}}>
        <Row label="Fecha">{fmtDateTime(lead.created_at)}</Row>
        <Row label="Tipo"><TypePill type={lead.type}/></Row>
        <Row label="Nombre">{lead.name||'—'}</Row>
        <Row label="Restaurante">{lead.business_name||'—'}</Row>
        <Row label="Email">{lead.email||'—'}</Row>
        <Row label="WhatsApp"><WaLink phone={lead.whatsapp}/></Row>
        <Row label="Plan">{lead.plan_slug||'—'}</Row>
        <Row label="Add-ons">{addons.length ? addons.join(', ') : '—'}</Row>
        <Row label="Mensaje">{lead.message||'—'}</Row>
        <Row label="Origen">{lead.source||'—'}</Row>
      </div>
      <FormField label="Estado">
        <select value={status} onChange={e=>setStatus(e.target.value)}>
          {LEAD_STATUSES.map(s=><option key={s} value={s}>{LEAD_STATUS_META[s].label}</option>)}
        </select>
      </FormField>
      <FormField label="Notas internas" hint="Solo visibles para superadmin.">
        <textarea value={notes} onChange={e=>setNotes(e.target.value)} rows={4} placeholder="Notas de seguimiento…"/>
      </FormField>
      <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:8}}>
        <Btn variant="ghost" onClick={onClose}>Cerrar</Btn>
        <Btn onClick={save} disabled={saving}>{saving?'Guardando…':'Guardar'}</Btn>
      </div>
    </Modal>
  );
}

function SitioLeads({leads, setFlash, reload}) {
  const [fType, setFType]     = useState('all');
  const [fStatus, setFStatus] = useState('all');
  const [selected, setSelected] = useState(null);

  let shown = leads;
  if (fType!=='all')   shown = shown.filter(l => l.type===fType);
  if (fStatus!=='all') shown = shown.filter(l => l.status===fStatus);

  return (
    <div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',marginBottom:16}}>
        <select value={fType} onChange={e=>setFType(e.target.value)} style={{width:'auto',minWidth:150,fontSize:13}}>
          <option value="all">Todos los tipos</option>
          {Object.keys(LEAD_TYPE_LABEL).map(t=><option key={t} value={t}>{leadTypeLabel(t)}</option>)}
        </select>
        <select value={fStatus} onChange={e=>setFStatus(e.target.value)} style={{width:'auto',minWidth:150,fontSize:13}}>
          <option value="all">Todos los estados</option>
          {LEAD_STATUSES.map(s=><option key={s} value={s}>{LEAD_STATUS_META[s].label}</option>)}
        </select>
        <span style={{fontSize:12,color:C.dim}}>{shown.length} lead{shown.length!==1?'s':''}</span>
      </div>
      <SectionCard>
        {shown.length===0
          ? <div style={{padding:48,textAlign:'center',color:C.dim,fontSize:13}}>Sin leads con los filtros actuales</div>
          : <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse'}}>
                <thead><tr>
                  <Th>Fecha</Th><Th>Tipo</Th><Th>Nombre</Th><Th>Restaurante</Th><Th>Email</Th><Th>WhatsApp</Th><Th>Plan</Th><Th>Estado</Th><Th></Th>
                </tr></thead>
                <tbody>
                  {shown.map(l=>(
                    <tr key={l.id}>
                      <Td style={{whiteSpace:'nowrap',color:C.mid}}>{fmtDate(l.created_at)}</Td>
                      <Td><TypePill type={l.type}/></Td>
                      <Td>{l.name||'—'}</Td>
                      <Td>{l.business_name||'—'}</Td>
                      <Td style={{fontSize:12,color:C.mid}}>{l.email||'—'}</Td>
                      <Td style={{fontSize:12,whiteSpace:'nowrap'}}><WaLink phone={l.whatsapp}/></Td>
                      <Td style={{fontSize:12}}>{l.plan_slug||'—'}</Td>
                      <Td><LeadStatusBadge status={l.status}/></Td>
                      <Td style={{whiteSpace:'nowrap'}}><Btn size="sm" variant="ghost" onClick={()=>setSelected(l)}>Ver</Btn></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}
      </SectionCard>
      {selected && <LeadDetailModal lead={selected} onClose={()=>setSelected(null)} setFlash={setFlash} reload={reload}/>}
    </div>
  );
}

function SitioActividad({events}) {
  const [fName, setFName] = useState('all');
  const names = Array.from(new Set(events.map(e=>e.event_name).filter(Boolean))).sort();
  const shown = fName==='all' ? events : events.filter(e=>e.event_name===fName);
  return (
    <div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',marginBottom:16}}>
        <select value={fName} onChange={e=>setFName(e.target.value)} style={{width:'auto',minWidth:200,fontSize:13}}>
          <option value="all">Todos los eventos</option>
          {names.map(n=><option key={n} value={n}>{n}</option>)}
        </select>
        <span style={{fontSize:12,color:C.dim}}>{shown.length} evento{shown.length!==1?'s':''}</span>
        <span style={{fontSize:11,color:C.dim}}>· solo lectura</span>
      </div>
      <SectionCard>
        {shown.length===0
          ? <div style={{padding:48,textAlign:'center',color:C.dim,fontSize:13}}>Sin actividad registrada</div>
          : shown.slice(0,200).map(ev=>(
              <div key={ev.id} style={{padding:'12px 20px',borderBottom:`1px solid ${C.border}`,display:'flex',gap:14,alignItems:'center'}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                    <span style={{fontWeight:700,fontSize:13}}>{ev.event_name}</span>
                    {ev.plan_slug && <span style={{fontSize:12,color:C.mid}}>· {ev.plan_slug}</span>}
                  </div>
                  <div style={{fontSize:12,color:C.mid,marginTop:2}}>{ev.page_path||'—'}</div>
                </div>
                <div style={{fontSize:11,color:C.dim,whiteSpace:'nowrap',flexShrink:0}}>{fmtDateTime(ev.created_at)}</div>
              </div>
            ))}
      </SectionCard>
    </div>
  );
}

// ── Identidad y redes (WEB-8) — fuente única del negocio para sitio + legales ──
// Todas las claves son is_public=true (las lee el sitio con anon). La escritura
// pasa por la RPC fail-closed superadmin_set_marketing_identity (mig 148), con
// whitelist de claves; la RLS de marketing_config ya bloquea a no-superadmin.
const IDENTITY_FIELDS = [
  {key:'legal_name',           label:'Razón social / Nombre', type:'text',  ph:'MYTHOS EAS',                  full:true,  hint:'Nombre legal con el que operás. Aparece en las páginas legales y el pie.'},
  {key:'ruc',                  label:'RUC',                   type:'text',  ph:'80012345-6'},
  {key:'contact_email',        label:'Email de contacto',     type:'email', ph:'hola@mythos.com.py'},
  {key:'legal_address',        label:'Domicilio',             type:'text',  ph:'Asunción, Paraguay',          full:true},
  {key:'whatsapp',             label:'WhatsApp',              type:'text',  ph:'595986622735',                hint:'Solo dígitos: código de país + número. Única fuente del botón de WhatsApp en todo el sitio.'},
  {key:'website_domain',       label:'Dominio del sitio',     type:'text',  ph:'mythos.com.py',       hint:'Sin https://. Se usa en los meta OG y en los legales.'},
  {key:'instagram_url',        label:'Instagram (URL)',       type:'url',   ph:'https://instagram.com/tu_cuenta', hint:'Vacío = se oculta el ícono.'},
  {key:'facebook_url',         label:'Facebook (URL)',        type:'url',   ph:'https://facebook.com/tu_pagina',  hint:'Vacío = se oculta el ícono.'},
  {key:'tiktok_url',           label:'TikTok (URL)',          type:'url',   ph:'https://tiktok.com/@tu_cuenta',   hint:'Vacío = se oculta el ícono.'},
  {key:'legal_effective_date', label:'Fecha de vigencia legal', type:'text', ph:'5 de julio de 2026',         hint:'"Última actualización" de Términos/Privacidad/Cookies.'},
];

function SitioIdentidad({config, setFlash, reload}) {
  const getStr = k => { const row = config.find(c=>c.key===k); const v = row ? row.value : ''; return v==null ? '' : String(v); };
  const [form, setForm] = useState(() => { const o={}; IDENTITY_FIELDS.forEach(f=>{ o[f.key]=getStr(f.key); }); return o; });
  const [saving, setSaving] = useState(false);
  const set = (k,v) => setForm(s=>({...s,[k]:v}));

  const save = async () => {
    if (!db) { setFlash({type:'warn',text:'Sin conexión'}); return; }
    const wa = (form.whatsapp||'').trim();
    if (wa && !/^\d{6,15}$/.test(wa)) { setFlash({type:'error',text:'WhatsApp: solo dígitos, código de país + número (ej: 595986622735).'}); return; }
    const em = (form.contact_email||'').trim();
    if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { setFlash({type:'error',text:'Ese email no parece válido.'}); return; }
    setSaving(true);
    const payload = {}; IDENTITY_FIELDS.forEach(f=>{ payload[f.key] = (form[f.key]||'').trim(); });
    const { error } = await db.rpc('superadmin_set_marketing_identity', { p_values: payload });
    setSaving(false);
    if (error) {
      const msg = /function|does not exist|schema cache|permission denied/i.test(error.message||'')
        ? 'Falta aplicar la migración 148 (o no sos superadmin).' : ('No se pudo guardar: '+error.message);
      setFlash({type:'error',text:msg}); return;
    }
    setFlash({type:'success',text:'Identidad y redes guardadas — el sitio se actualiza al recargar'});
    reload();
  };

  return (
    <div style={{maxWidth:680}}>
      <SectionCard title="Identidad y redes"
        action={<Btn onClick={save} disabled={saving}>{saving?'Guardando…':'Guardar cambios'}</Btn>}>
        <div style={{padding:'18px 20px'}}>
          <p style={{fontSize:12.5,color:C.mid,margin:'0 0 16px',lineHeight:1.55}}>
            Fuente única de los datos del negocio. De acá se alimentan el pie del sitio, el botón de WhatsApp, los íconos de redes y las páginas legales (Términos, Privacidad, Cookies). Un campo vacío se muestra como “—” o se oculta; nunca sale roto.
          </p>
          <div className="my-row-2" style={{gap:'0 16px'}}>
            {IDENTITY_FIELDS.map(f => (
              <FormField key={f.key} label={f.label} hint={f.hint} col={f.full?'1 / -1':undefined}>
                <input type={f.type==='email'?'email':(f.type==='url'?'url':'text')} value={form[f.key]} onChange={e=>set(f.key,e.target.value)} placeholder={f.ph} style={{width:'100%'}}/>
              </FormField>
            ))}
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

// datetime-local (local, sin tz) ⟷ ISO (UTC) para la fecha de fin de promo.
function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function localInputToIso(local) {
  if (!local) return '';
  const d = new Date(local);   // interpreta el string local en la tz del navegador
  return isNaN(d.getTime()) ? '' : d.toISOString();
}
// Texto de cuenta regresiva para el preview (discreto) del superadmin.
function promoCountdownText(iso) {
  if (!iso) return 'sin fecha de fin (sin contador)';
  const end = new Date(iso).getTime();
  if (isNaN(end)) return 'fecha inválida';
  const ms = end - Date.now();
  if (ms <= 0) return 'la oferta ya venció (no se muestra)';
  const s = Math.floor(ms/1000);
  const d = Math.floor(s/86400), h = Math.floor((s%86400)/3600), m = Math.floor((s%3600)/60);
  return `termina en ${d}d ${h}h ${m}m`;
}

function SitioConfig({config, setFlash, reload}) {
  const getVal = (k, dflt) => { const row = config.find(c=>c.key===k); return row ? row.value : dflt; };
  const hasKey = k => config.some(c=>c.key===k);

  // WhatsApp: fuente única = clave `whatsapp` (mig 148). Lee esa; si no existe,
  // hereda del `sales_whatsapp` legacy. También editable desde "Identidad y redes".
  const [whatsapp, setWhatsapp]         = useState(String(getVal('whatsapp', getVal('sales_whatsapp','')) ?? ''));
  const [founderActive, setFounderActive] = useState(getVal('founder_offer_active', false) === true);
  const [founderLimit, setFounderLimit] = useState(String(getVal('founder_offer_limit', 0) ?? 0));
  const [trialDays, setTrialDays]       = useState(String(getVal('trial_days', TRIAL_DAYS_FALLBACK) ?? TRIAL_DAYS_FALLBACK));
  // Promoción / Oferta (WEB-9) — cuadro llamativo + descuento en la web.
  const [promoActive, setPromoActive]   = useState(getVal('promo_active', false) === true);
  const [promoPercent, setPromoPercent] = useState(String(getVal('promo_percent', 0) ?? 0));
  const [promoEndsAt, setPromoEndsAt]   = useState(isoToLocalInput(getVal('promo_ends_at', '')));
  const [promoLabel, setPromoLabel]     = useState(String(getVal('promo_label', 'Oferta por tiempo limitado') ?? ''));
  const [promoHeadline, setPromoHeadline] = useState(String(getVal('promo_headline', '') ?? ''));
  const [saving, setSaving]             = useState(false);

  const trialSignupExists = hasKey('trial_signup_enabled');
  const trialSignupOn = getVal('trial_signup_enabled', null) === true;

  // Guarda una clave en marketing_config con el TIPO JSONB correcto (number/bool/string).
  // Devuelve true si persistió, false si no (para revertir toggles optimistas).
  const saveKey = async (key, value) => {
    if (!db) { setFlash({type:'warn',text:'Sin conexión'}); return false; }
    setSaving(true);
    const { error } = await db.from('marketing_config')
      .upsert({ key, value, is_public:true, updated_at:new Date().toISOString() }, { onConflict:'key' });
    setSaving(false);
    if (error) { setFlash({type:'error',text:'No se pudo guardar la configuración'}); return false; }
    setFlash({type:'success',text:'Configuración guardada'});
    reload();
    return true;
  };

  const saveWhatsapp = () => {
    const v = whatsapp.trim();
    if (!/^\d{6,15}$/.test(v)) { setFlash({type:'error',text:'Usá solo dígitos: código de país + número (ej: 595986622735)'}); return; }
    saveKey('whatsapp', v);                        // fuente única (mig 148), string JSONB
  };
  // Optimista con reversión: si el guardado falla, el toggle vuelve a su estado real.
  const saveFounderActive = async (val) => { setFounderActive(val); const ok = await saveKey('founder_offer_active', !!val); if (!ok) setFounderActive(!val); };  // boolean JSONB
  const saveFounderLimit = () => {
    const n = parseInt(founderLimit, 10);
    if (!Number.isFinite(n) || n < 0) { setFlash({type:'error',text:'El límite debe ser un número entero ≥ 0'}); return; }
    saveKey('founder_offer_limit', n);            // number JSONB
  };
  const saveTrialDays = () => {
    const n = parseInt(trialDays, 10);
    if (!Number.isFinite(n) || n < 1) { setFlash({type:'error',text:'Los días deben ser un número entero ≥ 1'}); return; }
    saveKey('trial_days', n);                      // number JSONB
  };
  const savePromoActive = async (val) => { setPromoActive(val); const ok = await saveKey('promo_active', !!val); if (!ok) setPromoActive(!val); };   // boolean JSONB (optimista con reversión)
  const savePromoPercent = () => {
    const n = parseInt(promoPercent, 10);
    if (!Number.isFinite(n) || n < 0 || n > 100) { setFlash({type:'error',text:'El descuento debe ser un entero entre 0 y 100 (100 = gratis)'}); return; }
    saveKey('promo_percent', n);                   // number JSONB
  };
  const savePromoEndsAt = () => { saveKey('promo_ends_at', localInputToIso(promoEndsAt)); };   // ISO string (o '')
  const savePromoLabel = () => { saveKey('promo_label', (promoLabel||'').trim()); };
  const savePromoHeadline = () => { saveKey('promo_headline', (promoHeadline||'').trim()); };

  return (
    <div style={{maxWidth:640}}>
      <SectionCard title="Contacto de ventas" style={{marginBottom:18}}>
        <div style={{padding:'18px 20px'}}>
          <FormField label="WhatsApp de ventas" hint="Solo dígitos: código de país + número (ej: 595986622735).">
            <div style={{display:'flex',gap:8}}>
              <input value={whatsapp} onChange={e=>setWhatsapp(e.target.value)} placeholder="595986622735" style={{flex:1}}/>
              <Btn variant="ghost" onClick={saveWhatsapp} disabled={saving}>Guardar</Btn>
            </div>
          </FormField>
        </div>
      </SectionCard>

      <SectionCard title="Oferta Fundador" style={{marginBottom:18}}>
        <div style={{padding:'18px 20px'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
            <div>
              <div style={{fontWeight:600,fontSize:14,color:C.ink,marginBottom:4}}>Oferta Fundador activa</div>
              <div style={{fontSize:12,color:C.mid}}>Muestra el banner de cupos en el sitio público.</div>
            </div>
            <Toggle checked={founderActive} onChange={saveFounderActive}/>
          </div>
          <FormField label="Cupos de la oferta">
            <div style={{display:'flex',gap:8}}>
              <input type="number" min="0" value={founderLimit} onChange={e=>setFounderLimit(e.target.value)} style={{flex:1}}/>
              <Btn variant="ghost" onClick={saveFounderLimit} disabled={saving}>Guardar</Btn>
            </div>
          </FormField>
        </div>
      </SectionCard>

      <SectionCard title="Promoción / Oferta" style={{marginBottom:18}}>
        <div style={{padding:'18px 20px'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
            <div>
              <div style={{fontWeight:600,fontSize:14,color:C.ink,marginBottom:4}}>Promoción activa</div>
              <div style={{fontSize:12,color:C.mid}}>Enciende el cuadro de oferta + descuento en la web (planes de restaurante y proveedores).</div>
            </div>
            <Toggle checked={promoActive} onChange={savePromoActive}/>
          </div>
          <FormField label="Descuento (%)" hint="0–100. 100% = planes gratis.">
            <div style={{display:'flex',gap:8}}>
              <input type="number" min="0" max="100" value={promoPercent} onChange={e=>setPromoPercent(e.target.value)} style={{flex:1}}/>
              <Btn variant="ghost" onClick={savePromoPercent} disabled={saving}>Guardar</Btn>
            </div>
          </FormField>
          <FormField label="Termina el" hint="Fecha y hora de fin, para la cuenta regresiva. Vacío = sin contador (oferta abierta).">
            <div style={{display:'flex',gap:8}}>
              <input type="datetime-local" value={promoEndsAt} onChange={e=>setPromoEndsAt(e.target.value)} style={{flex:1}}/>
              <Btn variant="ghost" onClick={savePromoEndsAt} disabled={saving}>Guardar</Btn>
            </div>
          </FormField>
          <FormField label="Etiqueta" hint="Texto chico arriba del cuadro (ej: 'Oferta de lanzamiento').">
            <div style={{display:'flex',gap:8}}>
              <input value={promoLabel} onChange={e=>setPromoLabel(e.target.value)} maxLength={40} placeholder="Oferta por tiempo limitado" style={{flex:1}}/>
              <Btn variant="ghost" onClick={savePromoLabel} disabled={saving}>Guardar</Btn>
            </div>
          </FormField>
          <FormField label="Título (opcional)" hint="Frase principal del cuadro. Vacío = se arma sola con el %.">
            <div style={{display:'flex',gap:8}}>
              <input value={promoHeadline} onChange={e=>setPromoHeadline(e.target.value)} maxLength={80} placeholder="Todos los planes con 30% de descuento" style={{flex:1}}/>
              <Btn variant="ghost" onClick={savePromoHeadline} disabled={saving}>Guardar</Btn>
            </div>
          </FormField>

          {/* Vista previa discreta (no exagerada) de cómo queda en la web */}
          <div style={{marginTop:6,padding:'12px 14px',border:`1px solid ${C.border}`,borderRadius:10,background:C.bg,display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}}>
            <span style={{fontSize:11,fontWeight:700,letterSpacing:.4,color:C.mid,textTransform:'uppercase'}}>Vista previa</span>
            {(() => {
              const pct = Math.max(0, Math.min(100, parseInt(promoPercent,10)||0));
              const on = promoActive && pct>0;
              if (!on) return <span style={{fontSize:13,color:C.dim}}>Promo apagada — la web muestra los precios normales.</span>;
              const tag = pct>=100 ? 'GRATIS' : `−${pct}%`;
              const ej = pct>=100 ? 'GRATIS' : 'Gs '+Math.round(300000*(100-pct)/100).toLocaleString('es-PY');
              return (<>
                <span style={{fontSize:13,fontWeight:800,color:C.surface,background:C.ink,padding:'3px 11px',borderRadius:20}}>{tag}</span>
                <span style={{fontSize:13,color:C.mid}}>{promoCountdownText(localInputToIso(promoEndsAt))}</span>
                <span style={{fontSize:12.5,color:C.dim}}>Ej: Consolidado <s>Gs 300.000</s> → <b style={{color:C.ink}}>{ej}</b>/mes</span>
              </>);
            })()}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Prueba gratis">
        <div style={{padding:'18px 20px'}}>
          <FormField label="Días de prueba"
                     hint="Es el único lugar donde se define. Al guardar cambia el texto de /inicio, /precios, /demo, los Términos y el onboarding, Y la duración real que recibe cada alta nueva. En una FAQ escribí {trial_days} para que el número salga solo.">
            <div style={{display:'flex',gap:8}}>
              <input type="number" min="1" value={trialDays} onChange={e=>setTrialDays(e.target.value)} style={{flex:1}}/>
              <Btn variant="ghost" onClick={saveTrialDays} disabled={saving}>Guardar</Btn>
            </div>
          </FormField>

          {/* Registro público de prueba — BLOQUEADO en WEB-6A (solo lectura). */}
          <div style={{marginTop:6,padding:'14px 16px',border:`1px solid ${TINT.warnBorder}`,borderRadius:10,background:TINT.warnBg}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12}}>
              <div>
                <div style={{fontWeight:700,fontSize:13,color:TINT.warnText}}>Registro público de prueba</div>
                <div style={{fontSize:12,color:C.mid,marginTop:3,lineHeight:1.5}}>
                  Estado actual: <strong>{trialSignupExists ? (trialSignupOn ? 'activado' : 'apagado') : 'apagado / no configurado'}</strong>.
                  {' '}El alta automática todavía no tiene backend ni control de expiración: se habilita en una fase posterior (WEB-4B), no desde acá.
                </div>
              </div>
              <span style={{padding:'4px 10px',borderRadius:8,fontSize:11,fontWeight:800,letterSpacing:'.04em',whiteSpace:'nowrap',background:'var(--bg-subtle)',color:C.mid,border:`1px solid ${C.border}`}}>BLOQUEADO</span>
            </div>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

// ── Planes / Add-ons (WEB-6B) — editor de marketing_plans / marketing_add_ons ──
// Edición SOLO (sin alta ni borrado). slug = clave estable, read-only. Números
// validados como enteros ≥0 (vacío = null = "a cotizar"). RLS superadmin (mig 110).
const ADDON_PRICE_TYPES = {cuota:'Cuota mensual', comision:'Comisión', cotizar:'A cotizar'};
const fmtGsRaw = n => (n==null || n==='') ? 'A cotizar' : '₲ ' + Number(n).toLocaleString('es-PY');
// Entero opcional ≥0: '' → null; solo dígitos → number; otro → inválido.
function parseOptInt(s) {
  const t = String(s == null ? '' : s).trim();
  if (t === '') return { ok:true, value:null };
  if (!/^\d+$/.test(t)) return { ok:false, value:null };
  return { ok:true, value: parseInt(t, 10) };
}

function PlanEditModal({plan, onClose, setFlash, reload}) {
  const [name, setName]               = useState(plan.name||'');
  const [headline, setHeadline]       = useState(plan.headline||'');
  const [description, setDescription] = useState(plan.description||'');
  const [monthly, setMonthly]         = useState(plan.price_monthly_gs==null?'':String(plan.price_monthly_gs));
  const [annual, setAnnual]           = useState(plan.price_annual_gs==null?'':String(plan.price_annual_gs));
  const [badge, setBadge]             = useState(plan.badge||'');
  const [features, setFeatures]       = useState(asArr(plan.features).join('\n'));
  const [isRec, setIsRec]             = useState(plan.is_recommended===true);
  const [isEnt, setIsEnt]             = useState(plan.is_enterprise===true);
  const [isActive, setIsActive]       = useState(plan.is_active!==false);
  const [order, setOrder]             = useState(plan.sort_order==null?'0':String(plan.sort_order));
  const [saving, setSaving]           = useState(false);
  // Si el plan está vinculado a uno operativo (subscription_plans, mig 119), su precio
  // se sincroniza desde ahí (trigger en BD) → acá es SOLO-LECTURA, para no reintroducir
  // a mano la desincronización. El "Enterprise a cotizar" (sin link) sigue editable.
  const linked = !!plan.subscription_plan_id;

  const save = async () => {
    if (!db) { setFlash({type:'warn',text:'Sin conexión'}); return; }
    if (!name.trim()) { setFlash({type:'error',text:'El nombre es obligatorio'}); return; }
    const m = parseOptInt(monthly), a = parseOptInt(annual), o = parseOptInt(order);
    if (!m.ok) { setFlash({type:'error',text:'Precio mensual: solo números (vacío = a cotizar)'}); return; }
    if (!a.ok) { setFlash({type:'error',text:'Precio anual: solo números (vacío = a cotizar)'}); return; }
    if (!o.ok) { setFlash({type:'error',text:'Orden: solo números'}); return; }
    const feats = features.split('\n').map(s=>s.trim()).filter(Boolean);
    setSaving(true);
    const { error } = await db.from('marketing_plans').update({
      name: name.trim(),
      headline: headline.trim() || null,
      description: description.trim() || null,
      // Precio: solo si NO está vinculado. Si lo está, lo maneja el trigger de sync
      // desde subscription_plans (no se pisa la fuente única desde la vidriera).
      ...(linked ? {} : { price_monthly_gs: m.value, price_annual_gs: a.value }),
      badge: badge.trim() || null,
      features: feats,           // jsonb array de strings
      is_recommended: isRec,
      is_enterprise: isEnt,
      is_active: isActive,
      sort_order: o.value==null ? 0 : o.value,
      updated_at: new Date().toISOString(),
    }).eq('id', plan.id);        // slug NUNCA se envía (read-only)
    setSaving(false);
    if (error) { setFlash({type:'error',text:'No se pudo guardar el plan'}); return; }
    setFlash({type:'success',text:'Plan actualizado'});
    onClose(); reload();
  };

  return (
    <Modal title={`Editar plan — ${plan.name||plan.slug}`} onClose={onClose} width={560}>
      <FormField label="Slug (no editable)" hint="Clave estable que consume la web pública y el mapeo de billing.">
        <input value={plan.slug||''} disabled readOnly/>
      </FormField>
      <FormField label="Nombre">
        <input value={name} onChange={e=>setName(e.target.value)} placeholder="MYTHOS Servicio"/>
      </FormField>
      <FormField label="Titular (headline)">
        <input value={headline} onChange={e=>setHeadline(e.target.value)} placeholder="Sala y cocina, sincronizadas"/>
      </FormField>
      <FormField label="Descripción">
        <textarea value={description} onChange={e=>setDescription(e.target.value)} rows={2}/>
      </FormField>
      <div className="my-row-2" style={{gap:12}}>
        <FormField label="Precio mensual (₲)" hint={linked ? 'Sincronizado desde el plan operativo (Superadmin → Planes)' : 'Vacío = a cotizar'}>
          <GsInput value={monthly} onChange={setMonthly} placeholder="229000" disabled={linked} readOnly={linked}/>
        </FormField>
        <FormField label="Precio anual (₲)" hint={linked ? 'Derivado (mensual × 10)' : 'Vacío = a cotizar'}>
          <GsInput value={annual} onChange={setAnnual} placeholder="2290000" disabled={linked} readOnly={linked}/>
        </FormField>
      </div>
      <div className="my-row-2" style={{gap:12}}>
        <FormField label="Badge"><input value={badge} onChange={e=>setBadge(e.target.value)} placeholder="Recomendado"/></FormField>
        <FormField label="Orden"><input value={order} onChange={e=>setOrder(e.target.value)} placeholder="0"/></FormField>
      </div>
      <FormField label="Features (una por línea)" hint="Cada línea es un ítem de la lista del plan.">
        <textarea value={features} onChange={e=>setFeatures(e.target.value)} rows={6} placeholder={"Menú digital QR\nCaja/POS\nCocina/KDS"}/>
      </FormField>
      <div style={{display:'flex',gap:24,flexWrap:'wrap',marginBottom:10}}>
        <div style={{display:'flex',alignItems:'center',gap:8,fontSize:13,color:C.ink}}><Toggle checked={isRec} onChange={setIsRec}/><span>Recomendado</span></div>
        <div style={{display:'flex',alignItems:'center',gap:8,fontSize:13,color:C.ink}}><Toggle checked={isEnt} onChange={setIsEnt}/><span>Enterprise</span></div>
        <div style={{display:'flex',alignItems:'center',gap:8,fontSize:13,color:C.ink}}><Toggle checked={isActive} onChange={setIsActive}/><span>Activo</span></div>
      </div>
      <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:8}}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn onClick={save} disabled={saving}>{saving?'Guardando…':'Guardar'}</Btn>
      </div>
    </Modal>
  );
}

function SitioPlanes({plans, setFlash, reload}) {
  const [editing, setEditing] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const sorted = [...plans].sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));

  // Sincroniza la vidriera desde el panel operativo: el panel MANDA, el sitio
  // REFLEJA. Por cada plan operativo ACTIVO crea/actualiza su tarjeta (match por
  // subscription_plan_id), copiando nombre, precio mensual y estado + generando
  // la lista "incluye" desde su config. PRESERVA los campos propios del sitio
  // (descripción, badge, precio anual, orden) y la tarjeta manual "A cotizar".
  // Plan pausado/archivado → oculta su tarjeta.
  const syncFromPanel = async () => {
    if (!db) { setFlash({type:'warn',text:'Sin conexión — operación demo'}); return; }
    setSyncing(true);
    try {
      const [opRes, cardRes] = await Promise.all([
        db.from('subscription_plans').select('*'),
        db.from('marketing_plans').select('*'),
      ]);
      if (opRes.error) throw opRes.error;
      if (cardRes.error) throw cardRes.error;
      const ops = opRes.data || [];
      const cards = cardRes.data || [];
      let created = 0, updated = 0, hidden = 0;
      // Orden para nuevas tarjetas: después de la última "real", antes de la manual "A cotizar".
      let maxOrder = cards.filter(c=>!c.is_enterprise).reduce((m,c)=>Math.max(m, c.sort_order||0), 0);
      const usedSlugs = new Set(cards.map(c=>c.slug));

      // insert/update tolerante a que la columna plan_config aún no exista (mig 153/154).
      const writeMkt = async (isInsert, payload, id) => {
        const run = pl => isInsert ? db.from('marketing_plans').insert(pl) : db.from('marketing_plans').update(pl).eq('id', id);
        let { error } = await run(payload);
        if (error && /plan_config/.test(error.message||'')) {
          const { plan_config, ...rest } = payload;
          ({ error } = await run(rest));
        }
        return error;
      };

      const norm = s => String(s || '').trim().toLowerCase();
      for (const op of ops) {
        // Match por vínculo (subscription_plan_id); si falta, auto-repara por nombre
        // (tarjeta manual no-enterprise con el mismo nombre) para no duplicar.
        const existing = cards.find(c => c.subscription_plan_id === op.id)
          || cards.find(c => !c.subscription_plan_id && !c.is_enterprise && norm(c.name) === norm(op.name));
        const active = PLAN_ST(op) === 'active';
        const monthly = Math.round(Number(op.price_usd) || 0);
        if (active) {
          const payload = {
            name: op.name, price_monthly_gs: monthly, is_active: true,
            subscription_plan_id: op.id,   // (re)afirma el vínculo por si faltaba
            plan_config: buildMktConfig(op), features: buildSiteIncludes(op),
            updated_at: new Date().toISOString(),
          };
          if (existing) {
            // PRESERVA description / badge / price_annual_gs / sort_order / is_recommended.
            const err = await writeMkt(false, payload, existing.id);
            if (err) throw err;
            updated++;
          } else {
            let base = slugifyPlan(op.name), s = base, i = 2;
            while (usedSlugs.has(s)) s = base + '-' + (i++);
            usedSlugs.add(s);
            const err = await writeMkt(true, {
              ...payload, slug: s, headline: '', description: '',
              price_annual_gs: monthly * 10, currency: 'PYG',
              badge: null, is_recommended: false, is_enterprise: false,
              subscription_plan_id: op.id, sort_order: ++maxOrder,
            });
            if (err) throw err;
            created++;
          }
        } else if (existing && existing.is_active !== false) {
          // Operativo pausado/archivado → ocultar su tarjeta del sitio.
          const { error } = await db.from('marketing_plans').update({ is_active:false, updated_at:new Date().toISOString() }).eq('id', existing.id);
          if (error) throw error;
          hidden++;
        }
      }
      setFlash({ type:'ok', text:`Sitio actualizado desde el panel — ${created} creado(s) · ${updated} actualizado(s) · ${hidden} ocultado(s).` });
      reload();
    } catch(e) {
      setFlash({ type:'error', text:'Error al sincronizar: ' + (e.message || e) });
    }
    setSyncing(false);
  };

  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:16,marginBottom:14,flexWrap:'wrap'}}>
        <div style={{fontSize:12,color:C.mid,lineHeight:1.5,flex:'1 1 320px'}}>
          El <strong>panel operativo manda</strong>: estos planes alimentan <strong>/precios</strong> y la calculadora. Con <strong>“Actualizar sitio desde el panel”</strong> se copian nombre, precio y estado de cada plan operativo activo y se regenera su lista “incluye”. Se preservan descripción, badge, precio anual, orden y la tarjeta manual “A cotizar”. El <strong>slug</strong> es una clave estable y no se edita.
        </div>
        <Btn size="sm" onClick={syncFromPanel} disabled={syncing}>{syncing?'Sincronizando…':'↻ Actualizar sitio desde el panel'}</Btn>
      </div>
      <SectionCard>
        {sorted.length===0
          ? <div style={{padding:48,textAlign:'center',color:C.dim,fontSize:13}}>Sin planes cargados</div>
          : <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse'}}>
                <thead><tr>
                  <Th>Orden</Th><Th>Nombre</Th><Th>Slug</Th><Th>Mensual</Th><Th>Anual</Th><Th>Estado</Th><Th></Th>
                </tr></thead>
                <tbody>
                  {sorted.map(p=>(
                    <tr key={p.id}>
                      <Td style={{color:C.mid}}>{p.sort_order??0}</Td>
                      <Td>
                        <div style={{fontWeight:600}}>{p.name||'—'}</div>
                        <div style={{display:'flex',gap:6,marginTop:3,flexWrap:'wrap'}}>
                          {p.badge && <span style={{padding:'1px 8px',borderRadius:10,fontSize:10.5,fontWeight:700,background:C.bg,color:C.mid,border:`1px solid ${C.border}`}}>{p.badge}</span>}
                          {p.is_recommended && (p.badge||'').trim().toLowerCase()!=='recomendado' && <span style={{padding:'1px 8px',borderRadius:10,fontSize:10.5,fontWeight:700,background:C.bg,color:C.mid,border:`1px solid ${C.border}`}}>Recomendado</span>}
                          {p.is_enterprise && <span style={{padding:'1px 8px',borderRadius:10,fontSize:10.5,fontWeight:700,background:C.bg,color:C.mid,border:`1px solid ${C.border}`}}>Enterprise</span>}
                        </div>
                      </Td>
                      <Td style={{fontSize:12,color:C.mid,fontFamily:"'SF Mono',ui-monospace,monospace"}}>{p.slug}</Td>
                      <Td style={{whiteSpace:'nowrap'}}>{fmtGsRaw(p.price_monthly_gs)}</Td>
                      <Td style={{whiteSpace:'nowrap'}}>{fmtGsRaw(p.price_annual_gs)}</Td>
                      <Td><Badge status={p.is_active!==false?'active':'inactive'}/></Td>
                      <Td style={{whiteSpace:'nowrap'}}><Btn size="sm" variant="ghost" onClick={()=>setEditing(p)}>Editar</Btn></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}
      </SectionCard>
      {editing && <PlanEditModal plan={editing} onClose={()=>setEditing(null)} setFlash={setFlash} reload={reload}/>}
    </div>
  );
}

function AddonEditModal({addon, onClose, setFlash, reload}) {
  const [name, setName]               = useState(addon.name||'');
  const [description, setDescription] = useState(addon.description||'');
  const [price, setPrice]             = useState(addon.price_gs==null?'':String(addon.price_gs));
  const [priceType, setPriceType]     = useState(['cuota','comision','cotizar'].includes(addon.price_type)?addon.price_type:'cuota');
  const [isActive, setIsActive]       = useState(addon.is_active!==false);
  const [order, setOrder]             = useState(addon.sort_order==null?'0':String(addon.sort_order));
  const [saving, setSaving]           = useState(false);

  const save = async () => {
    if (!db) { setFlash({type:'warn',text:'Sin conexión'}); return; }
    if (!name.trim()) { setFlash({type:'error',text:'El nombre es obligatorio'}); return; }
    if (!['cuota','comision','cotizar'].includes(priceType)) { setFlash({type:'error',text:'Tipo de precio inválido'}); return; }
    const pr = parseOptInt(price), o = parseOptInt(order);
    if (!pr.ok) { setFlash({type:'error',text:'Precio: solo números (vacío = sin precio)'}); return; }
    if (!o.ok) { setFlash({type:'error',text:'Orden: solo números'}); return; }
    setSaving(true);
    const { error } = await db.from('marketing_add_ons').update({
      name: name.trim(),
      description: description.trim() || null,
      price_gs: pr.value,
      price_type: priceType,
      is_active: isActive,
      sort_order: o.value==null ? 0 : o.value,
      updated_at: new Date().toISOString(),
    }).eq('id', addon.id);      // slug NUNCA se envía (read-only)
    setSaving(false);
    if (error) { setFlash({type:'error',text:'No se pudo guardar el add-on'}); return; }
    setFlash({type:'success',text:'Add-on actualizado'});
    onClose(); reload();
  };

  return (
    <Modal title={`Editar add-on — ${addon.name||addon.slug}`} onClose={onClose} width={520}>
      <FormField label="Slug (no editable)" hint="Clave estable que consume la web pública.">
        <input value={addon.slug||''} disabled readOnly/>
      </FormField>
      <FormField label="Nombre"><input value={name} onChange={e=>setName(e.target.value)} placeholder="Facturación electrónica"/></FormField>
      <FormField label="Descripción"><textarea value={description} onChange={e=>setDescription(e.target.value)} rows={2}/></FormField>
      <div className="my-row-2" style={{gap:12}}>
        <FormField label="Precio (₲)" hint="Vacío = sin precio">
          <GsInput value={price} onChange={setPrice} placeholder="150000"/>
        </FormField>
        <FormField label="Tipo de precio">
          <select value={priceType} onChange={e=>setPriceType(e.target.value)}>
            <option value="cuota">Cuota mensual</option>
            <option value="comision">Comisión</option>
            <option value="cotizar">A cotizar</option>
          </select>
        </FormField>
      </div>
      <FormField label="Orden"><input value={order} onChange={e=>setOrder(e.target.value)} placeholder="0"/></FormField>
      <div style={{display:'flex',alignItems:'center',gap:8,fontSize:13,color:C.ink,marginBottom:10}}><Toggle checked={isActive} onChange={setIsActive}/><span>Activo</span></div>
      <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:8}}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn onClick={save} disabled={saving}>{saving?'Guardando…':'Guardar'}</Btn>
      </div>
    </Modal>
  );
}

/* ── Planes de PROVEEDOR (vidriera pública de /proveedores) — mig 179 + 199 ──
   Faltaba el editor: `marketing_supplier_plans` (lo que ve el público) no se
   podía tocar desde ningún panel, así que cambiar el precio en Proveedores ›
   Planes dejaba /proveedores mostrando el precio VIEJO y sin arreglo posible
   fuera del SQL Editor. Con la mig 199 el operativo empuja el precio por trigger;
   acá se edita lo EDITORIAL (nombre, titular, features, badge, orden).
   El precio queda de solo lectura cuando la tarjeta está linkeada: la fuente
   única es el plan operativo — "gana el panel". */
function SupplierPlanEditModal({plan, onClose, setFlash, reload}) {
  const [name, setName]               = useState(plan.name||'');
  const [headline, setHeadline]       = useState(plan.headline||'');
  const [description, setDescription] = useState(plan.description||'');
  const [badge, setBadge]             = useState(plan.badge||'');
  const [features, setFeatures]       = useState(asArr(plan.features).join('\n'));
  const [isRec, setIsRec]             = useState(plan.is_recommended===true);
  const [isActive, setIsActive]       = useState(plan.is_active!==false);
  const [order, setOrder]             = useState(plan.sort_order==null?'0':String(plan.sort_order));
  const [monthly, setMonthly]         = useState(plan.price_monthly_gs==null?'':String(plan.price_monthly_gs));
  const [saving, setSaving]           = useState(false);
  const linked = !!plan.supplier_plan_slug;

  const save = async () => {
    if (!db) { setFlash({type:'warn',text:'Sin conexión'}); return; }
    if (!name.trim()) { setFlash({type:'error',text:'El nombre es obligatorio'}); return; }
    const m = parseOptInt(monthly), o = parseOptInt(order);
    if (!m.ok) { setFlash({type:'error',text:'Precio mensual: solo números'}); return; }
    if (!o.ok) { setFlash({type:'error',text:'Orden: solo números'}); return; }
    setSaving(true);
    const { error } = await db.from('marketing_supplier_plans').update({
      name: name.trim(),
      headline: headline.trim() || null,
      description: description.trim() || null,
      badge: badge.trim() || null,
      features: features.split('\n').map(s=>s.trim()).filter(Boolean),
      is_recommended: isRec,
      is_active: isActive,
      sort_order: o.value==null ? 0 : o.value,
      // Precio: solo si la tarjeta NO está linkeada al plan operativo. Si lo está,
      // el trigger lo re-deriva igual — mandarlo a mano solo reintroduciría drift.
      ...(linked ? {} : { price_monthly_gs: m.value, price_annual_gs: m.value==null?null:m.value*10 }),
      updated_at: new Date().toISOString(),
    }).eq('id', plan.id);          // slug NUNCA se envía (read-only)
    setSaving(false);
    if (error) { setFlash({type:'error',text:'No se pudo guardar el plan'}); return; }
    setFlash({type:'success',text:'Plan de proveedor actualizado'});
    onClose(); reload();
  };

  return (
    <Modal title={`Editar plan de proveedor — ${plan.name||plan.slug}`} onClose={onClose} width={560}>
      <FormField label="Slug (no editable)" hint="Clave estable que consume /proveedores y el alta de solicitudes.">
        <input value={plan.slug||''} disabled readOnly/>
      </FormField>
      <FormField label="Nombre"><input value={name} onChange={e=>setName(e.target.value)} placeholder="Profesional"/></FormField>
      <FormField label="Titular (headline)"><input value={headline} onChange={e=>setHeadline(e.target.value)} placeholder="El plan que más venden"/></FormField>
      <FormField label="Descripción"><textarea value={description} onChange={e=>setDescription(e.target.value)} rows={2}/></FormField>
      <div className="my-row-2" style={{gap:12}}>
        <FormField label="Precio mensual (₲)"
          hint={linked ? 'Sincronizado desde Proveedores › Planes (fuente única)' : 'Tarjeta sin plan operativo: precio libre'}>
          <GsInput value={monthly} onChange={setMonthly} placeholder="199000" disabled={linked} readOnly={linked}/>
        </FormField>
        <FormField label="Orden"><input value={order} onChange={e=>setOrder(e.target.value)} placeholder="0"/></FormField>
      </div>
      <FormField label="Badge"><input value={badge} onChange={e=>setBadge(e.target.value)} placeholder="Recomendado"/></FormField>
      <FormField label="Features (una por línea)" hint="Prometé solo lo que el plan operativo entrega: los límites se aplican por trigger.">
        <textarea value={features} onChange={e=>setFeatures(e.target.value)} rows={7} placeholder={"Hasta 50 productos\nContacto de leads inmediato\n1 producto destacado"}/>
      </FormField>
      <div style={{display:'flex',gap:24,flexWrap:'wrap',marginBottom:10}}>
        <div style={{display:'flex',alignItems:'center',gap:8,fontSize:13,color:C.ink}}><Toggle checked={isRec} onChange={setIsRec}/><span>Recomendado</span></div>
        <div style={{display:'flex',alignItems:'center',gap:8,fontSize:13,color:C.ink}}><Toggle checked={isActive} onChange={setIsActive}/><span>Visible en la web</span></div>
      </div>
      <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:8}}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn onClick={save} disabled={saving}>{saving?'Guardando…':'Guardar'}</Btn>
      </div>
    </Modal>
  );
}

function SitioPlanesProveedor({plans, setFlash, reload}) {
  const [editing, setEditing] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const sorted = [...plans].sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));

  // Re-tirar precio y límites desde el plan operativo. Con la mig 199 el push es
  // automático (trigger); este botón queda como red: si la 199 todavía no está
  // aplicada, tocar la fila dispara el trigger de la 179 (BEFORE UPDATE), que
  // re-deriva precio y plan_config desde marketplace_supplier_plans.
  const syncFromPanel = async () => {
    if (!db) { setFlash({type:'warn',text:'Sin conexión — operación demo'}); return; }
    setSyncing(true);
    try {
      const linked = plans.filter(p=>p.supplier_plan_slug);
      for (const p of linked) {
        await db.from('marketing_supplier_plans').update({updated_at:new Date().toISOString()}).eq('id',p.id);
      }
      setFlash({type:'ok',text:`Vidriera sincronizada (${linked.length} plan${linked.length===1?'':'es'})`});
      reload();
    } catch(e) { setFlash({type:'error',text:'No se pudo sincronizar: '+e.message}); }
    setSyncing(false);
  };

  return (
    <div className="animate-in">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,marginBottom:14,flexWrap:'wrap'}}>
        <span style={{fontSize:12,color:C.mid}}>
          Lo que ve el público en <b style={{color:C.ink}}>/proveedores</b>. Los límites reales se configuran en Proveedores › Planes.
        </span>
        <Btn variant="ghost" size="sm" onClick={syncFromPanel} disabled={syncing}>
          {syncing?'Sincronizando…':'Sincronizar precios'}
        </Btn>
      </div>
      {sorted.length===0 ? (
        <MkEmpty text="Sin planes de proveedor en la vidriera. Aplicá la migración 179 para sembrarlos."/>
      ) : (
        <SectionCard>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',minWidth:720}}>
              <thead><tr>
                <Th style={{width:56,textAlign:'center'}}>Orden</Th><Th>Plan</Th><Th>Titular</Th>
                <Th style={{textAlign:'right'}}>Mensual</Th><Th style={{textAlign:'center'}}>Features</Th>
                <Th style={{textAlign:'center'}}>Web</Th><Th style={{textAlign:'right'}}>Acciones</Th>
              </tr></thead>
              <tbody>
                {sorted.map(p=>(
                  <tr key={p.id}>
                    <Td style={{textAlign:'center',color:C.mid}}>{p.sort_order}</Td>
                    <Td>
                      <span style={{fontWeight:600,color:C.ink}}>{p.name}</span>
                      {p.is_recommended && <span style={{marginLeft:7,padding:'1px 7px',borderRadius:20,fontSize:10,fontWeight:700,background:TINT.okBg,color:TINT.okText}}>{p.badge||'Recomendado'}</span>}
                      <div><code style={{fontSize:11,color:C.dim}}>{p.slug}</code>
                        {p.supplier_plan_slug && <span style={{fontSize:10.5,color:C.dim}}> · linkeado a {p.supplier_plan_slug}</span>}</div>
                    </Td>
                    <Td><span style={{fontSize:12,color:C.mid}}>{p.headline||'—'}</span></Td>
                    <Td style={{textAlign:'right'}}>{fmtGsRaw(p.price_monthly_gs)}</Td>
                    <Td style={{textAlign:'center',color:C.mid}}>{asArr(p.features).length}</Td>
                    <Td style={{textAlign:'center'}}>
                      <span style={{padding:'2px 9px',borderRadius:20,fontSize:11,fontWeight:600,
                        background:p.is_active!==false?TINT.okBg:'var(--bg-subtle)',
                        color:p.is_active!==false?TINT.okText:C.mid}}>{p.is_active!==false?'Visible':'Oculto'}</span>
                    </Td>
                    <Td style={{textAlign:'right'}}><Btn variant="ghost" size="sm" onClick={()=>setEditing(p)}>Editar</Btn></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
      {editing && <SupplierPlanEditModal plan={editing} onClose={()=>setEditing(null)} setFlash={setFlash} reload={reload}/>}
    </div>
  );
}

function SitioAddons({addons, setFlash, reload}) {
  const [editing, setEditing] = useState(null);
  const sorted = [...addons].sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
  return (
    <div>
      <div style={{fontSize:12,color:C.mid,marginBottom:14,lineHeight:1.5}}>
        Add-ons que aparecen en la calculadora de <strong>/precios</strong>. El <strong>slug</strong> es una clave estable y no se edita.
      </div>
      <SectionCard>
        {sorted.length===0
          ? <div style={{padding:48,textAlign:'center',color:C.dim,fontSize:13}}>Sin add-ons cargados</div>
          : <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse'}}>
                <thead><tr>
                  <Th>Orden</Th><Th>Nombre</Th><Th>Slug</Th><Th>Precio</Th><Th>Tipo</Th><Th>Estado</Th><Th></Th>
                </tr></thead>
                <tbody>
                  {sorted.map(a=>(
                    <tr key={a.id}>
                      <Td style={{color:C.mid}}>{a.sort_order??0}</Td>
                      <Td style={{fontWeight:600}}>{a.name||'—'}</Td>
                      <Td style={{fontSize:12,color:C.mid,fontFamily:"'SF Mono',ui-monospace,monospace"}}>{a.slug}</Td>
                      <Td style={{whiteSpace:'nowrap'}}>{a.price_type==='cotizar'?'A cotizar':fmtGsRaw(a.price_gs)}</Td>
                      <Td style={{fontSize:12,color:C.mid}}>{ADDON_PRICE_TYPES[a.price_type]||a.price_type||'—'}</Td>
                      <Td><Badge status={a.is_active!==false?'active':'inactive'}/></Td>
                      <Td style={{whiteSpace:'nowrap'}}><Btn size="sm" variant="ghost" onClick={()=>setEditing(a)}>Editar</Btn></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}
      </SectionCard>
      {editing && <AddonEditModal addon={editing} onClose={()=>setEditing(null)} setFlash={setFlash} reload={reload}/>}
    </div>
  );
}

// ── Contenido (WEB-6C) — FAQs (CRUD) + Testimonios (solo reales) ──────────
// CRUD vía cliente autenticado (RLS superadmin, mig 110). Delete con confirm de
// 2 pasos (no hay primitive de confirm en el panel). Testimonios: NO inventar;
// vacío = estado honesto (el sitio público oculta la sección sin datos).
function FaqEditModal({faq, onClose, setFlash, reload}) {
  const isNew = !faq.id;
  const [question, setQuestion] = useState(faq.question||'');
  const [answer, setAnswer]     = useState(faq.answer||'');
  const [isActive, setIsActive] = useState(faq.is_active!==false);
  const [order, setOrder]       = useState(faq.sort_order==null?'0':String(faq.sort_order));
  const [saving, setSaving]     = useState(false);

  const save = async () => {
    if (!db) { setFlash({type:'warn',text:'Sin conexión'}); return; }
    if (!question.trim() || !answer.trim()) { setFlash({type:'error',text:'Pregunta y respuesta son obligatorias'}); return; }
    const o = parseOptInt(order);
    if (!o.ok) { setFlash({type:'error',text:'Orden: solo números'}); return; }
    const payload = { question:question.trim(), answer:answer.trim(), is_active:isActive, sort_order:o.value==null?0:o.value, updated_at:new Date().toISOString() };
    setSaving(true);
    const { error } = isNew
      ? await db.from('marketing_faqs').insert(payload)
      : await db.from('marketing_faqs').update(payload).eq('id', faq.id);
    setSaving(false);
    if (error) { setFlash({type:'error',text:'No se pudo guardar la FAQ'}); return; }
    setFlash({type:'success',text:isNew?'FAQ creada':'FAQ actualizada'});
    onClose(); reload();
  };

  return (
    <Modal title={isNew?'Nueva pregunta':'Editar pregunta'} onClose={onClose} width={560}>
      <FormField label="Pregunta"><input value={question} onChange={e=>setQuestion(e.target.value)} placeholder="¿Necesito conocimientos técnicos?"/></FormField>
      <FormField label="Respuesta"
                 hint="Escribí {trial_days} donde vaya la duración de la prueba: el sitio lo reemplaza por los días configurados en Prueba gratis. Si ponés el número a mano, queda desactualizado cuando lo cambies ahí.">
        <textarea value={answer} onChange={e=>setAnswer(e.target.value)} rows={4}/>
      </FormField>
      <div className="my-row-2" style={{gap:12,alignItems:'center'}}>
        <FormField label="Orden"><input value={order} onChange={e=>setOrder(e.target.value)} placeholder="0"/></FormField>
        <div style={{display:'flex',alignItems:'center',gap:8,fontSize:13,color:C.ink,marginTop:8}}><Toggle checked={isActive} onChange={setIsActive}/><span>Activa</span></div>
      </div>
      <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:8}}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn onClick={save} disabled={saving}>{saving?'Guardando…':'Guardar'}</Btn>
      </div>
    </Modal>
  );
}

function FaqManager({faqs, setFlash, reload}) {
  const [editing, setEditing] = useState(null);
  const sorted = [...faqs].sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));

  const toggleActive = async (f) => {
    if (!db) return;
    const { error } = await db.from('marketing_faqs').update({is_active:!(f.is_active!==false), updated_at:new Date().toISOString()}).eq('id', f.id);
    if (error) { setFlash({type:'error',text:'No se pudo actualizar'}); return; }
    setFlash({type:'ok',text:'FAQ actualizada'}); reload();
  };

  return (
    <SectionCard title="Preguntas frecuentes" action={<Btn size="sm" onClick={()=>setEditing({})}>+ Nueva</Btn>} style={{marginBottom:18}}>
      {sorted.length===0
        ? <div style={{padding:40,textAlign:'center',color:C.dim,fontSize:13}}>Sin preguntas cargadas</div>
        : sorted.map(f=>(
            <div key={f.id} style={{padding:'14px 20px',borderBottom:`1px solid ${C.border}`,display:'flex',gap:14,alignItems:'flex-start'}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                  <span style={{fontSize:11,color:C.mid,fontWeight:700}}>#{f.sort_order??0}</span>
                  <span style={{fontWeight:600,fontSize:13}}>{f.question}</span>
                  {!(f.is_active!==false) && <Badge status="inactive"/>}
                </div>
                <div style={{fontSize:12,color:C.mid,marginTop:3,lineHeight:1.5}}>{f.answer}</div>
              </div>
              <div style={{display:'flex',gap:6,alignItems:'center',flexShrink:0}}>
                <Toggle checked={f.is_active!==false} onChange={()=>toggleActive(f)}/>
                <Btn size="sm" variant="ghost" onClick={()=>setEditing(f)}>Editar</Btn>
              </div>
            </div>
          ))}
      {editing && <FaqEditModal faq={editing} onClose={()=>setEditing(null)} setFlash={setFlash} reload={reload}/>}
    </SectionCard>
  );
}

function TestimonialEditModal({item, onClose, setFlash, reload}) {
  const isNew = !item.id;
  const [personName, setPersonName]   = useState(item.person_name||'');
  const [businessName, setBusinessName] = useState(item.business_name||'');
  const [role, setRole]               = useState(item.role||'');
  const [quote, setQuote]             = useState(item.quote||'');
  const [isActive, setIsActive]       = useState(item.is_active!==false);
  const [order, setOrder]             = useState(item.sort_order==null?'0':String(item.sort_order));
  const [saving, setSaving]           = useState(false);

  const save = async () => {
    if (!db) { setFlash({type:'warn',text:'Sin conexión'}); return; }
    if (!personName.trim() || !quote.trim()) { setFlash({type:'error',text:'Nombre y testimonio son obligatorios'}); return; }
    const o = parseOptInt(order);
    if (!o.ok) { setFlash({type:'error',text:'Orden: solo números'}); return; }
    const payload = { person_name:personName.trim(), business_name:businessName.trim()||null, role:role.trim()||null, quote:quote.trim(), is_active:isActive, sort_order:o.value==null?0:o.value, updated_at:new Date().toISOString() };
    setSaving(true);
    const { error } = isNew
      ? await db.from('marketing_testimonials').insert(payload)
      : await db.from('marketing_testimonials').update(payload).eq('id', item.id);
    setSaving(false);
    if (error) { setFlash({type:'error',text:'No se pudo guardar el testimonio'}); return; }
    setFlash({type:'success',text:isNew?'Testimonio creado':'Testimonio actualizado'});
    onClose(); reload();
  };

  return (
    <Modal title={isNew?'Nuevo testimonio':'Editar testimonio'} onClose={onClose} width={560}>
      <div style={{padding:'9px 12px',marginBottom:14,fontSize:12,color:C.mid,border:`1px solid ${C.border}`,borderRadius:8,lineHeight:1.5}}>Cargá solo testimonios <strong>reales</strong> y con consentimiento. No inventes prueba social.</div>
      <div className="my-row-2" style={{gap:12}}>
        <FormField label="Nombre"><input value={personName} onChange={e=>setPersonName(e.target.value)}/></FormField>
        <FormField label="Restaurante"><input value={businessName} onChange={e=>setBusinessName(e.target.value)}/></FormField>
      </div>
      <FormField label="Rol / cargo"><input value={role} onChange={e=>setRole(e.target.value)} placeholder="Dueño, Encargada…"/></FormField>
      <FormField label="Testimonio"><textarea value={quote} onChange={e=>setQuote(e.target.value)} rows={4}/></FormField>
      <div className="my-row-2" style={{gap:12,alignItems:'center'}}>
        <FormField label="Orden"><input value={order} onChange={e=>setOrder(e.target.value)} placeholder="0"/></FormField>
        <div style={{display:'flex',alignItems:'center',gap:8,fontSize:13,color:C.ink,marginTop:8}}><Toggle checked={isActive} onChange={setIsActive}/><span>Activo</span></div>
      </div>
      <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:8}}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn onClick={save} disabled={saving}>{saving?'Guardando…':'Guardar'}</Btn>
      </div>
    </Modal>
  );
}

function TestimonialManager({testimonials, setFlash, reload}) {
  const [editing, setEditing] = useState(null);
  const sorted = [...testimonials].sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));

  const toggleActive = async (t) => {
    if (!db) return;
    const { error } = await db.from('marketing_testimonials').update({is_active:!(t.is_active!==false), updated_at:new Date().toISOString()}).eq('id', t.id);
    if (error) { setFlash({type:'error',text:'No se pudo actualizar'}); return; }
    setFlash({type:'ok',text:'Testimonio actualizado'}); reload();
  };

  return (
    <SectionCard title="Testimonios" action={<Btn size="sm" onClick={()=>setEditing({})}>+ Nuevo</Btn>}>
      {sorted.length===0
        ? <div style={{padding:40,textAlign:'center',color:C.dim,fontSize:13,lineHeight:1.6}}>Sin testimonios cargados. Agregá solo testimonios reales; el sitio público no muestra la sección hasta que haya datos.</div>
        : sorted.map(t=>(
            <div key={t.id} style={{padding:'14px 20px',borderBottom:`1px solid ${C.border}`,display:'flex',gap:14,alignItems:'flex-start'}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                  <span style={{fontWeight:600,fontSize:13}}>{t.person_name}</span>
                  {t.business_name && <span style={{fontSize:12,color:C.mid}}>· {t.business_name}</span>}
                  {!(t.is_active!==false) && <Badge status="inactive"/>}
                </div>
                <div style={{fontSize:12,color:C.mid,marginTop:3,lineHeight:1.5,fontStyle:'italic'}}>“{t.quote}”</div>
              </div>
              <div style={{display:'flex',gap:6,alignItems:'center',flexShrink:0}}>
                <Toggle checked={t.is_active!==false} onChange={()=>toggleActive(t)}/>
                <Btn size="sm" variant="ghost" onClick={()=>setEditing(t)}>Editar</Btn>
              </div>
            </div>
          ))}
      {editing && <TestimonialEditModal item={editing} onClose={()=>setEditing(null)} setFlash={setFlash} reload={reload}/>}
    </SectionCard>
  );
}

function SitioContenido({faqs, testimonials, setFlash, reload}) {
  return (
    <div>
      <div style={{fontSize:12,color:C.mid,marginBottom:14,lineHeight:1.5}}>
        Las FAQs activas se publican en <strong>/inicio#faq</strong>. Los testimonios se cargan solo reales; el sitio oculta la sección si no hay ninguno. Para ocultar contenido, desactivalo con el interruptor (no se borra de la base).
      </div>
      <FaqManager faqs={faqs} setFlash={setFlash} reload={reload}/>
      <TestimonialManager testimonials={testimonials} setFlash={setFlash} reload={reload}/>
    </div>
  );
}

/* ══════════════════════════════════════════════
   SITIO WEB › FORMULARIOS — qué contesta la gente que se registra
   ──────────────────────────────────────────────
   Los formularios públicos (registro de dueños, onboarding, proveedores,
   contacto) se guardaban pero SOLO se leían de a una fila, en cuatro tablas y
   desde tres páginas distintas del panel. No había forma de responder "¿cuántos
   dueños tienen delivery propio?" o "¿qué medio de pago pide todo el mundo?",
   que es justamente para lo que se pregunta.

   Esta pestaña dibuja cada formulario CON SU FORMA ORIGINAL — las preguntas en
   el orden en que se hacen y TODAS las opciones, incluidas las que nadie eligió
   (que son las que hay que mirar: una opción en cero puede significar que
   sobra… o que está mal redactada).

   Los conteos salen de la RPC `form_analytics` (mig 198), que agrega del lado
   de la BASE sobre todo el historial. NO se agrupa el array `leads` del panel:
   se carga con .limit(500), así que ese número empeoraría cuanto más creciera
   el negocio — el mismo error que la mig 197 tuvo que arreglar en el CRM.

   Las ETIQUETAS viven acá y no en la base, copiadas del formulario real, para
   que reescribir una opción no exija una migración y para poder mostrar las
   opciones con cero respuestas.
══════════════════════════════════════════════ */
const FORM_NONE = '__none__';   // clave que usa la RPC para "no respondió / vacío"

const FORM_SPECS = [
  {
    id:'duenos_registro', label:'Dueños · Crear cuenta', page:'/registro', accent:'#007AFF',
    intro:'Lo que completa un dueño para abrir su cuenta. El lead se guarda siempre, aunque después no verifique el correo ni contrate.',
    questions:[
      {key:'tipo_negocio', label:'¿Qué tipo de negocio tenés?', options:[
        ['restaurante','Tengo un restaurante / local gastronómico'],
        ['foodpark_local','Tengo un local en un foodpark o patio de comidas'],
        ['foodpark_owner','Soy dueño de un foodpark (botón «Próximamente»)'],
      ]},
      {key:'contacto', label:'¿Por dónde se lo puede contactar?',
       hint:'El WhatsApp es obligatorio desde la migración 198: los «solo email» y «sin contacto» son registros anteriores a ese cambio.',
       options:[['whatsapp','WhatsApp'],['solo_email','Solo email'],['sin_contacto','Ningún contacto']]},
      {key:'origen', label:'¿Desde dónde llegó?', options:[
        ['web_registro','Formulario de registro'],['interes_foodpark','Interés en foodpark']]},
      {key:'verificado', label:'¿Verificó el correo?', options:[['si','Sí'],['no','No']]},
      {key:'estado', label:'Estado del prospecto', options:[
        ['registrado','Registrado'],['onboarding','En onboarding'],['contactado','Contactado'],
        ['calificado','Calificado'],['convertido','Convertido'],['descartado','Descartado']]},
    ]
  },
  {
    id:'duenos_onboarding', label:'Dueños · Onboarding', page:'/onboarding', accent:'#34C759',
    intro:'El wizard de 7 pasos que completa el dueño al crear su local. Es la radiografía de cómo trabaja realmente la base de clientes.',
    questions:[
      {key:'business_type', label:'Paso 1 · ¿Qué tipo de negocio es?', options:[
        ['restaurante','Restaurante, bar o cafetería'],
        ['foodpark_local','Local gastronómico dentro de un foodpark'],
        ['delivery_dark','Delivery o cocina oculta'],
        ['otro','Otro tipo de local gastronómico']]},
      {key:'onboarding', label:'¿Terminó el onboarding?', options:[
        ['completado','Lo terminó'],['incompleto','Quedó a mitad de camino']]},
      {key:'contacto', label:'Paso 3 · WhatsApp del local', options:[
        ['whatsapp','WhatsApp cargado'],['solo_telefono','Solo teléfono fijo'],['sin_contacto','Ningún contacto']]},
      {key:'operation_modes', label:'Paso 4 · ¿Cómo atendés hoy?', multi:true, options:[
        ['mesas_salon','Mesas en salón'],['retiro_local','Retiro en el local'],
        ['delivery_propio','Delivery propio'],['whatsapp','Pedidos por WhatsApp'],
        ['apps_externas','Pedidos por apps externas']]},
      {key:'order_intake', label:'Paso 4 · ¿Cómo se cargan los pedidos?', multi:true, options:[
        ['mozo','Los toma el mozo'],['caja','Los carga la caja'],
        ['qr_cliente','El cliente pide desde el QR'],['papel','Por ahora, papel o manual']]},
      {key:'kitchen_routing', label:'Paso 4 · ¿Cómo llega el pedido a cocina o barra?', options:[
        ['kds','Pantalla de cocina (KDS)'],['tablet','Tablet o celular'],
        ['impresora','Impresora de comandas'],['manual','Todavía manual']]},
      {key:'mesas', label:'Paso 4 · Cantidad aproximada de mesas', options:[
        ['sin_mesas','Sin mesas'],['1_10','1 a 10'],['11_30','11 a 30'],['31_mas','31 o más']]},
      {key:'payment_methods', label:'Paso 5 · ¿Qué medios de pago aceptás?', multi:true, options:[
        ['efectivo','Efectivo'],['transferencia','Transferencia'],['tarjeta','Tarjeta / POS'],
        ['qr_bancard','QR Bancard'],['qr_billetera','QR de otra billetera'],['contra_entrega','Pago contra entrega']]},
      {key:'einvoicing_status', label:'Paso 5 · ¿Emitís factura actualmente?', options:[
        ['no','No por ahora'],['impresa','Sí, factura impresa o preimpresa'],
        ['electronica','Sí, factura electrónica'],['interesa','Me interesa activarla más adelante']]},
      {key:'print_needs', label:'Paso 5 · ¿Qué necesitás imprimir?', multi:true, options:[
        ['ticket_cliente','Ticket / cuenta para el cliente'],['comanda_cocina','Comanda para cocina'],
        ['comanda_barra','Comanda para barra'],['factura_legal','Factura legal'],['ninguno','No imprimo por ahora']]},
    ]
  },
  {
    id:'proveedores', label:'Proveedores', page:'/proveedores', accent:'#AF52DE',
    // El alta se acortó a 3 pasos (nombre, RUC, ciudad, tipo · WhatsApp, email,
    // rubro · confirmación): pedir 30 campos antes de dejar entrar espantaba
    // proveedores, y el resto del perfil ahora se completa desde el panel. Las
    // preguntas retiradas (años en el mercado, condiciones, zonas) siguen en la
    // base para las solicitudes históricas, pero ya no se preguntan.
    intro:'Solicitudes para sumarse al marketplace. Tres pasos: empresa, contacto y rubro, confirmación.',
    questions:[
      {key:'tipo_proveedor', label:'Paso 1 · Tipo de proveedor', options:[
        ['productor','Productor'],['distribuidor','Distribuidor'],['mayorista','Mayorista'],
        ['minorista','Minorista'],['importador','Importador'],['fabricante','Fabricante'],['servicio','Servicio']]},
      {key:'ciudad', label:'Paso 1 · Ciudad', dynamic:true},
      {key:'contacto', label:'Paso 2 · ¿Por dónde se lo puede contactar?', options:[
        ['whatsapp','WhatsApp'],['solo_telefono','Solo teléfono'],['sin_contacto','Ningún contacto']]},
      {key:'categorias', label:'Paso 2 · ¿Qué vendés?', multi:true, dynamic:true,
       hint:'El catálogo lo administra el propio marketplace, por eso las opciones salen de los datos.'},
      {key:'plan_slug', label:'Plan elegido', dynamic:true},
      {key:'estado', label:'Estado de la solicitud', options:[
        ['pendiente','Pendiente'],['en_revision','En revisión'],['falta_info','Falta info'],
        ['aprobada','Aprobada'],['rechazada','Rechazada']]},
    ]
  },
  {
    id:'delivery', label:'Delivery · Repartidores', page:'/riders', accent:'#FF9500',
    // Esta sección mide el ALTA real de la Red de Riders (mythos_riders), no la
    // encuesta de demanda: esa vive en la pestaña Encuestas, con sus preguntas
    // guardadas en la base (mig 211). Mientras el alta esté cerrada este número
    // va a quedar en cero, y está bien: es lo que está pasando.
    intro:'Postulaciones reales a la Red de Riders. La encuesta previa de interés está en la pestaña «Encuestas».',
    questions:[]
  },
  {
    id:'clientes_web', label:'Clientes · Interesados de la web', page:'/contacto', accent:'#FFD60A',
    intro:'Los que dejan sus datos en el sitio pidiendo información, una demo o una prueba. Todavía no son clientes.',
    questions:[
      {key:'type', label:'¿En qué te ayudamos?', options:[
        ['contact','Contacto general'],['demo','Quiero una demo'],
        ['trial_interest','Me interesa probar MYTHOS'],['whatsapp','Vino por WhatsApp'],['pricing','Consulta de precios']]},
      {key:'contacto', label:'¿Por dónde se lo puede contactar?', options:[
        ['whatsapp','WhatsApp'],['solo_email','Solo email'],['sin_contacto','Ningún contacto']]},
      {key:'plan_slug', label:'Plan que estaba mirando', dynamic:true},
      {key:'selected_addons', label:'Add-ons marcados', multi:true, dynamic:true},
      {key:'source', label:'Página desde la que escribió', dynamic:true},
      {key:'status', label:'Estado del lead', options:[
        ['new','Nuevo'],['contacted','Contactado'],['qualified','Calificado'],
        ['won','Ganado'],['lost','Perdido'],['spam','Spam']]},
    ]
  },
  {
    id:'comensales', label:'Clientes · Comensales de los locales', page:'CRM', accent:'#FF375F',
    intro:'Las fichas que cargan los locales en su CRM (Admin, Caja, Mozo, QR y Delivery). Son clientes DE los restaurantes, no de Mythos.',
    questions:[
      {key:'source', label:'¿Desde dónde se cargó la ficha?', options:[
        ['admin','Admin › Clientes'],['caja','Caja'],['mozo','Mozo'],
        ['qr','QR de mesa (la cargó el comensal)'],['delivery','Delivery'],['backfill','Migrada de pedidos viejos']]},
      {key:'contacto', label:'¿Tiene teléfono?',
       hint:'En gastronomía el teléfono ES la identidad del cliente: una ficha sin número no se puede reconocer en la próxima visita.',
       options:[['con_telefono','Con teléfono'],['solo_email','Solo email'],['sin_contacto','Ningún contacto']]},
      {key:'datos', label:'Qué más completaron de la ficha', multi:true, options:[
        ['email','Email'],['direccion','Dirección'],['documento','Documento / RUC'],['cumpleanos','Cumpleaños']]},
      {key:'estado', label:'Estado de la ficha', options:[['activo','Activa'],['inactivo','Dada de baja']]},
    ]
  },
];

const FORM_PERIODS = [
  {id:'all',  label:'Todo el historial'},
  {id:'30d',  label:'Últimos 30 días'},
  {id:'90d',  label:'Últimos 90 días'},
  {id:'year', label:'Este año'},
];
// Rango como timestamptz. Paraguay es UTC-3 fijo (sin horario de verano desde
// 2024), así que "este año" arranca el 1/1 a las 00:00 de Asunción — con un
// toISOString() pelado empezaría a las 21:00 del 31/12 y el reporte de enero
// se comería los registros de la última noche del año anterior.
function formRange(period) {
  const now = Date.now();
  if (period === '30d')  return { from: new Date(now - 30*86400000).toISOString(), to: null };
  if (period === '90d')  return { from: new Date(now - 90*86400000).toISOString(), to: null };
  if (period === 'year') {
    const y = new Date().toLocaleDateString('en-CA', {timeZone:'America/Asuncion'}).slice(0,4);
    return { from: `${y}-01-01T00:00:00-03:00`, to: null };
  }
  return { from: null, to: null };
}

// Una pregunta con sus opciones. El orden es el DEL FORMULARIO (no el ranking):
// leerlo de arriba a abajo tiene que sentirse como leer el formulario. Las
// opciones fuera del catálogo (ciudades, planes, add-ons) van después ordenadas
// por cantidad, y "sin responder" siempre al final.
function FormQuestion({q, counts, total, accent}) {
  const c = counts || {};
  const known = new Set((q.options||[]).map(o=>o[0]));
  const rows = (q.options||[]).map(([k,label]) => ({key:k, label, value:Number(c[k]||0)}));
  Object.keys(c)
    .filter(k => k !== FORM_NONE && !known.has(k))
    .sort((a,b) => Number(c[b]) - Number(c[a]))
    .forEach(k => rows.push({key:k, label:k, value:Number(c[k]||0)}));
  const none = Number(c[FORM_NONE]||0);
  if (none > 0) rows.push({key:FORM_NONE, label:'Sin responder', value:none, muted:true});

  const base = total || 1;
  return (
    <div className="my-card" style={{padding:'14px 16px'}}>
      <div style={{fontSize:13,fontWeight:600,color:C.ink,marginBottom:q.hint?4:12,lineHeight:1.35}}>{q.label}</div>
      {q.hint && <div style={{fontSize:11,color:C.dim,marginBottom:10,lineHeight:1.45}}>{q.hint}</div>}
      {q.multi && <div style={{fontSize:10,color:C.dim,marginBottom:8,textTransform:'uppercase',letterSpacing:.4}}>Se puede elegir más de una</div>}
      {rows.length === 0
        ? <div style={{fontSize:12,color:C.dim,padding:'6px 0'}}>Sin respuestas todavía</div>
        : rows.map(r => {
            const pct = Math.round((r.value / base) * 100);
            return (
              <div key={r.key} style={{marginBottom:10}}>
                <div style={{display:'flex',justifyContent:'space-between',gap:10,fontSize:12,marginBottom:4}}>
                  <span style={{color:r.muted?C.dim:C.mid,fontStyle:r.muted?'italic':'normal',minWidth:0,overflow:'hidden',textOverflow:'ellipsis'}}>{r.label}</span>
                  <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:600,color:r.value?C.ink:C.dim,whiteSpace:'nowrap'}}>
                    {fmtNum(r.value)} <span style={{color:C.dim,fontWeight:400}}>· {pct}%</span>
                  </span>
                </div>
                <div style={{height:8,background:C.bg,borderRadius:5,overflow:'hidden'}}>
                  <div style={{height:'100%',width:`${Math.max((r.value/base)*100, r.value>0?2:0)}%`,
                    background:r.muted?C.border:accent,borderRadius:5,transition:'width .6s ease'}}/>
                </div>
              </div>
            );
          })}
    </div>
  );
}

function SitioFormularios() {
  const [period,  setPeriod]  = useState('all');
  const [formId,  setFormId]  = useState(FORM_SPECS[0].id);
  const [data,    setData]    = useState(null);
  const [err,     setErr]     = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!db) { setLoading(false); setErr('sin conexión con la base'); return; }
    setLoading(true);
    const r = formRange(period);
    const { data:res, error } = await db.rpc('form_analytics', { p_from: r.from, p_to: r.to });
    // El código va adelante del mensaje: PGRST202 ("no encuentro la función") es
    // el caso de "falta la migración", y se avisa distinto que un error real.
    if (error) { setErr(`${error.code ? error.code + ': ' : ''}${error.message || 'error'}`); setData(null); }
    else       { setErr(''); setData(res || null); }
    setLoading(false);
  }, [period]);
  useEffect(()=>{ load(); }, [load]);

  const spec    = FORM_SPECS.find(f => f.id === formId) || FORM_SPECS[0];
  const section = (data && data[spec.id]) || null;
  const total   = section ? Number(section.total || 0) : 0;
  const wa      = section && section.contacto ? Number(section.contacto.whatsapp || section.contacto.con_telefono || 0) : 0;
  const waPct   = total ? Math.round((wa/total)*100) : 0;
  // La RPC no existe (migración 198 sin aplicar) → PGRST202. Se distingue del
  // resto de los errores porque la solución es distinta: no es un fallo, falta
  // correr la migración.
  const faltaMig = /PGRST202|function .*form_analytics|does not exist|no existe/i.test(err);

  return (
    <div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',marginBottom:14}}>
        {FORM_PERIODS.map(p => <FilterBtn key={p.id} active={period===p.id} onClick={()=>setPeriod(p.id)}>{p.label}</FilterBtn>)}
        <div style={{flex:1}}/>
        <Btn size="sm" variant="ghost" onClick={load} disabled={loading}>{loading?'Actualizando…':'Actualizar'}</Btn>
      </div>

      {err && (
        <SectionCard style={{marginBottom:16}}>
          <div style={{padding:'16px 20px',fontSize:13,color:C.ink,lineHeight:1.6}}>
            {faltaMig
              ? <>Falta aplicar la <strong>migración 198</strong> en Supabase (<code>form_analytics</code> todavía no existe en la base).
                  Hasta entonces esta pestaña no puede mostrar los conteos: se calculan del lado de la base a propósito, porque
                  agrupar en el navegador el listado de leads —que se carga con un tope de 500— daría números cada vez más falsos
                  a medida que crezca el negocio.</>
              : <>No se pudo leer el reporte de formularios. <span style={{color:C.dim}}>({err})</span></>}
          </div>
        </SectionCard>
      )}

      <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:16}}>
        {FORM_SPECS.map(f => {
          const s = data && data[f.id];
          const n = s && s.disponible ? Number(s.total||0) : null;
          return (
            <FilterBtn key={f.id} active={formId===f.id} onClick={()=>setFormId(f.id)}>
              {f.label}{n!=null ? ` (${fmtNum(n)})` : ''}
            </FilterBtn>
          );
        })}
      </div>

      {loading && !data ? (
        <div style={{display:'flex',justifyContent:'center',alignItems:'center',height:160,gap:12}}><Spinner/><span style={{color:C.mid}}>Cargando…</span></div>
      ) : (
        <div className="animate-in">
          <SectionCard style={{marginBottom:16}}>
            <div style={{padding:'16px 20px'}}>
              <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',marginBottom:6}}>
                <span style={{width:10,height:10,borderRadius:3,background:spec.accent,flexShrink:0}}/>
                <span style={{fontSize:15,fontWeight:700,color:C.ink}}>{spec.label}</span>
                {spec.page !== '—' && <span style={{fontSize:11,color:C.dim,fontFamily:"'SF Mono',ui-monospace,monospace"}}>{spec.page}</span>}
              </div>
              <div style={{fontSize:12.5,color:C.mid,lineHeight:1.55}}>{spec.intro}</div>
            </div>
          </SectionCard>

          {!section || !section.disponible ? (
            <SectionCard>
              <div style={{padding:48,textAlign:'center',color:C.dim,fontSize:13,lineHeight:1.6}}>
                {spec.id==='delivery'
                  ? <>Todavía no hay postulaciones reales a la Red de Riders.<br/>La encuesta de interés se mira en la pestaña «Encuestas».</>
                  : section && section.error
                    ? <>No se pudo leer esta sección. <span style={{fontFamily:"'SF Mono',ui-monospace,monospace"}}>({String(section.error)})</span></>
                    : 'Sin datos para este formulario.'}
              </div>
            </SectionCard>
          ) : total === 0 ? (
            <SectionCard>
              <div style={{padding:48,textAlign:'center',color:C.dim,fontSize:13}}>
                Nadie completó este formulario en el período elegido.
              </div>
            </SectionCard>
          ) : (
            <>
              <div className="sa-kpis" style={{marginBottom:16}}>
                <Kpi label={spec.id==='comensales' ? 'Fichas cargadas' : 'Formularios completados'} value={fmtNum(total)}
                     sub={period==='all' ? 'Todo el historial' : FORM_PERIODS.find(p=>p.id===period).label}/>
                {section.contacto && (
                  <Kpi label={spec.id==='comensales' ? 'Con teléfono' : 'Contactables por WhatsApp'}
                       value={`${waPct}%`} sub={`${fmtNum(wa)} de ${fmtNum(total)}`}
                       accent={waPct>=90 ? C.green : waPct>=60 ? undefined : C.red}/>
                )}
                {spec.id==='comensales' && section.locales!=null &&
                  <Kpi label="Locales que cargan clientes" value={fmtNum(section.locales)}/>}
              </div>

              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(300px,1fr))',gap:14}}>
                {spec.questions.map(q => (
                  <FormQuestion key={q.key} q={q} counts={section[q.key]} total={total} accent={spec.accent}/>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   SITIO WEB › ENCUESTAS — el motor de formularios públicos (mig 211)

   Diferencia con la pestaña "Formularios" de al lado, que se confunde fácil:
     · Formularios = reporte de los formularios REALES del producto (registro,
       onboarding, alta de proveedores). Sus preguntas SON columnas de tablas de
       negocio, por eso sus etiquetas viven en FORM_SPECS, en el código.
     · Encuestas  = formularios de demanda que se arman ACÁ. Preguntas, opciones
       y textos viven en la BASE justamente para que cambiarlos no exija una
       migración ni un deploy.

   Los conteos salen de `public_form_stats` y las filas de `public_form_export`,
   las dos agregando/paginando del lado de la base. Es la cuarta vez que se
   escribe esta nota (migs 197, 198, 200 y 211) y la razón no cambia: agrupar en
   el navegador un listado capado da un número que empeora cuanto más crece el
   negocio.
══════════════════════════════════════════════════════════════ */
// Los acentos se sacan con una RegExp construida desde texto y NO con los
// caracteres combinantes escritos literalmente en el patron: esos son
// invisibles en el editor y cualquier normalizacion del archivo (o un diff mal
// resuelto) los borra sin que se note, dejando una regex que compila y no
// filtra nada. Asi el rango U+0300..U+036F queda legible y a prueba de eso.
const RE_ACENTOS = new RegExp('[\u0300-\u036f]', 'g');
const slugifyOpt = s => String(s||'').toLowerCase().normalize('NFD')
  .replace(RE_ACENTOS,'').replace(/[^a-z0-9]+/g,'_')
  .replace(/^_+|_+$/g,'').slice(0,40) || 'opcion';

const QTYPES = [
  {id:'single',     label:'Una opción'},
  {id:'multi',      label:'Varias opciones'},
  {id:'short_text', label:'Texto corto'},
  {id:'long_text',  label:'Texto largo'},
  {id:'number',     label:'Número'},
];
// Las tres que además se guardan en columna propia (ver §2 de la mig 211). No
// se pueden borrar ni cambiarles la clave: de ellas dependen el dedupe por
// teléfono, el filtro por ciudad y la agenda de contactos del export.
const QKEY_FIJAS = ['nombre','whatsapp','ciudad'];

const encInput = {width:'100%',padding:'8px 11px',borderRadius:8,border:`1px solid ${C.border}`,
  background:C.surface,color:C.ink,fontSize:13,fontFamily:'inherit'};

function EncuestaPregunta({q, onSave, onDelete, onMove, first, last, setFlash}) {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState(q);
  useEffect(()=>{ setD(q); }, [q.id, q.updated_at]);

  const isChoice = d.qtype==='single' || d.qtype==='multi';
  const fija = QKEY_FIJAS.includes(q.qkey);
  const opts = Array.isArray(d.options) ? d.options : [];

  const setOpt = (i, label) => {
    const next = opts.slice();
    // El `value` se genera al CREAR la opción y después no se toca: es lo que
    // quedó escrito dentro de cada respuesta ya guardada. Cambiarlo dejaría
    // esas respuestas apuntando a una opción que ya no existe y el reporte las
    // mostraría como una barra huérfana.
    next[i] = {...next[i], label};
    setD({...d, options: next});
  };
  const addOpt = () => setD({...d, options: opts.concat([{value:'', label:''}])});
  const delOpt = i => setD({...d, options: opts.filter((_,j)=>j!==i)});

  const save = () => {
    const clean = opts
      .map(o => ({ value: (o.value || slugifyOpt(o.label)), label: String(o.label||'').trim() }))
      .filter(o => o.label);
    if (isChoice && clean.length < 2) { setFlash({type:'error',text:'Una pregunta de opciones necesita al menos dos.'}); return; }
    if (!String(d.label||'').trim()) { setFlash({type:'error',text:'La pregunta necesita un texto.'}); return; }
    onSave({
      id: q.id,
      label: String(d.label).trim(),
      help: String(d.help||'').trim() || null,
      qtype: d.qtype,
      required: !!d.required,
      allow_other: isChoice ? !!d.allow_other : false,
      options: isChoice ? clean : [],
      max_len: Math.max(1, Math.min(4000, Number(d.max_len)||400)),
      placeholder: String(d.placeholder||'').trim() || null,
      is_active: d.is_active !== false,
    });
    setOpen(false);
  };

  return (
    <div className="my-card" style={{padding:0,marginBottom:10,opacity:q.is_active===false?.55:1}}>
      <div style={{display:'flex',alignItems:'center',gap:10,padding:'12px 14px'}}>
        <div style={{display:'flex',flexDirection:'column',gap:2}}>
          <button onClick={()=>onMove(q,-1)} disabled={first} title="Subir"
            style={{border:'none',background:'transparent',cursor:first?'default':'pointer',color:first?C.border:C.mid,fontSize:11,lineHeight:1,padding:0}}>▲</button>
          <button onClick={()=>onMove(q,1)} disabled={last} title="Bajar"
            style={{border:'none',background:'transparent',cursor:last?'default':'pointer',color:last?C.border:C.mid,fontSize:11,lineHeight:1,padding:0}}>▼</button>
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13,fontWeight:600,color:C.ink,lineHeight:1.35}}>
            {q.label}{q.required && <span style={{color:C.red,marginLeft:3}}>*</span>}
          </div>
          <div style={{fontSize:11,color:C.dim,marginTop:3,fontFamily:"'SF Mono',ui-monospace,monospace"}}>
            {q.qkey} · {(QTYPES.find(t=>t.id===q.qtype)||{}).label}
            {Array.isArray(q.options) && q.options.length ? ` · ${q.options.length} opciones` : ''}
            {q.allow_other ? ' · con «Otra»' : ''}
            {q.is_active===false ? ' · RETIRADA' : ''}
            {fija ? ' · fija' : ''}
          </div>
        </div>
        <Btn size="sm" variant="ghost" onClick={()=>{ setD(q); setOpen(o=>!o); }}>{open?'Cerrar':'Editar'}</Btn>
      </div>

      {open && (
        <div style={{borderTop:`1px solid ${C.border}`,padding:'14px 16px',display:'grid',gap:12}}>
          <FormField label="Pregunta">
            <input style={encInput} value={d.label||''} onChange={e=>setD({...d,label:e.target.value})}/>
          </FormField>
          <FormField label="Ayuda (opcional)" hint="Texto chico debajo de la pregunta.">
            <input style={encInput} value={d.help||''} onChange={e=>setD({...d,help:e.target.value})}/>
          </FormField>

          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))',gap:12}}>
            <FormField label="Tipo">
              <select style={encInput} value={d.qtype} disabled={fija}
                      onChange={e=>setD({...d,qtype:e.target.value})}>
                {QTYPES.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </FormField>
            <FormField label="Largo máximo">
              <input style={encInput} type="number" min={1} max={4000} value={d.max_len||400}
                     onChange={e=>setD({...d,max_len:e.target.value})}/>
            </FormField>
          </div>

          {!isChoice && (
            <FormField label="Texto de ejemplo (placeholder)">
              <input style={encInput} value={d.placeholder||''} onChange={e=>setD({...d,placeholder:e.target.value})}/>
            </FormField>
          )}

          <div style={{display:'flex',gap:20,flexWrap:'wrap',alignItems:'center'}}>
            <label style={{display:'flex',alignItems:'center',gap:8,fontSize:12.5,color:C.mid,cursor:'pointer'}}>
              <Toggle checked={!!d.required} onChange={v=>setD({...d,required:v})}/> Obligatoria
            </label>
            {isChoice && (
              <label style={{display:'flex',alignItems:'center',gap:8,fontSize:12.5,color:C.mid,cursor:'pointer'}}>
                <Toggle checked={!!d.allow_other} onChange={v=>setD({...d,allow_other:v})}/> Dejar escribir «Otra»
              </label>
            )}
            {!fija && (
              <label style={{display:'flex',alignItems:'center',gap:8,fontSize:12.5,color:C.mid,cursor:'pointer'}}>
                <Toggle checked={d.is_active!==false} onChange={v=>setD({...d,is_active:v})}/> Visible en el formulario
              </label>
            )}
          </div>

          {isChoice && (
            <div>
              <div style={{fontSize:11,color:C.mid,fontWeight:600,marginBottom:7,textTransform:'uppercase',letterSpacing:.4}}>Opciones</div>
              {opts.map((o,i)=>(
                <div key={i} style={{display:'flex',gap:8,alignItems:'center',marginBottom:7}}>
                  <input style={{...encInput,flex:1}} value={o.label||''} placeholder="Texto de la opción"
                         onChange={e=>setOpt(i,e.target.value)}/>
                  <span style={{fontSize:10,color:C.dim,fontFamily:"'SF Mono',ui-monospace,monospace",width:96,
                                overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}
                        title={o.value || slugifyOpt(o.label)}>{o.value || slugifyOpt(o.label)}</span>
                  <button onClick={()=>delOpt(i)} title="Quitar opción"
                    style={{border:'none',background:'transparent',color:C.red,cursor:'pointer',fontSize:16,lineHeight:1,padding:'0 4px'}}>×</button>
                </div>
              ))}
              <Btn size="sm" variant="ghost" onClick={addOpt}>+ Agregar opción</Btn>
              <div style={{fontSize:11,color:C.dim,marginTop:8,lineHeight:1.5}}>
                La clave gris de la derecha es la que queda guardada en cada respuesta. Se genera sola
                al crear la opción y ya no cambia: si cambiara, las respuestas viejas quedarían apuntando
                a una opción que no existe.
              </div>
            </div>
          )}

          <div style={{display:'flex',gap:8,justifyContent:'space-between',alignItems:'center',
                       borderTop:`1px solid ${C.border}`,paddingTop:12}}>
            {fija
              ? <span style={{fontSize:11,color:C.dim}}>Pregunta fija: no se puede borrar ni cambiarle el tipo.</span>
              : <Btn size="sm" variant="ghost" style={{color:C.red}} onClick={()=>onDelete(q)}>Borrar</Btn>}
            <div style={{display:'flex',gap:8}}>
              <Btn size="sm" variant="ghost" onClick={()=>{ setD(q); setOpen(false); }}>Cancelar</Btn>
              <Btn size="sm" onClick={save}>Guardar</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SitioEncuestas({setFlash}) {
  const [forms,  setForms]  = useState([]);
  const [qs,     setQs]     = useState([]);
  const [slug,   setSlug]   = useState('');
  const [sub,    setSub]    = useState('reporte');
  const [period, setPeriod] = useState('all');
  const [stats,  setStats]  = useState(null);
  const [dump,   setDump]   = useState(null);
  const [gates,  setGates]  = useState({});
  const [loading,setLoading]= useState(true);
  const [busy,   setBusy]   = useState(false);
  const [err,    setErr]    = useState('');

  const load = useCallback(async () => {
    if (!db) { setLoading(false); setErr('sin conexión con la base'); return; }
    setLoading(true);
    const [f, q, rc, mc] = await Promise.all([
      db.from('public_forms').select('*').order('sort_order'),
      db.from('public_form_questions').select('*').order('sort_order'),
      db.from('mythos_rider_config').select('registration_open,closed_message').maybeSingle(),
      db.from('marketing_config').select('value').eq('key','supplier_signup').maybeSingle(),
    ]);
    // PGRST205 = la tabla no existe → falta aplicar la 211. Se distingue de un
    // error real porque la solución es otra: no es un fallo, falta la migración.
    if (f.error) { setErr(`${f.error.code||''} ${f.error.message||''}`.trim()); setForms([]); setLoading(false); return; }
    setErr('');
    const list = f.data || [];
    setForms(list);
    setQs(q.data || []);
    setGates({
      riders: rc.data ? !!rc.data.registration_open : null,
      proveedores: mc.data && mc.data.value ? mc.data.value.open !== false : null,
      proveedores_msg: mc.data && mc.data.value ? (mc.data.value.closed_message||'') : '',
    });
    setSlug(s => (s && list.some(x=>x.slug===s)) ? s : (list[0]?.slug || ''));
    setLoading(false);
  }, []);
  useEffect(()=>{ load(); }, [load]);

  const form = forms.find(f=>f.slug===slug) || null;
  const myQs = useMemo(
    () => qs.filter(q=>form && q.form_id===form.id).sort((a,b)=>(a.sort_order-b.sort_order)||(a.id<b.id?-1:1)),
    [qs, form]);

  const range = useMemo(()=>formRange(period), [period]);

  const loadStats = useCallback(async () => {
    if (!db || !slug) return;
    const [s, e] = await Promise.all([
      db.rpc('public_form_stats',  {p_slug:slug, p_from:range.from, p_to:range.to}),
      db.rpc('public_form_export', {p_slug:slug, p_from:range.from, p_to:range.to}),
    ]);
    setStats(s.error ? null : s.data);
    setDump(e.error ? null : e.data);
  }, [slug, range.from, range.to]);
  useEffect(()=>{ loadStats(); }, [loadStats]);

  /* ── Guardar ───────────────────────────────────────────────── */
  const patchForm = async (patch) => {
    if (!form) return;
    setBusy(true);
    const { error } = await db.from('public_forms').update({...patch, updated_at:new Date().toISOString()}).eq('id', form.id);
    setBusy(false);
    if (error) { setFlash({type:'error',text:error.message}); return; }
    setForms(fs => fs.map(f => f.id===form.id ? {...f, ...patch} : f));
    setFlash({type:'success',text:'Guardado'});
  };

  const saveQ = async (patch) => {
    const { id, ...rest } = patch;
    const { error } = await db.from('public_form_questions').update(rest).eq('id', id);
    if (error) { setFlash({type:'error',text:error.message}); return; }
    setQs(list => list.map(q => q.id===id ? {...q, ...rest} : q));
    setFlash({type:'success',text:'Pregunta actualizada'});
  };

  const delQ = async (q) => {
    if (!window.confirm(`¿Borrar «${q.label}»?\n\nLas respuestas ya recibidas conservan lo que la gente contestó, pero esta pregunta deja de aparecer en el reporte. Si sólo querés sacarla del formulario, apagá «Visible» en vez de borrarla.`)) return;
    const { error } = await db.from('public_form_questions').delete().eq('id', q.id);
    if (error) { setFlash({type:'error',text:error.message}); return; }
    setQs(list => list.filter(x=>x.id!==q.id));
    setFlash({type:'success',text:'Pregunta borrada'});
  };

  const moveQ = async (q, dir) => {
    const i = myQs.findIndex(x=>x.id===q.id);
    const j = i + dir;
    if (i<0 || j<0 || j>=myQs.length) return;
    const a = myQs[i], b = myQs[j];
    const [oa, ob] = [a.sort_order, b.sort_order];
    // Si dos preguntas comparten sort_order (se puede dar al importar), un swap
    // pelado no movería nada: se les reasigna una separación explícita.
    const na = (oa===ob) ? ob + (dir>0 ? 1 : -1) : ob;
    const nb = (oa===ob) ? oa : oa;
    setQs(list => list.map(x => x.id===a.id ? {...x,sort_order:na} : x.id===b.id ? {...x,sort_order:nb} : x));
    await Promise.all([
      db.from('public_form_questions').update({sort_order:na}).eq('id',a.id),
      db.from('public_form_questions').update({sort_order:nb}).eq('id',b.id),
    ]);
  };

  const addQ = async () => {
    if (!form) return;
    const label = window.prompt('¿Qué querés preguntar?');
    if (!label || !label.trim()) return;
    let key = slugifyOpt(label);
    const used = new Set(myQs.map(q=>q.qkey));
    if (used.has(key)) { let n=2; while(used.has(`${key}_${n}`)) n++; key = `${key}_${n}`; }
    const max = myQs.reduce((m,q)=>Math.max(m,q.sort_order||0), 0);
    const row = {form_id:form.id, qkey:key, label:label.trim(), qtype:'single',
                 options:[{value:'si',label:'Sí'},{value:'no',label:'No'}],
                 sort_order:max+10};
    const { data, error } = await db.from('public_form_questions').insert(row).select().single();
    if (error) { setFlash({type:'error',text:error.message}); return; }
    setQs(list => list.concat([data]));
    setFlash({type:'success',text:'Pregunta agregada — editala para poner sus opciones'});
  };

  /* ── Interruptores del alta real ───────────────────────────── */
  const setRiderGate = async (open) => {
    const { error } = await db.from('mythos_rider_config').update({registration_open:open}).eq('id', true);
    if (error) { setFlash({type:'error',text:error.message}); return; }
    setGates(g => ({...g, riders:open}));
    setFlash({type:'success',text:open?'Alta de riders ABIERTA':'Alta de riders cerrada'});
  };
  const setSupplierGate = async (open) => {
    const value = {open, closed_message: gates.proveedores_msg || 'Todavía no abrimos el alta de proveedores. Dejanos tus datos y te avisamos apenas empecemos.'};
    const { error } = await db.from('marketing_config')
      .upsert({key:'supplier_signup', value, is_public:true}, {onConflict:'key'});
    if (error) { setFlash({type:'error',text:error.message}); return; }
    setGates(g => ({...g, proveedores:open}));
    setFlash({type:'success',text:open?'Alta de proveedores ABIERTA':'Alta de proveedores cerrada'});
  };

  /* ── Exportar ──────────────────────────────────────────────── */
  // Las etiquetas salen de las opciones que devolvió la RPC: adentro de
  // `answers` está guardado el value ('mas_300k'), y una planilla llena de
  // slugs no la lee nadie.
  const labelOf = (col, v) => {
    const o = (col.options||[]).find(x=>x.value===v);
    if (o) return o.label;
    if (typeof v === 'string' && v.indexOf('otro:')===0) return 'Otra: ' + v.slice(5);
    return v;
  };
  const cellOf = (col, row) => {
    const v = row.answers ? row.answers[col.qkey] : null;
    if (v == null) return '';
    if (Array.isArray(v)) return v.map(x=>labelOf(col,x)).join(' · ');
    return labelOf(col, v);
  };
  const sheet = () => {
    const cols = (dump && dump.columns) || [];
    const head = ['Fecha','Estado'].concat(cols.map(c=>c.label))
      .concat(['Origen (utm_source)','Campaña','Dispositivo','Página','Notas internas']);
    const body = ((dump && dump.rows) || []).map(r => [
      r.created_at ? new Date(r.created_at).toLocaleString('es-PY') : '',
      r.estado || '',
    ].concat(cols.map(c=>cellOf(c,r)))
     .concat([
       (r.utm && r.utm.utm_source) || '',
       (r.utm && r.utm.utm_campaign) || '',
       r.device || '', r.landing_path || '', r.notas_internas || '',
     ]));
    return [head].concat(body);
  };
  const exportXLS = () => {
    if (!window.XLSX) { setFlash({type:'error',text:'SheetJS no disponible'}); return; }
    const ws = window.XLSX.utils.aoa_to_sheet(sheet());
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, (form?.title||'Encuesta').slice(0,31));
    window.XLSX.writeFile(wb, `mythos_${slug}_${todayPY()}.xlsx`);
  };
  const exportCSV = () => mkDownloadCSV(`mythos_${slug}_${todayPY()}.csv`, sheet());

  // El PDF es el INFORME (porcentajes + textos), no la planilla: para los datos
  // crudos está el Excel, y un PDF de 400 filas no lo lee nadie.
  const exportPDF = () => {
    if (!stats || !stats.disponible) return;
    const total = Number(stats.total||0) || 1;
    const bloques = myQs.map(q => {
      if (q.qtype==='single' || q.qtype==='multi') {
        const counts = (stats.counts||{})[q.qkey] || {};
        const opts = (q.options||[]).map(o=>[o.value,o.label]);
        if (q.allow_other) opts.push(['otro','Otra (escrita)']);
        opts.push([FORM_NONE,'Sin responder']);
        const filas = opts.map(([k,lab])=>{
          const n = Number(counts[k]||0);
          if (k===FORM_NONE && !n) return '';
          const pct = Math.round((n/total)*100);
          return `<tr><td style="padding:4px 8px;font-size:11px;border-bottom:1px solid #eee">${esc(lab)}</td>
                  <td style="padding:4px 8px;font-size:11px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">${fmtNum(n)} · ${pct}%</td>
                  <td style="padding:4px 8px;border-bottom:1px solid #eee;width:45%"><div style="height:7px;background:#eee;border-radius:4px;overflow:hidden"><div style="height:100%;width:${pct}%;background:#1D1D1F"></div></div></td></tr>`;
        }).join('');
        const otros = ((stats.otros||{})[q.qkey]||[]).map(o=>`${esc(o.texto)} (${o.veces})`).join(' · ');
        return `<div style="margin-bottom:18px;break-inside:avoid">
          <div style="font-size:13px;font-weight:700;margin-bottom:6px">${esc(q.label)}</div>
          <table style="width:100%;border-collapse:collapse">${filas}</table>
          ${otros?`<div style="font-size:10px;color:#666;margin-top:5px"><b>Escribieron:</b> ${otros}</div>`:''}
        </div>`;
      }
      const txt = ((stats.abiertas||{})[q.qkey]||[]).slice(0,60)
        .map(a=>`<li style="font-size:11px;margin-bottom:5px;line-height:1.45">${esc(a.texto)}
                 <span style="color:#999"> — ${esc(a.nombre||'')}${a.ciudad?', '+esc(a.ciudad):''}</span></li>`).join('');
      if (!txt) return '';
      return `<div style="margin-bottom:18px">
        <div style="font-size:13px;font-weight:700;margin-bottom:6px">${esc(q.label)}</div>
        <ul style="margin:0;padding-left:18px">${txt}</ul></div>`;
    }).join('');

    const w = window.open('','_blank');
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(form?.title||'Encuesta')}</title>
      <style>body{font-family:system-ui,sans-serif;margin:32px;color:#222}@media print{button{display:none!important}}</style></head><body>
      <div style="font-size:22px;font-weight:800;margin-bottom:4px">Mythos — Encuestas</div>
      <div style="font-size:16px;font-weight:700;margin-bottom:4px">${esc(form?.title||'')}</div>
      <div style="font-size:11px;color:#888;margin-bottom:18px">Generado: ${new Date().toLocaleDateString('es-PY')} ·
        Período: ${esc((FORM_PERIODS.find(p=>p.id===period)||{}).label||'')} ·
        <b>${fmtNum(stats.total||0)} respuestas</b></div>
      <div style="border-top:2px solid #1D1D1F;padding-top:16px">${bloques}</div>
      <div style="margin-top:24px;font-size:9px;color:#bbb;text-align:right">Mythos Platform</div>
      <script>window.onload=function(){window.print();}<\/script></body></html>`);
    w.document.close();
  };

  const setEstado = async (row, estado) => {
    const { error } = await db.from('public_form_submissions').update({estado}).eq('id', row.id);
    if (error) { setFlash({type:'error',text:error.message}); return; }
    setDump(d => d ? {...d, rows: d.rows.map(r => r.id===row.id ? {...r, estado} : r)} : d);
  };

  /* ── Render ────────────────────────────────────────────────── */
  const faltaMig = /PGRST205|PGRST202|does not exist|no existe|schema cache/i.test(err);
  if (loading) return <div style={{display:'flex',justifyContent:'center',alignItems:'center',height:160,gap:12}}><Spinner/><span style={{color:C.mid}}>Cargando…</span></div>;

  if (err) return (
    <SectionCard>
      <div style={{padding:'18px 22px',fontSize:13,color:C.ink,lineHeight:1.65}}>
        {faltaMig
          ? <>Falta aplicar la <strong>migración 211</strong> en Supabase (las tablas <code>public_forms</code> todavía
              no existen). Es la que crea el motor de encuestas: los dos formularios vienen sembrados y
              <strong> apagados</strong>, así que aplicarla no publica nada por sí sola.</>
          : <>No se pudo leer las encuestas. <span style={{color:C.dim}}>({err})</span></>}
      </div>
    </SectionCard>
  );

  if (!forms.length) return <SectionCard><MkEmpty text="Todavía no hay ninguna encuesta."/></SectionCard>;

  const total = stats && stats.disponible ? Number(stats.total||0) : 0;
  const gateOpen = form && (form.audience==='delivery' ? gates.riders
                          : form.audience==='proveedores' ? gates.proveedores : null);

  return (
    <div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:14,alignItems:'center'}}>
        {forms.map(f=>(
          <FilterBtn key={f.slug} active={slug===f.slug} onClick={()=>{ setSlug(f.slug); setStats(null); setDump(null); }}>
            {f.title.length>34 ? f.title.slice(0,34)+'…' : f.title}
            {f.is_open ? '' : ' · apagada'}
          </FilterBtn>
        ))}
        <div style={{flex:1}}/>
        <Btn size="sm" variant="ghost" onClick={()=>{ load(); loadStats(); }}>Actualizar</Btn>
      </div>

      {form && (
        <>
          {/* ── Interruptores ──────────────────────────────────── */}
          <SectionCard style={{marginBottom:16}}>
            <div style={{padding:'16px 20px',display:'grid',gap:14}}>
              <div style={{display:'flex',alignItems:'center',gap:14,flexWrap:'wrap'}}>
                <Toggle checked={!!form.is_open} onChange={v=>patchForm({is_open:v})}/>
                <div style={{flex:1,minWidth:220}}>
                  <div style={{fontSize:13.5,fontWeight:700,color:C.ink}}>
                    {form.is_open ? 'La encuesta está PUBLICADA' : 'La encuesta está apagada'}
                  </div>
                  <div style={{fontSize:12,color:C.mid,lineHeight:1.5,marginTop:2}}>
                    {form.is_open
                      ? <>Cualquiera que entre a <code>{form.audience==='delivery'?'/riders':'/proveedores'}</code> la ve y la puede completar.</>
                      : <>Nadie la puede completar. La página muestra el mensaje de cerrado y la base rechaza los envíos.</>}
                  </div>
                </div>
              </div>

              {gateOpen != null && (
                <div style={{display:'flex',alignItems:'center',gap:14,flexWrap:'wrap',
                             borderTop:`1px solid ${C.border}`,paddingTop:14}}>
                  <Toggle checked={!!gateOpen}
                          onChange={v=>form.audience==='delivery'?setRiderGate(v):setSupplierGate(v)}/>
                  <div style={{flex:1,minWidth:220}}>
                    <div style={{fontSize:13.5,fontWeight:700,color:C.ink}}>
                      {gateOpen ? 'El alta REAL está abierta' : 'El alta REAL está cerrada'}
                    </div>
                    <div style={{fontSize:12,color:C.mid,lineHeight:1.5,marginTop:2}}>
                      {form.audience==='delivery'
                        ? 'Es el mismo interruptor de Riders › Configuración (registration_open): un rider puede crear su ficha y postularse en serio.'
                        : 'Habilita el formulario de solicitud del marketplace. Lo respeta también la base, no sólo la pantalla.'}
                    </div>
                  </div>
                </div>
              )}

              {form.is_open && gateOpen && (
                <div style={{fontSize:12,color:C.orange,lineHeight:1.55,background:`${C.orange}14`,
                             border:`1px solid ${C.orange}55`,borderRadius:9,padding:'10px 13px'}}>
                  Están prendidas las <strong>dos</strong> cosas a la vez. La página va a ofrecer el alta real y la
                  encuesta va a quedar escondida detrás. Si querés medir demanda antes de abrir, cerrá el alta.
                </div>
              )}
            </div>
          </SectionCard>

          <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',marginBottom:14}}>
            <MkTabBar tabs={[{id:'reporte',label:'Reporte'},{id:'respuestas',label:`Respuestas${total?` (${fmtNum(total)})`:''}`},{id:'editor',label:'Editar formulario'}]}
                      active={sub} onSelect={setSub}/>
          </div>

          {sub!=='editor' && (
            <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',marginBottom:14}}>
              {FORM_PERIODS.map(p=><FilterBtn key={p.id} active={period===p.id} onClick={()=>setPeriod(p.id)}>{p.label}</FilterBtn>)}
              <div style={{flex:1}}/>
              <Btn size="sm" variant="ghost" onClick={exportPDF} disabled={!total}>↓ PDF (informe)</Btn>
              <Btn size="sm" variant="ghost" onClick={exportXLS} disabled={!total}>↓ Excel</Btn>
              <Btn size="sm" variant="ghost" onClick={exportCSV} disabled={!total}>↓ CSV</Btn>
            </div>
          )}

          {/* ── REPORTE ────────────────────────────────────────── */}
          {sub==='reporte' && (
            !total ? <SectionCard><MkEmpty text={form.is_open?'Todavía nadie respondió.':'Todavía nadie respondió — la encuesta está apagada.'}/></SectionCard> : (
              <>
                <div className="sa-kpis" style={{marginBottom:16}}>
                  <Kpi label="Respuestas" value={fmtNum(total)} sub={(FORM_PERIODS.find(p=>p.id===period)||{}).label}/>
                  <Kpi label="Ciudades" value={fmtNum(Object.keys((stats.contexto||{}).ciudad||{}).length)}/>
                  <Kpi label="Sin contactar"
                       value={fmtNum(((stats.contexto||{}).estado||{}).nuevo||0)}
                       accent={C.orange}/>
                </div>

                <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(300px,1fr))',gap:14,marginBottom:16}}>
                  {myQs.filter(q=>q.qtype==='single'||q.qtype==='multi').map(q=>{
                    const opts = (q.options||[]).map(o=>[o.value,o.label]);
                    if (q.allow_other) opts.push(['otro','Otra (escrita)']);
                    return <FormQuestion key={q.id} accent={form.accent} total={total}
                              counts={(stats.counts||{})[q.qkey]}
                              q={{key:q.qkey, label:q.label, hint:q.help, multi:q.qtype==='multi', options:opts}}/>;
                  })}
                </div>

                {/* Lo que la gente ESCRIBIÓ. Va aparte y no en barras: es la
                    respuesta que más suele valer y un conteo de textos únicos
                    no dice nada. */}
                {myQs.filter(q=>['short_text','long_text','number'].includes(q.qtype)
                                && ((stats.abiertas||{})[q.qkey]||[]).length
                                && !QKEY_FIJAS.includes(q.qkey)).map(q=>(
                  <SectionCard key={q.id} title={q.label} style={{marginBottom:14}}>
                    <div style={{padding:'4px 20px 16px',maxHeight:420,overflowY:'auto'}}>
                      {((stats.abiertas||{})[q.qkey]||[]).map((a,i)=>(
                        <div key={i} style={{padding:'11px 0',borderBottom:`1px solid ${C.border}`}}>
                          <div style={{fontSize:13,color:C.ink,lineHeight:1.55}}>{a.texto}</div>
                          <div style={{fontSize:11,color:C.dim,marginTop:4}}>
                            {a.nombre||'—'}{a.ciudad?` · ${a.ciudad}`:''}
                            {a.fecha?` · ${new Date(a.fecha).toLocaleDateString('es-PY')}`:''}
                          </div>
                        </div>
                      ))}
                    </div>
                  </SectionCard>
                ))}

                {/* Lo que escribieron en "Otra": son las opciones que le faltan
                    al formulario. */}
                {Object.keys(stats.otros||{}).length>0 && (
                  <SectionCard title="Lo que escribieron en «Otra»" style={{marginBottom:14}}>
                    <div style={{padding:'4px 20px 16px'}}>
                      {Object.entries(stats.otros).map(([k,arr])=>{
                        const q = myQs.find(x=>x.qkey===k);
                        return (
                          <div key={k} style={{padding:'11px 0',borderBottom:`1px solid ${C.border}`}}>
                            <div style={{fontSize:12,color:C.mid,marginBottom:6}}>{q?q.label:k}</div>
                            <div style={{display:'flex',gap:7,flexWrap:'wrap'}}>
                              {arr.map((o,i)=>(
                                <span key={i} style={{fontSize:12,padding:'4px 10px',borderRadius:20,
                                  border:`1px solid ${C.border}`,color:C.ink}}>{o.texto} <span style={{color:C.dim}}>×{o.veces}</span></span>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </SectionCard>
                )}

                {/* De dónde vino la gente. Es la mitad del valor de tener el
                    formulario en casa y no en Google Forms. */}
                <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(300px,1fr))',gap:14}}>
                  {[['ciudad','Ciudad'],['utm_source','Origen de la campaña'],['utm_campaign','Campaña'],['device','Dispositivo']].map(([k,lab])=>{
                    const c = (stats.contexto||{})[k];
                    if (!c || !Object.keys(c).length) return null;
                    const opts = Object.keys(c).filter(x=>x!==FORM_NONE)
                      .sort((a,b)=>Number(c[b])-Number(c[a]))
                      .map(x=>{
                        const q = myQs.find(y=>y.qkey===k);
                        const o = q && (q.options||[]).find(z=>z.value===x);
                        return [x, o ? o.label : x];
                      });
                    return <FormQuestion key={k} accent={form.accent} total={total} counts={c}
                              q={{key:k, label:lab, options:opts}}/>;
                  })}
                </div>
              </>
            )
          )}

          {/* ── RESPUESTAS ─────────────────────────────────────── */}
          {sub==='respuestas' && (
            !dump || !dump.rows || !dump.rows.length
              ? <SectionCard><MkEmpty text="Todavía nadie respondió."/></SectionCard>
              : (
                <SectionCard>
                  {dump.truncado && (
                    <div style={{padding:'11px 20px',fontSize:12,color:C.orange,borderBottom:`1px solid ${C.border}`}}>
                      Hay más de 5.000 respuestas: se muestran y exportan las 5.000 más recientes.
                    </div>
                  )}
                  <div style={{overflowX:'auto'}}>
                    <table style={{width:'100%',borderCollapse:'collapse',fontSize:12.5}}>
                      <thead>
                        <tr style={{textAlign:'left',color:C.mid}}>
                          {['Fecha','Nombre','WhatsApp','Ciudad','Origen','Estado'].map(h=>(
                            <th key={h} style={{padding:'10px 14px',borderBottom:`1px solid ${C.border}`,fontWeight:600,whiteSpace:'nowrap'}}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {dump.rows.slice(0,300).map(r=>(
                          <tr key={r.id}>
                            <td style={{padding:'10px 14px',borderBottom:`1px solid ${C.border}`,whiteSpace:'nowrap',color:C.mid}}>
                              {r.created_at?new Date(r.created_at).toLocaleDateString('es-PY',{day:'2-digit',month:'short'}):'—'}
                            </td>
                            <td style={{padding:'10px 14px',borderBottom:`1px solid ${C.border}`,color:C.ink,fontWeight:600}}>{r.nombre||'—'}</td>
                            <td style={{padding:'10px 14px',borderBottom:`1px solid ${C.border}`,whiteSpace:'nowrap'}}>
                              {r.whatsapp
                                ? <a href={`https://wa.me/${String(r.whatsapp).replace(/\D/g,'').replace(/^0/,'595')}`}
                                     target="_blank" rel="noopener" style={{color:C.green,textDecoration:'none',fontWeight:600}}>{r.whatsapp}</a>
                                : '—'}
                            </td>
                            <td style={{padding:'10px 14px',borderBottom:`1px solid ${C.border}`,color:C.mid}}>
                              {(()=>{ const q=myQs.find(x=>x.qkey==='ciudad');
                                      const o=q&&(q.options||[]).find(z=>z.value===r.ciudad);
                                      return o?o.label:(r.ciudad||'—'); })()}
                            </td>
                            <td style={{padding:'10px 14px',borderBottom:`1px solid ${C.border}`,color:C.dim,fontSize:11.5}}>
                              {(r.utm&&r.utm.utm_source)||r.device||'—'}
                            </td>
                            <td style={{padding:'8px 14px',borderBottom:`1px solid ${C.border}`}}>
                              <select value={r.estado||'nuevo'} onChange={e=>setEstado(r,e.target.value)}
                                      style={{...encInput,padding:'5px 8px',fontSize:12,width:'auto'}}>
                                {['nuevo','contactado','interesado','descartado','convertido'].map(s=>
                                  <option key={s} value={s}>{s[0].toUpperCase()+s.slice(1)}</option>)}
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {dump.rows.length>300 && (
                    <div style={{padding:'11px 20px',fontSize:11.5,color:C.dim}}>
                      Se muestran 300 en pantalla; el Excel y el CSV exportan las {fmtNum(dump.rows.length)}.
                    </div>
                  )}
                </SectionCard>
              )
          )}

          {/* ── EDITOR ─────────────────────────────────────────── */}
          {sub==='editor' && (
            <>
              <SectionCard title="Textos del formulario" style={{marginBottom:16}}>
                <div style={{padding:'4px 20px 18px',display:'grid',gap:2}}>
                  <FormField label="Título">
                    <input style={encInput} defaultValue={form.title} key={`t${form.id}`}
                           onBlur={e=>e.target.value!==form.title && patchForm({title:e.target.value})}/>
                  </FormField>
                  <FormField label="Descripción" hint="Se muestra arriba del formulario.">
                    <textarea style={{...encInput,minHeight:72,resize:'vertical'}} defaultValue={form.description||''} key={`d${form.id}`}
                              onBlur={e=>e.target.value!==(form.description||'') && patchForm({description:e.target.value})}/>
                  </FormField>
                  <FormField label="Mensaje cuando está apagada">
                    <input style={encInput} defaultValue={form.closed_message} key={`c${form.id}`}
                           onBlur={e=>e.target.value!==form.closed_message && patchForm({closed_message:e.target.value})}/>
                  </FormField>
                  <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:14}}>
                    <FormField label="Título del «gracias»">
                      <input style={encInput} defaultValue={form.success_title} key={`st${form.id}`}
                             onBlur={e=>e.target.value!==form.success_title && patchForm({success_title:e.target.value})}/>
                    </FormField>
                    <FormField label="Mensaje del «gracias»" hint="Es el momento de más atención de todo el formulario.">
                      <input style={encInput} defaultValue={form.success_message} key={`sm${form.id}`}
                             onBlur={e=>e.target.value!==form.success_message && patchForm({success_message:e.target.value})}/>
                    </FormField>
                  </div>
                  <div style={{fontSize:11.5,color:C.dim,lineHeight:1.55}}>
                    Los cambios se guardan al salir de cada campo. {busy?'Guardando…':''}
                  </div>
                </div>
              </SectionCard>

              <SectionCard title={`Preguntas (${myQs.length})`}
                           action={<Btn size="sm" onClick={addQ}>+ Agregar pregunta</Btn>}>
                <div style={{padding:'4px 16px 16px'}}>
                  {myQs.map((q,i)=>(
                    <EncuestaPregunta key={q.id} q={q} setFlash={setFlash}
                      first={i===0} last={i===myQs.length-1}
                      onSave={saveQ} onDelete={delQ} onMove={moveQ}/>
                  ))}
                  <div style={{fontSize:11.5,color:C.dim,lineHeight:1.6,marginTop:14}}>
                    Cambiar el texto de una pregunta o de una opción <strong>no</strong> afecta las respuestas
                    ya recibidas: lo que queda guardado es la clave gris, no la redacción. Por eso se puede
                    corregir un texto mientras la encuesta corre sin romper el reporte.
                  </div>
                </div>
              </SectionCard>
            </>
          )}
        </>
      )}
    </div>
  );
}

function PageSitioWeb({setFlash}) {
  const [tab,    setTab]    = useState('resumen');
  const [leads,  setLeads]  = useState([]);
  const [events, setEvents] = useState([]);
  const [config, setConfig] = useState([]);
  const [plans,  setPlans]  = useState([]);
  const [addons, setAddons] = useState([]);
  const [supplierPlans, setSupplierPlans] = useState([]);   // vidriera de /proveedores (mig 179)
  const [faqs,   setFaqs]   = useState([]);
  const [testimonials, setTestimonials] = useState([]);
  const [registros, setRegistros] = useState([]);
  const [regRestaurants, setRegRestaurants] = useState(null);   // null = query falló → sin cruce (no confundir con "0 locales")
  const [regCount, setRegCount] = useState(null);               // count exacto: la lista de registros se capa a 500
  const [loading,setLoading]= useState(true);

  // Self-fetch (como PageSoporte). Tablas de mig 110 + leads_prospectos (mig 117)
  // + restaurants para el cruce registro→local. Degradado a [] si la tabla no
  // existe o RLS deniega (no rompe el panel).
  const load = useCallback(async () => {
    if (!db) { setLoading(false); return; }
    const [l, e, c, p, a, f, t, rg, rs, rc, sp] = await Promise.all([
      db.from('marketing_leads').select('*').order('created_at',{ascending:false}).limit(500).then(r=>r.error?{data:[]}:r),
      db.from('marketing_events').select('*').order('created_at',{ascending:false}).limit(300).then(r=>r.error?{data:[]}:r),
      db.from('marketing_config').select('*').then(r=>r.error?{data:[]}:r),
      db.from('marketing_plans').select('*').order('sort_order',{ascending:true}).then(r=>r.error?{data:[]}:r),
      db.from('marketing_add_ons').select('*').order('sort_order',{ascending:true}).then(r=>r.error?{data:[]}:r),
      db.from('marketing_faqs').select('*').order('sort_order',{ascending:true}).then(r=>r.error?{data:[]}:r),
      db.from('marketing_testimonials').select('*').order('sort_order',{ascending:true}).then(r=>r.error?{data:[]}:r),
      db.from('leads_prospectos').select('*').order('created_at',{ascending:false}).limit(500).then(r=>r.error?{data:[]}:r),
      db.from('restaurants').select('id,name,owner_email,status,created_at').order('created_at',{ascending:true}).limit(2000).then(r=>r.error?{data:null}:r),
      db.from('leads_prospectos').select('id',{count:'exact',head:true}).then(r=>r.error?{count:null}:r),
      // Vidriera de planes de PROVEEDOR (mig 179). Degradada a [] si no está aplicada.
      db.from('marketing_supplier_plans').select('*').order('sort_order',{ascending:true}).then(r=>r.error?{data:[]}:r),
    ]);
    setLeads(l.data||[]); setEvents(e.data||[]); setConfig(c.data||[]); setPlans(p.data||[]); setAddons(a.data||[]);
    setFaqs(f.data||[]); setTestimonials(t.data||[]); setSupplierPlans(sp.data||[]);
    setRegistros(rg.data||[]); setRegRestaurants(rs.data); setRegCount(rc.count==null?null:rc.count);
    setLoading(false);
  }, []);
  useEffect(()=>{ load(); }, [load]);

  const TABS = [
    {id:'resumen',     label:'Resumen'},
    {id:'formularios', label:'Formularios'},
    {id:'encuestas',   label:'Encuestas'},
    {id:'registros',   label:'Registros'},
    {id:'leads',       label:'Leads'},
    {id:'actividad', label:'Actividad'},
    {id:'planes',    label:'Planes'},
    {id:'planes_prov', label:'Planes proveedor'},
    {id:'addons',    label:'Add-ons'},
    {id:'faq',       label:'FAQ'},
    {id:'identidad', label:'Identidad y redes'},
    {id:'config',    label:'Config'},
  ];

  return (
    <div className="animate-in">
      <div style={{display:'flex',gap:8,marginBottom:18,flexWrap:'wrap'}}>
        {TABS.map(t=><FilterBtn key={t.id} active={tab===t.id} onClick={()=>setTab(t.id)}>{t.label}</FilterBtn>)}
      </div>
      {loading ? (
        <div style={{display:'flex',justifyContent:'center',alignItems:'center',height:160,gap:12}}><Spinner/><span style={{color:C.mid}}>Cargando…</span></div>
      ) : (
        <>
          {tab==='resumen'     && <SitioResumen  leads={leads} events={events} registros={registros} registrosTotal={regCount}/>}
          {/* Self-fetch propio (RPC form_analytics): NO usa los arrays de arriba,
              que vienen capados a 500 filas. Ver el encabezado de SitioFormularios. */}
          {tab==='formularios' && <SitioFormularios/>}
          {/* Motor de encuestas (mig 211). Self-fetch propio: sus preguntas
              viven en la base, no en FORM_SPECS. */}
          {tab==='encuestas'   && <SitioEncuestas setFlash={setFlash}/>}
          {tab==='registros' && <SitioRegistros registros={registros} restaurants={regRestaurants} totalExact={regCount} setFlash={setFlash} reload={load}/>}
          {tab==='leads'     && <SitioLeads    leads={leads} setFlash={setFlash} reload={load}/>}
          {tab==='actividad' && <SitioActividad events={events}/>}
          {tab==='planes'    && <SitioPlanes   plans={plans} setFlash={setFlash} reload={load}/>}
          {tab==='planes_prov' && <SitioPlanesProveedor plans={supplierPlans} setFlash={setFlash} reload={load}/>}
          {tab==='addons'    && <SitioAddons   addons={addons} setFlash={setFlash} reload={load}/>}
          {tab==='faq'       && <SitioContenido faqs={faqs} testimonials={testimonials} setFlash={setFlash} reload={load}/>}
          {tab==='identidad' && <SitioIdentidad config={config} setFlash={setFlash} reload={load}/>}
          {tab==='config'    && <SitioConfig   config={config} setFlash={setFlash} reload={load}/>}
        </>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════
   PÁGINA FISCAL (superadmin) — PR-SA3
   Dashboard de facturación electrónica (SIFEN/FacturaSend): config por local
   (vista fiscal_config_admin, mig 141 — SIN secretos), documentos emitidos
   (documentos_electronicos, mig 138/139) y costo estimado (tarifa en
   platform_config). Self-fetch degradado a [] (patrón PageSitioWeb). Sólo lectura,
   salvo la tarifa (upsert en platform_config, igual que la moneda).
══════════════════════════════════════════════ */
// Estado del DE → color. GENERADO es el éxito TERMINAL en sandbox desconectado
// (mig 139); se muestra como OK igual que APROBADO. ERROR = fallo de emisión.
const FISCAL_ESTADO_META = {
  APROBADO:    {label:'Aprobado',    bg:TINT.okBg,          color:TINT.okText},
  GENERADO:    {label:'Generado',    bg:TINT.okBg,          color:TINT.okText},
  ENVIADO:     {label:'Enviado',     bg:TINT.infoBg,        color:TINT.infoText},
  BORRADOR:    {label:'Borrador',    bg:'var(--bg-subtle)', color:C.mid},
  RECHAZADO:   {label:'Rechazado',   bg:TINT.dangerBg,      color:TINT.dangerText},
  ERROR:       {label:'Error',       bg:TINT.dangerBg,      color:TINT.dangerText},
  CANCELADO:   {label:'Cancelado',   bg:TINT.warnBg,        color:TINT.warnText},
  INUTILIZADO: {label:'Inutilizado', bg:TINT.warnBg,        color:TINT.warnText},
};
const fiscalEstadoMeta = e => FISCAL_ESTADO_META[e] || {label:e||'—', color:C.mid, bg:'var(--bg-subtle)'};
const FE_OK      = new Set(['APROBADO','GENERADO']);   // éxito terminal
const FE_BAD     = new Set(['RECHAZADO','ERROR']);     // fallo terminal
const FE_PENDING = new Set(['ENVIADO']);               // en vuelo
const FISCAL_ESTADOS = ['GENERADO','APROBADO','ENVIADO','BORRADOR','RECHAZADO','ERROR','CANCELADO','INUTILIZADO'];

const FiscalBadge = ({estado, title}) => {
  const m = fiscalEstadoMeta(estado);
  return <span title={title||undefined} style={{padding:'2px 8px',borderRadius:20,fontSize:11,fontWeight:600,background:m.bg,color:m.color,whiteSpace:'nowrap'}}>{m.label}</span>;
};
// Badge sí/no genérico (estado FE Activa/Inactiva, credencial cargada, etc.)
const YesNoBadge = ({on, yes='Sí', no='No'}) => (
  <span style={{padding:'2px 8px',borderRadius:20,fontSize:11,fontWeight:600,whiteSpace:'nowrap',
    background:on?TINT.okBg:'var(--bg-subtle)', color:on?TINT.okText:C.mid}}>{on?yes:no}</span>
);
// Environment: production en verde (real), sandbox/test gris.
const EnvBadge = ({env}) => {
  const prod = (env||'').toLowerCase()==='production';
  return <span style={{padding:'2px 8px',borderRadius:20,fontSize:11,fontWeight:600,whiteSpace:'nowrap',
    background:prod?TINT.okBg:'var(--bg-subtle)', color:prod?TINT.okText:C.mid}}>{env||'—'}</span>;
};

// Mes en hora de Paraguay como 'YYYY-MM' (agrupar/filtrar por mes real, no el del navegador).
const mesPY = d => d ? new Date(d).toLocaleDateString('en-CA',{timeZone:'America/Asuncion'}).slice(0,7) : '';
const mesActualPY = () => new Date().toLocaleDateString('en-CA',{timeZone:'America/Asuncion'}).slice(0,7);
const mesLabelPY = ym => {
  if(!ym) return '—';
  const [y,m]=ym.split('-');
  return new Date(Number(y),Number(m)-1,1).toLocaleDateString('es-PY',{month:'short',year:'numeric'});
};
// CDC (44 díg.): primeros 8…últimos 4 para no desbordar la tabla.
const truncCdc = c => { const s=String(c||''); return s.length>14 ? `${s.slice(0,8)}…${s.slice(-4)}` : s; };

function CopyBtn({text, label='Copiar'}) {
  const [done,setDone]=useState(false);
  const copy=async()=>{ try{ await navigator.clipboard.writeText(String(text||'')); setDone(true); setTimeout(()=>setDone(false),1500); }catch(_){} };
  return (
    <button onClick={copy} title={`Copiar ${text}`}
      style={{background:'transparent',border:`1px solid ${C.border}`,borderRadius:6,padding:'2px 8px',fontSize:11,fontWeight:600,color:done?C.green:C.mid,cursor:'pointer',whiteSpace:'nowrap'}}>
      {done?'✓ Copiado':label}
    </button>
  );
}

function PageFiscal({setFlash}) {
  const [configs, setConfigs] = useState([]);   // fiscal_config_admin (sin secretos)
  const [docs,    setDocs]    = useState([]);    // documentos_electronicos (200 recientes)
  const [rests,   setRests]   = useState([]);    // restaurants id,name (cruce por id)
  const [pconf,   setPconf]   = useState([]);    // platform_config (tarifa fe_*)
  const [loading, setLoading] = useState(true);
  const [fRest,   setFRest]   = useState('all');
  const [fEstado, setFEstado] = useState('all');
  const [fMes,    setFMes]    = useState('all');
  const [editT,   setEditT]   = useState(false);
  const [tDoc,    setTDoc]    = useState('');
  const [tFijo,   setTFijo]   = useState('');

  // Self-fetch, degradado a [] si la tabla/vista no existe o RLS deniega (no rompe el panel).
  const load = useCallback(async () => {
    if (!db) { setLoading(false); return; }
    const [fc, de, rs, pc] = await Promise.all([
      db.from('fiscal_config_admin').select('*').then(r=>r.error?{data:[]}:r),
      db.from('documentos_electronicos').select('*').order('created_at',{ascending:false}).limit(200).then(r=>r.error?{data:[]}:r),
      db.from('restaurants').select('id,name').order('name',{ascending:true}).limit(2000).then(r=>r.error?{data:[]}:r),
      db.from('platform_config').select('*').then(r=>r.error?{data:[]}:r),
    ]);
    setConfigs(fc.data||[]); setDocs(de.data||[]); setRests(rs.data||[]); setPconf(pc.data||[]);
    setLoading(false);
  }, []);
  useEffect(()=>{ load(); }, [load]);

  if (loading) {
    return <div style={{display:'flex',justifyContent:'center',alignItems:'center',height:180,gap:12}}><Spinner/><span style={{color:C.mid}}>Cargando…</span></div>;
  }

  const nameById = {};
  rests.forEach(r => { nameById[r.id] = r.name; });
  const restName = id => nameById[id] || (id ? `${String(id).slice(0,8)}…` : '—');
  const mesA = mesActualPY();

  // ── Config por local ──────────────────────────────────────────
  const activos    = configs.filter(c => c.active);
  const enProd     = activos.filter(c => (c.environment||'').toLowerCase()==='production').length;
  const enSandbox  = activos.length - enProd;

  // ── Documentos: agrupaciones ──────────────────────────────────
  const docsByRest = {};
  docs.forEach(d => { (docsByRest[d.restaurant_id] = docsByRest[d.restaurant_id] || []).push(d); });
  const capped = docs.length >= 200;

  const docsMes = docs.filter(d => mesPY(d.created_at)===mesA);
  const okAll   = docs.filter(d => FE_OK.has(d.estado));
  const badAll  = docs.filter(d => FE_BAD.has(d.estado));
  const pendAll = docs.filter(d => FE_PENDING.has(d.estado));
  const generados = docs.filter(d => d.estado==='GENERADO').length;
  const denom   = okAll.length + badAll.length + pendAll.length;
  const exitoPct = denom ? Math.round(okAll.length/denom*100) : null;

  // ── Costo estimado (tarifa en platform_config) ────────────────
  const cfgVal = k => pconf.find(c => c.key===k)?.value;
  const porDoc = Number(cfgVal('fe_costo_por_doc'))||0;
  const fijo   = Number(cfgVal('fe_costo_fijo_mensual'))||0;
  const tarifaSet = porDoc>0 || fijo>0;
  // Aprobados/generados del mes por local → base del costo variable.
  const aprobMesByRest = {};
  docs.forEach(d => { if (FE_OK.has(d.estado) && mesPY(d.created_at)===mesA) aprobMesByRest[d.restaurant_id]=(aprobMesByRest[d.restaurant_id]||0)+1; });
  const okMesTotal = Object.values(aprobMesByRest).reduce((a,b)=>a+b,0);
  // Costo = fijo×locales activos + docs aprobados del mes × costo/doc. El desglose
  // incluye TODO local activo O con docs aprobados este mes, y su suma reconcilia
  // exacto con el titular (el fijo sólo se cobra a los locales activos).
  const activeIds = new Set(activos.map(c=>c.restaurant_id));
  const desgloseIds = Array.from(new Set([...activos.map(c=>c.restaurant_id), ...Object.keys(aprobMesByRest)]));
  const desglose = desgloseIds.map(id => {
    const cfg = configs.find(c => c.restaurant_id===id);
    const isActive = activeIds.has(id);
    const n = aprobMesByRest[id]||0;
    return { id, name:restName(id), env:cfg?cfg.environment:'—', active:isActive, docs:n, costo:(isActive?fijo:0) + n*porDoc };
  }).filter(x => x.active || x.docs>0);
  const costoTotal = fijo*activos.length + okMesTotal*porDoc;

  const startEdit = () => { setTDoc(porDoc?String(porDoc):''); setTFijo(fijo?String(fijo):''); setEditT(true); };
  const saveTarifa = async () => {
    if (!db) return;
    const now = new Date().toISOString();
    const rows = [
      { key:'fe_costo_por_doc',      value:String(Number(tDoc)||0),  updated_at:now },
      { key:'fe_costo_fijo_mensual', value:String(Number(tFijo)||0), updated_at:now },
    ];
    const { error } = await db.from('platform_config').upsert(rows, { onConflict:'key' });
    if (error) { setFlash && setFlash({type:'error', text:'No se pudo guardar la tarifa'}); return; }
    setFlash && setFlash({type:'success', text:'Tarifa actualizada'});
    setEditT(false); load();
  };

  // ── Documentos: filtros ───────────────────────────────────────
  const mesesPresentes = Array.from(new Set(docs.map(d => mesPY(d.created_at)).filter(Boolean))).sort().reverse();
  const restsConDocs   = Array.from(new Set(docs.map(d => d.restaurant_id).filter(Boolean)));
  let shownDocs = docs;
  if (fRest!=='all')   shownDocs = shownDocs.filter(d => d.restaurant_id===fRest);
  if (fEstado!=='all') shownDocs = shownDocs.filter(d => d.estado===fEstado);
  if (fMes!=='all')    shownDocs = shownDocs.filter(d => mesPY(d.created_at)===fMes);

  const numeroDe = d => [d.establecimiento||'—', d.punto||'—', d.numero||'—'].join('-');

  return (
    <div className="animate-in">
      {/* KPIs */}
      <div className="sa-kpis" style={{marginBottom:18}}>
        <Kpi label="Locales con FE activa" value={fmtNum(activos.length)} sub={`${fmtNum(enProd)} en producción · ${fmtNum(enSandbox)} en sandbox`}/>
        <Kpi label="Docs este mes"         value={fmtNum(docsMes.length)} sub={mesLabelPY(mesA)}/>
        <Kpi label="Aprobados"             value={fmtNum(okAll.length)}   sub={generados?`incl. ${fmtNum(generados)} generados (sandbox)`:'emitidos OK'}/>
        <Kpi label="Rechazados"            value={fmtNum(badAll.length)}  sub="rechazados / error"/>
        <Kpi label="% de éxito"            value={exitoPct==null?'—':`${exitoPct}%`} sub="OK / enviados+OK+rechazados"/>
      </div>
      {capped && <div style={{fontSize:11,color:C.mid,marginBottom:14}}>Mostrando los 200 documentos más recientes; las métricas se calculan sobre ellos.</div>}

      {/* Costo estimado */}
      <SectionCard title="Costo estimado del mes" style={{marginBottom:18}}
        action={<button onClick={editT?()=>setEditT(false):startEdit} style={{background:'transparent',border:`1px solid ${C.border}`,borderRadius:8,padding:'5px 12px',fontSize:12,fontWeight:600,color:C.ink,cursor:'pointer'}}>{editT?'Cancelar':'Editar tarifa'}</button>}>
        <div style={{padding:'16px 20px'}}>
          {editT ? (
            <div style={{display:'flex',gap:14,flexWrap:'wrap',alignItems:'flex-end'}}>
              <div style={{flex:'1 1 200px',minWidth:180}}>
                <label style={{display:'block',fontSize:11,color:C.mid,fontWeight:600,marginBottom:5,textTransform:'uppercase',letterSpacing:.4}}>Costo por documento ({CCY.symbol})</label>
                <MoneyCcyInput value={tDoc} onChange={setTDoc} placeholder={CCY.ph}
                  style={{width:'100%',fontSize:13,padding:'9px 12px',border:`1px solid ${C.border}`,borderRadius:9,background:C.surface,color:C.ink}}/>
              </div>
              <div style={{flex:'1 1 200px',minWidth:180}}>
                <label style={{display:'block',fontSize:11,color:C.mid,fontWeight:600,marginBottom:5,textTransform:'uppercase',letterSpacing:.4}}>Costo fijo mensual por local ({CCY.symbol})</label>
                <MoneyCcyInput value={tFijo} onChange={setTFijo} placeholder={CCY.ph}
                  style={{width:'100%',fontSize:13,padding:'9px 12px',border:`1px solid ${C.border}`,borderRadius:9,background:C.surface,color:C.ink}}/>
              </div>
              <Btn onClick={saveTarifa}>Guardar tarifa</Btn>
            </div>
          ) : !tarifaSet ? (
            <div style={{textAlign:'center',padding:'12px 0'}}>
              <div style={{fontSize:14,fontWeight:700,color:C.ink,marginBottom:4}}>Configurá la tarifa</div>
              <div style={{fontSize:12,color:C.mid}}>Cargá el costo por documento y/o el fijo mensual por local para estimar el gasto de facturación electrónica.</div>
            </div>
          ) : (
            <div>
              <div style={{display:'flex',alignItems:'baseline',gap:12,flexWrap:'wrap',marginBottom:12}}>
                <span style={{fontSize:30,fontWeight:800,color:C.ink,letterSpacing:'-0.5px'}}>{fmtMoney(costoTotal)}</span>
                <span style={{fontSize:12,color:C.mid}}>
                  {fmtMoney(fijo)} fijo × {fmtNum(activos.length)} local{activos.length!==1?'es':''} + {fmtNum(okMesTotal)} doc aprob. × {fmtMoney(porDoc)}
                </span>
              </div>
              {desglose.length>0 ? (
                <div style={{overflowX:'auto'}}>
                  <table style={{width:'100%',borderCollapse:'collapse'}}>
                    <thead><tr><Th>Local</Th><Th>Ambiente</Th><Th style={{textAlign:'right'}}>Docs aprob. (mes)</Th><Th style={{textAlign:'right'}}>Costo estimado</Th></tr></thead>
                    <tbody>
                      {desglose.map(x=>(
                        <tr key={x.id}>
                          <Td style={{fontSize:13}}>{x.name}{!x.active && <span style={{fontSize:10,color:C.dim,marginLeft:6}}>(inactiva)</span>}</Td>
                          <Td><EnvBadge env={x.env}/></Td>
                          <Td style={{textAlign:'right',fontVariantNumeric:'tabular-nums'}}>{fmtNum(x.docs)}</Td>
                          <Td style={{textAlign:'right',fontVariantNumeric:'tabular-nums',fontWeight:600}}>{fmtMoney(x.costo)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <div style={{fontSize:12,color:C.dim}}>Sin locales con FE activa para estimar.</div>}
            </div>
          )}
        </div>
      </SectionCard>

      {/* Locales */}
      <SectionCard title={`Locales (${fmtNum(configs.length)})`} style={{marginBottom:18}}>
        {configs.length===0
          ? <div style={{padding:48,textAlign:'center',color:C.dim,fontSize:13}}>Ningún local tiene facturación electrónica configurada</div>
          : <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse'}}>
                <thead><tr>
                  <Th>Restaurante</Th><Th>Estado FE</Th><Th>Ambiente</Th><Th>Key</Th><Th>RUC</Th><Th>Timbrado</Th><Th>Est-Punto</Th><Th style={{textAlign:'right'}}>Docs (mes)</Th><Th>Último doc</Th>
                </tr></thead>
                <tbody>
                  {configs.map(c=>{
                    const ds = docsByRest[c.restaurant_id]||[];
                    const dmes = ds.filter(d=>mesPY(d.created_at)===mesA).length;
                    const ult = ds[0];   // desc global → primero = más reciente del local
                    return (
                      <tr key={c.id}>
                        <Td style={{fontSize:13,fontWeight:600}}>{restName(c.restaurant_id)}</Td>
                        <Td><YesNoBadge on={c.active} yes="Activa" no="Inactiva"/></Td>
                        <Td><EnvBadge env={c.environment}/></Td>
                        <Td><YesNoBadge on={c.has_api_key}/></Td>
                        <Td style={{fontSize:12,whiteSpace:'nowrap'}}>{c.ruc||'—'}</Td>
                        <Td style={{fontSize:12,whiteSpace:'nowrap'}}>{c.timbrado||'—'}</Td>
                        <Td style={{fontSize:12,whiteSpace:'nowrap'}}>{(c.establecimiento||'—')}-{(c.punto_expedicion||'—')}</Td>
                        <Td style={{textAlign:'right',fontVariantNumeric:'tabular-nums'}}>{fmtNum(dmes)}</Td>
                        <Td style={{fontSize:12,whiteSpace:'nowrap'}}>{ult ? <span style={{display:'inline-flex',alignItems:'center',gap:8}}><span style={{color:C.mid}}>{fmtAlta(ult.created_at)}</span><FiscalBadge estado={ult.estado}/></span> : '—'}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>}
      </SectionCard>

      {/* Documentos recientes */}
      <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',marginBottom:12}}>
        <select value={fRest} onChange={e=>setFRest(e.target.value)} style={{width:'auto',minWidth:170,fontSize:13}}>
          <option value="all">Todos los locales</option>
          {restsConDocs.map(id=><option key={id} value={id}>{restName(id)}</option>)}
        </select>
        <select value={fEstado} onChange={e=>setFEstado(e.target.value)} style={{width:'auto',minWidth:150,fontSize:13}}>
          <option value="all">Todos los estados</option>
          {FISCAL_ESTADOS.map(s=><option key={s} value={s}>{fiscalEstadoMeta(s).label}</option>)}
        </select>
        <select value={fMes} onChange={e=>setFMes(e.target.value)} style={{width:'auto',minWidth:130,fontSize:13}}>
          <option value="all">Todos los meses</option>
          {mesesPresentes.map(m=><option key={m} value={m}>{mesLabelPY(m)}</option>)}
        </select>
        <span style={{fontSize:12,color:C.dim}}>{shownDocs.length} doc{shownDocs.length!==1?'s':''}</span>
      </div>

      <SectionCard title="Documentos recientes">
        {docs.length===0
          ? <div style={{padding:48,textAlign:'center',color:C.dim,fontSize:13}}>Sin documentos todavía</div>
          : shownDocs.length===0
          ? <div style={{padding:40,textAlign:'center',color:C.dim,fontSize:13}}>Sin documentos con los filtros actuales</div>
          : <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse'}}>
                <thead><tr>
                  <Th>Fecha</Th><Th>Restaurante</Th><Th>Número</Th><Th>Estado</Th><Th>CDC</Th><Th>XML</Th>
                </tr></thead>
                <tbody>
                  {shownDocs.map(d=>{
                    const rechazo = (d.estado==='RECHAZADO'||d.estado==='ERROR') ? d.motivo_rechazo : null;
                    return (
                      <tr key={d.id}>
                        <Td style={{whiteSpace:'nowrap',color:C.mid,fontSize:12}}>{fmtAlta(d.created_at)}</Td>
                        <Td style={{fontSize:12}}>{restName(d.restaurant_id)}</Td>
                        <Td style={{fontSize:12,fontFamily:"'SF Mono',ui-monospace,monospace",whiteSpace:'nowrap'}}>{numeroDe(d)}</Td>
                        <Td>
                          <div style={{display:'flex',flexDirection:'column',gap:3}}>
                            <FiscalBadge estado={d.estado} title={rechazo||undefined}/>
                            {rechazo && <span title={rechazo} style={{fontSize:11,color:TINT.dangerText,maxWidth:280,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{rechazo}</span>}
                          </div>
                        </Td>
                        <Td style={{whiteSpace:'nowrap'}}>
                          {d.cdc
                            ? <span style={{display:'inline-flex',alignItems:'center',gap:8}}>
                                <span title={d.cdc} style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:12,color:C.mid}}>{truncCdc(d.cdc)}</span>
                                <CopyBtn text={d.cdc}/>
                              </span>
                            : <span style={{color:C.dim,fontSize:12}}>—</span>}
                        </Td>
                        <Td>{d.xml_url ? <a href={d.xml_url} target="_blank" rel="noopener noreferrer" style={{fontSize:12,color:C.ink,fontWeight:600}}>XML ↗</a> : <span style={{color:C.dim,fontSize:12}}>—</span>}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>}
      </SectionCard>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   PAGE: COMENSALES — la app /clientes se controla ENTERA desde acá (mig 200)
   ────────────────────────────────────────────────────────────────────────────
   Todo lo que el comensal ve es dato editable, no código: cuánto XP da cada
   cosa, cómo se llaman los niveles, qué insignias existen, qué preguntas trae
   el registro y qué aspectos se califican. Cambiar cualquiera de esas cosas
   NO debe pedir una migración ni un deploy.

   El portero de la beta también vive acá: mientras `is_public` esté en false,
   sólo entran los correos de la lista. La defensa real está en la base
   (ensure_my_diner rechaza), esto es el panel de control.
   ════════════════════════════════════════════════════════════════════════════ */

const CM_TABS = [
  {id:'resumen',      label:'Resumen'},
  {id:'comensales',   label:'Comensales'},
  // Las categorías de la vitrina y el copy del sitio (mig 204). Van acá y no en
  // "Sitio web" porque ese módulo es la web de venta a restaurantes; esto es la
  // vitrina del comensal, otro público y otro contenido.
  {id:'experiencias', label:'Experiencias'},
  {id:'sitio',        label:'Sitio'},
  {id:'experiencia',  label:'Experiencia'},
  {id:'insignias',   label:'Insignias'},
  {id:'colecciones', label:'Colecciones'},
  {id:'retos',       label:'Retos'},
  {id:'resenas',     label:'Reseñas'},
  {id:'registro',    label:'Registro'},
  {id:'acceso',      label:'Acceso'},
];

// ── Editor genérico de catálogo ────────────────────────────────────────────
// Los seis catálogos de la mig 200 (reglas, niveles, insignias, colecciones,
// retos, dimensiones, preguntas) son la MISMA operación: listar, crear,
// editar, borrar. Un editor por tabla serían ~900 líneas repetidas que se
// desincronizan de a una.
//
// `columns` describe la tabla:
//   {key, label, type, options?, hint?, hide?, required?, width?}
//   type: text | textarea | number | bool | select | tags | json
function CatalogEditor({table, pk='id', columns, orderBy, title, help, setFlash, onChanged, migNote}) {
  const [rows,setRows]   = useState(null);
  const [err,setErr]     = useState('');
  const [edit,setEdit]   = useState(null);   // fila en edición (o {} = nueva)
  const [busy,setBusy]   = useState(false);

  const load = useCallback(async ()=>{
    if (!db) { setRows([]); return; }
    let q = db.from(table).select('*');
    if (orderBy) orderBy.split(',').forEach(o=>{ q = q.order(o.trim()); });
    const {data,error} = await q;
    if (error) { setErr(error.message||'error'); setRows([]); return; }
    setErr(''); setRows(data||[]);
  },[table,orderBy]);
  useEffect(()=>{ load(); },[load]);

  const save = async () => {
    const row = {...edit};
    const isNew = !!row.__new;
    delete row.__new;
    // Los vacíos se mandan como NULL: '' en una columna numérica revienta,
    // y en una de texto guarda una cadena vacía que después hay que limpiar.
    columns.forEach(c=>{
      if (row[c.key] === '' || row[c.key] === undefined) row[c.key] = null;
      if (c.type==='number' && row[c.key]!=null) row[c.key] = Number(row[c.key]);
      if (c.type==='tags' && typeof row[c.key]==='string') {
        row[c.key] = row[c.key].split(',').map(s=>s.trim()).filter(Boolean);
      }
      if (c.type==='json' && typeof row[c.key]==='string') {
        try { row[c.key] = JSON.parse(row[c.key]); }
        catch(_) { throw new Error(`El campo "${c.label}" no es un JSON válido.`); }
      }
    });
    const missing = columns.filter(c=>c.required && (row[c.key]==null || row[c.key]===''));
    if (missing.length) { setFlash({type:'error',text:'Falta: '+missing.map(c=>c.label).join(', ')}); return; }

    setBusy(true);
    try {
      const {error} = isNew
        ? await db.from(table).insert(row)
        : await db.from(table).update(row).eq(pk, edit[pk]);
      if (error) throw error;
      setFlash({type:'ok',text:'Guardado'});
      setEdit(null); await load(); onChanged && onChanged();
    } catch(e) {
      setFlash({type:'error',text:'No se pudo guardar: '+(e.message||'')});
    }
    setBusy(false);
  };

  const remove = async (row) => {
    if (!window.confirm('¿Eliminar "'+(row.name||row.label||row[pk])+'"? No se puede deshacer.')) return;
    const {error} = await db.from(table).delete().eq(pk, row[pk]);
    if (error) { setFlash({type:'error',text:'No se pudo eliminar: '+error.message}); return; }
    setFlash({type:'ok',text:'Eliminado'}); load(); onChanged && onChanged();
  };

  if (rows===null) return <div style={{display:'flex',justifyContent:'center',padding:40}}><Spinner/></div>;
  if (err) return <MkEmpty text={migNote || ('No se pudo leer '+table+': '+err)}/>;

  const shown = columns.filter(c=>!c.hide);

  return (
    <SectionCard title={title} action={
      <Btn size="sm" onClick={()=>setEdit({__new:true, ...Object.fromEntries(
        columns.filter(c=>c.def!==undefined).map(c=>[c.key,c.def]))})}>+ Agregar</Btn>
    }>
      {help && <div style={{padding:'12px 18px',fontSize:12,color:C.mid,lineHeight:1.7,
        borderBottom:`1px solid ${C.border}`}}>{help}</div>}
      {rows.length===0 ? <MkEmpty text="Todavía no hay filas."/> : (
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse'}}>
            <thead><tr>
              {shown.map(c=><Th key={c.key} style={c.width?{width:c.width}:undefined}>{c.label}</Th>)}
              <Th style={{width:110,textAlign:'right'}}>Acciones</Th>
            </tr></thead>
            <tbody>
              {rows.map(r=>(
                <tr key={r[pk]}>
                  {shown.map(c=>(
                    <Td key={c.key}>
                      {c.type==='bool'
                        ? <span style={{color:r[c.key]?C.green:C.dim,fontWeight:700,fontSize:12}}>{r[c.key]?'Sí':'No'}</span>
                        : c.type==='tags'
                          ? <span style={{fontSize:12,color:C.mid}}>{(r[c.key]||[]).join(', ')||'—'}</span>
                          : c.type==='json'
                            ? <span style={{fontSize:11,color:C.dim}}>{Array.isArray(r[c.key])?r[c.key].length+' opciones':'—'}</span>
                            : <span style={{fontSize:13,color:C.ink}}>{r[c.key]==null||r[c.key]===''?'—':String(r[c.key])}</span>}
                    </Td>
                  ))}
                  <Td style={{textAlign:'right',whiteSpace:'nowrap'}}>
                    <Btn size="sm" variant="ghost" onClick={()=>setEdit({...r})}>Editar</Btn>{' '}
                    <Btn size="sm" variant="danger" onClick={()=>remove(r)}>×</Btn>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {edit && (
        <Modal title={edit.__new?'Nueva fila':'Editar'} onClose={()=>setEdit(null)} width={560}>
          {columns.map(c=>(
            <FormField key={c.key} label={c.label} hint={c.hint}>
              {c.type==='bool'
                ? <Toggle checked={!!edit[c.key]} onChange={v=>setEdit(e=>({...e,[c.key]:v}))}/>
                : c.type==='textarea'
                  ? <STa value={edit[c.key]??''} onChange={v=>setEdit(e=>({...e,[c.key]:v}))}/>
                  : c.type==='select'
                    ? <SSel value={edit[c.key]??''} onChange={v=>setEdit(e=>({...e,[c.key]:v}))}>
                        <option value="">—</option>
                        {(c.options||[]).map(o=><option key={o.v} value={o.v}>{o.l}</option>)}
                      </SSel>
                    : c.type==='tags'
                      ? <SInp value={Array.isArray(edit[c.key])?edit[c.key].join(', '):(edit[c.key]??'')}
                              onChange={v=>setEdit(e=>({...e,[c.key]:v}))} placeholder="pizzeria, pizza"/>
                      : c.type==='json'
                        ? <STa rows={6} value={typeof edit[c.key]==='string'?edit[c.key]:JSON.stringify(edit[c.key]??[],null,1)}
                               onChange={v=>setEdit(e=>({...e,[c.key]:v}))}/>
                        : <SInp type={c.type==='number'?'number':'text'} value={edit[c.key]??''}
                                onChange={v=>setEdit(e=>({...e,[c.key]:v}))}/>}
            </FormField>
          ))}
          <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:8}}>
            <Btn variant="ghost" onClick={()=>setEdit(null)}>Cancelar</Btn>
            <Btn onClick={save} disabled={busy}>{busy?'Guardando…':'Guardar'}</Btn>
          </div>
        </Modal>
      )}
    </SectionCard>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   RIDERS — Red de Riders Mythos (mig 206)
   ──────────────────────────────────────────────────────────────────────────
   La mesa de control de la red: quién se postula, qué papeles trajo, quién
   está habilitado, qué locales trabajan con ella y qué pasa cuando hay un
   conflicto. Todo lo que se ve acá sale de RPC agregadas del lado del
   servidor: agrupar un `.limit()` en el navegador da un número que empeora
   cuanto más crece la red (el error que las migs 197 y 198 ya tuvieron que
   arreglar dos veces).
══════════════════════════════════════════════════════════════════════════ */
const RD_TABS = [
  {id:'resumen',    label:'Resumen'},
  {id:'solicitudes',label:'Solicitudes'},
  {id:'riders',     label:'Riders'},
  {id:'socios',     label:'Locales socios'},
  {id:'casos',      label:'Expedientes'},
  {id:'config',     label:'Configuración'},
  {id:'contrato',   label:'Contrato'},
];
const RD_STATUS = {
  borrador:{l:'Borrador',c:C.dim}, pendiente:{l:'Pendiente',c:C.orange},
  observado:{l:'Observado',c:C.orange}, rechazado:{l:'Rechazado',c:C.red},
  aprobado:{l:'Aprobado',c:C.green}, activo:{l:'Activo',c:C.green},
  suspendido:{l:'Suspendido',c:C.red}, bloqueado:{l:'Bloqueado',c:C.red},
  baja:{l:'Baja',c:C.dim},
};
const rdIn = {width:'100%',padding:'9px 11px',border:`1px solid ${C.border}`,borderRadius:8,
              fontSize:13,background:C.surface,color:C.ink,fontFamily:'inherit'};
const RdIn = p => <input {...p} style={{...rdIn,...(p.style||{})}}/>;
const RdSel = p => <select {...p} style={{...rdIn,cursor:'pointer',...(p.style||{})}}/>;
const RdArea = p => <textarea {...p} style={{...rdIn,minHeight:80,resize:'vertical',...(p.style||{})}}/>;
const RdPill = ({s}) => {
  const m = RD_STATUS[s] || {l:s,c:C.mid};
  return <span style={{padding:'2px 9px',borderRadius:20,fontSize:11,fontWeight:700,
                       background:m.c+'1A',color:m.c,whiteSpace:'nowrap'}}>{m.l}</span>;
};

function PageRiders({setFlash}) {
  const [tab,setTab]   = useState('resumen');
  const [dash,setDash] = useState(null);
  const [miss,setMiss] = useState(false);
  const [bump,setBump] = useState(0);

  const load = useCallback(async()=>{
    if(!db){ setDash(null); return; }
    const {data,error} = await db.rpc('superadmin_rider_dashboard');
    if(error){
      setMiss(/function|does not exist|schema cache|PGRST202/i.test(error.message||''));
      setDash(null); return;
    }
    setMiss(false); setDash(data||null);
  },[]);
  useEffect(()=>{ load(); },[load,bump]);

  if(miss) return <MkEmpty text="Red de Riders no disponible: falta aplicar la migración 206 en Supabase."/>;

  const refresh = ()=>setBump(b=>b+1);
  return (
    <div className="animate-in">
      <MkTabBar active={tab} onSelect={setTab}
        tabs={RD_TABS.map(t=> t.id==='solicitudes' ? {...t,badge:dash?.pendientes||0}
                            : t.id==='casos'       ? {...t,badge:dash?.casos_abiertos||0} : t)}/>
      {tab==='resumen'     && <RdResumen d={dash} setTab={setTab}/>}
      {tab==='solicitudes' && <RdLista soloPendientes setFlash={setFlash} onChanged={refresh}/>}
      {tab==='riders'      && <RdLista setFlash={setFlash} onChanged={refresh}/>}
      {tab==='socios'      && <RdSocios setFlash={setFlash} onChanged={refresh}/>}
      {tab==='casos'       && <RdCasos setFlash={setFlash} onChanged={refresh}/>}
      {tab==='config'      && <RdConfig setFlash={setFlash}/>}
      {tab==='contrato'    && <RdContrato setFlash={setFlash}/>}
    </div>
  );
}

function RdResumen({d,setTab}) {
  if(!d) return <MkEmpty text="Sin datos de la red todavía."/>;
  return (
    <div className="animate-in">
      <div className="sa-kpis" style={{marginBottom:18}}>
        <Kpi label="Registrados"   value={fmtNum(d.total||0)}       sub={`${fmtNum(d.borradores||0)} sin enviar`} icon="users"/>
        <Kpi label="Pendientes"    value={fmtNum(d.pendientes||0)}  sub="Esperando revisión" icon="clock"
             accent={(d.pendientes||0)>0?C.orange:undefined} onClick={()=>setTab('solicitudes')}/>
        <Kpi label="Activos"       value={fmtNum(d.activos||0)}     sub={`${fmtNum(d.aprobados||0)} aprobados sin capacitar`} icon="check"/>
        <Kpi label="En línea ahora" value={fmtNum(d.en_linea||0)}   sub="Disponibles u ocupados" icon="activity"/>
        <Kpi label="Entregas hoy"  value={fmtNum(d.entregas_hoy||0)} sub="De riders de la red" icon="bike"/>
        <Kpi label="Suspendidos"   value={fmtNum(d.suspendidos||0)} sub={`${fmtNum(d.bloqueados||0)} bloqueados`} icon="alert"
             accent={(d.suspendidos||0)>0?C.red:undefined}/>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(300px,1fr))',gap:16}}>
        <SectionCard title="Documentación">
          <div style={{padding:18}}>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:10}}>
              <span style={{color:C.mid}}>Por vencer (30 días)</span>
              <strong style={{color:(d.docs_por_vencer||0)>0?C.orange:C.ink}}>{fmtNum(d.docs_por_vencer||0)}</strong>
            </div>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:13}}>
              <span style={{color:C.mid}}>Vencidos</span>
              <strong style={{color:(d.docs_vencidos||0)>0?C.red:C.ink}}>{fmtNum(d.docs_vencidos||0)}</strong>
            </div>
            <div style={{fontSize:11.5,color:C.dim,marginTop:12,lineHeight:1.55}}>
              El cron diario avisa en los umbrales configurados y suspende solo al que se le vence un
              documento obligatorio. La suspensión se levanta reponiendo el papel y aprobándolo.
            </div>
          </div>
        </SectionCard>
        <SectionCard title="Locales de la red">
          <div style={{padding:18}}>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:10}}>
              <span style={{color:C.mid}}>Socios activos</span><strong style={{color:C.ink}}>{fmtNum(d.socios||0)}</strong>
            </div>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:13}}>
              <span style={{color:C.mid}}>Solicitudes de local</span>
              <strong style={{color:(d.socios_pend||0)>0?C.orange:C.ink}}>{fmtNum(d.socios_pend||0)}</strong>
            </div>
            <div style={{marginTop:14}}>
              <Btn size="sm" variant="ghost" onClick={()=>setTab('socios')}>Ver locales socios</Btn>
            </div>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

function RdLista({soloPendientes, setFlash, onChanged}) {
  const [rows,setRows] = useState(null);
  const [q,setQ]       = useState('');
  const [st,setSt]     = useState(soloPendientes?'pendiente':'');
  const [sel,setSel]   = useState(null);

  const load = useCallback(async()=>{
    if(!db) return;
    setRows(null);
    const {data} = await db.rpc('superadmin_rider_list',
      {p_status:st||null,p_search:q||null,p_city:null,p_limit:200});
    setRows(Array.isArray(data)?data:[]);
  },[q,st]);
  useEffect(()=>{ load(); },[load]);

  return (
    <div className="animate-in">
      <div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap',alignItems:'center'}}>
        <RdIn value={q} placeholder="Buscar por nombre, documento, teléfono o patente"
              onChange={e=>setQ(e.target.value)} style={{maxWidth:340}}/>
        <RdSel value={st} onChange={e=>setSt(e.target.value)} style={{maxWidth:190}}>
          <option value="">Todos los estados</option>
          {Object.keys(RD_STATUS).map(k=><option key={k} value={k}>{RD_STATUS[k].l}</option>)}
        </RdSel>
        <Btn size="sm" variant="ghost" onClick={load}>↻</Btn>
      </div>

      {rows===null ? <MkEmpty text="Cargando…"/>
        : rows.length===0 ? <MkEmpty text={soloPendientes?'No hay solicitudes esperando revisión.':'Sin riders que coincidan.'}/>
        : <SectionCard>
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',minWidth:820}}>
                <thead><tr>{['Rider','Ciudad','Vehículo','Estado','Locales','Docs','Entregas',''].map(h=>(
                  <th key={h} style={{textAlign:'left',fontSize:11,fontWeight:700,color:C.mid,
                    padding:'10px 16px',borderBottom:`1px solid ${C.border}`,whiteSpace:'nowrap'}}>{h}</th>))}</tr></thead>
                <tbody>
                  {rows.map(r=>(
                    <tr key={r.id}>
                      <td style={{padding:'11px 16px',borderBottom:`1px solid ${C.border}`}}>
                        <div style={{display:'flex',gap:10,alignItems:'center'}}>
                          {r.photo_url
                            ? <img src={r.photo_url} alt="" style={{width:32,height:32,borderRadius:'50%',objectFit:'cover'}}/>
                            : <div style={{width:32,height:32,borderRadius:'50%',background:C.bg,display:'flex',
                                alignItems:'center',justifyContent:'center',color:C.dim}}><Icon name="user" size={14}/></div>}
                          <div>
                            <div style={{fontSize:13,fontWeight:600,color:C.ink}}>{r.name||'—'}</div>
                            <div style={{fontSize:11,color:C.dim}}>{r.doc_number||'—'} · {r.phone||'—'}</div>
                          </div>
                        </div>
                      </td>
                      <td style={{padding:'11px 16px',fontSize:12.5,color:C.mid,borderBottom:`1px solid ${C.border}`}}>{r.city||'—'}</td>
                      <td style={{padding:'11px 16px',fontSize:12.5,color:C.mid,borderBottom:`1px solid ${C.border}`}}>{r.vehicle_type||'—'}</td>
                      <td style={{padding:'11px 16px',borderBottom:`1px solid ${C.border}`}}><RdPill s={r.status}/></td>
                      <td style={{padding:'11px 16px',fontSize:12.5,color:C.mid,borderBottom:`1px solid ${C.border}`}}>{r.places||0}</td>
                      <td style={{padding:'11px 16px',fontSize:12,borderBottom:`1px solid ${C.border}`,whiteSpace:'nowrap'}}>
                        {r.docs_venc>0 && <span style={{color:C.red,fontWeight:700}}>{r.docs_venc} venc.</span>}
                        {r.docs_venc>0 && r.docs_pend>0 && ' · '}
                        {r.docs_pend>0 && <span style={{color:C.orange,fontWeight:700}}>{r.docs_pend} p/rev.</span>}
                        {!r.docs_venc && !r.docs_pend && <span style={{color:C.dim}}>ok</span>}
                      </td>
                      <td style={{padding:'11px 16px',fontSize:12.5,color:C.mid,borderBottom:`1px solid ${C.border}`}}>{r.deliveries||0}</td>
                      <td style={{padding:'11px 16px',borderBottom:`1px solid ${C.border}`}}>
                        <Btn size="sm" variant="ghost" onClick={()=>setSel(r.id)}>Ver solicitud</Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>}

      {sel && <RdFicha riderId={sel} onClose={()=>setSel(null)} setFlash={setFlash}
                       onChanged={()=>{ load(); onChanged&&onChanged(); }}/>}
    </div>
  );
}

/* La ficha completa: todo lo que la persona cargó, sus papeles, su historial y
   las acciones. Los documentos viven en un bucket PRIVADO, así que se abren con
   URL firmada temporal — un enlace a una cédula no puede quedar vivo. */
function RdFicha({riderId,onClose,setFlash,onChanged}) {
  const [d,setD]     = useState(null);
  const [busy,setBusy]= useState('');
  const [note,setNote]= useState('');
  const [days,setDays]= useState(7);

  const load = useCallback(async()=>{
    const {data} = await db.rpc('superadmin_rider_detail',{p_rider_id:riderId});
    setD(data&&data.ok?data:null);
  },[riderId]);
  useEffect(()=>{ load(); },[load]);

  async function verDoc(path){
    try{
      const {data,error} = await db.storage.from('rider-docs').createSignedUrl(path,300);
      if(error||!data?.signedUrl) throw error||new Error('sin url');
      window.open(data.signedUrl,'_blank','noopener');
    }catch(_){ setFlash({type:'error',text:'No se pudo abrir el documento.'}); }
  }
  async function accion(action){
    setBusy(action);
    try{
      const {error} = await db.rpc('superadmin_review_rider',
        {p_rider_id:riderId,p_action:action,p_note:note||null,p_days:action==='suspender'?Number(days)||7:null});
      if(error) throw error;
      setFlash({type:'success',text:'Listo.'}); setNote(''); load(); onChanged&&onChanged();
    }catch(e){ setFlash({type:'error',text:e.message||'No se pudo'}); }
    setBusy('');
  }
  async function doc(docId,action){
    setBusy(docId);
    try{
      const {error} = await db.rpc('superadmin_review_document',
        {p_doc_id:docId,p_action:action,p_note:note||null});
      if(error) throw error;
      load(); onChanged&&onChanged();
    }catch(e){ setFlash({type:'error',text:e.message||'No se pudo'}); }
    setBusy('');
  }

  const r = d?.rider;
  return (
    <Modal title={r?[r.first_name,r.last_name].filter(Boolean).join(' ')||'Rider':'Rider'} onClose={onClose} width={760}>
      {!d ? <MkEmpty text="Cargando…"/> : (<>
        <div style={{display:'flex',gap:16,alignItems:'center',marginBottom:18,flexWrap:'wrap'}}>
          {r.photo_url
            ? <img src={r.photo_url} alt="" style={{width:64,height:64,borderRadius:'50%',objectFit:'cover'}}/>
            : <div style={{width:64,height:64,borderRadius:'50%',background:C.bg,display:'flex',
                alignItems:'center',justifyContent:'center',color:C.dim}}><Icon name="user" size={24}/></div>}
          <div style={{flex:1,minWidth:200}}>
            <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
              <RdPill s={r.status}/>
              <span style={{fontSize:12,color:C.mid}}>{r.availability}</span>
              {r.suspended_until && <span style={{fontSize:12,color:C.red}}>hasta {fmtRelTime(r.suspended_until)}</span>}
            </div>
            <div style={{fontSize:12.5,color:C.mid,marginTop:6,lineHeight:1.6}}>
              {r.doc_number||'—'} · {r.phone||'—'} · {r.email||'—'}<br/>
              {[r.address,r.city,r.department].filter(Boolean).join(', ')||'—'}<br/>
              Nacimiento {r.birth_date||'—'} · {r.nationality||'—'}
            </div>
          </div>
          <div style={{textAlign:'right'}}>
            <div style={{fontSize:22,fontWeight:800,color:C.ink}}>{r.deliveries_count||0}</div>
            <div style={{fontSize:11,color:C.dim}}>entregas</div>
            {r.rating_avg!=null && <div style={{fontSize:12,color:C.mid,marginTop:4}}>★ {Number(r.rating_avg).toFixed(2)}</div>}
          </div>
        </div>

        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))',gap:14,marginBottom:18}}>
          <div style={{background:C.bg,borderRadius:10,padding:14}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:8}}>VEHÍCULO</div>
            <div style={{fontSize:12.5,color:C.ink,lineHeight:1.7}}>
              {r.vehicle_type} · {[r.vehicle_brand,r.vehicle_model,r.vehicle_color].filter(Boolean).join(' ')||'—'}<br/>
              Año {r.vehicle_year||'—'} · Patente <strong>{r.vehicle_plate||'—'}</strong><br/>
              Chasis {r.vehicle_chassis||'—'} · Motor {r.vehicle_engine||'—'}
            </div>
          </div>
          <div style={{background:C.bg,borderRadius:10,padding:14}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:8}}>COBRO</div>
            <div style={{fontSize:12.5,color:C.ink,lineHeight:1.7}}>
              {r.bank_holder||'—'}<br/>{r.bank_name||'—'} · {r.bank_account_type||'—'}<br/>
              {r.bank_account||'—'}{r.bank_alias?` · ${r.bank_alias}`:''}
            </div>
          </div>
          <div style={{background:C.bg,borderRadius:10,padding:14}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:8}}>CONTRATO ACEPTADO</div>
            {(d.contracts||[]).length===0
              ? <div style={{fontSize:12.5,color:C.dim}}>Sin aceptación registrada.</div>
              : (d.contracts||[]).slice(0,2).map(c=>(
                  <div key={c.id} style={{fontSize:12,color:C.ink,lineHeight:1.6}}>
                    v{c.version} · {new Date(c.accepted_at).toLocaleString('es-PY')}<br/>
                    <span style={{color:C.dim}}>IP {c.ip||'—'}</span>
                  </div>))}
          </div>
        </div>

        {/* Documentos */}
        <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:8}}>DOCUMENTOS</div>
        <div style={{marginBottom:18}}>
          {(d.docs||[]).filter(x=>!x.replaced_at).length===0
            ? <div style={{fontSize:12.5,color:C.dim,padding:'8px 0'}}>No subió ningún documento todavía.</div>
            : (d.docs||[]).filter(x=>!x.replaced_at).map((x,i)=>(
              <div key={x.id} style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',
                padding:'10px 0',borderTop:i?`1px solid ${C.border}`:'none'}}>
                <div style={{flex:1,minWidth:170}}>
                  <div style={{fontSize:13,fontWeight:600,color:C.ink}}>
                    {x.label||x.slug}{x.required?'':' (opcional)'}
                  </div>
                  <div style={{fontSize:11.5,color:C.dim,marginTop:2}}>
                    {x.expires_at?`Vence ${x.expires_at}`:'Sin vencimiento'} · subido {fmtRelTime(x.uploaded_at)}
                  </div>
                  {x.review_note && <div style={{fontSize:11.5,color:C.red,marginTop:2}}>{x.review_note}</div>}
                </div>
                <span style={{padding:'2px 9px',borderRadius:20,fontSize:11,fontWeight:700,whiteSpace:'nowrap',
                  background:(x.status==='aprobado'?C.green:x.status==='rechazado'||x.status==='vencido'?C.red:C.orange)+'1A',
                  color:x.status==='aprobado'?C.green:x.status==='rechazado'||x.status==='vencido'?C.red:C.orange}}>
                  {x.status}
                </span>
                <Btn size="sm" variant="ghost" onClick={()=>verDoc(x.file_path)}>Ver</Btn>
                <Btn size="sm" variant="success" disabled={busy===x.id} onClick={()=>doc(x.id,'aprobar')}>Aprobar</Btn>
                <Btn size="sm" variant="danger"  disabled={busy===x.id} onClick={()=>doc(x.id,'rechazar')}>Rechazar</Btn>
              </div>))}
        </div>

        {/* Locales + historial */}
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(260px,1fr))',gap:16,marginBottom:18}}>
          <div>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:8}}>LOCALES</div>
            {(d.links||[]).length===0 ? <div style={{fontSize:12.5,color:C.dim}}>No se sumó a ninguno.</div>
              : (d.links||[]).map(l=>(
                  <div key={l.link_id} style={{fontSize:12.5,color:C.ink,padding:'4px 0'}}>
                    {l.name} <span style={{color:C.dim}}>· {l.link_status} · {l.deliveries} entregas</span>
                  </div>))}
          </div>
          <div>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:8}}>HISTORIAL DISCIPLINARIO</div>
            {(d.incidents||[]).length===0 ? <div style={{fontSize:12.5,color:C.dim}}>Sin antecedentes.</div>
              : (d.incidents||[]).slice(0,8).map(i=>(
                  <div key={i.id} style={{fontSize:12,color:C.ink,padding:'4px 0',lineHeight:1.5}}>
                    <strong>{i.kind}</strong> · {fmtRelTime(i.created_at)}
                    {i.detail && <div style={{color:C.dim}}>{i.detail}</div>}
                  </div>))}
          </div>
        </div>

        {/* Acciones */}
        <div style={{background:C.bg,borderRadius:10,padding:16}}>
          <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:10}}>ACCIÓN</div>
          <RdArea value={note} placeholder="Observación para el rider (la ve en su perfil y le llega como aviso)"
                  onChange={e=>setNote(e.target.value)} style={{marginBottom:10}}/>
          <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
            <Btn size="sm" variant="success" disabled={!!busy} onClick={()=>accion('aprobar')}>Aprobar</Btn>
            <Btn size="sm" disabled={!!busy} onClick={()=>accion('observar')}>Pedir correcciones</Btn>
            <Btn size="sm" variant="danger"  disabled={!!busy} onClick={()=>accion('rechazar')}>Rechazar</Btn>
            <Btn size="sm" disabled={!!busy} onClick={()=>accion('advertir')}>Advertencia</Btn>
            <span style={{display:'inline-flex',gap:6,alignItems:'center'}}>
              <RdIn type="number" value={days} onChange={e=>setDays(e.target.value)} style={{width:64}}/>
              <Btn size="sm" variant="danger" disabled={!!busy} onClick={()=>accion('suspender')}>Suspender (días)</Btn>
            </span>
            <Btn size="sm" variant="danger" disabled={!!busy} onClick={()=>accion('bloquear')}>Bloquear</Btn>
            <Btn size="sm" variant="ghost"  disabled={!!busy} onClick={()=>accion('activar')}>Reactivar</Btn>
          </div>
          <div style={{fontSize:11,color:C.dim,marginTop:10,lineHeight:1.55}}>
            Cada acción deja su asiento con fecha y responsable. El historial no se borra: una sanción
            se corrige con una reactivación, no reescribiendo la anterior.
          </div>
        </div>
      </>)}
    </Modal>
  );
}

function RdSocios({setFlash,onChanged}) {
  const [rows,setRows] = useState(null);
  const load = useCallback(async()=>{
    if(!db) return;
    const {data} = await db.from('mythos_delivery_partners')
      .select('*, restaurants(name,city)').order('requested_at',{ascending:false});
    setRows(data||[]);
  },[]);
  useEffect(()=>{ load(); },[load]);

  async function accion(rid,action){
    try{
      const {error} = await db.rpc('superadmin_review_partner',{p_restaurant_id:rid,p_action:action});
      if(error) throw error;
      setFlash({type:'success',text:'Listo.'}); load(); onChanged&&onChanged();
    }catch(e){ setFlash({type:'error',text:e.message||'No se pudo'}); }
  }

  if(rows===null) return <MkEmpty text="Cargando…"/>;
  if(!rows.length) return <MkEmpty text="Ningún restaurante pidió trabajar con la red todavía."/>;
  return (
    <SectionCard>
      <div style={{overflowX:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse',minWidth:760}}>
          <thead><tr>{['Restaurante','Estado','Paga','Despacho','Cupo','Solicitado',''].map(h=>(
            <th key={h} style={{textAlign:'left',fontSize:11,fontWeight:700,color:C.mid,
              padding:'10px 16px',borderBottom:`1px solid ${C.border}`,whiteSpace:'nowrap'}}>{h}</th>))}</tr></thead>
          <tbody>
            {rows.map(p=>(
              <tr key={p.restaurant_id}>
                <td style={{padding:'11px 16px',borderBottom:`1px solid ${C.border}`}}>
                  <div style={{fontSize:13,fontWeight:600,color:C.ink}}>{p.restaurants?.name||'—'}</div>
                  <div style={{fontSize:11.5,color:C.dim}}>{p.restaurants?.city||'—'}
                    {p.contact_name?` · ${p.contact_name}`:''}{p.contact_phone?` · ${p.contact_phone}`:''}</div>
                  {p.note && <div style={{fontSize:11.5,color:C.mid,marginTop:3}}>{p.note}</div>}
                </td>
                <td style={{padding:'11px 16px',borderBottom:`1px solid ${C.border}`}}>
                  <span style={{padding:'2px 9px',borderRadius:20,fontSize:11,fontWeight:700,whiteSpace:'nowrap',
                    background:(p.status==='activo'?C.green:p.status==='pendiente'?C.orange:C.red)+'1A',
                    color:p.status==='activo'?C.green:p.status==='pendiente'?C.orange:C.red}}>{p.status}</span>
                </td>
                <td style={{padding:'11px 16px',fontSize:12.5,color:C.mid,borderBottom:`1px solid ${C.border}`,whiteSpace:'nowrap'}}>
                  {p.pay_type==='pct'?`${p.pay_value}%`:fmtGs(p.pay_value)}<br/>
                  <span style={{fontSize:11,color:C.dim}}>{p.pay_method}</span>
                </td>
                <td style={{padding:'11px 16px',fontSize:12.5,color:C.mid,borderBottom:`1px solid ${C.border}`}}>{p.dispatch_mode}</td>
                <td style={{padding:'11px 16px',fontSize:12.5,color:C.mid,borderBottom:`1px solid ${C.border}`}}>{p.max_riders??'—'}</td>
                <td style={{padding:'11px 16px',fontSize:12,color:C.dim,borderBottom:`1px solid ${C.border}`,whiteSpace:'nowrap'}}>
                  {fmtRelTime(p.requested_at)}</td>
                <td style={{padding:'11px 16px',borderBottom:`1px solid ${C.border}`,whiteSpace:'nowrap'}}>
                  {p.status!=='activo' && <Btn size="sm" variant="success" onClick={()=>accion(p.restaurant_id,'aprobar')}>Aprobar</Btn>}
                  {p.status==='activo' && <Btn size="sm" onClick={()=>accion(p.restaurant_id,'pausar')}>Pausar</Btn>}
                  {' '}<Btn size="sm" variant="danger" onClick={()=>accion(p.restaurant_id,'rechazar')}>Rechazar</Btn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

function RdCasos({setFlash,onChanged}) {
  const [rows,setRows] = useState(null);
  const [sel,setSel]   = useState(null);
  const load = useCallback(async()=>{
    if(!db) return;
    const {data} = await db.from('mythos_rider_cases').select('*')
      .order('created_at',{ascending:false}).limit(200);
    setRows(data||[]);
  },[]);
  useEffect(()=>{ load(); },[load]);

  if(rows===null) return <MkEmpty text="Cargando…"/>;
  if(!rows.length) return <MkEmpty text="Sin expedientes. Se abren cuando hay un conflicto en una entrega."/>;
  return (<>
    <SectionCard>
      <div style={{overflowX:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse',minWidth:680}}>
          <thead><tr>{['Código','Asunto','Abierto por','Estado','Fecha',''].map(h=>(
            <th key={h} style={{textAlign:'left',fontSize:11,fontWeight:700,color:C.mid,
              padding:'10px 16px',borderBottom:`1px solid ${C.border}`}}>{h}</th>))}</tr></thead>
          <tbody>
            {rows.map(c=>(
              <tr key={c.id}>
                <td style={{padding:'11px 16px',fontSize:12,fontFamily:"'SF Mono',ui-monospace,monospace",
                  color:C.ink,borderBottom:`1px solid ${C.border}`}}>{c.code}</td>
                <td style={{padding:'11px 16px',fontSize:13,color:C.ink,borderBottom:`1px solid ${C.border}`}}>{c.subject}</td>
                <td style={{padding:'11px 16px',fontSize:12.5,color:C.mid,borderBottom:`1px solid ${C.border}`}}>{c.opened_role}</td>
                <td style={{padding:'11px 16px',fontSize:12.5,borderBottom:`1px solid ${C.border}`}}>
                  <span style={{color:['resuelto','cerrado'].includes(c.status)?C.green:C.orange,fontWeight:700}}>{c.status}</span></td>
                <td style={{padding:'11px 16px',fontSize:12,color:C.dim,borderBottom:`1px solid ${C.border}`}}>{fmtRelTime(c.created_at)}</td>
                <td style={{padding:'11px 16px',borderBottom:`1px solid ${C.border}`}}>
                  <Btn size="sm" variant="ghost" onClick={()=>setSel(c.id)}>Abrir</Btn></td>
              </tr>))}
          </tbody>
        </table>
      </div>
    </SectionCard>
    {sel && <RdCasoDetalle caseId={sel} onClose={()=>setSel(null)} setFlash={setFlash}
                           onChanged={()=>{load(); onChanged&&onChanged();}}/>}
  </>);
}

function RdCasoDetalle({caseId,onClose,setFlash,onChanged}) {
  const [d,setD]   = useState(null);
  const [msg,setMsg] = useState('');
  const [res,setRes] = useState('');
  const load = useCallback(async()=>{
    const {data} = await db.rpc('rider_case_detail',{p_case_id:caseId});
    setD(data&&data.ok?data:null);
    if(data?.case?.resolution) setRes(data.case.resolution);
  },[caseId]);
  useEffect(()=>{ load(); },[load]);

  async function enviar(){
    if(!msg.trim()) return;
    const {error} = await db.rpc('add_rider_case_message',{p_case_id:caseId,p_body:msg,p_file_path:null});
    if(error){ setFlash({type:'error',text:error.message}); return; }
    setMsg(''); load();
  }
  async function resolver(status){
    const {error} = await db.rpc('superadmin_resolve_case',
      {p_case_id:caseId,p_status:status,p_resolution:res||null});
    if(error){ setFlash({type:'error',text:error.message}); return; }
    setFlash({type:'success',text:'Expediente actualizado.'}); load(); onChanged&&onChanged();
  }

  return (
    <Modal title={d?.case?.code||'Expediente'} onClose={onClose} width={640}>
      {!d ? <MkEmpty text="Cargando…"/> : (<>
        <div style={{fontSize:14,fontWeight:700,color:C.ink,marginBottom:6}}>{d.case.subject}</div>
        <div style={{fontSize:12.5,color:C.mid,lineHeight:1.6,marginBottom:16}}>{d.case.description||'—'}</div>

        <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:8}}>
          EVIDENCIA Y DESCARGOS ({(d.messages||[]).length})
        </div>
        <div style={{maxHeight:240,overflowY:'auto',marginBottom:16}}>
          {(d.messages||[]).length===0
            ? <div style={{fontSize:12.5,color:C.dim}}>Todavía nadie aportó nada.</div>
            : (d.messages||[]).map(m=>(
                <div key={m.id} style={{padding:'9px 0',borderBottom:`1px solid ${C.border}`}}>
                  <div style={{fontSize:11.5,color:C.dim,marginBottom:3}}>
                    <strong style={{color:C.mid}}>{m.author_name||m.author_role}</strong> · {m.author_role} · {fmtRelTime(m.created_at)}
                  </div>
                  <div style={{fontSize:12.5,color:C.ink,lineHeight:1.55}}>{m.body||'(archivo adjunto)'}</div>
                </div>))}
        </div>

        <RdArea value={msg} placeholder="Escribir en el expediente" onChange={e=>setMsg(e.target.value)}
                style={{marginBottom:8}}/>
        <Btn size="sm" onClick={enviar}>Agregar</Btn>

        <div style={{marginTop:20,paddingTop:16,borderTop:`1px solid ${C.border}`}}>
          <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:8}}>RESOLUCIÓN</div>
          <RdArea value={res} onChange={e=>setRes(e.target.value)}
                  placeholder="Qué se decidió y por qué. Queda firmado con tu usuario y la fecha."
                  style={{marginBottom:10}}/>
          <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
            <Btn size="sm" onClick={()=>resolver('en_revision')}>Marcar en revisión</Btn>
            <Btn size="sm" onClick={()=>resolver('esperando')}>Esperando a una parte</Btn>
            <Btn size="sm" variant="success" onClick={()=>resolver('resuelto')}>Resolver</Btn>
            <Btn size="sm" variant="danger" onClick={()=>resolver('cerrado')}>Cerrar</Btn>
          </div>
        </div>
      </>)}
    </Modal>
  );
}

function RdConfig({setFlash}) {
  const [c,setC]     = useState(null);
  const [docs,setDocs]= useState([]);
  const [rests,setRests]= useState([]);   // para la allowlist del piloto
  const [pq,setPq]   = useState('');
  const [saving,setSaving]= useState(false);
  const load = useCallback(async()=>{
    const [a,b,r] = await Promise.all([
      db.from('mythos_rider_config').select('*').eq('id',true).maybeSingle(),
      db.from('mythos_rider_doc_types').select('*').order('sort_order'),
      db.from('restaurants').select('id,name,city').order('name'),
    ]);
    setC(a.data||null); setDocs(b.data||[]); setRests(r.data||[]);
  },[]);
  useEffect(()=>{ load(); },[load]);
  if(!c) return <MkEmpty text="Cargando…"/>;

  const set = (k,v)=>setC(p=>({...p,[k]:v}));
  async function save(){
    setSaving(true);
    const {error} = await db.from('mythos_rider_config').update({
      network_enabled:c.network_enabled, registration_open:c.registration_open,
      closed_message:c.closed_message, min_age:Number(c.min_age)||18,
      require_selfie:c.require_selfie, require_bank:c.require_bank,
      require_training:c.require_training, training_url:c.training_url||null,
      auto_approve:c.auto_approve,
      accept_seconds:Number(c.accept_seconds)||60, max_distance_km:Number(c.max_distance_km)||10,
      offer_max_riders:Number(c.offer_max_riders)||6,
      geo_enabled:c.geo_enabled, geo_interval_seconds:Number(c.geo_interval_seconds)||60,
      max_rejections_per_day:Number(c.max_rejections_per_day)||5,
      warnings_before_suspension:Number(c.warnings_before_suspension)||3,
      suspension_days:Number(c.suspension_days)||7,
      auto_suspend_on_expiry:c.auto_suspend_on_expiry,
      site_texts:c.site_texts||{}, hero_image_url:c.hero_image_url||null,
      // Piloto cerrado (mig 208). Se mandan sólo si la columna existe en la fila
      // cargada: con la 208 sin aplicar, incluirlas rebota el UPDATE entero y se
      // perdería toda la configuración de riders.
      ...( 'pilot_mode' in c ? {
        pilot_mode:!!c.pilot_mode,
        pilot_restaurant_ids:c.pilot_restaurant_ids||[],
      } : {}),
      updated_at:new Date().toISOString(),
    }).eq('id',true);
    setSaving(false);
    setFlash(error?{type:'error',text:error.message}:{type:'success',text:'Configuración guardada.'});
  }
  async function saveDoc(d,patch){
    const {error} = await db.from('mythos_rider_doc_types').update(patch).eq('id',d.id);
    if(error) setFlash({type:'error',text:error.message}); else load();
  }

  const Row = ({label,hint,children}) => (
    <div style={{display:'flex',gap:14,alignItems:'center',padding:'11px 0',borderTop:`1px solid ${C.border}`,flexWrap:'wrap'}}>
      <div style={{flex:1,minWidth:230}}>
        <div style={{fontSize:13,color:C.ink,fontWeight:600}}>{label}</div>
        {hint && <div style={{fontSize:11.5,color:C.dim,marginTop:2,lineHeight:1.5}}>{hint}</div>}
      </div>
      {children}
    </div>
  );

  return (
    <div className="animate-in" style={{display:'grid',gap:16}}>
      <SectionCard title="La red" action={<Btn size="sm" onClick={save} disabled={saving}>{saving?'Guardando…':'Guardar'}</Btn>}>
        <div style={{padding:'6px 18px 18px'}}>
          <Row label="Red de riders habilitada"
               hint="Apagada, /riders muestra que todavía no está disponible y ningún local puede solicitarla.">
            <Toggle checked={!!c.network_enabled} onChange={v=>set('network_enabled',v)}/>
          </Row>
          {/* Piloto cerrado (mig 208). Sólo se dibuja si la columna existe: con la
              208 sin aplicar, el interruptor prometería un filtro que la base no
              aplica — y eso es peor que no tenerlo. */}
          {('pilot_mode' in c) && (<>
            <Row label="Piloto cerrado"
                 hint="Con la red encendida, sólo los restaurantes de abajo pueden ser socios activos. Los riders se siguen postulando normalmente: son de la plataforma, no de un local.">
              <Toggle checked={!!c.pilot_mode} onChange={v=>set('pilot_mode',v)}/>
            </Row>
            {!!c.pilot_mode && (
              <div style={{padding:'4px 0 12px'}}>
                <RdIn value={pq} onChange={e=>setPq(e.target.value)}
                      placeholder="Buscar restaurante…" style={{maxWidth:340,marginBottom:8}}/>
                <div style={{maxHeight:230,overflowY:'auto',border:`1px solid ${C.border}`,borderRadius:8}}>
                  {rests
                    .filter(r=>!pq.trim() || `${r.name||''} ${r.city||''}`.toLowerCase().includes(pq.trim().toLowerCase()))
                    .map((r,i)=>{
                      const on = (c.pilot_restaurant_ids||[]).includes(r.id);
                      return (
                        <label key={r.id} style={{display:'flex',gap:10,alignItems:'center',padding:'9px 12px',
                                 cursor:'pointer',borderTop:i?`1px solid ${C.border}`:'none',
                                 background:on?C.card:'transparent'}}>
                          <input type="checkbox" checked={on} onChange={()=>{
                            const cur = c.pilot_restaurant_ids||[];
                            set('pilot_restaurant_ids', on ? cur.filter(x=>x!==r.id) : [...cur, r.id]);
                          }}/>
                          <span style={{flex:1,minWidth:0}}>
                            <span style={{fontSize:13,color:C.ink,fontWeight:on?700:500}}>{r.name||'—'}</span>
                            {r.city && <span style={{fontSize:11.5,color:C.dim}}> · {r.city}</span>}
                          </span>
                        </label>
                      );
                    })}
                  {rests.length===0 && <div style={{padding:'12px',fontSize:12.5,color:C.dim}}>No hay restaurantes.</div>}
                </div>
                <div style={{fontSize:11.5,color:C.dim,marginTop:7,lineHeight:1.5}}>
                  {(c.pilot_restaurant_ids||[]).length} habilitado(s).
                  {' '}Al guardar, los locales que ya eran socios y quedan fuera de la lista pasan a <strong>pausado</strong> (reversible).
                </div>
              </div>
            )}
          </>)}
          <Row label="Postulaciones abiertas"
               hint="Cerrarlas no saca a nadie: los riders que ya están siguen trabajando.">
            <Toggle checked={!!c.registration_open} onChange={v=>set('registration_open',v)}/>
          </Row>
          <Row label="Mensaje cuando están cerradas">
            <RdIn value={c.closed_message||''} onChange={e=>set('closed_message',e.target.value)} style={{maxWidth:340}}/>
          </Row>
          <Row label="Edad mínima"><RdIn type="number" value={c.min_age} onChange={e=>set('min_age',e.target.value)} style={{width:90}}/></Row>
          <Row label="Pedir selfie de validación"><Toggle checked={!!c.require_selfie} onChange={v=>set('require_selfie',v)}/></Row>
          <Row label="Pedir datos bancarios"><Toggle checked={!!c.require_bank} onChange={v=>set('require_bank',v)}/></Row>
          <Row label="Aprobar automáticamente" hint="Con esto prendido nadie revisa las solicitudes. Dejalo apagado salvo prueba.">
            <Toggle checked={!!c.auto_approve} onChange={v=>set('auto_approve',v)}/>
          </Row>
          <Row label="Capacitación obligatoria" hint="El aprobado no puede trabajar hasta marcarla como hecha.">
            <Toggle checked={!!c.require_training} onChange={v=>set('require_training',v)}/>
          </Row>
          <Row label="Link de la capacitación">
            <RdIn value={c.training_url||''} onChange={e=>set('training_url',e.target.value)} style={{maxWidth:340}}/>
          </Row>
        </div>
      </SectionCard>

      <SectionCard title="Despacho y penalizaciones" action={<Btn size="sm" onClick={save} disabled={saving}>Guardar</Btn>}>
        <div style={{padding:'6px 18px 18px'}}>
          <Row label="Tiempo para aceptar un pedido (segundos)"
               hint="Si vence, el pedido pasa solo al siguiente rider.">
            <RdIn type="number" value={c.accept_seconds} onChange={e=>set('accept_seconds',e.target.value)} style={{width:90}}/>
          </Row>
          <Row label="Distancia máxima al local (km)">
            <RdIn type="number" value={c.max_distance_km} onChange={e=>set('max_distance_km',e.target.value)} style={{width:90}}/>
          </Row>
          <Row label="A cuántos riders se le ofrece antes de rendirse"
               hint="Agotados, el pedido queda sin asignar y lo ve el local para darlo a mano.">
            <RdIn type="number" value={c.offer_max_riders} onChange={e=>set('offer_max_riders',e.target.value)} style={{width:90}}/>
          </Row>
          <Row label="Geolocalización" hint="Nunca se registra si el rider está desconectado.">
            <Toggle checked={!!c.geo_enabled} onChange={v=>set('geo_enabled',v)}/>
          </Row>
          <Row label="Cada cuántos segundos se actualiza la ubicación">
            <RdIn type="number" value={c.geo_interval_seconds} onChange={e=>set('geo_interval_seconds',e.target.value)} style={{width:90}}/>
          </Row>
          <Row label="Máximo de pedidos sin tomar por día" hint="Al superarlo se registra una advertencia automática.">
            <RdIn type="number" value={c.max_rejections_per_day} onChange={e=>set('max_rejections_per_day',e.target.value)} style={{width:90}}/>
          </Row>
          <Row label="Advertencias antes de suspender">
            <RdIn type="number" value={c.warnings_before_suspension} onChange={e=>set('warnings_before_suspension',e.target.value)} style={{width:90}}/>
          </Row>
          <Row label="Días de suspensión por defecto">
            <RdIn type="number" value={c.suspension_days} onChange={e=>set('suspension_days',e.target.value)} style={{width:90}}/>
          </Row>
          <Row label="Suspender al vencerse un documento obligatorio">
            <Toggle checked={!!c.auto_suspend_on_expiry} onChange={v=>set('auto_suspend_on_expiry',v)}/>
          </Row>
        </div>
      </SectionCard>

      <SectionCard title="Documentos que se exigen">
        <div style={{padding:'6px 18px 18px'}}>
          <div style={{fontSize:11.5,color:C.dim,lineHeight:1.55,padding:'8px 0'}}>
            Cambiar esto NO pide migración. Lo que marques como obligatorio es lo que la base va a
            exigir para poder enviar una solicitud, y lo que la landing muestra en “Qué necesitás”.
          </div>
          {docs.map(d=>(
            <div key={d.id} style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap',
              padding:'11px 0',borderTop:`1px solid ${C.border}`}}>
              <div style={{flex:1,minWidth:200}}>
                <div style={{fontSize:13,fontWeight:600,color:C.ink}}>{d.label}</div>
                <div style={{fontSize:11.5,color:C.dim,marginTop:2}}>
                  {d.slug}{(d.vehicles||[]).length?` · sólo ${(d.vehicles||[]).join(', ')}`:' · todos los vehículos'}
                </div>
              </div>
              <label style={{display:'flex',gap:6,alignItems:'center',fontSize:12,color:C.mid}}>
                <input type="checkbox" checked={!!d.required} onChange={e=>saveDoc(d,{required:e.target.checked})}/>
                obligatorio
              </label>
              <label style={{display:'flex',gap:6,alignItems:'center',fontSize:12,color:C.mid}}>
                <input type="checkbox" checked={!!d.has_expiry} onChange={e=>saveDoc(d,{has_expiry:e.target.checked})}/>
                vence
              </label>
              <label style={{display:'flex',gap:6,alignItems:'center',fontSize:12,color:C.mid}}>
                <input type="checkbox" checked={!!d.is_active} onChange={e=>saveDoc(d,{is_active:e.target.checked})}/>
                activo
              </label>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}

function RdContrato({setFlash}) {
  const [rows,setRows] = useState(null);
  const [nv,setNv]     = useState({version:'',title:'Términos de la Red de Riders Mythos',body:''});
  const load = useCallback(async()=>{
    const {data} = await db.from('mythos_rider_contract_versions').select('*')
      .order('published_at',{ascending:false});
    setRows(data||[]);
    const cur = (data||[]).find(x=>x.is_current);
    if(cur) setNv(v=>v.body?v:{version:'',title:cur.title,body:cur.body});
  },[]);
  useEffect(()=>{ load(); },[load]);

  async function publicar(){
    if(!nv.version.trim()||!nv.body.trim()){ setFlash({type:'error',text:'Poné versión y texto.'}); return; }
    // Una sola versión vigente: primero se baja la actual (hay un índice único
    // parcial que lo garantiza igual del lado de la base).
    await db.from('mythos_rider_contract_versions').update({is_current:false}).eq('is_current',true);
    const {error} = await db.from('mythos_rider_contract_versions')
      .insert({version:nv.version.trim(),title:nv.title,body:nv.body,is_current:true});
    if(error){ setFlash({type:'error',text:error.message}); return; }
    setFlash({type:'success',text:'Versión publicada. Los nuevos postulantes aceptan ésta.'});
    setNv({version:'',title:nv.title,body:nv.body}); load();
  }

  return (
    <div className="animate-in" style={{display:'grid',gap:16}}>
      <SectionCard title="Publicar una versión nueva">
        <div style={{padding:18}}>
          <div style={{fontSize:12,color:C.mid,lineHeight:1.6,marginBottom:14}}>
            El texto se versiona a propósito: una redacción nueva <strong>no</strong> reescribe lo que las
            personas ya aceptaron — esa aceptación es la prueba, y reescribirla la rompería. La
            redacción definitiva la tiene que revisar un abogado en Paraguay.
          </div>
          <div style={{display:'grid',gridTemplateColumns:'160px 1fr',gap:10,marginBottom:10}}>
            <RdIn value={nv.version} placeholder="v1" onChange={e=>setNv({...nv,version:e.target.value})}/>
            <RdIn value={nv.title} onChange={e=>setNv({...nv,title:e.target.value})}/>
          </div>
          <RdArea value={nv.body} onChange={e=>setNv({...nv,body:e.target.value})} style={{minHeight:260}}/>
          <div style={{marginTop:12}}><Btn onClick={publicar}>Publicar como vigente</Btn></div>
        </div>
      </SectionCard>

      <SectionCard title="Versiones">
        <div style={{padding:18}}>
          {rows===null ? 'Cargando…' : rows.length===0 ? <MkEmpty text="Sin versiones."/>
            : rows.map((r,i)=>(
                <div key={r.id} style={{padding:'10px 0',borderTop:i?`1px solid ${C.border}`:'none',
                  display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
                  <strong style={{fontSize:13,color:C.ink}}>{r.version}</strong>
                  {r.is_current && <span style={{padding:'2px 9px',borderRadius:20,fontSize:11,fontWeight:700,
                    background:C.green+'1A',color:C.green}}>vigente</span>}
                  <span style={{fontSize:12,color:C.dim,flex:1}}>{r.title}</span>
                  <span style={{fontSize:12,color:C.dim}}>{fmtRelTime(r.published_at)}</span>
                </div>))}
        </div>
      </SectionCard>
    </div>
  );
}

function PageComensales({setFlash}) {
  const [tab,setTab] = useState('resumen');
  const [ov,setOv]   = useState(null);
  const [miss,setMiss] = useState(false);
  const [bump,setBump] = useState(0);

  const loadOv = useCallback(async ()=>{
    if (!db) { setOv(null); return; }
    const {data,error} = await db.rpc('superadmin_diner_overview');
    if (error) {
      setMiss(/function|does not exist|schema cache|PGRST202/i.test(error.message||''));
      setOv(null); return;
    }
    setMiss(false); setOv(data||null);
  },[]);
  useEffect(()=>{ loadOv(); },[loadOv,bump]);

  if (miss) return (
    <MkEmpty text="App de comensales no disponible: falta aplicar la migración 200 en Supabase."/>
  );

  const pending = (ov?.reviews_pending||0) + (ov?.photos_pending||0);

  return (
    <div className="animate-in">
      <MkTabBar active={tab} onSelect={setTab}
        tabs={CM_TABS.map(t=>t.id==='resenas'?{...t,badge:pending}:t)}/>

      {tab==='resumen'     && <CmResumen ov={ov} setTab={setTab}/>}
      {tab==='comensales'  && <CmComensales ov={ov} setFlash={setFlash} onChanged={()=>setBump(b=>b+1)}/>}
      {tab==='experiencias'&& <CmExperiencias setFlash={setFlash}/>}
      {tab==='sitio'       && <CmSitio setFlash={setFlash}/>}
      {tab==='experiencia' && <CmExperiencia setFlash={setFlash}/>}
      {tab==='insignias'   && <CmInsignias setFlash={setFlash}/>}
      {tab==='colecciones' && <CmColecciones setFlash={setFlash}/>}
      {tab==='retos'       && <CmRetos setFlash={setFlash}/>}
      {tab==='resenas'     && <CmResenas setFlash={setFlash} onChanged={()=>setBump(b=>b+1)}/>}
      {tab==='registro'    && <CmRegistro setFlash={setFlash}/>}
      {tab==='acceso'      && <CmAcceso setFlash={setFlash}/>}
    </div>
  );
}

/* ─── Imágenes de la vitrina (bucket `vitrina`, mig 204) ─── */
// Subir + guardar la URL. Se comparte entre las experiencias y la portada
// porque es la misma operación y el mismo bucket.
async function uploadVitrina(file) {
  if (!file) return null;
  if (!/^image\//.test(file.type || '')) throw new Error('Tiene que ser una imagen');
  if (file.size > 5 * 1024 * 1024)       throw new Error('La imagen no puede pasar de 5 MB');
  const ext  = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await db.storage.from('vitrina')
    .upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  return db.storage.from('vitrina').getPublicUrl(path).data.publicUrl;
}

function ImagePicker({value, onChange, label, hint}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState('');
  const pick = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    setBusy(true); setErr('');
    try { onChange(await uploadVitrina(f)); }
    catch (ex) { setErr(ex.message || 'No se pudo subir'); }
    setBusy(false);
  };
  return (
    <div style={{marginBottom:14}}>
      {label && <div style={{fontSize:12,fontWeight:700,color:C.mid,marginBottom:6}}>{label}</div>}
      <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
        <div style={{width:120,height:74,borderRadius:10,overflow:'hidden',background:C.soft,
                     border:`1px solid ${C.line}`,display:'flex',alignItems:'center',
                     justifyContent:'center',flexShrink:0}}>
          {value ? <img src={value} alt="" style={{width:'100%',height:'100%',objectFit:'cover'}}/>
                 : <span style={{fontSize:11,color:C.dim}}>sin imagen</span>}
        </div>
        <label style={{cursor:busy?'wait':'pointer'}}>
          <input type="file" accept="image/*" onChange={pick} disabled={busy} style={{display:'none'}}/>
          <span style={{display:'inline-block',background:C.ink,color:'#FFF',borderRadius:8,
                        padding:'8px 14px',fontSize:12.5,fontWeight:700}}>
            {busy ? 'Subiendo…' : (value ? 'Cambiar' : 'Subir imagen')}
          </span>
        </label>
        {value && (
          <button onClick={()=>onChange(null)} style={{background:'none',border:'none',cursor:'pointer',
                   fontSize:12.5,color:C.mid,textDecoration:'underline'}}>Quitar</button>
        )}
      </div>
      {hint && <div style={{fontSize:11.5,color:C.dim,marginTop:6,lineHeight:1.5}}>{hint}</div>}
      {err  && <div style={{fontSize:11.5,color:'#B91C1C',marginTop:6}}>{err}</div>}
    </div>
  );
}

/* ─── Experiencias de la vitrina (mig 204) ─── */
// Es lo que pidió Renato: crear "Pizzas" y decidir qué locales se sugieren ahí.
// Un local entra por su RUBRO (match_types) o porque se lo eligió a mano — las
// dos vías conviven porque `business_type` es texto libre y nadie lo escribe
// igual ("Pizzeria", "pizzería", "Pizza & Pasta" son tres grupos distintos).
function CmExperiencias({setFlash}) {
  const [rows, setRows] = useState(null);
  const [rests, setRests] = useState([]);
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState('');

  const load = useCallback(async ()=>{
    if (!db) { setRows([]); return; }
    const {data, error} = await db.from('diner_experiences').select('*').order('sort_order').order('label');
    if (error) { setErr(error.message||'error'); setRows([]); return; }
    const ids = (data||[]).map(r=>r.id);
    let links = [];
    if (ids.length) {
      const lk = await db.from('diner_experience_places').select('experience_id,restaurant_id').in('experience_id', ids);
      links = lk.data || [];
    }
    setErr('');
    setRows((data||[]).map(r=>({...r, places: links.filter(l=>l.experience_id===r.id).map(l=>l.restaurant_id)})));
  },[]);

  useEffect(()=>{ load(); },[load]);
  useEffect(()=>{ (async()=>{
    if (!db) return;
    const {data} = await db.from('restaurants').select('id,name,business_type,city')
      .eq('is_active',true).order('name').limit(500);
    setRests(data||[]);
  })(); },[]);

  const save = async () => {
    const row = {...edit};
    const places = row.places || [];
    const isNew = !!row.__new;
    delete row.places; delete row.__new;
    if (!row.label || !row.slug) { setFlash({type:'error',text:'Nombre y slug son obligatorios'}); return; }
    if (typeof row.match_types === 'string') {
      row.match_types = row.match_types.split(',').map(s=>s.trim()).filter(Boolean);
    }
    row.sort_order = Number(row.sort_order||0);
    setBusy(true);
    try {
      let id = row.id;
      if (isNew) {
        delete row.id;
        const {data,error} = await db.from('diner_experiences').insert(row).select('id').single();
        if (error) throw error;
        id = data.id;
      } else {
        const {error} = await db.from('diner_experiences').update(row).eq('id', id);
        if (error) throw error;
      }
      // Los locales sugeridos se reescriben enteros: son pocos y así no hay que
      // calcular altas y bajas por separado.
      await db.from('diner_experience_places').delete().eq('experience_id', id);
      if (places.length) {
        await db.from('diner_experience_places')
          .insert(places.map((rid,i)=>({experience_id:id, restaurant_id:rid, sort_order:i})));
      }
      setFlash({type:'ok',text:'Experiencia guardada'});
      setEdit(null); load();
    } catch(e) { setFlash({type:'error',text:'Error: '+(e.message||e)}); }
    setBusy(false);
  };

  const del = async (row) => {
    if (!window.confirm('¿Borrar la experiencia "'+row.label+'"?')) return;
    const {error} = await db.from('diner_experiences').delete().eq('id',row.id);
    if (error) { setFlash({type:'error',text:'Error: '+error.message}); return; }
    load();
  };

  // NFD separa la letra de su tilde y el rango siguiente borra la tilde suelta:
  // "Cafetería" → "cafeteria". Mismo idioma que los otros slugify del panel.
  const slugify = s => String(s||'').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g,'')
    .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

  if (rows === null) return <div style={{display:'flex',justifyContent:'center',padding:40}}><Spinner/></div>;

  return (
    <SectionCard title="Experiencias de la vitrina"
      action={<Btn onClick={()=>setEdit({__new:true, is_active:true, sort_order:(rows.length+1)*10, match_types:'', places:[]})}>Nueva experiencia</Btn>}>
      <div style={{padding:18}}>
        <div style={{fontSize:12.5,color:C.mid,lineHeight:1.7,marginBottom:16}}>
          Son las categorías que ve el comensal en <b>mythos.com.py/clientes</b>. Un local
          entra a una experiencia por su <b>rubro</b> o porque lo elegís a mano — las dos
          cosas suman. Si no hay ninguna activa, la vitrina agrupa por el rubro que cada
          dueño cargó, como antes.
        </div>

        {err && <div style={{fontSize:12.5,color:'#B91C1C',marginBottom:12}}>
          {/rela|exist/i.test(err) ? 'Falta aplicar la migración 204.' : err}
        </div>}

        {rows.length === 0 ? (
          <div style={{fontSize:13,color:C.dim}}>Todavía no creaste ninguna experiencia.</div>
        ) : (
          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            {rows.map(r=>(
              <div key={r.id} style={{display:'flex',gap:12,alignItems:'center',padding:12,
                     border:`1px solid ${C.line}`,borderRadius:10,opacity:r.is_active?1:.5}}>
                <div style={{width:64,height:44,borderRadius:8,overflow:'hidden',background:C.soft,flexShrink:0}}>
                  {r.image_url && <img src={r.image_url} alt="" style={{width:'100%',height:'100%',objectFit:'cover'}}/>}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13.5,fontWeight:700,color:C.ink}}>{r.label}</div>
                  <div style={{fontSize:11.5,color:C.dim,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                    /{r.slug} · rubros: {(r.match_types||[]).join(', ')||'—'} · a mano: {r.places.length}
                  </div>
                </div>
                <Btn variant="ghost" onClick={()=>setEdit({...r, match_types:(r.match_types||[]).join(', ')})}>Editar</Btn>
                <Btn variant="ghost" onClick={()=>del(r)}>Borrar</Btn>
              </div>
            ))}
          </div>
        )}
      </div>

      {edit && (
        <Modal title={edit.__new?'Nueva experiencia':'Editar experiencia'} onClose={()=>setEdit(null)} width={560}>
          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            <FormField label="Nombre visible">
              <SInp value={edit.label||''} placeholder="Pizzas"
                onChange={v=>setEdit({...edit, label:v,
                  slug: edit.__new && !edit.__slugTouched ? slugify(v) : edit.slug})}/>
            </FormField>
            <FormField label="Slug (va en el enlace)">
              <SInp value={edit.slug||''} placeholder="pizzas"
                onChange={v=>setEdit({...edit, slug:slugify(v), __slugTouched:true})}/>
            </FormField>
            <FormField label="Bajada">
              <SInp value={edit.subtitle||''} placeholder="Napolitanas, al taglio y para la mesa larga"
                onChange={v=>setEdit({...edit, subtitle:v})}/>
            </FormField>

            <ImagePicker label="Imagen de fondo" value={edit.image_url}
              onChange={u=>setEdit({...edit, image_url:u})}
              hint="Se ve detrás del título en la tarjeta y en la página de la experiencia. Horizontal, mínimo 1200px de ancho."/>

            <FormField label="Rubros que agrupa">
              <SInp value={edit.match_types||''} placeholder="Pizzeria, Pizzería, Pizza"
                onChange={v=>setEdit({...edit, match_types:v})}/>
              <div style={{fontSize:11.5,color:C.dim,marginTop:5,lineHeight:1.5}}>
                Separados por coma. Es el rubro que el dueño cargó en su onboarding, y
                cada uno lo escribe distinto — poné todas las variantes.
              </div>
            </FormField>

            <FormField label="Locales sugeridos (además de los del rubro)">
              <div style={{maxHeight:190,overflowY:'auto',border:`1px solid ${C.line}`,
                           borderRadius:8,padding:8}}>
                {rests.length===0 ? <div style={{fontSize:12,color:C.dim}}>Sin restaurantes.</div>
                : rests.map(rr=>{
                  const on = (edit.places||[]).includes(rr.id);
                  return (
                    <label key={rr.id} style={{display:'flex',alignItems:'center',gap:9,
                             padding:'5px 2px',cursor:'pointer',fontSize:12.5}}>
                      <input type="checkbox" checked={on} onChange={()=>setEdit({...edit,
                        places: on ? edit.places.filter(x=>x!==rr.id) : [...(edit.places||[]), rr.id]})}/>
                      <span style={{color:C.ink}}>{rr.name}</span>
                      <span style={{color:C.dim}}>{[rr.business_type, rr.city].filter(Boolean).join(' · ')}</span>
                    </label>
                  );
                })}
              </div>
            </FormField>

            <div style={{display:'flex',gap:14,alignItems:'center'}}>
              <FormField label="Orden">
                <SInp type="number" value={edit.sort_order??0}
                  onChange={v=>setEdit({...edit, sort_order:v})}/>
              </FormField>
              <label style={{display:'flex',alignItems:'center',gap:8,fontSize:13,marginTop:18}}>
                <input type="checkbox" checked={edit.is_active!==false}
                  onChange={e=>setEdit({...edit, is_active:e.target.checked})}/>
                Activa
              </label>
            </div>
          </div>
        </Modal>
      )}
    </SectionCard>
  );
}

/* ─── Textos e imágenes del sitio (mig 204) ─── */
// El copy va en un jsonb, no en columnas: cada frase nueva que quiera Renato
// exigiría una migración. Vacío = el texto por defecto del front.
const SITE_FIELDS = [
  ['hero_eyebrow', 'Portada · línea de arriba',  'Tu próxima salida', false],
  ['hero_title',   'Portada · título',           '¿Qué te gustaría\ncomer hoy?', true],
  ['hero_sub',     'Portada · bajada',           'Descubrí los restaurantes, bares y cafés que están en Mythos…', true],
  ['hero_cta',     'Portada · botón',            'Explorar lugares', false],
  ['exps_eyebrow', 'Experiencias · línea de arriba', 'Experiencias', false],
  ['exps_title',   'Experiencias · título',      'Elegí el plan.\nNosotros, los lugares.', true],
  ['exps_sub',     'Experiencias · bajada',      'Cada experiencia agrupa los lugares que la hacen posible…', true],
];

function CmSitio({setFlash}) {
  const [cfg, setCfg]   = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState('');

  const load = useCallback(async ()=>{
    if (!db) return;
    const {data, error} = await db.from('diner_app_config').select('site_texts,hero_image_url').maybeSingle();
    if (error) { setErr(error.message||'error'); setCfg({}); return; }
    setErr(''); setCfg({ ...(data?.site_texts||{}), hero_image_url: data?.hero_image_url||null });
  },[]);
  useEffect(()=>{ load(); },[load]);

  const save = async () => {
    setBusy(true);
    try {
      const { hero_image_url, ...texts } = cfg;
      // Las claves vacías se BORRAN en vez de guardarse como '': una cadena
      // vacía taparía el texto por defecto y dejaría el hueco en blanco.
      const clean = {};
      Object.keys(texts).forEach(k=>{ if (String(texts[k]||'').trim()) clean[k]=texts[k]; });
      const {error} = await db.from('diner_app_config')
        .update({ site_texts: clean, hero_image_url: hero_image_url||null }).eq('id', true);
      if (error) throw error;
      setFlash({type:'ok',text:'Sitio actualizado'});
    } catch(e) { setFlash({type:'error',text:'Error: '+(e.message||e)}); }
    setBusy(false);
  };

  if (cfg === null) return <div style={{display:'flex',justifyContent:'center',padding:40}}><Spinner/></div>;

  return (
    <SectionCard title="Textos e imágenes de la vitrina"
      action={<Btn onClick={save} disabled={busy}>{busy?'Guardando…':'Guardar'}</Btn>}>
      <div style={{padding:18}}>
        <div style={{fontSize:12.5,color:C.mid,lineHeight:1.7,marginBottom:16}}>
          Es lo que se lee en <b>mythos.com.py/clientes</b> sin iniciar sesión. Lo que
          dejes vacío usa el texto por defecto.
        </div>

        {err && <div style={{fontSize:12.5,color:'#B91C1C',marginBottom:12}}>
          {/column|exist/i.test(err) ? 'Falta aplicar la migración 204.' : err}
        </div>}

        <ImagePicker label="Imagen de portada" value={cfg.hero_image_url}
          onChange={u=>setCfg({...cfg, hero_image_url:u})}
          hint="Va detrás del título de la portada, oscurecida para que el texto se lea. Horizontal, mínimo 1600px de ancho."/>

        <div style={{display:'flex',flexDirection:'column',gap:12,marginTop:6}}>
          {SITE_FIELDS.map(([k,label,ph,multi])=>(
            <FormField key={k} label={label}>
              {multi
                ? <STa value={cfg[k]||''} onChange={v=>setCfg({...cfg,[k]:v})} placeholder={ph} rows={2}/>
                : <SInp value={cfg[k]||''} onChange={v=>setCfg({...cfg,[k]:v})} placeholder={ph}/>}
            </FormField>
          ))}
          <div style={{fontSize:11.5,color:C.dim,lineHeight:1.5}}>
            En los títulos, un salto de línea se respeta tal cual lo escribís.
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

/* ─── Resumen ─── */
function CmResumen({ov, setTab}) {
  if (!ov) return <div style={{display:'flex',justifyContent:'center',padding:40}}><Spinner/></div>;
  const n = v => Number(v||0).toLocaleString('es-PY');
  return (
    <div>
      <div className="sa-kpis" style={{marginBottom:18}}>
        <Kpi label="Comensales" value={n(ov.diners_total)} icon="users"
             sub={`${n(ov.diners_active)} activos · ${n(ov.diners_30d)} en 30 días`}
             onClick={()=>setTab('comensales')}/>
        <Kpi label="Registro completado" value={n(ov.diners_onboarded)} icon="fileText"
             sub={ov.diners_total ? Math.round(100*ov.diners_onboarded/ov.diners_total)+'% del total' : 'sin datos'}
             onClick={()=>setTab('registro')}/>
        <Kpi label="Reseñas" value={n(ov.reviews_total)} icon="star"
             sub={ov.avg_stars ? `promedio ${ov.avg_stars} ★` : 'sin reseñas'}
             onClick={()=>setTab('resenas')}/>
        <Kpi label="Fichas vinculadas" value={n(ov.links_total)} icon="link"
             sub={`${n(ov.xp_total)} XP repartido`}/>
      </div>

      {(ov.reviews_pending>0 || ov.photos_pending>0 || ov.recovery_pending>0) && (
        <div style={{background:TINT.warnBg,border:`1px solid ${C.orange}`,borderRadius:10,
                     padding:'12px 16px',marginBottom:18,display:'flex',alignItems:'center',gap:12}}>
          <Icon name="alert" size={16}/>
          <span style={{fontSize:13,color:TINT.warnText,flex:1}}>
            Hay {ov.reviews_pending>0 && <b>{ov.reviews_pending} reseña{ov.reviews_pending!==1?'s':''}</b>}
            {ov.reviews_pending>0 && ov.photos_pending>0 && ' y '}
            {ov.photos_pending>0 && <b>{ov.photos_pending} foto{ov.photos_pending!==1?'s':''}</b>}
            {(ov.reviews_pending>0||ov.photos_pending>0) && ' esperando moderación'}
            {ov.recovery_pending>0 && `${(ov.reviews_pending||ov.photos_pending)?'. Además, ':''}${ov.recovery_pending} pedido(s) de recuperación de cuenta`}.
          </span>
          <Btn size="sm" onClick={()=>setTab('resenas')}>Revisar</Btn>
        </div>
      )}

      <div style={{display:'grid',gridTemplateColumns:'1.6fr 1fr',gap:18}}>
        <SectionCard title="Top comensales por experiencia">
          {(ov.top_diners||[]).length===0 ? <MkEmpty text="Todavía nadie acumuló experiencia."/> : (
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse'}}>
                <thead><tr>
                  <Th>#</Th><Th>Comensal</Th><Th>Nivel</Th>
                  <Th style={{textAlign:'right'}}>XP</Th>
                  <Th style={{textAlign:'right'}}>Reseñas</Th>
                  <Th style={{textAlign:'right'}}>Credibilidad</Th>
                </tr></thead>
                <tbody>
                  {ov.top_diners.map((d,i)=>(
                    <tr key={d.id}>
                      <Td style={{color:C.dim,width:34}}>{i+1}</Td>
                      <Td>
                        <div style={{fontWeight:600,color:C.ink}}>{d.display_name||'Comensal'}</div>
                        <div style={{fontSize:11,color:C.dim}}>{d.email||'—'}{d.city?' · '+d.city:''}</div>
                      </Td>
                      <Td style={{fontSize:12,color:C.mid}}>{d.level_name||'—'}</Td>
                      <Td style={{textAlign:'right',fontWeight:700}}>{n(d.xp)}</Td>
                      <Td style={{textAlign:'right'}}>{n(d.reviews)}</Td>
                      <Td style={{textAlign:'right',color:d.credibility>=60?C.green:C.mid}}>{d.credibility}%</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Por ciudad">
          {(ov.by_city||[]).length===0 ? <MkEmpty text="Sin datos."/> : (
            <div style={{padding:'6px 0'}}>
              {ov.by_city.map(r=>(
                <div key={r.city} style={{display:'flex',justifyContent:'space-between',
                     padding:'8px 18px',fontSize:13}}>
                  <span style={{color:C.mid}}>{r.city}</span>
                  <span style={{fontWeight:700,color:C.ink}}>{n(r.n)}</span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

/* ─── Comensales (lista + soporte) ─── */
function CmComensales({ov, setFlash, onChanged}) {
  const [q,setQ] = useState('');
  const [adj,setAdj] = useState(null);
  const [xp,setXp]   = useState('');
  const [note,setNote] = useState('');
  const rows = (ov?.top_diners||[]).filter(d=>{
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return (d.display_name||'').toLowerCase().includes(s) || (d.email||'').toLowerCase().includes(s);
  });

  const applyAdjust = async () => {
    const v = parseInt(xp,10);
    if (!v) { setFlash({type:'error',text:'El ajuste no puede ser 0.'}); return; }
    const {data,error} = await db.rpc('superadmin_adjust_xp',
      {p_diner:adj.id, p_xp:v, p_note:note||'ajuste de soporte'});
    if (error || !data?.ok) { setFlash({type:'error',text:'No se pudo ajustar: '+(error?.message||'')}); return; }
    setFlash({type:'ok',text:'Ajuste registrado. Total: '+Number(data.total).toLocaleString('es-PY')+' XP'});
    setAdj(null); setXp(''); setNote(''); onChanged && onChanged();
  };

  return (
    <>
      <SectionCard title="Comensales" action={
        <div style={{width:260}}><SInp value={q} onChange={setQ} placeholder="Buscar por nombre o correo…"/></div>
      }>
        <div style={{padding:'12px 18px',fontSize:12,color:C.mid,lineHeight:1.7,
                     borderBottom:`1px solid ${C.border}`}}>
          Esta es la única pantalla de Mythos que ve la identidad global de una persona.
          El staff de un restaurante NO la ve: sólo alcanza su propia ficha de cliente y
          el XP acumulado en su local. Que alguien sea a la vez mozo de un restaurante y
          comensal no es deducible desde ningún panel — y tiene que seguir siendo así.
        </div>
        {rows.length===0 ? <MkEmpty text="Sin comensales que coincidan."/> : (
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse'}}>
              <thead><tr>
                <Th>Comensal</Th><Th>Ciudad</Th><Th>Nivel</Th>
                <Th style={{textAlign:'right'}}>XP</Th>
                <Th style={{textAlign:'right'}}>Reseñas</Th>
                <Th style={{textAlign:'right'}}>Credibilidad</Th>
                <Th style={{textAlign:'right',width:130}}>Soporte</Th>
              </tr></thead>
              <tbody>
                {rows.map(d=>(
                  <tr key={d.id}>
                    <Td>
                      <div style={{fontWeight:600,color:C.ink}}>{d.display_name||'Comensal'}</div>
                      <div style={{fontSize:11,color:C.dim}}>{d.email||'—'}</div>
                    </Td>
                    <Td style={{fontSize:12,color:C.mid}}>{d.city||'—'}</Td>
                    <Td style={{fontSize:12,color:C.mid}}>{d.level_name||'—'}</Td>
                    <Td style={{textAlign:'right',fontWeight:700}}>{Number(d.xp||0).toLocaleString('es-PY')}</Td>
                    <Td style={{textAlign:'right'}}>{d.reviews}</Td>
                    <Td style={{textAlign:'right'}}>{d.credibility}%</Td>
                    <Td style={{textAlign:'right'}}>
                      <Btn size="sm" variant="ghost" onClick={()=>setAdj(d)}>Ajustar XP</Btn>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {adj && (
        <Modal title={'Ajustar XP · '+(adj.display_name||adj.email)} onClose={()=>setAdj(null)} width={440}>
          <div style={{fontSize:12.5,color:C.mid,lineHeight:1.7,marginBottom:16}}>
            El ajuste se anota como una fila más en el libro, nunca editando el pasado:
            así el historial sigue siendo auditable. Un número negativo resta.
          </div>
          <FormField label="XP a sumar o restar" hint="Ej.: 500 o −200">
            <SInp type="number" value={xp} onChange={setXp}/>
          </FormField>
          <FormField label="Motivo" hint="Queda guardado junto al asiento.">
            <SInp value={note} onChange={setNote} placeholder="Compensación por pedido no acreditado"/>
          </FormField>
          <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
            <Btn variant="ghost" onClick={()=>setAdj(null)}>Cancelar</Btn>
            <Btn onClick={applyAdjust}>Registrar ajuste</Btn>
          </div>
        </Modal>
      )}
    </>
  );
}

/* ─── Experiencia: reglas + niveles ─── */
function CmExperiencia({setFlash}) {
  return (
    <div style={{display:'flex',flexDirection:'column',gap:18}}>
      <CatalogEditor
        table="xp_rules" pk="code" orderBy="sort_order" setFlash={setFlash}
        title="Cuánto XP da cada cosa"
        migNote="Falta aplicar la migración 200 en Supabase."
        help={<>
          El XP viene de <b>contribuir</b>, no de cuánto se gasta: el nivel mide lo que
          dice medir y el que más plata pone no compra el voto más pesado sobre el
          ranking. <b>El techo diario no es un detalle</b> — sin él, quien más actividad
          genera termina siendo quien más influye. Si activás <i>XP por ₲1.000</i>,
          ponele techo.
        </>}
        columns={[
          {key:'code',        label:'Código', required:true, hint:'No se cambia: es lo que escribe la base al acreditar.'},
          {key:'label',       label:'Nombre', required:true},
          {key:'description', label:'Descripción', type:'textarea'},
          {key:'xp_fixed',    label:'XP fijo', type:'number', def:0},
          {key:'xp_per_unit', label:'XP por unidad', type:'number', def:0, hint:'Por dimensión calificada, por foto, por voto…'},
          {key:'xp_per_1000', label:'XP por ₲1.000', type:'number', def:0, hint:'Dejalo en 0 salvo que quieras premiar el gasto.'},
          {key:'per_event_cap',label:'Tope por evento', type:'number', hint:'Vacío = sin tope.'},
          {key:'daily_cap',   label:'Techo diario', type:'number', hint:'Vacío = sin techo. Recomendado en todo lo repetible.'},
          {key:'is_active',   label:'Activa', type:'bool', def:true},
          {key:'sort_order',  label:'Orden', type:'number', def:0},
        ]}/>

      <CatalogEditor
        table="xp_levels" pk="level" orderBy="level" setFlash={setFlash}
        title="La escalera de niveles"
        help={<>
          El nivel <b>no se guarda en ningún lado</b>: se deriva comparando el XP contra
          esta tabla. Por eso cambiar acá recalcula a todos los comensales al instante,
          sin migrar un solo dato. <b>Peso de crítica</b> es cuánto vale la reseña de
          alguien de este nivel en la nota del restaurante.
        </>}
        columns={[
          {key:'level',        label:'Nivel', type:'number', required:true},
          {key:'name',         label:'Título', required:true, hint:'Novato, Explorador, Catador, Crítico, Experto, Inspector, Embajador, Leyenda Gastronómica…'},
          {key:'min_xp',       label:'XP mínimo', type:'number', required:true},
          {key:'review_weight',label:'Peso de crítica', type:'number', def:1},
        ]}/>
    </div>
  );
}

/* ─── Insignias ─── */
const CRIT_OPTS = [
  {v:'orders_total',        l:'Cantidad de pedidos'},
  {v:'restaurants_total',   l:'Restaurantes distintos'},
  {v:'reviews_total',       l:'Reseñas publicadas'},
  {v:'photos_total',        l:'Fotos aprobadas'},
  {v:'helpful_total',       l:'Votos útiles recibidos'},
  {v:'level',               l:'Nivel alcanzado'},
  {v:'orders_by_type',      l:'Pedidos en un tipo de local'},
  {v:'restaurants_by_type', l:'Locales distintos de un tipo'},
  {v:'restaurants_by_city', l:'Locales distintos de una ciudad'},
];

function CmInsignias({setFlash}) {
  return (
    <CatalogEditor
      table="diner_badges_catalog" orderBy="sort_order" setFlash={setFlash}
      title="Insignias"
      migNote="Falta aplicar la migración 200 en Supabase."
      help={<>
        Se otorgan solas cuando el comensal abre su perfil. <b>Tipos de local</b> se
        compara contra <code>restaurants.business_type</code>, que es texto libre: poné
        todas las variantes que uses (<i>pizzeria, pizzería, pizza</i>) o la insignia no
        se va a disparar nunca.
      </>}
      columns={[
        {key:'code',          label:'Código', required:true},
        {key:'name',          label:'Nombre', required:true},
        {key:'emoji',         label:'Emoji', def:'🏅'},
        {key:'description',   label:'Descripción', type:'textarea'},
        {key:'criteria_type', label:'Se gana por', type:'select', options:CRIT_OPTS, required:true},
        {key:'criteria_value',label:'Cantidad', type:'number', def:1},
        {key:'match_types',   label:'Tipos de local', type:'tags', hint:'Separados por coma. Sólo si el criterio es "de un tipo".'},
        {key:'match_city',    label:'Ciudad', hint:'Sólo si el criterio es por ciudad.'},
        {key:'xp_reward',     label:'XP de regalo', type:'number', def:0},
        {key:'is_active',     label:'Activa', type:'bool', def:true},
        {key:'sort_order',    label:'Orden', type:'number', def:0},
      ]}/>
  );
}

/* ─── Colecciones ─── */
function CmColecciones({setFlash}) {
  return (
    <CatalogEditor
      table="diner_collections" orderBy="sort_order" setFlash={setFlash}
      title="Colecciones"
      migNote="Falta aplicar la migración 200 en Supabase."
      help={<>
        "Visitaste 18 de 35 hamburgueserías". Si dejás <b>Total</b> vacío, el
        denominador lo calcula la base contando los locales activos que
        realmente matchean — que es lo correcto: prometer 35 cuando hay 12 es una
        promesa que la app no puede cumplir.
      </>}
      columns={[
        {key:'code',        label:'Código', required:true},
        {key:'name',        label:'Nombre', required:true},
        {key:'emoji',       label:'Emoji', def:'📚'},
        {key:'description', label:'Descripción', type:'textarea'},
        {key:'match_types', label:'Tipos de local', type:'tags', required:true},
        {key:'match_city',  label:'Ciudad', hint:'Vacío = todo el país.'},
        {key:'target_count',label:'Total', type:'number', hint:'Vacío = se cuenta solo.'},
        {key:'reward_xp',   label:'XP al completar', type:'number', def:0},
        {key:'is_active',   label:'Activa', type:'bool', def:true},
        {key:'sort_order',  label:'Orden', type:'number', def:0},
      ]}/>
  );
}

/* ─── Retos ─── */
function CmRetos({setFlash}) {
  return (
    <CatalogEditor
      table="diner_challenges" orderBy="sort_order" setFlash={setFlash}
      title="Retos"
      migNote="Falta aplicar la migración 200 en Supabase."
      help={<>
        El reto se vuelve a poner en juego cada semana o cada mes según su período, y el
        premio se entrega <b>una sola vez por período</b>: correr el motor dos veces no
        reparte dos veces.
      </>}
      columns={[
        {key:'code',        label:'Código', required:true},
        {key:'name',        label:'Nombre', required:true},
        {key:'emoji',       label:'Emoji', def:'🎯'},
        {key:'description', label:'Descripción', type:'textarea'},
        {key:'period',      label:'Período', type:'select', def:'month',
         options:[{v:'week',l:'Semanal'},{v:'month',l:'Mensual'},{v:'once',l:'Una sola vez'}]},
        {key:'goal_type',   label:'Objetivo', type:'select', required:true,
         options:[{v:'orders',l:'Pedidos'},{v:'restaurants',l:'Restaurantes distintos'},
                  {v:'reviews',l:'Reseñas'},{v:'photos',l:'Fotos'},
                  {v:'restaurants_by_type',l:'Locales de un tipo'}]},
        {key:'goal_value',  label:'Cantidad', type:'number', def:1},
        {key:'match_types', label:'Tipos de local', type:'tags'},
        {key:'reward_xp',   label:'XP de premio', type:'number', def:0},
        {key:'reward_text', label:'Premio extra', hint:'Texto libre: un cupón, un beneficio…'},
        {key:'is_active',   label:'Activo', type:'bool', def:true},
        {key:'sort_order',  label:'Orden', type:'number', def:0},
      ]}/>
  );
}

/* ─── Reseñas: moderación + dimensiones ─── */
function CmResenas({setFlash, onChanged}) {
  const [sub,setSub]   = useState('cola');
  const [st,setSt]     = useState('pending');
  const [q,setQ]       = useState(null);
  const [busy,setBusy] = useState('');

  const load = useCallback(async ()=>{
    if (!db) return;
    const {data} = await db.rpc('superadmin_review_queue',{p_status:st, p_limit:150});
    setQ(data||{reviews:[],photos:[]});
  },[st]);
  useEffect(()=>{ if (sub==='cola') load(); },[load,sub]);

  const moderate = async (kind,id,status) => {
    setBusy(id);
    const {data,error} = await db.rpc('superadmin_moderate',{p_kind:kind,p_id:id,p_status:status,p_note:null});
    setBusy('');
    if (error || !data?.ok) { setFlash({type:'error',text:'No se pudo moderar.'}); return; }
    setFlash({type:'ok',text:status==='approved'?'Aprobado':'Rechazado'});
    load(); onChanged && onChanged();
  };

  return (
    <div>
      <div style={{display:'flex',gap:8,marginBottom:16}}>
        <FilterBtn active={sub==='cola'} onClick={()=>setSub('cola')}>Moderación</FilterBtn>
        <FilterBtn active={sub==='dims'} onClick={()=>setSub('dims')}>Aspectos que se califican</FilterBtn>
      </div>

      {sub==='dims' ? (
        <CatalogEditor
          table="review_dimensions" pk="code" orderBy="sort_order" setFlash={setFlash}
          title="Aspectos de una reseña"
          migNote="Falta aplicar la migración 200 en Supabase."
          help={<>
            Son de plataforma —iguales para todos los locales— para que la nota sea
            comparable entre restaurantes. Cada aspecto que el comensal califica le suma
            XP: por eso agregar uno nuevo cambia cuánto rinde escribir una reseña
            completa. <b>Aplica a</b> permite que "Limpieza" sólo aparezca en salón y
            "Delivery" sólo en pedidos a domicilio.
          </>}
          columns={[
            {key:'code',        label:'Código', required:true},
            {key:'label',       label:'Nombre', required:true},
            {key:'emoji',       label:'Emoji'},
            {key:'description', label:'Ayuda', hint:'La frase corta que ve el comensal debajo.'},
            {key:'applies_to',  label:'Aplica a', type:'select', def:'all',
             options:[{v:'all',l:'Todos los pedidos'},{v:'dine_in',l:'Sólo en el local'},
                      {v:'delivery',l:'Sólo delivery'},{v:'pickup',l:'Sólo retiro'}]},
            {key:'is_active',   label:'Activo', type:'bool', def:true},
            {key:'sort_order',  label:'Orden', type:'number', def:0},
          ]}/>
      ) : (
        <>
          <div style={{display:'flex',gap:8,marginBottom:14}}>
            {[['pending','Pendientes'],['approved','Aprobadas'],['rejected','Rechazadas'],['all','Todas']]
              .map(([v,l])=><FilterBtn key={v} active={st===v} onClick={()=>setSt(v)}>{l}</FilterBtn>)}
          </div>

          <SectionCard title="Reseñas" style={{marginBottom:18}}>
            {!q ? <div style={{display:'flex',justifyContent:'center',padding:36}}><Spinner/></div>
             : (q.reviews||[]).length===0 ? <MkEmpty text="Nada en esta bandeja."/> : (
              <div>
                {q.reviews.map(r=>(
                  <div key={r.id} style={{padding:'14px 18px',borderBottom:`1px solid ${C.border}`}}>
                    <div style={{display:'flex',justifyContent:'space-between',gap:14,alignItems:'flex-start'}}>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                          <span style={{fontWeight:700,color:C.ink,fontSize:13.5}}>{r.restaurant_name}</span>
                          <span style={{fontSize:12,color:C.orange,fontWeight:700}}>{'★'.repeat(r.stars)}</span>
                          <span style={{fontSize:11,color:C.dim}}>
                            {r.author} · credibilidad {r.author_credibility}% · peso ×{r.weight}
                          </span>
                        </div>
                        {r.comment && <div style={{fontSize:13,color:C.mid,lineHeight:1.65,marginTop:6}}>{r.comment}</div>}
                        {Object.keys(r.scores||{}).length>0 && (
                          <div style={{display:'flex',flexWrap:'wrap',gap:6,marginTop:8}}>
                            {Object.entries(r.scores).map(([k,v])=>(
                              <span key={k} style={{fontSize:11,color:C.mid,background:'var(--bg-subtle)',
                                border:`1px solid ${C.border}`,borderRadius:6,padding:'2px 7px'}}>{k} {v}★</span>
                            ))}
                          </div>
                        )}
                        <div style={{fontSize:11,color:C.dim,marginTop:7}}>
                          {new Date(r.created_at).toLocaleString('es-PY')} · {r.service_type}
                        </div>
                      </div>
                      <div style={{display:'flex',flexDirection:'column',gap:6,flexShrink:0}}>
                        {r.status!=='approved' && <Btn size="sm" variant="success" disabled={busy===r.id}
                          onClick={()=>moderate('review',r.id,'approved')}>Aprobar</Btn>}
                        {r.status!=='rejected' && <Btn size="sm" variant="danger" disabled={busy===r.id}
                          onClick={()=>moderate('review',r.id,'rejected')}>Rechazar</Btn>}
                        {r.status==='approved' && <Btn size="sm" variant="ghost" disabled={busy===r.id}
                          onClick={()=>moderate('review',r.id,'hidden')}>Ocultar</Btn>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Fotos">
            <div style={{padding:'12px 18px',fontSize:12,color:C.mid,lineHeight:1.7,
                         borderBottom:`1px solid ${C.border}`}}>
              El XP de la foto se acredita <b>recién al aprobarla</b>: si se pagara al
              subirla, subir basura rendiría igual que subir algo útil.
            </div>
            {!q ? null : (q.photos||[]).length===0 ? <MkEmpty text="Sin fotos en esta bandeja."/> : (
              <div style={{display:'flex',flexWrap:'wrap',gap:14,padding:18}}>
                {q.photos.map(p=>(
                  <div key={p.id} style={{width:180,border:`1px solid ${C.border}`,borderRadius:10,overflow:'hidden'}}>
                    <img src={p.storage_path} alt="" style={{width:'100%',height:130,objectFit:'cover',display:'block'}}/>
                    <div style={{padding:10}}>
                      <div style={{fontSize:12,fontWeight:600,color:C.ink,overflow:'hidden',
                        textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.restaurant_name}</div>
                      <div style={{fontSize:11,color:C.dim,marginBottom:8}}>{p.author}</div>
                      <div style={{display:'flex',gap:6}}>
                        {p.status!=='approved' && <Btn size="sm" variant="success" disabled={busy===p.id}
                          onClick={()=>moderate('photo',p.id,'approved')}>Aprobar</Btn>}
                        {p.status!=='rejected' && <Btn size="sm" variant="danger" disabled={busy===p.id}
                          onClick={()=>moderate('photo',p.id,'rejected')}>×</Btn>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}

/* ─── Registro: preguntas + analítica ─── */
function CmRegistro({setFlash}) {
  const [sub,setSub] = useState('analitica');
  const [an,setAn]   = useState(null);
  const [miss,setMiss] = useState(false);

  useEffect(()=>{
    if (sub!=='analitica' || !db) return;
    let alive = true;
    (async ()=>{
      const {data,error} = await db.rpc('diner_profile_analytics',{p_from:null,p_to:null});
      if (!alive) return;
      if (error) { setMiss(true); return; }
      setMiss(false); setAn(data||null);
    })();
    return ()=>{ alive = false; };
  },[sub]);

  return (
    <div>
      <div style={{display:'flex',gap:8,marginBottom:16}}>
        <FilterBtn active={sub==='analitica'} onClick={()=>setSub('analitica')}>Respuestas</FilterBtn>
        <FilterBtn active={sub==='preguntas'} onClick={()=>setSub('preguntas')}>Preguntas</FilterBtn>
      </div>

      {sub==='preguntas' ? (
        <CatalogEditor
          table="diner_profile_questions" pk="code" orderBy="step,sort_order" setFlash={setFlash}
          title="Preguntas del registro"
          migNote="Falta aplicar la migración 200 en Supabase."
          help={<>
            Es lo que hace útil a la app y lo que un restaurante solo no puede saber: qué
            come esta persona. <b>Paso</b> agrupa las preguntas en pantallas del wizard.
            Las <b>Opciones</b> son un JSON de <code>{'{value,label,emoji}'}</code>; el
            <i> value</i> es lo que se guarda, así que cambiarlo desconecta las respuestas
            ya cargadas — para renombrar, cambiá sólo el <i>label</i>.
          </>}
          columns={[
            {key:'code',       label:'Código', required:true},
            {key:'label',      label:'Pregunta', required:true},
            {key:'help',       label:'Aclaración'},
            {key:'kind',       label:'Tipo', type:'select', def:'multi', required:true,
             options:[{v:'multi',l:'Varias opciones'},{v:'single',l:'Una opción'},
                      {v:'text',l:'Texto libre'},{v:'number',l:'Número'},{v:'date',l:'Fecha'}]},
            {key:'options',    label:'Opciones (JSON)', type:'json'},
            {key:'is_required',label:'Obligatoria', type:'bool', def:false},
            {key:'is_active',  label:'Activa', type:'bool', def:true},
            {key:'step',       label:'Paso', type:'number', def:1},
            {key:'sort_order', label:'Orden', type:'number', def:0},
          ]}/>
      ) : miss ? (
        <MkEmpty text="Analítica del registro no disponible: falta aplicar la migración 200."/>
      ) : !an ? (
        <div style={{display:'flex',justifyContent:'center',padding:40}}><Spinner/></div>
      ) : (
        <>
          <div className="sa-kpis" style={{marginBottom:18}}>
            <Kpi label="Comensales" value={Number(an.total||0).toLocaleString('es-PY')} icon="users"/>
            <Kpi label="Completaron el registro" value={Number(an.answered||0).toLocaleString('es-PY')}
                 icon="check" sub={an.total?Math.round(100*an.answered/an.total)+'%':'—'}/>
          </div>

          <div style={{padding:'0 0 14px',fontSize:12,color:C.mid,lineHeight:1.7}}>
            Los conteos salen de la base sobre <b>todo</b> el historial, no del array que
            carga el panel: agrupar en el navegador da un número que empeora cuanto más
            crece el negocio. Las opciones que <b>nadie eligió</b> también aparecen —
            eso es información, no una fila que falta.
          </div>

          {(an.questions||[]).map(q=>(
            <SectionCard key={q.code} title={q.label} style={{marginBottom:14}}
              action={<span style={{fontSize:11,color:C.dim}}>{q.answers} respuesta{q.answers!==1?'s':''}</span>}>
              {(q.options||[]).length===0 ? <MkEmpty text="Sin respuestas todavía."/> : (
                <div style={{padding:'12px 18px'}}>
                  {q.options.map(o=>{
                    const pct = q.answers>0 ? Math.round(100*o.n/q.answers) : 0;
                    return (
                      <div key={o.value} style={{marginBottom:9}}>
                        <div style={{display:'flex',justifyContent:'space-between',fontSize:12.5,marginBottom:4}}>
                          <span style={{color:o.n?C.ink:C.dim}}>{o.emoji?o.emoji+' ':''}{o.label}</span>
                          <span style={{color:C.mid,fontWeight:600}}>{o.n} · {pct}%</span>
                        </div>
                        <div style={{height:5,background:'var(--bg-subtle)',borderRadius:9999,overflow:'hidden'}}>
                          <div style={{width:pct+'%',height:'100%',background:C.ink,borderRadius:9999}}/>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </SectionCard>
          ))}
        </>
      )}
    </div>
  );
}

/* ─── Acceso: portero de la beta + módulos + credibilidad ─── */
function CmAcceso({setFlash}) {
  const [cfg,setCfg]   = useState(null);
  const [list,setList] = useState(null);
  const [mail,setMail] = useState('');
  const [note,setNote] = useState('');
  const [busy,setBusy] = useState(false);

  const load = useCallback(async ()=>{
    if (!db) return;
    const [c,l] = await Promise.all([
      db.from('diner_app_config').select('*').maybeSingle(),
      db.from('diner_app_access').select('*').order('created_at')
    ]);
    setCfg(c.data||null); setList(l.data||[]);
  },[]);
  useEffect(()=>{ load(); },[load]);

  const patch = async (fields) => {
    setCfg(c=>({...c,...fields}));   // optimista: el toggle no debe "saltar"
    const {error} = await db.from('diner_app_config').update({...fields, updated_at:new Date().toISOString()}).eq('id',true);
    if (error) { setFlash({type:'error',text:'No se pudo guardar: '+error.message}); load(); }
  };

  const addMail = async () => {
    const v = mail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { setFlash({type:'error',text:'Escribí un correo válido.'}); return; }
    setBusy(true);
    const {error} = await db.from('diner_app_access').insert({email:v, note:note||null});
    setBusy(false);
    if (error) { setFlash({type:'error',text:/duplicate|unique/i.test(error.message)?'Ese correo ya está en la lista.':'Error: '+error.message}); return; }
    setFlash({type:'ok',text:'Correo habilitado'}); setMail(''); setNote(''); load();
  };

  const delMail = async (row) => {
    if (!window.confirm('¿Quitar '+row.email+' de la lista?')) return;
    const {error} = await db.from('diner_app_access').delete().eq('id',row.id);
    if (error) { setFlash({type:'error',text:'Error: '+error.message}); return; }
    load();
  };

  if (!cfg) return <div style={{display:'flex',justifyContent:'center',padding:40}}><Spinner/></div>;

  const MODS = [
    ['discovery_enabled',   'Descubrir restaurantes', 'La portada con el buscador y el listado.'],
    // Interruptor de la mig 201. Es distinto del portero de arriba (is_public):
    // ése decide quién puede CREAR perfil de comensal; éste decide si la vitrina
    // se ve SIN cuenta. Arranca apagado — con la beta cerrada, prenderlo es lo
    // que hace pública la portada de /clientes.
    ['public_browse_enabled','Dejar MIRAR la vitrina sin iniciar sesión',
     'Sólo mirar: la portada, las experiencias y los locales se ven sin cuenta. NO habilita a nadie a crear perfil de comensal — eso es el interruptor de arriba. Requiere "Descubrir restaurantes" prendido.'],
    ['reviews_enabled',     'Reseñas',                'Sólo puede reseñar quien pidió y pagó ahí.'],
    ['photos_enabled',      'Fotos en las reseñas',   'Pasan por moderación antes de verse.'],
    ['ranking_enabled',     'Ranking',                'Tabla de posiciones por país y por ciudad.'],
    ['badges_enabled',      'Insignias',              null],
    ['collections_enabled', 'Colecciones',            null],
    ['challenges_enabled',  'Retos',                  null],
  ];

  return (
    <div style={{display:'flex',flexDirection:'column',gap:18}}>
      <SectionCard title="Quién puede CREAR perfil de comensal">
        <div style={{padding:18}}>
          <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:14}}>
            {/* Confirmación al ABRIR, nunca al cerrar: cerrar es siempre seguro.
                Este interruptor tiene un efecto que no se ve en esta pantalla —
                con `is_public` en true, `diner_access_allowed()` (mig 200) sale
                por el `RETURN true` antes de mirar la lista de abajo, así que la
                lista deja de filtrar sin que nada acá lo indique. El 2026-08-05
                quedó prendido sin querer (se confundía con el de mirar la
                vitrina) y cuentas de restaurante terminaron como comensales. */}
            <Toggle checked={!!cfg.is_public} onChange={v=>{
              if (v && !window.confirm(
                'Vas a ABRIR el alta de comensales a cualquiera.\n\n' +
                'Desde ese momento la lista de correos habilitados DEJA DE FILTRAR: ' +
                'cualquier persona con cuenta en Mythos —dueños, mozos y cajeros incluidos— ' +
                'puede crear su perfil de comensal.\n\n' +
                'Si lo que querías es que la portada se vea sin iniciar sesión, ese es ' +
                'otro interruptor: "Dejar MIRAR la vitrina sin iniciar sesión".\n\n' +
                '¿Confirmás abrirla?')) return;
              patch({is_public:v});
            }}/>
            <div>
              <div style={{fontWeight:700,fontSize:14,color:C.ink}}>
                {cfg.is_public ? 'Cualquiera — abierta al público' : 'Sólo la lista de abajo — beta cerrada'}
              </div>
              <div style={{fontSize:12,color:C.mid,marginTop:2}}>
                {cfg.is_public
                  ? 'La lista de correos habilitados no filtra nada mientras esto esté prendido.'
                  : 'Nadie más puede crear perfil de comensal, aunque llegue a /clientes con sesión.'}
              </div>
            </div>
          </div>
          {cfg.is_public && (
            <div style={{background:TINT.warnBg,border:`1px solid ${C.orange}`,borderRadius:8,
                         padding:'10px 14px',fontSize:12.5,color:TINT.warnText,lineHeight:1.7}}>
              Antes de abrirla: sacá <code>/clientes</code> del <code>Disallow</code> de
              <code> robots.txt</code> y agregala al <code>sitemap.xml</code>, o Google no
              la va a indexar nunca.
            </div>
          )}
          <FormField label="Mensaje mientras está cerrada" hint="Es lo que ve alguien que entra sin estar habilitado.">
            <STa value={cfg.closed_message||''} rows={2}
                 onChange={v=>setCfg(c=>({...c,closed_message:v}))}/>
          </FormField>
          <Btn size="sm" onClick={()=>patch({closed_message:cfg.closed_message})}>Guardar mensaje</Btn>
        </div>
      </SectionCard>

      <SectionCard title="Correos habilitados">
        {/* Si la app está abierta, esta lista no filtra NADA. Sin este aviso la
            pantalla miente por omisión: se ve una lista de dos correos y se lee
            como "sólo entran estos dos". */}
        {cfg.is_public && (
          <div style={{background:TINT.warnBg,borderBottom:`1px solid ${C.orange}`,
                       padding:'12px 18px',fontSize:12.5,color:TINT.warnText,lineHeight:1.7}}>
            <b>Esta lista no está filtrando nada.</b> Con el interruptor de arriba
            abierto, cualquier cuenta puede crear perfil de comensal, esté o no acá.
            Cerrá la beta para que vuelva a tener efecto.
          </div>
        )}
        <div style={{padding:'12px 18px',fontSize:12,color:C.mid,lineHeight:1.7,
                     borderBottom:`1px solid ${C.border}`}}>
          El portero está en la base, no en la pantalla: aunque alguien llegue a
          <code> /clientes</code>, la base rechaza crearle perfil si su correo no está acá.
          Esconder el botón nunca es la única defensa.
        </div>
        <div style={{padding:18,display:'flex',gap:10,alignItems:'flex-end',flexWrap:'wrap',
                     borderBottom:`1px solid ${C.border}`}}>
          <div style={{flex:'1 1 240px'}}>
            <FormField label="Correo"><SInp value={mail} onChange={setMail} placeholder="alguien@correo.com"/></FormField>
          </div>
          <div style={{flex:'1 1 200px'}}>
            <FormField label="Nota"><SInp value={note} onChange={setNote} placeholder="Prueba de campo"/></FormField>
          </div>
          <div style={{marginBottom:14}}><Btn onClick={addMail} disabled={busy}>Habilitar</Btn></div>
        </div>
        {!list ? null : list.length===0 ? <MkEmpty text="La lista está vacía."/> : (
          <table style={{width:'100%',borderCollapse:'collapse'}}>
            <thead><tr><Th>Correo</Th><Th>Nota</Th><Th>Alta</Th><Th style={{width:70}}/></tr></thead>
            <tbody>
              {list.map(r=>(
                <tr key={r.id}>
                  <Td style={{fontWeight:600,color:C.ink}}>{r.email}</Td>
                  <Td style={{color:C.mid,fontSize:12}}>{r.note||'—'}</Td>
                  <Td style={{color:C.dim,fontSize:12}}>{new Date(r.created_at).toLocaleDateString('es-PY')}</Td>
                  <Td style={{textAlign:'right'}}>
                    <Btn size="sm" variant="danger" onClick={()=>delMail(r)}>×</Btn>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      <SectionCard title="Módulos">
        <div style={{padding:18}}>
          {MODS.map(([k,label,hint])=>(
            <div key={k} style={{display:'flex',alignItems:'center',gap:14,padding:'9px 0',
                 borderBottom:`1px solid ${C.border}`}}>
              <Toggle checked={!!cfg[k]} onChange={v=>patch({[k]:v})}/>
              <div style={{flex:1}}>
                <div style={{fontSize:13.5,fontWeight:600,color:C.ink}}>{label}</div>
                {hint && <div style={{fontSize:11.5,color:C.dim,marginTop:1}}>{hint}</div>}
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Reseñas — reglas">
        <div style={{padding:18}}>
          <div style={{display:'flex',alignItems:'center',gap:14,padding:'9px 0',borderBottom:`1px solid ${C.border}`}}>
            <Toggle checked={!!cfg.review_auto_approve} onChange={v=>patch({review_auto_approve:v})}/>
            <div style={{flex:1}}>
              <div style={{fontSize:13.5,fontWeight:600,color:C.ink}}>Publicar reseñas sin revisar</div>
              <div style={{fontSize:11.5,color:C.dim,marginTop:1}}>
                Apagado, cada reseña espera en la bandeja de moderación.
              </div>
            </div>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:14,padding:'9px 0',borderBottom:`1px solid ${C.border}`,marginBottom:14}}>
            <Toggle checked={!!cfg.weighted_rating_enabled} onChange={v=>patch({weighted_rating_enabled:v})}/>
            <div style={{flex:1}}>
              <div style={{fontSize:13.5,fontWeight:600,color:C.ink}}>Nota ponderada por reputación</div>
              <div style={{fontSize:11.5,color:C.dim,marginTop:1}}>
                La reseña de alguien con 300 pedidos y 250 votos útiles pesa más que la de
                una cuenta de ayer. Apagado, todas pesan igual.
              </div>
            </div>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12}}>
            <FormField label="Mínimo de caracteres" hint="0 = el comentario es opcional.">
              <SInp type="number" value={cfg.review_min_chars??0}
                    onChange={v=>setCfg(c=>({...c,review_min_chars:v}))}/>
            </FormField>
            <FormField label="Fotos por reseña">
              <SInp type="number" value={cfg.review_max_photos??4}
                    onChange={v=>setCfg(c=>({...c,review_max_photos:v}))}/>
            </FormField>
            <FormField label="Credibilidad mínima (%)" hint="Piso: nadie arranca en 0.">
              <SInp type="number" value={cfg.cred_min_percent??5}
                    onChange={v=>setCfg(c=>({...c,cred_min_percent:v}))}/>
            </FormField>
          </div>
          <Btn size="sm" onClick={()=>patch({
            review_min_chars:Number(cfg.review_min_chars)||0,
            review_max_photos:Number(cfg.review_max_photos)||4,
            cred_min_percent:Number(cfg.cred_min_percent)||0})}>Guardar</Btn>
        </div>
      </SectionCard>

      <SectionCard title="Índice de credibilidad — pesos">
        <div style={{padding:'12px 18px',fontSize:12,color:C.mid,lineHeight:1.7,
                     borderBottom:`1px solid ${C.border}`}}>
          Cada componente aporta como máximo su peso y satura en su "tope": 300 pedidos no
          valen cinco veces más que 60, porque si no la reputación se compra con volumen.
          Los pesos suman 100 si querés leer el resultado como un porcentaje directo.
        </div>
        <div style={{padding:18,display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 18px'}}>
          {[['orders','Pedidos verificados'],['diversity','Restaurantes distintos'],
            ['helpful','Votos útiles recibidos'],['photos','Fotos aprobadas'],
            ['age','Antigüedad de la cuenta'],['consistency','Meses con actividad']].map(([k,l])=>(
            <React.Fragment key={k}>
              <FormField label={l+' — peso'}>
                <SInp type="number" value={cfg['cred_w_'+k]??0}
                      onChange={v=>setCfg(c=>({...c,['cred_w_'+k]:v}))}/>
              </FormField>
              <FormField label={l+' — tope'}>
                <SInp type="number"
                      value={cfg[k==='age'?'cred_full_age_days':k==='consistency'?'cred_full_months':'cred_full_'+k]??0}
                      onChange={v=>setCfg(c=>({...c,
                        [k==='age'?'cred_full_age_days':k==='consistency'?'cred_full_months':'cred_full_'+k]:v}))}/>
              </FormField>
            </React.Fragment>
          ))}
          <div>
            <Btn size="sm" onClick={()=>patch(Object.fromEntries(
              ['cred_w_orders','cred_w_diversity','cred_w_helpful','cred_w_photos','cred_w_age',
               'cred_w_consistency','cred_full_orders','cred_full_diversity','cred_full_helpful',
               'cred_full_photos','cred_full_age_days','cred_full_months']
              .map(k=>[k, Number(cfg[k])||0])))}>Guardar pesos</Btn>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

function Sidebar({page, setPage, badges={}, themeMode, onToggleTheme}) {
  const signOut = async () => {
    if (db) { try { await db.auth.signOut(); } catch(e){} }
    localStorage.removeItem('mesa_session');
    window.location.replace('login.html');
  };
  return (
    <div style={{width:220,background:C.sidebar,borderRight:`1px solid ${C.border}`,display:'flex',flexDirection:'column',height:'100%',flexShrink:0,overflowY:'auto'}}>
      <div style={{padding:'20px 18px 16px',borderBottom:`1px solid ${C.border}`,flexShrink:0,display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:8}}>
        <div>
          <div style={{fontWeight:800,fontSize:18,color:C.ink,letterSpacing:'-1px'}}>Mythos</div>
          <div style={{fontSize:11,fontWeight:600,color:C.mid,marginTop:2,letterSpacing:.3}}>Superadmin</div>
        </div>
        <button onClick={onToggleTheme} title={themeMode==='dark'?'Cambiar a claro':'Cambiar a oscuro'}
          style={{width:30,height:30,borderRadius:'50%',background:'transparent',border:`1px solid ${C.border}`,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',color:C.ink,flexShrink:0}}>
          <Icon name={themeMode==='dark'?'sun':'moon'} size={14}/>
        </button>
      </div>
      <nav style={{padding:'10px',flex:1}}>
        {NAV.map((n,i)=>{
          if (!n) return <div key={`d${i}`} style={{height:1,background:C.border,margin:'8px 4px'}}/>;
          const active = page===n.id;
          const badge = badges[n.id]||0;
          return (
            <div key={n.id}>
              {n.group && <div style={{padding:'6px 12px 4px',fontSize:9,color:C.mid,fontWeight:800,letterSpacing:'0.14em',textTransform:'uppercase'}}>{n.group}</div>}
              <button onClick={()=>setPage(n.id)} style={{display:'flex',alignItems:'center',gap:10,padding:'9px 12px',borderRadius:8,width:'100%',border:'none',background:active?C.ink:'transparent',color:active?C.sidebar:C.ink,fontWeight:active?600:500,fontSize:13,cursor:'pointer',transition:'background .15s,color .15s',marginBottom:2,textAlign:'left'}}>
                <span style={{width:16,flexShrink:0,display:'inline-flex',alignItems:'center',justifyContent:'center'}}><Icon name={n.icon} size={15}/></span>
                <span style={{flex:1}}>{n.label}</span>
                {badge > 0 && <span style={{background:active?C.sidebar:C.red,color:active?C.red:C.sidebar,fontSize:10,fontWeight:800,padding:'1px 6px',borderRadius:8,minWidth:16,textAlign:'center'}}>{badge}</span>}
              </button>
            </div>
          );
        })}
      </nav>
      {/* Pie: identidad + salida. "Cerrar sesión" deja de ser un botón negro
          sólido (el negro está reservado a la acción principal, y salir no lo
          es) → ghost con borde, igual que admin/gerente. */}
      <div style={{padding:'12px 14px',borderTop:`1px solid ${C.border}`,flexShrink:0}}>
        {window._userProfile && (
          <div style={{fontSize:12,fontWeight:700,color:C.ink,marginBottom:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
            {window._userProfile.display_name||window._userProfile.username}
          </div>
        )}
        <div style={{fontSize:11,color:C.mid,marginBottom:10}}>Superadmin</div>
        <button onClick={signOut} style={{display:'flex',alignItems:'center',justifyContent:'center',gap:7,width:'100%',background:'transparent',border:`1px solid ${C.border}`,borderRadius:6,color:C.mid,fontSize:12,padding:'7px 10px',cursor:'pointer',fontFamily:'inherit',fontWeight:600}}>
          <Icon name="logout" size={13}/> Cerrar sesión
        </button>
      </div>
    </div>
  );
}

// ── App principal ────────────────────────────────────────────
// ── Modal reutilizable: cambio voluntario de contraseña (verifica la actual) ──
// Verifica la clave actual re-autenticando (signInWithPassword) y recién ahí
// cambia con updateUser. NO usa el endpoint de recuperación (ese es sin clave
// previa, para el enlace por correo / primer ingreso forzado).
function ChangePasswordModal({email, onClose, setFlash}) {
  const [cur,setCur] = useState('');
  const [n1,setN1]   = useState('');
  const [n2,setN2]   = useState('');
  const [busy,setBusy] = useState(false);
  const [err,setErr]   = useState('');
  const cap = useTurnstile(true);   // CAPTCHA para re-autenticar (signInWithPassword)
  const submit = async () => {
    setErr('');
    if (!cur) { setErr('Ingresá tu contraseña actual.'); return; }
    if (n1.length < 8) { setErr('La nueva contraseña debe tener al menos 8 caracteres.'); return; }
    if (n1 !== n2) { setErr('Las contraseñas nuevas no coinciden.'); return; }
    if (email && n1.toLowerCase() === email.toLowerCase()) { setErr('La contraseña no puede ser igual a tu correo.'); return; }
    if (!db || !email) { setErr('No hay sesión activa.'); return; }
    setBusy(true);
    try {
      // Re-autentica con la clave actual; manda el captchaToken (Supabase lo exige
      // si el Turnstile está activo, lo ignora si no). updateUser (abajo) usa la
      // sesión → NO necesita captcha.
      const { error: e1 } = await db.auth.signInWithPassword({ email, password: cur, options: { captchaToken: cap.token } });
      if (e1) {
        cap.reset();   // token de un solo uso: renovar para el reintento
        setErr(/captcha/i.test(e1.message||'') ? 'No pudimos validar la verificación de seguridad. Resolvé el captcha de abajo y probá de nuevo.' : 'La contraseña actual es incorrecta.');
        setBusy(false); return;
      }
      const { error: e2 } = await db.auth.updateUser({ password: n1 });
      if (e2) { cap.reset(); setErr('No se pudo cambiar: ' + (e2.message || 'probá con otra')); setBusy(false); return; }
      setFlash({type:'ok',text:'Contraseña actualizada'});
      onClose();
    } catch(e) { setErr('Error: ' + (e.message || 'intentá de nuevo')); }
    setBusy(false);
  };
  return (
    <Modal title="Cambiar contraseña" onClose={onClose} width={420}>
      {err && <div style={{background:TINT.dangerBg,color:TINT.dangerText,border:`1px solid ${C.red}`,borderRadius:8,padding:'9px 12px',fontSize:12.5,marginBottom:14}}>{err}</div>}
      <FormField label="Contraseña actual"><input type="password" value={cur} onChange={e=>setCur(e.target.value)} autoFocus autoComplete="current-password"/></FormField>
      <FormField label="Nueva contraseña" hint="Mínimo 8 caracteres."><input type="password" value={n1} onChange={e=>setN1(e.target.value)} autoComplete="new-password"/></FormField>
      <FormField label="Repetir nueva contraseña"><input type="password" value={n2} onChange={e=>setN2(e.target.value)} autoComplete="new-password"/></FormField>
      <div ref={cap.ref} style={{margin:'4px 0 8px',minHeight:65}}></div>
      <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:8}}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn onClick={submit} disabled={busy}>{busy?'Guardando…':'Cambiar contraseña'}</Btn>
      </div>
    </Modal>
  );
}

// ── Mi cuenta (superadmin) — perfil real desde Supabase, editable ────────────
function PageMiCuenta({setFlash}) {
  const prof = window._userProfile || {};
  const [email,setEmail] = useState('');
  const [name,setName]   = useState(prof.display_name || prof.username || '');
  const [phone,setPhone] = useState('');
  const [saving,setSaving] = useState(false);
  const [pwModal,setPwModal] = useState(false);

  useEffect(()=>{
    if (!db) return;
    let alive = true;
    (async ()=>{
      try { const { data:{ user } } = await db.auth.getUser(); if (alive && user) setEmail(user.email || ''); } catch(_){}
      try {
        if (prof.id) {
          const { data } = await db.from('user_roles').select('*').eq('user_id',prof.id).eq('is_active',true).limit(1).maybeSingle();
          if (alive && data) { setName(data.display_name || data.username || ''); setPhone(data.phone || ''); }
        }
      } catch(_){}
    })();
    return ()=>{ alive = false; };
  },[]);

  const saveProfile = async () => {
    if (!name.trim()) { setFlash({type:'error',text:'El nombre no puede quedar vacío.'}); return; }
    if (!db) return;
    setSaving(true);
    try {
      const { error } = await db.rpc('update_my_profile',{ p_display_name:name.trim(), p_phone:phone.trim() });
      if (error) throw error;
      try { window._userProfile = {...prof, display_name:name.trim()}; } catch(_){}
      try { localStorage.setItem('mythos_display_name', name.trim()); } catch(_){}
      setFlash({type:'ok',text:'Perfil actualizado'});
    } catch(e) {
      const m = e.message || '';
      setFlash({type:'error',text: /update_my_profile|schema cache|does not exist|function/i.test(m) ? 'Falta aplicar la migración 145 para editar el perfil.' : 'Error: '+m});
    }
    setSaving(false);
  };

  return (
    <div style={{maxWidth:680}}>
      <SectionCard title="Mi perfil" style={{marginBottom:18}}>
        <div style={{padding:'18px 20px'}}>
          <div className="my-row-2" style={{gap:'0 16px'}}>
            <FormField label="Nombre"><input value={name} onChange={e=>setName(e.target.value)} placeholder="Tu nombre"/></FormField>
            <FormField label="Teléfono"><input value={phone} onChange={e=>setPhone(e.target.value)} placeholder="+595 9xx xxx xxx"/></FormField>
            <FormField label="Email" hint="Tu correo de acceso (no editable desde acá)."><input value={email} disabled style={{opacity:.65,cursor:'not-allowed'}}/></FormField>
            <FormField label="Rol"><input value="Superadmin" disabled style={{opacity:.65,cursor:'not-allowed'}}/></FormField>
          </div>
          <div style={{display:'flex',justifyContent:'flex-end',marginTop:2}}>
            <Btn onClick={saveProfile} disabled={saving}>{saving?'Guardando…':'Guardar cambios'}</Btn>
          </div>
        </div>
      </SectionCard>
      <SectionCard title="Seguridad">
        <div style={{padding:'18px 20px',display:'flex',justifyContent:'space-between',alignItems:'center',gap:14,flexWrap:'wrap'}}>
          <div style={{fontSize:13,color:C.mid}}>Cambiá tu contraseña. Te vamos a pedir la actual por seguridad.</div>
          <Btn variant="ghost" onClick={()=>setPwModal(true)}>Cambiar contraseña</Btn>
        </div>
      </SectionCard>
      {pwModal && <ChangePasswordModal email={email} onClose={()=>setPwModal(false)} setFlash={setFlash}/>}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   FINANZAS DEL SUPERADMIN — la caja del dueño de la plataforma.
   SOLO superadmin. Todo pasa por RPCs fail-closed (mig 147). Los importes se
   muestran en ₲ (los costos en USD muestran también su conversión con el tipo
   de cambio). MRR = suscripciones activas (ya en ₲, mig 119); el FX solo
   normaliza costos/movimientos cargados en USD.
══════════════════════════════════════════════════════════════ */
const fmtGs  = n => `₲ ${Math.round(Number(n||0)).toLocaleString('es-PY')}`;
const fmtUsd = n => `US$ ${Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const CYCLE_LABEL = {monthly:'Mensual', annual:'Anual', one_time:'Pago único'};
const financeMigMsg = m => /function|does not exist|schema cache|relation|permission denied/i.test(m||'')
  ? 'Falta aplicar la migración 147 (o no tenés permiso de superadmin).'
  : ('Error: ' + (m||''));

// Semáforo de vencimiento: rojo <7 días, amarillo <15, verde ≥15, gris sin fecha.
const dueSemaphore = days => {
  if (days === null || days === undefined) return {color:C.mid,    bg:'var(--bg-subtle)'};
  if (days < 7)   return {color:C.red,    bg:TINT.dangerBg};
  if (days < 15)  return {color:C.orange, bg:TINT.warnBg};
  return               {color:C.green,  bg:TINT.okBg};
};
const dueLabel = days => (days===null||days===undefined) ? 'Sin fecha'
  : days<0 ? `Vencido hace ${-days}d` : days===0 ? 'Vence hoy' : `Vence en ${days}d`;

const _finInp = {width:'100%',fontSize:13,padding:'10px 12px',border:`1px solid ${C.border}`,borderRadius:9,background:C.surface,color:C.ink,boxSizing:'border-box'};

function CostModal({row, onClose, onSaved, setFlash}) {
  const edit = !!(row && row.id);
  const [f, setF] = useState({
    name: row?.name||'', provider: row?.provider||'', category: row?.category||'',
    amount: row?.amount!=null ? String(row.amount) : '', currency: row?.currency||'USD',
    cycle: row?.cycle||'monthly', next_due_date: row?.next_due_date||'',
    auto_renew: row?.auto_renew!==false, active: row?.active!==false, notes: row?.notes||'',
  });
  const [busy, setBusy] = useState(false);
  const set = (k,v)=>setF(s=>({...s,[k]:v}));
  const save = async () => {
    if (!f.name.trim()) { setFlash({type:'error',text:'El nombre es obligatorio'}); return; }
    setBusy(true);
    const { error } = await db.rpc('platform_cost_upsert', {
      p_id: edit ? row.id : null, p_name: f.name.trim(), p_provider: f.provider.trim()||null,
      p_category: f.category.trim()||null, p_amount: Number(f.amount)||0, p_currency: f.currency,
      p_cycle: f.cycle, p_next_due_date: f.next_due_date||null, p_auto_renew: f.auto_renew,
      p_active: f.active, p_notes: f.notes.trim()||null,
    });
    setBusy(false);
    if (error) { setFlash({type:'error',text:financeMigMsg(error.message)}); return; }
    setFlash({type:'success',text:edit?'Costo actualizado':'Costo agregado'});
    onSaved();
  };
  return (
    <Modal title={edit?'Editar costo del sistema':'Agregar costo del sistema'} onClose={onClose} width={560}>
      <div className="my-row-2" style={{gap:14}}>
        <FormField label="Servicio / concepto" col="1 / -1">
          <input style={_finInp} value={f.name} onChange={e=>set('name',e.target.value)} placeholder="Ej. Supabase Pro"/>
        </FormField>
        <FormField label="Proveedor">
          <input style={_finInp} value={f.provider} onChange={e=>set('provider',e.target.value)} placeholder="Ej. Supabase"/>
        </FormField>
        <FormField label="Categoría">
          <input style={_finInp} value={f.category} onChange={e=>set('category',e.target.value)} placeholder="Ej. backend"/>
        </FormField>
        <FormField label="Monto">
          {f.currency==='PYG'
            ? <GsInput style={_finInp} value={f.amount} onChange={v=>set('amount',v)} placeholder="0"/>
            : <input style={_finInp} type="number" min="0" step="0.01" value={f.amount} onChange={e=>set('amount',e.target.value)} placeholder="0"/>}
        </FormField>
        <FormField label="Moneda">
          <select style={_finInp} value={f.currency} onChange={e=>{const c=e.target.value; set('currency',c); if(CURRENCIES[c]&&CURRENCIES[c].decimals===0&&f.amount!=='') set('amount', String(Math.trunc(Number(f.amount))||0));}}>
            <option value="USD">USD (US$)</option>
            <option value="PYG">Guaraníes (₲)</option>
          </select>
        </FormField>
        <FormField label="Ciclo">
          <select style={_finInp} value={f.cycle} onChange={e=>set('cycle',e.target.value)}>
            <option value="monthly">Mensual</option>
            <option value="annual">Anual</option>
            <option value="one_time">Pago único</option>
          </select>
        </FormField>
        <FormField label="Próximo vencimiento" hint="Dejá vacío si aún no aplica.">
          <input style={_finInp} type="date" value={f.next_due_date||''} onChange={e=>set('next_due_date',e.target.value)}/>
        </FormField>
        <FormField label="Notas" col="1 / -1">
          <input style={_finInp} value={f.notes} onChange={e=>set('notes',e.target.value)} placeholder="Opcional"/>
        </FormField>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <Toggle checked={f.auto_renew} onChange={v=>set('auto_renew',v)}/>
          <span style={{fontSize:13,color:C.ink}}>Renovación automática</span>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <Toggle checked={f.active} onChange={v=>set('active',v)}/>
          <span style={{fontSize:13,color:C.ink}}>Activo (cuenta en los totales)</span>
        </div>
      </div>
      <div style={{display:'flex',justifyContent:'flex-end',gap:10,marginTop:18}}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn onClick={save} disabled={busy}>{busy?'Guardando…':(edit?'Guardar cambios':'Agregar')}</Btn>
      </div>
    </Modal>
  );
}

function EntryModal({type, onClose, onSaved, setFlash}) {
  const isIncome = type==='income';
  const [f, setF] = useState({
    concept:'', amount:'', currency:'PYG',
    entry_date: todayPY(), category:'', notes:'',
  });
  const [busy, setBusy] = useState(false);
  const set = (k,v)=>setF(s=>({...s,[k]:v}));
  const save = async () => {
    if (!f.concept.trim()) { setFlash({type:'error',text:'El concepto es obligatorio'}); return; }
    setBusy(true);
    const { error } = await db.rpc('platform_finance_entry_create', {
      p_type: type, p_concept: f.concept.trim(), p_amount: Number(f.amount)||0,
      p_currency: f.currency, p_entry_date: f.entry_date||null,
      p_category: f.category.trim()||null, p_notes: f.notes.trim()||null,
    });
    setBusy(false);
    if (error) { setFlash({type:'error',text:financeMigMsg(error.message)}); return; }
    setFlash({type:'success',text:isIncome?'Ingreso registrado':'Egreso registrado'});
    onSaved();
  };
  return (
    <Modal title={isIncome?'Registrar ingreso':'Registrar egreso'} onClose={onClose} width={520}>
      <div className="my-row-2" style={{gap:14}}>
        <FormField label="Concepto" col="1 / -1">
          <input style={_finInp} value={f.concept} onChange={e=>set('concept',e.target.value)} placeholder={isIncome?'Ej. Cobro anual adelantado':'Ej. Publicidad'}/>
        </FormField>
        <FormField label="Monto">
          {f.currency==='PYG'
            ? <GsInput style={_finInp} value={f.amount} onChange={v=>set('amount',v)} placeholder="0"/>
            : <input style={_finInp} type="number" min="0" step="0.01" value={f.amount} onChange={e=>set('amount',e.target.value)} placeholder="0"/>}
        </FormField>
        <FormField label="Moneda">
          <select style={_finInp} value={f.currency} onChange={e=>{const c=e.target.value; set('currency',c); if(CURRENCIES[c]&&CURRENCIES[c].decimals===0&&f.amount!=='') set('amount', String(Math.trunc(Number(f.amount))||0));}}>
            <option value="PYG">Guaraníes (₲)</option>
            <option value="USD">USD (US$)</option>
          </select>
        </FormField>
        <FormField label="Fecha">
          <input style={_finInp} type="date" value={f.entry_date} onChange={e=>set('entry_date',e.target.value)}/>
        </FormField>
        <FormField label="Categoría">
          <input style={_finInp} value={f.category} onChange={e=>set('category',e.target.value)} placeholder="Opcional"/>
        </FormField>
        <FormField label="Notas" col="1 / -1">
          <input style={_finInp} value={f.notes} onChange={e=>set('notes',e.target.value)} placeholder="Opcional"/>
        </FormField>
      </div>
      <div style={{display:'flex',justifyContent:'flex-end',gap:10,marginTop:18}}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant={isIncome?'success':'danger'} onClick={save} disabled={busy}>{busy?'Guardando…':'Registrar'}</Btn>
      </div>
    </Modal>
  );
}

function PageFinanzas({enriched, setFlash}) {
  const [summary, setSummary] = useState(null);
  const [costs,   setCosts]   = useState([]);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err,     setErr]     = useState(null);
  const [month,   setMonth]   = useState(new Date().toISOString().slice(0,7));
  const [costModal,  setCostModal]  = useState(null);   // null | {} | row
  const [entryModal, setEntryModal] = useState(null);   // null | 'income' | 'expense'
  const [rateEdit, setRateEdit] = useState(false);
  const [rateVal,  setRateVal]  = useState('');

  const load = useCallback(async (silent) => {
    if (!db) { setErr('Sin conexión a Supabase.'); setLoading(false); return; }
    if (!silent) setLoading(true);
    const [s, c, e] = await Promise.all([
      db.rpc('platform_finance_summary'),
      db.rpc('platform_costs_list'),
      db.rpc('platform_finance_entries_list', { p_month: month || null }),
    ]);
    if (s.error) { setErr(financeMigMsg(s.error.message)); setLoading(false); return; }
    setErr(null);
    setSummary(s.data || null);
    setCosts(Array.isArray(c.data) ? c.data : []);
    setEntries(Array.isArray(e.data) ? e.data : []);
    setLoading(false);
  }, [month]);

  // Silencioso siempre: el spinner inicial lo cubre el estado loading=true de
  // arranque; los cambios de mes refrescan sin parpadear la página entera.
  useEffect(()=>{ load(true); }, [load]);

  // "Hoy" a medianoche LOCAL (no UTC) para que los días restantes de la tabla
  // coincidan con days_remaining del servidor (hora de Paraguay).
  const _today0 = (()=>{ const d=new Date(); return new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime(); })();

  const rate = Number(summary?.usd_pyg_rate) || 7500;
  const toPyg = (amount, ccy) => (ccy==='USD' ? Number(amount||0)*rate : Number(amount||0));
  const amountCell = (amount, ccy) => ccy==='USD'
    ? <span>{fmtUsd(amount)} <span style={{color:C.dim,fontSize:11}}>· {fmtGs(toPyg(amount,'USD'))}</span></span>
    : <span>{fmtGs(amount)}</span>;

  const markPaid = async (c) => {
    if (!window.confirm(`Registrar el pago de "${c.name}" y avanzar su vencimiento un ciclo?`)) return;
    const { error } = await db.rpc('platform_cost_mark_paid', { p_id: c.id });
    if (error) { setFlash({type:'error',text:financeMigMsg(error.message)}); return; }
    setFlash({type:'success',text:'Pago registrado y vencimiento actualizado'});
    load(true);
  };
  const delCost = async (c) => {
    if (!window.confirm(`Eliminar el costo "${c.name}"? No borra los egresos ya registrados.`)) return;
    const { error } = await db.rpc('platform_cost_delete', { p_id: c.id });
    if (error) { setFlash({type:'error',text:financeMigMsg(error.message)}); return; }
    load(true);
  };
  const delEntry = async (en) => {
    if (!window.confirm('Eliminar este movimiento?')) return;
    const { error } = await db.rpc('platform_finance_entry_delete', { p_id: en.id });
    if (error) { setFlash({type:'error',text:financeMigMsg(error.message)}); return; }
    load(true);
  };
  const saveRate = async () => {
    const v = Number(rateVal);
    if (!v || v<=0) { setFlash({type:'error',text:'Tipo de cambio inválido'}); return; }
    const { error } = await db.rpc('superadmin_set_usd_rate', { p_rate: v });
    if (error) { setFlash({type:'error',text:financeMigMsg(error.message)}); return; }
    setRateEdit(false);
    setFlash({type:'success',text:'Tipo de cambio actualizado'});
    load(true);
  };

  // Ingresos recurrentes por suscripción (informativo — base de la MRR).
  const recurring = (enriched||[])
    .filter(r => r.subscription && Number(r.subscription.monthly_amount||r.plan?.price_usd||0) > 0
                 && (r.subscription.status==='active' || r.status==='active'))
    .map(r => ({ name:r.name, plan:r.plan?.name||'—', amount:Number(r.subscription.monthly_amount||r.plan?.price_usd||0) }))
    .sort((a,b)=>b.amount-a.amount);

  const up0 = summary?.upcoming?.[0] || null;

  if (loading) return <div style={{padding:40,textAlign:'center',color:C.mid}}>Cargando finanzas…</div>;
  if (err) return (
    <div>
      <h1 style={{fontSize:24,fontWeight:800,letterSpacing:'-0.5px',margin:'0 0 4px',color:C.ink}}>Finanzas</h1>
      <div style={{marginTop:16,border:`1px solid ${C.orange}`,background:TINT.warnBg,borderRadius:12,padding:'16px 18px',color:C.orange,fontSize:13.5,fontWeight:600,maxWidth:620,lineHeight:1.55}}>
        {err}
        <div style={{fontSize:12,fontWeight:400,color:C.mid,marginTop:8}}>Aplicá la migración <strong>147</strong> en el SQL Editor (tras backup) y volvé a entrar a esta sección.</div>
      </div>
    </div>
  );

  const margin = Number(summary?.margin_pyg||0);
  return (
    <div className="animate-in">
      <h1 style={{fontSize:24,fontWeight:800,letterSpacing:'-0.5px',margin:'0 0 4px',color:C.ink}}>Finanzas</h1>
      <p style={{fontSize:13,color:C.mid,margin:'0 0 18px',maxWidth:680,lineHeight:1.55}}>
        Tu caja como dueño de la plataforma: ingresos por suscripción, egresos, costos del sistema y avisos de vencimiento. Importes en <strong>₲</strong>; los costos en USD se convierten con el tipo de cambio configurable.
      </p>

      {/* KPIs */}
      <div style={{display:'flex',gap:12,marginBottom:22,flexWrap:'wrap'}}>
        <div className="my-metric-card" style={{flex:'1 1 180px',minWidth:160}}>
          <div className="my-metric-card__label">MRR estimada</div>
          <div style={{fontSize:26,fontWeight:800,color:'var(--text-primary)',lineHeight:1.1,letterSpacing:'-0.5px'}}>{fmtGs(summary?.mrr_pyg)}</div>
          <div style={{fontSize:11,color:C.mid,marginTop:6}}>suscripciones activas · ₲/mes</div>
        </div>
        <div className="my-metric-card" style={{flex:'1 1 180px',minWidth:160}}>
          <div className="my-metric-card__label">Costos mensuales</div>
          <div style={{fontSize:26,fontWeight:800,color:'var(--text-primary)',lineHeight:1.1,letterSpacing:'-0.5px'}}>{fmtGs(summary?.monthly_costs_pyg)}</div>
          <div style={{fontSize:11,color:C.mid,marginTop:6}}>anuales /12 · USD→₲</div>
        </div>
        <div className="my-metric-card" style={{flex:'1 1 180px',minWidth:160}}>
          <div className="my-metric-card__label">Margen mensual</div>
          <div style={{fontSize:26,fontWeight:800,color:margin>=0?C.green:C.red,lineHeight:1.1,letterSpacing:'-0.5px'}}>{fmtGs(margin)}</div>
          <div style={{fontSize:11,color:C.mid,marginTop:6}}>MRR − costos</div>
        </div>
        <div className="my-metric-card" style={{flex:'1 1 180px',minWidth:160}}>
          <div className="my-metric-card__label">Próximo vencimiento</div>
          {up0 ? (
            <>
              <div style={{fontSize:18,fontWeight:800,color:'var(--text-primary)',lineHeight:1.15,letterSpacing:'-0.3px'}}>{up0.name}</div>
              <div style={{fontSize:12,fontWeight:700,color:dueSemaphore(up0.days_remaining).color,marginTop:6}}>{dueLabel(up0.days_remaining)}</div>
            </>
          ) : <div style={{fontSize:15,color:C.mid,marginTop:8}}>Sin vencimientos cargados</div>}
        </div>
      </div>

      {/* Costos del sistema */}
      <SectionCard title="Costos del sistema" action={<Btn size="sm" onClick={()=>setCostModal({})}>+ Agregar costo</Btn>}>
        {costs.length===0 ? (
          <div style={{padding:'18px 4px',color:C.mid,fontSize:13}}>No hay costos cargados.</div>
        ) : (
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
              <thead>
                <tr style={{textAlign:'left',color:C.mid,fontSize:11,textTransform:'uppercase',letterSpacing:.4}}>
                  <th style={{padding:'8px 10px'}}>Servicio</th>
                  <th style={{padding:'8px 10px'}}>Monto</th>
                  <th style={{padding:'8px 10px'}}>Ciclo</th>
                  <th style={{padding:'8px 10px'}}>Vence</th>
                  <th style={{padding:'8px 10px'}}></th>
                </tr>
              </thead>
              <tbody>
                {costs.map(c=>{
                  const days = c.next_due_date ? Math.round((new Date(c.next_due_date+'T00:00:00').getTime() - _today0)/86400000) : null;
                  const sem = dueSemaphore(days);
                  return (
                    <tr key={c.id} style={{borderTop:`1px solid ${C.border}`,opacity:c.active?1:.5}}>
                      <td style={{padding:'10px'}}>
                        <div style={{fontWeight:700,color:C.ink}}>{c.name}{!c.active && <span style={{fontSize:11,color:C.mid,fontWeight:400}}> · inactivo</span>}</div>
                        <div style={{fontSize:11,color:C.mid}}>{[c.provider,c.category].filter(Boolean).join(' · ')||'—'}</div>
                      </td>
                      <td style={{padding:'10px',whiteSpace:'nowrap'}}>{amountCell(c.amount,c.currency)}</td>
                      <td style={{padding:'10px',color:C.mid}}>{CYCLE_LABEL[c.cycle]||c.cycle}</td>
                      <td style={{padding:'10px',whiteSpace:'nowrap'}}>
                        <span style={{display:'inline-block',padding:'2px 9px',borderRadius:20,fontSize:11,fontWeight:700,background:sem.bg,color:sem.color}}>
                          {c.next_due_date ? dueLabel(days) : 'Sin fecha'}
                        </span>
                        {c.next_due_date && <div style={{fontSize:10.5,color:C.dim,marginTop:2}}>{fmtDate(c.next_due_date)}</div>}
                      </td>
                      <td style={{padding:'10px',whiteSpace:'nowrap',textAlign:'right'}}>
                        <div style={{display:'inline-flex',gap:6}}>
                          <Btn size="sm" variant="success" onClick={()=>markPaid(c)} title="Registra el egreso y avanza el vencimiento">Pagado</Btn>
                          <Btn size="sm" variant="ghost" onClick={()=>setCostModal(c)}>Editar</Btn>
                          <Btn size="sm" variant="danger" onClick={()=>delCost(c)}>×</Btn>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* Ingresos y egresos */}
      <div style={{marginTop:18}}>
        <SectionCard title="Ingresos y egresos"
          action={
            <div style={{display:'flex',gap:8,alignItems:'center'}}>
              <input type="month" value={month} onChange={e=>setMonth(e.target.value)}
                style={{fontSize:12,padding:'7px 10px',border:`1px solid ${C.border}`,borderRadius:8,background:C.surface,color:C.ink}}/>
              <Btn size="sm" variant="success" onClick={()=>setEntryModal('income')}>+ Ingreso</Btn>
              <Btn size="sm" variant="danger"  onClick={()=>setEntryModal('expense')}>+ Egreso</Btn>
            </div>
          }>
          <div style={{display:'flex',gap:16,marginBottom:12,flexWrap:'wrap'}}>
            <div style={{fontSize:12,color:C.mid}}>Ingresos del mes: <strong style={{color:C.green}}>{fmtGs(summary?.income_month_pyg)}</strong></div>
            <div style={{fontSize:12,color:C.mid}}>Egresos del mes: <strong style={{color:C.red}}>{fmtGs(summary?.expense_month_pyg)}</strong></div>
            <div style={{fontSize:12,color:C.mid}}>Neto: <strong style={{color:(Number(summary?.income_month_pyg||0)-Number(summary?.expense_month_pyg||0))>=0?C.green:C.red}}>{fmtGs(Number(summary?.income_month_pyg||0)-Number(summary?.expense_month_pyg||0))}</strong></div>
          </div>
          {entries.length===0 ? (
            <div style={{padding:'14px 4px',color:C.mid,fontSize:13}}>Sin movimientos en el mes seleccionado.</div>
          ) : (
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
                <thead>
                  <tr style={{textAlign:'left',color:C.mid,fontSize:11,textTransform:'uppercase',letterSpacing:.4}}>
                    <th style={{padding:'8px 10px'}}>Fecha</th>
                    <th style={{padding:'8px 10px'}}>Concepto</th>
                    <th style={{padding:'8px 10px'}}>Tipo</th>
                    <th style={{padding:'8px 10px'}}>Monto</th>
                    <th style={{padding:'8px 10px'}}></th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(en=>(
                    <tr key={en.id} style={{borderTop:`1px solid ${C.border}`}}>
                      <td style={{padding:'10px',whiteSpace:'nowrap',color:C.mid}}>{fmtDate(en.entry_date)}</td>
                      <td style={{padding:'10px'}}>
                        <div style={{color:C.ink}}>{en.concept}</div>
                        {en.category && <div style={{fontSize:11,color:C.mid}}>{en.category}</div>}
                      </td>
                      <td style={{padding:'10px'}}>
                        <span style={{padding:'2px 8px',borderRadius:20,fontSize:11,fontWeight:700,background:en.type==='income'?TINT.okBg:TINT.dangerBg,color:en.type==='income'?C.green:C.red}}>
                          {en.type==='income'?'Ingreso':'Egreso'}
                        </span>
                      </td>
                      <td style={{padding:'10px',whiteSpace:'nowrap',fontWeight:700,color:en.type==='income'?C.green:C.red}}>
                        {en.type==='income'?'+':'−'} {amountCell(en.amount,en.currency)}
                      </td>
                      <td style={{padding:'10px',textAlign:'right'}}>
                        <Btn size="sm" variant="danger" onClick={()=>delEntry(en)}>×</Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>

      {/* Ingresos recurrentes por suscripción (informativo, solo lectura) */}
      <div style={{marginTop:18}}>
        <SectionCard title="Ingresos recurrentes por suscripción (base de la MRR)">
          {recurring.length===0 ? (
            <div style={{padding:'14px 4px',color:C.mid,fontSize:13}}>No hay suscripciones activas con importe.</div>
          ) : (
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
                <thead>
                  <tr style={{textAlign:'left',color:C.mid,fontSize:11,textTransform:'uppercase',letterSpacing:.4}}>
                    <th style={{padding:'8px 10px'}}>Restaurante</th>
                    <th style={{padding:'8px 10px'}}>Plan</th>
                    <th style={{padding:'8px 10px',textAlign:'right'}}>₲/mes</th>
                  </tr>
                </thead>
                <tbody>
                  {recurring.map((r,i)=>(
                    <tr key={i} style={{borderTop:`1px solid ${C.border}`}}>
                      <td style={{padding:'9px 10px',color:C.ink}}>{r.name}</td>
                      <td style={{padding:'9px 10px'}}><PlanBadge name={r.plan}/></td>
                      <td style={{padding:'9px 10px',textAlign:'right',fontWeight:700,color:C.ink}}>{fmtGs(r.amount)}</td>
                    </tr>
                  ))}
                  <tr style={{borderTop:`2px solid ${C.border}`}}>
                    <td style={{padding:'9px 10px',fontWeight:800,color:C.ink}} colSpan={2}>MRR estimada</td>
                    <td style={{padding:'9px 10px',textAlign:'right',fontWeight:800,color:C.green}}>{fmtGs(summary?.mrr_pyg)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          <div style={{fontSize:11,color:C.dim,marginTop:8}}>Solo lectura. Los planes/precios se editan en <strong>Facturación</strong>.</div>
        </SectionCard>
      </div>

      {/* Configuración: tipo de cambio */}
      <div style={{marginTop:18}}>
        <SectionCard title="Configuración">
          <div style={{display:'flex',alignItems:'center',gap:14,flexWrap:'wrap'}}>
            <div>
              <div style={{fontSize:11,color:C.mid,fontWeight:600,textTransform:'uppercase',letterSpacing:.4,marginBottom:4}}>Tipo de cambio USD → ₲</div>
              {rateEdit ? (
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <GsInput value={rateVal} onChange={setRateVal}
                    style={{width:140,fontSize:14,padding:'8px 10px',border:`1px solid ${C.border}`,borderRadius:8,background:C.surface,color:C.ink}}/>
                  <Btn size="sm" onClick={saveRate}>Guardar</Btn>
                  <Btn size="sm" variant="ghost" onClick={()=>setRateEdit(false)}>Cancelar</Btn>
                </div>
              ) : (
                <div style={{display:'flex',gap:10,alignItems:'center'}}>
                  <span style={{fontSize:22,fontWeight:800,color:C.ink}}>1 US$ = ₲ {Number(rate).toLocaleString('es-PY')}</span>
                  <Btn size="sm" variant="ghost" onClick={()=>{ setRateVal(String(rate)); setRateEdit(true); }}>Editar</Btn>
                </div>
              )}
            </div>
          </div>
          <div style={{fontSize:11,color:C.dim,marginTop:10,maxWidth:560,lineHeight:1.5}}>Afecta la conversión de todos los costos y movimientos cargados en USD (Vercel, Supabase, etc.). No cambia la MRR (las suscripciones ya están en ₲).</div>
        </SectionCard>
      </div>

      {costModal  && <CostModal  row={costModal} onClose={()=>setCostModal(null)} onSaved={()=>{ setCostModal(null); load(true); }} setFlash={setFlash}/>}
      {entryModal && <EntryModal type={entryModal} onClose={()=>setEntryModal(null)} onSaved={()=>{ setEntryModal(null); load(true); }} setFlash={setFlash}/>}
    </div>
  );
}

function App() {
  const [page,    setPage]    = useState('dashboard');
  const [loading, setLoading] = useState(true);
  const [flash,   setFlash]   = useState(null);
  const [offline, setOffline] = useState(false);
  const [rtLive,  setRtLive]  = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [unreadSupport, setUnreadSupport] = useState(0);
  const [pendingSuppliers, setPendingSuppliers] = useState(0);
  const [rawData, setRawData] = useState({restaurants:[],plans:[],subscriptions:[],events:[],orders:[],ratings:[],platformConfig:[],addons:[],addonCatalog:[]});
  const [themeMode, setThemeMode] = useState(window.MythosTheme ? window.MythosTheme.get() : 'light');
  // Sidebar colapsable (persistente): contenido a pantalla completa al ocultarlo.
  const [navOpen,setNavOpen]=useState(()=>{try{return localStorage.getItem('sa_nav_open')!=='0';}catch{return true;}});
  const toggleNav=()=>setNavOpen(v=>{const n=!v;try{localStorage.setItem('sa_nav_open',n?'1':'0');}catch{} return n;});
  useEffect(() => {
    const onTheme = e => setThemeMode(e.detail.mode);
    document.addEventListener('mythos:themechange', onTheme);
    return () => document.removeEventListener('mythos:themechange', onTheme);
  }, []);
  const handleToggleTheme = () => window.MythosTheme && window.MythosTheme.toggle();

  // Polling de tickets de soporte sin leer
  useEffect(()=>{
    if(!db) return;
    const tick = async () => {
      if(_shouldPause()) return;
      const { data } = await db.from('support_tickets')
        .select('unread_for_super,status')
        .neq('status','cerrado');
      setUnreadSupport((data||[]).reduce((s,t)=>s+(t.unread_for_super||0),0));
    };
    tick();
    const id = setInterval(tick, 20000);
    return () => clearInterval(id);
  },[]);

  // Polling de solicitudes de proveedores pendientes (badge del marketplace)
  useEffect(()=>{
    if(!db) return;
    const tick = async () => {
      if(_shouldPause()) return;
      const { count } = await db.from('marketplace_applications')
        .select('id',{count:'exact',head:true})
        .eq('estado','pendiente');
      setPendingSuppliers(count||0);
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  },[]);

  const loadAll = useCallback(async (opts) => {
    const silent = opts && opts.silent;
    if (!db) { setRawData(DEMO); setOffline(true); setLoading(false); return; }
    if (!silent) setLoading(true);
    setRefreshing(true);
    try {
      const ago30 = new Date(Date.now()-30*86400000).toISOString();
      const [rests,subs,plans,events,orders,ratings,config,addons,addonCat] = await Promise.all([
        db.from('restaurants').select('*').order('created_at',{ascending:false}),
        db.from('subscriptions').select('*, plan:subscription_plans(id,name,price_usd,billing_cycle)').then(r=>r.error?{data:[]}:r),
        db.from('subscription_plans').select('*').order('price_usd').then(r=>r.error?{data:[]}:r),
        db.from('platform_events').select('*, restaurant:restaurants(name)').order('created_at',{ascending:false}).limit(100).then(r=>r.error?{data:[]}:r),
        db.from('orders').select('id,restaurant_id,total,created_at,status').gte('created_at',ago30).then(r=>r.error?{data:[]}:r),
        db.from('ratings').select('restaurant_id,stars,created_at').then(r=>r.error?{data:[]}:r),
        db.from('platform_config').select('*').then(r=>r.error?{data:[]}:r),
        db.from('restaurant_addons').select('*').then(r=>r.error?{data:[]}:r),
        db.from('plan_addons').select('*').order('price_usd').then(r=>r.error?{data:[]}:r),
      ]);
      if (rests.error) throw rests.error;
      setRawData({restaurants:rests.data||[],subscriptions:subs.data||[],plans:plans.data||[],events:events.data||[],orders:orders.data||[],ratings:ratings.data||[],platformConfig:config.data||[],addons:addons.data||[],addonCatalog:addonCat.data||[]});
      setOffline(false);
    } catch(e) {
      console.warn('Error cargando datos:',e);
      setRawData(DEMO); setOffline(true);
      if (!silent) setFlash({type:'warn',text:'Sin conexión a Supabase — datos demo'});
    }
    if (!silent) setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(()=>{ loadAll(); },[loadAll]);

  // Realtime + polling fallback 30s
  useEffect(()=>{
    if (!db) return;
    const interval = setInterval(()=>{ if(!_shouldPause()) loadAll({silent:true}); }, 30000);
    const safeLoad = ()=>{ if(!_shouldPause()) loadAll({silent:true}); };
    const ch = db.channel('superadmin-rt')
      .on('postgres_changes',{event:'*',schema:'public',table:'orders'},          safeLoad)
      .on('postgres_changes',{event:'*',schema:'public',table:'restaurants'},     safeLoad)
      .on('postgres_changes',{event:'*',schema:'public',table:'subscriptions'},   safeLoad)
      .on('postgres_changes',{event:'*',schema:'public',table:'platform_events'}, safeLoad)
      .on('postgres_changes',{event:'*',schema:'public',table:'user_roles'},      safeLoad)
      .on('postgres_changes',{event:'*',schema:'public',table:'platform_config'}, safeLoad)
      .on('postgres_changes',{event:'*',schema:'public',table:'restaurant_addons'}, safeLoad)
      .subscribe(s=>setRtLive(s==='SUBSCRIBED'));
    return ()=>{ clearInterval(interval); db.removeChannel(ch); };
  },[loadAll]);

  const {restaurants,plans,subscriptions,events,orders,ratings,platformConfig,addons,addonCatalog} = rawData;
  const enriched = buildAnalytics(restaurants, orders, ratings, subscriptions, plans, addons);

  // reload silencioso (sin spinner full-screen) — para acciones tras mutaciones
  const reloadSilent = useCallback(()=>loadAll({silent:true}),[loadAll]);

  const bannerRow    = platformConfig.find(c=>c.key==='global_banner_active');
  const bannerMsgRow = platformConfig.find(c=>c.key==='global_banner_message');
  const bannerActive = bannerRow?.value==='true' && !!bannerMsgRow?.value;
  const bannerMsg    = bannerMsgRow?.value||'';

  // Moneda activa de la plataforma (afecta a todo fmtMoney/fmtGuarani de la app).
  // Se aplica en el cuerpo del render para que los hijos formateen ya con la moneda correcta.
  setPlatformCurrency(platformConfig.find(c=>c.key==='platform_currency')?.value);

  // 'paneles' y 'horarios' faltaban → el header mostraba el id crudo en minúscula.
  const pageTitles = {dashboard:'Dashboard',paneles:'Paneles',capacidad:'Capacidad',restaurantes:'Restaurantes',prospeccion:'Clientes contactados',facturacion:'Facturación',finanzas:'Finanzas',fiscal:'Fiscal',usuarios:'Usuarios',proveedores:'Proveedores',soporte:'Soporte',reportes:'Reportes',actividad:'Actividad',sitio_web:'Sitio web',horarios:'Horarios',configuracion:'Configuración'};

  return (
    <div style={{display:'flex',height:'100vh',overflow:'hidden'}}>
      {navOpen && <Sidebar page={page} setPage={setPage} badges={{soporte:unreadSupport, proveedores:pendingSuppliers}} themeMode={themeMode} onToggleTheme={handleToggleTheme}/>}
      <div style={{flex:1,display:'flex',flexDirection:'column',minWidth:0,overflow:'hidden'}}>
        {/* Banner global */}
        {bannerActive&&!bannerDismissed&&(
          <div style={{background:'#FF9500',color:'#FFFFFF',padding:'10px 24px',flexShrink:0,display:'flex',justifyContent:'space-between',alignItems:'center',zIndex:20}}>
            <span style={{fontSize:13,fontWeight:500}}>{bannerMsg}</span>
            <button onClick={()=>setBannerDismissed(true)} style={{background:'none',border:'none',color:'#FFFFFF',fontSize:18,cursor:'pointer',padding:'0 4px',opacity:.8}}>×</button>
          </div>
        )}
        {/* Header */}
        <div style={{background:C.sidebar,borderBottom:`1px solid ${C.border}`,padding:'12px 24px',display:'flex',justifyContent:'space-between',alignItems:'center',flexShrink:0,zIndex:10}}>
          <div style={{display:'flex',alignItems:'center',gap:12}}>
            <button onClick={toggleNav} title={navOpen?'Ocultar menú':'Mostrar menú'}
              style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:6,padding:'7px 9px',cursor:'pointer',display:'flex',flexDirection:'column',justifyContent:'center',gap:3}}>
              <span style={{width:15,height:2,background:C.mid,display:'block',borderRadius:2}}/>
              <span style={{width:15,height:2,background:C.mid,display:'block',borderRadius:2}}/>
              <span style={{width:15,height:2,background:C.mid,display:'block',borderRadius:2}}/>
            </button>
            <div style={{fontWeight:700,fontSize:17,color:C.ink,letterSpacing:'-0.3px'}}>{pageTitles[page]||page}</div>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:12,flexShrink:0}}>
            {offline&&<span style={{fontSize:11,color:C.dim,fontWeight:500,background:C.bg,border:`1px solid ${C.border}`,padding:'3px 10px',borderRadius:12}}>Demo offline</span>}
            {!offline&&!loading&&rtLive&&<span style={{fontSize:11,color:C.green,fontWeight:600,background:TINT.okBg,padding:'3px 10px',borderRadius:12}} className="pulse">En vivo</span>}
            {!offline&&!loading&&!rtLive&&<span style={{fontSize:11,color:C.mid,fontWeight:500,background:C.bg,border:`1px solid ${C.border}`,padding:'3px 10px',borderRadius:12}}>Conectado</span>}
            {/* La identidad del usuario vive en el pie del sidebar (patrón
                admin/gerente); mostrarla también acá la duplicaba en pantalla. */}
            {/* Ícono del set compartido (mythos-icons.js) en vez del glifo Unicode ↺ */}
            <button onClick={()=>loadAll({silent:true})} disabled={refreshing} title="Recargar datos" style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:6,padding:'6px 10px',color:C.mid,cursor:'pointer',opacity:refreshing?0.5:1,display:'inline-flex',alignItems:'center'}}><span className={refreshing?'spin':''} style={{display:'inline-flex'}}><Icon name="refresh" size={14}/></span></button>
          </div>
        </div>
        {/* Contenido */}
        <div style={{flex:1,padding:24,overflowY:'auto'}}>
          {loading ? (
            <div style={{display:'flex',justifyContent:'center',alignItems:'center',height:200,gap:14}}>
              <Spinner/><span style={{color:C.mid}}>Cargando Mythos…</span>
            </div>
          ) : (
            <>
              {page==='dashboard'     && <PageDashboard    enriched={enriched} orders={orders} ratings={ratings} subscriptions={subscriptions} setFlash={setFlash} reload={reloadSilent} setPage={setPage}/>}
              {page==='paneles'       && <PageSuperPaneles restaurants={restaurants}/>}
              {page==='capacidad'     && <PageCapacidad    enriched={enriched}/>}
              {page==='restaurantes'  && <PageRestaurantes enriched={enriched} plans={plans} addonCatalog={addonCatalog} setFlash={setFlash} reload={reloadSilent}/>}
              {page==='prospeccion'   && <PageProspeccion  setFlash={setFlash} restaurants={restaurants}/>}
              {page==='facturacion'   && <PageFacturacion  enriched={enriched} plans={plans} addonCatalog={addonCatalog} platformConfig={platformConfig} setFlash={setFlash} reload={reloadSilent}/>}
              {page==='finanzas'      && <PageFinanzas     enriched={enriched} setFlash={setFlash}/>}
              {page==='fiscal'        && <PageFiscal       setFlash={setFlash}/>}
              {page==='usuarios'      && <PageUsuarios     restaurants={restaurants} setFlash={setFlash}/>}
              {page==='proveedores'   && <PageProveedores  restaurants={restaurants} setFlash={setFlash}/>}
              {page==='comensales'    && <PageComensales   setFlash={setFlash}/>}
              {page==='riders'        && <PageRiders       setFlash={setFlash}/>}
              {page==='soporte'       && <PageSoporte      setFlash={setFlash}/>}
              {page==='reportes'      && <PageReportes     enriched={enriched} orders={orders} ratings={ratings} subscriptions={subscriptions} plans={plans} events={events}/>}
              {page==='actividad'     && <PageActividad    events={events} restaurants={restaurants} setFlash={setFlash} reload={reloadSilent}/>}
              {page==='sitio_web'     && <PageSitioWeb     setFlash={setFlash}/>}
              {page==='horarios'      && <PageHorarios     restaurants={restaurants} setFlash={setFlash} reload={reloadSilent}/>}
              {page==='configuracion' && <PageConfiguracion restaurants={restaurants} platformConfig={platformConfig} setFlash={setFlash} reload={reloadSilent}/>}
            </>
          )}
        </div>
      </div>
      <FlashMsg msg={flash} onClose={()=>setFlash(null)}/>
    </div>
  );
}

// ── Auth guard — solo superadmin ─────────────────────────────
async function bootstrap() {
  if (!db) {
    createRoot(document.getElementById('root')).render(<App/>);
    return;
  }
  const { data: { session } } = await db.auth.getSession();
  if (!session) { window.location.replace('login.html'); return; }
  const { data: profile } = await db.rpc('get_my_profile');
  if (!profile || profile.role !== 'superadmin') {
    await db.auth.signOut();
    window.location.replace('login.html');
    return;
  }
  window._userProfile = profile;
  createRoot(document.getElementById('root')).render(<App/>);
}
bootstrap();
