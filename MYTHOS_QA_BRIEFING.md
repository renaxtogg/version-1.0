# Mythos — Briefing de QA para Claude en Chrome

> Documento de entrega para una prueba funcional + visual completa del sistema, panel por panel,
> rol por rol, restaurante por restaurante. Generado por Claude Code el 2026-06-15.
> **Copiá/pegá este documento a Claude en Chrome como contexto inicial.**

---

## 0. Lo primero — alcance honesto y reglas de seguridad (LEER ANTES DE TOCAR NADA)

**Esto es PRODUCCIÓN. No hay entorno de staging.** Todo lo que crees/edites/borres persiste en la base real
de producción (Supabase `ocwzupmamfojvdywavqi`). Por eso:

### 🔴 Reglas innegociables
1. **SOLO podés operar sobre los 3 restaurantes de simulacro** (Bella Napoli, Sushi Sakura, Don Carlos —
   IDs `a1a1…`, `b2b2…`, `c3c3…`). Crear pedidos, cobrar, mover mesas, abrir caja, etc. **dentro de estos 3 está OK.**
2. **NUNCA toques "Terrapizza".** Es un restaurante **REAL** cargado a mano. No crear pedidos en él, no editarlo,
   no borrarlo, no abrirlo "para ver qué pasa". Si lo ves en una lista (p. ej. en superadmin), **ignoralo**.
3. **NUNCA ejecutes DELETEs, resets ni acciones masivas/destructivas** desde la consola, la pestaña Network,
   ni la UI. La limpieza del simulacro tiene su propio script controlado (`_simulacion/99_teardown.sql`) que corre
   el dueño, no vos.
4. **No expongas ni pegues `config.js`, la anon key, ni ningún token** en ningún lado público. Las credenciales
   de abajo son cuentas desechables `@mythos.test` — sí podés usarlas.
5. Si encontrás un agujero de seguridad (p. ej. podés leer/editar datos de otro restaurante, o borrar algo
   crítico), **documentalo, NO lo ejecutes a fondo**. Reportá "esto es posible" sin causar daño real.

### Qué SÍ se espera que hagas
Navegar, clickear, llenar formularios, leer el **DOM**, la **consola de errores** y la pestaña **Network**
(peticiones que fallan, 4xx/5xx, payloads), abrir **varias pestañas/sesiones** para simular concurrencia
(mozo manda pedido → cocina lo recibe), y simular **un día normal de trabajo** end-to-end en cada restaurante.

### Límites conocidos (no esperés magia)
- **Concurrencia real entre dispositivos físicos**: se simula con pestañas, no es idéntico a 4 tablets a la vez.
- **Hardware**: impresoras de ticket 80mm, comanderas, KDS físico, lectores QR — no se pueden tocar.
- **Pagos reales con pasarela**: el flujo se prueba, pero no hay cobro real de dinero (Bancard/Tigo no integrados aún).

---

## 1. Entorno y URLs

- **Producción (en vivo, verificada 2026-06-15):** `https://mythos-pos.vercel.app`
- Rutas limpias (sin `.html`): `/login`, `/admin`, `/mozo`, `/caja`, `/cocina`, `/gerente`,
  `/superadmin`, `/delivery-cliente`, `/delivery-rider`, `/diag`. El cliente de mesa es `/index.html`.
- **Login:** `https://mythos-pos.vercel.app/login` — se ingresa con **correo electrónico completo + contraseña**
  (no usuario interno, no PIN). Tras login válido redirige solo al panel del rol.
- **Diagnóstico de conexión:** `https://mythos-pos.vercel.app/diag` (útil si algo no carga).

### ✅ Pre-flight (confirmá antes de arrancar)
1. Abrí `/login` e ingresá con `admin.napoli@mythos.test` / `Mythos2026!`. Si entra → el simulacro sigue vivo.
   Si dice "credenciales incorrectas", avisá al dueño: hay que re-sembrar el simulacro antes de probar.
2. Confirmá que la extensión **Claude en Chrome** está instalada, conectada y con permiso para esta pestaña.

---

## 2. Los 3 restaurantes de prueba (qué tiene cada uno)

