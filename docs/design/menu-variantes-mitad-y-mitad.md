# Diseño: Tamaños/Variantes y Pizza Mitad-y-Mitad en la carta Mythos

> Documento de diseño generado a partir de un análisis del código real (menu_items,
> order_items, RPC create_order, y los 6 paneles Vite). Base de decisiones técnicas:
> order_items guarda SNAPSHOT; DB solo con migración nueva numerada (próxima **169**);
> precio es INTEGER guaraní (sin decimales); RLS tenant-scoped por `restaurant_id`;
> paneles Vite en `src/<panel>/main.jsx`; el precio hoy es **autoritativo en el cliente**
> (create_order hace passthrough, mig 131:90-99).

---

## A. Tamaños / variantes

### A.1 Opciones de modelado

**(i) Tabla nueva `menu_item_variants(id, item_id, name, price_guarani, sort_order, is_active)`**
- Espeja 1:1 el patrón ya existente `menu_item_extras` (schema 001:87-92 + `is_active` de mig 037). El admin ya sabe cargar/editar tablas hijas anidadas (extras: admin/main.jsx:1572-1577 carga, 1618-1625 persiste).
- FK `item_id INTEGER → menu_items(id) ON DELETE CASCADE` (mismo CASCADE que extras, schema:89) → borrar el plato borra sus tamaños, sin huérfanos; el snapshot en pedidos históricos sobrevive por `item_name`/`unit_price`.
- **No infla** `subscription_plans.max_menu_items`: el trigger `enforce_menu_item_limit` (mig 157) cuenta filas de `menu_items` por `restaurant_id`. Los tamaños son filas de otra tabla → no cuentan. Esto es el argumento decisivo contra modelar tamaños como filas separadas de `menu_items`.
- RLS: sin `restaurant_id` propio → policy `EXISTS`-join a `menu_items` como `extras_auth_write` (mig 104:454-471) + `anon_select USING(true)` (patrón mig 134:71-81).

**(ii) Reusar `menu_item_extras` con semántica de "grupo tamaño"** — Cero migración de tabla, pero rompe la semántica: los extras son **multi-selección checkbox** y aditivos; un tamaño es **selección única obligatoria** y **reemplaza** el precio base. Frágil y confuso para reportes. **Descartada.**

**(iii) JSON `sizes jsonb` en `menu_items`** — Una columna, sin FK. Pero: no hay integridad por tamaño, no hay `is_active` por tamaño sin re-parsear, editar en admin es más torpe, y consultar "ventas por tamaño" obliga a parsear JSON. No aporta ventaja real sobre (i).

### A.2 Recomendación: **Opción (i), tabla `menu_item_variants`**

Justificación: (a) reusa el patrón admin de extras casi 1:1 → menos código y riesgo; (b) no toca el trigger de límite de plan (mig 157); (c) `is_active` por tamaño gratis; (d) el snapshot en el pedido no necesita FK a la variante. El precio base del plato pasa a ser el **precio del tamaño por defecto** (no se relaja el CHECK `price_guarani>0`).

### A.3 Migración sketch (169)

```sql
-- 20260711_169_menu_item_variants.sql
CREATE TABLE public.menu_item_variants (
  id            SERIAL PRIMARY KEY,
  item_id       INTEGER NOT NULL REFERENCES public.menu_items(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,                      -- 'Chica' / 'Mediana' / 'Grande'
  price_guarani INTEGER NOT NULL CHECK (price_guarani > 0),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_default    BOOLEAN NOT NULL DEFAULT false,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_menu_item_variants_item ON public.menu_item_variants(item_id);

ALTER TABLE public.menu_item_variants ENABLE ROW LEVEL SECURITY;

-- Escritura tenant-scoped por el ítem padre (patrón extras_auth_write, mig 104:454-471)
CREATE POLICY variants_auth_write ON public.menu_item_variants
  FOR ALL TO authenticated
  USING     (EXISTS (SELECT 1 FROM public.menu_items mi
                     WHERE mi.id = item_id
                       AND mi.restaurant_id IN (SELECT get_my_company_restaurant_ids())))
  WITH CHECK(EXISTS (SELECT 1 FROM public.menu_items mi
                     WHERE mi.id = item_id
                       AND mi.restaurant_id IN (SELECT get_my_company_restaurant_ids())));

-- Lectura anon para el menú del QR (patrón mig 134:71-81)
CREATE POLICY variants_anon_select ON public.menu_item_variants
  FOR SELECT TO anon USING (true);

REVOKE INSERT, UPDATE, DELETE ON public.menu_item_variants FROM anon;
GRANT  SELECT ON public.menu_item_variants TO anon;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.menu_item_variants TO authenticated;
GRANT  USAGE, SELECT ON SEQUENCE menu_item_variants_id_seq TO authenticated;
```

