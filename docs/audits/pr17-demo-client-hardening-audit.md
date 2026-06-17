# PR-17 — Auditoría hardening demo/cliente

> **Tipo:** auditoría read-only + documentación. **No cambia producto.**
> **Fecha:** 2026-06-16. **Autor:** Claude Code (programador). **Para:** Renato (fundador) + ChatGPT (arquitecto).
> **Bloque:** A de la auditoría PR-15 (hardening demo/cliente), **etapa 1 (solo auditoría, sin fixes)**.
> Nada de DB/RLS/RPC/policies/migraciones/datos/runtime fue tocado. Teardown y dry-run **NO** ejecutados. Terrapizza **NO** tocada.

---

## 1. Estado base

| Campo | Valor |
|---|---|
| Commit base | `main` = `origin/main` = **`08013d8`** (PR-16) |
| Rama de esta auditoría | `audit/pr-17-demo-client-hardening` (desde `08013d8`) |
| Producción | `https://mythos-pos.vercel.app` (Vercel proyecto `mythos`) |
| Supabase | proyecto `ocwzupmamfojvdywavqi` |
| Última migración en repo | `20260616_108_harden_get_restaurant_capabilities.sql` |

**Qué NO se tocó:** DB, RLS, RPC, policies, migraciones (ninguna creada/editada), frontend, backend/runtime, datos, Terrapizza. No se corrió SQL en prod, ni seeders, ni teardown/dry-run. No se instalaron dependencias. Working tree limpio salvo los 3 `.md` no rastreados.

---

## 2. Resumen ejecutivo

**El sistema es apto para demos atendidas con cuentas/restaurantes de simulación, pero NO está listo para un cliente real** hasta cerrar dos bloqueos de seguridad cuyo estado **no es verificable localmente** (requieren consulta a Supabase prod).

- ✅ **Higiene de credenciales del repo: sólida.** Cero secretos hardcodeados en archivos rastreados; `service_role` solo server-side (`/api/create-user`, desde env, con verificación criptográfica de token + guard de tenant); `config.js` gitignored y generado desde env por `build.sh` (solo anon key, pública); cero IDs de sim/demo/Terrapizza embarcados en `public/`/`src/`.
- ✅ **Aislamiento de tenant a nivel cliente: consistente.** Todos los paneles operativos resuelven `RESTAURANT_ID` por contexto (sin fallback hardcodeado — el `…0001` quedó eliminado en mig 096) y filtran sus lecturas por `restaurant_id`.
- ⚠️ **Bloqueo 1 (seguridad):** la migración **105 (production drift hotfix)** documenta drift vivo en prod (tabla fantasma `delivery_channels` con acceso anon total, políticas `public_all_riders/zones USING(true)`, 3 RPCs `SECURITY DEFINER` sin guardia) y su encabezado dice *"PREPARED — DO NOT APPLY UNTIL…"*. **No puedo confirmar localmente si 105/106/107 fueron aplicadas.** Si NO lo fueron, hay acceso anon cross-tenant abierto → **bloqueo para cliente real**.
- ⚠️ **Bloqueo 2 (datos):** conviven en prod **datos de simulación + 15 logins `@mythos.test` con una contraseña compartida documentada**, junto a **Terrapizza (real)**. El plan de teardown está preparado (PR-14) pero **no ejecutado**. Contraseñas conocidas hacia un sistema productivo = bloqueo para cliente real.
- ⚠️ **superadmin es cross-tenant por diseño** y muestra **Terrapizza (real) + todos los tenants** → **no apto para demo abierta/no atendida**.

---

## 3. Exposición de credenciales/config

