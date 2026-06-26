# Teardown selectivo — conservar SOLO superadmin + Prueba1 (PREPARADO, NO EJECUTADO)

> Más amplio que el teardown de simulación (`SIMULATION_TEARDOWN_CHECKLIST.md`):
> este **también** borra Terrapizza. Conserva únicamente el superadmin oficial y el
> restaurante de `prueba1@gmail.com` con toda su data y todos sus usuarios.
> **Nada de esto se ejecutó.** Seguir top-to-bottom; no saltar el backup ni el inventario.

## Qué se conserva (y qué se borra)

**CONSERVAR (intacto):**
- (A) Superadmin `mancuellorenato@gmail.com` (`restaurant_id = NULL`) — **NUNCA se toca**.
- (B) El restaurante de `prueba1@gmail.com` ("Prueba1") + TODA su data tenant + TODOS sus
  usuarios (staff: mozo/caja/rider/etc.).
- Catálogo global: `subscription_plans`, `plan_addons`, `platform_config`. Schema/RLS/migraciones.

**BORRAR:** todo lo demás — Terrapizza, sims `a1a1…/b2b2…/c3c3…`, `@mythos.test`/`@mythos.internal`,
cualquier otro restaurante y sus usuarios/datos.

## Identificación (marcadores seguros, sin patrones frágiles)

- El restaurante a conservar se **resuelve por email + `user_roles`** (no se hardcodea UUID):
  `prueba1@gmail.com` → `auth.users` → `user_roles.restaurant_id`. Debe resolver a **exactamente 1**.
- El keep-set de usuarios = superadmin **∪** todos los `user_roles.user_id` con ese `restaurant_id`.
- El borrado **EXCLUYE por id** el restaurante de Prueba1 y los usuarios del keep-set (allow-list de
  sobrevivientes), nunca por denylist de nombre/patrón.

---

## PASO 1 — Backup NUEVO (MANUAL, OBLIGATORIO)

Antes de nada, en el Supabase Dashboard (proyecto `ocwzupmamfojvdywavqi`):
**Database → Backups** → confirmar/disparar un backup reciente, o `pg_dump` por el pooler.
**No avanzar sin un backup restaurable.** Registrar **path + fecha + operador** acá:

```
Backup nuevo:  path = ______________   fecha = __________   operador = __________   restore probado = sí/no
```

> El histórico (`C:\MYTHOS_BACKUPS\mythos_pre_rls_20260611_121455.dump`) **no** alcanza; tomar uno nuevo.

## PASO 2 — Inventario (SOLO LECTURA) + aprobación

Variables de entorno (PowerShell; nunca escribir el token a archivo):

```powershell
$env:SUPABASE_PAT          = '<PAT — pegar a mano, nunca guardar>'
$env:SUPABASE_PROJECT_REF  = 'ocwzupmamfojvdywavqi'
$env:ALLOW_PROD_SIMULATION = 'true'    # requerido: el target ES producción
```

Correr el inventario (read-only) y **guardar la salida**:

```powershell
.\_simulacion\run.ps1 -File .\scripts\teardown\dry-run-keep-prueba1.sql
```

> Alternativa: pegar `scripts/teardown/dry-run-keep-prueba1.sql` en el SQL Editor del Dashboard
> (en INGLÉS) y leer cada grid `§N`.

**Gate de aprobación — verificar a ojo antes de seguir:**
- [ ] `§0 superadmin_present = 1` y `prueba1_restaurants_resueltos = 1`.
- [ ] `§1` muestra el `restaurant_id` correcto de Prueba1.
- [ ] `§2` el de Prueba1 = `CONSERVAR`; Terrapizza y los sims = `BORRAR`.
- [ ] `§3` el superadmin y TODO el staff de Prueba1 = `CONSERVAR`; nadie del keep en `BORRAR`.
- [ ] **Renato aprueba la lista explícitamente.** ⟵ no avanzar sin esto.

## PASO 3 — Borrado (solo tras OK del inventario)

El borrado es un **único script transaccional** con guardas duras y `ROLLBACK` por defecto:
`scripts/teardown/teardown-keep-prueba1.sql`.

1. **Dry-run real** (con `ROLLBACK`): en la MISMA sesión, setear el GUC y correr el script tal cual.
   Revisar el `NOTICE` del POST-CHECK. No aplica nada (termina en `ROLLBACK`).
   ```sql
   SET mythos.keep_prueba1_confirm = 'RENATO_KEEP_PRUEBA1_BACKUP_DONE';
   -- pegar scripts/teardown/teardown-keep-prueba1.sql
   ```
