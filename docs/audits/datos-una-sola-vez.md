# Un dato se pide UNA sola vez — repaso general del sistema

> **Instrucción de Renato (2026-08-04):** si el administrador (o el comensal, o el
> proveedor, o quien sea) ya cargó su teléfono, cédula/RUC, redes, domicilio,
> dirección del local, foto de perfil o de portada — ese dato **tiene que aparecer
> ya prellenado** en cualquier módulo, panel o formulario nuevo que vuelva a
> necesitarlo. Y las tablas que guardan lo mismo bajo otro nombre tienen que poder
> leerse entre ellas.

Este documento es el **repaso completo** que pidió esa instrucción: dónde se
repite el mismo dato hoy, con archivo y línea, ordenado por gravedad. Al final
está el plan de arreglo y la regla que queda vigente para todo lo que se
construya de acá en adelante.

**Fecha del repaso:** 2026-08-04 · última migración escrita: 202.

---

## Resumen

| | Qué es | Cuántos |
|---|---|---|
| **A** | El mismo dato guardado en **dos lugares distintos de la base** (se desincronizan) | 4 |
| **B** | El mismo dato **pedido dos veces a la misma persona** (fricción pura) | 6 |
| **C** | Datos que se capturan una vez y **después no se pueden editar en ningún panel** | 4 |
| **D** | Lo que ya está bien resuelto — **modelo a copiar**, no tocar | 6 |

La conclusión práctica: el problema **no** es que falten tablas. Es que hay
**cuatro identidades** en Mythos (el local, la persona/staff, el cliente/comensal,
el proveedor) y solo una de ellas —el cliente— tiene un módulo compartido que
manda (`src/shared/clientes.js`). Las otras tres las resuelve cada panel por su
cuenta, y ahí es donde nacen las copias.

---

## A · El mismo dato en dos lugares de la base

Esto es lo más grave: no es molestia, es **datos contradictorios**. Cuando hay dos
copias, ninguna pantalla sabe cuál es la verdadera.

### A1 · Hay DOS Facebook del local

