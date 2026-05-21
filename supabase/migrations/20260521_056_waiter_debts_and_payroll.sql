-- ============================================================
-- 056 — Sistema de deudas de mozo y ajustes de nómina
-- Tablas nuevas: waiter_debts, staff_payroll_adjustments
-- Columnas nuevas en employee_shifts: totales del turno
-- ============================================================

-- ─── 1. waiter_debts ──────────────────────────────────────
-- Registra cada orden no cobrada al cerrar un turno de mozo.
-- Se genera automáticamente en el flujo "Terminar turno" desde mozo.html.
CREATE TABLE IF NOT EXISTS public.waiter_debts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  waiter_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  waiter_name     text NOT NULL,
  order_id        uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  order_number    text NOT NULL,
  table_number    text,
  amount          numeric(12,0) NOT NULL DEFAULT 0,
  -- pending: sin resolver | paid: el mozo lo pagó | forgiven: el admin lo perdonó | discount_applied: se descontó de nómina
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','paid','forgiven','discount_applied')),
  notes           text,
  shift_end       timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolved_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_waiter_debts_restaurant ON public.waiter_debts(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_waiter_debts_waiter     ON public.waiter_debts(waiter_id);
CREATE INDEX IF NOT EXISTS idx_waiter_debts_status     ON public.waiter_debts(status);
CREATE INDEX IF NOT EXISTS idx_waiter_debts_created    ON public.waiter_debts(created_at);

ALTER TABLE public.waiter_debts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "waiter_debts_all" ON public.waiter_debts
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON public.waiter_debts TO authenticated;
GRANT SELECT ON public.waiter_debts TO anon;


-- ─── 2. staff_payroll_adjustments ─────────────────────────
-- Ajustes de nómina que el administrador gestiona manualmente.
-- Tipos positivos (comision, bono) y negativos (descuento, deuda_cobrada).
CREATE TABLE IF NOT EXISTS public.staff_payroll_adjustments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  employee_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  employee_name   text NOT NULL,
  -- descuento: deducción libre | comision: % sobre ventas | bono: pago extra
  -- deuda_cobrada: cuando el mozo saldó una waiter_debt | otro: libre
  type            text NOT NULL
                    CHECK (type IN ('descuento','comision','bono','deuda_cobrada','otro')),
  concept         text NOT NULL,
  -- positivo = a favor del empleado (comision/bono); negativo = descuento
  amount          numeric(12,0) NOT NULL,
  -- enlace opcional a waiter_debts u otras referencias
  reference_id    uuid,
  reference_type  text,
  -- mes de nómina al que aplica (primer día del mes, ej: 2026-05-01)
  period_month    date,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payroll_adj_restaurant ON public.staff_payroll_adjustments(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_payroll_adj_employee   ON public.staff_payroll_adjustments(employee_id);
CREATE INDEX IF NOT EXISTS idx_payroll_adj_period     ON public.staff_payroll_adjustments(period_month);

ALTER TABLE public.staff_payroll_adjustments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "staff_payroll_adjustments_all" ON public.staff_payroll_adjustments
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_payroll_adjustments TO authenticated;
GRANT SELECT ON public.staff_payroll_adjustments TO anon;


-- ─── 3. employee_shifts — crear si no existe, luego agregar columnas ──
CREATE TABLE IF NOT EXISTS public.employee_shifts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  employee_id   uuid,
  employee_name text,
  role          text,
  clock_in      timestamptz NOT NULL DEFAULT now(),
  clock_out     timestamptz,
  total_sold    numeric(12,0) DEFAULT 0,
  total_debt    numeric(12,0) DEFAULT 0,
  orders_count  integer DEFAULT 0,
  -- 'manual' = mozo eligió cerrar | 'session_expired' = cierre accidental
  closed_by     text DEFAULT 'manual',
  created_at    timestamptz DEFAULT now()
);

-- Por si la tabla ya existía sin estas columnas (migración 033 sí aplicada)
ALTER TABLE public.employee_shifts
  ADD COLUMN IF NOT EXISTS total_sold    numeric(12,0) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_debt    numeric(12,0) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS orders_count  integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS closed_by     text DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS idx_employee_shifts_restaurant ON public.employee_shifts(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_employee_shifts_clock_in   ON public.employee_shifts(clock_in);
CREATE INDEX IF NOT EXISTS idx_employee_shifts_employee   ON public.employee_shifts(employee_id);

ALTER TABLE public.employee_shifts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'employee_shifts' AND policyname = 'employee_shifts_all'
  ) THEN
    CREATE POLICY "employee_shifts_all" ON public.employee_shifts
      USING (true) WITH CHECK (true);
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.employee_shifts TO authenticated;
GRANT SELECT ON public.employee_shifts TO anon;


-- ─── 4. Realtime ──────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE public.waiter_debts;
ALTER PUBLICATION supabase_realtime ADD TABLE public.staff_payroll_adjustments;
