// ════════════════════════════════════════════════════════════════════
// MYTHOS · /riders — Red de Riders.
// ────────────────────────────────────────────────────────────────────
// Tres cosas en una URL, en este orden:
//   1. La landing pública ("Convertite en Rider Mythos") — se ve sin cuenta.
//   2. La postulación: datos, vehículo, documentos, banco y contrato.
//   3. El perfil del rider ya adentro: estado, locales de la red, documentos y
//      sus vencimientos, historial, reputación, ranking y expedientes.
//
// LO QUE ESTE PANEL **NO** HACE — la decisión de arquitectura del archivo:
// NO reparte. El menú del pedido, la ruta, el mapa y el botón "Entregar" viven
// en `/delivery-rider`, que ya sabe hacerlo y lo hace hace meses para los
// riders propios de cada local. Una segunda copia se desincroniza al primer
// cambio de estados y termina dejando pedidos colgados. Acá el rider se
// postula y se administra; a trabajar entra por el botón "Ir a trabajar".
//
// Responsive de verdad (celular Y computadora), sin marco de teléfono. El
// corte móvil es 640px y está también en public/riders.html.
// ════════════════════════════════════════════════════════════════════
import React from 'react';
import { createRoot } from 'react-dom/client';
import * as API from './api.js';

const { useState, useEffect, useCallback, useRef, useMemo } = React;

/* ══ ATERRIZAJE DE RECUPERACIÓN ══════════════════════════════════ */
// Se lee al cargar el módulo, ANTES de que supabase-js consuma el hash: con
// detectSessionInUrl:true la librería lo limpia de la URL apenas lo procesa y
// después ya no hay forma de saber que este arranque venía de "olvidé mi
// contraseña". El evento PASSWORD_RECOVERY del listener es el segundo cinturón.
// Copiado del mismo mecanismo de /clientes.
const URL_RECOVERY = (() => {
  try {
    const h = (window.location.hash || '') + ' ' + (window.location.search || '');
    return /type=recovery/.test(h);
  } catch (_) { return false; }
})();

/* ══ PALETA — blanco y negro, línea iOS ══════════════════════════ */
const T = {
  ink:    '#000000',
  body:   '#1C1C1E',
  mid:    '#6E6E73',
  soft:   '#8E8E93',
  line:   '#E5E5EA',
  hair:   '#F2F2F7',
  bg:     '#FFFFFF',
  card:   '#FFFFFF',
  sunk:   '#FAFAFA',
  ok:     '#1B7F3B',
  okBg:   '#EDF7F0',
  warn:   '#8A5A00',
  warnBg: '#FFF7E6',
  bad:    '#B3261E',
  badBg:  '#FDEDEC',
};
const FONT = "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
const R = { sm: 10, md: 14, lg: 20, pill: 9999 };

const fmtGs = n => '₲ ' + Math.round(Number(n) || 0).toLocaleString('es-PY');
const fmtDate = d => { try { return new Date(d).toLocaleDateString('es-PY', { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch (_) { return '—'; } };
const fmtDateTime = d => { try { return new Date(d).toLocaleString('es-PY', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (_) { return '—'; } };

function useIsMobile() {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 640);
  useEffect(() => {
    const on = () => setM(window.innerWidth <= 640);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return m;
}

/* ══ ICONOS ══════════════════════════════════════════════════════ */
// Del set global (mythos-icons.js) para no inventar un segundo lenguaje visual.
const Icon = ({ name, size = 16, style }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0, ...(style || {}) }}
        dangerouslySetInnerHTML={{ __html: window.MythosIcons ? window.MythosIcons.html(name, { size }) : '' }} />
);

/* ══ PRIMITIVAS ══════════════════════════════════════════════════ */
function Btn({ children, variant = 'primary', small, wide, style, ...rest }) {
  const base = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    padding: small ? '9px 16px' : '13px 22px', fontSize: small ? 13 : 15, fontWeight: 600,
    borderRadius: R.pill, cursor: rest.disabled ? 'default' : 'pointer',
    border: '1px solid transparent', transition: 'opacity .15s, background .15s',
    opacity: rest.disabled ? .45 : 1, width: wide ? '100%' : undefined,
    fontFamily: FONT, whiteSpace: 'nowrap',
  };
  const v = {
    primary:   { background: T.ink, color: '#FFF' },
    secondary: { background: '#FFF', color: T.ink, borderColor: T.line },
    ghost:     { background: 'transparent', color: T.mid, borderColor: 'transparent' },
    danger:    { background: '#FFF', color: T.bad, borderColor: '#F0C8C5' },
  }[variant] || {};
  return <button {...rest} style={{ ...base, ...v, ...(style || {}) }}>{children}</button>;
}

function Card({ children, style, pad = 20 }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: R.lg,
                  padding: pad, ...(style || {}) }}>{children}</div>
  );
}

function Pill({ children, tone = 'neutral', style }) {
  const c = {
    neutral: { bg: T.hair,   fg: T.mid },
    ok:      { bg: T.okBg,   fg: T.ok },
    warn:    { bg: T.warnBg, fg: T.warn },
    bad:     { bg: T.badBg,  fg: T.bad },
    ink:     { bg: T.ink,    fg: '#FFF' },
  }[tone] || { bg: T.hair, fg: T.mid };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 11px',
                   borderRadius: R.pill, background: c.bg, color: c.fg, fontSize: 11.5,
                   fontWeight: 700, letterSpacing: '.01em', ...(style || {}) }}>{children}</span>
  );
}

function Field({ label, hint, children, req }) {
  return (
    <label style={{ display: 'block', marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: T.soft, letterSpacing: '.06em',
                    textTransform: 'uppercase', marginBottom: 6 }}>
        {label}{req && <span style={{ color: T.bad }}> *</span>}
      </div>
      {children}
      {hint && <div style={{ fontSize: 11.5, color: T.soft, marginTop: 5, lineHeight: 1.45 }}>{hint}</div>}
    </label>
  );
}

const inputStyle = {
  width: '100%', height: 46, background: '#FFF', border: `1px solid ${T.line}`,
  borderRadius: R.md, padding: '0 14px', fontSize: 15, color: T.body,
  fontFamily: FONT, outline: 'none',
};
const Inp = props => <input {...props} style={{ ...inputStyle, ...(props.style || {}) }} />;
const Sel = props => (
  <select {...props} style={{ ...inputStyle, appearance: 'none', cursor: 'pointer',
    backgroundImage: 'linear-gradient(45deg,transparent 50%,#8E8E93 50%),linear-gradient(135deg,#8E8E93 50%,transparent 50%)',
    backgroundPosition: 'calc(100% - 18px) 20px, calc(100% - 13px) 20px',
    backgroundSize: '5px 5px, 5px 5px', backgroundRepeat: 'no-repeat',
    ...(props.style || {}) }} />
);
const Area = props => (
  <textarea {...props} style={{ ...inputStyle, height: 'auto', minHeight: 96, padding: '12px 14px',
                                lineHeight: 1.5, resize: 'vertical', ...(props.style || {}) }} />
);

function Spinner({ size = 22, style }) {
  return <div style={{ width: size, height: size, border: `2px solid ${T.line}`, borderTopColor: T.ink,
                       borderRadius: '50%', animation: 'spin .7s linear infinite', ...(style || {}) }} />;
}

function Loading({ label = 'Cargando…' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '70px 20px' }}>
      <Spinner /><div style={{ fontSize: 13.5, color: T.soft }}>{label}</div>
    </div>
  );
}

function Empty({ icon = 'package', title, sub }) {
  return (
    <div style={{ textAlign: 'center', padding: '52px 20px', color: T.soft }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12, color: T.line }}>
        <Icon name={icon} size={40} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.body }}>{title}</div>
      {sub && <div style={{ fontSize: 13.5, marginTop: 6, lineHeight: 1.55, maxWidth: 380, margin: '6px auto 0' }}>{sub}</div>}
    </div>
  );
}

function Toast({ msg, tone, onHide }) {
  useEffect(() => { const t = setTimeout(onHide, 3400); return () => clearTimeout(t); }, [msg]);
  return (
    <div style={{ position: 'fixed', left: '50%', bottom: 26, transform: 'translateX(-50%)',
                  background: tone === 'bad' ? T.bad : T.ink, color: '#FFF', borderRadius: R.pill,
                  padding: '12px 22px', fontSize: 13.5, fontWeight: 600, zIndex: 9999,
                  maxWidth: 'min(92vw,460px)', textAlign: 'center', lineHeight: 1.45,
                  boxShadow: '0 10px 40px rgba(0,0,0,.28)', animation: 'fadeIn .2s' }}>{msg}</div>
  );
}

// Cierre SÓLO con la X o con Escape — nunca con click en el fondo (regla de
// CLAUDE.md: seleccionar texto y soltar afuera perdía todo lo cargado).
function Sheet({ title, children, onClose, footer, width = 560 }) {
  useEffect(() => {
    const esc = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  const mob = useIsMobile();
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000,
                  display: 'flex', alignItems: mob ? 'flex-end' : 'center', justifyContent: 'center',
                  padding: mob ? 0 : 24 }}>
      <div style={{ background: '#FFF', width: '100%', maxWidth: width, maxHeight: mob ? '92dvh' : '86dvh',
                    borderRadius: mob ? '20px 20px 0 0' : R.lg, display: 'flex', flexDirection: 'column',
                    animation: mob ? 'slideUp .26s ease' : 'fadeIn .18s' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '17px 20px 14px', borderBottom: `1px solid ${T.line}`, flexShrink: 0 }}>
          <div style={{ fontSize: 16.5, fontWeight: 800, color: T.ink }}>{title}</div>
          <button onClick={onClose} aria-label="Cerrar"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, lineHeight: 0 }}>
            <Icon name="x" size={19} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>{children}</div>
        {footer && <div style={{ padding: 16, borderTop: `1px solid ${T.line}`, flexShrink: 0 }}>{footer}</div>}
      </div>
    </div>
  );
}

/* ══ ESTADOS DEL RIDER ═══════════════════════════════════════════ */
const STATUS = {
  borrador:   { label: 'Borrador',     tone: 'neutral', desc: 'Todavía no enviaste tu solicitud.' },
  pendiente:  { label: 'En revisión',  tone: 'warn',    desc: 'Recibimos tu postulación. Te avisamos apenas la revisemos.' },
  observado:  { label: 'Con observaciones', tone: 'warn', desc: 'Necesitamos que corrijas algo antes de aprobarte.' },
  rechazado:  { label: 'No aprobada',  tone: 'bad',     desc: 'Tu solicitud no fue aprobada.' },
  aprobado:   { label: 'Aprobado',     tone: 'ok',      desc: 'Te falta completar la capacitación para empezar.' },
  activo:     { label: 'Activo',       tone: 'ok',      desc: 'Podés recibir pedidos.' },
  suspendido: { label: 'Suspendido',   tone: 'bad',     desc: 'Tu cuenta está suspendida.' },
  bloqueado:  { label: 'Bloqueado',    tone: 'bad',     desc: 'Tu cuenta fue bloqueada.' },
  baja:       { label: 'Dado de baja', tone: 'neutral', desc: 'Tu cuenta está dada de baja.' },
};
const AVAIL = {
  disponible:   { label: 'Disponible',   tone: 'ok' },
  ocupado:      { label: 'Ocupado',      tone: 'warn' },
  pausado:      { label: 'Pausado',      tone: 'neutral' },
  desconectado: { label: 'Desconectado', tone: 'neutral' },
};
const VEHICLES = [
  { v: 'moto', label: 'Moto' },
  { v: 'bici', label: 'Bicicleta' },
  { v: 'auto', label: 'Automóvil' },
  { v: 'otro', label: 'Otro' },
];

