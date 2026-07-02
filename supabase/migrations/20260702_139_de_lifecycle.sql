-- ════════════════════════════════════════════════════════════════════
-- 139 · DE — ciclo de vida completo (estados GENERADO/ERROR + idempotencia
--       real + inutilizaciones)   [PR-FE-3]
-- ────────────────────────────────────────────────────────────────────
-- Depende de las migs 137 (fiscal_config) y 138 (documentos_electronicos +
-- fiscal_secuencias + siguiente_numero_de). SOLO sandbox por ahora.
-- 1 PR = 1 causa: "cerrar el ciclo de vida del Documento Electrónico".
--
-- HALLAZGO PR-FE-2 (confirmado en vivo): en modo "No conectado a SIFEN" el
-- estado terminal de un DE es GENERADO (XML + CDC + KuDE existen). APROBADO sólo
-- ocurre conectado a SIFEN (cert F1 + timbrado). El modelo de estados refleja
-- esa realidad: GENERADO es un éxito TERMINAL, no un ENVIADO eterno.
--
-- Cambios:
--   1) CHECK de estado: agrega 'GENERADO' (éxito terminal desconectado) y
--      'ERROR' (falla de generación: sin CDC/lote — mata el "BORRADOR disfrazado").
--   2) Idempotencia real: reemplaza el UNIQUE total por un UNIQUE PARCIAL sobre
--      (restaurant_id, order_id) SÓLO para DE "vivos". Así un reintento tras
--      ERROR/RECHAZADO puede crear un DE NUEVO (número nuevo) sin chocar con la
--      fila histórica del intento fallido (su número queda registrado; SIFEN
--      tolera huecos pero NUNCA repetición).
--   3) RPC reclamar_o_crear_de: get-or-create ATÓMICO del DE vivo de una orden,
--      con SELECT ... FOR UPDATE sobre la orden (mismo patrón anti-carrera que
--      cobro_mesa_parcial, mig 128). service_role-only.
--   4) fiscal_inutilizaciones: bitácora de eventos de inutilización de rangos de
--      numeración. RLS deny-all salvo service_role (mismo patrón que mig 137),
--      fuera de la publicación realtime.
--
-- Idempotente y seguro de re-correr. Revertir:
--   DROP FUNCTION IF EXISTS public.reclamar_o_crear_de(uuid,uuid,int,text,text);
--   DROP TABLE IF EXISTS public.fiscal_inutilizaciones;
--   -- (el CHECK y el índice parcial se pueden dejar; son un superconjunto seguro)
--
-- ⚠ PREPARED — aplicar manualmente en el SQL Editor (en INGLÉS) tras backup nuevo.
--   Claude Code NO aplica migraciones.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1) Estados: agrega GENERADO y ERROR al CHECK ────────────────────────────
-- El CHECK inline de la mig 138 se llama documentos_electronicos_estado_check
-- (nombre autogenerado <tabla>_<columna>_check). Lo reemplazamos por el ampliado.
-- El set nuevo es SUPERCONJUNTO del viejo → ninguna fila existente lo viola.
ALTER TABLE public.documentos_electronicos
  DROP CONSTRAINT IF EXISTS documentos_electronicos_estado_check;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documentos_electronicos_estado_check') THEN
    ALTER TABLE public.documentos_electronicos
      ADD CONSTRAINT documentos_electronicos_estado_check
      CHECK (estado IN ('BORRADOR','ENVIADO','GENERADO','APROBADO','RECHAZADO','CANCELADO','INUTILIZADO','ERROR'));
  END IF;
END $$;

-- ── 2) Idempotencia: UNIQUE parcial de "DE vivo" por orden ──────────────────
-- El índice total de la mig 138 (restaurant_id, order_id, tipo_de) impedía crear
-- un DE nuevo tras un ERROR/RECHAZADO. Lo cambiamos por uno PARCIAL: a lo sumo un
-- DE VIVO por (restaurant_id, order_id). Los estados terminales no-vivos
-- (RECHAZADO/CANCELADO/INUTILIZADO/ERROR) NO ocupan el slot → el reintento crea
-- un DE nuevo con número nuevo. order_id NULL (DE de ejemplo) queda fuera del
-- índice (no aplica unicidad a los ejemplos).
DROP INDEX IF EXISTS public.documentos_electronicos_uq_order;

CREATE UNIQUE INDEX IF NOT EXISTS documentos_electronicos_uq_order_vivo
  ON public.documentos_electronicos (restaurant_id, order_id)
  WHERE order_id IS NOT NULL
    AND estado IN ('BORRADOR','ENVIADO','GENERADO','APROBADO');

