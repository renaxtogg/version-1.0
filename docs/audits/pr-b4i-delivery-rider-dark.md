# PR-B4I — Delivery rider dark (dedicated)

> FASE B (UI/UX + dark global). Recolor dark dedicado de **Delivery rider** (solo).
> Fecha: 2026-06-18 · Rama: `fix/pr-b4i-delivery-rider-dark` · Base: `main = f7b2665`.
> Frontend/visual. NO toca Auth, asignación, estados, ubicación, pedidos, datos, backend ni Delivery cliente.

## Decisión

**Delivery rider → ACTIVAR dark** (`MythosTheme.init()`).

El shell ya cargaba `tokens.css` + `ui-primitives.css` + `mythos-theme.js`, pero estaba **pineado** con `MythosTheme.init('light')`. El cuerpo del panel (`src/delivery-rider/main.jsx`) usa **estilos inline** (sin clases, sin paleta `C`, sin listener de tema). Buena parte ya consumía tokens (`--text-primary/secondary/tertiary`, `--border`, `--bg-subtle`), pero tenía superficies y botones hardcodeados en `#fff`/`#000` que romperían en dark. Tras el recolor de esos breakers el panel queda **usable y legible** en dark → se activa.

- **Activación:** `init('light')` → `init()`. `init()` sigue la **preferencia global** (`localStorage['mythos-theme']`) y, si es `system`/ausente, `prefers-color-scheme`. En móvil, un rider con el teléfono en modo oscuro obtiene el panel oscuro automáticamente.
- **Sin toggle propio** (decisión, igual que Login en PR-B4H): es un panel operativo móvil compacto (header con ↻ y "Salir"); agregar un control de tema es superficie/riesgo extra. Refleja la preferencia global/sistema. (No había toggle previo que reutilizar.)
- **`mythos-theme.js` NO se modificó** (script de presentación). El IIFE/lógica del rider corre aparte.

## Mecanismo de recolor (sin listener)

Los tintes claros se reescriben como `color-mix(in srgb, var(--estado) N%, var(--surface))`. Como `var()` + `color-mix` se evalúan **al pintar**, cambian de tema automáticamente cuando `data-theme` cambia (sin re-render ni listener). El resto va a tokens que ya flipean por tema.

## Cambios (solo color; lógica/condiciones/handlers intactos)

### `public/delivery-rider.html` (shell)
- `MythosTheme.init('light')` → `init()` (+ comentario).
- `.screen { background:#fff }` → `var(--surface)` (canvas de la app).
- `@media(max-width:430px) body { background:#fff }` → `var(--bg)` (fondo móvil tras el scroll-bounce).
- **No tocado:** `body { background:#111 }` de escritorio = "escenario" neutro oscuro detrás del mock del teléfono; funciona en ambos temas (se deja).

### `src/delivery-rider/main.jsx` (breakers reales corregidos)
- **Spinner**: `borderTopColor:'#000'` → `var(--text-primary)` (negro invisible sobre superficie dark).
- **Superficies de pantalla** `#fff` → `var(--surface)`: contenedores Error/Home/Route/History (`background:'#fff'`), headers sticky de Route e History, contenedores centrados (Error/PinEntry/Route-allDone).
- **Botones/avatares primarios** `#000`/`#fff` → `var(--primary)`/`var(--on-primary)`: botón "Volver al inicio de sesión" (Error), toggle "Activarme" (Home), botón "Comenzar/Salir a entregar" (Home), círculos-número de pedido (Home + Route), botón "Volver al inicio" (Route allDone), botón "Ruta completa" (Route header), botón "Volver" (PinEntry, código muerto, alineado por consistencia).
- **Botones-ícono** (tel/mapa) `background:'#fff'` → `var(--surface)` (Home y Route; el borde ya era `var(--border)`).
- **Puntos de estado** `STATUS_COLOR` `#34C759`/`#FF9500` → `var(--success)`/`var(--warning)` (light idéntico; dark más brillante).
- **2 cards con texto que FLIPEA** (`var(--text-primary)`) → bg a `color-mix(...var(--surface))`, que sin esto quedaría texto claro sobre tinte claro = invisible en dark:
  - Card de **estado** del rider (`STATUS_BG` disponible/en_ruta).
  - Card de pedido **isReady** (`#F0FAF4` + borde `#34C759` → `color-mix(success, surface)` + borde `var(--success)`).

## Superficies sensibles revisadas y NO tocadas (intencional)

Saturadas/bespoke, **legibles en dark** (texto hardcodeado que NO flipea; en dark se ven brillantes pero usables). Tokenizarlas alteraría su look en **light** (rompe "light no se degrada") o cruzaría el límite de recolor:

