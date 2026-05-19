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
| `public/index.html` | Cliente QR | Móvil. 8 pantallas: menú→pedido→pago→tracking→rating |
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

## Status flow de orders
draft → confirmed → paid → kitchen_received → cooking → ready → delivered

- Cocina ve: `paid` / `kitchen_received` → "nuevo" | `cooking` → "preparando" | `ready` → "listo"
- El cliente crea la orden con `status='paid'` directo (sin confirmed intermedio en el flujo actual)
- Caja cobra órdenes en estado `paid` / `cooking` / `ready`

---

## Tablas principales — referencia rápida
restaurants, tables, menu_categories, menu_items, menu_item_extras,
coupons, orders, order_items, order_item_extras, order_status_history,
waiter_calls, ratings, user_roles, turnos_caja, movimientos_caja,
cancelaciones_caja, quejas_sugerencias, subscription_plans,
subscriptions, payments, platform_events, ingredients, recipes,
stock_movements, stock_alerts, expenses

**Pendientes (no existen aún):** `reservations`, `customers`, `delivery_orders`, `delivery_drivers`

---

## Bugs críticos conocidos — no romper el fix en progreso

| # | Bug | Causa raíz | Archivo |
|---|---|---|---|
| 1 | `tables.is_occupied` no se actualiza | `index.html` no hace UPDATE tras INSERT de order | `index.html → dbSubmitOrder()` |
| 2 | Mesa "?" en cocina | `order.table_id` NULL o join fallido | `cocina.html` |
| 3 | Mesa "—" en caja | `orders.table_id` NULL para pedidos sin mesa | `caja.html` |
| 4 | Cobro ₲0 | `orders.total` queda en 0 (race condition en `confirmAddProducts`) | `mozo.html` |
| 5 | RLS con `USING(true)` | No filtra por restaurant_id del usuario | Supabase → todas las tablas |
| 6 | Tracking sin Realtime | Suscripción no se dispara correctamente | `index.html` |
| 7 | Reservas en localStorage | Tabla `reservations` no existe | `index.html` / `admin.html` |
| 8 | Sin logout en caja | No hay botón explícito | `caja.html` |
| 9 | Crear usuarios usa service_role en frontend | `superadmin.html` llama Admin API con key expuesta | `superadmin.html` |

---

## Relaciones con bug conocido (no romper)
index.html → dbSubmitOrder() → INSERT orders ← FALTA update tables.is_occupied
mozo.html → loadData() → suma totales SOLO de mesas con is_occupied=true → bug ₲0
mozo.html → processPay() → UPDATE orders + movimientos_caja + tables.is_occupied=false

**Fix pendiente para Bug #1:**
Agregar en `index.html → dbSubmitOrder()` después del INSERT de orders:
```js
await db.from('tables')
  .update({ is_occupied: true, occupied_since: new Date().toISOString() })
  .eq('id', tableId)
```

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

- Están en `supabase/migrations/` numeradas `001` → `028`
- Crear migración nueva con número siguiente (`029`, `030`, etc.)
- **NUNCA** editar una migración existente
- Aplicar con: `supabase db push` o desde el dashboard

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
