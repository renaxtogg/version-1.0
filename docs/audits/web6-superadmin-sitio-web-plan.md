# WEB-6 — Módulo Superadmin "Sitio web": diagnóstico + plan

> **Fase:** WEB-6 (auditoría + plan). **Fecha:** 2026-06-22. **Base:** `main = 3e59a10` (WEB-5 leads).
> **Estado:** plan aprobado. Implementación incremental por sub-fases (WEB-6A primero). Auditoría por workflow read-only (7 agentes). **No se aplicó SQL, no se tocó código de producto en esta fase.**

---

## 1. Diagnóstico del Superadmin actual

**Estructura** — `src/superadmin/main.jsx` es **un solo archivo JSX (~3857 líneas)** compilado por Vite a `public/build/superadmin.js` (lo carga `public/superadmin.html`). Hay un `App()` (shell, ~3690) + `Sidebar()` (~3640) + ~12 componentes `Page*` independientes.

- **NAV**: array plano a nivel módulo `const NAV = [{id,label}, …]` (~2777). Sin icon/href.
- **Ruteo**: NO hay router — *switch por string state*: `const [page,setPage]=useState('dashboard')` + cadena `{page==='x' && <PageX/>}` (~3819-3830).
- **Sin pestañas internas** hoy; patrón reusable: `FilterBtn` (pill, ~437) como en `PageSoporte`/`PageCapacidad`.

**Datos** — `db = createClient(url, anonKey)` una vez a nivel módulo (~62-71); lleva el **JWT del superadmin logueado** → RLS autoriza por `get_my_role()`. **Sin service_role en el cliente.**
- Guardia: `bootstrap()` (~3841-3856): `getSession()` → `db.rpc('get_my_profile')` → si `role!=='superadmin'` → `signOut()` + redirect a `login.html`.
- CRUD: `db.from(t).select/insert/update/upsert/delete`. Config key/value: `upsert({key,value},{onConflict:'key'})`.
- Reusables: `Modal`, `FormField`, `Btn`, `Badge`, `Toggle`, `FlashMsg` (toast `setFlash`), `SectionCard`, `Th/Td`, `Spinner`, `FilterBtn`, `Kpi`, `fmtGuarani`, `fmtDate/RelTime`, `statusMeta`, `asArr/asObj`.
- **No existe** confirm-dialog (delete corre directo + toast) ni paginación (carga todo, filtra en cliente).

## 2. RLS: ¿superadmin puede leer/editar `marketing_*`? — SÍ, completo. CERO migración.

Las 8 tablas (mig 110) tienen el patrón uniforme: `*_superadmin_all FOR ALL TO authenticated USING/WITH CHECK get_my_role()='superadmin'` + `GRANT SELECT,INSERT,UPDATE,DELETE TO authenticated`.

| Tabla | Superadmin | anon |
|---|---|---|
| `marketing_plans`/`add_ons`/`site_sections`/`faqs`/`testimonials` | CRUD total | SELECT solo `is_active=true` |
| `marketing_config` | CRUD total (`sales_whatsapp`, `founder_*`, `trial_days`) | SELECT solo `is_public=true` |
| `marketing_leads` | SELECT + UPDATE status/internal_notes + INSERT/DELETE | **solo INSERT** (no SELECT) |
| `marketing_events` | SELECT (+CRUD) | solo INSERT (no SELECT) |

→ **WEB-6 es 100% frontend.** No hace falta policy, columna ni grant nuevos.

## 3. Inventario de columnas (editables)

- **marketing_plans**: name, slug(unique), headline, description, price_monthly_gs, price_annual_gs, currency, features(jsonb array), badge, is_recommended, is_enterprise, is_active, sort_order.
- **marketing_add_ons**: name, slug(unique), description, price_gs, price_type CHECK(cuota/comision/cotizar), is_active, sort_order.
- **marketing_site_sections**: section_key(unique), title, subtitle, body, items(jsonb), cta(jsonb), is_active, sort_order. (jsonb anidado → editor diferido)
- **marketing_faqs**: question, answer, is_active, sort_order.
- **marketing_testimonials**: person_name, business_name, role, quote, avatar_url, is_active, sort_order. **SIN seed — vacía a propósito; no inventar.**
- **marketing_config**: key/value(jsonb)/is_public. Seeds: `trial_days=14`, `founder_offer_active=true`, `founder_offer_limit=10`, `sales_whatsapp="595000000000"`, `site_home_path="/inicio"`. **`trial_signup_enabled` NO está en mig 110** — solo en mig 111 (PREPARED, no aplicada).
- **marketing_leads**: type CHECK(contact/demo/trial_interest/whatsapp/pricing), status CHECK(new/contacted/qualified/won/lost/spam), internal_notes, name/business_name/email/whatsapp/message/plan_slug/selected_addons/source/utm. Solo `status`+`internal_notes` editables en triage.
- **marketing_events**: event_name, page_path, plan_slug, metadata, session_id, created_at. Append-only, read-only.

