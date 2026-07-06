# Mig 151 — Borrado de restaurante: eliminar TODAS las dependencias + limpieza de huérfanos

**Fecha:** 2026-07-06 · **Migración:** `supabase/migrations/20260706_151_fix_delete_restaurant_full_cascade.sql` · **Estado:** aplicada en prod y verificada.

## Bug

`superadmin_delete_restaurant` (mig 146) borraba explícito **solo** `orders`, `user_profiles`
y `staff_broadcasts`, y confiaba en `ON DELETE CASCADE` para el resto. Pero hay FKs a
`restaurants` **sin cascade** que bloquean el borrado. Al eliminar un restaurante con zonas
de delivery: `violates foreign key constraint delivery_zones_restaurant_id_fkey` → ROLLBACK
(no borraba nada).

## Causa raíz (verificada contra `pg_constraint` en vivo, no contra las migraciones)

Nota: las migraciones mienten (drift). `delivery_zones` figura como `ON DELETE CASCADE` en la
mig 030, pero en prod es **NO ACTION**. Se enumeró el FK real con `pg_constraint`.

FKs cuyo **padre es `restaurants`** y NO son CASCADE:

| Tabla | Columna | ON DELETE | ¿Bloquea? |
|---|---|---|---|
| `orders` | `restaurant_id` | RESTRICT | sí (ya se borraba) |
| `delivery_zones` | `restaurant_id` | NO ACTION | **sí — el bug reportado** |
| `delivery_channels` | `restaurant_id` | NO ACTION | **sí** |
| `delivery_riders` | `restaurant_id` | NO ACTION | **sí** |
| `marketplace_events` | `restaurant_id` | SET NULL | no (se anula) |
| `marketplace_reports` | `reporter_restaurant_id` | SET NULL | no |
| `platform_events` | `restaurant_id` | SET NULL | no |
| `terms_acceptance` | `restaurant_id` | SET NULL | no |
| `restaurants` | `parent_company_id` | SET NULL | no (sucursales se desvinculan) |

Además, columnas `restaurant_id` **sin FK** (no bloquean pero dejan filas huérfanas):
`availability_log`, `delivery_orders`, `staff_broadcasts`.

## Fix — tablas agregadas al borrado explícito (además de las que ya estaban)

En el orden correcto de llaves foráneas, **antes** de `DELETE FROM restaurants`:

1. `orders` (RESTRICT) — cascada `order_items` etc. *(ya estaba)*
2. `delivery_orders` — va **primero** del cluster: referencia `delivery_zones`/`delivery_channels`
   (NO ACTION) y `delivery_riders` (SET NULL). Se borran también los "sueltos" (`order_id` NULL)
   por `restaurant_id` o por pertenencia de zona/canal/rider. **NUEVO**
3. `delivery_zones` (NO ACTION) — **NUEVO**
4. `delivery_channels` (NO ACTION) — **NUEVO**
5. `delivery_riders` (NO ACTION) — **NUEVO**
6. `availability_log` (sin FK) — **NUEVO**
7. `user_profiles` (legacy, guardado con `to_regclass`) *(ya estaba)*
8. `staff_broadcasts` (sin FK) *(ya estaba)*
9. `restaurants` — cascada TODO el resto.

Se mantienen intactas: SECURITY DEFINER + `search_path=public`, fail-closed (superadmin O
service_role), REVOKE/GRANT, atomicidad (una transacción), NO toca `auth.users` (eso lo hace
`api/delete-restaurant.js`, que protege la cuenta oficial, superadmins y usuarios de otro local).
El resumen que devuelve la RPC ahora incluye los conteos de delivery.

## Limpieza de huérfanos (una sola vez, dentro de la migración)

Resultado en prod (2026-07-06):

- `availability_log` · `delivery_orders` · `staff_broadcasts`: **0 huérfanos borrados**.
- Barrido de completitud sobre TODA columna `%restaurant_id%`: **0 huérfanos remanentes**.
- SET NULL (reportados, NO borrados): `marketplace_events` = **4** NULL, `platform_events` = **2**
  NULL, `marketplace_reports.reporter_restaurant_id` = 0, `terms_acceptance` = 0. Esos NULL son
  la huella intencional de los restaurantes ya borrados (terrapizza + otro), no basura.

## Verificación end-to-end (en vivo)

Se creó un restaurante descartable con `delivery_zones` (x2) + `delivery_channels` +
`delivery_riders` + un `delivery_order` suelto + `staff_broadcasts`, y se borró **vía la RPC**
(autorizada como `service_role`). Resultado: **PASS** — restaurante y todas sus dependencias
eliminados, sin error de FK y sin huérfanos. La prueba corre en una transacción y no deja
residuo.

## Checklist

- [x] FK real leído de `pg_constraint` (no de las migraciones).
- [x] Todas las tablas no-cascade se borran explícito, en orden de FK.
- [x] Idempotente (`CREATE OR REPLACE`, `to_regclass`, `DROP ... IF EXISTS`).
- [x] Protecciones y atomicidad intactas.
- [x] Limpieza de huérfanos: 0 borrados, 0 remanentes; NULLs de SET NULL reportados.
- [x] Verificación con restaurante de prueba: borrado completo sin error.
- [x] Aplicada en prod + committeada a `main`.