- `restaurants.facebook` — columna real (mig 118). La escribe el onboarding
  ([onboarding.html:433](public/onboarding.html#L433), [:661](public/onboarding.html#L661))
  y la **lee la vitrina pública de `/clientes`** (mig 202, `diner_place_public`,
  líneas 122 y 207) y [clientes/main.jsx:1489](src/clientes/main.jsx#L1489).
- `restaurant_settings.settings_json.receipt.social.facebook` — copia paralela.
  Es la única que edita el diseñador de comprobante
  ([admin/main.jsx:5942](src/admin/main.jsx#L5942)) y la única que imprime el
  ticket ([admin:5924](src/admin/main.jsx#L5924), [admin:6016](src/admin/main.jsx#L6016),
  [caja/main.jsx:5988](src/caja/main.jsx#L5988)).

**Qué se rompe hoy:** el dueño carga su Facebook en el onboarding → en Admin ›
Comprobante el campo Facebook aparece **vacío** → lo vuelve a escribir → ahora el
ticket lo muestra pero la ficha del local en `/clientes` sigue mostrando el
primero. Si después cambia de página de Facebook, tiene que acordarse de
cambiarlo en dos lados.

**Nótese el contraste:** Instagram en esa misma pantalla **sí** sale de
`restaurants.instagram` ([admin:5904](src/admin/main.jsx#L5904)). Facebook es la
excepción, y es la excepción equivocada.

### A2 · Hay DOS fichas de cliente por teléfono

- `customers` (mig 196) — `restaurant_id` + `phone_digits` (índice único), con
  `first_name`, `last_name`, `phone`, `doc_*`, `email`, `address`, `notes`, tipos.
- `frequent_customers` (mig 184) — `restaurant_id` + `phone` (UNIQUE), con `name`
  y `note`. Sirve para decidir si un cliente de delivery puede pagar en efectivo.

Misma clave de identidad (local + teléfono), mismo contenido reducido. La 184 es
**anterior** a la 196, así que no es un error de diseño — es una tabla que quedó
huérfana cuando llegó el CRM de verdad. Hoy el mostrador puede tener a Juan
cargado en `customers` y **no** en `frequent_customers`, y el delivery lo trata
como desconocido.

**Lo correcto:** "frecuente" es un **atributo** del cliente, no otra ficha. Ya
existe el mecanismo — `customer_types` (catálogo por local, mig 196). Un tipo
sembrado "Frecuente" hace exactamente lo mismo y se ve en Admin › Clientes.

### A3 · La identidad del rider está en dos tablas

- `user_roles` — `display_name`, `username`, `email`, `cedula`, `recovery_email`,
  `phone`, `is_active`.
- `delivery_riders` — `name`, `phone`, `cedula` (mig 123), `photo_url`, `active`.

[api/create-user.js:382-387](api/create-user.js#L382-L387) escribe los dos en el
mismo request, así que **nacen sincronizados**. El problema es después: editar el
nombre o el teléfono desde Personal toca uno, editarlo desde Delivery toca el
otro ([admin:3715-3716](src/admin/main.jsx#L3715-L3716) los distingue con un `if`).

### A4 · El registro del dueño no alimenta al onboarding

- `leads_prospectos` (mig 117 + 198) guarda `nombre`, `whatsapp`, `email`,
  `tipo_negocio` desde `/registro` ([registro.html:152-161](public/registro.html#L152-L161)).
- `restaurants` guarda `owner_name`, `whatsapp`, `owner_email`, `business_type`
  desde `/onboarding`.

Son los **mismos cuatro datos** de la misma persona, con nombres distintos, en
tablas distintas. Y [api/onboarding.js:176](api/onboarding.js#L176) **ya busca el
lead por email** — pero solo para marcarle `estado='onboarding'`. Tiene el registro
en la mano y no lo usa para prellenar nada.

---

## B · El mismo dato pedido dos veces a la misma persona

### B1 · Registro → onboarding: cuatro campos repetidos

| Se pidió en `/registro` | Se vuelve a pedir en `/onboarding` |
|---|---|
| Nombre y apellido ([registro:152](public/registro.html#L152)) | "Nombre del dueño" ([onboarding:429](public/onboarding.html#L429), validado en [:654](public/onboarding.html#L654)) |
| WhatsApp ([registro:161](public/registro.html#L161)) | "WhatsApp del local" ([onboarding:411](public/onboarding.html#L411)) |
| Email ([registro:157](public/registro.html#L157)) | "Email del dueño" ([onboarding:433](public/onboarding.html#L433)) |
| Tipo de negocio ([registro:131-142](public/registro.html#L131-L142)) | "¿Qué tipo de negocio es?" ([onboarding:370](public/onboarding.html#L370)) |

Peor: el nombre **ya está en Auth**. `/registro` hace
`signUp(..., { data: { full_name: nombre } })` ([registro:396](public/registro.html#L396)),
o sea `auth.users.raw_user_meta_data.full_name` lo tiene. Y el email es
literalmente el de la sesión activa. Los dos se pueden prellenar sin tocar la base.

Este es el peor momento posible para la fricción: es el **primer** contacto de un
cliente nuevo con el producto.

### B2 · Admin › Mi cuenta pide el nombre dos veces en la misma pantalla

En [admin/main.jsx:14075-14110](src/admin/main.jsx#L14075-L14110), una sola página
muestra:

- **"Mi perfil"** → Nombre, Teléfono (van a `user_roles` vía `update_my_profile`).
- **"Dueño y encargado del local"** → Nombre, Teléfono, Email, Documento del dueño
  (van a `restaurants.owner_*`).

Para el dueño de un local unipersonal —que es el caso normal en Paraguay— son la
**misma persona**, y las dos tarjetas arrancan vacías e independientes. Nadie le
dice que puede copiar de arriba.

### B3 · Dar de alta un rider se hace en dos formularios distintos

- Personal › Nuevo empleado: [admin:3769](src/admin/main.jsx#L3769) →
  cédula, correo, contraseña, nombre, rol, teléfono.
- Delivery › Nuevo rider: [admin:10695-10710](src/admin/main.jsx#L10695-L10710) →
  cédula, correo de recuperación, contraseña, nombre, teléfono.

Mismos campos, misma validación de cédula duplicada
([admin:10695](src/admin/main.jsx#L10695) vs [admin:3706](src/admin/main.jsx#L3706)),
mismo endpoint. Dos pantallas para mantener y dos lugares donde se puede olvidar
un campo.

### B4 · En el QR, "Mis datos" no llena los datos de la factura

[index/main.jsx:1300](src/index/main.jsx#L1300) guarda "Mis datos" en
`localStorage.mythos_mis_datos` — nombre, apellido, teléfono, tipo y número de
documento, email, dirección. Bien pensado: clave **global**, así que el habitué lo
carga una vez y le sirve en cualquier local.

Pero el bloque de factura ([index:1621](src/index/main.jsx#L1621)) tiene su propio
estado `name` / `ruc` / `email` que **arranca vacío**
([index:1290-1292](src/index/main.jsx#L1290-L1292)). El comensal que ya cargó sus
datos y pide factura tipea nombre, RUC y correo **otra vez**. El merge de
[index:1411-1417](src/index/main.jsx#L1411-L1417) sí prefiere los datos del CRM —
pero para entonces la persona ya los volvió a escribir.

### B5 · En Caja, elegir la ficha del cliente no llena la factura

El **mozo** lo hace bien: al elegir una ficha,
[mozo/main.jsx:3317-3318](src/mozo/main.jsx#L3317-L3318) copia el nombre y el
documento a los campos de factura.

**Caja** no. El `ClientePicker` de [caja:3354](src/caja/main.jsx#L3354) llena
`customerName` ([caja:3191](src/caja/main.jsx#L3191)) pero `invName`/`invRuc`
siguen en blanco ([caja:2813-2814](src/caja/main.jsx#L2813-L2814)). El cajero
—que es quien más apurado está— tipea lo que ya está en pantalla.

### B6 · Delivery guarda los datos del comensal por restaurante; el QR, globalmente

- QR: `localStorage.mythos_mis_datos` — **global**
  ([index:1300](src/index/main.jsx#L1300)). ✅
- Delivery: `lsk('dc_customer')` = `<restaurant_id>:dc_customer` — **por local**
  ([delivery-cliente/main.jsx:48](src/delivery-cliente/main.jsx#L48),
  [:2866](src/delivery-cliente/main.jsx#L2866)). ❌

Consecuencias: el mismo comensal escribe nombre, teléfono y **dirección de
entrega** de cero en cada local nuevo al que pide, y nada de lo que cargó por QR
le sirve para el delivery del mismo local ni al revés.

---

## C · Datos que se capturan y después nadie puede editar

Estos cuatro se piden en el onboarding, se guardan, se **usan en pantallas
visibles al público** — y no hay ningún formulario en ningún panel para
corregirlos. Un error de tipeo queda para siempre salvo que entre el superadmin.

| Dato | Dónde se carga | Quién lo usa | Editor |
|---|---|---|---|
| `restaurants.whatsapp` | onboarding, **obligatorio** ([:411](public/onboarding.html#L411)) | ficha del local en `/clientes` (mig 202:116) | **ninguno** |
| `restaurants.facebook` | onboarding ([:433](public/onboarding.html#L433)) | ficha del local en `/clientes` (mig 202:122) | solo el fork del comprobante (ver A1) |
| `restaurants.ruc` / `legal_name` | onboarding ([:459-460](public/onboarding.html#L459-L460)) | encabezado del ticket ([caja:5976](src/caja/main.jsx#L5976)) | solo superadmin ([superadmin:2318](src/superadmin/main.jsx#L2318)); en Admin son de **solo lectura** ([admin:5924](src/admin/main.jsx#L5924)) |
| `business_type` y el perfil de operación de la mig 120 | onboarding pasos 1/4/5 | `business_type` agrupa las "experiencias" de la portada de `/clientes` (mig 201) | **ninguno** |

El editor de Admin › Info del local guarda exactamente
`name, address, phone, instagram, website, logo_initials, cover_image_url, logo_url`
([admin:9845](src/admin/main.jsx#L9845), campos en [:9912](src/admin/main.jsx#L9912)).
No incluye whatsapp, facebook, ciudad, RUC ni razón social. El del superadmin
guarda `name, legal_name, ruc, city, country, address, phone, email, owner_*`
([superadmin:2023](src/superadmin/main.jsx#L2023)) — no incluye whatsapp,
instagram, facebook ni website. **Entre los dos no cubren la ficha completa**, y
ninguno de los dos avisa qué falta.

---

## D · Lo que ya está bien — el modelo a copiar

No tocar. Estos son los patrones que hay que replicar en el resto.

1. **`src/shared/clientes.js` + `ClienteUI.jsx`** — fuente única del CRM: ningún
   panel arma sus propias queries de cliente, la identidad es el teléfono
   normalizado, y el formulario/picker es el mismo en Admin, Caja, Mozo, QR y
   Delivery. **Éste es exactamente el patrón que le falta a las otras tres
   identidades.**
2. **`api/approve-supplier.js:244-298`** — al aprobar una postulación copia
   nombre comercial, razón social, RUC, ciudad, departamento, días de entrega,
   pedido mínimo, teléfono, WhatsApp, email y contacto desde
   `marketplace_applications` al perfil y a `marketplace_supplier_contacts`. El
   proveedor **no vuelve a cargar nada**.
3. **`marketplace_leads`** (mig 142) — guarda `restaurant_id` y `supplier_id`, no
   una copia del nombre/teléfono del comprador. El proveedor resuelve los datos
   del restaurante por la relación. Referenciar en vez de copiar: así se hace.
4. **`diner_customer_links`** (mig 200) — vincula la identidad global del comensal
   con su ficha local en vez de duplicar la persona por restaurante.
5. **La cédula del dueño sirve además como login**
   ([onboarding.html:670-680](public/onboarding.html#L670-L680)) — un solo campo,
   dos usos, sin pedirlo de nuevo.
6. **`marketing_config.whatsapp`** (mig 148) — "única fuente del botón de WhatsApp
   en todo el sitio", literal en el hint de
   [superadmin:7691](src/superadmin/main.jsx#L7691). El criterio ya está escrito y
   aplicado para la plataforma; falta aplicarlo a los locales.

---

## Plan de arreglo

Ordenado por relación valor/riesgo. **Nada de esto está hecho todavía.**

### Etapa 1 — solo frontend, sin migración, sin riesgo

| # | Arreglo | Archivos |
|---|---|---|
| 1 | Prellenar el onboarding con lo que ya dio el registro: nombre desde `user_metadata.full_name`, email desde la sesión, WhatsApp y tipo de negocio desde `leads_prospectos` (el lookup ya existe en `api/onboarding.js:176`) | `public/onboarding.html`, `api/onboarding.js` |
| 2 | En Admin › Info del local, agregar los campos que faltan: WhatsApp, Facebook, ciudad, RUC, razón social (resuelve C1–C3 sin tocar la base — las columnas ya existen) | `src/admin/main.jsx` |
| 3 | Caja: al elegir ficha, llenar también `invName`/`invRuc` — copiar el patrón del mozo | `src/caja/main.jsx` |
| 4 | QR: sembrar los campos de factura desde "Mis datos" | `src/index/main.jsx` |
| 5 | Delivery cliente: pasar `dc_customer` a la clave **global** `mythos_mis_datos`, compartida con el QR (migrar lo que ya esté guardado por local) | `src/delivery-cliente/main.jsx`, `src/index/main.jsx` |
| 6 | Admin › Mi cuenta: botón "usar mis datos" en la tarjeta del dueño, o directamente sembrarla desde el perfil cuando esté vacía | `src/admin/main.jsx` |

### Etapa 2 — módulo compartido (el arreglo estructural)

Crear **`src/shared/local.js`** — la fuente única de la identidad del local, con
el mismo criterio que `clientes.js`: qué columnas forman la ficha, cómo se leen,
cómo se guardan, y un `<LocalForm>` reusable. Todo panel que muestre o edite
datos del local pasa por ahí. Es lo que evita que el próximo módulo vuelva a
inventar un campo.

En el mismo movimiento: unificar el Facebook (A1) leyendo `restaurants.facebook`
en el comprobante, con fallback al valor viejo de `settings_json` mientras haya
locales con la copia cargada.

### Etapa 3 — requiere migración y aprobación explícita de Renato

| # | Arreglo | Cómo |
|---|---|---|
| 7 | Unificar `frequent_customers` en `customers` (A2) | migración nueva: tipo sembrado "Frecuente" + backfill de las filas existentes + reescribir `is_frequent_customer` para que mire `customers`. La tabla vieja se **deja quieta** hasta confirmar el backfill |
| 8 | Que la ficha del rider sea una vista de `user_roles` + lo específico del rider (vehículo, comisión) (A3) | migración + unificar los dos formularios de alta (B3) |
| 9 | Editor del perfil de operación de la mig 120 (C4) | pantalla nueva en Admin, sin migración; se agrupa acá porque conviene hacerlo junto con el resto |

---

## La regla que queda vigente

Copiada a `CLAUDE.md` para que aplique a todo lo que se construya de acá en
adelante:

1. Antes de agregar un campo a un formulario nuevo, **buscar si ese dato ya
   existe** en alguna tabla. Si existe → leerlo y prellenar. Nunca crear una
   columna nueva para algo que ya está guardado.
2. Si de verdad hace falta una tabla nueva, que **referencie** la ficha existente
   (`restaurant_id`, `customer_id`, `diner_id`, `user_id`) en vez de copiar
   nombre, teléfono o dirección.
3. El acceso a cada identidad va por un **módulo compartido único** en
   `src/shared/`. Ningún panel arma sus propias queries de identidad.
4. **Todo dato que se captura tiene que poder editarse** desde algún panel. Un
   campo write-once es un bug, no una decisión.
