# PR-B3I.5 — Operational / mobile / POS polish

> FASE B (UI/UX unificado + dark mode). Quinto PR de implementación tras la auditoría PR-B3I.
> Fecha: 2026-06-17 · Rama: `fix/pr-b3i-5-operational-pos-polish` · Base: `main = 0f06d42`.
> Frontend/visual. NO toca lógica, permisos, datos, flujos, handlers ni condiciones de render.

## Objetivo

Pulir superficies operativas reales (Superadmin/Caja/Cocina/Mozo/Delivery) de forma **visual-only**,
con prioridad #1 en el **bug visual MRR negro** de Superadmin.

## Lo que se corrigió — Superadmin (prioridad #1)

**Bug "MRR negro" confirmado y corregido.** El chart de MRR (`MRRChart`, dashboard) dibujaba sus
barras con `background:'#000000'` (negro **puro**) hardcodeado, mientras que **todos los demás
charts del panel** (HBars, TrendArea, SemiGauge, DonutChart) usan `C.ink` (el near-black de marca,
`#1D1D1F` en light / `#F5F5F7` en dark, **reactivo al tema**). La propia etiqueta de valor encima de
cada barra ya usaba `C.ink` → la barra era la única pieza inconsistente.

| Línea | Antes | Después | Efecto |
|---|---|---|---|
| `MRRChart` barra | `background:'#000000'` | `background:C.ink` | barras coherentes con el resto de charts; **visibles en dark** (antes, negro puro = invisible sobre fondo oscuro) |
| `PALETTES.light.blue` | `blue:'#000000'` | `blue:'#1D1D1F'` | quita el negro puro off-brand del único color que el arquitecto nombró; usado en 1 lugar (stat "Eventos este mes" del calendario). Dark ya era `#F5F5F7` |

Ambos son **literales de color en estilos inline** (visual-only): no se tocó ningún handler,
condición, dato, prop funcional ni el flujo. `C.ink` ya estaba en uso en `MRRChart` (la etiqueta),
así que el cambio es 1:1 con el lenguaje visual existente.

## Lo que quedó FUERA de alcance (documentado, no forzado)

La inspección de los paneles operativos encontró que su falta de coherencia visual es **sistémica**
(no aislada), y arreglarla viola las prohibiciones de este PR. Conteo de negros puros (`#000`/`#000000`)
usados como acento de marca en lugar del near-black `#1D1D1F`:

| Panel | `#000` / `#000000` | Por qué NO se tocó aquí |
|---|---|---|
| **Caja** | 36 / 26 | Sweep masivo = "cambios masivos no verificables" (prohibido). Varios están en botones de **cobro/operación crítica** (modal PIN, cancelación) → **prohibido tocar cobro**. |
| **Cocina** | 5 / 1 | Panel **pineado `dark`** (KDS por diseño). "No parecer otro producto" = unificar su tema → decisión de **dark global (PR-B4)**, no un fix visual pequeño. KDS/estados no se tocan. |
| **Mozo** | 10 / 7 | Acentos de marca + dot semántico "Ocupada" (su color debe **coincidir** con el indicador real de mesa → cambiarlo arriesga desincronizar la leyenda). Cards `.item-card` data-gated. |
| **Delivery rider** | 9 / 0 | Todos son **botones de acción del rider** (login, iniciar ruta, navegar) → operativos. |
| **Delivery cliente** | 1 / 2 | Cards/estados data-gated; superficie de cliente. |

**Criterio aplicado:** "No hacer cambios masivos no verificables", "No tocar cobro real de Caja",
"No tocar acciones KDS funcionales", "No cambiar handlers/condiciones". Convertir estos negros a
near-black de marca es deseable pero corresponde a una **migración de panel dedicada con QA visual**
(toca JSX operativo / requiere datos para validar), no a este PR visual-mínimo.

### Por panel (prioridades 2–5)

- **Caja (P2):** reducir densidad/mezcla = ajustar padding/markup de cards inline densas → reflow +
  riesgo de tocar superficies de cobro. **Diferido a migración con QA.**
- **Cocina (P3):** su "otro producto" = el pin `dark`. Alinearlo = **PR-B4 (dark global)**. KDS intacto.
- **Mozo (P4):** `.item-card` y cards son data-gated (requieren pedidos/mesas para verificar) +
  el negro de "Ocupada" es semántico. **Diferido.**
- **Delivery rider/cliente (P5):** cards/badges data-gated; los negros son botones de acción.
  **Diferido.**

## Superficies data-gated NO verificadas

MRR chart (requiere `subscriptions` con datos para ver barras con altura real — el fix de color es
verificable sin datos, pero el render completo del chart no se validó con datos de simulación).
Cards/estados de Caja/Mozo/Delivery/Cocina requieren datos operativos (pedidos, mesas, rutas) para
QA visual → **pendiente de QA en prod/simulacro**.

## Diag

**No incluido** (no-op). Sigue siendo la consola dev dark standalone; alinearla no es un ajuste
visual mínimo seguro (ver PR-B3H). Branding "Mesa App" → "Mythos" sigue como follow-up de copy.

## Riesgos visuales

- **Mínimo y reversible.** El cambio toca solo Superadmin: barras MRR y un stat de calendario pasan
  de negro puro a near-black de marca (reactivo al tema). Sin riesgo de layout, lógica ni datos.
- Beneficio extra: el chart MRR ahora es **visible en dark** (antes invisible).

## Build

- `npm run build`: **PASS — 9/9** paneles (`built in` ×9, sin errores).
- `npm run typecheck`: no existe (JS/JSX puro).

## Confirmación de no-alcance

`git diff --name-only main` ⇒ **solo `src/superadmin/main.jsx`** (+ este doc al commitear). Sin
cambios en `public/build/*` (gitignored), tokens.css/ui-primitives.css, otros paneles, ni en
handlers/condiciones/queries/RPC/endpoints/payloads. No se tocó: **Auth / backend / Supabase /
DB / RLS / RPC / migraciones / datos / teardown / permisos / lógica / API / flujos**. **Cobro de
Caja intacto. Acciones KDS intactas. Dark global NO activado. Index/QR NO tokenizado.**