/* ══ COPY POR DEFECTO DE LA LANDING ══════════════════════════════ */
// Vive en el front a propósito, igual que EXP_COPY y FORM_SPECS: reescribir
// una frase no puede exigir una migración. Lo que el superadmin cargue en
// `site_texts` (mig 206) pisa cada clave; lo que deje vacío cae acá.
const COPY = {
  hero_title: 'Convertite en Rider Mythos',
  hero_sub:   'Trabajá cuando quieras, con tu propio vehículo, para los restaurantes de la red.',
  cta:        'Quiero ser Rider',
  benefits: [
    { icon: 'clock',  t: 'Trabajá cuando quieras',   d: 'Vos elegís los días y las horas. No hay turnos asignados.' },
    { icon: 'check',  t: 'Sin horarios obligatorios', d: 'Te conectás y te desconectás cuando te conviene.' },
    { icon: 'pin',    t: 'Pedidos cercanos',          d: 'Te ofrecemos los pedidos que están cerca tuyo.' },
    { icon: 'bike',   t: 'Tu moto, bici o auto',      d: 'Trabajás con el vehículo que ya tenés.' },
    { icon: 'store',  t: 'Varios restaurantes',       d: 'Un solo perfil para todos los locales de la red.' },
    { icon: 'money',  t: 'Te paga el restaurante',    d: 'El pago del delivery lo hace el local directamente a vos.' },
  ],
  steps: [
    { t: 'Creás tu cuenta',      d: 'Con tu correo y una contraseña.' },
    { t: 'Completás tus datos',  d: 'Datos personales, vehículo y cuenta bancaria.' },
    { t: 'Subís tus documentos', d: 'Cédula, licencia y lo que corresponda a tu vehículo.' },
    { t: 'Revisamos tu solicitud', d: 'Si falta algo te lo decimos: no empezás de cero.' },
    { t: 'Empezás a recibir pedidos', d: 'Te sumás a los locales que quieras y te conectás.' },
  ],
  faq: [
    { q: '¿Tengo que cumplir un horario?', a: 'No. Te conectás cuando querés y te desconectás cuando querés. No hay turnos ni mínimo de entregas.' },
    { q: '¿Quién me paga?', a: 'El restaurante, directamente a vos, con los términos que publica en la plataforma. Mythos no administra el dinero del pedido ni cobra comisión sobre lo que ganás.' },
    { q: '¿Puedo trabajar para varios restaurantes?', a: 'Sí. Ese es el punto de la red: un solo perfil, un solo documento cargado, y te sumás a los locales que quieras.' },
    { q: '¿Qué necesito para empezar?', a: 'Cédula vigente, tu vehículo, y la licencia y documentación que corresponda si manejás moto o auto. Todo se sube desde el celular.' },
    { q: '¿Qué pasa si se me vence un documento?', a: 'Te avisamos antes de que venza. Si vence, tu cuenta queda suspendida hasta que subas el documento actualizado: no es una sanción, es una habilitación que caducó.' },
    { q: '¿Mythos me contrata?', a: 'No. Sos un prestador independiente que usa la plataforma para conectarse con restaurantes. Está escrito en los términos que aceptás al postularte.' },
  ],
};
function copyOf(site, key) {
  const v = site && site[key];
  return (typeof v === 'string' && v.trim()) ? v : COPY[key];
}

/* ══ HEADER ══════════════════════════════════════════════════════ */
function Header({ session, rider, onAccount, onSignOut, unread }) {
  const mob = useIsMobile();
  const [open, setOpen] = useState(false);
  const links = [
    { href: '#beneficios', label: 'Beneficios' },
    { href: '#como',       label: 'Cómo funciona' },
    { href: '#requisitos', label: 'Requisitos' },
    { href: '#faq',        label: 'Preguntas' },
  ];
  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 500, background: 'rgba(255,255,255,.92)',
                     backdropFilter: 'saturate(180%) blur(18px)', borderBottom: `1px solid ${T.line}` }}>
      <div className="wrap" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                     height: 62, gap: 16 }}>
        <a href="/inicio" style={{ display: 'flex', alignItems: 'center', gap: 9, textDecoration: 'none' }}>
          <span style={{ fontSize: 17, fontWeight: 800, color: T.ink, letterSpacing: '-.02em' }}>MYTHOS</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: T.mid, background: T.hair,
                         padding: '3px 8px', borderRadius: R.pill }}>RIDERS</span>
        </a>

        {!mob && !session && (
          <nav style={{ display: 'flex', gap: 24 }}>
            {links.map(l => (
              <a key={l.href} href={l.href}
                 style={{ fontSize: 13.5, color: T.mid, textDecoration: 'none', fontWeight: 500 }}>{l.label}</a>
            ))}
          </nav>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {session ? (
            <>
              {rider?.status === 'activo' && (
                <a href="/delivery-rider" style={{ textDecoration: 'none' }}>
                  <Btn small><Icon name="bike" size={14} /> Ir a trabajar</Btn>
                </a>
              )}
              <button onClick={() => setOpen(o => !o)}
                      style={{ background: 'none', border: `1px solid ${T.line}`, borderRadius: R.pill,
                               padding: '6px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center',
                               gap: 7, fontSize: 13, color: T.body, fontWeight: 600, position: 'relative' }}>
                <Icon name="user" size={14} />
                {!mob && (rider?.first_name || 'Mi cuenta')}
                {unread > 0 && <span style={{ position: 'absolute', top: -3, right: -3, width: 9, height: 9,
                                              borderRadius: '50%', background: T.bad }} />}
              </button>
            </>
          ) : (
            <Btn small variant="secondary" onClick={onAccount}>Entrar</Btn>
          )}

          {mob && !session && (
            <button onClick={() => setOpen(o => !o)} aria-label="Menú"
                    style={{ background: 'none', border: `1px solid ${T.line}`, borderRadius: R.sm,
                             padding: '7px 9px', cursor: 'pointer', lineHeight: 0 }}>
              <Icon name="menu" size={16} />
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="wrap" style={{ paddingBottom: 14, borderTop: `1px solid ${T.hair}`, paddingTop: 12 }}>
          {!session && links.map(l => (
            <a key={l.href} href={l.href} onClick={() => setOpen(false)}
               style={{ display: 'block', padding: '10px 0', fontSize: 14.5, color: T.body,
                        textDecoration: 'none', fontWeight: 500 }}>{l.label}</a>
          ))}
          {session && (
            <button onClick={() => { setOpen(false); onSignOut(); }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 0',
                             fontSize: 14.5, color: T.bad, background: 'none', border: 'none',
                             cursor: 'pointer', fontWeight: 600 }}>Cerrar sesión</button>
          )}
        </div>
      )}
    </header>
  );
}

function Footer() {
  return (
    <footer style={{ borderTop: `1px solid ${T.line}`, marginTop: 60, padding: '32px 0 44px' }}>
      <div className="wrap" style={{ display: 'flex', flexWrap: 'wrap', gap: 18,
                                     justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 12.5, color: T.soft }}>
          © {new Date().getFullYear()} Mythos · Asunción, Paraguay
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {[['/terminos-riders', 'Términos para Riders'], ['/privacidad', 'Privacidad'],
            ['/inicio', 'Mythos para restaurantes']].map(([h, l]) => (
            <a key={h} href={h} style={{ fontSize: 12.5, color: T.mid, textDecoration: 'none' }}>{l}</a>
          ))}
        </div>
      </div>
    </footer>
  );
}

