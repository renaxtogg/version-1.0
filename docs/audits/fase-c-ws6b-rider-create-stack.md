# FASE C / WS6-B1 — Admin crear RIDER: `Maximum call stack size exceeded`

> **Objetivo:** diagnosticar y corregir, **solo si es frontend/app-logic**, el error
> `Maximum call stack size exceeded` al crear un **rider** desde Admin → Personal → Nuevo empleado.
> Crear **mozo** funciona. Si el bug depende de `/api/create-user`, Auth Admin API, service_role,
> RLS o migraciones → **documentar y detener** (no corregir aquí).
> **Rama:** `fix/fase-c-ws6b-rider-create-stack` (base `main` @ `2b367f2`).
> **Reglas:** sin tocar Auth real / DB·RLS·RPC·migraciones / Maps / Bancard / facturación.

---

## 0. CORRECCIÓN — hallazgo DESCARTADO (QA runtime, 2026-06-19)

> 🟢 **ESTADO FINAL: crear rider = PASS. NO es un bug del producto. NO requiere fix.**
> El error `Maximum call stack size exceeded` queda **descartado como artefacto de la
> instrumentación de QA** (wrapper/doble-wrapper de `fetch`), no del app.

Las §1–§9 de abajo son el **diagnóstico inicial** (histórico) y siguen siendo válidas en su
conclusión clave: el **path frontend de creación de rider no contiene recursión**. Lo que faltaba era
la evidencia runtime, que ahora confirma que tampoco había bug en el backend: el error nacía en la
capa de instrumentación del QA.

### 0.1 Diagnóstico inicial (resumen)

WS6-B1 (estático, sin entorno vivo) concluyó que el path de Personal para rider está **limpio**
(mismo `addEmployee` que mozo salvo el string `role`; `riderToProfile`/`loadProfiles`/render/realtime
sin recursión) y, como no había recursión en el app, atribuyó el `RangeError` como **probable** origen
server-side, ruteándolo a WS6-B/Auth. **Esa hipótesis de "server-side" queda corregida** por la
evidencia runtime: no era ni frontend ni backend del app.

### 0.2 Nueva evidencia (QA runtime pasivo, preview `ba647ee`)

- **Crear rider FUNCIONA.** Se creó la fila nueva: **"juanperes"**, `Rider · delivery`, **Activo**.
- El **contador de activos pasó de 11 → 12**.
- **Consola: 0 errores.** **No** hubo **toast** rojo ni **overlay** de React.
- En la captura pasiva **no se observó** que se disparara `/api/create-user` (el QA reportó que el flujo
  siguió otra vía); en todo caso, **no hubo error visible** en consola/red.
- El `Maximum call stack size exceeded` de la corrida anterior fue **provocado por la propia
  instrumentación de QA**: un **wrapper (y probable doble-wrapper) de `window.fetch`** que, al llamarse a
  sí mismo, recursaba infinitamente → `RangeError`. El stack overflow vivía en la **capa de observación
  del QA**, no en MYTHOS.

> Esto **valida** el análisis estático de WS6-B1: la razón por la que no se encontró ninguna recursión en
> el código del app es que **no la había** — la recursión estaba en el harness de QA.

### 0.3 Conclusión corregida

- ✅ **Crear rider = PASS.** No hay fix requerido (ni frontend ni backend).
- ✅ El `Maximum call stack size exceeded` se **descarta** como bug del producto: **artefacto de QA**.
- ✅ WS6-B1 cierra **sin cambios de código de producto** (sigue siendo un PR de solo documentación).

### 0.4 Lección de QA (método)

- Para auditar **consola/red**, usar **captura pasiva** (p. ej. `PerformanceObserver` / Resource Timing,
  o el panel Network de DevTools), **no** envolver `window.fetch`.
- **No envolver `fetch`** salvo que sea estrictamente necesario; si se hace, **garantizar un único
  wrapper** que delegue al `fetch` **nativo original** (capturado una sola vez), nunca al ya-envuelto,
  para evitar recursión/doble-wrapper.
- Ante un `Maximum call stack size exceeded` durante QA instrumentado, **sospechar primero del harness**
  (wrapper de `fetch`/`console`) antes de atribuirlo al producto.

### 0.5 Pendientes reales que SÍ quedan (no son este caso)

