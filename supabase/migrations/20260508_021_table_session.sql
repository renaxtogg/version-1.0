-- ═══════════════════════════════════════════════════════════
-- MIGRACIÓN 021 — ESTADO DE MESA: ocupación explícita
-- Problema: la mesa pasaba a "libre" automáticamente al cobrar
-- Solución: columna is_occupied en tables + trigger de auto-ocupación
-- EJECUTAR EN SUPABASE SQL EDITOR (dashboard en inglés)
-- ═══════════════════════════════════════════════════════════

-- ─── COLUMNAS EN TABLES ───────────────────────────────────
ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS is_occupied BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS occupied_since TIMESTAMPTZ;

-- ─── BACKFILL: marcar como ocupadas las mesas con órdenes activas ──
UPDATE public.tables t
SET
  is_occupied   = true,
  occupied_since = sub.min_created
FROM (
  SELECT table_id, MIN(created_at) AS min_created
  FROM public.orders
  WHERE table_id IS NOT NULL
    AND status IN ('paid', 'kitchen_received', 'cooking', 'ready')
  GROUP BY table_id
) sub
WHERE t.id = sub.table_id;

-- ─── TRIGGER: auto-ocupar mesa al crear una orden ─────────
CREATE OR REPLACE FUNCTION public.fn_occupy_table_on_order()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.table_id IS NOT NULL AND NEW.status != 'cancelled' THEN
    UPDATE public.tables
    SET
      is_occupied   = true,
      occupied_since = COALESCE(occupied_since, NEW.created_at)
    WHERE id = NEW.table_id AND is_occupied = false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_occupy_table ON public.orders;
CREATE TRIGGER trg_occupy_table
  AFTER INSERT ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_occupy_table_on_order();

-- ─── RLS: permitir UPDATE de is_occupied a roles autorizados ──
-- (tables ya tiene RLS; añadimos política de UPDATE explícita)
DROP POLICY IF EXISTS "Staff can update table occupancy" ON public.tables;
CREATE POLICY "Staff can update table occupancy"
  ON public.tables FOR UPDATE
  USING (
    restaurant_id IN (
      SELECT restaurant_id FROM public.user_roles
      WHERE user_id = auth.uid() AND is_active = true
    )
  )
  WITH CHECK (
    restaurant_id IN (
      SELECT restaurant_id FROM public.user_roles
      WHERE user_id = auth.uid() AND is_active = true
    )
  );
