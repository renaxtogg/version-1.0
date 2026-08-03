-- ════════════════════════════════════════════════════════════════════
-- 199 · supplier_billing_tiers_storefront — El marketplace de proveedores
--       pasa de "todo gratis para siempre" a un negocio que cobra y cuyos
--       planes se distinguen de verdad.
-- ────────────────────────────────────────────────────────────────────
-- Cierra los 6 agujeros detectados en la auditoría del circuito de proveedores
-- (2026-08-03). Los tres primeros son de PLATA; los otros tres, de producto.
--
--   A) EL TRIAL NUNCA VENCÍA. resolve_supplier_entitlement (mig 178) habilitaba
--      con `status IN ('trial','active')` y NO miraba `trial_ends_at`: un
--      proveedor aprobado operaba gratis de por vida y no aparecía en ninguna
--      métrica de ingresos. Ahora el entitlement mira la FECHA (con gracia,
--      igual que los restaurantes en la mig 193) y hay cron que mueve a
--      `past_due` y, pasada la gracia, PAUSA la tienda (reversible).
--
--   B) NO HABÍA DÓNDE COBRAR. Nace `marketplace_supplier_payments` (espejo de
--      `payments`, mig 028) + `superadmin_register_supplier_payment` (registra
--      el cobro, extiende el período y reactiva la tienda auto-pausada, ATÓMICO)
--      + `superadmin_supplier_billing_overview` (MRR y vencimientos agregados
--      SERVER-SIDE — el panel carga con `.limit()`, agrupar ahí mentiría cuanto
--      más crezca el negocio; misma lección que la mig 197 en el CRM).
--
--   C) LA VIDRIERA PÚBLICA NO SE PODÍA ACTUALIZAR. El trigger de la mig 179 solo
--      dispara al escribir `marketing_supplier_plans`, y esa tabla no tiene
--      editor en ningún panel: cambiar el precio en Proveedores › Planes dejaba
--      /proveedores mostrando el precio VIEJO, sin forma de arreglarlo sin SQL.
--      Ahora el operativo EMPUJA a la vidriera (trigger AFTER en el operativo),
--      así "gana el panel" en los dos sentidos.
--
--   D) LOS TIERS NO SE DISTINGUÍAN. `max_categorias`, `max_zonas`,
--      `max_catalog_files`, `featured_slots` y `branding_banner` se editaban en
--      el superadmin y NO los leía nadie: el plan Básico podía marcar las 16
--      categorías, subir banner y catálogos ilimitados. O sea, Premium (₲349.000)
--      no entregaba nada que Básico (₲99.000) no diera. Ahora cada uno tiene su
--      trigger, en la DB (lección M10: el tope vive en un trigger, no en el
--      cliente, o la API lo saltea).
--
--   E) "1 ESPACIO DESTACADO" NO EXISTÍA. Nace `marketplace_products.destacado`:
--      el proveedor elige QUÉ producto destaca, hasta `featured_slots`. Además
--      `marketplace_suppliers.destacado` (editorial de Mythos) queda gateado por
--      el plan: no se puede destacar a quien no lo paga.
--
--   F) LA VITRINA NO TENÍA PORTADA. `marketplace_storefront()` devuelve
--      destacados, novedades y categorías CON CONTEO en una sola llamada
--      agregada server-side, para que Explorar abra como una tienda y no como
--      un directorio vacío hasta que buscás algo.
--
-- ⚠️ CONSECUENCIA AL APLICAR (leer antes de correr):
--    · Todo proveedor cuyo trial YA venció quedaría cortado en el acto. Para no
--      cortarle el servicio a nadie sin aviso, el punto 1.8 hace UN backfill
--      (una sola vez, marcado con un evento) que reabre 30 días de trial a las
--      suscripciones vencidas. Los proveedores SIN suscripción (los de QA de las
--      migs 142/177) siguen en el piso fail-closed, como ya estaban.
--    · Los proveedores que hoy exceden el cupo de su plan (categorías, zonas,
--      catálogos) NO se tocan: los triggers solo actúan cuando el valor CAMBIA y
--      EMPEORA. Bajar de 5 a 4 categorías estando en un plan de 3 se permite
--      (acercarse al límite nunca se bloquea); subir a 6, no.
--
-- PREPARED — NOT APPLIED: aplicar A MANO en el SQL Editor (idioma en INGLÉS)
--   tras backup, DESPUÉS de la 177/178/179. Idempotente (re-ejecutable).
-- Revertir (en orden inverso — primero consumidores, después el resolver):
--   DROP FUNCTION public.marketplace_storefront();
--   DROP TRIGGER trg_sync_mkt_supplier_plan_push ON public.marketplace_supplier_plans;
--   DROP FUNCTION public.sync_marketing_supplier_plan_push();
--   DROP TRIGGER trg_enforce_supplier_featured ON public.marketplace_products;
--   DROP FUNCTION public.enforce_supplier_featured_limit();
--   DROP TRIGGER trg_enforce_supplier_catalog_files ON public.marketplace_catalog_files;
--   DROP FUNCTION public.enforce_supplier_catalog_file_limit();
--   DROP TRIGGER trg_enforce_supplier_profile ON public.marketplace_suppliers;
--   DROP FUNCTION public.enforce_supplier_profile_limits();
--   DROP FUNCTION public.superadmin_supplier_billing_overview();
--   DROP FUNCTION public.superadmin_register_supplier_payment(uuid,bigint,int,text,text,text);
--   DROP FUNCTION public.expire_supplier_trials();
--   DROP FUNCTION public.supplier_grace_days(uuid);
--   DROP TABLE public.marketplace_supplier_payments;
--   -- restaurar resolve_supplier_entitlement a la versión de la mig 178
--   ALTER TABLE public.marketplace_products ADD/DROP COLUMN destacado;  -- según convenga
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- 1. CICLO DE COBRO DEL PROVEEDOR
-- ════════════════════════════════════════════════════════════════════

-- 1.1 Gracia: default por plan + override por suscripción (espeja mig 193).
ALTER TABLE public.marketplace_supplier_plans
  ADD COLUMN IF NOT EXISTS grace_days int NOT NULL DEFAULT 5;

