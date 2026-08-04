// ════════════════════════════════════════════════════════════════════
// MYTHOS · /clientes — app de comensales.
// ────────────────────────────────────────────────────────────────────
// El comensal deja de ser un cliente de un restaurante y pasa a tener una
// identidad propia por encima de todos: historial cruzado, experiencia,
// reseñas verificadas y reputación (mig 200 + docs/design/identidad-comensal).
//
// LO QUE ESTE PANEL **NO** HACE — y es la decisión de arquitectura más
// importante del archivo: NO reimplementa el flujo de pedido. Menú, carrito,
// extras, mitad-y-mitad, cupones, métodos de pago, comprobantes y facturación
// viven en `index.html` (QR) y `delivery-cliente.html`, que son ~5.600 líneas
// entre los dos. Una segunda copia se desincronizaría al primer cambio de
// precios y terminaría cobrando distinto que la caja. Acá se descubre, se
// entra al panel que ya sabe pedir, y se vuelve con el pedido hecho.
//
// BETA CERRADA: el portero real está en la base (ensure_my_diner falla si el
// correo no está en diner_app_access). Lo de acá es sólo la pantalla.
// ════════════════════════════════════════════════════════════════════
import React from "react";
import { createRoot } from "react-dom/client";
import {
  ThemeCtx, makeTheme, useT, Icon, Stars, Btn, Card, Pill, Empty, Spinner,
  XpBar, fmt, num, FONT
} from "./theme.jsx";
import * as API from "./api.js";

const { useState, useEffect, useCallback, useRef, useMemo } = React;

/* ══ SERVICIOS ═══════════════════════════════════════════════════ */
const SERVICES = [
  { key: 'dine_in',  label: 'En el local', icon: 'utensils' },
  { key: 'delivery', label: 'Delivery',    icon: 'bike' },
  { key: 'pickup',   label: 'Retiro',      icon: 'bag' }
];

