# PR-B3I.6 — QA visual final pre-dark

> FASE B (UI/UX unificado + dark mode). Cierre de la serie de polish PR-B3I.1…PR-B3I.5 + PR-B3I.X,
> antes de PR-B4 (dark global). **Entregable: SOLO documentación** (registro del QA visual recibido).
> Fecha: 2026-06-17 · Rama: `docs/pr-b3i-6-final-visual-qa` · Base: `main = 635c9e1`.
> Cero código de producto.

## Origen del QA

- **Ejecutor:** Claude Web/Chrome (rol QA visual/UI-UX).
- **Entorno:** Producción — `https://mythos-pos.vercel.app`, `main = 635c9e1`
  (último commit `PR-B3I.X — document QR menu branding theme boundary`).
- **Sesión:** `qa.superadmin@mythos.test` (el dueño tipeó la clave; QA no maneja credenciales).
- **Viewport principal:** 1424×749 (desktop). Spot-check tablet/narrow ~657px.
- **Método:** auditoría visual/estilo/estados-vacíos en Chrome. **Sin** tocar código, datos, Auth,
  RLS, configuración, ni abrir turnos/pedidos reales.

> **Nota de método (clave para leer el informe):** los paneles staff se auditaron desde la sesión
> Superadmin (quick-links / URL directa), que **no tiene restaurante vinculado** (`RESTAURANT_ID`
> = `…0001`, placeholder, confirmado en `/diag.html`). Por eso las métricas salen en cero y
> aparecen errores de datos que **NO son bugs de producto** sino artefactos de auditoría (§3D). La
> auditoría de **layout/estilo/estados vacíos es válida**; la de **datos reales** requiere las
> cuentas por rol.

## 1) Veredicto general

### ✅ PASS — apto para iniciar PR-B4 (dark global)

El producto en **light mode** se ve parejo, moderno y premium (lenguaje iOS/Apple-like
consistente): cards suaves, radios coherentes (10–20px), sombras sutiles, tipografía `system-ui`
con jerarquía clara, ink `#1d1d1f` sobre `#f5f5f7`, primitivos `.my-card` / `.my-metric-card` /
`.my-btn` aplicados de forma uniforme en los paneles staff. **No hay bugs visuales que bloqueen**
el arranque del dark global. Los hallazgos abiertos son cosméticos o de responsive, ortogonales al
theming. No hace falta un PR-B3I.7 de bloqueo previo.

## 2) Estado por panel

| Panel | Veredicto | Notas |
|---|---|---|
| **QR / menu cliente** | ✅ PASS (referencia) | Mockup teléfono (`.phone` radius 44px, sombra profunda), mood **Blanco** del branding por restaurante. Pills suaves, primario negro, precios 17px/800. Coherente y premium. **Respeta su frontera de branding — excluido del dark staff (correcto, PR-B3I.X).** |
| **Login** | ✅ PASS | Card radius 20px, sombra `0 4px 24px /.08`, botón dark `#1d1d1f` radius 10px, fondo `#f5f5f7`. Apple-like. Consola limpia. |
| **Admin** | ✅ PASS (visual) | Metric cards `.my-metric-card` radius 16px, doble sombra suave, borde `#d2d2d7`. Sidebar agrupado (DELIVERY/GESTIÓN/ANÁLISIS). **No se ve denso** — spacing generoso. Estados vacíos resueltos ("Todo en orden"). |
| **Gerente** | ✅ PASS | "Dashboard del turno": 6 metric cards consistentes, estados vacíos correctos ("No hay pedidos en cocina", "Nadie con turno abierto"). Mismo lenguaje que Admin/Superadmin. |
| **Caja** | ✅ PASS (apertura) | Vista "Apertura de Turno": conteo por denominación, centrado y prolijo, TOTAL en verde. *Vista operativa del salón NO recorrida (requiere abrir turno = acción de estado, no ejecutada).* |
| **Cocina (KDS)** | ✅ PASS | Dark **nativo por diseño** (estándar de pantalla de cocina). Kanban NUEVO/PREPARANDO/LISTO/ENTREGADO con headers de color, pills y cards del mismo set. **Cohesión: sí es el mismo producto** (primitivos compartidos); hoy es la única superficie oscura, se nivela cuando B4 oscurezca el resto. |
| **Mozo** | ✅ PASS | Layout móvil centrado, bottom tab bar (Mesas/Orden/Alertas/Turno) iOS-like, segmented Cuadrícula/Mapa, leyenda de estados con dots de color, estados vacíos correctos. `item-card` **data-gated**. |
| **Delivery rider** | ⚠️ PARCIAL | Estado error/empty ("No pudimos abrir tu panel — cuenta no vinculada a rider") **bien diseñado** (centrado, copy amable, CTA dark). Vista operativa (cards de entrega) **no verificable** vía Superadmin y **data-gated**. Verificar con `rider1.carlos`. |
| **Delivery cliente** | ✅ PASS | Mismo lenguaje que QR (mockup teléfono, pills radius 18px, blanco/negro sobre backdrop `#111`). Opciones Delivery/Paso a buscar/Reservar. Consola limpia. |
| **Superadmin** | ✅ PASS | Dashboard limpio y premium: metric cards, "Salud del sistema" con estados Online en verde, sidebar ordenado. **Chart MRR corregido (§3A).** |
| **Diag** | ✅ PASS (no-op) | Consola dev dark intacta, todo verde (Supabase OK, sesión autenticada, 4 restaurants, build OK). No es superficie de producto. |

## 3) Hallazgos

