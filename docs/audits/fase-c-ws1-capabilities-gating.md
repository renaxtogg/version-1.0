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
- **➡️ Corregido en WS1-B (§8):** el arquitecto decidió cerrarlo dentro de FASE C con un gate **frontend fail-closed** (reusando la capability existente). El refuerzo **backend** sigue recomendado como evolución posterior.

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

> **Actualización:** el arquitecto decidió cerrar el hueco §5.1 dentro de FASE C → implementado en **§8 (WS1-B)** abajo.

---

## 8. WS1-B — Fix mínimo de gating por URL directa

### 8.1 Bug corregido
Paneles **premium standalone** abrían por URL directa en planes que NO los incluyen (hueco §5.1):
`gerente.html`, `delivery-rider.html`, `delivery-cliente.html?r=…`. Ahora cada uno **valida el plan del
restaurante** (vía `allowed_panels`) y, si el panel no está incluido, **no carga datos del módulo** y muestra
una pantalla simple de "no disponible". **Fail-closed:** si no se puede confirmar la capability → se bloquea.

### 8.2 Archivos tocados
| Archivo | Cambio | ¿Migración? |
|---|---|---|
| `src/gerente/main.jsx` | Hook `usePlanGate('gerente')` (RPC `get_restaurant_capabilities`, fail-closed) + componente `PlanLock` + 2 efectos de conteo gateados + 2 ramas de render. | No |
| `src/delivery-rider/main.jsx` | Tras resolver la ficha del rider, chequea `allowed_panels.includes('delivery-rider')` antes de `startRiderSession`; si no, reusa la pantalla `error` con mensaje de plan. Fail-closed. | No |
| `src/delivery-cliente/main.jsx` | Panel **anónimo** → nueva RPC anon-safe `restaurant_panel_enabled` (no sirve `get_restaurant_capabilities`, que da NULL a anon). Estado `planStatus` + `GateScreen kind="plan"`; solo carga menú/zonas si el plan incluye `delivery-cliente`. Fail-closed. | **Sí (109)** |
| `supabase/migrations/20260618_109_restaurant_panel_enabled.sql` | Nueva RPC `restaurant_panel_enabled(rid, panel) → boolean`, SECURITY DEFINER, GRANT anon. Espeja la unión plan∪add-ons de la 090/108; solo expone un boolean por (restaurante, panel). **PREPARADA, NO APLICADA** (la aplica Renato). | — |

Sin tocar `allowed_features`, ni planes, ni RLS, ni Auth. No se rediseñó nada comercial.

### 8.3 Antes / Después
| Caso | Antes | Después |
|---|---|---|
| `gerente.napoli` (Starter) → `gerente.html` | entra y opera | **bloqueado** ("Módulo no disponible", sin cargar datos) |
| `rider1.napoli` (Starter) → `delivery-rider.html` | entra (tiene ficha) | **bloqueado** (pantalla error con mensaje de plan) |
| `delivery-cliente.html?r=<Napoli/Starter>` | carga menú y deja pedir | **bloqueado** ("Delivery no disponible", sin cargar menú) |
| `gerente.sakura` (Pro) → `gerente.html` | entra | **bloqueado** (Pro no incluye gerente) |
| `rider1.sakura` (Pro) → `delivery-rider.html` | entra | **bloqueado** (Pro no incluye rider) |
| `delivery-cliente.html?r=<Sakura/Pro>` | carga | **permitido** (Pro incluye delivery-cliente) |
| Don Carlos (Enterprise): gerente / rider / delivery-cliente | entra | **permitido** (todo incluido) — sin cambio de comportamiento |

### 8.4 Matriz final (paneles premium por plan, con enforcement WS1-B)
| Panel | Starter (Napoli) | Pro (Sakura) | Enterprise (Don Carlos) | Capa de enforcement |
|---|---|---|---|---|
| `gerente` | ❌ bloqueado | ❌ bloqueado | ✅ permitido | frontend fail-closed (`get_restaurant_capabilities`) |
| `delivery-rider` | ❌ bloqueado | ❌ bloqueado | ✅ permitido | frontend fail-closed (`get_restaurant_capabilities`) |
| `delivery-cliente` | ❌ bloqueado | ✅ permitido | ✅ permitido | frontend fail-closed (`restaurant_panel_enabled`, mig 109) |
| `caja`/`mozo`/`cocina` | ✅ | ✅ | ✅ | en todos los planes (sin gate) |
| `admin` | ✅ (rol) | ✅ | ✅ | role guard (no es panel de plan) |

### 8.5 Comportamiento del gate
- **Bloqueado:** pantalla simple ("no disponible"); **no** se cargan datos del módulo; navegación no se rompe; sin error de consola; sin fuga cross-tenant (no se consulta data del tenant).
- **Permitido:** comportamiento idéntico al previo.
- **Fail-closed:** error de RPC / `null` / sin `allowed_panels` / sin restaurante / sin backend → **bloquea**.

### 8.6 Verificación
- `npm run build` **PASS** (9/9). Lógica validada contra la matriz (mig 090) + guards reales.
- ⚠️ **No se ejecutó la app en vivo** (sin credenciales prod en el entorno; además delivery-cliente exige aplicar mig 109 antes). La verificación por plan/rol queda para **QA real** con las cuentas WS0-B (ver §8.3 como guion exacto).

### 8.7 Riesgo residual
- **Orden de despliegue (delivery-cliente):** mig **109 debe aplicarse ANTES** de desplegar el front. El gate es fail-closed: sin la función, `delivery-cliente` se bloquea para **todos** los planes (incl. Enterprise/Pro). Documentado en la cabecera de la migración.
- **Fail-closed transitorio:** un error puntual de la RPC bloquea temporalmente a un usuario legítimo (Enterprise) hasta reintentar. Es el costo elegido de "fail-closed".
- **Sigue siendo gate de frontend** (bypasseable por un atacante técnico). No hay fuga de datos (RLS + role guard intactos). El **refuerzo backend** (RLS/route) sigue recomendado como evolución futura (§7), fuera de WS1-B.
- **mozo** sin allowlist de rol (§5.3) **no** se tocó (es rol-guard, no plan-gating) → queda para WS2.
- Superadmin que abra un panel premium **con contexto de un tenant de plan inferior** también queda gateado (usa la propia herramienta superadmin). Aceptado.