/* ══ TOAST ═══════════════════════════════════════════════════════ */
function Toast({ msg, onHide }) {
  const T = useT();
  useEffect(() => { const t = setTimeout(onHide, 2600); return () => clearTimeout(t); }, [msg]);
  return (
    <div style={{ position: 'fixed', top: 58, left: '50%', transform: 'translateX(-50%)',
                  background: T.black, color: '#FFF', borderRadius: 9999, padding: '10px 20px',
                  fontSize: 13, fontWeight: 600, zIndex: 9999, maxWidth: 330, textAlign: 'center',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.35)', animation: 'fadeIn 200ms' }}>
      {msg}
    </div>
  );
}

/* ══ HOJA INFERIOR ═══════════════════════════════════════════════ */
// Cierre SÓLO con la X o con "Cancelar" — nunca con click en el fondo.
// Regla de CLAUDE.md: seleccionar texto y soltar fuera perdía todo lo cargado.
function Sheet({ title, children, onClose, footer }) {
  const T = useT();
  useEffect(() => {
    const esc = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)',
                  zIndex: 900, display: 'flex', alignItems: 'flex-end' }}>
      <div style={{ background: T.white, width: '100%', maxHeight: '92%', borderRadius: '20px 20px 0 0',
                    display: 'flex', flexDirection: 'column', animation: 'slideUp 260ms ease' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '16px 18px 12px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: T.ink }}>{title}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
            <Icon name="x" size={19} color={T.mid} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>{children}</div>
        {footer && <div style={{ padding: 16, borderTop: `1px solid ${T.border}`, flexShrink: 0 }}>{footer}</div>}
      </div>
    </div>
  );
}

/* ══ PANTALLA: ACCESO ════════════════════════════════════════════ */
function LoginScreen({ onFlash }) {
  const T = useT();
  const [email, setEmail] = useState('');
  const [busy, setBusy]   = useState('');
  const [sent, setSent]   = useState(false);
  const googleOn = !!(window.MYTHOS_CONFIG && window.MYTHOS_CONFIG.authProviders
                      && window.MYTHOS_CONFIG.authProviders.google);

  const withGoogle = async () => {
    setBusy('google');
    try { await API.signInWithGoogle(); }
    catch (e) { onFlash('No pudimos abrir Google. ' + (e.message || '')); setBusy(''); }
  };

  const withEmail = async () => {
    const v = email.trim();
    if (!v || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { onFlash('Escribí un correo válido.'); return; }
    setBusy('email');
    try { await API.signInWithEmail(v); setSent(true); }
    catch (e) { onFlash(e.message || 'No pudimos enviar el enlace.'); }
    setBusy('');
  };

  return (
    <div style={{ height: '100%', background: T.offwhite, display: 'flex', flexDirection: 'column',
                  padding: '0 26px', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', marginBottom: 34 }}>
        <div style={{ fontFamily: T.F.h, fontSize: 40, fontWeight: 400, color: T.ink,
                      letterSpacing: '-0.5px', marginBottom: 8 }}>Mythos</div>
        <div style={{ fontSize: 11, fontWeight: 800, color: T.gray, letterSpacing: '0.18em',
                      textTransform: 'uppercase' }}>Explorador Gastronómico</div>
      </div>

      {sent ? (
        <Card style={{ textAlign: 'center' }}>
          <Icon name="mail" size={30} color={T.ink} />
          <div style={{ fontSize: 16, fontWeight: 800, color: T.ink, margin: '12px 0 6px' }}>
            Revisá tu correo
          </div>
          <div style={{ fontSize: 13, color: T.gray, lineHeight: 1.7 }}>
            Te mandamos un enlace a <b style={{ color: T.ink }}>{email.trim()}</b>. Abrilo desde este
            mismo teléfono y entrás directo — no hay contraseña que recordar.
          </div>
          <div style={{ marginTop: 16 }}>
            <Btn variant="ghost" onClick={() => setSent(false)}>Usar otro correo</Btn>
          </div>
        </Card>
      ) : (
        <>
          {googleOn && (
            <Btn variant="ghost" onClick={withGoogle} disabled={busy === 'google'} style={{ marginBottom: 12 }}>
              {busy === 'google' ? <Spinner size={16} /> : <GoogleMark />}
              Continuar con Google
            </Btn>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '18px 0',
                        color: T.silver, fontSize: 11, fontWeight: 700, letterSpacing: '.1em' }}>
            <div style={{ flex: 1, height: 1, background: T.border }} />
            {googleOn ? 'O CON TU CORREO' : 'ENTRÁ CON TU CORREO'}
            <div style={{ flex: 1, height: 1, background: T.border }} />
          </div>

          <input value={email} onChange={e => setEmail(e.target.value)} type="email"
            inputMode="email" autoComplete="email" placeholder="tu@correo.com"
            onKeyDown={e => { if (e.key === 'Enter') withEmail(); }}
            style={{ width: '100%', height: 48, background: T.white, border: `1px solid ${T.border}`,
                     borderRadius: 12, padding: '0 15px', fontSize: 15, color: T.ink,
                     fontFamily: FONT, outline: 'none', marginBottom: 12 }} />
          <Btn onClick={withEmail} disabled={busy === 'email'}>
            {busy === 'email' ? <Spinner size={16} color={T.btnPrimaryText} /> : null}
            Enviarme el enlace
          </Btn>

          <div style={{ fontSize: 11.5, color: T.gray, textAlign: 'center', marginTop: 20, lineHeight: 1.7 }}>
            Sin contraseña. El enlace del correo es a la vez tu forma de entrar
            y de recuperar la cuenta.
          </div>
        </>
      )}
    </div>
  );
}

const GoogleMark = () => (
  <svg width="17" height="17" viewBox="0 0 24 24">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0012 23z"/>
    <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 010-4.2V7.06H2.18a11 11 0 000 9.88l3.66-2.84z"/>
    <path fill="#EA4335" d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.46 14.97.5 12 .5A11 11 0 002.18 7.06L5.84 9.9c.87-2.6 3.3-4.53 6.16-4.53z"/>
  </svg>
);

/* ══ PANTALLA: BETA CERRADA ══════════════════════════════════════ */
function ClosedScreen({ email, message, onOut }) {
  const T = useT();
  return (
    <div style={{ height: '100%', background: T.offwhite, display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center', padding: '0 30px', textAlign: 'center' }}>
      <Icon name="shield" size={38} color={T.silver} />
      <div style={{ fontSize: 19, fontWeight: 800, color: T.ink, margin: '16px 0 8px' }}>
        Todavía no está abierta
      </div>
      <div style={{ fontSize: 13.5, color: T.gray, lineHeight: 1.75, maxWidth: 290 }}>
        {message || 'La app de comensales está en pruebas cerradas.'}
      </div>
      {email && (
        <div style={{ marginTop: 18, fontSize: 12, color: T.silver }}>
          Entraste como <b style={{ color: T.mid }}>{email}</b>
        </div>
      )}
      <div style={{ marginTop: 26, width: '100%', maxWidth: 260 }}>
        <Btn variant="ghost" onClick={onOut}><Icon name="logout" size={15} /> Salir</Btn>
      </div>
    </div>
  );
}

/* ══ PANTALLA: REGISTRO DE GUSTOS ════════════════════════════════ */
// El alta no puede ser sólo nombre y correo. Lo que hace útil a la app —y lo
// que un local no puede saber solo— es qué come esta persona. Las preguntas
// son DATOS (diner_profile_questions): se cambian desde el superadmin, sin
// tocar este archivo ni pedir una migración.
function OnboardingScreen({ boot, onDone, onFlash }) {
  const T = useT();
  const [qs, setQs]         = useState(null);
  const [step, setStep]     = useState(0);
  const [name, setName]     = useState(boot?.diner?.display_name || '');
  const [ans, setAns]       = useState({});
  const [busy, setBusy]     = useState(false);

  useEffect(() => {
    (async () => {
      const [list, mine] = await Promise.all([API.loadQuestions(), API.loadMyAnswers()]);
      setQs(list); setAns(mine || {});
    })();
  }, []);

  const steps = useMemo(() => {
    if (!qs) return [];
    const by = {};
    qs.forEach(q => { (by[q.step] = by[q.step] || []).push(q); });
    return Object.keys(by).sort((a, b) => a - b).map(k => by[k]);
  }, [qs]);

  if (!qs) return <Loading />;

  const total   = steps.length + 1;      // +1 = la pantalla del nombre
  const isName  = step === 0;
  const current = isName ? [] : (steps[step - 1] || []);

  const setVal = (code, v) => setAns(a => ({ ...a, [code]: v }));

  const toggleMulti = (code, v) => {
    const cur = Array.isArray(ans[code]) ? ans[code] : [];
    setVal(code, cur.includes(v) ? cur.filter(x => x !== v) : cur.concat(v));
  };

  const canNext = () => {
    if (isName) return name.trim().length >= 2;
    return current.filter(q => q.is_required).every(q => {
      const v = ans[q.code];
      return Array.isArray(v) ? v.length > 0 : (v != null && String(v).trim() !== '');
    });
  };

  const next = async () => {
    if (!canNext()) { onFlash('Falta responder algo de esta pantalla.'); return; }
    if (step < total - 1) { setStep(step + 1); return; }
    setBusy(true);
    const payload = {
      display_name: name.trim(),
      city: typeof ans.ciudad === 'string' ? ans.ciudad.trim() : null,
      birth_date: ans.cumple || null,
      answers: ans
    };
    const { data, error } = await API.saveProfile(payload);
    setBusy(false);
    if (error) { onFlash('No pudimos guardar tus gustos. Probá de nuevo.'); return; }
    onDone(data?.xp || 0);
  };

  return (
    <div style={{ height: '100%', background: T.offwhite, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '48px 22px 14px', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 5, marginBottom: 18 }}>
          {Array.from({ length: total }).map((_, i) => (
            <div key={i} style={{ flex: 1, height: 3, borderRadius: 9999,
                                  background: i <= step ? T.ink : T.border }} />
          ))}
        </div>
        <div style={{ fontSize: 11, fontWeight: 800, color: T.gray, letterSpacing: '.16em',
                      textTransform: 'uppercase', marginBottom: 6 }}>
          Paso {step + 1} de {total}
        </div>
        <div style={{ fontFamily: T.F.h, fontSize: 26, color: T.ink, lineHeight: 1.2 }}>
          {isName ? '¿Cómo te llamamos?' : 'Contanos qué te gusta'}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 22px 20px' }}>
        {isName ? (
          <>
            <input value={name} onChange={e => setName(e.target.value)} autoFocus
              placeholder="Tu nombre"
              style={{ width: '100%', height: 50, background: T.white, border: `1px solid ${T.border}`,
                       borderRadius: 12, padding: '0 15px', fontSize: 16, color: T.ink,
                       fontFamily: FONT, outline: 'none' }} />
            <div style={{ fontSize: 12.5, color: T.gray, lineHeight: 1.7, marginTop: 14 }}>
              Es el nombre que van a ver los demás en tus reseñas y en el ranking.
              Tu correo no se muestra nunca.
            </div>
          </>
        ) : current.map(q => (
          <div key={q.code} style={{ marginBottom: 26 }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: T.ink, marginBottom: 3 }}>
              {q.label}{q.is_required && <span style={{ color: T.bad }}> *</span>}
            </div>
            {q.help && <div style={{ fontSize: 12, color: T.gray, marginBottom: 10 }}>{q.help}</div>}
            {!q.help && <div style={{ height: 8 }} />}

            {(q.kind === 'multi' || q.kind === 'single') && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {(q.options || []).map(o => {
                  const on = q.kind === 'multi'
                    ? (Array.isArray(ans[q.code]) && ans[q.code].includes(o.value))
                    : ans[q.code] === o.value;
                  return (
                    <Pill key={o.value} active={on}
                      onClick={() => q.kind === 'multi' ? toggleMulti(q.code, o.value) : setVal(q.code, o.value)}>
                      {o.emoji ? o.emoji + ' ' : ''}{o.label}
                    </Pill>
                  );
                })}
              </div>
            )}

            {(q.kind === 'text' || q.kind === 'number' || q.kind === 'date') && (
              <input
                type={q.kind === 'date' ? 'date' : q.kind === 'number' ? 'number' : 'text'}
                value={ans[q.code] || ''} onChange={e => setVal(q.code, e.target.value)}
                style={{ width: '100%', height: 46, background: T.white, border: `1px solid ${T.border}`,
                         borderRadius: 12, padding: '0 14px', fontSize: 15, color: T.ink,
                         fontFamily: FONT, outline: 'none' }} />
            )}
          </div>
        ))}
      </div>

      <div style={{ padding: '12px 22px 26px', flexShrink: 0, display: 'flex', gap: 10 }}>
        {step > 0 && <Btn variant="ghost" onClick={() => setStep(step - 1)} style={{ width: 100 }} full={false}>Atrás</Btn>}
        <Btn onClick={next} disabled={busy}>
          {busy ? <Spinner size={16} color={T.btnPrimaryText} /> : null}
          {step < total - 1 ? 'Seguir' : 'Listo'}
        </Btn>
      </div>
    </div>
  );
}

/* ══ CABECERA ════════════════════════════════════════════════════ */
function TopBar({ me, carts, onCart, onNotif, notifCount, dark, onTheme }) {
  const T = useT();
  return (
    <div style={{ background: T.hdrBg, padding: '46px 20px 14px', flexShrink: 0,
                  borderBottom: `1px solid ${T.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, color: T.hdrSub, letterSpacing: '.14em',
                        textTransform: 'uppercase', marginBottom: 2 }}>
            Nivel {me?.level || 1} · {me?.level_name || 'Novato'}
          </div>
          <div style={{ fontFamily: T.F.h, fontSize: 22, color: T.hdrText, lineHeight: 1.1,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Hola{me?.display_name ? ', ' + me.display_name.split(' ')[0] : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <RoundBtn icon={dark ? 'sun' : 'moon'} onClick={onTheme} />
          <RoundBtn icon="bell" onClick={onNotif} badge={notifCount} />
          <RoundBtn icon="cart" onClick={onCart} badge={carts.reduce((s, c) => s + c.count, 0)} />
        </div>
      </div>
    </div>
  );
}

function RoundBtn({ icon, onClick, badge }) {
  const T = useT();
  return (
    <button onClick={onClick} style={{ position: 'relative', width: 38, height: 38, borderRadius: '50%',
      background: T.softBg, border: `1px solid ${T.softBorder}`, cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.hdrText }}>
      <Icon name={icon} size={17} color={T.hdrText} />
      {badge > 0 && (
        <span style={{ position: 'absolute', top: -3, right: -3, minWidth: 17, height: 17,
                       borderRadius: 9999, background: T.bad, color: '#FFF', fontSize: 10,
                       fontWeight: 800, display: 'flex', alignItems: 'center',
                       justifyContent: 'center', padding: '0 4px' }}>{badge > 9 ? '9+' : badge}</span>
      )}
    </button>
  );
}

/* ══ NAVEGACIÓN INFERIOR ═════════════════════════════════════════ */
// Abajo, al alcance del pulgar: el comensal entra de noche, con una mano y
// con hambre. No es el sidebar de los paneles de staff (§9 del diseño).
function BottomNav({ tab, setTab }) {
  const T = useT();
  const items = [
    { k: 'home',    label: 'Explorar', icon: 'search' },
    { k: 'orders',  label: 'Pedidos',  icon: 'bag' },
    { k: 'ranking', label: 'Ranking',  icon: 'trophy' },
    { k: 'profile', label: 'Perfil',   icon: 'user' }
  ];
  return (
    <div style={{ display: 'flex', background: T.white, borderTop: `1px solid ${T.border}`,
                  flexShrink: 0, paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {items.map(it => {
        const on = tab === it.k;
        return (
          <button key={it.k} onClick={() => setTab(it.k)} style={{
            flex: 1, background: 'none', border: 'none', cursor: 'pointer',
            padding: '10px 0 12px', display: 'flex', flexDirection: 'column',
            alignItems: 'center', gap: 3, color: on ? T.ink : T.silver }}>
            <Icon name={it.icon} size={20} color={on ? T.ink : T.silver} sw={on ? 2 : 1.5} />
            <span style={{ fontSize: 10, fontWeight: on ? 800 : 600 }}>{it.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ══ PANTALLA: EXPLORAR ══════════════════════════════════════════ */
function HomeScreen({ me, onOpen, onFlash }) {
  const T = useT();
  const [service, setService] = useState('dine_in');
  const [search, setSearch]   = useState('');
  const [city, setCity]       = useState('');
  const [type, setType]       = useState('');
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, missing } = await API.discover({ search, city, service, type });
    setMissing(missing); setData(data); setLoading(false);
  }, [search, city, service, type]);

  // Debounce del buscador: sin esto se dispara una consulta por tecla.
  useEffect(() => { const t = setTimeout(load, search ? 320 : 0); return () => clearTimeout(t); }, [load]);

  if (missing) return <MissingMigration what="el descubrimiento de restaurantes" />;

  const rows   = data?.rows || [];
  const cities = data?.cities || [];
  const types  = data?.types || [];
  const favs   = rows.filter(r => r.is_favorite);
  const nuevos = rows.filter(r => !r.visited);

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: T.offwhite }}>
      {/* Tarjeta de identidad — lo primero es quién sos, no una lista */}
      <div style={{ padding: '14px 18px 4px' }}>
        <Card style={{ background: T.ink, border: 'none' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 800, color: 'rgba(255,255,255,.55)',
                            letterSpacing: '.16em', textTransform: 'uppercase' }}>
                Explorador Gastronómico
              </div>
              <div style={{ fontFamily: T.F.h, fontSize: 25, color: '#FFF', marginTop: 5 }}>
                Nivel {me?.level || 1} · {me?.level_name || 'Novato'}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 21, fontWeight: 800, color: '#FFF' }}>{num(me?.xp || 0)}</div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,.55)', fontWeight: 700,
                            letterSpacing: '.1em' }}>XP</div>
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <XpBar xp={me?.xp || 0} min={me?.level_min_xp || 0} next={me?.next_level_xp} />
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,.55)', marginTop: 7 }}>
              {me?.next_level_xp
                ? `${num(me.next_level_xp - (me.xp || 0))} XP para el nivel ${(me.level || 1) + 1}`
                : 'Llegaste al nivel máximo'}
            </div>
          </div>
        </Card>
      </div>

      {/* Servicio */}
      <div style={{ display: 'flex', gap: 8, padding: '14px 18px 8px' }}>
        {SERVICES.map(s => (
          <button key={s.key} onClick={() => setService(s.key)} style={{
            flex: 1, background: service === s.key ? T.ink : T.white,
            color: service === s.key ? T.white : T.mid,
            border: `1px solid ${service === s.key ? T.ink : T.border}`,
            borderRadius: 12, padding: '11px 4px', cursor: 'pointer', fontFamily: FONT,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
            <Icon name={s.icon} size={17} color={service === s.key ? T.white : T.mid} />
            <span style={{ fontSize: 11.5, fontWeight: 700 }}>{s.label}</span>
          </button>
        ))}
      </div>

      {/* Buscador */}
      <div style={{ padding: '6px 18px 10px', position: 'relative' }}>
        <div style={{ position: 'absolute', left: 30, top: '50%', transform: 'translateY(-50%)' }}>
          <Icon name="search" size={15} color={T.gray} />
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Buscar restaurante o tipo de comida…"
          style={{ width: '100%', height: 44, background: T.white, border: `1px solid ${T.border}`,
                   borderRadius: 12, paddingLeft: 38, paddingRight: 14, fontSize: 13.5,
                   color: T.ink, fontFamily: FONT, outline: 'none' }} />
      </div>

      {/* Filtros */}
      {(cities.length > 1 || types.length > 1) && (
        <div style={{ display: 'flex', gap: 7, overflowX: 'auto', padding: '2px 18px 12px' }}>
          {cities.length > 1 && <Pill active={!city} onClick={() => setCity('')}>
            <Icon name="map" size={12} /> Todas
          </Pill>}
          {cities.map(c => <Pill key={c} active={city === c} onClick={() => setCity(city === c ? '' : c)}>{c}</Pill>)}
          {types.map(t => <Pill key={t} active={type === t} onClick={() => setType(type === t ? '' : t)}>{t}</Pill>)}
        </div>
      )}

      {loading ? <Loading /> : rows.length === 0 ? (
        <Empty icon="search" title="No encontramos nada"
               text="Probá con otro nombre, otra ciudad o cambiá el tipo de servicio." />
      ) : (
        <div style={{ padding: '0 18px 20px' }}>
          {favs.length > 0 && !search && (
            <Section title="Tus favoritos" icon="heart">
              {favs.map(r => <RestRow key={'f' + r.id} r={r} service={service} onOpen={onOpen} />)}
            </Section>
          )}
          {nuevos.length > 0 && !search && (
            <Section title="Todavía no probaste" icon="sparkle">
              <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 6 }}>
                {nuevos.slice(0, 8).map(r => <RestCardH key={'n' + r.id} r={r} onOpen={onOpen} />)}
              </div>
            </Section>
          )}
          <Section title={search ? `${rows.length} resultado${rows.length !== 1 ? 's' : ''}` : 'Todos los restaurantes'}
                   icon="utensils">
            {rows.map(r => <RestRow key={r.id} r={r} service={service} onOpen={onOpen} />)}
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({ title, icon, children }) {
  const T = useT();
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <Icon name={icon} size={13} color={T.ink} />
        <span style={{ fontSize: 11, fontWeight: 800, color: T.ink, letterSpacing: '.14em',
                       textTransform: 'uppercase' }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

function RestLogo({ r, size = 54, radius = 12 }) {
  const T = useT();
  return (
    <div style={{ width: size, height: size, borderRadius: radius, flexShrink: 0, overflow: 'hidden',
                  background: r.logo_url ? 'transparent' : `linear-gradient(135deg,${T.dark},${T.black})`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {r.logo_url
        ? <img src={r.logo_url} alt={r.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : <span style={{ color: 'rgba(255,255,255,.85)', fontWeight: 800, fontSize: size * 0.32 }}>
            {r.logo_initials || (r.name || '?').slice(0, 2).toUpperCase()}
          </span>}
    </div>
  );
}

function RestRow({ r, service, onOpen }) {
  const T = useT();
  return (
    <div onClick={() => onOpen(r, service)} style={{
      display: 'flex', gap: 12, alignItems: 'center', padding: '12px 0',
      borderBottom: `1px solid ${T.border}`, cursor: 'pointer' }}>
      <RestLogo r={r} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 14.5, fontWeight: 700, color: T.ink, overflow: 'hidden',
                         textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
          {r.is_favorite && <Icon name="heart" size={12} color={T.ink} />}
        </div>
        <div style={{ fontSize: 12, color: T.gray, marginTop: 2, overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {[r.business_type, r.city].filter(Boolean).join(' · ') || 'Restaurante'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 5 }}>
          {r.rating ? (
            <>
              <Stars value={r.rating} size={11} />
              <span style={{ fontSize: 11.5, fontWeight: 700, color: T.ink }}>{r.rating}</span>
              <span style={{ fontSize: 11, color: T.silver }}>({r.review_count})</span>
            </>
          ) : (
            <span style={{ fontSize: 11, color: T.silver }}>Sin reseñas todavía</span>
          )}
          {!r.visited && (
            <span style={{ fontSize: 9.5, fontWeight: 800, color: T.ink, background: T.softBg,
                           border: `1px solid ${T.softBorder}`, borderRadius: 5, padding: '1px 6px',
                           letterSpacing: '.06em' }}>+70 XP</span>
          )}
        </div>
      </div>
      <Icon name="chevron" size={16} color={T.silver} />
    </div>
  );
}

function RestCardH({ r, onOpen }) {
  const T = useT();
  return (
    <div onClick={() => onOpen(r)} style={{
      flexShrink: 0, width: 140, background: T.white, border: `1px solid ${T.border}`,
      borderRadius: 14, overflow: 'hidden', cursor: 'pointer' }}>
      <div style={{ height: 78, background: r.cover_image_url ? 'transparent' : `linear-gradient(135deg,${T.dark},${T.black})`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {r.cover_image_url
          ? <img src={r.cover_image_url} alt={r.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <Icon name="utensils" size={24} color="rgba(255,255,255,.18)" />}
      </div>
      <div style={{ padding: '9px 10px' }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: T.ink, lineHeight: 1.3,
                      overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical', minHeight: 32 }}>{r.name}</div>
        <div style={{ fontSize: 10.5, color: T.gray, marginTop: 3 }}>{r.business_type || 'Restaurante'}</div>
      </div>
    </div>
  );
}

/* ══ HOJA: RESTAURANTE ═══════════════════════════════════════════ */
function RestaurantSheet({ r, service, onClose, onFlash, onChanged }) {
  const T = useT();
  const [rev, setRev]   = useState(null);
  const [fav, setFav]   = useState(!!r.is_favorite);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => { const { data } = await API.restaurantReviews(r.id); setRev(data); })();
  }, [r.id]);

  const toggleFav = async () => {
    setBusy(true);
    const { data, error } = await API.toggleFavorite(r.id);
    setBusy(false);
    if (error) { onFlash('No pudimos guardar el favorito.'); return; }
    setFav(!!data); onChanged && onChanged();
    onFlash(data ? 'Agregado a favoritos' : 'Quitado de favoritos');
  };

  const go = (svc) => { window.location.href = API.orderUrl(r.id, svc); };

  const dims = rev?.dimensions || {};
  const dimKeys = Object.keys(dims);

  return (
    <Sheet title={r.name} onClose={onClose} footer={
      <div style={{ display: 'flex', gap: 9 }}>
        <Btn variant="ghost" onClick={toggleFav} disabled={busy} full={false} style={{ width: 52 }}>
          <Icon name="heart" size={18} color={fav ? T.bad : T.mid} />
        </Btn>
        <Btn onClick={() => go(service === 'delivery' ? 'delivery' : 'dine_in')}>
          {service === 'delivery' ? 'Pedir a domicilio' : 'Ver la carta y pedir'}
        </Btn>
      </div>
    }>
      <div style={{ display: 'flex', gap: 13, alignItems: 'center', marginBottom: 18 }}>
        <RestLogo r={r} size={62} radius={14} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, color: T.gray }}>
            {[r.business_type, r.city].filter(Boolean).join(' · ') || 'Restaurante'}
          </div>
          {rev?.count > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 5 }}>
              <Stars value={rev.avg} size={14} />
              <span style={{ fontSize: 15, fontWeight: 800, color: T.ink }}>{rev.avg}</span>
              <span style={{ fontSize: 11.5, color: T.silver }}>· {rev.count} reseña{rev.count !== 1 ? 's' : ''}</span>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: T.silver, marginTop: 5 }}>Todavía nadie lo calificó</div>
          )}
          {r.address && <div style={{ fontSize: 11.5, color: T.silver, marginTop: 4 }}>{r.address}</div>}
        </div>
      </div>

      {/* La nota ponderada existe porque no todas las opiniones pesan igual:
          una reseña de alguien con 300 pedidos y 250 votos útiles no vale lo
          mismo que la de una cuenta de ayer. */}
      {rev?.weighted_avg != null && rev.weighted_avg !== rev.avg && (
        <div style={{ background: T.softBg, border: `1px solid ${T.softBorder}`, borderRadius: 12,
                      padding: '10px 13px', marginBottom: 16, display: 'flex',
                      alignItems: 'center', gap: 9 }}>
          <Icon name="shield" size={15} color={T.mid} />
          <div style={{ fontSize: 11.5, color: T.mid, lineHeight: 1.55 }}>
            Nota ponderada por credibilidad: <b style={{ color: T.ink }}>{rev.weighted_avg}</b>
          </div>
        </div>
      )}

      {dimKeys.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <SectionLabel>Cómo lo califican</SectionLabel>
          {dimKeys.map(k => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                  padding: '7px 0', borderBottom: `1px solid ${T.border}` }}>
              <span style={{ fontSize: 13, color: T.mid, textTransform: 'capitalize' }}>{k}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <Stars value={dims[k]} size={11} />
                <span style={{ fontSize: 12, fontWeight: 700, color: T.ink, width: 26,
                               textAlign: 'right' }}>{dims[k]}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <SectionLabel>Reseñas verificadas</SectionLabel>
      {!rev ? <Loading /> : (rev.rows || []).length === 0 ? (
        <div style={{ fontSize: 12.5, color: T.gray, lineHeight: 1.7, padding: '8px 0 4px' }}>
          Nadie lo reseñó todavía. Sólo puede opinar quien pidió y pagó acá, así que
          la primera reseña puede ser la tuya.
        </div>
      ) : rev.rows.map(rv => (
        <ReviewCard key={rv.id} rv={rv} onVote={async (kind, on) => {
          const { data } = await API.voteReview(rv.id, kind, on);
          if (data?.ok) { const { data: d2 } = await API.restaurantReviews(r.id); setRev(d2); }
          else onFlash(data?.error || 'No pudimos registrar tu voto.');
        }} />
      ))}
    </Sheet>
  );
}

function SectionLabel({ children }) {
  const T = useT();
  return <div style={{ fontSize: 10.5, fontWeight: 800, color: T.gray, letterSpacing: '.15em',
                       textTransform: 'uppercase', marginBottom: 10 }}>{children}</div>;
}

const VOTE_KINDS = [
  { k: 'helpful',  emoji: '👍', label: 'Útil' },
  { k: 'detailed', emoji: '👏', label: 'Detallada' },
  { k: 'decided',  emoji: '🍽', label: 'Me ayudó' }
];

function ReviewCard({ rv, onVote }) {
  const T = useT();
  const mine = rv.my_votes || [];
  const scores = rv.scores || {};
  const scoreKeys = Object.keys(scores);
  return (
    <div style={{ padding: '14px 0', borderBottom: `1px solid ${T.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 7 }}>
        <div style={{ width: 32, height: 32, borderRadius: '50%', background: T.softBg,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      overflow: 'hidden', flexShrink: 0 }}>
          {rv.author_avatar
            ? <img src={rv.author_avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <span style={{ fontSize: 12, fontWeight: 800, color: T.mid }}>{(rv.author || '?')[0].toUpperCase()}</span>}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.ink }}>{rv.author}</div>
          <div style={{ fontSize: 10.5, color: T.silver }}>
            Nivel {rv.author_level} · {rv.author_level_name} · credibilidad {rv.author_credibility}%
          </div>
        </div>
        <Stars value={rv.stars} size={12} />
      </div>

      {rv.comment && (
        <div style={{ fontSize: 13, color: T.mid, lineHeight: 1.65, marginBottom: 8 }}>{rv.comment}</div>
      )}

      {(rv.photos || []).length > 0 && (
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 9 }}>
          {rv.photos.map((p, i) => (
            <img key={i} src={p} alt="" style={{ width: 78, height: 78, objectFit: 'cover',
                                                 borderRadius: 9, flexShrink: 0 }} />
          ))}
        </div>
      )}

      {scoreKeys.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 9 }}>
          {scoreKeys.map(k => (
            <span key={k} style={{ fontSize: 10.5, color: T.mid, background: T.softBg,
                                   border: `1px solid ${T.softBorder}`, borderRadius: 6,
                                   padding: '2px 7px' }}>
              {k} {scores[k]}★
            </span>
          ))}
        </div>
      )}

      {rv.restaurant_reply && (
        <div style={{ background: T.softBg, borderLeft: `2px solid ${T.ink}`, borderRadius: '0 8px 8px 0',
                      padding: '9px 12px', marginBottom: 9 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: T.gray, letterSpacing: '.1em',
                        textTransform: 'uppercase', marginBottom: 3 }}>Respuesta del local</div>
          <div style={{ fontSize: 12, color: T.mid, lineHeight: 1.6 }}>{rv.restaurant_reply}</div>
        </div>
      )}

      {!rv.is_mine && (
        <div style={{ display: 'flex', gap: 6 }}>
          {VOTE_KINDS.map(v => {
            const on = mine.includes(v.k);
            const n  = v.k === 'helpful' ? rv.helpful_count
                     : v.k === 'detailed' ? rv.detailed_count : rv.decided_count;
            return (
              <button key={v.k} onClick={() => onVote(v.k, !on)} style={{
                background: on ? T.ink : 'transparent', color: on ? T.white : T.mid,
                border: `1px solid ${on ? T.ink : T.border}`, borderRadius: 9999,
                padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                fontFamily: FONT, display: 'flex', alignItems: 'center', gap: 4 }}>
                <span>{v.emoji}</span>{v.label}{n > 0 ? ` ${n}` : ''}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ══ PANTALLA: PEDIDOS ═══════════════════════════════════════════ */
function OrdersScreen({ onRate, onFlash }) {
  const T = useT();
  const [rows, setRows]       = useState(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    const { data, missing } = await API.myOrders();
    setMissing(missing); setRows(Array.isArray(data) ? data : []);
  }, []);
  useEffect(() => { load(); }, [load]);

  if (missing) return <MissingMigration what="tu historial de pedidos" />;
  if (!rows)   return <Loading />;

  if (rows.length === 0) return (
    <div style={{ flex: 1, overflowY: 'auto', background: T.offwhite }}>
      <Empty icon="bag" title="Todavía no hay pedidos"
             text="Cuando pidas con la sesión iniciada, el pedido aparece acá — sin importar en qué restaurante lo hayas hecho." />
    </div>
  );

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: T.offwhite, padding: '14px 18px 20px' }}>
      {rows.map(o => <OrderRow key={o.id} o={o} onRate={onRate} onFlash={onFlash} />)}
    </div>
  );
}

const STATUS_LABEL = {
  draft: 'Borrador', confirmed: 'Confirmado', paid: 'Pago aprobado',
  kitchen_received: 'En cocina', cooking: 'Preparando', ready: 'Listo',
  delivered: 'Entregado', cancelled: 'Cancelado'
};
const RIDER_LABEL = {
  pending: 'Buscando repartidor', confirmed: 'Repartidor asignado',
  picked_up: 'Retirado del local', on_way: 'En camino',
  delivered: 'Entregado', cancelled: 'Cancelado'
};

function OrderRow({ o, onRate, onFlash }) {
  const T = useT();
  const done = o.status === 'delivered' || o.rider_status === 'delivered';
  const items = (o.items || []).map(i => `${i.qty}× ${i.name}`).join(' · ');
  const estado = o.delivery_order_id
    ? (RIDER_LABEL[o.rider_status] || STATUS_LABEL[o.status] || o.status)
    : (STATUS_LABEL[o.status] || o.status);

  return (
    <Card style={{ marginBottom: 11 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 700, color: T.ink }}>{o.restaurant_name}</div>
          <div style={{ fontSize: 11.5, color: T.silver, marginTop: 2 }}>
            #{o.order_number} · {new Date(o.created_at).toLocaleDateString('es-PY', {
              day: '2-digit', month: 'short', year: 'numeric' })}
          </div>
        </div>
        <div style={{ fontFamily: T.F.h, fontSize: 17, color: T.ink, flexShrink: 0 }}>{fmt(o.total)}</div>
      </div>

      {items && (
        <div style={{ fontSize: 12, color: T.gray, marginTop: 8, lineHeight: 1.5,
                      overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical' }}>{items}</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%',
                       background: done ? T.good : T.warn, flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: done ? T.good : T.warn }}>{estado}</span>
        {o.rider_name && <span style={{ fontSize: 11, color: T.silver }}>· {o.rider_name}</span>}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 13 }}>
        <Btn variant="soft" style={{ height: 40, fontSize: 13 }}
             onClick={() => { window.location.href = API.orderUrl(o.restaurant_id,
                              o.delivery_order_id ? 'delivery' : 'dine_in'); }}>
          <Icon name="repeat" size={14} /> Pedir de nuevo
        </Btn>
        {/* La opción de calificar aparece cuando la comida YA llegó. La base
            además exige que el pedido esté pagado y que sea tuyo: una reseña
            por pedido, y nadie opina de lo que no comió. */}
        {done && !o.reviewed && (
          <Btn style={{ height: 40, fontSize: 13 }} onClick={() => onRate(o)}>
            <Icon name="star" size={14} /> Calificar
          </Btn>
        )}
        {o.reviewed && (
          <div style={{ flex: 1, height: 40, display: 'flex', alignItems: 'center',
                        justifyContent: 'center', gap: 6, color: T.good, fontSize: 12.5,
                        fontWeight: 700 }}>
            <Icon name="check" size={14} color={T.good} /> Ya lo calificaste
          </div>
        )}
      </div>
    </Card>
  );
}

