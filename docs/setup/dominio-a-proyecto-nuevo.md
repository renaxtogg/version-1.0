# Conectar `mythos.com.py` al proyecto nuevo

Continuación de `dominio-mythos-com-py.md`, que cuenta cómo el dominio **salió** del
proyecto Mythos el 2026-09-04. Esto es cómo **entra** al siguiente.

El prompt del §3 es autocontenido: el chat nuevo no va a tener nada de este contexto.

---

## 1. Antes de abrir el chat nuevo

**Creá el token de Cloudflare** (dura lo que dure la tarea; revocalo al terminar):

1. https://dash.cloudflare.com/profile/api-tokens → **Create Token**
2. Plantilla **"Edit zone DNS"** → *Use template*
3. Permissions — tienen que quedar **dos** filas:
   - `Zone` · `DNS` · **Edit**
   - `Zone` · `Zone` · **Read**  ← agregala, sin esto no puede resolver el ID de la zona
4. Zone Resources: `Include` → `Specific zone` → **mythos.com.py**
5. Create Token → copiar

**Guardalo** en tu PowerShell (el token no queda en el historial: `Read-Host` no se registra):

```powershell
$t = Read-Host "Token de Cloudflare"
Write-Host "Recibi $($t.Length) caracteres"
if ($t.Length -gt 20) {
  [Environment]::SetEnvironmentVariable('CLOUDFLARE_API_TOKEN', $t, 'User')
  Write-Host "Guardado OK" -ForegroundColor Green
} else {
  Write-Host "Vacio o muy corto - no lo guardo" -ForegroundColor Red
}
```

Pegá el token **cuando PowerShell te pregunte**, no dentro de las comillas de la primera
línea. Tiene que decirte ~40 caracteres y `Guardado OK`.

**Y asegurate de que el CLI de Vercel esté autenticado**: `vercel whoami`. Si da error,
`vercel login`.

---

## 2. Datos de referencia (medidos el 2026-09-04)

| | |
|---|---|
| Dominio | `mythos.com.py` |
| Registrador | NIC.py o un reseller — **no Cloudflare** (no registra `.py`) |
| DNS | Cloudflare, cuenta `Mancuellorenato@gmail.com`, plan Free |
| `zone_id` | `f689051241403501a84eda97907d8fa8` |
| Nameservers | `ridge.ns.cloudflare.com`, `sunny.ns.cloudflare.com` — **no tocar** |
| Team Vercel viejo | `renaxtoggs-projects` / `team_h8g7TPZLLVEsK0iXUgpSpOVI` |
| Estado | sin registro de raíz ni de `www`: **no resuelve** |

### 🔴 Los 4 registros que NO se tocan

Son el correo del dominio — Resend sobre Amazon SES. Borrarlos deja al dominio sin mail.

| Tipo | Nombre | Contenido |
|---|---|---|
| MX | `send.mythos.com.py` | `feedback-smtp.sa-east-1.amazonses.com` |
| TXT | `send.mythos.com.py` | `"v=spf1 include:amazonses.com ~all"` |
| TXT | `resend._domainkey.mythos.com.py` | DKIM (`p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC80DOyc8KZuG4/...`) |
| TXT | `_dmarc.mythos.com.py` | `"v=DMARC1; p=none;"` |

---

## 3. El prompt — copiá desde acá

