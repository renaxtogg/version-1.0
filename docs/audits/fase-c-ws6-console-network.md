# FASE C / WS6-A — Auditoría de consola y red limpia

> **Objetivo:** inventariar y limpiar ruido **seguro** de consola/red en frontend, sin cambiar
> comportamiento, payloads, rutas, permisos ni lógica de negocio. Dejar una rama auditable para
> preview + QA real en navegador.
> **Rama:** `fix/fase-c-ws6-console-network-audit` (base `main` @ `df4321a`).
> **Reglas:** sin tocar Auth real / Google Maps / Bancard / facturación / DB·RLS·RPC·migraciones.
> Lo que requiera backend/security/RLS se **documenta como pendiente**, no se parchea aquí.

---

## 1. Resumen

- **Inventario:** 33 sentencias `console.*` en 6 de los 9 bundles `src/`. **0** `debugger`.
  `alert(` solo en superadmin (validaciones de UI intencionales, no ruido). **0** ruido en el
  chrome público no-bundle (login.html, diag.html, sw.js, `mythos-*.js`).
- **Cambio de producto aplicado:** **1 línea** — se elimina un `console.log` de éxito en admin
  que se disparaba en cada carga del dashboard e imprimía el `RID`.
- **Conservado:** 32 sentencias — todas son diagnósticos de error en `catch` o warns
  best-effort intencionales (auto-assign de rider, fallback de menú). Ninguna es ruido de
  desarrollo puro.
- **Pendiente fuera de alcance:** el ruido recurrente del **auto-assign de rider** tiene causa
  raíz en **RLS** (el cliente anónimo no puede `UPDATE delivery_orders`). Se documenta como
  **WS6-B / security**, no se silencia (escondería que los pedidos quedan sin rider).

---

## 2. Archivos tocados

| Archivo | Cambio |
|---|---|
| `src/admin/main.jsx` | Eliminado 1 `console.log` de desarrollo (carga de pedidos + RID) |
| `docs/audits/fase-c-ws6-console-network.md` | Este documento (nuevo) |

> Sin cambios en otros 8 paneles ni en scripts públicos. `public/build/` es gitignored
> (Vercel compila de `src/`).

---

## 3. Inventario completo de `console.*` (33) + clasificación

### Categoría A — Ruido de desarrollo removible (ELIMINADO)

| Archivo:línea | Sentencia | Por qué |
|---|---|---|
| `admin/main.jsx:9490` | `console.log('[admin] orders loaded:', rawOrds.length, '\| RID:', RID)` | Log de **éxito** en cada carga del dashboard; imprime conteo + `RID` en consola. No es error, no afecta UX. **ELIMINADO.** |

### Categoría B — Warns/info best-effort intencionales (CONSERVADO)

Auto-assign de rider (creado/ajustado en WS3 — el pedido se crea igual; el warn señala que no
se pudo asignar rider). **Causa raíz = RLS** → ver §5.

| Archivo:línea | Sentencia |
|---|---|
| `delivery-cliente/main.jsx:233` | `console.warn('[delivery] auto-assign (best-effort) no pudo buscar riders:', …)` |
| `delivery-cliente/main.jsx:234` | `console.warn('[delivery] auto-assign: no hay riders disponibles para', …)` |
| `delivery-cliente/main.jsx:261` | `console.warn('[delivery] auto-assign no disponible (best-effort)…', updErr.message)` |
| `delivery-cliente/main.jsx:263` | `console.info('[delivery] auto-assign: rider asignado OK →', …)` |
| `delivery-cliente/main.jsx:266` | `console.warn('[delivery] auto-assign (best-effort) excepción…', …)` |
| `cocina/main.jsx:489` | `console.warn('Auto-assign rider error:', e)` |
| `cocina/main.jsx:500` | `console.warn('auto-assign:', e)` (`.catch`) |
| `cocina/main.jsx:1371` | `console.warn('auto-assign:', e)` (`.catch`) |
| `index/main.jsx:71` | `console.warn('Supabase menu load failed, using static data')` (fallback informado) |
| `cocina/main.jsx:82` | `console.warn('logStationAction', e)` (best-effort de logging de estación) |
| `cocina/main.jsx:426` / `:444` / `:516` | `console.warn('Advance/Dismiss/Dismiss delivery error:', e)` (catch best-effort) |
| `superadmin/main.jsx:3745` | `console.warn('Error cargando datos:', e)` (catch) |

