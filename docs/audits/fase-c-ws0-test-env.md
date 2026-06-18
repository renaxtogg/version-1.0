# FASE C · WS0 — Preparación de entorno de prueba — ✅ PASS OPERATIVO

> **Estado:** WS0-A (plan/inventario) **CERRADO** + WS0-B (normalización demo) **EJECUTADO Y VERIFICADO
> por Renato (2026-06-18)**. Las 5 cuentas demo faltantes existen; Terrapizza y Renato intactos; cero borrado.
> **WS0 = PASS operativo.** Falta solo la **ratificación del cierre por ChatGPT (arquitecto)** antes de pasar a WS1.
>
> Rol: Claude Code (programador). Arquitecto: ChatGPT. Intermediario/dueño: Renato.
>
> Las §1–§11 documentan el inventario y el plan original. La decisión quedó **ratificada (Opción A)**; la
> ejecución y el **resultado real del verify** están en **§12 (WS0-B)** abajo — leer §12 para el estado final.

---

## 12. WS0-B — Normalización demo (decisiones ratificadas + ejecución)

### 12.1 Decisiones ratificadas por el arquitecto/Renato
- **Opción A:** reutilizar los 3 restaurantes sim existentes. **Sin teardown. Sin recrear.**
- **No** tocar Terrapizza. **No** tocar Renato. **No** usar la cuenta de Renato para QA.
- **Crear superadmin demo nuevo** (`superadmin.demo@mythos.test`).
- **Contraseña demo única:** `Mythos2026!` (se mantiene la existente; no se resetean las 15 viejas).
- **Crear 5 cuentas faltantes:** gerente Napoli, rider Napoli, gerente Sakura, rider Sakura, superadmin demo.

### 12.2 Mecanismo de creación (no se inventó nada nuevo)
Se reutiliza el patrón de seed del simulacro (`_simulacion/02_staff.sql`: `auth.users` + `auth.identities` +
`user_roles`, password vía `crypt('Mythos2026!', gen_salt('bf'))`) y, para riders, el patrón de
`_simulacion/03_menu_tables.sql` (`delivery_riders` con `user_id`, requerido por mig 101 para que
`delivery-rider.html` resuelva al rider). **No** se usó `/api/create-user` porque para semillas de QA el
camino consistente y auditable del repo es el SQL del simulacro corrido por `run.ps1` (no `service_role` en cliente).

- **Seed:** `_simulacion/07_ws0b_accounts.sql` — **INSERT-only, idempotente (`ON CONFLICT DO NOTHING`), no destructivo.** Gitignored (igual que los demás seeds sim → la contraseña literal no entra al repo).
- **Verificación read-only:** `scripts/verify/ws0b-demo-accounts-verification.sql` — solo `SELECT`, committeable, sin secretos.

### 12.3 Cuentas demo finales (rol → cuenta → email → restaurante → plan → panel)