/* ══ LANDING PÚBLICA ═════════════════════════════════════════════ */
function Landing({ cfg, onStart }) {
  const mob = useIsMobile();
  const site = cfg?.site || {};
  const open = cfg?.enabled && cfg?.registration_open;
  const [faqOpen, setFaqOpen] = useState(null);
  const hero = site.hero_image;

  return (
    <main style={{ flex: 1 }}>
      {/* Hero */}
      <section style={{ position: 'relative', overflow: 'hidden',
                        borderBottom: `1px solid ${T.line}` }}>
        {hero && (
          <div style={{ position: 'absolute', inset: 0, backgroundImage: `url(${hero})`,
                        backgroundSize: 'cover', backgroundPosition: 'center', opacity: .14 }} />
        )}
        <div className="wrap" style={{ position: 'relative', padding: mob ? '54px 16px 48px' : '96px 20px 84px',
                                       textAlign: 'center' }}>
          <Pill tone="ink" style={{ marginBottom: 20 }}>RED DE RIDERS MYTHOS</Pill>
          <h1 style={{ fontSize: mob ? 34 : 58, lineHeight: 1.06, fontWeight: 800, color: T.ink,
                       letterSpacing: '-.035em', maxWidth: 880, margin: '0 auto' }}>
            {copyOf(site, 'hero_title')}
          </h1>
          <p style={{ fontSize: mob ? 16 : 19, color: T.mid, marginTop: 18, lineHeight: 1.55,
                      maxWidth: 620, margin: '18px auto 0' }}>
            {copyOf(site, 'hero_sub')}
          </p>
          <div style={{ marginTop: 32, display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            {open
              ? <Btn onClick={onStart} style={{ padding: '15px 30px', fontSize: 16 }}>
                  {copyOf(site, 'cta')}
                </Btn>
              : <Card style={{ background: T.sunk, maxWidth: 480 }} pad={16}>
                  <div style={{ fontSize: 14, color: T.body, lineHeight: 1.55 }}>
                    {cfg?.enabled
                      ? (cfg?.closed_message || 'Las postulaciones están cerradas por ahora.')
                      : 'La Red de Riders Mythos todavía no está disponible. Muy pronto.'}
                  </div>
                </Card>}
            <Btn variant="secondary" onClick={onStart} style={{ padding: '15px 26px', fontSize: 16 }}>
              Ya soy rider
            </Btn>
          </div>
        </div>
      </section>

      {/* Beneficios */}
      <section id="beneficios" className="wrap" style={{ padding: mob ? '46px 16px' : '72px 20px' }}>
        <h2 style={{ fontSize: mob ? 24 : 32, fontWeight: 800, color: T.ink, letterSpacing: '-.025em',
                     marginBottom: 8 }}>Por qué la red</h2>
        <p style={{ fontSize: 15, color: T.mid, marginBottom: 30, maxWidth: 560, lineHeight: 1.55 }}>
          Un solo perfil para todos los restaurantes de Mythos. Cargás tus papeles una vez.
        </p>
        <div className="grid">
          {COPY.benefits.map(b => (
            <Card key={b.t}>
              <div style={{ width: 40, height: 40, borderRadius: R.md, background: T.hair,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: T.ink, marginBottom: 14 }}>
                <Icon name={b.icon} size={19} />
              </div>
              <div style={{ fontSize: 15.5, fontWeight: 700, color: T.ink, marginBottom: 6 }}>{b.t}</div>
              <div style={{ fontSize: 13.5, color: T.mid, lineHeight: 1.55 }}>{b.d}</div>
            </Card>
          ))}
        </div>
      </section>

      {/* Cómo funciona */}
      <section id="como" style={{ background: T.sunk, borderTop: `1px solid ${T.line}`,
                                  borderBottom: `1px solid ${T.line}` }}>
        <div className="wrap" style={{ padding: mob ? '46px 16px' : '72px 20px' }}>
          <h2 style={{ fontSize: mob ? 24 : 32, fontWeight: 800, color: T.ink,
                       letterSpacing: '-.025em', marginBottom: 30 }}>Cómo funciona</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {COPY.steps.map((s, i) => (
              <div key={s.t} style={{ display: 'flex', gap: 18, alignItems: 'flex-start',
                                      padding: '18px 0', borderTop: i ? `1px solid ${T.line}` : 'none' }}>
                <div style={{ width: 30, height: 30, borderRadius: '50%', background: T.ink, color: '#FFF',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: 13, fontWeight: 800, flexShrink: 0 }}>{i + 1}</div>
                <div>
                  <div style={{ fontSize: 15.5, fontWeight: 700, color: T.ink }}>{s.t}</div>
                  <div style={{ fontSize: 13.5, color: T.mid, marginTop: 3, lineHeight: 1.55 }}>{s.d}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Requisitos — sale del catálogo real de documentos, no de una lista
          escrita a mano: si el superadmin cambia lo que se exige, esto cambia. */}
      <section id="requisitos" className="wrap" style={{ padding: mob ? '46px 16px' : '72px 20px' }}>
        <h2 style={{ fontSize: mob ? 24 : 32, fontWeight: 800, color: T.ink,
                     letterSpacing: '-.025em', marginBottom: 8 }}>Qué necesitás</h2>
        <p style={{ fontSize: 15, color: T.mid, marginBottom: 30, maxWidth: 560, lineHeight: 1.55 }}>
          Ser mayor de {cfg?.min_age || 18} años y tener tu documentación al día. Todo se sube desde el celular.
        </p>
        <div className="grid">
          {(cfg?.doc_types || []).map(d => (
            <Card key={d.slug}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span style={{ color: d.required ? T.ink : T.soft, marginTop: 2 }}>
                  <Icon name={d.required ? 'check' : 'info'} size={16} />
                </span>
                <div>
                  <div style={{ fontSize: 14.5, fontWeight: 700, color: T.ink }}>
                    {d.label}{!d.required && <span style={{ color: T.soft, fontWeight: 500 }}> · opcional</span>}
                  </div>
                  {d.help && <div style={{ fontSize: 13, color: T.mid, marginTop: 4, lineHeight: 1.5 }}>{d.help}</div>}
                  {Array.isArray(d.vehicles) && d.vehicles.length > 0 && (
                    <div style={{ fontSize: 12, color: T.soft, marginTop: 5 }}>
                      Sólo para: {d.vehicles.map(v => (VEHICLES.find(x => x.v === v)?.label || v)).join(', ')}
                    </div>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" style={{ background: T.sunk, borderTop: `1px solid ${T.line}` }}>
        <div className="wrap" style={{ padding: mob ? '46px 16px' : '72px 20px', maxWidth: 820 }}>
          <h2 style={{ fontSize: mob ? 24 : 32, fontWeight: 800, color: T.ink,
                       letterSpacing: '-.025em', marginBottom: 26 }}>Preguntas frecuentes</h2>
          {COPY.faq.map((f, i) => (
            <div key={f.q} style={{ borderTop: i ? `1px solid ${T.line}` : 'none' }}>
              <button onClick={() => setFaqOpen(faqOpen === i ? null : i)}
                      style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none',
                               padding: '17px 0', cursor: 'pointer', display: 'flex',
                               justifyContent: 'space-between', gap: 16, alignItems: 'center' }}>
                <span style={{ fontSize: 15.5, fontWeight: 600, color: T.ink }}>{f.q}</span>
                <span style={{ color: T.soft, transform: faqOpen === i ? 'rotate(45deg)' : 'none',
                               transition: 'transform .18s', fontSize: 20, lineHeight: 1 }}>+</span>
              </button>
              {faqOpen === i && (
                <div style={{ fontSize: 14, color: T.mid, lineHeight: 1.65, paddingBottom: 18 }}>{f.a}</div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* CTA final */}
      <section className="wrap" style={{ padding: mob ? '48px 16px' : '76px 20px', textAlign: 'center' }}>
        <h2 style={{ fontSize: mob ? 26 : 36, fontWeight: 800, color: T.ink, letterSpacing: '-.03em' }}>
          ¿Empezamos?
        </h2>
        <p style={{ fontSize: 15, color: T.mid, marginTop: 12, marginBottom: 26 }}>
          La postulación toma unos minutos. Si falta algo, te lo decimos y lo corregís sin empezar de cero.
        </p>
        <Btn onClick={onStart} style={{ padding: '15px 32px', fontSize: 16 }}>
          {open ? copyOf(site, 'cta') : 'Entrar a mi cuenta'}
        </Btn>
      </section>
    </main>
  );
}

/* ══ ACCESO ══════════════════════════════════════════════════════ */
// El widget de Turnstile vive FUERA del árbol que React redibuja (pinta un
// iframe propio): si se desmontara en cada tecleo perdería el token.
function CaptchaBox() {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) window.MythosCaptcha?.mount(ref.current); }, []);
  return <div ref={ref} style={{ margin: '4px 0 12px', minHeight: 66 }} />;
}

function AuthScreen({ onClose, onDone, canRegister, closedMsg }) {
  const [mode, setMode] = useState(canRegister ? 'signup' : 'login');
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  async function submit(e) {
    e?.preventDefault();
    setErr(''); setOk(''); setBusy(true);
    try {
      if (mode === 'signup') {
        if (!email.trim() || pass.length < 8) throw new Error('Ingresá tu correo y una contraseña de al menos 8 caracteres.');
        const { needsConfirm } = await API.signUpWithPassword(email, pass);
        if (needsConfirm) { setOk('Te mandamos un correo para confirmar tu cuenta. Abrilo y volvé acá.'); setBusy(false); return; }
        onDone();
      } else if (mode === 'login') {
        await API.signInWithPassword(email, pass);
        onDone();
      } else {
        await API.resetPassword(email);
        setOk('Si ese correo tiene cuenta, te mandamos un enlace para recuperarla.');
      }
    } catch (e2) { setErr(API.authMsg(e2)); }
    setBusy(false);
  }

  const title = mode === 'signup' ? 'Creá tu cuenta de rider'
              : mode === 'login'  ? 'Entrá a tu cuenta'
              : 'Recuperar contraseña';

  return (
    <Sheet title={title} onClose={onClose} width={440}>
      <form onSubmit={submit}>
        {mode === 'signup' && !canRegister && (
          <div style={{ background: T.warnBg, border: `1px solid ${T.line}`, borderRadius: R.md,
                        padding: 13, fontSize: 13, color: T.warn, lineHeight: 1.5, marginBottom: 16 }}>
            {closedMsg || 'Las postulaciones están cerradas por ahora.'}
          </div>
        )}

        <Field label="Correo" req>
          <Inp type="email" value={email} autoComplete="email" inputMode="email"
               onChange={e => setEmail(e.target.value)} placeholder="tucorreo@ejemplo.com" />
        </Field>

        {mode !== 'reset' && (
          <Field label="Contraseña" req
                 hint={mode === 'signup' ? 'Mínimo 8 caracteres.' : null}>
            <Inp type="password" value={pass}
                 autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                 onChange={e => setPass(e.target.value)} placeholder="••••••••" />
          </Field>
        )}

        <CaptchaBox />

        {err && <div style={{ background: T.badBg, borderRadius: R.md, padding: 12, fontSize: 13,
                              color: T.bad, lineHeight: 1.5, marginBottom: 12 }}>{err}</div>}
        {ok  && <div style={{ background: T.okBg, borderRadius: R.md, padding: 12, fontSize: 13,
                              color: T.ok, lineHeight: 1.5, marginBottom: 12 }}>{ok}</div>}

        <Btn type="submit" wide disabled={busy}>
          {busy ? 'Un momento…' : mode === 'signup' ? 'Crear cuenta' : mode === 'login' ? 'Entrar' : 'Enviar enlace'}
        </Btn>

        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
          {mode !== 'signup' && canRegister && (
            <button type="button" onClick={() => { setMode('signup'); setErr(''); setOk(''); }}
                    style={{ background: 'none', border: 'none', color: T.mid, fontSize: 13,
                             cursor: 'pointer' }}>¿No tenés cuenta? <b style={{ color: T.ink }}>Creála</b></button>
          )}
          {mode !== 'login' && (
            <button type="button" onClick={() => { setMode('login'); setErr(''); setOk(''); }}
                    style={{ background: 'none', border: 'none', color: T.mid, fontSize: 13,
                             cursor: 'pointer' }}>Ya tengo cuenta · <b style={{ color: T.ink }}>Entrar</b></button>
          )}
          {mode === 'login' && (
            <button type="button" onClick={() => { setMode('reset'); setErr(''); setOk(''); }}
                    style={{ background: 'none', border: 'none', color: T.soft, fontSize: 12.5,
                             cursor: 'pointer' }}>Olvidé mi contraseña</button>
          )}
        </div>
      </form>
    </Sheet>
  );
}

/* ══ SUBIDA DE UN DOCUMENTO ══════════════════════════════════════ */
// El archivo va al bucket PRIVADO y después se asienta con la RPC. Si la
// subida sale bien pero el asiento falla, se avisa: el archivo quedaría
// huérfano en el storage y el rider creería que ya lo cargó.
function DocRow({ doc, onUploaded, toast }) {
  const [busy, setBusy] = useState(false);
  const [exp, setExp] = useState(doc.expires_at || '');
  const fileRef = useRef(null);
  const st = doc.status || 'faltante';

  const tone = st === 'aprobado' ? 'ok'
             : st === 'rechazado' || st === 'vencido' ? 'bad'
             : st === 'pendiente' ? 'warn' : 'neutral';
  const label = { faltante: 'Falta subir', pendiente: 'En revisión', aprobado: 'Aprobado',
                  rechazado: 'Rechazado', vencido: 'Vencido' }[st] || st;

  async function pick(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { toast('El archivo no puede pasar de 8 MB.', 'bad'); return; }
    if (doc.has_expiry && !exp) { toast('Poné primero la fecha de vencimiento del documento.', 'bad'); return; }
    setBusy(true);
    try {
      const path = await API.uploadDoc(f, doc.slug);
      const { error } = await API.registerDocument(doc.slug, path, f.type, null, doc.has_expiry ? exp : null);
      if (error) throw error;
      toast('Documento cargado. Queda en revisión.');
      onUploaded();
    } catch (e2) {
      toast(e2?.message || 'No pudimos subir el documento.', 'bad');
    }
    setBusy(false);
  }

  const days = doc.days_left;
  const soon = typeof days === 'number' && days >= 0 && days <= 30;

  return (
    <div style={{ padding: '15px 0', borderTop: `1px solid ${T.hair}` }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14.5, fontWeight: 700, color: T.ink }}>{doc.label}</span>
            {!doc.required && <span style={{ fontSize: 12, color: T.soft }}>opcional</span>}
            <Pill tone={tone}>{label}</Pill>
          </div>
          {doc.help && <div style={{ fontSize: 12.5, color: T.soft, marginTop: 4, lineHeight: 1.45 }}>{doc.help}</div>}
          {doc.review_note && (
            <div style={{ fontSize: 12.5, color: T.bad, marginTop: 6, lineHeight: 1.45 }}>
              Observación: {doc.review_note}
            </div>
          )}
          {doc.expires_at && (
            <div style={{ fontSize: 12.5, color: soon ? T.warn : T.soft, marginTop: 5, fontWeight: soon ? 700 : 400 }}>
              Vence el {fmtDate(doc.expires_at)}
              {typeof days === 'number' && (days < 0 ? ' · vencido' : days <= 30 ? ` · en ${days} día(s)` : '')}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {doc.has_expiry && (
            <Inp type="date" value={exp} onChange={e => setExp(e.target.value)}
                 style={{ height: 40, width: 158, fontSize: 13.5 }} aria-label="Vencimiento" />
          )}
          <input ref={fileRef} type="file" accept="image/*,application/pdf" onChange={pick}
                 style={{ display: 'none' }} />
          <Btn small variant="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? 'Subiendo…' : doc.doc_id ? 'Reemplazar' : 'Subir'}
          </Btn>
        </div>
      </div>
      {doc.doc_id && doc.status === 'aprobado' && (
        <div style={{ fontSize: 12, color: T.soft, marginTop: 8, lineHeight: 1.45 }}>
          Si lo reemplazás, vuelve a revisión: un documento aprobado no se cambia sin que lo miremos de nuevo.
        </div>
      )}
    </div>
  );
}

/* ══ POSTULACIÓN — el formulario en pasos ════════════════════════ */
const STEPS = ['Vos', 'Vehículo', 'Documentos', 'Cobro', 'Términos'];

function Application({ profile, cfg, reload, toast }) {
  const mob = useIsMobile();
  const r = profile.rider || {};
  const [step, setStep] = useState(0);
  const [f, setF] = useState(() => ({
    first_name: r.first_name || '', last_name: r.last_name || '',
    birth_date: r.birth_date || '', gender: r.gender || '',
    doc_number: r.doc_number || '', nationality: r.nationality || 'Paraguaya',
    phone: r.phone || '', whatsapp: r.whatsapp || '',
    address: r.address || '', city: r.city || '', department: r.department || '',
    photo_url: r.photo_url || '', selfie_path: r.selfie_path || '',
    vehicle_type: r.vehicle_type || 'moto', vehicle_brand: r.vehicle_brand || '',
    vehicle_model: r.vehicle_model || '', vehicle_color: r.vehicle_color || '',
    vehicle_year: r.vehicle_year || '', vehicle_plate: r.vehicle_plate || '',
    vehicle_chassis: r.vehicle_chassis || '', vehicle_engine: r.vehicle_engine || '',
    bank_holder: r.bank_holder || '', bank_name: r.bank_name || '',
    bank_account: r.bank_account || '', bank_alias: r.bank_alias || '',
    bank_account_type: r.bank_account_type || 'Ahorro',
  }));
  const [saving, setSaving] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [readContract, setReadContract] = useState(false);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));

  // El paso de documentos depende del VEHÍCULO elegido, así que se guarda
  // antes de llegar ahí: si no, a quien elige moto no se le pediría licencia
  // hasta recargar la página.
  async function saveStep(next) {
    setSaving(true);
    const { error } = await API.saveDraft({ ...f, vehicle_year: f.vehicle_year || null });
    setSaving(false);
    if (error) { toast(error.message || 'No pudimos guardar.', 'bad'); return; }
    await reload();
    if (typeof next === 'number') setStep(next);
  }

  async function pickPhoto(e, which) {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    setSaving(true);
    try {
      if (which === 'photo') {
        const url = await API.uploadPhoto(file);
        set('photo_url', url);
        await API.saveDraft({ photo_url: url });
      } else {
        const path = await API.uploadDoc(file, 'selfie');
        set('selfie_path', path);
        await API.saveDraft({ selfie_path: path });
      }
      toast('Foto cargada.');
      await reload();
    } catch (e2) { toast(e2?.message || 'No pudimos subir la foto.', 'bad'); }
    setSaving(false);
  }

  async function submit() {
    if (!accepted) { toast('Tenés que aceptar los términos para enviar la solicitud.', 'bad'); return; }
    setSaving(true);
    const ip = await API.clientIp();
    const { error } = await API.submitApplication(cfg?.contract?.version, ip, navigator.userAgent);
    setSaving(false);
    if (error) { toast(error.message || 'No pudimos enviar la solicitud.', 'bad'); return; }
    toast('¡Solicitud enviada! Te avisamos apenas la revisemos.');
    reload();
  }

  const docs = profile.docs || [];
  const missingDocs = docs.filter(d => d.required && d.status === 'faltante').length;

  return (
    <main style={{ flex: 1 }}>
      <div className="wrap" style={{ maxWidth: 760, padding: mob ? '24px 16px 40px' : '38px 20px 60px' }}>
        <h1 style={{ fontSize: mob ? 26 : 34, fontWeight: 800, color: T.ink, letterSpacing: '-.03em' }}>
          Tu postulación
        </h1>
        <p style={{ fontSize: 14.5, color: T.mid, marginTop: 8, lineHeight: 1.55 }}>
          Podés guardar y seguir después. Nada se envía hasta que toques “Enviar solicitud”.
        </p>

        {/* Pasos */}
        <div style={{ display: 'flex', gap: 6, margin: '26px 0 24px', overflowX: 'auto' }}>
          {STEPS.map((s, i) => (
            <button key={s} onClick={() => saveStep(i)}
                    style={{ flex: mob ? '0 0 auto' : 1, background: i === step ? T.ink : T.hair,
                             color: i === step ? '#FFF' : T.mid, border: 'none', borderRadius: R.pill,
                             padding: '9px 15px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                             whiteSpace: 'nowrap' }}>
              {i + 1}. {s}
            </button>
          ))}
        </div>

        <Card pad={mob ? 18 : 26}>
          {/* ── 1. Datos personales ── */}
          {step === 0 && (<>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 22, flexWrap: 'wrap' }}>
              <div style={{ width: 76, height: 76, borderRadius: '50%', background: T.hair, overflow: 'hidden',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.soft }}>
                {f.photo_url ? <img src={f.photo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                             : <Icon name="user" size={28} />}
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>Foto de perfil</div>
                <div style={{ fontSize: 12.5, color: T.soft, marginTop: 3, marginBottom: 8, lineHeight: 1.45 }}>
                  La ve el cliente que espera su pedido.
                </div>
                <label>
                  <input type="file" accept="image/*" style={{ display: 'none' }}
                         onChange={e => pickPhoto(e, 'photo')} />
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 15px',
                                 border: `1px solid ${T.line}`, borderRadius: R.pill, fontSize: 13,
                                 fontWeight: 600, cursor: 'pointer', color: T.ink }}>
                    <Icon name="camera" size={14} /> {f.photo_url ? 'Cambiar' : 'Subir foto'}
                  </span>
                </label>
              </div>
            </div>

            <div style={{ display: 'grid', gap: 0, gridTemplateColumns: mob ? '1fr' : '1fr 1fr', columnGap: 16 }}>
              <Field label="Nombre" req><Inp value={f.first_name} onChange={e => set('first_name', e.target.value)} /></Field>
              <Field label="Apellido" req><Inp value={f.last_name} onChange={e => set('last_name', e.target.value)} /></Field>
              <Field label="Fecha de nacimiento" req>
                <Inp type="date" value={f.birth_date} onChange={e => set('birth_date', e.target.value)} />
              </Field>
              <Field label="Sexo" hint="Opcional.">
                <Sel value={f.gender} onChange={e => set('gender', e.target.value)}>
                  <option value="">Prefiero no decirlo</option>
                  <option value="Femenino">Femenino</option>
                  <option value="Masculino">Masculino</option>
                  <option value="Otro">Otro</option>
                </Sel>
              </Field>
              <Field label="Documento de identidad" req hint="Sólo números.">
                <Inp inputMode="numeric" value={f.doc_number}
                     onChange={e => set('doc_number', e.target.value.replace(/[^\d]/g, ''))} />
              </Field>
              <Field label="Nacionalidad"><Inp value={f.nationality} onChange={e => set('nationality', e.target.value)} /></Field>
              <Field label="Celular" req><Inp inputMode="tel" value={f.phone} onChange={e => set('phone', e.target.value)} placeholder="0981 000 000" /></Field>
              <Field label="WhatsApp" hint="Es como te vamos a escribir.">
                <Inp inputMode="tel" value={f.whatsapp} onChange={e => set('whatsapp', e.target.value)} placeholder="0981 000 000" />
              </Field>
              <Field label="Ciudad" req><Inp value={f.city} onChange={e => set('city', e.target.value)} /></Field>
              <Field label="Departamento"><Inp value={f.department} onChange={e => set('department', e.target.value)} /></Field>
            </div>
            <Field label="Dirección"><Inp value={f.address} onChange={e => set('address', e.target.value)} /></Field>

            {cfg?.require_selfie && (
              <div style={{ background: T.sunk, borderRadius: R.md, padding: 16, marginTop: 6 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>Selfie de validación</div>
                <div style={{ fontSize: 12.5, color: T.mid, marginTop: 4, marginBottom: 10, lineHeight: 1.5 }}>
                  Una foto tuya sosteniendo tu documento. Es privada: no la ve ningún restaurante.
                </div>
                <label>
                  <input type="file" accept="image/*" capture="user" style={{ display: 'none' }}
                         onChange={e => pickPhoto(e, 'selfie')} />
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px',
                                 border: `1px solid ${T.line}`, borderRadius: R.pill, fontSize: 13,
                                 fontWeight: 600, cursor: 'pointer', color: T.ink, background: '#FFF' }}>
                    <Icon name="camera" size={14} /> {f.selfie_path ? 'Cargada · cambiar' : 'Tomar selfie'}
                  </span>
                </label>
              </div>
            )}
          </>)}

          {/* ── 2. Vehículo ── */}
          {step === 1 && (<>
            <Field label="Tipo de vehículo" req>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {VEHICLES.map(v => (
                  <button key={v.v} onClick={() => set('vehicle_type', v.v)}
                          style={{ padding: '11px 20px', borderRadius: R.pill, cursor: 'pointer',
                                   border: `1px solid ${f.vehicle_type === v.v ? T.ink : T.line}`,
                                   background: f.vehicle_type === v.v ? T.ink : '#FFF',
                                   color: f.vehicle_type === v.v ? '#FFF' : T.body,
                                   fontSize: 14, fontWeight: 600 }}>{v.label}</button>
                ))}
              </div>
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: mob ? '1fr' : '1fr 1fr', columnGap: 16 }}>
              <Field label="Marca"><Inp value={f.vehicle_brand} onChange={e => set('vehicle_brand', e.target.value)} /></Field>
              <Field label="Modelo"><Inp value={f.vehicle_model} onChange={e => set('vehicle_model', e.target.value)} /></Field>
              <Field label="Color"><Inp value={f.vehicle_color} onChange={e => set('vehicle_color', e.target.value)} /></Field>
              <Field label="Año"><Inp inputMode="numeric" value={f.vehicle_year}
                                      onChange={e => set('vehicle_year', e.target.value.replace(/[^\d]/g, '').slice(0, 4))} /></Field>
            </div>
            {(f.vehicle_type === 'moto' || f.vehicle_type === 'auto') && (<>
              <Field label="Patente / chapa" req hint="La usamos para verificar que el vehículo es el que declaraste.">
                <Inp value={f.vehicle_plate} onChange={e => set('vehicle_plate', e.target.value.toUpperCase())} />
              </Field>
              <div style={{ display: 'grid', gridTemplateColumns: mob ? '1fr' : '1fr 1fr', columnGap: 16 }}>
                <Field label="Número de chasis" hint="Si corresponde.">
                  <Inp value={f.vehicle_chassis} onChange={e => set('vehicle_chassis', e.target.value)} /></Field>
                <Field label="Número de motor" hint="Si corresponde.">
                  <Inp value={f.vehicle_engine} onChange={e => set('vehicle_engine', e.target.value)} /></Field>
              </div>
            </>)}
          </>)}

          {/* ── 3. Documentos ── */}
          {step === 2 && (<>
            <div style={{ fontSize: 14.5, color: T.mid, lineHeight: 1.6, marginBottom: 4 }}>
              Estos son los documentos que se piden para <b style={{ color: T.ink }}>
              {VEHICLES.find(v => v.v === f.vehicle_type)?.label.toLowerCase()}</b>. Son privados:
              los ve Mythos para verificarte, no los restaurantes.
            </div>
            {docs.length === 0
              ? <Empty icon="fileText" title="Sin documentos configurados"
                       sub="Todavía no hay documentos cargados en el catálogo de la red." />
              : docs.map(d => <DocRow key={d.slug} doc={d} toast={toast} onUploaded={reload} />)}
            {missingDocs > 0 && (
              <div style={{ background: T.warnBg, borderRadius: R.md, padding: 13, marginTop: 16,
                            fontSize: 13, color: T.warn, lineHeight: 1.5 }}>
                Te faltan {missingDocs} documento(s) obligatorio(s) para poder enviar la solicitud.
              </div>
            )}
          </>)}

          {/* ── 4. Cobro ── */}
          {step === 3 && (<>
            <div style={{ background: T.sunk, borderRadius: R.md, padding: 15, marginBottom: 20,
                          fontSize: 13.5, color: T.body, lineHeight: 1.6 }}>
              <b>El pago te lo hace el restaurante, directamente a vos.</b> Mythos no cobra ni administra
              ese dinero: guarda tus datos para que el local pueda transferirte y para llevar el registro
              de lo que te corresponde por período.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: mob ? '1fr' : '1fr 1fr', columnGap: 16 }}>
              <Field label="Titular de la cuenta" req>
                <Inp value={f.bank_holder} onChange={e => set('bank_holder', e.target.value)} /></Field>
              <Field label="Banco / billetera" req>
                <Inp value={f.bank_name} onChange={e => set('bank_name', e.target.value)} /></Field>
              <Field label="Número de cuenta" req>
                <Inp value={f.bank_account} onChange={e => set('bank_account', e.target.value)} /></Field>
              <Field label="Alias" hint="Si tu banco lo usa.">
                <Inp value={f.bank_alias} onChange={e => set('bank_alias', e.target.value)} /></Field>
            </div>
            <Field label="Tipo de cuenta">
              <Sel value={f.bank_account_type} onChange={e => set('bank_account_type', e.target.value)}>
                <option>Ahorro</option><option>Corriente</option><option>Billetera</option>
              </Sel>
            </Field>
          </>)}

          {/* ── 5. Contrato ── */}
          {step === 4 && (<>
            <div style={{ fontSize: 15.5, fontWeight: 700, color: T.ink, marginBottom: 6 }}>
              {cfg?.contract?.title || 'Términos de la Red de Riders Mythos'}
            </div>
            <div style={{ fontSize: 12.5, color: T.soft, marginBottom: 14 }}>
              Versión {cfg?.contract?.version || '—'}
            </div>
            <div onScroll={e => {
                   const el = e.target;
                   if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) setReadContract(true);
                 }}
                 style={{ maxHeight: 300, overflowY: 'auto', border: `1px solid ${T.line}`,
                          borderRadius: R.md, padding: 16, fontSize: 13.5, color: T.body,
                          lineHeight: 1.7, whiteSpace: 'pre-wrap', background: T.sunk }}>
              {cfg?.contract?.body || 'No hay un contrato publicado todavía.'}
            </div>
            <div style={{ fontSize: 12, color: T.soft, marginTop: 8 }}>
              También podés leerlo en <a href="/terminos-riders" target="_blank" rel="noopener noreferrer"
                 style={{ color: T.ink }}>/terminos-riders</a>.
            </div>

            <label style={{ display: 'flex', gap: 11, alignItems: 'flex-start', marginTop: 20,
                            cursor: 'pointer', padding: 15, background: T.hair, borderRadius: R.md }}>
              <input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)}
                     style={{ width: 19, height: 19, marginTop: 1, flexShrink: 0, accentColor: T.ink }} />
              <span style={{ fontSize: 13.5, color: T.body, lineHeight: 1.55 }}>
                Leí y acepto los términos, y declaro que uso la plataforma como
                <b> prestador independiente</b>: sin relación de dependencia con Mythos, con mis propios
                medios y organizando libremente mi tiempo. Entiendo que <b>el pago del delivery lo hace
                el restaurante directamente</b> y que Mythos no administra ese dinero.
              </span>
            </label>
            <div style={{ fontSize: 11.5, color: T.soft, marginTop: 10, lineHeight: 1.5 }}>
              Al enviar queda registrada tu aceptación con fecha, hora, dirección IP y número de versión
              del documento.
            </div>
          </>)}
        </Card>

        {/* Navegación */}
        <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
          {step > 0 && <Btn variant="secondary" onClick={() => saveStep(step - 1)} disabled={saving}>Atrás</Btn>}
          <div style={{ flex: 1 }} />
          {step < STEPS.length - 1
            ? <Btn onClick={() => saveStep(step + 1)} disabled={saving}>
                {saving ? 'Guardando…' : 'Guardar y seguir'}
              </Btn>
            : <Btn onClick={submit} disabled={saving || !accepted}>
                {saving ? 'Enviando…' : 'Enviar solicitud'}
              </Btn>}
        </div>
      </div>
    </main>
  );
}

