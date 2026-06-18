# FASE C · WS3 — Regresión: pedido "0 Gs" + persistencia de carrito/pago

> Rama `fix/fase-c-ws3-order-persistence` (base `68e24e6`). Programador: Claude Code. Arquitecto: ChatGPT.
> **Resultado:** el bug histórico **"el pedido se resetea a 0 Gs al recargar (sobre todo en pago)" NO se
> reproduce en código** en ninguno de los dos flujos de cliente. Ambos ya están mitigados. Se aplicó **un fix
> defensivo mínimo** (guard anti-0/carrito-vacío en delivery-cliente, para alinearlo con el cliente QR).
>
> ⚠️ Método: auditoría **estática** (lectura de código) + razonamiento de reload/back-forward/doble-submit.
> **No corrí la app en vivo** (sin creds prod). El PASS/FAIL interactivo lo cierra QA real (checklist §6).

---

## 1. Cliente QR — `src/index/main.jsx`  ·  bug 0 Gs: **NO reproduce**

| Mecanismo | Dónde | Efecto |
|---|---|---|
| Carrito persistido | `app_cart` (L1791) + init reload-safe (L1784) | el carrito sobrevive al reload |
| **Total reload-safe** | `cartTotal = Σ ci.total` (L1871); cada ítem guarda su `.total` | no depende de re-cargar precios del menú → no cae a 0 |
| `payTotal` persistido | `app_pay_total` (L1820) + init reload-safe (L1813); también sub/disc/coupon | en `pay`, el total se restaura del storage |
| **Guard anti-0 en pago** | L1827: `if (screen==='pay' && (payTotal<=0 || !cartItems.length)) setScreen('cart')` | si llega a pago con total 0 o carrito vacío, **rebota a carrito** |
| **Fallback anti-0 al confirmar** | `PayScreen.handleConfirm` L968: `effectiveTotal = total>0 ? total : Σ ci.total`; rechaza `<=0` (L969) | aunque el prop `total` fuese 0, recalcula del carrito; nunca envía 0 |
| `screen` persistido | `app_screen` (L1790) | reload mantiene el paso (menú/carrito/pago/track) |
| **Doble submit** | `step` ('form'→'proc'→'ok'); el botón Confirmar solo existe en `form`; error → vuelve a `form` | un segundo click no dispara otra inserción |

**Conclusión index:** carrito + total + paso persisten; hay doble guard anti-0 (rebote L1827 + fallback L968) y guard de doble-submit por estado. **Sin fix.**

---

## 2. Delivery cliente — `src/delivery-cliente/main.jsx`

| Aspecto | Estado | Detalle |
|---|---|---|
| Doble submit | ✅ OK | `step` ('form'→'proc'); botón Confirmar solo en `form`; error → `form` (L1171–1196). `Pagar` del carrito `disabled` si vacío (L1134). |
| 0 Gs en pago al recargar | ✅ NO reproduce | En reload, `screen` se reinicializa a `dc_order ? 'confirm' : 'welcome'` (L1898). Antes de confirmar **no** hay `dc_order` → vuelve a **welcome** con carrito vacío. **Nunca** muestra una pantalla de pago con total 0. |
| Persistencia de carrito en reload | ⚠️ **P3 (gap UX)** | `cartItems`/`payData` son `useState([])`/`{…,total:0}` **no** restaurados de storage (solo `dc_order/type/zone/customer` tras confirmar). → recargar a mitad de pedido **pierde el carrito** y reinicia en welcome (no es el bug 0 Gs; es "reiniciar pedido"). |
| Guard anti-0 al confirmar | ➕ **FIX WS3** | `handleConfirm` no validaba carrito vacío/total≤0 (a diferencia de index). **Agregado** (ver §3). |

---

## 3. Fix aplicado (mínimo, defensivo)

**Archivo:** `src/delivery-cliente/main.jsx` — `PayScreen.handleConfirm`.
**Cambio:** antes de enviar, rechaza carrito vacío o `total<=0` (mismo criterio que el cliente QR), con mensaje claro y sin pasar a "Enviando…". No cambia montos ni lógica comercial.

```js
// antes:  setStep('proc'); setSubmitError(null); try { ... }
// después:
setSubmitError(null);
if (!cartItems || cartItems.length === 0) { setSubmitError('Tu carrito está vacío. Volvé al menú.'); return; }
if (!(total > 0)) { setSubmitError('El total del pedido es inválido. Volvé al carrito y revisá tu pedido.'); return; }
setStep('proc'); try { ... }
```

