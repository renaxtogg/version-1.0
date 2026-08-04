# MYTHOS — Identidad del comensal y app de clientes (`/clientes`)

> **Estado:** **IMPLEMENTADO** el 2026-08-03 (migración **200** escrita, front
> completo y compilando). **La 200 todavía NO está aplicada en Supabase.**
> **Fecha del diseño:** 2026-08-03.
>
> El alcance final quedó **más grande que el v1 del §9**: Renato sumó reseñas
> multidimensionales, reputación, ranking, insignias, colecciones, retos y un
> registro de gustos configurable. Todo eso entró en la misma migración. Lo que
> se construyó, y los tres desvíos respecto de este documento, están en el
> **§13** al final — leerlo antes de tocar nada.

---

## 1. Propósito

Definir la capa de identidad que permite que **una persona** exista en Mythos por
encima de los restaurantes, para poder abrir la app de comensales en
`mythos.com.py/clientes`: cuenta propia, historial cruzado entre locales, puntos
acumulados, gift cards y —más adelante— reseñas y ranking.

Este documento cubre **sólo la identidad y el libro de puntos**. Descubrimiento,
ranking y gamificación quedan fuera a propósito (ver §9).

---

## 2. El problema

Mythos hoy es un SaaS B2B multi-tenant: **todo dato pertenece a un restaurante**.
La ficha de cliente (`customers`, mig 196) tiene `restaurant_id NOT NULL` y el
teléfono es único **por local**.

Consecuencia: si una persona come en tres restaurantes Mythos, es **tres clientes
distintos que no se conocen entre sí**. No hay a quién darle una cuenta, ni dónde
acumular puntos que valgan en más de un local.

Un consumidor no pertenece a ningún restaurante — los atraviesa. Eso es un eje
nuevo en el modelo:

```
hoy:    plataforma → restaurante → datos
falta:  plataforma → persona     → N restaurantes
```

La solución **no** es modificar `customers`. Eso rompería el CRM, su RLS y las
migs 196/197. La capa de persona va **arriba**, aditiva.

---

## 3. Decisiones tomadas

Cada una con el motivo, porque el motivo es lo que evita que se revierta por
error dentro de seis meses.

### 3.1 Sin cédula

La cédula **no** se pide para tener cuenta. Es fricción cara en el alta y no
resuelve lo que parecía resolver: crear 50 cuentas falsas ya es posible en
cualquier plataforma de reseñas del mundo.

La cédula sigue existiendo donde ya existe hoy: `customers.doc_number`, opcional,
declarada, y pedida sólo cuando alguien quiere factura. **Sin unicidad, nunca.**

> Un `UNIQUE` sobre `customers.doc_number` haría que un cajero que tipea mal una
> cédula **bloquee un cobro**. Viola la regla de CLAUDE.md: un fallo del CRM no
> puede frenar una venta.

### 3.2 Antifraude por pedido pagado, no por documento

Reemplaza a la cédula y no cuesta fricción:

> **Para reseñar un restaurante hace falta un pedido pagado en ese restaurante.**

Las cuentas falsas siguen siendo gratis; las reseñas falsas pasan a costar cenas
reales. Es lo que Google Maps estructuralmente no puede hacer, porque no ve la
transacción. Aplica cuando se implementen reseñas (fuera de v1), pero se decide
ahora porque condiciona el modelo de datos.

**Por qué importa más acá que en otras plataformas:** Google no le cobra
suscripción al restaurante que rankea. Mythos sí. Si a un cliente que paga lo
hunden con reseñas falsas, el reclamo viene a Mythos.

### 3.3 Identidad ≠ credencial

La cuenta se autentica por **canales verificados**, y ninguno de ellos es un dato
público como la cédula.

**Sin contraseña.** Tres canales, todos simétricos — cada uno sirve para entrar
*y* para recuperar:

| Canal | Costo | Rol | Estado |
|---|---|---|---|
| Google (OAuth) | gratis | alta y login diario | **v1** |
| Correo (link mágico) | gratis | alta y login diario | **v1** |
| Teléfono (código) | se paga por mensaje | verificar para absorber historial viejo | **postergado** (§5.2) |

`build.sh` ya trae `MYTHOS_AUTH_GOOGLE` y `MYTHOS_AUTH_FACEBOOK` preparadas y sin
usar, con degradación elegante si faltan.

**Regla:** una cuenta con **un solo** canal verificado es una cuenta sin
recuperación. Hay que mostrárselo al usuario así de claro y empujar el segundo.

### 3.4 El teléfono es llave de encuentro, no propiedad

El teléfono cumple un trabajo distinto del login: es **cómo los restaurantes
encuentran a la persona** en sus fichas de `customers`.

- Una persona tiene **N teléfonos**, no uno.
- Los números **se reciclan**: las operadoras reasignan líneas dadas de baja.
  Cuando alguien verifica un número que figura en otra cuenta, el número **se
  muda**: se libera de la vieja y se ata a la nueva.
- Se muda **el puntero, no la propiedad**: los puntos e historial ya ganados
  **quedan en la cuenta vieja**.
- Un número dado de baja **no se borra**: queda como liberado, para que las
  fichas locales que lo apuntaban no queden huérfanas.

### 3.5 El vínculo lo reclama la persona, el restaurante no lo empuja

Esta es la decisión que hace que la migración sea segura (§8).

Una coincidencia de teléfono encontrada por el local es un **candidato**, nunca un
vínculo. El vínculo se consuma cuando la persona **prueba que controla el
número** con un código.

Por qué nunca automático:

