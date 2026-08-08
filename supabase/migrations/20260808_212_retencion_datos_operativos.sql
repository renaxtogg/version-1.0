-- ════════════════════════════════════════════════════════════════════════
-- 212 · Retención de datos operativos (2 meses) + aviso al local
-- ────────────────────────────────────────────────────────────────────────
-- [PARA PEGAR EN SUPABASE]  ·  rol postgres, SQL Editor en INGLÉS.
--
-- POR QUÉ EXISTE ESTO
-- Los pedidos no se borran nunca. Cada mesa, cada delivery, cada llamada al
-- mozo y cada escaneo de QR queda para siempre en la base, y eso crece sin
-- techo con datos que a los 60 días ya no sirven para operar. Decisión de
-- Renato (2026-08-08): el histórico operativo se guarda **como máximo 2
-- meses**, y el local exporta a PDF/Excel lo que quiera conservar.
--
-- LO QUE ESTO **NO** BORRA, y por qué importa
-- El libro de caja (`turnos_caja`, `movimientos_caja`, `cancelaciones_caja`),
-- los egresos (`expenses`) y los movimientos de stock quedan **APAGADOS** en
-- el seed de §2. No es un olvido:
--   • Caja y egresos son respaldo CONTABLE. En Paraguay los comprobantes y
--     registros de una operación se conservan por años para la SET; que Mythos
--     los borre a los 60 días le crearía un problema fiscal al restaurante.
--   • `stock_movements` es el historial del que sale el stock actual: borrarlo
--     puede dejar el inventario sin explicación (o directamente mal).
-- Están listados igual, apagados y con el motivo escrito, para que la decisión
-- sea visible y de un toque — no para que alguien la tome sin verla.
-- `payments`, `subscriptions` y `platform_events` no se listan siquiera: son
-- de Mythos, no del local.
--
-- ARRANCA APAGADO — A PROPÓSITO.
-- `data_retention_config.enabled = false`. Aplicar esta migración NO borra ni
-- una fila. Es la regla de la casa para todo lo destructivo sobre datos de
-- terceros (CLAUDE.md): spec + backup nuevo + dry-run revisado ANTES de tocar.
-- El dry-run está acá mismo: `data_retention_report()` dice exactamente cuántas
-- filas se irían, por tabla, sin escribir nada. Recién después se prende.
--
-- CÓMO SE CORRE
--   • Dry-run:  SELECT public.data_retention_report();
--   • Manual:   SELECT public.run_data_retention(false);   -- borra de verdad
--   • Nocturno: paso `retencion` de /api/cron/nightly (idempotente).
-- Cada corrida deja asiento en `platform_events` (`retencion_datos`), así que
-- siempre se puede reconstruir qué se borró y cuándo.
--
-- TOPE POR CORRIDA: `max_rows_per_table` (default 50.000). La primera pasada
-- sobre un local con años de historia podría ser un DELETE gigantesco que
-- muere por statement timeout y no borra nada. Con el tope, cada noche muerde
-- un pedazo y el reporte informa cuánto queda.
--
-- Todo ADITIVO e idempotente.
--
-- REVERSA:
--   DROP FUNCTION IF EXISTS public.run_data_retention(boolean);
--   DROP FUNCTION IF EXISTS public.data_retention_report();
--   DROP TABLE IF EXISTS public.data_retention_targets;
--   DROP TABLE IF EXISTS public.data_retention_config;
--   (los datos ya borrados NO vuelven — de ahí el arranque apagado)
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- 1) data_retention_config — la política, una sola fila
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.data_retention_config (
  id                  BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),

  -- Portero. Apagado = el cron reporta lo que haría y no borra nada.
  enabled             BOOLEAN NOT NULL DEFAULT false,

  -- 60 días = los 2 meses pedidos. El piso de 30 no es decorativo: un 1 tipeado
  -- de más borraría el mes en curso, y eso no se deshace.
  retention_days      INT     NOT NULL DEFAULT 60
                        CHECK (retention_days BETWEEN 30 AND 3650),

  -- Tope de filas por tabla y por corrida (ver cabecera).
  max_rows_per_table  INT     NOT NULL DEFAULT 50000
                        CHECK (max_rows_per_table BETWEEN 1000 AND 1000000),

  -- Si el aviso se muestra en Admin › Configuración del local. Se puede apagar,
  -- pero avisar es justamente lo que hace legítimo el borrado.
  notice_enabled      BOOLEAN NOT NULL DEFAULT true,

  last_run_at         TIMESTAMPTZ,
  last_result         JSONB,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.data_retention_config (id) VALUES (true)