| Archivo | Hallazgo | Severidad | Acción recomendada | ¿Secreto real expuesto? |
|---|---|---|---|---|
| `api/create-user.js` | Usa `process.env.SUPABASE_SERVICE_ROLE_KEY` (server-side); valida token del caller contra `/auth/v1/user` (firma+exp) y rol en `user_roles`; guard de tenant (admin solo crea en su restaurante); rollback ante fallo | OK (patrón correcto) | Ninguna | **No** (lee de env) |
| `api/create-user.js:50` | `Access-Control-Allow-Origin: '*'` | Baja | El endpoint exige bearer válido + rol → riesgo bajo; opcional restringir origen | No |
| `build.sh` | Genera `public/config.js` desde env (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `RESTAURANT_ID`); sin default cableado | OK | Ninguna | No |
| `public/config.js` | **Gitignored** (`.gitignore:2`) y **NO rastreado** (verificado `git ls-files`) | OK | Mantener ignorado | No (no está en repo) |
| `.env.example`, `public/config.example.js`, `docs/SUPABASE_SETUP.md` | Contienen `eyJ…` **truncados/placeholder** de la anon key (pública por diseño) | Info | Ninguna | No (placeholder) |
| `.env`, `.env.*`, `_simulacion/` | Gitignored (`.gitignore:4-8,24`) | OK | Mantener | No verificable (no rastreados) |
| 3 `.md` no rastreados (`MYTHOS_*`) | Contienen IDs de sim, emails `@mythos.test`, `[REDACTADO]`, y el path del backup | Info (local, no commiteado) | **No commitear**; tratarlos como sensibles locales | Parcial (datos sim, sin claves vivas) |

> **No se imprimió ningún valor secreto.** Las apariciones de `service_role` en `docs/`, `pdfgen/`, `SKILL.md` son texto/reglas, no claves.

**Conclusión:** a nivel repositorio, **no hay secretos expuestos**. (El historial menciona una secret key expuesta en el pasado → su rotación es operativa en el dashboard, **no verificable localmente**.)

---

## 4. Aislamiento tenant/restaurante (a nivel cliente)

> Heurística: conteo de `.from('…')` vs `.eq('restaurant_id')` + inspección de la resolución de `RESTAURANT_ID`. **La frontera de seguridad real es RLS** (ver §7); los filtros de cliente son corrección/UX, no garantía.

| Panel | Tablas consultadas (muestra) | Filtro `restaurant_id` | Riesgo | Evidencia | Recomendación |
|---|---|---|---|---|---|
| `index.html` (QR, anon) | menu_categories, menu_items, coupons, tables, orders, waiter_calls, ratings, restaurants | **Sí** (todas por `RESTAURANT_ID`) | Bajo (cliente) | `index.html:68-69,87-88,111,167-168`; sin RID → "notfound", sin menú demo (`:118,:1864`) | OK; depende de RLS anon (mig 102) |
| `src/delivery-cliente` (anon, Vite) | restaurants, menu_*, delivery_zones, delivery_riders, delivery_orders, orders, ratings | **Sí** (`RESTAURANT_ID`) | Bajo | `main.jsx:103-132,148,192-194,228-251`; fuerza cliente anónimo (`:22-24`) | OK; depende de RLS anon |
| `src/delivery-rider` (login, Vite) | delivery_riders (por `user_id`), delivery_orders, orders | **Sí** (rider por su `id`/`user_id`) | Bajo | `main.jsx:25,564,582-606` | OK |
| `cocina.html` (login) | orders, delivery_orders, kitchen_*, ratings, restaurant_settings | Sí (`RID`) | Bajo-Medio | 34 `.from`, 10 `eq(restaurant_id)` + filtros por padre | Verificar RLS cocina en prod |
| `mozo.html` (login) | orders, order_items, tables, waiter_calls | Sí (`RID`) | Bajo-Medio | 60 `.from`, 17 `eq(restaurant_id)`; PR-16 agregó `payment_status` | OK; RLS prod |
| `caja.html` (login) | orders, turnos_caja, movimientos_caja, tables, payments | Sí (`RID`) | Bajo-Medio | 61 `.from`, 20 `eq(restaurant_id)` | OK; RLS prod |
| `gerente.html` (login) | orders, ratings, quejas, manager_approvals, employee_shifts, … | Sí (`RID`) | Bajo | 49 `.from`, 32 `eq(restaurant_id)` | OK; RLS prod |
| `admin.html` (login) | ~todas las del tenant | Sí (`RID`) | Bajo | 150 `.from`, 51 `eq(restaurant_id)`; orders load `eq(restaurant_id)` `:9475` | OK; RLS prod |
| `superadmin.html` (login) | restaurants, subscriptions, payments, platform_events, addons, … | **No (cross-tenant a propósito)** | **Medio-Alto para demo** | 60 `.from`, solo 2 `eq(restaurant_id)` | Aislamiento = RLS `get_my_role()='superadmin'`; **no apto para demo abierta** (ve Terrapizza real) |

