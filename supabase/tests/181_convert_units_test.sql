-- ============================================================
-- TEST (solo lectura) de la migración 181 — conversión de unidades de stock.
-- Correr en el SQL Editor de Supabase DESPUÉS de aplicar la migración 181.
-- Poné el idioma del dashboard en INGLÉS antes de ejecutar.
-- No modifica datos: son puros SELECT sobre public.convert_units.
-- Todas las filas deben dar result = 'PASS'.
-- ============================================================

WITH compatibles(qty, f, t, expected) AS (
  VALUES
    (1000::decimal, 'g'::stock_unit,  'kg'::stock_unit, 1::decimal),   -- 1000 g  = 1 kg
    (2.5,           'kg',             'g',              2500),          -- 2.5 kg  = 2500 g
    (100,           'g',              'kg',             0.1),           -- 100 g   = 0.1 kg  (caso reportado)
    (500,           'ml',             'l',              0.5),           -- 500 ml  = 0.5 L
    (3,             'l',              'ml',             3000),          -- 3 L     = 3000 ml
    (100,           'g',              'g',              100),           -- misma unidad
    (5,             'unit',           'unit',           5),
    (7,             'portion',        'portion',        7),
    (1,             'g',              'kg',             0.001)          -- resolución mínima DECIMAL(12,3)
)
SELECT f AS from_unit, t AS to_unit, qty,
       public.convert_units(qty, f, t) AS got,
       expected,
       CASE WHEN public.convert_units(qty, f, t) = expected THEN 'PASS' ELSE 'FAIL' END AS result
FROM compatibles

UNION ALL

-- Incompatibles (dimensiones distintas) → deben devolver NULL.
SELECT f, t, qty,
       public.convert_units(qty, f, t) AS got,
       NULL::decimal AS expected,
       CASE WHEN public.convert_units(qty, f, t) IS NULL THEN 'PASS' ELSE 'FAIL' END AS result
FROM (VALUES
    (100::decimal, 'g'::stock_unit,   'ml'::stock_unit),  -- masa vs volumen
    (1::decimal,   'unit'::stock_unit,'g'::stock_unit),   -- conteo vs masa
    (1::decimal,   'l'::stock_unit,   'kg'::stock_unit),  -- volumen vs masa
    (2::decimal,   'portion'::stock_unit,'unit'::stock_unit)
) AS inc(qty, f, t)

ORDER BY result DESC, from_unit, to_unit;
