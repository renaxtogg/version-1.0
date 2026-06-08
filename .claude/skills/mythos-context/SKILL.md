# Mythos Context — Skill de contexto del proyecto

Cuando esta skill se activa, tenés el contexto completo del proyecto antes de tocar cualquier archivo.
Leé todo antes de escribir una sola línea de código.

---

## Identidad

**Mythos** — SaaS gastronómico multi-restaurante. Moneda: guaraní (₲).
Plataforma reseteada a fábrica (migración 096): sin restaurante demo. Cada
negocio carga sus propios datos desde 0. No cablear "La Huaca" ni el UUID `…0001`.
Repo: `github.com/mancuellorenato/version-1.0`
Deploy: Vercel (auto desde `main`).

---

## Stack — reglas duras

| Regla | Razón |
|---|---|
| HTML + React 18 CDN + Babel Standalone | Sin bundler por decisión de arquitectura |
| Sin `import`/`export` | Todo es `window.*` o script global |
| Sin Vite / Next.js / Webpack | No convertir bajo ninguna circunstancia |
| Supabase JS v2 UMD | `window.supabase.createClient()` |
| CSS custom properties + inline JSX | Sin Tailwind, sin CSS modules |
| `config.js` gitignoreado | Credenciales via `window.SUPABASE_CONFIG` |
| Sin `service_role` en frontend | Riesgo crítico — usar Edge Function |
| Service Worker `sw.js` | PWA / modo offline para impresión de tickets |

---

## Paneles existentes

| Archivo | Rol | Notas |
|---|---|---|
| `public/index.html` | Cliente QR | Móvil. menú→pedido→pago→tracking→rating→factura. Carrito persistente. |
| `public/delivery-cliente.html` | Cliente delivery | Pedido a domicilio + tracking en tiempo real. Phone-wrapper desktop. Google Places autocomplete. |
| `public/delivery-rider.html` | Panel rider | Login por PIN, lista de pedidos asignados, auto-asignación al entrar en cocina, vuelto en efectivo, Realtime + polling fallback. |
| `public/cocina.html` | KDS cocina | Kanban en tiempo real. Estaciones de despacho con link compartible. Dark theme. Despacho separado de entrega física. |
| `public/mozo.html` | Panel mozo | Mapa de zonas drag-and-drop, filtro Mis/Todas, transferencia de mesas con notificación, mozo asignado por mesa, estadísticas turno por método. |
| `public/caja.html` | Panel caja | Turnos, cobros, fondo fijo apertura/cierre, secciones por tipo (Salón/Llevar/Retirar), facturación con selector de comprobante, ticket 80mm, modo offline. |
| `public/gerente.html` | Panel gerente | Proveedores, alertas de personal, solicitudes de incorporación, chat de soporte. |
| `public/admin.html` | Admin local | Menú (selección múltiple), mesas, personal, stock con toma obligatoria por turno, finanzas, dashboard con alertas, módulo Proveedores, calendario de eventos. |
| `public/superadmin.html` | Superadmin SaaS | Restaurantes, planes, horarios (abierto/cerrado), suscripciones, calendario, reportes (PDF/Excel/CSV), dev tools (reset + ambiente simulado). |
| `public/login.html` | Login unificado | Redirige por rol. Diseño de referencia validado. |
| `public/diag.html` | Diagnóstico | Conexión Supabase, debug rápido. |
| `public/design-system.css` | Tokens CSS globales | Importado por todos los paneles. |
| `public/mythos-theme.js` | Toggle claro/oscuro | Persistente en localStorage. Aplica `data-theme="dark"`. |
| `public/mythos-icons.js` | Set de íconos SVG inline | Reusable en todos los paneles. |
| `public/sw.js` | Service worker | Modo offline para impresión de tickets en caja. |

---

## Variables críticas en código

```js
RESTAURANT_ID = '00000000-0000-0000-0000-000000000001'  // fijo en todos los paneles
TABLE_NUM = parseInt(URLParams.get('mesa') || '4')       // index.html
window.SUPABASE_CONFIG = { url, anonKey, restaurantId }  // inyectado por config.js
```

NO modificar el `RESTAURANT_ID` hardcodeado. Si necesitás multi-tenant real, es una tarea separada de RLS.

---

## Status flows

