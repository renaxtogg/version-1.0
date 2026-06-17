# PR-B3C — UI primitives en Superadmin

> FASE B (UI/UX unificado + dark mode). Sigue a PR-B3A (Gerente) y PR-B3B/-FIX (Admin).
> Fecha: 2026-06-17 · Rama: `fix/pr-b3c-superadmin-ui` · Base: `main = edf356d`.
> Alcance: **solo el panel Superadmin.** Frontend/visual. Mismo patrón validado.

## Objetivo

Que Superadmin empiece a consumir las primitivas `.my-*` migrando las **definiciones de sus
componentes compartidos**, de modo que el cambio se propague a todos los usos con un diff mínimo
y sin tocar call sites, handlers, props, ids, data-attributes ni lógica.

## Verificación previa (lección de PR-B3B-FIX)

Se confirmó que los componentes compartidos **sí se usan en las superficies renderizadas** (no
hay coverage gap como en el Dashboard de Admin): el componente `Kpi` se usa **12×**, incluido el
**dashboard principal** (Restaurantes activos / MRR Total / Pedidos hoy / Rating — líneas 745-748).
Por eso migrar la definición alcanza la UI real.

## Archivos modificados

- **`src/superadmin/main.jsx`** — 3 definiciones de componente migradas a `.my-*` + 1 tokenización.
- **`public/build/superadmin.js`** — bundle reconstruido (`npm run build`). **Gitignored**, no versionado.
- **`docs/audits/pr-b3c-superadmin-ui.md`** — este doc.

`git diff --name-only` ⇒ solo `src/superadmin/main.jsx`. Ningún otro panel.

## Cambios (solo `src/superadmin/main.jsx`)

1. **`Kpi` → `.my-metric-card`** (Opción A, superficie neutra) + label `.my-metric-card__label`.
   Se conserva el valor (28px bold; color a `var(--text-primary)`) y el `sub`. Propaga a **12**
   usos de `<Kpi>` (dashboard + métricas de plataforma + soporte).
2. **`Btn` → `.my-btn my-btn--<variant>`** (+ `my-btn--sm` si `size==='sm'`; `is-disabled` si
   `disabled`). Se preserva la semántica de `onClick` (sigue guardado por `disabled`). Mapeo:
   primary/ghost/danger/success → su clase; `warn` → secondary (no hay variante warn; además no
   se usa). Propaga a **39** usos de `<Btn>`. *Nota:* `danger`/`success` pasan de tinte suave a
   sólido (estándar del design system).
3. **`SectionCard` → `.my-card`** con `padding:0` + `overflow:hidden` preservados, para que el
   contenido (tablas) siga edge-to-edge y el header conserve su propio padding. Da a Superadmin
   superficie/borde/radio/sombra por tokens. Header: borde y título a `var(--border)` /
   `var(--text-primary)`.
4. **`#F5F5F7` (fondo de página/card observado por QA) tokenizado en el origen:**
   `C_LIGHT.bg: '#F5F5F7'` → **`var(--bg-subtle)`**. Cubre las usos de `C.bg` (página/wrappers)
   → token-driven y dark-ready; en light el valor es idéntico. Verificado que `C.bg` **no** se
   interpola en el HTML detached de impresión/exportación (`document.write`, L2547, que usa solo
   colores hardcodeados), así que `var()` siempre resuelve en el DOM temizado.

## ¿Se tocó `ui-primitives.css` / `tokens.css`?

**No.** Las primitivas existentes alcanzaron. Diff de CSS global = 0.

## CSS inline reducido

Se eliminó el styling inline de superficie/borde/padding de `Kpi`, `SectionCard` y el cálculo de
estilo por variante/tamaño de `Btn`, reemplazados por clases `.my-*`. Sin tocar CSS global.

## Qué quedó fuera de alcance (diferido, con justificación)

- **`Badge` / `PlanBadge`** — color dinámico por estado (`statusMeta`/`SUPPORT_STATUS`); no mapea
  1:1 a `.my-badge--*`. Igual que en PR-B3A/PR-B3B.
- **`Th` / `Td`** (tablas), **`FilterBtn`** (pill de filtro — candidato a `.my-chip`), **`Toggle`**
  (switch) — UI especializada; diferida para no rediseñar.
- **Chart MRR** (`MRRChart`, L425): el audit lo marcó como "barra negra gigante". Causa: la
  paleta define `blue:'#000000'` en light (L19), así que las barras salen negras. **Fuera del
  alcance de PR-B3C** (cards/KPIs/botones); es un fix de chart aparte (reemplazar por
  `--info`/`--success`).
- **`#F5F5F7` restantes (14 líneas):** todas justificadas, **ninguna es el fondo de página/card**:
  - L19/L25/L26 → valores de paleta (accent `blueDim`/`blue`, texto `ink` en dark). No backgrounds de DOM.
  - L123/L125/L231/L2781/L2783/L2971/L3041 → **fondo de badge de estado** (Inactivo/Cancelado/
    soporte), que alimenta el `Badge` dinámico (diferido).
  - L1243/L1248/L1252 → **bordes** `1px solid #F5F5F7` (separadores sutiles en la card de detalle
    de restaurante). Cambiarlos a `var(--border)` los oscurecería; se dejan.
  - L3284 → fondo de fila emparejado con un tinte verde hardcodeado (`#34C75920`); se deja por consistencia.

## Validación

- `npm run build`: **PASS** (9/9; `superadmin.js` 305.61 kB). `npm run typecheck`: no existe (JS/JSX puro).
- `git diff --name-only`: **solo `src/superadmin/main.jsx`** (bundles gitignored).
- Líneas `+` del diff con literal de color nuevo (excluyendo `var()`): **0**.

## Qué NO se tocó

Otros paneles (Admin, Gerente, Caja, Cocina, Mozo, Delivery, Login, Diag) · Auth/backend/
Supabase/DB/RLS/RPC/migraciones/teardown · lógica/API/permisos/datos · rutas/navegación ·
handlers/ids/data-attrs · `ui-primitives.css`/`tokens.css` · dark mode global (Superadmin sigue
pineado `light`).

> Nota (no investigado, fuera de alcance): el QA de Admin reportó errores de consola 42501
> (permission denied) en orders/restaurants — es DB/RLS, no UI.

## Conteos finales (`src/superadmin/main.jsx`)

- `.my-card`: emitido por `SectionCard` (def). `.my-metric-card`: emitido por `Kpi` (12 usos).
  `.my-btn`: emitido por `Btn` (39 usos).
- `#F5F5F7`: 14 líneas restantes, todas justificadas (badge dinámico / dark-palette / borde /
  accent); el fondo de página/card (`C.bg`) quedó en `var(--bg-subtle)`.

## Próximos pasos sugeridos

- Re-QA visual/técnico de Superadmin: KPIs y SectionCards con superficie neutra tokenizada;
  botones unificados (danger/success sólidos).
- Follow-up (fuera de B3C): chart MRR (color `blue:#000000` → token), `Badge`/`FilterBtn`/tablas,
  tokenizar paleta JS completa. Recién entonces PR-B4 (dark global) por panel con checklist.
