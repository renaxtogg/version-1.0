# PR-15 — Auditoría final post-remediation

> **Tipo:** auditoría read-only + documentación. **No cambia producto.**
> **Fecha:** 2026-06-16. **Autor:** Claude Code (programador). **Para:** Renato (fundador) + ChatGPT (arquitecto).
> **Alcance:** mapa honesto del estado real del sistema tras cerrar la lista original de remediación.
> Nada de DB/RLS/RPC/migraciones/frontend/backend/datos fue tocado. Teardown y dry-run **NO** ejecutados.

---

## 1. Estado base

| Campo | Valor |
|---|---|
| Commit base | `main` = `origin/main` = **`429882d`** (merge PR-14, no-ff; producto `02bbbb7`) |
| Rama de esta auditoría | `audit/pr-15-post-remediation` (creada desde `429882d`) |
| Producción | `https://mythos-pos.vercel.app` (Vercel proyecto `mythos`, team `renaxtoggs-projects`) |
| Supabase | proyecto `ocwzupmamfojvdywavqi` (PostgreSQL + Auth + RLS + Realtime + Storage) |
| Última migración en repo | `20260616_108_harden_get_restaurant_capabilities.sql` |
| Último PR cerrado | PR-14 (plan de teardown, prepared only) |

**Qué NO fue tocado en PR-15:** DB, RLS, RPC, policies, migraciones (no se creó ninguna), frontend, backend/runtime, datos productivos, Terrapizza. No se instalaron dependencias, no se corrieron seeders ni SQL contra producción.

**Confirmación teardown/dry-run:** el teardown (`scripts/teardown/teardown-simulation-data.sql`) y el dry-run (`scripts/teardown/dry-run-simulation-data.sql`) **NO** fueron ejecutados. El teardown sigue inerte por diseño (guardas + `ROLLBACK`).

**Working tree:** limpio salvo 3 `.md` no rastreados preexistentes (`MYTHOS_PRESPRINT_REPORT.md`, `MYTHOS_QA_BRIEFING.md`, `MYTHOS_SYSTEM_REPORT.md`) — no tocados.

---

## 2. Trazabilidad contra la lista original canónica

> La numeración real del repo llegó a PR-14 por bugs/hardenings intermedios. La lista original es un set de **9 temas** (PR-0..PR-8); abajo se mapea cada tema a los PR(s)/commits reales.

| # | Ítem original | Objetivo original | PR/commit real relacionado | Estado | Evidencia técnica | Riesgo restante |
|---|---|---|---|---|---|---|
| PR-0 | Safety harness + errores Supabase visibles | Que los fallos de Supabase no queden silenciados; piso de estabilidad | Trabajo temprano PR-1A..PR-2 (informes QA) | **PASS** (QA-verified) | No verificable de forma aislada en repo/memoria local; confirmado en informes QA PR-1A..PR-2 | Bajo |
| PR-1 | Órdenes QR ligadas correctamente a mesa | Eliminar Mesa "?" / "—"; ligar pedido↔mesa↔mozo | `table_scan_sessions` + `assigned_waiter` (migs 074/076, CLAUDE.md "Resueltos") | **PASS** | CLAUDE.md sección Resueltos; informe QA PR-1 PASS | Bajo |
| PR-2 | Paid/pending accounting + formato Guaraní | Contabilidad cobrado/pendiente correcta; ₲ | Fixes mozo/caja (CLAUDE.md "Resueltos": "Cobro pte." con paid, cobro ₲0, requires_invoice mig 084) | **PASS** | CLAUDE.md Resueltos; informe QA PR-2 PASS | Bajo |
| PR-3 | Login superadmin QA + Admin>Personal roles | Acceso superadmin QA; gestión de roles sin ghost-write | PR-3 real (ghost-write de rol/estado cerrado) + mig 104 tenant-scoping + `/api/create-user` tenant-guard | **PASS** | `project_pr4_verified` (memoria): "ghost-write de rol/estado ya cerrado en PR-3"; mig `20260612_104_authenticated_tenant_scoping.sql` | Bajo |
| PR-4 | Persistencia Manager: staff requests + support tickets | Que solicitudes de personal y tickets persistan reales (no fake success) | PR-4 real (auditoría, cerrado PASS sin código) | **PASS** | `project_pr4_verified`: backends ya tenant-scoped (mig 104), toasts gateados, sin fake-write | Bajo (deuda menor: avisos no auto-refresca) |
| PR-5 | Migrar frontend de Babel navegador a Vite | Sacar `@babel/standalone` del navegador; precompilar con Vite | PR-11 (`delivery-rider`, `35e8f69`) + PR-12 (`delivery-cliente`, `dca4a82`) | **PARCIAL** | `public/build/delivery-rider.js` + `delivery-cliente.js` presentes; `src/<panel>/`; 2 vite configs. **2 de 9 paneles** migrados; resto pausado por decisión | Medio — 7 paneles siguen Babel/CDN |
| PR-6 | Capabilities/paywall frontend + backend guardrails | Gating de planes/features + barandas backend | Capabilities migs 090/091/092 + PR-6 real (CRM audit) + PR-10 (tenant-guard `get_restaurant_capabilities`, mig 108) | **PARCIAL** | mig `20260616_108_harden_get_restaurant_capabilities.sql`; `project_pr10_capabilities_paywall`, `project_pr6_crm_audit` | Medio — enforcement backend de features y diferenciación de planes DIFERIDOS |
| PR-7 | Realtime KDS / cocina con fallback | Realtime en KDS + fallback de polling razonable | PR-13 (`6d31d67`, solo `public/cocina.html`) | **PASS** | poll 15s→45s + listener `delivery_orders` filtrado por `restaurant_id`; `project_pr13_kds_realtime_fallback` | Bajo (cocina sigue legacy Babel) |
| PR-8 | Plan de teardown seguro, prepared-only | Plan de teardown guardado, NO ejecutado | PR-14 (`429882d` / `02bbbb7`) | **PASS** | `scripts/teardown/` (README + dry-run + teardown bloqueado + seed-plan); `project_pr14_teardown_plan` | Bajo — ejecución futura requiere backup nuevo |

