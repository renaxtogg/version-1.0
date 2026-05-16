-- ============================================================
-- Migración 024: Fix de migración 019 — políticas idempotentes
-- 2026-05-16
-- Soluciona: ERROR 42710 "policy already exists" al re-ejecutar 019
-- Todas las CREATE POLICY envueltas en DO $$ con IF NOT EXISTS
-- ============================================================

-- ─── ROL cajero en user_roles ─────────────────────────────
ALTER TABLE public.user_roles
  DROP CONSTRAINT IF EXISTS user_roles_role_check;

ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_role_check
  CHECK (role IN ('cocina', 'admin', 'superadmin', 'cajero', 'waiter', 'delivery'));

-- ─── get_my_profile actualizado ───────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_profile()
RETURNS JSON
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT row_to_json(t) FROM (
    SELECT ur.user_id AS id, ur.role, ur.username, ur.display_name, ur.restaurant_id, ur.is_active
    FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.is_active = true
    LIMIT 1
  ) t;
$$;
GRANT EXECUTE ON FUNCTION public.get_my_profile TO authenticated;

-- ─── Tablas (IF NOT EXISTS ya maneja duplicados) ──────────
CREATE TABLE IF NOT EXISTS public.turnos_caja (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id          UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  cajero_id              UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  cajero_nombre          TEXT,
  fecha_apertura         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fecha_cierre           TIMESTAMPTZ,
  estado                 TEXT NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto','cerrado')),
  fondo_apertura         JSONB NOT NULL DEFAULT '{}',
  fondo_cierre_contado   JSONB,
  fondo_cierre_esperado  NUMERIC(14,2),
  diferencia             NUMERIC(14,2),
  justificacion_diff     TEXT,
  observaciones_apertura TEXT,
  supervisor_cierre_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  supervisor_cierre_nombre TEXT,
  tipo_reporte           TEXT CHECK (tipo_reporte IN ('X','Z')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.movimientos_caja (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  turno_id      UUID NOT NULL REFERENCES public.turnos_caja(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  tipo          TEXT NOT NULL CHECK (tipo IN (
    'cobro','ingreso_manual','egreso','retiro_parcial',
    'reposicion','descuento','cortesia','propina'
  )),
  monto         NUMERIC(14,2) NOT NULL,
  metodo_pago   TEXT CHECK (metodo_pago IN (
    'efectivo','tarjeta_credito','tarjeta_debito',
    'qr','gift_card','cuenta_corriente','mixto'
  )),
  pedido_id     UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  descripcion   TEXT,
  categoria     TEXT,
  motivo        TEXT,
  usuario_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  usuario_nombre TEXT,
  supervisor_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata       JSONB DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.cancelaciones_caja (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  turno_id                UUID NOT NULL REFERENCES public.turnos_caja(id) ON DELETE CASCADE,
  restaurant_id           UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  pedido_id               UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  pedido_numero           TEXT,
  tipo                    TEXT NOT NULL CHECK (tipo IN ('parcial','total')),
  items_cancelados        JSONB NOT NULL DEFAULT '[]',
  monto_cancelado         NUMERIC(14,2) NOT NULL,
  motivo                  TEXT NOT NULL,
  descripcion             TEXT,
  estado_pedido_cancelar  TEXT,
  perdida_insumos         BOOLEAN NOT NULL DEFAULT FALSE,
  usuario_id              UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  usuario_nombre          TEXT,
  supervisor_id           UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.quejas_sugerencias (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  turno_id             UUID REFERENCES public.turnos_caja(id) ON DELETE SET NULL,
  restaurant_id        UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  pedido_id            UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  tipo                 TEXT NOT NULL CHECK (tipo IN ('queja','sugerencia','comentario_positivo')),
  categoria            TEXT,
  urgencia             TEXT CHECK (urgencia IN ('baja','media','alta')),
  descripcion          TEXT NOT NULL,
  compensacion_ofrecida BOOLEAN NOT NULL DEFAULT FALSE,
  compensacion_tipo    TEXT,
  compensacion_monto   NUMERIC(14,2),
  estado               TEXT NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto','en_revision','resuelto','escalado')),
  usuario_id           UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  usuario_nombre       TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── RLS (habilitar, idempotente) ─────────────────────────
ALTER TABLE public.turnos_caja         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.movimientos_caja    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cancelaciones_caja  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quejas_sugerencias  ENABLE ROW LEVEL SECURITY;

-- ─── Políticas idempotentes ────────────────────────────────
DO $$
BEGIN

  -- turnos_caja
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='turnos_caja_select' AND tablename='turnos_caja') THEN
    CREATE POLICY "turnos_caja_select" ON public.turnos_caja
      FOR SELECT USING (
        restaurant_id = (SELECT restaurant_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true LIMIT 1)
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='turnos_caja_insert' AND tablename='turnos_caja') THEN
    CREATE POLICY "turnos_caja_insert" ON public.turnos_caja
      FOR INSERT WITH CHECK (
        restaurant_id = (SELECT restaurant_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true LIMIT 1)
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='turnos_caja_update' AND tablename='turnos_caja') THEN
    CREATE POLICY "turnos_caja_update" ON public.turnos_caja
      FOR UPDATE USING (
        restaurant_id = (SELECT restaurant_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true LIMIT 1)
      );
  END IF;

  -- movimientos_caja
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='movimientos_caja_select' AND tablename='movimientos_caja') THEN
    CREATE POLICY "movimientos_caja_select" ON public.movimientos_caja
      FOR SELECT USING (
        restaurant_id = (SELECT restaurant_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true LIMIT 1)
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='movimientos_caja_insert' AND tablename='movimientos_caja') THEN
    CREATE POLICY "movimientos_caja_insert" ON public.movimientos_caja
      FOR INSERT WITH CHECK (
        restaurant_id = (SELECT restaurant_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true LIMIT 1)
      );
  END IF;

  -- cancelaciones_caja
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='cancelaciones_caja_select' AND tablename='cancelaciones_caja') THEN
    CREATE POLICY "cancelaciones_caja_select" ON public.cancelaciones_caja
      FOR SELECT USING (
        restaurant_id = (SELECT restaurant_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true LIMIT 1)
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='cancelaciones_caja_insert' AND tablename='cancelaciones_caja') THEN
    CREATE POLICY "cancelaciones_caja_insert" ON public.cancelaciones_caja
      FOR INSERT WITH CHECK (
        restaurant_id = (SELECT restaurant_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true LIMIT 1)
      );
  END IF;

  -- quejas_sugerencias
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='quejas_sugerencias_all' AND tablename='quejas_sugerencias') THEN
    CREATE POLICY "quejas_sugerencias_all" ON public.quejas_sugerencias
      FOR ALL USING (
        restaurant_id = (SELECT restaurant_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true LIMIT 1)
      );
  END IF;

END$$;

-- ─── Índices ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_turnos_caja_restaurant ON public.turnos_caja(restaurant_id, estado);
CREATE INDEX IF NOT EXISTS idx_movimientos_turno      ON public.movimientos_caja(turno_id);
CREATE INDEX IF NOT EXISTS idx_movimientos_restaurant ON public.movimientos_caja(restaurant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cancelaciones_turno    ON public.cancelaciones_caja(turno_id);
CREATE INDEX IF NOT EXISTS idx_quejas_restaurant      ON public.quejas_sugerencias(restaurant_id, estado);

-- ─── Realtime ──────────────────────────────────────────────
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.turnos_caja;
EXCEPTION WHEN others THEN NULL;
END$$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.movimientos_caja;
EXCEPTION WHEN others THEN NULL;
END$$;
