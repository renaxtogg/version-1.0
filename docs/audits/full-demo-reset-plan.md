# MYTHOS — Reset total controlado de datos demo/QA (plan)

> **Estado:** **PREPARADO, NO EJECUTADO.** Fases 1 y 2 entregan **scripts** (dry-run SELECT-only +
> teardown protegido). **Cero SQL corrido, cero datos modificados.** Fase 3 = **esperar aprobación
> explícita de Renato + backup nuevo** antes de ejecutar.
> **Rama:** `chore/full-demo-reset-teardown` (base `main` @ `ac22880`). Solo scripts/docs.

---

## 1. Objetivo

Dejar el sistema **desde cero**: eliminar **todos** los datos demo/QA/simulación y **todos** los
restaurantes (incluida **Terrapizza**), preservando **únicamente**:

- la **cuenta oficial** `mancuellorenato@gmail.com` (auth + identities + user_roles), y
- la **estructura/catálogo** mínima para operar (schema, funciones, policies/RLS, migraciones,
  `subscription_plans`, `plan_addons`, `platform_config`).

> ⚠️ **Cambio de criterio respecto a los scripts previos.** `dry-run-simulation-data.sql` y
> `teardown-simulation-data.sql` (PR-14) **excluyen Terrapizza** (allowlist de 3 sims + guarda que
> **aborta** si Terrapizza aparece). Este reset es **total** e **incluye** Terrapizza. Por eso se crean
> **scripts nuevos** (`*-full-reset.sql`); **no** se reutilizan los de simulación. Esto es coherente con
> el criterio FINAL del dueño (2026-06-16): la **única** protección dura es `mancuellorenato@gmail.com`.

---

## 2. Entregables (esta rama)

| Archivo | Tipo | ¿Destructivo? |
|---|---|---|
| `scripts/teardown/dry-run-full-reset.sql` | **Fase 1** — inventario | **SOLO SELECT** — seguro en prod |
| `scripts/teardown/teardown-full-reset.sql` | **Fase 2** — teardown | DELETE **bloqueado** (guardas + `ROLLBACK`) |
| `docs/audits/full-demo-reset-plan.md` | este plan | — |

Los scripts de simulación previos quedan **en el repo** (caso acotado), pero para este reset total
se usan los `*-full-reset.sql`.

---

## 3. Qué se ELIMINA

- **Todos** los restaurantes: Terrapizza, Bella Napoli, Sushi Sakura, Parrilla Don Carlos (sims) y
  cualquier otro → `DELETE FROM restaurants` dispara **CASCADE** sobre ~51 tablas tenant.
- **Todos** los usuarios **menos** `mancuellorenato@gmail.com`: `auth.users`, `auth.identities`,
  `user_roles` (incluye `@mythos.test`, `@mythos.internal` y cualquier otro).
- **Todo** el árbol operativo: `orders` (+ `order_items`, `order_item_extras`, `order_status_history`,
  `order_item_station_log`, `payments`, `delivery_orders`), `delivery_riders/zones/channels`,
  `tables`, `table_scan_sessions`, menú (`menu_items/categories/extras`, `coupons`), `ratings`,
  `reservations`, `waiter_calls`, `invoice_request`, caja (`turnos_caja`, `movimientos_caja`,
  `cancelaciones_caja`, `caja_config`), `quejas_sugerencias`, finanzas/stock (`expenses`,
  `ingredients`, `recipes`, `stock_movements`, `stock_alerts`, `stock_sessions`), staff
  (`staff_sessions`, `staff_requests`, `staff_broadcasts`, `staff_payroll_adjustments`,
  `employee_shifts`, `kitchen_stations`, `calendar_events`), soporte (`support_tickets`,
  `support_chat`), `restaurant_settings`, `restaurant_addons`, `subscriptions`.
- **`platform_events`** (log de plataforma) — vaciado (ver §5, decisión revisable).

> El **dry-run §5** reporta los conteos exactos por tabla **antes** de cualquier borrado.

---

## 4. Qué se PRESERVA (no se toca)

- **Cuenta oficial** `mancuellorenato@gmail.com`: su fila en `auth.users`, sus `auth.identities` y sus
  `user_roles` (es superadmin, `restaurant_id = NULL` → no depende de ningún restaurante).
- **Catálogo/estructura global:** `subscription_plans`, `plan_addons`, `platform_config`.
- **Schema, funciones, policies (RLS), migraciones** — intactos.

Resultado final esperado: **0 restaurantes, 0 usuarios salvo el oficial**, catálogo intacto, sistema
listo para crear un primer restaurante real desde cero.

---

## 5. Decisiones revisables (para Renato)