```text
Necesito conectar mi dominio mythos.com.py a ESTE proyecto y quiero que lo hagas vos.
Tengo el CLI de Vercel autenticado y el token de Cloudflare guardado en la variable de
entorno de usuario CLOUDFLARE_API_TOKEN.

=== CONTEXTO DEL DOMINIO (medido el 2026-09-04 — no lo asumas, verificalo) ===

- Registrador: NIC.py o un reseller. Cloudflare NO registra .py: sólo le delegaron el
  DNS. La cuenta del registrador NO hace falta para esto.
- DNS en Cloudflare, cuenta Mancuellorenato@gmail.com, plan Free, status active.
  zone_id = f689051241403501a84eda97907d8fa8
- Nameservers: ridge.ns.cloudflare.com y sunny.ns.cloudflare.com. NO LOS TOQUES.
  Cambiarlos obliga a volver a NIC.py y esperar propagación de nuevo.
- El dominio estuvo en otro proyecto de Vercel (Mythos) hasta el 2026-09-04. Se le
  borraron los registros de la raíz y de www, así que HOY NO RESUELVE.
- Sigue dado de alta en el team de Vercel renaxtoggs-projects
  (team_h8g7TPZLLVEsK0iXUgpSpOVI) pero SIN proyecto asignado.

=== 🔴 NO TOQUES ESTOS 4 REGISTROS ===

Son el correo del dominio (Resend sobre Amazon SES). Borrarlos lo deja sin mail:

  MX   send.mythos.com.py               -> feedback-smtp.sa-east-1.amazonses.com
  TXT  send.mythos.com.py               -> "v=spf1 include:amazonses.com ~all"
  TXT  resend._domainkey.mythos.com.py  -> DKIM, empieza con p=MIGfMA0GCSqGSIb3DQEB
  TXT  _dmarc.mythos.com.py             -> "v=DMARC1; p=none;"

Al terminar, confirmame que los cuatro siguen ahí.

=== QUÉ QUIERO ===

Que https://mythos.com.py y https://www.mythos.com.py sirvan ESTE proyecto, con HTTPS.

=== CÓMO ===

1. Primero medí el estado real. Listá la zona ENTERA por la API de Cloudflare
   (GET /client/v4/zones/<zone_id>/dns_records) y los dominios del proyecto. No te
   fíes de nslookup: un MX consultado en la raíz no describe una zona — así casi se
   borra el correo de este dominio la vez pasada.

2. Agregá el dominio al proyecto. Si este proyecto está en el team
   renaxtoggs-projects, se agrega directo. Si está en otra cuenta de Vercel, primero
   hay que soltarlo del team viejo (vercel domains rm mythos.com.py) o la otra cuenta
   no lo va a poder reclamar.

3. Creá en Cloudflare los registros que el host pida, en DNS ONLY (nube gris,
   proxied=false). Con el proxy naranja de Cloudflare, Vercel no puede emitir el
   certificado y el dominio queda en "Invalid Configuration". Si por algún motivo hay
   que proxear, el modo SSL de Cloudflare tiene que ser "Full (strict)": en "Flexible"
   se arma un bucle de redirecciones.

4. Esperá la verificación y el certificado.

5. Verificá pidiendo una ruta que SÓLO exista en este proyecto, no la raíz. Una raíz
   que devuelve 200 no prueba nada: la vez pasada un hostname de otra persona devolvió
   200 en / y 404 en /inicio, y casi se da por bueno.

=== NOTAS ===

- Leé el token así, porque $env: no sobrevive entre invocaciones del tool:
  $t = [Environment]::GetEnvironmentVariable('CLOUDFLARE_API_TOKEN','User')
  Nunca lo imprimas.
- Si algún panel del proyecto arma URLs contra window.location.origin (códigos QR,
  links compartibles, emailRedirectTo), revisá que el cambio de dominio no los deje
  apuntando al host viejo.
- Si el proyecto usa Supabase Auth: cargá el dominio nuevo en Authentication → URL
  Configuration (Site URL y Redirect URLs) o los links mágicos llegan pero no entran.
```

---

## 4. Trampas conocidas

- **Proxy naranja de Cloudflare + Vercel = certificado que nunca sale.** Los registros
  van en **DNS only**. Es la causa #1 de "Invalid Configuration" en Vercel.
- **`$env:VAR` no persiste entre llamadas del tool.** El proceso hereda el entorno del
  padre, que arrancó antes de que se escribiera la variable. Hay que leerla del registro:
  `[Environment]::GetEnvironmentVariable('X','User')`.
- **`SetEnvironmentVariable` con string vacío BORRA la variable.** Si el `Read-Host`
  capturó vacío, el resultado es "no existe", no "existe vacía".
- **Un `curl` a la raíz no adjudica un hostname**, y **un `MX` en la raíz no describe una
  zona**. Los dos errores pasaron el 2026-09-04. Medir por API, y pedir una ruta propia.
- **Los QR viejos de Mythos** apuntan a `https://mythos.com.py/?r=<uuid>&t=<token>`. Se
  están reimprimiendo, pero si querés ser amable con los que queden dando vueltas, el
  proyecto nuevo puede redirigir las URLs con `?r=` a `https://mythos-pos.vercel.app`
  preservando el query string.
