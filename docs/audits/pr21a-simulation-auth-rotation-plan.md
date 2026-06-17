# PR-21A — Plan de rotación/desactivación segura de cuentas sim compartidas

> **Autor:** Claude Code (programador). **Para:** Renato (fundador) + ChatGPT (arquitecto). **Fecha:** 2026-06-16.

## 1. Estado

- **STATUS: PLAN ONLY / NO AUTH CHANGES.**
- Base: `main` = `origin/main` = **`a51603a`** (PR-20).
- **No ejecución realizada:** no se tocó Auth, ni DB, ni datos, ni Terrapizza. Solo se agregan 1 script SELECT-only + este documento.
- Es el primer paso (reversible) del cierre del **Bloqueo 2** de PR-17, recomendado por PR-20.

## 2. Objetivo

- Reducir el riesgo de **cuentas demo/sim compartidas vivas en producción** (logins con contraseña conocida).
- Hacerlo de forma **reversible** (rotar/desactivar antes que borrar).
- **No tocar Terrapizza** ni ningún usuario real.
- Dejar listo el **inventario clasificado** y los **pasos manuales** para que, con aprobación, la operación sea segura y una cuenta por vez.

## 3. No objetivos

- **No** teardown. **No** borrar datos. **No** borrar usuarios.
- **No** cambiar RLS / RPC / migraciones.
- **No** tocar frontend/backend runtime. **No** Vite.
- **No** tocar pricing / paywall / CRM-CRUD.
- **No** ejecutar ninguna acción en Auth en este PR.

## 4. Hallazgos heredados de PR-20 (confirmados en prod)

Gauge de PR-20 (`scripts/verify/pr20-simulation-accounts-inventory.sql`, ejecutado por Renato):

| Métrica | Valor |
|---|---|
| `demo_restaurants_count` | 3 |
| `demo_users_count` | 25 |
| `demo_orders_count` | 24 |
| `demo_delivery_orders_count` | 5 |
| `real_tenant_present` | 1 (Terrapizza) |
| `terrapizza_present` | 1 |
| `recommended_action_hint` | `DEMO_PRESENT_ROTATE_OR_TEARDOWN` |

**Interpretación:** hay cuentas sim vivas en producción. La acción recomendada es **rotación/desactivación controlada y reversible** (no teardown todavía). `demo_users_count=25` es mayor que la estimación previa (~15-18) → probable acumulación de cuentas QA `@mythos.internal`; el inventario de PR-21A separa candidatas de protegidas.

## 5. Criterios de clasificación

| Clasificación | Significado |
|---|---|
| **`SIM_AUTH_CANDIDATE`** | Cuenta sim/QA candidata a rotación/desactivación futura. Email `@mythos.test`/`@mythos.internal` **o** con rol anclado a restaurante sim, **y sin** rol en tenant real. |
| **`PROTECTED_REAL_USER`** | Tiene al menos un rol en un restaurante **no-sim** (real / Terrapizza). **Nunca objetivo.** |
| **`REVIEW_REQUIRED`** | Superadmin, o vínculo no claro, o nombre sospechoso fuera de la allowlist. **Revisar a mano; no automatizar.** |

Para restaurantes: `SIM_CANDIDATE` (allowlist `a1a1/b2b2/c3c3`), `PROTECTED_REAL_TENANT` (Terrapizza o cualquier no-sim), `REVIEW_REQUIRED` (nombre demo/test fuera de allowlist).

## 6. Criterios de protección

- **Terrapizza siempre protegida** (por nombre `%terrapizza%` y por estar fuera de la allowlist).
- **Tenants no-sim** → protegidos.
- **Usuarios con rol en un tenant real** → protegidos (aunque también tengan un rol sim).
- **Usuarios sin relación clara** → `REVIEW_REQUIRED` (no objetivo).
- **Superadmin** → solo revisión manual; nunca acción automática.
- **Usuarios reales** → nunca tocar.

## 7. Inventario propuesto

`scripts/verify/pr21a-simulation-auth-inventory.sql` (SELECT-only, ejecutar a mano en el SQL Editor) devuelve:

0. **`guardrail_script_metadata`** — nombre, fecha lógica, `READ_ONLY`, aviso "NO AUTH CHANGES ARE PERFORMED".
1. **`restaurant_classification`** — cada restaurante con señales + clasificación + razón.
2. **`auth_user_inventory`** — cuentas candidatas: email, `created_at`, `last_sign_in_at`, `is_currently_blocked` (de `banned_until`), roles, `has_role_in_sim/nonsim`, clasificación + razón. **Sin hashes.**
3. **`shared_account_risk_signals`** — conteos por dominio (`@mythos.test`/`.internal`) y por nombre de rol genérico (admin/mozo/caja/…). Sin passwords.
4. **`protected_users_summary`** — conteo de usuarios con rol en tenant no-sim.
5. **`candidate_action_plan_input`** — por cuenta: acción futura sugerida (`ROTATE_PASSWORD_FUTURE_APPROVAL_REQUIRED` / `MANUAL_REVIEW_REQUIRED` / `DO_NOT_TOUCH_PROTECTED`).
6. **`gauge_summary`** — `sim_restaurants`, `sim_auth_candidates`, `protected_users`, `review_required`, `terrapizza_present`, `recommended_next_step`.

**Renato debe ejecutarlo manualmente** si aprueba avanzar. Las salidas con **emails completos** son datos sensibles: no pegarlas en chats públicos; manejarlas en el informe/privado.

## 8. Plan futuro de acción manual (sujeto a aprobación explícita)

- **Opción A — Rotar contraseña** de cada `SIM_AUTH_CANDIDATE` aprobada (reversible: se puede volver a setear; corta el riesgo de "contraseña conocida"). **Preferida.**
- **Opción B — Desactivar/bloquear** la cuenta sim si Supabase Auth lo permite de forma reversible (`ban`/disable temporal). Reversible.
- **Opción C — Cambiar el email demo** a un formato interno controlado, si aplica (más invasivo; solo si A/B no alcanzan).
- **Opción D — Dejar en review** las cuentas con duda (`REVIEW_REQUIRED`): no tocar hasta resolver.

Orden sugerido: **A** (rotar) como default; **B** (desactivar) si se quiere cortar acceso del todo; **C/D** según caso. Nada de esto se ejecuta en PR-21A.

## 9. Pasos seguros en Supabase Dashboard / Auth (solo para el futuro)

1. Entrar al **proyecto correcto** `ocwzupmamfojvdywavqi`.
2. Ir a **Authentication → Users**.
3. Buscar el **usuario exacto aprobado** (de la lista cerrada del Gate 4).
4. **Verificar** email / user id / restaurante asociado **antes** de tocar.
5. **No tocar Terrapizza** ni ningún usuario protegido.
6. Aplicar **una cuenta por vez**.
7. **Registrar** la acción (cuenta, qué se hizo, fecha, operador) en un log fuera del repo.
8. **Verificar el login** después (que el cambio surtió efecto y no rompió otra cosa).
9. **Detenerse ante cualquier duda** y volver a consultar.

## 10. Rollback

- Si una cuenta sim se necesita de nuevo: **re-rotar** su contraseña a una nueva conocida (Opción A) o **quitar el bloqueo** (revertir el `ban`, Opción B) — solo para cuentas aprobadas.
- Mantener un **registro de cambios manuales** (qué cuenta, acción, fecha) para poder revertir con precisión.
- **No** usar backups para revertir salvo emergencia real (rotación/desactivación son reversibles sin restore).

## 11. QA posterior sugerido

- **Login de usuarios reales** sigue funcionando.
- **Login de Terrapizza** (solo si Renato aprueba un test no invasivo).
- Paneles **admin / gerente / mozo / caja** siguen cargando.
- **Cuentas sim rotadas/desactivadas** ya no entran con la contraseña vieja.
- **Sin cambios** en datos ni pedidos (esto es solo Auth).

## 12. Gates de aprobación

1. **Gate 1** — merge del plan + script (este PR).
2. **Gate 2** — Renato ejecuta el inventario read-only.
3. **Gate 3** — el arquitecto revisa el resultado (clasificación + gauge).
4. **Gate 4** — Renato aprueba la **lista exacta** de cuentas objetivo.
5. **Gate 5** — acción manual en Auth, **una por una**.
6. **Gate 6** — QA posterior.

## 13. Conclusión

- **PR-21A prepara la operación**: inventario clasificado + plan + rollback + gates.
- **No ejecuta Auth ni DB writes.** Nada destructivo ni reversible-todavía-pendiente fue corrido.
- **Siguiente paso:** Renato corre el gauge real (Gate 2) y el arquitecto revisa antes de cualquier acción en Auth.

---

### Anexo — Qué NO se tocó en PR-21A
no DB writes · no Auth changes · no teardown · no dry-run teardown · no RLS/RPC/migrations · no frontend/backend runtime · no Vite · **Terrapizza untouched**.
