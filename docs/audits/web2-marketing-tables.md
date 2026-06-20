# WEB-2 — Tablas `marketing_*` del sitio web comercial (migración 110)

> **Estado: PREPARED — NOT APPLIED.** La migración está escrita y validada localmente, **no se aplicó a producción** ni a ninguna base. Aplicarla requiere **backup nuevo + ejecución manual revisada** (ver §5). No se tocó Auth, Login, paneles, `/` (cliente QR) ni datos demo.

Archivo: [`supabase/migrations/20260620_110_marketing_site.sql`](../../supabase/migrations/20260620_110_marketing_site.sql)
Fecha: 2026-06-20 · Helper opcional de lectura: [`public/web-marketing-data.js`](../../public/web-marketing-data.js) (no cableado todavía).

---

## 1. Objetivo

Crear la base **dinámica** del sitio público MYTHOS (WEB-1 hoy es estático). En WEB-3 el sitio leerá estas tablas; en WEB-6 se editarán desde el módulo Superadmin "Sitio web", y los leads/eventos se verán desde Superadmin.

La migración es **100% aditiva**: solo `CREATE TABLE IF NOT EXISTS` de tablas **nuevas** con prefijo `marketing_*`, sus policies, grants y semillas. No altera ninguna tabla, policy, grant, función ni dato existente → **no destructiva**.

## 2. Tablas creadas (8)

| Tabla | Propósito | Lectura | Escritura |
|---|---|---|---|
| `marketing_plans` | Planes de la vidriera (Carta/Servicio/Full/Enterprise) | pública (activos) | superadmin |
| `marketing_add_ons` | Add-ons modulares | pública (activos) | superadmin |
| `marketing_site_sections` | Bloques de contenido editables (hero, trust, etc.) | pública (activos) | superadmin |
| `marketing_faqs` | Preguntas frecuentes | pública (activas) | superadmin |
| `marketing_testimonials` | Testimonios reales (sin semilla: no inventar prueba social) | pública (activos) | superadmin |
| `marketing_config` | Config key/value del sitio | pública **solo `is_public=true`** | superadmin |
| `marketing_leads` | Captación del sitio (contacto/demo/trial…) | **solo superadmin** | anon **INSERT-only** + superadmin |
| `marketing_events` | Analítica de actividad del sitio (append-only) | **solo superadmin** | anon **INSERT-only** + superadmin |

## 3. RLS (modelo de seguridad)

RLS **habilitada en las 8 tablas** (fail-closed: sin policy = denegado). Helper reutilizado: **`public.get_my_role()`** (mig 029), mismo criterio que migs 103/104 — **no se creó ningún helper nuevo** de superadmin (no hace falta).

- **Catálogos públicos** (`plans`, `add_ons`, `site_sections`, `faqs`, `testimonials`):
  - `*_public_read` — `FOR SELECT TO anon, authenticated USING (is_active = true)`
  - `*_superadmin_all` — `FOR ALL TO authenticated USING/WITH CHECK (get_my_role() = 'superadmin')`
  - Grants: `REVOKE ALL FROM anon` → `GRANT SELECT TO anon`; `GRANT SELECT,INSERT,UPDATE,DELETE TO authenticated` (las escrituras las filtra la policy a superadmin).
  - Superadmin ve también filas inactivas (vía la policy `*_superadmin_all`, que es permisiva/OR).

- **`marketing_config`**: igual que los catálogos pero la lectura pública es `USING (is_public = true)`.

- **`marketing_leads` / `marketing_events`** (captación):
  - `*_anon_insert` — `FOR INSERT TO anon`. En leads: `WITH CHECK (status = 'new' AND internal_notes IS NULL)` (anon no puede prefijar estado ni inyectar notas internas). En events: `WITH CHECK (true)`.
  - `*_superadmin_all` — lectura/gestión total solo superadmin.
  - Grants: `REVOKE ALL FROM anon` → `GRANT INSERT TO anon` (sin SELECT). Doble candado: anon no puede leer ni con bug.
  - **authenticated común NO puede leer** leads/events (sin policy que lo permita salvo superadmin).

