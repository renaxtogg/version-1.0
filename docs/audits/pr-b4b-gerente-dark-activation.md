# PR-B4B — Gerente dark activation

> FASE B (UI/UX + dark global). Primer panel staff activado en dark, tras la foundation PR-B4A.
> Fecha: 2026-06-17 · Rama: `fix/pr-b4b-gerente-dark-activation` · Base: `main = 714b532`.
> Frontend/visual. NO toca lógica, datos, backend, ni otros paneles.

## Objetivo

Activar dark mode **real y persistente solo en Gerente**, usando la infraestructura existente
(`MythosTheme` / `data-theme` / tokens), y asegurar que el panel se vea usable y premium en dark
sin degradar light.

## 1) Cómo se activa dark en Gerente

- **Gerente ya tenía casi todo:** un objeto de paleta `C` con variantes **light/dark** (`PALETTES`)
  **reactivo a `mythos:themechange`** (re-tiñe bg/surface/text/border al cambiar de tema), y **un
  toggle de tema YA wireado** en el header del sidebar (`MythosTheme.toggle()` + ícono sun/moon +
  estado `themeMode`). Lo único que forzaba light era el **pin del shell**.
- **Cambio de activación (1 línea):** `public/gerente.html` pasa de `MythosTheme.init('light')` a
  **`MythosTheme.init()`** → respeta `localStorage['mythos-theme']` / sistema y **persiste** la
  elección del usuario vía el toggle existente. **Solo Gerente**; el resto de shells siguen pineados.
- **`mythos-theme.js` NO se tocó** (ya soporta init()/set()/toggle()).
- **`data-theme="dark"` cambia realmente:** `init()` aplica el tema resuelto; el toggle llama
  `set()` que escribe preferencia, quita el pin y aplica → en recarga, `init()` respeta la
  preferencia guardada (dark persiste). Volver a light: el mismo toggle → `set('light')`.
- **¿Se agregó toggle?** No hizo falta: ya existía y está wireado. Se mantuvo.

## 2) Ajustes visuales para contraste dark (Gerente)

El núcleo (fondos/superficies/texto/bordes/cards/nav/botones primitivos/metric cards) **ya
adaptaba** vía `C` + primitivos `.my-*`. Se corrigieron los literales inline que **no** pasaban por
`C` y romperían en dark (parches claros / negro invisible). **Toda la lógica/condicionales intactos:
solo se cambió el valor de color.**

- **`public/gerente.html`** — spinner `.spin`: `#D2D2D7`/`#1D1D1F` → `var(--border)` /
  `var(--text-primary)` (se veía mal sobre fondo oscuro).
- **`src/gerente/main.jsx`** — se agregaron **slots de tinte suave theme-aware** a `PALETTES`
  (light = valor actual exacto; dark = tinte del color de estado a baja opacidad sobre la surface):
  `redSoft/redSoftBorder/redSoftText`, `greenSoft/…`, `orangeSoft/…`, `blueSoft`. Y se cablearon:
  - **Toasts** (ok/error), **alerta crítica del dashboard**, **fila de pedido demorado**,
    **card "Llamadas de mozo"**, **chips item-86**, **aviso de solicitudes pendientes**,
    **badge de alta afluencia** y **calendario** (día seleccionado/hoy/alta-prioridad + leyenda) →
    de literales `#FFF1F0/#FFB3AD/#FFF4E0/#FFD580/#F0F6FF/#FFF8F0/#F0FAF3/…` a `C.*Soft*`.
  - **Botones de filtro** (×2) y **burbujas de chat de soporte**: el patrón negro/blanco
    (`'#000'`/`'#fff'`) que invertía mal → `C.ink` / `C.surface` (theme-reactivo).

**NO se tocó** (semánticos, legibles en dark): colores de estado puntuales (`SC`, `PRIO_COL`),
dots de tipo de evento (`G_CAL_TYPES`), ni el `#fff` de texto sobre badge rojo (on-color correcto).

## 3) Checklist visual light / dark (Gerente)

