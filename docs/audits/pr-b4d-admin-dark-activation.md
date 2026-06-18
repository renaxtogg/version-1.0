# PR-B4D — Admin dark activation

> FASE B (UI/UX + dark global). Tercer panel staff activado en dark, tras Gerente (B4B) y Superadmin (B4C).
> Fecha: 2026-06-18 · Rama: `fix/pr-b4d-admin-dark-activation` · Base: `main = 232fccb`.
> Frontend/visual. NO toca lógica, datos, backend, permisos, ni otros paneles.

## 1) Cómo se activa dark en Admin

- **Admin ya tenía** la infraestructura completa de tema: objeto `C` con variantes **light/dark**
  (`C_LIGHT`/`C_DARK`) **reactivo a `mythos:themechange`** (se hace `Object.assign(C, …)`), estado
  `themeMode`, listener, `toggleTheme()` → `MythosTheme.toggle()`, y un **toggle sun/moon YA wireado**
  en el `Sidebar` (`onToggleTheme`).
- **Activación (1 línea):** `public/admin.html` pasa de `MythosTheme.init('light')` a
  **`MythosTheme.init()`** → respeta `localStorage['mythos-theme']`/sistema y **persiste** vía el
  toggle existente. **Solo Admin**; el resto de shells siguen pineados.
- **`mythos-theme.js` NO se tocó.** **¿Toggle nuevo?** No: ya existía, se reutilizó.
- **`data-theme="dark"` cambia realmente** y persiste en recarga; volver a light = mismo toggle.

## 2) Ajustes visuales para contraste dark (solo color/tinte; lógica intacta)

Admin era el panel **más lejano de dark-ready** (~694 literales hex; los otros paneles ~250–300).
El núcleo (fondos/superficies/cards/sidebar/texto/botones/metric cards Opción A) **ya adaptaba** vía
`C` + `.my-*` + tokens. Se cablearon los literales inline que **no** pasaban por `C` y romperían en
dark. **Toda la lógica/condicionales/handlers intactos: solo cambió el valor de color.** Hex
hardcodeados en el componente: **694 → 148** (los 148 restantes son intencionales: ver §4).

### Técnica: helper `TINT` (frozen-safe + theme-adaptive)
Varios tintes viven en **objetos `const`** (`levelStyle`, `ZONAS_DEF`, `rowBg`, mapas de estado)
evaluados una vez → no podían usar `C` (que se **muta** en `themechange` → se congelarían). Se
agregó **`TINT`** = strings `color-mix(in srgb, var(--estado) N%, var(--surface|--text-primary))`:
el navegador los resuelve **por tema en cada paint**, así que sirven dentro de `const`. Familias
`amber / green / blue / red / purple` (cada una bg + text + border). Mismo lenguaje que `.my-badge`.

### Superficies cableadas (resumen)
- **Neutros claros → `var(--bg-subtle)` / `C.surface` / `C.border`:** cabeceras y zebra de tablas
  (`#FAFAFA`/`#F9F9FA`/`#F9F9F9`/`#fff`), selects (`#FFF`), segment control (`#EFEFF4`), placeholder
  de imagen (`#E8E8ED`), barras de progreso (`#EEEEEE`), badge "Global" (`#F0F0F5`), área de chat
  (`#FAFAFB`), separadores de fila (`#F0F0F0`/`#E5E5EA`/`#D2D2D7`), hovers de fila
  (`#F9F9FA`→`var(--surface-hover)`).
- **Pills de tinte semántico → `TINT.*`:** promo tags, FACTURA/FRECUENTE/VIP/VENCIDO,
  "Para llevar"/"Delivery", "Solo local", "Google ✓", botones Desactivar/Reactivar, toast (ok/error),
  cajas de aviso (stock/factura), filas de alerta del dashboard (sin monto / sin cierre / diferencias),
  `levelStyle` (critical/warning/info), `ZONAS_DEF` (salón/terraza/bar/privado/exterior), `rowBg` por
  estado de orden, celda de mesa (alerta/reservada/ocupada/libre).
- **Patrón negro/blanco que invertía mal → `C.ink`/`C.surface`:** botones CSV + header de tabla de
  reporte (`#1D1D1F`, que se fundía con la superficie dark), burbujas de chat, icon-picker, toggles
  de config, `FilterBtn`, selector de cash-mode, chips seleccionables, selector de rango, botón
  primario "Guardar" (`#000`/`#ccc`), día de calendario (seleccionado/hoy).
- **Bug latente corregido:** `RESTAURANT ID` tenía `color:'#F5F5F7'` sobre `C.bg` → **invisible en
  light** (texto casi-blanco sobre fondo casi-blanco). Ahora `C.ink` → visible en ambos temas.

### Deliberadamente NO tocado
- **Contenedor del código QR** (`background:'#FFFFFF'`): blanco **requerido para escaneabilidad** →
  se mantiene en ambos temas (correcto, igual que Superadmin B4C).
- **HTML de exportación** (string `<!DOCTYPE html>…` para imprimir/descargar Clientes/Reportes:
  `th{background:#1D1D1F}`, zebra `#fff/#f9f9f9`, `.vip`, etc.): documento exportado, **siempre claro**.
  Usa CSS sin comillas, así que ningún `replace_all` lo tocó (verificado).
- **Colores semánticos saturados** (`C.green/orange/red`, dots de tipo de evento `CAL_TYPES`,
  fallbacks grises `||'#6E6E73'`/`||'#8E8E93'` de `roleColor/srCol/CANAL_COLOR/tipoColor`, dots de
  `ZONAS_DEF`, picker de zona) y `#fff` de texto sobre fondos de color/`C.ink` → legibles en dark.
