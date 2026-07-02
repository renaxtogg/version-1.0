// ════════════════════════════════════════════════════════════════════
// PR-FE-3 · Emitir un Documento Electrónico (FACTURA, tipoDocumento=1) — SANDBOX.
// ────────────────────────────────────────────────────────────────────
//   POST /api/facturasend/emitir
//   body/query: { restaurant_id, order_id?, ejemplo? }
//   Header:     Authorization: Bearer $FACTURASEND_EMIT_SECRET
//
// Flujo: fiscal_config (service_role) → (orden real) reclama/crea el DE VIVO de
// la orden de forma ATÓMICA (RPC reclamar_o_crear_de, FOR UPDATE) → arma el DE →
// lote/create → clasifica el resultado → persiste estado terminal.
//
// MODELO DE ESTADOS (PR-FE-3):
//   BORRADOR → ENVIADO → GENERADO | APROBADO | RECHAZADO | ERROR
//   • GENERADO: XML+CDC generados. En modo DESCONECTADO de SIFEN es el estado
//     TERMINAL de éxito (APROBADO sólo llega conectado: cert F1 + timbrado).
//   • ERROR: falla de generación (sin CDC / sin lote) o excepción de transporte.
//     Reemplaza el "BORRADOR disfrazado": un fallo nunca queda como BORRADOR vivo.
//   • ok := estado ∈ { APROBADO, GENERADO }. NUNCA ok:true sin CDC.
//
// IDEMPOTENCIA (1 orden = 1 DE vivo):
//   • Índice UNIQUE parcial (restaurant_id, order_id) para estados vivos (mig 139).
//   • Ya hay DE vivo para la orden → se DEVUELVE ese doc (idempotent:true), NO se
//     re-emite (evita duplicar en SIFEN). Reintento tras ERROR/RECHAZADO (no
//     vivos) → el RPC crea un DE NUEVO con número nuevo; el número del fallido
//     queda registrado (SIFEN tolera huecos, nunca repetición).
//
// SEGURIDAD / REGLAS del proyecto:
//   • FAIL-CLOSED: exige FACTURASEND_EMIT_SECRET. SOLO sandbox (production → 403).
//   • Errores VISIBLES: cada fallo devuelve status + motivo. La api_key nunca se
//     devuelve ni se loguea. Anti-flood por IP. maxDuration 30s (vercel.json).
// ════════════════════════════════════════════════════════════════════
import { getFiscalConfig, getOrderForInvoice, insertDocumento,
         updateDocumentoById, reservarNumero, reclamarOCrearDe } from './_db.js';
import { providerFromConfig } from './_provider.js';
import { buildFacturaDEFromOrder, buildEjemploDE, fechaEmisionSIFEN,
         formatNumero, formatCodigo3, mapSituacionToEstado } from './_de_builder.js';
import { checkRateLimit } from '../_ratelimit.js';

const TIPO_FACTURA = 1;

