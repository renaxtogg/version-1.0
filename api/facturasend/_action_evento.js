// ════════════════════════════════════════════════════════════════════
// PR-FE-3 · Eventos SIFEN: cancelación / inutilización — SANDBOX.
// ────────────────────────────────────────────────────────────────────
//   POST /api/facturasend/evento
//     • Cancelación:   { restaurant_id, tipo:'cancelacion', cdc, motivo }
//     • Inutilización: { restaurant_id, tipo:'inutilizacion',
//                        establecimiento, punto, desde, hasta, motivo, serie?, tipoDocumento? }
//   Header: Authorization: Bearer $FACTURASEND_EMIT_SECRET
//
// CANCELACIÓN: valida server-side que el DE exista, sea del restaurante, esté
//   GENERADO/APROBADO y dentro de la ventana SIFEN de 48h desde la emisión.
//   Éxito confirmado por SIFEN (dEstRes=Aprobado) → estado CANCELADO. Si el
//   sandbox desconectado rechaza el evento → error HONESTO (no se toca el estado).
//
// INUTILIZACIÓN: quema un rango [desde..hasta] de numeración. Se registra SIEMPRE
//   en fiscal_inutilizaciones (mig 139) con su resultado (aprobado/rechazado/error).
//
// Gate FAIL-CLOSED (FACTURASEND_EMIT_SECRET) + rate-limit + SOLO sandbox. La
// api_key nunca se devuelve ni se loguea. Errores VISIBLES.
// ════════════════════════════════════════════════════════════════════
import { getFiscalConfig, getDocumentoByCdc, updateDocumentoById, insertInutilizacion } from './_db.js';
import { providerFromConfig } from './_provider.js';
import { checkRateLimit } from '../_ratelimit.js';

const VENTANA_CANCELACION_MS = 48 * 3600 * 1000;   // 48h SIFEN
// SIFEN dMotEve/dMotivo: motivo entre 5 y 500 caracteres.
const MOTIVO_MIN = 5, MOTIVO_MAX = 500;
const ESTADOS_CANCELABLES = new Set(['GENERADO', 'APROBADO']);

// ¿SIFEN aprobó el evento? Busca dEstRes="Aprobado" en la respuesta (namespaced
// ns2). Conservador a propósito: sólo confirmamos con marca explícita de SIFEN
// (para un evento fiscal, un falso positivo — marcar CANCELADO sin cancelar — es
// peor que un falso negativo).
function sifenAprobado(body) {
  if (!body) return false;
  const str = typeof body === 'string' ? body : JSON.stringify(body);
  return /"(?:ns2:)?dEstRes"\s*:\s*"Aprobado"/i.test(str);
}

