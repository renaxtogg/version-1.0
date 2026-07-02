// ════════════════════════════════════════════════════════════════════
// PR-FE-2 · Consultar el estado de un DE (confirmar aprobación) — SANDBOX.
// ────────────────────────────────────────────────────────────────────
//   POST /api/facturasend/estado
//   body/query: { restaurant_id, cdc? , order_id? }   (uno de cdc | order_id)
//   Header:     Authorization: Bearer $FACTURASEND_EMIT_SECRET
//
// Consulta FacturaSend (POST {tenant}/de/estado por CDC) y ACTUALIZA la fila de
// documentos_electronicos con el estado resuelto (APROBADO/RECHAZADO/...) + el
// motivo. Sirve para los documentos que quedaron ENVIADO (pendientes) tras
// /emitir: se puede llamar con backoff hasta que sea final.
//
// Mismo gate FAIL-CLOSED que /emitir (FACTURASEND_EMIT_SECRET) + rate-limit.
// La api_key nunca se devuelve ni se loguea. Errores VISIBLES.
// ════════════════════════════════════════════════════════════════════
import { getFiscalConfig, getDocumentoByOrder, getDocumentoByCdc, updateDocumentoById } from './_db.js';
import { providerFromConfig } from './_provider.js';
import { mapSituacionToEstado } from './_de_builder.js';
import { checkRateLimit } from '../_ratelimit.js';

const TIPO_FACTURA = 1;

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (await checkRateLimit(req, res, { key: 'fs-estado', max: 60, windowSec: 60 })) return;

  const secret = process.env.FACTURASEND_EMIT_SECRET;
  if (!secret) {
    return res.status(403).json({ error: 'Consulta deshabilitada: seteá FACTURASEND_EMIT_SECRET para habilitarla' });
  }
  if (req.headers['authorization'] !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const q = req.query || {};
  const b = req.body || {};
  const restaurantId = q.restaurant_id || q.r || b.restaurant_id || null;
  let cdc = q.cdc || b.cdc || null;
  const orderId = q.order_id || b.order_id || null;

  if (!restaurantId) return res.status(400).json({ error: 'Falta restaurant_id' });
  if (!cdc && !orderId) return res.status(400).json({ error: 'Falta cdc u order_id' });

  try {
    // Ubicar la fila local (por order_id o por cdc) para saber a quién actualizar.
    let doc = null;
    if (orderId) {
      doc = await getDocumentoByOrder(restaurantId, orderId, TIPO_FACTURA);
      if (doc && doc.cdc && !cdc) cdc = doc.cdc;
    } else if (cdc) {
      doc = await getDocumentoByCdc(restaurantId, cdc);
    }
    if (!cdc) {
      return res.status(404).json({ ok: false, error: 'no hay CDC para consultar (el DE aún no se emitió)' , documento: doc });
    }

    const cfg = await getFiscalConfig(restaurantId);
    if (!cfg) return res.status(502).json({ ok: false, error: `fiscal_config: sin configuración para restaurant_id=${restaurantId}` });
    const provider = providerFromConfig(cfg);

    const r = await provider.consultarEstado([cdc]);
    const d = r && r.body && Array.isArray(r.body.deList) ? r.body.deList[0] : null;
    if (!d) {
      return res.status(502).json({ ok: false, error: 'FacturaSend no devolvió estado para el CDC', upstream: r ? r.body : null });
    }

    const estado = mapSituacionToEstado(d.situacion, d.estado);
    const motivo = d.respuesta_mensaje || null;

    if (doc) {
      doc = await updateDocumentoById(doc.id, {
        estado,
        motivo_rechazo: estado === 'RECHAZADO' ? motivo : null,
        raw: { ...(doc.raw || {}), estado_consulta: d },
        updated_at: new Date().toISOString(),
      });
    }

    return res.status(200).json({
      ok: estado === 'APROBADO',
      estado,
      situacion: d.situacion,
      cdc,
      motivo,                       // respuesta_mensaje SIFEN (visible)
      documento: doc,
      checked_at: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e && e.message ? e.message : 'consulta de estado falló', checked_at: new Date().toISOString() });
  }
}
