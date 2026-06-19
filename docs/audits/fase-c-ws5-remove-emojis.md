# FASE C / WS5 — Purga de emojis del producto

> **Objetivo:** quitar los emojis coloridos visibles del producto y reemplazarlos por
> íconos vectoriales / símbolos sobrios consistentes con el diseño Mythos (premium,
> iOS-like). Solo cambios visuales/frontend/textuales. Sin lógica, datos, Auth, RLS,
> DB, rutas ni payloads.
> **Rama:** `fix/fase-c-ws5-remove-emojis` (base `main` @ `b966cf3`).
> **Alcance:** barrido completo de los **9 paneles** (decisión del owner: el inventario
> reveló emojis coloridos en todos, no solo en los 3 detectados originalmente).

---

## 1. Inventario (antes)

El prompt detectó emojis solo en QR/cliente (⚠️📲📍), Rider (🛵📦📋) y Mozo (🗺📋) +
glyphs de acción (✎↻⊞▦⛶). **El inventario real mostró emojis coloridos en los 9 paneles**,
con caja/admin/gerente como los más cargados (🧾🪑🥡🛒💳👤📞🎂💑🏖🎉⚽🎊📢🟢🟡🔴💬🛵💵🖨…).

Infra de reemplazo existente (no se introdujo librería nueva): **`public/mythos-icons.js`**
(`window.MythosIcons`, set Lucide-style con `currentColor`, cargado por los 9 HTML).
Paneles con helper `Icon` propio: admin/gerente/superadmin (→MythosIcons), index/delivery-cliente
(set SVG local). Se **agregó** un helper `Icon` mínimo a los que no lo tenían
(mozo, caja, delivery-rider, cocina) y se ampliaron los sets locales de index/delivery-cliente
(`alert/mail/print/building/link/store/calendarX`).

---

## 2. Criterio aplicado

| Caso | Acción |
|---|---|
| Emoji colorido pictográfico (🛵📦📍📞🧾💳…) | → **SVG `MythosIcons`/Icon local** (hereda color/tamaño, monocromo, premium) |
| Emoji en `<option>` / CSV / string de notificación / `Modal title` (no admite JSX) | → **texto** (se quita el glyph; el label/color ya comunica) |
| Dots de estado/afluencia 🔴🟡🟢 / 🟢-abierto | → **`●` (U+25CF)** geométrico monocromo que hereda el color CSS del span |
| Labels de motivo/ocasión (🎂💑💼🥂), banderas (🇵🇾), fiesta (🎉) | → **texto** (se quita el emoji decorativo) |
| Glyphs clunky `↻ ⊞ ▦ ⛶` (acción/vista) | → **SVG** `refresh/layout/dashboard/maximize` |
| Símbolos monocromos sobrios `✓ ✕ ★ ☆ ✎ ✦ ♦ ⚠ ● ◷ ○ □ ▭ ▣ ▦ ₲ ≡ ◷` | **ACEPTADOS** (se conservan): render estable, no coloridos, lenguaje consistente |

Nota sobre `⚠`: se conserva como **marcador monocromo compacto** (badges/tablas/celdas);
se **retiró** solo donde era glyph redundante antepuesto a texto de advertencia (el color ya
lo comunica). Nota sobre `▣/▦/₲`: glyphs geométricos del selector de método de pago de mozo
(no hay equivalente SVG de QR) — se conservan como conjunto monocromo consistente.

---

## 3. Archivos tocados (9 paneles + 0 HTML de estilo)

Todos `src/<panel>/main.jsx`. `public/mythos-icons.js` **no** se modificó (ya tenía el set).

| Panel | Resumen del barrido |
|---|---|
| **index (QR cliente)** | Flujo pago/comprobante/rating/reserva/gates: 📲→card, ⚠️→alert, 🖨/✉️→texto, 🏦→building, 🎉→texto, OCCASIONS/ZONES→texto (tiles solo-label), ⛔→alert, 📅→calendar, 🔗→link, 🏪→store. + helper `Icon` ampliado (alert/mail/print/building/link/store) y soporte `style`. |
| **delivery-cliente** | OCCASIONS→texto, 📍→location, ⚠️→alert, 📲→card, 🖨/✉️→texto, 🏦→building, 🎉→star, 🔗→link, 🏪→store, ZONE.emoji muerto eliminado. |
| **delivery-rider** | VEHICLE 🛵🚲🚗🚶→bike/truck/user, 📦→package, 📋→clipboard, 📍→pin, 📞→phone, 🗺️→pin, ✅→checkCircle, ↻→refresh. + helper `Icon`. |
| **mozo** | ⊞→layout, 🗺→pin, 📲→creditCard, 🎁→tag, 📋→book, 🏦→building; 📞/⚠ en diálogos in-app→texto. `▣▦₲` (selector pago) conservados. + helper `Icon`. |
| **caja** | ~50 sitios: 🖨🧾🛒💳📲👤📞📍🛵💰💵📝🃏🧮🇵🇾🔒🔓❌⏱⏳→Icon; 🪑🥡 (tipos)/OCCASION/⚠ redundantes→texto; ↻→refresh, ▦→dashboard. + helper `Icon`. |
| **gerente** | 💬→chat, 🔴 afluencia→`●`; CAL_TYPES/CAL_CROWD emoji→`●`; ⚠ redundante→texto. |
| **admin** | TYPE_TABS/CANAL_ICON→nombres MythosIcons (Icon en divs, texto en option/CSV), alert icons (🔴🟡📦💸)→alert/package/money, CAL maps→`●`, 🍽→utensils, 🖼→upload, 🔍→search, 🗺️/🗺/📍→pin, 📅→calendar, 🌅🌙→sun/moon, 🏆⭐👑→texto, 🇵🇾→fileText, formas mesa ⬜⭕→□○, etc. |
| **superadmin** | FEATURE_GROUPS ⚙️💳🍽️→settings/creditCard/utensils, 🏢→building, ➕→plus, SA_CAL maps→`●`, ⚠ redundante→texto. |
| **cocina** | ⚠ ALERGIA→alert, 📞→phone, 🛵→bike, 💵→money, ⛳ fallback→'', ⛶→maximize, ⚠ (HTML string)→MythosIcons.html('alert'). + helper `Icon`. |