/* ══ HOJA: CALIFICAR ═════════════════════════════════════════════ */
function RateSheet({ order, boot, onClose, onDone, onFlash }) {
  const T = useT();
  const [dims, setDims]       = useState(null);
  const [stars, setStars]     = useState(0);
  const [scores, setScores]   = useState({});
  const [comment, setComment] = useState('');
  const [photos, setPhotos]   = useState([]);
  const [busy, setBusy]       = useState(false);
  const fileRef = useRef(null);

  const service = order.delivery_order_id ? 'delivery'
                : (order.order_type === 'pickup' || order.order_type === 'llevar') ? 'pickup' : 'dine_in';

  useEffect(() => { (async () => setDims(await API.loadDimensions()))(); }, []);

  const shown = (dims || []).filter(d => d.applies_to === 'all' || d.applies_to === service);
  const answered = Object.keys(scores).filter(k => scores[k] > 0).length;
  const minChars = boot?.review_min_chars || 0;

  const send = async () => {
    if (stars < 1) { onFlash('Elegí una calificación general.'); return; }
    if (minChars > 0 && comment.trim().length < minChars) {
      onFlash(`Contanos un poco más (mínimo ${minChars} caracteres).`); return;
    }
    setBusy(true);
    const { data, error, missing } = await API.submitReview({
      order_id: order.id, stars, comment: comment.trim() || null, scores
    });
    if (missing) { setBusy(false); onFlash('Las reseñas todavía no están disponibles.'); return; }
    if (error || !data?.ok) { setBusy(false); onFlash(data?.error || 'No pudimos publicar tu reseña.'); return; }

    // Las fotos se suben DESPUÉS: la reseña ya está publicada, así que si
    // falla una subida no se pierde la opinión (que es lo caro de escribir).
    for (const f of photos) { try { await API.uploadReviewPhoto(f, data.review_id); } catch (_) {} }
    setBusy(false);
    onDone(data.xp || 0, photos.length);
  };

  return (
    <Sheet title={`Calificar · ${order.restaurant_name}`} onClose={onClose} footer={
      <Btn onClick={send} disabled={busy}>
        {busy ? <Spinner size={16} color={T.btnPrimaryText} /> : <Icon name="check" size={16} />}
        Publicar reseña
      </Btn>
    }>
      <div style={{ textAlign: 'center', marginBottom: 22 }}>
        <SectionLabel>Tu calificación general</SectionLabel>
        <Stars value={stars} size={34} gap={7} onPick={setStars} />
      </div>

      <div style={{ background: T.softBg, border: `1px solid ${T.softBorder}`, borderRadius: 12,
                    padding: '11px 13px', marginBottom: 20, display: 'flex', gap: 9 }}>
        <Icon name="award" size={16} color={T.mid} />
        <div style={{ fontSize: 11.5, color: T.mid, lineHeight: 1.6 }}>
          Cuanto más completa sea tu reseña, más experiencia ganás.
          Llevás <b style={{ color: T.ink }}>{answered} de {shown.length}</b> aspectos calificados.
        </div>
      </div>

      <SectionLabel>Aspecto por aspecto</SectionLabel>
      {!dims ? <Loading /> : shown.map(d => (
        <div key={d.code} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                   padding: '10px 0', borderBottom: `1px solid ${T.border}`, gap: 10 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: T.ink }}>
              {d.emoji ? d.emoji + ' ' : ''}{d.label}
            </div>
            {d.description && <div style={{ fontSize: 11, color: T.silver, marginTop: 1 }}>{d.description}</div>}
          </div>
          <Stars value={scores[d.code] || 0} size={17}
                 onPick={n => setScores(s => ({ ...s, [d.code]: n }))} />
        </div>
      ))}

      <div style={{ marginTop: 20 }}>
        <SectionLabel>Contá tu experiencia{minChars > 0 ? ` (mínimo ${minChars})` : ' (opcional)'}</SectionLabel>
        <textarea value={comment} onChange={e => setComment(e.target.value)} rows={4}
          placeholder="¿Qué pediste? ¿Cómo estuvo? ¿Lo recomendarías?"
          style={{ width: '100%', background: T.white, border: `1px solid ${T.border}`,
                   borderRadius: 12, padding: 13, fontSize: 13.5, color: T.ink,
                   fontFamily: FONT, outline: 'none', resize: 'vertical', lineHeight: 1.6 }} />
      </div>

      {boot?.modules?.photos && (
        <div style={{ marginTop: 18 }}>
          <SectionLabel>Fotos (suman XP al aprobarse)</SectionLabel>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {photos.map((f, i) => (
              <div key={i} style={{ position: 'relative', width: 68, height: 68 }}>
                <img src={URL.createObjectURL(f)} alt="" style={{ width: '100%', height: '100%',
                     objectFit: 'cover', borderRadius: 10 }} />
                <button onClick={() => setPhotos(p => p.filter((_, j) => j !== i))}
                  style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20,
                           borderRadius: '50%', background: T.black, color: '#FFF', border: 'none',
                           cursor: 'pointer', display: 'flex', alignItems: 'center',
                           justifyContent: 'center', fontSize: 11 }}>×</button>
              </div>
            ))}
            {photos.length < (boot?.review_max_photos || 4) && (
              <button onClick={() => fileRef.current && fileRef.current.click()}
                style={{ width: 68, height: 68, borderRadius: 10, background: 'transparent',
                         border: `1px dashed ${T.border}`, cursor: 'pointer', display: 'flex',
                         alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="img" size={20} color={T.silver} />
              </button>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
            onChange={e => {
              const max = boot?.review_max_photos || 4;
              setPhotos(p => p.concat(Array.from(e.target.files || [])).slice(0, max));
              e.target.value = '';
            }} />
          <div style={{ fontSize: 11, color: T.silver, marginTop: 8, lineHeight: 1.6 }}>
            Las fotos pasan por moderación antes de mostrarse.
          </div>
        </div>
      )}
    </Sheet>
  );
}