ALTER TABLE public.marketplace_supplier_subscriptions
  ADD COLUMN IF NOT EXISTS grace_days int;

-- Marca de la pausa AUTOMÁTICA por mora. Sirve para dos cosas: (a) reactivar
-- sola la tienda al registrar el pago, y (b) impedir que el proveedor se
-- auto-reactive desde su panel (el guard de la mig 142 permite activo↔pausado).
ALTER TABLE public.marketplace_supplier_subscriptions
  ADD COLUMN IF NOT EXISTS auto_paused_at timestamptz;

COMMENT ON COLUMN public.marketplace_supplier_plans.grace_days IS
  'Días de gracia tras vencer el período/trial antes de cortar el servicio.';
COMMENT ON COLUMN public.marketplace_supplier_subscriptions.auto_paused_at IS
  'Si no es NULL, la tienda fue pausada automáticamente por mora (no por el proveedor).';

-- 1.2 Pagos del proveedor (espejo de public.payments, mig 028, pero en ₲ enteros).
CREATE TABLE IF NOT EXISTS public.marketplace_supplier_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id     uuid NOT NULL REFERENCES public.marketplace_suppliers(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES public.marketplace_supplier_subscriptions(id) ON DELETE SET NULL,
  plan_slug       text,
  amount_gs       bigint NOT NULL,
  months          int NOT NULL DEFAULT 1,
  method          text NOT NULL DEFAULT 'transferencia'
                    CHECK (method IN ('transferencia','efectivo','tarjeta','qr','manual','otro')),
  status          text NOT NULL DEFAULT 'paid'
                    CHECK (status IN ('paid','pending','failed','refunded')),
  reference       text,
  notes           text,
  period_start    timestamptz,
  period_end      timestamptz,
  paid_at         timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mkp_supplier_payments_supplier
  ON public.marketplace_supplier_payments (supplier_id, paid_at DESC);

-- RLS fail-closed: anon CERO; el proveedor LEE sus pagos (transparencia de su
-- cuenta); solo el superadmin escribe (y la escritura real pasa por la RPC).
ALTER TABLE public.marketplace_supplier_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketplace_supplier_payments FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketplace_supplier_payments TO authenticated;

DROP POLICY IF EXISTS "mkp_supplier_payments_supplier_select" ON public.marketplace_supplier_payments;
CREATE POLICY "mkp_supplier_payments_supplier_select" ON public.marketplace_supplier_payments
  FOR SELECT TO authenticated
  USING (supplier_id = public.get_my_supplier_id());

DROP POLICY IF EXISTS "mkp_supplier_payments_superadmin_all" ON public.marketplace_supplier_payments;
CREATE POLICY "mkp_supplier_payments_superadmin_all" ON public.marketplace_supplier_payments
  FOR ALL TO authenticated
  USING      (COALESCE(public.get_my_role() = 'superadmin', false))
  WITH CHECK (COALESCE(public.get_my_role() = 'superadmin', false));

-- 1.3 Gracia efectiva de un proveedor (override de la sub → default del plan → 5).
CREATE OR REPLACE FUNCTION public.supplier_grace_days(p_supplier_id uuid)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT COALESCE(s.grace_days, p.grace_days, 5)
    FROM public.marketplace_supplier_subscriptions s
    LEFT JOIN public.marketplace_supplier_plans p ON p.slug = s.plan_slug
   WHERE s.supplier_id = p_supplier_id
   LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.supplier_grace_days(uuid) FROM PUBLIC, anon;

-- 1.4 RESOLVER CANÓNICO v2 — ahora mira la FECHA, no solo el status.
-- Reemplaza la versión de la mig 178. Sigue siendo la ÚNICA fuente de límites
-- efectivos (triggers + get_supplier_capabilities leen de acá).
-- Habilita si:
--   · trial     → trial_ends_at NULL o dentro de (vencimiento + gracia)
--   · active    → current_period_end NULL o dentro de (vencimiento + gracia)
--   · past_due  → dentro de (current_period_end/trial_ends_at + gracia)
--   · el resto (cancelled/suspended) → piso fail-closed.
-- Agrega meta para que el panel NO recalcule nada (misma filosofía que mig 193):
--   expires_on · days_left (negativo = vencido) · in_grace · locked.
CREATE OR REPLACE FUNCTION public.resolve_supplier_entitlement(p_supplier_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_limits  jsonb;
  v_slug    text;
  v_status  text;
  v_trial   timestamptz;
  v_period  timestamptz;
  v_paused  timestamptz;
  v_grace   int;
  v_expires timestamptz;
  v_days    int;
  v_ok      boolean := false;
  v_grace_on boolean := false;
  v_floor   jsonb := jsonb_build_object(
    'max_products', 0, 'max_users', 0, 'max_catalog_files', 0,
    'max_categorias', 0, 'max_zonas', 0, 'featured_slots', 0,
    'lead_contact', 'oculto', 'lead_priority', false,
    'analytics', 'none', 'branding_banner', false
  );
  v_meta_null jsonb := jsonb_build_object(
    'plan_slug', NULL, 'status', NULL, 'entitled', false, 'trial_ends_at', NULL,
    'current_period_end', NULL, 'expires_on', NULL, 'days_left', NULL,
    'in_grace', false, 'locked', true, 'auto_paused', false, 'grace_days', NULL
  );
BEGIN
  IF p_supplier_id IS NULL THEN
    RETURN v_floor || v_meta_null;
  END IF;

  SELECT p.limits, p.slug, s.status, s.trial_ends_at, s.current_period_end,
         s.auto_paused_at, COALESCE(s.grace_days, p.grace_days, 5)
    INTO v_limits, v_slug, v_status, v_trial, v_period, v_paused, v_grace
    FROM public.marketplace_supplier_subscriptions s
    JOIN public.marketplace_supplier_plans p ON p.slug = s.plan_slug
   WHERE s.supplier_id = p_supplier_id
   LIMIT 1;

  IF v_limits IS NULL THEN
    -- Sin suscripción: piso fail-closed (idéntico a la mig 178).
    RETURN v_floor || v_meta_null;
  END IF;

  -- Fecha de corte según el estado del ciclo.
  v_expires := CASE
                 WHEN v_status = 'trial' THEN v_trial
                 ELSE COALESCE(v_period, v_trial)
               END;

  IF v_status IN ('trial','active','past_due') THEN
    IF v_expires IS NULL THEN
      v_ok := true;                                    -- sin fecha = sin corte
    ELSIF v_expires >= now() THEN
      v_ok := true;                                    -- al día
    ELSIF v_expires >= now() - make_interval(days => v_grace) THEN
      v_ok := true;  v_grace_on := true;               -- vencido pero en gracia
    END IF;
  END IF;

  v_days := CASE WHEN v_expires IS NULL THEN NULL
                 ELSE EXTRACT(day FROM date_trunc('day', v_expires) - date_trunc('day', now()))::int END;

  IF NOT v_ok THEN
    RETURN v_floor || jsonb_build_object(
      'plan_slug', v_slug, 'status', v_status, 'entitled', false,
      'trial_ends_at', v_trial, 'current_period_end', v_period,
      'expires_on', v_expires, 'days_left', v_days,
      'in_grace', false, 'locked', true,
      'auto_paused', v_paused IS NOT NULL, 'grace_days', v_grace);
  END IF;

  RETURN v_limits || jsonb_build_object(
    'plan_slug', v_slug, 'status', v_status, 'entitled', true,
    'trial_ends_at', v_trial, 'current_period_end', v_period,
    'expires_on', v_expires, 'days_left', v_days,
    'in_grace', v_grace_on, 'locked', false,
    'auto_paused', v_paused IS NOT NULL, 'grace_days', v_grace);
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_supplier_entitlement(uuid) FROM PUBLIC, anon;

-- get_supplier_capabilities sigue siendo el wrapper delgado de la mig 178 (misma
-- firma y forma) — se recrea acá solo para dejarlo explícito tras el cambio.
CREATE OR REPLACE FUNCTION public.get_supplier_capabilities()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT public.resolve_supplier_entitlement(public.get_my_supplier_id());
$$;
REVOKE ALL    ON FUNCTION public.get_supplier_capabilities() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_supplier_capabilities() TO authenticated;

-- 1.5 Cron: vencer trials/períodos y, pasada la gracia, PAUSAR la tienda.
-- Idempotente: solo actúa sobre lo que todavía no movió. Pausa 'pausado' (no
-- 'suspendido': suspender es sanción de Mythos, esto es mora y se revierte sola
-- al cobrar).
CREATE OR REPLACE FUNCTION public.expire_supplier_trials()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_past_due int := 0;
  v_paused   int := 0;
  r          record;
BEGIN
  -- (a) trial/active vencidos → past_due (la gracia se evalúa en el resolver).
  WITH moved AS (
    UPDATE public.marketplace_supplier_subscriptions s
       SET status = 'past_due', updated_at = now()
     WHERE s.status IN ('trial','active')
       AND COALESCE(
             CASE WHEN s.status = 'trial' THEN s.trial_ends_at
                  ELSE COALESCE(s.current_period_end, s.trial_ends_at) END,
             'infinity'::timestamptz) < now()
    RETURNING s.id
  )
  SELECT count(*) INTO v_past_due FROM moved;

  -- (b) past_due con la gracia agotada → pausar la tienda (una sola vez).
  FOR r IN
    SELECT s.supplier_id, s.id AS sub_id
      FROM public.marketplace_supplier_subscriptions s
      JOIN public.marketplace_supplier_plans p ON p.slug = s.plan_slug
      JOIN public.marketplace_suppliers sup ON sup.id = s.supplier_id
     WHERE s.status = 'past_due'
       AND s.auto_paused_at IS NULL
       AND sup.estado = 'activo'
       AND COALESCE(s.current_period_end, s.trial_ends_at) IS NOT NULL
       AND COALESCE(s.current_period_end, s.trial_ends_at)
             < now() - make_interval(days => COALESCE(s.grace_days, p.grace_days, 5))
  LOOP
    UPDATE public.marketplace_suppliers SET estado = 'pausado' WHERE id = r.supplier_id;
    UPDATE public.marketplace_supplier_subscriptions SET auto_paused_at = now(), updated_at = now()
     WHERE id = r.sub_id;
    INSERT INTO public.marketplace_events (event_type, supplier_id, metadata)
    VALUES ('supplier_auto_paused', r.supplier_id, jsonb_build_object('reason', 'impago'));
    v_paused := v_paused + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'past_due', v_past_due, 'paused', v_paused, 'ran_at', now());
END;
$$;
REVOKE ALL ON FUNCTION public.expire_supplier_trials() FROM PUBLIC, anon, authenticated;

-- 1.6 Registrar un cobro (única vía de escritura de pagos).
-- ATÓMICO: asienta el pago + extiende el período + reactiva la tienda si estaba
-- auto-pausada + audita. El período nuevo arranca del vencimiento vigente si aún
-- no pasó (no se regala tiempo ni se pierde el remanente pagado).
CREATE OR REPLACE FUNCTION public.superadmin_register_supplier_payment(
  p_supplier_id uuid,
  p_amount_gs   bigint DEFAULT NULL,
  p_months      int    DEFAULT 1,
  p_method      text   DEFAULT 'transferencia',
  p_reference   text   DEFAULT NULL,
  p_notes       text   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_sub    record;
  v_plan   record;
  v_months int := GREATEST(1, COALESCE(p_months, 1));
  v_amount bigint;
  v_from   timestamptz;
  v_to     timestamptz;
  v_pay_id uuid;
  v_react  boolean := false;
BEGIN
  IF NOT COALESCE(public.get_my_role() = 'superadmin', false) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_supplier_id IS NULL THEN
    RAISE EXCEPTION 'proveedor requerido' USING ERRCODE = '22023';
  END IF;
  IF p_method IS NOT NULL AND p_method NOT IN ('transferencia','efectivo','tarjeta','qr','manual','otro') THEN
    RAISE EXCEPTION 'método de pago inválido' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_sub FROM public.marketplace_supplier_subscriptions WHERE supplier_id = p_supplier_id;
  IF v_sub.id IS NULL THEN
    RAISE EXCEPTION 'el proveedor no tiene suscripción: asignale un plan primero' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_plan FROM public.marketplace_supplier_plans WHERE slug = v_sub.plan_slug;

  v_amount := COALESCE(p_amount_gs, v_sub.monthly_amount, v_plan.price_gs, 0) ;
  IF v_amount < 0 THEN
    RAISE EXCEPTION 'monto inválido' USING ERRCODE = '22023';
  END IF;

  -- Arranca del vencimiento vigente si todavía no pasó; si ya pasó, de hoy.
  v_from := GREATEST(now(), COALESCE(v_sub.current_period_end, v_sub.trial_ends_at, now()));
  v_to   := v_from + make_interval(months => v_months);

  INSERT INTO public.marketplace_supplier_payments (
    supplier_id, subscription_id, plan_slug, amount_gs, months, method,
    status, reference, notes, period_start, period_end, created_by
  ) VALUES (
    p_supplier_id, v_sub.id, v_sub.plan_slug, v_amount, v_months,
    COALESCE(p_method,'transferencia'), 'paid',
    left(NULLIF(btrim(COALESCE(p_reference,'')),''), 120),
    left(NULLIF(btrim(COALESCE(p_notes,'')),''), 1000),
    v_from, v_to, auth.uid()
  ) RETURNING id INTO v_pay_id;

  UPDATE public.marketplace_supplier_subscriptions
     SET status             = 'active',
         current_period_end = v_to,
         monthly_amount     = COALESCE(v_sub.monthly_amount, v_plan.price_gs),
         auto_paused_at     = NULL,
         updated_at         = now()
   WHERE id = v_sub.id;

  -- Reactivar SOLO si la pausa fue automática por mora (si el proveedor pausó su
  -- tienda a mano, o Mythos la suspendió, cobrar no debe reabrirla).
  IF v_sub.auto_paused_at IS NOT NULL THEN
    UPDATE public.marketplace_suppliers
       SET estado = 'activo'
     WHERE id = p_supplier_id AND estado = 'pausado';
    v_react := true;
  END IF;

  INSERT INTO public.marketplace_events (event_type, supplier_id, actor_user, metadata)
  VALUES ('supplier_payment_registered', p_supplier_id, auth.uid(),
          jsonb_build_object('payment_id', v_pay_id, 'amount_gs', v_amount,
                             'months', v_months, 'period_end', v_to, 'reactivated', v_react));

  RETURN jsonb_build_object('ok', true, 'payment_id', v_pay_id, 'period_end', v_to,
                            'amount_gs', v_amount, 'reactivated', v_react);
END;
$$;
REVOKE ALL    ON FUNCTION public.superadmin_register_supplier_payment(uuid,bigint,int,text,text,text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.superadmin_register_supplier_payment(uuid,bigint,int,text,text,text) TO authenticated;

-- 1.7 Panorama de facturación de proveedores — agregado SERVER-SIDE.
-- El panel carga las tablas con `.limit()`; sumar el MRR en el navegador daría
-- un número que empeora cuanto más crece el negocio (mig 197, mismo error).
CREATE OR REPLACE FUNCTION public.superadmin_supplier_billing_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_out jsonb;
BEGIN
  IF NOT COALESCE(public.get_my_role() = 'superadmin', false) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'mrr_active', (SELECT COALESCE(sum(COALESCE(s.monthly_amount, p.price_gs, 0)), 0)
                     FROM public.marketplace_supplier_subscriptions s
                     LEFT JOIN public.marketplace_supplier_plans p ON p.slug = s.plan_slug
                    WHERE s.status = 'active'),
    'mrr_potential', (SELECT COALESCE(sum(COALESCE(s.monthly_amount, p.price_gs, 0)), 0)
                        FROM public.marketplace_supplier_subscriptions s
                        LEFT JOIN public.marketplace_supplier_plans p ON p.slug = s.plan_slug
                       WHERE s.status IN ('trial','active','past_due')),
    'by_status', (SELECT COALESCE(jsonb_object_agg(t.status, t.n), '{}'::jsonb)
                    FROM (SELECT status, count(*) AS n
                            FROM public.marketplace_supplier_subscriptions GROUP BY status) t),
    'no_subscription', (SELECT count(*) FROM public.marketplace_suppliers sup
                         WHERE NOT EXISTS (SELECT 1 FROM public.marketplace_supplier_subscriptions s
                                            WHERE s.supplier_id = sup.id)),
    'collected_month', (SELECT COALESCE(sum(amount_gs), 0)
                          FROM public.marketplace_supplier_payments
                         WHERE status = 'paid' AND paid_at >= date_trunc('month', now())),
    'collected_total', (SELECT COALESCE(sum(amount_gs), 0)
                          FROM public.marketplace_supplier_payments WHERE status = 'paid'),
    'rows', (
      SELECT COALESCE(jsonb_agg(x ORDER BY x->>'nombre_comercial'), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
                 'supplier_id',   sup.id,
                 'nombre_comercial', sup.nombre_comercial,
                 'estado',        sup.estado,
                 'plan_slug',     s.plan_slug,
                 'plan_name',     p.name,
                 'status',        s.status,
                 'monthly_amount',COALESCE(s.monthly_amount, p.price_gs, 0),
                 'trial_ends_at', s.trial_ends_at,
                 'current_period_end', s.current_period_end,
                 'expires_on',    CASE WHEN s.status = 'trial' THEN s.trial_ends_at
                                       ELSE COALESCE(s.current_period_end, s.trial_ends_at) END,
                 'auto_paused',   s.auto_paused_at IS NOT NULL,
                 'grace_days',    COALESCE(s.grace_days, p.grace_days, 5),
                 'last_payment_at', (SELECT max(paid_at) FROM public.marketplace_supplier_payments mp
                                      WHERE mp.supplier_id = sup.id AND mp.status = 'paid'),
                 'paid_total',    (SELECT COALESCE(sum(amount_gs),0) FROM public.marketplace_supplier_payments mp
                                    WHERE mp.supplier_id = sup.id AND mp.status = 'paid')
               ) AS x
          FROM public.marketplace_suppliers sup
          LEFT JOIN public.marketplace_supplier_subscriptions s ON s.supplier_id = sup.id
          LEFT JOIN public.marketplace_supplier_plans p ON p.slug = s.plan_slug
      ) q
    )
  ) INTO v_out;

  RETURN v_out;
END;
$$;
REVOKE ALL    ON FUNCTION public.superadmin_supplier_billing_overview() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.superadmin_supplier_billing_overview() TO authenticated;

-- 1.8 Backfill ÚNICO: reabrir 30 días a las suscripciones ya vencidas.
-- Sin esto, aplicar la migración cortaría en el acto a todo proveedor cuyo trial
-- pasó (hasta hoy nada lo vencía, así que nadie fue avisado). Se ejecuta UNA vez:
-- queda marcado con un evento y una re-corrida lo saltea.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.marketplace_events
                  WHERE event_type = 'supplier_billing_backfill') THEN
    UPDATE public.marketplace_supplier_subscriptions
       SET trial_ends_at = now() + interval '30 days',
           status        = CASE WHEN status IN ('trial','active') THEN status ELSE 'trial' END,
           updated_at    = now()
     WHERE COALESCE(
             CASE WHEN status = 'trial' THEN trial_ends_at
                  ELSE COALESCE(current_period_end, trial_ends_at) END,
             'infinity'::timestamptz) < now();

    INSERT INTO public.marketplace_events (event_type, metadata)
    VALUES ('supplier_billing_backfill',
            jsonb_build_object('note', 'mig 199: 30 días de gracia inicial a suscripciones vencidas'));
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- 2. ENFORCEMENT DE LOS TIERS (lo que el cuadro de precios promete)
-- ════════════════════════════════════════════════════════════════════

