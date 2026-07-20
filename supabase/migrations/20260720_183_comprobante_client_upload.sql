-- ════════════════════════════════════════════════════════════════════════
-- 183 · FASE D2 — El CLIENTE sube el comprobante (bucket privado + retención)
-- ────────────────────────────────────────────────────────────────────────
-- [PARA PEGAR EN SUPABASE]  ·  rol postgres, SQL Editor en INGLÉS.
--
-- Pedido de Renato (2026-07-20): que el PROPIO CLIENTE suba la foto del
-- comprobante al pagar por transferencia; el staff la corrobora en el detalle
-- del pedido ANTES de marcar pagado.
--
-- Cómo se hace SIN romper el lockdown de anon (migs 102/129/132):
--   1) Bucket PRIVADO `comprobantes` (los recibos tienen PII: nombre/banco del
--      pagador). anon SOLO puede INSERT (subir); NO puede leer/listar/borrar.
--      El staff (authenticated, tenant-scoped) puede SELECT → genera URL firmada
--      temporal para verlo. Público (anon) NO tiene SELECT → nadie enumera recibos.
--   2) El comprobante se adjunta al pedido por una RPC SECURITY DEFINER acotada
--      `attach_payment_proof(order_id,url,ref)` — el cliente NO recibe UPDATE de
--      orders (sigue cerrado); la RPC (derechos del owner) setea SOLO 3 campos y
--      solo en pedidos recientes (ventana 2h) → no puede tocar pedidos ajenos/viejos.
--      Mismo patrón que create_order (mig 131): carril chico y controlado.
--   3) RETENCIÓN 31 días: `list_old_comprobantes()` (para el cron service_role que
--      borra los archivos viejos vía la Storage API) → no se acumulan para siempre.
--
-- Todo ADITIVO y fail-open: si no se aplica, el cliente no puede subir (degrada:
-- muestra los datos de transferencia como hoy) y nada del cobro se rompe.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1) Bucket privado para los comprobantes ──────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('comprobantes','comprobantes', false, 5242880, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET
  public             = false,           -- PRIVADO (PII del pagador)
  file_size_limit    = 5242880,
  allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp'];

-- ── 2) Policies de storage.objects para el bucket comprobantes ───────────
-- anon: SOLO subir (INSERT). Sin SELECT/UPDATE/DELETE → no lee ni lista recibos.
DROP POLICY IF EXISTS comp_anon_insert ON storage.objects;
CREATE POLICY comp_anon_insert ON storage.objects FOR INSERT TO anon
  WITH CHECK (bucket_id = 'comprobantes' AND (storage.foldername(name))[1] IS NOT NULL);

-- authenticated (staff): subir dentro de la carpeta de un local de su empresa.
DROP POLICY IF EXISTS comp_auth_insert ON storage.objects;
CREATE POLICY comp_auth_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'comprobantes' AND (
      public.get_my_role() = 'superadmin'
      OR (storage.foldername(name))[1] IN (SELECT rid::text FROM public.get_my_company_restaurant_ids() AS rid)
    )
  );

-- authenticated (staff): LEER solo los de su empresa → habilita createSignedUrl.
DROP POLICY IF EXISTS comp_auth_select ON storage.objects;
CREATE POLICY comp_auth_select ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'comprobantes' AND (
      public.get_my_role() = 'superadmin'
      OR (storage.foldername(name))[1] IN (SELECT rid::text FROM public.get_my_company_restaurant_ids() AS rid)
    )
  );

-- authenticated (staff): borrar los de su empresa (limpieza manual opcional).
DROP POLICY IF EXISTS comp_auth_delete ON storage.objects;
CREATE POLICY comp_auth_delete ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'comprobantes' AND (
      public.get_my_role() = 'superadmin'
      OR (storage.foldername(name))[1] IN (SELECT rid::text FROM public.get_my_company_restaurant_ids() AS rid)
    )
  );

-- ── 3) Adjuntar el comprobante al pedido (RPC acotada, no reabre orders) ──
-- El cliente crea el pedido por create_order (mig 131) y DESPUÉS adjunta el
-- comprobante con esta RPC. Setea SOLO payment_proof_url/payment_reference y
-- deja el pedido en payment_review_status='pending' (esperando validación del
-- staff). Ventana de 2h: no permite tocar pedidos viejos/ajenos por fuerza bruta.
CREATE OR REPLACE FUNCTION public.attach_payment_proof(p_order_id uuid, p_url text, p_reference text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_created timestamptz;
BEGIN
  IF p_order_id IS NULL OR NULLIF(p_url,'') IS NULL THEN
    RAISE EXCEPTION 'order_id y url requeridos' USING ERRCODE = '22023';
  END IF;
  SELECT created_at INTO v_created FROM public.orders WHERE id = p_order_id;
  IF v_created IS NULL THEN
    RAISE EXCEPTION 'pedido inexistente' USING ERRCODE = '22023';
  END IF;
  IF v_created < now() - interval '2 hours' THEN
    RAISE EXCEPTION 'pedido fuera de ventana' USING ERRCODE = '22023';
  END IF;
  UPDATE public.orders
     SET payment_proof_url     = p_url,
         payment_reference     = COALESCE(NULLIF(p_reference,''), payment_reference),
         payment_review_status = 'pending'
   WHERE id = p_order_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.attach_payment_proof(uuid, text, text) TO anon, authenticated;

-- ── 4) Retención: listar comprobantes con > N días (para el cron de purga) ─
-- El cron (service_role) toma estos nombres y borra los archivos por la Storage
-- API (borrar la fila de storage.objects sola NO libera el archivo físico).
CREATE OR REPLACE FUNCTION public.list_old_comprobantes(p_days int DEFAULT 31)
RETURNS SETOF text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT o.name FROM storage.objects o
   WHERE o.bucket_id = 'comprobantes'
     AND o.created_at < now() - (GREATEST(p_days,1) || ' days')::interval;
$$;
REVOKE ALL ON FUNCTION public.list_old_comprobantes(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_old_comprobantes(int) TO service_role;

COMMENT ON FUNCTION public.attach_payment_proof(uuid,text,text) IS
  'FASE D2: el cliente adjunta la foto del comprobante a su pedido reciente (ventana 2h). Setea payment_proof_url/reference + payment_review_status=pending. No otorga UPDATE de orders a anon.';
COMMENT ON FUNCTION public.list_old_comprobantes(int) IS
  'FASE D2 retención: nombres de objetos del bucket comprobantes con más de N días (default 31). Lo consume el cron service_role /api/cron/purge-comprobantes.';

COMMIT;

NOTIFY pgrst, 'reload schema';

SELECT 'migración 183 aplicada — cliente sube comprobante (bucket privado + attach RPC + retención 31d)' AS status;
