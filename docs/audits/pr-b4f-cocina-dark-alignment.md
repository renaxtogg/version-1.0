# PR-B4F — Cocina dark alignment

> FASE B (UI/UX + dark global). Alineación de Cocina (KDS) con la infraestructura global.
> Fecha: 2026-06-18 · Rama: `fix/pr-b4f-cocina-dark-alignment` · Base: `main = f87e45c`.
> Frontend/visual. NO toca lógica KDS, estados de órdenes, timers, queries ni flujos.

## 1) Decisión de arquitectura: Cocina se MANTIENE dark-pinned

**Decisión: mantener `MythosTheme.init('dark')` (NO cambiar a `init()`).**

Cocina es un **KDS operativo** (display de cocina): por convención y operatividad debe ser **oscuro
por diseño** (legibilidad a distancia, menos glare, los colores de estado "saltan" sobre fondo negro).
Cambiar a `init()` haría que Cocina siguiera la preferencia global → en un dispositivo sin preferencia
o con sistema en claro, el KDS arrancaría **claro**, lo cual es indeseable operativamente.

**Cómo participa igual de MythosTheme (alineación):**
- Carga `design-system.css` → `tokens.css` → `ui-primitives.css` → `mythos-theme.js` (igual que el resto).
- El shell usa variables de token (`var(--bg)`, `var(--text-primary)`, etc.).
- Su objeto `C` deriva de `PALETTES` y **ya tiene variantes light Y dark**, y **reacciona a
  `mythos:themechange`** (`Object.assign(C, …)` + re-render).
- **Ya tenía un toggle sun/moon wireado** (`MythosTheme.toggle()`), pre-existente. Se **valida que no
  rompe** (la paleta light existe y `C` adapta) y se **conserva como escape opcional**, pero **no es el
  modo operativo**. No se agregó ni se quitó ningún toggle.

Resultado: Cocina participa del sistema de tema global, pero **por defecto es dark** (excepción
deliberada y documentada, coherente con "dark global" — es el panel siempre-oscuro).

## 2) Cambios aplicados (mínimos, solo color/alineación)

**Shell (`public/cocina.html`):**
- Comentario que documenta la decisión dark-pinned.
- Spinner `.spin` `#38383A`/`#F5F5F7` → `var(--border)`/`var(--text-primary)` (idéntico en dark;
  alinea el shell con el sistema de tokens).
- **`init('dark')` se MANTIENE.**

**Componente (`src/cocina/main.jsx`) — 2 ediciones color-only:**
- Badge de conteo en filtro/tab y botón **"Guardar"**: `color:'#000'` → `color:C.bg`. Ambos están
  pareados con `background:C.white` (token **reactivo**); `#000` fijo era una inconsistencia: en dark
  (operativo) `C.white`=`#F5F5F7` → negro legible (idéntico), pero si se usa el toggle a light
  `C.white`=`#1D1D1F` → el negro quedaba invisible. `C.bg` completa el par (negro en dark, blanco en
  light) → **sin texto invisible en ningún tema**. Identidad visual del dark operativo intacta.

## 3) Deliberadamente NO tocado (preservar el dark nativo)
- **Colores de estado/KDS saturados** (`#FF9500`/`#FF3B30`/`#34C759`/`#22C55E`/`#16A34A`/`#FFD60A`/
  `#5AC8FA`/`#60a5fa`/`#fb923c`/`#f87171`/`#c084fc`/`#f9a8d4`/`#4ade80`/`#6b7280`/`#FBBF24`/`#FCA5A5`/
  `#DC2626`/`#A1A1A6`/`#888`): color-coding de columnas/estados/timers/categorías/alertas. Son la
  esencia del KDS y funcionan sobre fondo oscuro. **No tocar** (también: "no tocar estados de pedidos").
- **`color:'#000'` sobre fondos saturados** (botones de acción `st.color`/`col`): negro sobre color
  brillante = legible en ambos temas. Se mantienen.
- **Neutros dark-context** (`#333`/`#222` bordes, `#e0e0e0`/`#888` texto, `#111` en comentario): son
  valores afinados para el KDS oscuro. Tocarlos = sweep del panel dark-nativo (prohibido) y arriesga
  degradar el dark. **Se mantienen** (correctos en el modo operativo dark).
