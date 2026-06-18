# PR-B3I — Auditoría visual global y plan de polish (Apple-like)

> FASE B (UI/UX unificado + dark mode). **Auditoría + plan, SIN implementar rediseño.**
> Fecha: 2026-06-17 · Rama: `audit/pr-b3i-global-visual-polish` · Base: `main = 9eef1fa`.
> Objetivo: identificar qué falta para que TODOS los paneles se vean parejos, modernos, premium,
> tipo iOS/Apple-like y vendibles, tomando el **menú QR / cliente (`index`)** como referencia.

---

## A. Estado general

**¿Estamos visualmente parejos de verdad? → PARCIAL.**

PR-B3 (A→H) logró **alineación técnica de color**: casi todos los paneles consumen los tokens
(directo vía `.my-*`, o vía token bridge), cargan la misma cascada (`design-system.css` →
`tokens.css` → `ui-primitives.css` → `mythos-theme.js`) y están pineados `light` (excepto Cocina
`dark`). Eso resolvió **consistencia de paleta** y **dark-readiness de color**.

**Pero "parejo de color" ≠ "premium y uniforme".** La métrica dura lo confirma: el sistema tiene
escalas de **radio, tipografía y espaciado** en `tokens.css`, pero **los estilos inline de los
paneles NO las consumen** — usan valores arbitrarios fuera de escala. Medición en `src/*/main.jsx`:

- **Radios:** ~19 valores distintos en uso. El más frecuente es **`8px` (289 usos)**, que **no
  existe** en la escala de tokens (`--radius-sm:6 / md:10 / lg:14 / xl:20 / full:999`). También
  abundan `12`(94), `7`(53), `5`(51), `9`(29), `3`, `11`, `13`, `16`, `18`… → **radios inconsistentes**.
- **Tipografía:** ~25 tamaños distintos. Dominan `11/13/12/10` (cercanos a `--text-xs/sm`), pero
  hay mucho off-scale: `12, 16, 22, 18, 26, 36, 48, 44, 54, 52, 40, 19, 9, 8, 7`… La escala de
  tokens (`xs11/sm13/base15/md17/lg20/xl24/2xl28/3xl34`) **casi no se usa por nombre**.
- **Sombras:** uso desigual — Gerente y Delivery-rider **0** (planos), Index/Admin/Caja **10**
  (pesadas), Delivery-cliente 7, Cocina/Mozo 3. No hay una "voz" de sombra única.
- **Espaciado:** padding/gap mayormente en múltiplos de 4 pero **no via `--space-*`**; conviven
  `padding:'14px 16px'`, `'12px 14px'`, `'10px 12px'`, etc. → ritmo desigual entre paneles.

**Tres mecanismos de theming conviven** (correctos, pero distintos): (1) `.my-*` (Gerente, Admin,
Superadmin, Caja, Cocina-stats); (2) **token bridge** (Mozo `:root`, Delivery inline, Login); (3)
**paleta JS** `C`/`C_LIGHT`/`C_DARK` (Admin, Caja, Superadmin, Cocina) que corre **en paralelo** a
los tokens. Esa coexistencia es la principal fuente de "se siente distinto".

**El panel de referencia (`index`/cliente QR) NO está tokenizado:** carga la cascada y se ve
premium, pero su JSX usa **175 hex hardcodeados, 0 `var(--)`, 0 `.my-*`**. Su "premium" viene de un
inline cuidado (espaciado, radios suaves, jerarquía), no del sistema. → Igualar a `index` significa
**replicar su pulido** (ritmo/sombras/tipografía), no copiar tokens.

### Paneles más cercanos al objetivo
1. **Index (cliente QR)** — referencia; el más pulido (pero por inline propio).
2. **Gerente** — el más limpio del lado staff: `.my-card`/`.my-metric-card`/`.my-btn` puros, casi
   sin hardcode (111 hex, casi todos semánticos). El "después" deseado del resto.
