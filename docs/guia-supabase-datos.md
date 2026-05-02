# Guía: Ver datos y estadísticas en Supabase
## Mesa App v1.0 — La Huaca

---

## 1. Cómo ingresar al panel de Supabase

1. Ir a **[supabase.com/dashboard](https://supabase.com/dashboard)**
2. Iniciar sesión con tu cuenta
3. Seleccionar el proyecto **mesa-app**

El panel tiene tres secciones principales que vas a usar:

| Sección | Icono en la barra lateral | Para qué sirve |
|---|---|---|
| **Table Editor** | Grilla / tabla | Ver y filtrar datos visualmente |
| **SQL Editor** | `< >` | Consultas avanzadas y estadísticas |
| **Replication** | Antena / rayo | Ver tablas con realtime habilitado |

---

## 2. Qué datos se guardan cuando alguien usa la app

Cada vez que un cliente escanea el QR, arma su pedido y paga, se crean registros en estas tablas:

```
orders               ← el pedido principal (mesa, total, estado, método de pago)
  └── order_items    ← cada plato del pedido (nombre, precio, cantidad)
        └── order_item_extras   ← extras elegidos por plato
order_status_history ← historial completo de cambios de estado
ratings              ← calificación 1-5 estrellas al final
waiter_calls         ← llamadas al mozo desde la app
```

Otras tablas con datos de configuración (no cambian con cada pedido):

```
restaurants     ← info del local
tables          ← las mesas con sus tokens QR
menu_categories ← categorías del menú
menu_items      ← platos con precios
menu_item_extras← extras por plato
coupons         ← cupones de descuento (ej: MESA10)
```

---

## 3. Ver datos con el Table Editor (modo visual)

### Ver todos los pedidos

1. Clic en **Table Editor** en la barra lateral
2. Seleccionar la tabla **`orders`**
3. Verás todas las columnas:

| Columna | Qué es |
|---|---|
| `order_number` | Número visible del pedido (ej: T-12345) |
| `table_id` | UUID de la mesa (hacer JOIN con `tables.number` para ver el número) |
| `status` | Estado actual del pedido |
| `subtotal` / `discount_amount` / `total` | Importes en guaraníes (₲) |
| `payment_method` | efectivo / tarjeta / qr / pos |
| `created_at` | Fecha y hora del pedido |

### Estados posibles de un pedido

```
draft            → carrito en construcción (no confirmado)
confirmed        → cliente confirmó el pedido
paid             → pago registrado ← cocina lo ve como "Nuevo"
kitchen_received → cocina lo vio   ← cocina lo ve como "Nuevo"
cooking          → en preparación  ← cocina lo ve como "Preparando"
ready            → listo para llevar a la mesa ← cocina lo ve como "Listo"
delivered        → entregado (archivado)
```

### Filtrar por fecha

En el Table Editor, usar el botón **Filter** → columna `created_at` → `is after` → ingresar la fecha.

### Ver los ítems de un pedido específico

1. Ir a la tabla **`order_items`**
2. Filtrar por `order_id` (el UUID del pedido que te interesa)

---

## 4. Estadísticas con el SQL Editor

Ir a **SQL Editor** en la barra lateral → clic en **New query**.

### 4.1 Pedidos de hoy

```sql
SELECT
  o.order_number,
  t.number          AS mesa,
  o.status,
  o.total,
  o.payment_method,
  o.created_at
FROM orders o
LEFT JOIN tables t ON t.id = o.table_id
WHERE DATE(o.created_at) = CURRENT_DATE
  AND o.status != 'draft'
ORDER BY o.created_at DESC;
```

### 4.2 Resumen del día (ingresos, cantidad de pedidos, ticket promedio)

```sql
SELECT
  COUNT(*)                          AS total_pedidos,
  SUM(total)                        AS ingresos_totales,
  ROUND(AVG(total))                 AS ticket_promedio,
  SUM(discount_amount)              AS descuentos_aplicados,
  COUNT(*) FILTER (WHERE payment_method = 'efectivo') AS pagos_efectivo,
  COUNT(*) FILTER (WHERE payment_method = 'tarjeta')  AS pagos_tarjeta,
  COUNT(*) FILTER (WHERE payment_method = 'qr')       AS pagos_qr
FROM orders
WHERE DATE(created_at) = CURRENT_DATE
  AND status NOT IN ('draft', 'confirmed');
```

### 4.3 Platos más vendidos (todos los tiempos)

```sql
SELECT
  oi.item_name,
  SUM(oi.quantity)                   AS unidades_vendidas,
  SUM(oi.quantity * oi.unit_price)   AS ingresos_generados
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE o.status NOT IN ('draft', 'confirmed')
GROUP BY oi.item_name
ORDER BY unidades_vendidas DESC
LIMIT 10;
```

### 4.4 Platos más vendidos (esta semana)

```sql
SELECT
  oi.item_name,
  SUM(oi.quantity)                     AS unidades,
  SUM(oi.quantity * oi.unit_price)     AS ingresos
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE o.status NOT IN ('draft', 'confirmed')
  AND o.created_at >= date_trunc('week', NOW())
GROUP BY oi.item_name
ORDER BY unidades DESC
LIMIT 10;
```

### 4.5 Ingresos por día (últimos 30 días)

```sql
SELECT
  DATE(created_at)  AS fecha,
  COUNT(*)          AS pedidos,
  SUM(total)        AS ingresos
FROM orders
WHERE status NOT IN ('draft', 'confirmed')
  AND created_at >= NOW() - INTERVAL '30 days'
GROUP BY DATE(created_at)
ORDER BY fecha DESC;
```

### 4.6 Ingresos por semana (últimas 8 semanas)

```sql
SELECT
  DATE_TRUNC('week', created_at) AS semana,
  COUNT(*)                       AS pedidos,
  SUM(total)                     AS ingresos
FROM orders
WHERE status NOT IN ('draft', 'confirmed')
  AND created_at >= NOW() - INTERVAL '8 weeks'
GROUP BY DATE_TRUNC('week', created_at)
ORDER BY semana DESC;
```

### 4.7 Mesa más activa

```sql
SELECT
  t.number     AS mesa,
  COUNT(*)     AS pedidos,
  SUM(o.total) AS ingresos
FROM orders o
LEFT JOIN tables t ON t.id = o.table_id
WHERE o.status NOT IN ('draft', 'confirmed')
GROUP BY t.number
ORDER BY pedidos DESC;
```

### 4.8 Uso de cupones

```sql
SELECT
  coupon_code,
  COUNT(*)              AS veces_usado,
  SUM(discount_amount)  AS ahorro_total_clientes
FROM orders
WHERE coupon_code IS NOT NULL
  AND status NOT IN ('draft', 'confirmed')
GROUP BY coupon_code
ORDER BY veces_usado DESC;
```

### 4.9 Calificaciones de clientes

```sql
SELECT
  ROUND(AVG(stars), 1)               AS promedio,
  COUNT(*)                           AS total_calificaciones,
  COUNT(*) FILTER (WHERE stars = 5)  AS cinco_estrellas,
  COUNT(*) FILTER (WHERE stars = 4)  AS cuatro_estrellas,
  COUNT(*) FILTER (WHERE stars = 3)  AS tres_estrellas,
  COUNT(*) FILTER (WHERE stars <= 2) AS una_dos_estrellas
FROM ratings;
```

### 4.10 Tiempo promedio de preparación (de paid a ready)

```sql
SELECT
  ROUND(
    AVG(
      EXTRACT(EPOCH FROM (ready_at - paid_at)) / 60
    )
  ) AS minutos_promedio_preparacion
FROM (
  SELECT
    o.id,
    MIN(h.changed_at) FILTER (WHERE h.status = 'paid')  AS paid_at,
    MIN(h.changed_at) FILTER (WHERE h.status = 'ready') AS ready_at
  FROM orders o
  JOIN order_status_history h ON h.order_id = o.id
  GROUP BY o.id
) t
WHERE paid_at IS NOT NULL AND ready_at IS NOT NULL;
```

### 4.11 Pedidos completos con sus ítems (vista de ticket)

```sql
SELECT
  o.order_number,
  t.number     AS mesa,
  o.created_at,
  oi.item_name,
  oi.quantity,
  oi.unit_price,
  oi.quantity * oi.unit_price AS subtotal_item
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
LEFT JOIN tables t ON t.id = o.table_id
WHERE o.status NOT IN ('draft', 'confirmed')
ORDER BY o.created_at DESC, oi.item_name;
```

### 4.12 Extras más pedidos

```sql
SELECT
  oie.extra_name,
  COUNT(*)        AS veces_pedido,
  SUM(oie.extra_price * oi.quantity) AS ingresos_extra
FROM order_item_extras oie
JOIN order_items oi ON oi.id = oie.order_item_id
JOIN orders o ON o.id = oi.order_id
WHERE o.status NOT IN ('draft', 'confirmed')
GROUP BY oie.extra_name
ORDER BY veces_pedido DESC;
```

---

## 5. Ver actividad en tiempo real

1. En la barra lateral, ir a **Database** → **Replication**
2. Las tablas con realtime habilitado son:
   - `orders` — cambios de estado (cocina actualizando tickets)
   - `order_status_history` — cada actualización de estado
   - `waiter_calls` — llamadas al mozo

Para una vista rápida en vivo: filtrar la tabla `orders` por `status = 'paid'` en el Table Editor — refrescar la página para ver nuevos pedidos.

---

## 6. Exportar datos a Excel/CSV

Desde el **SQL Editor**, después de correr cualquier consulta:

1. Ver los resultados en la tabla inferior
2. Clic en el botón **Export** (esquina superior derecha de los resultados)
3. Elegir **CSV** — se descarga directamente

Desde el **Table Editor**:

1. Abrir la tabla
2. Clic en el botón **···** (opciones) → **Export to CSV**

---

## 7. Referencia rápida de columnas importantes

### Tabla `orders`

| Columna | Tipo | Descripción |
|---|---|---|
| `order_number` | TEXT | Identificador visible (T-12345) |
| `table_id` | UUID | FK a `tables.id` |
| `status` | TEXT | Estado del pedido |
| `subtotal` | INTEGER | Subtotal en ₲ |
| `discount_amount` | INTEGER | Descuento aplicado en ₲ |
| `total` | INTEGER | Total final en ₲ |
| `payment_method` | TEXT | efectivo/tarjeta/qr/pos |
| `coupon_code` | TEXT | Código de cupón usado |
| `created_at` | TIMESTAMPTZ | Fecha y hora del pedido |

### Tabla `ratings`

| Columna | Tipo | Descripción |
|---|---|---|
| `stars` | INTEGER | Calificación 1-5 |
| `comment` | TEXT | Comentario libre |
| `created_at` | TIMESTAMPTZ | Fecha de la calificación |

### Tabla `order_status_history`

| Columna | Tipo | Descripción |
|---|---|---|
| `order_id` | UUID | FK al pedido |
| `status` | TEXT | Nuevo estado registrado |
| `changed_at` | TIMESTAMPTZ | Momento del cambio |
| `changed_by` | TEXT | customer / kitchen / system |

---

*Mesa App v1.0 — La Huaca, Asunción, Paraguay*
