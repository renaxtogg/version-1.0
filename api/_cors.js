/* ══════════════════════════════════════════════════════════════════════════
   CORS de los endpoints de administración — fuente única.

   `Access-Control-Allow-Origin` admite UN solo origen: no acepta lista ni
   comodín cuando además viajan credenciales. Con el valor cableado en cada
   handler, mudar el panel de dominio obligaba a elegir entre romper el origen
   viejo o el nuevo. Acá `ALLOWED_ORIGIN` se lee como lista separada por comas
   y se REFLEJA el origen de la petición si figura en ella, así una migración
   de dominio puede tener los dos orígenes vivos a la vez y no hay ventana en
   la que estos endpoints rechacen a todo el mundo.

   Reflejar exige `Vary: Origin`, o una caché intermedia le sirve a un origen
   la respuesta que se armó para el otro.

   Ojo: esto NO es la autorización. Todos estos endpoints exigen igual un
   `Authorization` con sesión válida de Supabase — CORS sólo decide qué página
   puede LEER la respuesta desde un navegador, no quién puede llamar.
   ══════════════════════════════════════════════════════════════════════════ */

// Sin env var, el origen del producto. Ver docs/setup/dominio-mythos-com-py.md.
const DEFAULT_ORIGINS = ['https://mythos.vercel.app'];

function allowedOrigins() {
  const raw = (process.env.ALLOWED_ORIGIN || '').trim();
  if (!raw) return DEFAULT_ORIGINS;
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_ORIGINS;
}

function applyCors(req, res, methods = 'POST, OPTIONS') {
  const list   = allowedOrigins();
  const origin = ((req && req.headers && req.headers.origin) || '').trim();
  // Si el origen no está en la lista se responde con el primero: no habilita a
  // nadie nuevo y mantiene el comportamiento de antes para clientes sin Origin.
  res.setHeader('Access-Control-Allow-Origin', list.includes(origin) ? origin : list[0]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = { applyCors, allowedOrigins };