### Categoría C — Diagnósticos de error reales en `catch`/error-branch (CONSERVADO)

Necesarios para diagnóstico; varios ya acompañados de feedback al usuario (`showToast`). No se
ocultan (regla: no esconder errores reales).

| Archivo:línea | Sentencia |
|---|---|
| `admin/main.jsx:4848` | `console.error(e)` (catch genérico) |
| `admin/main.jsx:9484-9486` | `console.error('[admin] orders/tables/restaurants error \| code… message…')` (errores de query Supabase) |
| `cocina/main.jsx:61` | `console.error('loadStationConfig', e)` |
| `cocina/main.jsx:357` | `console.error('dbLoadTickets error:', error)` |
| `cocina/main.jsx:1376` | `console.error('fetchAndAddTicket:', e)` |
| `delivery-cliente/main.jsx:212` | `console.error('[delivery] delivery_orders insert error:', …)` |
| `index/main.jsx:111` | `console.error('Order insert error:', orderErr)` |
| `index/main.jsx:120` | `console.error('order_items insert error:', itemErr)` |
| `index/main.jsx:123` | `console.error('order_item_extras insert error:', extErr)` |
| `mozo/main.jsx:768` | `console.error('loadData error:', e)` |
| `mozo/main.jsx:1061` | `console.error('createOrder error:', error)` |
| `mozo/main.jsx:1183` | `console.error('loadHistorial error:', e)` |
| `mozo/main.jsx:1240` | `console.error(newErr)` (+ `showToast('Error al crear orden')`) |
| `mozo/main.jsx:1260` | `console.error(error)` (+ `showToast('Error al agregar')`) |
| `mozo/main.jsx:1385` | `console.error(error)` (+ `showToast('Error al notificar a caja')`) |
| `mozo/main.jsx:1500` | `console.error('processPay error:', e)` |

### `alert(` — UX intencional (CONSERVADO, no es ruido)

| Archivo:línea | Uso |
|---|---|
| `superadmin/main.jsx:2308/2309` | Validación de formulario de reportes ("Seleccioná un tipo", "Fechas inválidas") |
| `superadmin/main.jsx:2315` | Error de generación de reporte (`'Error: '+e.message`) |
| `superadmin/main.jsx:2555` | "SheetJS no disponible" (export Excel) |

> `mozo/main.jsx:637` contiene la palabra "alert" **solo en un comentario** (no es una llamada).

---

## 4. Cambios aplicados

- **Eliminado** `src/admin/main.jsx:9490` (`console.log` de éxito con `RID`). Es la única sentencia
  de desarrollo no accionable; su retiro no cambia comportamiento, UX ni flujo (la línea era
  independiente entre `const rawOrds=…` y `const orderIds=…`).

**No se aplicó** ninguna otra modificación de producto: no se silenciaron warns/errores, no se
tocó RLS/red, no se cambiaron payloads/rutas/permisos/capabilities.

---

## 5. Caso especial (WS3) — auto-assign de rider → pendiente WS6-B / security

El bloque `dbAutoAssignRider` (delivery-cliente) y su equivalente en cocina son **best-effort por
diseño**: el pedido se crea aunque la asignación falle. El warn de `:261`
(`auto-assign no disponible…`) se dispara cuando **RLS** rechaza el `UPDATE delivery_orders` del
cliente anónimo (`permission denied`). En prod esto ocurre de forma recurrente hasta que exista
una policy/flujo backend para asignar rider.

