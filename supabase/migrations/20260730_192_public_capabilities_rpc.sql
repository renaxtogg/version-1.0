-- ════════════════════════════════════════════════════════════════════
-- 192 · get_public_capabilities — capacidades visibles por el CLIENTE (rol anon)
--       (PREPARED — NOT APPLIED: aplicar manualmente tras backup nuevo,
--        Supabase SQL Editor en INGLÉS, rol postgres. Claude Code NO la aplica.)
-- ────────────────────────────────────────────────────────────────────
-- PROBLEMA (obs. Renato 2026-07-30): "bloquear reserva al abrir cliente QR".
-- public/index.html (Menú QR) y delivery-cliente corren como `anon`, y
-- get_restaurant_capabilities tiene guard tenant-safe (mig 108) que a `anon` le
-- devuelve NULL. O sea: la superficie del cliente NO PUEDE VER EL PLAN, y por eso
-- ofrecía "Reservar mesa" en todos los planes, incluso los que no incluyen Agenda.
--
-- Lo único que anon podía consultar hasta hoy era restaurant_panel_enabled (mig
-- 176), que es granularidad de PANEL, no de feature.
--
-- FIX: una RPC de solo lectura, SECURITY DEFINER, que expone una LISTA BLANCA de
-- flags de cara al cliente. NO devuelve PII, ni precios, ni topes, ni el nombre del
-- plan, ni allowed_panels: solo booleanos de "qué se le ofrece al comensal".
-- Agregar un flag nuevo acá es una decisión deliberada, no un descuido.
--
-- SEMÁNTICA (coherente con el resto del gating):
--   · reservations = el plan incluye admin:agenda (o hay override ON del superadmin)
--                    Y el local NO opera en modo delivery (mig 173: sin salón no hay
--                    mesa que reservar) Y la suscripción está habilitante (mig 163).
--   · Sin suscripción habilitante ⇒ false (corte por facturación, igual que 176).
--   · REGLA DE TRANSICIÓN: si el plan todavía NO declara ninguna key de 2ª
--     generación (o sea, la mig 191 no corrió), reservations = true — fail-open,
--     idéntico a lo que hace public/mythos-gating.js. Así esta migración se puede
--     aplicar ANTES o DESPUÉS de la 191 sin apagar reservas por accidente.
--
-- ALCANCE: crea UNA función nueva. NO toca tablas, NO toca RLS, NO toca funciones
-- existentes. Idempotente (CREATE OR REPLACE).
-- ════════════════════════════════════════════════════════════════════
BEGIN;

CREATE OR REPLACE FUNCTION public.get_public_capabilities(p_restaurant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_feats     jsonb;
  v_mode      text;
  v_entitled  boolean;
  v_ovr       boolean;
  v_knows_g2  boolean;
  v_agenda    boolean;
BEGIN
  IF p_restaurant_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT r.service_mode INTO v_mode
    FROM public.restaurants r WHERE r.id = p_restaurant_id;

  IF NOT FOUND THEN
    RETURN NULL;                       -- restaurante inexistente: nada que informar
  END IF;

  -- Suscripción habilitante (regla canónica mig 163, inlineada para autosuficiencia).
  v_entitled := EXISTS (
    SELECT 1 FROM public.subscriptions s
     WHERE s.restaurant_id = p_restaurant_id
       AND ( s.status IN ('active','past_due')
             OR (s.status = 'trial' AND s.end_date >= CURRENT_DATE) )
  );

  -- allowed_features del plan de la suscripción más nueva HABILITANTE.
  SELECT sp.allowed_features
    INTO v_feats
    FROM public.subscriptions s
    JOIN public.subscription_plans sp ON sp.id = s.plan_id
   WHERE s.restaurant_id = p_restaurant_id
     AND ( s.status IN ('active','past_due')
           OR (s.status = 'trial' AND s.end_date >= CURRENT_DATE) )
   ORDER BY s.created_at DESC
   LIMIT 1;

  -- ¿El plan ya conoce la 2ª generación? (mig 191). Si no, fail-open.
  v_knows_g2 := COALESCE(v_feats, '[]'::jsonb) ?| array['admin:agenda','admin:personal'];

  -- Override explícito por restaurante (mig 146) — manda sobre el plan.
  SELECT o.enabled INTO v_ovr
    FROM public.restaurant_feature_overrides o
   WHERE o.restaurant_id = p_restaurant_id
     AND o.key = 'feature:admin:agenda';

  IF FOUND THEN
    v_agenda := v_ovr;
  ELSIF NOT v_knows_g2 THEN
    v_agenda := true;                              -- transición: plan pre-191
  ELSE
    v_agenda := COALESCE(v_feats, '[]'::jsonb) ? 'admin:agenda';
  END IF;

  RETURN jsonb_build_object(
    -- LISTA BLANCA. Nada de PII / precios / topes / nombre de plan / paneles.
    'reservations', (v_agenda AND v_entitled AND COALESCE(v_mode,'salon') <> 'delivery'),
    'service_mode', COALESCE(v_mode, 'salon')
  );
END;
$$;

REVOKE ALL     ON FUNCTION public.get_public_capabilities(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_public_capabilities(uuid) TO anon, authenticated;

COMMIT;

-- Recargar el cache de esquema de PostgREST (función nueva).
NOTIFY pgrst, 'reload schema';

-- ── Verificación (correr aparte) ─────────────────────────────────────────────
--   (a) Como anon debe responder sin error y sin datos sensibles:
--     SELECT public.get_public_capabilities('<restaurant_id>');
--   (b) Antes de la 191 (plan sin keys de 2ª gen) → reservations = true.
--   (c) Después de la 191, en un local con plan Emprendedor → reservations = false.
--   (d) Un local en modo delivery → reservations = false, service_mode = 'delivery'.
SELECT 'migration 192 applied — get_public_capabilities (anon) para gatear la reserva en el Menú QR' AS status;
