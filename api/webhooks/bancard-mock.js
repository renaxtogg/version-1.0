// Bancard Webhook Mock — Vercel Serverless Function (Node 18)
// Simula la respuesta exitosa de un webhook post-cobro de Bancard.
// Latencia artificial de 1.5 s para emular red real.
// NO procesa cobros reales — solo simulación para certificación.

export const config = { runtime: 'nodejs18.x' };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomTxId() {
  const ts  = Date.now().toString(36).toUpperCase();
  const rnd = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `BNCD-MOCK-${ts}-${rnd}`;
}

export default async function handler(req, res) {
  // Solo POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let body = {};
  try {
    if (typeof req.body === 'string') {
      body = JSON.parse(req.body);
    } else if (req.body && typeof req.body === 'object') {
      body = req.body;
    }
  } catch (_) {
    body = {};
  }

  // Simular latencia de red Bancard (~1.5 s)
  await sleep(1500);

  const transaction_id   = randomTxId();
  const authorization_number = Math.floor(100000 + Math.random() * 900000).toString();
  const processed_at     = new Date().toISOString();

  // Payload compatible con movimientos_caja.metadata
  const movimientoCajaMetadata = {
    transaction_id,
    authorization_number,
    amount:         body.amount         || null,
    currency:       body.currency       || 'PYG',
    card_brand:     body.card_brand     || 'VISA',
    card_last_four: body.card_last_four || '****',
    order_id:       body.order_id       || null,
    turno_id:       body.turno_id       || null,
    processed_at,
    raw_response: {
      status:      'SUCCESS',
      returnCode:  '00',
      returnDesc:  'Aprobado',
      processorResponse: 'APPROVED',
    },
  };

  return res.status(200).json({
    status:           'SUCCESS',
    transaction_id,
    authorization_number,
    processed_at,
    amount:           body.amount || null,
    currency:         'PYG',
    description:      'Pago simulado — módulo Bancard en fase de certificación',
    movimientos_caja_metadata: movimientoCajaMetadata,
    _mock: true,
  });
}