3. **Delivery rider/cliente** — móvil branded, token bridge, ya bastante "app-like".

### Paneles más lejos del objetivo
1. **Admin** — el más divergente: **694 hex**, paleta JS densa, dashboards con densidad alta,
   tarjetas inline tintadas históricas, muchos radios/tipos off-scale. "Parece otro producto".
2. **Caja** — **355 hex**, paleta JS + sistema de impresión 80mm; denso, utilitario.
3. **Superadmin** — 225 hex, chart MRR con barra negra (`blue:'#000000'`), tablas densas.
4. **Cocina** — único `dark` pineado; KDS especializado (correcto que difiera, pero rompe la
   sensación "mismo producto" si se ve al lado de los demás).
5. **Diag** — consola dev dark; no es superficie de venta (aceptable que difiera).

---

## B. Matriz por panel

Leyenda: ✅ alineado · 🟡 parcial/mejorable · 🔴 divergente · N/A.

### Login
| Dim | Estado | Nota |
|---|---|---|
| Tipografía | 🟡 | tamaños propios (32/15/13), no escala token |
| Fondo | ✅ | `var(--bg-subtle)` |
| Cards | ✅ | card única tokenizada (radio 20) |
| Botones | ✅ | `var(--primary)`/`var(--on-primary)` |
| KPIs | N/A | — |
| Sidebar/nav | N/A | — |
| Inputs | 🟡 | tokenizados color, radio 10 propio |
| Estados vacíos | N/A | — |
| Responsive | ✅ | centrado simple |
| Premium/iOS | 🟡 | limpio pero plano; radio card 20 vs resto |
| Riesgo dark | 🟡 | sin `theme.js`; falta activar (PR-B4) |

### Gerente
| Dim | Estado | Nota |
|---|---|---|
| Tipografía | 🟡 | vía componentes, algunos tamaños inline |
| Fondo | ✅ | tokens |
| Cards | ✅ | `.my-card` |
| Botones | ✅ | `.my-btn` (+variantes) |
| KPIs | ✅ | `.my-metric-card` |
| Sidebar/nav | 🟡 | propio, no primitiva nav |
| Inputs | 🟡 | inline, no primitiva form |
| Estados vacíos | 🟡 | simples |
| Responsive | ✅ | ok |
| Premium/iOS | ✅ | el más cercano del staff |
| Riesgo dark | 🟢 | bajo (consume tokens) |

### Admin
| Dim | Estado | Nota |
|---|---|---|
| Tipografía | 🔴 | mucha variación off-scale |
| Fondo | 🟡 | `C_LIGHT.bg`→token, resto paleta JS |
| Cards | 🔴 | mayoría inline (no hay `Card` compartido); 8 KPI dashboard ya `.my-metric-card` |
| Botones | 🟡 | `<Btn>`→`.my-btn`, pero 116 `<button>` crudos (tabs/toggles) |
| KPIs | ✅ | `.my-metric-card` (21) |
| Sidebar/nav | 🟡 | propio |
| Inputs | 🔴 | inline, paleta JS |
| Estados vacíos | 🟡 | desiguales |
| Responsive | 🟡 | denso |
| Premium/iOS | 🔴 | denso, "otro producto" |
| Riesgo dark | 🔴 | paleta JS `C_DARK` paralela + 694 hex |

### Superadmin
| Dim | Estado | Nota |
|---|---|---|
| Tipografía | 🔴 | variada |
| Fondo | 🟡 | `C_LIGHT.bg`→token, resto JS |
| Cards | ✅ | `SectionCard`→`.my-card` |
| Botones | ✅ | `Btn`→`.my-btn` (39) |
| KPIs | ✅ | `Kpi`→`.my-metric-card` (12) |
| Sidebar/nav | 🟡 | propio |
| Inputs | 🟡 | Th/Td/Filter inline |
| Estados vacíos | 🟡 | tablas densas |
| Responsive | 🟡 | sidebar no colapsa angosto |
| Premium/iOS | 🟡 | mejor que Admin, chart MRR roto |
| Riesgo dark | 🔴 | paleta JS + `blue:'#000000'` (MRR negro) |