/* ══ ESTADO DE LA SOLICITUD (enviada / rechazada / suspendido) ═══ */
function StatusScreen({ profile, cfg, reload, toast, onFix }) {
  const mob = useIsMobile();
  const r = profile.rider || {};
  const s = STATUS[r.status] || STATUS.pendiente;
  const inc = (profile.incidents || []).filter(i => ['observacion', 'rechazo', 'suspension', 'bloqueo'].includes(i.kind));

  async function doTraining() {
    const { error } = await API.markTrainingDone();
    if (error) { toast(error.message || 'No pudimos registrarlo.', 'bad'); return; }
    toast('¡Listo! Ya podés empezar.');
    reload();
  }

  return (
    <main style={{ flex: 1 }}>
      <div className="wrap" style={{ maxWidth: 660, padding: mob ? '34px 16px 50px' : '60px 20px 70px',
                                     textAlign: 'center' }}>
        <div style={{ width: 62, height: 62, borderRadius: '50%', margin: '0 auto 20px',
                      background: s.tone === 'ok' ? T.okBg : s.tone === 'bad' ? T.badBg : T.warnBg,
                      color: s.tone === 'ok' ? T.ok : s.tone === 'bad' ? T.bad : T.warn,
                      display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={s.tone === 'ok' ? 'checkCircle' : s.tone === 'bad' ? 'alert' : 'clock'} size={26} />
        </div>
        <h1 style={{ fontSize: mob ? 25 : 32, fontWeight: 800, color: T.ink, letterSpacing: '-.03em' }}>
          {r.status === 'pendiente' ? 'Tu solicitud está en revisión' : s.label}
        </h1>
        <p style={{ fontSize: 15, color: T.mid, marginTop: 12, lineHeight: 1.6 }}>
          {r.status_reason || s.desc}
        </p>
        {r.suspended_until && (
          <p style={{ fontSize: 14, color: T.warn, marginTop: 10 }}>
            Hasta el {fmtDateTime(r.suspended_until)}.
          </p>
        )}

        {/* Capacitación pendiente */}
        {r.status === 'aprobado' && (
          <Card style={{ marginTop: 28, textAlign: 'left' }}>
            <div style={{ fontSize: 15.5, fontWeight: 700, color: T.ink, marginBottom: 6 }}>
              Falta la capacitación
            </div>
            <div style={{ fontSize: 13.5, color: T.mid, lineHeight: 1.6, marginBottom: 16 }}>
              Es corta y explica cómo funciona la entrega, qué hacer si el cliente no aparece y cómo se
              maneja el efectivo.
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {cfg?.training_url && (
                <a href={cfg.training_url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                  <Btn variant="secondary">Ver la capacitación</Btn>
                </a>
              )}
              <Btn onClick={doTraining}>Ya la hice</Btn>
            </div>
          </Card>
        )}

        {/* Observaciones a corregir */}
        {inc.length > 0 && (
          <Card style={{ marginTop: 24, textAlign: 'left' }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: T.soft, letterSpacing: '.06em',
                          textTransform: 'uppercase', marginBottom: 12 }}>Qué nos falta</div>
            {inc.slice(0, 5).map((i, k) => (
              <div key={i.id} style={{ paddingTop: k ? 12 : 0, marginTop: k ? 12 : 0,
                                       borderTop: k ? `1px solid ${T.hair}` : 'none' }}>
                <div style={{ fontSize: 13.5, color: T.body, lineHeight: 1.55 }}>
                  {i.detail || i.reason || '—'}
                </div>
                <div style={{ fontSize: 11.5, color: T.soft, marginTop: 4 }}>{fmtDateTime(i.created_at)}</div>
              </div>
            ))}
          </Card>
        )}

        {(r.status === 'observado' || r.status === 'rechazado' || r.status === 'suspendido') && (
          <div style={{ marginTop: 26 }}>
            <Btn onClick={onFix}>
              {r.status === 'suspendido' ? 'Actualizar mis documentos' : 'Corregir mi solicitud'}
            </Btn>
            <div style={{ fontSize: 12.5, color: T.soft, marginTop: 12, lineHeight: 1.5 }}>
              No empezás de cero: tus datos y tus documentos siguen cargados.
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

/* ══ PERFIL DEL RIDER ACTIVO ═════════════════════════════════════ */
const TABS = [
  { id: 'resumen',  label: 'Resumen',    icon: 'dashboard' },
  { id: 'locales',  label: 'Locales',    icon: 'store' },
  { id: 'docs',     label: 'Documentos', icon: 'fileText' },
  { id: 'historial',label: 'Historial',  icon: 'clipboard' },
  { id: 'ranking',  label: 'Ranking',    icon: 'star' },
  { id: 'casos',    label: 'Expedientes',icon: 'alert' },
  { id: 'avisos',   label: 'Avisos',     icon: 'bell' },
];

function Profile({ profile, cfg, reload, toast }) {
  const mob = useIsMobile();
  const r = profile.rider || {};
  const st = profile.stats || {};
  const [tab, setTab] = useState('resumen');
  const [busy, setBusy] = useState(false);

  const avail = r.availability || 'desconectado';
  const canWork = r.status === 'activo';

  /* Geolocalización: sólo mientras está disponible u ocupado, con el intervalo
     que fija el superadmin. Al desconectarse se corta y la RPC además rechaza
     el ping — "nunca si está desconectado" tiene que valer en los dos lados. */
  useEffect(() => {
    if (!canWork || !profile.config?.geo_enabled) return;
    if (avail === 'desconectado' || avail === 'pausado') return;
    if (!navigator.geolocation) return;
    let stop = false;
    const send = () => navigator.geolocation.getCurrentPosition(
      p => { if (!stop) API.pingLocation(p.coords.latitude, p.coords.longitude); },
      () => {}, { enableHighAccuracy: true, maximumAge: 30000, timeout: 12000 });
    send();
    const iv = setInterval(send, Math.max(15, profile.config?.geo_interval || 60) * 1000);
    return () => { stop = true; clearInterval(iv); };
  }, [avail, canWork, profile.config?.geo_enabled, profile.config?.geo_interval]);

  async function setAvail(next) {
    setBusy(true);
    const { error } = await API.setAvailability(next);
    setBusy(false);
    if (error) { toast(error.message || 'No pudimos cambiar tu estado.', 'bad'); return; }
    reload();
  }

  return (
    <main style={{ flex: 1 }}>
      <div className="wrap" style={{ padding: mob ? '20px 16px 44px' : '32px 20px 60px' }}>

        {/* Cabecera */}
        <Card style={{ marginBottom: 20 }} pad={mob ? 18 : 24}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ width: 64, height: 64, borderRadius: '50%', background: T.hair, overflow: 'hidden',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: T.soft, flexShrink: 0 }}>
              {r.photo_url ? <img src={r.photo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                           : <Icon name="user" size={26} />}
            </div>
            <div style={{ flex: 1, minWidth: 170 }}>
              <div style={{ fontSize: 19, fontWeight: 800, color: T.ink, letterSpacing: '-.02em' }}>
                {[r.first_name, r.last_name].filter(Boolean).join(' ') || 'Rider'}
              </div>
              <div style={{ display: 'flex', gap: 7, marginTop: 7, flexWrap: 'wrap', alignItems: 'center' }}>
                <Pill tone={(STATUS[r.status] || {}).tone}>{(STATUS[r.status] || {}).label || r.status}</Pill>
                <Pill tone={(AVAIL[avail] || {}).tone}>{(AVAIL[avail] || {}).label || avail}</Pill>
                {r.city && <span style={{ fontSize: 12.5, color: T.soft }}>{r.city}</span>}
                <span style={{ fontSize: 12.5, color: T.soft }}>
                  · {VEHICLES.find(v => v.v === r.vehicle_type)?.label || r.vehicle_type}
                </span>
              </div>
            </div>
            {canWork && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {avail === 'disponible'
                  ? <Btn small variant="secondary" disabled={busy} onClick={() => setAvail('pausado')}>Pausar</Btn>
                  : <Btn small disabled={busy || avail === 'ocupado'} onClick={() => setAvail('disponible')}>
                      Ponerme disponible
                    </Btn>}
                {avail !== 'desconectado' && (
                  <Btn small variant="ghost" disabled={busy} onClick={() => setAvail('desconectado')}>Desconectarme</Btn>
                )}
              </div>
            )}
          </div>

          {canWork && avail === 'disponible' && (
            <div style={{ marginTop: 16, padding: 13, background: T.okBg, borderRadius: R.md,
                          fontSize: 13, color: T.ok, lineHeight: 1.5, display: 'flex', gap: 9 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: T.ok, marginTop: 5,
                             flexShrink: 0, animation: 'pulse 1.8s ease-in-out infinite' }} />
              <span>Estás disponible. Los pedidos que aceptes aparecen en tu panel de trabajo —
                    entrá con <b>Ir a trabajar</b>.</span>
            </div>
          )}
        </Card>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 20, overflowX: 'auto', paddingBottom: 2 }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 7, flexShrink: 0,
                             background: tab === t.id ? T.ink : '#FFF', color: tab === t.id ? '#FFF' : T.mid,
                             border: `1px solid ${tab === t.id ? T.ink : T.line}`, borderRadius: R.pill,
                             padding: '9px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              <Icon name={t.icon} size={14} /> {t.label}
              {t.id === 'avisos' && st.unread > 0 && (
                <span style={{ background: tab === t.id ? '#FFF' : T.bad, color: tab === t.id ? T.ink : '#FFF',
                               borderRadius: R.pill, padding: '1px 6px', fontSize: 10.5, fontWeight: 800 }}>
                  {st.unread}
                </span>
              )}
            </button>
          ))}
        </div>

        {tab === 'resumen'   && <TabResumen profile={profile} />}
        {tab === 'locales'   && <TabLocales profile={profile} reload={reload} toast={toast} />}
        {tab === 'docs'      && <TabDocs profile={profile} reload={reload} toast={toast} />}
        {tab === 'historial' && <TabHistorial toast={toast} />}
        {tab === 'ranking'   && <TabRanking rider={r} />}
        {tab === 'casos'     && <TabCasos profile={profile} reload={reload} toast={toast} />}
        {tab === 'avisos'    && <TabAvisos profile={profile} reload={reload} />}
      </div>
    </main>
  );
}

