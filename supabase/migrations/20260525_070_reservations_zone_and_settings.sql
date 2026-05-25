-- ============================================================
-- 070 — Reservas: zona preferida + ventana configurable
-- ============================================================

-- Zona preferida cuando el cliente elige zona pero no mesa específica
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS preferred_zone text;

-- Comentario orientativo: zona compatible con tables.zona
-- valores típicos: salon | terraza | bar | privado | exterior

-- Settings por restaurante: ventana en horas para "bloquear" mesa
-- y minutos de anticipación para alertar mozo si la mesa sigue ocupada
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS reservation_window_hours numeric NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS reservation_alert_minutes int     NOT NULL DEFAULT 30;

-- Índice para query por (restaurant, fecha, status) — usado por mozo/caja/admin
CREATE INDEX IF NOT EXISTS reservations_restaurant_date_status_idx
  ON public.reservations (restaurant_id, reservation_date, status);
