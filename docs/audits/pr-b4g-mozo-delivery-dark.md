# PR-B4G — Mozo + Delivery dark activation/alignment

> FASE B (UI/UX + dark global). Mozo + Delivery (rider/cliente).
> Fecha: 2026-06-18 · Rama: `fix/pr-b4g-mozo-delivery-dark` · Base: `main = c59d1b9`.
> Frontend/visual. NO toca lógica de pedidos/asignación/estados/ubicación/timers, datos, backend, ni otros paneles.

## Decisión por superficie

| Superficie | Decisión | Motivo |
|---|---|---|
| **Mozo** | **ACTIVAR dark** (`init()`) | Token bridge maduro (PR-B3F, ya con reglas `[data-theme="dark"]`). Cubre lo suficiente; faltaban overrides acotados para literales de mesa/badge/heroes no bridgeados. |
| **Delivery rider** | **ALINEAR/DOCUMENTAR — NO activar** | PR-B3G **preservó la marca `#fff`/`#000`** (cards blancas + botones negros) dispersa inline por todas las pantallas. No es dark-ready: activar ahora daría cards blancas y botones negros que se funden. Requiere recolor dedicado. |
| **Delivery cliente** | **ALINEAR/DOCUMENTAR — NO activar** | Igual que rider + es **customer-facing** (sólo 8 `var(--)` vs 35 hex hardcodeados): activar = decisión de producto, no rollout de dark de staff. Recolor dedicado. |

> Resultado: **Mozo activado**; **Delivery rider/cliente quedan pineados `init('light')`** con su decisión documentada (no se tocó su código → cero riesgo de dark roto). Login/Diag siguen fuera de alcance.

## 1) Mozo — cómo se activa

- **Ya tenía** el token bridge en el `<style>` del shell (`:root` aliasando tokens globales + bloque
  `[data-theme="dark"]`), y en el JSX un **toggle de tema wireado** (estado `dark` + listener
  `mythos:themechange` + `MythosTheme.toggle()`). 
- **Activación (1 línea):** `public/mozo.html` `MythosTheme.init('light')` → **`init()`** (respeta
  preferencia/sistema + persiste vía el toggle existente).
- **`mythos-theme.js` NO se tocó. Toggle reutilizado** (no se agregó ni amplió).
- **`data-theme="dark"`** activa el bridge dark del shell + los nuevos overrides.

### Mozo — overrides dark agregados (shell `<style>`, additivos `[data-theme="dark"]`)
Literales hardcodeados que NO pasaban por el bridge y rompían en dark:
- **Mesa-cards:** `.ocupada` (`#000000`→ se fundía) → `#2C2C2E`/`#48484A`; `.cuenta` (card blanca `#FFFFFF`)
  → `var(--surface)` + número → `var(--text)`.
- **Badges negros** (`.cobrar-badge`/`.item-badge-listo`/`.promo-badge` `#000`) → `var(--text)`/`var(--bg)`;
  `.item-badge-entregado` texto → `var(--green)`.
- **Superficies "invertidas"** (`.order-header`/`.toast` usaban `background:var(--text)` + texto blanco →
  en dark quedaban claras con texto blanco invisible) → `background:var(--surface)`;
  `.order-action-btn.primary-action` (botón blanco + texto `var(--text)`) → `var(--text)`/`var(--bg)`.
- `.featured-card` → `border:1px solid var(--border)` (definición sobre fondo oscuro);
  `.extra-check-label input` `accent-color:#000` → `var(--text)`.

### Mozo — JSX cableado (solo color/tinte; condiciones/handlers intactos)
7 ediciones `#000`/`#fff` → `var(--text)`/`var(--bg)` en **selectores de segmento/toggle**:
vista cuadrícula/mapa (`mesaViewMode`), alcance mis/todas (`tableScope`), botón "Guardar" nota,
segmento de método de pago (`sel`). **Las condiciones (`=== 'grid'`, `=== 'all'`, `sel`) se preservan;
solo cambió el valor de color.**

### Mozo — deliberadamente NO tocado
- **Floor-plan / canvas de mesas (vista "mapa")**: el status map `sc` (bg/bd/tx) alimenta tanto el
  render como **condiciones** (`sc.tx==='#000000'` en 3 lugares para elegir color de sub-texto). Igual
  que Caja (B4E): recolorearlo **cambiaría una condición de render** (prohibido). Se deja intacto +
  su **leyenda** (dots de estado) coherente con el canvas. **Pendiente de QA / posible PR dedicado.**
- **Heroes dark inline** (card de perfil/sesión del mozo `#000` + white-alpha; popup de transferencia
  `#1D1D1F`; toast Bancard `#1C1C1E`): elementos oscuros intencionales con texto blanco; funcionan en
  dark (leve blend con el fondo). Se mantienen (no se pueden bridgear sin romper light: su contenido es
  white-alpha). Documentados.
- **Colores de estado/semánticos saturados** (`#34C759`/`#FF9500`/`#FF3B30`/`#248A3D`/`#B45309`, dots
  de leyenda, badges de estado) → legibles en dark.

### Mozo — checklist light / dark