- **El nombre nunca coincide.** "Juan Pérez" / "Juan Perez González" / "JUAN P.".
  Sirve como señal para ordenar candidatos, jamás como condición.
- **Los números se reciclan.** Con vínculo automático, quien hereda tu número
  hereda tu historial.
- **El teléfono familiar.** El número de la madre pide para toda la casa.

### 3.6 Los puntos son EXPERIENCIA, no moneda

**Los puntos no se canjean.** Son XP: acumulan, hacen subir de nivel, y el nivel
es lo que da peso a la crítica. No son un saldo, no son deuda, no valen plata.

Consecuencias, todas a favor:

- **Desaparece el problema del canje cruzado.** Si fueran moneda, gastar en un
  local puntos ganados en otro exigiría un acuerdo comercial entre restaurantes
  —y el que recibe el canje querría que alguien le pague la diferencia—. Como
  XP, son de la plataforma y de la persona: nadie debe nada.
- **No hay pasivo contable.** Un saldo canjeable es plata que el local debe;
  el XP no.
- **Pero el antifraude importa más, no menos.** El XP no compra un café: compra
  **influencia** sobre el ranking. Ver §3.2 y la pregunta abierta de §11.

Las reglas de acumulación y la tabla de niveles se editan desde el **panel de
superadmin** (§4.6), no están cableadas en el código.

### 3.6.1 El XP se acumula antes de que exista la cuenta

El XP se anota contra la **ficha local** (`customer_id`) desde el primer pedido,
con o sin app. Cuando la persona se registra y vincula esa ficha, **absorbe todo
lo que ya había juntado sin saberlo**.

Es el único antídoto real contra el arranque en frío: el día que abre
`/clientes`, el primero que entra ve *"nivel 4 — 2.400 XP en 3 restaurantes"*, no
una pantalla vacía. Por eso la migración va **antes** que el panel, y admite
backfill del historial existente.

### 3.7 La unicidad va arriba, nunca abajo

`customers` no se toca. La unicidad de teléfono vive en la capa de persona, y
sólo sobre **vínculos verificados y vigentes** — nunca sobre las fichas crudas.

> Hoy el mismo número existe legítimamente en varias fichas de distintos locales,
> porque `customers.phone_digits` es único **por restaurante**. Una unicidad
> global sobre ese dato haría **fallar la migración el día que se aplica**.

---

## 4. Modelo de datos

Siete tablas nuevas. Ninguna columna nueva en tablas existentes.

### 4.1 `diners` — la persona

