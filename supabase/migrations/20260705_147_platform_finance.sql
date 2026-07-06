-- ════════════════════════════════════════════════════════════════════════
-- 147 · FINANZAS DEL SUPERADMIN (la caja del dueño de la plataforma)
-- ────────────────────────────────────────────────────────────────────────
-- (PREPARED — NOT APPLIED: aplicar manualmente tras backup nuevo, SQL Editor
--  en INGLÉS. Claude Code NO la aplica.)
--
-- Ingresos, egresos, costos recurrentes del sistema y avisos de vencimiento.
-- TODO lo de esta migración es SOLO para el superadmin: tablas con RLS
-- superadmin-only y RPCs SECURITY DEFINER fail-closed (get_my_role()='superadmin').
-- Ningún admin/otro rol debe leer las tablas ni ejecutar las RPC.
--
-- Convención de moneda (heredada, mig 119):
--   • subscription_plans.price_usd y subscriptions.monthly_amount están en ₲
--     (el nombre "usd" es histórico). La MRR NO se convierte con el FX.
--   • El tipo de cambio USD→₲ (platform_config.usd_pyg_rate, default 7500) se
--     usa SOLO para normalizar costos/movimientos cargados en USD.
--
-- 100% ADITIVA: 2 tablas nuevas + 1 fila de config + RPCs nuevas. No toca RLS,
-- columnas ni datos existentes.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1) Costos / servicios recurrentes del sistema ────────────────────────
CREATE TABLE IF NOT EXISTS public.platform_costs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  provider      text,
  category      text,
  amount        numeric(14,2) NOT NULL DEFAULT 0,
  currency      text NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','PYG')),
  cycle         text NOT NULL DEFAULT 'monthly' CHECK (cycle IN ('monthly','annual','one_time')),
  next_due_date date,
  auto_renew    boolean NOT NULL DEFAULT true,
  active        boolean NOT NULL DEFAULT true,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ── 2) Movimientos manuales de la caja del superadmin ────────────────────
CREATE TABLE IF NOT EXISTS public.platform_finance_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type        text NOT NULL CHECK (type IN ('income','expense')),
  concept     text NOT NULL,
  amount      numeric(14,2) NOT NULL DEFAULT 0,
  currency    text NOT NULL DEFAULT 'PYG' CHECK (currency IN ('USD','PYG')),
  entry_date  date NOT NULL DEFAULT CURRENT_DATE,
  category    text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_costs_active_due
  ON public.platform_costs (active, next_due_date);
CREATE INDEX IF NOT EXISTS idx_platform_finance_entries_date
  ON public.platform_finance_entries (entry_date);

-- ── 3) RLS: SOLO superadmin (defensa en profundidad; las RPC igual bypassan) ─
ALTER TABLE public.platform_costs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_finance_entries  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "platform_costs_superadmin_all"           ON public.platform_costs;
DROP POLICY IF EXISTS "platform_finance_entries_superadmin_all" ON public.platform_finance_entries;

CREATE POLICY "platform_costs_superadmin_all"
  ON public.platform_costs FOR ALL
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

CREATE POLICY "platform_finance_entries_superadmin_all"
  ON public.platform_finance_entries FOR ALL
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- anon nunca; authenticated pasa por RLS (solo superadmin ve algo).
REVOKE ALL ON public.platform_costs            FROM anon;
REVOKE ALL ON public.platform_finance_entries  FROM anon;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.platform_costs           TO authenticated;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.platform_finance_entries TO authenticated;

-- ── 4) Tipo de cambio USD→₲ configurable (reusa platform_config) ─────────
INSERT INTO public.platform_config (key, value, updated_at)
VALUES ('usd_pyg_rate', '7500', now())
ON CONFLICT (key) DO NOTHING;

-- ── 5) Helpers internos ──────────────────────────────────────────────────
-- Guarda fail-closed reutilizable por todas las RPC.
CREATE OR REPLACE FUNCTION public._pf_assert_superadmin()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.get_my_role() IS DISTINCT FROM 'superadmin' THEN
    RAISE EXCEPTION 'forbidden: solo el superadmin' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._pf_usd_rate()
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    NULLIF((SELECT value FROM public.platform_config WHERE key = 'usd_pyg_rate'), '')::numeric,
    7500
  );
$$;