// Motivo del upstream para dejarlo VISIBLE (sin inventar).
function motivoUpstream(body) {
  if (!body) return null;
  if (typeof body === 'string') return body;
  return body.message || body.error ||
    (Array.isArray(body.errores) ? body.errores.join('; ') : null) ||
    (body.result && body.result.mensaje) || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed (usar POST)' });
  }

  if (await checkRateLimit(req, res, { key: 'fs-evento', max: 20, windowSec: 60 })) return;

  const secret = process.env.FACTURASEND_EMIT_SECRET;
  if (!secret) {
    return res.status(403).json({ ok: false, error: 'Eventos deshabilitados: seteá FACTURASEND_EMIT_SECRET para habilitarlos' });
  }
  if (req.headers['authorization'] !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const b = req.body || {};
  const q = req.query || {};
  const restaurantId = b.restaurant_id || q.restaurant_id || q.r || null;
  const tipo = (b.tipo || q.tipo || '').toString().toLowerCase();

  if (!restaurantId) return res.status(400).json({ ok: false, error: 'Falta restaurant_id' });
  if (tipo !== 'cancelacion' && tipo !== 'inutilizacion') {
    return res.status(400).json({ ok: false, error: "tipo inválido (usar 'cancelacion' o 'inutilizacion')" });
  }

  try {
    const cfg = await getFiscalConfig(restaurantId);
    if (!cfg) return res.status(502).json({ ok: false, error: `fiscal_config: sin configuración para restaurant_id=${restaurantId}` });
    if (cfg.active === false) return res.status(400).json({ ok: false, error: 'fiscal_config: configuración INACTIVA' });
    if ((cfg.environment || '').toLowerCase() === 'production') {
      return res.status(403).json({ ok: false, error: 'PR-FE-3 sólo opera en sandbox; environment=production está bloqueado' });
    }
    const provider = providerFromConfig(cfg);

    // ── CANCELACIÓN ─────────────────────────────────────────────────────────
    if (tipo === 'cancelacion') {
      const cdc = (b.cdc || q.cdc || '').toString().trim();
      const motivo = (b.motivo || '').toString().trim();
      if (!cdc) return res.status(400).json({ ok: false, error: 'Falta cdc' });
      if (motivo.length < MOTIVO_MIN || motivo.length > MOTIVO_MAX) {
        return res.status(400).json({ ok: false, error: `motivo requerido, entre ${MOTIVO_MIN} y ${MOTIVO_MAX} caracteres (SIFEN)` });
      }

      const doc = await getDocumentoByCdc(restaurantId, cdc);
      if (!doc) return res.status(404).json({ ok: false, error: 'no existe un DE con ese CDC para este restaurante' });
      if (!ESTADOS_CANCELABLES.has(doc.estado)) {
        return res.status(409).json({ ok: false, error: `el DE está en estado ${doc.estado}; sólo se cancela GENERADO/APROBADO` });
      }
      const emitidoMs = doc.created_at ? new Date(doc.created_at).getTime() : NaN;
      if (Number.isFinite(emitidoMs) && (Date.now() - emitidoMs) > VENTANA_CANCELACION_MS) {
        return res.status(409).json({ ok: false, error: 'fuera de la ventana SIFEN de 48h desde la emisión; el DE ya no se puede cancelar' });
      }

      const r = await provider.cancelar(cdc, motivo);
      const success = !!(r && r.body && r.body.success === true);
      const aprobado = success && sifenAprobado(r.body);

      if (aprobado) {
        const updated = await updateDocumentoById(doc.id, {
          estado: 'CANCELADO', motivo_rechazo: null,
          raw: { ...(doc.raw || {}), cancelacion: { motivo, response: r.body } },
          updated_at: new Date().toISOString(),
        });
        return res.status(200).json({
          ok: true, estado: 'CANCELADO', cdc, motivo,
          upstream_status: r.status, documento: updated, checked_at: new Date().toISOString(),
        });
      }
      // No confirmado por SIFEN (p. ej. sandbox desconectado) → honesto, sin tocar estado.
      return res.status(502).json({
        ok: false, estado: doc.estado, cdc,
        error: 'SIFEN no confirmó la cancelación',
        motivo: motivoUpstream(r && r.body),
        upstream_status: r ? r.status : null, upstream: r ? r.body : null,
        checked_at: new Date().toISOString(),
      });
    }

    // ── INUTILIZACIÓN ───────────────────────────────────────────────────────
    const establecimiento = (b.establecimiento || '').toString().trim();
    const punto = (b.punto || '').toString().trim();
    const desde = Number(b.desde), hasta = Number(b.hasta);
    const motivo = (b.motivo || '').toString().trim();
    const serie = b.serie != null && b.serie !== '' ? String(b.serie).trim() : null;
    const tipoDocumento = b.tipoDocumento != null ? Number(b.tipoDocumento) : 1;

    if (!establecimiento || !punto) return res.status(400).json({ ok: false, error: 'Faltan establecimiento y/o punto' });
    if (!Number.isInteger(desde) || !Number.isInteger(hasta) || desde < 1 || hasta < 1) {
      return res.status(400).json({ ok: false, error: 'desde/hasta deben ser enteros ≥ 1' });
    }
    if (desde > hasta) return res.status(400).json({ ok: false, error: 'desde no puede ser mayor que hasta' });
    if (motivo.length < MOTIVO_MIN || motivo.length > MOTIVO_MAX) {
      return res.status(400).json({ ok: false, error: `motivo requerido, entre ${MOTIVO_MIN} y ${MOTIVO_MAX} caracteres (SIFEN)` });
    }

    let r = null, errMsg = null;
    try {
      r = await provider.inutilizar({ tipoDocumento, establecimiento, punto, desde, hasta, motivo, serie });
    } catch (e) {
      errMsg = e && e.message ? e.message : 'inutilización falló';
    }
    const success = !!(r && r.body && r.body.success === true);
    const aprobado = success && sifenAprobado(r && r.body);
    const resultado = aprobado ? 'aprobado' : (r ? 'rechazado' : 'error');

    // Bitácora SIEMPRE (éxito o rechazo/error) — trazabilidad del rango quemado.
    let registro = null;
    try {
      registro = await insertInutilizacion({
        restaurant_id: restaurantId, tipo_documento: tipoDocumento,
        establecimiento, punto, serie, desde, hasta, motivo, resultado,
        raw: { request: { tipoDocumento, establecimiento, punto, desde, hasta, motivo, serie },
               response: r ? r.body : null, error: errMsg },
        created_at: new Date().toISOString(),
      });
    } catch (_) { /* best-effort: no tapar el resultado del evento */ }

    return res.status(aprobado ? 200 : 502).json({
      ok: aprobado, resultado,
      establecimiento, punto, desde, hasta,
      motivo: errMsg || motivoUpstream(r && r.body),
      upstream_status: r ? r.status : null, upstream: r ? r.body : null,
      registro, checked_at: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e && e.message ? e.message : 'evento falló', checked_at: new Date().toISOString() });
  }
}
