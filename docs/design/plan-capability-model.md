# Modelo de capacidades y creación de planes (Mythos)

> Escrito el 2026-07-30 a pedido de Renato, a partir de las observaciones sobre el plan
> **Emprendedor** (módulos visibles que no corresponden al plan).
> Objetivo: dejar por escrito **la lógica**, no solo los parches — para que crear un plan
> nuevo mañana sea "elegir tier + ajustar", y no "acordarse de tocar 6 archivos".

---

## 1. Cómo funciona HOY

Hoy no hay **un** sistema de planes: hay **cinco mecanismos independientes**, y ninguno es
la fuente de verdad del otro.

| # | Mecanismo | Dónde vive | Qué controla | Default cuando falta |
|---|---|---|---|---|
| 1 | `subscription_plans.allowed_panels` | jsonb array | Paneles separados: `caja`, `mozo`, `cocina`, `delivery-cliente`, `delivery-rider`, `gerente` | **fail-CLOSED** desde mig 155 |
| 2 | `subscription_plans.allowed_features` | jsonb array `"panel:feature"` | Sub-módulos dentro de un panel | **fail-OPEN** (null ⇒ todo permitido) |
| 3 | `subscription_plans.max_*` | `max_tables`, `max_menu_items`, `max_users_by_role` | Cantidades | **fail-OPEN** (clave ausente ⇒ ilimitado) |
| 4 | `restaurants.service_mode` | `'salon'` \| `'delivery'` | Oculta Mesas + Menú QR de salón | `'salon'` |
| 5 | `restaurant_feature_overrides` + `restaurant_addons` | por restaurante | ON/OFF manual y add-ons pagos | vacío |

Resolución en la DB: [`get_restaurant_capabilities`](../../supabase/migrations/20260706_155_panel_entitlements_fail_closed.sql)
(paneles = `plan ∪ add-ons ∪ 'admin'`, menos overrides `false`, más overrides `true`).
Consumo en el front: [mythos-gating.js](../../public/mythos-gating.js) → `hasPanel()` / `hasFeature()` / `<PanelLock>` / `<FeatureLock>`.