### Caja
| Dim | Estado | Nota |
|---|---|---|
| Tipografía | 🔴 | mono+sans mezclados, variada |
| Fondo | 🟡 | paleta JS (light/dark) |
| Cards | 🔴 | inline (no `Card` compartido) |
| Botones | ✅ | `Btn`→`.my-btn` (41) |
| KPIs | ✅ | `KpiMini`→`.my-metric-card` (10) |
| Sidebar/nav | 🟡 | propio |
| Inputs | 🟡 | inline |
| Estados vacíos | 🟡 | utilitarios |
| Responsive | 🟡 | pensado tablet/POS |
| Premium/iOS | 🔴 | utilitario; sistema de impresión 80mm aparte |
| Riesgo dark | 🟡 | YA dark-capable (`C_DARK`), pero paralelo a tokens |

### Cocina
| Dim | Estado | Nota |
|---|---|---|
| Tipografía | 🟡 | KDS densa, mono |
| Fondo | ✅ | `dark` nativo (correcto para KDS) |
| Cards | 🟡 | tickets especializados (borde=urgencia); StatsPanel→`.my-card` |
| Botones | 🟡 | toggles/acciones KDS (blanco/negro) |
| KPIs | ✅ | StatsPanel→`.my-metric-card` |
| Sidebar/nav | N/A | toolbar |
| Inputs | 🟡 | config drawer |
| Estados vacíos | 🟡 | columnas vacías |
| Responsive | ✅ | pantallas amplias |
| Premium/iOS | 🟡 | coherente como KDS, pero rompe "mismo producto" si se compara |
| Riesgo dark | 🟢 | ya dark, reactivo |

### Mozo
| Dim | Estado | Nota |
|---|---|---|
| Tipografía | 🟡 | clases propias |
| Fondo | ✅ | token bridge `:root` |
| Cards | 🟡 | `.item-card`/`.alert-card`/`.featured-card` propias (no `.my-card`, por decisión) |
| Botones | 🟡 | `.btn` propio (dark-ready, token bridge) — no `.my-btn` |
| KPIs | 🟡 | `.turno-stat` fila (≠ `.my-metric-card`) |
| Sidebar/nav | ✅ | bottom-nav móvil coherente |
| Inputs | 🟡 | propios |
| Estados vacíos | 🟡 | ok |
| Responsive | ✅ | mobile-first |
| Premium/iOS | 🟡 | coherente consigo mismo; clases ≠ resto |
| Riesgo dark | 🟢 | bajo (bridge a tokens) |

### Delivery rider
| Dim | Estado | Nota |
|---|---|---|
| Tipografía | 🟡 | inline, app-like |
| Fondo | ✅ | bridge; frame simulador |
| Cards | 🟡 | inline (bridge neutrales) |
| Botones | 🟡 | inline bespoke (naranja ruta, etc.) |
| KPIs | 🟡 | stats inline |
| Sidebar/nav | N/A | pantallas |
| Inputs | 🟡 | login propio |
| Estados vacíos | 🟡 | data-gated |
| Responsive | ✅ | phone-frame |
| Premium/iOS | 🟡 | ya "app", neutrales bridgeados |
| Riesgo dark | 🟡 | neutrales bridgeados; marca/semánticos hardcode |

### Delivery cliente
| Dim | Estado | Nota |
|---|---|---|
| Tipografía | 🟡 | branded, inline |
| Fondo | ✅ | bridge parcial; frame |
| Cards | 🟡 | `ProdCard` + pantallas branded |
| Botones | 🟡 | inline branded |
| KPIs | N/A | — |
| Sidebar/nav | N/A | flujo pantallas |
| Inputs | 🟡 | inline |
| Estados vacíos | 🟡 | flujo |
| Responsive | ✅ | phone-frame |
| Premium/iOS | 🟡 | branded coherente; poco bridge (11) |
| Riesgo dark | 🟡 | paleta branded hardcode mayoritaria |

