// ════════════════════════════════════════════════════════════════════
// MYTHOS — helper de formato guaraní (₲) reutilizable por todos los paneles.
// ────────────────────────────────────────────────────────────────────
// SOLO presentación y entrada. La base sigue guardando el ENTERO CRUDO
// (sin puntos, sin decimales). Pedido recurrente de Renato: los montos en
// guaraníes se muestran y se tipean con separador de miles con PUNTO
// (100.000, 1.500.000), nunca "100000" pelado.
//
// Uso:
//   import { formatGs, parseGs, GsInput } from '../shared/gs.jsx';
//   // display:  ₲ {formatGs(row.price)}   → "₲ 100.000"
//   // input:    <GsInput value={f.price} onChange={v => set('price', v)} />
//               //  v = string de dígitos crudos ("100000") o '' — listo para
//               //  guardar con Number(v)/parseInt sin tocar la base.
//
// NO usar en campos que no son dinero (mesas, días, %, IDs, cantidades chicas).
// Para montos con decimales (p. ej. USD) NO usar GsInput: es entero puro.
// ════════════════════════════════════════════════════════════════════
import React, { useRef, useCallback } from 'react';

// Deja solo dígitos y quita ceros a la izquierda (pero conserva un "0" solo).
function digitsOnly(value) {
  const d = String(value == null ? '' : value).replace(/[^\d]/g, '');
  if (d === '') return '';
  const trimmed = d.replace(/^0+(?=\d)/, '');
  return trimmed === '' ? '0' : trimmed;
}