---

## 4. Exclusiones explícitas (NO tocadas — y por qué)

1. **Selector de íconos de estación de cocina (`STATION_ICONS`, `STATION_TYPES`) en admin**
   (🍳🔥🍸☕🍰… + paleta de 16): es **emoji-como-dato**. El usuario elige un emoji que se
   **persiste en `kitchen_stations.icon` (payload/DB)** y se muestra en KDS. Reemplazarlo =
   cambiar el picker/flujo/payload → **fuera del alcance WS5** ("sin cambiar flujos/payloads").
   Requiere rediseño de feature (picker de íconos vectoriales) en un PR aparte.
2. **Plantillas de mensajes de WhatsApp en admin** (`MSG_TEMPLATES`: 👋🍽😊🎂): es **contenido
   de mensaje saliente** al cliente (copy de marketing), no chrome de UI. Quitar los emojis
   cambiaría el contenido del mensaje → decisión de producto/contenido, no de UI.
3. **Símbolos monocromos aceptados** (`✓ ✕ ★ ☆ ✎ ✦ ♦ ⚠ ● ◷ ○ □ ▭ ▣ ▦ ₲`): se conservan por
   diseño (sobrios, render estable, no coloridos).

---

## 5. Validación

- **Build:** `npm run build` → **PASS** (9/9, exit 0). `public/build/` gitignored (Vercel compila de `src/`).
- **Escaneo de emoji pictográfico colorido (plano alto 1F300+):** **0** en los 9 paneles salvo
  las 2 exclusiones documentadas en admin (STATION + WhatsApp).
- Sin cambios de lógica, handlers, queries, payloads, RLS, rutas ni navegación.
  Light/dark intactos (los SVG usan `currentColor` → adoptan el color del contexto).

---

## 6. Checklist de QA visual (para Claude Web)

Verificar que NO hay emojis coloridos y que los íconos se ven sobrios/legibles (light **y** dark
donde aplique):

1. **QR cliente (index):** menú, carrito, **pago** (método "Pagar desde el celular", aviso QR,
   comprobante Impreso/Email), **toast Bancard** (ícono edificio), tracking ("¡Buen provecho!"
   sin 🎉), **rating** (sin 🎉), **reserva** (ocasiones y zonas solo-texto), pantallas
   "Mesa llena" / "reserva" / gates (Escaneá QR / Restaurante no disponible) con íconos vectoriales.
2. **Delivery cliente:** welcome, zonas (pin), ocasiones, pago (card), comprobante, toast Bancard,
   gracias-rating (estrella), gates (link/store).
3. **Rider:** header (ícono vehículo), ruta activa (bike), pedidos (phone/pin), botones llamar/mapa,
   "sin pedidos" (package), historial (clipboard), "ruta completada" (checkCircle), refresh.
4. **Mozo:** toggle Cuadrícula/Mapa (layout/pin), botón QR (tarjeta), promociones (tag), "todo el
   menú" (book), toast Bancard (edificio). Leyenda "Ocupada" intacta (WS4).
5. **Caja:** lista de cobros (cliente/tel/dirección/rider/⏱ con íconos), modal de cobro
   (QR Bancard/Tarjeta, factura SIFEN, imprimir), reservas (tel/hora/personas/motivo), salón
   (QR mostrador/Actualizar), facturas (receipt), SET Paraguay (fileText), calculadora flotante.
6. **Gerente:** soporte vacío (chat), calendario (bullets `●` por tipo/afluencia).
7. **Admin:** alertas dashboard (íconos por nivel), filtros de canal (utensils/bike/package),
   tabla de pedidos (canal), CRM (bike/whatsapp), calendario (`●`), reservas (calendar/phone),
   mapa (search/pin/alert), Top consumidores (sin 🏆⭐👑). **Estaciones siguen con emoji
   (excluido).**
8. **Superadmin:** features (settings/creditCard/utensils), sucursal hija (building/plus),
   calendario (`●`).
9. **Cocina (KDS):** badge ALERGIA (alert), info delivery (phone/bike/money), pantalla completa
   (maximize), error de estación (alert).
10. **Transversal:** sin emojis coloridos visibles (salvo estaciones de cocina y plantillas
    WhatsApp, documentadas); sin regresión de layout/legibilidad en light/dark.
