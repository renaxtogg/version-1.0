# Mesa App v1.0

Sistema de pedidos por código QR para restaurantes. Diseñado para Paraguay con moneda guaraní (₲).

## Descripción

El cliente escanea el QR de su mesa, ve el menú del restaurante, arma su pedido con extras y observaciones, paga y sigue el estado de su pedido en tiempo real. La cocina ve los pedidos en un KDS (Kitchen Display System) y los actualiza a medida que avanza la preparación.

## URLs del proyecto
- **App cliente:** [https://mesa-app.vercel.app](https://mesa-app.vercel.app) (o tu dominio Vercel)
- **Cocina:** [https://mesa-app.vercel.app/cocina](https://mesa-app.vercel.app/cocina)
- **GitHub:** [https://github.com/mancuellorenato/version-1.0](https://github.com/mancuellorenato/version-1.0)
- **Supabase Dashboard:** https://supabase.com/dashboard/project/TU_PROJECT_ID

## Tech Stack

| Capa | Tecnología |
|---|---|
| Frontend | HTML + React 18 (CDN) + Babel Standalone |
| Base de datos | Supabase (PostgreSQL) |
| Realtime | Supabase Realtime (WebSockets) |
| Deploy | Vercel (estático) |
| Fuentes | DM Serif Display, Plus Jakarta Sans, JetBrains Mono |

## Funcionalidades

### App del cliente (`public/index.html`)
- Escaneo de QR para identificar la mesa
- Perfil del restaurante con horarios, redes y modos (comer aquí / para llevar)
- Selector de idioma (ES/EN/PT/DE)
- Menú con búsqueda, filtros por categoría y badges de promo
- Modal de producto con extras y observaciones para cocina
- Carrito con edición de cantidades
- Validación de cupones de descuento (ej: MESA10)
- Pago: efectivo, tarjeta, QR, POS
- Datos para factura electrónica (RUC/CI)
- Seguimiento en tiempo real del pedido
- Calificación del servicio (1-5 estrellas)
- Modo sin conexión (banner de aviso)
- Panel de theming: 3 paletas × 3 tipografías × 3 layouts de carta

### Cocina (`public/cocina.html`)
- KDS kanban: Nuevos → Preparando → Listos
- Carga en tiempo real desde Supabase
- Alertas de urgencia (pedidos > 20 min)
- Avanzar/archivar tickets con un click
- Historial de estado registrado automáticamente
- Reloj en tiempo real
- Modo DEMO si Supabase no está configurado

## Configuración rápida

### 1. Clonar el repo
```bash
git clone https://github.com/mancuellorenato/version-1.0
cd version-1.0
```

### 2. Configurar Supabase
Ver [docs/SUPABASE_SETUP.md](SUPABASE_SETUP.md) para el paso a paso completo.

### 3. Configurar credenciales locales
```bash
cp public/config.example.js public/config.js
# Editar public/config.js con tu URL y anon key
```

### 4. Abrir la app
Abrir `public/index.html` en el browser. No requiere servidor.

O con servidor local:
```bash
npx serve public
```

## Deploy en Vercel

Ver [docs/DEPLOYMENT.md](DEPLOYMENT.md) para instrucciones completas.

TL;DR:
```bash
vercel --prod
# Luego agregar SUPABASE_URL y SUPABASE_ANON_KEY en Vercel Dashboard
```

## Estructura de archivos

```
version-1.0/
├── public/
│   ├── index.html          # App del cliente
│   ├── cocina.html         # KDS cocina
│   ├── tweaks-panel.jsx    # Panel de theming
│   ├── config.js           # ← CREAR: credenciales Supabase (gitignored)
│   └── config.example.js  # Plantilla de config.js
├── supabase/
│   └── migrations/
│       ├── 20260429_001_schema.sql  # Tablas + RLS + Realtime
│       └── 20260429_002_seed.sql    # Datos de La Huaca + menú
├── docs/
│   ├── README.md            # Este archivo
│   ├── ARCHITECTURE.md      # Arquitectura del sistema
│   ├── DATABASE_SCHEMA.md   # Referencia completa de tablas
│   ├── SUPABASE_SETUP.md    # Paso a paso Supabase
│   └── DEPLOYMENT.md        # Instrucciones de deploy
├── .env.example             # Variables de entorno para Vercel
├── .gitignore
├── vercel.json
└── CLAUDE.md                # Contexto para agentes IA
```

## Roadmap (Fases futuras)
- **Fase 2:** Panel admin (gestión de menú, mesas, estadísticas)
- **Fase 3:** Pagos reales (Bancard, Tigo Money API)
- **Fase 4:** Factura electrónica SIFEN (SET Paraguay)
- **Fase 5:** Multi-restaurante y white-label
- **Fase 6:** App nativa (React Native / Expo)
