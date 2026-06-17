# PR-18 — Verificación RLS producción read-only

> **Tipo:** verificación read-only + documentación. **No cambia producto. No toca DB (solo SELECT, y aún sin ejecutar).**
> **Fecha:** 2026-06-16. **Autor:** Claude Code (programador). **Para:** Renato (fundador) + ChatGPT (arquitecto).
> **Siguiente paso recomendado por:** PR-17 (Bloque A). Genera evidencia para decidir si hace falta PR-19 (hotfix).

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

**Opción B — Script preparado, PENDIENTE de ejecución manual por Renato.**

No hay un método de conexión seguro ya configurado en el entorno local (verificado sin imprimir valores): `SUPABASE_PAT`, `SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `SUPABASE_ACCESS_TOKEN`, `PGPASSWORD` están **todas sin setear**; **no** hay `supabase` CLI ni `psql` instalados. Según las reglas del PR, **no se piden secretos por chat**.

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
| `103` anon_write_lockdown | Sí | _(Q10 = 0 según memoria 2026-06-11)_ | _a reconfirmar_ | Sprint 1A |
| `104` authenticated_tenant_scoping | Sí | _(aplicado, memoria)_ | _a reconfirmar_ | Sprint 1A |
| **`105`** production_drift_security_hotfix | Sí (**header: "DO NOT APPLY UNTIL ordered"**) | **? — desconocido** | **A VERIFICAR (clave)** | Efecto: §2.1/§2.2 del script (delivery_channels anon=0, drift policies=0, 3 stock RPCs no anon, residual=0) |
| **`106`** fix admin_list ambiguity | Sí | **?** | **A VERIFICAR** | Efecto: §2.3 (función calificada, SECURITY DEFINER, search_path) |
| **`107`** tenant guard admin_list | Sí | **?** | **A VERIFICAR** | Efecto: §2.3 (`has_tenant_guard_107 = true`) |
| **`108`** harden get_restaurant_capabilities | Sí (memoria: "aplicada a mano en prod") | _(aplicado, memoria)_ | _a reconfirmar_ | Efecto: §2.4 (`has_tenant_guard = true` y `has_failclosed_coalesce = true`) |

**Interpretación esperada (PASS):** §2.1 todos 0; §2.2 sin filas; §2.3 `has_tenant_guard_107 = true`; §2.4 `has_tenant_guard = true` y `has_failclosed_coalesce = true`.

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

**Estado: PENDING EXECUTION.** El script read-only está preparado y validado como SELECT-only, pero **aún no se ejecutó contra prod** (no hay conexión segura local y no se piden secretos). La conclusión definitiva (PASS / PARTIAL / FAIL) se completa tras la corrida manual.

**Hipótesis previa (de la memoria del proyecto, a confirmar):** 103/104 aplicados (Q10 = 0) y 108 aplicado a mano; **105/106/107 con estado de aplicación NO confirmado** — son el foco de esta verificación. Si 105 no se aplicó, hay exposición anon real (delivery_channels + drift riders/zones + 3 RPCs de stock) → **FAIL/BLOCKER** y se necesita PR-19.

---

## 10. Recomendación para PR-19

- **Si la corrida muestra drift** (cualquier contador del gauge §9 ≠ esperado: `anon_admin_rpcs>0`, `dc_anon_grants>0`, `drift_policies>0`, `anon_residual_grants>0`, `list_users_guarded=false`, `capabilities_guarded=false`, o `rls_disabled_critical>0`):
  → **PR-19 — aplicación controlada de las migraciones faltantes (105/106/107)** tal cual están en el repo (idempotentes, guardadas con `to_regclass`/`to_regprocedure`), corriendo el script de verificación **antes y después**. NO crear migración nueva si las existentes cubren el drift; aplicarlas en orden, con backup/ventana según el arquitecto.
- **Si la corrida está sana** (gauge §9 todo en verde):
  → **saltar PR-19** y pasar a **PR-20** (decisión sobre datos de simulación + contraseñas compartidas) o **PR-21** (superadmin demo-safety).

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
