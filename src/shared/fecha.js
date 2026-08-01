// ════════════════════════════════════════════════════════════════════
// Día comercial del local — FUENTE ÚNICA para todos los paneles.
// ────────────────────────────────────────────────────────────────────
// POR QUÉ EXISTE ESTE MÓDULO
//   `new Date().toISOString().slice(0,10)` devuelve la fecha **UTC**. Paraguay es
//   UTC-3, así que desde las 21:00 hora local eso ya es el día SIGUIENTE: el
//   sistema cambiaba de día en plena cena, la franja que más factura un
//   restaurante. Aparecía 44 veces repartido en 7 paneles, cada uno con su propia
//   copia del helper — que es exactamente cómo se desincronizaron. Acá vive una
//   sola implementación y todos la importan.
//
// ZONA HORARIA: CONFIGURABLE, con el default correcto
//   El huso sale de `restaurants.timezone` (columna que ya existe y se puebla al
//   crear cada local). Hasta que esa consulta responde —y para cualquier local sin
//   el campo cargado— se usa `America/Asuncion`, que es lo correcto para todos los
//   clientes de hoy. Así el comportamiento correcto es el default y no hay que
//   configurar nada, pero un local en otro huso queda contemplado sin tocar código.
//
// CUÁL USAR (elegir mal es justo donde estaba la trampa):
//   · todayLocal()     → "hoy" del local. Para columnas DATE (reservation_date,
//                        log_date, date), defaults y `min` de <input type="date">,
//                        nombres de archivo exportado.
//   · dayLocal(ts)     → día del local de un TIMESTAMP que vino de la DB
//                        (login_at, fecha_apertura…). Para compararlo con todayLocal().
//   · isoLocal(d)      → YYYY-MM-DD de un Date construido LOCALMENTE (un dd/mm/aaaa
//                        que tipeó el usuario, o una fecha calculada con setMonth).
//                        Lee sus propios componentes, sin pasar por UTC. Es el
//                        correcto para los EXTREMOS DE UN RANGO: `to` viene con
//                        23:59:59.999 y por toISOString() se iba un día de más.
//   · startOfDayISO()  → instante de inicio del día comercial, para comparar contra
//                        columnas timestamptz con .gte(). Pasarles 'YYYY-MM-DD' las
//                        lee como medianoche UTC = 21:00 del día anterior en PY.
// ════════════════════════════════════════════════════════════════════

// Default correcto para todos los locales actuales. Solo se reemplaza si el local
// tiene otro `timezone` cargado.
export const TZ_DEFAULT = 'America/Asuncion';

let _tz = TZ_DEFAULT;

/** Zona horaria vigente del local. */
export function businessTZ() { return _tz; }

/** Fija la zona horaria del local (p.ej. al recibir la fila de `restaurants`). */
export function setBusinessTZ(tz) {
  if (typeof tz === 'string' && tz.trim()) _tz = tz.trim();
  return _tz;
}

/**
 * Lee `restaurants.timezone` y la fija. Best-effort: si falla (sin red, sin permiso,
 * columna vacía) se conserva el default, que ya es el correcto. Se llama una vez al
 * arrancar el panel; hasta que resuelve, los helpers devuelven el día en TZ_DEFAULT.
 */
export async function initBusinessTZ(db, restaurantId) {
  if (!db || !restaurantId) return _tz;
  try {
    const { data } = await db.from('restaurants')
      .select('timezone').eq('id', restaurantId).maybeSingle();
    if (data && data.timezone) setBusinessTZ(data.timezone);
  } catch (_) { /* se queda con el default */ }
  return _tz;
}

// 'en-CA' produce YYYY-MM-DD, que es el formato que espera Postgres para un DATE.
/** "Hoy" en el huso del local, como YYYY-MM-DD. */
export const todayLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: _tz });

/** Día del local (YYYY-MM-DD) de un timestamp cualquiera. '' si viene vacío. */
export const dayLocal = d => d ? new Date(d).toLocaleDateString('en-CA', { timeZone: _tz }) : '';

/** YYYY-MM-DD de un Date construido localmente, sin pasar por UTC. */
export const isoLocal = d =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Offset del huso `tz` respecto de UTC, en ms, para un instante dado. Se calcula
 * formateando el MISMO instante en ese huso y comparándolo contra su valor UTC, así
 * no hace falta ninguna tabla propia de husos ni de horario de verano.
 */
function tzOffsetMs(tz, at) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at).forEach(x => { p[x.type] = x.value; });
  // `hour` puede venir '24' en algunos motores para la medianoche.
  const asIfUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return asIfUTC - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * Instante ISO del comienzo del día comercial (00:00 en el huso del local).
 * Correcto aunque el navegador esté en otro huso — el dueño mirando desde afuera
 * sigue viendo el día del local, no el suyo.
 */
export function startOfDayISO(at = new Date()) {
  try {
    const day = new Date(at).toLocaleDateString('en-CA', { timeZone: _tz });
    const [y, m, d] = day.split('-').map(Number);
    // Medianoche del día del local expresada como si fuera UTC, menos el offset de
    // ese huso = el instante absoluto en que arrancó el día comercial.
    const midnightAsUTC = Date.UTC(y, m - 1, d, 0, 0, 0);
    return new Date(midnightAsUTC - tzOffsetMs(_tz, at)).toISOString();
  } catch (_) {
    // Respaldo: medianoche del navegador. Coincide con la del local siempre que el
    // dispositivo esté en el mismo huso, que es el caso normal en el salón.
    const f = new Date(at); f.setHours(0, 0, 0, 0); return f.toISOString();
  }
}
