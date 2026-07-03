// ════════════════════════════════════════════════════════════════════
// Núcleo de emisión de un DE — compartido por /emitir (secret, sandbox) y
// /emitir-caja (sesión de staff). Server-only. Un solo pipeline: reclamar_o_
// crear_de → _de_builder → _provider → clasificar → persistir.
// ────────────────────────────────────────────────────────────────────
// NO hace gate/secret/rate-limit (eso es responsabilidad del endpoint). cfg =
// fiscal_config YA leída y validada (sandbox, activa). Nada acá loguea la key.
// ════════════════════════════════════════════════════════════════════
import { getOrderForInvoice, updateDocumentoById, reclamarOCrearDe, updateOrderFacturaEstado } from './_db.js';
import { providerFromConfig } from './_provider.js';
import { buildFacturaDEFromOrder, fechaEmisionSIFEN, formatCodigo3, mapSituacionToEstado } from './_de_builder.js';

const TIPO_FACTURA = 1;

// Envía un DE ya persistido (fila en BORRADOR) a FacturaSend, clasifica el
// resultado (honesto) y persiste el estado terminal. Devuelve un resultado
// normalizado. PUEDE lanzar si el transporte falla ANTES de obtener respuesta
// (el caller marca ERROR). GENERADO = éxito terminal desconectado (ver mig 139).
export async function sendAndClassify({ provider, de, doc }) {
  const emit = await provider.emitir([de]);
  const result = emit && emit.body && emit.body.result ? emit.body.result : (emit && emit.body) || {};
  const deList = result && Array.isArray(result.deList) ? result.deList : [];
  const first = deList[0] || {};
  const cdc = first.cdc || null;
  const loteId = result && result.loteId != null ? String(result.loteId) : null;

  let estado, motivo;
  if (deList.length > 0) {
    estado = mapSituacionToEstado(first.situacion, first.estado, !!cdc);
    motivo = first.respuesta_mensaje || first.respuesta_codigo || null;
    if (!cdc && estado !== 'RECHAZADO') {
      estado = 'ERROR';
      if (!motivo) motivo = `generación sin CDC (FacturaSend HTTP ${emit.status})`;
    }
  } else {
    estado = 'ERROR';
    motivo = (typeof emit.body === 'string' ? emit.body
              : (emit.body && (emit.body.message || emit.body.error))) || `FacturaSend HTTP ${emit.status}`;
  }

  const documento = await updateDocumentoById(doc.id, {
    cdc, lote_id: loteId, estado,
    motivo_rechazo: (estado === 'RECHAZADO' || estado === 'ERROR') ? motivo : null,
    raw: { de, response: emit.body },
    updated_at: new Date().toISOString(),
  });

  const ok = estado === 'APROBADO' || estado === 'GENERADO';
  return { ok, estado, cdc, loteId, motivo, documento };
}

// Sincroniza el estado coarse a nivel pedido (best-effort, sólo si pidió factura).
async function syncFactura(restaurantId, orderId, factSolicitada, estadoFactura) {
  if (!factSolicitada) return;
  try { await updateOrderFacturaEstado(restaurantId, orderId, estadoFactura); } catch (_) { /* best-effort */ }
}

// Emite (o devuelve idempotente) el DE de una ORDEN real. NUNCA lanza por un fallo
// de emisión (lo refleja en estado ERROR). Lanza SOLO por precondición (orden
// inexistente / sin items) con e.httpCode. Idempotente vía reclamar_o_crear_de.
export async function emitirDeDeOrden({ cfg, restaurantId, orderId }) {
  const provider = providerFromConfig(cfg);
  const est = formatCodigo3(cfg.establecimiento);
  const punto = formatCodigo3(cfg.punto_expedicion);
  const fecha = fechaEmisionSIFEN();

  const order = await getOrderForInvoice(restaurantId, orderId);
  if (!order) { const e = new Error(`orden ${orderId} no encontrada para este restaurante`); e.httpCode = 404; throw e; }
  const items = order.order_items || [];
  if (!items.length) { const e = new Error('la orden no tiene items para facturar'); e.httpCode = 400; throw e; }
  const factSolicitada = order.factura_solicitada === true;

  const claim = await reclamarOCrearDe(restaurantId, orderId, TIPO_FACTURA, est, punto);
  let doc = claim.doc;

  if (!claim.created) {
    // Ya hay un DE vivo → idempotente, NO re-emitir. Sincronizar el estado coarse.
    const ok = doc.estado === 'APROBADO' || doc.estado === 'GENERADO';
    const fEstado = ok ? 'EMITIDA' : (doc.estado === 'ERROR' || doc.estado === 'RECHAZADO' ? 'ERROR' : 'SOLICITADA');
    await syncFactura(restaurantId, orderId, factSolicitada, fEstado);
    return { ok, idempotent: true, estado: doc.estado, cdc: doc.cdc, numero: doc.numero,
             loteId: doc.lote_id, motivo: doc.motivo_rechazo || null, documento: doc };
  }

  try {
    const de = buildFacturaDEFromOrder({ order, items, cfg, numero: doc.numero, fecha });
    doc = await updateDocumentoById(doc.id, { raw: { de }, estado: 'BORRADOR', updated_at: new Date().toISOString() });
    const r = await sendAndClassify({ provider, de, doc });
    await syncFactura(restaurantId, orderId, factSolicitada, r.ok ? 'EMITIDA' : 'ERROR');
    return { ok: r.ok, idempotent: false, estado: r.estado, cdc: r.cdc,
             numero: r.documento ? r.documento.numero : doc.numero, loteId: r.loteId,
             motivo: r.motivo, documento: r.documento };
  } catch (e) {
    // Excepción de transporte → marcar la fila ERROR (no dejar BORRADOR vivo).
    const msg = e && e.message ? e.message : 'emisión falló';
    if (doc && doc.id) {
      try { await updateDocumentoById(doc.id, { estado: 'ERROR', motivo_rechazo: msg, updated_at: new Date().toISOString() }); } catch (_) {}
    }
    await syncFactura(restaurantId, orderId, factSolicitada, 'ERROR');
    return { ok: false, idempotent: false, estado: 'ERROR', cdc: null,
             numero: doc ? doc.numero : null, loteId: null, motivo: msg, documento: doc };
  }
}
