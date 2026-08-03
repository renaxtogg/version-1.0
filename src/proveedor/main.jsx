// ════════════════════════════════════════════════════════════════════
// PR-MKT-1 — Panel Proveedor (marketplace B2B "Proveedores", FASE 1).
// Panel nuevo precompilado con Vite (patrón PR-5/gerente): React de npm,
// el resto de globales del shell en window.* (config.js, supabase UMD,
// MythosTheme/Icons/Session/AuthGuard). Requiere la migración 142
// (tablas marketplace_*, rol 'supplier', RPCs y buckets).
// Secciones: Inicio (métricas) · Mi Tienda (perfil+contacto+pausa) ·
// Catálogo (productos CRUD + archivos) · Solicitudes (leads) ·
// Mensajes (chat real desde PR-MKT-2: módulo compartido + migs 143).
// ════════════════════════════════════════════════════════════════════
import React from "react";
import { createRoot } from "react-dom/client";
import { formatGs, parseGs, GsInput } from "../shared/gs.jsx";
// PR-MKT-2: chat del marketplace (módulo compartido con admin/gerente)
import { createMarketplaceChat } from "../marketplace/chat.jsx";

const { useState, useEffect, useRef, useMemo, useCallback } = React;

/* ───────────────────────── DB + CONFIG ───────────────────────── */
const _initDB = () => {
  const cfg = window.SUPABASE_CONFIG;
  if (!cfg?.url || !cfg?.anonKey) return null;
  const url = cfg.url.replace(/^﻿/,'').trim();
  const key = cfg.anonKey.replace(/^﻿/,'').trim();
  if (!url || url.includes('YOUR_') || !key) return null;
  try { return window.supabase.createClient(url, key); } catch(e){ return null; }
};
const db = _initDB();

/* ───────────────────────── UTILS ───────────────────────── */
const fmt    = n => '₲ ' + (Math.round(n)||0).toLocaleString('es-PY');
const fmtDate= d => d ? new Date(d).toLocaleDateString('es-PY',{day:'2-digit',month:'2-digit',year:'2-digit'}) : '—';
const fmtTime= d => d ? new Date(d).toLocaleTimeString('es-PY',{hour:'2-digit',minute:'2-digit'}) : '—';
const fmtDT  = d => d ? `${fmtDate(d)} ${fmtTime(d)}` : '—';

const LEAD_TIPO   = { contacto:'Contacto', cotizacion:'Cotización' };
const LEAD_ESTADO = { nueva:'Nueva', respondida:'Respondida', negociando:'Negociando', cerrada:'Cerrada', perdida:'Perdida', archivada:'Archivada' };
const FREC_LABEL  = { unica:'Única', semanal:'Semanal', mensual:'Mensual', a_definir:'A definir' };
const PROD_ESTADO = { borrador:'Borrador', publicado:'Publicado', pausado:'Pausado', oculto_admin:'Oculto por Mythos' };
const PRECIO_TIPO = { visible:'Precio visible', desde:'Precio desde', cotizar:'A cotizar' };
const UNIDADES    = ['kg','unidad','caja','pack','bolsa','litro','bidon','docena','otro'];
const TIENDA_ESTADO = { activo:'Activa', pausado:'Pausada', suspendido:'Suspendida' };
const SUB_ESTADO  = { trial:'Prueba', active:'Al día', past_due:'Pago pendiente', cancelled:'Cancelada', suspended:'Suspendida' };
const LEAD_CONTACT_LBL = { inmediato:'Inmediato', demorado:'Con demora de 24 h', oculto:'No disponible' };

/* ── Capacidades del plan (RPC get_supplier_capabilities, migs 177/178/199) ──
   Hasta la 199 el panel NUNCA preguntaba por su plan: el proveedor no sabía
   cuánto cupo le quedaba, cuándo vencía su prueba, ni por qué le aparecía en
   blanco el nombre de un restaurante (era el gating del plan Básico, pero sin
   cartel parecía un bug). Todo eso sale de acá.
   caps === null significa "no pude preguntar" (RPC vieja o sin aplicar): en ese
   caso la UI NO topea nada — la DB es la autoridad y ya rebota lo que no toca. */
const capNum = (caps, key, fallback = -1) => {
  if (!caps) return fallback;
  const v = caps[key];
  return (v === null || v === undefined) ? fallback : Number(v);
};
const capOn      = (caps, key) => caps ? !!caps[key] : true;
const unlimited  = n => n === -1;
const atLimit    = (n, used) => !unlimited(n) && used >= n;
const capText    = n => unlimited(n) ? 'Ilimitado' : String(n);

const PALETTES = {
  light: {
    bg:'#F5F5F7', surface:'#FFFFFF', sidebar:'#FFFFFF', white:'#FFFFFF',
    border:'#D2D2D7', bs:'#86868B',
    ink:'#1D1D1F', mid:'#6E6E73', dim:'#86868B',
    green:'#34C759', orange:'#FF9500', red:'#FF3B30', blue:'#007AFF', yellow:'#FFCC00',
    redSoft:'#FFF1F0', redSoftBorder:'#FFB3AD', redSoftText:'#C0190F',
    greenSoft:'#F0FAF3', greenSoftBorder:'#A3D9B1', greenSoftText:'#1A7E37',
    orangeSoft:'#FFF4E0', orangeSoftBorder:'#FFD580', orangeSoftText:'#8A4B00',
    blueSoft:'#F0F6FF'
  },
  dark: {
    bg:'#000000', surface:'#1C1C1E', sidebar:'#1C1C1E', white:'#1C1C1E',
    border:'#38383A', bs:'#636366',
    ink:'#F5F5F7', mid:'#AEAEB2', dim:'#8E8E93',
    green:'#30D158', orange:'#FF9F0A', red:'#FF453A', blue:'#0A84FF', yellow:'#FFD60A',
    redSoft:'rgba(255,69,58,.15)', redSoftBorder:'rgba(255,69,58,.4)', redSoftText:'#FF6961',
    greenSoft:'rgba(48,209,88,.15)', greenSoftBorder:'rgba(48,209,88,.4)', greenSoftText:'#30D158',
    orangeSoft:'rgba(255,159,10,.15)', orangeSoftBorder:'rgba(255,159,10,.4)', orangeSoftText:'#FF9F0A',
    blueSoft:'rgba(10,132,255,.15)'
  },
};
const C = Object.assign({}, PALETTES[window.MythosTheme ? window.MythosTheme.get() : 'light']);
if (window.MythosTheme) {
  document.addEventListener('mythos:themechange', function(e){
    Object.assign(C, PALETTES[e.detail.mode] || PALETTES.light);
  });
}

const LEAD_COLOR = () => ({ nueva:C.orange, respondida:C.blue, negociando:C.yellow, cerrada:C.green, perdida:C.red, archivada:C.dim });
const PROD_COLOR = () => ({ borrador:C.dim, publicado:C.green, pausado:C.orange, oculto_admin:C.red });

/* ── Icon helper ──────────────────────────────────────────── */
const Icon = ({name, size=14, style}) => (
  <span style={{display:'inline-flex',alignItems:'center',justifyContent:'center',lineHeight:0,...(style||{})}}
        dangerouslySetInnerHTML={{__html: window.MythosIcons ? window.MythosIcons.html(name, {size}) : ''}}/>
);

/* contador modales / focus → pausa polling */
let _modalCount = 0;
function _shouldPause() {
  if (_modalCount > 0) return true;
  const el = document.activeElement;
  if (!el) return false;
  return ['INPUT','TEXTAREA','SELECT'].includes(el.tagName) || el.isContentEditable;
}

/* ───────────────────────── TOAST ───────────────────────── */
const _toast = { fn: null };
function toast(msg, ok=true) { _toast.fn?.({msg, ok, id: Date.now()}); }
function ToastContainer() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    _toast.fn = it => { setItems(p => [...p.slice(-4), it]); setTimeout(() => setItems(p => p.filter(i => i.id !== it.id)), 4000); };
    return () => { _toast.fn = null; };
  }, []);
  return (
    <div style={{position:'fixed',bottom:20,right:20,zIndex:9999,display:'flex',flexDirection:'column',gap:8,pointerEvents:'none'}}>
      {items.map(it => (
        <div key={it.id} style={{background:it.ok?C.greenSoft:C.redSoft,border:`1px solid ${it.ok?C.greenSoftBorder:C.redSoftBorder}`,color:it.ok?C.greenSoftText:C.redSoftText,padding:'10px 16px',fontSize:13,fontWeight:700,borderRadius:8,animation:'slideUp .2s ease',minWidth:220,maxWidth:320}}>
          {it.ok?'✓ ':'✕ '}{it.msg}
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────── MODAL (cierra solo con ESC o X) ───────────────────────── */
function Modal({title, onClose, children, width=460}) {
  useEffect(() => {
    _modalCount++;
    const fn = e => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', fn);
    return () => { _modalCount = Math.max(0, _modalCount-1); window.removeEventListener('keydown', fn); };
  }, [onClose]);
  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.7)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000,padding:20}}>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:24,width:'100%',maxWidth:width,maxHeight:'92vh',overflowY:'auto',animation:'slideUp .2s ease'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18}}>
          <div style={{fontSize:15,fontWeight:700}}>{title}</div>
          <button onClick={onClose} style={{background:'none',color:C.mid,fontSize:22,lineHeight:1,padding:0}}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ───────────────────────── COMPONENTES REUTILIZABLES ───────────────────────── */
