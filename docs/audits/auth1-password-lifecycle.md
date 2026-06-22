# AUTH-1 — Password lifecycle (recuperación + cambio + primer ingreso forzado)

> Estado: **IMPLEMENTADO · NO mergeado.** Rama `feat/auth-password-lifecycle` (base `main = 574653f`).
> Migración **113 PREPARED — NOT APPLIED** (la aplica Renato a mano). No se ejecutó SQL.
> No toca WEB-4B (otra rama), no aplica mig 111, no activa trial signup, no toca `/` ni rompe `/login`/Google.

---

## 1. Parte A — Diagnóstico / preflight

| Ítem auditado | Resultado |
|---|---|
| `public/login.html` | Login email+password (`signInWithPassword`) → `get_my_profile` (RPC) → `resolveAndRoute` → `window.location.replace(dest)`. Sesión Supabase + `localStorage.mythos_*`. Punto de inserción del gate: tras auth, antes del redirect (2 sitios: submit y getSession). |
| Google OAuth | `signInWithOAuth({provider})`; al volver, el bloque `getSession` enruta. El gate solo dispara con flag explícito → OAuth no se ve forzado salvo flag. |
| `/api/create-user.js` | service_role server-side, valida token del caller, rollback. Es el único alta de staff. |
| Guards de paneles | Los 7 paneles de personal (superadmin/admin/gerente/caja/cocina/mozo/delivery-rider) ya incluyen `mythos-session.js`; los públicos (`index`, `delivery-cliente`) no. Cada panel tiene además un guard inline mínimo por `localStorage`. **Todos los paneles son Vite** (`src/<panel>/main.jsx` → `public/build/<panel>.js`). |
| ¿Flag de usuario existente? | **No existe** `must_change_password` ni tabla de flags → se crea (mig 113). |
| ¿Auth metadata en uso? | `user_metadata` se usa (create-user, cocina), pero es **editable por el cliente** (`auth.updateUser({data})`) → **no apto** para un flag de seguridad. Por eso tabla propia con RLS. |
| Rutas HTML | Rewrites explícitos por ruta en `vercel.json`. Se agrega `/cambiar-password` → `/cambiar-password.html`. |

**Dónde se guarda `must_change_password`:** tabla nueva `public.user_security_flags` (mig 113), con RLS — el usuario solo **lee** su fila y **no puede** escribirla; el flag se limpia **solo server-side** tras cambiar la contraseña.

**¿Requiere migración?** Sí, **113** (no 112: ya usado por WEB-4B). PREPARED — NOT APPLIED.

**¿Bloqueo?** No.

---

## 2. Parte B — Modelo de seguridad (migración 113, PREPARED — NOT APPLIED)

`supabase/migrations/20260622_113_password_lifecycle.sql` crea `public.user_security_flags`:

- `user_id uuid PK REFERENCES auth.users(id) ON DELETE CASCADE`, `must_change_password bool NOT NULL DEFAULT false`, `password_changed_at timestamptz`, `forced_reason text`, `created_at`, `updated_at`.
- **RLS fail-closed:** `usf_read_own` (SELECT solo `user_id = auth.uid()`) + `usf_superadmin_all` (FOR ALL solo `get_my_role()='superadmin'`). **No hay** policy de INSERT/UPDATE/DELETE para el usuario común → **no puede apagar su propio flag** desde el frontend. anon sin acceso. El server usa **service_role** (bypassa RLS) para setear/limpiar el flag.
- Trigger `set_updated_at` (helper mig 001).

---

## 3. Archivos tocados / creados

| Archivo | Cambio |
|---|---|
| `supabase/migrations/20260622_113_password_lifecycle.sql` | **NUEVO · PREPARED — NOT APPLIED** — tabla `user_security_flags` + RLS. |
| `public/mythos-auth-guard.js` | **NUEVO** — guard anti-bypass reutilizable (lee el flag, redirige). |
| `public/cambiar-password.html` | **NUEVO** — página de cambio (modo logueado + recuperación). |
| `api/change-password.js` | **NUEVO** — endpoint server-side de cambio de contraseña. |
| `public/login.html` | Gate de cambio obligatorio antes del redirect + "Olvidé mi contraseña". |
| `api/create-user.js` | Setea `must_change_password=true` al crear (default), rollback si falla el flag. |
| `public/{superadmin,admin,gerente,caja,cocina,mozo,delivery-rider}.html` | Incluyen `mythos-auth-guard.js` (tras `mythos-session.js`). |
| `src/admin/main.jsx`, `src/superadmin/main.jsx` | Aviso "El usuario deberá cambiar esta contraseña en su primer ingreso". |
| `vercel.json` | Rewrite `/cambiar-password`. |

**Endpoints nuevos:** `POST /api/change-password`. **Rutas nuevas:** `/cambiar-password`.

---

## 4. Comportamiento implementado

