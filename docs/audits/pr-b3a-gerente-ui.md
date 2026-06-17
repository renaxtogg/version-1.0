# PR-B3A — Pilot: UI primitives en Gerente

> FASE B (UI/UX unificado + dark mode). Piloto de PR-B3 (re-scopeado por arquitectura).
> Fecha: 2026-06-17 · Rama: `fix/pr-b3a-gerente-ui` · Base: `main = 54a0a94` (PR-B2).
> Alcance: **solo el panel Gerente.** Frontend/visual. No toca otros paneles ni lógica.

## Por qué PR-B3A (re-scope)

PR-B3 original asumía (modelo pre-Vite) que el markup de Gerente/Admin/Superadmin vivía en
los `public/*.html`. Tras PR-5 esos HTML son **shells** (cargan `build/<panel>.js`); el markup
real está en `src/<panel>/main.jsx` (Gerente: 2263 líneas, ~355 `style={{}}` inline). Reportado
al arquitecto, que aprobó **piloto solo en Gerente** (`src/gerente/main.jsx`) para revisar diff
y QA antes de migrar Admin/Superadmin en PR-B3B/PR-B3C.

## Estrategia

Gerente compone toda su UI a partir de **componentes compartidos** definidos una sola vez
(`Card`, `KpiCard`, `Btn`, `Badge`, `Th`/`Td`, `Inp`/`Sel`/`Txt`, `Modal`…). Migrar la
**definición** de esos componentes a primitives `.my-*` propaga el cambio a todos sus usos con
un diff mínimo y sin tocar ningún call site, handler, prop, id ni data-attribute.

## Archivos modificados

- **`src/gerente/main.jsx`** — 3 definiciones de componente migradas a `.my-*` (className-only).
- **`public/build/gerente.js`** — bundle reconstruido (`npm run build`). **Gitignored**, no versionado.
- **`docs/audits/pr-b3a-gerente-ui.md`** — este doc.

`git diff --name-only` ⇒ solo `src/gerente/main.jsx` (+ este doc al añadirlo). Ningún otro panel.

## Cambios exactos en `src/gerente/main.jsx`

Se cambió **solo `className`/`style`** en 3 componentes; props, handlers, `onClick`, `disabled`,
estructura y textos quedan idénticos:

1. **`Card`** → contenedor `className="my-card"`; se quitó el inline `background:C.surface /
   border / borderRadius:10 / padding:18` (ahora desde tokens). Se conserva el merge de `style`
   (sx), así la card "Llamadas de mozo" (override `background:#FFF8F0`) mantiene su tinte.
   Propaga a **21** usos de `<Card>`.
2. **`KpiCard`** → contenedor `className="my-metric-card"` (Opción A, superficie neutra) +
   label `className="my-metric-card__label"`. Se conserva el **valor** (mono + color de acento)
   y el `sub` inline para no alterar la identidad de los KPIs. `alert` ahora pinta el borde con
   `var(--error)`. Propaga a **19** usos de `<KpiCard>`.
3. **`Btn`** → `className="my-btn my-btn--<variant>"` (+ `my-btn--sm` si `small`, `width:100%` si
   `full`); se quitó el cálculo de color por `C.*`. Propaga a **28** usos de `<Btn>`
   (variantes en uso: primary, ghost, danger, success).

## ¿Se tocó `ui-primitives.css`?

**No.** Los primitives de PR-B2 cubrieron todo lo necesario; no hizo falta agregar helpers.
Diff de CSS = 0.

## CSS local eliminado/reducido

Se eliminó el styling de color/borde/superficie inline de `Card`/`KpiCard` y el cálculo de
color por variante de `Btn` (≈3 bloques de estilo inline), reemplazados por clases `.my-*`.
No se borró CSS global ni se tocó `design-system.css`.

## Deltas visuales esperados (para QA)

Cambios **intencionales** de unificación (light; dark sigue sin liberarse):
- **Cards:** radio 10→14, padding 18→20, + `--shadow-sm` sutil. Borde/superficie iguales en light.
- **Metric cards:** misma superficie neutra; label casi idéntico (11px/600 vs 10px/700). Valor sin
  cambios. Padding levemente mayor (20×24).
- **Botones:** primary y ghost ≈ iguales. **danger/success pasan de tinte suave a sólido**
  (estándar del design system: fondo de estado + `--on-*`). secondary/otros: fondo
  `#F5F5F7`→`var(--surface)` + hover. Altura fija 40px (sm 32px).

## Qué NO se tocó

- **Otros paneles:** Admin, Superadmin, Caja, Cocina, Mozo, Delivery (cliente/rider), Login, Diag — intactos.
- **Lógica/negocio:** fetch, queries, RPC, handlers, permisos, navegación, rutas, ids, data-attrs,
  render de datos, textos funcionales — sin cambios.
- **Auth / backend / DB / RLS / RPC / migraciones / pricing / CRM / teardown** — nada.
- **Dark mode global** — NO liberado; Gerente sigue pineado a `MythosTheme.init('light')`. Los
  primitives son dark-ready por tokens, pero el panel permanece en light.
- **`Badge`/`StatusBadge`** (color dinámico por estado), **tablas** (`Th`/`Td`), **formularios**
  (`Inp`/`Sel`/`Txt`), **`Modal`** y los **botones inline crudos** del banner de alertas —
  diferidos a propósito (ver abajo).

## Riesgos visuales pendientes

- 20 literales de color **pre-existentes** en `src/gerente/main.jsx` (PALETTES JS, toasts, overlay
  de Modal `rgba(0,0,0,.7)`, banner de alertas `#FFF1F0/#FFB3AD`, card tintada `#FFF8F0`). **No se
  agregó ninguno** (verificado: 0 literales en líneas `+` del diff). Su tokenización es trabajo futuro.
- `Badge` usa color dinámico (no mapea 1:1 a `.my-badge--*`); forzar variantes fijas podría
  cambiar semántica/uppercasing → se difiere.
- danger/success sólidos: confirmar en QA que "Aprobar/Rechazar" se ven correctos (se espera mejora
  de affordance).

## Recomendación de QA visual

Abrir Gerente en preview (light): Dashboard (KPIs + cards), y vistas con `<Btn>` de
aprobar/rechazar. Verificar: cards uniformes con sombra sutil; KPIs legibles con su valor mono;
botones primary/ghost iguales, danger/success sólidos legibles; banner de alertas sin cambios;
card "Llamadas de mozo" conserva su tinte. Confirmar que ninguna acción cambió de comportamiento.

## Próximos pasos (PR-B3B / PR-B3C)

- **PR-B3B:** aplicar el mismo patrón a `src/admin/main.jsx` (revisar si comparte componentes
  `Card/KpiCard/Btn` análogos; admin es el más grande, ~1767 inline → migrar por componentes).
- **PR-B3C:** `src/superadmin/main.jsx` (incluye el chart MRR roto — tratar aparte).
- Follow-up Gerente: badges/tablas/forms/Modal + tokenizar la PALETTES JS (acercarse a un solo
  origen de color). Dark global recién en PR-B4 tras checklist por panel.