- **NO se silencia en WS6-A:** esconderlo ocultaría que los pedidos quedan sin rider asignado
  (condición operativa real). El warn es informativo y ya está documentado inline.
- **NO se toca RLS en WS6-A** (regla de la rama).
- **Frontend revisado:** el bloque no genera ruido evitable (sin logs duplicados ni spam en el
  happy-path; cada rama loguea una vez). El `console.info` de éxito (`:263`) es de baja frecuencia.
- **Pendiente WS6-B / security:** la solución correcta es habilitar la asignación por una vía
  autorizada (RLS policy para rol autenticado, o mover el auto-assign a un endpoint/RPC backend).
  **No parchear a ciegas.** (Coincide con el ruteo de WS3: "auto-assign rider RLS → WS6/security".)

---

## 6. Red (network) — para verificar en QA

El análisis estático no observa requests en vivo; se listan los esperables para confirmar en QA:

- **PATCH `delivery_orders` → 401/403 (permission denied)** en el flujo de pedido delivery del
  cliente (auto-assign bloqueado por RLS). **Esperado / best-effort** — el pedido se crea igual.
  Ruteado a WS6-B/security (§5).
- Errores de carga de catálogo en `index` caen a **menú estático** con un `console.warn`
  informativo (`:71`) — verificar que la UX no se rompe si Supabase no responde.
- Otros 400/406 históricos de paneles ya fueron resueltos en PRs previos
  (restaurant_settings `.maybeSingle` PR-9, staff_sessions 401 PR-8, admin stock 400 PR-7) —
  confirmar que **no reaparecen**.

> Cualquier hallazgo de red nuevo que implique RLS/backend se documenta como pendiente
> (WS6-B/security), no se arregla en esta rama.

---

## 7. Conservado intencionalmente

- Todos los `console.error` de `catch`/error-branch (diagnósticos reales).
- Los warns best-effort de auto-assign y fallback de menú.
- Los `alert()` de validación/UX de superadmin.

Razón: son accionables o señalan estado operativo real; eliminarlos escondería errores que el
usuario/operador debe poder ver, o que el dev necesita para diagnóstico.

---

## 8. Pendientes fuera de alcance

| Tema | Estado |
|---|---|
| Auto-assign rider bloqueado por RLS (PATCH delivery_orders) | **WS6-B / security** (RLS policy o endpoint backend) |
| RLS `USING(true)` cross-tenant restante (authenticated) | Security sprint (fuera de FASE C) |
| Downgrade del `console.info` de éxito de auto-assign (`:263`) | Candidato menor — solo si se rehace el bloque en WS6-B |

---

## 9. Checklist de QA real (para Claude Web)

Abrir DevTools → **Console** y **Network** en el preview, recorrer cada panel y confirmar:

1. **QR/index:** cargar menú, agregar al carrito, pagar. Consola sin logs de desarrollo;
   si Supabase falla, debe verse el warn de fallback a menú estático (informativo) y la UI
   sigue usable. Insert de orden sin errores en el happy-path.
2. **delivery-cliente:** crear un pedido **delivery**. Esperado: el pedido se crea; en Network
   puede aparecer un PATCH a `delivery_orders` con 401/403 (auto-assign best-effort) + un
   `console.warn` informativo. **Eso es esperado** (pendiente WS6-B). Sin `console.error` fatal.
3. **delivery-rider:** login + lista de pedidos + cambio de estado. Consola limpia salvo
   diagnósticos de error reales si algo falla.
4. **mozo:** cargar mesas/órdenes, crear orden, cobrar, notificar a caja. Los errores muestran
   `showToast` al usuario; la consola no debe tener logs de desarrollo sueltos.
5. **caja:** turnos, cobro, reservas. Consola sin ruido de desarrollo.
6. **cocina (KDS):** tickets, avanzar/dismiss, delivery. Los warns de auto-assign son
   best-effort (esperados si hay delivery). Sin errores fatales en el happy-path.
