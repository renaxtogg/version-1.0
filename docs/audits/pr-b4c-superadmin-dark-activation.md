# PR-B4C — Superadmin dark activation

> FASE B (UI/UX + dark global). Segundo panel staff activado en dark, tras Gerente (B4B).
> Fecha: 2026-06-17 · Rama: `fix/pr-b4c-superadmin-dark-activation` · Base: `main = bfca5dc`.
> Frontend/visual. NO toca lógica, datos, backend, ni otros paneles.

## 1) Cómo se activa dark en Superadmin

- **Superadmin ya tenía** un objeto de paleta `C` con variantes **light/dark** (`PALETTES`)
  **reactivo a `mythos:themechange`** y un **toggle de tema YA wireado** en el `Sidebar`
  (`onToggleTheme` → `MythosTheme.toggle()`, ícono sun/moon, estado `themeMode`).
- **Activación (1 línea):** `public/superadmin.html` pasa de `MythosTheme.init('light')` a
  **`MythosTheme.init()`** → respeta `localStorage['mythos-theme']`/sistema y **persiste** vía el
  toggle existente. **Solo Superadmin**; el resto de shells siguen pineados.
- **`mythos-theme.js` NO se tocó.** **¿Toggle nuevo?** No: ya existía, se reutilizó.
- **`data-theme="dark"` cambia realmente** y persiste en recarga (init() respeta la preferencia
  guardada por el toggle); volver a light = mismo toggle.

## 2) Ajustes visuales para contraste dark (solo color/tinte; lógica intacta)

El núcleo (fondos/superficies/cards/sidebar/texto/botones primitivos/metric cards/charts) **ya
adaptaba** vía `C` + `.my-*` + el fix MRR de PR-B3I.5. Se corrigieron los literales inline que
**no** pasaban por `C` y romperían en dark. **Toda la lógica/condicionales intactos: solo cambió
el valor de color.**

### Técnica: helper `TINT` (frozen-safe + theme-adaptive)
Varios tintes viven en **objetos `const` de estado** (`statusMeta`, `SUPPORT_STATUS`, etc.)
evaluados una sola vez → no podían usar `C` (que es **mutado** en `themechange` → se congelarían).
Se agregó un helper **`TINT`** de strings `color-mix(in srgb, var(--estado) N%, var(--surface|--text-primary))`:
el navegador los resuelve **por tema en cada paint**, así que sirven incluso dentro de `const`.
Familias: `ok / warn / danger / info / purple` (bg + text + warnBorder). Mismo lenguaje que `.my-badge`.

### Superficies cableadas
- **Mapas de estado:** `statusMeta` (Activo/Trial/Suspendido/Vencido/Mora/Inactivo/Cancelado),
  `SUPPORT_STATUS`, `SUPPORT_PRIO`, helper de vencimiento → `TINT.*` / `C.*` / `var(--bg-subtle)`.
- **Inline render:** trend ↑/↓ (%), latencia, dots de salud (→ `C.green`), pill de add-ons,
  fila "vence pronto", banner de aviso, **zebra de tablas de reporte**, item de lista de soporte,
  **fondo del panel de chat** (`#FAFAFB` → `var(--bg-subtle)`), pill "En vivo",
  **calendario** (día seleccionado/hoy/alta-afluencia/global + bordes + número), leyenda,
  badges "Global".
- **Patrón negro/blanco que invertía mal:** `Toggle` (switch), `FilterBtn`, badge **POPULAR**,
  **burbujas de chat** → `C.ink` / `C.surface` (theme-reactivo). Select de reportes `#fff`→`C.surface`.
- **Charts:** MRR ya correcto (B3I.5); **donut de almacenamiento** slice 0 `#1D1D1F`→`C.ink` (no
  queda near-negro en dark). HBars/TrendArea/SemiGauge usan `C.ink` (adaptan).

### Deliberadamente NO tocado
- **Contenedor del código QR** (`background:'#FFFFFF'`): el blanco es **requerido para
  escaneabilidad** del QR → se mantiene en ambos temas (correcto).
- **HTML de exportación** (filas zebra `#fff/#f9f9f9` del XLSX/print): documento exportado, siempre
  claro.