> **Snapshot en order_items:** NO se agrega FK a la variante. Se reutiliza el snapshot existente: `item_name = "Pizza Mozzarella (Grande)"`, `unit_price = precio del tamaño`, `total_price = unit_price*qty`. Opcionalmente, una columna estructurada `variant_label TEXT` en `order_items` (Fase 3) para reportes sin parsear texto. **MVP no la necesita.**

### A.4 UI admin

En `ItemModal` (admin/main.jsx:1551-1749), **debajo del campo PRECIO** (1660-1677), modelando sobre el bloque de extras (1719-1740):
- Estado `const [variants,setVariants]=useState([])` junto a `extras` (admin:1566); carga replicando el `useEffect` de extras (1572-1577).
- Handlers `addVariant/removeVariant/updVariant` copiando 1579-1581.
- Persistencia: en `save()`, tras el insert/update de `menu_items`, **delete-all + re-insert** de variantes como los extras (1618-1625). Aceptable porque el snapshot histórico NO referencia `menu_item_variants.id`.
- `price_guarani` (base) = precio del tamaño `is_default`. Etiquetar el campo PRECIO como "Precio tamaño por defecto".

### A.5 UI cliente

En `ProductModal` (index/main.jsx:842-947 y delivery-cliente/main.jsx:1422-1499):
- Extender `dbLoadMenu` (index:54-75 / delivery:216-233) para traer `menu_item_variants` anidado como `item.variants`.
- Selector de **selección única (radio)** — patrón NUEVO. Default = variante `is_default`. Solo si `item.variants?.length`.
- `basePrice` (index:853) pasa a ser el precio de la variante elegida.

**⚠️ Punto crítico (bug preexistente):** `App.addToCart` (index:2137) y `updateQty` (2145) recalculan `total=(item.price+et)*qty` **ignorando el `basePrice` del modal** — hoy ya pierde el `discount_pct`. **Solución:** enhebrar `unitPrice` y `variant` en la línea del carrito `{item, qty, variant, unitPrice, extras, notes, total}` y recalcular desde `unitPrice`. Mismo fix en delivery (2575-2589). Esto **de paso arregla el bug del descuento.**

### A.6 Snapshot en order_items

En `dbSubmitOrder` (index:113-117 payload RPC + 150-154 insert directo) y su gemelo delivery (281-285 + 336-344):
- `item_name = ci.variant ? \`${ci.item.name} (${ci.variant.name})\` : ci.item.name`
- `unit_price = ci.unitPrice`; `total_price = ci.total`

**No se toca el RPC create_order para tamaños** — ya hace passthrough (mig 131:90-99).

### A.7 Impacto en cocina / mozo / caja / delivery

- **Cocina** (cocina:760): muestra `item.nombre` que ya incluye "(Grande)" → **sin cambios**.
- **Mozo**: muestra `item_name` → bien. Arreglar `adjustItemQty` (mozo:1420-1422) que hace `total_price=unit_price*qty` (borra premium de extras).
- **Caja**: cobro-por-mesa usa `effUnit=total_price/qty` (908,1520) → **ya cuadra**. Cobro clásico + ticket usan `unit_price` (1163,1248; receipt.js:140-145): con variante ahora `unit_price` = precio real → **mejora**.
- **Delivery**: cubierto en A.6.

---

## B. Pizza mitad-y-mitad

### B.1 Modelado (sin romper snapshot ni asumir 1 línea = 1 item_id)

Una pizza mitad-y-mitad es **UNA línea de order_items** (una pizza física). El `item_id` apunta al plato "ancla" (o `NULL`), y los dos sabores viven en el snapshot:

