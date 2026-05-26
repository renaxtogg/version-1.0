-- ════════════════════════════════════════════════════════════════════════════
-- Migration 072 — Panel Gerente + Módulo Proveedores
-- ════════════════════════════════════════════════════════════════════════════
-- Crea las tablas que sustentan el panel de Gerente/Supervisor Local
-- y el módulo de Proveedores en Admin. Compatible con multi-restaurante.
--
-- Tablas nuevas:
--   • suppliers              — proveedores del restaurante
--   • supplier_contacts      — contactos múltiples por proveedor
--   • supplier_purchases     — órdenes de compra / facturas a proveedores
--   • shift_logs             — bitácora de turno (notas, traspasos, incidencias)
--   • manager_approvals      — pedidos de autorización al gerente
--   • item_86_list           — productos "no disponibles hoy" (86'd items)
--
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. SUPPLIERS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.suppliers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  ruc             TEXT,
  legal_name      TEXT,
  category        TEXT,                              -- 'bebidas','carnes','verdulería','limpieza','servicios','otros'
  phone           TEXT,
  email           TEXT,
  address         TEXT,
  city            TEXT,
  contact_name    TEXT,                              -- contacto principal (atajo)
  payment_terms   TEXT,                              -- '30 días','contado','15/30/45',etc
  delivery_days   TEXT,                              -- 'lun,mié,vie' o texto libre
  min_order       NUMERIC(14,2),
  notes           TEXT,
  rating          INTEGER CHECK (rating BETWEEN 1 AND 5),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_suppliers_restaurant ON public.suppliers(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_active     ON public.suppliers(restaurant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_suppliers_category   ON public.suppliers(restaurant_id, category);

-- ─── 2. SUPPLIER CONTACTS (varios contactos por proveedor) ─────────────────
CREATE TABLE IF NOT EXISTS public.supplier_contacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id   UUID NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  role          TEXT,                                -- 'ventas','cobranzas','reparto','gerente'
  phone         TEXT,
  email         TEXT,
  is_primary    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supplier_contacts_supplier ON public.supplier_contacts(supplier_id);

-- ─── 3. SUPPLIER PURCHASES (compras / facturas registradas) ────────────────
CREATE TABLE IF NOT EXISTS public.supplier_purchases (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  supplier_id     UUID REFERENCES public.suppliers(id) ON DELETE SET NULL,
  supplier_name   TEXT,                              -- snapshot por si borran el proveedor
  invoice_number  TEXT,
  purchase_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  total           NUMERIC(14,2) NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pendiente'
                    CHECK (status IN ('pendiente','pagada','parcial','anulada')),
  paid_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
  payment_method  TEXT,
  due_date        DATE,
  paid_at         TIMESTAMPTZ,
  items           JSONB DEFAULT '[]',                -- [{nombre,cantidad,unidad,precio_unit,subtotal}]
  notes           TEXT,
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchases_restaurant ON public.supplier_purchases(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier   ON public.supplier_purchases(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchases_status     ON public.supplier_purchases(restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_purchases_date       ON public.supplier_purchases(restaurant_id, purchase_date DESC);

-- ─── 4. SHIFT LOGS (bitácora de turno) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shift_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  log_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  shift_period    TEXT CHECK (shift_period IN ('mañana','tarde','noche','madrugada')),
  category        TEXT NOT NULL DEFAULT 'nota'
                    CHECK (category IN ('nota','incidencia','tarea','traspaso','cliente','personal','equipo','limpieza')),
  priority        TEXT NOT NULL DEFAULT 'normal'
                    CHECK (priority IN ('baja','normal','alta','urgente')),
  title           TEXT NOT NULL,
  description     TEXT,
  is_resolved     BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_note   TEXT,
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shift_logs_restaurant ON public.shift_logs(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_shift_logs_date       ON public.shift_logs(restaurant_id, log_date DESC);
CREATE INDEX IF NOT EXISTS idx_shift_logs_open       ON public.shift_logs(restaurant_id, is_resolved);

-- ─── 5. MANAGER APPROVALS (centro de autorizaciones) ───────────────────────
CREATE TABLE IF NOT EXISTS public.manager_approvals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  turno_id        UUID REFERENCES public.turnos_caja(id) ON DELETE SET NULL,
  request_type    TEXT NOT NULL
                    CHECK (request_type IN (
                      'descuento','cortesia','anulacion_cobro','cancelacion_item',
                      'cierre_diferencia','egreso_mayor','apertura_caja','reapertura_pedido','otro'
                    )),
  amount          NUMERIC(14,2),
  reason          TEXT NOT NULL,
  context         JSONB DEFAULT '{}',                -- libre: {pedido_id, mesa, item_id, descuento_pct...}
  pedido_id       UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pendiente'
                    CHECK (status IN ('pendiente','aprobado','rechazado','cancelado')),
  requested_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_by_name TEXT,
  requested_by_role TEXT,
  resolved_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_by_name TEXT,
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approvals_restaurant ON public.manager_approvals(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_approvals_pending    ON public.manager_approvals(restaurant_id, status) WHERE status='pendiente';
CREATE INDEX IF NOT EXISTS idx_approvals_date       ON public.manager_approvals(restaurant_id, created_at DESC);

-- ─── 6. ITEM 86 LIST (productos no disponibles hoy) ────────────────────────
CREATE TABLE IF NOT EXISTS public.item_86_list (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  menu_item_id    INTEGER REFERENCES public.menu_items(id) ON DELETE CASCADE,
  item_name       TEXT NOT NULL,                     -- snapshot
  reason          TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,     -- false = ya repuesto
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_item86_restaurant ON public.item_86_list(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_item86_active     ON public.item_86_list(restaurant_id, is_active);

-- ─── 7. RLS ────────────────────────────────────────────────────────────────
ALTER TABLE public.suppliers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_contacts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shift_logs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manager_approvals  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_86_list       ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "suppliers_all"          ON public.suppliers;
DROP POLICY IF EXISTS "supplier_contacts_all"  ON public.supplier_contacts;
DROP POLICY IF EXISTS "supplier_purchases_all" ON public.supplier_purchases;
DROP POLICY IF EXISTS "shift_logs_all"         ON public.shift_logs;
DROP POLICY IF EXISTS "manager_approvals_all"  ON public.manager_approvals;
DROP POLICY IF EXISTS "item_86_list_all"       ON public.item_86_list;

CREATE POLICY "suppliers_all"          ON public.suppliers          USING (true) WITH CHECK (true);
CREATE POLICY "supplier_contacts_all"  ON public.supplier_contacts  USING (true) WITH CHECK (true);
CREATE POLICY "supplier_purchases_all" ON public.supplier_purchases USING (true) WITH CHECK (true);
CREATE POLICY "shift_logs_all"         ON public.shift_logs         USING (true) WITH CHECK (true);
CREATE POLICY "manager_approvals_all"  ON public.manager_approvals  USING (true) WITH CHECK (true);
CREATE POLICY "item_86_list_all"       ON public.item_86_list       USING (true) WITH CHECK (true);

-- ─── 8. REALTIME ───────────────────────────────────────────────────────────
DO $$ BEGIN
  PERFORM 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='manager_approvals';
  IF NOT FOUND THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.manager_approvals;
  END IF;
END $$;

DO $$ BEGIN
  PERFORM 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='shift_logs';
  IF NOT FOUND THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.shift_logs;
  END IF;
END $$;

DO $$ BEGIN
  PERFORM 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='item_86_list';
  IF NOT FOUND THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.item_86_list;
  END IF;
END $$;

-- ─── 9. FK ingredients.supplier_id → suppliers ─────────────────────────────
-- (Existía como FK fantasma desde migración 017)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='ingredients') THEN
    BEGIN
      ALTER TABLE public.ingredients
        DROP CONSTRAINT IF EXISTS ingredients_supplier_id_fkey;
      ALTER TABLE public.ingredients
        ADD CONSTRAINT ingredients_supplier_id_fkey
        FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE SET NULL;
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'No se pudo cablear FK ingredients.supplier_id: %', SQLERRM;
    END;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Fin migration 072
-- ════════════════════════════════════════════════════════════════════════════
