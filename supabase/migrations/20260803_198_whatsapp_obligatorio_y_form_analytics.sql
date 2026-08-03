-- ════════════════════════════════════════════════════════════════════════
-- 198 · WhatsApp obligatorio para contactar + reporte de formularios
-- ────────────────────────────────────────────────────────────────────────
-- [PARA PEGAR EN SUPABASE]  ·  rol postgres, SQL Editor en INGLÉS.
--
-- Dos problemas, uno consecuencia del otro:
--
-- 1) HABÍA REGISTRADOS A LOS QUE NO SE PODÍA ESCRIBIR.
--    El registro de dueños (/registro) pedía SOLO email, y `leads_prospectos`
--    ni siquiera tenía columna para un teléfono: un dueño se registraba, no
--    verificaba el correo, y no quedaba NINGUNA forma de contactarlo. En
--    Paraguay el canal real es WhatsApp, no el mail. Ahora el WhatsApp es
--    obligatorio en los tres formularios públicos, y la obligación vive
--    TAMBIÉN en la base (policy / RPC): esconder un asterisco en el HTML no
--    es una validación — cualquiera puede postear con la anon key.
--      · leads_prospectos → columnas `nombre` y `whatsapp` + policy de anon
--        que exige ≥8 dígitos cuando origen='web_registro'.
--      · marketing_leads  → policy de anon que exige ≥8 dígitos.
--      · submit_supplier_application → deja de aceptar "teléfono O WhatsApp"
--        y pasa a exigir WhatsApp (el teléfono sigue siendo opcional).
--    El botón "Soy dueño de un foodpark — Próximamente" (origen
--    'interes_foodpark') queda EXENTO a propósito: se toca antes de completar
--    el formulario y exigirle WhatsApp perdería el conteo de interés, que es
--    todo lo que ese botón captura.
--
-- 2) NADIE PODÍA VER QUÉ CONTESTABA LA GENTE.
--    Los formularios se guardaban pero solo se leían de a una fila, en tablas
--    distintas y desde tres páginas distintas del Superadmin. No había manera
--    de responder "¿cuántos dueños tienen delivery propio?" o "¿qué medio de
--    pago pide todo el mundo?" — que es justamente para lo que se preguntan.
--    `form_analytics()` agrega DEL LADO DE LA BASE, sobre todo el historial,
--    y devuelve un conteo por CADA opción de cada pregunta. La pestaña
--    Superadmin › Sitio web › Formularios lo dibuja con la forma del
--    formulario original (incluidas las opciones que nadie eligió, que son
--    justamente las que hay que mirar).
--
--    Se agrega en la base y no en el navegador por el mismo motivo que
--    `crm_customer_stats` (mig 197): el panel carga los leads con .limit(500),
--    así que agrupar ese array daría un número que EMPEORA cuanto más crece
--    el negocio — el error silencioso más caro que tuvo este proyecto.
--
-- Todo ADITIVO e idempotente. Cada bloque del reporte está aislado en su
-- propio sub-bloque con EXCEPTION: si una tabla todavía no existe (p. ej.
-- `customers` sin la mig 196), esa sección devuelve {"disponible": false} y
-- el resto del reporte sigue saliendo.
--
-- REVERSA:
--   ALTER TABLE public.leads_prospectos DROP COLUMN IF EXISTS whatsapp;
--   ALTER TABLE public.leads_prospectos DROP COLUMN IF EXISTS nombre;
--   DROP FUNCTION IF EXISTS public.form_analytics(timestamptz, timestamptz);
--   -- y restaurar las policies anon de las migs 117 §anon_insert y 110 §7.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- 1) leads_prospectos — nombre y WhatsApp del dueño
-- ════════════════════════════════════════════════════════════════════════
-- La mig 117 guardaba solo el email. El nombre ya se pedía en el formulario
-- (viajaba a auth.users.raw_user_meta_data) pero no quedaba en el lead, así
-- que la lista de prospectos mostraba direcciones de correo sueltas.
ALTER TABLE public.leads_prospectos ADD COLUMN IF NOT EXISTS nombre   text;
ALTER TABLE public.leads_prospectos ADD COLUMN IF NOT EXISTS whatsapp text;