function Stat({ value, label, sub }) {
  return (
    <Card>
      <div style={{ fontSize: 27, fontWeight: 800, color: T.ink, letterSpacing: '-.03em' }}>{value}</div>
      <div style={{ fontSize: 12.5, color: T.mid, marginTop: 4 }}>{label}</div>
      {sub && <div style={{ fontSize: 11.5, color: T.soft, marginTop: 3 }}>{sub}</div>}
    </Card>
  );
}

function TabResumen({ profile }) {
  const st = profile.stats || {};
  const r = profile.rider || {};
  const dims = (profile.dimensions || []).filter(d => d.avg != null);
  return (<>
    <div className="grid" style={{ marginBottom: 20 }}>
      <Stat value={st.deliveries || 0} label="Entregas" />
      <Stat value={st.rating_avg ? Number(st.rating_avg).toFixed(2) : '—'} label="Calificación"
            sub={st.rating_count ? `${st.rating_count} opinión(es)` : 'Todavía sin opiniones'} />
      <Stat value={st.avg_minutes ? `${Math.round(st.avg_minutes)} min` : '—'} label="Tiempo promedio" />
      <Stat value={st.compliance != null ? `${st.compliance}%` : '—'} label="Cumplimiento"
            sub="Entregas sobre pedidos ofrecidos" />
    </div>

    {dims.length > 0 && (
      <Card style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: T.soft, letterSpacing: '.06em',
                      textTransform: 'uppercase', marginBottom: 14 }}>Tu reputación por aspecto</div>
        {dims.map((d, i) => (
          <div key={d.slug} style={{ display: 'flex', alignItems: 'center', gap: 14,
                                     paddingTop: i ? 11 : 0, marginTop: i ? 11 : 0,
                                     borderTop: i ? `1px solid ${T.hair}` : 'none' }}>
            <div style={{ fontSize: 13.5, color: T.body, width: 140, flexShrink: 0 }}>{d.label}</div>
            <div style={{ flex: 1, height: 6, background: T.hair, borderRadius: R.pill, overflow: 'hidden' }}>
              <div style={{ width: `${(Number(d.avg) / 5) * 100}%`, height: '100%', background: T.ink }} />
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.ink, width: 34, textAlign: 'right' }}>
              {Number(d.avg).toFixed(1)}
            </div>
          </div>
        ))}
      </Card>
    )}

    <Card>
      <div style={{ fontSize: 11, fontWeight: 800, color: T.soft, letterSpacing: '.06em',
                    textTransform: 'uppercase', marginBottom: 12 }}>Tu historial en la red</div>
      {(profile.incidents || []).length === 0
        ? <div style={{ fontSize: 13.5, color: T.mid, lineHeight: 1.55 }}>
            Sin advertencias ni sanciones. Seguí así.
          </div>
        : (profile.incidents || []).slice(0, 8).map((i, k) => (
            <div key={i.id} style={{ display: 'flex', gap: 12, paddingTop: k ? 12 : 0, marginTop: k ? 12 : 0,
                                     borderTop: k ? `1px solid ${T.hair}` : 'none' }}>
              <Pill tone={['suspension', 'bloqueo'].includes(i.kind) ? 'bad'
                        : i.kind === 'advertencia' ? 'warn'
                        : ['aprobacion', 'reactivacion'].includes(i.kind) ? 'ok' : 'neutral'}>
                {i.kind}
              </Pill>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, color: T.body, lineHeight: 1.5 }}>
                  {i.detail || i.reason || '—'}
                </div>
                <div style={{ fontSize: 11.5, color: T.soft, marginTop: 3 }}>
                  {fmtDateTime(i.created_at)}{i.automatic ? ' · automático' : ''}
                </div>
              </div>
            </div>
          ))}
    </Card>
  </>);
}

