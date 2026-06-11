# Simulation Teardown Checklist (PREPARED — NOT YET EXECUTED)

> Sprint 0.1 deliverable, 2026-06-11. This checklist governs the removal of the
> 2026-06-08 simulation data from production. **Nothing in this file has been run.**
> Follow it top to bottom; do not skip the backup or the pre-counts.

## What will be deleted

- 3 simulation restaurants with fixed UUIDs:
  - `a1a10000-0000-4000-8000-000000000001`
  - `b2b20000-0000-4000-8000-000000000002`
  - `c3c30000-0000-4000-8000-000000000003`
- 15 auth users with emails ending in `@mythos.test` (shared known password — this is why they must go).
- Their operational rows (orders, items, history, delivery, caja, menu, tables, zones, riders, subscriptions).

## ⚠️ What must NOT be touched

- **Terrapizza** — a REAL restaurant loaded manually after the factory reset. It is NOT simulation data.
- The superadmin **Renato** (`Renaxto`, `restaurant_id = NULL`).
- Plans / add-ons / platform catalog (`subscription_plans`, `plan_addons`, `platform_config`).

The teardown script (`_simulacion/99_teardown.sql`) only targets the 3 fixed UUIDs and
`%@mythos.test` emails, so Terrapizza is structurally out of scope — but verify with the
pre/post counts below anyway.

## Step 1 — Backup (MANUAL, REQUIRED)

Before anything else, in the Supabase Dashboard (project `ocwzupmamfojvdywavqi`):
Database → Backups → confirm a recent backup exists, or trigger/download one now.
Do not proceed without a restorable backup. (Alternatively `pg_dump` via the pooler.)

## Step 2 — Required environment variables

Set in the PowerShell session (never write tokens to files):

```powershell
$env:SUPABASE_PAT          = '<rotated PAT — paste manually, never save>'
$env:SUPABASE_PROJECT_REF  = 'ocwzupmamfojvdywavqi'
$env:ALLOW_PROD_SIMULATION = 'true'    # required because the target IS production
```

## Step 3 — Pre-counts (read-only)

Save this as a temp file and run it with the runner (it is non-destructive, runs directly).
Record the output next to this checklist.

```sql
SELECT
  (SELECT count(*) FROM public.restaurants) AS restaurants_total,                                   -- expect 4
  (SELECT count(*) FROM public.restaurants WHERE id IN ('a1a10000-0000-4000-8000-000000000001','b2b20000-0000-4000-8000-000000000002','c3c30000-0000-4000-8000-000000000003')) AS sim_restaurants, -- expect 3
  (SELECT count(*) FROM public.restaurants WHERE name ILIKE '%terrapizza%') AS terrapizza_present,  -- expect 1
  (SELECT count(*) FROM auth.users WHERE email LIKE '%@mythos.test') AS sim_users,                  -- expect 15
  (SELECT count(*) FROM public.user_roles WHERE email LIKE '%@mythos.test') AS sim_user_roles,
  (SELECT count(*) FROM public.orders WHERE restaurant_id IN ('a1a10000-0000-4000-8000-000000000001','b2b20000-0000-4000-8000-000000000002','c3c30000-0000-4000-8000-000000000003')) AS sim_orders,
  (SELECT count(*) FROM public.delivery_orders WHERE restaurant_id IN ('a1a10000-0000-4000-8000-000000000001','b2b20000-0000-4000-8000-000000000002','c3c30000-0000-4000-8000-000000000003')) AS sim_delivery_orders,
  (SELECT count(*) FROM public.turnos_caja WHERE restaurant_id IN ('a1a10000-0000-4000-8000-000000000001','b2b20000-0000-4000-8000-000000000002','c3c30000-0000-4000-8000-000000000003')) AS sim_turnos,
  (SELECT count(*) FROM public.movimientos_caja WHERE restaurant_id IN ('a1a10000-0000-4000-8000-000000000001','b2b20000-0000-4000-8000-000000000002','c3c30000-0000-4000-8000-000000000003')) AS sim_movimientos,
  (SELECT count(*) FROM public.subscriptions WHERE restaurant_id IN ('a1a10000-0000-4000-8000-000000000001','b2b20000-0000-4000-8000-000000000002','c3c30000-0000-4000-8000-000000000003')) AS sim_subscriptions;
```

## Step 4 — Dry run

```powershell
.\_simulacion\run.ps1 -File .\_simulacion\99_teardown.sql
```

Without `CONFIRM_SIMULATION_TEARDOWN=true` the runner prints the destructive
statements it found and **refuses to execute** — that printout is the dry run.
Read it. Confirm it only mentions the 3 sim UUIDs and `@mythos.test`.

## Step 5 — Guarded teardown

```powershell
$env:CONFIRM_SIMULATION_TEARDOWN = 'true'
.\_simulacion\run.ps1 -File .\_simulacion\99_teardown.sql
Remove-Item Env:CONFIRM_SIMULATION_TEARDOWN   # unset immediately after
```

The script is transactional (single BEGIN/COMMIT) and re-runnable.

## Step 6 — Post-teardown checks (read-only)

```sql
SELECT
  (SELECT count(*) FROM auth.users WHERE email LIKE '%@mythos.test') AS sim_users_left,             -- MUST be 0
  (SELECT count(*) FROM public.user_roles WHERE email LIKE '%@mythos.test') AS sim_user_roles_left, -- MUST be 0
  (SELECT count(*) FROM public.restaurants WHERE id IN ('a1a10000-0000-4000-8000-000000000001','b2b20000-0000-4000-8000-000000000002','c3c30000-0000-4000-8000-000000000003')) AS sim_restaurants_left, -- MUST be 0
  (SELECT count(*) FROM public.restaurants WHERE name ILIKE '%terrapizza%') AS terrapizza_present,  -- MUST be 1
  -- Orphan operational rows (the teardown relies on FK cascades for some tables):
  (SELECT count(*) FROM public.orders o            WHERE NOT EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = o.restaurant_id)) AS orphan_orders,
  (SELECT count(*) FROM public.delivery_orders d   WHERE NOT EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = d.restaurant_id)) AS orphan_delivery_orders,
  (SELECT count(*) FROM public.movimientos_caja m  WHERE NOT EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = m.restaurant_id)) AS orphan_movimientos,
  (SELECT count(*) FROM public.user_roles ur       WHERE ur.restaurant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = ur.restaurant_id)) AS orphan_user_roles,
  (SELECT count(*) FROM public.staff_sessions s    WHERE s.restaurant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = s.restaurant_id)) AS orphan_staff_sessions,
  (SELECT count(*) FROM public.waiter_calls w      WHERE NOT EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = w.restaurant_id)) AS orphan_waiter_calls,
  (SELECT count(*) FROM public.ratings rt          WHERE rt.restaurant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = rt.restaurant_id)) AS orphan_ratings,
  (SELECT count(*) FROM public.reservations rs     WHERE NOT EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = rs.restaurant_id)) AS orphan_reservations;
```

All `orphan_*` columns MUST be 0. If any is > 0, the teardown's FK-cascade assumption
failed for that table: delete only those orphan rows with a scoped statement, e.g.

```sql
DELETE FROM public.staff_sessions s
WHERE s.restaurant_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = s.restaurant_id);
```

(run through the guarded runner — it will require `CONFIRM_SIMULATION_TEARDOWN=true` again),
then re-run the post-check.

## Step 7 — Record the result

Append pre-counts, post-counts, and the date/operator to this file (or a sibling
`TEARDOWN_LOG.md`) so the next audit can verify the cleanup happened.
