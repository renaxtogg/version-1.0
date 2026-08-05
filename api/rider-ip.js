// Devuelve la IP que Vercel ve del visitante. La usa /riders para registrar la
// aceptación del contrato de adhesión (mig 206) con fecha, hora, IP y versión.
//
// Existe como endpoint propio porque el `connect-src` del CSP (vercel.json)
// sólo admite 'self', Supabase, Google Maps, Nominatim y Turnstile: un servicio
// externo tipo ipify lo bloquearía el navegador y el campo llegaría siempre
// vacío. No expone nada: le devuelve a cada quien su propia IP.
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  const fwd = String(req.headers['x-forwarded-for'] || '');
  const ip = (fwd.split(',')[0] || '').trim()
    || String(req.headers['x-real-ip'] || '').trim()
    || req.socket?.remoteAddress
    || null;
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ip });
}
