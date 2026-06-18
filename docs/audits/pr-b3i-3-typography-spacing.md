# PR-B3I.3 — Tipografía + espaciado

> FASE B (UI/UX unificado + dark mode). Tercer PR de implementación tras la auditoría PR-B3I.
> Fecha: 2026-06-17 · Rama: `fix/pr-b3i-3-typography-spacing` · Base: `main = 67426ac`.
> Frontend/visual, **CSS-only** (`public/tokens.css` + `public/ui-primitives.css`). NO toca
> lógica, flujos, paneles, JSX/HTML, dark global ni Index/QR.

## Objetivo

Unificar la jerarquía tipográfica y el ritmo de espaciado en el origen (tokens + primitivos),
aplicando **solo cambios CSS globales seguros**, para un look más parejo, limpio y premium
(iOS/Apple-like).

## Inspección (qué se encontró)

- **No existen primitivos tipográficos standalone** (`.my-title`, `.my-text`, `.my-kpi`, etc.).
  La tipografía vive en **clases component-scoped** (`.my-card__title/__subtitle/__body`,
  `.my-metric-card__value/__label/__delta`, `.my-label`, `.my-modal__title/__body`,
  `.my-empty-state__*`, `.my-table__header`…) que **ya consumen** el scale `--text-*` /
  `--weight-*` de forma coherente.
- **No existía token de `line-height`.** La mayoría de las clases tipográficas no fijaba
  interlineado → heredaba (ritmo inconsistente). **Gap real** a cubrir.
- La dispersión "dura" (~25 tamaños de fuente del audit PR-B3I) vive en el **markup inline de
  los paneles**, fuera de alcance de este PR (no se toca markup).
- **Densidad** (Admin/Caja): la reducción global de densidad (subir padding/gaps de `.my-card`)
  arriesga reflow/overflow en paneles densos → se **reporta**, no se fuerza (criterio de éxito).

## Cambios aplicados

### 1. `public/tokens.css` — tokens de interlineado (gap real)

```css
--leading-tight:  1.15;   /* titulares / KPI */
--leading-snug:   1.3;    /* títulos */
--leading-normal: 1.5;    /* cuerpo / labels */
```

Independientes del tema. Eran **estrictamente necesarios** (no existía line-height tokenizado).

### 2. `public/ui-primitives.css` — refinar clases tipográficas EXISTENTES

Solo `line-height` + tracking premium. **NO se cambió ningún `font-size`** → cero reflow de
tamaño (solo se ajusta el alto de línea y el espaciado entre letras de titulares).

| Clase | Cambio |
|---|---|
| `.my-card__title` | + `line-height: snug` + `letter-spacing: -0.01em` |
| `.my-card__subtitle` | + `line-height: normal` |
| `.my-card__body` | + `line-height: normal` |
| `.my-metric-card__value` | `letter-spacing: -0.5px` → `-0.02em` (relativo, escala mejor) + `line-height: tight` |
| `.my-modal__title` | + `line-height: snug` + `letter-spacing: -0.01em` |
| `.my-modal__body` | + `line-height: normal` |
| `.my-label` | + `line-height: normal` |

### 3. `public/ui-primitives.css` — type-scale canónico **ADITIVO** (cero consumidores)

Se agregan, consumiendo **solo tokens** y **sin que ningún panel los use todavía**
(→ **cero cambio visual**), como fundación para migrar el texto inline en un PR futuro
(igual que PR-B3I.2 adelantó los primitivos de nav). Sus valores **reflejan** las clases
component-scoped ya existentes para que el sistema tipográfico sea **uno solo**:

- **`.my-display`** — hero `text-3xl`/bold/tight/`-0.02em`
- **`.my-title`** — título `text-xl`/semibold/snug/`-0.01em` (= `.my-modal__title`)
- **`.my-subtitle`** — `text-md`/semibold/snug (= `.my-card__title`)
- **`.my-body`** — cuerpo `text-base`/regular/normal
- **`.my-caption`** — `text-sm`/secondary/normal
- **`.my-eyebrow`** — overline `text-xs`/semibold/uppercase/`0.06em` (= `.my-metric-card__label`)
- **`.my-kpi`** — cifra `text-2xl`/bold/tight/`-0.02em` (= `.my-metric-card__value`)

## Paneles afectados

| Cambio | Afecta | Cómo |
|---|---|---|
| line-height/tracking en clases existentes | paneles que usan `.my-card` / `.my-metric-card` / `.my-modal` / `.my-label`: **gerente, admin, superadmin, caja, cocina-stats** | por cascada; cero JSX tocado |
| Tokens de line-height | solo donde se referencian (las clases de arriba) | aditivo |
| Type-scale `.my-display`…`.my-kpi` | **ninguno (hoy)** | aditivo, sin consumidores → cero cambio visual |

**Insensibles:** Mozo, Delivery, Index, Login, Diag (no consumen estos primitivos ni el type-scale).

## Qué quedó fuera de alcance (y por qué)

- **Tamaños de fuente inline de los paneles** (la dispersión real): toca markup → PR futuro
  panel-touching.
- **Densidad de Admin/Caja:** subir padding/gaps de `.my-card` globalmente arriesga reflow en
  paneles densos → no se fuerza; queda como trabajo panel-touching (criterio de éxito).
- **Card padding/gaps:** **no se tocó** `.my-card`/`.my-metric-card` padding (evitar reflow);
  el detalle de cards/empty-states es **PR-B3I.4**.
- **Navegación inline, botones operativos especiales:** no tocados.
- **`tokens.css`:** solo se agregaron tokens de line-height (necesarios); el resto del scale
  tipográfico/espaciado ya existía y no se modificó.
- **Auth / backend / Supabase / DB / RLS / RPC / migraciones / datos / teardown / permisos /
  lógica / API / flujos:** intactos. **Dark global NO activado. Index/QR NO tokenizado.**

## Riesgos visuales

- **Bajo y reversible (CSS puro).** El único cambio visible recae en superficies `.my-*`
  (títulos/cuerpo/KPI de cards, modales, labels): interlineado más coherente y titulares con
  tracking levemente más cerrado (premium). **No se cambió ningún `font-size`** → no hay salto
  de tamaño ni riesgo de overflow por escala. Apretar el `line-height` de un título multilínea
  reduce mínimamente su alto (efecto deseado); los de una sola línea no cambian.
- El type-scale aditivo **no cambia nada** hasta que un panel lo adopte.

## Build

- `npm run build`: **PASS — 9/9** paneles (`built in` ×9, sin errores).
- `npm run typecheck`: no existe (JS/JSX puro).

## Confirmación de no-alcance

`git diff --name-only main` ⇒ **solo `public/tokens.css` + `public/ui-primitives.css`** (+ este
doc al commitear). Sin cambios en `public/build/*` (gitignored), paneles, JSX/HTML/handlers, ni
en Auth/backend/Supabase/DB/RLS/RPC/migraciones/teardown/datos/permisos/API/lógica/flujos.
