-- ============================================================
-- Mesa App v1.0 — Seed Data
-- Restaurante: La Huaca, Asunción, Paraguay
-- ============================================================

-- ── RESTAURANTE ───────────────────────────────────────────────
INSERT INTO restaurants (id, name, address, phone, instagram, website, logo_initials)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'La Huaca',
  'Av. España 1840, Asunción, Paraguay',
  '+595 21 000 000',
  '@lahuaca.py',
  'lahuaca.com.py',
  'LH'
) ON CONFLICT (id) DO NOTHING;

-- ── MESAS (10 mesas) ─────────────────────────────────────────
INSERT INTO tables (restaurant_id, number, qr_token, capacity) VALUES
  ('00000000-0000-0000-0000-000000000001', 1,  'lahuaca-mesa-1',  4),
  ('00000000-0000-0000-0000-000000000001', 2,  'lahuaca-mesa-2',  4),
  ('00000000-0000-0000-0000-000000000001', 3,  'lahuaca-mesa-3',  6),
  ('00000000-0000-0000-0000-000000000001', 4,  'lahuaca-mesa-4',  4),
  ('00000000-0000-0000-0000-000000000001', 5,  'lahuaca-mesa-5',  2),
  ('00000000-0000-0000-0000-000000000001', 6,  'lahuaca-mesa-6',  4),
  ('00000000-0000-0000-0000-000000000001', 7,  'lahuaca-mesa-7',  8),
  ('00000000-0000-0000-0000-000000000001', 8,  'lahuaca-mesa-8',  4),
  ('00000000-0000-0000-0000-000000000001', 9,  'lahuaca-mesa-9',  6),
  ('00000000-0000-0000-0000-000000000001', 10, 'lahuaca-mesa-10', 4)
ON CONFLICT (restaurant_id, number) DO NOTHING;

-- ── CATEGORÍAS DEL MENÚ ──────────────────────────────────────
INSERT INTO menu_categories (id, restaurant_id, name, sort_order) VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Entrantes',   1),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Hamburguesas',2),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'Lomito',       3),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'Bebidas',      4)
ON CONFLICT (id) DO NOTHING;

-- ── PLATOS DEL MENÚ ──────────────────────────────────────────
-- Entrantes
INSERT INTO menu_items (id, category_id, restaurant_id, name, description, price_guarani, promo_tag, sort_order) VALUES
  (1,  '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   'Empanada de carne',  'Masa crujiente, carne molida, cebolla, huevo duro',        15000, NULL,     1),
  (2,  '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   'Provoleta parrilla', 'Queso provolone, orégano fresco, tomate cherry',            22000, '2×1',   2),
  (3,  '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   'Tabla de fiambres',  'Jamón serrano, salami, queso, aceitunas, tostadas',         38000, NULL,     3),
  (4,  '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   'Sopa paraguaya',     'Torta de maíz, queso Paraguay, cebolla',                   12000, NULL,     4),
-- Hamburguesas
  (5,  '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'Clásica Comanda',    '200g res, lechuga, tomate, cebolla morada, cheddar',        28000, NULL,     1),
  (6,  '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'BBQ Smokey',         '200g, cheddar ahumado, cebolla caramelizada, salsa BBQ',    32000, '−10%',  2),
  (7,  '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'Doble Black',        '2×160g angus, queso americano, brioche negro',              42000, NULL,     3),
  (8,  '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'Veggie',             'Base de poroto negro, aguacate, brotes, tahini',            30000, NULL,     4),
-- Lomito
  (9,  '10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001',
   'Lomito simple',      'Lomo fino, pan casero tostado, lechuga, tomate',            30000, NULL,     1),
  (10, '10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001',
   'Lomito completo',    'Lomo, huevo, jamón, queso, lechuga, tomate, mayo',          38000, NULL,     2),
  (11, '10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001',
   'Lomito americano',   'Lomo, cheddar fundido, bacon, salsa americana',             35000, 'Chef ★', 3),
-- Bebidas
  (12, '10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001',
   'Coca-Cola',          'Lata 350ml bien fría',                                       8000, NULL,     1),
  (13, '10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001',
   'Cerveza Pilsen',     'Botella 500ml importada',                                   15000, '2×1',   2),
  (14, '10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001',
   'Jugo natural',       'Naranja, mango o maracuyá. 400ml al momento',               12000, NULL,     3),
  (15, '10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001',
   'Agua mineral',       '500ml con o sin gas',                                        5000, NULL,     4),
  (16, '10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001',
   'Tereré especial',    'Con hierbas medicinales, limón y menta fresca',             10000, NULL,     5)
ON CONFLICT (id) DO NOTHING;

-- ── EXTRAS POR PLATO ─────────────────────────────────────────
INSERT INTO menu_item_extras (item_id, name, price_guarani) VALUES
  -- Empanada de carne (id=1)
  (1,  'Chimichurri',   2000),
  (1,  'Salsa picante', 1500),
  -- Clásica Comanda (id=5)
  (5,  'Panceta',       5000),
  (5,  'Huevo frito',   3000),
  (5,  'Doble carne',  12000),
  (5,  'Extra queso',   3000),
  -- BBQ Smokey (id=6)
  (6,  'Panceta',       5000),
  (6,  'Jalapeños',     2000),
  -- Doble Black (id=7)
  (7,  'Panceta',       5000),
  (7,  'Huevo frito',   3000),
  -- Lomito simple (id=9)
  (9,  'Huevo frito',   3000),
  (9,  'Jamón',         4000),
  (9,  'Queso',         3000),
  -- Lomito completo (id=10)
  (10, 'Extra carne',  10000),
  (10, 'Panceta',       5000)
ON CONFLICT DO NOTHING;

-- ── CUPÓN DE DESCUENTO ────────────────────────────────────────
-- MESA10 = 10% de descuento en cualquier pedido
INSERT INTO coupons (restaurant_id, code, discount_type, discount_value, min_order_amount, is_active)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'MESA10',
  'percentage',
  10,
  0,
  true
) ON CONFLICT (restaurant_id, code) DO NOTHING;

-- ── VERIFICACIÓN ─────────────────────────────────────────────
-- Ejecutar para confirmar que los datos se insertaron correctamente:
-- SELECT COUNT(*) FROM restaurants;        -- debe ser 1
-- SELECT COUNT(*) FROM tables;             -- debe ser 10
-- SELECT COUNT(*) FROM menu_categories;    -- debe ser 4
-- SELECT COUNT(*) FROM menu_items;         -- debe ser 16
-- SELECT COUNT(*) FROM menu_item_extras;   -- debe ser 15
-- SELECT COUNT(*) FROM coupons;            -- debe ser 1
