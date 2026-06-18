# FASE C · WS2-A — Auditoría funcional integral (mapa + prioridades)

> **Tipo:** AUDITORÍA. **Cero fixes, cero cambios de producto.** Inventario + severidad + PRs recomendados.
> Rama `audit/fase-c-ws2-functional-qa` (base `315a35c`). Programador: Claude Code. Arquitecto: ChatGPT.
>
> ⚠️ **Método y alcance honesto:** esta auditoría es **estática (lectura de código)** + consolidación de la
> evidencia de QA real ya recibida (WS1-B/C) y de los reportes del sistema. **No se ejecutó la app en vivo**
> (sin credenciales de prod en el entorno del programador). Por eso el **PASS/FAIL interactivo por flujo**
> (clicks, recarga real, atrás/adelante) queda para **QA real (Claude Web)** — acá se entrega el **mapa
> funcional, los hallazgos verificables por código y el checklist exacto que QA debe correr**. Lo marcado
> "needs-live-QA" no es un PASS afirmado: es "sin bug evidente en código, confirmar en vivo".

---

## 1. Resumen ejecutivo

- **Hallazgo funcional P1 confirmado por código:** `mozo.html` **no valida el rol** (acepta cualquier sesión autenticada → cualquier rol queda como "mozo"). Es el "pendiente conocido" que el propio WS2 pidió revisar. **Siguiente fix chico recomendado.**
- **Buenas noticias (bugs históricos ya mitigados en código, a re-confirmar en vivo en WS3):**
  - **"Pedido se resetea a 0 Gs al recargar"** → el cliente QR (`src/index`) **persiste carrito + total + screen + cupón** en `localStorage` con inicializadores reload-safe (líneas 1784–1823). El TDZ de `payTotal` se arregló en PR-5. → probablemente **resuelto**; WS3 lo re-verifica en vivo.
  - **"Tracking mesa sin Realtime"** (CLAUDE.md bug #2) → `src/index` **sí** tiene Realtime (`channel track-…` sobre `orders` UPDATE) **+ polling 10s** de fallback (líneas 1170–1183). → **CLAUDE.md está desactualizado** acá (coincide con el system report). 
- **Resto:** sin bugs funcionales evidentes en código; requieren confirmación interactiva (matriz §3 + checklist §6).
- **Carryovers ya ruteados:** emojis → WS5; consola/red (42501/PGRST116/uuid vacío) → WS6; RLS `USING(true)` cross-tenant autenticado → seguridad/WS6.

---

## 2. Guards de acceso por panel (verificado en código — base para QA)

| Panel | Cuenta demo | Guard de rol (fail-closed, `get_my_profile`) | Gating por plan (WS1-B) |
|---|---|---|---|
| `superadmin.html` | (Renato / superadmin demo) | `role === 'superadmin'` | n/a (plataforma) |
| `admin.html` | admin.* | `[admin, gerente, supervisor_local, superadmin]` | hub "Paneles" (soft) |
| `gerente.html` | gerente.* | `[gerente, supervisor_local, admin, superadmin]` | **fail-closed** `allowed_panels∋gerente` |
| `caja.html` | caja.* | `[admin, superadmin, cajero, cocina]` | en todos los planes |
| `cocina.html` | cocina.* | `[cocina, admin, superadmin]` | en todos los planes |
| `mozo.html` | mozo.* | ⚠️ **ninguno (solo exige sesión)** — **P1, §4** | en todos los planes |
| `delivery-rider.html` | rider1.* | ficha `delivery_riders.user_id = auth.uid()` | **fail-closed** `allowed_panels∋delivery-rider` |
| `index.html` (QR) | público (anon, `?r=&mesa=`) | n/a | n/a |
| `delivery-cliente.html` | público (anon, `?r=`) | n/a | **fail-closed** `restaurant_panel_enabled` (mig 109) |

---

## 3. Matriz funcional por panel (estado de código + qué confirmar en vivo)

Leyenda: **CODE-OK** = sin bug evidente en lectura de código; **needs-live-QA** = confirmar interactivo; **FLAG** = ver hallazgo.

| Panel | Flujos clave | Estado código | Flags / a confirmar en vivo |
|---|---|---|---|
| **Superadmin** | dashboard, salud, tabla restaurantes, activar/desactivar, MRR, planes/capabilities | CODE-OK | needs-live-QA: edición de plan persiste `allowed_panels/features`; MRR coherente; activar/desactivar refleja. |
| **Admin** | dashboard, mesas/floor-plan, personal (alta+clave ≥8 PR-5), config, hub paneles | CODE-OK | needs-live-QA: floor-plan con datos; alta de usuario por `/api/create-user`; `restaurant_settings` 406 ya mitigado (PR-9 `.maybeSingle()`). |
| **Gerente** | dashboard turno, calendario, reportes | CODE-OK | P3: `restaurants…eq(id,RID).single()` (L1339) → 406 si la fila del restaurante no existe (edge). needs-live-QA: reportes con datos. |
| **Caja** | apertura/cierre turno, salón, cobro, denominaciones, arqueo, offline | CODE-OK | needs-live-QA (alto valor): cobro real + recarga a mitad de cobro; cierre de turno; floor-plan dark con datos (riesgo residual FASE B). |
| **Cocina/KDS** | NUEVO/PREPARANDO/LISTO/ENTREGADO, timers, crítica/blink, estación | CODE-OK (Realtime+poll, PR-13) | needs-live-QA: kanban con pedidos reales; blink/timers; despacho por estación. |
| **Mozo** | mesas grid/mapa, toma de pedido, estados, item-card | **FLAG P1** (guard de rol) | P1 §4. needs-live-QA: toma de pedido + recarga; transferencia; floor-plan dark con datos. |
| **Delivery rider** | ruta activa/on_way, KitchenBadge, historial, asignaciones | CODE-OK | WS5: emojis 🛵/📦/📋 (incl. pantalla de bloqueo). needs-live-QA: cambio de estado, asignación. |
| **Cliente QR** | bienvenida, menú, carrito, **pago**, seguimiento | CODE-OK (persistencia + Realtime+poll) | needs-live-QA (WS3): recarga en cada paso (carrito/pago) **no** resetea a 0; tracking actualiza. |
| **Delivery cliente** | cobertura, menú, carrito, pago, tracking, rating | CODE-OK | needs-live-QA: pago + tracking + rating end-to-end; gate de plan (ya PASS en WS1-B). |

---

## 4. Hallazgos priorizados

### P1 — `mozo.html` sin allowlist de rol (cross-rol)
- **Repro (código):** `src/mozo/main.jsx` ~L503–523: el bootstrap solo verifica `getSession()`; si hay sesión, crea `mozo_session` con `session.user.id` **sin** chequear `profile.role`. No hay allowlist como en los demás paneles.
- **Cuenta/ruta:** cualquier cuenta demo (p.ej. `caja.napoli`, `cocina.napoli`, `rider1.carlos`) → abrir `/mozo.html` por URL directa.
- **Esperado:** rebote al login ("rol no autorizado"), como en gerente/caja/cocina.
- **Real (por código):** entra y queda operando como "mozo".
- **Severidad:** **P1** (consistencia de control de acceso; el dato sigue **tenant-scoped por RLS → sin fuga cross-tenant**, por eso no es P0). Lo flageó el propio brief de WS2 y el §5.3 de WS1.
- **Fix recomendado (chico, frontend):** agregar guard `['mozo','admin','supervisor_local','superadmin']` con `get_my_profile`, alineado a los otros paneles; rebote al login si no matchea. **← siguiente PR puntual sugerido (WS2-B).**

### P3 — `.single()` en lectura de restaurante por `RID`
- `src/gerente/main.jsx:1339` y `src/admin/main.jsx:9475`: `from('restaurants').select(...).eq('id',RID).single()` → si la fila del restaurante de la sesión no existe (edge: restaurante borrado/RID stale) devuelve **PGRST116/406** y puede romper el render.
- **Severidad:** P3 (edge). **Fix:** `.maybeSingle()` + default, patrón ya adoptado en PR-9. → agrupar en WS6 (consola/red) o en un fix menor.

### NO-BUG (documentado para no re-levantar)
- **CRM / `customers` sin tabla:** PR-6 confirmó que "Clientes" de admin es **analítica read-only derivada de `orders`** (honesta), no CRUD falso; `admin:crm` es paywall. **No es bug funcional.**
- **0 Gs / tracking mesa:** ver §1 — mitigados en código; CLAUDE.md bug #2 quedó desactualizado.

---

## 5. Ruteo a otros workstreams

| Tema | Severidad | WS destino |
|---|---|---|
| `mozo.html` guard de rol | P1 | **WS2-B (fix chico)** — recomendado ya |
| Re-verificar 0 Gs / persistencia de carrito-pago en vivo + doble submit/atrás-adelante | P1 (histórico) | **WS3** (regresión) |
| `.single()` → `.maybeSingle()` en lecturas opcionales (restaurante por RID, settings) | P3 | **WS6** (consola/red) o fix menor |
| Consistencia visual light/dark con datos reales (floor-plans Caja/Mozo) | P2 | **WS4** (consistencia visual) |
| Emojis (rider 🛵/📦/📋 y barrido global) | P2 | **WS5** (purga de emojis) |
| Consola/red: `42501`, `PGRST116`, `uuid vacío` | P2 | **WS6** (consola limpia) |
| RLS `USING(true)` cross-tenant autenticado (~25 tablas) | P1 seguridad | seguridad / fuera de WS2 funcional (Sprint RLS) |

---

## 6. Qué debe validar QA real (Claude Web) — checklist interactivo

Cuentas demo (`Mythos2026!`), preview o prod-con-cuidado. Por cada flujo: flujo feliz + **recarga en punto crítico** + atrás/adelante + consola/red. Registrar PASS/FAIL/BLOCKED.

**P1 dirigido (mozo guard):**
- [ ] Loguear `caja.napoli` (cajero) → abrir `/mozo.html` por URL directa → **debe** rebotar al login. (Hoy se espera FAIL → confirma el P1.)

**Por panel (flujo feliz + recarga):**
- [ ] **Superadmin:** editar un plan (toggle un panel en `allowed_panels`) → guardar → recargar → persiste. Activar/desactivar un restaurante. MRR no rompe.
- [ ] **Admin (Don Carlos):** dashboard carga; floor-plan con mesas; alta de empleado con clave ≥8; recargar en config no pierde estado.
- [ ] **Gerente (Don Carlos):** dashboard de turno con datos; reportes; calendario.
- [ ] **Caja (Don Carlos):** abrir turno → **cobro real** → recargar a mitad → estado consistente; arqueo/denominaciones; cerrar turno.
- [ ] **Cocina (Don Carlos):** con pedidos reales, mover NUEVO→…→ENTREGADO; timers/blink; despacho por estación.
- [ ] **Mozo (Don Carlos):** tomar pedido → recargar → mesa/pedido persiste; transferencia; estados de mesa.
- [ ] **Rider (Don Carlos):** marcar on_way/entregado; historial; KitchenBadge.
- [ ] **Cliente QR (`index.html?r=…&mesa=`):** armar carrito → **recargar en paso de pago** → total **NO** vuelve a 0; seguir a pago; tracking actualiza (realtime/poll).
- [ ] **Delivery cliente (Pro/Enterprise):** cobertura → carrito → pago → tracking → rating.

**Transversal:** consola sin errores rojos en flujos felices; sin datos cruzados entre restaurantes; recarga nunca pierde sesión/turno/carrito.

---

## 7. Definición de hecho WS2-A
- [x] Mapa funcional completo por panel (§2/§3).
- [x] Bugs priorizados por severidad (§4) con ruteo (§5).
- [x] No se mezcló todo en un mega-fix (cero fixes; solo doc).
- [x] `npm run build` PASS.
- [x] El arquitecto puede decidir el siguiente PR puntual → **WS2-B: guard de rol en `mozo.html`** (P1, chico).

> **Pendiente real para PASS pleno de WS2:** la verificación **interactiva** del checklist §6 por **QA real**.
> Esta WS2-A entrega el mapa y la priorización; el PASS/FAIL por flujo lo cierra Claude Web.

---

## 8. WS2-B — Fix: guard de rol en `mozo.html`

### 8.1 Bug corregido
`mozo.html` no tenía allowlist de rol (§4 P1): cualquier sesión autenticada (cajero/cocina/rider) que abriera
`/mozo.html` por URL directa quedaba operando como "mozo". Tenant-scoped por RLS (sin fuga cross-tenant), pero
hueco de control de acceso por rol.

### 8.2 Archivo tocado
`src/mozo/main.jsx` (solo el bootstrap de auth + el gate de render). **Sin tocar Auth/RLS/DB/planes/UI ni los flujos de mozo.** Patrón alineado a gerente/caja/cocina (`get_my_profile` + allowlist, fail-closed).
- Nuevo estado `authOk` (el panel monta solo cuando el guard confirmó).
- Guard reescrito: corre `get_my_profile` y valida rol **siempre** (aun con `mozo_session` cacheada en localStorage, para que una sesión vieja no saltee el chequeo). Si el rol no está permitido → limpia `mozo_session` y `window.location.replace('login.html')` (login reenvía la sesión activa al panel correcto de su rol).
- Gate de render: `if (!mozoSession || !authOk)` reutiliza la pantalla existente "Verificando sesión..." (sin UI nueva) → el panel y sus datos no se muestran hasta confirmar el rol.

### 8.3 Roles
- **Permitidos:** `mozo`, `admin`, `supervisor_local`, `superadmin`.
- **Bloqueados:** `cajero`, `cocina`, `rider`, rol desconocido, sin perfil, sesión inválida → redirige a login.

### 8.4 Comportamiento
- Rol permitido → `/mozo.html` carga igual que antes (breve "Verificando sesión..." y luego el panel).
- Rol bloqueado → no monta el panel ni sus datos; redirige a login → login lo manda a su propio panel. Sin errores rojos de consola.

### 8.5 Riesgo residual
- Caso borde (navegador con `mozo_session` viejo de antes del fix): durante el redirect (~ms) los efectos de datos —gateados por `mozoSession`— podrían disparar lecturas **RLS-protegidas del propio tenant** antes de navegar; **no se renderiza el panel** (gate `authOk`) y no hay fuga cross-tenant. El caso común (rol equivocado sin `mozo_session`) ni siquiera dispara esas lecturas.
- Sigue siendo guard de **frontend** (consistente con los demás paneles). El refuerzo backend del acceso por rol es tema del sprint de seguridad, no de WS2.

### 8.6 Verificación requerida (QA real)
**Debe PERMITIR (carga normal):**
- [ ] `mozo.*@mythos.test` → `/mozo.html`
- [ ] `admin.*@mythos.test` → `/mozo.html`
- [ ] `gerente.*@mythos.test` (rol `supervisor_local`) → `/mozo.html`

**Debe BLOQUEAR (redirige a login / no monta panel):**
- [ ] `caja.*@mythos.test` → `/mozo.html`
- [ ] `cocina.*@mythos.test` → `/mozo.html`
- [ ] `rider1.*@mythos.test` → `/mozo.html`

`npm run build` PASS (9/9). **Requiere QA real** (las 6 verificaciones). Recomendación: mergear WS2-A+WS2-B juntos tras QA PASS de estos 6 casos.
