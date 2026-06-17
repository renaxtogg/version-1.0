# PR-B3D — UI primitives en paneles operativos

> FASE B (UI/UX unificado + dark mode). Sigue a PR-B3A (Gerente), PR-B3B/-FIX (Admin) y PR-B3C (Superadmin).
> Fecha: 2026-06-17 · Rama: `fix/pr-b3d-operational-panels-ui` · Base: `main = 56c0cd8`.
> Alcance: **paneles operativos** (Caja, Cocina, Mozo, Delivery). Frontend/visual, migración **acotada**.

## Objetivo

Auditar los paneles operativos y migrar **de forma acotada y segura** a las primitivas UI
compartidas (`.my-card`, `.my-metric-card`, `.my-btn`), aplicando el patrón validado en
B3A/B3B/B3C: migrar las **definiciones de los componentes compartidos** (swap className-only),
de modo que el cambio se propague a todos los usos sin tocar call sites, handlers, props, ids,
data-attributes ni lógica. **No** rediseño, **no** tocar lógica, **no** dark mode global.

## Paneles revisados

| Panel | Archivo | Componentes compartidos | Resultado |
|---|---|---|---|
| **Caja** | `src/caja/main.jsx` | `Btn` (41 usos), `KpiMini` (10 usos) | **Migrado** ✅ |
| **Cocina** | `src/cocina/main.jsx` | `Btn` (= toggle con estado `active`) | **No aplica** (sin candidato seguro) |
| **Mozo** | `src/mozo/main.jsx` | — (sin Card/Btn/Kpi compartido; todo inline) | **No aplica** (sin refactor estructural) |
| **Delivery (rider)** | `src/delivery-rider/main.jsx` | — (botones inline a medida) | **No aplica** (sin refactor estructural) |
| **Delivery (cliente)** | `src/delivery-cliente/main.jsx` | — (flujo branded inline) | **No aplica** (sin refactor estructural) |

> Nota: el prompt nombraba `src/delivery/main.jsx`, que **no existe**. "Delivery" son dos paneles
> reales: `delivery-rider` (staff) y `delivery-cliente` (cliente). Se auditaron ambos.
> `src/index/main.jsx` (cliente QR) **no** estaba en la lista objetivo → fuera de alcance.

## Por qué solo Caja se migra (auditoría honesta — lección de PR-B3B-FIX)

El swap **className-only** es seguro y acotado **solo cuando el panel define componentes
compartidos centralizados** cuyo cambio se propaga sin tocar call sites. La auditoría encontró:

- **Caja** centraliza `Btn` (41×) y `KpiMini` (10×) → migración segura, alto leverage. ✅
- **Cocina** (KDS): su único componente `Btn` es un **toggle con estado `active`** (control
  segmentado de vista en el header) — exactamente lo que el alcance prohíbe convertir. Los
  "tickets" del kanban son **cards especializadas** con estados/columnas, no `SectionCard`
  genéricos; migrarlos sería rediseño. Además el panel es **theme-reactivo dark** (default
  `dark`, paleta `PALETTES`/`C` reactiva a `mythos:themechange`). → **No aplica** sin rediseño.
- **Mozo / Delivery-rider / Delivery-cliente**: **no tienen** componentes compartidos
  `Card`/`Btn`/`Kpi`; cada botón y card es **markup inline a medida** (colores por ternario
  `dark?…`, estilos por pantalla). Migrarlos exigiría **tocar muchos call sites** o **introducir
  componentes nuevos** (refactor estructural) → fuera del alcance "acotado, sin rediseño, sin
  tocar lógica". → **No aplica** sin un refactor aparte.

Forzar la migración en estos paneles repetiría el *coverage gap* de PR-B3B (clases en
definiciones que la UI real no renderiza, o cambios de muchas superficies inline con riesgo).
Se prefiere reportar **"no aplica"** honesto y dejar el refactor estructural para un PR dedicado.

## Archivos tocados

- **`src/caja/main.jsx`** — 2 definiciones de componente migradas a `.my-*`.
- **`public/build/caja.js`** — bundle reconstruido (`npm run build`). **Gitignored**, no versionado.
- **`docs/audits/pr-b3d-operational-panels-ui.md`** — este doc.

`git diff --name-only` ⇒ solo `src/caja/main.jsx`. Ningún otro panel de código.

## Cambios visuales realizados — por panel

### Caja (`src/caja/main.jsx`)

1. **`Btn` → `.my-btn my-btn--<variant>`** (+ `my-btn--sm` si `small`). Se preservan props,
   `onClick` y el atributo nativo `disabled` (el `<button>` sigue bloqueando el click), y `full`
   → `width:100%`. Mapeo de variantes usadas (danger/ghost/primary/secondary/success) **1:1** a
   las clases del design system. **Cambio visual intencional:** `danger`/`success` pasan de
   **tinte suave a sólido** (estándar unificado, igual que en B3A/B3B/B3C). Propaga a **41** usos.
