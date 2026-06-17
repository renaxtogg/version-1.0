# PR-18 — Verificación RLS producción read-only

> **Tipo:** verificación read-only + documentación. **No cambia producto. No toca DB (solo SELECT).**
> **Fecha:** 2026-06-16. **Autor:** Claude Code (programador). **Para:** Renato (fundador) + ChatGPT (arquitecto).
> **Siguiente paso recomendado por:** PR-17 (Bloque A). Genera evidencia para decidir si hace falta PR-19 (hotfix).
> **Estado:** **PASS** — gauge consolidado (§9) ejecutado manualmente por Renato en prod (ver "Resultado de ejecución manual").

---

## 1. Estado base

| Campo | Valor |
|---|---|
| Commit base | `main` = `origin/main` = **`e30ecfe`** (PR-17) |
| Rama de esta verificación | `audit/pr-18-prod-rls-verification` (desde `e30ecfe`) |
| Producción | Supabase proyecto `ocwzupmamfojvdywavqi` |
| Método de verificación | Script SQL **estrictamente read-only** (`scripts/verify/pr18-prod-rls-verification.sql`) |
| Confirmación solo lectura | 14 sentencias, todas `SELECT`; sin INSERT/UPDATE/DELETE/DDL/GRANT/`BEGIN` (verificado por grep) |

**No se modificó nada.** El script inspecciona catálogos del sistema (`pg_policies`, `pg_proc`, `pg_class`, `information_schema.role_table_grants`, `pg_publication_tables`) y no ejecuta ninguna función.

---

## 2. Ejecución