2. **Aplicar**: solo si el POST-CHECK sale OK, cambiar la última línea `ROLLBACK;` por `COMMIT;`
   y re-ejecutar (con el GUC seteado en la misma sesión).

> El script borra en orden de dependencias (orders → bloqueadores → user_roles →
> restaurants[cascada 51 tablas] → auth.identities/users), **excluyendo por id** el restaurante
> y los usuarios de Prueba1. Borrar `auth.users` por SQL cascada sus hijos de GoTrue
> (identities/sessions/refresh_tokens). Es idempotente.

### (Opcional) Borrar las cuentas auth por Admin API en vez de SQL

El path recomendado es el SQL de arriba (atómico, un solo `BEGIN/COMMIT` con post-check). Si se
prefiere borrar `auth.users` con la Admin API (service_role), hacerlo **después** de que el SQL
commitee el resto, y re-correr el POST-CHECK. Secreto **solo** por env var (nunca hardcodear):

```powershell
$env:SUPABASE_URL          = 'https://ocwzupmamfojvdywavqi.supabase.co'
$env:SUPABASE_SERVICE_ROLE = '<service_role — pegar a mano, nunca guardar>'
$env:KEEP_RESTAURANT_ID    = '<restaurant_id de Prueba1, del §1 del inventario>'
$env:CONFIRM_TEARDOWN      = 'true'
node scripts/teardown/delete-auth-users.mjs   # (server-side; lista keep-set y borra el resto vía auth.admin)
```

(El script `delete-auth-users.mjs` se crea recién en PASO 3 si se elige este path; mantiene la
allow-list de sobrevivientes y aborta sin `CONFIRM_TEARDOWN=true` ni `KEEP_RESTAURANT_ID`.)

## PASO 4 — Post-check (SOLO LECTURA) + verificación funcional

```sql
SELECT
  (SELECT count(*) FROM public.restaurants)                                                     AS restaurants_left,   -- DEBE ser 1 (Prueba1)
  (SELECT count(*) FROM auth.users WHERE lower(email)=lower('mancuellorenato@gmail.com'))       AS superadmin_left,    -- DEBE ser 1
  (SELECT count(*) FROM auth.users WHERE lower(email)=lower('prueba1@gmail.com'))               AS prueba1_left,       -- DEBE ser 1
  (SELECT count(*) FROM public.restaurants WHERE name ILIKE '%terrapizza%')                     AS terrapizza_left,    -- DEBE ser 0
  (SELECT count(*) FROM auth.users WHERE email LIKE '%@mythos.test')                            AS sim_users_left,     -- DEBE ser 0
  (SELECT count(*) FROM public.orders o     WHERE NOT EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id=o.restaurant_id))   AS orphan_orders,        -- DEBE ser 0
  (SELECT count(*) FROM public.user_roles ur WHERE ur.restaurant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id=ur.restaurant_id)) AS orphan_roles; -- DEBE ser 0
```

- [ ] `restaurants_left = 1`, `superadmin_left = 1`, `prueba1_left = 1`, `terrapizza_left = 0`, `sim_users_left = 0`, huérfanos = 0.
- [ ] **Login `prueba1@gmail.com`** funciona; sus paneles (admin/caja/mozo/cocina según roles) cargan su data.
- [ ] **Login superadmin** funciona y ve solo Prueba1.

## PASO 5 — Registrar resultado

Anexar pre/post-conteos, fecha y operador acá (o en un `TEARDOWN_LOG.md`) para auditoría.

---

## Guardas y reversibilidad

| Riesgo | Mitigación |
|---|---|
| Borrar al superadmin/Prueba1 | Allow-list por id (keep-set capturado en TEMP antes de tocar roles); guardas que abortan si superadmin≠1 o Prueba1≠1 restaurante. |
| DB equivocada / email cambiado | Aborta si el superadmin o Prueba1 no resuelven exactamente. |
| Ejecución accidental | GUC `mythos.keep_prueba1_confirm` + `ROLLBACK` por defecto (hay que cambiar a `COMMIT` a mano). Runner exige `ALLOW_PROD_SIMULATION=true` (+ `CONFIRM_SIMULATION_TEARDOWN=true` para destructivos). |
| Huérfanos por FK | Orden por dependencias + post-check de huérfanos (deben ser 0). |
| Backup insuficiente | Backup NUEVO obligatorio + registrar path/fecha + restore probado. |
| Secretos en disco | PAT/service_role **solo** por env var; nunca a archivo (OneDrive sincroniza). |

**Estado: PREPARADO — NO EJECUTADO.** Esperando backup nuevo + aprobación del inventario por Renato.
