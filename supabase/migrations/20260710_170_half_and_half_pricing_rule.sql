-- ============================================================
-- Migración 170: Regla de precio de pizza mitad-y-mitad
-- ============================================================
-- La pizza mitad-y-mitad combina dos sabores en una sola pizza. Cuando
-- los sabores tienen precios distintos, hay que resolver qué se cobra.
-- La regla es DECISIÓN DEL DUEÑO y se define a dos niveles:
--
--   • restaurants.half_and_half_rule  → regla POR DEFECTO del local.
--   • menu_items.half_and_half_rule   → override POR PRODUCTO (NULL = heredar
--                                        la del restaurante).
--
-- Reglas: 'max' (mitad más cara — default), 'avg' (promedio),
--         'sum_halves' (suma de medios) y 'fixed' (precio fijo, usa el
--         *_fixed_price correspondiente). En un combo A+B manda la regla
--         del producto ANCLA (el que el cliente abrió primero).
--
-- allows_half_and_half (marca de "apto") ya se agregó en la migración 169.
-- Diseño: docs/design/menu-variantes-mitad-y-mitad.md §B
-- ============================================================

BEGIN;

-- ── 1. Regla por defecto del restaurante ─────────────────────
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS half_and_half_rule TEXT NOT NULL DEFAULT 'max'
    CHECK (half_and_half_rule IN ('max','avg','sum_halves','fixed')),
  ADD COLUMN IF NOT EXISTS half_and_half_fixed_price INTEGER
    CHECK (half_and_half_fixed_price IS NULL OR half_and_half_fixed_price > 0);

-- ── 2. Override por producto (NULL = heredar del restaurante) ─
ALTER TABLE public.menu_items
  ADD COLUMN IF NOT EXISTS half_and_half_rule TEXT
    CHECK (half_and_half_rule IN ('max','avg','sum_halves','fixed')),
  ADD COLUMN IF NOT EXISTS half_and_half_fixed_price INTEGER
    CHECK (half_and_half_fixed_price IS NULL OR half_and_half_fixed_price > 0);

-- ── 3. Lectura anon de las columnas nuevas ───────────────────
-- restaurants tiene SELECT por-columna para anon (mig 102): sin este GRANT
-- explícito, el cliente (anon) NO podría leer la regla por defecto del local.
GRANT SELECT (half_and_half_rule, half_and_half_fixed_price)
  ON public.restaurants TO anon;

-- menu_items: grant defensivo (si el SELECT de anon fuese por-columna).
-- Incluye allows_half_and_half (mig 169) que el cliente empieza a leer ahora.
GRANT SELECT (allows_half_and_half, half_and_half_rule, half_and_half_fixed_price)
  ON public.menu_items TO anon;

COMMIT;

-- Recargar el cache de esquema de PostgREST.
NOTIFY pgrst, 'reload schema';

SELECT 'migration 170 applied — half_and_half_rule en restaurants + menu_items' AS status;
