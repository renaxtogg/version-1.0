# MYTHOS — Module / Panel Creation Contract

## 1. Propósito

Este documento define el contrato obligatorio para crear nuevos módulos o paneles en MYTHOS EAS.

Ningún módulo nuevo debe agregarse como pantalla aislada. Todo módulo debe integrarse a:

* planes/capabilities;
* guards de rol;
* tenant isolation;
* UI/UX light/dark;
* consola/red limpia;
* QA real en preview;
* documentación de auditoría;
* proceso de PR chico con build y merge solo con PASS.

Este contrato evita que futuros paneles nazcan con lógica duplicada, UI inconsistente, permisos incompletos o errores silenciosos.

---

## 2. Principio central

Todo panel nuevo debe responder estas preguntas antes de implementarse:

1. ¿Qué plan lo incluye?
2. ¿Qué capability lo habilita?
3. ¿Qué roles pueden entrar?
4. ¿Qué restaurante/tenant puede ver esos datos?
5. ¿Qué pasa si el restaurante no tiene el módulo?
6. ¿Qué pasa si el usuario no tiene rol suficiente?
7. ¿Cómo se ve en light y dark?
8. ¿Qué queries usa y bajo qué RLS?
9. ¿Qué errores pueden aparecer en consola/red?
10. ¿Cómo se valida en QA real?

Si una respuesta no está clara, el módulo no debe construirse todavía.

---

## 3. Registro de planes y capabilities

Todo módulo debe registrarse en la matriz de planes/capabilities.

Patrón actual validado:
`restaurant_panel_enabled(rid, panel)`

Regla:

* Si el panel no está registrado en capabilities/gating, no se considera terminado.
* Si un restaurante pierde la capability, el panel debe bloquearse automáticamente.
* Si un restaurante gana la capability, el panel debe habilitarse sin hardcode manual.
* No usar excepciones por restaurante salvo demo/QA documentado.
* No usar checks dispersos sin pasar por el patrón central.

Ejemplo conceptual:

* Starter puede tener QR, Caja, Cocina, Mozo.
* Pro puede sumar Delivery cliente.
* Enterprise puede sumar Gerente, Rider, Delivery completo.

Cada nuevo panel debe definir:

* `panel_key`
* planes que lo incluyen
* capability asociada
* texto de bloqueo/upsell
* ruta/página afectada
* roles permitidos

---

## 4. Gating obligatorio

Todo panel nuevo debe tener gating antes de cargar datos sensibles.

El gating debe cubrir:

* restaurante válido;
* plan/capability habilitada;
* rol permitido;
* sesión válida;
* tenant correcto.

Si el panel está bloqueado:

* mostrar estado sobrio;
* explicar que el módulo no está disponible;
* no cargar queries innecesarias;
* no filtrar datos sensibles;
* no generar spam de red/consola.

Prohibido:

* cargar datos y ocultarlos después;
* depender solo de UI disabled;
* dejar rutas internas accesibles sin guard;
* hardcodear IDs de restaurante;
* resolver permisos solo en frontend si el dato requiere backend/RLS.

---

## 5. Roles y permisos

Cada panel debe declarar roles permitidos.

Ejemplo de patrón:

* Mozo: `mozo`, `admin`, `supervisor_local`, `superadmin`
* Caja: `cajero`, `admin`, `supervisor_local`, `superadmin`
* Cocina: `cocina`, `admin`, `supervisor_local`, `superadmin`
* Gerente: `gerente`, `admin`, `supervisor_local`, `superadmin`
* Rider: `rider`, `admin`, `supervisor_local`, `superadmin`

Regla:

* Si el rol no está permitido, bloquear antes de cargar datos.
* Si un rol se agrega, debe actualizarse la matriz y la auditoría.
* No crear roles nuevos sin spec.
* No usar strings diferentes para el mismo rol.
* No mezclar `gerente` con `supervisor_local` sin justificación.

---

## 6. Tenant isolation

Todo módulo debe respetar aislamiento por restaurante.

Reglas:

* Toda query debe estar filtrada por `restaurant_id` o equivalente.
* Nunca confiar en datos del cliente para cruzar tenant.
* No permitir que un admin de un restaurante vea datos de otro.
* Superadmin es la única excepción, y debe estar documentada.
* Si se usa RPC, debe validar tenant internamente.
* Si se usa RLS, la policy debe estar documentada y testeada.

Checklist tenant:

* [ ] Usuario de restaurante A no ve datos de B.
* [ ] Usuario sin rol no ve datos.
* [ ] Superadmin ve solo lo que corresponde.
* [ ] Anon no accede a datos privados.
* [ ] Demo no rompe tenants reales.

---

## 7. UI/UX obligatorio

Todo nuevo panel debe seguir el estándar visual actual de MYTHOS:

* sobrio;
* premium;
* iOS-like;
* consistente con QR/menu;
* light/dark correcto;
* sin emojis pictográficos/coloridos;
* íconos SVG o símbolos tipográficos monocromos;
* tokens de color y texto;
* sin hardcode `#000` / `#fff` salvo caso justificado;
* contraste legible;
* estados vacíos claros;
* errores visibles sin ruido.

Reglas:

