# PR-B4A — Dark mode foundation + staff shell

> FASE B (UI/UX unificado + **dark mode global**). Primer PR de B4: **foundation**, no activación.
> Fecha: 2026-06-17 · Rama: `fix/pr-b4a-dark-foundation-staff-shell` · Base: `main = 4616ffc`.
> Frontend/visual, CSS-only. NO activa dark en ningún panel todavía (eso es B4B/B4C…).

## Objetivo

Dejar la **base** del dark mode sólida y confiable antes de activarlo panel por panel. NO es un
toggle gigante: este PR confirma el mecanismo, cierra el último gap de tokens dark y verifica que
los primitivos respondan en dark.

## 1) Mecanismo de tema (confirmado)

`public/mythos-theme.js` es el mecanismo real y **ya está completo**:

- **`data-theme` en `<html>`** gobierna el modo (+ `color-scheme`). Los tokens dark viven en
  `tokens.css` bajo `[data-theme="dark"]`.
- **`localStorage['mythos-theme']`** = `'light' | 'dark' | 'system'` (preferencia del usuario).
- **`MythosTheme.init('light'|'dark')`** = **PIN por panel** (compat; no persiste). Hoy **todos los
  shells staff pinean `'light'`** salvo **`cocina` que pinea `'dark'`** (KDS nativo).
- **`set()/toggle()`** = elección explícita del usuario (persiste, quita el pin, aplica). Es el
  **camino real de B4**, aún **sin wirear** (`mountButton()` devuelve `null` a propósito).

→ **No se modificó `mythos-theme.js`**: ya soporta todo lo que B4 necesita. Activar (cambiar
`init('light')` → `init()`/toggle por panel) es trabajo de **B4B/B4C**, no de este PR.

## 2) Cambio aplicado (foundation)

**Único cambio de producto: `public/tokens.css` — sombras dark armonizadas.** En B3I.1 se refinaron
las sombras **light** al modelo difuso de 2 capas (contacto + ambiente) y se **difirió** dark a B4.
Aquí se cierra ese gap:

| Token | Antes (1 capa) | Después (2 capas, misma geometría que light) |
|---|---|---|
| `--shadow-xs` | `0 1px 2px /.4` | `0 1px 2px /.4` |
| `--shadow-sm` | `0 1px 4px /.5, 0 0 1px /.3` | `0 1px 2px /.3, 0 2px 8px /.4` |
| `--shadow-md` | `0 4px 16px /.6, 0 0 1px /.3` | `0 2px 4px /.35, 0 8px 24px /.5` |
| `--shadow-lg` | `0 8px 32px /.7, 0 0 1px /.3` | `0 4px 10px /.4, 0 16px 48px /.6` |

Misma **geometría** (blur/spread) que light → la "forma" de la elevación es coherente entre temas;
en dark el peso lo da la **opacidad** (más alta), no un blur distinto.

## 3) Estado de tokens dark (auditado)

`[data-theme="dark"]` tiene **pares completos y coherentes**: bg `#0B0B0D` < bg-subtle `#111113` <
surface `#1C1C1E` < hover `#2C2C2E`; border `#38383A`/strong `#636366`; text primary `#F5F5F7` /
secondary `#AEAEB2` / tertiary `#8E8E93` / disabled `#48484A`; primary `#FFFFFF` (+on-primary
`#000000`); estados `#30D158/#FF9F0A/#FF453A/#0A84FF` con `on-*` de contraste; overlays. Radius /
espaciado / tipografía / `--leading-*` / `--control-*` son **theme-independent** (heredan de `:root`)
→ correcto. **No faltan pares dark.**

## 4) Primitivos en dark (auditado)

`public/ui-primitives.css` tiene **CERO literales hex** (verificado por grep) → **todos los
primitivos son dark-ready por construcción** (consumen solo tokens). Verificado para los del brief:

| Primitivo | Dark | Nota |
|---|---|---|
| `.my-card` / `.my-metric-card` | ✅ | surface/border/shadow por token; metric card **neutra (Opción A)** — sin tinte por estado (decisión de arquitectura) |
| `.my-btn` (+variantes) | ✅ | primary = `--primary` (blanco en dark) + `--on-primary` (negro); hover por `color-mix` sobre tokens |
| `.my-input` / `.my-select` / `.my-textarea` | ✅ | bg/border/placeholder por token; focus ring `--info` |
| `.my-table` | ✅ | header `--bg-subtle`, filas `--surface-hover`, bordes `--border` |
| `.my-modal` (+overlay/drawer/dropdown) | ✅ | overlay `--overlay`, surface/shadow-lg por token |
| `.my-alert` (+info/success/warning/danger) | ✅ | tinte por `color-mix(estado, var(--surface))` → en dark mezcla con surface oscuro = tinte correcto |
| `.my-section` | ✅ | tipografía + spacing por token |

