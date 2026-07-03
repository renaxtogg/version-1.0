// ════════════════════════════════════════════════════════════════════
// PR-FE-4b · Router ÚNICO de facturación (una sola Serverless Function).
// ────────────────────────────────────────────────────────────────────
// El plan Hobby de Vercel permite máximo 12 funciones. Cada archivo handler
// en api/ (sin prefijo `_`) contaba como una función; los 8 endpoints de
// facturación empujaron el total sobre 12 y el build entero se rechazaba.
//
// Solución: dynamic route `api/facturasend/[action].js` = 1 sola función que
// despacha por el segmento de ruta (req.query.action) a la lógica de cada
// acción, ahora en módulos `_action_*.js` (prefijo `_` ⇒ NO cuentan como
// funciones). Las URLs públicas NO cambian:
//   /api/facturasend/emitir       → _action_emitir.js
//   /api/facturasend/emitir-caja  → _action_emitir_caja.js
//   /api/facturasend/estado       → _action_estado.js
//   /api/facturasend/evento       → _action_evento.js
//   /api/facturasend/kude         → _action_kude.js
//   /api/facturasend/email        → _action_email.js
//   /api/facturasend/test         → _action_test.js
//   /api/facturasend/seed-demo    → _action_seed_demo.js
//
// Esto es PURO RE-RUTEO: cada handler conserva su cuerpo EXACTO (método,
// gate de autorización, sandbox-only, rate-limit, forma de respuesta). El
// router NO aplica ningún gate propio — cada acción mantiene el suyo. En
// particular, `emitir-caja` sigue autorizando SOLO por sesión de staff y
// NUNCA por FACTURASEND_EMIT_SECRET.
// ════════════════════════════════════════════════════════════════════
import emitir from './_action_emitir.js';
import emitirCaja from './_action_emitir_caja.js';
import estado from './_action_estado.js';
import evento from './_action_evento.js';
import kude from './_action_kude.js';
import email from './_action_email.js';
import test from './_action_test.js';
import seedDemo from './_action_seed_demo.js';

// action (segmento de ruta) → handler. Las claves son las rutas públicas
// actuales; no agregar/renombrar sin actualizar a los llamadores.
const ROUTES = {
  'emitir': emitir,
  'emitir-caja': emitirCaja,
  'estado': estado,
  'evento': evento,
  'kude': kude,
  'email': email,
  'test': test,
  'seed-demo': seedDemo,
};

export default async function handler(req, res) {
  // El valor viene del segmento dinámico [action]; ningún handler usa la
  // clave `action`, así que no colisiona con sus parámetros.
  const action = (req.query && (Array.isArray(req.query.action) ? req.query.action[0] : req.query.action)) || '';
  const fn = ROUTES[action];
  if (typeof fn !== 'function') {
    return res.status(404).json({ ok: false, error: `acción de facturación desconocida: ${action || '(vacía)'}` });
  }
  // Delegación total: el handler original decide método, auth, sandbox y respuesta.
  return fn(req, res);
}
