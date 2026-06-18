# PR-B3I.1 — Radios + sombras globales

> FASE B (UI/UX unificado + dark mode). Primer PR de implementación tras la auditoría PR-B3I.
> Fecha: 2026-06-17 · Rama: `fix/pr-b3i-1-radius-shadows` · Base: `main = 4f37a80`.
> Frontend/visual, CSS-only. **NO** toca lógica, flujos, paneles, dark global ni Index/QR.

## Objetivo

Unificar **radios** y **sombras** en el origen (tokens) para que las superficies del
sistema se vean más parejas, suaves y premium (iOS/Apple-like), aplicando **un solo cambio
global seguro** y sin tocar markup de paneles.

## Hallazgo previo (qué estaba pasando)

La auditoría PR-B3I detectó dispersión de radios (~19 valores, dominante `8px` **fuera de
escala**) y de sombras (0→10 por panel). Pero esa dispersión vive en el **markup inline de
los paneles**, que este PR tiene **prohibido** tocar.

A nivel de sistema, en cambio:

- **Las escalas radius/shadow ya existían** en `tokens.css` y **los primitivos `.my-*`
  (`ui-primitives.css`) ya las consumían de forma coherente** (`.my-card`/`.my-metric-card`
  = `--radius-lg` + `--shadow-sm`; `.my-btn` = `--radius-md`; modales = `--radius-lg` +
  `--shadow-lg`; etc.). **No había dispersión dentro de los primitivos.**
- Por tanto, el único lever global **seguro** y dentro de alcance es **refinar los valores de
  los tokens en el origen** → se propaga uniformemente a todas las superficies `.my-*`
  **sin tocar paneles, JSX ni lógica**.

## Blast radius (medido, no asumido)

Consumidores reales de `--radius-*` / `--shadow-*` en producto (grep):

| Superficie | ¿Consume tokens radius/shadow? | ¿La afecta este PR? |
|---|---|---|
| `ui-primitives.css` (`.my-*`) | **Sí** | **Sí (intencional)** → Gerente, Admin, Superadmin, Caja, Cocina-stats |
| `mozo.html` / `src/mozo` | Solo `--radius`, `--radius-sm`, `--shadow-lg`, **definidos localmente en mozo.html** | **No** (aislado por override local) |
| `index`, `delivery-cliente`, `delivery-rider` (html + src) | **No** (0 referencias) | **No** |
| `login.html` | **No** (radios/sombra hardcodeados inline) | **No** |
| `diag.html` | **No** (no carga tokens) | **No** |
| `design-system.css` | Define las mismas escalas, pero **carga ANTES** que tokens.css | Queda **shadowed** por cascada (sin efecto) |

→ El cambio es **quirúrgico**: alcanza exclusivamente al sistema `.my-*`. Mozo, Delivery,
Index, Login y Diag quedan **insensibles** (valores propios o hardcodeados). Esto satisface
"paneles que usan `.my-*` deberían verse más consistentes y premium" sin tocar el resto.

## Cambios aplicados (solo `public/tokens.css`)

### Radios — escala aritmética limpia (Δ4), más suave/premium

| Token | Antes | Después | Nota |
|---|---|---|---|
| `--radius-sm` | 6px | **8px** | absorbe el `8px` dominante off-scale de los paneles |
| `--radius-md` | 10px | **12px** | botones/inputs `.my-*` un poco más suaves |
| `--radius-lg` | 14px | **16px** | cards/metric-cards/modales iOS-like (cambio más visible) |
| `--radius-xl` | 20px | 20px | sin cambio (ya cierra la progresión Δ4: 8/12/16/20) |
| `--radius-full` | 999px | 999px | sin cambio |

Escala resultante: **8 / 12 / 16 / 20 / full**. El radio es independiente del tema → aplica
igual en light y en la única superficie pineada dark (Cocina-stats), sin drift.

### Sombras (light) — modelo difuso de 2 capas (contacto + ambiente)

| Token | Antes | Después |
|---|---|---|
| `--shadow-xs` | `0 1px 2px /.06` | `0 1px 2px /.05` |
| `--shadow-sm` | `0 1px 4px /.08, 0 0 1px /.04` | `0 1px 2px /.04, 0 2px 8px /.06` |
| `--shadow-md` | `0 4px 16px /.10, 0 0 1px /.06` | `0 2px 4px /.05, 0 8px 24px /.08` |
| `--shadow-lg` | `0 8px 32px /.12, 0 0 1px /.04` | `0 4px 10px /.06, 0 16px 48px /.12` |

Menor opacidad de contacto + mayor blur de ambiente → las cards "flotan" suave, sin canto
duro. `--shadow-sm` (sombra por defecto de `.my-card`/`.my-metric-card`) es la más visible.

## Qué NO se tocó

- **`ui-primitives.css`**: revisado — ya consume las escalas de forma coherente → **0 ediciones**
  (el refinamiento se propaga solo vía los tokens; tocarlo sería redundante).
- **`design-system.css`**: fuera de alcance; tokens.css lo sobreescribe por cascada (queda
  como duplicado inerte — ver deuda técnica abajo).
- **Sombras dark** (`[data-theme="dark"]` en tokens.css y design-system.css): **diferidas a
  PR-B4** (no se activa dark global; la única superficie dark, Cocina-stats, conserva sus
  sombras dark actuales y solo recoge el nuevo radio).
- **Paneles** (markup inline, JSX, hex hardcodeados): no se tocó ninguno.
- **Index/QR, Mozo, Delivery, Login, Diag**: insensibles al cambio (medido) y no editados.
- **Tipografía, espaciado, navegación, charts, botones especiales**: fuera de alcance (PRs
  posteriores B3I.2…B3I.6).
- **Auth / backend / Supabase / DB / RLS / RPC / migraciones / datos / teardown / permisos /
  lógica / API / flujos**: intactos.

## Riesgos visuales

- **Bajo y reversible (CSS-only).** Cambia el aspecto de las cards/botones/modales `.my-*`
  (radios +2px, sombras más difusas) en Gerente/Admin/Superadmin/Caja/Cocina-stats. No hay
  riesgo de layout (radius/shadow no alteran el box model) ni de lógica.
- **Cocina (pineada dark):** las metric/cards de StatsPanel pasan a radio 16px (consistente);
  las sombras dark no cambian (no tocadas).
- Cualquier ajuste fino de valores es trivialmente reversible.

## Deuda técnica detectada (no resuelta aquí)

- **Duplicación de escalas:** `design-system.css` y `tokens.css` definen `--radius-*` y
  `--shadow-*` con los mismos valores; tokens.css gana por orden de carga, así que el bloque
  de design-system.css quedó **stale/inerte** para estos tokens. Consolidar (retirar la
  definición duplicada de design-system.css) es candidato a PR-B5 (cierre de migración),
  fuera de alcance aquí.
- **Sombras dark** pendientes de armonizar al modelo de 2 capas en PR-B4.

## Build

- `npm run build`: **PASS — 9/9** paneles (`built in` ×9, sin errores).
- `npm run typecheck`: no existe (JS/JSX puro, sin tsconfig).

## Confirmación de no-alcance

`git diff --name-only main` ⇒ **solo `public/tokens.css`** (+ este doc al commitear). Sin
cambios en `public/build/*` (gitignored). No se tocó: ningún panel, ni Auth/backend/Supabase/
DB/RLS/RPC/migraciones/teardown/datos/permisos/API/lógica/flujos. **Dark global NO activado.
Index/QR NO tokenizado.**