/* ══ PANTALLA: RANKING ═══════════════════════════════════════════ */
function RankingScreen({ me }) {
  const T = useT();
  const [scope, setScope]   = useState('country');
  const [period, setPeriod] = useState('all');
  const [data, setData]     = useState(null);
  const [loading, setLoad]  = useState(true);

  useEffect(() => {
    let alive = true;
    setLoad(true);
    (async () => {
      const { data } = await API.leaderboard(scope, period);
      if (alive) { setData(data); setLoad(false); }
    })();
    return () => { alive = false; };
  }, [scope, period]);

  if (data && data.enabled === false) return (
    <div style={{ flex: 1, background: T.offwhite }}>
      <Empty icon="trophy" title="El ranking está apagado"
             text="Lo prende el equipo de Mythos desde el panel de superadmin." />
    </div>
  );

  const rows = data?.rows || [];

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: T.offwhite }}>
      <div style={{ padding: '14px 18px 10px', display: 'flex', gap: 7, overflowX: 'auto' }}>
        <Pill active={scope === 'country'} onClick={() => setScope('country')}>Paraguay</Pill>
        <Pill active={scope === 'city'}    onClick={() => setScope('city')}>Mi ciudad</Pill>
        <div style={{ width: 1, background: T.border, margin: '4px 3px', flexShrink: 0 }} />
        <Pill active={period === 'all'}   onClick={() => setPeriod('all')}>Histórico</Pill>
        <Pill active={period === 'month'} onClick={() => setPeriod('month')}>Este mes</Pill>
      </div>

      {data?.me && (
        <div style={{ padding: '4px 18px 12px' }}>
          <Card style={{ background: T.ink, border: 'none', display: 'flex',
                         alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 800, color: 'rgba(255,255,255,.55)',
                            letterSpacing: '.15em', textTransform: 'uppercase' }}>Tu puesto</div>
              <div style={{ fontFamily: T.F.h, fontSize: 28, color: '#FFF', marginTop: 3 }}>
                #{data.me.position}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: '#FFF' }}>{num(data.me.xp)} XP</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,.55)' }}>
                de {num(data.total || 0)} exploradores
              </div>
            </div>
          </Card>
        </div>
      )}

      {loading ? <Loading /> : rows.length === 0 ? (
        <Empty icon="trophy" title="Todavía no hay ranking"
               text="Apenas empiecen a acumularse pedidos y reseñas, esta tabla se llena sola." />
      ) : (
        <div style={{ padding: '0 18px 20px' }}>
          {rows.map(r => (
            <div key={r.diner_id} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '11px 12px',
              borderRadius: 12, marginBottom: 4,
              background: r.is_me ? T.softBg : 'transparent',
              border: `1px solid ${r.is_me ? T.softBorder : 'transparent'}` }}>
              <div style={{ width: 30, textAlign: 'center', flexShrink: 0 }}>
                {r.position <= 3
                  ? <span style={{ fontSize: 17 }}>{['🥇', '🥈', '🥉'][r.position - 1]}</span>
                  : <span style={{ fontSize: 13, fontWeight: 800, color: T.silver }}>{r.position}</span>}
              </div>
              <div style={{ width: 34, height: 34, borderRadius: '50%', background: T.softBg,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            overflow: 'hidden', flexShrink: 0 }}>
                {r.avatar
                  ? <img src={r.avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <span style={{ fontSize: 13, fontWeight: 800, color: T.mid }}>{(r.name || '?')[0].toUpperCase()}</span>}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: r.is_me ? 800 : 600, color: T.ink,
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.name}{r.is_me ? ' · vos' : ''}
                </div>
                <div style={{ fontSize: 11, color: T.silver }}>
                  Nivel {r.level} · {r.level_name}{r.reviews ? ` · ${r.reviews} reseñas` : ''}
                </div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 800, color: T.ink, flexShrink: 0 }}>{num(r.xp)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ══ PANTALLA: PERFIL ════════════════════════════════════════════ */
function ProfileScreen({ onFlash, onOut, onCounterCode, reload }) {
  const T = useT();
  const [p, setP] = useState(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    await API.refreshAchievements();               // recalcula insignias y retos
    const { data, missing } = await API.profile();
    setMissing(missing); setP(data);
  }, []);
  useEffect(() => { load(); }, [load, reload]);

  if (missing) return <MissingMigration what="tu perfil" />;
  if (!p || !p.ok) return <Loading />;

  const s = p.stats || {};
  const earned = (p.badges || []).filter(b => b.earned);
  const locked = (p.badges || []).filter(b => !b.earned);

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: T.offwhite, padding: '14px 18px 24px' }}>
      {/* Identidad */}
      <div style={{ textAlign: 'center', marginBottom: 22 }}>
        <div style={{ width: 78, height: 78, borderRadius: '50%', background: T.softBg,
                      margin: '0 auto 12px', display: 'flex', alignItems: 'center',
                      justifyContent: 'center', overflow: 'hidden', border: `1px solid ${T.border}` }}>
          {p.diner.avatar_url
            ? <img src={p.diner.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <span style={{ fontSize: 28, fontWeight: 800, color: T.mid }}>
                {(p.diner.display_name || '?')[0].toUpperCase()}</span>}
        </div>
        <div style={{ fontFamily: T.F.h, fontSize: 26, color: T.ink }}>{p.diner.display_name || 'Comensal'}</div>
        <div style={{ fontSize: 11, fontWeight: 800, color: T.gray, letterSpacing: '.16em',
                      textTransform: 'uppercase', marginTop: 5 }}>
          {p.level_name} · Nivel {p.level}
        </div>
        <div style={{ marginTop: 8 }}><Stars value={Math.min(5, Math.ceil(p.level / 6))} size={15} /></div>
        <div style={{ fontSize: 11.5, color: T.silver, marginTop: 7 }}>
          Miembro desde {p.diner.member_since}{p.diner.city ? ` · ${p.diner.city}` : ''}
        </div>
      </div>

      {/* Progreso */}
      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 9 }}>
          <span style={{ fontSize: 12.5, color: T.mid }}>{num(p.xp)} XP</span>
          <span style={{ fontSize: 12.5, color: T.silver }}>
            {p.next_level_xp ? `${num(p.next_level_xp)} para el nivel ${p.level + 1}` : 'Nivel máximo'}
          </span>
        </div>
        <XpBar xp={p.xp} min={p.level_min_xp} next={p.next_level_xp} height={7} />
      </Card>

      {/* Ranking */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <Stat label="Top Paraguay" value={'#' + (p.rank?.country ?? '—')} />
        <Stat label={p.rank?.city_name ? 'Top ' + p.rank.city_name : 'Top ciudad'}
              value={p.rank?.city ? '#' + p.rank.city : '—'} />
      </div>

      {/* Credibilidad — la reputación que hace que la crítica pese */}
      <Card style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Icon name="shield" size={15} color={T.ink} />
            <span style={{ fontSize: 13, fontWeight: 700, color: T.ink }}>Índice de credibilidad</span>
          </div>
          <span style={{ fontSize: 17, fontWeight: 800, color: T.ink }}>{p.credibility}%</span>
        </div>
        <XpBar xp={p.credibility} min={0} next={100} />
        <div style={{ fontSize: 11.5, color: T.gray, lineHeight: 1.65, marginTop: 10 }}>
          Se construye con pedidos verificados, variedad de restaurantes, votos útiles,
          fotos aprobadas y constancia. Tu reseña pesa <b style={{ color: T.ink }}>×{p.review_weight}</b> en
          la nota de los locales.
        </div>
      </Card>

      {/* Estadísticas */}
      <SectionLabel>Tu recorrido</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 }}>
        <Stat label="Pedidos"     value={num(s.orders)} />
        <Stat label="Restaurantes"value={num(s.restaurants)} />
        <Stat label="Reseñas"     value={num(s.reviews)} />
        <Stat label="Fotos"       value={num(s.photos)} />
        <Stat label="Votos útiles"value={num(s.helpful)} />
        <Stat label="Gastado"     value={fmt(s.spent)} small />
      </div>

      {(s.top_restaurant || s.top_type || s.top_city || s.top_hour) && (
        <>
          <SectionLabel>Tus costumbres</SectionLabel>
          <Card style={{ marginBottom: 18, padding: 0 }}>
            {[['Restaurante favorito', s.top_restaurant],
              ['Comida preferida',     s.top_type],
              ['Ciudad más visitada',  s.top_city],
              ['Horario habitual',     s.top_hour]]
              .filter(([, v]) => v).map(([k, v], i, arr) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between',
                                    padding: '12px 16px',
                                    borderBottom: i < arr.length - 1 ? `1px solid ${T.border}` : 'none' }}>
                <span style={{ fontSize: 12.5, color: T.gray }}>{k}</span>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: T.ink,
                               textTransform: 'capitalize' }}>{v}</span>
              </div>
            ))}
          </Card>
        </>
      )}

      {/* Insignias */}
      {(p.badges || []).length > 0 && (
        <>
          <SectionLabel>Insignias · {earned.length} de {p.badges.length}</SectionLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9, marginBottom: 18 }}>
            {earned.concat(locked).map(b => (
              <div key={b.code} title={b.description} style={{
                width: 'calc(25% - 7px)', aspectRatio: '1', borderRadius: 14,
                background: b.earned ? T.white : 'transparent',
                border: `1px solid ${b.earned ? T.border : T.border}`,
                opacity: b.earned ? 1 : 0.32, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: 3, padding: 4 }}>
                <span style={{ fontSize: 21, filter: b.earned ? 'none' : 'grayscale(1)' }}>{b.emoji}</span>
                <span style={{ fontSize: 8.5, fontWeight: 700, color: T.mid, textAlign: 'center',
                               lineHeight: 1.2 }}>{b.name}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Colecciones */}
      {(p.collections || []).length > 0 && (
        <>
          <SectionLabel>Colecciones</SectionLabel>
          {p.collections.map(c => (
            <Card key={c.code} style={{ marginBottom: 9 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 9 }}>
                <span style={{ fontSize: 20 }}>{c.emoji}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: T.ink }}>{c.name}</div>
                  <div style={{ fontSize: 11, color: T.silver }}>{c.description}</div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 800, color: T.ink }}>
                  {c.done}<span style={{ color: T.silver, fontWeight: 600 }}> / {c.total}</span>
                </div>
              </div>
              <XpBar xp={c.done} min={0} next={Math.max(c.total, 1)} />
            </Card>
          ))}
          <div style={{ height: 9 }} />
        </>
      )}

      {/* Retos */}
      {(p.challenges || []).length > 0 && (
        <>
          <SectionLabel>Retos activos</SectionLabel>
          {p.challenges.map(c => (
            <Card key={c.code} style={{ marginBottom: 9, display: 'flex', alignItems: 'center', gap: 11 }}>
              <span style={{ fontSize: 21 }}>{c.emoji}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: T.ink }}>{c.name}</div>
                <div style={{ fontSize: 11.5, color: T.gray, marginTop: 1 }}>{c.description}</div>
              </div>
              {c.claimed
                ? <span style={{ fontSize: 11, fontWeight: 800, color: T.good }}>✓ Logrado</span>
                : <span style={{ fontSize: 11, fontWeight: 800, color: T.ink,
                                 background: T.softBg, borderRadius: 6, padding: '3px 8px' }}>
                    +{num(c.reward_xp)} XP</span>}
            </Card>
          ))}
          <div style={{ height: 9 }} />
        </>
      )}

      {/* Vincular historial viejo */}
      <SectionLabel>Historial anterior a la app</SectionLabel>
      <Card style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12.5, color: T.gray, lineHeight: 1.7, marginBottom: 12 }}>
          Si ya comías en un restaurante Mythos antes de tener cuenta, ese local tiene
          tu ficha con todo lo que fuiste juntando. Pedí un código, dictáselo en el
          mostrador y todo eso pasa a tu perfil.
        </div>
        <Btn variant="ghost" onClick={onCounterCode}>
          <Icon name="key" size={15} /> Pedir mi código
        </Btn>
      </Card>

      <Btn variant="ghost" onClick={onOut} style={{ marginTop: 6 }}>
        <Icon name="logout" size={15} /> Cerrar sesión
      </Btn>

      <div style={{ fontSize: 10.5, color: T.silver, textAlign: 'center', marginTop: 18, lineHeight: 1.7 }}>
        {p.diner.email}
      </div>
    </div>
  );
}

