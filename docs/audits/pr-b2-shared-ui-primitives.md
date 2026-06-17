# PR-B2 — Shared UI primitives / componentes base compartidos

> FASE B (UI/UX unificado + dark mode). Segundo PR de la secuencia PR-B1…PR-B5.
> Fecha: 2026-06-17 · Rama: `fix/pr-b2-shared-ui-primitives` · Base: `main = e872088` (PR-B1).
> Alcance: **solo primitivos compartidos.** No migra paneles, no rediseña, no activa dark global.

## Objetivo

Crear los componentes visuales base reutilizables del sistema MYTHOS, consumiendo
**exclusivamente** los tokens de `tokens.css` (PR-B1), para que PR-B3/PR-B4 los apliquen
panel por panel. Los primitivos son **aditivos y de riesgo cero**: namespace `my-*`, sin
tocar ningún selector existente, elemento ni global → ningún panel cambia de aspecto hasta
que su markup los adopte (eso es PR-B3).

## Archivos modificados

- **`public/ui-primitives.css`** (nuevo) — hoja de componentes base.
- **9 paneles** (1 línea c/u): se añadió `<link rel="stylesheet" href="ui-primitives.css">`
  **después** de `tokens.css`. Orden final de hojas:
  ```html
  <link rel="stylesheet" href="design-system.css">
  <link rel="stylesheet" href="tokens.css">
  <link rel="stylesheet" href="ui-primitives.css">
  ```
  Paneles: index, mozo, caja, cocina, gerente, admin, superadmin, delivery-cliente, delivery-rider.
- **`docs/audits/pr-b2-shared-ui-primitives.md`** (este doc).

## ¿Por qué archivo nuevo y no `design-system.css`?

Por defecto de arquitectura, y porque mantiene PR-B2 reversible y auditable: `ui-primitives.css`
contiene SOLO componentes nuevos namespaced (`my-*`), separados del CSS legacy de
`design-system.css` (que conserva sus clases `.btn`/`.card`/`.badge`/`.modal`/`.data-table`
intactas). Así el grep de "cero hardcodeos" aplica a un archivo limpio y la migración de
PR-B3 puede ir reemplazando clases legacy por `my-*` sin pelear con overrides.

## Componentes / clases creadas (todas en `ui-primitives.css`)

- **Botones:** `.my-btn` + `--primary` `--secondary` `--ghost` `--danger` `--success`
  `--icon` `--sm` `--md` `--lg`; estados `:disabled`/`[disabled]`/`.is-disabled`,
  `.is-loading` (spinner `@keyframes my-spin`), `:focus-visible` con `var(--info)`, hover/active.
- **Cards:** `.my-card` + `--interactive` `--selected` `--elevated`; partes `__header`
  `__title` `__subtitle` `__body` `__footer`. **Metric card (Opción A, superficie neutra):**
  `.my-metric-card` + `__label` `__value` `__delta` (`.is-up`/`.is-down` con `--success`/`--error`).
- **Formularios:** `.my-field` `.my-label` `.my-input` `.my-select` `.my-textarea`
  `.my-helper` `.my-error` `.my-form-row` `.my-form-grid`; placeholder `var(--text-tertiary)`,
  focus `var(--info)`, `.is-invalid` con `var(--error)`, disabled legible.
- **Badges:** `.my-badge` + `--neutral` `--success` `--warning` `--danger` `--info`
  `--pending` `--preparing` `--ready` `--delivered` (estados de pedido mapeados a tokens).
- **Tablas/listas:** `.my-table` + `__header` `__row` `__cell`; `.my-list` `.my-list-item`
  (`--interactive`); `.my-empty-state` (+ `__icon` `__title` `__hint`); `.my-loading-state`
  (+ `__spinner`).
- **Modales/drawers/dropdowns:** `.my-modal-overlay` (`var(--overlay)`), `.my-modal`
  (+ `__header` `__title` `__body` `__footer`), `.my-dropdown`, `.my-drawer`.
- **Chips/filtros:** `.my-chip` + `--active` `--disabled`; `.my-filter-group`.
- **Utilidades mínimas de layout:** `.my-stack` `.my-row` (`--between`) `.my-cluster`.

## Adaptadores de compatibilidad agregados

**Ninguno.** Decisión deliberada para cumplir "no cambiar visual masivamente / no overrides
agresivos": las clases legacy compartidas (`.btn`, `.card`, `.badge`, `.modal`, `.data-table`)
ya consumen tokens vía `design-system.css`, así que un adaptador que las redefina en
`ui-primitives.css` (cargada después) podría alterar su aspecto en producción sin necesidad.
Los adaptadores/migración de markup se harán **por panel en PR-B3**, donde el cambio es
observable y QA-eado. `ui-primitives.css` no redefine ninguna clase existente.

## Decisiones tomadas

1. **Namespace `my-*`** para aislamiento total (verificado: 0 colisiones con clases existentes
   en `src/` y `public/`).
2. **Metric card = Opción A** (superficie neutra), según decisión de arquitectura. No se usan
   tarjetas tintadas como patrón principal.
3. **Tintes de estado por `color-mix()` sobre tokens** (badges/chips/alertas y focus rings):
   `color-mix(in srgb, var(--token) N%, var(--surface)/transparent)`. Permite tinte suave
   adaptado a light/dark sin escribir un solo color literal. (Sin literales `#fff`/`#000`/etc.)
4. **Solo selectores `.my-*`** — sin selectores de elemento (`button`, `input`, `table`) ni
   globales (`*`), para no afectar markup existente.

## Qué NO se tocó

Auth · backend · DB/RLS/RPC · migraciones · pricing · CRM lógico · teardown · lógica de negocio ·
flujos · llamadas API · queries · permisos. No se reescribió HTML de paneles (solo +1 `<link>`).
No se migró ningún botón/card/tabla de ningún panel. No se activó dark global. `login.html` y
`diag.html` siguen fuera (no comparten el design system; Login se aborda en PR-B4). Datos de
Terrapizza/demo y `mancuellorenato@gmail.com` intactos.

## Checklist de QA

- [x] `ui-primitives.css` consume solo tokens (grep de literales de color = sin coincidencias).
- [x] 9 paneles importan `ui-primitives.css` después de `tokens.css`.
- [x] `npm run build` PASS (no procesa `public/*.css`, pero confirma que nada se rompió).
- [x] 0 colisiones de clases `my-*` con markup existente → cero cambio visual.
- [ ] (PR-B3) QA visual light + dark de cada componente al aplicarlo en un panel piloto.

## Próximos pasos (PR-B3)

Aplicar los primitivos a los **paneles operativos internos** empezando por los de prioridad
Alta del audit: **Mozo** (arreglar dark roto, cablear botón primario a `--primary/--on-primary`),
**Caja** (quitar serif, alerta con contraste, modal de cobro), **KDS/Cocina** (migrar inline a
tokens, mantener oscuro, calmar el rojo). Migración por panel, con QA visual light+dark, sin
liberar dark global hasta pasar el checklist. **No iniciar sin aprobación.**