- Colores de estado saturados puntuales (`C.green/orange/red`, dots de tipo de evento) y `#fff` de
  texto sobre fondos de color → legibles en dark, se mantienen.

## 3) Checklist visual light / dark (Superadmin)

| Elemento | Light | Dark | Mecanismo |
|---|---|---|---|
| Fondo / sidebar / nav | ✅ | ✅ | `C.bg/sidebar` + nav activo `C.ink` |
| Cards (SectionCard = `.my-card`) | ✅ | ✅ | tokens |
| **Metric cards (Opción A neutra)** | ✅ | ✅ | `.my-metric-card` neutro; valor accent vía `C` |
| Botones (Btn = `.my-btn`) | ✅ | ✅ | tokens |
| Inputs / selects | ✅ | ✅ | shell tokens + select `C.surface` |
| Tablas / listas / zebra | ✅ | ✅ | `C.surface` / `var(--bg-subtle)` |
| Modales | ✅ | ✅ | `C.surface` + tokens |
| Badges / estados (status maps) | ✅ | ✅ | `TINT.*` (color-mix adaptativo) |
| Toggles / filtros / POPULAR / chat | ✅ | ✅ | `C.ink` / `C.surface` |
| Calendario (sel/hoy/alta/global) | ✅ | ✅ | `C.ink` / `TINT.info/warn/purple` |
| **Charts** | ✅ | ✅ | MRR `C.ink` (B3I.5); donut slice0 `C.ink`; resto `C.ink` |
| Texto secundario | ✅ | ✅ | `C.mid/dim` |

- **Sin textos invisibles** (0 `color:'#1D1D1F/...'` frozen — todo texto vía `C`).
- **Sin cards blancas sobre fondo oscuro** (scan final: solo el QR blanco intencional + PALETTES).
- **Sin chart negro** (MRR + donut cubiertos). **Sin contraste invertido** (negros/blancos → `C.ink/surface`).

## 4) Light no se degrada

Los `TINT.*` en light ≈ los tintes claros previos (mismas familias pastel + texto de estado);
microvariación de hue por `color-mix` (visualmente equivalente). El negro de marca `#000`→`C.ink`
(`#1D1D1F`) es el delta estándar de FASE B. **No hay degradación funcional ni de legibilidad.**

## 5) Observaciones / pendientes

- **`C.dark.bg` es `#000000`** (negro puro) — el design system prefiere `#0B0B0D`; funciona y da
  buen contraste con cards `#1C1C1E`. Polish opcional (igual que Gerente).
- Vistas/charts **data-gated** (MRR multi-mes, donut con datos, soporte con hilos, tablas de
  reporte) validadas por código + tema; conviene spot-check visual con datos reales en QA.

## 6) Pendiente para otros paneles (NO tocados)

Admin, Caja, Cocina, Mozo, Delivery (rider/cliente), Login → **siguen pineados**; cada uno en su
PR (B4D…). **Gerente** (B4B) **no se tocó**. **QR/menu (index): EXCLUIDO** (branding por `mood`).

## 7) Riesgos visuales

- **Acotado a Superadmin.** Light prácticamente idéntico; dark construido sobre `C` + `TINT` +
  `.my-*` + tokens, con todos los literales de contraste cubiertos (scan final limpio). Reversible.
  Sin riesgo de layout/lógica.

## 8) Build

- `npm run build`: **PASS — 9/9** (`built in` ×9, sin errores).

## Confirmación de no-alcance

`git diff --name-only main` ⇒ **`public/superadmin.html` + `src/superadmin/main.jsx`** (+ este doc).
Sin cambios en `mythos-theme.js`, tokens.css, ui-primitives.css, otros paneles, `src/index/main.jsx`,
`public/index.html`, `public/build/*`. No se tocó: Auth/backend/Supabase/DB/RLS/RPC/migraciones/
datos/teardown/permisos/lógica/API/flujos/handlers/condiciones de render/queries/payloads. Solo el
handler visual del toggle (preexistente) gobierna el tema. **QR/menu intacto y excluido. Gerente no
tocado. Ningún otro panel activado.**
