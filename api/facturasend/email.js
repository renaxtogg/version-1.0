// ════════════════════════════════════════════════════════════════════
// PR-FE-3 · Enviar/reenviar un DE por email — SANDBOX.
// ────────────────────────────────────────────────────────────────────
//   POST /api/facturasend/email   body { restaurant_id, cdc, email }
//   Header: Authorization: Bearer $FACTURASEND_EMIT_SECRET
//
// Llama a FacturaSend (POST {tenant}/de/email). Respuesta HONESTA: si el sandbox
// desconectado no envía, el motivo real queda visible (nada de ok:true mentiroso).
//
// Mismo gate FAIL-CLOSED que /emitir (FACTURASEND_EMIT_SECRET) + rate-limit +
// SOLO sandbox. La api_key nunca se devuelve ni se loguea.
// ════════════════════════════════════════════════════════════════════
import { getFiscalConfig, getDocumentoByCdc } from './_db.js';
import { providerFromConfig } from './_provider.js';
import { checkRateLimit } from '../_ratelimit.js';

// Validación de email pragmática (no RFC-completa): algo@algo.tld sin espacios.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Estados con documento disponible para enviar.
const ESTADOS_ENVIABLES = new Set(['GENERADO', 'APROBADO', 'CANCELADO']);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed (usar POST)' });
  }

  if (await checkRateLimit(req, res, { key: 'fs-email', max: 20, windowSec: 60 })) return;

  const secret = process.env.FACTURASEND_EMIT_SECRET;
  if (!secret) {
    return res.status(403).json({ ok: false, error: 'Email deshabilitado: seteá FACTURASEND_EMIT_SECRET para habilitarlo' });
  }
  if (req.headers['authorization'] !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const q = req.query || {};
  const b = req.body || {};
  const restaurantId = q.restaurant_id || q.r || b.restaurant_id || null;
  const cdc = q.cdc || b.cdc || null;
  const email = (b.email || q.email || '').toString().trim();

  if (!restaurantId) return res.status(400).json({ ok: false, error: 'Falta restaurant_id' });
  if (!cdc) return res.status(400).json({ ok: false, error: 'Falta cdc' });
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'email inválido' });
  }

  try {
    const cfg = await getFiscalConfig(restaurantId);
    if (!cfg) return res.status(502).json({ ok: false, error: `fiscal_config: sin configuración para restaurant_id=${restaurantId}` });
    if ((cfg.environment || '').toLowerCase() === 'production') {
      return res.status(403).json({ ok: false, error: 'PR-FE-3 sólo opera en sandbox; environment=production está bloqueado' });
    }

    const doc = await getDocumentoByCdc(restaurantId, cdc);
    if (!doc) return res.status(404).json({ ok: false, error: 'no existe un DE con ese CDC para este restaurante' });
    if (!ESTADOS_ENVIABLES.has(doc.estado)) {
      return res.status(409).json({ ok: false, error: `el DE está en estado ${doc.estado}; sólo se puede enviar GENERADO/APROBADO/CANCELADO` });
    }

    const provider = providerFromConfig(cfg);
    const r = await provider.enviarEmail(cdc, email);

    // Honesto: ok SÓLO con confirmación explícita del upstream (success===true).
    // NO se usa r.ok (HTTP 2xx) como señal: un 200 con body sin `success` NO es
    // confirmación de envío (regla "nada de ok:true mentiroso"). Igual que evento.js.
    const success = !!(r && r.body && r.body.success === true);
    const motivo = r && r.body && (r.body.message || r.body.error || (Array.isArray(r.body.errores) ? r.body.errores.join('; ') : null)) || null;
    return res.status(success ? 200 : 502).json({
      ok: success,
      cdc,
      email,
      motivo,
      upstream_status: r ? r.status : null,
      upstream: r ? r.body : null,
      checked_at: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e && e.message ? e.message : 'envío de email falló', checked_at: new Date().toISOString() });
  }
}
