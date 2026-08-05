-- ════════════════════════════════════════════════════════════════════════════
-- 208 — Red de Riders Mythos: PILOTO CERRADO
-- ════════════════════════════════════════════════════════════════════════════
-- La 207 dejó un solo interruptor global (`network_enabled`): o la red existe
-- para toda la plataforma, o no existe para nadie. Para probar el circuito
-- completo en un local real hace falta un tercer estado: la red ENCENDIDA pero
-- alcanzando sólo a los restaurantes elegidos a dedo.
--
-- Mismo criterio que la beta cerrada de `/clientes` (mig 200, `diner_app_access`):
-- la allowlist vive en la BASE, no en la pantalla. Esconder el botón nunca es la
-- única defensa — con la lista sólo en el front, cualquiera con la anon key y
-- las RPC a mano metía a su restaurante en la red.
--
-- El portero es UNO SOLO: `mythos_network_on(restaurant_id)`. Misma decisión que
-- `resolve_supplier_entitlement` en la 178/199 — un segundo criterio en paralelo
-- es exactamente el drift que costó la mig 160.
--
-- No hace falta reescribir el despacho: `_rider_offer_next`,
-- `assign_delivery_order`, `_sweep_unassigned_delivery`, `rider_join_place` y
-- `rider_network_places` YA exigen `mythos_delivery_partners.status = 'activo'`.
-- Alcanza con impedir que un local fuera del piloto llegue a ese estado, y toda
-- la cadena queda cerrada sola.
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1) La allowlist ─────────────────────────────────────────────────────────
ALTER TABLE public.mythos_rider_config
  ADD COLUMN IF NOT EXISTS pilot_mode           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pilot_restaurant_ids UUID[]  NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.mythos_rider_config.pilot_mode IS
  'Piloto cerrado: con la red encendida, sólo los restaurantes de pilot_restaurant_ids pueden ser socios activos. Los riders se siguen postulando normalmente (son de la plataforma, no de un local).';
COMMENT ON COLUMN public.mythos_rider_config.pilot_restaurant_ids IS
  'Restaurantes habilitados durante el piloto. Se edita en Superadmin › Riders › Configuración.';


-- ── 2) EL portero único ─────────────────────────────────────────────────────
-- Fail-CLOSED a propósito: sin fila de config, con p_restaurant_id NULL, o con
-- la red apagada, devuelve false. Un portero que ante la duda deja pasar no es
-- un portero.
CREATE OR REPLACE FUNCTION public.mythos_network_on(p_restaurant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT COALESCE((
    SELECT COALESCE(c.network_enabled, false)
       AND (NOT COALESCE(c.pilot_mode, false)
            OR p_restaurant_id = ANY (COALESCE(c.pilot_restaurant_ids, '{}'::uuid[])))
      FROM public.mythos_rider_config c
     WHERE c.id
  ), false);
$$;

COMMENT ON FUNCTION public.mythos_network_on(uuid) IS
  'Portero canónico de la Red de Riders Mythos para UN restaurante: red encendida Y (piloto apagado O restaurante en la allowlist). Único criterio — no crear un segundo.';

REVOKE ALL ON FUNCTION public.mythos_network_on(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mythos_network_on(uuid) TO authenticated;


-- ── 3) El portero, en la base ───────────────────────────────────────────────
-- Cierra TODAS las puertas de una vez: ninguna fila de socio llega a 'activo'
-- fuera del piloto, ni por RPC, ni por el panel del superadmin, ni por un
-- UPDATE suelto. Aguas abajo, el despacho ya filtra por ese estado.
CREATE OR REPLACE FUNCTION public._mythos_partner_pilot_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF NEW.status = 'activo' AND NOT public.mythos_network_on(NEW.restaurant_id) THEN
    RAISE EXCEPTION 'la Red de Riders Mythos está en piloto cerrado: este restaurante todavía no está habilitado'
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mythos_partner_pilot_guard ON public.mythos_delivery_partners;
CREATE TRIGGER trg_mythos_partner_pilot_guard
  BEFORE INSERT OR UPDATE OF status ON public.mythos_delivery_partners
  FOR EACH ROW EXECUTE FUNCTION public._mythos_partner_pilot_guard();


-- ── 4) Cambiar la allowlist tiene efecto sobre lo que YA está activo ────────
-- Sin esto, "piloto cerrado" no restringiría nada: los locales que entraron
-- antes de encenderlo seguirían despachando por la red. Se PAUSA (reversible),
-- nunca se rechaza — 'rechazado' es una decisión sobre la solicitud, no un
-- efecto colateral de mover un interruptor.
CREATE OR REPLACE FUNCTION public._mythos_pilot_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF COALESCE(NEW.pilot_mode, false) THEN
    UPDATE public.mythos_delivery_partners p
       SET status = 'pausado', updated_at = now()
     WHERE p.status = 'activo'
       AND NOT (p.restaurant_id = ANY (COALESCE(NEW.pilot_restaurant_ids, '{}'::uuid[])));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mythos_pilot_sync ON public.mythos_rider_config;
