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
