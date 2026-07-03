// ════════════════════════════════════════════════════════════════════
// PR-FE-4 · Emitir la factura de un pedido — desde CAJA, por sesión de staff.
// ────────────────────────────────────────────────────────────────────
//   POST /api/facturasend/emitir-caja   { restaurant_id, order_id }
//   Header: Authorization: Bearer <access_token del staff de Supabase>
//
// A diferencia de /emitir (secret de sandbox), este endpoint autoriza por la
// SESIÓN del staff: el caller debe ser staff (cajero/admin/supervisor_local) del
// restaurante dueño del pedido (o superadmin, o misma empresa). El secret
// compartido NO se usa acá y NUNCA viaja al browser.
//
// Reutiliza EXACTAMENTE el mismo pipeline que /emitir (emitirDeDeOrden en _emit.js):
// idempotente por order_id (reclamar_o_crear_de + índice UNIQUE parcial) → reintentar
// NO duplica; toma el receptor fiscal REAL del pedido (factura_* → CONSUMIDOR real).
// Además sincroniza orders.factura_estado (SOLICITADA→EMITIDA|ERROR).
//
// SOLO sandbox por ahora (production → 403). Errores VISIBLES. Rate-limit. La
// api_key nunca se devuelve ni se loguea.
// ════════════════════════════════════════════════════════════════════
import { getFiscalConfig } from './_db.js';
import { emitirDeDeOrden } from './_emit.js';
import { authorizeStaffForRestaurant } from './_staffauth.js';
import { checkRateLimit } from '../_ratelimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed (usar POST)' });
  }

  if (await checkRateLimit(req, res, { key: 'fs-emitir-caja', max: 30, windowSec: 60 })) return;

  const b = req.body || {};
  const q = req.query || {};
  const restaurantId = b.restaurant_id || q.restaurant_id || q.r || null;
  const orderId = b.order_id || q.order_id || null;
  if (!restaurantId) return res.status(400).json({ ok: false, error: 'Falta restaurant_id' });
  if (!orderId) return res.status(400).json({ ok: false, error: 'Falta order_id' });

  // Autorización por SESIÓN (staff del restaurante). Fail-closed.
  let authz;
  try {
    authz = await authorizeStaffForRestaurant(req, restaurantId);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'No se pudo validar la sesión' });
  }
  if (!authz.authorized) {
    const code = (authz.reason === 'sin_token' || authz.reason === 'token_invalido') ? 401 : 403;
    return res.status(code).json({ ok: false, error: 'No autorizado para emitir en este restaurante' });
  }

  try {
    const cfg = await getFiscalConfig(restaurantId);
    if (!cfg) return res.status(502).json({ ok: false, error: 'Facturación no configurada para este restaurante' });
    if (cfg.active === false) return res.status(400).json({ ok: false, error: 'Facturación INACTIVA para este restaurante' });
    if ((cfg.environment || '').toLowerCase() === 'production') {
      return res.status(403).json({ ok: false, error: 'La emisión sólo está habilitada en sandbox por ahora' });
    }

    const r = await emitirDeDeOrden({ cfg, restaurantId, orderId });
    const httpCode = r.ok ? 200 : (r.idempotent ? 409 : (r.estado === 'ENVIADO' ? 202 : 502));
    return res.status(httpCode).json({
      ok: r.ok,
      idempotent: !!r.idempotent,
      estado: r.estado,
      factura_estado: r.ok ? 'EMITIDA' : (r.estado === 'ERROR' || r.estado === 'RECHAZADO' ? 'ERROR' : 'SOLICITADA'),
      cdc: r.cdc,
      numero: r.numero,
      lote_id: r.loteId,
      motivo: r.motivo,
      documento: r.documento,
      checked_at: new Date().toISOString(),
    });
  } catch (e) {
    // Precondición (orden inexistente / sin items) trae httpCode; el resto → 502.
    const code = e && e.httpCode ? e.httpCode : 502;
    return res.status(code).json({ ok: false, estado: 'ERROR', error: e && e.message ? e.message : 'emisión falló', checked_at: new Date().toISOString() });
  }
}
