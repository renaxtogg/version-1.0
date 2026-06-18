# FASE C · WS1 — Gating por plan y capabilities (AUDITORÍA)

> **Resultado:** **SOLO AUDITORÍA — cero cambios de producto.** No se encontró ninguna **fuga de datos**;
> las violaciones posibles son **comerciales/UI**, no de seguridad. Por las reglas de WS1 (evitar RLS/migraciones
> salvo fuga real, no rediseñar planes, no sobreingeniería, corregir solo falla real) → se **documenta**, no se corrige.
>
> Rama `fix/fase-c-ws1-capabilities-gating` (base `9bb7da2`). Programador: Claude Code. Arquitecto: ChatGPT.
> Método: lectura de migraciones (fuente de verdad) + `src/<panel>/main.jsx` (guards reales) + `public/login.html`.
> No se ejecutó la app en vivo; las cuentas demo de WS0-B permiten que QA confirme cada fila de la matriz.

---

## 1. Fuente de verdad (dónde se define el gating hoy)

| Qué | Dónde vive | Cómo se lee en runtime |
|---|---|---|
| **Plan del restaurante** | `subscriptions.plan_id` → `subscription_plans` (DB) | RPC `get_restaurant_capabilities(p_restaurant_id)` |
| **Paneles del plan** | `subscription_plans.allowed_panels` (jsonb) — seed mig **090** | RPC (unión plan ∪ add-ons) |
| **Add-ons (paneles extra)** | `plan_addons` + `restaurant_addons` — mig 090 | RPC (se unen a allowed_panels) |
| **Features (sub-módulos)** | `subscription_plans.allowed_features` (jsonb) — seed mig **091** | RPC → `mythos-gating.js` (`hasFeature`) |
| **Límite usuarios por rol** | `subscription_plans.max_users_by_role` — mig 090 | **Trigger server-side** `enforce_role_user_limit` |
| **Edición de la matriz** | Panel **Superadmin** → Planes (CRUD de allowed_panels/allowed_features) | `src/superadmin/main.jsx` |
| **RPC** | `get_restaurant_capabilities` | mig 090 → 091 (añade features) → **108 (guard tenant-safe, fail-closed)** |

**Hay refuerzo backend, pero parcial:**
- ✅ Aislamiento **multi-tenant** por RLS (mig 086/103/104): cada panel ve solo su restaurante.
- ✅ RPC de capabilities **tenant-guarded** (mig 108): no se puede leer metadata de otro tenant.
- ✅ **Límite de usuarios por rol/plan**: trigger real en DB (mig 090).
- ✅ **Role guard** por panel (fail-closed, vía `get_my_profile`) en el bootstrap de cada panel.
- ❌ **NO hay refuerzo backend del gating por PANEL/FEATURE comercial**: `allowed_panels`/`allowed_features` solo se usan para **UI** (mostrar candado/upsell). Diferido estructural desde PR-10.

---

## 2. Matriz canónica plan × panel × módulo

Fuente: mig 090 (`allowed_panels`, `max_users_by_role`) + mig 091 (`allowed_features`). Mapeo demo = WS0.

| Plan | Restaurante demo | Paneles permitidos (`allowed_panels`) | Módulos premium permitidos (`allowed_features`) | Paneles bloqueados (por plan) |
|---|---|---|---|---|
| **Starter** | Pizzería Bella Napoli | `caja`, `mozo`, `cocina` | **los 6** (ver nota ⚠️) | `delivery-cliente`, `delivery-rider`, `gerente` |
| **Pro** | Sushi Sakura | `caja`, `mozo`, `cocina`, `delivery-cliente` | **los 6** (ver nota ⚠️) | `delivery-rider`, `gerente` |
| **Enterprise** | Parrilla Don Carlos | `caja`, `mozo`, `cocina`, `delivery-cliente`, `delivery-rider`, `gerente` | **los 6** | — |

Límites de usuarios por rol: Starter `{mozo:2, cajero:1, cocina:1}` · Pro `{mozo:5, cajero:2, cocina:3}` · Enterprise sin límite. (Refuerzo real por trigger.)

Catálogo de los 6 módulos premium (`allowed_features`, key `panel:feature`): `admin:delivery_zones`, `admin:inventory`, `admin:crm`, `caja:sifen`, `caja:digital_payments`, `mozo:digital_qr_pay`.