**Órdenes (`orders.status`):**
`draft → confirmed → paid → kitchen_received → cooking → ready → delivered`
- Cocina ve: `paid` / `kitchen_received` → "nuevo" | `cooking` → "preparando" | `ready` → "listo"
- El cliente crea la orden con `status='paid'` directo (sin confirmed intermedio en el flujo actual).
- Caja cobra órdenes en estado `paid` / `cooking` / `ready`.
- **Despacho de cocina ≠ entrega física a la mesa** — `delivered_to_table_at` es timestamp separado (fix `8730dce`).

**Delivery — rider status (`delivery_orders.rider_status`):**
`pending → confirmed → picked_up → on_way → delivered → cancelled`
- `pending`: orden creada, sin rider asignado.
- `confirmed`: rider auto-asignado al entrar en cocina (round-robin).
- `picked_up`: rider tomó el pedido (alias interno).
- `on_way`: rider inició ruta — cliente ve "En camino".
- `delivered`: rider confirmó entrega — pero permanece en "A cobrar" en caja hasta cobro efectivo.

**Riders (`delivery_riders.current_status`):**
`disponible → en_ruta → offline`

---

## Tablas — referencia completa

**Core:** restaurants, tables (con `assigned_waiter`, `pos_x/y`, `zone`, `shape`), menu_categories, menu_items, menu_item_extras, coupons.

**Órdenes:** orders (con `requires_invoice`, `delivered_to_table_at`), order_items, order_item_extras, order_status_history, waiter_calls (con `metadata`), ratings.

**Auth & roles:** user_roles, staff_requests, staff_broadcasts (avisos internos).

**Caja:** turnos_caja, movimientos_caja, cancelaciones_caja, caja_config (fondo fijo), quejas_sugerencias, invoice_request.

**SaaS:** subscription_plans, subscriptions, payments, platform_events, calendar_events.

**Stock:** ingredients, recipes, stock_movements, stock_alerts, stock_sessions (toma obligatoria).

**Finanzas:** expenses.

**Delivery:** delivery_orders (con `cash_amount`, `rider_status`), delivery_riders (con PIN), delivery_zones.

**Reservas & QR:** reservations (con `zone`), table_scan_sessions (sesión QR + límite de escaneos).

**Operaciones:** employee_shifts, kitchen_stations (con link compartible), support_chat (Gerente/Admin ↔ Superadmin).

**Pendientes (no existen aún):**
- `customers` (CRM tiene UI pero datos no persisten — bug abierto)

---

## Migraciones

- Están en `supabase/migrations/` numeradas. Último número aplicado: ver `ls supabase/migrations/ | tail -1` (a 2026-05-26 es **085**).
- Crear migración nueva con número siguiente al último existente.
- **NUNCA** editar una migración existente — siempre nueva.
- Aplicar vía **Supabase Management API** con el PAT (ver memoria `reference_supabase_credentials.md`), no por dashboard.
- Si tenés que usar el dashboard: cambiar idioma a **inglés** primero — en español auto-traduce las keywords SQL y rompe.
- Migraciones que crean policies: usar `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` para idempotencia (patrón de `083`).

---

## Bugs abiertos — no romper el fix en progreso

| # | Bug | Causa raíz | Archivo |
|---|---|---|---|
| 1 | RLS con `USING(true)` | No filtra por restaurant_id del usuario | Todas las tablas de Supabase |
| 2 | Crear usuarios usa `service_role` en frontend | `superadmin.html` llama Admin API con key expuesta | `superadmin.html` |
| 3 | Tracking cliente mesa sin Realtime | Suscripción no se dispara (delivery sí tiene Realtime + polling) | `index.html` |
| 4 | `customers` sin tabla | UI de CRM existe pero datos no persisten | `admin.html` (módulo Clientes) |

**Resueltos recientemente — NO revertir:**
- `tables.is_occupied` → liberación explícita implementada (`fix(mesa+caja)`)
- Cierre de turno / logout caja → implementado (`fix(mozo): corregir deudas fantasma`)
- Reservas en localStorage → tabla `reservations` + selector de zona + verificación QR
- "Cobro pte." con payment_status=paid → corregido en `mozo.html`
- Mesa "?" / Mesa "—" → resuelto vía `table_scan_sessions` + `assigned_waiter`
- Cobro ₲0 → validación anti-pedido ₲0 en cliente
- Cobro silencioso por `requires_invoice` faltante → migración 084 + fix mozo+caja
- Dashboard admin 0 pedidos (400) → fix `customer_phone` en select (`9d94cee`)
- Despacho cocina vs entrega mesa → ahora son timestamps separados
- Pickup pagado como "A cobrar" → auto-oculta 6min tras entrega cocina