function Stat({ label, value, small }) {
  const T = useT();
  return (
    <div style={{ flex: 1, background: T.white, border: `1px solid ${T.border}`,
                  borderRadius: 14, padding: '13px 14px' }}>
      <div style={{ fontSize: small ? 14 : 19, fontWeight: 800, color: T.ink,
                    letterSpacing: '-0.02em' }}>{value}</div>
      <div style={{ fontSize: 10.5, color: T.gray, marginTop: 3, fontWeight: 600 }}>{label}</div>
    </div>
  );
}

/* ══ HOJAS AUXILIARES ════════════════════════════════════════════ */
function CartsSheet({ carts, restaurants, onClose }) {
  const T = useT();
  const byId = {};
  (restaurants || []).forEach(r => { byId[r.id] = r; });
  return (
    <Sheet title="Carritos abiertos" onClose={onClose}>
      {carts.length === 0 ? (
        <Empty icon="cart" title="No tenés nada en el carrito"
               text="Cuando agregues platos en la carta de un restaurante, el carrito queda guardado y aparece acá." />
      ) : (
        <>
          <div style={{ fontSize: 12.5, color: T.gray, lineHeight: 1.7, marginBottom: 16 }}>
            El pedido se termina en la carta de cada restaurante. Tocá uno para volver
            justo donde lo dejaste.
          </div>
          {carts.map(c => {
            const r = byId[c.restaurant_id];
            return (
              <div key={c.restaurant_id}
                onClick={() => { window.location.href = API.orderUrl(c.restaurant_id, 'dine_in'); }}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 0',
                         borderBottom: `1px solid ${T.border}`, cursor: 'pointer' }}>
                <Icon name="cart" size={19} color={T.ink} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: T.ink }}>
                    {r ? r.name : 'Restaurante'}
                  </div>
                  <div style={{ fontSize: 11.5, color: T.silver }}>
                    {c.count} ítem{c.count !== 1 ? 's' : ''} · {fmt(c.total)}
                  </div>
                </div>
                <Icon name="chevron" size={16} color={T.silver} />
              </div>
            );
          })}
        </>
      )}
    </Sheet>
  );
}

