// Vercel Cron — mantenimiento nocturno. UN endpoint que corre las tareas
// diarias de toda la plataforma, cada una independiente de las otras.
//
// ¿Por qué juntas y no un archivo por tarea, que se leería mejor? Por dos topes
// del plan Hobby de Vercel, y conviene dejarlo escrito porque no se ven desde
// el código:
//   • 12 funciones serverless por deploy — el repo estaba EXACTAMENTE en 12, y
//     el primer endpoint nuevo hacía fallar el deploy entero con
//     `exceeded_serverless_functions_per_deployment`. El build compila igual:
//     el rechazo llega recién en "Deploying outputs...", sin línea de error en
//     el log, así que es un fallo difícil de diagnosticar. Tres crons diarios
//     en un archivo devuelven 2 lugares.
//   • 2 cron jobs — y había 3 declarados, o sea uno no se estaba ejecutando
//     nunca. Con este quedan 2 (keep-alive + nightly), dentro del tope.
// Si el proyecto pasa a Pro (40 crons, sin tope práctico de funciones), esto se
// puede volver a separar en un archivo por tarea sin tocar nada más: cada paso
// ya es una función suelta acá abajo.
//
// Contrato: cada paso es best-effort e idempotente, y el fallo de uno NO frena
// a los siguientes — si la purga de comprobantes se cae, el cobro de
// proveedores y los vencimientos de riders tienen que correr igual. Siempre
// responde 200 con el detalle por paso: un 500 haría que Vercel lo marque como
// cron roto cuando en realidad lo único que pasó es que falta una migración.

