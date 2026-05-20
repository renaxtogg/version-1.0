-- ============================================================
-- 043 — Campos de promo y descuento en menu_items
-- ============================================================

-- Tipo de promo estructurado (corrida, libre, etc.)
alter table public.menu_items
  add column if not exists promo_type text
    check (promo_type in ('pizza_corrida','hamburgesa_corrida','tenedor_libre','sushi_libre','bebida_libre','other'));

-- Porcentaje de descuento (0 = sin descuento)
alter table public.menu_items
  add column if not exists discount_pct smallint not null default 0
    check (discount_pct >= 0 and discount_pct <= 100);

-- Solo consumo en local (no disponible para delivery)
alter table public.menu_items
  add column if not exists dine_in_only boolean not null default false;

-- Grants para roles anon y authenticated
grant select on public.menu_items to anon, authenticated;
