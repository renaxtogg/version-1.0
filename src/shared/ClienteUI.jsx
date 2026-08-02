// ════════════════════════════════════════════════════════════════════
// MYTHOS — UI de clientes (CRM) reutilizable por TODOS los paneles.
// ────────────────────────────────────────────────────────────────────
// El alta de un cliente ocurre en cinco lugares distintos (Admin, Caja, Mozo,
// QR de mesa y Delivery). Si cada panel arma su propio formulario, en dos
// semanas hay cinco formularios que piden campos distintos y validan distinto
// —que es exactamente lo que pasó con los helpers de fecha—. Acá vive uno solo.
//
//   import { ClienteForm, ClienteModal, ClientePicker, TipoBadge, TiposManager }
//     from '../shared/ClienteUI.jsx';
//
// ESTILO: usa las variables de `design-system.css` (--surface, --border,
// --text-primary…), NO una paleta propia. Así hereda el tema claro/oscuro de
// cada panel sin que ninguno le pase colores.
//
// MODALES: cierre SOLO con ESC o la ✕ del header — nunca por click en el
// overlay (regla del proyecto: al seleccionar texto, el mouseup cae fuera y
// se perdía todo lo tipeado).
// ════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  emptyCustomer, validateCustomer, fullName, formatPhone, phoneKey,
  searchCustomers, createCustomer, updateCustomer, loadTypes,
  createType, updateType, deleteType, isMissingCrm, CRM_MISSING_MSG,
} from './clientes.js';

/* ── tokens locales (todos resuelven contra design-system.css) ── */
const S = {
  surface: 'var(--surface, #fff)',
  subtle:  'var(--bg-subtle, #F5F5F7)',
  border:  'var(--border, #D2D2D7)',
  ink:     'var(--text-primary, #1D1D1F)',
  mid:     'var(--text-secondary, #6E6E73)',
  dim:     'var(--text-tertiary, #86868B)',
  error:   'var(--error, #FF3B30)',
  inverse: 'var(--text-inverse, #fff)',
};

const inputSt = {
  width: '100%', padding: '10px 12px', border: `1px solid ${S.border}`,
  borderRadius: 10, fontSize: 14, fontFamily: 'inherit', outline: 'none',
  background: S.surface, color: S.ink, minHeight: 42,
};
const labelSt = { display: 'block', fontSize: 11, fontWeight: 700, color: S.mid, marginBottom: 5, letterSpacing: '.02em' };

function Field({ label, hint, required, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={labelSt}>
        {label}{required && <span style={{ color: S.error }}> *</span>}
        {hint && <span style={{ fontWeight: 500, color: S.dim, marginLeft: 6 }}>{hint}</span>}
      </label>
      {children}
    </div>
  );
}

/* ── Badge de tipo de cliente ────────────────────────────────────────
   El color de fondo es una excepción legítima al monocromo, igual que los
   badges de tipo de orden: identifica una categoría, no decora. */
