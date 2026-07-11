# MYTHOS Security + QA Pre-Sprint Report

> Generated 2026-06-11 by the implementation engineer (Claude Code) for the architect (ChatGPT).
> Every finding below was verified directly against the repository, and the critical RLS/privilege
> findings were **confirmed against the live production database** with a read-only query
> (information_schema + pg_policies + row counts — no data was modified).
> No destructive change was performed. No teardown was run.

---

## 1. Executive summary

**Is the app safe for real customers right now? No.** Two findings were confirmed live in production today:

1. The public anon key can **UPDATE, INSERT and DELETE rows in `restaurants`** — the table-level privileges were never revoked and the `sa_restaurants_all FOR ALL USING(true)` policy (migration 004) plus `admin_update_restaurant` (010) are still active in prod. An anonymous HTTP request could rename, suspend, or **delete a tenant** (cascading to its users, tables, menu and settings). This was listed as "verify" in MYTHOS_SYSTEM_REPORT.md §9.5#3 — it is now **confirmed, and worse than reported** (DELETE too, not just UPDATE).
2. The anon role holds **full read/write privileges on `payments` (SaaS billing) and `staff_payroll_adjustments` (payroll)**, combined with `USING(true)` policies. Anyone with the public key can read and falsify payroll and billing records.

Additional blockers: anon can still insert orders into any restaurant and update any `delivery_orders` row cross-tenant (`dord_anon_update`, mig 102); ~25 tables remain `USING(true)` for authenticated users (cross-tenant staff access); 3 simulation restaurants + 15 test users with a shared known password are live in prod; a **live Supabase Personal Access Token is hardcoded in `_simulacion/run.ps1`** (gitignored, but the repo lives inside OneDrive, so it syncs to the cloud); plan limits for tables/items are frontend-only; zero automated tests.

**What should be fixed first, in order:**
1. **Sprint 1 (one migration, ~1 day):** revoke anon write privileges on `restaurants`, `payments`, `staff_payroll_adjustments`, `waiter_debts`, `employee_shifts`, `kitchen_stations*`, `platform_config`; drop/rescope the `USING(true)` policies on `restaurants` and `payments`. This closes the tenant-destruction and billing-tamper holes without touching any client flow (staff panels are `authenticated`; the client QR flow needs only SELECT/INSERT on orders).
2. **Credential hygiene (manual, same day):** rotate the Supabase PAT (it is hardcoded in `run.ps1` and was used to run scripts) and the service_role/secret key (historically exposed per project memory). Move the PAT to an environment variable.
3. **Simulation teardown** (after a backup + pre/post orphan count) to remove the 15 known-password accounts.
4. Then the anon ordering redesign (scoped RPC), plan-limit backstops, harness, and CI — roadmap in §6.

---

## 2. Confirmed critical security findings

