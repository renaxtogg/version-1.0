# Mythos — Sprint 2 Resumen de cambios

## Migraciones nuevas (aplicar en Supabase Dashboard en inglés)

| Archivo | Propósito |
|---|---|
| `supabase/migrations/20260527_088_superadmin_rls_bypass.sql` | Bypass RLS total para `get_my_role() = 'superadmin'` en todas las tablas operativas |
| `supabase/migrations/20260527_089_dev_reset_operativo.sql` | Reset de tablas operativas (reemplaza el `supabase db reset` que requería Docker) |

> Para ejecutar ambas: usar el archivo `EJECUTAR_EN_SUPABASE.sql` en la raíz del proyecto.

---

## Backend

- `api/webhooks/bancard-mock.js` — Vercel Function Node 18: simula webhook Bancard con 1.5 s de latencia, devuelve `transaction_id` ficticio compatible con `movimientos_caja.metadata`

---

## Guardia de seguridad

Inyectado en todos los paneles operativos internos. Si no hay `mythos_restaurant_id` en localStorage (y el rol no es `superadmin`), redirige a `login.html` antes de que React arranque.

Paneles afectados: `caja.html`, `mozo.html`, `cocina.html`, `delivery-rider.html`, `admin.html`, `gerente.html`

---

## Feature flags Bancard / SIFEN — "Próximamente"

Comportamiento común: al interactuar con cualquier opción de pago digital, el sistema **no procesa cobro real**. Dispara un toast flotante que dice:
> *"Módulo Bancard / SIFEN en fase de certificación. Esta pasarela se activará automáticamente al concluir los trámites del comercio."*

### caja.html — CobroModal
- Botón **📲 QR Bancard**
- Botón **💳 Tarjeta (VPos Bancard)**
- Toggle **🧾 Factura Electrónica SIFEN** (con aviso en proceso de certificación SET)

### mozo.html — Vista de orden activa
- Botón **📲** "Cobrar Mesa con QR Digital" junto al botón `$` de cobro existente

### index.html — PayScreen (cliente mesa QR)
- Tarjeta **📲 Pagar desde el celular** con badge `PRÓXIMAMENTE` — Tarjeta / QR Bancard

### delivery-cliente.html — PayScreen
- Opción **📲 Pago Online (Tarjeta/QR Bancard)** con badge `PRÓXIMAMENTE`

---

## Google Maps — Fallback por zonas

### delivery-cliente.html — CoverageScreen
- Badge permanente: *"🗺️ Usando cálculo estimado por zonas (Google Maps en modo demostración)"*
- El cálculo ya usa `delivery_zones` de Supabase + haversine como fallback nativo

### admin.html — Panel de zonas de delivery
- Cuando no hay `googleMapsKey` en `config.js`:
  - Aviso usuario: *"🗺️ Usando cálculo estimado por zonas (Google Maps en modo demostración)"*
  - Aviso técnico: instrucciones para activar Maps JS API + Places API en Google Cloud Console

---

## Archivos modificados

| Archivo | Cambios |
|---|---|
| `public/caja.html` | Guardia seguridad + botones Bancard/SIFEN en CobroModal |
| `public/mozo.html` | Guardia seguridad + botón QR digital en vista de orden |
| `public/cocina.html` | Guardia seguridad |
| `public/delivery-rider.html` | Guardia seguridad |
| `public/admin.html` | Guardia seguridad + fallback Google Maps |
| `public/gerente.html` | Guardia seguridad |
| `public/index.html` | Opción Bancard en PayScreen cliente mesa |
| `public/delivery-cliente.html` | Opción Bancard + fallback Google Maps en CoverageScreen |

## Archivos creados

| Archivo | Descripción |
|---|---|
| `supabase/migrations/20260527_088_superadmin_rls_bypass.sql` | Migración RLS superadmin |
| `supabase/migrations/20260527_089_dev_reset_operativo.sql` | Migración reset operativo |
| `api/webhooks/bancard-mock.js` | Endpoint mock Bancard (Vercel) |
| `EJECUTAR_EN_SUPABASE.sql` | Archivo único para copiar/pegar en Supabase |
| `SPRINT2_RESUMEN.md` | Este archivo |
