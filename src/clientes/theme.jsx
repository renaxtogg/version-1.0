// ════════════════════════════════════════════════════════════════════
// /clientes — sistema visual.
// ────────────────────────────────────────────────────────────────────
// Es el MISMO lenguaje del panel del QR (src/index/main.jsx): paleta
// blanco/negro tipo iOS, marco de teléfono de 390×844, misma tipografía y
// mismos íconos de trazo. Se replica en vez de importarse porque el panel del
// QR arma su tema desde los tweaks en vivo (EDITMODE) y acá no hay tweaks:
// el comensal no configura la carta de nadie.
//
// El shell SÍ es distinto, y a propósito (§9 del diseño): los paneles de staff
// tienen sidebar y grilla de KPIs porque un cajero está frente a un monitor.
// El comensal entra de noche, con una mano y con hambre → navegación abajo, al
// alcance del pulgar, y una pantalla por objetivo.
// ════════════════════════════════════════════════════════════════════
import React from "react";

const { createContext, useContext } = React;

export const PALETTES = {
  blanco: {
    black: '#000000', ink: '#1D1D1F', dark: '#2D2D2D', mid: '#6E6E73',
    gray: '#86868B', silver: '#BBB', border: '#E8E8E8', light: '#F0F0F0',
    offwhite: '#F8F8F8', white: '#FFF',
    hdrBg: '#FFF', hdrText: '#1D1D1F', hdrSub: '#86868B',
    hdrInputBg: '#F5F5F5', hdrInputBorder: '#E2E2E2', hdrInputText: '#1D1D1F',
    softBg: 'rgba(0,0,0,0.04)', softBorder: 'rgba(0,0,0,0.08)',
    btnPrimary: '#000000', btnPrimaryText: '#FFF', phoneBg: '#F8F8F8',
    // Panel de contraste (tarjeta de identidad). NO es `ink`: en tema oscuro
    // `ink` es casi blanco, así que usarlo de fondo con texto blanco fijo dejaba
    // la tarjeta ilegible. Va como token propio para que cada tema decida.
    heroBg: '#000000', heroText: '#FFFFFF', heroDim: 'rgba(255,255,255,.55)',
    heroTrack: 'rgba(255,255,255,.18)',
    good: '#16A34A', warn: '#B45309', bad: '#B91C1C', gold: '#B8860B'
  },
  negro: {
    black: '#000000', ink: '#F5F5F7', dark: '#2D2D2D', mid: '#8E8E93',
    gray: '#86868B', silver: '#5A5A5F', border: '#2C2C2E', light: '#1C1C1E',
    offwhite: '#000000', white: '#141416',
    hdrBg: '#000000', hdrText: '#FFF', hdrSub: '#86868B',
    hdrInputBg: 'rgba(255,255,255,0.07)', hdrInputBorder: 'rgba(255,255,255,0.12)', hdrInputText: '#FFF',
    softBg: 'rgba(255,255,255,0.05)', softBorder: 'rgba(255,255,255,0.10)',
    btnPrimary: '#FFFFFF', btnPrimaryText: '#000000', phoneBg: '#000000',
    // En oscuro el negro puro se funde con el fondo de la pantalla (offwhite es
    // #000): la tarjeta de identidad se ELEVA, no se hunde.
    heroBg: '#1F1F23', heroText: '#F5F5F7', heroDim: 'rgba(255,255,255,.5)',
    heroTrack: 'rgba(255,255,255,.14)',
    good: '#4ADE80', warn: '#FBBF24', bad: '#F87171', gold: '#E0B84C'
  }
};

export const FONT = "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
export const SERIF = "Georgia,'Times New Roman',serif";

export function makeTheme(mood) {
  const p = PALETTES[mood] || PALETTES.blanco;
  return {
    ...p,
    F: { h: SERIF, hW: 400, heroSz: 34, titleSz: 22, priceSz: 19,
         lCase: 'uppercase', lSpacing: '0.08em', menuTitleSz: 20 }
  };
}