### Index (cliente QR) — REFERENCIA
| Dim | Estado | Nota |
|---|---|---|
| Tipografía | ✅ | jerarquía clara (es la referencia) |
| Fondo | ✅ | suave |
| Cards | ✅ | suaves, radios consistentes |
| Botones | ✅ | coherentes |
| KPIs | N/A | — |
| Sidebar/nav | N/A | — |
| Inputs | ✅ | — |
| Estados vacíos | ✅ | — |
| Responsive | ✅ | mobile-first premium |
| Premium/iOS | ✅ | **objetivo** |
| Riesgo dark | 🔴 | **175 hex, 0 var, 0 `.my-*`** → NO dark-ready |

### Diag
| Dim | Estado | Nota |
|---|---|---|
| Todo | N/A | consola dev dark standalone; **no** superficie de venta. Branding "Mesa App" (bug). No carga tokens. |

---

## C. Gaps visuales concretos

1. **Radios inconsistentes.** Dominante `8px` (off-scale) + ~18 valores más. No mapean a
   `--radius-*`. Cards/inputs/botones con esquinas dispares entre paneles.
2. **Tipografía dispersa.** ~25 tamaños; la escala `--text-*` casi no se usa por nombre. Jerarquía
   distinta por panel (Admin/Caja/Superadmin mezclan mono+sans y saltos arbitrarios).
3. **Sombras sin voz única.** De `0` (Gerente, Delivery-rider = planos) a `10` pesadas
   (Index/Admin/Caja). Falta una elevación coherente tipo `--shadow-sm/md`.
4. **Espaciado/densidad desigual.** Padding/gap no via `--space-*`; Admin/Caja/Superadmin densos,
   Gerente/Index aireados. "Premium" pide más aire y ritmo constante.
5. **Tres sistemas de color conviven.** `.my-*` vs token bridge vs paleta JS `C_DARK`. Admin, Caja,
   Superadmin y Cocina mantienen **paleta JS paralela** a los tokens → fuente de divergencia y de
   **riesgo en dark** (los `C_DARK` no son los tokens).
6. **Botones inline no tematizables.** Caja "Vista del salón" (+Nueva mesa/Editar/Cancelar),
   Admin 116 `<button>` crudos (tabs/toggles), Delivery bespoke, acciones KDS blanco/negro.
7. **Cards con estilo propio.** Admin y Caja **no tienen `Card` compartido** (divs inline);
   Mozo/Delivery usan cards propias; solo Gerente/Superadmin/Cocina-stats usan `.my-card`.
8. **KPIs heterogéneos.** `.my-metric-card` (Gerente/Admin/Superadmin/Caja/Cocina) vs
   `.turno-stat` fila (Mozo) vs stats inline (Delivery). No todos comparten la misma "metric card".
9. **Estados vacíos pobres/desiguales.** No hay `.my-empty-state` aplicado; cada panel improvisa.
10. **Sidebars/navs incompatibles.** Cada panel staff tiene su sidebar propia; Mozo bottom-nav;
    no hay primitiva de navegación → estilos distintos de un panel a otro.
11. **Bugs visuales puntuales.** Superadmin chart MRR **barra negra** (`blue:'#000000'`); Diag
    branding "Mesa App"; index no dark-ready.
12. **Cocina rompe "mismo producto".** Es `dark` siempre; correcto como KDS, pero contrasta fuerte
    con el resto en una demo lado a lado (decisión de producto, no bug).

---

## D. Recomendación de PRs de polish (pequeños, seguros, frontend-only)

> Orden por **leverage/riesgo**. Cada uno = visual/CSS, sin lógica/datos/Auth. Mantener el flujo:
> implementar → reporte → revisión → commit/merge/push → QA. **Ninguno activa dark global.**

