# Datos sensibles del proyecto — Mesa App v1.0

> Este archivo documenta QUÉ credenciales existen, DÓNDE se guardan de forma segura,
> y qué NUNCA debe subirse a GitHub ni quedar expuesto públicamente.

---

## ✅ Lo que está protegido correctamente

| Dato | Dónde se guarda | En GitHub | En URL pública |
|---|---|---|---|
| `SUPABASE_URL` | Vercel Environment Variables | ❌ Nunca | ❌ Generado en build |
| `SUPABASE_ANON_KEY` | Vercel Environment Variables | ❌ Nunca | ⚠️ Ver nota abajo |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard únicamente | ❌ Nunca | ❌ Nunca |
| `RESTAURANT_ID` | Vercel Environment Variables | ❌ Nunca | ❌ Generado en build |

---

## ⚠️ Nota sobre el Anon Key de Supabase

El `SUPABASE_ANON_KEY` **sí queda visible en el browser** (en DevTools → Sources).
Esto es **intencional y seguro por diseño de Supabase**:

- Es la clave "anónima/pública" — creada exactamente para ser usada en el browser
- La seguridad real está en **Row Level Security (RLS)** en la base de datos
- Nadie puede hacer más de lo que las políticas RLS permiten, aunque tenga el anon key
- Es equivalente a tener una "clave de sólo-lectura con permisos limitados"

Lo que **sí** sería peligroso (y nunca hacemos):
- Poner el `service_role key` en el frontend → acceso total sin restricciones a la DB

---

## 🔴 Lo que NUNCA debe subirse a GitHub

| Archivo / Dato | Razón |
|---|---|
| `public/config.js` | Contiene credenciales generadas en el build |
| `.env` | Variables de entorno con credenciales reales |
| `SUPABASE_SERVICE_ROLE_KEY` | Acceso admin total a la base de datos |
| Cualquier token de API | De Supabase, Vercel, GitHub, etc. |

---

## 🟢 Lo que SÍ está en GitHub (sin peligro)

| Archivo | Por qué es seguro |
|---|---|
| `public/config.example.js` | Solo tiene placeholders, sin valores reales |
| `.env.example` | Solo tiene nombres de variables, sin valores |
| `build.sh` | Lee las credenciales de env vars, no las contiene |
| `vercel.json` | Solo configuración de rutas, sin credenciales |
| `supabase/migrations/*.sql` | Solo estructura de tablas, sin datos sensibles |

---

## 📍 Dónde configurar las credenciales reales

### Para deploy en Vercel (producción)
1. Ir a [Vercel Dashboard → mesa-app → Settings → Environment Variables](https://vercel.com/renaxtoggs-projects/mesa-app/settings/environment-variables)
2. Agregar:
   - `SUPABASE_URL` → `https://ocwzupmamfojvdywavqi.supabase.co`
   - `SUPABASE_ANON_KEY` → el anon key de tu proyecto
   - `RESTAURANT_ID` → `00000000-0000-0000-0000-000000000001`
3. Redes → Production, Preview, Development

### Para desarrollo local
1. Copiar `public/config.example.js` → `public/config.js`
2. Llenar con los valores reales
3. `config.js` está en `.gitignore` — nunca se sube

---

## 🗝️ Dónde encontrar las credenciales de Supabase
- **Dashboard:** [supabase.com/dashboard/project/ocwzupmamfojvdywavqi/settings/api](https://supabase.com/dashboard/project/ocwzupmamfojvdywavqi/settings/api)
- **Anon Key:** Settings → API → Project API keys → `anon / public`
- **Service Role Key:** Settings → API → Project API keys → `service_role` (NUNCA al frontend)