* No introducir estilos propios si ya existe token/clase reutilizable.
* No crear un nuevo sistema visual paralelo.
* No usar emojis para navegación, acciones, estados o títulos.
* No usar colores directos que rompan dark mode.
* No duplicar componentes si existe patrón equivalente.

Checklist visual:

* [ ] Light OK.
* [ ] Dark OK.
* [ ] Mobile/tablet si aplica.
* [ ] Empty state.
* [ ] Loading state.
* [ ] Error state.
* [ ] Disabled/blocked state.
* [ ] Sin emojis.
* [ ] Sin contraste bajo.
* [ ] Sin layout roto.

---

## 8. Backend / datos

Antes de hacer queries, el módulo debe verificar el esquema real.

Reglas:

* No asumir columnas.
* Revisar migraciones/schema antes de escribir selects.
* No pedir columnas inexistentes.
* No usar nombres inventados como `table_number`, `confirmed_at`, `name`, `price` si no existen en esa tabla.
* Usar aliases PostgREST si el frontend necesita shape estable.
* No cambiar DB sin aprobación explícita.
* No crear migraciones dentro de un workstream frontend.

Checklist query:

* [ ] Cada columna existe.
* [ ] Cada relación existe.
* [ ] El select fue validado contra schema/migraciones.
* [ ] El happy-path devuelve 200.
* [ ] Los errores reales se manejan.
* [ ] No hay fallo silencioso.
* [ ] No hay loops/retries infinitos.
* [ ] No hay requests redundantes.

---

## 9. Consola y red

Todo módulo debe pasar QA de consola/red.

Reglas:

* 0 `console.log` de desarrollo.
* 0 `debugger`.
* `console.error` solo ante error real.
* `console.warn` solo para best-effort documentado.
* No esconder errores reales.
* No generar spam repetitivo.
* No generar loops de requests.
* No assets 404.
* No CORS.
* No 400/401/403/406 inesperados.

Si hay un error por RLS/backend:

* documentarlo;
* clasificarlo;
* no silenciarlo como “fix”;
* no tocar security sin aprobación.

---

## 10. Estados obligatorios del módulo

Cada módulo debe implementar estados claros:

1. Loading.
2. Empty.
3. Error.
4. Blocked by plan.
5. Blocked by role.
6. Data ready.
7. Offline/fallback si aplica.

Ningún módulo debe quedar en blanco sin explicación.

---

## 11. QA obligatorio

Ningún módulo se mergea sin QA real.

Flujo obligatorio:

1. Claude Code implementa en rama chica.
2. `npm run build` PASS.
3. Push de rama.
4. Preview Vercel Ready.
5. Claude Web/QA valida navegador real.
6. Arquitectura revisa reporte.
7. Merge solo con PASS.

QA mínima:

* panel cargando;
* light/dark;
* roles permitidos;
* roles bloqueados;
* plan habilitado;
* plan bloqueado;
* consola;
* red;
* flujo principal;
* regresión de paneles relacionados.

---

## 12. Documentación por PR

Cada nuevo módulo debe tener auditoría propia en:

`docs/audits/<nombre-del-workstream>.md`

Debe incluir:

* objetivo;
* alcance;
* archivos tocados;
* decisiones;
* capabilities;
* roles;
* queries;
* riesgos;
* exclusiones;
* build;
* checklist QA;
* resultado QA;
* pendientes.

---

## 13. Prohibiciones

Prohibido en PR de módulo nuevo:

* mezclar Auth real sin spec;
* tocar Google Maps sin spec;
* tocar Bancard sin spec;
* tocar facturación electrónica sin spec;
* tocar DB/RLS/RPC/migraciones sin aprobación;
* hacer PR gigante;
* meter UI nueva sin tokens;
* usar emojis;
* crear rutas sin guard;
* hardcodear tenants;
* silenciar errores;
* mergear sin QA real.

---

## 14. Plantilla para nuevo módulo

Antes de construir, completar:

```md
# Nuevo módulo: <nombre>

## Objetivo
...

## Panel key
...

## Planes que lo incluyen
- Starter:
- Pro:
- Enterprise:

## Capability
...

## Roles permitidos
...

## Ruta/página
...

## Datos usados
Tablas/RPC:
...

## Tenant isolation
...

## Gating
...

## UI/UX
...

## Estados
- Loading:
- Empty:
- Error:
- Blocked plan:
- Blocked role:
- Ready:

## Riesgos
...

## QA requerida
...
```

---

## 15. Definition of Done

Un módulo nuevo está terminado solo si:

* [ ] Está registrado en plans/capabilities.
* [ ] Tiene gating por plan.
* [ ] Tiene guard por rol.
* [ ] Respeta tenant isolation.
* [ ] Usa UI light/dark consistente.
* [ ] No usa emojis.
* [ ] No tiene logs dev.
* [ ] No tiene requests fallidos inesperados.
* [ ] Tiene estados loading/empty/error/blocked.
* [ ] Build PASS.
* [ ] Preview Ready.
* [ ] QA real PASS.
* [ ] Auditoría documentada.
* [ ] Merge aprobado por arquitectura.

---

## 16. Nota final

Este contrato es obligatorio para todo módulo futuro de MYTHOS.

Si una implementación necesita romper este contrato, primero debe existir una spec aprobada por arquitectura. No se debe resolver improvisando dentro del PR.

Fin del documento.
