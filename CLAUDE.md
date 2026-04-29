# Mesa App v1.0 — Contexto para Agentes IA

## Qué es este proyecto
Sistema de pedidos por QR para restaurantes. Cliente escanea un QR en la mesa, ve el menú, arma su pedido, paga y sigue el estado en tiempo real. La cocina ve los tickets en un KDS (Kitchen Display System) y los actualiza conforme avanza la preparación.

**Restaurante demo:** La Huaca, Asunción, Paraguay. Moneda: guaraní (₲).

## Stack técnico
- **Frontend:** HTML + React 18 (CDN) + Babel Standalone. Sin bundler. CSS-in-JS inline.
- **Backend:** Supabase (PostgreSQL + Realtime + RLS)
- **Deploy:** Vercel (estático, outputDirectory: public/)
- **Repo:** github.com/mancuellorenato/version-1.0

## Estructura de archivos
```
public/
  index.html      — App del cliente (8 pantallas QR→rating)
  cocina.html     — KDS para cocina (kanban: nuevo/preparando/listo)
  tweaks-panel.jsx — Panel de theming visual (3 controles)
  config.js       — Credenciales Supabase (GITIGNORED, no subir)
  config.example.js — Plantilla de config.js
supabase/
  migrations/
    20260429_001_schema.sql  — 12 tablas + RLS + realtime
    20260429_002_seed.sql    — Datos de La Huaca + menú + cupón MESA10
docs/            — Documentación completa
.env.example     — Variables de entorno para Vercel
vercel.json      — Config de deploy
CLAUDE.md        — Este archivo
```

## Flujo de la aplicación

### Cliente (index.html)
1. **QR Scan** → identifica Mesa 4 (hardcodeado en TABLA_NUM, en producción viene de URL param)
2. **Perfil** → info del local, selector comer aquí/para llevar, idioma
3. **Menú** → carga desde Supabase (fallback a datos estáticos si no hay config)
4. **Producto modal** → extras + observaciones para cocina
5. **Cart** → editar cantidades, cupón MESA10 validado contra Supabase
6. **Pago** → efectivo/tarjeta/QR/POS + datos factura electrónica (RUC/CI)
   → **Supabase INSERT**: orders + order_items + order_item_extras + order_status_history
7. **Tracking** → Supabase Realtime subscription en orders por order_number
8. **Calificación** → INSERT en ratings

### Cocina (cocina.html)
- Carga pedidos activos (status: paid/kitchen_received/cooking/ready)
- Kanban: Nuevos → Preparando → Listos
- Supabase Realtime: INSERT y UPDATE en orders
- Avanzar ticket → UPDATE orders.status + INSERT order_status_history
- Archivar (listo) → UPDATE status='delivered'
- Sin Supabase: modo DEMO con datos hardcodeados

## Tablas Supabase (resumen)
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

## Status flow de orders
`draft → confirmed → paid → kitchen_received → cooking → ready → delivered`

Cocina lee: paid/kitchen_received → "nuevo", cooking → "preparando", ready → "listo"

## Variables críticas en código
- `RESTAURANT_ID`: UUID fijo `00000000-0000-0000-0000-000000000001`
- `TABLE_NUM`: número de mesa (4 hardcodeado, futuro: extraer de URL `?mesa=4&token=xxx`)
- `window.SUPABASE_CONFIG`: inyectado por `config.js` en el browser

## Qué falta para producción (Fase 2+)
- Leer número de mesa y token del QR URL param
- Auth para cocina (no dejar que cualquiera acceda al KDS)
- Pagos reales integrados (Bancard, Tigo Money API)
- Panel admin (gestión de menú, mesas, estadísticas)
- Generación de QRs por mesa
- Factura electrónica SIFEN (SET Paraguay)
- Multi-restaurante (el schema ya lo soporta)
- PWA / offline con Service Worker

## Comandos útiles
```bash
# Ver la app localmente
# Abrir public/index.html en browser (no requiere servidor)
# O con servidor local:
npx serve public

# Deploy a Vercel
vercel --prod

# Push a GitHub
git push origin main

# Ver DB en Supabase
# Dashboard: https://supabase.com/dashboard/project/TU_PROJECT_ID/editor
```

## Notas para IA
- El proyecto usa React CDN con Babel Standalone — NO usar import/export ni bundler
- `@babel/standalone` permite async/await en el script type="text/babel"
- `window.supabase.createClient()` es el cliente UMD de Supabase JS v2
- Todos los componentes del cliente están en un solo archivo (index.html) — es intencional para este prototipo
- Los comentarios `/*EDITMODE-BEGIN*/` y `/*EDITMODE-END*/` son para el panel de tweaks — no borrar
- El PDF `02_v1_paso_a_paso.pdf` contiene la guía de desarrollo del proyecto