| Tema | Ruta |
|---|---|
| Auto-assign rider bloqueado por RLS (PATCH `delivery_orders`) | **WS6-B / security** |
| `superadmin.demo@mythos.test` login → `Database error querying schema` | **WS6-B / Auth / seed** |
| Admin → Personal → columna **USUARIO** con bajo contraste en **dark** | **Visual / dark** |

### 0.6 Datos de QA a limpiar más adelante (no en esta rama)

Creados durante el QA contra el sim (no Terrapizza, no la cuenta oficial) — limpiar con el teardown
guardado, no con DELETEs ad-hoc:

- usuario **`qa.ws6a3.mozo`** (creado al probar crear-mozo).
- rider **`juanperes`** (creado al probar crear-rider).

---

## 1. Resultado (TL;DR)

> ⚠️ **Histórico — diagnóstico inicial.** La conclusión vigente está en §0 (crear rider = PASS, error
> descartado como artefacto de QA). Se conserva lo de abajo por trazabilidad.

- **No se encontró ninguna recursión en el path frontend de creación de rider** (`src/admin/main.jsx`).
  El flujo de Personal es **idéntico** para mozo y rider salvo el valor `role` que se envía y los
  textos de placeholder/label. Todo lo rider-específico del frontend es benigno.
- Como **crear mozo funciona** en el mismo entorno, `/api/create-user` está **configurado y operativo**
  ahí (se descarta la hipótesis "env vars ausentes en Preview" de WS6-A3 para este caso).
- La **única divergencia rider-específica que alcanza otro código** es el **branch de `/api/create-user`**
  que inserta en `delivery_riders` (paso que mozo no ejecuta).
- ⇒ **No se corrige en WS6-B1.** El origen más probable es **server-side** (la función serverless
  `/api/create-user`, que usa **service_role + Supabase Auth Admin API**) → **pendiente WS6-B / Auth / security**.
- **PR de diagnóstico: 0 cambios de producto** (solo este documento).

---

## 2. Repro reportado

`Admin → Personal → "Nuevo empleado" → Rol: Rider → "Crear rider"` → `Maximum call stack size exceeded`.
Con `Rol: Mozo` el mismo formulario crea el empleado sin error.

---

## 3. Qué se auditó en el frontend (todo limpio)

El botón **"Crear rider"** llama a `addEmployee` (`src/admin/main.jsx:2712`), el **mismo** handler que
"Crear empleado" (mozo). Revisado paso a paso:

| Elemento | Línea | ¿Recursa / loop? | Nota |
|---|---|---|---|
| `addEmployee` (handler) | 2513 | **No** | Idéntico para mozo/rider salvo el string `role` en el body. Valida nombre/usuario/password(≥8), `POST /api/create-user` con Bearer, maneja error real. |
| Body del POST | 2531 | **No** | Solo primitivos (`{username,password,display_name,role,restaurant_id,email,phone}`). No circular → `JSON.stringify` no desborda. |
| `riderToProfile` | 2419 | **No** | Devuelve un objeto plano; sin auto-referencia. |
| `loadProfiles` | 2428 | **No** | Lee `delivery_riders` + `user_roles`/RPC, `setProfiles([...])` una vez. Sin recursión. |
| Render de la grilla | 2632-2654 | **No** | Fila de rider == fila de mozo + sufijo `· delivery`. Mismos componentes. |
| `roleLabel` | 80 | **No** | Lookup en `ROLE_LABEL`. |
| `fmtDate` | 59 | **No** | `toLocaleDateString`. |
| `_shouldPause` | 36 | **No** | Lee `document.activeElement`. |
| Realtime `delivery_riders` | 2482 | **No** | `()=>loadProfiles()` (ignora payload). Un reload por evento; sin escritura → sin cascada. |
| Efectos sobre `profiles` | — | **No existen** | Ningún `useEffect`/`useMemo` depende de `profiles` (descarta loop de set-state). |
| Montaje de secciones | 7789 / 9526 | **No** | Secciones condicionales (`case`); `DelivRiders` **no** está montado durante Personal → sin doble-realtime. |

**Conclusión frontend:** el path de Personal para rider **no contiene recursión ni loop de estado**.
No hay un fix de frontend que aplicar.

---

## 4. Backend verificado (read-only, para acotar el origen)

