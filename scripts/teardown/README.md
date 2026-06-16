# Teardown de datos de simulación — PLAN (PREPARADO, NO EJECUTADO)

> **PR-14.** Este directorio contiene un plan de teardown **endurecido y versionado**
> para remover los datos de simulación de producción. **Nada de esto se ejecutó.**
> El reporte de PR-14 dice explícitamente: **prepared only, not run.**
>
> Reemplaza/endurece al `_simulacion/99_teardown.sql` (gitignored, incompleto y sin
> guardas in-SQL). Complementa —no duplica— `docs/security/SIMULATION_TEARDOWN_CHECKLIST.md`,
> que sigue siendo el checklist operativo canónico.

## Archivos

| Archivo | Qué es | ¿Destructivo? |
|---|---|---|
| `dry-run-simulation-data.sql` | Solo `SELECT`/`count(*)`: inventario por tabla, candidatos de usuarios, prueba de exclusión de Terrapizza, pre-chequeo de umbrales. | **NO** — seguro de correr en prod |
| `teardown-simulation-data.sql` | Teardown transaccional con guardas duras in-SQL. **Termina en `ROLLBACK`.** | Sí, pero **bloqueado** (ver guardas) |
| `seed-demo-data-plan.md` | Propuesta (opcional) de seed demo profesional para después. | NO |
| `README.md` | Este archivo. | NO |

---

## Qué se borra

- Los **3 restaurantes de simulación** (allowlist explícita de UUIDs):
  - Bella Napoli `a1a10000-0000-4000-8000-000000000001`
  - Sushi Sakura `b2b20000-0000-4000-8000-000000000002`
  - Parrilla Don Carlos `c3c30000-0000-4000-8000-000000000003`
- Toda su data operativa (cascada por FK — ver abajo).
- Las **cuentas auth de simulación/QA**: `%@mythos.test` (sim original, contraseña compartida)
  **y** las cuentas QA `@mythos.internal` creadas durante los PRs — pero **solo** las que
  están ancladas a un restaurante sim y **sin** rol en ningún restaurante real.

## Qué NO se toca (jamás)

- **Terrapizza** — restaurante REAL cargado a mano. NO es simulación. Excluido por construcción
  (no está en la allowlist) + guarda dura que aborta si aparece (por nombre o id).
- El superadmin **Renato** (`Renaxto`, `restaurant_id = NULL`, email **no** `@mythos.test`).
- Catálogo de plataforma: `subscription_plans`, `plan_addons`, `platform_config`.
- Cualquier usuario con rol en un restaurante **no-sim** (protege staff real de Terrapizza).

---

## Auditoría de dependencias (por qué este orden)

FKs a `restaurants` (migraciones activas): **51 `ON DELETE CASCADE`**, **2 que bloquean**, **1 que deja huérfano**:

| Tabla | FK a restaurants | Implicación para el teardown |
|---|---|---|
| `orders.restaurant_id` | **ON DELETE RESTRICT** | Bloquea el `DELETE` del restaurante → hay que borrar `orders` (y su árbol) ANTES. |
| `user_profiles.restaurant_id` | **sin acción (NO ACTION)** | Bloquea → borrar filas sim de `user_profiles` ANTES. |
| `platform_events.restaurant_id` | **ON DELETE SET NULL** | No bloquea, pero dejaría logs con `restaurant_id` NULL → borrar filas sim ANTES (limpieza). |
| ~51 tablas tenant | **ON DELETE CASCADE** | Se borran **solas** al borrar `restaurants` (menu, tables, zones, riders, caja, stock, ratings, reservations, staff_sessions, support, etc.). |

Hijos de `orders` con `order_id ON DELETE SET NULL` (ratings, waiter_calls, movimientos/cancelaciones/quejas de caja, waiter_debts, manager_approvals): al borrar `orders` se les anula `order_id`, pero **también** tienen `restaurant_id` CASCADE → caen con el `DELETE` del restaurante. Sin huérfanos.

**Orden seguro resultante:** guardas → `orders` (cascada su árbol) → `user_profiles` sim → `platform_events` sim → `user_roles` sim → `restaurants` (cascada las 51) → `auth.users`/`auth.identities` sim → verificación de huérfanos.

### Tablas que NO conviene borrar a ciegas
- `auth.users` / `auth.identities` — borrar de más rompe accesos reales. Por eso se acota a `%@mythos.test` + QA `@mythos.internal` **anclados a sim y sin rol real** (set capturado en TEMP antes de tocar roles).
- `subscription_plans` / `plan_addons` / `platform_config` — catálogo global, NO tenant.
- `restaurants` — solo la allowlist de 3 UUIDs; nunca por nombre/denylist.

---

## Criterios de identificación de datos sim (marcadores seguros)