**Resumen del mapeo:** de los 9 temas originales, **6 PASS**, **2 PARCIAL** (PR-5 Vite incompleto por diseño; PR-6 enforcement backend diferido), **0 NO INICIADO**, **0 DIFERIDO completo**.

---

## 3. PRs reales relevantes (PR-3 a PR-14, según evidencia local)

> Resumen por evidencia en repo + memoria. Lo previo a PR-3 (PR-1A..PR-2, "PR-0") está PASS en informes QA pero **no es verificable de forma aislada localmente**; se cita como QA-verified.

- **PR-3 — Roles / Personal (ghost-write cerrado).** Cerró escritura fantasma de rol/estado; base tenant-scoped. Evidencia: `project_pr4_verified`, mig 104.
- **PR-4 — Persistencia Manager (auditoría).** PASS sin código: backends ya tenant-scoped, toasts gateados, sin fake success. Deuda menor: avisos no auto-refresca; password opcional al crear empleado (cerrado luego en PR-5 real).
- **PR-5 real — Password obligatorio en creación de usuarios.** `>=8` en `/api/create-user` + 3 forms + `autoComplete="new-password"`. Commit `f6a7fe8` → merge `76ecfd8`. `project_pr5_password_required`. (Ojo: el "PR-5" original = Vite, que en el repo cayó en PR-11/PR-12.)
- **PR-6 real — CRM audit.** PASS sin cambios: "Clientes" de admin es analítica read-only derivada de `orders` (honesta), no CRUD falso. Tabla `customers`/`crm_customers` NO existe = feature futura. `project_pr6_crm_audit`.
- **PR-7/7B real — Admin Stock 400.** Fix frontend de contrato viejo (`ingredients.min_threshold`, `stock_alerts.resolved_at`, `menu_items.is_available`, etc.). main `2257eb5`. `project_pr7_admin_stock_400`.
- **PR-8 real — staff_sessions 401.** `mythos-presence.js` escribía como anon; mig 104 cerró anon → 401. Fix: `setSession()` con JWT del usuario antes de leer/escribir. main `ed34514`. `project_pr8_staff_sessions_401`.
- **PR-9 real — restaurant_settings 406.** `.single()`→`.maybeSingle()` para lecturas opcionales de settings. main `750a325`. `project_pr9_restaurant_settings_406`.
- **PR-10 real — Tenant-guard `get_restaurant_capabilities`.** mig 108 (`CREATE OR REPLACE` cuerpo idéntico a mig 092 + guard fail-closed con `COALESCE`). Cierra fuga de lectura cross-tenant de metadata de plan/sucursales. main `e740120`. `project_pr10_capabilities_paywall`.
- **PR-11 real — Vite piloto `delivery-rider`.** Saca React/ReactDOM/@babel/standalone CDN → bundle IIFE `public/build/delivery-rider.js`. Hotfix `process.env.NODE_ENV` en `vite.config.mjs`. main `35e8f69`. `project_pr11_vite_pilot_delivery_rider`.
- **PR-12 real — Vite piloto `delivery-cliente`.** Mismo patrón; `vite.config.delivery-cliente.mjs`. Deuda: 2 configs (Rollup no hace multi-IIFE en un build). main `dca4a82`. `project_pr12_vite_pilot_delivery_cliente`.
- **PR-13 real — KDS realtime + fallback.** poll 15s→45s + listener `delivery_orders` UPDATE filtrado por `restaurant_id`. Solo `public/cocina.html` (legacy, NO Vite). main `f171145`. `project_pr13_kds_realtime_fallback`.
- **PR-14 real — Plan de teardown guardado.** Solo docs/scripts en `scripts/teardown/`, prepared only, not run. main `429882d`. `project_pr14_teardown_plan`.

