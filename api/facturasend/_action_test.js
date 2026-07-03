// ════════════════════════════════════════════════════════════════════
// Smoke test de conexión con FacturaSend (SIFEN, sandbox)
// ────────────────────────────────────────────────────────────────────
// Serverless (Vercel, Node 18). Hace GET {BASE}/{TENANT}/test y devuelve el
// resultado, para confirmar que la API responde OK con NUESTRA key.
//
// Dos caminos:
//   • PR-FE-1 — ?restaurant_id=<uuid>: resuelve el BillingProvider desde
//     fiscal_config (service_role), DESCIFRA la api_key del tenant y prueba con
//     esa key (source: 'db'). Es el camino "real" multi-tenant.
//   • PR-FE-0 — sin restaurant_id: usa FACTURASEND_API_KEY del env como fallback
//     del tenant demo durante la transición (source: 'env').
//
// SEGURIDAD:
//   • La API key vive SÓLO en el server (env o cifrada en DB). NUNCA se devuelve
//     ni se loguea (sólo viaja en el header saliente).
//   • Ambiente SANDBOX ("No conectado a SIFEN"): sin efecto fiscal.
//   • Camino DB (por tenant) = FAIL-CLOSED: exige FACTURASEND_TEST_SECRET, porque
//     descifra la credencial REAL del tenant y la usa como proxy saliente, y
//     restaurant_id NO es secreto (es el ?r= del QR). Sin gate sería un oráculo
//     de enumeración + proxy credenciado sin throttle.
//   • Camino ENV (fallback demo, PR-FE-0): gate opcional (fail-open si no está
//     seteado); sólo usa la key demo del env, no descifra ni enumera por tenant.
//   • Anti-flood: checkRateLimit por IP (fail-open sin Upstash).
// Errores VISIBLES: nada de catch vacío; cada fallo devuelve status + motivo.
// ════════════════════════════════════════════════════════════════════
import { facturaSendAuthHeader } from './_client.js';
import { resolveBillingProvider } from './_provider.js';
import { checkRateLimit } from '../_ratelimit.js';

export default async function handler(req, res) {
  // Sólo lectura.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Anti-flood: este endpoint dispara llamadas salientes credenciadas a FacturaSend.
  if (await checkRateLimit(req, res, { key: 'fs-test', max: 10, windowSec: 60 })) return;

  // Gate: si FACTURASEND_TEST_SECRET está seteado, se exige en AMBOS caminos.
  const testSecret = process.env.FACTURASEND_TEST_SECRET;
  if (testSecret && req.headers['authorization'] !== `Bearer ${testSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── Camino DB (PR-FE-1): key CIFRADA por tenant ───────────────────────────
  const restaurantId = (req.query && (req.query.restaurant_id || req.query.r)) || null;
  if (restaurantId) {
    // FAIL-CLOSED: descifra la credencial REAL del tenant → exige el secret
    // (restaurant_id no es secreto). Sin secret: no se habilita el camino DB.
    if (!testSecret) {
      return res.status(403).json({
        ok: false,
        source: 'db',
        error: 'Test por tenant deshabilitado: seteá FACTURASEND_TEST_SECRET para habilitarlo',
      });
    }
    try {
      const provider = await resolveBillingProvider(restaurantId);   // lee fiscal_config + descifra (server-only)
      const result = await provider.test();
      return res.status(result.ok ? 200 : 502).json({
        ok: result.ok,
        status: result.status,
        source: 'db',
        restaurant_id: restaurantId,
        tenant: provider.tenant,
        environment: provider.environment,
        upstream: result.body,      // respuesta de FacturaSend (no contiene nuestra key)
        checked_at: new Date().toISOString(),
      });
    } catch (e) {
      // Visible: falta config / inactiva / descifrado / red. El mensaje no contiene la key.
      return res.status(502).json({
        ok: false,
        source: 'db',
        restaurant_id: restaurantId,
        error: e && e.message ? e.message : 'no se pudo resolver el proveedor de facturación',
        checked_at: new Date().toISOString(),
      });
    }
  }

  // ── Camino ENV (PR-FE-0, fallback demo) ───────────────────────────────────
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
      source: 'env',
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
      source: 'env',
      error: e && e.message ? e.message : 'fetch a FacturaSend falló',
      upstream_status: upstreamStatus,
      tenant: TENANT,
      environment: 'sandbox',
      checked_at: new Date().toISOString(),
    });
  }
}
