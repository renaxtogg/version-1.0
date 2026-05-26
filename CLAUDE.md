# Mythos — Contexto para Agentes IA

> Ecosistema SaaS gastronómico multi-restaurante.
> Restaurante demo: **La Huaca**, Asunción, Paraguay. Moneda: guaraní (₲).
> Referencia completa: `docs/auditoria_contexto_ia.md`

---

## Stack

- **Frontend:** HTML + React 18 CDN + Babel Standalone. Sin bundler. CSS-in-JS inline.
- **Backend:** Supabase (PostgreSQL + Auth + Realtime + Storage + RLS)
- **Deploy:** Vercel estático (`outputDirectory: public/`)
- **Config:** `config.js` gitignored — credenciales via `window.SUPABASE_CONFIG`

---

## Paneles

| Archivo | Rol |
|---|---|
| `public/index.html` | Cliente QR (scan→menú→cart→pago→tracking→rating) |
| `public/delivery-cliente.html` | Cliente delivery (pedido a domicilio, tracking en tiempo real) |
| `public/delivery-rider.html` | Panel rider (login por PIN, lista de pedidos, cambio de estado) |
| `public/cocina.html` | KDS cocina (kanban: nuevo/preparando/listo) |
| `public/mozo.html` | Panel mozo |
| `public/caja.html` | Panel caja (turnos, cobros, movimientos) |
| `public/admin.html` | Admin local (menú, mesas, personal, finanzas) |
| `public/superadmin.html` | Superadmin SaaS (restaurantes, planes, pagos) |
| `public/login.html` | Login unificado (redirige por rol) |

---

## Tablas principales

restaurants, tables, menu_categories, menu_items, menu_item_extras, coupons, orders, order_items, order_item_extras, order_status_history, waiter_calls, ratings, user_roles, turnos_caja, movimientos_caja, cancelaciones_caja, quejas_sugerencias, subscription_plans, subscriptions, payments, platform_events, ingredients, recipes, stock_movements, stock_alerts, expenses, delivery_orders, delivery_riders, delivery_zones, reservations, employee_shifts.

**Pendientes:** customers, moderación de ratings.

**Status flow orders:** `draft → confirmed → paid → kitchen_received → cooking → ready → delivered`

**Status flow delivery (rider_status en delivery_orders):** `pending → confirmed → picked_up → on_way → delivered → cancelled`

**Status flow riders (current_status en delivery_riders):** `disponible → en_ruta → offline`

---

## Bugs críticos conocidos

1. Mesa ? / Mesa — — número de mesa no resuelto en algunos flujos (orders con table_id NULL)
2. Cobro puede salir ₲0 en caja (race condition en confirmAddProducts)
3. RLS con `USING(true)` — no segura para multi-restaurante real
4. Tracking cliente sin Realtime completo
5. Crear usuarios usa service_role en frontend — riesgo crítico de seguridad

**Resueltos recientemente (no revertir):**
- ~~`tables.is_occupied` no se actualizaba~~ — fix en `fix(mesa+caja): mesa permanece ocupada hasta liberación explícita`
- ~~Caja sin logout / cierre de turno~~ — fix en `fix(mozo): corregir deudas fantasma + mejorar cierre de turno`
- ~~Reservas en localStorage~~ — tabla `reservations` creada en migración 040
- ~~Mozo mostraba "Cobro pte." con payment_status=paid~~ — fix en `fix(mozo): no mostrar si ya paid`

---

## Reglas para agentes

- NO exponer `config.js` ni credenciales en ningún archivo
- NO usar `service_role` key en código frontend
- NO convertir a Vite / Next.js / Webpack
- NO usar `import`/`export` — todo es `window.*` o scripts globales
- NO borrar comentarios `/*EDITMODE-BEGIN*/` / `/*EDITMODE-END*/`
- Respetar `RESTAURANT_ID = 00000000-0000-0000-0000-000000000001` en todos los queries
- Cambios de DB siempre con migración nueva numerada
- NO modificar RLS sin analizar impacto multi-restaurante
- Probar flujo cliente→cocina→mozo→caja cuando el cambio toca órdenes

---

## Prioridades

1. Fix Mesa ? / Mesa — (orders con table_id NULL)
2. Fix cobro ₲0 en caja
3. Realtime tracking cliente
4. RLS multi-restaurante segura
5. Customers / CRM
6. Pagos superadmin (Bancard, Tigo Money)
7. Gestión segura de usuarios (Edge Function)
8. QR real por mesa (URL param + token)
