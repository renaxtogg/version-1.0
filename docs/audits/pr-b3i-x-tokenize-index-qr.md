# PR-B3I.X — Tokenizar Index/QR menu (DECISIÓN ARQUITECTÓNICA)

> FASE B (UI/UX unificado + dark mode). Investigación previa a PR-B3I.6 (QA visual) y PR-B4 (dark).
> Fecha: 2026-06-17 · Rama: `fix/pr-b3i-x-tokenize-index-qr` · Base: `main = 4b5efe3`.
> **Entregable: SOLO documentación.** Cero código de producto modificado (decisión de arquitectura).

## Premisa del spec vs. realidad

El spec asumía que el Index/QR "todavía no consume el sistema global de tokens" por un descuido y
que había que **bridgearlo a `tokens.css`** para dark-readiness. La inspección reveló otra cosa.

## Hallazgo (evidencia)

El QR/menu **ya tiene su propio sistema de theming**, pero **NO es light/dark mode**: es
**branding por-restaurante**.

- `makeTheme(mood, tipo, carta)` (`src/index/main.jsx:232`) construye toda la paleta del menú a
  partir de **`mood`**, con **3 paletas de marca**: **`negro`** (chrome negro), **`blanco`**
  (claro) y **`sepia`** (cálido/marrón) — `src/index/main.jsx:233-264`.
- `mood` es una **elección del restaurante**: hay un control de UI "Tono de color: Negro / Blanco
  / Sépia" (`src/index/main.jsx:1931`, `tweaks.mood`), y el tema se arma en vivo
  (`makeTheme(tweaks.mood, …)`, `src/index/main.jsx:1733`).
- Cada paleta define ~25 slots semánticos por sección (`hdrBg/hdrText/qrBg/trackBg/rateBg/
  btnPrimary/ink/mid/gray/…`). Los neutrales (`#1D1D1F/#6E6E73/#86868B`) y el negro
  (`#000000`) son **valores de esas paletas de marca**, no literales sueltos.
- `public/index.html` **ya carga** `tokens.css` (+ design-system + ui-primitives) y pinea
  `MythosTheme.init('light')` — los tokens están disponibles, pero el menú no los consume **a
  propósito**.

## Por qué NO se debe bridgear (la razón de la decisión)

Reemplazar los valores de `makeTheme(mood)` por `var(--token)` sería **arquitectónicamente
incorrecto**:

1. **Acoplaría la estética del menú del CLIENTE al dark-mode del STAFF.** El menú es la cara de
   marca del restaurante; no debe oscurecerse porque un cajero active dark en su panel.
2. **Rompería el branding elegido.** El `mood:'negro'` (menú negro) es una **decisión de diseño
   intencional** del restaurante, no un "olvido de dark-readiness".
3. **En light sería byte-idéntico hoy**, pero crearía un híbrido que **choca** con el propio
   sistema `mood` (3 paletas) en cuanto el dark global se active (PR-B4).
4. **Cablear `mood` ↔ tema global** sería un **cambio de lógica** (prohibido) + una decisión de
   producto sin disparador definido (¿qué activaría el dark del cliente?).

## Decisión (Opción A, aprobada por arquitectura)

- **NO** se reemplazan las paletas `makeTheme(mood)` por tokens globales.
- **NO** se cablea `mood` con el dark global.
- La **dark-readiness del menú** se trata como **feature de branding/`mood` del restaurante**
  (p. ej. su propio `mood:'negro'`), **no** como herencia automática de los tokens del staff.
- **PR-B4 (dark global) NO debe forzar el menú del cliente a seguir el dark del staff.**

## Shell (`public/index.html <style>`)

Revisado y **NO tocado**. Es el marco del **mockup de teléfono** (no UI del menú):
`body{background:#111}` (escritorio detrás del teléfono en desktop) y `body{background:#fff}`
(móvil). El `#111` **no tiene token-equal** (los tokens neutros son `#FFFFFF/#1D1D1F/#0B0B0D`);
tokenizar solo el `#fff` móvil dejaría el marco a medias y aportaría valor ~nulo. Por el criterio
"si hay duda, no tocar y documentar", se deja intacto.

## Qué se tokenizó

**Nada.** Este PR es una **decisión arquitectónica documentada**: el QR/menu ya es una referencia
visual propia con sistema de branding por-restaurante; su integración a dark NO pasa por los
tokens globales.

## Riesgos

- **Ninguno.** Cero cambios de código de producto → cero riesgo visual, de lógica, de datos o de
  flujo. El look del menú queda **exactamente** igual.

## Build

- `npm run build`: **PASS — 9/9** paneles (`built in` ×9, sin errores) — confirma integridad del
  repo (no se modificó ningún fuente de panel).

## Confirmación de no-alcance

`git diff --name-only main` ⇒ **solo este doc** (cero archivos de producto). No se tocó:
`src/index/main.jsx`, `public/index.html`, `tokens.css`, otros paneles, ni
Auth/backend/Supabase/DB/RLS/RPC/migraciones/teardown/datos/permisos/lógica/API/flujos/handlers/
condiciones de render/queries/payloads. **Dark global NO activado. Branding del menú intacto.**

## Implicación para PR-B4

Cuando se diseñe PR-B4 (dark global por panel), el **menú cliente (`index`) queda EXCLUiDO** del
toggle de dark del staff: su apariencia la gobierna `mood` (negro/blanco/sepia) por restaurante.
Si en el futuro se quiere "dark del menú", debe especificarse como **feature de branding** (p. ej.
exponer/forzar `mood:'negro'`), no como herencia de tokens globales.