```sql
CREATE TABLE public.diners (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id      UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name      TEXT,
  email             TEXT,               -- copia del canal verificado (fuente: auth.users)
  email_verified_at TIMESTAMPTZ,
  avatar_url        TEXT,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','pending_recovery')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

La fuente de verdad del login sigue siendo `auth.users`; `email` acá es copia
desnormalizada para poder consultarla sin `SECURITY DEFINER`.

### 4.2 `diner_phones` — los teléfonos

```sql
CREATE TABLE public.diner_phones (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diner_id     UUID NOT NULL REFERENCES public.diners(id) ON DELETE CASCADE,
  phone        TEXT NOT NULL,
  phone_digits TEXT GENERATED ALWAYS AS
                 (regexp_replace(coalesce(phone,''), '\D', '', 'g')) STORED,
  is_primary   BOOLEAN NOT NULL DEFAULT false,
  verified_at  TIMESTAMPTZ,
  released_at  TIMESTAMPTZ,   -- se soltó: baja voluntaria o reciclado por la operadora
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un número VERIFICADO y VIGENTE pertenece a una sola persona.
-- Parcial a propósito: los no verificados (candidatos) y los liberados
-- (reciclados) no bloquean.
CREATE UNIQUE INDEX ux_diner_phones_active
  ON public.diner_phones (phone_digits)
  WHERE verified_at IS NOT NULL AND released_at IS NULL;
```

El índice **parcial** es el corazón del diseño: implementa a la vez la unicidad,
los candidatos sin verificar y el reciclado de números.

### 4.3 `diner_customer_links` — el puente

```sql
CREATE TABLE public.diner_customer_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diner_id      UUID NOT NULL REFERENCES public.diners(id)   ON DELETE CASCADE,
  customer_id   UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  linked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  linked_via    TEXT NOT NULL
                CHECK (linked_via IN ('order_claim','counter_claim',
                                      'phone_otp','manual_support')),
  UNIQUE (diner_id, customer_id)
);
```

`restaurant_id` va desnormalizado para que la RLS no tenga que hacer join.

### 4.4 `xp_ledger` — el libro de experiencia

```sql
CREATE TABLE public.xp_ledger (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  restaurant_id     UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  order_id          UUID REFERENCES public.orders(id)          ON DELETE SET NULL,
  delivery_order_id UUID REFERENCES public.delivery_orders(id) ON DELETE SET NULL,
  xp                INT  NOT NULL,
  rule_code         TEXT NOT NULL REFERENCES public.xp_rules(code),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotencia: un pedido acredita XP UNA sola vez, se corra el backfill las
-- veces que se corra.
CREATE UNIQUE INDEX ux_xp_order    ON public.xp_ledger (order_id)
  WHERE order_id IS NOT NULL AND rule_code = 'order';
CREATE UNIQUE INDEX ux_xp_delivery ON public.xp_ledger (delivery_order_id)
  WHERE delivery_order_id IS NOT NULL AND rule_code = 'order';
```

**Es sólo de suma** — no hay `redeem`, no hay saldo que baje. Una corrección se
hace con una fila negativa (`rule_code='adjust'`), nunca borrando.

**No lleva `diner_id`.** El XP se anota contra la ficha local; el total de una
persona se resuelve por join a través de `diner_customer_links`:

```sql
SELECT sum(xp) FROM xp_ledger
 WHERE customer_id IN (SELECT customer_id FROM diner_customer_links
                        WHERE diner_id = :me);
```

Así **vincular es un solo INSERT** en el puente y todo el historial pasado sigue
solo, sin reescribir el libro.

### 4.6 `xp_rules` y `xp_levels` — editables desde el superadmin

Ninguna regla de XP va cableada en el código. Ambas tablas se administran desde
**Superadmin › Clientes › Experiencia**, con el mismo molde de RLS que
`marketing_config` (mig 110): lectura pública, escritura sólo de superadmin.

```sql
-- Cuánto XP da cada cosa.
CREATE TABLE public.xp_rules (
  code         TEXT PRIMARY KEY,   -- 'order','review','first_visit','streak','adjust'
  label        TEXT NOT NULL,
  xp_fixed      INT     NOT NULL DEFAULT 0,  -- XP fijo por evento
  xp_per_1000   NUMERIC NOT NULL DEFAULT 0,  -- XP por cada ₲1.000 gastados
  xp_per_unit   INT     NOT NULL DEFAULT 0,  -- XP por unidad (ej.: dimensión calificada)
  per_event_cap INT,                         -- tope por evento (NULL = sin tope)
  daily_cap     INT,                         -- techo diario (NULL = sin techo)
  is_active    BOOLEAN NOT NULL DEFAULT true,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- La escalera de niveles.
CREATE TABLE public.xp_levels (
  level         INT PRIMARY KEY,
  name          TEXT NOT NULL,       -- 'Curioso', 'Habitué', 'Crítico'…
  min_xp        INT  NOT NULL,
  review_weight NUMERIC NOT NULL DEFAULT 1,  -- el "poder de crítica"
  perks         JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`daily_cap` no es un detalle: sin techo, el XP por gasto convierte al que más
gasta en el que más influye (§11.2).

`review_weight` es donde vive el "poder de crítica" del que hablamos. Queda
declarado ahora aunque las reseñas sean posteriores a v1, para que la escalera de
niveles no haya que rehacerla después.

### 4.5 `diner_recovery_requests` — la salida de emergencia

```sql
CREATE TABLE public.diner_recovery_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diner_id      UUID REFERENCES public.diners(id) ON DELETE SET NULL,
  claimed_email TEXT,
  claimed_phone TEXT,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected')),
  reviewed_by   UUID,
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Chica, pero **va desde el día uno**. Sin ella, quien pierde todos sus canales
queda encerrado sin salida y te enterás por un reclamo.

---

## 5. Flujos

### 5.1 Alta

1. Google o correo. Se crea `auth.users` + fila en `diners`.
2. Se empuja el **segundo canal** ("tu cuenta no se puede recuperar todavía").
3. El teléfono **no** se pide acá. Se guarda sin verificar cuando la persona lo
   carga, y sirve para sugerirle las fichas que puede vincular por el Camino B
   (§5.2).

### 5.2 Vinculación de fichas — sin código por SMS

**El OTP por teléfono queda postergado por presupuesto.** El diseño de
`diner_phones` (§4.2) lo contempla y no hay que rehacer nada cuando se active,
pero v1 sale con **dos caminos que no cuestan un guaraní**.

#### Camino A — automático, al pedir con sesión iniciada

Es el camino por defecto y cubre todo hacia adelante. Si la persona está logueada
cuando hace el pedido (QR de mesa o delivery), el pedido nace ya vinculado:
`create_order` recibe el `diner_id` junto al `payload.customer` que ya acepta
desde la mig 196, y el vínculo se inserta con `linked_via='order_claim'` en la
misma transacción.

No hace falta verificar nada: **la persona está demostrablemente haciendo el
pedido**. Costo cero, fricción cero.

> **Consecuencia técnica a resolver en implementación:** hoy `index.html` y
> `delivery-cliente` corren como `anon` con `persistSession:false` y storageKey
> propio (§8.4). Para que reconozcan una sesión de comensal iniciada, las tres
> superficies de cliente deben compartir el storageKey `mythos-cliente-app` —
> distinto del de staff, pero común entre ellas. Si no, el panel del QR no puede
> saber quién está pidiendo.

#### Camino B — asistido por el mostrador, para el historial viejo

Para absorber las fichas anteriores a la app. La app muestra un **código corto de
6 dígitos con vencimiento**; la persona se lo dicta al cajero, que lo tipea en
Caja; el vínculo se inserta con `linked_via='counter_claim'`.

La verificación acá es **presencia física**, que para este caso es más fuerte que
un SMS: el cajero está mirando a la persona. Y el restaurante ya está en el
circuito, así que no hay intermediario nuevo que pagar.

#### Lo que se pierde mientras no haya OTP

Nadie puede absorber su historial viejo **a distancia**: hay que volver al local
una vez. Es una molestia aceptable, y el Camino A hace que sea un problema que se
apaga solo con el tiempo.

Mientras tanto el teléfono se guarda igual en `diner_phones` **sin verificar** —
sirve como candidato y queda listo para cuando haya presupuesto para el código.

### 5.3 Cambio de canal, con enfriamiento

El riesgo: si entro con el correo porque perdí el teléfono y ahí mismo puedo
cambiar el teléfono, quien me robe el correo se queda con la cuenta en 30
segundos.

- Cambiar un canal se **confirma desde el otro canal** → instantáneo.
- Si el otro canal no responde, el cambio queda **pendiente 72 h**, con aviso al
  canal viejo y botón de cancelar.
- Agotado el plazo sin cancelación, se aplica.

### 5.4 Acumulación de XP

Trigger sobre el pedido pagado → lee `xp_rules` e inserta en `xp_ledger` contra
el `customer_id` de la ficha, respetando `daily_cap`. Si el pedido no tiene ficha
asociada, no acumula (nada que romper). Best-effort: **un fallo del libro de XP
jamás puede frenar un cobro**, igual que el CRM.

El nivel **no se guarda**: se deriva comparando el total contra `xp_levels`. Así
cambiar la escalera desde el superadmin recalcula a todos sin migrar datos.

---

## 6. RLS

La tabla `diners` concentra nombre, correo, teléfonos y vínculos de **todos los
comensales de toda la plataforma**. Es el dato más sensible que Mythos va a
tener — bastante más que cualquier ficha local suelta.

| Tabla | Comensal | Staff del local | Superadmin |
|---|---|---|---|
| `diners` | sólo su fila | **sin acceso** | sólo vía soporte |
| `diner_phones` | sólo las suyas | **sin acceso** | sólo vía soporte |
| `diner_customer_links` | sólo los suyos | **sin acceso** en v1 | lectura |
| `xp_ledger` | los de sus fichas | los de **su** restaurante | lectura |
| `xp_rules` / `xp_levels` | lectura | lectura | **ABM** |
| `diner_recovery_requests` | los suyos | sin acceso | ABM |

- `anon`: **sin acceso a ninguna**.
- El local ve el saldo de *su* ficha (lo necesita el mostrador), nunca la
  identidad global ni en qué otros locales come esa persona.
- Toda función `SECURITY DEFINER` con
  `SET search_path = public, extensions, pg_temp` (regla de la mig 195).

---

## 7. Qué NO hace la migración 200

Explícito, porque es la garantía de que no rompe nada:

- **No** modifica `customers`, `orders`, `user_roles`, `auth.users` ni `restaurants`.
- **No** vincula nada automáticamente. El día que se aplica, las tablas nuevas
  quedan **vacías** y para todos los registrados de hoy no cambia ni un campo.
- **No** requiere rebuild del frontend. Se aplica sola, se verifica que nada se
  movió, y recién después empieza el panel.
- Es reversible: `DROP` de las tablas nuevas deja el sistema como estaba.

---

## 8. Puntos de contacto con lo existente

Los cuatro lugares donde esto roza el sistema vivo.

### 8.1 `auth.users` es compartido con el staff — dueño y empleado que además comen

**La regla única, de la que sale todo lo demás:**

> No se agrega ningún rol de comensal a `user_roles`. Nunca.

Motivo concreto: `get_my_role()` (mig 029) devuelve **un solo** rol con `LIMIT 1`
ordenando `superadmin → admin → cajero → ELSE 3`. Un rol `cliente` ahí adentro
caería empatado en `ELSE 3` con `mozo`/`cocina` y **cuál gana queda indefinido** —
y de esa función cuelga el RLS de ~25 tablas.

Con esa regla respetada, la identidad de comensal vive **sólo** en `diners`, y
que una persona sea las dos cosas deja de ser un problema. Los tres casos:

**Regla de identidad (2026-08-03): una persona = un usuario de Auth. El contexto
se elige al entrar.**

Mythos ya había elegido este camino, y está escrito en la **migración 166**:

> **REGLA DE NEGOCIO (Renato):** una cédula = una persona = un `user_id`, pero esa
> misma persona **sí** puede tener rol en uno o más restaurantes.

Antes de la 166, `UNIQUE(user_id, role)` (mig 006) impedía que un mozo trabajara
en dos locales: el alta en el segundo **rebotaba**. La 166 mueve la unicidad de
fila para que incluya el restaurante, y defiende la identidad —cédula/username →
un solo `user_id`— con `EXCLUDE`.

> ⚠ La 166 está marcada **PREPARED, aplicar manualmente**. Confirmar si está
> aplicada en prod antes de asumir que el multi-local ya funciona.

#### Qué combinaciones funcionan

| Combinación | Estado | Por qué |
|---|---|---|
| Mismo rol en varios locales (mozo en 2) | ✅ con la mig 166 | El sistema no elige nada: sos mozo, y suma los locales |
| **Comensal + un rol de negocio** | ✅ **sin trabajo extra** | `diners` no usa `get_my_role()`: su RLS es `auth_user_id = auth.uid()` |
| Dos roles de negocio (admin **y** proveedor) | ❌ falta | `get_my_role()` devuelve UNO solo, y siempre el de más permisos |

La fila del medio es la que importa acá: **el perfil de comensal convive con
cualquier rol de negocio en la misma cuenta, hoy, sin tocar nada.** No hace falta
separar correos ni bloquear altas.

#### Lo que se evaluó y se descartó

Una tabla `auth_profile_registry` con PK sobre `auth_user_id`, para forzar "un
usuario de Auth = una sola rama". **Descartada:** va justo en contra de la regla
de la 166 y bloquearía el selector de contexto que sí se quiere. Queda anotado
para que no se vuelva a proponer.

#### Lo que sí falta: que el contexto elegido llegue a la base

El login ya sabe preguntar *"¿a qué panel entrás?"* y, desde el commit `8209db1`,
también *"¿a qué local?"*. Pero la base todavía **no escucha esa respuesta**:

- `get_my_role()` (mig 029) devuelve un solo rol con `LIMIT 1` por prioridad.
- `get_my_company_restaurant_ids()` (mig 092) resuelve el restaurante con
  `LIMIT 1` **sin ORDER BY** para roles operativos.

Las dos derivan el contexto **del usuario**, no de la sesión. Mientras sea así,
elegir en el login es cosmético: la RLS sigue apuntando a lo que decidió la base,
y quien elija "el otro" local va a ver el panel vacío.

Hacerlas sensibles al contexto elegido (claim en el JWT, o tabla de sesión) es el
trabajo que habilita a la vez el multi-local real y el selector de ramas. Toca la
función de la que cuelga la RLS de ~25 tablas, así que **no se encara mientras
siga abierta la deuda de RLS que es la prioridad 1 de CLAUDE.md** — no conviene
operar dos veces sobre la misma zona.

**Mientras tanto**, para el caso raro de alguien que necesite dos roles de
negocio: el mismo buzón admite varias direcciones
(`juan+proveedor@gmail.com` llega a `juan@gmail.com`). Cero costo, cero riesgo.

#### El empleado queda separado solo

No hace falta ninguna regla: el login del empleado es el sintético
`${cedula}@mythos.internal`, así que si se registra como comensal con su correo
real son **dos cuentas distintas por construcción**.

Y conviene que siga así. El empleado recibe una cuenta creada por su admin, **con
una contraseña que el admin eligió** (`create-user.js`). Si esa misma cuenta
cargara además su identidad de comensal, **el patrón podría entrar al perfil
personal de su empleado** y ver dónde come y qué opina de otros restaurantes. El
dueño, en cambio, elige su propia contraseña: para él fusionar es seguro.

> **Regla:** si algún día el empleado pasa a loguearse con su correo real, hay que
> revisar esto — su privacidad deja de estar garantizada por construcción.

**Sobre el correo real del empleado — ya existe.** `create-user.js` acepta
`recovery_email` y lo guarda en `user_roles.recovery_email`, con la regla escrita
de que **el sintético NUNCA se muestra como "su correo"**. Lo que falta no es
capturarlo, es *usarlo*: hoy un empleado no puede recuperar su contraseña solo,
porque no recibe correo en `@mythos.internal` y el reseteo pasa por el admin.
Habilitar el reseteo contra `recovery_email` es una mejora independiente y
conviene hacerla.

**El sintético no se puede eliminar:** hay empleados sin correo (cocina, limpieza,
personal temporal). Sin ese fallback no se los podría dar de alta.

Queda pendiente igual la sesión del navegador (§8.4): que una cuenta pueda llevar
los dos sombreros no sirve de nada si `/clientes` y `/admin` se pisan el token.

### 8.1.2 El teléfono sí es común a los tres perfiles

El correo separa; **el teléfono une**, y tiene que ser así: es la llave con la que
el mostrador reconoce a la persona (§3.4), y una persona tiene un teléfono más
allá de cuántos perfiles tenga en el sistema.

No hay conflicto técnico: el teléfono del staff vive en `user_roles` /
`restaurants`, el del comensal en `diner_phones`, y **ninguna restricción cruza
las dos**. La unicidad del §4.2 aplica sólo entre comensales.

> **Regla:** el teléfono es un dato compartido, pero **ninguna consulta puede
> usarlo para correlacionar perfiles**. Que el mozo Juan sea también un comensal
> no puede ser deducible desde ningún panel. Lo garantiza la RLS de §6 —
> `diner_phones` no es legible por staff— y hay que sostenerlo cuando se agreguen
> reportes.

### 8.1.3 ⚠ `delete-restaurant` puede destruir la cuenta personal de un comensal

**Riesgo concreto, verificado en el código.** `api/delete-restaurant.js` con
`delete_users: true` borra el usuario de `auth.users` salvo que sea la cuenta
protegida, sea superadmin, o tenga rol en otro restaurante. **No mira si ese
usuario tiene fila en `diners`.**

**Es un riesgo de primera línea, no una red de seguridad.** Con la regla de §8.1
—una persona, un usuario de Auth, rol de negocio y perfil de comensal en la misma
cuenta— **el caso es el normal, no la excepción**: cualquier dueño que además use
la app comparte usuario entre `user_roles` y `diners`.

Hoy se borra el usuario mirando sólo su costado laboral. En cuanto exista
`/clientes`, eliminar un restaurante le destruye al dueño su **cuenta personal**:
XP, historial y gift cards de **otros** locales que no tienen nada que ver con el
que se borró. Y es irreversible.

> Si el `user_id` tiene fila en `diners`, **no se borra el usuario de Auth**: se
> le quitan los roles de staff y se lo deja como comensal. Sumar el motivo
> `'es comensal'` a `usersSkipped`.

### 8.1.1 La verificación del correo sale gratis — pero hay algo que verificar

**La verificación del comensal no depende del ajuste "Confirm email" de
Supabase**, porque el login es sin contraseña (§3.3):

- **Google** — Google ya verificó que el correo es suyo.
- **Link mágico** — hay que abrir la casilla para entrar. **La verificación *es*
  el login.**

O sea que el perfil del comensal queda verificado por construcción, sin depender
de una configuración que hoy está apagada para el funnel de dueños.

> **⚠ A verificar en el dashboard ANTES de abrir `/clientes`:** si "Confirm email"
> sigue apagado para el alta de dueños, aparece un vector nuevo al juntar los dos
> funnels:
>
> 1. Alguien se registra en `/registro` con `victima@gmail.com` + contraseña. La
>    cuenta se crea **sin verificar**.
> 2. La víctima entra después a `/clientes` con Google usando ese mismo correo.
> 3. Si Supabase **enlaza** la identidad de Google a la cuenta preexistente sin
>    verificar, la víctima termina compartiendo cuenta con quien puso la
>    contraseña.
>
> El comportamiento depende del ajuste de *identity linking* del proyecto. Hay que
> mirarlo en el dashboard y, si hace falta, prender la confirmación de correo en
> el alta de dueños. No es un problema de este diseño, pero **se activa recién
> cuando `/clientes` existe**.

### 8.2 El mismo teléfono ya existe en varias fichas

Legítimo: `customers.phone_digits` es único por restaurante. La unicidad nueva va
sólo sobre `diner_phones` verificados y vigentes (§4.2), nunca sobre `customers`.

### 8.3 El backfill de puntos tiene que ser idempotente

Resuelto por los índices únicos parciales sobre `order_id` /
`delivery_order_id` (§4.4).

### 8.4 La sesión del navegador — requiere una línea desde el principio

Hoy hay un patrón deliberado: los paneles del comensal usan storageKey propio y
**no** persisten sesión (`src/index/main.jsx:32` → `mythos-anon-cliente`;
`src/delivery-cliente/main.jsx:31` → `mythos-anon-delivery-cliente`), mientras
que los paneles de staff usan el storageKey por defecto de Supabase.

`/clientes` es el primer panel que **sí** necesita persistir sesión. Con el
storageKey por defecto compartiría la ranura del token con el staff: un dueño que
entra a `/clientes` desde su celular **le pisa la sesión de `/admin`**, y el
logout de uno cierra el otro (la arquitectura de sesión es de signOut global).

> **Regla:** `/clientes` con `storageKey: 'mythos-cliente-app'` y
> `persistSession: true`.

---

## 9. Alcance de v1 (`/clientes`)

**Entra:** cuenta, mis pedidos cruzados, repetir pedido, mi XP y mi nivel, mis
gift cards.

**No entra:** descubrimiento de restaurantes, ranking mensual e histórico,
reseñas, niveles de crítico, puntos por calificar.

Motivo: lo que entra **ya sirve con un solo restaurante**; lo que no entra
necesita densidad de locales y un flujo de moderación que todavía no existe
(prioridad 9 de CLAUDE.md).

**El shell no es el de los paneles de staff.** El sidebar con íconos, grupos y
grilla de KPIs está pensado para un cajero frente a un monitor. El comensal entra
de noche, con una mano y con hambre: navegación abajo al alcance del pulgar,
pantallas de un objetivo cada una. Mismos tokens de `design-system.css`, shell
distinto.

---

## 10. Plan de implementación

| # | Entregable | Depende de |
|---|---|---|
| 1 | Este documento, revisado y aprobado | — |
| 2 | Migración **200** — tablas, índices, RLS, RPCs, backfill de XP | 1 |
| 3 | Rewrites `/clientes` y `/restaurantes` + `sitemap.xml`/`robots.txt` al dominio real | — |
| 4 | **Superadmin › Clientes › Experiencia** — ABM de `xp_rules` y `xp_levels` | 2 |
| 5 | Esqueleto del panel (`src/clientes/main.jsx`, `vite.config.clientes.mjs`, `public/clientes.html`, `npm run build`) + login Google/correo | 2, 3 |
| 6 | ~~Bloqueo cruzado de altas~~ — **descartado**: una cuenta puede llevar rol de negocio + perfil de comensal (§8.1) | — |
| 7 | **Guarda en `delete-restaurant.js`** — no borrar de Auth a quien tenga fila en `diners` (§8.1.3) | 2 |
| 8 | Vinculación por mostrador — campo de código en Caja | 5 |
| 9 | Pantallas de v1 | 5 |

El paso **7 es bloqueante**: no se abre `/clientes` sin esa guarda, porque con la
regla de §8.1 compartir cuenta es el caso normal y el borrado es irreversible.

Cada paso es deployable solo. El 3 es independiente y se puede hacer ya.

**Antes de aplicar la 200: backup**, por costumbre, no por riesgo.

---

## 11. Preguntas abiertas

### 11.1 Valores iniciales de `xp_rules` y `xp_levels`

Las tablas se editan desde el superadmin, así que esto no bloquea la migración —
pero hay que sembrarla con algo. Falta definir: XP por cada ₲1.000, XP fijo por
visita, cuántos niveles, cómo se llaman y a qué XP arranca cada uno.

### 11.2 De dónde viene el XP — RESUELTO: de la contribución

**Decidido (2026-08-03):** el XP sale de contribuir, **no del monto gastado**.
El nivel mide lo que dice medir, y el que más plata gasta no compra el voto más
pesado sobre el ranking.

Fórmula en definición (borrador de Renato, números tentativos):

| Componente | XP |
|---|---|
| Reseñar un restaurante (base) | 1.000 |
| Por cada dimensión calificada (sabor, lugar, precio…) | 100 c/u |
| Foto | +300, por encima del tope de la reseña |

El diseño premia la **completitud**: 9 de 10 dimensiones = 900, no 1.000.

**Dependencia que esto crea — importante:** la fórmula necesita reseñas
**multidimensionales**, y `ratings` hoy es sólo `stars` + `comment` (mig 001).
Las dimensiones tienen que ser una tabla configurable, no una lista cableada, o
cada cambio de criterio pide una migración. Esto agranda el módulo de reseñas
respecto de lo previsto — no afecta a v1 (las reseñas quedan fuera, §9), pero sí
define cómo se construye después.

**Antifarmeo:** ya está cubierto por la regla de §3.2 — una reseña por pedido
pagado. Nadie puede completar 10 fichas de dimensiones por día sin 10 cenas.
El riesgo remanente es reseñar rápido y mal para juntar XP; se acota con largo
mínimo de texto y `per_event_cap`.

**Opción a considerar:** XP extra por reseñar un local con pocas reseñas.
Empuja cobertura donde falta, en vez de amontonar reseñas sobre los mismos tres
restaurantes de siempre.

### 11.3 Nombre de la ruta

`/clientes` colisiona con el vocabulario interno (Admin › Clientes es el CRM del
local). `/comer` no admite dos lecturas.

### 11.4 ¿Aparecer en la app es opt-in del restaurante?

Aplica recién con descubrimiento, pero conviene decidirlo antes de construirlo.
Es una feature de plan, como los destacados de proveedores de la mig 199.

---

## 12. Decisiones registradas

| Fecha | Decisión |
|---|---|
| 2026-08-03 | **La app sale con reputación completa**, no con el v1 mínimo del §9: reseñas multidimensionales, credibilidad, ranking, insignias, colecciones y retos entran en la misma migración 200. |
| 2026-08-03 | **Beta cerrada por allowlist en la BASE** (`diner_app_access`), no sólo en el front. Sembrada con `mancuellorenato@gmail.com` y `mancuelloempresas@gmail.com`. |
| 2026-08-03 | **La ruta es `/clientes`** (con `/comer` y `/restaurantes` como alias). Cierra la §11.3. |
| 2026-08-03 | **El QR y el delivery NO comparten sesión con `/clientes`** — el Camino A viaja por token de dispositivo. Motivo verificado en el §13.2. |
| 2026-08-03 | Sin cédula para comensales. Antifraude por pedido pagado. |
| 2026-08-03 | Sin contraseña: Google + correo, canales simétricos. |
| 2026-08-03 | Los puntos son **XP, no moneda**. No se canjean. |
| 2026-08-03 | Reglas de XP y niveles **editables desde el superadmin**, no cableadas. |
| 2026-08-03 | **OTP por teléfono postergado** (sin presupuesto). v1 vincula por pedido con sesión iniciada y por código en el mostrador. |
| 2026-08-03 | El XP viene de la **contribución**, no del monto gastado. Fórmula en definición (§11.2). |
| 2026-08-03 | **Una persona = un usuario de Auth**, alineado con la regla de la mig 166. El perfil de comensal convive con un rol de negocio en la misma cuenta; el contexto se elige al entrar. Se descartó `auth_profile_registry` (§8.1). |
| 2026-08-03 | **Dos roles de negocio a la vez** (admin + proveedor) queda para después: exige que `get_my_role()` sea sensible a la sesión, y esa zona no se toca con la deuda de RLS abierta. |
| 2026-08-03 | **El teléfono sí es común** a los tres perfiles: es la llave de reconocimiento en el mostrador. Ninguna consulta puede usarlo para correlacionar perfiles (§8.1.2). |

---

## 13. Lo que se construyó (2026-08-03)

Esta sección se agregó **después** de implementar. Donde contradice a las
secciones de arriba, gana esta: las de arriba son el diseño, ésta es lo que
existe.

### 13.1 Entregables

| # | Entregable | Archivo | Estado |
|---|---|---|---|
| 1 | Diseño aprobado | este documento | ✅ |
| 2 | Migración **200** | `supabase/migrations/20260803_200_diner_identity_xp_reviews.sql` | ✅ escrita · ⏳ **sin aplicar** |
| 3 | Rewrites + dominio real | `vercel.json`, `robots.txt`, `sitemap.xml`, legales | ✅ deployable ya |
| 4 | **Superadmin › Comensales** | `src/superadmin/main.jsx` | ✅ 9 pestañas |
| 5 | Panel `/clientes` | `src/clientes/{main,theme,api}.jsx`, `public/clientes.html` | ✅ |
| 6 | ~~Bloqueo cruzado de altas~~ | — | descartado (§8.1) |
| 7 | **Guarda en `delete-restaurant.js`** | `api/delete-restaurant.js` | ✅ **bloqueante, hecho** |
| 8 | Vinculación por mostrador | `src/caja/main.jsx` → `VincularApp` | ✅ |
| 9 | Pantallas | ver 13.3 | ✅ |
| + | Vista del local | `src/admin/main.jsx` → Clientes › **App Mythos** | ✅ |
| + | Selector de contexto | `public/login.html` | ✅ |

**23 tablas nuevas** y ninguna columna nueva en tablas existentes. El único
punto de contacto con lo vivo es un `AFTER`-hook por RPC explícita: `create_order`
**no se reescribió** (ver 13.2).

### 13.2 Los tres desvíos, con su motivo

**(a) `xp_ledger` lleva `diner_id` Y `customer_id`** — el §4.4 pedía sólo
`customer_id`. Reseñar, subir una foto o responder el registro son actos de la
*persona* y pueden ocurrir sin ficha local; con sólo `customer_id` ese XP no
tendría dónde anotarse. Lo que el §4.4 buscaba —que vincular una ficha absorba
el historial viejo con un solo `INSERT` en el puente— se conserva intacto,
porque el total suma las filas propias **más** las de las fichas vinculadas.

**(b) El QR y el delivery NO comparten `storageKey` con `/clientes`** — el §5.2
lo proponía. **Verificado en el código:** la policy `mi_auth_select` de
`menu_items` (mig 086) exige `restaurant_id = get_my_restaurant_id()`, y un
comensal **no tiene fila en `user_roles`** → esa función devuelve `NULL` → **el
menú saldría vacío**. Compartir la sesión rompería el pedido, que es lo único
que no se puede romper.

En su lugar, el Camino A viaja por `diner_link_tokens` (`kind='device'`): la app
guarda un token en `localStorage.mythos_diner_token`, el panel del QR sigue
corriendo como `anon` y, **después** de crear el pedido, llama a
`diner_claim_my_order(token, order_id)`.

> También se descartó `set_config()` + trigger: PostgREST reusa conexiones de un
> pool, así que con `is_local=false` el token de una persona se le aplicaría al
> pedido de **otra**, y con `is_local=true` no sobrevive a la transacción. No hay
> variante segura de esa idea.

**(c) Ninguna policy de `UPDATE` sobre `diner_reviews`.** La RLS filtra **filas,
no columnas**: una policy "el local edita las reseñas de su restaurante" le
habilitaría `stars` y `status` —ponerse 5 estrellas solo—, y una "el autor edita
la suya" le habilitaría `status` y `weight` —aprobarse una reseña en moderación
y subirse el peso de su propia crítica—. Publicar, responder y moderar pasan por
RPC: `diner_submit_review`, `restaurant_reply_review`, `superadmin_moderate`.

### 13.3 El panel

Shell de teléfono (390×844), blanco/negro estilo iOS, **idéntico al del QR**
(`src/index/main.jsx`) salvo la navegación: barra inferior al alcance del pulgar
en vez del sidebar de los paneles de staff (§9).

Pantallas: acceso sin contraseña → registro de gustos (wizard de 4 pasos, las
preguntas salen de la base) → **Explorar** (identidad + nivel, servicio, buscador,
filtros, favoritos, novedades) → **restaurante** (nota ponderada, promedio por
aspecto, reseñas con votos) → **Pedidos** (cruzados entre locales, repetir,
calificar) → **calificar** (nota general + N aspectos + comentario + fotos) →
**Ranking** (país/ciudad × histórico/mes) → **Perfil** (XP, credibilidad,
estadísticas, insignias, colecciones, retos, código de mostrador).

**El panel NO reimplementa el flujo de pedido.** Menú, carrito, extras,
mitad-y-mitad, cupones, métodos de pago, comprobantes y facturación viven en
`index.html` y `delivery-cliente.html` (~5.600 líneas entre los dos). Una segunda
copia se desincronizaría al primer cambio de precios y terminaría cobrando
distinto que la caja. `/clientes` descubre, manda al panel que ya sabe pedir, y
recibe el pedido de vuelta.

### 13.4 Todo se controla desde el superadmin

**Superadmin › Comensales**, 9 pestañas: Resumen · Comensales (+ ajuste manual de
XP) · **Experiencia** (`xp_rules` + `xp_levels`) · Insignias · Colecciones ·
Retos · **Reseñas** (moderación de reseñas y fotos + catálogo de aspectos) ·
**Registro** (preguntas + analítica server-side) · **Acceso** (portero de la
beta, allowlist, módulos, reglas de reseña y pesos de credibilidad).

Nada de eso está cableado en el código: cuánto XP da cada cosa, cómo se llaman
los niveles, qué insignias existen, qué se califica y qué pregunta el registro
son **datos**. Cambiarlos no pide migración ni deploy.

La analítica del registro sale de `diner_profile_analytics()`, no de los arrays
del panel — mismo criterio que `form_analytics` (mig 198) y `crm_customer_stats`
(mig 197): agrupar en el navegador da un número que empeora cuanto más crece el
negocio.

### 13.5 Antes de aplicar la 200

1. **Backup** de la base.
2. Correr la migración entera (rol `postgres`, SQL Editor en **inglés**).
3. Correr la **§16 de la migración** (verificación): 23 tablas, `anon` sin un
   solo grant, todas las funciones con `search_path` fijo, tablas vacías y los
   dos correos en la allowlist.
4. **Verificar el *identity linking* del proyecto** (§8.1.1). Con "Confirm email"
   apagado para el alta de dueños, alguien podría registrarse en `/registro` con
   el correo de otro y quedarse en la misma cuenta cuando la víctima entre a
   `/clientes` con Google. No es un problema de este diseño, pero **se activa
   recién cuando `/clientes` existe**.
5. Para **abrir la beta**: prender `is_public` en Superadmin › Comensales ›
   Acceso **y** sacar `/clientes` del `Disallow` de `robots.txt` + agregarlo al
   `sitemap.xml`. El panel lo avisa al prender el interruptor.

### 13.6 Lo que sigue abierto

- **La 200 no está aplicada.** Hasta que lo esté, `/clientes` muestra "falta un
  paso en el servidor" y ningún otro panel cambia de comportamiento.
- **`get_my_company_restaurant_ids()` sigue con `LIMIT 1` sin `ORDER BY`** (mig
  092): el selector de local del login sigue siendo cosmético para la RLS. No se
  toca mientras siga abierta la deuda de RLS (prioridad 1 de CLAUDE.md).
- **La mig 166 sigue sin confirmarse en prod.** Sin ella nadie puede tener el
  mismo rol en dos locales.
- **OTP por teléfono**: postergado por presupuesto. El modelo ya lo contempla.
- **Gift cards del comensal** desde `/clientes`: el motor está (mig 197), falta
  la pantalla.
- **Realtime** en el seguimiento del pedido: hoy refresca al volver a la
  pestaña.
