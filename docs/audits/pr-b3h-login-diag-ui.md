# PR-B3H — Alineación visual de Login y Diag

> FASE B (UI/UX unificado + dark mode). PR **dedicado** para Login y Diag (superficies sueltas).
> Fecha: 2026-06-17 · Rama: `fix/pr-b3h-login-diag-ui` · Base: `main = 55aa28e`.
> Cierra la cobertura de superficies de PR-B3 (paneles + login/diag). Frontend/visual.

## Objetivo

Alinear Login y Diag con el sistema de tokens global, sin tocar Auth, permisos, flujo de login,
validaciones, redirects, sesiones, diagnóstico funcional, backend, DB ni rutas. Sin dark global.

## Archivos reales inspeccionados

- `public/login.html` (182 líneas) — **modificado**.
- `public/diag.html` (111 líneas) — **revisado, NO tocado** (no-op, ver abajo).
- **No existen** `src/login/main.jsx` ni `src/diag/main.jsx`: Login y Diag **no** son paneles Vite,
  son HTML **vanilla** standalone (sin React/bundle).

## Auditoría → enfoque por superficie

Ninguna de las dos superficies cargaba el sistema global (`design-system.css`/`tokens.css`/
`ui-primitives.css`/`mythos-theme.js`); cada una tiene su propio `<style>` inline con colores
hardcodeados. Por eso `.my-*` y `var(--token)` **no resolverían** sin antes enlazar el CSS.

### Login → **token bridge** (enfoque B, adaptado)

`login.html` es la pantalla de acceso (user-facing) y sus neutrales hardcodeados **coinciden
exactamente** con los valores de los tokens en light. Enfoque elegido: enlazar **solo `tokens.css`**
(define las CSS custom properties en `:root`; **no** tiene reglas de elemento → cero riesgo de
conflicto de layout) y **aliasar** los neutrales del `<style>` a `var(--token)`.

- **NO** se enlazó `design-system.css` (podría pisar elementos base de una página auto-estilada),
  ni `ui-primitives.css` (no se usan `.my-*`), ni `mythos-theme.js` (no se activa theming aquí;
  eso es PR-B4). Login queda **wired a tokens** y dark-ready, pero pineado light de facto
  (sin `data-theme`, resuelve `:root`).

| Hex (literal) | → token | rol |
|---|---|---|
| `#F5F5F7` | `var(--bg-subtle)` | fondo de página |
| `#fff` (card/input/error bg) | `var(--surface)` | superficies |
| `#1D1D1F` | `var(--text-primary)` | texto / input |
| `#6E6E73` | `var(--text-secondary)` | labels / subtítulo |
| `#AEAEB2` | `var(--text-disabled)` | placeholder / hint |
| `#D2D2D7` | `var(--border)` | bordes de card/input |
| `#000` | `var(--primary)` | botón / logo / focus (→ #1D1D1F, delta de marca PR-B1) |

**Preservado (semántico):** rojos de error (`#FFCDD0` borde / `#C0190F` texto — sin token 1:1),
blanco del spinner (`#fff` sobre botón oscuro) y las sombras `rgba(0,0,0,…)`.

**Delta visual (light, único tema activo):** cero, salvo `#000 → #1D1D1F` (casi-negro de marca,
el mismo delta aceptado en todos los PR de FASE B). Auth/JS **intactos**.

### Diag → **no-op documentado** (enfoque C)

`diag.html` es una **consola de diagnóstico para desarrolladores**, standalone y **dark** por
diseño (`body #0A0A0A`, fuente monoespaciada tipo terminal, colores de estado ok/err/warn). No es
una superficie del sistema visual user-facing.

- Alinearla a tokens exigiría **forzar `data-theme="dark"`** + enlazar `tokens.css` y, aun así,
  introduciría **deltas** (p. ej. bordes `#222` → `var(--border)` dark `#38383A` = más claros;
  verdes/ámbar de estado levemente distintos) en una herramienta funcional, con **valor ~nulo**
  (es dev-only y ya es internamente consistente).
- Por eso: **no-op** (la opción C del propio plan: "ya está alineado/innecesario tocarlo").
- *Nota (no tocado, follow-up):* el título dice "Mesa App" (bug de branding; debería ser "Mythos"
  por las reglas del proyecto). Se deja fuera de este PR (es copy, no alineación de tokens).

## Archivos modificados

- **`public/login.html`** — `<head>`: +1 `<link tokens.css>`; `<style>`: neutrales → `var(--token)`.
- **`docs/audits/pr-b3h-login-diag-ui.md`** — este doc.

`git diff --name-only` ⇒ solo `public/login.html`.

## Qué quedó fuera de alcance

- **Diag** completo (no-op; ver arriba). Branding "Mesa App"→"Mythos" → follow-up.
- **`.my-*` / `mythos-theme.js` / `design-system.css` / `ui-primitives.css`** en Login → no
  necesarios para el bridge; integrarlos (y activar dark) es trabajo de PR-B4.
- **Rojos de error, spinner, sombras** en Login → semánticos, se preservan.

## Riesgos evitados

- **Auth/flujo intactos:** no se tocó el `<script>` de login (signIn, get_my_profile,
  validateAndRedirect, saveSession, homeForRole, redirects, sesiones) ni el de diag.
- **Sin conflicto de cascada:** se enlazó solo `tokens.css` (define variables, sin reglas de
  elemento) → no puede pisar el layout auto-estilado de login.
- **Sin romper Diag:** no se tocó (evita aclarar/oscurecer una consola dev funcional).
- **Delta light = 0** (salvo el casi-negro de marca, ya estándar en FASE B).

## Validación

- `npm run build`: **PASS** (9/9). `npm run typecheck`: no existe (JS/JSX puro). *(Login/Diag son
  HTML estáticos; Vite no los procesa, pero el build confirma que nada más se rompió.)*
- `git diff --name-only`: **solo `public/login.html`** (diag.html intacto).
- Login: 0 neutrales hardcodeados funcionales restantes (solo `#fff` del spinner + rojos de error
  + rgba de sombra, todos intencionales); `var(--token)` cableado en body/card/input/label/botón.

## Confirmación de no-alcance

No se tocó: **Gerente, Admin, Superadmin, Caja, Cocina, Mozo, Delivery** ·
**Auth/backend/Supabase/DB/RLS/RPC/migraciones/teardown** · **lógica/API/permisos/datos** ·
**flujo de login / validaciones / redirects / sesiones** · **diagnóstico funcional** ·
rutas/navegación · `ui-primitives.css` / `tokens.css` (no editados; login solo los **enlaza**) ·
**dark mode global**. **PR-B4 no iniciado.**

## Follow-ups conocidos (fuera de este PR, NO investigados)

- Caja: botones inline de salón. · Cocina: charts data-gated. · Mozo: `.item-card` data-gated. ·
  Delivery: cards data-gated / flujo cliente no recorrido. · Superadmin: chart MRR negro. ·
  Admin: error 42501 RLS. · Diag: branding "Mesa App" + (opcional) alineación dark en PR-B4.

## Conteos finales

- `.my-card` / `.my-btn` / `.my-input` en login.html y diag.html: **0** (enfoque = token bridge en
  login; no-op en diag).
- Login `var(--token)`: bg-subtle 1, surface 3, border 2, text-primary 2, text-secondary 2,
  text-disabled 2, primary 3 (+1 en comentario), on-primary 1.
- Hardcodes restantes — login: spinner `#fff`, error `#FFCDD0`/`#C0190F`, sombras rgba (semánticos).
  diag: sin cambios (consola dark intencional).
