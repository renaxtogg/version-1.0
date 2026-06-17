// ════════════════════════════════════════════════════════════════════
// PR-5 — Panel caja precompilado con Vite (batch de migración legacy).
// Migrado 1:1 desde el <script type="text/babel"> inline de public/caja.html.
// Sin cambios de comportamiento ni de UI. React/createRoot vienen de npm
// (bundle Vite); el resto de globales del shell siguen en window.* (config.js,
// supabase UMD, MythosTheme/Icons/Presence/Session/Gating, XLSX, Leaflet, etc.).
// ════════════════════════════════════════════════════════════════════
import React from "react";
import { createRoot } from "react-dom/client";

// PR-5 (Bug A): mythos-gating.js es un script global legacy que usa React global
// (window.React). Tras bundlear React por panel con Vite ya no existe como global y
// useCapabilities() rompía con "React is not defined". Reexponemos la MISMA instancia de
// React (la del bundle) para el script global; NO se reintroduce React por CDN.
window.React = React;

const { useState, useEffect, useRef, useMemo, useCallback, useReducer } = React;

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
const RESTAURANT_ID = localStorage.getItem('mythos_restaurant_id');
let RID = RESTAURANT_ID; // alias retro-compatible; initApp lo reafirma con profile.restaurant_id

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
const EG_CATS        = ['Insumos','Propinas al staff','Servicio/Mantenimiento','Devolución a cliente','Otro'];
const ING_CATS       = ['Delivery externo','Evento privado','Venta de mercadería','Otro'];
const DELIVERY_PLATS = ['Rappi','PedidosYa','UberEats','Otro'];
const QUEJA_CATS     = ['Tiempo de espera','Calidad de la comida','Temperatura incorrecta','Error en el pedido','Trato del personal','Limpieza','Precio o cobro incorrecto','Otro'];
const CORTESIA_MOTIVOS = ['Error de cocina','Cliente VIP','Evento especial','Compensación por queja','Otro'];
const FONDO_MINIMO   = 50000; // ₲ 50.000 mínimo recomendado

