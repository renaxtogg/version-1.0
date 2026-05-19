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
| `public/cocina.html` | KDS cocina (kanban: nuevo/preparando/listo) |
| `public/mozo.html` | Panel mozo |
| `public/caja.html` | Panel caja (turnos, cobros, movimientos) |
| `public/admin.html` | Admin local (menú, mesas, personal, finanzas) |
| `public/superadmin.html` | Superadmin SaaS (restaurantes, planes, pagos) |
| `public/login.html` | Login unificado (redirige por rol) |

---

## Tablas principales

restaurants, tables, menu_categories, menu_items, menu_item_extras, coupons, orders, order_items, order_item_extras, order_status_history, waiter_calls, ratings, user_roles, turnos_caja, movimientos_caja, cancelaciones_caja, quejas_sugerencias, subscription_plans, subscriptions, payments, platform_events, ingredients, recipes, stock_movements, stock_alerts, expenses.

**Pendientes:** reservations, customers, delivery_orders, delivery_drivers, moderación de ratings.

**Status flow orders:** `draft → confirmed → paid → kitchen_received → cooking → ready → delivered`

---

## Bugs críticos conocidos

1. `tables.is_occupied` no siempre se actualiza — mozo ve mesas libres con órdenes activas
2. Mesa ? / Mesa — — número de mesa no resuelto en algunos flujos
3. Cobro puede salir ₲0 en caja
4. RLS con `USING(true)` — no segura para multi-restaurante real
5. Tracking cliente sin Realtime completo
6. Reservas en localStorage — no persisten entre dispositivos
7. Caja sin logout claro / cierre de turno
8. Crear usuarios usa service_role en frontend — riesgo crítico de seguridad

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

1. Fix `is_occupied`
2. Fix Mesa ? / Mesa —
3. Logout + cierre de turno en caja
4. Realtime tracking cliente
5. RLS multi-restaurante segura
6. Reservations en DB
7. Customers / CRM
8. Pagos superadmin
9. Gestión segura de usuarios (Edge Function)
10. QR real por mesa (URL param + token)
