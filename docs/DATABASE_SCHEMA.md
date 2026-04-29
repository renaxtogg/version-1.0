# Esquema de la Base de Datos

## Diagrama de relaciones

```
restaurants
    │
    ├── tables (mesas)
    │       └── orders ──────────────────┐
    │                                     │
    ├── menu_categories                   │
    │       └── menu_items               │
    │               └── menu_item_extras  │
    │                                     │
    ├── coupons                           │
    │                                     │
    ├── orders ◄───────────────────────────┘
    │       ├── order_items
    │       │       └── order_item_extras
    │       ├── order_status_history
    │       └── waiter_calls
    │
    └── ratings
```

---

## Tablas

### `restaurants`
Información del local. Un proyecto Supabase puede servir a múltiples restaurantes.

| Columna | Tipo | Descripción |
|---|---|---|
| id | UUID PK | Identificador único |
| name | TEXT | Nombre del restaurante |
| address | TEXT | Dirección |
| phone | TEXT | Teléfono |
| instagram | TEXT | Handle de Instagram |
| website | TEXT | Sitio web |
| logo_initials | TEXT | Iniciales para el logo (ej: LH) |
| timezone | TEXT | Zona horaria (default: America/Asuncion) |
| is_active | BOOLEAN | Si el restaurante está activo |
| created_at | TIMESTAMPTZ | Fecha de creación |

---

### `tables`
Mesas del restaurante. Cada mesa tiene un token único que va en el QR.

| Columna | Tipo | Descripción |
|---|---|---|
| id | UUID PK | Identificador único |
| restaurant_id | UUID FK | Referencia a restaurants |
| number | INTEGER | Número de mesa (1, 2, 3...) |
| qr_token | TEXT UNIQUE | Token del QR (ej: lahuaca-mesa-4) |
| capacity | INTEGER | Capacidad de personas |
| is_active | BOOLEAN | Si la mesa está habilitada |

**Constraint:** UNIQUE(restaurant_id, number)

---

### `menu_categories`
Categorías del menú (Entrantes, Hamburguesas, etc.)

| Columna | Tipo | Descripción |
|---|---|---|
| id | UUID PK | Identificador único |
| restaurant_id | UUID FK | Referencia a restaurants |
| name | TEXT | Nombre de la categoría |
| sort_order | INTEGER | Orden de presentación |
| is_active | BOOLEAN | Si la categoría está activa |

---

### `menu_items`
Platos del menú. Precios en guaraníes enteros (sin decimales).

| Columna | Tipo | Descripción |
|---|---|---|
| id | SERIAL PK | ID numérico autoincremental |
| category_id | UUID FK | Referencia a menu_categories |
| restaurant_id | UUID FK | Referencia a restaurants |
| name | TEXT | Nombre del plato |
| description | TEXT | Descripción |
| price_guarani | INTEGER | Precio en ₲ (ej: 28000) |
| promo_tag | TEXT | Badge de promo: '2×1', '−10%', 'Chef ★', NULL |
| image_url | TEXT | URL de imagen (opcional) |
| is_available | BOOLEAN | Si está disponible para pedir |
| sort_order | INTEGER | Orden dentro de la categoría |

---

### `menu_item_extras`
Ingredientes o extras que se pueden agregar a un plato.

| Columna | Tipo | Descripción |
|---|---|---|
| id | SERIAL PK | ID autoincremental |
| item_id | INTEGER FK | Referencia a menu_items |
| name | TEXT | Nombre del extra (ej: Panceta) |
| price_guarani | INTEGER | Precio adicional en ₲ |

---

### `coupons`
Cupones de descuento.

| Columna | Tipo | Descripción |
|---|---|---|
| id | UUID PK | Identificador único |
| restaurant_id | UUID FK | Referencia a restaurants |
| code | TEXT | Código del cupón (ej: MESA10) |
| discount_type | TEXT | 'percentage' o 'fixed' |
| discount_value | INTEGER | Valor: % o monto fijo en ₲ |
| min_order_amount | INTEGER | Monto mínimo del pedido |
| is_active | BOOLEAN | Si el cupón está activo |
| used_count | INTEGER | Veces usado |
| max_uses | INTEGER | Máximo de usos (NULL = ilimitado) |
| valid_until | TIMESTAMPTZ | Fecha de expiración (NULL = sin límite) |

---

### `orders` ⭐ Tabla principal
Pedido principal. Contiene todos los datos del pedido.

