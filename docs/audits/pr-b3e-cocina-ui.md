# PR-B3E — UI primitives / alineación visual en Cocina (KDS)

> FASE B (UI/UX unificado + dark mode). PR **dedicado** (Cocina no tenía componentes
> compartidos seguros para un swap className-only — detectado en la auditoría de PR-B3D).
> Fecha: 2026-06-17 · Rama: `fix/pr-b3e-cocina-ui` · Base: `main = 4baf3d2`.
> Alcance: **solo el panel Cocina.** Frontend/visual. Sin romper KDS, sin lógica, sin dark global.

## Objetivo

Alinear visualmente Cocina con el sistema UI compartido (`.my-card`, `.my-metric-card`) **donde
es seguro**, sin tocar el corazón del KDS (tickets/columnas/toolbar/acciones de estado), sin
cambiar lógica/estados/polling/realtime y **sin** activar dark mode global. Cocina ya es
**dark-reactiva** (pineada `dark` en `cocina.html` vía `MythosTheme.init('dark')`, con paleta `C`
reactiva a `mythos:themechange`) — ese comportamiento se **conserva**.

## Superficies revisadas

- **KDS kanban** (columnas + `TicketCard`): cards con **borde de color = nivel de urgencia**
  (`URGENCY_BORDER`), animación `flash`, clase `card-critical`, opacidad por estado. → **No
  migrado** (el borde y el "blanco = listo" portan información operativa; migrar = rediseño y
  pérdida de señal). Riesgo alto evitado.
- **Toolbar header** (`Btn`, 7 usos): STATS / Felicitaciones / sonido / pantalla dividida /
  fullscreen / **toggle de tema** / config. Son **toggles/iconos con estado `active`** → se
  **mantienen** (el alcance prohíbe convertir toggles).
- **Botones de acción del ticket** (`ENTREGADO`, `PREPARANDO/LISTO`): estilados por urgencia y
  por convención KDS "primary = blanco/negro" → **no migrados** (riesgo de invertir/!perder señal).
- **Modal Config** (drawer): botón **"Guardar"** usa `background:C.white / color:#000` = misma
  convención KDS blanco/negro → **no migrado** (`.my-btn--primary` lo invertiría respecto al KDS).
- **Panel de Estadísticas (`StatsPanel`, overlay del toggle STATS):** superficies **genéricas**
  (tiles de métrica + paneles de gráfico) con fondo **hardcodeado `#111`** (no theme-reactive →
  caja negra en tema claro). → **Migrado** ✅ (ver abajo). Aquí estaba el cambio seguro real.

## Archivos tocados

- **`src/cocina/main.jsx`** — 4 ediciones en `StatsPanel` (1 helper + 3 contenedores).
- **`public/build/cocina.js`** — bundle reconstruido (`npm run build`). **Gitignored**, no versionado.
- **`docs/audits/pr-b3e-cocina-ui.md`** — este doc.

`git diff --name-only` ⇒ solo `src/cocina/main.jsx`. Ningún otro panel.

## Cambios visuales realizados (solo `StatsPanel`)

1. **`statBox` → `.my-metric-card`** + `.my-metric-card__label`. Las 3 tiles de KPI del día
   (Tiempo promedio / Completados hoy / En proceso) adoptan superficie/borde/radio/sombra por
   **tokens**. Se **conserva** el valor en mono (21px) y el **`color` semántico** (verde/naranja/
   rojo por umbral de tiempo, p. ej. promedio alto = rojo); el fallback `C.white` pasa a
   `var(--text-primary)`. `sub` y `flexShrink:0` conservados. → Cocina consume **`.my-metric-card`**.
2. **3 paneles de gráfico → `.my-card`** (reemplazan el fondo hardcodeado `#111`):
   - "Distribución tiempos" (barras rápido/normal/lento).
   - "Pedidos por hora" (histograma horario).
   - "Métricas por producto" (colapsable; `padding:0` + `overflow:hidden` preservados para que el
     header full-width siga edge-to-edge).
   Toman superficie/borde/radio/sombra por tokens; se preservan inline solo los props de **layout**
   (`padding`/`flex`/`minWidth`/`overflow`). → Cocina consume **`.my-card`**.
