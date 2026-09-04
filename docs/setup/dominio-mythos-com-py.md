# Separar `mythos.com.py` del proyecto Mythos

> Decisión de Renato (2026-09-04): el dominio se libera para un proyecto nuevo.
> **Mythos queda en `https://mythos-pos.vercel.app`** — el alias que ya estaba dado
> de alta en el proyecto y sólo redirigía; se le quitó el redirect y pasó a servir
> el contenido. Es el único `.vercel.app` del proyecto que responde en público
> (los demás caen en el SSO de Vercel — ver §1.b). El dominio se estaciona en
> Cloudflare hasta que el proyecto nuevo exista.

---

## 1. Estado medido (2026-09-04)

**Registrador:** NIC.py o un reseller — **no Cloudflare**. Cloudflare no registra `.py`,
sólo le delegaron el DNS. Son dos cuentas distintas y la del registrador **no hace falta**
para este cambio: los nameservers no se tocan.

**Nameservers:** `sunny.ns.cloudflare.com` / `ridge.ns.cloudflare.com`

**Zona completa** (medido con `nslookup` contra 8.8.8.8 — sólo estos dos registros):

| Nombre | Tipo | Valor | Proxy |
|---|---|---|---|
| `mythos.com.py` | A | `216.198.79.1`, `64.29.17.1` (Vercel) | DNS only |
| `www.mythos.com.py` | CNAME | `af427e0208554977.vercel-dns-017.com` | DNS only |

**Sin MX, sin TXT, sin subdominios.** No hay correo corporativo en el dominio: liberarlo
no deja a nadie sin mail. Están en DNS-only (gris), no proxeados — por eso `nslookup`
devuelve IPs de Vercel y no de Cloudflare.

**Vercel:** proyecto `mythos` · `prj_Gc8xmRIUwhEYiHuVRdeDOB0GqNnP` · team `renaxtogg`
(`team_h8g7TPZLLVEsK0iXUgpSpOVI`). OJO: `mythos.vercel.app` NO es de este team (ver §1.b);
`mythos-pos.vercel.app` (308, alias viejo).

---

## 1.b 🔴 Mythos NO tiene hoy una URL pública de repuesto (medido 2026-09-04)

Dos hechos que invalidaron el primer plan y que hay que tener a la vista:

**`mythos.vercel.app` no es nuestro.** Sirve un sitio llamado *Mythos Studio*, de otra
cuenta: el subdominio en `vercel.app` es global y ya estaba tomado. Devuelve **200 en la
raíz** —por eso pasa por bueno en un chequeo superficial— pero **404 en `/inicio` y en
`/api/create-user`**. Un `curl` a la raíz no alcanza para adjudicarse un hostname: hay que
pedir una ruta que sólo exista en el proyecto propio.

**Las URLs `.vercel.app` propias están protegidas.** `mythos-renaxtoggs-projects.vercel.app`,
`mythos-git-main-…` y las de cada deployment devuelven **302 a `vercel.com/sso-api`**: el
proyecto tiene **Deployment Protection** (Vercel Authentication) activa. Quien no tenga
cuenta en el team, no entra.

**Consecuencia:** el único acceso público de Mythos **es `mythos.com.py`**. Sacar el dominio
sin haber habilitado otro camino no deja a los locales en una URL fea — los deja afuera,
mirando un login de Vercel. Antes de cualquier corte hay que decidir el destino y
**verificarlo sirviendo `/inicio` sin sesión**.

## 2. Lo que se rompe al sacar el dominio

Ordenado por gravedad. **Hay locales reales operando** (Nativa Gastronomía y otros).

1. **🔴 Los QR impresos en las mesas.** `_buildQrUrl()` en `src/admin/main.jsx:3729`
   arma la URL contra la **raíz** del origin donde se generó:
   `https://mythos.com.py/?r=<RID>&t=<qr_token>`. Esos QR están plastificados en las
   mesas. **No se pueden actualizar de forma remota — se reimprimen desde
   Admin › Mesas una vez que el panel viva en la URL nueva.**
2. **🔴 La PWA de caja** instalada en los dispositivos: el service worker
   (`public/sw.js`) está registrado bajo el origin viejo. Hay que desinstalar y
   reinstalar desde la URL nueva, o la caja offline queda apuntando a un origin muerto.
3. **🟠 Supabase Auth.** `Site URL` y `Redirect URLs` apuntan a `mythos.com.py`.
   Sin actualizarlas, los links mágicos y de recuperación llegan pero no entran.
4. **🟠 `ALLOWED_ORIGIN`.** Los 7 endpoints de `/api` (`create-user`, `onboarding`,
   `change-password`, `manage-staff`, `delete-restaurant`, `approve-supplier`,
   `set-admin-cedula`) leen `process.env.ALLOWED_ORIGIN` con fallback
   `'https://mythos.com.py'`. Es variable de entorno de Vercel: se cambia sin deploy.
5. **🟡 Favoritos y accesos directos del staff** (caja, cocina, mozo, admin).
6. **🟡 Textos y SEO:** `public/sitemap.xml`, `public/robots.txt`, los legales
   (`terminos.html`, `privacidad.html`, `cookies.html`) y `website_domain` —
   este último se edita desde **Superadmin › Sitio web**, sin deploy.

