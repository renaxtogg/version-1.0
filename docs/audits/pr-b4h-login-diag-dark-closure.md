# PR-B4H — Login / Diag dark closure

> FASE B (UI/UX + dark global). Cierre de la parte core/staff del dark: Login + Diag.
> Fecha: 2026-06-18 · Rama: `fix/pr-b4h-login-diag-dark-closure` · Base: `main = dc42cc4`.
> Frontend/visual. NO toca Auth, sesión, redirects, tokens de sesión, roles, usuarios ni permisos.

## Decisión por superficie

| Superficie | Decisión | Motivo |
|---|---|---|
| **Login** | **ACTIVAR dark** (`MythosTheme.init()`) | Ya estaba 100% token-bridgeado (PR-B3H, todo `var(--*)`), pero **no cargaba mythos-theme.js** → `data-theme` nunca se seteaba (era light-only). Agregar el script de tema + 2 fixes lo deja dark-ready, sin tocar Auth. |
| **Diag** | **NO-OP documentado** | Consola de diagnóstico **standalone**: no carga tokens.css/ui-primitives.css/mythos-theme.js; es un "dev console" con estética terminal **siempre oscura** intencional. No participa del theme system; alinearlo es innecesario y riesgoso. Cero cambios. |

## 1) Login — cómo se activa dark

- **Estado previo (PR-B3H):** enlaza solo `tokens.css` (define las CSS vars), **sin** design-system/
  ui-primitives/theme. Todo el `<style>` usa `var(--*)` (bg-subtle/surface/border/text-primary/
  text-secondary/primary/on-primary/text-disabled). Como **no** cargaba `mythos-theme.js`, el atributo
  `data-theme="dark"` nunca se aplicaba → Login renderizaba siempre light.
- **Activación (este PR):** se agrega **solo** `mythos-theme.js` + `MythosTheme.init()` en el `<head>`
  (tras `tokens.css`). `init()` setea `data-theme`/`color-scheme` según la **preferencia global**
  (`localStorage['mythos-theme']`)/sistema → Login refleja el tema que el usuario eligió en cualquier
  panel staff. El token bridge ya resuelve a los valores dark de `tokens.css`.
- **Sin toggle propio:** Login es pre-auth; **no se agrega** un toggle (sería ruido + riesgo). Refleja
  la preferencia global. (No había toggle previo; nada que reutilizar.)
- **`mythos-theme.js` NO se modificó.** Es un script de **presentación** (setea atributos, lee
  `localStorage['mythos-theme']`); no toca el cliente Supabase, el form, las claves de sesión
  (`mythos_role`/`mythos_restaurant_id`/…) ni los redirects. El IIFE de login corre aparte.