1. **Restaurantes:** allowlist explícita de 3 UUIDs (`a1a1…/b2b2…/c3c3…`). Nunca denylist.
2. **Data operativa:** `restaurant_id IN (allowlist)` (directo) o vía padre (`order_id`/`order_item_id`).
3. **Usuarios:** `email LIKE '%@mythos.test'` **OR** existe `user_roles` con `restaurant_id IN (allowlist)` — **MINUS** cualquier usuario con un `user_roles` en restaurante **no-sim** (protege Terrapizza/real). Esto captura también las cuentas QA `@mythos.internal` sin un wildcard de dominio peligroso.

> ⚠️ **Hallazgo PR-14:** el filtro histórico `%@mythos.test` **no** captura las cuentas QA
> `@mythos.internal` (p.ej. `qa.testsinpass@mythos.internal`, `qa.pr5.adminpass@mythos.internal`).
> Por eso el marcador de usuarios se amplía a "anclado a restaurante sim", verificado en el dry-run.

---

## Cómo se excluye Terrapizza (demostrable)

1. **Por construcción:** el teardown solo apunta a 3 UUIDs fijos; Terrapizza tiene otro UUID → fuera de alcance.
2. **Guarda dura in-SQL:** aborta (`RAISE EXCEPTION`) si algún restaurante de la allowlist tiene `name ILIKE '%terrapizza%'`, o si la allowlist no resuelve exactamente a los 3 sim.
3. **Prueba en el dry-run:** lista los restaurantes **sobrevivientes** (`id <> ALL(allowlist)`) — Terrapizza debe aparecer ahí — y cuenta `terrapizza_present` (debe ser ≥1 antes y después).

---

## Riesgos de borrar mal (documentados)

| Riesgo | Mitigación |
|---|---|
| Borrar usuarios reales (Terrapizza/Renato) | Set de usuarios = sim-anchored **MINUS** rol en restaurante real; Renato es `@`-no-test y `restaurant_id NULL`. |
| Borrar Terrapizza | Allowlist de UUIDs + guarda de nombre + prueba de sobrevivientes. |
| Romper FKs / orphans | Orden por dependencias + se apoya en las 51 CASCADE; post-check de huérfanos (todos deben ser 0). |
| Borrar de más por umbral inesperado | Guarda de umbrales: aborta si `restaurants_sim != 3` o si los conteos superan máximos esperados. |
| Borrar catálogo comercial | El script nunca toca `subscription_plans`/`plan_addons`/`platform_config`. |
| Ejecutar sin querer | Guarda de `current_setting('mythos.teardown_confirm')` + transacción que termina en `ROLLBACK`. |
| Backup insuficiente | Checklist de backup obligatorio + pedir backup NUEVO (el histórico no alcanza). |

---

## Checklist de backup (obligatorio antes de cualquier ejecución futura)

> El operativo paso-a-paso vive en `docs/security/SIMULATION_TEARDOWN_CHECKLIST.md`.
> Resumen de pre-requisitos:

- [ ] **Backup Supabase NUEVO** del proyecto `ocwzupmamfojvdywavqi` (Dashboard → Database → Backups, o `pg_dump`).
- [ ] Registrar **path + fecha + operador** del backup nuevo (no asumir que sirve el histórico
      `C:\MYTHOS_BACKUPS\mythos_pre_rls_20260611_121455.dump`).
- [ ] Confirmar que el backup es **restaurable** (probar restore en entorno aparte si es posible).
- [ ] Correr `dry-run-simulation-data.sql` y **guardar la salida**.
- [ ] Revisar conteos vs esperados (abajo) y la lista de usuarios candidatos.
- [ ] Confirmar `terrapizza_present ≥ 1` y que Terrapizza está en los sobrevivientes.
- [ ] **Aprobación explícita de Renato.**
- [ ] Ventana de mantenimiento acordada.
- [ ] Plan de rollback listo (restore del backup nuevo).
- [ ] Solo entonces: setear el GUC de confirmación y cambiar `ROLLBACK` → `COMMIT` en el script.

### Conteos esperados (referencia; correr el dry-run para los reales)
- `restaurants` sim: **3** · `terrapizza_present`: **≥1** · `restaurants_total`: ~4-5.
- `%@mythos.test` users: ~**15-16** (15 sim + `qa.superadmin`).
- QA `@mythos.internal` anclados a Don Carlos: ~**2-3** (PR-4/PR-5).
- Data operativa de Don Carlos creada en QA: pedidos PR-3 (T-36948/T-34167), ingredients PR-7B (2), staff_sessions PR-8 (cerradas), ticket/aviso PR-4. Ver `project_qa_test_data_pending_teardown` en memoria.

---

## Estado

**PREPARED ONLY — NOT RUN.** Sin merge, sin deploy, sin DB tocada. Esperando revisión del arquitecto.
