-- ═══════════════════════════════════════════════════════════
-- MIGRACIÓN 074 — QR FUNCIONALES: sesiones de escaneo por mesa
-- Limita accesos al QR según la capacidad de la mesa.
-- El primer escaneo abre la sesión; se cierra al liberar la mesa.
-- EJECUTAR EN SUPABASE SQL EDITOR (dashboard en inglés)
-- ═══════════════════════════════════════════════════════════

-- ─── TABLA DE SESIONES ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.table_scan_sessions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id    UUID        NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
  scan_count  INTEGER     NOT NULL DEFAULT 0,
  max_scans   INTEGER     NOT NULL DEFAULT 4,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_scan_sessions_table_active
  ON public.table_scan_sessions(table_id)
  WHERE ended_at IS NULL;

ALTER TABLE public.table_scan_sessions ENABLE ROW LEVEL SECURITY;

-- Staff puede leer sesiones de su restaurante
CREATE POLICY "Staff read scan sessions" ON public.table_scan_sessions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      JOIN public.tables t ON t.id = table_scan_sessions.table_id
      WHERE ur.user_id = auth.uid()
        AND ur.restaurant_id = t.restaurant_id
        AND ur.is_active = true
    )
  );

-- ─── FUNCIÓN RPC: unirse a una sesión de mesa ─────────────
-- Llamada por clientes anónimos al escanear el QR.
-- Es atómica: crea la sesión si no existe, incrementa el contador,
-- rechaza si la mesa ya está llena.
CREATE OR REPLACE FUNCTION public.join_table_session(p_table_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_cap  INTEGER;
  v_sess RECORD;
  v_count INTEGER;
BEGIN
  SELECT capacity INTO v_cap
  FROM public.tables
  WHERE id = p_table_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', false, 'message', 'Mesa no encontrada');
  END IF;

  v_cap := COALESCE(v_cap, 4);

  -- Buscar sesión activa
  SELECT * INTO v_sess
  FROM public.table_scan_sessions
  WHERE table_id = p_table_id AND ended_at IS NULL
  ORDER BY started_at DESC
  LIMIT 1;

  IF FOUND THEN
    -- Sesión existente: verificar si hay lugar
    IF v_sess.scan_count >= v_sess.max_scans THEN
      RETURN jsonb_build_object(
        'allowed',    false,
        'message',    'Mesa llena',
        'scan_count', v_sess.scan_count,
        'max_scans',  v_sess.max_scans
      );
    END IF;
    -- Hay lugar: incrementar contador
    UPDATE public.table_scan_sessions
    SET scan_count = scan_count + 1
    WHERE id = v_sess.id
    RETURNING scan_count INTO v_count;
  ELSE
    -- Sin sesión activa: crear una nueva y marcar mesa como ocupada
    INSERT INTO public.table_scan_sessions(table_id, scan_count, max_scans)
    VALUES (p_table_id, 1, v_cap)
    RETURNING scan_count INTO v_count;

    UPDATE public.tables
    SET is_occupied = true,
        occupied_since = COALESCE(occupied_since, NOW())
    WHERE id = p_table_id AND is_occupied = false;
  END IF;

  RETURN jsonb_build_object(
    'allowed',    true,
    'scan_count', v_count,
    'max_scans',  v_cap
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.join_table_session(UUID) TO anon, authenticated;

-- ─── TRIGGER: cerrar sesión al liberar la mesa ────────────
CREATE OR REPLACE FUNCTION public.fn_close_scan_session_on_free()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF OLD.is_occupied = true AND NEW.is_occupied = false THEN
    UPDATE public.table_scan_sessions
    SET ended_at = NOW()
    WHERE table_id = NEW.id AND ended_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_close_scan_session ON public.tables;
CREATE TRIGGER trg_close_scan_session
  AFTER UPDATE OF is_occupied ON public.tables
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_close_scan_session_on_free();
