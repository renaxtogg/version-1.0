# Mythos — Contexto para Agentes IA

> Ecosistema SaaS gastronómico multi-restaurante. Moneda: guaraní (₲).
> **Estado:** reset a fábrica el 2026-06-05 (migración 096). Hoy en prod conviven: el superadmin **Renato** (`Renaxto`, `restaurant_id = NULL`), **Terrapizza** (demo/QA cargada a mano por Renato — **NO es cliente real**) y datos de simulacro (3 restaurantes `a1a1…/b2b2…/c3c3…` + 15 usuarios `@mythos.test`) pendientes de teardown guardado.
> **⚠️ Criterio de cuentas (FINAL 2026-06-16, instrucción de Renato):** actualmente **ninguna cuenta/restaurante en prod corresponde a un cliente real** (Terrapizza incluida). La **única cuenta oficial protegida** es `mancuellorenato@gmail.com`. Todo lo demás es demo/QA — candidato a futura rotación/desactivación/edición/eliminación — pero **NO se toca automáticamente**: cualquier acción sobre Auth o datos requiere **spec explícita + aprobación de Renato** (reversible primero; borrado definitivo solo en fase separada aprobada). Teardown sigue exigiendo **backup nuevo + dry-run revisado + aprobación explícita**. Ver `docs/audits/pr21c-demo-criterion-reconciliation.md`.
> **⚠️ SEGURIDAD — estado al 2026-08-01 (auditoría general):** el **Sprint 1 de RLS ya está aplicado** (migs **103** lockdown de escritura de `anon` + **104** tenant-scoping de `authenticated`), así que el aviso viejo de "no apta para clientes reales" **quedó saldado en lo que listaba**: `anon` ya no escribe `restaurants`, ni lee/escribe `payments` (cerrada además por la mig 194) ni `staff_payroll_adjustments`. Se sumó la mig **195**: `search_path` fijo en TODA función `SECURITY DEFINER` + `REVOKE CREATE ON SCHEMA public` a `anon`/`authenticated` (cerraba una escalada a superusuario vía shadowing — ver regla abajo). **Lo que sigue abierto** es el `USING(true)` a nivel de fila para `authenticated` en ~25 tablas (cross-tenant *interno*, entre locales; no expuesto a `anon`). Roadmap: `MYTHOS_PRESPRINT_REPORT.md` (su encabezado describe el estado de junio, leerlo con esta nota al lado).
> Referencia extendida: `.claude/skills/mythos-context/SKILL.md` y `.claude/skills/mythos-ui/SKILL.md`.

---

## Stack

- **Frontend:** HTML + React 18 + CSS-in-JS inline + `design-system.css`. **Migración a Vite COMPLETA:** los 10 paneles se editan en `src/<panel>/main.jsx` y Vite los precompila a `public/build/<panel>.js`. **`public/build/` está gitignored — lo reconstruye Vercel en cada deploy.** Ver regla "Build moderno" abajo.
- **Backend:** Supabase (PostgreSQL + Auth + Realtime + Storage + RLS).
- **Deploy:** Vercel estático (`outputDirectory: public/`).
- **Config:** `config.js` gitignored — credenciales via `window.SUPABASE_CONFIG`.
- **PWA / Offline:** `public/sw.js` (service worker) — caja imprime tickets 80mm sin internet.

---

## Paneles

| Archivo | Rol |
|---|---|
| `public/index.html` | Cliente QR (scan→menú→cart→pago→tracking→rating→factura) |
| `public/delivery-cliente.html` | Cliente delivery (pedido a domicilio, tracking en tiempo real) |
| `public/delivery-rider.html` | Panel rider (login por correo+contraseña, lista de pedidos, cambio de estado) |
| `public/cocina.html` | KDS cocina (kanban + estaciones de despacho con link compartible) |
| `public/mozo.html` | Panel mozo (mesas, transferencia entre mozos, filtro Mis/Todas) |
| `public/caja.html` | Panel caja (turnos, cobros, fondo fijo, facturación, modo offline) |
| `public/gerente.html` | Panel gerente (proveedores, personal, alertas, reportes) |
| `public/admin.html` | Admin local (menú, mesas, personal, stock, finanzas, alertas) |
| `public/superadmin.html` | Superadmin SaaS (restaurantes, planes, horarios, calendario, reportes) |
| `public/login.html` | Login unificado (redirige por rol) |
| `public/diag.html` | Diagnóstico de conexión / debug |
| `public/design-system.css` | Tokens CSS globales — importado por todos los paneles |
| `public/mythos-theme.js` | Toggle claro/oscuro persistente (localStorage) |
| `public/mythos-icons.js` | Set de íconos SVG inline reusables |
| `public/sw.js` | Service worker — caché para modo offline |