-- ── 6) RPC: fijar el tipo de cambio ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.superadmin_set_usd_rate(p_rate numeric)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._pf_assert_superadmin();
  IF p_rate IS NULL OR p_rate <= 0 THEN
    RAISE EXCEPTION 'tipo de cambio inválido' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.platform_config (key, value, updated_at)
  VALUES ('usd_pyg_rate', p_rate::text, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  RETURN p_rate;
END;
$$;

-- ── 7) RPC: listar costos ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.platform_costs_list()
RETURNS SETOF public.platform_costs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._pf_assert_superadmin();
  RETURN QUERY
    SELECT * FROM public.platform_costs
    ORDER BY active DESC,
             (next_due_date IS NULL),          -- con fecha primero
             next_due_date ASC NULLS LAST,
             name ASC;
END;
$$;

-- ── 8) RPC: crear/editar costo (upsert por id) ───────────────────────────
CREATE OR REPLACE FUNCTION public.platform_cost_upsert(
  p_id            uuid,
  p_name          text,
  p_provider      text,
  p_category      text,
  p_amount        numeric,
  p_currency      text,
  p_cycle         text,
  p_next_due_date date,
  p_auto_renew    boolean,
  p_active        boolean,
  p_notes         text
)
RETURNS public.platform_costs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.platform_costs;
BEGIN
  PERFORM public._pf_assert_superadmin();
  IF COALESCE(btrim(p_name), '') = '' THEN
    RAISE EXCEPTION 'el nombre es obligatorio' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_currency,'USD') NOT IN ('USD','PYG') THEN
    RAISE EXCEPTION 'moneda inválida' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_cycle,'monthly') NOT IN ('monthly','annual','one_time') THEN
    RAISE EXCEPTION 'ciclo inválido' USING ERRCODE = '22023';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.platform_costs
      (name, provider, category, amount, currency, cycle, next_due_date, auto_renew, active, notes)
    VALUES
      (btrim(p_name), NULLIF(btrim(p_provider),''), NULLIF(btrim(p_category),''),
       COALESCE(p_amount,0), COALESCE(p_currency,'USD'), COALESCE(p_cycle,'monthly'),
       p_next_due_date, COALESCE(p_auto_renew,true), COALESCE(p_active,true),
       NULLIF(btrim(p_notes),''))
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.platform_costs SET
      name          = btrim(p_name),
      provider      = NULLIF(btrim(p_provider),''),
      category      = NULLIF(btrim(p_category),''),
      amount        = COALESCE(p_amount,0),
      currency      = COALESCE(p_currency,'USD'),
      cycle         = COALESCE(p_cycle,'monthly'),
      next_due_date = p_next_due_date,
      auto_renew    = COALESCE(p_auto_renew,true),
      active        = COALESCE(p_active,true),
      notes         = NULLIF(btrim(p_notes),''),
      updated_at    = now()
    WHERE id = p_id
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'costo inexistente' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  RETURN v_row;
END;
$$;

-- ── 9) RPC: eliminar costo ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.platform_cost_delete(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._pf_assert_superadmin();
  DELETE FROM public.platform_costs WHERE id = p_id;
END;
$$;

-- ── 10) RPC: marcar como pagado / renovado ───────────────────────────────
-- Registra un egreso con el monto y la fecha de hoy, y avanza next_due_date un
-- ciclo (monthly=+1 mes, annual=+1 año; one_time desactiva el costo).
CREATE OR REPLACE FUNCTION public.platform_cost_mark_paid(p_id uuid)
RETURNS public.platform_costs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cost public.platform_costs;
BEGIN
  PERFORM public._pf_assert_superadmin();

  SELECT * INTO v_cost FROM public.platform_costs WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'costo inexistente' USING ERRCODE = 'P0002';
  END IF;

  -- Egreso en la moneda ORIGINAL del costo (el summary lo normaliza a ₲).
  INSERT INTO public.platform_finance_entries
    (type, concept, amount, currency, entry_date, category, notes)
  VALUES
    ('expense',
     'Pago/renovación: ' || v_cost.name || COALESCE(' ('||v_cost.provider||')',''),
     v_cost.amount, v_cost.currency, CURRENT_DATE,
     COALESCE(v_cost.category, 'costo_sistema'),
     'Registrado automáticamente al marcar el costo como pagado');

  -- Avanzar el vencimiento un ciclo.
  IF v_cost.cycle = 'monthly' THEN
    UPDATE public.platform_costs
       SET next_due_date = (COALESCE(next_due_date, CURRENT_DATE) + interval '1 month')::date,
           updated_at = now()
     WHERE id = p_id RETURNING * INTO v_cost;
  ELSIF v_cost.cycle = 'annual' THEN
    UPDATE public.platform_costs
       SET next_due_date = (COALESCE(next_due_date, CURRENT_DATE) + interval '1 year')::date,
           updated_at = now()
     WHERE id = p_id RETURNING * INTO v_cost;
  ELSE   -- one_time: se cumplió, se desactiva
    UPDATE public.platform_costs
       SET active = false, updated_at = now()
     WHERE id = p_id RETURNING * INTO v_cost;
  END IF;

  RETURN v_cost;
