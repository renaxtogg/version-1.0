-- ============================================================
-- Migración 169: Tamaños/variantes de producto + flag mitad-y-mitad
-- ============================================================
-- Habilita que un mismo producto (ej. "Pizza Mozzarella") tenga varios
-- tamaños con precio distinto (Chica/Mediana/Grande), sin inflar el
-- conteo de menu_items del plan (trigger enforce_menu_item_limit, mig 157).
--
-- Modelo: tabla hija menu_item_variants, espejo del patrón de
-- menu_item_extras (FK item_id → menu_items ON DELETE CASCADE, is_active).
-- El pedido NO referencia la variante: el tamaño se congela en el SNAPSHOT
-- de order_items (item_name "(Grande)" + unit_price del tamaño), igual que
-- hoy con item_name/unit_price. Así el historial sobrevive a ediciones.
--
-- También agrega menu_items.allows_half_and_half (default false), columna
-- reservada para la futura pizza mitad-y-mitad (PR-3); sin efecto hoy.
--
-- Diseño completo: docs/design/menu-variantes-mitad-y-mitad.md
-- ============================================================

BEGIN;

-- ── 1. Tabla de variantes/tamaños ────────────────────────────
CREATE TABLE IF NOT EXISTS public.menu_item_variants (
  id            SERIAL PRIMARY KEY,
  item_id       INTEGER NOT NULL REFERENCES public.menu_items(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,                       -- 'Chica' / 'Mediana' / 'Grande'
  price_guarani INTEGER NOT NULL CHECK (price_guarani > 0),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_default    BOOLEAN NOT NULL DEFAULT false,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_menu_item_variants_item
  ON public.menu_item_variants(item_id);

ALTER TABLE public.menu_item_variants ENABLE ROW LEVEL SECURITY;

-- ── 2. RLS ───────────────────────────────────────────────────
-- Escritura tenant-scoped por el restaurante del ítem padre
-- (mismo patrón que extras_auth_write, mig 104).
DROP POLICY IF EXISTS variants_auth_write ON public.menu_item_variants;
CREATE POLICY variants_auth_write ON public.menu_item_variants
  FOR ALL TO authenticated
  USING     (EXISTS (SELECT 1 FROM public.menu_items mi
                     WHERE mi.id = item_id
                       AND mi.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())))
  WITH CHECK(EXISTS (SELECT 1 FROM public.menu_items mi
                     WHERE mi.id = item_id
                       AND mi.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())));

-- Lectura pública (anon) para que el menú del QR/delivery pueda leer los
-- tamaños (patrón mig 134). anon NUNCA escribe.
DROP POLICY IF EXISTS variants_anon_select ON public.menu_item_variants;
CREATE POLICY variants_anon_select ON public.menu_item_variants
  FOR SELECT TO anon USING (true);

-- ── 3. Grants ────────────────────────────────────────────────
REVOKE INSERT, UPDATE, DELETE ON public.menu_item_variants FROM anon;
GRANT  SELECT                        ON public.menu_item_variants TO anon;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.menu_item_variants TO authenticated;
GRANT  USAGE, SELECT ON SEQUENCE public.menu_item_variants_id_seq TO authenticated;

-- ── 4. Flag para pizza mitad-y-mitad (PR-3; sin efecto hoy) ───
ALTER TABLE public.menu_items
  ADD COLUMN IF NOT EXISTS allows_half_and_half BOOLEAN NOT NULL DEFAULT false;

COMMIT;

-- Recargar el cache de esquema de PostgREST.
NOTIFY pgrst, 'reload schema';

SELECT 'migration 169 applied — menu_item_variants + menu_items.allows_half_and_half' AS status;