- **`api/create-user.js`** (serverless): para `role==='rider'`, además de `auth.users` + `user_roles`,
  hace un `httpsPost` extra a `delivery_riders` (`:184-208`) con rollback total ante fallo. Los helpers
  `httpsPost/httpsGet/httpsDelete` y el handler son **lineales, sin recursión**.
- **Esquema `delivery_riders`:** `commission_type` admite `('pct','fixed','salary')` (migs 051/052) →
  el default `'pct'` del backend es **válido** (no es violación de constraint). **Sin triggers** sobre
  `delivery_riders` (solo índices + policy). ⇒ El INSERT debería tener éxito; un fallo de constraint
  daría un mensaje distinto, no `Maximum call stack size exceeded`.
- **RLS:** una recursión de policy en Postgres se reporta como `infinite recursion detected in policy
  for relation …`, **no** como `Maximum call stack size exceeded` (que es un `RangeError` de V8/JS).

---

## 5. Diagnóstico

`Maximum call stack size exceeded` es un **`RangeError` de JS (V8)** — nace en JS, no en SQL. Dado que:

1. el path **cliente** de Personal está limpio y es idéntico a mozo (que funciona), y
2. la única diferencia rider que ejecuta código nuevo es el **insert a `delivery_riders` dentro de
   `/api/create-user`** (Node serverless),

el origen **más probable es server-side**: la función `/api/create-user` lanza el `RangeError` en su
rama de rider, lo captura (`catch(e)` `:212`) y responde `500 {"error":"Maximum call stack size exceeded"}`;
el cliente hace `throw new Error(result.error)` → `toast(e.message)`. Es decir, el texto se vería como un
**toast rojo**, no como un crash de React.

> **Pregunta que desambigua (para el QA, 1 paso):** ¿el error aparece como **toast rojo** o como
> **error en consola / overlay de React**?
> - **Toast rojo** → vino del servidor (`/api/create-user` devolvió 500 con ese mensaje) → **backend**.
> - **Console/React crash sin toast** → recursión en cliente (no hallada en el path de Personal; habría
>   que capturar el **stack trace** y mirar el frame superior para localizar el archivo/función).
>
> En ambos casos conviene capturar en DevTools el **stack trace completo** (frames superiores) y, si es
> toast, el **status + body** de la respuesta de `/api/create-user` en la pestaña **Network**.

---

## 6. Resolución: pendiente WS6-B / Auth / security (NO corregido aquí)

El bug **depende de `/api/create-user`** (rama de rider), que usa **service_role + Supabase Auth Admin
API** y la inserción en `delivery_riders`. Eso cae explícitamente en lo **excluido** de WS6-B1
("No tocar Auth real / DB·RLS·RPC"). Por las reglas de la tarea, se **documenta y se detiene**:

- **Pendiente WS6-B/Auth/security:** revisar la rama `role==='rider'` de `api/create-user.js` (y su
  cadena de requests a PostgREST/Auth) con el **stack trace real** del entorno donde se reproduce. Un PR
  separado de backend (fuera de FASE C frontend) podrá corregir la causa una vez localizada con el trace.
- **Si el QA confirma que es un toast con texto del servidor**, el fix vive 100% en el serverless / capa
  Supabase, no en `src/admin/main.jsx`.

---

## 7. Riesgos

- **Ninguno por esta rama:** PR de **diagnóstico**, sin cambios de código de producto (solo este `.md`).
  No se tocó Auth, DB, RLS, RPC, migraciones, payloads, rutas ni permisos.

---

## 8. Checklist de QA (cuando se retome en WS6-B/Auth)

1. Reproducir Admin → Personal → Nuevo empleado → Rider → Crear rider.
2. Anotar **dónde** aparece el error: **toast rojo** vs **consola/React overlay**.
3. Si es toast: en **Network**, capturar `POST /api/create-user` → **status** y **response body**
   (debería ser `{"error":"Maximum call stack size exceeded"}` si es server-origin). **No** pegar
   contraseñas en el reporte.
4. Capturar el **stack trace** completo de consola (frames superiores) para localizar el archivo/función.
5. Confirmar que crear **mozo/cajero/cocina** en el mismo entorno sí funciona (aísla el rider-branch).
6. Con esa evidencia, abrir el PR de backend correspondiente (WS6-B/Auth/security).

---

## 9. Build

- `npm run build` → **PASS** (9/9, exit 0). Sin cambios de `src/` (PR de diagnóstico).
