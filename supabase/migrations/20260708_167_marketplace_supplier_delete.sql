-- ════════════════════════════════════════════════════════════════════
-- 167 · marketplace_supplier_delete — Ciclo de vida del proveedor (borrado)
-- ────────────────────────────────────────────────────────────────────
-- PR-MKT-4. Cierra la gestión del ciclo de vida del proveedor en el panel
-- superadmin. El on/off Activo↔Inactivo YA existe (superadmin_set_supplier_estado,
-- mig 144: suspender = 'suspendido' = oculto del marketplace y de las búsquedas
-- de leads/contacto vía RLS estado='activo'; reactivar = 'activo'). Lo que
-- faltaba es el **borrado permanente** con cascada + auditoría.
--
-- Contenido:
--   1. superadmin_delete_supplier(p_supplier_id) → jsonb. Borrado permanente,
--      SOLO superadmin (fail-closed COALESCE + REVOKE FROM PUBLIC,anon +
--      search_path, patrón migs 144/135). Antes de borrar deja un evento
--      'supplier_deleted' en marketplace_events con un snapshot del "blast
--      radius" (nombre/ruc + conteos) para trazabilidad; el FK del evento es
--      ON DELETE SET NULL, así que el evento sobrevive al borrado.
--   2. REVOKE DELETE ON marketplace_suppliers FROM authenticated → el ÚNICO
--      camino de borrado pasa por la RPC auditada (defensa en profundidad;
--      hoy nada más borra proveedores directo, verificado en el frontend).
--   3. FIX (fuga de PII, review adversarial): la policy
--      mkp_contacts_restaurant_select (mig 142) revelaba el contacto
--      (telefono/whatsapp/email_comercial) de un proveedor mientras existiera
--      un lead, SIN chequear estado='activo'. Un proveedor suspendido/pausado
--      seguía filtrando su PII a cualquier restaurante que alguna vez lo
--      contactó (leyendo marketplace_supplier_contacts directo por PostgREST),
--      contradiciendo "Inactivo = oculto de las búsquedas de contacto". Se
--      recrea la policy agregando el gate estado='activo' que ya tienen sus
--      hermanas (suppliers/products/catalog_files). Sólo TIGHTENING: el
--      restaurante pierde el contacto cuando el proveedor deja de estar activo;
--      cero impacto cross-tenant (el lead sigue scopeado por empresa).
--
-- LIMITACIONES CONOCIDAS (documentadas, no bloqueantes — review adversarial):
--   · La solicitud (marketplace_applications) que originó al proveedor queda
--     estado='aprobada' tras el borrado (el FK application_id→applications es
--     SET NULL sólo al borrar la SOLICITUD, no el proveedor). approve-supplier.js
--     rechaza re-aprobar una solicitud ya 'aprobada' (409). Para re-onboardear
--     al mismo proveedor: nueva solicitud por el formulario público (el dedupe
--     sólo bloquea pendiente/en_revision). No se auto-muta la solicitud para no
--     re-ensuciar la bandeja en limpiezas de basura.
--   · Los archivos en Storage (buckets supplier-images/supplier-files, carpeta
--     = supplier_id: logo/banner/imágenes de producto/catálogos PDF) NO se
--     borran: un DELETE de tabla no cascada a storage.objects. Quedan huérfanos
--     (impacto bajo, basura). Purga futura: endpoint service_role tipo
--     /api/delete-restaurant, o GC manual del bucket por carpeta.
--
-- CASCADA (FKs ya definidos en mig 142) al borrar un marketplace_suppliers:
--   · marketplace_products          ON DELETE CASCADE  → se borran
--   · marketplace_leads             ON DELETE CASCADE  → se borran   (*)
--   · marketplace_conversations     ON DELETE CASCADE  → se borran
--       └ marketplace_messages      ON DELETE CASCADE  → se borran
--   · marketplace_supplier_contacts ON DELETE CASCADE  → se borran
--   · marketplace_catalog_files     ON DELETE CASCADE  → se borran
--   · marketplace_saved             ON DELETE CASCADE  → se borran
--   · marketplace_reviews           ON DELETE CASCADE  → se borran
--   · marketplace_supplier_users    ON DELETE CASCADE  → se borra el VÍNCULO
--   · marketplace_reports (target/reporter_supplier_id) ON DELETE SET NULL → sobreviven
--   · marketplace_events (supplier_id)                  ON DELETE SET NULL → sobreviven
--
-- (*) LEADS = núcleo del negocio. Decisión (borrado de proveedores de prueba/
--     basura, criterio Renato): se **cascadean** junto al proveedor, pero su
--     conteo queda snapshotteado en el evento 'supplier_deleted'. La UI muestra
--     el conteo (leads/productos/conversaciones) en el modal de confirmación
--     ANTES de borrar. Alternativa (bloquear el borrado si hay leads) = cambiar
--     el bloque marcado "OPCIÓN B" más abajo por un RAISE. No se eligió porque
--     el caso de uso es limpieza de basura.
--
-- La cuenta de acceso del proveedor (auth.users) NO se toca: sólo se borra el
-- vínculo marketplace_supplier_users → la cuenta queda inerte
-- (get_my_supplier_id() → NULL). Eliminar la cuenta Auth es una fase separada
-- que exige aprobación explícita (regla CLAUDE.md: no tocar Auth automático).
--
-- PREPARED — NOT APPLIED: aplicar A MANO en el SQL Editor del dashboard
-- (idioma en inglés) tras un backup, DESPUÉS de la 142/143/144. Idempotente.
-- Revertir:
--   DROP FUNCTION public.superadmin_delete_supplier(uuid);
--   GRANT DELETE ON public.marketplace_suppliers TO authenticated;
--   -- y recrear mkp_contacts_restaurant_select SIN el gate estado='activo'
--   -- (versión original de la mig 142, líneas 606-615) si se quisiera revertir
--   -- el fix de PII (NO recomendado).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. superadmin_delete_supplier ──────────────────────────────────
-- DEFINER (owner postgres): puede INSERT en marketplace_events (append-only
-- para authenticated, mig 142) y borrar la fila aunque authenticated pierda
-- el privilegio DELETE (punto 2).
CREATE OR REPLACE FUNCTION public.superadmin_delete_supplier(p_supplier_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sup   record;
  v_prod  int;
  v_leads int;
  v_convs int;
  v_files int;
  v_users int;
BEGIN
  -- Fail-closed: sólo superadmin (COALESCE por si get_my_role() es NULL/anon).
  IF NOT COALESCE(public.get_my_role() = 'superadmin', false) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_supplier_id IS NULL THEN
    RAISE EXCEPTION 'proveedor requerido' USING ERRCODE = '22023';
  END IF;

  SELECT id, nombre_comercial, ruc, slug, estado, application_id
    INTO v_sup
    FROM public.marketplace_suppliers
   WHERE id = p_supplier_id;
  IF v_sup.id IS NULL THEN
    RAISE EXCEPTION 'proveedor inexistente' USING ERRCODE = '22023';
  END IF;

  -- Blast radius (para snapshot de auditoría + eco a la UI).
  SELECT count(*) INTO v_prod  FROM public.marketplace_products        WHERE supplier_id = p_supplier_id;
  SELECT count(*) INTO v_leads FROM public.marketplace_leads          WHERE supplier_id = p_supplier_id;
  SELECT count(*) INTO v_convs FROM public.marketplace_conversations  WHERE supplier_id = p_supplier_id;
  SELECT count(*) INTO v_files FROM public.marketplace_catalog_files  WHERE supplier_id = p_supplier_id;
  SELECT count(*) INTO v_users FROM public.marketplace_supplier_users WHERE supplier_id = p_supplier_id;

  -- OPCIÓN B (no activa): bloquear el borrado si hay leads reales.
  --   IF v_leads > 0 THEN
  --     RAISE EXCEPTION 'el proveedor tiene % leads; suspendé en vez de borrar', v_leads
  --       USING ERRCODE = '23503';
  --   END IF;

  -- Auditoría ANTES del delete: marketplace_events.supplier_id es ON DELETE
  -- SET NULL, así que el evento sobrevive con supplier_id=NULL; la identidad y
  -- el blast radius quedan en metadata para trazabilidad permanente.
  INSERT INTO public.marketplace_events (event_type, supplier_id, actor_user, metadata)
  VALUES ('supplier_deleted', p_supplier_id, auth.uid(),
          jsonb_build_object(
            'supplier_id',              p_supplier_id,
            'nombre_comercial',         v_sup.nombre_comercial,
            'ruc',                      v_sup.ruc,
            'slug',                     v_sup.slug,
            'estado_previo',            v_sup.estado,
            'products_deleted',         v_prod,
            'leads_deleted',            v_leads,
            'conversations_deleted',    v_convs,
            'catalog_files_deleted',    v_files,
            'supplier_users_unlinked',  v_users
          ));

  -- Borrado permanente. La cascada (arriba) barre productos, leads,
  -- conversaciones+mensajes, contactos, archivos, guardados, reseñas y el
  -- vínculo de usuarios. reports/events → SET NULL (sobreviven).
  DELETE FROM public.marketplace_suppliers WHERE id = p_supplier_id;

  RETURN jsonb_build_object(
    'ok',               true,
    'deleted',          true,
    'nombre_comercial', v_sup.nombre_comercial,
    'counts', jsonb_build_object(
      'products',                v_prod,
      'leads',                   v_leads,
      'conversations',           v_convs,
      'catalog_files',           v_files,
      'supplier_users_unlinked', v_users
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.superadmin_delete_supplier(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.superadmin_delete_supplier(uuid) TO authenticated;

-- ─── 2. Cerrar el borrado directo ───────────────────────────────────
-- El único camino de borrado queda la RPC auditada. La policy
-- mkp_suppliers_superadmin_all (FOR ALL) ya no puede ejercer DELETE porque el
-- privilegio de tabla se chequea ANTES que la RLS. anon ya tenía REVOKE ALL
-- (mig 142). El DEFINER de la RPC (owner) borra igual.
REVOKE DELETE ON public.marketplace_suppliers FROM authenticated;

-- ─── 3. FIX de fuga de PII en el contacto de proveedores inactivos ──
-- La policy original (mig 142) autorizaba la lectura directa de
-- marketplace_supplier_contacts con SÓLO la existencia de un lead, sin gate de
-- estado. Se recrea idéntica + "AND EXISTS(proveedor activo)" para que un
-- proveedor suspendido/pausado deje de filtrar telefono/whatsapp/email a los
-- restaurantes que alguna vez lo contactaron. Las policies del supplier dueño y
-- del superadmin NO se tocan (siguen viendo todo lo suyo / todo).
DROP POLICY IF EXISTS "mkp_contacts_restaurant_select" ON public.marketplace_supplier_contacts;
CREATE POLICY "mkp_contacts_restaurant_select" ON public.marketplace_supplier_contacts
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.marketplace_suppliers s
      WHERE s.id = marketplace_supplier_contacts.supplier_id
        AND s.estado = 'activo'
    )
    AND EXISTS (
      SELECT 1 FROM public.marketplace_leads l
      WHERE l.supplier_id = marketplace_supplier_contacts.supplier_id
        AND l.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  );

COMMIT;

-- Recargar el cache de esquema de PostgREST (función nueva)
NOTIFY pgrst, 'reload schema';

SELECT 'migracion 167 aplicada (marketplace: superadmin_delete_supplier + REVOKE DELETE directo + fix PII contacto inactivos)' AS status;