| Elemento | Light | Dark | Mecanismo |
|---|---|---|---|
| Fondo / sidebar | ✅ | ✅ | `C.bg` / `C.sidebar` (#F5F5F7/#FFFFFF → #000000/#1C1C1E) |
| Cards (Card = `.my-card`) | ✅ | ✅ | tokens (surface/border/shadow) |
| **Metric cards (Opción A neutra)** | ✅ | ✅ | `.my-metric-card` neutro; accent = color de valor vía `C` (sin tinte por estado) |
| Botones (`.my-btn` / Btn) | ✅ | ✅ | tokens; nav activo `C.ink` |
| Inputs / selects (shell) | ✅ | ✅ | `var(--surface/--border/--text-primary)` |
| Tablas / listas / filas | ✅ | ✅ | `C` (surface/bg/border) |
| Modales | ✅ | ✅ | `C.surface` + tokens |
| Alertas / toasts / badges | ✅ | ✅ | nuevos slots `C.*Soft*` (tinte adaptado) |
| Filtros / chat soporte | ✅ | ✅ | `C.ink` / `C.surface` (ya no `#000`/`#fff`) |
| Calendario (sel/hoy/alta) | ✅ | ✅ | `C.ink` / `C.blueSoft` / `C.orangeSoft` |
| Spinner | ✅ | ✅ | `var(--border/--text-primary)` |
| Estados/dots semánticos | ✅ | ✅ | colores de estado saturados (legibles en dark) |

- **Sin textos invisibles**, **sin cards blancas sobre fondo oscuro**, **sin botones con contraste
  invertido** (verificado por scan: 0 literales `#fff`/`#000`/tinte-claro inline sin adaptar, salvo
  los semánticos correctos).
- **Light no se degrada:** los slots light = valores actuales; única microvariación intencional:
  3 amb.es casi idénticos unificados a un solo `orangeSoft` (#FFF8F0/#FFF9F0 → #FFF4E0,
  imperceptible) y el negro de marca `#000` → `C.ink` (#1D1D1F, delta de marca estándar de FASE B).

## 4) Observaciones / pendientes

- **`C.dark.bg` es `#000000` (negro puro)** — el design system prefiere `#0B0B0D`. Funciona y da
  buen contraste con las cards `#1C1C1E`; alinearlo es polish opcional (no bloquea).
- Vistas/estados **data-gated** (toasts, demorados, llamadas mozo, item-86, chat con hilos) se
  validaron por código + tema; conviene un spot-check visual con datos reales en QA.

## 5) Pendiente para otros paneles (NO tocados aquí)

Admin, Superadmin, Caja, Mozo, Delivery (rider/cliente), Login, Cocina → **siguen pineados** (sin
activar). Cada uno en su propio PR (B4C…), siguiendo este patrón: `init('light')`→`init()` +
toggle + contraste de literales inline. **QR/menu (index): EXCLUIDO** (branding por `mood`).

## 6) Riesgos visuales

- **Acotado a Gerente.** Light prácticamente idéntico (deltas de marca/unificación imperceptibles).
  Dark nuevo pero construido sobre `C` + `.my-*` + tokens, con todos los literales de contraste
  cubiertos. Reversible. Sin riesgo de layout/lógica.

## 7) Build

- `npm run build`: **PASS — 9/9** (`built in` ×9, sin errores).

## Confirmación de no-alcance

`git diff --name-only main` ⇒ **`public/gerente.html` + `src/gerente/main.jsx`** (+ este doc). Sin
cambios en `mythos-theme.js`, tokens.css, ui-primitives.css, otros paneles, `src/index/main.jsx`,
`public/index.html`, `public/build/*` (gitignored). No se tocó: Auth/backend/Supabase/DB/RLS/RPC/
migraciones/datos/teardown/permisos/lógica/API/flujos/handlers/condiciones de render/queries/
payloads. **Solo el handler visual del toggle (preexistente) gobierna el tema. QR/menu intacto y
excluido. Ningún otro panel activado.**