**Capa de seguridad RLS transversal (no en la lista de 9 pero crítica):** migraciones `102` (anon PII lockdown, commit `dce8119`), `103` (anon write lockdown), `104` (authenticated tenant scoping), `105` (production drift security hotfix), `106`/`107` (fixes `admin_list_restaurant_users`), `108` (capabilities tenant-guard). Cierran el grueso del `USING(true)` histórico. **No verificable aquí** que el 100% del `USING(true)` a nivel fila esté cerrado: queda como deuda de seguridad de prioridad alta (ver §5).

---

## 4. Legacy aceptado

**Migrados a Vite/build (precompilados, sin Babel en navegador):**
- `delivery-rider` → `public/build/delivery-rider.js` (PR-11)
- `delivery-cliente` → `public/build/delivery-cliente.js` (PR-12)

**Siguen legacy React 18 UMD + `@babel/standalone` + `<script type="text/babel">` (aceptado por ahora):**

| Panel | Archivo | Nota |
|---|---|---|
| Cliente QR | `public/index.html` | Babel CDN (verificado: contiene `@babel/standalone`) |
| Cocina (KDS) | `public/cocina.html` | Babel CDN; recibió realtime PR-13 sin migrar a Vite |
| Mozo | `public/mozo.html` | Babel CDN |
| Caja | `public/caja.html` | Babel CDN |
| Gerente | `public/gerente.html` | Babel CDN |
| Admin | `public/admin.html` | Babel CDN; alto riesgo de migración (último, por decisión) |
| Superadmin | `public/superadmin.html` | Babel CDN; alto riesgo de migración (último) |

**Caso aparte — `login.html`:** **NO** usa React ni Babel ni Vite; es **JS vanilla** (Supabase UMD + `config.js` + `<script>` plano). Está **fuera del alcance de la migración Vite** por construcción (no hay JSX que compilar). En la doc QA figura como "legacy Babel/CDN" — eso es **impreciso**: login no carga Babel.

El aviso de consola `[BABEL] code generator has deoptimised…` en los 7 paneles legacy es **ruido conocido esperado**, no un error.

---

## 5. Deudas técnicas vivas

1. **Migración Vite restante (pausada).** 7 paneles siguen Babel/CDN (`index`, `cocina`, `mozo`, `caja`, `gerente`, `admin`, `superadmin`). Estrategia incremental: 1 panel por PR, los de mayor riesgo (`admin`/`caja`/`cocina`/`superadmin`) al final. **No** migrar más sin aprobación.
2. **Decisión técnica de 2 configs Vite.** `vite.config.mjs` + `vite.config.delivery-cliente.mjs` (Rollup no emite múltiples IIFE en un build multi-input). Build encadenado en `package.json`. Consolidar a ES modules/chunks compartidos **solo con aprobación** (cambia el contrato de carga de todos los paneles).
3. **Semánticas "Ventas hoy / Total facturado".** Definición de negocio aún no auditada/normalizada (qué cuenta como venta, en qué momento del flujo de estados, manejo de cancelaciones/devoluciones). Deuda funcional, requiere spec del arquitecto.
4. **"Mi turno" del mozo.** Semántica del turno/asignación del mozo no auditada en este ciclo; potencial inconsistencia entre filtro "Mis/Todas" y la realidad de `assigned_waiter` + `staff_sessions`.
5. **CRM-CRUD real (feature futura).** La UI "Clientes" es analítica read-only honesta. No existe tabla `customers`/`crm_customers`. Construir CRUD real es feature nueva, NO bug. Diferido por decisión del arquitecto (`project_pr6_crm_audit`).
6. **Pricing comercial por `allowed_features`.** Hoy `allowed_features` no diferencia planes (el paywall no dispara distinto por plan). Diferenciar es decisión comercial, diferida (`project_pr10_capabilities_paywall`).
7. **Enforcement backend de features premium.** El gating es principalmente frontend; falta enforcement estructural en backend (RLS/RPC) de las features premium. Diferido (estructural).
8. **Contrato legacy `restaurant_settings` dual.** Inconsistencia verificada: `cocina.html` lee `restaurant_settings` como **key/value** (`.eq('key','kitchen_message_frequency').select('value').maybeSingle()`, línea ~562); admin (PR-7) usa contrato **columnar** (`auto_stock_discount`, etc.). Conviven dos contratos sobre la misma tabla → auditoría de contrato pendiente (ver bloque G).
9. **Teardown real pendiente.** Plan guardado y bloqueado (`scripts/teardown/`); ejecución futura requiere **backup nuevo** + aprobación + dry-run revisado. Datos sim siguen vivos en prod.
10. **Deudas menores arrastradas:** avisos del Manager no auto-refresca (PR-4); `restaurant_settings` 406 mitigado con `maybeSingle` pero la tabla sigue sin fila para Don Carlos sim (cae a defaults OFF — aceptado).
11. **Cierre total de `USING(true)` a nivel fila.** Migs 102-108 cerraron el grueso (anon-PII, anon-write, authenticated tenant-scoping, drift), pero **no es verificable localmente** que el 100% esté cerrado. Prioridad alta de seguridad; requiere auditoría RLS dedicada en DB (fuera de PR-15).