ON CONFLICT (id) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════
-- 2) data_retention_targets — QUÉ se purga. Es dato, no código.
-- ────────────────────────────────────────────────────────────────────────
-- Sumar una tabla a la purga no debería exigir una migración, y sobre todo:
-- la lista tiene que poder MIRARSE. Una purga cuyo alcance vive adentro de una
-- función es una purga que nadie audita.
--
-- `extra_where` es SQL crudo que se concatena. Sólo lo escribe un superadmin
-- (RLS de §3) — mismo nivel de confianza que escribir una migración. No es un
-- campo que reciba nada de un usuario final.
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.data_retention_targets (
  table_name   TEXT PRIMARY KEY,
  date_column  TEXT    NOT NULL,
  extra_where  TEXT,                      -- condición extra (NULL = sin filtro)
  enabled      BOOLEAN NOT NULL DEFAULT false,
  label        TEXT    NOT NULL,
  reason       TEXT,                      -- por qué está prendida o apagada
  sort_order   INT     NOT NULL DEFAULT 0
);

-- ── Operativo: se purga ────────────────────────────────────────────────
-- `orders` va primero y arrastra en cascada order_items, order_item_extras,
-- order_status_history y los delivery_orders vinculados. Lo que apunta al
-- pedido desde la contabilidad (movimientos_caja.pedido_id, cancelaciones,
-- ratings) es ON DELETE SET NULL: el asiento contable sobrevive sin el pedido.
INSERT INTO public.data_retention_targets
  (table_name, date_column, extra_where, enabled, label, reason, sort_order) VALUES
  ('orders', 'created_at', $$status IN ('delivered','cancelled')$$, true,
   'Pedidos de salón y mostrador',
   'Sólo pedidos cerrados o cancelados: uno abierto a los 60 días es raro, pero borrarlo sería borrar trabajo en curso. Arrastra ítems, extras e historial de estados.', 10),

  ('delivery_orders', 'created_at', $$status IN ('delivered','cancelled')$$, true,
   'Pedidos de delivery',
   'Los que cuelgan de un pedido ya se van en cascada; esto barre los sueltos (order_id NULL).', 20),

  ('waiter_calls', 'created_at', NULL, true,
   'Llamadas al mozo',
   'Señal del momento: a los 60 días no informa nada.', 30),

  ('table_scan_sessions', 'started_at', NULL, true,
   'Sesiones de escaneo de QR',
   'Control anti-abuso del QR, sirve mientras la mesa está abierta.', 40),

  ('staff_sessions', 'login_at', $$logout_at IS NOT NULL$$, true,
   'Entradas y salidas del personal',
   'Alimenta Personal › Turnos. Nunca borra una sesión todavía abierta.', 50),

-- ── Contable / delicado: listado y APAGADO, con el motivo a la vista ───
  ('movimientos_caja', 'created_at', NULL, false,
   'Movimientos de caja',
   'APAGADO: es el libro de caja, respaldo contable ante la SET. Prenderlo es una decisión fiscal del negocio, no de mantenimiento.', 60),

  ('cancelaciones_caja', 'created_at', NULL, false,
   'Cancelaciones de caja',
   'APAGADO: respalda anulaciones y descuadres. Es justo lo que se pide cuando algo se audita.', 70),

  ('turnos_caja', 'fecha_apertura', $$estado = 'cerrado'$$, false,
   'Turnos y arqueos de caja',
   'APAGADO: borrar un turno se lleva en cascada sus movimientos y cancelaciones, aunque esas dos estén apagadas acá.', 80),

  ('expenses', 'created_at', NULL, false,
   'Egresos y gastos',
   'APAGADO: respaldo contable.', 90),

  ('stock_movements', 'created_at', NULL, false,
   'Movimientos de stock',
   'APAGADO: de este historial sale el stock actual; borrarlo puede dejar el inventario sin explicación.', 100),

  ('quejas_sugerencias', 'created_at', NULL, false,
   'Quejas y sugerencias',
   'APAGADO: son reclamos de clientes reales, no telemetría.', 110)
