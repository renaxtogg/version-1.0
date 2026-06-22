# WEB-4B — Registro trial conectado: auditoría + plan técnico

> **Fase:** WEB-4B-1 (auditoría + preparación). **Fecha:** 2026-06-22.
> **Estado:** registro público **APAGADO** detrás del flag `marketing_config.trial_signup_enabled = false`. **NO implementado** el endpoint ni el formulario real. **No se aplicó SQL, no se creó ningún usuario/restaurante/trial.**
> **Base:** `main = 7f1adc6` (WEB-4A login unificado). Migración relevante previa: `110` (marketing_*), aplicada manualmente por Renato.

---

## 0. Objetivo y restricciones

Preparar el registro público de prueba gratis (14 días) para nuevos restaurantes, conectado a Supabase Auth, **sin romper Auth actual ni datos demo y sin abrir el signup todavía**. Esta pasada es **solo auditoría + preparación**: deja el mapeo de planes y los flags listos, pero el registro público real se activa más adelante.

**Decisión de arquitectura (Renato, 2026-06-22):** WEB-4B queda **preparado detrás de un flag apagado**. No se implementa endpoint, no se crean usuarios/restaurantes, no se toca Auth, no se toca producción, no se ejecuta SQL, no se abre signup público.

---

## 1. Diagnóstico del modelo actual

### 1.1 Cómo se crean restaurantes hoy
- **Solo el Superadmin**, desde `src/superadmin/main.jsx`, con un `INSERT` directo a `restaurants` bajo la sesión autenticada del superadmin. **No hay endpoint backend ni RPC** para crear restaurantes.
- Al crear, el panel siembra opcionalmente una fila `subscriptions` y una `platform_events` (onboarding). **No crea el usuario dueño**: el dueño se da de alta aparte (pestaña Usuarios → `/api/create-user`).
- RLS: `restaurants` INSERT es **superadmin-only** (mig `103`, `restaurants_superadmin_all`). **No hay camino anónimo.**

### 1.2 Cómo se crean usuarios hoy (camino seguro)
- Único endpoint serverless: `api/create-user.js` (Vercel). Exige **JWT del llamante** (verificado contra `/auth/v1/user`, no decodificado localmente), lee el rol del llamante en `user_roles`, y solo permite `admin` (staff de su propio restaurante) o `superadmin` (cualquiera). Escribe con `SERVICE_ROLE_KEY` y hace **rollback** ante fallos.
- **Nunca crea restaurantes.** Solo agrega usuarios a un restaurante existente.
- **No existe self-signup:** `supabase.auth.signUp()` no aparece en el código. `registro.html` es un **placeholder deshabilitado** con `TODO(WEB-4)`.

### 1.3 Schema relevante (reconstruido de las migraciones)
| Tabla | Hechos clave para trial |
|---|---|
| `restaurants` | Tiene `status` (enum **incluye `'trial'`**), `is_active`, `auto_provisioned` (marcador demo), `parent_company_id`. **NO tiene `plan_id`.** `owner_name/owner_email/owner_phone` = texto plano, **sin FK**. |
| `user_roles` (mig 006) | `user_id` (FK `auth.users`), `restaurant_id` (FK, NULL = superadmin), `role`, `is_active`, `username/display_name/email`. **Dueño = `role='admin'`** (rutea a `admin.html`). No existe rol DB `owner` ni `gerente` (gerente = `supervisor_local`). `CHECK` de 8 roles (mig 049). |
| `profiles` / `user_profiles` | **No existen** (`user_profiles` es tabla fantasma, mig 038 nunca materializada). Identidad = `auth.users`. |
| `subscriptions` (mig 004) | `plan_id` (FK, **NOT NULL**), `status` (**ya admite `'trial'`**), `start_date`/`end_date` (DATE). **`UNIQUE(restaurant_id)` → una sola sub por restaurante.** |
| `subscription_plans` (mig 004) | `name` (Starter/Pro/Enterprise), `price_usd` (**contiene ₲** desde mig 097: 200k/400k/800k), `allowed_panels`/`allowed_features`/`max_users_by_role`. **NO tenía columna `slug`** (la agrega mig 111). UUIDs fijos …0001/0002/0003. |
| `restaurant_addons` (mig 090) | `restaurant_id`, `addon_key`, `enabled`, `quantity` — **acá viven los add-ons elegidos** (un row por add-on). `UNIQUE(restaurant_id, addon_key)`. |