| # | Finding | Evidence | Risk | Affected tables/files | Recommended fix |
|---|---|---|---|---|---|
| 1 | 🔴 **Anon can UPDATE/INSERT/DELETE `restaurants`** — confirmed in prod: anon table privileges = `DELETE,INSERT,REFERENCES,TRIGGER,TRUNCATE,UPDATE`; active policies `sa_restaurants_all[ALL]`, `admin_update_restaurant[UPDATE]`, both `USING(true)`. Mig 102 only restricted anon **SELECT** by column. | Live `pg_policies` / `role_table_grants` query 2026-06-11; `20260430_004_superadmin.sql:72`, `20260502_010_complete_admin_policies.sql:12`, `20260429_003_admin_policies.sql:52` | Anonymous tenant takeover/destruction: rename, suspend, set maintenance mode, or DELETE a restaurant (CASCADE wipes its users/menu/tables) | `restaurants` | New migration: `REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON restaurants FROM anon;` drop `sa_restaurants_all`/`admin_update_restaurant`/old update policies; recreate scoped: superadmin via `get_my_role()`, admin via `get_my_company_restaurant_ids()` |
| 2 | 🔴 **Anon has full read/write on `payments` and `staff_payroll_adjustments`** — confirmed in prod: both tables grant anon `DELETE,INSERT,SELECT,UPDATE…` and the only policies are `sa_payments_all[ALL] USING(true)` (028) and the 056 `USING(true)` policy | Live query 2026-06-11; `20260516_028_superadmin_improvements.sql:50`, `20260521_056_waiter_debts_and_payroll.sql:74-77` | Anyone with the public key can read and falsify SaaS billing records and employee payroll (PII + money) | `payments`, `staff_payroll_adjustments` (also `waiter_debts`, `employee_shifts` have `GRANT SELECT TO anon`) | Same migration: revoke ALL from anon on these 4 tables; `payments` → superadmin-only policy; payroll/debts/shifts → same-restaurant staff policies |
| 3 | 🔴 **Anon row-level access to orders is cross-tenant** — `USING(true)` SELECT/INSERT on `orders`/`order_items`, and `dord_anon_update USING(true)` deliberately kept on `delivery_orders` "for rider auto-assignment" even though cocina operates authenticated | `20260429_001_schema.sql:243-252`, `20260608_102_anon_pii_lockdown.sql:36-43` | KDS spam (insert orders into any restaurant), metric poisoning, tracking other tenants' operational data, mutating any delivery order (reassign riders, mark delivered) | `orders`, `order_items`, `order_item_extras`, `delivery_orders` | Sprint 2 redesign: SECURITY DEFINER RPCs with a session token (`table_scan_sessions`/order token); drop `dord_anon_update` immediately (auto-assign runs from authenticated cocina) — verify by grep that no anon flow PATCHes `delivery_orders` |
| 4 | 🔴 **~25 tables `USING(true)` for `authenticated`** — any logged-in employee of restaurant A can read/write restaurant B's data | grep across migrations: 017 (stock as `TO authenticated`), 023 (`expenses`), 031 (`platform_config` write), 033/056/098 (shifts/debts/sessions), 035/062 (`delivery_riders`), 030 (`delivery_zones` ALL), 037 (`restaurant_settings`), 069 (stations), 072 (suppliers, shift_logs, manager_approvals, item_86), 073 (support), 080 (calendar), 081/085b (staff_requests/broadcasts), 090 (plan_addons, restaurant_addons) | Cross-tenant insider access: a waiter at one restaurant can read another restaurant's suppliers, support tickets, payroll, and rewrite plan add-ons | listed tables | Sprint 1b migration: rewrite each policy to `restaurant_id IN (SELECT get_my_company_restaurant_ids())` (pattern of 086/092); superadmin tables → `get_my_role()='superadmin'` (pattern applied to `subscriptions` post-simulation) |
| 5 | 🔴 **Live Supabase PAT hardcoded in `_simulacion/run.ps1`**, pointing at the production project ref with no guard — any SQL file passed to it executes against prod | [run.ps1](_simulacion/run.ps1) line 3-4 (gitignored, but stored inside OneDrive → synced off-machine) | Full DB admin via Management API if the file leaks; also the #1 "accidentally run against prod" vector | `_simulacion/run.ps1` | Rotate the PAT now; rewrite runner to read `SUPABASE_PAT`/`SUPABASE_PROJECT_REF` from env vars with prod guard (§5) |
| 6 | 🟠 **Simulation data live in prod**: 3 `[SIM]`-style restaurants (`a1a1…/b2b2…/c3c3…`) + 15 `@mythos.test` users with one shared, documented password — confirmed live today (counts: 3 and 15) | Live query 2026-06-11; `_simulacion/INFORME.md` | 15 working staff logins with a known password into a production system | `auth.users`, `user_roles`, `restaurants` + operational rows | Backup → run `99_teardown.sql` → orphan check (§4). Not executed in this audit per rules |
| 7 | 🟠 **`GRANT ALL TO anon`** on the 4 kitchen-station tables + `GRANT SELECT kitchen_station_stats TO anon` | `20260525_069_kitchen_stations.sql:87-90,205` | Anon can read/rewrite station configs and access tokens of every restaurant (station links are the KDS auth) | `kitchen_stations`, `kitchen_station_categories`, `kitchen_station_zonas`, `order_item_station_log` | Revoke from anon; station-link access should go through a token-validating RPC instead of open SELECT |
| 8 | 🟡 **`get_user_email` RPC granted to anon** → username/email enumeration; legacy `admin_create_user` RPC still callable | migrations 007/008, 016/020 | Account enumeration; legacy privileged path kept alive in parallel to `/api/create-user` | RPC functions | `REVOKE EXECUTE … FROM anon` on `get_user_email`; drop or no-op the legacy `admin_create_user` |
| 9 | 🟡 **Obsolete dev-tool RPCs** `superadmin_reset_operation_data` / `superadmin_seed_simulated_environment` still deployed; hardcode the deleted `…0001` UUID | `20260522_068_superadmin_devtools.sql` | Data-destroying functions live in prod; misleading if invoked | RPC functions | Migration to `DROP FUNCTION`; superadmin dev tooling moves to the new harness |
| 10 | 🟡 **`diag.html` publicly routable** (`/diag` rewrite) revealing project URL, key prefix, table reachability | `public/diag.html`, `vercel.json:11` | Recon aid | `public/diag.html` | Gate behind login or remove the rewrite |

