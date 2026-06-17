# PR-21B — Plan manual de limpieza/rotación Auth sin SQL

> **Autor:** Claude Code (programador). **Para:** Renato (fundador) + ChatGPT (arquitecto). **Fecha:** 2026-06-16.

## 1. Estado

- **STATUS: PLAN ONLY / NO AUTH CHANGES / NO SQL.**
- Base: `main` = `origin/main` = **`091a071`** (PR-21A).
- No se ejecuta nada: ni SQL, ni Auth, ni datos. Solo se agrega este documento.
- Reemplaza el camino SQL de PR-21A (Gate 2 SQL descartado por decisión de Renato) por un **camino manual en Supabase Dashboard/Auth**.

## 2. Decisión de Renato (criterio operativo actualizado, 2026-06-16)

- **No** ejecutar el inventario SQL read-only de PR-21A (no insistir con Gate 2 SQL).
- **Terrapizza es demo/QA manual creada por Renato**, **no** cliente real.
- **Ninguna cuenta/restaurante actual en producción corresponde a un cliente real.**
- **Única cuenta oficial propia de Renato (protegida): `mancuellorenato@gmail.com`.**
- Aunque Terrapizza ya no sea cliente real, se **trata con cuidado operativo** hasta que Renato apruebe una acción concreta.

## 3. Objetivo

- Reducir el riesgo de **cuentas demo/sim compartidas** (logins con contraseña conocida) vivas en producción.
- Usar **Supabase Dashboard / Auth** como fuente y herramienta **manual** (sin SQL).
- **Proteger siempre** la cuenta oficial de Renato.
- Mantener **reversibilidad** (rotar/desactivar antes que borrar).

## 4. No objetivos

- **No** SQL. **No** DB changes. **No** Auth changes en este PR.
- **No** borrar usuarios. **No** borrar datos.
- **No** teardown / dry-run.
- **No** migraciones / RLS / RPC.
- **No** frontend/backend runtime. **No** Vite.

## 5. Clasificación manual propuesta

| Clasificación | Significado | Acción en este PR |
|---|---|---|
| **`PROTECT_RENATO_OFFICIAL`** | `mancuellorenato@gmail.com` — única cuenta oficial de Renato | **Nunca tocar.** Confirmar siempre que queda intacta. |
| **`DEMO_CANDIDATE`** | Toda cuenta que **no** sea la oficial de Renato (incluye Terrapizza y las sim `@mythos.test`/`@mythos.internal`) | Candidata a rotación/desactivación **futura**, con aprobación. |
| **`REVIEW_BEFORE_ACTION`** | Cualquier cuenta dudosa (p.ej. emails ajenos, cuentas que parezcan personales/no-demo) | Revisar a mano antes de cualquier acción. |

> Nota: con el nuevo criterio, **la regla de protección se invierte respecto a PR-20/PR-21A**: ya no se protege "el tenant real Terrapizza", sino **solo** la cuenta oficial `mancuellorenato@gmail.com`. Todo lo demás es demo/sim — pero igualmente **nada se toca sin aprobación**.

## 6. Procedimiento manual futuro en Supabase Auth (sujeto a aprobación)

1. Entrar al **proyecto correcto** `ocwzupmamfojvdywavqi`.
2. Ir a **Authentication → Users**.
3. **Revisar los usuarios uno por uno** (la lista de Auth es la fuente; no hace falta SQL).
4. **Confirmar que `mancuellorenato@gmail.com` queda PROTEGIDO** (marcarlo mentalmente como intocable antes de cualquier otra cosa).
5. Para cada **otra** cuenta, **registrar email / user id de forma privada** (planilla/nota local, **fuera de chats públicos**).
6. **No copiar passwords.** **No** pegar datos sensibles (emails completos, ids) en chats públicos.
7. **No accionar todavía** sin aprobación explícita de Renato (esto es solo relevamiento manual).

## 7. Opciones futuras de acción

- **Opción A — Rotar contraseña** de las cuentas demo (reversible; corta el riesgo de "contraseña conocida"). **Preferida.**
- **Opción B — Desactivar/bloquear** cuentas demo si Supabase Auth lo permite de forma **reversible** (ban temporal / disable). Reversible.
- **Opción C — Mantener** algunas cuentas demo **controladas** para QA (p.ej. 1 admin demo con contraseña nueva conocida solo por Renato).
- **Opción D — Borrar usuarios** solo en una **fase futura separada**, si Renato lo aprueba explícitamente (irreversible; último recurso, idealmente junto al teardown con backup nuevo).

## 8. Recomendación arquitectónica

- **No borrar todavía.**
- **Preferir desactivar/rotar** (A/B) sobre borrar (reversible primero).
- **Mantener una cuenta admin demo controlada** si hace falta para seguir haciendo QA manual (Opción C), con contraseña nueva no compartida.
- **Proteger siempre** la cuenta oficial de Renato (`mancuellorenato@gmail.com`).

## 9. Checklist de aprobación antes de tocar Auth

- [ ] Renato **confirma la lista exacta** de cuentas a tocar.
- [ ] El **arquitecto aprueba** la acción (A/B/C/D) por cuenta.
- [ ] Acción **una cuenta por vez**.
- [ ] **`mancuellorenato@gmail.com` verificado intacto** en cada paso.
- [ ] **QA de login después** (cuenta tocada se comporta como se espera; cuentas no tocadas siguen igual).
- [ ] **Registrar el resultado** (cuenta, acción, fecha, operador) en un log fuera del repo.

## 10. Conclusión

- **PR-21B no ejecuta nada.** Es plan operativo manual.
- **Solo reemplaza el camino SQL** (PR-21A Gate 2) **por un camino manual** en Supabase Dashboard/Auth.
- Mantiene el criterio actualizado: **única protección dura = `mancuellorenato@gmail.com`**; el resto es demo/sim, **pero intocable hasta aprobación explícita**.

---

### Anexo — Qué NO se tocó en PR-21B
no SQL · no DB writes · no Auth changes · no teardown · no dry-run teardown · no RLS/RPC/migrations · no frontend/backend runtime · no Vite · nada en producción.