COMMENT ON COLUMN public.leads_prospectos.whatsapp IS
  'WhatsApp de contacto. Obligatorio (≥8 dígitos) para origen=web_registro, exento para interes_foodpark. Ver policy leads_prospectos_anon_insert.';

CREATE INDEX IF NOT EXISTS idx_leads_prospectos_tipo
  ON public.leads_prospectos (tipo_negocio, created_at DESC);

-- Policy de anon reescrita: mismos límites de la 117 (no puede prefijar estado
-- ni marcarse verificado) + WhatsApp contactable. El umbral es 8 dígitos: un
-- celular paraguayo sin prefijo país ya son 10 (0981 123456) y una línea fija
-- 9 (021 123456), así que 8 no rechaza a nadie real y sí frena el "-" o el
-- "no tengo" que hoy entraría como texto libre.
DROP POLICY IF EXISTS "leads_prospectos_anon_insert" ON public.leads_prospectos;
CREATE POLICY "leads_prospectos_anon_insert" ON public.leads_prospectos
  FOR INSERT TO anon
  WITH CHECK (
    estado = 'registrado'
    AND verificado = false
    AND origen IN ('web_registro','interes_foodpark')
    AND tipo_negocio IN ('restaurante','foodpark_local','foodpark_owner')
    AND (
      origen <> 'web_registro'
      OR length(regexp_replace(COALESCE(whatsapp,''), '\D', '', 'g')) >= 8
    )
  );

-- ════════════════════════════════════════════════════════════════════════
-- 2) marketing_leads — WhatsApp obligatorio en el formulario de contacto
-- ════════════════════════════════════════════════════════════════════════
-- Antes alcanzaba con dejar "email O WhatsApp" y la mitad de los leads
-- llegaba con un correo que nadie contesta. El único escritor anon de esta
-- tabla es /contacto (mig 110 §7), que ya pide el número.
DROP POLICY IF EXISTS "marketing_leads_anon_insert" ON public.marketing_leads;
CREATE POLICY "marketing_leads_anon_insert" ON public.marketing_leads
  FOR INSERT TO anon
  WITH CHECK (
    status = 'new'
    AND internal_notes IS NULL
    AND length(regexp_replace(COALESCE(whatsapp,''), '\D', '', 'g')) >= 8
  );