const RETENTION_DAYS = 31; // comprobantes de transferencia (FASE D2, mig 183)

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

  // Dispara una RPC. Un 404 significa "la migración todavía no se aplicó", que
  // no es una falla del cron: se reporta como paso pendiente y se sigue.
  async function rpc(fn, body) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST', headers: authH, body: JSON.stringify(body || {}),
      });
      const text = await r.text();
      if (r.status === 404) return { ok: false, pending: true, fn };
      if (!r.ok) return { ok: false, status: r.status, error: text, fn };
      try { return { ok: true, result: JSON.parse(text) }; }
      catch (_) { return { ok: true, result: text }; }
    } catch (e) {
      return { ok: false, error: e.message || 'fetch failed', fn };
    }
  }

  // ── 1) Purga de comprobantes vencidos (retención 31 días, mig 183) ──
  // Tienen datos personales del pagador y no pueden acumularse para siempre.
  // Borrar la fila de storage.objects NO libera el archivo físico: hay que
  // pasar por la Storage API.
  async function purgeComprobantes() {
    const listed = await rpc('list_old_comprobantes', { p_days: RETENTION_DAYS });
    if (!listed.ok) return listed;
    const names = listed.result;
    if (!Array.isArray(names) || names.length === 0) return { ok: true, deleted: 0 };
    let deleted = 0;
    for (let i = 0; i < names.length; i += 100) {
      const batch = names.slice(i, i + 100);
      try {
        const del = await fetch(`${SUPABASE_URL}/storage/v1/object/comprobantes`, {
          method: 'DELETE', headers: authH, body: JSON.stringify({ prefixes: batch }),
        });
        if (del.ok) deleted += batch.length;
      } catch (_) { /* best-effort: el próximo pase lo reintenta */ }
    }
    return { ok: true, deleted, retention_days: RETENTION_DAYS };
  }

  const steps = {};
  // Cada paso va en su propio try: el que falla no arrastra a los demás.
  try { steps.comprobantes = await purgeComprobantes(); }
  catch (e) { steps.comprobantes = { ok: false, error: e.message }; }

  // ── 2) Ciclo de cobro del marketplace de proveedores (mig 199) ──
  // Mueve el reloj: trial/active vencido → past_due; gracia agotada → pausado
  // (reversible; 'suspendido' es sanción de Mythos, esto es mora).
  try { steps.proveedores = await rpc('expire_supplier_trials'); }
  catch (e) { steps.proveedores = { ok: false, error: e.message }; }

  // ── 3) Vencimientos de documentación de riders (mig 206) ──
  // Es lo que evita que alguien reparta con la licencia vencida, y por eso no
  // puede depender de que un panel esté abierto: avisos a 30/15/7/1 días,
  // marcar vencidos, suspender al que perdió un papel obligatorio y levantar
  // las suspensiones con plazo cumplido.
  try { steps.riders_docs = await rpc('expire_rider_documents'); }
  catch (e) { steps.riders_docs = { ok: false, error: e.message }; }

  // ── 4) Ofertas de pedido colgadas (mig 206) ──
  // Normalmente las vence la primera lectura del panel del rider; si nadie lo
  // abrió en toda la noche, conviene dejar la tabla limpia igual.
  try { steps.riders_ofertas = await rpc('expire_rider_offers'); }
  catch (e) { steps.riders_ofertas = { ok: false, error: e.message }; }

  // ── 5) Porteros: avisar cuando cambia quién puede entrar ────────────────
  // El 2026-08-05 `diner_app_config.is_public` estuvo en `true` sin que nadie
  // lo supiera: la allowlist de la beta cerrada dejó de filtrar y cuentas de
  // restaurante terminaron con perfil de comensal. No lo detectó ningún
  // escaneo de código, y no podía: el dato era el VALOR DE UNA FILA. Se
  // descubrió de casualidad, mirando una tabla de ranking.
  //
  // Esto NO valida contra un estado "correcto" fijo — abrir la app algún día
  // es una decisión de negocio legítima, y un cron que grite por eso se vuelve
  // ruido que se ignora. Detecta CAMBIOS: guarda una foto por noche y sólo
  // anota un evento cuando algo se movió respecto de la anterior. Un
  // interruptor que se abre solo, o que alguien abrió sin avisar, deja rastro
  // con fecha.
  //
  // Va a `platform_events`, que el superadmin ya lee: sin canal nuevo, sin otra
  // función serverless (el plan Hobby topea en 12) y sin otro cron (topea en 2).
  async function checkPorteros() {
    async function get(path) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: authH });
      if (!r.ok) return null;                       // tabla ausente = migración pendiente
      const j = await r.json().catch(() => null);
      return Array.isArray(j) ? (j[0] || null) : j;
    }

    const diner = await get('diner_app_config?select=is_public,public_browse_enabled&limit=1');
    const rider = await get('mythos_rider_config?select=enabled,pilot_mode&limit=1');
    if (!diner && !rider) return { ok: false, pending: true, motivo: 'sin tablas de config' };

    const ahora = {
      diner_signup_abierto: diner ? !!diner.is_public : null,
      diner_vitrina_publica: diner ? !!diner.public_browse_enabled : null,
      riders_red_activa:     rider ? !!rider.enabled : null,
      riders_modo_piloto:    rider ? !!rider.pilot_mode : null,
    };

    const previo = await get(
      'platform_events?select=metadata&event_type=eq.porteros_snapshot' +
      '&order=created_at.desc&limit=1');
    const antes = previo && previo.metadata ? previo.metadata.estado : null;

    const cambios = [];
    for (const k of Object.keys(ahora)) {
      if (antes && antes[k] !== undefined && antes[k] !== ahora[k]) {
        cambios.push({ interruptor: k, antes: antes[k], ahora: ahora[k] });
      }
    }

    // La foto se guarda SIEMPRE (es la base de la comparación de mañana); el
    // aviso sólo cuando hubo movimiento.
    const eventos = [{
      event_type: 'porteros_snapshot',
      description: 'Estado nocturno de los porteros de acceso',
      metadata: { estado: ahora },
    }];
    if (cambios.length) {
      eventos.push({
        event_type: 'porteros_cambio',
        description: 'Cambió quién puede entrar: ' +
          cambios.map(c => `${c.interruptor} ${c.antes} → ${c.ahora}`).join(' · '),
        metadata: { cambios, estado: ahora },
      });
    }
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/platform_events`, {
        method: 'POST', headers: authH, body: JSON.stringify(eventos),
      });
    } catch (_) { /* best-effort: mañana vuelve a intentar */ }

    return { ok: true, estado: ahora, cambios, primera_vez: !antes };
  }

  try { steps.porteros = await checkPorteros(); }
  catch (e) { steps.porteros = { ok: false, error: e.message }; }

  return res.status(200).json({ ok: true, steps, checked_at: new Date().toISOString() });
}