**El catálogo real de features hoy son 6 keys** ([superadmin/main.jsx:227](../../src/superadmin/main.jsx#L227), de los cuales 3 están declarados "no vivos"):

```
admin:inventory · admin:delivery_zones · admin:crm
caja:sifen · caja:digital_payments · mozo:digital_qr_pay (oculto, no funcional)
```

---

## 2. Los tres defectos estructurales

### D1 — El menú del panel no tiene ninguna relación con el catálogo

`NAV` en [admin/main.jsx:391](../../src/admin/main.jsx#L391) es una lista hardcodeada de 22 entradas.
Un módulo queda gateado **solo si alguien se acuerda** de escribir `caps.hasFeature(...)` en el
`switch` de `renderPage()` ([admin/main.jsx:12172](../../src/admin/main.jsx#L12172)).

Hoy están gateados **5 de 22**: `estaciones`, `clientes`, `caja`, `stock`, `delivery`.
Quedan libres para cualquier plan: **agenda, personal, proveedores, marketplace, reportes,
finanzas, marketing, calificaciones, avisos**.

> **Esta es la causa de casi todas las observaciones de Renato.** No son bugs sueltos:
> son el mismo bug 6 veces. Y se repite automáticamente con cada módulo nuevo que se agregue.

### D2 — Los paneles de cliente corren como `anon` y no pueden ver el plan

`get_restaurant_capabilities` tiene un guard tenant-safe (mig 108): para `anon` devuelve `NULL`.
Por eso `index.html` (Menú QR) **no puede saber qué incluye el plan** y muestra "Reservar mesa"
siempre. Lo único que hoy ve el anónimo es:

- `restaurant_panel_enabled(rid, panel)` → granularidad de **panel**, no de feature;
- `restaurants.service_mode` → un flag suelto.

Falta una RPC **anon-safe de solo lectura** que exponga una lista blanca de flags públicos
(sin PII, sin precios, sin límites internos).

### D3 — Dos de los tres ejes fallan ABIERTOS

- `allowed_features = NULL` ⇒ **todo permitido** ([mythos-gating.js:96-108](../../public/mythos-gating.js#L96)).
- `max_users_by_role = {}` ⇒ **ilimitado** para todos los roles ([superadmin/main.jsx:216](../../src/superadmin/main.jsx#L216)).
  El plan *Emprendedor Delivery* se sembró con `'{}'::jsonb` ([mig 175](../../supabase/migrations/20260712_175_plan_emprendedor_delivery.sql#L49)):
  formalmente **mozos/cajeros/cocineros/riders ilimitados**. Hoy no explota solo porque
  `allowed_panels=[]` les impide entrar — o sea, está tapado por el otro eje, no resuelto.

Los paneles ya se arreglaron con mig 155 (fail-closed). **Faltan features y cantidades.**

---

## 3. El modelo propuesto

### 3.1 Un catálogo único (fuente de verdad)

Una sola tabla declarativa — `feature_catalog` en DB, espejada en un JS compartido que leen
superadmin, admin y la vidriera. Cada entrada:

```js
{
  key:          'admin:agenda',     // "superficie:modulo"
  label:        'Agenda y Reservas',
  surface:      'admin',            // admin | caja | mozo | cocina | client | delivery
  kind:         'module',           // panel | module (entrada de nav) | feature (sub-función)
  parent:       null,               // si tiene padre, se renderiza como pestaña adentro
  public:       false,              // ¿lo puede leer anon? (gating de superficies de cliente)
  default_tier: 'flexible',         // base | flexible | full  → con qué tier entra al crear un plan
  sellable:     true,               // ¿se vende suelto como add-on?
  when_locked:  'hidden',           // 'hidden' (desaparece) | 'upsell' (candado + CTA)
}
```

Dos campos hacen todo el trabajo conceptual:

- **`when_locked`** resuelve *"no tiene sentido que Personal esté habilitado en el plan más
  básico"*. Un emprendedor sin empleados no necesita ver un candado sobre "Personal": eso es
  ruido, no venta. En cambio Stock / CRM / Delivery **sí** son upsell legítimo. Hoy esa
  decisión no existe en ningún lado; se decide por accidente (si alguien escribió el gate o no).
- **`default_tier`** es lo que hace que crear un plan nuevo sea barato: elegís tier y el
  catálogo ya sabe qué entra.

### 3.2 Tres ejes + dos modificadores

Un plan es **exactamente** esto:

1. **Alcance** — qué *pantallas/puestos* compra (`allowed_panels`). Ya fail-closed.
2. **Capacidades** — qué *módulos y sub-funciones* tiene adentro (`allowed_features`). ← el hueco.
3. **Cantidades** — mesas, ítems, usuarios por rol, sucursales (`max_*`). ← fail-open, arreglar.

Y dos cosas que **NO son un tier de precio** y por eso no deben generar planes nuevos:

4. **`service_mode`** (salón / delivery) — es *la forma del negocio*, no su tamaño.
5. **overrides + add-ons** — la válvula comercial por restaurante.

> ### 🔑 La lección más importante para crear planes mañana
> Hoy existen **"Emprendedor"** y **"Emprendedor Delivery"**: mismo precio (₲150.000), mismo
> tier, misma capacidad — cambia solo `service_mode`. Eso es **duplicación de plan por un
> modificador**. Si se sigue así, cada tier nuevo se duplica: *Consolidado / Consolidado
> Delivery / Premium / Premium Delivery…* y con un tercer modificador (multi-sucursal, por ej.)
> se multiplica de nuevo.
>
> **Regla:** un plan = un punto de precio. La forma del negocio (salón / delivery / ambos) es
> un **atributo del restaurante** que se elige en el alta y que ya sabe derivarse solo
> ([trigger `sync_service_mode_from_plan`, mig 176](../../supabase/migrations/20260712_176_delivery_plan_wiring.sql#L122)).
> Si mañana se quiere seguir vendiendo "Emprendedor Delivery" como *tarjeta de vidriera*, que
> sea una tarjeta de marketing apuntando al mismo `subscription_plan_id` con otro `service_mode`
> por defecto — **no** una fila más en `subscription_plans`.

### 3.3 Cuatro capas de enforcement

Cada capacidad tiene que existir en las 4, y en este orden de confianza:

| Capa | Dónde | Qué hace | Sin esto pasa… |
|---|---|---|---|
| 1 · Verdad | `get_restaurant_capabilities` (auth) + **`get_public_capabilities` (anon, NUEVA)** | resuelve plan ∪ add-ons ± overrides | el front inventa |
| 2 · Nav | sidebar generado **desde el catálogo** | `hidden` desaparece · `upsell` muestra candado | D1: módulos de más |
| 3 · Página | el módulo se niega a renderizar (`FeatureLock`) | paywall real | entra por URL/estado |
| 4 · Escritura | RLS / trigger | rechaza el INSERT igual | se bypassea con la consola |

La capa 4 solo hace falta donde se escribe plata o personal (staff, pagos, stock, reservas).
Para el resto, 1-3 alcanza.

### 3.4 Capacidades **derivadas** (no todo es un checkbox)

Algunas capacidades no deberían tildarse a mano: se deducen de los otros ejes. Esto evita que
un plan nuevo quede incoherente por olvido.

| Módulo | Regla derivada |
|---|---|
| **Personal** | disponible ⟺ el plan otorga ≥1 asiento de staff (algún panel de staff en `allowed_panels`, o algún `max_users_by_role[rol] > 0`) |
| **Avisos personal** | ⟺ Personal disponible |
| **Mesas / Agenda** | ⟺ `service_mode ≠ 'delivery'` **y** `max_tables > 0` |
| **Estaciones** | ⟺ panel `cocina` |
| **Caja (vista admin)** | ⟺ panel `caja` |
| **Delivery (zonas)** | ⟺ panel `delivery-cliente` o `delivery-rider` |

Con esto, el plan Emprendedor (`allowed_panels=[]`, `max_users_by_role={}` → hay que sembrarlo
con **ceros explícitos**) pierde Personal y Avisos **sin que nadie tilde nada**.

### 3.5 Las tres familias (el encuadre de Renato)

| Familia | Idea | Alcance | Capacidades | Cantidades |
|---|---|---|---|---|
| **Base** — "sin capacidades" | dueño solo, sin empleados | `[]` (solo admin + Menú QR) | menú, pedidos, config, soporte, marketplace | mesas y roles en **0 explícito**, ítems acotados |
| **Flexible** — "el negocio real" | tiene empleados y salón | `caja`, `mozo`, `cocina` | + personal, agenda, stock, finanzas, reportes | topes generosos por rol |
| **Full** — "todo incluido" | cadena / operación completa | + `delivery-cliente`, `delivery-rider`, `gerente` | + CRM (con marketing y calificaciones), zonas, SIFEN, multi-sucursal | ilimitado explícito |

`default_tier` en el catálogo hace que crear un plan nuevo sea: **elegir familia → ajustar 2 o 3
cosas → guardar.** Hoy es tildar 30 casillas sin lista de referencia.

---

## 4. Observaciones de Renato → acciones

| # | Observación | Diagnóstico | Capa | Prioridad |
|---|---|---|---|---|
| 1 | Bloquear **Agenda**, y bloquear reserva al abrir el cliente QR | D1 + **D2** (el QR corre anon y no ve el plan) → necesita `get_public_capabilities` + `client:reservations` | 1,2,3 | leve, pero **es la que arrastra la RPC nueva** |
| 2 | **Personal** no debería estar en planes que no lo incluyen | D1 → capacidad **derivada** (§3.4) + `when_locked:'hidden'` | 2,3 | leve |
| 3 | **Proveedores** debe entrar en Marketplace › "Mis proveedores" | No es gating: es arquitectura de información. Fusionar `ProveedoresPage` ([admin:10383](../../src/admin/main.jsx#L10383)) en la pestaña `mis` de [restaurant-marketplace.jsx:750](../../src/marketplace/restaurant-marketplace.jsx#L750) y sacar la entrada de NAV | — | leve |
| 4 | **Realtime de admin no es al momento** | Ver §5 | — | media |
| 5 | **Marketing** y **Calificaciones** dentro de Clientes (y mejorar ambos) | IA: `admin:clientes` pasa a tener pestañas [CRM · Marketing · Calificaciones] con `parent:'admin:crm'`. La *mejora* de cada uno queda como trabajo aparte | 2,3 | leve |
| 6 | **Mitad y mitad** va en Menú › configuración, y no es solo pizza | Está en Config ([admin:8106](../../src/admin/main.jsx#L8106), rotulado "PIZZA MITAD Y MITAD"). La DB **ya es genérica** (`allows_half_and_half` por ítem, mig 169/170): es mover el bloque a MenuPage y recopiar a "Productos combinables por mitades" | — | leve |
| 7 | Botón **"Ver todos los paneles"** redundante | Duplicaba la entrada `paneles` del NAV → **borrado** (pie del sidebar, [admin/main.jsx:451](../../src/admin/main.jsx#L451)) | — | ✅ hecho 2026-07-30 |

> No hubo una observación #8: la línea cortada del mensaje original era la #7 (confirmado por Renato con captura del pie del sidebar).

---

## 5. Realtime de admin — diagnóstico

Estado del canal en [admin/main.jsx:12087-12101](../../src/admin/main.jsx#L12087):

- ✅ Las tablas **sí** están en la publicación `supabase_realtime` (`orders`, `order_items`, `tables`, `menu_items`).
- ❌ **`.subscribe()` no tiene callback de estado.** Si el canal responde `CHANNEL_ERROR` /
  `TIMED_OUT` / `CLOSED`, falla **en silencio** y el panel degrada al poll de 30 s — que es
  exactamente la sensación de "no es al momento". No hay reintento.
- ❌ **`_shouldPause()`** ([admin:52](../../src/admin/main.jsx#L52)) devuelve `true` con **cualquier**
  input/select/textarea enfocado o modal abierto → congela el refresco de mesas y menú. En un
  panel con buscador y filtros en casi toda pantalla, eso es "casi siempre".
- ❌ Faltan suscripciones a `delivery_orders`, `movimientos_caja` y `turnos_caja` → Finanzas,
  Caja y Delivery **nunca** se actualizan solos (solo con el poll de 30 s).

Fix propuesto: callback de estado con re-subscribe y backoff · poll adaptativo (8 s mientras el
canal no esté `SUBSCRIBED`, 30 s cuando sí) · no aplicar `_shouldPause` a listas de monitoreo
(solo a formularios) · agregar los 3 canales faltantes.

---

## 6. Orden de implementación sugerido

| PR | Contenido | Riesgo |
|---|---|---|
| **A** | Catálogo `MODULE_CATALOG` en JS compartido + NAV del admin generado desde el catálogo. Todo `default_tier:'base'` ⇒ **cero cambios de comportamiento**. Solo prepara el terreno | nulo |
| **B** | Cosméticos/IA sin gating: mitad-y-mitad → Menú (obs. 6) · borrar "Ver todos los paneles" (obs. 7) · Proveedores → Marketplace (obs. 3) · Marketing y Calificaciones → pestañas de Clientes (obs. 5) | bajo |
| **C** | Realtime admin (§5) | bajo |
| **D** | Migración: `feature_catalog` + **backfill de `allowed_features` de cada plan vivo con lo que hoy tiene de facto** + ceros explícitos en `max_users_by_role` del tier base, y recién ahí flip a fail-closed | **alto** ⚠️ |
| **E** | `get_public_capabilities(rid)` anon-safe + `client:reservations` consumido por index.html (obs. 1) | medio |
| **F** | Editor de planes del superadmin generado desde el catálogo (crear plan = elegir familia) | medio |

### ⚠️ La trampa del PR-D (ya nos pasó una vez)

Flipear `allowed_features` a fail-closed **sin backfill** repite exactamente el incidente de la
mig 155 pero al revés: ahí una lista vacía concedía *todo*; acá una lista incompleta va a
*quitar* módulos que los comercios hoy usan. El backfill y el flip **van en la misma
transacción**, y antes hay que listar plan por plan qué tiene de facto.

Reglas de la casa que aplican: migración nueva numerada (nunca editar una existente), backup
previo, SQL Editor en **inglés**, y `NOTIFY pgrst, 'reload schema'` al final.