## 5) Mapa de cobertura por panel (para planear B4B/B4C)

Todos los shells staff cargan `mythos-theme.js` y `tokens.css`. Cómo reacciona cada panel cuando se
active dark:

| Panel | Tema propio | Cobertura foundation | Pendiente para B4B/C |
|---|---|---|---|
| **Gerente** | `.my-*` puro | ✅ Alta | activar (`init()`/toggle) + QA contraste |
| **Admin** | `.my-*` + paleta JS dark (`PALETTES/C_DARK`, reactiva a `mythos:themechange`) | ✅ Alta | activar + QA; revisar literales inline residuales (cards inline, follow-up `42501` es funcional, no visual) |
| **Superadmin** | `.my-*` + `PALETTES[light/dark]` (reactiva) | ✅ Alta | activar + QA; chart MRR ya usa `C.ink` (reactivo) |
| **Caja** | `.my-*` (btn/metric) + `C_LIGHT/C_DARK` (reactiva) | ✅ Media-alta | activar + QA; **vista de salón / botones inline NO son `.my-btn`** → revisar en dark; no tocar cobro |
| **Cocina** | `.my-*` (stats) + `C` dark; **pinea `dark` hoy** | ✅ (ya dark) | nivelar con el resto al activar; **no tocar acciones KDS**; ya recoge sombras dark nuevas |
| **Mozo** | bridge CSS `:root`/`[data-theme=dark]` (B3F) | ✅ Media | activar + QA; `item-card` data-gated |
| **Delivery rider** | bridge inline `var()` (B3G); **sin paleta dark ni listener** | ⚠️ Parcial | revisar inline (brand/`#000`/`#fff` hardcodeados no adaptan); cards de entrega data-gated |
| **Delivery cliente** | bridge inline `var()` (B3G) + listener | ⚠️ Parcial | revisar inline hardcodeado |
| **Login** | token bridge (B3H); **NO carga `mythos-theme.js`** | ⚠️ | para dark necesita enlazar theme.js + toggle (B4B) |
| **Diag** | consola dev dark propia | n/a (no-op) | no es superficie de producto |
| **QR/menu (index)** | branding por `mood` (negro/blanco/sepia) | **EXCLUIDO** | **NO** se toca; NO sigue el dark del staff (PR-B3I.X) |

## 6) QR/menu cliente — EXCLUIDO (confirmado)

`src/index/main.jsx` y `public/index.html` **NO se tocaron**. El menú cliente usa branding por
restaurante (`makeTheme(mood)`), independiente del dark del staff (PR-B3I.X). B4 **no** lo fuerza.

## 7) Riesgos visuales

- **Mínimo.** El único cambio (sombras dark) solo se ve **donde ya hay dark hoy = Cocina** (sus
  `.my-card`/`.my-metric-card` de StatsPanel pasan al modelo de sombra de 2 capas, más premium y
  coherente con light). El resto de paneles siguen pineados `light` → **sin cambio visual**.
- Reversible (CSS puro). Sin riesgo de layout/lógica.

## 8) Qué NO se hizo (por diseño de la etapa)

- **NO** se activó dark en ningún panel (siguen `init('light')`; cocina `init('dark')`).
- **NO** se wireó el toggle (`mountButton` sigue `null`).
- **NO** se tocó `mythos-theme.js` (ya completo), ni paneles, ni paletas inline, ni QR/menu.
- **NO** se hizo sweep masivo de colores inline (eso se evalúa por panel en B4B/C).

## Build

- `npm run build`: **PASS — 9/9** (`built in` ×9, sin errores). `typecheck`: no existe (JS/JSX puro).

## Confirmación de no-alcance

`git diff --name-only main` ⇒ **solo `public/tokens.css`** (+ este doc al commitear). Sin cambios en
`public/build/*` (gitignored), `ui-primitives.css`, `mythos-theme.js`, paneles, `src/index/main.jsx`,
`public/index.html`, ni en Auth/backend/Supabase/DB/RLS/RPC/migraciones/teardown/datos/permisos/
lógica/API/flujos/handlers/condiciones/queries/payloads. **QR/menu intacto y excluido. Dark NO
activado en ningún panel.**