- **Chips/cajas decorativas always-dark** (`#102a10`/`#2a1010` chip de disponibilidad, `#1a0a0a`/
  `#160808`/`#1a1200`/`#0a1a0a`/`#0a1a12` cajas de consola/alerta/preview WhatsApp): ya oscuras en
  ambos temas (diseño previo) → no se degradan en light, funcionan en dark.
- **Alpha tints** (`#FFD58022`, `rgba(...)`): overlays translúcidos que funcionan sobre dark.
- **`C_DARK.bg = '#000000'`**: definición de paleta (negro puro). Polish opcional (igual que
  Gerente/Superadmin); buen contraste con cards `#1C1C1E/#2C2C2E`.

## 3) Checklist visual light / dark (Admin)

| Elemento | Light | Dark | Mecanismo |
|---|---|---|---|
| Fondo / sidebar / nav | ✅ | ✅ | shell tokens + `C` |
| Cards (`.my-card` / `C.surface`) | ✅ | ✅ | tokens / `C` |
| **Metric cards (Opción A neutra)** | ✅ | ✅ | `.my-metric-card`; valor accent vía `C` |
| Botones (`.my-btn` + primario `C.ink`) | ✅ | ✅ | tokens / `C.ink`/`C.surface` |
| Inputs / selects | ✅ | ✅ | shell tokens + select `C.surface` |
| Tablas / zebra / hovers | ✅ | ✅ | `C.surface` / `var(--bg-subtle)` / `var(--surface-hover)` |
| Separadores de fila | ✅ | ✅ | `C.border` |
| Modales | ✅ | ✅ | `C.bg` + `C.bs` |
| Badges / pills / estados | ✅ | ✅ | `TINT.*` (color-mix adaptativo) |
| Toasts (ok/error) | ✅ | ✅ | `TINT.green*/red*` |
| Toggles / FilterBtn / chips / icon-picker | ✅ | ✅ | `C.ink`/`C.surface` |
| Calendario (sel/hoy + dots) | ✅ | ✅ | `C.ink`/`TINT.blue*`/`C.blue`; dots saturados |
| Mapa de mesas (zona/estado de mesa) | ✅ | ✅ | `TINT.*` + `C.*` |
| Alertas dashboard / `levelStyle` | ✅ | ✅ | `TINT.red/amber/blue/green` |
| Chat soporte (burbujas) | ✅ | ✅ | `C.ink`/`C.surface` |
| Texto secundario | ✅ | ✅ | `C.mid/dim` |

- **Sin textos invisibles** (0 `color:'#000/#1D1D1F/...'` frozen en JSX; bug `RESTAURANT ID` corregido).
- **Sin cards/pills blancas sobre fondo oscuro** (scan final: solo el QR blanco intencional + paleta).
- **Sin contraste invertido** (negros/blancos → `C.ink/surface`). **Sin chart roto** (no hay charts hex
  problemáticos en Admin; el reporte usa header `C.ink/surface`).

## 4) Hex restantes (148) — todos intencionales
Paletas `C_LIGHT`/`C_DARK` (~30), strings `TINT` (solo `#5856D6` ×3 púrpura), HTML de exportación
(~15), valores saturados de mapas (`roleColor`/`srCol`/`CANAL_COLOR`/`CAL_TYPES`/`tipoColor`/
`quejaCols`/dots `ZONAS_DEF`/picker de zona), chips/cajas always-dark, alpha tints, QR blanco, dot de
estado gris.

## 5) Hallazgos funcionales (NO corregidos en este PR — visual/dark-only)
- **No se observaron** errores `42501`/`PGRST116`/RLS durante la edición (PR estático, sin tocar
  queries/RPC/endpoints). Si aparecen en QA runtime, se documentan aparte como hallazgo funcional,
  **no** se arreglan aquí (instrucción del arquitecto).
- Nota de modelo (no-bug): el contrato dual de `restaurant_settings` (key/value en cocina vs columnar
  en admin) y deudas previas siguen igual; fuera de alcance de B4D.

## 6) Pendiente para otros paneles (NO tocados)
Caja, Cocina, Mozo, Delivery (rider/cliente), Login → **siguen pineados**; cada uno en su PR (B4E/B4F).
**Gerente** (B4B) y **Superadmin** (B4C) **no se tocaron**. **QR/menu (index): EXCLUIDO** (branding por
`mood`).

## 7) Riesgos visuales
- **Acotado a Admin.** Light prácticamente idéntico (los neutros claros mapean a `var(--bg-subtle)`
  ≈ `#F5F5F7`; microvariación de hue en tints por `color-mix`; zona "exterior" amarillo→ámbar es el
  único cambio de hue perceptible y menor). Dark construido sobre `C` + `TINT` + `.my-*` + tokens, con
  los literales de contraste cubiertos (scan final limpio). Reversible. Sin riesgo de layout/lógica.
- Por el volumen, conviene **spot-check visual en QA** de vistas data-gated (mapa de mesas con datos,
  calendario, reportes con filas, chat con hilos, alertas del dashboard).

## 8) Build
- `npm run build`: **PASS — 9/9** (`built in` ×9, `admin.js` 585.29 kB, sin errores).

## Confirmación de no-alcance
`git diff --name-only main` ⇒ **`public/admin.html` + `src/admin/main.jsx`** (+ este doc). Sin cambios
en `mythos-theme.js`, `tokens.css`, `ui-primitives.css`, otros paneles, `src/index/main.jsx`,
`public/index.html`, `public/build/*`. No se tocó: Auth/backend/Supabase/DB/RLS/RPC/migraciones/datos/
teardown/permisos/lógica/API/flujos/handlers/condiciones de render/queries/payloads. Solo el handler
visual del toggle (preexistente) gobierna el tema. **QR/menu intacto y excluido. Gerente y Superadmin
no tocados. Ningún otro panel activado.**
