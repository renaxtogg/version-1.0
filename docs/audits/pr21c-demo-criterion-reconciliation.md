# PR-21C — Reconciliación del criterio operativo demo/cuentas en `CLAUDE.md`

> **Autor:** Claude Code (programador). **Para:** Renato (fundador) + ChatGPT (arquitecto). **Fecha:** 2026-06-16.

## 1. Estado

- **STATUS: SOLO DOCUMENTACIÓN.** No SQL, no Auth, no DB writes, no teardown/dry-run, no RLS/RPC/migraciones, no runtime/Vite, no borrado de datos/usuarios, no secretos.
- Base: `main` = `origin/main` = **`c5f77ed`** (PR-21B).
- Cambios: solo `CLAUDE.md` (reconciliación) + este documento.

## 2. Por qué

Hasta PR-21B, `CLAUDE.md` declaraba *"Terrapizza es un restaurante REAL — nunca incluirlo en resets/teardowns"*. El **criterio operativo FINAL** confirmado por Renato (2026-06-16) **invalida** esa premisa. Los planes PR-20 / PR-21A / PR-21B ya operaban con el criterio nuevo, dejando a `CLAUDE.md` como única fuente desincronizada. Este PR la reconcilia.

## 3. Criterio operativo FINAL (instrucción explícita de Renato, 2026-06-16)

Clasificación final de cuentas Auth:

| Clasificación | Cuentas | Regla |
|---|---|---|
| **PROTEGER (única protección dura)** | `mancuellorenato@gmail.com` | **Nunca tocar.** Confirmar intacta en cada paso. |
| **CANDIDATAS DEMO/QA** | **Todas las demás**, incluida **Terrapizza** y las sim (`@mythos.test` / `@mythos.internal`) | Demo/QA. Candidatas a rotación/desactivación/edición/eliminación **futura**, con aprobación. |
| **REVIEW_BEFORE_ACTION** | Cualquier cuenta dudosa | Revisar a mano antes de cualquier acción. |

Hechos confirmados:

- **Terrapizza NO es cliente real.** Fue una demo/QA creada a mano por Renato.
- **Ninguna cuenta/restaurante en producción corresponde a un cliente real** hoy.
- **Única cuenta oficial propia de Renato:** `mancuellorenato@gmail.com`.

## 4. Qué habilita el criterio (PLANIFICAR; ejecutar solo con aprobación)

- Para cualquier cuenta ≠ la oficial de Renato: se permite **planificar** rotación, desactivación, edición o eliminación.
- **Preferir primero acciones reversibles:** rotar / desactivar / bloquear.
- **Eliminación definitiva** solo en **fase separada** aprobada como acción concreta (irreversible; último recurso).
- **NO** tocar DB / RLS / RPC / migraciones / runtime salvo spec explícita.
- **NO** ejecutar teardown salvo **backup nuevo + dry-run revisado + aprobación explícita**.

## 5. Qué NO autoriza este cambio

- **NO** es autorización destructiva automática.
- **NO** ejecuta ninguna acción de Auth/DB/datos/teardown.
- **NO** debilita las guardas existentes (`ALLOW_PROD_SIMULATION`, `CONFIRM_SIMULATION_TEARDOWN`, allowlist sim, exclusión de la cuenta oficial).
- El procedimiento operativo manual sigue siendo el de [PR-21B](pr21b-manual-auth-cleanup-plan.md) (Dashboard/Auth, una cuenta por vez, 6 gates de aprobación).

## 6. Cambios exactos en `CLAUDE.md`

1. **Encabezado `> Estado:`** — "Terrapizza (restaurante REAL cargado a mano — no tocar ni borrar)" → "Terrapizza (demo/QA cargada a mano por Renato — **NO es cliente real**)". Se agregó un bloque `> ⚠️ Criterio de cuentas (FINAL 2026-06-16)` con la protección única (`mancuellorenato@gmail.com`), el "no se toca automáticamente" y las condiciones de aprobación/teardown.
2. **Regla** "Terrapizza es un restaurante REAL … nunca incluirlo en resets/teardowns" → regla nueva: Terrapizza es demo/QA, no cliente real; única protección dura = `mancuellorenato@gmail.com`; el resto es demo/QA pero **no se borra/modifica automáticamente**; cualquier limpieza exige spec + aprobación; reversible primero; eliminación definitiva en fase separada; **no es autorización destructiva automática**.

Sin tocar: reglas de simulacro `@mythos.test`, guardas de runner, política de teardown guardado, reset DEV por migración, ni ninguna otra sección.

## 7. Conclusión

`CLAUDE.md` queda alineado con el criterio FINAL. La fuente de verdad operativa para las cuentas es ahora coherente entre el doc del repo y los planes PR-20/21A/21B. **Nada se ejecuta** con este PR.

---

### Anexo — Qué NO se tocó en PR-21C
no SQL · no DB writes · no Auth changes · no teardown · no dry-run · no RLS/RPC/migraciones · no runtime/Vite · no borrado de datos/usuarios · no secretos · nada en producción.
