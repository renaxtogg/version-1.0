# PR-B1 — Tokens globales + theme foundation

> FASE B (UI/UX unificado + dark mode). Primer PR de la secuencia PR-B1…PR-B5.
> Fecha: 2026-06-17 · Rama sugerida: `fix/pr-b1-theme-foundation`.
> Alcance: **solo foundation.** No migra componentes, no rediseña paneles, no libera dark global.

## Qué hace

1. **`public/tokens.css`** — fuente única de design tokens (sección B de `MYTHOS_UIUX_STYLE_SKILL.md`):
   - `:root` (light) y `[data-theme="dark"]` (dark con `--bg:#0B0B0D`, **no** `#000000`).
   - `--on-primary/--on-success/--on-warning/--on-error/--on-info`, `--overlay`/`--overlay-strong`.
   - Tipografía (`--font`, `--font-mono`, escala `--text-xs…3xl`, pesos), espaciado 4px,
     radios, sombras (light + override dark) y alturas de control (`--control-sm/md/lg`).
   - Alias de compatibilidad (`--bg-card`, `--bg-primary`, `--accent`, `--text-muted`,
     `--danger`, `--border-hover`, …) que resuelven por tema vía `var()`.
2. **Enlace global** — se añadió `<link rel="stylesheet" href="tokens.css">` **después** de
   `design-system.css` en los 9 paneles que comparten el design system (index, mozo, caja,
   cocina, gerente, admin, superadmin, delivery-cliente, delivery-rider). El orden de carga
   hace que los valores corregidos de `tokens.css` ganen por cascada sin tocar componentes.
3. **Foundation de tema** — `public/mythos-theme.js` pasa de "modo fijo sin persistencia" a un
   gestor de tema retrocompatible:
   - `data-theme` vive en `document.documentElement` (`<html>`).
   - Persistencia en `localStorage['mythos-theme']` con valores `light | dark | system`.
   - `system` o sin preferencia → `window.matchMedia('(prefers-color-scheme: dark)')`.
   - `init('light'|'dark')` sigue **fijando el modo por panel** (compat): no persiste y no
     cambia la apariencia actual. `init()` sin argumento sigue la preferencia (lo usará PR-B4).
   - `set()`, `toggle()`, `get()`, `getPreference()`, `resolve()`, `onChange()` ya funcionan;
     el wiring de un botón de toggle queda para PR-B4 (no se libera dark parcial).

## Convención de storage

La clave oficial nueva es **`mythos-theme`** (con guion). La versión previa no persistía y
limpiaba las claves legacy `mythos_theme` / `mesa_theme` (con guion bajo); se siguen limpiando
por higiene. No hay conflicto de nombres.

## Único delta visual (intencional, mandado por la skill)

Como `tokens.css` corrige la paleta base, hay exactamente dos cambios de valor con consumidor:

- `--accent` en **light**: `#000000` → `#1D1D1F` (casi-negro de marca; sub-perceptible). Afecta
  chips/botones del panel Mozo que usan `var(--accent)`.
- Base **dark** del único panel oscuro (cocina): `--bg` `#000000` → `#0B0B0D` y
  `--bg-subtle` `#1C1C1E` → `#111113` ("sin negro puro").

Todos los demás valores resueltos quedan idénticos a los previos. `--bg-primary`/`--bg-secondary`
no tienen consumidores en el repo, así que el mapeo nuevo del alias no produce regresión.

## Lo que NO toca

Auth · backend · DB/RLS/RPC · migraciones · pricing · CRM · teardown · lógica de negocio ·
layouts/componentes/paneles. No se migra ningún primitivo (eso es PR-B2). `login.html` y
`diag.html` no comparten el design system hoy y quedan fuera de alcance (Login se aborda en PR-B4).

## Verificación de tokens (DevTools)

```js
// Dark
document.documentElement.dataset.theme = 'dark';
getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();      // "#0B0B0D"

// Light (quitar el atributo / dejar default)
delete document.documentElement.dataset.theme;
getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();      // "#FFFFFF"

// Tokens presentes
getComputedStyle(document.documentElement).getPropertyValue('--surface').trim();     // "#FFFFFF" (light)
getComputedStyle(document.documentElement).getPropertyValue('--on-primary').trim();  // "#FFFFFF" (light)
getComputedStyle(document.documentElement).getPropertyValue('--overlay').trim();     // "rgba(0,0,0,.4)" (light)
```

## Siguiente

PR-B2 — cablear primitivos compartidos (buttons, cards, inputs, badges, modals, tables, shell)
a estos tokens y barrer hardcodeos `#fff`/inline. No iniciar sin aprobación.