export const ThemeCtx = createContext(makeTheme('blanco'));
export const useT = () => useContext(ThemeCtx);

/* ── Formato ─────────────────────────────────────────────────────── */
// El ₲ en PANTALLA está bien (el problema del glifo es sólo con la impresora
// térmica — ver la regla del comprobante en CLAUDE.md).
export const fmt  = (n) => '₲ ' + Number(n || 0).toLocaleString('es-PY');
export const num  = (n) => Number(n || 0).toLocaleString('es-PY');

/* ── Íconos ──────────────────────────────────────────────────────── */
// Mismo set de trazo del panel del QR, más los que necesita esta app.
export const Icon = ({ name, size = 20, color = 'currentColor', sw = 1.5, style }) => {
  const paths = {
    back:    <path d="M19 12H5M12 5l-7 7 7 7" />,
    menu:    <path d="M3 6h18M3 12h18M3 18h18" />,
    pin:     <><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" /><circle cx="12" cy="10" r="3" /></>,
    search:  <><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></>,
    x:       <path d="M18 6L6 18M6 6l12 12" />,
    check:   <path d="M20 6L9 17l-5-5" />,
    plus:    <path d="M12 5v14M5 12h14" />,
    clock:   <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
    bell:    <><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" /></>,
    star:    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />,
    heart:   <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" />,
    map:     <><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" /><circle cx="12" cy="10" r="3" /></>,
    cart:    <><circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" /><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6" /></>,
    user:    <><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></>,
    utensils:<><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 002-2V2" /><path d="M7 2v20" /><path d="M18 2a4 4 0 00-4 4v5c0 1.1.9 2 2 2h4V2z" /><path d="M18 13v9" /></>,
    award:   <><circle cx="12" cy="8" r="6" /><path d="M15.477 12.89L17 22l-5-3-5 3 1.523-9.11" /></>,
    trophy:  <><path d="M6 9H4.5a2.5 2.5 0 010-5H6" /><path d="M18 9h1.5a2.5 2.5 0 000-5H18" /><path d="M4 22h16" /><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" /><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" /><path d="M18 2H6v7a6 6 0 0012 0V2z" /></>,
    fire:    <path d="M12 2c0 0-4.8 5-4.8 9.5a4.8 4.8 0 009.6 0C16.8 7 12 2 12 2zm0 0c0 0 2.5 3 2.5 5.5a2.5 2.5 0 01-5 0C9.5 5 12 2 12 2z" />,
    bike:    <><circle cx="5.5" cy="17.5" r="3.5" /><circle cx="18.5" cy="17.5" r="3.5" /><path d="M15 6a1 1 0 100-2 1 1 0 000 2zM12 17.5V14l-3-3 4-3 2 3h2" /></>,
    bag:     <><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" /><path d="M3 6h18" /><path d="M16 10a4 4 0 01-8 0" /></>,
    img:     <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></>,
    chevron: <path d="M9 18l6-6-6-6" />,
    chevdown:<path d="M6 9l6 6 6-6" />,
    logout:  <><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>,
    shield:  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
    sparkle: <><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" /></>,
    target:  <><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></>,
    grid:    <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></>,
    edit:    <><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4z" /></>,
    mail:    <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M22 7l-10 6L2 7" /></>,
    key:     <><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3" /></>,
    moon:    <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />,
    sun:     <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></>,
    alert:   <><path d="M10.29 3.86 1.82 18a2 2 0 002.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>,
    thumb:   <path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3zM7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3" />,
    repeat:  <><polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 014-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 01-4 4H3" /></>
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
         strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={style}>
      {paths[name] || null}
    </svg>
  );
};

