# Mythos — Contexto para Agentes IA

> Ecosistema SaaS gastronómico multi-restaurante. Moneda: guaraní (₲).
> **Estado:** plataforma reseteada a fábrica el 2026-06-05 (migración 096) — sin restaurantes ni datos, solo planes/catálogo y el superadmin **Renato** (`Renaxto`, `restaurant_id = NULL`). Se cargan datos desde 0 para la primera simulación.
> Referencia extendida: `.claude/skills/mythos-context/SKILL.md` y `.claude/skills/mythos-ui/SKILL.md`.

---

## Stack

- **Frontend:** HTML + React 18 CDN + Babel Standalone. Sin bundler. CSS-in-JS inline + `design-system.css`.
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

1. **RLS con `USING(true)`** — *parcialmente mitigado*: el lado **autenticado** está aislado por restaurante (mig. 086) y el rol **anon** ya no filtra PII ni permite alterar pedidos ajenos (mig. 102). **Pendiente:** el resto de políticas `USING(true)` a nivel de fila (anon aún ve filas no-PII cross-tenant; tracking del cliente idealmente vía RPC `SECURITY DEFINER`).
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

---

## Reglas para agentes

- NO exponer `config.js` ni credenciales en ningún archivo commiteado.
- NO usar `service_role` key en código frontend — la creación de usuarios/riders ya pasa por el endpoint backend `/api/create-user` (no reintroducir `service_role` en el cliente).
- NO convertir a Vite / Next.js / Webpack — sin bundler por decisión arquitectónica.
- NO usar `import`/`export` — todo es `window.*` o scripts globales.
- NO borrar comentarios `/*EDITMODE-BEGIN*/` / `/*EDITMODE-END*/` (delimitan zonas de tweaks en vivo).
- **No hay restaurante por defecto.** El `RESTAURANT_ID` se resuelve siempre del contexto: `?r=` en la URL (QR/link), `localStorage.mythos_restaurant_id` (seteado al login), o `SUPABASE_CONFIG.restaurantId` (deploy de un solo local). El UUID `…0001` quedó **eliminado** como fallback (migración 096) — no volver a cablearlo.
- Cambios de DB siempre con **migración nueva numerada** (último número: ver `supabase/migrations/`).
- NO editar una migración existente — siempre crear una nueva.
- NO modificar RLS sin analizar impacto multi-restaurante.
- Modales de registro/edición: **cierre solo con ESC o botón X**, nunca click en overlay (pérdida de datos al seleccionar texto).
- Probar flujo cliente→cocina→mozo→caja cuando el cambio toca órdenes.
- Antes de commit+deploy de un bugfix que toque órdenes/cocina/mozo/caja/delivery: **reset DB** vía migración tipo `060_dev_reset_v2` (no borrar menú/usuarios/zonas/riders, sólo datos operativos).
- Branding: usar **"Mythos"** en toda UI visible. "Mesa App" es bug de branding.
- Dashboard Supabase: cambiar idioma a **inglés** antes de ejecutar SQL (el español auto-traduce keywords y rompe).

---

## Prioridades

1. **RLS multi-restaurante segura** (reemplazar el `USING(true)` restante a nivel de fila; anon-PII y escritura ya cerrados en mig. 102)
2. ~~**Gestión segura de usuarios** — mover Admin API a Edge Function~~ ✅ hecho (`/api/create-user`)
3. **Customers / CRM** — crear tabla y conectar UI existente
4. **Realtime tracking cliente** en `index.html` (mesa) — replicar patrón delivery
5. **QR real por mesa** con token único + expiración (parcial via `table_scan_sessions`)
6. **Pagos superadmin** — integrar Bancard / Tigo Money
7. **Factura electrónica SIFEN** (Paraguay)
8. **Moderación de ratings** (UI + flujo de aprobación)