- **Animaciones** `blink`/`greenFlash` (`#FF3B30`/rgba verde): alertas de tarjeta crítica. Semánticas.
- **PALETTES light/dark, listener, toggle**: intactos.

## 4) Checklist visual (Cocina — modo operativo dark)

| Elemento | Dark (operativo) | Mecanismo |
|---|---|---|
| Fondo / KDS | ✅ | `var(--bg)` (#000) + `C` |
| Cards / columnas / kanban | ✅ | `C.surface`/`C.card`/`C.border` |
| Estados de pedidos | ✅ | color-coding saturado (intacto) |
| Botones de estado | ✅ | bg saturado + texto `#000`/`C.bg` |
| Timers / tiempos | ✅ | escala `#22C55E`→`#FF9500`→`#FF3B30` |
| Alertas (crítico/blink) | ✅ | `#FF3B30` + animación |
| Filtros / tabs | ✅ | `C` + badge `C.bg`/`C.white` (fix) |
| Stats / distribución | ✅ | colores semánticos |
| Botón "Guardar" (modal) | ✅ | `C.white` bg + `C.bg` texto (fix) |
| Texto secundario | ✅ | `C.mid`/`#888` |

- **Sin textos invisibles** en el modo operativo dark (los 2 casos `C.white`+`#000` corregidos también
  blindan el toggle a light).
- **Sin cards blancas raras** (cards usan `C.surface`/`C.card` dark).
- **Sin botones con contraste incorrecto**.
- **Dark nativo NO degradado**: los 2 fixes son idénticos en dark; nada más del componente cambió.

## 5) Superficies data-gated / pendientes de QA
- **KDS con órdenes reales** (columnas pobladas, timers corriendo, tarjeta crítica/blink, despacho por
  estación): validar visualmente en QA (no se tocó lógica KDS/estados/timers).
- **Toggle a light (no operativo):** la paleta light existe y `C` adapta; los 2 fixes blindan los
  casos `C.white`+`#000`. Un pulido completo de Cocina en light **NO** es objetivo de B4F (sería un
  sweep del panel dark-nativo); los neutros dark-context (`#e0e0e0`/`#333`/`#888`) no están optimizados
  para light. Documentado como límite conocido; light no es el modo operativo del KDS.

## 6) Hallazgos funcionales (NO corregidos — visual/dark-only)
- **No se observaron** errores `42501`/`PGRST116`/RLS durante la edición (PR estático, sin tocar
  queries/RPC/endpoints). Si aparecen en QA runtime → documentar aparte, **no** arreglar aquí.
- Observación (no-bug): inconsistencia `C.white`+`#000` en 2 elementos — corregida como parte de la
  alineación (color-only, sin lógica).

## 7) Pendiente para otros paneles (NO tocados)
Mozo, Delivery (rider/cliente), Login → **siguen pineados**; cada uno en su PR. **Gerente (B4B),
Superadmin (B4C), Admin (B4D), Caja (B4E)** **no se tocaron**. **QR/menu (index): EXCLUIDO**.

## 8) Riesgos visuales
- **Mínimos / acotados a Cocina.** Decisión = mantener dark (sin cambio de modo). Solo 2 ediciones de
  color (idénticas en dark) + tokenización del spinner. Reversible. Sin riesgo de KDS/lógica.

## 9) Build
- `npm run build`: **PASS — 9/9** (`built in` ×9, `cocina.js` 200.85 kB, sin errores).

## Confirmación de no-alcance
`git diff --name-only main` ⇒ **`public/cocina.html` + `src/cocina/main.jsx`** (+ este doc). Sin
cambios en `mythos-theme.js`, `tokens.css`, `ui-primitives.css`, otros paneles, `src/index/main.jsx`,
`public/index.html`, `public/build/*`. No se tocó: Auth/backend/Supabase/DB/RLS/RPC/migraciones/datos/
teardown/permisos/lógica KDS/estados de pedidos/timers/ordenamiento/API/flujos/handlers/condiciones de
render/queries/payloads. `init('dark')` se mantiene; toggle/listener/PALETTES preexistentes intactos.
**QR/menu intacto y excluido. Gerente/Superadmin/Admin/Caja no tocados. Ningún otro panel activado.**
