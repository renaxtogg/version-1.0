export default async function handler(req, res) {
  // Vercel Cron invoca con GET.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  // Secreto opcional (fail-open si no está seteado, igual que bancard-mock).
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['authorization'] !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
  const KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!SUPABASE_URL || !KEY) {
    return res.status(500).json({ error: 'Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY' });
  }
  try {
    // SELECT mínimo: toca Postgres y resetea el contador de inactividad de Supabase.
    const r = await fetch(`${SUPABASE_URL}/rest/v1/subscription_plans?select=id&limit=1`,
      { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    return res.status(200).json({ ok: r.ok, status: r.status, pinged_at: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'ping failed' });
  }
}
