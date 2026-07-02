// ════════════════════════════════════════════════════════════════════
// PR-FE-0 · Smoke test de conexión con FacturaSend (SIFEN, sandbox)
// ────────────────────────────────────────────────────────────────────
// Serverless (Vercel, Node 18). Hace GET {BASE}/{TENANT}/test con
// "Authorization: Bearer $FACTURASEND_API_KEY" y devuelve el resultado, para
// confirmar que la API responde OK con NUESTRA key ANTES de construir nada más.
//
// SEGURIDAD:
//   • La API key vive SÓLO en el server (env FACTURASEND_API_KEY). NUNCA se
//     devuelve en la respuesta ni se loguea (sólo se envía en el header saliente).
//   • Ambiente SANDBOX ("No conectado a SIFEN"): sin efecto fiscal.
//   • Gate opcional FACTURASEND_TEST_SECRET (fail-open si no está seteado, igual
//     patrón que bancard-mock/keep-alive) para que este endpoint no gaste nuestra
//     credencial de FacturaSend si queda expuesto. No bloquea el smoke test.
// Errores VISIBLES: nada de catch vacío; cada fallo devuelve status + motivo.
// ════════════════════════════════════════════════════════════════════
import { facturaSendAuthHeader } from './_client.js';

export default async function handler(req, res) {
  // Sólo lectura.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Gate opcional (fail-open si FACTURASEND_TEST_SECRET no está seteado).
  const testSecret = process.env.FACTURASEND_TEST_SECRET;
  if (testSecret && req.headers['authorization'] !== `Bearer ${testSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const BASE   = (process.env.FACTURASEND_BASE_URL || 'https://api.facturasend.com.py').trim().replace(/\/+$/, '');
  const TENANT = (process.env.FACTURASEND_TENANT   || 'renatomancuello').trim();
  const KEY    = (process.env.FACTURASEND_API_KEY  || '').trim();

  if (!KEY) {
    // Visible, pero sin filtrar nada: la key simplemente no está cargada.
    return res.status(500).json({ ok: false, error: 'Falta la variable de entorno FACTURASEND_API_KEY (no está cargada en el server)' });
  }

  const url = `${BASE}/${TENANT}/test`;

  let upstreamStatus = null;
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        // FacturaSend exige "Bearer api_key_<KEY>" — el prefijo lo pone el helper.
        Authorization: facturaSendAuthHeader(KEY),   // ← único lugar donde se usa la key; nunca se loguea ni se devuelve
        Accept: 'application/json',
      },
    });
    upstreamStatus = r.status;

    // Parseo tolerante: JSON si se puede, si no texto crudo (para ver el error real).
    const raw = await r.text();
    let body;
    try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = raw; }

    return res.status(r.ok ? 200 : 502).json({
      ok: r.ok,
      status: r.status,
      tenant: TENANT,
      environment: 'sandbox',       // "No conectado a SIFEN" — sin efecto fiscal
      key_present: true,            // la env var está cargada (sin exponer el valor)
      upstream: body,               // respuesta de FacturaSend (no contiene nuestra key)
      checked_at: new Date().toISOString(),
    });
  } catch (e) {
    // Error de red / fetch: visible, con el motivo (el mensaje no contiene la key).
    return res.status(502).json({
      ok: false,
      error: e && e.message ? e.message : 'fetch a FacturaSend falló',
      upstream_status: upstreamStatus,
      tenant: TENANT,
      environment: 'sandbox',
      checked_at: new Date().toISOString(),
    });
  }
}