**Conclusión:** el filtrado por tenant del lado cliente es **consistente y correcto** en todos los paneles operativos. `superadmin` es legítimamente cross-tenant y su única protección es RLS por rol.

---

## 5. Demo vs cliente real

| Zona | Riesgo de mezclar demo/cliente | Evidencia | Recomendación |
|---|---|---|---|
| Datos de simulación en prod | **Alto** — 3 restaurantes sim + 15 logins `@mythos.test` con contraseña compartida documentada, vivos junto a Terrapizza (real) | `MYTHOS_PRESPRINT_REPORT.md` (no rastreado); plan PR-14 `scripts/teardown/` | Ejecutar teardown guardado (PR-14) con backup nuevo, **o** rotar la contraseña compartida; decisión del arquitecto |
| Terrapizza (real) visible en superadmin | **Alto** en demo de superadmin | superadmin cross-tenant (§4) | No demostrar superadmin abierto; o excluir/proteger tenants reales |
| Restaurante por defecto | **Bajo** (resuelto) | `build.sh:8-11`, mig 096; `index.html:118` sin fallback | Mantener; no recablear `…0001` |
| IDs demo embarcados en frontend | **Ninguno** | grep en `public/`+`src/` = 0 coincidencias de sim/Terrapizza | OK |
| Menú/cupones demo | **Ninguno** | `index.html:108,314` "sin cupones/menú demo" | OK |
| Flag `[DEMO]`/`maintenance_mode` | Disponible pero sin restaurante demo dedicado | `restaurants.maintenance_mode/is_active` leídos en `index.html:167` | Sembrar `[DEMO]` etiquetado (plan en `scripts/teardown/seed-demo-data-plan.md`) |

---

## 6. Mutaciones y acciones destructivas

| Panel/script | Acción | Confirmación visible | Role guard aparente | Riesgo | Recomendación |
|---|---|---|---|---|---|
| admin/mozo/caja/gerente/superadmin | `.delete().eq('id', …)` de registros puntuales (menu_items, tables, reservations, expenses, recipes, kitchen_stations, calendar_events, order_items, restaurant_addons) | Mayormente sí (`setConfirmDialog`); a verificar caso por caso | Login + RLS de tenant | Bajo (flujo normal, registro puntual; sin mass-delete) | Auditoría liviana de consistencia de diálogos de confirmación |
| cocina/mozo/caja | Cambios de estado de orders/items (flujo `draft→…→delivered`, cobro) | Acción de flujo | Login + RLS | Esperado por flujo normal | Ninguna |
| `scripts/teardown/teardown-simulation-data.sql` | **Mass DELETE** de datos sim | Triple guarda + termina en `ROLLBACK` (inerte) | Guarda GUC + allowlist + umbral | Riesgoso pero **bloqueado por diseño** (PR-14) | No ejecutar sin backup nuevo + aprobación |
| `scripts/teardown/dry-run-…sql` | Solo SELECT/count | n/a | n/a | Ninguno | Seguro de correr (no ejecutado aquí) |
| `api/create-user.js` | INSERT auth.users + user_roles (+delivery_riders) | n/a (backend) | Token verificado + rol + tenant + límites de plan + rollback | Bajo | Ninguna |

**Conclusión:** no hay mutaciones destructivas masivas en el frontend; los deletes son CRUD puntual protegido por login+RLS. El único mass-delete (teardown) está inerte por diseño.

---

## 7. RLS/RPC/migraciones — lectura local

**Arco de remediación presente en el repo (cumulativo):** `086` (multi-tenant RLS hardening) → `090/091/092` (límites de plan, allowed_features, multi-sucursal) → `102` (anon PII lockdown) → `103` (anon write lockdown) → `104` (authenticated tenant scoping) → `105` (production drift hotfix, *prepared*) → `106/107` (fix `admin_list_restaurant_users` ambigüedad + tenant guard) → `108` (tenant-guard `get_restaurant_capabilities`).

