// ════════════════════════════════════════════════════════════════════
// MYTHOS — FASE D2 · Comprobante de pago (foto) + validación del cobro.
// ────────────────────────────────────────────────────────────────────
// Reutilizable por los paneles de staff (caja / mozo / admin). Todo
// STAFF-SIDE (rol authenticated, tenant-scoped mig 086) porque el cliente
// anon no escribe orders/Storage (lockdown migs 102/129/132). Requiere la
// migración 182 (columnas payment_proof_url / payment_review_* + tabla
// payment_reviews). Fail-open: si la mig no está, no rompe el cobro.
//
//   import { ComprobanteUploader, recordPaymentReview, reviewMeta,
//            uploadComprobante } from '../shared/comprobante.jsx';
// ════════════════════════════════════════════════════════════════════
import React, { useRef, useState, useEffect } from 'react';

// Comprime a WebP (máx 1400px, calidad 0.82) — mismo criterio que el
// ImageUploader del admin; el bucket restaurant-images solo acepta imágenes.
function _compress(file) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const max = 1400;
      let { width: w, height: h } = img;
      if (w > max || h > max) { const s = Math.min(max / w, max / h); w = Math.round(w * s); h = Math.round(h * s); }
      const cvs = document.createElement('canvas');
      cvs.width = w; cvs.height = h;
      cvs.getContext('2d').drawImage(img, 0, 0, w, h);
      cvs.toBlob(b => resolve(b), 'image/webp', 0.82);
    };
    img.onerror = () => resolve(null);
    img.src = URL.createObjectURL(file);
  });
}

// Sube la foto del comprobante al bucket PRIVADO `comprobantes` bajo la carpeta
// del restaurante (path `<rid>/<ts>.webp`) — mig 183 (anon INSERT / staff SELECT
// tenant-scoped). Devuelve el PATH (no URL): el bucket es privado, se ve con URL
// firmada temporal (ver resolveProofUrl). Lanza el error si falla.
// `subfolder` (opcional) agrupa dentro de la carpeta del restaurante sin cambiar
// las policies: éstas miran SOLO foldername[1] (= restaurantId). Lo usa el cobro
// de la suscripción (mig 194) con 'subs' para no mezclar los comprobantes que el
// restaurante le paga a MYTHOS con los que sus clientes le pagan a él.
const PROOF_BUCKET = 'comprobantes';
export async function uploadComprobante(db, restaurantId, file, subfolder) {
  if (!db) throw new Error('Sin conexión a la base de datos');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Usá una foto JPG, PNG o WebP');
  if (file.size > 5 * 1024 * 1024) throw new Error('La imagen supera los 5 MB');
  const blob = await _compress(file);
  if (!blob) throw new Error('No se pudo procesar la imagen');
  const dir = subfolder ? `${restaurantId}/${String(subfolder).replace(/[^a-z0-9_-]/gi, '')}` : String(restaurantId);
  const path = `${dir}/${Date.now()}_${Math.random().toString(36).slice(2)}.webp`;
  const { error } = await db.storage.from(PROOF_BUCKET).upload(path, blob, { contentType: 'image/webp', upsert: false });
  if (error) throw error;
  return path; // el path se guarda en orders.payment_proof_url
}

// Resuelve un valor de payment_proof_url a una URL visible:
//   • URL http(s) → se devuelve tal cual (comprobantes viejos en bucket público).
//   • path del bucket privado → URL firmada temporal (60 min) para el staff.
// Devuelve null si no se puede (mig 183 sin aplicar / sin permiso).
export async function resolveProofUrl(db, value) {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (!db) return null;
  try {
    const { data, error } = await db.storage.from(PROOF_BUCKET).createSignedUrl(value, 3600);
    if (error) return null;
    return data && data.signedUrl;
  } catch (_) { return null; }
}

