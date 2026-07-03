-- ════════════════════════════════════════════════════════════════════
-- 143 · marketplace_chat_helpers — Marketplace B2B FASE 2 (chat operativo)
-- ────────────────────────────────────────────────────────────────────
-- PR-MKT-2. Tres RPCs SECURITY DEFINER fail-closed (patrón mig 135) que la
-- UI de chat necesita y que la RLS de la mig 142 no puede resolver sola:
--
--   1. ensure_conversation(p_supplier_id, p_restaurant_id) → uuid
--      Crea (o devuelve) la conversación del par proveedor-restaurante.
--      · lado restaurante: p_restaurant_id debe ser de SU empresa y el
--        proveedor estar activo. Si no hay un lead reciente (30 días) del
--        par, REGISTRA uno tipo 'contacto' canal 'chat': abrir un canal de
--        chat ES un contacto — el chat no puede ser una vía invisible al
--        funnel de leads (core del negocio, mig 142).
--      · lado proveedor: solo puede abrirla con un restaurante que YA lo
--        contactó (lead previo O conversación existente — el restaurante
--        puede haber iniciado por chat), y con su tienda NO suspendida
--        ('pausado' sí puede responder: la pausa la eligió él; la
--        suspensión es sanción de plataforma y congela el canal).
--   2. get_my_marketplace_conversations_info() → (conversation_id, counterpart_name)
--      Nombre de la contraparte de MIS conversaciones: el supplier no puede
--      leer public.restaurants (RLS) y el restaurante no puede leer
--      marketplace_suppliers pausados/suspendidos (policy estado='activo') —
--      esta RPC resuelve ambos lados sin debilitar ninguna policy. Devuelve
--      la UNIÓN de ambos lados (un usuario dual supplier+staff ve todo lo
--      suyo; un supplier puro obtiene vacío del lado restaurante).
--   3. marketplace_mark_read(p_conversation_id) → void
--      Resetea SOLO el contador unread del lado del caller. Necesaria porque
--      el supplier NO tiene UPDATE sobre marketplace_conversations (a
--      propósito, mig 142); los contadores los incrementa el trigger DEFINER
--      de marketplace_messages y esta RPC solo los pone en 0.
--
-- NO toca tablas, policies ni triggers existentes. Idempotente.
-- PREPARED — NOT APPLIED: aplicar a mano en el SQL Editor (inglés) tras backup.
-- Revertir: DROP FUNCTION public.ensure_conversation(uuid, uuid);
--           DROP FUNCTION public.get_my_marketplace_conversations_info();
--           DROP FUNCTION public.marketplace_mark_read(uuid);
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. ensure_conversation ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ensure_conversation(
  p_supplier_id   uuid,
  p_restaurant_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sid  uuid := public.get_my_supplier_id();
  v_conv uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_supplier_id IS NULL OR p_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'parámetros requeridos' USING ERRCODE = '22023';
  END IF;

  IF v_sid IS NOT NULL AND v_sid = p_supplier_id THEN
    -- Lado proveedor. La suspensión (sanción de plataforma) congela el canal;
    -- la pausa (elegida por el proveedor) NO le impide responder lo pendiente.
    IF EXISTS (
      SELECT 1 FROM public.marketplace_suppliers s
      WHERE s.id = p_supplier_id AND s.estado = 'suspendido'
    ) THEN
      RAISE EXCEPTION 'tu tienda está suspendida' USING ERRCODE = '42501';
    END IF;
    -- Solo responder a restaurantes que ya lo contactaron: lead previo o
    -- conversación existente (el restaurante pudo haber iniciado por chat).
    -- Sin esto, un supplier podría spamear a cualquier local.
    IF NOT EXISTS (
      SELECT 1 FROM public.marketplace_leads l
      WHERE l.supplier_id = p_supplier_id AND l.restaurant_id = p_restaurant_id
    ) AND NOT EXISTS (
      SELECT 1 FROM public.marketplace_conversations c
      WHERE c.supplier_id = p_supplier_id AND c.restaurant_id = p_restaurant_id
    ) THEN
      RAISE EXCEPTION 'ese restaurante todavía no te contactó' USING ERRCODE = '42501';
    END IF;
  ELSIF COALESCE(p_restaurant_id IN (SELECT public.get_my_company_restaurant_ids()), false) THEN
    -- Lado restaurante: el proveedor debe estar activo en el marketplace.
    IF NOT EXISTS (
      SELECT 1 FROM public.marketplace_suppliers s
      WHERE s.id = p_supplier_id AND s.estado = 'activo'
    ) THEN
      RAISE EXCEPTION 'proveedor no disponible' USING ERRCODE = '22023';
    END IF;
    -- Abrir un chat ES un contacto: registrar lead si no hay uno reciente
    -- del par (mismo dedupe de 30 días que request_supplier_contact). Así el
    -- chat nunca saltea el funnel de leads.
    IF NOT EXISTS (
      SELECT 1 FROM public.marketplace_leads l
      WHERE l.supplier_id = p_supplier_id
        AND l.restaurant_id = p_restaurant_id
        AND l.created_at > now() - interval '30 days'
    ) THEN
      INSERT INTO public.marketplace_leads (restaurant_id, supplier_id, tipo, canal, estado, created_by)
      VALUES (p_restaurant_id, p_supplier_id, 'contacto', 'chat', 'nueva', auth.uid());
    END IF;
  ELSIF COALESCE(public.get_my_role() = 'superadmin', false) THEN
    -- Superadmin (soporte/moderación): validar existencia para no filtrar
    -- un foreign_key_violation crudo (ERRCODEs consistentes con el resto).
    IF NOT EXISTS (SELECT 1 FROM public.marketplace_suppliers s WHERE s.id = p_supplier_id)
       OR NOT EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = p_restaurant_id) THEN
      RAISE EXCEPTION 'proveedor o restaurante inexistente' USING ERRCODE = '22023';
    END IF;
  ELSE
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  -- Upsert sin escritura dummy: DO NOTHING + lookup (no genera churn de
  -- tuplas ni disparará futuros triggers de UPDATE en conversations).
  INSERT INTO public.marketplace_conversations (supplier_id, restaurant_id)
  VALUES (p_supplier_id, p_restaurant_id)
  ON CONFLICT (supplier_id, restaurant_id) DO NOTHING
  RETURNING id INTO v_conv;

  IF v_conv IS NULL THEN
    SELECT c.id INTO v_conv
      FROM public.marketplace_conversations c
     WHERE c.supplier_id = p_supplier_id AND c.restaurant_id = p_restaurant_id;
  END IF;

  RETURN v_conv;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_conversation(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_conversation(uuid, uuid) TO authenticated;

-- ─── 2. get_my_marketplace_conversations_info ───────────────────────
CREATE OR REPLACE FUNCTION public.get_my_marketplace_conversations_info()
RETURNS TABLE (conversation_id uuid, counterpart_name text)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sid uuid := public.get_my_supplier_id();
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN; -- fail-closed: anon/sin sesión → vacío
  END IF;

  -- UNIÓN de ambos lados (sin RETURN excluyente): un usuario dual
  -- supplier+staff obtiene sus dos vistas; un supplier puro recibe vacío del
  -- lado restaurante (get_my_company_restaurant_ids() = conjunto vacío).
  IF v_sid IS NOT NULL THEN
    RETURN QUERY
      SELECT c.id, r.name
      FROM public.marketplace_conversations c
      JOIN public.restaurants r ON r.id = c.restaurant_id
      WHERE c.supplier_id = v_sid;
  END IF;

  RETURN QUERY
    SELECT c.id, s.nombre_comercial
    FROM public.marketplace_conversations c
    JOIN public.marketplace_suppliers s ON s.id = c.supplier_id
    WHERE c.restaurant_id IN (SELECT public.get_my_company_restaurant_ids());
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_marketplace_conversations_info() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_marketplace_conversations_info() TO authenticated;

-- ─── 3. marketplace_mark_read ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.marketplace_mark_read(p_conversation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sid  uuid := public.get_my_supplier_id();
  v_conv record;
BEGIN
  IF auth.uid() IS NULL OR p_conversation_id IS NULL THEN
    RETURN; -- fail-closed silencioso
  END IF;

  SELECT c.id, c.supplier_id, c.restaurant_id INTO v_conv
    FROM public.marketplace_conversations c WHERE c.id = p_conversation_id;
  IF v_conv.id IS NULL THEN
    RETURN;
  END IF;

  IF v_sid IS NOT NULL AND v_sid = v_conv.supplier_id THEN
    UPDATE public.marketplace_conversations
       SET supplier_unread = 0
     WHERE id = p_conversation_id AND supplier_unread <> 0;
  ELSIF COALESCE(v_conv.restaurant_id IN (SELECT public.get_my_company_restaurant_ids()), false) THEN
    UPDATE public.marketplace_conversations
       SET restaurant_unread = 0
     WHERE id = p_conversation_id AND restaurant_unread <> 0;
  END IF;
  -- Cualquier otro caller: no-op (nunca error, nunca toca contadores ajenos).
END;
$$;

REVOKE ALL ON FUNCTION public.marketplace_mark_read(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketplace_mark_read(uuid) TO authenticated;

COMMIT;

-- Recargar el cache de esquema de PostgREST (RPCs nuevas)
NOTIFY pgrst, 'reload schema';

SELECT 'migracion 143 aplicada (marketplace chat helpers: ensure_conversation + conversations_info + mark_read)' AS status;
