-- ════════════════════════════════════════════════════════════════════
-- 173 · Modo de operación del local: SALÓN (mesas+QR) vs DELIVERY (a domicilio)
--       (PREPARED — NOT APPLIED: aplicar manualmente tras backup nuevo,
--        Supabase SQL Editor en INGLÉS, rol postgres. Claude Code NO la aplica.)
-- ────────────────────────────────────────────────────────────────────
-- OBJETIVO (Renato, 2026-07-11): el plan Emprendedor (tier de entrada) se ofrece
-- en DOS modos que el local elige al contratar:
--   · 'salon'    → atiende en el local: Menú QR (index) + mesas.  (DEFAULT)
--   · 'delivery' → atiende SOLO a domicilio: se DESBLOQUEA el panel cliente de
--                  delivery (delivery-cliente, con menú + ubicación) y se BLOQUEAN
--                  el Menú QR y las mesas. Delivery "lite": el dueño gestiona los
--                  pedidos desde Admin → Pedidos (que ya muestran la dirección —
--                  botón "Ver detalle"); SIN flota de riders ni tracking en mapa
--                  (eso sigue siendo diferencial del plan Premium).
--
-- POR QUÉ ASÍ (restricción técnica real):
--   · El Menú QR (index.html) y el panel delivery-cliente corren ANÓNIMOS. La RPC
--     get_restaurant_capabilities devuelve NULL para anon (guard mig 108), así que
--     el gating anónimo NO puede usarla. Se resuelve con:
--       (a) la columna PÚBLICA restaurants.service_mode → el Menú QR se auto-bloquea
--           cuando el local es 'delivery' (lectura anon, agregada acá);
--       (b) la RPC anon-safe restaurant_panel_enabled (mig 109) → habilita el panel
--           delivery-cliente.
--   · delivery-cliente HOY está gateado por plan (sólo Premium lo incluye en
--     allowed_panels). Para habilitarlo a un Emprendedor-delivery SIN meterlo en el
--     plan (lo tendrían TODOS los Emprendedor, incluidos los de salón), se agrega
--     UNA rama por service_mode en restaurant_panel_enabled: 'delivery-cliente' se
--     habilita también cuando service_mode='delivery'. Nada más cambia ahí.
--
-- ALCANCE (100% aditivo · idempotente · NO relaja RLS · no toca planes):
--   1. restaurants.service_mode (text, NOT NULL DEFAULT 'salon', CHECK salon|delivery).
--      Default 'salon' = comportamiento ACTUAL de todos los locales (sin regresión;
--      un Premium con delivery por plan sigue igual — 'salon' no bloquea delivery).
--   2. GRANT SELECT (service_mode) a anon. La mig 102 revocó el SELECT amplio de
--      restaurants y lo re-otorgó por columnas; sumamos ésta (igual que la mig 170
--      sumó las columnas half_and_half_*).
--   3. restaurant_panel_enabled: rama service_mode='delivery' → 'delivery-cliente'.
--
-- COMPATIBILIDAD DE DESPLIEGUE: el front degrada con gracia si esto NO está aplicado.
--   · index / admin / superadmin leen service_mode best-effort: ausente ⇒ undefined
--     ⇒ se comporta como 'salon' (Menú QR y mesas visibles). Se puede desplegar el
--     código antes o después. El desbloqueo de delivery-cliente por modo recién
--     funciona una vez aplicada esta migración.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1. Columna service_mode (default 'salon' = statu quo) ─────────────────────
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS service_mode text NOT NULL DEFAULT 'salon';

ALTER TABLE public.restaurants DROP CONSTRAINT IF EXISTS restaurants_service_mode_check;
ALTER TABLE public.restaurants
  ADD CONSTRAINT restaurants_service_mode_check CHECK (service_mode IN ('salon','delivery'));

-- ── 2. Exponer service_mode al rol anon (Menú QR / delivery-cliente son anon) ─
--    mig 102 hizo REVOKE SELECT ... TO anon y re-GRANT por columnas; agregamos ésta.
GRANT SELECT (service_mode) ON public.restaurants TO anon;

-- ── 3. restaurant_panel_enabled (mig 109) + rama por service_mode ─────────────
--    VERBATIM de la mig 109 con UN solo agregado: si el panel es 'delivery-cliente'
--    y el local está en modo delivery, habilitar (independiente del plan). El resto
--    (plan.allowed_panels ∪ add-ons, fail-closed) queda IDÉNTICO. CREATE OR REPLACE
--    idempotente; misma firma/grants → sin impacto en otros callers.
CREATE OR REPLACE FUNCTION public.restaurant_panel_enabled(p_restaurant_id uuid, p_panel text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_panels jsonb;
  v_addon  boolean;
  v_mode   text;
BEGIN
  -- Fail-closed ante parámetros incompletos.
  IF p_restaurant_id IS NULL OR p_panel IS NULL OR p_panel = '' THEN
    RETURN false;
  END IF;

  -- Rama NUEVA (mig 173): el panel cliente de delivery se habilita cuando el local
  -- opera en modo delivery (Emprendedor-delivery), sin depender del plan. Sólo
  -- afecta a p_panel='delivery-cliente'; ningún otro panel cambia de criterio.
  IF p_panel = 'delivery-cliente' THEN
    SELECT r.service_mode INTO v_mode
      FROM public.restaurants r WHERE r.id = p_restaurant_id;
    IF v_mode = 'delivery' THEN
      RETURN true;
    END IF;
  END IF;

  -- allowed_panels del plan de la suscripción más reciente del restaurante.
  SELECT sp.allowed_panels
    INTO v_panels
    FROM public.subscriptions s
    JOIN public.subscription_plans sp ON sp.id = s.plan_id
   WHERE s.restaurant_id = p_restaurant_id
   ORDER BY s.created_at DESC
   LIMIT 1;

  -- jsonb `?` = ¿el string es elemento del array? (allowed_panels es array).
  IF v_panels IS NOT NULL AND (v_panels ? p_panel) THEN
    RETURN true;
  END IF;

  -- O habilitado vía add-on contratado y activo (mismo criterio que la 090/108).
  SELECT EXISTS (
    SELECT 1
      FROM public.restaurant_addons ra
      JOIN public.plan_addons pa ON pa.key = ra.addon_key
     WHERE ra.restaurant_id = p_restaurant_id
       AND ra.enabled = true
       AND pa.panel = p_panel
  ) INTO v_addon;

  RETURN COALESCE(v_addon, false);   -- fail-closed por defecto
END;
$$;

GRANT EXECUTE ON FUNCTION public.restaurant_panel_enabled(uuid, text) TO anon, authenticated;

COMMIT;

-- Recargar el cache de esquema de PostgREST (columna nueva + privilegio + firma).
NOTIFY pgrst, 'reload schema';

SELECT 'migration 173 applied — restaurants.service_mode (salon|delivery) + delivery-cliente unlock por modo' AS status;