---

## Tablas principales

restaurants, tables (con `assigned_waiter`, `pos_x/y` virtuales, `zone`), menu_categories, menu_items, menu_item_extras, coupons, orders (con `requires_invoice`, `delivered_to_table_at`), order_items, order_item_extras, order_status_history, waiter_calls (con `metadata`), ratings, user_roles, turnos_caja, movimientos_caja, cancelaciones_caja, quejas_sugerencias, caja_config (fondo fijo), subscription_plans, subscriptions, payments, platform_events, ingredients, recipes, stock_movements, stock_alerts, stock_sessions (toma obligatoria por turno), expenses, delivery_orders (con `rider_status`, `cash_amount`), delivery_riders (con PIN), delivery_zones, reservations (con `zone`), employee_shifts, kitchen_stations, support_chat, table_scan_sessions, calendar_events, staff_requests, staff_broadcasts, invoice_request, staff_sessions (registro automático de login/logout de cada panel — migración 098, alimenta Personal→Turnos).

**Pendientes:** `customers` (CRM con UI ya existe — falta tabla), moderación de ratings.

**Status flow orders:** `draft → confirmed → paid → kitchen_received → cooking → ready → delivered`

**Status flow delivery (`delivery_orders.rider_status`):** `pending → confirmed → picked_up → on_way → delivered → cancelled`

**Status flow riders (`delivery_riders.current_status`):** `disponible → en_ruta → offline`

---

## Bugs críticos conocidos

1. **RLS con `USING(true)` a nivel de fila para `authenticated`** — ~25 tablas siguen sin filtro de tenant por fila: es cross-tenant **interno** (un usuario autenticado de un local podría alcanzar filas de otro), **no** superficie de `anon`. Es lo único que queda del bug crítico original. Lo demás **ya se cerró**: `anon` sin PII ni manipulación de pedidos (mig. 102), sin escritura de `restaurants` ni acceso a `payments`/`staff_payroll_adjustments` (mig. 103), `authenticated` aislado por restaurante (migs. 086 y 104), `payments` con RLS propia (mig. 194). Roadmap: `MYTHOS_PRESPRINT_REPORT.md`.
2. **Tracking cliente en `index.html`** — Realtime parcial; delivery sí tiene Realtime + polling fallback, mesa aún no.
3. **`customers` sin tabla** — UI de CRM existe pero datos no persisten.

**Resueltos recientemente (no revertir):**
- ~~`tables.is_occupied` no se actualizaba~~ — `fix(mesa+caja): mesa permanece ocupada hasta liberación explícita`
- ~~Caja sin logout / cierre de turno~~ — `fix(mozo): corregir deudas fantasma + mejorar cierre de turno`
- ~~Reservas en localStorage~~ — tabla `reservations` (migración 040) + selector de zona + verificación QR
- ~~Mozo mostraba "Cobro pte." con payment_status=paid~~ — `fix(mozo): no mostrar si ya paid`
- ~~Mesa "?" / Mesa "—"~~ — resuelto vía `table_scan_sessions` + `assigned_waiter` (migración 074, 076)
- ~~Cobro ₲0~~ — validación anti-pedido ₲0 en cliente (`fix(cliente): carrito persistente y validación`)
- ~~Cobro no se registraba por `requires_invoice` faltante~~ — migración 084 + fix mozo+caja
- ~~Dashboard admin con 0 pedidos (400 Bad Request)~~ — fix `customer_phone` en select (commit 9d94cee)
- ~~Pickup pagado aparecía como "A cobrar"~~ — auto-oculta 6min tras entrega cocina
- ~~Crear usuarios con `service_role` en frontend~~ — alta de usuarios/riders vía endpoint backend `/api/create-user` (token del usuario); el frontend ya **no** usa `service_role`.
- ~~Fuga de PII por la anon key + manipulación de pedidos ajenos~~ — migración **102** (`anon` pierde SELECT de columnas PII en orders/delivery_orders/restaurants y UPDATE/DELETE de pedidos; commit `dce8119`, 2026-06-08).
- ~~`subscriptions` legibles/escribibles por anon (`sa_subs_all USING(true)`)~~ — restringido a superadmin (`get_my_role()`).
- ~~`delivery_riders.rider_pin` expuesto a anon~~ — vaciado a NULL (login de rider = correo+contraseña).
- ~~Escalada a superusuario por `search_path` mutable en funciones `SECURITY DEFINER`~~ — migración **195** (2026-08-01).
- ~~Desactivar a un admin no le quitaba poderes~~ — faltaba `is_active=eq.true` en `create-user` / `manage-staff` / `set-admin-cedula`.
- ~~"Hoy" se calculaba en UTC~~ — a partir de las 21:00 de Paraguay el sistema cambiaba de día en plena cena (ver regla "Día comercial" abajo).
- ~~Reservas fantasma~~ — `dbSaveReservation` devolvía `{ok:true}` aunque el INSERT fallara y confirmaba al comensal una reserva que el local nunca recibía.
- ~~Reintento de INSERT de `orders` ante cualquier error~~ — degradaba el pedido (perdía `requires_invoice`/`payment_reference`) o lo duplicaba; ahora sólo reintenta si la columna no existe.