### 1.4 Hallazgos que definen el plan
1. **El trial ya tiene dónde guardarse SIN columnas nuevas:** `subscriptions` con `status='trial'` + `start_date=hoy` + `end_date=hoy+14`. Add-ons → `restaurant_addons`. **No hace falta migración para *almacenar*.**
2. **No hay enforcement de expiración.** `get_restaurant_capabilities()` (mig 108) toma la última sub por `created_at` **ignorando `status` y fechas** → un trial vencido **conserva todos los paneles indefinidamente**. Riesgo comercial #1.
3. **Marketing y billing no están linkeados.** 4 slugs de marketing (`carta/servicio/full/enterprise`) vs 3 planes de billing (Starter/Pro/Enterprise, sin slug). **Precios no coinciden** (marketing 99k/229k/399k vs billing 200k/400k/800k). `registro.html` lee `?plan` solo como etiqueta e **ignora `?addons`**.
4. **El path de escritura anónima está CERRADO** (mig 103: anon no puede INSERT en restaurants/subscriptions/user_roles). → Un registro público **obligatoriamente** pasa por un endpoint `service_role`; el browser hace **cero** escrituras privilegiadas.

---

## 2. Decisiones de negocio (Renato, 2026-06-22)

- **Mapeo slug → plan de billing:** `carta → Starter`, `servicio → Pro`, `full → Enterprise`.
- **`enterprise` (marketing):** **no auto-provisiona**; deriva a **contactar ventas / WhatsApp**.
- **Email confirmation obligatoria** antes de poder usar el trial.
- **Trial vencido:** debe **bloquear el acceso operativo** o dejar mensaje de contacto; **no debe quedar gratis permanente**.
- **Precios:** marketing **no se alinea (todavía)** con el billing interno. **Billing define capabilities/features; marketing define la venta.** Por eso el mapeo es por **nombre de plan**, no por precio.
- **Registro público real se activa más adelante** mediante el flag `trial_signup_enabled`.

---

## 3. Migración 111 — PREPARED, NO APLICADA

Archivo: `supabase/migrations/20260622_111_trial_signup_support.sql`. **100% aditiva e idempotente.** Claude Code **no la aplica**; se corre a mano tras backup nuevo (SQL Editor en inglés).

Contenido:
- **Part A — mapeo:** `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS marketing_slug text` + índice único parcial (`WHERE marketing_slug IS NOT NULL`) + backfill idempotente (`Starter→carta`, `Pro→servicio`, `Enterprise→full`, solo donde `marketing_slug IS NULL`). **`enterprise` marketing queda sin mapear a propósito.**
- **Part B — flags:** `INSERT ... ON CONFLICT (key) DO NOTHING` de `trial_signup_enabled=false` y `trial_days=14` (este último ya sembrado por mig 110 → `DO NOTHING` no lo pisa). Ambos `is_public=true` para que el frontend pueda leer el gate.
- `NOTIFY pgrst, 'reload schema';`

**No incluye** (por diseño): endpoint, auth users, INSERT a restaurants/subscriptions/user_roles, cambios de RLS de escritura, enforcement de expiración, cron, captcha/rate-limit.

---

## 4. Flujo propuesto (para WEB-4B-2 en adelante, NO implementado)

```
/registro?plan=<slug>&addons=<slug,slug>
        │ (browser, sin privilegios; solo si trial_signup_enabled=true)
        ▼
POST /api/signup-trial   ← endpoint NUEVO, usa SERVICE_ROLE solo en server
        │
        ├─ 0. Gate: si trial_signup_enabled=false → 404/deshabilitado.
        │     Rechazos: JWT con user_roles existente → 403 (anti auto-registro de trabajador).
        │     Resuelve plan_id SERVER-SIDE vía subscription_plans.marketing_slug (nunca confía en el client).
        │     slug 'enterprise' → no provisiona; deriva a ventas/WhatsApp.
        │
        ├─ 1. Crea auth.users (Auth admin API) con email_confirm=false  ← PRIMERO
        │       └─ email ya existe → aborta acá, 0 filas → mensaje genérico + /login
        ├─ 2. INSERT restaurants (status='trial', auto_provisioned=true)
        ├─ 3. INSERT subscriptions (plan_id, status='trial', start=hoy, end=hoy+14)
        ├─ 4. INSERT user_roles (role='admin', restaurant_id=nuevo)   ← dueño
        ├─ 5. INSERT restaurant_addons (uno por add-on válido)
        │       └─ cualquier fallo en 2–5 → rollback total (borra todo + auth user)
        ▼
Pantalla "Revisá tu correo para activar tu prueba"   ← NO auto-login a admin.html
        ▼ (tras confirmar email)
/login  →  homeForRole('admin')  →  /admin   ← reusa WEB-4A, sin cambios
```

