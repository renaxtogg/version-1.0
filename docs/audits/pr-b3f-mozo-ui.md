# PR-B3F — Alineación de Mozo por token bridge

> FASE B (UI/UX unificado + dark mode). PR **dedicado** para Mozo.
> Fecha: 2026-06-17 · Rama: `fix/pr-b3f-mozo-ui` · Base: `main = c3ad7dd`.
> Decisión de arquitectura: **alinear por capa de tokens, NO por swap a `.my-*`.**

## Objetivo

Alinear Mozo con el sistema de diseño global **desde la capa de tokens**, preservando sus clases
locales, su layout y su comportamiento. Sin migrar JSX a `.my-card`/`.my-metric-card`/`.my-btn`,
sin tocar lógica, sin activar dark global.

## Hallazgo de la auditoría (por qué token bridge y no swap a `.my-*`)

A diferencia de Caja/Admin/Superadmin (inline + paleta JS) o Cocina (KDS con `#111` hardcodeado),
**Mozo ya implementa un sistema de diseño propio, completo y dark-ready** en el `<style>` de
`public/mozo.html`: un `:root` (light) + `[data-theme="dark"]` (dark) con variables
(`--bg/--bg2/--bg3/--surface/--border/--text/--text2/--text3/--accent/--radius/--shadow/...`), y
**todas** sus clases-componente ya consumen esas variables:

- Botones: `.btn` + `.btn-primary/-secondary/-indigo/-full/-sm` (con `flex:1`, `var(--text)`,
  `var(--indigo)`).
- KPIs de turno: `.turno-stat` (fila horizontal label+valor, con `var(--green-soft)` etc.).
- Cards: `.item-card`, `.alert-card`, `.featured-card`, `.order-action-btn` (especializados).

Es decir, Mozo **ya está alineado en arquitectura** (variable-based + dark-ready), pero con nombres
de variable **locales** en paralelo a los tokens globales. Forzar un swap a `.my-*` tendría mal
perfil: **riesgo de layout** (los `.btn` dependen de `flex:1`; `.turno-stat` es una fila, no la
columna de `.my-metric-card`), **beneficio de dark-readiness ~nulo** (ya lo tiene), y si fuera
**parcial** dejaría el panel **inconsistente consigo mismo** (mezcla `.btn` + `.my-btn`).

**Decisión (arquitectura):** alinear puenteando las variables locales de Mozo a los **tokens
globales** (`tokens.css`), sin tocar clases ni JSX. Mozo pasa a consumir la fuente de verdad
compartida y queda listo para dark global (PR-B4) con **delta visual mínimo**.

## Superficies revisadas

- `public/mozo.html` `<style>` → bloques `:root` y `[data-theme="dark"]` (variables del panel).
- `src/mozo/main.jsx` → JSX/clases (revisado, **no tocado**).
- Clases-componente locales (`.btn*`, `.turno-stat`, `.item-card`, `.alert-card`, `.featured-card`,
  `.order-action-btn`, `.mesa-card*`) → revisadas, **no tocadas**.

## Archivos tocados

- **`public/mozo.html`** — solo los bloques `:root` / `[data-theme="dark"]` del `<style>`.
- **`docs/audits/pr-b3f-mozo-ui.md`** — este doc.

`git diff --name-only` ⇒ solo `public/mozo.html`. **`src/mozo/main.jsx` NO modificado.**

## Cambios visuales realizados (token bridge)

Se puentearon los **neutrales** de Mozo a los tokens globales; las familias semánticas y de marca
secundaria quedan locales:

| Variable Mozo | Bridge | Light | Dark |
|---|---|---|---|
| `--bg` | (omitida → la aporta `tokens.css`) | `#FFFFFF` = igual | `#000000` → **`#0B0B0D`** (base de token) |
| `--surface` | (omitida → `tokens.css`) | `#FFFFFF` = igual | `#1C1C1E` = igual |
| `--border` | (omitida → `tokens.css`) | `#D2D2D7` = igual | `#38383A` = igual |
| `--bg2` | `var(--bg-subtle)` | `#F5F5F7` = igual | `#1C1C1E` → `#111113` |
| `--bg3` | `var(--bg-hover)` | `#E8E8ED` = igual | `#2C2C2E` = igual |
| `--text` | `var(--text-primary)` | `#1D1D1F` = igual | `#F5F5F7` = igual |
| `--text2` | `var(--text-secondary)` | `#6E6E73` = igual | `#AEAEB2` = igual |
| `--text3` | `var(--text-tertiary)` | `#86868B` = igual | `#8E8E93` = igual |
| `--accent` | `var(--primary)` | `#000000` → **`#1D1D1F`** | `#FFFFFF` = igual |

- **Nota técnica (ciclo `var()`):** `--bg`, `--surface`, `--border` **comparten nombre** con el
  token global → un `--bg: var(--bg)` sería una referencia cíclica inválida. Por eso esos tres se
  **omiten** del `<style>` de Mozo y los aporta `tokens.css` directamente (orden de cascada:
  `tokens.css` se carga antes que el `<style>`; al no redefinirlos Mozo, ganan los del token).