| Restaurante | Plan | Mesas | Ítems menú | Delivery | Riders | Para qué sirve probarlo |
|---|---|---|---|---|---|---|
| **Pizzería Bella Napoli** | Starter (₲200.000) | 5 | 5 (Pizzas, Bebidas) | — | — | Plan básico: ¿se limitan paneles/funciones? |
| **Sushi Sakura** | Pro (₲400.000) | 8 | 7 (Rolls, Entradas, Bebidas) | cliente | — | Plan medio: delivery de cliente sin rider |
| **Parrilla Don Carlos** | Enterprise (₲800.000) | 12 | 9 (Carnes, Guarniciones, Bebidas, Postres) | cliente + rider | 2 | Plan full: todo, incluido rider y gerente |

IDs (por si los necesitás para URLs de cliente):
- Bella Napoli = `a1a10000-0000-4000-8000-000000000001`
- Sushi Sakura = `b2b20000-0000-4000-8000-000000000002`
- Don Carlos = `c3c30000-0000-4000-8000-000000000003`

---

## 3. Credenciales — TODOS los roles

**Contraseña única para todas las cuentas: `Mythos2026!`** · Login con el **correo completo** en `/login`.

### Bella Napoli — Starter
| Rol | Correo (usuario) | Nombre | Panel destino |
|---|---|---|---|
| Admin | `admin.napoli@mythos.test` | Lucía Benítez | `/admin` |
| Mozo 1 | `mozo1.napoli@mythos.test` | Pedro Rojas | `/mozo` |
| Mozo 2 | `mozo2.napoli@mythos.test` | Ana Duarte | `/mozo` |
| Cajero | `caja.napoli@mythos.test` | Sofía Vera | `/caja` |
| Cocina | `cocina.napoli@mythos.test` | Marco Ruiz | `/cocina` |

### Sushi Sakura — Pro
| Rol | Correo (usuario) | Nombre | Panel destino |
|---|---|---|---|
| Admin | `admin.sakura@mythos.test` | Kenji Yamada | `/admin` |
| Mozo | `mozo1.sakura@mythos.test` | Hana Lopez | `/mozo` |
| Cajero | `caja.sakura@mythos.test` | Diego Park | `/caja` |
| Cocina | `cocina.sakura@mythos.test` | Yuki Sato | `/cocina` |

### Parrilla Don Carlos — Enterprise
| Rol | Correo (usuario) | Nombre | Panel destino |
|---|---|---|---|
| Admin | `admin.carlos@mythos.test` | Carlos Giménez | `/admin` |
| **Gerente** (`supervisor_local`) | `gerente.carlos@mythos.test` | Raúl Centurión | `/gerente` |
| Mozo | `mozo1.carlos@mythos.test` | José Areco | `/mozo` |
| Cajero | `caja.carlos@mythos.test` | Laura Méndez | `/caja` |
| Cocina | `cocina.carlos@mythos.test` | Tomás Ben | `/cocina` |
| Rider | `rider1.carlos@mythos.test` | Iván Cabrera | `/delivery-rider` |

### Superadmin de plataforma (QA — cuenta desechable)
| Rol | Correo (usuario) | Nombre | Panel destino |
|---|---|---|---|
| Superadmin | `qa.superadmin@mythos.test` | QA Superadmin | `/superadmin` |

> Cuenta creada **solo para esta prueba** (no es la real de Renato). Ve y puede editar **TODOS** los
> restaurantes, **incluido Terrapizza (REAL)**. → **Sobre Terrapizza: SOLO LECTURA.** No editar, no borrar,
> no provisionar nada. Probá superadmin operando únicamente sobre los 3 restaurantes de simulacro.

> **Nota de roles:** "Gerente" en la UI = rol DB `supervisor_local` → va a `/gerente`. No existe rol `gerente` en DB.

### Cliente (sin login — se entra por URL con el restaurante en el parámetro)
El cliente de mesa y de delivery no requieren cuenta. Se identifican por `?r=<restaurant_id>`:

- **Cliente mesa (QR), Napoli mesa 1:**
  `https://mythos-pos.vercel.app/index.html?r=a1a10000-0000-4000-8000-000000000001&mesa=1`
  (también acepta `&t=BN-MESA-1`; tokens de mesa: `BN-MESA-1..5`, `SS-MESA-1..8`, `DC-MESA-1..12`)
- **Cliente mostrador (sin mesa):** mismo link **sin** `&mesa`/`&t` → modo mostrador ("comer en local" / "para llevar").
- **Cliente delivery, Sakura:** `https://mythos-pos.vercel.app/delivery-cliente?r=b2b20000-0000-4000-8000-000000000002`
- **Cliente delivery, Don Carlos:** `https://mythos-pos.vercel.app/delivery-cliente?r=c3c30000-0000-4000-8000-000000000003`