- **Card "Ruta activa"** (naranja): bg `#FFF7ED`, borde `#FDBA74`, textos `#C2410C`/`#92400E`, chip/btn `#C2410C` con texto `#fff`. Paleta naranja **tuneada para light**; mapearla a tokens cambiaría sus colores/contrastes en light. Se deja pixel-perfect en light; en dark queda como card clara legible. **Único elemento "brillante" notable en dark** → diferido a polish dedicado si se desea.
- **KitchenBadge** (En cocina/Preparándose/Listo): tintes pastel + texto de color hardcodeado, legibles en dark (badges chicos).
- **Badge "En ruta"** `#FF9500`+`#fff`, **botón "Entregar"** `#34C759`+`#fff`, **check entregado** `#34C759`+`#fff`: sólidos saturados, contraste propio en ambos temas.
- **Grises de "entregados"** `#8E8E93`/`#C7C7CC` y **ganancia** `#34C759` (historial): estados atenuados/semánticos; legibles en dark; se dejan para no alterar light.

## Checklist visual light / dark

| Elemento | Light | Dark | Mecanismo |
|---|---|---|---|
| Fondo app (`.screen`) | ✅ | ✅ | `var(--surface)` |
| Fondo móvil (tras bounce) | ✅ | ✅ | `var(--bg)` |
| Header (Home/Route/History) | ✅ | ✅ | superficie + textos token |
| Card de estado del rider | ✅ | ✅ | `color-mix(success/warning, surface)` + punto `var(--success/--warning)` |
| Cards de pedido (pendientes) | ✅ | ✅ | `var(--bg-subtle)` / isReady `color-mix(success, surface)` |
| Card "Ruta activa" (naranja) | ✅ | ⚠️ legible (clara) | bespoke, dejada (documentada) |
| Badges de cocina | ✅ | ⚠️ legible (claras) | bespoke, dejadas |
| Botones primarios | ✅ | ✅ | `var(--primary)`/`var(--on-primary)` |
| Botones-ícono (tel/mapa) | ✅ | ✅ | `var(--surface)` + `var(--border)` |
| Botón "Entregar" (verde) | ✅ | ✅ | sólido saturado |
| Avatares-número | ✅ | ✅ | `var(--primary)`/`var(--on-primary)` |
| Spinner | ✅ | ✅ | `var(--text-primary)` |
| Empty state "Sin pedidos" | ✅ | ✅ | `var(--bg-subtle)` + `var(--text-tertiary)` |
| Error state | ✅ | ✅ | `var(--surface)` + textos token |
| Historial + footer | ✅ | ✅ | `var(--surface)`/`var(--bg-subtle)` + tokens |
| Stats "Hoy" | ✅ | ✅ | `var(--bg-subtle)` + tokens |
| Responsive móvil | ✅ | ✅ | layout sin cambios |

- **Sin textos invisibles** (spinner, superficies y las 2 cards de texto-flipante corregidos).
- **Light no se degrada**: las superficies `#fff`→`var(--surface)` y los íconos son idénticos en light; los botones `#000`→`var(--primary)` (#1D1D1F, delta casi-negro sancionado en PR-B1); los puntos de estado mantienen su hex en light; los dos `color-mix` producen un pastel mínimamente más saturado (mismo verde/ámbar de estado).

## Superficies data-gated (pendientes de QA con datos reales)
- Card "Ruta activa" y lista de ruta con pedidos `on_way` reales.
- Cards de pedido pendientes (isReady vs en preparación) con datos de cocina.
- KitchenBadge en sus 4 estados.
- Historial del día con entregas reales (grises de entregados, ganancia, promedio).
- Estado de presencia/realtime (no visual).

## Hallazgos funcionales (NO corregidos — fuera de alcance)
- Ninguno nuevo. `PinEntryScreen` es **código muerto** (el router no tiene pantalla `'pin'`; la asignación es automática por cocina) — no se elimina en este PR (solo se alineó su color por consistencia). No hay 42501/PGRST/RLS en edición visual estática.

## Pendiente — Delivery cliente
**NO tocado en este PR.** `delivery-cliente` es customer-facing; tendrá **PR separado con decisión de branding** (igual criterio que el menú/QR cliente). Ver `pr-b4g-mozo-delivery-dark.md` (frontera Delivery documentada).

## Riesgos visuales
- Bajo. Único punto: card "Ruta activa" y badges de cocina se ven **claras (brillantes) en dark** pero **legibles**; recolor completo diferido para no alterar su paleta light ni cruzar el límite de sweep.

## Build
- `npm run build`: **PASS — 9/9** (`delivery-rider.js` 168.14 kB; sin errores).

## Confirmación de no-alcance
`git diff --name-only main` ⇒ **`public/delivery-rider.html` + `src/delivery-rider/main.jsx`** (+ este doc). `public/build/*` es gitignored (regenerado por build).
**NO** tocado: Delivery cliente, QR/menu (index), Gerente/Superadmin/Admin/Caja/Cocina/Mozo/Login/Diag, `mythos-theme.js`/`tokens.css`/`ui-primitives.css`.
**NO** tocado: Auth/backend/Supabase/DB/RLS/RPC/migraciones/datos/teardown/permisos/service_role/PATs/secretos/lógica de asignación/estados/ubicación/geolocation/pedidos/timers/realtime/queries/RPC/endpoints/payloads/handlers (salvo color)/condiciones de render/reglas de negocio.