- **C — Alta con contraseña genérica:** `/api/create-user` marca `must_change_password=true` (`forced_reason='initial_generic_password'`) por defecto. Si el flag no se puede crear → **rollback total** (no deja usuario a medias). Aviso visible en los forms de Admin/Superadmin.
- **D — Login con bloqueo:** tras autenticar (email/password u OAuth) y antes del redirect por rol, `needsPasswordChange()` consulta el flag. Si `true` → `replace('/cambiar-password?reason=first_login')`, **no** entra al panel. **Fail-open** si la tabla no existe (mig 113 sin aplicar) → login normal.
- **E — Guard universal:** `mythos-auth-guard.js` en los 7 paneles. Con sesión + flag → redirige a `/cambiar-password?reason=required`. Sin sesión → no interfiere (el panel redirige al login). **Fail-open** ante error/red/tabla-ausente. Enforcement primario = login; el guard es la red anti-bypass por URL directa.
- **F — `/cambiar-password`:** dos modos. **Logueado** (`reason=first_login|required`): pide nueva contraseña + repetir. **Recuperación** (`mode=recovery`): consume el token del enlace (supabase-js) y habilita el form. Valida mín. 10, coincidencia, no trivial. Llama a `/api/change-password`. Al éxito: cierra sesión y vuelve a `/login`.
- **G — `/api/change-password`:** valida Bearer token del usuario contra Auth, valida la contraseña server-side (mín. 10, ≠ email, no trivial), cambia la contraseña **con el token del usuario** (`PUT /auth/v1/user`), y **solo después** limpia el flag con service_role. No loguea contraseñas; no devuelve errores técnicos.
- **H — Olvidé mi contraseña:** link en `/login` → `resetPasswordForEmail(email, { redirectTo: origin + '/cambiar-password?mode=recovery' })`. Respuesta **siempre genérica** ("Si el correo existe…") — no revela si el email existe.
- **I — Gestión:** aviso en Admin/Superadmin. La acción "Forzar cambio de contraseña" para un usuario existente se **difiere a AUTH-2** (no aumenta el alcance/riesgo de este bloque).

---

## 5. Pasos manuales en Supabase (los hace Renato)

1. **Aplicar la migración 113** en SQL Editor (idioma **inglés**), con backup nuevo:
   - Ejecutar `supabase/migrations/20260622_113_password_lifecycle.sql` tal cual (aditiva, idempotente).
   - Verificar: `SELECT * FROM public.user_security_flags LIMIT 1;` (tabla existe, vacía).
2. **Auth → URL Configuration → Redirect URLs:** agregar las URLs a las que vuelve el enlace de recuperación:
   - Producción: `https://mythos-pos.vercel.app/cambiar-password`
   - Preview (QA): la URL exacta del deploy de preview + `/cambiar-password`, o un wildcard de preview si está habilitado.
3. **Auth → SMTP:** confirmar que el envío de correos está configurado (el "olvidé mi contraseña" usa el correo de recuperación de Supabase). Sin SMTP propio, el rate-limit del SMTP de cortesía puede frenar los envíos en QA.

> Nada de esto se toca desde código. Claude Code **no** aplica SQL ni configura el dashboard.

---

## 6. Parte J — QA checklist (en preview, tras aplicar mig 113 + redirect URLs)

**1. Forgot password**
- [ ] `/login` muestra "¿Olvidaste tu contraseña?".
- [ ] Enviar con un email real de prueba → mensaje genérico ("Si el correo existe…").
- [ ] Llega el correo; el enlace abre `/cambiar-password` (modo recuperación) y habilita el form.
- [ ] Cambiar contraseña → éxito → login con la nueva funciona.
- [ ] Email inexistente → mismo mensaje genérico (no revela nada).

**2. Primer ingreso forzado**
- [ ] Crear un usuario de prueba desde Admin/Superadmin con contraseña genérica.
- [ ] Login con esa contraseña → redirige a `/cambiar-password?reason=first_login`, **no** entra al panel.
- [ ] Cambiar contraseña → vuelve a `/login` → login con la nueva → entra al panel.
- [ ] Segundo login ya **no** pide cambio.

**3. Bypass directo a paneles**
- [ ] Con un usuario `must_change_password=true` (sesión activa), abrir directo `/admin`, `/gerente`, `/caja`, `/cocina`, `/mozo`, `/delivery-rider`, `/superadmin` → cada uno redirige a `/cambiar-password?reason=required`.

**4. Cambio normal (logueado, sin flag)**
- [ ] Usuario sin flag entra a `/cambiar-password` → cambia → la contraseña anterior deja de funcionar, la nueva sí.

**5. Google**
- [ ] Login Google sigue funcionando; no fuerza cambio (sin flag explícito).

**6. Seguridad**
- [ ] service_role no aparece en el frontend (solo en `/api/*` server-side).
- [ ] No se loguean contraseñas.
- [ ] Forgot password no revela si el email existe.
- [ ] No se crea usuario/restaurante/trial; no se aplica mig 111.
- [ ] `/` sigue siendo el cliente QR; `/login` intacto salvo la nueva opción.
- [ ] El usuario **no** puede apagar su propio flag (probar un UPDATE directo con el token del usuario → RLS lo niega).
- [ ] build PASS.

---

## 7. Riesgos / decisiones

- **Fail-open del gate/guard ante tabla ausente o error de red:** decisión deliberada para no romper el login/paneles si la mig 113 aún no está aplicada o hay un blip. El enforcement primario es el login; el guard es una red secundaria. Un usuario con flag tiene credenciales válidas (no es un atacante), así que el riesgo del fail-open es bajo.
- **Correo de recuperación:** depende del SMTP del proyecto (verificar en QA). Si "Confirm email"/SMTP no están listos, el flujo de recuperación no entrega el enlace.
- **`must_change_password` no se puede apagar desde el cliente** (RLS sin policy de escritura para el usuario); solo el endpoint server-side lo limpia tras cambiar la contraseña.
- **Acción "Forzar cambio" para usuarios existentes:** diferida a AUTH-2.
- **`SERVICE_ROLE_KEY` solo server-side** (env de Vercel, ya usada por `/api/create-user`).

---

## 8. Confirmaciones duras

❌ SQL no ejecutado · ❌ migración 113 no aplicada (PREPARED) · ❌ migración 111 no aplicada · ❌ trial signup no activado · ❌ WEB-4B no tocado · ❌ service_role no expuesto al frontend · ❌ contraseñas no logueadas · ❌ `/` no tocado · ✅ `/login` y Google intactos (solo se agregó la opción de recuperación + el gate).
