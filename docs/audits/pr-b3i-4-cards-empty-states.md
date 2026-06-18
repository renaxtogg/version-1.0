# PR-B3I.4 — Cards + estados vacíos + metric cards

> FASE B (UI/UX unificado + dark mode). Cuarto PR de implementación tras la auditoría PR-B3I.
> Fecha: 2026-06-17 · Rama: `fix/pr-b3i-4-cards-empty-states` · Base: `main = 9631b7c`.
> Frontend/visual, **CSS-only** (solo `public/ui-primitives.css`). NO toca lógica, flujos,
> paneles, JSX/HTML, dark global ni Index/QR.

## Objetivo

Unificar cards, metric cards, estados vacíos y bloques informativos para un look más parejo,
limpio y premium (iOS/Apple-like), aplicando **solo cambios CSS globales seguros**.

## Inspección (qué se encontró)

Primitivos existentes y su consumo real en paneles (grep):

| Primitivo | Estado | Consumido por |
|---|---|---|
| `.my-card` (+ `--elevated/--interactive/--selected`, `__header/__title/__subtitle/__body/__footer`) | ya refinado (radius/shadow en B3I.1, tipografía en B3I.3) | gerente (default), cocina×3 y superadmin (con `padding` inline override) |
| `.my-metric-card` (+ `__label/__value/__delta`) | ya refinado (B3I.1 + B3I.3) | admin, caja, superadmin, cocina-stats |
| `.my-empty-state` (+ `__icon/__title/__hint`) | **0 consumidores** (aditivo de PR-B2, sin adoptar) | — |
| `.my-loading-state` (+ `__spinner`) | **0 consumidores** | — |
| `.my-alert` / `.my-panel` / `.my-section` | **NO existían** | — |

Conclusiones:
- **`.my-card` y `.my-metric-card` ya están coherentes y premium** (radio/sombra los fijó B3I.1;
  interlineado/tracking los fijó B3I.3). Tocar su **padding** solo afectaría a **gerente** (los
  demás consumidores lo sobreescriben inline), y el criterio pide **no forzar padding** → no se
  tocó su estructura.
- La inconsistencia real de cards es que **Admin/Caja usan cards inline** (no `.my-card`); migrarlas
  toca JSX → **panel-touching, fuera de alcance** (se reporta).
- `.my-empty-state`/`.my-loading-state` no los usa nadie → refinarlos es **cero riesgo**.
- Faltaban primitivos para **alerts / bloques informativos / secciones** (los pide el alcance).

## Cambios aplicados (solo `public/ui-primitives.css`)

### 1. Estados vacíos — pulido premium (0 consumidores → cero cambio visual)

- `.my-empty-state__icon`: ahora **ícono en contenedor circular suave** (`--bg-subtle`, 48px,
  `--radius-full`) — patrón empty-state iOS-like, en vez de un glifo suelto.
- `.my-empty-state__title` / `__hint`: + `line-height` coherente (snug / normal).

### 2. `.my-alert` — bloque informativo suave **ADITIVO** (cero consumidores)

Nuevo primitivo. Base neutra + variantes `--info / --success / --warning / --danger` con **tinte
suave derivado por `color-mix` sobre tokens** (mismo lenguaje que `.my-badge`) → "informativos
menos duros", sin colores agresivos. Sub-elementos `__icon / __content / __title / __body`.

### 3. `.my-section` — contenedor informativo titulado **ADITIVO** (cero consumidores)

Nuevo primitivo: agrupa `__header / __title / __subtitle / __body` con ritmo vertical coherente
usando el type-scale de B3I.3. Fundación para los "bloques de dashboard" y contenedores.

### 4. Lo que deliberadamente NO se agregó / cambió

- **`.my-panel`: NO se agrega** (sería redundante con `.my-card` como contenedor de superficie).
- **`.my-card` / `.my-metric-card`: estructura y padding intactos** (ya refinados; evitar reflow).
- **`tokens.css`: NO tocado** (los tintes de alert se derivan por `color-mix` de tokens existentes).

## Paneles afectados

| Cambio | Afecta | Cómo |
|---|---|---|
| `.my-empty-state` / `.my-loading-state` | **ninguno** (0 consumidores) | aditivo → cero cambio visual |
| `.my-alert` / `.my-section` | **ninguno (hoy)** | aditivos → cero cambio visual |
| `.my-card` / `.my-metric-card` | **sin cambios** | no se tocaron |

→ **Este PR no produce ningún cambio visual en producción hoy**: todo lo editado/agregado son
primitivos sin consumidores o ya-refinados. El valor es **fundación canónica** (alert/section,
empty-state premium) lista para que los paneles la adopten en un PR futuro (toca paneles →
aprobación aparte), siguiendo el patrón de B3I.2 (nav) y B3I.3 (type-scale).

**Insensibles:** todos los paneles (Gerente/Admin/Superadmin/Caja/Cocina/Mozo/Delivery/Index/
Login/Diag) — nadie consume lo agregado/refinado.

## Qué quedó fuera de alcance (y por qué)

- **Cards inline de Admin/Caja** (la divergencia real): migrarlas a `.my-card` toca JSX →
  **panel-touching**, fuera de alcance (criterio de éxito: reportar, no forzar).
- **Padding/densidad** de cards y metric cards: no se tocó (reflow risk en paneles densos).
- **Charts / data-gated** (Superadmin MRR, etc.): **PR-B3I.5** (requieren datos/lógica).
- **Caja/Cocina/Mozo/Delivery** refinamiento propio: **PR-B3I.5**.
- **Navegación inline, botones operativos especiales:** no tocados.
- **Auth / backend / Supabase / DB / RLS / RPC / migraciones / datos / teardown / permisos /
  lógica / API / flujos:** intactos. **Dark global NO activado. Index/QR NO tokenizado.**

## Riesgos visuales / reflow

- **Nulo en producción hoy.** Los primitivos refinados (`.my-empty-state`/`.my-loading-state`) no
  tienen consumidores; los nuevos (`.my-alert`/`.my-section`) tampoco. `.my-card`/`.my-metric-card`
  no se tocaron → **cero riesgo de reflow** en Gerente/Admin/Superadmin/Caja/Cocina-stats.
- Al adoptarse en el futuro, son superficies suaves y tokenizadas (sin colores duros).

## Build

- `npm run build`: **PASS — 9/9** paneles (`built in` ×9, sin errores).
- `npm run typecheck`: no existe (JS/JSX puro).

## Confirmación de no-alcance

`git diff --name-only main` ⇒ **solo `public/ui-primitives.css`** (+ este doc al commitear). Sin
cambios en `public/build/*` (gitignored), `tokens.css`, paneles, JSX/HTML/handlers, ni en
Auth/backend/Supabase/DB/RLS/RPC/migraciones/teardown/datos/permisos/API/lógica/flujos.
