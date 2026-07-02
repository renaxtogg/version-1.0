-- ════════════════════════════════════════════════════════════════════
-- 138 · documentos_electronicos — emisión de DE (SIFEN/FacturaSend)
-- ────────────────────────────────────────────────────────────────────
-- PR-FE-2. Depende de la mig 137 (fiscal_config). SOLO sandbox por ahora.
-- 1 PR = 1 causa: "emitir un Documento Electrónico (factura)".
--
-- Guarda 1 fila por DE emitido, con su estado en el ciclo SIFEN. La API key
-- del proveedor NO vive acá (está cifrada en fiscal_config, mig 137). Esta tabla
-- no tiene secretos: sólo metadatos del documento + el JSON crudo (raw).
--
-- Numeración: el número de comprobante es secuencial por
-- (restaurant_id, tipo_de, establecimiento, punto) y lo lleva la DB de forma
-- ATÓMICA (tabla fiscal_secuencias + función siguiente_numero_de, ambas
-- service_role-only). SIFEN tolera huecos pero NO repetición.
--
-- RLS:
--   • documentos_electronicos: la staff del restaurante LEE sus propios docs
--     (patrón mig 133: superadmin OR restaurant_id ∈ get_my_company_restaurant_ids()).
--     El WRITE (INSERT/UPDATE) es SÓLO service_role (server) — no hay policy de
--     escritura para authenticated/anon, y RLS default-deny cierra el resto.
--   • fiscal_secuencias: deny-all salvo service_role (como fiscal_config).
--
-- Idempotente. Revertir:
--   DROP FUNCTION IF EXISTS public.siguiente_numero_de(uuid,int,text,text);
--   DROP TABLE IF EXISTS public.documentos_electronicos;
--   DROP TABLE IF EXISTS public.fiscal_secuencias;
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ── documentos_electronicos ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.documentos_electronicos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  -- order_id NULLABLE: el DE de EJEMPLO (validación del pipeline) no tiene orden.
  order_id         uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  tipo_de          int  NOT NULL DEFAULT 1,      -- 1 = factura electrónica
  establecimiento  text,                         -- '001'
  punto            text,                          -- '001'
  numero           text,                          -- '0000001' (secuencial, zero-pad 7)
  cdc              text,                          -- Código de Control (44 díg.) que devuelve SIFEN
  estado           text NOT NULL DEFAULT 'BORRADOR'
                     CHECK (estado IN ('BORRADOR','ENVIADO','APROBADO','RECHAZADO','CANCELADO','INUTILIZADO')),
  lote_id          text,                          -- numeroLote que devuelve FacturaSend al enviar
  xml_url          text,                          -- URL del XML/KuDE si el proveedor la expone
  motivo_rechazo   text,                          -- visible cuando estado='RECHAZADO'
  raw              jsonb,                          -- DE enviado + respuesta cruda del upstream (sin secretos)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Anti-duplicado: un solo DE por (restaurante, orden, tipo). Con order_id NULL
-- (DE de ejemplo) el UNIQUE no aplica (NULLs distintos) → se permiten ejemplos.
CREATE UNIQUE INDEX IF NOT EXISTS documentos_electronicos_uq_order
  ON public.documentos_electronicos (restaurant_id, order_id, tipo_de);

CREATE INDEX IF NOT EXISTS documentos_electronicos_restaurant_idx
  ON public.documentos_electronicos (restaurant_id, created_at DESC);

ALTER TABLE public.documentos_electronicos ENABLE ROW LEVEL SECURITY;

-- Sin privilegios para anon; authenticated sólo SELECT (la policy acota filas).
REVOKE ALL ON public.documentos_electronicos FROM PUBLIC, anon, authenticated;
GRANT  SELECT ON public.documentos_electronicos TO authenticated;
GRANT  ALL    ON public.documentos_electronicos TO service_role;

-- Staff LEE sólo los docs de su empresa (mismo patrón que mig 133).
DROP POLICY IF EXISTS "de_auth_select" ON public.documentos_electronicos;
CREATE POLICY "de_auth_select" ON public.documentos_electronicos
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

-- SIN policy de INSERT/UPDATE/DELETE para authenticated → escritura sólo
-- service_role (bypassa RLS, opera SÓLO desde el server: api/facturasend/*).

-- ── fiscal_secuencias + siguiente_numero_de (numeración atómica) ────────────
CREATE TABLE IF NOT EXISTS public.fiscal_secuencias (
  restaurant_id   uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  tipo_de         int  NOT NULL,
  establecimiento text NOT NULL,
  punto           text NOT NULL,
  ultimo_numero   bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, tipo_de, establecimiento, punto)
);

ALTER TABLE public.fiscal_secuencias ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fiscal_secuencias FROM PUBLIC, anon, authenticated;
GRANT  ALL ON public.fiscal_secuencias TO service_role;
-- Sin policies → sólo service_role (que bypassa RLS) la toca.

-- Devuelve el SIGUIENTE número (atómico, sin condición de carrera) para el punto.
-- UPSERT con incremento en el mismo statement: dos emisiones concurrentes no
-- pueden obtener el mismo número (el UPDATE toma lock de la fila del contador).
CREATE OR REPLACE FUNCTION public.siguiente_numero_de(
  p_restaurant_id uuid, p_tipo_de int, p_establecimiento text, p_punto text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_num bigint;
BEGIN
  IF p_restaurant_id IS NULL OR p_tipo_de IS NULL
     OR p_establecimiento IS NULL OR p_punto IS NULL THEN
    RAISE EXCEPTION 'siguiente_numero_de: parámetros requeridos' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.fiscal_secuencias AS s
    (restaurant_id, tipo_de, establecimiento, punto, ultimo_numero, updated_at)
  VALUES (p_restaurant_id, p_tipo_de, p_establecimiento, p_punto, 1, now())
  ON CONFLICT (restaurant_id, tipo_de, establecimiento, punto)
  DO UPDATE SET ultimo_numero = s.ultimo_numero + 1, updated_at = now()
  RETURNING s.ultimo_numero INTO v_num;
  RETURN v_num;
END;
$$;

-- CREATE FUNCTION concede EXECUTE a PUBLIC por defecto → revocar y dar sólo a service_role.
REVOKE ALL ON FUNCTION public.siguiente_numero_de(uuid,int,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.siguiente_numero_de(uuid,int,text,text) TO service_role;

COMMIT;

-- Recargar el cache de esquema de PostgREST.
NOTIFY pgrst, 'reload schema';

SELECT 'migracion 138 aplicada (documentos_electronicos + fiscal_secuencias + siguiente_numero_de)' AS status;
