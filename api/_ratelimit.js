// api/_ratelimit.js
// ════════════════════════════════════════════════════════════════════════
// Helper de rate-limiting (anti flood/DoS) para los endpoints serverless.
// ────────────────────────────────────────────────────────────────────────
// Escrito en CommonJS (module.exports) para que lo consuman LOS DOS mundos:
//   • handlers CommonJS  → const { checkRateLimit } = require('./_ratelimit');
//   • webhook ESM        → import { checkRateLimit } from '../_ratelimit.js';
// Las libs de Upstash se cargan con import() DINÁMICO: así somos agnósticos a
// si publican CJS o ESM-only, y no rompemos el build de Vercel desde ninguno
// de los dos consumidores.
//
// FAIL-OPEN: si faltan las env vars de Upstash (local/preview sin config) o si
// Redis falla, NO se bloquea (return false). El objetivo es frenar floods,
// nunca tumbar un endpoint sano por un problema de infraestructura.
// ════════════════════════════════════════════════════════════════════════

// Cache de instancias Ratelimit por (key+ventana). Se reutilizan entre
// invocaciones "calientes" de la misma Function (incluido su ephemeralCache),
// para no recrear el cliente Redis en cada request.
const _limiters = new Map();
let _modsPromise = null;

function loadUpstash() {
  if (!_modsPromise) {
    _modsPromise = Promise.all([
      import('@upstash/ratelimit'),
      import('@upstash/redis'),
    ]);
  }
  return _modsPromise;
}

// Identidad del cliente = IP. PRIORIDAD: 'x-real-ip' lo setea el proxy de Vercel
// con la IP real del cliente y NO es falsificable por el cliente → es la clave
// primaria del rate-limit anti-DoS. 'x-forwarded-for' es spoofable (el cliente
// puede prepender valores y rotar la cubeta), así que solo se usa como fallback
// (primer valor de la lista). Si no hay nada, 'anon'.
function clientIp(req) {
  const h = req.headers || {};
  const xr = h['x-real-ip'];
  if (xr) {
    const v = String(xr).trim();
    if (v) return v;
  }
  const xff = h['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return 'anon';
}

async function getLimiter(key, max, windowSec) {
  const cacheKey = `${key}:${max}:${windowSec}`;
  const cached = _limiters.get(cacheKey);
  if (cached) return cached;

  const [rlMod, redisMod] = await loadUpstash();
  // Destructuring defensivo: vale tanto si la lib es ESM (export nombrado)
  // como CJS importado vía interop (queda bajo .default).
  const Ratelimit = rlMod.Ratelimit || (rlMod.default && rlMod.default.Ratelimit);
  const Redis = redisMod.Redis || (redisMod.default && redisMod.default.Redis);

  const limiter = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(max, `${windowSec} s`),
    ephemeralCache: new Map(), // no pegarle a Redis por IPs ya bloqueadas
    analytics: false,          // plan free
    prefix: 'mythos:rl',
  });
  _limiters.set(cacheKey, limiter);
  return limiter;
}

/**
 * Aplica rate-limiting por IP. Devuelve:
 *   • true  → YA respondió 429 (el handler DEBE cortar: `return`).
 *   • false → el request puede continuar.
 * @param {object} opts - { key, max, windowSec }
 */
async function checkRateLimit(req, res, { key, max, windowSec }) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false; // FAIL-OPEN: sin Upstash no bloqueamos

  try {
    const limiter = await getLimiter(key, max, windowSec);
    const ip = clientIp(req);
    const { success, reset } = await limiter.limit(`${key}:${ip}`);
    if (success) return false;

    // Retry-After (segundos) hasta que se libere la ventana. Si `reset` no fuera
    // numérico (no pasa con @upstash/ratelimit), caemos a windowSec como piso seguro
    // para nunca emitir "NaN".
    const resetMs = Number(reset);
    const retryAfter = Number.isFinite(resetMs)
      ? Math.max(1, Math.ceil((resetMs - Date.now()) / 1000))
      : windowSec;
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Demasiadas solicitudes, probá en un momento.' });
    return true;
  } catch (e) {
    // FAIL-OPEN ante cualquier fallo de Redis/red: no tumbamos el endpoint.
    try { console.error('[ratelimit] fail-open:', e && e.message ? e.message : e); } catch (_) {}
    return false;
  }
}

module.exports = { checkRateLimit };
