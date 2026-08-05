// Vercel Cron — vencimientos de documentación de los riders de la red (mig 206).
//
// Es el módulo que evita que alguien reparta con la licencia vencida, y por eso
// el reloj no puede depender de que un panel esté abierto: corre todos los días
// aunque nadie entre. La RPC expire_rider_documents() hace TODO el trabajo
// (avisos en 30/15/7/1 días, marcar vencidos, suspender al que perdió un papel
// obligatorio y levantar las suspensiones con plazo cumplido); acá no se decide
// nada, sólo se la dispara. Idempotente: correrlo dos veces no avisa dos veces
// (el umbral ya avisado queda en documents.warned_days).
//
// De paso vence las ofertas de pedido que quedaron colgadas: normalmente las
// vence sola la primera lectura del panel del rider, pero si nadie abrió el
// panel en toda la noche conviene dejar la tabla limpia.
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['authorization'] !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
  const KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!SUPABASE_URL || !KEY) {
    return res.status(500).json({ error: 'Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY' });
  }
  const authH = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

  async function call(fn) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers: authH, body: '{}',
    });
    const body = await r.text();
    if (!r.ok) return { ok: false, status: r.status, error: body };
    try { return { ok: true, result: JSON.parse(body) }; }
    catch (_) { return { ok: true, result: body }; }
  }

  try {
    const docs = await call('expire_rider_documents');
    // 404 = la migración 206 todavía no se aplicó. No es una falla del cron:
    // se responde 200 para que Vercel no lo marque como error recurrente.
    if (!docs.ok && docs.status === 404) {
      return res.status(200).json({ ok: false, reason: 'migracion_206_pendiente' });
    }
    const offers = await call('expire_rider_offers');
    return res.status(200).json({
      ok: true, docs: docs.result || docs.error, offers: offers.result || offers.error,
      checked_at: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'rider-docs failed' });
  }
}
