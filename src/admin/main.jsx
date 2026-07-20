// ════════════════════════════════════════════════════════════════════
// PR-5 — Panel admin precompilado con Vite (batch de migración legacy).
// Migrado 1:1 desde el <script type="text/babel"> inline de public/admin.html.
// Sin cambios de comportamiento ni de UI. React/createRoot vienen de npm
// (bundle Vite); el resto de globales del shell siguen en window.* (config.js,
// supabase UMD, MythosTheme/Icons/Presence/Session/Gating, XLSX, Leaflet, etc.).
// ════════════════════════════════════════════════════════════════════
import React from "react";
import { createRoot } from "react-dom/client";
import { formatGs, parseGs, GsInput, NumInput } from "../shared/gs.jsx";
// FASE D2 — validación de comprobantes (etiquetas de estado en reportes).
import { reviewMeta, ProofImage } from "../shared/comprobante.jsx";
// CAPTCHA Turnstile (nativo de Supabase Auth) para los flujos in-app que
// re-autentican (modal "Cambiar contraseña" → signInWithPassword).
import { useTurnstile } from "../shared/turnstile.js";
// PR-MKT-2: módulo Marketplace B2B (tablas marketplace_*, migs 142/143) —
// compartido con el panel gerente. NO confundir con ProveedoresPage (los
// proveedores internos de compras: public.suppliers, mig 072).
import { createRestaurantMarketplace } from "../marketplace/restaurant-marketplace.jsx";

// PR-5 (Bug A): mythos-gating.js es un script global legacy que usa React global
// (window.React). Tras bundlear React por panel con Vite ya no existe como global y
// useCapabilities() rompía con "React is not defined". Reexponemos la MISMA instancia de
// React (la del bundle) para el script global; NO se reintroduce React por CDN.
window.React = React;

const { useState, useEffect, useRef, useMemo, useCallback, useReducer } = React;

/* ── DB ── */
const _initDB = () => {
  const cfg = window.SUPABASE_CONFIG;
  if (!cfg?.url || !cfg?.anonKey) return null;
  const url = cfg.url.replace(/^﻿/,'').trim();
  const key = cfg.anonKey.replace(/^﻿/,'').trim();
  if (!url || url.includes('YOUR_') || !key) return null;
  try { return window.supabase.createClient(url, key); } catch(e) { return null; }
};
const db = _initDB();
/* RID = sucursal activa de la sesión (multi-sucursal). El dueño la conmuta vía
   localStorage.mythos_restaurant_id; fallback a config.js para superadmin/demo. */
// Superadmin launcher (superadmin → Paneles): puede fijar el local por ?r= para verlo/operarlo
// con su bypass de RLS (mig 088). SOLO aplica al superadmin; cualquier otro rol ignora ?r=.
const _SUPER_RID = (function(){ try {
  if ((localStorage.getItem('mythos_role')||'').trim() !== 'superadmin') return null;
  return (new URLSearchParams(window.location.search).get('r')||'').trim() || null;
} catch(_) { return null; } })();
const RID = (_SUPER_RID || localStorage.getItem('mythos_restaurant_id') || (window.SUPABASE_CONFIG?.restaurantId) || '').replace(/^﻿/,'').trim();
const MY_ROLE = (localStorage.getItem('mythos_role')||'').trim();

/* contador global — pausa el polling cuando hay modal abierto o input con foco */
let _modalCount = 0;
function _shouldPause() {
  if (_modalCount > 0) return true;
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return ['INPUT','TEXTAREA','SELECT'].includes(tag) || el.isContentEditable;
}

/* ── LOCALSTORAGE HELPERS ── */
const LS = {
  get: (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const ZONES_KEY   = `zones_${RID}`;
const EGRESOS_KEY = `egresos_${RID}`;
const DELIV_KEY   = `deliv_pct_${RID}`;

/* ── UTILS ── */
// Escapa HTML para interpolar datos en plantillas de impresión (document.write).
// Evita stored XSS: un cliente podría poner <script> como nombre/dirección al pedir.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt   = n => '₲ ' + (n||0).toLocaleString('es-PY');
const fmtK  = n => n >= 1000000 ? `${(n/1000000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n/1000)}k` : String(n||0);
const fmtDate = d => new Date(d).toLocaleDateString('es-PY',{day:'2-digit',month:'2-digit',year:'2-digit'});
const fmtTime = d => new Date(d).toLocaleTimeString('es-PY',{hour:'2-digit',minute:'2-digit'});
const fmtDT   = d => `${fmtDate(d)} ${fmtTime(d)}`;
const DAY = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
const SL = {draft:'Borrador',confirmed:'Confirmado',paid:'Nuevo',kitchen_received:'En cocina',cooking:'Preparando',ready:'Listo',delivered:'Entregado',cancelled:'Cancelado'};
const SC = {draft:'#86868B',confirmed:'#6E6E73',paid:'#FF9500',kitchen_received:'#007AFF',cooking:'#FF9500',ready:'#34C759',delivered:'#86868B',cancelled:'#FF3B30'};
const PL = {efectivo:'Efectivo',tarjeta:'Tarjeta',qr:'QR',pos:'POS'};
const EG_CATS = ['Insumos','Personal','Servicios','Alquiler','Mantenimiento','Impuestos','Otro'];
function mesaLabel(o) {
  if (!o) return '—';
  if (o.order_type === 'llevar')   return 'Para llevar';
  if (o.order_type === 'delivery') return 'Delivery';
  if (o.table_number != null)      return `Mesa ${o.table_number}`;
  if (o.table_id)                  return 'Mesa (sin número)';
  return 'Sin mesa';
}
const ROLES = ['cocina','admin','superadmin','waiter','cajero'];
/* Roles que el Admin puede asignar (no puede crear admins ni superadmins) */
const ADMIN_ALLOWED_ROLES = ['cajero','mozo','cocina','rider','supervisor_local'];
/* Etiquetas legibles (la clave es el string real en user_roles). 'supervisor_local' = Gerente */
const ROLE_LABEL = {superadmin:'Superadmin',admin:'Admin',supervisor_local:'Gerente',gerente:'Gerente',cajero:'Cajero',cocina:'Cocina',mozo:'Mozo',waiter:'Mozo',delivery:'Rider (legacy)',rider:'Rider',repartidor:'Rider'};
const roleLabel = r => ROLE_LABEL[(r||'').toLowerCase()] || r || '—';
/* PIN de 4 dígitos para riders (login del panel Delivery es por PIN, no por contraseña) */
function genRiderPin() { return String(Math.floor(1000 + Math.random() * 9000)); }

/* ── PALETTE ── reactiva al tema MythosTheme */
const C_LIGHT = {
  bg:'var(--bg-subtle)',sidebar:'#FFFFFF',surface:'#FFFFFF',card:'#FFFFFF',
  border:'#C2C2C8',bs:'#5E5E62',
  white:'#FFFFFF',ink:'#1D1D1F',mid:'#48484A',dim:'#5E5E62',
  green:'#34C759',orange:'#FF9500',red:'#FF3B30',yellow:'#FF9500',blue:'#007AFF',purple:'#000000',
  shadow:'0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.08)',
};
const C_DARK = {
  bg:'#0B0B0D',sidebar:'#1C1C1E',surface:'#1C1C1E',card:'#2C2C2E',
  border:'#48484A',bs:'#636366',
  white:'#1C1C1E',ink:'#F5F5F7',mid:'#AEAEB2',dim:'#8E8E93',
  green:'#30D158',orange:'#FF9F0A',red:'#FF453A',yellow:'#FFD60A',blue:'#0A84FF',purple:'#F5F5F7',
  shadow:'inset 0 1px 0 rgba(255,255,255,.06), 0 4px 16px rgba(0,0,0,.55)',
};
const C = {...(window.MythosTheme && window.MythosTheme.get()==='dark' ? C_DARK : C_LIGHT)};
if (window.MythosTheme) {
  document.addEventListener('mythos:themechange', function(e){
    Object.assign(C, e.detail.mode==='dark' ? C_DARK : C_LIGHT);
  });
}

/* ── TINT (PR-B4D) ── tintes de estado theme-adaptive y frozen-safe.
   Strings color-mix(var(--estado) N%, var(--surface|--text-primary)): el navegador
   los resuelve por tema en cada paint, así que sirven incluso dentro de objetos const
   evaluados una sola vez (badges/pills que en light eran #FFF4E0+#8A4B00 etc.). En light
   replican el tinte pastel + texto oscuro previos; en dark dan tinte oscuro + texto claro.
   Mismo lenguaje que .my-badge. NO cambia lógica: solo el valor de color. */
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
  purpleText:'color-mix(in srgb, #5856D6 72%, var(--text-primary))',
  purpleBorder:'color-mix(in srgb, #5856D6 40%, transparent)',
};

/* ── Icon helper ──────────────────────────────────────────── */
const Icon = ({name, size=14, style}) => (
  <span style={{display:'inline-flex',alignItems:'center',justifyContent:'center',lineHeight:0,...(style||{})}}
        dangerouslySetInnerHTML={{__html: window.MythosIcons ? window.MythosIcons.html(name, {size}) : ''}}/>
);

/* ── TOAST ── */
const _toast = { fn: null };
function toast(msg, ok=true) { _toast.fn?.({ msg, ok, id: Date.now() }); }
function ToastContainer() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    _toast.fn = item => {
      setItems(p => [...p.slice(-4), item]);
      setTimeout(() => setItems(p => p.filter(i => i.id !== item.id)), 4000);
    };
    return () => { _toast.fn = null; };
  }, []);
  return (
    <div style={{position:'fixed',bottom:20,right:20,zIndex:9999,display:'flex',flexDirection:'column',gap:8,pointerEvents:'none'}}>
      {items.map(it => (
        <div key={it.id} style={{background:it.ok?TINT.greenBg:TINT.redBg,border:`1px solid ${it.ok?TINT.greenBorder:TINT.redBorder}`,color:it.ok?TINT.greenText:TINT.redText,padding:'10px 16px',fontSize:13,fontWeight:700,borderRadius:8,animation:'slideUp 200ms ease',minWidth:220,maxWidth:320}}>
          {it.ok ? '✓ ' : '✕ '}{it.msg}
        </div>
      ))}
    </div>
  );
}

/* ── MODAL ── */
function Modal({ title, onClose, children, width=420 }) {
  useEffect(() => {
    _modalCount++;
    const fn = e => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', fn);
    return () => { _modalCount = Math.max(0, _modalCount - 1); window.removeEventListener('keydown', fn); };
  }, [onClose]);
  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.85)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000,padding:20}}>
      <div style={{background:C.bg,border:`1px solid ${C.bs}`,borderRadius:12,padding:28,width:'100%',maxWidth:width,maxHeight:'90vh',overflowY:'auto',animation:'slideUp 200ms ease'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
          <div style={{fontSize:15,fontWeight:700}}>{title}</div>
          <button onClick={onClose} style={{background:'none',border:'none',color:C.mid,fontSize:22,lineHeight:1,padding:0}}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ── SHARED COMPONENTS ── */
function Badge({status}) {
  const col = SC[status]||'#6E6E73';
  return <span style={{display:'inline-flex',alignItems:'center',gap:5,padding:'3px 8px',fontSize:11,fontWeight:700,background:col+'22',color:col,border:`1px solid ${col}44`,borderRadius:5}}><span style={{width:5,height:5,borderRadius:'50%',background:col}}/>{SL[status]||status}</span>;
}
function KpiCard({label,value,sub,accent,icon,onClick}) {
  // PR-B3B: superficie/label desde primitives (.my-metric-card, Opción A). Se
  // conservan el valor (mono + acento), el sub y el hover JS de las KPIs clicables.
  return (
    <div onClick={onClick} className="my-metric-card" style={{flex:1,minWidth:140,cursor:onClick?'pointer':'default'}} onMouseEnter={e=>{if(onClick)e.currentTarget.style.borderColor=C.bs;}} onMouseLeave={e=>{if(onClick)e.currentTarget.style.borderColor=C.border;}}>
      {icon && <div style={{fontSize:20,marginBottom:8}}>{icon}</div>}
      <div className="my-metric-card__label">{label}{onClick&&<span style={{color:C.mid,marginLeft:4}}>→</span>}</div>
      <div style={{fontSize:24,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:accent||'var(--text-primary)',lineHeight:1}}>{value}</div>
      {sub && <div style={{fontSize:11,color:C.dim,marginTop:5}}>{sub}</div>}
    </div>
  );
}
function Stars({n}) { return <span style={{color:C.yellow,letterSpacing:2,fontSize:14}}>{'★'.repeat(n)}{'☆'.repeat(5-n)}</span>; }
function Th({children,right}) { return <th style={{padding:'9px 14px',textAlign:right?'right':'left',fontSize:10,color:C.ink,fontWeight:700,letterSpacing:1,whiteSpace:'nowrap',textTransform:'uppercase'}}>{children}</th>; }
function Td({children,mono,dim,right,style:sx}) { return <td style={{padding:'10px 14px',fontSize:13,fontFamily:mono?"'SF Mono',ui-monospace,monospace":'inherit',color:dim?'var(--text-secondary)':'var(--text-primary)',textAlign:right?'right':'left',...sx}}>{children}</td>; }
function EmptyRow({cols,label}) { return <tr><td colSpan={cols} style={{padding:40,textAlign:'center',color:C.dim,fontSize:13}}>{label||'Sin datos'}</td></tr>; }
function Lbl({children}) { return <label style={{fontSize:10,color:C.mid,display:'block',marginBottom:5,fontWeight:700,letterSpacing:1}}>{children}</label>; }
/* Campo de formulario (label + control + hint). DEBE vivir a nivel de módulo:
   si se define dentro de un componente, cada render le da una identidad nueva y
   React desmonta/remonta el <input> hijo → el foco se pierde en cada tecla. */
function FF({label,hint,children}) {
  return (
    <div>
      <Lbl>{label}</Lbl>
      {children}
      {hint&&<div style={{fontSize:10,color:C.dim,marginTop:3}}>{hint}</div>}
    </div>
  );
}
function Inp({value,onChange,placeholder,type='text',mono,full=true,...rest}) {
  return <input type={type} value={value} onChange={onChange} placeholder={placeholder} {...rest} style={{width:full?'100%':'auto',padding:'8px 10px',fontSize:13,fontFamily:mono?"'SF Mono',ui-monospace,monospace":'inherit',borderRadius:6,...(rest.style||{})}}/>;
}
/* Input de guaraníes: muestra separadores de miles con punto (100.000) mientras
   se tipea y entrega el ENTERO crudo al padre. Delega en el <GsInput> compartido
   (cursor/pegar/borrar) y conserva el contrato de admin: onChange(numeroEntero). */
function MoneyInp({value, onChange, placeholder='0', full=true, style:sx, ...rest}) {
  const fmtPlaceholder = parseInt(placeholder)>0 ? parseInt(placeholder).toLocaleString('es-PY') : placeholder;
  return <GsInput
    value={value ? value : ''}
    onChange={raw => onChange(raw==='' ? 0 : (parseInt(raw,10)||0))}
    placeholder={fmtPlaceholder}
    {...rest}
    style={{width:full?'100%':'auto',padding:'8px 10px',fontSize:13,fontFamily:"'SF Mono',ui-monospace,monospace",borderRadius:6,...(sx||{})}}
  />;
}
function Sel({value,onChange,children,...rest}) {
  return <select value={value} onChange={onChange} {...rest} style={{width:'100%',padding:'8px 10px',fontSize:13,borderRadius:6,...(rest.style||{})}}>{children}</select>;
}
/* Input numérico de magnitud: separador de miles con punto (10.000) y sin el
   "0" pegado que no se puede borrar. Delega en el <NumInput> compartido; el
   padre recibe el string crudo JS-parseable ('10000', '2.5', ''). decimals=0
   → entero; decimals>0 → admite decimales (coma). Contrato onChange(rawString).
   Para dinero en ₲ usar <MoneyInp>; esto es para cantidades/umbrales/stock. */
function NumInp({value, onChange, decimals=0, placeholder, full=true, mono=true, style:sx, ...rest}) {
  return <NumInput
    value={value===''||value==null ? '' : value}
    onChange={onChange}
    decimals={decimals}
    placeholder={placeholder}
    {...rest}
    style={{width:full?'100%':'auto',padding:'8px 10px',fontSize:13,fontFamily:mono?"'SF Mono',ui-monospace,monospace":'inherit',borderRadius:6,...(sx||{})}}
  />;
}
function Btn({children,onClick,variant='primary',disabled,small,style:sx}) {
  // PR-B3B: botón cableado a .my-btn + variante (sin cambio de props ni handlers).
  // Branching preservado 1:1: primary/danger/ghost explícitos; el resto
  // (secondary/inline/success/otros) cae en secondary, igual que antes.
  // Nota: danger pasa de tinte suave a sólido (estándar del design system).
  const vcls = {primary:'my-btn--primary',danger:'my-btn--danger',ghost:'my-btn--ghost'}[variant] || 'my-btn--secondary';
  return (
    <button onClick={onClick} disabled={disabled} className={`my-btn ${vcls}${small?' my-btn--sm':''}`} style={sx}>
      {children}
    </button>
  );
}
function Divider() { return <div style={{height:1,background:C.border,margin:'4px 0'}}/> }

/* ── IMAGE UPLOADER ── */
async function _compressImg(file) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const MAX = 900;
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else { w = Math.round(w * MAX / h); h = MAX; }
      }
      const cvs = document.createElement('canvas');
      cvs.width = w; cvs.height = h;
      cvs.getContext('2d').drawImage(img, 0, 0, w, h);
      cvs.toBlob(b => resolve(b), 'image/webp', 0.82);
    };
    img.onerror = () => resolve(null);
    img.src = URL.createObjectURL(file);
  });
}
function ImageUploader({ value, onChange, compact = false, bucket = 'menu-images' }) {
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef();

  async function handleFile(file) {
    if (!['image/jpeg','image/png','image/webp'].includes(file.type)) {
      toast('Formato no permitido — usá JPG, PNG o WebP', false); return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast('Archivo demasiado grande — máximo 5 MB', false); return;
    }
    if (!db) { toast('Sin Supabase — configurá config.js', false); return; }
    setBusy(true);
    try {
      const blob = await _compressImg(file);
      if (!blob) { toast('No se pudo procesar la imagen', false); setBusy(false); return; }
      const path = `${RID}/${Date.now()}_${Math.random().toString(36).slice(2)}.webp`;
      const { error } = await db.storage.from(bucket).upload(path, blob, { contentType: 'image/webp', upsert: false });
      if (error) {
        const hint = error.message.includes('Bucket not found')
          ? `Bucket "${bucket}" no existe — ejecutá la migración ${bucket==='menu-images'?'011':'015'} en Supabase`
          : error.message;
        toast('Error al subir: ' + hint, false);
      } else {
        const { data: { publicUrl } } = db.storage.from(bucket).getPublicUrl(path);
        onChange(publicUrl);
        toast('Imagen subida correctamente');
      }
    } catch(e) { toast('Error: ' + e.message, false); }
    setBusy(false);
  }

  function onDrop(e) { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }

  if (compact) {
    return (
      <div style={{display:'flex',alignItems:'center',gap:6}}>
        {value
          ? <img src={value} alt="" style={{width:36,height:36,objectFit:'cover',borderRadius:5,flexShrink:0,border:`1px solid ${C.border}`}} onError={e=>{e.target.style.display='none';}}/>
          : <div style={{width:36,height:36,background:C.white,borderRadius:5,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,color:C.mid}}><Icon name="utensils" size={16}/></div>}
        <div style={{display:'flex',flexDirection:'column',gap:3}}>
          <button onClick={()=>ref.current.click()} disabled={busy} style={{background:'transparent',border:`1px solid ${C.border}`,color:C.mid,padding:'2px 8px',fontSize:10,fontWeight:600,borderRadius:4,cursor:'pointer',whiteSpace:'nowrap'}}>
            {busy?'Subiendo…':value?'Cambiar':'Subir foto'}
          </button>
          {value&&<button onClick={()=>onChange('')} style={{background:'transparent',border:'1px solid rgba(239,68,68,0.2)',color:'rgba(239,68,68,0.5)',padding:'2px 8px',fontSize:10,fontWeight:600,borderRadius:4,cursor:'pointer'}}>Quitar</button>}
        </div>
        <input ref={ref} type="file" accept=".jpg,.jpeg,.png,.webp" style={{display:'none'}} onClick={e=>e.stopPropagation()} onChange={e=>{if(e.target.files[0])handleFile(e.target.files[0]);e.target.value='';}}/>
      </div>
    );
  }

  if (value) {
    return (
      <div style={{position:'relative',width:'100%',height:150,borderRadius:8,overflow:'hidden',border:`1px solid ${C.border}`}}>
        <img src={value} alt="" style={{width:'100%',height:'100%',objectFit:'cover'}} onError={e=>{e.target.style.display='none';}}/>
        {busy&&<div style={{position:'absolute',inset:0,background:'rgba(0,0,0,0.75)',display:'flex',alignItems:'center',justifyContent:'center'}}><span className="spin"/></div>}
        <div style={{position:'absolute',bottom:0,left:0,right:0,background:'linear-gradient(transparent,rgba(0,0,0,0.88))',padding:'22px 10px 8px',display:'flex',gap:0}}>
          <button onClick={()=>ref.current.click()} disabled={busy} style={{flex:1,background:'rgba(255,255,255,0.12)',border:'1px solid rgba(255,255,255,0.18)',color:'#fff',padding:'5px 8px',fontSize:11,fontWeight:700,borderRadius:'5px 0 0 5px',cursor:'pointer'}}>Cambiar portada</button>
          <button onClick={()=>onChange('')} style={{background:'rgba(239,68,68,0.15)',border:'1px solid rgba(239,68,68,0.3)',borderLeft:'none',color:'#FF3B30',padding:'5px 8px',fontSize:11,fontWeight:700,borderRadius:'0 5px 5px 0',cursor:'pointer'}}>Eliminar foto</button>
        </div>
        <input ref={ref} type="file" accept=".jpg,.jpeg,.png,.webp" style={{display:'none'}} onClick={e=>e.stopPropagation()} onChange={e=>{if(e.target.files[0])handleFile(e.target.files[0]);e.target.value='';}}/>
      </div>
    );
  }

  return (
    <div
      onDragOver={e=>{e.preventDefault();setDrag(true)}}
      onDragLeave={()=>setDrag(false)}
      onDrop={onDrop}
      onClick={()=>ref.current.click()}
      style={{border:`2px dashed ${drag?'#6E6E73':'#D2D2D7'}`,borderRadius:8,padding:'26px 16px',textAlign:'center',cursor:'pointer',background:drag?'rgba(255,255,255,0.04)':'transparent',transition:'border-color .15s,background .15s',userSelect:'none'}}>
      {busy
        ? <><span className="spin"/><div style={{fontSize:12,color:C.mid,marginTop:10}}>Comprimiendo y subiendo…</div></>
        : <>
          <div style={{marginBottom:6,display:'flex',justifyContent:'center',color:C.mid}}><Icon name="upload" size={26}/></div>
          <div style={{fontSize:12,color:C.mid}}>Arrastrá una imagen o hacé clic para subir</div>
          <div style={{fontSize:10,color:C.dim,marginTop:4}}>JPG · PNG · WebP · máx 5 MB · se comprime automáticamente</div>
        </>}
      <input ref={ref} type="file" accept=".jpg,.jpeg,.png,.webp" style={{display:'none'}} onClick={e=>e.stopPropagation()} onChange={e=>{if(e.target.files[0])handleFile(e.target.files[0]);e.target.value='';}}/>
    </div>
  );
}

/* ── MÓDULO MARKETPLACE (PR-MKT-2) — factory compartida con gerente; recibe
      los primitivos UI de ESTE panel (Empty = EmptyRow acá). ── */
const MarketplacePage = createRestaurantMarketplace({
  React, db, rid: RID, C, Icon, toast, Modal, Btn, Inp, Sel, Lbl, Th, Td,
  Empty: EmptyRow, shouldPause: _shouldPause,
});

/* ── SIDEBAR ── */
const NAV = [
  {id:'dashboard', label:'Dashboard',    icon:'dashboard'},
  {id:'pedidos',   label:'Pedidos',      icon:'menu'},
  {id:'paneles',   label:'Paneles',      icon:'layout'},
  null,
  {id:'delivery',  label:'Delivery',     icon:'truck', group:'DELIVERY'},
  null,
  {id:'menu',       label:'Menú',         icon:'book', group:'GESTIÓN'},
  {id:'mesas',      label:'Mesas',        icon:'table'},
  {id:'agenda',     label:'Agenda',       icon:'calendar'},
  {id:'estaciones', label:'Estaciones',   icon:'boxes'},
  {id:'personal',   label:'Personal',     icon:'users'},
  {id:'stock',      label:'Stock',        icon:'package'},
  {id:'proveedores',label:'Proveedores',  icon:'building'},
  {id:'marketplace',label:'Marketplace',  icon:'store'},
  null,
  {id:'clientes',  label:'Clientes',     icon:'user', group:'ANÁLISIS'},
  {id:'reportes',  label:'Reportes',     icon:'chart'},
  {id:'finanzas',  label:'Finanzas',     icon:'money'},
  {id:'caja',      label:'Caja',         icon:'creditCard'},
  null,
  {id:'marketing', label:'Marketing',    icon:'megaphone', group:'ACCIONES'},
  {id:'ratings',   label:'Calificaciones',icon:'star'},
  null,
  {id:'avisos',    label:'Avisos personal', icon:'bell', group:'SISTEMA'},
  {id:'soporte',   label:'Soporte',      icon:'chat'},
  {id:'config',    label:'Config',       icon:'settings'},
];

function Sidebar({page,setPage,restaurant,onToggleTheme,badges={},themeMode='light'}) {
  return (
    <aside style={{width:200,minHeight:'100vh',background:C.sidebar,borderRight:`1px solid ${C.border}`,display:'flex',flexDirection:'column',position:'sticky',top:0,height:'100vh',overflowY:'auto',flexShrink:0}}>
      <div style={{padding:'18px 16px 14px',borderBottom:`1px solid ${C.border}`,display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:8}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontFamily:'inherit',fontSize:20,fontWeight:800,letterSpacing:'-0.5px',color:C.ink}}>Mythos</div>
          <div style={{fontSize:11,color:C.mid,marginTop:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{restaurant?.name||'Restaurante'} · Admin</div>
        </div>
        <button onClick={onToggleTheme} title={themeMode==='dark'?'Cambiar a claro':'Cambiar a oscuro'}
          style={{width:28,height:28,borderRadius:'50%',background:'transparent',border:`1px solid ${C.border}`,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',color:C.ink,flexShrink:0}}>
          <Icon name={themeMode==='dark'?'sun':'moon'} size={13}/>
        </button>
      </div>
      <nav style={{padding:'6px 0',flex:1}}>
        {/* Modo delivery (mig 173): el local no atiende en salón → se oculta Mesas. */}
        {NAV.filter(n => !(n && n.id==='mesas' && restaurant?.service_mode==='delivery')).map((n,i) => {
          if (!n) return <Divider key={i}/>;
          const active = page === n.id;
          const badge = badges[n.id]||0;
          return (
            <div key={n.id}>
              {n.group && <div style={{padding:'8px 16px 3px',fontSize:9,color:C.mid,fontWeight:800,letterSpacing:'0.14em',textTransform:'uppercase'}}>{n.group}</div>}
              <button onClick={() => setPage(n.id)} style={{display:'flex',alignItems:'center',gap:10,width:'100%',padding:'9px 16px',background:active?C.ink:'none',border:'none',color:active?C.sidebar:C.ink,textAlign:'left',fontSize:13,fontWeight:active?600:500,cursor:'pointer',borderLeft:active?`2px solid ${C.ink}`:'2px solid transparent'}}>
                <span style={{width:16,textAlign:'center',flexShrink:0,display:'inline-flex',alignItems:'center',justifyContent:'center'}}><Icon name={n.icon} size={15}/></span>
                <span style={{flex:1}}>{n.label}</span>
                {badge > 0 && <span style={{background:active?C.sidebar:C.red,color:active?C.red:C.sidebar,fontSize:10,fontWeight:800,padding:'1px 6px',borderRadius:8,minWidth:16,textAlign:'center'}}>{badge}</span>}
              </button>
            </div>
          );
        })}
      </nav>
      <div style={{padding:'10px 12px',borderTop:`1px solid ${C.border}`,display:'flex',flexDirection:'column',gap:8}}>
        <button onClick={()=>setPage('paneles')} style={{display:'flex',alignItems:'center',justifyContent:'center',gap:7,background:'none',border:`1px solid ${C.border}`,color:C.ink,fontSize:12,fontWeight:600,padding:'7px 10px',borderRadius:6,cursor:'pointer',width:'100%'}}>
          <Icon name="layout" size={13}/> Ver todos los paneles
        </button>
{db && <button onClick={async()=>{try{await window.MythosPresence?.stop('manual');}catch(_){}await db.auth.signOut();window.location.replace('login.html');}} style={{background:'none',border:`1px solid ${C.border}`,color:C.dim,fontSize:11,padding:'5px 10px',borderRadius:5,width:'100%'}}>Salir</button>}
      </div>
    </aside>
  );
}

/* ── SELECTOR DE SUCURSAL (Multi-local, solo dueño) ──
   Dropdown B&W. Cambia mythos_restaurant_id y recarga la sesión para
   que el dueño audite menú/mesas/ventas de la sucursal sin re-login.
   Los roles operativos (mozo/cajero/cocina) NO lo ven → anclados. */
function SucursalSwitcher({caps}) {
  const [open,setOpen] = useState(false);
  if (!['admin','gerente','owner'].includes(MY_ROLE)) return null;
  const branches = (caps && Array.isArray(caps.branches)) ? caps.branches : [];
  if (branches.length <= 1) return null;
  const maxB    = caps.max_branches || branches.length;
  const current = branches.find(b=>b.id===RID) || branches[0];
  const switchTo = (b, locked) => {
    if (locked || b.id===RID) { setOpen(false); return; }
    localStorage.setItem('mythos_restaurant_id', b.id);
    window.location.reload();   // recarga suave: re-ejecuta hooks con el nuevo RID, sin cerrar sesión
  };
  return (
    <div style={{position:'relative',marginBottom:18}}>
      <button onClick={()=>setOpen(o=>!o)}
        style={{display:'inline-flex',alignItems:'center',gap:8,background:C.surface,border:`1px solid ${C.ink}`,color:C.ink,borderRadius:10,padding:'8px 14px',fontSize:13,fontWeight:700,cursor:'pointer'}}>
        <span style={{display:'inline-flex',alignItems:'center',gap:5}}><Icon name="pin" size={13}/> Sucursal:</span>
        <span style={{fontWeight:800}}>{current?.name||'—'}</span>
        <span style={{fontSize:10,opacity:.7,transform:open?'rotate(180deg)':'none',transition:'transform .12s'}}>▼</span>
      </button>
      {open && (
        <React.Fragment>
          <div onClick={()=>setOpen(false)} style={{position:'fixed',inset:0,zIndex:40}}/>
          <div style={{position:'absolute',top:'calc(100% + 6px)',left:0,zIndex:41,minWidth:280,background:C.surface,border:`1px solid ${C.ink}`,borderRadius:12,boxShadow:'0 14px 40px rgba(0,0,0,0.22)',overflow:'hidden'}}>
            <div style={{padding:'9px 14px',fontSize:10,fontWeight:800,letterSpacing:'.12em',textTransform:'uppercase',color:C.mid,borderBottom:`1px solid ${C.border}`}}>
              Locales de la cuenta · {maxB} habilitada{maxB!==1?'s':''}
            </div>
            {branches.map((b,i)=>{
              const locked = i >= maxB && b.id!==RID;
              const active = b.id===RID;
              return (
                <button key={b.id} onClick={()=>switchTo(b,locked)} disabled={locked}
                  title={locked?'Sucursal no incluida en tu plan — contrata el add-on Sucursal Adicional':''}
                  style={{display:'flex',alignItems:'center',gap:10,width:'100%',textAlign:'left',padding:'10px 14px',background:active?C.ink:'transparent',color:locked?C.dim:(active?C.surface:C.ink),border:'none',borderTop:i?`1px solid ${C.border}`:'none',fontSize:13,fontWeight:active?700:500,cursor:locked?'not-allowed':'pointer',opacity:locked?.6:1}}>
                  <span style={{flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                    {b.name}{b.is_root?'  ·  Casa Central':''}{b.city?`  ·  ${b.city}`:''}
                  </span>
                  {active && <span style={{fontSize:11}}>✓</span>}
                  {locked && <span style={{display:'inline-flex'}}><Icon name="lock" size={12}/></span>}
                </button>
              );
            })}
          </div>
        </React.Fragment>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════
   MÓDULO PANELES — hub de accesos + compartir por QR / link
   ──────────────────────────────────────────────
   El dueño entra acá tras contratar su plan: un botón cuadrado por panel.
   · Incluido en el plan  → al tocarlo abre un QR + link directo para pasarle
     a su personal (caja/mozo/cocina/rider); cada quien inicia sesión normal.
   · NO incluido          → candado + copy de marketing + CTA "Mejorar plan"
     que abre WhatsApp de ventas (window.SUPABASE_CONFIG.salesWhatsapp).
   Gating por caps.allowed_panels (fail-open: plan sin configurar = todo abierto).
══════════════════════════════════════════════ */
const PANEL_HUB = [
  {key:'menu-cliente',     l:'Menú Cliente (QR)', h:'index.html',           ic:'cart',    rol:'cliente',     desc:'Carta digital que escanea el cliente para pedir en el local'},
  {key:'caja',             l:'Caja',             h:'caja.html',             ic:'money',   rol:'cajero/a',    desc:'Cobros, turnos, fondo fijo y facturación'},
  {key:'mozo',             l:'Mozo',             h:'mozo.html',             ic:'coffee',  rol:'mozo/a',      desc:'Mesas, comandas y transferencia entre mozos'},
  {key:'cocina',           l:'Cocina (KDS)',     h:'cocina.html',           ic:'flame',   rol:'cocina',      desc:'Tablero de comandas y despacho por estación'},
  {key:'gerente',          l:'Gerente',          h:'gerente.html',          ic:'chart',   rol:'gerente',     desc:'Reportes, personal, proveedores y alertas'},
  {key:'delivery-cliente', l:'Delivery Cliente', h:'delivery-cliente.html', ic:'package', rol:'cliente',     desc:'App de pedidos a domicilio para tus clientes'},
  {key:'delivery-rider',   l:'Rider Delivery',   h:'delivery-rider.html',   ic:'bike',    rol:'repartidor',  desc:'Panel del repartidor en ruta'},
];

function salesWaUrl(panelLabel) {
  const num = (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.salesWhatsapp) || '595981234567';
  const msg = `Hola Mythos, quiero ampliar mi plan para incluir el panel de ${panelLabel} en mi restaurante.`;
  return `https://wa.me/${num}?text=${encodeURIComponent(msg)}`;
}

function PanelShareModal({panel, url, onClose}) {
  const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=420x420&margin=14&data=${encodeURIComponent(url)}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); toast('Link copiado al portapapeles'); }
    catch(_){ toast('No se pudo copiar — copialo manualmente', false); }
  };
  return (
    <Modal title={`Compartir — ${panel.l}`} onClose={onClose} width={420}>
      <div style={{textAlign:'center'}}>
        <div style={{fontSize:13,color:C.mid,lineHeight:1.5,marginBottom:16}}>
          Mostrá este QR a tu <strong>{panel.rol}</strong> o compartí el link. Al abrirlo entra directo al panel de <strong>{panel.l}</strong> e inicia sesión con su correo y contraseña.
        </div>
        <div style={{background:'#FFFFFF',border:`1px solid ${C.border}`,borderRadius:14,padding:14,display:'inline-block',marginBottom:16}}>
          <img src={qrImg} alt={`QR ${panel.l}`} width={220} height={220} style={{display:'block',width:220,height:220}}/>
        </div>
        <div style={{display:'flex',gap:8,marginBottom:10}}>
          <input readOnly value={url} onFocus={e=>e.target.select()}
            style={{flex:1,fontSize:12,fontFamily:"'SF Mono',ui-monospace,monospace",padding:'10px 12px',border:`1px solid ${C.border}`,borderRadius:9,background:C.bg,color:C.ink,minWidth:0}}/>
          <button onClick={copy} style={{background:C.ink,color:C.surface,border:'none',borderRadius:9,padding:'10px 14px',fontSize:12.5,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap'}}>Copiar</button>
        </div>
        <a href={url} target="_blank" rel="noopener noreferrer"
           style={{display:'block',background:'transparent',color:C.ink,border:`1px solid ${C.ink}`,borderRadius:9,padding:'10px 14px',fontSize:13,fontWeight:700,textDecoration:'none'}}>
          Abrir ahora ↗
        </a>
      </div>
    </Modal>
  );
}

/* Modal de mejora de plan: lista los planes activos, marca cuál incluye el
   panel bloqueado y ofrece el contacto de WhatsApp pre-cargado. */
const PANEL_LABEL_SHORT = {'menu-cliente':'Menú Cliente',caja:'Caja',mozo:'Mozo',cocina:'Cocina',gerente:'Gerente','delivery-cliente':'Delivery Cliente','delivery-rider':'Rider'};

function UpgradeModal({panel, onClose}) {
  const [plans, setPlans] = useState(null);
  useEffect(()=>{
    let on = true;
    if (!db) { setPlans([]); return; }
    db.from('subscription_plans').select('id,name,price_usd,billing_cycle,allowed_panels,is_active')
      .eq('is_active', true).order('price_usd', {ascending:true})
      .then(({data})=>{ if(on) setPlans(data||[]); })
      .catch(()=>{ if(on) setPlans([]); });
    return ()=>{ on = false; };
  }, []);
  const includesPanel = pl => Array.isArray(pl.allowed_panels) && pl.allowed_panels.includes(panel.key);
  const waPlan = pl => {
    const num = (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.salesWhatsapp) || '595981234567';
    const msg = `Hola Mythos, quiero mejorar mi plan${pl?` al ${pl.name}`:''} para incluir el panel de ${panel.l} en mi restaurante.`;
    return `https://wa.me/${num}?text=${encodeURIComponent(msg)}`;
  };
  return (
    <Modal title="Mejorá tu plan" onClose={onClose} width={520}>
      <div style={{fontSize:13,color:C.mid,lineHeight:1.55,marginBottom:18}}>
        El panel <strong>{panel.l}</strong> no está incluido en tu plan actual. Elegí el plan que lo incluye y escribinos para activarlo al instante.
      </div>
      {plans===null
        ? <div style={{textAlign:'center',padding:'28px 0',color:C.dim,fontSize:13}}>Cargando planes…</div>
        : plans.length===0
          ? <a href={waPlan(null)} target="_blank" rel="noopener noreferrer" style={{display:'flex',alignItems:'center',justifyContent:'center',gap:6,background:C.ink,color:C.surface,fontSize:13,fontWeight:700,padding:'12px',borderRadius:10,textDecoration:'none'}}><Icon name="phone" size={14}/> Consultar por WhatsApp</a>
          : <div style={{display:'flex',flexDirection:'column',gap:12}}>
              {plans.map(pl=>{
                const inc = includesPanel(pl);
                return (
                  <div key={pl.id} style={{border:`1px solid ${inc?C.ink:C.border}`,borderRadius:12,padding:'14px 16px',background:inc?C.bg:'transparent'}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:10,marginBottom:8}}>
                      <div style={{fontSize:16,fontWeight:800,color:C.ink}}>
                        {pl.name}
                        {inc && <span style={{fontSize:11,fontWeight:800,color:C.green,marginLeft:8}}>✓ Incluye {panel.l}</span>}
                      </div>
                      <div style={{fontSize:15,fontWeight:800,color:C.ink,whiteSpace:'nowrap'}}>₲ {Number(pl.price_usd||0).toLocaleString('es-PY')}<span style={{fontSize:11,color:C.dim,fontWeight:600}}>/{pl.billing_cycle==='yearly'?'año':'mes'}</span></div>
                    </div>
                    <div style={{display:'flex',flexWrap:'wrap',gap:6,marginBottom:12}}>
                      {(Array.isArray(pl.allowed_panels)?pl.allowed_panels:[]).map(k=>(
                        <span key={k} style={{fontSize:11,fontWeight:600,color:k===panel.key?C.ink:C.mid,border:`1px solid ${k===panel.key?C.ink:C.border}`,borderRadius:20,padding:'2px 9px'}}>{PANEL_LABEL_SHORT[k]||k}</span>
                      ))}
                    </div>
                    <a href={waPlan(pl)} target="_blank" rel="noopener noreferrer"
                       style={{display:'inline-flex',alignItems:'center',gap:6,background:inc?C.ink:'transparent',color:inc?C.surface:C.ink,border:`1px solid ${C.ink}`,fontSize:12.5,fontWeight:700,padding:'8px 14px',borderRadius:9,textDecoration:'none'}}>
                      <Icon name="phone" size={13}/> Consultar {pl.name}
                    </a>
                  </div>
                );
              })}
            </div>}
    </Modal>
  );
}

function PanelesPage({caps}) {
  const [qr, setQr] = useState(null);
  const [upgrade, setUpgrade] = useState(null);
  const allowed = caps && caps.caps && Array.isArray(caps.caps.allowed_panels) ? caps.caps.allowed_panels : null;
  // El menú QR del cliente es la función base (en TODOS los planes, incluso el más
  // bajo) → nunca se bloquea, aunque allowed_panels no lo liste.
  const ALWAYS_INCLUDED = new Set(['menu-cliente']);
  const isLocked = key => ALWAYS_INCLUDED.has(key) ? false : (allowed ? !allowed.includes(key) : false);   // fail-open
  // Strip del último segmento de la ruta (sirve igual con admin.html o ruta limpia /admin)
  const base = window.location.origin + window.location.pathname.replace(/[^/]*$/,'');
  const urlFor = p => `${base}${p.h}?r=${encodeURIComponent(RID)}`;

  return (
    <div>
      <h1 style={{fontSize:24,fontWeight:800,letterSpacing:'-0.5px',margin:'0 0 4px'}}>Paneles</h1>
      <p style={{fontSize:13,color:C.mid,margin:'0 0 22px',maxWidth:640,lineHeight:1.55}}>
        Todos los paneles de tu restaurante en un solo lugar. Tocá un panel incluido en tu plan para abrir un <strong>QR</strong> o <strong>link directo</strong> y pasárselo a tu personal — al abrirlo, cada quien inicia sesión con su correo y contraseña. Los paneles con candado no están incluidos en tu plan actual.
      </p>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(212px,1fr))',gap:14}}>
        {PANEL_HUB.map(p => {
          const lk = isLocked(p.key);
          return (
            <div key={p.key}
              onClick={()=> lk ? null : setQr(p)}
              style={{position:'relative',background:C.surface,border:`1px solid ${lk?C.border:C.ink}`,borderRadius:14,padding:'18px 16px',minHeight:160,display:'flex',flexDirection:'column',cursor:lk?'default':'pointer',filter:lk?'grayscale(1)':'none',transition:'transform .12s, box-shadow .12s'}}
              onMouseEnter={e=>{ if(!lk){ e.currentTarget.style.transform='translateY(-2px)'; e.currentTarget.style.boxShadow='0 10px 28px rgba(0,0,0,0.12)'; }}}
              onMouseLeave={e=>{ e.currentTarget.style.transform='none'; e.currentTarget.style.boxShadow='none'; }}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
                <div style={{width:42,height:42,borderRadius:11,background:lk?C.bg:C.ink,color:lk?C.dim:C.surface,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                  <Icon name={p.ic} size={20}/>
                </div>
                {lk
                  ? <span style={{display:'inline-flex',alignItems:'center',gap:4,fontSize:10,fontWeight:800,color:C.dim,border:`1px solid ${C.border}`,borderRadius:20,padding:'3px 9px',textTransform:'uppercase',letterSpacing:'0.4px'}}><Icon name="lock" size={11}/>Bloqueado</span>
                  : <span style={{fontSize:20,color:C.dim,fontWeight:300}}>›</span>}
              </div>
              <div style={{fontSize:16,fontWeight:800,color:C.ink,marginBottom:5}}>{p.l}</div>
              {lk
                ? <React.Fragment>
                    <div style={{fontSize:12,color:C.mid,lineHeight:1.45,flex:1,marginBottom:12}}>No tenés acceso a este panel. Mejorá tu plan e inclúyelo para potenciar tu operación.</div>
                    <button onClick={e=>{ e.stopPropagation(); setUpgrade(p); }}
                       style={{display:'inline-flex',alignItems:'center',justifyContent:'center',gap:6,background:C.ink,color:C.surface,border:'none',fontSize:12.5,fontWeight:700,padding:'9px 12px',borderRadius:9,cursor:'pointer',width:'100%'}}>
                      <Icon name="unlock" size={13}/> Ver planes y mejorar
                    </button>
                  </React.Fragment>
                : <React.Fragment>
                    <div style={{fontSize:12,color:C.mid,lineHeight:1.45,flex:1,marginBottom:12}}>{p.desc}</div>
                    <div style={{display:'inline-flex',alignItems:'center',gap:6,fontSize:12.5,fontWeight:700,color:C.ink}}>
                      <Icon name="layout" size={13}/> Compartir / Abrir
                    </div>
                  </React.Fragment>}
            </div>
          );
        })}
      </div>

      {qr && <PanelShareModal panel={qr} url={urlFor(qr)} onClose={()=>setQr(null)}/>}
      {upgrade && <UpgradeModal panel={upgrade} onClose={()=>setUpgrade(null)}/>}
    </div>
  );
}

/* ══════════════════════════════════════════════
   GRÁFICOS DIDÁCTICOS — SVG/CSS puro (sin librerías)
══════════════════════════════════════════════ */
const Donut = ({data, size=150, thickness=22, centerLabel, centerSub}) => {
  const total = data.reduce((s,d)=>s+(d.value||0),0)||1;
  const r=(size-thickness)/2, cx=size/2, cy=size/2, circ=2*Math.PI*r;
  let off=0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={C.border} strokeWidth={thickness} opacity={.3}/>
      {data.map((d,i)=>{ const len=(d.value/total)*circ;
        const seg=<circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={d.color} strokeWidth={thickness}
          strokeDasharray={`${len} ${circ-len}`} strokeDashoffset={-off} transform={`rotate(-90 ${cx} ${cy})`}/>;
        off+=len; return seg; })}
      {centerLabel!=null && <text x={cx} y={cy-1} textAnchor="middle" fontSize="18" fontWeight="800" fill={C.ink}>{centerLabel}</text>}
      {centerSub && <text x={cx} y={cy+15} textAnchor="middle" fontSize="10" fill={C.mid}>{centerSub}</text>}
    </svg>
  );
};

const TrendArea = ({points, height=130, color}) => {
  const col = color || C.blue;
  const n=points.length;
  if(!n) return <div style={{height,display:'flex',alignItems:'center',justifyContent:'center',color:C.dim,fontSize:12}}>Sin datos</div>;
  const W=320,H=100,pad=6;
  const max=Math.max(...points.map(p=>p.value),1);
  const xs=i=> n<=1?W/2:pad+i*(W-2*pad)/(n-1);
  const ys=v=> H-pad-(v/max)*(H-2*pad);
  const line=points.map((p,i)=>`${xs(i).toFixed(1)},${ys(p.value).toFixed(1)}`).join(' ');
  const area=`${pad.toFixed(1)},${(H-pad).toFixed(1)} ${line} ${(W-pad).toFixed(1)},${(H-pad).toFixed(1)}`;
  const peak=points.reduce((m,p,i)=> p.value>points[m].value?i:m,0);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{width:'100%',height,display:'block'}}>
        {[.25,.5,.75].map(g=><line key={g} x1={pad} x2={W-pad} y1={H-pad-g*(H-2*pad)} y2={H-pad-g*(H-2*pad)} stroke={C.border} strokeWidth={1} opacity={.5} vectorEffect="non-scaling-stroke"/>)}
        <polygon points={area} fill={col} opacity={.12}/>
        <polyline points={line} fill="none" stroke={col} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
      </svg>
      <div style={{display:'flex',justifyContent:'space-between',marginTop:5}}>
        {points.map((p,i)=>(
          <span key={i} style={{flex:1,textAlign:'center',fontSize:9,color:i===peak?C.ink:C.dim,fontWeight:i===peak?700:400,whiteSpace:'nowrap'}}>{p.label}</span>
        ))}
      </div>
    </div>
  );
};

/* ══════════════════════════════════════════════
   DASHBOARD
══════════════════════════════════════════════ */
function DashboardPage({orders, ratings, setPage}) {
  const [todayItems, setTodayItems] = useState([]);
  const [stockAlerts, setStockAlerts] = useState([]);
  const [lowStock, setLowStock]       = useState([]);
  const [pendingInvoices, setPendingInvoices] = useState([]);
  const [todaySuppliers, setTodaySuppliers]   = useState([]);
  const [subscription, setSubscription]       = useState(undefined); // undefined=cargando · null=sin dato · obj=ok
  const [supplierSpend, setSupplierSpend]     = useState(null);      // null=cargando · []=sin compras
  const [acctStatus, setAcctStatus]           = useState(null);      // estado de cuenta (mig 150) · null=sin dato/error
  const now = new Date();
  const todayStr = now.toDateString();
  const ayer = new Date(now); ayer.setDate(ayer.getDate()-1);
  const ayerStr = ayer.toDateString();
  const nowHour = now.getHours();

  const valid = o => !['draft','cancelled'].includes(o.status);
  const todayOrds = orders.filter(o => new Date(o.created_at).toDateString()===todayStr && valid(o));
  const ayerOrds  = orders.filter(o => new Date(o.created_at).toDateString()===ayerStr  && valid(o));

  // PR-16: "Ventas hoy" = solo operaciones realmente cobradas (payment_status='paid'),
  // nunca pendientes/en curso. "Pedidos hoy" sigue contando todos los pedidos válidos.
  const isPaid = o => o.payment_status==='paid';
  const ventasHoy  = todayOrds.filter(isPaid).reduce((s,o)=>s+(o.total||0),0);
  const ventasAyer = ayerOrds.filter(isPaid).reduce((s,o)=>s+(o.total||0),0);
  const pedidosHoy  = todayOrds.length;
  const pedidosAyer = ayerOrds.length;
  const cobradosHoy  = todayOrds.filter(isPaid).length;
  const cobradosAyer = ayerOrds.filter(isPaid).length;
  const ticketHoy   = cobradosHoy  ? Math.round(ventasHoy/cobradosHoy)   : 0;
  const ticketAyer  = cobradosAyer ? Math.round(ventasAyer/cobradosAyer) : 0;

  const mesaCount = {}; todayOrds.forEach(o=>{if(o.table_number)mesaCount[o.table_number]=(mesaCount[o.table_number]||0)+1;});
  const mesaActiva = Object.entries(mesaCount).sort((a,b)=>b[1]-a[1])[0];
  const mesaCountAyer = {}; ayerOrds.forEach(o=>{if(o.table_number)mesaCountAyer[o.table_number]=(mesaCountAyer[o.table_number]||0)+1;});
  const mesaActivaAyer = Object.entries(mesaCountAyer).sort((a,b)=>b[1]-a[1])[0];

  // Pedidos activos ahora (en cocina / listos / cobrados en proceso)
  const activeStatuses = ['confirmed','paid','kitchen_received','cooking','ready'];
  const activosAhora = orders.filter(o=>activeStatuses.includes(o.status));
  const activosCocina = activosAhora.filter(o=>['paid','kitchen_received','cooking'].includes(o.status)).length;
  const activosListos = activosAhora.filter(o=>o.status==='ready').length;

  // Rating promedio últimos 7 días
  const hace7d = new Date(); hace7d.setDate(hace7d.getDate()-7);
  const ratings7d = (ratings||[]).filter(r=>new Date(r.created_at)>=hace7d);
  const ratingProm = ratings7d.length ? (ratings7d.reduce((s,r)=>s+(r.stars||0),0)/ratings7d.length).toFixed(1) : null;

  // Métodos de pago hoy
  const pagoHoy = {};
  // Bug-06: "Cobros hoy" = sólo dinero realmente cobrado (payment_status='paid'),
  // no pedidos con método elegido pero aún sin pagar.
  todayOrds.forEach(o=>{ if(o.payment_method && o.payment_status==='paid'){ pagoHoy[o.payment_method]=(pagoHoy[o.payment_method]||0)+(o.total||0); }});
  const pagosOrdenados = Object.entries(pagoHoy).sort((a,b)=>b[1]-a[1]);

  const pctDelta = (hoy,ayer) => (ayer>0 ? Math.round((hoy-ayer)/ayer*100) : null);
  const Delta = ({val,ayer}) => {
    const pct = pctDelta(val,ayer);
    if(pct===null) return <span style={{fontSize:11,color:C.dim}}>sin datos ayer</span>;
    const up = pct>=0;
    return <span style={{fontSize:11,fontWeight:700,color:up?'#34C759':'#FF3B30'}}>{up?'↑':'↓'} {Math.abs(pct)}% vs ayer</span>;
  };

  // Gráfico por hora — de 6am a hora actual
  const hourlyRev = Array(24).fill(0);
  todayOrds.forEach(o=>{ hourlyRev[new Date(o.created_at).getHours()]+=(o.total||0); });
  const startH = 6; const endH = Math.max(nowHour, startH);
  const hourSlice = hourlyRev.slice(startH, endH+1);
  const maxHourRev = Math.max(...hourSlice, 1);

  // Top 5 productos
  const prodTotals = {};
  todayItems.forEach(it=>{
    const k = it.item_name||'—';
    if(!prodTotals[k]) prodTotals[k]={name:k,qty:0,total:0};
    prodTotals[k].qty+=(it.quantity||1); prodTotals[k].total+=(it.total_price||0);
  });
  const top5 = Object.values(prodTotals).sort((a,b)=>b.qty-a.qty).slice(0,5);

  // Tendencia de ventas — últimos 14 días (gráfico de área)
  const DAYS = 14;
  const dayBuckets = [];
  const dayIndex = {};
  for (let i=DAYS-1;i>=0;i--){
    const d=new Date(now); d.setDate(d.getDate()-i); d.setHours(0,0,0,0);
    const key=d.toDateString();
    dayIndex[key]=dayBuckets.length;
    dayBuckets.push({key, label:d.toLocaleDateString('es-PY',{day:'numeric'}), value:0, orders:0});
  }
  orders.forEach(o=>{ if(!valid(o))return; const k=new Date(o.created_at).toDateString(); const idx=dayIndex[k]; if(idx!=null){ dayBuckets[idx].value+=(o.total||0); dayBuckets[idx].orders++; } });
  const venta14 = dayBuckets.reduce((s,b)=>s+b.value,0);
  const promDia = Math.round(venta14/DAYS);

  // Métodos de pago — últimos 14 días (dona)
  const payAgg = {};
  orders.forEach(o=>{ if(!valid(o))return; const k=new Date(o.created_at).toDateString(); if(dayIndex[k]!=null && o.payment_method && o.payment_status==='paid'){ payAgg[o.payment_method]=(payAgg[o.payment_method]||0)+(o.total||0); } });
  const PAY_COLORS = {efectivo:'#34C759',tarjeta:'#007AFF',qr:'#5856D6',pos:'#FF9500'};
  const FALLBACK_COLORS = ['#1D1D1F','#6E6E73','#86868B','#FF3B30'];
  const payDonut = Object.entries(payAgg).sort((a,b)=>b[1]-a[1]).map(([m,v],i)=>({label:PL[m]||m,value:v,color:PAY_COLORS[m]||FALLBACK_COLORS[i%FALLBACK_COLORS.length]}));
  const payTotal = payDonut.reduce((s,d)=>s+d.value,0);

  useEffect(()=>{
    if(!db||!todayOrds.length) return;
    const ids = todayOrds.map(o=>o.id).slice(0,150);
    db.from('order_items').select('order_id,item_name,quantity,total_price').in('order_id',ids)
      .then(({data})=>setTodayItems(data||[]));
  },[orders]);

  useEffect(()=>{
    if(!db) return;
    const DAY_NAMES = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
    const DAY_SHORT = ['dom','lun','mar','mié','jue','vie','sáb'];
    const todayIdx = now.getDay();
    Promise.all([
      db.from('stock_alerts').select('id,alert_type,ingredient:ingredients(name,unit,stock_quantity)').eq('restaurant_id',RID).is('resolved_at',null).order('created_at',{ascending:false}).limit(20),
      db.from('ingredients').select('id,name,unit,stock_quantity,min_threshold').eq('restaurant_id',RID).eq('is_active',true).gt('min_threshold',0),
      db.from('supplier_purchases').select('id,total,paid_amount,status,supplier:suppliers(name)').eq('restaurant_id',RID).eq('status','pendiente').order('purchase_date',{ascending:true}).limit(20),
      db.from('suppliers').select('id,name,delivery_days,phone').eq('restaurant_id',RID).eq('is_active',true),
    ]).then(([alertsRes, ingsRes, invoicesRes, suppliersRes]) => {
      setStockAlerts(alertsRes.data||[]);
      setLowStock((ingsRes.data||[]).filter(i => Number(i.stock_quantity||0) <= Number(i.min_threshold||0)));
      setPendingInvoices(invoicesRes.data||[]);
      const todayName = DAY_NAMES[todayIdx];
      const todayShort = DAY_SHORT[todayIdx];
      setTodaySuppliers((suppliersRes.data||[]).filter(s => {
        const dd = (s.delivery_days||'').toLowerCase();
        return dd.includes(todayName) || dd.includes(todayShort);
      }));
    });
  },[]);

  // PR-C: suscripción del restaurante (RPC tenant-safe — el rol admin no puede
  // leer `subscriptions` directo por RLS, mig 103) + gasto de proveedores del mes.
  useEffect(()=>{
    if(!db) return;
    const d0 = new Date();
    const monthStart = new Date(d0.getFullYear(), d0.getMonth(), 1).toLocaleDateString('en-CA');
    db.rpc('get_my_subscription',{p_restaurant_id:RID}).then(({data,error})=>{
      setSubscription(error ? null : (data||null));
    });
    // Estado de cuenta (mantenimiento / suspensión / vencimiento) — mig 150.
    // Fail-open: ante error/RPC ausente, acctStatus queda null y no muestra nada.
    db.rpc('get_my_account_status',{p_restaurant_id:RID}).then(({data,error})=>{
      setAcctStatus(error ? null : (data||null));
    }).catch(()=>setAcctStatus(null));
    db.from('supplier_purchases')
      .select('total,paid_amount,status,purchase_date,supplier_name,supplier:suppliers(name)')
      .eq('restaurant_id',RID).gte('purchase_date',monthStart).neq('status','anulada')
      .then(({data,error})=>setSupplierSpend(error ? [] : (data||[])));
  },[]);


  return (
    <div className="page">
      <div style={{marginBottom:20}}>
        <h1 style={{fontSize:24,fontWeight:800,color:C.ink,letterSpacing:'-0.5px'}}>Dashboard</h1>
        <div style={{fontSize:13,color:C.mid,marginTop:3}}>{now.toLocaleDateString('es-PY',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}</div>
      </div>

      {/* Fila 1 — 4 KPIs principales */}
      {/* PR-B3B-FIX: KPI cards inline tinteadas → .my-metric-card neutro (Opción A).
          Se quitan los tintes/hex hardcodeados (dark-ready). Se conservan icono,
          Delta, sub y onClick. El valor pasa a var(--text-primary) (token). */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:12}}>
        <div className="my-metric-card" style={{cursor:'pointer'}} onClick={()=>setPage('pedidos')}>
          <div className="my-metric-card__label" style={{display:'flex',alignItems:'center',gap:6}}><Icon name="money" size={13}/> Ventas hoy</div>
          <div style={{fontSize:28,fontWeight:800,color:'var(--text-primary)',lineHeight:1,letterSpacing:'-0.5px'}}>{fmt(ventasHoy)}</div>
          <div style={{marginTop:6}}><Delta val={ventasHoy} ayer={ventasAyer}/></div>
        </div>
        <div className="my-metric-card" style={{cursor:'pointer'}} onClick={()=>setPage('pedidos')}>
          <div className="my-metric-card__label" style={{display:'flex',alignItems:'center',gap:6}}><Icon name="package" size={13}/> Pedidos hoy</div>
          <div style={{fontSize:28,fontWeight:800,color:'var(--text-primary)',lineHeight:1,letterSpacing:'-0.5px'}}>{pedidosHoy}</div>
          <div style={{marginTop:6}}><Delta val={pedidosHoy} ayer={pedidosAyer}/></div>
        </div>
        <div className="my-metric-card">
          <div className="my-metric-card__label" style={{display:'flex',alignItems:'center',gap:6}}><Icon name="receipt" size={13}/> Ticket promedio</div>
          <div style={{fontSize:28,fontWeight:800,color:'var(--text-primary)',lineHeight:1,letterSpacing:'-0.5px'}}>{cobradosHoy>0?fmt(ticketHoy):'—'}</div>
          <div style={{marginTop:6}}>{ticketAyer>0?<Delta val={ticketHoy} ayer={ticketAyer}/>:<span style={{fontSize:11,color:C.mid}}>sin datos ayer</span>}</div>
        </div>
        <div className="my-metric-card">
          <div className="my-metric-card__label" style={{display:'flex',alignItems:'center',gap:6}}><Icon name="flame" size={13}/> Mesa más activa</div>
          <div style={{fontSize:28,fontWeight:800,color:'var(--text-primary)',lineHeight:1,letterSpacing:'-0.5px'}}>{mesaActiva?`Mesa ${mesaActiva[0]}`:'—'}</div>
          <div style={{marginTop:6,fontSize:11,color:C.mid}}>{mesaActiva?`${mesaActiva[1]} pedidos hoy`:mesaActivaAyer?`ayer: Mesa ${mesaActivaAyer[0]}`:''}</div>
        </div>
      </div>

      {/* Fila 2 — Estado en tiempo real + Rating + Métodos de pago */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:20}}>
        {/* Activos en cocina — PR-B3B-FIX: .my-metric-card; alerta por borde token */}
        <div className="my-metric-card" style={{cursor:'pointer',...(activosCocina>0?{borderColor:'var(--warning)'}:null)}} onClick={()=>setPage('pedidos')}>
          <div className="my-metric-card__label">En cocina ahora</div>
          <div style={{fontSize:32,fontWeight:800,color:activosCocina>0?'var(--warning)':'var(--text-primary)',lineHeight:1,letterSpacing:'-0.5px'}}>{activosCocina}</div>
          <div style={{marginTop:5,fontSize:11,color:C.mid}}>{activosCocina===1?'pedido preparándose':'pedidos preparándose'}</div>
        </div>
        {/* Listos para entregar */}
        <div className="my-metric-card" style={{cursor:'pointer',...(activosListos>0?{borderColor:'var(--success)'}:null)}} onClick={()=>setPage('pedidos')}>
          <div className="my-metric-card__label">Listos para entregar</div>
          <div style={{fontSize:32,fontWeight:800,color:activosListos>0?'var(--success)':'var(--text-primary)',lineHeight:1,letterSpacing:'-0.5px'}}>{activosListos}</div>
          <div style={{marginTop:5,fontSize:11,color:C.mid}}>{activosListos===1?'pedido esperando':'pedidos esperando'}</div>
        </div>
        {/* Rating 7 días */}
        <div className="my-metric-card" style={{cursor:'pointer'}} onClick={()=>setPage('ratings')}>
          <div className="my-metric-card__label">Rating últimos 7 días</div>
          <div style={{fontSize:32,fontWeight:800,color:'var(--text-primary)',lineHeight:1,letterSpacing:'-0.5px',display:'inline-flex',alignItems:'center',gap:6}}>{ratingProm||'—'} {ratingProm&&<Icon name="star" size={20} style={{color:'var(--warning)'}}/>}</div>
          <div style={{marginTop:5,fontSize:11,color:C.mid}}>{ratings7d.length} calificaciones</div>
        </div>
        {/* Métodos de pago hoy */}
        <div className="my-metric-card">
          <div className="my-metric-card__label">Cobros hoy por método</div>
          {pagosOrdenados.length===0
            ?<div style={{fontSize:12,color:C.dim,paddingTop:4}}>Sin datos de pago</div>
            :pagosOrdenados.map(([met,total])=>(
              <div key={met} style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                <span style={{fontSize:12,color:C.mid,textTransform:'capitalize'}}>{PL[met]||met}</span>
                <span style={{fontSize:12,fontWeight:700,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.ink}}>{fmt(total)}</span>
              </div>
            ))
          }
        </div>
      </div>

      {/* Gráfico barras por hora + Top 5 */}
      <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:14,marginBottom:20}}>
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:16,boxShadow:C.shadow,padding:20}}>
          <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:16}}>VENTAS POR HORA — HOY ({startH}hs al momento)</div>
          <div style={{display:'flex',alignItems:'flex-end',gap:3,height:100}}>
            {hourSlice.map((rev,i)=>{
              const h = startH+i;
              const isNow = h===nowHour;
              const barH = rev>0?Math.max(Math.round((rev/maxHourRev)*88),4):0;
              const pct = maxHourRev>0?rev/maxHourRev:0;
              const barColor = isNow?'#007AFF':pct>0.75?'#34C759':pct>0.4?'#FF9500':pct>0?'#A8C8FF':'#EFEFEF';
              return (
                <div key={h} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:2}}>
                  {rev>0?<div style={{fontSize:8,color:C.dim,fontFamily:"'SF Mono',ui-monospace,monospace",textAlign:'center',whiteSpace:'nowrap'}}>{fmtK(rev)}</div>
                        :<div style={{height:12}}/>}
                  <div style={{width:'100%',height:`${barH}px`,background:barColor,borderRadius:'3px 3px 0 0',transition:'height .3s'}}/>
                  <div style={{fontSize:8,color:isNow?'#007AFF':'#6E6E73',fontWeight:isNow?700:400,whiteSpace:'nowrap'}}>{h}hs</div>
                </div>
              );
            })}
          </div>
          <div style={{display:'flex',gap:10,marginTop:10,flexWrap:'wrap'}}>
            {[['#34C759','Alto'],['#FF9500','Medio'],['#A8C8FF','Bajo'],['#007AFF','Ahora']].map(([c,l])=>(
              <div key={l} style={{display:'flex',alignItems:'center',gap:4,fontSize:9,color:C.dim}}>
                <div style={{width:8,height:8,borderRadius:2,background:c}}/>
                {l}
              </div>
            ))}
          </div>
        </div>
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:16,boxShadow:C.shadow,padding:20}}>
          <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:14}}>TOP 5 PRODUCTOS — HOY</div>
          {top5.length===0
            ?<div style={{color:C.dim,fontSize:12,textAlign:'center',paddingTop:20}}>Sin ventas hoy</div>
            :top5.map((p,i)=>{
              const rankBg = i===0?'#FFD700':i===1?'#C0C0C0':i===2?'#CD7F32':'#E5E5EA';
              const rankColor = i<3?'#fff':'#6E6E73';
              return (
                <div key={i} style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}>
                  <div style={{width:22,height:22,borderRadius:'50%',background:rankBg,color:rankColor,fontSize:11,fontWeight:800,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>{i+1}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:12,fontWeight:600,color:C.ink,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.name}</div>
                    <div style={{fontSize:10,color:C.dim}}>{fmt(p.total)}</div>
                  </div>
                  <div style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:18,fontWeight:800,color:i===0?'#FF9500':C.ink,marginLeft:4}}>{p.qty}</div>
                </div>
              );
            })
          }
        </div>
      </div>

      {/* Analítica — tendencia 14 días + métodos de pago */}
      <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:14,marginBottom:20}}>
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:16,boxShadow:C.shadow,padding:20}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:14,flexWrap:'wrap',gap:8}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1}}>TENDENCIA DE VENTAS — ÚLTIMOS 14 DÍAS</div>
            <div style={{fontSize:11,color:C.dim}}>Total <strong style={{color:C.ink}}>{fmt(venta14)}</strong> · prom/día <strong style={{color:C.ink}}>{fmt(promDia)}</strong></div>
          </div>
          <TrendArea points={dayBuckets} color={C.blue}/>
        </div>
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:16,boxShadow:C.shadow,padding:20}}>
          <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:14}}>MÉTODOS DE PAGO — 14 DÍAS</div>
          {payTotal===0
            ? <div style={{color:C.dim,fontSize:12,textAlign:'center',paddingTop:30}}>Sin cobros registrados</div>
            : <div style={{display:'flex',flexDirection:'column',alignItems:'center'}}>
                <Donut data={payDonut} centerLabel={fmtK(payTotal)} centerSub="total ₲"/>
                <div style={{marginTop:14,width:'100%'}}>
                  {payDonut.map((d,i)=>(
                    <div key={i} style={{display:'flex',alignItems:'center',gap:8,fontSize:11,marginBottom:6}}>
                      <span style={{width:9,height:9,borderRadius:'50%',background:d.color,flexShrink:0}}/>
                      <span style={{flex:1,color:C.mid}}>{d.label}</span>
                      <span style={{color:C.ink,fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:600}}>{Math.round(d.value/payTotal*100)}%</span>
                    </div>
                  ))}
                </div>
              </div>
          }
        </div>
      </div>

      {/* Panel de alertas importantes */}
      {(()=>{
        const allAlerts = [];

        // Estado de cuenta (mig 150) — mantenimiento / suspensión / vencimiento.
        // Se reflejan acá además del banner/bloqueo del auth-guard.
        if (acctStatus && typeof acctStatus === 'object') {
          if (acctStatus.suspended === true) {
            allAlerts.push({
              key: 'acct-suspended',
              level: 'critical',
              icon: 'alert',
              title: 'Cuenta suspendida',
              sub: 'El acceso está pausado. Contactá a MYTHOS para reactivar tu cuenta.',
            });
          }
          if (acctStatus.maintenance_mode === true) {
            allAlerts.push({
              key: 'acct-maint',
              level: 'warning',
              icon: 'alert',
              title: 'Modo mantenimiento activo',
              sub: (acctStatus.maintenance_message && String(acctStatus.maintenance_message).trim())
                ? String(acctStatus.maintenance_message).trim()
                : 'El local no recibe pedidos de clientes (QR/delivery) mientras esté activo.',
            });
          }
          if (acctStatus.expired === true) {
            const end = acctStatus.subscription_end_date;
            const endTxt = end ? new Date(end+'T00:00:00').toLocaleDateString('es-PY',{day:'numeric',month:'long',year:'numeric'}) : '';
            allAlerts.push({
              key: 'acct-expired',
              level: 'warning',
              icon: 'money',
              title: 'Suscripción vencida',
              sub: (endTxt ? `Venció el ${endTxt}. ` : '') + 'Regularizá el pago para no perder el servicio.',
            });
          }
        }

        // Stock crítico (desde stock_alerts)
        stockAlerts.slice(0,5).forEach(a => {
          const ing = a.ingredient;
          allAlerts.push({
            key: 'alert-'+a.id,
            level: 'critical',
            icon: 'alert',
            title: ing ? `Stock crítico: ${ing.name}` : 'Alerta de stock',
            sub: ing ? `${Number(ing.stock_quantity||0).toFixed(1)} ${ing.unit||''} en inventario` : (a.notes||''),
            action: ()=>setPage('stock'),
            actionLabel: 'Ver stock →',
          });
        });

        // Ingredientes con stock bajo (no duplicar los ya en alertas)
        const alertIngNames = new Set(stockAlerts.map(a=>a.ingredient?.name));
        lowStock.filter(i=>!alertIngNames.has(i.name)).slice(0,5).forEach(i => {
          allAlerts.push({
            key: 'low-'+i.id,
            level: 'warning',
            icon: 'alert',
            title: `Stock bajo: ${i.name}`,
            sub: `${Number(i.stock_quantity||0).toFixed(1)} ${i.unit||''} (mínimo: ${Number(i.min_threshold||0).toFixed(1)})`,
            action: ()=>setPage('stock'),
            actionLabel: 'Ver stock →',
          });
        });

        // Entregas de proveedores hoy
        todaySuppliers.forEach(s => {
          allAlerts.push({
            key: 'sup-'+s.id,
            level: 'info',
            icon: 'package',
            title: `Entrega hoy: ${s.name}`,
            sub: s.phone ? `Tel: ${s.phone}` : 'Proveedor activo',
            action: ()=>setPage('proveedores'),
            actionLabel: 'Ver proveedor →',
          });
        });

        // Facturas pendientes de pago
        pendingInvoices.slice(0,5).forEach(inv => {
          const deuda = Number(inv.total||0) - Number(inv.paid_amount||0);
          allAlerts.push({
            key: 'inv-'+inv.id,
            level: 'warning',
            icon: 'money',
            title: `Factura pendiente: ${inv.supplier?.name||'Proveedor'}`,
            sub: `Saldo: ${fmt(deuda)}`,
            action: ()=>setPage('proveedores'),
            actionLabel: 'Ver compras →',
          });
        });

        const levelStyle = {
          critical: {bg:TINT.redBg, border:TINT.redBorder, left:C.red, titleColor:TINT.redText},
          warning:  {bg:TINT.amberBg, border:TINT.amberBorder, left:C.orange, titleColor:TINT.amberText},
          info:     {bg:TINT.blueBg, border:TINT.blueBorder, left:C.blue, titleColor:TINT.blueText},
        };

        return (
          <div style={{background:C.surface, border:`1px solid ${C.border}`, borderRadius:16, boxShadow:C.shadow, overflow:'hidden'}}>
            <div style={{padding:'12px 16px', borderBottom:`1px solid ${C.border}`, fontSize:10, fontWeight:700, color:C.mid, letterSpacing:1, display:'flex', justifyContent:'space-between', alignItems:'center'}}>
              ALERTAS Y NOTIFICACIONES
              <span style={{fontSize:11, color:C.dim}}>{allAlerts.length} {allAlerts.length===1?'alerta':'alertas'}</span>
            </div>
            {allAlerts.length === 0
              ? <div style={{padding:'28px 16px', textAlign:'center', color:C.dim, fontSize:13}}>
                  <div style={{marginBottom:8,display:'flex',justifyContent:'center',color:C.green}}><Icon name="checkCircle" size={28}/></div>
                  Todo en orden — sin alertas pendientes
                </div>
              : <div style={{display:'flex', flexDirection:'column', gap:0}}>
                  {allAlerts.map((a,idx) => {
                    const s = levelStyle[a.level]||levelStyle.info;
                    return (
                      <div key={a.key} style={{display:'flex', alignItems:'center', gap:12, padding:'10px 16px', borderBottom: idx<allAlerts.length-1?`1px solid ${C.border}`:'none', background: s.bg, borderLeft:`4px solid ${s.left}`}}>
                        <div style={{flexShrink:0, color:s.left, display:'flex'}}><Icon name={a.icon} size={20}/></div>
                        <div style={{flex:1, minWidth:0}}>
                          <div style={{fontSize:13, fontWeight:700, color: s.titleColor, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{a.title}</div>
                          <div style={{fontSize:11, color:C.mid, marginTop:1}}>{a.sub}</div>
                        </div>
                        {a.actionLabel && <button onClick={a.action} style={{background:'none', border:`1px solid ${s.left}`, color: s.left, fontSize:11, fontWeight:600, padding:'5px 10px', borderRadius:6, cursor:'pointer', flexShrink:0, whiteSpace:'nowrap'}}>{a.actionLabel}</button>}
                      </div>
                    );
                  })}
                </div>
            }
          </div>
        );
      })()}

      {/* ── PR-C · 3 tarjetas: alerta de stock · suscripción · gastos de proveedores ── */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:14,marginTop:20}}>

        {/* 1 · ALERTA DE STOCK (ítems bajo umbral mínimo) */}
        {(()=>{
          const items = stockAlerts.map(a=>({
            name: a.ingredient?.name || 'Ingrediente',
            detail: a.ingredient ? `${Number(a.ingredient.stock_quantity||0).toFixed(1)} ${a.ingredient.unit||''}`.trim() : '',
            crit: a.alert_type==='critical_stock' || a.alert_type==='expired',
          }));
          const seen = new Set(stockAlerts.map(a=>a.ingredient?.name));
          lowStock.filter(i=>!seen.has(i.name)).forEach(i=>items.push({
            name:i.name,
            detail:`${Number(i.stock_quantity||0).toFixed(1)} ${i.unit||''} · mín ${Number(i.min_threshold||0).toFixed(1)}`,
            crit:false,
          }));
          const n = items.length;
          return (
            <div style={{background:C.surface,border:`1px solid ${n>0?C.orange:C.border}`,borderRadius:16,boxShadow:C.shadow,padding:20}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
                <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1}}>ALERTA DE STOCK</div>
                <Icon name="alert" size={16} style={{color:n>0?C.orange:C.dim}}/>
              </div>
              {n===0
                ? <div style={{display:'flex',alignItems:'center',gap:8,color:C.green,fontSize:14,padding:'8px 0'}}><Icon name="checkCircle" size={18}/> Stock OK</div>
                : <>
                    <div style={{fontSize:28,fontWeight:800,color:C.orange,lineHeight:1,marginBottom:12}}>{n} <span style={{fontSize:13,fontWeight:600,color:C.mid}}>{n===1?'ítem en alerta':'ítems en alerta'}</span></div>
                    {items.slice(0,4).map((it,i)=>(
                      <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8,marginBottom:6}}>
                        <span style={{fontSize:13,color:C.ink,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',display:'flex',alignItems:'center',gap:6,minWidth:0}}>
                          <span style={{width:6,height:6,borderRadius:'50%',background:it.crit?C.red:C.orange,flexShrink:0}}/>{it.name}
                        </span>
                        <span style={{fontSize:12,color:C.mid,fontFamily:"'SF Mono',ui-monospace,monospace",flexShrink:0}}>{it.detail}</span>
                      </div>
                    ))}
                    {n>4 && <div style={{fontSize:12,color:C.dim,marginTop:2}}>+{n-4} más</div>}
                    <button onClick={()=>setPage('stock')} style={{marginTop:12,background:'none',border:`1px solid ${C.orange}`,color:C.orange,fontSize:12,fontWeight:600,padding:'6px 11px',borderRadius:6,cursor:'pointer'}}>Ver stock →</button>
                  </>
              }
            </div>
          );
        })()}

        {/* 2 · ESTADO DE SUSCRIPCIÓN (del restaurante logueado) */}
        {(()=>{
          const s = subscription; // undefined=cargando · null=sin dato · obj=ok
          const head = (
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
              <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1}}>ESTADO DE SUSCRIPCIÓN</div>
              <Icon name="receipt" size={16} style={{color:C.dim}}/>
            </div>
          );
          if(s===undefined) return <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:16,boxShadow:C.shadow,padding:20}}>{head}<div style={{color:C.dim,fontSize:14,padding:'8px 0'}}>Cargando…</div></div>;
          if(!s) return <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:16,boxShadow:C.shadow,padding:20}}>{head}<div style={{color:C.dim,fontSize:14,padding:'8px 0'}}>Sin suscripción activa registrada</div></div>;
          const days = s.days_remaining==null ? null : Number(s.days_remaining);
          const expired = s.status==='expired' || (days!=null && days<0);
          const soon = days!=null && days>=0 && days<=7;
          const fg = expired ? C.red : soon ? C.orange : C.green;
          const bg = expired ? TINT.redBg : soon ? TINT.amberBg : TINT.greenBg;
          const bd = expired ? TINT.redBorder : soon ? TINT.amberBorder : TINT.greenBorder;
          const STL = {active:'Activa',trial:'Prueba',expired:'Vencida',cancelled:'Cancelada',suspended:'Suspendida'};
          return (
            <div style={{background:C.surface,border:`1px solid ${(expired||soon)?bd:C.border}`,borderRadius:16,boxShadow:C.shadow,padding:20}}>
              {head}
              <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10,flexWrap:'wrap'}}>
                <span style={{fontSize:20,fontWeight:800,color:C.ink}}>{s.plan_name||'Plan'}</span>
                <span style={{fontSize:11,fontWeight:700,color:fg,background:bg,padding:'2px 9px',borderRadius:999,border:`1px solid ${bd}`,textTransform:'uppercase',letterSpacing:.5}}>{STL[s.status]||s.status}</span>
              </div>
              <div style={{fontSize:28,fontWeight:800,color:fg,lineHeight:1}}>
                {days==null ? '—' : days<0 ? `Vencida hace ${Math.abs(days)}d` : days===0 ? 'Vence hoy' : `${days} ${days===1?'día':'días'}`}
              </div>
              <div style={{fontSize:12,color:C.mid,marginTop:6}}>
                {expired ? 'Renová para reactivar el servicio' : `hasta el vencimiento · ${s.auto_renew?'renovación automática':'sin renovación auto'}`}
              </div>
            </div>
          );
        })()}

        {/* 3 · GASTOS DE PROVEEDORES (compras del mes en curso) */}
        {(()=>{
          const rows = supplierSpend; // null=cargando · []=sin compras
          const mes = new Date().toLocaleDateString('es-PY',{month:'long'});
          const head = (
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
              <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1}}>GASTOS DE PROVEEDORES</div>
              <Icon name="money" size={16} style={{color:C.dim}}/>
            </div>
          );
          const shell = body => <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:16,boxShadow:C.shadow,padding:20}}>{head}{body}</div>;
          if(rows===null) return shell(<div style={{color:C.dim,fontSize:14,padding:'8px 0'}}>Cargando…</div>);
          if(rows.length===0) return shell(<div style={{color:C.dim,fontSize:14,padding:'8px 0',textTransform:'capitalize'}}>Sin compras registradas en {mes}</div>);
          const total = rows.reduce((a,r)=>a+Number(r.total||0),0);
          const pend  = rows.reduce((a,r)=>a+(Number(r.total||0)-Number(r.paid_amount||0)),0);
          const byV = {};
          rows.forEach(r=>{ const k=r.supplier?.name||r.supplier_name||'Sin proveedor'; byV[k]=(byV[k]||0)+Number(r.total||0); });
          const top = Object.entries(byV).sort((a,b)=>b[1]-a[1]).slice(0,4);
          return shell(<>
            <div style={{fontSize:28,fontWeight:800,color:C.ink,lineHeight:1,marginBottom:2}}>{fmt(total)}</div>
            <div style={{fontSize:12,color:C.mid,marginBottom:12,textTransform:'capitalize'}}>gasto de {mes} · {rows.length} {rows.length===1?'compra':'compras'}</div>
            {top.map(([name,amt],i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8,marginBottom:6}}>
                <span style={{fontSize:13,color:C.ink,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',minWidth:0}}>{name}</span>
                <span style={{fontSize:12,color:C.mid,fontFamily:"'SF Mono',ui-monospace,monospace",flexShrink:0}}>{fmt(amt)}</span>
              </div>
            ))}
            {pend>0 && <div style={{marginTop:10,fontSize:12,color:C.orange,fontWeight:600}}>Saldo pendiente: {fmt(pend)}</div>}
            <button onClick={()=>setPage('proveedores')} style={{marginTop:12,background:'none',border:`1px solid ${C.bs}`,color:C.mid,fontSize:12,fontWeight:600,padding:'6px 11px',borderRadius:6,cursor:'pointer'}}>Ver proveedores →</button>
          </>);
        })()}

      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   PEDIDOS
══════════════════════════════════════════════ */
/* ── OrderDetailModal ── vista de detalle COMPLETO de un pedido.
   Pensada para el dueño que NO tiene panel de Caja (Emprendedor pickup / solo-
   delivery): muestra el DESTINO del pedido (dirección + referencias + teléfono
   para delivery, retiro para llevar, mesa para local), cliente, items y pago.
   Cierre solo con ESC o × (regla del proyecto — usa el <Modal> compartido). */
function OrderDetailModal({ order, items, deliv, loading, onClose }) {
  const o = order;
  const isDelivery = o.order_type === 'delivery';
  const isPickup   = ['llevar','pickup','counter'].includes(o.order_type);
  const typeLabel  = isDelivery ? 'Delivery a domicilio'
                   : (o.order_type==='llevar'||o.order_type==='pickup') ? 'Retiro / Para llevar'
                   : o.order_type==='counter' ? 'Mostrador'
                   : mesaLabel(o);
  const typeColor  = isDelivery ? '#FF9500' : isPickup ? TINT.purpleText : '#007AFF';

  const addr   = deliv?.delivery_address || '';
  const detail = deliv?.delivery_detail || '';
  const refs   = deliv?.delivery_references || '';
  const phone  = o.customer_phone || deliv?.customer_phone || '';
  const cash   = deliv?.cash_amount;
  const lat = deliv?.latitude ?? deliv?.lat ?? null;
  const lng = deliv?.longitude ?? deliv?.lng ?? null;
  const mapUrl = (lat!=null && lng!=null) ? `https://www.google.com/maps?q=${lat},${lng}` : null;

  const Row = ({label, value, mono, accent}) => (value!=null && value!=='') ? (
    <div style={{display:'flex',justifyContent:'space-between',gap:12,padding:'5px 0',fontSize:13}}>
      <span style={{color:C.mid,flexShrink:0}}>{label}</span>
      <span style={{fontWeight:600,textAlign:'right',color:accent||'var(--text-primary)',fontFamily:mono?"'SF Mono',ui-monospace,monospace":'inherit'}}>{value}</span>
    </div>
  ) : null;

  const Section = ({icon, title, accent, children}) => (
    <div style={{border:`1px solid ${C.border}`,borderRadius:10,padding:'12px 14px',marginBottom:12,background:C.surface}}>
      <div style={{display:'flex',alignItems:'center',gap:7,marginBottom:6,fontSize:11,fontWeight:800,letterSpacing:.5,textTransform:'uppercase',color:accent||C.mid}}>
        <Icon name={icon} size={13}/> {title}
      </div>
      {children}
    </div>
  );

  return (
    <Modal title={`Pedido ${o.order_number||''}`} onClose={onClose} width={470}>
      {/* estado + tipo + fecha */}
      <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',marginBottom:14}}>
        <Badge status={o.status}/>
        <span style={{fontSize:12,fontWeight:700,color:typeColor,display:'inline-flex',alignItems:'center',gap:5}}>
          <Icon name={isDelivery?'bike':isPickup?'package':'utensils'} size={13}/> {typeLabel}
        </span>
        <span style={{fontSize:11,color:C.dim,marginLeft:'auto'}}>{fmtDT(o.created_at)}</span>
      </div>

      {/* DESTINO del pedido (lo más importante para pickup / solo-delivery) */}
      <Section icon="pin" title="Destino del pedido" accent={isDelivery?'#FF9500':undefined}>
        {isDelivery ? (
          <>
            <Row label="Dirección" value={addr || '— sin dirección cargada —'} accent={addr?undefined:C.dim}/>
            <Row label="Detalle" value={detail}/>
            <Row label="Referencias" value={refs}/>
            {mapUrl && <div style={{marginTop:6}}><a href={mapUrl} target="_blank" rel="noopener noreferrer" style={{fontSize:12,color:C.blue,fontWeight:700}}>📍 Ver ubicación en el mapa</a></div>}
          </>
        ) : isPickup ? (
          <Row label="Modalidad" value="Retiro en el local (para llevar)"/>
        ) : (
          <Row label="Ubicación" value={mesaLabel(o)}/>
        )}
      </Section>

      {/* CLIENTE */}
      {(o.customer_name || phone || o.customer_email || o.requires_invoice) && (
        <Section icon="user" title="Cliente">
          <Row label="Nombre" value={o.customer_name}/>
          <Row label="Teléfono" value={phone}/>
          <Row label="Email" value={o.customer_email}/>
          <Row label="¿Pide factura?" value={o.requires_invoice ? 'Sí' : null} accent={C.blue}/>
        </Section>
      )}

      {/* ITEMS */}
      <Section icon="clipboard" title="Productos">
        {loading && <span className="spin"/>}
        {!loading && items.length===0 && <div style={{fontSize:12,color:C.dim}}>Sin items registrados</div>}
        {items.map((it,i)=>(
          <div key={i} style={{borderBottom:i<items.length-1?`1px solid ${C.border}`:'none',padding:'7px 0'}}>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:13}}>
              <span style={{fontWeight:600}}>{it.quantity}× {it.item_name}</span>
              <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",color:C.mid,marginLeft:6}}>{fmt(it.total_price)}</span>
            </div>
            {it.observations && <div style={{fontSize:11,color:C.mid,marginTop:2}}>→ {it.observations}</div>}
          </div>
        ))}
      </Section>

      {/* PAGO / TOTALES */}
      <Section icon="money" title="Pago">
        <Row label="Método" value={PL[o.payment_method]||o.payment_method||'—'}/>
        {o.payment_reference && <Row label="N° comprobante" value={o.payment_reference} mono/>}
        {(()=>{ const m=reviewMeta(o.payment_review_status); return m ? <Row label="Validación" value={m.label} accent={m.color}/> : null; })()}
        {o.payment_proof_url && (
          <div style={{display:'flex',justifyContent:'space-between',gap:12,padding:'7px 0',fontSize:13,alignItems:'center'}}>
            <span style={{color:C.mid,flexShrink:0}}>Comprobante</span>
            <ProofImage db={db} value={o.payment_proof_url} size={52}/>
          </div>
        )}
        {o.discount_amount>0 && <Row label="Descuento" value={'-'+fmt(o.discount_amount)} mono accent={C.green}/>}
        {isDelivery && cash>0 && <Row label="Paga con (efectivo)" value={fmt(cash)} mono/>}
        {isDelivery && cash>0 && o.total!=null && <Row label="Vuelto" value={fmt(Math.max(0,cash-(o.total||0)))} mono/>}
        <div style={{display:'flex',justifyContent:'space-between',fontWeight:800,fontSize:16,marginTop:6,paddingTop:8,borderTop:`1px solid ${C.border}`}}>
          <span>Total</span><span style={{fontFamily:"'SF Mono',ui-monospace,monospace"}}>{fmt(o.total)}</span>
        </div>
      </Section>
    </Modal>
  );
}

function PedidosPage({orders, tables, onRefresh, onRefreshOrders}) {
  const refreshOrders = onRefreshOrders || onRefresh;   // refresco liviano (fallback al pesado)
  const [typeFilter,setTypeFilter]     = useState('all');
  const [statusFilter,setStatusFilter] = useState('all');
  const [soloComp,setSoloComp]         = useState(false);   // solo transferencias con comprobante (mig 182/183)
  const [period,setPeriod]             = useState('hoy');
  const [dateFrom,setDateFrom]         = useState('');
  const [dateTo,setDateTo]             = useState('');
  const [search,setSearch]             = useState('');
  const [selected,setSelected]         = useState(null);
  const [items,setItems]               = useState([]);
  const [loadingItems,setLoadingItems] = useState(false);
  const [upd,setUpd]                   = useState(false);
  const [newBadge,setNewBadge]         = useState(0);
  // Detalle COMPLETO (modal): orden + items + fila delivery_orders (dirección/destino)
  const [detail,setDetail]             = useState(null);
  const [detailItems,setDetailItems]   = useState([]);
  const [detailDeliv,setDetailDeliv]   = useState(null);
  const [detailLoading,setDetailLoading] = useState(false);

  const TYPE_TABS = [
    {id:'all',      label:'Generales',  icon:'clipboard', color:C.ink},
    {id:'local',    label:'Local',       icon:'utensils', color:'#007AFF'},
    {id:'delivery', label:'Delivery',    icon:'bike', color:'#FF9500'},
    {id:'llevar',   label:'Para llevar', icon:'package', color:'#5856D6'},
  ];
  const STATUS_TABS = [
    {id:'all',       label:'Todos',      color:C.ink, statuses:null},
    {id:'pending',   label:'Pendientes', color:C.dim, statuses:['draft','confirmed']},
    {id:'kitchen',   label:'En cocina',  color:'#FF9500', statuses:['paid','kitchen_received','cooking']},
    {id:'ready',     label:'Listos',     color:'#34C759', statuses:['ready']},
    {id:'delivered', label:'Entregados', color:C.mid, statuses:['delivered']},
    {id:'cancelled', label:'Cancelados', color:'#FF3B30', statuses:['cancelled']},
  ];

  const periodFiltered = useMemo(()=>{
    let res = [...orders];
    const now = new Date();
    if(period==='hoy'){const d=now.toDateString();res=res.filter(o=>new Date(o.created_at).toDateString()===d);}
    else if(period==='7d'){const s=new Date();s.setDate(s.getDate()-6);s.setHours(0,0,0,0);res=res.filter(o=>new Date(o.created_at)>=s);}
    else if(period==='30d'){const s=new Date();s.setDate(s.getDate()-29);s.setHours(0,0,0,0);res=res.filter(o=>new Date(o.created_at)>=s);}
    else if(period==='custom'&&dateFrom){
      const s=new Date(dateFrom);const e=dateTo?new Date(dateTo+'T23:59:59'):new Date();
      res=res.filter(o=>{const d=new Date(o.created_at);return d>=s&&d<=e;});
    }
    if(search.trim()) res=res.filter(o=>(o.order_number||'').toLowerCase().includes(search.toLowerCase()));
    return res;
  },[orders,period,dateFrom,dateTo,search]);

  const typeCounts = useMemo(()=>{
    const c={all:periodFiltered.length,local:0,delivery:0,llevar:0};
    periodFiltered.forEach(o=>{
      if(o.order_type==='delivery') c.delivery++;
      else if(o.order_type==='llevar') c.llevar++;
      else c.local++;
    });
    return c;
  },[periodFiltered]);

  const typeFiltered = useMemo(()=>{
    if(typeFilter==='all') return periodFiltered;
    if(typeFilter==='delivery') return periodFiltered.filter(o=>o.order_type==='delivery');
    if(typeFilter==='llevar') return periodFiltered.filter(o=>o.order_type==='llevar');
    return periodFiltered.filter(o=>!['delivery','llevar'].includes(o.order_type));
  },[periodFiltered,typeFilter]);

  const statusCounts = useMemo(()=>{
    const c={all:typeFiltered.length};
    STATUS_TABS.slice(1).forEach(st=>{c[st.id]=typeFiltered.filter(o=>st.statuses.includes(o.status)).length;});
    return c;
  },[typeFiltered]);

  const filtered = useMemo(()=>{
    const st=STATUS_TABS.find(s=>s.id===statusFilter);
    let res = (!st||statusFilter==='all') ? typeFiltered : typeFiltered.filter(o=>st.statuses.includes(o.status));
    if(soloComp){
      const TR=['qr','transferencia','tarjeta','pos','tarjeta_credito','tarjeta_debito','mixto'];
      res = res.filter(o=>TR.includes(o.payment_method)&&(o.payment_proof_url||o.payment_reference));
    }
    return res;
  },[typeFiltered,statusFilter,soloComp]);

  const rowBg = s => selected?.status===s?'':['paid','kitchen_received','cooking'].includes(s)?TINT.amberBg:s==='ready'?TINT.greenBg:s==='cancelled'?TINT.redBg:'transparent';
  const rowBorderColor = s => ['paid','kitchen_received','cooking'].includes(s)?'#FF9500':s==='ready'?'#34C759':s==='cancelled'?'#FF3B30':'transparent';

  useEffect(()=>{
    if(!db) return;
    // Refresco LIVIANO + sin gate: el pedido nuevo entra a la lista aunque haya un input
    // con foco o un modal abierto (es una lista de monitoreo). El badge "Nuevo" se mantiene.
    // Coalescido en el padre (debounce compartido) → un solo refresco por pedido.
    const ch = db.channel('pedidos-rt')
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'orders',filter:`restaurant_id=eq.${RID}`},()=>{ setNewBadge(n=>n+1); refreshOrders(); })
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'orders',filter:`restaurant_id=eq.${RID}`},()=>{ refreshOrders(); })
      .subscribe();
    return ()=>{ db.removeChannel(ch); };
  },[]);

  function exportExcel() {
    const rows = filtered.map(o=>({
      'N° orden': o.order_number||'',
      'Tipo': o.order_type==='delivery'?'Delivery':o.order_type==='llevar'?'Para llevar':'Local',
      'Mesa': mesaLabel(o),
      'Estado': SL[o.status]||o.status,
      'Productos': o.items_count||0,
      'Total (₲)': o.total||0,
      'Método pago': PL[o.payment_method]||o.payment_method||'',
      'Fecha': fmtDT(o.created_at),
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Pedidos');
    XLSX.writeFile(wb, `pedidos_${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  async function selectOrder(o) {
    setSelected(o); setItems([]);
    if(!db) return;
    setLoadingItems(true);
    const{data}=await db.from('order_items').select('item_name,quantity,unit_price,total_price,observations').eq('order_id',o.id);
    setItems(data||[]); setLoadingItems(false);
  }
  // Abre el modal de detalle COMPLETO: trae items y, si es delivery, la fila de
  // delivery_orders enlazada por order_id (dirección/zona/referencias/efectivo).
  async function openDetail(o) {
    setDetail(o); setDetailItems([]); setDetailDeliv(null);
    if(!db) return;
    setDetailLoading(true);
    const{data:its}=await db.from('order_items').select('item_name,quantity,unit_price,total_price,observations').eq('order_id',o.id);
    setDetailItems(its||[]);
    if(o.order_type==='delivery'){
      const{data:dv}=await db.from('delivery_orders').select('*').eq('order_id',o.id).limit(1);
      if(dv&&dv[0]) setDetailDeliv(dv[0]);
    }
    setDetailLoading(false);
  }
  function closeDetail() { setDetail(null); setDetailItems([]); setDetailDeliv(null); }
  async function updateStatus(orderId,newStatus) {
    if(!db) return; setUpd(true);
    const{data,error}=await db.from('orders').update({status:newStatus,...(newStatus==='delivered'?{completed_at:new Date().toISOString()}:{})}).eq('id',orderId).select('id');
    if(error){toast('Error: '+error.message,false);}
    else if(!data||data.length===0){toast('No se pudo actualizar el estado — verificá RLS en Supabase',false);}
    else{toast('Estado actualizado');setSelected(s=>s?.id===orderId?{...s,status:newStatus}:s);refreshOrders();}
    setUpd(false);
  }

  const activeType = TYPE_TABS.find(t=>t.id===typeFilter)||TYPE_TABS[0];

  return (
    <div className="page">
      {/* Header */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <h1 style={{fontSize:22,fontWeight:800,color:C.ink}}>Pedidos</h1>
          {newBadge>0&&<span style={{background:'#FF3B30',color:'#fff',fontSize:10,fontWeight:800,padding:'2px 8px',borderRadius:10,animation:'fadeIn .2s'}}>{newBadge} nuevos</span>}
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <div style={{position:'relative'}}>
            <span style={{position:'absolute',left:9,top:'50%',transform:'translateY(-50%)',pointerEvents:'none',display:'flex',color:C.mid}}><Icon name="search" size={13}/></span>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar N° orden…" style={{padding:'7px 10px 7px 30px',fontSize:12,borderRadius:8,border:`1px solid ${C.border}`,width:180}}/>
          </div>
          <Btn onClick={exportExcel} variant="secondary" small>Exportar Excel</Btn>
          <Btn onClick={()=>{onRefresh();setNewBadge(0);}} variant="secondary">↺ Actualizar</Btn>
        </div>
      </div>

      {/* Filtro de período */}
      <div style={{display:'flex',gap:8,marginBottom:14,alignItems:'center',flexWrap:'wrap'}}>
        <div style={{display:'flex',gap:0,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
          {['hoy','7d','30d','custom'].map((p,i,a)=>(
            <button key={p} onClick={()=>setPeriod(p)} style={{padding:'6px 14px',fontSize:12,fontWeight:period===p?700:400,background:period===p?C.ink:C.white,color:period===p?C.sidebar:C.dim,border:'none',cursor:'pointer',borderRight:i<a.length-1?`1px solid ${C.border}`:'none'}}>
              {p==='hoy'?'Hoy':p==='7d'?'7 días':p==='30d'?'30 días':'Personalizado'}
            </button>
          ))}
        </div>
        {period==='custom'&&(
          <div style={{display:'flex',gap:6,alignItems:'center'}}>
            <input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} style={{padding:'5px 8px',fontSize:12,borderRadius:6,border:`1px solid ${C.border}`}}/>
            <span style={{fontSize:11,color:C.dim}}>–</span>
            <input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} style={{padding:'5px 8px',fontSize:12,borderRadius:6,border:`1px solid ${C.border}`}}/>
          </div>
        )}
        <span style={{fontSize:12,color:C.dim,marginLeft:'auto'}}>{filtered.length} pedido{filtered.length!==1?'s':''}</span>
      </div>

      {/* Tabs de tipo */}
      <div style={{display:'flex',gap:8,marginBottom:12,flexWrap:'wrap'}}>
        {TYPE_TABS.map(t=>{
          const count=typeCounts[t.id];
          const active=typeFilter===t.id;
          return (
            <button key={t.id} onClick={()=>{setTypeFilter(t.id);setStatusFilter('all');}}
              style={{display:'flex',alignItems:'center',gap:7,padding:'8px 16px',borderRadius:8,border:`2px solid ${active?t.color:C.border}`,background:active?t.color+'18':C.surface,color:active?t.color:C.mid,fontSize:13,fontWeight:active?700:500,cursor:'pointer',transition:'all .15s'}}>
              <Icon name={t.icon} size={14}/>
              <span>{t.label}</span>
              <span style={{background:active?t.color:C.dim,color:'#fff',fontSize:10,fontWeight:800,padding:'1px 7px',borderRadius:10,minWidth:20,textAlign:'center'}}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* Tabs de estado */}
      <div style={{display:'flex',gap:0,borderBottom:`2px solid ${C.border}`,marginBottom:14}}>
        {STATUS_TABS.map(s=>{
          const count=statusCounts[s.id]??0;
          const active=statusFilter===s.id;
          return (
            <button key={s.id} onClick={()=>setStatusFilter(s.id)}
              style={{background:'none',border:'none',color:active?s.color:C.dim,padding:'9px 14px',fontSize:12,fontWeight:active?700:400,borderBottom:active?`3px solid ${s.color}`:'3px solid transparent',cursor:'pointer',marginBottom:-2,display:'flex',alignItems:'center',gap:5,whiteSpace:'nowrap',transition:'color .15s'}}>
              {s.label}
              {count>0&&<span style={{background:active?s.color+'22':C.card,color:active?s.color:C.dim,fontSize:10,fontWeight:700,padding:'1px 6px',borderRadius:8}}>{count}</span>}
            </button>
          );
        })}
      </div>

      {/* Filtro de conciliación: solo transferencias/QR/tarjeta que tienen comprobante (N° o foto) */}
      <div style={{display:'flex',alignItems:'center',gap:8,margin:'12px 0 0'}}>
        <button onClick={()=>setSoloComp(v=>!v)} style={{display:'inline-flex',alignItems:'center',gap:6,padding:'6px 12px',fontSize:12,fontWeight:700,borderRadius:8,cursor:'pointer',border:`1px solid ${soloComp?'#34C759':C.border}`,background:soloComp?'rgba(52,199,89,0.10)':C.surface,color:soloComp?'#2FA84F':C.mid}}>
          <span>🧾</span> Solo transferencias con comprobante {soloComp&&<span style={{fontSize:13,lineHeight:1}}>✓</span>}
        </button>
        {soloComp&&<span style={{fontSize:11,color:C.dim}}>{filtered.length} pedido{filtered.length!==1?'s':''}</span>}
      </div>

      {/* Tabla + Panel de detalle */}
      <div style={{display:'flex',gap:12,minHeight:400,marginTop:12}}>
        <div style={{flex:1,background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse'}}>
            <thead>
              <tr style={{borderBottom:`1px solid ${C.border}`,background:'var(--bg-subtle)'}}>
                <Th>#</Th><Th>Tipo</Th><Th>Destino</Th><Th>Estado</Th><Th>Items</Th><Th right>Total</Th><Th>Pago</Th><Th>Hora</Th><Th></Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(o=>{
                const isSelected = selected?.id===o.id;
                const bg = isSelected?'#EEF5FF':rowBg(o.status);
                const bl = isSelected?'#007AFF':rowBorderColor(o.status);
                return (
                  <tr key={o.id} onClick={()=>{selectOrder(o);setNewBadge(0);}}
                    style={{borderBottom:`1px solid ${C.border}`,cursor:'pointer',background:bg,borderLeft:`3px solid ${bl}`}}>
                    <Td mono dim>{o.order_number}</Td>
                    <Td>
                      {o.order_type==='delivery'
                        ?<span style={{color:'#FF9500',fontSize:12,fontWeight:600,display:'inline-flex',alignItems:'center',gap:4}}><Icon name="bike" size={12}/> Delivery</span>
                        :o.order_type==='llevar'
                        ?<span style={{color:'#5856D6',fontSize:12,fontWeight:600,display:'inline-flex',alignItems:'center',gap:4}}><Icon name="package" size={12}/> Llevar</span>
                        :<span style={{color:'#007AFF',fontSize:12,fontWeight:600,display:'inline-flex',alignItems:'center',gap:4}}><Icon name="utensils" size={12}/> Local</span>}
                    </Td>
                    <Td>{mesaLabel(o)}</Td>
                    <Td><Badge status={o.status}/></Td>
                    <Td dim>{o.items_count||0}</Td>
                    <Td mono right>{fmt(o.total)}</Td>
                    <Td dim>
                      <span style={{display:'inline-flex',alignItems:'center',gap:5}}>
                        {PL[o.payment_method]||'—'}
                        {(o.payment_proof_url||o.payment_reference)&&<span title="Con comprobante" style={{fontSize:12}}>🧾</span>}
                        {(()=>{const m=reviewMeta(o.payment_review_status);return m?<span title={m.label} style={{width:7,height:7,borderRadius:'50%',background:m.color,display:'inline-block'}}/>:null;})()}
                      </span>
                    </Td>
                    <Td mono dim>{fmtTime(o.created_at)}</Td>
                    <Td right style={{whiteSpace:'nowrap'}}>
                      <Btn small variant="secondary" onClick={e=>{e.stopPropagation();openDetail(o);}}>Ver detalle</Btn>
                    </Td>
                  </tr>
                );
              })}
              {filtered.length===0&&<EmptyRow cols={9} label="Sin pedidos en este período"/>}
            </tbody>
          </table>
        </div>

        {selected&&(
          <div style={{width:290,background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,flexShrink:0,display:'flex',flexDirection:'column',overflow:'hidden'}}>
            <div style={{padding:'13px 16px',borderBottom:`1px solid ${C.border}`,display:'flex',justifyContent:'space-between',background:'var(--bg-subtle)'}}>
              <div>
                <div style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:14,fontWeight:700}}>{selected.order_number}</div>
                <div style={{fontSize:10,color:C.dim,marginTop:2}}>{fmtDT(selected.created_at)}</div>
              </div>
              <button onClick={()=>{setSelected(null);setItems([]);}} style={{background:'none',border:'none',color:C.dim,fontSize:22,lineHeight:1,padding:0,cursor:'pointer'}}>×</button>
            </div>
            <div style={{padding:'8px 16px',borderBottom:`1px solid ${C.border}`,display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
              <Badge status={selected.status}/>
              <span style={{fontSize:12,color:C.mid}}>{mesaLabel(selected)}</span>
              {selected.order_type==='delivery'&&<span style={{fontSize:11,color:'#FF9500',fontWeight:600,background:TINT.amberBg,padding:'2px 7px',borderRadius:6,display:'inline-flex',alignItems:'center',gap:4}}><Icon name="bike" size={11}/> Delivery</span>}
              {selected.order_type==='llevar'&&<span style={{fontSize:11,color:TINT.purpleText,fontWeight:600,background:TINT.purpleBg,padding:'2px 7px',borderRadius:6,display:'inline-flex',alignItems:'center',gap:4}}><Icon name="package" size={11}/> Para llevar</span>}
            </div>
            <div style={{flex:1,padding:'8px 16px',overflowY:'auto',borderBottom:`1px solid ${C.border}`}}>
              {loadingItems&&<span className="spin"/>}
              {items.map((it,i)=>(
                <div key={i} style={{borderBottom:`1px solid #F5F5F5`,padding:'7px 0'}}>
                  <div style={{display:'flex',justifyContent:'space-between',fontSize:13}}>
                    <span style={{fontWeight:600}}>{it.quantity}× {it.item_name}</span>
                    <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",color:C.mid,marginLeft:6}}>{fmt(it.total_price)}</span>
                  </div>
                  {it.observations&&<div style={{fontSize:11,color:C.mid,marginTop:2}}>→ {it.observations}</div>}
                </div>
              ))}
            </div>
            <div style={{padding:'10px 16px',borderBottom:`1px solid ${C.border}`}}>
              {selected.discount_amount>0&&<div style={{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:4,color:C.green}}><span>Descuento</span><span style={{fontFamily:"'SF Mono',ui-monospace,monospace"}}>-{fmt(selected.discount_amount)}</span></div>}
              <div style={{display:'flex',justifyContent:'space-between',fontWeight:800,fontSize:15}}><span>Total</span><span style={{fontFamily:"'SF Mono',ui-monospace,monospace"}}>{fmt(selected.total)}</span></div>
            </div>
            <div style={{padding:'12px 16px',display:'flex',flexDirection:'column',gap:7}}>
              <Btn variant="secondary" onClick={()=>openDetail(selected)}>Ver detalle completo</Btn>
              {selected.status==='paid'&&<Btn onClick={()=>updateStatus(selected.id,'cooking')} disabled={upd}>→ Iniciar preparación</Btn>}
              {selected.status==='cooking'&&<Btn onClick={()=>updateStatus(selected.id,'ready')} disabled={upd}>✓ Marcar listo</Btn>}
              {selected.status==='ready'&&<Btn onClick={()=>updateStatus(selected.id,'delivered')} disabled={upd}>✓ Entregar</Btn>}
              {!['delivered','cancelled'].includes(selected.status)&&<Btn variant="danger" onClick={()=>{if(confirm(`¿Cancelar ${selected.order_number}?`))updateStatus(selected.id,'cancelled');}} disabled={upd}>✕ Cancelar</Btn>}
            </div>
          </div>
        )}
      </div>

      {detail && (
        <OrderDetailModal
          order={detail} items={detailItems} deliv={detailDeliv}
          loading={detailLoading} onClose={closeDetail}/>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════
   MENÚ
══════════════════════════════════════════════ */
/* ══════════════════════════════════════════════
   ITEM MODAL — crear / editar producto del menú
══════════════════════════════════════════════ */
const PROMO_TYPES = [
  {value:'',            label:'Sin tipo de promo'},
  {value:'pizza_corrida',    label:'Pizza corrida'},
  {value:'hamburgesa_corrida',label:'Hamburguesa corrida'},
  {value:'tenedor_libre',    label:'Tenedor libre'},
  {value:'sushi_libre',      label:'Sushi libre'},
  {value:'bebida_libre',     label:'Bebida libre'},
  {value:'other',            label:'Otra promo especial'},
];
const PROMO_LABEL = Object.fromEntries(PROMO_TYPES.map(p=>[p.value,p.label]));

function ItemModal({item, categories, onClose, onSaved}) {
  const isNew = !item;
  const [form, setForm] = useState({
    name:          item?.name          ?? '',
    description:   item?.description   ?? '',
    price_guarani: item?.price_guarani  ?? '',
    discount_pct:  item?.discount_pct   ?? 0,
    category_id:   item?.category_id   ?? '',
    is_available:  item?.is_available   ?? true,
    promo_type:    item?.promo_type     ?? '',
    promo_tag:     item?.promo_tag      ?? '',
    dine_in_only:  item?.dine_in_only   ?? false,
    image_url:     item?.image_url      ?? '',
    stock_min:     item?.stock_min      ?? '',
    allows_half_and_half:      item?.allows_half_and_half      ?? false,
    half_and_half_rule:        item?.half_and_half_rule        ?? '',
    half_and_half_fixed_price: item?.half_and_half_fixed_price ?? '',
  });
  const [extras, setExtras]         = useState([]);
  const [extrasReady, setExtrasReady] = useState(isNew);
  const [variants, setVariants]       = useState([]);
  const [variantsReady, setVariantsReady] = useState(isNew);
  const [saving, setSaving]         = useState(false);

  const f = (k,v) => setForm(p=>({...p,[k]:v}));

  useEffect(()=>{
    if(!isNew && db){
      db.from('menu_item_extras').select('*').eq('item_id',item.id).order('id')
        .then(({data})=>{ setExtras(data||[]); setExtrasReady(true); });
      db.from('menu_item_variants').select('*').eq('item_id',item.id).order('sort_order')
        .then(({data})=>{ setVariants(data||[]); setVariantsReady(true); });
    }
  },[]);

  const addExtra    = () => setExtras(p=>[...p,{id:null,name:'',price_guarani:0,is_active:true}]);
  const removeExtra = i  => setExtras(p=>p.filter((_,j)=>j!==i));
  const updExtra    = (i,k,v) => setExtras(p=>p.map((e,j)=>j===i?{...e,[k]:v}:e));

  // Tamaños/variantes: el primero agregado queda por defecto; al borrar el
  // default, el primero restante lo hereda. Siempre hay exactamente 1 default.
  const addVariant    = () => setVariants(p=>[...p,{id:null,name:'',price_guarani:'',sort_order:p.length,is_default:p.length===0,is_active:true}]);
  const removeVariant = i  => setVariants(p=>{
    let n=p.filter((_,j)=>j!==i);
    if(n.length && !n.some(v=>v.is_default)) n=n.map((v,j)=>j===0?{...v,is_default:true}:v);
    return n;
  });
  const updVariant        = (i,k,v) => setVariants(p=>p.map((x,j)=>j===i?{...x,[k]:v}:x));
  const setDefaultVariant = i  => setVariants(p=>p.map((x,j)=>({...x,is_default:j===i})));

  const finalPrice = () => {
    const p = parseInt(form.price_guarani)||0;
    const d = parseInt(form.discount_pct)||0;
    return d>0 ? Math.round(p*(100-d)/100) : p;
  };

  async function save() {
    // Si hay tamaños, el precio base = precio del tamaño por defecto (o el 1º).
    const validVariants = variants.filter(v=>v.name.trim() && parseInt(v.price_guarani)>0);
    const effBase = validVariants.length>0
      ? parseInt((validVariants.find(v=>v.is_default)||validVariants[0]).price_guarani)
      : parseInt(form.price_guarani)||0;
    if(!form.name.trim()||!form.category_id||effBase<=0){
      toast('Completá nombre, categoría y un precio (o al menos un tamaño con precio)',false); return;
    }
    if(form.allows_half_and_half && form.half_and_half_rule==='fixed' && !(parseInt(form.half_and_half_fixed_price)>0)){
      toast('Ingresá el precio fijo de la mitad-y-mitad, o elegí otra regla',false); return;
    }
    setSaving(true);
    const payload = {
      name:          form.name.trim(),
      description:   form.description||null,
      price_guarani: effBase,
      discount_pct:  parseInt(form.discount_pct)||0,
      category_id:   form.category_id,
      restaurant_id: RID,
      is_available:  form.is_available,
      promo_type:    form.promo_type||null,
      promo_tag:     form.promo_tag||null,
      dine_in_only:  form.dine_in_only,
      image_url:     form.image_url||null,
      stock_min:     parseInt(form.stock_min)||0,
      allows_half_and_half: form.allows_half_and_half,
      half_and_half_rule:   form.allows_half_and_half ? (form.half_and_half_rule||null) : null,
      half_and_half_fixed_price: (form.allows_half_and_half && form.half_and_half_rule==='fixed') ? (parseInt(form.half_and_half_fixed_price)||null) : null,
    };
    let itemId = item?.id;
    if(isNew){
      // id es SERIAL: dejar que Postgres lo asigne. Asignarlo a mano rompía
      // multi-restaurante (RLS limita el SELECT al propio local → nextId=1 → choque pkey).
      const{data,error}=await db.from('menu_items').insert(payload).select('id');
      if(error||!data?.length){toast('Error: '+(error?.message||'verificá RLS'),false);setSaving(false);return;}
      itemId=data[0].id;
    } else {
      const{data,error}=await db.from('menu_items').update(payload).eq('id',item.id).select('id');
      if(error||!data?.length){toast('Error: '+(error?.message||'verificá RLS'),false);setSaving(false);return;}
      await db.from('menu_item_extras').delete().eq('item_id',item.id);
    }
    const validExtras = extras.filter(e=>e.name.trim());
    if(validExtras.length>0){
      await db.from('menu_item_extras').insert(
        validExtras.map(e=>({item_id:itemId,name:e.name.trim(),price_guarani:parseInt(e.price_guarani)||0,is_active:e.is_active!==false}))
      );
    }
    // Tamaños/variantes (mismo patrón delete-all + re-insert que los extras).
    // Guardado solo si ya cargaron: evita borrarlos al guardar antes de que lleguen.
    if(variantsReady){
      if(!isNew){ await db.from('menu_item_variants').delete().eq('item_id',item.id); }
      if(validVariants.length>0){
        const defIdx = Math.max(0, validVariants.findIndex(v=>v.is_default));
        await db.from('menu_item_variants').insert(
          validVariants.map((v,i)=>({item_id:itemId,name:v.name.trim(),price_guarani:parseInt(v.price_guarani),sort_order:i,is_default:i===defIdx,is_active:v.is_active!==false}))
        );
      }
    }
    toast(isNew?'Producto creado — ya visible en la app':'Cambios guardados');
    setSaving(false);
    onSaved();
    onClose();
  }

  const disc = parseInt(form.discount_pct)||0;
  const baseP = parseInt(form.price_guarani)||0;

  return (
    <Modal title={isNew?'Nuevo producto':`Editar: ${item.name}`} onClose={onClose} width={650}>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>

        {/* Imagen */}
        <div style={{gridColumn:'1/-1'}}>
          <Lbl>IMAGEN DEL PRODUCTO</Lbl>
          <ImageUploader value={form.image_url} onChange={url=>f('image_url',url)}/>
        </div>

        {/* Nombre */}
        <div>
          <Lbl>NOMBRE *</Lbl>
          <Inp value={form.name} onChange={e=>f('name',e.target.value)} placeholder="Lomito completo"/>
        </div>

        {/* Categoría */}
        <div>
          <Lbl>CATEGORÍA *</Lbl>
          <Sel value={form.category_id} onChange={e=>f('category_id',e.target.value)}>
            <option value="">Seleccionar…</option>
            {categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
          </Sel>
        </div>

        {/* Precio */}
        <div>
          <Lbl>PRECIO (₲) *</Lbl>
          <MoneyInp value={form.price_guarani} onChange={v=>f('price_guarani',v)} placeholder="75000"/>
        </div>

        {/* Descuento */}
        <div>
          <Lbl>DESCUENTO (%)</Lbl>
          <Inp type="number" mono value={form.discount_pct} onChange={e=>f('discount_pct',e.target.value)} placeholder="0" min="0" max="100"/>
          {disc>0&&baseP>0&&(
            <div style={{fontSize:11,marginTop:4,display:'flex',gap:8,alignItems:'center'}}>
              <span style={{color:C.dim,textDecoration:'line-through'}}>{fmt(baseP)}</span>
              <span style={{color:'#34C759',fontWeight:700}}>{fmt(finalPrice())}</span>
              <span style={{color:'#34C759'}}>−{disc}%</span>
            </div>
          )}
        </div>

        {/* Tipo de promo */}
        <div>
          <Lbl>TIPO DE PROMO</Lbl>
          <Sel value={form.promo_type} onChange={e=>f('promo_type',e.target.value)}>
            {PROMO_TYPES.map(p=><option key={p.value} value={p.value}>{p.label}</option>)}
          </Sel>
          {form.promo_type&&<div style={{fontSize:11,color:TINT.amberText,marginTop:4,background:TINT.amberBg,padding:'3px 8px',borderRadius:4,display:'inline-block'}}>{PROMO_LABEL[form.promo_type]}</div>}
        </div>

        {/* Badge / etiqueta libre */}
        <div>
          <Lbl>BADGE / ETIQUETA</Lbl>
          <Inp value={form.promo_tag} onChange={e=>f('promo_tag',e.target.value)} placeholder="2×1, Chef ★, Nuevo…"/>
        </div>

        {/* Stock mínimo */}
        <div>
          <Lbl>STOCK MÍNIMO</Lbl>
          <NumInp value={form.stock_min} onChange={v=>f('stock_min',v)} placeholder="0"/>
        </div>

        {/* Checkboxes */}
        <div style={{display:'flex',flexDirection:'column',gap:10,justifyContent:'flex-end',paddingBottom:2}}>
          <label style={{display:'flex',alignItems:'center',gap:8,fontSize:13,cursor:'pointer'}}>
            <input type="checkbox" checked={form.is_available} onChange={e=>f('is_available',e.target.checked)}/>
            Disponible en carta
          </label>
          <label style={{display:'flex',alignItems:'center',gap:8,fontSize:13,cursor:'pointer'}}>
            <input type="checkbox" checked={form.dine_in_only} onChange={e=>f('dine_in_only',e.target.checked)}/>
            Solo consumo en local
          </label>
          <label style={{display:'flex',alignItems:'center',gap:8,fontSize:13,cursor:'pointer'}}>
            <input type="checkbox" checked={form.allows_half_and_half} onChange={e=>f('allows_half_and_half',e.target.checked)}/>
            Apto para mitad y mitad
          </label>
        </div>

        {/* Descripción */}
        <div style={{gridColumn:'1/-1'}}>
          <Lbl>DESCRIPCIÓN</Lbl>
          <textarea value={form.description||''} onChange={e=>f('description',e.target.value)} rows={2}
            style={{width:'100%',padding:'8px 10px',fontSize:13,resize:'vertical',background:C.surface,border:`1px solid ${C.border}`,color:C.ink,borderRadius:6,boxSizing:'border-box'}}/>
        </div>

        {/* Regla de precio mitad-y-mitad (override por producto) */}
        {form.allows_half_and_half&&(
        <div style={{gridColumn:'1/-1',borderTop:`1px solid ${C.border}`,paddingTop:14}}>
          <Lbl>REGLA DE PRECIO MITAD Y MITAD</Lbl>
          <div style={{display:'grid',gridTemplateColumns:form.half_and_half_rule==='fixed'?'1fr 160px':'1fr',gap:10,alignItems:'center'}}>
            <Sel value={form.half_and_half_rule||''} onChange={e=>f('half_and_half_rule',e.target.value)}>
              <option value="">Usar la del local (por defecto)</option>
              <option value="max">Mitad más cara</option>
              <option value="avg">Promedio de los dos</option>
              <option value="fixed">Precio fijo</option>
            </Sel>
            {form.half_and_half_rule==='fixed'&&(
              <MoneyInp value={form.half_and_half_fixed_price} onChange={v=>f('half_and_half_fixed_price',v)} placeholder="Precio fijo ₲"/>
            )}
          </div>
          <div style={{color:C.dim,fontSize:11,marginTop:6}}>En un combo manda la regla del primer sabor que elige el cliente. "Usar la del local" toma la de Configuración.</div>
        </div>
        )}

        {/* Tamaños / variantes */}
        <div style={{gridColumn:'1/-1',borderTop:`1px solid ${C.border}`,paddingTop:14}}>
          <Lbl>TAMAÑOS / VARIANTES (opcional)</Lbl>
          <div style={{color:C.dim,fontSize:11,marginBottom:8}}>Si agregás tamaños, el precio de arriba se toma del tamaño por defecto (●). Dejá vacío para un único precio.</div>
          {variantsReady&&(<>
            {variants.map((v,i)=>(
              <div key={i} style={{display:'grid',gridTemplateColumns:'1fr 140px 40px 76px 32px',gap:8,alignItems:'center',marginBottom:7}}>
                <Inp value={v.name} onChange={ev=>updVariant(i,'name',ev.target.value)} placeholder="Ej: Chica, Mediana, Grande"/>
                <MoneyInp value={v.price_guarani} onChange={val=>updVariant(i,'price_guarani',val)} placeholder="0"/>
                <button title="Tamaño por defecto" onClick={()=>setDefaultVariant(i)}
                  style={{padding:'5px 0',fontSize:14,borderRadius:5,cursor:'pointer',border:`1px solid ${v.is_default?'rgba(0,122,255,0.4)':C.border}`,background:v.is_default?'rgba(0,122,255,0.12)':'transparent',color:v.is_default?'#007AFF':C.dim}}>
                  {v.is_default?'●':'○'}
                </button>
                <button onClick={()=>updVariant(i,'is_active',!v.is_active)}
                  style={{padding:'5px 6px',fontSize:11,fontWeight:600,borderRadius:5,cursor:'pointer',border:`1px solid ${v.is_active?'rgba(52,199,89,0.3)':'rgba(142,142,147,0.3)'}`,background:v.is_active?'rgba(52,199,89,0.1)':'transparent',color:v.is_active?'#34C759':'#86868B'}}>
                  {v.is_active?'Activo':'Inact.'}
                </button>
                <button onClick={()=>removeVariant(i)} style={{background:'none',border:'none',color:'#FF3B30',fontSize:20,cursor:'pointer',padding:0,lineHeight:1}}>×</button>
              </div>
            ))}
            {variants.length===0&&<div style={{color:C.dim,fontSize:12,padding:'4px 0 10px'}}>Sin tamaños — este producto usa el precio único de arriba</div>}
            <Btn variant="secondary" small onClick={addVariant}>+ Agregar tamaño</Btn>
          </>)}
        </div>

        {/* Extras */}
        <div style={{gridColumn:'1/-1',borderTop:`1px solid ${C.border}`,paddingTop:14}}>
          <Lbl>EXTRAS E INGREDIENTES ADICIONALES</Lbl>
          {!extrasReady&&<div style={{color:C.dim,fontSize:12,padding:'4px 0 10px'}}>Cargando extras…</div>}
          {extrasReady&&(<>
            {extras.map((e,i)=>(
              <div key={i} style={{display:'grid',gridTemplateColumns:'1fr 140px 76px 32px',gap:8,alignItems:'center',marginBottom:7}}>
                <Inp value={e.name} onChange={ev=>updExtra(i,'name',ev.target.value)} placeholder="Ej: Queso extra, Picante, Sin cebolla"/>
                <div style={{display:'flex',alignItems:'center',gap:4}}>
                  <MoneyInp value={e.price_guarani} onChange={v=>updExtra(i,'price_guarani',v)} placeholder="0" style={{flex:1}}/>
                </div>
                <button onClick={()=>updExtra(i,'is_active',!e.is_active)}
                  style={{padding:'5px 6px',fontSize:11,fontWeight:600,borderRadius:5,cursor:'pointer',border:`1px solid ${e.is_active?'rgba(52,199,89,0.3)':'rgba(142,142,147,0.3)'}`,background:e.is_active?'rgba(52,199,89,0.1)':'transparent',color:e.is_active?'#34C759':'#86868B'}}>
                  {e.is_active?'Activo':'Inact.'}
                </button>
                <button onClick={()=>removeExtra(i)} style={{background:'none',border:'none',color:'#FF3B30',fontSize:20,cursor:'pointer',padding:0,lineHeight:1}}>×</button>
              </div>
            ))}
            {extras.length===0&&<div style={{color:C.dim,fontSize:12,padding:'4px 0 10px'}}>Sin extras — agregá el primero abajo</div>}
            <Btn variant="secondary" small onClick={addExtra}>+ Agregar extra</Btn>
          </>)}
        </div>

      </div>
      <div style={{display:'flex',gap:8,marginTop:20}}>
        <Btn onClick={save} disabled={saving}>{saving?'Guardando…':(isNew?'Crear producto':'Guardar cambios')}</Btn>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
      </div>
    </Modal>
  );
}

/* ══════════════════════════════════════════════
   MENU PAGE
══════════════════════════════════════════════ */
function MenuPage({categories,menuItems,onRefresh}) {
  const [menuTab,setMenuTab]     = useState('productos');
  const [catFilter,setCatFilter] = useState('all');
  const [itemModal,setItemModal] = useState(null); // null | {item: null|object}
  const [previewItem,setPreviewItem] = useState(null);
  const [newCat,setNewCat]       = useState('');
  const [allExtras,setAllExtras]       = useState([]);
  const [extrasLoading,setExtrasLoading] = useState(false);
  const [selected,setSelected]   = useState(new Set());

  const visible = catFilter==='all'?menuItems:menuItems.filter(i=>i.category_id===catFilter);
  const catName = id => categories.find(c=>c.id===id)?.name||'—';
  const itemName = id => menuItems.find(i=>i.id===id)?.name||'—';

  const allVisibleSelected = visible.length>0 && visible.every(i=>selected.has(i.id));
  const someSelected = selected.size>0;

  useEffect(()=>{ setSelected(new Set()); },[catFilter]);

  function toggleSelect(id) {
    setSelected(prev=>{ const n=new Set(prev); n.has(id)?n.delete(id):n.add(id); return n; });
  }
  function toggleSelectAll() {
    if(allVisibleSelected) setSelected(prev=>{ const n=new Set(prev); visible.forEach(i=>n.delete(i.id)); return n; });
    else setSelected(prev=>{ const n=new Set(prev); visible.forEach(i=>n.add(i.id)); return n; });
  }
  async function bulkToggleAvail(enable) {
    if(!db||selected.size===0) return;
    const ids=[...selected];
    const{error}=await db.from('menu_items').update({is_available:enable}).in('id',ids);
    if(error){toast('Error: '+error.message,false);return;}
    toast(`${ids.length} item(s) ${enable?'activados':'desactivados'}`);
    setSelected(new Set()); onRefresh();
  }
  async function bulkDelete() {
    if(!db||selected.size===0) return;
    if(!confirm(`¿Eliminar ${selected.size} item(s) seleccionados? Esta acción no se puede deshacer.`)) return;
    const ids=[...selected];
    const{data,error}=await db.from('menu_items').delete().in('id',ids).select('id');
    if(error){
      const msg=error.message.includes('foreign key')||error.message.includes('order_items')
        ?'Uno o más productos tienen pedidos y no pueden borrarse. Desactivalos para ocultarlos de la carta.'
        :'Error: '+error.message;
      toast(msg,false);
    } else {
      toast(`${(data||[]).length} item(s) eliminados`);
      setSelected(new Set()); onRefresh();
    }
  }

  async function loadAllExtras() {
    if(!db||!menuItems.length) return;
    setExtrasLoading(true);
    const ids = menuItems.map(i=>i.id);
    const {data} = await db.from('menu_item_extras').select('*').in('item_id',ids).order('item_id').order('id');
    setAllExtras(data||[]);
    setExtrasLoading(false);
  }
  useEffect(()=>{ if(menuTab==='extras') loadAllExtras(); },[menuTab,menuItems]);

  async function toggleExtraActive(ext) {
    if(!db) return;
    const {error} = await db.from('menu_item_extras').update({is_active:!ext.is_active}).eq('id',ext.id);
    if(error){toast('Error: '+error.message,false);return;}
    setAllExtras(p=>p.map(e=>e.id===ext.id?{...e,is_active:!e.is_active}:e));
  }

  useEffect(()=>{
    if(!db) return;
    const ch = db.channel('menu-rt')
      .on('postgres_changes',{event:'*',schema:'public',table:'menu_items',filter:`restaurant_id=eq.${RID}`},()=>{ if(!_shouldPause()) onRefresh(); })
      .subscribe();
    return ()=>{ db.removeChannel(ch); };
  },[]);

  async function addCategory() {
    if(!db||!newCat.trim()) return;
    const{data,error}=await db.from('menu_categories').insert({restaurant_id:RID,name:newCat.trim(),sort_order:categories.length+1}).select('id');
    if(error){toast('Error: '+error.message,false);}
    else if(!data||data.length===0){toast('No se pudo crear la categoría — verificá RLS en Supabase',false);}
    else{toast('Categoría agregada');setNewCat('');onRefresh();}
  }

  async function deleteCategory(cat) {
    if(!db) return;
    // menu_items.category_id es ON DELETE CASCADE: borrar una categoría con
    // productos los borraría a todos. Bloqueamos y pedimos vaciar primero.
    const count = menuItems.filter(i=>i.category_id===cat.id).length;
    if(count>0){
      toast(`"${cat.name}" tiene ${count} producto(s). Movelos a otra categoría o eliminalos antes de borrarla.`,false);
      return;
    }
    if(!confirm(`¿Eliminar la categoría "${cat.name}"?`)) return;
    const{data,error}=await db.from('menu_categories').delete().eq('id',cat.id).select('id');
    if(error){toast('Error: '+error.message,false);}
    else if(!data||data.length===0){toast('No se pudo eliminar — verificá permisos RLS en Supabase',false);}
    else{toast('Categoría eliminada');if(catFilter===cat.id)setCatFilter('all');onRefresh();}
  }

  async function toggleAvail(item) {
    if(!db) return;
    const{data,error}=await db.from('menu_items').update({is_available:!item.is_available}).eq('id',item.id).select('id');
    if(error){toast('Error: '+error.message,false);}
    else if(!data||data.length===0){toast('No se pudo actualizar — verificá permisos RLS en Supabase',false);}
    else{toast(item.is_available?'Desactivado — no aparece en carta':'Activado — visible en carta');onRefresh();}
  }

  async function deleteItem(item) {
    if(!db||!confirm(`¿Eliminar "${item.name}"?`)) return;
    const{data,error}=await db.from('menu_items').delete().eq('id',item.id).select('id');
    if(error){
      const msg = error.message.includes('foreign key')||error.message.includes('order_items')
        ? 'Este producto tiene pedidos y no puede borrarse. Desactivalo para ocultarlo de la carta.'
        : 'Error: '+error.message;
      toast(msg,false);
    }
    else if(!data||data.length===0){toast('No se pudo eliminar — ejecutá la migración 010 en Supabase',false);}
    else{toast('Item eliminado');onRefresh();}
  }

  return (
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <h1 style={{fontSize:22,fontWeight:800,color:C.ink}}>Menú</h1>
        <div style={{display:'flex',gap:8}}>
          <a href={`index.html?r=${encodeURIComponent(RID)}`} target="_blank" style={{fontSize:12,color:C.mid,padding:'8px 12px',border:`1px solid ${C.border}`,borderRadius:6,textDecoration:'none'}}>Ver app →</a>
          {menuTab==='productos'&&<Btn onClick={()=>setItemModal({item:null})}>+ Nuevo producto</Btn>}
        </div>
      </div>

      {/* Sub-tabs */}
      <div style={{display:'flex',gap:0,borderBottom:`1px solid ${C.border}`,marginBottom:14}}>
        {[['productos','Productos'],['extras','Extras / Modificadores']].map(([id,lbl])=>(
          <button key={id} onClick={()=>setMenuTab(id)} style={{background:'none',border:'none',color:menuTab===id?C.ink:C.dim,padding:'8px 16px',fontSize:13,fontWeight:menuTab===id?700:400,borderBottom:menuTab===id?'2px solid '+C.ink:'2px solid transparent',cursor:'pointer',marginBottom:-1}}>{lbl}</button>
        ))}
      </div>

      {/* Modal crear / editar */}
      {itemModal&&(
        <ItemModal
          item={itemModal.item}
          categories={categories}
          onClose={()=>setItemModal(null)}
          onSaved={()=>{ onRefresh(); if(menuTab==='extras') loadAllExtras(); }}
        />
      )}

      {/* Modal vista previa */}
      {previewItem&&(
        <Modal title="Vista previa del producto" onClose={()=>setPreviewItem(null)} width={380}>
          <div style={{background:C.bg,borderRadius:12,overflow:'hidden'}}>
            {previewItem.image_url
              ?<img src={previewItem.image_url} alt="" style={{width:'100%',height:200,objectFit:'cover'}} onError={e=>{e.target.style.display='none';}}/>
              :<div style={{height:140,background:'var(--bg-subtle)',display:'flex',alignItems:'center',justifyContent:'center',color:C.dim}}><Icon name="utensils" size={38}/></div>
            }
            <div style={{padding:20}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8,gap:8}}>
                <div style={{fontSize:18,fontWeight:700,color:C.ink,flex:1}}>{previewItem.name}</div>
                <div style={{display:'flex',flexDirection:'column',gap:4,alignItems:'flex-end',flexShrink:0}}>
                  {previewItem.promo_tag&&<span style={{background:TINT.amberBg,border:`1px solid ${TINT.amberBorder}`,color:TINT.amberText,padding:'2px 8px',fontSize:11,borderRadius:4}}>{previewItem.promo_tag}</span>}
                  {previewItem.promo_type&&<span style={{background:TINT.blueBg,border:`1px solid ${TINT.blueBorder}`,color:TINT.blueText,padding:'2px 8px',fontSize:11,borderRadius:4}}>{PROMO_LABEL[previewItem.promo_type]}</span>}
                  {previewItem.dine_in_only&&<span style={{background:TINT.greenBg,border:`1px solid ${TINT.greenBorder}`,color:TINT.greenText,padding:'2px 8px',fontSize:11,borderRadius:4}}>Solo en local</span>}
                </div>
              </div>
              {previewItem.description&&<div style={{fontSize:13,color:C.mid,marginBottom:12,lineHeight:1.4}}>{previewItem.description}</div>}
              {(previewItem.discount_pct>0)
                ?<div style={{marginBottom:12}}>
                  <span style={{fontSize:14,color:C.dim,textDecoration:'line-through',marginRight:8}}>{fmt(previewItem.price_guarani)}</span>
                  <span style={{fontSize:22,fontWeight:800,color:C.ink}}>{fmt(Math.round(previewItem.price_guarani*(100-previewItem.discount_pct)/100))}</span>
                  <span style={{fontSize:12,color:'#34C759',marginLeft:6,fontWeight:700}}>−{previewItem.discount_pct}%</span>
                </div>
                :<div style={{fontSize:22,fontWeight:800,color:C.ink,marginBottom:12}}>{fmt(previewItem.price_guarani)}</div>
              }
              <div style={{background:C.ink,color:C.sidebar,padding:'11px',textAlign:'center',borderRadius:8,fontSize:14,fontWeight:600}}>Agregar al pedido</div>
            </div>
          </div>
          <div style={{marginTop:12,fontSize:11,color:C.dim,textAlign:'center'}}>Solo lectura — sin funcionalidad de carrito</div>
        </Modal>
      )}

      {/* ── TAB EXTRAS ── */}
      {menuTab==='extras'&&(
        <div>
          <div style={{fontSize:12,color:C.mid,marginBottom:14}}>Todos los extras configurados. Para añadir o editar extras abrí el producto con "Editar".</div>
          {extrasLoading&&<div style={{display:'flex',gap:8,alignItems:'center',color:C.mid,fontSize:13,padding:20}}><span className="spin"/>Cargando…</div>}
          {!extrasLoading&&(
            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
              <table style={{width:'100%',borderCollapse:'collapse'}}>
                <thead><tr style={{borderBottom:`1px solid ${C.border}`}}><Th>Nombre del extra</Th><Th>Producto</Th><Th right>Precio</Th><Th>Estado</Th></tr></thead>
                <tbody>
                  {allExtras.map(e=>(
                    <tr key={e.id} style={{borderBottom:`1px solid ${C.border}`}}>
                      <Td>{e.name}</Td>
                      <Td dim style={{fontSize:11}}>{itemName(e.item_id)}</Td>
                      <Td mono right>{e.price_guarani>0?`₲ ${e.price_guarani.toLocaleString('es-PY')}`:'Gratis'}</Td>
                      <Td>
                        <button onClick={()=>toggleExtraActive(e)} style={{background:e.is_active?'rgba(52,199,89,0.1)':'rgba(142,142,147,0.1)',border:`1px solid ${e.is_active?'rgba(52,199,89,0.3)':'rgba(142,142,147,0.3)'}`,color:e.is_active?'#34C759':'#86868B',padding:'2px 9px',fontSize:11,fontWeight:600,borderRadius:5,cursor:'pointer'}}>
                          {e.is_active?'Activo':'Inactivo'}
                        </button>
                      </Td>
                    </tr>
                  ))}
                  {allExtras.length===0&&<EmptyRow cols={4} label="Sin extras configurados — agregalos editando un producto"/>}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── TAB PRODUCTOS ── */}
      {menuTab==='productos'&&(
      <div style={{display:'flex',gap:14}}>
        {/* Sidebar categorías */}
        <div style={{width:165,flexShrink:0}}>
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,marginBottom:10,overflow:'hidden'}}>
            <div style={{padding:'8px 12px',fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,borderBottom:`1px solid ${C.border}`}}>CATEGORÍAS</div>
            {[{id:'all',name:'Todas',cnt:menuItems.length},...categories.map(c=>({id:c.id,name:c.name,cnt:menuItems.filter(i=>i.category_id===c.id).length}))].map(c=>{
              const active=catFilter===c.id;
              const isAll=c.id==='all';
              return <div key={c.id} style={{display:'flex',alignItems:'stretch',background:active?C.card:'none',borderBottom:`1px solid ${C.border}`,borderLeft:active?'2px solid '+C.ink:'2px solid transparent'}}>
                <button onClick={()=>setCatFilter(c.id)} style={{display:'flex',justifyContent:'space-between',flex:1,minWidth:0,textAlign:'left',padding:'8px 12px',background:'none',border:'none',color:active?C.ink:C.dim,fontSize:13,cursor:'pointer'}}>
                  <span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{c.name}</span><span style={{color:C.bs,fontSize:11,flexShrink:0,marginLeft:6}}>{c.cnt}</span>
                </button>
                {!isAll&&<button onClick={()=>deleteCategory(c)} title="Eliminar categoría" style={{background:'none',border:'none',color:C.dim,cursor:'pointer',padding:'0 9px',fontSize:15,lineHeight:1,flexShrink:0}}>×</button>}
              </div>;
            })}
          </div>
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:12}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:7}}>+ CATEGORÍA</div>
            <Inp value={newCat} onChange={e=>setNewCat(e.target.value)} placeholder="Nombre…" onKeyDown={e=>e.key==='Enter'&&addCategory()}/>
            <Btn variant="secondary" onClick={addCategory} style={{marginTop:7,width:'100%'}} small disabled={!newCat.trim()}>Agregar</Btn>
          </div>
        </div>

        {/* Tabla de productos */}
        <div style={{flex:1}}>
          {someSelected&&(
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8,padding:'8px 12px',background:C.card,borderRadius:8,border:`1px solid ${C.border}`}}>
              <span style={{fontSize:13,fontWeight:600,color:C.ink,flex:1}}>{selected.size} item(s) seleccionados</span>
              <Btn small variant="secondary" onClick={()=>bulkToggleAvail(true)}>✓ Activar</Btn>
              <Btn small variant="secondary" onClick={()=>bulkToggleAvail(false)}>✕ Desactivar</Btn>
              <Btn small variant="danger" onClick={bulkDelete}>Eliminar</Btn>
              <button onClick={()=>setSelected(new Set())} style={{background:'none',border:'none',color:C.dim,cursor:'pointer',fontSize:18,lineHeight:1,padding:'0 4px'}}>×</button>
            </div>
          )}
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
            <table style={{width:'100%',borderCollapse:'collapse'}}>
              <thead><tr style={{borderBottom:`1px solid ${C.border}`}}>
                <Th><input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} style={{cursor:'pointer',width:14,height:14}} title={allVisibleSelected?'Deseleccionar todos':'Seleccionar todos'}/></Th>
                <Th>Foto</Th><Th>Nombre</Th><Th>Cat.</Th><Th right>Precio</Th><Th>Promo / Tipo</Th><Th>Estado</Th><Th>Acc.</Th>
              </tr></thead>
              <tbody>
                {visible.map(item=>{
                  const stockBajo=(item.stock_min>0)&&(item.stock!=null)&&(item.stock<=item.stock_min);
                  const discountedPrice = item.discount_pct>0 ? Math.round(item.price_guarani*(100-item.discount_pct)/100) : null;
                  const isSelected=selected.has(item.id);
                  return (
                    <tr key={item.id}
                      style={{borderBottom:`1px solid ${C.border}`,background:isSelected?TINT.blueBg:'transparent'}}>
                      <Td><input type="checkbox" checked={isSelected} onChange={()=>toggleSelect(item.id)} style={{cursor:'pointer',width:14,height:14}} onClick={e=>e.stopPropagation()}/></Td>
                      <Td>
                        {item.image_url
                          ?<img src={item.image_url} alt="" style={{width:36,height:36,objectFit:'cover',borderRadius:4,border:`1px solid ${C.border}`}} onError={e=>{e.target.style.display='none';}}/>
                          :<div style={{width:36,height:36,background:C.bg,borderRadius:4,display:'flex',alignItems:'center',justifyContent:'center',color:C.dim}}><Icon name="utensils" size={14}/></div>}
                      </Td>
                      <Td>
                        <div style={{color:item.is_available?C.ink:C.dim,fontWeight:500}}>{item.name}</div>
                        {item.description&&<div style={{fontSize:11,color:C.dim,marginTop:1,maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{item.description}</div>}
                        {item.dine_in_only&&<span style={{fontSize:9,color:TINT.greenText,background:TINT.greenBg,border:`1px solid ${TINT.greenBorder}`,padding:'1px 5px',borderRadius:3,marginTop:2,display:'inline-block'}}>Solo local</span>}
                      </Td>
                      <Td dim>{catName(item.category_id)}</Td>
                      <Td mono right>
                        {discountedPrice
                          ?<div>
                            <span style={{textDecoration:'line-through',color:C.dim,fontSize:11}}>{fmt(item.price_guarani)}</span>
                            <div style={{color:'#34C759',fontWeight:700}}>{fmt(discountedPrice)}</div>
                          </div>
                          :fmt(item.price_guarani)
                        }
                        {stockBajo&&<div style={{fontSize:9,color:'#C0190F',fontWeight:700,marginTop:2}}>STOCK BAJO</div>}
                      </Td>
                      <Td>
                        <div style={{display:'flex',flexDirection:'column',gap:3}}>
                          {item.promo_tag&&<span style={{background:TINT.amberBg,border:`1px solid ${TINT.amberBorder}`,color:TINT.amberText,padding:'2px 6px',fontSize:11,borderRadius:4,display:'inline-block'}}>{item.promo_tag}</span>}
                          {item.promo_type&&<span style={{background:TINT.blueBg,border:`1px solid ${TINT.blueBorder}`,color:TINT.blueText,padding:'2px 6px',fontSize:10,borderRadius:4,display:'inline-block'}}>{PROMO_LABEL[item.promo_type]}</span>}
                        </div>
                      </Td>
                      <Td>
                        <button onClick={()=>toggleAvail(item)} style={{background:item.is_available?'rgba(52,199,89,0.1)':'rgba(142,142,147,0.1)',border:`1px solid ${item.is_available?'rgba(52,199,89,0.3)':'rgba(142,142,147,0.3)'}`,color:item.is_available?'#34C759':'#86868B',padding:'3px 9px',fontSize:11,fontWeight:600,borderRadius:5,cursor:'pointer'}}>
                          {item.is_available?'Activo':'Inactivo'}
                        </button>
                      </Td>
                      <Td>
                        <div style={{display:'flex',gap:4}}>
                          <Btn small variant="secondary" onClick={()=>setPreviewItem(item)}>Ver</Btn>
                          <Btn small variant="secondary" onClick={()=>setItemModal({item})}>Editar</Btn>
                          <Btn small variant="danger" onClick={()=>deleteItem(item)}>✕</Btn>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
                {visible.length===0&&<EmptyRow cols={8} label="Sin items en esta categoría"/>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════
   MESAS — canvas drag-and-drop + fix is_occupied
══════════════════════════════════════════════ */
const ZONAS_DEF = [
  {value:'salon',    label:'Salón',    bg:TINT.blueBg,   border:TINT.blueBorder,   dot:'#3B82F6'},
  {value:'terraza',  label:'Terraza',  bg:TINT.greenBg,  border:TINT.greenBorder,  dot:'#22C55E'},
  {value:'bar',      label:'Bar',      bg:TINT.amberBg,  border:TINT.amberBorder,  dot:'#F97316'},
  {value:'privado',  label:'Privado',  bg:TINT.purpleBg, border:TINT.purpleBorder, dot:'#A855F7'},
  {value:'exterior', label:'Exterior', bg:TINT.amberBg,  border:TINT.amberBorder,  dot:'#EAB308'},
];
const SHAPES_DEF = [
  {value:'square',    label:'Cuadrada',    icon:'□'},
  {value:'round',     label:'Redonda',     icon:'○'},
  {value:'rectangle', label:'Rectangular', icon:'▭'},
];
const CELL_SZ = 80; const GAP_SZ = 14;
// Coordenadas virtuales: pos_x/pos_y son 0-1000 (porcentaje × 10).
// Cada panel mapea a píxeles reales según el ancho del canvas.
const VCOORD_MAX = 1000;
const CANVAS_ASPECT = 0.55; // height = width × 0.55

function getTableDims(shape) {
  if(shape==='rectangle') return {w:CELL_SZ*1.65, h:CELL_SZ*0.72};
  return {w:CELL_SZ, h:CELL_SZ};
}
function getTableBR(shape) {
  if(shape==='round') return '50%';
  if(shape==='rectangle') return 8;
  return 10;
}
// Layout por defecto en coords virtuales (grid auto centrado)
function defaultVPos(idxInZone, total) {
  const cols = Math.min(Math.max(Math.ceil(Math.sqrt(Math.max(total,1))), 3), 6);
  const rows = Math.max(Math.ceil(total/cols), 1);
  const col = idxInZone % cols;
  const row = Math.floor(idxInZone / cols);
  const stepX = VCOORD_MAX / cols;
  const stepY = VCOORD_MAX / Math.max(rows, 1);
  return { vx: col*stepX + stepX/2, vy: row*stepY + stepY/2 };
}
// Convierte coords virtuales (centro de mesa) a píxeles del canvas (esquina sup-izq)
function vToPx(vx, vy, canvasW, canvasH, tableW, tableH) {
  const cx = (vx / VCOORD_MAX) * canvasW;
  const cy = (vy / VCOORD_MAX) * canvasH;
  return {
    x: Math.max(0, Math.min(canvasW - tableW, cx - tableW/2)),
    y: Math.max(0, Math.min(canvasH - tableH, cy - tableH/2)),
  };
}
function pxToV(px, py, canvasW, canvasH, tableW, tableH) {
  const cx = px + tableW/2;
  const cy = py + tableH/2;
  return {
    vx: Math.max(0, Math.min(VCOORD_MAX, (cx / Math.max(canvasW,1)) * VCOORD_MAX)),
    vy: Math.max(0, Math.min(VCOORD_MAX, (cy / Math.max(canvasH,1)) * VCOORD_MAX)),
  };
}

function buildReservationByTableA(reservations, nowMs, windowHours, alertMinutes) {
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
    if(dt>winMs||dt<-tolMs) return;
    map[r.table_id]={reservation:r,_timeMs:resMs,_alertMinutes:alertMinutes,_minutesUntil:Math.round(dt/60000)};
  });
  return map;
}

function ZonaCanvas({zona, tables, activeOrders, reservationByTable, editMode, dragging, dragOff, setDragging, setDragOff, setTables, onOpenEdit, onOpenDetail, onOpenReservation, onOpenQR, db, layout='map'}) {
  const canvasRef = useRef(null);
  const zd = ZONAS_DEF.find(z=>z.value===zona)||ZONAS_DEF[0];
  const [canvasW, setCanvasW] = useState(0);
  const isGrid = layout==='grid';

  useEffect(() => {
    if(isGrid||!canvasRef.current) return;
    const update = () => { if(canvasRef.current) setCanvasW(canvasRef.current.offsetWidth); };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(canvasRef.current);
    return () => ro.disconnect();
  }, [isGrid]);

  const canvasH = Math.max(Math.round(canvasW * CANVAS_ASPECT), 180);
  // Tamaño de mesa proporcional al lienzo (constreñido) — que no queden chiquitas.
  const cellMap = Math.round(CELL_SZ * Math.min(Math.max(canvasW/820, 0.55), 1.12));
  const dimsMap = shape => shape==='rectangle' ? {w:Math.round(cellMap*1.65), h:Math.round(cellMap*0.72)} : {w:cellMap, h:cellMap};

  function onPointerDown(e,t) {
    if(!editMode) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    setDragOff({x:e.clientX-rect.left, y:e.clientY-rect.top, zona, pointerId:e.pointerId});
    setDragging(t.id);
  }
  function onPointerMove(e) {
    if(!dragging||!canvasRef.current||dragOff.zona!==zona) return;
    e.preventDefault();
    const cr = canvasRef.current.getBoundingClientRect();
    const t = tables.find(x=>x.id===dragging);
    if(!t) return;
    const {w,h} = dimsMap(t.shape||'square');
    const px = Math.max(0, Math.min(cr.width - w, e.clientX-cr.left-dragOff.x));
    const py = Math.max(0, Math.min(cr.height - h, e.clientY-cr.top-dragOff.y));
    const {vx, vy} = pxToV(px, py, cr.width, cr.height, w, h);
    setTables(prev=>prev.map(x=>x.id===dragging?{...x,pos_x:vx,pos_y:vy}:x));
  }
  async function onPointerUp(e) {
    if(!dragging||dragOff.zona!==zona) return;
    const t = tables.find(x=>x.id===dragging);
    if(t&&db) await db.from('tables').update({pos_x:Math.round(t.pos_x),pos_y:Math.round(t.pos_y)}).eq('id',t.id);
    setDragging(null);
  }

  function tileMeta(t) {
    const order = activeOrders.find(o=>o.table_id===t.id);
    const busy = t.is_occupied||!!order;
    const resv = reservationByTable&&reservationByTable[t.id];
    const isAlert = resv&&busy&&resv._minutesUntil<=resv._alertMinutes;
    const isReserved = resv&&!busy;
    const bg = isAlert?TINT.redBg:isReserved?TINT.amberBg:(busy?'var(--surface-hover)':C.surface);
    const bd = isAlert?C.red:isReserved?C.orange:(busy?C.ink:C.border);
    const lblTxt = isAlert?'¡Liberar!':isReserved?'Reservada':(busy?(order?fmt(order.total):'Ocupada'):'Libre');
    const lblCol = isAlert?'#991B1B':isReserved?'#B45309':(busy?'#4B4B4B':'#86868B');
    return {order,busy,resv,isAlert,isReserved,bg,bd,lblTxt,lblCol};
  }
  function tileClick(t,m){
    if(editMode){onOpenEdit(t);return;}
    if(m.resv&&onOpenReservation){onOpenReservation(t,m.resv,m.order);return;}
    if(m.busy) onOpenDetail(t,m.order);
  }
  function tileInner(t,m,numF,subF){
    return(<>
      <div style={{fontSize:numF,fontWeight:800,color:m.isAlert?C.red:C.ink,lineHeight:1}}>{t.number}</div>
      <div style={{fontSize:subF,color:m.lblCol,textAlign:'center',marginTop:3,lineHeight:1.3,fontWeight:m.isAlert?800:500}}>{m.lblTxt}</div>
      {m.resv&&<div style={{fontSize:Math.max(subF-1,7),color:m.lblCol,marginTop:1,fontWeight:700}}>{m.resv.reservation.reservation_time?.slice(0,5)} · {m.resv.reservation.guests}p</div>}
      {m.busy&&!m.resv&&<div style={{width:5,height:5,borderRadius:'50%',background:C.ink,marginTop:3}}/>}
      {editMode&&<div style={{fontSize:Math.max(subF-2,6),color:'#999',marginTop:2,textTransform:'uppercase',letterSpacing:'0.3px'}}>{t.capacity||4}p</div>}
      {!editMode&&onOpenQR&&<button onClick={e=>{e.stopPropagation();onOpenQR(t);}} style={{position:'absolute',top:2,right:2,padding:'1px 4px',background:'rgba(0,0,0,0.08)',border:'none',borderRadius:3,cursor:'pointer',fontSize:7,color:'#444',lineHeight:'12px',fontWeight:700}}>QR</button>}
    </>);
  }
  const header = (
    <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}>
      <div style={{width:8,height:8,borderRadius:'50%',background:zd.dot}}/>
      <div style={{fontSize:12,fontWeight:700,color:'#3D3D3D',textTransform:'uppercase',letterSpacing:'0.5px'}}>{zd.label}</div>
      <div style={{fontSize:11,color:C.dim}}>· {tables.length} {tables.length===1?'mesa':'mesas'}{activeOrders.filter(o=>tables.some(t=>t.id===o.table_id)).length>0?' · '+activeOrders.filter(o=>tables.some(t=>t.id===o.table_id)).length+' activas':''}</div>
    </div>
  );

  // ── Vista CUADRÍCULA: grilla responsive, sin lienzo ni drag ──
  if(isGrid){
    return (
      <div style={{marginBottom:16}}>
        {header}
        {tables.length===0
          ? <div style={{color:'#C0C0C0',fontSize:12,padding:'8px 0 4px'}}>Sin mesas en {zd.label.toLowerCase()}</div>
          : <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(96px,1fr))',gap:10}}>
              {tables.map(t=>{
                const shape = t.shape||'square';
                const m = tileMeta(t);
                return (
                  <div key={t.id} onClick={()=>tileClick(t,m)}
                    style={{position:'relative',minHeight:92,padding:'10px 6px',borderRadius:shape==='round'?'50%':12,
                      background:m.bg,border:`2px solid ${m.bd}`,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',
                      cursor:editMode||m.busy||m.resv?'pointer':'default',userSelect:'none',boxShadow:'0 1px 3px rgba(0,0,0,0.06)',aspectRatio:shape==='round'?'1/1':'auto'}}>
                    {tileInner(t,m,18,9)}
                  </div>
                );
              })}
            </div>}
      </div>
    );
  }

  // ── Vista MAPA: lienzo constreñido (max-width, centrado) + mesas escaladas ──
  const numF = Math.max(Math.round(cellMap*0.2),13);
  const subF = Math.max(Math.round(cellMap*0.105),8);
  return (
    <div style={{marginBottom:16}}>
      {header}
      <div ref={canvasRef} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        style={{position:'relative',width:'100%',maxWidth:880,margin:'0 auto',height:canvasH,background:zd.bg,border:`1.5px solid ${zd.border}`,borderRadius:10,overflow:'hidden',touchAction:editMode?'none':'auto'}}>
        {tables.length===0&&<div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',color:'#C0C0C0',fontSize:12}}>Sin mesas en {zd.label.toLowerCase()}</div>}
        {canvasW>0 && tables.map((t,idx)=>{
          const shape = t.shape||'square';
          const {w,h} = dimsMap(shape);
          const br = getTableBR(shape);
          const hasPos = t.pos_x!=null && t.pos_y!=null;
          const v = hasPos ? {vx:t.pos_x, vy:t.pos_y} : defaultVPos(idx, tables.length);
          const pos = vToPx(v.vx, v.vy, canvasW, canvasH, w, h);
          const m = tileMeta(t);
          const isDrag = dragging===t.id;
          return (
            <div key={t.id}
              onPointerDown={e=>onPointerDown(e,t)}
              onClick={()=>tileClick(t,m)}
              style={{
                position:'absolute', left:pos.x, top:pos.y, width:w, height:h,
                background:m.bg,
                border:`2px solid ${m.bd}`,
                borderRadius:br,
                display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',
                cursor:editMode?'grab':((m.busy||m.resv)?'pointer':'default'),
                userSelect:'none', touchAction:editMode?'none':'auto',
                transition:isDrag?'none':'box-shadow .15s',
                boxShadow:isDrag?'0 8px 24px rgba(0,0,0,0.22)':'0 1px 3px rgba(0,0,0,0.06)',
                zIndex:isDrag?10:1,
              }}>
              {tileInner(t,m,shape==='rectangle'?Math.max(numF-2,11):numF,subF)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MesasPage({tables: tablesProp, orders, restaurant, onRefresh}) {
  const [tables, setTables]    = useState(tablesProp);
  const [editMode, setEditMode] = useState(false);
  const [mesaViewMode, setMesaViewMode] = useState(()=>localStorage.getItem('admin_mesa_view')||'grid'); // default desktop = Cuadrícula
  const [modal, setModal]       = useState(null);
  const [qrModal, setQrModal]   = useState(null);
  const [formModal, setFormModal]= useState(null);
  const [form, setForm]         = useState({number:'',capacity:'4',zona:'salon',shape:'square'});
  const [saving, setSaving]     = useState(false);
  const [dragging, setDragging] = useState(null);
  const [dragOff, setDragOff]   = useState({x:0,y:0,zona:null});
  const [reservationsToday,setReservationsToday] = useState([]);
  const [resvInfo,setResvInfo] = useState(null);
  const [nowTick,setNowTick] = useState(Date.now());

  useEffect(()=>{ setTables(tablesProp); },[tablesProp]);
  useEffect(()=>{ localStorage.setItem('admin_mesa_view',mesaViewMode); },[mesaViewMode]);

  useEffect(()=>{
    const id = setInterval(()=>setNowTick(Date.now()),60000);
    return ()=>clearInterval(id);
  },[]);

  useEffect(()=>{
    if(!db) return;
    const todayStr = new Date().toISOString().slice(0,10);
    db.from('reservations').select('*').eq('restaurant_id',RID).eq('reservation_date',todayStr).eq('status','confirmed')
      .then(({data})=>setReservationsToday(data||[]));
    const ch = db.channel('mesas-resv-rt')
      .on('postgres_changes',{event:'*',schema:'public',table:'reservations',filter:`restaurant_id=eq.${RID}`}, ()=>{
        db.from('reservations').select('*').eq('restaurant_id',RID).eq('reservation_date',todayStr).eq('status','confirmed')
          .then(({data})=>setReservationsToday(data||[]));
      }).subscribe();
    return ()=>{ db.removeChannel(ch); };
  },[]);

  const resvWindow = Number(restaurant?.reservation_window_hours ?? 3);
  const resvAlertMin = Number(restaurant?.reservation_alert_minutes ?? 30);
  const reservationByTable = useMemo(
    ()=>buildReservationByTableA(reservationsToday,nowTick,resvWindow,resvAlertMin),
    [reservationsToday,nowTick,resvWindow,resvAlertMin]
  );

  useEffect(()=>{
    if(!db) return;
    const ch = db.channel('mesas-rt')
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'tables',filter:`restaurant_id=eq.${RID}`}, payload=>{
        setTables(prev=>prev.map(t=>t.id===payload.new.id?{...t,...payload.new}:t));
      })
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'tables',filter:`restaurant_id=eq.${RID}`}, ()=>{ if(!_shouldPause()) onRefresh(); })
      .on('postgres_changes',{event:'DELETE',schema:'public',table:'tables',filter:`restaurant_id=eq.${RID}`}, ()=>{ if(!_shouldPause()) onRefresh(); })
      .subscribe();
    return ()=>{ db.removeChannel(ch); };
  },[]);

  const activeOrders = orders.filter(o=>['paid','kitchen_received','cooking','ready'].includes(o.status));

  async function saveTable() {
    if(!db||!form.number){toast('Número de mesa requerido',false);return;}
    const num=parseInt(form.number);
    if(isNaN(num)||num<1){toast('Número inválido',false);return;}
    setSaving(true);
    const zonaChanged = formModal.mode==='edit' && formModal.table.zona!==form.zona;
    if(formModal.mode==='add') {
      const token=(crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2)).replace(/-/g,'').slice(0,16);
      const{error}=await db.from('tables').insert({restaurant_id:RID,number:num,capacity:parseInt(form.capacity)||4,qr_token:token,pos_x:null,pos_y:null,zona:form.zona||'salon',shape:form.shape||'square'}).select().single();
      if(error){toast('Error: '+error.message,false);}
      else{toast('Mesa '+num+' creada');onRefresh();setFormModal(null);}
    } else {
      const upd={number:num,capacity:parseInt(form.capacity)||4,zona:form.zona||'salon',shape:form.shape||'square'};
      if(zonaChanged){upd.pos_x=null;upd.pos_y=null;}
      const{data,error}=await db.from('tables').update(upd).eq('id',formModal.table.id).select('id');
      if(error){toast('Error: '+error.message,false);}
      else if(!data||data.length===0){toast('No se pudo actualizar — verificá RLS en Supabase',false);}
      else{toast('Mesa actualizada');onRefresh();setFormModal(null);}
    }
    setSaving(false);
  }

  async function deleteTable(t) {
    const hasActive=activeOrders.some(o=>o.table_id===t.id);
    if(hasActive){toast('Mesa con pedido activo, no se puede eliminar',false);return;}
    if(!confirm(`¿Eliminar Mesa ${t.number}?`))return;
    const{data,error}=await db.from('tables').delete().eq('id',t.id).select('id');
    if(error){toast('Error: '+error.message,false);}
    else if(!data||data.length===0){toast('No se pudo eliminar — verificá RLS DELETE en Supabase',false);}
    else{toast('Mesa eliminada');onRefresh();}
  }

  function openEdit(t) {
    setForm({number:String(t.number),capacity:String(t.capacity||4),zona:t.zona||'salon',shape:t.shape||'square'});
    setFormModal({mode:'edit',table:t});
  }

  // Agrupar por zona; mostrar todas las zonas que tengan mesas + en editMode mostrar vacías también
  const zonaMap = {};
  tables.forEach(t=>{ const z=t.zona||'salon'; if(!zonaMap[z]) zonaMap[z]=[]; zonaMap[z].push(t); });
  const zonasToShow = editMode
    ? ZONAS_DEF
    : ZONAS_DEF.filter(z=>zonaMap[z.value]?.length>0);

  return (
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
        <div>
          <h1 style={{fontSize:22,fontWeight:800,color:C.ink}}>Mesas</h1>
          <div style={{fontSize:12,color:C.mid,marginTop:2}}>{activeOrders.length} con pedidos activos · {tables.length} mesas</div>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
          {/* Toggle Cuadrícula / Mapa */}
          <div style={{display:'flex',gap:4,background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:3}}>
            <button onClick={()=>{setMesaViewMode('grid');setDragging(null);}}
              style={{padding:'6px 12px',borderRadius:6,border:'none',fontSize:12,fontWeight:700,cursor:'pointer',background:mesaViewMode==='grid'?C.ink:'transparent',color:mesaViewMode==='grid'?C.sidebar:C.mid}}>
              <Icon name="layout" size={13} style={{verticalAlign:'-2px',marginRight:3}}/> Cuadrícula
            </button>
            <button onClick={()=>setMesaViewMode('mapa')}
              style={{padding:'6px 12px',borderRadius:6,border:'none',fontSize:12,fontWeight:700,cursor:'pointer',background:mesaViewMode==='mapa'?C.ink:'transparent',color:mesaViewMode==='mapa'?C.sidebar:C.mid}}>
              <Icon name="pin" size={13} style={{verticalAlign:'-2px',marginRight:3}}/> Mapa
            </button>
          </div>
          <button onClick={()=>{setEditMode(e=>!e);setDragging(null);}} style={{padding:'8px 16px',border:`1px solid ${C.border}`,borderRadius:6,background:editMode?C.ink:'transparent',color:editMode?C.sidebar:C.dim,fontSize:12,fontWeight:600,cursor:'pointer'}}>
            {editMode?'Modo vista':'Modo edición'}
          </button>
          <button onClick={()=>setQrModal('all')} style={{padding:'8px 14px',border:`1px solid ${C.border}`,borderRadius:6,background:'transparent',color:C.mid,fontSize:12,fontWeight:600,cursor:'pointer'}}>Imprimir QR</button>
          <Btn onClick={()=>{setForm({number:'',capacity:'4',zona:'salon',shape:'square'});setFormModal({mode:'add'});}}>+ Nueva mesa</Btn>
        </div>
      </div>

      {editMode&&<div style={{fontSize:11,color:C.dim,marginBottom:14,padding:'8px 14px',background:C.bg,borderRadius:6}}>{mesaViewMode==='mapa'?'Arrastrá las mesas dentro de su zona para posicionarlas. Para cambiar de zona, editá la mesa. En modo vista, click en una mesa ocupada muestra sus pedidos.':'Tocá una mesa para editarla. Cambiá a la vista Mapa para arrastrar y posicionar las mesas.'}</div>}

      {tables.length===0&&!editMode&&<div style={{padding:40,textAlign:'center',color:'#C0C0C0',fontSize:13}}>No hay mesas. Creá la primera.</div>}

      {zonasToShow.map(z=>(
        <ZonaCanvas key={z.value}
          zona={z.value}
          layout={mesaViewMode==='grid'?'grid':'map'}
          tables={zonaMap[z.value]||[]}
          activeOrders={activeOrders}
          reservationByTable={reservationByTable}
          editMode={editMode}
          dragging={dragging}
          dragOff={dragOff}
          setDragging={setDragging}
          setDragOff={setDragOff}
          setTables={setTables}
          onOpenEdit={openEdit}
          onOpenDetail={(t,order)=>setModal({table:t,order})}
          onOpenReservation={(t,resv,order)=>setResvInfo({table:t,info:resv,order})}
          onOpenQR={t=>setQrModal(t)}
          db={db}
        />
      ))}

      {/* Modal QR de mesa */}
      {qrModal&&qrModal!=='all'&&<QrModal table={qrModal} restaurant={restaurant} onClose={()=>setQrModal(null)} />}
      {qrModal==='all'&&<QrAllModal tables={tables} restaurant={restaurant} onClose={()=>setQrModal(null)} />}

      {/* Modal de info de reserva */}
      {resvInfo&&(()=>{
        const r=resvInfo.info.reservation;
        const mins=resvInfo.info._minutesUntil;
        const horaTxt=r.reservation_time?.slice(0,5)||'';
        const tiempoTxt=mins>0?`en ${mins<60?mins+' min':Math.floor(mins/60)+'h '+(mins%60)+'m'}`:`hace ${Math.abs(mins)} min`;
        const occ=resvInfo.table.is_occupied||!!resvInfo.order;
        const isAlert=occ&&mins<=resvAlertMin;
        return(
          <Modal title={`Mesa ${resvInfo.table.number} — ${isAlert?'Reserva próxima':'Reservada'}`} onClose={()=>setResvInfo(null)} width={420}>
            <div style={{display:'flex',flexDirection:'column',gap:10}}>
              {isAlert&&(
                <div style={{background:TINT.redBg,border:`1px solid ${TINT.redBorder}`,borderRadius:8,padding:'10px 12px',fontSize:12,color:TINT.redText}}>
                  Esta mesa está ocupada y la reserva es {tiempoTxt}. Avisá al mozo para pedir la cuenta.
                </div>
              )}
              <div style={{background:TINT.amberBg,border:`1px solid ${TINT.amberBorder}`,borderRadius:8,padding:'12px 14px'}}>
                <div style={{fontSize:16,fontWeight:800,color:C.ink,marginBottom:6}}>{r.customer_name}</div>
                <div style={{fontSize:13,color:'#3D3D3D',lineHeight:1.7}}>
                  <Icon name="phone" size={12} style={{verticalAlign:'-2px',marginRight:4}}/> {r.customer_phone}<br/>
                  <Icon name="clock" size={12} style={{verticalAlign:'-2px',marginRight:4}}/> Hora reservada: <strong>{horaTxt}</strong> ({tiempoTxt})<br/>
                  <Icon name="users" size={12} style={{verticalAlign:'-2px',marginRight:4}}/> {r.guests} personas{r.occasion?<><br/><Icon name="sparkles" size={12} style={{verticalAlign:'-2px',marginRight:4}}/> Motivo: {r.occasion}</>:null}
                  {r.notes?<><br/><Icon name="fileText" size={12} style={{verticalAlign:'-2px',marginRight:4}}/> {r.notes}</>:null}
                </div>
                <div style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:11,color:C.dim,marginTop:8}}>Confirmación {r.confirm_num}</div>
              </div>
              <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:6}}>
                {resvInfo.order&&<Btn variant="ghost" small onClick={()=>{setModal({table:resvInfo.table,order:resvInfo.order});setResvInfo(null);}}>Ver pedido actual</Btn>}
                <Btn variant="ghost" onClick={()=>setResvInfo(null)}>Cerrar</Btn>
              </div>
            </div>
          </Modal>
        );
      })()}

      {/* Modal detalle mesa ocupada */}
      {modal&&!editMode&&(
        <Modal title={`Mesa ${modal.table.number}`} onClose={()=>setModal(null)} width={420}>
          {modal.order?(
            <div>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:16}}>
                <div>
                  <div style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:13,color:C.dim}}>{modal.order.order_number}</div>
                  <div style={{fontSize:11,color:C.dim}}>{fmtTime(modal.order.created_at)}</div>
                </div>
                <Badge status={modal.order.status}/>
              </div>
              <div style={{fontSize:20,fontWeight:800,color:C.ink,marginBottom:20}}>{fmt(modal.order.total)}</div>
              <div style={{display:'flex',gap:8}}>
                <Btn style={{flex:1}} onClick={()=>setModal(null)}>Cerrar</Btn>
                <button onClick={()=>{openEdit(modal.table);setModal(null);}} style={{padding:'8px 14px',border:`1px solid ${C.border}`,borderRadius:6,fontSize:12,cursor:'pointer',background:'transparent',color:C.mid}}>Editar mesa</button>
              </div>
            </div>
          ):<div style={{color:C.mid,fontSize:13}}>Sin pedido activo en esta mesa.</div>}
        </Modal>
      )}

      {/* Modal crear/editar */}
      {formModal&&(
        <Modal title={formModal.mode==='add'?'Nueva mesa':'Editar mesa'} onClose={()=>setFormModal(null)} width={380}>
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
              <div><Lbl>NÚMERO *</Lbl><Inp type="number" mono value={form.number} onChange={e=>setForm({...form,number:e.target.value})} placeholder="1"/></div>
              <div><Lbl>LUGARES</Lbl><Inp type="number" mono value={form.capacity} onChange={e=>setForm({...form,capacity:e.target.value})} placeholder="4"/></div>
            </div>
            <div>
              <Lbl>ZONA / SECTOR</Lbl>
              <div style={{display:'flex',gap:6,flexWrap:'wrap',marginTop:4}}>
                {ZONAS_DEF.map(z=>(
                  <button key={z.value} type="button" onClick={()=>setForm(prev=>({...prev,zona:z.value}))}
                    style={{padding:'5px 12px',borderRadius:20,border:`1.5px solid ${form.zona===z.value?C.ink:C.border}`,background:form.zona===z.value?C.ink:'transparent',color:form.zona===z.value?C.sidebar:C.ink,fontSize:12,cursor:'pointer',fontWeight:form.zona===z.value?700:400,transition:'all .1s'}}>
                    {z.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Lbl>FORMA DE LA MESA</Lbl>
              <div style={{display:'flex',gap:8,marginTop:4}}>
                {SHAPES_DEF.map(s=>(
                  <button key={s.value} type="button" onClick={()=>setForm(prev=>({...prev,shape:s.value}))}
                    style={{flex:1,padding:'10px 6px',borderRadius:8,border:`2px solid ${form.shape===s.value?C.ink:C.border}`,background:form.shape===s.value?C.ink:'transparent',color:form.shape===s.value?C.sidebar:C.ink,fontSize:11,cursor:'pointer',fontWeight:600,textAlign:'center',transition:'all .1s',display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
                    <span style={{fontSize:20,pointerEvents:'none'}}>{s.icon}</span>
                    <span style={{pointerEvents:'none'}}>{s.label}</span>
                  </button>
                ))}
              </div>
            </div>
            {formModal.mode==='edit'&&formModal.table.zona!==form.zona&&(
              <div style={{fontSize:11,color:C.dim,background:TINT.amberBg,border:`1px solid ${TINT.amberBorder}`,borderRadius:6,padding:'8px 10px'}}>
                Al cambiar de zona, la mesa se reposicionará automáticamente en la nueva zona.
              </div>
            )}
            {formModal.mode==='edit'&&formModal.table.qr_token&&(
              <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:6,padding:10}}>
                <div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:4}}>TOKEN QR</div>
                <div style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:11,color:C.dim,wordBreak:'break-all'}}>{formModal.table.qr_token}</div>
              </div>
            )}
            <div style={{display:'flex',gap:8,marginTop:4}}>
              <Btn onClick={saveTable} disabled={saving}>{saving?'Guardando…':formModal.mode==='add'?'Crear':'Guardar'}</Btn>
              <Btn variant="ghost" onClick={()=>setFormModal(null)}>Cancelar</Btn>
              {formModal.mode==='edit'&&<Btn variant="danger" small onClick={()=>{deleteTable(formModal.table);setFormModal(null);}}>Eliminar</Btn>}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════
   QR MODALS
══════════════════════════════════════════════ */
function _buildQrUrl(table) {
  const origin = window.location.protocol + '//' + window.location.host;
  // Incluir restaurante: el QR lo escanea un cliente externo (sin localStorage) → debe llevar el local.
  return `${origin}/?r=${encodeURIComponent(RID)}&t=${encodeURIComponent(table.qr_token)}`;
}

function QrModal({table, restaurant, onClose}) {
  const [session, setSession] = React.useState(null);
  const tableUrl = _buildQrUrl(table);
  const qrImg    = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(tableUrl)}&margin=10`;

  React.useEffect(()=>{
    if(!db) return;
    db.from('table_scan_sessions')
      .select('scan_count,max_scans,started_at')
      .eq('table_id', table.id)
      .is('ended_at', null)
      .order('started_at',{ascending:false})
      .limit(1)
      .maybeSingle()
      .then(({data})=>setSession(data));
  },[table.id]);

  function printQR() {
    const w = window.open('','_blank','width=520,height=680');
    if(!w) return;
    const restName = restaurant?.name || 'Restaurante';
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>QR Mesa ${table.number}</title><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:system-ui,sans-serif;background:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:32px;}div.card{text-align:center;border:1.5px solid #E5E5E7;border-radius:16px;padding:32px;max-width:320px;width:100%;}img{border-radius:8px;margin-bottom:20px;}h1{font-size:32px;font-weight:900;color:#000;margin-bottom:4px;}p.rest{font-size:14px;color:#86868B;margin-bottom:8px;}p.cap{font-size:12px;color:#C0C0C0;margin-top:8px;}@media print{body{padding:0;}div.card{border:none;border-radius:0;}}</style></head><body><div class="card"><img src="${qrImg}" width="260" height="260"/><h1>Mesa ${table.number}</h1><p class="rest">${restName}</p><p class="cap">${table.capacity||4} personas &middot; Escaneá para ver el menú</p></div><script>window.onload=function(){window.print();}<\/script></body></html>`);
    w.document.close();
  }

  const cap = table.capacity || 4;
  const sessionFull = session && session.scan_count >= session.max_scans;

  return (
    <Modal title={`QR · Mesa ${table.number}`} onClose={onClose} width={380}>
      <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:14}}>
        <img src={qrImg} width={220} height={220} style={{borderRadius:12,border:`1px solid ${C.border}`}} alt="QR" />
        <div style={{width:'100%',background:C.bg,borderRadius:8,padding:'9px 12px'}}>
          <div style={{fontSize:10,color:C.dim,fontWeight:700,marginBottom:3}}>URL</div>
          <div style={{fontSize:10,color:C.ink,wordBreak:'break-all',fontFamily:"'SF Mono',ui-monospace,monospace"}}>{tableUrl}</div>
        </div>
        <div style={{display:'flex',gap:10,width:'100%'}}>
          <div style={{flex:1,background:C.bg,borderRadius:8,padding:'8px 10px',textAlign:'center'}}>
            <div style={{fontWeight:800,fontSize:20}}>{table.number}</div>
            <div style={{color:C.dim,fontSize:10,marginTop:2}}>Mesa</div>
          </div>
          <div style={{flex:1,background:C.bg,borderRadius:8,padding:'8px 10px',textAlign:'center'}}>
            <div style={{fontWeight:800,fontSize:20}}>{cap}</div>
            <div style={{color:C.dim,fontSize:10,marginTop:2}}>Lugares</div>
          </div>
          {session ? (
            <div style={{flex:1,background:sessionFull?TINT.redBg:TINT.greenBg,borderRadius:8,padding:'8px 10px',textAlign:'center'}}>
              <div style={{fontWeight:800,fontSize:20,color:sessionFull?TINT.redText:TINT.greenText}}>{session.scan_count}/{session.max_scans}</div>
              <div style={{color:C.dim,fontSize:10,marginTop:2}}>Sesión</div>
            </div>
          ) : (
            <div style={{flex:1,background:C.bg,borderRadius:8,padding:'8px 10px',textAlign:'center'}}>
              <div style={{fontWeight:800,fontSize:20,color:'#C0C0C0'}}>—</div>
              <div style={{color:C.dim,fontSize:10,marginTop:2}}>Sin sesión</div>
            </div>
          )}
        </div>
        <Btn onClick={printQR} style={{width:'100%'}}>Imprimir QR</Btn>
      </div>
    </Modal>
  );
}

function QrAllModal({tables, restaurant, onClose}) {
  function printAll() {
    const restName = restaurant?.name || 'Restaurante';
    const cards = tables.map(t => {
      const url = _buildQrUrl(t);
      const img = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(url)}&margin=8`;
      return `<div class="card"><img src="${img}" width="200" height="200"/><h2>Mesa ${t.number}</h2><p>${t.capacity||4} personas</p></div>`;
    }).join('');
    const w = window.open('','_blank','width=900,height=700');
    if(!w) return;
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>QR Mesas — ${restName}</title><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:system-ui,sans-serif;background:#fff;padding:24px;}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;}.card{text-align:center;border:1.5px solid #E5E5E7;border-radius:12px;padding:20px;}img{border-radius:6px;margin-bottom:12px;}h2{font-size:22px;font-weight:900;color:#000;margin-bottom:4px;}p{font-size:11px;color:#86868B;}h1.title{font-size:18px;font-weight:700;color:#000;margin-bottom:20px;}@media print{body{padding:0;}.card{border:1px solid #ccc;break-inside:avoid;}}</style></head><body><h1 class="title">${restName} — QR de mesas</h1><div class="grid">${cards}</div><script>window.onload=function(){window.print();}<\/script></body></html>`);
    w.document.close();
  }

  return (
    <Modal title="Imprimir QR de todas las mesas" onClose={onClose} width={400}>
      <div style={{display:'flex',flexDirection:'column',gap:12}}>
        <div style={{fontSize:13,color:C.mid,lineHeight:1.6}}>
          Se abrirá una página lista para imprimir con los QR de las <strong>{tables.length} mesas</strong>. Cada QR apunta directamente a la mesa correspondiente y respeta el límite de escaneos.
        </div>
        <div style={{background:C.bg,borderRadius:8,padding:'10px 14px',fontSize:12,color:C.dim}}>
          También podés imprimir mesa por mesa haciendo click en <strong>QR</strong> sobre cada mesa del plano.
        </div>
        <Btn onClick={printAll}>Abrir página de impresión</Btn>
      </div>
    </Modal>
  );
}

/* ══════════════════════════════════════════════
   PERSONAL
══════════════════════════════════════════════ */
function PersonalPage() {
  const [tab,setTab]           = useState('empleados');
  const [profiles,setProfiles] = useState([]);
  const [loading,setLoading]   = useState(true);
  const [error,setError]       = useState(null);
  const [editId,setEditId]     = useState(null);
  const [editRole,setEditRole] = useState('');
  const [editActive,setEditActive] = useState(true);
  const [addModal,setAddModal] = useState(false);
  const [addForm,setAddForm]   = useState({full_name:'',username:'',password:'',pin:'',role:'mozo',dni:'',phone:'',email:'',notes:'',_reqId:null});
  const [addLoading,setAddLoading] = useState(false);

  // Turnos / Conexiones — se alimenta de staff_sessions (login real de cada panel), no de carga manual.
  const [shifts,setShifts]         = useState([]);
  const [loadingShifts,setLS]      = useState(false);
  const [shiftDate,setShiftDate]   = useState(new Date().toISOString().slice(0,10));
  const [forcingId,setForcingId]   = useState(null);

  // Solicitudes de personal (desde gerente)
  const [reqs,setReqs]             = useState([]);
  const [loadingReqs,setLR]        = useState(false);
  const [rejectModal,setRejectModal] = useState(null); // {id, name}
  const [rejectNotes,setRejectNotes] = useState('');
  const [rejectSaving,setRS]       = useState(false);
  const [approvingId,setApprovingId] = useState(null);

  // Normaliza un registro de delivery_riders al shape de la grilla de personal.
  function riderToProfile(r) {
    return {
      id:r.id, _isRider:true, rider_pin:r.rider_pin, user_id:r.user_id||null,
      username:r.rider_pin?('PIN '+r.rider_pin):'—',
      display_name:r.name||'—', role:'rider', email:r.phone||'—',
      is_active:r.active!==false, created_at:r.created_at
    };
  }

  // El email `${cédula|usuario}@mythos.internal` es un handle INTERNO de login, no el
  // correo de la persona → nunca se muestra. Se muestra el correo real (recovery_email)
  // si existe, o "—".
  function displayEmail(p) {
    const e = (p && p.email) || '';
    if (/@mythos\.internal$/i.test(e)) return (p && p.recovery_email) || '—';
    return e || (p && p.recovery_email) || '—';
  }

  async function loadProfiles() {
    if(!db){setLoading(false);return;}
    setLoading(true); setError(null);
    // Los riders viven en delivery_riders (perfil operativo, vinculado a la cuenta por user_id).
    // Se toman de acá y se filtran de user_roles para no duplicar (login por correo+contraseña).
    const ridersP = db.from('delivery_riders').select('id,name,phone,rider_pin,active,created_at,user_id').eq('restaurant_id',RID).order('name');
    let base=null, errMsg=null;
    const {data:rpcData,error:rpcErr} = await db.rpc('admin_list_restaurant_users',{p_restaurant_id:RID});
    if(!rpcErr){ base = rpcData||[]; }
    else {
      const{data,error:e}=await db.from('user_roles').select('id,user_id,username,display_name,role,email,recovery_email,is_active,created_at').eq('restaurant_id',RID).order('created_at',{ascending:false});
      if(!e){ base = data||[]; }
      else {
        const uid=(await db.auth.getUser()).data?.user?.id||'';
        const{data:me,error:meErr}=await db.from('user_roles').select('id,user_id,username,display_name,role,email,recovery_email,is_active,created_at').eq('user_id',uid).limit(1);
        if(!meErr&&me?.length){ base = me; }
        else errMsg = rpcErr?.message||e?.message||'Sin acceso a user_roles';
      }
    }
    const{data:ridersData}=await ridersP;
    // Evitar duplicar riders que también puedan figurar en user_roles con rol rider.
    const baseNoRider = (base||[]).filter(p=>(p.role||'').toLowerCase()!=='rider'&&(p.role||'').toLowerCase()!=='repartidor');
    const riderRows = (ridersData||[]).map(riderToProfile);
    if(base===null && riderRows.length===0){ setError(`Error al cargar personal: ${errMsg||'Sin acceso a user_roles'}`); setLoading(false); return; }
    setProfiles([...baseNoRider, ...riderRows]);
    setLoading(false);
  }

  async function loadShifts() {
    if(!db) return;
    setLS(true);
    const s = new Date(shiftDate); s.setHours(0,0,0,0);
    const e = new Date(shiftDate); e.setHours(23,59,59,999);
    const{data}=await db.from('staff_sessions').select('*').eq('restaurant_id',RID).gte('login_at',s.toISOString()).lte('login_at',e.toISOString()).order('login_at',{ascending:false});
    setShifts(data||[]);
    setLS(false);
  }

  async function loadReqs() {
    if(!db) return;
    setLR(true);
    const{data}=await db.from('staff_requests').select('*').eq('restaurant_id',RID).order('created_at',{ascending:false});
    setReqs(data||[]);
    setLR(false);
  }

  useEffect(()=>{ loadProfiles(); },[]);
  useEffect(()=>{ if(tab==='turnos') loadShifts(); },[tab,shiftDate]);
  useEffect(()=>{ if(tab==='solicitudes') loadReqs(); },[tab]);

  useEffect(()=>{
    if(!db) return;
    const ch = db.channel('personal-rt')
      .on('postgres_changes',{event:'*',schema:'public',table:'user_roles',filter:`restaurant_id=eq.${RID}`},()=>{ if(!_shouldPause()) loadProfiles(); })
      .on('postgres_changes',{event:'*',schema:'public',table:'delivery_riders',filter:`restaurant_id=eq.${RID}`},()=>{ if(!_shouldPause()) loadProfiles(); })
      .on('postgres_changes',{event:'*',schema:'public',table:'staff_sessions',filter:`restaurant_id=eq.${RID}`},()=>{ if(!_shouldPause()) loadShifts(); })
      .subscribe();
    return ()=>{ db.removeChannel(ch); };
  },[tab]);

  async function saveRole(id) {
    if(!db)return;
    const prof = profiles.find(x=>x.id===id);
    // Riders viven en delivery_riders: su rol es fijo, sólo se cambia el estado activo.
    if(prof?._isRider){
      const{error}=await db.from('delivery_riders').update({active:editActive}).eq('id',id);
      if(error){toast('Error: '+error.message,false);return;}
      toast('Rider actualizado');
      setProfiles(p=>p.map(x=>x.id===id?{...x,is_active:editActive}:x));
      setEditId(null);
      return;
    }
    // PR-3: la gestión de roles/estado del personal es superadmin-only en el backend
    // (admin_update_user_role y admin_toggle_user exigen superadmin; la RLS de
    // user_roles sólo permite escritura a superadmin). La llamada previa pasaba
    // argumentos que NO coinciden con la firma real del RPC
    // (admin_update_user_role(p_user_id, p_role, p_restaurant_id, p_display_name))
    // y caía a un UPDATE directo a user_roles que RLS bloquea sin error → mostraba
    // "Usuario actualizado" sin persistir (ghost write). Hasta que el backend
    // habilite la gestión por un admin del mismo restaurante (migración con tenant
    // guard), se deshabilita con un mensaje claro en vez de simular el guardado.
    toast('La gestión de roles y estado del personal se realiza desde el panel Superadmin.', false);
    setEditId(null);
  }

  async function addEmployee() {
    if(!db){toast('Sin conexión',false);return;}
    const{full_name,username,password,pin,role,email,phone}=addForm;
    if(!full_name.trim()){toast('Ingresá el nombre completo',false);return;}

    // Riders: ahora se crean como el resto del personal (cuenta auth con usuario+contraseña).
    // El endpoint /api/create-user, además de la cuenta, crea su ficha en delivery_riders
    // vinculada por user_id (vehículo/comisión por defecto, editables en Delivery → Riders).
    const cedDigits=(username||'').replace(/\D/g,'');
    if(cedDigits.length<4||cedDigits.length>10){toast('Ingresá una cédula válida (solo números)',false);return;}
    if(email&&email.trim()&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())){toast('El email de recuperación no es válido',false);return;}
    if(typeof password!=='string'||!password.trim()||password.length<8){toast('Ingresá una contraseña de al menos 8 caracteres para crear el usuario.',false);return;}
    setAddLoading(true);
    try {
      const{data:{session}}=await db.auth.getSession();
      const token=session?.access_token;
      if(!token) throw new Error('Sin sesión activa');
      const resp=await fetch('/api/create-user',{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
        body:JSON.stringify({cedula:cedDigits,recovery_email:email.trim()||undefined,password,display_name:full_name.trim(),role,restaurant_id:RID,phone:phone||undefined})
      });
      const result=await resp.json();
      if(!resp.ok) throw new Error(result.error||'Error desconocido');
      // reused = la cédula ya tenía cuenta (trabaja en otro local) → se la vinculó a
      // este restaurante reusando su usuario. Se nombra a la persona para detectar
      // una cédula mal tipeada ("otra persona").
      toast(result.reused
        ? `Vinculado a la cuenta existente${result.linked_name?` de ${result.linked_name}`:''} en este restaurante`
        : `Empleado "${result.username}" creado`);
      if(addForm._reqId){
        const{data:{user:me}}=await db.auth.getUser();
        await db.from('staff_requests').update({status:'approved',reviewed_by:me?.id,reviewed_at:new Date().toISOString()}).eq('id',addForm._reqId);
        setReqs(r=>r.map(x=>x.id===addForm._reqId?{...x,status:'approved'}:x));
      }
      setAddModal(false);
      setAddForm({full_name:'',username:'',password:'',pin:'',role:'mozo',dni:'',phone:'',email:'',notes:'',_reqId:null});
      loadProfiles();
    } catch(e){toast(e.message,false);}
    setAddLoading(false);
  }

  function openApprove(req) {
    setAddForm({full_name:req.full_name||'',username:(req.dni||req.username||'').replace(/\D/g,''),password:'',pin:(req.role==='rider'?genRiderPin():''),role:req.role||'mozo',dni:req.dni||'',phone:req.phone||'',email:req.email||'',notes:req.notes||'',_reqId:req.id});
    setAddModal(true);
  }

  async function confirmReject() {
    if(!rejectModal||!db) return;
    setRS(true);
    const{data:{user:me}}=await db.auth.getUser();
    const{error}=await db.from('staff_requests').update({status:'rejected',reviewed_by:me?.id,reviewed_at:new Date().toISOString(),review_notes:rejectNotes.trim()}).eq('id',rejectModal.id);
    setRS(false);
    if(error){toast('Error: '+error.message,false);return;}
    toast('Solicitud rechazada');
    setReqs(r=>r.map(x=>x.id===rejectModal.id?{...x,status:'rejected',review_notes:rejectNotes.trim()}:x));
    setRejectModal(null); setRejectNotes('');
  }

  // Cierre forzado por el admin de una sesión que quedó abierta (deslogeo / cierre de pestaña / caída).
  async function forzarCierre(sess) {
    if(!db) return;
    setForcingId(sess.id);
    const{error}=await db.from('staff_sessions').update({logout_at:new Date().toISOString(),logout_reason:'forzado_admin'}).eq('id',sess.id).is('logout_at',null);
    setForcingId(null);
    if(error){toast('Error: '+error.message,false);return;}
    toast('Sesión cerrada'); loadShifts();
  }

  // Minutos de una sesión: hasta el logout, o hasta ahora si sigue abierta.
  function sessionMin(s) {
    const fin = s.logout_at ? new Date(s.logout_at) : new Date();
    return Math.max(0, Math.round((fin-new Date(s.login_at))/60000));
  }
  function duracion(s) {
    return `${Math.floor(sessionMin(s)/60)}h ${sessionMin(s)%60}m`;
  }
  // Estado de una conexión (sin heartbeat): cerrada / en línea hoy / abierta de día anterior.
  function sessionEstado(s) {
    if(s.logout_at) return {label:'CERRADO',color:C.dim,bg:C.card};
    const esHoy = new Date(s.login_at).toISOString().slice(0,10)===new Date().toISOString().slice(0,10);
    return esHoy
      ? {label:'EN LÍNEA',color:C.green,bg:'rgba(52,199,89,0.15)'}
      : {label:'SIN CIERRE',color:C.orange,bg:'rgba(249,115,22,0.12)'};
  }
  function horasTrabajadas(empName) {
    return shifts.filter(s=>s.employee_name===empName).reduce((acc,s)=>acc+sessionMin(s),0);
  }
  // Roster de quién NO se conectó en la fecha elegida (sólo roles operativos).
  function matchSesion(prof) {
    return shifts.some(s=> prof._isRider ? s.rider_id===prof.id : (prof.user_id && s.user_id===prof.user_id));
  }
  const ROLES_OPERATIVOS = ['mozo','waiter','cajero','caja','cocina','cocinero','rider','repartidor','gerente','supervisor_local'];
  const rosterEsperado = profiles.filter(p=>p.is_active!==false && ROLES_OPERATIVOS.includes((p.role||'').toLowerCase()));
  const sinConexion = rosterEsperado.filter(p=>!matchSesion(p));
  const esHoySel = shiftDate===new Date().toISOString().slice(0,10);

  const roleColor={cocina:C.orange,admin:C.blue,superadmin:C.purple,waiter:C.green,mozo:C.green,cajero:C.yellow,delivery:'#06b6d4',rider:'#06b6d4',supervisor_local:C.purple};

  return (
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
        <h1 style={{fontSize:22,fontWeight:800,color:C.ink}}>Personal</h1>
        <Btn small variant="secondary" onClick={()=>{ loadProfiles(); if(tab==='turnos') loadShifts(); }}>↺ Actualizar</Btn>
      </div>

      {/* Sub-tabs */}
      <div style={{display:'flex',gap:0,borderBottom:`1px solid ${C.border}`,marginBottom:16}}>
        {[['empleados','Empleados'],['turnos','Turnos · Conexiones'],['solicitudes',`Solicitudes${reqs.filter(r=>r.status==='pending').length>0?' ('+reqs.filter(r=>r.status==='pending').length+')':''}`]].map(([id,lbl])=>(
          <button key={id} onClick={()=>setTab(id)} style={{background:'none',border:'none',color:tab===id?C.ink:C.dim,padding:'8px 16px',fontSize:13,fontWeight:tab===id?700:400,borderBottom:tab===id?'2px solid '+C.ink:'2px solid transparent',cursor:'pointer',marginBottom:-1}}>{lbl}</button>
        ))}
      </div>

      {/* Tab Empleados */}
      {tab==='empleados'&&(<>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
          <div style={{fontSize:12,color:C.mid}}>Usuarios con acceso al sistema · restaurante {RID.slice(0,8)}…</div>
          <Btn small onClick={()=>{setAddForm({full_name:'',username:'',password:'',pin:'',role:'mozo',dni:'',phone:'',email:'',notes:'',_reqId:null});setAddModal(true);}}>+ Nuevo empleado</Btn>
        </div>
        {loading&&<div style={{display:'flex',gap:10,alignItems:'center',color:C.mid,fontSize:13}}><span className="spin"/>Cargando personal…</div>}
        {error&&<div style={{color:C.orange,fontSize:13,padding:16,background:'rgba(249,115,22,0.08)',border:'1px solid rgba(249,115,22,0.2)',borderRadius:8,marginBottom:14}}><div style={{fontWeight:700,marginBottom:4}}>Atención</div>{error}</div>}
        {!loading&&(
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
            <table style={{width:'100%',borderCollapse:'collapse'}}>
              <thead><tr style={{borderBottom:`1px solid ${C.border}`}}><Th>Usuario</Th><Th>Nombre</Th><Th>Email</Th><Th>Rol</Th><Th>Estado</Th><Th>Desde</Th><Th>Acc.</Th></tr></thead>
              <tbody>
                {profiles.map(p=>(
                  <tr key={p.id} style={{borderBottom:`1px solid ${C.border}`,opacity:p.is_active===false?0.5:1}}>
                    <Td mono>{p.username||'—'}</Td>
                    <Td>{p.display_name||'—'}</Td>
                    <Td dim style={{fontSize:11}}>{displayEmail(p)}</Td>
                    <Td>
                      {editId===p.id&&!p._isRider
                        ?<Sel value={editRole} onChange={e=>setEditRole(e.target.value)} style={{width:140}}>{ADMIN_ALLOWED_ROLES.map(r=><option key={r} value={r}>{roleLabel(r)}</option>)}</Sel>
                        :<span style={{background:(roleColor[p.role]||'#6E6E73')+'22',color:roleColor[p.role]||'#6E6E73',border:`1px solid ${(roleColor[p.role]||'#6E6E73')}44`,padding:'3px 9px',fontSize:11,fontWeight:700,borderRadius:5}}>{roleLabel(p.role)}{p._isRider?' · delivery':''}</span>}
                    </Td>
                    <Td>
                      {editId===p.id
                        ?<Sel value={String(editActive)} onChange={e=>setEditActive(e.target.value==='true')} style={{width:100}}><option value="true">Activo</option><option value="false">Inactivo</option></Sel>
                        :<span style={{fontSize:11,color:p.is_active!==false?'#34C759':'#FF3B30'}}>{p.is_active!==false?'Activo':'Inactivo'}</span>}
                    </Td>
                    <Td mono dim>{fmtDate(p.created_at)}</Td>
                    <Td>
                      {editId===p.id
                        ?<div style={{display:'flex',gap:5}}><Btn small onClick={()=>saveRole(p.id)}>✓</Btn><Btn small variant="ghost" onClick={()=>setEditId(null)}>✕</Btn></div>
                        :<Btn small variant="secondary" onClick={()=>{setEditId(p.id);setEditRole(p.role);setEditActive(p.is_active!==false);}}>Editar</Btn>}
                    </Td>
                  </tr>
                ))}
                {profiles.length===0&&!error&&<EmptyRow cols={7} label="Sin empleados. Usá + Nuevo empleado para agregar personal."/>}
              </tbody>
            </table>
          </div>
        )}
        {profiles.length>0&&<div style={{marginTop:10,fontSize:11,color:C.dim}}>{profiles.filter(p=>p.is_active!==false).length} activos · {profiles.filter(p=>p.is_active===false).length} inactivos</div>}

        {addModal&&(
          <Modal title={addForm._reqId?'Aprobar solicitud — crear usuario':'Nuevo empleado'} onClose={()=>{setAddModal(false);setAddForm({full_name:'',username:'',password:'',pin:'',role:'mozo',dni:'',phone:'',email:'',notes:'',_reqId:null});}} width={520}>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'14px 16px'}}>
              <div style={{gridColumn:'1/-1'}}>
                <Lbl>Nombre completo *</Lbl>
                <Inp value={addForm.full_name} onChange={e=>setAddForm(f=>({...f,full_name:e.target.value}))} placeholder="ej: Juan García" autoFocus/>
              </div>
              <div>
                <Lbl>Rol</Lbl>
                <Sel value={addForm.role} onChange={e=>setAddForm(f=>({...f,role:e.target.value}))} style={{width:'100%'}}>
                  {ADMIN_ALLOWED_ROLES.map(r=><option key={r} value={r}>{roleLabel(r)}</option>)}
                </Sel>
              </div>
              <div>
                <Lbl>Cédula *</Lbl>
                <Inp value={addForm.username} onChange={e=>setAddForm(f=>({...f,username:e.target.value.replace(/\D/g,'')}))} placeholder="ej: 4123456" inputMode="numeric" mono/>
              </div>
              <div>
                <Lbl>Contraseña * (mínimo 8 caracteres)</Lbl>
                <Inp type="password" autoComplete="new-password" value={addForm.password} onChange={e=>setAddForm(f=>({...f,password:e.target.value}))} placeholder="Contraseña segura"/>
                <div style={{fontSize:11,color:C.dim,marginTop:4}}>El usuario deberá cambiar esta contraseña en su primer ingreso.</div>
              </div>
              <div>
                <Lbl>Teléfono</Lbl>
                <Inp value={addForm.phone} onChange={e=>setAddForm(f=>({...f,phone:e.target.value}))} placeholder="ej: 0981 123456"/>
              </div>
              <div style={{gridColumn:'1/-1'}}>
                <Lbl>Correo electrónico — opcional</Lbl>
                <Inp type="email" value={addForm.email} onChange={e=>setAddForm(f=>({...f,email:e.target.value}))} placeholder="ej: juan@email.com"/>
                <div style={{fontSize:11,color:C.dim,marginTop:4}}>Si lo cargás, el empleado lo confirma en su primer ingreso y queda como su correo de contacto. Si no, dejalo vacío — no se crea ningún correo.</div>
              </div>
              <div style={{gridColumn:'1/-1'}}>
                <Lbl>Notas / observaciones</Lbl>
                <textarea value={addForm.notes} onChange={e=>setAddForm(f=>({...f,notes:e.target.value}))} placeholder="Experiencia previa, referencia, horario preferido…" rows={2} style={{width:'100%',padding:'8px 10px',fontSize:13,borderRadius:6,resize:'vertical',fontFamily:'inherit',boxSizing:'border-box'}}/>
              </div>
            </div>
            {addForm._reqId&&(
              <div style={{marginTop:14,padding:'8px 12px',background:TINT.amberBg,border:`1px solid ${TINT.amberBorder}`,borderRadius:8,fontSize:12,color:C.orange,fontWeight:600}}>
                Al crear el usuario se marcará la solicitud como <strong>Aprobada</strong>.
              </div>
            )}
            <div style={{marginTop:14,padding:'8px 12px',background:C.bg,borderRadius:8,fontSize:12,color:C.dim}}>
              {addForm.role==='rider'
                ? 'El rider inicia sesión con su cédula y contraseña. Su ficha (vehículo, comisión) se crea automáticamente y se edita en Delivery → Riders.'
                : 'El empleado iniciará sesión con su usuario y contraseña en el panel correspondiente a su rol.'}
            </div>
            <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:16}}>
              <Btn variant="ghost" onClick={()=>{setAddModal(false);setAddForm({full_name:'',username:'',password:'',pin:'',role:'mozo',dni:'',phone:'',email:'',notes:'',_reqId:null});}} disabled={addLoading}>Cancelar</Btn>
              <Btn onClick={addEmployee} disabled={addLoading}>{addLoading?'Creando…':(addForm.role==='rider'?'Crear rider':'Crear empleado')}</Btn>
            </div>
          </Modal>
        )}
      </>)}

      {/* Tab Turnos / Conexiones — alimentado por staff_sessions (login real de cada panel) */}
      {tab==='turnos'&&(<>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <label style={{fontSize:12,color:C.mid}}>Fecha:</label>
            <input type="date" value={shiftDate} onChange={e=>setShiftDate(e.target.value)} style={{padding:'5px 9px',fontSize:12,borderRadius:6,border:`1px solid ${C.border}`}}/>
          </div>
        </div>
        <div style={{fontSize:11,color:C.dim,marginBottom:14,lineHeight:1.5}}>Registro <strong>automático</strong> del inicio de sesión de cada panel (mozo, caja, cocina, gerente, rider). Una conexión <strong>«Sin cierre»</strong> = cerraron la pestaña sin salir o se cayó la sesión; podés cerrarla con «Forzar cierre».</div>

        {/* Quién no se conectó en la fecha seleccionada (sólo roles operativos) */}
        {rosterEsperado.length>0 && (
          <div style={{marginBottom:14,background:sinConexion.length>0?'rgba(249,115,22,0.06)':'rgba(52,199,89,0.06)',border:`1px solid ${sinConexion.length>0?'rgba(249,115,22,0.25)':'rgba(52,199,89,0.25)'}`,borderRadius:8,padding:'12px 14px'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:sinConexion.length>0?8:0}}>
              <div style={{fontSize:12,fontWeight:700,color:sinConexion.length>0?C.orange:C.green}}>
                {sinConexion.length>0 ? `Sin conexión ${esHoySel?'hoy':'ese día'} · ${sinConexion.length}` : `Todo el personal operativo se conectó ${esHoySel?'hoy':'ese día'} ✓`}
              </div>
              <span style={{fontSize:11,color:C.dim}}>{rosterEsperado.length-sinConexion.length}/{rosterEsperado.length} conectados</span>
            </div>
            {sinConexion.length>0 && (
              <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                {sinConexion.map(p=>(
                  <span key={p.id} style={{fontSize:11,padding:'3px 9px',borderRadius:5,background:C.surface,border:`1px solid ${C.border}`,color:C.mid}}>
                    {p.display_name||p.username||'—'} <span style={{color:C.dim}}>· {roleLabel(p.role)}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {loadingShifts&&<div style={{display:'flex',gap:10,alignItems:'center',color:C.mid,fontSize:13}}><span className="spin"/>Cargando conexiones…</div>}
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
          <table style={{width:'100%',borderCollapse:'collapse'}}>
            <thead><tr style={{borderBottom:`1px solid ${C.border}`}}><Th>Empleado</Th><Th>Rol</Th><Th>Panel</Th><Th>Inicio</Th><Th>Cierre</Th><Th>Duración</Th><Th>Estado</Th><Th></Th></tr></thead>
            <tbody>
              {shifts.map(s=>{
                const est=sessionEstado(s);
                const abierta=!s.logout_at;
                return (
                  <tr key={s.id} style={{borderBottom:`1px solid ${C.border}`}}>
                    <Td>{s.employee_name||'—'}</Td>
                    <Td dim>{roleLabel(s.role)}</Td>
                    <Td dim>{s.panel||'—'}</Td>
                    <Td mono dim>{fmtTime(s.login_at)}</Td>
                    <Td mono dim>{s.logout_at?fmtTime(s.logout_at):'—'}</Td>
                    <Td mono dim>{duracion(s)}</Td>
                    <Td><span style={{padding:'2px 8px',fontSize:10,fontWeight:700,borderRadius:4,background:est.bg,color:est.color}}>{est.label}</span></Td>
                    <Td>{abierta&&<Btn small variant="secondary" disabled={forcingId===s.id} onClick={()=>forzarCierre(s)}>{forcingId===s.id?'Cerrando…':'Forzar cierre'}</Btn>}</Td>
                  </tr>
                );
              })}
              {shifts.length===0&&!loadingShifts&&<EmptyRow cols={8} label={`Sin conexiones registradas el ${shiftDate}`}/>}
            </tbody>
          </table>
        </div>
        {shifts.length>0&&(
          <div style={{marginTop:12,background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:14}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:10}}>TIEMPO CONECTADO — {shiftDate}</div>
            {[...new Set(shifts.map(s=>s.employee_name))].map(name=>{
              const min=horasTrabajadas(name);
              return <div key={name} style={{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:6}}>
                <span>{name||'—'}</span>
                <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:700}}>{Math.floor(min/60)}h {min%60}m</span>
              </div>;
            })}
          </div>
        )}
      </>)}

      {/* Tab Solicitudes de Personal */}
      {tab==='solicitudes'&&(<>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
          <div style={{fontSize:12,color:C.mid}}>Solicitudes enviadas por gerentes · revisá la info y creá el usuario cuando estés listo</div>
          <Btn small variant="secondary" onClick={loadReqs}>↺ Actualizar</Btn>
        </div>
        {loadingReqs&&<div style={{display:'flex',gap:10,alignItems:'center',color:C.mid,fontSize:13}}><span className="spin"/>Cargando solicitudes…</div>}
        {!loadingReqs&&(
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
            <table style={{width:'100%',borderCollapse:'collapse'}}>
              <thead>
                <tr style={{borderBottom:`1px solid ${C.border}`}}>
                  <Th>Nombre completo</Th><Th>Usuario</Th><Th>Rol</Th><Th>DNI/CI</Th><Th>Tel.</Th><Th>Email</Th><Th>Solicitado por</Th><Th>Fecha</Th><Th>Estado</Th><Th>Acciones</Th>
                </tr>
              </thead>
              <tbody>
                {reqs.map(r=>{
                  const srCol={pending:C.orange,approved:C.green,rejected:C.red};
                  const srLbl={pending:'Pendiente',approved:'Aprobado',rejected:'Rechazado'};
                  return (
                    <tr key={r.id} style={{borderBottom:`1px solid ${C.border}`,opacity:r.status!=='pending'?0.65:1}}>
                      <Td>{r.full_name}</Td>
                      <Td mono>{r.username||'—'}</Td>
                      <Td><span style={{background:(srCol[r.status]||'#86868B')+'18',color:srCol[r.status]||'#86868B',border:`1px solid ${(srCol[r.status]||'#86868B')}33`,padding:'2px 8px',fontSize:11,fontWeight:700,borderRadius:4}}>{r.role}</span></Td>
                      <Td dim>{r.dni||'—'}</Td>
                      <Td dim>{r.phone||'—'}</Td>
                      <Td dim style={{fontSize:11}}>{r.email||'—'}</Td>
                      <Td dim>{r.requested_by_name||'—'}</Td>
                      <Td mono dim>{fmtDate(r.created_at)}</Td>
                      <Td>
                        <span style={{background:(srCol[r.status]||'#86868B')+'18',color:srCol[r.status]||'#86868B',border:`1px solid ${(srCol[r.status]||'#86868B')}33`,padding:'2px 8px',fontSize:11,fontWeight:700,borderRadius:4}}>
                          {srLbl[r.status]||r.status}
                        </span>
                        {r.review_notes&&<div style={{fontSize:11,color:C.dim,marginTop:2}}>{r.review_notes}</div>}
                        {r.notes&&r.status==='pending'&&<div style={{fontSize:11,color:C.mid,marginTop:2,fontStyle:'italic'}}>"{r.notes}"</div>}
                      </Td>
                      <Td>
                        {r.status==='pending'&&(
                          <div style={{display:'flex',gap:6}}>
                            <Btn small variant="success" onClick={()=>openApprove(r)}>✓ Aprobar y crear</Btn>
                            <Btn small variant="danger" onClick={()=>{setRejectModal({id:r.id,name:r.full_name});setRejectNotes('');}}>✕ Rechazar</Btn>
                          </div>
                        )}
                      </Td>
                    </tr>
                  );
                })}
                {reqs.length===0&&<EmptyRow cols={10} label="Sin solicitudes de personal recibidas"/>}
              </tbody>
            </table>
          </div>
        )}
        {rejectModal&&(
          <Modal title={`Rechazar solicitud — ${rejectModal.name}`} onClose={()=>setRejectModal(null)} width={400}>
            <div>
              <label style={{display:'block',fontSize:12,color:C.mid,marginBottom:5}}>Motivo del rechazo (opcional)</label>
              <textarea
                value={rejectNotes}
                onChange={e=>setRejectNotes(e.target.value)}
                placeholder="ej: No hay vacante disponible actualmente…"
                rows={3}
                style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6,resize:'vertical',fontFamily:'inherit',boxSizing:'border-box'}}
              />
            </div>
            <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:16}}>
              <Btn variant="ghost" onClick={()=>setRejectModal(null)} disabled={rejectSaving}>Cancelar</Btn>
              <Btn variant="danger" onClick={confirmReject} disabled={rejectSaving}>{rejectSaving?'Rechazando…':'Confirmar rechazo'}</Btn>
            </div>
          </Modal>
        )}
      </>)}
    </div>
  );
}

/* ══════════════════════════════════════════════
   CLIENTES — CRM Marketing / Meta Ads
══════════════════════════════════════════════ */
function ClientesPage({orders}) {
  const [view,setView]         = useState('todos');
  const [canalF,setCanalF]     = useState('todos');
  const [periodF,setPeriodF]   = useState('todos');
  const [search,setSearch]     = useState('');
  const [detalle,setDetalle]   = useState(null);
  const [detalleOrders,setDetalleOrders] = useState([]);

  // Reporte CRM
  const [rType,setRType]               = useState('');
  const [fromStr,setFromStr]           = useState('');
  const [toStr,setToStr]               = useState('');
  const [reportRows,setReportRows]     = useState(null);
  const [reportSummary,setReportSummary] = useState(null);
  const [reportLoading,setReportLoading] = useState(false);
  const [reportTitle,setReportTitle]   = useState('');
  const now = Date.now();
  const VIP_THRESHOLD = 500000;

  const ORDER_TYPES = {
    'mesa':'QR Mesa','llevar':'Para Llevar','delivery':'Delivery','counter':'Mostrador','external':'Plataforma'
  };
  const CANAL_ICON  = {'mesa':'utensils','llevar':'package','delivery':'bike','counter':'store','external':'phone'}; // WS5: nombres MythosIcons (no emoji)
  const CANAL_COLOR = {'mesa':'#007AFF','llevar':'#34C759','delivery':'#FF9500','counter':'#8E8E93','external':'#AF52DE'};

  useEffect(()=>{
    const n=new Date();
    const first=new Date(n.getFullYear(),n.getMonth(),1);
    const pad=x=>String(x).padStart(2,'0');
    setFromStr(`${pad(first.getDate())}/${pad(first.getMonth()+1)}/${first.getFullYear()}`);
    setToStr(`${pad(n.getDate())}/${pad(n.getMonth()+1)}/${n.getFullYear()}`);
  },[]);

  function parseDMY(str){
    if(!str)return null;
    const p=str.split('/');if(p.length!==3)return null;
    const d=new Date(parseInt(p[2]),parseInt(p[1])-1,parseInt(p[0]));
    return isNaN(d.getTime())?null:d;
  }
  function dmyToISO(str){
    if(!str)return '';const p=str.split('/');
    if(p.length!==3)return '';
    return `${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
  }

  const periodStart = p => {
    if(p==='hoy'){const d=new Date();d.setHours(0,0,0,0);return d.toISOString();}
    if(p==='semana'){const d=new Date();d.setDate(d.getDate()-6);d.setHours(0,0,0,0);return d.toISOString();}
    if(p==='mes'){const d=new Date();d.setDate(1);d.setHours(0,0,0,0);return d.toISOString();}
    if(p==='anio'){const d=new Date();d.setMonth(0,1);d.setHours(0,0,0,0);return d.toISOString();}
    return '';
  };

  const { clientMap, frecuentes, inactivos, vip, anonimos, conFactura, byCanal, totalConsumed } = useMemo(()=>{
    const m={};
    const validOrders = orders.filter(o=>!['draft','cancelled'].includes(o.status));
    const ps = periodStart(periodF);
    const periodOrds = ps ? validOrders.filter(o=>o.created_at>=ps) : validOrders;

    periodOrds.forEach(o=>{
      const isAnon = !o.customer_name;
      const k = o.customer_name || `Anónimo #${o.id.slice(0,6)}`;
      if(!m[k]) m[k]={
        name:k, phone:o.customer_phone||null, email:o.customer_email||null,
        registered:!isAnon, anonymous:isAnon,
        orders:0, total:0,
        firstDate:o.created_at, lastDate:o.created_at,
        canales:[], canalCount:{},
        pideFactura:false, facturaCount:0,
        addresses:[], tables:[],
        paymentMethods:{},
        orderHistory:[],
      };
      m[k].orders++;
      m[k].total += (o.total||0);
      if(o.created_at < m[k].firstDate) m[k].firstDate = o.created_at;
      if(o.created_at > m[k].lastDate)  m[k].lastDate  = o.created_at;
      if(o.order_type){
        m[k].canales.push(o.order_type);
        m[k].canalCount[o.order_type] = (m[k].canalCount[o.order_type]||0)+1;
      }
      if(o.requires_invoice){ m[k].pideFactura=true; m[k].facturaCount++; }
      if(o.delivery_address && !m[k].addresses.includes(o.delivery_address)) m[k].addresses.push(o.delivery_address);
      if(o.table_number && !m[k].tables.includes(o.table_number)) m[k].tables.push(o.table_number);
      if(o.payment_method) m[k].paymentMethods[o.payment_method]=(m[k].paymentMethods[o.payment_method]||0)+1;
      m[k].orderHistory.push({id:o.id,num:o.order_number,date:o.created_at,total:o.total||0,type:o.order_type,status:o.status});
    });

    const all = Object.values(m).map(c=>{
      const preferred = Object.entries(c.canalCount).sort((a,b)=>b[1]-a[1])[0]?.[0]||null;
      const ticket = c.orders>0 ? Math.round(c.total/c.orders) : 0;
      const diasActivo = Math.round((new Date(c.lastDate)-new Date(c.firstDate))/(864e5))||0;
      c.orderHistory.sort((a,b)=>b.date.localeCompare(a.date));
      return {...c, preferred, isVip:c.total>=VIP_THRESHOLD, ticket, diasActivo};
    }).sort((a,b)=>b.total-a.total);

    const cutoff = new Date(Date.now()-30*864e5).toISOString();
    const cByCanal={};
    all.forEach(c=>{ if(c.preferred) cByCanal[c.preferred]=(cByCanal[c.preferred]||0)+1; });
    return {
      clientMap: all,
      frecuentes: all.filter(c=>c.orders>=3),
      inactivos: all.filter(c=>c.lastDate<cutoff&&c.registered),
      vip: all.filter(c=>c.isVip),
      anonimos: all.filter(c=>c.anonymous),
      conFactura: all.filter(c=>c.pideFactura),
      byCanal: cByCanal,
      totalConsumed: all.reduce((s,c)=>s+c.total,0),
    };
  },[orders,periodF]);

  // Ranking top consumidores
  const hoy = new Date().toDateString();
  const semanaStart = new Date(Date.now()-6*864e5).toISOString();
  const mesStart    = (() => { const d=new Date(); d.setDate(1); d.setHours(0,0,0,0); return d.toISOString(); })();
  function topConsumidor(filterFn) {
    const m={};
    orders.filter(o=>!['draft','cancelled'].includes(o.status)&&o.customer_name&&filterFn(o)).forEach(o=>{
      const k=o.customer_name;
      if(!m[k]) m[k]={name:k,phone:o.customer_phone||null,email:o.customer_email||null,total:0,orders:0,canal:o.order_type};
      m[k].total+=(o.total||0); m[k].orders++;
    });
    return Object.values(m).sort((a,b)=>b.total-a.total)[0]||null;
  }
  const topDia    = topConsumidor(o=>new Date(o.created_at).toDateString()===hoy);
  const topSemana = topConsumidor(o=>o.created_at>=semanaStart);
  const topMes    = topConsumidor(o=>o.created_at>=mesStart);

  const displayed = useMemo(()=>{
    let res = view==='frecuentes'?frecuentes
      :view==='inactivos'?inactivos
      :view==='vip'?vip
      :view==='factura'?conFactura
      :view==='anonimos'?anonimos
      :view==='delivery'?clientMap.filter(c=>(c.canalCount['delivery']||0)>0)
      :view==='mesa'?clientMap.filter(c=>(c.canalCount['mesa']||0)>0)
      :view==='llevar'?clientMap.filter(c=>(c.canalCount['llevar']||0)>0)
      :clientMap;
    if(canalF!=='todos') res=res.filter(c=>c.preferred===canalF);
    if(search.trim()){
      const q=search.toLowerCase();
      res=res.filter(c=>c.name.toLowerCase().includes(q)||(c.phone||'').includes(q)||(c.email||'').toLowerCase().includes(q)||(c.addresses||[]).some(a=>a.toLowerCase().includes(q)));
    }
    return res;
  },[clientMap,frecuentes,inactivos,vip,conFactura,anonimos,view,canalF,search]);

  // ── REPORT DEFS ──────────────────────────────
  const REPORT_DEFS = [
    {id:'clientes_general',   label:'Listado general de clientes',   desc:'Nombre, teléfono, email, tipo, pedidos, total consumido y canal preferido'},
    {id:'clientes_ranking',   label:'Ranking de consumidores',        desc:'Top clientes ordenados por total consumido en el período'},
    {id:'clientes_delivery',  label:'Clientes Delivery',              desc:'Clientes con pedidos delivery — incluye todas las direcciones de entrega'},
    {id:'clientes_mesa',      label:'Clientes QR Mesa',               desc:'Clientes que ordenaron escaneando el QR de su mesa'},
    {id:'clientes_llevar',    label:'Clientes Para Llevar / Mostrador', desc:'Clientes con pedidos para llevar o mostrador'},
    {id:'clientes_vip',       label:'Clientes VIP',                   desc:`Clientes que gastaron más de ₲${(VIP_THRESHOLD/1000).toFixed(0)}k en el período`},
    {id:'clientes_frecuentes',label:'Clientes Frecuentes',            desc:'Clientes con 3 o más pedidos en el período'},
    {id:'clientes_factura',   label:'Clientes que piden factura',     desc:'Datos de clientes que solicitaron RUC / comprobante fiscal'},
    {id:'clientes_inactivos', label:'Clientes Inactivos (histórico)', desc:'Clientes registrados sin pedidos en los últimos 30 días'},
    {id:'clientes_anonimos',  label:'Pedidos sin identificar',        desc:'Pedidos realizados sin nombre de cliente registrado'},
  ];
  const selDef = REPORT_DEFS.find(r=>r.id===rType);

  function buildClientsInRange(){
    const from=parseDMY(fromStr); const to=parseDMY(toStr);
    if(!from||!to)return null;
    to.setHours(23,59,59,999);
    const validOrds=orders.filter(o=>!['draft','cancelled'].includes(o.status)&&new Date(o.created_at)>=from&&new Date(o.created_at)<=to);
    const m={};
    validOrds.forEach(o=>{
      const isAnon=!o.customer_name;
      const k=o.customer_name||`__ANON__${o.id}`;
      if(!m[k])m[k]={
        name:o.customer_name||'—',phone:o.customer_phone||'',email:o.customer_email||'',
        anonymous:isAnon,registered:!isAnon,
        orders:0,total:0,firstDate:o.created_at,lastDate:o.created_at,
        canalCount:{},pideFactura:false,facturaCount:0,
        addresses:[],tables:[],ordersRaw:[],
      };
      m[k].orders++;m[k].total+=(o.total||0);
      if(o.created_at<m[k].firstDate)m[k].firstDate=o.created_at;
      if(o.created_at>m[k].lastDate) m[k].lastDate=o.created_at;
      if(o.order_type)m[k].canalCount[o.order_type]=(m[k].canalCount[o.order_type]||0)+1;
      if(o.requires_invoice){m[k].pideFactura=true;m[k].facturaCount++;}
      if(o.delivery_address&&!m[k].addresses.includes(o.delivery_address))m[k].addresses.push(o.delivery_address);
      if(o.table_number&&!m[k].tables.includes(o.table_number))m[k].tables.push(o.table_number);
      m[k].ordersRaw.push(o);
    });
    return Object.values(m).map(c=>{
      const preferred=Object.entries(c.canalCount).sort((a,b)=>b[1]-a[1])[0]?.[0]||null;
      const ticket=c.orders>0?Math.round(c.total/c.orders):0;
      return {...c,preferred,isVip:c.total>=VIP_THRESHOLD,ticket};
    }).sort((a,b)=>b.total-a.total);
  }

  function generateReport(){
    const from=parseDMY(fromStr); const to=parseDMY(toStr);
    if(!rType){toast('Seleccioná un tipo de reporte',false);return;}
    if(!from||!to){toast('Fechas inválidas — usá formato dd/mm/aaaa',false);return;}
    setReportLoading(true);setReportRows(null);setReportSummary(null);
    setReportTitle(REPORT_DEFS.find(r=>r.id===rType)?.label||'Reporte');
    setTimeout(()=>{
      try{
        const clients=buildClientsInRange();
        if(!clients){toast('Fechas inválidas',false);setReportLoading(false);return;}
        _runReport(rType,clients);
      }catch(e){toast('Error: '+e.message,false);}
      setReportLoading(false);
    },80);
  }

  function _runReport(type,clients){
    if(type==='clientes_general'){
      setReportSummary([
        {label:'Clientes únicos',  value:clients.length,                                                  color:'#007AFF'},
        {label:'Total consumido',  value:fmt(clients.reduce((s,c)=>s+c.total,0)),                         color:'#34C759'},
        {label:'Ticket promedio',  value:clients.length?fmt(Math.round(clients.reduce((s,c)=>s+c.total,0)/clients.length)):0, color:'#FF9500'},
        {label:'Registrados',      value:clients.filter(c=>c.registered).length,                          color:C.ink},
      ]);
      setReportRows({
        cols:['Nombre','Teléfono','Email','Tipo','Pedidos','Total (₲)','Ticket prom (₲)','Canal pref.','Factura','1er pedido','Último pedido'],
        data:clients.map(c=>[
          c.name, c.phone||'—', c.email||'—',
          c.isVip?'VIP':c.registered?'Registrado':'Anónimo',
          c.orders, fmt(c.total), fmt(c.ticket),
          ORDER_TYPES[c.preferred]||c.preferred||'—',
          c.pideFactura?'Sí':'No',
          c.firstDate?fmtDate(c.firstDate):'—',
          c.lastDate?fmtDate(c.lastDate):'—',
        ]),
      });
    }
    else if(type==='clientes_ranking'){
      const top=clients.filter(c=>c.registered).slice(0,100);
      setReportSummary([
        {label:'Clientes rankeados',value:top.length,                                color:'#007AFF'},
        {label:'Total consumido',   value:fmt(top.reduce((s,c)=>s+c.total,0)),       color:'#34C759'},
        {label:'Top consumidor',    value:top[0]?.name||'—',                          color:'#FF9500'},
        {label:'Mayor gasto',       value:top[0]?fmt(top[0].total):'—',              color:'#AF52DE'},
      ]);
      setReportRows({
        cols:['Pos.','Nombre','Teléfono','Email','Pedidos','Total (₲)','Ticket prom (₲)','Canal pref.','Último pedido'],
        data:top.map((c,i)=>[
          `#${i+1}`, c.name, c.phone||'—', c.email||'—',
          c.orders, fmt(c.total), fmt(c.ticket),
          ORDER_TYPES[c.preferred]||c.preferred||'—',
          c.lastDate?fmtDate(c.lastDate):'—',
        ]),
      });
    }
    else if(type==='clientes_delivery'){
      const del=clients.filter(c=>(c.canalCount['delivery']||0)>0);
      setReportSummary([
        {label:'Clientes delivery', value:del.length,                                                         color:'#FF9500'},
        {label:'Total delivery',    value:fmt(del.reduce((s,c)=>s+c.total,0)),                                color:'#34C759'},
        {label:'Con dirección',     value:del.filter(c=>c.addresses.length>0).length,                         color:'#007AFF'},
        {label:'Pedidos delivery',  value:del.reduce((s,c)=>s+(c.canalCount['delivery']||0),0),              color:'#AF52DE'},
      ]);
      setReportRows({
        cols:['Nombre','Teléfono','Email','Pedidos delivery','Total (₲)','Ticket (₲)','Dirección(es)','Último pedido'],
        data:del.map(c=>[
          c.name, c.phone||'—', c.email||'—',
          c.canalCount['delivery']||0, fmt(c.total), fmt(c.ticket),
          c.addresses.join(' | ')||'—',
          c.lastDate?fmtDate(c.lastDate):'—',
        ]),
      });
    }
    else if(type==='clientes_mesa'){
      const mesa=clients.filter(c=>(c.canalCount['mesa']||0)>0);
      setReportSummary([
        {label:'Clientes QR Mesa',  value:mesa.length,                                                        color:'#007AFF'},
        {label:'Total consumido',   value:fmt(mesa.reduce((s,c)=>s+c.total,0)),                               color:'#34C759'},
        {label:'Pedidos en mesa',   value:mesa.reduce((s,c)=>s+(c.canalCount['mesa']||0),0),                  color:'#FF9500'},
        {label:'Ticket promedio',   value:mesa.length?fmt(Math.round(mesa.reduce((s,c)=>s+c.total,0)/mesa.length)):0, color:C.ink},
      ]);
      setReportRows({
        cols:['Nombre','Teléfono','Email','Pedidos en mesa','Total (₲)','Ticket (₲)','Mesas usadas','Último pedido'],
        data:mesa.map(c=>[
          c.name, c.phone||'—', c.email||'—',
          c.canalCount['mesa']||0, fmt(c.total), fmt(c.ticket),
          c.tables.map(t=>`Mesa ${t}`).join(', ')||'—',
          c.lastDate?fmtDate(c.lastDate):'—',
        ]),
      });
    }
    else if(type==='clientes_llevar'){
      const llevar=clients.filter(c=>(c.canalCount['llevar']||0)+(c.canalCount['counter']||0)>0);
      setReportSummary([
        {label:'Clientes para llevar',value:llevar.length,                                                    color:'#34C759'},
        {label:'Total consumido',     value:fmt(llevar.reduce((s,c)=>s+c.total,0)),                          color:'#007AFF'},
        {label:'Pedidos para llevar', value:llevar.reduce((s,c)=>s+(c.canalCount['llevar']||0)+(c.canalCount['counter']||0),0), color:'#FF9500'},
      ]);
      setReportRows({
        cols:['Nombre','Teléfono','Email','Para llevar','Mostrador','Total (₲)','Ticket (₲)','Último pedido'],
        data:llevar.map(c=>[
          c.name, c.phone||'—', c.email||'—',
          c.canalCount['llevar']||0, c.canalCount['counter']||0,
          fmt(c.total), fmt(c.ticket),
          c.lastDate?fmtDate(c.lastDate):'—',
        ]),
      });
    }
    else if(type==='clientes_vip'){
      const vipL=clients.filter(c=>c.isVip);
      setReportSummary([
        {label:'Clientes VIP',    value:vipL.length,                               color:'#FF9500'},
        {label:'Total consumido', value:fmt(vipL.reduce((s,c)=>s+c.total,0)),     color:'#34C759'},
        {label:'Mayor gasto',     value:vipL[0]?fmt(vipL[0].total):'—',           color:'#AF52DE'},
      ]);
      setReportRows({
        cols:['Nombre','Teléfono','Email','Pedidos','Total (₲)','Ticket (₲)','Canal pref.','Factura','1er pedido','Último pedido'],
        data:vipL.map(c=>[
          c.name, c.phone||'—', c.email||'—',
          c.orders, fmt(c.total), fmt(c.ticket),
          ORDER_TYPES[c.preferred]||c.preferred||'—',
          c.pideFactura?'Sí':'No',
          c.firstDate?fmtDate(c.firstDate):'—',
          c.lastDate?fmtDate(c.lastDate):'—',
        ]),
      });
    }
    else if(type==='clientes_frecuentes'){
      const freq=clients.filter(c=>c.orders>=3&&c.registered);
      setReportSummary([
        {label:'Clientes frecuentes',value:freq.length,                              color:'#34C759'},
        {label:'Total consumido',    value:fmt(freq.reduce((s,c)=>s+c.total,0)),    color:'#007AFF'},
        {label:'Más fiel',           value:freq[0]?`${freq[0].orders} pedidos`:'—', color:'#FF9500'},
      ]);
      setReportRows({
        cols:['Nombre','Teléfono','Email','Pedidos','Total (₲)','Ticket (₲)','Canal pref.','1er pedido','Último pedido'],
        data:freq.map(c=>[
          c.name, c.phone||'—', c.email||'—',
          c.orders, fmt(c.total), fmt(c.ticket),
          ORDER_TYPES[c.preferred]||c.preferred||'—',
          c.firstDate?fmtDate(c.firstDate):'—',
          c.lastDate?fmtDate(c.lastDate):'—',
        ]),
      });
    }
    else if(type==='clientes_factura'){
      const facL=clients.filter(c=>c.pideFactura);
      setReportSummary([
        {label:'Piden factura',   value:facL.length,                               color:'#007AFF'},
        {label:'Total facturado', value:fmt(facL.reduce((s,c)=>s+c.total,0)),     color:'#34C759'},
        {label:'Solicitudes',     value:facL.reduce((s,c)=>s+c.facturaCount,0),  color:'#AF52DE'},
      ]);
      setReportRows({
        cols:['Nombre','Teléfono','Email','Pedidos','Solicitudes factura','Total (₲)','Canal pref.','Último pedido'],
        data:facL.map(c=>[
          c.name, c.phone||'—', c.email||'—',
          c.orders, c.facturaCount, fmt(c.total),
          ORDER_TYPES[c.preferred]||c.preferred||'—',
          c.lastDate?fmtDate(c.lastDate):'—',
        ]),
      });
    }
    else if(type==='clientes_inactivos'){
      const cutoff=new Date(Date.now()-30*864e5).toISOString();
      const allValid=orders.filter(o=>!['draft','cancelled'].includes(o.status)&&o.customer_name);
      const m2={};
      allValid.forEach(o=>{
        const k=o.customer_name;
        if(!m2[k])m2[k]={name:k,phone:o.customer_phone||'',email:o.customer_email||'',total:0,orders:0,lastDate:o.created_at};
        m2[k].total+=(o.total||0);m2[k].orders++;
        if(o.created_at>m2[k].lastDate)m2[k].lastDate=o.created_at;
      });
      const inac=Object.values(m2).filter(c=>c.lastDate<cutoff).sort((a,b)=>a.lastDate.localeCompare(b.lastDate));
      setReportSummary([
        {label:'Clientes inactivos', value:inac.length,                           color:'#FF9500'},
        {label:'Días máx inactivo',  value:inac.length?Math.floor((now-new Date(inac[0].lastDate).getTime())/864e5)+'d':'—', color:'#FF3B30'},
        {label:'Valor en riesgo',    value:fmt(inac.reduce((s,c)=>s+c.total,0)), color:'#34C759'},
      ]);
      setReportRows({
        cols:['Nombre','Teléfono','Email','Días inactivo','Último pedido','Total pedidos','Total (₲)'],
        data:inac.map(c=>[
          c.name, c.phone||'—', c.email||'—',
          Math.floor((now-new Date(c.lastDate).getTime())/864e5),
          fmtDate(c.lastDate), c.orders, fmt(c.total),
        ]),
      });
    }
    else if(type==='clientes_anonimos'){
      const from=parseDMY(fromStr); const to=parseDMY(toStr);
      if(!from||!to)return;
      to.setHours(23,59,59,999);
      const anonOrds=orders.filter(o=>!['draft','cancelled'].includes(o.status)&&!o.customer_name&&new Date(o.created_at)>=from&&new Date(o.created_at)<=to);
      const totAnon=anonOrds.reduce((s,o)=>s+(o.total||0),0);
      setReportSummary([
        {label:'Pedidos anónimos',   value:anonOrds.length,                                                    color:'#8E8E93'},
        {label:'Total sin registrar',value:fmt(totAnon),                                                       color:'#FF9500'},
        {label:'Ticket promedio',    value:anonOrds.length?fmt(Math.round(totAnon/anonOrds.length)):'—',       color:'#007AFF'},
      ]);
      setReportRows({
        cols:['Pedido #','Fecha','Canal','Total (₲)','Mesa / Dirección','Método pago'],
        data:anonOrds.slice(0,300).map(o=>[
          o.order_number||o.id?.slice(-6)||'—',
          fmtDate(o.created_at),
          (ORDER_TYPES[o.order_type]||o.order_type||'—'),
          fmt(o.total||0),
          o.table_number?`Mesa ${o.table_number}`:o.delivery_address||'—',
          o.payment_method||'—',
        ]),
      });
    }
  }

  function exportReportCSV(){
    if(!reportRows)return;
    const lines=[reportRows.cols.join(','),...reportRows.data.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','))];
    const blob=new Blob(['﻿'+lines.join('\n')],{type:'text/csv;charset=utf-8;'});
    const url=URL.createObjectURL(blob);const a=document.createElement('a');
    a.href=url;a.download=`crm_${rType}_${dmyToISO(fromStr)}.csv`;a.click();URL.revokeObjectURL(url);
    toast('CSV descargado');
  }
  function exportReportXLS(){
    if(!reportRows||!window.XLSX){toast('Sin datos o XLSX no cargado',false);return;}
    const ws=XLSX.utils.aoa_to_sheet([reportRows.cols,...reportRows.data]);
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,(selDef?.label||'CRM').slice(0,31));
    XLSX.writeFile(wb,`crm_${rType}_${dmyToISO(fromStr)}.xlsx`);
    toast('Excel descargado');
  }
  function exportReportPDF(){
    if(!reportRows)return;
    const restaurantName=window.SUPABASE_CONFIG?.restaurantName||'Restaurante';
    const w=window.open('','_blank');
    const sumHtml=reportSummary?reportSummary.map(s=>`<div style="display:inline-block;margin:0 24px 12px 0"><div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.5px">${esc(s.label)}</div><div style="font-size:20px;font-weight:800;color:${esc(s.color)}">${esc(s.value)}</div></div>`).join(''):'';
    const tHead=`<tr>${reportRows.cols.map(c=>`<th style="background:#1D1D1F;color:#fff;padding:8px 12px;text-align:left;font-size:11px;white-space:nowrap">${esc(c)}</th>`).join('')}</tr>`;
    const tBody=reportRows.data.map((r,i)=>`<tr style="background:${i%2===0?'#fff':'#f9f9f9'}">${r.map(v=>`<td style="padding:7px 12px;font-size:11px;border-bottom:1px solid #eee">${esc(v)}</td>`).join('')}</tr>`).join('');
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${selDef?.label||'CRM'} — ${restaurantName}</title>
    <style>body{font-family:system-ui,sans-serif;margin:32px;color:#222}@media print{button{display:none!important}@page{margin:1cm;size:A4 landscape}}</style></head><body>
      <div style="font-size:24px;font-weight:800;color:#1D1D1F;margin-bottom:4px">${restaurantName}</div>
      <div style="font-size:16px;font-weight:700;color:#000;margin-bottom:4px">CRM — ${selDef?.label||'Clientes'}</div>
      <div style="font-size:11px;color:#888;margin-bottom:18px">Generado: ${new Date().toLocaleDateString('es-PY')} · Período: ${fromStr} al ${toStr}</div>
      <div style="margin-bottom:20px;padding:14px 0;border-top:2px solid #000;border-bottom:1px solid #eee">${sumHtml}</div>
      <table style="width:100%;border-collapse:collapse"><thead>${tHead}</thead><tbody>${tBody}</tbody></table>
      <div style="margin-top:24px;font-size:9px;color:#bbb;text-align:right">Mythos CRM · ${new Date().toLocaleDateString('es-PY')}</div>
      <script>window.onload=function(){window.print();}<\/script>
    </body></html>`);
    w.document.close();
    toast('PDF abierto para imprimir');
  }

  // ── Quick export (lista visible) ──────────────
  function buildExportRows(list) {
    return list.map(c=>({
      'Nombre':              c.name,
      'Teléfono':            c.phone||'',
      'Email':               c.email||'',
      'Tipo':                c.isVip?'VIP':c.registered?'Registrado':'Anónimo',
      'Pedidos totales':     c.orders,
      'Total gastado (₲)':  c.total,
      'Ticket promedio (₲)':c.ticket,
      'Pide factura':        c.pideFactura?'Sí':'No',
      'Canal preferido':     ORDER_TYPES[c.preferred]||c.preferred||'—',
      'Mesa QR':             c.canalCount['mesa']||0,
      'Para llevar':         c.canalCount['llevar']||0,
      'Delivery':            c.canalCount['delivery']||0,
      'Mostrador':           c.canalCount['counter']||0,
      'Direcciones delivery':c.addresses.join(' | '),
      'Mesas usadas':        c.tables.join(', '),
      'Primer pedido':       c.firstDate?fmtDate(c.firstDate):'',
      'Último pedido':       c.lastDate?fmtDate(c.lastDate):'',
      'Días activo':         c.diasActivo,
    }));
  }

  function exportExcel() {
    if(!window.XLSX){toast('SheetJS no cargado',false);return;}
    const rows = buildExportRows(displayed);
    const ws = XLSX.utils.json_to_sheet(rows);
    const colW = Object.keys(rows[0]||{}).map(k=>({wch:Math.max(k.length,12)}));
    ws['!cols']=colW;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,'Clientes');
    XLSX.writeFile(wb,`clientes_${new Date().toISOString().slice(0,10)}.xlsx`);
    toast('Excel descargado');
  }

  function exportCSV() {
    const rows = buildExportRows(displayed);
    if(!rows.length){toast('Sin datos',false);return;}
    const headers = Object.keys(rows[0]);
    const csv = [headers,...rows.map(r=>headers.map(h=>`"${(r[h]??'').toString().replace(/"/g,'""')}"`))].map(r=>Array.isArray(r)?r.join(','):r.join(',')).join('\n');
    const a=document.createElement('a');
    a.href='data:text/csv;charset=utf-8,﻿'+encodeURIComponent(csv);
    a.download=`clientes_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    toast('CSV descargado');
  }

  function exportPDF() {
    const printWin = window.open('','_blank','width=900,height=700');
    const restaurantName = window.SUPABASE_CONFIG?.restaurantName || '';
    const rows = buildExportRows(displayed);
    const fecha = new Date().toLocaleDateString('es-PY',{day:'2-digit',month:'2-digit',year:'numeric'});
    const cols = ['Nombre','Teléfono','Email','Tipo','Pedidos totales','Total gastado (₲)','Ticket promedio (₲)','Pide factura','Canal preferido','Direcciones delivery'];
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Clientes — ${fecha}</title>
    <style>body{font-family:-apple-system,Arial,sans-serif;font-size:11px;color:#1D1D1F;margin:24px}
    h1{font-size:18px;font-weight:800;margin:0 0 4px}p{color:#6E6E73;margin:0 0 16px;font-size:11px}
    table{width:100%;border-collapse:collapse;font-size:10px}
    th{background:#1D1D1F;color:#fff;padding:6px 8px;text-align:left;font-weight:700;white-space:nowrap}
    td{padding:5px 8px;border-bottom:1px solid #E5E5EA;vertical-align:top}
    tr:nth-child(even)td{background:#F5F5F7}
    .vip{background:#FFF4E0;color:#8A4B00;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700}
    .reg{background:#000;color:#fff;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700}
    .anon{background:#F5F5F7;color:#86868B;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700}
    @media print{@page{margin:1cm;size:A4 landscape}}</style></head>
    <body><h1>Clientes${restaurantName?' — '+restaurantName:''}</h1><p>Exportado el ${fecha} · ${rows.length} cliente${rows.length!==1?'s':''} · Filtro: ${view}</p>
    <table><thead><tr>${cols.map(c=>`<th>${c}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r=>`<tr>${cols.map(c=>{
      if(c==='Tipo'){
        const cls=r[c]==='VIP'?'vip':r[c]==='Registrado'?'reg':'anon';
        return `<td><span class="${cls}">${esc(r[c])}</span></td>`;
      }
      if(c==='Total gastado (₲)'||c==='Ticket promedio (₲)') return `<td style="text-align:right;font-family:monospace">₲ ${Number(r[c]).toLocaleString()}</td>`;
      if(c==='Pedidos totales') return `<td style="text-align:right">${r[c]}</td>`;
      return `<td>${esc(r[c]||'—')}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table>
    <script>window.onload=()=>{window.print();}<\/script></body></html>`;
    printWin.document.write(html);
    printWin.document.close();
  }

  // ── Badge / UI helpers ────────────────────────
  const TypeBadge = ({c}) => {
    if(c.isVip) return <span style={{background:TINT.amberBg,border:`1px solid ${TINT.amberBorder}`,color:TINT.amberText,padding:'2px 7px',fontSize:10,fontWeight:700,borderRadius:4}}>VIP</span>;
    if(c.registered) return <span style={{background:C.ink,color:C.sidebar,padding:'2px 7px',fontSize:10,fontWeight:700,borderRadius:4}}>REG</span>;
    return <span style={{background:C.bg,border:`1px solid ${C.border}`,color:C.dim,padding:'2px 7px',fontSize:10,fontWeight:700,borderRadius:4}}>ANÓN</span>;
  };

  const CanalBar = ({canalCount}) => {
    const canales = Object.entries(canalCount).sort((a,b)=>b[1]-a[1]);
    if(!canales.length) return <span style={{color:C.dim,fontSize:11}}>—</span>;
    return <div style={{display:'flex',gap:3,flexWrap:'wrap'}}>
      {canales.map(([k,v])=>(
        <span key={k} style={{background:CANAL_COLOR[k]||'#8E8E93',color:'#fff',padding:'1px 6px',borderRadius:10,fontSize:9,fontWeight:700,whiteSpace:'nowrap'}}>
<Icon name={CANAL_ICON[k]} size={12} style={{verticalAlign:'-2px',marginRight:3}}/> {ORDER_TYPES[k]||k}{v>1?` ×${v}`:''}
        </span>
      ))}
    </div>;
  };

  const totalCanalOrds = Object.values(byCanal).reduce((s,v)=>s+v,0)||1;

  return (
    <div className="page">
      {/* ── Header ── */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14,flexWrap:'wrap',gap:8}}>
        <div>
          <h1 style={{fontSize:22,fontWeight:800,color:C.ink,margin:0}}>Clientes</h1>
          <div style={{fontSize:11,color:C.dim,marginTop:2}}>CRM · Marketing · Meta Ads · Exportación de datos</div>
        </div>
        <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
          <Btn variant="secondary" small onClick={exportCSV}>↓ CSV rápido</Btn>
          <Btn variant="secondary" small onClick={exportExcel}>↓ Excel rápido</Btn>
          <Btn variant="secondary" small onClick={exportPDF}>↓ PDF rápido</Btn>
        </div>
      </div>

      {/* ── KPIs ── */}
      <div style={{display:'flex',gap:10,marginBottom:10,flexWrap:'wrap'}}>
        <KpiCard label="Clientes únicos"  value={clientMap.length}                           sub="en el período"/>
        <KpiCard label="Registrados"      value={clientMap.filter(c=>c.registered).length}   sub="con nombre" accent={C.green}/>
        <KpiCard label="Anónimos"         value={anonimos.length}                            sub="sin identificar" accent={C.mid}/>
        <KpiCard label="Frecuentes"       value={frecuentes.length}                          sub="3+ pedidos" accent={C.green}/>
        <KpiCard label="VIP"              value={vip.length}                                 sub={`+₲${(VIP_THRESHOLD/1000).toFixed(0)}k`} accent={C.orange}/>
        <KpiCard label="Piden factura"    value={conFactura.length}                          sub="RUC / factura" accent={'#007AFF'}/>
        <KpiCard label="Inactivos"        value={inactivos.length}                           sub="+30 días" accent={inactivos.length>5?C.red:C.mid}/>
        <KpiCard label="Total consumido"  value={fmt(totalConsumed)}                         sub="en el período" accent={C.green}/>
      </div>

      {/* ── Distribución por canal ── */}
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'12px 16px',marginBottom:10}}>
        <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:8}}>DISTRIBUCIÓN POR CANAL (clientes con preferencia)</div>
        <div style={{display:'flex',gap:12,flexWrap:'wrap',alignItems:'center'}}>
          {Object.entries(ORDER_TYPES).map(([k,v])=>{
            const count=byCanal[k]||0;
            const pct=Math.round(count/totalCanalOrds*100);
            return (
              <div key={k} style={{display:'flex',flexDirection:'column',alignItems:'center',gap:3,minWidth:70}}>
                <div style={{display:'flex'}}><Icon name={CANAL_ICON[k]} size={18}/></div>
                <div style={{fontSize:11,fontWeight:700,color:CANAL_COLOR[k]}}>{count}</div>
                <div style={{fontSize:10,color:C.mid,textAlign:'center',lineHeight:1.2}}>{v}</div>
                <div style={{width:60,height:4,background:C.card,borderRadius:2}}>
                  <div style={{width:`${pct}%`,height:'100%',background:CANAL_COLOR[k],borderRadius:2}}/>
                </div>
                <div style={{fontSize:9,color:C.dim}}>{pct}%</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Top consumidores ── */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:10,marginBottom:14}}>
        {[['Top del día',topDia],['Top de la semana',topSemana],['Top del mes',topMes]].map(([lbl,top])=>(
          <div key={lbl} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'12px 16px'}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:0.8,marginBottom:6}}>{lbl}</div>
            {top?<>
              <div style={{fontSize:14,fontWeight:700,color:C.ink,overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis'}}>{top.name}</div>
              {top.phone&&<div style={{fontSize:11,color:C.mid,fontFamily:"'SF Mono',ui-monospace,monospace",marginTop:1}}>{top.phone}</div>}
              {top.email&&<div style={{fontSize:10,color:C.dim,marginTop:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{top.email}</div>}
              <div style={{fontSize:12,color:C.orange,marginTop:4,fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:700}}>{fmt(top.total)}</div>
              <div style={{fontSize:10,color:C.dim}}>{top.orders} pedido{top.orders!==1?'s':''} · {ORDER_TYPES[top.canal]||top.canal||'—'}</div>
            </>:<div style={{fontSize:12,color:C.dim}}>Sin datos</div>}
          </div>
        ))}
      </div>

      {/* ══ PANEL REPORTES CRM ══ */}
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:20,marginBottom:20}}>
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:16}}>
          <div style={{width:32,height:32,borderRadius:8,background:'rgba(0,0,0,0.06)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:16}}>♦</div>
          <div>
            <div style={{fontSize:15,fontWeight:700}}>Reportes CRM</div>
            <div style={{fontSize:11,color:C.dim}}>Generá reportes por tipo y período — exportable en PDF, Excel y CSV</div>
          </div>
        </div>

        <div style={{marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:600,color:C.mid,marginBottom:5,letterSpacing:.5,textTransform:'uppercase'}}>Tipo de reporte</div>
          <select value={rType} onChange={e=>{setRType(e.target.value);setReportRows(null);setReportSummary(null);}} style={{width:'100%',maxWidth:480,padding:'9px 12px',borderRadius:8,fontSize:13,border:`1px solid ${C.border}`,background:C.surface,color:C.ink}}>
            <option value="">— Seleccioná un tipo de reporte CRM —</option>
            {REPORT_DEFS.map(r=><option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          {selDef&&<div style={{fontSize:11,color:C.dim,marginTop:4}}>{selDef.desc}</div>}
        </div>

        <div style={{display:'flex',gap:14,alignItems:'flex-end',flexWrap:'wrap',marginBottom:16}}>
          <div>
            <div style={{fontSize:11,fontWeight:600,color:C.mid,marginBottom:5,letterSpacing:.5,textTransform:'uppercase'}}>Fecha desde</div>
            <input type="text" value={fromStr} onChange={e=>setFromStr(e.target.value)} placeholder="dd/mm/aaaa" style={{padding:'8px 12px',borderRadius:8,fontSize:13,border:`1px solid ${C.border}`,width:145,background:C.surface,color:C.ink}}/>
          </div>
          <div>
            <div style={{fontSize:11,fontWeight:600,color:C.mid,marginBottom:5,letterSpacing:.5,textTransform:'uppercase'}}>Fecha hasta</div>
            <input type="text" value={toStr} onChange={e=>setToStr(e.target.value)} placeholder="dd/mm/aaaa" style={{padding:'8px 12px',borderRadius:8,fontSize:13,border:`1px solid ${C.border}`,width:145,background:C.surface,color:C.ink}}/>
          </div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
            <button onClick={generateReport} disabled={reportLoading} style={{display:'inline-flex',alignItems:'center',gap:6,padding:'9px 18px',background:C.ink,color:C.sidebar,border:'none',borderRadius:8,fontSize:13,fontWeight:700,cursor:'pointer',opacity:reportLoading?0.7:1}}>
              {reportLoading&&<span className="spin"/>}{reportLoading?'Generando…':'♦ Generar reporte'}
            </button>
            {reportRows&&<>
              <button onClick={exportReportPDF} style={{display:'inline-flex',alignItems:'center',gap:6,padding:'9px 16px',background:'#FF3B30',color:'#fff',border:'none',borderRadius:8,fontSize:13,fontWeight:700,cursor:'pointer'}}>↓ PDF</button>
              <button onClick={exportReportXLS} style={{display:'inline-flex',alignItems:'center',gap:6,padding:'9px 16px',background:'#34C759',color:'#fff',border:'none',borderRadius:8,fontSize:13,fontWeight:700,cursor:'pointer'}}>↓ Excel</button>
              <button onClick={exportReportCSV} style={{display:'inline-flex',alignItems:'center',gap:6,padding:'9px 16px',background:C.ink,color:C.surface,border:'none',borderRadius:8,fontSize:13,fontWeight:700,cursor:'pointer'}}>↓ CSV</button>
              <button onClick={()=>{setReportRows(null);setReportSummary(null);setReportTitle('');}} style={{padding:'9px 14px',background:'transparent',color:C.mid,border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,cursor:'pointer'}}>✕</button>
            </>}
          </div>
        </div>

        {reportSummary&&(
          <div style={{display:'flex',gap:12,flexWrap:'wrap',marginBottom:16}}>
            {reportSummary.map((s,i)=>(
              <div key={i} style={{flex:'1 1 160px',background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'14px 18px',borderLeft:`3px solid ${s.color}`}}>
                <div style={{fontSize:11,color:C.mid,marginBottom:4,textTransform:'uppercase',letterSpacing:.5,fontWeight:600}}>{s.label}</div>
                <div style={{fontSize:22,fontWeight:800,color:s.color}}>{s.value}</div>
              </div>
            ))}
          </div>
        )}

        {reportRows&&(
          <div style={{overflowX:'auto',borderRadius:8,border:`1px solid ${C.border}`}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
              <thead>
                <tr>{reportRows.cols.map((col,i)=><th key={i} style={{background:C.ink,color:C.surface,padding:'8px 12px',textAlign:'left',fontWeight:700,fontSize:11,whiteSpace:'nowrap'}}>{col}</th>)}</tr>
              </thead>
              <tbody>
                {reportRows.data.map((r,ri)=>(
                  <tr key={ri} style={{background:ri%2===0?C.surface:'var(--bg-subtle)',borderBottom:`1px solid ${C.border}`}}>
                    {r.map((v,vi)=><td key={vi} style={{padding:'7px 12px',color:C.ink}}>{v}</td>)}
                  </tr>
                ))}
                {reportRows.data.length===0&&<tr><td colSpan={reportRows.cols.length} style={{textAlign:'center',padding:28,color:C.dim,fontSize:13}}>Sin datos en el período seleccionado</td></tr>}
              </tbody>
            </table>
            <div style={{padding:'8px 14px',fontSize:11,color:C.dim,borderTop:`1px solid ${C.border}`,background:'var(--bg-subtle)'}}>
              {reportRows.data.length} registro{reportRows.data.length!==1?'s':''} · {selDef?.label} · {fromStr} al {toStr}
            </div>
          </div>
        )}

        {!reportRows&&(
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(220px,1fr))',gap:10,marginTop:4}}>
            {REPORT_DEFS.map(r=>(
              <button key={r.id} onClick={()=>{setRType(r.id);setReportRows(null);setReportSummary(null);}} style={{textAlign:'left',padding:'12px 14px',background:rType===r.id?C.ink:C.white,border:`1px solid ${rType===r.id?C.ink:C.border}`,borderRadius:8,cursor:'pointer'}}>
                <div style={{fontSize:13,fontWeight:600,color:rType===r.id?C.sidebar:C.ink,marginBottom:3}}>{r.label}</div>
                <div style={{fontSize:11,color:rType===r.id?'rgba(255,255,255,0.55)':C.dim,lineHeight:1.3}}>{r.desc}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Filtros lista visual ── */}
      <div style={{display:'flex',gap:8,marginBottom:10,flexWrap:'wrap',alignItems:'center'}}>
        <div style={{display:'flex',gap:0,borderBottom:`1px solid ${C.border}`,overflowX:'auto'}}>
          {[['todos','Todos'],['frecuentes','Frecuentes'],['vip','VIP'],['inactivos','Inactivos'],['factura','Factura'],['anonimos','Anónimos'],['delivery','Delivery'],['mesa','QR Mesa'],['llevar','Para llevar']].map(([id,lbl])=>(
            <button key={id} onClick={()=>setView(id)} style={{background:'none',border:'none',color:view===id?C.ink:C.dim,padding:'7px 12px',fontSize:12,fontWeight:view===id?700:400,borderBottom:view===id?'2px solid '+C.ink:'2px solid transparent',cursor:'pointer',marginBottom:-1,whiteSpace:'nowrap'}}>{lbl}</button>
          ))}
        </div>
        <select value={canalF} onChange={e=>setCanalF(e.target.value)} style={{padding:'5px 9px',fontSize:12,borderRadius:6,border:`1px solid ${C.border}`}}>
          <option value="todos">Todos los canales</option>
          {Object.entries(ORDER_TYPES).map(([k,v])=><option key={k} value={k}>{v}</option>)}
        </select>
        <select value={periodF} onChange={e=>setPeriodF(e.target.value)} style={{padding:'5px 9px',fontSize:12,borderRadius:6,border:`1px solid ${C.border}`}}>
          <option value="todos">Todo el tiempo</option>
          <option value="hoy">Hoy</option>
          <option value="semana">Esta semana</option>
          <option value="mes">Este mes</option>
          <option value="anio">Este año</option>
        </select>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar nombre, tel, email, dirección…" style={{padding:'5px 9px',fontSize:12,borderRadius:6,border:`1px solid ${C.border}`,width:230}}/>
        <span style={{fontSize:11,color:C.dim,marginLeft:'auto'}}>{displayed.length} cliente{displayed.length!==1?'s':''}</span>
      </div>

      {/* ── Tabla de clientes ── */}
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse',minWidth:860}}>
          <thead>
            <tr style={{borderBottom:`1px solid ${C.border}`,background:'var(--bg-subtle)'}}>
              <Th>Cliente</Th>
              <Th>Contacto</Th>
              <Th>Tipo</Th>
              <Th right>Pedidos</Th>
              <Th right>Total gastado</Th>
              <Th right>Ticket prom.</Th>
              <Th>Canales usados</Th>
              <Th>Dirección delivery</Th>
              <Th>Último pedido</Th>
            </tr>
          </thead>
          <tbody>
            {displayed.map((c,i)=>{
              const diasInactivo=Math.floor((now-new Date(c.lastDate).getTime())/864e5);
              return (
                <tr key={i} onClick={()=>{setDetalle(c);setDetalleOrders(c.orderHistory.slice(0,10));}} style={{borderBottom:`1px solid ${C.border}`,cursor:'pointer'}} onMouseEnter={e=>e.currentTarget.style.background='var(--surface-hover)'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                  <Td>
                    <div style={{fontWeight:700,fontSize:13,color:C.ink}}>{c.name}</div>
                    <div style={{display:'flex',gap:3,marginTop:3,flexWrap:'wrap'}}>
                      {c.pideFactura&&<span style={{fontSize:9,fontWeight:700,color:TINT.blueText,background:TINT.blueBg,padding:'1px 4px',borderRadius:3}}>FACTURA</span>}
                      {c.orders>=3&&!c.isVip&&<span style={{fontSize:9,fontWeight:700,color:C.green,background:TINT.greenBg,padding:'1px 4px',borderRadius:3}}>FRECUENTE</span>}
                      {c.addresses.length>0&&<span style={{fontWeight:700,color:'#FF9500',background:TINT.amberBg,padding:'2px 4px',borderRadius:3,display:'inline-flex'}}><Icon name="bike" size={10}/></span>}
                    </div>
                  </Td>
                  <Td>
                    <div style={{fontSize:12,fontFamily:"'SF Mono',ui-monospace,monospace",color:c.phone?'#1D1D1F':'#D2D2D7'}}>{c.phone||'—'}</div>
                    {c.email&&<div style={{fontSize:11,color:C.dim,marginTop:1,maxWidth:150,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{c.email}</div>}
                  </Td>
                  <Td><TypeBadge c={c}/></Td>
                  <Td right><span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:700,color:c.orders>=3?C.green:C.ink,fontSize:14}}>{c.orders}</span></Td>
                  <Td mono right><span style={{fontWeight:700,color:c.isVip?C.orange:C.ink}}>{fmt(c.total)}</span></Td>
                  <Td mono right><span style={{color:C.mid}}>{fmt(c.ticket)}</span></Td>
                  <Td><CanalBar canalCount={c.canalCount}/></Td>
                  <Td>
                    {c.addresses.length>0
                      ?<div style={{fontSize:11,color:'#FF9500',maxWidth:160,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={c.addresses.join(' | ')}><Icon name="bike" size={11} style={{verticalAlign:'-2px',marginRight:2}}/> {c.addresses[0]}{c.addresses.length>1?` +${c.addresses.length-1}`:''}</div>
                      :<span style={{color:C.dim,fontSize:11}}>—</span>
                    }
                  </Td>
                  <Td>
                    <span style={{color:diasInactivo>30?C.orange:C.mid,fontSize:12}}>{fmtDate(c.lastDate)}</span>
                    {diasInactivo>0&&<div style={{color:C.dim,fontSize:10}}>{diasInactivo}d atrás</div>}
                  </Td>
                </tr>
              );
            })}
            {displayed.length===0&&<EmptyRow cols={9} label="Sin clientes en este filtro"/>}
          </tbody>
        </table>
      </div>
      {clientMap.length===0&&<div style={{marginTop:12,fontSize:12,color:C.dim,padding:'10px 14px',background:C.bg,borderRadius:8}}>Los pedidos deben incluir nombre del cliente para aparecer aquí.</div>}

      {/* ── Modal detalle cliente ── */}
      {detalle&&(
        <Modal title="" onClose={()=>setDetalle(null)} width={580}>
          <div style={{display:'flex',flexDirection:'column',gap:16}}>

            {/* Header */}
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12}}>
              <div>
                <div style={{fontSize:20,fontWeight:800,color:C.ink}}>{detalle.name}</div>
                <div style={{display:'flex',gap:6,marginTop:6,flexWrap:'wrap'}}>
                  <TypeBadge c={detalle}/>
                  {detalle.orders>=3&&<span style={{background:TINT.greenBg,color:C.green,padding:'2px 7px',fontSize:10,fontWeight:700,borderRadius:4}}>FRECUENTE</span>}
                  {detalle.pideFactura&&<span style={{background:TINT.blueBg,color:TINT.blueText,padding:'2px 7px',fontSize:10,fontWeight:700,borderRadius:4}}>PIDE FACTURA</span>}
                  {(detalle.canalCount['delivery']||0)>0&&<span style={{background:TINT.amberBg,color:'#FF9500',padding:'2px 7px',fontSize:10,fontWeight:700,borderRadius:4,display:'inline-flex',alignItems:'center',gap:4}}><Icon name="bike" size={10}/> DELIVERY</span>}
                </div>
              </div>
              {detalle.phone&&(
                <a href={`https://wa.me/595${detalle.phone.replace(/\D/g,'').replace(/^0/,'').replace(/^595/,'')}`} target="_blank" rel="noopener" style={{display:'flex',alignItems:'center',gap:6,background:'#25D366',color:'#fff',padding:'8px 14px',borderRadius:8,fontSize:12,fontWeight:700,textDecoration:'none',whiteSpace:'nowrap'}}>
                  <Icon name="chat" size={14}/> WhatsApp
                </a>
              )}
            </div>

            {/* Datos de contacto */}
            <div style={{background:C.bg,borderRadius:10,padding:14}}>
              <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:10}}>DATOS DE CONTACTO</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                <div>
                  <div style={{fontSize:10,color:C.dim,marginBottom:2}}>Teléfono</div>
                  <div style={{fontSize:13,fontWeight:600,fontFamily:"'SF Mono',ui-monospace,monospace"}}>{detalle.phone||<span style={{color:C.dim}}>—</span>}</div>
                </div>
                <div>
                  <div style={{fontSize:10,color:C.dim,marginBottom:2}}>Email</div>
                  <div style={{fontSize:13,fontWeight:600,wordBreak:'break-all'}}>{detalle.email||<span style={{color:C.dim}}>—</span>}</div>
                </div>
                {detalle.addresses.length>0&&(
                  <div style={{gridColumn:'1/-1'}}>
                    <div style={{fontSize:10,color:C.dim,marginBottom:4}}>Direcciones de delivery ({detalle.addresses.length})</div>
                    {detalle.addresses.map((a,i)=>(
                      <div key={i} style={{fontSize:12,padding:'5px 10px',background:TINT.amberBg,borderRadius:6,marginBottom:4,display:'flex',alignItems:'center',gap:6}}>
                        <span style={{display:'inline-flex'}}><Icon name="bike" size={13}/></span><span style={{flex:1}}>{a}</span>
                      </div>
                    ))}
                  </div>
                )}
                {detalle.tables.length>0&&(
                  <div>
                    <div style={{fontSize:10,color:C.dim,marginBottom:2}}>Mesas usadas</div>
                    <div style={{fontSize:13}}>{detalle.tables.map(n=>`Mesa ${n}`).join(', ')}</div>
                  </div>
                )}
                {Object.keys(detalle.paymentMethods).length>0&&(
                  <div>
                    <div style={{fontSize:10,color:C.dim,marginBottom:2}}>Formas de pago</div>
                    <div style={{fontSize:12}}>{Object.entries(detalle.paymentMethods).map(([k,v])=>`${k} (${v}×)`).join(', ')}</div>
                  </div>
                )}
              </div>
            </div>

            {/* Estadísticas */}
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8}}>
              {[
                ['Total gastado',fmt(detalle.total),C.orange],
                ['Pedidos',detalle.orders,'#000'],
                ['Ticket prom.',fmt(detalle.ticket),'#000'],
                ['Días activo',detalle.diasActivo+' d','#6E6E73'],
              ].map(([lbl,val,clr])=>(
                <div key={lbl} style={{background:C.bg,borderRadius:8,padding:'10px 12px',textAlign:'center'}}>
                  <div style={{fontSize:15,fontWeight:800,color:clr,fontFamily:"'SF Mono',ui-monospace,monospace"}}>{val}</div>
                  <div style={{fontSize:10,color:C.dim,marginTop:3}}>{lbl}</div>
                </div>
              ))}
            </div>

            {/* Canales */}
            <div>
              <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:8}}>CANALES UTILIZADOS</div>
              <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                {Object.entries(detalle.canalCount).sort((a,b)=>b[1]-a[1]).map(([k,v])=>{
                  const pct = Math.round(v/detalle.orders*100);
                  return (
                    <div key={k} style={{background:C.bg,borderRadius:8,padding:'8px 12px',minWidth:90,textAlign:'center'}}>
                      <div style={{marginBottom:2,display:'flex',justifyContent:'center'}}><Icon name={CANAL_ICON[k]||'package'} size={20}/></div>
                      <div style={{fontSize:12,fontWeight:700,color:CANAL_COLOR[k]||'#000'}}>{v} pedido{v!==1?'s':''}</div>
                      <div style={{fontSize:10,color:C.dim}}>{ORDER_TYPES[k]||k}</div>
                      <div style={{fontSize:10,color:C.dim}}>{pct}%</div>
                    </div>
                  );
                })}
                {!Object.keys(detalle.canalCount).length&&<span style={{color:C.dim,fontSize:12}}>Sin datos</span>}
              </div>
            </div>

            {/* Actividad */}
            <div style={{background:C.bg,borderRadius:10,padding:14}}>
              <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:8}}>ACTIVIDAD</div>
              <div style={{display:'flex',gap:16,flexWrap:'wrap'}}>
                <div><div style={{fontSize:10,color:C.dim}}>Primer pedido</div><div style={{fontSize:13,fontWeight:600}}>{fmtDate(detalle.firstDate)}</div></div>
                <div><div style={{fontSize:10,color:C.dim}}>Último pedido</div><div style={{fontSize:13,fontWeight:600}}>{fmtDate(detalle.lastDate)} <span style={{fontSize:11,color:C.dim}}>({Math.floor((now-new Date(detalle.lastDate).getTime())/864e5)}d)</span></div></div>
                {detalle.pideFactura&&<div><div style={{fontSize:10,color:C.dim}}>Facturas solicitadas</div><div style={{fontSize:13,fontWeight:600,color:'#007AFF'}}>{detalle.facturaCount}×</div></div>}
              </div>
            </div>

            {/* Historial pedidos */}
            {detalleOrders.length>0&&(
              <div>
                <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:8}}>ÚLTIMOS PEDIDOS</div>
                <div style={{background:C.bg,borderRadius:10,overflow:'hidden'}}>
                  {detalleOrders.map((o,i)=>(
                    <div key={o.id} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'8px 12px',borderBottom:i<detalleOrders.length-1?`1px solid ${C.border}`:'none'}}>
                      <div style={{display:'flex',alignItems:'center',gap:8}}>
                        <span style={{display:'inline-flex'}}><Icon name={CANAL_ICON[o.type]||'package'} size={14}/></span>
                        <div>
                          <div style={{fontSize:12,fontWeight:600,color:C.ink}}>{o.num?`#${o.num}`:o.id.slice(0,8)}</div>
                          <div style={{fontSize:10,color:C.dim}}>{fmtDate(o.date)} · {ORDER_TYPES[o.type]||o.type||'—'}</div>
                        </div>
                      </div>
                      <div style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:13,fontWeight:700,color:C.ink}}>{fmt(o.total)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{display:'flex',justifyContent:'flex-end',gap:8}}>
              <Btn variant="secondary" onClick={()=>setDetalle(null)}>Cerrar</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════
   CAJA ADMIN
══════════════════════════════════════════════ */
function CajaAdminPage() {
  const [turnos,setTurnos]   = useState([]);
  const [movs,setMovs]       = useState([]);
  const [quejas,setQuejas]   = useState([]);
  const [loading,setLoading] = useState(true);
  const [selTurno,setSelTurno] = useState(null);
  const [cfg,setCfg]         = useState({cash_mode_default:'libre',cash_fondo_fijo:0,cash_diff_umbral:50000,cash_auto_retiro_excedente:false});
  const [savingCfg,setSavingCfg] = useState(false);
  // Multi-caja (mig 126). cajasAvailable=false ⇒ migración aún no aplicada → ocultar card (sin romper la página).
  const [cajas,setCajas]           = useState([]);
  const [cajaInfo,setCajaInfo]     = useState(null);   // {max_cajas,extra_cajas,effective_limit,active_count} | null
  const [cajasAvailable,setCajasAvailable] = useState(false);
  const [newCajaName,setNewCajaName] = useState('');
  const [editingCaja,setEditingCaja] = useState(null); // id en edición
  const [editCajaName,setEditCajaName] = useState('');
  const [busyCaja,setBusyCaja]     = useState(false);
  const [openTurnos,setOpenTurnos] = useState([]);     // turnos ABIERTOS (filtrado por estado, no por la ventana de 30)
  // Fase 2: config POR CAJA. selCajaCfg = caja cuya config se edita (null = legacy restaurante).
  const [selCajaCfg,setSelCajaCfg] = useState(null);
  const [rDefaults,setRDefaults]   = useState({cash_mode_default:'libre',cash_fondo_fijo:0,cash_diff_umbral:50000,cash_auto_retiro_excedente:false});

  // Config efectiva de una caja: su valor propio o, si es NULL, el del restaurante (mig 127).
  function cfgFromCaja(c, rd){
    return {
      cash_mode_default:          c.cash_mode_default || rd.cash_mode_default,
      cash_fondo_fijo:            c.cash_fondo_fijo!=null            ? Number(c.cash_fondo_fijo)  : rd.cash_fondo_fijo,
      cash_diff_umbral:           c.cash_diff_umbral!=null           ? Number(c.cash_diff_umbral) : rd.cash_diff_umbral,
      cash_auto_retiro_excedente: c.cash_auto_retiro_excedente!=null ? !!c.cash_auto_retiro_excedente : rd.cash_auto_retiro_excedente,
    };
  }
  const cajaNombreById = id => (cajas.find(c=>String(c.id)===String(id))||{}).nombre || '—';

  useEffect(()=>{ if(db) loadAll(); else setLoading(false); },[]);

  async function loadAll() {
    setLoading(true);
    const [tR,qR,rR,cR,lR,oR] = await Promise.all([
      db.from('turnos_caja').select('*').eq('restaurant_id',RID).order('fecha_apertura',{ascending:false}).limit(30),
      db.from('quejas_sugerencias').select('*').eq('restaurant_id',RID).order('created_at',{ascending:false}).limit(50),
      db.from('restaurants').select('cash_mode_default,cash_fondo_fijo,cash_diff_umbral,cash_auto_retiro_excedente').eq('id',RID).maybeSingle(),
      db.from('cajas').select('*').eq('restaurant_id',RID).order('sort_order').order('created_at'),
      db.rpc('get_my_caja_limit',{p_restaurant_id:RID}),
      // Turnos ABIERTOS sin recortar por la ventana de 30 (para el guard "no desactivar con turno abierto").
      db.from('turnos_caja').select('id,caja_id,estado').eq('restaurant_id',RID).eq('estado','abierto'),
    ]);
    const ts = tR.data||[];
    setTurnos(ts);
    setQuejas(qR.data||[]);
    setOpenTurnos(oR&&!oR.error ? (oR.data||[]) : []);
    // Defaults del restaurante (fallback de la config por caja).
    const rd = rR.data ? {
      cash_mode_default: rR.data.cash_mode_default || 'libre',
      cash_fondo_fijo: Number(rR.data.cash_fondo_fijo)||0,
      cash_diff_umbral: Number(rR.data.cash_diff_umbral)||50000,
      cash_auto_retiro_excedente: !!rR.data.cash_auto_retiro_excedente,
    } : {cash_mode_default:'libre',cash_fondo_fijo:0,cash_diff_umbral:50000,cash_auto_retiro_excedente:false};
    setRDefaults(rd);
    // Feature-detect multi-caja: si la tabla no existe (migración 126 sin aplicar), cR.error → ocultar card.
    const cajasList = cR.error ? [] : (cR.data||[]);
    if(cR.error){ setCajasAvailable(false); }
    else { setCajasAvailable(true); setCajas(cajasList); setCajaInfo(lR&&!lR.error ? (lR.data||null) : null); }
    // Config POR CAJA (Fase 2): editar la primera caja por defecto; sin cajas → config del restaurante (legacy).
    if(cajasList.length>0){ setSelCajaCfg(cajasList[0].id); setCfg(cfgFromCaja(cajasList[0], rd)); }
    else { setSelCajaCfg(null); setCfg(rd); }
    if(ts.length>0){
      const{data:md}=await db.from('movimientos_caja').select('*').eq('turno_id',ts[0].id).order('created_at',{ascending:false});
      setMovs(md||[]);
      setSelTurno(ts[0]);
    }
    setLoading(false);
  }

  async function saveCfg(){
    if(!db) return;
    const fondo=Number(cfg.cash_fondo_fijo);
    const umbral=Number(cfg.cash_diff_umbral);
    if(cfg.cash_mode_default==='fijo' && !(fondo>0)){
      toast('El fondo fijo debe ser mayor a 0 cuando el modo es "fijo"',false);return;
    }
    if(!(umbral>=0)){toast('Umbral inválido',false);return;}
    setSavingCfg(true);
    const payload={
      cash_mode_default: cfg.cash_mode_default,
      cash_fondo_fijo: fondo,
      cash_diff_umbral: umbral,
      cash_auto_retiro_excedente: cfg.cash_auto_retiro_excedente,
    };
    // Fase 2: si hay caja elegida → guardar SU config; sino (legacy) → restaurante.
    const{data,error}= selCajaCfg
      ? await db.from('cajas').update(payload).eq('id',selCajaCfg).select('id')
      : await db.from('restaurants').update(payload).eq('id',RID).select('id');
    if(error){toast('Error: '+error.message,false);}
    else if(!data||data.length===0){toast('No se pudo guardar — verificá la migración y RLS',false);}
    else{toast(selCajaCfg?`Configuración de ${cajaNombreById(selCajaCfg)} guardada`:'Configuración de caja guardada'); if(selCajaCfg) reloadCajas();}
    setSavingCfg(false);
  }

  async function loadMovs(turno){
    setSelTurno(turno);
    const{data}=await db.from('movimientos_caja').select('*').eq('turno_id',turno.id).order('created_at',{ascending:false});
    setMovs(data||[]);
  }

  // ─── Multi-caja (mig 126): CRUD + gating por plan ───
  async function reloadCajas(){
    const cR = await db.from('cajas').select('*').eq('restaurant_id',RID).order('sort_order').order('created_at');
    if(!cR.error){ setCajas(cR.data||[]); }
    const lR = await db.rpc('get_my_caja_limit',{p_restaurant_id:RID});
    if(!lR.error){ setCajaInfo(lR.data||null); }
  }
  async function createCaja(){
    const nombre=(newCajaName||'').trim();
    if(!nombre){ toast('Poné un nombre para la caja',false); return; }
    if(!puedeAgregarCaja){ toast('Llegaste al máximo de cajas de tu plan. Ampliá el plan o sumá una caja adicional.',false); return; }
    setBusyCaja(true);
    const maxOrder = cajas.reduce((m,c)=>Math.max(m, c.sort_order||0), -1);
    const{error}=await db.from('cajas').insert({restaurant_id:RID, nombre, activa:true, sort_order:maxOrder+1}).select('id');
    setBusyCaja(false);
    if(error){ toast('Error al crear caja: '+error.message,false); return; }
    setNewCajaName('');
    await reloadCajas();
    toast('Caja creada');
  }
  async function saveRenameCaja(c){
    const nombre=(editCajaName||'').trim();
    if(!nombre){ toast('El nombre no puede quedar vacío',false); return; }
    setBusyCaja(true);
    const{error}=await db.from('cajas').update({nombre}).eq('id',c.id).select('id');
    setBusyCaja(false);
    if(error){ toast('Error: '+error.message,false); return; }
    setEditingCaja(null); setEditCajaName('');
    await reloadCajas();
    toast('Caja renombrada');
  }
  async function toggleCaja(c){
    if(c.activa && cajaTieneTurnoAbierto(c)){ toast('No se puede desactivar: esta caja tiene un turno ABIERTO. Cerrá el turno primero.',false); return; }
    if(!c.activa && !sinTopeCajas && cajasActivas>=cajaLimitEff){ toast('Llegaste al máximo de cajas activas de tu plan.',false); return; }
    setBusyCaja(true);
    const{error}=await db.from('cajas').update({activa:!c.activa}).eq('id',c.id).select('id');
    setBusyCaja(false);
    if(error){ toast('Error: '+error.message,false); return; }
    await reloadCajas();
  }

  const cajasActivas  = cajas.filter(c=>c.activa).length;
  const cajaLimitEff  = cajaInfo ? cajaInfo.effective_limit : null;   // null = ilimitado
  const sinTopeCajas  = !cajaInfo || cajaLimitEff==null;              // sin dato o sin tope → no bloquear
  const puedeAgregarCaja = sinTopeCajas || cajasActivas < cajaLimitEff;
  // Caja "principal" implícita: primera activa por orden. En Fase 1 el panel caja sigue
  // abriendo turnos con caja_id=NULL (no se modifica) → esos turnos abiertos cuentan para
  // la caja principal. Un turno abierto bloquea desactivar la caja a la que pertenece.
  const primaryActiveCajaId = (cajas.find(c=>c.activa)||{}).id || null;
  function cajaTieneTurnoAbierto(c){
    return openTurnos.some(t=> t.caja_id===c.id || (t.caja_id==null && c.id===primaryActiveCajaId));
  }

  const turnoActivo = turnos.find(t=>t.estado==='abierto');
  const hoy = new Date().toISOString().slice(0,10);
  const turnosHoy = turnos.filter(t=>t.fecha_apertura.slice(0,10)===hoy);
  const cobradosHoy = turnosHoy.reduce((s,t)=>{
    /* sólo es una estimación rápida basada en movimientos del turno activo */
    return s;
  },0);

  const totalCobradoSel  = movs.filter(m=>m.tipo==='cobro').reduce((s,m)=>s+Number(m.monto),0);
  const pedidosCobradosSel = movs.filter(m=>m.tipo==='cobro').length;
  const totalEgresosSel  = movs.filter(m=>m.tipo==='egreso').reduce((s,m)=>s+Number(m.monto),0);

  const tipoColor={cobro:C.green,egreso:C.red,ingreso_manual:C.cyan,retiro_parcial:C.orange,reposicion:C.yellow,descuento:C.purple,cortesia:C.blue,propina:C.yellow};
  const quejaCols={queja:C.red,sugerencia:C.blue,comentario_positivo:C.green};

  if(!db) return (
    <div className="page">
      <h1 style={{fontSize:22,fontWeight:800,color:C.ink,marginBottom:16}}>Caja</h1>
      <AlertBoxAdmin type="warn">Sin conexión a Supabase. Configurá las credenciales para ver datos de caja.</AlertBoxAdmin>
      <a href="caja.html" style={{display:'inline-block',marginTop:12,padding:'10px 20px',background:C.ink,color:C.sidebar,borderRadius:6,fontSize:13,fontWeight:700,textDecoration:'none'}}>Abrir Panel de Caja →</a>
    </div>
  );

  return (
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
        <h1 style={{fontSize:22,fontWeight:800,color:C.ink}}>Caja</h1>
        <a href="caja.html" target="_blank" style={{padding:'9px 18px',background:C.ink,color:C.sidebar,borderRadius:6,fontSize:13,fontWeight:700,textDecoration:'none',display:'inline-flex',alignItems:'center',gap:6}}>
          <Icon name="creditCard" size={14}/> Abrir Panel de Caja
        </a>
      </div>

      {loading && <div style={{textAlign:'center',padding:40}}><span className="spin"/></div>}
      {!loading && (
        <>
          {/* TUS CAJAS (multi-caja · mig 126) */}
          {cajasAvailable && (
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'14px 18px',marginBottom:14}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:12,gap:12,flexWrap:'wrap'}}>
              <div>
                <div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:1}}>TUS CAJAS</div>
                <div style={{fontSize:11,color:C.dim,marginTop:4,lineHeight:1.5}}>
                  Puntos de cobro (POS) del local. En el panel de Caja, el cajero elegirá con cuál abre su turno.
                </div>
              </div>
              <div style={{fontSize:11,color:C.dim,textAlign:'right',whiteSpace:'nowrap'}}>
                <span style={{fontWeight:700,color:C.ink}}>{cajasActivas}</span> activa{cajasActivas===1?'':'s'}
                {sinTopeCajas
                  ? <span style={{color:C.dim}}> · sin tope</span>
                  : <span style={{color:C.dim}}> / {cajaLimitEff} del plan{cajaInfo?.extra_cajas?` (+${cajaInfo.extra_cajas} extra)`:''}</span>}
              </div>
            </div>

            {cajas.length===0 && (
              <div style={{fontSize:13,color:C.dim,padding:'8px 0 12px'}}>Todavía no tenés cajas. Creá la primera para empezar.</div>
            )}

            {cajas.length>0 && (
              <div style={{display:'flex',flexDirection:'column',gap:8,marginBottom:14}}>
                {cajas.map(c=>{
                  const turnoAbierto = cajaTieneTurnoAbierto(c);
                  const bloqueaReactivar = !c.activa && !sinTopeCajas && cajasActivas>=cajaLimitEff;
                  return (
                    <div key={c.id} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',border:`1px solid ${C.border}`,borderRadius:6,background:c.activa?'transparent':'rgba(0,0,0,0.02)',opacity:c.activa?1:0.7}}>
                      <div style={{width:8,height:8,borderRadius:'50%',background:c.activa?C.green:'#C7C7CC',flexShrink:0}}/>
                      {editingCaja===c.id ? (
                        <>
                          <Inp value={editCajaName} onChange={e=>setEditCajaName(e.target.value)} full={false} style={{flex:1,minWidth:0}}/>
                          <Btn small onClick={()=>saveRenameCaja(c)} disabled={busyCaja}>Guardar</Btn>
                          <Btn small variant="ghost" onClick={()=>{setEditingCaja(null);setEditCajaName('');}}>Cancelar</Btn>
                        </>
                      ) : (
                        <>
                          <div style={{flex:1,minWidth:0}}>
                            <span style={{fontSize:14,fontWeight:600,color:C.ink}}>{c.nombre}</span>
                            {c.zona && <span style={{fontSize:11,color:C.dim,marginLeft:8}}>· {c.zona}</span>}
                            {!c.activa && <span style={{fontSize:11,color:C.dim,marginLeft:8}}>· inactiva</span>}
                            {turnoAbierto && <span style={{fontSize:11,color:C.green,marginLeft:8,fontWeight:700}}>· turno abierto</span>}
                          </div>
                          <Btn small variant="ghost" onClick={()=>{setEditingCaja(c.id);setEditCajaName(c.nombre);}}>Renombrar</Btn>
                          <Btn small variant="ghost" onClick={()=>toggleCaja(c)} disabled={busyCaja || (c.activa && turnoAbierto) || bloqueaReactivar}
                            title={bloqueaReactivar?'Llegaste al máximo de cajas activas de tu plan':(c.activa&&turnoAbierto?'La caja tiene un turno abierto':undefined)}>
                            {c.activa?'Desactivar':'Activar'}
                          </Btn>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
              <Inp value={newCajaName} onChange={e=>setNewCajaName(e.target.value)} placeholder="Nombre de la nueva caja (ej: Caja 2, Terraza)" full={false} style={{flex:1,minWidth:200}} disabled={!puedeAgregarCaja}/>
              <Btn onClick={createCaja} disabled={busyCaja || !puedeAgregarCaja || !newCajaName.trim()}>+ Agregar caja</Btn>
            </div>
            {!puedeAgregarCaja && (
              <div style={{fontSize:12,color:C.orange,marginTop:8,fontWeight:600}}>
                Llegaste al máximo de cajas de tu plan. Ampliá el plan o sumá una caja adicional.
              </div>
            )}
          </div>
          )}

          {/* Configuración de cierre/apertura */}
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'14px 18px',marginBottom:14}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:12,gap:12,flexWrap:'wrap'}}>
              <div style={{flex:1,minWidth:240}}>
                <div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:1}}>CONFIGURACIÓN DE APERTURA / CIERRE{selCajaCfg?` · ${cajaNombreById(selCajaCfg)}`:''}</div>
                <div style={{fontSize:11,color:C.dim,marginTop:4,lineHeight:1.5}}>
                  {cajasAvailable&&cajas.length>0
                    ? <>Cada caja tiene su <strong>propio fondo fijo, umbral y modo</strong>. Elegí una caja para editar su configuración. En modo <strong>fondo fijo</strong> el cajero confirma el monto preestablecido al abrir.</>
                    : <>Definí cómo se abre y cierra la caja cada día. En modo <strong>fondo fijo</strong> el cajero confirma el monto preestablecido al abrir y al cerrar deja ese mismo monto en caja (el excedente puede entregarse automáticamente a administración).</>}
                </div>
              </div>
              {cajasAvailable&&cajas.length>0&&(
                <div style={{minWidth:180}}>
                  <Lbl>CAJA</Lbl>
                  <Sel value={selCajaCfg||''} onChange={e=>{ const id=e.target.value; setSelCajaCfg(id); const c=cajas.find(x=>String(x.id)===String(id)); if(c) setCfg(cfgFromCaja(c,rDefaults)); }}>
                    {cajas.map(c=><option key={c.id} value={c.id}>{c.nombre}{c.activa?'':' (inactiva)'}</option>)}
                  </Sel>
                </div>
              )}
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(2, minmax(0,1fr))',gap:14,marginBottom:14}}>
              <div>
                <Lbl>MODO POR DEFECTO</Lbl>
                <div style={{display:'flex',gap:8,marginTop:4}}>
                  {[['libre','Libre (cajero define)'],['fijo','Fondo fijo']].map(([v,lbl])=>(
                    <button key={v} onClick={()=>setCfg({...cfg,cash_mode_default:v})}
                      style={{padding:'8px 14px',fontSize:12,borderRadius:6,border:`1px solid ${cfg.cash_mode_default===v?C.ink:C.border}`,background:cfg.cash_mode_default===v?C.ink:'transparent',color:cfg.cash_mode_default===v?C.surface:C.mid,fontWeight:cfg.cash_mode_default===v?700:500,cursor:'pointer'}}>{lbl}</button>
                  ))}
                </div>
              </div>
              <div>
                <Lbl>FONDO FIJO (₲) {cfg.cash_mode_default==='fijo'?'— requerido':'— opcional'}</Lbl>
                <MoneyInp value={cfg.cash_fondo_fijo||0} onChange={v=>setCfg({...cfg,cash_fondo_fijo:v})} placeholder="500000" style={{width:'100%'}} disabled={cfg.cash_mode_default!=='fijo'}/>
                <div style={{fontSize:11,color:C.dim,marginTop:6}}>Monto que debe permanecer en caja para el próximo turno.</div>
              </div>
              <div>
                <Lbl>UMBRAL DE DIFERENCIA SIN JUSTIFICAR (₲)</Lbl>
                <MoneyInp value={cfg.cash_diff_umbral||0} onChange={v=>setCfg({...cfg,cash_diff_umbral:v})} placeholder="50000" style={{width:'100%'}}/>
                <div style={{fontSize:11,color:C.dim,marginTop:6}}>Si la diferencia entre contado y esperado supera este monto, el cajero deberá justificar.</div>
              </div>
              <div>
                <Lbl>EXCEDENTE AL CERRAR</Lbl>
                <label style={{display:'flex',alignItems:'center',gap:8,marginTop:8,cursor:'pointer'}}>
                  <input type="checkbox" checked={!!cfg.cash_auto_retiro_excedente} onChange={e=>setCfg({...cfg,cash_auto_retiro_excedente:e.target.checked})} style={{width:16,height:16,cursor:'pointer'}}/>
                  <span style={{fontSize:13,color:C.ink,fontWeight:500}}>Generar retiro automático del excedente a administración</span>
                </label>
                <div style={{fontSize:11,color:C.dim,marginTop:6,lineHeight:1.5}}>Solo aplica en modo "fondo fijo". Al cerrar, se registra un movimiento <code>retiro_parcial</code> con el sobrante (contado − fondo fijo).</div>
              </div>
            </div>
            <Btn onClick={saveCfg} disabled={savingCfg}>{savingCfg?'Guardando…':'Guardar configuración de caja'}</Btn>
          </div>

          {/* Estado del turno actual */}
          <div style={{background:turnoActivo?'rgba(34,197,94,0.06)':C.surface,border:`1px solid ${turnoActivo?'rgba(34,197,94,0.25)':C.border}`,borderRadius:8,padding:'14px 18px',marginBottom:14,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <div>
              <div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:4}}>ESTADO DEL TURNO</div>
              {turnoActivo ? (
                <div style={{display:'flex',alignItems:'center',gap:10}}>
                  <div style={{width:8,height:8,borderRadius:'50%',background:C.green}} className="pulse"/>
                  <span style={{fontWeight:700,color:C.green}}>TURNO ABIERTO</span>
                  <span style={{fontSize:12,color:C.mid}}>Cajero: {turnoActivo.cajero_nombre||'—'}</span>
                  <span style={{fontSize:12,color:C.dim}}>Desde: {fmtTime(turnoActivo.fecha_apertura)}</span>
                </div>
              ) : (
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <div style={{width:8,height:8,borderRadius:'50%',background:'#D2D2D7'}}/>
                  <span style={{color:C.mid,fontWeight:700}}>SIN TURNO ACTIVO</span>
                </div>
              )}
            </div>
            {turnoActivo && (
              <div style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:11,color:C.dim}}>
                Fondo apertura: {fmt(turnoActivo.fondo_apertura?.total||0)}
              </div>
            )}
          </div>

          {/* KPIs del turno seleccionado */}
          {selTurno && (
            <>
              <div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:10}}>
                {selTurno.estado==='abierto'?'TURNO ACTIVO':'ÚLTIMO TURNO'} — {fmtDate(selTurno.fecha_apertura)}
              </div>
              <div style={{display:'flex',gap:10,marginBottom:14,flexWrap:'wrap'}}>
                <KpiCard label="Pedidos cobrados" value={pedidosCobradosSel} sub={`Turno ${selTurno.cajero_nombre||''}`} accent={C.green}/>
                <KpiCard label="Total cobrado"    value={fmt(totalCobradoSel)} sub="todos los métodos" accent={C.green}/>
                <KpiCard label="Egresos"          value={fmt(totalEgresosSel)} sub={`${movs.filter(m=>m.tipo==='egreso').length} registros`} accent={C.red}/>
                {selTurno.estado==='cerrado' && selTurno.diferencia!=null && (
                  <KpiCard label="Diferencia arqueo" value={`${selTurno.diferencia>=0?'+':''}${fmt(selTurno.diferencia)}`} sub="efectivo" accent={selTurno.diferencia===0?C.green:Math.abs(selTurno.diferencia)<50000?C.yellow:C.red}/>
                )}
              </div>
            </>
          )}

          <div style={{display:'grid',gridTemplateColumns:'1fr 320px',gap:14}}>
            {/* Movimientos del turno seleccionado */}
            <div>
              <div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:4}}>MOVIMIENTOS DEL TURNO</div>
              {selTurno&&(
                <div style={{fontSize:11,color:C.dim,marginBottom:10}}>
                  {selTurno.caja_id?<><strong style={{color:C.mid}}>{cajaNombreById(selTurno.caja_id)}</strong> · </>:''}
                  Cajero: {selTurno.cajero_nombre||'—'}
                </div>
              )}
              {selTurno&&(
                <div style={{marginBottom:10,display:'flex',gap:6,flexWrap:'wrap'}}>
                  {turnos.slice(0,5).map(t=>(
                    <button key={t.id} onClick={()=>loadMovs(t)}
                      style={{padding:'4px 10px',fontSize:11,borderRadius:5,border:`1px solid ${selTurno?.id===t.id?C.ink:C.border}`,background:selTurno?.id===t.id?C.ink:'transparent',color:selTurno?.id===t.id?C.sidebar:C.mid,cursor:'pointer',fontWeight:selTurno?.id===t.id?700:400}}>
                      {fmtDate(t.fecha_apertura)} {cajasAvailable&&t.caja_id?`· ${cajaNombreById(t.caja_id)} `:''}{t.cajero_nombre?`(${t.cajero_nombre.split(' ')[0]})`:''} {t.estado==='abierto'?<span style={{color:'#34C759'}}>●</span>:''}
                    </button>
                  ))}
                </div>
              )}
              <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
                <table style={{width:'100%',borderCollapse:'collapse'}}>
                  <thead><tr style={{borderBottom:`1px solid ${C.border}`}}>
                    <Th>Hora</Th><Th>Tipo</Th><Th>Descripción</Th><Th>Cajero</Th><Th>Método</Th><Th right>Monto</Th>
                  </tr></thead>
                  <tbody>
                    {movs.slice(0,40).map(m=>(
                      <tr key={m.id} style={{borderBottom:`1px solid #0d0d0d`}}>
                        <Td mono dim>{fmtTime(m.created_at)}</Td>
                        <Td><span style={{background:(tipoColor[m.tipo]||'#6E6E73')+'22',color:tipoColor[m.tipo]||'#6E6E73',padding:'2px 7px',fontSize:11,fontWeight:700,borderRadius:4}}>{m.tipo}</span></Td>
                        <Td><span style={{fontSize:12}}>{m.descripcion||'—'}</span></Td>
                        <Td dim><span style={{fontSize:11}}>{m.usuario_nombre||'—'}</span></Td>
                        <Td dim><span style={{fontSize:11}}>{m.metodo_pago||'—'}</span></Td>
                        <Td mono right style={{color:['cobro','ingreso_manual'].includes(m.tipo)?C.green:['egreso','retiro_parcial'].includes(m.tipo)?C.red:C.mid}}>
                          {['egreso','retiro_parcial'].includes(m.tipo)?'- ':''}{fmt(m.monto)}
                        </Td>
                      </tr>
                    ))}
                    {movs.length===0&&<EmptyRow cols={6} label="Sin movimientos en este turno"/>}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Panel derecho: historial + quejas */}
            <div style={{display:'flex',flexDirection:'column',gap:14}}>
              {/* Historial de turnos */}
              <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
                <div style={{padding:'10px 14px',borderBottom:`1px solid ${C.border}`,fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1}}>HISTORIAL DE TURNOS</div>
                <table style={{width:'100%',borderCollapse:'collapse'}}>
                  <thead><tr style={{borderBottom:`1px solid ${C.border}`}}><Th>Cajero</Th><Th>Apertura</Th><Th right>Estado</Th></tr></thead>
                  <tbody>
                    {turnos.slice(0,8).map(t=>(
                      <tr key={t.id} style={{borderBottom:`1px solid #0d0d0d`,cursor:'pointer'}} onClick={()=>loadMovs(t)}>
                        <Td>
                          <span style={{fontSize:12}}>{t.cajero_nombre||'—'}</span>
                          {cajasAvailable&&t.caja_id&&<div style={{fontSize:10,color:C.dim}}>{cajaNombreById(t.caja_id)}</div>}
                        </Td>
                        <Td mono dim>{fmtDate(t.fecha_apertura)}</Td>
                        <Td right>
                          <span style={{background:t.estado==='abierto'?C.green+'22':C.dim+'22',color:t.estado==='abierto'?C.green:C.dim,border:`1px solid ${t.estado==='abierto'?C.green:C.dim}44`,padding:'2px 7px',fontSize:10,fontWeight:700,borderRadius:4}}>
                            {t.estado}
                            {t.estado==='cerrado'&&t.diferencia!=null&&` Δ${fmt(t.diferencia)}`}
                          </span>
                        </Td>
                      </tr>
                    ))}
                    {turnos.length===0&&<EmptyRow cols={3} label="Sin turnos registrados"/>}
                  </tbody>
                </table>
              </div>

              {/* Quejas recientes */}
              <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
                <div style={{padding:'10px 14px',borderBottom:`1px solid ${C.border}`,fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  QUEJAS RECIENTES
                  {quejas.filter(q=>q.estado==='abierto').length>0&&(
                    <span style={{background:C.red+'22',color:C.red,border:`1px solid ${C.red}44`,padding:'1px 7px',fontSize:10,fontWeight:700,borderRadius:4}}>
                      {quejas.filter(q=>q.estado==='abierto').length} abiertas
                    </span>
                  )}
                </div>
                <div style={{maxHeight:200,overflowY:'auto'}}>
                  {quejas.slice(0,8).map(q=>(
                    <div key={q.id} style={{padding:'8px 14px',borderBottom:`1px solid #0d0d0d`}}>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:2}}>
                        <span style={{background:(quejaCols[q.tipo]||'#6E6E73')+'22',color:quejaCols[q.tipo]||'#6E6E73',padding:'1px 6px',fontSize:10,fontWeight:700,borderRadius:4}}>{q.tipo}</span>
                        {q.urgencia==='alta'&&<span style={{background:C.red+'22',color:C.red,padding:'1px 6px',fontSize:10,fontWeight:700,borderRadius:4}}>ALTA</span>}
                        <span style={{fontSize:10,color:C.dim}}>{fmtDate(q.created_at)}</span>
                      </div>
                      <div style={{fontSize:11,color:C.mid,marginTop:2,overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis'}}>{q.descripcion}</div>
                    </div>
                  ))}
                  {quejas.length===0&&<div style={{padding:20,textAlign:'center',color:C.dim,fontSize:12}}>Sin quejas registradas</div>}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* helper local para la página de caja */
function AlertBoxAdmin({type='info',children}){
  const cfg={info:{bg:'rgba(59,130,246,0.08)',border:'rgba(59,130,246,0.25)',color:'#93c5fd'},warn:{bg:'rgba(251,191,36,0.08)',border:'rgba(251,191,36,0.25)',color:'#fde68a'},error:{bg:'rgba(239,68,68,0.08)',border:'rgba(239,68,68,0.25)',color:'#fca5a5'}};
  const s=cfg[type]||cfg.info;
  return<div style={{background:s.bg,border:`1px solid ${s.border}`,color:s.color,padding:'10px 14px',borderRadius:8,fontSize:13}}>{children}</div>;
}

/* ══════════════════════════════════════════════
   FINANZAS — Tabs: resumen, movimientos, alertas, exportar
══════════════════════════════════════════════ */
/* ══════════════════════════════════════════════
   COMPROBANTE — diseñador + impresora (usa window.MythosReceipt)
   El render 80mm vive en public/mythos-receipt.js; acá editamos la
   config (settings_json.receipt) + la identidad (tabla restaurants) y
   mostramos la vista previa con el MISMO renderer que imprime caja.
══════════════════════════════════════════════ */
function RcToggle({on,onChange,label,hint}){
  return (
    <button type="button" onClick={()=>onChange(!on)} style={{display:'flex',alignItems:'center',gap:11,width:'100%',background:'transparent',border:'none',padding:'7px 0',cursor:'pointer',textAlign:'left'}}>
      <span style={{width:34,height:20,borderRadius:20,background:on?C.ink:C.border,position:'relative',flexShrink:0,transition:'background .15s'}}>
        <span style={{position:'absolute',top:2,left:on?16:2,width:16,height:16,borderRadius:'50%',background:C.surface,boxShadow:'0 1px 2px rgba(0,0,0,.2)',transition:'left .15s'}}/>
      </span>
      <span style={{flex:1,minWidth:0}}>
        <span style={{fontSize:13,color:C.ink,fontWeight:on?600:400}}>{label}</span>
        {hint&&<span style={{display:'block',fontSize:11,color:C.dim,marginTop:1}}>{hint}</span>}
      </span>
    </button>
  );
}

// Carga settings_json.receipt mergeada con los defaults del renderer.
async function _loadReceiptCfg(){
  const base=(window.MythosReceipt&&window.MythosReceipt.defaultConfig)||{};
  let rc={};
  try{
    const{data}=await db.from('restaurant_settings').select('settings_json').eq('restaurant_id',RID).maybeSingle();
    rc=(data&&data.settings_json&&data.settings_json.receipt)||{};
  }catch(e){}
  return {
    ...base, ...rc,
    fields:{...(base.fields||{}),...(rc.fields||{})},
    header:{...(base.header||{}),...(rc.header||{})},
    social:{...(base.social||{}),...(rc.social||{})},
  };
}
// Guarda un parche en settings_json.receipt sin pisar otras keys (read-merge-write).
async function _saveReceiptCfg(patch){
  const{data:cur}=await db.from('restaurant_settings').select('settings_json').eq('restaurant_id',RID).maybeSingle();
  const sj={...((cur&&cur.settings_json)||{})};
  sj.receipt={...(sj.receipt||{}),...patch};
  const{error}=await db.from('restaurant_settings').upsert({restaurant_id:RID,settings_json:sj},{onConflict:'restaurant_id'});
  if(error) throw error;
}

function ComprobanteDesign({restaurant,onRefresh}){
  const MR=window.MythosReceipt;
  const [cfg,setCfg]=useState(()=> (MR&&MR.defaultConfig)||{});
  const [biz,setBiz]=useState({name:'',address:'',phone:'',instagram:'',logo_url:''});
  const [loaded,setLoaded]=useState(false);
  const [saving,setSaving]=useState(false);

  useEffect(()=>{
    let alive=true;
    (async()=>{
      const c=await _loadReceiptCfg();
      const r=restaurant||{};
      if(!alive)return;
      setBiz({name:r.name||'',address:r.address||'',phone:r.phone||'',instagram:r.instagram||'',logo_url:r.logo_url||''});
      setCfg(c); setLoaded(true);
    })();
    return ()=>{alive=false;};
  },[]);

  const setField =(k,v)=>setCfg(c=>({...c,fields:{...c.fields,[k]:v}}));
  const setHeader=(k,v)=>setCfg(c=>({...c,header:{...c.header,[k]:v}}));

  async function save(){
    setSaving(true);
    try{
      await db.from('restaurants').update({name:biz.name||null,address:biz.address||null,phone:biz.phone||null,instagram:biz.instagram||null,logo_url:biz.logo_url||null}).eq('id',RID);
      await _saveReceiptCfg({showLogo:cfg.showLogo,fields:cfg.fields,header:cfg.header,footer:cfg.footer,social:cfg.social});
      toast('Diseño del comprobante guardado');
      if(onRefresh) onRefresh(true);
    }catch(e){ toast('No se pudo guardar: '+(e.message||e),false); }
    setSaving(false);
  }

  const previewBiz={name:biz.name,address:biz.address,phone:biz.phone,instagram:biz.instagram,logoUrl:biz.logo_url,ruc:(restaurant||{}).ruc,legalName:(restaurant||{}).legal_name,facebook:(cfg.social&&cfg.social.facebook)||''};
  const previewHtml=(loaded&&MR)? MR.buildHTML(MR.sampleData,{...cfg,business:previewBiz}) : '';

  const FIELDS=[['orderNumber','N° de pedido'],['customerName','Nombre del cliente (o "Anónimo")'],['table','N° de mesa'],['cashier','Cajero'],['dateTime','Fecha y hora'],['paymentMethod','Método de pago'],['change','Vuelto'],['ruc','RUC del cliente (si lo dio)']];
  const HEAD=[['showName','Nombre comercial'],['showRuc','RUC / Razón social'],['showAddress','Dirección'],['showPhone','Teléfono'],['showInstagram','Instagram'],['showFacebook','Facebook']];

  if(!loaded) return <div style={{padding:40,textAlign:'center',color:C.dim,fontSize:13}}><span className="spin"/> Cargando…</div>;

  return (
    <div style={{display:'grid',gridTemplateColumns:'1fr 320px',gap:18,alignItems:'start'}}>
      <div style={{display:'flex',flexDirection:'column',gap:16,minWidth:0}}>
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:18}}>
          <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:14}}>DATOS DEL NEGOCIO</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
            <div><Lbl>NOMBRE COMERCIAL</Lbl><Inp value={biz.name} onChange={e=>setBiz({...biz,name:e.target.value})}/></div>
            <div><Lbl>TELÉFONO</Lbl><Inp value={biz.phone} onChange={e=>setBiz({...biz,phone:e.target.value})}/></div>
            <div style={{gridColumn:'1 / -1'}}><Lbl>DIRECCIÓN</Lbl><Inp value={biz.address} onChange={e=>setBiz({...biz,address:e.target.value})}/></div>
            <div><Lbl>INSTAGRAM</Lbl><Inp value={biz.instagram} onChange={e=>setBiz({...biz,instagram:e.target.value})} placeholder="kamuipoolbar"/></div>
            <div><Lbl>FACEBOOK</Lbl><Inp value={(cfg.social&&cfg.social.facebook)||''} onChange={e=>setCfg({...cfg,social:{...cfg.social,facebook:e.target.value}})}/></div>
            <div style={{gridColumn:'1 / -1'}}><Lbl>TEXTO AL PIE</Lbl><Inp value={cfg.footer||''} onChange={e=>setCfg({...cfg,footer:e.target.value})} placeholder="¡Gracias por su visita!"/></div>
          </div>
          <div style={{marginTop:14,display:'flex',gap:14,alignItems:'flex-start'}}>
            <div style={{flexShrink:0}}>
              {biz.logo_url
                ? <div style={{position:'relative',width:64,height:64}}>
                    <img src={biz.logo_url} alt="" style={{width:64,height:64,objectFit:'cover',borderRadius:10,border:`1px solid ${C.border}`}} onError={e=>{e.target.style.display='none';}}/>
                    <button onClick={()=>setBiz({...biz,logo_url:''})} title="Quitar logo" style={{position:'absolute',top:-6,right:-6,width:18,height:18,borderRadius:'50%',background:'#FF3B30',border:'none',color:'#fff',fontSize:10,cursor:'pointer',fontWeight:700}}>✕</button>
                  </div>
                : <div style={{width:64,height:64,borderRadius:10,background:C.white,border:`1px dashed ${C.border}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,color:C.dim}}>Sin logo</div>}
            </div>
            <div style={{flex:1,minWidth:0}}>
              <Lbl>LOGO</Lbl>
              <ImageUploader compact value={biz.logo_url||''} onChange={url=>setBiz({...biz,logo_url:url})} bucket="restaurant-images"/>
              <div style={{marginTop:8}}><RcToggle on={!!cfg.showLogo} onChange={v=>setCfg({...cfg,showLogo:v})} label="Mostrar logo en el comprobante" hint="Algunas térmicas rinden mal las imágenes."/></div>
            </div>
          </div>
        </div>

        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:18}}>
          <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:6}}>ENCABEZADO — QUÉ MOSTRAR</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 18px'}}>
            {HEAD.map(([k,l])=><RcToggle key={k} on={cfg.header?.[k]!==false} onChange={v=>setHeader(k,v)} label={l}/>)}
          </div>
        </div>

        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:18}}>
          <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:6}}>CAMPOS DEL COMPROBANTE</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 18px'}}>
            {FIELDS.map(([k,l])=><RcToggle key={k} on={cfg.fields?.[k]!==false} onChange={v=>setField(k,v)} label={l}/>)}
          </div>
        </div>

        <div><Btn onClick={save} disabled={saving}>{saving?'Guardando…':'Guardar diseño'}</Btn></div>
      </div>

      <div style={{position:'sticky',top:12}}>
        <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:8}}>VISTA PREVIA · 80MM</div>
        <div style={{background:'#fff',border:`1px solid ${C.border}`,borderRadius:10,padding:14,display:'flex',justifyContent:'center'}}>
          <iframe title="preview-comprobante" srcDoc={previewHtml} style={{width:'80mm',minHeight:360,border:'none',background:'#fff'}}/>
        </div>
        <div style={{fontSize:11,color:C.dim,marginTop:8}}>Con datos de ejemplo. Lo que ves es lo que se imprime.</div>
      </div>
    </div>
  );
}

function ImpresoraConfig({restaurant}){
  const MR=window.MythosReceipt;
  const [cfg,setCfg]=useState(()=>(MR&&MR.defaultConfig)||{paperWidth:80,charsPerLine:32});
  const [loaded,setLoaded]=useState(false);
  const [saving,setSaving]=useState(false);

  useEffect(()=>{ let alive=true; (async()=>{ const c=await _loadReceiptCfg(); if(alive){setCfg(c);setLoaded(true);} })(); return ()=>{alive=false;}; },[]);

  async function save(){
    setSaving(true);
    try{ await _saveReceiptCfg({paperWidth:Number(cfg.paperWidth)||80,charsPerLine:Number(cfg.charsPerLine)||32}); toast('Configuración de impresora guardada'); }
    catch(e){ toast('No se pudo guardar: '+(e.message||e),false); }
    setSaving(false);
  }
  function testPrint(){
    if(!MR){toast('Módulo de impresión no disponible',false);return;}
    const r=restaurant||{};
    const biz={name:r.name||'Mythos',address:r.address||'',phone:r.phone||'',instagram:r.instagram||'',logoUrl:r.logo_url||'',ruc:r.ruc||'',legalName:r.legal_name||'',facebook:(cfg.social&&cfg.social.facebook)||''};
    const ok=MR.print(MR.sampleData,{...cfg,business:biz});
    if(ok===false) toast('Permití ventanas emergentes para imprimir',false);
  }

  if(!loaded) return <div style={{padding:40,textAlign:'center',color:C.dim,fontSize:13}}><span className="spin"/> Cargando…</div>;

  return (
    <div style={{maxWidth:560,display:'flex',flexDirection:'column',gap:16}}>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:18}}>
        <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:14}}>PAPEL</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
          <div><Lbl>ANCHO DE PAPEL</Lbl>
            <Sel value={String(cfg.paperWidth||80)} onChange={e=>setCfg({...cfg,paperWidth:Number(e.target.value)})}>
              <option value="80">80 mm</option><option value="58">58 mm</option>
            </Sel>
          </div>
          <div><Lbl>CARACTERES POR LÍNEA</Lbl><Inp type="number" value={cfg.charsPerLine||32} onChange={e=>setCfg({...cfg,charsPerLine:e.target.value})}/></div>
        </div>
      </div>

      <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
        <Btn onClick={save} disabled={saving}>{saving?'Guardando…':'Guardar'}</Btn>
        <Btn variant="secondary" onClick={testPrint}><Icon name="print" size={14} style={{verticalAlign:'-2px',marginRight:5}}/>Imprimir prueba</Btn>
      </div>

      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:'16px 18px',fontSize:12.5,color:C.mid,lineHeight:1.65}}>
        <div style={{fontSize:13,fontWeight:800,color:C.ink,marginBottom:8}}>Imprimir sin clicks (recomendado para caja)</div>
        <div style={{marginBottom:6}}>Para que el ticket salga <strong>al instante, sin el diálogo del navegador</strong>, configurá la PC de caja una sola vez:</div>
        <ol style={{margin:'0 0 10px 18px',padding:0,display:'flex',flexDirection:'column',gap:4}}>
          <li>Poné la <strong>POS-80C como impresora predeterminada</strong> de Windows (Configuración → Bluetooth y dispositivos → Impresoras → POS-80C → “Predeterminar”). Así no arranca en “Microsoft Print to PDF”.</li>
          <li>En sus <strong>propiedades</strong>, fijá el tamaño de papel en 80 mm (o el rollo) y márgenes en 0. Subí la <strong>densidad / oscuridad de impresión al máximo</strong> (el navegador imprime como gráfico, así que la densidad alta = texto más negro). Ahí mismo activá el <strong>corte automático</strong> y, si tenés, el <strong>pulso de cajón</strong>.</li>
          <li>Abrí Mythos con un acceso directo de Chrome en <strong>modo kiosco de impresión</strong>: clic derecho en el ícono de Chrome → Propiedades → en “Destino” agregá <code style={{fontFamily:"'SF Mono',monospace",background:C.bg,padding:'1px 5px',borderRadius:4}}>--kiosk-printing</code> al final (después de las comillas, con un espacio). Abrí caja con ESE acceso directo.</li>
        </ol>
        <div style={{marginBottom:10}}>Con eso, al cobrar el comprobante se imprime directo en la térmica, <strong>sin diálogo ni clicks</strong>.</div>
        <div style={{borderTop:`1px solid ${C.border}`,paddingTop:10}}>
          <strong style={{color:C.ink}}>Sin modo kiosco</strong> aparece el diálogo: elegí la POS-80C y poné márgenes en “Ninguno”. El <strong>corte de papel</strong> y la <strong>apertura del cajón</strong> los maneja el <em>driver</em> de Windows, no Mythos: una web no envía comandos ESC/POS directos. Para controlarlos por software haría falta un agente de escritorio.
        </div>
      </div>
    </div>
  );
}

function FinanzasPage({orders, restaurant, showDelivery=true, onRefresh}) {
  const [finTab,setFinTab] = useState('resumen');
  const [period,setPeriod] = useState('semana');
  const [egresos,setEgresos] = useState([]);
  const [loadingEg,setLoadingEg] = useState(false);
  const [delivPct,setDelivPct] = useState(()=>LS.get(DELIV_KEY,0));
  const [showEgForm,setShowEgForm] = useState(false);
  const [savingEg,setSavingEg] = useState(false);
  const [egForm,setEgForm] = useState({date:new Date().toISOString().slice(0,10),desc:'',amount:'',category:'Insumos'});
  const [movFilter,setMovFilter] = useState('todos');
  const [movSearch,setMovSearch] = useState('');
  const [alertas,setAlertas] = useState({ordesSinMonto:[],turnosSinCierre:[],diferencias:[]});
  const [loadingAlertas,setLoadingAlertas] = useState(false);
  const [exportMes,setExportMes] = useState(new Date().toISOString().slice(0,7));
  const [delivRows,setDelivRows] = useState([]);   // delivery por canal del período (Parte 4)

  // Delivery por canal: bruto/comisión/neto CONGELADOS por pedido (delivery_orders),
  // nombres desde delivery_channels. Se recarga al cambiar el período.
  async function loadDelivByChannel(){
    if(!db || !showDelivery){ setDelivRows([]); return; }   // plan sin delivery → no cargar ni mostrar
    const st = periodStart(period);
    const [doR,chR] = await Promise.all([
      db.from('delivery_orders').select('channel,channel_commission,order_total,rider_status,created_at').eq('restaurant_id',RID).gte('created_at',st.toISOString()),
      db.from('delivery_channels').select('slug,name').eq('restaurant_id',RID),
    ]);
    const nameBySlug = Object.fromEntries(((chR&&chR.data)||[]).map(c=>[c.slug,c.name]));
    const map = {};
    (((doR&&doR.data))||[]).filter(o=>o.rider_status!=='cancelled').forEach(o=>{
      const slug=o.channel||'propio', bruto=o.order_total||0, com=Math.round(bruto*(o.channel_commission||0)/100);
      if(!map[slug]) map[slug]={canal:nameBySlug[slug]||slug,pedidos:0,bruto:0,comision:0};
      map[slug].pedidos++; map[slug].bruto+=bruto; map[slug].comision+=com;
    });
    setDelivRows(Object.values(map).map(r=>({...r,neto:r.bruto-r.comision})).sort((a,b)=>b.bruto-a.bruto));
  }
  React.useEffect(()=>{ loadDelivByChannel(); },[period]);

  async function loadEgresos() {
    if(!db){setEgresos(LS.get(EGRESOS_KEY,[]));return;}
    setLoadingEg(true);
    const{data,error}=await db.from('expenses').select('*').eq('restaurant_id',RID).order('date',{ascending:false}).order('created_at',{ascending:false});
    if(error) {
      // Fallback a localStorage si la tabla no existe aún
      setEgresos(LS.get(EGRESOS_KEY,[]));
    } else {
      setEgresos((data||[]).map(e=>({...e,desc:e.description})));
    }
    setLoadingEg(false);
  }

  useEffect(()=>{ loadEgresos(); },[]);

  async function loadAlertas() {
    if(!db) return;
    setLoadingAlertas(true);
    const [oR,tR] = await Promise.all([
      db.from('orders').select('id,order_number,total,status,created_at').eq('restaurant_id',RID).eq('status','paid').or('total.is.null,total.eq.0'),
      db.from('turnos_caja').select('id,cajero_nombre,fecha_apertura,diferencia,estado').eq('restaurant_id',RID).eq('estado','abierto').lt('fecha_apertura',new Date(Date.now()-12*3600000).toISOString()),
    ]);
    const diffs = await db.from('turnos_caja').select('id,cajero_nombre,fecha_apertura,diferencia').eq('restaurant_id',RID).eq('estado','cerrado').not('diferencia','is',null).gt('diferencia',50000);
    setAlertas({
      ordenesSinMonto: oR.data||[],
      turnosSinCierre: tR.data||[],
      diferencias: diffs.data||[],
    });
    setLoadingAlertas(false);
  }
  React.useEffect(()=>{ if(finTab==='alertas') loadAlertas(); },[finTab]);

  const valid = o => !['draft','cancelled'].includes(o.status);
  function periodStart(p, asString=false) {
    const d=new Date();
    if(p==='hoy'){d.setHours(0,0,0,0);}
    else if(p==='semana'){d.setDate(d.getDate()-6);d.setHours(0,0,0,0);}
    else{d.setDate(1);d.setHours(0,0,0,0);}
    return asString ? d.toISOString().slice(0,10) : d;
  }
  const start=periodStart(period);
  const periodOrders=orders.filter(o=>valid(o)&&new Date(o.created_at)>=start);
  const ingresos=periodOrders.reduce((s,o)=>s+(o.total||0),0);
  const llevarOrders=periodOrders.filter(o=>o.order_type==='llevar');
  const llevarTotal=llevarOrders.reduce((s,o)=>s+(o.total||0),0);
  const comision=Math.round(llevarTotal*(delivPct/100));

  const egPeriod=egresos.filter(e=>(e.date||'')>=periodStart(period, true));
  const egresoTotal=egPeriod.reduce((s,e)=>s+(e.amount||0),0);
  const margen=ingresos-egresoTotal-comision;
  const margenPct=ingresos>0?Math.round(margen/ingresos*100):0;

  async function addEgreso() {
    if(!egForm.desc||!egForm.amount){toast('Completá descripción y monto',false);return;}
    setSavingEg(true);
    if(db) {
      const{error}=await db.from('expenses').insert({
        restaurant_id:RID, date:egForm.date, description:egForm.desc,
        amount:parseInt(egForm.amount), category:egForm.category,
      });
      if(error) {
        // Fallback localStorage
        const item={id:Date.now().toString(),date:egForm.date,desc:egForm.desc,description:egForm.desc,amount:parseInt(egForm.amount),category:egForm.category};
        const u=[item,...egresos];setEgresos(u);LS.set(EGRESOS_KEY,u);
        toast('Egreso guardado localmente (ejecutá migración 023 para usar Supabase)');
      } else {
        toast('Egreso registrado en Supabase');
        await loadEgresos();
      }
    } else {
      const item={id:Date.now().toString(),date:egForm.date,desc:egForm.desc,description:egForm.desc,amount:parseInt(egForm.amount),category:egForm.category};
      const u=[item,...egresos];setEgresos(u);LS.set(EGRESOS_KEY,u);
      toast('Egreso guardado');
    }
    setSavingEg(false);
    setShowEgForm(false);
    setEgForm({date:new Date().toISOString().slice(0,10),desc:'',amount:'',category:'Insumos'});
  }

  async function delEgreso(eg) {
    if(!confirm('¿Eliminar este egreso?'))return;
    if(db && eg.restaurant_id) {
      await db.from('expenses').delete().eq('id',eg.id);
      await loadEgresos();
    } else {
      const u=egresos.filter(e=>e.id!==eg.id);setEgresos(u);LS.set(EGRESOS_KEY,u);
    }
    toast('Eliminado');
  }

  const egByCat=EG_CATS.map(cat=>({cat,total:egPeriod.filter(e=>e.category===cat).reduce((s,e)=>s+e.amount,0)})).filter(x=>x.total>0).sort((a,b)=>b.total-a.total);
  const maxCat=egByCat[0]?.total||1;

  // Exportar resumen mensual a Excel
  function exportContador() {
    if(!window.XLSX){toast('SheetJS no cargado',false);return;}
    const [yr,mo]=exportMes.split('-').map(Number);
    const start=new Date(yr,mo-1,1);const end=new Date(yr,mo,0,23,59,59);
    const mesOrds=orders.filter(o=>!['draft','cancelled'].includes(o.status)&&new Date(o.created_at)>=start&&new Date(o.created_at)<=end);
    const mesEgs=egresos.filter(e=>(e.date||'').startsWith(exportMes));
    const wb=XLSX.utils.book_new();
    // Hoja Ingresos
    const ingRows=[['Orden','Fecha','Tipo','Monto','Método'],...mesOrds.map(o=>[o.order_number||'',fmtDate(o.created_at),o.order_type||'',o.total||0,o.payment_method||''])];
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(ingRows),'Ingresos');
    // Hoja Egresos
    const egRows=[['Fecha','Descripción','Categoría','Monto'],...mesEgs.map(e=>[e.date,e.desc||e.description||'',e.category||'',e.amount||0])];
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(egRows),'Egresos');
    // Hoja Resumen
    const totIng=mesOrds.reduce((s,o)=>s+(o.total||0),0);
    const totEg=mesEgs.reduce((s,e)=>s+(e.amount||0),0);
    const res=[['Métrica','Valor'],['Total ingresos',totIng],['Total egresos',totEg],['Neto estimado',totIng-totEg],['Pedidos',mesOrds.length]];
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(res),'Resumen');
    XLSX.writeFile(wb,`finanzas_${exportMes}.xlsx`);
    toast('Excel generado');
  }

  function exportPDF() {
    window.print();
  }

  // Movimientos (todos los egresos + sintesis de orders)
  const allMovs = useMemo(()=>{
    const egs = egresos.map(e=>({date:e.date,tipo:'egreso',concepto:e.desc||e.description||'',monto:e.amount||0,cat:e.category||''}));
    return egs.sort((a,b)=>b.date.localeCompare(a.date));
  },[egresos]);

  const filteredMovs = useMemo(()=>{
    let res=[...allMovs];
    if(movFilter==='ingresos') res=[];
    if(movFilter==='egresos') res=allMovs;
    if(movSearch.trim()) res=res.filter(m=>m.concepto.toLowerCase().includes(movSearch.toLowerCase()));
    return res;
  },[allMovs,movFilter,movSearch]);

  return (
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
        <h1 style={{fontSize:22,fontWeight:800,color:C.ink}}>Finanzas</h1>
      </div>

      {/* Sub-tabs */}
      <div style={{display:'flex',gap:0,borderBottom:`1px solid ${C.border}`,marginBottom:18}}>
        {[['resumen','Resumen del mes'],['movimientos','Movimientos'],['comprobantes','Comprobantes'],['diseno','Diseño del comprobante'],['impresora','Impresora'],['alertas','Alertas contables'],['exportar','Exportar para contador']].map(([id,lbl])=>(
          <button key={id} onClick={()=>setFinTab(id)} style={{background:'none',border:'none',color:finTab===id?C.ink:C.dim,padding:'8px 16px',fontSize:13,fontWeight:finTab===id?700:400,borderBottom:finTab===id?'2px solid '+C.ink:'2px solid transparent',cursor:'pointer',marginBottom:-1}}>{lbl}</button>
        ))}
      </div>

      {/* ── TAB RESUMEN ── */}
      {finTab==='resumen'&&(<>
        <div style={{display:'flex',gap:6,marginBottom:14}}>
          {['hoy','semana','mes'].map(p=>(
            <button key={p} onClick={()=>setPeriod(p)} style={{background:period===p?C.ink:'transparent',border:`1px solid ${period===p?C.ink:C.border}`,color:period===p?C.sidebar:C.mid,padding:'6px 14px',fontSize:12,fontWeight:period===p?700:400,borderRadius:6,cursor:'pointer',textTransform:'capitalize'}}>{p}</button>
          ))}
        </div>
        <div style={{display:'flex',gap:10,marginBottom:14,flexWrap:'wrap'}}>
          <KpiCard label={`Ingresos (${period})`} value={fmt(ingresos)} sub={`${periodOrders.length} pedidos`} accent={C.green}/>
          <KpiCard label={`Egresos (${period})`}  value={fmt(egresoTotal)} sub={`${egPeriod.length} registros`} accent={C.red}/>
          <KpiCard label="Margen estimado"         value={fmt(margen)} sub={`${margenPct}% del ingreso`} accent={margenPct>=30?C.green:margenPct>=10?C.yellow:C.red}/>
          <KpiCard label="Ventas para llevar"      value={fmt(llevarTotal)} sub={`${llevarOrders.length} pedidos llevar`}/>
          <KpiCard label="Comisión s/ llevar"      value={fmt(comision)} sub={`${delivPct}% s/ para llevar`} accent={C.orange}/>
        </div>

        {/* Config comisión delivery */}
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'12px 16px',marginBottom:14,display:'flex',alignItems:'center',gap:14}}>
          <div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:1}}>COMISION DELIVERY %</div>
          <input type="number" value={delivPct} onChange={e=>{const v=parseInt(e.target.value)||0;setDelivPct(v);LS.set(DELIV_KEY,v);}} min={0} max={50} style={{width:70,padding:'6px 9px',fontSize:14,fontFamily:"'SF Mono',ui-monospace,monospace",textAlign:'right',border:`1px solid ${C.border}`,borderRadius:6}}/>
          <span style={{fontSize:12,color:C.mid}}>% sobre total pedidos para llevar</span>
        </div>

        {/* Delivery por canal (Parte 4) — bruto/comisión/neto congelados por pedido · oculto si el plan no tiene delivery (L6) */}
        {showDelivery && (
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden',marginBottom:14}}>
          <div style={{padding:'12px 16px',borderBottom:`1px solid ${C.border}`,fontSize:11,color:C.mid,fontWeight:700,letterSpacing:1}}>DELIVERY POR CANAL · {period.toUpperCase()}</div>
          {delivRows.length===0
            ? <div style={{padding:20,textAlign:'center',color:C.dim,fontSize:13}}>Sin pedidos de delivery en el período</div>
            : <table style={{width:'100%',borderCollapse:'collapse'}}>
                <thead><tr style={{borderBottom:`1px solid ${C.border}`,background:'var(--bg-subtle)'}}><Th>Canal</Th><Th right>Pedidos</Th><Th right>Bruto</Th><Th right>Comisión</Th><Th right>Neto</Th></tr></thead>
                <tbody>
                  {delivRows.map(r=>(
                    <tr key={r.canal} style={{borderBottom:`1px solid ${C.border}`}}>
                      <Td>{r.canal}</Td>
                      <Td right mono>{r.pedidos}</Td>
                      <Td right mono>{fmt(r.bruto)}</Td>
                      <Td right mono>{r.comision>0?<span style={{color:C.red}}>-{fmt(r.comision)}</span>:fmt(0)}</Td>
                      <Td right mono>{fmt(r.neto)}</Td>
                    </tr>
                  ))}
                  {delivRows.length>1&&(
                    <tr style={{borderTop:`2px solid ${C.border}`}}>
                      <Td><strong>Total</strong></Td>
                      <Td right mono><strong>{delivRows.reduce((s,r)=>s+r.pedidos,0)}</strong></Td>
                      <Td right mono><strong>{fmt(delivRows.reduce((s,r)=>s+r.bruto,0))}</strong></Td>
                      <Td right mono><span style={{color:C.red}}><strong>-{fmt(delivRows.reduce((s,r)=>s+r.comision,0))}</strong></span></Td>
                      <Td right mono><strong>{fmt(delivRows.reduce((s,r)=>s+r.neto,0))}</strong></Td>
                    </tr>
                  )}
                </tbody>
              </table>
          }
        </div>
        )}

        <div style={{display:'grid',gridTemplateColumns:'1fr 320px',gap:14}}>
          {/* Egresos */}
          <div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:1}}>EGRESOS REGISTRADOS</div>
              <Btn small onClick={()=>setShowEgForm(!showEgForm)}>+ Agregar</Btn>
            </div>
            {showEgForm&&(
              <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:16,marginBottom:10}}>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
                  <div><Lbl>FECHA</Lbl><Inp type="date" value={egForm.date} onChange={e=>setEgForm({...egForm,date:e.target.value})}/></div>
                  <div><Lbl>MONTO (₲) *</Lbl><MoneyInp value={egForm.amount} onChange={v=>setEgForm({...egForm,amount:v})} placeholder="50000"/></div>
                  <div><Lbl>CATEGORIA</Lbl><Sel value={egForm.category} onChange={e=>setEgForm({...egForm,category:e.target.value})}>{EG_CATS.map(c=><option key={c}>{c}</option>)}</Sel></div>
                  <div><Lbl>DESCRIPCION *</Lbl><Inp value={egForm.desc} onChange={e=>setEgForm({...egForm,desc:e.target.value})} placeholder="Descripcion…"/></div>
                </div>
                <div style={{display:'flex',gap:8}}><Btn small onClick={addEgreso} disabled={savingEg}>{savingEg?'Guardando…':'Guardar egreso'}</Btn><Btn small variant="ghost" onClick={()=>setShowEgForm(false)}>Cancelar</Btn></div>
              </div>
            )}
            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
              <table style={{width:'100%',borderCollapse:'collapse'}}>
                <thead><tr style={{borderBottom:`1px solid ${C.border}`}}><Th>Fecha</Th><Th>Descripcion</Th><Th>Cat.</Th><Th right>Monto</Th><Th/></tr></thead>
                <tbody>
                  {egPeriod.map(e=>(
                    <tr key={e.id} style={{borderBottom:`1px solid ${C.border}`}}>
                      <Td mono dim>{e.date}</Td>
                      <Td>{e.desc||e.description}</Td>
                      <Td dim>{e.category}</Td>
                      <Td mono right style={{color:C.red}}>{fmt(e.amount)}</Td>
                      <Td><button onClick={()=>delEgreso(e)} style={{background:'none',border:'none',color:C.dim,cursor:'pointer',fontSize:14}}>✕</button></Td>
                    </tr>
                  ))}
                  {egPeriod.length===0&&<EmptyRow cols={5} label="Sin egresos este periodo"/>}
                </tbody>
              </table>
            </div>
          </div>
          {/* Distribución por categoría */}
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:18}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:14}}>EGRESOS POR CATEGORIA</div>
            {egByCat.length===0&&<div style={{color:C.dim,fontSize:12}}>Sin egresos este periodo</div>}
            {egByCat.map(({cat,total})=>(
              <div key={cat} style={{marginBottom:12}}>
                <div style={{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:4}}>
                  <span style={{color:C.mid}}>{cat}</span>
                  <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",color:C.red}}>{fmt(total)}</span>
                </div>
                <div style={{height:4,background:C.border,borderRadius:2,overflow:'hidden'}}>
                  <div style={{width:`${(total/maxCat)*100}%`,height:'100%',background:C.red,borderRadius:2}}/>
                </div>
              </div>
            ))}
            {egByCat.length>0&&(
              <div style={{borderTop:`1px solid ${C.border}`,paddingTop:12,marginTop:4,display:'flex',justifyContent:'space-between',fontSize:13,fontWeight:700}}>
                <span>Total</span><span style={{fontFamily:"'SF Mono',ui-monospace,monospace",color:C.red}}>{fmt(egresoTotal)}</span>
              </div>
            )}
          </div>
        </div>
      </>)}

      {/* ── TAB MOVIMIENTOS ── */}
      {finTab==='movimientos'&&(
        <div>
          <div style={{fontSize:12,color:C.mid,marginBottom:12}}>Historial de egresos registrados. Los ingresos se ven en el módulo de Pedidos con detalle de órdenes.</div>
          <div style={{display:'flex',gap:8,marginBottom:14,alignItems:'center'}}>
            <div style={{display:'flex',gap:0,border:`1px solid ${C.border}`,borderRadius:6,overflow:'hidden'}}>
              {[['todos','Todos'],['egresos','Egresos']].map(([id,lbl])=>(
                <button key={id} onClick={()=>setMovFilter(id)} style={{padding:'5px 12px',fontSize:12,fontWeight:movFilter===id?700:400,background:movFilter===id?C.ink:C.white,color:movFilter===id?C.sidebar:C.dim,border:'none',cursor:'pointer'}}>
                  {lbl}
                </button>
              ))}
            </div>
            <input value={movSearch} onChange={e=>setMovSearch(e.target.value)} placeholder="Buscar concepto…" style={{padding:'5px 9px',fontSize:12,borderRadius:6,border:`1px solid ${C.border}`,width:180}}/>
          </div>
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
            <table style={{width:'100%',borderCollapse:'collapse'}}>
              <thead><tr style={{borderBottom:`1px solid ${C.border}`}}><Th>Fecha</Th><Th>Tipo</Th><Th>Concepto</Th><Th>Categoria</Th><Th right>Monto</Th></tr></thead>
              <tbody>
                {filteredMovs.map((m,i)=>(
                  <tr key={i} style={{borderBottom:`1px solid ${C.border}`}}>
                    <Td mono dim>{m.date}</Td>
                    <Td><span style={{background:'rgba(239,68,68,0.1)',border:'1px solid rgba(239,68,68,0.2)',color:'#C0190F',padding:'2px 7px',fontSize:10,fontWeight:700,borderRadius:4}}>EGRESO</span></Td>
                    <Td>{m.concepto}</Td>
                    <Td dim>{m.cat}</Td>
                    <Td mono right style={{color:C.red}}>{fmt(m.monto)}</Td>
                  </tr>
                ))}
                {filteredMovs.length===0&&<EmptyRow cols={5} label="Sin movimientos"/>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── TAB ALERTAS CONTABLES ── */}
      {finTab==='alertas'&&(
        <div>
          <div style={{fontSize:12,color:C.mid,marginBottom:14}}>Verificaciones automáticas del sistema. Revisalas antes de cerrar el mes.</div>
          {loadingAlertas&&<div style={{color:C.dim,padding:20}}><span className="spin"/> Verificando…</div>}
          {!loadingAlertas&&(
            <div style={{display:'flex',flexDirection:'column',gap:14}}>
              {/* Órdenes sin monto */}
              <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
                <div style={{padding:'10px 16px',borderBottom:`1px solid ${C.border}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div style={{fontSize:13,fontWeight:700}}>Ordenes sin monto registrado</div>
                  <span style={{background:alertas.ordenesSinMonto?.length>0?TINT.redBg:TINT.greenBg,color:alertas.ordenesSinMonto?.length>0?TINT.redText:TINT.greenText,padding:'2px 8px',fontSize:11,fontWeight:700,borderRadius:4}}>{alertas.ordenesSinMonto?.length||0}</span>
                </div>
                {alertas.ordenesSinMonto?.length>0
                  ?<table style={{width:'100%',borderCollapse:'collapse'}}>
                    <thead><tr><Th>#Orden</Th><Th>Fecha</Th><Th right>Total</Th></tr></thead>
                    <tbody>{alertas.ordenesSinMonto.map(o=><tr key={o.id} style={{borderBottom:`1px solid ${C.border}`}}><Td mono dim>{o.order_number}</Td><Td dim>{fmtDate(o.created_at)}</Td><Td mono right style={{color:C.red}}>{fmt(o.total)}</Td></tr>)}</tbody>
                  </table>
                  :<div style={{padding:'12px 16px',fontSize:12,color:C.dim}}>Sin alertas</div>}
              </div>
              {/* Turnos sin cierre */}
              <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
                <div style={{padding:'10px 16px',borderBottom:`1px solid ${C.border}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div style={{fontSize:13,fontWeight:700}}>Turnos de caja sin cierre (+12h)</div>
                  <span style={{background:alertas.turnosSinCierre?.length>0?TINT.redBg:TINT.greenBg,color:alertas.turnosSinCierre?.length>0?TINT.redText:TINT.greenText,padding:'2px 8px',fontSize:11,fontWeight:700,borderRadius:4}}>{alertas.turnosSinCierre?.length||0}</span>
                </div>
                {alertas.turnosSinCierre?.length>0
                  ?<table style={{width:'100%',borderCollapse:'collapse'}}><thead><tr><Th>Cajero</Th><Th>Apertura</Th></tr></thead><tbody>{alertas.turnosSinCierre.map(t=><tr key={t.id} style={{borderBottom:`1px solid ${C.border}`}}><Td>{t.cajero_nombre||'—'}</Td><Td mono dim>{fmtDT(t.fecha_apertura)}</Td></tr>)}</tbody></table>
                  :<div style={{padding:'12px 16px',fontSize:12,color:C.dim}}>Sin alertas</div>}
              </div>
              {/* Diferencias de caja */}
              <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
                <div style={{padding:'10px 16px',borderBottom:`1px solid ${C.border}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div style={{fontSize:13,fontWeight:700}}>Diferencias de caja &gt; ₲ 50.000</div>
                  <span style={{background:alertas.diferencias?.length>0?TINT.amberBg:TINT.greenBg,color:alertas.diferencias?.length>0?TINT.amberText:TINT.greenText,padding:'2px 8px',fontSize:11,fontWeight:700,borderRadius:4}}>{alertas.diferencias?.length||0}</span>
                </div>
                {alertas.diferencias?.length>0
                  ?<table style={{width:'100%',borderCollapse:'collapse'}}><thead><tr><Th>Cajero</Th><Th>Apertura</Th><Th right>Diferencia</Th></tr></thead><tbody>{alertas.diferencias.map(t=><tr key={t.id} style={{borderBottom:`1px solid ${C.border}`}}><Td>{t.cajero_nombre||'—'}</Td><Td mono dim>{fmtDate(t.fecha_apertura)}</Td><Td mono right style={{color:C.orange}}>{fmt(t.diferencia)}</Td></tr>)}</tbody></table>
                  :<div style={{padding:'12px 16px',fontSize:12,color:C.dim}}>Sin alertas</div>}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── TAB EXPORTAR ── */}
      {finTab==='exportar'&&(
        <div style={{maxWidth:600}}>
          <div style={{fontSize:12,color:C.mid,marginBottom:20}}>Generá archivos para enviar a tu contador. Seleccioná el mes y elegí el formato.</div>
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:24,display:'flex',flexDirection:'column',gap:20}}>
            <div style={{display:'flex',alignItems:'center',gap:12}}>
              <Lbl>MES A EXPORTAR</Lbl>
              <input type="month" value={exportMes} onChange={e=>setExportMes(e.target.value)} style={{padding:'7px 10px',fontSize:13,border:`1px solid ${C.border}`,borderRadius:6}}/>
            </div>
            <div style={{display:'flex',gap:10}}>
              <Btn onClick={exportContador} style={{flex:1}}>Generar Excel completo</Btn>
              <Btn variant="secondary" onClick={exportPDF} style={{flex:1}}>Generar PDF (imprimir)</Btn>
            </div>
            <div style={{fontSize:11,color:C.dim,lineHeight:1.5}}>El Excel incluye hojas: Ingresos, Egresos, Resumen. El PDF usa la impresión del navegador — usá "Guardar como PDF" en el diálogo de impresión.</div>
          </div>
        </div>
      )}

      {/* ── TAB COMPROBANTES (ex módulo Facturas) ── */}
      {finTab==='comprobantes'&&<FacturasAdminPage/>}

      {/* ── TAB DISEÑO DEL COMPROBANTE ── */}
      {finTab==='diseno'&&<ComprobanteDesign restaurant={restaurant} onRefresh={onRefresh}/>}

      {/* ── TAB IMPRESORA ── */}
      {finTab==='impresora'&&<ImpresoraConfig restaurant={restaurant}/>}
    </div>
  );
}

/* ══════════════════════════════════════════════
   MARKETING
══════════════════════════════════════════════ */
function MarketingPage({coupons,orders,restaurant,onRefresh}) {
  const [tab,setTab] = useState('cupones');
  const [form,setForm] = useState({code:'',discount_type:'percentage',discount_value:'',min_order_amount:'',max_uses:''});
  const [saving,setSaving] = useState(false);
  const [tplId,setTplId] = useState('promo');
  const [tplVars,setTplVars] = useState({nombre:'',descuento:'10',codigo:'',fecha:'',mesa:''});
  const [copied,setCopied] = useState(false);

  const rname = restaurant?.name || window.SUPABASE_CONFIG?.restaurantName || 'nuestro local';
  const TPLS = [
    {id:'promo',label:'Promoción',msg:`Hola {nombre}! 👋 Tenemos una promo especial para vos: {descuento}% OFF usando el código *{codigo}*. Válido hasta el {fecha}. ¡Te esperamos en ${rname}! 🍽`},
    {id:'inactive',label:'Cliente inactivo',msg:`Hola {nombre}! Hace tiempo que no te vemos 😊. Tenemos novedades en el menú. Pasate por ${rname} o pedí escaneando el QR de tu mesa. ¡Te esperamos!`},
    {id:'birthday',label:'Cumpleaños',msg:`Hola {nombre}! 🎂 El equipo de ${rname} te desea un feliz cumpleaños. Como regalo tenés {descuento}% OFF con el código *{codigo}*. ¡Celebrá con nosotros!`},
  ];
  const tpl=TPLS.find(t=>t.id===tplId);
  const preview=tpl?tpl.msg.replace(/\{(\w+)\}/g,(_,k)=>tplVars[k]||`{${k}}`):'' ;

  function copyMsg(){navigator.clipboard?.writeText(preview);setCopied(true);setTimeout(()=>setCopied(false),2000);}

  const now=Date.now();
  const inactivos=useMemo(()=>{
    const m={};
    orders.filter(o=>!['draft','cancelled'].includes(o.status)&&o.customer_name).forEach(o=>{
      const k=o.customer_name;
      if(!m[k]||o.created_at>m[k].last)m[k]={name:k,phone:o.customer_phone||null,last:o.created_at};
    });
    const cutoff=new Date(Date.now()-30*864e5).toISOString();
    return Object.values(m).filter(c=>c.last<cutoff).sort((a,b)=>a.last<b.last?-1:1);
  },[orders]);

  async function addCoupon(){
    if(!db||!form.code||!form.discount_value){toast('Completá código y valor',false);return;}
    setSaving(true);
    const{data,error}=await db.from('coupons').insert({restaurant_id:RID,code:form.code.toUpperCase().trim(),discount_type:form.discount_type,discount_value:parseInt(form.discount_value),min_order_amount:parseInt(form.min_order_amount)||0,max_uses:form.max_uses?parseInt(form.max_uses):null,is_active:true}).select('id');
    if(error){toast('Error: '+error.message,false);}
    else if(!data||data.length===0){toast('No se pudo crear el cupón — verificá RLS en Supabase',false);}
    else{toast('Cupón creado');setForm({code:'',discount_type:'percentage',discount_value:'',min_order_amount:'',max_uses:''});onRefresh();}
    setSaving(false);
  }
  async function toggleCoupon(id,current){
    const{data,error}=await db.from('coupons').update({is_active:!current}).eq('id',id).select('id');
    if(error){toast('Error: '+error.message,false);}
    else if(!data||data.length===0){toast('No se pudo actualizar el cupón — verificá RLS en Supabase',false);}
    else{toast(current?'Cupón desactivado':'Cupón activado');onRefresh();}
  }

  return (
    <div className="page">
      <h1 style={{fontSize:22,fontWeight:800,color:C.ink,marginBottom:16}}>Marketing</h1>
      <div style={{display:'flex',gap:0,borderBottom:`1px solid ${C.border}`,marginBottom:16}}>
        {[['cupones','Cupones'],['whatsapp','WhatsApp'],['inactivos','Clientes inactivos']].map(([id,lbl])=>(
          <button key={id} onClick={()=>setTab(id)} style={{background:'none',border:'none',color:tab===id?C.ink:C.dim,padding:'8px 14px',fontSize:12,fontWeight:tab===id?700:400,borderBottom:tab===id?'2px solid '+C.ink:'2px solid transparent',cursor:'pointer',marginBottom:-1}}>{lbl}</button>
        ))}
      </div>

      {tab==='cupones'&&(
        <div>
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:18,marginBottom:14}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:12}}>NUEVO CUPÓN / DESCUENTO</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(140px,1fr))',gap:10,marginBottom:12}}>
              <div><Lbl>CÓDIGO *</Lbl><Inp value={form.code} onChange={e=>setForm({...form,code:e.target.value.toUpperCase()})} placeholder="PROMO20"/></div>
              <div><Lbl>TIPO</Lbl><Sel value={form.discount_type} onChange={e=>setForm({...form,discount_type:e.target.value})}><option value="percentage">% Porcentaje</option><option value="fixed">₲ Fijo</option></Sel></div>
              <div><Lbl>VALOR *</Lbl>
                {form.discount_type==='percentage'
                  ? <Inp type="number" mono value={form.discount_value} onChange={e=>setForm({...form,discount_value:e.target.value})} placeholder="10"/>
                  : <MoneyInp value={form.discount_value} onChange={v=>setForm({...form,discount_value:v})} placeholder="5000"/>
                }
              </div>
              <div><Lbl>MONTO MÍN. (₲)</Lbl><MoneyInp value={form.min_order_amount} onChange={v=>setForm({...form,min_order_amount:v})} placeholder="0"/></div>
              <div><Lbl>USOS MÁX.</Lbl><NumInp value={form.max_uses} onChange={v=>setForm({...form,max_uses:v})} placeholder="∞"/></div>
            </div>
            <Btn onClick={addCoupon} disabled={saving||!form.code||!form.discount_value}>{saving?'Creando…':'Crear cupón'}</Btn>
          </div>
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
            <table style={{width:'100%',borderCollapse:'collapse'}}>
              <thead><tr style={{borderBottom:`1px solid ${C.border}`}}><Th>Código</Th><Th>Descuento</Th><Th>Tipo</Th><Th>Mín.</Th><Th>Usos</Th><Th>Estado</Th></tr></thead>
              <tbody>
                {coupons.map(c=>(
                  <tr key={c.id} style={{borderBottom:`1px solid #0d0d0d`}}>
                    <Td><span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:700}}>{c.code}</span></Td>
                    <Td><span style={{fontFamily:"'SF Mono',ui-monospace,monospace",color:C.green,fontWeight:700}}>{c.discount_type==='percentage'?`${c.discount_value}%`:fmt(c.discount_value)}</span></Td>
                    <Td dim>{c.discount_type==='percentage'?'Porcentaje':'Fijo'}</Td>
                    <Td mono dim>{c.min_order_amount>0?fmt(c.min_order_amount):'—'}</Td>
                    <Td mono>{c.used_count||0}/{c.max_uses||'∞'}</Td>
                    <Td><button onClick={()=>toggleCoupon(c.id,c.is_active)} style={{background:c.is_active?'rgba(34,197,94,0.1)':'rgba(255,255,255,0.04)',border:`1px solid ${c.is_active?'rgba(34,197,94,0.3)':C.border}`,color:c.is_active?C.green:'#86868B',padding:'3px 9px',fontSize:11,fontWeight:600,borderRadius:5}}>{c.is_active?'Activo':'Inactivo'}</button></Td>
                  </tr>
                ))}
                {coupons.length===0&&<EmptyRow cols={6} label="Sin cupones"/>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab==='whatsapp'&&(
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
          <div>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:10}}>PLANTILLA</div>
            <div style={{display:'flex',flexDirection:'column',gap:8,marginBottom:14}}>
              {TPLS.map(t=>(
                <button key={t.id} onClick={()=>setTplId(t.id)} style={{textAlign:'left',padding:'10px 14px',background:tplId===t.id?'rgba(255,255,255,0.08)':'var(--bg-subtle)',border:`1px solid ${tplId===t.id?C.bs:C.border}`,borderRadius:8,cursor:'pointer',color:tplId===t.id?C.white:C.mid,fontSize:13,fontWeight:tplId===t.id?600:400}}>
                  {t.label}
                </button>
              ))}
            </div>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:10}}>VARIABLES</div>
            {['nombre','descuento','codigo','fecha'].map(k=>(
              <div key={k} style={{marginBottom:8}}><Lbl>{k.toUpperCase()}</Lbl><Inp value={tplVars[k]||''} onChange={e=>setTplVars({...tplVars,[k]:e.target.value})} placeholder={k}/></div>
            ))}
          </div>
          <div>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:10}}>PREVIEW</div>
            <div style={{background:'#0a1a12',border:'1px solid rgba(34,197,94,0.2)',borderRadius:12,padding:18,fontSize:14,lineHeight:1.6,color:'#d1fae5',minHeight:180,fontFamily:'inherit',whiteSpace:'pre-wrap',marginBottom:12}}>
              {preview}
            </div>
            <Btn onClick={copyMsg} variant={copied?'primary':'secondary'}>{copied?'✓ Copiado!':'Copiar mensaje'}</Btn>
            <div style={{fontSize:11,color:C.dim,marginTop:8}}>Pegá el mensaje en WhatsApp Web o WhatsApp Desktop manualmente.</div>
          </div>
        </div>
      )}

      {tab==='inactivos'&&(
        <div>
          <div style={{fontSize:12,color:C.mid,marginBottom:12}}>{inactivos.length} clientes sin pedidos en los últimos 30 días</div>
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
            <table style={{width:'100%',borderCollapse:'collapse'}}>
              <thead><tr style={{borderBottom:`1px solid ${C.border}`}}><Th>Cliente</Th><Th>Teléfono</Th><Th>Último pedido</Th><Th>Días inactivo</Th></tr></thead>
              <tbody>
                {inactivos.map((c,i)=>{
                  const dias=Math.floor((now-new Date(c.last).getTime())/864e5);
                  return (
                    <tr key={i} style={{borderBottom:`1px solid #0d0d0d`}}>
                      <Td>{c.name}</Td>
                      <Td dim>{c.phone||'—'}</Td>
                      <Td dim>{fmtDate(c.last)}</Td>
                      <Td><span style={{color:dias>60?C.red:C.orange,fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:700}}>{dias}d</span></Td>
                    </tr>
                  );
                })}
                {inactivos.length===0&&<EmptyRow cols={4} label="Todos los clientes estuvieron activos recientemente"/>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════
   CALIFICACIONES — filtros por canal + mensajes de cocina
══════════════════════════════════════════════ */
function RatingsPage({ratings}) {
  const [tab,setTab]           = useState('ratings');  // 'ratings' | 'mensajes'
  const [originF,setOriginF]   = useState('all');
  const [messages,setMessages] = useState([]);
  const [loadingMsg,setLoadingMsg] = useState(false);
  const [newMsg,setNewMsg]     = useState('');
  const [savingMsg,setSavingMsg] = useState(false);
  const [frequency,setFreq]    = useState(10);

  const ORIGINS = {
    all:'Todos',
    qr_mesa:'QR Mesa',
    delivery:'Delivery',
    pickup:'Para Llevar',
    counter:'Mostrador',
    unknown:'Sin origen',
  };

  const filtered = originF==='all' ? ratings : ratings.filter(r=>(r.origin||'unknown')===originF);
  const avg = filtered.length ? (filtered.reduce((s,r)=>s+r.stars,0)/filtered.length).toFixed(1) : '0.0';
  const dist = [5,4,3,2,1].map(s=>({s,n:filtered.filter(r=>r.stars===s).length}));

  // KPIs por canal
  const kpiByChannel = Object.entries(ORIGINS).filter(([k])=>k!=='all').map(([k,label])=>{
    const rts = ratings.filter(r=>(r.origin||'unknown')===k);
    return {k,label,count:rts.length,avg:rts.length?(rts.reduce((s,r)=>s+r.stars,0)/rts.length).toFixed(1):'—'};
  }).filter(x=>x.count>0);

  async function loadMessages() {
    if(!db) return;
    setLoadingMsg(true);
    const {data} = await db.from('kitchen_messages').select('*').eq('restaurant_id',RID).order('created_at');
    setMessages(data||[]);
    const {data:settings} = await db.from('restaurant_settings').select('kitchen_message_frequency').eq('restaurant_id',RID).maybeSingle();
    if(settings?.kitchen_message_frequency) setFreq(settings.kitchen_message_frequency);
    setLoadingMsg(false);
  }

  React.useEffect(()=>{ if(tab==='mensajes') loadMessages(); },[tab]);

  async function saveMessage() {
    if(!newMsg.trim()||!db){toast('Escribí un mensaje',false);return;}
    if(newMsg.length>80){toast('Máximo 80 caracteres',false);return;}
    setSavingMsg(true);
    const {error} = await db.from('kitchen_messages').insert({restaurant_id:RID,message:newMsg.trim(),active:true});
    if(error){toast('Error: '+error.message,false);}
    else{toast('Mensaje guardado');setNewMsg('');loadMessages();}
    setSavingMsg(false);
  }

  async function toggleMessage(msg) {
    if(!db) return;
    await db.from('kitchen_messages').update({active:!msg.active}).eq('id',msg.id);
    setMessages(p=>p.map(m=>m.id===msg.id?{...m,active:!m.active}:m));
  }

  async function deleteMessage(id) {
    if(!db||!confirm('¿Eliminar este mensaje?')) return;
    await db.from('kitchen_messages').delete().eq('id',id);
    setMessages(p=>p.filter(m=>m.id!==id));
    toast('Mensaje eliminado');
  }

  async function saveFrequency(val) {
    setFreq(val);
    if(db) await db.from('restaurant_settings').upsert({restaurant_id:RID,kitchen_message_frequency:val},{onConflict:'restaurant_id'});
  }

  return (
    <div className="page">
      <h1 style={{fontSize:22,fontWeight:800,color:C.ink,marginBottom:14}}>Calificaciones</h1>

      {/* Sub-tabs */}
      <div style={{display:'flex',gap:0,borderBottom:`1px solid ${C.border}`,marginBottom:16}}>
        {[['ratings','Calificaciones'],['mensajes','Mensajes de cocina']].map(([id,lbl])=>(
          <button key={id} onClick={()=>setTab(id)} style={{background:'none',border:'none',color:tab===id?C.ink:C.dim,padding:'8px 16px',fontSize:13,fontWeight:tab===id?700:400,borderBottom:tab===id?'2px solid '+C.ink:'2px solid transparent',cursor:'pointer',marginBottom:-1}}>{lbl}</button>
        ))}
      </div>

      {/* ── TAB RATINGS ── */}
      {tab==='ratings'&&(<>
        {/* KPIs por canal */}
        {kpiByChannel.length>0&&(
          <div style={{display:'flex',gap:10,marginBottom:14,flexWrap:'wrap'}}>
            {kpiByChannel.map(ch=>(
              <div key={ch.k} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'10px 14px',minWidth:120}}>
                <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:4}}>{ch.label.toUpperCase()}</div>
                <div style={{fontSize:20,fontWeight:800,color:C.yellow}}>{ch.avg} ★</div>
                <div style={{fontSize:11,color:C.dim}}>{ch.count} reseñas</div>
              </div>
            ))}
          </div>
        )}

        {/* Filtro por canal */}
        <div style={{display:'flex',gap:0,borderBottom:`1px solid ${C.border}`,marginBottom:14}}>
          {Object.entries(ORIGINS).map(([k,lbl])=>(
            <button key={k} onClick={()=>setOriginF(k)} style={{background:'none',border:'none',color:originF===k?C.ink:C.dim,padding:'6px 12px',fontSize:12,fontWeight:originF===k?700:400,borderBottom:originF===k?'2px solid '+C.ink:'2px solid transparent',cursor:'pointer',marginBottom:-1}}>{lbl}</button>
          ))}
        </div>

        <div style={{display:'flex',gap:12,marginBottom:16}}>
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'20px 26px',minWidth:160}}>
            <div style={{fontSize:42,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.yellow,lineHeight:1}}>{avg}</div>
            <div style={{fontSize:16,color:C.yellow,margin:'8px 0 4px'}}>{'★'.repeat(Math.round(Number(avg)))}</div>
            <div style={{fontSize:12,color:C.mid}}>{filtered.length} calificaciones</div>
          </div>
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'16px 20px',flex:1}}>
            {dist.map(({s,n})=>{
              const pct=filtered.length?Math.round(n/filtered.length*100):0;
              return (
                <div key={s} style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                  <span style={{color:C.yellow,fontSize:12,width:10}}>{s}</span>
                  <span style={{color:C.yellow,fontSize:10}}>★</span>
                  <div style={{flex:1,height:6,background:C.border,borderRadius:3,overflow:'hidden'}}><div style={{width:`${pct}%`,height:'100%',background:C.yellow,borderRadius:3}}/></div>
                  <span style={{fontSize:11,color:C.mid,width:24,textAlign:'right'}}>{n}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
          <table style={{width:'100%',borderCollapse:'collapse'}}>
            <thead><tr style={{borderBottom:`1px solid ${C.border}`}}><Th>Rating</Th><Th>Comentario</Th><Th>Canal</Th><Th>Fecha</Th></tr></thead>
            <tbody>
              {filtered.map(r=>(
                <tr key={r.id} style={{borderBottom:`1px solid ${C.border}`}}>
                  <Td><Stars n={r.stars}/></Td>
                  <Td style={{color:r.comment?C.ink:'#D2D2D7',fontStyle:r.comment?'normal':'italic'}}>{r.comment||'Sin comentario'}</Td>
                  <Td dim style={{fontSize:11}}>{ORIGINS[r.origin||'unknown']||r.origin||'—'}</Td>
                  <Td mono dim>{fmtDate(r.created_at)}</Td>
                </tr>
              ))}
              {filtered.length===0&&<EmptyRow cols={4} label="Sin calificaciones en este filtro"/>}
            </tbody>
          </table>
        </div>
      </>)}

      {/* ── TAB MENSAJES DE COCINA ── */}
      {tab==='mensajes'&&(
        <div>
          <div style={{fontSize:12,color:C.mid,marginBottom:14}}>Los mensajes configurados aquí aparecen en el KDS de cocina según la frecuencia elegida. Máximo 80 caracteres por mensaje.</div>

          {/* Frecuencia */}
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'12px 16px',marginBottom:14,display:'flex',alignItems:'center',gap:12}}>
            <span style={{fontSize:13,color:C.ink,fontWeight:600}}>Mostrar cada</span>
            <select value={frequency} onChange={e=>saveFrequency(parseInt(e.target.value))} style={{padding:'5px 9px',fontSize:13,borderRadius:6,border:`1px solid ${C.border}`}}>
              {[1,5,10,15,20,30,50].map(n=><option key={n} value={n}>cada {n} pedidos</option>)}
            </select>
            <span style={{fontSize:12,color:C.mid}}>pedidos completados</span>
          </div>

          {/* Nuevo mensaje */}
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'14px 16px',marginBottom:14}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:10}}>NUEVO MENSAJE</div>
            <div style={{display:'flex',gap:8,alignItems:'center'}}>
              <input value={newMsg} onChange={e=>setNewMsg(e.target.value.slice(0,80))} placeholder="Ej: Gracias al equipo por su esfuerzo!" maxLength={80} style={{flex:1,padding:'8px 10px',fontSize:13,border:`1px solid ${C.border}`,borderRadius:6}}/>
              <span style={{fontSize:11,color:C.dim,flexShrink:0}}>{newMsg.length}/80</span>
              <Btn small onClick={saveMessage} disabled={savingMsg||!newMsg.trim()}>Guardar</Btn>
            </div>
          </div>

          {/* Lista de mensajes */}
          {loadingMsg&&<div style={{color:C.dim,padding:20}}><span className="spin"/> Cargando…</div>}
          {!loadingMsg&&(
            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
              <table style={{width:'100%',borderCollapse:'collapse'}}>
                <thead><tr style={{borderBottom:`1px solid ${C.border}`}}><Th>Mensaje</Th><Th>Estado</Th><Th/></tr></thead>
                <tbody>
                  {messages.map(m=>(
                    <tr key={m.id} style={{borderBottom:`1px solid ${C.border}`}}>
                      <Td style={{color:m.active?'#1D1D1F':'#86868B'}}>{m.message}</Td>
                      <Td>
                        <button onClick={()=>toggleMessage(m)} style={{background:m.active?'rgba(52,199,89,0.1)':'transparent',border:`1px solid ${m.active?'rgba(52,199,89,0.3)':C.border}`,color:m.active?'#34C759':'#86868B',padding:'2px 9px',fontSize:11,fontWeight:600,borderRadius:5,cursor:'pointer'}}>
                          {m.active?'Activo':'Inactivo'}
                        </button>
                      </Td>
                      <Td><button onClick={()=>deleteMessage(m.id)} style={{background:'none',border:'none',color:'#FF3B30',fontSize:16,cursor:'pointer'}}>✕</button></Td>
                    </tr>
                  ))}
                  {messages.length===0&&<EmptyRow cols={3} label="Sin mensajes configurados — agregá el primero"/>}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════
   STOCK E INVENTARIO
══════════════════════════════════════════════ */
function StockPage() {
  const [tab, setTab]             = useState('inventario');
  const [ingredients, setIng]     = useState([]);
  const [menuItems, setItems]     = useState([]);
  const [recipes, setRecipes]     = useState([]);
  const [movements, setMovements] = useState([]);
  const [alerts, setAlerts]       = useState([]);
  const [loading, setLoading]     = useState(false);
  const [modal, setModal]         = useState(null);
  const [saving, setSaving]       = useState(false);
  const [autoDiscount, setAutoDiscount] = useState(false);
  const [savingToggle, setSavingToggle] = useState(false);

  /* ── Toma de inventario ───── */
  const [todaySessions, setTodaySessions]   = useState([]);
  const [tomaView, setTomaView]             = useState('list'); // 'list'|'form'|'result'
  const [tomaType, setTomaType]             = useState('apertura');
  const [tomaSessionId, setTomaSessionId]   = useState(null);
  const [tomaItems, setTomaItems]           = useState([]); // [{id,ingredient_id,name,unit,system_quantity}]
  const [tomaCounts, setTomaCounts]         = useState({}); // {ingredient_id: {counted,adjust}}
  const [tomaResult, setTomaResult]         = useState(null);
  const [tomaLoading, setTomaLoading]       = useState(false);
  const [tomaNotesForm, setTomaNotesForm]   = useState('');

  /* Cargar y guardar toggle auto_stock_discount */
  React.useEffect(()=>{
    if(!db) return;
    db.from('restaurant_settings').select('auto_stock_discount').eq('restaurant_id',RID).maybeSingle()
      .then(({data})=>{ if(data) setAutoDiscount(!!data.auto_stock_discount); });
  },[]);

  async function toggleAutoDiscount() {
    setSavingToggle(true);
    const next = !autoDiscount;
    if(db){
      const{error}=await db.from('restaurant_settings').upsert({restaurant_id:RID,auto_stock_discount:next},{onConflict:'restaurant_id'});
      if(error){toast('Error al guardar: '+error.message,false);setSavingToggle(false);return;}
    }
    setAutoDiscount(next);
    toast(next?'Descuento automático activado':'Descuento automático desactivado');
    setSavingToggle(false);
  }

  const emptyIng  = {name:'',category:'',unit:'unit',min_threshold:'',cost_per_unit:'',stock_quantity:''};
  const emptyLoad = {ingredient_id:'',quantity:'',unit:'unit',expiry_date:'',batch_id:'',cost_per_unit:'',notes:''};
  const emptyRec  = {menu_item_id:'',ingredient_id:'',quantity_required:'1',unit:'unit',notes:''};
  const [ingForm,  setIngForm]  = useState(emptyIng);
  const [loadForm, setLoadForm] = useState(emptyLoad);
  const [recForm,  setRecForm]  = useState(emptyRec);

  const UNIT_LABELS = {g:'g (gramos)',kg:'kg (kilogramos)',l:'L (litros)',ml:'ml (mililitros)',unit:'unidades enteras',portion:'porciones'};
  const UNIT_DISPLAY = {g:'g',kg:'kg',l:'L',ml:'ml',unit:'u',portion:'p'};
  // Dimensión de cada unidad: masa/volumen/conteo/porción. Para filtrar los
  // selectores a unidades compatibles con el ingrediente (evita recetas g↔ml, etc.).
  const UNIT_DIM = {g:'m',kg:'m',ml:'v',l:'v',unit:'c',portion:'p'};
  const unitOpts = (ingUnit) => {
    const d = UNIT_DIM[ingUnit];
    const entries = Object.entries(UNIT_LABELS);
    return d ? entries.filter(([v]) => UNIT_DIM[v] === d) : entries;
  };

  // El stock se guarda EN LA UNIDAD DEL INGREDIENTE (10 kg = 10). Se muestra en su
  // unidad, escalando para legibilidad (kg<1 → g, g≥1000 → kg, ídem L/ml).
  const _trimNum = (n) => {
    const r = Math.round((Number(n) || 0) * 1000) / 1000;
    return Number.isInteger(r) ? String(r) : r.toFixed(3).replace(/\.?0+$/, '');
  };
  const fmtStock = (qty, unit) => {
    const q = Number(qty) || 0;
    if (unit === 'kg') return q !== 0 && Math.abs(q) < 1 ? `${_trimNum(q * 1000)} g`  : `${_trimNum(q)} kg`;
    if (unit === 'g')  return Math.abs(q) >= 1000        ? `${_trimNum(q / 1000)} kg` : `${_trimNum(q)} g`;
    if (unit === 'l')  return q !== 0 && Math.abs(q) < 1 ? `${_trimNum(q * 1000)} ml` : `${_trimNum(q)} L`;
    if (unit === 'ml') return Math.abs(q) >= 1000        ? `${_trimNum(q / 1000)} L`  : `${_trimNum(q)} ml`;
    return `${_trimNum(q)} ${UNIT_DISPLAY[unit] || unit}`;
  };
  const stockColor = lvl => ({ok:C.green,bajo:C.yellow,critico:C.orange,sin_stock:C.red}[lvl]||C.mid);
  const stockLabel = lvl => ({ok:'OK',bajo:'Bajo',critico:'Crítico',sin_stock:'Sin stock'}[lvl]||lvl);

  const loadTodaySessions = React.useCallback(async () => {
    if(!db) return;
    const today = new Date(); today.setHours(0,0,0,0);
    const {data} = await db.from('stock_sessions')
      .select('id,session_type,status,created_at,completed_at,notes')
      .eq('restaurant_id', RID)
      .gte('created_at', today.toISOString())
      .order('created_at', {ascending:false});
    setTodaySessions(data||[]);
  }, []);

  const loadData = React.useCallback(async () => {
    if (!db) return;
    setLoading(true);
    try {
      const [ingsRes, itemsRes, recsRes, movsRes, alertsRes] = await Promise.all([
        db.rpc('admin_list_ingredients', {p_restaurant_id: RID}),
        db.from('menu_items').select('id,name,is_available,availability_reason').eq('restaurant_id',RID).order('name'),
        db.from('recipes').select('*').then(async r => {
          if (r.error) return {data:[]};
          const ingIds = (await db.from('ingredients').select('id').eq('restaurant_id',RID)).data?.map(i=>i.id)||[];
          return {data:(r.data||[]).filter(rec=>ingIds.includes(rec.ingredient_id))};
        }),
        db.from('stock_movements').select('*, ingredient:ingredients(name,unit)').eq('restaurant_id',RID).order('created_at',{ascending:false}).limit(100),
        db.from('stock_alerts').select('*, ingredient:ingredients(name,unit)').eq('restaurant_id',RID).is('resolved_at',null).order('created_at',{ascending:false}).limit(30),
      ]);
      setIng(ingsRes.data||[]);
      setItems(itemsRes.data||[]);
      setRecipes(recsRes.data||[]);
      setMovements(movsRes.data||[]);
      setAlerts(alertsRes.data||[]);
    } catch(e) { console.error(e); }
    setLoading(false);
  }, []);

  React.useEffect(()=>{ loadData(); loadTodaySessions(); },[loadData, loadTodaySessions]);

  React.useEffect(()=>{
    if (!db) return;
    const ch = db.channel('stock-admin-rt')
      .on('postgres_changes',{event:'*',schema:'public',table:'ingredients',filter:`restaurant_id=eq.${RID}`}, ()=>{ if(!_shouldPause()) loadData(); })
      .on('postgres_changes',{event:'*',schema:'public',table:'stock_alerts',filter:`restaurant_id=eq.${RID}`}, ()=>{ if(!_shouldPause()) loadData(); })
      .on('postgres_changes',{event:'*',schema:'public',table:'stock_movements',filter:`restaurant_id=eq.${RID}`}, ()=>{ if(!_shouldPause()) loadData(); })
      .subscribe();
    return ()=>{ db.removeChannel(ch); };
  }, [loadData]);

  const createIngredient = async () => {
    if (!ingForm.name.trim()) { toast('El nombre es requerido', false); return; }
    setSaving(true);
    try {
      const {error} = await db.from('ingredients').insert({
        restaurant_id: RID, name:ingForm.name.trim(), category:ingForm.category.trim()||null,
        unit:ingForm.unit, stock_quantity:parseFloat(ingForm.stock_quantity)||0,
        min_threshold:parseFloat(ingForm.min_threshold)||0,
        cost_per_unit:ingForm.cost_per_unit?parseFloat(ingForm.cost_per_unit):null,
      });
      if (error) throw error;
      toast('Ingrediente creado'); setModal(null); setIngForm(emptyIng); loadData();
    } catch(e) { toast('Error: '+e.message, false); }
    setSaving(false);
  };

  const doLoadStock = async () => {
    if (!loadForm.ingredient_id) { toast('Seleccioná un ingrediente', false); return; }
    if (!loadForm.quantity||parseFloat(loadForm.quantity)<=0) { toast('Cantidad inválida', false); return; }
    setSaving(true);
    try {
      const {error} = await db.rpc('admin_load_stock', {
        p_ingredient_id: loadForm.ingredient_id, p_quantity:parseFloat(loadForm.quantity),
        p_unit:loadForm.unit, p_expiry_date:loadForm.expiry_date||null,
        p_batch_id:loadForm.batch_id||null,
        p_cost_per_unit:loadForm.cost_per_unit?parseFloat(loadForm.cost_per_unit):null,
        p_notes:loadForm.notes||null,
      });
      if (error) throw error;
      toast('Stock cargado correctamente'); setModal(null); setLoadForm(emptyLoad); loadData();
    } catch(e) { toast('Error: '+e.message, false); }
    setSaving(false);
  };

  const createRecipe = async () => {
    if (!recForm.menu_item_id||!recForm.ingredient_id) { toast('Seleccioná ítem e ingrediente', false); return; }
    setSaving(true);
    try {
      const {error} = await db.from('recipes').insert({
        menu_item_id:parseInt(recForm.menu_item_id), ingredient_id:recForm.ingredient_id,
        quantity_required:parseFloat(recForm.quantity_required)||1, unit:recForm.unit, notes:recForm.notes||null,
      });
      if (error) throw error;
      toast('Receta guardada'); setModal(null); setRecForm(emptyRec); loadData();
    } catch(e) { toast('Error: '+e.message, false); }
    setSaving(false);
  };

  const deleteRecipe = async (id) => {
    const {error} = await db.from('recipes').delete().eq('id',id);
    if (error) { toast('Error: '+error.message, false); return; }
    toast('Receta eliminada'); loadData();
  };

  const resolveAlert = async (id) => {
    const {error} = await db.from('stock_alerts').update({resolved_at:new Date().toISOString()}).eq('id',id);
    if (!error) loadData();
  };

  /* ── Toma de inventario ─────────────────────── */
  const iniciarToma = async (tipo) => {
    if(ingredients.length===0){ toast('No hay ingredientes registrados para tomar inventario', false); return; }
    setTomaLoading(true);
    try {
      const {data, error} = await db.rpc('admin_create_stock_session',{
        p_restaurant_id: RID, p_session_type: tipo, p_notes: tomaNotesForm||null
      });
      if(error) throw error;
      const sessionId = data;
      // Cargar los items de la sesión recién creada
      const {data: items, error: e2} = await db.from('stock_session_items')
        .select('id,ingredient_id,system_quantity,ingredients(name,unit,category)')
        .eq('session_id', sessionId)
        .order('ingredients(name)');
      if(e2) throw e2;
      const mappedItems = (items||[]).map(it=>({
        id: it.id,
        ingredient_id: it.ingredient_id,
        name: it.ingredients?.name||it.ingredient_id,
        unit: it.ingredients?.unit||'unit',
        category: it.ingredients?.category||'',
        system_quantity: it.system_quantity,
      }));
      // Inicializar conteos vacíos
      const initCounts = {};
      mappedItems.forEach(it=>{ initCounts[it.ingredient_id]={counted:'',adjust:false}; });
      setTomaSessionId(sessionId);
      setTomaItems(mappedItems);
      setTomaCounts(initCounts);
      setTomaType(tipo);
      setTomaView('form');
      loadTodaySessions();
    } catch(e){ toast('Error al iniciar toma: '+e.message, false); }
    setTomaLoading(false);
  };

  const completarToma = async () => {
    setTomaLoading(true);
    try {
      // Construir array de conteos — solo los que tienen valor ingresado
      const counts = tomaItems
        .filter(it => tomaCounts[it.ingredient_id]?.counted !== '')
        .map(it => ({
          ingredient_id: it.ingredient_id,
          counted_quantity: parseFloat(tomaCounts[it.ingredient_id]?.counted)||0,
          apply_adjustment: !!tomaCounts[it.ingredient_id]?.adjust,
        }));
      // p_counts es JSONB: pasar el array directo. supabase-js ya serializa el
      // body, así que JSON.stringify lo mandaría como string escalar y el RPC
      // fallaría con "cannot extract elements from a scalar" en jsonb_array_elements.
      const {data, error} = await db.rpc('admin_complete_stock_session',{
        p_session_id: tomaSessionId, p_counts: counts
      });
      if(error) throw error;
      setTomaResult({...data, items: tomaItems, counts: tomaCounts});
      setTomaView('result');
      loadData(); loadTodaySessions();
    } catch(e){ toast('Error al completar toma: '+e.message, false); }
    setTomaLoading(false);
  };

  const ingName  = id => ingredients.find(i=>i.id===id)?.name||id;
  const itemName = id => menuItems.find(i=>i.id===parseInt(id))?.name||id;
  const mvtIcon  = t => ({load:'↑',deduct:'↓',adjustment:'≈',waste:'✕',expired:'⚠'}[t]||'•');
  const mvtColor = t => ({load:C.green,deduct:C.blue,adjustment:C.yellow,waste:C.orange,expired:C.red}[t]||C.mid);
  const alertIcon  = t => ({low_stock:'⚠',critical_stock:'●',expiring_soon:'◷',expired:'✕'}[t]||'•');
  const alertColor = t => ({low_stock:C.yellow,critical_stock:C.red,expiring_soon:C.orange,expired:C.red}[t]||C.mid);
  const alertLabel = t => ({low_stock:'Stock bajo',critical_stock:'Stock crítico',expiring_soon:'Por vencer',expired:'Vencido'}[t]||t);

  const TabBtn = ({id,label,badge}) => (
    <button onClick={()=>setTab(id)} style={{padding:'6px 14px',borderRadius:6,border:'none',fontFamily:'inherit',fontSize:12,fontWeight:600,cursor:'pointer',background:tab===id?C.white:'transparent',color:tab===id?C.ink:C.mid,transition:'all .15s',position:'relative'}}>
      {label}
      {badge&&<span style={{position:'absolute',top:2,right:2,width:7,height:7,borderRadius:4,background:C.red,display:'block'}}/>}
    </button>
  );

  /* Alertas de vencimiento: ítems que vencen en los próximos 7 días */
  const now = new Date();
  const in7d = new Date(now.getTime() + 7*86400000);
  const expiringAlerts = ingredients.filter(ing => {
    if(!ing.expiry_date) return false;
    const exp = new Date(ing.expiry_date);
    return exp <= in7d;
  }).sort((a,b)=>new Date(a.expiry_date)-new Date(b.expiry_date));

  /* ¿Falta la toma de apertura hoy? */
  const faltaApertura = ingredients.length>0 && !todaySessions.some(s=>s.session_type==='apertura'&&s.status==='completado');
  const faltaCierre   = ingredients.length>0 && todaySessions.some(s=>s.session_type==='apertura'&&s.status==='completado')
                        && !todaySessions.some(s=>s.session_type==='cierre'&&s.status==='completado');

  return (
    <div className="page">
      <h1 style={{fontSize:22,fontWeight:800,color:C.ink,marginBottom:12}}>Stock e Inventario</h1>

      {/* Banner: falta toma de apertura */}
      {faltaApertura&&tab!=='toma'&&(
        <div onClick={()=>setTab('toma')} style={{cursor:'pointer',background:TINT.amberBg,border:`1px solid ${TINT.amberBorder}`,borderRadius:8,padding:'10px 16px',marginBottom:12,display:'flex',alignItems:'center',gap:10}}>
          <span style={{display:'flex',color:TINT.amberText}}><Icon name="clipboard" size={18}/></span>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontSize:13,color:TINT.amberText}}>Toma de inventario de apertura pendiente</div>
            <div style={{fontSize:11,color:TINT.amberText,opacity:.8}}>Realizá el conteo de stock al iniciar el día. Hacé clic aquí para comenzar.</div>
          </div>
          <span style={{fontSize:12,color:TINT.amberText,fontWeight:600}}>Ir →</span>
        </div>
      )}

      {/* Toggle descuento automático — prominente */}
      <div style={{background:C.surface,border:`2px solid ${autoDiscount?'#34C759':'#D2D2D7'}`,borderRadius:10,padding:'14px 18px',marginBottom:16,display:'flex',alignItems:'center',justifyContent:'space-between',gap:16}}>
        <div>
          <div style={{fontSize:13,fontWeight:700,color:C.ink,marginBottom:3}}>Descuento automático de stock al confirmar pedidos</div>
          <div style={{fontSize:11,color:C.mid}}>
            Descuenta solo los ingredientes con receta configurada. Requiere stock cargado para descontar.
            Si está OFF, el stock no se descuenta al recibir pedidos.
          </div>
        </div>
        <button onClick={toggleAutoDiscount} disabled={savingToggle} style={{flexShrink:0,width:52,height:28,borderRadius:14,border:'none',background:autoDiscount?'#34C759':'#D2D2D7',cursor:savingToggle?'wait':'pointer',position:'relative',transition:'background .2s'}}>
          <span style={{position:'absolute',top:3,left:autoDiscount?26:3,width:22,height:22,borderRadius:11,background:C.surface,transition:'left .2s',display:'block',boxShadow:'0 1px 3px rgba(0,0,0,0.2)'}}/>
        </button>
      </div>

      {/* Tabs + refresh */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16,flexWrap:'wrap',gap:10}}>
        <div style={{display:'flex',gap:4,background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:3}}>
          <TabBtn id="inventario"  label="Inventario"/>
          <TabBtn id="cargar"      label="Cargar stock"/>
          <TabBtn id="recetas"     label="Recetas"/>
          <TabBtn id="movimientos" label="Movimientos"/>
          <TabBtn id="toma"        label="Toma" badge={faltaApertura}/>
        </div>
        <button onClick={()=>{ loadData(); loadTodaySessions(); }} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:6,padding:'6px 12px',color:C.mid,fontSize:12,cursor:'pointer'}}>↺ Actualizar</button>
      </div>

      {/* Alertas de vencimiento */}
      {expiringAlerts.length>0&&(
        <div style={{marginBottom:12,background:TINT.amberBg,border:`1px solid ${TINT.amberBorder}`,borderRadius:8,overflow:'hidden'}}>
          <div style={{padding:'8px 14px',borderBottom:`1px solid ${TINT.amberBorder}`,fontSize:10,fontWeight:700,color:TINT.amberText,letterSpacing:1}}>VENCIMIENTOS PROXIMOS</div>
          {expiringAlerts.map(ing=>{
            const exp = new Date(ing.expiry_date);
            const vencido = exp < now;
            const diffDays = Math.ceil((exp-now)/86400000);
            return (
              <div key={ing.id} style={{padding:'8px 14px',borderBottom:'1px solid #FFD58040',display:'flex',justifyContent:'space-between',alignItems:'center',background:vencido?TINT.redBg:'transparent'}}>
                <div style={{fontSize:13,fontWeight:600,color:C.ink}}>{ing.name}</div>
                <div style={{display:'flex',alignItems:'center',gap:10}}>
                  <span style={{fontSize:11,color:C.dim}}>{fmtDate(ing.expiry_date)}</span>
                  {vencido
                    ?<span style={{background:TINT.redBg,border:`1px solid ${TINT.redBorder}`,color:TINT.redText,padding:'2px 8px',fontSize:10,fontWeight:700,borderRadius:4}}>VENCIDO</span>
                    :<span style={{background:TINT.amberBg,border:`1px solid ${TINT.amberBorder}`,color:TINT.amberText,padding:'2px 8px',fontSize:10,fontWeight:700,borderRadius:4}}>VENCE en {diffDays}d</span>
                  }
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Alertas activas de stock */}
      {alerts.length>0&&(
        <div style={{marginBottom:14,display:'flex',flexDirection:'column',gap:6}}>
          {alerts.map(al=>(
            <div key={al.id} style={{background:'#160808',border:`1px solid ${alertColor(al.alert_type)}40`,borderRadius:8,padding:'10px 16px',display:'flex',alignItems:'center',gap:10}}>
              <span style={{fontSize:16}}>{alertIcon(al.alert_type)}</span>
              <div style={{flex:1}}>
                <span style={{fontWeight:700,fontSize:13,color:alertColor(al.alert_type)}}>{alertLabel(al.alert_type)}: </span>
                <span style={{fontSize:13,color:C.ink}}>{al.ingredient?.name||'—'}</span>
                {al.current_value!=null&&<span style={{fontSize:11,color:C.mid,marginLeft:8}}>({fmtStock(al.current_value,al.ingredient?.unit||'unit')} actual)</span>}
              </div>
              <Btn small variant="ghost" onClick={()=>resolveAlert(al.id)}>Resolver</Btn>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:200,gap:12}}><span className="spin"/><span style={{color:C.mid}}>Cargando inventario…</span></div>
      ) : (<>

        {/* ── INVENTARIO ── */}
        {tab==='inventario'&&(
          <div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
              <span style={{fontSize:13,color:C.mid}}>{ingredients.length} ingredientes registrados</span>
              <Btn small onClick={()=>setTab('cargar')}>+ Nuevo ingrediente</Btn>
            </div>
            {ingredients.length===0 ? (
              <div style={{textAlign:'center',padding:'60px 0',color:C.dim,fontSize:14}}>No hay ingredientes.<br/><span style={{fontSize:12}}>Creá uno y vinculalo al menú con "Recetas".</span></div>
            ) : (
              <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
                <table style={{width:'100%',borderCollapse:'collapse'}}>
                  <thead><tr><Th>Ingrediente</Th><Th>Stock actual</Th><Th>Umbral mín.</Th><Th>Proyectado</Th><Th>Estado</Th><Th>Vence</Th></tr></thead>
                  <tbody>
                    {ingredients.map(ing=>{
                      const lc=stockColor(ing.stock_level);
                      const diff=ing.projected_qty-ing.stock_quantity;
                      return (
                        <tr key={ing.id} style={{borderBottom:`1px solid #0d0d0d`}}>
                          <Td><div style={{fontWeight:600}}>{ing.name}</div>{ing.category&&<div style={{fontSize:11,color:C.dim}}>{ing.category}</div>}</Td>
                          <Td><span style={{fontWeight:700,color:lc,fontFamily:"'SF Mono',ui-monospace,monospace"}}>{fmtStock(ing.stock_quantity,ing.unit)}</span></Td>
                          <Td mono dim>{ing.min_threshold>0?fmtStock(ing.min_threshold,ing.unit):'—'}</Td>
                          <Td><span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:12,color:ing.projected_qty<0?C.red:ing.projected_qty<ing.min_threshold?C.orange:C.mid}}>{fmtStock(Math.max(0,ing.projected_qty),ing.unit)}</span>{diff<0&&<span style={{fontSize:10,color:C.red,marginLeft:4}}>↓{fmtStock(Math.abs(diff),ing.unit)}</span>}</Td>
                          <Td><span style={{padding:'2px 8px',borderRadius:20,fontSize:11,fontWeight:700,background:lc+'22',color:lc}}>{stockLabel(ing.stock_level)}</span>{ing.alert_count>0&&<span style={{marginLeft:6,fontSize:10,color:C.red}}>⚠{ing.alert_count}</span>}</Td>
                          <Td style={{fontSize:12,color:ing.expiry_date&&new Date(ing.expiry_date)<new Date()?C.red:ing.expiry_date&&new Date(ing.expiry_date)<new Date(Date.now()+7*86400000)?C.orange:C.mid}}>{ing.expiry_date?fmtDate(ing.expiry_date):'—'}</Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {menuItems.length>0&&(
              <div style={{marginTop:16,background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
                <div style={{padding:'10px 14px',borderBottom:`1px solid ${C.border}`,fontWeight:600,fontSize:13}}>Disponibilidad del menú</div>
                <div style={{padding:14,display:'flex',flexWrap:'wrap',gap:8}}>
                  {menuItems.map(mi=>(
                    <div key={mi.id} style={{padding:'4px 10px',borderRadius:20,fontSize:12,fontWeight:600,background:mi.is_available?'#102a10':'#2a1010',color:mi.is_available?C.green:C.red,border:`1px solid ${mi.is_available?C.green:C.red}30`}}>
                      {mi.is_available?'●':'○'} {mi.name}
                      {!mi.is_available&&mi.availability_reason&&<span style={{fontSize:10,fontWeight:400,color:C.red,marginLeft:4}}>({mi.availability_reason})</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── CARGAR STOCK ── */}
        {tab==='cargar'&&(
          <div style={{maxWidth:560}}>
            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:22}}>
              <div style={{fontWeight:700,fontSize:15,marginBottom:18}}>Cargar stock de ingrediente</div>
              <div style={{display:'flex',flexDirection:'column',gap:12}}>
                <FF label="INGREDIENTE *">
                  <Sel value={loadForm.ingredient_id} onChange={e=>setLoadForm({...loadForm,ingredient_id:e.target.value,unit:(ingredients.find(i=>i.id===e.target.value)?.unit||'unit')})}>
                    <option value="">— Seleccioná un ingrediente —</option>
                    {ingredients.map(i=><option key={i.id} value={i.id}>{i.name} (stock: {fmtStock(i.stock_quantity,i.unit)})</option>)}
                  </Sel>
                </FF>
                <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:10}}>
                  <FF label="CANTIDAD *"><NumInp decimals={3} value={loadForm.quantity} onChange={v=>setLoadForm({...loadForm,quantity:v})} placeholder="ej: 5"/></FF>
                  <FF label="UNIDAD"><Sel value={loadForm.unit} onChange={e=>setLoadForm({...loadForm,unit:e.target.value})}>{unitOpts(ingredients.find(i=>i.id===loadForm.ingredient_id)?.unit).map(([v,l])=><option key={v} value={v}>{l}</option>)}</Sel></FF>
                </div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                  <FF label="VENCIMIENTO" hint="Opcional, recomendado para perecederos"><Inp type="date" value={loadForm.expiry_date} onChange={e=>setLoadForm({...loadForm,expiry_date:e.target.value})}/></FF>
                  <FF label="N° LOTE / REMITO" hint="Para trazabilidad"><Inp value={loadForm.batch_id} onChange={e=>setLoadForm({...loadForm,batch_id:e.target.value})} placeholder="Opcional"/></FF>
                </div>
                <FF label="COSTO UNITARIO (₲)" hint="Opcional — para reportes de costo"><MoneyInp value={loadForm.cost_per_unit} onChange={v=>setLoadForm({...loadForm,cost_per_unit:v})} placeholder="Opcional"/></FF>
                <FF label="NOTAS"><textarea rows={2} value={loadForm.notes} onChange={e=>setLoadForm({...loadForm,notes:e.target.value})} placeholder="Ej: Proveedor X, factura #123" style={{width:'100%',padding:'8px 10px',fontSize:13,borderRadius:6,resize:'vertical'}}/></FF>
                <Btn onClick={doLoadStock} disabled={saving} style={{width:'100%'}}>{saving?'Guardando…':'Confirmar carga de stock'}</Btn>
              </div>
            </div>
            <div style={{marginTop:16,background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:22}}>
              <div style={{fontWeight:700,fontSize:15,marginBottom:18}}>Nuevo ingrediente</div>
              <div style={{display:'flex',flexDirection:'column',gap:12}}>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                  <FF label="NOMBRE *"><Inp value={ingForm.name} onChange={e=>setIngForm({...ingForm,name:e.target.value})} placeholder="Ej: Carne vacuna"/></FF>
                  <FF label="CATEGORÍA"><Inp value={ingForm.category} onChange={e=>setIngForm({...ingForm,category:e.target.value})} placeholder="Ej: Carnes, Lácteos…"/></FF>
                </div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10}}>
                  <FF label="UNIDAD BASE"><Sel value={ingForm.unit} onChange={e=>setIngForm({...ingForm,unit:e.target.value})}>{Object.entries(UNIT_LABELS).map(([v,l])=><option key={v} value={v}>{l}</option>)}</Sel></FF>
                  <FF label="STOCK INICIAL" hint="Podés dejar en 0 y cargar después"><NumInp decimals={3} value={ingForm.stock_quantity} onChange={v=>setIngForm({...ingForm,stock_quantity:v})} placeholder="0"/></FF>
                  <FF label="UMBRAL MÍN." hint="Alerta cuando baje de este nivel"><NumInp decimals={3} value={ingForm.min_threshold} onChange={v=>setIngForm({...ingForm,min_threshold:v})} placeholder="0"/></FF>
                </div>
                <Btn onClick={createIngredient} disabled={saving} style={{width:'100%'}}>{saving?'Guardando…':'Crear ingrediente'}</Btn>
              </div>
            </div>
          </div>
        )}

        {/* ── RECETAS ── */}
        {tab==='recetas'&&(
          <div>
            <div style={{marginBottom:12,background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'12px 16px'}}>
              <div style={{fontWeight:700,fontSize:13,color:C.ink,marginBottom:4}}>¿Cómo funciona?</div>
              <div style={{fontSize:12,color:C.mid,lineHeight:1.5}}>
                Vinculá ingredientes a ítems del menú. Cuando se venda ese ítem (y el descuento automático esté ON), el sistema descontará la cantidad indicada del stock del ingrediente.<br/>
                <b>Si un ítem no tiene receta configurada, no se descuenta nada — sin problema.</b><br/>
                Podés ir configurando de a poco según tu disponibilidad.
              </div>
            </div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
              <span style={{fontSize:13,color:C.mid}}>{recipes.length} vínculos configurados</span>
              <Btn small onClick={()=>setModal('new_recipe')}>+ Nueva receta</Btn>
            </div>
            {recipes.length===0 ? (
              <div style={{textAlign:'center',padding:'60px 0',color:C.dim,fontSize:14}}>No hay recetas.<br/><span style={{fontSize:12}}>Sin receta, el stock no se descuenta automáticamente.</span></div>
            ) : (
              <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
                <table style={{width:'100%',borderCollapse:'collapse'}}>
                  <thead><tr><Th>Ítem del menú</Th><Th>Ingrediente</Th><Th>Cantidad/porción</Th><Th>Notas</Th><Th/></tr></thead>
                  <tbody>
                    {recipes.map(rec=>(
                      <tr key={rec.id} style={{borderBottom:`1px solid #0d0d0d`}}>
                        <Td style={{fontWeight:600}}>{itemName(rec.menu_item_id)}</Td>
                        <Td>{ingName(rec.ingredient_id)}</Td>
                        <Td mono dim>{rec.quantity_required} {UNIT_DISPLAY[rec.unit]||rec.unit}</Td>
                        <Td dim>{rec.notes||'—'}</Td>
                        <Td right><Btn small variant="danger" onClick={()=>deleteRecipe(rec.id)}>Eliminar</Btn></Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── MOVIMIENTOS ── */}
        {tab==='movimientos'&&(
          <div>
            <div style={{marginBottom:12,fontSize:13,color:C.mid}}>Últimos 100 movimientos de stock</div>
            {movements.length===0 ? (
              <div style={{textAlign:'center',padding:'60px 0',color:C.dim,fontSize:14}}>No hay movimientos registrados aún.</div>
            ) : (
              <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
                <table style={{width:'100%',borderCollapse:'collapse'}}>
                  <thead><tr><Th>Fecha</Th><Th>Tipo</Th><Th>Ingrediente</Th><Th>Cantidad</Th><Th>Notas</Th></tr></thead>
                  <tbody>
                    {movements.map(mv=>{
                      const col=mvtColor(mv.movement_type);
                      return (
                        <tr key={mv.id} style={{borderBottom:`1px solid #0d0d0d`}}>
                          <Td mono dim>{fmtDT(mv.created_at)}</Td>
                          <Td><span style={{display:'inline-flex',alignItems:'center',gap:5,padding:'2px 8px',borderRadius:20,fontSize:11,fontWeight:700,background:col+'22',color:col}}>{mvtIcon(mv.movement_type)} {mv.movement_type}</span></Td>
                          <Td style={{fontWeight:500}}>{mv.ingredient?.name||'—'}</Td>
                          <Td mono style={{color:mv.movement_type==='load'?C.green:C.red}}>{mv.movement_type==='load'?'+':'-'}{fmtStock(mv.quantity,mv.ingredient?.unit||'unit')}</Td>
                          <Td dim>{mv.notes||'—'}</Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── TOMA DE INVENTARIO ── */}
        {tab==='toma'&&(
          <div>

            {/* Vista: lista de sesiones del día */}
            {tomaView==='list'&&(
              <div>
                {/* Resumen del día */}
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
                  {['apertura','cierre'].map(tipo=>{
                    const sess = todaySessions.filter(s=>s.session_type===tipo&&s.status==='completado');
                    const ultima = sess[0];
                    const enCurso = todaySessions.find(s=>s.session_type===tipo&&s.status==='en_curso');
                    const hecho = !!ultima;
                    return (
                      <div key={tipo} style={{background:C.surface,border:`2px solid ${hecho?C.green:enCurso?C.yellow:'#D2D2D7'}`,borderRadius:10,padding:'14px 16px'}}>
                        <div style={{fontWeight:700,fontSize:14,color:C.ink,marginBottom:4,textTransform:'capitalize'}}>
                          Toma de {tipo}
                        </div>
                        {hecho ? (
                          <>
                            <div style={{fontSize:11,color:C.green,fontWeight:600,marginBottom:2}}>✓ Completada hoy</div>
                            <div style={{fontSize:11,color:C.mid}}>{fmtDT(ultima.created_at)}</div>
                          </>
                        ) : enCurso ? (
                          <div style={{fontSize:11,color:C.yellow,fontWeight:600}}>En curso…</div>
                        ) : (
                          <div style={{fontSize:11,color:'#C0190F',fontWeight:600}}>✗ Pendiente hoy</div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Aviso obligatoriedad */}
                {(faltaApertura||faltaCierre)&&(
                  <div style={{background:'#1a1200',border:'1px solid #FFD58060',borderRadius:8,padding:'10px 14px',marginBottom:16,fontSize:12,color:'#FFD580'}}>
                    <b>Control de turno obligatorio:</b> la toma de inventario de {faltaApertura?'apertura':'cierre'} del día está pendiente.
                    Realizála antes de operar el turno.
                  </div>
                )}

                {ingredients.length===0 ? (
                  <div style={{textAlign:'center',padding:'40px 0',color:C.dim,fontSize:13}}>
                    No hay ingredientes registrados.<br/>
                    <span style={{fontSize:12}}>Primero agregá ingredientes en "Cargar stock".</span>
                  </div>
                ) : (
                  <div style={{display:'flex',flexDirection:'column',gap:10}}>
                    {/* Botones de inicio */}
                    <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
                      {[
                        {tipo:'apertura',label:'Iniciar toma de apertura',disabled:todaySessions.some(s=>s.session_type==='apertura'&&s.status==='completado')},
                        {tipo:'cierre',  label:'Iniciar toma de cierre',  disabled:!todaySessions.some(s=>s.session_type==='apertura'&&s.status==='completado')},
                      ].map(({tipo,label,disabled})=>(
                        <Btn key={tipo} onClick={()=>{ setTomaType(tipo); setTomaNotesForm(''); iniciarToma(tipo); }} disabled={disabled||tomaLoading}
                          style={{opacity:disabled?.5:1}}>
                          {tomaLoading?'Iniciando…':label}
                        </Btn>
                      ))}
                    </div>
                    {todaySessions.some(s=>s.session_type==='apertura'&&s.status==='completado')&&
                      !todaySessions.some(s=>s.session_type==='cierre'&&s.status==='completado')&&(
                      <div style={{fontSize:11,color:C.mid}}>La toma de cierre compara contra el stock actual del sistema.</div>
                    )}

                    {/* Historial del día */}
                    {todaySessions.length>0&&(
                      <div style={{marginTop:8,background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
                        <div style={{padding:'8px 14px',borderBottom:`1px solid ${C.border}`,fontSize:11,fontWeight:700,color:C.mid,letterSpacing:1}}>HISTORIAL DE HOY</div>
                        {todaySessions.map(s=>(
                          <div key={s.id} style={{padding:'10px 14px',borderBottom:`1px solid ${C.border}30`,display:'flex',alignItems:'center',gap:10}}>
                            <span style={{display:'flex',color:C.mid}}><Icon name={s.session_type==='apertura'?'sun':'moon'} size={16}/></span>
                            <div style={{flex:1}}>
                              <span style={{fontWeight:600,fontSize:13,textTransform:'capitalize'}}>{s.session_type}</span>
                              <span style={{marginLeft:8,padding:'1px 7px',borderRadius:10,fontSize:10,fontWeight:700,background:s.status==='completado'?C.green+'22':'#FFD58022',color:s.status==='completado'?C.green:'#8A4B00'}}>
                                {s.status==='completado'?'Completada':'En curso'}
                              </span>
                            </div>
                            <span style={{fontSize:11,color:C.mid}}>{fmtDT(s.created_at)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Vista: formulario de conteo */}
            {tomaView==='form'&&(
              <div>
                <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:16}}>
                  <button onClick={()=>setTomaView('list')} style={{background:'none',border:'none',cursor:'pointer',fontSize:18,color:C.mid}}>←</button>
                  <div>
                    <div style={{fontWeight:700,fontSize:16,textTransform:'capitalize'}}>Toma de {tomaType}</div>
                    <div style={{fontSize:11,color:C.mid}}>Ingresá la cantidad física contada. Dejá en blanco lo que no podés contar ahora.</div>
                  </div>
                </div>

                <div style={{background:TINT.greenBg,border:`1px solid ${TINT.greenBorder}`,borderRadius:8,padding:'10px 14px',marginBottom:14,fontSize:12,color:TINT.greenText}}>
                  <b>Tip:</b> los ítems que no contés quedan sin diferencia registrada. Podés completar solo lo que tenés a mano y continuar después.
                </div>

                <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden',marginBottom:14}}>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 100px 100px 90px',padding:'8px 14px',borderBottom:`1px solid ${C.border}`,fontSize:10,fontWeight:700,color:C.mid,letterSpacing:.5}}>
                    <span>INGREDIENTE</span><span>SISTEMA</span><span>CONTADO</span><span>AJUSTAR</span>
                  </div>
                  {tomaItems.map(it=>{
                    const cnt = tomaCounts[it.ingredient_id]||{counted:'',adjust:false};
                    const diff = cnt.counted!=='' ? parseFloat(cnt.counted||0)-it.system_quantity : null;
                    const hasDiff = diff!==null && Math.abs(diff)>0.001;
                    return (
                      <div key={it.ingredient_id} style={{display:'grid',gridTemplateColumns:'1fr 100px 100px 90px',padding:'10px 14px',borderBottom:`1px solid ${C.border}20`,alignItems:'center',background:hasDiff?(diff>0?TINT.greenBg:TINT.redBg):'transparent'}}>
                        <div>
                          <div style={{fontWeight:600,fontSize:13,color:C.ink}}>{it.name}</div>
                          {it.category&&<div style={{fontSize:10,color:C.dim}}>{it.category}</div>}
                        </div>
                        <div style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:12,color:C.mid}}>
                          {fmtStock(it.system_quantity, it.unit)}
                        </div>
                        <div style={{display:'flex',alignItems:'center',gap:4}}>
                          <NumInp decimals={3}
                            value={cnt.counted}
                            onChange={v=>setTomaCounts(prev=>({...prev,[it.ingredient_id]:{...prev[it.ingredient_id],counted:v}}))}
                            placeholder="—"
                            style={{width:70,textAlign:'right',fontFamily:"'SF Mono',ui-monospace,monospace",
                              background: hasDiff ? (diff>0?TINT.greenBg:TINT.redBg) : undefined,
                              color: hasDiff ? (diff>0?TINT.greenText:TINT.redText) : undefined,
                              fontWeight: hasDiff ? 700 : undefined,
                            }}
                          />
                          <span style={{fontSize:10,color:C.dim}}>{UNIT_DISPLAY[it.unit]||it.unit}</span>
                        </div>
                        <div style={{display:'flex',alignItems:'center',gap:6}}>
                          {hasDiff&&(
                            <>
                              <span style={{fontSize:11,fontWeight:700,color:diff>0?TINT.greenText:TINT.redText}}>
                                {diff>0?'+':''}{diff.toFixed(2)}
                              </span>
                              <input type="checkbox" checked={!!cnt.adjust}
                                onChange={e=>setTomaCounts(prev=>({...prev,[it.ingredient_id]:{...prev[it.ingredient_id],adjust:e.target.checked}}))}
                                style={{width:16,height:16,cursor:'pointer'}}
                                title="Aplicar ajuste al stock del sistema"
                              />
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div style={{fontSize:11,color:C.mid,marginBottom:10}}>
                  Marcá ✓ en "Ajustar" para actualizar el stock del sistema con el valor contado.
                </div>
                <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
                  <Btn variant="ghost" onClick={()=>setTomaView('list')}>Cancelar</Btn>
                  <Btn onClick={completarToma} disabled={tomaLoading}>
                    {tomaLoading?'Guardando…':'Completar toma'}
                  </Btn>
                </div>
              </div>
            )}

            {/* Vista: resultado */}
            {tomaView==='result'&&tomaResult&&(
              <div>
                <div style={{background:TINT.greenBg,border:`1px solid ${TINT.greenBorder}`,borderRadius:10,padding:'16px 20px',marginBottom:16,textAlign:'center'}}>
                  <div style={{fontSize:24,marginBottom:6}}>✓</div>
                  <div style={{fontWeight:700,fontSize:16,color:TINT.greenText,marginBottom:4,textTransform:'capitalize'}}>
                    Toma de {tomaType} completada
                  </div>
                  <div style={{fontSize:13,color:C.mid}}>
                    {tomaResult.discrepancy_count>0
                      ? `${tomaResult.discrepancy_count} diferencia${tomaResult.discrepancy_count>1?'s':''} encontrada${tomaResult.discrepancy_count>1?'s':''} · ${tomaResult.adjusted_count} ajuste${tomaResult.adjusted_count!==1?'s':''} aplicado${tomaResult.adjusted_count!==1?'s':''}`
                      : 'Sin diferencias — el stock coincide con el sistema'}
                  </div>
                </div>

                {/* Tabla de diferencias */}
                {tomaResult.discrepancy_count>0&&(
                  <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden',marginBottom:14}}>
                    <div style={{padding:'8px 14px',borderBottom:`1px solid ${C.border}`,fontSize:10,fontWeight:700,color:C.mid,letterSpacing:.5}}>DIFERENCIAS DETECTADAS</div>
                    {tomaResult.items
                      .filter(it=>{ const cnt=tomaResult.counts[it.ingredient_id]; return cnt?.counted!=='' && Math.abs(parseFloat(cnt?.counted||0)-it.system_quantity)>0.001; })
                      .map(it=>{
                        const cnt = tomaResult.counts[it.ingredient_id];
                        const diff = parseFloat(cnt.counted||0) - it.system_quantity;
                        return (
                          <div key={it.ingredient_id} style={{padding:'10px 14px',borderBottom:`1px solid ${C.border}20`,display:'grid',gridTemplateColumns:'1fr 90px 90px 80px 60px',alignItems:'center',gap:8}}>
                            <div style={{fontWeight:600,fontSize:13,color:C.ink}}>{it.name}</div>
                            <span style={{fontSize:12,color:C.mid,fontFamily:'monospace'}}>{fmtStock(it.system_quantity,it.unit)}</span>
                            <span style={{fontSize:12,color:C.ink,fontFamily:'monospace'}}>{fmtStock(parseFloat(cnt.counted),it.unit)}</span>
                            <span style={{fontSize:12,fontWeight:700,color:diff>0?TINT.greenText:TINT.redText,fontFamily:'monospace'}}>{diff>0?'+':''}{diff.toFixed(2)}</span>
                            <span style={{fontSize:11,color:cnt.adjust?TINT.greenText:C.mid}}>{cnt.adjust?'Ajustado':'Sin ajuste'}</span>
                          </div>
                        );
                      })}
                  </div>
                )}

                <div style={{display:'flex',gap:10,justifyContent:'center'}}>
                  <Btn onClick={()=>{ setTomaView('list'); setTomaResult(null); }}>Volver al inicio</Btn>
                  <Btn variant="ghost" onClick={()=>setTab('inventario')}>Ver inventario actualizado</Btn>
                </div>
              </div>
            )}
          </div>
        )}

      </>)}

      {/* Modal: nueva receta */}
      {modal==='new_recipe'&&(
        <Modal title="Nueva receta" onClose={()=>setModal(null)} width={480}>
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            <FF label="ÍTEM DEL MENÚ *">
              <Sel value={recForm.menu_item_id} onChange={e=>setRecForm({...recForm,menu_item_id:e.target.value})}>
                <option value="">— Seleccioná un ítem —</option>
                {menuItems.map(mi=><option key={mi.id} value={mi.id}>{mi.name}</option>)}
              </Sel>
            </FF>
            <FF label="INGREDIENTE *">
              <Sel value={recForm.ingredient_id} onChange={e=>setRecForm({...recForm,ingredient_id:e.target.value,unit:(ingredients.find(i=>i.id===e.target.value)?.unit||'unit')})}>
                <option value="">— Seleccioná un ingrediente —</option>
                {ingredients.map(i=><option key={i.id} value={i.id}>{i.name}</option>)}
              </Sel>
            </FF>
            <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:10}}>
              <FF label="CANTIDAD POR PORCIÓN *"><NumInp decimals={3} value={recForm.quantity_required} onChange={v=>setRecForm({...recForm,quantity_required:v})}/></FF>
              <FF label="UNIDAD"><Sel value={recForm.unit} onChange={e=>setRecForm({...recForm,unit:e.target.value})}>{unitOpts(ingredients.find(i=>i.id===recForm.ingredient_id)?.unit).map(([v,l])=><option key={v} value={v}>{l}</option>)}</Sel></FF>
            </div>
            <FF label="NOTAS" hint="Opcional — ej: 'Sin grasa'"><Inp value={recForm.notes} onChange={e=>setRecForm({...recForm,notes:e.target.value})} placeholder="Opcional"/></FF>
            <div style={{display:'flex',gap:10,justifyContent:'flex-end',paddingTop:4}}>
              <Btn variant="ghost" onClick={()=>setModal(null)}>Cancelar</Btn>
              <Btn onClick={createRecipe} disabled={saving}>{saving?'Guardando…':'Guardar receta'}</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════
   REPORTES
══════════════════════════════════════════════ */
function ReportesPage({orders}) {
  const [rType, setRType]     = useState('');
  const [fromStr, setFromStr] = useState('');
  const [toStr, setToStr]     = useState('');
  const [rows, setRows]       = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [reportTitle, setReportTitle] = useState('');

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
    const d=new Date(parseInt(p[2]), parseInt(p[1])-1, parseInt(p[0]));
    return isNaN(d.getTime()) ? null : d;
  }

  function dmyToISO(str) {
    if(!str) return '';
    const p = str.split('/');
    if(p.length!==3) return '';
    return `${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
  }

  const REPORT_DEFS = [
    {id:'ventas_periodo',   label:'Ventas por período',        cat:'ventas',    desc:'Total, pedidos y ticket promedio del período'},
    {id:'ventas_producto',  label:'Ventas por producto',       cat:'ventas',    desc:'Ranking de productos por cantidad e ingreso'},
    {id:'ventas_mesa',      label:'Ventas por mesa',           cat:'ventas',    desc:'Ingresos generados por cada mesa o canal'},
    {id:'delivery_canal',   label:'Delivery por canal',        cat:'ventas',    desc:'Pedidos, bruto, comisión y neto por canal (Propio, PedidosYa, Monchis…)'},
    {id:'metodo_pago',      label:'Métodos de pago',           cat:'ventas',    desc:'Distribución por efectivo, tarjeta, QR, POS'},
    {id:'rentabilidad',     label:'Rentabilidad por producto', cat:'ventas',    desc:'Margen bruto descontando costo de insumos'},
    {id:'egresos',          label:'Egresos / Gastos',          cat:'finanzas',  desc:'Gastos registrados por categoría en el período'},
    {id:'balance',          label:'Balance del período',       cat:'finanzas',  desc:'Ingresos vs egresos y resultado neto'},
    {id:'movimientos_caja', label:'Movimientos de caja',       cat:'caja',      desc:'Cobros, egresos y movimientos por turno'},
    {id:'transferencias',   label:'Transferencias y comprobantes', cat:'caja',  desc:'Cobros por transferencia / QR o tarjeta con su N° de comprobante'},
    {id:'stock_actual',     label:'Stock actual',              cat:'stock',     desc:'Inventario actual de ingredientes y alertas'},
    {id:'movimientos_stock',label:'Movimientos de stock',      cat:'stock',     desc:'Entradas, consumos y ajustes de inventario'},
    {id:'ratings',          label:'Calificaciones',            cat:'clientes',  desc:'Puntajes y comentarios de clientes'},
    {id:'cupones',          label:'Cupones y descuentos',      cat:'marketing', desc:'Uso y efectividad de cupones aplicados'},
  ];

  const CATS = [
    {id:'ventas',    label:'Ventas y facturación', icon:'↗', color:'#007AFF'},
    {id:'finanzas',  label:'Finanzas',             icon:'₲', color:'#34C759'},
    {id:'caja',      label:'Caja',                 icon:'□', color:'#FF9500'},
    {id:'stock',     label:'Stock / Insumos',      icon:'▤', color:'#AF52DE'},
    {id:'clientes',  label:'Clientes',             icon:'★', color:'#FFD60A'},
    {id:'marketing', label:'Marketing',            icon:'%', color:'#FF2D55'},
  ];

  const valid = o => !['draft','cancelled'].includes(o.status);

  async function generate() {
    const from = parseDMY(fromStr);
    const to   = parseDMY(toStr);
    if(!rType){ toast('Seleccioná un tipo de reporte',false); return; }
    if(!from||!to){ toast('Fechas inválidas — usá formato dd/mm/aaaa',false); return; }
    to.setHours(23,59,59,999);
    setLoading(true);
    setRows(null); setSummary(null);
    const def = REPORT_DEFS.find(r=>r.id===rType);
    setReportTitle(def?.label||'Reporte');
    try { await _run(rType, from, to); }
    catch(e){ toast('Error: '+e.message, false); }
    setLoading(false);
  }

  async function _run(type, from, to) {
    const fromISO = from.toISOString().slice(0,10);
    const toISO   = to.toISOString().slice(0,10);

    if(type==='ventas_periodo') {
      const f = orders.filter(o=>valid(o)&&new Date(o.created_at)>=from&&new Date(o.created_at)<=to);
      const total = f.reduce((s,o)=>s+(o.total||0),0);
      const count = f.length;
      setSummary([
        {label:'Total ventas',    value:fmt(total),                              color:'#34C759'},
        {label:'Pedidos',         value:count,                                   color:'#007AFF'},
        {label:'Ticket promedio', value:count?fmt(Math.round(total/count)):'—',  color:'#FF9500'},
      ]);
      setRows({
        cols:['Fecha','N° Pedido','Mesa','Estado','Pago','Total'],
        data:f.map(o=>[
          fmtDate(o.created_at),
          o.order_number||o.id?.slice(-6)||'—',
          mesaLabel(o),
          SL[o.status]||o.status,
          PL[o.payment_method]||o.payment_method||'—',
          fmt(o.total||0),
        ]),
      });
    }

    else if(type==='ventas_producto') {
      const f = orders.filter(o=>valid(o)&&new Date(o.created_at)>=from&&new Date(o.created_at)<=to);
      const ids = f.map(o=>o.id).slice(0,500);
      const {data:items} = ids.length>0&&db ? await db.from('order_items').select('item_name,quantity,total_price').in('order_id',ids) : {data:[]};
      const map = {};
      (items||[]).forEach(it=>{ const k=it.item_name||'—'; if(!map[k])map[k]={name:k,qty:0,total:0}; map[k].qty+=(it.quantity||1); map[k].total+=(it.total_price||0); });
      const rows2 = Object.values(map).sort((a,b)=>b.total-a.total);
      const tot = rows2.reduce((s,r)=>s+r.total,0);
      setSummary([
        {label:'Total ventas',        value:fmt(tot),                              color:'#34C759'},
        {label:'Productos distintos', value:rows2.length,                          color:'#007AFF'},
        {label:'Unidades vendidas',   value:rows2.reduce((s,r)=>s+r.qty,0),       color:'#FF9500'},
      ]);
      setRows({ cols:['Producto','Unidades','Ingreso','% del total'], data:rows2.map(r=>[r.name, r.qty, fmt(r.total), tot>0?`${Math.round(r.total/tot*100)}%`:'—']) });
    }

    else if(type==='ventas_mesa') {
      const f = orders.filter(o=>valid(o)&&new Date(o.created_at)>=from&&new Date(o.created_at)<=to);
      const map = {};
      f.forEach(o=>{ const k=mesaLabel(o); if(!map[k])map[k]={mesa:k,pedidos:0,total:0}; map[k].pedidos++; map[k].total+=(o.total||0); });
      const rows2 = Object.values(map).sort((a,b)=>b.total-a.total);
      const tot = rows2.reduce((s,r)=>s+r.total,0);
      setSummary([
        {label:'Total ventas',  value:fmt(tot),    color:'#34C759'},
        {label:'Mesas/canales', value:rows2.length,color:'#007AFF'},
        {label:'Total pedidos', value:f.length,    color:'#FF9500'},
      ]);
      setRows({ cols:['Mesa / Canal','Pedidos','Ingreso','Ticket promedio'], data:rows2.map(r=>[r.mesa, r.pedidos, fmt(r.total), fmt(r.pedidos?Math.round(r.total/r.pedidos):0)]) });
    }

    else if(type==='delivery_canal') {
      // Fuente: delivery_orders (canal + comisión CONGELADOS por pedido). Nombres desde delivery_channels.
      const [doR, chR] = await Promise.all([
        db ? db.from('delivery_orders').select('channel,channel_commission,order_total,rider_status,created_at').eq('restaurant_id',RID).gte('created_at',from.toISOString()).lte('created_at',to.toISOString()) : {data:[]},
        db ? db.from('delivery_channels').select('slug,name').eq('restaurant_id',RID) : {data:[]},
      ]);
      const dords = (doR.data||[]).filter(o=>o.rider_status!=='cancelled');
      const nameBySlug = Object.fromEntries((chR.data||[]).map(c=>[c.slug,c.name]));
      const map = {};
      dords.forEach(o=>{
        const slug = o.channel||'propio';
        const bruto = o.order_total||0;
        const com = Math.round(bruto*(o.channel_commission||0)/100);
        if(!map[slug]) map[slug]={canal:nameBySlug[slug]||slug, pedidos:0, bruto:0, comision:0};
        map[slug].pedidos++; map[slug].bruto+=bruto; map[slug].comision+=com;
      });
      const rows2 = Object.values(map).map(r=>({...r, neto:r.bruto-r.comision})).sort((a,b)=>b.bruto-a.bruto);
      const totB=rows2.reduce((s,r)=>s+r.bruto,0), totC=rows2.reduce((s,r)=>s+r.comision,0);
      setSummary([
        {label:'Bruto delivery',   value:fmt(totB),      color:'#34C759'},
        {label:'Comisión canales', value:fmt(totC),      color:'#FF3B30'},
        {label:'Neto',             value:fmt(totB-totC), color:'#007AFF'},
      ]);
      setRows({ cols:['Canal','Pedidos','Bruto','Comisión','Neto'], data:rows2.map(r=>[r.canal, r.pedidos, fmt(r.bruto), r.comision>0?'-'+fmt(r.comision):fmt(0), fmt(r.neto)]) });
    }

    else if(type==='metodo_pago') {
      // Bug-06: el reporte de métodos de pago / "Total cobrado" cuenta sólo
      // pedidos efectivamente cobrados (payment_status='paid').
      const f = orders.filter(o=>valid(o)&&o.payment_status==='paid'&&new Date(o.created_at)>=from&&new Date(o.created_at)<=to);
      const map = {};
      f.forEach(o=>{ const k=PL[o.payment_method]||o.payment_method||'Sin especificar'; if(!map[k])map[k]={metodo:k,pedidos:0,total:0}; map[k].pedidos++; map[k].total+=(o.total||0); });
      const rows2 = Object.values(map).sort((a,b)=>b.total-a.total);
      const tot = rows2.reduce((s,r)=>s+r.total,0);
      setSummary([
        {label:'Total cobrado',      value:fmt(tot),    color:'#34C759'},
        {label:'Métodos distintos',  value:rows2.length,color:'#007AFF'},
        {label:'Total pedidos',      value:f.length,    color:'#FF9500'},
      ]);
      setRows({ cols:['Método de pago','Pedidos','Total','% participación'], data:rows2.map(r=>[r.metodo, r.pedidos, fmt(r.total), tot>0?`${Math.round(r.total/tot*100)}%`:'—']) });
    }

    else if(type==='rentabilidad') {
      const f = orders.filter(o=>valid(o)&&new Date(o.created_at)>=from&&new Date(o.created_at)<=to);
      const ids = f.map(o=>o.id).slice(0,500);
      const [{data:items},{data:ings},{data:recs}] = await Promise.all([
        ids.length>0&&db ? db.from('order_items').select('item_name,quantity,total_price,menu_item_id').in('order_id',ids) : {data:[]},
        db ? db.from('ingredients').select('id,name,unit_cost').eq('restaurant_id',RID) : {data:[]},
        db ? db.from('recipes').select('*') : {data:[]},
      ]);
      const map = {};
      (items||[]).forEach(it=>{ const k=it.item_name||'—'; if(!map[k])map[k]={name:k,qty:0,total:0,mid:it.menu_item_id}; map[k].qty+=(it.quantity||1); map[k].total+=(it.total_price||0); });
      const rows2 = Object.values(map).map(p=>{
        const costU = (recs||[]).filter(r=>r.menu_item_id===p.mid).reduce((s,r)=>{ const i=(ings||[]).find(x=>x.id===r.ingredient_id); return s+(i?.unit_cost||0)*(r.quantity_required||1); },0);
        const costo = costU*p.qty;
        return {...p, costo, margen:p.total-costo};
      }).sort((a,b)=>b.total-a.total);
      const totV=rows2.reduce((s,r)=>s+r.total,0), totC=rows2.reduce((s,r)=>s+r.costo,0);
      setSummary([
        {label:'Ingresos',     value:fmt(totV),       color:'#34C759'},
        {label:'Costo insumos',value:fmt(totC),       color:'#FF3B30'},
        {label:'Margen bruto', value:fmt(totV-totC),  color:(totV-totC)>=0?'#34C759':'#FF3B30'},
      ]);
      setRows({ cols:['Producto','Uds','Ingreso','Costo','Margen','% Margen'], data:rows2.map(r=>[r.name, r.qty, fmt(r.total), r.costo>0?fmt(r.costo):'—', r.costo>0?fmt(r.margen):'—', r.costo>0&&r.total>0?`${Math.round(r.margen/r.total*100)}%`:'—']) });
    }

    else if(type==='egresos') {
      let data = [];
      if(db){
        const{data:d}=await db.from('expenses').select('*').eq('restaurant_id',RID).gte('date',fromISO).lte('date',toISO).order('date',{ascending:false});
        data = d||[];
        if(data.length===0) data = LS.get(EGRESOS_KEY,[]).filter(e=>e.date>=fromISO&&e.date<=toISO);
      } else { data = LS.get(EGRESOS_KEY,[]).filter(e=>e.date>=fromISO&&e.date<=toISO); }
      const tot = data.reduce((s,e)=>s+(e.amount||0),0);
      const catMap = {};
      data.forEach(e=>{ const c=e.category||'Sin categoría'; catMap[c]=(catMap[c]||0)+(e.amount||0); });
      setSummary([
        {label:'Total egresos',value:fmt(tot),                   color:'#FF3B30'},
        {label:'Registros',    value:data.length,                color:C.mid},
        {label:'Categorías',   value:Object.keys(catMap).length, color:'#FF9500'},
      ]);
      setRows({ cols:['Fecha','Categoría','Descripción','Monto'], data:data.map(e=>[e.date?e.date.split('-').reverse().join('/'):'—', e.category||'—', e.description||e.desc||'—', fmt(e.amount||0)]) });
    }

    else if(type==='balance') {
      const f = orders.filter(o=>valid(o)&&new Date(o.created_at)>=from&&new Date(o.created_at)<=to);
      const ingresos = f.reduce((s,o)=>s+(o.total||0),0);
      let egData = [];
      if(db){
        const{data:d}=await db.from('expenses').select('*').eq('restaurant_id',RID).gte('date',fromISO).lte('date',toISO);
        egData=d||[];
        if(egData.length===0) egData=LS.get(EGRESOS_KEY,[]).filter(e=>e.date>=fromISO&&e.date<=toISO);
      } else { egData=LS.get(EGRESOS_KEY,[]).filter(e=>e.date>=fromISO&&e.date<=toISO); }
      const egresos = egData.reduce((s,e)=>s+(e.amount||0),0);
      const resultado = ingresos-egresos;
      const catMap = {};
      egData.forEach(e=>{ const c=e.category||'Sin cat'; catMap[c]=(catMap[c]||0)+(e.amount||0); });
      setSummary([
        {label:'Ingresos',      value:fmt(ingresos),  color:'#34C759'},
        {label:'Egresos',       value:fmt(egresos),   color:'#FF3B30'},
        {label:'Resultado neto',value:fmt(resultado), color:resultado>=0?'#34C759':'#FF3B30'},
      ]);
      const balRows = [
        ['── INGRESOS ──','',''],
        ...f.slice(0,100).map(o=>[fmtDate(o.created_at), `Pedido #${o.order_number||'—'}`, fmt(o.total||0)]),
        ...(f.length>100?[[`… y ${f.length-100} más`,'',fmt(ingresos)]]:[] ),
        ['── EGRESOS ──','',''],
        ...Object.entries(catMap).map(([c,a])=>[c,'',fmt(a)]),
        ['── RESULTADO NETO ──','',fmt(resultado)],
      ];
      setRows({ cols:['Concepto','Detalle','Monto'], data:balRows });
    }

    else if(type==='movimientos_caja') {
      if(!db){toast('Sin conexión a base de datos',false);return;}
      const{data:turnos}=await db.from('turnos_caja').select('*').eq('restaurant_id',RID).gte('fecha_apertura',from.toISOString()).lte('fecha_apertura',to.toISOString()).order('fecha_apertura',{ascending:false});
      const tIds=(turnos||[]).map(t=>t.id);
      let movs=[];
      if(tIds.length>0){const{data:m}=await db.from('movimientos_caja').select('*').in('turno_id',tIds).order('created_at',{ascending:false});movs=m||[];}
      const totCobros=movs.filter(m=>m.tipo==='cobro').reduce((s,m)=>s+Number(m.monto||0),0);
      const totEg=movs.filter(m=>m.tipo==='egreso').reduce((s,m)=>s+Number(m.monto||0),0);
      setSummary([
        {label:'Total cobrado', value:fmt(totCobros),      color:'#34C759'},
        {label:'Egresos caja',  value:fmt(totEg),          color:'#FF3B30'},
        {label:'Turnos',        value:(turnos||[]).length, color:'#007AFF'},
      ]);
      setRows({ cols:['Fecha/Hora','Tipo','Descripción','Monto','Cajero'], data:movs.slice(0,300).map(m=>[fmtDT(m.created_at), m.tipo||'—', m.descripcion||'—', fmt(Number(m.monto||0)), m.usuario_nombre||'—']) });
    }

    else if(type==='transferencias') {
      // Detalle de cobros por transferencia/QR o tarjeta con su N° de comprobante,
      // la FOTO del comprobante y el estado de validación (mig 180 + 182 · FASE D2).
      // Lee de orders (más completo que el ledger: incluye cobros de caja Y mozo).
      if(!db){toast('Sin conexión a base de datos',false);return;}
      const METS=['qr','transferencia','tarjeta_credito','tarjeta_debito','tarjeta','pos','mixto'];
      const base='id,order_number,created_at,payment_method,payment_reference,total,customer_name,paid_by_name';
      const ext=base+',payment_proof_url,payment_review_status';
      const runQ=cols=>db.from('orders').select(cols).eq('restaurant_id',RID).eq('payment_status','paid')
        .gte('created_at',from.toISOString()).lte('created_at',to.toISOString())
        .in('payment_method',METS).order('created_at',{ascending:false}).limit(300);
      let hasExt=true; let r=await runQ(ext);
      if(r.error){ hasExt=false; r=await runQ(base); }   // fail-open: mig 182 sin aplicar
      const trans=r.data||[];
      const ML={qr:'Transferencia / QR',transferencia:'Transferencia',tarjeta_credito:'Tarjeta crédito',tarjeta_debito:'Tarjeta débito',tarjeta:'Tarjeta',pos:'POS/Mixto',mixto:'Mixto'};
      const totTrans=trans.reduce((s,o)=>s+Number(o.total||0),0);
      const conComp=trans.filter(o=>o.payment_reference||o.payment_proof_url).length;
      const pend=trans.filter(o=>o.payment_review_status==='pending').length;
      const rech=trans.filter(o=>o.payment_review_status==='rejected').length;
      setSummary([
        {label:'Cobros transf./tarjeta', value:trans.length, color:'#007AFF'},
        {label:'Con comprobante',        value:conComp,       color:'#34C759'},
        hasExt?{label:'Sin validar',     value:pend,          color:pend?'#FF9500':'#8E8E93'}:null,
        hasExt?{label:'Rechazados',      value:rech,          color:rech?'#FF3B30':'#8E8E93'}:null,
      ].filter(Boolean));
      const cols=['Fecha/Hora','Método','N° comprobante','Foto','Validación','Monto','Cliente/Cajero'];
      setRows({ cols, data:trans.map(o=>{
        const meta=hasExt?reviewMeta(o.payment_review_status):null;
        return [fmtDT(o.created_at), ML[o.payment_method]||o.payment_method||'—', o.payment_reference||'—',
          o.payment_proof_url?'Con foto':'—', meta?meta.short:'—', fmt(Number(o.total||0)), o.paid_by_name||o.customer_name||'—'];
      }) });
    }

    else if(type==='stock_actual') {
      if(!db){toast('Sin conexión a base de datos',false);return;}
      const [{data:ings},{data:alerts}] = await Promise.all([
        db.from('ingredients').select('*').eq('restaurant_id',RID).order('name'),
        db.from('stock_alerts').select('*').eq('restaurant_id',RID).is('resolved_at',null),
      ]);
      const alertIds=new Set((alerts||[]).map(a=>a.ingredient_id));
      const total=(ings||[]).length;
      setSummary([
        {label:'Ingredientes',value:total,               color:'#007AFF'},
        {label:'Con alerta',  value:alertIds.size,       color:'#FF3B30'},
        {label:'OK',          value:total-alertIds.size, color:'#34C759'},
      ]);
      setRows({ cols:['Ingrediente','Stock actual','Mínimo','Unidad','Costo unit.','Estado'], data:(ings||[]).map(i=>[i.name, i.stock_quantity??'—', i.min_threshold??'—', i.unit||'—', (i.unit_cost??i.cost_per_unit)?fmt(i.unit_cost??i.cost_per_unit):'—', alertIds.has(i.id)?'⚠ Alerta':'✓ OK']) });
    }

    else if(type==='movimientos_stock') {
      if(!db){toast('Sin conexión a base de datos',false);return;}
      const{data:movs}=await db.from('stock_movements').select('*,ingredients(name)').eq('restaurant_id',RID).gte('created_at',from.toISOString()).lte('created_at',to.toISOString()).order('created_at',{ascending:false}).limit(300);
      const data=movs||[];
      const entradas=data.filter(m=>m.type==='add').reduce((s,m)=>s+(m.quantity||0),0);
      const salidas=data.filter(m=>m.type==='deduct').reduce((s,m)=>s+(m.quantity||0),0);
      setSummary([
        {label:'Movimientos',      value:data.length, color:'#007AFF'},
        {label:'Entradas',         value:entradas,    color:'#34C759'},
        {label:'Salidas/Consumos', value:salidas,     color:'#FF3B30'},
      ]);
      setRows({ cols:['Fecha','Ingrediente','Tipo','Cantidad','Nota'], data:data.map(m=>[fmtDate(m.created_at), m.ingredients?.name||'—', m.type==='add'?'Entrada':m.type==='deduct'?'Consumo':m.type||'—', m.quantity||0, m.note||'—']) });
    }

    else if(type==='ratings') {
      let data=[];
      if(db){const{data:d}=await db.from('ratings').select('*').eq('restaurant_id',RID).gte('created_at',from.toISOString()).lte('created_at',to.toISOString()).order('created_at',{ascending:false});data=d||[];}
      const count=data.length;
      const avg=count?(data.reduce((s,r)=>s+(r.stars||r.rating||0),0)/count).toFixed(1):'—';
      const pos=data.filter(r=>(r.stars||r.rating||0)>=4).length;
      setSummary([
        {label:'Calificaciones',  value:count,      color:'#007AFF'},
        {label:'Promedio',        value:`${avg} ★`, color:'#FFD60A'},
        {label:'Positivas (≥4★)', value:pos,        color:'#34C759'},
      ]);
      setRows({ cols:['Fecha','Puntaje','Comentario','Mesa'], data:data.map(r=>[fmtDate(r.created_at), `${r.stars||r.rating||'—'} ★`, r.comment||r.comentario||'—', r.table_number?`Mesa ${r.table_number}`:'—']) });
    }

    else if(type==='cupones') {
      const f = orders.filter(o=>valid(o)&&o.coupon_code&&new Date(o.created_at)>=from&&new Date(o.created_at)<=to);
      const map={};
      f.forEach(o=>{ const k=o.coupon_code; if(!map[k])map[k]={code:k,usos:0,desc:0}; map[k].usos++; map[k].desc+=(o.discount_amount||0); });
      const rows2=Object.values(map).sort((a,b)=>b.usos-a.usos);
      const totDesc=rows2.reduce((s,c)=>s+c.desc,0);
      setSummary([
        {label:'Pedidos con cupón', value:f.length,    color:'#007AFF'},
        {label:'Cupones distintos', value:rows2.length,color:'#FF9500'},
        {label:'Total descuentos',  value:fmt(totDesc),color:'#FF3B30'},
      ]);
      setRows({ cols:['Cupón','Usos','Descuento total'], data:rows2.map(c=>[c.code, c.usos, fmt(c.desc)]) });
    }
  }

  function exportCSV() {
    if(!rows) return;
    const lines=[rows.cols.join(','),...rows.data.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','))];
    const blob=new Blob(['﻿'+lines.join('\n')],{type:'text/csv;charset=utf-8;'});
    const url=URL.createObjectURL(blob); const a=document.createElement('a');
    a.href=url; a.download=`reporte_${rType}_${dmyToISO(fromStr)}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  function exportXLS() {
    if(!rows) return;
    const ws=XLSX.utils.aoa_to_sheet([rows.cols,...rows.data]);
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,(REPORT_DEFS.find(r=>r.id===rType)?.label||'Reporte').slice(0,31));
    XLSX.writeFile(wb,`reporte_${rType}_${dmyToISO(fromStr)}.xlsx`);
  }

  function exportPDF() {
    if(!rows) return;
    const def=REPORT_DEFS.find(r=>r.id===rType);
    const restaurantName = window.SUPABASE_CONFIG?.restaurantName || 'Restaurante';
    const w=window.open('','_blank');
    const sumHtml=summary?summary.map(s=>`<div style="display:inline-block;margin:0 24px 12px 0"><div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.5px">${esc(s.label)}</div><div style="font-size:20px;font-weight:800;color:${esc(s.color)}">${esc(s.value)}</div></div>`).join(''):'';
    const tHead=`<tr>${rows.cols.map(c=>`<th style="background:#E65100;color:#fff;padding:8px 12px;text-align:left;font-size:11px;white-space:nowrap">${esc(c)}</th>`).join('')}</tr>`;
    const tBody=rows.data.map((r,i)=>`<tr style="background:${i%2===0?'#fff':'#f9f9f9'}">${r.map(v=>`<td style="padding:7px 12px;font-size:11px;border-bottom:1px solid #eee">${esc(v)}</td>`).join('')}</tr>`).join('');
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${def?.label||'Reporte'}</title><style>body{font-family:system-ui,sans-serif;margin:32px;color:#222}@media print{button{display:none!important}}</style></head><body>
      <div style="font-size:24px;font-weight:800;color:#1D1D1F;margin-bottom:4px">${restaurantName}</div>
      <div style="font-size:16px;font-weight:700;color:#E65100;margin-bottom:4px">${def?.label||'Reporte'}</div>
      <div style="font-size:11px;color:#888;margin-bottom:18px">Generado: ${new Date().toLocaleDateString('es-PY')} · Período: ${fromStr} al ${toStr}</div>
      <div style="margin-bottom:20px;padding:14px 0;border-top:2px solid #E65100;border-bottom:1px solid #eee">${sumHtml}</div>
      <table style="width:100%;border-collapse:collapse;margin-top:4px"><thead>${tHead}</thead><tbody>${tBody}</tbody></table>
      <div style="margin-top:24px;font-size:9px;color:#bbb;text-align:right">Página 1 de 1 · Mythos</div>
      <script>window.onload=function(){window.print();}<\/script>
    </body></html>`);
    w.document.close();
  }

  function limpiar() { setRType(''); setRows(null); setSummary(null); setReportTitle(''); }

  const selDef = REPORT_DEFS.find(r=>r.id===rType);

  return (
    <div className="page">
      <div style={{marginBottom:20}}>
        <h1 style={{fontSize:22,fontWeight:800,color:C.ink}}>Reportes</h1>
        <div style={{fontSize:13,color:C.mid,marginTop:2}}>Análisis e informes con filtros y exportación</div>
      </div>

      {/* Panel personalizado */}
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:20,marginBottom:20}}>
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:16}}>
          <div style={{width:32,height:32,borderRadius:8,background:'rgba(230,81,0,0.1)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:16}}>≈</div>
          <div style={{fontSize:15,fontWeight:700}}>Reportes personalizados</div>
        </div>

        <div style={{marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:600,color:C.mid,marginBottom:5,letterSpacing:.5,textTransform:'uppercase'}}>Tipo de reporte</div>
          <select value={rType} onChange={e=>{setRType(e.target.value);setRows(null);setSummary(null);}} style={{width:'100%',maxWidth:420,padding:'9px 12px',borderRadius:8,fontSize:13,border:`1px solid ${C.border}`,background:C.surface,color:C.ink}}>
            <option value="">— Seleccioná un tipo —</option>
            {REPORT_DEFS.map(r=><option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          {selDef&&<div style={{fontSize:11,color:C.dim,marginTop:4}}>{selDef.desc}</div>}
        </div>

        <div style={{display:'flex',gap:14,alignItems:'flex-end',flexWrap:'wrap',marginBottom:16}}>
          <div>
            <div style={{fontSize:11,fontWeight:600,color:C.mid,marginBottom:5,letterSpacing:.5,textTransform:'uppercase'}}>Fecha desde</div>
            <input type="text" value={fromStr} onChange={e=>setFromStr(e.target.value)} placeholder="dd/mm/aaaa" style={{padding:'8px 12px',borderRadius:8,fontSize:13,border:`1px solid ${C.border}`,width:145,background:C.surface,color:C.ink}}/>
          </div>
          <div>
            <div style={{fontSize:11,fontWeight:600,color:C.mid,marginBottom:5,letterSpacing:.5,textTransform:'uppercase'}}>Fecha hasta</div>
            <input type="text" value={toStr} onChange={e=>setToStr(e.target.value)} placeholder="dd/mm/aaaa" style={{padding:'8px 12px',borderRadius:8,fontSize:13,border:`1px solid ${C.border}`,width:145,background:C.surface,color:C.ink}}/>
          </div>
        </div>

        <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
          <button onClick={generate} disabled={loading} style={{display:'inline-flex',alignItems:'center',gap:6,padding:'9px 18px',background:'#E65100',color:'#fff',border:'none',borderRadius:8,fontSize:13,fontWeight:700,cursor:'pointer',opacity:loading?0.7:1}}>
            {loading&&<span className="spin"/>}{loading?'Generando…':'≡ Generar reporte'}
          </button>
          {rows&&<>
            <button onClick={exportPDF} style={{display:'inline-flex',alignItems:'center',gap:6,padding:'9px 16px',background:'#FF3B30',color:'#fff',border:'none',borderRadius:8,fontSize:13,fontWeight:700,cursor:'pointer'}}>↓ Exportar PDF</button>
            <button onClick={exportXLS} style={{display:'inline-flex',alignItems:'center',gap:6,padding:'9px 16px',background:'#34C759',color:'#fff',border:'none',borderRadius:8,fontSize:13,fontWeight:700,cursor:'pointer'}}>↓ Exportar Excel</button>
            <button onClick={exportCSV} style={{display:'inline-flex',alignItems:'center',gap:6,padding:'9px 16px',background:C.ink,color:C.surface,border:'none',borderRadius:8,fontSize:13,fontWeight:700,cursor:'pointer'}}>↓ Exportar CSV</button>
            <button onClick={limpiar} style={{display:'inline-flex',alignItems:'center',gap:6,padding:'9px 14px',background:'transparent',color:C.mid,border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,cursor:'pointer'}}>✕ Limpiar</button>
          </>}
        </div>

        {summary&&(
          <div style={{marginTop:20,display:'flex',gap:12,flexWrap:'wrap'}}>
            {summary.map((s,i)=>(
              <div key={i} style={{flex:'1 1 180px',background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'14px 18px',borderLeft:`3px solid ${s.color}`}}>
                <div style={{fontSize:11,color:C.mid,marginBottom:4,textTransform:'uppercase',letterSpacing:.5,fontWeight:600}}>{s.label}</div>
                <div style={{fontSize:22,fontWeight:800,color:s.color}}>{s.value}</div>
              </div>
            ))}
          </div>
        )}

        {rows&&(
          <div style={{marginTop:16,overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
              <thead>
                <tr>{rows.cols.map((c,i)=><th key={i} style={{background:'#E65100',color:'#fff',padding:'8px 12px',textAlign:'left',fontWeight:700,fontSize:11,whiteSpace:'nowrap'}}>{c}</th>)}</tr>
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

      {/* Categorías de reportes */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:16}}>
        {CATS.map(cat=>{
          const catReps=REPORT_DEFS.filter(r=>r.cat===cat.id);
          return (
            <div key={cat.id} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:18}}>
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
                <div style={{width:30,height:30,borderRadius:7,background:`${cat.color}1A`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:14,color:cat.color,fontWeight:700}}>{cat.icon}</div>
                <div style={{fontSize:14,fontWeight:700}}>{cat.label}</div>
              </div>
              {catReps.map(r=>(
                <button key={r.id} onClick={()=>{setRType(r.id);setRows(null);setSummary(null);window.scrollTo({top:0,behavior:'smooth'});}} style={{display:'block',width:'100%',textAlign:'left',padding:'8px 10px',marginBottom:4,background:'transparent',border:'1px solid transparent',borderRadius:7,cursor:'pointer'}}>
                  <div style={{display:'flex',alignItems:'flex-start',gap:8}}>
                    <span style={{fontSize:11,color:C.dim,marginTop:2,flexShrink:0}}>≡</span>
                    <div>
                      <div style={{fontSize:13,fontWeight:600,color:C.ink}}>{r.label}</div>
                      <div style={{fontSize:11,color:C.dim,marginTop:1}}>{r.desc}</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
/* ══════════════════════════════════════════════
   ESTACIONES DE DESPACHO
   CRUD de cocinas/bares/cafeterías + asignación de
   categorías y zonas + link compartible + auditoría
══════════════════════════════════════════════ */
const STATION_TYPES = [
  {key:'cocina',    label:'Cocina',    icon:'🍳', color:'#fb923c'},
  {key:'parrilla',  label:'Parrilla',  icon:'🔥', color:'#f87171'},
  {key:'bar',       label:'Bar',       icon:'🍸', color:'#60a5fa'},
  {key:'cafeteria', label:'Cafetería', icon:'☕', color:'#c084fc'},
  {key:'postres',   label:'Postres',   icon:'🍰', color:'#f9a8d4'},
  {key:'custom',    label:'Otro',      icon:'⚙️', color:C.mid},
];
const STATION_ICONS = ['🍳','🔥','🍸','☕','🍰','🥘','🍕','🥗','🍔','🍷','🧁','🍺','🥩','🥖','🍦','⚙️'];
const STATION_COLORS = ['#fb923c','#f87171','#60a5fa','#c084fc','#f9a8d4','#34d399','#fbbf24','#a78bfa','#f472b6','#22d3ee','#000000'];

function EstacionesPage({categories, tables}) {
  const [tab, setTab]                       = useState('lista');
  const [stations, setStations]             = useState([]);
  const [stationCats, setStationCats]       = useState({});  // {station_id: [category_id...]}
  const [stationZonas, setStationZonas]     = useState({});  // {station_id: [zona...]}
  const [stats, setStats]                   = useState([]);
  const [loading, setLoading]               = useState(true);
  const [editing, setEditing]               = useState(null); // station object o {} para nueva
  const [saving, setSaving]                 = useState(false);
  const [confirmDel, setConfirmDel]         = useState(null);

  // Zonas existentes del salón (de la tabla tables) + estándar
  const STD_ZONAS = ['salon','terraza','bar','privado','exterior'];
  const zonasFromTables = useMemo(()=>{
    const s = new Set();
    (tables||[]).forEach(t=>{ if(t.zona) s.add(t.zona); });
    STD_ZONAS.forEach(z=>s.add(z));
    return Array.from(s).sort();
  },[tables]);

  const loadStations = React.useCallback(async()=>{
    if(!db) return;
    setLoading(true);
    const [sR, scR, szR, stR] = await Promise.all([
      db.from('kitchen_stations').select('*').eq('restaurant_id',RID).order('sort_order'),
      db.from('kitchen_station_categories').select('*'),
      db.from('kitchen_station_zonas').select('*'),
      db.from('kitchen_station_stats').select('*').eq('restaurant_id',RID),
    ]);
    setStations(sR.data||[]);
    const cm={};(scR.data||[]).forEach(r=>{(cm[r.station_id]=cm[r.station_id]||[]).push(r.category_id);});
    setStationCats(cm);
    const zm={};(szR.data||[]).forEach(r=>{(zm[r.station_id]=zm[r.station_id]||[]).push(r.zona);});
    setStationZonas(zm);
    setStats(stR.data||[]);
    setLoading(false);
  },[]);

  useEffect(()=>{ loadStations(); },[loadStations]);

  // Realtime
  useEffect(()=>{
    if(!db) return;
    const ch = db.channel('estaciones-rt')
      .on('postgres_changes',{event:'*',schema:'public',table:'kitchen_stations',filter:`restaurant_id=eq.${RID}`}, ()=>{ if(!_shouldPause()) loadStations(); })
      .on('postgres_changes',{event:'*',schema:'public',table:'kitchen_station_categories'}, ()=>{ if(!_shouldPause()) loadStations(); })
      .on('postgres_changes',{event:'*',schema:'public',table:'kitchen_station_zonas'}, ()=>{ if(!_shouldPause()) loadStations(); })
      .subscribe();
    return ()=>{ db.removeChannel(ch); };
  },[loadStations]);

  function openNew() {
    setEditing({
      __new:true,
      name:'',
      type:'cocina',
      color:'#fb923c',
      icon:'🍳',
      is_active:true,
      sort_order:(stations.length||0)+1,
      _categories:[],
      _zonas:['*'],
    });
  }

  function openEdit(st) {
    setEditing({
      ...st,
      _categories:(stationCats[st.id]||[]).slice(),
      _zonas:(stationZonas[st.id]||[]).slice(),
    });
  }

  async function saveStation() {
    if(!editing.name.trim()) { toast('Falta el nombre', false); return; }
    if(!editing._categories.length) { toast('Asigná al menos una categoría', false); return; }
    if(!editing._zonas.length) { toast('Asigná al menos una zona (o "Todas")', false); return; }
    setSaving(true);
    try {
      let sid = editing.id;
      if (editing.__new) {
        const {data, error} = await db.from('kitchen_stations').insert({
          restaurant_id:RID,
          name:editing.name.trim(),
          type:editing.type,
          color:editing.color,
          icon:editing.icon,
          is_active:editing.is_active!==false,
          sort_order:editing.sort_order||0,
        }).select().single();
        if (error) throw error;
        sid = data.id;
      } else {
        const {error} = await db.from('kitchen_stations').update({
          name:editing.name.trim(),
          type:editing.type,
          color:editing.color,
          icon:editing.icon,
          is_active:editing.is_active!==false,
          sort_order:editing.sort_order||0,
        }).eq('id',sid);
        if (error) throw error;
      }
      // Reescribir categorías y zonas (delete+insert)
      await db.from('kitchen_station_categories').delete().eq('station_id',sid);
      if (editing._categories.length) {
        const rows = editing._categories.map(cid=>({station_id:sid,category_id:cid}));
        const {error:e1} = await db.from('kitchen_station_categories').insert(rows);
        if (e1) throw e1;
      }
      await db.from('kitchen_station_zonas').delete().eq('station_id',sid);
      if (editing._zonas.length) {
        const rows = editing._zonas.map(z=>({station_id:sid,zona:z}));
        const {error:e2} = await db.from('kitchen_station_zonas').insert(rows);
        if (e2) throw e2;
      }
      toast(editing.__new?'Estación creada':'Estación actualizada');
      setEditing(null);
      loadStations();
    } catch(e) { toast('Error: '+e.message,false); }
    setSaving(false);
  }

  async function deleteStation(st) {
    const {error} = await db.from('kitchen_stations').delete().eq('id',st.id);
    if (error) { toast('Error: '+error.message,false); return; }
    toast('Estación eliminada');
    setConfirmDel(null);
    loadStations();
  }

  async function toggleActive(st) {
    const {error} = await db.from('kitchen_stations').update({is_active:!st.is_active}).eq('id',st.id);
    if (error) { toast('Error: '+error.message,false); return; }
    toast(!st.is_active?'Activada':'Desactivada');
    loadStations();
  }

  function copyLink(st) {
    const url = `${window.location.origin}${window.location.pathname.replace(/admin\.html$/,'')}cocina.html?station=${st.access_token}`;
    navigator.clipboard?.writeText(url).then(()=>toast('Link copiado al portapapeles'),()=>toast('No se pudo copiar',false));
  }

  function regenToken(st) {
    const newToken = Array.from(crypto.getRandomValues(new Uint8Array(12))).map(b=>b.toString(16).padStart(2,'0')).join('');
    db.from('kitchen_stations').update({access_token:newToken}).eq('id',st.id)
      .then(({error})=>{ if(error) toast('Error: '+error.message,false); else { toast('Token regenerado — los links viejos dejaron de funcionar'); loadStations(); } });
  }

  if (loading) return <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:300,gap:12}}><span className="spin"/><span style={{fontSize:13,color:C.dim}}>Cargando estaciones…</span></div>;

  const TabBtn = ({id,label}) => (
    <button onClick={()=>setTab(id)} style={{padding:'6px 14px',borderRadius:6,border:'none',fontFamily:'inherit',fontSize:12,fontWeight:600,cursor:'pointer',background:tab===id?C.white:'transparent',color:tab===id?C.ink:C.mid,transition:'all .15s'}}>{label}</button>
  );

  return (
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
        <div>
          <h1 style={{fontSize:22,fontWeight:800,color:C.ink}}>Estaciones de despacho</h1>
          <div style={{fontSize:12,color:C.mid,marginTop:4}}>Cocinas, bares y cafeterías con su pantalla y zonas asignadas</div>
        </div>
        <div style={{display:'flex',gap:8}}>
          <Btn variant="secondary" onClick={loadStations}>↺ Actualizar</Btn>
          {tab==='lista' && <Btn onClick={openNew}>+ Nueva estación</Btn>}
        </div>
      </div>

      <div style={{display:'inline-flex',gap:0,background:'var(--bg-subtle)',padding:3,borderRadius:8,marginBottom:18}}>
        <TabBtn id="lista" label="Estaciones"/>
        <TabBtn id="stats" label="Estadísticas"/>
        <TabBtn id="audit" label="Auditoría"/>
      </div>

      {tab==='lista' && (
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(340px,1fr))',gap:14}}>
          {stations.length===0 && (
            <div style={{gridColumn:'1/-1',background:C.surface,border:`1px dashed ${C.border}`,padding:40,textAlign:'center',borderRadius:8,color:C.mid}}>
              No hay estaciones aún. Hacé clic en "+ Nueva estación" para empezar.
            </div>
          )}
          {stations.map(st => {
            const typ = STATION_TYPES.find(t=>t.key===st.type) || STATION_TYPES[0];
            const cats = stationCats[st.id]||[];
            const zns  = stationZonas[st.id]||[];
            const stStat = stats.find(s=>s.station_id===st.id);
            return (
              <div key={st.id} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:16,opacity:st.is_active?1:0.55}}>
                <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}>
                  <div style={{width:38,height:38,borderRadius:8,background:st.color+'22',border:`1px solid ${st.color}55`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18}}>{st.icon||typ.icon}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:14,fontWeight:700,color:C.ink,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{st.name}</div>
                    <div style={{fontSize:11,color:C.mid,marginTop:2}}>
                      <span style={{display:'inline-block',padding:'1px 6px',background:st.color+'22',color:st.color,borderRadius:4,fontWeight:600,marginRight:6}}>{typ.label}</span>
                      {!st.is_active && <span style={{color:C.red,fontWeight:700}}>· inactiva</span>}
                    </div>
                  </div>
                </div>

                <div style={{display:'flex',gap:8,fontSize:11,marginBottom:10}}>
                  <div style={{flex:1,background:C.bg,padding:'6px 8px',borderRadius:5,textAlign:'center'}}>
                    <div style={{color:C.mid,fontSize:9,fontWeight:700,letterSpacing:0.5,textTransform:'uppercase'}}>Categorías</div>
                    <div style={{fontSize:14,fontWeight:700}}>{cats.length}</div>
                  </div>
                  <div style={{flex:1,background:C.bg,padding:'6px 8px',borderRadius:5,textAlign:'center'}}>
                    <div style={{color:C.mid,fontSize:9,fontWeight:700,letterSpacing:0.5,textTransform:'uppercase'}}>Zonas</div>
                    <div style={{fontSize:14,fontWeight:700}}>{zns.includes('*')?'Todas':zns.length}</div>
                  </div>
                  <div style={{flex:1,background:C.bg,padding:'6px 8px',borderRadius:5,textAlign:'center'}}>
                    <div style={{color:C.mid,fontSize:9,fontWeight:700,letterSpacing:0.5,textTransform:'uppercase'}}>Hoy</div>
                    <div style={{fontSize:14,fontWeight:700,color:C.ink}}>{stStat?.items_ready_today||0}</div>
                  </div>
                </div>

                <div style={{display:'flex',gap:6,alignItems:'center',background:C.bg,padding:'6px 8px',borderRadius:6,marginBottom:10,fontSize:11,color:C.mid,fontFamily:"'SF Mono',ui-monospace,monospace"}}>
                  <span style={{flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>cocina.html?station={st.access_token.slice(0,8)}…</span>
                  <button onClick={()=>copyLink(st)} title="Copiar link" style={{background:C.ink,color:C.sidebar,border:'none',padding:'3px 8px',borderRadius:4,fontSize:10,fontWeight:700,cursor:'pointer'}}>Copiar</button>
                </div>

                <div style={{display:'flex',gap:6}}>
                  <Btn small variant="secondary" onClick={()=>openEdit(st)} style={{flex:1}}>Editar</Btn>
                  <Btn small variant="secondary" onClick={()=>toggleActive(st)} style={{flex:1}}>{st.is_active?'Desactivar':'Activar'}</Btn>
                  <Btn small variant="danger" onClick={()=>setConfirmDel(st)}>Eliminar</Btn>
                </div>
                <div style={{textAlign:'right',marginTop:6}}>
                  <button onClick={()=>regenToken(st)} style={{background:'none',border:'none',color:C.mid,fontSize:10,cursor:'pointer',textDecoration:'underline'}}>Regenerar token</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab==='stats' && <EstacionesStats stations={stations} stats={stats}/>}
      {tab==='audit' && <EstacionesAudit stations={stations}/>}

      {editing && (
        <Modal title={editing.__new?'Nueva estación':'Editar estación'} onClose={()=>setEditing(null)} width={560}>
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            <div style={{display:'flex',gap:10}}>
              <div style={{flex:2}}>
                <Lbl>Nombre</Lbl>
                <Inp value={editing.name} onChange={e=>setEditing({...editing,name:e.target.value})} placeholder="Ej: Bar Terraza Planta Alta" style={{border:`1px solid ${C.border}`,background:C.surface}}/>
              </div>
              <div style={{flex:1}}>
                <Lbl>Tipo</Lbl>
                <Sel value={editing.type} onChange={e=>{const t=STATION_TYPES.find(x=>x.key===e.target.value);setEditing({...editing,type:e.target.value, color:t?.color||editing.color, icon:t?.icon||editing.icon});}} style={{border:`1px solid ${C.border}`,background:C.surface}}>
                  {STATION_TYPES.map(t=><option key={t.key} value={t.key}>{t.label}</option>)}
                </Sel>
              </div>
            </div>

            <div>
              <Lbl>Ícono</Lbl>
              <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
                {STATION_ICONS.map(ic=>(
                  <button key={ic} onClick={()=>setEditing({...editing,icon:ic})} style={{width:34,height:34,fontSize:18,border:`1px solid ${editing.icon===ic?C.ink:C.border}`,background:editing.icon===ic?C.ink:C.surface,borderRadius:6,cursor:'pointer'}}>{ic}</button>
                ))}
              </div>
            </div>

            <div>
              <Lbl>Color</Lbl>
              <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                {STATION_COLORS.map(c=>(
                  <button key={c} onClick={()=>setEditing({...editing,color:c})} style={{width:30,height:30,background:c,border:`2px solid ${editing.color===c?'#000':'transparent'}`,borderRadius:6,cursor:'pointer'}}/>
                ))}
              </div>
            </div>

            <div>
              <Lbl>Categorías que recibe ({editing._categories.length}/{categories.length})</Lbl>
              <div style={{maxHeight:160,overflowY:'auto',border:`1px solid ${C.border}`,borderRadius:6,padding:8,background:C.surface,display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(140px,1fr))',gap:4}}>
                {categories.map(cat=>{
                  const checked = editing._categories.includes(cat.id);
                  return (
                    <label key={cat.id} style={{display:'flex',alignItems:'center',gap:6,padding:'4px 6px',cursor:'pointer',background:checked?C.ink:'transparent',color:checked?C.surface:C.ink,borderRadius:4,fontSize:12}}>
                      <input type="checkbox" checked={checked} onChange={()=>{
                        const next = checked ? editing._categories.filter(x=>x!==cat.id) : [...editing._categories,cat.id];
                        setEditing({...editing,_categories:next});
                      }} style={{margin:0}}/>
                      <span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{cat.name}</span>
                    </label>
                  );
                })}
                {categories.length===0 && <div style={{color:C.mid,fontSize:12,padding:8}}>No hay categorías en el menú</div>}
              </div>
              <div style={{display:'flex',gap:6,marginTop:6}}>
                <button onClick={()=>setEditing({...editing,_categories:categories.map(c=>c.id)})} style={{background:'none',border:`1px solid ${C.border}`,padding:'3px 8px',fontSize:11,borderRadius:4,cursor:'pointer'}}>Seleccionar todas</button>
                <button onClick={()=>setEditing({...editing,_categories:[]})} style={{background:'none',border:`1px solid ${C.border}`,padding:'3px 8px',fontSize:11,borderRadius:4,cursor:'pointer'}}>Limpiar</button>
              </div>
            </div>

            <div>
              <Lbl>Zonas del salón que atiende</Lbl>
              <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                {[{z:'*',label:'★ Todas las zonas'},...zonasFromTables.map(z=>({z,label:z}))].map(({z,label})=>{
                  const checked = editing._zonas.includes(z);
                  return (
                    <button key={z} onClick={()=>{
                      let next;
                      if (z==='*') next = checked ? [] : ['*'];
                      else next = checked ? editing._zonas.filter(x=>x!==z) : [...editing._zonas.filter(x=>x!=='*'),z];
                      setEditing({...editing,_zonas:next});
                    }} style={{padding:'5px 10px',border:`1px solid ${checked?C.ink:C.border}`,background:checked?C.ink:C.surface,color:checked?C.surface:C.ink,borderRadius:5,fontSize:12,fontWeight:600,cursor:'pointer',textTransform:'capitalize'}}>{label}</button>
                  );
                })}
              </div>
              <div style={{fontSize:10,color:C.mid,marginTop:6}}>Si el pedido viene de una mesa cuya zona no está asignada a esta estación, no aparecerá en su pantalla. "Todas las zonas" actúa como comodín.</div>
            </div>

            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <input type="checkbox" id="st_active" checked={editing.is_active!==false} onChange={e=>setEditing({...editing,is_active:e.target.checked})}/>
              <label htmlFor="st_active" style={{fontSize:13,cursor:'pointer'}}>Estación activa (recibe pedidos)</label>
            </div>

            <div style={{display:'flex',gap:8,marginTop:8,justifyContent:'flex-end'}}>
              <Btn variant="ghost" onClick={()=>setEditing(null)}>Cancelar</Btn>
              <Btn onClick={saveStation} disabled={saving}>{saving?'Guardando…':(editing.__new?'Crear estación':'Guardar cambios')}</Btn>
            </div>
          </div>
        </Modal>
      )}

      {confirmDel && (
        <Modal title="Eliminar estación" onClose={()=>setConfirmDel(null)}>
          <div style={{fontSize:13,marginBottom:16,color:C.ink}}>¿Eliminar "<b>{confirmDel.name}</b>"? Las pantallas con su link dejarán de funcionar. El historial de auditoría se conserva.</div>
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <Btn variant="ghost" onClick={()=>setConfirmDel(null)}>Cancelar</Btn>
            <Btn variant="danger" onClick={()=>deleteStation(confirmDel)}>Eliminar</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

function EstacionesStats({stations, stats}) {
  return (
    <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
      <table style={{width:'100%',borderCollapse:'collapse'}}>
        <thead style={{background:C.bg}}>
          <tr>
            <Th>Estación</Th>
            <Th right>Hoy</Th>
            <Th right>7 días</Th>
            <Th right>Total despachado</Th>
            <Th right>En cocina (acum.)</Th>
            <Th right>Entregados (acum.)</Th>
          </tr>
        </thead>
        <tbody>
          {stations.length===0 && <EmptyRow cols={6} label="Sin estaciones"/>}
          {stations.map(st=>{
            const s = stats.find(x=>x.station_id===st.id) || {};
            return (
              <tr key={st.id} style={{borderTop:`1px solid ${C.border}`}}>
                <Td><span style={{display:'inline-flex',alignItems:'center',gap:8}}><span style={{width:8,height:8,background:st.color,borderRadius:'50%'}}/>{st.icon} {st.name}</span></Td>
                <Td right mono>{s.items_ready_today||0}</Td>
                <Td right mono>{s.items_ready_week||0}</Td>
                <Td right mono>{s.items_ready_total||0}</Td>
                <Td right mono dim>{s.items_cooking_total||0}</Td>
                <Td right mono dim>{s.items_delivered_total||0}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EstacionesAudit({stations}) {
  const [logs, setLogs] = useState([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);

  useEffect(()=>{
    if (!db) return;
    setLoading(true);
    let q = db.from('order_item_station_log').select('*').order('created_at',{ascending:false}).limit(200);
    if (filter!=='all') q = q.eq('station_id', filter);
    q.then(({data})=>{ setLogs(data||[]); setLoading(false); });
  },[filter]);

  const actionColor = a => ({received:'#60a5fa',cooking:'#fb923c',ready:'#34C759',delivered:'#6E6E73'}[a]||C.mid);
  const actionLabel = a => ({received:'Recibido',cooking:'En preparación',ready:'Listo',delivered:'Entregado'}[a]||a);

  return (
    <div>
      <div style={{marginBottom:12,display:'flex',gap:8,alignItems:'center'}}>
        <span style={{fontSize:12,color:C.mid}}>Filtrar:</span>
        <Sel value={filter} onChange={e=>setFilter(e.target.value)} style={{maxWidth:240,border:`1px solid ${C.border}`,background:C.surface}}>
          <option value="all">Todas las estaciones</option>
          {stations.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
        </Sel>
      </div>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead style={{background:C.bg}}>
            <tr>
              <Th>Cuándo</Th>
              <Th>Estación</Th>
              <Th>Acción</Th>
              <Th>Usuario</Th>
              <Th>Order item</Th>
            </tr>
          </thead>
          <tbody>
            {loading && <EmptyRow cols={5} label="Cargando…"/>}
            {!loading && logs.length===0 && <EmptyRow cols={5} label="Sin registros aún"/>}
            {!loading && logs.map(l=>{
              const st = stations.find(s=>s.id===l.station_id);
              const ts = new Date(l.created_at);
              return (
                <tr key={l.id} style={{borderTop:`1px solid ${C.border}`}}>
                  <Td dim mono>{ts.toLocaleString('es-PY',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</Td>
                  <Td>{st ? <span><span style={{display:'inline-block',width:6,height:6,background:st.color,borderRadius:'50%',marginRight:6}}/>{st.icon} {st.station_name||st.name}</span> : <span style={{color:C.mid}}>{l.station_name||'—'}</span>}</Td>
                  <Td><span style={{display:'inline-block',padding:'2px 8px',background:actionColor(l.action)+'22',color:actionColor(l.action),borderRadius:4,fontSize:11,fontWeight:700}}>{actionLabel(l.action)}</span></Td>
                  <Td>{l.user_name || <span style={{color:C.mid}}>—</span>}</Td>
                  <Td mono dim>{(l.order_item_id||'').slice(0,8)}…</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   CONFIG
══════════════════════════════════════════════ */
// Horario estructurado (mig 125). Semana en orden lunes-primero (índices 0=Dom…6=Sáb).
const WEEK_DAYS = [{i:1,l:'Lunes'},{i:2,l:'Martes'},{i:3,l:'Miércoles'},{i:4,l:'Jueves'},{i:5,l:'Viernes'},{i:6,l:'Sábado'},{i:0,l:'Domingo'}];
const _DOW_FULL  = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
const _DOW_SHORT = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
// Deriva el texto display (lista {day,hours}) desde el horario estructurado,
// agrupando días consecutivos (lun-primero) con el mismo horario → "Lun–Vie 12:00–23:00".
function deriveHoursDisplay(bh){
  const order=[1,2,3,4,5,6,0];
  const dayStr=(d)=>{ const rs=Array.isArray(bh[String(d)])?bh[String(d)]:[]; if(!rs.length) return null; return rs.filter(r=>r.start&&r.end).map(r=>`${r.start}–${r.end}`).join(' · ')||null; };
  const out=[]; let i=0;
  while(i<order.length){
    const s=dayStr(order[i]);
    if(s==null){ i++; continue; }
    let j=i; while(j+1<order.length && dayStr(order[j+1])===s) j++;
    out.push({day: i===j?_DOW_FULL[order[i]]:`${_DOW_SHORT[order[i]]}–${_DOW_SHORT[order[j]]}`, hours:s});
    i=j+1;
  }
  return out;
}
// Limpia el horario estructurado: descarta rangos sin start/end y días vacíos.
function cleanBusinessHours(bhDays){
  const clean={};
  for(let d=0; d<7; d++){
    const rs=Array.isArray(bhDays[String(d)])?bhDays[String(d)].filter(r=>r.start&&r.end):[];
    if(rs.length) clean[String(d)]=rs.map(r=>({start:r.start,end:r.end}));
  }
  return clean;
}

function ConfigPage({restaurant,onRefresh}) {
  const [form,setForm] = useState({});
  const [bhDays,setBhDays] = useState({});            // { '0':[{start,end}], … } (mig 125)
  const [openOverride,setOpenOverride] = useState('auto'); // 'auto' | 'open' | 'closed'
  const [saving,setSaving] = useState(false);
  const [savingH,setSavingH] = useState(false);
  const [savingHH,setSavingHH] = useState(false);
  const [savingBank,setSavingBank] = useState(false);
  const [savingPm,setSavingPm] = useState(false);
  const [pmForm,setPmForm] = useState(null);   // métodos de pago habilitados (mig 181)
  const [savingDc,setSavingDc] = useState(false);
  const [dcForm,setDcForm] = useState(null);   // política de cobro/validación/preparación (mig 182)
  const [tab,setTab] = useState('general');   // general (config del local) | cuenta (Mi cuenta, consolidada desde el nav)

  useEffect(()=>{
    if(restaurant){
      setForm(restaurant);
      setPmForm(restaurant.payment_methods||null);
      setDcForm(restaurant.delivery_config||null);
      const bh=(restaurant.business_hours && typeof restaurant.business_hours==='object')?restaurant.business_hours:{};
      const norm={}; for(let d=0; d<7; d++){ const r=bh[String(d)]; norm[String(d)]=Array.isArray(r)?r.map(x=>({start:x.start||'',end:x.end||''})):[]; }
      setBhDays(norm);
      setOpenOverride(restaurant.open_override || 'auto');
    }
  },[restaurant]);

  const addRange    = (d)=>setBhDays(p=>({...p,[d]:[...(p[d]||[]),{start:'12:00',end:'23:00'}]}));
  const removeRange = (d,idx)=>setBhDays(p=>({...p,[d]:(p[d]||[]).filter((_,j)=>j!==idx)}));
  const setRange    = (d,idx,field,val)=>setBhDays(p=>({...p,[d]:(p[d]||[]).map((r,j)=>j===idx?{...r,[field]:val}:r)}));

  async function save(){
    if(!db)return;setSaving(true);
    const upd={name:form.name,address:form.address,phone:form.phone,instagram:form.instagram,website:form.website,logo_initials:form.logo_initials||null,cover_image_url:form.cover_image_url||null,logo_url:form.logo_url||null};
    const{data,error}=await db.from('restaurants').update(upd).eq('id',RID).select('id');
    if(error){toast('Error: '+error.message,false);}
    else if(!data||data.length===0){toast('No se pudo guardar — verificá RLS en Supabase',false);}
    else{toast('Cambios guardados — se reflejan en la app al refrescar');onRefresh();}
    setSaving(false);
  }
  async function saveHours(){
    if(!db)return;setSavingH(true);
    const clean=cleanBusinessHours(bhDays);
    const display=deriveHoursDisplay(clean);
    const upd={business_hours:clean, opening_hours:display, open_override:openOverride};
    const{data,error}=await db.from('restaurants').update(upd).eq('id',RID).select('id');
    if(error){toast('Error al guardar horarios: '+error.message+' — ¿está aplicada la migración 125?',false);}
    else if(!data||data.length===0){toast('No se pudo guardar los horarios — verificá RLS en Supabase',false);}
    else{toast('Horarios guardados');onRefresh();}
    setSavingH(false);
  }
  async function saveHalfRule(){
    if(!db)return;setSavingHH(true);
    const rule=form.half_and_half_rule||'max';
    const fixed=rule==='fixed'?(parseInt(form.half_and_half_fixed_price)||0):null;
    if(rule==='fixed'&&!(fixed>0)){toast('Ingresá el precio fijo de la pizza mitad-y-mitad',false);setSavingHH(false);return;}
    const{data,error}=await db.from('restaurants').update({half_and_half_rule:rule,half_and_half_fixed_price:fixed}).eq('id',RID).select('id');
    if(error){toast('Error: '+error.message+' — ¿está aplicada la migración 170?',false);}
    else if(!data||data.length===0){toast('No se pudo guardar — verificá RLS',false);}
    else{toast('Regla de mitad-y-mitad guardada');onRefresh();}
    setSavingHH(false);
  }
  // Datos de transferencia del comercio (mig 180): los muestran caja/mozo al cobrar por QR/transferencia.
  async function saveBank(){
    if(!db)return;setSavingBank(true);
    const upd={
      bank_holder:form.bank_holder||null, bank_name:form.bank_name||null,
      bank_account:form.bank_account||null, bank_alias:form.bank_alias||null,
      bank_doc:form.bank_doc||null, bank_qr_url:form.bank_qr_url||null,
    };
    const{data,error}=await db.from('restaurants').update(upd).eq('id',RID).select('id');
    if(error){toast('Error: '+error.message+' — ¿está aplicada la migración 180?',false);}
    else if(!data||data.length===0){toast('No se pudo guardar — verificá RLS',false);}
    else{toast('Datos de transferencia guardados');onRefresh();}
    setSavingBank(false);
  }
  // Métodos de pago que ve el cliente en el menú QR (mig 181). Normaliza a objeto explícito.
  async function savePaymentMethods(){
    if(!db)return;setSavingPm(true);
    const cfg={efectivo:true,tarjeta:true,qr:true,pos:true,...(pmForm||{})};
    const{data,error}=await db.from('restaurants').update({payment_methods:cfg}).eq('id',RID).select('id');
    if(error){toast('Error: '+error.message+' — ¿está aplicada la migración 181?',false);}
    else if(!data||data.length===0){toast('No se pudo guardar — verificá RLS',false);}
    else{toast('Métodos de pago guardados');onRefresh();}
    setSavingPm(false);
  }
  // Política de cobro/validación/preparación (mig 182 · FASE D2 · Módulos 4/5/9).
  async function saveDeliveryConfig(){
    if(!db)return;setSavingDc(true);
    const cur=dcForm||{};
    const cfg={
      require_proof: cur.require_proof===true,
      prep_policy: ['A','B','C'].includes(cur.prep_policy)?cur.prep_policy:'A',
      prep_threshold: Math.max(0, parseInt(cur.prep_threshold)||0),
      frequent_min_orders: Math.max(0, parseInt(cur.frequent_min_orders)||0),
    };
    const{data,error}=await db.from('restaurants').update({delivery_config:cfg}).eq('id',RID).select('id');
    if(error){toast('Error: '+error.message+' — ¿está aplicada la migración 182?',false);}
    else if(!data||data.length===0){toast('No se pudo guardar — verificá RLS',false);}
    else{toast('Política de cobro guardada');setDcForm(cfg);onRefresh();}
    setSavingDc(false);
  }

  const INFO_FIELDS=[{key:'name',label:'Nombre del restaurante'},{key:'address',label:'Dirección'},{key:'phone',label:'Teléfono'},{key:'instagram',label:'Instagram',ph:'@turestaurante'},{key:'website',label:'Sitio web',ph:'turestaurante.com.py'}];

  return (
    <div className="page">
      <h1 style={{fontSize:22,fontWeight:800,color:C.ink,marginBottom:20}}>Configuración</h1>

      {/* Sub-pestañas: configuración del local + Mi cuenta (consolidada desde el nav de nivel superior) */}
      <div style={{display:'inline-flex',background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:2,marginBottom:20}}>
        {[['general','General'],['cuenta','Mi cuenta']].map(([v,l])=>(
          <button key={v} onClick={()=>setTab(v)}
            style={{padding:'6px 16px',fontSize:13,fontWeight:700,border:'none',borderRadius:6,cursor:'pointer',
              background:tab===v?C.ink:'transparent',color:tab===v?C.sidebar:C.mid}}>{l}</button>
        ))}
      </div>

      {tab==='cuenta' && <MiCuentaPage restaurant={restaurant} onRefresh={onRefresh} embedded/>}

      {tab==='general' && (
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,maxWidth:860}}>

        {/* ── Columna izquierda: info + imágenes ── */}
        <div style={{display:'flex',flexDirection:'column',gap:14}}>

          {/* Portada */}
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:22}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:14}}>PORTADA DEL RESTAURANTE</div>
            <ImageUploader
              value={form.cover_image_url||''}
              onChange={url=>setForm({...form,cover_image_url:url})}
              bucket="restaurant-images"
            />
            <div style={{fontSize:10,color:C.dim,marginTop:8}}>Aparece en la pantalla de bienvenida de los clientes. Recomendado: imagen horizontal 1200×600 px.</div>
          </div>

          {/* Logo */}
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:22}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:14}}>LOGO O FOTO DE PERFIL</div>
            <div style={{display:'flex',gap:14,alignItems:'flex-start'}}>
              <div style={{flexShrink:0}}>
                {form.logo_url
                  ? <div style={{position:'relative',width:72,height:72}}>
                      <img src={form.logo_url} alt="" style={{width:72,height:72,objectFit:'cover',borderRadius:'50%',border:`2px solid ${C.bs}`}} onError={e=>{e.target.style.display='none';}}/>
                      <button onClick={()=>setForm({...form,logo_url:''})} title="Eliminar logo" style={{position:'absolute',top:-4,right:-4,width:18,height:18,borderRadius:'50%',background:'#FF3B30',border:'none',color:'#fff',fontSize:10,lineHeight:'18px',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700}}>✕</button>
                    </div>
                  : <div style={{width:72,height:72,borderRadius:'50%',background:C.white,border:`2px dashed ${C.border}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:22,color:C.dim}}>
                      {form.logo_initials||'?'}
                    </div>}
              </div>
              <div style={{flex:1}}>
                <ImageUploader
                  compact
                  value={form.logo_url||''}
                  onChange={url=>setForm({...form,logo_url:url})}
                  bucket="restaurant-images"
                />
                <div style={{marginTop:10}}>
                  <Lbl>INICIALES (fallback si no hay logo)</Lbl>
                  <Inp value={form.logo_initials||''} onChange={e=>setForm({...form,logo_initials:e.target.value})} placeholder="LH" style={{width:64}}/>
                </div>
              </div>
            </div>
          </div>

          {/* Info básica */}
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:22}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:14}}>INFO DEL RESTAURANTE</div>
            <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:16}}>
              {INFO_FIELDS.map(f=>(
                <div key={f.key}><Lbl>{f.label.toUpperCase()}</Lbl><Inp value={form[f.key]||''} onChange={e=>setForm({...form,[f.key]:e.target.value})} placeholder={f.ph||f.label}/></div>
              ))}
            </div>
            <Btn onClick={save} disabled={saving}>{saving?'Guardando…':'Guardar cambios'}</Btn>
          </div>

          {/* Métodos de pago que ve el cliente en el menú QR — mig 181 (FASE D2 · Módulo 1) */}
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:22}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:4}}>MÉTODOS DE PAGO (CLIENTE QR)</div>
            <div style={{fontSize:11,color:C.dim,marginBottom:14,lineHeight:1.5}}>Elegí qué medios ve el cliente al pagar desde el menú QR. Los que apagues no aparecen. Los datos de "QR / Transferencia" se cargan en la tarjeta de abajo.</div>
            <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:14}}>
              {[['efectivo','Efectivo','Se cobra en mesa o caja'],['tarjeta','Tarjeta','Visa · Mastercard · Amex (POS)'],['qr','QR / Transferencia','Muestra tus datos + QR de transferencia'],['pos','POS en mesa','El mozo lleva la terminal a la mesa']].map(([id,label,sub])=>{
                const on = !pmForm || pmForm[id] !== false;
                return (
                  <div key={id} onClick={()=>setPmForm(p=>({efectivo:true,tarjeta:true,qr:true,pos:true,...(p||{}),[id]:!on}))} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 12px',border:`1px solid ${C.border}`,borderRadius:9,cursor:'pointer',background:on?'transparent':C.bg}}>
                    <div>
                      <div style={{fontSize:13,fontWeight:700,color:on?C.ink:C.mid}}>{label}</div>
                      <div style={{fontSize:11,color:C.dim,marginTop:1}}>{sub}</div>
                    </div>
                    <div style={{width:42,height:24,borderRadius:12,background:on?C.green:C.border,position:'relative',flexShrink:0,transition:'background .2s'}}>
                      <div style={{position:'absolute',top:2,left:on?'20px':'2px',width:20,height:20,borderRadius:'50%',background:'#fff',transition:'left .2s',boxShadow:'0 1px 4px rgba(0,0,0,0.25)'}}/>
                    </div>
                  </div>
                );
              })}
            </div>
            <Btn onClick={savePaymentMethods} disabled={savingPm}>{savingPm?'Guardando…':'Guardar métodos de pago'}</Btn>
          </div>

          {/* Datos para transferencias (cobro) — mig 180 */}
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:22}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:4}}>DATOS PARA TRANSFERENCIAS (COBRO)</div>
            <div style={{fontSize:11,color:C.dim,marginBottom:14,lineHeight:1.5}}>Caja y mozo muestran estos datos cuando el cliente paga por transferencia / QR. Si cargás el QR de tu cuenta, el cliente puede escanearlo y transferir el monto directo.</div>
            <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:14}}>
              <div><Lbl>TITULAR DE LA CUENTA</Lbl><Inp value={form.bank_holder||''} onChange={e=>setForm({...form,bank_holder:e.target.value})} placeholder="Nombre del titular"/></div>
              <div><Lbl>BANCO / ENTIDAD</Lbl><Inp value={form.bank_name||''} onChange={e=>setForm({...form,bank_name:e.target.value})} placeholder="Ueno, Itaú, Familiar…"/></div>
              <div><Lbl>N° DE CUENTA</Lbl><Inp value={form.bank_account||''} onChange={e=>setForm({...form,bank_account:e.target.value})} placeholder="Número de cuenta"/></div>
              <div><Lbl>ALIAS</Lbl><Inp value={form.bank_alias||''} onChange={e=>setForm({...form,bank_alias:e.target.value})} placeholder="Alias de transferencia"/></div>
              <div><Lbl>CI / RUC DEL TITULAR</Lbl><Inp value={form.bank_doc||''} onChange={e=>setForm({...form,bank_doc:e.target.value})} placeholder="CI o RUC"/></div>
            </div>
            <Lbl>QR DE LA CUENTA (OPCIONAL)</Lbl>
            <div style={{display:'flex',gap:14,alignItems:'flex-start',marginBottom:14}}>
              <div style={{flexShrink:0}}>
                {form.bank_qr_url
                  ? <div style={{position:'relative',width:96,height:96}}>
                      <img src={form.bank_qr_url} alt="QR" style={{width:96,height:96,objectFit:'contain',borderRadius:8,border:`1px solid ${C.border}`,background:'#fff'}} onError={e=>{e.target.style.display='none';}}/>
                      <button onClick={()=>setForm({...form,bank_qr_url:''})} title="Quitar QR" style={{position:'absolute',top:-6,right:-6,width:18,height:18,borderRadius:'50%',background:'#FF3B30',border:'none',color:'#fff',fontSize:10,cursor:'pointer',fontWeight:700}}>✕</button>
                    </div>
                  : <div style={{width:96,height:96,borderRadius:8,background:C.white,border:`2px dashed ${C.border}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,color:C.dim,textAlign:'center',padding:6}}>Sin QR</div>}
              </div>
              <div style={{flex:1}}>
                <ImageUploader compact value={form.bank_qr_url||''} onChange={url=>setForm({...form,bank_qr_url:url})} bucket="restaurant-images"/>
                <div style={{fontSize:10,color:C.dim,marginTop:8}}>Subí la imagen del QR de tu cuenta bancaria (captura del app del banco).</div>
              </div>
            </div>
            <Btn onClick={saveBank} disabled={savingBank}>{savingBank?'Guardando…':'Guardar datos de transferencia'}</Btn>
          </div>

          {/* Política de cobro / validación / preparación — mig 182 (FASE D2 · Módulos 4/5/9) */}
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:22}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:4}}>POLÍTICA DE COBRO Y VALIDACIÓN</div>
            <div style={{fontSize:11,color:C.dim,marginBottom:14,lineHeight:1.5}}>Cómo maneja tu local los pagos por transferencia: si exigís comprobante y cuándo se empieza a preparar el pedido. Mythos nunca decide por vos — lo configurás acá.</div>

            {/* Exigir comprobante */}
            {(()=>{const on=!!(dcForm&&dcForm.require_proof);return(
              <div onClick={()=>setDcForm(p=>({...(p||{}),require_proof:!on}))} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 12px',border:`1px solid ${C.border}`,borderRadius:9,cursor:'pointer',marginBottom:14,background:on?'transparent':C.bg}}>
                <div>
                  <div style={{fontSize:13,fontWeight:700,color:on?C.ink:C.mid}}>Exigir comprobante en transferencia/QR</div>
                  <div style={{fontSize:11,color:C.dim,marginTop:1}}>Caja/mozo deben cargar el N° o la foto del comprobante para cobrar.</div>
                </div>
                <div style={{width:42,height:24,borderRadius:12,background:on?C.green:C.border,position:'relative',flexShrink:0,transition:'background .2s'}}>
                  <div style={{position:'absolute',top:2,left:on?'20px':'2px',width:20,height:20,borderRadius:'50%',background:'#fff',transition:'left .2s',boxShadow:'0 1px 4px rgba(0,0,0,0.25)'}}/>
                </div>
              </div>
            );})()}

            {/* Política de inicio de preparación A/B/C */}
            <div style={{fontSize:11,color:C.mid,fontWeight:700,letterSpacing:0.5,marginBottom:8}}>¿CUÁNDO SE EMPIEZA A PREPARAR?</div>
            <div style={{display:'flex',flexDirection:'column',gap:8,marginBottom:14}}>
              {[
                ['A','Preparar apenas entra','No espera la validación del pago (lo más rápido).'],
                ['B','Esperar validación del pago','El pedido queda "esperando validación" hasta que caja/admin apruebe el comprobante.'],
                ['C','Inteligente','Prepara ya, salvo montos altos o clientes nuevos (definís los umbrales abajo).'],
              ].map(([id,label,sub])=>{
                const sel=((dcForm&&dcForm.prep_policy)||'A')===id;
                return(
                  <div key={id} onClick={()=>setDcForm(p=>({...(p||{}),prep_policy:id}))} style={{display:'flex',gap:10,alignItems:'flex-start',padding:'10px 12px',border:`1px solid ${sel?C.green:C.border}`,borderRadius:9,cursor:'pointer',background:sel?'rgba(52,199,89,0.06)':'transparent'}}>
                    <div style={{width:18,height:18,borderRadius:'50%',border:`2px solid ${sel?C.green:C.border}`,flexShrink:0,marginTop:1,display:'flex',alignItems:'center',justifyContent:'center'}}>{sel&&<div style={{width:9,height:9,borderRadius:'50%',background:C.green}}/>}</div>
                    <div>
                      <div style={{fontSize:13,fontWeight:700,color:C.ink}}>{label}</div>
                      <div style={{fontSize:11,color:C.dim,marginTop:1,lineHeight:1.4}}>{sub}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Umbrales del modo inteligente (solo C) */}
            {((dcForm&&dcForm.prep_policy)||'A')==='C' && (
              <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:14,paddingLeft:12,borderLeft:`2px solid ${C.border}`}}>
                <div>
                  <Lbl>PREPARAR SIN ESPERAR SI EL TOTAL ES MENOR A (₲)</Lbl>
                  <GsInput value={(dcForm&&dcForm.prep_threshold)||''} onChange={v=>setDcForm(p=>({...(p||{}),prep_threshold:v}))} placeholder="0 = siempre esperar validación"/>
                </div>
                <div>
                  <Lbl>CLIENTE FRECUENTE A PARTIR DE (N° DE PEDIDOS PREVIOS)</Lbl>
                  <NumInput value={(dcForm&&dcForm.frequent_min_orders)||''} onChange={v=>setDcForm(p=>({...(p||{}),frequent_min_orders:v}))} placeholder="Ej: 3 — a estos se les prepara ya"/>
                </div>
              </div>
            )}

            <Btn onClick={saveDeliveryConfig} disabled={savingDc}>{savingDc?'Guardando…':'Guardar política de cobro'}</Btn>
          </div>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:14}}>
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:22}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:4}}>ESTADO DEL LOCAL AHORA</div>
            <div style={{fontSize:11,color:C.dim,marginBottom:12,lineHeight:1.5}}>El modo manual <strong>gana</strong> sobre el horario (feriados, imprevistos). En "Automático" el cliente abre/cierra según el horario de abajo.</div>
            <div style={{display:'flex',gap:6,marginBottom:6}}>
              {[{v:'auto',l:'Automático',d:'Según horario'},{v:'open',l:'Abierto ahora',d:'Forzar abierto'},{v:'closed',l:'Cerrado ahora',d:'Forzar cerrado'}].map(o=>{
                const sel=openOverride===o.v;
                const clr=o.v==='closed'?'#FF3B30':o.v==='open'?C.green:C.ink;
                return (
                  <button key={o.v} onClick={()=>setOpenOverride(o.v)} style={{flex:1,textAlign:'center',padding:'10px 6px',border:`2px solid ${sel?clr:C.border}`,borderRadius:10,background:sel?'var(--bg-subtle)':'transparent',cursor:'pointer',transition:'all 150ms'}}>
                    <div style={{fontSize:12.5,fontWeight:800,color:sel?clr:C.mid}}>{o.l}</div>
                    <div style={{fontSize:10,color:C.dim,marginTop:2}}>{o.d}</div>
                  </button>
                );
              })}
            </div>
            <div style={{height:1,background:C.border,margin:'16px 0'}}/>

            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
              <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1}}>HORARIO POR DÍA</div>
            </div>
            <div style={{fontSize:11,color:C.dim,marginBottom:12,lineHeight:1.5}}>Cargá los rangos de cada día (admite turnos partidos). Si un turno cruza la medianoche, poné el fin menor al inicio (ej. 20:00 → 02:00). Un día sin rangos = cerrado.</div>
            <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:14}}>
              {WEEK_DAYS.map(({i,l})=>{
                const ranges=bhDays[String(i)]||[];
                return (
                  <div key={i} style={{borderBottom:`1px solid ${C.border}`,paddingBottom:10}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:ranges.length?8:0}}>
                      <span style={{fontSize:13,fontWeight:700,color:C.ink}}>{l}{ranges.length?'':<span style={{fontSize:11,fontWeight:600,color:C.dim,marginLeft:8}}>Cerrado</span>}</span>
                      <Btn small variant="secondary" onClick={()=>addRange(String(i))}>+ Rango</Btn>
                    </div>
                    {ranges.map((r,idx)=>(
                      <div key={idx} style={{display:'flex',gap:6,alignItems:'center',marginBottom:6}}>
                        <input type="time" value={r.start} onChange={e=>setRange(String(i),idx,'start',e.target.value)} style={{flex:1,padding:'7px 8px',fontSize:13,borderRadius:6,border:`1px solid ${C.border}`,color:C.ink,background:C.surface,outline:'none'}}/>
                        <span style={{fontSize:12,color:C.dim}}>a</span>
                        <input type="time" value={r.end} onChange={e=>setRange(String(i),idx,'end',e.target.value)} style={{flex:1,padding:'7px 8px',fontSize:13,borderRadius:6,border:`1px solid ${C.border}`,color:C.ink,background:C.surface,outline:'none'}}/>
                        <button onClick={()=>removeRange(String(i),idx)} style={{background:'none',border:`1px solid rgba(239,68,68,0.25)`,color:'rgba(239,68,68,0.7)',padding:'0 9px',height:32,borderRadius:6,cursor:'pointer',flexShrink:0}}>✕</button>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
            <Btn onClick={saveHours} disabled={savingH}>{savingH?'Guardando…':'Guardar horarios'}</Btn>
          </div>

          {/* Regla de precio mitad-y-mitad (default del local) */}
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:22}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:6}}>PIZZA MITAD Y MITAD</div>
            <div style={{fontSize:11,color:C.dim,marginBottom:14,lineHeight:1.5}}>Cuando una pizza combina dos sabores de distinto precio, ¿cuánto se cobra? Esta es la regla por defecto del local; cada producto puede usar otra al editarlo.</div>
            <div style={{display:'flex',flexDirection:'column',gap:12,marginBottom:14}}>
              <div>
                <Lbl>REGLA POR DEFECTO</Lbl>
                <Sel value={form.half_and_half_rule||'max'} onChange={e=>setForm({...form,half_and_half_rule:e.target.value})}>
                  <option value="max">Mitad más cara (recomendado)</option>
                  <option value="avg">Promedio de los dos</option>
                  <option value="fixed">Precio fijo</option>
                </Sel>
              </div>
              {form.half_and_half_rule==='fixed'&&(
                <div>
                  <Lbl>PRECIO FIJO (₲)</Lbl>
                  <MoneyInp value={form.half_and_half_fixed_price||''} onChange={v=>setForm({...form,half_and_half_fixed_price:v})} placeholder="45000"/>
                </div>
              )}
            </div>
            <Btn onClick={saveHalfRule} disabled={savingHH}>{savingHH?'Guardando…':'Guardar regla'}</Btn>
          </div>

          <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:14}}>
            <div style={{fontSize:9,color:C.dim,fontWeight:700,marginBottom:5,letterSpacing:1}}>RESTAURANT ID</div>
            <div style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:11,color:C.ink,wordBreak:'break-all'}}>{RID}</div>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════
   DELIVERY — status helpers
══════════════════════════════════════════════ */
const DLIV_LABEL = {pending:'Pendiente',confirmed:'Confirmado',picked_up:'Recogido',on_way:'En camino',delivered:'Entregado',cancelled:'Cancelado'};
const DLIV_COLOR = {pending:'#86868B',confirmed:'#1D1D1F',picked_up:'#003F80',on_way:'#000000',delivered:'#34C759',cancelled:'#FF3B30'};

function DelivBadge({status}) {
  const col = DLIV_COLOR[status]||'#86868B';
  // Tinte/borde/texto theme-adaptive (color-mix sobre tokens): los estados neutros
  // (confirmado #1D1D1F, en camino #000000) dejan de quedar negro-sobre-negro en oscuro.
  const fg = `color-mix(in srgb, ${col} 70%, var(--text-primary))`;
  return (
    <span style={{display:'inline-flex',alignItems:'center',gap:5,padding:'3px 8px',fontSize:11,fontWeight:700,background:`color-mix(in srgb, ${col} 15%, var(--surface))`,color:fg,border:`1px solid color-mix(in srgb, ${col} 32%, transparent)`,borderRadius:5}}>
      <span style={{width:5,height:5,borderRadius:'50%',background:fg}}/>{DLIV_LABEL[status]||status}
    </span>
  );
}

/* ── DelivDashboard ── */
function DelivDashboard({deliveryOrders, channels}) {
  const today = new Date().toDateString();
  const active = deliveryOrders.filter(o=>['confirmed','picked_up','on_way'].includes(o.rider_status));
  const deliveredToday = deliveryOrders.filter(o=>o.rider_status==='delivered'&&new Date(o.created_at).toDateString()===today);
  const revenueToday = deliveredToday.reduce((s,o)=>s+(o.order_total||0),0);
  const withTime = deliveredToday.filter(o=>o.delivered_at&&o.created_at);
  const avgMin = withTime.length ? Math.round(withTime.reduce((s,o)=>s+(new Date(o.delivered_at)-new Date(o.created_at))/60000,0)/withTime.length) : 0;

  const weekStart = new Date(); weekStart.setDate(weekStart.getDate()-6); weekStart.setHours(0,0,0,0);
  const weekOrds = deliveryOrders.filter(o=>new Date(o.created_at)>=weekStart&&o.rider_status!=='cancelled');
  // Agrupar por el canal REAL congelado en cada pedido (o.channel) usando la comisión
  // CONGELADA por pedido (o.channel_commission), no la viva del canal. Incluye canales
  // inactivos/borrados: si el slug no está en `channels`, cae al slug + gris.
  const chIndex = Object.fromEntries((channels||[]).map(c=>[c.id,c]));
  const chAgg = {};
  weekOrds.forEach(o=>{
    const slug = o.channel||'propio';
    const monto = o.order_total||0;
    const com = Math.round(monto*(o.channel_commission||0)/100);
    if(!chAgg[slug]) chAgg[slug]={slug,monto:0,commissionAmt:0,count:0};
    chAgg[slug].monto+=monto; chAgg[slug].commissionAmt+=com; chAgg[slug].count++;
  });
  const channelData = Object.values(chAgg).map(x=>{
    const def = chIndex[x.slug];
    return {id:x.slug, name:def?.name||x.slug, color:def?.color||'#8E8E93',
            monto:x.monto, count:x.count, commissionAmt:x.commissionAmt, neto:x.monto-x.commissionAmt};
  }).filter(x=>x.monto>0).sort((a,b)=>b.monto-a.monto);
  const maxMonto = Math.max(...channelData.map(c=>c.monto),1);
  const activeOrds = deliveryOrders.filter(o=>!['delivered','cancelled'].includes(o.rider_status)).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));

  return (
    <div>
      <div style={{display:'flex',gap:10,marginBottom:20,flexWrap:'wrap'}}>
        <KpiCard label="Activos ahora" value={active.length} accent={active.length>0?C.orange:C.mid} sub="confirmados · recogidos · en camino"/>
        <KpiCard label="Entregados hoy" value={deliveredToday.length} accent={C.green} sub={`de ${deliveryOrders.filter(o=>new Date(o.created_at).toDateString()===today).length} del día`}/>
        <KpiCard label="Ingresos delivery hoy" value={fmt(revenueToday)} sub="órdenes entregadas"/>
        <KpiCard label="Tiempo promedio" value={avgMin>0?`${avgMin} min`:'—'} sub="entregadas hoy"/>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:16,boxShadow:C.shadow,padding:20}}>
          <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:16}}>INGRESOS POR CANAL — ÚLTIMOS 7 DÍAS</div>
          {channelData.length===0
            ? <div style={{color:C.dim,fontSize:13,textAlign:'center',padding:'20px 0'}}>Sin datos de canal esta semana</div>
            : channelData.map(ch=>(
              <div key={ch.id} style={{marginBottom:14}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                  <div style={{display:'flex',alignItems:'center',gap:6}}>
                    <span style={{width:8,height:8,borderRadius:'50%',background:ch.color,display:'inline-block',flexShrink:0}}/>
                    <span style={{fontSize:13,fontWeight:600,color:C.ink}}>{ch.name}</span>
                  </div>
                  <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:12,fontWeight:700}}>{fmt(ch.monto)}</span>
                </div>
                <div style={{height:4,background:C.card,borderRadius:4,overflow:'hidden'}}>
                  <div style={{height:'100%',background:ch.color,borderRadius:4,width:`${Math.round(ch.monto/maxMonto*100)}%`,transition:'width .3s'}}/>
                </div>
                <div style={{display:'flex',justifyContent:'space-between',marginTop:4}}>
                  <span style={{fontSize:10,color:C.dim}}>{ch.count} pedidos · comisión {fmt(ch.commissionAmt)}</span>
                  <span style={{fontSize:10,color:C.dim}}>Neto: {fmt(ch.neto)}</span>
                </div>
              </div>
            ))
          }
        </div>
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
          <div style={{padding:'12px 16px',borderBottom:`1px solid ${C.border}`,fontSize:10,fontWeight:700,color:C.mid,letterSpacing:1}}>PEDIDOS ACTIVOS EN CURSO</div>
          {activeOrds.length===0
            ? <div style={{padding:40,textAlign:'center',color:C.dim,fontSize:13}}>Sin pedidos activos</div>
            : <div style={{overflowY:'auto',maxHeight:340}}>
                {activeOrds.map(o=>{
                  const addr = o.delivery_address?(o.delivery_address.length>32?o.delivery_address.slice(0,32)+'…':o.delivery_address):'—';
                  return (
                    <div key={o.id} style={{padding:'12px 16px',borderBottom:`1px solid ${C.border}`,display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:10}}>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:2}}>
                          <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:11,color:C.dim}}>#{o.order_number||o.id.slice(0,8)}</span>
                          <DelivBadge status={o.rider_status||'pending'}/>
                        </div>
                        <div style={{fontSize:12,fontWeight:600,color:C.ink,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{o.customer_name||'—'}</div>
                        <div style={{fontSize:11,color:C.dim,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{addr}</div>
                        <div style={{fontSize:11,color:C.dim,marginTop:2}}>Rider: {o.rider_name||<span style={{color:'#FF9500'}}>Sin asignar</span>}</div>
                      </div>
                      <div style={{fontSize:11,color:C.ink,fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:700,whiteSpace:'nowrap'}}>{fmt(o.order_total||0)}</div>
                    </div>
                  );
                })}
              </div>
          }
        </div>
      </div>
    </div>
  );
}

/* ── DelivPedidos ── */
function DelivPedidos({deliveryOrders, riders, channels, zones, onRefresh}) {
  const [filter,setFilter] = useState('all');
  const [chanFilter,setChanFilter] = useState('all');
  const [dateFilter,setDateFilter] = useState('today');
  const [selected,setSelected] = useState(null);
  const [items,setItems] = useState([]);
  const [assigning,setAssigning] = useState(false);
  const [selRider,setSelRider] = useState('');
  const [showNew,setShowNew] = useState(false);
  const [newForm,setNewForm] = useState({customer_name:'',customer_phone:'',delivery_address:'',delivery_detail:'',delivery_references:'',zone_id:'',channel:'propio',external_order_id:'',payment_method:'efectivo',notes:'',items:[{name:'',qty:1,price:0}]});
  const [saving,setSaving] = useState(false);
  const DFILTS = [{id:'all',label:'Todos'},{id:'active',label:'Activos'},{id:'delivered',label:'Entregados'},{id:'cancelled',label:'Cancelados'}];

  function updForm(k,v){ setNewForm(f=>({...f,[k]:v})); }
  function addItem(){ setNewForm(f=>({...f,items:[...f.items,{name:'',qty:1,price:0}]})); }
  function updItem(i,k,v){ setNewForm(f=>({...f,items:f.items.map((it,j)=>j===i?{...it,[k]:v}:it)})); }
  function removeItem(i){ setNewForm(f=>({...f,items:f.items.filter((_,j)=>j!==i)})); }

  const selZone = (zones||[]).find(z=>z.id===newForm.zone_id);
  const selChan = (channels||[]).find(c=>c.id===newForm.channel);
  const newSubtotal = newForm.items.reduce((s,it)=>s+(Number(it.price)*Number(it.qty)),0);
  const newDelivFee = selZone?.price||0;
  const newTotal = newSubtotal + newDelivFee;

  async function saveNewOrder() {
    if(!db) return;
    if(!newForm.customer_name.trim()){toast('Nombre requerido',false);return;}
    if(!newForm.delivery_address.trim()){toast('Dirección requerida',false);return;}
    if(newForm.channel!=='propio'&&!newForm.external_order_id.trim()){toast('Nº de pedido de la plataforma requerido',false);return;}
    const validItems = newForm.items.filter(it=>it.name.trim()&&Number(it.price)>0);
    if(!validItems.length){toast('Agregá al menos un producto con precio',false);return;}
    setSaving(true);
    try {
      const orderNum = 'D-'+String(Math.floor(Date.now()%90000)+10000);
      const{data:order,error:oErr}=await db.from('orders').insert({
        restaurant_id:RID, order_number:orderNum, order_type:'delivery',
        status:'paid', subtotal:newSubtotal, discount_amount:0,
        total:newTotal, payment_method:newForm.payment_method,
        customer_name:newForm.customer_name.trim()||null,
        channel:newForm.channel||null, external_order_id:newForm.channel!=='propio'?(newForm.external_order_id.trim()||null):null,
      }).select().single();
      if(oErr) throw new Error(oErr.message);
      await db.from('order_items').insert(validItems.map(it=>({
        order_id:order.id, item_name:it.name.trim(),
        quantity:Number(it.qty), unit_price:Number(it.price),
        total_price:Number(it.price)*Number(it.qty),
      })));
      const delivPayload={
        restaurant_id:RID, order_id:order.id, order_number:orderNum,
        order_type:'delivery', customer_name:newForm.customer_name.trim()||null,
        customer_phone:newForm.customer_phone.trim()||null,
        delivery_address:newForm.delivery_address.trim(),
        delivery_detail:newForm.delivery_detail.trim()||null,
        delivery_references:newForm.delivery_references.trim()||null,
        zone_id:newForm.zone_id||null, zone_name:selZone?.name||null,
        delivery_fee:newDelivFee, estimated_minutes:selZone?.time||null,
        channel:newForm.channel||'propio', channel_commission:selChan?.commission||0,
        external_order_id:newForm.channel!=='propio'?(newForm.external_order_id.trim()||null):null,
        order_total:newSubtotal, rider_status:'pending',
        delivery_notes:newForm.notes.trim()||null,
      };
      let{error:dErr}=await db.from('delivery_orders').insert(delivPayload);
      // Defensivo: si la mig 161 (external_order_id) aún no está aplicada, reintentar sin esa columna.
      if(dErr && /external_order_id|PGRST204|42703|schema cache/i.test(`${dErr.message||''} ${dErr.code||''}`)){
        const {external_order_id, ...noExt}=delivPayload;
        dErr=(await db.from('delivery_orders').insert(noExt)).error;
      }
      if(dErr) throw new Error(dErr.message);
      await db.from('order_status_history').insert({order_id:order.id,status:'paid',changed_by:'admin'});
      toast('Pedido delivery creado');
      setShowNew(false);
      setNewForm({customer_name:'',customer_phone:'',delivery_address:'',delivery_detail:'',delivery_references:'',zone_id:'',channel:'propio',external_order_id:'',payment_method:'efectivo',notes:'',items:[{name:'',qty:1,price:0}]});
      onRefresh();
    } catch(e){ toast('Error: '+e.message,false); }
    setSaving(false);
  }

  const filtered = useMemo(()=>{
    let res = [...deliveryOrders];
    if(dateFilter==='today'){const t=new Date().toDateString();res=res.filter(o=>new Date(o.created_at).toDateString()===t);}
    else if(dateFilter==='7d'){const s=new Date();s.setDate(s.getDate()-6);s.setHours(0,0,0,0);res=res.filter(o=>new Date(o.created_at)>=s);}
    else if(dateFilter==='30d'){const s=new Date();s.setDate(s.getDate()-29);s.setHours(0,0,0,0);res=res.filter(o=>new Date(o.created_at)>=s);}
    if(filter==='active') res=res.filter(o=>['pending','confirmed','picked_up','on_way'].includes(o.rider_status));
    else if(filter==='delivered') res=res.filter(o=>o.rider_status==='delivered');
    else if(filter==='cancelled') res=res.filter(o=>o.rider_status==='cancelled');
    if(chanFilter!=='all') res=res.filter(o=>(o.channel||'propio')===chanFilter);
    return res;
  },[deliveryOrders,filter,chanFilter,dateFilter]);

  async function openOrder(o) {
    setSelected(o); setSelRider(o.rider_id||''); setItems([]);
    if(!db||!o.order_id) return;
    const{data}=await db.from('order_items').select('item_name,quantity,unit_price,total_price').eq('order_id',o.order_id);
    setItems(data||[]);
  }

  async function assignRider() {
    if(!db||!selected) return;
    setAssigning(true);
    const rider = riders.find(r=>r.id===selRider);
    const newPin = selRider ? String(Math.floor(1000 + Math.random() * 9000)) : null;
    const update = {rider_id:selRider||null,rider_name:rider?.name||null,rider_status:selRider?'confirmed':'pending',delivery_pin:newPin};
    const{error}=await db.from('delivery_orders').update(update).eq('id',selected.id);
    if(error) toast('Error al asignar: '+error.message,false);
    else{toast('Rider asignado');setSelected(prev=>({...prev,...update}));onRefresh();}
    setAssigning(false);
  }

  async function cancelOrder() {
    if(!db||!selected||!confirm('¿Cancelar este pedido?')) return;
    const{error}=await db.from('delivery_orders').update({rider_status:'cancelled'}).eq('id',selected.id);
    if(error) toast('Error: '+error.message,false);
    else{toast('Pedido cancelado');onRefresh();setSelected(null);}
  }

  return (
    <div>
      <div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap',alignItems:'center',justifyContent:'space-between'}}>
        <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
        <div style={{display:'flex',gap:0,border:`1px solid ${C.border}`,borderRadius:6,overflow:'hidden'}}>
          {DFILTS.map((f,i)=>(
            <button key={f.id} onClick={()=>setFilter(f.id)} style={{padding:'6px 14px',fontSize:12,fontWeight:filter===f.id?700:400,background:filter===f.id?C.ink:C.surface,color:filter===f.id?C.surface:C.ink,border:'none',cursor:'pointer',borderRight:i<DFILTS.length-1?`1px solid ${C.border}`:'none'}}>
              {f.label}
            </button>
          ))}
        </div>
        <select value={chanFilter} onChange={e=>setChanFilter(e.target.value)} style={{padding:'6px 10px',fontSize:12,borderRadius:6,border:`1px solid ${C.border}`,color:C.ink,background:C.surface}}>
          <option value="all">Todos los canales</option>
          {channels.map(ch=><option key={ch.id} value={ch.id}>{ch.name}</option>)}
        </select>
        <select value={dateFilter} onChange={e=>setDateFilter(e.target.value)} style={{padding:'6px 10px',fontSize:12,borderRadius:6,border:`1px solid ${C.border}`,color:C.ink,background:C.surface}}>
          <option value="today">Hoy</option>
          <option value="7d">Últimos 7 días</option>
          <option value="30d">Últimos 30 días</option>
          <option value="all">Todos</option>
        </select>
        </div>
        <button onClick={()=>setShowNew(true)} style={{height:34,padding:'0 16px',background:C.ink,color:C.sidebar,border:'none',borderRadius:6,fontSize:12,fontWeight:700,cursor:'pointer'}}>+ Nuevo pedido</button>
      </div>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead>
            <tr style={{borderBottom:`1px solid ${C.border}`,background:'var(--bg-subtle)'}}>
              <Th># Orden</Th><Th>Canal</Th><Th>Cliente</Th><Th>Dirección</Th><Th>Rider</Th><Th>Estado</Th><Th right>Monto</Th><Th right>Fee</Th><Th>Hora</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(o=>(
              <tr key={o.id} onClick={()=>openOrder(o)} style={{borderBottom:`1px solid ${C.border}`,cursor:'pointer'}} onMouseEnter={e=>e.currentTarget.style.background='var(--surface-hover)'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                <Td mono dim>#{o.order_number||o.id.slice(0,8)}</Td>
                <Td>{o.channel||'Propio'}{o.external_order_id?<span style={{display:'block',fontSize:10,color:C.dim,fontFamily:"'SF Mono',ui-monospace,monospace"}}>Nº {o.external_order_id}</span>:null}</Td>
                <Td>{o.customer_name||'—'}</Td>
                <Td dim>{o.delivery_address?o.delivery_address.slice(0,28)+'…':'—'}</Td>
                <Td dim>{o.rider_name||'Sin asignar'}</Td>
                <Td><DelivBadge status={o.rider_status||'pending'}/></Td>
                <Td mono right>{fmt(o.order_total||0)}</Td>
                <Td mono right dim>{fmt(o.delivery_fee||0)}</Td>
                <Td mono dim>{fmtTime(o.created_at)}</Td>
              </tr>
            ))}
            {filtered.length===0 && <EmptyRow cols={9} label="Sin pedidos en este filtro"/>}
          </tbody>
        </table>
      </div>

      {showNew && (
        <Modal title="Nuevo pedido delivery" onClose={()=>setShowNew(false)} width={580}>
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
              <div>
                <Lbl>NOMBRE *</Lbl>
                <Inp value={newForm.customer_name} onChange={e=>updForm('customer_name',e.target.value)} placeholder="Nombre del cliente"/>
              </div>
              <div>
                <Lbl>TELÉFONO</Lbl>
                <Inp value={newForm.customer_phone} onChange={e=>updForm('customer_phone',e.target.value)} placeholder="0981 000000"/>
              </div>
            </div>
            <div>
              <Lbl>DIRECCIÓN *</Lbl>
              <Inp value={newForm.delivery_address} onChange={e=>updForm('delivery_address',e.target.value)} placeholder="Calle, número, barrio"/>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
              <div>
                <Lbl>DETALLE (apto/piso)</Lbl>
                <Inp value={newForm.delivery_detail} onChange={e=>updForm('delivery_detail',e.target.value)} placeholder="Ej: Piso 2, Apto B"/>
              </div>
              <div>
                <Lbl>REFERENCIAS</Lbl>
                <Inp value={newForm.delivery_references} onChange={e=>updForm('delivery_references',e.target.value)} placeholder="Ej: Portón rojo"/>
              </div>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10}}>
              <div>
                <Lbl>ZONA</Lbl>
                <Sel value={newForm.zone_id} onChange={e=>updForm('zone_id',e.target.value)}>
                  <option value="">Sin zona</option>
                  {(zones||[]).filter(z=>z.active!==false).map(z=><option key={z.id} value={z.id}>{z.name} — {fmt(z.price)}</option>)}
                </Sel>
              </div>
              <div>
                <Lbl>CANAL</Lbl>
                <Sel value={newForm.channel} onChange={e=>updForm('channel',e.target.value)}>
                  {(channels||[]).filter(c=>c.active!==false).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
                </Sel>
              </div>
              <div>
                <Lbl>PAGO</Lbl>
                <Sel value={newForm.payment_method} onChange={e=>updForm('payment_method',e.target.value)}>
                  <option value="efectivo">Efectivo</option>
                  <option value="tarjeta">Tarjeta</option>
                  <option value="transferencia">Transferencia</option>
                </Sel>
              </div>
            </div>
            {newForm.channel!=='propio'&&(
              <div>
                <Lbl>Nº DE PEDIDO DE LA PLATAFORMA *</Lbl>
                <Inp value={newForm.external_order_id} onChange={e=>updForm('external_order_id',e.target.value)} placeholder="Ej: PY-8842193"/>
              </div>
            )}
            <div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                <Lbl style={{marginBottom:0}}>PRODUCTOS *</Lbl>
                <button onClick={addItem} style={{fontSize:11,fontWeight:700,background:'none',border:`1px solid ${C.border}`,borderRadius:4,padding:'2px 8px',cursor:'pointer'}}>+ Agregar</button>
              </div>
              {newForm.items.map((it,i)=>(
                <div key={i} style={{display:'grid',gridTemplateColumns:'1fr 60px 110px 28px',gap:6,marginBottom:6}}>
                  <Inp value={it.name} onChange={e=>updItem(i,'name',e.target.value)} placeholder="Nombre del producto"/>
                  <NumInp decimals={3} value={it.qty} onChange={v=>updItem(i,'qty',v)} placeholder="Qty"/>
                  <MoneyInp value={it.price} onChange={v=>updItem(i,'price',v)} placeholder="Precio ₲"/>
                  {newForm.items.length>1&&<button onClick={()=>removeItem(i)} style={{background:'#FF3B30',color:'#fff',border:'none',borderRadius:4,cursor:'pointer',fontWeight:700}}>×</button>}
                </div>
              ))}
            </div>
            <div>
              <Lbl>NOTAS</Lbl>
              <Inp value={newForm.notes} onChange={e=>updForm('notes',e.target.value)} placeholder="Instrucciones especiales…"/>
            </div>
            <div style={{background:C.bg,borderRadius:8,padding:12}}>
              <div style={{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:4}}><span style={{color:C.mid}}>Subtotal</span><span style={{fontFamily:"'SF Mono',ui-monospace,monospace"}}>{fmt(newSubtotal)}</span></div>
              <div style={{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:4}}><span style={{color:C.mid}}>Delivery fee {selZone?`(${selZone.name})`:''}</span><span style={{fontFamily:"'SF Mono',ui-monospace,monospace"}}>{fmt(newDelivFee)}</span></div>
              <div style={{height:1,background:C.border,margin:'6px 0'}}/>
              <div style={{display:'flex',justifyContent:'space-between',fontSize:15,fontWeight:800}}><span>Total</span><span style={{fontFamily:"'SF Mono',ui-monospace,monospace"}}>{fmt(newTotal)}</span></div>
            </div>
            <div style={{display:'flex',gap:8}}>
              <Btn onClick={saveNewOrder} disabled={saving} style={{flex:1}}>{saving?'Guardando…':'Crear pedido'}</Btn>
              <Btn variant="secondary" onClick={()=>setShowNew(false)}>Cancelar</Btn>
            </div>
          </div>
        </Modal>
      )}

      {selected && (
        <Modal title={`Pedido #${selected.order_number||selected.id.slice(0,8)}`} onClose={()=>setSelected(null)} width={560}>
          <div style={{display:'flex',flexDirection:'column',gap:16}}>
            <div style={{background:C.bg,borderRadius:8,padding:14}}>
              <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:8}}>CLIENTE</div>
              <div style={{fontSize:14,fontWeight:700,color:C.ink}}>{selected.customer_name||'—'}</div>
              {selected.customer_phone&&<div style={{fontSize:12,color:C.mid,marginTop:3}}>{selected.customer_phone}</div>}
              <div style={{fontSize:12,color:C.ink,marginTop:6}}>{selected.delivery_address||'—'}</div>
              {selected.delivery_detail&&<div style={{fontSize:11,color:C.mid,marginTop:2}}>{selected.delivery_detail}</div>}
              {selected.delivery_notes&&<div style={{fontSize:11,color:C.dim,marginTop:2,fontStyle:'italic'}}>{selected.delivery_notes}</div>}
              {selected.external_order_id&&<div style={{fontSize:11,marginTop:6}}><span style={{color:C.dim}}>Nº plataforma:</span> <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:700,color:C.ink}}>{selected.external_order_id}</span>{selected.channel&&selected.channel!=='propio'?<span style={{color:C.mid}}> · {selected.channel}</span>:null}</div>}
            </div>
            {items.length>0&&(
              <div>
                <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:8}}>PRODUCTOS</div>
                {items.map((it,i)=>(
                  <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'6px 0',borderBottom:`1px solid ${C.border}`,fontSize:13}}>
                    <span>{it.quantity}× {it.item_name}</span>
                    <span style={{fontFamily:"'SF Mono',ui-monospace,monospace"}}>{fmt(it.total_price)}</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{background:C.bg,borderRadius:8,padding:12}}>
              <div style={{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:4}}><span style={{color:C.mid}}>Subtotal</span><span style={{fontFamily:"'SF Mono',ui-monospace,monospace"}}>{fmt(selected.order_total||0)}</span></div>
              <div style={{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:4}}><span style={{color:C.mid}}>Delivery fee</span><span style={{fontFamily:"'SF Mono',ui-monospace,monospace"}}>{fmt(selected.delivery_fee||0)}</span></div>
              {selected.channel&&selected.channel!=='propio'&&(
                <div style={{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:4}}>
                  <span style={{color:C.mid}}>Comisión canal ({selected.channel_commission||0}%)</span>
                  <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",color:C.red}}>-{fmt(Math.round((selected.order_total||0)*((selected.channel_commission||0)/100)))}</span>
                </div>
              )}
              <div style={{height:1,background:C.border,margin:'6px 0'}}/>
              <div style={{display:'flex',justifyContent:'space-between',fontSize:14,fontWeight:800}}>
                <span>Total cobrado</span>
                <span style={{fontFamily:"'SF Mono',ui-monospace,monospace"}}>{fmt((selected.order_total||0)+(selected.delivery_fee||0))}</span>
              </div>
            </div>
            <div>
              <Lbl>ASIGNAR RIDER</Lbl>
              <div style={{display:'flex',gap:8}}>
                <Sel value={selRider} onChange={e=>setSelRider(e.target.value)}>
                  <option value="">Sin asignar</option>
                  {riders.filter(r=>r.active!==false).map(r=><option key={r.id} value={r.id}>{r.name} — {r.vehicle||'—'}</option>)}
                </Sel>
                <Btn onClick={assignRider} disabled={assigning}>{assigning?'…':'Guardar'}</Btn>
              </div>
            </div>
            {selected.delivery_pin&&selected.rider_status==='confirmed'&&(
              <div style={{background:TINT.amberBg,border:'2px solid #FF9500',borderRadius:12,padding:'14px 16px',textAlign:'center'}}>
                <div style={{fontSize:10,fontWeight:800,color:'#FF9500',letterSpacing:1,marginBottom:8}}>PIN PARA EL RIDER</div>
                <div style={{fontSize:44,fontWeight:900,color:C.ink,letterSpacing:10,fontFamily:"'SF Mono',ui-monospace,monospace"}}>{selected.delivery_pin}</div>
                <div style={{fontSize:11,color:C.dim,marginTop:6}}>Dáselo al rider para que lo ingrese en su panel</div>
              </div>
            )}
            {selected.rider_status&&(
              <div>
                <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1,marginBottom:6}}>ESTADO ACTUAL</div>
                <DelivBadge status={selected.rider_status}/>
                {selected.delivered_at&&<div style={{fontSize:11,color:C.dim,marginTop:6}}>Entregado: {fmtDT(selected.delivered_at)}</div>}
              </div>
            )}
            {/* WhatsApp directo */}
            {selected.customer_phone&&(()=>{
              const phone = selected.customer_phone.replace(/[\s\-\+]/g,'').replace(/^0/,'').replace(/^595/,'');
              const estado = DLIV_LABEL[selected.rider_status]||selected.rider_status||'en proceso';
              const num = selected.order_number||selected.id.slice(0,8);
              const msg = encodeURIComponent(`Hola, tu pedido #${num} está ${estado}`);
              return (
                <a href={`https://wa.me/595${phone}?text=${msg}`} target="_blank" rel="noopener noreferrer"
                  style={{display:'block',padding:'10px',textAlign:'center',background:'#25D366',color:'#fff',borderRadius:8,fontSize:13,fontWeight:700,textDecoration:'none'}}>
                  WhatsApp al cliente
                </a>
              );
            })()}
            {!['delivered','cancelled'].includes(selected.rider_status)&&(
              <Btn variant="danger" onClick={cancelOrder}>Cancelar pedido</Btn>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ── DelivRiders ── */
function DelivRiders({riders, deliveryOrders=[], settings, onRefresh, onRebalance, onTransfer}) {
  const [modal,setModal] = useState(null);
  const [form,setForm] = useState({name:'',phone:'',vehicle:'moto',commission_type:'pct',commission_value:0,username:'',password:'',active:true});
  const [saving,setSaving] = useState(false);
  const [rebalancing,setRebalancing] = useState(false);
  const [target,setTarget] = useState({});       // {orderId: riderId destino}
  const [transferringId,setTransferringId] = useState(null);
  const VEHICLE_LABELS = {moto:'Moto',bici:'Bici',auto:'Auto',pie:'A pie'};
  const COMM_LABELS = {pct:'% del pedido',fixed:'₲ por entrega',salary:'₲ sueldo/mes'};

  // ── Despacho / cola por rider (mig 156) ──
  const cap = Number(settings?.max_orders_per_rider) || 0;   // 0 = sin límite
  // Carga por rider: bolsón = ya recogido (on_way, BLOQUEADO); cola = confirmado sin
  // recoger (TRANSFERIBLE). active = bolsón + cola (contra la que se mide la alerta).
  function riderCounts(rid){
    const mine = (deliveryOrders||[]).filter(o=>o.rider_id===rid);
    const bag   = mine.filter(o=>o.rider_status==='on_way').length;
    const queue = mine.filter(o=>o.rider_status==='confirmed' && !o.picked_up_at).length;
    return { bag, queue, active: bag+queue };
  }
  const riderById = id => riders.find(r=>r.id===id);
  const statusPill = r => { const off=r?.active===false; return off?'offline':(r?.current_status||'disponible'); };
  // Pedidos TRANSFERIBLES: confirmados y NO recogidos (aún en el local).
  const transferable = (deliveryOrders||[]).filter(o=>o.rider_status==='confirmed' && !o.picked_up_at && o.rider_id);
  const overCapRiders = riders.filter(r=>cap>0 && r.active!==false && riderCounts(r.id).active>cap);

  async function doTransfer(orderId){
    const rid = target[orderId];
    if(!rid || !onTransfer){ toast('Elegí un rider destino',false); return; }
    setTransferringId(orderId);
    const res = await onTransfer(orderId, rid);
    if(res && res.ok) setTarget(t=>{ const n={...t}; delete n[orderId]; return n; });
    setTransferringId(null);
  }
  async function doRebalance(){
    if(!onRebalance) return;
    setRebalancing(true);
    await onRebalance();
    setRebalancing(false);
  }

  function openNew() { setForm({name:'',phone:'',vehicle:'moto',commission_type:'pct',commission_value:0,username:'',password:'',active:true}); setModal('new'); }
  function openEdit(r) { setForm({name:r.name||'',phone:r.phone||'',vehicle:r.vehicle||'moto',commission_type:r.commission_type||'pct',commission_value:r.commission_value||0,username:'',password:'',active:r.active!==false}); setModal(r); }

  async function saveRider() {
    if(!db||!form.name.trim()){toast('El nombre es obligatorio',false);return;}
    setSaving(true);
    if(modal==='new'){
      // Alta: crear cuenta auth (usuario+contraseña) + ficha de rider vía endpoint seguro
      // (service_role en backend). El panel rider resuelve la ficha por user_id (sin PIN).
      const ced=(form.cedula||'').replace(/\D/g,'');
      if(ced.length<4||ced.length>10){toast('Ingresá una cédula válida (solo números)',false);setSaving(false);return;}
      if(form.recovery_email&&form.recovery_email.trim()&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.recovery_email.trim())){toast('El email de recuperación no es válido',false);setSaving(false);return;}
      if(typeof form.password!=='string'||!form.password.trim()||form.password.length<8){toast('Ingresá una contraseña de al menos 8 caracteres para crear el usuario.',false);setSaving(false);return;}
      try{
        const{data:{session}}=await db.auth.getSession();
        const token=session?.access_token;
        if(!token) throw new Error('Sin sesión activa');
        const resp=await fetch('/api/create-user',{
          method:'POST',
          headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
          body:JSON.stringify({
            cedula:ced, recovery_email:(form.recovery_email||'').trim()||undefined,
            password:form.password, display_name:form.name.trim(),
            role:'rider', restaurant_id:RID,
            vehicle:form.vehicle, commission_type:form.commission_type, commission_value:Number(form.commission_value),
            phone:form.phone||undefined
          })
        });
        const result=await resp.json();
        if(!resp.ok) throw new Error(result.error||'Error desconocido');
        toast(result.reused
          ? `Rider vinculado${result.linked_name?` (${result.linked_name})`:''} a este restaurante`
          : 'Rider creado');
        onRefresh(); setModal(null);
      }catch(e){toast(e.message,false);}
      setSaving(false);
      return;
    }
    // Edición: sólo el perfil operativo (la cuenta auth no se modifica acá).
    const payload={name:form.name.trim(),phone:form.phone,vehicle:form.vehicle,commission_type:form.commission_type,commission_value:Number(form.commission_value),active:form.active!==false};
    const{error}=await db.from('delivery_riders').update(payload).eq('id',modal.id);
    if(error) toast('Error: '+error.message,false);
    else{toast('Rider actualizado');onRefresh();setModal(null);}
    setSaving(false);
  }

  async function toggleActive(r) {
    if(!db) return;
    const{error}=await db.from('delivery_riders').update({active:!r.active}).eq('id',r.id);
    if(error) toast('Error: '+error.message,false);
    else{toast(r.active?'Rider desactivado':'Rider activado');onRefresh();}
  }

  function commLabel(r) {
    if(r.commission_type==='pct')    return `${r.commission_value||0}% del pedido`;
    if(r.commission_type==='salary') return `Sueldo: ${fmt(r.commission_value||0)}/mes`;
    return `${fmt(r.commission_value||0)} por entrega`;
  }

  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
        <div style={{fontSize:13,color:C.mid}}>{riders.length} riders registrados</div>
        <Btn onClick={openNew}>+ Nuevo Rider</Btn>
      </div>

      {/* ── Despacho: rebalanceo + transferencias (mig 156) ── */}
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:18,marginBottom:20}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap',marginBottom:transferable.length?14:0}}>
          <div>
            <div style={{fontSize:14,fontWeight:800,color:C.ink}}>Despacho de riders</div>
            <div style={{fontSize:11,color:C.dim,marginTop:2}}>El rebalanceo mueve pedidos <strong>transferibles</strong> (aún en el local, sin recoger) de los riders en ruta a los disponibles.</div>
          </div>
          <Btn variant="secondary" onClick={doRebalance} disabled={rebalancing}>{rebalancing?'Rebalanceando…':'↻ Rebalancear ahora'}</Btn>
        </div>

        {/* Alerta de cola llena */}
        {overCapRiders.length>0 && (
          <div style={{padding:'9px 12px',background:'#FEF2F2',border:'1px solid #FECACA',borderRadius:8,fontSize:12,color:'#991B1B',lineHeight:1.5,marginBottom:transferable.length?12:0,display:'flex',gap:8,alignItems:'flex-start'}}>
            <span style={{flexShrink:0,display:'flex',marginTop:1}}><Icon name="alert" size={14}/></span>
            <span>Cola llena (límite {cap}/rider): {overCapRiders.map(r=>`${r.name} (${riderCounts(r.id).active})`).join(', ')}. Rebalanceá o transferí pedidos.</span>
          </div>
        )}

        {/* Lista de pedidos transferibles con transferencia manual */}
        {transferable.length===0
          ? <div style={{fontSize:12,color:C.dim,paddingTop:transferable.length?0:12}}>No hay pedidos transferibles ahora (todos recogidos o sin asignar).</div>
          : <div style={{display:'flex',flexDirection:'column',gap:8}}>
              <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1}}>PEDIDOS TRANSFERIBLES ({transferable.length})</div>
              {transferable.map(o=>{
                const owner = riderById(o.rider_id);
                const opts = riders.filter(r=>r.active!==false && (r.current_status||'disponible')!=='offline' && r.id!==o.rider_id);
                return (
                  <div key={o.id} style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',padding:'8px 10px',background:C.card,borderRadius:8}}>
                    <div style={{flex:1,minWidth:160}}>
                      <div style={{fontSize:12,fontWeight:700,color:C.ink}}>{o.customer_name||'Cliente'}</div>
                      <div style={{fontSize:11,color:C.dim,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',maxWidth:280}}>{o.delivery_address||'—'}</div>
                    </div>
                    <div style={{fontSize:11,color:C.mid}}>Actual: <strong>{owner?.name||o.rider_name||'—'}</strong></div>
                    <div style={{display:'flex',gap:6,alignItems:'center'}}>
                      <Sel value={target[o.id]||''} onChange={e=>setTarget(t=>({...t,[o.id]:e.target.value}))} style={{minWidth:130}}>
                        <option value="">Transferir a…</option>
                        {opts.map(r=><option key={r.id} value={r.id}>{r.name}{(r.current_status||'disponible')==='en_ruta'?' (en ruta)':''}</option>)}
                      </Sel>
                      <Btn small onClick={()=>doTransfer(o.id)} disabled={transferringId===o.id||!target[o.id]}>{transferringId===o.id?'…':'Transferir'}</Btn>
                    </div>
                  </div>
                );
              })}
            </div>
        }
      </div>

      {riders.length===0
        ? <div style={{textAlign:'center',padding:60,color:C.dim,fontSize:14}}>No hay riders — creá el primero</div>
        : <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:14}}>
            {riders.map(r=>{
              // Estado real del rider: current_status manda (offline/en_ruta/disponible);
              // active===false también cuenta como offline. Se ignora la columna `status` legacy (muerta).
              const statusKey = (r.active===false || (r.current_status||'disponible')==='offline')
                ? 'offline' : (r.current_status||'disponible');
              const statusLabel = statusKey==='offline'?'OFFLINE':statusKey==='en_ruta'?'EN RUTA':'DISPONIBLE';
              const statusCol = statusKey==='offline'?'#86868B':statusKey==='en_ruta'?C.ink:C.green;
              const initials = r.name.split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
              return (
                <div key={r.id} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:20}}>
                  <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12}}>
                    {r.photo_url
                      ? <img src={r.photo_url} alt="" style={{width:44,height:44,borderRadius:'50%',objectFit:'cover',border:`1px solid ${C.border}`}}/>
                      : <div style={{width:44,height:44,borderRadius:'50%',background:C.card,display:'flex',alignItems:'center',justifyContent:'center',fontSize:15,fontWeight:800,color:C.mid,flexShrink:0}}>{initials}</div>
                    }
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:14,fontWeight:700,color:C.ink,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{r.name}</div>
                      <div style={{fontSize:11,color:C.dim}}>{VEHICLE_LABELS[r.vehicle]||r.vehicle||'—'}</div>
                    </div>
                  </div>
                  <div style={{display:'inline-flex',alignItems:'center',gap:5,padding:'3px 8px',fontSize:10,fontWeight:800,background:statusCol+'22',color:statusCol,border:`1px solid ${statusCol}44`,borderRadius:5,marginBottom:8}}>
                    <span style={{width:5,height:5,borderRadius:'50%',background:statusCol}}/>{statusLabel}
                  </div>
                  <div style={{fontSize:11,color:C.dim,marginBottom:4}}>{commLabel(r)}</div>
                  {(() => {
                    const c = riderCounts(r.id);
                    const over = cap>0 && r.active!==false && c.active>cap;
                    return (
                      <div style={{display:'flex',gap:10,flexWrap:'wrap',alignItems:'center',fontSize:11,marginBottom:8}}>
                        <span style={{color:C.mid}} title="En el bolsón — ya recogidos (no transferibles)">Bolsón: <strong style={{color:C.ink}}>{c.bag}</strong></span>
                        <span style={{color:C.mid}} title="En cola — asignados sin recoger (transferibles)">Cola: <strong style={{color:C.ink}}>{c.queue}</strong></span>
                        {over && <span style={{color:'#DC2626',fontWeight:800,display:'inline-flex',alignItems:'center',gap:3}}><Icon name="alert" size={11}/> {c.active}/{cap}</span>}
                      </div>
                    );
                  })()}
                  {r.rider_pin&&(
                    <div style={{fontSize:11,color:C.dim,marginBottom:12}}>
                      PIN: <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontWeight:800,color:'#007AFF',letterSpacing:2}}>{r.rider_pin}</span>
                    </div>
                  )}
                  <div style={{display:'flex',gap:6}}>
                    <Btn small variant="secondary" onClick={()=>openEdit(r)}>Editar</Btn>
                    <Btn small variant={r.active===false?'secondary':'danger'} onClick={()=>toggleActive(r)}>{r.active===false?'Activar':'Desactivar'}</Btn>
                  </div>
                </div>
              );
            })}
          </div>
      }
      {modal&&(
        <Modal title={modal==='new'?'Nuevo Rider':'Editar Rider'} onClose={()=>setModal(null)} width={440}>
          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            <div><Lbl>NOMBRE *</Lbl><Inp value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="Juan Pérez"/></div>
            <div><Lbl>TELÉFONO</Lbl><Inp value={form.phone||''} onChange={e=>setForm({...form,phone:e.target.value})} placeholder="0981 000 000"/></div>
            <div><Lbl>VEHÍCULO</Lbl>
              <Sel value={form.vehicle} onChange={e=>setForm({...form,vehicle:e.target.value})}>
                <option value="moto">Moto</option><option value="bici">Bici</option><option value="auto">Auto</option><option value="pie">A pie</option>
              </Sel>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              <div><Lbl>TIPO DE PAGO</Lbl>
                <Sel value={form.commission_type} onChange={e=>setForm({...form,commission_type:e.target.value})}>
                  <option value="pct">Comisión %</option>
                  <option value="fixed">Monto fijo/entrega</option>
                  <option value="salary">Sueldo mensual</option>
                </Sel>
              </div>
              <div>
                <Lbl>{form.commission_type==='pct'?'PORCENTAJE %':form.commission_type==='salary'?'MONTO ₲/MES':'MONTO ₲/ENTREGA'}</Lbl>
                {form.commission_type==='pct'
                  ? <Inp type="number" value={form.commission_value} onChange={e=>setForm({...form,commission_value:e.target.value})} placeholder="10"/>
                  : <MoneyInp value={form.commission_value} onChange={v=>setForm({...form,commission_value:v})} placeholder="2000000"/>
                }
              </div>
            </div>
            {modal==='new'?(<>
              <div>
                <Lbl>CÉDULA *</Lbl>
                <Inp value={form.cedula||''} onChange={e=>setForm({...form,cedula:e.target.value.replace(/\D/g,'')})} placeholder="ej: 4123456" inputMode="numeric" style={{fontFamily:"'SF Mono',ui-monospace,monospace"}}/>
              </div>
              <div>
                <Lbl>EMAIL (RECUPERACIÓN) — opcional</Lbl>
                <Inp type="email" value={form.recovery_email||''} onChange={e=>setForm({...form,recovery_email:e.target.value})} placeholder="ej: juan@email.com"/>
              </div>
              <div>
                <Lbl>CONTRASEÑA * (mínimo 8 caracteres)</Lbl>
                <Inp type="password" autoComplete="new-password" value={form.password||''} onChange={e=>setForm({...form,password:e.target.value})} placeholder="Contraseña segura"/>
                <div style={{fontSize:11,color:C.dim,marginTop:4}}>El rider inicia sesión con su <strong>cédula</strong> y contraseña. Deberá cambiarla en su primer ingreso.</div>
              </div>
            </>):(
              <div style={{fontSize:11,color:C.dim}}>El usuario y la contraseña del rider se gestionan en Personal. Acá editás su perfil operativo.</div>
            )}
            {modal!=='new'&&(
              <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',fontSize:13}}>
                <input type="checkbox" checked={form.active!==false} onChange={e=>setForm({...form,active:e.target.checked})}/> Rider activo
              </label>
            )}
            <div style={{display:'flex',gap:8,marginTop:8}}>
              <Btn onClick={saveRider} disabled={saving} style={{flex:1}}>{saving?'Guardando…':'Guardar'}</Btn>
              <Btn variant="secondary" onClick={()=>setModal(null)}>Cancelar</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* Reverse-geocode una coordenada → dirección legible. Usa Google Geocoder si la
   API está cargada; si no, cae a Nominatim/OSM. Resuelve a string o null (defensivo). */
function reverseGeocode(lat, lng) {
  return new Promise((resolve) => {
    try {
      if (window.google?.maps?.Geocoder) {
        const geo = new window.google.maps.Geocoder();
        geo.geocode({ location: { lat, lng }, language: 'es' }, (results, status) => {
          resolve((status === 'OK' && results && results[0]) ? results[0].formatted_address : null);
        });
        return;
      }
    } catch (_) { /* cae al fallback */ }
    fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=es`)
      .then(r => r.json())
      .then(d => resolve(d?.display_name || null))
      .catch(() => resolve(null));
  });
}

/* ── MAPA BASE (tiles Carto tema-consciente) + PIN CENTRAL ──────────────────
   Reemplaza los tiles OSM crudos por Carto Positron (claro) / Dark Matter
   (oscuro): look minimalista tipo Uber/Bolt, gratis y SIN API key (el host
   *.basemaps.cartocdn.com está en img-src del CSP de vercel.json). El pin del
   local queda FIJO al centro del mapa: se mueve el mapa por debajo y el centro
   es la ubicación. Mismos helpers que el panel delivery-cliente. */
const CARTO_LIGHT = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
const CARTO_DARK  = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const _mapIsDark = () => {
  try { if (window.MythosTheme && window.MythosTheme.get) return window.MythosTheme.get() === 'dark'; } catch (_) {}
  return document.documentElement.getAttribute('data-theme') === 'dark';
};
const _cartoTiles = (dark) => window.L.tileLayer(dark ? CARTO_DARK : CARTO_LIGHT, {
  subdomains: 'abcd', maxZoom: 20, detectRetina: true,
  attribution: '© OpenStreetMap · © CARTO',
});
// Mapa base Carto CON FALLBACK a OSM: si Carto no carga (CSP/red/región), tras
// varios tileerror sin ningún 'load' cae a OSM para no dejar el mapa en blanco.
function _addBaseTiles(map, dark) {
  const L = window.L;
  const base = _cartoTiles(dark);
  let loaded = false, errs = 0;
  base.on('load', () => { loaded = true; });
  base.on('tileerror', () => {
    if (!loaded && ++errs >= 3) {
      try { base.off(); map.removeLayer(base); } catch (_) {}
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    }
  });
  return base.addTo(map);
}
const _pinSvg = (dark) => {
  const body = dark ? '#FFFFFF' : '#111111';
  const hole = dark ? '#111111' : '#FFFFFF';
  return '<svg width="30" height="40" viewBox="0 0 30 40" fill="none" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M15 0C6.7 0 0 6.7 0 15c0 10.5 13.2 23.4 13.8 24a1.7 1.7 0 0 0 2.4 0C16.8 38.4 30 25.5 30 15 30 6.7 23.3 0 15 0z" fill="' + body + '"/>'
    + '<circle cx="15" cy="15" r="5.5" fill="' + hole + '"/></svg>';
};
function _ensurePinCss() {
  if (typeof document === 'undefined' || document.getElementById('mythos-cpin-css')) return;
  const s = document.createElement('style');
  s.id = 'mythos-cpin-css';
  s.textContent =
    '.mythos-cpin{position:absolute;left:50%;top:50%;z-index:600;pointer-events:none;transform:translate(-50%,-100%);transition:transform .18s cubic-bezier(.2,.8,.3,1);will-change:transform}'
    + '.mythos-cpin.lift{transform:translate(-50%,-100%) translateY(-14px)}'
    + '.mythos-cpin svg{display:block;filter:drop-shadow(0 4px 6px rgba(0,0,0,.35))}'
    + '.mythos-cpin-sh{position:absolute;left:50%;top:50%;width:16px;height:6px;border-radius:50%;background:rgba(0,0,0,.45);transform:translate(-50%,-50%);pointer-events:none;z-index:599;transition:all .18s cubic-bezier(.2,.8,.3,1);filter:blur(1.5px)}'
    + '.mythos-cpin-sh.lift{width:9px;height:5px;opacity:.55}';
  document.head.appendChild(s);
}

/* ── MapEditor ── */
function MapEditor({zones, restaurant, onSave, onClose}) {
  const mapDivRef = useRef(null);
  const mapRef    = useRef(null);
  const pinElRef  = useRef(null);   // overlay SVG del pin central (no es un marker de Leaflet)
  const shElRef   = useRef(null);   // sombra del pin
  const circlesRef= useRef({});
  const latRef    = useRef(restaurant?.lat || -25.2867);
  const lngRef    = useRef(restaurant?.lng || -57.6470);
  const suppressGeoRef = useRef(false); // moveend programático (search/GPS) no re-geocodifica

  const ZCLR = {red:'#EF4444',orange:'#F97316',yellow:'#EAB308',green:'#22C55E'};
  const ZLBL = {red:'Roja',orange:'Naranja',yellow:'Amarilla',green:'Verde'};

  const [editZones, setEditZones] = useState(()=>zones.map(z=>({
    ...z, radius_km: z.radius_km||z.radius||3, price: z.price||0, time: z.time||30, color: z.color||'red'
  })));
  const [activeIdx, setActiveIdx] = useState(0);
  const activeIdxRef = useRef(0);
  const setActive = (i) => { activeIdxRef.current = i; setActiveIdx(i); if(mapRef.current) mapRef.current._activeIdxRef = activeIdxRef; };
  const [saving, setSaving] = useState(false);
  const [geoBusy, setGeoBusy] = useState(false);
  const [hint, setHint] = useState(zones.length
    ? 'Tocá el mapa para definir el alcance de la zona activa'
    : 'Mové el mapa (o usá "Mi ubicación") para centrar el pin en el local');

  // Bloquear polling global mientras el editor esté abierto
  useEffect(()=>{ _modalCount++; return ()=>{ _modalCount=Math.max(0,_modalCount-1); }; },[]);

  // Buscador de lugares — Google Places API o Nominatim (fallback).
  // La key REAL del proyecto la inyecta build.sh en window.MYTHOS_CONFIG.googleMapsApiKey
  // (env var GOOGLE_MAPS_API_KEY) — la misma que usa el panel cliente. Se mantiene el
  // path viejo como fallback defensivo y se limpia BOM/espacios.
  const GKEY = (window.MYTHOS_CONFIG?.googleMapsApiKey || window.SUPABASE_CONFIG?.googleMapsKey || '').replace(/^﻿/, '').trim();
  const [searchQ, setSearchQ]     = useState('');
  const [searchRes, setSearchRes] = useState([]);
  const [searching, setSearching] = useState(false);
  const [gmapsReady, setGmapsReady] = useState(false);
  const searchTimer  = useRef(null);
  const autoSvcRef   = useRef(null);  // google.maps.places.AutocompleteService
  const placesSvcRef = useRef(null);  // google.maps.places.PlacesService
  const placesDivRef = useRef(null);  // nodo oculto requerido por PlacesService

  function _initGooglePlaces() {
    if(!window.google?.maps?.places) return;
    autoSvcRef.current  = new window.google.maps.places.AutocompleteService();
    const dummyMap = new window.google.maps.Map(placesDivRef.current||document.createElement('div'),{center:{lat:-25.28,lng:-57.64},zoom:12});
    placesSvcRef.current = new window.google.maps.places.PlacesService(dummyMap);
    setGmapsReady(true);
  }

  useEffect(()=>{
    if(!GKEY) return;
    if(window.google?.maps?.places){ _initGooglePlaces(); return; }
    const existing = document.querySelector('script[data-gmaps-places]');
    if(existing){ existing.addEventListener('load',_initGooglePlaces); return; }
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${GKEY}&libraries=places&language=es`;
    s.async = true; s.setAttribute('data-gmaps-places','1');
    s.onload = _initGooglePlaces;
    document.head.appendChild(s);
  },[]);

  // Recentra el mapa (el pin fijo del centro = local). geocode=false → el moveend
  // NO reverse-geocodifica ni pisa searchQ (el llamador ya tiene un nombre mejor:
  // búsqueda por Places o su propio geocode). El moveend actualiza latRef/lngRef
  // y reposiciona los círculos de zona sobre el nuevo centro.
  function _movePinTo(lat, lng, geocode = false) {
    if(!mapRef.current||isNaN(lat)||isNaN(lng)) return;
    // Fijar coords + recentrar círculos de inmediato (no esperar al moveend de la
    // animación) para que "Guardar" nunca use coordenadas viejas.
    latRef.current = lat; lngRef.current = lng;
    Object.values(circlesRef.current).forEach(c=>c.setLatLng([lat,lng]));
    suppressGeoRef.current = !geocode;
    setTimeout(()=>{ suppressGeoRef.current = false; }, 500); // fallback si setView no movió el centro
    mapRef.current.setView([lat,lng],17,{animate:true});
  }

  function handleSearchChange(q) {
    setSearchQ(q);
    clearTimeout(searchTimer.current);
    if(!q.trim()){ setSearchRes([]); return; }
    searchTimer.current = setTimeout(()=>{
      setSearching(true);
      if(autoSvcRef.current) {
        // Google Places: encuentra negocios por nombre en cualquier lugar
        autoSvcRef.current.getPlacePredictions(
          {input:q, language:'es'},
          (predictions, status)=>{
            setSearching(false);
            if(status==='OK'&&predictions){
              setSearchRes(predictions.map(p=>({
                _type:'google',
                place_id: p.place_id,
                main: p.structured_formatting.main_text,
                secondary: p.structured_formatting.secondary_text||'',
              })));
            } else { setSearchRes([]); }
          }
        );
      } else {
        // Fallback: Nominatim / OpenStreetMap (cobertura limitada en PY)
        fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=6&accept-language=es&addressdetails=1`)
          .then(r=>r.json())
          .then(data=>{
            const items = (Array.isArray(data)?data:[]).map(d=>({
              _type:'osm', place_id:null,
              main: d.display_name.split(',').slice(0,2).join(',').trim(),
              secondary: d.display_name.split(',').slice(2,5).join(',').trim(),
              lat:d.lat, lon:d.lon,
            }));
            setSearchRes(items); setSearching(false);
          })
          .catch(()=>{ setSearchRes([]); setSearching(false); });
      }
    }, 420);
  }

  // "Usar mi ubicación": geolocaliza, centra/suelta el pin del local y muestra la
  // dirección (reverse geocode). Degradación elegante si el permiso es negado.
  function useMyLocation() {
    if(!navigator.geolocation){ setHint('Tu navegador no permite ubicación automática — movés el pin a mano.'); return; }
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      async (pos)=>{
        const { latitude, longitude } = pos.coords;
        _movePinTo(latitude, longitude);
        setHint('Ubicación detectada — guardá para confirmar');
        const addr = await reverseGeocode(latitude, longitude);
        if(addr){ setSearchQ(addr); setHint(`${addr} — guardá para confirmar`); }
        setGeoBusy(false);
      },
      ()=>{ setGeoBusy(false); setHint('No pudimos acceder a tu ubicación. Movés el pin a mano o buscás por nombre.'); },
      { timeout: 8000, enableHighAccuracy: true }
    );
  }

  function goToPlace(item) {
    if(item._type==='google' && placesSvcRef.current) {
      placesSvcRef.current.getDetails(
        {placeId:item.place_id, fields:['geometry','name','formatted_address']},
        (place, status)=>{
          if(status!=='OK'||!place?.geometry) return;
          _movePinTo(place.geometry.location.lat(), place.geometry.location.lng());
          setSearchQ(place.name||item.main);
          setSearchRes([]);
          setHint(`${place.name||item.main} — guardá para confirmar`);
        }
      );
    } else {
      _movePinTo(parseFloat(item.lat||0), parseFloat(item.lon||0));
      setSearchQ(item.main);
      setSearchRes([]);
      setHint('Ubicación actualizada — guardá para confirmar');
    }
  }

  useEffect(()=>{
    if(!mapDivRef.current||!window.L) return;
    _ensurePinCss();
    const L = window.L;
    const lat0 = latRef.current, lng0 = lngRef.current;
    let dark = _mapIsDark();
    const map = L.map(mapDivRef.current,{zoomControl:true}).setView([lat0,lng0], editZones.length?13:16);
    let tiles = _addBaseTiles(map, dark);
    if(pinElRef.current) pinElRef.current.innerHTML = _pinSvg(dark);

    // Círculos de zonas (orden inverso: externo primero para que internos queden encima)
    const sorted = [...editZones].map((z,i)=>({...z,origIdx:i})).sort((a,b)=>(b.radius_km||99)-(a.radius_km||99));
    sorted.forEach(z=>{
      const clr = ZCLR[z.color]||'#EF4444';
      const c = L.circle([lat0,lng0],{
        radius:(z.radius_km||3)*1000,
        color:clr, fillColor:clr, fillOpacity:0.08, weight:2.5
      }).addTo(map).bindTooltip(`${ZLBL[z.color]||z.color} — ${z.name}`,{permanent:false,sticky:true});
      circlesRef.current[z.origIdx] = c;
    });

    // Pin FIJO al centro (patrón Uber/Bolt): el local = centro del mapa. Al mover el
    // mapa, moveend fija latRef/lngRef y recentra los círculos sobre el nuevo centro.
    let ready = false;
    const lift = (on) => {
      if(pinElRef.current) pinElRef.current.classList.toggle('lift', on);
      if(shElRef.current)  shElRef.current.classList.toggle('lift', on);
    };
    map.on('movestart', ()=> lift(true));
    map.on('moveend', async ()=>{
      lift(false);
      const {lat,lng} = map.getCenter();
      latRef.current = lat; lngRef.current = lng;
      Object.values(circlesRef.current).forEach(c=>c.setLatLng([lat,lng]));
      if(!ready) return;
      if(suppressGeoRef.current){ suppressGeoRef.current = false; return; }
      setHint('Ubicación del local actualizada — guardá para confirmar');
      const addr = await reverseGeocode(lat,lng);
      if(addr) setSearchQ(addr);
    });

    // Click (tap sin arrastre) en mapa → radio de zona activa = distancia centro→click
    map._activeIdxRef = activeIdxRef;
    map.on('click',e=>{
      const idx = map._activeIdxRef.current;
      if(!circlesRef.current[idx]) return;   // sin zona activa (p.ej. solo ubicando el local) → el toque no hace nada
      const centerLL = map.getCenter();
      const distM = centerLL.distanceTo(e.latlng);
      const distKm = Math.max(0.3, Math.round(distM/100)/10);
      setEditZones(pz=>pz.map((z,i)=>{
        if(i!==idx) return z;
        if(circlesRef.current[i]) circlesRef.current[i].setRadius(distKm*1000);
        return {...z,radius_km:distKm};
      }));
      setHint(`✓ Radio actualizado a ${distKm} km`);
    });

    // Cambio de tema en vivo → intercambiar tiles + recolorear el pin.
    const off = (window.MythosTheme && window.MythosTheme.onChange)
      ? window.MythosTheme.onChange((mode)=>{
          dark = mode === 'dark';
          try { map.removeLayer(tiles); } catch(_){}
          tiles = _addBaseTiles(map, dark);
          if(pinElRef.current) pinElRef.current.innerHTML = _pinSvg(dark);
        })
      : null;

    // Evitar que eventos del mapa burbujeen al DOM de React
    window.L.DomEvent.disableClickPropagation(mapDivRef.current);
    window.L.DomEvent.disableScrollPropagation(mapDivRef.current);

    mapRef.current = map;
    const t = setTimeout(()=>{ try{ map.invalidateSize({pan:false}); }catch(_){} ready = true; }, 150);
    return ()=>{ clearTimeout(t); if(off) off(); map.remove(); mapRef.current=null; circlesRef.current={}; };
  },[]);

  const updateRadius = (idx,km)=>{
    const v = Math.max(0.3,Math.min(50,parseFloat(km)||0.3));
    setEditZones(pz=>pz.map((z,i)=>i===idx?{...z,radius_km:v}:z));
    if(circlesRef.current[idx]) circlesRef.current[idx].setRadius(v*1000);
  };

  const handleSave = async ()=>{
    setSaving(true);
    const lat = latRef.current, lng = lngRef.current;
    if(db){
      // Actualizar lat/lng del restaurante
      await db.from('restaurants').update({lat,lng}).eq('id',RID);
      // Upsert zonas
      const isUUID = s => typeof s==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s);
      for(const z of editZones){
        const payload = {
          restaurant_id:RID, name:z.name, radius_km:z.radius_km,
          price_guarani:Number(z.price)||0, estimated_minutes:Number(z.time)||30,
          is_active:z.active!==false, color:z.color||'red'
        };
        if(isUUID(z.id)){
          await db.from('delivery_zones').update(payload).eq('id',z.id);
        } else {
          await db.from('delivery_zones').insert(payload);
        }
      }
    }
    onSave(lat, lng, editZones);
    setSaving(false);
  };

  const az = editZones[activeIdx] || editZones[0];
  const azClr = ZCLR[az?.color]||'#EF4444';

  return (
    <div
      style={{position:'fixed',inset:0,zIndex:9999,background:'rgba(0,0,0,0.7)',display:'flex',alignItems:'center',justifyContent:'center',padding:16}}
      onClick={e=>e.stopPropagation()}
      onMouseDown={e=>e.stopPropagation()}
      onTouchStart={e=>e.stopPropagation()}
      onPointerDown={e=>e.stopPropagation()}
    >
      <div style={{background:C.surface,borderRadius:16,width:'100%',maxWidth:700,maxHeight:'92vh',display:'flex',flexDirection:'column',overflow:'hidden',boxShadow:'0 32px 80px rgba(0,0,0,0.4)'}}>
        {/* Header */}
        <div style={{padding:'16px 20px',borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
          <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:12}}>
            <div>
              <div style={{fontSize:17,fontWeight:800,color:C.ink}}>Ubicación del local{zones.length?' y zonas':''}</div>
              <div style={{fontSize:12,color:C.dim,marginTop:2}}>Buscá por nombre · Usá tu ubicación · Mové el mapa{zones.length?' · Tocá el mapa para ajustar radios':''}</div>
            </div>
            <button onClick={e=>{e.stopPropagation();onClose();}} style={{background:C.bg,border:'none',borderRadius:8,width:32,height:32,cursor:'pointer',fontSize:18,color:C.dim,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,marginLeft:12}}>×</button>
          </div>
          {/* Nodo oculto requerido por Google PlacesService */}
          <div ref={placesDivRef} style={{display:'none'}}/>

          {/* Buscador de lugares */}
          <div style={{position:'relative'}}>
            <div style={{display:'flex',alignItems:'center',gap:8,background:C.bg,border:`1.5px solid ${gmapsReady?'#A3D9B1':'#D2D2D7'}`,borderRadius:10,padding:'9px 12px'}}>
              <span style={{flexShrink:0,display:'flex',color:C.mid}}><Icon name="search" size={16}/></span>
              <input
                value={searchQ}
                onChange={e=>handleSearchChange(e.target.value)}
                placeholder={gmapsReady?'Buscar por nombre del local… (ej: Terrapizza Fernando de la Mora)':'Buscar por dirección o ciudad…'}
                style={{flex:1,background:'none',border:'none',fontSize:13,outline:'none',color:C.ink,minWidth:0}}
                onKeyDown={e=>{ if(e.key==='Escape'){setSearchQ('');setSearchRes([]);} }}
              />
              {searching&&<span className="spin" style={{width:14,height:14,borderWidth:1.5,flexShrink:0}}/>}
              {!searching&&(
                gmapsReady
                  ?<span style={{fontSize:10,fontWeight:700,color:TINT.greenText,background:TINT.greenBg,border:`1px solid ${TINT.greenBorder}`,borderRadius:5,padding:'2px 6px',flexShrink:0,whiteSpace:'nowrap'}}>Google ✓</span>
                  :<span style={{fontSize:10,fontWeight:600,color:C.dim,background:C.card,borderRadius:5,padding:'2px 6px',flexShrink:0,whiteSpace:'nowrap'}}>OSM</span>
              )}
              {searchQ&&!searching&&(
                <button onClick={()=>{setSearchQ('');setSearchRes([]);}} style={{background:'none',border:'none',color:C.dim,cursor:'pointer',fontSize:17,lineHeight:1,padding:0,flexShrink:0}}>×</button>
              )}
            </div>

            {/* Usar mi ubicación (geolocalización del dispositivo) */}
            <button onClick={useMyLocation} disabled={geoBusy} style={{marginTop:8,width:'100%',display:'flex',alignItems:'center',justifyContent:'center',gap:8,height:38,background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,color:C.ink,fontSize:13,fontWeight:700,cursor:geoBusy?'default':'pointer',opacity:geoBusy?0.6:1,fontFamily:'inherit'}}>
              {geoBusy ? <span className="spin" style={{width:14,height:14,borderWidth:1.5}}/> : <Icon name="pin" size={15}/>}
              {geoBusy ? 'Detectando…' : 'Usar mi ubicación'}
            </button>

            {/* Con key → Google Places activo (badge ✓, sin aviso). Sin key → fallback OSM + cómo activarlo. */}
            {!GKEY&&(
              <div style={{marginTop:6,padding:'7px 10px',background:TINT.amberBg,border:`1px solid ${TINT.amberBorder}`,borderRadius:7,fontSize:11,color:TINT.amberText,display:'flex',gap:6,alignItems:'flex-start'}}>
                <span style={{flexShrink:0,display:'flex'}}><Icon name="alert" size={13}/></span>
                <span>Búsqueda por dirección (OpenStreetMap). Para buscar negocios por nombre, configurá la env var <code style={{fontFamily:"'SF Mono',monospace",fontSize:10}}>GOOGLE_MAPS_API_KEY</code> en Vercel (Maps JS + Places API).</span>
              </div>
            )}

            {searchRes.length>0&&(
              <div style={{position:'absolute',left:0,right:0,top:'calc(100% + 4px)',background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,boxShadow:'0 8px 28px rgba(0,0,0,0.14)',zIndex:99999,overflow:'hidden',maxHeight:260,overflowY:'auto'}}>
                {searchRes.map((r,i)=>(
                  <button key={i} onClick={()=>goToPlace(r)}
                    style={{display:'block',width:'100%',padding:'10px 14px',textAlign:'left',background:'none',border:'none',borderBottom:i<searchRes.length-1?'1px solid #F0F0F0':'none',cursor:'pointer',fontFamily:'inherit'}}
                    onMouseEnter={e=>e.currentTarget.style.background='var(--bg-subtle)'}
                    onMouseLeave={e=>e.currentTarget.style.background='none'}>
                    <div style={{fontSize:13,fontWeight:600,color:C.ink,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}><Icon name="pin" size={12} style={{verticalAlign:'-2px',marginRight:2}}/> {r.main}</div>
                    {r.secondary&&<div style={{fontSize:11,color:C.dim,marginTop:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.secondary}</div>}
                  </button>
                ))}
              </div>
            )}
            {searchQ.trim()&&!searching&&searchRes.length===0&&(
              <div style={{position:'absolute',left:0,right:0,top:'calc(100% + 4px)',background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:'14px',textAlign:'center',color:C.dim,fontSize:12,zIndex:99999}}>
                Sin resultados — intentá con otro nombre o ciudad
              </div>
            )}
          </div>
        </div>

        {/* Mapa */}
        <div style={{position:'relative',flexShrink:0}}>
          <div ref={mapDivRef} style={{height:320,width:'100%',touchAction:'none'}}/>
          {/* Pin FIJO al centro (overlay, pointer-events:none → no bloquea el mapa) */}
          <div ref={shElRef} className="mythos-cpin-sh" />
          <div ref={pinElRef} className="mythos-cpin" />
          {/* Hint overlay */}
          <div style={{position:'absolute',bottom:8,left:'50%',transform:'translateX(-50%)',background:'rgba(0,0,0,0.65)',color:'#fff',borderRadius:20,padding:'5px 14px',fontSize:11,fontWeight:600,pointerEvents:'none',whiteSpace:'nowrap',maxWidth:'90%',overflow:'hidden',textOverflow:'ellipsis'}}>
            {hint}
          </div>
          {/* Tabs de zona superpuestos sobre el mapa */}
          <div style={{position:'absolute',top:8,right:8,display:'flex',flexDirection:'column',gap:4}}>
            {editZones.map((z,i)=>(
              <button key={i} onClick={()=>{ setActive(i); setHint(`Zona ${ZLBL[z.color]||z.name} activa — tocá el mapa para ajustar radio`); }} style={{background:activeIdx===i?ZCLR[z.color]||'#EF4444':'rgba(255,255,255,0.92)',border:`2px solid ${ZCLR[z.color]||'#EF4444'}`,borderRadius:20,padding:'4px 10px',fontSize:11,fontWeight:800,cursor:'pointer',color:activeIdx===i?'#fff':ZCLR[z.color]||'#EF4444',transition:'all 150ms',boxShadow:'0 2px 8px rgba(0,0,0,0.2)'}}>
                {ZLBL[z.color]||'Zona'} {z.radius_km} km
              </button>
            ))}
          </div>
        </div>

        {/* Panel de edición zona activa */}
        <div style={{flex:1,overflowY:'auto',padding:'16px 20px'}}>
          {editZones.length===0 && (
            <div style={{background:'var(--bg-subtle)',border:`1px solid ${C.border}`,borderRadius:10,padding:'14px 16px',fontSize:13,color:C.dim,lineHeight:1.6}}>
              Estás fijando la <strong style={{color:C.ink}}>ubicación del local</strong>. Buscala por nombre, usá “Mi ubicación” o mové el mapa hasta centrar el pin, y guardá. Las zonas de delivery las agregás después en la tarjeta de Zonas.
            </div>
          )}
          {/* Tabs selector */}
          <div style={{display:'flex',gap:6,marginBottom:16,flexWrap:'wrap'}}>
            {editZones.map((z,i)=>{
              const clr=ZCLR[z.color]||'#EF4444';
              return (
                <button key={i} onClick={()=>setActive(i)} style={{display:'flex',alignItems:'center',gap:6,padding:'6px 14px',border:`2px solid ${activeIdx===i?clr:'#E5E5EA'}`,borderRadius:20,background:activeIdx===i?clr+'18':'transparent',cursor:'pointer',fontSize:12,fontWeight:700,color:activeIdx===i?clr:'#86868B',transition:'all 150ms'}}>
                  <span style={{width:10,height:10,borderRadius:'50%',background:clr,display:'inline-block'}}/>
                  {ZLBL[z.color]||z.name}
                </button>
              );
            })}
          </div>

          {az && (
            <div style={{background:'var(--bg-subtle)',border:`2px solid ${azClr}33`,borderRadius:12,padding:16}}>
              <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
                <span style={{width:14,height:14,borderRadius:'50%',background:azClr,display:'inline-block',flexShrink:0}}/>
                <span style={{fontSize:14,fontWeight:800,color:C.ink}}>{az.name}</span>
                <span style={{fontSize:11,color:C.dim}}>{ZLBL[az.color]||az.color}</span>
              </div>

              {/* Radio con slider */}
              <div style={{marginBottom:14}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                  <span style={{fontSize:12,fontWeight:700,color:C.dim,textTransform:'uppercase',letterSpacing:1}}>Radio</span>
                  <span style={{fontSize:15,fontWeight:800,color:azClr}}>{az.radius_km} km</span>
                </div>
                <input type="range" min="0.3" max="50" step="0.1" value={az.radius_km||3}
                  onChange={e=>updateRadius(activeIdx,parseFloat(e.target.value))}
                  style={{width:'100%',accentColor:azClr}}
                />
                <div style={{display:'flex',justifyContent:'space-between',fontSize:10,color:C.dim,marginTop:2}}>
                  <span>0.3 km</span><span>25 km</span><span>50 km</span>
                </div>
              </div>

              {/* Precio y tiempo */}
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                <div>
                  <div style={{fontSize:11,fontWeight:700,color:C.dim,textTransform:'uppercase',letterSpacing:1,marginBottom:4}}>Precio delivery (₲)</div>
                  <MoneyInp value={az.price||0}
                    onChange={v=>setEditZones(pz=>pz.map((z,i)=>i===activeIdx?{...z,price:v}:z))}
                    style={{width:'100%',height:40,border:`1.5px solid ${azClr}44`,borderRadius:8,padding:'0 10px',fontSize:14,fontWeight:700,outline:'none'}}
                  />
                </div>
                <div>
                  <div style={{fontSize:11,fontWeight:700,color:C.dim,textTransform:'uppercase',letterSpacing:1,marginBottom:4}}>Tiempo estimado (min)</div>
                  <input type="number" value={az.time||30}
                    onChange={e=>setEditZones(pz=>pz.map((z,i)=>i===activeIdx?{...z,time:Number(e.target.value)}:z))}
                    style={{width:'100%',height:40,border:`1.5px solid ${azClr}44`,borderRadius:8,padding:'0 10px',fontSize:14,fontWeight:700,outline:'none'}}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{padding:'12px 20px 16px',borderTop:`1px solid ${C.border}`,flexShrink:0,display:'flex',gap:8}}>
          <button onClick={handleSave} disabled={saving} style={{flex:1,height:44,background:C.ink,color:C.sidebar,border:'none',borderRadius:10,fontSize:14,fontWeight:800,cursor:saving?'default':'pointer',opacity:saving?0.6:1,fontFamily:'inherit'}}>
            {saving?'Guardando…':(editZones.length?'Guardar ubicación y zonas':'Guardar ubicación del local')}
          </button>
          <button onClick={onClose} style={{height:44,padding:'0 18px',background:'transparent',color:C.dim,border:'1.5px solid #E5E5EA',borderRadius:10,fontSize:13,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}}>Cancelar</button>
        </div>
      </div>
    </div>
  );
}

/* ── DelivConfig ── */
const PRICING_MODE_OPTS = [
  {v:'fixed',     label:'Tarifa fija',      desc:'Un precio único de envío'},
  {v:'radial_km', label:'Por km a la redonda', desc:'Base + ₲/km en línea recta'},
  {v:'route_km',  label:'Por km recorrido', desc:'Distancia real de manejo (Google)'},
  {v:'zone',      label:'Por zonas',        desc:'Bandas por radio desde el local'},
];
// Modos ocultos (mismo patrón reversible que PENDING_ADDONS: Bancard/Facturación).
// 'route_km' depende de Google Distance Matrix (API paga) y hoy cae a línea recta,
// así que se oculta de las opciones del dueño hasta habilitar/pagar esa API.
// ► Reactivar = vaciar este array: [] (no se borra código; queda todo listo).
const PENDING_PRICING_MODES = ['route_km'];
// Normaliza el modo leído: un restaurante que YA tenía elegido un modo oculto
// (p.ej. 'route_km') cae a 'Por km a la redonda' sin tocar la DB (fallback en lectura).
const effectivePricingMode = m => PENDING_PRICING_MODES.includes(m) ? 'radial_km' : (m || 'zone');
function pricingFromSettings(s){
  return {
    pricing_mode:     effectivePricingMode(s?.pricing_mode),
    base_fee:         s?.base_fee ?? 0,
    price_per_km:     s?.price_per_km ?? 0,
    min_fee:          s?.min_fee ?? 0,
    max_km:           (s?.max_km ?? '') === null ? '' : (s?.max_km ?? ''),
    free_over_amount: (s?.free_over_amount ?? '') === null ? '' : (s?.free_over_amount ?? ''),
    round_to:         s?.round_to ?? 500,
    // Alerta de cola: máximo de pedidos por rider (mig 156). Vacío = sin límite.
    max_orders_per_rider: (s?.max_orders_per_rider ?? '') === null ? '' : (s?.max_orders_per_rider ?? ''),
  };
}
function DelivConfig({zones, setZones, channels, setChannels, reloadChannels, restaurant, setRestaurant, settings, onSaveSettings}) {
  const [zoneModal,setZoneModal] = useState(null);
  const [chanModal,setChanModal] = useState(null);
  const [mapOpen,setMapOpen] = useState(false);
  const [zForm,setZForm] = useState({name:'',radius:'',price:0,time:30,active:true,color:'red'});
  const [cForm,setCForm] = useState({name:'',commission:0,color:C.ink,active:true});

  // ── Modo de cotización (mig 124) ──
  const [pm,setPm] = useState(()=>pricingFromSettings(settings));
  const [savingPm,setSavingPm] = useState(false);
  useEffect(()=>{ if(settings) setPm(pricingFromSettings(settings)); },[settings]);
  const pf = (k,v)=>setPm(p=>({...p,[k]:v}));
  const byKm = pm.pricing_mode==='radial_km' || pm.pricing_mode==='route_km';
  const needsLoc = byKm && (!restaurant?.lat || !restaurant?.lng);
  async function handleSavePm(){
    // No persistir un modo por km sin ubicación del local: el cliente cotizaría
    // la distancia desde un origen inválido. Forzar a fijar el pin primero.
    if(byKm && needsLoc){
      toast('Configurá primero la ubicación del local (Editor de mapa, en la tarjeta de Zonas) para cotizar por distancia.',false);
      return;
    }
    setSavingPm(true);
    const r = onSaveSettings ? await onSaveSettings(pm) : {ok:false};
    setSavingPm(false);
    if(r?.ok) toast('Modo de cotización guardado');
    else toast('No se pudo guardar la configuración'+(r?.error?.message?` · ${r.error.message}`:'')+'. Verificá que las migraciones 124 y 156 estén aplicadas.',false);
  }

  function saveZone() {
    if(!zForm.name.trim()){toast('El nombre es obligatorio',false);return;}
    const zone={id:zoneModal==='new'?Date.now().toString():zoneModal.id,...zForm,price:Number(zForm.price),time:Number(zForm.time),radius:zForm.radius?Number(zForm.radius):null};
    if(zoneModal==='new') setZones([...zones,zone]);
    else setZones(zones.map(z=>z.id===zoneModal.id?zone:z));
    toast(zoneModal==='new'?'Zona creada':'Zona actualizada'); setZoneModal(null);
  }

  function deleteZone(id) { if(!confirm('¿Eliminar esta zona?'))return; setZones(zones.filter(z=>z.id!==id)); toast('Zona eliminada'); }

  async function saveChan() {
    if(!cForm.name.trim()){toast('El nombre es obligatorio',false);return;}
    if(!db){toast('Sin conexión',false);return;}
    const commission = Number(cForm.commission)||0;
    if(chanModal==='new'){
      // slug estable derivado del nombre; único por tenant (mig 162). Colisión → sufijo.
      const base = cForm.name.trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'') || 'canal';
      const payload = {restaurant_id:RID, name:cForm.name.trim(), slug:base, commission_pct:commission, color:cForm.color||'#8E8E93', is_active:cForm.active!==false};
      let {error} = await db.from('delivery_channels').insert(payload);
      if(error && /duplicate|unique|23505/i.test(`${error.message||''} ${error.code||''}`)){
        const retry = await db.from('delivery_channels').insert({...payload, slug:base+'_'+Date.now().toString(36)});
        error = retry.error;
      }
      if(error){toast('No se pudo crear el canal: '+error.message+(/relation|does not exist|schema cache|PGRST205/i.test(`${error.message} ${error.code||''}`)?' — aplicá la migración 162':''),false);return;}
    } else {
      // Editar NO cambia el slug: es la identidad congelada en los pedidos históricos.
      if(!chanModal.uuid){toast('Canal por defecto (sin id de DB) — aplicá la migración 162 y recargá',false);return;}
      const {error} = await db.from('delivery_channels').update({name:cForm.name.trim(), commission_pct:commission, color:cForm.color||'#8E8E93', is_active:cForm.active!==false}).eq('id',chanModal.uuid);
      if(error){toast('No se pudo actualizar: '+error.message,false);return;}
    }
    toast(chanModal==='new'?'Canal creado':'Canal actualizado');
    setChanModal(null);
    if(reloadChannels) await reloadChannels();
  }

  async function toggleChan(c) {
    if(!db||!c?.uuid){toast('Canal por defecto — aplicá la migración 162',false);return;}
    const {error} = await db.from('delivery_channels').update({is_active:!c.active}).eq('id',c.uuid);
    if(error){toast('No se pudo cambiar el estado: '+error.message,false);return;}
    if(reloadChannels) await reloadChannels();
  }

  return (
    <div style={{display:'flex',flexDirection:'column',gap:20,maxWidth:820}}>

      {/* ── Modo de cotización de delivery (mig 124) ── */}
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
        <div style={{padding:'14px 18px',borderBottom:`1px solid ${C.border}`}}>
          <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1}}>MODO DE COTIZACIÓN DE DELIVERY</div>
          <div style={{fontSize:12,color:C.dim,marginTop:4}}>Cómo se calcula el costo de envío que ve el cliente al marcar su ubicación, antes de pagar.</div>
        </div>
        <div style={{padding:18,display:'flex',flexDirection:'column',gap:16}}>
          {/* Selector de modo */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:8}}>
            {PRICING_MODE_OPTS.filter(opt=>!PENDING_PRICING_MODES.includes(opt.v)).map(opt=>{
              const sel = pm.pricing_mode===opt.v;
              return (
                <button key={opt.v} onClick={()=>pf('pricing_mode',opt.v)} style={{textAlign:'left',padding:'12px 14px',border:`2px solid ${sel?C.ink:C.border}`,borderRadius:10,background:sel?'var(--bg-subtle)':'transparent',cursor:'pointer',transition:'all 150ms'}}>
                  <div style={{fontSize:13,fontWeight:800,color:sel?C.ink:C.mid}}>{opt.label}</div>
                  <div style={{fontSize:11,color:C.dim,marginTop:2}}>{opt.desc}</div>
                </button>
              );
            })}
          </div>

          {/* Aviso: ubicación del local requerida para cotizar por distancia */}
          {needsLoc && (
            <div style={{padding:'9px 12px',background:TINT.amberBg,border:`1px solid ${TINT.amberBorder}`,borderRadius:8,fontSize:12,color:TINT.amberText,display:'flex',gap:8,alignItems:'center',lineHeight:1.4}}>
              <span style={{flexShrink:0,display:'flex'}}><Icon name="alert" size={14}/></span>
              Configurá la ubicación del local para cotizar por distancia (abrí el <strong>Editor de mapa</strong> en la tarjeta de Zonas y guardá el pin del local).
            </div>
          )}

          {/* Campos según modo */}
          {pm.pricing_mode==='fixed' && (
            <div style={{maxWidth:280}}><Lbl>TARIFA FIJA (₲)</Lbl><MoneyInp value={pm.base_fee} onChange={v=>pf('base_fee',v)} placeholder="15000" style={{border:`1px solid ${C.border}`,color:C.ink,background:C.surface,outline:'none'}}/></div>
          )}

          {byKm && (
            <>
              {pm.pricing_mode==='route_km' && (
                <div style={{padding:'9px 12px',background:TINT.amberBg,border:`1px solid ${TINT.amberBorder}`,borderRadius:8,fontSize:11,color:TINT.amberText,lineHeight:1.5}}>
                  Requiere activar <strong>Distance Matrix de Google</strong> (pago por cotización). Hasta activarlo, el cliente cotiza con la distancia en línea recta.
                </div>
              )}
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
                <div><Lbl>CARGO BASE (₲)</Lbl><MoneyInp value={pm.base_fee} onChange={v=>pf('base_fee',v)} placeholder="5000" style={{border:`1px solid ${C.border}`,color:C.ink,background:C.surface,outline:'none'}}/></div>
                <div><Lbl>PRECIO POR KM (₲)</Lbl><MoneyInp value={pm.price_per_km} onChange={v=>pf('price_per_km',v)} placeholder="3000" style={{border:`1px solid ${C.border}`,color:C.ink,background:C.surface,outline:'none'}}/></div>
                <div><Lbl>COBRO MÍNIMO (₲)</Lbl><MoneyInp value={pm.min_fee} onChange={v=>pf('min_fee',v)} placeholder="10000" style={{border:`1px solid ${C.border}`,color:C.ink,background:C.surface,outline:'none'}}/></div>
                <div><Lbl>DISTANCIA MÁX (km · vacío = sin límite)</Lbl><Inp type="number" value={pm.max_km} onChange={e=>pf('max_km',e.target.value)} placeholder="10" style={{border:`1px solid ${C.border}`,color:C.ink,background:C.surface,outline:'none'}}/></div>
                <div><Lbl>REDONDEO (₲)</Lbl><MoneyInp value={pm.round_to} onChange={v=>pf('round_to',v)} placeholder="500" style={{border:`1px solid ${C.border}`,color:C.ink,background:C.surface,outline:'none'}}/></div>
                <div><Lbl>ENVÍO GRATIS DESDE (₲ · opcional)</Lbl><MoneyInp value={pm.free_over_amount} onChange={v=>pf('free_over_amount',v)} placeholder="100000" style={{border:`1px solid ${C.border}`,color:C.ink,background:C.surface,outline:'none'}}/></div>
              </div>
            </>
          )}

          {pm.pricing_mode==='zone' && (
            <div style={{fontSize:12,color:C.dim,lineHeight:1.6}}>
              El costo se calcula por las <strong>zonas de cobertura</strong> definidas abajo (banda por radio desde el local, con su precio y tiempo). Editá las zonas en la tarjeta siguiente.
            </div>
          )}

          {/* Alerta de cola por rider (mig 156) — aplica a todos los modos */}
          <div style={{borderTop:`1px solid ${C.border}`,paddingTop:14,marginTop:2}}>
            <div style={{maxWidth:320}}>
              <Lbl>MÁXIMO DE PEDIDOS EN COLA POR RIDER</Lbl>
              <Inp type="number" min="0" value={pm.max_orders_per_rider} onChange={e=>pf('max_orders_per_rider',e.target.value)} placeholder="vacío = sin límite" style={{border:`1px solid ${C.border}`,color:C.ink,background:C.surface,outline:'none'}}/>
              <div style={{fontSize:11,color:C.dim,marginTop:4,lineHeight:1.5}}>Si un rider supera esta cantidad de pedidos activos (en bolsón + en cola), te avisamos en la pestaña <strong>Riders</strong>. Vacío o 0 = sin límite.</div>
            </div>
          </div>

          <div style={{display:'flex',alignItems:'center',gap:12}}>
            <Btn onClick={handleSavePm} disabled={savingPm}>{savingPm?'Guardando…':'Guardar configuración'}</Btn>
            <span style={{fontSize:11,color:C.dim}}>Modo actual: <strong style={{color:C.mid}}>{(PRICING_MODE_OPTS.find(o=>o.v===effectivePricingMode(settings?.pricing_mode))||{}).label}</strong></span>
          </div>
        </div>
      </div>

      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
        <div style={{padding:'14px 18px',borderBottom:`1px solid ${C.border}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1}}>ZONAS DE COBERTURA</div>
          <div style={{display:'flex',gap:6}}>
            <Btn small variant="secondary" onClick={()=>setMapOpen(true)}><Icon name="pin" size={13} style={{verticalAlign:'-2px',marginRight:4}}/>Editor de mapa</Btn>
            <Btn small onClick={()=>{setZForm({name:'',radius:'',price:0,time:30,active:true,color:'red'});setZoneModal('new');}}>+ Agregar zona</Btn>
          </div>
        </div>
        {zones.length===0
          ? <div style={{padding:32,textAlign:'center',color:C.dim,fontSize:13}}>Sin zonas configuradas</div>
          : <table style={{width:'100%',borderCollapse:'collapse'}}>
              <thead><tr style={{borderBottom:`1px solid ${C.border}`,background:'var(--bg-subtle)'}}><Th>Zona</Th><Th>Radio</Th><Th right>Precio delivery</Th><Th right>Tiempo est.</Th><Th>Activa</Th><Th/></tr></thead>
              <tbody>
                {zones.map(z=>{
                  const ZONE_COLORS={red:'#EF4444',orange:'#F97316',yellow:'#EAB308',green:'#22C55E'};
                  const ZONE_LABELS={red:'Roja',orange:'Naranja',yellow:'Amarilla',green:'Verde'};
                  const zc=ZONE_COLORS[z.color]||'#EF4444';
                  return (
                  <tr key={z.id} style={{borderBottom:`1px solid ${C.border}`}}>
                    <Td>
                      <div style={{display:'flex',alignItems:'center',gap:8}}>
                        <span style={{width:12,height:12,borderRadius:'50%',background:zc,display:'inline-block',flexShrink:0,boxShadow:`0 0 0 2px ${zc}33`}}/>
                        <span>{z.name}</span>
                        <span style={{fontSize:10,color:C.dim,fontWeight:600}}>({ZONE_LABELS[z.color]||'Roja'})</span>
                      </div>
                    </Td>
                    <Td dim>{z.radius?`${z.radius} km`:'Sin límite'}</Td>
                    <Td mono right>{fmt(z.price)}</Td>
                    <Td mono right dim>{z.time} min</Td>
                    <Td><span style={{fontSize:10,fontWeight:700,color:z.active?C.green:'#86868B'}}>{z.active?'Activa':'Inactiva'}</span></Td>
                    <Td>
                      <div style={{display:'flex',gap:6}}>
                        <Btn small variant="secondary" onClick={()=>{setZForm({...z,radius:z.radius||'',color:z.color||'red'});setZoneModal(z);}}>Editar</Btn>
                        <Btn small variant="danger" onClick={()=>deleteZone(z.id)}>Eliminar</Btn>
                      </div>
                    </Td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
        }
      </div>

      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:'hidden'}}>
        <div style={{padding:'14px 18px',borderBottom:`1px solid ${C.border}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div style={{fontSize:10,color:C.mid,fontWeight:700,letterSpacing:1}}>CANALES EXTERNOS</div>
          <Btn small onClick={()=>{setCForm({name:'',commission:0,color:'#8E8E93',active:true});setChanModal('new');}}>+ Canal</Btn>
        </div>
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead><tr style={{borderBottom:`1px solid ${C.border}`,background:'var(--bg-subtle)'}}><Th>Canal</Th><Th right>Comisión %</Th><Th>Color</Th><Th>Estado</Th><Th/></tr></thead>
          <tbody>
            {channels.map(c=>(
              <tr key={c.id} style={{borderBottom:`1px solid ${C.border}`}}>
                <Td><div style={{display:'flex',alignItems:'center',gap:8}}><span style={{width:10,height:10,borderRadius:'50%',background:c.color,display:'inline-block',flexShrink:0}}/>{c.name}</div></Td>
                <Td mono right>{c.commission}%</Td>
                <Td><code style={{fontSize:10,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.mid}}>{c.color}</code></Td>
                <Td>
                  <button onClick={()=>toggleChan(c)} style={{background:c.active?'rgba(52,199,89,0.1)':'rgba(142,142,147,0.1)',border:`1px solid ${c.active?'rgba(52,199,89,0.3)':'rgba(142,142,147,0.3)'}`,color:c.active?C.green:'#86868B',padding:'3px 10px',fontSize:11,fontWeight:700,borderRadius:5,cursor:'pointer'}}>
                    {c.active?'Activo':'Inactivo'}
                  </button>
                </Td>
                <Td><Btn small variant="secondary" onClick={()=>{setCForm({name:c.name,commission:c.commission,color:c.color,active:c.active});setChanModal(c);}}>Editar</Btn></Td>
              </tr>
            ))}
            {channels.length===0&&<EmptyRow cols={5} label="Sin canales configurados"/>}
          </tbody>
        </table>
      </div>

      {zoneModal&&(
        <Modal title={zoneModal==='new'?'Nueva zona':'Editar zona'} onClose={()=>setZoneModal(null)} width={420}>
          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            <div><Lbl>NOMBRE *</Lbl><Inp value={zForm.name} onChange={e=>setZForm({...zForm,name:e.target.value})} placeholder="Centro, Barrio Sur…"/></div>
            <div>
              <Lbl>COLOR DE ZONA</Lbl>
              <div style={{display:'flex',gap:8,marginTop:4}}>
                {[{v:'red',label:'Roja',hex:'#EF4444',desc:'Más cercana'},{v:'orange',label:'Naranja',hex:'#F97316',desc:'Intermedia'},{v:'yellow',label:'Amarilla',hex:'#EAB308',desc:'Límite'},{v:'green',label:'Verde',hex:'#22C55E',desc:'Especial'}].map(opt=>(
                  <button key={opt.v} onClick={()=>setZForm({...zForm,color:opt.v})} style={{flex:1,padding:'8px 4px',border:`2px solid ${zForm.color===opt.v?opt.hex:'#E5E5EA'}`,borderRadius:8,background:zForm.color===opt.v?opt.hex+'18':'transparent',cursor:'pointer',display:'flex',flexDirection:'column',alignItems:'center',gap:4,transition:'all 150ms'}}>
                    <span style={{width:20,height:20,borderRadius:'50%',background:opt.hex,display:'block',flexShrink:0}}/>
                    <span style={{fontSize:11,fontWeight:700,color:zForm.color===opt.v?opt.hex:'#86868B'}}>{opt.label}</span>
                    <span style={{fontSize:10,color:C.dim}}>{opt.desc}</span>
                  </button>
                ))}
              </div>
            </div>
            <div><Lbl>RADIO (km — vacío = sin límite)</Lbl><Inp type="number" value={zForm.radius||''} onChange={e=>setZForm({...zForm,radius:e.target.value})} placeholder="5"/></div>
            <div><Lbl>PRECIO DELIVERY (₲)</Lbl><MoneyInp value={zForm.price} onChange={v=>setZForm({...zForm,price:v})} placeholder="15000"/></div>
            <div><Lbl>TIEMPO ESTIMADO (minutos)</Lbl><Inp type="number" value={zForm.time} onChange={e=>setZForm({...zForm,time:e.target.value})} placeholder="30"/></div>
            <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',fontSize:13}}>
              <input type="checkbox" checked={zForm.active} onChange={e=>setZForm({...zForm,active:e.target.checked})}/> Zona activa
            </label>
            <div style={{display:'flex',gap:8,marginTop:8}}>
              <Btn onClick={saveZone} style={{flex:1}}>Guardar zona</Btn>
              <Btn variant="secondary" onClick={()=>setZoneModal(null)}>Cancelar</Btn>
            </div>
          </div>
        </Modal>
      )}

      {/* El editor de mapa se abre SIEMPRE: sirve para fijar la ubicación del local
          (con o sin zonas). Si hay zonas, además se editan sus radios. */}
      {mapOpen&&(
        <MapEditor
          zones={zones}
          restaurant={restaurant}
          onSave={(lat,lng,updatedZones)=>{
            if(setRestaurant&&restaurant) setRestaurant({...restaurant,lat,lng});
            const mapped = updatedZones.map(z=>({...z,radius:z.radius_km}));
            setZones(mapped);
            setMapOpen(false);
            toast(updatedZones.length?'Zonas y ubicación del local guardadas':'Ubicación del local guardada');
          }}
          onClose={()=>setMapOpen(false)}
        />
      )}

      {chanModal&&(
        <Modal title={chanModal==='new'?'Nuevo canal':'Editar canal'} onClose={()=>setChanModal(null)} width={420}>
          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            <div><Lbl>NOMBRE *</Lbl><Inp value={cForm.name} onChange={e=>setCForm({...cForm,name:e.target.value})} placeholder="PedidosYa, Monchis…"/></div>
            <div><Lbl>COMISIÓN %</Lbl><Inp type="number" value={cForm.commission} onChange={e=>setCForm({...cForm,commission:e.target.value})} placeholder="18"/></div>
            <div>
              <Lbl>COLOR</Lbl>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <input type="color" value={cForm.color} onChange={e=>setCForm({...cForm,color:e.target.value})} style={{width:36,height:32,border:`1px solid ${C.border}`,borderRadius:6,padding:2,cursor:'pointer',background:'none'}}/>
                <Inp value={cForm.color} onChange={e=>setCForm({...cForm,color:e.target.value})} placeholder="#000000" style={{flex:1}}/>
              </div>
            </div>
            <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',fontSize:13}}>
              <input type="checkbox" checked={cForm.active} onChange={e=>setCForm({...cForm,active:e.target.checked})}/> Canal activo
            </label>
            <div style={{display:'flex',gap:8,marginTop:8}}>
              <Btn onClick={saveChan} style={{flex:1}}>Guardar canal</Btn>
              <Btn variant="secondary" onClick={()=>setChanModal(null)}>Cancelar</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ── DeliveryModule (root) ── */
// Canales por defecto (fallback en memoria si delivery_channels/mig 162 no está aplicada).
const DEFAULT_CHANNELS = [
  {id:'propio',    name:'Propio',     commission:0,  color:'#8E8E93', active:true},
  {id:'pedidosya', name:'PedidosYa',  commission:18, color:'#FF6000', active:true},
  {id:'monchis',   name:'Monchis',    commission:15, color:'#00B04F', active:true},
];
function DeliveryModule() {
  const [tab,setTab] = useState('dashboard');
  const [deliveryOrders,setDeliveryOrders] = useState([]);
  const [riders,setRiders] = useState([]);
  const [loading,setLoading] = useState(true);
  const [restaurant,setRestaurant] = useState(null);
  const [zones,setZonesState] = useState(()=>LS.get(`deliv_zones_${RID}`,[]) );
  // Canales por defecto EN MEMORIA (fallback si la mig 162 aún no está aplicada).
  // Fuente real: tabla delivery_channels (DB, tenant-scoped). id = slug estable.
  const [channels,setChannelsState] = useState(DEFAULT_CHANNELS);

  const [settings,setSettings] = useState(null);   // delivery_settings (mig 124) · null = modo 'zone' por defecto

  function setZones(z)    { setZonesState(z);    LS.set(`deliv_zones_${RID}`,z); }
  // setChannels ya NO persiste a localStorage: los canales viven en delivery_channels (DB, mig 162).
  function setChannels(ch){ setChannelsState(ch); }

  // Carga canales desde la DB → shape del front ({id:slug, uuid, name, commission, color, active}).
  // Defensivo: si la mig 162 no está o no hay filas, cae a los defaults en memoria (no rompe).
  async function loadChannels(){
    if(!db){ setChannelsState(DEFAULT_CHANNELS); return; }
    const {data,error} = await db.from('delivery_channels').select('*').eq('restaurant_id',RID).order('name');
    if(error || !data || !data.length){ setChannelsState(DEFAULT_CHANNELS); return; }
    setChannelsState(data.map(r=>({
      id: r.slug || String(r.id), uuid: r.id, name: r.name,
      commission: Number(r.commission_pct)||0, color: r.color || '#8E8E93', active: r.is_active !== false,
    })));
  }

  // Guarda el modo de cotización (upsert por restaurant_id). Defensivo: devuelve
  // {ok,error} y DelivConfig avisa si la migración 124 todavía no está aplicada.
  async function saveSettings(next){
    if(!db) return { ok:false, error:{message:'Sin conexión'} };
    const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const optNum = v => { if(v===''||v==null) return null; const n=Number(v); return Number.isFinite(n)&&n>0 ? n : null; };
    const payload = {
      restaurant_id:    RID,
      pricing_mode:     next.pricing_mode || 'zone',
      base_fee:         num(next.base_fee),
      price_per_km:     num(next.price_per_km),
      min_fee:          num(next.min_fee),
      max_km:           optNum(next.max_km),
      free_over_amount: optNum(next.free_over_amount),
      // round_to: 0 = sin redondeo (válido); negativo/NaN → default 500.
      round_to:         (() => { const n = Number(next.round_to); return Number.isFinite(n) && n >= 0 ? n : 500; })(),
      // Máximo de pedidos en cola por rider (mig 156). Vacío/≤0 = sin límite.
      max_orders_per_rider: optNum(next.max_orders_per_rider),
      updated_at:       new Date().toISOString(),
    };
    let { data, error } = await db.from('delivery_settings').upsert(payload,{onConflict:'restaurant_id'}).select().maybeSingle();
    // Degradación si la mig 156 (max_orders_per_rider) aún no está aplicada: reintentar
    // sin esa columna para no bloquear el guardado del resto de la config.
    if(error && /max_orders_per_rider|PGRST204|42703|column|schema cache/i.test(`${error.message||''} ${error.code||''}`)){
      const { max_orders_per_rider, ...rest } = payload;
      const retry = await db.from('delivery_settings').upsert(rest,{onConflict:'restaurant_id'}).select().maybeSingle();
      data = retry.data; error = retry.error;
      if(!error) console.warn('[delivery] max_orders_per_rider no disponible aún — guardado sin la alerta de cola. Aplicar migración 156.');
    }
    if(error) return { ok:false, error };
    setSettings(data || payload);
    return { ok:true };
  }

  useEffect(()=>{ loadDelivery(); },[]);

  async function loadDelivery(silent=false) {
    if(!silent) setLoading(true);
    if(!db){ if(!silent) setLoading(false); return; }
    const [doR,rR,zR,restR] = await Promise.all([
      db.from('delivery_orders').select('*').eq('restaurant_id',RID).order('created_at',{ascending:false}).limit(300),
      db.from('delivery_riders').select('*').eq('restaurant_id',RID).order('name'),
      db.from('delivery_zones').select('*').eq('restaurant_id',RID).order('radius_km'),
      db.from('restaurants').select('id,name,lat,lng').eq('id',RID).maybeSingle(),
    ]);
    setDeliveryOrders(doR.data||[]);
    setRiders(rR.data||[]);
    if(restR.data) setRestaurant(restR.data);
    if(zR.data?.length){
      const mapped = zR.data.map(z=>({
        id:z.id, name:z.name, radius:z.radius_km, radius_km:z.radius_km,
        price:z.price_guarani, time:z.estimated_minutes,
        active:z.is_active!==false, color:z.color||'red'
      }));
      setZones(mapped);
    }
    // Modo de cotización (mig 124) · feature-detect: si la tabla aún no existe,
    // settings queda null y DelivConfig cae al modo 'zone' (comportamiento actual).
    try {
      const sR = await db.from('delivery_settings').select('*').eq('restaurant_id',RID).maybeSingle();
      setSettings(sR && !sR.error ? (sR.data || null) : null);
    } catch(_) { setSettings(null); }
    await loadChannels();
    setLoading(false);
  }

  // Auto-asignación de rider
  async function autoAssignRider(order) {
    if(!db) return;
    // Despacho centralizado (mig 156): DISPONIBLE primero; si no hay, se acumula al
    // rider EN RUTA en su cola "próximo viaje". Atómico/idempotente en el servidor.
    // Fallback al balanceo cliente de abajo si la RPC no está aplicada todavía.
    try {
      const { data, error } = await db.rpc('assign_delivery_order', { p_order_id: order.id });
      if(!error){
        if(data && data.ok) toast(`Rider asignado automáticamente: ${data.rider_name}`);
        loadDelivery(true);
        return;
      }
    } catch(_) { /* RPC ausente → fallback */ }
    const available = riders.filter(r=>r.active!==false&&r.current_status==='disponible');
    if(!available.length) return;
    const activos = deliveryOrders.filter(o=>!['delivered','cancelled'].includes(o.rider_status)&&o.rider_id);
    const countMap={};
    activos.forEach(o=>{ if(o.rider_id) countMap[o.rider_id]=(countMap[o.rider_id]||0)+1; });
    const rider = available.sort((a,b)=>(countMap[a.id]||0)-(countMap[b.id]||0))[0];
    if(!rider) return;
    await db.from('delivery_orders').update({rider_id:rider.id,rider_name:rider.name,rider_status:'confirmed'}).eq('id',order.id);
    toast(`Rider asignado automáticamente: ${rider.name}`);
    loadDelivery();
  }

  // Rebalanceo manual: mueve pedidos transferibles de riders en ruta a los
  // disponibles (mig 156). El admin lo dispara desde la pestaña Riders.
  async function handleRebalance() {
    if(!db) return;
    try {
      const { data, error } = await db.rpc('rebalance_delivery_dispatch',{ p_restaurant_id: RID });
      if(error){ toast('No se pudo rebalancear'+(error.message?` · ${error.message}`:'')+'. Verificá que la migración 156 esté aplicada.',false); return; }
      const moved = data?.moved || 0;
      toast(moved>0 ? `Rebalanceo: ${moved} pedido${moved>1?'s':''} movido${moved>1?'s':''} a riders disponibles` : 'No había pedidos para rebalancear');
      loadDelivery(true);
    } catch(e){ toast('Error al rebalancear',false); }
  }

  // Transferencia manual de un pedido transferible a otro rider (mig 156).
  async function handleTransferOrder(orderId, riderId) {
    if(!db || !orderId || !riderId) return { ok:false };
    try {
      const { data, error } = await db.rpc('transfer_delivery_order',{ p_order_id: orderId, p_rider_id: riderId });
      if(error){ toast('No se pudo transferir'+(error.message?` · ${error.message}`:'')+'. Verificá la migración 156.',false); return { ok:false }; }
      if(data && data.ok){ toast(`Pedido transferido a ${data.rider_name}`); loadDelivery(true); return { ok:true }; }
      toast('No se pudo transferir: '+(data?.reason||'motivo desconocido'),false);
      return { ok:false };
    } catch(e){ toast('Error al transferir',false); return { ok:false }; }
  }

  // Realtime delivery
  useEffect(()=>{
    if(!db) return;
    const ch = db.channel('delivery-rt')
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'delivery_orders',filter:`restaurant_id=eq.${RID}`}, payload=>{
        setDeliveryOrders(prev=>[payload.new,...prev]);
        if(!payload.new.rider_id) autoAssignRider(payload.new);
      })
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'delivery_orders',filter:`restaurant_id=eq.${RID}`}, ()=>{ if(!_shouldPause()) loadDelivery(true); })
      .on('postgres_changes',{event:'*',schema:'public',table:'delivery_riders',filter:`restaurant_id=eq.${RID}`}, ()=>{ if(!_shouldPause()) loadDelivery(true); })
      .subscribe();
    const poll = setInterval(()=>{ if(_shouldPause()) return; loadDelivery(true); }, 120000);
    return ()=>{ db.removeChannel(ch); clearInterval(poll); };
  },[riders]);

  const TABS = [{id:'dashboard',label:'Dashboard'},{id:'pedidos',label:'Pedidos'},{id:'riders',label:'Riders'},{id:'config',label:'Config'}];

  function renderTab() {
    if(loading) return <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:300,gap:12}}><span className="spin"/><span style={{fontSize:13,color:C.dim}}>Cargando…</span></div>;
    switch(tab){
      case 'dashboard': return <DelivDashboard deliveryOrders={deliveryOrders} channels={channels}/>;
      case 'pedidos':   return <DelivPedidos deliveryOrders={deliveryOrders} riders={riders} channels={channels} zones={zones} onRefresh={loadDelivery}/>;
      case 'riders':    return <DelivRiders riders={riders} deliveryOrders={deliveryOrders} settings={settings} onRefresh={loadDelivery} onRebalance={handleRebalance} onTransfer={handleTransferOrder}/>;
      case 'config':    return <DelivConfig zones={zones} setZones={setZones} channels={channels} setChannels={setChannels} reloadChannels={loadChannels} restaurant={restaurant} setRestaurant={setRestaurant} settings={settings} onSaveSettings={saveSettings}/>;
      default: return null;
    }
  }

  return (
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
        <h1 style={{fontSize:22,fontWeight:800,color:C.ink}}>Delivery</h1>
        <Btn variant="secondary" onClick={loadDelivery}>↺ Actualizar</Btn>
      </div>
      <div style={{display:'flex',gap:0,borderBottom:`1px solid ${C.border}`,marginBottom:24}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{background:'none',border:'none',borderBottom:tab===t.id?'2px solid '+C.ink:'2px solid transparent',color:tab===t.id?C.ink:C.dim,padding:'10px 20px',fontSize:13,fontWeight:tab===t.id?700:400,cursor:'pointer',transition:'color .15s',marginBottom:'-1px'}}>
            {t.label}
          </button>
        ))}
      </div>
      {renderTab()}
    </div>
  );
}

/* ══════════════════════════════════════════════
   PÁGINA: RESERVAS (ADMIN)
══════════════════════════════════════════════ */
// Config de reservas (ventana "Reservada" + alerta al mozo). Vive dentro del módulo
// Agenda → Reservas (antes estaba en Configuración). Guarda sobre restaurants; los
// valores los consumen mozo/caja/admin (ver buildReservationByTableA en MesasPage).
function ReservasConfigModal({restaurant, onClose, onSaved}) {
  const [win,setWin]     = useState(restaurant?.reservation_window_hours ?? 3);
  const [alertM,setAlert]= useState(restaurant?.reservation_alert_minutes ?? 30);
  const [saving,setSaving] = useState(false);
  async function save(){
    if(!db) return;
    const w=Number(win), a=Number(alertM);
    if(!(w>0)||!(a>=0)){ toast('Valores inválidos',false); return; }
    setSaving(true);
    const{data,error}=await db.from('restaurants').update({reservation_window_hours:w,reservation_alert_minutes:a}).eq('id',RID).select('id');
    if(error){ toast('Error: '+error.message,false); }
    else if(!data||data.length===0){ toast('No se pudo guardar — verificá RLS / migración 070',false); }
    else{ toast('Reservas: configuración guardada'); onSaved&&onSaved(); onClose(); }
    setSaving(false);
  }
  return (
    <Modal title="Configuración de reservas" onClose={onClose} width={460}>
      <div style={{display:'flex',flexDirection:'column',gap:14,marginBottom:18}}>
        <div>
          <Lbl>VENTANA PARA MARCAR MESA COMO "RESERVADA" (HORAS)</Lbl>
          <Inp type="number" min="0.5" max="12" step="0.5" value={win} onChange={e=>setWin(e.target.value)} style={{width:90}}/>
          <div style={{fontSize:11,color:C.dim,marginTop:6,lineHeight:1.5}}>Las mesas con reserva confirmada se marcan como <strong>Reservada</strong> en mozo/caja/admin cuando faltan menos de estas horas para la hora de la reserva. Recomendado: 3h.</div>
        </div>
        <div>
          <Lbl>ALERTA AL MOZO SI MESA SIGUE OCUPADA (MINUTOS ANTES)</Lbl>
          <Inp type="number" min="0" max="120" step="5" value={alertM} onChange={e=>setAlert(e.target.value)} style={{width:90}}/>
          <div style={{fontSize:11,color:C.dim,marginTop:6,lineHeight:1.5}}>Si una mesa con reserva próxima sigue ocupada cuando faltan estos minutos, aparece una alerta roja al mozo para pedir la cuenta. Recomendado: 30 min.</div>
        </div>
      </div>
      <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn onClick={save} disabled={saving}>{saving?'Guardando…':'Guardar reservas'}</Btn>
      </div>
    </Modal>
  );
}

function ReservasPage({tables,embedded,mode,restaurant,onRefresh}) {
  // mode==='cola' → cola de próximas PENDIENTES (sin filtro de día, ordenadas por
  // fecha) para que el dueño las confirme de un vistazo, sin adivinar el día.
  const isCola = mode==='cola';
  // Fecha de HOY en zona local (no UTC): con toISOString() al anochecer en Paraguay
  // (UTC ya rodó al día siguiente) se perdían las reservas del día. Mismo patrón que
  // el resto del panel (getFullYear/getMonth/getDate son locales).
  const localToday = () => { const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
  const [reservas,setReservas] = useState([]);
  const [loading,setLoading]   = useState(true);
  const [dateFilter,setDateFilter] = useState(isCola ? '' : localToday());
  const [statusFilter,setStatusFilter] = useState(isCola ? 'pending' : 'all');
  const [editModal,setEditModal] = useState(null);
  const [newModal,setNewModal]  = useState(false);
  const [cfgModal,setCfgModal]  = useState(false);

  const OCCASION_LABEL={birthday:'Cumpleaños',anniversary:'Aniversario',business:'Reunión',celebration:'Celebración',other:'Otro'};
  const STATUS_CFG={
    pending:   {label:'Pendiente', color:'#FF9500'},
    confirmed: {label:'Confirmada',color:'#34C759'},
    seated:    {label:'En mesa',   color:'#007AFF'},
    no_show:   {label:'No llegó',  color:C.mid},
    cancelled: {label:'Cancelada', color:'#FF3B30'},
  };
  const ALL_STATUS = Object.entries(STATUS_CFG);

  async function load(){
    setLoading(true);
    if(!db){setLoading(false);return;}
    let q = db.from('reservations').select('*').eq('restaurant_id',RID).order('reservation_date').order('reservation_time');
    if(dateFilter) q = q.eq('reservation_date',dateFilter);
    else if(isCola) q = q.gte('reservation_date',localToday());   // solo próximas (fecha local)
    if(statusFilter!=='all') q = q.eq('status',statusFilter);
    const{data}=await q.limit(200);
    setReservas(data||[]);
    setLoading(false);
  }
  useEffect(()=>{load();},[dateFilter,statusFilter]);

  async function updateStatus(id,status){
    await db.from('reservations').update({status}).eq('id',id);
    // En la cola de Pendientes, Confirmar/Rechazar saca la fila (deja de ser pending);
    // en la vista Lista se actualiza en el lugar (feedback sin recargar).
    if (isCola && statusFilter==='pending') setReservas(p=>p.filter(r=>r.id!==id));
    else setReservas(p=>p.map(r=>r.id===id?{...r,status}:r));
  }

  async function deleteReserva(id){
    if(!window.confirm('¿Eliminar esta reserva?')) return;
    await db.from('reservations').delete().eq('id',id);
    setReservas(p=>p.filter(r=>r.id!==id));
  }

  const fmtTime=t=>t?t.slice(0,5):'—';
  const fmtDate=d=>{if(!d)return'—';const[y,m,dd]=d.split('-');return`${dd}/${m}/${y}`;};
  const tableNum=id=>{const t=(tables||[]).find(t=>t.id===id);return t?`Mesa ${t.number}`:null;};
  const ZONE_LABEL={salon:'Salón',terraza:'Terraza',bar:'Bar',privado:'Privado',exterior:'Exterior'};
  const zoneFor=r=>{
    if(r.table_id){const t=(tables||[]).find(x=>x.id===r.table_id);if(t)return ZONE_LABEL[t.zona]||t.zona||'—';}
    return r.preferred_zone?ZONE_LABEL[r.preferred_zone]||r.preferred_zone:'—';
  };

  const pending  = reservas.filter(r=>r.status==='pending').length;
  const confirmed= reservas.filter(r=>r.status==='confirmed').length;

  return(
    <div>
      {/* Header */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20,flexWrap:'wrap',gap:12}}>
        <div>
          {!embedded && <h1 style={{fontSize:22,fontWeight:800,color:C.ink,margin:0}}>Reservas</h1>}
          <div style={{fontSize:12,color:C.mid,marginTop:embedded?0:3}}>{pending} pendientes · {confirmed} confirmadas</div>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
          <input type="date" value={dateFilter} onChange={e=>setDateFilter(e.target.value)}
            style={{height:34,border:`1px solid ${C.border}`,borderRadius:6,padding:'0 10px',fontSize:13,color:C.ink,background:C.surface,outline:'none'}}/>
          <button onClick={()=>setDateFilter('')} style={{height:34,padding:'0 10px',border:`1px solid ${C.border}`,borderRadius:6,background:C.surface,color:C.mid,fontSize:12,cursor:'pointer'}}>Todas las fechas</button>
          <select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}
            style={{height:34,border:`1px solid ${C.border}`,borderRadius:6,padding:'0 10px',fontSize:13,color:C.ink,background:C.surface,outline:'none'}}>
            <option value="all">Todos los estados</option>
            {ALL_STATUS.map(([id,cfg])=><option key={id} value={id}>{cfg.label}</option>)}
          </select>
          <button onClick={load} style={{height:34,padding:'0 10px',border:`1px solid ${C.border}`,borderRadius:6,background:C.surface,color:C.mid,fontSize:12,cursor:'pointer'}}>↺</button>
          <button onClick={()=>setCfgModal(true)} title="Configuración de reservas" style={{height:34,padding:'0 12px',border:`1px solid ${C.border}`,borderRadius:6,background:C.surface,color:C.mid,fontSize:12,cursor:'pointer',display:'inline-flex',alignItems:'center',gap:6}}><Icon name="settings" size={14}/> Config</button>
          <button onClick={()=>setNewModal(true)} style={{height:34,padding:'0 14px',border:'none',borderRadius:6,background:C.ink,color:C.sidebar,fontSize:12,fontWeight:700,cursor:'pointer'}}>+ Nueva reserva</button>
        </div>
      </div>

      {/* KPIs del día */}
      {dateFilter&&(
        <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:10,marginBottom:20}}>
          {ALL_STATUS.map(([id,cfg])=>{
            const count=reservas.filter(r=>r.status===id).length;
            return(
              <div key={id} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'12px 14px',cursor:'pointer',opacity:statusFilter!=='all'&&statusFilter!==id?.5:1}}
                onClick={()=>setStatusFilter(statusFilter===id?'all':id)}>
                <div style={{fontSize:11,color:C.mid,marginBottom:4}}>{cfg.label}</div>
                <div style={{fontSize:24,fontWeight:800,color:cfg.color}}>{count}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Tabla */}
      {loading&&<div style={{textAlign:'center',padding:40,color:C.mid}}>Cargando…</div>}
      {!loading&&reservas.length===0&&(
        <div style={{textAlign:'center',padding:60,color:C.mid}}>
          <div style={{marginBottom:12,display:'flex',justifyContent:'center',color:C.mid}}><Icon name="calendar" size={32}/></div>
          <div style={{fontSize:14,fontWeight:600,marginBottom:6}}>Sin reservas</div>
          <div style={{fontSize:12}}>Cambiá los filtros o creá una nueva reserva.</div>
        </div>
      )}
      {!loading&&reservas.length>0&&(
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,overflow:'hidden'}}>
          <table style={{width:'100%',borderCollapse:'collapse'}}>
            <thead>
              <tr style={{borderBottom:`1px solid ${C.border}`,background:C.bg}}>
                {['Confirmación','Cliente','Fecha','Hora','Pers.','Zona','Mesa','Motivo','Estado','Acciones'].map(h=>(
                  <th key={h} style={{padding:'10px 12px',textAlign:'left',fontSize:10,fontWeight:700,color:'#3a3a3c',letterSpacing:'0.08em',textTransform:'uppercase',whiteSpace:'nowrap'}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {reservas.map((r,i)=>{
                const sc=STATUS_CFG[r.status]||STATUS_CFG.pending;
                const tn=tableNum(r.table_id);
                return(
                  <tr key={r.id} style={{borderBottom:i<reservas.length-1?`1px solid ${C.border}`:'none',background:'transparent'}}>
                    <td style={{padding:'10px 12px',fontFamily:'monospace',fontSize:12,color:C.mid}}>{r.confirm_num}</td>
                    <td style={{padding:'10px 12px'}}>
                      <div style={{fontWeight:600,fontSize:13,color:C.ink}}>{r.customer_name}</div>
                      <div style={{fontSize:11,color:C.mid,display:'flex',alignItems:'center',gap:4}}><Icon name="phone" size={11}/> {r.customer_phone}</div>
                    </td>
                    <td style={{padding:'10px 12px',fontSize:13,color:C.ink,whiteSpace:'nowrap'}}>{fmtDate(r.reservation_date)}</td>
                    <td style={{padding:'10px 12px',fontSize:13,fontWeight:700,color:C.ink}}>{fmtTime(r.reservation_time)}</td>
                    <td style={{padding:'10px 12px',fontSize:13,textAlign:'center',color:C.ink}}>{r.guests}</td>
                    <td style={{padding:'10px 12px',fontSize:12,color:C.mid}}>{zoneFor(r)}</td>
                    <td style={{padding:'10px 12px',fontSize:12,color:C.mid}}>{tn||(r.preferred_zone?<span style={{color:'#FF9500'}}>Sin asignar</span>:'—')}</td>
                    <td style={{padding:'10px 12px',fontSize:12,color:C.mid}}>{r.occasion?OCCASION_LABEL[r.occasion]||r.occasion:'—'}</td>
                    <td style={{padding:'10px 12px'}}>
                      <select value={r.status} onChange={e=>updateStatus(r.id,e.target.value)}
                        style={{border:`1px solid ${sc.color}`,borderRadius:20,padding:'3px 8px',fontSize:11,fontWeight:700,color:sc.color,background:'transparent',cursor:'pointer',outline:'none'}}>
                        {ALL_STATUS.map(([id,cfg])=><option key={id} value={id} style={{color:C.ink}}>{cfg.label}</option>)}
                      </select>
                    </td>
                    <td style={{padding:'10px 12px'}}>
                      <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                        {r.status==='pending' && <>
                          <button onClick={()=>updateStatus(r.id,'confirmed')} title="Confirmar reserva" style={{padding:'4px 10px',borderRadius:6,border:'1px solid #34C759',background:'#34C759',color:'#fff',fontSize:11,fontWeight:700,cursor:'pointer'}}>Confirmar</button>
                          <button onClick={()=>updateStatus(r.id,'cancelled')} title="Rechazar reserva" style={{padding:'4px 10px',borderRadius:6,border:'1px solid #FF3B30',background:'transparent',color:'#FF3B30',fontSize:11,fontWeight:700,cursor:'pointer'}}>Rechazar</button>
                        </>}
                        <button onClick={()=>setEditModal(r)} style={{padding:'4px 10px',borderRadius:6,border:`1px solid ${C.border}`,background:'transparent',color:C.mid,fontSize:11,cursor:'pointer'}}>Editar</button>
                        <a href={`https://wa.me/${r.customer_phone.replace(/\D/g,'')}`} target="_blank"
                          style={{padding:'4px 10px',borderRadius:6,border:`1px solid #25D366`,background:'transparent',color:'#25D366',fontSize:11,fontWeight:600,textDecoration:'none'}}>WA</a>
                        <button onClick={()=>deleteReserva(r.id)} style={{padding:'4px 10px',borderRadius:6,border:`1px solid #FF3B30`,background:'transparent',color:'#FF3B30',fontSize:11,cursor:'pointer'}}>✕</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal editar / nueva reserva */}
      {(editModal||newModal)&&(
        <ReservaFormModal
          reserva={editModal}
          tables={tables||[]}
          onClose={()=>{setEditModal(null);setNewModal(false);}}
          onSaved={()=>{setEditModal(null);setNewModal(false);load();}}
        />
      )}

      {/* Modal configuración de reservas (movido desde Configuración) */}
      {cfgModal&&(
        <ReservasConfigModal
          restaurant={restaurant}
          onClose={()=>setCfgModal(false)}
          onSaved={()=>{ if(onRefresh) onRefresh(true); }}
        />
      )}
    </div>
  );
}

function ReservaFormModal({reserva,tables,onClose,onSaved,defaultDate}){
  const isNew=!reserva;
  const now=new Date();
  const todayStr=now.toISOString().slice(0,10);
  const MONTHS_ES=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const OCCASION_OPTS=[{id:'',label:'Sin motivo especial'},{id:'birthday',label:'Cumpleaños'},{id:'anniversary',label:'Aniversario'},{id:'business',label:'Reunión'},{id:'celebration',label:'Celebración'},{id:'other',label:'Otro'}];
  const STATUS_OPTS=[{id:'pending',label:'Pendiente'},{id:'confirmed',label:'Confirmada'},{id:'seated',label:'En mesa'},{id:'no_show',label:'No llegó'},{id:'cancelled',label:'Cancelada'}];

  const TIME_SLOTS=[];
  for(let h=10;h<=23;h++){TIME_SLOTS.push(`${String(h).padStart(2,'0')}:00`);TIME_SLOTS.push(`${String(h).padStart(2,'0')}:30`);}

  const initDate=reserva?.reservation_date||defaultDate||todayStr;
  const [selYear,selMonth,selDay]=initDate.split('-').map(Number);

  const [form,setForm]=useState({
    customer_name:   reserva?.customer_name   ||'',
    customer_phone:  reserva?.customer_phone  ||'',
    day:   selDay,
    month: selMonth,
    year:  selYear,
    reservation_time:reserva?.reservation_time?.slice(0,5)||'',
    guests:          reserva?.guests          ||2,
    preferred_zone:  reserva?.preferred_zone  ||(reserva?.table_id?((tables||[]).find(t=>t.id===reserva.table_id)?.zona||''):''),
    table_id:        reserva?.table_id        ||'',
    occasion:        reserva?.occasion        ||'',
    notes:           reserva?.notes           ||'',
    status:          reserva?.status          ||'pending',
  });
  const ZONE_OPTS=[{id:'',label:'Sin preferencia'},{id:'salon',label:'Salón'},{id:'terraza',label:'Terraza'},{id:'bar',label:'Bar'},{id:'privado',label:'Privado'},{id:'exterior',label:'Exterior'}];
  const tablesFiltered=(tables||[]).filter(t=>!form.preferred_zone||(t.zona||'salon')===form.preferred_zone);
  const [saving,setSaving]=useState(false);
  const f=(k,v)=>setForm(p=>({...p,[k]:v}));
  const inputSt={width:'100%',height:38,border:`1px solid ${C.border}`,borderRadius:6,padding:'0 10px',fontSize:13,color:C.ink,background:C.surface,outline:'none',boxSizing:'border-box'};
  const selSt={...inputSt,cursor:'pointer'};

  const daysInMonth=new Date(form.year,form.month,0).getDate();
  const yearOptions=[now.getFullYear(),now.getFullYear()+1,now.getFullYear()+2];

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
        preferred_zone:form.preferred_zone||null,
        occasion:form.occasion||null,notes:form.notes||null,status:form.status,
      });
    } else {
      await db.from('reservations').update({
        customer_name:form.customer_name,customer_phone:form.customer_phone,
        reservation_date:dateStr,reservation_time:form.reservation_time,
        guests:Number(form.guests),table_id:form.table_id||null,
        preferred_zone:form.preferred_zone||null,
        occasion:form.occasion||null,notes:form.notes||null,status:form.status,
      }).eq('id',reserva.id);
    }
    setSaving(false);
    onSaved();
  }

  const canSave=form.customer_name&&form.customer_phone&&form.reservation_time;

  return(
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.5)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000,padding:20}}>
      <div style={{background:C.surface,borderRadius:14,width:'100%',maxWidth:560,maxHeight:'92vh',overflowY:'auto',padding:24}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
          <div style={{fontSize:18,fontWeight:800,color:C.ink}}>{isNew?'Nueva reserva':'Editar reserva'}</div>
          <button onClick={onClose} style={{width:30,height:30,borderRadius:'50%',border:`1px solid ${C.border}`,background:'transparent',cursor:'pointer',fontSize:16,color:C.mid}}>✕</button>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:14}}>

          {/* Contacto */}
          <div style={{display:'flex',gap:10}}>
            <div style={{flex:1}}><label style={{fontSize:11,fontWeight:600,color:C.mid,display:'block',marginBottom:4}}>Nombre *</label><input value={form.customer_name} onChange={e=>f('customer_name',e.target.value)} style={inputSt} placeholder="Nombre del cliente"/></div>
            <div style={{flex:1}}><label style={{fontSize:11,fontWeight:600,color:C.mid,display:'block',marginBottom:4}}>Teléfono *</label><input value={form.customer_phone} onChange={e=>f('customer_phone',e.target.value)} type="tel" style={inputSt} placeholder="+595 9XX XXX XXX"/></div>
          </div>

          {/* Fecha — dropdowns */}
          <div>
            <label style={{fontSize:11,fontWeight:600,color:C.mid,display:'block',marginBottom:6}}>Fecha de la reserva *</label>
            <div style={{display:'flex',gap:8}}>
              <div style={{flex:'0 0 90px'}}>
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
              <div style={{flex:'0 0 90px'}}>
                <div style={{fontSize:10,color:C.mid,marginBottom:3,fontWeight:600}}>AÑO</div>
                <select value={form.year} onChange={e=>f('year',Number(e.target.value))} style={selSt}>
                  {yearOptions.map(y=><option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </div>
            <div style={{marginTop:6,fontSize:11,color:C.mid}}>
              → <strong style={{color:C.ink}}>{MONTHS_ES[form.month-1]} {Math.min(form.day,daysInMonth)}, {form.year}</strong>
            </div>
          </div>

          {/* Hora — slots clickeables */}
          <div>
            <label style={{fontSize:11,fontWeight:600,color:C.mid,display:'block',marginBottom:6}}>
              Horario *{form.reservation_time&&<strong style={{color:C.ink,marginLeft:8}}>{form.reservation_time} hs</strong>}
            </label>
            <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:5}}>
              {TIME_SLOTS.map(t=>{
                const sel=form.reservation_time===t;
                return(
                  <button key={t} onClick={()=>f('reservation_time',t)}
                    style={{padding:'6px 4px',borderRadius:6,border:`1.5px solid ${sel?C.ink:C.border}`,background:sel?C.ink:'transparent',color:sel?C.surface:C.ink,fontSize:11,fontWeight:sel?700:400,cursor:'pointer',textAlign:'center',transition:'all 100ms'}}>
                    {t}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Personas + Zona + Mesa */}
          <div style={{display:'flex',gap:10}}>
            <div style={{flex:'0 0 110px'}}>
              <label style={{fontSize:11,fontWeight:600,color:C.mid,display:'block',marginBottom:4}}>Personas</label>
              <select value={form.guests} onChange={e=>f('guests',e.target.value)} style={selSt}>
                {[1,2,3,4,5,6,7,8,10,12].map(n=><option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div style={{flex:1}}>
              <label style={{fontSize:11,fontWeight:600,color:C.mid,display:'block',marginBottom:4}}>Zona</label>
              <select value={form.preferred_zone} onChange={e=>{const v=e.target.value;setForm(p=>{const t=(tables||[]).find(x=>x.id===p.table_id);const keepTable=t&&((t.zona||'salon')===v||!v);return{...p,preferred_zone:v,table_id:keepTable?p.table_id:''};});}} style={selSt}>
                {ZONE_OPTS.map(z=><option key={z.id} value={z.id}>{z.label}</option>)}
              </select>
            </div>
            <div style={{flex:1}}>
              <label style={{fontSize:11,fontWeight:600,color:C.mid,display:'block',marginBottom:4}}>Mesa</label>
              <select value={form.table_id} onChange={e=>{const v=e.target.value;const t=(tables||[]).find(x=>x.id===v);setForm(p=>({...p,table_id:v,preferred_zone:t?(t.zona||'salon'):p.preferred_zone}));}} style={selSt}>
                <option value="">Sin asignar</option>
                {tablesFiltered.map(t=><option key={t.id} value={t.id}>Mesa {t.number}{t.capacity?` (${t.capacity}p)`:''}</option>)}
              </select>
            </div>
          </div>

          {/* Motivo + Estado */}
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

          {/* Notas */}
          <div>
            <label style={{fontSize:11,fontWeight:600,color:C.mid,display:'block',marginBottom:4}}>Notas / comentarios</label>
            <textarea value={form.notes} onChange={e=>f('notes',e.target.value)} rows={2}
              style={{width:'100%',border:`1px solid ${C.border}`,borderRadius:6,padding:'8px 10px',fontSize:13,color:C.ink,background:C.surface,outline:'none',resize:'none',boxSizing:'border-box'}}/>
          </div>

          <div style={{background:TINT.amberBg,border:`1px solid ${TINT.amberBorder}`,borderRadius:8,padding:'9px 12px',fontSize:11,color:TINT.amberText}}>
            <strong>Tolerancia 15 min.</strong> Si el cliente no llega en 15 min de la hora reservada, marcá como "No llegó".
          </div>

          <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
            <button onClick={onClose} style={{padding:'8px 18px',border:`1px solid ${C.border}`,borderRadius:8,background:'transparent',color:C.mid,fontSize:13,cursor:'pointer'}}>Cancelar</button>
            <button onClick={save} disabled={saving||!canSave}
              style={{padding:'8px 22px',border:'none',borderRadius:8,background:canSave?C.ink:C.border,color:canSave?C.surface:C.dim,fontSize:13,fontWeight:700,cursor:canSave?'pointer':'default',opacity:saving?.6:1}}>
              {saving?'Guardando…':isNew?'Crear reserva':'Guardar cambios'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   PROVEEDORES
══════════════════════════════════════════════ */
const SUPPLIER_CATS = ['bebidas','carnes','verdulería','panadería','almacén','lácteos','limpieza','descartables','servicios','otros'];

function ProveedoresPage() {
  const [tab, setTab] = useState('lista'); // lista | compras | estadisticas
  const [suppliers, setSuppliers] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('');
  const [filterActive, setFilterActive] = useState('activos'); // activos | inactivos | todos
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [showPurchaseForm, setShowPurchaseForm] = useState(false);
  const [editingPurchase, setEditingPurchase] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!db) return;
    setLoading(true);
    const [s, p] = await Promise.all([
      db.from('suppliers').select('*').eq('restaurant_id',RID).order('name'),
      db.from('supplier_purchases').select('*').eq('restaurant_id',RID).order('purchase_date',{ascending:false}).limit(120)
    ]);
    setSuppliers(s.data||[]);
    setPurchases(p.data||[]);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => suppliers.filter(s => {
    if (filterActive === 'activos' && !s.is_active) return false;
    if (filterActive === 'inactivos' && s.is_active) return false;
    if (filterCat && s.category !== filterCat) return false;
    if (search && !((s.name||'')+' '+(s.contact_name||'')+' '+(s.ruc||'')).toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [suppliers, search, filterCat, filterActive]);

  const removeSupplier = async (id) => {
    if (!confirm('¿Desactivar este proveedor? (Podrás reactivarlo después)')) return;
    const { error } = await db.from('suppliers').update({is_active:false, updated_at: new Date().toISOString()}).eq('id', id);
    if (error) toast(error.message, false); else { toast('Proveedor desactivado'); load(); }
  };

  const reactivate = async (id) => {
    const { error } = await db.from('suppliers').update({is_active:true, updated_at: new Date().toISOString()}).eq('id', id);
    if (error) toast(error.message, false); else { toast('Proveedor reactivado'); load(); }
  };

  if (loading) return <div style={{padding:40,textAlign:'center'}}><span className="spin"/></div>;

  /* Estadísticas básicas */
  const stats = {
    total: suppliers.filter(s => s.is_active).length,
    pendientes: purchases.filter(p => p.status === 'pendiente').reduce((s,p) => s + Number(p.total||0) - Number(p.paid_amount||0), 0),
    mesActual: purchases.filter(p => {
      const d = new Date(p.purchase_date); const now = new Date();
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).reduce((s,p) => s + Number(p.total||0), 0)
  };

  return (
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18,flexWrap:'wrap',gap:10}}>
        <div>
          <h2 style={{fontSize:22,fontWeight:800}}>Proveedores</h2>
          <div style={{fontSize:12,color:C.dim,marginTop:2}}>Agenda y registro de proveedores · compras y deudas</div>
        </div>
        <div style={{display:'flex',gap:8}}>
          {tab === 'lista' && <button onClick={() => { setEditing(null); setShowForm(true); }} style={{background:C.ink,color:C.sidebar,border:'none',padding:'9px 16px',borderRadius:8,fontSize:13,fontWeight:700,cursor:'pointer'}}>+ Nuevo proveedor</button>}
          {tab === 'compras' && <button onClick={() => { setEditingPurchase(null); setShowPurchaseForm(true); }} style={{background:C.ink,color:C.sidebar,border:'none',padding:'9px 16px',borderRadius:8,fontSize:13,fontWeight:700,cursor:'pointer'}}>+ Registrar compra</button>}
        </div>
      </div>

      <div style={{display:'flex',gap:12,flexWrap:'wrap',marginBottom:18}}>
        <KpiCard label="Proveedores activos" value={stats.total}/>
        <KpiCard label="Compras este mes" value={'₲ ' + (Math.round(stats.mesActual)||0).toLocaleString('es-PY')} accent="#34C759"/>
        <KpiCard label="A pagar" value={'₲ ' + (Math.round(stats.pendientes)||0).toLocaleString('es-PY')} sub={`${purchases.filter(p=>p.status==='pendiente').length} facturas`} accent={stats.pendientes>0?'#FF9500':'#86868B'}/>
      </div>

      <div style={{display:'flex',gap:6,borderBottom:`1px solid ${C.border}`,marginBottom:16}}>
        {[['lista','Proveedores'],['compras','Compras / Facturas'],['estadisticas','Estadísticas']].map(([k,l]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            padding:'10px 16px',background:'none',border:'none',borderBottom:`2px solid ${tab===k?C.ink:'transparent'}`,
            color:tab===k?C.ink:C.dim,fontSize:13,fontWeight:tab===k?700:500,cursor:'pointer',marginBottom:-1
          }}>{l}</button>
        ))}
      </div>

      {tab === 'lista' && (
        <>
          <div style={{display:'flex',gap:10,marginBottom:14,flexWrap:'wrap'}}>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar nombre, contacto o RUC…" style={{flex:1,minWidth:200,padding:'8px 12px',fontSize:13,borderRadius:6}}/>
            <select value={filterCat} onChange={e=>setFilterCat(e.target.value)} style={{padding:'8px 12px',fontSize:13,borderRadius:6,minWidth:150}}>
              <option value="">Todas las categorías</option>
              {SUPPLIER_CATS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={filterActive} onChange={e=>setFilterActive(e.target.value)} style={{padding:'8px 12px',fontSize:13,borderRadius:6,minWidth:130}}>
              <option value="activos">Activos</option>
              <option value="inactivos">Inactivos</option>
              <option value="todos">Todos</option>
            </select>
          </div>

          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,overflow:'hidden'}}>
            <table style={{width:'100%',borderCollapse:'collapse'}}>
              <thead style={{background:C.bg}}>
                <tr>
                  <Th>Proveedor</Th>
                  <Th>Categoría</Th>
                  <Th>Contacto</Th>
                  <Th>Teléfono</Th>
                  <Th>Términos</Th>
                  <Th>Entrega</Th>
                  <Th right>Acciones</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0
                  ? <tr><td colSpan={7} style={{padding:36,textAlign:'center',color:C.dim,fontSize:13}}>Sin proveedores</td></tr>
                  : filtered.map(s => (
                      <tr key={s.id} style={{borderTop:`1px solid ${C.border}`,opacity:s.is_active?1:.5}}>
                        <Td>
                          <div style={{display:'flex',flexDirection:'column'}}>
                            <strong>{s.name}</strong>
                            {s.legal_name && <span style={{fontSize:11,color:C.dim}}>{s.legal_name}</span>}
                            {s.ruc && <span style={{fontSize:11,color:C.dim,fontFamily:"'SF Mono',ui-monospace,monospace"}}>RUC: {s.ruc}</span>}
                          </div>
                        </Td>
                        <Td dim>{s.category||'—'}</Td>
                        <Td>{s.contact_name||'—'}</Td>
                        <Td mono dim>{s.phone||'—'}</Td>
                        <Td dim>{s.payment_terms||'—'}</Td>
                        <Td dim>{s.delivery_days||'—'}</Td>
                        <Td right>
                          <div style={{display:'flex',gap:6,justifyContent:'flex-end'}}>
                            <button onClick={() => { setEditing(s); setShowForm(true); }} style={{background:C.bg,border:`1px solid ${C.border}`,padding:'5px 10px',fontSize:12,fontWeight:600,borderRadius:5,cursor:'pointer'}}>Editar</button>
                            {s.is_active
                              ? <button onClick={() => removeSupplier(s.id)} style={{background:TINT.redBg,color:TINT.redText,border:`1px solid ${TINT.redBorder}`,padding:'5px 10px',fontSize:12,fontWeight:600,borderRadius:5,cursor:'pointer'}}>Desactivar</button>
                              : <button onClick={() => reactivate(s.id)} style={{background:TINT.greenBg,color:TINT.greenText,border:`1px solid ${TINT.greenBorder}`,padding:'5px 10px',fontSize:12,fontWeight:600,borderRadius:5,cursor:'pointer'}}>Reactivar</button>}
                          </div>
                        </Td>
                      </tr>
                    ))
                }
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'compras' && (
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,overflow:'hidden'}}>
          <table style={{width:'100%',borderCollapse:'collapse'}}>
            <thead style={{background:C.bg}}>
              <tr>
                <Th>Fecha</Th>
                <Th>Proveedor</Th>
                <Th>Factura</Th>
                <Th>Estado</Th>
                <Th right>Total</Th>
                <Th right>Pagado</Th>
                <Th right>Saldo</Th>
                <Th right>Acciones</Th>
              </tr>
            </thead>
            <tbody>
              {purchases.length === 0
                ? <tr><td colSpan={8} style={{padding:36,textAlign:'center',color:C.dim,fontSize:13}}>Sin compras registradas</td></tr>
                : purchases.map(p => {
                    const supp = suppliers.find(s => s.id === p.supplier_id);
                    const saldo = Number(p.total||0) - Number(p.paid_amount||0);
                    return (
                      <tr key={p.id} style={{borderTop:`1px solid ${C.border}`}}>
                        <Td mono>{p.purchase_date}</Td>
                        <Td><strong>{supp?.name || p.supplier_name || '—'}</strong></Td>
                        <Td mono dim>{p.invoice_number||'—'}</Td>
                        <Td>
                          <span style={{
                            padding:'3px 8px',fontSize:11,fontWeight:700,borderRadius:5,
                            background: p.status==='pagada'?'#34C75922':p.status==='parcial'?'#FF950022':p.status==='anulada'?'#86868B22':'#FF3B3022',
                            color: p.status==='pagada'?'#1A7E37':p.status==='parcial'?'#FF9500':p.status==='anulada'?'#86868B':'#C0190F'
                          }}>{p.status}</span>
                        </Td>
                        <Td right mono><strong>{'₲ '+(Math.round(p.total)||0).toLocaleString('es-PY')}</strong></Td>
                        <Td right mono>{'₲ '+(Math.round(p.paid_amount)||0).toLocaleString('es-PY')}</Td>
                        <Td right mono style={{color:saldo>0?'#C0190F':'#86868B'}}>{'₲ '+(Math.round(saldo)||0).toLocaleString('es-PY')}</Td>
                        <Td right>
                          <button onClick={() => { setEditingPurchase(p); setShowPurchaseForm(true); }} style={{background:C.bg,border:`1px solid ${C.border}`,padding:'5px 10px',fontSize:12,fontWeight:600,borderRadius:5,cursor:'pointer'}}>Ver / Editar</button>
                        </Td>
                      </tr>
                    );
                  })}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'estadisticas' && (
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16}}>
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:18}}>
            <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>Top proveedores por gasto (mes actual)</div>
            {(() => {
              const now = new Date();
              const monthly = {};
              purchases.filter(p => {
                const d = new Date(p.purchase_date);
                return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
              }).forEach(p => {
                const k = p.supplier_id || p.supplier_name || 'desconocido';
                const name = suppliers.find(s => s.id === p.supplier_id)?.name || p.supplier_name || '—';
                if (!monthly[k]) monthly[k] = {name, total:0, count:0};
                monthly[k].total += Number(p.total||0);
                monthly[k].count++;
              });
              const sorted = Object.values(monthly).sort((a,b) => b.total - a.total).slice(0,10);
              return sorted.length === 0
                ? <div style={{padding:18,textAlign:'center',color:C.dim,fontSize:13}}>Sin compras este mes</div>
                : (
                  <table style={{width:'100%',borderCollapse:'collapse'}}>
                    <thead><tr style={{borderBottom:`1px solid ${C.border}`}}><Th>Proveedor</Th><Th right>Facturas</Th><Th right>Total</Th></tr></thead>
                    <tbody>{sorted.map((m,i) => (
                      <tr key={i} style={{borderBottom:`1px solid ${C.border}`}}>
                        <Td><strong>{m.name}</strong></Td>
                        <Td right mono>{m.count}</Td>
                        <Td right mono><strong>{'₲ '+(Math.round(m.total)||0).toLocaleString('es-PY')}</strong></Td>
                      </tr>
                    ))}</tbody>
                  </table>
                );
            })()}
          </div>

          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:18}}>
            <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>Por categoría (mes actual)</div>
            {(() => {
              const now = new Date();
              const byCat = {};
              purchases.filter(p => {
                const d = new Date(p.purchase_date);
                return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
              }).forEach(p => {
                const cat = suppliers.find(s => s.id === p.supplier_id)?.category || 'sin categoría';
                byCat[cat] = (byCat[cat]||0) + Number(p.total||0);
              });
              const sorted = Object.entries(byCat).sort((a,b) => b[1] - a[1]);
              const total = sorted.reduce((s,[,v]) => s + v, 0);
              return sorted.length === 0
                ? <div style={{padding:18,textAlign:'center',color:C.dim,fontSize:13}}>Sin datos</div>
                : <div style={{display:'flex',flexDirection:'column',gap:8}}>{sorted.map(([cat,val]) => {
                    const pct = total ? (val/total*100) : 0;
                    return (
                      <div key={cat}>
                        <div style={{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:3}}>
                          <span style={{fontWeight:600}}>{cat}</span>
                          <span style={{fontFamily:"'SF Mono',ui-monospace,monospace"}}>{'₲ '+(Math.round(val)||0).toLocaleString('es-PY')} <span style={{color:C.dim}}>({pct.toFixed(0)}%)</span></span>
                        </div>
                        <div style={{height:6,background:C.bg,borderRadius:3}}>
                          <div style={{width:`${pct}%`,height:'100%',background:C.ink,borderRadius:3}}/>
                        </div>
                      </div>
                    );
                  })}</div>;
            })()}
          </div>
        </div>
      )}

      {showForm && <SupplierFormModal supplier={editing} onClose={() => { setShowForm(false); setEditing(null); }} onSaved={() => { setShowForm(false); setEditing(null); load(); }}/>}
      {showPurchaseForm && <PurchaseFormModal purchase={editingPurchase} suppliers={suppliers} onClose={() => { setShowPurchaseForm(false); setEditingPurchase(null); }} onSaved={() => { setShowPurchaseForm(false); setEditingPurchase(null); load(); }}/>}
    </div>
  );
}

function SupplierFormModal({supplier, onClose, onSaved}) {
  const isNew = !supplier;
  const [f, setF] = useState({
    name: supplier?.name || '',
    ruc: supplier?.ruc || '',
    legal_name: supplier?.legal_name || '',
    category: supplier?.category || '',
    phone: supplier?.phone || '',
    email: supplier?.email || '',
    address: supplier?.address || '',
    city: supplier?.city || '',
    contact_name: supplier?.contact_name || '',
    payment_terms: supplier?.payment_terms || '',
    delivery_days: supplier?.delivery_days || '',
    min_order: supplier?.min_order || '',
    notes: supplier?.notes || '',
    rating: supplier?.rating || ''
  });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!f.name.trim()) { toast('Indicá el nombre del proveedor', false); return; }
    setSaving(true);
    const payload = {
      ...f, restaurant_id: RID,
      min_order: f.min_order ? Number(f.min_order) : null,
      rating: f.rating ? Number(f.rating) : null,
      updated_at: new Date().toISOString()
    };
    Object.keys(payload).forEach(k => { if (payload[k] === '') payload[k] = null; });
    const q = isNew ? db.from('suppliers').insert(payload) : db.from('suppliers').update(payload).eq('id', supplier.id);
    const { error } = await q;
    setSaving(false);
    if (error) toast(error.message, false); else { toast(isNew?'Proveedor creado':'Proveedor actualizado'); onSaved(); }
  };

  useEffect(() => { _modalCount++; return () => { _modalCount = Math.max(0, _modalCount-1); }; }, []);

  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.7)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000,padding:20}}>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:24,width:'100%',maxWidth:580,maxHeight:'92vh',overflowY:'auto'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18}}>
          <div style={{fontSize:15,fontWeight:700}}>{isNew?'Nuevo proveedor':'Editar proveedor'}</div>
          <button onClick={onClose} style={{background:'none',border:'none',color:C.mid,fontSize:22,lineHeight:1,padding:0,cursor:'pointer'}}>×</button>
        </div>

        <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:10,marginBottom:10}}>
          <div><div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Nombre comercial *</div>
            <input value={f.name} onChange={e=>setF({...f, name:e.target.value})} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6}}/></div>
          <div><div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>RUC</div>
            <input value={f.ruc} onChange={e=>setF({...f, ruc:e.target.value})} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6,fontFamily:"'SF Mono',ui-monospace,monospace"}}/></div>
        </div>

        <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:10,marginBottom:10}}>
          <div><div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Razón social</div>
            <input value={f.legal_name} onChange={e=>setF({...f, legal_name:e.target.value})} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6}}/></div>
          <div><div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Categoría</div>
            <select value={f.category} onChange={e=>setF({...f, category:e.target.value})} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6}}>
              <option value="">— Elegir —</option>
              {SUPPLIER_CATS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
          <div><div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Contacto principal</div>
            <input value={f.contact_name} onChange={e=>setF({...f, contact_name:e.target.value})} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6}}/></div>
          <div><div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Teléfono</div>
            <input value={f.phone} onChange={e=>setF({...f, phone:e.target.value})} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6}}/></div>
        </div>

        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
          <div><div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Email</div>
            <input type="email" value={f.email} onChange={e=>setF({...f, email:e.target.value})} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6}}/></div>
          <div><div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Ciudad</div>
            <input value={f.city} onChange={e=>setF({...f, city:e.target.value})} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6}}/></div>
        </div>

        <div style={{marginBottom:10}}>
          <div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Dirección</div>
          <input value={f.address} onChange={e=>setF({...f, address:e.target.value})} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6}}/>
        </div>

        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:10}}>
          <div><div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Términos de pago</div>
            <input value={f.payment_terms} onChange={e=>setF({...f, payment_terms:e.target.value})} placeholder="ej: 30 días" style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6}}/></div>
          <div><div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Días de entrega</div>
            <input value={f.delivery_days} onChange={e=>setF({...f, delivery_days:e.target.value})} placeholder="ej: lun, mié, vie" style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6}}/></div>
          <div><div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Pedido mínimo (₲)</div>
            <MoneyInp value={f.min_order} onChange={v=>setF({...f, min_order:v})} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6,fontFamily:"'SF Mono',ui-monospace,monospace"}}/></div>
        </div>

        <div style={{marginBottom:10}}>
          <div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Valoración (1-5)</div>
          <select value={f.rating} onChange={e=>setF({...f, rating:e.target.value})} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6}}>
            <option value="">— Sin valorar —</option>
            {[1,2,3,4,5].map(n => <option key={n} value={n}>{'★'.repeat(n)} ({n})</option>)}
          </select>
        </div>

        <div style={{marginBottom:14}}>
          <div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Notas</div>
          <textarea value={f.notes} onChange={e=>setF({...f, notes:e.target.value})} rows={3} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6,fontFamily:'inherit',resize:'vertical'}}/>
        </div>

        <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:8}}>
          <button onClick={onClose} style={{padding:'9px 16px',border:`1px solid ${C.border}`,borderRadius:8,background:'transparent',color:C.mid,fontSize:13,fontWeight:600,cursor:'pointer'}}>Cancelar</button>
          <button onClick={save} disabled={saving} style={{padding:'9px 18px',border:'none',borderRadius:8,background:C.ink,color:C.sidebar,fontSize:13,fontWeight:700,cursor:saving?'not-allowed':'pointer',opacity:saving?.5:1}}>
            {saving?'Guardando…':(isNew?'Crear proveedor':'Guardar cambios')}
          </button>
        </div>
      </div>
    </div>
  );
}

function PurchaseFormModal({purchase, suppliers, onClose, onSaved}) {
  const isNew = !purchase;
  const [f, setF] = useState({
    supplier_id: purchase?.supplier_id || '',
    invoice_number: purchase?.invoice_number || '',
    purchase_date: purchase?.purchase_date || new Date().toISOString().slice(0,10),
    total: purchase?.total || '',
    paid_amount: purchase?.paid_amount || 0,
    status: purchase?.status || 'pendiente',
    payment_method: purchase?.payment_method || '',
    due_date: purchase?.due_date || '',
    notes: purchase?.notes || ''
  });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!f.total || Number(f.total) <= 0) { toast('Indicá el total', false); return; }
    setSaving(true);
    const supp = suppliers.find(s => s.id === f.supplier_id);
    const payload = {
      ...f, restaurant_id: RID,
      supplier_id: f.supplier_id || null,
      supplier_name: supp?.name || null,
      total: Number(f.total),
      paid_amount: Number(f.paid_amount||0),
      due_date: f.due_date || null,
      payment_method: f.payment_method || null
    };
    if (f.status === 'pagada' && !purchase?.paid_at) payload.paid_at = new Date().toISOString();
    Object.keys(payload).forEach(k => { if (payload[k] === '') payload[k] = null; });
    const q = isNew ? db.from('supplier_purchases').insert(payload) : db.from('supplier_purchases').update(payload).eq('id', purchase.id);
    const { error } = await q;
    setSaving(false);
    if (error) toast(error.message, false); else { toast(isNew?'Compra registrada':'Compra actualizada'); onSaved(); }
  };

  useEffect(() => { _modalCount++; return () => { _modalCount = Math.max(0, _modalCount-1); }; }, []);

  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.7)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000,padding:20}}>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:24,width:'100%',maxWidth:500,maxHeight:'92vh',overflowY:'auto'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18}}>
          <div style={{fontSize:15,fontWeight:700}}>{isNew?'Registrar compra':'Editar compra'}</div>
          <button onClick={onClose} style={{background:'none',border:'none',color:C.mid,fontSize:22,lineHeight:1,padding:0,cursor:'pointer'}}>×</button>
        </div>

        <div style={{marginBottom:10}}>
          <div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Proveedor</div>
          <select value={f.supplier_id} onChange={e=>setF({...f, supplier_id:e.target.value})} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6}}>
            <option value="">— Elegir —</option>
            {suppliers.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
          <div><div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Nº factura</div>
            <input value={f.invoice_number} onChange={e=>setF({...f, invoice_number:e.target.value})} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6,fontFamily:"'SF Mono',ui-monospace,monospace"}}/></div>
          <div><div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Fecha compra</div>
            <input type="date" value={f.purchase_date} onChange={e=>setF({...f, purchase_date:e.target.value})} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6}}/></div>
        </div>

        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
          <div><div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Total (₲) *</div>
            <MoneyInp value={f.total} onChange={v=>setF({...f, total:v})} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6,fontFamily:"'SF Mono',ui-monospace,monospace"}}/></div>
          <div><div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Pagado (₲)</div>
            <MoneyInp value={f.paid_amount} onChange={v=>setF({...f, paid_amount:v})} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6,fontFamily:"'SF Mono',ui-monospace,monospace"}}/></div>
        </div>

        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
          <div><div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Estado</div>
            <select value={f.status} onChange={e=>setF({...f, status:e.target.value})} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6}}>
              <option value="pendiente">Pendiente</option>
              <option value="parcial">Parcial</option>
              <option value="pagada">Pagada</option>
              <option value="anulada">Anulada</option>
            </select>
          </div>
          <div><div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Vencimiento</div>
            <input type="date" value={f.due_date} onChange={e=>setF({...f, due_date:e.target.value})} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6}}/></div>
        </div>

        <div style={{marginBottom:10}}>
          <div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Método de pago</div>
          <select value={f.payment_method} onChange={e=>setF({...f, payment_method:e.target.value})} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6}}>
            <option value="">— Elegir —</option>
            <option value="efectivo">Efectivo</option>
            <option value="transferencia">Transferencia</option>
            <option value="cheque">Cheque</option>
            <option value="tarjeta">Tarjeta</option>
            <option value="otro">Otro</option>
          </select>
        </div>

        <div style={{marginBottom:14}}>
          <div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:5,letterSpacing:1,textTransform:'uppercase'}}>Notas</div>
          <textarea value={f.notes} onChange={e=>setF({...f, notes:e.target.value})} rows={3} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6,fontFamily:'inherit',resize:'vertical'}}/>
        </div>

        <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
          <button onClick={onClose} style={{padding:'9px 16px',border:`1px solid ${C.border}`,borderRadius:8,background:'transparent',color:C.mid,fontSize:13,fontWeight:600,cursor:'pointer'}}>Cancelar</button>
          <button onClick={save} disabled={saving} style={{padding:'9px 18px',border:'none',borderRadius:8,background:C.ink,color:C.sidebar,fontSize:13,fontWeight:700,cursor:saving?'not-allowed':'pointer',opacity:saving?.5:1}}>
            {saving?'Guardando…':(isNew?'Registrar':'Guardar cambios')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   SOPORTE (chat con Mythos / Superadmin)
══════════════════════════════════════════════ */
const SUPPORT_CATS = {
  problema_tecnico:'Problema técnico',
  consulta:'Consulta',
  facturacion:'Facturación',
  sugerencia:'Sugerencia',
  urgente:'Urgente',
  otro:'Otro'
};
const SUPPORT_STATUS = {
  abierto:{label:'Abierto', color:'#007AFF'},
  en_curso:{label:'En curso', color:'#FF9500'},
  esperando_cliente:{label:'Esperando respuesta', color:C.dim},
  resuelto:{label:'Resuelto', color:'#34C759'},
  cerrado:{label:'Cerrado', color:C.mid}
};
function SupportPill({status}) {
  const s = SUPPORT_STATUS[status]||{label:status,color:C.mid};
  return <span style={{display:'inline-flex',alignItems:'center',gap:5,padding:'2px 8px',fontSize:11,fontWeight:700,background:s.color+'22',color:s.color,border:`1px solid ${s.color}44`,borderRadius:5}}><span style={{width:5,height:5,borderRadius:'50%',background:s.color}}/>{s.label}</span>;
}

function AvisosAdmin({restaurant}) {
  const profile  = window._userProfile || {};
  const [sent,     setSent]    = useState([]);
  const [msg,      setMsg]     = useState('');
  const [target,   setTarget]  = useState('todos');
  const [sending,  setSending] = useState(false);
  const [confirm,  setConfirm] = useState(null);

  const TARGETS = [
    {v:'todos',          lbl:'Todos (incluye gerente + trabajadores)'},
    {v:'trabajadores',   lbl:'Todos los trabajadores (cocina, mozo, caja, riders)'},
    {v:'supervisor_local', lbl:'Solo Gerentes'},
    {v:'cocina',         lbl:'Solo Cocina'},
    {v:'mozo',           lbl:'Solo Mozos'},
    {v:'cajero',         lbl:'Solo Caja'},
    {v:'rider',          lbl:'Solo Delivery riders'},
  ];

  useEffect(() => {
    if (!db) return;
    const load = async () => {
      const { data } = await db.from('staff_broadcasts')
        .select('*').eq('restaurant_id', RID)
        .order('created_at', { ascending: false }).limit(50);
      setSent(data || []);
    };
    load();
    const ch = db.channel('bc-admin')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'staff_broadcasts' }, () => load())
      .subscribe();
    return () => db.removeChannel(ch);
  }, []);

  async function enviar() {
    if (!msg.trim() || !db) return;
    setSending(true);
    const { error } = await db.from('staff_broadcasts').insert({
      restaurant_id: RID,
      sender_name: profile.display_name || profile.username || 'Admin',
      sender_role: 'admin',
      target_roles: [target],
      message: msg.trim(),
    });
    setSending(false);
    if (error) { toast('Error al enviar: ' + error.message, false); return; }
    setConfirm('Aviso enviado');
    setMsg('');
    setTimeout(() => setConfirm(null), 3000);
  }

  const targetLabel = v => TARGETS.find(t => t.v === v)?.lbl || v;

  return (
    <div>
      <h2 style={{fontSize:22,fontWeight:800,letterSpacing:-0.5,marginBottom:4}}>Avisos al personal</h2>
      <p style={{fontSize:12,color:C.mid,marginBottom:24}}>Enviá avisos a todo el personal o grupos específicos. Los avisos aparecen en tiempo real en los paneles receptores.</p>

      {/* Formulario */}
      <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:14,padding:22,marginBottom:28,maxWidth:640}}>
        <div style={{fontSize:11,fontWeight:700,color:C.mid,marginBottom:10,textTransform:'uppercase',letterSpacing:'0.08em'}}>Nuevo aviso</div>
        <textarea
          value={msg} onChange={e=>setMsg(e.target.value)} rows={3}
          placeholder="Escribí el aviso para el personal..."
          style={{width:'100%',padding:'10px 12px',borderRadius:8,border:`1px solid ${C.border}`,fontSize:14,marginBottom:12,resize:'vertical',background:C.bg,color:C.ink,fontFamily:'inherit',boxSizing:'border-box'}}
        />
        <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
          <select value={target} onChange={e=>setTarget(e.target.value)}
            style={{padding:'8px 12px',borderRadius:8,border:`1px solid ${C.border}`,fontSize:13,background:C.bg,color:C.ink,flex:1}}>
            {TARGETS.map(t=><option key={t.v} value={t.v}>{t.lbl}</option>)}
          </select>
          <Btn onClick={enviar} disabled={!msg.trim()||sending}>{sending?'Enviando…':'Enviar aviso'}</Btn>
          {confirm && <span style={{fontSize:12,color:C.green,fontWeight:600}}>{confirm}</span>}
        </div>
      </div>

      {/* Historial */}
      <div style={{fontSize:11,fontWeight:700,color:C.mid,marginBottom:12,textTransform:'uppercase',letterSpacing:'0.08em'}}>Historial de avisos</div>
      {sent.length === 0
        ? <div style={{color:C.mid,fontSize:13}}>Sin avisos enviados aún</div>
        : <div style={{display:'flex',flexDirection:'column',gap:8,maxWidth:640}}>
            {sent.map(b=>{
              const isAdmin = b.sender_role === 'admin';
              return(
                <div key={b.id} style={{background:C.white,border:`1px solid ${C.border}`,borderLeft:`4px solid ${isAdmin?C.green:'#007AFF'}`,borderRadius:10,padding:'12px 16px'}}>
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                    <span style={{fontSize:12,fontWeight:700,color:C.dim}}>{b.sender_name} <span style={{fontWeight:400}}>→ {targetLabel(b.target_roles?.[0]||'?')}</span></span>
                    <span style={{fontSize:11,color:C.dim}}>{new Date(b.created_at).toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit'})} · {new Date(b.created_at).toLocaleDateString('es',{day:'2-digit',month:'2-digit'})}</span>
                  </div>
                  <div style={{fontSize:14,color:C.ink,lineHeight:1.5}}>{b.message}</div>
                </div>
              );
            })}
          </div>
      }
    </div>
  );
}

function SoportePage({restaurant}) {
  const profile = window._userProfile||{};
  const [user, setUser] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!db) return;
    db.auth.getSession().then(({data:{session}}) => setUser(session?.user||null));
  }, []);

  const userName = profile.display_name||profile.username||'Admin';
  const userEmail = user?.email||null;
  const restaurantName = restaurant?.name||'';
  const restaurantPhone = restaurant?.phone||null;

  const loadTickets = useCallback(async () => {
    if (!db) return;
    const { data } = await db.from('support_tickets')
      .select('*')
      .eq('restaurant_id', RID)
      .order('last_message_at', {ascending:false})
      .limit(80);
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
    await db.rpc('support_mark_read', {p_ticket_id: ticketId, p_side: 'client'});
    loadTickets();
  }, [loadTickets]);

  useEffect(() => { loadTickets(); }, [loadTickets]);

  useEffect(() => {
    if (!db) return;
    const ch = db.channel('support-admin-rt')
      .on('postgres_changes',{event:'*',schema:'public',table:'support_tickets',filter:`restaurant_id=eq.${RID}`}, () => loadTickets())
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'support_messages'},(payload) => {
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

  async function createTicket({subject, category, priority, body}) {
    if (!db) return null;
    const { data: t, error } = await db.from('support_tickets').insert({
      restaurant_id: RID,
      restaurant_name: restaurantName,
      created_by_user_id: profile.id||user?.id||null,
      created_by_name: userName,
      created_by_username: profile.username||null,
      created_by_role: profile.role||'admin',
      created_by_email: userEmail,
      created_by_phone: restaurantPhone,
      subject, category, priority,
      status:'abierto',
      last_message_at: new Date().toISOString(),
      last_message_preview: body.slice(0,140),
      last_message_by_side: 'client',
      total_messages: 0
    }).select('*').single();
    if (error || !t) { toast('No se pudo crear el ticket: '+(error?.message||''), false); return null; }
    const { error: e2 } = await db.from('support_messages').insert({
      ticket_id: t.id,
      author_user_id: profile.id||user?.id||null,
      author_name: userName,
      author_role: profile.role||'admin',
      author_side: 'client',
      body
    });
    if (e2) { toast('No se pudo enviar el mensaje: '+e2.message, false); return null; }
    toast('Ticket enviado a Mythos');
    await loadTickets();
    const { data: fresh } = await db.from('support_tickets').select('*').eq('id', t.id).single();
    setSelected(fresh||t);
    loadMessages(t.id);
    return t;
  }

  async function sendReply(body) {
    if (!db || !selected || !body.trim()) return;
    const { error } = await db.from('support_messages').insert({
      ticket_id: selected.id,
      author_user_id: profile.id||user?.id||null,
      author_name: userName,
      author_role: profile.role||'admin',
      author_side: 'client',
      body: body.trim()
    });
    if (error) { toast('Error: '+error.message, false); return; }
    loadMessages(selected.id);
  }

  return (
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
        <div>
          <h2 style={{fontSize:22,fontWeight:800,letterSpacing:-0.5}}>Soporte Mythos</h2>
          <div style={{fontSize:12,color:C.mid,marginTop:3}}>Chat directo con el equipo Mythos · Tus datos se envían automáticamente</div>
        </div>
        <Btn onClick={() => setShowNew(true)}>＋ Nueva consulta</Btn>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'340px 1fr',gap:14,minHeight:560,height:'calc(100vh - 160px)'}}>
        {/* LISTA */}
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,display:'flex',flexDirection:'column',overflow:'hidden'}}>
          <div style={{padding:'12px 14px',borderBottom:`1px solid ${C.border}`,fontSize:11,color:C.mid,fontWeight:700,textTransform:'uppercase',letterSpacing:1}}>
            Mis tickets ({tickets.length})
          </div>
          <div style={{flex:1,overflowY:'auto'}}>
            {loading ? <div style={{padding:30,textAlign:'center'}}><span className="spin"/></div>
              : tickets.length === 0
                ? <div style={{padding:30,textAlign:'center',color:C.dim,fontSize:13}}>Sin tickets todavía.<br/>Abrí uno nuevo para escribirle al equipo Mythos.</div>
                : tickets.map(t => {
                    const s = SUPPORT_STATUS[t.status]||{label:t.status,color:C.mid};
                    const isSel = selected?.id === t.id;
                    return (
                      <div key={t.id} onClick={() => openTicket(t)} style={{
                        padding:'12px 14px',borderBottom:`1px solid ${C.border}`,cursor:'pointer',
                        background: isSel ? TINT.blueBg : 'transparent',
                        borderLeft: isSel ? `3px solid ${C.blue}` : '3px solid transparent',
                        transition:'background .15s'
                      }}>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:6,marginBottom:4}}>
                          <div style={{fontSize:13,fontWeight:700,flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{t.subject}</div>
                          {t.unread_for_client > 0 && (
                            <span style={{background:C.red,color:'#fff',fontSize:10,fontWeight:800,padding:'1px 6px',borderRadius:8,flexShrink:0}}>{t.unread_for_client}</span>
                          )}
                        </div>
                        <div style={{fontSize:11,color:C.mid,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginBottom:6}}>
                          {t.last_message_by_side==='support' && <span style={{color:C.blue,fontWeight:700}}>Mythos: </span>}
                          {t.last_message_preview||'—'}
                        </div>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:6}}>
                          <SupportPill status={t.status}/>
                          <span style={{fontSize:10,color:C.dim}}>{fmtDT(t.last_message_at)}</span>
                        </div>
                      </div>
                    );
                  })
            }
          </div>
        </div>

        {/* CHAT */}
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,display:'flex',flexDirection:'column',overflow:'hidden'}}>
          {!selected ? (
            <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:10,padding:40,color:C.dim}}>
              <div style={{opacity:.4}}><Icon name="chat" size={28}/></div>
              <div style={{fontSize:14,fontWeight:600,color:C.mid}}>Seleccioná un ticket o creá uno nuevo</div>
              <div style={{fontSize:12,maxWidth:360,textAlign:'center'}}>El equipo Mythos verá automáticamente quién sos, tu rol y tu restaurante. Vos solo escribí tu consulta.</div>
            </div>
          ) : (
            <SoporteChatAdmin
              ticket={selected}
              messages={messages}
              onSend={sendReply}
              onClose={() => setSelected(null)}
            />
          )}
        </div>
      </div>

      {showNew && (
        <NewTicketModalAdmin
          onClose={() => setShowNew(false)}
          onCreate={async (d) => { const t = await createTicket(d); if (t) setShowNew(false); }}
          userName={userName}
          role={profile.role||'admin'}
          email={userEmail}
          restaurantName={restaurantName}
        />
      )}
    </div>
  );
}

function SoporteChatAdmin({ticket, messages, onSend, onClose}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);
  const closed = ['resuelto','cerrado'].includes(ticket.status);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  async function submit() {
    if (!draft.trim() || sending) return;
    setSending(true);
    await onSend(draft);
    setDraft('');
    setSending(false);
  }

  const PRIO_COL = {baja:'#86868B', normal:'#007AFF', alta:'#FF9500', urgente:'#FF3B30'};

  return (
    <>
      <div style={{padding:'12px 16px',borderBottom:`1px solid ${C.border}`,display:'flex',justifyContent:'space-between',alignItems:'center',gap:10}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:14,fontWeight:700,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{ticket.subject}</div>
          <div style={{display:'flex',gap:8,marginTop:4,alignItems:'center',flexWrap:'wrap'}}>
            <SupportPill status={ticket.status}/>
            <span style={{fontSize:11,color:C.mid}}>{SUPPORT_CATS[ticket.category]||ticket.category}</span>
            <span style={{fontSize:11,color:PRIO_COL[ticket.priority]||C.mid,fontWeight:700}}>· Prioridad: {ticket.priority}</span>
          </div>
        </div>
        <button onClick={onClose} style={{background:'none',color:C.mid,fontSize:20,padding:'4px 10px',border:'none',cursor:'pointer'}}>×</button>
      </div>

      <div ref={scrollRef} style={{flex:1,overflowY:'auto',padding:'18px 20px',background:'var(--bg-subtle)',display:'flex',flexDirection:'column',gap:10}}>
        {messages.length === 0 && <div style={{textAlign:'center',color:C.dim,fontSize:12,padding:20}}>Sin mensajes aún…</div>}
        {messages.map(m => {
          if (m.author_side === 'system') {
            return <div key={m.id} style={{textAlign:'center',fontSize:11,color:C.dim,padding:'4px 8px'}}>— {m.body} · {fmtTime(m.created_at)} —</div>;
          }
          const mine = m.author_side === 'client';
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
                  {mine ? 'Vos' : (m.author_name||'Mythos')} · {fmtTime(m.created_at)}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{padding:12,borderTop:`1px solid ${C.border}`,background:C.surface}}>
        {closed && (
          <div style={{fontSize:11,color:C.mid,marginBottom:8,textAlign:'center'}}>
            Este ticket está {SUPPORT_STATUS[ticket.status]?.label?.toLowerCase()}. Si volvés a escribir, se reabrirá.
          </div>
        )}
        <div style={{display:'flex',gap:8,alignItems:'flex-end'}}>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            rows={2}
            placeholder="Escribí tu mensaje al equipo Mythos…"
            onKeyDown={e => { if (e.key==='Enter' && (e.metaKey||e.ctrlKey)) submit(); }}
            style={{flex:1,minHeight:50,padding:'9px 12px',fontSize:13,borderRadius:8,resize:'none',fontFamily:'inherit'}}
          />
          <Btn onClick={submit} disabled={sending || !draft.trim()} style={{flexShrink:0,height:46}}>{sending?'Enviando…':'Enviar'}</Btn>
        </div>
        <div style={{fontSize:10,color:C.dim,marginTop:5,textAlign:'right'}}>Ctrl/Cmd + Enter para enviar</div>
      </div>
    </>
  );
}

function NewTicketModalAdmin({onClose, onCreate, userName, role, email, restaurantName}) {
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState('consulta');
  const [priority, setPriority] = useState('normal');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!subject.trim() || !body.trim()) { toast('Completá el asunto y el mensaje', false); return; }
    setSaving(true);
    await onCreate({subject:subject.trim(), category, priority, body:body.trim()});
    setSaving(false);
  }

  return (
    <Modal title="Nueva consulta a Mythos" onClose={onClose} width={560}>
      <div style={{display:'flex',flexDirection:'column',gap:14}}>
        <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:8,padding:'10px 14px',fontSize:11,color:C.mid,lineHeight:1.6}}>
          <div style={{fontWeight:700,color:C.ink,marginBottom:4,fontSize:11,textTransform:'uppercase',letterSpacing:.5}}>Datos que se envían automáticamente</div>
          <div>Restaurante: <strong style={{color:C.ink}}>{restaurantName||'—'}</strong></div>
          <div>Usuario: <strong style={{color:C.ink}}>{userName}</strong> ({role})</div>
          {email && <div>Email: <strong style={{color:C.ink}}>{email}</strong></div>}
        </div>

        <div><Lbl>Asunto</Lbl>
          <Inp value={subject} onChange={e=>setSubject(e.target.value)} placeholder="Resumen breve del problema o consulta" autoFocus/>
        </div>

        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
          <div><Lbl>Categoría</Lbl>
            <Sel value={category} onChange={e=>setCategory(e.target.value)}>
              {Object.entries(SUPPORT_CATS).map(([k,v]) => <option key={k} value={k}>{v}</option>)}
            </Sel>
          </div>
          <div><Lbl>Prioridad</Lbl>
            <Sel value={priority} onChange={e=>setPriority(e.target.value)}>
              <option value="baja">Baja</option>
              <option value="normal">Normal</option>
              <option value="alta">Alta</option>
              <option value="urgente">Urgente</option>
            </Sel>
          </div>
        </div>

        <div><Lbl>Descripción del problema / consulta</Lbl>
          <textarea value={body} onChange={e=>setBody(e.target.value)} rows={6} placeholder="Describí con el mayor detalle posible qué está pasando, qué intentaste, qué esperabas que pasara…" style={{width:'100%',padding:'10px 12px',fontSize:13,borderRadius:8,resize:'vertical',fontFamily:'inherit',minHeight:120}}/>
        </div>

        <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
          <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
          <Btn onClick={save} disabled={saving}>{saving?'Enviando…':'Enviar consulta'}</Btn>
        </div>
      </div>
    </Modal>
  );
}

/* ══════════════════════════════════════════════
   CALENDARIO
══════════════════════════════════════════════ */
// WS5: emoji → bullet geométrico monocromo '●' (U+25CF), hereda color del span.
const CAL_TYPES = {
  holiday: {label:'Feriado',    color:'#FF3B30', icon:'●'},
  event:   {label:'Evento',     color:'#007AFF', icon:'●'},
  sport:   {label:'Deportivo',  color:'#34C759', icon:'●'},
  special: {label:'Especial',   color:'#AF52DE', icon:'●'},
  promo:   {label:'Promoción',  color:'#FF9500', icon:'●'},
};
const CAL_CROWD = {
  low:    {label:'Afluencia baja',  color:'#34C759', dot:'●'},
  medium: {label:'Afluencia media', color:'#FF9500', dot:'●'},
  high:   {label:'Afluencia alta',  color:'#FF3B30', dot:'●'},
};
const CAL_WEEK  = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
const CAL_MONTHS= ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function calGridDays(year, month) {
  const first   = new Date(year, month, 1);
  const last    = new Date(year, month + 1, 0);
  const startDow = (first.getDay() + 6) % 7; // Mon = 0
  const days = [];
  for (let i = 0; i < startDow; i++) days.push(null);
  for (let d = 1; d <= last.getDate(); d++) days.push(d);
  return days;
}

// Estados de reserva (compartidos con ReservasPage) para los indicadores del calendario.
const CAL_RES_STATUS = {
  pending:   {label:'Pendiente', color:'#FF9500'},
  confirmed: {label:'Confirmada',color:'#34C759'},
  seated:    {label:'En mesa',   color:'#007AFF'},
  no_show:   {label:'No llegó',  color:'#8E8E93'},
  cancelled: {label:'Cancelada', color:'#FF3B30'},
};

function CalendarioPage({tables, embedded}) {
  const now = new Date();
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [events, setEvents] = useState([]);
  const [reservas, setReservas] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({title:'', type:'event', end_date:'', expected_crowd:'medium', notes:''});
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [resModal, setResModal] = useState(null);   // null=cerrado · {}=nueva · objeto reserva=editar

  const loadEvents = useCallback(async () => {
    if (!db) return;
    setLoading(true);
    const mm   = String(month + 1).padStart(2,'0');
    const days = new Date(year, month + 1, 0).getDate();
    const start = `${year}-${mm}-01`, end = `${year}-${mm}-${String(days).padStart(2,'0')}`;
    const [evR, reR] = await Promise.all([
      db.from('calendar_events').select('*')
        .or(`restaurant_id.eq.${RID},is_global.eq.true`)
        .gte('date', start).lte('date', end).order('date'),
      db.from('reservations').select('*')
        .eq('restaurant_id', RID)
        .gte('reservation_date', start).lte('reservation_date', end)
        .order('reservation_time'),
    ]);
    setEvents(evR.data || []);
    setReservas(reR.data || []);
    setLoading(false);
  }, [year, month]);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  const prevMonth = () => { if (month===0){setYear(y=>y-1);setMonth(11);}else setMonth(m=>m-1); setSelected(null); };
  const nextMonth = () => { if (month===11){setYear(y=>y+1);setMonth(0);}else setMonth(m=>m+1); setSelected(null); };

  const days   = calGridDays(year, month);
  const today  = new Date();
  const isToday = d => d===today.getDate() && month===today.getMonth() && year===today.getFullYear();

  const evtsForDay = d => {
    if (!d) return [];
    const ds = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    return events.filter(e => e.date <= ds && (e.end_date ? e.end_date >= ds : e.date === ds));
  };
  const resForDay = d => {
    if (!d) return [];
    const ds = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    return reservas.filter(r => r.reservation_date === ds);
  };
  // Indicador de reservas por día: cuenta activas (no canceladas) y color por estado dominante.
  const resBadge = list => {
    const active = list.filter(r => r.status !== 'cancelled');
    if (!active.length) return null;
    const color = active.some(r => r.status === 'pending') ? '#FF9500' : '#34C759';
    return { count: active.length, color };
  };

  const selDate = selected
    ? `${year}-${String(month+1).padStart(2,'0')}-${String(selected).padStart(2,'0')}`
    : null;
  const selEvts = selected ? evtsForDay(selected) : [];
  const selRes  = selected ? resForDay(selected) : [];

  const fmtResTime = t => t ? t.slice(0,5) : '—';

  const resetForm = () => { setForm({title:'', type:'event', end_date:'', expected_crowd:'medium', notes:''}); setEditId(null); };
  const startEdit = e => { setForm({title:e.title, type:e.type, end_date:e.end_date||'', expected_crowd:e.expected_crowd||'medium', notes:e.notes||''}); setEditId(e.id); };

  const save = async () => {
    if (!form.title.trim() || !selDate || !db) return;
    setSaving(true);
    const payload = {
      restaurant_id:   RID,
      title:           form.title.trim(),
      type:            form.type,
      date:            selDate,
      end_date:        form.end_date || null,
      expected_crowd:  form.expected_crowd,
      notes:           form.notes || null,
      color:           CAL_TYPES[form.type]?.color || '#007AFF',
      is_global:       false,
    };
    if (editId) await db.from('calendar_events').update(payload).eq('id', editId);
    else        await db.from('calendar_events').insert(payload);
    setSaving(false);
    resetForm();
    loadEvents();
  };

  const del = async id => {
    if (!db) return;
    await db.from('calendar_events').delete().eq('id', id).eq('restaurant_id', RID);
    loadEvents();
  };

  const upcoming = [...events]
    .filter(e => e.date >= `${year}-${String(month+1).padStart(2,'0')}-01`)
    .sort((a,b) => a.date.localeCompare(b.date))
    .slice(0, 6);

  // Conteo de afluencia alta este mes
  const highCrowdCount = events.filter(e => e.expected_crowd === 'high').length;

  return (
    <div className={embedded?'':'page'}>
      {(!embedded || highCrowdCount > 0) && (
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:embedded?14:20,gap:12}}>
        {!embedded && (
        <div>
          <h1 style={{fontSize:22,fontWeight:800,color:C.ink,margin:0}}>Calendario de Eventos</h1>
          <div style={{fontSize:12,color:C.mid,marginTop:3}}>Planificá feriados, eventos y movimiento de público</div>
        </div>
        )}
        {highCrowdCount > 0 && (
          <div style={{background:TINT.amberBg,border:`1px solid ${TINT.amberBorder}`,borderRadius:8,padding:'6px 12px',fontSize:12,fontWeight:600,color:TINT.amberText,flexShrink:0,marginLeft:'auto'}}>
            <span style={{color:'#FF3B30'}}>●</span> {highCrowdCount} evento{highCrowdCount>1?'s':''} de alta afluencia este mes
          </div>
        )}
      </div>
      )}

      <div style={{display:'flex',gap:20,alignItems:'flex-start'}}>
        {/* ── Grilla mensual ── */}
        <div style={{flex:'1 1 0',minWidth:0}}>
          {/* Navegación mes */}
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:14}}>
            <button onClick={prevMonth} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,width:34,height:34,fontSize:17,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>‹</button>
            <div style={{flex:1,textAlign:'center',fontWeight:800,fontSize:16,color:C.ink}}>{CAL_MONTHS[month]} {year}</div>
            <button onClick={nextMonth} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,width:34,height:34,fontSize:17,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>›</button>
            <button onClick={()=>{setYear(today.getFullYear());setMonth(today.getMonth());setSelected(null);}} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'5px 10px',fontSize:11,fontWeight:700,cursor:'pointer',color:C.mid,flexShrink:0}}>Hoy</button>
          </div>

          {/* Cabecera días semana */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:2,marginBottom:3}}>
            {CAL_WEEK.map(d => <div key={d} style={{textAlign:'center',fontSize:10,fontWeight:800,color:C.mid,padding:'3px 0',textTransform:'uppercase',letterSpacing:.5}}>{d}</div>)}
          </div>

          {/* Celdas */}
          {loading ? (
            <div style={{textAlign:'center',padding:50}}><div className="spin"/></div>
          ) : (
            <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:2}}>
              {days.map((d, i) => {
                const dayEvts = evtsForDay(d);
                const rb      = d ? resBadge(resForDay(d)) : null;
                const sel     = d && selected === d;
                const isTdy   = isToday(d);
                return (
                  <div key={i}
                    onClick={() => { if (d) { setSelected(sel ? null : d); resetForm(); } }}
                    style={{
                      minHeight:68, padding:'6px 7px', borderRadius:8,
                      cursor: d ? 'pointer' : 'default',
                      background: sel ? C.ink : isTdy ? TINT.blueBg : d ? C.surface : 'transparent',
                      border: sel ? `1.5px solid ${C.ink}` : isTdy ? `1.5px solid ${C.blue}` : `1px solid ${C.border}`,
                      transition: 'all .1s',
                    }}>
                    {d && <>
                      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:4,marginBottom:4}}>
                        <div style={{fontSize:12,fontWeight:isTdy?800:500,color:sel?C.surface:isTdy?C.blue:C.ink,lineHeight:1}}>{d}</div>
                        {rb && (
                          <div title={`${rb.count} reserva${rb.count!==1?'s':''}`}
                            style={{display:'flex',alignItems:'center',gap:2,background:rb.color,color:'#fff',borderRadius:8,padding:'0 5px',height:14,fontSize:9,fontWeight:800,lineHeight:'14px',flexShrink:0}}>
                            <Icon name="users" size={8}/>{rb.count}
                          </div>
                        )}
                      </div>
                      <div style={{display:'flex',flexWrap:'wrap',gap:2}}>
                        {dayEvts.slice(0,3).map(e => (
                          <div key={e.id} style={{width:7,height:7,borderRadius:'50%',background:CAL_TYPES[e.type]?.color||'#007AFF',opacity:sel?.85:1,flexShrink:0}}/>
                        ))}
                        {dayEvts.length > 3 && <div style={{fontSize:9,color:sel?'#ccc':C.mid,lineHeight:'7px'}}>+{dayEvts.length-3}</div>}
                      </div>
                    </>}
                  </div>
                );
              })}
            </div>
          )}

          {/* Leyenda tipos */}
          <div style={{display:'flex',flexWrap:'wrap',gap:14,marginTop:14,paddingTop:12,borderTop:`1px solid ${C.border}`}}>
            {Object.entries(CAL_TYPES).map(([k,v]) => (
              <div key={k} style={{display:'flex',alignItems:'center',gap:5,fontSize:11,color:C.mid}}>
                <div style={{width:8,height:8,borderRadius:'50%',background:v.color}}/>
                {v.label}
              </div>
            ))}
          </div>
        </div>

        {/* ── Panel lateral ── */}
        <div style={{width:310,flexShrink:0}}>
          {selected ? (
            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:16}}>
              <div style={{fontWeight:800,fontSize:13,marginBottom:12,color:C.ink,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                <span>{String(selected).padStart(2,'0')} {CAL_MONTHS[month].substring(0,3)} {year}</span>
                <span style={{fontSize:11,color:C.mid,fontWeight:400}}>{selEvts.length} evento{selEvts.length!==1?'s':''}</span>
              </div>

              {selEvts.map(e => (
                <div key={e.id} style={{background:C.bg,borderRadius:8,padding:'10px 12px',marginBottom:6,borderLeft:`3px solid ${CAL_TYPES[e.type]?.color||'#007AFF'}`}}>
                  <div style={{display:'flex',alignItems:'flex-start',gap:8}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:600,fontSize:13,color:C.ink,marginBottom:3}}>{CAL_TYPES[e.type]?.icon} {e.title}</div>
                      <div style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:e.notes?3:0}}>
                        <span style={{fontSize:10,padding:'1px 6px',borderRadius:4,background:CAL_TYPES[e.type]?.color+'22',color:CAL_TYPES[e.type]?.color,fontWeight:700}}>{CAL_TYPES[e.type]?.label}</span>
                        <span style={{fontSize:10,padding:'1px 6px',borderRadius:4,background:CAL_CROWD[e.expected_crowd]?.color+'22',color:CAL_CROWD[e.expected_crowd]?.color,fontWeight:700}}>{CAL_CROWD[e.expected_crowd]?.dot} {CAL_CROWD[e.expected_crowd]?.label}</span>
                        {e.is_global && <span style={{fontSize:10,padding:'1px 6px',borderRadius:4,background:'var(--bg-subtle)',color:'#8E8E93',fontWeight:700}}>Global</span>}
                        {e.end_date && e.end_date !== e.date && <span style={{fontSize:10,color:C.mid}}>hasta {e.end_date}</span>}
                      </div>
                      {e.notes && <div style={{fontSize:11,color:C.mid,marginTop:2}}>{e.notes}</div>}
                    </div>
                    {e.restaurant_id === RID && (
                      <div style={{display:'flex',gap:3,flexShrink:0}}>
                        <button onClick={()=>startEdit(e)} style={{background:'none',border:`1px solid ${C.border}`,borderRadius:5,padding:'2px 7px',fontSize:11,cursor:'pointer',color:C.mid}}>✎</button>
                        <button onClick={()=>del(e.id)} style={{background:'none',border:`1px solid rgba(239,68,68,.3)`,borderRadius:5,padding:'2px 7px',fontSize:11,cursor:'pointer',color:C.red}}>✕</button>
                      </div>
                    )}
                  </div>
                </div>
              ))}

              <div style={{borderTop:selEvts.length?`1px solid ${C.border}`:'none',paddingTop:selEvts.length?12:0,marginTop:selEvts.length?4:0}}>
                <div style={{fontSize:10,fontWeight:800,color:C.mid,textTransform:'uppercase',letterSpacing:.5,marginBottom:8}}>
                  {editId ? '✎ Editar evento' : '+ Nuevo evento'}
                </div>
                <div style={{display:'flex',flexDirection:'column',gap:7}}>
                  <input value={form.title} onChange={e=>setForm(f=>({...f,title:e.target.value}))} placeholder="Título del evento" style={{padding:'8px 10px',fontSize:13,borderRadius:7,border:`1px solid ${C.border}`,width:'100%'}}/>
                  <select value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value}))} style={{padding:'8px 10px',fontSize:13,borderRadius:7,border:`1px solid ${C.border}`}}>
                    {Object.entries(CAL_TYPES).map(([k,v])=><option key={k} value={k}>{v.icon} {v.label}</option>)}
                  </select>
                  <select value={form.expected_crowd} onChange={e=>setForm(f=>({...f,expected_crowd:e.target.value}))} style={{padding:'8px 10px',fontSize:13,borderRadius:7,border:`1px solid ${C.border}`}}>
                    {Object.entries(CAL_CROWD).map(([k,v])=><option key={k} value={k}>{v.dot} {v.label}</option>)}
                  </select>
                  <div>
                    <div style={{fontSize:10,color:C.mid,marginBottom:3}}>Hasta (multi-día, opcional)</div>
                    <input type="date" value={form.end_date} onChange={e=>setForm(f=>({...f,end_date:e.target.value}))} style={{padding:'7px 10px',fontSize:12,borderRadius:7,border:`1px solid ${C.border}`,width:'100%'}}/>
                  </div>
                  <textarea value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} placeholder="Notas (opcional)" rows={2} style={{padding:'8px 10px',fontSize:12,borderRadius:7,border:`1px solid ${C.border}`,resize:'none',fontFamily:'inherit'}}/>
                  <div style={{display:'flex',gap:6}}>
                    {editId && <Btn variant="ghost" small onClick={resetForm} style={{flex:1}}>Cancelar</Btn>}
                    <Btn small onClick={save} disabled={saving||!form.title.trim()} style={{flex:1}}>
                      {saving ? 'Guardando…' : editId ? 'Guardar cambios' : 'Agregar evento'}
                    </Btn>
                  </div>
                </div>
              </div>

              {/* ── Reservas del día ── */}
              <div style={{borderTop:`1px solid ${C.border}`,marginTop:14,paddingTop:12}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
                  <div style={{fontSize:10,fontWeight:800,color:C.mid,textTransform:'uppercase',letterSpacing:.5}}>
                    Reservas del día{selRes.length>0 && <span style={{fontWeight:600}}> · {selRes.length}</span>}
                  </div>
                  <button onClick={()=>setResModal({})} style={{background:C.ink,color:C.sidebar,border:'none',borderRadius:6,padding:'4px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>+ Nueva</button>
                </div>
                {selRes.length===0 ? (
                  <div style={{fontSize:11,color:C.mid,padding:'2px 0 4px'}}>Sin reservas para este día.</div>
                ) : selRes.map(r=>{
                  const sc=CAL_RES_STATUS[r.status]||CAL_RES_STATUS.pending;
                  return (
                    <div key={r.id} onClick={()=>setResModal(r)}
                      style={{background:C.bg,borderRadius:8,padding:'8px 10px',marginBottom:6,cursor:'pointer',borderLeft:`3px solid ${sc.color}`}}>
                      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
                        <div style={{minWidth:0}}>
                          <div style={{fontSize:12,fontWeight:600,color:C.ink,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.customer_name}</div>
                          <div style={{fontSize:10,color:C.mid}}>{fmtResTime(r.reservation_time)} · {r.guests} pers.{r.confirm_num?` · ${r.confirm_num}`:''}</div>
                        </div>
                        <span style={{fontSize:9,fontWeight:700,color:sc.color,border:`1px solid ${sc.color}`,borderRadius:20,padding:'1px 7px',flexShrink:0,whiteSpace:'nowrap'}}>{sc.label}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:16}}>
              <div style={{fontWeight:800,fontSize:13,marginBottom:12,color:C.ink}}>Próximos eventos — {CAL_MONTHS[month]}</div>
              {upcoming.length === 0 ? (
                <div style={{fontSize:12,color:C.mid,textAlign:'center',padding:'24px 0',lineHeight:1.6}}>
                  Sin eventos este mes.<br/>
                  <span style={{fontSize:11}}>Hacé clic en un día para agregar.</span>
                </div>
              ) : upcoming.map(e => {
                const d = new Date(e.date + 'T12:00:00');
                return (
                  <div key={e.id} style={{display:'flex',gap:10,alignItems:'flex-start',padding:'8px 0',borderBottom:`1px solid ${C.border}`}}
                    onClick={()=>{setSelected(d.getDate());resetForm();}}>
                    <div style={{width:38,textAlign:'center',flexShrink:0,cursor:'pointer'}}>
                      <div style={{fontSize:20,fontWeight:900,color:CAL_TYPES[e.type]?.color||C.ink,lineHeight:1}}>{String(d.getDate()).padStart(2,'0')}</div>
                      <div style={{fontSize:9,color:C.mid,textTransform:'uppercase',letterSpacing:.3}}>{CAL_MONTHS[d.getMonth()].substring(0,3)}</div>
                    </div>
                    <div style={{flex:1,minWidth:0,cursor:'pointer'}}>
                      <div style={{fontSize:12,fontWeight:600,color:C.ink,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{CAL_TYPES[e.type]?.icon} {e.title}</div>
                      <div style={{display:'flex',gap:4,marginTop:2,alignItems:'center'}}>
                        <span style={{fontSize:10,color:CAL_CROWD[e.expected_crowd]?.color,fontWeight:700}}>{CAL_CROWD[e.expected_crowd]?.dot} {CAL_CROWD[e.expected_crowd]?.label}</span>
                        {e.is_global && <span style={{fontSize:9,color:'#8E8E93',background:'var(--bg-subtle)',padding:'1px 5px',borderRadius:3,fontWeight:700}}>Global</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Modal nueva/editar reserva (reusa el modal de ReservasPage) */}
      {resModal && (
        <ReservaFormModal
          reserva={resModal.id ? resModal : null}
          defaultDate={selDate}
          tables={tables||[]}
          onClose={()=>setResModal(null)}
          onSaved={()=>{setResModal(null);loadEvents();}}
        />
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════
   AGENDA — módulo unificado (Calendario + Reservas)
══════════════════════════════════════════════ */
function AgendaPage({tables, initialView='calendario', restaurant, onRefresh}) {
  const [view,setView] = useState(initialView);
  const TABS = [['pendientes','Pendientes'],['calendario','Calendario'],['lista','Lista']];
  return (
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18,gap:12,flexWrap:'wrap'}}>
        <h1 style={{fontSize:22,fontWeight:800,color:C.ink,margin:0}}>Agenda</h1>
        <div style={{display:'inline-flex',background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:2}}>
          {TABS.map(([v,l])=>(
            <button key={v} onClick={()=>setView(v)}
              style={{padding:'6px 16px',fontSize:13,fontWeight:700,border:'none',borderRadius:6,cursor:'pointer',
                background:view===v?C.ink:'transparent',color:view===v?C.sidebar:C.mid}}>{l}</button>
          ))}
        </div>
      </div>
      {view==='calendario'
        ? <CalendarioPage tables={tables} embedded/>
        : view==='pendientes'
          ? <ReservasPage tables={tables} embedded mode='cola' restaurant={restaurant} onRefresh={onRefresh}/>
          : <ReservasPage tables={tables} embedded restaurant={restaurant} onRefresh={onRefresh}/>}
    </div>
  );
}

/* ══════════════════════════════════════════════
   ROOT APP
══════════════════════════════════════════════ */
/* ═══════════════════════════════════════════
   PAGE: MI CUENTA (perfil real + dueño/encargado del local)
═══════════════════════════════════════════ */
// Campo etiqueta+control. Definido a nivel de módulo (identidad estable) para no
// remontar los <input> en cada render (perderían el foco al tipear).
function AcctField({label, children}) {
  return (
    <div style={{marginBottom:14}}>
      <label style={{display:'block',fontSize:11,color:C.mid,fontWeight:700,marginBottom:5,textTransform:'uppercase',letterSpacing:.4}}>{label}</label>
      {children}
    </div>
  );
}
// Cambio voluntario de contraseña: verifica la actual re-autenticando y recién
// ahí cambia con updateUser (el enlace por correo / primer ingreso van por otro
// flujo, sin clave previa).
function AdminChangePasswordModal({ email, onClose }) {
  const [cur,setCur] = useState('');
  const [n1,setN1]   = useState('');
  const [n2,setN2]   = useState('');
  const [busy,setBusy] = useState(false);
  const [err,setErr]   = useState('');
  const cap = useTurnstile(true);   // CAPTCHA para re-autenticar (signInWithPassword)
  const iStyle = {width:'100%',padding:'9px 12px',fontSize:13.5,borderRadius:8,border:`1px solid ${C.border}`,background:C.surface,color:C.ink,outline:'none',boxSizing:'border-box'};
  const lStyle = {display:'block',fontSize:11,color:C.mid,fontWeight:700,marginBottom:5,textTransform:'uppercase',letterSpacing:.4};
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
      toast('Contraseña actualizada');
      onClose();
    } catch(e) { setErr('Error: ' + (e.message || 'intentá de nuevo')); }
    setBusy(false);
  };
  return (
    <Modal title="Cambiar contraseña" onClose={onClose} width={400}>
      {err && <div style={{background:C.red+'22',color:C.red,border:`1px solid ${C.red}55`,borderRadius:8,padding:'9px 12px',fontSize:12.5,marginBottom:14}}>{err}</div>}
      <div style={{marginBottom:14}}><label style={lStyle}>Contraseña actual</label><input type="password" value={cur} onChange={e=>setCur(e.target.value)} autoFocus autoComplete="current-password" style={iStyle}/></div>
      <div style={{marginBottom:14}}><label style={lStyle}>Nueva contraseña</label><input type="password" value={n1} onChange={e=>setN1(e.target.value)} autoComplete="new-password" style={iStyle}/><div style={{fontSize:11,color:C.dim,marginTop:4}}>Mínimo 8 caracteres.</div></div>
      <div style={{marginBottom:14}}><label style={lStyle}>Repetir nueva contraseña</label><input type="password" value={n2} onChange={e=>setN2(e.target.value)} autoComplete="new-password" style={iStyle}/></div>
      <div ref={cap.ref} style={{marginBottom:18,minHeight:65}}></div>
      <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn onClick={submit} disabled={busy}>{busy?'Guardando…':'Cambiar contraseña'}</Btn>
      </div>
    </Modal>
  );
}

function MiCuentaPage({ restaurant, onRefresh, embedded }) {
  const prof = window._userProfile || {};
  const canEditLocal = ['admin','owner','superadmin'].includes(MY_ROLE);
  const restHasCol = c => restaurant && Object.prototype.hasOwnProperty.call(restaurant, c);

  const [email,setEmail] = useState('');
  const [name,setName]   = useState(prof.display_name || prof.username || '');
  const [phone,setPhone] = useState('');
  const [savingProfile,setSavingProfile] = useState(false);
  const [pwModal,setPwModal] = useState(false);

  // Dueño / encargado del local (desde el row de restaurants)
  const [loc,setLoc] = useState({owner_name:'',owner_email:'',owner_phone:'',owner_document:'',manager_name:'',manager_phone:''});
  const [savingLoc,setSavingLoc] = useState(false);

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

  // Sembramos `loc` UNA vez por restaurante (por id). loadAll(true) del poll/realtime
  // recrea el objeto restaurant en cada refresco (nueva referencia) → sin este guard,
  // el efecto se re-dispara y pisa las ediciones en curso de dueño/encargado.
  const seededRestId = useRef(null);
  useEffect(()=>{
    if (!restaurant) return;
    if (seededRestId.current === restaurant.id) return;
    seededRestId.current = restaurant.id;
    setLoc({
      owner_name:restaurant.owner_name||'', owner_email:restaurant.owner_email||'', owner_phone:restaurant.owner_phone||'',
      owner_document:restaurant.owner_document||'', manager_name:restaurant.manager_name||'', manager_phone:restaurant.manager_phone||''
    });
  },[restaurant]);

  const iStyle = {width:'100%',padding:'9px 12px',fontSize:13.5,borderRadius:8,border:`1px solid ${C.border}`,background:C.surface,color:C.ink,outline:'none',boxSizing:'border-box'};
  const iDisabled = {...iStyle, opacity:.6, cursor:'not-allowed'};
  const lStyle = {display:'block',fontSize:11,color:C.mid,fontWeight:700,marginBottom:5,textTransform:'uppercase',letterSpacing:.4};
  const cardStyle = {background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:'18px 20px',marginBottom:16};
  const sf = k => e => setLoc(s=>({...s,[k]:e.target.value}));

  const saveProfile = async () => {
    if (!name.trim()) { toast('El nombre no puede quedar vacío', false); return; }
    if (!db) return;
    setSavingProfile(true);
    try {
      const { error } = await db.rpc('update_my_profile',{ p_display_name:name.trim(), p_phone:phone.trim() });
      if (error) throw error;
      try { window._userProfile = {...prof, display_name:name.trim()}; } catch(_){}
      try { localStorage.setItem('mythos_display_name', name.trim()); } catch(_){}
      toast('Perfil actualizado');
    } catch(e) {
      const m = e.message || '';
      toast(/update_my_profile|schema cache|does not exist|function/i.test(m) ? 'Falta aplicar la migración 145 para editar el perfil' : ('Error: '+m), false);
    }
    setSavingProfile(false);
  };

  const saveLoc = async () => {
    if (!db || !RID) return;
    if (!canEditLocal) { toast('Solo el administrador del local puede editar estos datos', false); return; }
    // Guard anti-borrado: si el row del restaurante aún no cargó (fallo transitorio),
    // `loc` está en blanco → NO guardar (borraría owner_name/email/phone existentes).
    if (!restaurant) { toast('Los datos del local aún se están cargando, probá de nuevo', false); return; }
    setSavingLoc(true);
    try {
      const patch = { owner_name:loc.owner_name.trim()||null, owner_email:loc.owner_email.trim()||null, owner_phone:loc.owner_phone.trim()||null };
      if (restHasCol('owner_document')) patch.owner_document = loc.owner_document.trim()||null;
      if (restHasCol('manager_name'))   patch.manager_name   = loc.manager_name.trim()||null;
      if (restHasCol('manager_phone'))  patch.manager_phone  = loc.manager_phone.trim()||null;
      const { data, error } = await db.from('restaurants').update(patch).eq('id',RID).select('id');
      if (error) throw error;
      if (!data || data.length===0) { toast('No se pudo guardar — verificá tus permisos (RLS)', false); setSavingLoc(false); return; }
      toast('Datos del local actualizados');
      if (onRefresh) onRefresh(true);
    } catch(e) { toast('Error: ' + (e.message || 'no se pudo guardar'), false); }
    setSavingLoc(false);
  };

  return (
    <div className={embedded?'':'page'} style={{maxWidth:720}}>
      {!embedded && <h1 style={{fontSize:20,fontWeight:800,marginBottom:18}}>Mi cuenta</h1>}

      {/* Perfil personal */}
      <div style={cardStyle}>
        <div style={{fontSize:14,fontWeight:700,marginBottom:14}}>Mi perfil</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 16px'}}>
          <AcctField label="Nombre"><input value={name} onChange={e=>setName(e.target.value)} placeholder="Tu nombre" style={iStyle}/></AcctField>
          <AcctField label="Teléfono"><input value={phone} onChange={e=>setPhone(e.target.value)} placeholder="+595 9xx xxx xxx" style={iStyle}/></AcctField>
          <AcctField label="Email"><input value={email} disabled style={iDisabled}/></AcctField>
          <AcctField label="Rol"><input value={roleLabel(prof.role)} disabled style={iDisabled}/></AcctField>
          <AcctField label="Restaurante"><input value={restaurant?.name||'—'} disabled style={iDisabled}/></AcctField>
        </div>
        <div style={{display:'flex',justifyContent:'flex-end'}}>
          <Btn onClick={saveProfile} disabled={savingProfile}>{savingProfile?'Guardando…':'Guardar cambios'}</Btn>
        </div>
      </div>

      {/* Seguridad */}
      <div style={cardStyle}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:14,flexWrap:'wrap'}}>
          <div>
            <div style={{fontSize:14,fontWeight:700,marginBottom:3}}>Seguridad</div>
            <div style={{fontSize:12.5,color:C.mid}}>Cambiá tu contraseña. Te vamos a pedir la actual por seguridad.</div>
          </div>
          <Btn variant="ghost" onClick={()=>setPwModal(true)}>Cambiar contraseña</Btn>
        </div>
      </div>

      {/* Dueño y encargado del local */}
      <div style={cardStyle}>
        <div style={{fontSize:14,fontWeight:700,marginBottom:3}}>Dueño y encargado del local</div>
        <div style={{fontSize:12.5,color:C.mid,marginBottom:14}}>{canEditLocal ? 'Datos de contacto del dueño y (si difiere) del encargado del local.' : 'Solo el administrador del local puede editar estos datos.'}</div>
        <div style={{fontSize:10,color:C.mid,fontWeight:700,textTransform:'uppercase',letterSpacing:.5,marginBottom:8}}>Dueño</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 16px'}}>
          <AcctField label="Nombre"><input value={loc.owner_name} onChange={sf('owner_name')} disabled={!canEditLocal} placeholder="Nombre del dueño" style={canEditLocal?iStyle:iDisabled}/></AcctField>
          <AcctField label="Teléfono"><input value={loc.owner_phone} onChange={sf('owner_phone')} disabled={!canEditLocal} placeholder="+595 9xx xxx xxx" style={canEditLocal?iStyle:iDisabled}/></AcctField>
          <AcctField label="Email"><input value={loc.owner_email} onChange={sf('owner_email')} disabled={!canEditLocal} placeholder="dueno@correo.com" style={canEditLocal?iStyle:iDisabled}/></AcctField>
          <AcctField label="Documento / RUC"><input value={loc.owner_document} onChange={sf('owner_document')} disabled={!canEditLocal} placeholder="C.I. o RUC" style={canEditLocal?iStyle:iDisabled}/></AcctField>
        </div>
        <div style={{fontSize:10,color:C.mid,fontWeight:700,textTransform:'uppercase',letterSpacing:.5,margin:'6px 0 8px'}}>Encargado <span style={{textTransform:'none',fontWeight:500,color:C.dim}}>(si difiere del dueño)</span></div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 16px'}}>
          <AcctField label="Nombre"><input value={loc.manager_name} onChange={sf('manager_name')} disabled={!canEditLocal} placeholder="Nombre del encargado" style={canEditLocal?iStyle:iDisabled}/></AcctField>
          <AcctField label="Teléfono"><input value={loc.manager_phone} onChange={sf('manager_phone')} disabled={!canEditLocal} placeholder="+595 9xx xxx xxx" style={canEditLocal?iStyle:iDisabled}/></AcctField>
        </div>
        {canEditLocal && <div style={{display:'flex',justifyContent:'flex-end'}}>
          <Btn onClick={saveLoc} disabled={savingLoc}>{savingLoc?'Guardando…':'Guardar datos del local'}</Btn>
        </div>}
      </div>

      {pwModal && <AdminChangePasswordModal email={email} onClose={()=>setPwModal(false)}/>}
    </div>
  );
}

// ── Aceptación de términos (mig 149) ──────────────────────────────
// Versión vigente de los T&C / Privacidad. Bumpeá esta constante cuando cambien
// materialmente los términos → obliga a re-aceptar en el próximo ingreso.
const TERMS_VERSION = '2026-07-05';

// Gate de una sola vez: si el dueño (rol admin) todavía no aceptó los términos,
// se muestra ANTES del panel. Registra la aceptación con timestamp server-side.
// Fail-open: si falta la migración 149 (RPC/tabla ausente) NO bloquea el acceso.
function TermsGateModal({ onAccept }) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    if (!checked || busy) return;
    setBusy(true);
    try {
      const { error } = await db.rpc('record_terms_acceptance', { p_version: TERMS_VERSION, p_source: 'first_login' });
      if (error) throw error;
    } catch (e) {
      // Falta mig 149 / error transitorio → no atrapamos al usuario (fail-open).
      try { console.warn('[terms] no se pudo registrar la aceptación:', e && e.message ? e.message : e); } catch (_) {}
    } finally {
      setBusy(false);
      onAccept();
    }
  };
  return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',padding:24,background:C.bg}}>
      <div style={{maxWidth:480,width:'100%',border:`1px solid ${C.border}`,borderRadius:16,padding:'32px 28px',background:C.card,boxSizing:'border-box'}}>
        <div style={{fontSize:19,fontWeight:800,color:C.ink,marginBottom:10}}>Antes de empezar</div>
        <div style={{fontSize:13.5,color:C.mid,lineHeight:1.6,marginBottom:20}}>
          Para usar Mythos necesitamos que aceptes nuestros Términos y la Política de Privacidad. Es una sola vez.
        </div>
        <label style={{display:'flex',alignItems:'flex-start',gap:10,cursor:'pointer',fontSize:13.5,color:C.ink,lineHeight:1.55,marginBottom:22}}>
          <input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)} style={{marginTop:3,width:17,height:17,flexShrink:0,cursor:'pointer'}}/>
          <span>Acepto los <a href="/terminos" target="_blank" rel="noopener noreferrer" style={{color:C.ink,fontWeight:700}}>Términos y Condiciones</a> y la <a href="/privacidad" target="_blank" rel="noopener noreferrer" style={{color:C.ink,fontWeight:700}}>Política de Privacidad</a>.</span>
        </label>
        <button onClick={accept} disabled={!checked||busy}
          style={{width:'100%',background:checked?C.ink:C.border,color:checked?C.bg:C.mid,border:'none',borderRadius:10,padding:'13px',fontSize:14,fontWeight:700,cursor:checked&&!busy?'pointer':'default'}}>
          {busy?'Guardando…':'Aceptar y continuar'}
        </button>
      </div>
    </div>
  );
}

function AdminApp() {
  const [page,setPage] = useState('dashboard');
  // Sidebar colapsable (persistente): main a ancho completo al ocultarlo.
  const [navOpen,setNavOpen]=useState(()=>{try{return localStorage.getItem('admin_nav_open')!=='0';}catch{return true;}});
  const toggleNav=()=>setNavOpen(v=>{const n=!v;try{localStorage.setItem('admin_nav_open',n?'1':'0');}catch{} return n;});
  const [loading,setLoading] = useState(true);
  const [unreadSupport,setUnreadSupport] = useState(0);
  const [,forceRender] = useReducer(x=>x+1,0);
  const [themeMode, setThemeMode] = useState(window.MythosTheme ? window.MythosTheme.get() : 'light');
  useEffect(() => {
    const onTheme = e => { setThemeMode(e.detail.mode); forceRender(); };
    document.addEventListener('mythos:themechange', onTheme);
    return () => document.removeEventListener('mythos:themechange', onTheme);
  }, []);
  function toggleTheme(){ if (window.MythosTheme) window.MythosTheme.toggle(); }
  const [orders,setOrders] = useState([]);
  const tablesRef   = useRef([]);    // espejo de `tables` para el mapeo liviano sin closures viejos
  const ordersTimer = useRef(null);  // debounce del refresco liviano de pedidos
  const [categories,setCategories] = useState([]);
  const [menuItems,setMenuItems] = useState([]);
  const [tables,setTables] = useState([]);
  const [coupons,setCoupons] = useState([]);
  const [ratings,setRatings] = useState([]);
  const [restaurant,setRestaurant] = useState(null);
  // Capacidades del plan (Omni-Gating por feature) — re-renderiza al resolver
  const caps = window.MythosGating ? window.MythosGating.useCapabilities(db, RID) : {hasFeature:()=>true, hasPanel:()=>true};

  // ── Guard de tenant ──────────────────────────────────────────────
  // Si el restaurante activo (RID en localStorage) NO pertenece a la sesión,
  // get_restaurant_capabilities (mig 108) devuelve NULL SIN error → el panel
  // está apuntando a un restaurante que el usuario no puede leer/escribir
  // (sale todo vacío y la RLS rechaza los INSERT). Bloqueamos SOLO ante esa
  // señal definitiva; ante un error transitorio de red NO bloqueamos (no
  // dejamos afuera a un admin legítimo). El superadmin nunca cae acá: la
  // mig 108 le devuelve datos para cualquier restaurante.
  const [tenantDenied,setTenantDenied] = useState(false);
  useEffect(()=>{
    if(!db || !RID) return;
    let alive = true;
    db.rpc('get_restaurant_capabilities',{p_restaurant_id:RID})
      .then(({data,error})=>{ if(alive && !error && data === null) setTenantDenied(true); })
      .catch(()=>{});   // error transitorio → no bloquear
    return ()=>{ alive=false; };
  },[]);

  // ── Gate de aceptación de términos (mig 149) ─────────────────────
  // Solo el dueño (rol admin). Si no hay aceptación registrada para la versión
  // vigente, se muestra el gate antes del panel. Fail-open ante error / migración
  // sin aplicar (la tabla no existe → SELECT falla → no se bloquea).
  const [termsGate,setTermsGate] = useState(false);
  useEffect(()=>{
    if(!db || MY_ROLE !== 'admin') return;
    let alive = true;
    db.from('terms_acceptance').select('id').eq('version',TERMS_VERSION).limit(1)
      .then(({data,error})=>{ if(alive && !error && (!data || data.length===0)) setTermsGate(true); })
      .catch(()=>{});
    return ()=>{ alive=false; };
  },[]);

  useEffect(()=>{ loadAll(); },[]);

  // Polling de tickets sin leer (Soporte)
  useEffect(()=>{
    if(!db) return;
    const tick = async () => {
      if(_shouldPause()) return;
      const { data } = await db.from('support_tickets')
        .select('unread_for_client').eq('restaurant_id',RID).neq('status','cerrado');
      setUnreadSupport((data||[]).reduce((s,t)=>s+(t.unread_for_client||0),0));
    };
    tick();
    const id = setInterval(tick, 20000);
    return () => clearInterval(id);
  },[]);

  // Realtime global + polling 30s
  // Los handlers usan loadAll(true) para no desmontar modales abiertos
  useEffect(()=>{
    if(!db) return;
    const ch = db.channel('admin-global-rt')
      // Pedidos → refresco LIVIANO (solo orders), sin gate: aparecen aun con foco/modal.
      // El recuento de items se recalcula en refreshOrders, así que el INSERT/UPDATE de
      // la orden ya cubre los items asociados (order_items no tiene restaurant_id para filtrar).
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'orders',filter:`restaurant_id=eq.${RID}`},()=>{ refreshOrders(); })
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'orders',filter:`restaurant_id=eq.${RID}`},()=>{ refreshOrders(); })
      // Mesas/menú → recarga completa (afectan otras vistas), gateada por interacción.
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'tables',filter:`restaurant_id=eq.${RID}`},()=>{ if(!_shouldPause()) loadAll(true); })
      .on('postgres_changes',{event:'*',schema:'public',table:'menu_items',filter:`restaurant_id=eq.${RID}`},()=>{ if(!_shouldPause()) loadAll(true); })
      .subscribe();
    const poll = setInterval(()=>{ if(!_shouldPause()) loadAll(true); }, 30000);
    return ()=>{ db.removeChannel(ch); clearInterval(poll); };
  },[]);

  // silent=true → refresca datos sin setLoading(true) (no desmonta modales)
  async function loadAll(silent=false) {
    if(!silent) setLoading(true);
    if(!db){if(!silent) setLoading(false);return;}
    const [rR,tR,oR,cR,iR,cpR,raR] = await Promise.all([
      db.from('restaurants').select('*').eq('id',RID).single(),
      db.from('tables').select('*').eq('restaurant_id',RID).order('number'),
      db.from('orders').select('*').eq('restaurant_id',RID).order('created_at',{ascending:false}).limit(500),
      db.from('menu_categories').select('*').eq('restaurant_id',RID).order('sort_order'),
      db.from('menu_items').select('*').eq('restaurant_id',RID).order('sort_order'),
      db.from('coupons').select('*').eq('restaurant_id',RID).order('created_at',{ascending:false}),
      db.from('ratings').select('*').eq('restaurant_id',RID).order('created_at',{ascending:false}).limit(200),
    ]);
    if(oR.error) console.error('[admin] orders error | code:',oR.error.code,'| message:',oR.error.message,'| details:',oR.error.details);
    if(tR.error) console.error('[admin] tables error | code:',tR.error.code,'| message:',tR.error.message);
    if(rR.error) console.error('[admin] restaurants error | code:',rR.error.code,'| message:',rR.error.message);
    const tbls=tR.data||[];
    const tableMap={};tbls.forEach(t=>{tableMap[t.id]=t.number;});
    const rawOrds=oR.data||[];
    const orderIds=rawOrds.slice(0,150).map(o=>o.id);
    let countsMap={};
    if(orderIds.length){
      const{data:cd}=await db.from('order_items').select('order_id').in('order_id',orderIds);
      (cd||[]).forEach(it=>{countsMap[it.order_id]=(countsMap[it.order_id]||0)+1;});
    }
    if(rR.data?.name) document.title=`Admin — ${rR.data.name}`;
    setRestaurant(rR.data);
    setTables(tbls); tablesRef.current=tbls;
    setOrders(rawOrds.map(o=>({...o,table_number:o.table_id?tableMap[o.table_id]:null,items_count:countsMap[o.id]||0})));
    setCategories(cR.data||[]);
    setMenuItems(iR.data||[]);
    setCoupons(cpR.data||[]);
    setRatings(raR.data||[]);
    if(!silent) setLoading(false);
  }

  // Refresco LIVIANO de la lista de pedidos: recarga SOLO orders (+conteo de items),
  // nunca el bootstrap completo (menú/mesas/ratings/cupones/restaurante quedan intactos).
  // Coalescido ~400ms: el INSERT + los UPDATEs + los eventos de items de un mismo
  // pedido se funden en UNA sola recarga. SIN gate de _shouldPause: la lista de
  // monitoreo debe actualizarse aunque haya un input con foco o un modal abierto.
  function refreshOrders() {
    clearTimeout(ordersTimer.current);
    ordersTimer.current = setTimeout(async () => {
      if(!db) return;
      const oR = await db.from('orders').select('*').eq('restaurant_id',RID).order('created_at',{ascending:false}).limit(500);
      if(oR.error){ console.error('[admin] refreshOrders error | code:',oR.error.code,'| message:',oR.error.message); return; }
      const rawOrds = oR.data||[];
      const orderIds = rawOrds.slice(0,150).map(o=>o.id);
      let countsMap={};
      if(orderIds.length){
        const{data:cd}=await db.from('order_items').select('order_id').in('order_id',orderIds);
        (cd||[]).forEach(it=>{countsMap[it.order_id]=(countsMap[it.order_id]||0)+1;});
      }
      const tableMap={}; (tablesRef.current||[]).forEach(t=>{tableMap[t.id]=t.number;});
      setOrders(rawOrds.map(o=>({...o,table_number:o.table_id?tableMap[o.table_id]:null,items_count:countsMap[o.id]||0})));
    }, 400);
  }

  function renderPage() {
    if(loading) return <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:400,flexDirection:'column',gap:14}}><span className="spin"/><div style={{fontSize:12,color:C.dim}}>Cargando datos…</div></div>;
    if(!db) return (
      <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:400,flexDirection:'column',gap:12}}>
        <div style={{color:C.dim,display:'flex'}}><Icon name="alert" size={32}/></div>
        <div style={{fontSize:15,fontWeight:700}}>Sin conexión a la base de datos</div>
        <div style={{fontSize:13,color:C.mid,maxWidth:340,textAlign:'center'}}>Configurá las credenciales en <code style={{fontFamily:"'SF Mono',ui-monospace,monospace",color:C.mid}}>config.js</code> o en variables de entorno de Vercel.</div>
        <a href="diag.html" style={{fontSize:13,color:C.mid,marginTop:8}}>→ Ver diagnóstico</a>
      </div>
    );
    switch(page){
      case 'dashboard': return <DashboardPage orders={orders} ratings={ratings} setPage={setPage}/>;
      case 'paneles':   return <PanelesPage caps={caps}/>;
      case 'pedidos':   return <PedidosPage orders={orders} tables={tables} onRefresh={loadAll} onRefreshOrders={refreshOrders}/>;
      case 'menu':      return <MenuPage categories={categories} menuItems={menuItems} onRefresh={loadAll}/>;
      case 'mesas':     return restaurant?.service_mode==='delivery'
        ? <div className="page"><div style={{maxWidth:460,margin:'60px auto',textAlign:'center',border:`1px solid ${C.border}`,borderRadius:16,padding:'34px 28px',background:C.card}}>
            <div style={{display:'flex',justifyContent:'center',color:C.mid,marginBottom:14}}><Icon name="bike" size={34}/></div>
            <div style={{fontSize:18,fontWeight:800,color:C.ink,marginBottom:10}}>Mesas desactivadas</div>
            <div style={{fontSize:13,color:C.mid,lineHeight:1.6}}>Este local opera en modo <b>Delivery a domicilio</b>, así que no gestiona mesas ni Menú QR. Para reactivar el salón, cambiá el modo de operación desde el Superadmin.</div>
          </div></div>
        : <MesasPage tables={tables} orders={orders} restaurant={restaurant} onRefresh={loadAll}/>;
      case 'agenda':
      case 'reservas':
      case 'calendario':return <AgendaPage tables={tables} initialView={page==='reservas'?'pendientes':(page==='agenda'?'pendientes':'calendario')} restaurant={restaurant} onRefresh={loadAll}/>;
      case 'estaciones':return caps.hasPanel('cocina') ? <EstacionesPage categories={categories} tables={tables}/> : <window.MythosGating.PanelLock panelKey="cocina" variant="inline"/>;
      case 'personal':  return <PersonalPage/>;
      case 'clientes':  return caps.hasFeature('admin:crm') ? <ClientesPage orders={orders}/> : <window.MythosGating.FeatureLock featureKey="admin:crm" variant="inline"/>;
      case 'caja':      return caps.hasPanel('caja') ? <CajaAdminPage/> : <window.MythosGating.PanelLock panelKey="caja" variant="inline"/>;
      case 'reportes':  return <ReportesPage orders={orders}/>;
      case 'finanzas':  return <FinanzasPage orders={orders} restaurant={restaurant} showDelivery={caps.hasFeature('admin:delivery_zones')} onRefresh={loadAll}/>;
      case 'marketing': return <MarketingPage coupons={coupons} orders={orders} restaurant={restaurant} onRefresh={loadAll}/>;
      case 'ratings':   return <RatingsPage ratings={ratings}/>;
      case 'stock':     return caps.hasFeature('admin:inventory') ? <StockPage/> : <window.MythosGating.FeatureLock featureKey="admin:inventory" variant="inline"/>;
      case 'proveedores': return <ProveedoresPage/>;
      case 'marketplace': return <MarketplacePage/>;
      case 'delivery':  return caps.hasFeature('admin:delivery_zones') ? <DeliveryModule/> : <window.MythosGating.FeatureLock featureKey="admin:delivery_zones" variant="inline"/>;
      case 'avisos':    return <AvisosAdmin restaurant={restaurant}/>;
      case 'soporte':   return <SoportePage restaurant={restaurant}/>;
      case 'config':    return <ConfigPage restaurant={restaurant} onRefresh={loadAll}/>;
      default: return null;
    }
  }

  if (termsGate) return <TermsGateModal onAccept={()=>setTermsGate(false)}/>;

  if (tenantDenied) {
    return (
      <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',padding:24,background:C.bg}}>
        <div style={{maxWidth:460,width:'100%',textAlign:'center',border:`1px solid ${C.border}`,borderRadius:16,padding:'34px 28px',background:C.card,boxSizing:'border-box'}}>
          <div style={{display:'flex',justifyContent:'center',color:C.dim,marginBottom:14}}><Icon name="alert" size={34}/></div>
          <div style={{fontSize:18,fontWeight:800,color:C.ink,marginBottom:10}}>Sesión sin acceso a este restaurante</div>
          <div style={{fontSize:13,color:C.mid,lineHeight:1.6,marginBottom:22}}>
            El panel está apuntando a un restaurante (<code style={{fontFamily:"'SF Mono',monospace"}}>{(RID||'').slice(0,8)}…</code>) que tu usuario actual no tiene autorizado.
            Por eso las listas salen vacías y al crear datos la base los rechaza. Volvé a iniciar sesión con la cuenta del restaurante correcto.
          </div>
          <button onClick={()=>{
            try{ Object.keys(localStorage).filter(k=>k.startsWith('mythos_')||k.startsWith('sb-')||k.toLowerCase().includes('supabase')).forEach(k=>localStorage.removeItem(k)); }catch(e){}
            window.location.href='login.html';
          }} style={{background:C.ink,color:C.bg,border:'none',borderRadius:10,padding:'12px 22px',fontSize:13.5,fontWeight:700,cursor:'pointer'}}>
            Volver a iniciar sesión
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{display:'flex',minHeight:'100vh'}}>
      {navOpen && <Sidebar page={page} setPage={setPage} restaurant={restaurant} onToggleTheme={toggleTheme} badges={{soporte:unreadSupport}} themeMode={themeMode}/>}
      <main style={{flex:1,padding:26,overflowY:'auto',minWidth:0}}>
        <button onClick={toggleNav} title={navOpen?'Ocultar menú':'Mostrar menú'}
          style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:6,padding:'7px 9px',cursor:'pointer',display:'flex',flexDirection:'column',justifyContent:'center',gap:3,marginBottom:16}}>
          <span style={{width:15,height:2,background:C.mid,display:'block',borderRadius:2}}/>
          <span style={{width:15,height:2,background:C.mid,display:'block',borderRadius:2}}/>
          <span style={{width:15,height:2,background:C.mid,display:'block',borderRadius:2}}/>
        </button>
        <SucursalSwitcher caps={caps.caps}/>
        {renderPage()}
      </main>
      <ToastContainer/>
    </div>
  );
}

/* ═══════════════════════════════════════════
   PAGE: FACTURAS
═══════════════════════════════════════════ */
function FacturasAdminPage(){
  const [cobros,setCobros]=useState([]);
  const [loading,setLoading]=useState(true);
  const [rango,setRango]=useState('hoy');
  const [metodoFlt,setMetodoFlt]=useState('todos');
  const [searchQ,setSearchQ]=useState('');

  useEffect(()=>{load();},[rango]);

  async function load(){
    setLoading(true);
    const now=new Date();
    let desde=null;
    if(rango==='hoy'){desde=new Date(now.getFullYear(),now.getMonth(),now.getDate()).toISOString();}
    else if(rango==='7d'){desde=new Date(Date.now()-7*86400000).toISOString();}
    else if(rango==='30d'){desde=new Date(Date.now()-30*86400000).toISOString();}

    let q=db.from('movimientos_caja')
      .select('id,created_at,monto,metodo_pago,descripcion,pedido_id,metadata,turnos_caja(cajero_id,fecha_apertura)')
      .eq('restaurant_id',RID).eq('tipo','cobro')
      .order('created_at',{ascending:false}).limit(300);
    if(desde)q=q.gte('created_at',desde);
    const{data}=await q;
    setCobros(data||[]);
    setLoading(false);
  }

  const MET={efectivo:'Efectivo',tarjeta_credito:'T.Crédito',tarjeta_debito:'T.Débito',qr:'QR',mixto:'Mixto'};

  const display=cobros.filter(c=>{
    if(metodoFlt!=='todos'&&c.metodo_pago!==metodoFlt)return false;
    if(searchQ){
      const q=searchQ.toLowerCase();
      const meta=c.metadata||{};
      if(!String(meta.orden_numero||'').includes(q)&&!(meta.mesa||'').toLowerCase().includes(q))return false;
    }
    return true;
  });

  const totalDisplay=display.reduce((s,c)=>s+Number(c.monto||0),0);
  const byMetodo={};
  display.forEach(c=>{byMetodo[c.metodo_pago]=(byMetodo[c.metodo_pago]||0)+Number(c.monto||0);});

  return(
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16,gap:10,flexWrap:'wrap'}}>
        <h1 style={{fontSize:20,fontWeight:800}}>Facturas</h1>
        <div style={{fontFamily:"'SF Mono',monospace",fontSize:18,fontWeight:800,color:C.green}}>{fmt(totalDisplay)}</div>
      </div>

      {/* Placeholder facturación electrónica */}
      <div style={{background:'rgba(0,122,255,0.06)',border:'1px solid rgba(0,122,255,0.2)',borderRadius:10,padding:'14px 18px',marginBottom:20,display:'flex',alignItems:'center',gap:14}}>
        <span style={{display:'flex',color:'#007AFF'}}><Icon name="fileText" size={24}/></span>
        <div style={{flex:1}}>
          <div style={{fontSize:14,fontWeight:700,color:'#007AFF'}}>Facturación electrónica SET (SIFEN)</div>
          <div style={{fontSize:12,color:C.mid,marginTop:3}}>Próximamente — integración con la SET de Paraguay para emisión de e-Kuatia. Las facturas listadas aquí son comprobantes internos del sistema.</div>
        </div>
        <span style={{fontSize:11,fontWeight:700,color:'#007AFF',background:'rgba(0,122,255,0.1)',padding:'4px 10px',borderRadius:10,whiteSpace:'nowrap',flexShrink:0}}>PRÓXIMAMENTE</span>
      </div>

      {/* KPIs por método */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(140px,1fr))',gap:10,marginBottom:20}}>
        {Object.entries(byMetodo).map(([m,tot])=>(
          <div key={m} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'12px 14px'}}>
            <div style={{fontSize:10,color:C.mid,fontWeight:700,marginBottom:4,textTransform:'uppercase'}}>{MET[m]||m}</div>
            <div style={{fontFamily:"'SF Mono',monospace",fontSize:16,fontWeight:800,color:C.ink}}>{fmt(tot)}</div>
          </div>
        ))}
      </div>

      {/* Filtros */}
      <div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap',alignItems:'center'}}>
        <div style={{display:'flex',gap:0,background:C.card,borderRadius:8,padding:3}}>
          {[['hoy','Hoy'],['7d','7 días'],['30d','30 días'],['todo','Todo']].map(([id,lbl])=>(
            <button key={id} onClick={()=>setRango(id)} style={{
              padding:'5px 12px',borderRadius:6,border:'none',fontSize:12,fontWeight:rango===id?700:500,
              background:rango===id?C.white:'transparent',color:rango===id?C.ink:C.mid,
              cursor:'pointer',boxShadow:rango===id?'0 1px 4px rgba(0,0,0,0.15)':'none',
            }}>{lbl}</button>
          ))}
        </div>
        <select value={metodoFlt} onChange={e=>setMetodoFlt(e.target.value)} style={{padding:'6px 10px',fontSize:12,borderRadius:6,border:`1px solid ${C.border}`,background:C.surface,color:C.ink}}>
          <option value="todos">Todos los métodos</option>
          {Object.entries(MET).map(([id,lbl])=><option key={id} value={id}>{lbl}</option>)}
        </select>
        <input value={searchQ} onChange={e=>setSearchQ(e.target.value)} placeholder="Buscar #pedido o mesa…"
          style={{padding:'6px 11px',fontSize:12,borderRadius:6,border:`1px solid ${C.border}`,width:200,color:C.ink}}/>
      </div>

      {loading&&<div style={{textAlign:'center',padding:40}}><span className="spin"/></div>}

      {!loading&&display.length===0&&(
        <div style={{textAlign:'center',padding:'60px 0',color:C.mid}}>
          <div style={{marginBottom:12,display:'flex',justifyContent:'center'}}><Icon name="receipt" size={34}/></div>
          <div style={{fontSize:14,fontWeight:700}}>Sin facturas en el período</div>
        </div>
      )}

      {!loading&&display.length>0&&(
        <div style={{border:`1px solid ${C.border}`,borderRadius:10,overflow:'hidden'}}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 120px 1fr 110px',padding:'8px 14px',background:C.bg,fontSize:10,fontWeight:700,color:C.mid,textTransform:'uppercase',gap:8}}>
            <span>Pedido</span><span>Mesa / Cliente</span><span>Método</span><span>Fecha / hora</span><span style={{textAlign:'right'}}>Total</span>
          </div>
          {display.map((c,i)=>{
            const meta=c.metadata||{};
            const dt=new Date(c.created_at);
            const fecha=dt.toLocaleDateString('es-PY',{day:'2-digit',month:'2-digit'});
            const hora=dt.toLocaleTimeString('es-PY',{hour:'2-digit',minute:'2-digit'});
            return(
              <div key={c.id} style={{display:'grid',gridTemplateColumns:'1fr 1fr 120px 1fr 110px',padding:'10px 14px',borderTop:i===0?'none':`1px solid ${C.border}`,alignItems:'center',gap:8,fontSize:13}}>
                <span style={{fontWeight:700,fontFamily:"'SF Mono',monospace"}}>#{meta.orden_numero||'—'}</span>
                <span style={{color:C.mid}}>{meta.mesa||'—'}</span>
                <span style={{fontSize:11,background:C.card,borderRadius:6,padding:'2px 7px',color:C.mid,fontWeight:600,width:'fit-content'}}>{MET[c.metodo_pago]||c.metodo_pago}</span>
                <span style={{fontSize:11,color:C.dim}}>{fecha} {hora}</span>
                <span style={{textAlign:'right',fontFamily:"'SF Mono',monospace",fontWeight:800,color:C.green}}>{fmt(c.monto)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── AUTH GUARD ── */
async function bootstrap() {
  if(!db){window.location.replace('login.html?next=admin.html');return;}
  const{data:{session}}=await db.auth.getSession();
  if(!session){window.location.replace('login.html?next=admin.html');return;}
  const{data:profile}=await db.rpc('get_my_profile');
  if(!profile||!['admin','gerente','supervisor_local','superadmin'].includes(profile.role)){await db.auth.signOut();window.location.replace('login.html');return;}
  window._userProfile=profile;
  createRoot(document.getElementById('root')).render(<AdminApp/>);
}
bootstrap();
