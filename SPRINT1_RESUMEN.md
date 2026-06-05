# Sprint 1 — Refactorización y Hardening · Mythos
Fecha: 2026-05-27

---

## TAREA 1 — Saneamiento de migraciones

Se resolvieron 6 colisiones de numeración renombrando el segundo archivo de cada par con sufijo `b`:

| Colisión | Archivo conservado | Archivo renombrado |
|---|---|---|
| 009 | 009_delete_policies | → 009b_cover_and_hours |
| 036 | 036_mozo_waiter_call_type_tables_realtime | → 036b_kitchen_station |
| 051 | 051_rider_pin_system | → 051b_tables_pos_xy |
| 069 | 069_kitchen_stations | → 069b_fix_delete_where_clause |
| 085 | 085_invoice_request | → 085b_staff_broadcasts |

`20260501_FULL_SETUP.sql` renombrado a `.sql.bak` para que el CLI de Supabase lo ignore.
Era un rollup manual de las migraciones 001–008; su contenido ya existía en las migraciones individuales.

El orden alfabético es ahora determinístico: `036_` (ASCII 95) < `036b_` (ASCII 98).

---

## TAREA 2 — Migración 086: RLS multi-tenant

Archivo: `supabase/migrations/20260527_086_multi_tenant_rls_hardening.sql`

- Usa `public.get_my_restaurant_id()` (existe desde migración 029, SECURITY DEFINER) — sin recursión.
- Reemplaza todas las políticas USING(true) en:
  orders, order_items, delivery_orders, tables, menu_categories, menu_items.
- Usuarios autenticados: filtro estricto por restaurant_id = get_my_restaurant_id().
- Anon: SELECT permitido en tablas públicas (menú, mesas); INSERT/UPDATE habilitado
  en orders / order_items / delivery_orders para flujos QR cliente y delivery.
- Completamente idempotente (todo envuelto en DO $$ IF NOT EXISTS ... $$).

---

## TAREA 3 — Soporte Bancard / SIFEN

### Migración 087
Archivo: `supabase/migrations/20260527_087_orders_payment_provider.sql`

- orders.payment_provider  TEXT  CHECK IN ('bancard', 'tigo_money', NULL)
- orders.payment_ref        TEXT  (referencia externa: transaction_id, token, etc.)
- Índice por (restaurant_id, payment_provider) para reportes

### caja.html — metadata extendida
4 puntos de inserción en movimientos_caja actualizados con placeholders:
  metadata: { ..., transaction_id: null, auth_code: null, raw_response: null }

Aplica a: cobro de pedido salón, cobro de pedido delivery, ingreso/egreso manual, retiro parcial.

---

## TAREA 4 — Login unificado con localStorage

Archivo: `public/login.html`

- Nueva función saveSession(profile) guarda en localStorage:
    mythos_role, mythos_restaurant_id, mythos_user_id, mythos_display_name
- Al login exitoso: llama saveSession antes de redirigir.
- Al detectar sesión activa: usa caché de localStorage para redirect inmediato
  (evita un round-trip extra a Supabase en cada carga de login.html).
- Validación de restaurant_id con excepción explícita para superadmin
  (el superadmin no tiene restaurant_id en user_roles).

---

## PENDIENTES / ADVERTENCIAS para Sprint 2

1. CRITICO — Migración 086 en producción existente:
   Probar en staging antes de aplicar. La eliminación de políticas USING(true)
   puede romper paneles si algún user_roles está mal configurado.

2. order_items sin restaurant_id propio:
   Las políticas actuales usan subquery a orders. Con volumen alto conviene
   agregar restaurant_id directamente a order_items e indexarlo.

3. Superadmin bloqueado por RLS en orders:
   Si el superadmin no tiene restaurant_id en user_roles, la política
   orders_auth_insert lo bloquea (NULL != NULL). Necesita política especial
   con get_my_role() = 'superadmin' o usar Edge Function con service_role.

4. Guard de restaurant_id en los paneles:
   Los paneles (mozo, caja, cocina, etc.) aún no verifican
   localStorage.getItem('mythos_restaurant_id') al inicializar.
   Próximo paso: si el valor está ausente, redirigir a login.html.
