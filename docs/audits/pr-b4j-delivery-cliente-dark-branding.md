# PR-B4J — Delivery cliente: dark / branding (customer-facing)

> FASE B (UI/UX + dark global). Revisión de **Delivery cliente** (superficie customer-facing) y decisión de tema.
> Fecha: 2026-06-18 · Rama: `fix/pr-b4j-delivery-cliente-dark-branding` · Base: `main = abdc045`.
> Frontend/visual. NO toca tracking, estados, pedidos, ubicación, datos, backend, QR/menu ni Delivery rider.

## Decisión

**MANTENER LIGHT / BRANDING** (customer-facing). **NO** se activa dark; **NO** se agrega toggle. Panel pineado `MythosTheme.init('light')` (sin cambio funcional). Documentado como decisión de marca, **mismo criterio y precedente que el menú/QR cliente (PR-B3I.X)**.

Es la **Opción 2** del PR: *"Mantener light/branding si dark no conviene para cliente final, documentando la decisión."*

## Por qué NO se activa dark (Opción 1 descartada)

`src/delivery-cliente/main.jsx` (2033 líneas) es un flujo customer-facing completo (Bienvenida → Cobertura/zonas → Datos → Menú → Detalle de ítem → Carrito → Pago → Tracking → Rating) construido sobre un **theme de marca propio** `makeTheme()`:

```
black:'#000000'  white:'#FFF'  dark:'#2D2D2D'  silver:'#BBB'  border:'#E8E8E8'
light:'#F0F0F0'  offwhite:'#F8F8F8'  hdrBg:'#FFF'  trackBg:'#F8F8F8'  phoneBg:'#F8F8F8'
btnPrimary:'#000000'  btnPrimaryText:'#FFF'  trackLine:'rgba(0,0,0,0.5)' …
ink:'var(--text-primary)'  mid:'var(--text-secondary)'  gray:'var(--text-tertiary)'  ← únicos bridgeados
```

- **Bridge de tokens PARCIAL:** solo `ink`/`mid`/`gray` (textos) están bridgeados a tokens; **todas las superficies** (`white`/`black`/`border`/`offwhite`/`light`/`hdrBg`/`trackBg`/gradientes `linear-gradient(${T.dark},${T.black})`) son **literales claros hardcodeados**.
- **Consecuencia de activar `init()`:** en dark, los textos (`T.ink`) flipearían a claro mientras las superficies (`T.white`, `T.offwhite`, headers, cards, modales) seguirían **blancas** → **texto claro sobre fondo blanco = invisible en todo el flujo**. El panel quedaría inusable.
- **Activar dark de forma segura exigiría un rebrand completo**: tokenizar toda la paleta `makeTheme()` + auditar **66+ literales hex inline** + los **mapas de color por zona** (`ZONE_COLOR_MAP` red/orange/yellow/green, pastel + texto oscuro) + gradientes de imagen + alertas (GPS denegado `#FEF3C7`, fuera de cobertura `#FEF2F2`, pendiente `#FFF7ED`) + el **timeline de tracking** y la pantalla de rating. Eso es un **sweep masivo en la superficie de mayor sensibilidad de confianza/marca** → el PR prohíbe explícitamente sweeps no controlados de alto riesgo de producto.

## Por qué no "alinear parcialmente sin activar" (Opción 3 descartada)

Tokenizar algunas superficies sin activar dark **no tendría efecto visible** (sigue pineado light) y dejaría un bridge a medias: si alguien luego flipea a `init()`, un rebrand parcial es **peor** que ninguno (rompe de forma inconsistente). Además, tocar la paleta de marca arriesga **shift de píxeles en light**. Sin beneficio inmediato y con riesgo → descartada.

## Precedente (consistencia)

Idéntico al menú/QR cliente: **PR-B3I.X** decidió (vía AskUserQuestion, Opción A) que el QR/menu **NO se tokeniza al dark del staff** porque tiene branding propio por-restaurante (`makeTheme(mood)` negro/blanco/sepia). Delivery cliente es la **misma familia** (app de pedido customer-facing con `makeTheme()`), por lo que hereda el **mismo criterio: excluido del dark staff, queda en light/branding**.

## Cambios aplicados