2. **`KpiMini` → `.my-metric-card`** + `.my-metric-card__label`. El contenedor toma
   superficie/borde/radio/sombra/padding por tokens; el label adopta el look estándar (xs,
   semibold, uppercase, secondary). **Se conserva** el valor en mono (`SF Mono`, 22px/800) y el
   **`accent` semántico** (Mesas ocupadas/En cocina/Listos/Delivery/Sin cobrar/Cancelado…), que
   transmite estado; el fallback `C.ink` pasa a `var(--text-primary)`. `sub` conservado. Propaga
   a **10** usos (turno: 6 KPIs; reportes: 4 KPIs) — verificado que ambas superficies renderizan
   (no hay coverage gap).

`caja.html` ya carga la cascada correcta (`design-system.css` → `tokens.css` → `ui-primitives.css`
→ `mythos-theme.js`) y está pineado `light` (`MythosTheme.init('light')`) → las primitivas
resuelven en light, sin cambio de comportamiento de tema.

### Cocina / Mozo / Delivery (rider y cliente)

**Sin cambios de código.** Auditados; no hay candidato seguro/acotado (ver sección anterior).

## Qué quedó fuera de alcance (diferido, con justificación)

- **Caja — `Badge`** (color dinámico por estado, 18 usos), **`Modal`**, **`Lbl`/`Inp`/`Sel`/
  `Textarea`** (formularios), **`AlertBox`**, **`Divider`**, **`KpiMini` accent** (semántico, se
  mantiene a propósito): UI especializada o portadora de significado; diferida para no rediseñar.
  Cards inline de Caja (no hay `Card`/`SectionCard` compartido) → diferidas.
- **Caja — `#F5F5F7` restantes (6 líneas):** todas justificadas, **ninguna es un fondo de
  página/card del DOM vivo migrable de forma segura**:
  - L180 `C_LIGHT.bg` / L188 `C_DARK.ink` / L189 `C_DARK.purple` → **valores de paleta JS**,
    ya **theme-reactiva** (`C_DARK` existe y conmuta en runtime) → **no bloquea dark-readiness**,
    por eso **no** se tokeniza (a diferencia de Admin/Superadmin, Caja ya cambia de paleta en vivo
    y además **imprime tickets 80mm offline**; se evita tocar su sistema de color crítico).
  - L793 (banner dark `#1C1C1E`/texto `#F5F5F7`), L1247 (input PIN de denominaciones), L1345
    (header de fila) → **elementos inline localizados**, no componentes compartidos → fuera del
    swap acotado.
- **Cocina**: `Btn` (toggle), tickets KDS (cards especializadas), paleta dark propia.
- **Mozo / Delivery (rider/cliente)**: refactor estructural a componentes compartidos →
  PR dedicado (no en B3D).

## ¿Se tocó `ui-primitives.css` / `tokens.css`?

**No.** Las primitivas existentes alcanzaron. Diff de CSS global = 0.

## Validación

- `npm run build`: **PASS** (9/9; `caja.js` 327.00 kB). `npm run typecheck`: no existe (JS/JSX puro).
- `git diff --name-only`: **solo `src/caja/main.jsx`** (bundles gitignored).
- Bundle `public/build/caja.js`: contiene `my-btn` (7) y `my-metric-card` (2) → renderiza las
  primitivas en prod tras deploy.
- Líneas `+` del diff con literal de color nuevo (excluyendo `var()`): **0**.

## Confirmación de no-alcance

No se tocó: **Gerente, Admin, Superadmin, Login, Diag** · **Cocina, Mozo, Delivery (rider/cliente)**
quedaron sin cambios de código · **Auth/backend/Supabase/DB/RLS/RPC/migraciones/teardown** ·
**lógica/API/permisos/datos** · rutas/navegación · handlers/ids/data-attrs · `ui-primitives.css`/
`tokens.css` · **dark mode global** (Caja sigue pineado `light`). **PR-B4 no iniciado.**

## Follow-ups conocidos (fuera de este PR, NO investigados)

- Superadmin: chart MRR con barra negra por `blue:'#000000'`.
- Admin: errores de consola 42501 (permission denied) — DB/RLS.
- Futuro: refactor de Mozo/Delivery a componentes compartidos; migración de Cocina KDS con su
  propio criterio dark; tokenización de paletas JS y elementos inline localizados; recién entonces
  PR-B4 (dark global por panel con checklist).

## Conteos finales

- `src/caja/main.jsx`: `.my-btn` (def `Btn`, 41 usos) + `.my-metric-card` (def `KpiMini`, 10 usos).
- `src/cocina/main.jsx` / `src/mozo/main.jsx` / `src/delivery-rider/main.jsx` /
  `src/delivery-cliente/main.jsx`: `.my-*` = **0** (sin cambios; no aplica).
- `#F5F5F7` restantes: Caja 6 (justificadas), Cocina 4, Mozo 1, Delivery-rider 12, Delivery-cliente 1
  (paletas/elementos inline de paneles **no migrados** en este PR).
