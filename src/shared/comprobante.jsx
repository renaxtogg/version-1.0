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
import React, { useRef, useState } from 'react';

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

// Sube la foto del comprobante al bucket restaurant-images bajo la carpeta
// del restaurante (path `<rid>/comprobantes/...`) — mismo tenant-scoping que
// portada/logo/QR (mig 165). Devuelve la URL pública o lanza el error.
export async function uploadComprobante(db, restaurantId, file) {
  if (!db) throw new Error('Sin conexión a la base de datos');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Usá una foto JPG, PNG o WebP');
  if (file.size > 5 * 1024 * 1024) throw new Error('La imagen supera los 5 MB');
  const blob = await _compress(file);
  if (!blob) throw new Error('No se pudo procesar la imagen');
  const path = `${restaurantId}/comprobantes/${Date.now()}_${Math.random().toString(36).slice(2)}.webp`;
  const { error } = await db.storage.from('restaurant-images').upload(path, blob, { contentType: 'image/webp', upsert: false });
  if (error) throw error;
  const { data } = db.storage.from('restaurant-images').getPublicUrl(path);
  return data.publicUrl;
}

// Uploader compacto y neutral (styling con tokens del design-system, presentes
// en todos los paneles). value = URL actual, onChange(url|''), onMsg(text,ok).
export function ComprobanteUploader({ db, restaurantId, value, onChange, onMsg, label = 'FOTO DEL COMPROBANTE (OPCIONAL)' }) {
  const ref = useRef();
  const [busy, setBusy] = useState(false);
  async function handle(file) {
    if (!file) return;
    setBusy(true);
    try {
      const url = await uploadComprobante(db, restaurantId, file);
      onChange(url);
      onMsg && onMsg('Comprobante adjuntado', true);
    } catch (e) {
      const hint = /Bucket not found/i.test(e.message || '') ? 'Falta el bucket restaurant-images (mig 015/165)' : (e.message || 'Error al subir');
      onMsg && onMsg('No se pudo subir: ' + hint, false);
    }
    setBusy(false);
  }
  const box = { border: '1px solid var(--border,#e2e2e6)', background: 'var(--bg-subtle,#f7f7f8)', color: 'var(--text-mid,#6e6e73)' };
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: 'var(--text-mid,#6e6e73)', marginBottom: 6 }}>{label}</div>
      {value ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <a href={value} target="_blank" rel="noreferrer" style={{ flexShrink: 0 }}>
            <img src={value} alt="comprobante" style={{ width: 54, height: 54, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border,#e2e2e6)' }} onError={e => { e.target.style.display = 'none'; }} />
          </a>
          <button type="button" onClick={() => ref.current.click()} disabled={busy} style={{ ...box, padding: '5px 10px', fontSize: 11, fontWeight: 600, borderRadius: 6, cursor: 'pointer' }}>{busy ? 'Subiendo…' : 'Cambiar'}</button>
          <button type="button" onClick={() => onChange('')} style={{ padding: '5px 10px', fontSize: 11, fontWeight: 600, borderRadius: 6, cursor: 'pointer', border: '1px solid rgba(239,68,68,0.3)', background: 'transparent', color: '#EF4444' }}>Quitar</button>
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
    try { const { data } = await db.auth.getUser(); if (data && data.user) { reviewerId = reviewerId || data.user.id; reviewerName = reviewerName || data.user.email; } } catch (_) {}
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
