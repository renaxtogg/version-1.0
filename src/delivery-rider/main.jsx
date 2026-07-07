// ════════════════════════════════════════════════════════════════════
// PR-11 piloto — Panel Rider (delivery-rider) precompilado con Vite.
// Migrado 1:1 desde el <script type="text/babel"> inline de
// public/delivery-rider.html. Sin cambios de comportamiento de producto.
//   - React/ReactDOM ahora se importan de npm (bundleados por Vite).
//   - Supabase sigue como UMD CDN (window.supabase) — diferido.
//   - Globales del shell siguen en window.* (config.js, MythosPresence, etc.).
// ════════════════════════════════════════════════════════════════════
import React from 'react';
import { createRoot } from 'react-dom/client';

const { useState, useEffect, useRef } = React;

/* ── Icon (SVG inline de mythos-icons.js, hereda color/tamaño) — WS5 ── */
const Icon = ({ name, size = 16, style }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0, ...(style || {}) }}
        dangerouslySetInnerHTML={{ __html: window.MythosIcons ? window.MythosIcons.html(name, { size }) : '' }} />
);

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
// Multi-tenant Engine: el comercio se resuelve desde la sesión activa (localStorage), sin UUID hardcodeado.
// Superadmin launcher (superadmin → Paneles): puede fijar el local por ?r= para verlo/operarlo
// con su bypass de RLS (mig 088). SOLO aplica al superadmin; cualquier otro rol ignora ?r=.
const _SUPER_RID = (function(){ try {
  if ((localStorage.getItem('mythos_role')||'').trim() !== 'superadmin') return null;
  return (new URLSearchParams(window.location.search).get('r')||'').trim() || null;
} catch(_) { return null; } })();
const RESTAURANT_ID = _SUPER_RID || localStorage.getItem('mythos_restaurant_id');
const RID = RESTAURANT_ID; // alias retro-compatible con consultas/suscripciones existentes

/* ── INTEGRACIÓN GOOGLE MAPS (preparación) ─────────────────────────────────
   Punto de integración de la ubicación del RIDER: los enlaces "Ver en mapa" /
   getMapsUrl() abren google.com/maps/dir (deep-links de navegación) — NO
   requieren API key, ya funcionan. Cuando se aprovisione la key
   (window.MYTHOS_CONFIG.googleMapsApiKey, inyectada por build.sh desde la env
   var GOOGLE_MAPS_API_KEY), ACÁ se puede montar un mapa embebido / tracking en
   vivo. Sin key, los deep-links actuales quedan intactos. */

/* ── UTILS ── */
const fmt = n => '₲ ' + (n||0).toLocaleString('es-PY');
const fmtTime = d => new Date(d).toLocaleTimeString('es-PY',{hour:'2-digit',minute:'2-digit'});
const diffMin = (a,b) => Math.round((new Date(b)-new Date(a))/60000);
const vibrate = () => { try { navigator.vibrate && navigator.vibrate([200,100,200]); } catch(e) {} };
const VEHICLE = { moto:'bike', bici:'bike', auto:'truck', pie:'user' };

/* ── HOJA DE RUTA: ordenar paradas por cercanía (más cerca primero) ──
   Nearest-neighbor desde el origen (el local). Los pedidos sin coordenadas
   (delivery_lat/lng, mig 121) quedan al final en su orden original. */
const _num = v => (v==null || v==='') ? null : Number(v);
function haversineKm(lat1,lng1,lat2,lng2){
  const R=6371, dLat=(lat2-lat1)*Math.PI/180, dLng=(lng2-lng1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function sortByProximity(orders, origin){
  const withC=[], without=[];
  for(const o of (orders||[])){
    const la=_num(o.delivery_lat), ln=_num(o.delivery_lng);
    if(la!=null && ln!=null && Number.isFinite(la) && Number.isFinite(ln)) withC.push({o,la,ln});
    else without.push(o);
  }
  const oLat=_num(origin?.lat), oLng=_num(origin?.lng);
  if(oLat==null || oLng==null || !Number.isFinite(oLat) || !Number.isFinite(oLng) || withC.length<2){
    return orders || [];
  }
  const rem=[...withC], route=[]; let cur={lat:oLat,lng:oLng};
  while(rem.length){
    let bi=0, bd=Infinity;
    rem.forEach((x,i)=>{ const d=haversineKm(cur.lat,cur.lng,x.la,x.ln); if(d<bd){bd=d;bi=i;} });
    const nx=rem.splice(bi,1)[0];
    route.push(nx.o); cur={lat:nx.la,lng:nx.ln};
  }
  return [...route, ...without];
}

/* ── SPINNER ── */
function Spinner() {
  return <div style={{width:22,height:22,border:'2px solid var(--border)',borderTopColor:'var(--text-primary)',borderRadius:'50%',animation:'spin .7s linear infinite',margin:'48px auto',display:'block'}} />;
}

/* ─────────────────────────────────────────
   PANTALLA: ERROR (cuenta sin ficha de rider / desactivada)
   El login es por correo+contraseña en login.html; acá ya no hay PIN.
───────────────────────────────────────── */
function ErrorScreen({ msg, onLogout }) {
  return (
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:'100%',padding:32,background:'var(--surface)',textAlign:'center'}}>
      <div style={{marginBottom:12,display:'flex',justifyContent:'center',color:'var(--text-tertiary)'}}><Icon name="bike" size={52} /></div>
      <div style={{fontSize:20,fontWeight:800,color:'var(--text-primary)',marginBottom:10}}>No pudimos abrir tu panel</div>
      <div style={{fontSize:14,color:'var(--text-tertiary)',marginBottom:32,lineHeight:1.5,maxWidth:300}}>{msg}</div>
      <button
        onClick={onLogout}
        style={{width:'100%',padding:'16px',background:'var(--primary)',color:'var(--on-primary)',border:'none',borderRadius:16,fontSize:16,fontWeight:700,cursor:'pointer'}}
      >Volver al inicio de sesión</button>
    </div>
  );
}