| Columna | Tipo | Descripción |
|---|---|---|
| id | UUID PK | Identificador único |
| restaurant_id | UUID FK | Referencia a restaurants |
| table_id | UUID FK | Referencia a tables (nullable) |
| order_number | TEXT UNIQUE | Número legible (ej: T-2847) |
| order_type | TEXT | 'local' o 'llevar' |
| status | TEXT | Estado actual (ver flow abajo) |
| subtotal | INTEGER | Subtotal antes del descuento (₲) |
| discount_amount | INTEGER | Monto del descuento (₲) |
| coupon_code | TEXT | Código del cupón aplicado |
| total | INTEGER | Total final (₲) |
| payment_method | TEXT | 'efectivo', 'tarjeta', 'qr', 'pos' |
| customer_name | TEXT | Nombre para factura (opcional) |
| customer_ruc | TEXT | RUC o cédula (opcional) |
| customer_email | TEXT | Email para factura electrónica |
| language | TEXT | Idioma del cliente (es/en/pt/de) |
| created_at | TIMESTAMPTZ | Fecha/hora del pedido |
| completed_at | TIMESTAMPTZ | Fecha/hora de entrega |

#### Status flow
```
draft → confirmed → paid → kitchen_received → cooking → ready → delivered
                                 ↓                ↓          ↓
                              "Nuevo"        "Preparando"  "Listo"
                           (en cocina)      (en cocina)  (en cocina)
```

---

### `order_items`
Ítems dentro de un pedido. Los nombres y precios son snapshots del momento del pedido.

| Columna | Tipo | Descripción |
|---|---|---|
| id | UUID PK | Identificador único |
| order_id | UUID FK | Referencia a orders |
| item_id | INTEGER FK | Referencia a menu_items (nullable si el plato se eliminó) |
| item_name | TEXT | Nombre del plato al momento del pedido |
| quantity | INTEGER | Cantidad pedida |
| unit_price | INTEGER | Precio unitario al momento del pedido |
| total_price | INTEGER | quantity × unit_price + extras |
| observations | TEXT | Notas para cocina ("sin mayo", etc.) |

---

### `order_item_extras`
Extras seleccionados por cada ítem del pedido.

| Columna | Tipo | Descripción |
|---|---|---|
| id | UUID PK | Identificador único |
| order_item_id | UUID FK | Referencia a order_items |
| extra_name | TEXT | Nombre del extra (snapshot) |
| extra_price | INTEGER | Precio del extra (snapshot) |

---

### `order_status_history`
Log inmutable de todos los cambios de estado. Solo se inserta, nunca se modifica.

| Columna | Tipo | Descripción |
|---|---|---|
| id | UUID PK | Identificador único |
| order_id | UUID FK | Referencia a orders |
| status | TEXT | Nuevo status |
| changed_at | TIMESTAMPTZ | Timestamp del cambio |
| changed_by | TEXT | 'customer', 'kitchen', 'system' |

---

### `waiter_calls`
Registro de llamadas al mozo desde la app del cliente.

| Columna | Tipo | Descripción |
|---|---|---|
| id | UUID PK | Identificador único |
| restaurant_id | UUID FK | Referencia a restaurants |
| table_id | UUID FK | Mesa que llamó |
| order_id | UUID FK | Pedido asociado (opcional) |
| status | TEXT | 'pending' o 'attended' |
| created_at | TIMESTAMPTZ | Cuándo se llamó |
| attended_at | TIMESTAMPTZ | Cuándo fue atendida |

---

### `ratings`
Calificaciones de los clientes.

| Columna | Tipo | Descripción |
|---|---|---|
| id | UUID PK | Identificador único |
| order_id | UUID FK | Pedido calificado |
| restaurant_id | UUID FK | Restaurante |
| table_id | UUID FK | Mesa |
| stars | INTEGER | 1 a 5 estrellas |
| comment | TEXT | Comentario libre (opcional) |
| created_at | TIMESTAMPTZ | Fecha de la calificación |

---

## Row Level Security (RLS)

| Tabla | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| restaurants | público | — | — | — |
| tables | público | — | — | — |
| menu_categories | público | — | — | — |
| menu_items | público | — | — | — |
| menu_item_extras | público | — | — | — |
| coupons | público | — | — | — |
| orders | público | anónimo | anónimo | — |
| order_items | público | anónimo | — | — |
| order_item_extras | público | anónimo | — | — |
| order_status_history | público | anónimo | — | — |
| waiter_calls | público | anónimo | anónimo | — |
| ratings | público | anónimo | — | — |

> ⚠️ En producción: restringir UPDATE en orders solo a la cocina (service_role o JWT con rol kitchen)

## Tablas con Realtime habilitado
- `orders` — cliente trackea status, cocina recibe nuevos pedidos
- `waiter_calls` — mozo recibe notificaciones
- `order_status_history` — auditoría en tiempo real
