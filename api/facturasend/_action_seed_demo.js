// ════════════════════════════════════════════════════════════════════
// PR-FE-1 · Seed del tenant demo en fiscal_config SIN exponer la key.
// ────────────────────────────────────────────────────────────────────
// Rutina server one-time: toma la key de FACTURASEND_API_KEY (env), la CIFRA
// con encryptApiKey (AES-256-GCM) y hace upsert de la fila fiscal_config del
// restaurante indicado, con tenant='renatomancuello', environment='sandbox',
// active=true. El plaintext NUNCA va a una migración ni se loguea/devuelve.
//
// GATE FAIL-CLOSED: escribe config fiscal → exige FACTURASEND_SEED_SECRET
// (Authorization: Bearer <secret>). Si el secret no está seteado, se rechaza
// (no se deja un endpoint de escritura abierto). Seteá el secret, llamalo una
// vez, y después podés quitar el secret para dejarlo inutilizable.
//
//   POST /api/facturasend/seed-demo?restaurant_id=<uuid>
//   Header: Authorization: Bearer $FACTURASEND_SEED_SECRET
// ════════════════════════════════════════════════════════════════════
import { encryptApiKey } from './_crypto.js';
import { upsertFiscalConfig } from './_db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed (usar POST)' });
  }

  // Gate FAIL-CLOSED.
  const secret = process.env.FACTURASEND_SEED_SECRET;
  if (!secret) {
    return res.status(403).json({ error: 'Seed deshabilitado: seteá FACTURASEND_SEED_SECRET para habilitarlo' });
  }
  if (req.headers['authorization'] !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const restaurantId =
    (req.query && (req.query.restaurant_id || req.query.r)) ||
    (req.body && req.body.restaurant_id) || null;
  if (!restaurantId) {
    return res.status(400).json({ error: 'Falta restaurant_id (query ?restaurant_id=<uuid> o body)' });
  }

  const envKey = (process.env.FACTURASEND_API_KEY || '').trim();
  if (!envKey) {
    return res.status(500).json({ error: 'Falta FACTURASEND_API_KEY (fuente de la key del tenant demo)' });
  }
  const tenant = (process.env.FACTURASEND_TENANT || 'renatomancuello').trim();

  try {
    const enc = encryptApiKey(envKey);   // cifra el GUID pelado; el plaintext no sale de acá
    const saved = await upsertFiscalConfig({
      restaurant_id: restaurantId,
      provider: 'facturasend',
      tenant,
      environment: 'sandbox',
      api_key_ciphertext: enc.ciphertext,
      api_key_iv: enc.iv,
      api_key_tag: enc.tag,
      active: true,
      updated_at: new Date().toISOString(),
    });
    return res.status(200).json({
      ok: true,
      seeded: true,
      restaurant_id: restaurantId,
      tenant,
      environment: 'sandbox',
      active: true,
      api_key_stored: 'cifrada (AES-256-GCM)',   // jamás el valor
      updated_at: saved ? saved.updated_at : null,
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e && e.message ? e.message : 'seed falló' });
  }
}
