# Seed demo profesional — PROPUESTA (opcional, para DESPUÉS del teardown)

> Borrador no vinculante. NO implementa nada. Pensado para correr **después** de
> un teardown aprobado, si se quiere un entorno demo limpio y reproducible que
> NO contamine métricas reales ni se confunda con producción.

## Objetivo
Un único restaurante demo, claramente etiquetado, con datos mínimos coherentes
para mostrar el producto, **separado** de Terrapizza (real) y de cualquier cliente.

## Principios (alineados con CLAUDE.md)
- Prefijo visible **`[DEMO]`** en el nombre del restaurante (análogo a `[SIM]`).
- Emails `@mythos.test` (dominio ya reconocido como no-real → el teardown lo limpia solo).
- UUID fijo y reconocible para el restaurante demo (distinto de los 3 sim y de Terrapizza).
- **Idempotente:** `INSERT ... ON CONFLICT DO NOTHING`; re-ejecutable sin duplicar.
- Sin secretos en el archivo: contraseñas de demo vía variable de entorno del runner.
- Creación de usuarios vía el endpoint `/api/create-user` (no `service_role` en cliente),
  o vía `auth.admin` desde un script con PAT por env var.

## Alcance mínimo sugerido
- 1 restaurante `[DEMO] Mythos`.
- 1 plan asignado (de catálogo existente; no crear planes nuevos).
- 1 admin + 1 mozo + 1 cajero + 1 cocina + 1 rider (`*.demo@mythos.test`).
- Menú chico (2-3 categorías, ~8 ítems con precios en ₲), 4-6 mesas, 1-2 zonas de delivery.
- Opcional: 2-3 pedidos de ejemplo en estados variados para poblar KDS/caja.

## Guardas para el seed (cuando se implemente)
- Abortar si el UUID demo coincide con Terrapizza o con un sim id.
- Abortar si ya existe data real en ese UUID.
- Marcar todo con el prefijo/dominio demo para que el teardown lo identifique.

## Entregables futuros (no en este PR)
- `scripts/seed/seed-demo.sql` (idempotente) o `scripts/seed/seed-demo.ps1` (con PAT por env).
- Checklist de verificación post-seed.

**Estado:** propuesta. Requiere aprobación explícita antes de construirse.