-- 2.1 Producto destacado: el "espacio destacado" que vende el plan.
ALTER TABLE public.marketplace_products
  ADD COLUMN IF NOT EXISTS destacado boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_mkp_products_destacados
  ON public.marketplace_products (supplier_id) WHERE destacado = true AND estado = 'publicado';

-- 2.2 Perfil del proveedor: categorías, zonas, banner, destacado y anti-bypass
--     de la pausa por mora. BEFORE UPDATE (el alta la hace approve-supplier con
--     los datos de la solicitud y no debe rebotar).
-- Regla clave: solo se bloquea EMPEORAR. Si un proveedor ya excede su cupo
-- (bajó de plan, o el plan se recortó), puede seguir editando y hasta reducir;
-- lo que no puede es sumar por encima del tope.
CREATE OR REPLACE FUNCTION public.enforce_supplier_profile_limits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_cap    jsonb;
  v_maxcat int;
  v_maxzon int;
  v_banner boolean;
  v_feat   int;
  v_paused timestamptz;
  v_oldn   int;
  v_newn   int;
BEGIN
  -- La plataforma (cron, endpoints service_role) y el superadmin no topean.
  IF current_user IN ('postgres','supabase_admin','service_role')
     OR COALESCE(public.get_my_role() = 'superadmin', false) THEN
    -- …salvo el destacado: es un beneficio PAGO, y si el superadmin lo prende
    -- sobre un plan que no lo incluye, la promesa del cuadro de precios se cae.
    IF NEW.destacado = true AND OLD.destacado IS DISTINCT FROM true THEN
      v_cap  := public.resolve_supplier_entitlement(NEW.id);
      v_feat := COALESCE((v_cap->>'featured_slots')::int, 0);
      IF v_feat = 0 THEN
        RAISE EXCEPTION 'El plan de este proveedor no incluye espacio destacado. Cambiale el plan para destacarlo.'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  v_cap    := public.resolve_supplier_entitlement(NEW.id);
  v_maxcat := COALESCE((v_cap->>'max_categorias')::int, 0);
  v_maxzon := COALESCE((v_cap->>'max_zonas')::int, 0);
  v_banner := COALESCE((v_cap->>'branding_banner')::boolean, false);

  -- Anti-bypass: el guard de la mig 142 deja activo↔pausado, así que sin esto un
  -- proveedor auto-pausado por mora se reactivaba solo desde su panel.
  SELECT auto_paused_at INTO v_paused
    FROM public.marketplace_supplier_subscriptions WHERE supplier_id = NEW.id;
  IF v_paused IS NOT NULL AND NEW.estado = 'activo' AND OLD.estado IS DISTINCT FROM 'activo' THEN
    RAISE EXCEPTION 'Tu tienda está pausada por falta de pago. Regularizá la suscripción para reactivarla.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Categorías (solo si crece y supera el tope; -1 = ilimitado).
  IF v_maxcat <> -1 AND NEW.categorias IS DISTINCT FROM OLD.categorias THEN
    v_newn := COALESCE(array_length(NEW.categorias, 1), 0);
    v_oldn := COALESCE(array_length(OLD.categorias, 1), 0);
    IF v_newn > v_maxcat AND v_newn > v_oldn THEN
      RAISE EXCEPTION 'Tu plan permite % categoría(s). Mejorá tu plan para elegir más.', v_maxcat
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Zonas de entrega.
  IF v_maxzon <> -1 AND NEW.zonas_entrega IS DISTINCT FROM OLD.zonas_entrega THEN
    v_newn := COALESCE(array_length(NEW.zonas_entrega, 1), 0);
    v_oldn := COALESCE(array_length(OLD.zonas_entrega, 1), 0);
    IF v_newn > v_maxzon AND v_newn > v_oldn THEN
      RAISE EXCEPTION 'Tu plan permite % zona(s) de entrega. Mejorá tu plan para sumar más.', v_maxzon
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Banner de marca (beneficio de plan; quitarlo siempre se permite).
  IF NOT v_banner AND NEW.banner_url IS DISTINCT FROM OLD.banner_url AND NEW.banner_url IS NOT NULL THEN
    RAISE EXCEPTION 'El banner de marca es parte de un plan superior. Mejorá tu plan para usarlo.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_supplier_profile ON public.marketplace_suppliers;