---

## 6. Riesgos si seguimos migrando a Vite

- **QA visual/manual alto.** Cada panel migrado necesita smoke manual en preview (montaje, tenant correcto, sin `process is not defined`, sin Babel/UMD, flujos no destructivos). El costo de QA crece con paneles más grandes.
- **Paneles legacy acoplados.** Los paneles comparten `window.*` globales, `design-system.css`, `mythos-theme.js`, `mythos-icons.js`, `mythos-session.js`, `mythos-presence.js`. Un panel migrado a módulos podría romper supuestos de globales compartidos si no se preserva el patrón.
- **Diferencias de runtime CDN/Babel vs bundle.** Confirmado en PR-11: Vite lib mode **no** reemplaza `process.env.NODE_ENV` → crash `process is not defined` si no se hace `define`. Hay clases enteras de diferencias (tree-shaking, orden de evaluación, minify) que solo aparecen en runtime.
- **Mitigación obligatoria:** migrar **de a un panel**, con smoke claro y reversible, empezando por los de menor riesgo. Los de alto riesgo (`admin`, `caja`, `cocina`, `superadmin`) al final.
- **No cambiar a ES modules / chunks compartidos sin aprobación.** Es un cambio de arquitectura de carga (afecta a todos los HTML), no una migración incremental. Requiere decisión del arquitecto.

---

## 7. Riesgos si ejecutamos teardown

- **El backup histórico NO alcanza.** `C:\MYTHOS_BACKUPS\mythos_pre_rls_20260611_121455.dump` es pre-RLS (2026-06-11) y previo a varios PRs → **no** refleja el estado actual. **Backup NUEVO obligatorio** antes de cualquier ejecución.
- **Dry-run debe revisarse antes.** `scripts/teardown/dry-run-simulation-data.sql` (solo SELECT/count) debe correrse y su salida revisarse: confirmar `sim_restaurants = 3`, `terrapizza_en_allowlist = 0`, `terrapizza_present >= 1`, y la lista de usuarios candidatos.
- **Aprobación explícita de Renato obligatoria.** Además del GUC `mythos.teardown_confirm='RENATO_APPROVED_BACKUP_DONE'` (no incluido en el archivo a propósito) y de cambiar `ROLLBACK`→`COMMIT` a mano.
- **Riesgo de borrar datos equivocados si la allowlist/guardas se usan mal.** El marcador de usuarios es "sim-anchored MINUS rol en restaurante no-sim". Si alguien relaja las guardas o agranda la allowlist, puede borrar staff real. Hallazgo PR-14: el filtro `%@mythos.test` **no** captura cuentas QA `@mythos.internal` → el marcador se amplió por anclaje a restaurante sim.
- **Terrapizza debe seguir excluida.** UUID `01b5efb6-b912-4a8e-8a3c-b2ff246b66ca`, **NO** en la allowlist + guarda de nombre (`ILIKE '%terrapizza%'`) + post-check `terrapizza_present >= 1`. Si Terrapizza apareciera en la allowlist o desapareciera del post-check, el script aborta.
- **Estado:** prepared only, NOT run. El script es inerte (guardas + `ROLLBACK`) hasta intervención humana deliberada.

---

## 8. Próximos bloques recomendados (propuestos, ninguno iniciado)

