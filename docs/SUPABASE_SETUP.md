# Guía de Configuración Supabase

## Paso 1: Crear el proyecto en Supabase

1. Ir a [https://supabase.com](https://supabase.com) y crear una cuenta (gratuita)
2. Click en **"New project"**
3. Nombre: `mesa-app` (o el que prefieras)
4. Contraseña de base de datos: guardar en lugar seguro
5. Región: `South America (São Paulo)` — más cercana a Paraguay
6. Click en **"Create new project"** y esperar ~2 minutos

## Paso 2: Obtener las credenciales

1. En el dashboard del proyecto, ir a **Settings > API**
2. Copiar:
   - **Project URL** → `https://ABCDEFGH.supabase.co`
   - **anon / public key** → `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`

## Paso 3: Ejecutar el schema SQL

### Opción A: Desde el SQL Editor (recomendado)

1. En el dashboard ir a **SQL Editor** (ícono de código en el menú izquierdo)
2. Click en **"New query"**
3. Copiar y pegar todo el contenido de `supabase/migrations/20260429_001_schema.sql`
4. Click en **"Run"** — debe mostrar "Success. No rows returned"
5. Crear otra query nueva
6. Copiar y pegar todo el contenido de `supabase/migrations/20260429_002_seed.sql`
7. Click en **"Run"** — debe insertar los datos de La Huaca

### Verificación
Ejecutar en el SQL Editor:
```sql
SELECT COUNT(*) as count, 'restaurants' as tabla FROM restaurants
UNION ALL SELECT COUNT(*), 'tables' FROM tables
UNION ALL SELECT COUNT(*), 'menu_items' FROM menu_items
UNION ALL SELECT COUNT(*), 'coupons' FROM coupons;
```
Resultados esperados: restaurants=1, tables=10, menu_items=16, coupons=1

## Paso 4: Habilitar Realtime

1. Ir a **Database > Replication** en el dashboard
2. Verificar que las siguientes tablas están en la publicación `supabase_realtime`:
   - `orders`
   - `waiter_calls`
   - `order_status_history`
3. Si no están, ejecutar en SQL Editor:
```sql
ALTER PUBLICATION supabase_realtime ADD TABLE orders;
ALTER PUBLICATION supabase_realtime ADD TABLE waiter_calls;
ALTER PUBLICATION supabase_realtime ADD TABLE order_status_history;
```

## Paso 5: Configurar las credenciales

### Para producción (Vercel) — método recomendado
Las credenciales se inyectan desde las variables de entorno de Vercel en el build.
Nunca tocan el repositorio ni quedan en el código fuente.

Ver: **SENSITIVE_DATA.md** para entender el modelo de seguridad completo.

### Para desarrollo local únicamente
```bash
cp public/config.example.js public/config.js
# Editar public/config.js con los valores reales
# Este archivo está en .gitignore — nunca se sube a GitHub
```

## Paso 6: Verificar la conexión

1. Abrir `public/index.html` en el browser
2. La app debe cargar el menú desde Supabase (si no hay error en console)
3. Abrir las DevTools (F12) > Console — no debe haber errores rojos

## Paso 7: Ver los datos en el dashboard

Cuando un cliente haga un pedido, ver los datos en:

**Supabase Dashboard > Table Editor > orders**

O en el **SQL Editor**:
```sql
-- Ver últimos pedidos
SELECT 
  o.order_number,
  o.status,
  o.total,
  o.payment_method,
  o.created_at,
  COUNT(oi.id) as items
FROM orders o
LEFT JOIN order_items oi ON oi.order_id = o.id
GROUP BY o.id
ORDER BY o.created_at DESC
LIMIT 20;

-- Ver pedido completo con ítems
SELECT 
  o.order_number,
  oi.item_name,
  oi.quantity,
  oi.total_price,
  oi.observations,
  STRING_AGG(oie.extra_name, ', ') as extras
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
LEFT JOIN order_item_extras oie ON oie.order_item_id = oi.id
WHERE o.order_number = 'T-12345'  -- reemplazar con el número real
GROUP BY o.order_number, oi.id
ORDER BY oi.created_at;
```

## Configurar para Vercel (producción)

Ver [DEPLOYMENT.md](DEPLOYMENT.md) para agregar las variables de entorno en Vercel.

## Troubleshooting

### "Failed to fetch" en la app
- Verificar que SUPABASE_URL y anonKey en config.js son correctos
- Verificar que el proyecto Supabase está activo (no pausado por inactividad)

### Menú no carga
- Verificar que el seed data se ejecutó correctamente
- Verificar RLS: las políticas `read_menu_items` y `read_menu_categories` deben existir

### Realtime no funciona
- Verificar que las tablas están en la publicación `supabase_realtime`
- El plan gratuito de Supabase soporta hasta 200 conexiones simultáneas

### Cupón no valida
- El cupón de demo es `MESA10`
- La validación tiene fallback offline: si Supabase no responde, acepta `MESA10` igualmente