function TabLocales({ profile, reload, toast }) {
  const [places, setPlaces] = useState(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const links = profile.links || [];

  const load = useCallback(async (search) => {
    const { data } = await API.networkPlaces(search);
    setPlaces(Array.isArray(data) ? data : []);
  }, []);
  useEffect(() => { load(''); }, [load]);

  async function join(id) {
    setBusy(id);
    const { data, error } = await API.joinPlace(id);
    setBusy('');
    if (error) { toast(error.message || 'No pudimos sumarte.', 'bad'); return; }
    toast(data?.pending ? 'Pedido enviado: el local tiene que aceptarte.' : 'Ya trabajás con ese local.');
    reload(); load(q);
  }
  async function leave(id) {
    setBusy(id);
    const { error } = await API.leavePlace(id);
    setBusy('');
    if (error) { toast(error.message || 'No pudimos sacarte.', 'bad'); return; }
    toast('Saliste de ese local.');
    reload(); load(q);
  }

  return (<>
    <Card style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: T.soft, letterSpacing: '.06em',
                    textTransform: 'uppercase', marginBottom: 12 }}>
        Donde trabajás ({links.length})
      </div>
      {links.length === 0
        ? <div style={{ fontSize: 13.5, color: T.mid, lineHeight: 1.55 }}>
            Todavía no te sumaste a ningún local. Elegí abajo los que te queden cómodos:
            podés estar en varios al mismo tiempo.
          </div>
        : links.map((l, i) => (
            <div key={l.link_id} style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
                                          paddingTop: i ? 13 : 0, marginTop: i ? 13 : 0,
                                          borderTop: i ? `1px solid ${T.hair}` : 'none' }}>
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontSize: 14.5, fontWeight: 700, color: T.ink }}>{l.name}</div>
                <div style={{ fontSize: 12.5, color: T.soft, marginTop: 2 }}>
                  {[l.city, l.address].filter(Boolean).join(' · ') || '—'}
                </div>
                <div style={{ fontSize: 12.5, color: T.mid, marginTop: 4 }}>
                  Te paga {l.pay_type === 'pct' ? `${l.pay_value}% del pedido` : fmtGs(l.pay_value) + ' por entrega'}
                  {l.pay_method ? ` · ${l.pay_method}` : ''}
                </div>
              </div>
              <Pill tone={l.link_status === 'activo' ? 'ok' : 'warn'}>
                {l.link_status === 'activo' ? 'Activo' : 'Esperando al local'}
              </Pill>
              <Btn small variant="danger" disabled={busy === l.restaurant_id}
                   onClick={() => leave(l.restaurant_id)}>Salir</Btn>
            </div>
          ))}
    </Card>

    <Card>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: T.soft, letterSpacing: '.06em',
                      textTransform: 'uppercase', flex: 1 }}>Locales de la red</div>
        <Inp value={q} placeholder="Buscar por nombre o ciudad"
             onChange={e => { setQ(e.target.value); load(e.target.value); }}
             style={{ height: 40, maxWidth: 260, fontSize: 13.5 }} />
      </div>
      {places === null ? <Loading label="Buscando locales…" />
        : places.length === 0
          ? <Empty icon="store" title="Todavía no hay locales en la red"
                   sub="Cuando un restaurante se sume, va a aparecer acá." />
          : places.filter(p => !p.linked).length === 0 && places.length > 0
            ? <div style={{ fontSize: 13.5, color: T.mid, lineHeight: 1.55 }}>
                Ya estás en todos los locales disponibles.
              </div>
            : places.filter(p => !p.linked).map((p, i) => (
                <div key={p.restaurant_id}
                     style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
                              paddingTop: i ? 13 : 0, marginTop: i ? 13 : 0,
                              borderTop: i ? `1px solid ${T.hair}` : 'none' }}>
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 700, color: T.ink }}>{p.name}</div>
                    <div style={{ fontSize: 12.5, color: T.soft, marginTop: 2 }}>
                      {[p.city, p.address].filter(Boolean).join(' · ') || '—'}
                    </div>
                    <div style={{ fontSize: 12.5, color: T.mid, marginTop: 4 }}>
                      Paga {p.pay_type === 'pct' ? `${p.pay_value}% del pedido` : fmtGs(p.pay_value) + ' por entrega'}
                      {' · '}{p.dispatch_mode === 'oferta' ? 'te ofrece los pedidos' : 'te los asigna directo'}
                    </div>
                  </div>
                  {p.full
                    ? <Pill tone="neutral">Cupo lleno</Pill>
                    : <Btn small disabled={busy === p.restaurant_id} onClick={() => join(p.restaurant_id)}>
                        Sumarme
                      </Btn>}
                </div>
              ))}
    </Card>
  </>);
}