/* ── PRINT TICKET ── */
// Escapa HTML al interpolar datos en el ticket (document.write) — evita XSS por
// nombres de producto/mesa manipulados.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function printTicket({orderNumber,mesa,items,total,metodo,cambio,isOffline}){
  const fecha=new Date().toLocaleString('es-PY',{dateStyle:'short',timeStyle:'short'});
  const metodos={efectivo:'Efectivo',tarjeta_credito:'Tarjeta Crédito',tarjeta_debito:'Tarjeta Débito',qr:'QR / Transferencia',mixto:'Mixto'};
  const restName=window._restaurantName||'Restaurante';
  const w=window.open('','_blank','width=340,height=720,menubar=no,toolbar=no,scrollbars=yes');
  if(!w){toast('Permití ventanas emergentes para imprimir',false);return;}
  const rows=(items||[]).map(it=>{
    const precio=(it.unit_price||it.price_guarani||0);
    const qty=it.quantity||1;
    return `<tr><td>${qty}× ${esc(it.item_name||it.name||'')}</td><td style="text-align:right;white-space:nowrap">${fmt(precio*qty)}</td></tr>`;
  }).join('');
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Ticket #${orderNumber}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Courier New',Courier,monospace;font-size:12px;width:72mm;margin:0 auto;padding:4mm;background:#fff;color:#000}
.c{text-align:center}.b{font-weight:bold}.big{font-size:15px;font-weight:bold}
hr{border:none;border-top:1px dashed #000;margin:5px 0}
table{width:100%}td{padding:1px 0;vertical-align:top}
.tot td{font-weight:bold;font-size:14px;border-top:1px solid #000;padding-top:3px;margin-top:2px}
.vuelto{font-size:13px;font-weight:bold;margin-top:3px}
@media print{body{width:72mm;margin:0;padding:2mm}}
</style></head><body>
<div class="c big">${esc(restName)}</div>
<div class="c" style="font-size:10px;margin:2px 0">${fecha}</div>
<hr>
<div class="c b">Pedido #${esc(orderNumber)}${isOffline?' <span style="font-size:10px">(LOCAL)</span>':''}</div>
<div class="c" style="font-size:10px">${esc(mesa)}</div>
<hr>
<table>${rows}<tr class="tot"><td>TOTAL</td><td style="text-align:right">${fmt(total)}</td></tr></table>
<hr>
<div>Método: ${metodos[metodo]||metodo}</div>
${cambio>0?`<div class="vuelto">Vuelto: ${fmt(cambio)}</div>`:''}
<hr>
<div class="c" style="font-size:10px;margin-top:4px">¡Gracias por su visita!</div>
<script>window.onload=function(){window.print();}<\/script>
</body></html>`);
  w.document.close();
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
        <div key={it.id} style={{background:it.ok?'#F0FAF3':'#FFF1F0',border:`1px solid ${it.ok?'#A3D9B1':'#FFB3AD'}`,color:it.ok?'#1A7E37':'#C0190F',padding:'10px 16px',fontSize:13,fontWeight:700,borderRadius:8,animation:'slideUp 200ms ease',minWidth:220,maxWidth:340}}>
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
function Inp({value,onChange,placeholder,type='text',mono,full=true,...rest}){return<input type={type} value={value} onChange={onChange} placeholder={placeholder} {...rest} style={{width:full?'100%':'auto',padding:'9px 11px',fontSize:14,fontFamily:mono?"'SF Mono',ui-monospace,monospace":'inherit',borderRadius:6,...(rest.style||{})}}/>;}
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
  const cfg={info:{bg:'rgba(59,130,246,0.08)',border:'rgba(59,130,246,0.25)',color:'#93c5fd'},warn:{bg:'rgba(251,191,36,0.08)',border:'rgba(251,191,36,0.25)',color:'#fde68a'},error:{bg:'rgba(239,68,68,0.08)',border:'rgba(239,68,68,0.25)',color:'#fca5a5'},success:{bg:'rgba(34,197,94,0.08)',border:'rgba(34,197,94,0.25)',color:'#86efac'}};
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
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
        {DENOMS.map(d=>(
          <div key={d.v} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:'10px 12px',display:'flex',alignItems:'center',gap:8}}>
            <div style={{flex:1}}>
              <div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:2}}>{d.t==='moneda'?'🪙':'💵'} {d.lbl}</div>
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
function AperturaTurnoScreen({profile,turnoAbierto,onTurnoAbierto}){
  const [denoms,setDenoms]=useState(emptyDenoms());
  const [obs,setObs]=useState('');
  const [busy,setBusy]=useState(false);
  const [cfg,setCfg]=useState({cash_mode_default:'libre',cash_fondo_fijo:0,cash_diff_umbral:50000});
  const [modo,setModo]=useState('libre');
  const [cfgLoaded,setCfgLoaded]=useState(false);

  useEffect(()=>{
    (async()=>{
      const{data}=await db.from('restaurants').select('cash_mode_default,cash_fondo_fijo,cash_diff_umbral').eq('id',RID).maybeSingle();
      if(data){
        const c={
          cash_mode_default:data.cash_mode_default||'libre',
          cash_fondo_fijo:Number(data.cash_fondo_fijo)||0,
          cash_diff_umbral:Number(data.cash_diff_umbral)||50000,
        };
        setCfg(c);
        setModo(c.cash_mode_default==='fijo'&&c.cash_fondo_fijo>0?'fijo':'libre');
      }
      setCfgLoaded(true);
    })();
  },[]);

  const total=calcDenomTotal(denoms);
  const fondoBajo=modo==='libre'&&total>0&&total<FONDO_MINIMO;
  const objetivo=modo==='fijo'?cfg.cash_fondo_fijo:0;
  const diffFijo=modo==='fijo'?total-objetivo:0;
  const umbral=cfg.cash_diff_umbral||50000;
  const matchOk=modo==='libre'||Math.abs(diffFijo)<=umbral;

  async function abrir(){
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
    }catch(e){toast('Error al abrir turno: '+e.message,false);}
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

        {turnoAbierto&&(
          <AlertBox type="error">
            ⚠ Hay un turno anterior abierto desde {fmtDT(turnoAbierto.fecha_apertura)} por <strong>{turnoAbierto.cajero_nombre||'otro cajero'}</strong>. Cerralo antes de abrir uno nuevo.
          </AlertBox>
        )}
        {fondoBajo&&(
          <AlertBox type="warn">
            ⚠ El fondo es menor al mínimo recomendado de {fmt(FONDO_MINIMO)}. Podés continuar igual.
          </AlertBox>
        )}

        {cfgLoaded&&cfg.cash_fondo_fijo>0&&(
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:'14px 18px',marginBottom:12,display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,flexWrap:'wrap'}}>
            <div>
              <div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:4}}>MODO DE APERTURA</div>
              <div style={{fontSize:12,color:C.dim}}>{modo==='fijo'?`Fondo fijo definido por admin: ${fmt(cfg.cash_fondo_fijo)}`:'Cajero define el fondo libremente'}</div>
            </div>
            <div style={{display:'flex',gap:6}}>
              {[['libre','Libre'],['fijo','Fondo fijo']].map(([v,lbl])=>(
                <button key={v} onClick={()=>setModo(v)}
                  disabled={v==='fijo'&&!(cfg.cash_fondo_fijo>0)}
                  style={{padding:'7px 14px',fontSize:12,borderRadius:6,border:`1px solid ${modo===v?'#000000':C.border}`,background:modo===v?'#000000':'transparent',color:modo===v?'#FFFFFF':C.mid,fontWeight:modo===v?700:500,cursor:v==='fijo'&&!(cfg.cash_fondo_fijo>0)?'not-allowed':'pointer',opacity:v==='fijo'&&!(cfg.cash_fondo_fijo>0)?0.4:1}}>{lbl}</button>
              ))}
            </div>
          </div>
        )}

        {modo==='fijo'&&(
          <div style={{background:matchOk?'rgba(52,199,89,0.06)':'rgba(255,149,0,0.08)',border:`1px solid ${matchOk?'rgba(52,199,89,0.25)':'rgba(255,149,0,0.3)'}`,borderRadius:10,padding:'12px 16px',marginBottom:12,display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,fontFamily:"'SF Mono',ui-monospace,monospace"}}>
            <div><div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:2}}>OBJETIVO</div><div style={{fontSize:16,fontWeight:800,color:C.ink}}>{fmt(objetivo)}</div></div>
            <div><div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:2}}>CONTADO</div><div style={{fontSize:16,fontWeight:800,color:C.ink}}>{fmt(total)}</div></div>
            <div><div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:2}}>DIFERENCIA</div><div style={{fontSize:16,fontWeight:800,color:Math.abs(diffFijo)===0?'#34C759':Math.abs(diffFijo)<=umbral?'#FF9500':'#FF3B30'}}>{diffFijo>=0?'+':''}{fmt(diffFijo)}</div></div>
          </div>
        )}

        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:24,marginBottom:16}}>
          <DenomGrid values={denoms} onChange={setDenoms} label={modo==='fijo'?`Confirmá el fondo fijo (${fmt(objetivo)}) ingresando billetes y monedas`:'Fondo inicial — ingresá la cantidad de cada denominación'}/>
          <div style={{marginTop:14}}>
            <Lbl>OBSERVACIONES {modo==='fijo'&&Math.abs(diffFijo)>0?'(requerido por diferencia)':'(opcional)'}</Lbl>
            <Textarea value={obs} onChange={e=>setObs(e.target.value)} placeholder="Ej: Fondo recibido de turno anterior, novedades…" rows={2}/>
          </div>
        </div>

        <div style={{display:'flex',gap:10}}>
          <Btn full onClick={abrir} disabled={busy||!!turnoAbierto||!cfgLoaded}>
            {busy?<><span className="spin"/> Abriendo…</>:'Abrir Turno →'}
          </Btn>
          <Btn variant="ghost" onClick={()=>window.location.href='admin.html'}>Admin</Btn>
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
  ['mythos_role','mythos_restaurant_id','mythos_user_id','mythos_display_name','mythos_last_activity','caja_panel','caja_cart']
    .forEach(k=>{try{localStorage.removeItem(k);}catch(_){}});
  window.location.replace('login.html');
}

function SidebarTurno({turno,movimientos,panel,setPanel,onCierre,profile,onToggleTheme,paymentCalls=0,onClickCalls,isOnline=true,pendingOffline=0,broadcastCount=0}){
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
    {id:'facturas', icon:'🧾', lbl:'Facturas del turno'},
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
          <div style={{fontSize:11,fontWeight:500,color:C.mid}}>Caja · {profile?.display_name||profile?.username}</div>
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
          <div style={{fontSize:11,fontWeight:700,color:'#FF3B30',marginBottom:2}}>⚡ MODO OFFLINE</div>
          <div style={{fontSize:10,color:C.dim}}>Menú desde caché local</div>
          {pendingOffline>0&&<div style={{fontSize:10,color:'#FF9500',marginTop:2,fontWeight:600}}>{pendingOffline} pedido{pendingOffline>1?'s':''} pendiente{pendingOffline>1?'s':''} de sync</div>}
        </div>
      )}

      <div style={{padding:'10px 8px',borderTop:`1px solid ${C.border}`}}>
        <button onClick={()=>window.location.href='admin.html'} style={{display:'flex',alignItems:'center',gap:8,width:'100%',padding:'7px 10px',borderRadius:6,border:'none',background:'transparent',color:C.mid,fontSize:11,cursor:'pointer'}}>
          ← Admin
        </button>
        <button
          onClick={cerrarSesion}
          title="Cerrar sesión"
          style={{marginTop:4,width:'100%',borderRadius:6,padding:'6px 10px',background:'rgba(239,68,68,0.07)',border:'1px solid rgba(239,68,68,0.2)',color:'#FF3B30',fontSize:12,cursor:'pointer',fontFamily:'inherit',fontWeight:600}}
        >
          ⏻ Cerrar sesión
        </button>
      </div>
    </aside>
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
  const [searchQ,setSearchQ]=useState('');
  const [deliveryInfoMap,setDeliveryInfoMap]=useState({});
  const [cancelTarget,setCancelTarget]=useState(null);

  useEffect(()=>{loadOrders();},[]);
  useEffect(()=>{
    if(!db)return;
    const ch=db.channel('cobros-rt')
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'orders',filter:`restaurant_id=eq.${RID}`},()=>loadOrders())
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'orders',filter:`restaurant_id=eq.${RID}`},(payload)=>{
        const o=payload.new;
        // Solo sacar de la lista si ya está cobrado o cancelado
        // NUNCA sacar por status='delivered' solo — delivery entregado != cobrado
        if(o.status==='cancelled'||o.payment_status==='paid'){
          setOrders(p=>p.filter(x=>x.id!==o.id));
        } else {
          setOrders(p=>p.some(x=>x.id===o.id)
            ?p.map(x=>x.id===o.id?{...x,status:o.status,payment_status:o.payment_status,payment_method:o.payment_method,total:o.total}:x)
            :p
          );
        }
      })
      .subscribe();
    const onVisible=()=>{if(document.visibilityState==='visible')loadOrders();};
    document.addEventListener('visibilitychange',onVisible);
    return()=>{db.removeChannel(ch);document.removeEventListener('visibilitychange',onVisible);};
  },[]);

  async function loadOrders(){
    setLoading(true);
    const{data,error}=await db.from('orders')
      .select('id,order_number,status,payment_status,total,payment_method,order_type,customer_name,customer_ruc,customer_email,requires_invoice,invoice_delivery_method,invoice_status,created_at,table_id,tables(number),order_items(id,quantity,unit_price)')
      .eq('restaurant_id',RID)
      .in('status',['confirmed','paid','pending_payment','kitchen_received','cooking','ready','delivered'])
      .or('payment_status.neq.paid,payment_status.is.null')
      .order('created_at',{ascending:true});
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

  const display=orders.filter(o=>{
    if(!searchQ)return true;
    const q=searchQ.toLowerCase();
    return (o.order_number||'').toLowerCase().includes(q)||(o.customer_name||'').toLowerCase().includes(q)||String(o.tables?.number||'').includes(q);
  });

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
      {!loading&&display.length===0&&(
        <div style={{textAlign:'center',padding:'60px 0',color:C.mid}}>
          <div style={{fontSize:36,marginBottom:12}}>✓</div>
          <div style={{fontSize:14,fontWeight:700,color:C.ink}}>No hay pedidos pendientes de cobro</div>
          <div style={{fontSize:12,color:C.mid,marginTop:6}}>Aparecen aquí pedidos de todos los canales: QR mesa, caja, delivery, para llevar</div>
        </div>
      )}
      {!loading&&display.length>0&&(
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(300px,1fr))',gap:12}}>
          {display.map(o=>{
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
                    {o.requires_invoice&&(o.invoice_status||'pending')==='pending'&&(
                      <div style={{display:'inline-block',marginTop:6,background:'#007AFF',color:'#fff',fontSize:10,fontWeight:800,padding:'3px 7px',borderRadius:8}}>
                        🧾 Factura solicitada{o.invoice_delivery_method==='email'?' — email':o.invoice_delivery_method==='print'?' — impresa':''}
                        {o.customer_email?` · ${o.customer_email}`:''}
                      </div>
                    )}
                    <div style={{fontSize:10,color:C.mid,marginTop:2}}>{origen}</div>
                  </div>
                  <Badge txt={SL[o.status]||o.status} color={SC[o.status]||'#6E6E73'}/>
                </div>
                {dInfo&&(
                  <div style={{background:'rgba(255,59,48,0.05)',border:'1px solid rgba(255,59,48,0.15)',borderRadius:7,padding:'7px 10px',marginBottom:8,fontSize:11}}>
                    {(dInfo.customer_name||o.customer_name)&&<div style={{fontWeight:700,color:C.ink,marginBottom:2}}>👤 {dInfo.customer_name||o.customer_name}</div>}
                    {dInfo.customer_phone&&<div style={{color:C.mid,marginBottom:1}}>📞 {dInfo.customer_phone}</div>}
                    {dInfo.delivery_address&&<div style={{color:C.mid,marginBottom:1}}>📍 {dInfo.delivery_address}</div>}
                    {dInfo.rider_name
                      ? <div style={{color:dInfo.rider_status==='delivered'?'#FF9500':'#34C759',fontWeight:700,marginTop:2}}>🛵 Rider: {dInfo.rider_name}{dInfo.rider_status==='on_way'?' — En camino':dInfo.rider_status==='confirmed'?' — Esperando retiro':dInfo.rider_status==='delivered'?' — Entregado, pdte. cobro':''}</div>
                      : <div style={{color:'#FF9500',fontWeight:600,marginTop:2}}>⏳ Sin rider asignado aún</div>
                    }
                  </div>
                )}
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div style={{fontSize:20,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.green}}>{fmt(displayTotal)}</div>
                  <div style={{fontSize:11,color:espera>30?C.red:espera>15?C.orange:'#6E6E73'}}>⏱ {espera}m</div>
                </div>
                {!yaCobrado?(
                  <div style={{marginTop:12,display:'flex',gap:6,alignItems:'stretch'}}>
                    <Btn small style={{flex:1}} variant={sinCobrar?'danger':listo?'success':'secondary'} onClick={e=>{e.stopPropagation();selectOrder(orderForModal);}}>
                      {listo?'✓ Cobrar':'⚠ Cobrar ahora'}
                    </Btn>
                    <button
                      onClick={e=>{e.stopPropagation();setCancelTarget(orderForModal);}}
                      title="Cancelar pedido"
                      style={{padding:'6px 12px',background:'transparent',color:C.red,border:`1px solid ${C.red}55`,borderRadius:6,fontSize:11,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap',letterSpacing:0.2}}>
                      ❌ Cancelar
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
      <span style={{fontSize:22,flexShrink:0}}>🏦</span>
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
    db.from('order_items').select('id,item_name,quantity,unit_price').eq('order_id',order.id)
      .then(({data})=>setItems(data||[]));
  },[order.id]);

  const montoNum=parseInt(montoPagado)||0;
  // Usar total de items si order.total es 0 (total se graba en DB recién al cobrar)
  const totalReal=React.useMemo(()=>{
    const fromOrder=Number(order.total)||0;
    if(fromOrder>0)return fromOrder;
    return items.reduce((s,i)=>s+Number(i.quantity||1)*Number(i.unit_price||0),0);
  },[order.total,items]);
  const cambio=metodo==='efectivo'?montoNum-totalReal:0;
  const mesa=order.tables?.number?`Mesa ${order.tables.number}`:order.customer_name||'Sin mesa';
  const BILLETES=[1000,2000,5000,10000,20000,50000,100000];

  async function confirmar(){
    if(metodo==='efectivo'&&montoNum<totalReal){
      toast('El monto recibido es menor al total',false);return;
    }
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
      const orderUpdate = order.status==='confirmed'
        ? {payment_status:'paid', status:'paid', total:totalReal, payment_method:metodo, ...invoiceFields}
        : cerrarOrden
          ? {payment_status:'paid', status:'delivered', completed_at:new Date().toISOString(), total:totalReal, payment_method:metodo, ...invoiceFields}
          : {payment_status:'paid', total:totalReal, payment_method:metodo, ...invoiceFields};
      let{error:e1}=await db.from('orders').update(orderUpdate).eq('id',order.id);
      // Fallback sin invoiceFields si la migración de requires_invoice no está aplicada
      if(e1){
        const fallbackUpdate = order.status==='confirmed'
          ? {payment_status:'paid', status:'paid', total:totalReal, payment_method:metodo}
          : cerrarOrden
            ? {payment_status:'paid', status:'delivered', completed_at:new Date().toISOString(), total:totalReal, payment_method:metodo}
            : {payment_status:'paid', total:totalReal, payment_method:metodo};
        const{error:e1b}=await db.from('orders').update(fallbackUpdate).eq('id',order.id);
        if(e1b)throw e1b;
      }
      // Registrar en historial solo si el pedido pasó a cocina por primera vez
      if(order.status==='confirmed'){
        await db.from('order_status_history').insert({order_id:order.id,status:'paid',notes:'Cobrado en caja — enviado a cocina'});
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
    return(
      <Modal title="Pedido cobrado" onClose={cerrarTrasExito} width={420}>
        <div style={{textAlign:'center',padding:'20px 0 8px'}}>
          <div style={{fontSize:48,marginBottom:8}}>✓</div>
          <div style={{fontSize:18,fontWeight:800,color:'#34C759',marginBottom:4}}>¡Cobrado!</div>
          <div style={{fontSize:13,color:C.mid,marginBottom:2}}>Pedido #{successTicket.orderNumber}</div>
          <div style={{fontSize:12,color:C.mid}}>{successTicket.mesa}</div>
        </div>
        <div style={{background:C.bg,borderRadius:10,padding:'12px 14px',marginTop:12,marginBottom:16}}>
          {successTicket.items.map((it,i)=>(
            <div key={i} style={{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:3}}>
              <span>{it.quantity}× {it.item_name}</span>
              <span style={{fontFamily:"'SF Mono',monospace",fontWeight:700}}>{fmt((it.unit_price||0)*it.quantity)}</span>
            </div>
          ))}
          <div style={{display:'flex',justifyContent:'space-between',fontSize:15,fontWeight:800,borderTop:'1px solid #D2D2D7',paddingTop:8,marginTop:6}}>
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
          <Btn full onClick={()=>printTicket(successTicket)} variant="secondary">🖨 Imprimir ticket</Btn>
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
          {(deliveryInfo.customer_name||order.customer_name)&&<div style={{fontWeight:700,color:C.ink,marginBottom:3}}>👤 {deliveryInfo.customer_name||order.customer_name}</div>}
          {deliveryInfo.customer_phone&&<div style={{color:C.mid,marginBottom:2}}>📞 {deliveryInfo.customer_phone}</div>}
          {deliveryInfo.delivery_address&&<div style={{color:C.mid,marginBottom:2}}>📍 {deliveryInfo.delivery_address}</div>}
          {deliveryInfo.rider_name
            ?<div style={{color:deliveryInfo.rider_status==='delivered'?'#FF9500':'#34C759',fontWeight:700,marginTop:3}}>🛵 Rider: {deliveryInfo.rider_name}{deliveryInfo.rider_status==='on_way'?' — En camino':deliveryInfo.rider_status==='confirmed'?' — Esperando retiro':deliveryInfo.rider_status==='delivered'?' — Entregado, pdte. cobro':''}</div>
            :<div style={{color:'#FF9500',fontWeight:600,marginTop:3}}>⏳ Sin rider asignado</div>
          }
          {cashAmountNum>0&&cashChangeNum>=0&&(
            <div style={{marginTop:6,paddingTop:6,borderTop:'1px solid rgba(255,59,48,0.15)'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <span style={{color:'#15803D',fontWeight:700}}>💵 Vuelto a llevar</span>
                <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:800,fontSize:15,color:'#16A34A'}}>{fmt(cashChangeNum)}</span>
              </div>
              <div style={{fontSize:10,color:C.mid,marginTop:1}}>Cliente paga {fmt(cashAmountNum)} · total {fmt(totalReal+deliveryFeeNum)}</div>
            </div>
          )}
        </div>
      )}

      {order.requires_invoice&&(order.invoice_status||'pending')==='pending'&&(
        <div style={{background:'rgba(0,122,255,0.08)',border:'1px solid rgba(0,122,255,0.3)',borderRadius:9,padding:'10px 13px',marginBottom:12,fontSize:12,color:'#0040A0'}}>
          🧾 <strong>Factura solicitada por el cliente</strong>
          {order.invoice_delivery_method==='email'?' — entregar por email':order.invoice_delivery_method==='print'?' — entregar impresa':''}
          {order.customer_email&&<div style={{fontSize:11,marginTop:2,color:'#0040A0'}}>Email: {order.customer_email}</div>}
          {order.customer_ruc&&<div style={{fontSize:11,marginTop:2,color:'#0040A0'}}>RUC: {order.customer_ruc}</div>}
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
                <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",color:'#000000',fontWeight:700}}>{fmt(it.unit_price*it.quantity)}</span>
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
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          {METODOS_PAGO.map(m=>(
            <button key={m.id} onClick={()=>setMetodo(m.id)} style={{
              padding:'10px',borderRadius:7,border:`1px solid ${metodo===m.id?'#000000':C.border}`,
              background:metodo===m.id?'#000000':'transparent',
              color:metodo===m.id?'#FFFFFF':C.mid,fontSize:12,fontWeight:metodo===m.id?700:400,cursor:'pointer',
            }}>{m.lbl}</button>
          ))}
        </div>
        {/* ── Pago digital — Próximamente ── */}
        <div style={{marginTop:10,paddingTop:10,borderTop:`1px dashed ${C.border}`}}>
          <div style={{fontSize:10,color:C.dim,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:6}}>Pago digital (próximamente)</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
            <button onClick={gate('caja:digital_payments',()=>setShowBancardToast(true))} style={{
              padding:'10px 6px',borderRadius:7,border:`1px solid rgba(255,149,0,0.35)`,
              background:'rgba(255,149,0,0.06)',color:'#B45309',fontSize:11,fontWeight:700,cursor:'pointer',
              display:'flex',alignItems:'center',justifyContent:'center',gap:5,
            }}>
              <span style={{fontSize:14}}>📲</span> QR Bancard
            </button>
            <button onClick={gate('caja:digital_payments',()=>setShowBancardToast(true))} style={{
              padding:'10px 6px',borderRadius:7,border:`1px solid rgba(255,149,0,0.35)`,
              background:'rgba(255,149,0,0.06)',color:'#B45309',fontSize:11,fontWeight:700,cursor:'pointer',
              display:'flex',alignItems:'center',justifyContent:'center',gap:5,
            }}>
              <span style={{fontSize:14}}>💳</span> Tarjeta (VPos)
            </button>
          </div>
        </div>
      </div>

      {metodo==='efectivo'&&(
        <div style={{marginBottom:16}}>
          {/* Billetes rápidos */}
          <Lbl>BILLETES RECIBIDOS</Lbl>
          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:5,marginBottom:8}}>
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
              <Inp type="number" mono value={montoPagado} onChange={e=>setMontoPagado(e.target.value)} placeholder={String(totalReal)}/>
            </div>
            <button onClick={()=>setMontoPagado('0')} title="Limpiar" style={{marginTop:18,padding:'9px 10px',borderRadius:6,border:`1px solid ${C.border}`,background:'transparent',color:C.dim,fontSize:13,cursor:'pointer'}}>✕</button>
          </div>
          {/* Vuelto */}
          {montoNum>0&&(
            cambio>=0?(
              <div style={{padding:'14px 16px',background:'rgba(34,197,94,0.08)',border:`1px solid rgba(34,197,94,0.3)`,borderRadius:8}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <span style={{fontSize:13,color:'#86efac',fontWeight:700}}>Vuelto a devolver</span>
                  <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:26,fontWeight:800,color:cambio>0?C.green:'#6E6E73'}}>{cambio>0?fmt(cambio):'Sin vuelto'}</span>
                </div>
                {cambio>0&&<div style={{fontSize:11,color:C.mid,marginTop:4}}>Recibido {fmt(montoNum)} − Total {fmt(totalReal)}</div>}
              </div>
            ):(
              <div style={{padding:'10px 14px',background:'rgba(239,68,68,0.08)',border:`1px solid rgba(239,68,68,0.3)`,borderRadius:7}}>
                <span style={{fontSize:13,color:C.red,fontWeight:700}}>⚠ Insuficiente — faltan {fmt(totalReal-montoNum)}</span>
              </div>
            )
          )}
        </div>
      )}

      {/* Toggle SIFEN */}
      <div onClick={gate('caja:sifen',()=>setInvoiceType(v=>v==='fiscal'?'none':'fiscal'))} style={{
        display:'flex',alignItems:'center',justifyContent:'space-between',
        padding:'11px 14px',marginBottom:12,borderRadius:9,cursor:'pointer',
        background:invoiceType==='fiscal'?'rgba(0,122,255,0.07)':'transparent',
        border:`1px solid ${invoiceType==='fiscal'?'rgba(0,122,255,0.3)':C.border}`,
        transition:'all .15s',
      }}>
        <div>
          <div style={{fontSize:12,fontWeight:700,color:invoiceType==='fiscal'?'#0040A0':C.ink}}>🧾 Emitir Factura Electrónica (SIFEN)</div>
          <div style={{fontSize:10,color:C.mid,marginTop:2}}>e-Kuatia · Certificación en proceso</div>
        </div>
        <div style={{width:42,height:24,borderRadius:12,background:invoiceType==='fiscal'?'#007AFF':'#D1D1D6',transition:'background .2s',position:'relative',flexShrink:0}}>
          <div style={{position:'absolute',top:2,left:invoiceType==='fiscal'?'18px':'2px',width:20,height:20,borderRadius:'50%',background:'#fff',transition:'left .2s',boxShadow:'0 1px 4px rgba(0,0,0,0.25)'}}/>
        </div>
      </div>

      {/* Comprobante */}
      <div style={{marginBottom:16}}>
        <Lbl>COMPROBANTE</Lbl>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6,marginBottom:invoiceType!=='none'?10:0}}>
          {[['none','Sin comprobante'],['ticket','Ticket impreso'],['fiscal','Factura fiscal']].map(([v,lbl])=>(
            <button key={v} onClick={v==='fiscal'?gate('caja:sifen',()=>setInvoiceType('fiscal')):()=>setInvoiceType(v)} style={{
              padding:'9px 4px',borderRadius:7,border:`1px solid ${invoiceType===v?C.ink:C.border}`,
              background:invoiceType===v?C.ink:'transparent',
              color:invoiceType===v?C.sidebar:C.mid,fontSize:11,fontWeight:700,cursor:'pointer',lineHeight:1.3,
            }}>{lbl}</button>
          ))}
        </div>
        {invoiceType==='ticket'&&(
          <div style={{padding:'8px 12px',background:'rgba(52,199,89,0.08)',border:'1px solid rgba(52,199,89,0.3)',borderRadius:7,fontSize:12,color:'#248A3D'}}>
            🖨 El ticket se imprimirá automáticamente al cobrar.
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

      {/* ── SIFEN / Factura electrónica — Próximamente ── */}
      <div style={{marginBottom:16,padding:'10px 12px',borderRadius:8,
        border:'1px dashed rgba(0,122,255,0.3)',background:'rgba(0,122,255,0.04)',
        display:'flex',alignItems:'center',justifyContent:'space-between',gap:10}}>
        <div>
          <div style={{fontSize:12,fontWeight:700,color:'#0040A0'}}>🧾 Factura Electrónica SIFEN</div>
          <div style={{fontSize:10,color:C.dim,marginTop:2}}>e-Kuatia — en proceso de certificación SET</div>
        </div>
        <button onClick={gate('caja:sifen',()=>setShowBancardToast(true))} style={{
          padding:'6px 12px',borderRadius:6,border:'1px solid rgba(0,122,255,0.4)',
          background:'rgba(0,122,255,0.08)',color:'#004AAD',fontSize:11,fontWeight:700,cursor:'pointer',flexShrink:0,
        }}>Activar</button>
      </div>

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
      <div style={{background:'#FFFFFF',border:'1px solid #000000',borderRadius:14,padding:28,width:'100%',maxWidth:420,boxShadow:'0 24px 60px rgba(0,0,0,0.45)',animation:'slideUp 200ms ease'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18}}>
          <div style={{fontFamily:'DM Serif Display',fontSize:20,color:'#000'}}>🔒 {title||'Autorización Requerida'}</div>
          <button onClick={()=>!busy&&onCancel()} disabled={busy} style={{background:'none',border:'none',color:'#000',fontSize:24,lineHeight:1,padding:0,cursor:busy?'default':'pointer',opacity:busy?0.4:1}} aria-label="Cerrar">×</button>
        </div>
        <div style={{fontSize:13,color:'#3A3A3C',lineHeight:1.5,marginBottom:18}}>
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
            style={{width:'100%',padding:'14px 16px',fontSize:26,fontWeight:800,letterSpacing:12,textAlign:'center',fontFamily:"'SF Mono',ui-monospace,monospace",background:'#F5F5F7',border:`1.5px solid ${error?'#000000':'#D2D2D7'}`,borderRadius:10,color:'#000',outline:'none'}}
          />
        </div>
        {error&&(
          <div style={{background:'#000000',color:'#FFFFFF',padding:'10px 14px',borderRadius:8,fontSize:12,fontWeight:600,marginBottom:14,textAlign:'center',letterSpacing:0.3}}>
            {error}
          </div>
        )}
        <div style={{display:'flex',gap:8}}>
          <button onClick={()=>!busy&&onCancel()} disabled={busy} style={{flex:1,padding:'12px 16px',background:'transparent',color:'#000',border:'1px solid #D2D2D7',borderRadius:8,fontSize:13,fontWeight:600,cursor:busy?'default':'pointer',opacity:busy?0.5:1}}>
            Cancelar
          </button>
          <button onClick={submit} disabled={busy||pin.length!==4} style={{flex:1.2,padding:'12px 16px',background:'#000',color:'#FFF',border:'1px solid #000',borderRadius:8,fontSize:13,fontWeight:700,cursor:(busy||pin.length!==4)?'default':'pointer',opacity:(busy||pin.length!==4)?0.55:1}}>
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
        <div style={{background:'#FFFFFF',border:'1px solid #000000',borderRadius:14,padding:24,width:'100%',maxWidth:440,boxShadow:'0 24px 60px rgba(0,0,0,0.45)',animation:'slideUp 200ms ease',color:'#000'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
            <div style={{fontFamily:'DM Serif Display',fontSize:18,color:'#000'}}>❌ Cancelar pedido</div>
            <button onClick={()=>!busy&&onClose()} disabled={busy} style={{background:'none',border:'none',color:'#000',fontSize:24,lineHeight:1,padding:0,cursor:busy?'default':'pointer',opacity:busy?0.4:1}} aria-label="Cerrar">×</button>
          </div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14,padding:'10px 14px',background:'#F5F5F7',border:'1px solid #D2D2D7',borderRadius:8}}>
            <div>
              <div style={{fontSize:14,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:'#000'}}>#{order.order_number}</div>
              <div style={{fontSize:12,color:'#3A3A3C',marginTop:2,fontWeight:600}}>{mesa}</div>
            </div>
            <div style={{fontSize:16,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:'#C0190F'}}>{fmt(Number(order.total)||0)}</div>
          </div>
          {requierePin&&(
            <div style={{background:'#000000',color:'#FFFFFF',padding:'10px 14px',borderRadius:8,fontSize:12,fontWeight:600,marginBottom:14,letterSpacing:0.2}}>
              🔒 Esta acción requerirá el PIN de un Administrador o Gerente al continuar.
            </div>
          )}
          <div style={{marginBottom:12}}>
            <div style={{fontSize:10,color:'#6E6E73',fontWeight:700,letterSpacing:1,marginBottom:6}}>MOTIVO DE LA CANCELACIÓN <span style={{color:'#C0190F'}}>*</span></div>
            <select value={motivo} onChange={e=>setMotivo(e.target.value)} disabled={busy} style={{width:'100%',padding:'10px 12px',fontSize:14,background:'#FFFFFF',border:'1.5px solid #D2D2D7',borderRadius:8,color:'#000',outline:'none'}}>
              <option value="">Seleccionar…</option>
              {MOTIVOS_CANCEL.map(m=><option key={m}>{m}</option>)}
            </select>
          </div>
          {motivo&&(
            <div style={{marginBottom:14}}>
              <div style={{fontSize:10,color:'#6E6E73',fontWeight:700,letterSpacing:1,marginBottom:6}}>DETALLE {motivo==='Otro'?<span style={{color:'#C0190F'}}>*</span>:'(opcional)'}</div>
              <textarea value={descripcion} onChange={e=>setDescripcion(e.target.value)} disabled={busy} placeholder="Notas adicionales para auditoría…" rows={2} style={{width:'100%',padding:'10px 12px',fontSize:13,background:'#FFFFFF',border:'1.5px solid #D2D2D7',borderRadius:8,color:'#000',outline:'none',resize:'vertical',fontFamily:'inherit'}}/>
            </div>
          )}
          <div style={{marginBottom:18,display:'flex',alignItems:'center',gap:8}}>
            <input type="checkbox" id="qc-perdida" checked={perdida} onChange={e=>setPerdida(e.target.checked)} disabled={busy} style={{width:14,height:14}}/>
            <label htmlFor="qc-perdida" style={{fontSize:12,color:'#3A3A3C',cursor:'pointer'}}>Generó pérdida de insumos</label>
          </div>
          <div style={{display:'flex',gap:8}}>
            <button onClick={()=>!busy&&onClose()} disabled={busy} style={{flex:1,padding:'12px 16px',background:'transparent',color:'#000',border:'1px solid #D2D2D7',borderRadius:8,fontSize:13,fontWeight:600,cursor:busy?'default':'pointer',opacity:busy?0.5:1}}>
              Volver
            </button>
            <button onClick={intentarCancelar} disabled={busy||!motivo} style={{flex:1.4,padding:'12px 16px',background:'#000',color:'#FFF',border:'1px solid #000',borderRadius:8,fontSize:13,fontWeight:700,cursor:(busy||!motivo)?'default':'pointer',opacity:(busy||!motivo)?0.55:1}}>
              {busy?'Cancelando…':requierePin?'Continuar 🔒':'Continuar'}
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
                  style={{background:selected?.id===o.id?'#EBEBEB':C.surface,border:`2px solid ${selected?.id===o.id?'#000000':C.border}`,borderRadius:8,padding:'12px 14px',cursor:'pointer',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div>
                    <div style={{fontSize:14,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.ink}}>#{o.order_number}</div>
                    <div style={{fontSize:12,color:C.ink,marginTop:2,fontWeight:600}}>{mesa}</div>
                  </div>
                  <div style={{display:'flex',alignItems:'center',gap:10}}>
                    <Badge txt={SL[o.status]} color={SC[o.status]||'#6E6E73'}/>
                    {enCocina&&<Badge txt="⚠ En cocina" color={C.orange}/>}
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
              <div style={{marginBottom:14,padding:'10px 14px',background:'#F0F0F0',borderRadius:7,border:`1px solid ${C.border}`}}>
                <div style={{fontSize:14,fontWeight:800,color:C.ink}}>#{selected.order_number}</div>
                <div style={{fontSize:13,color:C.ink,marginTop:2,fontWeight:600}}>{fmt(selected.total)}</div>
              </div>
              {requierePin&&(
                <AlertBox type="info">🔒 Esta acción requerirá el PIN de un Administrador o Gerente al confirmar.</AlertBox>
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
                {busy?<><span className="spin"/> Cancelando…</>:requierePin?'Confirmar cancelación 🔒':'Confirmar cancelación'}
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
              <button key={id} onClick={()=>setTipo(id)} style={{padding:'8px 14px',fontSize:12,fontWeight:tipo===id?700:400,color:tipo===id?C.ink:'#86868B',background:'none',border:'none',borderBottom:tipo===id?'2px solid #000':'2px solid transparent',cursor:'pointer',marginBottom:-1}}>{lbl}</button>
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
            <Inp type="number" mono value={form.monto} onChange={e=>setForm({...form,monto:e.target.value})} placeholder="0"/>
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
      if(form.urgencia==='alta'&&form.tipo==='queja')toast('⚠ Urgencia alta — notificar al supervisor',false);
      setShowForm(false);
      setForm({tipo:'queja',categoria:'',urgencia:'media',descripcion:'',compensacion:false,comp_tipo:'',comp_monto:''});
      loadQuejas();
    }catch(e){toast('Error: '+e.message,false);}
    setBusy(false);
  }

  const urgColor={alta:C.red,media:C.yellow,baja:C.green};
  const tipoColor={queja:C.red,sugerencia:C.blue,comentario_positivo:C.green};
  const tipoIcon={queja:'⚠',sugerencia:'💡',comentario_positivo:'✓'};

  return(
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
        <h1 style={{fontSize:20,fontWeight:800}}>Quejas y Sugerencias</h1>
        <Btn small onClick={()=>setShowForm(!showForm)}>+ Nueva queja / sugerencia</Btn>
      </div>

      {showForm&&(
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:20,marginBottom:16,animation:'fadeIn .15s ease'}}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:12}}>
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
                  <option value="alta">Alta ⚠</option>
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
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                  <div>
                    <Lbl>TIPO COMPENSACIÓN</Lbl>
                    <Sel value={form.comp_tipo} onChange={e=>setForm({...form,comp_tipo:e.target.value})}>
                      <option value="">Seleccionar…</option>
                      {['Descuento','Cortesía','Voucher','Reembolso'].map(t=><option key={t}>{t}</option>)}
                    </Sel>
                  </div>
                  <div>
                    <Lbl>MONTO (₲)</Lbl>
                    <Inp type="number" mono value={form.comp_monto} onChange={e=>setForm({...form,comp_monto:e.target.value})} placeholder="0"/>
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
                <Badge txt={`${tipoIcon[q.tipo]} ${q.tipo.replace('_',' ')}`} color={tipoColor[q.tipo]||'#6E6E73'}/>
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
                    {m.motivo&&<div style={{fontSize:11,color:C.mid,marginTop:1}}>📝 {m.motivo}</div>}
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
            <Inp type="number" mono value={form.monto} onChange={e=>setForm({...form,monto:e.target.value})} placeholder="0"/>
            {excede&&(
              <div style={{fontSize:11,color:C.red,marginTop:4}}>⚠ Supera el efectivo disponible ({fmt(saldoEfectivo)})</div>
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
function PagarAntesDeEnviarModal({cart,orderType,tableId,customerName,tables,turno,profile,onClose,onConfirmed}){
  const [metodo,setMetodo]=useState('efectivo');
  const [montoPagado,setMontoPagado]=useState('0');
  const [busy,setBusy]=useState(false);
  const [successTicket,setSuccessTicket]=useState(null);
  const [invoiceType,setInvoiceType]=useState('none'); // 'none'|'ticket'|'fiscal'
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
  const montoNum=parseInt(montoPagado)||0;
  const cambio=metodo==='efectivo'?montoNum-subtotal:0;
  const BILLETES=[1000,2000,5000,10000,20000,50000,100000];
  const mesa=tableId&&tableId!=='sin_mesa'?tables.find(t=>t.id===tableId):null;
  const origen=orderType==='dine_in'?(tableId==='sin_mesa'?'Sin número de mesa':`Mesa ${mesa?.number||'?'}`):orderType==='delivery'?'Delivery':'Para llevar';

  async function confirmar(){
    if(metodo==='efectivo'&&montoNum<subtotal){toast('El monto recibido es menor al total',false);return;}
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
        subtotal,discount_amount:0,total:subtotal,
        payment_method:metodo,
      };
      let{data:order,error:e1}=await db.from('orders').insert({...baseInsert,...invoiceFields}).select().single();
      if(e1){
        // Fallback si la migración de invoice no está aplicada
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
      await db.from('order_status_history').insert({order_id:order.id,status:'paid',notes:'Pedido tomado y cobrado en caja'});

      /* 5. movimiento_caja */
      const mov={
        turno_id:turno.id,restaurant_id:RID,tipo:'cobro',
        monto:subtotal,metodo_pago:metodo,pedido_id:order.id,
        descripcion:`Cobro pedido #${orderNum} — ${origen}`,
        usuario_id:profile.id,usuario_nombre:profile.display_name||profile.username,
        metadata:{orden_numero:orderNum,mesa:origen,monto_pagado:montoNum||subtotal,cambio:Math.max(0,cambio),transaction_id:null,auth_code:null,raw_response:null},
      };
      const{data:movData,error:e4}=await db.from('movimientos_caja').insert(mov).select().single();
      if(e4)throw e4;

      movDataRef.current=movData;
      orderRef.current=order;
      const ticket={
        orderNumber:order.order_number,
        mesa:origen,
        items:cart.map(c=>({item_name:c.item.name,quantity:c.quantity,unit_price:c.linePrice})),
        total:subtotal,
        metodo,
        cambio:Math.max(0,cambio),
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
    return(
      <Modal title="Pedido cobrado" onClose={cerrarTrasExito} width={420}>
        <div style={{textAlign:'center',padding:'20px 0 8px'}}>
          <div style={{fontSize:48,marginBottom:8}}>✓</div>
          <div style={{fontSize:18,fontWeight:800,color:'#34C759',marginBottom:4}}>¡Cobrado!</div>
          <div style={{fontSize:13,color:C.mid,marginBottom:2}}>Pedido #{successTicket.orderNumber}</div>
          <div style={{fontSize:12,color:C.mid}}>{successTicket.mesa}</div>
        </div>
        <div style={{background:C.bg,borderRadius:10,padding:'12px 14px',marginTop:12,marginBottom:16}}>
          {successTicket.items.map((it,i)=>(
            <div key={i} style={{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:3}}>
              <span>{it.quantity}× {it.item_name}</span>
              <span style={{fontFamily:"'SF Mono',monospace",fontWeight:700}}>{fmt(it.unit_price*it.quantity)}</span>
            </div>
          ))}
          <div style={{display:'flex',justifyContent:'space-between',fontSize:15,fontWeight:800,borderTop:'1px solid #D2D2D7',paddingTop:8,marginTop:6}}>
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
          <Btn full onClick={()=>printTicket(successTicket)} variant="secondary">🖨 Imprimir ticket</Btn>
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
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',borderTop:'1px solid #D2D2D7',paddingTop:10}}>
            <span style={{fontSize:14,fontWeight:800,color:C.ink}}>TOTAL A COBRAR</span>
            <span style={{fontSize:26,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.green}}>{fmt(subtotal)}</span>
          </div>
        </div>

        <div style={{marginBottom:14}}>
          <Lbl required>MÉTODO DE PAGO</Lbl>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
            {METODOS_PAGO.map(m=>(
              <button key={m.id} onClick={()=>setMetodo(m.id)} style={{
                padding:'10px',borderRadius:7,border:`1px solid ${metodo===m.id?'#000000':C.border}`,
                background:metodo===m.id?'#000000':'transparent',
                color:metodo===m.id?'#FFFFFF':'#6E6E73',fontSize:12,fontWeight:metodo===m.id?700:400,cursor:'pointer',
              }}>{m.lbl}</button>
            ))}
          </div>
          {/* ── Pago digital — Próximamente ── */}
          <div style={{marginTop:10,paddingTop:10,borderTop:`1px dashed ${C.border}`}}>
            <div style={{fontSize:10,color:C.dim,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:8}}>Pago digital (próximamente)</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              <button onClick={gate('caja:digital_payments',()=>setShowBancardToast(true))} style={{
                padding:'10px 6px',borderRadius:7,border:'1px solid rgba(255,149,0,0.35)',
                background:'rgba(255,149,0,0.06)',color:'#B45309',fontSize:11,fontWeight:700,cursor:'pointer',
                display:'flex',alignItems:'center',justifyContent:'center',gap:5,
              }}>
                <span style={{fontSize:14}}>📲</span> QR Bancard
              </button>
              <button onClick={gate('caja:digital_payments',()=>setShowBancardToast(true))} style={{
                padding:'10px 6px',borderRadius:7,border:'1px solid rgba(255,149,0,0.35)',
                background:'rgba(255,149,0,0.06)',color:'#B45309',fontSize:11,fontWeight:700,cursor:'pointer',
                display:'flex',alignItems:'center',justifyContent:'center',gap:5,
              }}>
                <span style={{fontSize:14}}>💳</span> Tarjeta (VPos Bancard)
              </button>
            </div>
          </div>
        </div>

        {metodo==='efectivo'&&(
          <div style={{marginBottom:14}}>
            <Lbl>BILLETES RECIBIDOS</Lbl>
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:5,marginBottom:8}}>
              {BILLETES.map(v=>(
                <button key={v} onClick={()=>setMontoPagado(String(montoNum+v))} style={{
                  padding:'9px 4px',borderRadius:6,border:`1px solid ${C.border}`,
                  background:C.bg,color:C.ink,fontSize:12,fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:700,cursor:'pointer',
                }}>{v>=1000?`${v/1000}k`:v}</button>
              ))}
              <button onClick={()=>setMontoPagado(String(subtotal))} style={{
                padding:'9px 4px',borderRadius:6,border:`1px solid ${C.blue}55`,
                background:'rgba(59,130,246,0.1)',color:C.blue,fontSize:11,fontWeight:700,cursor:'pointer',
              }}>Exacto</button>
            </div>
            <Lbl required>MONTO RECIBIDO (₲)</Lbl>
            <Inp type="number" mono value={montoPagado} onChange={e=>setMontoPagado(e.target.value)} placeholder={String(subtotal)}/>
            {montoNum>0&&(
              cambio>=0?(
                <div style={{marginTop:8,padding:'12px 14px',background:'rgba(34,197,94,0.1)',border:'1px solid rgba(34,197,94,0.3)',borderRadius:8,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <span style={{fontSize:13,color:'#1A7E37',fontWeight:700}}>Vuelto a entregar</span>
                  <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:24,fontWeight:800,color:cambio>0?C.green:'#6E6E73'}}>{cambio>0?fmt(cambio):'Sin vuelto'}</span>
                </div>
              ):(
                <div style={{marginTop:8,padding:'10px 12px',background:'rgba(255,59,48,0.08)',border:'1px solid rgba(255,59,48,0.3)',borderRadius:7}}>
                  <span style={{fontSize:13,color:C.red,fontWeight:700}}>⚠ Faltan {fmt(subtotal-montoNum)}</span>
                </div>
              )
            )}
          </div>
        )}
      </div>

      {/* Toggle SIFEN */}
      <div onClick={gate('caja:sifen',()=>setInvoiceType(v=>v==='fiscal'?'none':'fiscal'))} style={{
        display:'flex',alignItems:'center',justifyContent:'space-between',
        padding:'11px 14px',marginBottom:12,borderRadius:9,cursor:'pointer',
        background:invoiceType==='fiscal'?'rgba(0,122,255,0.07)':'transparent',
        border:`1px solid ${invoiceType==='fiscal'?'rgba(0,122,255,0.3)':C.border}`,
        transition:'all .15s',
      }}>
        <div>
          <div style={{fontSize:12,fontWeight:700,color:invoiceType==='fiscal'?'#0040A0':C.ink}}>🧾 Emitir Factura Electrónica (SIFEN)</div>
          <div style={{fontSize:10,color:C.mid,marginTop:2}}>e-Kuatia · Certificación en proceso</div>
        </div>
        <div style={{width:42,height:24,borderRadius:12,background:invoiceType==='fiscal'?'#007AFF':'#D1D1D6',transition:'background .2s',position:'relative',flexShrink:0}}>
          <div style={{position:'absolute',top:2,left:invoiceType==='fiscal'?'18px':'2px',width:20,height:20,borderRadius:'50%',background:'#fff',transition:'left .2s',boxShadow:'0 1px 4px rgba(0,0,0,0.25)'}}/>
        </div>
      </div>

      {/* Comprobante */}
      <div style={{marginBottom:16}}>
        <Lbl>COMPROBANTE</Lbl>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6,marginBottom:invoiceType!=='none'?10:0}}>
          {[['none','Sin comprobante'],['ticket','Ticket impreso'],['fiscal','Factura fiscal']].map(([v,lbl])=>(
            <button key={v} onClick={v==='fiscal'?gate('caja:sifen',()=>setInvoiceType('fiscal')):()=>setInvoiceType(v)} style={{
              padding:'9px 4px',borderRadius:7,border:`1px solid ${invoiceType===v?C.ink:C.border}`,
              background:invoiceType===v?C.ink:'transparent',
              color:invoiceType===v?C.sidebar:C.mid,fontSize:11,fontWeight:700,cursor:'pointer',lineHeight:1.3,
            }}>{lbl}</button>
          ))}
        </div>
        {invoiceType==='ticket'&&(
          <div style={{padding:'8px 12px',background:'rgba(52,199,89,0.08)',border:'1px solid rgba(52,199,89,0.3)',borderRadius:7,fontSize:12,color:'#248A3D'}}>
            🖨 El ticket se imprimirá automáticamente al cobrar.
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
          {busy?<><span className="spin"/> Procesando…</>:'✓ Cobrar y enviar a cocina'}
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
  const [cart,setCart]=useState(()=>{try{return JSON.parse(localStorage.getItem('caja_cart')||'[]');}catch{return [];}});
  const [orderType,setOrderType]=useState(()=>localStorage.getItem('caja_order_type')||'dine_in');
  const [tableId,setTableId]=useState(()=>localStorage.getItem('caja_table_id')||'');
  const [customerName,setCustomerName]=useState(()=>localStorage.getItem('caja_customer_name')||'');
  const [extrasModal,setExtrasModal]=useState(null);
  const [pagoModal,setPagoModal]=useState(false);
  const [busy,setBusy]=useState(false);

  useEffect(()=>{load();},[]);
  useEffect(()=>{localStorage.setItem('caja_cart',JSON.stringify(cart));},[cart]);
  useEffect(()=>{localStorage.setItem('caja_order_type',orderType);},[orderType]);
  useEffect(()=>{localStorage.setItem('caja_table_id',tableId);},[tableId]);
  useEffect(()=>{localStorage.setItem('caja_customer_name',customerName);},[customerName]);

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
    setPagoModal(true);
  }

  function onPagoConfirmado(movData,order){
    setPagoModal(false);
    if(movData&&onMovimiento)onMovimiento(movData);
    toast(`Pedido #${order?.order_number||''} cobrado y enviado a cocina ✓`);
    setCart([]);setCustomerName('');setTableId('');
    localStorage.removeItem('caja_cart');localStorage.removeItem('caja_customer_name');localStorage.removeItem('caja_table_id');
  }

  /* ── render ── */
  const TYPE_BTNS=[['dine_in','🪑 Salón'],['takeaway','🥡 Para llevar'],['delivery','🛵 Delivery']];

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
              border:`1px solid ${orderType===t?'#000000':C.border}`,
              background:orderType===t?'#000000':'transparent',
              color:orderType===t?'#FFFFFF':C.mid,
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
                  border:`1px solid ${selCat===c.id?'#000000':C.border}`,
                  background:selCat===c.id?'#000000':'transparent',
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
                          : <div className="ds-product-card-placeholder">🍽️</div>
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
              ):(
                <>
                  <Lbl>{orderType==='delivery'?'CLIENTE / DIRECCIÓN':'NOMBRE DEL CLIENTE'}</Lbl>
                  <Inp value={customerName} onChange={e=>setCustomerName(e.target.value)} placeholder={orderType==='delivery'?'Nombre y dirección…':'Nombre…'}/>
                </>
              )}
            </div>

            {/* Ítems */}
            <div style={{flex:1,overflowY:'auto',padding:'10px 14px'}}>
              {cart.length===0?(
                <div style={{textAlign:'center',padding:'28px 0',color:C.mid}}>
                  <div style={{fontSize:30,marginBottom:8}}>🛒</div>
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
                          {c.observations&&<div style={{fontSize:10,color:C.yellow,marginTop:2}}>📝 {c.observations}</div>}
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
                  {'💳 Cobrar y enviar →'}
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
        <span style={{fontSize:11,color:C.dim}}>⏱ {espera}m</span>
      </div>

      {/* Info delivery */}
      {isDelivery&&dInfo&&(
        <div style={{background:'rgba(255,59,48,0.05)',border:'1px solid rgba(255,59,48,0.18)',borderRadius:9,padding:'10px 13px',marginBottom:14,fontSize:12}}>
          {(dInfo.customer_name||order.customer_name)&&<div style={{fontWeight:700,color:C.ink,marginBottom:3}}>👤 {dInfo.customer_name||order.customer_name}</div>}
          {dInfo.customer_phone&&<div style={{color:C.mid,marginBottom:2}}>📞 {dInfo.customer_phone}</div>}
          {dInfo.delivery_address&&<div style={{color:C.mid,marginBottom:2}}>📍 {dInfo.delivery_address}</div>}
          {dInfo.rider_name
            ?<div style={{color:dInfo.rider_status==='delivered'?'#FF9500':'#34C759',fontWeight:700,marginTop:3}}>🛵 Rider: {dInfo.rider_name}{dInfo.rider_status==='on_way'?' — En camino':dInfo.rider_status==='confirmed'?' — Esperando retiro':dInfo.rider_status==='delivered'?' — Entregado, pdte. cobro':''}</div>
            :<div style={{color:'#FF9500',fontWeight:600,marginTop:3}}>⏳ Sin rider asignado</div>
          }
          {cashAmt>0&&cashChg>=0&&(
            <div style={{marginTop:6,paddingTop:6,borderTop:'1px solid rgba(255,59,48,0.15)'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <span style={{color:'#15803D',fontWeight:700}}>💵 Vuelto a llevar</span>
                <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:800,fontSize:14,color:'#16A34A'}}>{fmt(cashChg)}</span>
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
              <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",color:'#777'}}>{fmt(it.unit_price*it.quantity)}</span>
            </div>
            {it.observations&&<div style={{fontSize:11,color:C.yellow,marginLeft:12}}>📝 {it.observations}</div>}
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
  {value:'salon',    label:'Salón',    bg:'#F0F7FF',border:'#BFDBFE',dot:'#3B82F6'},
  {value:'terraza',  label:'Terraza',  bg:'#F0FFF4',border:'#BBF7D0',dot:'#22C55E'},
  {value:'bar',      label:'Bar',      bg:'#FFF7ED',border:'#FED7AA',dot:'#F97316'},
  {value:'privado',  label:'Privado',  bg:'#FDF4FF',border:'#E9D5FF',dot:'#A855F7'},
  {value:'exterior', label:'Exterior', bg:'#FEFCE8',border:'#FEF08A',dot:'#EAB308'},
];
const SHAPES_DEF_C=[{value:'square',label:'Cuadrada',icon:'⬜'},{value:'round',label:'Redonda',icon:'⭕'},{value:'rectangle',label:'Rectangular',icon:'▬'}];
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

function ZonaCaja({zona,tables,ordersByTable,sessionTotals,reservationByTable,editMode,dragging,dragOff,setDragging,setDragOff,setTables,onTableClick,onEditTable}){
  const canvasRef=React.useRef(null);
  const zd=ZONAS_DEF_C.find(z=>z.value===zona)||ZONAS_DEF_C[0];
  const [canvasW,setCanvasW]=React.useState(0);
  React.useEffect(()=>{
    if(!canvasRef.current)return;
    const update=()=>{if(canvasRef.current)setCanvasW(canvasRef.current.offsetWidth);};
    update();
    const ro=new ResizeObserver(update);
    ro.observe(canvasRef.current);
    return()=>ro.disconnect();
  },[]);
  const canvasH=Math.max(Math.round(canvasW*CANVAS_ASPECT_C),160);
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
    const{w,h}=tdC(t.shape||'square');
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
  const ACTIVE_STATUSES=['paid','pending_payment','kitchen_received','cooking','ready'];
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
  return(
    <div style={{marginBottom:16}}>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}>
        <div style={{width:8,height:8,borderRadius:'50%',background:zd.dot}}/>
        <div style={{fontSize:12,fontWeight:700,color:'#3D3D3D',textTransform:'uppercase',letterSpacing:'0.5px'}}>{zd.label}</div>
        <div style={{fontSize:11,color:C.dim}}>· {tables.length} {tables.length===1?'mesa':'mesas'}</div>
      </div>
      <div ref={canvasRef} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        style={{position:'relative',width:'100%',height:canvasH,background:zd.bg,border:`1.5px solid ${zd.border}`,borderRadius:10,overflow:'hidden',touchAction:editMode?'none':'auto'}}>
        {tables.length===0&&<div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',color:'#C0C0C0',fontSize:12}}>Sin mesas en {zd.label.toLowerCase()}</div>}
        {canvasW>0 && tables.map((t,idx)=>{
          const shape=t.shape||'square';
          const{w,h}=tdC(shape);
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
              {sesTotal>0&&<div style={{fontSize:8,color:sc.tx==='#FFFFFF'?'rgba(255,255,255,0.85)':'#22C55E',fontWeight:700,lineHeight:1,marginBottom:2,fontFamily:"'SF Mono',ui-monospace,monospace"}}>{fmt(sesTotal)}</div>}
              <div style={{fontSize:shape==='rectangle'?13:16,fontWeight:800,color:sc.tx,lineHeight:1}}>{t.number}</div>
              {status==='libre'
                ?<div style={{fontSize:8,color:C.dim,marginTop:2,fontWeight:500}}>Libre</div>
                :<div style={{fontSize:8,color:sc.tx,marginTop:2,fontWeight:status==='alerta_reserva'?800:500}}>
                  {status==='cocina'?'Cocina':status==='lista'?'Lista':status==='cobro'?'A cobrar':status==='reservada'?'Reservada':status==='alerta_reserva'?'¡Liberar!':'Ocupada'}
                </div>
              }
              {(status==='reservada'||status==='alerta_reserva')&&(reservationByTable&&reservationByTable[t.id])
                ?<div style={{fontSize:8,color:sc.tx,marginTop:1,fontWeight:700}}>{reservationByTable[t.id].reservation.reservation_time?.slice(0,5)} · {reservationByTable[t.id].reservation.guests}p</div>
                :<div style={{fontSize:8,color:sc.tx==='#FFFFFF'?'rgba(255,255,255,0.5)':'#86868B',marginTop:2}}>{t.capacity||4} pax</div>
              }
              {editMode&&<div style={{position:'absolute',top:3,right:5,fontSize:9,color:C.dim}}>✎</div>}
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
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
          <div><Lbl>NÚMERO *</Lbl><Inp type="number" value={form.number} onChange={e=>setForm(f=>({...f,number:e.target.value}))} placeholder="1"/></div>
          <div><Lbl>LUGARES (pax)</Lbl><Inp type="number" value={form.capacity} onChange={e=>setForm(f=>({...f,capacity:e.target.value}))} placeholder="4"/></div>
        </div>
        <div>
          <Lbl>ZONA / SECTOR</Lbl>
          <div style={{display:'flex',gap:6,flexWrap:'wrap',marginTop:4}}>
            {ZONAS_DEF_C.map(z=>(
              <button key={z.value} type="button" onClick={()=>setForm(prev=>({...prev,zona:z.value}))}
                style={{padding:'5px 12px',borderRadius:20,border:`1.5px solid ${form.zona===z.value?'#000':'#D2D2D7'}`,background:form.zona===z.value?'#000':'transparent',color:form.zona===z.value?'#fff':'#3D3D3D',fontSize:12,cursor:'pointer',fontWeight:form.zona===z.value?700:400}}>
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
                style={{flex:1,padding:'10px 6px',borderRadius:8,border:`2px solid ${form.shape===s.value?'#000':'#D2D2D7'}`,background:form.shape===s.value?'#000':'transparent',color:form.shape===s.value?'#fff':'#3D3D3D',fontSize:11,cursor:'pointer',fontWeight:600,textAlign:'center',display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
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
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
          <div><Lbl>NÚMERO *</Lbl><Inp type="number" value={form.number} onChange={e=>setForm(f=>({...f,number:e.target.value}))} placeholder="1"/></div>
          <div><Lbl>LUGARES (pax)</Lbl><Inp type="number" value={form.capacity} onChange={e=>setForm(f=>({...f,capacity:e.target.value}))} placeholder="4"/></div>
        </div>
        <div>
          <Lbl>ZONA / SECTOR</Lbl>
          <div style={{display:'flex',gap:6,flexWrap:'wrap',marginTop:4}}>
            {ZONAS_DEF_C.map(z=>(
              <button key={z.value} type="button" onClick={()=>setForm(prev=>({...prev,zona:z.value}))}
                style={{padding:'5px 12px',borderRadius:20,border:`1.5px solid ${form.zona===z.value?'#000':'#D2D2D7'}`,background:form.zona===z.value?'#000':'transparent',color:form.zona===z.value?'#fff':'#3D3D3D',fontSize:12,cursor:'pointer',fontWeight:form.zona===z.value?700:400}}>
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
                style={{flex:1,padding:'10px 6px',borderRadius:8,border:`2px solid ${form.shape===s.value?'#000':'#D2D2D7'}`,background:form.shape===s.value?'#000':'transparent',color:form.shape===s.value?'#fff':'#3D3D3D',fontSize:11,cursor:'pointer',fontWeight:600,textAlign:'center',display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
                <span style={{fontSize:18,pointerEvents:'none'}}>{s.icon}</span><span style={{pointerEvents:'none'}}>{s.label}</span>
              </button>
            ))}
          </div>
        </div>
        {table.zona!==form.zona&&(
          <div style={{fontSize:11,color:C.dim,background:'#FFF7ED',border:'1px solid #FED7AA',borderRadius:6,padding:'8px 10px'}}>
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
    const todayStr=new Date().toISOString().slice(0,10);
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
    const accent=occ?(order?statusAccent(order.status):C.green):'#C8C8CC';
    const espera=order?Math.floor((Date.now()-new Date(order.created_at))/60000):0;
    const sesTotal=sessionTotals[table.id]||0;
    const tableInvoiceReq=(orders||[]).some(o=>o.table_id===table.id && o.requires_invoice && (o.invoice_status||'pending')==='pending');
    return(
      <div onClick={()=>occ&&loadTableSession(table)} style={{
        background:occ?'#1D1D1F':C.surface,
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
        <div style={{fontSize:22,fontWeight:800,color:occ?'#FFFFFF':'#1D1D1F',letterSpacing:'-0.5px'}}>Mesa {table.number}</div>
        {tableInvoiceReq&&(()=>{const m=(orders||[]).find(o=>o.table_id===table.id && o.requires_invoice && (o.invoice_status||'pending')==='pending')?.invoice_delivery_method;return(
          <div style={{position:'absolute',top:8,right:8,background:'#007AFF',color:'#fff',fontSize:10,fontWeight:800,padding:'3px 7px',borderRadius:8,letterSpacing:'0.04em'}}>
            🧾 {m==='email'?'EMAIL':'IMPRESA'}
          </div>
        );})()}
        {table.capacity&&<div style={{fontSize:12,color:occ?'#AAAAAA':'#6E6E73',marginTop:2}}>{table.capacity} pax</div>}
        {occ?(
          <>
            {order&&<div style={{marginTop:10}}><Badge txt={SL[order.status]} color={SC[order.status]||'#6E6E73'}/></div>}
            {!order&&<div style={{marginTop:10}}><Badge txt="Servicio activo" color={C.green}/></div>}
            {order&&<div style={{fontSize:11,color:'#AAAAAA',marginTop:8}}>⏱ {espera}m · #{order.order_number}</div>}
            {table.assigned_waiter_name&&<div style={{fontSize:11,color:'#AAAAAA',marginTop:4}}>👤 {table.assigned_waiter_name}</div>}
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
                <Badge txt={`🧾 ${order.invoice_delivery_method==='email'?'Factura email':'Factura impresa'}`} color={'#007AFF'}/>
              )}
              <span style={{fontSize:10,color:C.mid}}>⏱ {espera}m</span>
            </div>
          </div>
          <div style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:15,fontWeight:800,color:C.green,whiteSpace:'nowrap'}}>{fmt(order.total)}</div>
        </div>
        {allowCancel&&(
          <div style={{display:'flex',justifyContent:'flex-end'}}>
            <button
              onClick={e=>{e.stopPropagation();setCancelTarget(order);}}
              title="Cancelar pedido"
              style={{padding:'5px 10px',background:'transparent',color:C.red,border:`1px solid ${C.red}55`,borderRadius:6,fontSize:11,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap',letterSpacing:0.2}}>
              ❌ Cancelar
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
          <Btn small variant="secondary" onClick={()=>setQrModal(true)}>▦ QR mostrador</Btn>
          <Btn small variant="secondary" onClick={load}>↻ Actualizar</Btn>
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
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
              <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1}}>MAPA DEL SALÓN</div>
              <div style={{display:'flex',gap:8,alignItems:'center'}}>
                {editMode&&<div style={{fontSize:11,color:C.dim}}>Arrastrá para posicionar · click para editar</div>}
                <button type="button" onClick={()=>setNewMesa(true)}
                  style={{padding:'5px 14px',borderRadius:6,border:'none',background:'#000',color:'#fff',fontSize:12,fontWeight:700,cursor:'pointer'}}>
                  + Nueva mesa
                </button>
                <button type="button" onClick={()=>{setEditMode(e=>!e);setDragging(null);}}
                  style={{padding:'5px 14px',borderRadius:6,border:`1px solid ${editMode?'#000':'#D2D2D7'}`,background:editMode?'#000':'transparent',color:editMode?'#fff':'#6E6E73',fontSize:12,fontWeight:700,cursor:'pointer'}}>
                  {editMode?'✓ Editando':'✎ Editar mesas'}
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
                <div style={{fontSize:10,color:C.yellow,fontWeight:700,letterSpacing:1,marginBottom:8}}>⚠ PEDIDOS CON MESA NO REGISTRADA</div>
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
                <div style={{background:'#FEE2E2',border:'1px solid #DC2626',borderRadius:8,padding:'10px 12px',fontSize:12,color:'#991B1B'}}>
                  ⚠ Esta mesa está ocupada y tiene una reserva próxima. Considerá pedir la cuenta al cliente actual.
                </div>
              )}
              <div style={{background:'#FFF7ED',border:'1px solid #FED7AA',borderRadius:8,padding:'12px 14px'}}>
                <div style={{fontSize:16,fontWeight:800,color:C.ink,marginBottom:6}}>{r.customer_name}</div>
                <div style={{fontSize:13,color:'#3D3D3D',lineHeight:1.7}}>
                  📞 {r.customer_phone}<br/>
                  🕐 Hora reservada: <strong>{horaTxt}</strong> ({tiempoTxt})<br/>
                  👥 {r.guests} personas{r.occasion?<><br/>🎉 Motivo: {r.occasion}</>:null}
                  {r.notes?<><br/>📝 {r.notes}</>:null}
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
                <span style={{fontSize:12,color:C.ink,fontWeight:600}}>👤 Mozo: {selTable.table.assigned_waiter_name||selTable.orders[0].waiter_name}</span>
              ):(
                <span style={{fontSize:12,color:C.mid}}>👤 Sin mozo asignado</span>
              )}
            </div>

            {/* Resumen rápido */}
            {selTable.orders.length>0&&(()=>{
              const pagados=selTable.orders.filter(o=>o.payment_status==='paid');
              const sinCobrar=selTable.orders.filter(o=>o.payment_status!=='paid');
              const totalPagado=pagados.reduce((s,o)=>s+Number(o.total||0),0);
              const totalSinCobrar=sinCobrar.reduce((s,o)=>s+Number(o.total||0),0);
              return(
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,marginBottom:14}}>
                  <div style={{background:'rgba(52,199,89,0.1)',border:'1px solid rgba(52,199,89,0.3)',borderRadius:8,padding:'10px 12px',textAlign:'center'}}>
                    <div style={{fontSize:10,color:'#1A7E37',fontWeight:700,marginBottom:4}}>PAGADO</div>
                    <div style={{fontSize:16,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:'#1A7E37'}}>{fmt(totalPagado)}</div>
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
                      {esPagado?<span style={{fontSize:10,color:C.green,fontWeight:700}}>✓ Cobrado</span>:<span style={{fontSize:10,color:C.red,fontWeight:700}}>⚠ Sin cobrar</span>}
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
function CierreCajaPanel({turno,movimientos,profile,onCierre}){
  const [denoms,setDenoms]=useState(emptyDenoms());
  const [vouchersTxt,setVouchersTxt]=useState('');
  const [transferTxt,setTransferTxt]=useState('');
  const [obs,setObs]=useState('');
  const [busy,setBusy]=useState(false);

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
      try{localStorage.removeItem('caja_panel');localStorage.removeItem('caja_cart');}catch{}
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
          <div style={{fontFamily:'DM Serif Display',fontSize:26,marginBottom:6,color:C.ink}}>Cierre de Caja</div>
          <div style={{fontSize:13,color:C.mid}}>Cajero: <strong style={{color:C.ink}}>{profile.display_name||profile.username}</strong> · Apertura {fmtDT(turno.fecha_apertura)}</div>
        </div>

        <AlertBox type="info">
          Ingresá el conteo físico de tu caja. El sistema registra el arqueo y cierra tu turno; no verás totales del sistema en pantalla.
        </AlertBox>

        <DenomGrid values={denoms} onChange={setDenoms} label="Conteo físico de efectivo en caja"/>

        <div style={{marginTop:16}}>
          <Lbl>TOTAL VOUCHERS TARJETA (GS.)</Lbl>
          <Inp type="number" mono value={vouchersTxt} onChange={e=>setVouchersTxt(e.target.value)} placeholder="0" min="0" step="1"/>
        </div>
        <div style={{marginTop:12}}>
          <Lbl>TOTAL TRANSFERENCIAS / QR BANCARD (GS.)</Lbl>
          <Inp type="number" mono value={transferTxt} onChange={e=>setTransferTxt(e.target.value)} placeholder="0" min="0" step="1"/>
        </div>
        <div style={{marginTop:12,marginBottom:20}}>
          <Lbl>OBSERVACIONES DE CIERRE</Lbl>
          <Textarea value={obs} onChange={e=>setObs(e.target.value)} placeholder="Novedades, incidentes o aclaraciones del turno…" rows={3}/>
        </div>

        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'14px 16px',display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18}}>
          <div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:1}}>TOTAL DECLARADO</div>
          <div style={{fontSize:22,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.ink}}>{fmt(totalDeclarado)}</div>
        </div>

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
        background:open?C.white:'#FFFFFF',
        border:`1px solid ${open?'transparent':C.bs}`,
        color:open?'#000':C.mid,
        fontSize:20,cursor:'pointer',
        boxShadow:'0 4px 16px rgba(0,0,0,0.5)',
        display:'flex',alignItems:'center',justifyContent:'center',
      }}>🧮</button>

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
                      background:isDel?'rgba(239,68,68,0.15)':isEq?'rgba(34,197,94,0.18)':isOp||k==='%'||k==='←'?'#000000':C.card,
                      color:isDel?C.red:isEq?C.green:isOp||k==='%'||k==='←'?'#FFFFFF':C.ink,
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
  const OCCASION_OPTS=[{id:'',label:'Sin motivo especial'},{id:'birthday',label:'🎂 Cumpleaños'},{id:'anniversary',label:'💑 Aniversario'},{id:'business',label:'💼 Reunión'},{id:'celebration',label:'🥂 Celebración'},{id:'other',label:'✦ Otro'}];
  const STATUS_OPTS=[{id:'pending',label:'Pendiente'},{id:'confirmed',label:'Confirmada'},{id:'seated',label:'En mesa'},{id:'no_show',label:'No llegó'},{id:'cancelled',label:'Cancelada'}];

  const TIME_SLOTS=[];
  for(let h=10;h<=23;h++){TIME_SLOTS.push(`${String(h).padStart(2,'0')}:00`);TIME_SLOTS.push(`${String(h).padStart(2,'0')}:30`);}

  const todayStr=now.toISOString().slice(0,10);
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
                  style={{padding:'5px 2px',borderRadius:5,border:`1.5px solid ${sel?'#000':C.border}`,background:sel?'#000':'transparent',color:sel?'#fff':C.ink,fontSize:11,fontWeight:sel?700:400,cursor:'pointer',transition:'all 100ms'}}>
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
              style={{padding:'8px 20px',border:'none',borderRadius:8,background:canSave?'#000':'#ccc',color:'#fff',fontSize:13,fontWeight:700,cursor:canSave?'pointer':'default',opacity:saving?.6:1}}>
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
  const [dateFilter,setDateFilter]=useState(new Date().toISOString().slice(0,10));
  const [newModal,setNewModal]=useState(false);
  const [editModal,setEditModal]=useState(null);
  const [tables,setTables]=useState([]);

  const OCCASION_LABEL={birthday:'🎂 Cumpleaños',anniversary:'💑 Aniversario',business:'💼 Reunión',celebration:'🥂 Celebración',other:'✦ Otro'};
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
          <h1 style={{fontSize:22,fontWeight:800,color:'#000000',margin:0}}>Reservas</h1>
          <div style={{fontSize:12,color:C.mid,marginTop:3}}>{reservas.filter(r=>['pending','confirmed'].includes(r.status)).length} activas para esta fecha</div>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <input type="date" value={dateFilter} onChange={e=>setDateFilter(e.target.value)}
            style={{height:34,border:`1px solid ${C.border}`,borderRadius:6,padding:'0 10px',fontSize:13,color:C.ink,background:C.surface,outline:'none'}}/>
          <button onClick={load} style={{height:34,padding:'0 12px',border:`1px solid ${C.border}`,borderRadius:6,background:C.surface,color:C.mid,fontSize:12,cursor:'pointer'}}>↺</button>
          <button onClick={()=>setNewModal(true)} style={{height:34,padding:'0 14px',border:'none',borderRadius:6,background:'#000',color:'#fff',fontSize:12,fontWeight:700,cursor:'pointer'}}>+ Nueva</button>
        </div>
      </div>

      {loading&&<div style={{textAlign:'center',padding:40,color:C.mid}}>Cargando…</div>}
      {!loading&&reservas.length===0&&(
        <div style={{textAlign:'center',padding:60,color:C.mid}}>
          <div style={{fontSize:28,marginBottom:10}}>◷</div>
          <div style={{fontSize:14,fontWeight:600}}>Sin reservas para esta fecha</div>
          <button onClick={()=>setNewModal(true)} style={{marginTop:14,padding:'8px 20px',border:'none',borderRadius:8,background:'#000',color:'#fff',fontSize:13,fontWeight:700,cursor:'pointer'}}>+ Crear reserva</button>
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
                      <span>👥 {r.guests} personas</span>
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
      .select('id,created_at,monto,metodo_pago,descripcion,pedido_id,metadata')
      .eq('turno_id',turno.id).eq('tipo','cobro')
      .order('created_at',{ascending:false})
      .then(({data})=>{setCobros(data||[]);setLoading(false);});
  },[turno.id]);

  const total=cobros.reduce((s,m)=>s+Number(m.monto||0),0);
  const MET={efectivo:'Efectivo',tarjeta_credito:'T.Crédito',tarjeta_debito:'T.Débito',qr:'QR',mixto:'Mixto'};

  async function reimprimir(c){
    const meta=c.metadata||{};
    let items=[];
    if(c.pedido_id){
      const{data}=await db.from('order_items').select('item_name,quantity,unit_price').eq('order_id',c.pedido_id);
      items=data||[];
    }
    printTicket({
      orderNumber:meta.orden_numero||'—',
      mesa:meta.mesa||c.descripcion||'—',
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
        <span style={{fontSize:22}}>🇵🇾</span>
        <div>
          <div style={{fontSize:13,fontWeight:700,color:'#007AFF'}}>Facturación electrónica SET (SIFEN)</div>
          <div style={{fontSize:11,color:C.mid,marginTop:2}}>Próximamente — integración con la SET de Paraguay para emisión de facturas electrónicas (e-Kuatia).</div>
        </div>
        <span style={{marginLeft:'auto',fontSize:10,fontWeight:700,color:'#007AFF',background:'rgba(0,122,255,0.1)',padding:'3px 8px',borderRadius:10,whiteSpace:'nowrap'}}>PRÓX.</span>
      </div>

      {loading&&<div style={{textAlign:'center',padding:40}}><span className="spin"/></div>}

      {!loading&&cobros.length===0&&(
        <div style={{textAlign:'center',padding:'60px 0',color:C.mid}}>
          <div style={{fontSize:36,marginBottom:12}}>🧾</div>
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
                    <span style={{fontSize:10,background:'#F0F0F0',borderRadius:6,padding:'1px 6px',color:C.mid,fontWeight:600}}>{MET[c.metodo_pago]||c.metodo_pago}</span>
                  </div>
                  <div style={{fontSize:11,color:C.dim}}>{hora}</div>
                </div>
                <div style={{fontFamily:"'SF Mono',monospace",fontSize:16,fontWeight:800,color:'#34C759',flexShrink:0}}>{fmt(c.monto)}</div>
                <button onClick={()=>reimprimir(c)} title="Reimprimir ticket" style={{padding:'6px 10px',borderRadius:6,border:`1px solid ${C.border}`,background:'transparent',color:C.mid,fontSize:13,cursor:'pointer',flexShrink:0}}>🖨</button>
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

    const{data,error}=await db.from('orders')
      .select('id,order_number,status,payment_status,total,order_type,customer_name,created_at,table_id,payment_method,tables(number)')
      .eq('restaurant_id',RID)
      .gte('created_at',from.toISOString())
      .order('created_at',{ascending:false})
      .limit(300);
    if(!error){
      const rows=data||[];
      setOrders(rows);
      // Alerta: pedidos que llegaron al historial sin cobrar (no cancelados, payment_status != paid)
      const pendCount=rows.filter(o=>o.status!=='cancelled'&&o.payment_status!=='paid'&&Number(o.total||0)>=0).length;
      setAlertaPendientes(pendCount);
    }
    setLoading(false);
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
  const MET_LBL={efectivo:'Efectivo',tarjeta_credito:'Tarjeta Cred.',tarjeta_debito:'Tarjeta Déb.',qr:'QR/Transfer.',mixto:'Mixto'};

  return(
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16,gap:10,flexWrap:'wrap'}}>
        <h1 style={{fontSize:20,fontWeight:800}}>Historial de pedidos</h1>
        <Btn small variant="secondary" onClick={load}>↻ Actualizar</Btn>
      </div>

      {alertaPendientes>0&&(
        <div style={{background:'rgba(255,59,48,0.08)',border:'2px solid rgba(255,59,48,0.5)',borderRadius:10,padding:'12px 16px',marginBottom:16,display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap'}}>
          <div>
            <div style={{fontWeight:800,color:'#FF3B30',fontSize:14}}>⚠ {alertaPendientes} pedido{alertaPendientes>1?'s':''} sin cobrar en el historial</div>
            <div style={{fontSize:12,color:C.mid,marginTop:2}}>Estos pedidos no deberían estar aquí sin cobrar. Ir a cobrar para resolverlos.</div>
          </div>
          {onGoCobros&&<button onClick={onGoCobros} style={{background:'#FF3B30',color:'#fff',border:'none',padding:'8px 16px',borderRadius:8,fontSize:13,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap'}}>Ir a cobrar →</button>}
        </div>
      )}

      {/* Filtros */}
      <div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap',alignItems:'center'}}>
        {/* Rango */}
        <div style={{display:'flex',gap:0,background:'#F0F0F0',borderRadius:8,padding:3}}>
          {[['hoy','Hoy'],['7d','7 días'],['30d','30 días'],['todo','Todo']].map(([id,lbl])=>(
            <button key={id} onClick={()=>setRango(id)} style={{
              padding:'5px 12px',borderRadius:6,border:'none',fontSize:12,fontWeight:rango===id?700:500,
              background:rango===id?'#FFFFFF':'transparent',color:rango===id?'#000000':'#6E6E73',
              cursor:'pointer',boxShadow:rango===id?'0 1px 4px rgba(0,0,0,0.15)':'none',
            }}>{lbl}</button>
          ))}
        </div>

        {/* Status filter */}
        <select value={statusFlt} onChange={e=>setStatusFlt(e.target.value)} style={{padding:'6px 10px',fontSize:12,borderRadius:6,border:`1px solid ${C.border}`,background:'#FFF',color:C.ink,fontWeight:600}}>
          {STATUS_OPTIONS.map(s=><option key={s.id} value={s.id}>{s.lbl}</option>)}
        </select>

        {/* Tipo filter */}
        <select value={tipoFlt} onChange={e=>setTipoFlt(e.target.value)} style={{padding:'6px 10px',fontSize:12,borderRadius:6,border:`1px solid ${C.border}`,background:'#FFF',color:C.ink,fontWeight:600}}>
          {TIPO_OPTIONS.map(t=><option key={t.id} value={t.id}>{t.lbl}</option>)}
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
            return(
              <div key={o.id} style={{background:C.surface,border:`1px solid ${borderColor}`,borderRadius:8,padding:'10px 16px',display:'flex',justifyContent:'space-between',alignItems:'center',gap:10}}>
                <div style={{minWidth:0,flex:1}}>
                  <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                    <span style={{fontSize:13,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.ink}}>#{o.order_number}</span>
                    <Badge txt={SL[o.status]||o.status} color={SC[o.status]||'#6E6E73'}/>
                    <span style={{fontSize:11,color:C.mid,fontWeight:500}}>{tipo}</span>
                    <span style={{fontSize:11,color:C.mid}}>{mesa}</span>
                  </div>
                  <div style={{fontSize:11,color:C.mid,marginTop:4,display:'flex',gap:12}}>
                    <span>{fmtDT(o.created_at)}</span>
                    {o.payment_method&&<span>💳 {metodo}</span>}
                  </div>
                </div>
                <div style={{textAlign:'right',flexShrink:0}}>
                  <div style={{fontSize:16,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:esCancelado?C.red:esSinCobrar?C.orange:C.green}}>{fmt(o.total)}</div>
                  {esSinCobrar&&<div style={{fontSize:10,color:C.orange,fontWeight:700,marginTop:2}}>⚠ PENDIENTE</div>}
                </div>
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
  function changePanel(p){localStorage.setItem('caja_panel',p);setPanel(p);}

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
          payment_method:o.metodo,total:o.total,created_by:profile.id,
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
          toast(`💰 ${mesa} solicita cobro`,true);
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
      case 'cierre':           return <CierreCajaPanel   turno={turno} movimientos={movimientos} profile={profile} onCierre={handleCierre}/>;
      default: return null;
    }
  };

  return(
    <div style={{display:'flex',minHeight:'100vh'}}>
      <SidebarTurno turno={turno} movimientos={movimientos} panel={panel} setPanel={(p)=>{if(p==='avisos'){const now=Date.now();localStorage.setItem('caja_bc_seen',now);lastSeenBroadcasts.current=now;}changePanel(p);}} profile={profile} onToggleTheme={toggleTheme} paymentCalls={paymentCalls.length} onClickCalls={()=>changePanel('cobros')} isOnline={isOnline} pendingOffline={pendingOffline} broadcastCount={broadcasts.filter(b=>new Date(b.created_at).getTime()>lastSeenBroadcasts.current).length}/>
      <main style={{flex:1,padding:24,overflowY:'auto',minWidth:0}}>
        {paymentCalls.length>0&&(
          <div style={{background:'rgba(255,149,0,0.12)',border:'1px solid rgba(255,149,0,0.5)',borderRadius:10,padding:'12px 16px',marginBottom:16,display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}}>
            <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
              <span style={{fontSize:18}}>💰</span>
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
    const{data}=await db.from('turnos_caja')
      .select('*').eq('restaurant_id',RID).eq('estado','abierto')
      .order('fecha_apertura',{ascending:false}).limit(1);
    if(data&&data.length>0){
      const t=data[0];
      // Comparación robusta (coerción a string evita mismatch por tipo/espacios).
      const esMiTurno   = String(t.cajero_id||'')===String(profile.id||'');
      const esPrivilegiado=['admin','superadmin'].includes(profile.role);
      if(esMiTurno||esPrivilegiado){
        // Mismo cajero (o admin) reconectándose a mitad del turno → reabrir el
        // panel directamente, SIN volver a pedir la apertura de caja.
        setTurno(t);
      } else {
        // Otro cajero: caja abierta sin cierre por la sesión anterior.
        // No es dead-end → pantalla con opción de retomar/arquear (CajaOcupadaScreen).
        setTurnoConflicto(t);
      }
    }
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
        <Btn variant="ghost" onClick={()=>window.location.href='admin.html'}>Ir al Admin</Btn>
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
          <div style={{fontSize:38,marginBottom:8}}>🔓</div>
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

  return <AperturaTurnoScreen profile={profile} turnoAbierto={null} onTurnoAbierto={t=>{setTurno(t);setTurnoConflicto(null);}}/>;
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
    const{data:r}=await db.from('restaurants').select('name').eq('id',RID).maybeSingle();
    window._restaurantName=r?.name||'Restaurante';
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