END;
$$;

-- ── 11) RPC: listar movimientos (opcional por mes 'YYYY-MM') ──────────────
CREATE OR REPLACE FUNCTION public.platform_finance_entries_list(p_month text DEFAULT NULL)
RETURNS SETOF public.platform_finance_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start date;
BEGIN
  PERFORM public._pf_assert_superadmin();
  IF p_month IS NULL OR btrim(p_month) = '' THEN
    RETURN QUERY
      SELECT * FROM public.platform_finance_entries
      ORDER BY entry_date DESC, created_at DESC;
  ELSE
    v_start := to_date(p_month || '-01', 'YYYY-MM-DD');
    RETURN QUERY
      SELECT * FROM public.platform_finance_entries
      WHERE entry_date >= v_start
        AND entry_date <  (v_start + interval '1 month')::date
      ORDER BY entry_date DESC, created_at DESC;
  END IF;
END;
$$;

-- ── 12) RPC: crear movimiento manual ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.platform_finance_entry_create(
  p_type       text,
  p_concept    text,
  p_amount     numeric,
  p_currency   text,
  p_entry_date date,
  p_category   text,
  p_notes      text
)
RETURNS public.platform_finance_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.platform_finance_entries;
BEGIN
  PERFORM public._pf_assert_superadmin();
  IF COALESCE(p_type,'') NOT IN ('income','expense') THEN
    RAISE EXCEPTION 'tipo inválido' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(btrim(p_concept),'') = '' THEN
    RAISE EXCEPTION 'el concepto es obligatorio' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_currency,'PYG') NOT IN ('USD','PYG') THEN
    RAISE EXCEPTION 'moneda inválida' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.platform_finance_entries
    (type, concept, amount, currency, entry_date, category, notes)
  VALUES
    (p_type, btrim(p_concept), COALESCE(p_amount,0), COALESCE(p_currency,'PYG'),
     COALESCE(p_entry_date, CURRENT_DATE), NULLIF(btrim(p_category),''),
     NULLIF(btrim(p_notes),''))
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- ── 13) RPC: eliminar movimiento ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.platform_finance_entry_delete(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._pf_assert_superadmin();
  DELETE FROM public.platform_finance_entries WHERE id = p_id;
END;
$$;

-- ── 14) RPC: resumen financiero ──────────────────────────────────────────
-- Todo normalizado a ₲. MRR = suscripciones activas (monthly_amount ya en ₲).
-- Costos mensuales = costos activos, anual/12, USD→₲ con el tipo de cambio.
CREATE OR REPLACE FUNCTION public.platform_finance_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rate          numeric;
  v_mrr           numeric;
  v_costs_monthly numeric;
  v_income_month  numeric;
  v_expense_month numeric;
  v_month_start   date := date_trunc('month', CURRENT_DATE)::date;
  v_upcoming      jsonb;
