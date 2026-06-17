# PR-20 — Auditoría datos de simulación + cuentas compartidas

> **Tipo:** auditoría + plan (read-only + documentación). **No cambia producto. No toca datos.**
> **Fecha:** 2026-06-16. **Autor:** Claude Code (programador). **Para:** Renato (fundador) + ChatGPT (arquitecto).
> **Bloqueo:** 2 detectado en PR-17 (datos/cuentas de simulación vivos en prod junto a Terrapizza real).

---

## 1. Estado base

| Campo | Valor |
|---|---|
| Commit base | `main` = `origin/main` = **`e422789`** (PR-18) |
| Rama de esta auditoría | `audit/pr-20-simulation-accounts-plan` (desde `e422789`) |
| Producción | Supabase proyecto `ocwzupmamfojvdywavqi` |
| Confirmación solo lectura | Script de inventario = 16 sentencias, todas `SELECT` (verificado por grep); cero INSERT/UPDATE/DELETE/DDL/GRANT |

**Qué NO se tocó:** datos, usuarios, Auth, DB/RLS/RPC, migraciones, teardown, dry-run, Terrapizza, frontend/backend/runtime, Vite. No se ejecutó SQL contra prod (no hay conexión segura local). No se imprimieron contraseñas/hashes/tokens.

---

## 2. Resumen ejecutivo

- **Riesgo activo confirmado a nivel de modelo** (a cuantificar con el inventario): existen **3 restaurantes de simulación** (allowlist `a1a1…/b2b2…/c3c3…`) y **~15 cuentas `@mythos.test` + ~2-3 `@mythos.internal`** (QA) que, según PR-14/PR-17 y la memoria del proyecto, **siguen vivos en prod** junto a **Terrapizza (real)**.
- **La contraseña compartida de simulación NO está en ningún archivo rastreado del repo** (`git grep` = 0 matches). Vive solo en `_simulacion/` (gitignored) y en `MYTHOS_QA_BRIEFING.md` (no rastreado). **Pero** esos archivos locales **se sincronizan a OneDrive** (riesgo documentado en CLAUDE.md), y lo más importante: **las cuentas con esa contraseña son cuentas reales y activas en prod**.
- **No listo para cliente real** mientras existan logins compartidos con contraseña conocida hacia producción.
- **Requiere ejecución manual del inventario** (PENDING) para pasar de "riesgo conocido por modelo" a "conteos exactos" y elegir el camino.

---

## 3. Inventario read-only

**Opción B — Script preparado, PENDIENTE de ejecución manual por Renato.**

