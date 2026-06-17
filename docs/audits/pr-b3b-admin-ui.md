# PR-B3B — UI primitives en Admin

> FASE B (UI/UX unificado + dark mode). Continuación de PR-B3A (pilot Gerente).
> Fecha: 2026-06-17 · Rama: `fix/pr-b3b-admin-ui` · Base: `main = 816a235` (PR-B3A).
> Alcance: **solo el panel Admin.** Frontend/visual. Mismo patrón seguro que PR-B3A.

## Objetivo

Aplicar los primitives `.my-*` (PR-B2) al panel Admin migrando las **definiciones de sus
componentes compartidos**, de modo que el cambio se propague a todos los usos con un diff
mínimo y sin tocar call sites, handlers, props, ids, data-attributes ni lógica.

## Archivos modificados

- **`src/admin/main.jsx`** — 2 definiciones de componente migradas a `.my-*` (className-only).
- **`public/build/admin.js`** — bundle reconstruido (`npm run build`). **Gitignored**, no versionado.
- **`docs/audits/pr-b3b-admin-ui.md`** — este doc.

`git diff --name-only` ⇒ solo `src/admin/main.jsx` (+ este doc al añadirlo). Ningún otro panel.

## Componentes migrados en Admin

Admin compone su UI con componentes compartidos definidos una sola vez (igual que Gerente).
Se migraron los dos de mayor leverage:

1. **`KpiCard`** → contenedor `className="my-metric-card"` (Opción A, superficie neutra) + label
   `className="my-metric-card__label"`. Se conservan: el **valor** (mono + color de acento), el
   `sub`, el `onClick` y los **handlers de hover** (`onMouseEnter/Leave` que resaltan el borde de
   las KPIs clicables). El default de color del valor pasó de `'#000000'` (hardcodeado) a
   **`var(--text-primary)`** (token). Propaga a **24** usos de `<KpiCard>`.
2. **`Btn`** → `className="my-btn my-btn--<variant>"` (+ `my-btn--sm` si `small`); se quitó el
   cálculo de color por `C.*`. **El branching se preserva 1:1**: `primary`/`danger`/`ghost`
   explícitos; todo lo demás (`secondary`, `inline`, `success`, otros) cae en `secondary`,
   exactamente como antes (la función original solo ramificaba en primary/danger/ghost). Propaga
   a **104** usos de `<Btn>`. Variantes en uso: primary, danger, ghost, secondary, inline, success.

## ¿Se tocó `ui-primitives.css`?

**No.** Los primitives de PR-B2 alcanzaron. Diff de CSS = 0.

## CSS inline reducido

Se eliminó el styling inline de superficie/borde/padding/transition de `KpiCard` y todo el
cálculo de color/padding/opacity por variante de `Btn`, reemplazados por clases `.my-*`. No se
borró CSS global ni se tocó `design-system.css`/`ui-primitives.css`.

## Qué NO se tocó

- **No hay componente `Card` compartido en Admin** (a diferencia de Gerente): las "cards" son
  divs inline dispersos. Migrarlas exigiría tocar muchos call sites → **diferido** (igual que el
  criterio conservador de PR-B3A). No se migraron cards inline.
- **`Badge`** (color dinámico por estado de pedido vía `SC[status]`), **tablas** (`Th`/`Td`/
  `EmptyRow`), **formularios** (`Inp`/`MoneyInp`/`Sel`/`Lbl`), **`Modal`** y botones inline crudos
  — **diferidos** a propósito (consistencia con PR-B3A; evitar riesgo en un panel de 9662 líneas).
- **Lógica/negocio:** handlers, fetch, queries, RPC, permisos, roles, usuarios, staff,
  capabilities, tenant, navegación, rutas, ids, data-attrs, validaciones, sesión/login/logout,
  textos funcionales — **sin cambios**.
- **Auth / backend / Supabase / DB / RLS / RPC / migraciones / pricing / CRM / teardown** — nada.
- **Dark mode global** — NO liberado; Admin sigue pineado a `MythosTheme.init('light')`. Los
  primitives son dark-ready por tokens, pero el panel permanece en light.

## Deltas visuales esperados (para QA)

Cambios **intencionales** de unificación (light; dark sigue sin liberarse):
- **Metric cards (24):** misma superficie neutra; radio 8→14, padding ≈ igual (18×20 vs 20×24),
  + `--shadow-sm` sutil; label casi idéntico; valor sin cambios (mono + acento). Hover de KPIs
  clicables preservado.
- **Botones (104):** primary ≈ igual; ghost ≈ igual; **danger pasa de tinte suave a sólido**
  (estándar del design system); secondary/inline/success: fondo `#F5F5F7`→`var(--surface)` y
  texto gris→`--text-primary`, altura fija 40px (sm 32px). `success`/`inline` siguen
  renderizándose como secondary (igual que hoy).

## Riesgos visuales pendientes

- 114 literales de color **pre-existentes** en `src/admin/main.jsx` (PALETTES JS, toasts, overlay
  de Modal, banners, cards inline tintadas que el audit señaló, etc.). **No se agregó ninguno**
  (verificado: 0 literales en líneas `+` del diff; de hecho se quitó un `#000000`). Su
  tokenización es trabajo futuro.
- Las "metric cards tintadas" que mencionó el audit son **cards inline** (no `KpiCard`); quedan
  para un follow-up que toque call sites con QA.
- danger sólido: confirmar en QA que las acciones destructivas (p.ej. eliminar) se ven correctas.

## Recomendación de QA visual

Abrir Admin en preview (light): Dashboard (KPIs + charts), Menú, Personal, Stock, Finanzas.
Verificar: KPIs uniformes con su valor mono; botones primary/ghost iguales, danger sólido legible,
secondary con texto más oscuro; densidad operativa intacta; ninguna acción cambió de
comportamiento (crear/editar/eliminar, navegación de tabs, modales). Confirmar que NO hay dark
global accidental.

## Próximos pasos (PR-B3C)

- **PR-B3C:** aplicar el mismo patrón a `src/superadmin/main.jsx` (revisar sus componentes
  compartidos; incluye el **chart MRR roto** que el audit marcó → tratar aparte, posiblemente
  fuera de B3C).
- Follow-up Admin: cards inline tintadas → `.my-card`/metric Opción A (con QA de call sites),
  badges/tablas/forms/Modal, y tokenizar la PALETTES JS. Dark global recién en PR-B4 por panel
  tras checklist.
