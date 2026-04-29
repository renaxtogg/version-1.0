# Guía de Deploy en Vercel

## Prerequisitos
- Node.js 18+ instalado
- GitHub CLI (`gh`) instalado y autenticado
- Vercel CLI instalado: `npm install -g vercel`
- Supabase configurado (ver SUPABASE_SETUP.md)

## Deploy inicial

### 1. Instalar Vercel CLI (si no está instalado)
```bash
npm install -g vercel
```

### 2. Login en Vercel
```bash
vercel login
```
Seleccionar "Continue with GitHub" y seguir el flujo en el browser.

### 3. Deploy
```bash
cd "c:\Users\mancu\OneDrive\Desktop\version 1.0"
vercel --prod
```
Seguir las instrucciones:
- Set up and deploy: `Y`
- Which scope: seleccionar tu cuenta
- Link to existing project: `N`
- Project name: `mesa-app` (o el que prefieras)
- Directory: `.` (directorio actual)

### 4. Configurar variables de entorno en Vercel

Opción A — Dashboard:
1. Ir a [vercel.com/dashboard](https://vercel.com/dashboard)
2. Seleccionar el proyecto `mesa-app`
3. Settings > Environment Variables
4. Agregar:
   - `SUPABASE_URL` = `https://TU_PROJECT_ID.supabase.co`
   - `SUPABASE_ANON_KEY` = `eyJ...`

Opción B — CLI:
```bash
vercel env add SUPABASE_URL
vercel env add SUPABASE_ANON_KEY
```

> ⚠️ Nota: Las variables de entorno en Vercel son para el servidor, pero esta app es 100% estática. Las credenciales de Supabase se cargan desde `public/config.js` que NO está en git. Para producción ver "Opción serverless" abajo.

### 5. Crear config.js para el deploy
Para que el deploy de Vercel incluya las credenciales de Supabase, tienes dos opciones:

**Opción simple (para MVP/desarrollo):**
Editar `public/config.js` con las credenciales reales antes de hacer deploy.
> ⚠️ config.js está en .gitignore, así que debes copiarlo manualmente antes del deploy o usar las instrucciones de abajo.

**Opción recomendada para producción:**
Crear un script de build que genere config.js desde las env vars:
```bash
# build.sh
echo "window.SUPABASE_CONFIG = { url: '$SUPABASE_URL', anonKey: '$SUPABASE_ANON_KEY', restaurantId: '00000000-0000-0000-0000-000000000001' };" > public/config.js
```

## Verificar el deploy

1. Abrir la URL del deploy (ej: https://mesa-app.vercel.app)
2. Verificar que el menú carga desde Supabase
3. Abrir https://mesa-app.vercel.app/cocina
4. Verificar que el KDS carga

## Re-deploy automático

Una vez configurado, cada `git push` a la rama `main` triggerea un re-deploy automático en Vercel.

```bash
git add .
git commit -m "descripción del cambio"
git push origin main
# Vercel despliega automáticamente en ~30 segundos
```

## Dominios personalizados

En Vercel Dashboard > Project > Settings > Domains:
- Agregar `menu.lahuaca.com.py` o cualquier dominio propio
- Configurar DNS según las instrucciones de Vercel

## URLs importantes

| URL | Descripción |
|---|---|
| `/` o `/index.html` | App del cliente |
| `/cocina` | KDS de cocina |

## Troubleshooting

### El menú no carga en producción
- Verificar que `public/config.js` tiene las credenciales correctas en el deploy
- Revisar los logs en Vercel Dashboard > Deployments > Functions

### 404 en /cocina
- Verificar que `vercel.json` tiene el rewrite configurado
- Verificar que `public/cocina.html` existe en el repo

### Cambios no se ven
- Forzar re-deploy: `vercel --prod --force`
- O desde el Dashboard: Deployments > "..." > Redeploy
