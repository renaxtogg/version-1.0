# Auditoría de Contexto IA — Mythos / Mythos v1.0

> Versión larga de referencia. Última actualización: 2026-05-16.
> El CLAUDE.md activo es la versión compacta. Este archivo conserva el detalle completo.

---

## Identidad del proyecto

**Mythos** — ecosistema SaaS gastronómico multi-restaurante.
Restaurante demo: **Tu Restaurante**, Asunción, Paraguay. Moneda: guaraní (₲).
Repo: `github.com/mancuellorenato/version-1.0`

---

## Stack técnico

- **Frontend:** HTML + React 18 (CDN) + Babel Standalone. Sin bundler. CSS-in-JS inline.
- **Backend:** Supabase (PostgreSQL + Auth + Realtime + Storage + RLS)
- **Deploy:** Vercel estático (`outputDirectory: public/`)
- **Config:** `config.js` gitignored — credenciales via `window.SUPABASE_CONFIG`

---

## Paneles existentes

| Archivo | Rol |
|---|---|
| `public/index.html` | Cliente QR (8 pantallas: scan→menú→cart→pago→tracking→rating) |
| `public/cocina.html` | KDS cocina (kanban: nuevo/preparando/listo) |
| `public/mozo.html` | Panel mozo (ver mesas, tomar pedidos, llamadas) |
| `public/caja.html` | Panel caja (cobros, turnos, movimientos, cancelaciones) |
| `public/admin.html` | Admin local (menú, mesas, personal, finanzas, reservas) |
| `public/superadmin.html` | Superadmin SaaS (restaurantes, planes, suscripciones, pagos) |
| `public/login.html` | Login unificado (redirige por rol) |

---

## Flujo cliente (index.html)

1. QR Scan → identifica mesa (TABLA_NUM hardcodeado=4; producción: URL param `?mesa=4&token=xxx`)
2. Perfil → info local, selector comer aquí/para llevar, idioma
3. Menú → carga Supabase (fallback estático sin config)
4. Producto modal → extras + observaciones
5. Cart → editar cantidades, cupón MESA10 validado en Supabase
6. Pago → efectivo/tarjeta/QR/POS + datos factura (RUC/CI)  
   → INSERT orders + order_items + order_item_extras + order_status_history
7. Tracking → Supabase Realtime subscription en orders por order_number
8. Calificación → INSERT ratings

## Flujo cocina (cocina.html)

- Carga pedidos activos (paid/kitchen_received/cooking/ready)
- Kanban: Nuevos → Preparando → Listos
- Realtime: INSERT y UPDATE en orders
- Avanzar ticket → UPDATE orders.status + INSERT order_status_history
- Archivar → UPDATE status='delivered'
- Sin Supabase: modo DEMO hardcodeado

---

## Status flow de orders

`draft → confirmed → paid → kitchen_received → cooking → ready → delivered`

Cocina: paid/kitchen_received → "nuevo" | cooking → "preparando" | ready → "listo"

---

## Tablas Supabase — existentes

| Tabla | Descripción |
|---|---|
| restaurants | Info del local |
| tables | Mesas con QR token único |
| menu_categories | Categorías del menú |
| menu_items | Platos con precio en ₲ |
| menu_item_extras | Extras por plato |
| coupons | Cupones (ej: MESA10 = 10%) |
| orders | Pedido principal con status y totales |
| order_items | Ítems del pedido (snapshot nombre/precio) |
| order_item_extras | Extras seleccionados |
| order_status_history | Log inmutable de cambios de estado |
| waiter_calls | Llamadas al mozo |
| ratings | Calificaciones 1-5 estrellas |
| user_roles | Roles por usuario y restaurante |
| turnos_caja | Turnos de caja con apertura/cierre |
| movimientos_caja | Ingresos/egresos manuales |
| cancelaciones_caja | Registro de cancelaciones |
| quejas_sugerencias | Feedback interno |
| subscription_plans | Planes SaaS |
| subscriptions | Suscripciones activas por restaurante |
| payments | Pagos de suscripción |
| platform_events | Log de eventos plataforma |
| ingredients | Ingredientes para stock |
| recipes | Recetas (relación plato→ingredientes) |
| stock_movements | Movimientos de stock |
| stock_alerts | Alertas de stock bajo |
| expenses | Gastos operativos |