ON CONFLICT (table_name) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════
-- 3) RLS
-- ────────────────────────────────────────────────────────────────────────
-- `data_retention_config` es un CATÁLOGO GLOBAL de lectura: el panel de cada
-- local necesita saber la política para mostrar el aviso, y no hay nada
-- sensible en "se guardan 60 días". Escribir, sólo superadmin.
-- `data_retention_targets` no la lee nadie fuera del superadmin: la lista de
-- tablas del sistema no le aporta nada a un restaurante.
-- `anon` no toca ninguna de las dos (desde la mig 210 no hereda nada de fábrica
-- y acá no se le otorga nada).
-- ════════════════════════════════════════════════════════════════════════
ALTER TABLE public.data_retention_config  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_retention_targets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS drc_read     ON public.data_retention_config;
DROP POLICY IF EXISTS drc_sa_write ON public.data_retention_config;
DROP POLICY IF EXISTS drt_sa_all   ON public.data_retention_targets;

CREATE POLICY drc_read ON public.data_retention_config
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY drc_sa_write ON public.data_retention_config
  FOR UPDATE TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

CREATE POLICY drt_sa_all ON public.data_retention_targets
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

GRANT SELECT          ON public.data_retention_config  TO authenticated;
GRANT UPDATE          ON public.data_retention_config  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
                      ON public.data_retention_targets TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 4) _data_retention_run(p_dry_run) — el motor, privado
-- ────────────────────────────────────────────────────────────────────────
-- Una sola implementación para contar y para borrar: si el dry-run recorriera
-- un camino distinto al borrado, dejaría de ser un ensayo del borrado.
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public._data_retention_run(p_dry_run BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_cfg     public.data_retention_config%ROWTYPE;
  v_t       RECORD;
  v_cutoff  TIMESTAMPTZ;
  v_where   TEXT;
  v_sql     TEXT;
  v_total   BIGINT;
  v_deleted BIGINT;
  v_detalle JSONB := '[]'::jsonb;
  v_suma    BIGINT := 0;
BEGIN
  SELECT * INTO v_cfg FROM public.data_retention_config WHERE id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sin configuración de retención');
  END IF;

  v_cutoff := NOW() - make_interval(days => v_cfg.retention_days);

  -- Un borrado real con el portero apagado se degrada a ensayo. Es la
  -- diferencia entre "todavía no lo prendimos" y "borró igual".
  IF NOT p_dry_run AND NOT v_cfg.enabled THEN
    p_dry_run := true;
  END IF;

  FOR v_t IN
    SELECT * FROM public.data_retention_targets
    WHERE enabled ORDER BY sort_order, table_name
  LOOP
    -- Schema drift: la tabla o la columna pueden no existir en esta base
    -- (migración vieja, tabla renombrada). Se saltea, no se rompe la corrida.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = v_t.table_name
        AND column_name  = v_t.date_column
    ) THEN
      v_detalle := v_detalle || jsonb_build_object(
        'tabla', v_t.table_name, 'estado', 'ausente', 'filas', 0);
      CONTINUE;
    END IF;

    v_where := format('%I < %L', v_t.date_column, v_cutoff);
    IF v_t.extra_where IS NOT NULL AND btrim(v_t.extra_where) <> '' THEN
      v_where := v_where || ' AND (' || v_t.extra_where || ')';
    END IF;

    -- Cuánto hay en total por encima del corte (con tope o sin él).
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %s', v_t.table_name, v_where)
      INTO v_total;

    v_deleted := 0;
    IF NOT p_dry_run AND v_total > 0 THEN
      -- Por ctid + LIMIT: acota la corrida al tope configurado en vez de
      -- intentar un DELETE de tamaño desconocido que muera por timeout.
      EXECUTE format(
        'DELETE FROM public.%I WHERE ctid IN '
        '(SELECT ctid FROM public.%I WHERE %s LIMIT %s)',
        v_t.table_name, v_t.table_name, v_where, v_cfg.max_rows_per_table);
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
      v_suma := v_suma + v_deleted;
    END IF;

    v_detalle := v_detalle || jsonb_build_object(
      'tabla',     v_t.table_name,
      'etiqueta',  v_t.label,
      'estado',    CASE WHEN p_dry_run THEN 'ensayo' ELSE 'purgado' END,
      'elegibles', v_total,
      'borradas',  v_deleted,
      'restantes', GREATEST(v_total - v_deleted, 0)
    );
  END LOOP;

  IF NOT p_dry_run THEN
    UPDATE public.data_retention_config
       SET last_run_at = NOW(),
           last_result = jsonb_build_object('borradas', v_suma, 'detalle', v_detalle),
           updated_at  = NOW()
     WHERE id;

    -- Asiento auditable: sin esto, "¿qué pasó con los pedidos de junio?" no
    -- tiene respuesta posible.
    INSERT INTO public.platform_events (event_type, description, metadata)
    VALUES ('retencion_datos',
            format('Purga de datos operativos: %s filas borradas (corte %s días)',
                   v_suma, v_cfg.retention_days),
            jsonb_build_object('borradas', v_suma, 'retention_days', v_cfg.retention_days,
                               'detalle', v_detalle));
  END IF;

  RETURN jsonb_build_object(
    'ok',             true,
    'ensayo',         p_dry_run,
    'activo',         v_cfg.enabled,
    'retention_days', v_cfg.retention_days,
    'corte',          v_cutoff,
    'borradas',       v_suma,
    'detalle',        v_detalle
  );