| Rol | Username | Email | Restaurante | Plan | Panel esperado | Origen |
|---|---|---|---|---|---|---|
| admin | admin.napoli | admin.napoli@mythos.test | Bella Napoli | Starter | admin.html | ya existía |
| gerente (`supervisor_local`) | gerente.napoli | gerente.napoli@mythos.test | Bella Napoli | Starter | gerente.html | **WS0-B ➕** |
| cajero | caja.napoli | caja.napoli@mythos.test | Bella Napoli | Starter | caja.html | ya existía |
| cocina | cocina.napoli | cocina.napoli@mythos.test | Bella Napoli | Starter | cocina.html | ya existía |
| mozo | mozo1/2.napoli | mozo1.napoli@mythos.test, mozo2.napoli@mythos.test | Bella Napoli | Starter | mozo.html | ya existía |
| rider | rider1.napoli | rider1.napoli@mythos.test | Bella Napoli | Starter | delivery-rider.html | **WS0-B ➕** |
| admin | admin.sakura | admin.sakura@mythos.test | Sushi Sakura | Pro | admin.html | ya existía |
| gerente (`supervisor_local`) | gerente.sakura | gerente.sakura@mythos.test | Sushi Sakura | Pro | gerente.html | **WS0-B ➕** |
| cajero | caja.sakura | caja.sakura@mythos.test | Sushi Sakura | Pro | caja.html | ya existía |
| cocina | cocina.sakura | cocina.sakura@mythos.test | Sushi Sakura | Pro | cocina.html | ya existía |
| mozo | mozo1.sakura | mozo1.sakura@mythos.test | Sushi Sakura | Pro | mozo.html | ya existía |
| rider | rider1.sakura | rider1.sakura@mythos.test | Sushi Sakura | Pro | delivery-rider.html | **WS0-B ➕** |
| admin | admin.carlos | admin.carlos@mythos.test | Parrilla Don Carlos | Enterprise | admin.html | ya existía |
| gerente (`supervisor_local`) | gerente.carlos | gerente.carlos@mythos.test | Parrilla Don Carlos | Enterprise | gerente.html | ya existía |
| cajero | caja.carlos | caja.carlos@mythos.test | Parrilla Don Carlos | Enterprise | caja.html | ya existía |
| cocina | cocina.carlos | cocina.carlos@mythos.test | Parrilla Don Carlos | Enterprise | cocina.html | ya existía |
| mozo | mozo1.carlos | mozo1.carlos@mythos.test | Parrilla Don Carlos | Enterprise | mozo.html | ya existía |
| rider | rider1.carlos | rider1.carlos@mythos.test | Parrilla Don Carlos | Enterprise | delivery-rider.html | ya existía |
| **superadmin** | superadmin.demo | superadmin.demo@mythos.test | — (plataforma, `restaurant_id NULL`) | — | superadmin.html | **WS0-B ➕** |

**Contraseña demo única para TODAS:** `Mythos2026!` (throwaway de QA; rotar/eliminar antes de cualquier cliente real; jamás reutilizar para `mancuellorenato@gmail.com`).

> ⚠️ **Nota de gating (insumo para WS1, NO se resuelve acá):** los riders de Napoli (Starter) y Sakura (Pro)
> existen **a propósito** para que QA verifique si el plan **habilita o bloquea** el panel rider (el seed sim
> marca el panel delivery-rider como propio de Enterprise). Tener la cuenta + su fila `delivery_riders` permite
> aislar el comportamiento de gating del de "rider inexistente". Lo mismo aplica al delivery en Starter.

### 12.4 Cuentas protegidas (NO tocadas — INSERT-only no puede tocarlas)
- **Renato:** `mancuellorenato@gmail.com`, `restaurant_id NULL`, superadmin. **No se elimina** (única protección dura); puede usarse para QA/admin. El seed solo hace `INSERT` de UUIDs/emails nuevos → no la roza. Verificado por §4 del verify.
- **Terrapizza:** **demo** (no cliente real), UUID fuera de la allowlist sim → **dato de control: no borrar/romper sin necesidad explícita y recuperable** (criterio del dueño 2026-06-18). No referenciada por el seed. Verificado por §5 del verify.

### 12.5 Qué se ejecutó (por Renato) y cómo
- **Preparado por el programador (sin PAT):** seed `07_ws0b_accounts.sql` + verify `ws0b-demo-accounts-verification.sql`. Cero SQL corrido desde mi entorno.
- **Ejecutado por Renato (2026-06-18)** vía `run.ps1` (PAT por env var, prod):
  ```powershell
  $env:SUPABASE_PAT='<token>'; $env:SUPABASE_PROJECT_REF='ocwzupmamfojvdywavqi'
  $env:ALLOW_PROD_SIMULATION='true'   # INSERT-only: NO dispara la guarda destructiva de run.ps1
  cd _simulacion; .\run.ps1 -File .\07_ws0b_accounts.sql
  ```