CREATE TRIGGER trg_mythos_pilot_sync
  AFTER UPDATE OF pilot_mode, pilot_restaurant_ids ON public.mythos_rider_config
  FOR EACH ROW EXECUTE FUNCTION public._mythos_pilot_sync();


-- ── 5) El local que pide entrar ─────────────────────────────────────────────
-- Se repone entera (la 207 chequeaba sólo `network_enabled`). Único cambio: el
-- portero pasa a ser `mythos_network_on`, con dos mensajes distintos según por
-- qué no puede entrar — "todavía no abrimos" y "abrimos pero no para vos" son
-- situaciones distintas y el dueño merece saber cuál es la suya.
CREATE OR REPLACE FUNCTION public.request_mythos_delivery(p_restaurant_id uuid, payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_cfg public.mythos_rider_config%ROWTYPE; v_st TEXT;
BEGIN
  IF NOT (public.get_my_role() = 'superadmin'
          OR (public.get_my_role() = 'admin'
              AND p_restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))) THEN
    RAISE EXCEPTION 'sólo el administrador del local puede solicitarlo' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_cfg FROM public.mythos_rider_config WHERE id;
  IF NOT COALESCE(v_cfg.network_enabled, false) THEN
    RAISE EXCEPTION 'la red de riders todavía no está disponible' USING ERRCODE = '22023';
  END IF;
  IF NOT public.mythos_network_on(p_restaurant_id) THEN
    RAISE EXCEPTION 'la Red de Riders Mythos está en piloto cerrado y este restaurante todavía no está habilitado'
      USING ERRCODE = '22023';
  END IF;

  SELECT status INTO v_st FROM public.mythos_delivery_partners WHERE restaurant_id = p_restaurant_id;
  IF v_st = 'activo' THEN RETURN jsonb_build_object('ok', true, 'status', 'activo'); END IF;

  INSERT INTO public.mythos_delivery_partners (
    restaurant_id, status, pay_type, pay_value, pay_method, dispatch_mode,
    max_riders, auto_accept_riders, contact_name, contact_phone, note, requested_by)
  VALUES (
    p_restaurant_id, 'pendiente',
    COALESCE(NULLIF(btrim(payload->>'pay_type'),''), 'fixed'),
    COALESCE(NULLIF(btrim(payload->>'pay_value'),'')::numeric, 0),
    COALESCE(NULLIF(btrim(payload->>'pay_method'),''), 'transferencia'),
    COALESCE(NULLIF(btrim(payload->>'dispatch_mode'),''), 'oferta'),
    NULLIF(btrim(payload->>'max_riders'),'')::int,
    COALESCE((payload->>'auto_accept_riders')::boolean, true),
    left(NULLIF(btrim(payload->>'contact_name'),''), 120),
    left(NULLIF(btrim(payload->>'contact_phone'),''), 40),
    left(NULLIF(btrim(payload->>'note'),''), 1000),
    auth.uid())
  ON CONFLICT (restaurant_id) DO UPDATE SET
    status        = CASE WHEN public.mythos_delivery_partners.status = 'rechazado'
                         THEN 'pendiente' ELSE public.mythos_delivery_partners.status END,
    pay_type      = EXCLUDED.pay_type,
    pay_value     = EXCLUDED.pay_value,
    pay_method    = EXCLUDED.pay_method,
    dispatch_mode = EXCLUDED.dispatch_mode,
    max_riders    = EXCLUDED.max_riders,
    auto_accept_riders = EXCLUDED.auto_accept_riders,
    contact_name  = EXCLUDED.contact_name,
    contact_phone = EXCLUDED.contact_phone,
    note          = EXCLUDED.note,
    requested_at  = now(),
    updated_at    = now();

  -- Cambiar el modo de despacho tiene que llegar a las fichas ya creadas, o el
  -- local pasaría a "oferta" y sus riders de red seguirían recibiendo pedidos
  -- automáticamente (la config diría una cosa y el despacho haría otra).
  UPDATE public.delivery_riders dr
     SET dispatch_auto = (SELECT p.dispatch_mode = 'auto'
                            FROM public.mythos_delivery_partners p
                           WHERE p.restaurant_id = dr.restaurant_id)
   WHERE dr.restaurant_id = p_restaurant_id AND dr.mythos_rider_id IS NOT NULL;

  RETURN jsonb_build_object('ok', true, 'status',
    (SELECT status FROM public.mythos_delivery_partners WHERE restaurant_id = p_restaurant_id));