// Miniatura async del comprobante (resuelve la URL firmada). Placeholder 🧾 mientras
// resuelve o si el archivo ya no está (purgado a los 31 días → onError lo oculta).
export function ProofImage({ db, value, size = 54, style, alt = 'comprobante' }) {
  const [url, setUrl] = useState(null);
  useEffect(() => { let m = true; resolveProofUrl(db, value).then(u => { if (m) setUrl(u); }); return () => { m = false; }; }, [value]);
  if (!value) return null;
  const base = { width: size, height: size, borderRadius: 8, border: '1px solid var(--border,#e2e2e6)', flexShrink: 0, ...style };
  if (!url) return <div style={{ ...base, background: 'var(--bg-subtle,#f2f2f4)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: size > 40 ? 18 : 12 }}>🧾</div>;
  return <a href={url} target="_blank" rel="noreferrer" style={{ lineHeight: 0, flexShrink: 0 }}><img src={url} alt={alt} style={{ ...base, objectFit: 'cover' }} onError={e => { e.target.style.display = 'none'; }} /></a>;
}

// Uploader compacto y neutral (styling con tokens del design-system, presentes
// en todos los paneles). value = URL actual, onChange(url|''), onMsg(text,ok).
export function ComprobanteUploader({ db, restaurantId, value, onChange, onMsg, label = 'FOTO DEL COMPROBANTE (OPCIONAL)', subfolder }) {
  const ref = useRef();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState('');   // objectURL local (el bucket es privado, no hay URL directa)
  async function handle(file) {
    if (!file) return;
    setBusy(true);
    try {
      const path = await uploadComprobante(db, restaurantId, file, subfolder);
      try { setPreview(URL.createObjectURL(file)); } catch (_) {}
      onChange(path);
      onMsg && onMsg('Comprobante adjuntado', true);
    } catch (e) {
      const hint = /Bucket not found/i.test(e.message || '') ? 'Falta el bucket comprobantes (aplicá la mig 183)' : (e.message || 'Error al subir');
      onMsg && onMsg('No se pudo subir: ' + hint, false);
    }
    setBusy(false);
  }
  const box = { border: '1px solid var(--border,#e2e2e6)', background: 'var(--bg-subtle,#f7f7f8)', color: 'var(--text-mid,#6e6e73)' };
  const hasProof = !!(value || preview);
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: 'var(--text-mid,#6e6e73)', marginBottom: 6 }}>{label}</div>
      {hasProof ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {preview
            ? <img src={preview} alt="comprobante" style={{ width: 54, height: 54, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border,#e2e2e6)', flexShrink: 0 }} />
            : <ProofImage db={db} value={value} size={54} />}
          <button type="button" onClick={() => ref.current.click()} disabled={busy} style={{ ...box, padding: '5px 10px', fontSize: 11, fontWeight: 600, borderRadius: 6, cursor: 'pointer' }}>{busy ? 'Subiendo…' : 'Cambiar'}</button>
          <button type="button" onClick={() => { onChange(''); setPreview(''); }} style={{ padding: '5px 10px', fontSize: 11, fontWeight: 600, borderRadius: 6, cursor: 'pointer', border: '1px solid rgba(239,68,68,0.3)', background: 'transparent', color: '#EF4444' }}>Quitar</button>
        </div>
      ) : (
        <button type="button" onClick={() => ref.current.click()} disabled={busy} style={{ ...box, padding: '9px 14px', fontSize: 12, fontWeight: 600, borderRadius: 8, cursor: 'pointer', width: '100%' }}>
          {busy ? 'Subiendo…' : '📷  Adjuntar foto del comprobante'}
        </button>
      )}
      <input ref={ref} type="file" accept=".jpg,.jpeg,.png,.webp" style={{ display: 'none' }} onChange={e => { const f = e.target.files[0]; e.target.value = ''; handle(f); }} />
    </div>
  );
}

// Metadatos visuales del estado de validación del pago.
export function reviewMeta(status) {
  if (status === 'approved') return { label: 'Pago verificado', color: '#34C759', short: 'Verificado' };
  if (status === 'rejected') return { label: 'Pago rechazado', color: '#FF3B30', short: 'Rechazado' };
  if (status === 'pending')  return { label: 'Esperando validación', color: '#FF9500', short: 'Pendiente' };
  return null;
}

// Registra una validación: actualiza el estado en orders + deja bitácora
// inmutable en payment_reviews (Módulo 11). Fail-open: si la mig 182 no está,
// devuelve { applied:false, error } y NO rompe (el caller avisa).
// action = 'approved' | 'rejected' | 'proof_added'.
export async function recordPaymentReview(db, { restaurantId, orderId, action, note, reviewerId, reviewerName }) {
  if (!db) return { applied: false, error: 'Sin conexión' };
  if (!reviewerId || !reviewerName) {
    // Nombre del revisor: usar el display_name del metadata de Auth, NUNCA el email.
    // Para el staff (mozo/caja) el email es el sintético `${cedula}@mythos.internal`,
    // que ensuciaría la bitácora inmutable payment_reviews.reviewer_name.
    try {
      const { data } = await db.auth.getUser();
      if (data && data.user) {
        reviewerId = reviewerId || data.user.id;
        const md = data.user.user_metadata || {};
        reviewerName = reviewerName || md.display_name || md.username || 'Staff';
      }
    } catch (_) {}
  }
  let applied = true, error = null;
  if (action === 'approved' || action === 'rejected') {
    const upd = { payment_review_status: action, payment_reviewed_at: new Date().toISOString(), payment_review_note: note || null };
    if (reviewerId) upd.payment_reviewed_by = reviewerId;
    const res = await db.from('orders').update(upd).eq('id', orderId).select('id');
    if (res.error) { applied = false; error = res.error.message; }
  }
  // Bitácora (independiente; la tabla puede no existir aún → se ignora el error).
  try { await db.from('payment_reviews').insert({ restaurant_id: restaurantId, order_id: orderId, action, note: note || null, reviewer_id: reviewerId || null, reviewer_name: reviewerName || null }); } catch (_) {}
  return { applied, error };
}