> ⚠️ **NOTA CRÍTICA (no-op de feature-gating):** mig 091 sembró **TODOS** los planes con **las 6 features**
> (`UPDATE … WHERE allowed_features IS NULL`). Starter, Pro y Enterprise tienen `allowed_features` **idénticos**
> → **el paywall por feature de `mythos-gating.js` NUNCA dispara** en ningún plan. Es un hueco **comercial**
> (diferido en PR-10: "diferenciar allowed_features por plan"), **NO un bug**. QA verá los 3 planes con los mismos
> módulos. No se toca (regla: "No rediseñar planes comerciales todavía").

> **`admin` y `superadmin` NO están en `allowed_panels`**: no son paneles "de plan". `admin.html` es el panel del
> dueño (siempre disponible para roles admin/gerente); `superadmin.html` es plataforma (solo rol superadmin).

---

## 3. Capas de control real (qué bloquea qué)

| Capa | Implementación | Tipo | ¿Bloquea URL directa? |
|---|---|---|---|
| **Role guard por panel** | bootstrap de cada `src/<panel>/main.jsx` (`get_my_profile`) | **hard, fail-closed** | ✅ cross-rol (salvo mozo, ver §5.3) |
| **Aislamiento tenant** | RLS (mig 086/103/104) | **hard** | ✅ cross-tenant (datos) |
| **Guard RPC capabilities** | mig 108 (COALESCE fail-closed) | **hard** | ✅ metadata de otro tenant |
| **Límite usuarios rol/plan** | trigger `enforce_role_user_limit` (090) | **hard, server** | ✅ alta por encima del límite |
| **Gating por panel** (`allowed_panels`) | solo hub "Paneles" de admin (`PanelesPage`, fail-open) | **soft, UI** | ❌ **no** bloquea paneles standalone |
| **Gating por feature** (`allowed_features`) | `mythos-gating.js` en admin/caja/mozo (fail-open) | **soft, UI** | ❌ + hoy no-op (§2) |

### Role guards reales por panel (allowlist en el bootstrap)
| Panel | Roles aceptados | Nota |
|---|---|---|
| `superadmin.html` | `superadmin` | hard, único panel cross-tenant → bien blindado |
| `admin.html` | `admin`, `gerente`, `supervisor_local`, `superadmin` | |
| `gerente.html` | `gerente`, `supervisor_local`, `admin`, `superadmin` | |
| `caja.html` | `admin`, `superadmin`, `cajero`, `cocina` | |
| `cocina.html` | `cocina`, `admin`, `superadmin` | |
| `mozo.html` | **cualquier sesión autenticada** (sin allowlist de rol) | ⚠️ §5.3 |
| `delivery-rider.html` | requiere **ficha `delivery_riders.user_id = auth.uid()`** (no por rol) | sin ficha → pantalla de error |
| `index.html`, `delivery-cliente.html` | público (cliente, sin login) | gate solo por `?r=` |

---

## 4. Reproducción / guía de QA (qué probar por plan y rol)

Cuentas WS0-B (password `Mythos2026!`). Para cada caso, abrir el panel por **URL directa** y observar.

### 4.1 Lo que DEBE seguir bloqueado (hard) — si falla, es bug real
- **Cross-rol:** loguear `caja.napoli` (cajero) y abrir `gerente.html` → debe **rebotar al login** ("rol no autorizado"). Igual `cocina.*` → `gerente.html`; `mozo` → `caja.html`.
- **Superadmin:** loguear cualquier cuenta no-superadmin (admin/gerente/caja/…) y abrir `superadmin.html` → debe **cerrar sesión y rebotar**. (Único panel cross-tenant; verificar con prioridad.)
- **Cross-tenant datos:** logueado en un restaurante, intentar `?r=<UUID de otro restaurante>` en cualquier panel → **no** debe mostrar datos del otro local (RLS). Verificar consola sin filas ajenas.
- **Límite de usuarios:** en Superadmin/Admin, intentar crear un 3.º mozo en Starter (límite 2) → la **DB lo rechaza** (trigger).

### 4.2 Lo que es gating SOFT (esperado, NO bug) — solo UI
- **Hub de paneles (admin):** loguear `admin.napoli` (Starter) → Admin → "Paneles": `gerente`, `delivery-cliente`, `delivery-rider` deben verse con **candado + "Mejorá tu plan"** (no botón compartir). `caja/mozo/cocina` desbloqueados. (En Pro: `delivery-cliente` desbloqueado; `delivery-rider`/`gerente` con candado.)
- **Paywall por feature:** NO va a aparecer en ningún plan (todos tienen las 6 features — §2). Esperado.

### 4.3 Hueco documentado (no bug de datos) — ver §5.1
- **Plan inferior usando panel premium por URL directa:** loguear `gerente.napoli` (Starter) y abrir `gerente.html` → **entra y funciona** (el role guard pasa porque el ROL es gerente; el PLAN no se chequea ahí). Igual `rider1.napoli` (Starter) → `delivery-rider.html` (tiene ficha) → entra. **Solo ve datos de su propio restaurante (RLS).** Esto es el hueco comercial de §5.1.