function TabDocs({ profile, reload, toast }) {
  const docs = profile.docs || [];
  const venc = docs.filter(d => d.status === 'vencido').length;
  const pronto = docs.filter(d => typeof d.days_left === 'number' && d.days_left >= 0 && d.days_left <= 30).length;
  return (
    <Card>
      {venc > 0 && (
        <div style={{ background: T.badBg, borderRadius: R.md, padding: 13, marginBottom: 14,
                      fontSize: 13, color: T.bad, lineHeight: 1.5 }}>
          Tenés {venc} documento(s) vencido(s). Mientras siga así, tu cuenta queda suspendida:
          subí el actualizado y lo revisamos.
        </div>
      )}
      {venc === 0 && pronto > 0 && (
        <div style={{ background: T.warnBg, borderRadius: R.md, padding: 13, marginBottom: 14,
                      fontSize: 13, color: T.warn, lineHeight: 1.5 }}>
          Tenés {pronto} documento(s) por vencer en los próximos 30 días.
        </div>
      )}
      <div style={{ fontSize: 13.5, color: T.mid, lineHeight: 1.55, marginBottom: 4 }}>
        Tus documentos son privados: los ve Mythos para verificarte, nunca los restaurantes.
      </div>
      {docs.map(d => <DocRow key={d.slug} doc={d} toast={toast} onUploaded={reload} />)}
    </Card>
  );
}

function TabHistorial({ toast }) {
  const mob = useIsMobile();
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [data, setData] = useState(null);

  const load = useCallback(async (f, t) => {
    setData(null);
    const { data: d, error } = await API.myHistory(f, t);
    if (error) { toast(error.message || 'No pudimos cargar el historial.', 'bad'); setData({ rows: [] }); return; }
    setData(d || { rows: [] });
  }, [toast]);
  useEffect(() => { load(from, to); }, []);

  const rows = data?.rows || [];
  const total = rows.reduce((s, r) => s + (Number(r.pay) || 0), 0);
  const mins = rows.filter(r => r.minutes != null);
  const avg = mins.length ? Math.round(mins.reduce((s, r) => s + Number(r.minutes), 0) / mins.length) : null;

  return (<>
    <Card style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div><div style={{ fontSize: 11, fontWeight: 800, color: T.soft, letterSpacing: '.06em',
                           textTransform: 'uppercase', marginBottom: 6 }}>Desde</div>
          <Inp type="date" value={from} onChange={e => setFrom(e.target.value)} style={{ height: 42, width: 165 }} /></div>
        <div><div style={{ fontSize: 11, fontWeight: 800, color: T.soft, letterSpacing: '.06em',
                           textTransform: 'uppercase', marginBottom: 6 }}>Hasta</div>
          <Inp type="date" value={to} onChange={e => setTo(e.target.value)} style={{ height: 42, width: 165 }} /></div>
        <Btn onClick={() => load(from, to)}>Ver</Btn>
      </div>
    </Card>

    {data === null ? <Loading /> : (<>
      <div className="grid" style={{ marginBottom: 20 }}>
        <Stat value={rows.length} label="Entregas" />
        <Stat value={fmtGs(total)} label="Estimado a cobrar"
              sub="Según lo que paga cada local" />
        <Stat value={avg != null ? `${avg} min` : '—'} label="Promedio por entrega" />
      </div>

      <Card style={{ marginBottom: 20 }} pad={0}>
        <div style={{ padding: '16px 20px 12px', fontSize: 11, fontWeight: 800, color: T.soft,
                      letterSpacing: '.06em', textTransform: 'uppercase' }}>Entregas</div>
        {rows.length === 0
          ? <Empty icon="clipboard" title="Sin entregas en ese rango" />
          : <div className="tscroll">
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
                <thead>
                  <tr>{['Fecha', 'Local', 'Cliente', 'Pedido', 'Minutos', 'Te toca'].map(h => (
                    <th key={h} style={{ textAlign: h === 'Pedido' || h === 'Te toca' ? 'right' : 'left',
                                         fontSize: 11, fontWeight: 700, color: T.soft, padding: '8px 20px',
                                         borderBottom: `1px solid ${T.line}` }}>{h}</th>))}</tr>
                </thead>
                <tbody>
                  {rows.map(o => (
                    <tr key={o.id}>
                      <td style={{ padding: '11px 20px', fontSize: 13, color: T.mid, borderBottom: `1px solid ${T.hair}` }}>
                        {fmtDateTime(o.delivered_at)}</td>
                      <td style={{ padding: '11px 20px', fontSize: 13, color: T.body, fontWeight: 600, borderBottom: `1px solid ${T.hair}` }}>
                        {o.restaurant}</td>
                      <td style={{ padding: '11px 20px', fontSize: 13, color: T.mid, borderBottom: `1px solid ${T.hair}` }}>
                        {o.customer_name || '—'}</td>
                      <td style={{ padding: '11px 20px', fontSize: 13, color: T.mid, textAlign: 'right', borderBottom: `1px solid ${T.hair}` }}>
                        {fmtGs(o.order_total)}</td>
                      <td style={{ padding: '11px 20px', fontSize: 13, color: T.mid, textAlign: 'left', borderBottom: `1px solid ${T.hair}` }}>
                        {o.minutes != null ? `${o.minutes}′` : '—'}</td>
                      <td style={{ padding: '11px 20px', fontSize: 13, color: T.ink, fontWeight: 700, textAlign: 'right', borderBottom: `1px solid ${T.hair}` }}>
                        {o.pay != null ? fmtGs(o.pay) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}
      </Card>

      <Card pad={0}>
        <div style={{ padding: '16px 20px 12px', fontSize: 11, fontWeight: 800, color: T.soft,
                      letterSpacing: '.06em', textTransform: 'uppercase' }}>Pagos registrados por los locales</div>
        {(data.settlements || []).length === 0
          ? <div style={{ padding: '0 20px 20px', fontSize: 13.5, color: T.mid, lineHeight: 1.55 }}>
              Todavía ningún local registró un pago. Recordá que el pago lo hace el restaurante
              directamente: esto es el registro, no el cobro.
            </div>
          : <div style={{ padding: '0 20px 8px' }}>
              {(data.settlements || []).map((s, i) => (
                <div key={s.id} style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
                                         padding: '12px 0', borderTop: i ? `1px solid ${T.hair}` : 'none' }}>
                  <div style={{ flex: 1, minWidth: 150 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>{s.restaurant}</div>
                    <div style={{ fontSize: 12, color: T.soft, marginTop: 2 }}>
                      {fmtDate(s.period_from)} — {fmtDate(s.period_to)} · {s.deliveries} entrega(s)
                    </div>
                  </div>
                  <div style={{ fontSize: 14.5, fontWeight: 700, color: T.ink }}>{fmtGs(s.amount)}</div>
                  <Pill tone={s.status === 'pagado' ? 'ok' : 'warn'}>{s.status}</Pill>
                </div>
              ))}
            </div>}
      </Card>
    </>)}
  </>);
}

function TabRanking({ rider }) {
  const [scope, setScope] = useState('mes');
  const [onlyCity, setOnlyCity] = useState(false);
  const [data, setData] = useState(null);
  useEffect(() => {
    setData(null);
    API.leaderboard(scope, onlyCity ? rider.city : null).then(({ data: d }) => setData(d || { rows: [] }));
  }, [scope, onlyCity]);

  const rows = data?.rows || [];
  return (
    <Card pad={0}>
      <div style={{ padding: '18px 20px 14px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {[['mes', 'Este mes'], ['semana', 'Últimos 7 días'], ['historico', 'Histórico']].map(([v, l]) => (
          <button key={v} onClick={() => setScope(v)}
                  style={{ padding: '8px 14px', borderRadius: R.pill, cursor: 'pointer', fontSize: 12.5,
                           fontWeight: 600, border: `1px solid ${scope === v ? T.ink : T.line}`,
                           background: scope === v ? T.ink : '#FFF', color: scope === v ? '#FFF' : T.mid }}>{l}</button>
        ))}
        {rider.city && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5,
                          color: T.mid, cursor: 'pointer', marginLeft: 'auto' }}>
            <input type="checkbox" checked={onlyCity} onChange={e => setOnlyCity(e.target.checked)}
                   style={{ accentColor: T.ink }} />
            Sólo {rider.city}
          </label>
        )}
      </div>
      {data === null ? <Loading />
        : rows.length === 0
          ? <Empty icon="star" title="Todavía no hay ranking" sub="Aparece cuando haya entregas registradas en el período." />
          : <div style={{ padding: '0 20px 14px' }}>
              {rows.map((x, i) => {
                const me = x.rider_id === rider.id;
                return (
                  <div key={x.rider_id}
                       style={{ display: 'flex', gap: 13, alignItems: 'center', padding: '12px 12px',
                                margin: '0 -12px', borderTop: i ? `1px solid ${T.hair}` : 'none',
                                background: me ? T.hair : 'transparent', borderRadius: me ? R.md : 0 }}>
                    <div style={{ width: 26, fontSize: 14, fontWeight: 800,
                                  color: i < 3 ? T.ink : T.soft, textAlign: 'center' }}>{i + 1}</div>
                    <div style={{ width: 36, height: 36, borderRadius: '50%', background: T.hair,
                                  overflow: 'hidden', display: 'flex', alignItems: 'center',
                                  justifyContent: 'center', color: T.soft, flexShrink: 0 }}>
                      {x.photo_url ? <img src={x.photo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                   : <Icon name="user" size={16} />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: me ? 800 : 600, color: T.ink }}>
                        {x.name || 'Rider'}{me ? ' · vos' : ''}
                      </div>
                      <div style={{ fontSize: 12, color: T.soft }}>{x.city || '—'}</div>
                    </div>
                    {x.rating != null && (
                      <div style={{ fontSize: 12.5, color: T.mid, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Icon name="star" size={12} /> {Number(x.rating).toFixed(1)}
                      </div>
                    )}
                    <div style={{ fontSize: 14.5, fontWeight: 700, color: T.ink }}>{x.deliveries}</div>
                  </div>
                );
              })}
            </div>}
    </Card>
  );
}

function TabCasos({ profile, reload, toast }) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const cases = profile.cases || [];

  async function create() {
    if (!subject.trim()) { toast('Contá en una línea de qué se trata.', 'bad'); return; }
    setBusy(true);
    const { error } = await API.openCase({ subject, description: desc });
    setBusy(false);
    if (error) { toast(error.message || 'No pudimos abrirlo.', 'bad'); return; }
    toast('Expediente abierto. Te vamos a escribir por acá.');
    setOpen(false); setSubject(''); setDesc(''); reload();
  }

  return (<>
    <Card>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15.5, fontWeight: 700, color: T.ink }}>Expedientes</div>
          <div style={{ fontSize: 13, color: T.mid, marginTop: 3, lineHeight: 1.5 }}>
            Si hay un conflicto con un pedido, un cliente o un local, abrí uno: cada parte adjunta su
            versión y sus pruebas, y Mythos resuelve.
          </div>
        </div>
        <Btn small onClick={() => setOpen(true)}>Abrir expediente</Btn>
      </div>
      {cases.length === 0
        ? <Empty icon="check" title="Sin expedientes" sub="No tenés ningún conflicto abierto." />
        : cases.map((c, i) => (
            <div key={c.id} style={{ paddingTop: i ? 13 : 0, marginTop: i ? 13 : 0,
                                     borderTop: i ? `1px solid ${T.hair}` : 'none' }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontFamily: "'SF Mono',ui-monospace,monospace", fontSize: 12,
                               fontWeight: 700, color: T.mid }}>{c.code}</span>
                <Pill tone={c.status === 'resuelto' || c.status === 'cerrado' ? 'ok' : 'warn'}>{c.status}</Pill>
                <span style={{ fontSize: 12, color: T.soft }}>{fmtDate(c.created_at)}</span>
              </div>
              <div style={{ fontSize: 14, color: T.body, marginTop: 6, lineHeight: 1.5 }}>{c.subject}</div>
              {c.resolution && (
                <div style={{ fontSize: 13, color: T.ok, marginTop: 6, lineHeight: 1.5 }}>
                  Resolución: {c.resolution}
                </div>
              )}
            </div>
          ))}
    </Card>

    {open && (
      <Sheet title="Abrir expediente" onClose={() => setOpen(false)}
             footer={<Btn wide onClick={create} disabled={busy}>{busy ? 'Abriendo…' : 'Abrir expediente'}</Btn>}>
        <Field label="De qué se trata" req>
          <Inp value={subject} onChange={e => setSubject(e.target.value)}
               placeholder="Ej: el cliente no estaba en la dirección" /></Field>
        <Field label="Contanos qué pasó" hint="Después vas a poder adjuntar fotos y capturas.">
          <Area value={desc} onChange={e => setDesc(e.target.value)} /></Field>
      </Sheet>
    )}
  </>);
}

