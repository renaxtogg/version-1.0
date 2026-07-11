# FASE B-dark — CIERRE OFICIAL (PASS)

> Capstone de la serie PR-B4 (dark mode global, FASE B "UI/UX unificado + dark mode global").
> Fecha de cierre: 2026-06-18 · `main = origin/main = 28918cc` (último commit: `PR-B4J - document delivery cliente branding boundary`).
> **Documento de cierre. NO toca producto** (cero código/Auth/backend/Supabase/DB/RLS/RPC/migraciones/datos/permisos/API/flujos).

## Veredicto

**FASE B-dark CERRADA — PASS.** QA visual completa en producción (https://mythos-pos.vercel.app) sobre `28918cc`: rollout de dark mode global **consistente y sólido**, **sin bloqueantes visuales**, **light no se degradó**, preferencia `localStorage['mythos-theme']` **persiste** (incl. navegación entre paneles), y las superficies customer-facing branded (**QR/menu/index** y **Delivery cliente**) **quedan light/branding** correctamente.

Informe QA completo (fuera del repo, en *Mythos EAS*): `Informe_QA_Mythos_FASE-B-dark_2026-06-18.md` (rol QA visual en Chrome, sesión `qa.superadmin@mythos.test`; sin tocar código/DB/Auth).

## Superficies — decisión final

| Superficie | Decisión | QA | PR |
|---|---|---|---|
| Gerente | dark activado | ✅ PASS | PR-B4B |
| Superadmin | dark activado | ✅ PASS | PR-B4C |
| Admin | dark activado | ✅ PASS | PR-B4D |
| Caja | dark activado | ✅ PASS (apertura) | PR-B4E |
| Cocina | dark-pinned por diseño KDS (`init('dark')`) | ✅ PASS | PR-B4F |
| Mozo | dark activado | ✅ PASS | PR-B4G |
| Login | dark activado (sin toggle; sigue preferencia/sistema) | ✅ PASS | PR-B4H |
| Diag | no-op / dev console standalone | ✅ PASS | PR-B4H |
| Delivery rider | dark activado | ✅ PASS (parcial; operativo data-gated) | PR-B4I |
| QR/menu/index cliente | light / branding propio (excluido del dark staff) | ✅ PASS | PR-B3I.X |
| Delivery cliente | light / branding propio (excluido del dark staff) | ✅ PASS | PR-B4J |

**Infraestructura de theme** (`mythos-theme.js`, foundation PR-B1/B4A): `data-theme` en `<html>`, persistencia key `mythos-theme`, `prefers-color-scheme` respetado, anti-FOUC (init inline en `<head>`). API completa `init/get/getPreference/resolve/set/toggle/onChange`. ✅ PASS.

## Hallazgos NO bloqueantes (cosméticos — follow-up opcional)
1. **Login (dark):** footer "Mythos · Sistema gastronómico" con contraste bajo (de-énfasis intencional).
2. **Mozo (dark):** dot "Ocupada" de la leyenda de estados puede tener contraste bajo (no confirmado con mesas reales; revisar junto al floor-plan).

## Residuales data-gated (NO bloquean — re-check con datos reales)
- **Caja:** floor-plan/canvas del salón (requiere abrir turno).
- **Mozo:** floor-plan/canvas con celdas de estado color-coded (requiere mesas configuradas).
- **Admin:** floor-plan de Mesas (0 mesas en la sesión QA).
- **Cocina:** columnas con tickets, timers, tarjeta crítica/blink, despacho por estación (sin pedidos).
- **Delivery rider:** ruta activa/on_way, KitchenBadge, historial (requiere cuenta rider + pedidos).
- **Delivery cliente:** flujo cliente completo (cobertura→menú→carrito→pago→tracking→rating) — solo se verificó portada y frontera de branding.

> Estos son los riesgos residuales que el brief pidió mirar; quedan **abiertos para re-check con datos reales** (restaurante de simulación), **sin bloquear el cierre** porque no se halló defecto.

## Fuera de alcance (NO son bugs de dark — no corregir en este cierre)
- Consola staff: `PGRST116` (Admin/Gerente) e `invalid input syntax for type uuid: ''` (Cocina) = **artefactos de auditar con sesión Superadmin sin restaurante vinculado** (`RESTAURANT_ID` placeholder), NO bugs del dark.
- `42501 permission denied` real del Admin: verificar aparte con cuenta `admin.*` (tema RLS, no dark).

## Confirmación de no-alcance (este cierre)
Documentación/memoria local únicamente. **Sin** cambios de producto: no se tocó código/Auth/backend/Supabase/DB/RLS/RPC/migraciones/datos/teardown/permisos/API/lógica/flujos. No se abrió PR de código. No se modificaron datos reales.

## Recomendación
**FASE B-dark queda CERRADA (PASS).** Follow-ups opcionales (no bloquean): re-check de contraste de floor-plans color-coded de Caja/Mozo en dark con datos, KDS con pedidos y rider operativo en dark, flujo cliente completo de Delivery cliente, y ajustes cosméticos del footer de Login / dot "Ocupada" de Mozo.

**No iniciar una nueva fase sin aprobación de Renato.**