7. **admin:** abrir dashboard. **Confirmar que YA NO aparece** `[admin] orders loaded: … | RID:`
   en consola (era el log eliminado). Los `console.error` de query solo deben verse si una
   query realmente falla.
8. **gerente:** reportes/calendario/soporte. Consola limpia.
9. **superadmin:** restaurantes/planes/reportes. Los `alert()` de validación son UX esperada
   (tipo de reporte, fechas, SheetJS). Sin logs de desarrollo.
10. **login / diag:** sin ruido de consola (no tienen `console.*`).
11. **Transversal:** ningún `debugger`; ningún `console.log` de desarrollo; los errores visibles
    corresponden a fallas reales (no a logs decorativos). Anotar cualquier 400/406/401 nuevo
    para evaluar si es pendiente de security.

---

## 10. Build

- `npm run build` → **PASS** (9/9, exit 0). `public/build/` gitignored.

---

## Criterio de salida WS6-A

- ✅ Build PASS.
- ✅ Inventario claro (33 `console.*` clasificados; 0 `debugger`; `alert(` mapeado).
- ✅ Sin cambios de lógica (solo se eliminó 1 `console.log` de desarrollo).
- ✅ Rama lista para preview + QA real de consola/red.
- ➡️ Pendiente ruteado: auto-assign rider (RLS) → **WS6-B / security** (no tocado aquí).

---

## WS6-A2 — Fix de red: Gerente "Caja en vivo" / Reportes (400 columna inexistente)

El QA real de WS6-A (2026-06-19, preview `e17b7d8`) dio **FAIL** por un **request 400 real**
en el panel **Gerente** (consola por lo demás limpia code+runtime en los 11 paneles, y los 400/406/401
históricos confirmados resueltos). Este sub-fix es **frontend-only** (no toca DB/RLS/RPC/migraciones/Auth).

### QA FAIL recibido

| Campo | Detalle |
|---|---|
| Panel/sección | Gerente (Parrilla Don Carlos / Enterprise) → "Caja en vivo" / carga del panel |
| Request | `GET /rest/v1/orders?select=…,table_id,table_number,created_at,…` |
| Respuesta | `400` · `{"code":"42703","message":"column orders.table_number does not exist"}` |
| Asociado | `GET /rest/v1/order_items?select=id,order_id,name,quantity` → `400` (columna `name` inválida) |
| Síntoma | Falla **silenciosa** (sin consola/toast); la sección no carga datos completos |
| Severidad | P2 — bloqueante de WS6-A |

### Causa raíz

1. **`orders.table_number` no existe.** El número de mesa vive en `tables.number` (FK `orders.table_id`).
   Dos queries del panel pedían `table_number` sobre `orders` y por eso **400** (Postgres `42703`):
   - `src/gerente/main.jsx:288` — load del **Dashboard del turno** (corre en `setInterval`; es la query
     que capturó el QA: `…table_id,table_number,created_at,paid_at,confirmed_at,payment_status`).
   - `src/gerente/main.jsx:1201` — load de **Reportes del día** (mismo bug; aquí `table_number` ni
     siquiera se usa en la UI).
2. **`order_items.name` y `order_items.price` no existen.** El esquema (`migración 001`) define
   `item_name`, `unit_price`, `total_price`. `src/gerente/main.jsx:1202` pedía `name` y `price`
   → 400. Todos los demás paneles (caja/admin) usan `item_name`/`unit_price`.
3. **Bonus latente:** la query de Reportes (`:1201`) **no** seleccionaba `payment_status`, que la
   lógica PR-16 ya lee (`o.payment_status==='paid'`). Estaba enmascarado porque la query 400-eaba
   entera. Se agrega la columna para que la sección cargue **correcta** (no se cambia la lógica/filtro,
   solo se le provee su columna).

### Fix aplicado (frontend-only, `src/gerente/main.jsx`)

