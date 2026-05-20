-- ============================================================
-- 040 — Tabla reservations
-- ============================================================

create table if not exists public.reservations (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete cascade,
  confirm_num    text not null,
  customer_name  text not null,
  customer_phone text not null,
  reservation_date date not null,
  reservation_time time not null,
  guests         int  not null default 2,
  table_id       uuid references public.tables(id) on delete set null,
  occasion       text,          -- birthday | anniversary | business | other
  notes          text,
  status         text not null default 'pending'
                   check (status in ('pending','confirmed','seated','no_show','cancelled')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Índice para consultas por fecha + restaurante
create index if not exists reservations_restaurant_date_idx
  on public.reservations (restaurant_id, reservation_date);

-- RLS
alter table public.reservations enable row level security;

-- Clientes pueden insertar (status pending) sin auth
create policy "reservations_insert_public"
  on public.reservations for insert
  with check (restaurant_id = '00000000-0000-0000-0000-000000000001'::uuid);

-- Staff autenticado puede leer/actualizar/eliminar las de su restaurante
create policy "reservations_staff_all"
  on public.reservations for all
  using (
    restaurant_id = (
      select restaurant_id from public.user_roles
      where user_id = auth.uid()
      limit 1
    )
  );

-- Trigger updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists reservations_updated_at on public.reservations;
create trigger reservations_updated_at
  before update on public.reservations
  for each row execute function public.set_updated_at();