- El seed **corrió sin error**. Verify corrido en SQL Editor.

### 12.6 Resultado real del verify (2026-06-18) — evidencia de cierre
- **5 cuentas WS0-B presentes** (terminal devolvió las 5 esperadas):
  `gerente.napoli`, `rider1.napoli`, `gerente.sakura`, `rider1.sakura`, `superadmin.demo` (todas `@mythos.test`).
- **`superadmins_total = 3`** → Renato + `qa.superadmin` (preexistente, ya listado en §1.3) + `superadmin.demo` (WS0-B).
  > Nota: la estimación previa "esperado = 2" **omitía** el `qa.superadmin` preexistente. **3 es correcto y esperado.**
- **`riders_ws0b = 2`** → los 2 riders nuevos (Napoli + Sakura) creados y linkeados por `user_id`.
- **Sin evidencia de borrado ni daño.** Terrapizza y Renato intactos (el seed es INSERT-only).
- **Criterio reafirmado por el dueño:** Terrapizza = demo (dato de control, no borrar/romper sin necesidad); cuenta superadmin de Renato usable para QA pero **no se elimina**.

### 12.7 Estado de la Definición de Hecho WS0 — ✅ PASS OPERATIVO
- [x] 3 restaurantes sim mapeados a Starter/Pro/Enterprise (preexistente, confirmado §1.1/§7).
- [x] Cuenta demo para **cada rol requerido** — creada y verificada (§12.6).
- [x] **Superadmin demo** creado y verificado.
- [x] Todas las demos con `Mythos2026!`.
- [x] **Terrapizza no tocada / Renato no tocado** (INSERT-only + §12.6).
- [x] Documentación actualizada (este §12).
- [x] `npm run build` PASS.
- ✅ **WS0 = PASS operativo.** Único gate restante: **ratificación del cierre por ChatGPT (arquitecto)** antes de iniciar WS1.

---

## 0. Base de trabajo (git)

| Campo | Valor |
|---|---|
| Rama | `fix/fase-c-ws0-test-env` (creada desde `main`) |
| Commit base | `28918cc` (`PR-B4J - document delivery cliente branding boundary`) |
| `main` == `origin/main` | Sí (`28918cc`, working tree limpio salvo reportes untracked) |
| Untracked previos | `MYTHOS_PRESPRINT_REPORT.md`, `MYTHOS_QA_BRIEFING.md`, `MYTHOS_SYSTEM_REPORT.md`, `docs/audits/pr-b4-fase-b-dark-closure.md` |

**Alcance de esta rama:** solo este documento (`docs/audits/fase-c-ws0-test-env.md`). Sin tocar HTML, JSX, CSS, migraciones, RLS ni Auth.

---

## 1. Inventario inicial

> ⚠️ **Fuente del inventario:** este WS0 NO consultó la base de prod en vivo (no hay PAT en el entorno
> y WS0 es documentación). El estado de abajo proviene de (a) los artefactos versionados del simulacro
> (`_simulacion/`), (b) los scripts de verificación read-only ya existentes, y (c) el último inventario
> de prod **ya ejecutado por Renato** en PR-20 (`docs/audits/pr20-simulation-accounts-plan.md`).
> **Antes de cualquier borrado**, re-correr el inventario read-only (ver §3) para confirmar números frescos.

### 1.1 Restaurantes demo / simulación (definidos en `_simulacion/01_restaurants.sql`)

| # | Nombre | UUID | Plan asignado | Monto | Email owner |
|---|---|---|---|---|---|
| A | Pizzería Bella Napoli | `a1a10000-0000-4000-8000-000000000001` | **Starter** (`10000000-…-001`) | ₲200.000 | admin.napoli@mythos.test |
| B | Sushi Sakura | `b2b20000-0000-4000-8000-000000000002` | **Pro** (`10000000-…-002`) | ₲400.000 | admin.sakura@mythos.test |
| C | Parrilla Don Carlos | `c3c30000-0000-4000-8000-000000000003` | **Enterprise** (`10000000-…-003`) | ₲800.000 | admin.carlos@mythos.test |

