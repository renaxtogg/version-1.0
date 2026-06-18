# PR-B4E — Caja dark activation

> FASE B (UI/UX + dark global). Cuarto panel staff activado en dark, tras Gerente (B4B),
> Superadmin (B4C) y Admin (B4D).
> Fecha: 2026-06-18 · Rama: `fix/pr-b4e-caja-dark-activation` · Base: `main = a222718`.
> Frontend/visual. NO toca lógica de cobro/turnos/pedidos, datos, backend, permisos, ni otros paneles.

## 1) Cómo se activa dark en Caja

- **Caja ya tenía** la infraestructura completa: objeto `C` con variantes **light/dark**
  (`C_LIGHT`/`C_DARK`), listener `mythos:themechange` que hace `Object.assign(C, …)` + `forceRender()`,
  `toggleTheme()` → `MythosTheme.toggle()`, y un **toggle sun/moon YA wireado** en `SidebarTurno`
  (`onToggleTheme`).
- **Activación (1 línea):** `public/caja.html` pasa de `MythosTheme.init('light')` a
  **`MythosTheme.init()`** → respeta `localStorage['mythos-theme']`/sistema y **persiste** vía el
  toggle existente. **Solo Caja**; el resto de shells siguen pineados.
- **`mythos-theme.js` NO se tocó.** **¿Toggle nuevo?** No: ya existía, se reutilizó.
- Shell: además se tokenizó el spinner `.spin` (`#D2D2D7`/`#1D1D1F` → `var(--border)`/`var(--text-primary)`).
- **`data-theme="dark"` cambia realmente** y persiste en recarga; volver a light = mismo toggle.

## 2) Ajustes visuales para contraste dark (solo color/tinte; lógica intacta)

Caja partía con 94 literales hex. El núcleo (fondos/superficies/sidebar/texto/botones/metric cards
Opción A) ya adaptaba vía `C`. Se cablearon los literales inline que romperían en dark. **Toda la
lógica de cobro/turnos/pedidos/cancelación, condicionales, handlers y queries intactos: solo cambió
el valor de color.**

### Técnica: helper `TINT` (frozen-safe + theme-adaptive)
Igual que B4C/B4D: strings `color-mix(in srgb, var(--estado) N%, var(--surface|--text-primary))` para
tintes que viven en objetos `const` (`AlertBox`, `ZONAS_DEF_C`) o en pills. Familias
`amber / green / blue / red` (+ `purple` bg/border para la zona "privado"). El navegador los resuelve
por tema en cada paint → frozen-safe.

### Superficies cableadas
- **Modal de autorización PIN + modal de cancelación rápida** (estaban hardcodeados en blanco/negro,
  no usaban `C`): card `#FFFFFF`/borde `#000000` → `C.surface`/`C.border`; texto `#000`/`#000000` →
  `C.ink`; subtítulos `#3A3A3C` → `C.mid`; insets `#F5F5F7` → `var(--bg-subtle)`; cajas info/error
  `#000000`/`#FFFFFF` → `C.ink`/`C.surface`; botones primarios `#000`/`#FFF` → `C.ink`/`C.surface`;
  borde de error del PIN `error?#000000:#D2D2D7` → `error?C.red:C.border`; total/asteriscos `#C0190F`
  → `C.red`. **Sin tocar la lógica de PIN/cancelación.**
- **Toast** (`it.ok?#F0FAF3:#FFF1F0` …) → `TINT.green*/red*`.
- **AlertBox** (`const cfg` con texto claro `#93c5fd/#fde68a/#fca5a5/#86efac` sobre tinte translúcido
  — de hecho **poco legible en light**) → `TINT.{blue/amber/red/green}*`. Mejora ambos temas.
- **Botones-segmento seleccionados** (método de pago, tipo de orden, categoría, rango, modo, tabs):
  patrón `?#000000:'transparent'` / `?#000000:C.border` / `?#FFFFFF:C.mid` / `?#fff:#3D3D3D` →
  `C.ink`/`C.surface`/`C.border` reactivos. Underline de tab `2px solid #000` → `C.ink`.
