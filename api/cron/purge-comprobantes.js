// Vercel Cron — purga de comprobantes vencidos (FASE D2, retención 31 días).
// Los comprobantes de transferencia (bucket privado `comprobantes`) tienen datos
// personales del pagador y no deben acumularse para siempre. Este cron borra los
// archivos con más de RETENTION_DAYS días vía la Storage API (borrar la fila de
// storage.objects sola NO libera el archivo físico → hay que usar la API).
//
// Flujo: RPC list_old_comprobantes (SECURITY DEFINER, mig 183) → nombres viejos
// → DELETE /storage/v1/object/comprobantes { prefixes }. Idempotente y best-effort.
const RETENTION_DAYS = 31;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  // Secreto opcional (fail-open si no está seteado, igual que keep-alive).
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
  try {
    // 1) Nombres de los comprobantes vencidos (via RPC DEFINER).
    const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/list_old_comprobantes`, {
      method: 'POST', headers: authH, body: JSON.stringify({ p_days: RETENTION_DAYS }),
    });
    if (!rpc.ok) {
      const t = await rpc.text();
      return res.status(200).json({ ok: false, step: 'rpc', status: rpc.status, error: t });
    }
    const names = await rpc.json(); // array de text (paths)
    if (!Array.isArray(names) || names.length === 0) {
      return res.status(200).json({ ok: true, deleted: 0, checked_at: new Date().toISOString() });
    }
    // 2) Borrado físico por lotes (la Storage API acepta muchos prefixes por llamada).
    let deleted = 0;
    for (let i = 0; i < names.length; i += 100) {
      const batch = names.slice(i, i + 100);
      const del = await fetch(`${SUPABASE_URL}/storage/v1/object/comprobantes`, {
        method: 'DELETE', headers: authH, body: JSON.stringify({ prefixes: batch }),
      });
      if (del.ok) deleted += batch.length;
    }
    return res.status(200).json({ ok: true, deleted, retention_days: RETENTION_DAYS, checked_at: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'purge failed' });
  }
}