---

## 3. Credenciales — qué se necesita y dónde vive

**Nunca en un archivo.** `.env`, `config.js` y hasta los gitignored se sincronizan a
OneDrive. Los tokens van a variables de entorno de usuario de Windows
(`HKCU\Environment`), que OneDrive no toca.

### Token de Cloudflare (para el DNS)

1. `dash.cloudflare.com` → perfil (arriba a la derecha) → **My Profile**
2. **API Tokens** → **Create Token**
3. Plantilla **"Edit zone DNS"** → *Use template*
4. *Zone Resources*: `Include` → `Specific zone` → **mythos.com.py**
5. *Continue to summary* → *Create Token* → copiar

Alcance: edita el DNS **de esa zona y nada más**. No lee la cuenta, no toca otros dominios,
no puede transferir ni borrar el dominio.

### Token de Vercel (para el proyecto)

`vercel.com` → **Settings** de la cuenta → **Tokens** → Create, scope al team `renaxtogg`.
Alternativa sin token: correr `vercel login` en la terminal propia.

### Guardarlos

En **tu** PowerShell (no en el chat, así el token no queda en el historial):

```powershell
setx CLOUDFLARE_API_TOKEN "pega_el_token_aca"
setx VERCEL_TOKEN "pega_el_token_aca"
```

Se leen desde el registro sin reiniciar nada:

```powershell
[Environment]::GetEnvironmentVariable('CLOUDFLARE_API_TOKEN','User')
```

Para revocarlos después: mismo panel de Cloudflare/Vercel → *Delete*. Conviene
revocar el de Cloudflare apenas termine la migración; el DNS de un dominio es la
llave de todo lo demás.

---

## 4. Procedimiento

Orden importa: **primero Vercel, después Cloudflare.** Al revés, el dominio queda
apuntando a un proyecto que ya no lo reclama y Vercel sirve un error genérico.

### Paso 1 — Darle a Mythos un acceso público verificado ✅

Destino: **`mythos-pos.vercel.app`**. Se le quitó el `redirect` por API
(`PATCH /v9/projects/<id>/domains/<domain>` con `{"redirect": null}`) y quedó
sirviendo el contenido. Verificado sin sesión: `/inicio` 200, `/caja.html` 200,
`/api/create-user` 405 (existe), y ningún `Location` al SSO.

- [x] `ALLOWED_ORIGIN=https://mythos.com.py,https://mythos-pos.vercel.app` en
      Production. Los dos a la vez: `api/_cors.js` acepta lista justamente para que
      la mudanza no tenga ventana de CORS roto. Al terminar se puede dejar sólo el nuevo.
- [ ] Supabase → Authentication → URL Configuration: `Site URL` =
      `https://mythos-pos.vercel.app`; Redirect URLs = `https://mythos-pos.vercel.app/**`
      (cubre `/clientes` y `/riders`, hoy prioridad #4 de CLAUDE.md). **Manual.**
- [ ] Superadmin › Sitio web → `website_domain`. **Manual.**
- [x] `public/sitemap.xml`, `public/robots.txt`, legales, `registro.html`,
      `web-marketing-data.js`, `.env.example` y los textos del superadmin.
- [x] Avisar a los locales.

### Paso 2 — Sacar el dominio de Vercel

```bash
vercel domains rm mythos.com.py --token "$VERCEL_TOKEN" --yes
# o, si sólo se quita del proyecto sin soltarlo del team:
#   Dashboard → proyecto mythos → Settings → Domains → Remove
```

Quitar **las dos** entradas: `mythos.com.py` y `www.mythos.com.py`.

### Paso 3 — Estacionar la zona en Cloudflare

Sin proyecto nuevo todavía, lo limpio es **borrar los dos registros** que apuntan a
Vercel. La zona queda vacía y el dominio no resuelve — mejor que servir el error de
Vercel de "deployment not found", que se ve como un sitio roto.

Los nameservers **no se tocan**: la zona sigue en Cloudflare, lista para el proyecto
nuevo. Tocar los NS obligaría a volver a NIC.py y a esperar propagación de nuevo.

### Paso 4 — Después, para el proyecto nuevo

- Si va a Vercel: agregar el dominio en el proyecto nuevo y Vercel dicta los registros.
- Si va a otro host: crear el A/CNAME que ese host indique.
- **Si querés salvar los QR impresos:** en el proyecto nuevo, una redirección que mande
  `https://mythos.com.py/?r=…` a https://mythos-pos.vercel.app/?r=… preservando el query
  string. Es lo único que devuelve a la vida a los QR ya plastificados.

---

## 5. Rollback

Todo esto es reversible en minutos mientras la zona siga en Cloudflare:
volver a agregar `mythos.com.py` en el proyecto `mythos` de Vercel y recrear los dos
registros de la tabla del §1. La propagación es de minutos, no de días, porque los
nameservers nunca cambian.

Lo **no** reversible es el tiempo que los locales reales pasen sin poder escanear un QR.
Por eso el paso 1 va antes que el 2.