## Tablas pendientes de implementar

- `reservations` — sistema de reservas (hoy en localStorage)
- `customers` — CRM / historial de clientes
- `delivery_orders` — pedidos delivery
- `delivery_drivers` — repartidores
- Moderación de ratings

---

## Variables críticas en código

- `RESTAURANT_ID`: UUID fijo `00000000-0000-0000-0000-000000000001`
- `TABLE_NUM`: número de mesa (4 hardcodeado)
- `window.SUPABASE_CONFIG`: inyectado por `config.js` en el browser
- Comentarios `/*EDITMODE-BEGIN*/` y `/*EDITMODE-END*/` para panel tweaks — NO borrar

---

## Bugs críticos conocidos

1. **`tables.is_occupied` no siempre se actualiza** — mozo ve mesas libres con órdenes activas
2. **Mesa ? / Mesa —** — número de mesa no resuelto en algunos flujos
3. **Cobro puede salir ₲0** — bug en cálculo en caja
4. **RLS con `USING(true)`** — no es segura para multi-restaurante real en producción
5. **Tracking cliente sin Realtime completo** — suscripción puede no dispararse
6. **Reservas en localStorage** — no persisten entre dispositivos
7. **Caja sin logout claro** — usuario queda logueado sin cerrar turno
8. **Crear usuarios usa service_role en frontend** — crítico de seguridad, debe resolverse con Edge Function o Auth admin server-side

---

## Reglas para agentes IA

- NO exponer `config.js` ni credenciales en ningún archivo
- NO usar `service_role` key en código frontend
- NO convertir a Vite / Next.js / Webpack — el proyecto es CDN+Babel intencional
- NO usar `import`/`export` — todo es `window.*` o scripts globales
- NO borrar comentarios `/*EDITMODE-BEGIN*/` / `/*EDITMODE-END*/`
- Respetar `RESTAURANT_ID` fijo en todos los queries
- Cambios de DB siempre con migración nueva numerada (no editar migraciones existentes)
- NO modificar políticas RLS sin analizar impacto multi-restaurante
- NO asumir que botones/flows funcionan — verificar end-to-end cuando aplique
- Probar flujo completo cliente→cocina→mozo→caja cuando el cambio toca órdenes

---

## Prioridades de desarrollo

### Inmediatas (bugs)
1. Fix `is_occupied` — sincronizar con estado real de orders
2. Fix Mesa ? / Mesa — en todos los paneles
3. Logout en caja con cierre de turno
4. Realtime tracking cliente (suscripción robusta)

### Corto plazo
5. RLS multi-restaurante segura (reemplazar `USING(true)`)
6. Sistema de reservas en DB (migrar desde localStorage)
7. Customers / CRM básico
8. Pagos superadmin (Bancard, Tigo Money)

### Medio plazo
9. Gestión segura de usuarios (Edge Function, no service_role frontend)
10. QR real por mesa (URL param + token)
11. Delivery (tablas + flujo)
12. PWA / Service Worker

---
   
## Comandos útiles

```bash
# Ver localmente
npx serve public

# Deploy
vercel --prod

# Push
git push origin main
```

---

## Notas técnicas adicionales

- `@babel/standalone` permite async/await en `<script type="text/babel">`
- `window.supabase.createClient()` es el cliente UMD de Supabase JS v2
- Todos los componentes del cliente están en un solo archivo por diseño de prototipo
- El Supabase Dashboard en español puede romper SQL — usar en inglés para migraciones