3. **Tokenización de color hardcodeado:** se eliminaron las **4** ocurrencias funcionales de
   `background:'#111'` (las 3 anteriores + la del `statBox`). `#111` era un near-black fijo, **no**
   theme-reactive (caja negra incluso en tema claro) → ahora superficie por tokens, **dark-ready**
   y consistente. (El único `#111` que queda en el archivo es texto dentro de un comentario.)

## ¿Se tocó `ui-primitives.css` / `tokens.css`?

**No.** Las primitivas existentes alcanzaron. Diff de CSS global = 0.

## Qué quedó fuera de alcance (diferido, con justificación)

- **`TicketCard`** y **`Column`**: borde por urgencia + flash + `card-critical` → señal operativa;
  no migrar (rediseño/riesgo).
- **Toolbar `Btn` (7)**: toggles/iconos con `active` → se mantienen (regla de alcance).
- **Acciones de ticket** (`ENTREGADO` / `PREPARANDO` / `LISTO`) y **"Guardar"** de Config:
  convención KDS blanco/negro + colores de urgencia → no migrar (invertirían/perderían señal).
- **Badges de estado/tipo/alergia, columnas de color (`COL_COLOR`), barras de urgencia, alertas
  (cuello de botella)**: portan estado/semántica → se mantienen.
- **`#F5F5F7` restantes (4):** valores de **paleta** de Cocina (dark `white`/`ink`, light `surface`)
  y un fallback de color de barra — theme-aware, no son fondos hardcodeados → se dejan.

## Riesgos evitados

- No se tocó la **lógica de estados** de pedidos (`onAdvance`/`onDismiss`/`status`), ni
  **polling/realtime**, ni la asignación de riders, ni la impresión/estaciones.
- No se alteró el **borde de urgencia** ni la convención **blanco = listo** del KDS (señales que
  el personal usa de un vistazo).
- No se forzó ningún **toggle** a `.my-btn` (evita romper el estado `active`).
- No se activó **dark mode global**: Cocina sigue pineada `dark` con su paleta reactiva; las
  primitivas `.my-*` consumen tokens que ya siguen `data-theme` en lockstep con esa paleta.

## Validación

- `npm run build`: **PASS** (9/9; `cocina.js` 200.85 kB). `npm run typecheck`: no existe (JS/JSX puro).
- `git diff --name-only`: **solo `src/cocina/main.jsx`** (bundles gitignored).
- Bundle `public/build/cocina.js`: contiene `my-card` (3) y `my-metric-card` (2) → renderiza las
  primitivas en prod tras deploy.
- Líneas `+` del diff con literal de color nuevo (excluyendo `var()`): **0** (se **quitaron** 4 `#111`).

## Confirmación de no-alcance

No se tocó: **Gerente, Admin, Superadmin, Caja, Mozo, Delivery, Login, Diag** ·
**Auth/backend/Supabase/DB/RLS/RPC/migraciones/teardown** · **lógica/API/permisos/datos** ·
**estados de pedidos/polling/realtime** · rutas/navegación · `ui-primitives.css`/`tokens.css` ·
**dark mode global** (Cocina sigue pineada `dark`). **PR-B4 no iniciado.**

## Follow-ups conocidos (fuera de este PR, NO investigados)

- Caja: algunos botones de "Vista del salón" siguen inline.
- Superadmin: chart MRR con barra negra (`blue:'#000000'`).
- Admin: errores 42501 (permission denied) — DB/RLS.
- Futuro: evaluar si el KDS (tickets/acciones/toolbar) adopta tokens en un rediseño con criterio
  dark propio; recién entonces PR-B4 (dark global por panel con checklist).

## Conteos finales (`src/cocina/main.jsx`)

- `.my-metric-card`: **sí** — def `statBox` (3 tiles del día). `.my-card`: **sí** — 3 paneles de
  gráfico de `StatsPanel`. `.my-btn`: **no aplica** (todos los botones son toggles de toolbar o
  acciones KDS/blanco-negro especializadas).
- `#111` funcionales: **0** (eran 4). `#F5F5F7`: 4 (paleta, justificados).
