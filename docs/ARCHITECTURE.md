# Arquitectura del Sistema

## Vista general

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENTE                              │
│                                                             │
│  📱 Mesa (QR scan)          🖥️ Cocina (KDS)                 │
│  public/index.html          public/cocina.html              │
│                                                             │
│  React 18 (CDN)             React 18 (CDN)                  │
│  + Supabase JS v2           + Supabase JS v2                │
│  + Babel Standalone         + Babel Standalone              │
└──────────────┬──────────────────────┬───────────────────────┘
               │                      │
               │  HTTPS (REST API)    │  WebSocket (Realtime)
               ▼                      ▼
┌─────────────────────────────────────────────────────────────┐
│                       SUPABASE                              │
│                                                             │
│  ┌─────────────┐    ┌────────────────┐    ┌─────────────┐  │
│  │   REST API  │    │   Realtime     │    │  PostgreSQL │  │
│  │  (PostgREST)│    │  (WebSockets)  │    │    (DB)     │  │
│  └─────────────┘    └────────────────┘    └─────────────┘  │
│                                                             │
│  RLS: Row Level Security en todas las tablas                │
└─────────────────────────────────────────────────────────────┘
               │
               │  Deploy
               ▼
┌─────────────────────────────────────────────────────────────┐
│                        VERCEL                               │
│                    (Hosting estático)                       │
│           https://mesa-app.vercel.app                       │
└─────────────────────────────────────────────────────────────┘
```

## Flujo de un pedido completo

```
1. CLIENTE ESCANEA QR
   QR URL: https://mesa-app.vercel.app?mesa=4&token=lahuaca-mesa-4
   → App identifica Mesa 4

2. VE EL MENÚ
   GET /menu_categories?restaurant_id=eq.{id}
   GET /menu_items?restaurant_id=eq.{id}&is_available=eq.true
   GET /menu_item_extras  (join automático)
   → Menú renderizado en pantalla

3. ARMA EL PEDIDO
   → Estado local en React (cartItems[])
   → Sin llamadas a Supabase todavía

4. APLICA CUPÓN (opcional)
   GET /coupons?code=eq.MESA10&is_active=eq.true
   → Descuento calculado localmente

5. CONFIRMA PAGO
   POST /orders { status: 'paid', total: 28000, ... }
   POST /order_items [{ item_name: 'BBQ Smokey', quantity: 2 }, ...]
   POST /order_item_extras [{ extra_name: 'Panceta' }, ...]
   POST /order_status_history { status: 'paid', changed_by: 'customer' }
   → order_number generado: 'T-12847'

6. CLIENTE VE SEGUIMIENTO
   SUBSCRIBE: orders WHERE order_number = 'T-12847'
   → Realtime updates cuando cocina cambia el status

7. COCINA RECIBE PEDIDO (automático)
   REALTIME INSERT en orders → cocina.html recibe el evento
   → Ticket aparece en columna "Nuevos" del KDS

8. COCINA AVANZA EL TICKET
   PATCH /orders?id=eq.{id} { status: 'cooking' }
   POST /order_status_history { status: 'cooking', changed_by: 'kitchen' }
   → Cliente ve "Cocinando" en su tracking

9. COCINA MARCA LISTO
   PATCH /orders?id=eq.{id} { status: 'ready' }
   → Cliente ve "Listo para retirar"

10. COCINA ARCHIVA (entregado)
    PATCH /orders?id=eq.{id} { status: 'delivered', completed_at: now() }
    → Ticket desaparece del KDS

11. CLIENTE CALIFICA
    POST /ratings { stars: 5, comment: 'Excelente...' }
    → App vuelve a la pantalla inicial
```

## Componentes del frontend

### `index.html` — App del cliente
```
App (root)
├── ThemeCtx.Provider (paleta de colores)
├── MenuCtx.Provider (datos del menú, dinámico desde Supabase)
├── PhoneFrame
│   ├── OfflineBanner
│   ├── Toast
│   ├── ProductModal (overlay)
│   └── [pantallas condicionales]
│       ├── QRScreen
│       ├── ProfileScreen
│       ├── MenuScreen
│       │   └── ProdCard[]
│       ├── CartScreen
│       ├── PayScreen
│       ├── TrackingScreen
│       └── RatingScreen
└── TweaksPanel (fuera del teléfono)
```

### `cocina.html` — KDS
```
App (root)
├── Topbar (título, urgentes, reloj)
├── AlertBanner (nuevo ticket)
└── Board (3 columnas CSS Grid)
    ├── Column "Nuevos"
    │   └── TicketCard[]
    ├── Column "Preparando"
    │   └── TicketCard[]
    └── Column "Listos"
        └── TicketCard[]
```

## Decisiones de diseño

### ¿Por qué HTML + CDN en lugar de Vite/Next.js?
- Fase 1 de MVP: velocidad de iteración > arquitectura perfecta
- Sin proceso de build → deploy inmediato
- El usuario (propietario del restaurante) puede editar el HTML directamente
- La app es completamente estática en Vercel

### ¿Por qué Supabase?
- PostgreSQL real con RLS → seguridad robusta sin servidor propio
- Realtime incorporado → no necesitar Socket.io ni WebSocket server
- Dashboard visual → el dueño puede ver los datos sin código
- Plan gratuito generoso para arrancar

### ¿Por qué los nombres/precios son "snapshot" en order_items?
- Si el menú cambia de precio, los pedidos históricos conservan el precio al momento de la compra
- Si un plato se elimina del menú, los pedidos históricos siguen siendo legibles

### ¿Por qué un solo HTML por pantalla?
- Simplicidad para Fase 1
- Fase 2 migra a React + Vite con rutas reales
