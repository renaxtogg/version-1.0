# PR-B3I.2 — Botones + navegación

> FASE B (UI/UX unificado + dark mode). Segundo PR de implementación tras la auditoría PR-B3I.
> Fecha: 2026-06-17 · Rama: `fix/pr-b3i-2-buttons-navigation` · Base: `main = 6e9d8af`.
> Frontend/visual, **CSS-only** (solo `public/ui-primitives.css`). NO toca lógica, flujos,
> paneles, JSX/HTML, dark global ni Index/QR.

## Objetivo

Unificar visualmente botones y navegación (tabs/sidebars/segmented) para que MYTHOS se vea
más parejo, suave y premium (iOS/Apple-like), aplicando **solo cambios CSS globales seguros**.

## Inspección (qué se encontró)

- **Botones:** `.my-btn` + variantes (`--primary/--secondary/--ghost/--danger/--success` +
  tamaños) **ya están centralizados** en `ui-primitives.css` y son consumidos por el componente
  `Btn` compartido de **4 paneles** (`gerente`, `caja`, `superadmin`, `admin`) con el mismo mapeo
  (`primary/danger/success/ghost` → variante; resto → `secondary`). → refinar `.my-btn`/estados
  en el origen **se propaga a esos 4 paneles sin tocar JSX**.
- **Navegación:** **NO existe** ningún primitivo `.my-nav` / `.my-tab` / `.my-sidebar` /
  `.my-segment` (los 5 "matches" iniciales eran falsos positivos de `.my-table`). Cada panel
  resuelve su navegación **inline** (toolbar de Cocina, tabs de Mozo con clases locales, etc.).
  No hay nav centralizada que refinar globalmente, y tocar el nav inline de los paneles está
  **fuera de alcance** (sería rediseño de panel / handlers sensibles).
- **`--transition`:** no existe como token; los primitivos lo referencian con fallback
  `var(--transition, 150ms ease)`. Como el fallback ya funciona, **no era estrictamente
  necesario** crear el token → `tokens.css` NO se tocó.

## Cambios aplicados (solo `public/ui-primitives.css`)

### 1. Botones — focus ring suave (premium, coherente con inputs)

`.my-btn:focus-visible` pasa del **outline duro** azul a un **anillo translúcido** consistente
con `.my-input:focus`:

```css
/* antes */                              /* después */
outline: 2px solid var(--info);          outline: 2px solid transparent;   /* forced-colors */
outline-offset: 2px;                     outline-offset: 2px;
                                         box-shadow: 0 0 0 3px color-mix(in srgb, var(--info) 35%, transparent);
```

- El `outline` transparente preserva la visibilidad de foco en modo alto-contraste/forced-colors.
- Es la única refinación de botón: las variantes y el layout se mantienen porque ya son
  **coherentes y context-safe** (p. ej. `--secondary` con fondo `--surface` funciona igual sobre
  cards blancas y sobre páginas grises; cambiarlo a relleno tonal lo haría desaparecer sobre
  fondos `--bg-subtle` → se descartó por contraste).

### 2. Navegación — primitivos canónicos **aditivos** (cero consumidores)

Se agregan, consumiendo **solo tokens** y **sin que ningún panel los use todavía**
(→ **cero cambio visual**), como fundación para migrar la navegación inline en un PR futuro
(igual que PR-B2 adelantó botones/cards antes de su adopción):

- **`.my-tabs` / `.my-tab` / `.my-tab--active`** — tabs horizontales con indicador underline.
- **`.my-segment` / `.my-segment-item` / `.my-segment-item--active`** — segmented control iOS
  (pill seleccionable sobre `--bg-subtle`, activo con `--surface` + `--shadow-xs`).
- **`.my-nav` / `.my-nav-item` / `.my-nav-item--active`** — sidebar/nav vertical.

Estados: hover suave (`--surface-hover`/color), activo claro (peso + fondo/underline), focus
con outline inset (convención ya usada por `.my-list-item--interactive`). Sin sombras duras.

## Paneles afectados

| Cambio | Afecta | Cómo |
|---|---|---|
| Focus ring `.my-btn` | **gerente, caja, superadmin, admin** | por cascada (consumen `.my-btn`); cero JSX tocado |
| Primitivos de nav | **ninguno (hoy)** | aditivos, sin consumidores → cero cambio visual |

**Insensibles:** Cocina (sus botones son toolbar-toggles/KDS-actions, NO `.my-btn`), Mozo,
Delivery, Index, Login, Diag (no consumen `.my-btn` ni los nuevos primitivos).

## Qué quedó fuera de alcance (y por qué)

- **Nav inline de paneles** (Cocina toolbar, Mozo tabs, sidebars de admin/superadmin/gerente):
  no consumen primitivos; cablearlos toca JSX/HTML y handlers → **PR futuro** (panel-touching).
- **Botones operativos especiales:** acciones KDS/Cocina, cobro/operación de Caja, **toggles**,
  botones **data-gated** e inline con handlers sensibles → **no tocados** (riesgo de comportamiento).
- **Variante `--secondary` con relleno tonal:** descartada por contraste (se fundiría con páginas
  `--bg-subtle`). Se mantiene `--surface` + borde (context-safe).
- **`tokens.css`:** no tocado (token `--transition` no estrictamente necesario; fallbacks ok).
- **Tipografía / espaciado / cards / charts:** PR-B3I.3 y PR-B3I.4.
- **Auth / backend / Supabase / DB / RLS / RPC / migraciones / datos / teardown / permisos /
  lógica / API / flujos:** intactos. **Dark global NO activado. Index/QR NO tokenizado.**

## Riesgos visuales

- **Bajo y reversible (CSS puro).** Único cambio visible: el **foco por teclado** de los botones
  `.my-btn` en 4 paneles pasa de outline azul a anillo translúcido (más premium, igual que inputs).
  Sin cambio en estados de reposo/hover/active, sin riesgo de layout (no altera box model).
- Los primitivos de nav **no cambian nada** hasta que un panel los adopte (aditivos).

## Build

- `npm run build`: **PASS — 9/9** paneles (`built in` ×9, sin errores).
- `npm run typecheck`: no existe (JS/JSX puro).

## Confirmación de no-alcance

`git diff --name-only main` ⇒ **solo `public/ui-primitives.css`** (+ este doc al commitear).
Sin cambios en `public/build/*` (gitignored), `tokens.css`, paneles, JSX/HTML/handlers, ni en
Auth/backend/Supabase/DB/RLS/RPC/migraciones/teardown/datos/permisos/API/lógica/flujos.