**Qué parece sólido (según repo):**
- `/api/create-user` saca `service_role` del frontend (verificado en código).
- 102/103/104 cierran anon PII + anon write + scoping authenticated (la memoria registra Sprint 1 aplicado, Q10 todo 0).
- 108 cierra fuga de lectura cross-tenant en `get_restaurant_capabilities` (aplicada a mano en prod, según memoria).
- Las migraciones nuevas no editan viejas; el teardown está fuera de migraciones y guardado.

**Qué NO puede confirmarse sin Supabase prod (verificación con `pg_policies`/`information_schema`):**
1. **Si 105/106/107 fueron aplicadas.** El encabezado de 105 dice *"DO NOT APPLY UNTIL the architect gives the apply order"*. Si NO se aplicaron, **siguen vivos**: acceso anon total a `delivery_channels` (incl. `commission_pct`), `public_all_riders/zones USING(true)` (cross-tenant para authenticated), y 3 RPCs `SECURITY DEFINER` sin guardia (`admin_load_stock`, `admin_set_item_availability`, `admin_complete_stock_session`).
2. **Cierre 100% del `USING(true)` a nivel fila para `authenticated`** (CLAUDE.md menciona ~25 tablas históricas; 086/104 acotan la mayoría, pero la completitud no es verificable desde archivos — los conteos de `USING(true)` en migraciones son acumulativos, no estado final).
3. **Estado de los grants residuales a anon** (TRUNCATE/REFERENCES/TRIGGER en ~23 tablas) que 105 buscaba limpiar.

**Recomendación:** correr `docs/security/RLS_SPRINT_1_VERIFICATION.sql` (read-only) en prod **antes** de cualquier demo a cliente real, para confirmar el estado real de 1–3.

---

## 8. Aptitud por panel para demo

| Panel | Estado | Motivo | Requisitos previos | QA requerido |
|---|---|---|---|---|
| `index.html` (cliente QR) | **Apto con cautela** | anon; sin datos demo embarcados | Restaurante sim con menú + `?r=` + mesa | Visual + flujo pedido |
| `delivery-cliente` | **Apto con cautela** | anon; depende de RLS anon | Restaurante sim con menú + zonas | Visual + checkout |
| `delivery-rider` | **Apto con login** | requiere cuenta rider | `rider.*@mythos.test` + pedidos | Visual + cambio estado |
| `cocina` | **Apto con login** | requiere rol cocina | login cocina + pedidos en cocina | Visual KDS |
| `mozo` | **Apto con login** | requiere rol mozo | login mozo + mesas | Visual (PR-16 ya QA) |
| `caja` | **Apto con login** | requiere rol cajero | login caja + turno abierto | Visual |
| `gerente` | **Apto con login** | requiere `supervisor_local` | login gerente + datos del día | Visual (PR-16 ya QA) |
| `admin` | **Apto con login** | requiere rol admin | login admin + datos del tenant | Visual (PR-16 ya QA) |
| `superadmin` | **No apto para demo abierta** | cross-tenant: muestra Terrapizza (real) + todos los tenants | Solo demo atendida y consciente; nunca tocar Terrapizza | Alto / manual |

---

## 9. PRs futuros recomendados (pequeños, priorizados; ninguno iniciado)

1. **PR-18 — Verificación RLS en prod (read-only).**
   - Objetivo: correr `RLS_SPRINT_1_VERIFICATION.sql` y dump de `pg_policies` para confirmar estado real de 105/106/107 y residuales `USING(true)`.
   - Riesgo que reduce: incertidumbre de seguridad antes de cliente real.
   - Toca DB: **solo lectura** (SQL en prod). QA visual: no. Prioridad: **Alta**. Sin datos: sí (no muta).
2. **PR-19 — Aplicar drift hotfix (migs 105/106/107) si PR-18 confirma que faltan.**
   - Objetivo: cerrar anon en `delivery_channels`, quitar `public_all_riders/zones USING(true)`, guardar las 3 RPCs.
   - Riesgo que reduce: acceso anon cross-tenant abierto.
   - Toca DB/RLS/RPC: **sí**. QA visual: liviano (smoke de paneles afectados). Prioridad: **Alta**. Sin datos: sí.
