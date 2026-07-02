// ════════════════════════════════════════════════════════════════════
// PR-FE-2 · Emitir un Documento Electrónico (FACTURA, tipoDocumento=1) — SANDBOX.
// ────────────────────────────────────────────────────────────────────
//   POST /api/facturasend/emitir
//   body/query: { restaurant_id, order_id?, ejemplo? }
//   Header:     Authorization: Bearer $FACTURASEND_EMIT_SECRET
//
// Flujo: fiscal_config (service_role) → arma el DE (ejemplo o desde la orden) →
// reserva número atómico → persiste documentos_electronicos (BORRADOR) → lote/create
// → guarda cdc/estado → poll corto hasta APROBADO/RECHAZADO.
//
// SEGURIDAD / REGLAS del proyecto:
//   • FAIL-CLOSED: exige FACTURASEND_EMIT_SECRET (si no está seteado, endpoint OFF).
//   • SOLO sandbox: si fiscal_config.environment='production' → 403.
//   • IDEMPOTENTE y HONESTO:
//       - ya APROBADO/ENVIADO/CANCELADO para la orden → NO re-emite (no miente el ok).
//       - BORRADOR/RECHAZADO → reintentable: reusa la MISMA fila (UPDATE) y reenvía.
//       - `ok` es SIEMPRE (estado === 'APROBADO'); nunca ok:true para un doc sin CDC.
//       - índice UNIQUE (restaurant_id, order_id, tipo_de) cierra el doble-click.
//   • NO rompe la venta (endpoint aparte). Errores VISIBLES: cada fallo devuelve
//     status + motivo; la api_key nunca se devuelve ni se loguea.
//   • Anti-flood: checkRateLimit por IP. maxDuration 30s (vercel.json) para el poll.
//
// LIMITACIÓN CONOCIDA (cerrar antes de PRODUCCIÓN, hoy acotada a sandbox):
//   El reintento de un BORRADOR sin CDC (p. ej. la respuesta de FacturaSend se
//   perdió pero SIFEN sí recibió el lote) puede emitir un 2º DE con número nuevo
//   → factura duplicada. En sandbox es inocuo (producción está bloqueada). El
//   cierre correcto es una clave de idempotencia hacia SIFEN (reusar numero +
//   codigoSeguridadAleatorio fijo para que el CDC sea determinístico) — PR-FE-3.
//   Cada reintento además "quema" un correlativo (SIFEN tolera huecos).
// ════════════════════════════════════════════════════════════════════
import { getFiscalConfig, getOrderForInvoice, getDocumentoByOrder,
         insertDocumento, updateDocumentoById, reservarNumero } from './_db.js';
import { providerFromConfig } from './_provider.js';
import { buildFacturaDEFromOrder, buildEjemploDE, fechaEmisionSIFEN,
         formatNumero, formatCodigo3, mapSituacionToEstado } from './_de_builder.js';
import { checkRateLimit } from '../_ratelimit.js';

const TIPO_FACTURA = 1;

// Estados por los que NO se re-emite (ya aprobado, en vuelo con CDC, o anulado).
const ESTADOS_NO_REEMITIR = new Set(['APROBADO', 'ENVIADO', 'CANCELADO']);

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Poll corto tras el envío: sandbox suele aprobar en segundos. Devuelve el
// estado final (APROBADO/RECHAZADO/CANCELADO) o null si sigue ENVIADO. Cotas
// chicas (≤5s) para no chocar con el timeout de la función; el resto lo resuelve
// /api/facturasend/estado con backoff propio.
async function pollHastaFinal(provider, cdc) {
  const esperas = [2000, 3000];   // ~5s máx.
  for (const ms of esperas) {
    await sleep(ms);
    let r;
    try { r = await provider.consultarEstado([cdc]); } catch (_) { continue; }
    const d = r && r.body && Array.isArray(r.body.deList) ? r.body.deList[0] : null;
    if (!d) continue;
    const estado = mapSituacionToEstado(d.situacion, d.estado);
    if (estado !== 'ENVIADO') {
      return { estado, motivo: d.respuesta_mensaje || d.respuesta_codigo || null, situacion: d.situacion };
    }
  }
  return null;
}

