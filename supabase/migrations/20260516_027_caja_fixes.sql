-- ═══════════════════════════════════════════════════════════
-- MIGRACIÓN 027 — PANEL CAJA: fix de acceso RLS para cajero
-- Problema: RID se tomaba de config.js en lugar de profile.restaurant_id.
--   En algunos casos el cajero no podía leer orders ni tables.
--   Se agregan/actualizan políticas para garantizar acceso por restaurante
--   a usuarios autenticados con rol cajero, admin o superadmin.
-- EJECUTAR EN SUPABASE SQL EDITOR (dashboard en inglés)
-- ═══════════════════════════════════════════════════════════

-- ─── 1. ORDERS: política de lectura para cajero ───────────
-- Si no existe una política de SELECT para authenticated en orders,
-- nos aseguramos de que el cajero autenticado pueda leer órdenes de su restaurante.
DO $$
BEGIN
  -- Eliminar política vieja si existe con nombre incorrecto para orders select
  DROP POLICY IF EXISTS "cajero_orders_select" ON public.orders;

  CREATE POLICY "cajero_orders_select"
    ON public.orders FOR SELECT
    USING (
      restaurant_id = (
        SELECT restaurant_id FROM public.user_roles
        WHERE user_id = auth.uid() AND is_active = true LIMIT 1
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;

-- ─── 2. ORDERS: política de UPDATE para cajero ────────────
-- Cajero necesita actualizar status (paid→delivered, paid→cancelled, etc.)
DO $$
BEGIN
  DROP POLICY IF EXISTS "cajero_orders_update" ON public.orders;

  CREATE POLICY "cajero_orders_update"
    ON public.orders FOR UPDATE
    USING (
      restaurant_id = (
        SELECT restaurant_id FROM public.user_roles
        WHERE user_id = auth.uid() AND is_active = true LIMIT 1
      )
    )
    WITH CHECK (
      restaurant_id = (
        SELECT restaurant_id FROM public.user_roles
        WHERE user_id = auth.uid() AND is_active = true LIMIT 1
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;

-- ─── 3. ORDERS: política de INSERT para cajero (tomar pedido en POS) ───
DO $$
BEGIN
  DROP POLICY IF EXISTS "cajero_orders_insert" ON public.orders;

  CREATE POLICY "cajero_orders_insert"
    ON public.orders FOR INSERT
    WITH CHECK (
      restaurant_id = (
        SELECT restaurant_id FROM public.user_roles
        WHERE user_id = auth.uid() AND is_active = true LIMIT 1
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;

-- ─── 4. ORDER_ITEMS: lectura y escritura para cajero ──────
DO $$
BEGIN
  DROP POLICY IF EXISTS "cajero_order_items_select" ON public.order_items;
  CREATE POLICY "cajero_order_items_select"
    ON public.order_items FOR SELECT
    USING (
      EXISTS (
        SELECT 1 FROM public.orders o
        WHERE o.id = order_id
          AND o.restaurant_id = (
            SELECT restaurant_id FROM public.user_roles
            WHERE user_id = auth.uid() AND is_active = true LIMIT 1
          )
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;

DO $$
BEGIN
  DROP POLICY IF EXISTS "cajero_order_items_insert" ON public.order_items;
  CREATE POLICY "cajero_order_items_insert"
    ON public.order_items FOR INSERT
    WITH CHECK (
      EXISTS (
        SELECT 1 FROM public.orders o
        WHERE o.id = order_id
          AND o.restaurant_id = (
            SELECT restaurant_id FROM public.user_roles
            WHERE user_id = auth.uid() AND is_active = true LIMIT 1
          )
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;

-- ─── 5. ORDER_ITEM_EXTRAS: lectura y escritura para cajero ─
DO $$
BEGIN
  DROP POLICY IF EXISTS "cajero_order_item_extras_select" ON public.order_item_extras;
  CREATE POLICY "cajero_order_item_extras_select"
    ON public.order_item_extras FOR SELECT
    USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;

DO $$
BEGIN
  DROP POLICY IF EXISTS "cajero_order_item_extras_insert" ON public.order_item_extras;
  CREATE POLICY "cajero_order_item_extras_insert"
    ON public.order_item_extras FOR INSERT
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;

-- ─── 6. ORDER_STATUS_HISTORY: cajero puede insertar ───────
DO $$
BEGIN
  DROP POLICY IF EXISTS "cajero_order_status_history_insert" ON public.order_status_history;
  CREATE POLICY "cajero_order_status_history_insert"
    ON public.order_status_history FOR INSERT
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;

DO $$
BEGIN
  DROP POLICY IF EXISTS "cajero_order_status_history_select" ON public.order_status_history;
  CREATE POLICY "cajero_order_status_history_select"
    ON public.order_status_history FOR SELECT
    USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;

-- ─── 7. TABLES: cajero puede leer mesas de su restaurante ─
DO $$
BEGIN
  DROP POLICY IF EXISTS "cajero_tables_select" ON public.tables;
  CREATE POLICY "cajero_tables_select"
    ON public.tables FOR SELECT
    USING (
      restaurant_id = (
        SELECT restaurant_id FROM public.user_roles
        WHERE user_id = auth.uid() AND is_active = true LIMIT 1
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;

-- ─── 8. CANCELACIONES_CAJA: agregar UPDATE (marcar revisado) ─
DO $$
BEGIN
  DROP POLICY IF EXISTS "cancelaciones_caja_update" ON public.cancelaciones_caja;
  CREATE POLICY "cancelaciones_caja_update"
    ON public.cancelaciones_caja FOR UPDATE
    USING (
      restaurant_id = (
        SELECT restaurant_id FROM public.user_roles
        WHERE user_id = auth.uid() AND is_active = true LIMIT 1
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;

-- ─── 9. QUEJAS_SUGERENCIAS: índice adicional por turno ────
CREATE INDEX IF NOT EXISTS idx_quejas_turno ON public.quejas_sugerencias(turno_id, created_at DESC);

-- ─── 10. MOVIMIENTOS_CAJA: agregar UPDATE ─────────────────
DO $$
BEGIN
  DROP POLICY IF EXISTS "movimientos_caja_update" ON public.movimientos_caja;
  CREATE POLICY "movimientos_caja_update"
    ON public.movimientos_caja FOR UPDATE
    USING (
      restaurant_id = (
        SELECT restaurant_id FROM public.user_roles
        WHERE user_id = auth.uid() AND is_active = true LIMIT 1
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;
