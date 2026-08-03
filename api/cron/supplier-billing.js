// Vercel Cron — ciclo de cobro del marketplace de proveedores (mig 199).
//
// Hasta la mig 199 el trial del proveedor NO vencía nunca: `resolve_supplier_
// entitlement` habilitaba por `status` sin mirar la fecha, así que un proveedor
// aprobado operaba gratis de por vida. Este cron es el que mueve el reloj:
//   1) trial/active con fecha vencida → `past_due` (arranca la gracia)
//   2) `past_due` con la gracia agotada → la tienda pasa a `pausado`
//
// Toda la lógica vive en la RPC expire_supplier_trials() (SECURITY DEFINER,
// idempotente): acá no se decide nada, solo se la dispara. Pausar es reversible
// a propósito — 'suspendido' es sanción de Mythos, esto es mora y se revierte
// sola cuando el superadmin registra el pago.
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  // Secreto opcional (fail-open si no está seteado, igual que los otros crons).
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
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/expire_supplier_trials`, {
      method: 'POST', headers: authH, body: '{}',
    });
    const body = await r.text();
    if (!r.ok) {
      // 404 = la mig 199 todavía no se aplicó: no es un fallo del cron.
      return res.status(200).json({ ok: false, step: 'rpc', status: r.status, error: body });
    }
    let parsed = null;
    try { parsed = JSON.parse(body); } catch (_) { parsed = body; }
    return res.status(200).json({ ok: true, result: parsed, checked_at: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'supplier-billing failed' });
  }
}