3. **PR-20 — Decisión sobre datos sim en prod (teardown PR-14 con backup nuevo, o rotación de contraseña sim).**
   - Objetivo: eliminar logins compartidos conocidos hacia prod.
   - Riesgo que reduce: acceso con contraseña documentada a producción.
   - Toca DB/datos: **sí**. QA visual: no (verificación BD). Prioridad: **Alta**. Sin datos: no.
4. **PR-21 — superadmin demo-safety.**
   - Objetivo: modo demo/lectura o exclusión de tenants reales (Terrapizza) en sesiones de demo.
   - Riesgo que reduce: exposición de datos reales en demo.
   - Toca DB: posible (RLS/flag). QA visual: **sí**. Prioridad: **Media**.
5. **PR-22 — Seed de restaurante `[DEMO]` etiquetado** (según `seed-demo-data-plan.md`).
   - Objetivo: entorno demo reproducible separado de sim y de Terrapizza.
   - Riesgo que reduce: contaminación demo/real; demos sin datos.
   - Toca DB/datos: **sí** (seed idempotente). QA visual: **sí**. Prioridad: **Media**. Depende de PR-20.
6. **PR-23 — Auditoría de diálogos de confirmación en acciones destructivas del frontend.**
   - Objetivo: consistencia de confirmación en todos los `.delete()` puntuales.
   - Riesgo que reduce: borrados accidentales en demo/uso real.
   - Toca DB: **no**. QA visual: **sí**. Prioridad: **Baja**. Sin datos: sí.

> No proponer un mega-PR. Orden lógico: **PR-18 → PR-19 → PR-20** (bloqueos de cliente real), luego PR-21/PR-22 (demo segura), PR-23 (pulido).

---

## 10. Qué NO tocar todavía

- **Terrapizza** (UUID `01b5efb6-…`, real).
- **Teardown real** y **dry-run** (no ejecutar sin backup nuevo + aprobación).
- **Migraciones / RLS / RPC / policies** sin spec aprobado (105/106/107 incluidas — su aplicación la ordena el arquitecto tras PR-18).
- **Pricing / paywall / enforcement premium.**
- **CRM-CRUD** (tabla `customers` no existe = feature futura).
- **Más migración Vite** (ningún panel adicional).
- **Datos productivos** (sim incluidos), **seeds**, **scripts destructivos**.

---

## 11. Conclusión

- **Qué se puede mostrar (demo atendida con datos sim):** cliente QR, delivery-cliente, delivery-rider, cocina, mozo, caja, gerente, admin — todos con su restaurante de simulación y su login. El filtrado por tenant del lado cliente es consistente y no hay datos demo embarcados en el frontend.
- **Qué NO conviene mostrar:** `superadmin` en demo abierta (expone Terrapizza real + todos los tenants).
- **Qué endurecer antes de cliente real (bloqueos):** (1) confirmar/aplicar el drift hotfix de seguridad (105/106/107) — anon cross-tenant podría seguir abierto; (2) resolver los datos de simulación + contraseñas compartidas vivos en prod; (3) verificar el cierre 100% del `USING(true)` de fila en prod. Los tres requieren verificación/acción en Supabase, **no resolubles desde el repo**.
- **PR-17 no cambia producto:** es solo auditoría + documentación.

---

### Anexo — Incertidumbre / no verificable localmente

- Aplicación real de migraciones **105/106/107** en prod (encabezado 105 = "do not apply until ordered").
- Cierre 100% de `USING(true)` a nivel fila para `authenticated`/`anon` (requiere `pg_policies` en prod).
- Rotación efectiva de la secret key/PAT históricamente expuestos (acción de dashboard).
- Estado vivo de los datos de simulación y de las cuentas `@mythos.test`/`@mythos.internal` (requiere query a prod; el dry-run de PR-14 lo revelaría, **no ejecutado**).
- Comportamiento runtime de los paneles en prod no re-verificado aquí (auditoría estática de repo).