**Opción A — Ejecutado manualmente por Renato en el Supabase SQL Editor (producción).** Renato corrió el **gauge consolidado (§9)** y devolvió la fila de resultados (ver "Resultado de ejecución manual" abajo). El entorno local de Claude Code sigue **sin** método de conexión seguro (verificado sin imprimir valores: `SUPABASE_PAT`, `SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `SUPABASE_ACCESS_TOKEN`, `PGPASSWORD` todas sin setear; sin `supabase` CLI ni `psql`), por lo que la corrida la hizo Renato — **no se pidieron secretos por chat**.

### Resultado de ejecución manual por Renato

**Fecha:** 2026-06-16. **Método:** Supabase SQL Editor, producción (`ocwzupmamfojvdywavqi`). **Resultado:** **PASS del gauge consolidado (§9).**

| Contador (§9) | Valor observado | Esperado (PASS) | ¿OK? |
|---|---|---|---|
| `anon_admin_rpcs` | 0 | 0 | ✅ |
| `dc_anon_grants` | 0 | 0 | ✅ |
| `drift_policies` | 0 | 0 | ✅ |
| `anon_residual_grants` | 0 | 0 | ✅ |
| `list_users_guarded` | true | true | ✅ |
| `capabilities_guarded` | true | true | ✅ |
| `rls_disabled_critical` | 0 | 0 | ✅ |

**Lectura:** los 7 contadores críticos coinciden con el PASS esperado → el drift de 105 está cerrado, los guards de 107 y 108 están presentes, y ninguna tabla crítica tiene RLS apagado.

> **Incertidumbre menor:** se ejecutó el **gauge consolidado** (§9), no necesariamente todas las secciones de detalle (§3–§8) ni el `RLS_SPRINT_1_VERIFICATION.sql` completo. El detalle de catálogo por tabla/policy queda **no adjunto**, pero la **decisión crítica de hotfix** (¿aplicar 105/106/107?) queda **resuelta por el gauge**. Si en el futuro se quiere el detalle completo, basta correr las secciones §3–§8 (siguen siendo read-only).

### Instrucciones de ejecución manual (seguras, sin secretos)
1. Supabase Dashboard → **SQL Editor**. Cambiar idioma a **inglés** (el español rompe keywords).
2. Pegar **`scripts/verify/pr18-prod-rls-verification.sql`** completo y ejecutar (o sección por sección).
3. Además, correr **`docs/security/RLS_SPRINT_1_VERIFICATION.sql`** (Q1–Q15) para el detalle profundo de Sprint 1/1B.
4. Pegar la salida en las tablas de §3–§8 de este informe. **No** pegar connection strings, tokens ni claves (el script no los pide ni los devuelve).
5. Con los resultados, marcar la conclusión §9 (PASS / PARTIAL / FAIL).

> El script PR-18 **complementa** al de Sprint 1 (no lo reemplaza). El de Sprint 1 ya cubre Q1–Q15 (anon grants, USING(true), dropped policies, anon RPCs, tenant scoping, RLS disabled, drift 1B). PR-18 agrega: tracking de migraciones, checks de **efecto** de 106/107/108, listado de **SECURITY DEFINER con search_path**, **realtime publication**, y un **gauge consolidado**.

---

## 3. Migraciones aplicadas

> A confirmar en prod. Lo de "repo" es estado conocido localmente; "prod" lo llena la ejecución.
> **Nota:** este proyecto aplica varias migraciones **a mano** en el SQL Editor (p.ej. 108 según memoria). Por eso `supabase_migrations.schema_migrations` puede estar **vacío o incompleto** y NO es autoritativo. La fuente de verdad es la **verificación por efecto** (§2.1–§2.4 del script).

| Versión/nombre | Presente en repo | Presente en prod | Estado | Observación |
|---|---|---|---|---|
| `103` anon_write_lockdown | Sí | Sí (memoria; consistente con gauge) | OK | Sprint 1A |
| `104` authenticated_tenant_scoping | Sí | Sí (memoria; consistente con gauge) | OK | Sprint 1A |
| **`105`** production_drift_security_hotfix | Sí (header: "DO NOT APPLY UNTIL ordered") | **Sí — confirmado por EFECTO** | **OK** | Gauge §9: `dc_anon_grants=0`, `drift_policies=0`, `anon_admin_rpcs=0`, `anon_residual_grants=0` |
| **`106`** fix admin_list ambiguity | Sí | **Sí — confirmado por EFECTO** | **OK** | Gauge §9: `list_users_guarded=true` (cuerpo actualizado) |
| **`107`** tenant guard admin_list | Sí | **Sí — confirmado por EFECTO** | **OK** | Gauge §9: `list_users_guarded=true` (contiene `get_my_company_restaurant_ids`) |
| **`108`** harden get_restaurant_capabilities | Sí | **Sí — confirmado por EFECTO** | **OK** | Gauge §9: `capabilities_guarded=true` |

**Resultado (gauge §9, ejecutado por Renato 2026-06-16):** todos los efectos esperados confirmados. 105/106/107/108 están aplicados en prod (por efecto). **No hace falta aplicar nada.**

---

## 4. Tablas con RLS deshabilitado

| schema | tabla | RLS enabled | severidad | recomendación |
|---|---|---|---|---|
| _(a completar con §3 del script + Q9 del Sprint script)_ | | sí/no | | Cualquier tabla crítica con RLS=false → revisar/escalar a PR-19 |

**PASS esperado:** ninguna de `orders`, `delivery_orders`, `restaurants`, `payments`, `subscriptions`, `user_profiles`, `user_roles`, `restaurant_settings`, `delivery_channels`, `staff_payroll_adjustments` aparece con RLS=false (gauge §9 `rls_disabled_critical = 0`).

---

## 5. Policies amplias / `USING true`

| tabla | policy | roles | cmd | qual | with_check | severidad | recomendación |
|---|---|---|---|---|---|---|---|
| _(a completar con §4 y §5 del script + Q3 del Sprint script)_ | | | | | | | |

**PASS esperado:** las únicas `USING(true)`/`WITH CHECK(true)` son las leftovers de flujo anon documentadas (orders/order_items/order_item_extras/order_status_history/waiter_calls/ratings/table_scan_sessions/tables_anon_select/menú/cupones/delivery_zones_read/platform_config_read/plans_*). **FAIL** si aparece cualquier hit en payments, payroll, suppliers, support, staff_*, stock, stations, settings, addons.

---

## 6. SECURITY DEFINER

> Llenar con §6 del script (`prosecdef IS TRUE`). Columnas del script: `has_search_path_set`, `references_guard_heuristic`, `anon_can_execute`, `authenticated_can_execute`.

| función | argumentos | search_path fijado | usa guard tenant/rol | anon ejecuta | severidad | recomendación |
|---|---|---|---|---|---|---|
| _(a completar)_ | | sí/no | sí/no/heurística | sí/no | | |

**PASS esperado:** todas las SECURITY DEFINER con `search_path` fijado; **solo** este surface anon-ejecutable: `join_table_session`, `get_table_upcoming_reservation`, `get_restaurant_capabilities`, `check_menu_item_availability`. **FAIL** si `admin_*` (incl. `admin_load_stock`, `admin_set_item_availability`, `admin_complete_stock_session`), `get_user_email`, `superadmin_reset_operation_data` o `superadmin_seed_simulated_environment` son anon-ejecutables.

---

## 7. Tablas críticas

> Llenar con §7 del script (listado completo de policies por tabla) + §7.1 (RLS on/off).

| tabla | policies presentes (resumen) | riesgo | recomendación |
|---|---|---|---|
| `orders` | _(a completar)_ | anon select/insert es flujo esperado | confirmar que no haya UPDATE/DELETE anon |
| `delivery_orders` | | `dord_anon_update` debe **NO** existir | |
| `restaurants` | | `sa_restaurants_all`/`admin_update_restaurant` deben **NO** existir | |
| `delivery_channels` | | sin acceso anon (tabla fantasma) | si hay grants anon → PR-19 |
| `delivery_riders` / `delivery_zones` | | solo anon SELECT acotado (`active`/`is_active`) | |
| `restaurant_settings` / `payments` / `staff_payroll_adjustments` / `subscriptions` / `user_profiles` / `user_roles` / `coupons` / `support_tickets` / `staff_requests` / `ratings` / `restaurant_addons` | | tenant-scoped o superadmin-only | |

---

## 8. Realtime/publication

> Llenar con §8 del script (`pg_publication_tables` para `supabase_realtime`).

| tablas publicadas | riesgo | recomendación |
|---|---|---|
| _(a completar)_ | tablas sensibles publicadas sin necesidad (payments/payroll/subscriptions/user_profiles/support_*) = riesgo | si aparecen, evaluar quitarlas de la publication (PR futuro) |

Si no se pudo consultar (permisos), indicarlo aquí.

---

## 9. Conclusión

**Estado: PASS** (basado en el gauge consolidado §9 ejecutado manualmente por Renato en prod el 2026-06-16). Los 7 contadores críticos coinciden con el resultado esperado:
`anon_admin_rpcs=0`, `dc_anon_grants=0`, `drift_policies=0`, `anon_residual_grants=0`, `list_users_guarded=true`, `capabilities_guarded=true`, `rls_disabled_critical=0`.

**Interpretación:** producción **pasa la verificación crítica** de PR-18. El drift que documentaba la migración 105 (acceso anon a `delivery_channels`, políticas `public_all_riders/zones`, RPCs admin de stock ejecutables por anon) está **cerrado**; los tenant guards de 107 (`admin_list_restaurant_users`) y 108 (`get_restaurant_capabilities`) están **presentes**; y ninguna tabla crítica tiene RLS deshabilitado.

> Alcance del PASS: se basa en el **gauge consolidado**, no en el dump completo de catálogo (§3–§8). La decisión crítica de hotfix queda resuelta; el detalle granular queda como verificación opcional futura (read-only).

---

## 10. Recomendación para PR-19

**Decisión (gauge en verde):** **saltar PR-19 por ahora.** No aplicar 105/106/107 — su efecto ya está presente en prod. No abrir hotfix.

Siguiente bloque recomendado: **PR-20** (decisión sobre datos de simulación + contraseñas compartidas vivos en prod) o **PR-21** (superadmin demo-safety). Ambos quedan a decisión del arquitecto.

> Si más adelante se corre el detalle §3–§8 y aparece algún hallazgo no crítico (p.ej. una `USING(true)` inesperada en una tabla no-crítica, o una tabla sensible en la realtime publication), se evaluaría un PR pequeño puntual — pero **no** es un bloqueo de cliente real según el gauge actual.

---

## 11. Qué NO se tocó

- **no DB writes** · **no RLS changes** · **no RPC changes** · **no migrations applied** · **no data changes** · **no teardown** · **no dry-run** · **Terrapizza no tocada** · **no frontend/runtime** · **no backend/runtime** · **no Vite**.
- No se instalaron dependencias. No se pidieron ni imprimieron secretos/connection strings/tokens. El único cambio en el repo son los 2 archivos de este PR (script SQL read-only + este informe).

---

### Anexo — Incertidumbres
- Estado de aplicación real de **105/106/107** en prod (resuelto por la corrida).
- Fiabilidad de `supabase_migrations.schema_migrations` (puede no reflejar migraciones aplicadas a mano) → por eso se usan checks de **efecto**.
- Permisos del rol del SQL Editor para leer `pg_publication_tables` / `pg_proc` definiciones (normalmente sí en el dashboard como `postgres`).
- Esta verificación es de catálogo (RLS/grants/definiciones); **no** prueba explotación en runtime.