| Línea | Antes | Después |
|---|---|---|
| 288 (orders, Dashboard) | `select('id,total,status,order_type,table_id,table_number,created_at,paid_at,confirmed_at,payment_status')` | `select('id,total,status,order_type,table_id,created_at,paid_at,confirmed_at,payment_status')` (sin `table_number`) |
| 297-301 (setData Dashboard) | `orders: o.data\|\|[]` | resuelve `table_number` desde las `tables` ya cargadas: `orders: (o.data\|\|[]).map(ord => ({...ord, table_number: tblNum[ord.table_id] ?? null}))` (sin request extra; `mesaLabel` sigue usando `o.table_number`) |
| 1201 (orders, Reportes) | `select('…,table_id,table_number,waiter_id,waiter_name,created_at,paid_at,confirmed_at')` | `select('…,table_id,waiter_id,waiter_name,created_at,paid_at,confirmed_at,payment_status')` (sin `table_number`, **+`payment_status`**) |
| 1202 (order_items, Reportes) | `select('id,order_id,name,quantity,price')` | `select('id,order_id,name:item_name,quantity,price:unit_price')` (alias PostgREST → la UI sigue leyendo `it.name`/`it.price` sin cambios) |
| 297 / 1206 (manejo de error) | `setData(…)` directo | `if (o.error) console.error('[gerente] … orders load error:', o.error.message)` antes del `setData` |

**Decisiones de diseño:**
- **`table_number` del Dashboard** se resuelve client-side con el map de `tables` (ya en el mismo
  `Promise.all`) → **no** se agrega request ni embed, se conserva el shape `o.table_number` que espera `mesaLabel`.
- **`order_items`** se corrige con **alias** (`name:item_name`, `price:unit_price`) para no tocar el
  render (`itemMap[it.name]`, `it.price*it.quantity`) — mismo shape de datos para la UI.
- **Falla silenciosa:** se añade un `console.error` **solo ante error real** de la query de orders
  (patrón idéntico al de admin). En el camino exitoso la consola queda **limpia** (no spam). No se
  oculta ningún error real ni se cambia la UX del happy-path.
- **No** se tocó lógica de negocio, filtros, RLS, payloads de escritura, rutas ni permisos.

### `order_items.name` — corregido (con evidencia)

Confirmado contra `supabase/migrations/20260429_001_schema.sql:148-158`: `order_items` tiene
`item_name`, `unit_price`, `total_price` (no `name` ni `price`). Verificado además que **todos**
los demás paneles usan `item_name`/`unit_price` (`caja:856/2532/4017`, `admin:788/1173/5614/5661/6743`).
→ Se corrigió a `item_name`/`unit_price` vía alias.

### Verificación esperada (re-QA)

- Gerente → **Dashboard del turno** y **Reportes del día**: la query a `orders` responde **200**
  (sin `42703`); el número de mesa aparece en "Pedidos en cocina" (`mesaLabel`).
- Gerente → **Reportes del día**: `order_items` responde **200**; "Top productos del día" lista
  productos con cantidades; "Ventas hoy" refleja `payment_status='paid'` (antes 0 por el 400).
- Consola: **0 mensajes** en el happy-path; un `console.error` **solo** si una query realmente falla.
- Sin nuevos 400/406/401 en el resto del panel; sin regresión en los demás paneles (build 9/9).

### Pendiente WS6-B / security (sin cambios)

- **Auto-assign rider / RLS:** sigue ruteado a WS6-B/security (§5). No se ejerció en el QA (requiere
  flujo de cliente con QR de mesa). No bloquea WS6-A2.

### Fuera de alcance (anotado por el QA, no se toca aquí)

- **Login `superadmin.demo@mythos.test` → "Database error querying schema":** error de capa **auth/DB**
  (Auth real explícitamente excluido de WS6). La cuenta `qa.superadmin@mythos.test` entra OK. Se deja
  para **WS6-B/security** o revisión del seed del demo. No bloquea WS6-A2.

### Build

- `npm run build` → **PASS** (9/9, exit 0).