export function TipoBadge({ type, onRemove, size = 'md' }) {
  if (!type) return null;
  const c = type.color || '#8E8E93';
  const sm = size === 'sm';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: sm ? '1px 7px' : '3px 9px', borderRadius: 999,
      fontSize: sm ? 10 : 11, fontWeight: 700, letterSpacing: '.02em',
      color: c, border: `1px solid ${c}`,
      background: `color-mix(in srgb, ${c} 12%, transparent)`,
      whiteSpace: 'nowrap',
    }}>
      {type.name}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Quitar ${type.name}`}
          style={{ background: 'none', border: 'none', color: c, cursor: 'pointer', padding: 0, fontSize: 13, lineHeight: 1 }}>×</button>
      )}
    </span>
  );
}

/* ── Selector múltiple de tipos ──────────────────────────────────── */
function TiposSelector({ types, value, onChange }) {
  const sel = new Set(value || []);
  if (!types || !types.length) {
    return <div style={{ fontSize: 12, color: S.dim }}>Este local todavía no tiene tipos de cliente configurados.</div>;
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
      {types.map(t => {
        const on = sel.has(t.id);
        const c = t.color || '#8E8E93';
        return (
          <button key={t.id} type="button"
            onClick={() => {
              const n = new Set(sel);
              n.has(t.id) ? n.delete(t.id) : n.add(t.id);
              onChange(Array.from(n));
            }}
            style={{
              padding: '6px 12px', borderRadius: 999, cursor: 'pointer',
              fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
              border: `1px solid ${on ? c : S.border}`,
              background: on ? c : 'transparent',
              color: on ? '#fff' : S.mid,
              transition: 'all 150ms ease',
            }}>
            {t.name}
          </button>
        );
      })}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   ClienteForm — el formulario completo de una ficha.
   `compact` (caja/mozo, con el local lleno): deja visibles solo nombre,
   apellido y teléfono; el resto vive detrás de "Más datos". Los campos son
   los mismos — lo que cambia es cuántos se ven de entrada.
   ════════════════════════════════════════════════════════════════════ */
export function ClienteForm({ value, onChange, types = [], compact = false, showTypes = true, autoFocus = true }) {
  const [open, setOpen] = useState(!compact);
  const f = value || emptyCustomer();
  const set = (k, v) => onChange({ ...f, [k]: v });
  const firstRef = useRef(null);
  useEffect(() => { if (autoFocus && firstRef.current) firstRef.current.focus(); }, [autoFocus]);

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="NOMBRE" required>
          <input ref={firstRef} style={inputSt} value={f.first_name || ''} autoComplete="given-name"
            onChange={e => set('first_name', e.target.value)} placeholder="Juan" />
        </Field>
        <Field label="APELLIDO">
          <input style={inputSt} value={f.last_name || ''} autoComplete="family-name"
            onChange={e => set('last_name', e.target.value)} placeholder="Pérez" />
        </Field>
      </div>

      <Field label="TELÉFONO" hint="identifica al cliente entre canales">
        <input style={inputSt} type="tel" value={f.phone || ''} autoComplete="tel"
          onChange={e => set('phone', e.target.value)} placeholder="0981 123 456" />
      </Field>

      {compact && !open && (
        <button type="button" onClick={() => setOpen(true)}
          style={{ background: 'none', border: 'none', color: S.mid, fontSize: 12, fontWeight: 700,
                   cursor: 'pointer', padding: '4px 0', fontFamily: 'inherit', textDecoration: 'underline' }}>
          Más datos (CI/RUC, dirección, tipo)
        </button>
      )}

      {open && (
        <>
          <Field label="CI / RUC" hint="opcional">
            <div style={{ display: 'flex', gap: 8 }}>
              <select style={{ ...inputSt, width: 90, flex: '0 0 90px' }} value={f.doc_type || 'ci'}
                onChange={e => set('doc_type', e.target.value)}>
                <option value="ci">CI</option>
                <option value="ruc">RUC</option>
              </select>
              <input style={inputSt} value={f.doc_number || ''} inputMode="numeric"
                onChange={e => set('doc_number', e.target.value)}
                placeholder={(f.doc_type || 'ci') === 'ruc' ? '80012345-6' : '1234567'} />
            </div>
          </Field>

          <Field label="CORREO" hint="opcional · para enviar la factura">
            <input style={inputSt} type="email" value={f.email || ''} autoComplete="email"
              onChange={e => set('email', e.target.value)} placeholder="juan@correo.com" />
          </Field>

          <Field label="DIRECCIÓN" hint="opcional">
            <input style={inputSt} value={f.address || ''} autoComplete="street-address"
              onChange={e => set('address', e.target.value)} placeholder="Av. España 1234" />
          </Field>

          <Field label="REFERENCIA" hint="opcional · casa de portón negro, esquina…">
            <input style={inputSt} value={f.address_reference || ''}
              onChange={e => set('address_reference', e.target.value)} placeholder="Entre Brasil y Perú" />
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="CUMPLEAÑOS" hint="opcional">
              <input style={inputSt} type="date" value={f.birth_date || ''}
                onChange={e => set('birth_date', e.target.value)} />
            </Field>
            <div />
          </div>

          <Field label="NOTAS" hint="opcional · alergias, preferencias, mesa favorita">
            <textarea style={{ ...inputSt, minHeight: 64, resize: 'vertical' }} value={f.notes || ''}
              onChange={e => set('notes', e.target.value)} placeholder="Sin sal. Siempre pide la mesa del fondo." />
          </Field>

          {showTypes && (
            <Field label="TIPO DE CLIENTE" hint="podés elegir más de uno">
              <TiposSelector types={types} value={f.type_ids} onChange={v => set('type_ids', v)} />
            </Field>
          )}
        </>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   ClienteModal — alta o edición completa, con guardado incluido.
   `onSaved(cliente)` recibe la ficha ya persistida.
   ════════════════════════════════════════════════════════════════════ */
export function ClienteModal({
  db, restaurantId, customer = null, types = [], source = 'admin', createdBy = null,
  prefill = null, compact = false, onClose, onSaved, title,
}) {
  const [form, setForm] = useState(() => customer
    ? { ...customer, birth_date: customer.birth_date || '', type_ids: customer.type_ids || [] }
    : emptyCustomer(prefill || {}));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // Cierre SOLO por ESC (además de la ✕). El overlay NO cierra: ver cabecera.
  useEffect(() => {
    const h = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  async function save() {
    const v = validateCustomer(form);
    if (!v.ok) { setErr(v.error); return; }
    setSaving(true); setErr('');
    const r = customer
      ? await updateCustomer(db, customer.id, form)
      : await createCustomer(db, restaurantId, form, { source, createdBy });
    setSaving(false);
    if (r.error) { setErr(isMissingCrm(r.error) ? CRM_MISSING_MSG : (r.error.message || 'No se pudo guardar')); return; }
    onSaved(r.customer, { existed: !!r.existed });
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', backdropFilter: 'blur(4px)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 4000, padding: 16 }}>
      <div style={{ background: S.surface, borderRadius: 18, width: '100%', maxWidth: 520,
                    maxHeight: '92vh', overflowY: 'auto', padding: 24, boxShadow: '0 8px 32px rgba(0,0,0,.22)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 19, fontWeight: 800, color: S.ink }}>
              {title || (customer ? 'Editar cliente' : 'Nuevo cliente')}
            </div>
            {!customer && <div style={{ fontSize: 11.5, color: S.dim, marginTop: 2 }}>Solo el nombre es obligatorio.</div>}
          </div>
          <button onClick={onClose} aria-label="Cerrar"
            style={{ background: 'none', border: 'none', fontSize: 24, lineHeight: 1, color: S.mid, cursor: 'pointer', padding: 4 }}>×</button>
        </div>

        <ClienteForm value={form} onChange={setForm} types={types} compact={compact} />

        {err && (
          <div style={{ background: 'color-mix(in srgb, var(--error) 10%, transparent)', border: `1px solid ${S.error}`,
                        color: S.error, borderRadius: 10, padding: '9px 12px', fontSize: 12.5, margin: '4px 0 12px' }}>
            {err}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} disabled={saving}
            style={{ padding: '11px 18px', borderRadius: 10, border: `1px solid ${S.border}`, background: 'transparent',
                     color: S.ink, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
            Cancelar
          </button>
          <button onClick={save} disabled={saving}
            style={{ padding: '11px 20px', borderRadius: 10, border: 'none', background: S.ink, color: S.surface,
                     fontSize: 14, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer',
                     opacity: saving ? .5 : 1, fontFamily: 'inherit' }}>
            {saving ? 'Guardando…' : (customer ? 'Guardar cambios' : 'Crear cliente')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   ClientePicker — buscar un cliente existente o crear uno al vuelo.
   Pensado para el mostrador: se escribe el teléfono o el nombre, aparecen
   coincidencias, y si no existe se crea sin salir de la pantalla de cobro.
   `value` = ficha seleccionada (o null). `onChange(ficha|null)`.
   ════════════════════════════════════════════════════════════════════ */
export function ClientePicker({
  db, restaurantId, value, onChange, types = [], source = 'caja', createdBy = null,
  label = 'CLIENTE', placeholder = 'Buscar por nombre o teléfono…', compact = true, disabled = false,
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(null);   // null | {prefill}
  const [missing, setMissing] = useState(false);
  const boxRef = useRef(null);
  const timerRef = useRef(null);

  // Debounce: el picker se usa tipeando rápido en el mostrador; una query por
  // tecla satura PostgREST sin mejorar nada.
  useEffect(() => {
    if (!open) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      const { customers, error } = await searchCustomers(db, restaurantId, term);
      setLoading(false);
      if (error) { setMissing(isMissingCrm(error)); setResults([]); return; }
      setMissing(false); setResults(customers);
    }, 220);
    return () => clearTimeout(timerRef.current);
  }, [term, open, db, restaurantId]);

  // Cerrar el desplegable al hacer click afuera (no es un modal de edición:
  // acá no hay datos que perder, así que el click-fuera sí corresponde).
  useEffect(() => {
    if (!open) return;
    const h = e => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const pick = useCallback(c => { onChange(c); setOpen(false); setTerm(''); }, [onChange]);

  // Lo tipeado se aprovecha como prefill: si son dígitos es el teléfono,
  // si son letras es el nombre. Nadie quiere retipear lo que ya escribió.
  function openNew() {
    const digits = term.replace(/\D/g, '');
    const pre = digits.length >= 5 ? { phone: term.trim() } : {};
    if (digits.length < 5 && term.trim()) {
      const parts = term.trim().split(/\s+/);
      pre.first_name = parts[0];
      if (parts.length > 1) pre.last_name = parts.slice(1).join(' ');
    }
    setModal({ prefill: pre });
    setOpen(false);
  }

  if (value) {
    return (
      <div>
        {label && <label style={labelSt}>{label}</label>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                      border: `1px solid ${S.border}`, borderRadius: 10, background: S.subtle }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: S.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {fullName(value)}
            </div>
            <div style={{ fontSize: 11.5, color: S.mid }}>
              {value.phone ? formatPhone(value.phone) : 'Sin teléfono'}
              {value.doc_number ? ` · ${(value.doc_type || 'ci').toUpperCase()} ${value.doc_number}` : ''}
            </div>
          </div>
          {!disabled && (
            <button type="button" onClick={() => onChange(null)}
              style={{ background: 'none', border: `1px solid ${S.border}`, borderRadius: 8, padding: '5px 10px',
                       fontSize: 11.5, fontWeight: 700, color: S.mid, cursor: 'pointer', fontFamily: 'inherit' }}>
              Cambiar
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      {label && <label style={labelSt}>{label}</label>}
      <input style={inputSt} value={term} disabled={disabled} placeholder={placeholder}
        onChange={e => { setTerm(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)} />

      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 60, marginTop: 4,
                      background: S.surface, border: `1px solid ${S.border}`, borderRadius: 12,
                      boxShadow: '0 8px 28px rgba(0,0,0,.14)', maxHeight: 280, overflowY: 'auto' }}>
          {missing && (
            <div style={{ padding: '12px 14px', fontSize: 12, color: S.error }}>{CRM_MISSING_MSG}</div>
          )}
          {!missing && loading && (
            <div style={{ padding: '12px 14px', fontSize: 12.5, color: S.dim }}>Buscando…</div>
          )}
          {!missing && !loading && results.map(c => (
            <button key={c.id} type="button" onClick={() => pick(c)}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px', background: 'none',
                       border: 'none', borderBottom: `1px solid ${S.subtle}`, cursor: 'pointer', fontFamily: 'inherit' }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: S.ink }}>{fullName(c)}</div>
              <div style={{ fontSize: 11.5, color: S.mid }}>
                {c.phone ? formatPhone(c.phone) : 'Sin teléfono'}
                {c.doc_number ? ` · ${(c.doc_type || 'ci').toUpperCase()} ${c.doc_number}` : ''}
              </div>
            </button>
          ))}
          {!missing && !loading && !results.length && (
            <div style={{ padding: '12px 14px', fontSize: 12.5, color: S.dim }}>
              {term.trim() ? 'Ningún cliente coincide.' : 'Escribí un nombre o un teléfono.'}
            </div>
          )}
          {!missing && (
            <button type="button" onClick={openNew}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '11px 14px', background: S.subtle,
                       border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, color: S.ink, fontFamily: 'inherit' }}>
              + Registrar cliente nuevo
            </button>
          )}
        </div>
      )}

      {modal && (
        <ClienteModal db={db} restaurantId={restaurantId} types={types} source={source} createdBy={createdBy}
          prefill={modal.prefill} compact={compact}
          onClose={() => setModal(null)}
          onSaved={c => { setModal(null); pick(c); }} />
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   TiposManager — ABM del catálogo de tipos del local (Admin).
   ════════════════════════════════════════════════════════════════════ */
const PALETTE = ['#8E8E93', '#34C759', '#FF9500', '#007AFF', '#AF52DE', '#FF3B30', '#5AC8FA', '#FFCC00'];

export function TiposManager({ db, restaurantId, types, onChange, onToast }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(PALETTE[0]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);   // {id,name,color}

  const say = (m, ok = true) => { if (onToast) onToast(m, ok); };

  async function add() {
    const n = name.trim();
    if (!n) return;
    if (types.some(t => t.name.trim().toLowerCase() === n.toLowerCase())) { say('Ya existe un tipo con ese nombre', false); return; }
    setBusy(true);
    const { type, error } = await createType(db, restaurantId, { name: n, color, sort_order: 100 + types.length });
    setBusy(false);
    if (error) { say(isMissingCrm(error) ? CRM_MISSING_MSG : (error.message || 'No se pudo crear'), false); return; }
    setName(''); setColor(PALETTE[0]);
    onChange([...types, type]);
    say('Tipo creado');
  }

  async function saveEdit() {
    if (!editing) return;
    const n = (editing.name || '').trim();
    if (!n) return;
    setBusy(true);
    const { type, error } = await updateType(db, editing.id, { name: n, color: editing.color });
    setBusy(false);
    if (error) { say(error.message || 'No se pudo guardar', false); return; }
    onChange(types.map(t => (t.id === type.id ? type : t)));
    setEditing(null);
    say('Tipo actualizado');
  }

  async function remove(t) {
    if (!window.confirm(`¿Eliminar el tipo "${t.name}"? Los clientes que lo tengan simplemente dejan de tenerlo — ninguna ficha se borra.`)) return;
    setBusy(true);
    const { error } = await deleteType(db, t.id);
    setBusy(false);
    if (error) { say(error.message || 'No se pudo eliminar', false); return; }
    onChange(types.filter(x => x.id !== t.id));
    say('Tipo eliminado');
  }

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        {types.map(t => (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
                                   border: `1px solid ${S.border}`, borderRadius: 999 }}>
            <span style={{ width: 10, height: 10, borderRadius: 5, background: t.color || '#8E8E93', flexShrink: 0 }} />
            <span style={{ fontSize: 12.5, fontWeight: 700, color: S.ink }}>{t.name}</span>
            <button type="button" onClick={() => setEditing({ id: t.id, name: t.name, color: t.color || '#8E8E93' })}
              style={{ background: 'none', border: 'none', color: S.mid, fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>editar</button>
            <button type="button" onClick={() => remove(t)}
              style={{ background: 'none', border: 'none', color: S.error, fontSize: 15, lineHeight: 1, cursor: 'pointer', padding: 0 }}
              aria-label={`Eliminar ${t.name}`}>×</button>
          </div>
        ))}
        {!types.length && <div style={{ fontSize: 12.5, color: S.dim }}>Todavía no hay tipos configurados.</div>}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 180px', minWidth: 160 }}>
          <label style={labelSt}>NUEVO TIPO</label>
          <input style={inputSt} value={editing ? editing.name : name} placeholder="Ej.: Cumpleañero del mes"
            onChange={e => (editing ? setEditing({ ...editing, name: e.target.value }) : setName(e.target.value))} />
        </div>
        <div>
          <label style={labelSt}>COLOR</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {PALETTE.map(p => {
              const active = (editing ? editing.color : color) === p;
              return (
                <button key={p} type="button"
                  onClick={() => (editing ? setEditing({ ...editing, color: p }) : setColor(p))}
                  aria-label={`Color ${p}`}
                  style={{ width: 26, height: 26, borderRadius: 13, background: p, cursor: 'pointer',
                           border: active ? `2px solid ${S.ink}` : `1px solid ${S.border}` }} />
              );
            })}
          </div>
        </div>
        <button type="button" onClick={editing ? saveEdit : add} disabled={busy}
          style={{ padding: '11px 18px', borderRadius: 10, border: 'none', background: S.ink, color: S.surface,
                   fontSize: 13.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: busy ? .5 : 1 }}>
          {editing ? 'Guardar' : 'Agregar'}
        </button>
        {editing && (
          <button type="button" onClick={() => setEditing(null)}
            style={{ padding: '11px 14px', borderRadius: 10, border: `1px solid ${S.border}`, background: 'transparent',
                     color: S.mid, fontSize: 13.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Hook: catálogo de tipos del local ───────────────────────────────
   Lo usan Admin, Caja y Mozo. Devuelve [] y `missing` si la mig 196 no está,
   para que el panel avise en vez de romperse. */
export function useCustomerTypes(db, restaurantId) {
  const [types, setTypes] = useState([]);
  const [missing, setMissing] = useState(false);
  const reload = useCallback(async () => {
    if (!db || !restaurantId) return;
    const { types: t, error } = await loadTypes(db, restaurantId);
    if (error) { setMissing(isMissingCrm(error)); setTypes([]); return; }
    setMissing(false); setTypes(t);
  }, [db, restaurantId]);
  useEffect(() => { reload(); }, [reload]);
  return { types, setTypes, missing, reloadTypes: reload };
}

/* Etiquetas de tipos de una ficha, para las tablas. */
export function TipoBadges({ typeIds, types, size = 'sm' }) {
  if (!typeIds || !typeIds.length || !types || !types.length) return null;
  const byId = new Map(types.map(t => [t.id, t]));
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {typeIds.map(id => byId.get(id)).filter(Boolean).map(t => <TipoBadge key={t.id} type={t} size={size} />)}
    </span>
  );
}

export { phoneKey, fullName, formatPhone };