// Respuesta idempotente honesta para un DE vivo ya existente (no se re-emite).
// ok := terminal de éxito (GENERADO/APROBADO). BORRADOR/ENVIADO vivos → nota.
function respuestaExistente(res, ex) {
  const ok = ex.estado === 'APROBADO' || ex.estado === 'GENERADO';
  const nota = (ex.estado === 'BORRADOR' || ex.estado === 'ENVIADO')
    ? 'DE vivo sin confirmar; consultá /api/facturasend/estado'
    : undefined;
  return res.status(ok ? 200 : 409).json({
    ok, idempotent: true, idempotente: true, estado: ex.estado,
    cdc: ex.cdc, numero: ex.numero, motivo: ex.motivo_rechazo || null,
    ...(nota ? { nota } : {}), documento: ex,
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed (usar POST)' });
  }

  // Anti-flood.
  if (await checkRateLimit(req, res, { key: 'fs-emitir', max: 20, windowSec: 60 })) return;

  // FAIL-CLOSED: sin secret el endpoint está deshabilitado.
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

  if (!restaurantId) {
    return res.status(400).json({ ok: false, error: 'Falta restaurant_id' });
  }

  // Declarado fuera del try para poder marcar ERROR en el catch (nunca dejar un
  // BORRADOR vivo tras una excepción → evita trabar la orden).
  let doc = null;

  try {
    // 1) Config fiscal (server-only). Necesitamos est/punto + validar sandbox.
    const cfg = await getFiscalConfig(restaurantId);
    if (!cfg) return res.status(502).json({ ok: false, error: `fiscal_config: sin configuración para restaurant_id=${restaurantId}` });
    if (cfg.active === false) return res.status(400).json({ ok: false, error: 'fiscal_config: configuración INACTIVA (activá antes de emitir)' });
    if ((cfg.environment || '').toLowerCase() === 'production') {
      return res.status(403).json({ ok: false, error: 'PR-FE-3 sólo emite en sandbox; environment=production está bloqueado' });
    }

    const provider = providerFromConfig(cfg);   // descifra la key (server-only)
    const est = formatCodigo3(cfg.establecimiento);
    const punto = formatCodigo3(cfg.punto_expedicion);
    const fecha = fechaEmisionSIFEN();

    let de;
    if (isEjemplo) {
      // 2a) Ejemplo: sin orden, sin idempotencia (order_id NULL queda fuera del
      //     índice parcial). Reserva número + inserta BORRADOR.
      const numero = await reservarNumero(restaurantId, TIPO_FACTURA, est, punto);
      de = buildEjemploDE({ numero, establecimiento: est, punto, fecha });
      doc = await insertDocumento({
        restaurant_id: restaurantId, order_id: null, tipo_de: TIPO_FACTURA,
        establecimiento: est, punto, numero: formatNumero(numero),
        estado: 'BORRADOR', motivo_rechazo: null, cdc: null, lote_id: null,
        raw: { de }, updated_at: new Date().toISOString(),
      });
    } else {
      // 2b) Orden real: cargar orden + items (validación) y reclamar el DE vivo.
      const order = await getOrderForInvoice(restaurantId, orderId);
      if (!order) return res.status(404).json({ ok: false, error: `orden ${orderId} no encontrada para este restaurante` });
      const items = order.order_items || [];
      if (!items.length) return res.status(400).json({ ok: false, error: 'la orden no tiene items para facturar' });

      // Get-or-create ATÓMICO (FOR UPDATE sobre la orden). Si ya hay DE vivo →
      // NO re-emitir. El reintento tras ERROR/RECHAZADO crea uno nuevo (número
      // nuevo); un BORRADOR abandonado (sin CDC, viejo) se re-reclama (created=true).
      const claim = await reclamarOCrearDe(restaurantId, orderId, TIPO_FACTURA, est, punto);
      doc = claim.doc;
      if (!claim.created) {
        // Ya existe un DE vivo para la orden → respuesta idempotente, sin re-emitir.
        return respuestaExistente(res, doc);
      }

      // BORRADOR reclamado (nuevo, o reusado de un intento abandonado — mismo
      // número). Armar el DE con ese número y persistirlo (raw.de) ANTES de enviar.
      de = buildFacturaDEFromOrder({ order, items, cfg, numero: doc.numero, fecha });
      doc = await updateDocumentoById(doc.id, { raw: { de }, estado: 'BORRADOR', updated_at: new Date().toISOString() });
    }

    if (!doc || !doc.id) {
      throw new Error('no se pudo persistir el documento electrónico (PostgREST sin representación)');
    }

    // 3) Envío del lote a FacturaSend.
    const emit = await provider.emitir([de]);
    const result = emit && emit.body && emit.body.result ? emit.body.result : (emit && emit.body) || {};
    const deList = result && Array.isArray(result.deList) ? result.deList : [];
    const first = deList[0] || {};
    const cdc = first.cdc || null;
    const loteId = result && result.loteId != null ? String(result.loteId) : null;

    // 4) Clasificación honesta del resultado:
    //   • deList con CDC → estado por-DE (GENERADO/APROBADO/RECHAZADO/CANCELADO).
    //   • deList sin CDC → RECHAZADO (si el upstream lo marca así, con su motivo)
    //     o ERROR (generación fallida). Nunca BORRADOR disfrazado.
    //   • sin deList → ERROR de transporte (reintentable: el próximo intento
    //     crea un DE nuevo con número nuevo).
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

    doc = await updateDocumentoById(doc.id, {
      cdc, lote_id: loteId, estado,
      motivo_rechazo: (estado === 'RECHAZADO' || estado === 'ERROR') ? motivo : null,
      raw: { de, response: emit.body },
      updated_at: new Date().toISOString(),
    });

    // Estado terminal en sandbox desconectado: GENERADO (con CDC) / RECHAZADO /
    // ERROR. Un DE con CDC generado NO queda ENVIADO (el mapeo con hasCdc lo lleva
    // a GENERADO). Conectado a SIFEN, GENERADO→APROBADO se resuelve vía /estado.
    // ok := GENERADO/APROBADO. 200 éxito · 502 el resto (202 defensivo si ENVIADO).
    const ok = estado === 'APROBADO' || estado === 'GENERADO';
    const httpCode = ok ? 200 : (estado === 'ENVIADO' ? 202 : 502);
    return res.status(httpCode).json({
      ok,
      estado,
      cdc,
      numero: doc ? doc.numero : null,
      lote_id: loteId,
      motivo,                       // motivo de rechazo / error del upstream (visible)
      ejemplo: isEjemplo,
      documento: doc,
      checked_at: new Date().toISOString(),
    });
  } catch (e) {
    // Excepción de transporte/persistencia. Si ya hay una fila, marcarla ERROR
    // (best-effort) para no dejar un BORRADOR vivo que trabe la orden. El próximo
    // intento creará un DE nuevo con número nuevo.
    const msg = e && e.message ? e.message : 'emisión falló';
    if (doc && doc.id) {
      try {
        await updateDocumentoById(doc.id, {
          estado: 'ERROR', motivo_rechazo: msg, updated_at: new Date().toISOString(),
        });
      } catch (_) { /* best-effort: no tapar el error original */ }
    }
    // Visible: nunca rompe la venta (endpoint aparte). El mensaje no contiene la key.
    return res.status(502).json({ ok: false, estado: 'ERROR', error: msg, checked_at: new Date().toISOString() });
  }
}