| Bloque | Objetivo | Riesgo | Dependencia | ¿QA visual? | ¿DB/migración? | Prioridad |
|---|---|---|---|---|---|---|
| **A. Hardening demo/cliente** | Dejar un entorno demo/cliente seguro (cerrar el `USING(true)` de fila restante, smoke de seguridad) | Alto si toca RLS mal | Auditoría RLS de DB; backup | Parcial | **Sí** (RLS/migración) | **Alta** (es el bloqueo de "apto para clientes reales") |
| **B. Semánticas ventas/turno** | Normalizar "Ventas hoy / Total facturado" y "Mi turno" del mozo | Medio (toca lógica de negocio en caja/mozo) | Spec del arquitecto | **Sí** | Posible (vistas/funciones) | **Alta** (afecta confianza en números) |
| **C. Pricing + enforcement premium** | Diferenciar `allowed_features` por plan + enforcement backend | Alto (comercial + estructural) | Definición comercial | Sí | **Sí** (RLS/RPC) | Media |
| **D. CRM-CRUD real** | Crear tabla `customers` + conectar UI existente | Medio | Decisión de producto | Sí | **Sí** (tabla nueva + RLS) | Media |
| **E. Continuación Vite por paneles** | Migrar el siguiente panel de menor riesgo | Medio (runtime) | Smoke por panel | **Sí (alto)** | No | Media |
| **F. Teardown real con backup nuevo** | Ejecutar el teardown ya preparado | Alto (destructivo) | Backup nuevo + dry-run + aprobación | No (verificación BD) | Sí (DELETE en prod) | Media (cuando convenga limpiar) |
| **G. Auditoría de contrato KDS/settings** | Unificar el contrato dual de `restaurant_settings` (key/value vs columnar) | Bajo-medio | Mapear todos los lectores/escritores | Parcial | Posible (migración de normalización) | Baja-media |

**Recomendación de orden:** **B** (semánticas ventas/turno — alto valor, bajo riesgo si es solo lectura/spec) y **A** (hardening seguridad — es el bloqueo declarado para clientes reales) primero; luego **E**/**G** (deuda técnica acotada); **C**/**D**/**F** cuando haya decisión comercial/operativa.

---

## 9. Qué NO tocar todavía

- **Terrapizza** (restaurante real, UUID `01b5efb6-…`).
- **Teardown real** (`scripts/teardown/teardown-simulation-data.sql`).
- **Dry-run real** (`scripts/teardown/dry-run-simulation-data.sql`) — no ejecutar sin aprobación.
- **Migraciones / RLS / RPC / policies** — no crear ni editar.
- **Features premium** (pricing, `allowed_features`, enforcement backend).
- **CRM-CRUD** (tabla `customers` / conexión de UI).
- **Más migración Vite** (ningún panel adicional sin aprobación).
- **Datos productivos** (sim incluidos) — no modificar.
- **Seeds** (`scripts/seed/...` propuesto, no implementado).
- **Scripts destructivos** de cualquier tipo.

---

## 10. Conclusión

- **La remediación original está cerrada en términos de seguridad/estabilidad trazable:** de los 9 temas originales, 6 PASS y 2 PARCIAL por decisión deliberada (Vite incremental incompleto; enforcement backend de features diferido), 0 sin iniciar. La capa RLS (migs 102-108) cerró el grueso del `USING(true)` histórico.
- **El sistema NO está "terminado":** queda backlog real y verificable (Vite restante, semánticas de ventas/turno, pricing/enforcement premium, CRM-CRUD, contrato dual de `restaurant_settings`, teardown real, cierre 100% de RLS de fila).
- **El próximo paso debe decidirse por bloque, no por improvisación** (ver §8). El bloqueo declarado "apto para clientes reales" depende del bloque A (hardening de seguridad).
- **PR-15 no cambia producto:** es solo auditoría + documentación.

---

### Anexo — Incertidumbre / no verificable localmente

- **PR-0 / PR-1 / PR-2** (safety harness, QR→mesa, accounting): PASS en informes QA y reflejados en CLAUDE.md "Resueltos", pero **no verificables de forma aislada** desde repo/memoria local en este ciclo.
- **Cierre 100% del `USING(true)` a nivel fila:** no verificable sin inspección directa de la DB (requiere consulta de `pg_policies` en prod, fuera del alcance read-only de PR-15).
- **Estado en vivo de prod:** el smoke de los paneles en `mythos-pos.vercel.app` no se re-corrió aquí (PR-15 es solo lectura de repo); el último estado verde verificado es post-PR-14.