- `public/delivery-cliente.html`: **comentario aclaratorio** antes de `MythosTheme.init('light')` (la llamada **no cambia**). Documenta la decisión y advierte: ⚠️ no cambiar a `init()` sin rebrand completo (bridge parcial → texto invisible). Cero cambio de comportamiento.
- `docs/audits/pr-b4j-delivery-cliente-dark-branding.md`: este documento.
- **`src/delivery-cliente/main.jsx`: NO tocado** (cero cambios de producto).

## Estado actual (light) — checklist

El panel renderiza **siempre light** (pin `init('light')` → `data-theme="light"` → tokens bridgeados resuelven a valores light; el pin **ignora** la preferencia global del staff y protege la marca).

| Superficie | Light | Mecanismo |
|---|---|---|
| Fondo / phone stage | ✅ | shell `#111` (escenario) + `.screen` / `T.white` |
| Bienvenida (logo, opciones) | ✅ | `T.white`/`T.black` marca |
| Cobertura (GPS, anillos, zonas) | ✅ | `ZONE_COLOR_MAP` + `T.*` |
| Datos de entrega (form) | ✅ | `inputStyle(T)` + `T.*` |
| Menú (categorías, cards, featured) | ✅ | `T.white`/gradientes marca |
| Detalle de ítem (modal, extras) | ✅ | `T.white`/`T.black` |
| Carrito (ítems, totales) | ✅ | `T.white`/`T.border` |
| Pago (métodos, factura) | ✅ | `T.white`/`T.black` |
| Tracking / timeline | ✅ | `trackBg`/`trackLine` marca |
| Rating | ✅ | `T.*` marca |
| Estados (cobertura no, GPS denegado, pendiente) | ✅ | pastel semántico inline |
| Empty/menú vacío | ✅ | `T.*` |
| Responsive móvil | ✅ | shell media-query |

**Light NO se degrada** (cero cambios de estilo; solo un comentario en el shell).

## Superficies sensibles revisadas (NO tocadas)
- Theme de marca `makeTheme()` y todos los `T.white`/`T.black`/gradientes — intactos.
- `ZONE_COLOR_MAP` (zonas de cobertura) — intacto.
- Timeline de tracking, pantalla de pago/factura, rating — intactos.

## Superficies data-gated (no verificadas — quedan en light por diseño)
- Tracking en tiempo real con un pedido real (timeline/estados).
- Cobertura con zonas reales (`delivery_zones`) y GPS real.
- Menú/carrito/pago con datos reales del restaurante.
- (Todas se mantienen en light/branding; no hay dark que verificar.)

## Hallazgos funcionales (NO corregidos — fuera de alcance)
- Ninguno nuevo. Observación (no es un bug de tema): el bridge parcial de `makeTheme()` (textos a tokens, superficies hardcodeadas) es una **trampa latente** si alguien activa `init()` sin rebrand — documentada con el comentario del shell. No se modifica la lógica.

## Riesgos visuales / producto
- **Ninguno introducido** (cero cambios de estilo). Mantener light en una superficie customer-facing es la opción de **menor riesgo de marca/confianza**.
- Riesgo evitado: activar dark con bridge parcial habría dejado el flujo de pedido **inusable** (texto invisible) para el cliente final.

## Build
- `npm run build`: **PASS — 9/9** (no se modificó el bundle de cliente; solo el comentario del shell + doc).

## Confirmación de no-alcance
`git diff --name-only main` ⇒ **`public/delivery-cliente.html`** (comentario) + este doc. `src/delivery-cliente/main.jsx` **sin cambios**.
**NO** tocado: Delivery rider, QR/menu (index), Gerente/Superadmin/Admin/Caja/Cocina/Mozo/Login/Diag, `mythos-theme.js`/`tokens.css`/`ui-primitives.css`, `public/build/*`.
**NO** tocado: Auth/backend/Supabase/DB/RLS/RPC/migraciones/datos/teardown/permisos/API/lógica de tracking/estados de delivery/ubicación/geolocation/pedidos/timers/realtime/queries/RPC/endpoints/payloads/handlers/condiciones de render/reglas de negocio.

## Estado FASE B-dark tras este PR
- **Core/staff:** Gerente/Superadmin/Admin/Caja/Cocina(pinned)/Mozo/Login activados; Diag no-op.
- **Delivery rider:** activado (PR-B4I).
- **Delivery cliente:** light/branding (este PR) — excluido del dark staff, como el menú/QR.
- Con esto, **todas las superficies de FASE B-dark tienen decisión cerrada**: staff en dark; las dos superficies customer-facing branded (menú/QR e índice de pedido cliente) quedan en su branding propio light.