CREATE TRIGGER trg_enforce_supplier_profile
  BEFORE UPDATE ON public.marketplace_suppliers
  FOR EACH ROW EXECUTE FUNCTION public.enforce_supplier_profile_limits();

-- 2.3 Archivos de catálogo (PDF/Excel) por plan.
CREATE OR REPLACE FUNCTION public.enforce_supplier_catalog_file_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_max   int;
  v_count int;
BEGIN
  v_max := COALESCE((public.resolve_supplier_entitlement(NEW.supplier_id) ->> 'max_catalog_files')::int, 0);
  IF v_max = -1 THEN RETURN NEW; END IF;

  SELECT count(*) INTO v_count
    FROM public.marketplace_catalog_files
   WHERE supplier_id = NEW.supplier_id AND id <> NEW.id;

  IF v_count >= v_max THEN
    IF v_max = 0 THEN
      RAISE EXCEPTION 'Tu plan no incluye catálogos PDF/Excel. Mejorá tu plan para subirlos.'
        USING ERRCODE = 'check_violation';
    END IF;
    RAISE EXCEPTION 'Alcanzaste el máximo de catálogos de tu plan (%). Mejorá tu plan para subir más.', v_max
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_supplier_catalog_files ON public.marketplace_catalog_files;
CREATE TRIGGER trg_enforce_supplier_catalog_files
  BEFORE INSERT ON public.marketplace_catalog_files
  FOR EACH ROW EXECUTE FUNCTION public.enforce_supplier_catalog_file_limit();

