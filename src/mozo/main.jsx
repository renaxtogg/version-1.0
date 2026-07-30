// ════════════════════════════════════════════════════════════════════
// PR-5 — Panel mozo precompilado con Vite (batch de migración legacy).
// Migrado 1:1 desde el <script type="text/babel"> inline de public/mozo.html.
// Sin cambios de comportamiento ni de UI. React/createRoot vienen de npm
// (bundle Vite); el resto de globales del shell siguen en window.* (config.js,
// supabase UMD, MythosTheme/Icons/Presence/Session/Gating, XLSX, Leaflet, etc.).
// ════════════════════════════════════════════════════════════════════
import React from "react";
import { createRoot } from "react-dom/client";
// FASE D2 — foto del comprobante en el cobro + validación del pago (mig 182).
import { ComprobanteUploader, ProofImage, reviewMeta, recordPaymentReview } from "../shared/comprobante.jsx";

// PR-5 (Bug A): mythos-gating.js es un script global legacy que usa React global
// (window.React). Tras bundlear React por panel con Vite ya no existe como global y
// useCapabilities() rompía con "React is not defined". Reexponemos la MISMA instancia de
// React (la del bundle) para el script global; NO se reintroduce React por CDN.
window.React = React;

const { useState, useEffect, useRef, useCallback, useMemo } = React;

/* ── Icon (SVG inline de mythos-icons.js, hereda color/tamaño) — WS5 ── */
const Icon = ({ name, size = 16, style }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0, ...(style || {}) }}
        dangerouslySetInnerHTML={{ __html: window.MythosIcons ? window.MythosIcons.html(name, { size }) : '' }} />
);

/* ── SUPABASE ── */
const _initDB = () => {
  const cfg = window.SUPABASE_CONFIG;
  if (!cfg || !cfg.url || !cfg.anonKey) return null;
  const url = cfg.url.replace(/^﻿/, '').trim();
  const key = cfg.anonKey.replace(/^﻿/, '').trim();
  if (!url || url.includes('YOUR_') || !key) return null;
  try { return window.supabase.createClient(url, key); } catch(e) { return null; }
};
const db = _initDB();
// Multi-tenant Engine: el comercio se resuelve desde la sesión activa (localStorage), sin UUID hardcodeado.
// Superadmin launcher (superadmin → Paneles): puede fijar el local por ?r= para verlo/operarlo
// con su bypass de RLS (mig 088). SOLO aplica al superadmin; cualquier otro rol ignora ?r=.
const _SUPER_RID = (function(){ try {
  if ((localStorage.getItem('mythos_role')||'').trim() !== 'superadmin') return null;
  return (new URLSearchParams(window.location.search).get('r')||'').trim() || null;
} catch(_) { return null; } })();
const RESTAURANT_ID = _SUPER_RID || localStorage.getItem('mythos_restaurant_id');
const RID = RESTAURANT_ID; // alias retro-compatible con consultas/suscripciones existentes

/* ── UTILS ── */
const fGs = n => '₲ ' + Math.round(n || 0).toLocaleString('es-PY');
// El selector de cobro usa el dominio de movimientos_caja.metodo_pago
// (efectivo/tarjeta_credito/tarjeta_debito/qr) para entrar al arqueo vía la RPC.
// orders.payment_method tiene OTRO CHECK ('efectivo','tarjeta','qr','pos','pos_mesa','transferencia'):
// para escribirlo en el cobro clásico mapeamos igual que la RPC cobro_mesa_parcial.
const mapOrderPM = m =>
  /^tarjeta/.test(m || '') ? 'tarjeta'
  : (m === 'mixto' || m === 'gift_card' || m === 'cuenta_corriente') ? 'pos'
  : (m || 'efectivo');
const PROMO_TYPE_LABEL = {
  '2x1': '2×1',
  '3x2': '3×2',
  'happy_hour': 'Happy Hour',
  'combo': 'Combo',
  'descuento': 'Descuento',
  'destacado': 'Destacado',
  'chef': 'Chef ★',
};
function promoLabel(item) {
  if (item.promo_tag) return item.promo_tag;
  if (item.discount_pct > 0) return `−${item.discount_pct}%`;
  if (item.promo_type) return PROMO_TYPE_LABEL[item.promo_type] || item.promo_type;
  return null;
}
function effectivePrice(item) {
  const base = Number(item.price_guarani || 0);
  if (item.discount_pct > 0) return Math.round(base * (1 - item.discount_pct / 100));
  return base;
}
const timeStr = dt => new Date(dt).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
const minAgo = dt => Math.floor((Date.now() - new Date(dt)) / 60000);

/* ── STATUS ──
 * lista (verde, RETIRAR) = cocina marcó listo o despachó pero el mozo aún
 *   no llevó la comida a la mesa (delivered_to_table_at === null).
 * pendiente_pago (naranja, COBRO PTE) = comida ya en la mesa y el cliente
 *   solicitó cuenta (payment_method seteado).
 * ocupada (negro) = comida ya entregada y/o ya cobrada; mesa en servicio
 *   sin acción pendiente del mozo. */
function getMesaStatus(tableId, ordersMap, callsMap, tablesById) {
  if (callsMap[tableId]) return 'alerta';
  const order = ordersMap[tableId];
  const tbl = tablesById && tablesById[tableId];
  const occupied = (tbl ? tbl.is_occupied : false) || !!order;
  if (!occupied) return 'libre';
  if (!order) return 'ocupada';
  if (order.status === 'ready') return 'lista';
  if (order.status === 'pending_payment') {
    // Cocina despachó pero el mozo todavía no confirmó entrega física
    if (!order.delivered_to_table_at) return 'lista';
    // Ya en mesa: pendiente cobro sólo si no está pagado
    if (order.payment_status === 'paid') return 'ocupada';
    if (order.payment_method) return 'pendiente_pago';
    return 'ocupada';
  }
  if (order.status === 'cooking' || order.status === 'kitchen_received') return 'cocina';
  return 'ocupada';
}

const fGsK = n => '₲ ' + (n >= 1000000 ? (n/1000000).toFixed(1)+'M' : n >= 1000 ? Math.round(n/1000)+'k' : String(Math.round(n||0)));

function statusLabel(s) {
  return { libre: 'Libre', ocupada: 'Ocupada', cocina: 'En cocina', lista: 'Retirar', cuenta: 'Cuenta', alerta: 'Alerta', pendiente_pago: 'Cobro pte.', reservada: 'Reservada', alerta_reserva: '¡Liberar!' }[s] || s;
}

/* ── RESERVATION HELPERS ──
 * Una reserva está "activa" si:
 *   - status = 'confirmed'
 *   - reservation_date = hoy
 *   - está dentro de [now - 15min de tolerancia, now + window_hours]
 * Devuelve un map { table_id → { reservation, _timeMs, _alertMinutes, _minutesUntil } }
 * Solo incluye reservas con table_id asignada.
 */
function buildReservationByTable(reservations, nowMs, windowHours, alertMinutes) {
  const map = {};
  const today = new Date(nowMs);
  const todayStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
  const winMs = windowHours * 3600 * 1000;
  const tolMs = 15 * 60 * 1000; // 15min de tolerancia tras la hora reservada
  (reservations || []).forEach(r => {
    if (r.status !== 'confirmed') return;
    if (r.reservation_date !== todayStr) return;
    if (!r.table_id) return;
    const t = (r.reservation_time || '00:00:00').slice(0, 8);
    const resMs = new Date(`${r.reservation_date}T${t.length === 5 ? t + ':00' : t}`).getTime();
    if (isNaN(resMs)) return;
    const dt = resMs - nowMs;
    if (dt > winMs) return;         // muy lejos en el futuro
    if (dt < -tolMs) return;        // ya pasó la tolerancia
    map[r.table_id] = {
      reservation: r,
      _timeMs: resMs,
      _alertMinutes: alertMinutes,
      _minutesUntil: Math.round(dt / 60000),
    };
  });
  return map;
}

function applyReservationOverride(baseStatus, tableId, reservationByTable) {
  const r = reservationByTable && reservationByTable[tableId];
  if (!r) return baseStatus;
  if (baseStatus !== 'libre' && r._minutesUntil <= r._alertMinutes) return 'alerta_reserva';
  if (baseStatus === 'libre') return 'reservada';
  return baseStatus;
}