**MVP — sin migración de columnas:** las dos mitades como **order_item_extras** (reutiliza `extra_name`/`extra_price`):
- `item_name = "Pizza mitad y mitad"` (o `"1/2 Napolitana + 1/2 Pepperoni"`)
- `order_item_extras = [{extra_name:"1/2 Napolitana", extra_price:0}, {extra_name:"1/2 Pepperoni", extra_price:0}]`
- `unit_price`/`total_price` = precio combinado según la regla (B.3). Los `extra_price=0` porque el precio ya está resuelto en `unit_price` (evita doble conteo).

Ventaja: **cero cambio de esquema**, cocina ya muestra extras como chips (772-777), histórico sobrevive. Desventaja: reportes "ventas por sabor" requieren parsear texto (aceptable en MVP).

**Primera clase (Fase 3, opcional):** columna `half_breakdown jsonb` en `order_items` → ruteo a 2 estaciones + reportes limpios. Requiere extender RPC create_order. **No en MVP.**

### B.2 Config admin (por producto)

- `menu_items.allows_half_and_half BOOLEAN NOT NULL DEFAULT false` (ya agregada en mig 169).
- **Regla de precio POR PRODUCTO** (decisión del dueño, 2026-07-10): cada producto apto elige su propia regla al editarlo. Columnas nuevas (migración de PR-3):
  - `half_and_half_rule TEXT CHECK (half_and_half_rule IN ('max','avg','sum_halves','fixed'))` — default `'max'`.
  - `half_and_half_fixed_price INTEGER` — solo se usa cuando la regla es `'fixed'` (CHECK `>0` o NULL).
- UI: en `ItemModal` (admin:1700-1710) — checkbox "Apto para mitad-y-mitad"; al tildarlo, aparece un desplegable de regla y (si es `fixed`) un campo de precio. Estado (1553-1565) y payload (1594-1607).
- **Combinabilidad:** sabores combinables = otros `menu_items` de la MISMA `category_id` con `allows_half_and_half=true`. Sin tabla de compatibilidad.
- **Qué regla manda en un combo A+B:** la del producto **ANCLA** (el que el cliente abrió primero y sobre el que arma la mitad-y-mitad). El 2º sabor solo aporta su precio; la regla y el `fixed_price` salen del ancla.

### B.3 REGLA DE PRECIO — configurable por el dueño, por producto

El dueño elige la regla en cada producto apto. Ejemplo: **Napolitana ₲40.000** + **Pepperoni Especial ₲50.000** (mismo tamaño).

| `half_and_half_rule` | Fórmula | Resultado | Nota |
|---|---|---|---|
| `max` — **Mitad más cara** | `max(A, B)` | **₲50.000** | ⭐ Default. Estándar en pizzerías. |
| `avg` — **Promedio** | `round((A+B)/2)` | **₲45.000** | "Justo" percibido. |
| `fixed` — **Precio fijo** | `half_and_half_fixed_price` | **₲48.000** (ej.) | Precio de "combinada" fijo del ancla, sin importar sabores. |

> Redondeo obligatorio con `Math.round` (enteros ₲). La función de precio se encapsula pura: `halfPrice(priceA, priceB, rule, fixed)` → entero.
> **Nota (revisión adversarial 2026-07-10):** se descartó `sum_halves` de la UI (matemáticamente idéntica a `avg`; el CHECK de la DB la sigue aceptando por compat). El `half_and_half_rule='fixed'` requiere precio (validado en admin en ambos niveles). El precio mitad-y-mitad **no** aplica `discount_pct` del producto: lo fija la regla del dueño (aplicar un % sobre un precio de regla/fijo daría mostrado≠cobrado).

### B.4 Interacción con tamaños

- Si el plato tiene variantes: elegir **primero tamaño** (una vez), **luego los dos sabores**.
- La regla de B.3 se aplica sobre el precio de cada sabor **en ese tamaño**.
- Solo se combinan sabores que tengan la variante del mismo `name` ("Grande").

### B.5 UI cliente

En `ProductModal`, cuando `item.allows_half_and_half`: toggle "Pedir mitad y mitad" → (a) selector de tamaño si hay variantes; (b) 1ª mitad = producto abierto; (c) dropdown 2ª mitad = misma categoría + apto. `unitPrice` = regla B.3. Enhebrar en el carrito igual que las variantes.

### B.6 Snapshot, cocina y caja