### A) Positivo — Chart MRR de Superadmin corregido ✅
Confirmado: la barra del chart MRR es un `div` con `background: rgb(29,29,31)` = **`#1d1d1f`** (el ink
de marca, mismo del botón primario/headings), **visible** sobre blanco y **consistente** con el
design system. El follow-up histórico (`#000000`, negro puro/invisible) **quedó resuelto** (PR-B3I.5).
*(Solo Jun. tiene dato; meses previos vacíos = data-gated.)*

### B) Bugs visuales que BLOQUEAN PR-B4
**Ninguno.** Sin pantallas blancas, rutas rotas, overflow horizontal ni quiebres de layout en light.

### C) Bugs / observaciones NO bloqueantes
1. **Responsive de paneles desktop (Admin/Gerente/Superadmin).** Tienen **0–1 media queries**
   (Superadmin: 1 @ `max-width:640px`; Admin: 0). Reflow solo por CSS grid auto-fit. A ~657px el
   **sidebar no colapsa** (queda fijo ~190px) y la grilla de metric cards deja la card derecha
   **parcialmente recortada**. Funcional en tablet, apretado en phone. *No bloquea dark; candidato
   a un PR de responsive aparte.*
2. **Caja — emojis como denominación.** Usa 🟠/🟩 como marcadores de monedas/billetes; menos premium
   que iconografía propia. **Cosmético.**
3. **Caja — vista del salón (follow-up histórico).** Los botones de acción inline (+ Nueva mesa /
   Editar / Cancelar) no se pudieron revisar (requiere abrir turno). **No son `.my-btn`** → **no se
   tematizan solos en B4** — vigilar en dark.

### D) Artefactos de método (NO son bugs de producto)
> Aparecen sólo porque Superadmin no tiene restaurante vinculado. Re-verificar con la cuenta de cada rol.
- **Admin/Gerente:** consola repite `restaurants error | code: PGRST116 | Cannot coerce the result
  to a single JSON object` → la query `.single()` no encuentra restaurante único para la sesión
  superadmin. **Distinto** del follow-up conocido `42501 permission denied` del Admin real (ese
  sigue pendiente de verificar con `admin.carlos`).
- **Cocina:** banner rojo "Error DB: invalid input syntax for type uuid: ''" y "Sin conexión" → por
  `restaurantId` vacío de la sesión. Verificar con `cocina.carlos`.

### E) Superficies NO verificadas (por datos o acción no permitida)
- **Delivery rider** operativo (cards de entrega) — requiere `rider1.carlos`; data-gated.
- **Caja** vista operativa del salón — requiere abrir turno.
- **Mozo** `item-card` con orden activa — data-gated.
- **Charts con datos** (Superadmin MRR multi-mes, Admin ventas/top productos) — data-gated.
- **Reflow real en phone (~390px)** de los paneles desktop — viewport de la herramienta fijo en
  1424px; verificar en dispositivo/responsive devtools.

## 4) Implicación para PR-B4 (dark global)

**Avanzar a PR-B4.** El light mode está suficientemente parejo, premium y vendible.

- **QR/menu cliente EXCLUIDO** del toggle dark del staff: su apariencia la gobierna `mood`
  (negro/blanco/sepia) por restaurante (PR-B3I.X). B4 no debe forzarlo.
- **B4 debe revisar EXPLÍCITAMENTE las superficies que NO se tematizan solas** (no migradas a
  primitivos `.my-*`):
  - **Caja** — vista de salón / botones de acción inline.
  - **Mozo** — `item-card`.
  - **Delivery rider** — cards de entrega.
  - **Cocina** — dark **nativo** (ya oscuro; nivelar con el resto cuando B4 oscurezca).
  - Cobertura base de primitivos: **inputs / modales / tablas / botones / sidebar / cards**.
- **B4 por panel con checklist**, **no** como toggle gigante de una sola pasada.
- **Decisión pendiente** que condiciona el dark: metric card **Opción A (neutra)** vs **B (tinte por
  estado)**.
- **Fuera de B4 (verificación funcional aparte, no visual):** `42501 permission denied` del Admin
  real y comportamiento sin-restaurante (`PGRST116`) — relevante para multi-tenant, no para el dark.

**Mentalidad de negocio (del QA):** el producto ya es demostrable/vendible en desktop/tablet. Si se
mostrará desde el celular a dueños de locales, el responsive de paneles desktop (§3C-1) sube de
prioridad (barato de arreglar, alto impacto en la percepción "premium").

## 5) Evidencia (resumen)

- **Rutas:** `/index.html?r=…&mesa=1` · `/login.html` · `/delivery-cliente.html?r=…` ·
  `/superadmin.html` · `/admin.html` · `/gerente` · `/caja.html` · `/cocina.html` · `/mozo.html`
  (+ Mesas) · `/delivery-rider.html` · `/diag.html`.
- **Computed styles clave:** Login card radius 20px / shadow `0 4px 24px /.08`, botón `#1d1d1f`
  radius 10px; `.my-metric-card` radius 16px / shadow `0 1px 2px /.04, 0 2px 8px /.06` / borde
  `#d2d2d7`; `.phone` radius 44px / shadow `0 40px 80px /.7`; chart MRR barra `#1d1d1f` (no `#000`).
- **Consola:** públicas limpias; Admin/Gerente `PGRST116` y Cocina `uuid ''` = artefactos de sesión;
  sin errores JS de runtime que rompan render.
- **Limitación de tooling:** los mockups de teléfono (menú QR interior, delivery cliente) congelaron
  la captura CDP por animación en loop; auditados por DOM + computed styles + screenshot de portada.
  No es bug de producto.

## Confirmación de no-alcance (este PR documental)

Este PR **solo agrega este documento**. No se tocó: código de producto, build output, datos, Auth,
backend, Supabase, DB/RLS/RPC, migraciones, teardown, permisos, lógica/API/flujos. **PR-B4 NO
iniciado.**
