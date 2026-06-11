# RLS Sprint 1 — Manual Test Plan (run AFTER applying 103 + 104)

> Prepared 2026-06-11 (Sprint 1A). Execute this checklist immediately after
> applying `20260611_103_anon_write_lockdown.sql` and
> `20260612_104_authenticated_tenant_scoping.sql` to staging or production.
> Pair it with `RLS_SPRINT_1_VERIFICATION.sql` (run Before + After).
> If any step fails, record it in §Results and notify the architect before
> applying anything else.

## Prerequisites

- [ ] Database backup confirmed and restorable (HARD GATE — do not apply without it).
- [ ] `RLS_SPRINT_1_VERIFICATION.sql` baseline captured BEFORE applying.
- [ ] Both migrations applied in order (103 → 104), each ending in `NOTIFY pgrst`.
- [ ] `RLS_SPRINT_1_VERIFICATION.sql` re-run AFTER: Q10 all green.

## A. Staff panels keep working (authenticated paths)

1. **Login as superadmin (Renato)** at `/login`.
   - [ ] Dashboard loads with KPIs; Restaurantes page lists all 4 restaurants.
   - [ ] Capacidad page loads plans + add-ons (plans/plan_addons read OK).
   - [ ] Facturación page loads subscriptions (sa_subs_all rescope intact).
   - [ ] Configuración: toggle the global maintenance banner on and off
         (platform_config write is now superadmin-only — must still work here).
2. **Login as admin/manager of Terrapizza** (the only real restaurant).
   - [ ] `/admin` loads: Dashboard, Pedidos, Menú, Mesas.
   - [ ] Config page: edit a harmless field (e.g. notes/horario) and save —
         `restaurants_update_own` must allow it. Revert the change.
   - [ ] Stock page lists ingredients/recipes/alerts (scoped stock policies).
   - [ ] Proveedores page lists suppliers + contacts.
   - [ ] Personal → Turnos shows staff_sessions.
   - [ ] Estaciones page lists kitchen stations; open a station KDS link.
   - [ ] Marketing: create + delete a test coupon (coupons_auth_write).
   - [ ] Calendario: create + delete a local (non-global) event.
   - [ ] Soporte: open a ticket / send a message (support scoping).
3. **Open gerente, caja, cocina, mozo panels** with Terrapizza staff accounts
   (create via Personal → `/api/create-user` if none exist).
   - [ ] gerente: Dashboard, Supervisión (employee_shifts), Bitácora
         (shift_logs), Aprobaciones, Caja en vivo.
   - [ ] caja: open a turno, take a counter order, charge it, close the turno.
         Supervisor PIN modal (user_profiles) still resolves the PIN.
   - [ ] cocina: KDS shows the order; advance it to ready; station tabs load.
   - [ ] mozo: salon map loads; attend a table; "Mis/Todas" toggle.
4. **Authenticated order flow** (caja POS or mozo "Pedir más"):
   - [ ] Create → cocina receives → ready → delivered → charge. No RLS errors
         in the browser console (watch for 401/403 from PostgREST).

## B. Public client flows still work (intentionally preserved)

5. **QR order page loads**: open `/?r=<terrapizza_id>&t=<mesa>` in an
   incognito window (no session).
   - [ ] Menu renders (categories, items, extras, restaurant branding).
6. **Public QR order creation** (intentionally preserved this sprint):
   - [ ] Build a cart, confirm the order, see TrackingScreen advance when
         cocina moves it. Rating screen submits.
7. **Delivery client**: open `/delivery-cliente.html?r=<id>` incognito.
   - [ ] Coverage check works (delivery_zones anon read).
   - [ ] Create a delivery order — creation must succeed.
   - [ ] **EXPECTED TEMPORARY DEGRADATION (Sprint 1A.1):** the instant
         rider auto-assignment from the client now FAILS silently (anon
         UPDATE on delivery_orders was fully revoked). The order stays
         `rider_status='pending'`; the browser console will log
         `[delivery] auto-assign: error...` — this is expected, NOT a bug.
   - [ ] **Assignment via the authenticated path:** in cocina, mark the
         delivery ready → cocina's round-robin must assign the rider
         (order reaches `rider_status='confirmed'` with rider name).
         Until then the customer's tracking shows the pre-assignment step.
   - [ ] Tracking screen shows the assigned rider's NAME after cocina
         assigns (and can no longer query rider phone/commission — in the
         network tab a manual `select=phone` on delivery_riders must
         return a permission error).
8. **Rider panel**: login as a rider.
   - [ ] Sees the confirmed order, starts route, marks delivered, status
         returns to disponible (delivery_riders_auth_all).
8b. **Public reservation creation (preserved):**
   - [ ] From the QR client (`ReservationScreen`) create a reservation —
         must succeed and show the confirm number.
   - [ ] Same from the delivery client (`ReservaScreen`).
   - [ ] The reservation appears in admin/caja → Reservas with
         status `pending` for that restaurant only.

## C. Attacks that must now FAIL (use curl/Postman with the anon key only)

