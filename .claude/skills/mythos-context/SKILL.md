# Mythos Context — Skill de contexto del proyecto

Cuando esta skill se activa, tenés el contexto completo del proyecto antes de tocar cualquier archivo.
Leé todo antes de escribir una sola línea de código.

---

## Identidad

**Mythos** — SaaS gastronómico multi-restaurante.
Restaurante demo: **La Huaca**, Asunción, Paraguay. Moneda: guaraní (₲).
Repo: `github.com/mancuellorenato/version-1.0`

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

---

## Paneles existentes

| Archivo | Rol | Notas |
|---|---|---|
| `public/index.html` | Cliente QR | Móvil. Pantallas: menú→pedido→pago→tracking→rating |
| `public/delivery-cliente.html` | Cliente delivery | Pedido a domicilio + tracking en tiempo real. Envuelto en phone-wrapper desktop. |
| `public/delivery-rider.html` | Panel rider | Login por PIN, lista de pedidos asignados, cambio de estado (confirmed/picked_up/on_way/delivered) |
| `public/cocina.html` | KDS cocina | Kanban en tiempo real. Dark theme. |
| `public/mozo.html` | Panel mozo | Grilla de mesas + órdenes |
| `public/caja.html` | Panel caja | Turnos, cobros, egresos, quejas |
| `public/admin.html` | Admin local | Menú, mesas, personal, stock, finanzas |
| `public/superadmin.html` | Superadmin SaaS | Restaurantes, planes, suscripciones |
| `public/login.html` | Login unificado | Redirige por rol |
| `public/design-system.css` | Tokens CSS globales | Importado por todos los paneles |

---

## Variables críticas en código

```js
RESTAURANT_ID = '00000000-0000-0000-0000-000000000001'  // fijo en todos los paneles
TABLE_NUM = parseInt(URLParams.get('mesa') || '4')       // index.html
window.SUPABASE_CONFIG = { url, anonKey, restaurantId }  // inyectado por config.js
```

NO modificar el RESTAURANT_ID hardcodeado. Si necesitás multi-tenant real, es una tarea separada de RLS.

---

## Status flows

**Órdenes (orders.status):**
`draft → confirmed → paid → kitchen_received → cooking → ready → delivered`
- Cocina ve: `paid` / `kitchen_received` → "nuevo" | `cooking` → "preparando" | `ready` → "listo"
- El cliente crea la orden con `status='paid'` directo (sin confirmed intermedio en el flujo actual)
- Caja cobra órdenes en estado `paid` / `cooking` / `ready`

**Delivery — rider status (delivery_orders.rider_status):**
`pending → confirmed → picked_up → on_way → delivered → cancelled`
- `pending`: orden creada, sin rider asignado
- `confirmed`: rider asignado por cocina (round-robin), esperando retiro en local
- `picked_up`: rider tomó el pedido (alias interno, va directo a on_way en UI actual)
- `on_way`: rider inició ruta — cliente ve "En camino"
- `delivered`: rider confirmó entrega — cliente ve "Entregado"

**Riders (delivery_riders.current_status):**
`disponible → en_ruta → offline`

---

## Tablas principales — referencia rápida
restaurants, tables, menu_categories, menu_items, menu_item_extras,
coupons, orders, order_items, order_item_extras, order_status_history,
waiter_calls, ratings, user_roles, turnos_caja, movimientos_caja,
cancelaciones_caja, quejas_sugerencias, subscription_plans,
subscriptions, payments, platform_events, ingredients, recipes,
stock_movements, stock_alerts, expenses,
delivery_orders, delivery_riders, delivery_zones,
reservations, employee_shifts

**Pendientes (no existen aún):** `customers`

---

## Bugs abiertos — no romper el fix en progreso

| # | Bug | Causa raíz | Archivo |
|---|---|---|---|
| 1 | Mesa "?" en cocina / Mesa "—" en caja | `orders.table_id` NULL o join fallido | `cocina.html`, `caja.html` |
| 2 | Cobro ₲0 | `orders.total` queda en 0 (race condition en `confirmAddProducts`) | `mozo.html` |
| 3 | RLS con `USING(true)` | No filtra por restaurant_id del usuario | Supabase → todas las tablas |
| 4 | Tracking sin Realtime completo | Suscripción no se dispara correctamente | `index.html` |
| 5 | Crear usuarios usa service_role en frontend | `superadmin.html` llama Admin API con key expuesta | `superadmin.html` |

**Resueltos recientemente — NO revertir:**
- `tables.is_occupied` → liberación explícita implementada (`fix(mesa+caja)`)
- Cierre de turno / logout caja → implementado (`fix(mozo): corregir deudas fantasma`)
- Reservas en localStorage → tabla `reservations` creada (migración 040-042)
- "Cobro pte." con payment_status=paid → corregido en `mozo.html`

---

## Comentarios especiales — NO borrar

```js
/*EDITMODE-BEGIN*/
// ... código de panel tweaks ...
/*EDITMODE-END*/
```

Estos comentarios delimitan zonas de edición en vivo. Borrarlos rompe la feature de tweaks.

---

## Migraciones

- Están en `supabase/migrations/` numeradas `001` → `060`
- Crear migración nueva con número siguiente al último existente
- **NUNCA** editar una migración existente
- Aplicar con: `supabase db push` o desde el SQL Editor del dashboard
- **Importante:** el dashboard de Supabase en español rompe el SQL — cambiar idioma a inglés antes de ejecutar

---

## Reglas para todo agente que toque este proyecto

1. NO exponer `config.js` ni credenciales en ningún archivo commiteado
2. NO usar `service_role` key en código frontend
3. NO convertir a framework moderno (Vite, Next, etc.)
4. NO usar `import`/`export` — todo es global
5. NO borrar `/*EDITMODE-BEGIN*/` ni `/*EDITMODE-END*/`
6. SIEMPRE respetar `RESTAURANT_ID` en todos los queries
7. SIEMPRE crear migración nueva para cambios de schema
8. NO modificar RLS sin analizar impacto multi-restaurante completo
9. PROBAR flujo cliente→cocina→mozo→caja cuando el cambio toca orders
10. Verificar que fallback a modo demo siga funcionando si `config.js` no existe

---

## Prioridades de desarrollo (orden)

1. Fix `is_occupied` — Bug #1
2. Fix Mesa ? / Mesa — — Bugs #2 y #3
3. Logout + cierre de turno en caja — Bug #8
4. Realtime tracking cliente — Bug #6
5. RLS multi-restaurante real — Bug #5
6. Sistema de reservas en DB
7. Módulo Customers / CRM
8. Pagos en superadmin (Bancard, Tigo Money)
9. Gestión segura de usuarios (Edge Function)
10. QR real por mesa con URL param + token