/* ── Estrellas ───────────────────────────────────────────────────── */
export function Stars({ value = 0, size = 14, color, onPick, gap = 2 }) {
  const T = useT();
  const c = color || T.ink;
  return (
    <div style={{ display: 'inline-flex', gap, alignItems: 'center' }}>
      {[1, 2, 3, 4, 5].map(n => (
        <span key={n}
          onClick={onPick ? (e) => { e.stopPropagation(); onPick(n); } : undefined}
          style={{ cursor: onPick ? 'pointer' : 'default', lineHeight: 0, display: 'inline-flex' }}>
          <svg width={size} height={size} viewBox="0 0 24 24"
               fill={n <= Math.round(value) ? c : 'none'} stroke={c} strokeWidth={1.4}
               strokeLinejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
        </span>
      ))}
    </div>
  );
}

/* ── Piezas base ─────────────────────────────────────────────────── */
export function Btn({ children, onClick, variant = 'primary', disabled, style, full = true }) {
  const T = useT();
  const base = {
    width: full ? '100%' : undefined, height: 48, borderRadius: 12, border: 'none',
    fontFamily: FONT, fontSize: 15, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1, display: 'flex', alignItems: 'center',
    justifyContent: 'center', gap: 8, transition: 'opacity .15s'
  };
  const kinds = {
    primary: { background: T.btnPrimary, color: T.btnPrimaryText },
    ghost:   { background: 'transparent', color: T.ink, border: `1px solid ${T.border}` },
    soft:    { background: T.softBg, color: T.ink, border: `1px solid ${T.softBorder}` }
  };
  return <button onClick={disabled ? undefined : onClick} disabled={disabled}
                 style={{ ...base, ...kinds[variant], ...style }}>{children}</button>;
}

export function Card({ children, style, onClick }) {
  const T = useT();
  return (
    <div onClick={onClick} style={{
      background: T.white, border: `1px solid ${T.border}`, borderRadius: 16,
      padding: 16, cursor: onClick ? 'pointer' : 'default', ...style
    }}>{children}</div>
  );
}

export function Pill({ children, active, onClick, style }) {
  const T = useT();
  return (
    <button onClick={onClick} style={{
      flexShrink: 0, background: active ? T.ink : 'transparent',
      color: active ? T.white : T.mid, border: `1px solid ${active ? T.ink : T.border}`,
      borderRadius: 9999, padding: '8px 15px', fontSize: 13, fontWeight: 700,
      fontFamily: FONT, cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all .15s', ...style
    }}>{children}</button>
  );
}

export function Empty({ icon = 'utensils', title, text }) {
  const T = useT();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
                  justifyContent: 'center', textAlign: 'center', padding: '56px 32px', gap: 12 }}>
      <Icon name={icon} size={38} color={T.silver} />
      <div style={{ fontSize: 16, fontWeight: 800, color: T.ink }}>{title}</div>
      {text && <div style={{ fontSize: 13, color: T.gray, lineHeight: 1.7, maxWidth: 280 }}>{text}</div>}
    </div>
  );
}

export function Spinner({ size = 20, color }) {
  const T = useT();
  return <div style={{
    width: size, height: size, border: `2px solid ${T.border}`,
    borderTopColor: color || T.ink, borderRadius: '50%',
    animation: 'spin .8s linear infinite', display: 'inline-block'
  }} />;
}

/* ── Barra de progreso de nivel ──────────────────────────────────── */
// `color`/`track` son obligatorios cuando la barra va DENTRO del panel de
// contraste: los defaults (T.ink sobre T.softBg) son tinta sobre tinta ahí, o
// sea una barra invisible — pasaba en los dos temas, no sólo en el oscuro.
export function XpBar({ xp, min, next, height = 6, color, track }) {
  const T = useT();
  // Sin siguiente nivel = nivel máximo: la barra va llena, no vacía.
  const pct = next == null ? 100
            : Math.max(0, Math.min(100, ((xp - min) / Math.max(next - min, 1)) * 100));
  return (
    <div style={{ width: '100%', height, background: track || T.softBg,
                  borderRadius: 9999, overflow: 'hidden' }}>
      <div style={{ width: pct + '%', height: '100%', background: color || T.ink, borderRadius: 9999,
                    transition: 'width .4s ease' }} />
    </div>
  );
}