> Replace `<URL>`/`<ANON>` with the project values; these must all be DENIED.

9. **Anon cannot update restaurant name/status:**
   ```
   PATCH <URL>/rest/v1/restaurants?id=eq.<terrapizza_id>
   apikey: <ANON>   body: {"name":"hacked"}
   ```
   - [ ] Expect `42501` permission denied (or 404/0 rows). Same for DELETE.
10. **Anon cannot read or write payments / payroll:**
    ```
    GET  <URL>/rest/v1/payments?select=*                       → denied
    GET  <URL>/rest/v1/staff_payroll_adjustments?select=*      → denied
    POST <URL>/rest/v1/payments        {...}                   → denied
    GET  <URL>/rest/v1/waiter_debts?select=*                   → denied
    GET  <URL>/rest/v1/employee_shifts?select=*                → denied
    ```
11. **Anon cannot update delivery_orders AT ALL (Sprint 1A.1):**
    ```
    PATCH <URL>/rest/v1/delivery_orders?id=eq.<any>  {"rider_status":"confirmed"} → 42501 permission denied
    PATCH <URL>/rest/v1/delivery_orders?id=eq.<any>  {"delivery_fee":0}           → 42501 permission denied
    DELETE <URL>/rest/v1/delivery_orders?id=eq.<any>                              → denied
    ```
11b. **Anon reservation attacks (Sprint 1A.1):**
    ```
    GET    <URL>/rest/v1/reservations?select=*                          → denied (no SELECT)
    GET    <URL>/rest/v1/reservations?select=customer_name,customer_phone → denied
    PATCH  <URL>/rest/v1/reservations?id=eq.<any> {"status":"confirmed"} → denied (no UPDATE)
    DELETE <URL>/rest/v1/reservations?id=eq.<any>                        → denied (no DELETE)
    POST   <URL>/rest/v1/reservations {"restaurant_id":"<rid>", ...,
           "status":"confirmed"}                                         → RLS violation (only 'pending' allowed)
    POST   <URL>/rest/v1/reservations {..., "status":"pending"}          → 201 created (public flow preserved)
    ```
12. **Anon cannot read stations/stock/suppliers/support/etc.:**
    ```
    GET <URL>/rest/v1/kitchen_stations?select=access_token   → denied
    GET <URL>/rest/v1/ingredients?select=*                   → denied
    GET <URL>/rest/v1/suppliers?select=*                     → denied
    GET <URL>/rest/v1/calendar_events?select=*               → denied
    GET <URL>/rest/v1/subscription_plans?select=*            → denied
    ```
13. **Anon cannot enumerate users:**
    ```
    POST <URL>/rest/v1/rpc/get_user_email  {"p_username":"renaxto"}  → denied
    ```

## D. Cross-tenant isolation (if test accounts exist)

14. With a staff JWT from restaurant A (e.g. a `[SIM]` account while the
    simulation data still exists), query restaurant B's data:
    ```
    GET /rest/v1/suppliers?restaurant_id=eq.<other_rid>        → 0 rows
    GET /rest/v1/staff_sessions?restaurant_id=eq.<other_rid>   → 0 rows
    GET /rest/v1/expenses?restaurant_id=eq.<other_rid>         → 0 rows
    GET /rest/v1/reservations?restaurant_id=eq.<other_rid>     → 0 rows
    PATCH /rest/v1/restaurants?id=eq.<other_rid> {"name":"x"}  → 0 rows
    ```
    - [ ] All return empty/denied. (orders/tables/menu were already scoped by 086/092.)

## E. Diagnostics

15. - [ ] `/diag` logged out → "Acceso restringido". Logged in → checks run.

## F. Sprint 1B — drift hotfix tests (run AFTER applying migration 105)

> 105 closes production drift found by the post-apply verification of
> 103/104: `delivery_channels` open to anon, `public_all_*` /
> `public_read_*` USING(true) policies on riders/zones, anon-callable
> `admin_*` RPCs, and residual anon TRUNCATE/REFERENCES/TRIGGER grants.
> Pair with verification Q11–Q15 (before + after).

16. **Public delivery client still works** (`/delivery-cliente.html?r=<id>` incognito):
    - [ ] Coverage check / zone selector loads with fees and ETA
          (anon zone read is now `delivery_zones_anon_select`,
          `is_active = true` — the client already filtered active zones,
          so the list must be identical).
    - [ ] Create a delivery order end-to-end; tracking shows the rider's
          name after cocina assigns (rider anon read from 103 unchanged).
17. **Authenticated delivery settings still work** (admin of Terrapizza):
    - [ ] admin → Delivery: zone list loads; edit a zone's fee and save;
          create + delete a test zone (`delivery_zones_auth_all`).
    - [ ] Riders management: list, edit, change rider status.
18. **anon cannot list or mutate delivery_channels** (curl/Postman, anon key):
    ```
    GET    <URL>/rest/v1/delivery_channels?select=*                  → denied (42501)
    POST   <URL>/rest/v1/delivery_channels {...}                     → denied
    PATCH  <URL>/rest/v1/delivery_channels?id=eq.<any> {"commission_pct":0} → denied
    DELETE <URL>/rest/v1/delivery_channels?id=eq.<any>               → denied
    ```