-- ── 3) RPC reclamar_o_crear_de — get-or-create atómico del DE vivo de una orden
-- Devuelve jsonb { doc: <fila documentos_electronicos>, created: bool }.
--   • Bloquea la fila de la ORDEN (FOR UPDATE) → serializa emisiones concurrentes
--     de la misma orden (mismo patrón anti-doble-cobro de la mig 128).
--   • Si ya hay un DE VIVO real (con CDC, o GENERADO/APROBADO, o un BORRADOR/
--     ENVIADO RECIENTE aún en vuelo) → lo devuelve (created=false) SIN consumir
--     número. El caller NO re-emite (idempotente).
--   • STALENESS-RECLAIM: un BORRADOR/ENVIADO SIN CDC más viejo que el umbral es
--     un intento ABANDONADO (la función serverless murió por timeout/OOM/deploy
--     entre el INSERT del BORRADOR y el update terminal — el catch de JS no corre
--     en un kill duro). Como NO tiene CDC, nada se emitió a SIFEN: se RE-RECLAMA
--     la MISMA fila (reusa su número) y se devuelve created=true para re-emitir.
--     Sin esto, un BORRADOR huérfano trabaría la orden para siempre. El umbral
--     (2 min) supera con margen el maxDuration (30s), así que nunca pisa un
--     intento legítimamente en vuelo.
--   • Si no hay DE vivo → reserva número (siguiente_numero_de, atómico) e inserta
--     un BORRADOR (created=true). Bajo el lock de la orden no hay carrera.
-- service_role-only (se invoca sólo desde el server; no usa get_my_role, que no
-- aplica bajo service_role).
CREATE OR REPLACE FUNCTION public.reclamar_o_crear_de(
  p_restaurant_id uuid,
  p_order_id      uuid,
  p_tipo_de       int,
  p_establecimiento text,
  p_punto         text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_doc   public.documentos_electronicos%ROWTYPE;
  v_num   bigint;
  v_exist boolean;
  v_stale_after constant interval := interval '2 minutes';   -- > maxDuration (30s)
BEGIN
  IF p_restaurant_id IS NULL OR p_order_id IS NULL OR p_tipo_de IS NULL
     OR p_establecimiento IS NULL OR p_punto IS NULL THEN
    RAISE EXCEPTION 'reclamar_o_crear_de: parámetros requeridos' USING ERRCODE = '22023';
  END IF;

  -- Lock de la orden (serializa emisiones concurrentes de la MISMA orden).
  -- También valida que la orden exista para ese restaurante.
  PERFORM 1 FROM public.orders o
    WHERE o.id = p_order_id AND o.restaurant_id = p_restaurant_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reclamar_o_crear_de: orden % no existe para el restaurante %', p_order_id, p_restaurant_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- ¿Ya hay un DE VIVO para esta orden? (el más nuevo).
  SELECT * INTO v_doc
    FROM public.documentos_electronicos d
   WHERE d.restaurant_id = p_restaurant_id
     AND d.order_id = p_order_id
     AND d.tipo_de = p_tipo_de
     AND d.estado IN ('BORRADOR','ENVIADO','GENERADO','APROBADO')
   ORDER BY d.created_at DESC
   LIMIT 1;
  v_exist := FOUND;

  IF v_exist THEN
    -- STALENESS-RECLAIM: BORRADOR/ENVIADO SIN CDC y viejo → abandonado. Reusar la
    -- misma fila (mismo número; sin CDC nada se emitió a SIFEN → sin duplicado).
    IF v_doc.cdc IS NULL
       AND v_doc.estado IN ('BORRADOR','ENVIADO')
       AND v_doc.updated_at < (now() - v_stale_after) THEN
      UPDATE public.documentos_electronicos
         SET estado = 'BORRADOR', motivo_rechazo = NULL, updated_at = now()
       WHERE id = v_doc.id
       RETURNING * INTO v_doc;
      RETURN jsonb_build_object('doc', row_to_json(v_doc), 'created', true);
    END IF;
    -- DE vivo real (con CDC, terminal-vivo, o reciente en vuelo) → idempotente.
    RETURN jsonb_build_object('doc', row_to_json(v_doc), 'created', false);
  END IF;

  -- No hay DE vivo → reservar número atómico e insertar BORRADOR.
  v_num := public.siguiente_numero_de(p_restaurant_id, p_tipo_de, p_establecimiento, p_punto);

  INSERT INTO public.documentos_electronicos
    (restaurant_id, order_id, tipo_de, establecimiento, punto, numero, estado, updated_at)
  VALUES
    (p_restaurant_id, p_order_id, p_tipo_de, p_establecimiento, p_punto,
     lpad(v_num::text, 7, '0'), 'BORRADOR', now())
  RETURNING * INTO v_doc;

  RETURN jsonb_build_object('doc', row_to_json(v_doc), 'created', true);
END;
$$;

REVOKE ALL ON FUNCTION public.reclamar_o_crear_de(uuid,uuid,int,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reclamar_o_crear_de(uuid,uuid,int,text,text) TO service_role;

-- ── 4) fiscal_inutilizaciones — bitácora de rangos inutilizados ─────────────
-- Un evento de inutilización quema un rango de numeración [desde..hasta] de un
-- (establecimiento, punto). Se registra SIEMPRE (éxito o rechazo de SIFEN) con
-- su resultado, para tener trazabilidad. Sin secretos.
CREATE TABLE IF NOT EXISTS public.fiscal_inutilizaciones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  tipo_documento  int  NOT NULL DEFAULT 1,
  establecimiento text NOT NULL,
  punto           text NOT NULL,
  serie           text,
  desde           bigint NOT NULL,
  hasta           bigint NOT NULL,
  motivo          text,
  resultado       text NOT NULL DEFAULT 'pendiente'
                    CHECK (resultado IN ('pendiente','aprobado','rechazado','error')),
  raw             jsonb,        -- request + respuesta cruda del upstream (sin secretos)
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fiscal_inutilizaciones_restaurant_idx
  ON public.fiscal_inutilizaciones (restaurant_id, created_at DESC);

-- RLS deny-all salvo service_role (mismo patrón que fiscal_config, mig 137).
ALTER TABLE public.fiscal_inutilizaciones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fiscal_inutilizaciones FROM PUBLIC, anon, authenticated;
GRANT  ALL ON public.fiscal_inutilizaciones TO service_role;
-- Intencionalmente SIN policies para anon/authenticated → default-deny.
-- NO se agrega a la publicación supabase_realtime.

COMMIT;

-- Recargar el cache de esquema de PostgREST (expone la tabla/función al service_role).
NOTIFY pgrst, 'reload schema';

SELECT 'migracion 139 aplicada (DE lifecycle: GENERADO/ERROR + UNIQUE parcial + reclamar_o_crear_de + fiscal_inutilizaciones)' AS status;
