-- ═══════════════════════════════════════════════════════════
-- MIGRACIÓN 026 — PANEL MOZO: fixes de RLS y estado de mesas
-- Problema: el anon key no podía UPDATE tables (is_occupied),
--   y el trigger solo ocupaba mesas con is_occupied=false.
-- EJECUTAR EN SUPABASE SQL EDITOR (dashboard en inglés)
-- ═══════════════════════════════════════════════════════════

-- ─── 1. REEMPLAZAR POLÍTICA DE UPDATE EN TABLES ──────────
-- La política de migración 021 requería user_roles → el anon key
-- (mozo, cliente) no podía actualizar is_occupied ni occupied_since.
-- Para este prototipo abrimos UPDATE a todos con anon key.
DROP POLICY IF EXISTS "Staff can update table occupancy" ON public.tables;
DROP POLICY IF EXISTS "update_tables"                   ON public.tables;

CREATE POLICY "update_tables"
  ON public.tables FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- ─── 2. TRIGGER: también liberar mesa cuando se actualiza a delivered ──
-- El trigger original solo actuaba en INSERT. Agregamos uno para UPDATE
-- que libera la mesa cuando todas las órdenes activas están delivered.
CREATE OR REPLACE FUNCTION public.fn_auto_release_table_on_delivered()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Si la orden pasó a delivered/cancelled y table_id no es null
  IF NEW.table_id IS NOT NULL
     AND NEW.status IN ('delivered', 'cancelled')
     AND OLD.status NOT IN ('delivered', 'cancelled')
  THEN
    -- Verificar si quedan órdenes activas para esta mesa
    IF NOT EXISTS (
      SELECT 1 FROM public.orders
      WHERE table_id = NEW.table_id
        AND status NOT IN ('delivered', 'cancelled')
        AND id != NEW.id
    ) THEN
      -- No quedan órdenes activas → liberar mesa
      UPDATE public.tables
        SET is_occupied = false, occupied_since = NULL
      WHERE id = NEW.table_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_release_table_on_delivered ON public.orders;
CREATE TRIGGER trg_release_table_on_delivered
  AFTER UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_auto_release_table_on_delivered();

-- ─── 3. TRIGGER INSERT: también actuar si la mesa ya está ocupada ──
-- El trigger original tenía WHERE is_occupied = false, así que si la mesa
-- ya estaba ocupada no se re-ocupaba. Ajustamos para setear occupied_since
-- si es la primera orden de la sesión.
CREATE OR REPLACE FUNCTION public.fn_occupy_table_on_order()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.table_id IS NOT NULL AND NEW.status != 'cancelled' THEN
    UPDATE public.tables
    SET
      is_occupied   = true,
      occupied_since = COALESCE(occupied_since, NEW.created_at)
    WHERE id = NEW.table_id;
  END IF;
  RETURN NEW;
END;
$$;

-- El trigger ya existe; DROP+CREATE para reemplazar la función
DROP TRIGGER IF EXISTS trg_occupy_table ON public.orders;
CREATE TRIGGER trg_occupy_table
  AFTER INSERT ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_occupy_table_on_order();

-- ─── 4. BACKFILL: sincronizar is_occupied con órdenes activas reales ──
-- Marcar como ocupadas las mesas con órdenes no finalizadas
UPDATE public.tables t
SET is_occupied = true,
    occupied_since = COALESCE(t.occupied_since, sub.min_created)
FROM (
  SELECT table_id, MIN(created_at) AS min_created
  FROM public.orders
  WHERE table_id IS NOT NULL
    AND status NOT IN ('delivered', 'cancelled')
  GROUP BY table_id
) sub
WHERE t.id = sub.table_id;

-- Liberar mesas sin órdenes activas
UPDATE public.tables t
SET is_occupied = false, occupied_since = NULL
WHERE t.is_occupied = true
  AND NOT EXISTS (
    SELECT 1 FROM public.orders
    WHERE table_id = t.id
      AND status NOT IN ('delivered', 'cancelled')
  );