/* ─────────────────────────────────────────
   PANTALLA: HOME (con pedidos asignados integrados)
───────────────────────────────────────── */
function HomeScreen({ rider, stats, activeOrders, onStartRoute, onShowRoute, onShowHistory, onLogout, onStatusChange, onRefresh }) {
  const [changingStatus, setChangingStatus] = useState(false);
  const [starting, setStarting] = useState(false);
  const status = rider.current_status || 'disponible';

  const pendingOrders = activeOrders.filter(o => o.rider_status === 'confirmed');
  const routeOrders   = activeOrders.filter(o => o.rider_status === 'on_way');

  async function toggleStatus() {
    if (!db) return;
    setChangingStatus(true);
    const next = status === 'disponible' ? 'offline' : 'disponible';
    await db.from('delivery_riders').update({ current_status: next }).eq('id', rider.id);
    // Al ponerse EN LÍNEA (Disponible): rebalanceo → jala pedidos transferibles
    // (aún en el local, no recogidos) de los riders en ruta para agilizar.
    if (next === 'disponible' && rider.restaurant_id) {
      try { await db.rpc('rebalance_delivery_dispatch', { p_restaurant_id: rider.restaurant_id }); } catch(_) {}
      onRefresh && onRefresh();
    }
    onStatusChange(next);
    setChangingStatus(false);
  }

  async function handleStartRoute() {
    if (!pendingOrders.length || !db || starting) return;
    setStarting(true);
    for (const o of pendingOrders) {
      await db.from('delivery_orders').update({
        rider_status: 'on_way',
        picked_up_at: new Date().toISOString(),
      }).eq('id', o.id);
    }
    await db.from('delivery_riders').update({ current_status: 'en_ruta' }).eq('id', rider.id);
    setStarting(false);
    onStartRoute(pendingOrders);
  }

  function getMapsUrl(orders) {
    const addrs = orders.map(o => encodeURIComponent(o.delivery_address || o.customer_name || ''));
    if (!addrs.length) return null;
    if (addrs.length === 1) return `https://www.google.com/maps/dir/?api=1&destination=${addrs[0]}`;
    return `https://www.google.com/maps/dir/?api=1&destination=${addrs[addrs.length-1]}&waypoints=${addrs.slice(0,-1).join('|')}`;
  }

  // PR-B4I: tintes claros → color-mix sobre var(--surface) (auto-adapta por tema;
  // en dark el texto var(--text-primary) flipea a claro y queda legible). Los
  // colores de punto van a tokens de estado (light idéntico, dark más brillante).
  const STATUS_BG    = { disponible:'color-mix(in srgb, var(--success) 12%, var(--surface))', offline:'var(--bg-subtle)', en_ruta:'color-mix(in srgb, var(--warning) 14%, var(--surface))' };
  const STATUS_COLOR = { disponible:'var(--success)', offline:'var(--text-tertiary)', en_ruta:'var(--warning)' };
  const STATUS_LABEL = { disponible:'Disponible', offline:'Offline', en_ruta:'En ruta' };

  function earnLabel() {
    if (!stats.count) return '—';
    if (rider.commission_type === 'salary') return `${stats.count} entregas`;
    return fmt(stats.earned);
  }

  return (
    <div style={{display:'flex',flexDirection:'column',height:'100%',background:'var(--surface)'}}>
      {/* Header */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'20px 20px 14px',borderBottom:'1px solid var(--bg-subtle)'}}>
        <div>
          <div style={{fontSize:20,fontWeight:800,color:'var(--text-primary)',display:'flex',alignItems:'center',gap:6}}>
            <Icon name={VEHICLE[rider.vehicle]||'bike'} size={18} /> {rider.name.split(' ')[0]}
          </div>
          <div style={{fontSize:12,color:'var(--text-tertiary)',marginTop:2}}>{rider.name}</div>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <button onClick={onRefresh} aria-label="Actualizar" style={{background:'none',border:'1.5px solid var(--border)',borderRadius:8,padding:'6px 10px',color:'var(--text-secondary)',cursor:'pointer',display:'inline-flex',alignItems:'center'}}><Icon name="refresh" size={14} /></button>
          <button onClick={onLogout} style={{background:'none',border:'1.5px solid var(--border)',borderRadius:8,padding:'6px 12px',fontSize:12,color:'var(--text-secondary)',cursor:'pointer',fontWeight:500}}>Salir</button>
        </div>
      </div>

      <div style={{flex:1,overflowY:'auto',padding:'16px 20px 80px'}}>

        {/* Status card */}
        <div style={{background:STATUS_BG[status]||'var(--bg-subtle)',borderRadius:16,padding:'16px 20px',marginBottom:16,animation:'fadeIn .2s'}}>
          <div style={{display:'flex',alignItems:'center',gap:12}}>
            <div style={{width:11,height:11,borderRadius:'50%',background:STATUS_COLOR[status]||'var(--text-tertiary)',flexShrink:0,animation:status==='disponible'?'pulse 1.8s ease-in-out infinite':'none'}} />
            <div style={{fontSize:15,fontWeight:700,color:'var(--text-primary)',flex:1}}>{STATUS_LABEL[status]||status}</div>
            {status !== 'en_ruta' && (
              <button onClick={toggleStatus} disabled={changingStatus} style={{padding:'7px 14px',background:status==='disponible'?'transparent':'var(--primary)',color:status==='disponible'?'var(--text-secondary)':'var(--on-primary)',border:status==='disponible'?'1.5px solid var(--border)':'none',borderRadius:9,fontSize:12,fontWeight:600,cursor:'pointer'}}>
                {changingStatus ? '…' : status==='disponible' ? 'Ir offline' : 'Activarme'}
              </button>
            )}
          </div>
        </div>

        {/* Ruta activa */}
        {routeOrders.length > 0 && (
          <div style={{background:'#FFF7ED',border:'1.5px solid #FDBA74',borderRadius:16,padding:'16px',marginBottom:16,animation:'fadeIn .2s'}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
              <div style={{fontSize:14,fontWeight:800,color:'#C2410C',display:'flex',alignItems:'center',gap:6}}><Icon name="bike" size={15} /> Ruta activa — {routeOrders.length} entrega{routeOrders.length>1?'s':''}</div>
              {getMapsUrl(routeOrders) && (
                <a href={getMapsUrl(routeOrders)} target="_blank" rel="noopener noreferrer" style={{fontSize:12,fontWeight:700,color:'#fff',background:'#C2410C',borderRadius:8,padding:'5px 10px',textDecoration:'none'}}>
                  Ver mapa
                </a>
              )}
            </div>
            {routeOrders.map((o,i) => (
              <div key={o.id} style={{fontSize:12,color:'#92400E',padding:'4px 0',borderTop:i>0?'1px solid rgba(194,65,12,.15)':'none',display:'flex',gap:8,alignItems:'flex-start'}}>
                <span style={{fontWeight:800,flexShrink:0}}>{i+1}.</span>
                <span>{o.customer_name} — {o.delivery_address||'—'}</span>
              </div>
            ))}
            <button onClick={onShowRoute} style={{marginTop:12,width:'100%',padding:'12px',background:'#C2410C',color:'#fff',border:'none',borderRadius:12,fontSize:14,fontWeight:700,cursor:'pointer'}}>
              Continuar ruta →
            </button>
          </div>
        )}

        {/* Pedidos asignados esperando inicio */}
        {pendingOrders.length > 0 && (
          <div style={{marginBottom:16,animation:'fadeIn .2s'}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
              <div style={{fontSize:11,fontWeight:700,color:'var(--text-tertiary)',textTransform:'uppercase',letterSpacing:.8}}>
                {pendingOrders.length} pedido{pendingOrders.length>1?'s':''} asignado{pendingOrders.length>1?'s':''} —{' '}
                {pendingOrders.every(o => o.orders?.status === 'ready') ? '¡Listos para buscar!' : 'En preparación'}
              </div>
              {getMapsUrl(pendingOrders) && (
                <a href={getMapsUrl(pendingOrders)} target="_blank" rel="noopener noreferrer" style={{fontSize:11,color:'var(--text-secondary)',textDecoration:'underline'}}>
                  Ver en mapa
                </a>
              )}
            </div>
            <div style={{display:'flex',flexDirection:'column',gap:10}}>
              {pendingOrders.map((o,i) => {
                const kitchenStatus = o.orders?.status || 'kitchen_received';
                const isReady = kitchenStatus === 'ready';
                const orderNum = o.orders?.order_number || null;
                return (
                <div key={o.id} style={{background: isReady ? 'color-mix(in srgb, var(--success) 12%, var(--surface))' : 'var(--bg-subtle)', border: isReady ? '1.5px solid var(--success)' : '1.5px solid transparent', borderRadius:14,padding:'14px 16px',animation:'fadeIn .15s'}}>
                  {/* Ticket + estado cocina */}
                  <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:8}}>
                    {orderNum && <span style={{fontFamily:"'SF Mono',ui-monospace,monospace",fontSize:12,fontWeight:800,color:'var(--text-primary)'}}>#{orderNum}</span>}
                    <KitchenBadge status={kitchenStatus} />
                  </div>
                  <div style={{display:'flex',alignItems:'flex-start',gap:10,marginBottom:6}}>
                    <div style={{width:26,height:26,borderRadius:'50%',background:'var(--primary)',color:'var(--on-primary)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:800,flexShrink:0,marginTop:1}}>{i+1}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:14,fontWeight:700,color:'var(--text-primary)'}}>{o.customer_name||'Sin nombre'}</div>
                      {o.customer_phone && <div style={{fontSize:11,color:'var(--text-secondary)',marginTop:1,display:'flex',alignItems:'center',gap:4}}><Icon name="phone" size={11} /> {o.customer_phone}</div>}
                    </div>
                    <div style={{fontSize:13,fontWeight:700,color:'var(--text-primary)',flexShrink:0}}>{fmt((o.order_total||0)+(o.delivery_fee||0))}</div>
                  </div>
                  <div style={{fontSize:12,color:'var(--text-primary)',marginBottom:8,paddingLeft:36,lineHeight:1.4}}>
                    <Icon name="pin" size={12} style={{verticalAlign:'-2px',marginRight:2}} /> {o.delivery_address||'Sin dirección'}
                    {o.delivery_detail && <div style={{fontSize:11,color:'var(--text-secondary)',marginTop:1}}>{o.delivery_detail}</div>}
                  </div>
                  <div style={{display:'flex',gap:8,paddingLeft:36}}>
                    {o.customer_phone && (
                      <a href={`tel:${o.customer_phone}`} aria-label="Llamar" style={{display:'flex',alignItems:'center',justifyContent:'center',width:36,height:36,background:'var(--surface)',border:'1.5px solid var(--border)',borderRadius:8,color:'var(--text-primary)',textDecoration:'none',flexShrink:0}}><Icon name="phone" size={16} /></a>
                    )}
                    <a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(o.delivery_address||o.customer_name||'')}`} target="_blank" rel="noopener noreferrer" aria-label="Ver en mapa" style={{display:'flex',alignItems:'center',justifyContent:'center',width:36,height:36,background:'var(--surface)',border:'1.5px solid var(--border)',borderRadius:8,color:'var(--text-primary)',textDecoration:'none',flexShrink:0}}><Icon name="pin" size={16} /></a>
                  </div>
                </div>
                );
              })}
            </div>
            <button
              onClick={handleStartRoute}
              disabled={starting}
              style={{width:'100%',padding:'16px',background:'var(--primary)',color:'var(--on-primary)',border:'none',borderRadius:14,fontSize:15,fontWeight:700,cursor:starting?'default':'pointer',opacity:starting?.7:1,marginTop:12,display:'flex',alignItems:'center',justifyContent:'center',gap:10}}
            >
              <Icon name="bike" size={16} />
              <span>{starting ? 'Iniciando…' : pendingOrders.every(o => o.orders?.status === 'ready') ? `Salir a entregar · ${pendingOrders.length} pedido${pendingOrders.length>1?'s':''}` : `Comenzar ruta · ${pendingOrders.length} pedido${pendingOrders.length>1?'s':''}`}</span>
            </button>
          </div>
        )}

        {/* Sin pedidos */}
        {pendingOrders.length === 0 && routeOrders.length === 0 && (
          <div style={{textAlign:'center',padding:'32px 20px',color:'var(--text-tertiary)',fontSize:14,background:'var(--bg-subtle)',borderRadius:16,marginBottom:16}}>
            <div style={{marginBottom:10,display:'flex',justifyContent:'center'}}><Icon name="package" size={36} /></div>
            <div style={{fontWeight:600}}>Sin pedidos asignados</div>
            <div style={{fontSize:12,marginTop:4}}>Cuando un pedido de delivery entre a cocina,<br/>te aparecerá aquí automáticamente.</div>
          </div>
        )}

        {/* Stats */}
        <div style={{background:'var(--bg-subtle)',borderRadius:14,padding:'14px 18px',marginBottom:14}}>
          <div style={{fontSize:10,fontWeight:700,color:'var(--text-tertiary)',textTransform:'uppercase',letterSpacing:.8,marginBottom:10}}>Hoy</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,textAlign:'center'}}>
            <div>
              <div style={{fontSize:22,fontWeight:800,color:'var(--text-primary)'}}>{stats.count}</div>
              <div style={{fontSize:10,color:'var(--text-tertiary)',marginTop:2}}>Entregas</div>
            </div>
            <div>
              <div style={{fontSize:rider.commission_type==='salary'?12:13,fontWeight:700,color:'var(--text-primary)',lineHeight:1.3}}>{earnLabel()}</div>
              <div style={{fontSize:10,color:'var(--text-tertiary)',marginTop:2}}>{rider.commission_type==='salary'?'Sueldo fijo':'Ganado'}</div>
            </div>
            <div>
              <div style={{fontSize:18,fontWeight:700,color:'var(--text-primary)'}}>{stats.avgMin>0?stats.avgMin+'min':'—'}</div>
              <div style={{fontSize:10,color:'var(--text-tertiary)',marginTop:2}}>Promedio</div>
            </div>
          </div>
        </div>

        <button onClick={onShowHistory} style={{width:'100%',padding:'12px',background:'transparent',color:'var(--text-primary)',border:'1.5px solid var(--border)',borderRadius:12,fontSize:14,fontWeight:500,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8}}>
          <Icon name="clipboard" size={16} /> Historial del día
        </button>
      </div>
    </div>
  );
}

/* Badge de estado de cocina para el rider */
function KitchenBadge({ status }) {
  const map = {
    kitchen_received: { label: 'En cocina', bg: '#EFF6FF', color: '#1E40AF' },
    paid:             { label: 'En cocina', bg: '#EFF6FF', color: '#1E40AF' },
    cooking:          { label: 'Preparándose', bg: '#FFF7ED', color: '#C2410C' },
    ready:            { label: '✓ Listo', bg: '#F0FAF4', color: '#166534' },
  };
  const s = map[status] || { label: 'En cocina', bg: '#EFF6FF', color: '#1E40AF' };
  return (
    <span style={{
      display:'inline-block', padding:'2px 8px', borderRadius:6,
      background:s.bg, color:s.color, fontSize:11, fontWeight:700, flexShrink:0
    }}>{s.label}</span>
  );
}

/* PinEntryScreen eliminado — asignación automática por cocina */
function PinEntryScreen({ onBack }) {
  return (
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:'100%',padding:32,background:'var(--surface)',textAlign:'center'}}>
      <div style={{marginBottom:16,display:'flex',justifyContent:'center',color:'var(--text-tertiary)'}}><Icon name="bike" size={44} /></div>
      <div style={{fontSize:16,fontWeight:700,color:'var(--text-primary)',marginBottom:8}}>Los pedidos se asignan automáticamente</div>
      <div style={{fontSize:13,color:'var(--text-tertiary)',marginBottom:24,lineHeight:1.6}}>Cocina te asigna los pedidos cuando están listos.<br/>Volvé al inicio para verlos.</div>
      <button onClick={onBack} style={{padding:'12px 24px',background:'var(--primary)',color:'var(--on-primary)',border:'none',borderRadius:12,fontSize:14,fontWeight:700,cursor:'pointer'}}>Volver</button>
    </div>
  );
}

/* ─────────────────────────────────────────
   PANTALLA: RUTA ACTIVA
───────────────────────────────────────── */
function RouteScreen({ rider, initialOrders, onDone }) {
  const [orders, setOrders] = useState(() =>
    initialOrders.map(o => ({ ...o, _done:false, _delivering:false }))
  );
  const [allDone, setAllDone] = useState(false);

  const pending   = orders.filter(o => !o._done);
  const delivered = orders.filter(o =>  o._done);

  async function deliverOrder(id) {
    setOrders(prev => prev.map(o => o.id===id ? {...o, _delivering:true} : o));

    if (db) {
      const delivOrd = orders.find(o => o.id === id);
      await db.from('delivery_orders').update({
        rider_status: 'delivered',
        status: 'delivered',
        delivered_at: new Date().toISOString(),
      }).eq('id', id);
      // Actualizar orders.status para que caja y cliente vean el pedido como entregado
      if (delivOrd?.order_id) {
        await db.from('orders').update({ status: 'delivered' }).eq('id', delivOrd.order_id);
      }
    }

    const updated = orders.map(o =>
      o.id===id ? {...o, _done:true, _delivering:false} : o
    );
    setOrders(updated);

    if (updated.every(o => o._done)) {
      if (db) {
        await db.from('delivery_riders').update({ current_status:'disponible' }).eq('id', rider.id);
        // Ruta terminada → rider disponible → rebalancear (puede recibir cola nueva).
        if (rider.restaurant_id) { try { await db.rpc('rebalance_delivery_dispatch', { p_restaurant_id: rider.restaurant_id }); } catch(_) {} }
      }
      vibrate();
      setAllDone(true);
    }
  }

  function getMapsUrl() {
    const addrs = pending.map(o => encodeURIComponent(o.delivery_address || o.customer_name || ''));
    if (!addrs.length) return null;
    if (addrs.length === 1) return `https://www.google.com/maps/dir/?api=1&destination=${addrs[0]}`;
    return `https://www.google.com/maps/dir/?api=1&destination=${addrs[addrs.length-1]}&waypoints=${addrs.slice(0,-1).join('|')}`;
  }

  /* ── Todos entregados ── */
  if (allDone) {
    return (
      <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:'100%',padding:32,background:'var(--surface)',textAlign:'center'}}>
        <div style={{marginBottom:20,animation:'popIn .4s ease',display:'flex',justifyContent:'center',color:'#34C759'}}><Icon name="checkCircle" size={66} /></div>
        <div style={{fontSize:24,fontWeight:800,color:'var(--text-primary)',marginBottom:8}}>¡Ruta completada!</div>
        <div style={{fontSize:15,color:'var(--text-secondary)',marginBottom:48,lineHeight:1.6}}>
          {orders.length} pedido{orders.length>1?'s':''} entregado{orders.length>1?'s':''}<br/>
          Estás disponible de nuevo
        </div>
        <button
          onClick={onDone}
          style={{width:'100%',padding:'18px',background:'var(--primary)',color:'var(--on-primary)',border:'none',borderRadius:16,fontSize:17,fontWeight:700,cursor:'pointer'}}
        >Volver al inicio</button>
      </div>
    );
  }

  return (
    <div style={{display:'flex',flexDirection:'column',height:'100%',background:'var(--surface)'}}>
      {/* Header */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'16px 20px',borderBottom:'1px solid var(--bg-subtle)',background:'var(--surface)',position:'sticky',top:0,zIndex:10}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <div style={{fontSize:17,fontWeight:700,color:'var(--text-primary)'}}>En ruta</div>
          <div style={{background:'#FF9500',color:'#fff',borderRadius:12,padding:'2px 9px',fontSize:12,fontWeight:800}}>{pending.length}</div>
        </div>
        {getMapsUrl() && (
          <a
            href={getMapsUrl()}
            target="_blank"
            rel="noopener noreferrer"
            style={{display:'flex',alignItems:'center',gap:6,padding:'8px 14px',background:'var(--primary)',color:'var(--on-primary)',borderRadius:10,textDecoration:'none',fontSize:13,fontWeight:600}}
          >
            <Icon name="pin" size={14} /> Ruta completa
          </a>
        )}
      </div>

      <div style={{flex:1,overflowY:'auto',padding:'16px 20px 32px'}}>

        {/* Pending orders */}
        {pending.map((o, i) => (
          <div key={o.id} style={{background:'var(--bg-subtle)',borderRadius:16,padding:'16px 18px',marginBottom:14,animation:'fadeIn .2s'}}>
            {/* Top row: number + customer + total */}
            <div style={{display:'flex',alignItems:'flex-start',gap:10,marginBottom:10}}>
              <div style={{width:30,height:30,borderRadius:'50%',background:'var(--primary)',color:'var(--on-primary)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:13,fontWeight:800,flexShrink:0,marginTop:1}}>{i+1}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:15,fontWeight:700,color:'var(--text-primary)'}}>{o.customer_name||'Sin nombre'}</div>
                {o.customer_phone && <div style={{fontSize:12,color:'var(--text-secondary)',marginTop:1}}>{o.customer_phone}</div>}
              </div>
              <div style={{fontSize:15,fontWeight:700,color:'var(--text-primary)',flexShrink:0}}>{fmt((o.order_total||0)+(o.delivery_fee||0))}</div>
            </div>

            {/* Address */}
            <div style={{fontSize:14,color:'var(--text-primary)',marginBottom:12,paddingLeft:40,lineHeight:1.4}}>
              <Icon name="pin" size={13} style={{verticalAlign:'-2px',marginRight:2}} /> {o.delivery_address||'Sin dirección'}
            </div>

            {/* Actions */}
            <div style={{display:'flex',gap:8,paddingLeft:40}}>
              {o.customer_phone && (
                <a
                  href={`tel:${o.customer_phone}`}
                  aria-label="Llamar"
                  style={{display:'flex',alignItems:'center',justifyContent:'center',width:42,height:42,background:'var(--surface)',border:'1.5px solid var(--border)',borderRadius:10,color:'var(--text-primary)',textDecoration:'none',flexShrink:0}}
                ><Icon name="phone" size={18} /></a>
              )}
              <a
                href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(o.delivery_address||o.customer_name||'')}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Ver en mapa"
                style={{display:'flex',alignItems:'center',justifyContent:'center',width:42,height:42,background:'var(--surface)',border:'1.5px solid var(--border)',borderRadius:10,color:'var(--text-primary)',textDecoration:'none',flexShrink:0}}
              ><Icon name="pin" size={18} /></a>
              <button
                onClick={() => deliverOrder(o.id)}
                disabled={o._delivering}
                style={{flex:1,padding:'10px',background:'#34C759',color:'#fff',border:'none',borderRadius:10,fontSize:14,fontWeight:700,cursor:o._delivering?'default':'pointer',opacity:o._delivering?.7:1,transition:'opacity .15s'}}
              >{o._delivering ? '…' : '✓ Entregar'}</button>
            </div>
          </div>
        ))}

        {/* Delivered orders */}
        {delivered.length > 0 && (
          <div style={{marginTop:8}}>
            <div style={{fontSize:11,fontWeight:700,color:'var(--text-tertiary)',textTransform:'uppercase',letterSpacing:.8,marginBottom:10}}>
              Entregados ({delivered.length})
            </div>
            {delivered.map(o => (
              <div key={o.id} style={{padding:'12px 0',borderBottom:'1px solid var(--bg-subtle)',display:'flex',alignItems:'center',gap:12}}>
                <div style={{width:26,height:26,borderRadius:'50%',background:'#34C759',display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,color:'#fff',flexShrink:0}}>✓</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:14,fontWeight:600,color:'#8E8E93'}}>{o.customer_name||'Sin nombre'}</div>
                  <div style={{fontSize:12,color:'#C7C7CC',marginTop:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{o.delivery_address||'—'}</div>
                </div>
                <div style={{fontSize:13,color:'#8E8E93',flexShrink:0}}>{fmt((o.order_total||0)+(o.delivery_fee||0))}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────
   PANTALLA: HISTORIAL
───────────────────────────────────────── */
function HistoryScreen({ rider, onBack }) {
  const [orders, setOrders] = useState(null);

  useEffect(() => {
    if (!db) { setOrders([]); return; }
    const today = new Date(); today.setHours(0,0,0,0);
    db.from('delivery_orders')
      .select('id,delivery_pin,customer_name,delivery_address,order_total,delivery_fee,picked_up_at,delivered_at')
      .eq('rider_id', rider.id)
      .eq('rider_status', 'delivered')
      .gte('delivered_at', today.toISOString())
      .order('delivered_at', { ascending: false })
      .then(({ data }) => setOrders(data || []));
  }, []);

  function calcEarning(o) {
    if (rider.commission_type === 'pct')   return Math.round((o.order_total||0) * (rider.commission_value||0) / 100);
    if (rider.commission_type === 'fixed') return rider.commission_value||0;
    return null;
  }

  const totalEarned = (orders||[]).reduce((s, o) => s + (calcEarning(o)||0), 0);
  const timings = (orders||[]).filter(o => o.picked_up_at && o.delivered_at);
  const avgMin  = timings.length
    ? Math.round(timings.reduce((s,o) => s + diffMin(o.picked_up_at, o.delivered_at), 0) / timings.length)
    : 0;

  return (
    <div style={{display:'flex',flexDirection:'column',height:'100%',background:'var(--surface)'}}>
      <div style={{display:'flex',alignItems:'center',gap:8,padding:'16px 20px',borderBottom:'1px solid var(--bg-subtle)',position:'sticky',top:0,background:'var(--surface)',zIndex:10}}>
        <button onClick={onBack} style={{background:'none',border:'none',padding:'4px 8px 4px 0',fontSize:22,lineHeight:1,color:'var(--text-primary)',cursor:'pointer'}}>‹</button>
        <div style={{fontSize:17,fontWeight:600,color:'var(--text-primary)'}}>Historial del día</div>
      </div>

      <div style={{flex:1,overflowY:'auto',padding:'16px 20px 32px'}}>
        {orders === null && <Spinner />}
        {orders !== null && orders.length === 0 && (
          <div style={{textAlign:'center',padding:'60px 20px',color:'var(--text-tertiary)',fontSize:15}}>
            <div style={{marginBottom:14,display:'flex',justifyContent:'center'}}><Icon name="clipboard" size={44} /></div>
            No hay entregas hoy todavía
          </div>
        )}
        {orders !== null && orders.map((o, i) => {
          const mins    = (o.picked_up_at && o.delivered_at) ? diffMin(o.picked_up_at, o.delivered_at) : null;
          const earning = calcEarning(o);
          return (
            <div key={o.id} style={{padding:'14px 0',borderBottom:i<orders.length-1?'1px solid var(--bg-subtle)':'none'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                <div style={{flex:1,paddingRight:12}}>
                  <div style={{fontSize:12,color:'var(--text-tertiary)',marginBottom:2}}>{o.delivered_at ? fmtTime(o.delivered_at) : '—'}</div>
                  <div style={{fontSize:15,fontWeight:600,color:'var(--text-primary)',marginBottom:2}}>{o.customer_name||'Sin nombre'}</div>
                  <div style={{fontSize:12,color:'var(--text-secondary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{o.delivery_address||'—'}</div>
                </div>
                <div style={{textAlign:'right',flexShrink:0}}>
                  <div style={{fontSize:14,fontWeight:600,color:'var(--text-primary)'}}>{fmt((o.order_total||0)+(o.delivery_fee||0))}</div>
                  {earning !== null && <div style={{fontSize:12,color:'#34C759',marginTop:2,fontWeight:600}}>+{fmt(earning)}</div>}
                  {mins !== null && <div style={{fontSize:11,color:'var(--text-tertiary)',marginTop:2}}>{mins}min</div>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Summary footer */}
      {orders !== null && orders.length > 0 && (
        <div style={{borderTop:'1px solid var(--bg-subtle)',padding:'16px 20px',background:'var(--bg-subtle)',display:'grid',gridTemplateColumns:'repeat(3,1fr)',textAlign:'center'}}>
          <div>
            <div style={{fontSize:22,fontWeight:800,color:'var(--text-primary)'}}>{orders.length}</div>
            <div style={{fontSize:11,color:'var(--text-tertiary)',marginTop:2}}>Entregas</div>
          </div>
          <div>
            {rider.commission_type === 'salary'
              ? <>
                  <div style={{fontSize:12,fontWeight:700,color:'var(--text-primary)'}}>Sueldo</div>
                  <div style={{fontSize:11,color:'var(--text-tertiary)',marginTop:2}}>fijo mensual</div>
                </>
              : <>
                  <div style={{fontSize:14,fontWeight:700,color:'var(--text-primary)'}}>{fmt(totalEarned)}</div>
                  <div style={{fontSize:11,color:'var(--text-tertiary)',marginTop:2}}>Ganado</div>
                </>
            }
          </div>
          <div>
            <div style={{fontSize:22,fontWeight:700,color:'var(--text-primary)'}}>{avgMin>0?avgMin+'min':'—'}</div>
            <div style={{fontSize:11,color:'var(--text-tertiary)',marginTop:2}}>Promedio</div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────
   APP ROOT
───────────────────────────────────────── */
function App() {
  const [screen, setScreen]       = useState('loading');
  const [rider, setRider]         = useState(null);
  const [activeOrders, setActiveOrders] = useState([]);
  const [stats, setStats]         = useState({ count:0, earned:0, avgMin:0 });
  const [errMsg, setErrMsg]       = useState('');
  const [origin, setOrigin]       = useState(null);   // {lat,lng} del local → ordenar ruta por cercanía

  // Multi-tenant Engine: fail-safe — sin tenant en sesión, limpia y expulsa al login (salvo superadmin).
  useEffect(() => {
    if ((!RESTAURANT_ID || !RESTAURANT_ID.trim()) && localStorage.getItem('mythos_role') !== 'superadmin') {
      localStorage.clear();
      window.location.href = '/login.html';
    }
  }, []);

  // Resolver la ficha del rider desde la sesión auth — login por correo+contraseña (login.html),
  // sin PIN. Emparejamos delivery_riders.user_id = auth.uid(). La sesión persiste entre cierres
  // de pestaña (Supabase localStorage): al reabrir reanudamos sin re-login (cierre sólo por
  // logout explícito o 1h de inactividad vía mythos-session.js).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!db) { setErrMsg('Sin conexión a la base de datos.'); setScreen('error'); return; }
      let uid = '';
      try { const { data:{ user } } = await db.auth.getUser(); uid = user?.id || ''; } catch(_) {}
      if (!uid) uid = localStorage.getItem('mythos_user_id') || '';
      if (!uid) { window.location.replace('login.html?next=delivery-rider.html'); return; }
      const { data, error } = await db.from('delivery_riders').select('*').eq('user_id', uid).maybeSingle();
      if (cancelled) return;
      if (error || !data) {
        setErrMsg('Tu cuenta no está vinculada a un rider. Pedile al administrador que te dé de alta en Delivery → Riders.');
        setScreen('error'); return;
      }
      if (data.active === false) {
        setErrMsg('Tu cuenta de rider está desactivada. Contactá al administrador.');
        setScreen('error'); return;
      }
      // WS1-B · Gate por plan: el panel Rider debe estar incluido en allowed_panels
      // del plan del restaurante (get_restaurant_capabilities, mig 090/108).
      // Fail-closed: si no se puede confirmar la capability, se BLOQUEA (no se
      // arranca la sesión del rider ni se cargan pedidos/stats/realtime).
      let planOk = false;
      try {
        const { data: caps } = await db.rpc('get_restaurant_capabilities', { p_restaurant_id: data.restaurant_id });
        planOk = !!(caps && Array.isArray(caps.allowed_panels) && caps.allowed_panels.includes('delivery-rider'));
      } catch (_) { planOk = false; }
      if (cancelled) return;
      if (!planOk) {
        setErrMsg('El panel de Rider Delivery no está incluido en el plan de este restaurante. Contactá al administrador.');
        setScreen('error'); return;
      }
      // Origen para la hoja de ruta (ordenar paradas por cercanía). Best-effort.
      try {
        const { data: rest } = await db.from('restaurants').select('lat,lng').eq('id', data.restaurant_id).maybeSingle();
        if (!cancelled && rest && rest.lat!=null && rest.lng!=null) setOrigin({ lat: rest.lat, lng: rest.lng });
      } catch(_) {}
      startRiderSession(data);
    })();
    return () => { cancelled = true; };
  }, []);

  async function loadStats(r) {
    if (!db || !r) return;
    const today = new Date(); today.setHours(0,0,0,0);
    const { data } = await db.from('delivery_orders')
      .select('order_total,delivery_fee,picked_up_at,delivered_at')
      .eq('rider_id', r.id)
      .eq('rider_status', 'delivered')
      .gte('delivered_at', today.toISOString());

    if (!data?.length) return;

    let earned = 0;
    data.forEach(o => {
      if (r.commission_type === 'pct')   earned += Math.round((o.order_total||0) * (r.commission_value||0) / 100);
      else if (r.commission_type === 'fixed') earned += (r.commission_value||0);
    });

    const timings = data.filter(o => o.picked_up_at && o.delivered_at);
    const avgMin  = timings.length
      ? Math.round(timings.reduce((s,o) => s + diffMin(o.picked_up_at, o.delivered_at), 0) / timings.length)
      : 0;

    setStats({ count: data.length, earned, avgMin });
  }

  async function loadActiveOrders(r) {
    if (!db || !r) return;
    const { data } = await db.from('delivery_orders')
      .select('*, orders!order_id(status, order_number)')
      .eq('rider_id', r.id)
      .in('rider_status', ['confirmed','on_way'])
      .order('created_at', { ascending: true });
    setActiveOrders(data || []);
  }

  const pollRef = useRef(null);

  function startRiderSession(riderData) {
    // Registrar conexión del rider para el módulo Personal del admin (presencia).
    try {
      window.MythosPresence?.start({
        restaurant_id: RID, role: 'rider', panel: 'delivery-rider',
        rider_id: riderData.id, user_id: riderData.user_id || null, name: riderData.name || null
      });
    } catch(_) {}
    setRider(riderData);
    setScreen('home');
    loadStats(riderData);
    loadActiveOrders(riderData);

    if (db) {
      // Realtime: delivery_orders debe estar en supabase_realtime publication (migración 078).
      // Sin filtro de columna para capturar el UPDATE rider_id NULL→UUID.
      db.channel('rider-orders-' + riderData.id)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'delivery_orders'
        }, () => loadActiveOrders(riderData))
        .subscribe();
    }

    // Polling de respaldo cada 30 s por si el realtime falla o se desconecta.
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => loadActiveOrders(riderData), 30000);
  }

  async function handleLogout() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    try { await window.MythosPresence?.stop('manual'); } catch(_) {}
    if (rider?.id && db) {
      // M9-b: al cerrar sesión el rider queda OFFLINE (no 'disponible'). Si
      // quedara disponible, el despacho/rebalanceo (mig 156) le seguiría
      // mandando pedidos estando deslogueado → "rider fantasma", justo lo que
      // M9 cierra al nacer offline. Vuelve a 'disponible' sólo cuando entra al
      // panel y se pone En línea.
      await db.from('delivery_riders').update({ current_status: 'offline' }).eq('id', rider.id);
      try { db.removeAllChannels(); } catch(_) {}
    }
    // El rider es una cuenta auth real → cerrar sesión Supabase y volver al login.
    try { await db?.auth.signOut(); } catch(_) {}
    ['mythos_role','mythos_restaurant_id','mythos_user_id','mythos_display_name','mythos_last_activity']
      .forEach(k => { try { localStorage.removeItem(k); } catch(_) {} });
    window.location.replace('login.html');
  }

  function handleStartRoute(orders) {
    // Pasar a ruta con los pedidos que acaban de iniciar (on_way)
    loadActiveOrders(rider).then(() => setScreen('route'));
  }

  function handleAllDelivered() {
    const updated = rider ? { ...rider, current_status:'disponible' } : rider;
    setRider(updated);
    // Al liberarse, el rebalanceo (disparado en RouteScreen) pudo asignarle nuevos
    // pedidos → recargar la cola en vez de vaciarla a ciegas.
    if (updated) { loadActiveOrders(updated); loadStats(updated); }
    else setActiveOrders([]);
    setScreen('home');
  }

  return (
    <div className="phone-wrap">
      <div className="phone">
        <div className="screen">
          {screen === 'loading' && <Spinner />}
          {screen === 'error' && (
            <ErrorScreen msg={errMsg} onLogout={handleLogout} />
          )}
          {screen === 'home' && rider && (
            <HomeScreen
              rider={rider}
              stats={stats}
              activeOrders={activeOrders}
              onStartRoute={handleStartRoute}
              onShowRoute={() => setScreen('route')}
              onShowHistory={() => setScreen('history')}
              onLogout={handleLogout}
              onRefresh={() => { loadActiveOrders(rider); loadStats(rider); }}
              onStatusChange={next => setRider(prev => prev ? {...prev, current_status:next} : prev)}
            />
          )}
          {screen === 'route' && rider && (
            <RouteScreen
              rider={rider}
              initialOrders={sortByProximity(activeOrders.filter(o => o.rider_status === 'on_way'), origin)}
              onDone={handleAllDelivered}
            />
          )}
          {screen === 'history' && rider && (
            <HistoryScreen
              rider={rider}
              onBack={() => setScreen('home')}
            />
          )}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('app')).render(React.createElement(App));