- **Botones primarios "Guardar"** (`#000`/`#ccc` + texto `#fff`) → `C.ink`/`C.border`/`C.surface`/`C.dim`.
- **Botones de acción** `background:'#000',color:'#fff'` → `C.ink`/`C.surface`.
- **Keypad** (teclas operador `#000000`/`#FFFFFF`) → `C.ink`/`C.surface` (rgba de del/eq se mantienen).
- **Toggle "Factura Electrónica"**: label `#0040A0` → `C.blue`; track off `#D1D1D6` → `C.border`
  (on `#007AFF`→`C.blue`); knob `#fff` se mantiene (correcto en dark).
- **Pills/avisos**: `#FFF7ED`/`#FEE2E2` → `TINT.amberBg/redBg`; bordes `#FED7AA`/`#DC2626` →
  `TINT.amberBorder/redBorder`; textos `#991B1B`/`#B45309`/`#16A34A`/`#15803D`/`#248A3D`/`#1A7E37`/
  `#004AAD` → `TINT.*Text`; "vuelto a devolver" `#86efac` → `TINT.greenText`.
- **Neutros**: separadores/insets `#F0F0F0` → `var(--bg-subtle)`; bordes `#D2D2D7` → `C.border`;
  selects/inputs `#FFF`/`#FFFFFF` → `C.surface`; barras/labels grises `#3D3D3D`/`#C0C0C0`/`#777` →
  `C.mid`/`C.dim`.
- **`color:'#000000'` sueltos**: precio de ítem en resumen de cobro (sobre `C.card`) y heading
  "Reservas" → `C.ink` (**eran invisibles en dark**; el de Reservas además era inconsistente).
- **Canvas de salón/mesas — partes NO acopladas a condición**: contenedor (`ZONAS_DEF_C` bg/border)
  → `TINT.*` (dots saturados intactos); label de zona `#3D3D3D` → `C.mid`; empty-state `#C0C0C0` →
  `C.dim`; **celda de mesa (vista lista)** ocupada `occ?#1D1D1F:C.surface` → `occ?C.ink:C.surface` +
  texto interno `#FFFFFF`/`#1D1D1F`/`#AAAAAA` → `C.surface`/`C.ink`/`C.dim`.

### Deliberadamente NO tocado
- **Mapa de estados del floor-plan `SC_C`** (libre/ocupada/cocina/lista/cobro/reservada/alerta):
  sus valores (`bg`/`bd`/`tx`) alimentan tanto el render como **condiciones** (`sc.tx==='#FFFFFF'`
  en 2 lugares para elegir el color del sub-texto). Recolorearlo **cambiaría una condición de
  render** (prohibido). Se deja intacto: las celdas conservan su **color-coding por estado** (legible
  sobre el canvas ya adaptado). **Pendiente de QA / posible PR dedicado** (requiere refactor de la
  condición, con su propia aprobación). Único punto débil: la celda "ocupada" (`#1D1D1F`) tiene bajo
  contraste sobre canvas oscuro.
- **Toast `BancardProximamente`** (`#1C1C1E` + texto claro): snackbar oscuro intencional, funciona en
  ambos temas → se mantiene.
- **Knobs de switches** (`background:'#fff'` circular): blanco correcto sobre track en ambos temas.
- **Colores semánticos saturados** (`SC` status map, `C.green/orange/red/blue`, dots de `ZONAS_DEF_C`,
  `#fff` sobre botones de color) → legibles en dark.

## 3) Checklist visual light / dark (Caja)