function NotifSheet({ orders, onClose, onRate }) {
  const T = useT();
  const live = (orders || []).filter(o =>
    o.status !== 'delivered' && o.rider_status !== 'delivered' && o.status !== 'cancelled');
  const pend = (orders || []).filter(o =>
    (o.status === 'delivered' || o.rider_status === 'delivered') && !o.reviewed);

  return (
    <Sheet title="Notificaciones" onClose={onClose}>
      {live.length === 0 && pend.length === 0 && (
        <Empty icon="bell" title="Nada nuevo"
               text="Acá te avisamos cuando un pedido cambia de estado y cuando podés calificar." />
      )}
      {live.length > 0 && (
        <>
          <SectionLabel>Pedidos en curso</SectionLabel>
          {live.map(o => (
            <div key={o.id} style={{ padding: '11px 0', borderBottom: `1px solid ${T.border}` }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: T.ink }}>{o.restaurant_name}</div>
              <div style={{ fontSize: 12, color: T.warn, marginTop: 3, fontWeight: 600 }}>
                {o.delivery_order_id
                  ? (RIDER_LABEL[o.rider_status] || STATUS_LABEL[o.status])
                  : (STATUS_LABEL[o.status] || o.status)}
              </div>
            </div>
          ))}
          <div style={{ height: 18 }} />
        </>
      )}
      {pend.length > 0 && (
        <>
          <SectionLabel>Te falta calificar</SectionLabel>
          {pend.map(o => (
            <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 10,
                                     padding: '11px 0', borderBottom: `1px solid ${T.border}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: T.ink }}>{o.restaurant_name}</div>
                <div style={{ fontSize: 11.5, color: T.silver }}>#{o.order_number}</div>
              </div>
              <Btn full={false} style={{ width: 96, height: 36, fontSize: 12.5 }}
                   onClick={() => { onClose(); onRate(o); }}>Calificar</Btn>
            </div>
          ))}
        </>
      )}
    </Sheet>
  );
}

function CodeSheet({ onClose, onFlash }) {
  const T = useT();
  const [code, setCode] = useState(null);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    (async () => {
      const { data, error } = await API.issueToken('counter');
      if (error || !data) { onFlash('No pudimos generar el código.'); onClose(); return; }
      setCode(data.token);
      setLeft(Math.max(0, Math.floor((new Date(data.expires_at) - Date.now()) / 1000)));
    })();
  }, []);

  useEffect(() => {
    if (left <= 0) return;
    const t = setInterval(() => setLeft(v => Math.max(0, v - 1)), 1000);
    return () => clearInterval(t);
  }, [left > 0]);

  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');

  return (
    <Sheet title="Tu código para el mostrador" onClose={onClose}>
      {!code ? <Loading /> : (
        <div style={{ textAlign: 'center', padding: '8px 0 4px' }}>
          <div style={{ fontFamily: T.F.h, fontSize: 46, letterSpacing: '0.16em',
                        color: T.ink, marginBottom: 10 }}>{code}</div>
          <div style={{ fontSize: 12.5, color: left > 0 ? T.gray : T.bad, marginBottom: 22 }}>
            {left > 0 ? `Vence en ${mm}:${ss}` : 'El código venció. Cerrá y pedí otro.'}
          </div>
          <div style={{ fontSize: 13, color: T.mid, lineHeight: 1.75, textAlign: 'left',
                        background: T.softBg, border: `1px solid ${T.softBorder}`,
                        borderRadius: 12, padding: 15 }}>
            Dictáselo al cajero del restaurante donde ya eras cliente. Él lo carga en
            Caja y tu ficha de ese local —con todo el historial y la experiencia que
            venías juntando— queda unida a este perfil.
            <br /><br />
            <b style={{ color: T.ink }}>Por qué en persona:</b> el cajero te está viendo,
            y eso vale más que un mensaje al teléfono. Además nadie puede reclamar tu
            historial a distancia.
          </div>
        </div>
      )}
    </Sheet>
  );
}

/* ══ AUXILIARES ══════════════════════════════════════════════════ */
function Loading() {
  const T = useT();
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: '56px 0', gap: 11 }}>
      <Spinner />
      <span style={{ fontSize: 13, color: T.gray }}>Cargando…</span>
    </div>
  );
}

// La migración 200 puede no estar aplicada todavía: el panel lo dice claro en
// vez de mostrar una pantalla rota. Mismo criterio deploy-safe que la mig 199.
function MissingMigration({ what }) {
  const T = useT();
  return (
    <div style={{ flex: 1, background: T.offwhite }}>
      <Empty icon="alert" title="Falta un paso en el servidor"
             text={`No pudimos cargar ${what}. Falta aplicar la migración 200 en Supabase.`} />
    </div>
  );
}

/* ══ APP ═════════════════════════════════════════════════════════ */
function App() {
  const [mood, setMood]     = useState(() => {
    try { return localStorage.getItem('mythos_clientes_mood') || 'blanco'; } catch (_) { return 'blanco'; }
  });
  const T = useMemo(() => makeTheme(mood), [mood]);

  const [boot, setBoot]     = useState(undefined);   // undefined = cargando
  const [tab, setTab]       = useState('home');
  const [flash, setFlash]   = useState('');
  const [sheet, setSheet]   = useState(null);        // {kind, payload}
  const [orders, setOrders] = useState([]);
  const [carts, setCarts]   = useState([]);
  const [rests, setRests]   = useState([]);
  const [bump, setBump]     = useState(0);           // fuerza recarga del perfil

  useEffect(() => { try { localStorage.setItem('mythos_clientes_mood', mood); } catch (_) {} }, [mood]);

  /* ── Arranque ── */
  const load = useCallback(async () => {
    const { data, missing } = await API.bootstrap();
    if (missing) { setBoot({ missing: true }); return; }
    setBoot(data || { signed_in: false });

    if (data?.signed_in && data?.allowed) {
      // Perfil: si el correo está habilitado pero todavía no hay fila en
      // `diners`, se crea acá (el portero real está en la base).
      if (!data.diner) {
        const { error } = await API.ensureDiner(
          data.email ? data.email.split('@')[0] : null, null);
        if (!error) { const { data: d2 } = await API.bootstrap(); setBoot(d2); }
        return;
      }
      // Token de dispositivo: es lo que permite que un pedido hecho en el QR
      // o en delivery se reconozca como tuyo (Camino A). Se renueva si falta.
      if (!API.getDeviceToken()) {
        const { data: tk } = await API.issueToken('device');
        if (tk?.token) API.setDeviceToken(tk.token);
      }
      const { data: os } = await API.myOrders();
      setOrders(Array.isArray(os) ? os : []);
      setCarts(API.openCarts());
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Refresca los pedidos al volver a la pestaña (el estado cambia en cocina,
  // no acá). Realtime queda para cuando el panel salga de la beta.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      setCarts(API.openCarts());
      API.myOrders().then(({ data }) => { if (Array.isArray(data)) setOrders(data); });
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const doOut = async () => { await API.signOut(); window.location.reload(); };

  const notifCount = orders.filter(o =>
    (o.status !== 'delivered' && o.rider_status !== 'delivered' && o.status !== 'cancelled')
    || ((o.status === 'delivered' || o.rider_status === 'delivered') && !o.reviewed)).length;

  /* ── Estados de arranque ── */
  let body = null;

  if (boot === undefined) {
    body = <div style={{ height: '100%', display: 'flex', alignItems: 'center',
                         justifyContent: 'center', background: T.offwhite }}><Loading /></div>;

  } else if (boot.missing) {
    body = <div style={{ height: '100%', background: T.offwhite, display: 'flex',
                         alignItems: 'center' }}>
      <Empty icon="alert" title="La app todavía no está disponible"
             text="Falta aplicar la migración 200 en Supabase. Una vez aplicada, esta pantalla desaparece sola." />
    </div>;

  } else if (!API.db) {
    body = <div style={{ height: '100%', background: T.offwhite, display: 'flex', alignItems: 'center' }}>
      <Empty icon="alert" title="Sin conexión con el servidor"
             text="No pudimos cargar la configuración. Revisá tu conexión y recargá." />
    </div>;

  } else if (!boot.signed_in) {
    body = <LoginScreen onFlash={setFlash} />;

  } else if (!boot.allowed) {
    body = <ClosedScreen email={boot.email} message={boot.closed_message} onOut={doOut} />;

  } else if (!boot.diner) {
    body = <div style={{ height: '100%', display: 'flex', alignItems: 'center',
                         justifyContent: 'center', background: T.offwhite }}><Loading /></div>;

  } else if (!boot.diner.onboarded) {
    body = <OnboardingScreen boot={boot} onFlash={setFlash} onDone={(xp) => {
      setFlash(xp > 0 ? `Listo · +${xp} XP` : 'Listo');
      load();
    }} />;

  } else {
    const me = boot.diner;
    body = (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: T.offwhite }}>
        <TopBar me={me} carts={carts} notifCount={notifCount}
          dark={mood === 'negro'} onTheme={() => setMood(m => m === 'negro' ? 'blanco' : 'negro')}
          onCart={() => setSheet({ kind: 'carts' })}
          onNotif={() => setSheet({ kind: 'notif' })} />

        {tab === 'home'    && <HomeScreen me={me} onFlash={setFlash}
                                onOpen={(r, svc) => { setRests(rs => rs.some(x => x.id === r.id) ? rs : rs.concat(r));
                                                      setSheet({ kind: 'rest', r, service: svc }); }} />}
        {tab === 'orders'  && <OrdersScreen onFlash={setFlash}
                                onRate={(o) => setSheet({ kind: 'rate', order: o })} />}
        {tab === 'ranking' && <RankingScreen me={me} />}
        {tab === 'profile' && <ProfileScreen onFlash={setFlash} onOut={doOut} reload={bump}
                                onCounterCode={() => setSheet({ kind: 'code' })} />}

        <BottomNav tab={tab} setTab={setTab} />
      </div>
    );
  }

  return (
    <ThemeCtx.Provider value={T}>
      <div className="phone-wrap">
        <div className="phone" style={{ background: T.phoneBg }}>
          <div className="screen" style={{ background: T.offwhite }}>{body}</div>

          {sheet?.kind === 'rest' && (
            <RestaurantSheet r={sheet.r} service={sheet.service} onFlash={setFlash}
              onClose={() => setSheet(null)} onChanged={() => setBump(b => b + 1)} />
          )}
          {sheet?.kind === 'rate' && (
            <RateSheet order={sheet.order} boot={boot} onFlash={setFlash}
              onClose={() => setSheet(null)}
              onDone={(xp, nPhotos) => {
                setSheet(null);
                setFlash(`¡Gracias! +${xp} XP${nPhotos ? ` · ${nPhotos} foto${nPhotos !== 1 ? 's' : ''} en revisión` : ''}`);
                API.myOrders().then(({ data }) => { if (Array.isArray(data)) setOrders(data); });
                load(); setBump(b => b + 1);
              }} />
          )}
          {sheet?.kind === 'carts' && (
            <CartsSheet carts={carts} restaurants={rests} onClose={() => setSheet(null)} />
          )}
          {sheet?.kind === 'notif' && (
            <NotifSheet orders={orders} onClose={() => setSheet(null)}
              onRate={(o) => setSheet({ kind: 'rate', order: o })} />
          )}
          {sheet?.kind === 'code' && (
            <CodeSheet onClose={() => setSheet(null)} onFlash={setFlash} />
          )}

          {flash && <Toast msg={flash} onHide={() => setFlash('')} />}
        </div>
      </div>
    </ThemeCtx.Provider>
  );
}

createRoot(document.getElementById('app')).render(<App />);
