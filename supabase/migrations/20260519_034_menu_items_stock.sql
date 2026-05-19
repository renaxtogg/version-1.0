-- Migración 034: campos stock_min y stock en menu_items

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS stock_min  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stock      integer DEFAULT NULL;

-- campo unit_cost en ingredients si no existe
ALTER TABLE ingredients
  ADD COLUMN IF NOT EXISTS unit_cost  numeric(14,2) DEFAULT NULL;