| Elemento | Light | Dark | Mecanismo |
|---|---|---|---|
| Fondo / sidebar / nav | ✅ | ✅ | shell tokens + `C` |
| Cards (`C.card/surface`) | ✅ | ✅ | `C` |
| **Metric cards (Opción A neutra)** | ✅ | ✅ | `.my-metric-card`; accent vía `C` |
| Botones (primarios/segmento/keypad) | ✅ | ✅ | `C.ink`/`C.surface`/`C.border` |
| Inputs / selects | ✅ | ✅ | shell tokens + `C.surface` |
| Tablas / listas / resúmenes | ✅ | ✅ | `C` + `var(--bg-subtle)` |
| **Modales (cobro-auth / cancelación)** | ✅ | ✅ | cableados a `C` (sin tocar lógica) |
| Resumen de cobro (ítems/total/vuelto) | ✅ | ✅ | `C.ink`/`C.green`/`TINT.greenText` |
| Badges / estados / AlertBox | ✅ | ✅ | `TINT.*` (color-mix) |
| Caja abierta/cerrada (turno) | ✅ | ✅ | `C` + `open?C.white:C.surface` |
| Salón/mesas (lista) | ✅ | ✅ | celda `occ?C.ink:C.surface` |
| **Salón/mesas (floor-plan canvas)** | ✅ | ⚠️ | frame adaptado; celdas con color-coding fijo (ver §2/§4) |
| Toggle Factura / switches | ✅ | ✅ | `C.blue`/`C.border`, knob blanco |
| Texto secundario | ✅ | ✅ | `C.mid/dim` |

- **Sin textos invisibles** (0 `color:'#000/#000000/#3D3D3D'` frozen; 2 invisibles latentes corregidos).
- **Sin cards/pills blancas sobre fondo oscuro** (scan final: solo knobs blancos + saturados + toast dark).
- **Sin contraste invertido** (negros/blancos → `C.ink/surface`).

## 4) Superficies data-gated / sensibles no verificadas (QA)
- **Floor-plan de mesas (canvas drag-and-drop)**: las celdas usan `SC_C` (color-coding por estado,
  acoplado a la condición `sc.tx==='#FFFFFF'`). Frame/labels adaptados; celdas con color fijo. Requiere
  QA visual con mesas reales en varios estados; la celda "ocupada" puede verse con bajo contraste en
  dark. Adaptar las celdas exige tocar una condición → fuera de alcance de B4E.
- **Modal de cobro / vuelto / cierre de turno**: cableados visualmente, pero conviene spot-check con
  un cobro real (montos, vuelto positivo/negativo, factura fiscal on/off).
- **Modo offline** (PWA): banners/estados con datos; revisar en QA.

## 5) Hallazgos funcionales (NO corregidos — visual/dark-only)
- **No se observaron** errores `42501`/`PGRST116`/RLS durante la edición (PR estático, sin tocar
  queries/RPC/endpoints). Si aparecen en QA runtime → se documentan aparte, **no** se arreglan aquí.
- `AlertBox` tenía texto claro sobre tinte translúcido (poco legible en light) — corregido como efecto
  colateral del cableado a `TINT` (mejora, no degrada).

## 6) Pendiente para otros paneles (NO tocados)
Cocina, Mozo, Delivery (rider/cliente), Login → **siguen pineados**; cada uno en su PR. **Gerente
(B4B), Superadmin (B4C) y Admin (B4D)** **no se tocaron**. **QR/menu (index): EXCLUIDO**.

## 7) Riesgos visuales
- **Acotado a Caja.** Light prácticamente idéntico (neutros → `var(--bg-subtle)` ≈ `#F5F5F7`;
  microvariación de hue en tints; `AlertBox` mejora). Dark sobre `C` + `TINT` + tokens. Reversible.
- Riesgo residual conocido: floor-plan de mesas (celdas color-coded, §4) — pendiente de QA.

## 8) Build
- `npm run build`: **PASS — 9/9** (`built in` ×9, `caja.js` 327.95 kB, sin errores).

## Confirmación de no-alcance
`git diff --name-only main` ⇒ **`public/caja.html` + `src/caja/main.jsx`** (+ este doc). Sin cambios
en `mythos-theme.js`, `tokens.css`, `ui-primitives.css`, otros paneles, `src/index/main.jsx`,
`public/index.html`, `public/build/*`. No se tocó: Auth/backend/Supabase/DB/RLS/RPC/migraciones/datos/
teardown/permisos/lógica de cobro/turnos/apertura-cierre/API/flujos/handlers/condiciones de render/
queries/payloads. Solo el handler visual del toggle (preexistente) gobierna el tema. **QR/menu intacto
y excluido. Gerente/Superadmin/Admin no tocados. Ningún otro panel activado.**
