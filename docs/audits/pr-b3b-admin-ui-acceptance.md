# PR-B3B-FIX — Admin: cerrar el acceptance de UI primitives

> FASE B. Corrección de aceptación de PR-B3B tras QA visual en producción.
> Fecha: 2026-06-17 · Rama: `fix/pr-b3b-admin-ui-acceptance` · Base: `main = e7ebbe1`.
> Alcance autorizado por arquitectura: **Opción A neutra, fix acotado** (no migración total).

## Diagnóstico (por qué el QA vio 0 `.my-btn` / `.my-metric-card`)

**Causa = C (coverage gap). NO fue A (deploy desactualizado).**

- **Prod NO estaba stale:** el bundle de prod `mythos-pos.vercel.app/build/admin.js` **contiene**
  `my-metric-card` y `my-btn` (idéntico al build local). Prod corre `e7ebbe1`.
- PR-B3B migró las **definiciones** de los componentes compartidos `KpiCard`/`Btn`, que **sí**
  se usan (y por tanto renderizan `.my-metric-card`/`.my-btn`) en **Clientes, Caja-turno,
  Finanzas, Delivery, Proveedores**.
- **El QA midió el Dashboard**, que **no** usa esos componentes: sus 8 KPI cards eran **divs
  inline tinteados** (hex hardcodeado `#F0FAF3/#1A7E37/#0051A8/#3E3A9B/#8A4B00`, etc.) y no tiene
  botones de acción (sus interactivos son las cards clicables + la sidebar compartida). Por eso
  el DOM del Dashboard mostró 0.
- Conteo base: `<KpiCard>` 24 · `<Btn>` 104 · `<button>` crudos 116 (tabs/toggles/×, no son
  candidatos a `.my-btn`).

## Decisión de arquitectura aplicada

Fix acotado de aceptación (Opción A neutra), **no** migración total de los 116 botones.

## Cambios (solo `src/admin/main.jsx`)

1. **Dashboard — 8 KPI cards inline → `.my-metric-card`** (Opción A neutra). Se quitaron los
   tintes/hex hardcodeados (`#F0FAF3`, `#A3D9B1`, `#1A7E37`, `#F0F6FF`, `#A8C8FF`, `#0051A8`,
   `#F5F0FF`, `#C4B8FF`, `#3E3A9B`, `#FFF4E0`, `#FFD580`, `#8A4B00`, `#FF9500` del star). Se
   **conservan** icono, `<Delta>` (tendencia), `sub`, `onClick` y los textos. El valor pasa a
   `var(--text-primary)`; los estados de alerta (En cocina / Listos) se marcan con **borde y
   valor por token** (`var(--warning)` / `var(--success)`) en vez de tinte hardcodeado.
   *Cambio visual intencional:* los KPIs hero pierden sus fondos tinteados → superficie neutra
   unificada con el resto del panel; dark-ready por tokens.
2. **`#F5F5F7` (fondo de panel/card observado por QA) tokenizado en el origen:**
   `C_LIGHT.bg: '#F5F5F7'` → **`var(--bg-subtle)`**. Cubre las **45 usos de `C.bg`** en todo
   Admin (página/cards/wrappers) → token-driven y dark-ready; en light el valor es idéntico
   (`#F5F5F7`). Verificado que `C.bg` **no** se interpola en los HTML detached de impresión/
   exportación (`document.write`), así que `var()` siempre resuelve en el DOM temizado del panel.
   + 2 fondos `#F5F5F7` sueltos de DOM tokenizados: selector de plantilla (Marketing) y hover de
   búsqueda de lugares (zonas delivery).

## Botones de las 5 vistas auditadas

No requirieron cambio: **MenuPage / PersonalPage / FinanzasPage / StockPage ya usan el componente
`<Btn>`** para sus acciones primarias ("+ Nuevo producto" L1641, "+ Nuevo empleado" L2596,
"+ Nuevo ingrediente" L5084, etc.) → ya renderizan `.my-btn` desde PR-B3B (vivo en prod). Los
`<button>` crudos restantes en esas vistas son **tabs/segmented/toggles/×** (UI especializada,
NO deben ser `.my-btn`). El Dashboard no tiene botones de acción que migrar.

## Conteos (post-fix, `src/admin/main.jsx`)

- `.my-metric-card` (incl. `__label`): **21** occ (def de `KpiCard` + 8 cards del Dashboard).
- `.my-btn`: **7** occ (emitidas por el componente `Btn`, usado 104×).
- `#F5F5F7`: **5** (era 8) — **todas justificadas, ninguna es un fondo de DOM del panel**:
  - L94 `C_DARK.ink` → color de **texto** en dark (correcto).
  - L95 `C_DARK.purple` → **bug pre-existente** de la paleta dark (no introducido; dark no liberado).
  - L3344 / L3347 → dentro del **HTML detached de exportación CRM** (`document.write`); ahí
    `tokens.css` no está cargado, `var()` no resolvería → **debe quedar literal**.
  - L6529 → color de **texto** (RID en mono), no fondo.
- `<button>` crudos: **116** (sin cambio; son tabs/toggles/×, fuera de alcance del fix).

## Validación

- `npm run build`: **PASS** (9/9; `admin.js` 583.68 kB). `npm run typecheck`: no existe (JS/JSX puro).
- `git diff --name-only`: **solo `src/admin/main.jsx`** (bundles gitignored).
- Líneas `+` del diff con literal de color nuevo (excluyendo `var()`): **0**.

## Qué NO se tocó

Otros paneles · Auth/backend/DB/RLS/RPC/migraciones/teardown · lógica/API/permisos/datos ·
handlers/ids/data-attrs · `ui-primitives.css` (no requirió cambios) · dark mode global (Admin
sigue pineado `light`). No se migraron los 116 botones crudos ni se rediseñó Admin.

## Criterios de aceptación — estado

- [x] Dashboard Admin renderiza KPI cards con `.my-metric-card` (build local + bundle).
- [x] Botones principales del Admin auditado renderizan con `.my-btn` (vía `<Btn>`, ya en prod).
- [x] `#F5F5F7` reducido (8→5) y justificado; el fondo de panel/card del QA tokenizado a `var(--bg-subtle)`.
- [x] Panel sigue visualmente usable; `npm run build` PASS.

## Próximos pasos sugeridos (no en este fix)

- Re-QA del **Dashboard** en preview/prod: KPIs neutros con `.my-metric-card`, alertas por borde token.
- Follow-up opcional: tokenizar la PALETTES JS completa (surface/sidebar/card) y migrar cards
  inline de otras vistas; recién entonces PR-B4 (dark global) por panel con checklist.