END;
$$;

-- Privada: se llega por las dos de abajo, que sí chequean quién llama. Los
-- REVOKE nombrados van además del de PUBLIC porque un ALTER DEFAULT PRIVILEGES
-- sobre FUNCTIONS podría haberle dado EXECUTE directo a esos roles (fue
-- exactamente lo que pasó con las TABLAS y `anon`, mig 210).
REVOKE ALL ON FUNCTION public._data_retention_run(boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._data_retention_run(boolean) FROM anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 5) data_retention_report() — el ensayo, para mirar antes de prender
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.data_retention_report()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF public.get_my_role() IS DISTINCT FROM 'superadmin' THEN
    RAISE EXCEPTION 'Solo superadmin';
  END IF;
  RETURN public._data_retention_run(true);
END;
$$;

REVOKE ALL ON FUNCTION public.data_retention_report() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.data_retention_report() TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 6) run_data_retention(p_dry_run) — la purga
-- ────────────────────────────────────────────────────────────────────────
-- Default `true`: quien la llame sin argumentos hace un ensayo. Borrar exige
-- escribir `false`, o sea decidirlo.
-- La llaman el superadmin (botón) y el cron nocturno (service_role).
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.run_data_retention(p_dry_run BOOLEAN DEFAULT true)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_jwt_role TEXT;
BEGIN
  -- service_role entra sin rol de negocio (es el cron); una persona necesita
  -- ser superadmin. Mismo chequeo que las migs 146/151.
  v_jwt_role := COALESCE(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  IF NOT (COALESCE(public.get_my_role() = 'superadmin', false)
          OR v_jwt_role = 'service_role'
          OR current_user IN ('postgres','supabase_admin','service_role')) THEN
    RAISE EXCEPTION 'Solo superadmin';
  END IF;
  RETURN public._data_retention_run(COALESCE(p_dry_run, true));
END;
$$;

REVOKE ALL ON FUNCTION public.run_data_retention(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.run_data_retention(boolean) TO authenticated, service_role;

COMMIT;

SELECT 'migracion 212 aplicada (retención de datos operativos — APAGADA; correr data_retention_report() antes de prender)' AS status;