19. **anon cannot mutate riders/zones:**
    ```
    PATCH <URL>/rest/v1/delivery_riders?id=eq.<any> {"name":"x"}     → denied
    PATCH <URL>/rest/v1/delivery_zones?id=eq.<any>  {"price_guarani":0} → denied
    GET   <URL>/rest/v1/delivery_zones?select=*&is_active=eq.false   → 0 rows (narrow policy)
    ```
20. **Cross-tenant staff isolation on channels/riders/zones** (staff JWT of
    restaurant A against restaurant B):
    ```
    GET   /rest/v1/delivery_channels?restaurant_id=eq.<other_rid>    → 0 rows
    GET   /rest/v1/delivery_riders?restaurant_id=eq.<other_rid>      → 0 rows
    PATCH /rest/v1/delivery_zones?restaurant_id=eq.<other_rid> {...} → 0 rows
    ```
21. **Stock / user-admin RPCs still work for valid staff** (logged in):
    - [ ] admin → Stock: cargar stock (`admin_load_stock`), abrir toma
          (`admin_create_stock_session`), completar toma
          (`admin_complete_stock_session`), listado (`admin_list_ingredients`).
    - [ ] admin → Personal: roster (`admin_list_restaurant_users`).
    - [ ] superadmin → Usuarios: listar (`admin_list_users`), activar/
          desactivar (`admin_toggle_user`), cambiar rol (`admin_update_user_role`).
    - [ ] Alta de usuario/rider vía Personal (`/api/create-user`) sigue
          funcionando (usa service_role en backend, no RPC).
22. **anon cannot call any admin RPC** (anon key, all must be denied —
    `42501 permission denied for function`):
    ```
    POST /rest/v1/rpc/admin_load_stock              {...} → denied
    POST /rest/v1/rpc/admin_set_item_availability   {...} → denied
    POST /rest/v1/rpc/admin_complete_stock_session  {...} → denied
    POST /rest/v1/rpc/admin_create_stock_session    {...} → denied
    POST /rest/v1/rpc/admin_create_user             {...} → denied
    POST /rest/v1/rpc/admin_list_users              {}    → denied
    POST /rest/v1/rpc/admin_toggle_user             {...} → denied
    POST /rest/v1/rpc/admin_update_user_role        {...} → denied
    POST /rest/v1/rpc/admin_list_ingredients        {...} → denied
    POST /rest/v1/rpc/admin_list_restaurant_users   {...} → denied
    ```

## G. Record results

| # | Step | PASS/FAIL | Notes (exact error if FAIL) |
|---|------|-----------|------------------------------|
|   |      |           |                              |

**Known acceptable degradations (document, don't fail):**
- **Delivery auto-assign is delayed (Sprint 1A.1):** the rider is no longer
  assigned instantly at order creation from the anon client; assignment
  happens when cocina marks the order ready (same round-robin, authenticated)
  or manually by staff. Instant assignment returns with the Sprint 2 RPC.
- **gerente/supervisor_local can no longer save restaurant fields** if they
  open admin.html → Config (`restaurants_update_own` is admin/owner only;
  gerente.html itself never updates restaurants — verified by grep). The
  save fails with 0 rows. If supervisors legitimately need an open/close
  toggle, that becomes a narrow-column RPC in Sprint 2.
- Legacy `user_profiles` rows with `restaurant_id = NULL` become invisible to
  caja's supervisor-PIN modal (policy now requires same-restaurant). Fix data
  if it bites: set the correct restaurant_id on those rows.
- Anon can no longer read rider phone/commission — if any UI displayed them
  to the public client (none found by grep), it will show blanks.
- Anon can no longer SELECT reservations. No anon panel reads reservations
  (verified by grep: index/delivery-cliente only INSERT, with
  `return=minimal`), so no visible impact is expected.

**Sprint 1B (105) acceptable degradations:**
- `delivery_channels` is fully closed to anon and tenant-scoped for staff.
  NO panel queries it (verified by grep across public/ and api/) — zero
  visible impact expected.
- `admin_create_user` and `admin_set_item_availability` become
  service_role-only: no panel calls them (user creation goes through
  `/api/create-user`; availability is updated via direct table writes).
- Inactive delivery zones are invisible to anon (the client already
  filtered `is_active = true`, so the rendered list is unchanged).
- KNOWN RESIDUAL for Sprint 2 (not a 105 regression): `admin_load_stock`
  and `admin_complete_stock_session` remain SECURITY DEFINER without an
  internal role guard — any authenticated user can still call them
  cross-tenant. Closing that requires editing function bodies.

**Rollback:** restore from the pre-apply backup, or revert policies/grants by
re-running the old policy definitions (kept in migrations 004→102). Because
103/104 only drop+create policies and revoke grants, a hotfix forward
(re-granting a specific privilege) is usually faster than a full restore.