**Por qué:** cumple la prioridad #3 de WS3 ("evitar que pago use total 0 si hay items") y **alinea delivery-cliente con index**. Defensivo: el flujo normal ya impide `total=0` (botón de carrito deshabilitado si vacío), así que no bloquea pedidos legítimos.

**NO se implementó** la persistencia de carrito en reload para delivery-cliente (priority #1 para ese panel) porque: (a) el bug 0 Gs **no** se da ahí (reinicia a welcome, no muestra 0); (b) una persistencia correcta debe ser **scoped por `RESTAURANT_ID`** (el panel se abre con `?r=` para distintos restaurantes) para no mezclar carritos entre locales → excede "cambio mínimo" y agregaría riesgo de un bug nuevo. Queda como **mejora opcional recomendada** (§5), a decisión del arquitecto.

---

## 4. Otros flujos de persistencia

- **Atrás/adelante (índice):** `screen` persiste en `app_screen`; los botones internos usan `setScreen`. El historial del navegador no es el driver del paso → atrás/adelante no rompe el total (se mantiene `payTotal`/`cartItems`). needs-live-QA para confirmar UX.
- **Pérdida de red:** ambos `handleConfirm` envuelven el insert en try/catch → error → vuelve a `form` + mensaje; no deja el botón colgado ni duplica. needs-live-QA (simular offline en el paso de envío).
- **Doble pedido:** prevenido por el `step` en ambos. needs-live-QA (doble click rápido en Confirmar).

---

## 5. Hallazgos y severidad

| # | Hallazgo | Severidad | Acción |
|---|---|---|---|
| 1 | Bug "0 Gs al recargar" (index, en pago) | — | **NO reproduce** (mitigado: persistencia + doble guard anti-0 + step). Sin fix. |
| 2 | delivery-cliente `handleConfirm` sin guard anti-0/carrito-vacío | P3 (defensivo) | **FIX aplicado** (§3). |
| 3 | delivery-cliente pierde carrito al recargar (vuelve a welcome) | P3 (UX) | **Documentado.** Mejora opcional: persistencia scoped por `RESTAURANT_ID` (no en WS3). |
| 4 | (index) no scoping de `app_cart` por restaurante | P3 | Bajo riesgo (1 QR = 1 restaurante). Documentado; no se toca. |

---

## 6. Checklist para QA real

Cliente QR `/index.html?r=<Don Carlos/Sakura>&mesa=<n>` (`Mythos2026!` no aplica — es público):
- [ ] Agregar productos → total correcto en barra.
- [ ] **Recargar en carrito** → ítems y total intactos (no 0).
- [ ] Ir a pago → **recargar en pago** → total intacto (no 0); no rebota indebidamente.
- [ ] Atrás/adelante del navegador → no se pierde el carrito ni el total.
- [ ] Doble click en "Confirmar pedido" → **un solo** pedido creado (verificar en cocina/caja).
- [ ] (Opcional) Cortar red al confirmar → mensaje de error, sin pedido colgado; reintento crea 1 pedido.

Delivery cliente `/delivery-cliente.html?r=<Sakura/Pro o Don Carlos/Enterprise>`:
- [ ] Modo → menú → carrito → pago: total correcto en cada paso.
- [ ] **Recargar a mitad de pedido** → **comportamiento esperado actual: vuelve a "welcome" con carrito vacío** (NO muestra pago en 0). Confirmar que es así (no un 0-Gs).
- [ ] Doble click en "Confirmar" → **un solo** delivery_order.
- [ ] Intentar confirmar con carrito vacío/total 0 (si se puede forzar) → **bloqueado** con mensaje (fix §3).

**PASS WS3 =** en ningún flujo el total cae a 0 mostrando pago; no hay pedido duplicado por doble submit; (index) reload preserva carrito/total. La pérdida de carrito en reload de delivery-cliente es **comportamiento documentado (reinicia)**, no un FAIL de 0 Gs.

---

## 7. Entrega
- **Archivos tocados:** `src/delivery-cliente/main.jsx` (guard anti-0 en `handleConfirm`) + este doc. `src/index` **sin cambios** (ya estaba mitigado).
- **Bug 0 Gs reproduce:** **No** (ni en index ni en delivery-cliente).
- **Fix:** 1 defensivo mínimo (delivery-cliente anti-0). El resto = auditoría.
- `npm run build` **PASS** (9/9). **Requiere QA real** (checklist §6). No mergear; no avanzar a WS4.