-- 2.4 Productos destacados por plan (featured_slots). Solo la TRANSICIÓN a
--     destacado consume cupo (editar un destacado no cuenta), igual que el
--     límite de publicados de la mig 178.
CREATE OR REPLACE FUNCTION public.enforce_supplier_featured_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_max   int;
  v_count int;
BEGIN
  IF COALESCE(NEW.destacado, false) = false THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND COALESCE(OLD.destacado, false) = true THEN RETURN NEW; END IF;

  v_max := COALESCE((public.resolve_supplier_entitlement(NEW.supplier_id) ->> 'featured_slots')::int, 0);
  IF v_max = -1 THEN RETURN NEW; END IF;

  IF v_max = 0 THEN
    RAISE EXCEPTION 'Tu plan no incluye espacios destacados. Mejorá tu plan para destacar productos.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO v_count
    FROM public.marketplace_products
   WHERE supplier_id = NEW.supplier_id AND destacado = true AND id <> NEW.id;

  IF v_count >= v_max THEN
    RAISE EXCEPTION 'Tu plan permite % producto(s) destacado(s). Quitá otro o mejorá tu plan.', v_max
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_supplier_featured ON public.marketplace_products;
CREATE TRIGGER trg_enforce_supplier_featured
  BEFORE INSERT OR UPDATE ON public.marketplace_products
  FOR EACH ROW EXECUTE FUNCTION public.enforce_supplier_featured_limit();