---

## Reglas para agentes

- NO exponer `config.js` ni credenciales en ningún archivo commiteado.
- **NUNCA hardcodear ni commitear secretos** (`service_role`, PATs, secret keys) en NINGÚN archivo — ni siquiera en archivos gitignored (`_simulacion/`, scripts locales): los archivos locales se sincronizan a OneDrive. Credenciales SOLO por variables de entorno (`$env:SUPABASE_PAT`, etc.). El PAT que estaba hardcodeado en `_simulacion/run.ps1` fue rotado el 2026-06-11.
- NO usar `service_role` key en código frontend — la creación de usuarios/riders ya pasa por el endpoint backend `/api/create-user` (no reintroducir `service_role` en el cliente).
- **Terrapizza es demo/QA de Renato, NO cliente real** (criterio FINAL 2026-06-16). Ninguna cuenta/restaurante en prod es cliente real. La **única cuenta oficial protegida** es `mancuellorenato@gmail.com` — esa **nunca se toca**. Todo lo demás (Terrapizza incluida) es demo/QA: **NO se borra ni modifica automáticamente**; cualquier limpieza de Auth/datos exige **spec explícita + aprobación de Renato** (preferir acciones reversibles —rotar/desactivar/bloquear— antes que borrar; eliminación definitiva solo en fase separada aprobada). Esto **NO** es autorización destructiva automática. Ver `docs/audits/pr21c-demo-criterion-reconciliation.md`.
- **Datos de simulacro** (restaurantes `a1a1…/b2b2…/c3c3…`, usuarios `@mythos.test`): solo se eliminan vía el teardown guardado, después de un backup, siguiendo `docs/security/SIMULATION_TEARDOWN_CHECKLIST.md`. Nunca con DELETEs ad-hoc.
- **Simulaciones futuras:** nombres de restaurantes con prefijo `[SIM]`, emails `@mythos.test`, runner con `SUPABASE_PAT`/`SUPABASE_PROJECT_REF` por env vars y guardas `ALLOW_PROD_SIMULATION=true` (para tocar prod) y `CONFIRM_SIMULATION_TEARDOWN=true` (para scripts destructivos). `_simulacion/run.ps1` ya implementa ambas guardas — no debilitarlas.
- **Build moderno (Vite) — migración COMPLETA.** La decisión histórica de "sin bundler / sin `import`-`export`" quedó reemplazada: **los 10 paneles** viven en `src/<panel>/main.jsx` con `import`/`export` y Vite los compila a `public/build/<panel>.js` (bundle IIFE) que el HTML referencia. **Editar SIEMPRE `src/<panel>/main.jsx`, nunca `public/build/*`** (está gitignored y lo regenera Vercel; un cambio ahí se pierde en el próximo deploy). Correr `npm run build` antes de commitear para verificar que compila. Seguimos **app estática** (sin Next/Remix); `outputDirectory` sigue `public/`. Las páginas sueltas de `public/` que NO son paneles (`web.html`, `registro.html`, `login.html`, `proveedores.html`, legales…) siguen siendo HTML+JS plano sin bundle — ahí sí mantener el patrón viejo (`window.*`, sin `import`/`export`).
- NO borrar comentarios `/*EDITMODE-BEGIN*/` / `/*EDITMODE-END*/` (delimitan zonas de tweaks en vivo).
- **No hay restaurante por defecto.** El `RESTAURANT_ID` se resuelve siempre del contexto: `?r=` en la URL (QR/link), `localStorage.mythos_restaurant_id` (seteado al login), o `SUPABASE_CONFIG.restaurantId` (deploy de un solo local). El UUID `…0001` quedó **eliminado** como fallback (migración 096) — no volver a cablearlo.
- **Día comercial: NUNCA `toISOString().slice(0,10)` para "hoy".** Devuelve la fecha **UTC** y desde las **21:00 de Paraguay ya es el día siguiente** → rompe en plena cena. Los helpers viven en **`src/shared/fecha.js`** (fuente única — no volver a copiarlos por panel, así fue como se desincronizaron). El huso sale de **`restaurants.timezone`** vía `initBusinessTZ(db, RID)` al arrancar el panel, con **`TZ_DEFAULT = America/Asuncion`** mientras carga o si el local no lo tiene: el comportamiento correcto es el default, no hay que configurar nada. Usar el que corresponde al **tipo de dato** (elegir mal es justo donde está la trampa): **`todayLocal()`** para columnas `DATE`, defaults y `min` de `<input type="date">`; **`dayLocal(ts)`** para comparar un timestamp de la DB contra "hoy"; **`isoLocal(d)`** para los extremos de un rango tipeado por el usuario (`to.setHours(23,59,59,999)` + `toISOString()` se iba **un día de más**); **`startOfDayISO()`** para `.gte()` sobre `timestamptz` (pasarles `'YYYY-MM-DD'` las lee como medianoche UTC = 21:00 del día anterior en PY). `superadmin` usa el módulo pero **no** llama `initBusinessTZ`: es transversal a todos los locales, su "hoy" es el de la plataforma. `index`/`delivery-cliente` leen `restaurant.timezone` del contexto de React (reactivo) — dejarlos así.
- Cambios de DB siempre con **migración nueva numerada** (última: **195**, ver `supabase/migrations/`).
- NO editar una migración existente — siempre crear una nueva.
- **Toda función `SECURITY DEFINER` nueva DEBE declarar `SET search_path = public, extensions, pg_temp`** (`pg_temp` siempre último). Sin eso hereda el `search_path` del llamador y quien pueda crear objetos en `public` shadowea una tabla sin calificar y ejecuta código como `postgres` — es el `function_search_path_mutable` del linter de Supabase. `extensions` va en la lista porque pgcrypto vive ahí. Si se olvida, re-correr la migración 195 (es idempotente y barre `pg_proc` entero).
- NO modificar RLS sin analizar impacto multi-restaurante.
- Modales de registro/edición: **cierre solo con ESC o botón X**, nunca click en overlay (pérdida de datos al seleccionar texto).
- Probar flujo cliente→cocina→mozo→caja cuando el cambio toca órdenes.
- Antes de commit+deploy de un bugfix que toque órdenes/cocina/mozo/caja/delivery: **reset DB** vía migración tipo `060_dev_reset_v2` (no borrar menú/usuarios/zonas/riders, sólo datos operativos).
- Branding: usar **"Mythos"** en toda UI visible. "Mesa App" es bug de branding.
- Dashboard Supabase: cambiar idioma a **inglés** antes de ejecutar SQL (el español auto-traduce keywords y rompe).

---

## Prioridades

1. **RLS multi-restaurante segura** — queda sólo el `USING(true)` a nivel de fila para `authenticated` (~25 tablas, cross-tenant interno). La superficie de `anon` ya está cerrada (migs. 102/103) y `authenticated` scopeado por tenant (migs. 086/104).
2. ~~**Gestión segura de usuarios** — mover Admin API a Edge Function~~ ✅ hecho (`/api/create-user`)
3. **Customers / CRM** — crear tabla y conectar UI existente
4. **Realtime tracking cliente** en `index.html` (mesa) — replicar patrón delivery
5. **QR real por mesa** con token único + expiración (parcial via `table_scan_sessions`)
6. **Pagos superadmin** — integrar Bancard / Tigo Money
7. **Factura electrónica SIFEN** (Paraguay)
8. **Moderación de ratings** (UI + flujo de aprobación)
