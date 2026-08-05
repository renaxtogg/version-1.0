// ════════════════════════════════════════════════════════════════════
// MYTHOS — "Mis datos": lo que el comensal cargó UNA vez en su dispositivo.
// ────────────────────────────────────────────────────────────────────
// POR QUÉ EXISTE ESTE MÓDULO
//   El menú QR y el panel de delivery le piden a la misma persona exactamente
//   los mismos datos —nombre, apellido, teléfono, CI/RUC, correo, dirección— y
//   los guardaban en lugares distintos:
//     · el QR, en `mythos_mis_datos`, clave GLOBAL → le servía en cualquier local;
//     · el delivery, en `<restaurant_id>:dc_customer`, clave POR LOCAL → el mismo
//       comensal escribía todo de cero en cada local nuevo al que pedía, y lo que
//       había cargado por QR no le servía para el delivery ni al revés.
//   Acá vive la copia GLOBAL, que es la correcta: los datos son de la PERSONA, no
//   de su relación con un restaurante. Ver docs/audits/datos-una-sola-vez.md (B6).
//
// QUÉ NO ES
//   No reemplaza a `customers` (la ficha del local, mig 196) ni a `diners` (la
//   identidad de la app, mig 200). Es sólo comodidad de tipeo en el dispositivo:
//   el comensal del QR/delivery es `anon` y no tiene sesión donde guardar nada.
//   La ficha real la escribe la RPC `upsert_customer_self` con estos mismos datos.
//
// FORMATO CANÓNICO (el del QR, que ya era global)
//   { first_name, last_name, phone, doc_type, doc_number, email, address,
//     address_reference }
//   El delivery usa otros nombres para lo mismo (`name`/`references`), así que
//   convierte con fromDelivery()/toDelivery() en vez de guardar un tercer formato.
// ════════════════════════════════════════════════════════════════════

/** Clave de localStorage. Se exporta para que nadie la repita como string suelto. */
export const LS_KEY = 'mythos_mis_datos';

const CAMPOS = ['first_name', 'last_name', 'phone', 'doc_type', 'doc_number',
                'email', 'address', 'address_reference'];

/** Lee "Mis datos" del dispositivo. Nunca lanza: sin storage devuelve {}. */
export function leerMisDatos() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return (raw && typeof raw === 'object') ? raw : {};
  } catch (_) { return {}; }
}

/**
 * Guarda (mezclando con lo que ya había) los campos que vengan con valor.
 * Mezcla y no reemplaza a propósito: el delivery no pregunta el correo y el QR no
 * pregunta la referencia de la dirección — si cada uno escribiera el objeto entero,
 * el último en guardar le borraría a la persona lo que había cargado en el otro.
 * Un campo sólo se pisa con un valor no vacío.
 */
export function guardarMisDatos(patch) {
  if (!patch) return leerMisDatos();
  const prev = leerMisDatos();
  const next = { ...prev };
  CAMPOS.forEach(k => {
    const v = patch[k];
    if (typeof v === 'string' && v.trim()) next[k] = v.trim();
  });
  try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch (_) {}
  return next;
}

/**
 * Combina varias fuentes de datos dando prioridad a las últimas, pero **sin que un
 * campo vacío pise uno que tiene valor**. Es la regla de toda esta capa: un dato ya
 * cargado no se pierde porque otra pantalla no lo pregunte.
 * Ejemplo del bug que evita: el comensal cargó su apellido por QR; el formulario de
 * delivery de un pedido viejo lo tenía vacío; un spread normal se lo borraba.
 */
export function combinar(...fuentes) {
  const out = {};
  fuentes.forEach(f => {
    if (!f) return;
    Object.keys(f).forEach(k => {
      const v = f[k];
      if (v != null && String(v).trim() !== '') out[k] = v;
    });
  });
  return out;
}

/** Nombre completo tal como lo muestran los formularios. */
export function nombreCompleto(d) {
  if (!d) return '';
  return `${(d.first_name || '').trim()} ${(d.last_name || '').trim()}`.trim();
}

// ── Conversión al formato del panel de delivery ──────────────────────
// `customerData` del delivery usa `name` (nombre de pila) y `references`, y
// además lleva datos de la UBICACIÓN del pedido en curso (detail, corner, lat,
// lng) que NO son "mis datos": son de ese envío puntual y no se comparten entre
// locales — la casa es la misma, pero el pin y la esquina los confirma cada vez.

/** {name, last_name, phone, …} del delivery → formato canónico. */
export function fromDelivery(cd) {
  if (!cd) return {};
  return {
    first_name: cd.name || '',
    last_name: cd.last_name || '',
    phone: cd.phone || '',
    doc_type: cd.doc_type || '',
    doc_number: cd.doc_number || '',
    email: cd.email || '',
    address: cd.address || '',
    address_reference: cd.references || '',
  };
}

/** Formato canónico → los campos del formulario de delivery que corresponda. */
export function toDelivery(d) {
  const s = d || {};
  return {
    name: s.first_name || '',
    last_name: s.last_name || '',
    phone: s.phone || '',
    doc_type: s.doc_type || 'ci',
    doc_number: s.doc_number || '',
    address: s.address || '',
    references: s.address_reference || '',
  };
}