function KpiCard({label,value,sub,accent,onClick,alert}) {
  return (
    <div onClick={onClick} className="my-metric-card" style={{flex:1,minWidth:140,cursor:onClick?'pointer':'default',position:'relative',...(alert?{borderColor:'var(--error)'}:null)}}>
      <div className="my-metric-card__label">{label}</div>
      <div style={{fontSize:22,fontWeight:800,fontFamily:"'SF Mono',ui-monospace,monospace",color:accent||C.ink,lineHeight:1}}>{value}</div>
      {sub && <div style={{fontSize:11,color:C.dim,marginTop:5}}>{sub}</div>}
    </div>
  );
}
function Badge({color, children, dot=true}) {
  return <span style={{display:'inline-flex',alignItems:'center',gap:5,padding:'3px 8px',fontSize:11,fontWeight:700,background:color+'22',color:color,border:`1px solid ${color}44`,borderRadius:5}}>{dot && <span style={{width:5,height:5,borderRadius:'50%',background:color}}/>}{children}</span>;
}
function Th({children,right,width}) { return <th style={{padding:'9px 14px',textAlign:right?'right':'left',fontSize:10,color:C.ink,fontWeight:700,letterSpacing:1,textTransform:'uppercase',whiteSpace:'nowrap',width:width||'auto'}}>{children}</th>; }
function Td({children,mono,dim,right,style:sx}) { return <td style={{padding:'10px 14px',fontSize:13,fontFamily:mono?"'SF Mono',ui-monospace,monospace":'inherit',color:dim?C.mid:C.ink,textAlign:right?'right':'left',...sx}}>{children}</td>; }
function Empty({cols, label}) { return <tr><td colSpan={cols} style={{padding:36,textAlign:'center',color:C.dim,fontSize:13}}>{label||'Sin datos'}</td></tr>; }
function Btn({children,onClick,variant='primary',disabled,small,style:sx,full}) {
  const vcls = {primary:'my-btn--primary',danger:'my-btn--danger',success:'my-btn--success',ghost:'my-btn--ghost'}[variant] || 'my-btn--secondary';
  return <button onClick={onClick} disabled={disabled} className={`my-btn ${vcls}${small?' my-btn--sm':''}`} style={{...(full?{width:'100%'}:null),...sx}}>{children}</button>;
}
function Lbl({children}) { return <label style={{fontSize:10,color:C.mid,display:'block',marginBottom:5,fontWeight:700,letterSpacing:1,textTransform:'uppercase'}}>{children}</label>; }
function Inp({value,onChange,placeholder,type='text',gs,style:sx,...rest}) {
  const style={width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6,...(sx||{})};
  // gs: input de guaraníes con separador de miles (100.000); onChange recibe dígitos crudos.
  if(gs) return <GsInput value={value} onChange={onChange} placeholder={placeholder} {...rest} style={style}/>;
  return <input type={type} value={value==null?'':value} onChange={onChange} placeholder={placeholder} {...rest} style={style}/>;
}
function Sel({value,onChange,children,...rest}) {
  return <select value={value||''} onChange={onChange} {...rest} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6,...(rest.style||{})}}>{children}</select>;
}
function Txt({value,onChange,placeholder,rows=3,...rest}) {
  return <textarea value={value||''} onChange={onChange} placeholder={placeholder} rows={rows} {...rest} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6,resize:'vertical',fontFamily:'inherit',...(rest.style||{})}}/>;
}
function Card({title, action, children, style:sx}) {
  return (
    <div className="my-card" style={sx}>
      {(title||action) && (
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
          {title && <div style={{fontSize:13,fontWeight:700,color:C.ink}}>{title}</div>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
function Toggle({checked, onChange, label}) {
  return (
    <button type="button" onClick={() => onChange(!checked)}
      style={{display:'flex',alignItems:'center',gap:10,background:'transparent',border:'none',padding:'6px 0',cursor:'pointer',textAlign:'left'}}>
      <span style={{width:36,height:20,borderRadius:10,flexShrink:0,position:'relative',transition:'background .15s',background:checked?C.ink:C.border}}>
        <span style={{position:'absolute',top:2,left:checked?18:2,width:16,height:16,borderRadius:'50%',background:C.surface,transition:'left .15s',boxShadow:'0 1px 2px rgba(0,0,0,.25)'}}/>
      </span>
      <span style={{fontSize:13,color:C.ink,fontWeight:500}}>{label}</span>
    </button>
  );
}

/* ───────────────────────── STORAGE HELPERS ───────────────────────── */
function fileExt(name) { const p = String(name||'').split('.'); return p.length>1 ? p.pop().toLowerCase() : 'bin'; }
function tipoArchivo(file) {
  const ext = fileExt(file.name);
  if (ext === 'pdf') return 'pdf';
  if (['xls','xlsx','csv'].includes(ext)) return 'excel';
  if ((file.type||'').startsWith('image/')) return 'imagen';
  return 'otro';
}
async function uploadToBucket(bucket, path, file) {
  const { error } = await db.storage.from(bucket).upload(path, file, { upsert: true, contentType: file.type || undefined });
  if (error) throw error;
  return path;
}
function publicUrl(bucket, path) {
  try { return db.storage.from(bucket).getPublicUrl(path).data.publicUrl; } catch(_) { return null; }
}

/* ───────────────────────── AUTH ───────────────────────── */
function useAuth() {
  const [state, setState] = useState({loading:true, user:null, role:null, name:null, email:null});
  useEffect(() => {
    if (!db) { setState({loading:false, user:null, role:null, name:null, email:null}); return; }
    (async () => {
      const { data: { session } } = await db.auth.getSession();
      if (!session) { window.location.replace('login.html?next=proveedor.html'); return; }
      const { data: profile } = await db.rpc('get_my_profile');
      if (!profile) { window.location.replace('login.html?next=proveedor.html'); return; }
      const allowed = ['supplier'];
      if (!allowed.includes(profile.role)) {
        toast('Acceso denegado: rol no autorizado para este panel', false);
        setTimeout(() => window.location.replace('login.html'), 1500);
        return;
      }
      setState({
        loading:false,
        user:session.user,
        role:profile.role,
        name: profile.display_name||profile.username||'Proveedor',
        email: session.user?.email||null
      });
    })();
  }, []);
  return state;
}

async function logout() {
  if (!db) return;
  try { await window.MythosPresence?.stop('manual'); } catch(_) {}
  await db.auth.signOut();
  window.location.replace('login.html');
}

/* ── PR-MKT-2: chat del marketplace (mi lado = supplier) ── */
const ChatSection = createMarketplaceChat({ React, db, C, Icon, toast, Btn, shouldPause: _shouldPause });

/* Resuelve el supplier del usuario logueado + su perfil + contacto. */
function useSupplier() {
  const [state, setState] = useState({loading:true, supplierId:null, supplier:null, contacts:null});
  const reload = useCallback(async () => {
    if (!db) { setState({loading:false, supplierId:null, supplier:null, contacts:null}); return; }
    const { data: sid, error } = await db.rpc('get_my_supplier_id');
    if (error || !sid) { setState({loading:false, supplierId:null, supplier:null, contacts:null}); return; }
    const [{ data: sup }, { data: cont }] = await Promise.all([
      db.from('marketplace_suppliers').select('*').eq('id', sid).maybeSingle(),
      db.from('marketplace_supplier_contacts').select('*').eq('supplier_id', sid).maybeSingle(),
    ]);
    setState({loading:false, supplierId:sid, supplier:sup||null, contacts:cont||null});
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}

/* Límites efectivos del plan + estado del ciclo de cobro. */
function useCapabilities() {
  const [state, setState] = useState({loading:true, caps:null});
  const reload = useCallback(async () => {
    if (!db) { setState({loading:false, caps:null}); return; }
    const { data, error } = await db.rpc('get_supplier_capabilities');
    if (error || !data) { setState({loading:false, caps:null}); return; }
    // El nombre comercial del plan no viaja en la RPC (que devuelve límites, no
    // catálogo). Se resuelve acá para no volver a hardcodear una tabla de labels
    // que se desactualice cuando cambien los planes.
    let caps = data;
    if (data.plan_slug) {
      const { data: pl } = await db.from('marketplace_supplier_plans')
        .select('name').eq('slug', data.plan_slug).maybeSingle();
      if (pl?.name) caps = {...data, plan_name: pl.name};
    }
    setState({loading:false, caps});
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}

/* ── Aviso de estado de la suscripción ──
   Es el único lugar donde el proveedor se entera de que su prueba termina o de
   que le van a pausar la tienda. Antes no existía: el trial no vencía nunca. */
function PlanAlert({caps, onJump}) {
  if (!caps) return null;
  const d = caps.days_left;
  let tone = null, titulo = '', texto = '';

  if (caps.locked) {
    tone = 'red'; titulo = 'Tu suscripción venció';
    texto = caps.auto_paused
      ? 'Tu tienda quedó pausada y no aparece en el marketplace. Escribinos para regularizarla y se reactiva enseguida.'
      : 'No podés publicar productos nuevos hasta regularizar el pago. Escribinos y lo resolvemos.';
  } else if (caps.in_grace) {
    tone = 'orange'; titulo = 'Tenés un pago pendiente';
    texto = `Tu período venció${typeof d === 'number' ? ` hace ${Math.abs(d)} día(s)` : ''}. Seguís operando durante los ${caps.grace_days || 5} días de gracia; después la tienda se pausa.`;
  } else if (caps.status === 'trial' && typeof d === 'number' && d <= 7) {
    tone = 'orange'; titulo = d <= 0 ? 'Tu prueba termina hoy' : `Tu prueba termina en ${d} día(s)`;
    texto = 'Escribinos para activar tu plan y que tu tienda siga recibiendo consultas.';
  }
  if (!tone) return null;

  const bg = tone === 'red' ? C.redSoft : C.orangeSoft;
  const bd = tone === 'red' ? C.redSoftBorder : C.orangeSoftBorder;
  const tx = tone === 'red' ? C.redSoftText : C.orangeSoftText;
  return (
    <div style={{background:bg,border:`1px solid ${bd}`,color:tx,padding:'12px 14px',borderRadius:10,marginBottom:14,
                 display:'flex',gap:12,alignItems:'flex-start',flexWrap:'wrap'}}>
      <Icon name="alert" size={16} style={{marginTop:2,flexShrink:0}}/>
      <div style={{flex:1,minWidth:220}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:2}}>{titulo}</div>
        <div style={{fontSize:12.5,lineHeight:1.5}}>{texto}</div>
      </div>
      {onJump && <Btn variant="secondary" small onClick={()=>onJump('plan')}>Ver mi plan</Btn>}
    </div>
  );
}

/* Nota de upsell reutilizable: aparece donde el plan corta algo. */
function Upsell({children, onJump}) {
  return (
    <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',background:C.blueSoft,
                 border:`1px solid ${C.border}`,borderRadius:8,padding:'8px 11px',fontSize:12,color:C.mid,lineHeight:1.5}}>
      <Icon name="alert" size={13} style={{color:C.blue,flexShrink:0}}/>
      <span style={{flex:1,minWidth:180}}>{children}</span>
      {onJump && <button onClick={()=>onJump('plan')} style={{background:'none',border:'none',padding:0,cursor:'pointer',
                   color:C.ink,fontWeight:700,fontSize:12,textDecoration:'underline'}}>Ver planes</button>}
    </div>
  );
}

/* Barra de uso de un cupo del plan (ej: 8 de 10 productos). */
function CupoBar({label, used, max}) {
  const inf = unlimited(max);
  const pct = inf ? 0 : Math.min(100, Math.round((used / Math.max(1, max)) * 100));
  const full = !inf && used >= max;
  return (
    <div style={{marginBottom:12}}>
      <div style={{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:5}}>
        <span style={{color:C.mid}}>{label}</span>
        <span style={{color:full?C.orange:C.ink,fontWeight:700}}>{used}{inf ? ' · sin límite' : ` / ${max}`}</span>
      </div>
      {!inf && (
        <div style={{height:6,borderRadius:4,background:C.bg,overflow:'hidden'}}>
          <div style={{height:'100%',width:`${pct}%`,background:full?C.orange:C.ink,transition:'width .2s'}}/>
        </div>
      )}
    </div>
  );
}

/* ── Checklist de perfil ──
   El alta pública quedó corta a propósito (nombre, RUC, WhatsApp, email y rubro):
   pedir 30 campos antes de dejar entrar espantaba proveedores. El resto del
   perfil se completa acá, con la tienda ya creada y viendo para qué sirve cada
   dato. Desaparece solo cuando está todo listo. */
function PerfilChecklist({supplier, contacts, prodTotal, onJump}) {
  const items = [
    {ok: !!(supplier.descripcion||'').trim(),        label:'Escribí una descripción de tu empresa', to:'tienda'},
    {ok: !!supplier.logo_url,                        label:'Subí tu logo',                          to:'tienda'},
    {ok: (supplier.categorias||[]).length > 0,       label:'Elegí tus categorías',                  to:'tienda'},
    {ok: (supplier.zonas_entrega||[]).length > 0,    label:'Cargá tus zonas de entrega',            to:'tienda'},
    {ok: !!(contacts?.whatsapp || contacts?.telefono),label:'Completá tu WhatsApp o teléfono',      to:'tienda'},
    {ok: (prodTotal||0) > 0,                         label:'Cargá tu primer producto',              to:'catalogo'},
  ];
  const hechos = items.filter(i=>i.ok).length;
  if (hechos === items.length) return null;
  const pct = Math.round((hechos/items.length)*100);

  return (
    <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:'14px 16px',marginBottom:14}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,marginBottom:10,flexWrap:'wrap'}}>
        <div>
          <div style={{fontSize:13.5,fontWeight:800,color:C.ink}}>Completá tu tienda</div>
          <div style={{fontSize:12,color:C.mid,marginTop:2}}>Un perfil completo recibe muchas más consultas de restaurantes.</div>
        </div>
        <div style={{fontSize:13,fontWeight:800,color:C.ink}}>{hechos} de {items.length}</div>
      </div>
      <div style={{height:6,borderRadius:4,background:C.bg,overflow:'hidden',marginBottom:12}}>
        <div style={{height:'100%',width:`${pct}%`,background:C.green,transition:'width .2s'}}/>
      </div>
      <div style={{display:'flex',flexWrap:'wrap',gap:'6px 18px'}}>
        {items.map((it,i)=>(
          <button key={i} onClick={()=>!it.ok && onJump(it.to)} disabled={it.ok}
            style={{display:'inline-flex',alignItems:'center',gap:7,background:'none',border:'none',padding:'3px 0',
                    cursor:it.ok?'default':'pointer',fontSize:12.5,textAlign:'left',
                    color:it.ok?C.dim:C.ink,textDecoration:it.ok?'line-through':'none'}}>
            <span style={{width:16,height:16,borderRadius:'50%',flexShrink:0,display:'inline-flex',alignItems:'center',
                          justifyContent:'center',fontSize:10,fontWeight:800,
                          background:it.ok?C.green:'transparent',color:C.surface,
                          border:it.ok?'none':`1.5px solid ${C.border}`}}>{it.ok?'✓':''}</span>
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   INICIO (dashboard del proveedor)
   ════════════════════════════════════════════════════════════════════ */
function Inicio({supplier, contacts, caps, onJump, unreadMsgs}) {
  const [stats, setStats] = useState({prodPub:0, prodTotal:0, leadsNuevos:0, cotAbiertas:0, contactosMes:0});
  const [lastLeads, setLastLeads] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!db || _shouldPause()) return;
    try {
      const firstOfMonth = new Date(); firstOfMonth.setDate(1); firstOfMonth.setHours(0,0,0,0);
      const [prodsQ, leadsQ, eventsQ] = await Promise.all([
        db.from('marketplace_products').select('id,estado'),
        db.from('marketplace_leads').select('id,tipo,estado,producto_texto,created_at').order('created_at',{ascending:false}),
        db.from('marketplace_events').select('id',{count:'exact',head:true})
          .eq('event_type','contact_revealed').gte('created_at', firstOfMonth.toISOString()),
      ]);
      const prods = prodsQ.data||[], leads = leadsQ.data||[];
      setStats({
        prodPub: prods.filter(p => p.estado==='publicado').length,
        prodTotal: prods.length,
        leadsNuevos: leads.filter(l => l.estado==='nueva').length,
        cotAbiertas: leads.filter(l => l.tipo==='cotizacion' && ['nueva','respondida','negociando'].includes(l.estado)).length,
        contactosMes: eventsQ.count||0,
      });
      setLastLeads(leads.slice(0,5));
    } catch(_) {}
    setLoading(false);
  }, []);
  useEffect(() => { load(); const id = setInterval(() => { if(!_shouldPause()) load(); }, 30000); return () => clearInterval(id); }, [load]);

  const lc = LEAD_COLOR();
  const estadoCol = supplier.estado==='activo'?C.green:supplier.estado==='pausado'?C.orange:C.red;
  return (
    <div className="page">
      <div style={{fontSize:18,fontWeight:800,color:C.ink,marginBottom:4}}>Inicio</div>
      <div style={{fontSize:12,color:C.mid,marginBottom:18}}>Resumen de tu tienda en el marketplace Mythos</div>

      <PlanAlert caps={caps} onJump={onJump}/>
      <PerfilChecklist supplier={supplier} contacts={contacts} prodTotal={stats.prodTotal} onJump={onJump}/>

      <div style={{display:'flex',gap:12,flexWrap:'wrap',marginBottom:16}}>
        <KpiCard label="Productos publicados" value={loading?'…':stats.prodPub} sub={`${stats.prodTotal} en total`} onClick={()=>onJump('catalogo')}/>
        <KpiCard label="Solicitudes nuevas" value={loading?'…':stats.leadsNuevos} accent={stats.leadsNuevos>0?C.orange:undefined} onClick={()=>onJump('solicitudes')}/>
        <KpiCard label="Cotizaciones abiertas" value={loading?'…':stats.cotAbiertas} onClick={()=>onJump('solicitudes')}/>
        <KpiCard label="Contactos revelados" value={loading?'…':stats.contactosMes} sub="este mes"/>
        <KpiCard label="Mensajes sin leer" value={unreadMsgs||0} accent={unreadMsgs>0?C.orange:undefined} onClick={()=>onJump('mensajes')}/>
      </div>

      <div style={{display:'flex',gap:14,flexWrap:'wrap',alignItems:'flex-start'}}>
        <Card title="Estado de la cuenta" style={{flex:'1 1 300px'}}>
          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{fontSize:12,color:C.mid}}>Tienda</span>
              <Badge color={estadoCol}>{TIENDA_ESTADO[supplier.estado]||supplier.estado}</Badge>
            </div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{fontSize:12,color:C.mid}}>Plan</span>
              <button onClick={()=>onJump('plan')} style={{background:'none',border:'none',padding:0,cursor:'pointer',
                       fontSize:13,fontWeight:700,color:C.ink,textDecoration:'underline'}}>
                {caps?.plan_name || caps?.plan_slug || supplier.plan || '—'}
                {caps?.status && <span style={{fontWeight:400,color:C.mid}}> · {SUB_ESTADO[caps.status]||caps.status}</span>}
              </button>
            </div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{fontSize:12,color:C.mid}}>Verificación</span>
              {supplier.verificado
                ? <Badge color={C.green}>Verificado</Badge>
                : <Badge color={C.dim}>Sin verificar</Badge>}
            </div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{fontSize:12,color:C.mid}}>Perfil público</span>
              <span style={{fontSize:12,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.dim}}>/{supplier.slug}</span>
            </div>
            {supplier.estado==='suspendido' && (
              <div style={{background:C.redSoft,border:`1px solid ${C.redSoftBorder}`,color:C.redSoftText,padding:'8px 10px',borderRadius:8,fontSize:12,fontWeight:600}}>
                Tu tienda fue suspendida por Mythos. Escribinos para regularizarla.
              </div>
            )}
          </div>
        </Card>

        <Card title="Últimas solicitudes" action={<Btn variant="ghost" small onClick={()=>onJump('solicitudes')}>Ver todas</Btn>} style={{flex:'2 1 420px'}}>
          {lastLeads.length===0
            ? <div style={{padding:24,textAlign:'center',color:C.dim,fontSize:13}}>Todavía no recibiste solicitudes. Publicá productos para aparecer en el marketplace.</div>
            : (
              <table style={{width:'100%',borderCollapse:'collapse'}}>
                <thead><tr style={{borderBottom:`1px solid ${C.border}`}}><Th>Fecha</Th><Th>Tipo</Th><Th>Producto</Th><Th>Estado</Th></tr></thead>
                <tbody>
                  {lastLeads.map(l => (
                    <tr key={l.id} style={{borderBottom:`1px solid ${C.border}`}}>
                      <Td dim>{fmtDT(l.created_at)}</Td>
                      <Td>{LEAD_TIPO[l.tipo]||l.tipo}</Td>
                      <Td>{l.producto_texto||'—'}</Td>
                      <Td><Badge color={lc[l.estado]||C.mid}>{LEAD_ESTADO[l.estado]||l.estado}</Badge></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </Card>

        <Card title="Accesos rápidos" style={{flex:'1 1 240px'}}>
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            <Btn variant="secondary" small full onClick={()=>onJump('catalogo')}>Cargar un producto</Btn>
            <Btn variant="secondary" small full onClick={()=>onJump('tienda')}>Completar mi perfil</Btn>
            <Btn variant="secondary" small full onClick={()=>onJump('solicitudes')}>Revisar solicitudes</Btn>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   MI TIENDA (perfil + contacto + pausar/reactivar)
   ════════════════════════════════════════════════════════════════════ */
function MiTienda({supplier, contacts, caps, onReload, onJump}) {
  const maxCats   = capNum(caps,'max_categorias');
  const maxZonas  = capNum(caps,'max_zonas');
  const puedeBanner = capOn(caps,'branding_banner');
  const [form, setForm] = useState({});
  const [cont, setCont] = useState({});
  const [cats, setCats] = useState([]);
  const [zonaInput, setZonaInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [savingCont, setSavingCont] = useState(false);
  const [uploading, setUploading] = useState(null); // 'logo' | 'banner'
  const [askPause, setAskPause] = useState(false);

  useEffect(() => {
    setForm({
      descripcion: supplier.descripcion||'', ciudad: supplier.ciudad||'', departamento: supplier.departamento||'',
      categorias: supplier.categorias||[], zonas_entrega: supplier.zonas_entrega||[],
      dias_entrega: supplier.dias_entrega||'', horario_atencion: supplier.horario_atencion||'',
      pedido_minimo: supplier.pedido_minimo||'', condiciones_comerciales: supplier.condiciones_comerciales||'',
      delivery_propio: !!supplier.delivery_propio, retiro_local: !!supplier.retiro_local,
      entrega_urgente: !!supplier.entrega_urgente, acepta_credito: !!supplier.acepta_credito,
      emite_factura: !!supplier.emite_factura,
    });
  }, [supplier]);
  useEffect(() => {
    setCont({
      telefono: contacts?.telefono||'', whatsapp: contacts?.whatsapp||'',
      email_comercial: contacts?.email_comercial||'', contacto_nombre: contacts?.contacto_nombre||'',
    });
  }, [contacts]);
  useEffect(() => {
    if (!db) return;
    db.from('marketplace_categories').select('slug,nombre').eq('activa', true).order('orden')
      .then(({data}) => setCats(data||[]));
  }, []);

  const set = (k,v) => setForm(f => ({...f, [k]:v}));
  // Los topes de categorías/zonas los aplica la DB (trigger de la mig 199); acá se
  // frenan antes para que el proveedor no descubra el límite recién al guardar.
  const toggleCat = slug => {
    const on = form.categorias.includes(slug);
    if (!on && !unlimited(maxCats) && form.categorias.length >= maxCats) {
      toast(`Tu plan permite ${maxCats} categoría(s). Mejorá tu plan para elegir más.`, false); return;
    }
    set('categorias', on ? form.categorias.filter(c=>c!==slug) : [...form.categorias, slug]);
  };
  const addZona = () => {
    const z = zonaInput.trim();
    if (!z || form.zonas_entrega.includes(z)) { setZonaInput(''); return; }
    if (!unlimited(maxZonas) && form.zonas_entrega.length >= maxZonas) {
      toast(`Tu plan permite ${maxZonas} zona(s) de entrega. Mejorá tu plan para sumar más.`, false); return;
    }
    set('zonas_entrega', [...form.zonas_entrega, z]); setZonaInput('');
  };

  async function saveProfile() {
    setSaving(true);
    const { error } = await db.from('marketplace_suppliers').update({
      descripcion: form.descripcion||null, ciudad: form.ciudad||null, departamento: form.departamento||null,
      categorias: form.categorias, zonas_entrega: form.zonas_entrega,
      dias_entrega: form.dias_entrega||null, horario_atencion: form.horario_atencion||null,
      pedido_minimo: form.pedido_minimo||null, condiciones_comerciales: form.condiciones_comerciales||null,
      delivery_propio: form.delivery_propio, retiro_local: form.retiro_local,
      entrega_urgente: form.entrega_urgente, acepta_credito: form.acepta_credito,
      emite_factura: form.emite_factura,
    }).eq('id', supplier.id);
    setSaving(false);
    if (error) { toast(error.message||'No se pudo guardar', false); return; }
    toast('Perfil guardado'); onReload();
  }

  async function saveContacts() {
    setSavingCont(true);
    const { error } = await db.from('marketplace_supplier_contacts').upsert({
      supplier_id: supplier.id,
      telefono: cont.telefono||null, whatsapp: cont.whatsapp||null,
      email_comercial: cont.email_comercial||null, contacto_nombre: cont.contacto_nombre||null,
    }, { onConflict: 'supplier_id' });
    setSavingCont(false);
    if (error) { toast(error.message||'No se pudo guardar el contacto', false); return; }
    toast('Datos de contacto guardados'); onReload();
  }

  async function uploadImage(kind, file) {
    if (!file) return;
    if (!(file.type||'').startsWith('image/')) { toast('El archivo debe ser una imagen', false); return; }
    if (file.size > 5*1024*1024) { toast('Máximo 5 MB', false); return; }
    setUploading(kind);
    try {
      const path = `${supplier.id}/${kind}-${Date.now()}.${fileExt(file.name)}`;
      await uploadToBucket('supplier-images', path, file);
      const url = publicUrl('supplier-images', path);
      const { error } = await db.from('marketplace_suppliers')
        .update(kind==='logo' ? {logo_url:url} : {banner_url:url}).eq('id', supplier.id);
      if (error) throw error;
      toast(kind==='logo'?'Logo actualizado':'Banner actualizado'); onReload();
    } catch(e) { toast(e.message||'No se pudo subir la imagen', false); }
    setUploading(null);
  }

  async function togglePause() {
    const next = supplier.estado==='activo' ? 'pausado' : 'activo';
    const { error } = await db.from('marketplace_suppliers').update({estado:next}).eq('id', supplier.id);
    setAskPause(false);
    if (error) { toast(error.message||'No se pudo cambiar el estado', false); return; }
    toast(next==='pausado'?'Tienda pausada: dejás de aparecer en el marketplace':'Tienda reactivada');
    onReload();
  }

  const suspendida = supplier.estado==='suspendido';
  return (
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:18,flexWrap:'wrap',gap:10}}>
        <div>
          <div style={{fontSize:18,fontWeight:800,color:C.ink,marginBottom:4}}>Mi Tienda</div>
          <div style={{fontSize:12,color:C.mid}}>Así te van a ver los restaurantes en el marketplace</div>
        </div>
        {!suspendida && (
          <Btn variant={supplier.estado==='activo'?'ghost':'success'} small onClick={()=>setAskPause(true)}>
            {supplier.estado==='activo' ? 'Pausar tienda' : 'Reactivar tienda'}
          </Btn>
        )}
      </div>

      {suspendida && (
        <div style={{background:C.redSoft,border:`1px solid ${C.redSoftBorder}`,color:C.redSoftText,padding:'10px 14px',borderRadius:8,fontSize:13,fontWeight:600,marginBottom:14}}>
          Tu tienda está suspendida por Mythos. Podés editar tu perfil, pero no aparecés en el marketplace.
        </div>
      )}

      <div style={{display:'flex',gap:14,flexWrap:'wrap',alignItems:'flex-start'}}>
        <div style={{flex:'2 1 460px',display:'flex',flexDirection:'column',gap:14}}>
          <Card title="Identidad (administrada por Mythos)">
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:12}}>
              <div><Lbl>Nombre comercial</Lbl><div style={{fontSize:13,fontWeight:700,color:C.ink}}>{supplier.nombre_comercial}</div></div>
              <div><Lbl>Razón social</Lbl><div style={{fontSize:13,color:C.ink}}>{supplier.razon_social||'—'}</div></div>
              <div><Lbl>RUC</Lbl><div style={{fontSize:13,fontFamily:"'SF Mono',ui-monospace,monospace",color:C.ink}}>{supplier.ruc||'—'}</div></div>
              <div><Lbl>Tipo</Lbl><div style={{fontSize:13,color:C.ink,textTransform:'capitalize'}}>{supplier.tipo_proveedor||'—'}</div></div>
            </div>
            <div style={{fontSize:11,color:C.dim,marginTop:10}}>Para corregir estos datos escribile al equipo de Mythos.</div>
          </Card>

          <Card title="Perfil de la tienda">
            <div style={{display:'flex',flexDirection:'column',gap:12}}>
              <div><Lbl>Descripción</Lbl><Txt rows={3} value={form.descripcion} onChange={e=>set('descripcion',e.target.value)} placeholder="Contale a los restaurantes qué vendés, desde cuándo y qué te diferencia"/></div>
              <div className="my-row-2" style={{gap:12}}>
                <div><Lbl>Ciudad</Lbl><Inp value={form.ciudad} onChange={e=>set('ciudad',e.target.value)}/></div>
                <div><Lbl>Departamento</Lbl><Inp value={form.departamento} onChange={e=>set('departamento',e.target.value)}/></div>
              </div>
              <div>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline'}}>
                  <Lbl>Categorías</Lbl>
                  {!unlimited(maxCats) && (
                    <span style={{fontSize:11,color:(form.categorias||[]).length>=maxCats?C.orange:C.dim,fontWeight:600}}>
                      {(form.categorias||[]).length} / {maxCats}
                    </span>
                  )}
                </div>
                <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                  {cats.map(c => {
                    const on = form.categorias?.includes(c.slug);
                    return (
                      <button key={c.slug} type="button" onClick={()=>toggleCat(c.slug)}
                        style={{padding:'5px 12px',borderRadius:14,fontSize:12,fontWeight:600,cursor:'pointer',border:`1px solid ${on?C.ink:C.border}`,background:on?C.ink:'transparent',color:on?C.sidebar:C.ink}}>
                        {c.nombre}
                      </button>
                    );
                  })}
                </div>
                {!unlimited(maxCats) && (form.categorias||[]).length>=maxCats && (
                  <div style={{marginTop:8}}>
                    <Upsell onJump={onJump}>Llegaste al máximo de categorías de tu plan. Con un plan superior aparecés en más búsquedas de restaurantes.</Upsell>
                  </div>
                )}
              </div>
              <div>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline'}}>
                  <Lbl>Zonas de entrega</Lbl>
                  {!unlimited(maxZonas) && (
                    <span style={{fontSize:11,color:(form.zonas_entrega||[]).length>=maxZonas?C.orange:C.dim,fontWeight:600}}>
                      {(form.zonas_entrega||[]).length} / {maxZonas}
                    </span>
                  )}
                </div>
                <div style={{display:'flex',gap:8}}>
                  <Inp value={zonaInput} onChange={e=>setZonaInput(e.target.value)} placeholder="Ej: Asunción, Luque…"
                       onKeyDown={e=>{ if(e.key==='Enter'){ e.preventDefault(); addZona(); } }}/>
                  <Btn variant="secondary" small onClick={addZona}>Agregar</Btn>
                </div>
                {form.zonas_entrega?.length>0 && (
                  <div style={{display:'flex',flexWrap:'wrap',gap:6,marginTop:8}}>
                    {form.zonas_entrega.map(z => (
                      <span key={z} style={{display:'inline-flex',alignItems:'center',gap:6,padding:'4px 10px',borderRadius:12,fontSize:12,border:`1px solid ${C.border}`,color:C.ink}}>
                        {z}
                        <button onClick={()=>set('zonas_entrega', form.zonas_entrega.filter(x=>x!==z))} style={{background:'none',color:C.mid,fontSize:14,lineHeight:1,padding:0}}>×</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="my-row-3" style={{gap:12}}>
                <div><Lbl>Días de entrega</Lbl><Inp value={form.dias_entrega} onChange={e=>set('dias_entrega',e.target.value)} placeholder="Lun-Vie"/></div>
                <div><Lbl>Horario</Lbl><Inp value={form.horario_atencion} onChange={e=>set('horario_atencion',e.target.value)} placeholder="07:00-17:00"/></div>
                <div><Lbl>Pedido mínimo</Lbl><Inp value={form.pedido_minimo} onChange={e=>set('pedido_minimo',e.target.value)} placeholder="₲ 300.000"/></div>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))',gap:2}}>
                <Toggle checked={form.delivery_propio} onChange={v=>set('delivery_propio',v)} label="Delivery propio"/>
                <Toggle checked={form.retiro_local} onChange={v=>set('retiro_local',v)} label="Retiro en local"/>
                <Toggle checked={form.entrega_urgente} onChange={v=>set('entrega_urgente',v)} label="Entrega urgente"/>
                <Toggle checked={form.acepta_credito} onChange={v=>set('acepta_credito',v)} label="Acepta crédito"/>
                <Toggle checked={form.emite_factura} onChange={v=>set('emite_factura',v)} label="Emite factura"/>
              </div>
              <div><Lbl>Condiciones comerciales</Lbl><Txt rows={2} value={form.condiciones_comerciales} onChange={e=>set('condiciones_comerciales',e.target.value)} placeholder="Plazos de pago, descuentos por volumen, etc."/></div>
              <div><Btn onClick={saveProfile} disabled={saving}>{saving?'Guardando…':'Guardar perfil'}</Btn></div>
            </div>
          </Card>
        </div>

        <div style={{flex:'1 1 300px',display:'flex',flexDirection:'column',gap:14}}>
          <Card title="Imágenes">
            <div style={{display:'flex',flexDirection:'column',gap:12}}>
              <div>
                <Lbl>Logo</Lbl>
                <div style={{display:'flex',alignItems:'center',gap:12}}>
                  <div style={{width:56,height:56,borderRadius:12,border:`1px solid ${C.border}`,overflow:'hidden',display:'flex',alignItems:'center',justifyContent:'center',background:C.bg,flexShrink:0}}>
                    {supplier.logo_url
                      ? <img src={supplier.logo_url} alt="logo" style={{width:'100%',height:'100%',objectFit:'cover'}}/>
                      : <Icon name="store" size={22} style={{color:C.dim}}/>}
                  </div>
                  <label className="my-btn my-btn--secondary my-btn--sm" style={{cursor:'pointer'}}>
                    {uploading==='logo'?'Subiendo…':'Cambiar logo'}
                    <input type="file" accept="image/jpeg,image/png,image/webp" style={{display:'none'}}
                           onChange={e=>{ uploadImage('logo', e.target.files?.[0]); e.target.value=''; }}/>
                  </label>
                </div>
              </div>
              <div>
                <Lbl>Banner de marca</Lbl>
                <div style={{borderRadius:10,border:`1px solid ${C.border}`,overflow:'hidden',background:C.bg,height:80,display:'flex',alignItems:'center',justifyContent:'center',marginBottom:8}}>
                  {supplier.banner_url
                    ? <img src={supplier.banner_url} alt="banner" style={{width:'100%',height:'100%',objectFit:'cover'}}/>
                    : <span style={{fontSize:12,color:C.dim}}>Sin banner</span>}
                </div>
                {puedeBanner ? (
                  <label className="my-btn my-btn--secondary my-btn--sm" style={{cursor:'pointer'}}>
                    {uploading==='banner'?'Subiendo…':'Cambiar banner'}
                    <input type="file" accept="image/jpeg,image/png,image/webp" style={{display:'none'}}
                           onChange={e=>{ uploadImage('banner', e.target.files?.[0]); e.target.value=''; }}/>
                  </label>
                ) : (
                  <Upsell onJump={onJump}>El banner de marca es parte de un plan superior.</Upsell>
                )}
              </div>
            </div>
          </Card>

          <Card title="Datos de contacto">
            <div style={{fontSize:11,color:C.dim,marginBottom:10,lineHeight:1.5}}>
              Estos datos NO son públicos: se revelan a un restaurante recién cuando te contacta por el marketplace (queda registrado como solicitud).
            </div>
            <div style={{display:'flex',flexDirection:'column',gap:10}}>
              <div><Lbl>Teléfono</Lbl><Inp value={cont.telefono} onChange={e=>setCont(c=>({...c,telefono:e.target.value}))} placeholder="+595 21 …"/></div>
              <div><Lbl>WhatsApp</Lbl><Inp value={cont.whatsapp} onChange={e=>setCont(c=>({...c,whatsapp:e.target.value}))} placeholder="+595 9…"/></div>
              <div><Lbl>Email comercial</Lbl><Inp type="email" value={cont.email_comercial} onChange={e=>setCont(c=>({...c,email_comercial:e.target.value}))}/></div>
              <div><Lbl>Persona de contacto</Lbl><Inp value={cont.contacto_nombre} onChange={e=>setCont(c=>({...c,contacto_nombre:e.target.value}))}/></div>
              <Btn onClick={saveContacts} disabled={savingCont}>{savingCont?'Guardando…':'Guardar contacto'}</Btn>
            </div>
          </Card>
        </div>
      </div>

      {askPause && (
        <Modal title={supplier.estado==='activo'?'Pausar tienda':'Reactivar tienda'} onClose={()=>setAskPause(false)} width={420}>
          <div style={{fontSize:13,color:C.mid,lineHeight:1.6,marginBottom:18}}>
            {supplier.estado==='activo'
              ? 'Mientras esté pausada, tu tienda y tus productos dejan de mostrarse a los restaurantes. Podés reactivarla cuando quieras.'
              : 'Tu tienda vuelve a mostrarse a los restaurantes del marketplace.'}
          </div>
          <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
            <Btn variant="ghost" small onClick={()=>setAskPause(false)}>Cancelar</Btn>
            <Btn variant={supplier.estado==='activo'?'danger':'success'} small onClick={togglePause}>
              {supplier.estado==='activo'?'Pausar':'Reactivar'}
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   CATÁLOGO (productos CRUD + archivos de catálogo)
   ════════════════════════════════════════════════════════════════════ */
function ProductModal({supplier, product, cats, onClose, onSaved}) {
  const isNew = !product?.id;
  const [f, setF] = useState({
    nombre: product?.nombre||'', categoria_slug: product?.categoria_slug||'', marca: product?.marca||'',
    presentacion: product?.presentacion||'', unidad: product?.unidad||'', precio: product?.precio??'',
    precio_tipo: product?.precio_tipo||'cotizar', pedido_minimo: product?.pedido_minimo||'',
    disponibilidad: product?.disponibilidad||'', etiquetas: (product?.etiquetas||[]).join(', '),
    descripcion: product?.descripcion||'', estado: product?.estado||'borrador',
  });
  const [imgFile, setImgFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k,v) => setF(x => ({...x, [k]:v}));

  async function save() {
    const nombre = f.nombre.trim();
    if (!nombre) { toast('El nombre es obligatorio', false); return; }
    const needsPrice = f.precio_tipo !== 'cotizar';
    const precioNum = f.precio === '' || f.precio == null ? null : Number(f.precio);
    if (needsPrice && (!precioNum || precioNum <= 0)) { toast('Cargá un precio válido en guaraníes', false); return; }
    setSaving(true);
    try {
      let imagen_url = product?.imagen_url || null;
      if (imgFile) {
        if (imgFile.size > 5*1024*1024) throw new Error('La imagen supera 5 MB');
        const path = `${supplier.id}/prod-${Date.now()}.${fileExt(imgFile.name)}`;
        await uploadToBucket('supplier-images', path, imgFile);
        imagen_url = publicUrl('supplier-images', path);
      }
      const row = {
        supplier_id: supplier.id, nombre, categoria_slug: f.categoria_slug||null,
        marca: f.marca.trim()||null, presentacion: f.presentacion.trim()||null, unidad: f.unidad||null,
        precio: needsPrice ? precioNum : null, precio_tipo: f.precio_tipo,
        pedido_minimo: f.pedido_minimo.trim()||null, disponibilidad: f.disponibilidad.trim()||null,
        etiquetas: f.etiquetas.split(',').map(s=>s.trim()).filter(Boolean),
        descripcion: f.descripcion.trim()||null, imagen_url, estado: f.estado,
      };
      const q = isNew
        ? db.from('marketplace_products').insert(row)
        : db.from('marketplace_products').update(row).eq('id', product.id);
      const { error } = await q;
      if (error) throw error;
      toast(isNew?'Producto creado':'Producto actualizado');
      onSaved(); onClose();
    } catch(e) { toast(e.message||'No se pudo guardar el producto', false); }
    setSaving(false);
  }

  return (
    <Modal title={isNew?'Nuevo producto':'Editar producto'} onClose={onClose} width={560}>
      <div style={{display:'flex',flexDirection:'column',gap:12}}>
        <div><Lbl>Nombre *</Lbl><Inp value={f.nombre} onChange={e=>set('nombre',e.target.value)} placeholder="Ej: Costilla vacuna premium"/></div>
        <div className="my-row-2" style={{gap:12}}>
          <div>
            <Lbl>Categoría</Lbl>
            <Sel value={f.categoria_slug} onChange={e=>set('categoria_slug',e.target.value)}>
              <option value="">Sin categoría</option>
              {cats.map(c => <option key={c.slug} value={c.slug}>{c.nombre}</option>)}
            </Sel>
          </div>
          <div><Lbl>Marca</Lbl><Inp value={f.marca} onChange={e=>set('marca',e.target.value)}/></div>
        </div>
        <div className="my-row-2" style={{gap:12}}>
          <div><Lbl>Presentación</Lbl><Inp value={f.presentacion} onChange={e=>set('presentacion',e.target.value)} placeholder="Ej: caja 20 kg"/></div>
          <div>
            <Lbl>Unidad</Lbl>
            <Sel value={f.unidad} onChange={e=>set('unidad',e.target.value)}>
              <option value="">Sin unidad</option>
              {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
            </Sel>
          </div>
        </div>
        <div className="my-row-2" style={{gap:12}}>
          <div>
            <Lbl>Modo de precio</Lbl>
            <Sel value={f.precio_tipo} onChange={e=>set('precio_tipo',e.target.value)}>
              {Object.entries(PRECIO_TIPO).map(([k,v]) => <option key={k} value={k}>{v}</option>)}
            </Sel>
          </div>
          <div>
            <Lbl>Precio (₲)</Lbl>
            <Inp gs value={f.precio} onChange={v=>set('precio',v)}
                 disabled={f.precio_tipo==='cotizar'} placeholder={f.precio_tipo==='cotizar'?'A cotizar':'Ej: 380000'}/>
          </div>
        </div>
        <div className="my-row-2" style={{gap:12}}>
          <div><Lbl>Pedido mínimo</Lbl><Inp value={f.pedido_minimo} onChange={e=>set('pedido_minimo',e.target.value)} placeholder="Ej: 1 caja"/></div>
          <div><Lbl>Disponibilidad</Lbl><Inp value={f.disponibilidad} onChange={e=>set('disponibilidad',e.target.value)} placeholder="En stock / A pedido"/></div>
        </div>
        <div><Lbl>Etiquetas (separadas por coma)</Lbl><Inp value={f.etiquetas} onChange={e=>set('etiquetas',e.target.value)} placeholder="premium, congelado, sin gluten"/></div>
        <div><Lbl>Descripción</Lbl><Txt rows={2} value={f.descripcion} onChange={e=>set('descripcion',e.target.value)}/></div>
        <div className="my-row-2" style={{gap:12,alignItems:'end'}}>
          <div>
            <Lbl>Imagen</Lbl>
            <label className="my-btn my-btn--secondary my-btn--sm" style={{cursor:'pointer',display:'inline-flex'}}>
              {imgFile ? imgFile.name.slice(0,24) : (product?.imagen_url ? 'Cambiar imagen' : 'Subir imagen')}
              <input type="file" accept="image/jpeg,image/png,image/webp" style={{display:'none'}}
                     onChange={e=>setImgFile(e.target.files?.[0]||null)}/>
            </label>
          </div>
          <div>
            <Lbl>Estado</Lbl>
            <Sel value={f.estado} onChange={e=>set('estado',e.target.value)}>
              <option value="borrador">Borrador</option>
              <option value="publicado">Publicado</option>
              <option value="pausado">Pausado</option>
            </Sel>
          </div>
        </div>
        <div style={{display:'flex',justifyContent:'flex-end',gap:10,marginTop:6}}>
          <Btn variant="ghost" small onClick={onClose}>Cancelar</Btn>
          <Btn small onClick={save} disabled={saving}>{saving?'Guardando…':'Guardar producto'}</Btn>
        </div>
      </div>
    </Modal>
  );
}

function Catalogo({supplier, caps, onJump}) {
  const maxProd = capNum(caps,'max_products');
  const maxFeat = capNum(caps,'featured_slots');
  const maxFiles= capNum(caps,'max_catalog_files');
  const [prods, setProds] = useState([]);
  const [files, setFiles] = useState([]);
  const [cats, setCats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);   // null | {} (nuevo) | producto
  const [deleting, setDeleting] = useState(null); // producto a confirmar
  const [uploadingFile, setUploadingFile] = useState(false);

  const load = useCallback(async () => {
    if (!db) return;
    const [p, fl, c] = await Promise.all([
      db.from('marketplace_products').select('*').order('created_at',{ascending:false}),
      db.from('marketplace_catalog_files').select('*').order('created_at',{ascending:false}),
      db.from('marketplace_categories').select('slug,nombre').eq('activa',true).order('orden'),
    ]);
    setProds(p.data||[]); setFiles(fl.data||[]); setCats(c.data||[]);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const catName = slug => (cats.find(c=>c.slug===slug)?.nombre) || slug || '—';
  const precioLabel = p =>
    p.precio_tipo==='cotizar' ? 'A cotizar'
    : p.precio_tipo==='desde' ? `Desde ${fmt(p.precio)}`
    : fmt(p.precio);

  async function quickEstado(p, estado) {
    const { error } = await db.from('marketplace_products').update({estado}).eq('id', p.id);
    if (error) { toast(error.message||'No se pudo cambiar el estado', false); return; }
    toast(estado==='publicado'?'Producto publicado':'Producto pausado'); load();
  }

  // Destacar = el "espacio destacado" que vende el plan (mig 199). El tope lo
  // aplica un trigger; acá se avisa antes para no gastarle un clic al proveedor.
  async function toggleDestacado(p) {
    const next = !p.destacado;
    if (next && !unlimited(maxFeat) && destacados >= maxFeat) {
      toast(maxFeat === 0
        ? 'Tu plan no incluye espacios destacados.'
        : `Tu plan permite ${maxFeat} producto(s) destacado(s). Quitá otro primero.`, false);
      return;
    }
    const { error } = await db.from('marketplace_products').update({destacado: next}).eq('id', p.id);
    if (error) { toast(error.message||'No se pudo destacar', false); return; }
    toast(next?'Producto destacado en el marketplace':'Producto sin destacar'); load();
  }

  async function doDelete() {
    const { error } = await db.from('marketplace_products').delete().eq('id', deleting.id);
    setDeleting(null);
    if (error) { toast(error.message||'No se pudo eliminar', false); return; }
    toast('Producto eliminado'); load();
  }

  async function uploadCatalogFile(file) {
    if (!file) return;
    if (file.size > 5*1024*1024) { toast('Máximo 5 MB', false); return; }
    setUploadingFile(true);
    try {
      const path = `${supplier.id}/cat-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
      await uploadToBucket('supplier-files', path, file);
      const { error } = await db.from('marketplace_catalog_files').insert({
        supplier_id: supplier.id, nombre: file.name, file_url: path, tipo: tipoArchivo(file),
      });
      if (error) throw error;
      toast('Archivo de catálogo subido'); load();
    } catch(e) { toast(e.message||'No se pudo subir el archivo', false); }
    setUploadingFile(false);
  }

  async function openFile(f) {
    try {
      const { data, error } = await db.storage.from('supplier-files').createSignedUrl(f.file_url, 3600);
      if (error || !data?.signedUrl) throw error || new Error('sin URL');
      window.open(data.signedUrl, '_blank', 'noopener');
    } catch(_) { toast('No se pudo abrir el archivo', false); }
  }

  async function deleteFile(f) {
    try { await db.storage.from('supplier-files').remove([f.file_url]); } catch(_) {}
    const { error } = await db.from('marketplace_catalog_files').delete().eq('id', f.id);
    if (error) { toast(error.message||'No se pudo eliminar el archivo', false); return; }
    toast('Archivo eliminado'); load();
  }

  const pc = PROD_COLOR();
  const publicados = prods.filter(p=>p.estado==='publicado').length;
  const destacados = prods.filter(p=>p.destacado).length;
  const sinCupo    = atLimit(maxProd, publicados);
  return (
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:18,flexWrap:'wrap',gap:10}}>
        <div>
          <div style={{fontSize:18,fontWeight:800,color:C.ink,marginBottom:4}}>Catálogo</div>
          <div style={{fontSize:12,color:C.mid}}>Los productos publicados aparecen en el marketplace para todos los restaurantes</div>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}}>
          <span style={{fontSize:12,color:sinCupo?C.orange:C.mid,fontWeight:sinCupo?700:500}}>
            {publicados} publicado{publicados===1?'':'s'}{!unlimited(maxProd) && ` de ${maxProd}`}
          </span>
          <Btn small onClick={()=>setEditing({})}>Nuevo producto</Btn>
        </div>
      </div>

      {sinCupo && (
        <div style={{marginBottom:14}}>
          <Upsell onJump={onJump}>
            Llegaste al máximo de productos publicados de tu plan ({maxProd}). Podés seguir cargando
            borradores, pero para publicarlos necesitás un plan superior o pausar otro producto.
          </Upsell>
        </div>
      )}

      <Card style={{marginBottom:14,padding:0,overflow:'hidden'}}>
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',minWidth:720}}>
            <thead><tr style={{borderBottom:`1px solid ${C.border}`}}>
              <Th>Producto</Th><Th>Categoría</Th><Th>Presentación</Th><Th right>Precio</Th><Th>Estado</Th><Th width={200}>Acciones</Th>
            </tr></thead>
            <tbody>
              {loading ? <Empty cols={6} label="Cargando…"/>
               : prods.length===0 ? <Empty cols={6} label="Sin productos todavía. Cargá el primero con “Nuevo producto”."/>
               : prods.map(p => {
                const oculto = p.estado==='oculto_admin';
                return (
                  <tr key={p.id} style={{borderBottom:`1px solid ${C.border}`,opacity:oculto?.6:1}}>
                    <Td>
                      <div style={{display:'flex',alignItems:'center',gap:10}}>
                        <div style={{width:34,height:34,borderRadius:8,border:`1px solid ${C.border}`,overflow:'hidden',flexShrink:0,background:C.bg,display:'flex',alignItems:'center',justifyContent:'center'}}>
                          {p.imagen_url
                            ? <img src={p.imagen_url} alt="" style={{width:'100%',height:'100%',objectFit:'cover'}}/>
                            : <Icon name="package" size={14} style={{color:C.dim}}/>}
                        </div>
                        <div>
                          <div style={{fontWeight:700,display:'flex',alignItems:'center',gap:6}}>
                            {p.nombre}
                            {p.destacado && <span title="Destacado en el marketplace" style={{fontSize:11,color:C.orange}}>★</span>}
                          </div>
                          {p.marca && <div style={{fontSize:11,color:C.dim}}>{p.marca}</div>}
                        </div>
                      </div>
                    </Td>
                    <Td dim>{catName(p.categoria_slug)}</Td>
                    <Td dim>{p.presentacion||'—'}</Td>
                    <Td right mono>{precioLabel(p)}</Td>
                    <Td><Badge color={pc[p.estado]||C.mid}>{PROD_ESTADO[p.estado]||p.estado}</Badge></Td>
                    <Td>
                      {oculto
                        ? <span style={{fontSize:11,color:C.dim}}>Bloqueado por Mythos</span>
                        : (
                          <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                            <Btn variant="secondary" small onClick={()=>setEditing(p)}>Editar</Btn>
                            {p.estado==='publicado'
                              ? <Btn variant="ghost" small onClick={()=>quickEstado(p,'pausado')}>Pausar</Btn>
                              : <Btn variant="success" small onClick={()=>quickEstado(p,'publicado')}>Publicar</Btn>}
                            {p.estado==='publicado' && maxFeat !== 0 && (
                              <Btn variant="ghost" small onClick={()=>toggleDestacado(p)}>
                                {p.destacado ? 'Quitar ★' : 'Destacar'}
                              </Btn>
                            )}
                            <Btn variant="danger" small onClick={()=>setDeleting(p)}>Eliminar</Btn>
                          </div>
                        )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Archivos de catálogo (PDF / Excel)"
            action={
              (maxFiles === 0 || atLimit(maxFiles, files.length))
                ? <span style={{fontSize:11.5,color:C.dim}}>
                    {maxFiles === 0 ? 'No incluido en tu plan' : `${files.length} / ${maxFiles} usados`}
                  </span>
                : <label className="my-btn my-btn--secondary my-btn--sm" style={{cursor:'pointer'}}>
                    {uploadingFile?'Subiendo…':'Subir archivo'}
                    <input type="file" accept=".pdf,.xls,.xlsx,image/jpeg,image/png,image/webp" style={{display:'none'}}
                           onChange={e=>{ uploadCatalogFile(e.target.files?.[0]); e.target.value=''; }}/>
                  </label>
            }>
        {(maxFiles === 0 || atLimit(maxFiles, files.length)) && (
          <div style={{marginBottom:files.length?12:0}}>
            <Upsell onJump={onJump}>
              {maxFiles === 0
                ? 'Tu plan no incluye catálogos PDF/Excel. Con un plan superior podés subir tu lista de precios completa.'
                : `Usaste los ${maxFiles} catálogo(s) de tu plan.`}
            </Upsell>
          </div>
        )}
        {files.length===0
          ? <div style={{padding:16,textAlign:'center',color:C.dim,fontSize:13}}>Podés subir tu catálogo completo en PDF o Excel para que los restaurantes lo descarguen.</div>
          : (
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {files.map(f => (
                <div key={f.id} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',border:`1px solid ${C.border}`,borderRadius:8}}>
                  <Icon name="fileText" size={16} style={{color:C.mid}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:600,color:C.ink,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{f.nombre}</div>
                    <div style={{fontSize:11,color:C.dim}}>{f.tipo.toUpperCase()} · {fmtDate(f.created_at)}</div>
                  </div>
                  <Btn variant="ghost" small onClick={()=>openFile(f)}>Abrir</Btn>
                  <Btn variant="danger" small onClick={()=>deleteFile(f)}>Eliminar</Btn>
                </div>
              ))}
            </div>
          )}
      </Card>

      {editing !== null && (
        <ProductModal supplier={supplier} product={editing.id?editing:null} cats={cats}
                      onClose={()=>setEditing(null)} onSaved={load}/>
      )}

      {deleting && (
        <Modal title="Eliminar producto" onClose={()=>setDeleting(null)} width={400}>
          <div style={{fontSize:13,color:C.mid,lineHeight:1.6,marginBottom:18}}>
            ¿Eliminar <strong style={{color:C.ink}}>{deleting.nombre}</strong> del catálogo? Esta acción no se puede deshacer.
          </div>
          <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
            <Btn variant="ghost" small onClick={()=>setDeleting(null)}>Cancelar</Btn>
            <Btn variant="danger" small onClick={doDelete}>Eliminar</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   SOLICITUDES (leads: contactos y cotizaciones)
   ════════════════════════════════════════════════════════════════════ */
function Solicitudes({caps, onNuevasChange, onResponder, onJump}) {
  // El nombre del restaurante viene NULL cuando el plan lo tapa (lead_contact
  // 'demorado' antes de las 24 h, u 'oculto'). Sin este cartel el proveedor veía
  // un campo en blanco y parecía un bug del panel, no un beneficio del plan.
  const leadMode = caps?.lead_contact || 'inmediato';
  const [leads, setLeads] = useState([]);
  const [restInfo, setRestInfo] = useState({});
  const [loading, setLoading] = useState(true);
  const [fTipo, setFTipo] = useState('');
  const [fEstado, setFEstado] = useState('');
  const [detail, setDetail] = useState(null);

  const load = useCallback(async () => {
    if (!db || _shouldPause()) return;
    const [{ data: ls }, { data: info }] = await Promise.all([
      db.from('marketplace_leads').select('*').order('created_at',{ascending:false}),
      db.rpc('get_my_supplier_leads_info'),
    ]);
    setLeads(ls||[]);
    const map = {};
    (info||[]).forEach(r => { map[r.lead_id] = { name: r.restaurant_name, address: r.restaurant_address }; });
    setRestInfo(map);
    setLoading(false);
    onNuevasChange?.((ls||[]).filter(l => l.estado==='nueva').length);
  }, [onNuevasChange]);
  useEffect(() => { load(); const id = setInterval(() => { if(!_shouldPause()) load(); }, 20000); return () => clearInterval(id); }, [load]);

  async function setEstado(lead, estado) {
    const { error } = await db.from('marketplace_leads').update({estado}).eq('id', lead.id);
    if (error) { toast(error.message||'No se pudo actualizar', false); return; }
    toast('Estado actualizado');
    setDetail(d => d && d.id===lead.id ? {...d, estado} : d);
    // Actualización optimista: load() se auto-cancela por _shouldPause mientras
    // el <select> conserva el foco y el Sel controlado rebotaría al valor viejo.
    const next = leads.map(x => x.id === lead.id ? { ...x, estado } : x);
    setLeads(next);
    onNuevasChange?.(next.filter(l => l.estado === 'nueva').length);
  }

  const filtered = leads.filter(l => (!fTipo || l.tipo===fTipo) && (!fEstado || l.estado===fEstado));
  const lc = LEAD_COLOR();
  return (
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-end',marginBottom:18,flexWrap:'wrap',gap:10}}>
        <div>
          <div style={{fontSize:18,fontWeight:800,color:C.ink,marginBottom:4}}>Solicitudes</div>
          <div style={{fontSize:12,color:C.mid}}>Restaurantes que pidieron tu contacto o una cotización</div>
        </div>
        <div style={{display:'flex',gap:8}}>
          <Sel value={fTipo} onChange={e=>setFTipo(e.target.value)} style={{width:150}}>
            <option value="">Todos los tipos</option>
            <option value="contacto">Contacto</option>
            <option value="cotizacion">Cotización</option>
          </Sel>
          <Sel value={fEstado} onChange={e=>setFEstado(e.target.value)} style={{width:150}}>
            <option value="">Todos los estados</option>
            {Object.entries(LEAD_ESTADO).map(([k,v]) => <option key={k} value={k}>{v}</option>)}
          </Sel>
        </div>
      </div>

      <Card style={{padding:0,overflow:'hidden'}}>
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',minWidth:760}}>
            <thead><tr style={{borderBottom:`1px solid ${C.border}`}}>
              <Th>Fecha</Th><Th>Restaurante</Th><Th>Tipo</Th><Th>Producto</Th><Th>Cantidad</Th><Th>Estado</Th><Th width={90}></Th>
            </tr></thead>
            <tbody>
              {loading ? <Empty cols={7} label="Cargando…"/>
               : filtered.length===0 ? <Empty cols={7} label="Sin solicitudes con esos filtros."/>
               : filtered.map(l => (
                <tr key={l.id} style={{borderBottom:`1px solid ${C.border}`,background:l.estado==='nueva'?C.orangeSoft:'transparent'}}>
                  <Td dim>{fmtDT(l.created_at)}</Td>
                  <Td>
                    {restInfo[l.id]?.name
                      ? <span style={{fontWeight:700}}>{restInfo[l.id].name}</span>
                      : <span style={{fontSize:11.5,color:C.orange,fontWeight:600}}>
                          {leadMode==='demorado' ? 'Se revela a las 24 h' : 'Requiere plan superior'}
                        </span>}
                  </Td>
                  <Td>{LEAD_TIPO[l.tipo]||l.tipo}</Td>
                  <Td>{l.producto_texto||'—'}</Td>
                  <Td dim>{l.cantidad||'—'}</Td>
                  <Td>
                    <Sel value={l.estado} onChange={e=>setEstado(l, e.target.value)} style={{width:130,padding:'5px 8px',fontSize:12}}>
                      {Object.entries(LEAD_ESTADO).map(([k,v]) => <option key={k} value={k}>{v}</option>)}
                    </Sel>
                  </Td>
                  <Td><Btn variant="ghost" small onClick={()=>setDetail(l)}>Detalle</Btn></Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {detail && (
        <Modal title={`Solicitud · ${LEAD_TIPO[detail.tipo]||detail.tipo}`} onClose={()=>setDetail(null)} width={480}>
          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            <div>
              <Lbl>Restaurante</Lbl>
              {restInfo[detail.id]?.name ? (
                <>
                  <div style={{fontSize:14,fontWeight:700,color:C.ink}}>{restInfo[detail.id].name}</div>
                  {restInfo[detail.id]?.address && <div style={{fontSize:12,color:C.mid}}>{restInfo[detail.id].address}</div>}
                </>
              ) : (
                <Upsell onJump={onJump}>
                  {leadMode==='demorado'
                    ? 'Con tu plan actual el nombre y la dirección del restaurante se revelan 24 h después de la consulta. Con un plan superior los ves al instante.'
                    : 'Tu plan no muestra los datos del restaurante. Mejorá tu plan para verlos.'}
                </Upsell>
              )}
            </div>
            <div className="my-row-2" style={{gap:12}}>
              <div><Lbl>Fecha</Lbl><div style={{fontSize:13,color:C.ink}}>{fmtDT(detail.created_at)}</div></div>
              <div><Lbl>Estado</Lbl><Badge color={lc[detail.estado]||C.mid}>{LEAD_ESTADO[detail.estado]||detail.estado}</Badge></div>
            </div>
            {detail.tipo==='cotizacion' && (
              <div className="my-row-3" style={{gap:12}}>
                <div><Lbl>Producto</Lbl><div style={{fontSize:13,color:C.ink}}>{detail.producto_texto||'—'}</div></div>
                <div><Lbl>Cantidad</Lbl><div style={{fontSize:13,color:C.ink}}>{detail.cantidad||'—'}</div></div>
                <div><Lbl>Frecuencia</Lbl><div style={{fontSize:13,color:C.ink}}>{FREC_LABEL[detail.frecuencia]||'—'}</div></div>
              </div>
            )}
            {detail.mensaje && (
              <div><Lbl>Mensaje</Lbl>
                <div style={{fontSize:13,color:C.ink,background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:'10px 12px',whiteSpace:'pre-wrap'}}>{detail.mensaje}</div>
              </div>
            )}
            <div>
              <Lbl>Cambiar estado</Lbl>
              <Sel value={detail.estado} onChange={e=>setEstado(detail, e.target.value)}>
                {Object.entries(LEAD_ESTADO).map(([k,v]) => <option key={k} value={k}>{v}</option>)}
              </Sel>
            </div>
            <div style={{display:'flex',justifyContent:'flex-end',gap:10}}>
              <Btn variant="secondary" small onClick={()=>{ setDetail(null); onResponder(detail); }}>Responder</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   MENSAJES (chat real — PR-MKT-2)
   ════════════════════════════════════════════════════════════════════ */
function Mensajes({openConversationId, onOpened, onUnread}) {
  return (
    <div className="page">
      <div style={{fontSize:18,fontWeight:800,color:C.ink,marginBottom:4}}>Mensajes</div>
      <div style={{fontSize:12,color:C.mid,marginBottom:14}}>Conversaciones con los restaurantes que te contactaron</div>
      <ChatSection side="supplier" openConversationId={openConversationId} onOpened={onOpened} onUnreadTotal={onUnread}/>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   ANALÍTICA — mig 199
   Los planes vendían "Analítica básica/completa" desde la mig 177 y el panel no
   tenía ninguna pantalla de analítica. Los números salen agregados de la RPC
   supplier_analytics (server-side): agrupar en el navegador un array cargado con
   `.limit()` daría un número que empeora cuanto más vende el proveedor.
   ════════════════════════════════════════════════════════════════════ */
function Analitica({caps, onJump}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [falta, setFalta] = useState(false);

  useEffect(() => {
    if (!db) { setLoading(false); return; }
    (async () => {
      const { data: d, error } = await db.rpc('supplier_analytics', { p_months: 6 });
      if (error) { setFalta(true); setLoading(false); return; }
      setData(d || null); setLoading(false);
    })();
  }, []);

  const modo = caps?.analytics || (data?.mode);
  const head = (
    <>
      <div style={{fontSize:18,fontWeight:800,color:C.ink,marginBottom:4}}>Analítica</div>
      <div style={{fontSize:12,color:C.mid,marginBottom:18}}>Cómo vienen las consultas de los restaurantes</div>
    </>
  );

  if (loading) return <div className="page">{head}<div style={{color:C.dim,fontSize:13}}>Cargando…</div></div>;

  if (falta) return (
    <div className="page">{head}
      <Card><div style={{padding:18,textAlign:'center',color:C.dim,fontSize:13}}>
        La analítica todavía no está disponible en este servidor.
      </div></Card>
    </div>
  );

  if (!data || data.enabled === false || modo === 'none') return (
    <div className="page">{head}
      <Card>
        <div style={{padding:'22px 18px',textAlign:'center'}}>
          <div style={{fontSize:15,fontWeight:800,color:C.ink,marginBottom:8}}>La analítica es parte de un plan superior</div>
          <div style={{fontSize:13,color:C.mid,lineHeight:1.6,maxWidth:460,margin:'0 auto 16px'}}>
            Vas a poder ver cuántas consultas recibís por mes, cuántas respondés y qué productos
            te piden más. Con eso sabés qué conviene tener siempre en stock.
          </div>
          <Btn small onClick={()=>onJump('plan')}>Ver planes</Btn>
        </div>
      </Card>
    </div>
  );

  const t = data.totals || {};
  const meses = Array.isArray(data.by_month) ? data.by_month : [];
  const maxMes = Math.max(1, ...meses.map(m=>Number(m.leads)||0));
  const respTasa = (t.leads||0) > 0 ? Math.round(((t.respondidas||0)/(t.leads||1))*100) : 0;
  const tops = Array.isArray(data.top_products) ? data.top_products : [];
  const topc = Array.isArray(data.top_categories) ? data.top_categories : [];
  const maxTop = Math.max(1, ...tops.map(x=>Number(x.n)||0));
  const maxTopc = Math.max(1, ...topc.map(x=>Number(x.n)||0));
  const mesLabel = m => { const [y,mm] = String(m).split('-'); return `${mm}/${String(y).slice(2)}`; };

  return (
    <div className="page">{head}
      <div style={{display:'flex',gap:12,flexWrap:'wrap',marginBottom:16}}>
        <KpiCard label="Consultas recibidas" value={t.leads||0} sub={`${t.contactos||0} contactos · ${t.cotizaciones||0} cotizaciones`}/>
        <KpiCard label="Sin responder" value={t.nuevas||0} accent={(t.nuevas||0)>0?C.orange:undefined}/>
        <KpiCard label="Tasa de respuesta" value={`${respTasa}%`} sub={`${t.respondidas||0} atendidas`}/>
        <KpiCard label="Cerradas" value={t.cerradas||0} sub={`${t.perdidas||0} perdidas`} accent={(t.cerradas||0)>0?C.green:undefined}/>
      </div>

      <Card title="Consultas por mes" style={{marginBottom:14}}>
        {meses.length===0
          ? <div style={{padding:18,textAlign:'center',color:C.dim,fontSize:13}}>Todavía no hay consultas.</div>
          : (
            <div style={{display:'flex',alignItems:'flex-end',gap:10,height:150,padding:'8px 4px'}}>
              {meses.map(m => {
                const n = Number(m.leads)||0;
                return (
                  <div key={m.mes} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:6}}>
                    <div style={{fontSize:11,fontWeight:700,color:n?C.ink:C.dim}}>{n}</div>
                    <div title={`${m.contactos_revelados||0} contactos revelados`}
                         style={{width:'100%',maxWidth:46,height:`${Math.round((n/maxMes)*100)}%`,minHeight:n?6:2,
                                 background:n?C.ink:C.border,borderRadius:'5px 5px 0 0',transition:'height .2s'}}/>
                    <div style={{fontSize:10.5,color:C.dim}}>{mesLabel(m.mes)}</div>
                  </div>
                );
              })}
            </div>
          )}
      </Card>

      {modo === 'completo' ? (
        <div style={{display:'flex',gap:14,flexWrap:'wrap',alignItems:'flex-start'}}>
          <Card title="Productos más consultados" style={{flex:'1 1 320px'}}>
            {tops.length===0 ? <div style={{padding:14,color:C.dim,fontSize:13}}>Sin datos todavía.</div> :
              tops.map((x,i)=>(
                <div key={i} style={{marginBottom:10}}>
                  <div style={{display:'flex',justifyContent:'space-between',fontSize:12.5,marginBottom:4}}>
                    <span style={{color:C.ink,fontWeight:600}}>{x.nombre}</span><span style={{color:C.mid}}>{x.n}</span>
                  </div>
                  <div style={{height:6,borderRadius:4,background:C.bg,overflow:'hidden'}}>
                    <div style={{height:'100%',width:`${Math.round((x.n/maxTop)*100)}%`,background:C.ink}}/>
                  </div>
                </div>
              ))}
          </Card>
          <Card title="Categorías más consultadas" style={{flex:'1 1 320px'}}>
            {topc.length===0 ? <div style={{padding:14,color:C.dim,fontSize:13}}>Sin datos todavía.</div> :
              topc.map((x,i)=>(
                <div key={i} style={{marginBottom:10}}>
                  <div style={{display:'flex',justifyContent:'space-between',fontSize:12.5,marginBottom:4}}>
                    <span style={{color:C.ink,fontWeight:600}}>{x.nombre}</span><span style={{color:C.mid}}>{x.n}</span>
                  </div>
                  <div style={{height:6,borderRadius:4,background:C.bg,overflow:'hidden'}}>
                    <div style={{height:'100%',width:`${Math.round((x.n/maxTopc)*100)}%`,background:C.ink}}/>
                  </div>
                </div>
              ))}
          </Card>
        </div>
      ) : (
        <Upsell onJump={onJump}>
          Con la analítica completa también ves qué productos y categorías te consultan más.
        </Upsell>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   MI PLAN (cupos, vencimiento, pagos y comparativa) — mig 199
   ════════════════════════════════════════════════════════════════════ */
function MiPlan({supplier, caps, onJump}) {
  const [plans, setPlans] = useState([]);
  const [pagos, setPagos] = useState([]);
  const [uso, setUso]     = useState({prodPub:0, destacados:0, archivos:0, usuarios:0});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!db) return;
    (async () => {
      const [pl, pg, prods, files, users] = await Promise.all([
        db.from('marketplace_supplier_plans').select('*').order('sort_order').then(r=>r.error?{data:[]}:r),
        db.from('marketplace_supplier_payments').select('*').order('paid_at',{ascending:false}).limit(24).then(r=>r.error?{data:[]}:r),
        db.from('marketplace_products').select('estado,destacado').then(r=>r.error?{data:[]}:r),
        db.from('marketplace_catalog_files').select('id').then(r=>r.error?{data:[]}:r),
        db.from('marketplace_supplier_users').select('id,is_active').then(r=>r.error?{data:[]}:r),
      ]);
      const P = prods.data||[];
      setPlans((pl.data||[]).filter(p=>p.status==='active'));
      setPagos(pg.data||[]);
      setUso({
        prodPub:    P.filter(p=>p.estado==='publicado').length,
        destacados: P.filter(p=>p.destacado).length,
        archivos:   (files.data||[]).length,
        usuarios:   (users.data||[]).filter(u=>u.is_active!==false).length || 1,
      });
      setLoading(false);
    })();
  }, []);

  const slug     = caps?.plan_slug || supplier.plan;
  const actual   = plans.find(p=>p.slug===slug);
  const estadoSub= caps?.status;
  const dias     = caps?.days_left;
  const vence    = caps?.expires_on;
  const estadoCol= caps?.locked ? C.red : caps?.in_grace ? C.orange : estadoSub==='active' ? C.green : C.blue;

  return (
    <div className="page">
      <div style={{fontSize:18,fontWeight:800,color:C.ink,marginBottom:4}}>Mi plan</div>
      <div style={{fontSize:12,color:C.mid,marginBottom:18}}>Qué incluye tu plan, cuánto usaste y cuándo vence</div>

      <PlanAlert caps={caps}/>

      <div style={{display:'flex',gap:14,flexWrap:'wrap',alignItems:'flex-start',marginBottom:14}}>
        <Card title="Tu plan" style={{flex:'1 1 320px'}}>
          <div style={{display:'flex',alignItems:'baseline',gap:10,marginBottom:12}}>
            <div style={{fontSize:24,fontWeight:800,color:C.ink}}>{actual?.name || slug || '—'}</div>
            {actual?.price_gs>0 && <div style={{fontSize:13,color:C.mid}}>{fmt(actual.price_gs)} / mes</div>}
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{fontSize:12,color:C.mid}}>Estado</span>
              {estadoSub
                ? <Badge color={estadoCol}>{SUB_ESTADO[estadoSub]||estadoSub}</Badge>
                : <Badge color={C.dim}>Sin suscripción</Badge>}
            </div>
            {vence && (
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <span style={{fontSize:12,color:C.mid}}>{estadoSub==='trial'?'La prueba termina':'Próximo vencimiento'}</span>
                <span style={{fontSize:13,fontWeight:700,color:C.ink}}>
                  {fmtDate(vence)}{typeof dias==='number' && <span style={{fontWeight:400,color:C.mid}}> · {dias>=0?`en ${dias} d`:`hace ${Math.abs(dias)} d`}</span>}
                </span>
              </div>
            )}
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{fontSize:12,color:C.mid}}>Contacto de los leads</span>
              <span style={{fontSize:13,fontWeight:700,color:C.ink}}>{LEAD_CONTACT_LBL[caps?.lead_contact]||'—'}</span>
            </div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{fontSize:12,color:C.mid}}>Tienda</span>
              <Badge color={supplier.estado==='activo'?C.green:supplier.estado==='pausado'?C.orange:C.red}>
                {TIENDA_ESTADO[supplier.estado]||supplier.estado}
              </Badge>
            </div>
          </div>
          <div style={{fontSize:11,color:C.dim,marginTop:14,lineHeight:1.5,borderTop:`1px solid ${C.border}`,paddingTop:10}}>
            Para cambiar de plan o regularizar un pago, escribile al equipo de Mythos.
          </div>
        </Card>

        <Card title="Cuánto usaste" style={{flex:'1 1 320px'}}>
          {loading ? <div style={{color:C.dim,fontSize:13,padding:8}}>Cargando…</div> : (
            <>
              <CupoBar label="Productos publicados" used={uso.prodPub}    max={capNum(caps,'max_products')}/>
              <CupoBar label="Productos destacados" used={uso.destacados} max={capNum(caps,'featured_slots')}/>
              <CupoBar label="Catálogos PDF/Excel"  used={uso.archivos}   max={capNum(caps,'max_catalog_files')}/>
              <CupoBar label="Categorías"           used={(supplier.categorias||[]).length}    max={capNum(caps,'max_categorias')}/>
              <CupoBar label="Zonas de entrega"     used={(supplier.zonas_entrega||[]).length} max={capNum(caps,'max_zonas')}/>
              <CupoBar label="Usuarios"             used={uso.usuarios}   max={capNum(caps,'max_users')}/>
            </>
          )}
        </Card>
      </div>

      {plans.length>0 && (
        <Card title="Planes disponibles" style={{marginBottom:14}}>
          <div style={{display:'flex',gap:12,flexWrap:'wrap'}}>
            {plans.map(p => {
              const on = p.slug===slug;
              return (
                <div key={p.slug} style={{flex:'1 1 240px',minWidth:220,border:`1px solid ${on?C.ink:C.border}`,
                     borderRadius:12,padding:'16px 14px',background:on?C.blueSoft:'transparent'}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                    <span style={{fontSize:15,fontWeight:800,color:C.ink}}>{p.name}</span>
                    {on && <Badge color={C.blue} dot={false}>Tu plan</Badge>}
                  </div>
                  <div style={{fontSize:18,fontWeight:800,color:C.ink,marginBottom:10}}>
                    {p.price_gs>0 ? fmt(p.price_gs) : 'Gratis'}
                    {p.price_gs>0 && <span style={{fontSize:11,fontWeight:600,color:C.mid}}> / mes</span>}
                  </div>
                  <ul style={{listStyle:'none',padding:0,margin:0,display:'flex',flexDirection:'column',gap:6}}>
                    {(Array.isArray(p.features)?p.features:[]).map((f,i)=>(
                      <li key={i} style={{fontSize:12,color:C.mid,display:'flex',gap:7,lineHeight:1.45}}>
                        <span style={{color:C.green,fontWeight:800,flexShrink:0}}>✓</span>{String(f)}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Card title="Historial de pagos">
        {pagos.length===0
          ? <div style={{padding:16,textAlign:'center',color:C.dim,fontSize:13}}>Todavía no hay pagos registrados.</div>
          : (
            <table style={{width:'100%',borderCollapse:'collapse'}}>
              <thead><tr style={{borderBottom:`1px solid ${C.border}`}}>
                <Th>Fecha</Th><Th>Plan</Th><Th>Período</Th><Th>Método</Th><Th right>Monto</Th>
              </tr></thead>
              <tbody>
                {pagos.map(p=>(
                  <tr key={p.id} style={{borderBottom:`1px solid ${C.border}`}}>
                    <Td dim>{fmtDate(p.paid_at)}</Td>
                    <Td>{p.plan_slug||'—'}</Td>
                    <Td dim>{p.period_end?`hasta ${fmtDate(p.period_end)}`:'—'}</Td>
                    <Td dim style={{textTransform:'capitalize'}}>{p.method||'—'}</Td>
                    <Td right mono>{fmt(p.amount_gs)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   PANTALLAS DE BORDE
   ════════════════════════════════════════════════════════════════════ */
function CenterNotice({title, children, showLogout}) {
  return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:C.bg,padding:24}}>
      <div style={{maxWidth:420,textAlign:'center',background:C.sidebar,border:`1px solid ${C.border}`,borderRadius:16,padding:'36px 28px'}}>
        <div style={{fontSize:20,fontWeight:800,color:C.ink,marginBottom:8}}>{title}</div>
        <div style={{fontSize:13.5,color:C.mid,lineHeight:1.6,marginBottom:showLogout?22:0}}>{children}</div>
        {showLogout && <Btn variant="ghost" small onClick={logout}>Cerrar sesión</Btn>}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   APP
   ════════════════════════════════════════════════════════════════════ */
function App() {
  const auth = useAuth();
  const { loading: supLoading, supplierId, supplier, contacts, reload } = useSupplier();
  const { caps, reload: reloadCaps } = useCapabilities();
  const [section, setSection] = useState('inicio');
  const [nuevas, setNuevas] = useState(0);
  const [unreadMsgs, setUnreadMsgs] = useState(0);
  const [chatTarget, setChatTarget] = useState(null);
  const [themeMode, setThemeMode] = useState(window.MythosTheme ? window.MythosTheme.get() : 'light');
  const [, force] = useState(0);

  useEffect(() => {
    const fn = e => { setThemeMode(e.detail.mode); force(x=>x+1); };
    document.addEventListener('mythos:themechange', fn);
    return () => document.removeEventListener('mythos:themechange', fn);
  }, []);

  // badges del sidebar: solicitudes nuevas + mensajes sin leer (poll liviano).
  // Estando en Mensajes, el conteo de no-leídos lo alimenta SOLO el ChatSection
  // (onUnreadTotal): sin esta guarda, una respuesta en vuelo del poll podría
  // pisar el 0 recién marcado con el conteo viejo (unread fantasma).
  useEffect(() => {
    if (!db || !supplierId) return;
    let on = true;
    const check = async () => {
      if (_shouldPause()) return;
      const { count } = await db.from('marketplace_leads').select('id',{count:'exact',head:true}).eq('estado','nueva');
      if (on && typeof count === 'number') setNuevas(count);
      if (section !== 'mensajes') {
        const { data: convs } = await db.from('marketplace_conversations').select('supplier_unread');
        if (on && Array.isArray(convs)) setUnreadMsgs(convs.reduce((s,c)=>s+(c.supplier_unread||0),0));
      }
    };
    check();
    const id = setInterval(check, 30000);
    return () => { on = false; clearInterval(id); };
  }, [supplierId, section]);

  // Responder una solicitud: abre (o crea vía RPC) la conversación con ese restaurante
  async function responderLead(lead) {
    if (!lead) return;
    const { data, error } = await db.rpc('ensure_conversation', {
      p_supplier_id: lead.supplier_id, p_restaurant_id: lead.restaurant_id,
    });
    if (error || !data) { toast((error && error.message) || 'No se pudo abrir la conversación', false); return; }
    setChatTarget(data);
    setSection('mensajes');
  }

  if (!db) return <CenterNotice title="Sin conexión a Supabase">Falta configurar <code>config.js</code> con las credenciales del proyecto.</CenterNotice>;
  if (auth.loading || supLoading) {
    return <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:C.bg}}><div className="spin"/></div>;
  }
  if (!auth.user) return null; // useAuth ya redirigió
  if (!supplierId || !supplier) {
    return (
      <CenterNotice title="Cuenta sin proveedor vinculado" showLogout>
        Tu usuario tiene rol de proveedor pero no está vinculado a ninguna tienda del marketplace.
        Escribile al equipo de Mythos para completar el alta.
      </CenterNotice>
    );
  }

  const sections = [
    {key:'inicio',      label:'Inicio',      icon:'dashboard'},
    {key:'tienda',      label:'Mi Tienda',   icon:'store'},
    {key:'catalogo',    label:'Catálogo',    icon:'package'},
    {key:'solicitudes', label:'Solicitudes', icon:'fileText', badge:nuevas},
    {key:'mensajes',    label:'Mensajes',    icon:'chat', badge:unreadMsgs},
    {key:'analitica',   label:'Analítica',   icon:'chart'},
    {key:'plan',        label:'Mi plan',     icon:'creditCard'},
  ];

  return (
    <div style={{display:'flex',minHeight:'100vh',background:C.bg}}>
      <aside style={{width:220,background:C.sidebar,borderRight:`1px solid ${C.border}`,padding:'20px 0',display:'flex',flexDirection:'column',flexShrink:0}}>
        <div style={{padding:'0 20px 18px',borderBottom:`1px solid ${C.border}`,display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:8}}>
          <div>
            <div style={{fontSize:20,fontWeight:800,letterSpacing:'-0.5px',color:C.ink}}>Mythos</div>
            <div style={{fontSize:11,color:C.mid,fontWeight:600,marginTop:2}}>Panel Proveedor</div>
          </div>
          <button onClick={()=>window.MythosTheme && window.MythosTheme.toggle()} title={themeMode==='dark'?'Cambiar a claro':'Cambiar a oscuro'}
            style={{width:28,height:28,borderRadius:'50%',background:'transparent',border:`1px solid ${C.border}`,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',color:C.ink,flexShrink:0}}>
            <Icon name={themeMode==='dark'?'sun':'moon'} size={13}/>
          </button>
        </div>
        <nav style={{flex:1,padding:'12px 10px',display:'flex',flexDirection:'column',gap:2}}>
          {sections.map(s => (
            <button key={s.key} onClick={() => setSection(s.key)} style={{
              display:'flex',alignItems:'center',gap:10,padding:'10px 12px',background:section===s.key?C.ink:'transparent',color:section===s.key?C.sidebar:C.ink,
              border:'none',borderRadius:8,fontSize:13,fontWeight:section===s.key?600:500,textAlign:'left',transition:'background .15s',position:'relative',cursor:'pointer'
            }}>
              <span style={{display:'inline-flex',alignItems:'center',width:16,justifyContent:'center'}}><Icon name={s.icon} size={15}/></span>
              <span style={{flex:1}}>{s.label}</span>
              {s.badge>0 && <span style={{background:section===s.key?C.sidebar:C.red,color:section===s.key?C.red:C.sidebar,fontSize:10,fontWeight:800,padding:'2px 7px',borderRadius:10,minWidth:18,textAlign:'center'}}>{s.badge}</span>}
            </button>
          ))}
        </nav>
        <div style={{padding:'14px 16px',borderTop:`1px solid ${C.border}`}}>
          <div style={{fontSize:12,fontWeight:700,color:C.ink,marginBottom:2}}>{supplier.nombre_comercial}</div>
          <div style={{fontSize:11,color:C.mid,marginBottom:10}}>{auth.name}</div>
          <Btn variant="ghost" small full onClick={logout}>Cerrar sesión</Btn>
        </div>
      </aside>

      <main style={{flex:1,padding:'28px 32px',overflowX:'auto',background:C.bg}}>
        {section==='inicio'      && <Inicio supplier={supplier} contacts={contacts} caps={caps} onJump={setSection} unreadMsgs={unreadMsgs}/>}
        {section==='tienda'      && <MiTienda supplier={supplier} contacts={contacts} caps={caps} onReload={()=>{reload();reloadCaps();}} onJump={setSection}/>}
        {section==='catalogo'    && <Catalogo supplier={supplier} caps={caps} onJump={setSection}/>}
        {section==='solicitudes' && <Solicitudes caps={caps} onNuevasChange={setNuevas} onResponder={responderLead} onJump={setSection}/>}
        {section==='mensajes'    && <Mensajes openConversationId={chatTarget} onOpened={()=>setChatTarget(null)} onUnread={setUnreadMsgs}/>}
        {section==='analitica'   && <Analitica caps={caps} onJump={setSection}/>}
        {section==='plan'        && <MiPlan supplier={supplier} caps={caps} onJump={setSection}/>}
      </main>

      <ToastContainer/>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App/>);