---

## 4. Mapa de paneles y módulos (qué tiene que existir en cada uno)

| Panel | Rol que entra | Módulos / qué probar |
|---|---|---|
| `/index.html` | Cliente mesa | Escaneo→menú→carrito→pago→tracking→rating→factura. Llamar al mozo. Reservar mesa. Idioma (es/en/pt). |
| `/delivery-cliente` | Cliente delivery | Pedido a domicilio, selección de zona, tracking en tiempo real, costo de envío. |
| `/delivery-rider` | Rider | Login correo+contraseña, lista de pedidos, cambio de estado (pending→…→delivered), efectivo. |
| `/cocina` | Cocina (KDS) | Kanban (recibido→cocinando→listo), estaciones (cocina/bar/parrilla), tema oscuro, timers, link compartible. |
| `/mozo` | Mozo | Grilla de mesas, tomar/ver pedido, transferir mesa entre mozos, filtro "Mis/Todas", cobro pendiente, liberar mesa. |
| `/caja` | Cajero | Abrir/cerrar turno, fondo fijo, cobros (efectivo/tarjeta/QR), movimientos, propinas, retiros, facturación, **modo offline (PWA)**. |
| `/gerente` | Gerente (`supervisor_local`) | Proveedores, personal/alertas, solicitudes de incorporación, chat de soporte, campana de avisos, reportes. **(el dueño avisa que es el más flojo — lupa acá).** |
| `/admin` | Admin local | Menú (CRUD ítems/categorías/extras), mesas, personal, stock/inventario, finanzas/gastos, alertas, reportes, cupones. |
| `/superadmin` | Superadmin (Renato) | Restaurantes, planes, suscripciones, horarios, calendario, reportes de plataforma. **(ver §9 — falta cuenta de prueba).** |

---

## 5. Guion "día normal de trabajo" — end-to-end por restaurante

Corré esto con **varias pestañas abiertas a la vez** (una por rol) para ver el tiempo real entre paneles.

### A) Bella Napoli (Starter) — flujo mesa puro
1. **Cliente** abre `index.html?r=a1a1…&mesa=2`, ve el menú, agrega 1 Pizza Margherita + 1 Coca-Cola, confirma, elige "Efectivo".
2. **Cocina** (`cocina.napoli`) debería ver el ticket nuevo aparecer (¿en tiempo real o hay que refrescar?). Avanzá: recibido→cocinando→listo.
3. **Mozo** (`mozo1.napoli`) ve la mesa 2 ocupada y el pedido listo; lo marca entregado.
4. **Caja** (`caja.napoli`) abre turno (fondo fijo), cobra la mesa 2 en efectivo, registra el movimiento.
5. **Mozo/Caja** libera la mesa 2. **Cliente** deja un rating.
6. **Caja** cierra turno y verificá que el total cuadre (apertura + cobros − retiros).

### B) Sushi Sakura (Pro) — mesa + delivery de cliente
- Repetí el flujo mesa con `mozo1.sakura` / `caja.sakura` / `cocina.sakura`.
- **Delivery:** abrí `delivery-cliente?r=b2b2…`, hacé un pedido a domicilio eligiendo zona ("Centro" ₲15.000 / "Zona Norte" ₲20.000), seguí el tracking. Verificá que cocina lo reciba con el badge "Delivery".

### C) Don Carlos (Enterprise) — todo, incluido rider y gerente
- Flujo mesa con `mozo1.carlos` / `caja.carlos` / `cocina.carlos` (estación **parrilla** existe acá).
- **Delivery con rider:** pedido en `delivery-cliente?r=c3c3…` → **rider** (`rider1.carlos`) lo ve, acepta, "Iniciar ruta", "Entregar". Verificá tracking del cliente en paralelo.
- **Gerente** (`gerente.carlos`): recorré TODOS sus módulos con lupa (proveedores, personal, alertas, solicitudes, chat soporte, campana, reportes). Anotá qué está vacío, roto, o "de mentira".
- **Admin** (`admin.carlos`): CRUD de menú, alta de mesa, stock/toma de inventario, finanzas, reportes.

---

## 6. 🎨 Auditoría de consistencia UI/UX (deliverable prioritario)

El dueño quiere que **TODOS los paneles se vean y se sientan idénticos**: mismos colores, tipografía, tamaños de
letra, espaciados e interacciones. Hoy algunos paneles no están alineados. Tu trabajo: **comparar cada panel contra
el design system** y listar cada desvío con captura.

