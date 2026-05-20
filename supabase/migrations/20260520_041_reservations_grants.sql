-- ============================================================
-- 041 — Permisos tabla reservations
-- ============================================================

-- anon puede insertar reservas (clientes sin login)
grant insert on public.reservations to anon;

-- authenticated (staff) puede leer, insertar, actualizar, eliminar
grant select, insert, update, delete on public.reservations to authenticated;
