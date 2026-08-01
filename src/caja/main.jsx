// ════════════════════════════════════════════════════════════════════
// PR-5 — Panel caja precompilado con Vite (batch de migración legacy).
// Migrado 1:1 desde el <script type="text/babel"> inline de public/caja.html.
// Sin cambios de comportamiento ni de UI. React/createRoot vienen de npm
// (bundle Vite); el resto de globales del shell siguen en window.* (config.js,
// supabase UMD, MythosTheme/Icons/Presence/Session/Gating, XLSX, Leaflet, etc.).
// ════════════════════════════════════════════════════════════════════
import React from "react";
import { createRoot } from "react-dom/client";
import { formatGs, parseGs, GsInput } from "../shared/gs.jsx";
// Día comercial del local (huso de restaurants.timezone, default America/Asuncion).
// NUNCA usar toISOString().slice(0,10) para "hoy": ver el encabezado de fecha.js.
import { initBusinessTZ, todayLocal } from "../shared/fecha.js";
// FASE D2 — comprobante (foto) + validación del pago (mig 182).
import { ComprobanteUploader, recordPaymentReview, reviewMeta, ProofImage } from "../shared/comprobante.jsx";

// PR-5 (Bug A): mythos-gating.js es un script global legacy que usa React global
// (window.React). Tras bundlear React por panel con Vite ya no existe como global y
// useCapabilities() rompía con "React is not defined". Reexponemos la MISMA instancia de
// React (la del bundle) para el script global; NO se reintroduce React por CDN.
window.React = React;

const { useState, useEffect, useRef, useMemo, useCallback, useReducer } = React;

/* ── Icon (SVG inline de mythos-icons.js, hereda color/tamaño) — WS5 ── */
const Icon = ({ name, size = 16, style }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0, ...(style || {}) }}
        dangerouslySetInnerHTML={{ __html: window.MythosIcons ? window.MythosIcons.html(name, { size }) : '' }} />
);

/* ── DB ── */
// Clave de almacenamiento de la sesión Supabase (formato por defecto de supabase-js).
const _SB_REF = ((window.SUPABASE_CONFIG?.url||'').match(/https?:\/\/([^.]+)\./)||[])[1]||'';
const SB_STORAGE_KEY = 'sb-'+_SB_REF+'-auth-token';
const _initDB = () => {
  const cfg = window.SUPABASE_CONFIG;
  if (!cfg?.url || !cfg?.anonKey) return null;
  const url = cfg.url.replace(/^﻿/,'').trim();
  const key = cfg.anonKey.replace(/^﻿/,'').trim();
  if (!url || url.includes('YOUR_') || !key) return null;
  // ── Sesión persistente (localStorage, por defecto de supabase-js) ────────
  // Caja recuerda la sesión entre cierres de pestaña, igual que el resto de los
  // paneles. El cierre ocurre sólo por logout explícito o por inactividad
  // (mythos-session.js, 1h). Si quedó un token en sessionStorage de la versión
  // anterior (sesión por-pestaña), lo migramos UNA vez a localStorage para no
  // patear al cajero que ya estaba logueado.
  try {
    const ss = window.sessionStorage.getItem(SB_STORAGE_KEY);
    if (ss && !window.localStorage.getItem(SB_STORAGE_KEY)) {
      window.localStorage.setItem(SB_STORAGE_KEY, ss);
    }
    window.sessionStorage.removeItem(SB_STORAGE_KEY);
  } catch (_) {}
  try {
    return window.supabase.createClient(url, key);
  } catch(e) { return null; }
};
const db = _initDB();
// ¿Hay sesión persistida? (token en localStorage) — permite redirigir a login al
// instante cuando no hay sesión, sin esperar el refresh. Caja ya NO usa sesión
// por-pestaña: la sesión se recuerda entre pestañas (cierre sólo por inactividad).
const HAS_TAB_SESSION = (()=>{ try{ return !!window.localStorage.getItem(SB_STORAGE_KEY); }catch(_){ return false; } })();
// Multi-tenant Engine: el comercio se resuelve desde la sesión activa (localStorage), sin UUID hardcodeado.
// Superadmin launcher (superadmin → Paneles): puede fijar el local por ?r= para verlo/operarlo
// con su bypass de RLS (mig 088). SOLO aplica al superadmin; cualquier otro rol ignora ?r=.
const _SUPER_RID = (function(){ try {
  if ((localStorage.getItem('mythos_role')||'').trim() !== 'superadmin') return null;
  return (new URLSearchParams(window.location.search).get('r')||'').trim() || null;
} catch(_) { return null; } })();
const RESTAURANT_ID = _SUPER_RID || localStorage.getItem('mythos_restaurant_id');
initBusinessTZ(db, RESTAURANT_ID);
let RID = RESTAURANT_ID; // alias retro-compatible; initApp lo reafirma con profile.restaurant_id
// Carrito/checkout de caja aislado por restaurante: el superadmin puede impersonar
// varios locales vía ?r= en el mismo navegador → cada uno con su propio carrito.
// Solo aplica a las claves de CARRITO (caja_cart/order_type/table_id/customer_name);
// las prefs de UI (caja_panel/caja_mesa_view/…) siguen globales. Sentinel sin RID.
const lsk = name => (RESTAURANT_ID || '_nolocal_') + ':' + name;

/* ── DENOMINACIONES GUARANÍES ── */
const DENOMS = [
  {v:50,   t:'moneda', lbl:'₲ 50'},
  {v:100,  t:'moneda', lbl:'₲ 100'},
  {v:500,  t:'moneda', lbl:'₲ 500'},
  {v:1000, t:'billete',lbl:'₲ 1.000'},
  {v:2000, t:'billete',lbl:'₲ 2.000'},
  {v:5000, t:'billete',lbl:'₲ 5.000'},
  {v:10000,t:'billete',lbl:'₲ 10.000'},
  {v:20000,t:'billete',lbl:'₲ 20.000'},
  {v:50000,t:'billete',lbl:'₲ 50.000'},
  {v:100000,t:'billete',lbl:'₲ 100.000'},
];
const emptyDenoms = () => Object.fromEntries(DENOMS.map(d=>[d.v,0]));
const calcDenomTotal = d => DENOMS.reduce((s,x)=>s+(d[x.v]||0)*x.v, 0);

/* ── CONSTANTES ── */
const MOTIVOS_CANCEL = ['Error del cliente','Cambio de decisión','Demora excesiva','Error del cajero','Error de cocina','Producto no disponible','Otro'];
const METODOS_PAGO   = [{id:'efectivo',lbl:'Efectivo'},{id:'tarjeta_credito',lbl:'Tarjeta Cred.'},{id:'tarjeta_debito',lbl:'Tarjeta Déb.'},{id:'qr',lbl:'QR / Transfer.'},{id:'mixto',lbl:'Mixto'}];
// orders.payment_method tiene CHECK IN ('efectivo','tarjeta','qr','pos','pos_mesa','transferencia') (mig 044),
// distinto del CHECK de movimientos_caja.metodo_pago. Mapeamos el método del selector ANTES de escribir
// orders.payment_method (igual que la RPC cobro_mesa_parcial). En movimientos_caja se guarda el método CRUDO.
const mapOrderPM = m =>
  /^tarjeta/.test(m||'') ? 'tarjeta'
  : (m==='mixto'||m==='gift_card'||m==='cuenta_corriente') ? 'pos'
  : (m||'efectivo');
const EG_CATS        = ['Insumos','Propinas al staff','Servicio/Mantenimiento','Devolución a cliente','Otro'];
const ING_CATS       = ['Delivery externo','Evento privado','Venta de mercadería','Otro'];
const DELIVERY_PLATS = ['Rappi','PedidosYa','UberEats','Otro'];
const QUEJA_CATS     = ['Tiempo de espera','Calidad de la comida','Temperatura incorrecta','Error en el pedido','Trato del personal','Limpieza','Precio o cobro incorrecto','Otro'];
const CORTESIA_MOTIVOS = ['Error de cocina','Cliente VIP','Evento especial','Compensación por queja','Otro'];
const FONDO_MINIMO   = 50000; // ₲ 50.000 mínimo recomendado

/* ── PRINT TICKET ── */
// El render del comprobante 80mm vive en window.MythosReceipt (public/mythos-receipt.js),
// compartido con el diseñador de admin (vista previa = lo que se imprime). printTicket
// arma el `data` y delega; la config (campos/ancho/encabezado) sale de window._receiptConfig,
// cargada en el bootstrap desde restaurant_settings.settings_json.receipt + datos del negocio.
function printTicket(t){
  t = t || {};
  if(!window.MythosReceipt){ toast('No se pudo cargar el módulo de impresión',false); return; }
  const cfg = window._receiptConfig || window.MythosReceipt.defaultConfig;
  const ok = window.MythosReceipt.print({
    orderNumber: t.orderNumber,
    tableLabel:  t.mesa,
    customerName:t.customerName,        // undefined → el renderer pone "Anónimo"
    customerRuc: t.customerRuc,
    cashier:     t.cashier,
    createdAt:   t.createdAt,
    items:       t.items,
    total:       t.total,
    metodo:      t.metodo,
    cambio:      t.cambio,
    isOffline:   t.isOffline,
    partial:     t.partial,            // cobro por mesa: badge "PAGO PARCIAL"
  }, cfg);
  if(ok===false) toast('Permití ventanas emergentes para imprimir',false);
}

/* ── MENU CACHE (localStorage) ── */
const menuCache={
  save(cats,items,tables){
    try{
      localStorage.setItem('mythos_menu_cats',JSON.stringify(cats));
      localStorage.setItem('mythos_menu_items',JSON.stringify(items));
      localStorage.setItem('mythos_menu_tables',JSON.stringify(tables));
    }catch(e){}
  },
  load(){
    try{
      return{
        cats:JSON.parse(localStorage.getItem('mythos_menu_cats')||'[]'),
        items:JSON.parse(localStorage.getItem('mythos_menu_items')||'[]'),
        tables:JSON.parse(localStorage.getItem('mythos_menu_tables')||'[]'),
      };
    }catch{return{cats:[],items:[],tables:[]};}
  },
};

/* ── OFFLINE QUEUE (localStorage) ── */
const offlineQ={
  _key:'mythos_offline_orders',
  _cntKey:'mythos_order_counter',
  getAll(){try{return JSON.parse(localStorage.getItem(this._key)||'[]');}catch{return[];}},
  _save(orders){localStorage.setItem(this._key,JSON.stringify(orders));},
  add(order){const all=this.getAll();all.push(order);this._save(all);},
  remove(localId){this._save(this.getAll().filter(o=>o.local_id!==localId));},
  nextNum(){
    const n=(parseInt(localStorage.getItem(this._cntKey)||'0')+1);
    localStorage.setItem(this._cntKey,String(n));
    return n;
  },
  pending(){return this.getAll().filter(o=>!o.synced);},
  markSynced(localId){
    const all=this.getAll().map(o=>o.local_id===localId?{...o,synced:true}:o);
    this._save(all);
  },
};

/* ── UTILS ── */
const fmt    = n => '₲ ' + (n||0).toLocaleString('es-PY');
const fmtK   = n => n>=1000000?`${(n/1000000).toFixed(1)}M`:n>=1000?`${Math.round(n/1000)}k`:String(n||0);
const fmtDate= d => new Date(d).toLocaleDateString('es-PY',{day:'2-digit',month:'2-digit',year:'2-digit'});
const fmtTime= d => new Date(d).toLocaleTimeString('es-PY',{hour:'2-digit',minute:'2-digit'});
const fmtDT  = d => `${fmtDate(d)} ${fmtTime(d)}`;
const fmtDur = (from,to=new Date()) => {
  const s=Math.floor((new Date(to)-new Date(from))/1000);
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60);
  return h>0?`${h}h ${m}m`:`${m}m`;
};
const SL = {draft:'Borrador',confirmed:'Confirmado',paid:'Nuevo',pending_payment:'A cobrar',kitchen_received:'En cocina',cooking:'Preparando',ready:'Listo',delivered:'Entregado',cancelled:'Cancelado'};
const SC = {paid:'#FF9500',pending_payment:'#FF9500',kitchen_received:'#007AFF',cooking:'#FF9500',ready:'#34C759',delivered:'#86868B',cancelled:'#FF3B30'};

/* ── PALETA — reactiva al tema MythosTheme ── */
const C_LIGHT = {
  bg:'#F5F5F7',sidebar:'#FFFFFF',surface:'#FFFFFF',card:'#FFFFFF',
  border:'#D2D2D7',bs:'#86868B',
  white:'#FFFFFF',ink:'#1D1D1F',mid:'#6E6E73',dim:'#86868B',
  green:'#34C759',orange:'#FF9500',red:'#FF3B30',yellow:'#FF9500',blue:'#007AFF',purple:'#000000',cyan:'#007AFF',
};
const C_DARK = {
  bg:'#000000',sidebar:'#1C1C1E',surface:'#1C1C1E',card:'#2C2C2E',
  border:'#38383A',bs:'#636366',
  white:'#1C1C1E',ink:'#F5F5F7',mid:'#AEAEB2',dim:'#8E8E93',
  green:'#30D158',orange:'#FF9F0A',red:'#FF453A',yellow:'#FFD60A',blue:'#0A84FF',purple:'#F5F5F7',cyan:'#0A84FF',
};
const C = {...(window.MythosTheme && window.MythosTheme.get()==='dark' ? C_DARK : C_LIGHT)};

/* ── TINT (PR-B4E) ── tintes de estado theme-adaptive y frozen-safe.
   Strings color-mix(var(--estado) N%, var(--surface|--text-primary)): el navegador los
   resuelve por tema en cada paint, así que sirven incluso dentro de objetos const. En
   light replican el tinte pastel + texto oscuro previos; en dark dan tinte oscuro + texto
   claro. Mismo lenguaje que .my-badge. NO cambia lógica: solo el valor de color. */
const TINT = {
  amberBg:'color-mix(in srgb, var(--warning) 16%, var(--surface))',
  amberText:'color-mix(in srgb, var(--warning) 72%, var(--text-primary))',
  amberBorder:'color-mix(in srgb, var(--warning) 40%, transparent)',
  greenBg:'color-mix(in srgb, var(--success) 15%, var(--surface))',
  greenText:'color-mix(in srgb, var(--success) 68%, var(--text-primary))',
  greenBorder:'color-mix(in srgb, var(--success) 38%, transparent)',
  blueBg:'color-mix(in srgb, var(--info) 14%, var(--surface))',
  blueText:'color-mix(in srgb, var(--info) 72%, var(--text-primary))',
  blueBorder:'color-mix(in srgb, var(--info) 38%, transparent)',
  redBg:'color-mix(in srgb, var(--error) 15%, var(--surface))',
  redText:'color-mix(in srgb, var(--error) 70%, var(--text-primary))',
  redBorder:'color-mix(in srgb, var(--error) 40%, transparent)',
  purpleBg:'color-mix(in srgb, #5856D6 16%, var(--surface))',
  purpleBorder:'color-mix(in srgb, #5856D6 40%, transparent)',
};

/* ── TOAST ── */
const _toast = {fn:null};
function toast(msg,ok=true){_toast.fn?.({msg,ok,id:Date.now()});}
function ToastContainer(){
  const [items,setItems]=useState([]);
  useEffect(()=>{
    _toast.fn=item=>{setItems(p=>[...p.slice(-4),item]);setTimeout(()=>setItems(p=>p.filter(i=>i.id!==item.id)),4500);};
    return()=>{_toast.fn=null;};
  },[]);
  return(
    <div style={{position:'fixed',bottom:20,right:20,zIndex:9999,display:'flex',flexDirection:'column',gap:8,pointerEvents:'none'}}>
      {items.map(it=>(
        <div key={it.id} style={{background:it.ok?TINT.greenBg:TINT.redBg,border:`1px solid ${it.ok?TINT.greenBorder:TINT.redBorder}`,color:it.ok?TINT.greenText:TINT.redText,padding:'10px 16px',fontSize:13,fontWeight:700,borderRadius:8,animation:'slideUp 200ms ease',minWidth:220,maxWidth:340}}>
          {it.ok?'✓ ':'✕ '}{it.msg}
        </div>
      ))}
    </div>
  );
}

/* ── MODAL ── */
function Modal({title,onClose,children,width=460}){
  useEffect(()=>{const fn=e=>e.key==='Escape'&&onClose();window.addEventListener('keydown',fn);return()=>window.removeEventListener('keydown',fn);},[onClose]);
  return(
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.88)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000,padding:20}}>
      <div style={{background:C.bg,border:`1px solid ${C.bs}`,borderRadius:12,padding:28,width:'100%',maxWidth:width,maxHeight:'92vh',overflowY:'auto',animation:'slideUp 200ms ease'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
          <div style={{fontSize:16,fontWeight:700}}>{title}</div>
          <button onClick={onClose} style={{background:'none',border:'none',color:C.mid,fontSize:24,lineHeight:1,padding:0}}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ── SHARED COMPONENTS ── */
function Lbl({children,required}){return<label style={{fontSize:10,color:C.mid,display:'block',marginBottom:5,fontWeight:700,letterSpacing:1}}>{children}{required&&<span style={{color:C.red,marginLeft:3}}>*</span>}</label>;}
function Inp({value,onChange,placeholder,type='text',mono,full=true,gs,style:sx,...rest}){
  const style={width:full?'100%':'auto',padding:'9px 11px',fontSize:14,fontFamily:mono?"'SF Mono',ui-monospace,monospace":'inherit',borderRadius:6,...(sx||{})};
  // gs: input de guaraníes con separador de miles (100.000); onChange recibe el
  // string de dígitos crudos (sin puntos). Conserva el estilo del <Inp> de caja.
  if(gs) return <GsInput value={value} onChange={onChange} placeholder={placeholder} {...rest} style={style}/>;
  return <input type={type} value={value} onChange={onChange} placeholder={placeholder} {...rest} style={style}/>;
}
function Sel({value,onChange,children,...rest}){return<select value={value} onChange={onChange} {...rest} style={{width:'100%',padding:'9px 11px',fontSize:14,borderRadius:6,...(rest.style||{})}}>{children}</select>;}
function Textarea({value,onChange,placeholder,rows=3}){return<textarea value={value} onChange={onChange} placeholder={placeholder} rows={rows} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6,resize:'vertical'}}/>;}
function Btn({children,onClick,variant='primary',disabled,small,full,style:sx}){
  // PR-B3D: cableado a .my-btn + variante/tamaño. Sin cambio de props ni de la
  // semántica (disabled sigue como atributo nativo del <button>; full = ancho completo).
  // Mapeo de variantes: primary/danger/success/ghost → su clase; resto → secondary.
  // danger/success pasan de tinte suave a sólido (estándar del design system).
  const vcls={primary:'my-btn--primary',danger:'my-btn--danger',success:'my-btn--success',ghost:'my-btn--ghost'}[variant]||'my-btn--secondary';
  const cls=`my-btn ${vcls}${small?' my-btn--sm':''}`;
  return<button onClick={onClick} disabled={disabled} className={cls} style={{...(full?{width:'100%'}:{}),...sx}}>{children}</button>;
}
function Divider(){return<div style={{height:1,background:C.border,margin:'8px 0'}}/>;}

/* ── Datos de transferencia del comercio (mig 180) — loader cacheado + hook ──
   Los carga el dueño en Admin → Configuración. Caja los muestra al cobrar por
   transferencia/QR para que el cliente transfiera o escanee el QR. Lectura del
   PROPIO restaurante (tenant scoping vigente); no toca RLS ni al rol anon. */
let _bankInfoCache;              // undefined = sin cargar · null = sin datos · obj = datos
let _bankInfoPromise = null;
function loadBankInfo(){
  if(_bankInfoCache!==undefined) return Promise.resolve(_bankInfoCache);
  if(_bankInfoPromise) return _bankInfoPromise;
  if(!db||!RID){ _bankInfoCache=null; return Promise.resolve(null); }
  _bankInfoPromise = db.from('restaurants')
    .select('bank_holder,bank_name,bank_account,bank_alias,bank_doc,bank_qr_url')
    .eq('id',RID).maybeSingle()
    .then(r=>{ _bankInfoCache=(r&&r.data)||null; return _bankInfoCache; })
    .catch(()=>{ _bankInfoCache=null; return null; });
  return _bankInfoPromise;
}
function useBankInfo(){
  const [bi,setBi]=useState(_bankInfoCache||null);
  useEffect(()=>{ let m=true; loadBankInfo().then(v=>{ if(m)setBi(v); }); return ()=>{m=false;}; },[]);
  return bi;
}

/* ── Config de cobro (mig 182): require_proof = exigir comprobante (N° o foto)
   para cobrar por transferencia/QR. Mismo loader cacheado (lectura del propio
   restaurante). NULL / clave ausente = no exige (fail-open). ── */
let _payCfgCache;                // undefined = sin cargar · obj = delivery_config · null = sin config
let _payCfgPromise = null;
function loadPayCfg(){
  if(_payCfgCache!==undefined) return Promise.resolve(_payCfgCache);
  if(_payCfgPromise) return _payCfgPromise;
  if(!db||!RID){ _payCfgCache=null; return Promise.resolve(null); }
  _payCfgPromise = db.from('restaurants')
    .select('delivery_config')
    .eq('id',RID).maybeSingle()
    .then(r=>{ _payCfgCache=(r&&r.data&&r.data.delivery_config)||null; return _payCfgCache; })
    .catch(()=>{ _payCfgCache=null; return null; });
  return _payCfgPromise;
}
function useRequireProof(){
  const [v,setV]=useState(!!(_payCfgCache&&_payCfgCache.require_proof));
  useEffect(()=>{ let m=true; loadPayCfg().then(c=>{ if(m)setV(!!(c&&c.require_proof)); }); return ()=>{m=false;}; },[]);
  return v;
}
// ¿Falta el comprobante exigido? Solo aplica a transferencia/QR (metodo 'qr').
// Se cumple con el N° de operación O con la foto — cualquiera de los dos alcanza.
function _faltaComprobante(requireProof, metodo, comprobante, proofUrl){
  return requireProof && metodo==='qr' && !String(comprobante||'').trim() && !proofUrl;
}
const _MSG_FALTA_COMP='Este local exige comprobante para cobrar por transferencia/QR — cargá el N° de operación o la foto.';
// Métodos que admiten Nº de comprobante (tarjeta POS / transferencia / QR / mixto).
// FUENTE ÚNICA: la usan tanto la UI (mostrar el campo) como el guardado de
// orders.payment_reference. No duplicar la lista — se desincronizan.
const _needsRef = m => m==='tarjeta_credito'||m==='tarjeta_debito'||m==='qr'||m==='mixto';
// ¿El error es "esa columna no existe todavía" (migración pendiente) y no un fallo real?
// Sirve para decidir si tiene sentido reintentar un INSERT recortado. Cualquier otro
// error (RLS, red, constraint) NO debe degradar el pedido: debe propagarse.
const _esColumnaFaltante = e =>
  /PGRST204|42703|schema cache|column .* does not exist/i.test(
    `${(e&&e.message)||''} ${(e&&e.code)||''} ${(e&&e.details)||''}`);
/* UI compartida por los modales de cobro: campo "N° de comprobante" (opcional) y,
   para transferencia/QR, los datos de la cuenta del comercio + su QR. */
function PagoRefTransfer({metodo, comprobante, setComprobante, bankInfo, proofUrl, setProofUrl}){
  if(!_needsRef(metodo)) return null;
  const isQr = metodo==='qr';
  const hasData = bankInfo && (bankInfo.bank_holder||bankInfo.bank_name||bankInfo.bank_account||bankInfo.bank_alias||bankInfo.bank_qr_url);
  return (
    <div style={{marginBottom:16}}>
      <Lbl>N° DE COMPROBANTE / OPERACIÓN <span style={{fontWeight:400,color:C.dim,letterSpacing:0}}>(opcional)</span></Lbl>
      <Inp value={comprobante} onChange={e=>setComprobante(e.target.value)}
        placeholder={isQr?'N° de operación de la transferencia':'N° del comprobante del POS'}/>
      <div style={{fontSize:11,color:C.mid,marginTop:4}}>Para conciliar después si el pago llegó. Podés dejarlo vacío.</div>
      {setProofUrl && (
        <div style={{marginTop:12}}>
          <ComprobanteUploader db={db} restaurantId={RID} value={proofUrl||''} onChange={setProofUrl} onMsg={(m,ok)=>toast(m,ok)}/>
        </div>
      )}
      {isQr && (hasData ? (
        <div style={{marginTop:12}}>
          <Lbl>DATOS PARA LA TRANSFERENCIA</Lbl>
          <div style={{display:'flex',gap:12,alignItems:'flex-start',background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:12}}>
            <div style={{flex:1,fontSize:13,lineHeight:1.6,color:C.ink,wordBreak:'break-word'}}>
              {bankInfo.bank_holder&&<div><span style={{color:C.mid}}>Titular:</span> <strong>{bankInfo.bank_holder}</strong></div>}
              {bankInfo.bank_name&&<div><span style={{color:C.mid}}>Banco:</span> {bankInfo.bank_name}</div>}
              {bankInfo.bank_account&&<div><span style={{color:C.mid}}>Cuenta:</span> {bankInfo.bank_account}</div>}
              {bankInfo.bank_alias&&<div><span style={{color:C.mid}}>Alias:</span> {bankInfo.bank_alias}</div>}
              {bankInfo.bank_doc&&<div><span style={{color:C.mid}}>CI/RUC:</span> {bankInfo.bank_doc}</div>}
            </div>
            {bankInfo.bank_qr_url&&<img src={bankInfo.bank_qr_url} alt="QR transferencia" style={{width:104,height:104,objectFit:'contain',borderRadius:8,border:`1px solid ${C.border}`,background:'#fff',flexShrink:0}}/>}
          </div>
          <div style={{fontSize:11,color:C.mid,marginTop:4}}>Mostrale estos datos al cliente. Si hay QR, puede escanearlo y transferir directo.</div>
        </div>
      ) : (
        <div style={{marginTop:12,padding:'10px 12px',background:C.card,border:`1px dashed ${C.border}`,borderRadius:8,fontSize:12,color:C.mid,lineHeight:1.5}}>
          El dueño todavía no cargó los datos de transferencia. Se configuran en <strong>Admin → Configuración → Datos para transferencias</strong>.
        </div>
      ))}
    </div>
  );
}
function KpiMini({label,value,accent,sub}){
  // PR-B3D: contenedor → .my-metric-card (superficie/borde/radio/sombra/padding por tokens).
  // Label → .my-metric-card__label (mismo look: xs, semibold, uppercase, secondary).
  // Se CONSERVA el valor en mono y el `accent` SEMÁNTICO (ocupadas/listos/delivery/sin-cobrar…);
  // el fallback C.ink pasa a var(--text-primary). `sub` conservado.
  return(
    <div className="my-metric-card">
      <div className="my-metric-card__label">{label}</div>
      <div style={{fontSize:22,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:accent||'var(--text-primary)',lineHeight:1}}>{value}</div>
      {sub&&<div style={{fontSize:11,color:C.dim,marginTop:4}}>{sub}</div>}
    </div>
  );
}
function Badge({txt,color='#86868B'}){
  return<span style={{background:color+'22',color,border:`1px solid ${color}44`,padding:'2px 8px',fontSize:11,fontWeight:700,borderRadius:4,whiteSpace:'nowrap'}}>{txt}</span>;
}
function orderTypeColor(t){
  if(t==='delivery') return '#FF3B30';
  if(t==='llevar'||t==='takeaway') return '#FF9500';
  if(t==='pickup') return '#FFD60A';
  return '#5AC8FA'; // local/dine_in/mostrador/sin_mesa — celeste
}
function orderTypeLabel(t){
  if(t==='delivery') return 'Delivery';
  if(t==='llevar'||t==='takeaway') return 'Para llevar';
  if(t==='pickup') return 'Para buscar';
  if(t==='mostrador') return 'Sin mesa';
  return 'Salón';
}
function AlertBox({type='info',children}){
  const cfg={info:{bg:TINT.blueBg,border:TINT.blueBorder,color:TINT.blueText},warn:{bg:TINT.amberBg,border:TINT.amberBorder,color:TINT.amberText},error:{bg:TINT.redBg,border:TINT.redBorder,color:TINT.redText},success:{bg:TINT.greenBg,border:TINT.greenBorder,color:TINT.greenText}};
  const s=cfg[type]||cfg.info;
  return<div style={{background:s.bg,border:`1px solid ${s.border}`,color:s.color,padding:'10px 14px',borderRadius:8,fontSize:13,marginBottom:12}}>{children}</div>;
}

/* ═══════════════════════════════════════════
   PANEL DE DENOMINACIONES (apertura y cierre)
═══════════════════════════════════════════ */
function DenomGrid({values,onChange,label=''}){
  const total=calcDenomTotal(values);
  return(
    <div>
      {label&&<div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:1,textTransform:'uppercase',marginBottom:10}}>{label}</div>}
      <div className="my-row-2" style={{gap:8,marginBottom:12}}>
        {DENOMS.map(d=>(
          <div key={d.v} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:'10px 12px',display:'flex',alignItems:'center',gap:8}}>
            <div style={{flex:1}}>
              <div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:2,display:'flex',alignItems:'center',gap:4}}><Icon name="money" size={10} /> {d.lbl}</div>
              <input
                type="number" min="0" step="1"
                value={values[d.v]||''}
                onChange={e=>onChange({...values,[d.v]:Math.max(0,parseInt(e.target.value)||0)})}
                placeholder="0"
                style={{width:'100%',background:'transparent',border:'none',color:C.white,fontSize:18,fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:700,outline:'none',padding:0}}
              />
            </div>
            <div style={{fontSize:11,color:C.dim,fontFamily:"'SF Mono',ui-monospace,monospace",textAlign:'right',whiteSpace:'nowrap'}}>
              {(values[d.v]||0)>0?fmt((values[d.v]||0)*d.v):''}
            </div>
          </div>
        ))}
      </div>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'14px 16px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <div style={{fontSize:13,color:C.mid,fontWeight:700}}>TOTAL CONTADO</div>
        <div style={{fontSize:28,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.green}}>{fmt(total)}</div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   PANTALLA: APERTURA DE TURNO
═══════════════════════════════════════════ */
function AperturaTurnoScreen({profile,cajas=[],openTurnos=[],onTurnoAbierto,onRetomar}){
  const [denoms,setDenoms]=useState(emptyDenoms());
  const [obs,setObs]=useState('');
  const [busy,setBusy]=useState(false);
  const [rcfg,setRcfg]=useState({cash_mode_default:'libre',cash_fondo_fijo:0,cash_diff_umbral:50000});
  const [modo,setModo]=useState('libre');
  const [modoTouched,setModoTouched]=useState(false);
  const [cfgLoaded,setCfgLoaded]=useState(false);
  const [selCajaId,setSelCajaId]=useState(null);

  // Multi-caja: ocupación = caja con turno abierto. Sin cajas → caja implícita (legacy).
  const turnoDeCaja = id => (openTurnos||[]).find(t=>String(t.caja_id||'')===String(id||''));
  const multiCaja = (cajas||[]).length>0;
  const selCaja = (cajas||[]).find(c=>String(c.id)===String(selCajaId))||null;

  // Config EFECTIVA: la de la caja elegida, con fallback al restaurante (mig 127).
  const cfg = {
    cash_mode_default: (selCaja&&selCaja.cash_mode_default) || rcfg.cash_mode_default,
    cash_fondo_fijo:   (selCaja&&selCaja.cash_fondo_fijo!=null)  ? Number(selCaja.cash_fondo_fijo)  : rcfg.cash_fondo_fijo,
    cash_diff_umbral:  (selCaja&&selCaja.cash_diff_umbral!=null) ? Number(selCaja.cash_diff_umbral) : rcfg.cash_diff_umbral,
  };

  useEffect(()=>{
    (async()=>{
      const{data}=await db.from('restaurants').select('cash_mode_default,cash_fondo_fijo,cash_diff_umbral').eq('id',RID).maybeSingle();
      if(data){
        setRcfg({
          cash_mode_default:data.cash_mode_default||'libre',
          cash_fondo_fijo:Number(data.cash_fondo_fijo)||0,
          cash_diff_umbral:Number(data.cash_diff_umbral)||50000,
        });
      }
      setCfgLoaded(true);
    })();
  },[]);

  // Auto-seleccionar cuando hay UNA sola caja activa y está libre (sin selector).
  useEffect(()=>{
    if(selCajaId) return;
    if(multiCaja && cajas.length===1 && !turnoDeCaja(cajas[0].id)) setSelCajaId(cajas[0].id);
  },[cajas]);

  // Sugerir el modo según la config efectiva, salvo que el cajero ya lo haya tocado.
  useEffect(()=>{
    if(!modoTouched) setModo(cfg.cash_mode_default==='fijo'&&cfg.cash_fondo_fijo>0?'fijo':'libre');
  },[cfg.cash_mode_default,cfg.cash_fondo_fijo,modoTouched]);

  const total=calcDenomTotal(denoms);
  const fondoBajo=modo==='libre'&&total>0&&total<FONDO_MINIMO;
  const objetivo=modo==='fijo'?cfg.cash_fondo_fijo:0;
  const diffFijo=modo==='fijo'?total-objetivo:0;
  const umbral=cfg.cash_diff_umbral||50000;
  const matchOk=modo==='libre'||Math.abs(diffFijo)<=umbral;
  const needCaja = multiCaja && !selCajaId;        // falta elegir caja
  const showFondo = !multiCaja || !!selCajaId;      // mostrar fondo/denoms sólo con caja elegida
  // Mostrar el selector con varias cajas, o con una sola caja que aún no quedó auto-elegida
  // (p.ej. la única caja está ocupada) para que el cajero la vea / pueda retomar.
  const showSelector = multiCaja && (cajas.length>1 || !selCajaId);

  async function abrir(){
    if(needCaja){toast('Elegí una caja para abrir tu turno.',false);return;}
    if(total===0){toast('Ingresá al menos una denominación para el fondo inicial',false);return;}
    if(modo==='fijo'&&Math.abs(diffFijo)>umbral){
      toast(`El conteo difiere del fondo fijo en ${fmt(Math.abs(diffFijo))} (umbral ${fmt(umbral)}). Ajustá las denominaciones.`,false);return;
    }
    if(modo==='fijo'&&Math.abs(diffFijo)>0&&!obs){
      toast('Hay diferencia con el fondo fijo. Agregá una observación que la explique.',false);return;
    }
    // El INSERT de turnos_caja está protegido por RLS: restaurant_id debe ==
    // get_my_restaurant_id() (el local del usuario autenticado). Si el
    // mythos_restaurant_id cacheado quedó viejo (tras reset de fábrica o cambio
    // de local), el INSERT se rechaza con "violates row-level security policy".
    // Derivamos SIEMPRE el local de la identidad autenticada para que coincida.
    const isSuper=profile.role==='superadmin';
    const ridApertura=isSuper?RID:(profile.restaurant_id||RID);
    if(!isSuper&&!profile.restaurant_id){
      toast('Tu sesión no tiene un restaurante asignado. Cerrá sesión y volvé a iniciarla.',false);return;
    }
    if(!ridApertura){
      toast('No se pudo determinar el restaurante de la caja. Cerrá sesión y volvé a iniciarla.',false);return;
    }
    try{ localStorage.setItem('mythos_restaurant_id',ridApertura); }catch(e){}
    setBusy(true);
    try{
      const payload={
        restaurant_id:ridApertura,
        caja_id:selCajaId||null,
        cajero_id:profile.id,
        cajero_nombre:profile.display_name||profile.username,
        fondo_apertura:{denominaciones:denoms,total},
        observaciones_apertura:obs||null,
        modo_apertura:modo,
        fondo_fijo_objetivo:modo==='fijo'?objetivo:null,
      };
      const{data,error}=await db.from('turnos_caja').insert(payload).select().single();
      if(error)throw error;
      toast('Turno abierto correctamente');
      onTurnoAbierto(data);
    }catch(e){
      // El índice único uniq_turno_abierto_por_caja (mig 127) rechaza un 2º turno
      // abierto en la misma caja (race de dos cajeros eligiendo la misma).
      if(String(e.code)==='23505'||/duplicate key|uniq_turno_abierto/i.test(e.message||'')){
        toast('Esa caja ya tiene un turno abierto. Actualizá la página y elegí otra.',false);
      }else{
        toast('Error al abrir turno: '+e.message,false);
      }
    }
    setBusy(false);
  }

  return(
    <div style={{minHeight:'100vh',background:C.bg,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
      <div style={{width:'100%',maxWidth:600,animation:'fadeIn .2s ease'}}>
        <div style={{textAlign:'center',marginBottom:28}}>
          <div style={{fontFamily:'DM Serif Display',fontSize:28,marginBottom:6}}>Apertura de Turno</div>
          <div style={{fontSize:13,color:C.mid}}>{new Date().toLocaleDateString('es-PY',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</div>
          <div style={{fontSize:13,color:C.dim,marginTop:4}}>Cajero: <span style={{color:C.white,fontWeight:700}}>{profile.display_name||profile.username}</span></div>
        </div>

        {/* Selector de caja (varias cajas, o una sola aún no auto-elegida) */}
        {showSelector && (
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:'14px 18px',marginBottom:12}}>
            <div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:10}}>ELEGÍ TU CAJA</div>
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {cajas.map(c=>{
                const t=turnoDeCaja(c.id);
                const ocupada=!!t;
                const selected=String(selCajaId)===String(c.id);
                return(
                  <div key={c.id} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',borderRadius:8,
                    border:`1.5px solid ${selected?C.ink:C.border}`,background:selected?'rgba(0,0,0,0.03)':'transparent',opacity:ocupada?0.75:1}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:14,fontWeight:700,color:C.ink}}>{c.nombre}{c.zona?<span style={{fontSize:11,color:C.dim,fontWeight:500}}> · {c.zona}</span>:''}</div>
                      {ocupada
                        ? <div style={{fontSize:11,color:'#FF9500',fontWeight:600}}>Ocupada · turno de {t.cajero_nombre||'otro cajero'}</div>
                        : <div style={{fontSize:11,color:'#34C759',fontWeight:600}}>Libre</div>}
                    </div>
                    {ocupada
                      ? <Btn small variant="ghost" onClick={()=>onRetomar&&onRetomar(t)}>Retomar</Btn>
                      : <Btn small variant={selected?'primary':'ghost'} onClick={()=>setSelCajaId(c.id)}>{selected?'Elegida':'Elegir'}</Btn>}
                  </div>
                );
              })}
            </div>
            {needCaja && <div style={{fontSize:11,color:C.dim,marginTop:10}}>Seleccioná una caja libre para cargar su fondo y abrir el turno.</div>}
          </div>
        )}

        {fondoBajo&&showFondo&&(
          <AlertBox type="warn">
            El fondo es menor al mínimo recomendado de {fmt(FONDO_MINIMO)}. Podés continuar igual.
          </AlertBox>
        )}

        {showFondo&&cfgLoaded&&cfg.cash_fondo_fijo>0&&(
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:'14px 18px',marginBottom:12,display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,flexWrap:'wrap'}}>
            <div>
              <div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:4}}>MODO DE APERTURA{selCaja?` · ${selCaja.nombre}`:''}</div>
              <div style={{fontSize:12,color:C.dim}}>{modo==='fijo'?`Fondo fijo definido por admin: ${fmt(cfg.cash_fondo_fijo)}`:'Cajero define el fondo libremente'}</div>
            </div>
            <div style={{display:'flex',gap:6}}>
              {[['libre','Libre'],['fijo','Fondo fijo']].map(([v,lbl])=>(
                <button key={v} onClick={()=>{setModoTouched(true);setModo(v);}}
                  disabled={v==='fijo'&&!(cfg.cash_fondo_fijo>0)}
                  style={{padding:'7px 14px',fontSize:12,borderRadius:6,border:`1px solid ${modo===v?C.ink:C.border}`,background:modo===v?C.ink:'transparent',color:modo===v?C.surface:C.mid,fontWeight:modo===v?700:500,cursor:v==='fijo'&&!(cfg.cash_fondo_fijo>0)?'not-allowed':'pointer',opacity:v==='fijo'&&!(cfg.cash_fondo_fijo>0)?0.4:1}}>{lbl}</button>
              ))}
            </div>
          </div>
        )}

        {showFondo&&modo==='fijo'&&(
          <div className="my-row-3" style={{background:matchOk?'rgba(52,199,89,0.06)':'rgba(255,149,0,0.08)',border:`1px solid ${matchOk?'rgba(52,199,89,0.25)':'rgba(255,149,0,0.3)'}`,borderRadius:10,padding:'12px 16px',marginBottom:12,gap:10,fontFamily:"'SF Mono',ui-monospace,monospace"}}>
            <div><div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:2}}>OBJETIVO</div><div style={{fontSize:16,fontWeight:800,color:C.ink}}>{fmt(objetivo)}</div></div>
            <div><div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:2}}>CONTADO</div><div style={{fontSize:16,fontWeight:800,color:C.ink}}>{fmt(total)}</div></div>
            <div><div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:2}}>DIFERENCIA</div><div style={{fontSize:16,fontWeight:800,color:Math.abs(diffFijo)===0?'#34C759':Math.abs(diffFijo)<=umbral?'#FF9500':'#FF3B30'}}>{diffFijo>=0?'+':''}{fmt(diffFijo)}</div></div>
          </div>
        )}

        {showFondo&&(
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:24,marginBottom:16}}>
            <DenomGrid values={denoms} onChange={setDenoms} label={modo==='fijo'?`Confirmá el fondo fijo (${fmt(objetivo)}) ingresando billetes y monedas`:'Fondo inicial — ingresá la cantidad de cada denominación'}/>
            <div style={{marginTop:14}}>
              <Lbl>OBSERVACIONES {modo==='fijo'&&Math.abs(diffFijo)>0?'(requerido por diferencia)':'(opcional)'}</Lbl>
              <Textarea value={obs} onChange={e=>setObs(e.target.value)} placeholder="Ej: Fondo recibido de turno anterior, novedades…" rows={2}/>
            </div>
          </div>
        )}

        <div style={{display:'flex',gap:10}}>
          <Btn full onClick={abrir} disabled={busy||!cfgLoaded||needCaja}>
            {busy?<><span className="spin"/> Abriendo…</>:needCaja?'Elegí una caja':'Abrir Turno →'}
          </Btn>
          <Btn variant="ghost" onClick={cerrarSesion}>Cambiar usuario</Btn>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   SIDEBAR DEL TURNO
═══════════════════════════════════════════ */
async function cerrarSesion(){
  if(!window.confirm('¿Cerrar sesión?'))return;
  try{await window.MythosPresence?.stop('manual');}catch(_){}
  try{await db.auth.signOut();}catch(e){}
  // Borra el token de sesión (ambos almacenes, por las dudas) y las claves de tenancy/caja.
  try{ sessionStorage.removeItem(SB_STORAGE_KEY); localStorage.removeItem(SB_STORAGE_KEY); }catch(_){}
  ['mythos_role','mythos_restaurant_id','mythos_user_id','mythos_display_name','mythos_last_activity','caja_panel']
    .forEach(k=>{try{localStorage.removeItem(k);}catch(_){}});
  // Carrito/checkout por-restaurante (todas las claves) + legacy global.
  try{ ['caja_cart','caja_order_type','caja_table_id','caja_customer_name'].forEach(kk=>localStorage.removeItem(lsk(kk))); localStorage.removeItem('caja_cart'); }catch(_){}
  window.location.replace('login.html');
}

function SidebarTurno({turno,cajaNombre,movimientos,panel,setPanel,onCierre,profile,onToggleTheme,paymentCalls=0,onClickCalls,isOnline=true,pendingOffline=0,broadcastCount=0}){
  const [hora,setHora]=useState(new Date());
  useEffect(()=>{const t=setInterval(()=>setHora(new Date()),30000);return()=>clearInterval(t);},[]);

  const cobros=movimientos.filter(m=>m.tipo==='cobro');
  const totalCobrado=cobros.reduce((s,m)=>s+Number(m.monto),0);
  const totalEgresos=movimientos.filter(m=>m.tipo==='egreso').reduce((s,m)=>s+Number(m.monto),0);
  const retiros=movimientos.filter(m=>m.tipo==='retiro_parcial').reduce((s,m)=>s+Number(m.monto),0);
  const ingresosMan=movimientos.filter(m=>m.tipo==='ingreso_manual').reduce((s,m)=>s+Number(m.monto),0);
  const efectivoCobros=cobros.filter(m=>m.metodo_pago==='efectivo').reduce((s,m)=>s+Number(m.monto),0);
  const fondoApertura=turno.fondo_apertura?.total||0;
  const saldoEstimado=fondoApertura+efectivoCobros+ingresosMan-totalEgresos-retiros;

  const NAV=[
    {id:'salon',   icon:'',  lbl:'Vista del salón'},
    {id:'pedido',  icon:'',  lbl:'Tomar pedido'},
    {id:'cobros',  icon:'',  lbl:'Cobrar pedidos'},
    {id:'avisos',  icon:'', lbl:'Avisos', badge: broadcastCount},
    {id:'facturas', icon:'', lbl:'Facturas del turno'},
    {id:'historial',icon:'≡', lbl:'Historial'},
    {id:'reservas',icon:'◷', lbl:'Reservas'},
    {id:'retiro',  icon:'',  lbl:'Retiro de efectivo'},
    {id:'cancelaciones', icon:'✕', lbl:'Cancelaciones'},
    {id:'ingresos_egresos', icon:'₲', lbl:'Ingresos / Egresos'},
    {id:'quejas',  icon:'',  lbl:'Quejas / Sugerencias'},
    {id:'cierre',  icon:'',  lbl:'Cierre de caja'},
  ];

  const themeDark = (window.MythosTheme && window.MythosTheme.get()==='dark');
  return(
    <aside style={{width:220,minHeight:'100vh',background:C.sidebar,borderRight:`1px solid ${C.border}`,display:'flex',flexDirection:'column',position:'sticky',top:0,height:'100vh',overflowY:'auto',flexShrink:0}}>
      <div style={{padding:'16px 14px 12px',borderBottom:`1px solid ${C.border}`,display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:8}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontFamily:'inherit',fontWeight:800,fontSize:18,color:C.ink,letterSpacing:'-1px',marginBottom:2}}>Mythos</div>
          {cajaNombre
            ? <div style={{fontSize:11,fontWeight:700,color:C.ink}}>{cajaNombre} · <span style={{fontWeight:500,color:C.mid}}>{profile?.display_name||profile?.username}</span></div>
            : <div style={{fontSize:11,fontWeight:500,color:C.mid}}>Caja · {profile?.display_name||profile?.username}</div>}
          <div style={{fontSize:11,color:C.mid,marginTop:2}}>Desde {fmtTime(turno.fecha_apertura)}</div>
        </div>
        <button onClick={onToggleTheme} title={themeDark?'Cambiar a claro':'Cambiar a oscuro'}
          style={{width:28,height:28,borderRadius:'50%',background:'transparent',border:`1px solid ${C.border}`,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',color:C.ink,flexShrink:0,padding:0}}>
          {themeDark
            ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
            : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>}
        </button>
      </div>

      {/* Reloj y duración */}
      <div style={{padding:'12px 14px',borderBottom:`1px solid ${C.border}`}}>
        <div style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:22,fontWeight:800,color:C.ink}}>{hora.toLocaleTimeString('es-PY',{hour:'2-digit',minute:'2-digit'})}</div>
        <div style={{fontSize:11,color:C.mid,marginTop:2}}>Turno: {fmtDur(turno.fecha_apertura)}</div>
      </div>

      {/* Saldo estimado */}
      <div style={{padding:'12px 14px',borderBottom:`1px solid ${C.border}`}}>
        <div style={{fontSize:9,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:6}}>EFECTIVO EN CAJA (est.)</div>
        <div style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:18,fontWeight:700,color:C.ink}}>{fmt(saldoEstimado)}</div>
        <div style={{fontSize:9,color:C.dim,marginTop:4}}>
          Fondo {fmt(fondoApertura)} + cobros {fmt(efectivoCobros)}
        </div>
      </div>

      {/* Stats del turno */}
      <div style={{padding:'12px 14px',borderBottom:`1px solid ${C.border}`}}>
        <div style={{fontSize:11,fontWeight:700,color:C.mid,letterSpacing:'0.08em',textTransform:'uppercase',marginBottom:10}}>RESUMEN DEL TURNO</div>
        <div style={{display:'flex',flexDirection:'column',gap:0}}>
          {[
            {lbl:'Pedidos cobrados',val:cobros.length},
            {lbl:'Total cobrado',val:fmt(totalCobrado)},
            {lbl:'Egresos',val:fmt(totalEgresos)},
          ].map(({lbl,val})=>(
            <div key={lbl} style={{display:'flex',justifyContent:'space-between',alignItems:'center',paddingBottom:8,borderBottom:`1px solid ${C.border}`}}>
              <span style={{fontSize:12,color:C.mid,fontWeight:500}}>{lbl}</span>
              <span style={{fontSize:lbl==='Total cobrado'?20:16,fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:lbl==='Total cobrado'?800:700,color:C.ink}}>{val}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Navegación */}
      <nav style={{flex:1,padding:'8px 8px'}}>
        {NAV.map(n=>{
          const badge = n.id==='cobros' ? paymentCalls : (n.badge||0);
          return(
          <button key={n.id} onClick={()=>setPanel(n.id)}
            onMouseEnter={e=>{if(panel!==n.id)e.currentTarget.style.background=C.bg;}}
            onMouseLeave={e=>{if(panel!==n.id)e.currentTarget.style.background='transparent';}}
            style={{
              display:'flex',alignItems:'center',gap:10,width:'100%',
              padding:'8px 12px',borderRadius:8,border:'none',textAlign:'left',cursor:'pointer',marginBottom:2,
              background:panel===n.id?C.ink:'transparent',
              color:panel===n.id?C.sidebar:C.ink,fontWeight:panel===n.id?700:500,fontSize:13,
          }}>
            {n.icon&&<span style={{width:18,textAlign:'center',fontSize:14}}>{n.icon}</span>}
            <span style={{flex:1}}>{n.lbl}</span>
            {badge>0&&(
              <span style={{background:'#FF9500',color:'#fff',fontSize:10,fontWeight:800,padding:'1px 7px',borderRadius:10,minWidth:18,textAlign:'center',animation:'pulse 1.5s ease infinite'}}>
                {badge}
              </span>
            )}
          </button>
          );
        })}
      </nav>

      {/* Indicador offline */}
      {!isOnline&&(
        <div style={{margin:'0 8px 6px',background:'rgba(255,59,48,0.1)',border:'1px solid rgba(255,59,48,0.3)',borderRadius:8,padding:'8px 10px'}}>
          <div style={{fontSize:11,fontWeight:700,color:'#FF3B30',marginBottom:2}}>MODO OFFLINE</div>
          <div style={{fontSize:10,color:C.dim}}>Menú desde caché local</div>
          {pendingOffline>0&&<div style={{fontSize:10,color:'#FF9500',marginTop:2,fontWeight:600}}>{pendingOffline} pedido{pendingOffline>1?'s':''} pendiente{pendingOffline>1?'s':''} de sync</div>}
        </div>
      )}

      <div style={{padding:'10px 8px',borderTop:`1px solid ${C.border}`}}>
        <button
          onClick={cerrarSesion}
          title="Cerrar sesión"
          style={{width:'100%',borderRadius:6,padding:'6px 10px',background:'rgba(239,68,68,0.07)',border:'1px solid rgba(239,68,68,0.2)',color:'#FF3B30',fontSize:12,cursor:'pointer',fontFamily:'inherit',fontWeight:600}}
        >
          <Icon name="logout" size={13} style={{verticalAlign:'-2px',marginRight:5}}/> Cerrar sesión
        </button>
      </div>
    </aside>
  );
}

/* ═══════════════════════════════════════════
   PR-FE-4 · FACTURA FISCAL (emisión desde caja)
   El staff emite por su SESIÓN (Bearer access_token); el secret NUNCA va al
   browser. Endpoints: /emitir-caja (emite), /kude (PDF), /email (reenvío).
═══════════════════════════════════════════ */
async function _staffToken(){
  const {data:{session}}=await db.auth.getSession();
  const t=session?.access_token;
  if(!t) throw new Error('Sin sesión activa. Volvé a iniciar sesión.');
  return t;
}
async function apiEmitirFacturaCaja(orderId){
  const token=await _staffToken();
  const resp=await fetch('/api/facturasend/emitir-caja',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
    body:JSON.stringify({restaurant_id:RID,order_id:orderId}),
  });
  const j=await resp.json().catch(()=>({}));
  return {httpOk:resp.ok,...j};
}
async function apiEnviarEmailFactura(cdc,email){
  const token=await _staffToken();
  const resp=await fetch('/api/facturasend/email',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
    body:JSON.stringify({restaurant_id:RID,cdc,email}),
  });
  const j=await resp.json().catch(()=>({}));
  return {httpOk:resp.ok,...j};
}
// KuDE = GET con Authorization → no se puede window.open() directo (sin header):
// se baja el PDF como blob y se abre en pestaña nueva (el usuario imprime).
async function abrirKude(cdc,formato='ticket'){
  const token=await _staffToken();
  const resp=await fetch(`/api/facturasend/kude?restaurant_id=${encodeURIComponent(RID)}&cdc=${encodeURIComponent(cdc)}&formato=${encodeURIComponent(formato)}`,{
    headers:{'Authorization':`Bearer ${token}`},
  });
  if(!resp.ok){
    let msg='No se pudo obtener el KuDE'; try{const j=await resp.json();msg=j.error||j.motivo||msg;}catch(_){}
    throw new Error(msg);
  }
  const blob=await resp.blob();
  const url=URL.createObjectURL(blob);
  window.open(url,'_blank');
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
// CDC del DE vivo de una orden (staff lee documentos_electronicos por su RLS).
async function fetchCdcDeOrden(orderId){
  try{
    const {data}=await db.from('documentos_electronicos')
      .select('cdc,estado,numero').eq('order_id',orderId)
      .in('estado',['GENERADO','APROBADO','CANCELADO'])
      .order('created_at',{ascending:false}).limit(1);
    return (data&&data[0])||null;
  }catch(_){ return null; }
}

// Bloque de factura fiscal en la tarjeta de un pedido: datos del receptor + acción
// según estado (Emitir / Imprimir KuDE / Enviar por email / Reintentar). No bloquea
// el cobro: la emisión es un paso aparte y reintentable (idempotente por order_id).
function FacturaFiscalCaja({order}){
  const AZUL='#007AFF';
  const [st,setSt]=useState(order.factura_estado||'SOLICITADA');
  const [cdc,setCdc]=useState(null);
  const [busy,setBusy]=useState(false);
  const [motivo,setMotivo]=useState(null);

  // EMITIDA de una sesión previa → recuperar el CDC para poder imprimir/enviar.
  useEffect(()=>{
    let alive=true;
    if(st==='EMITIDA'&&!cdc){ fetchCdcDeOrden(order.id).then(d=>{ if(alive&&d&&d.cdc) setCdc(d.cdc); }); }
    return()=>{alive=false;};
  },[st]); // eslint-disable-line

  const emitir=async(e)=>{
    if(e) e.stopPropagation();
    if(busy) return;
    setBusy(true); setMotivo(null);
    try{
      const r=await apiEmitirFacturaCaja(order.id);
      if(r.ok){ setSt('EMITIDA'); setCdc(r.cdc||null); toast('Factura emitida'); }
      else { setSt('ERROR'); setMotivo(r.motivo||r.error||'No se pudo emitir'); toast('No se pudo emitir la factura',false); }
    }catch(err){ setSt('ERROR'); setMotivo(err.message); toast(err.message,false); }
    finally{ setBusy(false); }
  };
  const imprimir=async(e)=>{ if(e) e.stopPropagation(); if(!cdc) return; try{ await abrirKude(cdc,'ticket'); }catch(err){ toast(err.message,false); } };
  const enviar=async(e)=>{
    if(e) e.stopPropagation();
    if(!cdc||!order.factura_email) return;
    setBusy(true);
    try{ const r=await apiEnviarEmailFactura(cdc,order.factura_email); toast(r.ok?`Factura enviada a ${order.factura_email}`:`No se pudo enviar: ${r.motivo||r.error||''}`,!!r.ok); }
    catch(err){ toast(err.message,false); }
    finally{ setBusy(false); }
  };

  return(
    <div onClick={e=>e.stopPropagation()} style={{marginTop:8,background:AZUL+'0D',border:`1px solid ${AZUL}33`,borderRadius:8,padding:'8px 10px'}}>
      <div style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
        <span style={{display:'inline-flex',alignItems:'center',gap:4,color:AZUL,fontSize:11,fontWeight:800}}><Icon name="receipt" size={11}/> Factura fiscal</span>
        <Badge txt={st==='EMITIDA'?'Emitida':st==='ERROR'?'Error':'Solicitada'} color={st==='EMITIDA'?'#34C759':st==='ERROR'?'#FF3B30':AZUL}/>
        <span style={{fontSize:10,color:C.mid}}>{order.factura_formato==='email'?'por email':'impresa'}</span>
      </div>
      <div style={{fontSize:11,color:C.ink,marginTop:4,lineHeight:1.4}}>
        {order.factura_razon_social||'—'} · <span style={{fontFamily:"'SF Mono',ui-monospace,monospace"}}>{order.factura_ruc_ci||'—'}</span>
        {order.factura_email?<span style={{color:C.mid}}> · {order.factura_email}</span>:null}
      </div>
      {st==='EMITIDA'&&cdc&&<div style={{fontSize:9.5,color:C.mid,marginTop:3,fontFamily:"'SF Mono',ui-monospace,monospace",wordBreak:'break-all'}}>CDC: {cdc}</div>}
      {st==='ERROR'&&motivo&&<div style={{fontSize:10,color:'#FF3B30',marginTop:3}}>{motivo}</div>}
      <div style={{display:'flex',gap:6,marginTop:8,flexWrap:'wrap'}}>
        {st!=='EMITIDA'&&<Btn small variant="primary" disabled={busy} onClick={emitir}>{busy?'Emitiendo…':st==='ERROR'?'Reintentar':'Emitir factura'}</Btn>}
        {st==='EMITIDA'&&<Btn small variant="secondary" disabled={!cdc} onClick={imprimir}>Imprimir KuDE</Btn>}
        {st==='EMITIDA'&&order.factura_formato==='email'&&order.factura_email&&<Btn small variant="secondary" disabled={busy||!cdc} onClick={enviar}>Enviar por email</Btn>}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   PANEL: COBRAR PEDIDOS
═══════════════════════════════════════════ */
function CobrosPanel({turno,profile,movimientos,onMovimiento}){
  const [orders,setOrders]=useState([]);
  const [loading,setLoading]=useState(true);
  const [selected,setSelected]=useState(null);
  const [cobroModal,setCobroModal]=useState(false);
  const [mesaModal,setMesaModal]=useState(null);   // {tableId,tableNumber,orders} — cobro por mesa
  const [searchQ,setSearchQ]=useState('');
  const [deliveryInfoMap,setDeliveryInfoMap]=useState({});
  const [cancelTarget,setCancelTarget]=useState(null);
  const [partialOn,setPartialOn]=useState(true);   // false = migración 128 sin aplicar → modo clásico (sin agrupar por mesa)
  const reloadRef=React.useRef(null);
  // Coalesce ráfagas de eventos realtime (transiciones de status, totales) en un solo reload.
  function scheduleReload(){ clearTimeout(reloadRef.current); reloadRef.current=setTimeout(()=>loadOrders(),350); }

  useEffect(()=>{loadOrders();},[]);
  useEffect(()=>{
    if(!db)return;
    const ch=db.channel('cobros-rt')
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'orders',filter:`restaurant_id=eq.${RID}`},()=>scheduleReload())
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'orders',filter:`restaurant_id=eq.${RID}`},(payload)=>{
        const o=payload.new;
        if(o.status==='cancelled'||o.payment_status==='paid'){
          // Cobrado/cancelado del todo → sacar al instante.
          setOrders(p=>p.filter(x=>x.id!==o.id));
        } else {
          // Cambios parciales (paid_quantity vive en order_items, no llega en este payload):
          // recargamos —debounced— para traer paid_quantity fresco y que dos cajas no cobren lo mismo dos veces.
          scheduleReload();
        }
      })
      .subscribe();
    const onVisible=()=>{if(document.visibilityState==='visible')loadOrders();};
    document.addEventListener('visibilitychange',onVisible);
    return()=>{clearTimeout(reloadRef.current);db.removeChannel(ch);document.removeEventListener('visibilitychange',onVisible);};
  },[]);

  async function loadOrders(){
    setLoading(true);
    const BASE='id,order_number,status,payment_status,total,payment_method,order_type,customer_name,customer_ruc,customer_email,requires_invoice,invoice_delivery_method,invoice_status,created_at,delivered_to_table_at,table_id,tables(number)';
    // PR-FE-4: columnas fiscales (mig 140). Best-effort: si la mig no está aplicada,
    // se reintenta SIN ellas para NO romper caja.
    const FISCAL='factura_solicitada,factura_estado,factura_razon_social,factura_ruc_ci,factura_email,factura_formato';
    const OI_FULL='order_items(id,item_name,quantity,unit_price,total_price,paid_quantity)';
    const OI_CLASSIC='order_items(id,item_name,quantity,unit_price,total_price)';
    const runSel=(oi,withFiscal)=>db.from('orders').select(`${BASE}${withFiscal?','+FISCAL:''},${oi}`)
      .eq('restaurant_id',RID)
      .in('status',['confirmed','paid','pending_payment','kitchen_received','cooking','ready','delivered'])
      .or('payment_status.neq.paid,payment_status.is.null')
      .order('created_at',{ascending:true});
    // total_price incluye extras (precio efectivo por unidad); paid_quantity = pago parcial (mig 128).
    // 1) intento completo (fiscal + paid_quantity).
    let{data,error}=await runSel(OI_FULL,true);
    if(!error){ setPartialOn(true); }
    else {
      // 2) sin columnas fiscales (mig 140 sin aplicar), con paid_quantity.
      const r=await runSel(OI_FULL,false);
      if(!r.error){ data=r.data; error=null; setPartialOn(true); }
      else {
        // 3) clásico: sin fiscal y sin paid_quantity (mig 128 sin aplicar) → cobro entero.
        const r2=await runSel(OI_CLASSIC,false);
        if(!r2.error){ data=(r2.data||[]).map(o=>({...o,order_items:(o.order_items||[]).map(it=>({...it,paid_quantity:it.paid_quantity??0}))})); error=null; setPartialOn(false); }
        else error=r2.error;
      }
    }
    if(!error){
      const orders = data || [];
      setOrders(orders);
      // Cargar info de delivery (rider, dirección, teléfono) para pedidos delivery/llevar
      const deliveryIds = orders.filter(o => o.order_type === 'delivery' || o.order_type === 'llevar').map(o => o.id);
      if(deliveryIds.length > 0){
        const{data:delData}=await db.from('delivery_orders')
          .select('order_id,order_type,customer_name,customer_phone,delivery_address,rider_name,rider_status,delivery_fee,cash_amount')
          .in('order_id',deliveryIds)
          .eq('order_type','delivery');
        const map = {};
        for(const d of (delData||[])) map[d.order_id] = d;
        setDeliveryInfoMap(map);
      } else {
        setDeliveryInfoMap({});
      }
    }
    setLoading(false);
  }

  const q=searchQ.trim().toLowerCase();
  const matchOrder=o=>!q||(o.order_number||'').toLowerCase().includes(q)||(o.customer_name||'').toLowerCase().includes(q)||String(o.tables?.number||'').includes(q);

  // Precio efectivo por unidad = total_price (incluye extras) / quantity; si no hay, unit_price.
  const effUnit=it=>{ const qy=Number(it.quantity)||0, tp=Number(it.total_price)||0; return (tp>0&&qy>0)?Math.round(tp/qy):(Number(it.unit_price)||0); };
  // Pago parcial por ítem: pendiente = quantity − paid_quantity.
  const itemPend=it=>Math.max(0,(Number(it.quantity)||0)-(Number(it.paid_quantity)||0));
  const orderPendCount=o=>(o.order_items||[]).reduce((n,it)=>n+itemPend(it),0);
  const orderSaldo=o=>(o.order_items||[]).reduce((s,it)=>s+itemPend(it)*effUnit(it),0);
  const hasItems=o=>(o.order_items||[]).length>0;

  // Pedidos CON mesa Y con líneas de ítems pendientes → tarjeta de mesa (cobro por ítem).
  // Cae a tarjeta individual (CobroModal por monto total) cuando: no hay mesa; no hay
  // líneas de ítems; o el modo parcial está apagado (migración 128 sin aplicar). Un
  // pedido con ítems 100% pagados pero sin payment_status='paid' (raro) también cae a
  // individual para no perderse. Así NINGÚN pedido pendiente desaparece del panel.
  const isMesaCobrable=o=>partialOn && o.table_id && hasItems(o) && orderPendCount(o)>0;
  // Pedido con ítems 100% pagados pero sin flag 'paid' (raro): YA fue cobrado por ítems
  // (sus movimientos existen). No mostrarlo en individual evita un doble cobro; el barrido
  // de la RPC le pone payment_status='paid' en el próximo cobro de esa mesa.
  const itemsAllPaid=o=>partialOn && o.table_id && hasItems(o) && orderPendCount(o)===0;
  const mesaGroupsMap={};
  orders.filter(isMesaCobrable).forEach(o=>{
    const k=o.table_id;
    if(!mesaGroupsMap[k]) mesaGroupsMap[k]={tableId:k,tableNumber:o.tables?.number??'?',orders:[]};
    mesaGroupsMap[k].orders.push(o);
  });
  const mesaGroups=Object.values(mesaGroupsMap)
    .map(g=>({...g, pendItems:g.orders.reduce((n,o)=>n+orderPendCount(o),0), saldo:g.orders.reduce((s,o)=>s+orderSaldo(o),0)}))
    .filter(g=>g.pendItems>0)
    .filter(g=>!q || String(g.tableNumber).includes(q) || g.orders.some(matchOrder))
    .sort((a,b)=>(Number(a.tableNumber)||0)-(Number(b.tableNumber)||0));
  const soloDisplay=orders.filter(o=>!isMesaCobrable(o)&&!itemsAllPaid(o)).filter(matchOrder);

  function selectOrder(o){setSelected(o);setCobroModal(true);}

  return(
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16,gap:10,flexWrap:'wrap'}}>
        <h1 style={{fontSize:20,fontWeight:800}}>Cobrar pedidos — todos los canales</h1>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <input value={searchQ} onChange={e=>setSearchQ(e.target.value)} placeholder="Buscar pedido, mesa…" style={{padding:'7px 11px',fontSize:13,borderRadius:6,width:200}}/>
          <Btn small variant="secondary" onClick={loadOrders}>↻ Actualizar</Btn>
        </div>
      </div>

      {loading&&<div style={{textAlign:'center',padding:40}}><span className="spin"/></div>}
      {!loading&&mesaGroups.length===0&&soloDisplay.length===0&&(
        <div style={{textAlign:'center',padding:'60px 0',color:C.mid}}>
          <div style={{fontSize:36,marginBottom:12}}>✓</div>
          <div style={{fontSize:14,fontWeight:700,color:C.ink}}>No hay pedidos pendientes de cobro</div>
          <div style={{fontSize:12,color:C.mid,marginTop:6}}>Aparecen aquí pedidos de todos los canales: QR mesa, caja, delivery, para llevar</div>
        </div>
      )}
      {!loading&&(mesaGroups.length>0||soloDisplay.length>0)&&(
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(300px,1fr))',gap:12}}>
          {/* ── Tarjetas de MESA (cobro por mesa + pago parcial por ítem) ── */}
          {mesaGroups.map(g=>{
            const numPedidos=g.orders.length;
            const invoiceReq=g.orders.some(o=>o.requires_invoice&&(o.invoice_status||'pending')==='pending');
            const fiscalOrders=g.orders.filter(o=>o.factura_solicitada);   // PR-FE-4
            // Ítems pendientes agregados (para preview en la tarjeta).
            const lines=g.orders.flatMap(o=>(o.order_items||[]).filter(itemPend).map(it=>({name:it.item_name,pend:itemPend(it)})));
            return(
              <div key={'mesa-'+g.tableId} style={{background:C.surface,border:`2px solid ${C.orange}`,borderRadius:10,padding:16,position:'relative'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
                  <div>
                    <div style={{fontSize:16,fontWeight:800,color:C.ink}}>Mesa {g.tableNumber}</div>
                    <div style={{fontSize:11,color:C.mid,marginTop:3}}>{numPedidos} pedido{numPedidos>1?'s':''} · {g.pendItems} ítem{g.pendItems>1?'s':''} pendiente{g.pendItems>1?'s':''}</div>
                    {invoiceReq&&fiscalOrders.length===0&&(
                      <div style={{display:'inline-flex',alignItems:'center',gap:3,marginTop:6,background:'#007AFF',color:'#fff',fontSize:10,fontWeight:800,padding:'3px 7px',borderRadius:8}}>
                        <Icon name="receipt" size={10} /> Factura solicitada
                      </div>
                    )}
                  </div>
                  <Badge txt="Salón" color={orderTypeColor('dine_in')}/>
                </div>
                {fiscalOrders.map(o=><FacturaFiscalCaja key={o.id} order={o}/>)}
                <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:'8px 10px',marginBottom:10,maxHeight:120,overflowY:'auto'}}>
                  {lines.slice(0,6).map((l,i)=>(
                    <div key={i} style={{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:2,color:C.mid}}>
                      <span>{l.pend}× {l.name}</span>
                    </div>
                  ))}
                  {lines.length>6&&<div style={{fontSize:11,color:C.dim,marginTop:2}}>+{lines.length-6} ítem(s) más…</div>}
                </div>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                  <span style={{fontSize:11,color:C.mid}}>Saldo restante</span>
                  <div style={{fontSize:20,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.green}}>{fmt(g.saldo)}</div>
                </div>
                <Btn full variant="success" onClick={()=>setMesaModal({tableId:g.tableId,tableNumber:g.tableNumber,orders:g.orders})}>
                  Cobrar mesa
                </Btn>
              </div>
            );
          })}

          {/* ── Tarjetas individuales SIN mesa (delivery / llevar / mostrador) ── */}
          {soloDisplay.map(o=>{
            const ORIGEN={local:'Caja — salón',llevar:'Caja — llevar',delivery:'Delivery',dine_in:'QR / Salón',takeaway:'Para llevar',confirmed:'QR mesa'};
            const mesa=o.tables?.number?`Mesa ${o.tables.number}`:o.order_type==='llevar'||o.order_type==='takeaway'?'Para llevar':o.order_type==='delivery'?'Delivery':o.customer_name||'Mostrador';
            const origen=ORIGEN[o.order_type]||o.order_type||'Caja';
            const espera=Math.floor((Date.now()-new Date(o.created_at))/60000);
            const yaCobrado=movimientos.some(m=>m.pedido_id===o.id&&m.tipo==='cobro')||o.payment_status==='paid';
            const sinCobrar=o.payment_status!=='paid';
            const enCocina=['kitchen_received','cooking'].includes(o.status);
            const listo=o.status==='ready'||o.status==='pending_payment';
            const totalReal=Number(o.total)||0;
            const totalItems=(o.order_items||[]).reduce((s,i)=>s+Number(i.quantity||1)*Number(i.unit_price||0),0);
            const displayTotal=totalReal>0?totalReal:totalItems;
            const pmLabel=o.payment_method==='efectivo'?'Efectivo':o.payment_method==='pos'||o.payment_method==='tarjeta'?'POS/Tarjeta':o.payment_method==='qr'?'QR':o.payment_method==='pos_mesa'?'POS Mesa':o.payment_method?o.payment_method:null;
            const borderColor=yaCobrado?C.green:sinCobrar?C.red:listo?C.green:enCocina?C.orange:C.border;
            const orderForModal={...o,total:displayTotal};
            const dInfo=deliveryInfoMap[o.id]||null;
            return(
              <div key={o.id} style={{background:C.surface,border:`2px solid ${borderColor}`,borderRadius:10,padding:16,cursor:yaCobrado?'default':'pointer',opacity:yaCobrado?.7:1,position:'relative'}} onClick={()=>!yaCobrado&&selectOrder(orderForModal)}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
                  <div>
                    <div style={{fontSize:13,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace"}}>#{o.order_number}</div>
                    <div style={{display:'flex',gap:6,alignItems:'center',marginTop:4,flexWrap:'wrap'}}>
                      <Badge txt={orderTypeLabel(o.order_type)} color={orderTypeColor(o.order_type)}/>
                      <span style={{fontSize:12,color:C.ink,fontWeight:600}}>{mesa}</span>
                    </div>
                    {o.requires_invoice&&!o.factura_solicitada&&(o.invoice_status||'pending')==='pending'&&(
                      <div style={{display:'inline-flex',alignItems:'center',gap:3,marginTop:6,background:'#007AFF',color:'#fff',fontSize:10,fontWeight:800,padding:'3px 7px',borderRadius:8}}>
                        <Icon name="receipt" size={10} /> Factura solicitada{o.invoice_delivery_method==='email'?' — email':o.invoice_delivery_method==='print'?' — impresa':''}
                        {o.customer_email?` · ${o.customer_email}`:''}
                      </div>
                    )}
                    <div style={{fontSize:10,color:C.mid,marginTop:2}}>{origen}</div>
                  </div>
                  <Badge txt={SL[o.status]||o.status} color={SC[o.status]||'#6E6E73'}/>
                </div>
                {o.factura_solicitada&&<FacturaFiscalCaja order={o}/>}
                {dInfo&&(
                  <div style={{background:'rgba(255,59,48,0.05)',border:'1px solid rgba(255,59,48,0.15)',borderRadius:7,padding:'7px 10px',marginBottom:8,fontSize:11}}>
                    {(dInfo.customer_name||o.customer_name)&&<div style={{fontWeight:700,color:C.ink,marginBottom:2,display:'flex',alignItems:'center',gap:5}}><Icon name="user" size={11} /> {dInfo.customer_name||o.customer_name}</div>}
                    {dInfo.customer_phone&&<div style={{color:C.mid,marginBottom:1,display:'flex',alignItems:'center',gap:5}}><Icon name="phone" size={11} /> {dInfo.customer_phone}</div>}
                    {dInfo.delivery_address&&<div style={{color:C.mid,marginBottom:1,display:'flex',alignItems:'center',gap:5}}><Icon name="pin" size={11} /> {dInfo.delivery_address}</div>}
                    {dInfo.rider_name
                      ? <div style={{color:dInfo.rider_status==='delivered'?'#FF9500':'#34C759',fontWeight:700,marginTop:2,display:'flex',alignItems:'center',gap:5}}><Icon name="bike" size={11} /> Rider: {dInfo.rider_name}{dInfo.rider_status==='on_way'?' — En camino':dInfo.rider_status==='confirmed'?' — Esperando retiro':dInfo.rider_status==='delivered'?' — Entregado, pdte. cobro':''}</div>
                      : <div style={{color:'#FF9500',fontWeight:600,marginTop:2,display:'flex',alignItems:'center',gap:5}}><Icon name="clock" size={11} /> Sin rider asignado aún</div>
                    }
                  </div>
                )}
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div style={{fontSize:20,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.green}}>{fmt(displayTotal)}</div>
                  <div style={{fontSize:11,color:espera>30?C.red:espera>15?C.orange:'#6E6E73',display:'inline-flex',alignItems:'center',gap:3}}><Icon name="clock" size={11} /> {espera}m</div>
                </div>
                {!yaCobrado?(
                  <div style={{marginTop:12,display:'flex',gap:6,alignItems:'stretch'}}>
                    <Btn small style={{flex:1}} variant={sinCobrar?'danger':listo?'success':'secondary'} onClick={e=>{e.stopPropagation();selectOrder(orderForModal);}}>
                      {listo?'✓ Cobrar':'Cobrar ahora'}
                    </Btn>
                    <button
                      onClick={e=>{e.stopPropagation();setCancelTarget(orderForModal);}}
                      title="Cancelar pedido"
                      style={{padding:'6px 12px',background:'transparent',color:C.red,border:`1px solid ${C.red}55`,borderRadius:6,fontSize:11,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap',letterSpacing:0.2,display:'inline-flex',alignItems:'center',gap:4}}>
                      <Icon name="x" size={12} /> Cancelar
                    </button>
                  </div>
                ):(
                  <div style={{marginTop:12,textAlign:'center',background:C.green+'15',color:C.green,border:`1px solid ${C.green}44`,padding:'6px 8px',fontSize:11,fontWeight:700,borderRadius:6}}>Cobrado ✓{pmLabel?` — ${pmLabel}`:''}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {cobroModal&&selected&&(
        <CobroModal
          order={selected}
          turno={turno}
          profile={profile}
          deliveryInfo={deliveryInfoMap[selected.id]||null}
          onClose={()=>{setCobroModal(false);setSelected(null);}}
          onSuccess={mov=>{
            onMovimiento(mov);
            setOrders(p=>p.filter(o=>o.id!==selected.id));
            setCobroModal(false);setSelected(null);
            toast(`Pedido #${selected.order_number} cobrado ✓`);
          }}
        />
      )}

      {mesaModal&&(
        <CobroMesaModal
          tableId={mesaModal.tableId}
          tableNumber={mesaModal.tableNumber}
          mesaOrders={mesaModal.orders}
          turno={turno}
          profile={profile}
          onClose={()=>setMesaModal(null)}
          onSuccess={(mov,mesaSaldada)=>{
            if(mov) onMovimiento(mov);
            setMesaModal(null);
            loadOrders();
            // Sólo confirmar si hubo cobro real (mov). Si vino vacío (ya cobrado por otra caja),
            // el modal ya mostró su propio aviso — no superponer un toast de éxito contradictorio.
            if(mov) toast(mesaSaldada?`Mesa ${mesaModal.tableNumber} saldada ✓`:`Cobro parcial Mesa ${mesaModal.tableNumber} ✓`);
          }}
        />
      )}

      {cancelTarget&&(
        <QuickCancelModal
          order={cancelTarget}
          turno={turno}
          profile={profile}
          onClose={()=>setCancelTarget(null)}
          onCancelled={(id)=>setOrders(p=>p.filter(o=>o.id!==id))}
        />
      )}
    </div>
  );
}

/* ─── MODAL: COBRO ────────────────────────────── */
/* Toast reutilizable dentro del modal de cobro */
function BancardProximamente({onDismiss}){
  useEffect(()=>{const t=setTimeout(onDismiss,4000);return()=>clearTimeout(t);},[]);
  return(
    <div style={{position:'fixed',bottom:24,left:'50%',transform:'translateX(-50%)',zIndex:9999,
      background:'#1C1C1E',color:'#F5F5F7',borderRadius:14,padding:'14px 20px',
      maxWidth:340,width:'calc(100% - 40px)',boxShadow:'0 8px 32px rgba(0,0,0,0.4)',
      display:'flex',alignItems:'flex-start',gap:12,animation:'slideUp .25s ease'}}>
      <span style={{flexShrink:0,display:'flex'}}><Icon name="building" size={22} /></span>
      <div>
        <div style={{fontWeight:700,fontSize:13,marginBottom:3}}>Módulo Bancard / SIFEN en fase de certificación</div>
        <div style={{fontSize:11,color:'#AEAEB2',lineHeight:1.4}}>Esta pasarela se activará automáticamente al concluir los trámites del comercio.</div>
      </div>
    </div>
  );
}

function CobroModal({order,turno,profile,deliveryInfo,onClose,onSuccess}){
  const [metodo,setMetodo]=useState('efectivo');
  const [montoPagado,setMontoPagado]=useState('0');
  const [comprobante,setComprobante]=useState('');   // Nº comprobante/operación (mig 180)
  const [proofUrl,setProofUrl]=useState('');         // foto del comprobante (mig 182)
  const bankInfo=useBankInfo();
  const requireProof=useRequireProof();              // exigir comprobante en QR (mig 182 · require_proof)
  const [busy,setBusy]=useState(false);
  const [items,setItems]=useState([]);
  const [successTicket,setSuccessTicket]=useState(null);
  const [showBancardToast,setShowBancardToast]=useState(false);
  const [invoiceType,setInvoiceType]=useState(()=>{
    if(!order.requires_invoice) return 'none';
    if(order.customer_ruc||order.customer_email) return 'fiscal';
    return 'ticket';
  });
  const [invName,setInvName]=useState(order.customer_name||'');
  const [invRuc,setInvRuc]=useState(order.customer_ruc||'');
  const [invEmail,setInvEmail]=useState(order.customer_email||'');
  const movDataRef=React.useRef(null);
  // Omni-Gating: pasarelas digitales (Bancard) y SIFEN según plan del comercio
  const _MG=window.MythosGating;
  const hasFeat=k=>!_MG||_MG.hasFeature(k);
  const [lockFeat,setLockFeat]=useState(null);
  const gate=(k,fn)=>()=>hasFeat(k)?fn():setLockFeat(k);

  useEffect(()=>{
    // total_price ya incluye extras/variantes; los nombres de los extras van al
    // ticket como sub-líneas. Sin total_price las líneas impresas no sumaban el
    // TOTAL cuando el pedido traía agregados.
    db.from('order_items').select('id,item_name,quantity,unit_price,total_price,observations,order_item_extras(extra_name)').eq('order_id',order.id)
      .then(({data,error})=>{
        if(!error){setItems(data||[]);return;}
        // Fallback si order_item_extras no está accesible: al menos el precio real.
        db.from('order_items').select('id,item_name,quantity,unit_price,total_price').eq('order_id',order.id)
          .then(({data:d2})=>setItems(d2||[]));
      });
  },[order.id]);

  const montoNum=parseInt(montoPagado)||0;
  // Precio efectivo de la línea: total_price (con extras) o unit_price × cantidad.
  const lineOf=i=>Number(i.total_price)>0?Number(i.total_price):Number(i.quantity||1)*Number(i.unit_price||0);
  // Usar total de items si order.total es 0 (total se graba en DB recién al cobrar)
  const totalReal=React.useMemo(()=>{
    const fromOrder=Number(order.total)||0;
    if(fromOrder>0)return fromOrder;
    return items.reduce((s,i)=>s+lineOf(i),0);
  },[order.total,items]);
  const cambio=metodo==='efectivo'?montoNum-totalReal:0;
  const mesa=order.tables?.number?`Mesa ${order.tables.number}`:order.customer_name||'Sin mesa';
  const BILLETES=[1000,2000,5000,10000,20000,50000,100000];

  async function confirmar(){
    if(metodo==='efectivo'&&montoNum<totalReal){
      toast('El monto recibido es menor al total',false);return;
    }
    if(_faltaComprobante(requireProof,metodo,comprobante,proofUrl)){ toast(_MSG_FALTA_COMP,false);return; }
    setBusy(true);
    try{
      // Solo cambiar status si el pedido aún no llegó a cocina — así kitchen puede continuar independiente.
      // Si está en pending_payment pero el mozo aún no entregó físicamente (delivered_to_table_at null),
      // dejamos status='pending_payment' para que la mesa siga marcada como "retirar" hasta que el mozo
      // confirme entrega. Sólo cerramos a 'delivered' cuando la comida ya está en la mesa.
      const yaEnMesa = !!order.delivered_to_table_at;
      const invoiceFields = {
        requires_invoice: invoiceType !== 'none',
        ...(invoiceType === 'fiscal' && {
          customer_name: invName || order.customer_name || null,
          customer_ruc: invRuc || null,
          customer_email: invEmail || null,
          invoice_delivery_method: invEmail ? 'email' : 'print',
          invoice_requested_at: new Date().toISOString(),
          invoice_status: 'pending',
        }),
        ...(invoiceType === 'ticket' && {
          invoice_delivery_method: 'print',
          invoice_status: 'issued',
        }),
      };
      const cerrarOrden = order.status==='pending_payment' && yaEnMesa;
      const pmOrder = mapOrderPM(metodo);
      // Se persiste con el MISMO criterio con el que `_needsRef` decide mostrar el
      // campo. Antes esta lista estaba escrita a mano y se había quedado sin 'mixto':
      // al cobrar mixto el cajero veía el campo, cargaba el N° de comprobante y se
      // descartaba en silencio — el pago quedaba sin referencia para conciliar.
      const payRef = (_needsRef(metodo) && comprobante.trim()) ? comprobante.trim() : null;
      const orderUpdate = order.status==='confirmed'
        ? {payment_status:'paid', status:'paid', total:totalReal, payment_method:pmOrder, payment_reference:payRef, ...invoiceFields}
        : cerrarOrden
          ? {payment_status:'paid', status:'delivered', completed_at:new Date().toISOString(), total:totalReal, payment_method:pmOrder, payment_reference:payRef, ...invoiceFields}
          : {payment_status:'paid', total:totalReal, payment_method:pmOrder, payment_reference:payRef, ...invoiceFields};
      let{error:e1}=await db.from('orders').update(orderUpdate).eq('id',order.id);
      // Fallback sin invoiceFields si la migración de requires_invoice no está aplicada
      if(e1){
        const fallbackUpdate = order.status==='confirmed'
          ? {payment_status:'paid', status:'paid', total:totalReal, payment_method:pmOrder}
          : cerrarOrden
            ? {payment_status:'paid', status:'delivered', completed_at:new Date().toISOString(), total:totalReal, payment_method:pmOrder}
            : {payment_status:'paid', total:totalReal, payment_method:pmOrder};
        const{error:e1b}=await db.from('orders').update(fallbackUpdate).eq('id',order.id);
        if(e1b)throw e1b;
      }
      // Registrar en historial solo si el pedido pasó a cocina por primera vez
      if(order.status==='confirmed'){
        await db.from('order_status_history').insert({order_id:order.id,status:'paid',changed_by:'caja'});
      }
      const mov={
        turno_id:turno.id,restaurant_id:RID,tipo:'cobro',
        monto:totalReal,metodo_pago:metodo,pedido_id:order.id,
        descripcion:`Cobro pedido #${order.order_number} — ${mesa}`,
        usuario_id:profile.id,usuario_nombre:profile.display_name||profile.username,
        metadata:{orden_numero:order.order_number,mesa,monto_pagado:montoNum||totalReal,cambio:Math.max(0,cambio),transaction_id:null,auth_code:null,raw_response:null},
      };
      const{data:movData,error:e2}=await db.from('movimientos_caja').insert(mov).select().single();
      if(e2)throw e2;
      if(payRef&&movData){ try{ await db.from('movimientos_caja').update({comprobante_nro:payRef}).eq('id',movData.id); }catch(_){} }
      // Foto del comprobante (mig 182): best-effort, no rompe el cobro si la mig no está.
      if(proofUrl){
        try{ await db.from('orders').update({payment_proof_url:proofUrl,payment_review_status:'pending'}).eq('id',order.id); }catch(_){}
        if(movData){ try{ await db.from('movimientos_caja').update({comprobante_url:proofUrl}).eq('id',movData.id); }catch(_){} }
        try{ await recordPaymentReview(db,{restaurantId:RID,orderId:order.id,action:'proof_added'}); }catch(_){}
      }
      // Marcar como atendidas las solicitudes de cobro (waiter_calls) de la mesa
      if(order.table_id){
        try{
          await db.from('waiter_calls')
            .update({status:'attended',attended_at:new Date().toISOString()})
            .eq('restaurant_id',RID).eq('table_id',order.table_id)
            .eq('status','pending').eq('type','payment_request');
        }catch(e){}
      }
      movDataRef.current=movData;
      const ticket={
        orderNumber:order.order_number,
        mesa,
        items,
        total:totalReal,
        metodo,
        cambio:Math.max(0,cambio),
        customerName:order.customer_name||null,
        customerRuc:order.customer_ruc||null,
        cashier:profile.display_name||profile.username,
        createdAt:order.created_at||new Date().toISOString(),
      };
      setSuccessTicket(ticket);
      if(invoiceType==='ticket') printTicket(ticket);
    }catch(e){toast('Error al cobrar: '+e.message,false);}
    setBusy(false);
  }

  function cerrarTrasExito(){
    if(movDataRef.current)onSuccess(movDataRef.current);
  }

  const isDeliveryOrder = order.order_type==='delivery';
  const deliveryFeeNum  = deliveryInfo?.delivery_fee||0;
  const cashAmountNum   = deliveryInfo?.cash_amount||0;
  const cashChangeNum   = cashAmountNum>0 ? cashAmountNum-(totalReal+deliveryFeeNum) : 0;

  if(successTicket){
    const ce=successTicket.contraEntrega;
    return(
      <Modal title={ce?'Pedido enviado a despacho':'Pedido cobrado'} onClose={cerrarTrasExito} width={420}>
        <div style={{textAlign:'center',padding:'20px 0 8px'}}>
          <div style={{fontSize:48,marginBottom:8}}>✓</div>
          <div style={{fontSize:18,fontWeight:800,color:'#34C759',marginBottom:4}}>{ce?'¡Enviado!':'¡Cobrado!'}</div>
          <div style={{fontSize:13,color:C.mid,marginBottom:2}}>Pedido #{successTicket.orderNumber}</div>
          <div style={{fontSize:12,color:C.mid}}>{ce?'El rider cobra al entregar':successTicket.mesa}</div>
        </div>
        <div style={{background:C.bg,borderRadius:10,padding:'12px 14px',marginTop:12,marginBottom:16}}>
          {successTicket.items.map((it,i)=>(
            <div key={i} style={{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:3}}>
              <span>{it.quantity}× {it.item_name}</span>
              <span style={{fontFamily:"'SF Mono',monospace",fontWeight:700}}>{fmt(lineOf(it))}</span>
            </div>
          ))}
          <div style={{display:'flex',justifyContent:'space-between',fontSize:15,fontWeight:800,borderTop:`1px solid ${C.border}`,paddingTop:8,marginTop:6}}>
            <span>TOTAL</span>
            <span style={{fontFamily:"'SF Mono',monospace",color:'#34C759'}}>{fmt(successTicket.total)}</span>
          </div>
          {successTicket.cambio>0&&(
            <div style={{display:'flex',justifyContent:'space-between',fontSize:13,color:C.mid,marginTop:4}}>
              <span>Vuelto</span>
              <span style={{fontFamily:"'SF Mono',monospace",fontWeight:700}}>{fmt(successTicket.cambio)}</span>
            </div>
          )}
        </div>
        <div style={{display:'flex',gap:10}}>
          <Btn full onClick={()=>printTicket(successTicket)} variant="secondary"><Icon name="print" size={14} style={{verticalAlign:'-2px',marginRight:5}}/>Imprimir ticket</Btn>
          <Btn full onClick={cerrarTrasExito} variant="success">Cerrar</Btn>
        </div>
      </Modal>
    );
  }

  return(
    <Modal title={`Cobrar pedido #${order.order_number}`} onClose={onClose} width={480}>
      {/* Info delivery */}
      {isDeliveryOrder&&deliveryInfo&&(
        <div style={{background:'rgba(255,59,48,0.05)',border:'1px solid rgba(255,59,48,0.18)',borderRadius:9,padding:'10px 13px',marginBottom:14,fontSize:12}}>
          {(deliveryInfo.customer_name||order.customer_name)&&<div style={{fontWeight:700,color:C.ink,marginBottom:3,display:'flex',alignItems:'center',gap:5}}><Icon name="user" size={12} /> {deliveryInfo.customer_name||order.customer_name}</div>}
          {deliveryInfo.customer_phone&&<div style={{color:C.mid,marginBottom:2,display:'flex',alignItems:'center',gap:5}}><Icon name="phone" size={12} /> {deliveryInfo.customer_phone}</div>}
          {deliveryInfo.delivery_address&&<div style={{color:C.mid,marginBottom:2,display:'flex',alignItems:'center',gap:5}}><Icon name="pin" size={12} /> {deliveryInfo.delivery_address}</div>}
          {deliveryInfo.rider_name
            ?<div style={{color:deliveryInfo.rider_status==='delivered'?'#FF9500':'#34C759',fontWeight:700,marginTop:3,display:'flex',alignItems:'center',gap:5}}><Icon name="bike" size={12} /> Rider: {deliveryInfo.rider_name}{deliveryInfo.rider_status==='on_way'?' — En camino':deliveryInfo.rider_status==='confirmed'?' — Esperando retiro':deliveryInfo.rider_status==='delivered'?' — Entregado, pdte. cobro':''}</div>
            :<div style={{color:'#FF9500',fontWeight:600,marginTop:3,display:'flex',alignItems:'center',gap:5}}><Icon name="clock" size={12} /> Sin rider asignado</div>
          }
          {cashAmountNum>0&&cashChangeNum>=0&&(
            <div style={{marginTop:6,paddingTop:6,borderTop:'1px solid rgba(255,59,48,0.15)'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <span style={{color:TINT.greenText,fontWeight:700,display:'inline-flex',alignItems:'center',gap:5}}><Icon name="money" size={12} /> Vuelto a llevar</span>
                <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:800,fontSize:15,color:TINT.greenText}}>{fmt(cashChangeNum)}</span>
              </div>
              <div style={{fontSize:10,color:C.mid,marginTop:1}}>Cliente paga {fmt(cashAmountNum)} · total {fmt(totalReal+deliveryFeeNum)}</div>
            </div>
          )}
        </div>
      )}

      {order.requires_invoice&&(order.invoice_status||'pending')==='pending'&&(
        <div style={{background:'rgba(0,122,255,0.08)',border:'1px solid rgba(0,122,255,0.3)',borderRadius:9,padding:'10px 13px',marginBottom:12,fontSize:12,color:TINT.blueText}}>
          <Icon name="receipt" size={13} style={{verticalAlign:'-2px',marginRight:4}}/> <strong>Factura solicitada por el cliente</strong>
          {order.invoice_delivery_method==='email'?' — entregar por email':order.invoice_delivery_method==='print'?' — entregar impresa':''}
          {order.customer_email&&<div style={{fontSize:11,marginTop:2,color:TINT.blueText}}>Email: {order.customer_email}</div>}
          {order.customer_ruc&&<div style={{fontSize:11,marginTop:2,color:TINT.blueText}}>RUC: {order.customer_ruc}</div>}
        </div>
      )}
      <div style={{marginBottom:16}}>
        <div style={{display:'flex',justifyContent:'space-between',marginBottom:8}}>
          <span style={{fontSize:12,color:C.mid}}>{mesa}</span>
          <Badge txt={SL[order.status]} color={SC[order.status]||'#6E6E73'}/>
        </div>
        {items.length>0&&(
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:12,marginBottom:12}}>
            {items.map(it=>(
              <div key={it.id} style={{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:4}}>
                <span>{it.quantity}× {it.item_name}</span>
                <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",color:C.ink,fontWeight:700}}>{fmt(lineOf(it))}</span>
              </div>
            ))}
          </div>
        )}
        {isDeliveryOrder&&deliveryFeeNum>0&&(
          <div style={{display:'flex',justifyContent:'space-between',fontSize:12,color:C.mid,marginBottom:6}}>
            <span>Costo delivery</span>
            <span style={{fontFamily:"'SF Mono',ui-monospace,monospace"}}>{fmt(deliveryFeeNum)}</span>
          </div>
        )}
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 0',borderTop:`1px solid ${C.border}`}}>
          <span style={{fontSize:14,fontWeight:700}}>TOTAL</span>
          <span style={{fontSize:24,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.green}}>{fmt(totalReal)}</span>
        </div>
      </div>

      <div style={{marginBottom:16}}>
        <Lbl required>MÉTODO DE PAGO</Lbl>
        <div className="my-row-2" style={{gap:8}}>
          {METODOS_PAGO.map(m=>(
            <button key={m.id} onClick={()=>setMetodo(m.id)} style={{
              padding:'10px',borderRadius:7,border:`1px solid ${metodo===m.id?C.ink:C.border}`,
              background:metodo===m.id?C.ink:'transparent',
              color:metodo===m.id?C.surface:C.mid,fontSize:12,fontWeight:metodo===m.id?700:400,cursor:'pointer',
            }}>{m.lbl}</button>
          ))}
        </div>
        <PagoRefTransfer metodo={metodo} comprobante={comprobante} setComprobante={setComprobante} bankInfo={bankInfo} proofUrl={proofUrl} setProofUrl={setProofUrl}/>
      </div>

      {metodo==='efectivo'&&(
        <div style={{marginBottom:16}}>
          {/* Billetes rápidos */}
          <Lbl>BILLETES RECIBIDOS</Lbl>
          <div className="my-grid" style={{'--my-col':'62px',gap:5,marginBottom:8}}>
            {BILLETES.map(v=>(
              <button key={v} onClick={()=>setMontoPagado(String(montoNum+v))} style={{
                padding:'9px 4px',borderRadius:6,border:`1px solid ${C.border}`,
                background:C.card,color:C.white,fontSize:12,fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:700,cursor:'pointer',
                transition:'border-color .1s',
              }}
                onMouseEnter={e=>e.currentTarget.style.borderColor='#86868B'}
                onMouseLeave={e=>e.currentTarget.style.borderColor=C.border}
              >{v>=1000?`${v/1000}k`:v}</button>
            ))}
            <button onClick={()=>setMontoPagado(String(totalReal))} style={{
              padding:'9px 4px',borderRadius:6,border:`1px solid ${C.blue}55`,
              background:`rgba(59,130,246,0.1)`,color:C.blue,fontSize:11,fontWeight:700,cursor:'pointer',
            }}>Exacto</button>
          </div>
          <div style={{display:'flex',gap:6,alignItems:'center',marginBottom:8}}>
            <div style={{flex:1}}>
              <Lbl required>MONTO RECIBIDO (₲)</Lbl>
              <Inp gs mono value={montoPagado} onChange={setMontoPagado} placeholder={formatGs(totalReal)}/>
            </div>
            <button onClick={()=>setMontoPagado('0')} title="Limpiar" style={{marginTop:18,padding:'9px 10px',borderRadius:6,border:`1px solid ${C.border}`,background:'transparent',color:C.dim,fontSize:13,cursor:'pointer'}}>✕</button>
          </div>
          {/* Vuelto */}
          {montoNum>0&&(
            cambio>=0?(
              <div style={{padding:'14px 16px',background:'rgba(34,197,94,0.08)',border:`1px solid rgba(34,197,94,0.3)`,borderRadius:8}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <span style={{fontSize:13,color:TINT.greenText,fontWeight:700}}>Vuelto a devolver</span>
                  <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:26,fontWeight:800,color:cambio>0?C.green:'#6E6E73'}}>{cambio>0?fmt(cambio):'Sin vuelto'}</span>
                </div>
                {cambio>0&&<div style={{fontSize:11,color:C.mid,marginTop:4}}>Recibido {fmt(montoNum)} − Total {fmt(totalReal)}</div>}
              </div>
            ):(
              <div style={{padding:'10px 14px',background:'rgba(239,68,68,0.08)',border:`1px solid rgba(239,68,68,0.3)`,borderRadius:7}}>
                <span style={{fontSize:13,color:C.red,fontWeight:700}}>Insuficiente — faltan {fmt(totalReal-montoNum)}</span>
              </div>
            )
          )}
        </div>
      )}

      {/* Factura Electrónica (SIFEN) — oculto hasta certificación e-Kuatia (2026-07-18) */}

      {/* Comprobante */}
      <div style={{marginBottom:16}}>
        <Lbl>COMPROBANTE</Lbl>
        <div className="my-row-3" style={{gap:6,marginBottom:invoiceType!=='none'?10:0}}>
          {[['none','Sin comprobante'],['ticket','Ticket impreso'],['fiscal','Factura fiscal']].map(([v,lbl])=>(
            <button key={v} onClick={v==='fiscal'?gate('caja:sifen',()=>setInvoiceType('fiscal')):()=>setInvoiceType(v)} style={{
              padding:'9px 4px',borderRadius:7,border:`1px solid ${invoiceType===v?C.ink:C.border}`,
              background:invoiceType===v?C.ink:'transparent',
              color:invoiceType===v?C.sidebar:C.mid,fontSize:11,fontWeight:700,cursor:'pointer',lineHeight:1.3,
            }}>{lbl}</button>
          ))}
        </div>
        {invoiceType==='ticket'&&(
          <div style={{padding:'8px 12px',background:'rgba(52,199,89,0.08)',border:'1px solid rgba(52,199,89,0.3)',borderRadius:7,fontSize:12,color:TINT.greenText}}>
            <Icon name="print" size={13} style={{verticalAlign:'-2px',marginRight:4}}/> El ticket se imprimirá automáticamente al cobrar.
          </div>
        )}
        {invoiceType==='fiscal'&&(
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            <Inp value={invName} onChange={e=>setInvName(e.target.value)} placeholder="Nombre / razón social"/>
            <Inp value={invRuc} onChange={e=>setInvRuc(e.target.value)} placeholder="RUC / Cédula"/>
            <Inp type="email" value={invEmail} onChange={e=>setInvEmail(e.target.value)} placeholder="Email para factura electrónica"/>
            <div style={{fontSize:11,color:C.mid}}>La e-Kuatia (SIFEN) estará disponible próximamente.</div>
          </div>
        )}
      </div>

      {/* Promo "Factura Electrónica SIFEN — Activar" retirada — no funcional aún (2026-07-18) */}

      <div style={{display:'flex',gap:10}}>
        <Btn full onClick={confirmar} disabled={busy} variant="success">
          {busy?<><span className="spin"/> Procesando…</>:'✓ Confirmar cobro'}
        </Btn>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
      </div>
      {showBancardToast&&<BancardProximamente onDismiss={()=>setShowBancardToast(false)}/>}
      {lockFeat&&_MG&&<_MG.FeatureLock featureKey={lockFeat} onClose={()=>setLockFeat(null)}/>}
    </Modal>
  );
}

/* ─── MODAL: COBRO POR MESA (pago parcial por ítem) ─── */
function CobroMesaModal({tableId,tableNumber,mesaOrders,turno,profile,onClose,onSuccess}){
  // Líneas cobrables: por cada pedido de la mesa, cada ítem con pendiente>0.
  // Precio efectivo por unidad = total_price (incluye extras) / quantity; si no, unit_price.
  const effUnit=it=>{ const qy=Number(it.quantity)||0, tp=Number(it.total_price)||0; return (tp>0&&qy>0)?Math.round(tp/qy):(Number(it.unit_price)||0); };
  const buildLines=(ords)=>(ords||[]).flatMap(o=>(o.order_items||[]).map(it=>({
    orderId:o.id, orderNumber:o.order_number, status:o.status, requiresInvoice:!!o.requires_invoice,
    deliveredAt:o.delivered_to_table_at, invoiceDeliveryMethod:o.invoice_delivery_method,
    itemId:it.id, itemName:it.item_name, unitPrice:effUnit(it),
    quantity:Number(it.quantity)||0, paid:Number(it.paid_quantity)||0,
    pend:Math.max(0,(Number(it.quantity)||0)-(Number(it.paid_quantity)||0)),
  })).filter(l=>l.pend>0));
  const lines=React.useMemo(()=>buildLines(mesaOrders),[mesaOrders]);

  const [sel,setSel]=useState(()=>{const m={};buildLines(mesaOrders).forEach(l=>{m[l.itemId]={checked:true,qty:l.pend};});return m;});
  const [metodo,setMetodo]=useState('efectivo');
  const [montoPagado,setMontoPagado]=useState('0');
  const [busy,setBusy]=useState(false);
  const [successTicket,setSuccessTicket]=useState(null);
  const successRef=React.useRef(null);
  const BILLETES=[1000,2000,5000,10000,20000,50000,100000];
  const [comprobante,setComprobante]=useState('');   // Nº comprobante/operación (mig 180)
  const [proofUrl,setProofUrl]=useState('');         // foto del comprobante (mig 182)
  const bankInfo=useBankInfo();
  const requireProof=useRequireProof();              // exigir comprobante en QR (mig 182 · require_proof)

  const selectedLines=lines.filter(l=>sel[l.itemId]?.checked&&(sel[l.itemId]?.qty||0)>0);
  const subtotal=selectedLines.reduce((s,l)=>s+Math.min(sel[l.itemId].qty,l.pend)*l.unitPrice,0);
  const totalMesa=lines.reduce((s,l)=>s+l.pend*l.unitPrice,0);
  const montoNum=parseInt(montoPagado)||0;
  const cambio=metodo==='efectivo'?montoNum-subtotal:0;

  function toggle(l){setSel(s=>({...s,[l.itemId]:{checked:!s[l.itemId]?.checked,qty:s[l.itemId]?.qty||l.pend}}));}
  function setQty(l,v){const q=Math.max(1,Math.min(l.pend,parseInt(v)||1));setSel(s=>({...s,[l.itemId]:{checked:true,qty:q}}));}
  function selectAll(on){setSel(()=>{const m={};lines.forEach(l=>{m[l.itemId]={checked:on,qty:l.pend};});return m;});}

  async function cobrar(cobrarTodo){
    let toCharge=cobrarTodo
      ? lines.map(l=>({l,qty:l.pend}))
      : selectedLines.map(l=>({l,qty:Math.min(sel[l.itemId].qty,l.pend)}));
    toCharge=toCharge.filter(x=>x.qty>0);
    if(toCharge.length===0){toast('Seleccioná al menos un ítem',false);return;}
    const subt=toCharge.reduce((s,x)=>s+x.qty*x.l.unitPrice,0);
    if(metodo==='efectivo'&&montoNum>0&&montoNum<subt){toast('El monto recibido es menor al total',false);return;}
    if(_faltaComprobante(requireProof,metodo,comprobante,proofUrl)){ toast(_MSG_FALTA_COMP,false);return; }
    setBusy(true);
    try{
      // Todo el cobro ocurre ATÓMICAMENTE en la RPC (bloqueo de fila anti-doble-cobro,
      // saldado de pedidos, movimiento y waiter_calls en UNA transacción — la caja no
      // queda a medias ni descuadrada). Dinero por unidad con extras lo calcula el server.
      const{data,error}=await db.rpc('cobro_mesa_parcial',{
        p_restaurant_id:RID, p_turno_id:turno.id, p_table_id:tableId,
        p_items:toCharge.map(x=>({item_id:x.l.itemId, qty:x.qty})),
        p_metodo:metodo, p_monto_pagado:montoNum||null,
      });
      if(error)throw error;
      const res=data||{};
      const applied=res.applied||[];
      if(!applied.length){toast('Estos ítems ya fueron cobrados por otra caja. Actualizá la lista.',false);setBusy(false);onSuccess(null,false);return;}
      const subReal=Number(res.sub)||0;
      const mesaSaldada=!!res.mesa_saldada;
      const compRef=(['tarjeta_credito','tarjeta_debito','qr'].includes(metodo)&&comprobante.trim())?comprobante.trim():null;
      if(compRef&&res.movimiento_id){ try{ await db.from('movimientos_caja').update({comprobante_nro:compRef}).eq('id',res.movimiento_id); }catch(_){} }
      // Foto del comprobante (mig 182) — cobro parcial por ítems: se guarda en el ledger de caja.
      if(proofUrl&&res.movimiento_id){ try{ await db.from('movimientos_caja').update({comprobante_url:proofUrl}).eq('id',res.movimiento_id); }catch(_){} }
      const ticket={
        orderNumber:null, mesa:`Mesa ${tableNumber}`, partial:!mesaSaldada,
        items:applied.map(a=>({item_name:a.nombre,quantity:a.cantidad,unit_price:a.precio})),
        total:subReal, metodo, cambio:Math.max(0,montoNum-subReal),
        cashier:profile.display_name||profile.username, createdAt:new Date().toISOString(),
      };
      printTicket(ticket);
      successRef.current={
        mov:{id:res.movimiento_id,tipo:'cobro',monto:subReal,metodo_pago:metodo,pedido_id:null,
             usuario_nombre:profile.display_name||profile.username,created_at:new Date().toISOString()},
        mesaSaldada,
      };
      setSuccessTicket(ticket);
    }catch(e){
      const m=`${e?.message||''} ${e?.code||''}`;
      if(/cobro_mesa_parcial|PGRST202|42883|schema cache|does not exist/i.test(m)){
        toast('Falta aplicar la migración 128 para el cobro por mesa. Usá el cobro individual por ahora.',false);
      } else { toast('Error al cobrar: '+(e?.message||'desconocido'),false); }
    }
    setBusy(false);
  }

  function cerrarTrasExito(){const r=successRef.current;onSuccess(r?.mov||null,!!r?.mesaSaldada);}

  if(successTicket){
    return(
      <Modal title="Cobro registrado" onClose={cerrarTrasExito} width={420}>
        <div style={{textAlign:'center',padding:'20px 0 8px'}}>
          <div style={{fontSize:48,marginBottom:8}}>✓</div>
          <div style={{fontSize:18,fontWeight:800,color:'#34C759',marginBottom:4}}>{successRef.current?.mesaSaldada?'¡Mesa saldada!':'Cobro parcial registrado'}</div>
          <div style={{fontSize:13,color:C.mid}}>Mesa {tableNumber}</div>
        </div>
        <div style={{background:C.bg,borderRadius:10,padding:'12px 14px',marginTop:12,marginBottom:16}}>
          {successTicket.items.map((it,i)=>(
            <div key={i} style={{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:3}}>
              <span>{it.quantity}× {it.item_name}</span>
              <span style={{fontFamily:"'SF Mono',monospace",fontWeight:700}}>{fmt((it.unit_price||0)*it.quantity)}</span>
            </div>
          ))}
          <div style={{display:'flex',justifyContent:'space-between',fontSize:15,fontWeight:800,borderTop:`1px solid ${C.border}`,paddingTop:8,marginTop:6}}>
            <span>COBRADO</span>
            <span style={{fontFamily:"'SF Mono',monospace",color:'#34C759'}}>{fmt(successTicket.total)}</span>
          </div>
          {successTicket.cambio>0&&(
            <div style={{display:'flex',justifyContent:'space-between',fontSize:13,color:C.mid,marginTop:4}}>
              <span>Vuelto</span><span style={{fontFamily:"'SF Mono',monospace",fontWeight:700}}>{fmt(successTicket.cambio)}</span>
            </div>
          )}
        </div>
        <div style={{display:'flex',gap:10}}>
          <Btn full onClick={()=>printTicket(successTicket)} variant="secondary"><Icon name="print" size={14} style={{verticalAlign:'-2px',marginRight:5}}/>Reimprimir</Btn>
          <Btn full onClick={cerrarTrasExito} variant="success">Cerrar</Btn>
        </div>
      </Modal>
    );
  }

  return(
    <Modal title={`Cobrar — Mesa ${tableNumber}`} onClose={onClose} width={520}>
      {lines.length===0?(
        <div style={{padding:'24px 0',textAlign:'center',color:C.mid}}>No hay ítems pendientes en esta mesa.</div>
      ):(<>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
          <span style={{fontSize:12,color:C.mid}}>{lines.length} ítem(s) pendiente(s) · saldo {fmt(totalMesa)}</span>
          <div style={{display:'flex',gap:6}}>
            <button onClick={()=>selectAll(true)} style={{padding:'4px 10px',fontSize:11,borderRadius:5,border:`1px solid ${C.border}`,background:'transparent',color:C.mid,cursor:'pointer'}}>Todos</button>
            <button onClick={()=>selectAll(false)} style={{padding:'4px 10px',fontSize:11,borderRadius:5,border:`1px solid ${C.border}`,background:'transparent',color:C.mid,cursor:'pointer'}}>Ninguno</button>
          </div>
        </div>
        <div style={{border:`1px solid ${C.border}`,borderRadius:8,maxHeight:280,overflowY:'auto',marginBottom:14}}>
          {lines.map(l=>{
            const s=sel[l.itemId]||{checked:false,qty:l.pend};
            return(
              <div key={l.itemId} style={{display:'flex',alignItems:'center',gap:10,padding:'9px 12px',borderBottom:`1px solid ${C.border}`,background:s.checked?'rgba(52,199,89,0.05)':'transparent'}}>
                <input type="checkbox" checked={!!s.checked} onChange={()=>toggle(l)} style={{width:17,height:17,cursor:'pointer',flexShrink:0}}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:600,color:C.ink,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{l.itemName}</div>
                  <div style={{fontSize:11,color:C.mid}}>#{l.orderNumber} · {fmt(l.unitPrice)} c/u · pendiente {l.pend}{l.paid>0?` (de ${l.quantity})`:''}</div>
                </div>
                {l.pend>1&&(
                  <div style={{display:'flex',alignItems:'center',gap:4,flexShrink:0}}>
                    <button onClick={()=>setQty(l,(s.qty||1)-1)} disabled={!s.checked} style={{width:24,height:24,borderRadius:5,border:`1px solid ${C.border}`,background:'transparent',color:C.mid,cursor:'pointer',fontSize:14}}>−</button>
                    <span style={{minWidth:18,textAlign:'center',fontSize:13,fontWeight:700,color:C.ink}}>{s.checked?s.qty:0}</span>
                    <button onClick={()=>setQty(l,(s.qty||0)+1)} disabled={!s.checked} style={{width:24,height:24,borderRadius:5,border:`1px solid ${C.border}`,background:'transparent',color:C.mid,cursor:'pointer',fontSize:14}}>+</button>
                  </div>
                )}
                <div style={{width:84,textAlign:'right',fontSize:13,fontWeight:700,fontFamily:"'SF Mono',ui-monospace,monospace",color:s.checked?C.ink:C.dim,flexShrink:0}}>{fmt((s.checked?Math.min(s.qty,l.pend):0)*l.unitPrice)}</div>
              </div>
            );
          })}
        </div>

        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderTop:`1px solid ${C.border}`,marginBottom:14}}>
          <span style={{fontSize:14,fontWeight:700}}>SELECCIONADO</span>
          <span style={{fontSize:24,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.green}}>{fmt(subtotal)}</span>
        </div>

        <div style={{marginBottom:14}}>
          <Lbl required>MÉTODO DE PAGO</Lbl>
          <div className="my-row-2" style={{gap:8}}>
            {/* 'mixto' excluido: sin desglose efectivo/tarjeta rompería el arqueo ciego. */}
            {METODOS_PAGO.filter(m=>m.id!=='mixto').map(m=>(
              <button key={m.id} onClick={()=>setMetodo(m.id)} style={{padding:'10px',borderRadius:7,border:`1px solid ${metodo===m.id?C.ink:C.border}`,background:metodo===m.id?C.ink:'transparent',color:metodo===m.id?C.surface:C.mid,fontSize:12,fontWeight:metodo===m.id?700:400,cursor:'pointer'}}>{m.lbl}</button>
            ))}
          </div>
        </div>

        <PagoRefTransfer metodo={metodo} comprobante={comprobante} setComprobante={setComprobante} bankInfo={bankInfo} proofUrl={proofUrl} setProofUrl={setProofUrl}/>

        {metodo==='efectivo'&&(
          <div style={{marginBottom:14}}>
            <Lbl>BILLETES RECIBIDOS</Lbl>
            <div className="my-grid" style={{'--my-col':'62px',gap:5,marginBottom:8}}>
              {BILLETES.map(v=>(<button key={v} onClick={()=>setMontoPagado(String(montoNum+v))} style={{padding:'9px 4px',borderRadius:6,border:`1px solid ${C.border}`,background:C.card,color:C.white,fontSize:12,fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:700,cursor:'pointer'}}>{v>=1000?`${v/1000}k`:v}</button>))}
              <button onClick={()=>setMontoPagado(String(subtotal))} style={{padding:'9px 4px',borderRadius:6,border:`1px solid ${C.blue}55`,background:`rgba(59,130,246,0.1)`,color:C.blue,fontSize:11,fontWeight:700,cursor:'pointer'}}>Exacto</button>
            </div>
            <div style={{display:'flex',gap:6,alignItems:'flex-end'}}>
              <div style={{flex:1}}><Lbl>MONTO RECIBIDO (₲)</Lbl><Inp gs mono value={montoPagado} onChange={setMontoPagado} placeholder={formatGs(subtotal)}/></div>
              <button onClick={()=>setMontoPagado('0')} title="Limpiar" style={{padding:'9px 10px',borderRadius:6,border:`1px solid ${C.border}`,background:'transparent',color:C.dim,fontSize:13,cursor:'pointer'}}>✕</button>
            </div>
            {montoNum>0&&(cambio>=0?(
              <div style={{marginTop:8,padding:'10px 14px',background:'rgba(34,197,94,0.08)',border:`1px solid rgba(34,197,94,0.3)`,borderRadius:8,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <span style={{fontSize:13,color:TINT.greenText,fontWeight:700}}>Vuelto</span>
                <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:22,fontWeight:800,color:cambio>0?C.green:'#6E6E73'}}>{cambio>0?fmt(cambio):'Sin vuelto'}</span>
              </div>
            ):(
              <div style={{marginTop:8,padding:'10px 14px',background:'rgba(239,68,68,0.08)',border:`1px solid rgba(239,68,68,0.3)`,borderRadius:7}}>
                <span style={{fontSize:13,color:C.red,fontWeight:700}}>Insuficiente — faltan {fmt(subtotal-montoNum)}</span>
              </div>
            ))}
          </div>
        )}

        <div style={{display:'flex',gap:10}}>
          <Btn full variant="success" onClick={()=>cobrar(false)} disabled={busy||selectedLines.length===0}>
            {busy?<><span className="spin"/> Procesando…</>:'✓ Cobrar seleccionados'}
          </Btn>
          <Btn full onClick={()=>cobrar(true)} disabled={busy}>Cobrar toda la mesa</Btn>
        </div>
        <div style={{marginTop:8,textAlign:'center'}}>
          <button onClick={onClose} style={{background:'transparent',border:'none',color:C.mid,fontSize:12,cursor:'pointer'}}>Cancelar</button>
        </div>
      </>)}
    </Modal>
  );
}

/* ═══════════════════════════════════════════
   MODAL: AUTORIZACIÓN POR PIN (admin/gerente)
   Cierre solo con ESC o botón X (NUNCA por overlay-click → evita
   pérdida de datos al seleccionar texto).
═══════════════════════════════════════════ */
function PinAuthModal({title,subtitle,onCancel,onAuthorized,verifying=false}){
  const [pin,setPin]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const inputRef=useRef(null);

  useEffect(()=>{
    const fn=e=>e.key==='Escape'&&!busy&&onCancel();
    window.addEventListener('keydown',fn);
    setTimeout(()=>{inputRef.current&&inputRef.current.focus();},50);
    return()=>window.removeEventListener('keydown',fn);
  },[busy,onCancel]);

  async function submit(){
    if(busy)return;
    if(!/^\d{4}$/.test(pin)){setError('El PIN debe tener 4 dígitos.');return;}
    setBusy(true);setError('');
    try{
      const{data,error:e}=await db.from('user_profiles')
        .select('id,full_name,role,restaurant_id,pin')
        .eq('restaurant_id',RID)
        .eq('pin',pin)
        .in('role',['admin','gerente','superadmin'])
        .limit(1);
      if(e)throw e;
      const auth=(data||[])[0];
      if(!auth){
        setError('PIN Incorrecto o Sin Permisos.');
        setPin('');
        setBusy(false);
        return;
      }
      await onAuthorized(auth);
    }catch(err){
      setError('PIN Incorrecto o Sin Permisos.');
      setPin('');
      setBusy(false);
    }
  }

  return(
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.86)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1100,padding:20,backdropFilter:'blur(4px)'}}>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:28,width:'100%',maxWidth:420,boxShadow:'0 24px 60px rgba(0,0,0,0.45)',animation:'slideUp 200ms ease'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18}}>
          <div style={{fontFamily:'DM Serif Display',fontSize:20,color:C.ink,display:'flex',alignItems:'center',gap:8}}><Icon name="lock" size={18} /> {title||'Autorización Requerida'}</div>
          <button onClick={()=>!busy&&onCancel()} disabled={busy} style={{background:'none',border:'none',color:C.ink,fontSize:24,lineHeight:1,padding:0,cursor:busy?'default':'pointer',opacity:busy?0.4:1}} aria-label="Cerrar">×</button>
        </div>
        <div style={{fontSize:13,color:C.mid,lineHeight:1.5,marginBottom:18}}>
          {subtitle||'Ingresá el PIN de un Administrador o Gerente para confirmar la cancelación de este pedido.'}
        </div>
        <div style={{marginBottom:14}}>
          <div style={{fontSize:10,color:'#6E6E73',fontWeight:700,letterSpacing:1,marginBottom:6}}>PIN (4 DÍGITOS)</div>
          <input
            ref={inputRef}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            disabled={busy||verifying}
            onChange={e=>{
              const v=e.target.value.replace(/\D/g,'').slice(0,4);
              setPin(v);
              if(error)setError('');
            }}
            onKeyDown={e=>{if(e.key==='Enter'&&pin.length===4)submit();}}
            placeholder="••••"
            maxLength={4}
            style={{width:'100%',padding:'14px 16px',fontSize:26,fontWeight:800,letterSpacing:12,textAlign:'center',fontFamily:"'SF Mono',ui-monospace,monospace",background:'var(--bg-subtle)',border:`1.5px solid ${error?C.red:C.border}`,borderRadius:10,color:C.ink,outline:'none'}}
          />
        </div>
        {error&&(
          <div style={{background:C.ink,color:C.surface,padding:'10px 14px',borderRadius:8,fontSize:12,fontWeight:600,marginBottom:14,textAlign:'center',letterSpacing:0.3}}>
            {error}
          </div>
        )}
        <div style={{display:'flex',gap:8}}>
          <button onClick={()=>!busy&&onCancel()} disabled={busy} style={{flex:1,padding:'12px 16px',background:'transparent',color:C.ink,border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontWeight:600,cursor:busy?'default':'pointer',opacity:busy?0.5:1}}>
            Cancelar
          </button>
          <button onClick={submit} disabled={busy||pin.length!==4} style={{flex:1.2,padding:'12px 16px',background:C.ink,color:C.surface,border:`1px solid ${C.ink}`,borderRadius:8,fontSize:13,fontWeight:700,cursor:(busy||pin.length!==4)?'default':'pointer',opacity:(busy||pin.length!==4)?0.55:1}}>
            {busy?'Verificando…':verifying?'Procesando…':'Autorizar'}
          </button>
        </div>
        <div style={{marginTop:14,fontSize:11,color:'#86868B',textAlign:'center'}}>
          La autorización queda registrada con el ID del usuario que aprueba.
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   MODAL: CANCELACIÓN RÁPIDA desde tarjetas
   Reutiliza el mismo flujo que CancelacionesPanel: motivo →
   (PIN si el rol no es admin/gerente/superadmin) → insert en
   cancelaciones_caja con auth_supervisor en items_cancelados (audit trail).
   Cierre solo con ESC o ×, nunca por overlay-click.
═══════════════════════════════════════════ */
function QuickCancelModal({order,turno,profile,onClose,onCancelled}){
  const [motivo,setMotivo]=useState('');
  const [descripcion,setDescripcion]=useState('');
  const [perdida,setPerdida]=useState(false);
  const [busy,setBusy]=useState(false);
  const [pinOpen,setPinOpen]=useState(false);

  const ROLES_SIN_PIN=['admin','gerente','superadmin'];
  const requierePin=!ROLES_SIN_PIN.includes((profile?.role||'').toLowerCase());

  useEffect(()=>{
    const fn=e=>{if(e.key==='Escape'&&!busy&&!pinOpen)onClose();};
    window.addEventListener('keydown',fn);
    return()=>window.removeEventListener('keydown',fn);
  },[busy,pinOpen,onClose]);

  function intentarCancelar(){
    if(!motivo){toast('Seleccioná un motivo',false);return;}
    if(motivo==='Otro'&&!descripcion.trim()){toast('Descripción obligatoria para "Otro"',false);return;}
    if(requierePin){setPinOpen(true);return;}
    ejecutarCancelacion(null);
  }

  async function ejecutarCancelacion(supervisor){
    if(!turno){toast('No hay turno de caja activo',false);return;}
    setBusy(true);
    try{
      const{error:e1}=await db.from('orders').update({status:'cancelled'}).eq('id',order.id);
      if(e1)throw e1;
      const descripcionFinal=supervisor
        ?`${descripcion||''}${descripcion?' · ':''}Autorizado por ${supervisor.full_name} (${supervisor.role}) — ID ${supervisor.id}`
        :(descripcion||null);
      const auditPayload=supervisor?[{
        auth_supervisor:{
          id:supervisor.id,
          full_name:supervisor.full_name,
          role:supervisor.role,
          at:new Date().toISOString(),
        }
      }]:[];
      const{error:e2}=await db.from('cancelaciones_caja').insert({
        turno_id:turno.id,restaurant_id:RID,pedido_id:order.id,
        pedido_numero:order.order_number,tipo:'total',
        items_cancelados:auditPayload,monto_cancelado:Number(order.total)||0,
        motivo,descripcion:descripcionFinal,
        estado_pedido_cancelar:order.status,perdida_insumos:perdida,
        usuario_id:profile.id,usuario_nombre:profile.display_name||profile.username,
      });
      if(e2)throw e2;
      const sufijo=supervisor?` (autorizado por ${supervisor.full_name})`:'';
      toast(`Pedido #${order.order_number} cancelado${sufijo}`);
      setPinOpen(false);
      onCancelled?.(order.id);
      onClose();
    }catch(e){toast('Error: '+e.message,false);setBusy(false);}
  }

  const mesa=order.tables?.number?`Mesa ${order.tables.number}`:(order.customer_name||'Sin mesa');

  return(
    <>
      <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.86)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1050,padding:20,backdropFilter:'blur(4px)'}}>
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:24,width:'100%',maxWidth:440,boxShadow:'0 24px 60px rgba(0,0,0,0.45)',animation:'slideUp 200ms ease',color:C.ink}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
            <div style={{fontFamily:'DM Serif Display',fontSize:18,color:C.ink,display:'flex',alignItems:'center',gap:8}}><Icon name="x" size={17} /> Cancelar pedido</div>
            <button onClick={()=>!busy&&onClose()} disabled={busy} style={{background:'none',border:'none',color:C.ink,fontSize:24,lineHeight:1,padding:0,cursor:busy?'default':'pointer',opacity:busy?0.4:1}} aria-label="Cerrar">×</button>
          </div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14,padding:'10px 14px',background:'var(--bg-subtle)',border:`1px solid ${C.border}`,borderRadius:8}}>
            <div>
              <div style={{fontSize:14,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.ink}}>#{order.order_number}</div>
              <div style={{fontSize:12,color:C.mid,marginTop:2,fontWeight:600}}>{mesa}</div>
            </div>
            <div style={{fontSize:16,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.red}}>{fmt(Number(order.total)||0)}</div>
          </div>
          {requierePin&&(
            <div style={{background:C.ink,color:C.surface,padding:'10px 14px',borderRadius:8,fontSize:12,fontWeight:600,marginBottom:14,letterSpacing:0.2}}>
              <Icon name="lock" size={13} style={{verticalAlign:'-2px',marginRight:4}}/> Esta acción requerirá el PIN de un Administrador o Gerente al continuar.
            </div>
          )}
          <div style={{marginBottom:12}}>
            <div style={{fontSize:10,color:'#6E6E73',fontWeight:700,letterSpacing:1,marginBottom:6}}>MOTIVO DE LA CANCELACIÓN <span style={{color:C.red}}>*</span></div>
            <select value={motivo} onChange={e=>setMotivo(e.target.value)} disabled={busy} style={{width:'100%',padding:'10px 12px',fontSize:14,background:C.surface,border:`1.5px solid ${C.border}`,borderRadius:8,color:C.ink,outline:'none'}}>
              <option value="">Seleccionar…</option>
              {MOTIVOS_CANCEL.map(m=><option key={m}>{m}</option>)}
            </select>
          </div>
          {motivo&&(
            <div style={{marginBottom:14}}>
              <div style={{fontSize:10,color:'#6E6E73',fontWeight:700,letterSpacing:1,marginBottom:6}}>DETALLE {motivo==='Otro'?<span style={{color:C.red}}>*</span>:'(opcional)'}</div>
              <textarea value={descripcion} onChange={e=>setDescripcion(e.target.value)} disabled={busy} placeholder="Notas adicionales para auditoría…" rows={2} style={{width:'100%',padding:'10px 12px',fontSize:13,background:C.surface,border:`1.5px solid ${C.border}`,borderRadius:8,color:C.ink,outline:'none',resize:'vertical',fontFamily:'inherit'}}/>
            </div>
          )}
          <div style={{marginBottom:18,display:'flex',alignItems:'center',gap:8}}>
            <input type="checkbox" id="qc-perdida" checked={perdida} onChange={e=>setPerdida(e.target.checked)} disabled={busy} style={{width:14,height:14}}/>
            <label htmlFor="qc-perdida" style={{fontSize:12,color:C.mid,cursor:'pointer'}}>Generó pérdida de insumos</label>
          </div>
          <div style={{display:'flex',gap:8}}>
            <button onClick={()=>!busy&&onClose()} disabled={busy} style={{flex:1,padding:'12px 16px',background:'transparent',color:C.ink,border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontWeight:600,cursor:busy?'default':'pointer',opacity:busy?0.5:1}}>
              Volver
            </button>
            <button onClick={intentarCancelar} disabled={busy||!motivo} style={{flex:1.4,padding:'12px 16px',background:C.ink,color:C.surface,border:`1px solid ${C.ink}`,borderRadius:8,fontSize:13,fontWeight:700,cursor:(busy||!motivo)?'default':'pointer',opacity:(busy||!motivo)?0.55:1}}>
              {busy?'Cancelando…':'Continuar'}
            </button>
          </div>
        </div>
      </div>
      {pinOpen&&(
        <PinAuthModal
          title="Autorización Requerida"
          subtitle={`Ingresá el PIN de un Administrador o Gerente para cancelar el pedido #${order.order_number}.`}
          verifying={busy}
          onCancel={()=>{if(!busy)setPinOpen(false);}}
          onAuthorized={async(supervisor)=>{await ejecutarCancelacion(supervisor);}}
        />
      )}
    </>
  );
}

/* ═══════════════════════════════════════════
   PANEL: CANCELACIONES
═══════════════════════════════════════════ */
function CancelacionesPanel({turno,profile,onMovimiento}){
  const [orders,setOrders]=useState([]);
  const [loading,setLoading]=useState(true);
  const [selected,setSelected]=useState(null);
  const [form,setForm]=useState({tipo:'total',motivo:'',descripcion:'',perdida:false});
  const [busy,setBusy]=useState(false);
  const [pinModalOpen,setPinModalOpen]=useState(false);

  // Roles que pueden cancelar sin autorización extra.
  const ROLES_SIN_PIN=['admin','gerente','superadmin'];
  const requierePin=!ROLES_SIN_PIN.includes((profile?.role||'').toLowerCase());

  useEffect(()=>{loadOrders();},[]);

  async function loadOrders(){
    setLoading(true);
    const{data}=await db.from('orders')
      .select('id,order_number,status,total,customer_name,created_at,tables(number)')
      .eq('restaurant_id',RID)
      .in('status',['paid','kitchen_received','cooking','ready'])
      .order('created_at',{ascending:false});
    setOrders(data||[]);setLoading(false);
  }

  // Valida el formulario y dispara el flujo correcto: directo o vía PIN.
  function intentarCancelar(){
    if(!selected){toast('Seleccioná un pedido',false);return;}
    if(!form.motivo){toast('Seleccioná un motivo',false);return;}
    if(form.motivo==='Otro'&&!form.descripcion){toast('Descripción obligatoria para "Otro"',false);return;}
    if(requierePin){setPinModalOpen(true);return;}
    ejecutarCancelacion(null);
  }

  // Ejecuta la cancelación. `supervisor` viene del PIN modal cuando aplica.
  // Nota: cancelaciones_caja.supervisor_id FK → auth.users(id), pero el PIN
  // se valida contra user_profiles (sin user_id). Por eso registramos al
  // autorizante en items_cancelados.auth_supervisor (audit trail JSONB).
  async function ejecutarCancelacion(supervisor){
    setBusy(true);
    try{
      const{error:e1}=await db.from('orders').update({status:'cancelled'}).eq('id',selected.id);
      if(e1)throw e1;
      const descripcionFinal=supervisor
        ?`${form.descripcion||''}${form.descripcion?' · ':''}Autorizado por ${supervisor.full_name} (${supervisor.role}) — ID ${supervisor.id}`
        :(form.descripcion||null);
      const auditPayload=supervisor?[{
        auth_supervisor:{
          id:supervisor.id,
          full_name:supervisor.full_name,
          role:supervisor.role,
          at:new Date().toISOString(),
        }
      }]:[];
      const{error:e2}=await db.from('cancelaciones_caja').insert({
        turno_id:turno.id,restaurant_id:RID,pedido_id:selected.id,
        pedido_numero:selected.order_number,tipo:form.tipo,
        items_cancelados:auditPayload,monto_cancelado:selected.total,
        motivo:form.motivo,descripcion:descripcionFinal,
        estado_pedido_cancelar:selected.status,perdida_insumos:form.perdida,
        usuario_id:profile.id,usuario_nombre:profile.display_name||profile.username,
      });
      if(e2)throw e2;
      const sufijo=supervisor?` (autorizado por ${supervisor.full_name})`:'';
      toast(`Pedido #${selected.order_number} cancelado${sufijo}`);
      setSelected(null);
      setForm({tipo:'total',motivo:'',descripcion:'',perdida:false});
      setPinModalOpen(false);
      loadOrders();
    }catch(e){toast('Error: '+e.message,false);}
    setBusy(false);
  }

  return(
    <div className="page">
      <h1 style={{fontSize:20,fontWeight:800,marginBottom:16}}>Cancelaciones</h1>
      <AlertBox type="warn">Las cancelaciones quedan registradas con usuario, motivo y timestamp. No se pueden borrar del historial.</AlertBox>
      <div style={{display:'grid',gridTemplateColumns:'1fr 360px',gap:16}}>
        <div>
          <div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:10}}>SELECCIONAR PEDIDO A CANCELAR</div>
          {loading&&<span className="spin"/>}
          {!loading&&orders.length===0&&<div style={{color:C.mid,fontSize:13,padding:20,fontWeight:500}}>No hay pedidos activos para cancelar.</div>}
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            {orders.map(o=>{
              const mesa=o.tables?.number?`Mesa ${o.tables.number}`:o.customer_name||'Sin mesa';
              const enCocina=['kitchen_received','cooking','ready'].includes(o.status);
              return(
                <div key={o.id} onClick={()=>setSelected(o)}
                  style={{background:selected?.id===o.id?'var(--surface-hover)':C.surface,border:`2px solid ${selected?.id===o.id?C.ink:C.border}`,borderRadius:8,padding:'12px 14px',cursor:'pointer',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div>
                    <div style={{fontSize:14,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.ink}}>#{o.order_number}</div>
                    <div style={{fontSize:12,color:C.ink,marginTop:2,fontWeight:600}}>{mesa}</div>
                  </div>
                  <div style={{display:'flex',alignItems:'center',gap:10}}>
                    <Badge txt={SL[o.status]} color={SC[o.status]||'#6E6E73'}/>
                    {enCocina&&<Badge txt="En cocina" color={C.orange}/>}
                    <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:14,fontWeight:700,color:C.red}}>{fmt(o.total)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:20,height:'fit-content'}}>
          <div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:14}}>MOTIVO DE CANCELACIÓN</div>
          {selected?(
            <>
              <div style={{marginBottom:14,padding:'10px 14px',background:'var(--bg-subtle)',borderRadius:7,border:`1px solid ${C.border}`}}>
                <div style={{fontSize:14,fontWeight:800,color:C.ink}}>#{selected.order_number}</div>
                <div style={{fontSize:13,color:C.ink,marginTop:2,fontWeight:600}}>{fmt(selected.total)}</div>
              </div>
              {requierePin&&(
                <AlertBox type="info"><Icon name="lock" size={13} style={{verticalAlign:'-2px',marginRight:4}}/> Esta acción requerirá el PIN de un Administrador o Gerente al confirmar.</AlertBox>
              )}
              <div style={{marginBottom:12}}>
                <Lbl required>MOTIVO</Lbl>
                <Sel value={form.motivo} onChange={e=>setForm({...form,motivo:e.target.value})}>
                  <option value="">Seleccionar…</option>
                  {MOTIVOS_CANCEL.map(m=><option key={m}>{m}</option>)}
                </Sel>
              </div>
              {(form.motivo==='Otro'||form.motivo)&&(
                <div style={{marginBottom:12}}>
                  <Lbl required={form.motivo==='Otro'}>DESCRIPCIÓN ADICIONAL</Lbl>
                  <Textarea value={form.descripcion} onChange={e=>setForm({...form,descripcion:e.target.value})} placeholder="Detalles adicionales…" rows={2}/>
                </div>
              )}
              <div style={{marginBottom:14,display:'flex',alignItems:'center',gap:8}}>
                <input type="checkbox" id="perdida" checked={form.perdida} onChange={e=>setForm({...form,perdida:e.target.checked})} style={{width:14,height:14}}/>
                <label htmlFor="perdida" style={{fontSize:12,color:C.mid,cursor:'pointer'}}>Generó pérdida de insumos</label>
              </div>
              <Btn full variant="danger" onClick={intentarCancelar} disabled={busy||!form.motivo}>
                {busy?<><span className="spin"/> Cancelando…</>:'Confirmar cancelación'}
              </Btn>
            </>
          ):(
            <div style={{color:C.mid,fontSize:13,padding:'20px 0',textAlign:'center',fontWeight:500}}>← Seleccioná un pedido de la lista</div>
          )}
        </div>
      </div>

      {pinModalOpen&&(
        <PinAuthModal
          title="Autorización Requerida"
          subtitle={`Ingresá el PIN de un Administrador o Gerente para confirmar la cancelación del pedido #${selected?.order_number}.`}
          verifying={busy}
          onCancel={()=>{if(!busy)setPinModalOpen(false);}}
          onAuthorized={async(supervisor)=>{await ejecutarCancelacion(supervisor);}}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   PANEL: INGRESOS Y EGRESOS MANUALES
═══════════════════════════════════════════ */
function IngresosEgresosPanel({turno,profile,movimientos,onMovimiento}){
  const [tipo,setTipo]=useState('egreso');
  const [form,setForm]=useState({desc:'',monto:'',categoria:'',metodo:'efectivo',plataforma:'',notas:''});
  const [busy,setBusy]=useState(false);

  const cats=tipo==='ingreso_manual'?ING_CATS:EG_CATS;

  async function guardar(){
    if(!form.desc||!form.monto){toast('Descripción y monto son obligatorios',false);return;}
    if(!form.categoria){toast('Seleccioná una categoría',false);return;}
    setBusy(true);
    try{
      const mov={
        turno_id:turno.id,restaurant_id:RID,tipo,
        monto:parseInt(form.monto),metodo_pago:form.metodo,
        descripcion:form.desc,categoria:form.categoria,
        usuario_id:profile.id,usuario_nombre:profile.display_name||profile.username,
        metadata:{plataforma:form.plataforma||null,notas:form.notas||null,transaction_id:null,auth_code:null,raw_response:null},
      };
      const{data,error}=await db.from('movimientos_caja').insert(mov).select().single();
      if(error)throw error;
      onMovimiento(data);
      toast(`${tipo==='ingreso_manual'?'Ingreso':'Egreso'} registrado`);
      setForm({desc:'',monto:'',categoria:'',metodo:'efectivo',plataforma:'',notas:''});
    }catch(e){toast('Error: '+e.message,false);}
    setBusy(false);
  }

  const historial=movimientos.filter(m=>m.tipo===tipo).slice().reverse();

  return(
    <div className="page">
      <h1 style={{fontSize:20,fontWeight:800,marginBottom:16}}>Ingresos y Egresos Manuales</h1>
      <div style={{display:'grid',gridTemplateColumns:'1fr 380px',gap:16}}>
        {/* Historial */}
        <div>
          <div style={{display:'flex',gap:0,borderBottom:`1px solid ${C.border}`,marginBottom:14}}>
            {[['egreso','Egresos'],['ingreso_manual','Ingresos manuales']].map(([id,lbl])=>(
              <button key={id} onClick={()=>setTipo(id)} style={{padding:'8px 14px',fontSize:12,fontWeight:tipo===id?700:400,color:tipo===id?C.ink:'#86868B',background:'none',border:'none',borderBottom:tipo===id?`2px solid ${C.ink}`:'2px solid transparent',cursor:'pointer',marginBottom:-1}}>{lbl}</button>
            ))}
          </div>
          {historial.length===0?(
            <div style={{color:C.mid,fontSize:13,padding:20,textAlign:'center',fontWeight:500}}>Sin registros en este turno</div>
          ):(
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {historial.map(m=>(
                <div key={m.id} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'10px 14px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div>
                    <div style={{fontSize:13,fontWeight:700,color:C.ink}}>{m.descripcion}</div>
                    <div style={{fontSize:12,color:C.mid,marginTop:2,fontWeight:500}}>{m.categoria} · {fmtTime(m.created_at)}</div>
                  </div>
                  <div style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:16,fontWeight:800,color:tipo==='egreso'?C.red:C.green}}>{tipo==='egreso'?'− ':''}{fmt(m.monto)}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Formulario */}
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:20,height:'fit-content'}}>
          <div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:14}}>
            {tipo==='egreso'?'REGISTRAR EGRESO':'REGISTRAR INGRESO MANUAL'}
          </div>
          <div style={{marginBottom:12}}>
            <Lbl required>DESCRIPCIÓN</Lbl>
            <Inp value={form.desc} onChange={e=>setForm({...form,desc:e.target.value})} placeholder={tipo==='egreso'?'Ej: Compra de insumos…':'Ej: Venta evento especial…'}/>
          </div>
          <div style={{marginBottom:12}}>
            <Lbl required>MONTO (₲)</Lbl>
            <Inp gs mono value={form.monto} onChange={v=>setForm({...form,monto:v})} placeholder="0"/>
          </div>
          <div style={{marginBottom:12}}>
            <Lbl required>CATEGORÍA</Lbl>
            <Sel value={form.categoria} onChange={e=>setForm({...form,categoria:e.target.value})}>
              <option value="">Seleccionar…</option>
              {cats.map(c=><option key={c}>{c}</option>)}
            </Sel>
          </div>
          {tipo==='ingreso_manual'&&form.categoria==='Delivery externo'&&(
            <div style={{marginBottom:12}}>
              <Lbl>PLATAFORMA</Lbl>
              <Sel value={form.plataforma} onChange={e=>setForm({...form,plataforma:e.target.value})}>
                <option value="">Seleccionar…</option>
                {DELIVERY_PLATS.map(p=><option key={p}>{p}</option>)}
              </Sel>
            </div>
          )}
          <div style={{marginBottom:14}}>
            <Lbl>MÉTODO DE PAGO</Lbl>
            <Sel value={form.metodo} onChange={e=>setForm({...form,metodo:e.target.value})}>
              {METODOS_PAGO.filter(m=>m.id!=='mixto').map(m=><option key={m.id} value={m.id}>{m.lbl}</option>)}
            </Sel>
          </div>
          <Btn full onClick={guardar} disabled={busy}>
            {busy?<><span className="spin"/> Guardando…</> :`+ Registrar ${tipo==='egreso'?'egreso':'ingreso'}`}
          </Btn>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   PANEL: QUEJAS Y SUGERENCIAS
═══════════════════════════════════════════ */
function QuejasPanel({turno,profile}){
  const [quejas,setQuejas]=useState([]);
  const [loading,setLoading]=useState(true);
  const [showForm,setShowForm]=useState(false);
  const [form,setForm]=useState({tipo:'queja',categoria:'',urgencia:'media',descripcion:'',compensacion:false,comp_tipo:'',comp_monto:''});
  const [busy,setBusy]=useState(false);

  useEffect(()=>{loadQuejas();},[]);

  async function loadQuejas(){
    setLoading(true);
    const{data}=await db.from('quejas_sugerencias')
      .select('*').eq('restaurant_id',RID).eq('turno_id',turno.id)
      .order('created_at',{ascending:false});
    setQuejas(data||[]);setLoading(false);
  }

  async function guardar(){
    if(!form.descripcion){toast('La descripción es obligatoria',false);return;}
    setBusy(true);
    try{
      const{error}=await db.from('quejas_sugerencias').insert({
        turno_id:turno.id,restaurant_id:RID,
        tipo:form.tipo,categoria:form.categoria||null,urgencia:form.urgencia,
        descripcion:form.descripcion,
        compensacion_ofrecida:form.compensacion,
        compensacion_tipo:form.compensacion?form.comp_tipo||null:null,
        compensacion_monto:form.compensacion&&form.comp_monto?parseInt(form.comp_monto):null,
        usuario_id:profile.id,usuario_nombre:profile.display_name||profile.username,
      });
      if(error)throw error;
      toast('Registrado correctamente');
      if(form.urgencia==='alta'&&form.tipo==='queja')toast('Urgencia alta — notificar al supervisor',false);
      setShowForm(false);
      setForm({tipo:'queja',categoria:'',urgencia:'media',descripcion:'',compensacion:false,comp_tipo:'',comp_monto:''});
      loadQuejas();
    }catch(e){toast('Error: '+e.message,false);}
    setBusy(false);
  }

  const urgColor={alta:C.red,media:C.yellow,baja:C.green};
  const tipoColor={queja:C.red,sugerencia:C.blue,comentario_positivo:C.green};

  return(
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
        <h1 style={{fontSize:20,fontWeight:800}}>Quejas y Sugerencias</h1>
        <Btn small onClick={()=>setShowForm(!showForm)}>+ Nueva queja / sugerencia</Btn>
      </div>

      {showForm&&(
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:20,marginBottom:16,animation:'fadeIn .15s ease'}}>
          <div className="my-row-2" style={{gap:12,marginBottom:12}}>
            <div>
              <Lbl required>TIPO</Lbl>
              <Sel value={form.tipo} onChange={e=>setForm({...form,tipo:e.target.value})}>
                <option value="queja">Queja</option>
                <option value="sugerencia">Sugerencia</option>
                <option value="comentario_positivo">Comentario positivo</option>
              </Sel>
            </div>
            {form.tipo==='queja'&&(
              <div>
                <Lbl>CATEGORÍA</Lbl>
                <Sel value={form.categoria} onChange={e=>setForm({...form,categoria:e.target.value})}>
                  <option value="">Seleccionar…</option>
                  {QUEJA_CATS.map(c=><option key={c}>{c}</option>)}
                </Sel>
              </div>
            )}
            {form.tipo==='queja'&&(
              <div>
                <Lbl>URGENCIA</Lbl>
                <Sel value={form.urgencia} onChange={e=>setForm({...form,urgencia:e.target.value})}>
                  <option value="baja">Baja</option>
                  <option value="media">Media</option>
                  <option value="alta">Alta</option>
                </Sel>
              </div>
            )}
          </div>
          <div style={{marginBottom:12}}>
            <Lbl required>DESCRIPCIÓN</Lbl>
            <Textarea value={form.descripcion} onChange={e=>setForm({...form,descripcion:e.target.value})} placeholder="Descripción detallada del caso…" rows={3}/>
          </div>
          {form.tipo==='queja'&&(
            <div style={{marginBottom:14}}>
              <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}>
                <input type="checkbox" id="comp" checked={form.compensacion} onChange={e=>setForm({...form,compensacion:e.target.checked})} style={{width:14,height:14}}/>
                <label htmlFor="comp" style={{fontSize:12,color:C.mid,cursor:'pointer'}}>Se ofreció compensación</label>
              </div>
              {form.compensacion&&(
                <div className="my-row-2" style={{gap:8}}>
                  <div>
                    <Lbl>TIPO COMPENSACIÓN</Lbl>
                    <Sel value={form.comp_tipo} onChange={e=>setForm({...form,comp_tipo:e.target.value})}>
                      <option value="">Seleccionar…</option>
                      {['Descuento','Cortesía','Voucher','Reembolso'].map(t=><option key={t}>{t}</option>)}
                    </Sel>
                  </div>
                  <div>
                    <Lbl>MONTO (₲)</Lbl>
                    <Inp gs mono value={form.comp_monto} onChange={v=>setForm({...form,comp_monto:v})} placeholder="0"/>
                  </div>
                </div>
              )}
            </div>
          )}
          <div style={{display:'flex',gap:8}}>
            <Btn small onClick={guardar} disabled={busy}>{busy?<span className="spin"/>:'Guardar'}</Btn>
            <Btn small variant="ghost" onClick={()=>setShowForm(false)}>Cancelar</Btn>
          </div>
        </div>
      )}

      {loading&&<span className="spin"/>}
      {!loading&&quejas.length===0&&<div style={{color:C.mid,fontSize:13,padding:20,textAlign:'center',fontWeight:500}}>Sin registros en este turno</div>}
      <div style={{display:'flex',flexDirection:'column',gap:8}}>
        {quejas.map(q=>(
          <div key={q.id} style={{background:C.surface,border:`1px solid ${tipoColor[q.tipo]||'#D2D2D7'}44`,borderRadius:8,padding:'12px 14px'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:6}}>
              <div style={{display:'flex',gap:8,alignItems:'center'}}>
                <Badge txt={q.tipo.replace('_',' ')} color={tipoColor[q.tipo]||'#6E6E73'}/>
                {q.urgencia&&<Badge txt={q.urgencia} color={urgColor[q.urgencia]||'#6E6E73'}/>}
                {q.categoria&&<Badge txt={q.categoria} color="#6E6E73"/>}
              </div>
              <span style={{fontSize:11,color:C.mid,fontWeight:500}}>{fmtTime(q.created_at)}</span>
            </div>
            <div style={{fontSize:13,color:C.ink,marginBottom:q.compensacion_ofrecida?6:0}}>{q.descripcion}</div>
            {q.compensacion_ofrecida&&(
              <div style={{fontSize:11,color:C.yellow,marginTop:4}}>Compensación ofrecida: {q.compensacion_tipo}{q.compensacion_monto?` — ${fmt(q.compensacion_monto)}`:''}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   PANEL: RETIRO DE EFECTIVO
═══════════════════════════════════════════ */
function RetiroPanel({turno,profile,movimientos,onMovimiento}){
  const [form,setForm]=useState({monto:'',destino:'Caja fuerte',notas:''});
  const [busy,setBusy]=useState(false);
  const [historial,setHistorial]=useState([]);

  /* Saldo efectivo estimado */
  const cobros=movimientos.filter(m=>m.tipo==='cobro');
  const efectivoCobros=cobros.filter(m=>m.metodo_pago==='efectivo').reduce((s,m)=>s+Number(m.monto),0);
  const ingresosMan=movimientos.filter(m=>m.tipo==='ingreso_manual'&&m.metodo_pago==='efectivo').reduce((s,m)=>s+Number(m.monto),0);
  const egresosEfectivo=movimientos.filter(m=>m.tipo==='egreso'&&m.metodo_pago==='efectivo').reduce((s,m)=>s+Number(m.monto),0);
  const retirosYa=movimientos.filter(m=>m.tipo==='retiro_parcial').reduce((s,m)=>s+Number(m.monto),0);
  const fondoApertura=turno.fondo_apertura?.total||0;
  const saldoEfectivo=fondoApertura+efectivoCobros+ingresosMan-egresosEfectivo-retirosYa;

  const retirosMov=movimientos.filter(m=>m.tipo==='retiro_parcial');

  async function retirar(){
    const monto=parseInt(form.monto)||0;
    if(monto<=0){toast('Ingresá un monto válido',false);return;}
    if(!form.notas){toast('El motivo/notas es obligatorio',false);return;}
    if(monto>saldoEfectivo){
      toast(`No podés retirar más que el efectivo disponible (${fmt(saldoEfectivo)})`,false);return;
    }
    if(!window.confirm(`¿Confirmar retiro de ${fmt(monto)} → ${form.destino}?`))return;
    setBusy(true);
    try{
      const mov={
        turno_id:turno.id,restaurant_id:RID,tipo:'retiro_parcial',
        monto,metodo_pago:'efectivo',
        descripcion:`Retiro parcial → ${form.destino}`,
        motivo:form.notas,
        usuario_id:profile.id,usuario_nombre:profile.display_name||profile.username,
        metadata:{destino:form.destino,transaction_id:null,auth_code:null,raw_response:null},
      };
      const{data,error}=await db.from('movimientos_caja').insert(mov).select().single();
      if(error)throw error;
      onMovimiento(data);
      toast(`Retiro de ${fmt(monto)} registrado`);
      setForm({monto:'',destino:'Caja fuerte',notas:''});
    }catch(e){toast('Error: '+e.message,false);}
    setBusy(false);
  }

  const montoNum=parseInt(form.monto)||0;
  const excede=montoNum>saldoEfectivo&&montoNum>0;

  return(
    <div className="page">
      <h1 style={{fontSize:20,fontWeight:800,marginBottom:16}}>Retiro Parcial de Efectivo</h1>
      <AlertBox type="warn">Esta acción queda registrada en el log del turno con tu nombre y timestamp.</AlertBox>

      <div style={{display:'grid',gridTemplateColumns:'1fr 380px',gap:16,alignItems:'start'}}>
        {/* Historial de retiros del turno */}
        <div>
          <div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:10}}>RETIROS DE ESTE TURNO</div>
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:14,marginBottom:14}}>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
              <span style={{fontSize:11,color:C.mid}}>Efectivo disponible (est.)</span>
              <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:16,fontWeight:700,color:C.green}}>{fmt(saldoEfectivo)}</span>
            </div>
            <div style={{display:'flex',justifyContent:'space-between'}}>
              <span style={{fontSize:11,color:C.mid}}>Total retirado hoy</span>
              <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:14,fontWeight:700,color:C.orange}}>{fmt(retirosYa)}</span>
            </div>
          </div>
          {retirosMov.length===0?(
            <div style={{color:C.mid,fontSize:13,padding:20,textAlign:'center',fontWeight:500}}>Sin retiros en este turno</div>
          ):(
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {retirosMov.map(m=>(
                <div key={m.id} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'10px 14px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div>
                    <div style={{fontSize:13,fontWeight:600}}>{m.descripcion}</div>
                    <div style={{fontSize:11,color:C.dim,marginTop:2}}>{m.usuario_nombre} · {fmtTime(m.created_at)}</div>
                    {m.motivo&&<div style={{fontSize:11,color:C.mid,marginTop:1,display:'flex',alignItems:'center',gap:4}}><Icon name="fileText" size={11} /> {m.motivo}</div>}
                  </div>
                  <div style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:15,fontWeight:700,color:C.orange}}>- {fmt(m.monto)}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Formulario */}
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:20,height:'fit-content'}}>
          <div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:14}}>NUEVO RETIRO</div>
          <div style={{marginBottom:12}}>
            <Lbl required>MONTO A RETIRAR (₲)</Lbl>
            <Inp gs mono value={form.monto} onChange={v=>setForm({...form,monto:v})} placeholder="0"/>
            {excede&&(
              <div style={{fontSize:11,color:C.red,marginTop:4}}>Supera el efectivo disponible ({fmt(saldoEfectivo)})</div>
            )}
          </div>
          <div style={{marginBottom:12}}>
            <Lbl>DESTINO</Lbl>
            <Sel value={form.destino} onChange={e=>setForm({...form,destino:e.target.value})}>
              <option>Caja fuerte</option>
              <option>Depósito bancario</option>
              <option>Gerencia</option>
              <option>Otro</option>
            </Sel>
          </div>
          <div style={{marginBottom:14}}>
            <Lbl required>MOTIVO / NOTAS</Lbl>
            <Textarea value={form.notas} onChange={e=>setForm({...form,notas:e.target.value})} placeholder="Motivo obligatorio del retiro…" rows={2}/>
          </div>
          <Btn full variant="danger" onClick={retirar} disabled={busy||excede||!form.notas}>
            {busy?<><span className="spin"/> Registrando…</>:'Confirmar retiro'}
          </Btn>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   MODAL: EXTRAS (POS)
═══════════════════════════════════════════ */
function ExtrasModal({item,extras,onClose,onConfirm}){
  const [sel,setSel]=useState([]);
  const [obs,setObs]=useState('');
  function toggle(id){setSel(p=>p.includes(id)?p.filter(x=>x!==id):[...p,id]);}
  const selectedExtras=extras.filter(e=>sel.includes(e.id));
  const extrasTotal=selectedExtras.reduce((s,e)=>s+Number(e.price_guarani||0),0);
  return(
    <Modal title={item.name} onClose={onClose} width={420}>
      <div style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:22,fontWeight:800,color:C.green,marginBottom:16}}>{fmt(item.price_guarani)}</div>
      <div style={{marginBottom:14}}>
        <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:10}}>EXTRAS</div>
        <div style={{display:'flex',flexDirection:'column',gap:6}}>
          {extras.map(ex=>(
            <label key={ex.id} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 12px',background:sel.includes(ex.id)?'rgba(255,255,255,0.05)':C.card,border:`1px solid ${sel.includes(ex.id)?C.white:C.border}`,borderRadius:7,cursor:'pointer'}}>
              <input type="checkbox" checked={sel.includes(ex.id)} onChange={()=>toggle(ex.id)} style={{width:14,height:14}}/>
              <span style={{flex:1,fontSize:13}}>{ex.name}</span>
              {Number(ex.price_guarani)>0&&<span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:12,color:C.green}}>+{fmt(ex.price_guarani)}</span>}
            </label>
          ))}
        </div>
      </div>
      <div style={{marginBottom:14}}>
        <Lbl>OBSERVACIONES PARA COCINA</Lbl>
        <Textarea value={obs} onChange={e=>setObs(e.target.value)} placeholder="Sin cebolla, bien cocido, sin sal…" rows={2}/>
      </div>
      <div style={{background:C.card,borderRadius:7,padding:'10px 14px',display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
        <span style={{fontSize:12,color:C.mid}}>Total con extras</span>
        <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:18,fontWeight:800,color:C.green}}>{fmt(Number(item.price_guarani)+extrasTotal)}</span>
      </div>
      <div style={{display:'flex',gap:8}}>
        <Btn full onClick={()=>onConfirm(selectedExtras,obs)} variant="success">+ Agregar al pedido</Btn>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
      </div>
    </Modal>
  );
}

/* ═══════════════════════════════════════════
   MODAL: COBRO INMEDIATO (antes de enviar a cocina)
═══════════════════════════════════════════ */
function PagarAntesDeEnviarModal({cart,orderType,tableId,customerName,tables,turno,profile,deliv,zones,channels,onClose,onConfirmed}){
  const [metodo,setMetodo]=useState('efectivo');
  const [montoPagado,setMontoPagado]=useState('0');
  const [busy,setBusy]=useState(false);
  const [successTicket,setSuccessTicket]=useState(null);
  const [invoiceType,setInvoiceType]=useState('none'); // 'none'|'ticket'|'fiscal'
  const [comprobante,setComprobante]=useState('');   // Nº comprobante/operación (mig 180)
  const [proofUrl,setProofUrl]=useState('');         // foto del comprobante (mig 182)
  const bankInfo=useBankInfo();
  const requireProof=useRequireProof();              // exigir comprobante en QR (mig 182 · require_proof)
  const [invName,setInvName]=useState('');
  const [invRuc,setInvRuc]=useState('');
  const [invEmail,setInvEmail]=useState('');
  const movDataRef=React.useRef(null);
  const orderRef=React.useRef(null);
  const [showBancardToast,setShowBancardToast]=useState(false);
  // Omni-Gating: pasarelas digitales (Bancard) y SIFEN según plan del comercio
  const _MG=window.MythosGating;
  const hasFeat=k=>!_MG||_MG.hasFeature(k);
  const [lockFeat,setLockFeat]=useState(null);
  const gate=(k,fn)=>()=>hasFeat(k)?fn():setLockFeat(k);

  const subtotal=cart.reduce((s,c)=>s+c.linePrice*c.quantity,0);
  // Delivery: envío desde la zona elegida (DB) → total = productos + envío.
  const isDeliv=orderType==='delivery';
  const selZone=isDeliv&&deliv?.zoneId?(zones||[]).find(z=>z.id===deliv.zoneId):null;
  const deliveryFee=selZone?.price_guarani||0;
  const total=subtotal+deliveryFee;               // = subtotal cuando no es delivery (fee 0)
  const contraEntrega=isDeliv&&!deliv?.paid;      // cobra el rider → no se cobra en mostrador
  const montoNum=parseInt(montoPagado)||0;
  const cambio=metodo==='efectivo'?montoNum-total:0;
  const BILLETES=[1000,2000,5000,10000,20000,50000,100000];
  const mesa=tableId&&tableId!=='sin_mesa'?tables.find(t=>t.id===tableId):null;
  const origen=orderType==='dine_in'?(tableId==='sin_mesa'?'Sin número de mesa':`Mesa ${mesa?.number||'?'}`):orderType==='delivery'?'Delivery':'Para llevar';

  async function confirmar(){
    if(!contraEntrega&&metodo==='efectivo'&&montoNum<total){toast('El monto recibido es menor al total',false);return;}
    if(!contraEntrega&&_faltaComprobante(requireProof,metodo,comprobante,proofUrl)){ toast(_MSG_FALTA_COMP,false);return; }
    setBusy(true);
    try{
      /* 1. crear order */
      const dbOrderType=orderType==='dine_in'?'local':orderType==='delivery'?'delivery':'llevar';
      const orderNum='C-'+String(Math.floor(Date.now()%90000)+10000);
      const invoiceFields = {
        requires_invoice: invoiceType !== 'none',
        ...(invoiceType === 'fiscal' && {
          customer_name: invName || customerName || null,
          customer_ruc: invRuc || null,
          customer_email: invEmail || null,
          invoice_delivery_method: invEmail ? 'email' : 'print',
          invoice_requested_at: new Date().toISOString(),
          invoice_status: 'pending',
        }),
        ...(invoiceType === 'ticket' && {
          invoice_delivery_method: 'print',
          invoice_status: 'issued',
        }),
      };
      const baseInsert = {
        restaurant_id:RID,
        table_id:orderType==='dine_in'&&tableId&&tableId!=='sin_mesa'?tableId:null,
        order_number:orderNum,order_type:dbOrderType,
        status:'paid',
        payment_status:'paid',
        customer_name:invoiceType==='fiscal'?(invName||customerName||null):(customerName||null),
        subtotal,discount_amount:0,total,
        payment_method:mapOrderPM(metodo),
        ...(isDeliv?{channel:deliv?.channel||'propio', external_order_id:(deliv?.channel!=='propio'?(deliv?.externalId||'').trim():'')||null}:{}),
      };
      // Se persiste con el MISMO criterio con el que `_needsRef` decide mostrar el
      // campo. Antes esta lista estaba escrita a mano y se había quedado sin 'mixto':
      // al cobrar mixto el cajero veía el campo, cargaba el N° de comprobante y se
      // descartaba en silencio — el pago quedaba sin referencia para conciliar.
      const payRef = (_needsRef(metodo) && comprobante.trim()) ? comprobante.trim() : null;
      let{data:order,error:e1}=await db.from('orders').insert({...baseInsert,...invoiceFields,...(payRef?{payment_reference:payRef}:{})}).select().single();
      // Reintento recortado SÓLO si la base todavía no tiene las columnas de factura.
      // Antes reintentaba ante CUALQUIER error: un fallo transitorio (RLS, red) hacía
      // que el pedido se creara sin requires_invoice ni payment_reference — el cliente
      // pedía factura, pagaba, y el pedido quedaba registrado como si no la hubiera
      // pedido. Cualquier otro error ahora se propaga y el cobro no se da por hecho.
      if(e1 && _esColumnaFaltante(e1)){
        const r=await db.from('orders').insert(baseInsert).select().single();
        order=r.data;e1=r.error;
      }
      if(e1)throw e1;

      /* 2. order_items */
      const itemsPayload=cart.map(c=>({
        order_id:order.id,item_id:c.item.id,item_name:c.item.name,
        quantity:c.quantity,unit_price:c.item.price_guarani,
        total_price:c.linePrice*c.quantity,observations:c.observations||null,
      }));
      const{data:createdItems,error:e2}=await db.from('order_items').insert(itemsPayload).select();
      if(e2)throw e2;

      /* 3. extras */
      const xPayload=[];
      cart.forEach((c,idx)=>{
        const oi=(createdItems||[])[idx];
        if(oi&&c.extras.length>0){c.extras.forEach(ex=>xPayload.push({order_item_id:oi.id,extra_name:ex.name,extra_price:ex.price_guarani||0}));}
      });
      if(xPayload.length>0){const{error:e3}=await db.from('order_item_extras').insert(xPayload);if(e3)throw e3;}

      /* 4. historial */
      await db.from('order_status_history').insert({order_id:order.id,status:'paid',changed_by:'caja'});

      /* 4b. delivery_orders + despacho (Part 1) — replica el camino del "+ Nuevo pedido" del admin.
         El bug era que Caja creaba el pedido en orders pero NUNCA en delivery_orders → no caía a
         ningún rider ni aparecía en Admin→Delivery. Ahora sí crea la ficha de dispatch y la asigna. */
      if(isDeliv){
        const selChan=(channels||[]).find(c=>c.id===(deliv?.channel||'propio'));
        const delivPayload={
          restaurant_id:RID, order_id:order.id, order_number:orderNum,
          order_type:'delivery', customer_name:order.customer_name||customerName||null,
          customer_phone:(deliv?.phone||'').trim()||null,
          delivery_address:(deliv?.address||'').trim()||null,
          delivery_references:(deliv?.reference||'').trim()||null,
          zone_id:deliv?.zoneId||null, zone_name:selZone?.name||null,
          delivery_fee:deliveryFee, estimated_minutes:selZone?.estimated_minutes||null,
          channel:deliv?.channel||'propio', channel_commission:selChan?.commission||0,
          external_order_id:(deliv?.channel!=='propio'?(deliv?.externalId||'').trim():'')||null,
          order_total:subtotal, rider_status:'pending',
          cash_amount:contraEntrega?total:null,
        };
        let{data:delRow,error:dErr}=await db.from('delivery_orders').insert(delivPayload).select('id').single();
        // Defensivo: si la mig 161 (external_order_id) aún no está aplicada, reintentar sin esa columna.
        if(dErr && /external_order_id|PGRST204|42703|schema cache/i.test(`${dErr.message||''} ${dErr.code||''}`)){
          const {external_order_id, ...noExt}=delivPayload;
          const retry=await db.from('delivery_orders').insert(noExt).select('id').single();
          delRow=retry.data; dErr=retry.error;
        }
        if(dErr)throw new Error('Delivery: '+dErr.message);
        // Dispatch centralizado (mig 156): cae a un rider disponible o queda Pendiente/Sin asignar.
        try{ await db.rpc('assign_delivery_order',{p_order_id:delRow.id}); }catch(_){}
      }

      /* 5. movimiento_caja — SÓLO si el dinero entra a la caja. En contra-entrega
         (cobra el rider) no se registra cobro para no descuadrar el arqueo. */
      let movData=null;
      if(!contraEntrega){
        const mov={
          turno_id:turno.id,restaurant_id:RID,tipo:'cobro',
          monto:total,metodo_pago:metodo,pedido_id:order.id,
          descripcion:`Cobro pedido #${orderNum} — ${origen}`,
          usuario_id:profile.id,usuario_nombre:profile.display_name||profile.username,
          metadata:{orden_numero:orderNum,mesa:origen,monto_pagado:montoNum||total,cambio:Math.max(0,cambio),transaction_id:null,auth_code:null,raw_response:null},
        };
        const{data:mv,error:e4}=await db.from('movimientos_caja').insert(mov).select().single();
        if(e4)throw e4;
        movData=mv;
        if(payRef&&mv){ try{ await db.from('movimientos_caja').update({comprobante_nro:payRef}).eq('id',mv.id); }catch(_){} }
        // Foto del comprobante (mig 182): best-effort.
        if(proofUrl){
          try{ await db.from('orders').update({payment_proof_url:proofUrl,payment_review_status:'pending'}).eq('id',order.id); }catch(_){}
          if(mv){ try{ await db.from('movimientos_caja').update({comprobante_url:proofUrl}).eq('id',mv.id); }catch(_){} }
          try{ await recordPaymentReview(db,{restaurantId:RID,orderId:order.id,action:'proof_added'}); }catch(_){}
        }
      }

      movDataRef.current=movData;
      orderRef.current=order;
      const ticket={
        orderNumber:order.order_number,
        mesa:origen,
        items:cart.map(c=>({item_name:c.item.name,quantity:c.quantity,unit_price:c.linePrice})),
        total,
        deliveryFee,
        contraEntrega,
        metodo,
        cambio:Math.max(0,cambio),
        customerName:order.customer_name||null,
        customerRuc:order.customer_ruc||null,
        cashier:profile.display_name||profile.username,
        createdAt:order.created_at||new Date().toISOString(),
      };
      setSuccessTicket(ticket);
      if(invoiceType==='ticket' || metodo==='efectivo') printTicket(ticket);
    }catch(e){toast('Error: '+e.message,false);}
    setBusy(false);
  }

  function cerrarTrasExito(){
    if(movDataRef.current&&orderRef.current) onConfirmed(movDataRef.current,orderRef.current);
  }

  if(successTicket){
    const ce=successTicket.contraEntrega;
    return(
      <Modal title={ce?'Pedido enviado a despacho':'Pedido cobrado'} onClose={cerrarTrasExito} width={420}>
        <div style={{textAlign:'center',padding:'20px 0 8px'}}>
          <div style={{fontSize:48,marginBottom:8}}>✓</div>
          <div style={{fontSize:18,fontWeight:800,color:'#34C759',marginBottom:4}}>{ce?'¡Enviado!':'¡Cobrado!'}</div>
          <div style={{fontSize:13,color:C.mid,marginBottom:2}}>Pedido #{successTicket.orderNumber}</div>
          <div style={{fontSize:12,color:C.mid}}>{ce?'El rider cobra al entregar':successTicket.mesa}</div>
        </div>
        <div style={{background:C.bg,borderRadius:10,padding:'12px 14px',marginTop:12,marginBottom:16}}>
          {successTicket.items.map((it,i)=>(
            <div key={i} style={{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:3}}>
              <span>{it.quantity}× {it.item_name}</span>
              <span style={{fontFamily:"'SF Mono',monospace",fontWeight:700}}>{fmt(it.unit_price*it.quantity)}</span>
            </div>
          ))}
          <div style={{display:'flex',justifyContent:'space-between',fontSize:15,fontWeight:800,borderTop:`1px solid ${C.border}`,paddingTop:8,marginTop:6}}>
            <span>TOTAL</span>
            <span style={{fontFamily:"'SF Mono',monospace",color:'#34C759'}}>{fmt(successTicket.total)}</span>
          </div>
          {successTicket.cambio>0&&(
            <div style={{display:'flex',justifyContent:'space-between',fontSize:13,color:C.mid,marginTop:4}}>
              <span>Vuelto</span>
              <span style={{fontFamily:"'SF Mono',monospace",fontWeight:700}}>{fmt(successTicket.cambio)}</span>
            </div>
          )}
        </div>
        <div style={{display:'flex',gap:10}}>
          <Btn full onClick={()=>printTicket(successTicket)} variant="secondary"><Icon name="print" size={14} style={{verticalAlign:'-2px',marginRight:5}}/>Imprimir ticket</Btn>
          <Btn full onClick={cerrarTrasExito} variant="success">Cerrar</Btn>
        </div>
      </Modal>
    );
  }

  return(
    <Modal title="Cobrar antes de enviar a cocina" onClose={onClose} width={500}>
      <div style={{marginBottom:16}}>
        <div style={{background:C.bg,borderRadius:8,padding:'10px 14px',marginBottom:14}}>
          <div style={{fontSize:12,color:C.mid,marginBottom:4}}>{origen} {customerName?`— ${customerName}`:''}</div>
          <div style={{display:'flex',flexDirection:'column',gap:4,marginBottom:10}}>
            {cart.map(c=>(
              <div key={c.cartId} style={{display:'flex',justifyContent:'space-between',fontSize:13,color:C.ink}}>
                <span style={{fontWeight:500}}>{c.quantity}× {c.item.name}</span>
                <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:700}}>{fmt(c.linePrice*c.quantity)}</span>
              </div>
            ))}
          </div>
          {isDeliv&&deliveryFee>0&&(
            <div style={{display:'flex',justifyContent:'space-between',fontSize:12,color:C.mid,marginBottom:4}}>
              <span>Envío{selZone?` · ${selZone.name}`:''}</span>
              <span style={{fontFamily:"'SF Mono',ui-monospace,monospace"}}>{fmt(deliveryFee)}</span>
            </div>
          )}
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',borderTop:`1px solid ${C.border}`,paddingTop:10}}>
            <span style={{fontSize:14,fontWeight:800,color:C.ink}}>{contraEntrega?'TOTAL (lo cobra el rider)':'TOTAL A COBRAR'}</span>
            <span style={{fontSize:26,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.green}}>{fmt(total)}</span>
          </div>
        </div>

        {contraEntrega ? (
          <div style={{marginBottom:14,padding:'12px 14px',background:'rgba(255,149,0,0.08)',border:'1px solid rgba(255,149,0,0.3)',borderRadius:8,fontSize:12,color:TINT.amberText,fontWeight:600,display:'flex',alignItems:'center',gap:6}}>
            <Icon name="bike" size={16} /> El rider cobra {fmt(total)} al entregar (efectivo contra-entrega). No se cobra en caja.
          </div>
        ) : (<>
        <div style={{marginBottom:14}}>
          <Lbl required>MÉTODO DE PAGO</Lbl>
          <div className="my-row-2" style={{gap:8}}>
            {METODOS_PAGO.map(m=>(
              <button key={m.id} onClick={()=>setMetodo(m.id)} style={{
                padding:'10px',borderRadius:7,border:`1px solid ${metodo===m.id?C.ink:C.border}`,
                background:metodo===m.id?C.ink:'transparent',
                color:metodo===m.id?'#FFFFFF':'#6E6E73',fontSize:12,fontWeight:metodo===m.id?700:400,cursor:'pointer',
              }}>{m.lbl}</button>
            ))}
          </div>
          <PagoRefTransfer metodo={metodo} comprobante={comprobante} setComprobante={setComprobante} bankInfo={bankInfo} proofUrl={proofUrl} setProofUrl={setProofUrl}/>
        </div>

        {metodo==='efectivo'&&(
          <div style={{marginBottom:14}}>
            <Lbl>BILLETES RECIBIDOS</Lbl>
            <div className="my-grid" style={{'--my-col':'62px',gap:5,marginBottom:8}}>
              {BILLETES.map(v=>(
                <button key={v} onClick={()=>setMontoPagado(String(montoNum+v))} style={{
                  padding:'9px 4px',borderRadius:6,border:`1px solid ${C.border}`,
                  background:C.bg,color:C.ink,fontSize:12,fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:700,cursor:'pointer',
                }}>{v>=1000?`${v/1000}k`:v}</button>
              ))}
              <button onClick={()=>setMontoPagado(String(total))} style={{
                padding:'9px 4px',borderRadius:6,border:`1px solid ${C.blue}55`,
                background:'rgba(59,130,246,0.1)',color:C.blue,fontSize:11,fontWeight:700,cursor:'pointer',
              }}>Exacto</button>
            </div>
            <Lbl required>MONTO RECIBIDO (₲)</Lbl>
            <Inp gs mono value={montoPagado} onChange={setMontoPagado} placeholder={formatGs(total)}/>
            {montoNum>0&&(
              cambio>=0?(
                <div style={{marginTop:8,padding:'12px 14px',background:'rgba(34,197,94,0.1)',border:'1px solid rgba(34,197,94,0.3)',borderRadius:8,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <span style={{fontSize:13,color:TINT.greenText,fontWeight:700}}>Vuelto a entregar</span>
                  <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:24,fontWeight:800,color:cambio>0?C.green:'#6E6E73'}}>{cambio>0?fmt(cambio):'Sin vuelto'}</span>
                </div>
              ):(
                <div style={{marginTop:8,padding:'10px 12px',background:'rgba(255,59,48,0.08)',border:'1px solid rgba(255,59,48,0.3)',borderRadius:7}}>
                  <span style={{fontSize:13,color:C.red,fontWeight:700}}>Faltan {fmt(total-montoNum)}</span>
                </div>
              )
            )}
          </div>
        )}
        </>)}
      </div>

      {/* Factura Electrónica (SIFEN) — oculto hasta certificación e-Kuatia (2026-07-18) */}

      {/* Comprobante */}
      <div style={{marginBottom:16}}>
        <Lbl>COMPROBANTE</Lbl>
        <div className="my-row-3" style={{gap:6,marginBottom:invoiceType!=='none'?10:0}}>
          {[['none','Sin comprobante'],['ticket','Ticket impreso'],['fiscal','Factura fiscal']].map(([v,lbl])=>(
            <button key={v} onClick={v==='fiscal'?gate('caja:sifen',()=>setInvoiceType('fiscal')):()=>setInvoiceType(v)} style={{
              padding:'9px 4px',borderRadius:7,border:`1px solid ${invoiceType===v?C.ink:C.border}`,
              background:invoiceType===v?C.ink:'transparent',
              color:invoiceType===v?C.sidebar:C.mid,fontSize:11,fontWeight:700,cursor:'pointer',lineHeight:1.3,
            }}>{lbl}</button>
          ))}
        </div>
        {invoiceType==='ticket'&&(
          <div style={{padding:'8px 12px',background:'rgba(52,199,89,0.08)',border:'1px solid rgba(52,199,89,0.3)',borderRadius:7,fontSize:12,color:TINT.greenText}}>
            <Icon name="print" size={13} style={{verticalAlign:'-2px',marginRight:4}}/> El ticket se imprimirá automáticamente al cobrar.
          </div>
        )}
        {invoiceType==='fiscal'&&(
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            <Inp value={invName} onChange={e=>setInvName(e.target.value)} placeholder="Nombre / razón social"/>
            <Inp value={invRuc} onChange={e=>setInvRuc(e.target.value)} placeholder="RUC / Cédula"/>
            <Inp type="email" value={invEmail} onChange={e=>setInvEmail(e.target.value)} placeholder="Email (opcional — para enviar la factura)"/>
            <div style={{fontSize:11,color:C.mid}}>Si dejás email se enviará por correo, si no se imprime. e-Kuatia (SIFEN) próximamente.</div>
          </div>
        )}
      </div>

      <div style={{display:'flex',gap:10}}>
        <Btn full onClick={confirmar} disabled={busy} variant="success">
          {busy?<><span className="spin"/> Procesando…</>:(contraEntrega?'✓ Enviar a despacho':isDeliv?'✓ Cobrar y despachar':'✓ Cobrar y enviar a cocina')}
        </Btn>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
      </div>
      {showBancardToast&&<BancardProximamente onDismiss={()=>setShowBancardToast(false)}/>}
      {lockFeat&&_MG&&<_MG.FeatureLock featureKey={lockFeat} onClose={()=>setLockFeat(null)}/>}
    </Modal>
  );
}

/* ═══════════════════════════════════════════
   PANEL: TOMAR PEDIDO (POS)
═══════════════════════════════════════════ */
function TomarPedidoPanel({turno,profile,onMovimiento}){
  const [cats,setCats]=useState([]);
  const [items,setItems]=useState([]);
  const [tables,setTables]=useState([]);
  const [loading,setLoading]=useState(true);
  const [selCat,setSelCat]=useState(null);
  const [cart,setCart]=useState(()=>{try{return JSON.parse(localStorage.getItem(lsk('caja_cart'))||'[]');}catch{return [];}});
  const [orderType,setOrderType]=useState(()=>localStorage.getItem(lsk('caja_order_type'))||'dine_in');
  const [tableId,setTableId]=useState(()=>localStorage.getItem(lsk('caja_table_id'))||'');
  const [customerName,setCustomerName]=useState(()=>localStorage.getItem(lsk('caja_customer_name'))||'');
  const [extrasModal,setExtrasModal]=useState(null);
  const [pagoModal,setPagoModal]=useState(false);
  const [busy,setBusy]=useState(false);
  // ── Delivery (Part 1): campos estructurados + zona (DB) + canal + modo de pago ──
  const [delivPhone,setDelivPhone]=useState('');
  const [delivAddress,setDelivAddress]=useState('');
  const [delivRef,setDelivRef]=useState('');
  const [delivZoneId,setDelivZoneId]=useState('');
  const [delivChannel,setDelivChannel]=useState('propio');
  const [delivExtId,setDelivExtId]=useState('');     // Nº de pedido de la plataforma (obligatorio si canal ≠ Propio)
  const [delivPaid,setDelivPaid]=useState(false);   // false = contra-entrega (cobra el rider) · true = ya pagó en caja
  const [zones,setZones]=useState([]);
  const [channels,setChannels]=useState([]);

  useEffect(()=>{load();},[]);
  // Zonas desde delivery_zones (DB — misma fuente que la cotización del cliente).
  // Canales desde delivery_channels (DB, tenant-scoped, mig 162 — Parte 3).
  useEffect(()=>{
    if(!db) return;
    db.from('delivery_zones').select('id,name,price_guarani,estimated_minutes').eq('restaurant_id',RID).eq('is_active',true).order('price_guarani')
      .then(({data})=>setZones(data||[])).catch(()=>{});
    const DEF_CH=[{id:'propio',name:'Propio',commission:0,active:true},{id:'pedidosya',name:'PedidosYa',commission:18,active:true},{id:'monchis',name:'Monchis',commission:15,active:true}];
    // Defensivo: si la mig 162 no está aplicada o no hay filas, cae a los defaults en memoria.
    db.from('delivery_channels').select('slug,name,commission_pct,is_active').eq('restaurant_id',RID).eq('is_active',true).order('name')
      .then(({data,error})=>{
        if(error||!data||!data.length){ setChannels(DEF_CH); return; }
        setChannels(data.map(r=>({id:r.slug||'propio', name:r.name, commission:Number(r.commission_pct)||0, active:r.is_active!==false})));
      }).catch(()=>setChannels(DEF_CH));
  },[]);
  useEffect(()=>{localStorage.setItem(lsk('caja_cart'),JSON.stringify(cart));},[cart]);
  useEffect(()=>{localStorage.setItem(lsk('caja_order_type'),orderType);},[orderType]);
  useEffect(()=>{localStorage.setItem(lsk('caja_table_id'),tableId);},[tableId]);
  useEffect(()=>{localStorage.setItem(lsk('caja_customer_name'),customerName);},[customerName]);

  async function load(){
    try{
      const[{data:catData},{data:itemData},{data:tblData}]=await Promise.all([
        db.from('menu_categories').select('id,name,sort_order').eq('restaurant_id',RID).eq('is_active',true).order('sort_order'),
        db.from('menu_items').select('id,name,price_guarani,description,image_url,category_id,menu_item_extras(id,name,price_guarani)').eq('restaurant_id',RID).eq('is_available',true).order('sort_order'),
        db.from('tables').select('id,number').eq('restaurant_id',RID).order('number'),
      ]);
      const cs=catData||[];
      setCats(cs);setItems(itemData||[]);setTables(tblData||[]);
      if(cs.length>0)setSelCat(cs[0].id);
      menuCache.save(cs,itemData||[],tblData||[]);
    }catch(e){
      const cached=menuCache.load();
      if(cached.cats.length>0){
        setCats(cached.cats);setItems(cached.items);setTables(cached.tables);
        setSelCat(cached.cats[0].id);
        toast('Menú cargado desde caché (sin conexión)');
      }
    }
    setLoading(false);
  }

  const displayItems=useMemo(()=>selCat?items.filter(i=>i.category_id===selCat):items,[items,selCat]);

  /* ── cart ops ── */
  function addToCart(item,extras=[],obs=''){
    const xTotal=extras.reduce((s,e)=>s+Number(e.price_guarani||0),0);
    setCart(p=>[...p,{cartId:Math.random().toString(36).slice(2),item,quantity:1,extras,observations:obs,linePrice:Number(item.price_guarani)+xTotal}]);
  }
  function removeFromCart(cartId){setCart(p=>p.filter(c=>c.cartId!==cartId));}
  function setQty(cartId,qty){
    if(qty<=0){removeFromCart(cartId);return;}
    setCart(p=>p.map(c=>c.cartId===cartId?{...c,quantity:qty}:c));
  }
  function clickItem(item){
    const extras=item.menu_item_extras||[];
    if(extras.length>0){setExtrasModal({item,extras});}else{addToCart(item);}
  }

  const subtotal=cart.reduce((s,c)=>s+c.linePrice*c.quantity,0);

  function abrirPago(){
    if(cart.length===0){toast('El carrito está vacío',false);return;}
    if(orderType==='dine_in'&&!tableId){toast('Seleccioná una mesa o "Sin número de mesa"',false);return;}
    if(orderType==='delivery'){
      if(!customerName.trim()){toast('Nombre del cliente requerido',false);return;}
      if(!delivAddress.trim()){toast('Dirección de entrega requerida',false);return;}
      if(delivChannel!=='propio'&&!delivExtId.trim()){toast('Nº de pedido de la plataforma requerido',false);return;}
    }
    setPagoModal(true);
  }

  function onPagoConfirmado(movData,order){
    setPagoModal(false);
    if(movData&&onMovimiento)onMovimiento(movData);
    toast(`Pedido #${order?.order_number||''} ${order?.order_type==='delivery'?'enviado a despacho':'cobrado y enviado a cocina'} ✓`);
    setCart([]);setCustomerName('');setTableId('');
    setDelivPhone('');setDelivAddress('');setDelivRef('');setDelivZoneId('');setDelivChannel('propio');setDelivExtId('');setDelivPaid(false);
    localStorage.removeItem(lsk('caja_cart'));localStorage.removeItem(lsk('caja_customer_name'));localStorage.removeItem(lsk('caja_table_id'));
  }

  /* ── render ── */
  const TYPE_BTNS=[['dine_in','Salón'],['takeaway','Para llevar'],['delivery','Delivery']];

  return(
    <div className="page" style={{height:'calc(100vh - 48px)',display:'flex',flexDirection:'column',gap:12}}>
      {/* Header */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:8,flexShrink:0}}>
        <h1 style={{fontSize:20,fontWeight:800}}>Tomar Pedido</h1>
        <div style={{display:'flex',gap:6}}>
          {TYPE_BTNS.map(([t,lbl])=>(
            <button key={t} onClick={()=>{setOrderType(t);setTableId('');setCustomerName('');}} style={{
              padding:'6px 14px',fontSize:12,borderRadius:20,cursor:'pointer',
              fontWeight:orderType===t?700:400,
              border:`1px solid ${orderType===t?C.ink:C.border}`,
              background:orderType===t?C.ink:'transparent',
              color:orderType===t?C.surface:C.mid,
            }}>{lbl}</button>
          ))}
        </div>
      </div>

      {loading&&<div style={{textAlign:'center',padding:40}}><span className="spin"/></div>}

      {!loading&&(
        <div style={{flex:1,display:'grid',gridTemplateColumns:'1fr 310px',gap:14,minHeight:0,overflow:'hidden'}}>
          {/* ─ LEFT: menú ─ */}
          <div style={{display:'flex',flexDirection:'column',minHeight:0}}>
            {/* Categorías */}
            <div style={{display:'flex',gap:6,overflowX:'auto',paddingBottom:10,flexShrink:0}}>
              {cats.map(c=>(
                <button key={c.id} onClick={()=>setSelCat(c.id)} style={{
                  padding:'6px 14px',fontSize:12,borderRadius:20,cursor:'pointer',whiteSpace:'nowrap',
                  fontWeight:selCat===c.id?700:400,
                  border:`1px solid ${selCat===c.id?C.ink:C.border}`,
                  background:selCat===c.id?C.ink:'transparent',
                  color:selCat===c.id?'#FFFFFF':'#000000',
                }}>{c.name}</button>
              ))}
            </div>
            {/* Grid de productos — estilo POS con imágenes */}
            <div style={{flex:1,overflowY:'auto',paddingRight:4}}>
              {displayItems.length===0?(
                <div style={{color:C.mid,fontSize:13,padding:20}}>Sin productos disponibles</div>
              ):(
                <div className="ds-product-grid">
                  {displayItems.map(item=>{
                    const inCart=cart.filter(c=>c.item.id===item.id).reduce((s,c)=>s+c.quantity,0);
                    return(
                      <div key={item.id} className="ds-product-card" onClick={()=>clickItem(item)}>
                        {item.image_url
                          ? <img className="ds-product-card-img" src={item.image_url} alt={item.name}/>
                          : <div className="ds-product-card-placeholder"><Icon name="utensils" size={26} /></div>
                        }
                        {inCart>0&&<div className="ds-product-badge">{inCart}</div>}
                        <div className="ds-product-info">
                          <div className="ds-product-name">{item.name}</div>
                          <div className="ds-product-price">{fmt(item.price_guarani)}</div>
                          {(item.menu_item_extras||[]).length>0&&<div className="ds-product-extras-tag">+ extras</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* ─ RIGHT: carrito ─ */}
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,display:'flex',flexDirection:'column',minHeight:0,overflow:'hidden'}}>
            {/* Config del pedido */}
            <div style={{padding:'14px 16px',borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
              <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:10}}>PEDIDO ACTUAL</div>
              {orderType==='dine_in'?(
                <>
                  <Lbl required>MESA</Lbl>
                  <Sel value={tableId} onChange={e=>setTableId(e.target.value)}>
                    <option value="">Seleccionar…</option>
                    <option value="sin_mesa">— Sin número de mesa</option>
                    {tables.map(t=><option key={t.id} value={t.id}>Mesa {t.number}</option>)}
                  </Sel>
                </>
              ):orderType==='delivery'?(
                <div style={{display:'flex',flexDirection:'column',gap:8}}>
                  <div><Lbl required>NOMBRE</Lbl><Inp value={customerName} onChange={e=>setCustomerName(e.target.value)} placeholder="Nombre del cliente"/></div>
                  <div><Lbl>TELÉFONO</Lbl><Inp value={delivPhone} onChange={e=>setDelivPhone(e.target.value)} placeholder="09xx xxx xxx"/></div>
                  <div><Lbl required>DIRECCIÓN</Lbl><Inp value={delivAddress} onChange={e=>setDelivAddress(e.target.value)} placeholder="Calle, número, barrio"/></div>
                  <div><Lbl>REFERENCIA</Lbl><Inp value={delivRef} onChange={e=>setDelivRef(e.target.value)} placeholder="Casa, timbre, entre calles…"/></div>
                  <div><Lbl>ZONA / ENVÍO</Lbl>
                    <Sel value={delivZoneId} onChange={e=>setDelivZoneId(e.target.value)}>
                      <option value="">Sin zona (envío ₲0)</option>
                      {zones.map(z=><option key={z.id} value={z.id}>{z.name} — {fmt(z.price_guarani)}</option>)}
                    </Sel>
                  </div>
                  <div><Lbl>CANAL</Lbl>
                    <Sel value={delivChannel} onChange={e=>setDelivChannel(e.target.value)}>
                      {channels.filter(c=>c.active!==false).map(c=><option key={c.id} value={c.id}>{c.name}{c.commission?` (${c.commission}%)`:''}</option>)}
                    </Sel>
                  </div>
                  {delivChannel!=='propio'&&(
                    <div><Lbl required>Nº PEDIDO PLATAFORMA</Lbl><Inp value={delivExtId} onChange={e=>setDelivExtId(e.target.value)} placeholder="Ej: PY-8842193"/></div>
                  )}
                  <div><Lbl>PAGO</Lbl>
                    <div style={{display:'flex',gap:6}}>
                      {[[false,'Cobra el rider'],[true,'Ya pagó en caja']].map(([v,lbl])=>(
                        <button key={String(v)} onClick={()=>setDelivPaid(v)} style={{flex:1,padding:'8px 6px',fontSize:11,borderRadius:7,cursor:'pointer',fontWeight:delivPaid===v?700:400,border:`1px solid ${delivPaid===v?C.ink:C.border}`,background:delivPaid===v?C.ink:'transparent',color:delivPaid===v?C.surface:C.mid}}>{lbl}</button>
                      ))}
                    </div>
                  </div>
                  {(()=>{const fee=zones.find(z=>z.id===delivZoneId)?.price_guarani||0;return <div style={{fontSize:11,color:C.mid,display:'flex',justifyContent:'space-between'}}><span>Envío {fmt(fee)}</span><span style={{fontWeight:700}}>Total {fmt(subtotal+fee)}</span></div>;})()}
                </div>
              ):(
                <>
                  <Lbl>NOMBRE DEL CLIENTE</Lbl>
                  <Inp value={customerName} onChange={e=>setCustomerName(e.target.value)} placeholder="Nombre…"/>
                </>
              )}
            </div>

            {/* Ítems */}
            <div style={{flex:1,overflowY:'auto',padding:'10px 14px'}}>
              {cart.length===0?(
                <div style={{textAlign:'center',padding:'28px 0',color:C.mid}}>
                  <div style={{marginBottom:8,display:'flex',justifyContent:'center'}}><Icon name="cart" size={28} /></div>
                  <div style={{fontSize:11,fontWeight:500}}>Tocá un producto para agregarlo</div>
                </div>
              ):(
                <div style={{display:'flex',flexDirection:'column',gap:8}}>
                  {cart.map(c=>(
                    <div key={c.cartId} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:'10px 12px'}}>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:8}}>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:13,fontWeight:600,lineHeight:1.3}}>{c.item.name}</div>
                          {c.extras.length>0&&<div style={{fontSize:10,color:C.mid,marginTop:2}}>{c.extras.map(e=>e.name).join(', ')}</div>}
                          {c.observations&&<div style={{fontSize:10,color:C.yellow,marginTop:2}}><Icon name="fileText" size={10} style={{verticalAlign:'-1px',marginRight:2}}/> {c.observations}</div>}
                        </div>
                        <div style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:12,color:C.green,whiteSpace:'nowrap'}}>{fmt(c.linePrice*c.quantity)}</div>
                      </div>
                      <div style={{display:'flex',alignItems:'center',gap:6,marginTop:8}}>
                        <button onClick={()=>setQty(c.cartId,c.quantity-1)} style={{width:26,height:26,borderRadius:5,border:`1px solid ${C.border}`,background:'transparent',color:C.mid,fontSize:16,cursor:'pointer',lineHeight:1}}>−</button>
                        <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:700,fontSize:14,minWidth:20,textAlign:'center'}}>{c.quantity}</span>
                        <button onClick={()=>setQty(c.cartId,c.quantity+1)} style={{width:26,height:26,borderRadius:5,border:`1px solid ${C.border}`,background:'transparent',color:C.mid,fontSize:16,cursor:'pointer',lineHeight:1}}>+</button>
                        <button onClick={()=>removeFromCart(c.cartId)} style={{marginLeft:'auto',background:'none',border:'none',color:C.dim,cursor:'pointer',fontSize:15,padding:0}}>✕</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer carrito */}
            <div style={{padding:'14px 16px',borderTop:`1px solid ${C.border}`,flexShrink:0}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                <span style={{fontSize:11,color:C.mid,fontWeight:700}}>{cart.reduce((s,c)=>s+c.quantity,0)} ítem{cart.reduce((s,c)=>s+c.quantity,0)!==1?'s':''}</span>
                <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:22,fontWeight:800,color:C.green}}>{fmt(subtotal)}</span>
              </div>
              <div style={{display:'flex',gap:8}}>
                <Btn full onClick={abrirPago} disabled={cart.length===0} variant="success">
                  <Icon name="creditCard" size={14} style={{verticalAlign:'-2px',marginRight:5}}/>Cobrar y enviar →
                </Btn>
                {cart.length>0&&(
                  <button onClick={()=>setCart([])} style={{background:'none',border:`1px solid ${C.border}`,color:C.dim,borderRadius:6,padding:'0 10px',cursor:'pointer',fontSize:11,flexShrink:0}}>Limpiar</button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {pagoModal&&(
        <PagarAntesDeEnviarModal
          cart={cart}
          orderType={orderType}
          tableId={tableId}
          customerName={customerName}
          tables={tables}
          turno={turno}
          profile={profile}
          deliv={{phone:delivPhone,address:delivAddress,reference:delivRef,zoneId:delivZoneId,channel:delivChannel,externalId:delivExtId,paid:delivPaid}}
          zones={zones}
          channels={channels}
          onClose={()=>setPagoModal(false)}
          onConfirmed={onPagoConfirmado}
        />
      )}

      {extrasModal&&(
        <ExtrasModal
          item={extrasModal.item}
          extras={extrasModal.extras}
          onClose={()=>setExtrasModal(null)}
          onConfirm={(selectedExtras,obs)=>{addToCart(extrasModal.item,selectedExtras,obs);setExtrasModal(null);}}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   MODAL: DETALLE DE PEDIDO (Vista salón)
═══════════════════════════════════════════ */
function OrderDetailModal({order,onClose}){
  const [items,setItems]=useState([]);
  const [dInfo,setDInfo]=useState(null);
  useEffect(()=>{
    db.from('order_items').select('id,item_name,quantity,unit_price,observations,order_item_extras(extra_name,extra_price)')
      .eq('order_id',order.id).then(({data})=>setItems(data||[]));
    if(order.order_type==='delivery'){
      db.from('delivery_orders')
        .select('customer_name,customer_phone,delivery_address,rider_name,rider_status,delivery_fee,cash_amount,order_total')
        .eq('order_id',order.id).maybeSingle()
        .then(({data})=>setDInfo(data||null));
    }
  },[order.id]);
  const mesa=order.tables?.number?`Mesa ${order.tables.number}`:order.customer_name||'Sin identificar';
  const espera=Math.floor((Date.now()-new Date(order.created_at))/60000);
  const isDelivery=order.order_type==='delivery';
  const deliveryFee=dInfo?.delivery_fee||0;
  const cashAmt=dInfo?.cash_amount||0;
  const orderTot=dInfo?.order_total||Number(order.total)||0;
  const cashChg=cashAmt>0?cashAmt-orderTot:0;
  return(
    <Modal title={`Pedido #${order.order_number}`} onClose={onClose} width={440}>
      <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginBottom:14}}>
        <Badge txt={SL[order.status]||order.status} color={SC[order.status]||'#6E6E73'}/>
        {order.order_type&&<Badge txt={orderTypeLabel(order.order_type)} color={orderTypeColor(order.order_type)}/>}
        <span style={{fontSize:12,color:C.mid}}>{mesa}</span>
        <span style={{fontSize:11,color:C.dim,display:'inline-flex',alignItems:'center',gap:3}}><Icon name="clock" size={11} /> {espera}m</span>
      </div>

      {/* Info delivery */}
      {isDelivery&&dInfo&&(
        <div style={{background:'rgba(255,59,48,0.05)',border:'1px solid rgba(255,59,48,0.18)',borderRadius:9,padding:'10px 13px',marginBottom:14,fontSize:12}}>
          {(dInfo.customer_name||order.customer_name)&&<div style={{fontWeight:700,color:C.ink,marginBottom:3,display:'flex',alignItems:'center',gap:5}}><Icon name="user" size={12} /> {dInfo.customer_name||order.customer_name}</div>}
          {dInfo.customer_phone&&<div style={{color:C.mid,marginBottom:2,display:'flex',alignItems:'center',gap:5}}><Icon name="phone" size={12} /> {dInfo.customer_phone}</div>}
          {dInfo.delivery_address&&<div style={{color:C.mid,marginBottom:2,display:'flex',alignItems:'center',gap:5}}><Icon name="pin" size={12} /> {dInfo.delivery_address}</div>}
          {dInfo.rider_name
            ?<div style={{color:dInfo.rider_status==='delivered'?'#FF9500':'#34C759',fontWeight:700,marginTop:3,display:'flex',alignItems:'center',gap:5}}><Icon name="bike" size={12} /> Rider: {dInfo.rider_name}{dInfo.rider_status==='on_way'?' — En camino':dInfo.rider_status==='confirmed'?' — Esperando retiro':dInfo.rider_status==='delivered'?' — Entregado, pdte. cobro':''}</div>
            :<div style={{color:'#FF9500',fontWeight:600,marginTop:3,display:'flex',alignItems:'center',gap:5}}><Icon name="clock" size={12} /> Sin rider asignado</div>
          }
          {cashAmt>0&&cashChg>=0&&(
            <div style={{marginTop:6,paddingTop:6,borderTop:'1px solid rgba(255,59,48,0.15)'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <span style={{color:TINT.greenText,fontWeight:700,display:'inline-flex',alignItems:'center',gap:5}}><Icon name="money" size={12} /> Vuelto a llevar</span>
                <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:800,fontSize:14,color:TINT.greenText}}>{fmt(cashChg)}</span>
              </div>
              <div style={{fontSize:10,color:C.mid,marginTop:1}}>Cliente paga {fmt(cashAmt)} · total {fmt(orderTot)}</div>
            </div>
          )}
        </div>
      )}
      {isDelivery&&!dInfo&&<div style={{fontSize:11,color:C.dim,marginBottom:12}}>Cargando info delivery…</div>}

      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:12,marginBottom:12,minHeight:60}}>
        {items.length===0&&<div style={{color:C.dim,fontSize:12,textAlign:'center',padding:8}}>Cargando ítems…</div>}
        {items.map(it=>(
          <div key={it.id} style={{marginBottom:8}}>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:13}}>
              <span style={{fontWeight:600}}>{it.quantity}× {it.item_name}</span>
              <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",color:C.dim}}>{fmt(it.unit_price*it.quantity)}</span>
            </div>
            {it.observations&&<div style={{fontSize:11,color:C.yellow,marginLeft:12}}><Icon name="fileText" size={11} style={{verticalAlign:'-1px',marginRight:2}}/> {it.observations}</div>}
            {(it.order_item_extras||[]).map(ex=>(
              <div key={ex.extra_name} style={{fontSize:11,color:C.mid,marginLeft:12}}>+ {ex.extra_name}{ex.extra_price>0?` (${fmt(ex.extra_price)})`:''}</div>
            ))}
          </div>
        ))}
      </div>
      {isDelivery&&deliveryFee>0&&(
        <div style={{display:'flex',justifyContent:'space-between',fontSize:12,color:C.mid,marginBottom:6}}>
          <span>Costo delivery</span>
          <span style={{fontFamily:"'SF Mono',ui-monospace,monospace"}}>{fmt(deliveryFee)}</span>
        </div>
      )}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderTop:`1px solid ${C.border}`,marginBottom:14}}>
        <span style={{fontSize:13,fontWeight:700,color:C.mid}}>TOTAL</span>
        <span style={{fontSize:22,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.green}}>{fmt(order.total)}</span>
      </div>
      <Btn variant="ghost" full onClick={onClose}>Cerrar</Btn>
    </Modal>
  );
}

/* ══════════════════════════════════════════════
   MAPA DE ZONAS — componentes para caja
══════════════════════════════════════════════ */
const ZONAS_DEF_C=[
  {value:'salon',    label:'Salón',    bg:TINT.blueBg,   border:TINT.blueBorder,   dot:'#3B82F6'},
  {value:'terraza',  label:'Terraza',  bg:TINT.greenBg,  border:TINT.greenBorder,  dot:'#22C55E'},
  {value:'bar',      label:'Bar',      bg:TINT.amberBg,  border:TINT.amberBorder,  dot:'#F97316'},
  {value:'privado',  label:'Privado',  bg:TINT.purpleBg, border:TINT.purpleBorder, dot:'#A855F7'},
  {value:'exterior', label:'Exterior', bg:TINT.amberBg,  border:TINT.amberBorder,  dot:'#EAB308'},
];
const SHAPES_DEF_C=[{value:'square',label:'Cuadrada',icon:'□'},{value:'round',label:'Redonda',icon:'○'},{value:'rectangle',label:'Rectangular',icon:'▬'}];
const CELL_C=80; const GAP_C=14;
// Coordenadas virtuales 0-1000 (compartido con admin y mozo)
const VCOORD_MAX_C=1000;
const CANVAS_ASPECT_C=0.5;
function tdC(shape){if(shape==='rectangle')return{w:Math.round(CELL_C*1.65),h:Math.round(CELL_C*0.72)};return{w:CELL_C,h:CELL_C};}
function tbrC(shape){if(shape==='round')return'50%';if(shape==='rectangle')return 8;return 10;}
function defaultVPosC(idx,total){
  const cols=Math.min(Math.max(Math.ceil(Math.sqrt(Math.max(total,1))),3),6);
  const rows=Math.max(Math.ceil(total/cols),1);
  const col=idx%cols, row=Math.floor(idx/cols);
  const stepX=VCOORD_MAX_C/cols, stepY=VCOORD_MAX_C/Math.max(rows,1);
  return{vx:col*stepX+stepX/2,vy:row*stepY+stepY/2};
}
function vToPxC(vx,vy,cw,ch,tw,th){
  const cx=(vx/VCOORD_MAX_C)*cw, cy=(vy/VCOORD_MAX_C)*ch;
  return{x:Math.max(0,Math.min(cw-tw,cx-tw/2)),y:Math.max(0,Math.min(ch-th,cy-th/2))};
}
function pxToVC(px,py,cw,ch,tw,th){
  const cx=px+tw/2, cy=py+th/2;
  return{vx:Math.max(0,Math.min(VCOORD_MAX_C,(cx/Math.max(cw,1))*VCOORD_MAX_C)),vy:Math.max(0,Math.min(VCOORD_MAX_C,(cy/Math.max(ch,1))*VCOORD_MAX_C))};
}

/* ── Reservas: util compartido para mozo/caja/admin ── */
function buildReservationByTableC(reservations, nowMs, windowHours, alertMinutes) {
  const map = {};
  const d = new Date(nowMs);
  const todayStr = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  const winMs = windowHours*3600*1000;
  const tolMs = 15*60*1000;
  (reservations||[]).forEach(r=>{
    if(r.status!=='confirmed') return;
    if(r.reservation_date!==todayStr) return;
    if(!r.table_id) return;
    const t=(r.reservation_time||'00:00:00').slice(0,8);
    const resMs=new Date(`${r.reservation_date}T${t.length===5?t+':00':t}`).getTime();
    if(isNaN(resMs)) return;
    const dt=resMs-nowMs;
    if(dt>winMs) return;
    if(dt<-tolMs) return;
    map[r.table_id]={reservation:r,_timeMs:resMs,_alertMinutes:alertMinutes,_minutesUntil:Math.round(dt/60000)};
  });
  return map;
}

function ZonaCaja({zona,tables,ordersByTable,sessionTotals,reservationByTable,editMode,dragging,dragOff,setDragging,setDragOff,setTables,onTableClick,onEditTable,layout='map'}){
  const canvasRef=React.useRef(null);
  const zd=ZONAS_DEF_C.find(z=>z.value===zona)||ZONAS_DEF_C[0];
  const [canvasW,setCanvasW]=React.useState(0);
  const isGrid=layout==='grid';
  React.useEffect(()=>{
    if(isGrid||!canvasRef.current)return;
    const update=()=>{if(canvasRef.current)setCanvasW(canvasRef.current.offsetWidth);};
    update();
    const ro=new ResizeObserver(update);
    ro.observe(canvasRef.current);
    return()=>ro.disconnect();
  },[isGrid]);
  const canvasH=Math.max(Math.round(canvasW*CANVAS_ASPECT_C),160);
  // Tamaño de mesa proporcional al lienzo (constreñido) — que no queden chiquitas.
  const cellMap=Math.round(CELL_C*Math.min(Math.max(canvasW/820,0.55),1.12));
  const dimsMap=shape=>shape==='rectangle'?{w:Math.round(cellMap*1.65),h:Math.round(cellMap*0.72)}:{w:cellMap,h:cellMap};
  function onPointerDown(e,t){
    if(!editMode)return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const rect=e.currentTarget.getBoundingClientRect();
    setDragOff({x:e.clientX-rect.left,y:e.clientY-rect.top,zona,pointerId:e.pointerId});
    setDragging(t.id);
  }
  function onPointerMove(e){
    if(!dragging||!canvasRef.current||dragOff.zona!==zona)return;
    e.preventDefault();
    const cr=canvasRef.current.getBoundingClientRect();
    const t=tables.find(x=>x.id===dragging);
    if(!t)return;
    const{w,h}=dimsMap(t.shape||'square');
    const px=Math.max(0,Math.min(cr.width-w,e.clientX-cr.left-dragOff.x));
    const py=Math.max(0,Math.min(cr.height-h,e.clientY-cr.top-dragOff.y));
    const{vx,vy}=pxToVC(px,py,cr.width,cr.height,w,h);
    setTables(prev=>prev.map(x=>x.id===dragging?{...x,pos_x:vx,pos_y:vy}:x));
  }
  async function onPointerUp(){
    if(!dragging||dragOff.zona!==zona)return;
    const t=tables.find(x=>x.id===dragging);
    if(t&&db)await db.from('tables').update({pos_x:Math.round(t.pos_x),pos_y:Math.round(t.pos_y)}).eq('id',t.id);
    setDragging(null);
  }
  function getTableStatus(t){
    const order=ordersByTable[t.id];
    const occ=t.is_occupied||!!order;
    let base;
    if(!occ) base='libre';
    else if(!order) base='ocupada';
    else if(order.status==='ready') base='lista';
    else if(['cooking','kitchen_received'].includes(order.status)) base='cocina';
    else if(order.status==='pending_payment'&&order.payment_status!=='paid') base='cobro';
    else base='ocupada';
    const r=reservationByTable&&reservationByTable[t.id];
    if(r){
      if(base!=='libre'&&r._minutesUntil<=r._alertMinutes) return 'alerta_reserva';
      if(base==='libre') return 'reservada';
    }
    return base;
  }
  const SC_C={
    libre:{bg:'#FFFFFF',bd:'#D2D2D7',tx:'#000000'},
    ocupada:{bg:'#1D1D1F',bd:'#1D1D1F',tx:'#FFFFFF'},
    cocina:{bg:'#555555',bd:'#555555',tx:'#FFFFFF'},
    lista:{bg:'#FFFFFF',bd:'#000000',tx:'#000000'},
    cobro:{bg:'#FFF4E5',bd:'#FF9500',tx:'#C05300'},
    reservada:{bg:'#FFF7ED',bd:'#FF9500',tx:'#B45309'},
    alerta_reserva:{bg:'#FEE2E2',bd:'#DC2626',tx:'#991B1B'},
  };
  // Contenido interno de la mesa (compartido map+grid; escala por numF/subF).
  function tileInner(t,status,sc,sesTotal,numF,subF){
    return(<>
      {sesTotal>0&&<div style={{fontSize:Math.max(subF-1,7),color:sc.tx==='#FFFFFF'?'rgba(255,255,255,0.85)':'#22C55E',fontWeight:700,lineHeight:1,marginBottom:2,fontFamily:"'SF Mono',ui-monospace,monospace"}}>{fmt(sesTotal)}</div>}
      <div style={{fontSize:numF,fontWeight:800,color:sc.tx,lineHeight:1}}>{t.number}</div>
      {status==='libre'
        ?<div style={{fontSize:subF,color:C.dim,marginTop:2,fontWeight:500}}>Libre</div>
        :<div style={{fontSize:subF,color:sc.tx,marginTop:2,fontWeight:status==='alerta_reserva'?800:500}}>
          {status==='cocina'?'Cocina':status==='lista'?'Lista':status==='cobro'?'A cobrar':status==='reservada'?'Reservada':status==='alerta_reserva'?'¡Liberar!':'Ocupada'}
        </div>}
      {(status==='reservada'||status==='alerta_reserva')&&(reservationByTable&&reservationByTable[t.id])
        ?<div style={{fontSize:subF,color:sc.tx,marginTop:1,fontWeight:700}}>{reservationByTable[t.id].reservation.reservation_time?.slice(0,5)} · {reservationByTable[t.id].reservation.guests}p</div>
        :<div style={{fontSize:subF,color:sc.tx==='#FFFFFF'?'rgba(255,255,255,0.5)':'#86868B',marginTop:2}}>{t.capacity||4} pax</div>}
      {editMode&&<div style={{position:'absolute',top:3,right:5,fontSize:9,color:C.dim}}>✎</div>}
    </>);
  }
  const header=(
    <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}>
      <div style={{width:8,height:8,borderRadius:'50%',background:zd.dot}}/>
      <div style={{fontSize:12,fontWeight:700,color:C.mid,textTransform:'uppercase',letterSpacing:'0.5px'}}>{zd.label}</div>
      <div style={{fontSize:11,color:C.dim}}>· {tables.length} {tables.length===1?'mesa':'mesas'}</div>
    </div>
  );

  // ── Vista CUADRÍCULA: grilla responsive, sin lienzo ni drag ──
  if(isGrid){
    return(
      <div style={{marginBottom:16}}>
        {header}
        {tables.length===0
          ?<div style={{color:C.dim,fontSize:12,padding:'8px 0 4px',fontWeight:500}}>Sin mesas en {zd.label.toLowerCase()}</div>
          :<div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(96px,1fr))',gap:10}}>
            {tables.map(t=>{
              const shape=t.shape||'square';
              const status=getTableStatus(t);
              const sc=SC_C[status]||SC_C.libre;
              const order=ordersByTable[t.id];
              const sesTotal=sessionTotals[t.id]||0;
              return(
                <div key={t.id} onClick={()=>editMode?onEditTable(t):onTableClick(t,order)}
                  style={{position:'relative',minHeight:92,padding:'10px 6px',borderRadius:shape==='round'?'50%':12,
                    background:sc.bg,border:`2px solid ${sc.bd}`,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',
                    cursor:'pointer',userSelect:'none',boxShadow:'0 1px 3px rgba(0,0,0,0.06)',aspectRatio:shape==='round'?'1/1':'auto'}}>
                  {tileInner(t,status,sc,sesTotal,18,9)}
                </div>
              );
            })}
          </div>}
      </div>
    );
  }

  // ── Vista MAPA: lienzo constreñido (max-width, centrado) + mesas escaladas ──
  const numF=Math.max(Math.round(cellMap*0.2),13);
  const subF=Math.max(Math.round(cellMap*0.105),8);
  return(
    <div style={{marginBottom:16}}>
      {header}
      <div ref={canvasRef} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        style={{position:'relative',width:'100%',maxWidth:880,margin:'0 auto',height:canvasH,background:zd.bg,border:`1.5px solid ${zd.border}`,borderRadius:10,overflow:'hidden',touchAction:editMode?'none':'auto'}}>
        {tables.length===0&&<div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',color:C.dim,fontSize:12}}>Sin mesas en {zd.label.toLowerCase()}</div>}
        {canvasW>0 && tables.map((t,idx)=>{
          const shape=t.shape||'square';
          const{w,h}=dimsMap(shape);
          const br=tbrC(shape);
          const hasPos=t.pos_x!=null&&t.pos_y!=null;
          const v=hasPos?{vx:t.pos_x,vy:t.pos_y}:defaultVPosC(idx,tables.length);
          const pos=vToPxC(v.vx,v.vy,canvasW,canvasH,w,h);
          const status=getTableStatus(t);
          const sc=SC_C[status]||SC_C.libre;
          const order=ordersByTable[t.id];
          const sesTotal=sessionTotals[t.id]||0;
          const isDrag=dragging===t.id;
          return(
            <div key={t.id}
              onPointerDown={e=>onPointerDown(e,t)}
              onClick={()=>editMode?onEditTable(t):onTableClick(t,order)}
              style={{position:'absolute',left:pos.x,top:pos.y,width:w,height:h,
                background:sc.bg,border:`2px solid ${sc.bd}`,borderRadius:br,
                display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',
                cursor:editMode?'grab':'pointer',userSelect:'none',touchAction:editMode?'none':'auto',
                transition:isDrag?'none':'box-shadow .15s',
                boxShadow:isDrag?'0 8px 24px rgba(0,0,0,0.22)':'0 1px 3px rgba(0,0,0,0.06)',
                zIndex:isDrag?10:1,
              }}>
              {tileInner(t,status,sc,sesTotal,shape==='rectangle'?Math.max(numF-2,11):numF,subF)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NuevaMesaModalC({onSave,onClose}){
  const [form,setForm]=React.useState({number:'',capacity:'4',zona:'salon',shape:'square'});
  const [saving,setSaving]=React.useState(false);
  async function save(){
    const num=parseInt(form.number);
    if(isNaN(num)||num<1){toast('Número de mesa requerido',false);return;}
    setSaving(true);
    const token=(crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2)).replace(/-/g,'').slice(0,16);
    const{error}=await db.from('tables').insert({restaurant_id:RID,number:num,capacity:parseInt(form.capacity)||4,qr_token:token,pos_x:null,pos_y:null,zona:form.zona||'salon',shape:form.shape||'square'}).select().single();
    setSaving(false);
    if(error){toast('Error: '+error.message,false);return;}
    toast('Mesa '+num+' creada');
    onSave();
  }
  return(
    <Modal title="Nueva mesa" onClose={onClose} width={380}>
      <div style={{display:'flex',flexDirection:'column',gap:14}}>
        <div className="my-row-2" style={{gap:10}}>
          <div><Lbl>NÚMERO *</Lbl><Inp type="number" value={form.number} onChange={e=>setForm(f=>({...f,number:e.target.value}))} placeholder="1"/></div>
          <div><Lbl>LUGARES (pax)</Lbl><Inp type="number" value={form.capacity} onChange={e=>setForm(f=>({...f,capacity:e.target.value}))} placeholder="4"/></div>
        </div>
        <div>
          <Lbl>ZONA / SECTOR</Lbl>
          <div style={{display:'flex',gap:6,flexWrap:'wrap',marginTop:4}}>
            {ZONAS_DEF_C.map(z=>(
              <button key={z.value} type="button" onClick={()=>setForm(prev=>({...prev,zona:z.value}))}
                style={{padding:'5px 12px',borderRadius:20,border:`1.5px solid ${form.zona===z.value?C.ink:C.border}`,background:form.zona===z.value?C.ink:'transparent',color:form.zona===z.value?C.surface:C.ink,fontSize:12,cursor:'pointer',fontWeight:form.zona===z.value?700:400}}>
                {z.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <Lbl>FORMA DE LA MESA</Lbl>
          <div style={{display:'flex',gap:8,marginTop:4}}>
            {SHAPES_DEF_C.map(s=>(
              <button key={s.value} type="button" onClick={()=>setForm(prev=>({...prev,shape:s.value}))}
                style={{flex:1,padding:'10px 6px',borderRadius:8,border:`2px solid ${form.shape===s.value?C.ink:C.border}`,background:form.shape===s.value?C.ink:'transparent',color:form.shape===s.value?C.surface:C.ink,fontSize:11,cursor:'pointer',fontWeight:600,textAlign:'center',display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
                <span style={{fontSize:18,pointerEvents:'none'}}>{s.icon}</span>
                <span style={{pointerEvents:'none'}}>{s.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div style={{display:'flex',gap:8,marginTop:4}}>
          <Btn onClick={save} disabled={saving}>{saving?'Guardando…':'Crear mesa'}</Btn>
          <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        </div>
      </div>
    </Modal>
  );
}

function MesaEditModalC({table,onSave,onClose}){
  const [form,setForm]=React.useState({number:String(table.number),capacity:String(table.capacity||4),zona:table.zona||'salon',shape:table.shape||'square'});
  const [saving,setSaving]=React.useState(false);
  async function save(){
    const num=parseInt(form.number);
    if(isNaN(num)||num<1)return;
    setSaving(true);
    const zonaChanged=table.zona!==form.zona;
    const upd={number:num,capacity:parseInt(form.capacity)||4,zona:form.zona||'salon',shape:form.shape||'square'};
    if(zonaChanged){upd.pos_x=null;upd.pos_y=null;}
    const{error}=await db.from('tables').update(upd).eq('id',table.id);
    setSaving(false);
    if(error){toast('Error: '+error.message,false);return;}
    onSave();
  }
  async function del(){
    if(!window.confirm(`¿Eliminar Mesa ${table.number}?`))return;
    const{error}=await db.from('tables').delete().eq('id',table.id);
    if(error){toast('Error: '+error.message,false);return;}
    onSave();
  }
  return(
    <Modal title={`Editar Mesa ${table.number}`} onClose={onClose} width={400}>
      <div style={{display:'flex',flexDirection:'column',gap:14}}>
        <div className="my-row-2" style={{gap:10}}>
          <div><Lbl>NÚMERO *</Lbl><Inp type="number" value={form.number} onChange={e=>setForm(f=>({...f,number:e.target.value}))} placeholder="1"/></div>
          <div><Lbl>LUGARES (pax)</Lbl><Inp type="number" value={form.capacity} onChange={e=>setForm(f=>({...f,capacity:e.target.value}))} placeholder="4"/></div>
        </div>
        <div>
          <Lbl>ZONA / SECTOR</Lbl>
          <div style={{display:'flex',gap:6,flexWrap:'wrap',marginTop:4}}>
            {ZONAS_DEF_C.map(z=>(
              <button key={z.value} type="button" onClick={()=>setForm(prev=>({...prev,zona:z.value}))}
                style={{padding:'5px 12px',borderRadius:20,border:`1.5px solid ${form.zona===z.value?C.ink:C.border}`,background:form.zona===z.value?C.ink:'transparent',color:form.zona===z.value?C.surface:C.ink,fontSize:12,cursor:'pointer',fontWeight:form.zona===z.value?700:400}}>
                {z.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <Lbl>FORMA DE LA MESA</Lbl>
          <div style={{display:'flex',gap:8,marginTop:4}}>
            {SHAPES_DEF_C.map(s=>(
              <button key={s.value} type="button" onClick={()=>setForm(prev=>({...prev,shape:s.value}))}
                style={{flex:1,padding:'10px 6px',borderRadius:8,border:`2px solid ${form.shape===s.value?C.ink:C.border}`,background:form.shape===s.value?C.ink:'transparent',color:form.shape===s.value?C.surface:C.ink,fontSize:11,cursor:'pointer',fontWeight:600,textAlign:'center',display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
                <span style={{fontSize:18,pointerEvents:'none'}}>{s.icon}</span><span style={{pointerEvents:'none'}}>{s.label}</span>
              </button>
            ))}
          </div>
        </div>
        {table.zona!==form.zona&&(
          <div style={{fontSize:11,color:C.dim,background:TINT.amberBg,border:`1px solid ${TINT.amberBorder}`,borderRadius:6,padding:'8px 10px'}}>
            Al cambiar de zona, la mesa se reposicionará automáticamente.
          </div>
        )}
        <div style={{display:'flex',gap:8,marginTop:4}}>
          <Btn onClick={save} disabled={saving}>{saving?'Guardando…':'Guardar'}</Btn>
          <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
          <Btn variant="danger" small onClick={del}>Eliminar</Btn>
        </div>
      </div>
    </Modal>
  );
}

/* ═══════════════════════════════════════════
   PANEL: VISTA DEL SALÓN
═══════════════════════════════════════════ */
function SalonPanel({turno,profile}){
  const [tables,setTables]=useState([]);
  const [orders,setOrders]=useState([]);
  const [sessionTotals,setSessionTotals]=useState({});
  const [loading,setLoading]=useState(true);
  const [selTable,setSelTable]=useState(null); // {table, orders: []}
  const [selOrder,setSelOrder]=useState(null);
  const [cancelTarget,setCancelTarget]=useState(null);
  const [editMode,setEditMode]=useState(false);
  const [mesaViewMode,setMesaViewMode]=useState(()=>localStorage.getItem('caja_mesa_view')||'grid'); // default desktop = Cuadrícula
  const [dragging,setDragging]=useState(null);
  const [dragOff,setDragOff]=useState({x:0,y:0,zona:null});
  const [mesaEdit,setMesaEdit]=useState(null);
  const [newMesa,setNewMesa]=useState(false);
  const [reservationsToday,setReservationsToday]=useState([]);
  const [resvConfig,setResvConfig]=useState({window:3,alertMin:30});
  const [nowTick,setNowTick]=useState(Date.now());
  const [resvInfo,setResvInfo]=useState(null);
  const [qrModal,setQrModal]=useState(false);
  const ACTIVE=['paid','pending_payment','kitchen_received','cooking','ready'];

  useEffect(()=>{
    const id=setInterval(()=>setNowTick(Date.now()),60000);
    return()=>clearInterval(id);
  },[]);
  useEffect(()=>{localStorage.setItem('caja_mesa_view',mesaViewMode);},[mesaViewMode]);

  const reservationByTable=useMemo(
    ()=>buildReservationByTableC(reservationsToday,nowTick,resvConfig.window,resvConfig.alertMin),
    [reservationsToday,nowTick,resvConfig.window,resvConfig.alertMin]
  );

  useEffect(()=>{
    load();
    if(!db)return;
    const ch=db.channel('salon-realtime')
      .on('postgres_changes',{event:'*',schema:'public',table:'orders',filter:`restaurant_id=eq.${RID}`},()=>load())
      .on('postgres_changes',{event:'*',schema:'public',table:'tables',filter:`restaurant_id=eq.${RID}`},()=>load())
      .subscribe();
    const onVisible=()=>{if(document.visibilityState==='visible')load();};
    document.addEventListener('visibilitychange',onVisible);
    return()=>{db.removeChannel(ch);document.removeEventListener('visibilitychange',onVisible);};
  },[]);

  async function load(){
    // Fecha del local: con la UTC, después de las 21:00 caja pedía las reservas de
    // MAÑANA y no veía ninguna de esta noche.
    const todayStr=todayLocal();
    // Pickup pagado entregado hace <10 min: lo mostramos en caja unos minutos
    // luego cae al historial. (Filtro real visible es 6 min — la query trae
    // 10 para evitar parpadeos por desfase de reloj.)
    const sincePickupISO=new Date(Date.now()-10*60*1000).toISOString();
    const[{data:tbl},{data:ord},{data:pickupDone},{data:resv},{data:rest}]=await Promise.all([
      db.from('tables').select('id,number,capacity,is_occupied,occupied_since,zona,shape,pos_x,pos_y,assigned_waiter_name').eq('restaurant_id',RID).order('number'),
      db.from('orders')
        .select('id,order_number,status,payment_status,total,order_type,customer_name,created_at,table_id,requires_invoice,invoice_delivery_method,invoice_status,completed_at,tables(number)')
        .eq('restaurant_id',RID).in('status',ACTIVE)
        .order('created_at',{ascending:true}),
      db.from('orders')
        .select('id,order_number,status,payment_status,total,order_type,customer_name,created_at,table_id,requires_invoice,invoice_delivery_method,invoice_status,completed_at')
        .eq('restaurant_id',RID).eq('status','delivered').eq('payment_status','paid')
        .is('table_id',null).gte('completed_at',sincePickupISO)
        .order('completed_at',{ascending:false}),
      db.from('reservations').select('*').eq('restaurant_id',RID).eq('reservation_date',todayStr).eq('status','confirmed'),
      db.from('restaurants').select('reservation_window_hours,reservation_alert_minutes').eq('id',RID).maybeSingle(),
    ]);
    const allTables=tbl||[];
    // Mergear pickup pagado entregado reciente con los activos
    const ordsMerged=[...(ord||[]),...(pickupDone||[])];
    setTables(allTables);setOrders(ordsMerged);
    setReservationsToday(resv||[]);
    if(rest)setResvConfig({window:Number(rest.reservation_window_hours??3),alertMin:Number(rest.reservation_alert_minutes??30)});

    // Totales de sesión para mesas ocupadas
    const occIds=allTables.filter(t=>t.is_occupied).map(t=>t.id);
    if(occIds.length>0){
      const{data:sessData}=await db.from('orders').select('table_id,total')
        .eq('restaurant_id',RID).in('table_id',occIds).neq('status','cancelled');
      const st={};
      (sessData||[]).forEach(o=>{st[o.table_id]=(st[o.table_id]||0)+Number(o.total||0);});
      setSessionTotals(st);
    } else {
      setSessionTotals({});
    }
    setLoading(false);
  }

  async function liberarMesa(tableId,tableNum){
    if(!db)return;
    if(!window.confirm(`¿Confirmar que el servicio de Mesa ${tableNum} concluyó y la mesa está libre?`))return;
    await db.from('tables').update({is_occupied:false,occupied_since:null}).eq('id',tableId);
    toast(`Mesa ${tableNum} liberada`);
    setSelTable(null);
    load();
  }

  async function ocuparMesa(tableId,tableNum){
    if(!db)return;
    await db.from('tables').update({is_occupied:true,occupied_since:new Date().toISOString()}).eq('id',tableId);
    toast(`Mesa ${tableNum} marcada como ocupada`);
    setSelTable(null);
    load();
  }

  async function loadTableSession(table){
    if(!db)return;
    let q=db.from('orders')
      .select('id,order_number,status,payment_status,total,created_at,waiter_name,order_items(id,item_name,quantity,unit_price,observations,order_item_extras(extra_name,extra_price))')
      .eq('restaurant_id',RID).eq('table_id',table.id).neq('status','cancelled')
      .order('created_at',{ascending:false});
    if(table.occupied_since) q=q.gte('created_at',table.occupied_since);
    const{data}=await q;
    setSelTable({table,orders:data||[]});
  }

  const ordersByTable=useMemo(()=>{
    const m={};(orders||[]).forEach(o=>{if(o.table_id)m[o.table_id]=o;});return m;
  },[orders]);

  // 'delivered' solo aplica a pickup pagado reciente (lo trae la query secundaria).
  // Para dine-in/delivery filtramos para no mostrar entregados aunque aparezcan.
  const SIX_MIN=6*60*1000;
  const isRecentDeliveredPickup=o=>o.status==='delivered'&&o.completed_at&&(nowTick-new Date(o.completed_at).getTime()<SIX_MIN);
  const dineInOrders  =orders.filter(o=>o.table_id&&o.status!=='delivered');
  const deliveryOrders =orders.filter(o=>!o.table_id&&o.order_type==='delivery'&&o.status!=='delivered');
  // Salón sin mesa: mostrador, local, dine_in sin table_id, etc.
  const salonOrders   =orders.filter(o=>!o.table_id&&!['takeaway','llevar','delivery','pickup'].includes(o.order_type));
  // Para llevar: el cliente retira y se va
  const llevarOrders  =orders.filter(o=>!o.table_id&&(o.order_type==='takeaway'||o.order_type==='llevar'));
  // Para retirar: pagó online y viene a buscar
  const retirarOrders =orders.filter(o=>!o.table_id&&o.order_type==='pickup');
  const pickupAll     =[...salonOrders,...llevarOrders,...retirarOrders]; // para KPI total
  const _paid=o=>o.payment_status==='paid'&&(o.status!=='delivered'||isRecentDeliveredPickup(o));
  const _unpaid=o=>o.payment_status!=='paid';
  const salonACobrar  =salonOrders.filter(_unpaid);
  const salonPagado   =salonOrders.filter(_paid);
  const llevarACobrar =llevarOrders.filter(_unpaid);
  const llevarPagado  =llevarOrders.filter(_paid);
  const retirarACobrar=retirarOrders.filter(_unpaid);
  const retirarPagado =retirarOrders.filter(_paid);
  const kitchenCount  =orders.filter(o=>['kitchen_received','cooking'].includes(o.status)).length;
  const readyCount    =orders.filter(o=>o.status==='ready').length;
  const totalEnProceso=Object.values(sessionTotals).reduce((s,v)=>s+v,0)||orders.reduce((s,o)=>s+Number(o.total),0);
  const ocupadas      =tables.filter(t=>t.is_occupied).length;

  function statusAccent(s){
    return s==='ready'?C.green:s==='cooking'?C.orange:s==='kitchen_received'?C.blue:C.yellow;
  }

  function TableCard({table}){
    const order=ordersByTable[table.id];
    const occ=table.is_occupied??!!order;
    const accent=occ?(order?statusAccent(order.status):C.green):C.border;
    const espera=order?Math.floor((Date.now()-new Date(order.created_at))/60000):0;
    const sesTotal=sessionTotals[table.id]||0;
    const tableInvoiceReq=(orders||[]).some(o=>o.table_id===table.id && o.requires_invoice && (o.invoice_status||'pending')==='pending');
    return(
      <div onClick={()=>occ&&loadTableSession(table)} style={{
        background:occ?C.ink:C.surface,
        border:`2px solid ${accent}`,borderRadius:12,padding:18,
        cursor:occ?'pointer':'default',minHeight:140,position:'relative',
        transition:'border-color .2s, transform .1s',
        boxShadow:occ?'0 2px 12px rgba(0,0,0,0.15)':'none',
      }}
        onMouseEnter={e=>{if(occ)e.currentTarget.style.transform='translateY(-2px)';}}
        onMouseLeave={e=>{e.currentTarget.style.transform='';}}
      >
        {/* Monto del servicio — visible arriba */}
        {sesTotal>0&&(
          <div style={{fontSize:12,fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:800,color:'#34C759',marginBottom:6}}>
            {fmt(sesTotal)}
          </div>
        )}
        <div style={{fontSize:22,fontWeight:800,color:occ?C.surface:C.ink,letterSpacing:'-0.5px'}}>Mesa {table.number}</div>
        {tableInvoiceReq&&(()=>{const m=(orders||[]).find(o=>o.table_id===table.id && o.requires_invoice && (o.invoice_status||'pending')==='pending')?.invoice_delivery_method;return(
          <div style={{position:'absolute',top:8,right:8,background:'#007AFF',color:'#fff',fontSize:10,fontWeight:800,padding:'3px 7px',borderRadius:8,letterSpacing:'0.04em',display:'flex',alignItems:'center',gap:3}}>
            <Icon name="receipt" size={10} /> {m==='email'?'EMAIL':'IMPRESA'}
          </div>
        );})()}
        {table.capacity&&<div style={{fontSize:12,color:occ?C.dim:C.mid,marginTop:2}}>{table.capacity} pax</div>}
        {occ?(
          <>
            {order&&<div style={{marginTop:10}}><Badge txt={SL[order.status]} color={SC[order.status]||'#6E6E73'}/></div>}
            {!order&&<div style={{marginTop:10}}><Badge txt="Servicio activo" color={C.green}/></div>}
            {order&&<div style={{fontSize:11,color:C.dim,marginTop:8}}>◷ {espera}m · #{order.order_number}</div>}
            {table.assigned_waiter_name&&<div style={{fontSize:11,color:C.dim,marginTop:4,display:'flex',alignItems:'center',gap:4}}><Icon name="user" size={11} /> {table.assigned_waiter_name}</div>}
          </>
        ):(
          <div style={{color:C.mid,fontSize:13,marginTop:12,fontWeight:700,letterSpacing:'0.05em'}}>LIBRE</div>
        )}
      </div>
    );
  }

  function OrderRow({order,allowCancel}){
    const espera=Math.floor((Date.now()-new Date(order.created_at))/60000);
    const name=order.customer_name?` — ${order.customer_name}`:'';
    const tipo=orderTypeLabel(order.order_type);
    const esPickupPagado=!order.table_id&&order.payment_status==='paid';
    const entregadoHace=esPickupPagado&&order.status==='delivered'&&order.completed_at
      ?Math.max(0,6-Math.floor((nowTick-new Date(order.completed_at).getTime())/60000))
      :null;
    const statusLbl=esPickupPagado
      ?(order.status==='delivered'?`✓ Entregado · oculta en ${entregadoHace}m`:'✓ Pagado · en cocina')
      :(SL[order.status]||order.status);
    const statusCol=esPickupPagado?C.green:(SC[order.status]||'#6E6E73');
    return(
      <div style={{
        background:C.surface,border:`1px solid ${statusCol}44`,
        borderRadius:8,padding:'10px 14px',
        display:'flex',flexDirection:'column',gap:8,
      }}>
        <div onClick={()=>setSelOrder(order)} style={{cursor:'pointer',display:'flex',justifyContent:'space-between',alignItems:'center',gap:10}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:13,fontWeight:700,fontFamily:"'SF Mono',ui-monospace,monospace",overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
              #{order.order_number}{name}
            </div>
            <div style={{display:'flex',gap:6,marginTop:5,alignItems:'center',flexWrap:'wrap'}}>
              <Badge txt={statusLbl} color={statusCol}/>
              {tipo&&<Badge txt={tipo} color={orderTypeColor(order.order_type)}/>}
              {order.requires_invoice&&(order.invoice_status||'pending')==='pending'&&(
                <Badge txt={`${order.invoice_delivery_method==='email'?'Factura email':'Factura impresa'}`} color={'#007AFF'}/>
              )}
              <span style={{fontSize:10,color:C.mid,display:'inline-flex',alignItems:'center',gap:3}}><Icon name="clock" size={10} /> {espera}m</span>
            </div>
          </div>
          <div style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:15,fontWeight:800,color:C.green,whiteSpace:'nowrap'}}>{fmt(order.total)}</div>
        </div>
        {allowCancel&&(
          <div style={{display:'flex',justifyContent:'flex-end'}}>
            <button
              onClick={e=>{e.stopPropagation();setCancelTarget(order);}}
              title="Cancelar pedido"
              style={{padding:'5px 10px',background:'transparent',color:C.red,border:`1px solid ${C.red}55`,borderRadius:6,fontSize:11,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap',letterSpacing:0.2,display:'inline-flex',alignItems:'center',gap:4}}>
              <Icon name="x" size={12} /> Cancelar
            </button>
          </div>
        )}
      </div>
    );
  }

  const SideSection=({title,list,emptyMsg,accent,desc,allowCancel})=>(
    <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:16}}>
      <div style={{marginBottom:10}}>
        <div style={{fontSize:11,color:accent||'#1D1D1F',fontWeight:800,letterSpacing:'0.05em'}}>
          {title} <span style={{background:accent+'22',color:accent,border:`1px solid ${accent}44`,padding:'1px 7px',fontSize:10,borderRadius:10,fontWeight:700,marginLeft:4}}>{list.length}</span>
        </div>
        {desc&&<div style={{fontSize:11,color:C.mid,marginTop:3}}>{desc}</div>}
      </div>
      {list.length===0?(
        <div style={{color:C.mid,fontSize:12,padding:'8px 0',fontWeight:500}}>{emptyMsg}</div>
      ):(
        <div style={{display:'flex',flexDirection:'column',gap:8}}>
          {list.map(o=><OrderRow key={o.id} order={o} allowCancel={allowCancel}/>)}
        </div>
      )}
    </div>
  );

  return(
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16,gap:10,flexWrap:'wrap'}}>
        <h1 style={{fontSize:20,fontWeight:800}}>Vista del Salón</h1>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <Btn small variant="secondary" onClick={()=>setQrModal(true)}><Icon name="dashboard" size={13} style={{verticalAlign:'-2px',marginRight:4}}/>QR mostrador</Btn>
          <Btn small variant="secondary" onClick={load}><Icon name="refresh" size={13} style={{verticalAlign:'-2px',marginRight:4}}/>Actualizar</Btn>
        </div>
      </div>

      {/* KPI strip */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))',gap:10,marginBottom:20}}>
        <KpiMini label="Mesas ocupadas"   value={`${ocupadas} / ${tables.length}`} accent={ocupadas>0?C.orange:C.mid}/>
        <KpiMini label="En cocina"        value={kitchenCount} accent={C.yellow}/>
        <KpiMini label="Listos"           value={readyCount}   accent={C.green}/>
        <KpiMini label="Sin mesa"          value={pickupAll.length} accent={'#FF9500'}/>
        <KpiMini label="Delivery"         value={deliveryOrders.length} accent={'#FF3B30'}/>
        <KpiMini label="Total en proceso" value={fmt(totalEnProceso)} accent={C.cyan}/>
      </div>

      {loading&&<div style={{textAlign:'center',padding:40}}><span className="spin"/></div>}

      {!loading&&(
        <div style={{display:'grid',gridTemplateColumns:'1fr 360px',gap:20,alignItems:'start'}}>
          {/* Mapa de zonas */}
          <div>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12,gap:10,flexWrap:'wrap'}}>
              <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1}}>{mesaViewMode==='grid'?'MESAS DEL SALÓN':'MAPA DEL SALÓN'}</div>
              <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                {editMode&&mesaViewMode==='mapa'&&<div style={{fontSize:11,color:C.dim}}>Arrastrá para posicionar · click para editar</div>}
                {/* Toggle Cuadrícula / Mapa */}
                <div style={{display:'flex',gap:4,background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:3}}>
                  <button type="button" onClick={()=>{setMesaViewMode('grid');setDragging(null);}}
                    style={{padding:'5px 12px',borderRadius:6,border:'none',fontSize:12,fontWeight:700,cursor:'pointer',background:mesaViewMode==='grid'?C.ink:'transparent',color:mesaViewMode==='grid'?C.surface:C.mid}}>
                    <Icon name="layout" size={13} style={{verticalAlign:'-2px',marginRight:3}}/> Cuadrícula
                  </button>
                  <button type="button" onClick={()=>setMesaViewMode('mapa')}
                    style={{padding:'5px 12px',borderRadius:6,border:'none',fontSize:12,fontWeight:700,cursor:'pointer',background:mesaViewMode==='mapa'?C.ink:'transparent',color:mesaViewMode==='mapa'?C.surface:C.mid}}>
                    <Icon name="pin" size={13} style={{verticalAlign:'-2px',marginRight:3}}/> Mapa
                  </button>
                </div>
                <button type="button" onClick={()=>setNewMesa(true)}
                  style={{padding:'5px 14px',borderRadius:6,border:'none',background:C.ink,color:C.surface,fontSize:12,fontWeight:700,cursor:'pointer'}}>
                  + Nueva mesa
                </button>
                <button type="button" onClick={()=>{setEditMode(e=>!e);setDragging(null);}}
                  style={{padding:'5px 14px',borderRadius:6,border:`1px solid ${editMode?C.ink:C.border}`,background:editMode?C.ink:'transparent',color:editMode?'#fff':'#6E6E73',fontSize:12,fontWeight:700,cursor:'pointer'}}>
                  {editMode?(mesaViewMode==='grid'?'✓ Editando (tocá una mesa)':'✓ Editando'):'✎ Editar mesas'}
                </button>
              </div>
            </div>
            {tables.length===0?(
              <div style={{color:C.mid,fontSize:13,padding:20,fontWeight:500}}>No hay mesas configuradas para este restaurante.</div>
            ):(()=>{
              const zonaMap={};
              tables.forEach(t=>{const z=t.zona||'salon';if(!zonaMap[z])zonaMap[z]=[];zonaMap[z].push(t);});
              const zonasToShow=editMode?ZONAS_DEF_C:ZONAS_DEF_C.filter(z=>zonaMap[z.value]?.length>0);
              return zonasToShow.map(z=>(
                <ZonaCaja key={z.value}
                  zona={z.value}
                  layout={mesaViewMode==='grid'?'grid':'map'}
                  tables={zonaMap[z.value]||[]}
                  ordersByTable={ordersByTable}
                  sessionTotals={sessionTotals}
                  reservationByTable={reservationByTable}
                  editMode={editMode}
                  dragging={dragging}
                  dragOff={dragOff}
                  setDragging={setDragging}
                  setDragOff={setDragOff}
                  setTables={setTables}
                  onTableClick={(t,order)=>{
                    const r=reservationByTable[t.id];
                    if(r&&!t.is_occupied&&!order){setResvInfo({table:t,info:r});return;}
                    if(r&&(t.is_occupied||order)){setResvInfo({table:t,info:r,alsoOccupied:true});}
                    if(!t.is_occupied&&!order){setSelTable({table:t,orders:[]});return;}
                    loadTableSession(t);
                  }}
                  onEditTable={t=>setMesaEdit(t)}
                />
              ));
            })()}
            {/* Pedidos con table_id que no está en la lista de mesas */}
            {dineInOrders.filter(o=>o.table_id&&!tables.find(t=>t.id===o.table_id)).length>0&&(
              <div style={{marginTop:16}}>
                <div style={{fontSize:10,color:C.yellow,fontWeight:700,letterSpacing:1,marginBottom:8}}>PEDIDOS CON MESA NO REGISTRADA</div>
                <AlertBox type="warn">Estos pedidos tienen una mesa asignada que no aparece en el listado. Verificar configuración de mesas.</AlertBox>
                <div style={{display:'flex',flexDirection:'column',gap:8}}>
                  {dineInOrders.filter(o=>o.table_id&&!tables.find(t=>t.id===o.table_id)).map(o=><OrderRow key={o.id} order={o}/>)}
                </div>
              </div>
            )}
          </div>

          {/* Columna derecha: salón sin mesa + para llevar + para retirar + delivery */}
          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            {(salonACobrar.length>0||salonPagado.length>0)&&<div style={{fontSize:10,fontWeight:800,letterSpacing:'0.08em',color:C.mid,paddingLeft:2}}>SALÓN</div>}
            {salonACobrar.length>0&&(
              <SideSection
                title="SALÓN · SIN PAGAR"
                desc="Pedidos del salón sin número de mesa, pendientes de cobro."
                list={salonACobrar}
                emptyMsg="Sin pedidos"
                accent={'#FF9500'}
                allowCancel
              />
            )}
            {salonPagado.length>0&&(
              <SideSection
                title="SALÓN · PAGADOS"
                desc="Pedidos del salón ya cobrados (se ocultan al entregarse)."
                list={salonPagado}
                emptyMsg="Sin pedidos"
                accent={'#34C759'}
              />
            )}
            {(llevarACobrar.length>0||llevarPagado.length>0)&&<div style={{fontSize:10,fontWeight:800,letterSpacing:'0.08em',color:C.mid,paddingLeft:2,marginTop:4}}>PARA LLEVAR</div>}
            {llevarACobrar.length>0&&(
              <SideSection
                title="PARA LLEVAR · SIN PAGAR"
                desc="El cliente pasa por caja, paga y retira."
                list={llevarACobrar}
                emptyMsg="Sin pedidos"
                accent={'#FF9500'}
                allowCancel
              />
            )}
            {llevarPagado.length>0&&(
              <SideSection
                title="PARA LLEVAR · PAGADOS"
                desc="Pagados online. Se ocultan a los 6 min de entregados por cocina."
                list={llevarPagado}
                emptyMsg="Sin pedidos"
                accent={'#34C759'}
              />
            )}
            {(retirarACobrar.length>0||retirarPagado.length>0)&&<div style={{fontSize:10,fontWeight:800,letterSpacing:'0.08em',color:C.mid,paddingLeft:2,marginTop:4}}>PARA RETIRAR</div>}
            {retirarACobrar.length>0&&(
              <SideSection
                title="PARA RETIRAR · SIN PAGAR"
                desc="El cliente viene a retirar y paga en caja."
                list={retirarACobrar}
                emptyMsg="Sin pedidos"
                accent={'#FF9500'}
                allowCancel
              />
            )}
            {retirarPagado.length>0&&(
              <SideSection
                title="PARA RETIRAR · PAGADOS"
                desc="Pagados online. Se ocultan a los 6 min de entregados por cocina."
                list={retirarPagado}
                emptyMsg="Sin pedidos"
                accent={'#34C759'}
              />
            )}
            <SideSection
              title="DELIVERY A DOMICILIO"
              desc="Pedidos de delivery pendientes"
              list={deliveryOrders}
              emptyMsg="Sin pedidos delivery activos"
              accent={'#FF3B30'}
            />
          </div>
        </div>
      )}

      {selOrder&&<OrderDetailModal order={selOrder} onClose={()=>setSelOrder(null)}/>}

      {cancelTarget&&(
        <QuickCancelModal
          order={cancelTarget}
          turno={turno}
          profile={profile}
          onClose={()=>setCancelTarget(null)}
          onCancelled={()=>{setCancelTarget(null);load();}}
        />
      )}

      {/* Modal de info de reserva */}
      {resvInfo&&(()=>{
        const r=resvInfo.info.reservation;
        const mins=resvInfo.info._minutesUntil;
        const horaTxt=r.reservation_time?.slice(0,5)||'';
        const tiempoTxt=mins>0?`en ${mins<60?mins+' min':Math.floor(mins/60)+'h '+(mins%60)+'m'}`:`hace ${Math.abs(mins)} min`;
        return(
          <Modal title={`Mesa ${resvInfo.table.number} — Reserva ${resvInfo.alsoOccupied?'próxima':'activa'}`} onClose={()=>setResvInfo(null)} width={420}>
            <div style={{display:'flex',flexDirection:'column',gap:10}}>
              {resvInfo.alsoOccupied&&(
                <div style={{background:TINT.redBg,border:`1px solid ${TINT.redBorder}`,borderRadius:8,padding:'10px 12px',fontSize:12,color:TINT.redText}}>
                  Esta mesa está ocupada y tiene una reserva próxima. Considerá pedir la cuenta al cliente actual.
                </div>
              )}
              <div style={{background:TINT.amberBg,border:`1px solid ${TINT.amberBorder}`,borderRadius:8,padding:'12px 14px'}}>
                <div style={{fontSize:16,fontWeight:800,color:C.ink,marginBottom:6}}>{r.customer_name}</div>
                <div style={{fontSize:13,color:C.mid,lineHeight:1.7}}>
                  <Icon name="phone" size={12} style={{verticalAlign:'-2px',marginRight:4}}/> {r.customer_phone}<br/>
                  <Icon name="clock" size={12} style={{verticalAlign:'-2px',marginRight:4}}/> Hora reservada: <strong>{horaTxt}</strong> ({tiempoTxt})<br/>
                  <Icon name="users" size={12} style={{verticalAlign:'-2px',marginRight:4}}/> {r.guests} personas{r.occasion?<><br/><Icon name="sparkles" size={12} style={{verticalAlign:'-2px',marginRight:4}}/> Motivo: {r.occasion}</>:null}
                  {r.notes?<><br/><Icon name="fileText" size={12} style={{verticalAlign:'-2px',marginRight:4}}/> {r.notes}</>:null}
                </div>
                <div style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:11,color:C.dim,marginTop:8}}>Confirmación {r.confirm_num}</div>
              </div>
              <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:6}}>
                <Btn variant="ghost" onClick={()=>setResvInfo(null)}>Cerrar</Btn>
              </div>
            </div>
          </Modal>
        );
      })()}

      {/* Modal edición de mesa */}
      {mesaEdit&&(
        <MesaEditModalC
          table={mesaEdit}
          onSave={()=>{setMesaEdit(null);setEditMode(false);load();}}
          onClose={()=>setMesaEdit(null)}
        />
      )}

      {/* Modal nueva mesa */}
      {newMesa&&(
        <NuevaMesaModalC
          onSave={()=>{setNewMesa(false);load();}}
          onClose={()=>setNewMesa(false)}
        />
      )}

      {/* Modal de sesión de mesa — historial + liberar/ocupar */}
      {selTable&&(()=>{
        const esLibre=!selTable.table.is_occupied;
        return(
        <Modal title={`Mesa ${selTable.table.number} — ${esLibre?'Libre':'Servicio activo'}`} onClose={()=>setSelTable(null)} width={540}>
          <div style={{marginBottom:16}}>
            {/* Info de mesa */}
            <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginBottom:14,padding:'10px 14px',background:C.bg,borderRadius:8}}>
              <Badge txt={esLibre?'Libre':'Ocupada'} color={esLibre?'#6E6E73':C.green}/>
              {selTable.table.capacity&&<span style={{fontSize:12,color:C.ink,fontWeight:600}}>{selTable.table.capacity} pax</span>}
              {selTable.table.occupied_since&&(
                <span style={{fontSize:12,color:C.mid}}>Desde {fmtTime(selTable.table.occupied_since)}</span>
              )}
              {(selTable.table.assigned_waiter_name||selTable.orders[0]?.waiter_name)?(
                <span style={{fontSize:12,color:C.ink,fontWeight:600,display:'inline-flex',alignItems:'center',gap:5}}><Icon name="user" size={12} /> Mozo: {selTable.table.assigned_waiter_name||selTable.orders[0].waiter_name}</span>
              ):(
                <span style={{fontSize:12,color:C.mid,display:'inline-flex',alignItems:'center',gap:5}}><Icon name="user" size={12} /> Sin mozo asignado</span>
              )}
            </div>

            {/* Resumen rápido */}
            {selTable.orders.length>0&&(()=>{
              const pagados=selTable.orders.filter(o=>o.payment_status==='paid');
              const sinCobrar=selTable.orders.filter(o=>o.payment_status!=='paid');
              const totalPagado=pagados.reduce((s,o)=>s+Number(o.total||0),0);
              const totalSinCobrar=sinCobrar.reduce((s,o)=>s+Number(o.total||0),0);
              return(
                <div className="my-row-3" style={{gap:8,marginBottom:14}}>
                  <div style={{background:'rgba(52,199,89,0.1)',border:'1px solid rgba(52,199,89,0.3)',borderRadius:8,padding:'10px 12px',textAlign:'center'}}>
                    <div style={{fontSize:10,color:TINT.greenText,fontWeight:700,marginBottom:4}}>PAGADO</div>
                    <div style={{fontSize:16,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:TINT.greenText}}>{fmt(totalPagado)}</div>
                    <div style={{fontSize:10,color:C.mid,marginTop:2}}>{pagados.length} pedido{pagados.length!==1?'s':''}</div>
                  </div>
                  <div style={{background:totalSinCobrar>0?'rgba(255,59,48,0.1)':'rgba(52,199,89,0.05)',border:`1px solid ${totalSinCobrar>0?'rgba(255,59,48,0.3)':'rgba(52,199,89,0.2)'}`,borderRadius:8,padding:'10px 12px',textAlign:'center'}}>
                    <div style={{fontSize:10,color:totalSinCobrar>0?'#C0190F':'#6E6E73',fontWeight:700,marginBottom:4}}>SIN COBRAR</div>
                    <div style={{fontSize:16,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:totalSinCobrar>0?C.red:'#6E6E73'}}>{fmt(totalSinCobrar)}</div>
                    <div style={{fontSize:10,color:C.mid,marginTop:2}}>{sinCobrar.length} pedido{sinCobrar.length!==1?'s':''}</div>
                  </div>
                  <div style={{background:'rgba(0,0,0,0.05)',border:'1px solid rgba(0,0,0,0.1)',borderRadius:8,padding:'10px 12px',textAlign:'center'}}>
                    <div style={{fontSize:10,color:C.ink,fontWeight:700,marginBottom:4}}>TOTAL SERVICIO</div>
                    <div style={{fontSize:16,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.ink}}>{fmt(selTable.orders.reduce((s,o)=>s+Number(o.total||0),0))}</div>
                    <div style={{fontSize:10,color:C.mid,marginTop:2}}>{selTable.orders.length} pedido{selTable.orders.length!==1?'s':''}</div>
                  </div>
                </div>
              );
            })()}

            {selTable.orders.length===0&&<div style={{textAlign:'center',padding:20,color:C.mid,fontWeight:500}}>{esLibre?'Mesa libre — sin servicio activo':'Sin órdenes registradas en esta sesión'}</div>}
            {selTable.orders.map((ord,idx)=>{
              const esPagado=ord.payment_status==='paid';
              return(
                <div key={ord.id} style={{marginBottom:14,border:`1px solid ${esPagado?'rgba(52,199,89,0.3)':'rgba(255,59,48,0.3)'}`,borderRadius:8,padding:12,background:esPagado?'rgba(52,199,89,0.04)':'rgba(255,59,48,0.04)'}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                    <div style={{display:'flex',gap:8,alignItems:'center'}}>
                      <span style={{fontSize:13,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.ink}}>#{ord.order_number}</span>
                      {!(ord.status==='pending_payment'&&esPagado)&&<Badge txt={SL[ord.status]||ord.status} color={SC[ord.status]||'#6E6E73'} />}
                      {esPagado?<span style={{fontSize:10,color:C.green,fontWeight:700}}>✓ Cobrado</span>:<span style={{fontSize:10,color:C.red,fontWeight:700}}>Sin cobrar</span>}
                    </div>
                    <div style={{textAlign:'right'}}>
                      <div style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:16,fontWeight:800,color:esPagado?C.green:C.red}}>{fmt(ord.total)}</div>
                      <div style={{fontSize:10,color:C.mid}}>{fmtTime(ord.created_at)}</div>
                    </div>
                  </div>
                  {(ord.order_items||[]).map(it=>(
                    <div key={it.id} style={{display:'flex',justifyContent:'space-between',fontSize:12,padding:'3px 8px',background:'rgba(0,0,0,0.04)',borderRadius:5,marginBottom:2,color:C.ink}}>
                      <span style={{fontWeight:500}}>{it.quantity}× {it.item_name}{it.observations?<span style={{color:C.mid,fontSize:11}}> — {it.observations}</span>:null}</span>
                      <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",color:C.ink,fontWeight:700}}>{fmt(it.unit_price*it.quantity)}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          <div style={{display:'flex',gap:10}}>
            {esLibre?(
              <Btn full variant="primary" onClick={()=>ocuparMesa(selTable.table.id,selTable.table.number)}>
                Ocupar mesa
              </Btn>
            ):(
              <Btn full variant="success" onClick={()=>liberarMesa(selTable.table.id,selTable.table.number)}>
                Liberar mesa
              </Btn>
            )}
            <Btn variant="ghost" onClick={()=>setSelTable(null)}>Cerrar</Btn>
          </div>
        </Modal>
        );
      })()}

      {/* Modal QR mostrador — ventana flotante (reemplaza al antiguo módulo de sidebar) */}
      {qrModal&&(
        <Modal title="QR para clientes · Mostrador" onClose={()=>setQrModal(false)} width={460}>
          <QrMostradorBody/>
        </Modal>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   PANEL: CIERRE DE CAJA — ARQUEO CIEGO
   El cajero declara su conteo físico SIN ver totales del sistema.
   La diferencia se registra en DB (monto_declarado vs monto_sistema)
   pero NO se muestra al cajero. Mensaje neutro + redirect a /login.html.
═══════════════════════════════════════════ */
function CierreCajaPanel({turno,cajaNombre,movimientos,profile,onCierre}){
  const [denoms,setDenoms]=useState(emptyDenoms());
  const [vouchersTxt,setVouchersTxt]=useState('');
  const [transferTxt,setTransferTxt]=useState('');
  const [obs,setObs]=useState('');
  const [busy,setBusy]=useState(false);
  // Cierre ciego (mig 186): true (default) = no mostrar totales del sistema al cajero.
  // Si el admin lo desactivó, el cajero ve el esperado y la diferencia. Feature-detect:
  // si la columna no existe todavía, queda en true (ciego) — comportamiento vigente.
  const [blindClose,setBlindClose]=useState(true);
  useEffect(()=>{
    if(!db) return;
    db.from('restaurants').select('cash_cierre_ciego').eq('id',RID).maybeSingle()
      .then(({data,error})=>{ if(!error&&data) setBlindClose(data.cash_cierre_ciego!==false); })
      .catch(()=>{});
  },[]);

  const contadoEfectivo=calcDenomTotal(denoms);
  const vouchersTarjeta=Math.max(0,parseInt(vouchersTxt)||0);
  const transferenciasQR=Math.max(0,parseInt(transferTxt)||0);
  const totalDeclarado=contadoEfectivo+vouchersTarjeta+transferenciasQR;

  // Cálculo SILENCIOSO del sistema — nunca se renderiza al cajero.
  const cobros=movimientos.filter(m=>m.tipo==='cobro');
  const sysEfectivo=cobros.filter(m=>m.metodo_pago==='efectivo').reduce((s,m)=>s+Number(m.monto),0);
  const sysTarjeta=cobros.filter(m=>['tarjeta_credito','tarjeta_debito'].includes(m.metodo_pago)).reduce((s,m)=>s+Number(m.monto),0);
  const sysQR=cobros.filter(m=>m.metodo_pago==='qr').reduce((s,m)=>s+Number(m.monto),0);
  const sysEgresos=movimientos.filter(m=>m.tipo==='egreso').reduce((s,m)=>s+Number(m.monto),0);
  const sysRetiros=movimientos.filter(m=>m.tipo==='retiro_parcial').reduce((s,m)=>s+Number(m.monto),0);
  const sysIngresosMan=movimientos.filter(m=>m.tipo==='ingreso_manual').reduce((s,m)=>s+Number(m.monto),0);
  const fondoApertura=Number(turno.fondo_apertura?.total)||0;
  const sysEfectivoEsperado=fondoApertura+sysEfectivo+sysIngresosMan-sysEgresos-sysRetiros;
  const montoSistema=sysEfectivoEsperado+sysTarjeta+sysQR;
  const diferencia=totalDeclarado-montoSistema;

  async function cerrar(){
    if(busy)return;
    if(totalDeclarado===0){
      toast('Ingresá el conteo físico antes de confirmar el cierre.',false);return;
    }
    setBusy(true);
    try{
      const payload={
        estado:'cerrado',
        fecha_cierre:new Date().toISOString(),
        fondo_cierre_contado:{
          denominaciones:denoms,
          total:contadoEfectivo,
          vouchers_tarjeta:vouchersTarjeta,
          transferencias_qr:transferenciasQR,
          monto_declarado:totalDeclarado,
          monto_sistema:montoSistema,
          modo:'arqueo_ciego',
        },
        fondo_cierre_esperado:montoSistema,
        diferencia,
        justificacion_diff:obs||null,
        tipo_reporte:'Z',
      };
      const{error}=await db.from('turnos_caja').update(payload).eq('id',turno.id);
      if(error)throw error;
      // Mensaje neutro — NUNCA mencionar diferencia/sobrante/faltante al cajero.
      toast('Cierre registrado correctamente. Gracias por tu turno.');
      try{localStorage.removeItem('caja_panel');['caja_cart','caja_order_type','caja_table_id','caja_customer_name'].forEach(kk=>localStorage.removeItem(lsk(kk)));}catch{}
      try{await window.MythosPresence?.stop('manual');}catch(_){}
      try{await db.auth.signOut();}catch{}
      setTimeout(()=>{window.location.replace('login.html?cierre=ok');},900);
    }catch(e){
      toast('No se pudo registrar el cierre: '+e.message,false);
      setBusy(false);
    }
  }

  return(
    <div className="page">
      <div style={{maxWidth:640,margin:'0 auto'}}>
        <div style={{textAlign:'center',marginBottom:22}}>
          <div style={{fontFamily:'DM Serif Display',fontSize:26,marginBottom:6,color:C.ink}}>Cierre de Caja{cajaNombre?` · ${cajaNombre}`:''}</div>
          <div style={{fontSize:13,color:C.mid}}>Cajero: <strong style={{color:C.ink}}>{profile.display_name||profile.username}</strong> · Apertura {fmtDT(turno.fecha_apertura)}</div>
        </div>

        <AlertBox type="info">
          {blindClose
            ? 'Ingresá el conteo físico de tu caja. El sistema registra el arqueo y cierra tu turno; no verás totales del sistema en pantalla.'
            : 'Ingresá el conteo físico de tu caja. Al cerrar verás el total esperado por el sistema y la diferencia.'}
        </AlertBox>

        <DenomGrid values={denoms} onChange={setDenoms} label="Conteo físico de efectivo en caja"/>

        <div style={{marginTop:16}}>
          <Lbl>TOTAL VOUCHERS TARJETA (GS.)</Lbl>
          <Inp gs mono value={vouchersTxt} onChange={setVouchersTxt} placeholder="0"/>
        </div>
        <div style={{marginTop:12}}>
          <Lbl>TOTAL TRANSFERENCIAS / QR BANCARD (GS.)</Lbl>
          <Inp gs mono value={transferTxt} onChange={setTransferTxt} placeholder="0"/>
        </div>
        <div style={{marginTop:12,marginBottom:20}}>
          <Lbl>OBSERVACIONES DE CIERRE</Lbl>
          <Textarea value={obs} onChange={e=>setObs(e.target.value)} placeholder="Novedades, incidentes o aclaraciones del turno…" rows={3}/>
        </div>

        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'14px 16px',display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:blindClose?18:10}}>
          <div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:1}}>TOTAL DECLARADO</div>
          <div style={{fontSize:22,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.ink}}>{fmt(totalDeclarado)}</div>
        </div>

        {/* Cierre NO ciego: mostrar el esperado del sistema y la diferencia (mig 186) */}
        {!blindClose&&(
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'12px 16px',marginBottom:18}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
              <div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:1}}>TOTAL ESPERADO (SISTEMA)</div>
              <div style={{fontSize:16,fontWeight:700,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.mid}}>{fmt(montoSistema)}</div>
            </div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',paddingTop:8,borderTop:`1px solid ${C.border}`}}>
              <div style={{fontSize:11,fontWeight:700,letterSpacing:1,color:diferencia===0?C.mid:(diferencia>0?'#34C759':'#FF3B30')}}>
                {diferencia===0?'SIN DIFERENCIA':(diferencia>0?'SOBRANTE':'FALTANTE')}
              </div>
              <div style={{fontSize:18,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:diferencia===0?C.ink:(diferencia>0?'#34C759':'#FF3B30')}}>
                {diferencia>0?'+':''}{fmt(diferencia)}
              </div>
            </div>
          </div>
        )}

        <Btn full variant="primary" onClick={cerrar} disabled={busy||totalDeclarado===0}>
          {busy?<><span className="spin"/> Registrando cierre…</>:'Confirmar Cierre de Caja'}
        </Btn>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   CALCULADORA FLOTANTE
═══════════════════════════════════════════ */
function CalculadoraFlotante(){
  const [open,setOpen]=useState(false);
  const [expr,setExpr]=useState('');
  const [display,setDisplay]=useState('0');
  const [newNum,setNewNum]=useState(true);

  function press(k){
    if(k==='C'){setExpr('');setDisplay('0');setNewNum(true);return;}
    if(k==='←'){
      if(newNum)return;
      const s=display.slice(0,-1);
      setDisplay(s||'0');
      if(!s)setNewNum(true);
      return;
    }
    if(k==='='){
      try{
        const full=expr+display;
        const res=Function('"use strict";return ('+full.replace(/×/g,'*').replace(/÷/g,'/')+')')();
        const rounded=Math.round(res*100)/100;
        setDisplay(isFinite(rounded)?String(rounded):'Error');
        setExpr('');setNewNum(true);
      }catch{setDisplay('Error');setNewNum(true);}
      return;
    }
    if(['+','-','×','÷'].includes(k)){
      setExpr(expr+display+k);
      setNewNum(true);
      return;
    }
    if(k==='%'){
      try{const v=parseFloat(display)/100;setDisplay(String(Math.round(v*100)/100));setNewNum(true);}catch{}
      return;
    }
    if(newNum){
      setDisplay(k==='.'?'0.':k);
      setNewNum(false);
    }else{
      if(k==='.'&&display.includes('.'))return;
      setDisplay(display==='0'&&k!=='.'?k:display+k);
    }
  }

  const KEYS=[
    ['C','←','%','÷'],
    ['7','8','9','×'],
    ['4','5','6','-'],
    ['1','2','3','+'],
    ['0','.','='],
  ];

  const numVal=parseFloat(display);
  const fmtCalc=!isNaN(numVal)&&display!=='Error'&&display!=='0'?'₲ '+Math.round(numVal).toLocaleString('es-PY'):'';

  return(
    <>
      <button onClick={()=>setOpen(o=>!o)} title="Calculadora" style={{
        position:'fixed',bottom:24,right:24,zIndex:1001,
        width:46,height:46,borderRadius:'50%',
        background:open?C.white:C.surface,
        border:`1px solid ${open?'transparent':C.bs}`,
        color:open?'#000':C.mid,
        fontSize:20,cursor:'pointer',
        boxShadow:'0 4px 16px rgba(0,0,0,0.5)',
        display:'flex',alignItems:'center',justifyContent:'center',
      }}><Icon name="dashboard" size={20} /></button>

      {open&&(
        <div style={{
          position:'fixed',bottom:80,right:24,zIndex:1001,
          background:C.bg,border:`1px solid ${C.bs}`,
          borderRadius:12,padding:12,width:238,
          boxShadow:'0 8px 32px rgba(0,0,0,0.7)',animation:'slideUp 150ms ease',
        }}>
          <div style={{textAlign:'right',marginBottom:8,padding:'8px 10px',background:C.card,borderRadius:8,minHeight:60}}>
            {expr&&<div style={{fontSize:10,color:C.mid,fontFamily:"'SF Mono',ui-monospace,monospace",marginBottom:2}}>{expr}</div>}
            <div style={{fontSize:24,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.ink,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{display}</div>
            {fmtCalc&&<div style={{fontSize:11,color:C.green,fontFamily:"'SF Mono',ui-monospace,monospace"}}>{fmtCalc}</div>}
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:5}}>
            {KEYS.map((row,i)=>(
              <div key={i} style={{display:'grid',gridTemplateColumns:row.length===3?'2fr 1fr 1fr':'repeat(4,1fr)',gap:5}}>
                {row.map(k=>{
                  const isOp=['+','-','×','÷'].includes(k);
                  const isEq=k==='=';
                  const isDel=k==='C';
                  return(
                    <button key={k} onClick={()=>press(k)} style={{
                      padding:'13px 0',borderRadius:7,border:'none',
                      background:isDel?'rgba(239,68,68,0.15)':isEq?'rgba(34,197,94,0.18)':isOp||k==='%'||k==='←'?C.ink:C.card,
                      color:isDel?C.red:isEq?C.green:isOp||k==='%'||k==='←'?C.surface:C.ink,
                      fontSize:15,fontWeight:isEq?800:600,cursor:'pointer',
                      fontFamily:"'SF Mono',ui-monospace,monospace",
                    }}>{k}</button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/* ═══════════════════════════════════════════
   PANEL: RESERVAS (CAJA)
═══════════════════════════════════════════ */
function ReservaFormModalCaja({reserva,tables,onClose,onSaved}){
  const isNew=!reserva;
  const now=new Date();
  const MONTHS_ES=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const OCCASION_OPTS=[{id:'',label:'Sin motivo especial'},{id:'birthday',label:'Cumpleaños'},{id:'anniversary',label:'Aniversario'},{id:'business',label:'Reunión'},{id:'celebration',label:'Celebración'},{id:'other',label:'Otro'}];
  const STATUS_OPTS=[{id:'pending',label:'Pendiente'},{id:'confirmed',label:'Confirmada'},{id:'seated',label:'En mesa'},{id:'no_show',label:'No llegó'},{id:'cancelled',label:'Cancelada'}];

  const TIME_SLOTS=[];
  for(let h=10;h<=23;h++){TIME_SLOTS.push(`${String(h).padStart(2,'0')}:00`);TIME_SLOTS.push(`${String(h).padStart(2,'0')}:30`);}

  const todayStr=todayLocal();
  const initDate=reserva?.reservation_date||todayStr;
  const [iY,iM,iD]=initDate.split('-').map(Number);

  const [form,setForm]=useState({
    customer_name:   reserva?.customer_name   ||'',
    customer_phone:  reserva?.customer_phone  ||'',
    day:iD, month:iM, year:iY,
    reservation_time:reserva?.reservation_time?.slice(0,5)||'',
    guests:          reserva?.guests          ||2,
    table_id:        reserva?.table_id        ||'',
    occasion:        reserva?.occasion        ||'',
    notes:           reserva?.notes           ||'',
    status:          reserva?.status          ||'confirmed',
  });
  const [saving,setSaving]=useState(false);
  const f=(k,v)=>setForm(p=>({...p,[k]:v}));
  const inputSt={width:'100%',height:38,border:`1px solid ${C.border}`,borderRadius:6,padding:'0 10px',fontSize:13,color:C.ink,background:C.surface,outline:'none',boxSizing:'border-box'};
  const selSt={...inputSt,cursor:'pointer'};

  const daysInMonth=new Date(form.year,form.month,0).getDate();
  const yearOptions=[now.getFullYear(),now.getFullYear()+1];

  function buildDateStr(){
    const d=String(Math.min(form.day,daysInMonth)).padStart(2,'0');
    const m=String(form.month).padStart(2,'0');
    return `${form.year}-${m}-${d}`;
  }

  async function save(){
    const dateStr=buildDateStr();
    if(!form.customer_name||!form.customer_phone||!dateStr||!form.reservation_time)return;
    setSaving(true);
    if(isNew){
      const confirmNum='R-'+String(Math.floor(Date.now()%90000)+10000);
      await db.from('reservations').insert({
        restaurant_id:RID,confirm_num:confirmNum,
        customer_name:form.customer_name,customer_phone:form.customer_phone,
        reservation_date:dateStr,reservation_time:form.reservation_time,
        guests:Number(form.guests),table_id:form.table_id||null,
        occasion:form.occasion||null,notes:form.notes||null,status:form.status,
      });
    } else {
      await db.from('reservations').update({
        customer_name:form.customer_name,customer_phone:form.customer_phone,
        reservation_date:buildDateStr(),reservation_time:form.reservation_time,
        guests:Number(form.guests),table_id:form.table_id||null,
        occasion:form.occasion||null,notes:form.notes||null,status:form.status,
      }).eq('id',reserva.id);
    }
    setSaving(false);
    onSaved();
  }

  const canSave=form.customer_name&&form.customer_phone&&form.reservation_time;

  return(
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.55)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000,padding:20}}>
      <div style={{background:C.surface,borderRadius:14,width:'100%',maxWidth:540,maxHeight:'92vh',overflowY:'auto',padding:24}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18}}>
          <div style={{fontSize:17,fontWeight:800,color:C.ink}}>{isNew?'Nueva reserva':'Editar reserva'}</div>
          <button onClick={onClose} style={{width:28,height:28,borderRadius:'50%',border:`1px solid ${C.border}`,background:'transparent',cursor:'pointer',fontSize:15,color:C.mid}}>✕</button>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:12}}>
          <div style={{display:'flex',gap:10}}>
            <div style={{flex:1}}><label style={{fontSize:11,fontWeight:600,color:C.mid,display:'block',marginBottom:4}}>Nombre *</label><input value={form.customer_name} onChange={e=>f('customer_name',e.target.value)} style={inputSt} placeholder="Nombre del cliente"/></div>
            <div style={{flex:1}}><label style={{fontSize:11,fontWeight:600,color:C.mid,display:'block',marginBottom:4}}>Teléfono *</label><input value={form.customer_phone} onChange={e=>f('customer_phone',e.target.value)} type="tel" style={inputSt} placeholder="+595 9XX XXX XXX"/></div>
          </div>

          {/* Fecha dropdowns */}
          <div>
            <label style={{fontSize:11,fontWeight:600,color:C.mid,display:'block',marginBottom:6}}>Fecha *</label>
            <div style={{display:'flex',gap:8}}>
              <div style={{flex:'0 0 80px'}}>
                <div style={{fontSize:10,color:C.mid,marginBottom:3,fontWeight:600}}>DÍA</div>
                <select value={form.day} onChange={e=>f('day',Number(e.target.value))} style={selSt}>
                  {Array.from({length:daysInMonth},(_,i)=><option key={i+1} value={i+1}>{i+1}</option>)}
                </select>
              </div>
              <div style={{flex:1}}>
                <div style={{fontSize:10,color:C.mid,marginBottom:3,fontWeight:600}}>MES</div>
                <select value={form.month} onChange={e=>f('month',Number(e.target.value))} style={selSt}>
                  {MONTHS_ES.map((m,i)=><option key={i+1} value={i+1}>{m}</option>)}
                </select>
              </div>
              <div style={{flex:'0 0 82px'}}>
                <div style={{fontSize:10,color:C.mid,marginBottom:3,fontWeight:600}}>AÑO</div>
                <select value={form.year} onChange={e=>f('year',Number(e.target.value))} style={selSt}>
                  {yearOptions.map(y=><option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </div>
            <div style={{marginTop:5,fontSize:11,color:C.mid}}>→ <strong style={{color:C.ink}}>{MONTHS_ES[form.month-1]} {Math.min(form.day,daysInMonth)}, {form.year}</strong></div>
          </div>

          {/* Hora — slots */}
          <div>
            <label style={{fontSize:11,fontWeight:600,color:C.mid,display:'block',marginBottom:6}}>
              Horario *{form.reservation_time&&<strong style={{color:C.ink,marginLeft:8}}>{form.reservation_time} hs</strong>}
            </label>
            <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:4}}>
              {TIME_SLOTS.map(t=>{
                const sel=form.reservation_time===t;
                return <button key={t} onClick={()=>f('reservation_time',t)}
                  style={{padding:'5px 2px',borderRadius:5,border:`1.5px solid ${sel?'#000':C.border}`,background:sel?C.ink:'transparent',color:sel?'#fff':C.ink,fontSize:11,fontWeight:sel?700:400,cursor:'pointer',transition:'all 100ms'}}>
                  {t}</button>;
              })}
            </div>
          </div>

          <div style={{display:'flex',gap:10}}>
            <div style={{flex:1}}>
              <label style={{fontSize:11,fontWeight:600,color:C.mid,display:'block',marginBottom:4}}>Personas</label>
              <select value={form.guests} onChange={e=>f('guests',e.target.value)} style={selSt}>
                {[1,2,3,4,5,6,7,8,10,12].map(n=><option key={n} value={n}>{n} personas</option>)}
              </select>
            </div>
            <div style={{flex:1}}>
              <label style={{fontSize:11,fontWeight:600,color:C.mid,display:'block',marginBottom:4}}>Mesa</label>
              <select value={form.table_id} onChange={e=>f('table_id',e.target.value)} style={selSt}>
                <option value="">Sin asignar</option>
                {(tables||[]).map(t=><option key={t.id} value={t.id}>Mesa {t.number}{t.capacity?` (${t.capacity}p)`:''}</option>)}
              </select>
            </div>
          </div>

          <div style={{display:'flex',gap:10}}>
            <div style={{flex:1}}>
              <label style={{fontSize:11,fontWeight:600,color:C.mid,display:'block',marginBottom:4}}>Motivo</label>
              <select value={form.occasion} onChange={e=>f('occasion',e.target.value)} style={selSt}>
                {OCCASION_OPTS.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
            <div style={{flex:1}}>
              <label style={{fontSize:11,fontWeight:600,color:C.mid,display:'block',marginBottom:4}}>Estado</label>
              <select value={form.status} onChange={e=>f('status',e.target.value)} style={selSt}>
                {STATUS_OPTS.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label style={{fontSize:11,fontWeight:600,color:C.mid,display:'block',marginBottom:4}}>Notas</label>
            <textarea value={form.notes} onChange={e=>f('notes',e.target.value)} rows={2}
              style={{width:'100%',border:`1px solid ${C.border}`,borderRadius:6,padding:'8px 10px',fontSize:13,color:C.ink,background:C.surface,outline:'none',resize:'none',boxSizing:'border-box'}}/>
          </div>

          <div style={{display:'flex',gap:10,justifyContent:'flex-end',paddingTop:4}}>
            <button onClick={onClose} style={{padding:'8px 16px',border:`1px solid ${C.border}`,borderRadius:8,background:'transparent',color:C.mid,fontSize:13,cursor:'pointer'}}>Cancelar</button>
            <button onClick={save} disabled={saving||!canSave}
              style={{padding:'8px 20px',border:'none',borderRadius:8,background:canSave?C.ink:C.border,color:canSave?C.surface:C.dim,fontSize:13,fontWeight:700,cursor:canSave?'pointer':'default',opacity:saving?.6:1}}>
              {saving?'Guardando…':isNew?'Crear reserva':'Guardar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReservasPanel(){
  const [reservas,setReservas]=useState([]);
  const [loading,setLoading]=useState(true);
  const [dateFilter,setDateFilter]=useState(todayLocal());
  const [newModal,setNewModal]=useState(false);
  const [editModal,setEditModal]=useState(null);
  const [tables,setTables]=useState([]);

  const OCCASION_LABEL={birthday:'Cumpleaños',anniversary:'Aniversario',business:'Reunión',celebration:'Celebración',other:'Otro'};
  const STATUS_CFG={
    pending:   {label:'Pendiente', color:'#FF9500', bg:'rgba(255,149,0,.12)'},
    confirmed: {label:'Confirmada',color:'#34C759', bg:'rgba(52,199,89,.12)'},
    seated:    {label:'En mesa',   color:'#007AFF', bg:'rgba(0,122,255,.12)'},
    no_show:   {label:'No llegó',  color:C.mid, bg:'rgba(110,110,115,.12)'},
    cancelled: {label:'Cancelada', color:'#FF3B30', bg:'rgba(255,59,48,.12)'},
  };

  useEffect(()=>{
    if(db) db.from('tables').select('id,number,capacity').eq('restaurant_id',RID).order('number').then(({data})=>setTables(data||[]));
  },[]);

  async function load(){
    setLoading(true);
    if(!db){setLoading(false);return;}
    const{data}=await db.from('reservations')
      .select('*').eq('restaurant_id',RID).eq('reservation_date',dateFilter).order('reservation_time');
    setReservas(data||[]);
    setLoading(false);
  }
  useEffect(()=>{load();},[dateFilter]);

  async function updateStatus(id,status){
    await db.from('reservations').update({status}).eq('id',id);
    setReservas(p=>p.map(r=>r.id===id?{...r,status}:r));
  }

  const fmtTime=t=>t?t.slice(0,5):'';

  return(
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20,flexWrap:'wrap',gap:10}}>
        <div>
          <h1 style={{fontSize:22,fontWeight:800,color:C.ink,margin:0}}>Reservas</h1>
          <div style={{fontSize:12,color:C.mid,marginTop:3}}>{reservas.filter(r=>['pending','confirmed'].includes(r.status)).length} activas para esta fecha</div>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <input type="date" value={dateFilter} onChange={e=>setDateFilter(e.target.value)}
            style={{height:34,border:`1px solid ${C.border}`,borderRadius:6,padding:'0 10px',fontSize:13,color:C.ink,background:C.surface,outline:'none'}}/>
          <button onClick={load} style={{height:34,padding:'0 12px',border:`1px solid ${C.border}`,borderRadius:6,background:C.surface,color:C.mid,fontSize:12,cursor:'pointer'}}>↺</button>
          <button onClick={()=>setNewModal(true)} style={{height:34,padding:'0 14px',border:'none',borderRadius:6,background:C.ink,color:C.surface,fontSize:12,fontWeight:700,cursor:'pointer'}}>+ Nueva</button>
        </div>
      </div>

      {loading&&<div style={{textAlign:'center',padding:40,color:C.mid}}>Cargando…</div>}
      {!loading&&reservas.length===0&&(
        <div style={{textAlign:'center',padding:60,color:C.mid}}>
          <div style={{fontSize:28,marginBottom:10}}>◷</div>
          <div style={{fontSize:14,fontWeight:600}}>Sin reservas para esta fecha</div>
          <button onClick={()=>setNewModal(true)} style={{marginTop:14,padding:'8px 20px',border:'none',borderRadius:8,background:C.ink,color:C.surface,fontSize:13,fontWeight:700,cursor:'pointer'}}>+ Crear reserva</button>
        </div>
      )}

      {!loading&&reservas.length>0&&(
        <div style={{display:'flex',flexDirection:'column',gap:10}}>
          {reservas.map(r=>{
            const sc=STATUS_CFG[r.status]||STATUS_CFG.pending;
            return(
              <div key={r.id} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:16}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12}}>
                  <div style={{flex:1}}>
                    <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}>
                      <span style={{fontSize:16,fontWeight:800,color:C.ink}}>{r.customer_name}</span>
                      <span style={{fontSize:11,fontWeight:700,color:sc.color,background:sc.bg,padding:'2px 8px',borderRadius:20}}>{sc.label}</span>
                    </div>
                    <div style={{display:'flex',gap:16,fontSize:12,color:C.mid,flexWrap:'wrap'}}>
                      <span>◷ {fmtTime(r.reservation_time)}</span>
                      <span style={{display:'inline-flex',alignItems:'center',gap:4}}><Icon name="users" size={12} /> {r.guests} personas</span>
                      {r.table_id&&<span>Mesa asignada</span>}
                      {r.occasion&&<span>{OCCASION_LABEL[r.occasion]||r.occasion}</span>}
                    </div>
                    <div style={{fontSize:12,color:C.mid,marginTop:4}}>
                      {r.customer_phone}
                      <span style={{marginLeft:12,color:C.dim,fontFamily:'monospace',fontSize:11}}>{r.confirm_num}</span>
                    </div>
                    {r.notes&&<div style={{fontSize:11,color:C.mid,marginTop:6,fontStyle:'italic',borderTop:`1px solid ${C.border}`,paddingTop:6}}>{r.notes}</div>}
                  </div>
                  <button onClick={()=>setEditModal(r)} style={{padding:'4px 10px',borderRadius:6,border:`1px solid ${C.border}`,background:'transparent',color:C.mid,fontSize:11,cursor:'pointer',flexShrink:0}}>Editar</button>
                </div>

                <div style={{display:'flex',gap:8,marginTop:12,flexWrap:'wrap'}}>
                  {r.status==='pending'&&<>
                    <button onClick={()=>updateStatus(r.id,'confirmed')} style={{padding:'6px 14px',borderRadius:6,border:'none',background:'#34C759',color:'#fff',fontSize:12,fontWeight:700,cursor:'pointer'}}>✓ Confirmar</button>
                    <button onClick={()=>updateStatus(r.id,'cancelled')} style={{padding:'6px 14px',borderRadius:6,border:`1px solid ${C.border}`,background:'transparent',color:'#FF3B30',fontSize:12,fontWeight:600,cursor:'pointer'}}>✕ Cancelar</button>
                  </>}
                  {r.status==='confirmed'&&<>
                    <button onClick={()=>updateStatus(r.id,'seated')} style={{padding:'6px 14px',borderRadius:6,border:'none',background:'#007AFF',color:'#fff',fontSize:12,fontWeight:700,cursor:'pointer'}}>Sentar</button>
                    <button onClick={()=>updateStatus(r.id,'no_show')} style={{padding:'6px 14px',borderRadius:6,border:`1px solid ${C.border}`,background:'transparent',color:C.mid,fontSize:12,fontWeight:600,cursor:'pointer'}}>No llegó</button>
                    <button onClick={()=>updateStatus(r.id,'cancelled')} style={{padding:'6px 14px',borderRadius:6,border:`1px solid ${C.border}`,background:'transparent',color:'#FF3B30',fontSize:12,fontWeight:600,cursor:'pointer'}}>✕ Cancelar</button>
                  </>}
                  {r.status==='seated'&&<span style={{fontSize:12,color:'#007AFF',fontWeight:600}}>Cliente en mesa</span>}
                  {(r.status==='no_show'||r.status==='cancelled')&&(
                    <button onClick={()=>updateStatus(r.id,'pending')} style={{padding:'6px 14px',borderRadius:6,border:`1px solid ${C.border}`,background:'transparent',color:C.mid,fontSize:12,cursor:'pointer'}}>↩ Reactivar</button>
                  )}
                  <a href={`https://wa.me/${r.customer_phone.replace(/\D/g,'')}`} target="_blank"
                    style={{padding:'6px 12px',borderRadius:6,border:`1px solid #25D366`,background:'transparent',color:'#25D366',fontSize:12,fontWeight:600,textDecoration:'none'}}>
                    WhatsApp
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(newModal||editModal)&&(
        <ReservaFormModalCaja
          reserva={editModal}
          tables={tables}
          onClose={()=>{setNewModal(false);setEditModal(null);}}
          onSaved={()=>{setNewModal(false);setEditModal(null);load();}}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   PANEL: FACTURAS DEL TURNO
═══════════════════════════════════════════ */
function FacturasCajaPanel({turno}){
  const [cobros,setCobros]=useState([]);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    if(!db)return;
    db.from('movimientos_caja')
      .select('id,created_at,monto,metodo_pago,descripcion,pedido_id,metadata,usuario_nombre')
      .eq('turno_id',turno.id).eq('tipo','cobro')
      .order('created_at',{ascending:false})
      .then(({data})=>{setCobros(data||[]);setLoading(false);});
  },[turno.id]);

  const total=cobros.reduce((s,m)=>s+Number(m.monto||0),0);
  const MET={efectivo:'Efectivo',tarjeta_credito:'T.Crédito',tarjeta_debito:'T.Débito',qr:'QR',mixto:'Mixto'};

  async function reimprimir(c){
    const meta=c.metadata||{};
    let items=[], ord=null;
    if(c.pedido_id){
      // Backfill desde el pedido: cliente/mesa/fecha (el mov sólo guarda un string de mesa).
      const[{data:oi},{data:o}]=await Promise.all([
        // total_price + extras: si no, la reimpresión lista precios sin agregados
        // y las líneas no cierran contra el TOTAL cobrado.
        db.from('order_items').select('item_name,quantity,unit_price,total_price,observations,order_item_extras(extra_name)').eq('order_id',c.pedido_id),
        db.from('orders').select('customer_name,customer_ruc,created_at,tables(number)').eq('id',c.pedido_id).maybeSingle(),
      ]);
      items=oi||[]; ord=o||null;
    }
    const tableLabel=ord?.tables?.number?`Mesa ${ord.tables.number}`:(meta.mesa||c.descripcion||'—');
    printTicket({
      orderNumber:meta.orden_numero||'—',
      mesa:tableLabel,
      customerName:ord?.customer_name||null,
      customerRuc:ord?.customer_ruc||null,
      cashier:c.usuario_nombre||null,   // el cajero queda en la columna del mov, no en metadata
      createdAt:ord?.created_at||c.created_at||null,
      items,
      total:Number(c.monto||0),
      metodo:c.metodo_pago,
      cambio:Number(meta.cambio||0),
    });
  }

  return(
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16,gap:10,flexWrap:'wrap'}}>
        <h1 style={{fontSize:20,fontWeight:800}}>Facturas del turno</h1>
        <div style={{fontFamily:"'SF Mono',monospace",fontSize:16,fontWeight:800,color:'#34C759'}}>{fmt(total)}</div>
      </div>

      {/* Placeholder facturación electrónica */}
      <div style={{background:'rgba(0,122,255,0.06)',border:'1px solid rgba(0,122,255,0.2)',borderRadius:10,padding:'12px 16px',marginBottom:20,display:'flex',alignItems:'center',gap:12}}>
        <span style={{display:'flex',flexShrink:0,color:'#007AFF'}}><Icon name="fileText" size={22} /></span>
        <div>
          <div style={{fontSize:13,fontWeight:700,color:'#007AFF'}}>Facturación electrónica SET (SIFEN)</div>
          <div style={{fontSize:11,color:C.mid,marginTop:2}}>Próximamente — integración con la SET de Paraguay para emisión de facturas electrónicas (e-Kuatia).</div>
        </div>
        <span style={{marginLeft:'auto',fontSize:10,fontWeight:700,color:'#007AFF',background:'rgba(0,122,255,0.1)',padding:'3px 8px',borderRadius:10,whiteSpace:'nowrap'}}>PRÓX.</span>
      </div>

      {loading&&<div style={{textAlign:'center',padding:40}}><span className="spin"/></div>}

      {!loading&&cobros.length===0&&(
        <div style={{textAlign:'center',padding:'60px 0',color:C.mid}}>
          <div style={{marginBottom:12,display:'flex',justifyContent:'center'}}><Icon name="receipt" size={34} /></div>
          <div style={{fontSize:14,fontWeight:700}}>Sin facturas en este turno</div>
          <div style={{fontSize:12,marginTop:4}}>Aparecen aquí al cobrar pedidos</div>
        </div>
      )}

      {!loading&&cobros.length>0&&(
        <div style={{display:'flex',flexDirection:'column',gap:8}}>
          {cobros.map(c=>{
            const meta=c.metadata||{};
            const hora=new Date(c.created_at).toLocaleTimeString('es-PY',{hour:'2-digit',minute:'2-digit'});
            return(
              <div key={c.id} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:'12px 14px',display:'flex',alignItems:'center',gap:12}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:2}}>
                    <span style={{fontSize:13,fontWeight:800}}>#{meta.orden_numero||'—'}</span>
                    <span style={{fontSize:11,color:C.mid}}>{meta.mesa||'—'}</span>
                    <span style={{fontSize:10,background:'var(--bg-subtle)',borderRadius:6,padding:'1px 6px',color:C.mid,fontWeight:600}}>{MET[c.metodo_pago]||c.metodo_pago}</span>
                  </div>
                  <div style={{fontSize:11,color:C.dim}}>{hora}</div>
                </div>
                <div style={{fontFamily:"'SF Mono',monospace",fontSize:16,fontWeight:800,color:'#34C759',flexShrink:0}}>{fmt(c.monto)}</div>
                <button onClick={()=>reimprimir(c)} title="Reimprimir ticket" style={{padding:'6px 10px',borderRadius:6,border:`1px solid ${C.border}`,background:'transparent',color:C.mid,cursor:'pointer',flexShrink:0,display:'inline-flex',alignItems:'center'}}><Icon name="print" size={14} /></button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   PANEL: HISTORIAL DE PEDIDOS
═══════════════════════════════════════════ */
function HistorialPanel({onGoCobros}){
  const [orders,setOrders]=useState([]);
  const [loading,setLoading]=useState(true);
  const [rango,setRango]=useState('hoy');
  const [statusFlt,setStatusFlt]=useState('todos');
  const [tipoFlt,setTipoFlt]=useState('todos');
  const [metFlt,setMetFlt]=useState('todos');   // filtro por método de pago (transferencia/tarjeta/efectivo)
  const [searchQ,setSearchQ]=useState('');
  const [alertaPendientes,setAlertaPendientes]=useState(0);

  useEffect(()=>{load();},[rango]);

  async function load(){
    setLoading(true);
    let from=new Date();
    if(rango==='hoy'){from.setHours(0,0,0,0);}
    else if(rango==='7d'){from=new Date(Date.now()-7*86400000);}
    else if(rango==='30d'){from=new Date(Date.now()-30*86400000);}
    else{from=new Date(0);}

    const baseCols='id,order_number,status,payment_status,total,order_type,customer_name,created_at,table_id,payment_method,payment_reference,tables(number)';
    const extCols=baseCols+',payment_proof_url,payment_review_status,payment_review_note';
    const runQ=cols=>db.from('orders').select(cols).eq('restaurant_id',RID)
      .gte('created_at',from.toISOString()).order('created_at',{ascending:false}).limit(300);
    let {data,error}=await runQ(extCols);
    if(error){ const r=await runQ(baseCols); data=r.data; error=r.error; }  // fail-open: mig 182 sin aplicar
    if(!error){
      const rows=data||[];
      setOrders(rows);
      // Alerta: pedidos que llegaron al historial sin cobrar (no cancelados, payment_status != paid)
      const pendCount=rows.filter(o=>o.status!=='cancelled'&&o.payment_status!=='paid'&&Number(o.total||0)>=0).length;
      setAlertaPendientes(pendCount);
    }
    setLoading(false);
  }

  // Validación del pago (mig 182 · FASE D2): aprobar/rechazar un cobro por
  // transferencia + bitácora inmutable. Optimista; fail-open si la mig no está.
  async function doReview(o,action){
    let note=null;
    if(action==='rejected'){ note=(window.prompt('Motivo del rechazo (opcional):')||'').trim()||null; }
    setOrders(prev=>prev.map(x=>x.id===o.id?{...x,payment_review_status:action,payment_review_note:note}:x));
    const r=await recordPaymentReview(db,{restaurantId:RID,orderId:o.id,action,note});
    if(!r.applied){ toast('No se pudo persistir la validación — ¿está aplicada la migración 182?'+(r.error?' ('+r.error+')':''),false); }
    else{ toast(action==='approved'?'Pago verificado':'Pago rechazado'); }
  }

  const STATUS_OPTIONS=[
    {id:'todos',lbl:'Todos'},
    {id:'confirmed',lbl:'Sin cobrar'},
    {id:'paid',lbl:'Cobrado'},
    {id:'kitchen_received',lbl:'En cocina'},
    {id:'cooking',lbl:'Preparando'},
    {id:'ready',lbl:'Listo'},
    {id:'delivered',lbl:'Entregado'},
    {id:'cancelled',lbl:'Cancelado'},
  ];
  const TIPO_OPTIONS=[
    {id:'todos',lbl:'Todos'},
    {id:'local',lbl:'Salón'},
    {id:'dine_in',lbl:'QR mesa'},
    {id:'llevar',lbl:'Para llevar'},
    {id:'takeaway',lbl:'Para llevar'},
    {id:'delivery',lbl:'Delivery'},
  ];

  const display=orders.filter(o=>{
    if(statusFlt!=='todos'&&o.status!==statusFlt)return false;
    if(tipoFlt!=='todos'&&o.order_type!==tipoFlt)return false;
    if(metFlt!=='todos'){
      const pm=o.payment_method||'';
      if(metFlt==='transferencia'&&!(pm==='qr'||pm==='transferencia'))return false;
      if(metFlt==='tarjeta'&&!(pm==='tarjeta'||pm==='pos'))return false;
      if(metFlt==='efectivo'&&pm!=='efectivo')return false;
    }
    if(searchQ){
      const q=searchQ.toLowerCase();
      if(!(o.order_number||'').toLowerCase().includes(q)&&!(o.customer_name||'').toLowerCase().includes(q)&&!String(o.tables?.number||'').includes(q))return false;
    }
    return true;
  });

  const totalCobrado=display.filter(o=>o.payment_status==='paid').reduce((s,o)=>s+Number(o.total||0),0);
  const totalSinCobrar=display.filter(o=>o.status!=='cancelled'&&o.payment_status!=='paid').reduce((s,o)=>s+Number(o.total||0),0);
  const totalCancelado=display.filter(o=>o.status==='cancelled').reduce((s,o)=>s+Number(o.total||0),0);

  const TIPO_LBL={local:'Caja/Salón',llevar:'Para llevar',delivery:'Delivery',dine_in:'QR mesa',takeaway:'Para llevar'};
  const MET_LBL={efectivo:'Efectivo',tarjeta_credito:'Tarjeta Cred.',tarjeta_debito:'Tarjeta Déb.',qr:'QR/Transfer.',mixto:'Mixto',tarjeta:'Tarjeta',pos:'POS/Mixto',transferencia:'Transferencia'};

  return(
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16,gap:10,flexWrap:'wrap'}}>
        <h1 style={{fontSize:20,fontWeight:800}}>Historial de pedidos</h1>
        <Btn small variant="secondary" onClick={load}>↻ Actualizar</Btn>
      </div>

      {alertaPendientes>0&&(
        <div style={{background:'rgba(255,59,48,0.08)',border:'2px solid rgba(255,59,48,0.5)',borderRadius:10,padding:'12px 16px',marginBottom:16,display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap'}}>
          <div>
            <div style={{fontWeight:800,color:'#FF3B30',fontSize:14}}>{alertaPendientes} pedido{alertaPendientes>1?'s':''} sin cobrar en el historial</div>
            <div style={{fontSize:12,color:C.mid,marginTop:2}}>Estos pedidos no deberían estar aquí sin cobrar. Ir a cobrar para resolverlos.</div>
          </div>
          {onGoCobros&&<button onClick={onGoCobros} style={{background:'#FF3B30',color:'#fff',border:'none',padding:'8px 16px',borderRadius:8,fontSize:13,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap'}}>Ir a cobrar →</button>}
        </div>
      )}

      {/* Filtros */}
      <div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap',alignItems:'center'}}>
        {/* Rango */}
        <div style={{display:'flex',gap:0,background:'var(--bg-subtle)',borderRadius:8,padding:3}}>
          {[['hoy','Hoy'],['7d','7 días'],['30d','30 días'],['todo','Todo']].map(([id,lbl])=>(
            <button key={id} onClick={()=>setRango(id)} style={{
              padding:'5px 12px',borderRadius:6,border:'none',fontSize:12,fontWeight:rango===id?700:500,
              background:rango===id?C.white:'transparent',color:rango===id?C.ink:C.mid,
              cursor:'pointer',boxShadow:rango===id?'0 1px 4px rgba(0,0,0,0.15)':'none',
            }}>{lbl}</button>
          ))}
        </div>

        {/* Status filter */}
        <select value={statusFlt} onChange={e=>setStatusFlt(e.target.value)} style={{padding:'6px 10px',fontSize:12,borderRadius:6,border:`1px solid ${C.border}`,background:C.surface,color:C.ink,fontWeight:600}}>
          {STATUS_OPTIONS.map(s=><option key={s.id} value={s.id}>{s.lbl}</option>)}
        </select>

        {/* Tipo filter */}
        <select value={tipoFlt} onChange={e=>setTipoFlt(e.target.value)} style={{padding:'6px 10px',fontSize:12,borderRadius:6,border:`1px solid ${C.border}`,background:C.surface,color:C.ink,fontWeight:600}}>
          {TIPO_OPTIONS.map(t=><option key={t.id} value={t.id}>{t.lbl}</option>)}
        </select>

        {/* Método de pago filter — para revisar transferencias/tarjeta y sus comprobantes */}
        <select value={metFlt} onChange={e=>setMetFlt(e.target.value)} style={{padding:'6px 10px',fontSize:12,borderRadius:6,border:`1px solid ${C.border}`,background:C.surface,color:C.ink,fontWeight:600}}>
          <option value="todos">Todos los pagos</option>
          <option value="transferencia">Transferencia / QR</option>
          <option value="tarjeta">Tarjeta</option>
          <option value="efectivo">Efectivo</option>
        </select>

        {/* Búsqueda */}
        <input value={searchQ} onChange={e=>setSearchQ(e.target.value)} placeholder="Buscar #nro, mesa, cliente…"
          style={{padding:'6px 11px',fontSize:12,borderRadius:6,border:`1px solid ${C.border}`,width:200,color:C.ink}}/>
      </div>

      {/* KPIs */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))',gap:10,marginBottom:20}}>
        <KpiMini label="Total pedidos" value={display.length} accent={C.blue}/>
        <KpiMini label="Facturado" value={fmt(totalCobrado)} accent={C.green}/>
        <KpiMini label="Sin cobrar" value={fmt(totalSinCobrar)} accent={totalSinCobrar>0?C.red:C.mid}/>
        <KpiMini label="Cancelado" value={fmt(totalCancelado)} accent={totalCancelado>0?C.orange:C.mid}/>
      </div>

      {loading&&<div style={{textAlign:'center',padding:40}}><span className="spin"/></div>}

      {!loading&&display.length===0&&(
        <div style={{textAlign:'center',padding:'60px 0',color:C.mid}}>
          <div style={{fontSize:32,marginBottom:10}}>≡</div>
          <div style={{fontSize:14,fontWeight:600,color:C.ink}}>Sin pedidos en este período</div>
        </div>
      )}

      {!loading&&display.length>0&&(
        <div style={{display:'flex',flexDirection:'column',gap:8}}>
          {display.map(o=>{
            const mesa=o.tables?.number?`Mesa ${o.tables.number}`:o.customer_name||'Mostrador';
            const tipo=TIPO_LBL[o.order_type]||o.order_type||'—';
            const metodo=MET_LBL[o.payment_method]||'—';
            const esCobrado=o.payment_status==='paid';
            const esCancelado=o.status==='cancelled';
            const esSinCobrar=!esCancelado&&o.payment_status!=='paid';
            const borderColor=esCancelado?'rgba(255,59,48,0.3)':esSinCobrar?'rgba(255,149,0,0.4)':esCobrado?'rgba(52,199,89,0.3)':C.border;
            const isTransfer=['qr','transferencia','tarjeta','pos','tarjeta_credito','tarjeta_debito','mixto'].includes(o.payment_method);
            // Mostrar la fila de validación cuando hay comprobante/estado de revisión
            // (incluye pedidos AÚN sin cobrar: el cliente subió su transferencia y el
            // staff debe corroborarla ANTES de cobrar) o es un pago tipo transferencia ya cobrado.
            const showReview=!!(o.payment_proof_url||o.payment_review_status||(isTransfer&&esCobrado));
            const rMeta=reviewMeta(o.payment_review_status);
            return(
              <div key={o.id} style={{background:C.surface,border:`1px solid ${borderColor}`,borderRadius:8,padding:'10px 16px'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10}}>
                  <div style={{minWidth:0,flex:1}}>
                    <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                      <span style={{fontSize:13,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.ink}}>#{o.order_number}</span>
                      <Badge txt={SL[o.status]||o.status} color={SC[o.status]||'#6E6E73'}/>
                      <span style={{fontSize:11,color:C.mid,fontWeight:500}}>{tipo}</span>
                      <span style={{fontSize:11,color:C.mid}}>{mesa}</span>
                    </div>
                    <div style={{fontSize:11,color:C.mid,marginTop:4,display:'flex',gap:12,flexWrap:'wrap'}}>
                      <span>{fmtDT(o.created_at)}</span>
                      {o.payment_method&&<span style={{display:'inline-flex',alignItems:'center',gap:4}}><Icon name="creditCard" size={12} /> {metodo}</span>}
                      {o.payment_reference&&<span style={{display:'inline-flex',alignItems:'center',gap:4,color:C.ink,fontWeight:600}}><Icon name="receipt" size={12} /> Comp. {o.payment_reference}</span>}
                    </div>
                  </div>
                  <div style={{textAlign:'right',flexShrink:0}}>
                    <div style={{fontSize:16,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:esCancelado?C.red:esSinCobrar?C.orange:C.green}}>{fmt(o.total)}</div>
                    {esSinCobrar&&<div style={{fontSize:10,color:C.orange,fontWeight:700,marginTop:2}}>PENDIENTE</div>}
                  </div>
                </div>
                {showReview&&(
                  <div style={{marginTop:8,paddingTop:8,borderTop:`1px dashed ${C.border}`,display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
                    {o.payment_proof_url&&<ProofImage db={db} value={o.payment_proof_url} size={38} style={{borderRadius:6}}/>}
                    {rMeta
                      ? <span style={{fontSize:11,fontWeight:700,color:rMeta.color,display:'inline-flex',alignItems:'center',gap:5}}><span style={{width:7,height:7,borderRadius:'50%',background:rMeta.color}}/>{rMeta.label}</span>
                      : <span style={{fontSize:11,color:C.mid,display:'inline-flex',alignItems:'center',gap:5}}><span style={{width:7,height:7,borderRadius:'50%',background:C.mid}}/>Sin validar</span>}
                    {o.payment_review_note&&<span style={{fontSize:11,color:C.mid,fontStyle:'italic'}}>“{o.payment_review_note}”</span>}
                    <div style={{marginLeft:'auto',display:'flex',gap:6}}>
                      {o.payment_review_status!=='approved'&&<button onClick={()=>doReview(o,'approved')} style={{background:'rgba(52,199,89,0.12)',border:'1px solid rgba(52,199,89,0.35)',color:'#2FA84F',padding:'4px 12px',fontSize:11,fontWeight:700,borderRadius:6,cursor:'pointer'}}>✓ Aprobar</button>}
                      {o.payment_review_status!=='rejected'&&<button onClick={()=>doReview(o,'rejected')} style={{background:'rgba(255,59,48,0.10)',border:'1px solid rgba(255,59,48,0.30)',color:'#FF3B30',padding:'4px 12px',fontSize:11,fontWeight:700,borderRadius:6,cursor:'pointer'}}>✕ Rechazar</button>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AvisosCajaPanel({broadcasts=[]}){
  if(broadcasts.length===0) return(
    <div style={{padding:40,textAlign:'center',color:C.mid}}>
      <div style={{fontSize:32,marginBottom:12,color:C.dim}}>—</div>
      <div style={{fontSize:15,fontWeight:600}}>Sin avisos del personal</div>
      <div style={{fontSize:12,marginTop:4}}>Los avisos del admin o gerente aparecerán aquí</div>
    </div>
  );
  return(
    <div>
      <h2 style={{fontSize:18,fontWeight:800,marginBottom:16}}>Avisos del personal</h2>
      <div style={{display:'flex',flexDirection:'column',gap:10}}>
        {broadcasts.map(b=>(
          <div key={b.id} style={{background:C.white,border:`1px solid ${C.border}`,borderLeft:'4px solid #007AFF',borderRadius:10,padding:'14px 16px'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
              <span style={{fontSize:12,fontWeight:700,color:C.dim}}>{b.sender_name}</span>
              <span style={{fontSize:11,color:C.dim}}>{new Date(b.created_at).toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit'})} · {new Date(b.created_at).toLocaleDateString('es',{day:'2-digit',month:'2-digit'})}</span>
            </div>
            <div style={{fontSize:14,color:C.ink,lineHeight:1.5}}>{b.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   QR PARA CLIENTES — MOSTRADOR (sin mesa)
   Deriva al panel cliente SIN número de mesa: el cliente elige comer
   en el local o para llevar. No confundir con los QR POR MESA (Admin →
   Mesas), que llevan ?t=<token> y traen la mesa asignada.
   Cuerpo reutilizable: se monta dentro del modal flotante de Vista del Salón.
═══════════════════════════════════════════ */
function QrMostradorBody(){
  const clientUrl = `${window.location.origin}/?r=${encodeURIComponent(RID||'')}`;
  const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=420x420&margin=12&data=${encodeURIComponent(clientUrl)}`;
  const [copied,setCopied]=useState(false);

  function copy(){
    try{ navigator.clipboard.writeText(clientUrl); setCopied(true); setTimeout(()=>setCopied(false),1800); }catch(e){}
  }
  function imprimir(){
    const w=window.open('','_blank','width=520,height=680');
    if(!w) return;
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>QR Mostrador</title>'
      +'<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center;padding:32px;color:#1D1D1F}'
      +'h1{font-size:22px;margin:0 0 4px}p{color:#6E6E73;font-size:13px;margin:4px 0 20px}'
      +'img{width:320px;height:320px}small{display:block;margin-top:16px;color:#86868B;font-size:11px;word-break:break-all}</style></head>'
      +'<body><h1>Pedí desde tu celular</h1><p>Escaneá el código · Elegí comer en el local o para llevar</p>'
      +'<img src="'+qrImg+'" alt="QR"/><small>'+clientUrl+'</small>'
      +'<scr'+'ipt>window.onload=function(){setTimeout(function(){window.print();},300);}</scr'+'ipt></body></html>');
    w.document.close();
  }

  return (
    <div>
      <p style={{fontSize:13,color:C.mid,marginBottom:18,lineHeight:1.5}}>
        Pegá este QR en el mostrador. Quien lo escanee verá el menú <strong>sin mesa asignada</strong> y elegirá si quiere
        comer en el local o para llevar. Para pedidos en mesa, generá los QR por mesa en <strong>Admin → Mesas</strong>.
      </p>
      {!RID ? (
        <div style={{color:C.red,fontSize:13}}>No se pudo identificar el restaurante de esta caja. Volvé a iniciar sesión.</div>
      ) : (
      <div style={{display:'flex',flexDirection:'column',gap:16,alignItems:'center'}}>
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:16,padding:20,textAlign:'center'}}>
          <img src={qrImg} width={220} height={220} style={{borderRadius:10,display:'block'}} alt="QR mostrador"/>
          <div style={{fontSize:11,color:C.dim,marginTop:10,fontWeight:700,letterSpacing:'0.06em',textTransform:'uppercase'}}>QR Mostrador</div>
        </div>
        <div style={{width:'100%',display:'flex',flexDirection:'column',gap:12}}>
          <div>
            <div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:'0.06em',textTransform:'uppercase',marginBottom:6}}>Link del cliente</div>
            <div style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:12,color:C.ink,background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:'10px 12px',wordBreak:'break-all'}}>{clientUrl}</div>
          </div>
          <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
            <button onClick={copy} style={{padding:'10px 18px',background:C.ink,color:C.sidebar,border:'none',borderRadius:8,fontSize:13,fontWeight:700,cursor:'pointer'}}>{copied?'¡Copiado!':'Copiar link'}</button>
            <button onClick={imprimir} style={{padding:'10px 18px',background:'transparent',color:C.ink,border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontWeight:700,cursor:'pointer'}}>Imprimir QR</button>
          </div>
          <div style={{fontSize:12,color:C.mid,background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:'10px 12px',lineHeight:1.5}}>
            <strong>Tip:</strong> este QR es general del local y no caduca. Sirve para pedidos para llevar o consumo en barra/mostrador.
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   DASHBOARD PRINCIPAL DEL TURNO
═══════════════════════════════════════════ */
function DashboardCaja({turno,profile,onCierre}){
  const [panel,setPanel]=useState(()=>{
    const p=localStorage.getItem('caja_panel')||'salon';
    return p==='qr_cliente'?'salon':p; // módulo migrado a botón flotante en Vista del Salón
  });
  const [movimientos,setMovimientos]=useState([]);
  const [paymentCalls,setPaymentCalls]=useState([]);
  const [broadcasts,setBroadcasts]=useState([]);
  const lastSeenBroadcasts=useRef(parseInt(localStorage.getItem('caja_bc_seen')||'0'));
  const [isOnline,setIsOnline]=useState(navigator.onLine);
  const [pendingOffline,setPendingOffline]=useState(()=>offlineQ.pending().length);
  const [,forceRender]=useReducer(x=>x+1,0);
  const [cajaNombre,setCajaNombre]=useState('');   // nombre de la caja del turno (multi-caja)
  // Sidebar colapsable (persistente): main a ancho completo al ocultarlo.
  const [navOpen,setNavOpen]=useState(()=>{try{return localStorage.getItem('caja_nav_open')!=='0';}catch{return true;}});
  const toggleNav=()=>setNavOpen(v=>{const n=!v;try{localStorage.setItem('caja_nav_open',n?'1':'0');}catch{} return n;});
  function changePanel(p){localStorage.setItem('caja_panel',p);setPanel(p);}

  // Nombre de la caja activa (si el turno tiene caja_id) para mostrarlo en el header.
  useEffect(()=>{
    if(!db||!turno?.caja_id){setCajaNombre('');return;}
    db.from('cajas').select('nombre').eq('id',turno.caja_id).maybeSingle()
      .then(({data})=>setCajaNombre(data?.nombre||''));
  },[turno?.caja_id]);

  useEffect(()=>{
    const onOn=()=>{setIsOnline(true);syncOfflineOrders();};
    const onOff=()=>setIsOnline(false);
    window.addEventListener('online',onOn);
    window.addEventListener('offline',onOff);
    return()=>{window.removeEventListener('online',onOn);window.removeEventListener('offline',onOff);};
  },[]);

  /* Avisos del personal */
  useEffect(()=>{
    if(!db)return;
    const load=async()=>{
      const{data}=await db.from('staff_broadcasts')
        .select('*').eq('restaurant_id',RID)
        .overlaps('target_roles',['cajero','todos','trabajadores'])
        .order('created_at',{ascending:false}).limit(30);
      setBroadcasts(data||[]);
    };
    load();
    const ch=db.channel('bc-caja')
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'staff_broadcasts'},()=>load())
      .subscribe();
    return()=>db.removeChannel(ch);
  },[]);

  async function syncOfflineOrders(){
    const pending=offlineQ.pending();
    if(!pending.length)return;
    for(const o of pending){
      try{
        const{data:ord,error:e1}=await db.from('orders').insert({
          restaurant_id:RID,order_type:o.order_type,table_id:o.table_id||null,
          customer_name:o.customer_name||null,status:'paid',payment_status:'paid',
          payment_method:mapOrderPM(o.metodo),total:o.total,created_by:profile.id,
          notes:'Pedido offline sincronizado',
        }).select().single();
        if(e1)throw e1;
        if(o.items?.length){
          await db.from('order_items').insert(o.items.map(it=>({
            order_id:ord.id,item_id:it.item?.id||null,item_name:it.item?.name||it.item_name,
            quantity:it.quantity,unit_price:it.item?.price_guarani||it.unit_price||0,
          })));
        }
        offlineQ.markSynced(o.local_id);
        setPendingOffline(offlineQ.pending().length);
        toast(`Pedido LOCAL-${o.local_num} sincronizado ✓`);
      }catch(err){
        toast(`Error al sincronizar pedido offline: ${err.message}`,false);
      }
    }
  }

  // Escuchar solicitudes de cobro del mozo (waiter_calls type=payment_request)
  useEffect(()=>{
    if(!db)return;
    let lastIds=new Set();
    const loadCalls=async()=>{
      const{data}=await db.from('waiter_calls')
        .select('id,table_id,created_at,type,tables(number)')
        .eq('restaurant_id',RID).eq('status','pending').eq('type','payment_request')
        .order('created_at',{ascending:false});
      const calls=data||[];
      // Notificar nuevos
      const fresh=calls.filter(c=>!lastIds.has(c.id));
      if(lastIds.size>0&&fresh.length>0){
        fresh.forEach(c=>{
          const mesa=c.tables?.number?`Mesa ${c.tables.number}`:'Mesa ?';
          toast(`${mesa} solicita cobro`,true);
          try{
            const ctx=new (window.AudioContext||window.webkitAudioContext)();
            const osc=ctx.createOscillator();const g=ctx.createGain();
            osc.connect(g);g.connect(ctx.destination);
            osc.frequency.value=880;g.gain.value=0.15;
            osc.start();osc.stop(ctx.currentTime+0.15);
            setTimeout(()=>{
              const o2=ctx.createOscillator();const g2=ctx.createGain();
              o2.connect(g2);g2.connect(ctx.destination);
              o2.frequency.value=1100;g2.gain.value=0.15;
              o2.start();o2.stop(ctx.currentTime+0.15);
            },180);
          }catch(e){}
        });
      }
      lastIds=new Set(calls.map(c=>c.id));
      setPaymentCalls(calls);
    };
    loadCalls();
    const ch=db.channel('caja-payment-calls')
      .on('postgres_changes',{event:'*',schema:'public',table:'waiter_calls',filter:`restaurant_id=eq.${RID}`},loadCalls)
      .subscribe();
    const onVis=()=>{if(document.visibilityState==='visible')loadCalls();};
    document.addEventListener('visibilitychange',onVis);
    return()=>{db.removeChannel(ch);document.removeEventListener('visibilitychange',onVis);};
  },[]);

  async function attendPaymentCall(callId){
    if(!db)return;
    await db.from('waiter_calls').update({status:'attended',attended_at:new Date().toISOString()}).eq('id',callId);
    setPaymentCalls(p=>p.filter(c=>c.id!==callId));
  }
  function toggleTheme(){ if (window.MythosTheme) window.MythosTheme.toggle(); }
  useEffect(() => {
    const onTheme = e => { Object.assign(C, e.detail.mode==='dark'?C_DARK:C_LIGHT); forceRender(); };
    document.addEventListener('mythos:themechange', onTheme);
    return () => document.removeEventListener('mythos:themechange', onTheme);
  }, []);

  useEffect(()=>{loadMovimientos();},[turno.id]);
  useEffect(()=>{
    if(!db)return;
    const ch=db.channel(`movimientos-rt-${turno.id}`)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'movimientos_caja',filter:`turno_id=eq.${turno.id}`},(payload)=>{
        setMovimientos(p=>p.find(m=>m.id===payload.new.id)?p:[payload.new,...p]);
      })
      .subscribe();
    return()=>db.removeChannel(ch);
  },[turno.id]);

  async function loadMovimientos(){
    const{data}=await db.from('movimientos_caja').select('*').eq('turno_id',turno.id).order('created_at',{ascending:false});
    setMovimientos(data||[]);
  }
  function addMovimiento(m){setMovimientos(p=>p.find(x=>x.id===m.id)?p:[m,...p]);}

  function handleCierre(){
    if(panel==='cierre')return;
    loadMovimientos();
    onCierre();
  }

  const renderPanel=()=>{
    switch(panel){
      case 'salon':            return <SalonPanel         turno={turno} profile={profile}/>;
      case 'pedido':           return <TomarPedidoPanel   turno={turno} profile={profile} onMovimiento={addMovimiento}/>;
      case 'cobros':           return <CobrosPanel       turno={turno} profile={profile} movimientos={movimientos} onMovimiento={addMovimiento}/>;
      case 'avisos':           return <AvisosCajaPanel   broadcasts={broadcasts}/>;
      case 'facturas':         return <FacturasCajaPanel  turno={turno}/>;
      case 'historial':        return <HistorialPanel onGoCobros={()=>changePanel('cobros')}/>;
      case 'cancelaciones':    return <CancelacionesPanel turno={turno} profile={profile} onMovimiento={addMovimiento}/>;
      case 'ingresos_egresos': return <IngresosEgresosPanel turno={turno} profile={profile} movimientos={movimientos} onMovimiento={addMovimiento}/>;
      case 'reservas':          return <ReservasPanel/>;
      case 'quejas':           return <QuejasPanel       turno={turno} profile={profile}/>;
      case 'retiro':           return <RetiroPanel       turno={turno} profile={profile} movimientos={movimientos} onMovimiento={addMovimiento}/>;
      case 'cierre':           return <CierreCajaPanel   turno={turno} cajaNombre={cajaNombre} movimientos={movimientos} profile={profile} onCierre={handleCierre}/>;
      default: return null;
    }
  };

  return(
    <div style={{display:'flex',minHeight:'100vh'}}>
      {navOpen && <SidebarTurno turno={turno} cajaNombre={cajaNombre} movimientos={movimientos} panel={panel} setPanel={(p)=>{if(p==='avisos'){const now=Date.now();localStorage.setItem('caja_bc_seen',now);lastSeenBroadcasts.current=now;}changePanel(p);}} profile={profile} onToggleTheme={toggleTheme} paymentCalls={paymentCalls.length} onClickCalls={()=>changePanel('cobros')} isOnline={isOnline} pendingOffline={pendingOffline} broadcastCount={broadcasts.filter(b=>new Date(b.created_at).getTime()>lastSeenBroadcasts.current).length}/>}
      <main style={{flex:1,padding:24,overflowY:'auto',minWidth:0}}>
        <button onClick={toggleNav} title={navOpen?'Ocultar menú':'Mostrar menú'}
          style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:6,padding:'7px 9px',cursor:'pointer',display:'flex',flexDirection:'column',justifyContent:'center',gap:3,marginBottom:16}}>
          <span style={{width:15,height:2,background:C.mid,display:'block',borderRadius:2}}/>
          <span style={{width:15,height:2,background:C.mid,display:'block',borderRadius:2}}/>
          <span style={{width:15,height:2,background:C.mid,display:'block',borderRadius:2}}/>
        </button>
        {paymentCalls.length>0&&(
          <div style={{background:'rgba(255,149,0,0.12)',border:'1px solid rgba(255,149,0,0.5)',borderRadius:10,padding:'12px 16px',marginBottom:16,display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}}>
            <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
              <span style={{display:'flex',color:C.ink}}><Icon name="money" size={18} /></span>
              <span style={{fontSize:13,fontWeight:700,color:C.ink}}>
                {paymentCalls.length===1?'1 mesa solicita cobro':`${paymentCalls.length} mesas solicitan cobro`}
              </span>
              <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                {paymentCalls.slice(0,5).map(c=>(
                  <span key={c.id} style={{background:'#FF9500',color:'#fff',padding:'2px 8px',borderRadius:10,fontSize:11,fontWeight:700}}>
                    Mesa {c.tables?.number||'?'}
                  </span>
                ))}
              </div>
            </div>
            <div style={{display:'flex',gap:6}}>
              <button onClick={()=>changePanel('cobros')} style={{background:'#FF9500',color:'#fff',border:'none',padding:'6px 14px',borderRadius:6,fontSize:12,fontWeight:700,cursor:'pointer'}}>Ir a cobrar</button>
              <button onClick={()=>paymentCalls.forEach(c=>attendPaymentCall(c.id))} style={{background:'rgba(0,0,0,0.06)',color:C.ink,border:'1px solid rgba(0,0,0,0.1)',padding:'6px 12px',borderRadius:6,fontSize:12,fontWeight:600,cursor:'pointer'}}>Atender todas</button>
            </div>
          </div>
        )}
        {renderPanel()}
      </main>
      <ToastContainer/>
      <CalculadoraFlotante/>
    </div>
  );
}

/* ═══════════════════════════════════════════
   APP PRINCIPAL
═══════════════════════════════════════════ */
function CajaApp({profile}){
  const [turno,setTurno]=useState(null);
  const [turnoConflicto,setTurnoConflicto]=useState(null);
  const [loading,setLoading]=useState(true);
  const [cerrado,setCerrado]=useState(false);
  const [cajas,setCajas]=useState([]);            // cajas ACTIVAS del local (multi-caja, mig 126/127)
  const [openTurnos,setOpenTurnos]=useState([]);  // turnos abiertos del local (para marcar cajas ocupadas)
  // Capacidades del plan (Omni-Gating por feature) — carga única + re-render
  if(window.MythosGating) window.MythosGating.useCapabilities(db, RID);

  // Multi-tenant Engine: fail-safe — sin tenant en sesión, limpia y expulsa al login (salvo superadmin).
  useEffect(()=>{
    if((!RESTAURANT_ID||!RESTAURANT_ID.trim())&&localStorage.getItem('mythos_role')!=='superadmin'){
      localStorage.clear();
      window.location.href='/login.html';
    }
  },[]);

  useEffect(()=>{checkTurno();},[]);

  async function checkTurno(){
    setLoading(true);
    setTurnoConflicto(null);
    // Fase 2: varias cajas pueden tener turno abierto a la vez (una por caja).
    // Traemos TODOS los turnos abiertos + las cajas activas del local.
    const [openRes, cajasRes] = await Promise.all([
      db.from('turnos_caja').select('*').eq('restaurant_id',RID).eq('estado','abierto')
        .order('fecha_apertura',{ascending:false}),
      db.from('cajas').select('*').eq('restaurant_id',RID).eq('activa',true)
        .order('sort_order').order('created_at'),
    ]);
    const open = openRes.data||[];
    const activeCajas = cajasRes.error ? [] : (cajasRes.data||[]);  // sin tabla cajas (mig 126/127) → legacy
    setOpenTurnos(open);
    setCajas(activeCajas);

    // Comparación robusta (coerción a string evita mismatch por tipo/espacios).
    const mine = open.find(t=>String(t.cajero_id||'')===String(profile.id||''));
    const priv = ['admin','superadmin'].includes(profile.role);
    if(mine){
      // Un cajero = un turno. Si ya tengo el mío abierto, reconecto directo.
      setTurno(mine); setLoading(false); return;
    }
    // Legacy (sin cajas activas / migración no aplicada): conservar el flujo de
    // retomar la caja única que otro dejó abierta sin cierre.
    if(activeCajas.length===0 && open.length>0){
      if(priv) setTurno(open[0]); else setTurnoConflicto(open[0]);
      setLoading(false); return;
    }
    // Multi-caja, o sin turno abierto → pantalla de apertura con SELECTOR de caja.
    setLoading(false);
  }

  if(loading)return(
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:14}}>
      <span className="spin"/>
      <div style={{fontSize:12,color:C.dim}}>Verificando turno activo…</div>
    </div>
  );

  if(cerrado)return(
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:16,padding:20}}>
      <div style={{fontSize:40}}>✓</div>
      <div style={{fontFamily:'DM Serif Display',fontSize:24}}>Turno cerrado</div>
      <div style={{fontSize:13,color:C.mid}}>El arqueo quedó registrado correctamente.</div>
      <div style={{display:'flex',gap:10}}>
        <Btn onClick={()=>{setCerrado(false);setTurno(null);checkTurno();}}>Abrir nuevo turno</Btn>
        <Btn variant="danger" onClick={cerrarSesion}>Cerrar sesión</Btn>
      </div>
    </div>
  );

  if(turno)return <DashboardCaja turno={turno} profile={profile} onCierre={()=>{setTurno(null);setCerrado(true);}}/>;

  // Caja abierta por OTRO cajero (sesión anterior cerrada sin cierre de caja).
  // En vez de bloquear con el botón "Abrir Turno" deshabilitado, ofrecemos
  // retomar esa caja: el cajero entrante puede seguir cobrando o ir directo
  // al cierre/arqueo. No hace falta volver a hacer la apertura.
  if(turnoConflicto)return(
    <div style={{minHeight:'100vh',background:C.bg,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
      <div style={{width:'100%',maxWidth:480,animation:'fadeIn .2s ease'}}>
        <div style={{textAlign:'center',marginBottom:20}}>
          <div style={{marginBottom:8,display:'flex',justifyContent:'center',color:C.ink}}><Icon name="unlock" size={36} /></div>
          <div style={{fontFamily:'DM Serif Display',fontSize:26,marginBottom:6,color:C.ink}}>Caja abierta sin cierre</div>
          <div style={{fontSize:13,color:C.mid}}>
            Hay un turno abierto por <strong style={{color:C.ink}}>{turnoConflicto.cajero_nombre||'otro cajero'}</strong> desde {fmtDT(turnoConflicto.fecha_apertura)}.
          </div>
        </div>
        <AlertBox type="warn">
          La sesión anterior se cerró sin registrar el cierre de caja. Podés <strong>retomar esta caja</strong> para seguir cobrando o para hacer el arqueo/cierre. No hace falta volver a cargar la apertura.
        </AlertBox>
        <div style={{display:'flex',flexDirection:'column',gap:10,marginTop:18}}>
          <Btn full variant="primary" onClick={()=>{setTurno(turnoConflicto);setTurnoConflicto(null);}}>Retomar esta caja →</Btn>
          <Btn full variant="ghost" onClick={cerrarSesion}>Cerrar sesión</Btn>
        </div>
      </div>
    </div>
  );

  return <AperturaTurnoScreen profile={profile} cajas={cajas} openTurnos={openTurnos}
    onTurnoAbierto={t=>{setTurno(t);setTurnoConflicto(null);}}
    onRetomar={t=>{setTurno(t);setTurnoConflicto(null);}}/>;
}

/* ── AUTH GUARD ── */
async function initApp(session){
  const{data:profile}=await db.rpc('get_my_profile');
  if(!profile||!['admin','superadmin','cajero','cocina'].includes(profile.role)){
    await db.auth.signOut();window.location.replace('login.html');return;
  }
  if(!profile.id){profile.id=session.user.id;}
  if(profile.restaurant_id) RID = profile.restaurant_id;
  window._userProfile=profile;
  try{
    // Datos del negocio + config del comprobante (settings_json.receipt) para el
    // render 80mm. La identidad vive en restaurants; el diseño en restaurant_settings.
    const [{data:r},{data:st}] = await Promise.all([
      db.from('restaurants').select('name,address,phone,instagram,website,logo_url,logo_initials,ruc,legal_name,email').eq('id',RID).maybeSingle(),
      db.from('restaurant_settings').select('settings_json').eq('restaurant_id',RID).maybeSingle(),
    ]);
    window._restaurantName=r?.name||'Restaurante';
    const rcfg=(st&&st.settings_json&&st.settings_json.receipt)||{};
    const base=(window.MythosReceipt&&window.MythosReceipt.defaultConfig)||{};
    window._receiptConfig={
      ...base, ...rcfg,
      business:{
        name:r?.name||'', address:r?.address||'', phone:r?.phone||'',
        instagram:r?.instagram||'', website:r?.website||'', logoUrl:r?.logo_url||'',
        ruc:r?.ruc||'', legalName:r?.legal_name||'', email:r?.email||'',
        facebook:(rcfg.social&&rcfg.social.facebook)||'',
      },
    };
  }catch(e){window._restaurantName='Restaurante';}
  createRoot(document.getElementById('root')).render(
    <><CajaApp profile={profile}/><ToastContainer/></>
  );
}

async function bootstrap(){
  if(!db){window.location.replace('login.html?next=caja.html');return;}
  const{data:{session}}=await db.auth.getSession();
  if(session){await initApp(session);return;}
  /* Sin sesión persistida → login de inmediato */
  if(!HAS_TAB_SESSION){window.location.replace('login.html?next=caja.html');return;}
  /* Token vencido pero refresh token válido — esperamos el refresh automático */
  await new Promise(resolve=>{
    const{data:{subscription}}=db.auth.onAuthStateChange(async(event,s)=>{
      subscription.unsubscribe();
      if(s){await initApp(s);}else{window.location.replace('login.html?next=caja.html');}
      resolve();
    });
    setTimeout(()=>{subscription.unsubscribe();window.location.replace('login.html?next=caja.html');resolve();},3000);
  });
}
bootstrap();