## 3. Confirmed beginner-bug risks

| # | Risk | Evidence | Why it matters | Recommended fix |
|---|---|---|---|---|
| 1 | Weak client-generated order numbers: `'T-' + (Date.now()%90000+10000)`, UNIQUE **global** (not per restaurant); the duplicate-retry re-inserts the **same** number | [index.html:119-137](public/index.html#L119-L137) | Cross-restaurant collisions (cycles every 90 s); predictable numbers let anon walk other tenants' order status via the open SELECT | DB sequence per restaurant via trigger/RPC; make UNIQUE `(restaurant_id, order_number)` |
| 2 | Plan limits `max_tables`/`max_menu_items` enforced only in frontend (proven: simulation H4 created table 6/5 on Starter via API) | `_simulacion/INFORME.md` H4; fix drafted in `_simulacion/SOLUCIONES_propuestas.sql`, never applied | Paying less ≠ getting less; the SaaS pricing model is bypassable with curl | Sprint 3: BEFORE INSERT triggers (pattern of `enforce_role_user_limit`, mig 090) |
| 3 | Feature gating fail-open + all 3 plans seeded with identical `allowed_features` | [mythos-gating.js:45](public/mythos-gating.js#L45) (`!Array.isArray(f) → return true`); mig 091 backfill; simulation H3 | The paywall never fires — revenue feature is dead code; fail-open means an RPC outage silently unlocks everything | Differentiate the seed per tier (new migration); keep fail-open only for legacy plans, log when it triggers; long-term enforce server-side |
| 4 | Hardcoded UUID `…0001` still referenced in deployed RPCs (068) and stale docs/skills | grep: mig 068, `.claude/skills/mythos-context/SKILL.md:58`, `docs/*`, `.env.example` | Post-reset, these point at a nonexistent tenant; copy-paste from stale docs reintroduces the banned fallback | Drop RPCs (finding 2.9); sweep docs/skills in Sprint 0 |
| 5 | `supabase-js@2` unpinned + React/Babel/Leaflet served from 4 third-party CDNs at runtime in all 11 panels | grep of `<script>` tags: jsdelivr `supabase-js@2` ×11, unpkg ×~40 | A supabase-js minor release can break every panel with zero repo change; CDN outage = total outage | Pin exact version (`@supabase/supabase-js@2.x.y`); mid-term: self-host vendor files in `public/vendor/` (no bundler needed) |
| 6 | Missing rewrites for `/gerente`, `/delivery-cliente`, `/delivery-rider` | [vercel.json](vercel.json) rewrites list | Inconsistent URLs; printed QR/links to clean routes 404 | Add 3 rewrites (Sprint 0, zero risk) |
| 7 | Data-reset scripts stored as migrations (045/060/089/095/099/100) and demo seeds inside migrations | `supabase/migrations/` | Replaying migrations on a fresh DB (staging!) executes data deletions and stale seeds; the migration chain is not reproducible | Never replay blindly; move future resets into the harness; document which migrations are "ops scripts" |
| 8 | Teardown/runner unguarded: `run.ps1` runs any file against prod; `99_teardown.sql` has no confirmation gate and relies on hardcoded UUIDs | `_simulacion/run.ps1`, `_simulacion/99_teardown.sql` | One wrong `-File` argument = destructive SQL in production | Harness design §5: env-var guards, marker-scoped deletes |
| 9 | Teardown coverage gaps: doesn't explicitly delete `staff_sessions`, `ratings`, `waiter_calls`, `reservations`, `restaurant_addons`, `platform_events` for sim tenants — relies on FK `ON DELETE CASCADE` that not every table has | `_simulacion/99_teardown.sql` vs schema FKs | Orphan rows after teardown pollute metrics and future audits | Add explicit deletes + post-teardown orphan assertion (§5 `22_assert_orphans.sql`) |
| 10 | Silent error swallowing in shared modules: gating `catch(){ return _caps; }`, polling catches return null | [mythos-gating.js:58](public/mythos-gating.js#L58), [index.html:1276](public/index.html#L1276) | Failures invisible to user and developer (no error capture service exists) | Sprint 5: minimal frontend error logger (e.g. POST to a `client_errors` table or external service) |
| 11 | Copy-paste divergence between panels: gerente reads legacy `employee_shifts` while admin reads `staff_sessions`; `delivery_orders.status` vs `rider_status`; two stock models (`menu_items.stock` vs ingredients/recipes); `cost_per_unit` vs `unit_cost` | gerente.html vs admin.html; migrations 033/034/098 | Same business question answered differently per panel; future fixes land in only one copy | One consolidation migration + frontend sweep (architect decision #7) — after security sprints |
| 12 | Ghost tables documented but nonexistent (`caja_config`, `invoice_request`, `support_chat`, `delivery_channels`, `customers`) + prod schema drift (`delivery_orders` columns created by hand, referenced by mig 102) | CLAUDE.md vs grep `CREATE TABLE`; mig 102 column list | Agents/devs build against tables that don't exist; repo no longer sole source of schema truth | Sprint 0: correct CLAUDE.md; dump prod schema once (`supabase db pull`) to capture drift as a migration |
| 13 | No lint, no tests, no CI, JSX errors surface only in the end user's browser (Babel runtime) | repo-wide; §14 of system report | A typo ships to production undetected by anything | Sprint 5 (smoke CI) — even a parse-check of each HTML's JSX in CI catches the worst class |

## 4. Simulation data status

**What exists (confirmed live in prod, 2026-06-11, read-only):**
- 3 simulation restaurants with fixed UUIDs `a1a10000-…0001`, `b2b20000-…0002`, `c3c30000-…0003`.
- 15 auth users `*@mythos.test` with one shared password (documented in gitignored `_simulacion/INFORME.md`).
- Their operational rows (orders, turnos, movimientos, delivery, menu, tables, subscriptions).
- **Also: `restaurants` count is 4** — there is 1 non-simulation restaurant ("Terrapizza", per the teardown's own comment "NO toca Terrapizza ni Renato"). CLAUDE.md still says the platform is at factory zero. The architect should know real/manual data exists beyond the simulation.

**Teardown:** exists (`_simulacion/99_teardown.sql`). It is transactional, targets only the 3 sim UUIDs + `@mythos.test` emails, and is re-runnable (plain DELETEs). But it is **not guarded** (no confirmation variable, runner has a hardcoded prod PAT), and it has **coverage gaps** (§3.9) where it depends on FK cascades that may not exist (`orders.restaurant_id` is RESTRICT, which is why it deletes orders explicitly — other tables weren't audited the same way).

**Before deleting anything:**
1. Take a Supabase backup/snapshot (or at minimum `COPY` the sim tenants' rows out).
2. Run a pre-count report (rows per table per sim restaurant) — keep it with the report.
3. Run teardown inside a transaction with the post-counts in the same script.
4. Run an orphan check afterwards (rows whose `restaurant_id` no longer resolves, `user_roles`/`staff_sessions` pointing at deleted users).
5. Rotate the shared test password story by simply confirming `sim_users = 0`.

Per the task rules, **teardown was NOT executed** in this audit.

## 5. Automated simulation harness design

Design only — not implemented (it is not trivial, and it must not be born with a hardcoded PAT like its predecessor).

**Folder structure** (tracked in git; secrets only via env):

```
simulation/
├── README.md                  # how to run, safety model, marker conventions
├── .env.example               # names only: SUPABASE_PAT, SUPABASE_PROJECT_REF,
│                              # ALLOW_PROD_SIMULATION, CONFIRM_SIMULATION_TEARDOWN, SIM_RUN_ID
├── run.ps1                    # orchestrator: guards → seed → operate → assert → report [→ teardown]
├── lib/
│   └── exec-sql.ps1           # Management API executor (PAT from env, never hardcoded)
├── sql/
│   ├── 00_preflight.sql       # read-only: env fingerprint, counts of pre-existing [SIM] data
│   ├── 01_seed_restaurants.sql# 3 tenants, names '[SIM] …', UUIDs in namespace 51f70000-…
│   ├── 02_seed_staff.sql      # users *@mythos.test, per-run random password (printed once to report)
│   ├── 03_seed_menu_tables.sql
│   ├── 10_op_table_flow.sql   # QR order → cocina → mozo → caja, full status chain
│   ├── 11_op_delivery_flow.sql# delivery order → rider assign → delivered
│   ├── 12_op_caja_flow.sql    # turno open → cobros → cierre with arqueo
│   ├── 20_assert_money.sql    # sum(movimientos) == sum(paid orders) per tenant
│   ├── 21_assert_stock.sql    # stock movements reconcile with recipes
│   ├── 22_assert_orphans.sql  # no rows pointing at missing parents
│   ├── 23_assert_isolation.sql# cross-tenant probes (see below)
│   ├── 30_report.sql          # one JSON row: all counts + assertion results
│   └── 99_teardown.sql        # deletes ONLY rows matching markers; returns leftover counts
└── reports/                   # gitignored — JSON + markdown output per run
```

**Environment variables (no defaults for the dangerous ones):**

| Variable | Effect |
|---|---|
| `SUPABASE_PAT` | Management API token. Required. Never in a file. |
| `SUPABASE_PROJECT_REF` | Target project. Required — no fallback to the prod ref. |
| `ALLOW_PROD_SIMULATION` | Runner refuses to execute if `SUPABASE_PROJECT_REF` equals the known production ref (`ocwzupmamfojvdywavqi`) unless this is literally `true`. |
| `CONFIRM_SIMULATION_TEARDOWN` | `99_teardown.sql` is skipped unless literally `true`. The orchestrator additionally prints what would be deleted (dry-run counts) first. |
| `SIM_RUN_ID` | Optional; defaults to timestamp. Stamped into `notes`/`metadata` columns of created rows. |

**Safety guards (in the orchestrator, before any SQL):**
1. Prod-ref check (above), printed loudly.
2. Teardown double gate: env var **and** the SQL itself only deletes rows matching markers — never bare `DELETE FROM x` and never by name patterns that could match real data.
3. Seeds are idempotent: fixed UUIDs + `ON CONFLICT DO NOTHING`; operations stamp `SIM_RUN_ID` so repeated runs are distinguishable.
4. Every script starts with an `DO $$ … ASSERT` block verifying the 3 sim tenant rows carry the `[SIM]` name prefix before touching them (defends against UUID collision with real data).
5. The runner logs each executed file + duration to the report; non-zero assertion failures abort before teardown.

**Tagging convention (3 layers, all required):**
- Restaurant names prefixed `[SIM] ` (e.g. `[SIM] Napoli Pizza`).
- All user emails end `@mythos.test`.
- All sim UUIDs share the namespace prefix `51f70000-0000-4000-8000-…` ("SIF0" ≈ SIM-fixture) — distinct from the old `a1a1/b2b2/c3c3` run so old and new fixtures can't be confused.
- Where the table has `notes`/`metadata`, stamp `SIM_RUN_ID`.

**Assertions / checks:** money reconciliation per tenant; delivery chain completed (`pending→…→delivered` with timestamps monotonic); stock deltas match recipes; zero orphans; **tenant isolation** — using PostgREST with the anon key and with a sim staff JWT from tenant A, attempt to read/write tenant B's `orders`, `payments`, `suppliers`, `restaurants` and assert DENIED (this turns today's manual findings into a regression suite); plan limits — attempt to exceed `max_tables` via API and assert rejection (will fail until Sprint 3 lands: that's the point).

**Final report (`reports/<run_id>.md` + `.json`):** restaurants created, users created, orders created (by type), payments/movements created, delivery flow result, stock consistency result, orphan check, tenant-isolation matrix (expected-deny vs actual), teardown result (rows deleted per table + leftover count, must be 0).

## 6. Recommended implementation roadmap

Each sprint is sized to be one architect prompt → one reviewable change set.

**Sprint 0 — no-risk cleanup & hygiene (no DB writes):**
- Rotate Supabase PAT + service_role key (manual, Renato, dashboard). Remove the PAT from `run.ps1` (read from env).
- Add the 3 missing rewrites to `vercel.json`; pin `supabase-js` to an exact version in all 11 HTML files.
- Correct CLAUDE.md (ghost tables, resolved tracking bug, Terrapizza exists, `caja_config`→restaurants columns).
- `supabase db pull` (or equivalent) once to capture the prod schema drift as a baseline file.
- Backup prod.

**Sprint 1 — critical RLS/grants lockdown (1–2 new migrations, e.g. `103_anon_write_lockdown.sql`, `104_authenticated_tenant_scoping.sql`):**
- 103: revoke anon INSERT/UPDATE/DELETE/TRUNCATE on `restaurants`, `payments`, `staff_payroll_adjustments`, `waiter_debts`, `employee_shifts`, `kitchen_stations(+3)`, `platform_config`, `delivery_riders`, `delivery_zones`, `restaurant_settings`, `calendar_events`, `subscription_plans`, `plan_addons`, `restaurant_addons`; drop `sa_restaurants_all`, `admin_update_restaurant`, `sa_payments_all`, `dord_anon_update`; recreate scoped policies (superadmin via `get_my_role()`, staff via `get_my_company_restaurant_ids()`); revoke `get_user_email` from anon; drop the 068 dev RPCs. `NOTIFY pgrst, 'reload schema'`.
- 104: rewrite the remaining `USING(true)` authenticated policies (suppliers, support, shift_logs, manager_approvals, staff_*, stock set, expenses) to tenant-scoped — pattern of 086/092.
- Verify with the staff panels (all authenticated → expected zero behavior change for legitimate users) + re-run the read-only privilege query.

**Sprint 2 — anon ordering redesign (scoped RPC/token):**
- `create_table_order(p_scan_token, p_items jsonb, …)` SECURITY DEFINER: validates an active `table_scan_sessions` token, generates a per-restaurant order number server-side, inserts orders/items/extras/history atomically, returns `{order_id, order_number, order_token}`.
- `get_order_status(p_order_number, p_order_token)` for tracking (replaces open SELECT). Equivalent pair for delivery.
- Then revoke anon's remaining direct SELECT/INSERT on `orders`/`order_items`/`delivery_orders`. Realtime tracking moves to the token-filtered channel or polling the RPC.
- Frontend: `index.html` + `delivery-cliente.html` switch the 4-INSERT chain to one RPC call (smaller surface, fixes the order_number bug at the same time).

**Sprint 3 — plan-limit DB backstops:**
- Triggers `enforce_table_limit` / `enforce_menu_item_limit` (adapt `_simulacion/SOLUCIONES_propuestas.sql`); differentiate `allowed_features` per tier (new seed migration); optional: subscription-active check in panel guards.

**Sprint 4 — automated simulation harness:** implement §5 exactly; first run against a **staging** Supabase project (create one); only then, optionally, a guarded prod run.

**Sprint 5 — smoke tests / CI:**
- GitHub Actions: (a) JSX parse check of every panel with @babel/core in CI (catches the "error only in user's browser" class), (b) secret scan, (c) SQL migration dry-run against a disposable Postgres, (d) Playwright smoke of QR-order→cocina→caja against staging.

(Teardown of the current sim data slots between Sprint 0 and 1, after the backup.)

## 7. Files likely to change

| Sprint | Files |
|---|---|
| 0 | `vercel.json`; all 11 `public/*.html` (CDN pin only); `_simulacion/run.ps1` (PAT → env); `CLAUDE.md`; `.claude/skills/mythos-context/SKILL.md` |
| 1 | NEW `supabase/migrations/20260611_103_anon_write_lockdown.sql`; NEW `…_104_authenticated_tenant_scoping.sql` |
| 2 | NEW `…_105_order_rpc_and_numbering.sql`; `public/index.html`; `public/delivery-cliente.html`; `public/cocina.html` (drop reliance on anon delivery update, if any) |
| 3 | NEW `…_106_plan_limit_backstops.sql`; NEW `…_107_features_per_tier_seed.sql` |
| 4 | NEW `simulation/**` (README, run.ps1, lib/, sql/ ×12, .env.example); `.gitignore` (+`simulation/reports/`) |
| 5 | NEW `.github/workflows/ci.yml`; NEW `tests/smoke/*.spec.js` (Playwright); possibly `package.json` (devDependencies only — not a bundler) |

## 8. Do not change yet (intentionally untouched in this audit)

- **No teardown executed** — the 3 sim restaurants and 15 test users are still in prod (counts verified, nothing deleted).
- **No migration created or edited**; no RLS policy or grant changed (the confirmed holes in §2 remain open until Sprint 1 is approved).
- **No key rotation performed** — the PAT in `run.ps1` and the historically exposed secret key must be rotated by Renato in the dashboard (I cannot and should not rotate credentials).
- **No frontend edits** (CDN pins, rewrites, dead PIN code, gerente's `employee_shifts` read — all deferred to their sprints).
- **No harness code written** — design only, per instructions.
- The only prod interaction was a single read-only `SELECT` (counts + `pg_policies` + `information_schema` grants) executed via the existing runner to confirm findings §2.1/§2.2/§2.6; the temporary SQL file was deleted afterwards.
- Out of scope and untouched per rules: Bancard, SIFEN, CRM/`customers`, bundler, broad refactors.

*End of pre-sprint report — 2026-06-11.*