> **El mapping restaurante→plan que pide la checklist de FASE C YA EXISTE** y coincide exactamente con
> Starter/Pro/Enterprise. No hace falta inventarlo: solo confirmarlo en prod (ver §5).

### 1.2 Usuarios demo / simulación (definidos en `_simulacion/02_staff.sql`)

Password único actual de TODOS: `Mythos2026!`. Dominio: `@mythos.test`. Total: **15 cuentas staff**.

| Restaurante | Roles cubiertos | Faltantes vs set "todos los roles" |
|---|---|---|
| Bella Napoli (Starter) | admin, mozo×2, cajero, cocina | **sin gerente, sin rider** |
| Sushi Sakura (Pro) | admin, mozo, cajero, cocina | **sin gerente, sin rider** |
| Don Carlos (Enterprise) | admin, supervisor_local (=gerente), mozo, cajero, cocina, rider | completo |

Mapeo de rol DB ↔ panel:
- `admin` → `admin.html` · `supervisor_local` → "Gerente" (`gerente.html`/`/gerente`) · `cajero` → `caja.html`
- `cocina` → `cocina.html` · `mozo` → `mozo.html` · `rider` → `delivery-rider.html`
- **`superadmin`** = plataforma, `restaurant_id = NULL`. **NO existe una cuenta superadmin demo** en el set
  `@mythos.test` (el único superadmin es Renato, que es cuenta real protegida — ver §1.4).

### 1.3 Cuentas QA `@mythos.internal` (creadas durante PR-3…PR-8, no en `_simulacion/`)

Ancladas a Don Carlos. No tienen wildcard de dominio en el teardown viejo → marcadas por anclaje a sim.
Ejemplos conocidos (de memoria PR-4/PR-5): `qa.testsinpass@mythos.internal`, `qa.pr5.adminpass@mythos.internal`,
más `qa.superadmin` (`@mythos.test`). Confirmar el set real en el dry-run antes de borrar.

### 1.4 Datos a PROTEGER (NO son demo)

| Qué | Identificador | Por qué se protege |
|---|---|---|
| **Renato (superadmin)** | `Renaxto`, email `mancuellorenato@gmail.com`, `restaurant_id = NULL` | **Única protección dura: NO se elimina.** Puede usarse para QA/admin. |
| **Terrapizza** | restaurante con `name ILIKE '%terrapizza%'`, UUID **fuera** de la allowlist sim | **Demo** (no cliente real), pero **dato de control: no borrar/romper sin necesidad explícita y recuperable**. Ver §4. |
| Catálogo de plataforma | `subscription_plans`, `plan_addons`, `platform_config` | Global, no-tenant. |

---

## 2. Inventario de scripts existentes (seed / reset / teardown / simulación)