-- ════════════════════════════════════════════════════════════════════════
-- 3) submit_supplier_application — WhatsApp obligatorio (era "tel O wa")
-- ════════════════════════════════════════════════════════════════════════
-- VERBATIM de la mig 179 (que ya incluía el plan_slug de la 177) con DOS
-- cambios marcados "-- 198":
--   (a) el chequeo "teléfono o WhatsApp" pasa a exigir WhatsApp con dígitos;
--   (b) search_path incluye `extensions` (regla de la mig 195 — sin eso, la
--       función queda otra vez en la lista del linter de Supabase).
CREATE OR REPLACE FUNCTION public.submit_supplier_application(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp     -- 198 (b)
AS $$
DECLARE
  v_nombre text := NULLIF(btrim(COALESCE(payload->>'nombre_comercial','')),'');
  v_email  text := lower(NULLIF(btrim(COALESCE(payload->>'email','')),''));
  v_ruc    text := NULLIF(btrim(COALESCE(payload->>'ruc','')),'');
  v_tel    text := NULLIF(btrim(COALESCE(payload->>'telefono','')),'');
  v_wa     text := NULLIF(btrim(COALESCE(payload->>'whatsapp','')),'');
  v_tipo   text := NULLIF(btrim(COALESCE(payload->>'tipo_proveedor','')),'');
  v_acepta boolean := COALESCE((payload->>'acepta_terminos')::boolean, false);
  v_cats   text[];
  v_valid_cats text[];
  v_zonas  text[];
  v_plan   text := NULLIF(btrim(COALESCE(payload->>'plan_slug','')),'');
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload) <> 'object' THEN
    RAISE EXCEPTION 'solicitud inválida' USING ERRCODE = '22023';
  END IF;

  -- Obligatorios (fail-closed, server-side)
  IF v_nombre IS NULL OR length(v_nombre) > 120 THEN
    RAISE EXCEPTION 'nombre_comercial requerido' USING ERRCODE = '22023';
  END IF;
  IF v_email IS NULL OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' OR length(v_email) > 160 THEN
    RAISE EXCEPTION 'email inválido' USING ERRCODE = '22023';
  END IF;
  IF v_ruc IS NULL OR length(v_ruc) > 30 THEN
    RAISE EXCEPTION 'ruc requerido' USING ERRCODE = '22023';
  END IF;
  -- 198 (a): el WhatsApp es el canal por el que se contacta al proveedor.
  IF v_wa IS NULL OR length(regexp_replace(v_wa, '\D', '', 'g')) < 8 THEN
    RAISE EXCEPTION 'ingresá un WhatsApp válido para contactarte' USING ERRCODE = '22023';
  END IF;
  IF NOT v_acepta THEN
    RAISE EXCEPTION 'debés aceptar los términos y condiciones' USING ERRCODE = '22023';
  END IF;
  IF v_tipo IS NOT NULL AND v_tipo NOT IN
     ('productor','distribuidor','mayorista','minorista','importador','fabricante','servicio') THEN
    RAISE EXCEPTION 'tipo_proveedor inválido' USING ERRCODE = '22023';
  END IF;

  -- Plan elegido — validación blanda (slug inexistente → NULL, no frena el alta).
  IF v_plan IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.marketplace_supplier_plans WHERE slug = v_plan
  ) THEN
    v_plan := NULL;
  END IF;

  -- Categorías: deben venir como array JSON; se filtran contra el catálogo
  -- activo; mínimo 1 válida
  IF jsonb_typeof(COALESCE(payload->'categorias','[]'::jsonb)) <> 'array'
     OR jsonb_typeof(COALESCE(payload->'zonas_entrega','[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'categorias/zonas_entrega inválidas' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(t.v), '{}') INTO v_cats
    FROM (SELECT value AS v
            FROM jsonb_array_elements_text(COALESCE(payload->'categorias','[]'::jsonb))
           LIMIT 20) t;
  SELECT COALESCE(array_agg(c.slug), '{}') INTO v_valid_cats
    FROM public.marketplace_categories c
   WHERE c.activa = true AND c.slug = ANY(v_cats);
  IF COALESCE(array_length(v_valid_cats,1),0) < 1 THEN
    RAISE EXCEPTION 'elegí al menos una categoría válida' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(t.v), '{}') INTO v_zonas
    FROM (SELECT left(value,80) AS v
            FROM jsonb_array_elements_text(COALESCE(payload->'zonas_entrega','[]'::jsonb))
           LIMIT 20) t;

  -- Dedupe blando: misma ruc o email con una solicitud aún abierta
  IF EXISTS (
    SELECT 1 FROM public.marketplace_applications a
    WHERE a.estado IN ('pendiente','en_revision')
      AND (lower(a.email) = v_email OR a.ruc = v_ruc)
  ) THEN
    RAISE EXCEPTION 'solicitud ya registrada' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.marketplace_applications (
    nombre_comercial, razon_social, ruc, tipo_proveedor, rubro_principal,
    anhos_mercado, ciudad, departamento, direccion, web_redes,
    contacto_nombre, contacto_cargo, telefono, whatsapp, email,
    categorias, productos_principales, marcas, vende_mayor, vende_menor,
    zonas_entrega, delivery_propio, retiro_local, dias_entrega, pedido_minimo,
    entrega_urgente, acepta_credito, emite_factura, precio_visible,
    acepta_nuevos_clientes, catalogo_url, mensaje, acepta_terminos,
    plan_slug, estado, origen
  ) VALUES (
    v_nombre,
    left(NULLIF(btrim(COALESCE(payload->>'razon_social','')),''), 160),
    v_ruc,
    v_tipo,
    left(NULLIF(btrim(COALESCE(payload->>'rubro_principal','')),''), 120),
    NULLIF(btrim(COALESCE(payload->>'anhos_mercado','')),'')::int,
    left(NULLIF(btrim(COALESCE(payload->>'ciudad','')),''), 80),
    left(NULLIF(btrim(COALESCE(payload->>'departamento','')),''), 80),
    left(NULLIF(btrim(COALESCE(payload->>'direccion','')),''), 200),
    left(NULLIF(btrim(COALESCE(payload->>'web_redes','')),''), 200),
    left(NULLIF(btrim(COALESCE(payload->>'contacto_nombre','')),''), 120),
    left(NULLIF(btrim(COALESCE(payload->>'contacto_cargo','')),''), 80),
    left(v_tel, 40),
    left(v_wa, 40),
    v_email,
    v_valid_cats,
    left(NULLIF(btrim(COALESCE(payload->>'productos_principales','')),''), 1000),
    left(NULLIF(btrim(COALESCE(payload->>'marcas','')),''), 400),
    COALESCE((payload->>'vende_mayor')::boolean, false),
    COALESCE((payload->>'vende_menor')::boolean, false),
    v_zonas,
    COALESCE((payload->>'delivery_propio')::boolean, false),
    COALESCE((payload->>'retiro_local')::boolean, false),
    left(NULLIF(btrim(COALESCE(payload->>'dias_entrega','')),''), 120),
    left(NULLIF(btrim(COALESCE(payload->>'pedido_minimo','')),''), 120),
    COALESCE((payload->>'entrega_urgente')::boolean, false),
    COALESCE((payload->>'acepta_credito')::boolean, false),
    COALESCE((payload->>'emite_factura')::boolean, false),
    COALESCE((payload->>'precio_visible')::boolean, false),
    COALESCE((payload->>'acepta_nuevos_clientes')::boolean, true),
    left(NULLIF(btrim(COALESCE(payload->>'catalogo_url','')),''), 300),
    left(NULLIF(btrim(COALESCE(payload->>'mensaje','')),''), 3000),
    true,
    v_plan,
    'pendiente',
    'web'
  );

  INSERT INTO public.marketplace_events (event_type, metadata)
  VALUES ('application_submitted', jsonb_build_object('nombre_comercial', v_nombre, 'plan_slug', v_plan));

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_supplier_application(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_supplier_application(jsonb) TO anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 4) form_analytics — un conteo por cada opción de cada formulario
-- ════════════════════════════════════════════════════════════════════════
-- SECURITY INVOKER a propósito (como crm_customer_stats): la RLS de cada tabla
-- sigue decidiendo qué filas se ven. El guard explícito de superadmin de abajo
-- es defensa en profundidad, no el único control: sin él, un admin de local
-- llamaría a la función y recibiría un reporte vacío/scopeado, no ajeno.
--
-- FORMATO DE SALIDA — un objeto por formulario; dentro, un objeto por pregunta
-- y dentro de cada pregunta {opción: cantidad}:
--   { "duenos_registro": { "total": 12, "tipo_negocio": {"restaurante": 9, …} }, … }
-- La clave '__none__' es "no respondió / vacío". Las ETIQUETAS de las opciones
-- NO viven acá: las pone el panel, copiadas del formulario real, para que el
-- reporte muestre TAMBIÉN las opciones que nadie eligió (que son las que hay
-- que mirar) y para que un cambio de redacción no exija una migración.
CREATE OR REPLACE FUNCTION public.form_analytics(
  p_from timestamptz DEFAULT NULL,
  p_to   timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_registro    jsonb := jsonb_build_object('disponible', false);
  v_onboarding  jsonb := jsonb_build_object('disponible', false);
  v_proveedores jsonb := jsonb_build_object('disponible', false);
  v_web         jsonb := jsonb_build_object('disponible', false);
  v_comensales  jsonb := jsonb_build_object('disponible', false);
BEGIN
  IF public.get_my_role() IS DISTINCT FROM 'superadmin' THEN
    RAISE EXCEPTION 'solo superadmin' USING ERRCODE = '42501';
  END IF;

  -- ── 4.1 Dueños · formulario de registro (/registro → leads_prospectos) ──
  BEGIN
    WITH src AS (
      SELECT * FROM public.leads_prospectos
       WHERE (p_from IS NULL OR created_at >= p_from)
         AND (p_to   IS NULL OR created_at <  p_to)
    ), pairs AS (
      SELECT 'tipo_negocio' AS q, COALESCE(NULLIF(btrim(tipo_negocio),''),'__none__') AS o FROM src
      UNION ALL SELECT 'origen',   COALESCE(NULLIF(btrim(origen),''),'__none__')       FROM src
      UNION ALL SELECT 'estado',   COALESCE(NULLIF(btrim(estado),''),'__none__')       FROM src
      UNION ALL SELECT 'verificado', CASE WHEN verificado THEN 'si' ELSE 'no' END      FROM src
      -- Contactabilidad: la razón de ser de esta migración. Los leads viejos
      -- (anteriores al WhatsApp obligatorio) caen en 'solo_email'/'sin_contacto'.
      UNION ALL SELECT 'contacto',
        CASE WHEN length(regexp_replace(COALESCE(whatsapp,''), '\D', '', 'g')) >= 8 THEN 'whatsapp'
             WHEN COALESCE(btrim(email),'') <> '' THEN 'solo_email'
             ELSE 'sin_contacto' END FROM src
    )
    SELECT jsonb_build_object('disponible', true, 'total', (SELECT count(*) FROM src))
           || COALESCE((
             SELECT jsonb_object_agg(q, opts)
               FROM (SELECT q, jsonb_object_agg(o, c) AS opts
                       FROM (SELECT q, o, count(*) AS c FROM pairs GROUP BY 1,2) z
                      GROUP BY q) y
           ), '{}'::jsonb)
      INTO v_registro;
  EXCEPTION WHEN others THEN
    v_registro := jsonb_build_object('disponible', false, 'error', SQLERRM);
  END;

  -- ── 4.2 Dueños · wizard de onboarding (/onboarding → restaurants) ───────
  -- Columnas de las migs 118/120. `operation_modes`, `order_intake`,
  -- `payment_methods` y `print_needs` son jsonb multi-opción: se abren con
  -- LEFT JOIN LATERAL para que un local que no marcó NADA cuente como
  -- '__none__' en vez de desaparecer de la pregunta.
  BEGIN
    WITH src AS (
      SELECT * FROM public.restaurants
       WHERE (p_from IS NULL OR created_at >= p_from)
         AND (p_to   IS NULL OR created_at <  p_to)
    ), pairs AS (
      SELECT 'business_type' AS q, COALESCE(NULLIF(btrim(business_type),''),'__none__') AS o FROM src
      UNION ALL SELECT 'kitchen_routing',   COALESCE(NULLIF(btrim(kitchen_routing),''),'__none__')   FROM src
      UNION ALL SELECT 'einvoicing_status', COALESCE(NULLIF(btrim(einvoicing_status),''),'__none__') FROM src
      UNION ALL SELECT 'onboarding',        CASE WHEN onboarding_completed_at IS NOT NULL THEN 'completado' ELSE 'incompleto' END FROM src
      UNION ALL SELECT 'mesas',
        CASE WHEN table_count IS NULL THEN '__none__'
             WHEN table_count = 0      THEN 'sin_mesas'
             WHEN table_count <= 10    THEN '1_10'
             WHEN table_count <= 30    THEN '11_30'
             ELSE '31_mas' END FROM src
      UNION ALL SELECT 'contacto',
        CASE WHEN length(regexp_replace(COALESCE(whatsapp,''), '\D', '', 'g')) >= 8 THEN 'whatsapp'
             WHEN COALESCE(btrim(phone),'') <> '' THEN 'solo_telefono'
             ELSE 'sin_contacto' END FROM src
      UNION ALL SELECT 'operation_modes', COALESCE(e.v,'__none__')
        FROM src LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(src.operation_modes,'[]'::jsonb)) e(v) ON true
      UNION ALL SELECT 'order_intake', COALESCE(e.v,'__none__')
        FROM src LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(src.order_intake,'[]'::jsonb)) e(v) ON true
      UNION ALL SELECT 'payment_methods', COALESCE(e.v,'__none__')
        FROM src LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(src.payment_methods,'[]'::jsonb)) e(v) ON true
      UNION ALL SELECT 'print_needs', COALESCE(e.v,'__none__')
        FROM src LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(src.print_needs,'[]'::jsonb)) e(v) ON true
    )
    SELECT jsonb_build_object('disponible', true, 'total', (SELECT count(*) FROM src))
           || COALESCE((
             SELECT jsonb_object_agg(q, opts)
               FROM (SELECT q, jsonb_object_agg(o, c) AS opts
                       FROM (SELECT q, o, count(*) AS c FROM pairs GROUP BY 1,2) z
                      GROUP BY q) y
           ), '{}'::jsonb)
      INTO v_onboarding;
  EXCEPTION WHEN others THEN
    v_onboarding := jsonb_build_object('disponible', false, 'error', SQLERRM);
  END;

  -- ── 4.3 Proveedores (/proveedores → marketplace_applications) ───────────
  -- `categorias` y `zonas_entrega` son text[]; los siete "qué ofrecés" son
  -- booleanos sueltos que en el formulario son UNA pregunta de casillas, así
  -- que acá se reagrupan como tal (solo se cuenta el sí).
  BEGIN
    WITH src AS (
      SELECT * FROM public.marketplace_applications
       WHERE (p_from IS NULL OR created_at >= p_from)
         AND (p_to   IS NULL OR created_at <  p_to)
    ), pairs AS (
      SELECT 'tipo_proveedor' AS q, COALESCE(NULLIF(btrim(tipo_proveedor),''),'__none__') AS o FROM src
      UNION ALL SELECT 'estado',    COALESCE(NULLIF(btrim(estado),''),'__none__')     FROM src
      UNION ALL SELECT 'plan_slug', COALESCE(NULLIF(btrim(plan_slug),''),'__none__')  FROM src
      UNION ALL SELECT 'ciudad',    COALESCE(NULLIF(btrim(ciudad),''),'__none__')     FROM src
      UNION ALL SELECT 'anhos_mercado',
        CASE WHEN anhos_mercado IS NULL THEN '__none__'
             WHEN anhos_mercado < 2  THEN '0_1'
             WHEN anhos_mercado < 6  THEN '2_5'
             WHEN anhos_mercado < 16 THEN '6_15'
             ELSE '16_mas' END FROM src
      UNION ALL SELECT 'contacto',
        CASE WHEN length(regexp_replace(COALESCE(whatsapp,''), '\D', '', 'g')) >= 8 THEN 'whatsapp'
             WHEN COALESCE(btrim(telefono),'') <> '' THEN 'solo_telefono'
             ELSE 'sin_contacto' END FROM src
      UNION ALL SELECT 'categorias', COALESCE(e.v,'__none__')
        FROM src LEFT JOIN LATERAL unnest(COALESCE(src.categorias,'{}'::text[])) e(v) ON true
      UNION ALL SELECT 'zonas_entrega', COALESCE(e.v,'__none__')
        FROM src LEFT JOIN LATERAL unnest(COALESCE(src.zonas_entrega,'{}'::text[])) e(v) ON true
      UNION ALL SELECT 'ofrece', o FROM src,
        LATERAL (VALUES ('vende_mayor', vende_mayor), ('vende_menor', vende_menor),
                        ('delivery_propio', delivery_propio), ('retiro_local', retiro_local),
                        ('entrega_urgente', entrega_urgente), ('emite_factura', emite_factura),
                        ('acepta_credito', acepta_credito)) AS f(o, on_)
        WHERE f.on_
    )
    SELECT jsonb_build_object('disponible', true, 'total', (SELECT count(*) FROM src))
           || COALESCE((
             SELECT jsonb_object_agg(q, opts)
               FROM (SELECT q, jsonb_object_agg(o, c) AS opts
                       FROM (SELECT q, o, count(*) AS c FROM pairs GROUP BY 1,2) z
                      GROUP BY q) y
           ), '{}'::jsonb)
      INTO v_proveedores;
  EXCEPTION WHEN others THEN
    v_proveedores := jsonb_build_object('disponible', false, 'error', SQLERRM);
  END;

  -- ── 4.4 Interesados del sitio (/contacto → marketing_leads) ─────────────
  BEGIN
    WITH src AS (
      SELECT * FROM public.marketing_leads
       WHERE (p_from IS NULL OR created_at >= p_from)
         AND (p_to   IS NULL OR created_at <  p_to)
    ), pairs AS (
      SELECT 'type' AS q, COALESCE(NULLIF(btrim(type),''),'__none__') AS o FROM src
      UNION ALL SELECT 'status',    COALESCE(NULLIF(btrim(status),''),'__none__')    FROM src
      UNION ALL SELECT 'plan_slug', COALESCE(NULLIF(btrim(plan_slug),''),'__none__') FROM src
      UNION ALL SELECT 'source',    COALESCE(NULLIF(btrim(source),''),'__none__')    FROM src
      UNION ALL SELECT 'contacto',
        CASE WHEN length(regexp_replace(COALESCE(whatsapp,''), '\D', '', 'g')) >= 8 THEN 'whatsapp'
             WHEN COALESCE(btrim(email),'') <> '' THEN 'solo_email'
             ELSE 'sin_contacto' END FROM src
      UNION ALL SELECT 'selected_addons', COALESCE(e.v,'__none__')
        FROM src LEFT JOIN LATERAL jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(COALESCE(src.selected_addons,'[]'::jsonb)) = 'array'
                    THEN src.selected_addons ELSE '[]'::jsonb END) e(v) ON true
    )
    SELECT jsonb_build_object('disponible', true, 'total', (SELECT count(*) FROM src))
           || COALESCE((
             SELECT jsonb_object_agg(q, opts)
               FROM (SELECT q, jsonb_object_agg(o, c) AS opts
                       FROM (SELECT q, o, count(*) AS c FROM pairs GROUP BY 1,2) z
                      GROUP BY q) y
           ), '{}'::jsonb)
      INTO v_web;
  EXCEPTION WHEN others THEN
    v_web := jsonb_build_object('disponible', false, 'error', SQLERRM);
  END;

  -- ── 4.5 Comensales cargados por los locales (customers, mig 196) ────────
  -- Si la 196 no está aplicada, el sub-bloque cae en el EXCEPTION y la sección
  -- queda 'disponible: false' — el resto del reporte sale igual.
  BEGIN
    WITH src AS (
      SELECT * FROM public.customers
       WHERE (p_from IS NULL OR created_at >= p_from)
         AND (p_to   IS NULL OR created_at <  p_to)
    ), pairs AS (
      SELECT 'source' AS q, COALESCE(NULLIF(btrim(source),''),'__none__') AS o FROM src
      UNION ALL SELECT 'estado', CASE WHEN is_active THEN 'activo' ELSE 'inactivo' END FROM src
      UNION ALL SELECT 'contacto',
        CASE WHEN length(COALESCE(phone_digits,'')) >= 6 THEN 'con_telefono'
             WHEN COALESCE(btrim(email),'') <> '' THEN 'solo_email'
             ELSE 'sin_contacto' END FROM src
      UNION ALL SELECT 'datos',  o FROM src,
        LATERAL (VALUES ('email', COALESCE(btrim(email),'') <> ''),
                        ('direccion', COALESCE(btrim(address),'') <> ''),
                        ('documento', COALESCE(btrim(doc_number),'') <> ''),
                        ('cumpleanos', birth_date IS NOT NULL)) AS f(o, on_)
        WHERE f.on_
    )
    SELECT jsonb_build_object(
             'disponible', true,
             'total', (SELECT count(*) FROM src),
             'locales', (SELECT count(DISTINCT restaurant_id) FROM src)
           )
           || COALESCE((
             SELECT jsonb_object_agg(q, opts)
               FROM (SELECT q, jsonb_object_agg(o, c) AS opts
                       FROM (SELECT q, o, count(*) AS c FROM pairs GROUP BY 1,2) z
                      GROUP BY q) y
           ), '{}'::jsonb)
      INTO v_comensales;
  EXCEPTION WHEN others THEN
    v_comensales := jsonb_build_object('disponible', false, 'error', SQLERRM);
  END;

  RETURN jsonb_build_object(
    'generated_at',      now(),
    'from',              p_from,
    'to',                p_to,
    'duenos_registro',   v_registro,
    'duenos_onboarding', v_onboarding,
    'proveedores',       v_proveedores,
    -- Todavía no existe un formulario público de repartidores: el panel dibuja
    -- la sección vacía con el aviso, en vez de fingir un cero que se lee como
    -- "nadie se anotó" cuando en realidad no hay dónde anotarse.
    'delivery',          jsonb_build_object('disponible', false, 'motivo', 'sin_formulario'),
    'clientes_web',      v_web,
    'comensales',        v_comensales
  );
END;
$$;

REVOKE ALL ON FUNCTION public.form_analytics(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.form_analytics(timestamptz, timestamptz) TO authenticated;

COMMIT;

-- Recargar el cache de esquema de PostgREST (columnas, policies y función nuevas).
NOTIFY pgrst, 'reload schema';

SELECT 'migración 198 aplicada — WhatsApp obligatorio (registro/contacto/proveedores) + form_analytics()' AS status;
