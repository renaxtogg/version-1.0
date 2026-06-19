# FASE C / WS4 — Consistencia visual light/dark (auditoría + polish)

> **Estado:** WS4-A (QA visual global) = ✅ PASS con follow-ups P2/P3.
> WS4-B (este doc) = fixes visuales mínimos aplicados. Frontend only — sin lógica, datos, Auth, RLS ni DB.
> **Rama:** `fix/fase-c-ws4-visual-polish` (base `main` @ `11dbab0`).

---

## 1. Resumen QA WS4-A (insumo)

QA real (Claude-en-Chrome, prod `mythos-pos.vercel.app` @ `11dbab0`, Parrilla Don Carlos / Enterprise, datos reales de seed) recorrió los 11 paneles en **light y dark** con toggle `MythosTheme.set()` + auditor de contraste WCAG + screenshot como fuente de verdad.

**Veredicto global: ✅ PASS.** Theming consistente y legible en todos los paneles. **0 P0, 0 P1.** Light no degradado, dark no degradado, fronteras de branding (QR / Delivery cliente quedan light) respetadas. Hallazgos = pulido:

| Sev | # | Hallazgo |
|---|---|---|
| P2 | 1 | **Cliente QR (`index.html`)** — iniciales "DC" del avatar gris-oscuro `#1D1D1F` sobre círculo negro `#000000` → contraste 1.25 (casi invisible). El mismo avatar en delivery-cliente sí es blanco-sobre-negro. |
| P2 | 2 | **Superadmin (light)** — labels "Links rápidos" del sidebar en `#AEAEB2` sobre blanco → contraste 2.21 (sub-AA). |
| P3 | 1 | **Login footer** "Mythos · Sistema gastronómico" — contraste 1.86 (dark) / 2.21 (light). |
| P3 | 2 | **Mozo (dark)** — dot "Ocupada" de la leyenda invisible (negro sobre oscuro). |
| P3 | 3 | **Texto secundario/helper (sistémico, light)** — token `#86868B` sobre blanco → 3.62 (apenas sub-AA). |
| P3 | 4 | **Métricas en color de acento sobre blanco** — verde/naranja grandes, sub-AA pero legibles por tamaño/peso. |
| P3 | 5 | **Superadmin** — barra del chart MRR = bloque negro sólido en light / claro en dark (pesado, no usa color de marca). |
| P3 | 6 | **Superadmin (dark)** — captions 10px "Salud del sistema" tenues. |
| P3 | 7 | **Caja (dark)** — "Editar mesas" secundario tenue. |

Data-gated (no bloquea, no evaluable sin datos): floor-plan posicionado de Caja/Mozo (mesas sin posición en prod), cards operativas del rider sin pedidos. Emojis → WS5. Consola/red → WS6.

---

## 2. Fixes aplicados en WS4-B

Criterio: **mínimo, sin rediseño, sin tocar layout/lógica**. Se prefiere **token CSS** (`var(--…)` de `public/tokens.css`) que resuelve por-paint según `data-theme` — más robusto que los objetos JS de paleta (`C`/`T`) que se mutan en `mythos:themechange` y pueden quedar desincronizados con el render.