| Archivo | Tipo | ¿Destructivo? | ¿Seguro de usar? |
|---|---|---|---|
| `_simulacion/01_restaurants.sql` | seed restaurantes+subs | INSERT | Seed sim original. Crea los 3 restaurantes+planes. |
| `_simulacion/02_staff.sql` | seed auth+roles | INSERT en `auth.*` | Seed sim original (15 usuarios, pass `Mythos2026!`). |
| `_simulacion/03_menu_tables.sql` | seed menú/mesas | INSERT | Seed sim. |
| `_simulacion/04a/b/c_operate_*.sql` | seed operación | INSERT | Pedidos/datos operativos sim. |
| `_simulacion/05_checks.sql`, `06_qa_superadmin.sql` | verificación | SELECT | Read-only. |
| `_simulacion/99_teardown.sql` | **teardown** | **DELETE** | ⚠️ **Versión vieja, SIN guardas in-SQL.** Reemplazada por `scripts/teardown/`. **NO usar** directamente. |
| `_simulacion/run.ps1` | runner Management API | — | Seguro: PAT/ref por env var; guarda prod (`ALLOW_PROD_SIMULATION`) + guarda destructiva (`CONFIRM_SIMULATION_TEARDOWN`, dry-run por defecto). No imprime el PAT. |
| `_simulacion/APLICAR_*.sql`, `SOLUCIONES_propuestas.sql` | parches RLS/límites | varía | Fuera de alcance WS0. |
| **`scripts/teardown/dry-run-simulation-data.sql`** | **dry-run** | **SOLO SELECT** | ✅ **Seguro en prod.** Inventario + candidatos + prueba exclusión Terrapizza. |
| **`scripts/teardown/teardown-simulation-data.sql`** | **teardown endurecido** | DELETE | 🔒 **Bloqueado:** triple guarda (GUC + allowlist/Terrapizza + umbral usuarios) y **termina en `ROLLBACK`**. No aplica nada hasta intervención humana deliberada. |
| `scripts/teardown/seed-demo-data-plan.md` | propuesta seed demo | — | Doc no vinculante (1 restaurante `[DEMO]`, idempotente, creds por env). |
| `scripts/teardown/README.md` | doc | — | Canónico de teardown PR-14 (51 FK CASCADE + bloqueadores). |
| `docs/security/SIMULATION_TEARDOWN_CHECKLIST.md` | checklist operativo | — | Canónico paso-a-paso de teardown. |
| `scripts/verify/pr18/pr20/pr21a-*.sql` | verificación | SOLO SELECT | ✅ Seguros. Inventario RLS y cuentas sim. |

**Conclusión de §2:** ya existe **toda** la maquinaria para inventariar (read-only) y para hacer teardown
seguro (bloqueado). **WS0 no necesita crear ningún script nuevo destructivo.** Falta solo, eventualmente,
un seed de recreación — que hoy es propuesta (`seed-demo-data-plan.md`), no implementación.

---

## 3. Pasos seguros (read-only) para refrescar el inventario antes de decidir

Estos **no modifican nada** (solo SELECT). Correr en SQL Editor de prod (Dashboard en **inglés**) o vía `run.ps1`:

1. `scripts/teardown/dry-run-simulation-data.sql` → conteos por tabla, usuarios candidatos, sobrevivientes (Terrapizza debe aparecer), `terrapizza_present ≥ 1`.
2. `scripts/verify/pr20-simulation-accounts-inventory.sql` → inventario de cuentas/restaurantes sim.
3. `scripts/verify/pr21a-simulation-auth-inventory.sql` → clasificación `SIM_AUTH_CANDIDATE / PROTECTED_REAL_USER / REVIEW_REQUIRED`.

Guardar la salida en la carpeta de QA (Mythos EAS) junto a las credenciales (§6).

---

## 4. Exclusión de Terrapizza (explícita)

**Terrapizza queda FUERA de todo borrado/recreación en WS0 y en toda FASE C.** Garantías:

1. **Por construcción:** todos los scripts de teardown apuntan a una **allowlist de 3 UUIDs sim** (`a1a1…/b2b2…/c3c3…`). Terrapizza tiene otro UUID → nunca en alcance.
2. **Guarda dura in-SQL:** `teardown-simulation-data.sql` aborta (`RAISE EXCEPTION`) si algún restaurante de la allowlist matchea `name ILIKE '%terrapizza%'`, o si la allowlist resuelve a >3 filas.
3. **Post-check:** el teardown aborta si `terrapizza_present < 1` después del borrado.