END;
$$;

REVOKE ALL ON FUNCTION public.request_mythos_delivery(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_mythos_delivery(uuid,jsonb) TO authenticated;


-- ── 6) Lo que ve el local: un diagnóstico, no un cartel genérico ───────────
-- La 207 devolvía sólo `network_enabled`, y el panel mostraba la MISMA tarjeta
-- para dos situaciones opuestas: "falta aplicar la migración" (problema
-- técnico) y "la red está apagada" (decisión de negocio). Ahora viaja
-- `availability`, que distingue los tres casos.
CREATE OR REPLACE FUNCTION public.mythos_partner_panel(p_restaurant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_cfg public.mythos_rider_config%ROWTYPE;
  v_p   public.mythos_delivery_partners%ROWTYPE;
  v_riders jsonb; v_offers jsonb; v_avail TEXT;
BEGIN
  IF NOT (public.get_my_role() = 'superadmin'
          OR p_restaurant_id IN (SELECT public.get_my_company_restaurant_ids())) THEN
    RAISE EXCEPTION 'sin permiso' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_cfg FROM public.mythos_rider_config WHERE id;
  SELECT * INTO v_p   FROM public.mythos_delivery_partners WHERE restaurant_id = p_restaurant_id;

  v_avail := CASE
    WHEN NOT COALESCE(v_cfg.network_enabled, false)          THEN 'off'
    WHEN NOT public.mythos_network_on(p_restaurant_id)       THEN 'pilot'
    ELSE 'on' END;

  -- Del rider de la red el local ve lo operativo: quién es, en qué anda y cómo
  -- rinde. NO ve su documento, su domicilio ni su cuenta bancaria — eso es de
  -- la persona, no del local (la cuenta bancaria aparece recién en la
  -- liquidación, que es cuando hace falta para pagarle).
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'link_id', dr.id, 'rider_id', mr.id,
           'name', NULLIF(btrim(COALESCE(mr.first_name,'')||' '||COALESCE(mr.last_name,'')),''),
           'photo_url', mr.photo_url, 'vehicle', mr.vehicle_type, 'city', mr.city,
           'phone', mr.phone,
           'status', mr.status, 'availability', mr.availability,
           'link_status', dr.link_status, 'linked_at', dr.linked_at,
           'rating_avg', mr.rating_avg, 'rating_count', mr.rating_count,
           'deliveries_here', (SELECT count(*) FROM public.delivery_orders o
                                WHERE o.rider_id = dr.id AND o.rider_status = 'delivered'),
           'active_here', (SELECT count(*) FROM public.delivery_orders o
                            WHERE o.rider_id = dr.id
                              AND o.rider_status IN ('confirmed','picked_up','on_way'))
         ) ORDER BY mr.first_name), '[]'::jsonb)
    INTO v_riders
    FROM public.delivery_riders dr
    JOIN public.mythos_riders mr ON mr.id = dr.mythos_rider_id
   WHERE dr.restaurant_id = p_restaurant_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', f.id, 'order_id', f.delivery_order_id, 'status', f.status,
           'seq', f.seq, 'offered_at', f.offered_at, 'expires_at', f.expires_at,
           'rider', NULLIF(btrim(COALESCE(mr.first_name,'')||' '||COALESCE(mr.last_name,'')),'')
         ) ORDER BY f.offered_at DESC), '[]'::jsonb)
    INTO v_offers
    FROM (SELECT * FROM public.mythos_rider_offers
           WHERE restaurant_id = p_restaurant_id ORDER BY offered_at DESC LIMIT 25) f
    JOIN public.mythos_riders mr ON mr.id = f.rider_id;

  RETURN jsonb_build_object(
    'network_enabled', COALESCE(v_cfg.network_enabled, false),
    'availability',    v_avail,
    'partner', CASE WHEN v_p.restaurant_id IS NULL THEN NULL ELSE to_jsonb(v_p) END,
    'riders',  v_riders,
    'offers',  v_offers
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mythos_partner_panel(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mythos_partner_panel(uuid) TO authenticated;