### Design system de referencia (lo correcto)
- **Estética:** minimalista, blanco y negro, estilo Apple. Sin gradientes, sin colores de acento como fondo, sin sombras de color.
- **Fondo app:** `#FFFFFF` (login usa `#F5F5F7`). **Texto primario:** `#1D1D1F`. **Bordes:** `#D2D2D7`.
- **Tipografía:** `system-ui, -apple-system, 'Segoe UI'`. Una sola familia (+ `SF Mono` solo para timers/montos mono).
- **Tamaños:** 11/13/15/17/20/24/28/34px (base 15px). **Pesos:** 400/500/600/700.
- **Espaciado:** grid de 8px (4,8,12,16,20,24,32…). **Radios:** 6/10/14/20px.
- **Botón primario:** negro sólido `#000`, texto blanco, hover = `opacity .84` (NO cambio de color), `:active` scale .98.
- **Semánticos (solo texto/íconos, nunca fondo de área):** error `#FF3B30`, success `#34C759`, warning `#FF9500`, info `#007AFF`.
- **Excepción válida (NO reportar como bug):** badges de **tipo de orden** en cocina/caja usan color de fondo
  (mesa=azul, delivery=naranja, mostrador=verde, llevar=violeta). Es semántico e intencional.

### Checklist por panel (rellenar para cada uno: login, index, delivery-cliente, delivery-rider, cocina, mozo, caja, gerente, admin, superadmin)
- [ ] **Branding:** dice "**Mythos**" en `<title>`, header/sidebar, footer, loaders, errores. **Cualquier "Mesa App" es bug.**
- [ ] **Tipografía:** misma familia y escala que el resto. ¿Hay tamaños/pesos fuera de la escala?
- [ ] **Color:** fondo blanco/gris Apple, sin gradientes ni fondos de color de acento. ¿Sombras con color? (bug)
- [ ] **Botones:** mismo estilo primario/secundario/ghost/danger. ¿Hover por opacidad o cambia de color? ¿Bordes/radios consistentes?
- [ ] **Inputs/labels:** borde fino, focus negro (no azul). Labels en gris secundario.
- [ ] **Modales:** ¿se cierran SOLO con ESC o botón ✕? (clic en overlay NO debe cerrar — es regla, pérdida de datos).
- [ ] **Tema claro/oscuro:** ¿existe el toggle? ¿funciona? ¿persiste? (cocina arranca oscuro; el resto claro).
- [ ] **Íconos:** del set propio (`mythos-icons.js`), no emojis sueltos ni librerías pesadas inconsistentes.
- [ ] **Estados vacíos / cargando / error:** ¿existen y son consistentes en estilo?
- [ ] **Responsive:** revisar a **375px (móvil)** y **1280px (desktop)**. ¿Se rompe algo? ¿Tap targets ≥44px?
- [ ] **Espaciado/alineación:** ¿respeta grid de 8px o hay paddings arbitrarios que lo hacen ver "distinto"?

**Entregá una tabla comparativa:** filas = paneles, columnas = cada ítem del checklist, celdas = ✅/❌ + nota.
Eso es lo que el dueño usará para unificarlos.

---

## 7. Bugs conocidos a VERIFICAR (confirmá si siguen, con evidencia)

Estos ya están documentados; tu job es confirmar estado actual desde el navegador (DOM + consola + Network):

1. **Tracking en tiempo real del cliente de MESA (`index.html`)** — se sospecha parcial: el cliente quizá no ve
   cambios de estado sin refrescar. Delivery sí tiene realtime+polling; mesa, verificá. → Severidad esperada: media.
2. **Paywall por plan no diferencia tiers (H3)** — los 3 planes tendrían las mismas features. **Esperado (bug):**
   Starter (Napoli) NO bloquea módulos premium (CRM, inventario, SIFEN, Bancard). Probá: ¿en Napoli aparecen
   módulos que deberían estar bloqueados/“con candado”? El gating por **panel** (allowed_panels) sí debería funcionar:
   confirmá qué paneles deja entrar Starter vs Enterprise.
3. **CRM `customers` sin tabla** — la UI de clientes existe pero **los datos no persisten**. Probá crear un cliente
   en admin/gerente y recargá: ¿desaparece? → Esperado: sí (bug conocido).
