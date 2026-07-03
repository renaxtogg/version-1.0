// ════════════════════════════════════════════════════════════════════
// PR-MKT-1 — Panel Proveedor (marketplace B2B "Proveedores", FASE 1).
// Panel nuevo precompilado con Vite (patrón PR-5/gerente): React de npm,
// el resto de globales del shell en window.* (config.js, supabase UMD,
// MythosTheme/Icons/Session/AuthGuard). Requiere la migración 142
// (tablas marketplace_*, rol 'supplier', RPCs y buckets).
// Secciones: Inicio (métricas) · Mi Tienda (perfil+contacto+pausa) ·
// Catálogo (productos CRUD + archivos) · Solicitudes (leads) ·
// Mensajes (placeholder — el chat llega en Fase 2).
// ════════════════════════════════════════════════════════════════════
import React from "react";
import { createRoot } from "react-dom/client";

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
const PLAN_LABEL  = { fundador:'Fundador', basico:'Básico', pro:'Pro' };
const TIENDA_ESTADO = { activo:'Activa', pausado:'Pausada', suspendido:'Suspendida' };

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
function Inp({value,onChange,placeholder,type='text',...rest}) {
  return <input type={type} value={value==null?'':value} onChange={onChange} placeholder={placeholder} {...rest} style={{width:'100%',padding:'9px 11px',fontSize:13,borderRadius:6,...(rest.style||{})}}/>;
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

/* ════════════════════════════════════════════════════════════════════
   INICIO (dashboard del proveedor)
   ════════════════════════════════════════════════════════════════════ */
function Inicio({supplier, onJump}) {
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

      <div style={{display:'flex',gap:12,flexWrap:'wrap',marginBottom:16}}>
        <KpiCard label="Productos publicados" value={loading?'…':stats.prodPub} sub={`${stats.prodTotal} en total`} onClick={()=>onJump('catalogo')}/>
        <KpiCard label="Solicitudes nuevas" value={loading?'…':stats.leadsNuevos} accent={stats.leadsNuevos>0?C.orange:undefined} onClick={()=>onJump('solicitudes')}/>
        <KpiCard label="Cotizaciones abiertas" value={loading?'…':stats.cotAbiertas} onClick={()=>onJump('solicitudes')}/>
        <KpiCard label="Contactos revelados" value={loading?'…':stats.contactosMes} sub="este mes"/>
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
              <span style={{fontSize:13,fontWeight:700,color:C.ink}}>{PLAN_LABEL[supplier.plan]||supplier.plan}</span>
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
function MiTienda({supplier, contacts, onReload}) {
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
  const toggleCat = slug => set('categorias',
    form.categorias.includes(slug) ? form.categorias.filter(c=>c!==slug) : [...form.categorias, slug]);
  const addZona = () => {
    const z = zonaInput.trim();
    if (!z || form.zonas_entrega.includes(z)) { setZonaInput(''); return; }
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
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
                <div><Lbl>Ciudad</Lbl><Inp value={form.ciudad} onChange={e=>set('ciudad',e.target.value)}/></div>
                <div><Lbl>Departamento</Lbl><Inp value={form.departamento} onChange={e=>set('departamento',e.target.value)}/></div>
              </div>
              <div>
                <Lbl>Categorías</Lbl>
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
              </div>
              <div>
                <Lbl>Zonas de entrega</Lbl>
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
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12}}>
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
                <Lbl>Banner</Lbl>
                <div style={{borderRadius:10,border:`1px solid ${C.border}`,overflow:'hidden',background:C.bg,height:80,display:'flex',alignItems:'center',justifyContent:'center',marginBottom:8}}>
                  {supplier.banner_url
                    ? <img src={supplier.banner_url} alt="banner" style={{width:'100%',height:'100%',objectFit:'cover'}}/>
                    : <span style={{fontSize:12,color:C.dim}}>Sin banner</span>}
                </div>
                <label className="my-btn my-btn--secondary my-btn--sm" style={{cursor:'pointer'}}>
                  {uploading==='banner'?'Subiendo…':'Cambiar banner'}
                  <input type="file" accept="image/jpeg,image/png,image/webp" style={{display:'none'}}
                         onChange={e=>{ uploadImage('banner', e.target.files?.[0]); e.target.value=''; }}/>
                </label>
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
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div>
            <Lbl>Categoría</Lbl>
            <Sel value={f.categoria_slug} onChange={e=>set('categoria_slug',e.target.value)}>
              <option value="">Sin categoría</option>
              {cats.map(c => <option key={c.slug} value={c.slug}>{c.nombre}</option>)}
            </Sel>
          </div>
          <div><Lbl>Marca</Lbl><Inp value={f.marca} onChange={e=>set('marca',e.target.value)}/></div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div><Lbl>Presentación</Lbl><Inp value={f.presentacion} onChange={e=>set('presentacion',e.target.value)} placeholder="Ej: caja 20 kg"/></div>
          <div>
            <Lbl>Unidad</Lbl>
            <Sel value={f.unidad} onChange={e=>set('unidad',e.target.value)}>
              <option value="">Sin unidad</option>
              {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
            </Sel>
          </div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div>
            <Lbl>Modo de precio</Lbl>
            <Sel value={f.precio_tipo} onChange={e=>set('precio_tipo',e.target.value)}>
              {Object.entries(PRECIO_TIPO).map(([k,v]) => <option key={k} value={k}>{v}</option>)}
            </Sel>
          </div>
          <div>
            <Lbl>Precio (₲)</Lbl>
            <Inp type="number" min="0" step="1000" value={f.precio} onChange={e=>set('precio',e.target.value)}
                 disabled={f.precio_tipo==='cotizar'} placeholder={f.precio_tipo==='cotizar'?'A cotizar':'Ej: 380000'}/>
          </div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div><Lbl>Pedido mínimo</Lbl><Inp value={f.pedido_minimo} onChange={e=>set('pedido_minimo',e.target.value)} placeholder="Ej: 1 caja"/></div>
          <div><Lbl>Disponibilidad</Lbl><Inp value={f.disponibilidad} onChange={e=>set('disponibilidad',e.target.value)} placeholder="En stock / A pedido"/></div>
        </div>
        <div><Lbl>Etiquetas (separadas por coma)</Lbl><Inp value={f.etiquetas} onChange={e=>set('etiquetas',e.target.value)} placeholder="premium, congelado, sin gluten"/></div>
        <div><Lbl>Descripción</Lbl><Txt rows={2} value={f.descripcion} onChange={e=>set('descripcion',e.target.value)}/></div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,alignItems:'end'}}>
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

function Catalogo({supplier}) {
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
  return (
    <div className="page">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:18,flexWrap:'wrap',gap:10}}>
        <div>
          <div style={{fontSize:18,fontWeight:800,color:C.ink,marginBottom:4}}>Catálogo</div>
          <div style={{fontSize:12,color:C.mid}}>Los productos publicados aparecen en el marketplace para todos los restaurantes</div>
        </div>
        <Btn small onClick={()=>setEditing({})}>Nuevo producto</Btn>
      </div>

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
                          <div style={{fontWeight:700}}>{p.nombre}</div>
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
              <label className="my-btn my-btn--secondary my-btn--sm" style={{cursor:'pointer'}}>
                {uploadingFile?'Subiendo…':'Subir archivo'}
                <input type="file" accept=".pdf,.xls,.xlsx,image/jpeg,image/png,image/webp" style={{display:'none'}}
                       onChange={e=>{ uploadCatalogFile(e.target.files?.[0]); e.target.value=''; }}/>
              </label>
            }>
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
function Solicitudes({onNuevasChange}) {
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
    load();
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
                  <Td><span style={{fontWeight:700}}>{restInfo[l.id]?.name||'Restaurante'}</span></Td>
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
              <div style={{fontSize:14,fontWeight:700,color:C.ink}}>{restInfo[detail.id]?.name||'Restaurante'}</div>
              {restInfo[detail.id]?.address && <div style={{fontSize:12,color:C.mid}}>{restInfo[detail.id].address}</div>}
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
              <div><Lbl>Fecha</Lbl><div style={{fontSize:13,color:C.ink}}>{fmtDT(detail.created_at)}</div></div>
              <div><Lbl>Estado</Lbl><Badge color={lc[detail.estado]||C.mid}>{LEAD_ESTADO[detail.estado]||detail.estado}</Badge></div>
            </div>
            {detail.tipo==='cotizacion' && (
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12}}>
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
              <Btn variant="secondary" small onClick={()=>toast('Mensajería disponible próximamente (Fase 2)')}>Responder</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   MENSAJES (placeholder — chat en Fase 2)
   ════════════════════════════════════════════════════════════════════ */
function Mensajes() {
  return (
    <div className="page" style={{display:'flex',alignItems:'center',justifyContent:'center',minHeight:'60vh'}}>
      <div style={{maxWidth:420,textAlign:'center'}}>
        <div style={{width:64,height:64,borderRadius:'50%',border:`1.5px solid ${C.border}`,display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 18px',color:C.dim}}>
          <Icon name="chat" size={26}/>
        </div>
        <div style={{fontSize:18,fontWeight:800,color:C.ink,marginBottom:8}}>Mensajería con restaurantes</div>
        <div style={{fontSize:13,color:C.mid,lineHeight:1.6}}>
          Disponible próximamente. Las cotizaciones que recibís ya crean la conversación:
          cuando activemos el chat vas a poder responderlas desde acá.
        </div>
      </div>
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
  const [section, setSection] = useState('inicio');
  const [nuevas, setNuevas] = useState(0);
  const [themeMode, setThemeMode] = useState(window.MythosTheme ? window.MythosTheme.get() : 'light');
  const [, force] = useState(0);

  useEffect(() => {
    const fn = e => { setThemeMode(e.detail.mode); force(x=>x+1); };
    document.addEventListener('mythos:themechange', fn);
    return () => document.removeEventListener('mythos:themechange', fn);
  }, []);

  // badge de solicitudes nuevas (poll liviano, aparte del de la sección)
  useEffect(() => {
    if (!db || !supplierId) return;
    let on = true;
    const check = async () => {
      if (_shouldPause()) return;
      const { count } = await db.from('marketplace_leads').select('id',{count:'exact',head:true}).eq('estado','nueva');
      if (on && typeof count === 'number') setNuevas(count);
    };
    check();
    const id = setInterval(check, 30000);
    return () => { on = false; clearInterval(id); };
  }, [supplierId]);

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
    {key:'mensajes',    label:'Mensajes',    icon:'chat'},
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
        {section==='inicio'      && <Inicio supplier={supplier} onJump={setSection}/>}
        {section==='tienda'      && <MiTienda supplier={supplier} contacts={contacts} onReload={reload}/>}
        {section==='catalogo'    && <Catalogo supplier={supplier}/>}
        {section==='solicitudes' && <Solicitudes onNuevasChange={setNuevas}/>}
        {section==='mensajes'    && <Mensajes/>}
      </main>

      <ToastContainer/>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App/>);
