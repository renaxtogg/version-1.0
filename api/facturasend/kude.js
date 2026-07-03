// ════════════════════════════════════════════════════════════════════
// PR-FE-3 · KuDE (PDF) de un DE por su CDC — SANDBOX.
// ────────────────────────────────────────────────────────────────────
//   GET /api/facturasend/kude?restaurant_id=..&cdc=..&formato=ticket|a4
//   Header: Authorization: Bearer $FACTURASEND_EMIT_SECRET
//
// Proxy DIRECTO del PDF de FacturaSend (POST {tenant}/de/pdf). No guarda nada:
// devuelve el PDF con Content-Type application/pdf en streaming. Sólo para
// documentos del propio restaurante en estado GENERADO/APROBADO/CANCELADO.
//
// Mismo gate FAIL-CLOSED que /emitir (FACTURASEND_EMIT_SECRET) + rate-limit +
// SOLO sandbox. La api_key nunca se devuelve ni se loguea. Errores VISIBLES (JSON).
// ════════════════════════════════════════════════════════════════════
import { getFiscalConfig, getDocumentoByCdc } from './_db.js';
import { providerFromConfig } from './_provider.js';
import { authorizeSecretOrStaff } from './_staffauth.js';
import { checkRateLimit } from '../_ratelimit.js';

// Estados con documento disponible para imprimir.
const ESTADOS_IMPRIMIBLES = new Set(['GENERADO', 'APROBADO', 'CANCELADO']);
// Formatos aceptados por el endpoint → param `format` de FacturaSend.
const FORMATOS = new Set(['ticket', 'a4']);

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed (usar GET)' });
  }

  if (await checkRateLimit(req, res, { key: 'fs-kude', max: 60, windowSec: 60 })) return;

  const q = req.query || {};
  const b = req.body || {};
  const restaurantId = q.restaurant_id || q.r || b.restaurant_id || null;
  const cdc = q.cdc || b.cdc || null;
  const formatoIn = (q.formato || b.formato || '').toString().toLowerCase();
  if (!restaurantId) return res.status(400).json({ ok: false, error: 'Falta restaurant_id' });
  if (!cdc) return res.status(400).json({ ok: false, error: 'Falta cdc' });

  // Auth: secret de sandbox O sesión de staff del restaurante (caja imprime KuDE
  // sin el secret). Fail-closed.
  let authz;
  try { authz = await authorizeSecretOrStaff(req, restaurantId); }
  catch (_) { return res.status(500).json({ ok: false, error: 'No se pudo validar la sesión' }); }
  if (!authz.authorized) {
    const code = (authz.reason === 'sin_token' || authz.reason === 'token_invalido') ? 401 : 403;
    return res.status(code).json({ ok: false, error: 'No autorizado' });
  }

  try {
    const cfg = await getFiscalConfig(restaurantId);
    if (!cfg) return res.status(502).json({ ok: false, error: `fiscal_config: sin configuración para restaurant_id=${restaurantId}` });
    if ((cfg.environment || '').toLowerCase() === 'production') {
      return res.status(403).json({ ok: false, error: 'PR-FE-3 sólo opera en sandbox; environment=production está bloqueado' });
    }

    // El doc debe existir, ser del restaurante y estar imprimible.
    const doc = await getDocumentoByCdc(restaurantId, cdc);
    if (!doc) return res.status(404).json({ ok: false, error: 'no existe un DE con ese CDC para este restaurante' });
    if (!ESTADOS_IMPRIMIBLES.has(doc.estado)) {
      return res.status(409).json({ ok: false, error: `el DE está en estado ${doc.estado}; el KuDE sólo está disponible para GENERADO/APROBADO/CANCELADO` });
    }

    // formato explícito → param; si no, el default del emisor (fiscal_config.kude_format).
    const format = FORMATOS.has(formatoIn) ? formatoIn
      : (FORMATOS.has((cfg.kude_format || '').toLowerCase()) ? cfg.kude_format.toLowerCase() : undefined);

    const provider = providerFromConfig(cfg);
    const pdf = await provider.obtenerPdf(cdc, { format });
    if (!pdf.ok || !pdf.buffer) {
      // Upstream no devolvió PDF → superficie honesta (motivo visible, sin secretos).
      return res.status(502).json({
        ok: false,
        error: 'FacturaSend no devolvió un PDF para el CDC',
        upstream_status: pdf.status,
        upstream: pdf.body != null ? pdf.body : null,
      });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="kude-${doc.numero || cdc}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(pdf.buffer);
  } catch (e) {
    return res.status(502).json({ ok: false, error: e && e.message ? e.message : 'KuDE falló', checked_at: new Date().toISOString() });
  }
}