- **Snapshot**: `item_name="Pizza mitad y mitad (Grande)"`, extras `["1/2 Napolitana","1/2 Pepperoni"]` con `extra_price=0`, `unit_price=75000`.
- **Cocina**: ve nombre + chips → **claro sin cambios**. (Ruteo a 2 estaciones NO en MVP — va a la estación del ancla.)
- **Caja/factura**: imprime `1× Pizza mitad y mitad (Grande) — 75.000`, cuadra con el TOTAL.

---

## C. Plan de implementación por fases (1 feature por PR)

### PR-1 — MVP Tamaños (backend + admin + cliente QR)
- **Migración 169**: `menu_item_variants` (tabla + RLS + grants).
- **admin/main.jsx**: ItemModal — variantes (A.4).
- **index/main.jsx**: `dbLoadMenu` trae `variants`; ProductModal selector radio; **fix crítico** `addToCart`/`updateQty` (A.5); snapshot en `dbSubmitOrder` (A.6).
- **Riesgo**: el fix de addToCart cambia el modelo de carrito → probar flujo cliente→cocina→mozo→caja. Reset DB operativo antes de deploy.
- **Retrocompat**: platos sin variantes → comportamiento idéntico al actual.

### PR-2 — Tamaños en Delivery + ticket 80mm
- **delivery-cliente/main.jsx**: espejar PR-1.
- **public/mythos-receipt.js**: sub-líneas de extras/variante (140-145) usando `total_price` — arregla el descuadre líneas-vs-TOTAL preexistente.
- **Recomendado**: antes de PR-2, extraer ProductModal + modelo de carrito a `src/shared/` para no divergir (hoy QR y delivery están duplicados 1:1).

### PR-3 — MVP Mitad-y-mitad
- **Migración**: `ALTER TABLE menu_items ADD COLUMN allows_half_and_half BOOLEAN NOT NULL DEFAULT false` (puede ir junto a la 169).
- **admin**: checkbox. **index + delivery**: toggle mitad, dropdown 2ª mitad, regla de precio (B.3), snapshot vía order_item_extras (B.1).
- Encapsular la regla en función pura `halfPrice(a,b,rule)`.

### PR-4 (opcional) — Mitad-y-mitad de primera clase
- Columna `half_breakdown jsonb` + ruteo cocina a 2 estaciones + reportes por sabor. Solo si el negocio lo pide.

**Reglas transversales de no-rotura:** ninguna FK nueva desde `order_items` a variantes/sabores; RLS anon solo SELECT, escritura solo authenticated tenant-scoped; el precio sigue autoritativo en cliente (la feature hereda ese riesgo, no lo agrava).

---

## D. Decisiones que necesito del dueño

1. ✅ **RESUELTA (2026-07-10):** la regla de precio es **configurable por producto** (`half_and_half_rule` en `menu_items`, default `max`); manda la regla del producto ancla. Ver B.2/B.3.
2. **¿Tamaño obligatorio** o hay "tamaño por defecto" preseleccionado? (Recomendado: default preseleccionado.)
3. **Alcance de tamaños**: ¿solo pizzas o cualquier categoría? (El diseño soporta cualquiera.)
4. **Sabores combinables**: ¿"misma categoría + apto", o lista explícita de prohibidas? (MVP: misma categoría.)
5. **Mitad-y-mitad con distinto tamaño por sabor**: ¿permitido? (Recomendado NO.)
6. **¿Recargo fijo por combinar** (ej. +₲5.000) además de la regla de precio? Sí/No.
7. **Ruteo a 2 estaciones en cocina** (mitad parrilla/mitad horno): ¿en v1 (obliga PR-4) o alcanza una estación en MVP?
8. **Precio base con variantes**: confirmar que `price_guarani` = precio del tamaño por defecto.

---

**Archivos de enganche principales:** `supabase/migrations/20260711_169_*.sql` (nueva) · `src/admin/main.jsx:1551-1749` · `src/index/main.jsx:54-75,842-947,2133-2146,113-117` · `src/delivery-cliente/main.jsx:216-233,1422-1499,2575-2589,281-285` · `src/cocina/main.jsx:760,772-777` · `src/mozo/main.jsx:1327-1339,1418-1422` · `src/caja/main.jsx:1163,1248,1520` · `public/mythos-receipt.js:140-145` · RPC intacto en `mig 131:90-99` para tamaños.