function TabAvisos({ profile, reload }) {
  const notifs = profile.notifications || [];
  const unread = notifs.filter(n => !n.read_at).length;
  useEffect(() => { if (unread > 0) API.markNotifsRead().then(reload); }, []);
  return (
    <Card>
      {notifs.length === 0
        ? <Empty icon="bell" title="Sin avisos" sub="Acá te avisamos cambios de estado, documentos por vencer y resoluciones." />
        : notifs.map((n, i) => (
            <div key={n.id} style={{ display: 'flex', gap: 12, paddingTop: i ? 14 : 0, marginTop: i ? 14 : 0,
                                     borderTop: i ? `1px solid ${T.hair}` : 'none' }}>
              <div style={{ width: 32, height: 32, borderRadius: '50%', background: T.hair, flexShrink: 0,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.mid }}>
                <Icon name={n.kind === 'vencimiento' ? 'clock' : n.kind === 'pago' ? 'money'
                          : n.kind === 'sancion' ? 'alert' : 'bell'} size={15} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>{n.title}</div>
                {n.body && <div style={{ fontSize: 13, color: T.mid, marginTop: 3, lineHeight: 1.5 }}>{n.body}</div>}
                <div style={{ fontSize: 11.5, color: T.soft, marginTop: 4 }}>{fmtDateTime(n.created_at)}</div>
              </div>
            </div>
          ))}
    </Card>
  );
}

/* ══ NUEVA CONTRASEÑA (aterrizaje del enlace de recuperación) ════ */
// Va ANTES que cualquier otra pantalla: quien llega por este enlace tiene una
// sesión abierta, y si lo dejáramos entrar al perfil se iría creyendo que
// cambió la contraseña sin haberla cambiado.
function RecoveryScreen({ onDone, toast }) {
  const mob = useIsMobile();
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(e) {
    e?.preventDefault();
    if (p1.length < 8)  { toast('La contraseña necesita al menos 8 caracteres.', 'bad'); return; }
    if (p1 !== p2)      { toast('Las dos contraseñas no coinciden.', 'bad'); return; }
    setBusy(true);
    try {
      await API.updatePassword(p1);
      toast('Contraseña actualizada.');
      onDone();
    } catch (e2) { toast(API.authMsg(e2), 'bad'); }
    setBusy(false);
  }

  return (
    <main style={{ flex: 1 }}>
      <div className="wrap" style={{ maxWidth: 420, padding: mob ? '34px 16px 50px' : '60px 20px 70px' }}>
        <h1 style={{ fontSize: mob ? 25 : 31, fontWeight: 800, color: T.ink, letterSpacing: '-.03em' }}>
          Elegí una contraseña nueva
        </h1>
        <p style={{ fontSize: 14.5, color: T.mid, marginTop: 10, marginBottom: 26, lineHeight: 1.6 }}>
          Entraste con el enlace que te mandamos. Poné tu contraseña nueva para terminar.
        </p>
        <form onSubmit={save}>
          <Field label="Contraseña nueva" req hint="Mínimo 8 caracteres.">
            <Inp type="password" value={p1} autoComplete="new-password"
                 onChange={e => setP1(e.target.value)} placeholder="••••••••" />
          </Field>
          <Field label="Repetila" req>
            <Inp type="password" value={p2} autoComplete="new-password"
                 onChange={e => setP2(e.target.value)} placeholder="••••••••" />
          </Field>
          <Btn type="submit" wide disabled={busy}>{busy ? 'Guardando…' : 'Guardar contraseña'}</Btn>
        </form>
      </div>
    </main>
  );
}

/* ══ PANTALLAS DE BORDE ══════════════════════════════════════════ */
function Blocked({ title, sub, action }) {
  return (
    <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ textAlign: 'center', maxWidth: 460 }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16, color: T.line }}>
          <Icon name="bike" size={44} />
        </div>
        <div style={{ fontSize: 21, fontWeight: 800, color: T.ink, letterSpacing: '-.02em' }}>{title}</div>
        <div style={{ fontSize: 14.5, color: T.mid, marginTop: 10, lineHeight: 1.6 }}>{sub}</div>
        {action && <div style={{ marginTop: 22 }}>{action}</div>}
      </div>
    </main>
  );
}

/* ══ APP ═════════════════════════════════════════════════════════ */
function App() {
  const [cfg, setCfg] = useState(null);
  const [cfgMissing, setCfgMissing] = useState(false);
  const [session, setSession] = useState(undefined);   // undefined = sin resolver
  const [profile, setProfile] = useState(null);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [enrollErr, setEnrollErr] = useState('');
  const [authOpen, setAuthOpen] = useState(false);
  const [forceEdit, setForceEdit] = useState(false);
  const [recovery, setRecovery] = useState(URL_RECOVERY);
  const [toast, setToast] = useState(null);

  const say = useCallback((msg, tone) => setToast({ msg, tone, k: Date.now() }), []);

  /* Config pública — se lee SIN cuenta: es lo que hace que la landing exista
     para alguien que todavía no se registró. */
  useEffect(() => {
    (async () => {
      const { data, missing } = await API.publicConfig();
      setCfgMissing(!!missing);
      setCfg(data || null);
    })();
  }, []);

  /* Sesión */
  useEffect(() => {
    (async () => setSession(await API.getSession()))();
    return API.onAuthChange((ev, s) => {
      // Segundo cinturón del aterrizaje de recuperación: si el hash ya se
      // consumió antes de que leyéramos URL_RECOVERY, el evento igual llega.
      if (ev === 'PASSWORD_RECOVERY') { setRecovery(true); }
      setSession(s || null);
      if (!s) { setProfile(null); setForceEdit(false); setRecovery(false); }
    });
  }, []);

  const loadProfile = useCallback(async () => {
    if (!session) { setProfile(null); return; }
    setLoadingProfile(true);
    // ensure_my_rider crea la ficha en borrador la primera vez. Falla a
    // propósito si la red está apagada o el registro cerrado y la persona
    // todavía no es rider — ese error es el portero, no un bug.
    const ens = await API.ensureRider();
    if (ens.error) setEnrollErr(ens.error.message || '');
    else setEnrollErr('');
    const { data } = await API.myProfile();
    setProfile(data && data.exists ? data : null);
    setLoadingProfile(false);
  }, [session]);

  useEffect(() => { if (session !== undefined) loadProfile(); }, [session, loadProfile]);

  async function signOut() {
    await API.signOut();
    setSession(null); setProfile(null); setForceEdit(false);
    say('Cerraste sesión.');
  }

  function startFlow() {
    if (session) { document.getElementById('app')?.scrollIntoView({ behavior: 'smooth' }); return; }
    setAuthOpen(true);
  }

  const canRegister = !!(cfg?.enabled && cfg?.registration_open);
  const rider = profile?.rider || null;

  /* ── Qué pantalla va ── */
  let body;
  if (cfg === null && !cfgMissing) {
    body = <Loading label="Cargando…" />;
  } else if (cfgMissing) {
    body = <Blocked title="La Red de Riders todavía no está publicada"
                    sub="Falta aplicar la migración 206 en la base. Cuando esté, esta página se activa sola."
                    action={<a href="/inicio" style={{ textDecoration: 'none' }}><Btn variant="secondary">Ir a Mythos</Btn></a>} />;
  } else if (session && recovery) {
    // Antes que TODO lo demás: quien llega por el enlace de recuperación ya
    // tiene sesión, y dejarlo pasar al perfil sería mandarlo a su cuenta
    // creyendo que cambió la contraseña cuando no la cambió.
    body = <RecoveryScreen toast={say} onDone={() => setRecovery(false)} />;
  } else if (session === undefined || (session && loadingProfile && !profile)) {
    body = <Loading label="Abriendo tu cuenta…" />;
  } else if (!session) {
    body = <Landing cfg={cfg} onStart={startFlow} />;
  } else if (!profile) {
    // Con sesión pero sin ficha: o la red está apagada, o el registro está
    // cerrado para alguien que todavía no es rider.
    body = <Blocked title={cfg?.enabled ? 'Las postulaciones están cerradas' : 'La red todavía no está disponible'}
                    sub={enrollErr || cfg?.closed_message || 'Volvé a intentar más adelante.'}
                    action={<Btn variant="secondary" onClick={signOut}>Cerrar sesión</Btn>} />;
  } else if (forceEdit || ['borrador', 'observado', 'rechazado'].includes(rider.status)) {
    body = <Application profile={profile} cfg={cfg} toast={say}
                        reload={async () => { await loadProfile(); }} />;
  } else if (['pendiente', 'aprobado', 'suspendido', 'bloqueado', 'baja'].includes(rider.status)) {
    body = <StatusScreen profile={profile} cfg={cfg} toast={say}
                         reload={async () => { setForceEdit(false); await loadProfile(); }}
                         onFix={() => setForceEdit(true)} />;
  } else {
    body = <Profile profile={profile} cfg={cfg} toast={say}
                    reload={async () => { await loadProfile(); }} />;
  }

  // Al salir del modo edición forzada cuando la solicitud ya se envió: si no,
  // el rider se quedaría mirando el formulario después de mandarla.
  useEffect(() => {
    if (forceEdit && rider && ['pendiente', 'activo', 'aprobado'].includes(rider.status)) setForceEdit(false);
  }, [rider?.status]);

  return (<>
    <Header session={session} rider={rider} unread={profile?.stats?.unread || 0}
            onAccount={() => setAuthOpen(true)} onSignOut={signOut} />
    {body}
    <Footer />
    {authOpen && (
      <AuthScreen canRegister={canRegister} closedMsg={cfg?.closed_message}
                  onClose={() => setAuthOpen(false)}
                  onDone={() => { setAuthOpen(false); say('¡Hola! Ya estás adentro.'); }} />
    )}
    {toast && <Toast key={toast.k} msg={toast.msg} tone={toast.tone} onHide={() => setToast(null)} />}
  </>);
}

createRoot(document.getElementById('app')).render(React.createElement(App));
