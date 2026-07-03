// ════════════════════════════════════════════════════════════════════
// PR-FE-2/3/4 · Emitir un DE (FACTURA, tipoDocumento=1) — SANDBOX (secret gate).
// ────────────────────────────────────────────────────────────────────
//   POST /api/facturasend/emitir
//   body/query: { restaurant_id, order_id?, ejemplo? }
//   Header:     Authorization: Bearer $FACTURASEND_EMIT_SECRET
//
// Este endpoint es para PRUEBAS de sandbox (gate por secret compartido). La
// emisión desde caja por sesión de staff vive en /api/facturasend/emitir-caja.
// Ambos comparten el MISMO pipeline (_emit.js): reclamar_o_crear_de → _de_builder
// → _provider → clasificar → persistir. Ver notas de estados/idempotencia en _emit.js.
//
// SEGURIDAD: FAIL-CLOSED (exige FACTURASEND_EMIT_SECRET). SOLO sandbox
// (production → 403). Errores VISIBLES. La api_key nunca se devuelve ni se loguea.
// ════════════════════════════════════════════════════════════════════
import { getFiscalConfig, insertDocumento, updateDocumentoById, reservarNumero } from './_db.js';
import { providerFromConfig } from './_provider.js';
import { buildEjemploDE, fechaEmisionSIFEN, formatNumero, formatCodigo3 } from './_de_builder.js';
import { sendAndClassify, emitirDeDeOrden } from './_emit.js';
import { checkRateLimit } from '../_ratelimit.js';

const TIPO_FACTURA = 1;

// Respuesta idempotente honesta para un DE vivo ya existente (no se re-emite).
function respuestaExistente(res, r) {
  const nota = (r.estado === 'BORRADOR' || r.estado === 'ENVIADO')
    ? 'DE vivo sin confirmar; consultá /api/facturasend/estado' : undefined;
  return res.status(r.ok ? 200 : 409).json({
    ok: r.ok, idempotent: true, idempotente: true, estado: r.estado,
    cdc: r.cdc, numero: r.numero, lote_id: r.loteId, motivo: r.motivo || null,
    ...(nota ? { nota } : {}), documento: r.documento, checked_at: new Date().toISOString(),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed (usar POST)' });
  }

  if (await checkRateLimit(req, res, { key: 'fs-emitir', max: 20, windowSec: 60 })) return;

  const secret = process.env.FACTURASEND_EMIT_SECRET;
  if (!secret) {
    return res.status(403).json({ ok: false, error: 'Emisión deshabilitada: seteá FACTURASEND_EMIT_SECRET para habilitarla' });
  }
  if (req.headers['authorization'] !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const restaurantId = (req.query && (req.query.restaurant_id || req.query.r)) ||
                       (req.body && req.body.restaurant_id) || null;
  const orderId = (req.query && req.query.order_id) || (req.body && req.body.order_id) || null;
  const ejemploFlag = (req.query && req.query.ejemplo) || (req.body && req.body.ejemplo);
  const isEjemplo = ejemploFlag === true || ejemploFlag === 'true' || ejemploFlag === '1' || !orderId;

  if (!restaurantId) return res.status(400).json({ ok: false, error: 'Falta restaurant_id' });

  let doc = null;   // fuera del try para marcar ERROR en el catch (ejemplo).
  try {
    const cfg = await getFiscalConfig(restaurantId);
    if (!cfg) return res.status(502).json({ ok: false, error: `fiscal_config: sin configuración para restaurant_id=${restaurantId}` });
    if (cfg.active === false) return res.status(400).json({ ok: false, error: 'fiscal_config: configuración INACTIVA (activá antes de emitir)' });
    if ((cfg.environment || '').toLowerCase() === 'production') {
      return res.status(403).json({ ok: false, error: 'sólo se emite en sandbox; environment=production está bloqueado' });
    }

    // ── Camino ORDEN REAL: pipeline compartido (idempotente por order_id) ──
    if (!isEjemplo) {
      const r = await emitirDeDeOrden({ cfg, restaurantId, orderId });
      if (r.idempotent) return respuestaExistente(res, r);
      const httpCode = r.ok ? 200 : (r.estado === 'ENVIADO' ? 202 : 502);
      return res.status(httpCode).json({
        ok: r.ok, estado: r.estado, cdc: r.cdc, numero: r.numero, lote_id: r.loteId,
        motivo: r.motivo, ejemplo: false, documento: r.documento, checked_at: new Date().toISOString(),
      });
    }

    // ── Camino EJEMPLO: sin orden, sin idempotencia (order_id NULL) ──
    const provider = providerFromConfig(cfg);
    const est = formatCodigo3(cfg.establecimiento);
    const punto = formatCodigo3(cfg.punto_expedicion);
    const numero = await reservarNumero(restaurantId, TIPO_FACTURA, est, punto);
    const de = buildEjemploDE({ numero, establecimiento: est, punto, fecha: fechaEmisionSIFEN() });
    doc = await insertDocumento({
      restaurant_id: restaurantId, order_id: null, tipo_de: TIPO_FACTURA,
      establecimiento: est, punto, numero: formatNumero(numero),
      estado: 'BORRADOR', motivo_rechazo: null, cdc: null, lote_id: null,
      raw: { de }, updated_at: new Date().toISOString(),
    });
    if (!doc || !doc.id) throw new Error('no se pudo persistir el documento electrónico (PostgREST sin representación)');

    const r = await sendAndClassify({ provider, de, doc });
    const httpCode = r.ok ? 200 : (r.estado === 'ENVIADO' ? 202 : 502);
    return res.status(httpCode).json({
      ok: r.ok, estado: r.estado, cdc: r.cdc, numero: r.documento ? r.documento.numero : formatNumero(numero),
      lote_id: r.loteId, motivo: r.motivo, ejemplo: true, documento: r.documento, checked_at: new Date().toISOString(),
    });
  } catch (e) {
    const msg = e && e.message ? e.message : 'emisión falló';
    const code = e && e.httpCode ? e.httpCode : 502;
    // Ejemplo: si ya hay fila, marcarla ERROR (no dejar BORRADOR vivo).
    if (doc && doc.id) {
      try { await updateDocumentoById(doc.id, { estado: 'ERROR', motivo_rechazo: msg, updated_at: new Date().toISOString() }); } catch (_) {}
    }
    return res.status(code).json({ ok: false, estado: 'ERROR', error: msg, checked_at: new Date().toISOString() });
  }
}