| Elemento | Light | Dark | Mecanismo |
|---|---|---|---|
| Fondo / header / bottom-nav | ✅ | ✅ | bridge (`var(--bg/--surface/--text)`) |
| Tabs / chips / segmentos | ✅ | ✅ | bridge + `var(--text)`/`var(--bg)` (fix) |
| Mesa-cards (grid) | ✅ | ✅ | clases + overrides dark (ocupada/cuenta/…) |
| Item-card / badges | ✅ | ✅ | bridge + overrides (listo/entregado/…) |
| Order header + acciones | ✅ | ✅ | override `.order-header`/`primary-action` |
| Inputs / selects / search | ✅ | ✅ | bridge |
| Modales / dialog | ✅ | ✅ | `var(--surface)`/`var(--border)` |
| Total bar / pay summary | ✅ | ✅ | bridge |
| Toast | ✅ | ✅ | override dark |
| Floor-plan canvas (mapa) | ✅ | ⚠️ | status map color-coded fijo (ver arriba), QA |
| Texto secundario | ✅ | ✅ | `var(--text2/--text3)` |

- Sin textos invisibles (las superficies invertidas order-header/toast/primary-action corregidas).
- Sin cards blancas raras (`.mesa-card.cuenta` y badges negros cableados).
- Light no se degrada (overrides son `[data-theme="dark"]`-only; JSX idéntico en light porque
  `var(--text)`=`#1D1D1F` / `var(--bg)`=blanco en light).

## 2) Delivery rider + cliente — alineación/documentación (NO activados)

- **Estado:** ambos siguen `MythosTheme.init('light')`. Cargan tokens.css/ui-primitives.css/
  mythos-theme.js; su contenido vive dentro de un frame "phone mockup" (`.screen`).
- **Por qué NO se activan ahora:** PR-B3G bridgeó **neutrales** a `var(--token)` pero **preservó
  deliberadamente la marca `#fff`/`#000`**: cards (`background:'#fff'`) y botones/headers
  (`background:'#000'`) hardcodeados, dispersos inline por todas las pantallas (rider ~28 hex /
  cliente ~35 hex, cliente con sólo 8 `var(--)`), además del `.screen{background:#fff}` del shell.
  Activar `init()` sin recolorear todo eso produciría **cards blancas + botones negros que se funden**
  en dark = roto. Recolorear las 2 apps de teléfono en este PR sería un **sweep** (prohibido).
- **Cliente es customer-facing:** activar dark cambia la experiencia del cliente según su dispositivo
  → decisión de producto, no parte del rollout de dark de staff.
- **Qué necesita un PR de recolor dedicado (uno por superficie):** `.screen` → superficie token;
  cards `#fff` → `var(--surface)`; botones/headers `#000` → `var(--text)`/`var(--bg)`; pills de tinte
  (`#FFF7ED`/`#F0FAF4`/…) → tinte adaptable; textos de tinte (`#166534`/`#1E40AF`/`#C2410C`/…) →
  adaptables; verificar mapas/rutas y empty/error states. Recién ahí `init()`.
- **En este PR no se tocó código de delivery** (cero riesgo).

## 3) Superficies data-gated / sensibles no verificadas (QA)
- **Mozo floor-plan (vista mapa)** con mesas reales en varios estados (status map color-coded; celda
  "ocupada" puede verse con bajo contraste en dark) y su **leyenda**.
- **Mozo order detail / cobro / pago** con un pedido real (header dark, segmento de método, total).
- **Mozo heroes** (card de perfil, popup de transferencia, toast Bancard): blend leve en dark.
- **Delivery rider/cliente**: no activados; pendientes de recolor + QA.

## 4) Hallazgos funcionales (NO corregidos — visual/dark-only)
- **No se observaron** errores `42501`/`PGRST116`/RLS durante la edición (PR estático, sin tocar
  queries/RPC/endpoints). Si aparecen en QA runtime → documentar aparte, **no** arreglar aquí.
- Observación (no-bug): en Mozo, `.order-header`/`.toast` usaban `background:var(--text)` (patrón
  "invertido") que sólo funciona en light; corregido con overrides dark (color-only).

## 5) Pendiente para Login / Diag (y Delivery)
- **Login / Diag:** fuera de alcance de B4G (su propio PR). 
- **Delivery rider + cliente:** recolor dedicado por superficie antes de activar (ver §2).

## 6) Riesgos visuales
- **Acotado a Mozo.** Light no se degrada (overrides dark-only; JSX color-only idéntico en light).
  Dark de Mozo construido sobre el bridge + overrides additivos + cableado de segmentos. Reversible.
  Riesgo residual conocido: floor-plan/canvas de Mozo (status map color-coded) — pendiente QA.
- **Delivery sin cambios** → cero riesgo.

## 7) Build
- `npm run build`: **PASS — 9/9** (`built in` ×9, `mozo.js` 241.49 kB, sin errores).

## Confirmación de no-alcance
`git diff --name-only main` ⇒ **`public/mozo.html` + `src/mozo/main.jsx`** (+ este doc). Sin cambios en
`mythos-theme.js`, `tokens.css`, `ui-primitives.css`, otros paneles, `delivery-rider.html`/
`src/delivery-rider/main.jsx`, `delivery-cliente.html`/`src/delivery-cliente/main.jsx`,
`src/index/main.jsx`, `public/index.html`, `public/build/*`. No se tocó: Auth/backend/Supabase/DB/RLS/
RPC/migraciones/datos/teardown/permisos/lógica de pedidos/asignación/estados/ubicación/timers/API/
flujos/handlers/condiciones de render/queries/payloads. Toggle de Mozo reutilizado (preexistente).
**QR/menu intacto y excluido. Gerente/Superadmin/Admin/Caja/Cocina/Login no tocados. Delivery no
tocado (documentado).**
