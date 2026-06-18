# PR-B3G — Alineación de Delivery (rider + cliente) por token bridge

> FASE B (UI/UX unificado + dark mode). PR **dedicado** para los paneles Delivery.
> Fecha: 2026-06-17 · Rama: `fix/pr-b3g-delivery-ui` · Base: `main = 2afe60e`.
> Cierra la cobertura de PR-B3 (último par de paneles). Frontend/visual, sin romper delivery.

## Objetivo

Alinear visualmente Delivery rider y Delivery cliente con el sistema de diseño global, sin romper
delivery operativo, estados, asignación de rider, tracking ni lógica, y sin activar dark global.

## Archivos reales inspeccionados

- `src/delivery-rider/main.jsx` (711 líneas) — **modificado**.
- `src/delivery-cliente/main.jsx` (2032 líneas) — **modificado**.
- `public/delivery-rider.html` (51) y `public/delivery-cliente.html` (41) — **revisados, NO tocados**.

(El prompt nombraba esos archivos; existen con esos nombres exactos.)

## Auditoría → enfoque elegido por panel

Ambos shells HTML cargan la cascada estándar (`design-system.css` → `tokens.css` →
`ui-primitives.css` → `mythos-theme.js`), están pineados `light` y su `<style>` es **solo el marco
del simulador de teléfono** (`.phone`/`.screen`; `body{background:#111}` = backdrop de escritorio,
`screen #fff`) — **no** hay sistema de tokens local tipo Mozo ni `:root` propio.

Ambos paneles JSX son **inline, sin componentes centralizados** (pantallas: `HomeScreen`,
`RouteScreen`, `MenuScreen`, `CartScreen`, `PayScreen`, etc.; no hay `Btn`/`Card`/`Kpi` compartido).

Por eso se descartan los enfoques A y "B clásico":
- **A) swap a `.my-*`:** no hay componentes centralizados → habría que tocar decenas de botones
  bespoke; además cambiaría colores/forma de UIs móviles **branded** (rider/cliente). Riesgo alto.
- **B clásico (como Mozo):** no hay bloque `:root` de variables locales que aliasar.

**Enfoque elegido (ambos paneles): token bridge *inline*.** Se observó que los **neutrales**
hardcodeados usan **exactamente los valores de los tokens globales**, así que se reemplazan los
literales por `var(--token)` (mismo valor en light → **delta visual cero**; quedan theme-reactivos
→ listos para que PR-B4 los termine). Marca, semánticos y frame se preservan.

| Hex (literal) | → token | rol | rider | cliente |
|---|---|---|---|---|
| `#1D1D1F` | `var(--text-primary)` | texto/acción primaria | 25 | 4 |
| `#86868B` | `var(--text-tertiary)` | texto atenuado / dots | 19 | 4 |
| `#6E6E73` | `var(--text-secondary)` | texto secundario | 9 | 2 |
| `#D2D2D7` | `var(--border)` | bordes | 9 | 0 |
| `#F5F5F7` | `var(--bg-subtle)` | fondo/borde sutil | 13 | 1 |
| **Total bridged** | | | **75** | **11** |

- **Verificación de seguridad:** ninguno de esos hex aparece como **atributo SVG** (`fill=`/
  `stroke=`) — todos están en `style={{}}` inline, donde `var()` resuelve. Se confirmó 0 residual
  tras el reemplazo en ambos archivos.

## Cambios visuales realizados

- **Delivery rider:** 75 literales neutrales → `var(--token)`. Sin tocar clases, layout, handlers,
  estados, rutas ni el marco del simulador.
- **Delivery cliente:** 11 literales neutrales → `var(--token)` (menos, por ser una UI **branded**
  con paleta semántica diversa). Mismo criterio.

**Delta visual:** en **light** (tema activo) = **cero** (todos los valores light son idénticos).
En **dark** (no activo) los neutrales pasan a resolver por token → preparado para PR-B4.

## Qué quedó fuera de alcance (no bridgeado, con justificación)

- **`.my-*` (primitivas):** no se usan (enfoque = token bridge, decisión por panel). 0 en ambos.
- **Colores de marca / CTA:** `#C2410C` (naranja de "iniciar ruta" del rider) y similares → identidad
  del flujo; no se tokenizan (sería rediseño).
- **Colores semánticos / badges de estado:** verdes (`#34C759`/`#16A34A`/`#166534`), ámbar/aviso
  (`#FF9500`/`#FFF7ED`/`#92400E`/`#FDBA74`), azules de estado (`#EFF6FF`/`#1E40AF`), rojos
  (`#EF4444`/`#B91C1C`/`#FECACA`), etc. → portan estado de pedido/cocina/zona; se mantienen.
- **`#fff` / `#000`:** marco del simulador de teléfono, fondo de pantalla/card, texto blanco sobre
  botón y sombras `rgba`. Roles mixtos (bg/ texto-inverso/ sombra) → se dejan; su afinado fino es
  trabajo de PR-B4 (dark) por panel.
- **`#8E8E93`, `#C7C7CC`, tints `-soft` branded:** sin match 1:1 limpio con un token de light →
  se dejan locales.

## Riesgos evitados

- **Sin swap de clases ni de componentes:** no se tocó estructura/layout de las pantallas móviles.
- **Sin cambio de lógica:** no se tocaron estados de delivery, asignación de rider, tracking,
  polling/realtime, rutas, navegación ni handlers.
- **Sin SVG roto:** se verificó que los neutrales no estaban en atributos `fill`/`stroke` (donde
  `var()` no resolvería).
- **Delta light cero:** el bridge es value-preserving en el tema activo (`light`).

## Validación

- `npm run build`: **PASS** (9/9; `delivery-rider.js` 167.69 kB, `delivery-cliente.js` 235.52 kB).
  `npm run typecheck`: no existe (JS/JSX puro).
- `git diff --name-only`: **solo `src/delivery-rider/main.jsx` y `src/delivery-cliente/main.jsx`**
  (bundles gitignored; los HTML shells NO se tocaron).
- Residual de hex neutrales bridgeados: **0** en ambos. `var(--token)` bridge: rider 75, cliente 11.

## Confirmación de no-alcance

No se tocó: **Gerente, Admin, Superadmin, Caja, Cocina, Mozo, Login, Diag** ·
`public/delivery-*.html` · `ui-primitives.css` / `tokens.css` ·
**Auth/backend/Supabase/DB/RLS/RPC/migraciones/teardown** · **lógica/API/permisos/datos** ·
**estados de delivery / asignación de rider / tracking** · **polling/realtime** ·
rutas/navegación · **dark mode global** (ambos siguen pineados `light`). **PR-B4 no iniciado.**

## Follow-ups conocidos (fuera de este PR, NO investigados)

- Caja: botones inline de "Vista del salón".
- Cocina: 2 charts de StatsPanel data-gated por 0 completados.
- Mozo: `.item-card` data-gated por orden vacía.
- Superadmin: chart MRR con barra negra (`blue:'#000000'`).
- Admin: errores 42501 (permission denied) — DB/RLS.
- Futuro: (opcional) bridgear/tokenizar también la paleta semántica/branded y el `#fff`/`#000` de
  frame con criterio dark por elemento; eso es parte de PR-B4 (dark global por panel con checklist).

## Conteos finales

- `.my-card` / `.my-metric-card` / `.my-btn` en ambos paneles (JSX): **0** — por decisión de
  enfoque (token bridge, no consumo directo de primitivas).
- Token bridge (`var(--token)` en neutrales): **rider 75**, **cliente 11**.
- Hex hardcodeados restantes (semántico/marca/frame): rider **63**, cliente **103** — justificados.
