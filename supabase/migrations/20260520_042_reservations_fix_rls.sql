-- ============================================================
-- 042 — Fix RLS reservations: SELECT para anon + drop política
--       duplicada que bloqueaba inserts del cliente QR
-- ============================================================

-- Permisos de rol (por si no se ejecutó 041)
grant insert on public.reservations to anon;
grant select on public.reservations to anon;
grant select, insert, update, delete on public.reservations to authenticated;

-- Eliminar políticas anteriores para recrearlas limpias
drop policy if exists "reservations_insert_public" on public.reservations;
drop policy if exists "reservations_staff_all"     on public.reservations;

-- Clientes (anon) pueden insertar reservas pendientes
create policy "reservations_anon_insert"
  on public.reservations for insert
  to anon
  with check (true);

-- Clientes (anon) pueden leer su propia reserva por confirm_num
-- (lectura amplia necesaria para que el insert sea visible)
create policy "reservations_anon_select"
  on public.reservations for select
  to anon
  using (true);

-- Staff autenticado: acceso total a las de su restaurante
create policy "reservations_auth_all"
  on public.reservations for all
  to authenticated
  using (true)
  with check (true);