BEGIN
  PERFORM public._pf_assert_superadmin();
  v_rate := public._pf_usd_rate();

  -- MRR (₲): snapshot congelado de la suscripción, fallback al precio del plan.
  SELECT COALESCE(SUM(COALESCE(s.monthly_amount, sp.price_usd, 0)), 0)
    INTO v_mrr
    FROM public.subscriptions s
    LEFT JOIN public.subscription_plans sp ON sp.id = s.plan_id
   WHERE s.status = 'active';

  -- Costos mensuales normalizados (₲).
  SELECT COALESCE(SUM(
           (CASE WHEN currency = 'USD' THEN amount * v_rate ELSE amount END)
           * CASE cycle WHEN 'monthly' THEN 1.0
                        WHEN 'annual'  THEN 1.0/12
                        ELSE 0 END
         ), 0)
    INTO v_costs_monthly
    FROM public.platform_costs
   WHERE active = true;

  -- Ingresos / egresos manuales del mes en curso (₲).
  SELECT
    COALESCE(SUM(CASE WHEN type='income'
                      THEN (CASE WHEN currency='USD' THEN amount*v_rate ELSE amount END) END), 0),
    COALESCE(SUM(CASE WHEN type='expense'
                      THEN (CASE WHEN currency='USD' THEN amount*v_rate ELSE amount END) END), 0)
    INTO v_income_month, v_expense_month
    FROM public.platform_finance_entries
   WHERE entry_date >= v_month_start
     AND entry_date <  (v_month_start + interval '1 month')::date;

  -- Próximos vencimientos (activos con fecha), ordenados por cercanía.
  SELECT COALESCE(jsonb_agg(s.obj ORDER BY s.nd ASC), '[]'::jsonb)
    INTO v_upcoming
    FROM (
      SELECT jsonb_build_object(
               'id',             id,
               'name',           name,
               'provider',       provider,
               'amount',         amount,
               'currency',       currency,
               'cycle',          cycle,
               'next_due_date',  next_due_date,
               'days_remaining', (next_due_date - CURRENT_DATE),
               'amount_pyg',     (CASE WHEN currency='USD' THEN amount*v_rate ELSE amount END)
             ) AS obj,
             next_due_date AS nd
        FROM public.platform_costs
       WHERE active = true AND next_due_date IS NOT NULL
    ) AS s;

  RETURN jsonb_build_object(
    'usd_pyg_rate',       v_rate,
    'mrr_pyg',            round(v_mrr),
    'monthly_costs_pyg',  round(v_costs_monthly),
    'margin_pyg',         round(v_mrr - v_costs_monthly),
    'income_month_pyg',   round(v_income_month),
    'expense_month_pyg',  round(v_expense_month),
    'month',              to_char(v_month_start, 'YYYY-MM'),
    'upcoming',           v_upcoming
  );
END;
$$;

-- ── 15) Permisos de ejecución: fail-closed (nunca PUBLIC/anon) ───────────
REVOKE ALL ON FUNCTION public._pf_assert_superadmin()                         FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._pf_usd_rate()                                  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.superadmin_set_usd_rate(numeric)                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_costs_list()                          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_cost_upsert(uuid,text,text,text,numeric,text,text,date,boolean,boolean,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_cost_delete(uuid)                      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_cost_mark_paid(uuid)                   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_finance_entries_list(text)            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_finance_entry_create(text,text,numeric,text,date,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_finance_entry_delete(uuid)            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_finance_summary()                     FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.superadmin_set_usd_rate(numeric)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_costs_list()                       TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_cost_upsert(uuid,text,text,text,numeric,text,text,date,boolean,boolean,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_cost_delete(uuid)                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_cost_mark_paid(uuid)                TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_finance_entries_list(text)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_finance_entry_create(text,text,numeric,text,date,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_finance_entry_delete(uuid)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_finance_summary()                  TO authenticated;
-- _pf_assert_superadmin / _pf_usd_rate son helpers internos: sin GRANT a nadie
-- (solo los llaman las otras funciones DEFINER, que corren como owner).

-- ── 16) SEED idempotente (solo si la tabla está vacía) ───────────────────
INSERT INTO public.platform_costs (name, provider, category, amount, currency, cycle, next_due_date, auto_renew, active, notes)
SELECT v.name, v.provider, v.category, v.amount, v.currency, v.cycle, v.next_due_date, v.auto_renew, true, v.notes
  FROM (VALUES
    ('Vercel Pro',           'Vercel',       'hosting', 20::numeric, 'USD', 'monthly',  NULL::date, true,  'activar cuando pase a plan Pro con clientes'),
    ('Supabase Pro',         'Supabase',     'backend', 25::numeric, 'USD', 'monthly',  NULL::date, true,  'producción con clientes reales'),
    ('Crédito Google Cloud', 'Google',       'infra',    0::numeric, 'USD', 'one_time', NULL::date, false, 'crédito de USD 300 con fecha de fin; confirmar next_due_date'),
    ('Dominio',              'Registrador',  'dominio',  0::numeric, 'USD', 'annual',   NULL::date, true,  'cargar cuando compre el dominio propio')
  ) AS v(name, provider, category, amount, currency, cycle, next_due_date, auto_renew, notes)
 WHERE NOT EXISTS (SELECT 1 FROM public.platform_costs);

COMMIT;

-- Recargar el cache de esquema de PostgREST (nuevas tablas/RPC visibles).
NOTIFY pgrst, 'reload schema';

SELECT 'migration 147 applied — platform finance (costs, entries, summary, seed)' AS status;