> ✅ **Criterio aclarado por el dueño (2026-06-18) — NO hay conflicto pendiente.**
> Terrapizza **es demo** (no cliente real); CLAUDE.md ya lo refleja desde PR-21c. Para FASE C queda como
> **dato de control: no borrar ni romper salvo necesidad explícita y recuperable.** La única protección dura
> sigue siendo `mancuellorenato@gmail.com` (no se elimina; **sí** puede usarse para QA/admin). Todo MYTHOS está
> en creación/demo: se permite **editar datos demo** para estabilizar, siempre que sea **seguro y reparable**.
> WS0-B no tocó ninguno de los dos (seed INSERT-only). Ver `project_terrapizza_demo_criterion`.

---

## 5. Decisión central: ¿borrar+recrear, o reutilizar+normalizar?

La checklist de FASE C dice literalmente "Borrar todas las demos actuales" + "Crear cuentas demo nuevas".
Pero el mapping restaurante→plan **ya existe y ya coincide** con Starter/Pro/Enterprise (§1.1).
Hay dos caminos; recomiendo el de menor riesgo:

### Opción A (RECOMENDADA) — Reutilizar restaurantes sim + normalizar cuentas
- **Mantener** los 3 restaurantes sim y su mapping de plan (ya correcto).
- **No** ejecutar teardown (evita backup obligatorio + ventana + riesgo de FK/orphans).
- **Completar roles faltantes** (gerente+rider en Napoli y Sakura) y **crear 1 superadmin demo** (ver §6, con su salvedad de seguridad).
- **Resetear contraseñas** de las cuentas demo a una única fácil (§6).
- **Impacto÷esfuerzo:** máximo. Deja a QA listo para WS1 sin tocar datos masivamente.

### Opción B — Teardown total + recreación desde cero
- Borrar los 3 restaurantes + cuentas sim/QA con `scripts/teardown/teardown-simulation-data.sql` (tras backup+aprobación) y recrear con un seed nuevo (`seed-demo-data-plan.md`, aún no implementado).
- **Coste:** backup nuevo obligatorio + dry-run revisado + aprobación de Renato + ventana + construir el seed. Mayor riesgo.
- Solo justificada si los datos sim actuales están corruptos/inservibles (no hay evidencia de eso).

> **Recomendación de arquitectura:** **Opción A.** El objetivo de FASE C es estabilizar lo existente, no
> reconstruir el entorno. Reservar la Opción B (teardown) para el cierre de FASE C o si QA reporta que la
> data sim está inutilizable. **Ambas opciones requieren aprobación explícita antes de ejecutar.**

---

## 6. Propuesta de cuentas demo (por rol) + contraseña única