-- ════════════════════════════════════════════════════════════════════
-- 3. VIDRIERA PÚBLICA ⟵ PANEL OPERATIVO (el precio deja de quedar viejo)
-- ════════════════════════════════════════════════════════════════════
-- La mig 179 solo derivaba precio al ESCRIBIR marketing_supplier_plans, y esa
-- tabla no tiene editor: cambiar el precio en Proveedores › Planes dejaba
-- /proveedores mostrando el viejo. Ahora el operativo EMPUJA (AFTER UPDATE) y el
-- trigger de la 179 sigue tirando (BEFORE INSERT/UPDATE) — "gana el panel" en
-- los dos sentidos. Solo toca filas LINKEADAS por supplier_plan_slug: una fila
-- de vidriera suelta (sin link) sigue siendo 100% editable a mano.
CREATE OR REPLACE FUNCTION public.sync_marketing_supplier_plan_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.price_gs   IS NOT DISTINCT FROM OLD.price_gs
     AND NEW.limits     IS NOT DISTINCT FROM OLD.limits
     AND NEW.status     IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;   -- nada que espejar
  END IF;

  UPDATE public.marketing_supplier_plans
     SET price_monthly_gs = NEW.price_gs,
         price_annual_gs  = NEW.price_gs * 10,
         plan_config      = NEW.limits,
         -- Un plan archivado/pausado no se sigue ofreciendo en la web.
         is_active        = (NEW.status = 'active'),
         updated_at       = now()
   WHERE supplier_plan_slug = NEW.slug;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_mkt_supplier_plan_push ON public.marketplace_supplier_plans;
CREATE TRIGGER trg_sync_mkt_supplier_plan_push
  AFTER INSERT OR UPDATE ON public.marketplace_supplier_plans
  FOR EACH ROW EXECUTE FUNCTION public.sync_marketing_supplier_plan_push();