/* ══════════════════════════════════════════════
   MAPA DE ZONAS — componentes compartidos mozo
══════════════════════════════════════════════ */
const ZONAS_DEF_M=[
  {value:'salon',    label:'Salón',    bg:'#F0F7FF',border:'#BFDBFE',dot:'#3B82F6'},
  {value:'terraza',  label:'Terraza',  bg:'#F0FFF4',border:'#BBF7D0',dot:'#22C55E'},
  {value:'bar',      label:'Bar',      bg:'#FFF7ED',border:'#FED7AA',dot:'#F97316'},
  {value:'privado',  label:'Privado',  bg:'#FDF4FF',border:'#E9D5FF',dot:'#A855F7'},
  {value:'exterior', label:'Exterior', bg:'#FEFCE8',border:'#FEF08A',dot:'#EAB308'},
];
const SHAPES_DEF_M=[{value:'square',label:'Cuadrada',icon:'□'},{value:'round',label:'Redonda',icon:'○'},{value:'rectangle',label:'Rectangular',icon:'▬'}];
const CELL_M=70; const GAP_M=10;
// Coordenadas virtuales 0-1000 (compartido con admin y caja)
const VCOORD_MAX_M=1000;
const CANVAS_ASPECT_M=0.55;
function tdM(shape){if(shape==='rectangle')return{w:Math.round(CELL_M*1.55),h:Math.round(CELL_M*0.65)};return{w:CELL_M,h:CELL_M};}
function tbrM(shape){if(shape==='round')return'50%';if(shape==='rectangle')return 6;return 8;}
function defaultVPosM(idx,total){
  const cols=Math.min(Math.max(Math.ceil(Math.sqrt(Math.max(total,1))),3),6);
  const rows=Math.max(Math.ceil(total/cols),1);
  const col=idx%cols, row=Math.floor(idx/cols);
  const stepX=VCOORD_MAX_M/cols, stepY=VCOORD_MAX_M/Math.max(rows,1);
  return{vx:col*stepX+stepX/2,vy:row*stepY+stepY/2};
}
function vToPxM(vx,vy,cw,ch,tw,th){
  const cx=(vx/VCOORD_MAX_M)*cw, cy=(vy/VCOORD_MAX_M)*ch;
  return{x:Math.max(0,Math.min(cw-tw,cx-tw/2)),y:Math.max(0,Math.min(ch-th,cy-th/2))};
}
function pxToVM(px,py,cw,ch,tw,th){
  const cx=px+tw/2, cy=py+th/2;
  return{vx:Math.max(0,Math.min(VCOORD_MAX_M,(cx/Math.max(cw,1))*VCOORD_MAX_M)),vy:Math.max(0,Math.min(VCOORD_MAX_M,(cy/Math.max(ch,1))*VCOORD_MAX_M))};
}
const SC_M={
  libre:{bg:'#FFFFFF',bd:'#D2D2D7',tx:'#000000'},
  ocupada:{bg:'#1D1D1F',bd:'#1D1D1F',tx:'#FFFFFF'},
  cocina:{bg:'#555555',bd:'#555555',tx:'#FFFFFF'},
  lista:{bg:'#34C759',bd:'#248A3D',tx:'#FFFFFF'},
  pendiente_pago:{bg:'#FF9500',bd:'#B45309',tx:'#FFFFFF'},
  alerta:{bg:'#FFF0F0',bd:'#FF3B30',tx:'#CC0000'},
  reservada:{bg:'#FFF7ED',bd:'#FF9500',tx:'#B45309'},
  alerta_reserva:{bg:'#FEE2E2',bd:'#DC2626',tx:'#991B1B'},
};
function ZonaMozo({zona,tables,ordersMap,callsMap,tablesById,sessionTotals,reservationByTable,editMode,setTables,onTableClick,onEditTable}){
  const zd=ZONAS_DEF_M.find(z=>z.value===zona)||ZONAS_DEF_M[0];
  const canvasRef=React.useRef(null);
  const [canvasW,setCanvasW]=React.useState(0);
  const [dragging,setDragging]=React.useState(null);
  const dragOffRef=React.useRef({x:0,y:0});
  const movedRef=React.useRef(false);
  React.useEffect(()=>{
    if(!canvasRef.current)return;
    const update=()=>{if(canvasRef.current)setCanvasW(canvasRef.current.offsetWidth);};
    update();
    const ro=new ResizeObserver(update);
    ro.observe(canvasRef.current);
    return()=>ro.disconnect();
  },[]);
  const canvasH=Math.max(Math.round(canvasW*CANVAS_ASPECT_M),180);

  function onPointerDown(e,t){
    if(!editMode)return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const rect=e.currentTarget.getBoundingClientRect();
    dragOffRef.current={x:e.clientX-rect.left,y:e.clientY-rect.top};
    movedRef.current=false;
    setDragging(t.id);
  }
  function onPointerMove(e){
    if(!dragging||!canvasRef.current)return;
    e.preventDefault();
    const cr=canvasRef.current.getBoundingClientRect();
    const t=tables.find(x=>x.id===dragging);
    if(!t)return;
    const{w,h}=tdM(t.shape||'square');
    const px=Math.max(0,Math.min(cr.width-w,e.clientX-cr.left-dragOffRef.current.x));
    const py=Math.max(0,Math.min(cr.height-h,e.clientY-cr.top-dragOffRef.current.y));
    const{vx,vy}=pxToVM(px,py,cr.width,cr.height,w,h);
    movedRef.current=true;
    setTables(prev=>prev.map(x=>x.id===dragging?{...x,pos_x:vx,pos_y:vy}:x));
  }
  async function onPointerUp(){
    if(!dragging)return;
    const t=tables.find(x=>x.id===dragging);
    const wasMoved=movedRef.current;
    setDragging(null);
    if(t&&db&&wasMoved){
      await db.from('tables').update({pos_x:Math.round(t.pos_x),pos_y:Math.round(t.pos_y)}).eq('id',t.id);
    }
  }

  return(
    <div style={{marginBottom:20}}>
      <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:6,padding:'0 16px'}}>
        <div style={{width:7,height:7,borderRadius:'50%',background:zd.dot}}/>
        <div style={{fontSize:11,fontWeight:700,color:'#3D3D3D',textTransform:'uppercase',letterSpacing:'0.5px'}}>{zd.label}</div>
        <div style={{fontSize:10,color:'#86868B'}}>· {tables.length} {tables.length===1?'mesa':'mesas'}</div>
      </div>
      <div ref={canvasRef} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        style={{position:'relative',width:'100%',maxWidth:560,height:canvasH,background:zd.bg,border:`1.5px solid ${zd.border}`,overflow:'hidden',touchAction:editMode?'none':'auto'}}>
        {tables.length===0&&<div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',color:'#C0C0C0',fontSize:12}}>Sin mesas en {zd.label.toLowerCase()}</div>}
        {canvasW>0 && tables.map((t,idx)=>{
          const shape=t.shape||'square';
          const{w,h}=tdM(shape);
          const br=tbrM(shape);
          const hasPos=t.pos_x!=null&&t.pos_y!=null;
          const v=hasPos?{vx:t.pos_x,vy:t.pos_y}:defaultVPosM(idx,tables.length);
          const pos=vToPxM(v.vx,v.vy,canvasW,canvasH,w,h);
          const baseStatus=getMesaStatus(t.id,ordersMap,callsMap,tablesById);
          const status=applyReservationOverride(baseStatus,t.id,reservationByTable);
          const sesTotal=sessionTotals[t.id]||0;
          const sc=SC_M[status]||SC_M.libre;
          const resv=reservationByTable&&reservationByTable[t.id];
          const isDrag=dragging===t.id;
          return(
            <div key={t.id}
              onPointerDown={e=>onPointerDown(e,t)}
              onClick={()=>{
                if(movedRef.current){ movedRef.current=false; return; }
                editMode?onEditTable(t):onTableClick(t.id);
              }}
              style={{position:'absolute',left:pos.x,top:pos.y,width:w,height:h,
                background:sc.bg,border:`2px solid ${sc.bd}`,borderRadius:br,
                display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',
                cursor:editMode?'grab':'pointer',userSelect:'none',touchAction:editMode?'none':'auto',
                transition:isDrag?'none':'box-shadow .15s',
                boxShadow:isDrag?'0 8px 24px rgba(0,0,0,0.22)':(status==='libre'?'0 1px 3px rgba(0,0,0,0.07)':'0 2px 8px rgba(0,0,0,0.18)'),
                zIndex:isDrag?10:1,
              }}>
              {sesTotal>0&&<div style={{fontSize:7,color:sc.tx==='#000000'?'#22C55E':'rgba(255,255,255,0.85)',fontWeight:700,lineHeight:1,marginBottom:1}}>{fGsK(sesTotal)}</div>}
              <div style={{fontSize:shape==='rectangle'?13:15,fontWeight:800,color:sc.tx,lineHeight:1}}>{t.number}</div>
              <div style={{fontSize:7,color:sc.tx==='#000000'?'#86868B':sc.tx,marginTop:2,fontWeight:status==='alerta_reserva'?800:500}}>{statusLabel(status)}</div>
              {(status==='reservada'||status==='alerta_reserva')&&resv&&(
                <div style={{fontSize:7,color:sc.tx,marginTop:1,fontWeight:700}}>{resv.reservation.reservation_time?.slice(0,5)} · {resv.reservation.guests}p</div>
              )}
              {status!=='reservada'&&status!=='alerta_reserva'&&<div style={{fontSize:7,color:sc.tx==='#000000'?'#86868B':'rgba(255,255,255,0.5)',marginTop:1}}>{t.capacity||4}p</div>}
              {editMode&&<div style={{position:'absolute',top:3,right:4,fontSize:8,color:'#86868B'}}>✎</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MesaEditModalM({table,onSave,onClose}){
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
    if(error)return;
    onSave();
  }
  async function del(){
    if(!window.confirm(`¿Eliminar Mesa ${table.number}?`))return;
    await db.from('tables').delete().eq('id',table.id);
    onSave();
  }
  return(
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.55)',zIndex:200,display:'flex',alignItems:'flex-end',justifyContent:'center'}} onClick={onClose}>
      <div style={{background:'var(--surface)',borderRadius:'16px 16px 0 0',padding:24,width:'100%',maxWidth:480}} onClick={e=>e.stopPropagation()}>
        <div style={{fontSize:16,fontWeight:800,marginBottom:20,color:'var(--text)'}}>Editar Mesa {table.number}</div>
        <div className="my-row-2" style={{gap:12,marginBottom:16}}>
          <div>
            <div style={{fontSize:10,color:'var(--text2)',fontWeight:700,marginBottom:5}}>NÚMERO</div>
            <input type="number" value={form.number} onChange={e=>setForm(f=>({...f,number:e.target.value}))} style={{width:'100%',padding:'9px 11px',fontSize:14,borderRadius:6,border:'1px solid var(--border)',background:'var(--bg2)',color:'var(--text)'}}/>
          </div>
          <div>
            <div style={{fontSize:10,color:'var(--text2)',fontWeight:700,marginBottom:5}}>CAPACIDAD (pax)</div>
            <input type="number" value={form.capacity} onChange={e=>setForm(f=>({...f,capacity:e.target.value}))} style={{width:'100%',padding:'9px 11px',fontSize:14,borderRadius:6,border:'1px solid var(--border)',background:'var(--bg2)',color:'var(--text)'}}/>
          </div>
        </div>
        <div style={{marginBottom:14}}>
          <div style={{fontSize:10,color:'var(--text2)',fontWeight:700,marginBottom:6}}>ZONA</div>
          <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
            {ZONAS_DEF_M.map(z=>(
              <button key={z.value} type="button" onClick={()=>setForm(prev=>({...prev,zona:z.value}))}
                style={{padding:'5px 12px',borderRadius:20,border:`1.5px solid ${form.zona===z.value?'var(--accent)':'var(--border)'}`,background:form.zona===z.value?'var(--accent)':'transparent',color:form.zona===z.value?'var(--bg)':'var(--text)',fontSize:12,cursor:'pointer',fontWeight:form.zona===z.value?700:400}}>
                {z.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{marginBottom:20}}>
          <div style={{fontSize:10,color:'var(--text2)',fontWeight:700,marginBottom:6}}>FORMA</div>
          <div style={{display:'flex',gap:8}}>
            {SHAPES_DEF_M.map(s=>(
              <button key={s.value} type="button" onClick={()=>setForm(prev=>({...prev,shape:s.value}))}
                style={{flex:1,padding:'10px 6px',borderRadius:8,border:`2px solid ${form.shape===s.value?'var(--accent)':'var(--border)'}`,background:form.shape===s.value?'var(--accent)':'transparent',color:form.shape===s.value?'var(--bg)':'var(--text)',fontSize:11,cursor:'pointer',fontWeight:600,textAlign:'center',display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
                <span style={{fontSize:18,pointerEvents:'none'}}>{s.icon}</span><span style={{pointerEvents:'none'}}>{s.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div style={{display:'flex',gap:8}}>
          <button onClick={save} disabled={saving} style={{flex:1,padding:'12px',background:'var(--accent)',color:'var(--bg)',border:'none',borderRadius:8,fontSize:14,fontWeight:700,cursor:'pointer'}}>{saving?'Guardando…':'Guardar'}</button>
          <button onClick={onClose} style={{padding:'12px 18px',background:'transparent',color:'var(--text2)',border:'1px solid var(--border)',borderRadius:8,fontSize:14,fontWeight:600,cursor:'pointer'}}>Cancelar</button>
          <button onClick={del} style={{padding:'12px 18px',background:'rgba(239,68,68,0.1)',color:'#FF3B30',border:'1px solid rgba(239,68,68,0.3)',borderRadius:8,fontSize:14,fontWeight:600,cursor:'pointer'}}>Eliminar</button>
        </div>
      </div>
    </div>
  );
}

function orderStatusText(status, paymentStatus) {
  if (paymentStatus === 'paid') return 'Cobrado';
  return {
    paid: 'En cocina', kitchen_received: 'En cocina',
    cooking: 'Preparando', ready: 'Listo', delivered: 'Entregado',
    pending_payment: 'A cobrar'
  }[status] || status;
}

function orderStatusClass(status) {
  if (status === 'ready') return 'lista';
  return '';
}

/* ── AUDIO — init on first user tap, reuse context ── */
let _audioCtx = null;
function initAudio() {
  if (!_audioCtx) {
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
  } else if (_audioCtx.state === 'suspended') {
    _audioCtx.resume().catch(() => {});
  }
}
function playAlertSound() {
  try {
    const ctx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
  } catch(e) {}
}
function vibrateDevice() {
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}

/* ── APP ── */
function App() {
  const [tables, setTables] = useState([]);
  const [ordersMap, setOrdersMap] = useState({});
  const [waiterCalls, setWaiterCalls] = useState([]);
  const [callsMap, setCallsMap] = useState({});
  const [broadcasts, setBroadcasts]         = useState([]);
  const lastSeenBroadcasts                  = useRef(parseInt(localStorage.getItem('mozo_bc_seen') || '0'));
  const [menu, setMenu] = useState([]);
  const [categories, setCategories] = useState([]);
  const [extrasMap, setExtrasMap] = useState({});

  const [currentView, setCurrentView] = useState(() => localStorage.getItem('mozo_view') || 'mesas');
  const [activeTableId, setActiveTableId] = useState(() => localStorage.getItem('mozo_tableId') || null);

  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [dark, setDark] = useState(() => (window.MythosTheme ? window.MythosTheme.get() : 'light') === 'dark');
  // Multi-tenant Engine: fail-safe — sin tenant en sesión, limpia y expulsa al login (salvo superadmin).
  useEffect(() => {
    if ((!RESTAURANT_ID || !RESTAURANT_ID.trim()) && localStorage.getItem('mythos_role') !== 'superadmin') {
      localStorage.clear();
      window.location.href = '/login.html';
    }
  }, []);
  useEffect(() => {
    const onTheme = e => setDark(e.detail.mode === 'dark');
    document.addEventListener('mythos:themechange', onTheme);
    return () => document.removeEventListener('mythos:themechange', onTheme);
  }, []);
  const [alertPopup, setAlertPopup] = useState(null);
  const [sessionTotals, setSessionTotals] = useState({});
  const [historialModal, setHistorialModal] = useState(false);
  const [historialOrders, setHistorialOrders] = useState([]);
  const [loadingHistorial, setLoadingHistorial] = useState(false);
  const [reservationsToday, setReservationsToday] = useState([]);
  const [reservationConfig, setReservationConfig] = useState({ window: 3, alertMin: 30 });
  const [nowTick, setNowTick] = useState(Date.now());

  // Turno: start from localStorage or midnight today
  const turnoInicio = useMemo(() => {
    const saved = localStorage.getItem('turno_inicio');
    if (saved) return saved;
    const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString();
  }, []);
  const [turnoOrders, setTurnoOrders] = useState([]);
  const [loadingTurno, setLoadingTurno] = useState(false);

  // Modals
  const [productModal, setProductModal] = useState(false);
  const [cobroModal, setCobroModal] = useState(false);
  const [invoiceType, setInvoiceType] = useState('none'); // 'none'|'ticket'|'fiscal'
  const [invoiceDelivery, setInvoiceDelivery] = useState('print'); // 'print' | 'email'
  const [invName, setInvName] = useState('');
  const [invRuc, setInvRuc] = useState('');
  const [invEmail, setInvEmail] = useState('');
  const [mesaDialog, setMesaDialog] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  // Nº de comprobante/operación (opcional) al cobrar con tarjeta o transferencia (mig 180)
  const [comprobante, setComprobante] = useState('');
  // Foto del comprobante (opcional) — mig 182
  const [proofUrl, setProofUrl] = useState('');
  // Datos de transferencia del comercio (para mostrar al cobrar por QR/transferencia — mig 180)
  const [bankInfo, setBankInfo] = useState(null);
  // Exigir comprobante en transferencia/QR (mig 182 · require_proof). NULL = no exige (fail-open).
  const [requireProof, setRequireProof] = useState(false);
  useEffect(() => {
    if (!db || !RID) return;
    db.from('restaurants')
      .select('bank_holder,bank_name,bank_account,bank_alias,bank_doc,bank_qr_url,delivery_config')
      .eq('id', RID).maybeSingle()
      .then(r => {
        const d = (r && r.data) || null;
        setBankInfo(d);
        setRequireProof(!!(d && d.delivery_config && d.delivery_config.require_proof));
      }).catch(() => {});
  }, []);

  // Mapa de zonas
  const [mesaViewMode, setMesaViewMode] = useState(() => localStorage.getItem('mozo_mesa_view') || 'grid');
  const [tableScope, setTableScope] = useState(() => localStorage.getItem('mozo_table_scope') || 'all');
  const [mapaEditMode, setMapaEditMode] = useState(false);
  const [mesaFormModal, setMesaFormModal] = useState(null);

  // Product selection
  const [selectedProducts, setSelectedProducts] = useState({});
  const [productSearch, setProductSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('Todos');
  const [itemNotes, setItemNotes] = useState({});
  const [itemExtras, setItemExtras] = useState({});

  // Payment
  const [tipPct, setTipPct] = useState(0);
  const [payMethod, setPayMethod] = useState('efectivo');

  // All orders for active table (FIX #4) + cobro items (FIX #5)
  const [tableOrders, setTableOrders] = useState([]);
  const [cobroItems, setCobroItems] = useState([]);
  const [cobroRealTotal, setCobroRealTotal] = useState(0);
  const [dividirPersonas, setDividirPersonas] = useState(2);
  const [fraccionStates, setFraccionStates] = useState({});
  // Cobro por ítem (mig 128) + entrada al arqueo de caja (RPC cobro_mesa_parcial)
  const [cobroItemSel, setCobroItemSel] = useState({}); // { [itemId]: { checked, qty } }
  const [openTurnos, setOpenTurnos] = useState([]);      // turnos_caja abiertos del restaurante
  const [cajasActivas, setCajasActivas] = useState([]);  // cajas activas (para el nombre en el selector)
  const [selTurnoId, setSelTurnoId] = useState(null);    // caja/turno elegido para rendir el cobro
  const [cobroBusy, setCobroBusy] = useState(false);
  const [partialOn, setPartialOn] = useState(true);      // mig 128 presente (paid_quantity + RPC) → cobro por ítem

  // Mozo session
  const [mozoSession, setMozoSession] = useState(() => {
    try { return JSON.parse(localStorage.getItem('mozo_session') || 'null'); } catch(e) { return null; }
  });
  // WS2-B · El panel solo monta cuando el guard de rol confirmó (fail-closed).
  const [authOk, setAuthOk] = useState(false);

  const [transferNotifPopup, setTransferNotifPopup] = useState(null);

  const toastTimer = useRef(null);
  const alertTimer = useRef(null);
  const transferAlertTimer = useRef(null);
  const loadDataRef = useRef(null);
  const loadTableOrdersRef = useRef(null);
  const loadCobroItemsRef = useRef(null);
  const cobroModalRef = useRef(false);
  const activeTableIdRef = useRef(activeTableId);
  const knownCallIds = useRef(new Set());
  const knownTransferCallIds = useRef(new Set());
  const knownReadyIds = useRef(new Set());
  const knownPendPayIds = useRef(new Set());
  const [itemEditId, setItemEditId] = useState(null);
  const [itemEditNote, setItemEditNote] = useState('');

  // Transferencia de mesas
  const [transferModal, setTransferModal] = useState(false);
  const [transferSelectedTables, setTransferSelectedTables] = useState(new Set());
  const [transferTargetMozo, setTransferTargetMozo] = useState(null);
  const [transferMotivo, setTransferMotivo] = useState('');
  const [otrosMozos, setOtrosMozos] = useState([]);
  const [transferring, setTransferring] = useState(false);

  const pollingRef = useRef(null);
  const channelRef = useRef(null);

  // Auth + guard de rol (WS2-B): solo roles autorizados montan el panel de mozo.
  // Patrón alineado a gerente/caja/cocina: get_my_profile + allowlist, fail-closed.
  // El chequeo de rol corre SIEMPRE (aun con mozo_session cacheada en localStorage),
  // para que una sesión vieja no saltee el guard.
  useEffect(() => {
    if (!db) { window.location.replace('login.html?next=mozo.html'); return; }
    db.auth.getSession()
      .then(async ({ data: { session } }) => {
        if (!session) { window.location.replace('login.html?next=mozo.html'); return; }
        const { data: profile } = await db.rpc('get_my_profile');
        const allowed = ['mozo', 'admin', 'supervisor_local', 'superadmin'];
        if (!profile || !allowed.includes(profile.role)) {
          // Rol no autorizado / sin perfil → no montar el panel. login.html
          // reenvía a la sesión activa a su propio panel según su rol.
          try { localStorage.removeItem('mozo_session'); } catch(e) {}
          window.location.replace('login.html');
          return;
        }
        setAuthOk(true);
        // Nombre visible del mozo: SIEMPRE display_name. get_my_profile NO devuelve
        // `full_name` → leerlo daba undefined y caía al email sintético de Auth
        // `${cedula}@mythos.internal`, que se mostraba como "nombre" del mozo y se
        // propagaba a orders.waiter_name / tables.assigned_waiter_name (leak a
        // cocina/caja). Nunca usar el email de Auth como nombre.
        const goodName = profile.display_name || 'Mozo';
        if (mozoSession) {
          // Auto-sanado: sesiones viejas cacheadas con el email sintético como nombre
          // (bug histórico) se corrigen al montar, sin necesidad de re-login.
          if (!mozoSession.mozo_name || /@mythos\.internal$/i.test(mozoSession.mozo_name)) {
            const fixed = { ...mozoSession, mozo_name: goodName };
            localStorage.setItem('mozo_session', JSON.stringify(fixed));
            setMozoSession(fixed);
          }
          return;   // ya inicializado: no re-setear el resto de la sesión
        }
        const s = {
          mozo_id: session.user.id,
          mozo_name: goodName,
          turno_inicio: localStorage.getItem('turno_inicio') || new Date().toISOString()
        };
        localStorage.setItem('mozo_session', JSON.stringify(s));
        localStorage.setItem('turno_inicio', s.turno_inicio);
        setMozoSession(s);
      })
      .catch(() => { window.location.replace('login.html'); });
  }, []);

  useEffect(() => { localStorage.setItem('mozo_view', currentView); }, [currentView]);
  useEffect(() => { localStorage.setItem('mozo_mesa_view', mesaViewMode); }, [mesaViewMode]);
  useEffect(() => { localStorage.setItem('mozo_table_scope', tableScope); }, [tableScope]);
  useEffect(() => {
    if (activeTableId) localStorage.setItem('mozo_tableId', activeTableId);
    else localStorage.removeItem('mozo_tableId');
    activeTableIdRef.current = activeTableId;
  }, [activeTableId]);

  useEffect(() => { loadDataRef.current = loadData; });
  useEffect(() => { loadTableOrdersRef.current = loadTableOrders; });
  // Refrescar el modal de cobro en vivo si otra caja salda ítems (paid_quantity).
  useEffect(() => { loadCobroItemsRef.current = loadCobroItems; });
  useEffect(() => { cobroModalRef.current = cobroModal; }, [cobroModal]);

  useEffect(() => {
    // Unlock AudioContext on first user interaction
    document.addEventListener('click', initAudio, { once: true });
    document.addEventListener('touchstart', initAudio, { once: true });

    loadData();
    if (db) {
      initRealtimeSubscriptions();
      pollingRef.current = setInterval(() => loadDataRef.current?.(), 20000);
    }

    // Reconnect all channels when app returns from background (mobile fix)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && db) {
        initRealtimeSubscriptions();
        loadDataRef.current?.();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      clearInterval(pollingRef.current);
      if (channelRef.current && db) db.removeChannel(channelRef.current);
    };
  }, []);

  useEffect(() => {
    if (currentView === 'turno') loadTurnoData();
  }, [currentView]);

  // Mostramos como "orden activa de la mesa" la que necesita más atención del mozo.
  // Prioridad alta = más visible. ready/pending_payment van arriba porque requieren
  // acción inmediata (retirar de cocina o cobrar) frente a órdenes aún en preparación.
  const STATUS_PRIORITY = ['draft', 'confirmed', 'paid', 'kitchen_received', 'cooking', 'ready', 'pending_payment'];

  async function loadData() {
    if (!db) { setLoading(false); return; }
    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      const [tablesRes, ordersRes, callsRes, menuRes, extrasRes, resvRes, restRes] = await Promise.all([
        db.from('tables').select('*').eq('restaurant_id', RID).eq('is_active', true).order('number'),
        db.from('orders').select('*, order_items(*)').eq('restaurant_id', RID)
          .in('status', ['draft', 'confirmed', 'paid', 'pending_payment', 'kitchen_received', 'cooking', 'ready'])
          .order('created_at'),
        db.from('waiter_calls').select('*').eq('restaurant_id', RID).eq('status', 'pending').or('type.is.null,type.neq.payment_request').order('created_at'),
        db.from('menu_categories').select('*, menu_items(id, name, price_guarani, image_url, is_available, discount_pct, promo_tag, promo_type, sort_order)').eq('restaurant_id', RID).eq('is_active', true).order('sort_order'),
        db.from('menu_item_extras').select('*'),
        db.from('reservations').select('*').eq('restaurant_id', RID).eq('reservation_date', todayStr).eq('status', 'confirmed'),
        db.from('restaurants').select('reservation_window_hours,reservation_alert_minutes').eq('id', RID).maybeSingle(),
      ]);
      setReservationsToday(resvRes.data || []);
      if (restRes.data) {
        setReservationConfig({
          window: Number(restRes.data.reservation_window_hours ?? 3),
          alertMin: Number(restRes.data.reservation_alert_minutes ?? 30),
        });
      }

      const allTables = tablesRes.data || [];
      setTables(allTables);

      const tblById = {};
      allTables.forEach(t => { tblById[t.id] = t; });

      const om = {};
      (ordersRes.data || []).forEach(o => {
        if (!o.table_id) return;
        // Excluir órdenes de sesiones anteriores (antes del occupied_since actual)
        const tbl = tblById[o.table_id];
        if (tbl?.occupied_since && new Date(o.created_at) < new Date(tbl.occupied_since)) return;
        const existing = om[o.table_id];
        if (!existing) { om[o.table_id] = o; return; }
        const newPrio = STATUS_PRIORITY.indexOf(o.status);
        const exPrio  = STATUS_PRIORITY.indexOf(existing.status);
        if (newPrio > exPrio) om[o.table_id] = o;
        else if (newPrio === exPrio && new Date(o.created_at) > new Date(existing.created_at)) om[o.table_id] = o;
      });
      setOrdersMap(om);

      const tblNumById = {};
      allTables.forEach(t => { tblNumById[t.id] = t.number; });

      // Detect newly ready orders → alert (solo pedidos de mesa, no delivery/llevar/pickup)
      const readyOrders = (ordersRes.data || []).filter(o => o.status === 'ready' && o.table_id);
      const newReady = readyOrders.filter(o => !knownReadyIds.current.has(o.id));
      if (newReady.length > 0 && knownReadyIds.current.size > 0) {
        newReady.forEach(o => {
          const mesaNum = tblNumById[o.table_id] || '?';
          playAlertSound();
          vibrateDevice();
          showToast(`Mesa ${mesaNum} — pedido listo`);
        });
      }
      knownReadyIds.current = new Set(readyOrders.map(o => o.id));

      // Detect newly pending_payment orders → alert. Sub-casos:
      //   ya pagado (payment_status=paid) o sin payment_method = cocina despachó, mozo debe retirar
      //   payment_method seteado + no pagado = cliente eligió método y solicitó la cuenta
      const pendPayOrders = (ordersRes.data || []).filter(o => o.status === 'pending_payment' && o.table_id);
      const newPendPay = pendPayOrders.filter(o => !knownPendPayIds.current.has(o.id));
      if (newPendPay.length > 0 && knownPendPayIds.current.size > 0) {
        newPendPay.forEach(o => {
          const mesaNum = o.table_id ? (tblNumById[o.table_id] || '?') : '?';
          const pm = o.payment_method;
          const yaPagado = o.payment_status === 'paid';
          const pmLabel = (yaPagado || !pm)
            ? 'Listo · retirar'
            : pm === 'efectivo' ? 'Efectivo'
            : (pm === 'pos' || pm === 'tarjeta') ? 'POS/Tarjeta'
            : pm === 'qr' ? 'QR'
            : pm === 'pos_mesa' ? 'POS Mesa'
            : 'Listo · retirar';
          playAlertSound();
          vibrateDevice();
          setAlertPopup({ tableNum: mesaNum, callId: null, isPay: true, pmLabel });
          clearTimeout(alertTimer.current);
          alertTimer.current = setTimeout(() => setAlertPopup(null), 10000);
        });
      }
      knownPendPayIds.current = new Set(pendPayOrders.map(o => o.id));

      const activeTableIds = new Set([
        ...allTables.filter(t => t.is_occupied).map(t => t.id),
        ...Object.keys(om),
      ]);
      const occupiedIds = [...activeTableIds];
      if (occupiedIds.length > 0) {
        // Solo contar órdenes activas (no cobradas = no delivered+payment_method)
        const { data: sessData } = await db
          .from('orders').select('table_id, total, created_at')
          .eq('restaurant_id', RID)
          .in('table_id', occupiedIds)
          .not('status', 'in', '("cancelled")')
          .or('status.neq.delivered,payment_method.is.null')
          .neq('payment_status', 'paid');
        const st = {};
        (sessData || []).forEach(o => {
          // Filtrar por occupied_since para no acumular deudas de sesiones anteriores
          const tbl = tblById[o.table_id];
          if (tbl?.occupied_since && new Date(o.created_at) < new Date(tbl.occupied_since)) return;
          st[o.table_id] = (st[o.table_id] || 0) + Number(o.total || 0);
        });
        setSessionTotals(st);
      } else {
        setSessionTotals({});
      }

      const newCalls = callsRes.data || [];
      const tableNumById = tblNumById;
      // Separar notificaciones de transferencia del resto de llamadas
      const transferNotifCalls = newCalls.filter(c => c.type === 'table_transfer');
      const regularCalls = newCalls.filter(c => c.type !== 'table_transfer');
      const enrichedCalls = regularCalls.map(c => ({
        ...c,
        _tableNum: c.table_id ? (tableNumById[c.table_id] || '?') : null,
      }));
      const cm = {};
      enrichedCalls.forEach(c => { if (c.table_id) cm[c.table_id] = c; });
      setCallsMap(cm);
      setWaiterCalls(enrichedCalls);

      // Detect new regular waiter calls
      const incoming = enrichedCalls.filter(c => !knownCallIds.current.has(c.id));
      if (incoming.length > 0 && knownCallIds.current.size > 0) {
        const last = incoming[incoming.length - 1];
        playAlertSound();
        vibrateDevice();
        setAlertPopup({ tableNum: last._tableNum, callId: last.id });
        clearTimeout(alertTimer.current);
        alertTimer.current = setTimeout(() => setAlertPopup(null), 8000);
      }
      knownCallIds.current = new Set(enrichedCalls.map(c => c.id));

      // Detect transfer notifications directed at the current mozo
      const incomingTransfers = transferNotifCalls.filter(c => !knownTransferCallIds.current.has(c.id));
      if (incomingTransfers.length > 0 && knownTransferCallIds.current.size > 0) {
        const myName = mozoSession?.mozo_name;
        const myId = mozoSession?.mozo_id;
        incomingTransfers.forEach(c => {
          const meta = c.metadata || {};
          if (meta.target_name === myName || (myId && meta.target_id === myId)) {
            playAlertSound();
            vibrateDevice();
            setTransferNotifPopup(meta);
            clearTimeout(transferAlertTimer.current);
            transferAlertTimer.current = setTimeout(() => setTransferNotifPopup(null), 20000);
          }
        });
      }
      knownTransferCallIds.current = new Set(transferNotifCalls.map(c => c.id));

      const items = [];
      const cats = [];
      (menuRes.data || []).forEach(cat => {
        const avail = (cat.menu_items || []).filter(i => i.is_available);
        if (avail.length > 0) {
          cats.push(cat.name);
          avail.forEach(item => items.push({ ...item, cat: cat.name }));
        }
      });
      setCategories(cats);
      setMenu(items);

      // Build extras map keyed by item_id
      const em = {};
      (extrasRes.data || []).forEach(e => {
        if (!em[e.item_id]) em[e.item_id] = [];
        em[e.item_id].push(e);
      });
      setExtrasMap(em);

      setLoading(false);
    } catch(e) {
      console.error('loadData error:', e);
      setLoading(false);
    }
  }

  // Centralizes all RT subscriptions — called on mount and on visibilitychange
  function initRealtimeSubscriptions() {
    if (channelRef.current && db) {
      db.removeChannel(channelRef.current);
    }
    channelRef.current = db.channel('mozo-live')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders', filter: `restaurant_id=eq.${RID}` }, (payload) => {
        const newStatus = payload?.new?.status;
        const newPayStatus = payload?.new?.payment_status;
        const tblId = payload?.new?.table_id;
        const payMethod = payload?.new?.payment_method;
        // Sync con caja: notificar al mozo cuando se cobra (delivered desde mozo, o payment_status=paid desde caja)
        if ((newStatus === 'delivered' && payMethod && tblId) || (newPayStatus === 'paid' && tblId)) {
          if (activeTableIdRef.current === tblId) {
            // Si el mozo está cobrando por ítem, NO cerrar el modal: un pedido puede saldarse
            // sin que la mesa lo esté. processPay cierra al saldar la mesa (mesa_saldada).
            // Solo refrescamos los pendientes; si otra caja saldó todo, el modal quedará vacío.
            if (cobroModalRef.current) {
              loadCobroItemsRef.current?.(tblId);
            } else {
              setCobroModal(false);
              showToast('Mesa cobrada en caja');
            }
          }
          loadTableOrdersRef.current?.(tblId);
        }
        loadDataRef.current?.();
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders', filter: `restaurant_id=eq.${RID}` }, () => loadDataRef.current?.())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'waiter_calls', filter: `restaurant_id=eq.${RID}` }, () => loadDataRef.current?.())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tables', filter: `restaurant_id=eq.${RID}` }, () => loadDataRef.current?.())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, () => {
        loadDataRef.current?.();
        if (activeTableIdRef.current) {
          loadTableOrdersRef.current?.(activeTableIdRef.current);
          // Si el modal de cobro está abierto, refrescar paid_quantity (cobro concurrente desde caja).
          if (cobroModalRef.current) loadCobroItemsRef.current?.(activeTableIdRef.current);
        }
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'order_status_history' }, () => {
        loadDataRef.current?.();
        if (activeTableIdRef.current) loadTableOrdersRef.current?.(activeTableIdRef.current);
      })
      .subscribe();
  }

  /* Avisos del personal */
  useEffect(() => {
    if (!db) return;
    const load = async () => {
      const { data } = await db.from('staff_broadcasts')
        .select('*').eq('restaurant_id', RID)
        .overlaps('target_roles', ['mozo', 'todos', 'trabajadores'])
        .order('created_at', { ascending: false }).limit(30);
      setBroadcasts(data || []);
    };
    load();
    const ch = db.channel('bc-mozo')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'staff_broadcasts' }, () => {
        load();
        playAlertSound();
      })
      .subscribe();
    return () => db.removeChannel(ch);
  }, []);

  async function loadTurnoData() {
    if (!db) return;
    setLoadingTurno(true);
    const { data } = await db.from('orders')
      .select('id, order_number, status, payment_status, total, table_id, created_at, payment_method, paid_by_name, paid_at, waiter_name, order_items(id, item_name, quantity)')
      .eq('restaurant_id', RID)
      .gte('created_at', turnoInicio)
      .neq('status', 'cancelled')
      .order('created_at', { ascending: false });
    setTurnoOrders(data || []);
    setLoadingTurno(false);
  }

  async function loadOtrosMozos() {
    if (!db) return;
    const today = new Date().toISOString().slice(0, 10);
    const { data: ordersData } = await db.from('orders')
      .select('waiter_id, waiter_name')
      .eq('restaurant_id', RID)
      .gte('created_at', today)
      .not('waiter_name', 'is', null);

    const mozosMap = {};
    (ordersData || []).forEach(o => {
      if (!o.waiter_name) return;
      if (o.waiter_id === mozoSession?.mozo_id) return;
      if (o.waiter_name === mozoSession?.mozo_name) return;
      const key = o.waiter_id || o.waiter_name;
      mozosMap[key] = { id: o.waiter_id, name: o.waiter_name };
    });
    // También desde mesas ocupadas
    tables.forEach(t => {
      if (!t.assigned_waiter_name) return;
      if (t.assigned_waiter_name === mozoSession?.mozo_name) return;
      if (!mozosMap[t.assigned_waiter_name]) {
        mozosMap[t.assigned_waiter_name] = { id: null, name: t.assigned_waiter_name };
      }
    });
    setOtrosMozos(Object.values(mozosMap));
  }

  async function ejecutarTransferencia() {
    if (transferSelectedTables.size === 0 || !transferTargetMozo || !transferMotivo.trim()) return;
    setTransferring(true);
    const tableIds = [...transferSelectedTables];
    try {
      await db.from('tables')
        .update({ assigned_waiter_name: transferTargetMozo.name })
        .in('id', tableIds);
      for (const tid of tableIds) {
        const upd = { waiter_name: transferTargetMozo.name };
        if (transferTargetMozo.id) upd.waiter_id = transferTargetMozo.id;
        await db.from('orders')
          .update(upd)
          .eq('table_id', tid)
          .in('status', ['draft', 'confirmed', 'paid', 'kitchen_received', 'cooking', 'ready', 'pending_payment']);
      }
      // Notificar al mozo receptor vía waiter_calls con metadata
      const mesaNums = tableIds.map(tid => {
        const t = tables.find(x => x.id === tid);
        return t ? t.number : '?';
      });
      await db.from('waiter_calls').insert({
        restaurant_id: RID,
        table_id: null,
        type: 'table_transfer',
        status: 'pending',
        metadata: {
          from_name: mozoSession?.mozo_name || 'Mozo',
          from_id: mozoSession?.mozo_id,
          target_name: transferTargetMozo.name,
          target_id: transferTargetMozo.id,
          tables: mesaNums,
          motivo: transferMotivo.trim(),
        },
      });
      setTransferModal(false);
      setTransferSelectedTables(new Set());
      setTransferTargetMozo(null);
      setTransferMotivo('');
      await loadData();
      showToast(`${tableIds.length} mesa(s) transferida(s) a ${transferTargetMozo.name}`);
    } catch(e) {
      showToast('Error al transferir mesas');
    } finally {
      setTransferring(false);
    }
  }

  function openTransferModal() {
    // Pre-seleccionar mesas ocupadas del mozo actual
    const misOcupadas = new Set(
      tables
        .filter(t => {
          const st = getMesaStatus(t.id, ordersMap, callsMap, tablesById);
          return st !== 'libre';
        })
        .map(t => t.id)
    );
    setTransferSelectedTables(misOcupadas);
    setTransferTargetMozo(null);
    setTransferMotivo('');
    loadOtrosMozos();
    setTransferModal(true);
  }

  function showToast(msg) {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  }

  function toggleDark() {
    if (window.MythosTheme) window.MythosTheme.toggle();
  }

  /* ── MESA ACTIONS ── */
  function handleMesaClick(tableId) {
    const mesa = tables.find(t => t.id === tableId);
    if (!mesa) return;
    const baseStatus = getMesaStatus(tableId, ordersMap, callsMap, tablesById);
    const status = applyReservationOverride(baseStatus, tableId, reservationByTable);
    const resv = reservationByTable && reservationByTable[tableId];

    if (status === 'reservada' && resv) {
      const r = resv.reservation;
      const mins = resv._minutesUntil;
      const horaTxt = r.reservation_time?.slice(0, 5) || '';
      const tiempoTxt = mins > 0 ? `en ${mins < 60 ? mins + ' min' : Math.floor(mins/60) + 'h ' + (mins%60) + 'm'}` : `hace ${Math.abs(mins)} min`;
      setMesaDialog({
        title: `Mesa ${mesa.number} — Reservada`,
        body: `${r.customer_name} · ${r.guests} personas\nTel: ${r.customer_phone}\nHora reservada: ${horaTxt} (${tiempoTxt})${r.occasion ? '\nMotivo: ' + r.occasion : ''}${r.notes ? '\nNotas: ' + r.notes : ''}\n\nLa mesa se reserva automáticamente cuando se acerca la hora.`,
        actions: [
          { label: 'Marcar como sentada (crear orden)', primary: true, action: async () => { await markReservationSeated(r.id); createOrder(tableId, mesa.number); } },
          { label: 'Llamar al cliente', action: () => { try { window.open('tel:' + r.customer_phone, '_self'); } catch(e) {} } },
          { label: 'Liberar (no usar)', action: null },
        ],
      });
      return;
    }

    if (status === 'alerta_reserva' && resv) {
      const r = resv.reservation;
      const horaTxt = r.reservation_time?.slice(0, 5) || '';
      const mins = resv._minutesUntil;
      setMesaDialog({
        title: `Mesa ${mesa.number} — Reserva próxima`,
        body: `Esta mesa tiene una reserva a las ${horaTxt} (${mins > 0 ? 'en ' + mins + ' min' : 'pasada hace ' + Math.abs(mins) + ' min'}).\n${r.customer_name} · ${r.guests} personas · Tel: ${r.customer_phone}\n\nLa mesa sigue ocupada. Considerá pedir la cuenta al cliente actual.`,
        actions: [
          { label: 'El cliente de la reserva ya llegó — Sentar', primary: true, action: async () => { await markReservationSeated(r.id); showToast('Reserva marcada como sentada ✓'); } },
          { label: 'Ver orden actual', action: () => openOrderView(tableId) },
          { label: 'Llamar al cliente reservado', action: () => { try { window.open('tel:' + r.customer_phone, '_self'); } catch(e) {} } },
          { label: 'Cancelar', action: null },
        ],
      });
      return;
    }

    if (baseStatus === 'libre') {
      setMesaDialog({
        title: `Mesa ${mesa.number}`,
        body: 'Mesa disponible. ¿Qué deseas hacer?',
        actions: [
          { label: 'Crear nueva orden', primary: true, action: () => createOrder(tableId, mesa.number) },
          { label: 'Cancelar', action: null },
        ],
      });
    } else if (baseStatus === 'alerta') {
      setMesaDialog({
        title: `Mesa ${mesa.number} — Asistencia`,
        body: 'El cliente ha solicitado asistencia. ¿Fue atendida?',
        actions: [
          { label: 'Sí, ya la atendí', primary: true, action: () => attendCall(tableId) },
          { label: 'Ver orden', action: () => openOrderView(tableId) },
          { label: 'Cancelar', action: null },
        ],
      });
    } else {
      openOrderView(tableId);
    }
  }

  async function markReservationSeated(reservationId) {
    if (!db) return;
    try { await db.from('reservations').update({ status: 'seated' }).eq('id', reservationId); } catch(e) {}
  }

  function openOrderView(tableId) {
    setActiveTableId(tableId);
    setCurrentView('orden');
    setMesaDialog(null);
    setAlertPopup(null);
    loadTableOrders(tableId);
  }

  async function createOrder(tableId, tableNum) {
    setMesaDialog(null);
    if (!db) { showToast('Sin conexión'); return; }
    if (!tableId) { showToast('Seleccioná una mesa antes de continuar'); return; }
    // Número único: prefijo + mesa + timestamp base36 + random
    const ts = Date.now().toString(36).toUpperCase().slice(-4);
    const rnd = Math.random().toString(36).slice(-2).toUpperCase();
    const orderNum = 'W-' + tableNum + '-' + ts + rnd;

    // Verificar que el auth session es válido antes de insertar
    const { data: { session: currentSession } } = await db.auth.getSession();
    if (!currentSession) { window.location.replace('login.html'); return; }

    const insertPayload = {
      restaurant_id: RID,
      table_id: tableId,
      order_number: orderNum,
      order_type: 'local',
      status: 'confirmed',
      subtotal: 0,
      discount_amount: 0,
      total: 0,
      // waiter_id y waiter_name requieren migración 044 aplicada en Supabase
      waiter_id: currentSession.user.id,
      waiter_name: mozoSession?.mozo_name || 'Mozo',
    };

    let { data: order, error } = await db.from('orders').insert(insertPayload).select().single();

    // Si falla por columna inexistente (migración 044 pendiente), reintenta sin campos opcionales
    if (error && (error.message?.includes('waiter_id') || error.message?.includes('waiter_name') || error.message?.includes('schema cache'))) {
      const safePayload = { restaurant_id: insertPayload.restaurant_id, table_id: insertPayload.table_id, order_number: insertPayload.order_number, order_type: insertPayload.order_type, status: insertPayload.status, subtotal: 0, discount_amount: 0, total: 0 };
      const retry = await db.from('orders').insert(safePayload).select().single();
      order = retry.data;
      error = retry.error;
    }

    if (error) {
      console.error('createOrder error:', error);
      const msg = error.code === '23505' ? 'Número de orden duplicado, reintentá'
                : error.code === '23503' ? 'Error de referencia en DB'
                : error.code === '42501' ? 'Sin permisos — verificá RLS de orders'
                : `Error: ${error.message || error.code || 'desconocido'}`;
      showToast(msg);
      return;
    }
    await db.from('order_status_history').insert({ order_id: order.id, status: 'confirmed', changed_by: 'mozo' });
    // Fix is_occupied: trigger may be slow, update directly
    await db.from('tables').update({ is_occupied: true, occupied_since: order.created_at, assigned_waiter_name: mozoSession?.mozo_name || 'Mozo' }).eq('id', tableId);
    await loadData();
    openOrderView(tableId);
    showToast('Orden creada — Mesa ' + tableNum);
  }

  async function attendCall(tableId) {
    setMesaDialog(null);
    const call = callsMap[tableId];
    if (!call || !db) return;
    await db.from('waiter_calls').update({ status: 'attended', attended_at: new Date().toISOString() }).eq('id', call.id);
    await loadData();
    showToast('Asistencia registrada');
  }

  async function liberarMesa(tableId) {
    if (!db) return;
    const mesa = tables.find(t => t.id === tableId);

    // Advertencia si quedan pedidos sin cobrar (no bloquea — el mozo decide)
    // Excluye órdenes ya pagadas (payment_status='paid') aunque sigan en cocina.
    const { data: deudas } = await db.from('orders')
      .select('id, payment_status')
      .eq('table_id', tableId)
      .not('status', 'in', '("cancelled","delivered")');
    const hayDeuda = !!(deudas && deudas.some(o => o.payment_status !== 'paid'));

    setConfirmDialog({
      title: `Liberar Mesa ${mesa?.number}`,
      body: hayDeuda
        ? `Hay pedidos sin cobrar. ¿Confirmar que el servicio concluyó y la mesa quedó libre?`
        : '¿Confirmar que el servicio concluyó y la mesa quedó libre?',
      danger: hayDeuda,
      onOk: async () => {
        await db.from('tables').update({ is_occupied: false, occupied_since: null, assigned_waiter_name: null }).eq('id', tableId);
        await loadData();
        setTableOrders([]);
        setActiveTableId(null);
        setCurrentView('mesas');
        showToast('Mesa ' + (mesa?.number || '') + ' liberada');
      },
    });
  }

  // Carga órdenes de la SESIÓN ACTUAL de la mesa (desde occupied_since, excluyendo cobradas)
  async function loadTableOrders(tableId) {
    if (!db || !tableId) return;
    const tbl = tablesById[tableId];
    // Columnas de validación del pago (mig 182). Si la mig no está, el select con
    // esas columnas da error → se reintenta sin ellas (fail-open, igual que caja).
    const EXT = 'payment_review_status, payment_review_note, payment_reference, payment_proof_url, ';
    const buildSel = ext => `id, order_number, status, payment_status, total, created_at, payment_method, delivered_to_table_at, ${ext}order_items(id, item_name, quantity, unit_price, total_price, observations)`;
    const run = sel => {
      let q = db.from('orders')
        .select(sel)
        .eq('restaurant_id', RID)
        .eq('table_id', tableId)
        .not('status', 'in', '("cancelled")')
        // Excluir órdenes ya cobradas por mozo (delivered + payment_method seteado)
        .or('status.neq.delivered,payment_method.is.null')
        .order('created_at');
      // Filtrar por sesión actual para no mostrar sesiones históricas de la misma mesa
      if (tbl?.occupied_since) q = q.gte('created_at', tbl.occupied_since);
      return q;
    };
    let { data, error } = await run(buildSel(EXT));
    if (error) { ({ data } = await run(buildSel(''))); }
    setTableOrders(data || []);
  }

  // Validación del pago (mig 182 · FASE D2): el mozo aprueba/rechaza una
  // transferencia/QR — misma capacidad que caja. Al APROBAR, el pedido se libera
  // a cocina (con policy B estaba frenado hasta la validación). Optimista + bitácora
  // inmutable en payment_reviews. Fail-open si la mig no está.
  async function doReview(order, action) {
    let note = null;
    if (action === 'rejected') { note = (window.prompt('Motivo del rechazo (opcional):') || '').trim() || null; }
    setTableOrders(prev => prev.map(x => x.id === order.id ? { ...x, payment_review_status: action, payment_review_note: note } : x));
    const r = await recordPaymentReview(db, { restaurantId: RID, orderId: order.id, action, note });
    if (!r.applied) { showToast('No se pudo guardar la validación' + (r.error ? ' (' + r.error + ')' : '')); }
    else { showToast(action === 'approved' ? 'Pago verificado — el pedido pasa a cocina' : 'Pago rechazado'); }
    if (activeTableIdRef.current) loadTableOrders(activeTableIdRef.current);
  }

  // Carga items para el modal de cobro: sesión actual, excluye cobradas.
  // Con mig 128 (paid_quantity) se trabaja por ítem: pendiente = quantity - paid_quantity.
  async function loadCobroItems(tableId) {
    if (!db || !tableId) return;
    const tbl = tablesById[tableId];
    const SEL_NEW = 'id, status, payment_status, payment_method, requires_invoice, delivered_to_table_at, invoice_delivery_method, order_items(id, item_name, quantity, unit_price, total_price, observations, paid_quantity)';
    const SEL_OLD = 'id, status, payment_status, payment_method, order_items(id, item_name, quantity, unit_price, total_price, observations)';
    const runSel = (sel) => {
      let q = db.from('orders')
        .select(sel)
        .eq('restaurant_id', RID)
        .eq('table_id', tableId)
        .not('status', 'in', '("cancelled")')
        .or('status.neq.delivered,payment_method.is.null')
        .or('payment_status.neq.paid,payment_status.is.null')
        .order('created_at');
      if (tbl?.occupied_since) q = q.gte('created_at', tbl.occupied_since);
      return q;
    };
    // Feature-detect mig 128: si paid_quantity no existe, degradar al cobro clásico (toda la mesa).
    let { data: orders, error } = await runSel(SEL_NEW);
    let hasPaidCol = true;
    if (error) { hasPaidCol = false; const r = await runSel(SEL_OLD); orders = r.data; }
    setPartialOn(hasPaidCol);
    const items = [];
    let total = 0;
    (orders || []).forEach(o => {
      // Si está delivered + payment_method, o payment_status='paid' → ya fue cobrado
      const yaCobrado = (o.status === 'delivered' && o.payment_method) || o.payment_status === 'paid';
      if (yaCobrado) return;
      (o.order_items || []).forEach(i => {
        const qty = Number(i.quantity) || 0;
        const paid = hasPaidCol ? (Number(i.paid_quantity) || 0) : 0;
        const pend = Math.max(0, qty - paid);
        if (pend <= 0) return; // ítem ya saldado → no se muestra
        // Precio efectivo por unidad: total_price (incluye extras) / quantity, o unit_price.
        const unit = (Number(i.total_price) > 0 && qty > 0) ? Math.round(Number(i.total_price) / qty) : (Number(i.unit_price) || 0);
        items.push({ ...i, _orderId: o.id, _qty: qty, _paid: paid, _pend: pend, _unit: unit, _lineTotal: pend * unit });
        total += pend * unit;
      });
    });
    setCobroItems(items);
    setCobroRealTotal(total);
    // Selección por defecto: todos los pendientes tildados (preservando lo ya elegido si recarga realtime).
    setCobroItemSel(prev => {
      const m = {};
      items.forEach(it => {
        const p = prev[it.id];
        m[it.id] = { checked: p ? p.checked : true, qty: Math.min(p?.qty || it._pend, it._pend) };
      });
      return m;
    });
  }

  // Carga el contexto de caja para rendir el cobro: turnos abiertos + cajas activas (nombres).
  async function loadCobroContext() {
    if (!db) return;
    try {
      const [tRes, cRes] = await Promise.all([
        db.from('turnos_caja').select('id, caja_id, cajero_nombre, fecha_apertura')
          .eq('restaurant_id', RID).eq('estado', 'abierto').order('fecha_apertura', { ascending: true }),
        db.from('cajas').select('id, nombre, activa, sort_order')
          .eq('restaurant_id', RID).order('sort_order', { ascending: true }),
      ]);
      const ts = tRes.data || [];
      setOpenTurnos(ts);
      setCajasActivas((cRes.data || []).filter(c => c.activa));
      // 1 turno abierto → autoseleccionar; varios → el mozo elige; 0 → bloqueado.
      setSelTurnoId(ts.length === 1 ? ts[0].id : null);
    } catch (e) {
      // cajas/turnos puede no existir si mig 126 no está aplicada → degradar a cobro clásico.
      setOpenTurnos([]); setCajasActivas([]); setSelTurnoId(null);
    }
  }

  async function loadHistorial(tableId) {
    if (!db) return;
    setLoadingHistorial(true);
    setHistorialOrders([]);
    setHistorialModal(true);
    const tbl = tablesById[tableId];
    try {
      let q = db.from('orders')
        .select('id, order_number, status, payment_status, payment_method, total, created_at, order_items(id, item_name, quantity, total_price)')
        .eq('restaurant_id', RID)
        .eq('table_id', tableId)
        .neq('status', 'cancelled')
        .order('created_at', { ascending: false });
      if (tbl?.occupied_since) q = q.gte('created_at', tbl.occupied_since);
      const { data } = await q;
      // Ocultar órdenes fantasma: sin ítems y sin total (restos de sesiones corruptas)
      setHistorialOrders((data || []).filter(o => (o.order_items || []).length > 0 || Number(o.total || 0) > 0));
    } catch(e) {
      console.error('loadHistorial error:', e);
    }
    setLoadingHistorial(false);
  }

  /* ── PRODUCT MODAL ── */
  function openProductModal() {
    setSelectedProducts({});
    setProductSearch('');
    setActiveCategory('Todos');
    setItemNotes({});
    setItemExtras({});
    setProductModal(true);
  }

  async function confirmAddProducts() {
    if (!db) { showToast('Sin conexión'); return; }
    if (!activeTableId) { showToast('Seleccioná una mesa antes de confirmar'); return; }
    const order = ordersMap[activeTableId];
    if (!order) { showToast('Sin orden activa'); return; }

    const selected = Object.entries(selectedProducts).filter(([, qty]) => qty > 0);
    if (selected.length === 0) { showToast('Seleccioná al menos un ítem'); return; }

    // Si la orden activa sigue editable (no enviada a cocina ni cobrada), se agregan los
    // ítems a la misma orden. Si ya avanzó (kitchen_received/cooking/ready/pending_payment/
    // delivered o pagada), los nuevos ítems NO deben heredar ese estado —si no, aparecen
    // como "Entregado · cobro pte." sin pasar por cocina. En ese caso se crea una orden nueva
    // que entra a la cocina como ticket aparte.
    const editable = ['draft', 'confirmed'].includes(order.status) && order.payment_status !== 'paid';
    let targetOrder = order;

    if (!editable) {
      const tableNum = activeTable?.number || order.table_id;
      const ts = Date.now().toString(36).toUpperCase().slice(-4);
      const rnd = Math.random().toString(36).slice(-2).toUpperCase();
      const orderNum = 'W-' + tableNum + '-' + ts + rnd;
      const { data: { session: currentSession } } = await db.auth.getSession();
      if (!currentSession) { window.location.replace('login.html'); return; }
      const insertPayload = {
        restaurant_id: RID,
        table_id: activeTableId,
        order_number: orderNum,
        order_type: 'local',
        status: 'kitchen_received',
        subtotal: 0,
        discount_amount: 0,
        total: 0,
        waiter_id: currentSession.user.id,
        waiter_name: mozoSession?.mozo_name || 'Mozo',
      };
      let { data: newOrder, error: newErr } = await db.from('orders').insert(insertPayload).select().single();
      if (newErr && (newErr.message?.includes('waiter_id') || newErr.message?.includes('waiter_name') || newErr.message?.includes('schema cache'))) {
        const safePayload = { restaurant_id: RID, table_id: activeTableId, order_number: orderNum, order_type: 'local', status: 'kitchen_received', subtotal: 0, discount_amount: 0, total: 0 };
        const retry = await db.from('orders').insert(safePayload).select().single();
        newOrder = retry.data; newErr = retry.error;
      }
      if (newErr || !newOrder) { showToast('Error al crear orden'); console.error(newErr); return; }
      await db.from('order_status_history').insert({ order_id: newOrder.id, status: 'kitchen_received', changed_by: 'mozo_pedir_mas' });
      targetOrder = newOrder;
    }

    const items = selected.map(([id, qty]) => {
      const p = menu.find(m => m.id === parseInt(id));
      const unit = effectivePrice(p);
      return {
        order_id: targetOrder.id,
        item_id: p.id,
        item_name: p.name,
        quantity: qty,
        unit_price: unit,
        total_price: unit * qty,
        observations: itemNotes[id] || null,
      };
    });

    const { data: insertedItems, error } = await db.from('order_items').insert(items).select();
    if (error) { showToast('Error al agregar'); console.error(error); return; }

    // Insert selected extras per item
    const extrasToInsert = [];
    (insertedItems || []).forEach(inserted => {
      const productId = String(inserted.item_id);
      const selectedEx = itemExtras[productId] || {};
      const availExtras = extrasMap[inserted.item_id] || [];
      Object.entries(selectedEx).forEach(([extraId, checked]) => {
        if (!checked) return;
        const extra = availExtras.find(e => e.id === parseInt(extraId));
        if (extra) extrasToInsert.push({ order_item_id: inserted.id, extra_name: extra.name, extra_price: extra.price_guarani });
      });
    });
    if (extrasToInsert.length > 0) {
      await db.from('order_item_extras').insert(extrasToInsert);
    }

    const addedTotal = items.reduce((s, i) => s + i.total_price, 0);
    const extrasTotal = extrasToInsert.reduce((s, e) => s + e.extra_price, 0);
    const newTotal = (targetOrder.subtotal || 0) + addedTotal + extrasTotal;
    await db.from('orders').update({ subtotal: newTotal, total: newTotal }).eq('id', targetOrder.id);

    await loadData();
    setProductModal(false);
    setItemNotes({});
    setItemExtras({});
    showToast(editable ? `${items.length} ítem(s) agregado(s)` : `${items.length} ítem(s) enviado(s) a cocina`);
  }

  /* ── SAVE ITEM NOTE ── */
  async function saveItemNote(itemId, note) {
    if (!db) return;
    await db.from('order_items').update({ observations: note || null }).eq('id', itemId);
    setItemEditId(null);
    setItemEditNote('');
    if (activeTableId) loadTableOrders(activeTableId);
    showToast('Nota actualizada');
  }

  /* ── REMOVE ITEM ── */
  async function removeItem(itemId) {
    if (!db) return;
    let targetOrder = null;
    let targetItem = null;
    for (const ord of tableOrders) {
      const found = (ord.order_items || []).find(i => i.id === itemId);
      if (found) { targetOrder = ord; targetItem = found; break; }
    }
    if (!targetOrder || !targetItem) { showToast('Ítem no encontrado'); return; }
    const { error: delErr } = await db.from('order_items').delete().eq('id', itemId);
    if (delErr) { showToast('Error al eliminar: ' + (delErr.message || delErr.code)); return; }
    const lineTotal = Number(targetItem.total_price) || Number((targetItem.unit_price || 0)) * Number(targetItem.quantity || 0);
    const newTotal = Math.max(0, (targetOrder.total || 0) - lineTotal);
    await db.from('orders').update({ subtotal: newTotal, total: newTotal }).eq('id', targetOrder.id);
    await loadData();
    if (activeTableId) await loadTableOrders(activeTableId);
    showToast('Ítem eliminado');
  }

  /* ── ADJUST ITEM QUANTITY ── */
  async function adjustItemQty(itemId, delta) {
    if (!db) return;
    let targetOrder = null;
    let targetItem = null;
    for (const ord of tableOrders) {
      const found = (ord.order_items || []).find(i => i.id === itemId);
      if (found) { targetOrder = ord; targetItem = found; break; }
    }
    if (!targetOrder || !targetItem) return;
    const oldQty = Number(targetItem.quantity || 1);
    const newQty = oldQty + delta;
    if (newQty <= 0) {
      await removeItem(itemId);
      return;
    }
    const unitPrice = Number(targetItem.unit_price || 0);
    const oldLineTotal = Number(targetItem.total_price) || unitPrice * oldQty;
    const newLineTotal = unitPrice * newQty;
    const { error: updErr } = await db.from('order_items')
      .update({ quantity: newQty, total_price: newLineTotal })
      .eq('id', itemId);
    if (updErr) { showToast('Error al actualizar cantidad: ' + (updErr.message || updErr.code)); return; }
    const newOrderTotal = Math.max(0, (targetOrder.total || 0) - oldLineTotal + newLineTotal);
    await db.from('orders').update({ subtotal: newOrderTotal, total: newOrderTotal }).eq('id', targetOrder.id);
    await loadData();
    if (activeTableId) await loadTableOrders(activeTableId);
  }

  /* ── ENVIAR A COCINA ── */
  async function enviarACocina() {
    if (!db) { showToast('Sin conexión'); return; }
    const order = ordersMap[activeTableId];
    if (!order) return;
    if ((order.order_items || []).length === 0) {
      showToast('Agregá al menos un producto antes de enviar a cocina');
      return;
    }
    await db.from('orders').update({ status: 'kitchen_received' }).eq('id', order.id);
    await db.from('order_status_history').insert({ order_id: order.id, status: 'kitchen_received', changed_by: 'mozo' });
    await loadData();
    showToast('Orden enviada a cocina');
  }

  /* ── LLAMAR A CAJA ── */
  async function callCaja() {
    if (!db || !activeTableId) return;
    // Evitar duplicar solicitudes pendientes para la misma mesa
    const { data: existing } = await db.from('waiter_calls')
      .select('id')
      .eq('restaurant_id', RID)
      .eq('table_id', activeTableId)
      .eq('type', 'payment_request')
      .eq('status', 'pending')
      .limit(1);
    if (existing && existing.length > 0) {
      showToast('Caja ya fue notificada para esta mesa');
      return;
    }
    const { error } = await db.from('waiter_calls').insert({
      restaurant_id: RID,
      table_id: activeTableId,
      type: 'payment_request',
      status: 'pending',
    });
    if (error) { showToast('Error al notificar a caja'); console.error(error); return; }
    showToast('✓ Caja notificada — solicitando cobro');
  }

  /* ── COBRO ── */
  function openCobroModal() {
    setTipPct(0);
    setPayMethod('efectivo');
    setCobroItems([]);
    setCobroRealTotal(0);
    setDividirPersonas(2);
    setFraccionStates({});
    setInvoiceType('none');
    setInvName('');
    setInvRuc('');
    setInvEmail('');
    setComprobante('');
    setCobroItemSel({});
    setCobroBusy(false);
    setCobroModal(true);
    loadCobroItems(activeTableId);
    loadCobroContext();
  }

  // Cobro por ítem que ENTRA al arqueo de la caja elegida (RPC cobro_mesa_parcial, mig 128).
  //   cobrarTodo=true  → todos los pendientes de la mesa ("Cobrar toda la mesa")
  //   cobrarTodo=false → solo los ítems tildados ("Cobrar seleccionados")
  // Si la mig 128 no está aplicada (sin paid_quantity / sin RPC) degrada al cobro clásico.
  // Exige comprobante para transferencia/QR si el local lo activó (mig 182 · require_proof).
  // Se cumple con el N° de operación O con la foto — cualquiera alcanza.
  function _faltaComprobanteMozo() {
    return requireProof && payMethod === 'qr' && !comprobante.trim() && !proofUrl;
  }
  const _MSG_FALTA_COMP = 'Este local exige comprobante para cobrar por transferencia/QR — cargá el N° de operación o la foto.';

  async function processPay(cobrarTodo) {
    if (!db) { showToast('Sin conexión'); return; }
    if (cobroBusy) return;
    if (_faltaComprobanteMozo()) { showToast(_MSG_FALTA_COMP); return; }

    // Sin mig 128: cobro clásico de toda la mesa (no entra a caja, no requiere caja abierta).
    if (!partialOn) { return processPayLegacy(); }

    const lines = cobrarTodo
      ? cobroItems.map(it => ({ it, qty: it._pend }))
      : cobroItems
          .filter(it => cobroItemSel[it.id]?.checked && (cobroItemSel[it.id]?.qty || 0) > 0)
          .map(it => ({ it, qty: Math.min(cobroItemSel[it.id].qty, it._pend) }));
    const toCharge = lines.filter(x => x.qty > 0);
    if (toCharge.length === 0) { showToast('Seleccioná al menos un ítem'); return; }

    // El mozo recauda y rinde a una caja → requiere una caja abierta.
    if (openTurnos.length === 0) {
      showToast('No hay caja abierta — pedí que abran una caja para cobrar');
      return;
    }
    const turnoId = openTurnos.length === 1 ? openTurnos[0].id : selTurnoId;
    if (!turnoId) { showToast('Elegí en qué caja registrar el cobro'); return; }

    const subt = toCharge.reduce((s, x) => s + x.qty * x.it._unit, 0);
    if (subt <= 0) { showToast('Total en ₲0 — verificá los productos'); return; }

    setCobroBusy(true);
    try {
      // 1) Persistir campos de factura en los pedidos tocados ANTES de la RPC.
      //    La RPC marca invoice_status='issued' al saldar cada pedido.
      if (invoiceType !== 'none') {
        const nowIso = new Date().toISOString();
        const invFields = {
          requires_invoice: true,
          invoice_delivery_method: invoiceDelivery,
          invoice_requested_at: nowIso,
          invoice_status: 'pending',
          ...(invoiceType === 'fiscal' && {
            customer_ruc: invRuc || null,
            customer_email: invEmail || null,
            ...(invName && { customer_name: invName }),
          }),
        };
        const orderIds = [...new Set(toCharge.map(x => x.it._orderId))];
        for (const oid of orderIds) {
          const { error: invErr } = await db.from('orders').update(invFields).eq('id', oid);
          // Fallback si las migraciones 039/044 no están aplicadas: al menos requires_invoice.
          if (invErr) { await db.from('orders').update({ requires_invoice: true }).eq('id', oid).then(() => {}, () => {}); }
        }
      }

      // 2) Cobro ATÓMICO: la RPC suma paid_quantity (FOR UPDATE anti-doble-cobro), salda los
      //    pedidos 100% pagados, inserta UN movimiento en la caja elegida (→ arqueo) y marca
      //    waiter_calls atendidas si la mesa queda saldada. Mapea payment_method internamente.
      const pm = payMethod || 'efectivo';
      const { data, error } = await db.rpc('cobro_mesa_parcial', {
        p_restaurant_id: RID,
        p_turno_id: turnoId,
        p_table_id: activeTableId,
        p_items: toCharge.map(x => ({ item_id: x.it.id, qty: x.qty })),
        p_metodo: pm,
        p_monto_pagado: subt,
      });
      if (error) throw error;
      const res = data || {};
      const applied = res.applied || [];
      if (!applied.length) {
        showToast('Estos ítems ya fueron cobrados. Actualizá la lista.');
        await loadCobroItems(activeTableId);
        setCobroBusy(false);
        return;
      }
      const subReal = Number(res.sub) || 0;
      const mesaSaldada = !!res.mesa_saldada;
      // Atribución "Cobrado por" en el historial del turno: la RPC no setea paid_by_name
      // (el registro principal queda en movimientos_caja). Lo estampamos best-effort sobre los
      // pedidos tocados para no perder la atribución que daba el cobro clásico. No bloquea el cobro.
      try {
        const payerName = mozoSession?.mozo_name || 'mozo';
        const touchedIds = [...new Set(toCharge.map(x => x.it._orderId))];
        if (touchedIds.length) {
          await db.from('orders').update({ paid_by_name: payerName, paid_at: new Date().toISOString(), payment_reference: (['tarjeta_credito','tarjeta_debito','qr'].includes(payMethod) && comprobante.trim()) ? comprobante.trim() : null }).in('id', touchedIds);
          // Foto del comprobante (mig 182): best-effort, no bloquea el cobro.
          if (proofUrl) { try { await db.from('orders').update({ payment_proof_url: proofUrl, payment_review_status: 'pending' }).in('id', touchedIds); } catch (_) {} }
        }
      } catch (_) { /* columnas opcionales (mig 044) — ignorar si faltan */ }
      await loadData();
      setComprobante(''); setProofUrl('');   // no reutilizar el comprobante en el próximo cobro
      if (mesaSaldada) {
        setCobroModal(false);
        setTableOrders([]);
        setActiveTableId(null);
        setCurrentView('mesas');
        showToast('✓ Mesa saldada — ' + fGs(subReal));
      } else {
        // Cobro parcial: refrescar el modal con lo que aún queda pendiente.
        await loadCobroItems(activeTableId);
        showToast('✓ Cobro parcial — ' + fGs(subReal));
      }
    } catch (e) {
      const m = `${e?.message || ''} ${e?.code || ''}`;
      if (/cobro_mesa_parcial|PGRST202|42883|schema cache|does not exist/i.test(m)) {
        // RPC ausente (mig 128 sin aplicar) → degradar al cobro clásico de toda la mesa.
        setCobroBusy(false);
        return processPayLegacy();
      }
      console.error('processPay error:', e);
      showToast('Error al cobrar: ' + (e?.message || e));
    }
    setCobroBusy(false);
  }

  // Cobro clásico (fallback sin mig 128): cobra TODA la mesa con update directo a orders.
  // No registra en caja — se mantiene para no romper el cobro si la RPC no está disponible.
  async function processPayLegacy() {
    if (!db) { showToast('Sin conexión'); return; }
    if (_faltaComprobanteMozo()) { showToast(_MSG_FALTA_COMP); return; }
    const base = cobroBase;
    if (base === 0) { showToast('Total en ₲0 — verificá los productos'); return; }
    const total = Math.round(base * (1 + tipPct / 100));
    // Mapear al dominio de orders.payment_method (el selector usa el de movimientos_caja).
    const pm = mapOrderPM(payMethod || 'efectivo');

    try {
      // Cobrar órdenes activas:
      //   - pending_payment + delivered_to_table_at seteado = comida en la mesa, se puede cerrar a delivered.
      //   - pending_payment sin delivered_to_table_at = cocina despachó pero el mozo aún no
      //     llevó la comida; se marca paid pero el status sigue pending_payment para que la mesa
      //     siga marcada como "retirar" hasta entrega física.
      //   - ready / cooking / kitchen_received / paid = cocina sigue trabajando; sólo registramos
      //     el cobro y dejamos que la cocina avance — caso contrario el KDS pierde el ticket.
      const { data: pendingOrders, error: qErr } = await db.from('orders')
        .select('id, status, delivered_to_table_at')
        .eq('restaurant_id', RID)
        .eq('table_id', activeTableId)
        .not('status', 'in', '("cancelled","delivered")');

      if (qErr) { showToast('Error al obtener órdenes: ' + qErr.message); return; }
      if (!pendingOrders || pendingOrders.length === 0) {
        showToast('No hay órdenes pendientes para cobrar');
        setCobroModal(false);
        return;
      }

      const authRes = await db.auth.getSession();
      const paySession = authRes?.data?.session || null;
      const payerId = paySession?.user?.id || null;
      const payerName = mozoSession?.mozo_name || 'mozo';
      const nowIso = new Date().toISOString();

      const invoiceFields = {
        requires_invoice: invoiceType !== 'none',
        ...(invoiceType === 'fiscal' && {
          customer_ruc: invRuc || null,
          customer_email: invEmail || null,
          ...(invName && { customer_name: invName }),
        }),
        ...(invoiceType !== 'none' && {
          invoice_delivery_method: invoiceDelivery,
          invoice_requested_at: nowIso,
          invoice_status: 'pending',
        }),
      };

      for (const ord of pendingOrders) {
        const yaEnMesa = !!ord.delivered_to_table_at;
        const cerrarOrden = ord.status === 'pending_payment' && yaEnMesa;

        // Update completo con campos de auditoría + facturación
        const update = {
          payment_status: 'paid',
          payment_method: pm,
          total: total,
          paid_by: payerId,
          paid_by_name: payerName,
          paid_at: nowIso,
          payment_reference: (['tarjeta_credito','tarjeta_debito','qr'].includes(payMethod) && comprobante.trim()) ? comprobante.trim() : null,
          ...invoiceFields,
        };
        if (cerrarOrden) {
          update.status = 'delivered';
          update.completed_at = nowIso;
        }

        let { error: updErr } = await db.from('orders').update(update).eq('id', ord.id);

        if (updErr) {
          // Fallback mínimo: solo los campos esenciales del cobro, sin auditoría ni facturación
          // (protege contra migraciones 039/044 no aplicadas en prod)
          const fallback = { payment_status: 'paid', payment_method: pm, total: total };
          if (cerrarOrden) { fallback.status = 'delivered'; fallback.completed_at = nowIso; }
          const { error: fallErr } = await db.from('orders').update(fallback).eq('id', ord.id);
          if (fallErr) {
            showToast('Error al registrar cobro: ' + fallErr.message);
            return;
          }
        }

        await db.from('order_status_history').insert({
          order_id: ord.id,
          status: cerrarOrden ? 'delivered' : 'paid_in_kitchen',
          changed_by: payerName,
        });
        // Foto del comprobante (mig 182): best-effort.
        if (proofUrl) { try { await db.from('orders').update({ payment_proof_url: proofUrl, payment_review_status: 'pending' }).eq('id', ord.id); } catch (_) {} }
      }

      await loadData();
      setComprobante(''); setProofUrl('');   // no reutilizar el comprobante en el próximo cobro
      setCobroModal(false);
      setTableOrders([]);
      setActiveTableId(null);
      setCurrentView('mesas');
      showToast('Cobro registrado — ' + fGs(total));
    } catch(e) {
      console.error('processPay error:', e);
      showToast('Error inesperado al cobrar: ' + (e?.message || e));
    }
  }

  /* ── FINALIZAR / CONFIRMAR ENTREGA ──
   * - ready o pending_payment sin delivered_to_table_at → mozo confirma que
   *   llevó físicamente los platos a la mesa. Setea delivered_to_table_at.
   *   Si la orden ya estaba pagada → cierra la orden (status=delivered).
   *   Si no, queda en pending_payment esperando cobro (mesa pasa a negro).
   * - pending_payment ya entregado + pagado → cerrar orden (status=delivered).
   * - draft/confirmed/paid/kitchen_received/cooking → no se permite, cocina
   *   aún tiene la orden. */
  function finalizarOrden() {
    const order = ordersMap[activeTableId];
    if (!order) return;
    const yaPagado = order.payment_status === 'paid';
    const yaEntregado = !!order.delivered_to_table_at;

    // Caso: entregada + pagada → solo queda cerrar el ticket
    if (yaEntregado && yaPagado) {
      setConfirmDialog({
        title: 'Finalizar orden',
        body: '¿Finalizar la orden? Se marcará como entregada y se cerrará el ticket.',
        onOk: async () => {
          if (!db) return;
          await db.from('orders').update({ status: 'delivered', completed_at: new Date().toISOString() }).eq('id', order.id);
          await db.from('order_status_history').insert({ order_id: order.id, status: 'delivered', changed_by: 'mozo_finalizar' });
          await loadData();
          showToast('Orden finalizada');
        },
      });
      return;
    }

    if (['draft','confirmed','paid','kitchen_received','cooking'].includes(order.status)) {
      showToast('La cocina aún está preparando esta orden');
      return;
    }

    // ready o pending_payment sin delivered_to_table_at → confirmar entrega física
    setConfirmDialog({
      title: 'Confirmar entrega a la mesa',
      body: yaPagado
        ? '¿Ya entregaste los platos al cliente? La orden quedará cerrada (ya está cobrada).'
        : `¿Ya entregaste los platos al cliente? La orden quedará pendiente de cobro (₲ ${fGs(order.total).replace('₲ ','')}).`,
      onOk: async () => {
        if (!db) return;
        const nowIso = new Date().toISOString();
        const update = { delivered_to_table_at: nowIso };
        // Si está en ready, despachar a pending_payment
        if (order.status === 'ready') update.status = 'pending_payment';
        // Si ya está pagada, cerrar
        if (yaPagado) {
          update.status = 'delivered';
          update.completed_at = nowIso;
        }
        let { error: updErr } = await db.from('orders').update(update).eq('id', order.id);
        // Fallback si la migración 067 no está aplicada
        if (updErr && (updErr.message?.includes('delivered_to_table_at') || updErr.message?.includes('schema cache'))) {
          const fallback = {};
          if (order.status === 'ready') fallback.status = 'pending_payment';
          if (yaPagado) { fallback.status = 'delivered'; fallback.completed_at = nowIso; }
          if (Object.keys(fallback).length > 0) {
            await db.from('orders').update(fallback).eq('id', order.id);
          }
        }
        await db.from('order_status_history').insert({
          order_id: order.id,
          status: yaPagado ? 'delivered' : 'pending_payment',
          changed_by: 'mozo_entregado',
        });
        await loadData();
        showToast(yaPagado ? 'Orden entregada y cerrada' : 'Entrega confirmada · pendiente de cobro');
      },
    });
  }

  /* ── ALERTS ── */
  async function handleAlertAction(callId) {
    if (!db) return;
    await db.from('waiter_calls').update({ status: 'attended', attended_at: new Date().toISOString() }).eq('id', callId);
    await loadData();
    showToast('Asistencia registrada');
  }

  function clearAlerts() {
    setConfirmDialog({
      title: 'Limpiar alertas',
      body: '¿Marcar todas las alertas como atendidas?',
      onOk: async () => {
        if (!db || waiterCalls.length === 0) return;
        const ids = waiterCalls.map(c => c.id);
        await db.from('waiter_calls').update({ status: 'attended', attended_at: new Date().toISOString() }).in('id', ids);
        await loadData();
        showToast('Alertas limpiadas');
      },
    });
  }

  /* ── COMPUTED ── */
  const tablesById = useMemo(() => {
    const m = {};
    tables.forEach(t => { m[t.id] = t; });
    return m;
  }, [tables]);

  // Tick cada 60s para que la ventana de "Reservada" / alerta avance sin recargar datos
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);

  const reservationByTable = useMemo(
    () => buildReservationByTable(reservationsToday, nowTick, reservationConfig.window, reservationConfig.alertMin),
    [reservationsToday, nowTick, reservationConfig.window, reservationConfig.alertMin]
  );

  const totalActivo = useMemo(() =>
    Object.values(ordersMap).reduce((sum, o) => sum + Number(o.total || 0), 0)
  , [ordersMap]);

  const mesasACobrar = Object.values(ordersMap).filter(o => o.payment_status !== 'paid').length;
  const montoACobrar = Object.values(sessionTotals).reduce((s, v) => s + v, 0);

  // Mesas con cobro pendiente: pending_payment sin pagar, o pago iniciado pero no cerrado.
  // Excluye órdenes ya pagadas (no aparecen en "cobros pendientes").
  const pendingPaymentTables = useMemo(() => {
    return Object.entries(ordersMap)
      .filter(([, o]) => o.payment_status !== 'paid' && (o.status === 'pending_payment' || (o.payment_method && o.status !== 'delivered' && o.status !== 'cancelled')))
      .map(([tableId, o]) => {
        const tbl = tablesById[tableId];
        const pm = o.payment_method;
        const enMesa = !!o.delivered_to_table_at;
        // Etiqueta según método de pago elegido por el cliente, o estado físico:
        //  - sin pm + no entregado = cocina despachó, mozo aún debe retirar
        //  - sin pm + entregado    = en la mesa, esperando que el cliente pida cuenta
        const pmLabel =
          pm === 'efectivo' ? 'Efectivo' :
          (pm === 'pos' || pm === 'tarjeta') ? 'POS/Tarjeta' :
          pm === 'qr' ? 'QR Mesa' :
          pm === 'pos_mesa' ? 'POS Mesa' :
          enMesa ? 'Entregado · cobro pte.' : 'Listo · a cobrar';
        const requested = !!pm; // sólo true si el cliente eligió método de pago
        return { tableId, tableNum: tbl?.number || '?', pmLabel, requested, total: sessionTotals[tableId] || 0, orderId: o.id };
      });
  }, [ordersMap, tablesById, sessionTotals]);

  const activeOrder = activeTableId ? ordersMap[activeTableId] : null;
  const activeTable = activeTableId ? tables.find(t => t.id === activeTableId) : null;
  // Hay cobro pendiente si existe alguna orden de la mesa sin payment_status='paid' y con ítems
  const hasPendingCobro = tableOrders.some(o => o.payment_status !== 'paid' && (o.order_items || []).length > 0);
  const activeTableOccupied = activeTableId ? (tablesById[activeTableId]?.is_occupied ?? false) : false;
  const unreadBroadcasts = broadcasts.filter(b => new Date(b.created_at).getTime() > lastSeenBroadcasts.current).length;
  const pendingAlerts = waiterCalls.length + unreadBroadcasts;
  const myName = mozoSession?.mozo_name;
  const displayTables = (tableScope === 'mine' && myName)
    ? tables.filter(t => tablesById[t.id]?.assigned_waiter_name === myName || ordersMap[t.id]?.waiter_name === myName)
    : tables;
  // Badge count: pedidos que el mozo debe retirar de cocina.
  // ready = cocina marcó listo (mozo aún no despachó manualmente)
  // pending_payment sin delivered_to_table_at = cocina despachó pero el mozo
  //   no confirmó entrega física a la mesa.
  const readyCount = Object.values(ordersMap).filter(o =>
    o.status === 'ready' || (o.status === 'pending_payment' && !o.delivered_to_table_at)
  ).length;

  const filteredMenu = useMemo(() => menu.filter(p =>
    (activeCategory === 'Todos' || p.cat === activeCategory) &&
    p.name.toLowerCase().includes(productSearch.toLowerCase())
  ), [menu, activeCategory, productSearch]);

  // Items con promoción (promo_tag, promo_type o descuento)
  const promoItems = useMemo(
    () => menu.filter(p => p.promo_tag || p.promo_type || (Number(p.discount_pct) > 0)),
    [menu]
  );
  // Destacado del día: el que tenga "★" o "chef" en el tag, sino el primero con mayor descuento
  const featuredItem = useMemo(() => {
    if (promoItems.length === 0) return null;
    const star = promoItems.find(p => (p.promo_tag || '').toLowerCase().includes('★') || p.promo_type === 'destacado' || p.promo_type === 'chef');
    if (star) return star;
    const byDisc = [...promoItems].sort((a, b) => (Number(b.discount_pct) || 0) - (Number(a.discount_pct) || 0));
    return byDisc[0];
  }, [promoItems]);
  // Mostrar promos/destacados solo en filtro "Todos" y sin búsqueda
  const showPromosSection = activeCategory === 'Todos' && !productSearch.trim() && promoItems.length > 0;

  const selectedCount = Object.values(selectedProducts).reduce((s, q) => s + q, 0);
  const selectedTotal = Object.entries(selectedProducts).reduce((s, [id, q]) => {
    const p = menu.find(m => m.id === parseInt(id));
    const extrasSum = Object.entries(itemExtras[id] || {}).reduce((es, [eid, checked]) => {
      if (!checked) return es;
      const ex = (extrasMap[parseInt(id)] || []).find(e => e.id === parseInt(eid));
      return es + (ex ? ex.price_guarani * q : 0);
    }, 0);
    return s + (p ? effectivePrice(p) * q : 0) + extrasSum;
  }, 0);

  const orderBase = activeOrder ? (activeOrder.total || 0) : 0;
  const tipAmt = Math.round(orderBase * tipPct / 100);
  const payTotal = orderBase + tipAmt;

  // Suma de todos los items de la mesa activa (usa total_price si está disponible)
  const tableTotal = useMemo(() =>
    tableOrders.reduce((sum, ord) =>
      sum + (ord.order_items || []).reduce((s, i) => {
        const lineTotal = Number(i.total_price) || Number((i.unit_price || 0)) * Number(i.quantity || 0);
        return s + lineTotal;
      }, 0), 0
    ), [tableOrders]);

  // FIX #5 — base para cobro usando total calculado de items reales
  const cobroBase = cobroRealTotal > 0 ? cobroRealTotal : (activeOrder?.total || 0);
  // Cobro por ítem (mig 128): subtotal de lo tildado + nombre de la caja elegida.
  const cobroSelTotal = cobroItems.reduce((s, it) => {
    const sel = cobroItemSel[it.id];
    return sel?.checked ? s + Math.min(sel.qty || 0, it._pend) * it._unit : s;
  }, 0);
  const cobroSelCount = cobroItems.filter(it => cobroItemSel[it.id]?.checked && (cobroItemSel[it.id]?.qty || 0) > 0).length;
  const cajaTurnoNombre = (t) => (cajasActivas.find(c => c.id === t?.caja_id)?.nombre) || t?.cajero_nombre || 'Caja';
  const noCajaAbierta = partialOn && openTurnos.length === 0;

  // Turno stats
  const turnoStats = useMemo(() => {
    // Bug-06: "cobrado" = solo pedidos realmente cobrados (payment_status='paid' o
    // entregados con método). NO contar un pedido sólo por tener payment_method
    // elegido en el QR (efectivo a cobrar en mesa) si aún está unpaid — eso lo
    // duplicaba en "Cobrados" y "Pendientes" a la vez. Ahora ambos son complementarios.
    const paid = turnoOrders.filter(o => (o.status === 'delivered' && o.payment_method) || o.payment_status === 'paid');
    const pendientes = turnoOrders.filter(o => !((o.status === 'delivered' && o.payment_method) || o.payment_status === 'paid'));
    const byMethod = { efectivo: 0, pos: 0, qr: 0, tarjeta: 0, otro: 0 };
    const cntMethod = { efectivo: 0, pos: 0, qr: 0, tarjeta: 0, otro: 0 };
    paid.forEach(o => {
      const m = o.payment_method;
      const t = Number(o.total || 0);
      if (m === 'efectivo') { byMethod.efectivo += t; cntMethod.efectivo++; }
      else if (m === 'pos' || m === 'pos_mesa') { byMethod.pos += t; cntMethod.pos++; }
      else if (m === 'qr') { byMethod.qr += t; cntMethod.qr++; }
      else if (m === 'tarjeta' || m === 'transferencia') { byMethod.tarjeta += t; cntMethod.tarjeta++; }
      else if (m) { byMethod.otro += t; cntMethod.otro++; }
    });
    return {
      pedidos: turnoOrders.length,
      mesas: new Set(turnoOrders.map(o => o.table_id).filter(Boolean)).size,
      total: turnoOrders.reduce((s, o) => s + Number(o.total || 0), 0),
      cobrados: paid.length,
      pendientes: pendientes.length,
      totalCobrado: paid.reduce((s, o) => s + Number(o.total || 0), 0),
      byMethod,
      cntMethod,
    };
  }, [turnoOrders]);

  /* ── ITEM STATUS BADGE ── */
  function itemStatusBadge(orderStatus, paymentStatus, deliveredAt) {
    if (paymentStatus === 'paid') return <span className="item-badge" style={{background:'var(--green-soft)',color:'var(--green)'}}>PAGADO ✓</span>;
    if (orderStatus === 'draft' || orderStatus === 'confirmed') return <span className="item-badge" style={{background:'var(--bg2)',color:'var(--text2)',border:'1px solid var(--border)'}}>Sin enviar</span>;
    if (orderStatus === 'ready') return <span className="item-badge item-badge-listo">Listo</span>;
    if (orderStatus === 'delivered') return <span className="item-badge item-badge-entregado">Entregado</span>;
    if (orderStatus === 'pending_payment') {
      // Entregado a la mesa → mostrar consumo entregado pendiente de cobro
      if (deliveredAt) return <span className="item-badge item-badge-entregado">Entregado · cobro pte.</span>;
      // Cocina despachó pero el mozo aún no retiró
      return <span className="item-badge item-badge-listo">Listo · retirar</span>;
    }
    if (orderStatus === 'cooking') return <span className="item-badge item-badge-cooking">Preparando</span>;
    return <span className="item-badge item-badge-prep">En cocina</span>;
  }

  /* ── SESSION GUARD ── */
  if (!mozoSession || !authOk) {
    return (
      <div className="loading-screen">
        <div className="spinner"></div>
        <div style={{ color: 'var(--text2)', fontSize: 14 }}>Verificando sesión...</div>
      </div>
    );
  }

  /* ── LOADING ── */
  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner"></div>
        <div style={{ color: 'var(--text2)', fontSize: 14 }}>Cargando panel del mozo...</div>
      </div>
    );
  }

  /* ── RENDER ── */
  return (
    <>
      {/* HEADER */}
      <header className="app-header">
        <div>
          <div className="brand">Mythos</div>
          {mozoSession && (
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 1 }}>
              {mozoSession.mozo_name} · desde {new Date(mozoSession.turno_inicio).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
            </div>
          )}
        </div>
        <div className="header-actions">
          {readyCount > 0 && (
            <span className="ready-count-badge" title={`${readyCount} pedido(s) listo(s) para entregar`}>{readyCount}</span>
          )}
          <div className="icon-btn" onClick={() => { setCurrentView('alertas'); const now = Date.now(); localStorage.setItem('mozo_bc_seen', now); lastSeenBroadcasts.current = now; }} title="Alertas">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
            {pendingAlerts > 0 && <span className="notif-badge">{pendingAlerts}</span>}
          </div>
          <div className="icon-btn" onClick={toggleDark} title={dark ? 'Cambiar a claro' : 'Cambiar a oscuro'}>
            {dark ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            )}
          </div>
          <div className="icon-btn" onClick={loadData} title="Actualizar">&#8635;</div>
        </div>
      </header>

      {/* MAIN */}
      <main className="main">

        {/* ─── MESAS ─── */}
        {currentView === 'mesas' && (
          <div>
            <div className="section-header">
              <div>
                <div className="section-title">Mesas</div>
                <div className="section-sub">
                  {tableScope === 'mine'
                    ? `${displayTables.length} de ${tables.length} · ${displayTables.filter(t => ordersMap[t.id]).length} activas`
                    : `${tables.length} mesas · ${Object.keys(ordersMap).length} activas`
                  }
                </div>
              </div>
              {/* Toggle vista */}
              <div style={{ display: 'flex', gap: 4, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 3 }}>
                <button onClick={() => { setMesaViewMode('grid'); setMapaEditMode(false); }}
                  style={{ padding: '5px 12px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer', background: mesaViewMode === 'grid' ? 'var(--text)' : 'transparent', color: mesaViewMode === 'grid' ? 'var(--bg)' : 'var(--text2)' }}>
                  <Icon name="layout" size={13} style={{ verticalAlign: '-2px', marginRight: 3 }} /> Cuadrícula
                </button>
                <button onClick={() => setMesaViewMode('mapa')}
                  style={{ padding: '5px 12px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer', background: mesaViewMode === 'mapa' ? 'var(--text)' : 'transparent', color: mesaViewMode === 'mapa' ? 'var(--bg)' : 'var(--text2)' }}>
                  <Icon name="pin" size={13} style={{ verticalAlign: '-2px', marginRight: 3 }} /> Mapa
                </button>
              </div>
            </div>
            {/* Toggle Mis mesas / Todas */}
            <div style={{ display: 'flex', gap: 6, padding: '0 16px 12px', alignItems: 'center' }}>
              <button
                onClick={() => setTableScope('all')}
                style={{ padding: '6px 14px', borderRadius: 20, border: '1.5px solid', borderColor: tableScope === 'all' ? 'var(--text)' : 'var(--border)', background: tableScope === 'all' ? 'var(--text)' : 'transparent', color: tableScope === 'all' ? 'var(--bg)' : 'var(--text2)', fontSize: 12, fontWeight: 700, cursor: 'pointer', transition: 'all 0.15s' }}>
                Todas
              </button>
              <button
                onClick={() => setTableScope('mine')}
                style={{ padding: '6px 14px', borderRadius: 20, border: '1.5px solid', borderColor: tableScope === 'mine' ? '#000' : 'var(--border)', background: tableScope === 'mine' ? '#000' : 'transparent', color: tableScope === 'mine' ? '#fff' : 'var(--text2)', fontSize: 12, fontWeight: 700, cursor: 'pointer', transition: 'all 0.15s' }}>
                Mis mesas
              </button>
              {tableScope === 'mine' && myName && (
                <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 4 }}>{myName}</span>
              )}
              {tableScope === 'mine' && !myName && (
                <span style={{ fontSize: 11, color: 'var(--red)' }}>Definí tu nombre en perfil</span>
              )}
            </div>

            <div style={{ display: 'flex', gap: 10, padding: '0 16px 16px', alignItems: 'stretch' }}>
              <div style={{ flex: 1, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }}>
                <div style={{ fontSize: 11, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600, marginBottom: 6 }}>Mesas a cobrar</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--text)', letterSpacing: '-0.5px' }}>{mesasACobrar}</div>
              </div>
              <div style={{ flex: 1, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }}>
                <div style={{ fontSize: 11, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600, marginBottom: 6 }}>Monto a cobrar</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', letterSpacing: '-0.5px' }}>{fGsK(montoACobrar)}</div>
              </div>
              <button
                onClick={openTransferModal}
                title="Transferir mesas a otro mozo"
                style={{ flexShrink: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '10px 14px', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, color: 'var(--text2)', fontWeight: 700 }}
              >
                <span style={{ fontSize: 18 }}>⇄</span>
                <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.3px', whiteSpace: 'nowrap' }}>Transferir</span>
              </button>
            </div>

            {pendingPaymentTables.length > 0 && (
              <div className="cobros-section">
                <div className="cobros-section-title">Cobros pendientes — {pendingPaymentTables.length} mesa(s)</div>
                {pendingPaymentTables.map(p => {
                  // requested=true → cliente eligió método de pago (solicitó cuenta de verdad).
                  // requested=false → cocina entregó pero nadie pidió la cuenta (solo listo a cobrar).
                  const bg = p.requested ? '#B45309' : '#1D1D1F';
                  return (
                  <div key={p.tableId} className="cobro-pending-row" onClick={() => openOrderView(p.tableId)} style={{ cursor: 'pointer' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--orange)' }}>Mesa {p.tableNum}</div>
                      <span style={{ fontSize: 11, background: bg, color: '#fff', borderRadius: 4, padding: '3px 8px', fontWeight: 700, letterSpacing: '0.02em' }}>{p.pmLabel}</span>
                    </div>
                    <div style={{ fontWeight: 800, fontSize: 14 }}>{fGs(p.total)}</div>
                  </div>
                  );
                })}
              </div>
            )}

            {!db && (
              <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text3)' }}>
                <div style={{ fontSize: 36, marginBottom: 12, color: 'var(--text3)' }}>○</div>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Sin conexión a Supabase</div>
                <div style={{ fontSize: 13 }}>Verificá las credenciales en config.js</div>
              </div>
            )}

            {/* ── Vista cuadrícula (existente) ── */}
            {mesaViewMode === 'grid' && (
              <>
                <div className="table-grid">
                  {displayTables.map(mesa => {
                    const status = getMesaStatus(mesa.id, ordersMap, callsMap, tablesById);
                    const order = ordersMap[mesa.id];
                    const itemCount = order?.order_items?.length || 0;
                    const sesTotal = sessionTotals[mesa.id] || 0;
                    const tbl = tablesById[mesa.id];
                    const occupiedMins = tbl?.occupied_since
                      ? Math.floor((Date.now() - new Date(tbl.occupied_since)) / 60000)
                      : null;
                    const showRetirar = status === 'lista';
                    const showCobrar = status === 'pendiente_pago';
                    const pm = order?.payment_method;
                    const pmLabel = pm === 'efectivo' ? 'EFECTIVO' : (pm === 'pos' || pm === 'tarjeta') ? 'POS' : pm === 'qr' ? 'QR' : pm === 'pos_mesa' ? 'POS MESA' : null;
                    const isOccupiedCard = ['ocupada','cocina','lista','pendiente_pago'].includes(status);
                    return (
                      <div key={mesa.id} className={`mesa-card ${status}`} onClick={() => handleMesaClick(mesa.id)}>
                        {itemCount > 0 && <div className="mesa-badge">{itemCount}</div>}
                        {showRetirar && <div className="cobrar-badge" style={{ background: '#248A3D' }}>RETIRAR</div>}
                        {showCobrar && <div className="cobrar-badge">COBRAR</div>}
                        {sesTotal > 0 && (
                          <div style={{ fontSize: 9, fontWeight: 700, color: isOccupiedCard ? 'rgba(255,255,255,0.75)' : 'var(--green)', marginBottom: 1, letterSpacing: '-0.3px' }}>
                            {fGsK(sesTotal)}
                          </div>
                        )}
                        <div className="mesa-num">{mesa.number}</div>
                        {occupiedMins !== null && status !== 'libre' && (
                          <div className={`mesa-time${occupiedMins >= 90 ? ' overtime' : ''}`}>
                            {occupiedMins} min
                          </div>
                        )}
                        <div className="mesa-label">{statusLabel(status)}</div>
                        {pmLabel && (
                          <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.3px', color: isOccupiedCard ? 'rgba(255,255,255,0.75)' : '#6E6E73', marginTop: 1 }}>{pmLabel}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="legend">
                  <div className="legend-item"><div className="legend-dot" style={{ background: 'transparent', border: '1px solid #D2D2D7' }}></div>Libre</div>
                  {/* WS4-B: dot "Ocupada" en var(--text-primary) (negro-marca en light,
                      casi-blanco en dark) — antes #000000 sólido quedaba invisible en dark. */}
                  <div className="legend-item"><div className="legend-dot" style={{ background: 'var(--text-primary)', border: '1px solid var(--text-primary)' }}></div>Ocupada</div>
                  <div className="legend-item"><div className="legend-dot" style={{ background: '#86868B', border: '1px solid #86868B' }}></div>En cocina</div>
                  <div className="legend-item"><div className="legend-dot" style={{ background: '#34C759', border: '1px solid #248A3D' }}></div>Retirar</div>
                  <div className="legend-item"><div className="legend-dot" style={{ background: '#FF9500', border: '1px solid #B45309' }}></div>Cobro pte.</div>
                  <div className="legend-item"><div className="legend-dot" style={{ background: '#FF3B30', border: '1px solid #FF3B30' }}></div>Alerta</div>
                </div>
              </>
            )}

            {/* ── Vista mapa de zonas ── */}
            {mesaViewMode === 'mapa' && (
              <div style={{ paddingBottom: 20 }}>
                {/* Barra de acciones del mapa */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px 14px' }}>
                  <div style={{ fontSize: 11, color: 'var(--text2)' }}>
                    {mapaEditMode ? 'Tocá una mesa para editarla' : 'Tocá una mesa para ver su estado'}
                  </div>
                  <button onClick={() => setMapaEditMode(e => !e)}
                    style={{ padding: '6px 14px', borderRadius: 20, border: '1.5px solid var(--border)', background: mapaEditMode ? 'var(--accent)' : 'transparent', color: mapaEditMode ? 'var(--bg)' : 'var(--text)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                    {mapaEditMode ? '✓ Editando' : '✎ Editar mesas'}
                  </button>
                </div>
                {displayTables.length === 0 && (
                  <div style={{ padding: '40px 16px', textAlign: 'center', color: '#C0C0C0', fontSize: 13 }}>
                    {tableScope === 'mine' ? 'No tenés mesas asignadas.' : 'No hay mesas configuradas.'}
                  </div>
                )}
                {(() => {
                  const zonaMap = {};
                  displayTables.forEach(t => { const z = t.zona || 'salon'; if (!zonaMap[z]) zonaMap[z] = []; zonaMap[z].push(t); });
                  const zonasToShow = ZONAS_DEF_M.filter(z => zonaMap[z.value]?.length > 0);
                  return zonasToShow.map(z => (
                    <ZonaMozo key={z.value}
                      zona={z.value}
                      tables={zonaMap[z.value] || []}
                      ordersMap={ordersMap}
                      callsMap={callsMap}
                      tablesById={tablesById}
                      sessionTotals={sessionTotals}
                      reservationByTable={reservationByTable}
                      editMode={mapaEditMode}
                      setTables={setTables}
                      onTableClick={handleMesaClick}
                      onEditTable={t => setMesaFormModal(t)}
                    />
                  ));
                })()}
              </div>
            )}

            {/* Modal de edición de mesa (solo vista mapa) */}
            {mesaFormModal && (
              <MesaEditModalM
                table={mesaFormModal}
                onSave={() => { setMesaFormModal(null); setMapaEditMode(false); loadData(); }}
                onClose={() => setMesaFormModal(null)}
              />
            )}
          </div>
        )}

        {/* ─── ORDEN ─── */}
        {currentView === 'orden' && (
          <div>
            {!activeTableId ? (
              <div className="no-order-state">
                <h3>Sin orden activa</h3>
                <p>Seleccioná una mesa con orden para gestionarla.</p>
                <button className="btn btn-primary" onClick={() => setCurrentView('mesas')}>← Ver mesas</button>
              </div>
            ) : !activeOrder && !activeTableOccupied ? (
              <div className="no-order-state">
                <h3>Sin orden activa</h3>
                <p>Seleccioná una mesa con orden para gestionarla.</p>
                <button className="btn btn-primary" onClick={() => setCurrentView('mesas')}>← Ver mesas</button>
              </div>
            ) : (
              <>
                <div className="order-header">
                  <div className="order-header-top">
                    <div className="order-title">{activeOrder ? 'Orden en curso' : 'Servicio activo'}</div>
                    <div className="order-actions">
                      <button className="order-action-btn" onClick={() => activeOrder ? openProductModal() : createOrder(activeTableId, activeTable?.number)} title={activeOrder ? 'Agregar ítems' : 'Nueva orden'}>＋</button>
                      {activeOrder && ['confirmed', 'draft'].includes(activeOrder.status) && (
                        <button className="order-action-btn" onClick={enviarACocina} title="Enviar a cocina">◷</button>
                      )}
                      {hasPendingCobro && (
                        <button className="order-action-btn primary-action" onClick={openCobroModal} title="Cobrar">₲</button>
                      )}
                      {activeOrder && (
                        // Mostrar ✓ sólo cuando hay acción real:
                        //  - ready / pending_payment sin delivered_to_table_at → confirmar entrega física
                        //  - entregada + pagada → cerrar ticket
                        // Si ya entregada y falta cobro, el botón a usar es $ (no ✓).
                        (['ready','pending_payment'].includes(activeOrder.status) && !activeOrder.delivered_to_table_at) ||
                        (activeOrder.payment_status === 'paid' && activeOrder.delivered_to_table_at && activeOrder.status !== 'delivered')
                      ) && (
                        <button className="order-action-btn" onClick={finalizarOrden} title={(activeOrder.payment_status === 'paid' && activeOrder.delivered_to_table_at) ? 'Finalizar orden' : 'Confirmar entrega a la mesa'}>&#10003;</button>
                      )}
                      <button className="order-action-btn" onClick={() => loadHistorial(activeTableId)} title="Historial">&#9776;</button>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <div className="order-mesa-btn">Mesa {activeTable?.number}</div>
                    {activeOrder && (
                      <div style={{ marginLeft: 'auto', fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
                        {orderStatusText(activeOrder.status, activeOrder.payment_status)}
                      </div>
                    )}
                    {sessionTotals[activeTableId] > 0 && (
                      <div style={{ marginLeft: activeOrder ? 0 : 'auto', fontSize: 12, color: 'rgba(100,255,150,0.9)', fontWeight: 700 }}>
                        Sesión: {fGs(sessionTotals[activeTableId])}
                      </div>
                    )}
                    <button
                      style={{ marginLeft: 'auto', background: 'rgba(52,199,89,0.2)', border: '1px solid rgba(52,199,89,0.5)', color: '#34C759', borderRadius: 8, padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                      onClick={() => liberarMesa(activeTableId)}
                    >Liberar mesa</button>
                  </div>
                </div>

                {activeOrder ? (
                  <>
                    <div className="order-info">
                      <div className="order-info-item">◷ {timeStr(activeOrder.created_at)}</div>
                      <div className="order-info-item" style={{ fontSize: 12 }}>{activeOrder.order_number}</div>
                      <div className={`order-status-badge ${orderStatusClass(activeOrder.status)}`}>
                        {orderStatusText(activeOrder.status, activeOrder.payment_status).toUpperCase()}
                      </div>
                    </div>

                    {/* Validación del pago por transferencia/QR (mig 182). El mozo ve el
                        comprobante (si el cliente lo subió) y aprueba/rechaza; al aprobar,
                        el pedido se libera a cocina (policy B lo tenía frenado). */}
                    {tableOrders.filter(o => o.payment_method === 'qr' || o.payment_method === 'transferencia').map(o => {
                      const meta = reviewMeta(o.payment_review_status);
                      const approved = o.payment_review_status === 'approved';
                      return (
                        <div key={'rev-' + o.id} style={{ background: 'var(--bg2)', border: `1px solid ${approved ? 'rgba(52,199,89,0.4)' : 'var(--border)'}`, borderRadius: 10, padding: '12px 14px', marginBottom: 10 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            {o.payment_proof_url && <ProofImage db={db} value={o.payment_proof_url} size={46} />}
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>Pago por transferencia · #{o.order_number}</div>
                              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                {meta
                                  ? <span style={{ color: meta.color, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: meta.color }} />{meta.label}</span>
                                  : <span style={{ color: '#FF9500', fontWeight: 700 }}>Esperando validación</span>}
                                {o.payment_reference && <span>· Comp. {o.payment_reference}</span>}
                              </div>
                              {o.payment_review_note && <div style={{ fontSize: 11, color: 'var(--text3)', fontStyle: 'italic', marginTop: 2 }}>“{o.payment_review_note}”</div>}
                              {!o.payment_proof_url && !approved && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>El cliente no adjuntó foto — verificá que la transferencia haya llegado antes de aprobar.</div>}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                            {!approved && <button onClick={() => doReview(o, 'approved')} style={{ flex: 1, background: 'rgba(52,199,89,0.14)', border: '1px solid rgba(52,199,89,0.4)', color: '#2FA84F', padding: '8px 10px', fontSize: 12, fontWeight: 700, borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' }}>✓ Aprobar pago</button>}
                            {o.payment_review_status !== 'rejected' && <button onClick={() => doReview(o, 'rejected')} style={{ flex: approved ? 1 : '0 0 auto', background: 'rgba(255,59,48,0.10)', border: '1px solid rgba(255,59,48,0.3)', color: '#FF3B30', padding: '8px 14px', fontSize: 12, fontWeight: 700, borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>✕ Rechazar</button>}
                          </div>
                        </div>
                      );
                    })}

                    <div className="items-list">
                      {tableOrders.length === 0 || tableOrders.every(o => (o.order_items||[]).length === 0) ? (
                        <div className="items-empty">
                          <div className="empty-icon">○</div>
                          <p>Sin productos en esta orden</p>
                          <button className="btn btn-indigo btn-sm" style={{ margin: '12px auto 0', display: 'inline-flex' }} onClick={openProductModal}>＋ Agregar productos</button>
                        </div>
                      ) : (
                        tableOrders.flatMap(ord =>
                          (ord.order_items || []).map(item => ({
                            ...item,
                            _orderId: ord.id,
                            _orderStatus: ord.status,
                            _paymentStatus: ord.payment_status,
                            _deliveredAt: ord.delivered_to_table_at,
                            _canRemove: ['confirmed', 'draft'].includes(ord.status) && ord.payment_status !== 'paid',
                            _lineTotal: Number(item.total_price) || Number((item.unit_price || 0)) * Number(item.quantity || 0),
                          }))
                        ).map(item => {
                          const isDelivered = item._orderStatus === 'delivered' || !!item._deliveredAt;
                          const isEditing = itemEditId === item.id;
                          return (
                            <div key={item.id} className="item-card">
                              <div className="item-top">
                                <div style={{ flex: 1 }}>
                                  <div className="item-name" style={{ color: isDelivered ? 'var(--text3)' : 'var(--text)' }}>
                                    {item._canRemove ? item.item_name : `${item.quantity}× ${item.item_name}`}
                                  </div>
                                  {!isEditing && item.observations && (
                                    <div className="item-note" onClick={() => { setItemEditId(item.id); setItemEditNote(item.observations || ''); }} style={{ cursor: 'pointer' }}>
                                      {item.observations} <span style={{ fontSize: 9, color: 'var(--text3)' }}>✎</span>
                                    </div>
                                  )}
                                  {!isEditing && !item.observations && (
                                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3, cursor: 'pointer' }} onClick={() => { setItemEditId(item.id); setItemEditNote(''); }}>
                                      + nota para cocina
                                    </div>
                                  )}
                                  {isEditing && (
                                    <div>
                                      <textarea
                                        className="item-note-edit"
                                        rows={2}
                                        autoFocus
                                        value={itemEditNote}
                                        onChange={e => setItemEditNote(e.target.value)}
                                        placeholder="Ej: sin cebolla, bien cocido, mitad pollo..."
                                      />
                                      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                                        <button onClick={() => saveItemNote(item.id, itemEditNote)} style={{ background: 'var(--text)', color: 'var(--bg)', border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Guardar</button>
                                        <button onClick={() => setItemEditId(null)} style={{ background: 'var(--bg2)', color: 'var(--text2)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>Cancelar</button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                                <div className="item-price">{fGs(item._lineTotal)}</div>
                                {item._canRemove ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginLeft: 6, flexShrink: 0 }}>
                                    <div className="qty-btn" style={{ width: 26, height: 26, borderRadius: 6, fontSize: 16 }} onClick={() => adjustItemQty(item.id, -1)}>−</div>
                                    <span style={{ fontSize: 14, fontWeight: 800, minWidth: 20, textAlign: 'center' }}>{item.quantity}</span>
                                    <div className="qty-btn" style={{ width: 26, height: 26, borderRadius: 6, fontSize: 16 }} onClick={() => adjustItemQty(item.id, 1)}>+</div>
                                    <div className="item-del" style={{ marginLeft: 2 }} onClick={() => removeItem(item.id)}>✕</div>
                                  </div>
                                ) : null}
                              </div>
                              <div className="item-status-row">
                                {itemStatusBadge(item._orderStatus, item._paymentStatus, item._deliveredAt)}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>

                    <div className="total-bar">
                      <div className="total-label">Total de la mesa</div>
                      <div className="total-amount">{fGs(tableTotal > 0 ? tableTotal : (activeOrder?.total || 0))}</div>
                    </div>

                    {/* Pedir más + Llamar a caja */}
                    <div className="actions-bar">
                      <button className="btn btn-primary" style={{ flex: 1 }} onClick={openProductModal}>
                        Pedir más
                      </button>
                      <button className="btn btn-secondary" style={{ flex: 1 }} onClick={callCaja}>
                        Llamar a caja
                      </button>
                    </div>
                  </>
                ) : (
                  /* Mesa ocupada pero sin orden activa */
                  <div style={{ padding: '24px 16px' }}>
                    <div style={{ background: 'var(--green-soft)', border: '1px solid var(--green)', borderRadius: 'var(--radius)', padding: '16px', marginBottom: 16, textAlign: 'center' }}>
                      <div style={{ fontSize: 22, marginBottom: 8, fontWeight: 800, color: 'var(--green)' }}>✓</div>
                      <div style={{ fontWeight: 700, color: 'var(--green)' }}>Todos los pedidos entregados</div>
                      <div style={{ fontSize: 13, color: 'var(--text2)', marginTop: 4 }}>
                        {sessionTotals[activeTableId] > 0 ? `Total consumido: ${fGs(sessionTotals[activeTableId])}` : 'Sin consumo registrado'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <button className="btn btn-indigo btn-full" onClick={() => createOrder(activeTableId, activeTable?.number)}>＋ Nueva orden</button>
                      <button
                        className="btn btn-full"
                        style={{ background: 'var(--green)', color: 'white' }}
                        onClick={() => liberarMesa(activeTableId)}
                      >Liberar mesa</button>
                      <button className="btn btn-secondary btn-full" onClick={() => loadHistorial(activeTableId)}>Ver historial del servicio</button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ─── ALERTAS ─── */}
        {currentView === 'alertas' && (
          <div>
            <div className="section-header">
              <div className="section-title">Alertas</div>
              {waiterCalls.length > 0 && (
                <button className="btn btn-secondary btn-sm" onClick={clearAlerts}>Limpiar todo</button>
              )}
            </div>
            <div className="alerts-list">
              {waiterCalls.length === 0 && broadcasts.length === 0 ? (
                <div className="alerts-empty">
                  <div className="empty-icon">○</div>
                  <p>Todo bajo control</p>
                </div>
              ) : (
                <>
                  {waiterCalls.map(call => (
                    <div key={call.id} className="alert-card urgente">
                      <div className="alert-icon">!</div>
                      <div className="alert-body">
                        <div className="alert-title">
                          {call.type === 'payment_request' ? 'Solicitud de cuenta' : 'Asistencia solicitada'}
                        </div>
                        <div className="alert-sub">
                          {call._tableNum != null ? `Mesa ${call._tableNum}` : 'Mesa desconocida'}
                        </div>
                        <div className="alert-time">hace {minAgo(call.created_at)} min</div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                          <button className="alert-action" onClick={() => handleAlertAction(call.id)}>Ya voy</button>
                          <button className="alert-action" style={{ background: 'var(--text2)' }} onClick={() => handleAlertAction(call.id)}>Atendida</button>
                        </div>
                      </div>
                    </div>
                  ))}
                  {broadcasts.length > 0 && (
                    <div style={{ marginTop: waiterCalls.length > 0 ? 16 : 0 }}>
                      {waiterCalls.length > 0 && <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '0 4px 8px' }}>Avisos del personal</div>}
                      {broadcasts.map(b => (
                        <div key={b.id} className="alert-card" style={{ borderLeft: '3px solid var(--blue, #007AFF)', marginBottom: 8 }}>
                          <div className="alert-body">
                            <div className="alert-title" style={{ fontSize: 12, color: 'var(--text2)' }}>{b.sender_name}</div>
                            <div style={{ fontSize: 14, color: 'var(--text)', marginTop: 2, lineHeight: 1.4 }}>{b.message}</div>
                            <div className="alert-time">{new Date(b.created_at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* ─── TURNO ─── */}
        {currentView === 'turno' && (
          <div>
            <div className="section-header">
              <div>
                <div className="section-title">Mi turno</div>
                <div className="section-sub">
                  {mozoSession?.mozo_name} · desde {new Date(mozoSession?.turno_inicio || turnoInicio).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-secondary btn-sm" onClick={loadTurnoData}>Actualizar</button>
                <button
                  className="btn btn-sm"
                  style={{ background: 'var(--text)', color: 'white', border: 'none' }}
                  onClick={async () => {
                    if (!db) return;
                    // Buscar órdenes activas sin cobrar del turno actual
                    const { data: pendientes } = await db.from('orders')
                      .select('id, order_number, total, table_id, order_items(id)')
                      .eq('restaurant_id', RID)
                      .not('status', 'in', '("cancelled","delivered")')
                      .neq('payment_status', 'paid');
                    const conItems = (pendientes || []).filter(o => (o.order_items || []).length > 0);
                    const vacias  = (pendientes || []).filter(o => (o.order_items || []).length === 0);

                    const doClose = async () => {
                      // Cancelar órdenes vacías automáticamente
                      for (const o of vacias) {
                        await db.from('orders').update({ status: 'cancelled' }).eq('id', o.id);
                      }
                      // Liberar todas las mesas ocupadas sin orden activa con ítems
                      const tablasConDeuda = new Set(conItems.map(o => o.table_id).filter(Boolean));
                      const { data: allOccupied } = await db.from('tables')
                        .select('id').eq('restaurant_id', RID).eq('is_occupied', true);
                      for (const t of (allOccupied || [])) {
                        if (!tablasConDeuda.has(t.id)) {
                          await db.from('tables').update({ is_occupied: false, occupied_since: null, assigned_waiter_name: null }).eq('id', t.id);
                        }
                      }
                      localStorage.removeItem('mozo_session');
                      localStorage.removeItem('turno_inicio');
                      try { await window.MythosPresence?.stop('manual'); } catch(_) {}
                      if (db) await db.auth.signOut();
                      window.location.replace('login.html');
                    };

                    if (conItems.length > 0) {
                      const mesaNums = conItems.map(o => {
                        const tbl = tablesById[o.table_id];
                        return `Mesa ${tbl?.number || '?'} (${fGsK(o.total || 0)})`;
                      }).join(', ');
                      setConfirmDialog({
                        title: 'Terminar turno',
                        body: `Quedan ${conItems.length} orden(es) sin cobrar: ${mesaNums}.\n\nEstas quedarán pendientes para caja. ¿Confirmar cierre de turno?`,
                        danger: true,
                        onOk: doClose,
                      });
                    } else {
                      setConfirmDialog({
                        title: 'Terminar turno',
                        body: 'Todas las órdenes están cobradas. ¿Confirmar cierre de turno?',
                        danger: false,
                        onOk: doClose,
                      });
                    }
                  }}
                >Terminar turno</button>
              </div>
            </div>

            {/* Registro del mozo */}
            <div style={{ margin: '0 16px 14px', background: '#000', borderRadius: 12, padding: '16px' }}>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>Mozo en turno</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 40, height: 40, borderRadius: 20, background: 'rgba(255,255,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>
                  {(mozoSession?.mozo_name || '?')[0].toUpperCase()}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: '#fff' }}>{mozoSession?.mozo_name || 'Sin nombre'}</div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>
                    Inicio: {new Date(mozoSession?.turno_inicio || turnoInicio).toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </div>
              {/* Campo para actualizar nombre visible del mozo */}
              <div style={{ marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 12 }}>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 6 }}>Cambiar nombre para este turno</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    id="mozo-name-input"
                    type="text"
                    placeholder="Tu nombre..."
                    defaultValue={mozoSession?.mozo_name || ''}
                    style={{ flex: 1, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 8, padding: '8px 12px', color: '#fff', fontSize: 14, fontFamily: 'inherit', outline: 'none' }}
                  />
                  <button
                    style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 8, padding: '8px 14px', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}
                    onClick={() => {
                      const input = document.getElementById('mozo-name-input');
                      const newName = input?.value?.trim();
                      if (!newName) return;
                      const updated = { ...mozoSession, mozo_name: newName };
                      localStorage.setItem('mozo_session', JSON.stringify(updated));
                      setMozoSession(updated);
                      showToast('Nombre actualizado: ' + newName);
                    }}
                  >Guardar</button>
                </div>
              </div>
            </div>

            <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* PR-16: las cifras de abajo son del restaurante en el turno (todos los
                  mozos), no individuales — aún no hay turno individual por mozo. */}
              <div style={{ fontSize: 11, color: 'var(--text2)' }}>
                Cifras del restaurante en el turno · todos los mozos
              </div>
              {/* Resumen rápido: grid 2x2 */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div className="turno-stat" style={{ padding: '12px 14px' }}>
                  <div className="turno-stat-label" style={{ fontSize: 11 }}>Pedidos</div>
                  <div className="turno-stat-value" style={{ fontSize: 22 }}>{turnoStats.pedidos}</div>
                </div>
                <div className="turno-stat" style={{ padding: '12px 14px' }}>
                  <div className="turno-stat-label" style={{ fontSize: 11 }}>Mesas</div>
                  <div className="turno-stat-value" style={{ fontSize: 22 }}>{turnoStats.mesas}</div>
                </div>
                <div className="turno-stat" style={{ padding: '12px 14px', borderColor: 'var(--green)', background: 'var(--green-soft)' }}>
                  <div className="turno-stat-label" style={{ fontSize: 11, color: 'var(--green)' }}>Cobrados</div>
                  <div className="turno-stat-value" style={{ fontSize: 22, color: 'var(--green)' }}>{turnoStats.cobrados}</div>
                </div>
                <div className="turno-stat" style={{ padding: '12px 14px', borderColor: turnoStats.pendientes > 0 ? 'var(--orange)' : 'var(--border)', background: turnoStats.pendientes > 0 ? 'var(--orange-soft)' : 'var(--surface)' }}>
                  <div className="turno-stat-label" style={{ fontSize: 11, color: turnoStats.pendientes > 0 ? 'var(--orange)' : 'var(--text2)' }}>Pendientes</div>
                  <div className="turno-stat-value" style={{ fontSize: 22, color: turnoStats.pendientes > 0 ? 'var(--orange)' : 'var(--text)' }}>{turnoStats.pendientes}</div>
                </div>
              </div>

              {/* PR-16: cobrado real del turno (pagado), no la suma con pendientes.
                  No llamar "facturado" a algo que incluye pendientes. */}
              <div className="turno-stat highlight">
                <div className="turno-stat-label">Cobrado en el turno</div>
                <div className="turno-stat-value">{fGs(turnoStats.totalCobrado)}</div>
              </div>

              {/* Desglose por método de pago */}
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px', marginTop: 4 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>Cobros por método</div>
                {[
                  { key: 'efectivo', icon: '₲', label: 'Efectivo', color: 'var(--green)' },
                  { key: 'pos',      icon: '▣', label: 'Tarjeta POS', color: 'var(--blue)' },
                  { key: 'qr',       icon: '▦', label: 'QR Mesa', color: 'var(--indigo)' },
                  { key: 'tarjeta',  icon: '↔', label: 'Transferencia', color: 'var(--text)' },
                ].map(m => {
                  const total = turnoStats.byMethod[m.key] || 0;
                  const cnt   = turnoStats.cntMethod[m.key] || 0;
                  const pct   = turnoStats.totalCobrado > 0 ? Math.round((total / turnoStats.totalCobrado) * 100) : 0;
                  return (
                    <div key={m.key} style={{ marginBottom: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ width: 22, height: 22, borderRadius: 6, background: 'var(--bg2)', color: m.color, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 12 }}>{m.icon}</span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{m.label}</span>
                          <span style={{ fontSize: 10, color: 'var(--text3)' }}>{cnt > 0 ? `· ${cnt}` : ''}</span>
                        </div>
                        <div style={{ fontSize: 14, fontWeight: 800, color: cnt > 0 ? 'var(--text)' : 'var(--text3)' }}>{fGs(total)}</div>
                      </div>
                      <div style={{ height: 4, background: 'var(--bg2)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ width: pct + '%', height: '100%', background: m.color, transition: 'width 0.3s' }}></div>
                      </div>
                    </div>
                  );
                })}
                {turnoStats.byMethod.otro > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text3)', marginTop: 6 }}>
                    <span>Otros</span>
                    <span style={{ fontWeight: 700 }}>{fGs(turnoStats.byMethod.otro)}</span>
                  </div>
                )}
                {turnoStats.cobrados === 0 && (
                  <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--text3)', padding: 6 }}>
                    Sin cobros en este turno
                  </div>
                )}
              </div>

              {/* Sesión: inicio + duración */}
              <div style={{ background: 'var(--bg2)', borderRadius: 12, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Inicio de turno</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginTop: 2 }}>
                    {new Date(mozoSession?.turno_inicio || turnoInicio).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Duración</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginTop: 2 }}>
                    {(() => {
                      const start = new Date(mozoSession?.turno_inicio || turnoInicio).getTime();
                      const mins = Math.floor((Date.now() - start) / 60000);
                      const h = Math.floor(mins / 60);
                      const m = mins % 60;
                      return h > 0 ? `${h}h ${m}m` : `${m}m`;
                    })()}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Ticket promedio</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginTop: 2 }}>
                    {fGs(turnoStats.cobrados > 0 ? Math.round(turnoStats.totalCobrado / turnoStats.cobrados) : 0)}
                  </div>
                </div>
              </div>
            </div>

            <div style={{ padding: '0 16px 8px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>Órdenes del turno</div>
              {loadingTurno ? (
                <div style={{ textAlign: 'center', padding: 30 }}><div className="spinner" style={{ margin: '0 auto' }}></div></div>
              ) : turnoOrders.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text3)' }}>Sin órdenes en este turno</div>
              ) : (
                turnoOrders.map(ord => {
                  const isPaid = ord.status === 'delivered' && ord.payment_method;
                  const pmLabel = ord.payment_method === 'efectivo' ? 'Efectivo' : ord.payment_method === 'pos' || ord.payment_method === 'tarjeta' ? 'POS' : ord.payment_method === 'qr' ? 'QR' : ord.payment_method;
                  return (
                  <div key={ord.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <div>
                        <span style={{ fontSize: 12, fontWeight: 700 }}>{ord.order_number}</span>
                        <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 8 }}>{timeStr(ord.created_at)}</span>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 14, fontWeight: 800 }}>{fGs(ord.total)}</div>
                        {isPaid && <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--green)', textTransform: 'uppercase' }}>{pmLabel} ✓</div>}
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                      {(ord.order_items || []).slice(0, 3).map(i => `${i.quantity}× ${i.item_name}`).join(', ')}
                      {(ord.order_items || []).length > 3 ? ` +${(ord.order_items || []).length - 3} más` : ''}
                    </div>
                    {ord.paid_by_name && (
                      <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>
                        Cobrado por: <span style={{ fontWeight: 700 }}>{ord.paid_by_name}</span>
                        {ord.paid_at && ` · ${timeStr(ord.paid_at)}`}
                      </div>
                    )}
                  </div>
                  );
                })
              )}
            </div>
          </div>
        )}

      </main>

      {/* BOTTOM NAV */}
      <nav className="bottom-nav">
        <div className={`nav-item ${currentView === 'mesas' ? 'active' : ''}`} onClick={() => setCurrentView('mesas')}>
          <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
          Mesas
        </div>
        <div className={`nav-item ${currentView === 'orden' ? 'active' : ''}`} onClick={() => setCurrentView('orden')}>
          <svg viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2M9 12h6M9 16h4"/></svg>
          Orden
          {activeOrder && activeOrder.order_items?.length > 0 && (
            <span className="nav-badge show">{activeOrder.order_items.length}</span>
          )}
        </div>
        <div className={`nav-item ${currentView === 'alertas' ? 'active' : ''}`} onClick={() => { setCurrentView('alertas'); const now = Date.now(); localStorage.setItem('mozo_bc_seen', now); lastSeenBroadcasts.current = now; }}>
          <svg viewBox="0 0 24 24"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/></svg>
          Alertas
          {pendingAlerts > 0 && <span className="nav-badge show">{pendingAlerts}</span>}
        </div>
        <div className={`nav-item ${currentView === 'turno' ? 'active' : ''}`} onClick={() => setCurrentView('turno')}>
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          Turno
        </div>
      </nav>

      {/* ─── MODAL: HISTORIAL DE SERVICIO ─── */}
      {historialModal && (
        <div className="modal-overlay open" onClick={e => { if (e.target.classList.contains('modal-overlay')) setHistorialModal(false); }}>
          <div className="modal">
            <div className="modal-handle"></div>
            <div className="modal-header">
              <div className="modal-title">Historial — Mesa {activeTable?.number}</div>
              <div className="modal-close" onClick={() => setHistorialModal(false)}>✕</div>
            </div>
            <div className="modal-body">
              {loadingHistorial && <div style={{ textAlign: 'center', padding: 30 }}><div className="spinner"></div></div>}
              {!loadingHistorial && historialOrders.length === 0 && (
                <div style={{ textAlign: 'center', padding: 30, color: 'var(--text3)' }}>Sin órdenes en esta sesión</div>
              )}
              {!loadingHistorial && historialOrders.map((ord, idx) => (
                <div key={ord.id} style={{ marginBottom: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <div>
                      <span style={{ fontSize: 12, fontWeight: 700 }}>#{ord.order_number}</span>
                      <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 8 }}>◷ {timeStr(ord.created_at)}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {(ord.payment_status === 'paid' || (ord.status === 'delivered' && ord.payment_method)) && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--green)', background: 'var(--green-soft)', padding: '2px 6px', borderRadius: 4 }}>PAGADO ✓</span>
                      )}
                      {ord.payment_status !== 'paid' && !ord.payment_method && (ord.status === 'pending_payment' || (ord.status === 'delivered')) && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--orange)', background: 'var(--orange-soft)', padding: '2px 6px', borderRadius: 4 }}>SIN COBRO</span>
                      )}
                      <div style={{ fontSize: 13, fontWeight: 800, color: (ord.payment_status === 'paid' || (ord.status === 'delivered' && ord.payment_method)) ? 'var(--green)' : 'var(--orange)' }}>
                        {fGs(Number(ord.total) > 0 ? ord.total : (ord.order_items || []).reduce((s, i) => s + Number(i.total_price || 0), 0))}
                      </div>
                    </div>
                  </div>
                  {(ord.order_items || []).map(it => (
                    <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 8px', background: 'var(--bg2)', borderRadius: 6, marginBottom: 3 }}>
                      <span>{it.quantity}× {it.item_name}</span>
                      <span style={{ color: 'var(--text2)' }}>{fGs(it.total_price)}</span>
                    </div>
                  ))}
                  {idx < historialOrders.length - 1 && <div style={{ height: 1, background: 'var(--border)', margin: '10px 0' }}></div>}
                </div>
              ))}
              {!loadingHistorial && historialOrders.length > 0 && (
                <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text2)' }}>Total del servicio</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text)' }}>
                    {fGs(historialOrders.reduce((s, o) => {
                      const t = Number(o.total) > 0 ? Number(o.total) : (o.order_items || []).reduce((si, i) => si + Number(i.total_price || 0), 0);
                      return s + t;
                    }, 0))}
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary btn-full" onClick={() => setHistorialModal(false)}>Cerrar</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── MODAL: PRODUCTOS ─── */}
      {productModal && (
        <div className="modal-overlay open" onClick={e => { if (e.target.classList.contains('modal-overlay')) setProductModal(false); }}>
          <div className="modal">
            <div className="modal-handle"></div>
            <div className="modal-header">
              <div className="modal-title">Agregar a Mesa {activeTable?.number}</div>
              <div className="modal-close" onClick={() => setProductModal(false)}>✕</div>
            </div>
            <div className="modal-body">
              <div className="search-box">
                <Icon name="search" size={14} style={{ color: 'var(--text3)' }} />
                <input
                  type="text"
                  placeholder="Buscar producto..."
                  value={productSearch}
                  onChange={e => setProductSearch(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="category-chips">
                {['Todos', ...categories].map(c => (
                  <div key={c} className={`chip ${activeCategory === c ? 'active' : ''}`} onClick={() => setActiveCategory(c)}>{c}</div>
                ))}
              </div>

              {/* ── DESTACADO DEL DÍA ── */}
              {showPromosSection && featuredItem && (
                <>
                  <div className="promo-section-title">
                    <span>★</span> Destacado del día
                  </div>
                  <div className="featured-card" onClick={() => setSelectedProducts(prev => ({ ...prev, [featuredItem.id]: (prev[featuredItem.id] || 0) + 1 }))}>
                    <div className="feat-img">
                      {featuredItem.image_url
                        ? <img src={featuredItem.image_url} alt={featuredItem.name} />
                        : <span style={{ fontSize: 22, color: 'rgba(255,255,255,0.5)' }}>★</span>}
                    </div>
                    <div className="feat-info">
                      <div className="feat-tag">
                        {promoLabel(featuredItem) || 'Recomendado del chef'}
                      </div>
                      <div className="feat-name">{featuredItem.name}</div>
                      <div className="feat-price">
                        {Number(featuredItem.discount_pct) > 0 && (
                          <span style={{ textDecoration: 'line-through', marginRight: 6, opacity: 0.5 }}>
                            {fGs(featuredItem.price_guarani)}
                          </span>
                        )}
                        <span style={{ color: '#fff', fontWeight: 700 }}>{fGs(effectivePrice(featuredItem))}</span>
                      </div>
                    </div>
                    <div className="feat-add">＋</div>
                  </div>
                </>
              )}

              {/* ── PROMOCIONES DISPONIBLES ── */}
              {showPromosSection && promoItems.length > 0 && (
                <>
                  <div className="promo-section-title">
                    <span style={{ color: 'var(--orange)' }}><Icon name="tag" size={14} style={{ verticalAlign: '-2px' }} /></span> Promociones disponibles
                  </div>
                  <div className="promo-strip">
                    {promoItems.map(p => {
                      const lbl = promoLabel(p);
                      const hasDisc = Number(p.discount_pct) > 0;
                      return (
                        <div
                          key={'promo-' + p.id}
                          className={`promo-pill ${hasDisc ? 'disc' : ''}`}
                          onClick={() => setSelectedProducts(prev => ({ ...prev, [p.id]: (prev[p.id] || 0) + 1 }))}
                        >
                          {lbl && <span className="pill-badge">{lbl}</span>}
                          <div className="pill-name">{p.name}</div>
                          <div className="pill-price">
                            {hasDisc && <span className="pill-old">{fGs(p.price_guarani)}</span>}
                            <span style={{ fontWeight: 700, color: 'var(--text)' }}>{fGs(effectivePrice(p))}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {showPromosSection && (
                <div className="promo-section-title">
                  <Icon name="book" size={14} style={{ verticalAlign: '-2px' }} /> Todo el menú
                </div>
              )}

              <div>
                {filteredMenu.map(p => {
                  const qty = selectedProducts[p.id] || 0;
                  const hasExtras = (extrasMap[p.id] || []).length > 0;
                  const lbl = promoLabel(p);
                  const hasDisc = Number(p.discount_pct) > 0;
                  return (
                    <div key={p.id}>
                      <div className="product-item">
                        <div className="product-img">
                          {p.image_url ? <img src={p.image_url} alt={p.name} /> : <span style={{ fontSize: 18, color: 'var(--text3)' }}>○</span>}
                        </div>
                        <div className="product-info">
                          <div className="product-name">
                            {p.name}
                            {lbl && (
                              <span className={`promo-badge ${hasDisc ? 'disc' : p.promo_type ? 'type' : ''}`}>{lbl}</span>
                            )}
                          </div>
                          <div className="product-price">
                            {hasDisc && (
                              <span style={{ textDecoration: 'line-through', color: 'var(--text3)', marginRight: 6, fontSize: 12 }}>
                                {fGs(p.price_guarani)}
                              </span>
                            )}
                            {fGs(effectivePrice(p))}
                          </div>
                        </div>
                        {qty === 0 ? (
                          <div className="product-add-btn" onClick={() => setSelectedProducts(prev => ({ ...prev, [p.id]: 1 }))}>+</div>
                        ) : (
                          <div className="product-qty-ctrl">
                            <div className="qty-btn" onClick={() => setSelectedProducts(prev => {
                              const next = { ...prev };
                              if (next[p.id] > 1) next[p.id]--; else delete next[p.id];
                              return next;
                            })}>−</div>
                            <div className="qty-num">{qty}</div>
                            <div className="qty-btn" onClick={() => setSelectedProducts(prev => ({ ...prev, [p.id]: (prev[p.id] || 0) + 1 }))}>+</div>
                          </div>
                        )}
                      </div>
                      {qty > 0 && (
                        <div className="product-extras">
                          <textarea
                            className="product-note-field"
                            rows={1}
                            placeholder="Notas: sin sal, bien cocido..."
                            value={itemNotes[p.id] || ''}
                            onChange={e => setItemNotes(prev => ({ ...prev, [p.id]: e.target.value }))}
                          />
                          {hasExtras && (
                            <div>
                              {(extrasMap[p.id] || []).map(extra => (
                                <label key={extra.id} className="extra-check-label">
                                  <input
                                    type="checkbox"
                                    checked={!!(itemExtras[p.id]?.[extra.id])}
                                    onChange={e => setItemExtras(prev => ({
                                      ...prev,
                                      [p.id]: { ...(prev[p.id] || {}), [extra.id]: e.target.checked }
                                    }))}
                                  />
                                  {extra.name}
                                  {extra.price_guarani > 0 && (
                                    <span style={{ color: 'var(--text3)', marginLeft: 2 }}>+{fGs(extra.price_guarani)}</span>
                                  )}
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {filteredMenu.length === 0 && (
                  <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text3)' }}>Sin resultados</div>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-indigo btn-full"
                onClick={confirmAddProducts}
                disabled={selectedCount === 0}
              >
                Agregar {selectedCount} ítem(s) · {fGs(selectedTotal)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── MODAL: COBRO ─── */}
      {cobroModal && (
        <div className="modal-overlay open">
          <div className="modal">
            <div className="modal-handle"></div>
            <div className="modal-header">
              <div className="modal-title">Cobro — Mesa {activeTable?.number}</div>
              <div className="modal-close" onClick={() => setCobroModal(false)}>✕</div>
            </div>
            <div className="modal-body">
              {/* Caja a la que se rinde el cobro (el mozo recauda y entra al arqueo) */}
              {partialOn && (
                openTurnos.length === 0 ? (
                  <div style={{ background: 'rgba(255,59,48,0.08)', border: '1px solid rgba(255,59,48,0.3)', borderRadius: 8, padding: '10px 12px', marginBottom: 12, fontSize: 12.5, color: 'var(--red, #FF3B30)', fontWeight: 600 }}>
                    No hay caja abierta — pedí que abran una caja para cobrar.
                  </div>
                ) : openTurnos.length === 1 ? (
                  <div style={{ background: 'var(--bg2)', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 12.5, color: 'var(--text2)' }}>
                    Se rinde a la caja <strong style={{ color: 'var(--text)' }}>{cajaTurnoNombre(openTurnos[0])}</strong>
                  </div>
                ) : (
                  <div style={{ marginBottom: 12 }}>
                    <div className="section-label">Caja para el cobro</div>
                    <select value={selTurnoId || ''} onChange={e => setSelTurnoId(e.target.value || null)}
                      style={{ width: '100%', height: 40, border: '1px solid var(--border)', borderRadius: 8, padding: '0 10px', fontSize: 13, fontFamily: 'inherit', color: 'var(--text)', background: 'var(--bg2)' }}>
                      <option value="">Elegí una caja…</option>
                      {openTurnos.map(t => <option key={t.id} value={t.id}>{cajaTurnoNombre(t)} · {t.cajero_nombre || 'cajero'}</option>)}
                    </select>
                  </div>
                )
              )}
              <div className="section-label">Consumo de la mesa</div>
              {cobroItems.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text3)', fontSize: 13 }}>
                  <div style={{ fontSize: 24, marginBottom: 8 }}>○</div>
                  Sin ítems pendientes de pago
                </div>
              ) : cobroItems.map(item => {
                const partes = fraccionStates[item.id];
                const sel = cobroItemSel[item.id] || { checked: true, qty: item._pend };
                const pend = (item._pend ?? (Number(item.quantity) || 0));
                const itemTotal = (partialOn ? Math.min(sel.qty || 0, pend) : 1) * (item._unit || 0) || item._lineTotal || (Number(item.total_price) || Number((item.unit_price || 0)) * Number(item.quantity || 0));
                const toggleItem = () => setCobroItemSel(prev => ({ ...prev, [item.id]: { checked: !(prev[item.id]?.checked ?? true), qty: prev[item.id]?.qty || pend } }));
                const setItemQty = v => setCobroItemSel(prev => ({ ...prev, [item.id]: { checked: true, qty: Math.max(1, Math.min(pend, parseInt(v) || 1)) } }));
                return (
                  <div key={item.id}>
                    <div className="pay-item">
                      {partialOn && (
                        <input type="checkbox" checked={sel.checked} onChange={toggleItem}
                          style={{ width: 18, height: 18, flexShrink: 0, accentColor: 'var(--indigo, #5856D6)', cursor: 'pointer' }} />
                      )}
                      <div style={{ fontSize: 11, color: 'var(--text3)', width: 24, flexShrink: 0 }}>{pend}×</div>
                      <div className="pay-item-name">
                        {item.item_name}
                        {partialOn && (item._paid > 0) && <span style={{ fontSize: 10, color: 'var(--green, #34C759)', marginLeft: 5 }}>({item._paid} pago/s)</span>}
                        {item.observations && <div style={{ fontSize: 10, color: 'var(--text3)', fontStyle: 'italic', marginTop: 1 }}>{item.observations}</div>}
                      </div>
                      {partialOn && pend > 1 && (
                        <input type="number" min={1} max={pend} value={sel.qty} onChange={e => setItemQty(e.target.value)}
                          onClick={e => e.stopPropagation()}
                          style={{ width: 46, padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, textAlign: 'center', fontFamily: 'inherit', flexShrink: 0, marginRight: 4, background: 'var(--bg2)', color: 'var(--text)' }} />
                      )}
                      <div className="pay-item-price">{fGs(itemTotal)}</div>
                      <button
                        onClick={() => setFraccionStates(prev => ({ ...prev, [item.id]: prev[item.id] ? null : 2 }))}
                        style={{ marginLeft: 6, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 7px', fontSize: 12, cursor: 'pointer', color: 'var(--text2)', flexShrink: 0 }}
                        title="Fraccionar"
                      >÷</button>
                    </div>
                    {partes && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0 8px 24px', fontSize: 13, color: 'var(--text2)' }}>
                        <span>Dividir en</span>
                        <input
                          type="number" min={2} max={20}
                          value={partes}
                          onChange={e => setFraccionStates(prev => ({ ...prev, [item.id]: Math.max(2, Math.min(20, parseInt(e.target.value)||2)) }))}
                          style={{ width: 48, padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, textAlign: 'center', fontFamily: 'inherit' }}
                        />
                        <span>partes →</span>
                        <span style={{ fontWeight: 700, color: 'var(--text)' }}>{fGs(Math.round(itemTotal / partes))} c/parte</span>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Dividir cuenta por personas */}
              <div className="tip-section">
                <div className="section-label">Dividir cuenta</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button onClick={() => setDividirPersonas(p => Math.max(1, p-1))} style={{ width: 32, height: 32, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg2)', cursor: 'pointer', fontSize: 16, fontWeight: 700, fontFamily: 'inherit' }}>−</button>
                    <span style={{ fontSize: 18, fontWeight: 700, minWidth: 28, textAlign: 'center' }}>{dividirPersonas}</span>
                    <button onClick={() => setDividirPersonas(p => Math.min(20, p+1))} style={{ width: 32, height: 32, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg2)', cursor: 'pointer', fontSize: 16, fontWeight: 700, fontFamily: 'inherit' }}>+</button>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text2)' }}>personas</div>
                </div>
                {dividirPersonas > 1 && (
                  <div style={{ background: 'var(--bg2)', borderRadius: 8, padding: '10px 12px', fontSize: 14 }}>
                    Cada persona paga: <span style={{ fontWeight: 800, color: 'var(--text)', fontSize: 16 }}>{fGs(Math.round(cobroBase / dividirPersonas))}</span>
                  </div>
                )}
              </div>

              {/* La propina no entra al cobro por ítem (la RPC cobra el subtotal de los ítems).
                  Solo se ofrece en el cobro clásico para no mostrar un total que no se recauda. */}
              {!partialOn && (
                <div className="tip-section">
                  <div className="section-label">Propina</div>
                  <div className="tip-chips">
                    {[0, 5, 10, 15].map(pct => (
                      <div key={pct} className={`tip-chip ${tipPct === pct ? 'active' : ''}`} onClick={() => setTipPct(pct)}>{pct}%</div>
                    ))}
                  </div>
                </div>
              )}

              <div className="tip-section">
                <div className="section-label">Método de pago</div>
                <div className="payment-methods">
                  {[
                    { key: 'efectivo', icon: '₲', label: 'Efectivo' },
                    { key: 'tarjeta_credito', icon: '▣', label: 'Tarjeta Créd.' },
                    { key: 'tarjeta_debito', icon: '▣', label: 'Tarjeta Déb.' },
                    { key: 'qr', icon: '▦', label: 'QR / Transf.' },
                  ].map(m => (
                    <div key={m.key} className={`pay-method ${payMethod === m.key ? 'active' : ''}`} onClick={() => setPayMethod(m.key)}>
                      <div className="pay-icon">{m.icon}</div>
                      {m.label}
                    </div>
                  ))}
                </div>
              </div>

              {/* Nº de comprobante (tarjeta POS / transferencia) — opcional, mig 180 */}
              {(payMethod === 'tarjeta_credito' || payMethod === 'tarjeta_debito' || payMethod === 'qr') && (
                <div className="tip-section">
                  <div className="section-label">N° de comprobante / operación <span style={{ fontWeight: 400, color: 'var(--text3)' }}>(opcional)</span></div>
                  <input value={comprobante} onChange={e => setComprobante(e.target.value)}
                    placeholder={payMethod === 'qr' ? 'N° de operación de la transferencia' : 'N° del comprobante del POS'}
                    style={{ width: '100%', height: 38, border: '1px solid var(--border)', borderRadius: 7, padding: '0 10px', fontSize: 13, fontFamily: 'inherit', color: 'var(--text)', outline: 'none', background: 'var(--bg2)', boxSizing: 'border-box' }} />
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>Para revisar después si el pago llegó. Podés dejarlo vacío.</div>
                  <div style={{ marginTop: 12 }}>
                    <ComprobanteUploader db={db} restaurantId={RID} value={proofUrl} onChange={setProofUrl} onMsg={(m) => showToast(m)} />
                  </div>
                </div>
              )}

              {/* Datos para la transferencia (los carga el dueño en Admin → Configuración) — mig 180 */}
              {payMethod === 'qr' && (() => {
                const hasData = bankInfo && (bankInfo.bank_holder || bankInfo.bank_name || bankInfo.bank_account || bankInfo.bank_alias || bankInfo.bank_qr_url);
                if (!hasData) return (
                  <div className="tip-section">
                    <div style={{ padding: '10px 12px', background: 'var(--bg2)', border: '1px dashed var(--border)', borderRadius: 8, fontSize: 12, color: 'var(--text2)', lineHeight: 1.5 }}>
                      El dueño todavía no cargó los datos de transferencia. Se configuran en <strong>Admin → Configuración → Datos para transferencias</strong>.
                    </div>
                  </div>
                );
                return (
                  <div className="tip-section">
                    <div className="section-label">Datos para la transferencia</div>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                      <div style={{ flex: 1, fontSize: 13, lineHeight: 1.6, color: 'var(--text)', wordBreak: 'break-word' }}>
                        {bankInfo.bank_holder && <div><span style={{ color: 'var(--text3)' }}>Titular:</span> <strong>{bankInfo.bank_holder}</strong></div>}
                        {bankInfo.bank_name && <div><span style={{ color: 'var(--text3)' }}>Banco:</span> {bankInfo.bank_name}</div>}
                        {bankInfo.bank_account && <div><span style={{ color: 'var(--text3)' }}>Cuenta:</span> {bankInfo.bank_account}</div>}
                        {bankInfo.bank_alias && <div><span style={{ color: 'var(--text3)' }}>Alias:</span> {bankInfo.bank_alias}</div>}
                        {bankInfo.bank_doc && <div><span style={{ color: 'var(--text3)' }}>CI/RUC:</span> {bankInfo.bank_doc}</div>}
                      </div>
                      {bankInfo.bank_qr_url && (
                        <img src={bankInfo.bank_qr_url} alt="QR transferencia" style={{ width: 96, height: 96, objectFit: 'contain', borderRadius: 8, border: '1px solid var(--border)', background: '#fff', flexShrink: 0 }} />
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>Mostrale estos datos al cliente. Si hay QR, puede escanearlo y transferir directo.</div>
                  </div>
                );
              })()}

              {/* Comprobante */}
              <div className="tip-section">
                <div className="section-label">Comprobante</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: invoiceType !== 'none' ? 10 : 0 }}>
                  {[['none','Sin comp.'],['ticket','Ticket'],['fiscal','Factura fiscal']].map(([v,lbl]) => (
                    <div key={v} className={`tip-chip ${invoiceType === v ? 'active' : ''}`} style={{ fontSize: 11, lineHeight: 1.3, padding: '8px 4px' }} onClick={() => setInvoiceType(v)}>{lbl}</div>
                  ))}
                </div>
                {invoiceType !== 'none' && (
                  <div style={{ marginBottom: 10 }}>
                    <div className="section-label" style={{ fontSize: 11, marginBottom: 5 }}>¿Cómo recibe el cliente?</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                      {[['print','Impreso'],['email','Email']].map(([v,lbl]) => (
                        <div key={v} className={`tip-chip ${invoiceDelivery === v ? 'active' : ''}`} style={{ fontSize: 11, padding: '8px 4px' }} onClick={() => setInvoiceDelivery(v)}>{lbl}</div>
                      ))}
                    </div>
                  </div>
                )}
                {invoiceType === 'ticket' && (
                  <div style={{ padding: '8px 12px', background: 'rgba(0,122,255,0.07)', border: '1px solid rgba(0,122,255,0.2)', borderRadius: 8, fontSize: 12, color: 'var(--text2)' }}>
                    {invoiceDelivery === 'email' ? 'Caja enviará el ticket por email al cliente.' : 'Indicá en caja que el cliente pidió ticket impreso.'}
                  </div>
                )}
                {invoiceType === 'fiscal' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <input value={invName} onChange={e => setInvName(e.target.value)} placeholder="Nombre / razón social" style={{ height: 38, border: '1px solid var(--border)', borderRadius: 7, padding: '0 10px', fontSize: 13, fontFamily: 'inherit', color: 'var(--text)', outline: 'none', background: 'var(--bg2)' }} />
                    <input value={invRuc} onChange={e => setInvRuc(e.target.value)} placeholder="RUC / Cédula" style={{ height: 38, border: '1px solid var(--border)', borderRadius: 7, padding: '0 10px', fontSize: 13, fontFamily: 'inherit', color: 'var(--text)', outline: 'none', background: 'var(--bg2)' }} />
                    <input type="email" value={invEmail} onChange={e => setInvEmail(e.target.value)} placeholder="Email para factura electrónica" style={{ height: 38, border: '1px solid var(--border)', borderRadius: 7, padding: '0 10px', fontSize: 13, fontFamily: 'inherit', color: 'var(--text)', outline: 'none', background: 'var(--bg2)' }} />
                  </div>
                )}
              </div>

              <div className="pay-summary">
                {partialOn ? (
                  <>
                    <div className="pay-row"><span>Seleccionado ({cobroSelCount})</span><span style={{ fontWeight: 700 }}>{fGs(cobroSelTotal)}</span></div>
                    <div className="pay-row total"><span>Total mesa</span><span style={{ fontSize: 24, fontWeight: 800, color: 'var(--text)' }}>{fGs(cobroBase)}</span></div>
                  </>
                ) : (
                  <>
                    <div className="pay-row"><span>Total mesa</span><span>{fGs(cobroBase)}</span></div>
                    <div className="pay-row"><span>Propina ({tipPct}%)</span><span>{fGs(Math.round(cobroBase * tipPct / 100))}</span></div>
                    <div className="pay-row total"><span>Total a pagar</span><span style={{ fontSize: 24, fontWeight: 800, color: 'var(--text)' }}>{fGs(Math.round(cobroBase * (1 + tipPct/100)))}</span></div>
                  </>
                )}
              </div>
            </div>
            <div className="modal-footer">
              {partialOn ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
                  <button className="btn btn-indigo btn-full" disabled={cobroBusy || noCajaAbierta || cobroSelCount === 0}
                    style={(cobroBusy || noCajaAbierta || cobroSelCount === 0) ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
                    onClick={() => processPay(false)}>
                    {cobroBusy ? 'Procesando…' : `Cobrar seleccionados — ${fGs(cobroSelTotal)}`}
                  </button>
                  <button className="btn btn-secondary btn-full" disabled={cobroBusy || noCajaAbierta || cobroItems.length === 0}
                    style={(cobroBusy || noCajaAbierta || cobroItems.length === 0) ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
                    onClick={() => processPay(true)}>
                    Cobrar toda la mesa — {fGs(cobroBase)}
                  </button>
                </div>
              ) : (
                <button className="btn btn-indigo btn-full" disabled={cobroBusy}
                  style={cobroBusy ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
                  onClick={() => processPay(true)}>
                  Cobrar {fGs(Math.round(cobroBase * (1 + tipPct/100)))} →
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─── MODAL: TRANSFERIR MESAS ─── */}
      {transferModal && (() => {
        const mesasOcupadas = tables.filter(t => getMesaStatus(t.id, ordersMap, callsMap, tablesById) !== 'libre');
        const allSelected = mesasOcupadas.length > 0 && mesasOcupadas.every(t => transferSelectedTables.has(t.id));
        const canConfirm = transferSelectedTables.size > 0 && transferTargetMozo && transferMotivo.trim().length > 0 && !transferring;
        function toggleTable(id) {
          setTransferSelectedTables(prev => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
          });
        }
        function toggleAll() {
          if (allSelected) {
            setTransferSelectedTables(new Set());
          } else {
            setTransferSelectedTables(new Set(mesasOcupadas.map(t => t.id)));
          }
        }
        return (
          <div className="modal-overlay open" onClick={e => { if (e.target.classList.contains('modal-overlay')) setTransferModal(false); }}>
            <div className="modal">
              <div className="modal-handle"></div>
              <div className="modal-header">
                <div className="modal-title">Transferir mesas</div>
                <div className="modal-close" onClick={() => setTransferModal(false)}>✕</div>
              </div>
              <div className="modal-body">

                {/* Mesas a transferir */}
                <div style={{ marginBottom: 18 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <div className="section-label">Mesas a transferir</div>
                    <button onClick={toggleAll} style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)', background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }}>
                      {allSelected ? 'Deseleccionar todo' : 'Seleccionar todo'}
                    </button>
                  </div>
                  {mesasOcupadas.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '16px', color: 'var(--text3)', fontSize: 13, background: 'var(--bg2)', borderRadius: 8 }}>
                      No hay mesas ocupadas para transferir
                    </div>
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                      {mesasOcupadas.map(t => {
                        const sel = transferSelectedTables.has(t.id);
                        const st = getMesaStatus(t.id, ordersMap, callsMap, tablesById);
                        const SC = SC_M[st] || SC_M.libre;
                        return (
                          <div key={t.id} onClick={() => toggleTable(t.id)}
                            style={{
                              aspectRatio: '1', borderRadius: 10, border: sel ? '2px solid var(--accent)' : '2px solid var(--border)',
                              background: sel ? 'var(--accent)' : SC.bg,
                              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                              cursor: 'pointer', userSelect: 'none', transition: 'all .15s', position: 'relative',
                            }}>
                            {sel && (
                              <div style={{ position: 'absolute', top: 3, right: 5, fontSize: 10, color: '#34C759', fontWeight: 800 }}>✓</div>
                            )}
                            <div style={{ fontSize: 16, fontWeight: 800, color: sel ? 'var(--bg)' : SC.tx }}>{t.number}</div>
                            <div style={{ fontSize: 8, color: sel ? 'rgba(0,0,0,0.5)' : SC.tx==='#000000' ? 'var(--text2)' : 'rgba(255,255,255,0.6)', marginTop: 2, fontWeight: 600 }}>{statusLabel(st)}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {transferSelectedTables.size > 0 && (
                    <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text2)', textAlign: 'center' }}>
                      {transferSelectedTables.size} mesa(s) seleccionada(s)
                    </div>
                  )}
                </div>

                {/* Seleccionar compañero mozo */}
                <div style={{ marginBottom: 18 }}>
                  <div className="section-label" style={{ marginBottom: 8 }}>Transferir a</div>
                  {otrosMozos.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '14px', color: 'var(--text3)', fontSize: 13, background: 'var(--bg2)', borderRadius: 8 }}>
                      No hay otros mozos activos hoy
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {otrosMozos.map((m, i) => {
                        const sel = transferTargetMozo?.name === m.name;
                        return (
                          <div key={i} onClick={() => setTransferTargetMozo(m)}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 10,
                              padding: '11px 14px', borderRadius: 10,
                              border: sel ? '2px solid var(--text)' : '1px solid var(--border)',
                              background: sel ? 'var(--text)' : 'var(--surface)',
                              cursor: 'pointer', transition: 'all .15s',
                            }}>
                            <div style={{ width: 32, height: 32, borderRadius: '50%', background: sel ? 'rgba(255,255,255,0.15)' : 'var(--bg2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 800, color: sel ? 'var(--bg)' : 'var(--text)', flexShrink: 0 }}>
                              {m.name.charAt(0).toUpperCase()}
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 14, fontWeight: 700, color: sel ? 'var(--bg)' : 'var(--text)' }}>{m.name}</div>
                              <div style={{ fontSize: 11, color: sel ? 'rgba(255,255,255,0.6)' : 'var(--text3)', marginTop: 1 }}>Mozo activo</div>
                            </div>
                            {sel && <div style={{ fontSize: 16, color: '#34C759' }}>✓</div>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Motivo de transferencia */}
                <div>
                  <div className="section-label" style={{ marginBottom: 6 }}>Motivo de la transferencia</div>
                  <textarea
                    className="note-field"
                    rows={3}
                    placeholder="Ej: Fin de turno, atención a zona, enfermedad..."
                    value={transferMotivo}
                    onChange={e => setTransferMotivo(e.target.value)}
                    maxLength={200}
                    style={{ marginTop: 0 }}
                  />
                  <div style={{ fontSize: 11, color: 'var(--text3)', textAlign: 'right', marginTop: 3 }}>{transferMotivo.length}/200</div>
                </div>

              </div>
              <div className="modal-footer">
                <button
                  className="btn btn-primary btn-full"
                  onClick={ejecutarTransferencia}
                  disabled={!canConfirm}
                >
                  {transferring ? 'Transfiriendo…' : `Transferir ${transferSelectedTables.size > 0 ? transferSelectedTables.size + ' mesa(s)' : ''} →`}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ─── DIALOG: MESA ─── */}
      {mesaDialog && (
        <div className="dialog-overlay open">
          <div className="dialog" style={{position:'relative'}}>
            <button onClick={() => setMesaDialog(null)} style={{position:'absolute',top:10,right:12,background:'none',border:'none',fontSize:20,cursor:'pointer',color:'#666',lineHeight:1}}>✕</button>
            <div className="dialog-title">{mesaDialog.title}</div>
            <div className="dialog-body">{mesaDialog.body}</div>
            <div className="dialog-actions">
              {mesaDialog.actions.map((a, i) => (
                <button
                  key={i}
                  className={`dialog-btn ${a.primary ? 'confirm' : 'cancel'}`}
                  onClick={() => { setMesaDialog(null); a.action && a.action(); }}
                >{a.label}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ─── DIALOG: CONFIRM ─── */}
      {confirmDialog && (
        <div className="dialog-overlay open">
          <div className="dialog">
            <div className="dialog-title">{confirmDialog.title}</div>
            <div className="dialog-body">{confirmDialog.body}</div>
            <div className="dialog-actions">
              <button className="dialog-btn cancel" onClick={() => setConfirmDialog(null)}>Cancelar</button>
              <button className={`dialog-btn ${confirmDialog.danger ? 'danger' : 'confirm'}`} onClick={() => { setConfirmDialog(null); confirmDialog.onOk(); }}>Confirmar</button>
            </div>
          </div>
        </div>
      )}

      {/* ALERT POPUP — nueva llamada o cobro en tiempo real */}
      {alertPopup && (() => {
        const isRetirar = alertPopup.isPay && alertPopup.pmLabel === 'Listo · retirar';
        const bg = isRetirar ? '#34C759' : (alertPopup.isPay ? 'var(--orange)' : null);
        const title = isRetirar
          ? 'Pedido despachado · retirar'
          : alertPopup.isPay
            ? `Cobro pendiente — ${alertPopup.pmLabel || ''}`
            : 'Asistencia solicitada';
        return (
          <div className="alert-popup" style={bg ? { background: bg } : {}}>
            <div className="alert-popup-body">
              <div className="alert-popup-title">{title}</div>
              <div className="alert-popup-sub">{alertPopup.tableNum != null ? `Mesa ${alertPopup.tableNum}` : 'Mesa desconocida'}</div>
            </div>
            <button className="alert-popup-btn" style={bg ? { color: bg } : {}} onClick={async () => {
              setAlertPopup(null);
              if (!alertPopup.isPay && db && alertPopup.callId) {
                await db.from('waiter_calls').update({ status: 'attended', attended_at: new Date().toISOString() }).eq('id', alertPopup.callId);
                await loadData();
                showToast('Asistencia registrada');
              }
            }}>OK</button>
          </div>
        );
      })()}

      {/* POPUP: NOTIFICACIÓN DE TRANSFERENCIA RECIBIDA */}
      {transferNotifPopup && (
        <div style={{
          position: 'fixed', top: 70, left: 16, right: 16, maxWidth: 448,
          margin: '0 auto', background: '#1D1D1F', color: 'white',
          borderRadius: 'var(--radius)', padding: '14px 16px',
          zIndex: 350, animation: 'slideDown 0.3s ease', boxShadow: 'var(--shadow-lg)',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ fontSize: 22, flexShrink: 0 }}>⇄</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 3 }}>
                Mesas transferidas a vos
              </div>
              <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 2 }}>
                <span style={{ fontWeight: 700 }}>{transferNotifPopup.from_name}</span> te transfirió{' '}
                {transferNotifPopup.tables?.length === 1
                  ? `la Mesa ${transferNotifPopup.tables[0]}`
                  : `las Mesas ${(transferNotifPopup.tables || []).join(', ')}`}
              </div>
              {transferNotifPopup.motivo && (
                <div style={{ fontSize: 12, opacity: 0.65, fontStyle: 'italic', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  "{transferNotifPopup.motivo}"
                </div>
              )}
            </div>
            <button
              onClick={async () => {
                setTransferNotifPopup(null);
                clearTimeout(transferAlertTimer.current);
                // Marcar la call como atendida para limpiarla
                try {
                  await db.from('waiter_calls')
                    .update({ status: 'attended', attended_at: new Date().toISOString() })
                    .eq('restaurant_id', RID)
                    .eq('type', 'table_transfer')
                    .eq('status', 'pending');
                } catch(e) {}
                await loadData();
              }}
              style={{ background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer', color: 'white', flexShrink: 0 }}
            >OK</button>
          </div>
        </div>
      )}

      {/* TOAST */}
      <div className={`toast ${toast ? 'show' : ''}`}>
        {toast && <span>{toast}</span>}
      </div>

    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