1. **`platform_events` se vacía.** Es un log de eventos de plataforma; para "desde cero" se limpia.
   *Si querés conservarlo:* comentá su `DELETE` en el paso (2) del teardown.
2. **Catálogo preservado** (`subscription_plans` / `plan_addons` / `platform_config`). Si quisieras
   resetearlos también, es **otra fase** aparte (cambiaría "operar desde cero" → requiere re-seed del
   catálogo). **No** incluido acá.
3. **`user_profiles`** es **tabla fantasma** (no existe en prod): el teardown la salta con `to_regclass`.

---

## 6. Protecciones del teardown (`teardown-full-reset.sql`)

1. **GUC de confirmación:** exige `SET mythos.full_reset_confirm = 'RENATO_FULL_RESET_BACKUP_DONE';`
   en la **misma sesión** (no está embebido a propósito).
2. **Guarda anti-"DB equivocada":** resuelve la cuenta oficial por **email**; si no aparece
   **exactamente 1 fila**, **aborta sin borrar nada**.
3. **POST-CHECK in-transacción:** aborta si quedaron restaurantes, si el oficial desapareció, o si
   quedaron usuarios no-oficiales.
4. **`ROLLBACK` por defecto:** aunque pase todo, **no aplica nada** hasta cambiar a `COMMIT` a mano.
5. **`to_regclass`** en los bloqueadores → no rompe por tablas fantasma.
6. Preserva por **email**, nunca por UUID hardcodeado.

---

## 7. Procedimiento de ejecución (Fase 3 — solo con aprobación)

1. **Backup NUEVO** de la base (snapshot/export) y verificación de que el backup es restaurable.
2. Correr `scripts/teardown/dry-run-full-reset.sql` (Dashboard SQL en **inglés**). Verificar:
   - `official_present = 1` y la fila §2 es la de Renato.
   - Revisar §3 (todos los restaurantes), §4 (usuarios a borrar — el oficial **no** aparece) y §5 (conteos).
3. Aprobación explícita de Renato sobre la salida del dry-run.
4. En la **misma sesión** del teardown:
   `SET mythos.full_reset_confirm = 'RENATO_FULL_RESET_BACKUP_DONE';`
5. Pegar `teardown-full-reset.sql`. Revisar el `NOTICE` del POST-CHECK.
6. **Solo si el POST-CHECK dice OK:** cambiar la última línea `ROLLBACK;` por `COMMIT;` y re-ejecutar.
7. Post-ejecución: correr de nuevo el dry-run → `restaurants_total = 0`, `users_to_delete = 0`,
   `official_present = 1`, catálogo intacto.

---

## 8. Rollback

- El teardown **no** se auto-revierte una vez `COMMIT`. El rollback real es **restaurar el backup
  nuevo** del paso 7.1. Por eso el backup es **obligatorio** antes de cambiar `ROLLBACK`→`COMMIT`.
- Mientras la última línea siga en `ROLLBACK`, ninguna corrida modifica datos.

---

## 9. Riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | Ejecutar sin backup | Backup nuevo obligatorio (§7.1); ROLLBACK por defecto. |
| R2 | Borrar la cuenta oficial por error | Preservación por email + GUARDA 2 (aborta si no hay 1 oficial) + POST-CHECK. |
| R3 | Correr contra la DB equivocada | GUARDA 2 aborta si el email oficial no existe ahí. |
| R4 | Una FK RESTRICT inesperada bloquea el `DELETE FROM restaurants` | La transacción aborta (ROLLBACK) sin aplicar; se revisa y ajusta el orden. |
| R5 | Tabla fantasma rompe el script | `to_regclass` salta tablas inexistentes. |
| R6 | Romper Auth de la cuenta oficial | No se tocan sus filas; identities/users no-oficiales se borran en orden (identities→users). |
| R7 | Perder catálogo/estructura | `subscription_plans`/`plan_addons`/`platform_config` y schema/funciones/policies/migraciones **no** se tocan. |

---

## 10. Checklist de aprobación (Fase 3)

- [ ] Backup nuevo creado y verificado restaurable.
- [ ] `dry-run-full-reset.sql` corrido y revisado (`official_present = 1`).
- [ ] Renato aprueba la salida del dry-run.
- [ ] `SET mythos.full_reset_confirm = 'RENATO_FULL_RESET_BACKUP_DONE';` en la misma sesión.
- [ ] POST-CHECK del teardown = OK.
- [ ] Cambio deliberado `ROLLBACK` → `COMMIT`.
- [ ] Verificación post-ejecución (dry-run de control).

> **Nada de esto se ejecuta sin las casillas anteriores.** Esta entrega es **solo** los scripts + este plan.