-- ════════════════════════════════════════════════════════════════════
-- 4. PORTADA DE LA VITRINA (lado restaurante)
-- ════════════════════════════════════════════════════════════════════
-- Una sola llamada agregada: destacados, novedades y categorías CON CONTEO.
-- Hasta ahora Explorar no mostraba NINGÚN producto hasta que el comprador
-- buscaba algo — abría como un directorio vacío, no como una tienda.
-- DEFINER porque agrega sobre todos los proveedores; fail-closed: solo staff con
-- restaurante asignado (o superadmin). Un supplier NO puede espiar el catálogo
-- de la competencia por esta vía (get_my_restaurant_id() le da NULL).
CREATE OR REPLACE FUNCTION public.marketplace_storefront(p_limit int DEFAULT 12)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_lim int := LEAST(GREATEST(COALESCE(p_limit, 12), 1), 40);
  v_out jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE(public.get_my_role() = 'superadmin', false)
     AND public.get_my_restaurant_id() IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'totals', jsonb_build_object(
      'suppliers', (SELECT count(*) FROM public.marketplace_suppliers WHERE estado = 'activo'),
      'products',  (SELECT count(*) FROM public.marketplace_products p
                     JOIN public.marketplace_suppliers s ON s.id = p.supplier_id
                    WHERE p.estado = 'publicado' AND s.estado = 'activo')
    ),
    -- Destacados: primero los productos que el proveedor destacó con su plan;
    -- si no alcanzan, se completan con los de proveedores destacados por Mythos.
    'featured', (
      SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
                 'id', p.id, 'nombre', p.nombre, 'imagen_url', p.imagen_url,
                 'precio', p.precio, 'precio_tipo', p.precio_tipo,
                 'presentacion', p.presentacion, 'marca', p.marca,
                 'categoria_slug', p.categoria_slug, 'supplier_id', p.supplier_id,
                 'supplier_nombre', s.nombre_comercial, 'verificado', s.verificado
               ) AS x
          FROM public.marketplace_products p
          JOIN public.marketplace_suppliers s ON s.id = p.supplier_id
         WHERE p.estado = 'publicado' AND s.estado = 'activo'
           AND (p.destacado = true OR s.destacado = true)
         ORDER BY p.destacado DESC, s.destacado DESC, p.created_at DESC
         LIMIT v_lim
      ) q
    ),
    'novedades', (
      SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
                 'id', p.id, 'nombre', p.nombre, 'imagen_url', p.imagen_url,
                 'precio', p.precio, 'precio_tipo', p.precio_tipo,
                 'presentacion', p.presentacion, 'marca', p.marca,
                 'categoria_slug', p.categoria_slug, 'supplier_id', p.supplier_id,
                 'supplier_nombre', s.nombre_comercial, 'verificado', s.verificado
               ) AS x
          FROM public.marketplace_products p
          JOIN public.marketplace_suppliers s ON s.id = p.supplier_id
         WHERE p.estado = 'publicado' AND s.estado = 'activo'
         ORDER BY p.created_at DESC
         LIMIT v_lim
      ) q
    ),
    -- Zonas y ciudades REALES para los filtros. Antes eran inputs de texto libre
    -- filtrados en el navegador sobre una página de proveedores: escribir mal
    -- una tilde daba "sin resultados" con proveedores que sí entregaban ahí.
    'zonas', (
      SELECT COALESCE(jsonb_agg(t.z ORDER BY t.z), '[]'::jsonb)
        FROM (SELECT DISTINCT btrim(z) AS z
                FROM public.marketplace_suppliers s
                CROSS JOIN LATERAL unnest(s.zonas_entrega) AS z
               WHERE s.estado = 'activo' AND btrim(z) <> '') t
    ),
    'ciudades', (
      SELECT COALESCE(jsonb_agg(t.c ORDER BY t.c), '[]'::jsonb)
        FROM (SELECT DISTINCT btrim(ciudad) AS c
                FROM public.marketplace_suppliers
               WHERE estado = 'activo' AND COALESCE(btrim(ciudad),'') <> '') t
    ),
    -- Categorías con conteo real: una categoría vacía en la portada es una
    -- puerta a una góndola sin nada adentro.
    'categorias', (
      SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'orden')::int), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
                 'slug', c.slug, 'nombre', c.nombre, 'orden', c.orden,
                 'productos', (SELECT count(*) FROM public.marketplace_products p
                                JOIN public.marketplace_suppliers s ON s.id = p.supplier_id
                               WHERE p.categoria_slug = c.slug
                                 AND p.estado = 'publicado' AND s.estado = 'activo'),
                 'proveedores', (SELECT count(*) FROM public.marketplace_suppliers s
                                  WHERE s.estado = 'activo' AND c.slug = ANY(s.categorias))
               ) AS x
          FROM public.marketplace_categories c
         WHERE c.activa = true
      ) q
    )
  ) INTO v_out;

  RETURN v_out;
END;
$$;

REVOKE ALL    ON FUNCTION public.marketplace_storefront(int) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.marketplace_storefront(int) TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- 5. ANALÍTICA DEL PROVEEDOR (el otro beneficio que se vendía y no existía)
-- ════════════════════════════════════════════════════════════════════
-- Los planes prometían "Analítica básica" y "Analítica completa" desde la mig
-- 177 y el panel proveedor no tenía NINGUNA pantalla de analítica. Acá vive el
-- cálculo, agregado server-side y gateado por el propio plan (`analytics`):
--   none     → {enabled:false} (el panel muestra el upsell, no un cero engañoso)
--   basico   → totales, embudo por estado y evolución mensual
--   completo → + productos y categorías más consultados
-- No se agrega en el navegador a propósito: las consultas se cargan con `.limit()`
-- y agrupar eso daría un número que empeora cuanto más vende el proveedor.
CREATE OR REPLACE FUNCTION public.supplier_analytics(p_months int DEFAULT 6)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_sid    uuid := public.get_my_supplier_id();
  v_mode   text;
  v_from   timestamptz;
  v_months int := LEAST(GREATEST(COALESCE(p_months, 6), 1), 24);
  v_out    jsonb;