- **En dark**, los neutrales bridgeados se **quitaron** del bloque `[data-theme="dark"]` de Mozo
  para que el alias de `:root` (theme-reactivo vía los tokens) tome el control.

### Delta visual

- **Light (tema activo, Mozo está pineado `light`):** único cambio = `--accent` `#000000`→`#1D1D1F`
  (el "casi-negro de marca" sancionado en PR-B1). Todo lo demás es **byte-idéntico**.
- **Dark (no activo):** `--bg` `#000`→`#0B0B0D` y `--bg2` `#1C1C1E`→`#111113` (alineación con la base
  de tokens "sin negro puro"). Solo se verá cuando PR-B4 active dark global.

## Qué quedó fuera de alcance (no bridgeado, con justificación)

- **`--accent-soft`, `--indigo`, `--indigo-soft`:** marca secundaria; sin token 1:1 claro → locales.
- **`--green/-soft`, `--orange/-soft`, `--red/-soft`, `--blue/-soft`:** colores de **estado**
  (semánticos); aunque coinciden con `--success/--warning/--error/--info`, se dejan locales para no
  ampliar alcance (no estaban en la lista autorizada).
- **`--radius` (12px), `--radius-sm` (8px), `--shadow`, `--shadow-lg`:** **sin match exacto** con
  los tokens (token `--radius-md:10px`/`--radius-lg:14px`, `--radius-sm:6px`; sombras parecidas pero
  no idénticas) → bridgearlos cambiaría el look → se dejan locales (preservar delta mínimo).
- **JSX / clases locales (`src/mozo/main.jsx`):** NO migradas a `.my-*` por decisión de
  arquitectura (riesgo de layout + inconsistencia intra-panel).
- **Colores semánticos hardcodeados en clases:** `.mesa-card.ocupada` (`#000` = mesa ocupada),
  `.mesa-card.cuenta` (`#FFFFFF`/`#000` = mesa pidiendo cuenta), `.turno-stat.highlight` (`#000`/
  `#fff`) → señal de estado de mesa/turno; fuera del bridge de neutrales.

## Riesgos evitados

- **Sin swap de clases:** no se tocó ni un `className` → cero riesgo de romper layout operativo
  (`flex:1` de botones, fila de `.turno-stat`, cards especializadas).
- **Sin inconsistencia intra-panel:** Mozo sigue 100% con sus clases locales (no mezcla `.my-*`).
- **Ciclo `var()` evitado:** los neutrales homónimos se omiten en vez de auto-referenciarse.
- **Lógica intacta:** no se tocó JSX, pedidos, mesas, productos, cantidades, notas, envío a
  cocina/caja, polling ni realtime.

## Validación

- `npm run build`: **PASS** (9/9; `mozo.js` 241.42 kB — el JSX no cambió). `npm run typecheck`:
  no existe (JS/JSX puro). `mozo.html` no lo procesa Vite (es estático), pero el build confirma que
  nada más se rompió.
- `git diff --name-only`: **solo `public/mozo.html`** (`src/mozo/main.jsx` intacto).
- Cascada de `mozo.html` intacta: `design-system.css` → `tokens.css` → `ui-primitives.css` →
  `mythos-theme.js` → `<style>` → `MythosTheme.init('light')`.

## Confirmación de no-alcance

No se tocó: **Gerente, Admin, Superadmin, Caja, Cocina, Delivery, Login, Diag** ·
`src/mozo/main.jsx` (JSX) · `ui-primitives.css` / `tokens.css` ·
**Auth/backend/Supabase/DB/RLS/RPC/migraciones/teardown** · **lógica/API/permisos/datos** ·
**pedidos/mesas/productos/cantidades/notas/envío a cocina/caja** · **polling/realtime** ·
rutas/navegación · **dark mode global** (Mozo sigue pineado `light`). **PR-B4 no iniciado.**

## Follow-ups conocidos (fuera de este PR, NO investigados)

- Caja: botones inline de "Vista del salón".
- Cocina: 2 charts de StatsPanel data-gated por 0 completados.
- Superadmin: chart MRR con barra negra (`blue:'#000000'`).
- Admin: errores 42501 (permission denied) — DB/RLS.
- Futuro: (opcional) bridgear también familias `-soft`/estados/radios/sombras y, si se quiere,
  converger las clases locales de Mozo a `.my-*`; recién entonces PR-B4 (dark global por panel).

## Conteos finales

- `public/mozo.html`: neutrales bridgeados a tokens (tabla arriba). `src/mozo/main.jsx`: sin cambios.
- `.my-card` / `.my-metric-card` / `.my-btn` en Mozo (JSX o HTML): **0** — por decisión de
  arquitectura (alineación por token bridge, no por consumo directo de primitivas).
- Hex hardcodeados restantes en `mozo.html`: solo **semánticos de estado** (mesa ocupada/cuenta,
  highlight de turno) — justificados.