| # | Hallazgo | Archivo | Antes | Después |
|---|---|---|---|---|
| 1 (P2) | Avatar QR iniciales ilegibles | `src/index/main.jsx` (~L457) | `color: T.hdrText` (casi-negro en variante light) sobre círculo `T.black` | `color: T.white` (`#FFF` en las 3 variantes) — espeja delivery-cliente |
| 2 (P2) | Links rápidos superadmin tenues | `src/superadmin/main.jsx` (~L3668-3672) | header + links en `C.mid` (objeto mutado; QA midió el mid **dark** `#AEAEB2` sobre fondo claro) | `var(--text-secondary)` (#6E6E73 light = AA / #AEAEB2 dark); hover → `var(--text-primary)` |
| 3 (P3) | Login footer poco legible | `public/login.html` (`.hint`) | `color: var(--text-disabled)` (#AEAEB2 light / #48484A dark) | `color: var(--text-tertiary)` (#86868B light / #8E8E93 dark) — un escalón |
| 4 (P3) | Mozo dot "Ocupada" invisible en dark | `src/mozo/main.jsx` (~L1950) | `#000000` sólido | `var(--text-primary)` (#1D1D1F light ≈ igual / #F5F5F7 dark = visible) |
| 5 (P3) | Chart MRR superadmin = bloque negro/blanco | `src/superadmin/main.jsx` (~L453, `MRRChart`) | `background: C.ink` (negro en light / blanco en dark) | `background: var(--info)` (#007AFF light / #0A84FF dark) — acento de datos theme-adaptive |

### Antes / después esperado (visual)
- **QR avatar:** "DC" pasa de gris-oscuro-sobre-negro (invisible) a **blanco sobre negro** (legible), igual que en delivery-cliente. Sin cambio de branding ni layout.
- **Superadmin Links rápidos (light):** labels pasan de gris muy claro (2.21) a **#6E6E73 (AA, 4.54)**; en dark quedan legibles (#AEAEB2 sobre sidebar #1C1C1E). Hover oscurece/aclara a primario.
- **Login footer:** un escalón más legible en ambos temas, sigue de-enfatizado.
- **Mozo dot "Ocupada":** en light prácticamente idéntico (negro-marca), en **dark ahora se ve** (dot casi-blanco). El resto de la leyenda sin cambios.
- **Chart MRR:** las barras dejan de ser un bloque negro pesado (light) / blanco (dark) y pasan a **azul de acento** en ambos temas; el número sobre la barra queda en texto primario.

---

## 3. Fix descartado (y por qué)

- **P3-3 sistémico (token `#86868B` → `#6E6E73`):** **NO se tocó.** En `tokens.css` ese valor es `--text-tertiary` (light) y además está aliaseado como `--text-muted`. Bajarlo afecta **a los 9 paneles en ambos temas** (todo el helper/caption text del sistema) — exactamente el caso "afecta demasiado globalmente" que la propia spec pide **documentar y NO tocar**. Queda como decisión de diseño global futura (revisar AA de helper text de forma deliberada y con QA dedicada), no como polish de WS4-B.
- **P3-4/6/7 (métricas de acento sub-AA, captions 10px superadmin dark, "Editar mesas" caja dark):** no incluidos — son tenues pero legibles (tamaño/peso), de bajo impacto, y tocarlos uno a uno excede "mínimo". Quedan anotados para un pase de contraste sistémico si se decide subir tokens globalmente.

---

## 4. No tocado en WS4-B (fuera de alcance)

Emojis (WS5) · consola/red (WS6) · floor-plan posicionado data-gated · Auth · Maps · Bancard · facturación · cualquier cambio funcional o de datos.

---

## 5. Build

`npm run build` → **PASS** (9/9, exit 0). Recompilados: `index.js`, `mozo.js`, `superadmin.js`. `login.html` es estático (no Vite) — no requiere build. `public/build/` está gitignored (Vercel compila desde `src/` en cada deploy).

---

## 6. Checklist de re-QA puntual

Solo verificar lo tocado, en **light y dark** (salvo lo customer-facing, que queda light):

1. **QR (`index.html`) — Don Carlos:** las iniciales del avatar ("DC") se leen **blancas sobre el círculo negro**. Sin cambio de branding/layout.
2. **Superadmin (light) — `qa.superadmin`:** los labels de "Links rápidos" del sidebar se leen sin esfuerzo; hover los oscurece. Verificar también en **dark** que siguen legibles.
3. **Login — footer:** "Mythos · Sistema gastronómico" un poco más legible en light **y** dark (sigue sutil).
4. **Mozo (dark):** el dot "Ocupada" de la leyenda **se ve** (casi-blanco); el resto de la leyenda intacto. En **light** el dot sigue negro como antes.
5. **Superadmin — chart "Crecimiento MRR":** las barras son **azules** (acento) en vez de bloque negro/blanco, en ambos temas; el monto sobre la barra sigue legible.
6. **Sin regresión visual evidente** en ningún panel light/dark (los cambios son puntuales y aislados).