// Inserta puntos de miles manualmente (independiente del locale del runtime).
function withThousands(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// ── formatGs(valor) → "100.000" ──────────────────────────────────────
// Acepta número o string (crudo o ya formateado). Sin símbolo, sin decimales.
// null / undefined / '' → '' (para que un input vacío muestre el placeholder).
export function formatGs(value) {
  const d = digitsOnly(value);
  if (d === '') return '';
  return withThousands(d);
}

// ── parseGs(valor) → "100000" ────────────────────────────────────────
// Quita puntos/símbolos y devuelve el entero crudo como string ('' si vacío).
export function parseGs(value) {
  return digitsOnly(value);
}

// ── <GsInput> — input de dinero en guaraníes ─────────────────────────
// Controlado: `value` es el entero crudo (número o string de dígitos) del
// estado del padre; `onChange(raw)` recibe el string de dígitos crudos SIN
// puntos ('' cuando se vacía). Muestra con puntos MIENTRAS se tipea, acepta
// solo dígitos, soporta pegar y borrar, y mantiene el cursor por posición de
// dígito. Es <input type="text" inputMode="numeric"> (type=number no permite
// mostrar puntos de miles). Cualquier prop extra (style, className, placeholder,
// disabled, id, name, onBlur, aria-*) se pasa al <input>.
export function GsInput({ value, onChange, ...rest }) {
  const ref = useRef(null);

  const handleChange = useCallback((e) => {
    const el = e.target;
    const before = el.value;
    const caret = el.selectionStart == null ? before.length : el.selectionStart;
    // Cuántos dígitos hay a la izquierda del cursor (para reubicarlo luego).
    const digitsBeforeCaret = before.slice(0, caret).replace(/[^\d]/g, '').length;

    const raw = digitsOnly(before);        // entero crudo, sin puntos
    const formatted = raw === '' ? '' : withThousands(raw);

    if (onChange) onChange(raw);

    // Reponer el valor formateado + cursor tras el re-render (o aun si el
    // estado no cambió, p. ej. al tipear un caracter no numérico).
    const restore = () => {
      const node = ref.current;
      if (!node) return;
      if (node.value !== formatted) node.value = formatted;
      let pos = 0;
      let seen = 0;
      const f = node.value;
      while (pos < f.length && seen < digitsBeforeCaret) {
        if (f.charCodeAt(pos) >= 48 && f.charCodeAt(pos) <= 57) seen++;
        pos++;
      }
      try { node.setSelectionRange(pos, pos); } catch (_) { /* input sin selección */ }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
    else restore();
  }, [onChange]);

  return (
    <input
      {...rest}
      ref={ref}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      value={formatGs(value)}
      onChange={handleChange}
    />
  );
}

// ════════════════════════════════════════════════════════════════════
// NumInput — input numérico general (NO guaraníes).
// ────────────────────────────────────────────────────────────────────
// Pedido recurrente de Renato: TODO número de magnitud (cantidades, stock,
// umbrales, límites) se tipea con separador de MILES con PUNTO (10.000) y sin
// el "0" pegado adelante que no se puede borrar. A diferencia de GsInput (entero
// puro), admite DECIMALES: display con miles-punto + decimal-coma (es-PY,
// "1.234,5"); el "raw" que va/vuelve al padre usa PUNTO decimal, JS-parseable
// con parseFloat ("1234.5", "10000", ""). maxDec = cantidad máx. de decimales
// (0 = entero). NO usar en identificadores (PIN/códigos/IDs): ahí el "0" inicial
// puede ser válido y el separador de miles estaría mal.
//
// Uso:
//   import { NumInput } from '../shared/gs.jsx';
//   <NumInput value={f.qty} onChange={v => set('qty', v)} decimals={3} />
// ════════════════════════════════════════════════════════════════════

// raw ("1234.5") → display "1.234,5". '' / null → '' (muestra placeholder).
export function formatNum(value, maxDec = 0) {
  const md = Number(maxDec) || 0;
  if (value === '' || value == null) return '';
  const s = String(value).replace(',', '.');
  const dot = s.indexOf('.');
  let intPart, decPart, hasDot;
  if (dot === -1 || md <= 0) {
    intPart = s.replace(/[^\d]/g, ''); decPart = ''; hasDot = false;
  } else {
    intPart = s.slice(0, dot).replace(/[^\d]/g, '');
    decPart = s.slice(dot + 1).replace(/[^\d]/g, '').slice(0, md);
    hasDot = true;
  }
  intPart = intPart.replace(/^0+(?=\d)/, '');           // sin ceros a la izquierda
  const intFmt = intPart === '' ? (hasDot ? '0' : '') : withThousands(intPart);
  if (md <= 0) return intFmt;
  if (!hasDot) return intFmt;
  return (intFmt === '' ? '0' : intFmt) + ',' + decPart;
}

// display ("1.234,5") → raw JS-parseable "1234.5". Quita miles, coma→punto,
// recorta a maxDec decimales, quita ceros a la izquierda.
function numDisplayToRaw(display, maxDec) {
  const md = Number(maxDec) || 0;
  let s = String(display == null ? '' : display);
  if (md <= 0) return s.replace(/[^\d]/g, '').replace(/^0+(?=\d)/, '');
  s = s.replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '');
  const dot = s.indexOf('.');
  if (dot === -1) return s.replace(/^0+(?=\d)/, '');
  let intP = s.slice(0, dot).replace(/[^\d]/g, '').replace(/^0+(?=\d)/, '');
  const decP = s.slice(dot + 1).replace(/[^\d]/g, '').slice(0, md);
  if (intP === '') intP = '0';
  return intP + '.' + decP;                              // puede quedar "10." al tipear
}

// parseNum(display) → raw string (para uso fuera del input si hace falta).
export function parseNum(value, maxDec = 0) {
  return numDisplayToRaw(value, maxDec);
}

// Cuenta caracteres "significativos" (dígitos + coma) a la izq. del cursor.
function numSigBefore(str, caret) {
  let n = 0;
  for (let k = 0; k < caret && k < str.length; k++) {
    const c = str.charCodeAt(k);
    if ((c >= 48 && c <= 57) || str[k] === ',') n++;
  }
  return n;
}

export function NumInput({ value, onChange, decimals = 0, ...rest }) {
  const ref = useRef(null);
  const md = Number(decimals) || 0;

  const commit = useCallback((displayStr, sigCount) => {
    const raw = numDisplayToRaw(displayStr, md);
    if (onChange) onChange(raw);
    const formatted = formatNum(raw, md);
    const restore = () => {
      const node = ref.current;
      if (!node) return;
      if (node.value !== formatted) node.value = formatted;
      let pos = 0, seen = 0;
      const f = node.value;
      while (pos < f.length && seen < sigCount) {
        const c = f.charCodeAt(pos);
        if ((c >= 48 && c <= 57) || f[pos] === ',') seen++;
        pos++;
      }
      try { node.setSelectionRange(pos, pos); } catch (_) { /* input sin selección */ }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
    else restore();
  }, [onChange, md]);

  const handleChange = useCallback((e) => {
    const el = e.target;
    const caret = el.selectionStart == null ? el.value.length : el.selectionStart;
    commit(el.value, numSigBefore(el.value, caret));
  }, [commit]);

  // Normaliza el separador decimal: tanto "." (numpad) como "," insertan una
  // sola coma. Sin esto, un "." tecleado se confundiría con los puntos de miles.
  const handleKeyDown = useCallback((e) => {
    if (rest.onKeyDown) rest.onKeyDown(e);
    if (md <= 0) return;
    if (e.key === '.' || e.key === ',') {
      e.preventDefault();
      const el = e.target;
      const val = el.value;
      if (val.includes(',')) return;                     // solo un decimal
      const start = el.selectionStart == null ? val.length : el.selectionStart;
      const end = el.selectionEnd == null ? val.length : el.selectionEnd;
      const next = val.slice(0, start) + ',' + val.slice(end);
      commit(next, numSigBefore(next, start + 1));
    }
  }, [commit, md, rest]);

  const { onKeyDown: _ignored, ...pass } = rest;
  return (
    <input
      {...pass}
      ref={ref}
      type="text"
      inputMode={md > 0 ? 'decimal' : 'numeric'}
      autoComplete="off"
      value={formatNum(value, md)}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
    />
  );
}