// Respuesta idempotente honesta para una fila ya existente (no se re-emite).
function respuestaExistente(res, ex, nota) {
  const aprobado = ex.estado === 'APROBADO';
  return res.status(aprobado ? 200 : 409).json({
    ok: aprobado, idempotente: true, estado: ex.estado,
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

  try {
    // 1) Config fiscal (server-only). Necesitamos est/punto + validar sandbox.
    const cfg = await getFiscalConfig(restaurantId);
    if (!cfg) return res.status(502).json({ ok: false, error: `fiscal_config: sin configuración para restaurant_id=${restaurantId}` });
    if (cfg.active === false) return res.status(400).json({ ok: false, error: 'fiscal_config: configuración INACTIVA (activá antes de emitir)' });
    if ((cfg.environment || '').toLowerCase() === 'production') {
      return res.status(403).json({ ok: false, error: 'PR-FE-2 sólo emite en sandbox; environment=production está bloqueado' });
    }

    const provider = providerFromConfig(cfg);   // descifra la key (server-only)
    const est = formatCodigo3(cfg.establecimiento);
    const punto = formatCodigo3(cfg.punto_expedicion);

    // 2) Idempotencia + carga de la orden (camino real).
    let existente = null, order = null, items = null;
    if (!isEjemplo) {
      existente = await getDocumentoByOrder(restaurantId, orderId, TIPO_FACTURA);
      // Ya aprobado / en vuelo / anulado → NO re-emitir (respuesta honesta).
      if (existente && ESTADOS_NO_REEMITIR.has(existente.estado)) {
        return respuestaExistente(res, existente,
          existente.estado === 'ENVIADO' ? 'emisión en curso; consultá /api/facturasend/estado' : undefined);
      }
      // BORRADOR / RECHAZADO → reintentable (se reenvía reusando la MISMA fila).
      order = await getOrderForInvoice(restaurantId, orderId);
      if (!order) return res.status(404).json({ ok: false, error: `orden ${orderId} no encontrada para este restaurante` });
      items = order.order_items || [];
      if (!items.length) return res.status(400).json({ ok: false, error: 'la orden no tiene items para facturar' });
    }

    // 3) Reserva atómica del número + armado del DE.
    const numero = await reservarNumero(restaurantId, TIPO_FACTURA, est, punto);
    const fecha = fechaEmisionSIFEN();
    const de = isEjemplo
      ? buildEjemploDE({ numero, establecimiento: est, punto, fecha })
      : buildFacturaDEFromOrder({ order, items, cfg, numero, fecha });

    // 4) Persistir BORRADOR. Reintento = UPDATE de la fila existente; alta nueva =
    //    INSERT (el UNIQUE cierra la carrera del doble-click concurrente).
    const baseRow = {
      establecimiento: est, punto, numero: formatNumero(numero),
      estado: 'BORRADOR', motivo_rechazo: null, cdc: null, lote_id: null,
      raw: { de }, updated_at: new Date().toISOString(),
    };
    let doc;
    if (existente) {
      doc = await updateDocumentoById(existente.id, baseRow);
    } else {
      try {
        doc = await insertDocumento({
          restaurant_id: restaurantId, order_id: isEjemplo ? null : orderId,
          tipo_de: TIPO_FACTURA, ...baseRow,
        });
      } catch (e) {
        if (e && e.status === 409 && !isEjemplo) {
          // Otra solicitud concurrente ganó la carrera del INSERT → no re-emitimos.
          const ex = await getDocumentoByOrder(restaurantId, orderId, TIPO_FACTURA);
          if (ex) return respuestaExistente(res, ex, 'emisión ya en curso/hecha por otra solicitud');
        }
        throw e;
      }
    }
    // Sin representación de la fila → NO emitimos (evita una emisión huérfana cuyo
    // CDC no podríamos persistir). Falla ANTES de tocar FacturaSend.
    if (!doc || !doc.id) {
      throw new Error('no se pudo persistir el documento electrónico (PostgREST sin representación)');
    }

    // 5) Envío del lote a FacturaSend.
    const emit = await provider.emitir([de]);
    const result = emit && emit.body && emit.body.result ? emit.body.result : (emit && emit.body) || {};
    const deList = result && Array.isArray(result.deList) ? result.deList : [];
    const first = deList[0] || {};
    const cdc = first.cdc || null;
    const loteId = result && result.loteId != null ? String(result.loteId) : null;

    // Clasificación del resultado. Con deList presente confiamos en el resultado
    // POR-DE (aprobado / RECHAZADO / pendiente) AUNQUE no venga cdc — así un rechazo
    // de validación (HTTP 200, estado 'Rechazado', sin CDC) NO se disfraza de error
    // transitorio y su motivo queda VISIBLE. Sin deList = error de transporte.
    let estado, motivo;
    if (deList.length > 0) {
      estado = mapSituacionToEstado(first.situacion, first.estado);
      motivo = first.respuesta_mensaje || first.respuesta_codigo || null;
      if (estado === 'ENVIADO' && !cdc) {          // pendiente sin CDC: nada que confirmar
        estado = 'BORRADOR';
        if (!motivo) motivo = `pendiente sin CDC (FacturaSend HTTP ${emit.status})`;
      }
    } else {
      estado = 'BORRADOR';                          // sin resultado por-DE → reintentable
      motivo = (typeof emit.body === 'string' ? emit.body
                : (emit.body && (emit.body.message || emit.body.error))) || `FacturaSend HTTP ${emit.status}`;
    }

    doc = await updateDocumentoById(doc.id, {
      cdc, lote_id: loteId, estado,
      motivo_rechazo: (estado === 'RECHAZADO' || estado === 'BORRADOR') ? motivo : null,
      raw: { de, response: emit.body },
      updated_at: new Date().toISOString(),
    });

    // 6) Poll corto si quedó ENVIADO con CDC (sandbox aprueba en segundos).
    if (cdc && estado === 'ENVIADO') {
      const fin = await pollHastaFinal(provider, cdc);
      if (fin) {
        estado = fin.estado;
        motivo = fin.motivo || motivo;
        doc = await updateDocumentoById(doc.id, {
          estado,
          motivo_rechazo: estado === 'RECHAZADO' ? motivo : null,
          raw: { de, response: emit.body, estado_final: fin },
          updated_at: new Date().toISOString(),
        });
      }
    }

    // ok SÓLO si APROBADO. 200 aprobado · 202 pendiente (ENVIADO) · 502 el resto.
    const httpCode = estado === 'APROBADO' ? 200 : (estado === 'ENVIADO' ? 202 : 502);
    return res.status(httpCode).json({
      ok: estado === 'APROBADO',
      estado,
      cdc,
      numero: doc ? doc.numero : formatNumero(numero),
      lote_id: loteId,
      motivo,                       // motivo de rechazo / error del upstream (visible)
      ejemplo: isEjemplo,
      documento: doc,
      checked_at: new Date().toISOString(),
    });
  } catch (e) {
    // Visible: nunca rompe la venta (endpoint aparte). El mensaje no contiene la key.
    return res.status(502).json({ ok: false, error: e && e.message ? e.message : 'emisión falló', checked_at: new Date().toISOString() });
  }
}