## 4. Propuesta de UI — 1 entrada NAV "Sitio web" → `PageSitioWeb` con pestañas (`FilterBtn` + `useState`)

| Pestaña | Qué hace | Modelo |
|---|---|---|
| **Resumen** | KPIs últimos 7 días: leads nuevos, demos, intereses trial, eventos. Estados vacíos honestos. | `Kpi`/`PageReportes` |
| **Leads** | Lista `marketing_leads` + filtros tipo/status + detalle; cambiar `status` + editar `internal_notes`. PII solo lectura. | `PageSoporte` |
| **Actividad** | Lista `marketing_events` read-only + filtro por `event_name`. | `PageActividad` |
| **Planes** | CRUD `marketing_plans`; `slug` read-only. | `PageFacturacion` |
| **Add-ons** | CRUD `marketing_add_ons`; `price_type` select. | `PageFacturacion` |
| **Config** | Editor tipado `sales_whatsapp`/`founder_*`/`trial_days`. `trial_signup_enabled` read-only + advertencia, nunca encender. | `PageConfiguracion` |
| **FAQ/contenido** | CRUD `marketing_faqs`; testimonios solo reales; `site_sections` diferido. | `PageActividad` |

## 5. Archivos a tocar

Solo `src/superadmin/main.jsx`, 4 puntos: (1) NAV entry, (2) línea en el switch de `App()`, (3) `function PageSitioWeb(...)` con autofetch + degradado `.then(r=>r.error?{data:[]}:r)`, (4) opcional `pageTitles`. **Sin migración. Sin tocar** Auth, `/`, login, registro trial, `web-marketing-data.js`.

## 6. Riesgos

| # | Riesgo | Sev. | Mitigación |
|---|---|---|---|
| 1 | `marketing_config.value` es JSONB (no text); `getPublicConfig` lo aplica crudo → tipo mal guardado corrompe el sitio en silencio. | Alta | Editor tipado por clave (number/toggle/text → JSON-encode). Nunca cuadro genérico texto→jsonb. |
| 2 | `trial_signup_enabled` — toggle peligroso (abre registro público sin endpoint). Solo existe con mig 111. | Alta | Read-only + advertencia; mantener `false`; si falta, "apagado/no configurado", nunca auto-crear `true`. |
| 3 | Editar `slug` de plan/add-on desincroniza billing (mig 111) y `FALLBACK_PLANS`. | Alta/Media | `slug` estable, read-only tras crear. |
| 4 | mig 110/111 en prod sin verificar (headers NOT APPLIED; memoria implica 110 vivo por efecto). | Alta | Confirmar `to_regclass` en prod; loaders con degradado. |
| 5 | PII en leads (email/whatsapp) solo superadmin. | Media | Leer solo con sesión auth; no loguear PII; triage edita solo status/internal_notes. |
| 6 | Sin confirm ni paginación. | Media | Soft-disable (`is_active=false`) sobre delete; cap en leads. |
| 7 | Inventar prueba social (tablas vacías por diseño). | Media | Estados vacíos honestos; no mockear. |

## 7. Plan de implementación

- **WEB-6A** (primero, bajo riesgo): NAV "Sitio web" + `PageSitioWeb` con **Resumen + Leads + Actividad + Config**. Solo tablas de mig 110. Config tipado con `trial_signup_enabled` bloqueado.
- **WEB-6B**: Planes + Add-ons (slug estable, price_type select).
- **WEB-6C**: FAQ + Testimonios mínimos (solo reales).
- **Diferido (aprobación aparte)**: editor estructurado de `site_sections.items/.cta`, paginación/filtrado server-side de leads.

**Precondición:** confirmar mig 110 aplicada en prod (para `trial_signup_enabled`, mig 111).

## 8. QA (preview con mig 110 aplicada)

Superadmin ve el módulo; no-superadmin rebota; Resumen carga; leads aparecen; cambiar status + internal_notes persiste; actividad muestra eventos; editar `founder_offer_limit` 10→11 se refleja en `/precios` y revierte; `sales_whatsapp` sigue `595986622735`; `trial_signup_enabled` no se puede activar; `/`/`/login`/`/inicio`/`/precios`/`/contacto`/`/registro` intactos; consola limpia; build PASS.