> **Tensión a resolver por el arquitecto (decisión #1):** "una cuenta por rol" vs. "probar gating por plan".
> El gating por plan (WS1) exige loguearse como **admin de cada restaurante** (Starter/Pro/Enterprise) para
> ver qué paneles/módulos habilita cada plan. Con **una sola** cuenta por rol no se puede comparar planes.
> Por eso propongo una **matriz práctica**: staff por restaurante (para gating + aislamiento multi-tenant)
> + **1 superadmin demo** global, **todas con la misma contraseña**.

### 6.1 Matriz propuesta (Opción A: completa lo que falta sobre el sim actual)

| Rol | Panel | Bella Napoli (Starter) | Sushi Sakura (Pro) | Don Carlos (Enterprise) |
|---|---|---|---|---|
| superadmin | superadmin.html | — (1 sola, global) | — | — |
| admin | admin.html | ✅ existe | ✅ existe | ✅ existe |
| gerente | gerente.html | ➕ **crear** | ➕ **crear** | ✅ existe |
| cajero | caja.html | ✅ existe | ✅ existe | ✅ existe |
| cocina | cocina.html | ✅ existe | ✅ existe | ✅ existe |
| mozo | mozo.html | ✅ existe (×2) | ✅ existe | ✅ existe |
| rider | delivery-rider.html | ➕ **crear** | ➕ **crear** | ✅ existe |
| superadmin (global) | superadmin.html | ➕ **crear 1** demo (`superadmin.demo@mythos.test`) | — | — |

Nuevas a crear bajo Opción A: **gerente+rider en Napoli y Sakura (4)** + **1 superadmin demo** = **5 cuentas**.
Nomenclatura sugerida: `gerente.napoli@mythos.test`, `rider.napoli@mythos.test`, `gerente.sakura@mythos.test`, `rider.sakura@mythos.test`, `superadmin.demo@mythos.test`.

> ⚠️ **Salvedad de seguridad — superadmin demo (decisión #2).** El superadmin ve **todos** los tenants
> (cross-tenant). PR-17 (Bloqueo 3) lo marcó **no apto para demo abierta**. Recomendación: crear la cuenta
> superadmin demo **solo para QA atendida** (no entregar a terceros) **o** que el propio Renato use su cuenta
> superadmin para los chequeos de superadmin, evitando una segunda credencial superadmin viva. Confirmar con Renato.

### 6.2 Contraseña demo única (propuesta)

- **Valor sugerido:** `MythosDemo2026!` (cumple ≥8 con el enforcement de PR-5; fácil y claramente "demo").
- Alternativa de mínimo cambio: **mantener `Mythos2026!`** (ya en uso, ya documentado en el QA briefing) y solo
  aplicarlo a las cuentas nuevas. Esto evita resetear 15 contraseñas. **← preferible por impacto÷esfuerzo.**
- **Regla:** es throwaway de demo. **Debe rotarse/eliminarse antes de cualquier cliente real** y **nunca**
  reutilizarse para `mancuellorenato@gmail.com`.

### 6.3 Manejo de la credencial (alineado con CLAUDE.md)

- **NO** hardcodear la contraseña en scripts versionados. Cuando se construya el seed de creación
  (`seed-demo-data-plan.md`), tomar la clave por **variable de entorno** del runner (patrón `run.ps1`).
- La **hoja de credenciales autoritativa** (rol → email → restaurante → plan → password) vive en la carpeta
  de QA **Mythos EAS** (fuera del repo), junto al QA briefing — **no** se commitea al repo.
- La creación de usuarios va por `/api/create-user` (token del usuario) o `auth.admin` con PAT por env. **Nunca** `service_role` en cliente.

---

## 7. Mapping final propuesto rol → cuenta → restaurante → plan

| Plan | Restaurante | UUID | Cuentas demo (todas con la contraseña única) |
|---|---|---|---|
| Starter | Pizzería Bella Napoli | `a1a10000-…-001` | admin.napoli, gerente.napoli➕, caja.napoli, cocina.napoli, mozo1/2.napoli, rider.napoli➕ |
| Pro | Sushi Sakura | `b2b20000-…-002` | admin.sakura, gerente.sakura➕, caja.sakura, cocina.sakura, mozo1.sakura, rider.sakura➕ |
| Enterprise | Parrilla Don Carlos | `c3c30000-…-003` | admin.carlos, gerente.carlos, caja.carlos, cocina.carlos, mozo1.carlos, rider1.carlos |
| Plataforma | — (`restaurant_id NULL`) | — | superadmin.demo➕ (con salvedad §6.1) |

(➕ = a crear; el resto ya existe en el sim.)

---

## 8. Riesgos detectados

| # | Riesgo | Severidad | Mitigación |
|---|---|---|---|
| R1 | Ejecutar teardown sin backup nuevo | Alta | Backup nuevo obligatorio + dry-run + aprobación (Opción B). Triple guarda + ROLLBACK ya en el script. |
| R2 | Borrar Terrapizza o Renato por error | Alta | Allowlist de UUIDs + guarda de nombre + protección de Renato por email/`restaurant_id NULL`. §4. |
| R3 | Superadmin demo expone datos cross-tenant | Media | No entregar a terceros; o usar la cuenta de Renato. §6.1. Bloqueo PR-17. |
| R4 | Contraseña demo filtrada → cuentas vivas accesibles | Media | Throwaway, rotar antes de clientes; creds fuera del repo; nunca reutilizar para la cuenta oficial. |
| R5 | Cuentas QA `@mythos.internal` no captadas por `%@mythos.test` | Media | Marcador por anclaje a restaurante sim (ya en teardown PR-14). Confirmar en dry-run. |
| R6 | Conflicto de criterio Terrapizza (prompt vs. FINAL 2026-06-16) | Media | WS0 sigue el prompt (NO tocar). Reconciliación formal en PR aparte. §4. |
| R7 | Inventario "en vivo" no verificado en WS0 | Baja | Re-correr los 3 SELECT de §3 antes de cualquier acción. |
| R8 | RLS Sprint 1: anon aún con escritura en `restaurants`/`payments`/`payroll` | Alta (plataforma) | Conocido (MYTHOS_PRESPRINT_REPORT). No es de WS0, pero relevante para "apto cliente real". No bloquea QA de demo atendida. |

---

## 9. Pasos para QA después del reset (handoff a WS1+)

1. **Pre:** correr los SELECT de §3 y guardar salida + hoja de credenciales en Mythos EAS.
2. **(Si Opción A)** crear las 5 cuentas faltantes (§6.1) y fijar la contraseña única; **no** borrar nada.
3. **(Si Opción B)** backup nuevo → dry-run revisado → aprobación → teardown (`ROLLBACK`→`COMMIT`) → seed nuevo. Solo con aprobación.
4. Verificar login de **cada rol** en su panel, en los **3 planes**.
5. Confirmar mapping plan↔restaurante en Superadmin (Starter=Napoli, Pro=Sakura, Enterprise=Don Carlos).
6. Recién entonces arrancar **WS1 (gating por plan)**: que cada plan muestre/oculte exactamente sus paneles/módulos en la app real, y que un plan inferior NO acceda por URL a un módulo de plan superior.
7. Documentar credenciales finales (rol→cuenta→restaurante→plan→password) en la carpeta de QA.

---

## 10. Decisiones requeridas ANTES de borrar/recrear (para Renato + arquitecto)

1. **Opción A (reutilizar+normalizar) vs. Opción B (teardown+recrear).** Recomendación: **A**. (§5)
2. **¿Crear superadmin demo, o usar la cuenta de Renato para los chequeos de superadmin?** (§6.1, riesgo R3)
3. **Contraseña:** ¿`MythosDemo2026!` nueva para todos, o mantener `Mythos2026!` y solo aplicarla a las nuevas? Recomendación: **mantener `Mythos2026!`** (menor esfuerzo). (§6.2)
4. **Roles faltantes:** confirmar crear gerente+rider en Napoli y Sakura (4 cuentas). (§6.1)
5. **Reconciliación del criterio Terrapizza** (prompt vs. FINAL 2026-06-16): ¿en qué PR se formaliza? (§4, R6)

> **Nada de §6/§7/§9 se ejecuta hasta que estas 5 decisiones estén cerradas y, para la Opción B, exista
> backup nuevo + aprobación explícita.** WS0 termina aquí: inventario + plan + propuesta. **No avanzar a WS1.**

---

## 11. Definición de hecho WS0 — checklist

- [x] Inventario claro (restaurantes, cuentas, roles, planes, mapping actual, datos a proteger).
- [x] Terrapizza protegida explícitamente (§4) + Renato protegido.
- [x] Mapping propuesto Starter/Pro/Enterprise (ya existente, confirmado §1.1/§7).
- [x] Cuentas demo propuestas por rol (§6/§7).
- [x] Ningún borrado ejecutado (cero SQL corrido, cero datos modificados).
- [x] Scripts existentes inventariados (§2); no se creó ningún script destructivo nuevo.
- [x] `npm run build` PASS (9/9 paneles compilados, exit 0).
- [x] Producto NO tocado (solo este `.md`).