## 4. Semillas (idempotentes — no pisan ediciones de Superadmin)

- **Planes**: Carta 99.000/990.000 · Servicio 229.000/2.290.000 (recomendado) · Full 399.000/3.990.000 · Enterprise (precio null). `ON CONFLICT (slug) DO NOTHING`.
- **Add-ons**: Bancard 100.000 · Facturación 150.000 · Inventario 250.000 · Delivery 350.000 · Fidelización 250.000 · Sucursal adicional 150.000. `ON CONFLICT (slug) DO NOTHING`.
- **Config pública**: `trial_days=14`, `founder_offer_active=true`, `founder_offer_limit=10`, `sales_whatsapp="595000000000"` (placeholder), `site_home_path="/inicio"`. `ON CONFLICT (key) DO NOTHING`.
- **Secciones**: `hero`, `trust_strip`, `local_bancard`, `final_cta`. `ON CONFLICT (section_key) DO NOTHING`.
- **FAQs**: las 7 de WEB-1 (`INSERT … WHERE NOT EXISTS` → corre una sola vez).
- **Testimonios**: ninguno (se cargan reales en WEB-6).

> Nota: `price_annual_gs` guarda el **total anual** (10× mensual = 2 meses gratis), distinto del "por mes en plan anual" que muestra hoy el toggle de WEB-1. WEB-3 reconcilia la presentación.

## 5. Cómo aplicar (manual, tras backup)

1. **Backup nuevo** de la base (no reutilizar uno viejo).
2. Supabase Dashboard → **SQL Editor en inglés** (el español autotraduce keywords y rompe — ver CLAUDE.md).
3. Pegar y ejecutar el contenido de `20260620_110_marketing_site.sql` completo (incluye `BEGIN…COMMIT` + `NOTIFY pgrst`).
4. Verificación rápida (debe devolver 8 tablas con `rowsecurity = true`):
   ```sql
   select tablename, rowsecurity
   from pg_tables
   where schemaname='public' and tablename like 'marketing\_%'
   order by tablename;
   ```
5. Smoke de RLS:
   - Con la **anon key**: `select count(*) from marketing_plans;` → ve solo activos; `select * from marketing_leads;` → **0 filas / denegado**; `insert into marketing_leads(type,email) values('contact','x@x.com');` → **OK**.
   - Como **superadmin**: `select * from marketing_leads;` → ve todo.

La migración es **idempotente** (segura de re-correr).

## 6. Contrato de lectura para WEB-3 (helper opcional)

`public/web-marketing-data.js` (`window.MythosWebData`, **no cableado aún**) expone:
`getPlans()`, `getAddOns()`, `getSections()`, `getFaqs()`, `getTestimonials()`, `getConfig()`, `logEvent(name, meta)`, `submitLead(payload)`. Degrada a `[]`/`{}`/`false` si no hay `window.supabase` + `SUPABASE_CONFIG`. Los INSERT usan `returning:'minimal'` (sin `.select()`), porque anon no tiene SELECT en leads/events.

## 7. Confirmaciones

- ✅ Migración nueva con el **siguiente número real** (110; la última era 109).
- ✅ **No destructiva** (solo CREATE de tablas nuevas + policies/grants/seeds).
- ✅ **RLS obligatoria** en las 8 tablas.
- ✅ **Producción NO fue tocada**; migración **no aplicada** en ninguna base.
- ✅ Sin tocar Auth core, Login, `/` (QR), paneles ni datos demo.
- ✅ Sin secretos. `build.sh` sigue generando `config.js` desde env vars.
- ✅ UI **no modificada** para leer de Supabase (eso es WEB-3); solo se agregó el helper opcional, sin cablear.

## 8. Próximo paso — WEB-3

Cablear `precios.html` (y secciones de `web.html`) para leer planes/add-ons/config vía `MythosWebData`, con el armador "Calculá tu precio" (total en vivo) y el flag de Oferta Fundador desde `marketing_config`. Requiere cargar el UMD de `@supabase/supabase-js` + `config.js` en esas páginas.