No hay conexión segura configurada localmente (verificado sin imprimir valores: `SUPABASE_PAT`/`SUPABASE_DB_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`DATABASE_URL`/`SUPABASE_ACCESS_TOKEN`/`PGPASSWORD` sin setear; sin `supabase` CLI ni `psql`). Según las reglas, **no se piden secretos**.

### Instrucciones de ejecución manual (seguras)
1. Supabase Dashboard → **SQL Editor**, idioma **inglés**.
2. Pegar **`scripts/verify/pr20-simulation-accounts-inventory.sql`** y ejecutar (o sección por sección).
3. Pegar la salida en §4–§5 de este informe; como mínimo la **fila del gauge (Sección 5)**.
4. **No** pegar contraseñas/hashes/tokens (el script no los devuelve).

> **Fix 2026-06-16 (primera corrida):** la primera ejecución abortó con
> `42P01: relation "public.user_profiles" does not exist` (Sección 3.1).
> Confirmado: **`public.user_profiles` NO existe en prod** (tabla fantasma,
> consistente con el hallazgo del RLS Sprint). El script se corrigió: las
> tablas opcionales/fantasma (`user_profiles`, `delivery_channels`) ya **no**
> se referencian directamente en SQL ejecutable — la Sección 3.1 ahora usa
> `to_regclass(...)` (devuelve NULL si la tabla no existe y nunca falla), y
> los conteos opcionales quedan **comentados** (ejecutar solo si existen).
> El script vuelve a ser ejecutable de punta a punta. **Renato debe volver a
> correr el archivo completo corregido.**

---

## 4. Datos demo/sim detectados

> A completar con el inventario (Secciones 1 y 3 del script). Conteos esperados (referencia de PR-14/memoria, a confirmar):

| restaurante/tenant candidato | motivo | conteos principales | severidad | recomendación |
|---|---|---|---|---|
| Bella Napoli `a1a1…0001` | allowlist sim + nombre | _(pendiente: orders/delivery/ratings/…)_ | Media | rotar/desactivar cuentas → luego teardown |
| Sushi Sakura `b2b2…0002` | allowlist sim + nombre | _(pendiente)_ | Media | idem |
| Parrilla Don Carlos `c3c3…0003` | allowlist sim + nombre + data QA | _(pendiente; tiene data QA de PRs)_ | Media-Alta | idem |
| **Terrapizza** | **tenant REAL** | n/a | — | **DETECTAR y EXCLUIR siempre; nunca tocar** |

**PASS esperado del gauge:** `terrapizza_present ≥ 1`; `demo_restaurants_count = 3`.

---

## 5. Cuentas demo/sim detectadas

> A completar con la Sección 2 (`user_roles`) y la Sección 4 (`auth.users`) del script. **Sin passwords.**

| patrón | cantidad (esperada) | roles | tenant asociado | severidad | recomendación |
|---|---|---|---|---|---|
| `@mythos.test` | ~15-16 | admin/mozo/caja/cocina/rider/superadmin | restaurantes sim | **Alta** (contraseña compartida) | rotar o desactivar |
| `@mythos.internal` | ~2-3 (QA PR-4/PR-5) | empleado | Don Carlos sim | Media | desactivar/limpiar |
| `qa.superadmin@mythos.test` | 1 | superadmin | (sin restaurante) | **Alta** | rotar/desactivar (superadmin sim) |

**Protección:** el script marca `protegido_no_tocar = true` para cualquier usuario con rol en restaurante NO-sim (staff real / Terrapizza / Renato) → esos **nunca** entran en una acción futura.

---

## 6. Contraseñas documentadas o compartidas

| archivo | tipo de hallazgo | ¿valor redactado? | ¿rastreado en git? | severidad | recomendación |
|---|---|---|---|---|---|
| `MYTHOS_QA_BRIEFING.md` | contraseña compartida sim en texto | Sí (no se imprime) | **No** (untracked) | Alta | mantener fuera del repo; rotar la contraseña en prod |
| `_simulacion/02_staff.sql` | contraseña sim usada al sembrar staff | Sí | **No** (gitignored) | Alta | gitignored, pero sincroniza a OneDrive → rotar en prod |
| `_simulacion/06_qa_superadmin.sql` | contraseña sim del superadmin QA | Sí | **No** (gitignored) | Alta | idem |
| `_simulacion/INFORME.md` | documenta la contraseña compartida | Sí | **No** (gitignored) | Alta | idem |
| `public/login.html`, `admin.html`, `superadmin.html` | `type="password"`, `autoComplete`, placeholders | n/a (no son secretos) | Sí | Ninguna | — (UI normal) |
| `docs/audits/pr17-…md`, `scripts/teardown/README.md` | mención conceptual "contraseña compartida" | Sí (sin valor) | Sí | Info | — |

**Conclusión:** **cero contraseñas reales en archivos rastreados.** El valor compartido existe solo en archivos locales no rastreados/gitignored (que sincronizan a OneDrive) **y, sobre todo, en las cuentas activas de prod** → el riesgo real es de **cuentas**, no de fuga por el repo.

---

## 7. Riesgo Terrapizza

- **Terrapizza es un tenant REAL** (cargado a mano post-reset; UUID `01b5efb6-…`). **No debe ser tocada** en ninguna acción.
- El riesgo no es Terrapizza en sí, sino su **convivencia** con: (a) datos/cuentas de simulación, (b) el panel **superadmin cross-tenant** que la muestra, (c) cualquier demo abierta.
- **Regla para toda acción futura:** usar **allowlist explícita de los 3 UUIDs sim** (nunca denylist), con **guarda dura que aborte si Terrapizza aparece** en el set objetivo (igual que el teardown de PR-14). El inventario la **detecta** (`terrapizza_present`, `es_terrapizza`) precisamente para confirmar que queda fuera.

---

## 8. Opciones de decisión

### Opción A — No tocar nada todavía
- **Pros:** cero riesgo de romper algo; mantiene el simulacro disponible para QA.
- **Contras:** sigue habiendo logins compartidos con contraseña conocida hacia prod → **no apto para cliente real**.
- **Cuándo usar:** solo mientras el sistema sea exclusivamente de demo/QA interno, sin cliente real.

### Opción B — Rotar contraseñas sim
- **Pros:** elimina el riesgo de "contraseña conocida" sin borrar datos; reversible; rápido.
- **Contras:** invalida los logins QA documentados (hay que redocumentar la nueva, fuera del repo); no limpia los datos sim.
- **Requiere:** Supabase Auth / dashboard (Admin API o reset por usuario). No es SQL de tablas.
- **Riesgo:** bajo. **Recomendación:** **buen primer paso** si se quiere mantener el simulacro pero cerrar el riesgo de credenciales.

### Opción C — Desactivar usuarios sim
- **Pros:** corta el acceso sin borrar (set `is_active=false` en `user_roles` y/o `ban`/`disable` en Auth); reversible.
- **Contras:** requiere escritura controlada (DB/Auth) → ya **no** es read-only (sería un PR aparte aprobado); deja los datos.
- **Requiere:** DB (`user_roles.is_active`) y/o Auth admin.
- **Riesgo:** bajo-medio (cuidar allowlist). **Recomendación:** alternativa a B; **B+C juntas** dejan el simulacro inerte sin borrar nada.

### Opción D — Teardown sim con backup nuevo
- **Pros:** elimina por completo datos + cuentas sim; deja prod solo con Terrapizza (real); es el plan ya preparado en PR-14.
- **Contras:** destructivo e irreversible sin backup; requiere ventana.
- **Requiere:** **backup NUEVO** (el histórico `mythos_pre_rls_20260611_…dump` NO alcanza) + correr el **dry-run** de PR-14 + **aprobación explícita de Renato**.
- **Riesgo:** alto si se hace mal; **mitigado** por las guardas del script PR-14 (allowlist + abort Terrapizza + umbral + ROLLBACK).
- **Recomendación:** **paso final**, después de B/C y de un backup nuevo verificado.

### Opción E — Demo limpia etiquetada `[DEMO]`
- **Pros:** entorno demo reproducible, separado de sim y de Terrapizza; no contamina métricas reales.
- **Contras:** agrega datos nuevos (seed); sólo tiene sentido **después** de decidir la limpieza de lo viejo.
- **Requiere:** seed controlado idempotente (plan en `scripts/teardown/seed-demo-data-plan.md`).
- **Riesgo:** bajo. **Recomendación:** **después** de B/C (y/o D).

---

## 9. Recomendación arquitectónica

Camino recomendado (incremental, reversible primero):

1. **Ejecutar el inventario read-only** (este PR) → confirmar conteos y el gauge.
2. Si confirma sim/demo vivo: **rotar (Opción B) y/o desactivar (Opción C)** las cuentas compartidas **primero** — cierra el riesgo de credenciales sin borrar nada, reversible.
3. **Postergar el teardown real (Opción D)** hasta tener **backup nuevo verificado** + dry-run revisado + aprobación.
4. **Crear demo limpia `[DEMO]` (Opción E)** solo **después** de decidir limpieza/rotación.

Racional: priorizar lo reversible y de menor riesgo (rotar/desactivar) antes que lo destructivo (teardown), y no sembrar demo nueva sobre datos viejos sin resolver.

---

## 10. Próximos PRs sugeridos (pequeños; ninguno iniciado)

- **PR-21A — Rotación/desactivación segura de cuentas sim.** Rotar contraseñas y/o `is_active=false` por allowlist (excluye Terrapizza/real). Toca Auth/DB (escritura acotada). QA: login sim deja de funcionar. **Alta.**
- **PR-21B — Superadmin demo-safety.** Modo lectura/exclusión de tenants reales en demo (de PR-17). **Media.**
- **PR-22 — Demo seed `[DEMO]`.** Seed idempotente etiquetado (`seed-demo-data-plan.md`). **Media** (depende de PR-21A).
- **PR-23 — Teardown real con backup nuevo.** Ejecutar el plan PR-14 con backup verificado + dry-run + aprobación. **Alta cuando se decida limpiar.**

---

## 11. Qué NO tocar todavía

- **Terrapizza** (real, UUID `01b5efb6-…`).
- **Teardown real** y **dry-run teardown** (no ejecutar sin backup nuevo + aprobación).
- **Datos productivos** y **Auth users** (no modificar en este PR).
- **Migraciones / RLS / RPC / policies.**
- **Pricing / enforcement premium.**
- **CRM-CRUD.**
- **Más migración Vite.**
- **Seeds** y **scripts destructivos.**

---

## 12. Conclusión

- **PR-20 no cambia producto ni datos.** Es auditoría + plan: prepara el inventario read-only y compara opciones.
- Su objetivo es **decidir el camino seguro** para el Bloqueo 2 (sim/cuentas compartidas).
- **Ninguna acción destructiva ni de escritura está aprobada todavía.** El siguiente paso concreto es correr el inventario y, con el gauge, elegir entre rotar/desactivar (reversible) y, más adelante, teardown (con backup nuevo).

---

### Anexo — Incertidumbres
- Conteos exactos de restaurantes/usuarios/orders sim en prod → los da el inventario (PENDING re-ejecución del script corregido).
- Acceso del SQL Editor a `auth.users` (Sección 4) — normalmente OK como `postgres`; si no, se omite.
- `public.user_profiles` **confirmado ausente** en prod (tabla fantasma). `public.delivery_channels` → la Sección 3.1 (`to_regclass`) revela si existe; si NULL, omitir su conteo opcional.
- Estado de rotación previa de la contraseña compartida (no verificable desde el repo).