4. **Fuga cross-tenant (solo documentar, NO explotar):** logueado como Napoli, ¿en algún panel/listado/Network
   aparecen datos de Sakura o Don Carlos? Reportá dónde, sin alterar nada.
5. **Mesa pagada sigue "ocupada"** hasta liberación explícita — esto es **por diseño**, no es bug. Confirmá que
   exista el botón/acción de liberar en mozo y caja.

---

## 8. ⭐ Petición extra de Claude Code (lo que YO quiero que mires, además de lo anterior)

1. **Captura sistemática de consola + Network en CADA carga de panel.** Por cada panel que abras, anotá:
   errores JS rojos, warnings, y toda petición Supabase con status 4xx/5xx (con el nombre del endpoint/tabla).
   Esto detecta RLS rotas, columnas faltantes (400 Bad Request) y RPCs caídas que no se ven en la UI.
2. **Coherencia de moneda y formato:** todo en guaraní (₲), miles con separador correcto, **cero decimales**,
   nada de "$" ni centavos. Reportá cualquier ₲0, `NaN`, `undefined`, `null` o fecha mal formateada visible.
3. **Estados límite:** pedido vacío (carrito ₲0 debe bloquear), cobro de ₲0, cerrar turno sin movimientos,
   transferir mesa sin pedido, doble-submit de un formulario (¿crea duplicados?).
4. **Concurrencia con 2 pestañas del mismo rol:** dos mozos del mismo local tomando la misma mesa, o dos cajas
   abriendo turno a la vez. ¿Se pisa el estado? ¿Hay condiciones de carrera visibles?
5. **Persistencia de sesión e inactividad:** los paneles de personal cierran sesión tras ~1h de inactividad y por
   logout. Confirmá que el logout limpia la sesión y que recargar no te saca indebidamente.
6. **PWA / Offline en caja:** con caja abierta, simulá perder internet (DevTools → Network → Offline) e intentá
   imprimir/registrar un cobro. ¿Sigue funcionando el ticket 80mm offline como promete?
7. **Coherencia de navegación:** ¿todos los paneles tienen logout visible? ¿el sidebar/nav se ve igual en todos?
   ¿el rebote al login funciona si entrás a un panel que no te corresponde por rol?
8. **Comparación lado a lado de los 3 planes:** mismo flujo en Napoli/Sakura/Don Carlos — ¿la experiencia base es
   idéntica salvo por las features de plan? Cualquier diferencia no explicada por el plan es un bug de consistencia.
9. **Texto/idioma:** en el cliente probá los 3 idiomas (es/en/pt) y reportá strings sin traducir o cortados.
10. **Una "demo de 10 minutos a prueba de cliente":** decime explícitamente cuál es el camino más corto que
    funciona sin romperse (abrir mesa→pedido→cocina→cobro→cierre) y cuáles módulos, si el cliente los toca, te
    dejan en ridículo. Eso define qué es demostrable HOY.

---

## 9. Lo que falta resolver / decisiones del dueño

1. **Superadmin → RESUELTO:** se creó la cuenta desechable `qa.superadmin@mythos.test` (`Mythos2026!`) para QA.
   Usala para `/superadmin`. **Recordá: solo lectura sobre Terrapizza.** (Se elimina con el teardown del simulacro,
   porque su email es `@mythos.test`.)
2. **Confirmar que el simulacro sigue vivo** (paso pre-flight §1). Si las migraciones recientes de RLS lo afectaron,
   re-sembrar antes de testear.

---

## 10. Formato del informe que se espera de vos

Para cada panel y módulo:
- **Estado:** ✅ funciona / ⚠️ funciona con problemas / ❌ roto / ⛔ no probado.
- **Bugs** clasificados por severidad: 🔴 crítico (rompe el flujo de venta) · 🟠 mayor · 🟡 menor · ⚪ cosmético.
  Cada bug con: pasos para reproducir, qué esperabas, qué pasó, evidencia (consola/Network/captura).
- **Auditoría UI/UX:** la tabla comparativa del §6.
- **% listo para demo** por módulo y **global**, con la lógica: ¿aguanta una demo de 10 min sin romperse?
- **Top 5 cosas a arreglar antes de mostrar a un cliente.**

Tomate el tiempo que necesites. Priorizá el flujo crítico de venta primero (abrir mesa→pedido→cocina→cobro→cierre),
después lo demás. Cuando termines un restaurante, entregá su informe parcial antes de pasar al siguiente.