- **PR-B3I.1 — Radios y sombras globales (foundation).** Definir/consolidar una "voz" de elevación
  y radio en `ui-primitives.css`/tokens y **alinear los valores dominantes** (8→`--radius-md` o un
  `--radius` unificado; estandarizar `--shadow-sm/md`). Empezar por las **primitivas `.my-*`** (que
  ya propagan a Gerente/Admin/Superadmin/Caja/Cocina-stats) → máximo efecto, mínimo diff.
- **PR-B3I.2 — Botones y navegación.** Primitiva de nav/sidebar coherente + pasar más botones
  visibles a `.my-btn` donde sea seguro (Caja salón, acciones de Admin no-toggle). No tocar
  toggles/segmented ni acciones KDS blanco/negro.
- **PR-B3I.3 — Tipografía y espaciado.** Acercar tamaños a `--text-*` y paddings a `--space-*` en
  las **primitivas y contenedores compartidos** primero (no en cada call-site). Subir el "aire"
  de Admin/Caja/Superadmin hacia el ritmo de Gerente/Index.
- **PR-B3I.4 — Cards y estados vacíos / metric cards.** Introducir `Card` compartido donde falta
  (Admin, Caja) de forma incremental; unificar metric cards (Mozo `.turno-stat`, Delivery stats) y
  aplicar `.my-empty-state`. Mayor riesgo de layout → más acotado.
- **PR-B3I.5 — Paneles móviles/POS + fixes puntuales.** Pulir Mozo/Delivery/Caja-POS; arreglar
  chart MRR (`blue:'#000000'`→token), branding Diag "Mesa App"→"Mythos", y converger paletas JS
  (`C_DARK`) hacia tokens donde sea seguro (prep dark).
- **PR-B3I.6 — QA visual final pre-dark.** Pasada lado-a-lado de los 10 paneles contra `index`;
  checklist de paridad (radio/sombra/tipo/espaciado/cards/botones). Recién entonces **PR-B4** (dark
  global por panel con checklist).

**Decisión pendiente para Renato (producto, no técnica):** ¿`index` (cliente QR) debe **tokenizarse**
para ser dark-ready y "fuente de verdad", o se mantiene como inline premium? Hoy es la referencia
visual pero NO consume el sistema. Afecta a PR-B4.

---

## E. Qué NO se tocó (y NO se tocará en la fase de auditoría)

- **Backend, Auth, DB/RLS/RPC, migraciones, teardown:** intactos.
- **Lógica/API/permisos/datos/flujos operativos:** intactos.
- **PR-B4 (dark global):** NO iniciado.
- **Frontend visual:** **NO** se cambió nada — este PR es **solo** este documento de auditoría.
- `tokens.css` / `ui-primitives.css` / `mythos-theme.js` / paneles: **NO** modificados.

---

## Validación

- `npm run build`: **PASS** (9/9) — confirmatorio (no se tocó código de producto).
- `git diff --name-only`: **solo `docs/audits/pr-b3i-global-visual-polish.md`**.

## Métrica de respaldo (resumen)

- `.my-*` por panel (JSX): Gerente card2/btn3/metric3 · Admin metric21/btn3 · Superadmin
  card2/btn3/metric3 · Caja btn3/metric4 · Cocina card3/metric4 · Mozo/Delivery/Index/Login 0.
- Hex hardcodeados (JSX): Admin **694**, Caja 355, Superadmin 225, Index 175, Gerente/Cocina 111,
  Delivery-cliente 103, Mozo 105, Delivery-rider 63.
- `var(--)` (JSX): Mozo **200**, Delivery-rider 75, Admin 17, Delivery-cliente 11, Superadmin 5.
- Radios distintos: ~19 (dominante `8px`, off-scale). Tipos distintos: ~25. Sombras: 0–10/panel.