---

## 5. Hallazgos

### 5.1 (Central) Gating por panel = soft/UI/fail-open, sin refuerzo en paneles standalone
- **Qué:** `allowed_panels` solo se aplica en el hub "Paneles" de `admin` (mostrar candado/upsell). Los paneles standalone (`gerente`, `delivery-cliente`, `delivery-rider`) **no** chequean el plan: si el **rol/ficha** del usuario es válido, se abren por URL directa **aunque el plan no los incluya**.
- **Riesgo:** **comercial/UI** (uso de un panel no pagado). **NO es fuga de datos:** RLS + role guard + RPC tenant-guard siguen intactos → el usuario solo ve su propio tenant; no hay escalada de rol ni cross-tenant.
- **Por qué NO se corrige en WS1:** (a) no hay fuga real de datos → la regla dice evitar RLS/migraciones; (b) el refuerzo "de verdad" es **backend/route enforcement**, explícitamente **diferido en PR-10** (estructural); (c) un gate solo-frontend es **bypasseable** (no es enforcement real) y tocar 3 paneles tiene riesgo de regresión de runtime (precedente: regresiones de gating en PR-5) → sobreingeniería para WS1.
- **Recomendación (PR aparte, no WS1):** gate centralizado de capabilities (idealmente refuerzo backend: política RLS por panel o validación en endpoints), reusando `get_restaurant_capabilities`. Decisión del arquitecto.

### 5.2 (Comercial) `allowed_features` idéntico en los 3 planes → paywall nunca dispara
- Ver nota ⚠️ §2. Es configuración comercial (mig 091 sembró todo a todos), **no bug**. Diferido en PR-10. No se toca ("no rediseñar planes").

### 5.3 (Menor, adyacente a WS2) `mozo.html` sin allowlist de rol
- `mozo.html` acepta **cualquier sesión autenticada** (no chequea `profile.role`). Un cajero/cocina/rider que abra `mozo.html` queda como "mozo". Sigue **tenant-scoped (RLS)** → sin fuga; es laxitud de **rol**, no de plan. Fuera del foco de WS1 (plan-gating); registrar para **WS2** (QA funcional por panel). Fix mínimo futuro: agregar `['mozo','admin','supervisor_local','superadmin']` al guard, alineado con los otros paneles.

### 5.4 (Menor) Catálogo de paneles duplicado
- Las keys de panel viven en 3 lugares: `PANEL_HUB` (`src/admin`), `PANEL_OPTIONS` (`src/superadmin`), `homeForRole` (`public/login.html`). Pequeño y estable. Centralizar exigiría un módulo compartido entre bundles Vite (hoy no existe salvo globals `window.*`) → diferible; no urge. Documentado para evitar drift.

---

## 6. Definición de hecho WS1

- [x] **Matriz canónica documentada** (§2) con fuente de verdad (§1).
- [x] **QA sabe qué probar por plan/rol** (§4): hard-blocks (deben pasar) vs soft-gating (esperado) vs hueco documentado.
- [x] **Starter/Pro/Enterprise** muestran lo que corresponde **a nivel de hub admin** (soft); a nivel datos, RLS aísla por tenant.
- [~] **URL directa no permite uso indebido:** ✅ para lo grave (cross-rol, cross-tenant, superadmin, límites = **hard-blocked**); ❌ para uso de panel premium del mismo tenant (**soft only → hueco comercial documentado §5.1**, sin fuga de datos).
- [x] **Fallas reales:** ninguna de seguridad. Las gaps son comerciales/UI → **marcadas como limitación documentada**, no corregidas (por las reglas de WS1).
- [x] `npm run build` PASS.

**WS1 = PASS de auditoría, con limitación comercial documentada (§5.1/§5.2).** No se modificó producto.

---

## 7. Recomendación

- **Mergear WS1 como checkpoint de auditoría** (solo doc) y **enviar a QA visual/funcional** para confirmar en la app real las filas hard-block de §4.1 (especialmente superadmin y cross-tenant) y el comportamiento del hub admin §4.2.
- **NO** construir enforcement de plan-panel en WS1. Si el arquitecto quiere cerrar el hueco §5.1, abrir un **PR dedicado** (preferible refuerzo backend, reusando `get_restaurant_capabilities`), separado de la estabilización.
- Diferidos comerciales (§5.2 features por plan) y estructurales (§5.1 enforcement) quedan para después de FASE C, salvo decisión contraria.