### Login — fixes visuales dark-safe (solo color; lógica intacta)
Dos literales que romperían al activar dark (light queda idéntico):
- **Spinner del botón** (`border-top-color:#fff` + `rgba(255,255,255,.3)`): el botón usa `var(--primary)`
  que en dark es **claro** (#FFFFFF) → un spinner blanco quedaría invisible. Ahora usa
  `var(--on-primary)` (el color de texto del botón: blanco sobre botón oscuro en light, oscuro sobre
  botón claro en dark) → contrasta en ambos.
- **Caja de error** (`border:#FFCDD0; color:#C0190F`): el rojo oscuro sobre `var(--surface)` oscuro
  quedaba sin contraste. Se agrega `[data-theme="dark"] .error { color: var(--error); border-color:
  color-mix(--error 45% transparent) }` → rojo claro legible en dark. **Light idéntico** (override
  dark-only).

### Login — checklist visual light / dark

| Elemento | Light | Dark | Mecanismo |
|---|---|---|---|
| Fondo | ✅ | ✅ | `var(--bg-subtle)` |
| Card / login box | ✅ | ✅ | `var(--surface)` + `var(--border)` |
| Logo / título | ✅ | ✅ | `var(--primary)` / `var(--text-secondary)` |
| Labels | ✅ | ✅ | `var(--text-secondary)` |
| Inputs (+ focus / placeholder) | ✅ | ✅ | `var(--surface/--border/--text-primary/--text-disabled)` |
| Botón "Ingresar" | ✅ | ✅ | `var(--primary)` + `var(--on-primary)` |
| Spinner (loading) | ✅ | ✅ | `var(--on-primary)` (fix) |
| Mensaje de error | ✅ | ✅ | light literal + override dark `var(--error)` (fix) |
| Hint / textos secundarios | ✅ | ✅ | `var(--text-disabled)` |
| Responsive móvil/desktop | ✅ | ✅ | layout flfrom sin cambios |

- Sin textos invisibles (spinner y error corregidos para dark).
- Sin cards blancas raras (card = `var(--surface)`, dark en dark).
- Light no se degrada (un solo cambio de valor en el spinner —idéntico en light— + override dark-only del error).

## 2) Diag — no-op documentado

- `public/diag.html`: herramienta de diagnóstico **standalone**. Carga `supabase` + `config.js`; **no**
  carga `tokens.css`/`ui-primitives.css`/`mythos-theme.js`/`design-system.css`.
- Estilo: `body { background:#0A0A0A; color:#E8E8E8; font-family: monospace }` + status (.ok/.err/
  .warn/.info) — estética **terminal/consola dev siempre oscura**, apropiada para un panel de debug.
- **Decisión: NO-OP** — no participa del theme system staff; ya es oscuro y legible; activar tokens/
  theme sería innecesario y un riesgo en una herramienta de debug. **Cero cambios.**
- Observación (NO corregida, fuera de alcance): el título/`<h1>` dice "Mesa App" (bug de branding
  conocido en CLAUDE.md; debería ser "Mythos"). No es un tema de dark → se deja para un PR de branding.

## 3) Riesgos Auth evitados
- **Solo se agregó un `<script>` de presentación** (`mythos-theme.js` + `init()`) y 2 cambios de CSS.
- **NO** se tocó: el IIFE de login, `signInWithPassword`, `get_my_profile`, `validateAndRedirect`,
  `homeForRole`, `clearSession`/`saveSession`, `getSession`, `signOut`, los redirects, las claves de
  sesión `mythos_*`, roles, usuarios, ni `mancuellorenato@gmail.com`. `clearSession` NO toca
  `mythos-theme` (tema y Auth desacoplados).
- **NO** se agregó design-system.css/ui-primitives.css a Login (se respeta la cautela de PR-B3H de no
  introducir conflictos de estilo cerca del login).

## 4) Pendiente (otras superficies)
- **Delivery rider + cliente** (FASE B-dark): recolor dedicado por superficie (marca `#fff`/`#000`
  dispersa; cliente customer-facing) — **NO tocado en este PR**. Ver `pr-b4g-mozo-delivery-dark.md`.
- **QR/menu cliente (index):** EXCLUIDO del dark staff.

## 5) Build
- `npm run build`: **PASS — 9/9** (Login/Diag son HTML vanilla, no entran al build Vite; los 9 paneles
  compilan sin errores).

## Confirmación de no-alcance
`git diff --name-only main` ⇒ **`public/login.html`** (+ este doc). Sin cambios en `public/diag.html`,
`mythos-theme.js`, `tokens.css`, `ui-primitives.css`, otros paneles (gerente/superadmin/admin/caja/
cocina/mozo), delivery (rider/cliente), `src/index/main.jsx`, `public/index.html`, `public/build/*`.
No se tocó: Auth/backend/Supabase/DB/RLS/RPC/migraciones/datos/teardown/permisos/service_role/PATs/
secretos/lógica de login/redirects/sesión/tokens/usuarios/roles/API/flujos/handlers/condiciones/
queries/payloads. **QR/menu intacto y excluido. Delivery no tocado. Resto de paneles staff no tocados.**