---

## 5. Roadmap WEB-4B (sub-fases, NO iniciadas)

- **WEB-4B-1 (esta fase):** documentar auditoría + preparar migración 111 (mapeo + flags). ✅ Esta entrega.
- **WEB-4B-2:** endpoint **server-side `/api/signup-trial.js`** con `SERVICE_ROLE` y **rollback total**; provisión atómica (auth user → restaurant → subscription trial → user_roles admin → add-ons), resolución de plan server-side vía `marketing_slug`, rechazo de sesiones con `user_roles` existente, manejo de email duplicado. Respeta `trial_signup_enabled`.
- **WEB-4B-3:** **`registro.html` real** (formulario habilitado, leer `?plan` **y** `?addons`, pantalla "revisá tu correo"). Solo se muestra el form real cuando `trial_signup_enabled=true`.
- **WEB-4B-4:** **enforcement de expiración** — `get_restaurant_capabilities()` (y triggers de límite) status/fecha-aware (fail-open para no-trial legacy) y/o cron que voltee `status='trial'→'expired'` en `end_date`. **Bloqueante para lanzar.**
- **WEB-4B-5:** **anti-abuso** — rate-limit (Vercel WAF) por IP/dominio, cap por email/IP, captcha opcional; reconciliar con el cupo fundador (solo contar trials confirmados).

**El registro público permanece APAGADO hasta activar `trial_signup_enabled = true`** (decisión explícita de Renato, posterior a tener al menos 4B-2 + 4B-4 listos y verificado el estado RLS en prod).

---

## 6. Riesgos (resumen; detalle en la auditoría del workflow)

| # | Riesgo | Sev. | Mitigación |
|---|---|---|---|
| 1 | Trial nunca expira → gratis permanente | 🔴 | Enforcement (4B-4) + cron. Bloqueante para lanzar. |
| 2 | Provisión huérfana (restaurante sin dueño) | 🔴 | Crear auth user PRIMERO; rollback total. |
| 3 | Escalada: trabajador se auto-crea restaurante | 🔴 | Endpoint rechaza sesiones con `user_roles`; `role='admin'` forzado a uid nuevo; ignora `restaurant_id/role/plan_id` del client. |
| 4 | Abuso por bots | 🔴 | `email_confirm=false` + rate-limit + cap + captcha; cupo fundador solo confirma. |
| 5 | Escritura privilegiada desde el browser | 🔴 | Todo por `service_role` server-side; mig 103 ya hace fallar inserts del client. |
| 6 | Auto-login a admin.html sin confirmar | 🟠 | Exigir confirmación; pantalla "revisá tu correo". |
| 7 | Plan forjado vía query param | 🟠 | Resolver plan server-side desde allowlist; default plan de entrada. |
| 8 | Lockdown 103/104/105 no aplicado en prod | 🟠 | Re-verificar gauge read-only antes de lanzar. |
| 9 | `UNIQUE(restaurant_id)` en subscriptions | 🟠 | Trial→pago = UPDATE de la fila única, no INSERT. |

---

## 7. Estado de esta entrega

- **Archivos creados:** este doc + `supabase/migrations/20260622_111_trial_signup_support.sql`.
- **NO se aplicó SQL.** **NO se creó** usuario, restaurante ni trial. **NO se tocó** Auth, producción, RLS de escritura ni el login.
- **Registro público:** APAGADO (`trial_signup_enabled=false`).
- Build verde (`npm run build` + `bash build.sh`). Rama: `feat/web-4b-trial-signup-prep`.