---

## Módulos / features nuevos importantes (2026-05)

- **Sistema de facturación:** selector de comprobante en cobros, solicitud de factura desde cliente, panel de facturas en caja con visibilidad para impresión/email.
- **Modo offline + ticket 80mm:** caja imprime tickets aunque no haya internet (service worker cachea recursos).
- **Chat de soporte:** Gerente/Admin ↔ Superadmin con metadata automática (`support_chat`).
- **Estaciones de despacho:** cocina divide tickets por estación, cada una con link compartible para mostrar en pantalla.
- **Fondo fijo de caja:** apertura/cierre con monto base configurable, retiro automático del excedente.
- **QR funcionales con sesiones:** `table_scan_sessions` rastrea escaneos, límite por mesa, detección de reservas activas.
- **Toma de inventario obligatoria por turno:** `stock_sessions` — caja no puede abrir turno sin inventario hecho.
- **Avisos internos (campana):** `staff_broadcasts` — broadcast a todo el personal con notificación visual.
- **Transferencia de mesas entre mozos:** notificación en tiempo real al receptor.
- **Filtro Mis mesas / Todas:** mozo puede trabajar sólo con sus asignadas.
- **Calendario superadmin:** `calendar_events` para eventos por restaurante.
- **Horarios de restaurante:** `restaurants.is_open` + módulo superadmin.
- **Reportes superadmin:** 7 tipos, exportación PDF/Excel/CSV, fechas dd/mm/aaaa.
- **Dev tools superadmin:** reset DB + ambiente simulado.
- **Drag-and-drop mapa de zonas:** canvas por zona, coords virtuales consistentes entre paneles.
- **Toggle claro/oscuro:** `mythos-theme.js` aplica `data-theme="dark"` persistente.

---

## Comentarios especiales — NO borrar

```js
/*EDITMODE-BEGIN*/
// ... código de panel tweaks ...
/*EDITMODE-END*/
```

Estos comentarios delimitan zonas de edición en vivo. Borrarlos rompe la feature de tweaks.

---

## Reglas para todo agente que toque este proyecto

1. NO exponer `config.js` ni credenciales en ningún archivo commiteado.
2. NO usar `service_role` key en código frontend.
3. NO convertir a framework moderno (Vite, Next, etc.).
4. NO usar `import`/`export` — todo es global.
5. NO borrar `/*EDITMODE-BEGIN*/` ni `/*EDITMODE-END*/`.
6. SIEMPRE respetar `RESTAURANT_ID` en todos los queries.
7. SIEMPRE crear migración nueva para cambios de schema.
8. NO modificar RLS sin analizar impacto multi-restaurante completo.
9. Modales de registro/edición: cierre solo con **ESC o botón X**, nunca click en overlay.
10. PROBAR flujo cliente→cocina→mozo→caja cuando el cambio toca orders.
11. ANTES de commit+deploy de bugfix operativo: reset DB vía migración tipo `060_dev_reset_v2` (sólo datos operativos, no menú/usuarios/zonas/riders).
12. Verificar que fallback a modo demo siga funcionando si `config.js` no existe.
13. Branding: usar **"Mythos"** en toda UI visible. "Mesa App" es bug de branding.

---

## Prioridades de desarrollo (orden)

1. **RLS multi-restaurante segura** (reemplazar `USING(true)`)
2. **Gestión segura de usuarios** — Edge Function, eliminar `service_role` del frontend
3. **Customers / CRM** — crear tabla y conectar UI existente
4. **Realtime tracking cliente** en `index.html` (mesa) — replicar patrón delivery
5. **QR real por mesa** con token único + expiración (parcial vía `table_scan_sessions`)
6. **Pagos superadmin** — integrar Bancard / Tigo Money
7. **Factura electrónica SIFEN** (Paraguay)
8. **Moderación de ratings** (UI + flujo de aprobación)
