# Tenant RID mismatch en admin + riesgo latente `LIMIT 1` en helpers RLS

**Fecha:** 2026-06-23 · **Origen:** reporte de Renato — al crear categoría/mesa en
`admin.html` ([SIM] QA Starter) la base devuelve
`new row violates row-level security policy for table "menu_categories"` / `"tables"`.

## Qué pasó (no es un bug de la base)

La política de INSERT efectiva de `menu_categories` y `tables` (migración
[092](../../supabase/migrations/20260527_092_multi_sucursal.sql)) es:

```sql
WITH CHECK ( restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
             OR public.get_my_role() = 'superadmin' )
```

El panel inserta `restaurant_id: RID`, donde `RID = localStorage.mythos_restaurant_id`
([src/admin/main.jsx:31](../../src/admin/main.jsx#L31)). El error aparece cuando ese
RID **no pertenece al usuario logueado**. La RLS funciona como debe (aislamiento
multi-tenant). El encabezado igual muestra el nombre del restaurante porque
`restaurants` conserva una política de lectura abierta (`read_restaurants`,
[mig 103 §1](../../supabase/migrations/20260611_103_anon_write_lockdown.sql#L54)) para
el cliente QR → **ver el nombre no implica tener acceso de escritura**.

Causa práctica habitual: `localStorage.mythos_restaurant_id` viejo / sesión cruzada
(estás logueado con un usuario cuyo `user_roles.restaurant_id` ≠ RID).

### Mitigaciones aplicadas (2026-06-23)
- **Guard de tenant en `admin.html`** ([src/admin/main.jsx](../../src/admin/main.jsx)):
  al montar, llama `get_restaurant_capabilities(RID)`; si devuelve `NULL` **sin error**
  (señal definitiva de la [mig 108](../../supabase/migrations/20260616_108_harden_get_restaurant_capabilities.sql):
  cross-tenant/sin acceso), muestra una pantalla de bloqueo con botón "Volver a iniciar
  sesión" (limpia `mythos_*` + claves supabase). **No** bloquea ante error transitorio de
  red (no deja afuera a un admin legítimo); el superadmin nunca cae acá (la 108 le devuelve
  datos). Solo frontend — **no toca RLS**.
- **Diagnóstico SQL** read-only: [scripts/verify/qa-starter-rls-diagnostic.sql](../../scripts/verify/qa-starter-rls-diagnostic.sql).

## Riesgo latente para el chat de RLS — `LIMIT 1` sin `ORDER BY`

`get_my_company_restaurant_ids()` ([mig 092](../../supabase/migrations/20260527_092_multi_sucursal.sql#L38))
y `get_my_restaurant_id()` ([mig 086](../../supabase/migrations/20260527_086_multi_tenant_rls_hardening.sql#L21))
resuelven el restaurante del usuario con:

```sql
SELECT ... FROM public.user_roles
WHERE user_id = auth.uid() AND is_active = true
LIMIT 1;   -- ⚠️ sin ORDER BY → no determinista
```

`login.html` ([:256](../../public/login.html#L256)) selecciona **todas** las filas
activas del usuario y, si hay más de una, muestra un selector y guarda la elegida en
`mythos_restaurant_id`. **Si un usuario llega a tener ≥2 `user_roles` activos**, el
`restaurant_id` elegido en el login y el que eligen las funciones helper (LIMIT 1
arbitrario) pueden **diferir** → el panel opera un restaurante y la RLS autoriza otro →
exactamente este síntoma, pero sin RID viejo de por medio.

Hoy el seed deja 1 fila por usuario (la consulta (3) del diagnóstico lo verifica), así
que probablemente no es la causa de este caso puntual, pero es frágil.

**Recomendación (no aplicada acá para no chocar con el sprint de RLS):** agregar un
`ORDER BY` determinista (p. ej. `created_at`, o priorizar `restaurant_id IS NOT NULL`)
a ambas funciones, y/o un índice único parcial que impida `>1` rol activo por usuario.
Esto cambia funciones SECURITY DEFINER usadas por la RLS → debe ir en una migración del
sprint de RLS con análisis de impacto multi-tenant.