BEGIN
  IF v_sid IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  v_mode := COALESCE(public.resolve_supplier_entitlement(v_sid) ->> 'analytics', 'none');
  IF v_mode = 'none' THEN
    RETURN jsonb_build_object('enabled', false, 'mode', 'none');
  END IF;

  v_from := date_trunc('month', now()) - make_interval(months => v_months - 1);

  SELECT jsonb_build_object(
    'enabled', true,
    'mode',    v_mode,
    'from',    v_from,
    'totals', (
      SELECT jsonb_build_object(
        'leads',       count(*),
        'contactos',   count(*) FILTER (WHERE tipo = 'contacto'),
        'cotizaciones',count(*) FILTER (WHERE tipo = 'cotizacion'),
        'nuevas',      count(*) FILTER (WHERE estado = 'nueva'),
        'respondidas', count(*) FILTER (WHERE estado <> 'nueva'),
        'cerradas',    count(*) FILTER (WHERE estado = 'cerrada'),
        'perdidas',    count(*) FILTER (WHERE estado = 'perdida')
      )
      FROM public.marketplace_leads WHERE supplier_id = v_sid
    ),
    'by_status', (
      SELECT COALESCE(jsonb_object_agg(t.estado, t.n), '{}'::jsonb)
        FROM (SELECT estado, count(*) AS n FROM public.marketplace_leads
               WHERE supplier_id = v_sid GROUP BY estado) t
    ),
    -- Serie mensual continua: sin generate_series, un mes sin consultas
    -- desaparecería del gráfico en vez de dibujarse en cero.
    'by_month', (
      SELECT COALESCE(jsonb_agg(x ORDER BY x->>'mes'), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
                 'mes', to_char(m.mes, 'YYYY-MM'),
                 'leads', (SELECT count(*) FROM public.marketplace_leads l
                            WHERE l.supplier_id = v_sid
                              AND l.created_at >= m.mes
                              AND l.created_at < m.mes + interval '1 month'),
                 'contactos_revelados', (SELECT count(*) FROM public.marketplace_events e
                                          WHERE e.supplier_id = v_sid
                                            AND e.event_type = 'contact_revealed'
                                            AND e.created_at >= m.mes
                                            AND e.created_at < m.mes + interval '1 month')
               ) AS x
          FROM generate_series(v_from, date_trunc('month', now()), interval '1 month') AS m(mes)
      ) q
    ),
    'top_products', CASE WHEN v_mode = 'completo' THEN (
      SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'n')::int DESC), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('nombre', COALESCE(p.nombre, l.producto_texto), 'n', count(*)) AS x
          FROM public.marketplace_leads l
          LEFT JOIN public.marketplace_products p ON p.id = l.product_id
         WHERE l.supplier_id = v_sid
           AND COALESCE(p.nombre, l.producto_texto) IS NOT NULL
         GROUP BY COALESCE(p.nombre, l.producto_texto)
         ORDER BY count(*) DESC
         LIMIT 8
      ) q
    ) ELSE '[]'::jsonb END,
    'top_categories', CASE WHEN v_mode = 'completo' THEN (
      SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'n')::int DESC), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('nombre', COALESCE(c.nombre, p.categoria_slug), 'n', count(*)) AS x
          FROM public.marketplace_leads l
          JOIN public.marketplace_products p ON p.id = l.product_id
          LEFT JOIN public.marketplace_categories c ON c.slug = p.categoria_slug
         WHERE l.supplier_id = v_sid AND p.categoria_slug IS NOT NULL
         GROUP BY COALESCE(c.nombre, p.categoria_slug)
         ORDER BY count(*) DESC
         LIMIT 8
      ) q
    ) ELSE '[]'::jsonb END
  ) INTO v_out;

  RETURN v_out;
END;
$$;

REVOKE ALL    ON FUNCTION public.supplier_analytics(int) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.supplier_analytics(int) TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- 6. ALINEAR EL TEXTO DE LOS PLANES CON LO QUE AHORA SE ENTREGA
-- ════════════════════════════════════════════════════════════════════
-- El cuadro de /proveedores prometía 8 cosas que no existían. Seis quedaron
-- implementadas en esta migración; las dos que NO se pueden cumplir hoy salen
-- del texto en vez de quedar como promesa vacía:
--   · "Hasta N usuarios" — el tope existe (trigger, mig 178) pero el panel del
--     proveedor todavía no tiene pantalla para invitar a un segundo usuario.
--   · "Contacto prioritario" — `lead_priority` sigue sin consumidor; queda como
--     knob del plan, no como promesa pública.
-- Corre UNA sola vez (marcada con un evento): a partir de acá el texto lo edita
-- Renato desde Sitio web › Planes proveedor, y una re-corrida no le pisa nada.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.marketplace_events
                  WHERE event_type = 'supplier_plan_copy_aligned') THEN

    UPDATE public.marketplace_supplier_plans SET features =
      '["Perfil de proveedor en el marketplace","Hasta 10 productos publicados","1 categoría y 1 zona de cobertura","Los datos del restaurante, 24 h después de la consulta"]'::jsonb
     WHERE slug = 'basico';
    UPDATE public.marketplace_supplier_plans SET features =
      '["Hasta 50 productos publicados","3 categorías y 3 zonas de cobertura","Los datos del restaurante al instante","1 producto destacado en la portada","Analítica de consultas","Hasta 3 catálogos PDF/Excel"]'::jsonb
     WHERE slug = 'profesional';
    UPDATE public.marketplace_supplier_plans SET features =
      '["Productos publicados ilimitados","Categorías y zonas ilimitadas","Los datos del restaurante al instante","Productos destacados ilimitados","Analítica completa","Banner de marca propio","Catálogos PDF/Excel ilimitados"]'::jsonb
     WHERE slug = 'premium';

    UPDATE public.marketing_supplier_plans SET features =
      '["Perfil de proveedor en el marketplace","Hasta 10 productos publicados","1 categoría y 1 zona de cobertura","Los datos del restaurante, 24 h después de la consulta"]'::jsonb
     WHERE slug = 'basico';
    UPDATE public.marketing_supplier_plans SET features =
      '["Hasta 50 productos publicados","3 categorías y 3 zonas de cobertura","Los datos del restaurante al instante","1 producto destacado en la portada","Analítica de consultas","Hasta 3 catálogos PDF/Excel"]'::jsonb
     WHERE slug = 'profesional';
    UPDATE public.marketing_supplier_plans SET features =
      '["Productos publicados ilimitados","Categorías y zonas ilimitadas","Los datos del restaurante al instante","Productos destacados ilimitados","Analítica completa","Banner de marca propio","Catálogos PDF/Excel ilimitados"]'::jsonb
     WHERE slug = 'premium';

    INSERT INTO public.marketplace_events (event_type, metadata)
    VALUES ('supplier_plan_copy_aligned',
            jsonb_build_object('note', 'mig 199: el texto de los planes ahora describe solo lo que el producto entrega'));
  END IF;
END $$;

COMMIT;

-- Recargar el cache de esquema de PostgREST (tablas, columnas y funciones nuevas).
NOTIFY pgrst, 'reload schema';

SELECT 'migracion 199 aplicada (cobro de proveedores + enforcement de tiers + sync vidriera + portada de tienda)' AS status;
