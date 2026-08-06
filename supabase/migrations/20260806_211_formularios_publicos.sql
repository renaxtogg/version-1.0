-- ════════════════════════════════════════════════════════════════════════
-- 211 · Motor de formularios públicos (encuestas de demanda)
-- ────────────────────────────────────────────────────────────────────────
-- [PARA PEGAR EN SUPABASE]  ·  rol postgres, SQL Editor en INGLÉS.
--
-- POR QUÉ EXISTE ESTO
-- Antes de abrir el registro real de repartidores y proveedores hay que saber
-- cuánta gente hay del otro lado y qué necesita. Hoy no hay forma de
-- preguntarlo: `/riders` y `/proveedores` sólo saben dar de ALTA (mig 207 y
-- `submit_supplier_application`), y un alta a medio completar de alguien que
-- todavía no podemos operar es basura que después hay que depurar a mano.
--
-- LA DECISIÓN DE DISEÑO — las preguntas viven en la BASE, no en el código.
-- El precedente de esta casa es el contrario: `FORM_SPECS` (mig 198) y
-- `EXP_COPY` (mig 204) guardan las etiquetas en el front A PROPÓSITO, para que
-- reescribir un texto no exija una migración. Ahí eso es correcto porque esas
-- "preguntas" son en realidad COLUMNAS de tablas de negocio: el front sólo les
-- pone nombre. Acá no: una encuesta no mapea a ninguna columna, sus preguntas
-- cambian mientras se corre (se agrega una opción que nadie previó, se parte
-- una pregunta en dos) y quien las cambia es Renato, no un deploy. Si vivieran
-- en el código, "agregar una opción" sería editar un .jsx, correr `npm run
-- build` y esperar a Vercel — que es exactamente lo que se pidió evitar.
--
-- LO QUE ESTO **NO** ES: un reemplazo del alta real. Las encuestas son previas
-- y conviven con `mythos_riders` / `marketplace_applications` sin tocarlas. Un
-- interesado NO es un postulante, y mezclarlos dejaría las dos bandejas
-- inservibles. Por eso son tablas propias y por eso el alta real se cierra
-- mientras la encuesta corre (§7).
--
-- ANON NO TOCA NINGUNA DE LAS TRES TABLAS. Las respuestas traen nombre y
-- WhatsApp de personas reales: es PII, y desde la mig 210 `anon` ya no hereda
-- privilegios de fábrica, así que simplemente NO se le otorga nada. Tanto leer
-- el formulario como enviarlo pasan por RPC `SECURITY DEFINER` (§5 y §6) —
-- mismo camino que `submit_supplier_application`, y de paso no gasta ninguna
-- de las 12 funciones serverless del plan Hobby de Vercel (el repo está en 11).
--
-- Todo ADITIVO e idempotente. El seed de §8 usa ON CONFLICT DO NOTHING: correr
-- la migración dos veces no duplica preguntas ni pisa las que se hayan editado
-- desde el panel.
--
-- REVERSA:
--   DROP FUNCTION IF EXISTS public.public_form_export(text, timestamptz, timestamptz);
--   DROP FUNCTION IF EXISTS public.public_form_stats(text, timestamptz, timestamptz);
--   DROP FUNCTION IF EXISTS public.public_form_submit(text, jsonb);
--   DROP FUNCTION IF EXISTS public.public_form_get(text);
--   DROP TABLE IF EXISTS public.public_form_submissions;
--   DROP TABLE IF EXISTS public.public_form_questions;
--   DROP TABLE IF EXISTS public.public_forms;
--   DELETE FROM public.marketing_config WHERE key = 'supplier_signup';
--   UPDATE public.mythos_rider_config SET registration_open = true WHERE id;
--   -- y re-aplicar submit_supplier_application de la mig 198 §3 (sin el gate).
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- 1) public_forms — un formulario
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.public_forms (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT NOT NULL UNIQUE,
  -- A quién le habla. No es decorativo: es lo que conecta la encuesta con el
  -- alta real que se cierra mientras corre (§7).
  audience        TEXT NOT NULL DEFAULT 'otro'
                    CHECK (audience IN ('delivery','proveedores','duenos','otro')),

  title           TEXT NOT NULL,
  description     TEXT,
  -- Copy de la pantalla de gracias. Es la última oportunidad de decirle a la
  -- persona qué va a pasar después; dejarlo en "enviado" desperdicia el momento
  -- de más atención de todo el formulario.
  success_title   TEXT NOT NULL DEFAULT '¡Listo! Ya estás en la lista',
  success_message TEXT NOT NULL DEFAULT 'Te vamos a escribir por WhatsApp apenas abramos el registro.',

  -- Portero. Nace APAGADO: publicar la encuesta es una decisión, no un efecto
  -- de aplicar la migración (mismo criterio que Marketing en la 197 y la Red de
  -- Riders en la 207).
  is_open         BOOLEAN NOT NULL DEFAULT false,
  closed_message  TEXT NOT NULL DEFAULT 'Este formulario está cerrado por ahora. Volvé pronto.',

  accent          TEXT NOT NULL DEFAULT '#FF9500',

  -- Anti-basura. Un formulario público con la anon key se llena de ruido si no
  -- tiene freno, y el freno tiene que estar en la BASE: el HTML lo saltea
  -- cualquiera posteando directo contra PostgREST.
  --
  -- El dedupe por WhatsApp NO es configurable a propósito: lo garantiza un
  -- índice único (§3), así que un interruptor "permitir repetidos" sería un
  -- interruptor que miente — la base rebotaría igual, pero con un 23505 crudo
  -- en vez del mensaje amable. Una encuesta es una persona, una respuesta.
  max_per_ip_day  INT     NOT NULL DEFAULT 8 CHECK (max_per_ip_day BETWEEN 1 AND 500),

  sort_order      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.public_forms IS
  'Encuestas públicas de demanda (previas al alta real). Editables desde Superadmin › Sitio web › Formularios › Encuestas.';
COMMENT ON COLUMN public.public_forms.is_open IS
  'Portero del formulario. Nace en false. Se enforca en public_form_submit(), no sólo escondiendo la pantalla.';

-- ════════════════════════════════════════════════════════════════════════
-- 2) public_form_questions — las preguntas, en orden
-- ════════════════════════════════════════════════════════════════════════
-- `qkey` es la clave ESTABLE: es la que queda escrita adentro de cada respuesta
-- guardada. Renombrar la etiqueta no rompe nada; cambiar la qkey sí — por eso
-- el editor del panel deja tocar el texto libremente y la clave no.
--
-- Tres qkey son especiales y están reservadas: `nombre`, `whatsapp` y `ciudad`.
-- Se preguntan como cualquier otra (y se pueden reordenar o reescribir), pero
-- además se COPIAN a columnas propias de la respuesta (§3). Es lo que permite
-- deduplicar por número, filtrar por ciudad y exportar una agenda de contactos
-- sin tener que abrir el jsonb de cada fila.
CREATE TABLE IF NOT EXISTS public.public_form_questions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id     UUID NOT NULL REFERENCES public.public_forms(id) ON DELETE CASCADE,
  qkey        TEXT NOT NULL CHECK (qkey ~ '^[a-z][a-z0-9_]{0,39}$'),
  label       TEXT NOT NULL,
  help        TEXT,

  qtype       TEXT NOT NULL DEFAULT 'single'
                CHECK (qtype IN ('short_text','long_text','number','single','multi')),
  required    BOOLEAN NOT NULL DEFAULT false,

  -- [{"value":"si","label":"Sí"}, …]. Sólo para single/multi.
  options     JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Deja marcar "Otra" y escribir. La respuesta libre entra como
  -- "otro:<texto>" para que el conteo agregado la siga viendo como "otro" y el
  -- texto no se pierda.
  allow_other BOOLEAN NOT NULL DEFAULT false,

  max_len     INT NOT NULL DEFAULT 400 CHECK (max_len BETWEEN 1 AND 4000),
  placeholder TEXT,

  sort_order  INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (form_id, qkey)
);

CREATE INDEX IF NOT EXISTS idx_pfq_form ON public.public_form_questions (form_id, sort_order, id);

COMMENT ON COLUMN public.public_form_questions.qkey IS
  'Clave estable guardada dentro de cada respuesta. nombre/whatsapp/ciudad son reservadas: además se copian a columnas de public_form_submissions.';

-- ════════════════════════════════════════════════════════════════════════
-- 3) public_form_submissions — una respuesta
-- ════════════════════════════════════════════════════════════════════════
-- La captura automática (§ utm/referrer/device/ip) es la mitad del valor de
-- hacer el formulario en casa en vez de en Google Forms: dice de qué campaña
-- vino cada persona sin preguntárselo. La IP la resuelve la RPC leyendo los
-- headers de la petición, NUNCA el navegador — una IP que viaja en el payload
-- la escribe cualquiera (mismo criterio que el contrato de riders, mig 207).
CREATE TABLE IF NOT EXISTS public.public_form_submissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id         UUID NOT NULL REFERENCES public.public_forms(id) ON DELETE CASCADE,

  -- Identidad promovida desde las qkey reservadas
  nombre          TEXT,
  whatsapp        TEXT,
  whatsapp_digits TEXT GENERATED ALWAYS AS
                    (regexp_replace(COALESCE(whatsapp,''), '\D', '', 'g')) STORED,
  ciudad          TEXT,

  -- {qkey: valor}. Escalar para short_text/long_text/number/single,
  -- array de strings para multi.
  answers         JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Captura automática
  utm             JSONB NOT NULL DEFAULT '{}'::jsonb,
  referrer        TEXT,
  landing_path    TEXT,
  user_agent      TEXT,
  device          TEXT,
  ip              TEXT,

  -- Gestión desde el panel
  estado          TEXT NOT NULL DEFAULT 'nuevo'
                    CHECK (estado IN ('nuevo','contactado','interesado','descartado','convertido')),
  notas_internas  TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedupe por número. Parcial (sólo cuando hay dígitos) para no chocar entre sí
-- las respuestas sin teléfono, si algún día se permite un formulario anónimo.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pfs_form_whatsapp
  ON public.public_form_submissions (form_id, whatsapp_digits)
  WHERE whatsapp_digits <> '';

CREATE INDEX IF NOT EXISTS idx_pfs_form_fecha
  ON public.public_form_submissions (form_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pfs_ip_fecha
  ON public.public_form_submissions (ip, created_at DESC);

-- ════════════════════════════════════════════════════════════════════════
-- 4) RLS y privilegios — anon: CERO en las tres tablas
-- ════════════════════════════════════════════════════════════════════════
ALTER TABLE public.public_forms            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_form_questions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_form_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pf_superadmin  ON public.public_forms;
CREATE POLICY pf_superadmin ON public.public_forms
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

DROP POLICY IF EXISTS pfq_superadmin ON public.public_form_questions;
CREATE POLICY pfq_superadmin ON public.public_form_questions
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- Las respuestas son PII (nombre + WhatsApp de personas reales). Sólo
-- superadmin, y el INSERT no está acá: entra por la RPC SECURITY DEFINER, que
-- es la única que valida. Sin policy de INSERT para authenticated, un dueño
-- logueado tampoco puede sembrar respuestas falsas.
DROP POLICY IF EXISTS pfs_superadmin ON public.public_form_submissions;
CREATE POLICY pfs_superadmin ON public.public_form_submissions
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- Desde la mig 210 `anon` ya no hereda privilegios al crear una tabla, así que
-- estos REVOKE son cinturón y tirantes: si alguien re-abriera el default, estas
-- tres tablas seguirían cerradas.
REVOKE ALL ON public.public_forms            FROM anon;
REVOKE ALL ON public.public_form_questions   FROM anon;
REVOKE ALL ON public.public_form_submissions FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.public_forms            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.public_form_questions   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.public_form_submissions TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 5) public_form_get — lo que ve el visitante
-- ════════════════════════════════════════════════════════════════════════
-- Devuelve el formulario y sus preguntas. NUNCA respuestas, ni conteos, ni
-- nada de otras personas: es la RPC que puede llamar cualquiera con la anon
-- key. Devuelve también los formularios CERRADOS (con is_open=false y el
-- mensaje) para que la página pueda explicar por qué no se puede completar en
-- vez de mostrar un hueco.
CREATE OR REPLACE FUNCTION public.public_form_get(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_f public.public_forms%ROWTYPE;
  v_q jsonb;
BEGIN
  SELECT * INTO v_f FROM public.public_forms WHERE slug = p_slug;
  IF v_f.id IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'qkey', q.qkey, 'label', q.label, 'help', q.help, 'qtype', q.qtype,
           'required', q.required, 'options', q.options, 'allow_other', q.allow_other,
           'max_len', q.max_len, 'placeholder', q.placeholder
         ) ORDER BY q.sort_order, q.created_at), '[]'::jsonb)
    INTO v_q
    FROM public.public_form_questions q
   WHERE q.form_id = v_f.id AND q.is_active;

  RETURN jsonb_build_object(
    'found',           true,
    'slug',            v_f.slug,
    'audience',        v_f.audience,
    'title',           v_f.title,
    'description',     v_f.description,
    'is_open',         v_f.is_open,
    'closed_message',  v_f.closed_message,
    'success_title',   v_f.success_title,
    'success_message', v_f.success_message,
    'accent',          v_f.accent,
    'questions',       v_q
  );
END;
$$;

REVOKE ALL ON FUNCTION public.public_form_get(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_form_get(text) TO anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 6) public_form_submit — el envío
-- ════════════════════════════════════════════════════════════════════════
-- Toda la validación está acá y no en el navegador, por el mismo motivo que la
-- mig 198 movió el WhatsApp obligatorio a la base: un asterisco en el HTML no
-- es una validación, cualquiera postea con la anon key. Se valida:
--   · que el formulario exista y esté ABIERTO;
--   · que cada pregunta `required` tenga respuesta;
--   · que las opciones elegidas EXISTAN en el catálogo de esa pregunta
--     (si no, una respuesta inventada rompería el reporte agregado);
--   · WhatsApp con ≥8 dígitos — el mismo umbral de la mig 198, a propósito: un
--     celular paraguayo sin prefijo ya son 10 y una línea fija 9, así que no
--     rechaza a nadie real y sí frena el "-";
--   · que no haya respondido ya con ese número;
--   · que esa IP no haya mandado más de `max_per_ip_day` en 24 h.
CREATE OR REPLACE FUNCTION public.public_form_submit(p_slug text, payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_f        public.public_forms%ROWTYPE;
  v_q        RECORD;
  v_ans      jsonb := '{}'::jsonb;
  v_raw      jsonb;
  v_txt      text;
  v_arr      text[];
  v_valid    text[];
  v_item     text;
  v_nombre   text;
  v_wa       text;
  v_ciudad   text;
  v_ip       text;
  v_ua       text;
  v_dev      text;
  v_utm      jsonb;
  v_count    int;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload) <> 'object' THEN
    RAISE EXCEPTION 'envío inválido' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_f FROM public.public_forms WHERE slug = p_slug;
  IF v_f.id IS NULL THEN
    RAISE EXCEPTION 'formulario inexistente' USING ERRCODE = '22023';
  END IF;
  IF NOT v_f.is_open THEN
    RAISE EXCEPTION '%', v_f.closed_message USING ERRCODE = '22023';
  END IF;

  -- ── IP real, desde los headers de la petición ─────────────────────────
  -- El navegador no la puede falsear porque no la manda: la pone la
  -- infraestructura y PostgREST la deja en el GUC `request.headers`. Fuera de
  -- PostgREST (psql, cron) no hay headers y queda NULL, que está bien.
  BEGIN
    v_ip := NULLIF(btrim(split_part(
      COALESCE(current_setting('request.headers', true)::json->>'x-forwarded-for', ''), ',', 1)), '');
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
  END;

  -- ── Freno por IP ──────────────────────────────────────────────────────
  IF v_ip IS NOT NULL THEN
    SELECT count(*) INTO v_count
      FROM public.public_form_submissions s
     WHERE s.ip = v_ip AND s.created_at > now() - interval '24 hours';
    IF v_count >= v_f.max_per_ip_day THEN
      RAISE EXCEPTION 'recibimos demasiados envíos desde esta conexión. Probá de nuevo mañana.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- ── Pregunta por pregunta ─────────────────────────────────────────────
  FOR v_q IN
    SELECT * FROM public.public_form_questions
     WHERE form_id = v_f.id AND is_active
     ORDER BY sort_order, created_at
  LOOP
    v_raw := payload->'answers'->v_q.qkey;

    IF v_q.qtype = 'multi' THEN
      -- Multi: array de strings. Se filtra contra el catálogo de la pregunta;
      -- lo que no esté se descarta en silencio salvo que sea "otro:<texto>"
      -- con allow_other, que se conserva entero.
      v_arr := '{}';
      IF v_raw IS NOT NULL AND jsonb_typeof(v_raw) = 'array' THEN
        SELECT COALESCE(array_agg(t.v), '{}') INTO v_arr
          FROM (SELECT left(value, v_q.max_len) AS v
                  FROM jsonb_array_elements_text(v_raw) LIMIT 40) t;
      END IF;

      SELECT COALESCE(array_agg(x), '{}') INTO v_valid
        FROM unnest(v_arr) AS x
       WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(v_q.options) o
                      WHERE o->>'value' = x)
          OR (v_q.allow_other AND x LIKE 'otro:%');

      IF v_q.required AND COALESCE(array_length(v_valid,1),0) = 0 THEN
        RAISE EXCEPTION 'Falta responder: %', v_q.label USING ERRCODE = '22023';
      END IF;
      IF COALESCE(array_length(v_valid,1),0) > 0 THEN
        v_ans := v_ans || jsonb_build_object(v_q.qkey, to_jsonb(v_valid));
      END IF;

    ELSE
      -- Escalar. jsonb_typeof distingue el número del texto para que un
      -- `number` guardado como 350000 no llegue como la cadena "350000".
      v_txt := CASE
        WHEN v_raw IS NULL OR jsonb_typeof(v_raw) = 'null' THEN NULL
        WHEN jsonb_typeof(v_raw) = 'string' THEN NULLIF(btrim(v_raw #>> '{}'), '')
        ELSE NULLIF(btrim(v_raw::text), '')
      END;
      v_txt := left(v_txt, v_q.max_len);

      IF v_q.qtype = 'single' AND v_txt IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_q.options) o
                        WHERE o->>'value' = v_txt)
           AND NOT (v_q.allow_other AND v_txt LIKE 'otro:%') THEN
          v_txt := NULL;   -- opción inventada: se descarta, no se guarda basura
        END IF;
      END IF;

      IF v_q.qtype = 'number' AND v_txt IS NOT NULL THEN
        -- Se guarda el texto tal cual (los rangos de guaraníes vienen con
        -- puntos), pero se exige que tenga al menos un dígito.
        IF v_txt !~ '\d' THEN v_txt := NULL; END IF;
      END IF;

      IF v_q.required AND v_txt IS NULL THEN
        RAISE EXCEPTION 'Falta responder: %', v_q.label USING ERRCODE = '22023';
      END IF;
      IF v_txt IS NOT NULL THEN
        v_ans := v_ans || jsonb_build_object(v_q.qkey, to_jsonb(v_txt));
      END IF;
    END IF;

    -- Las tres reservadas se promueven a columna (dedupe, filtro y export).
    IF v_q.qkey = 'nombre'   THEN v_nombre := v_ans->>'nombre';   END IF;
    IF v_q.qkey = 'whatsapp' THEN v_wa     := v_ans->>'whatsapp'; END IF;
    IF v_q.qkey = 'ciudad'   THEN v_ciudad := v_ans->>'ciudad';   END IF;
  END LOOP;

  -- ── WhatsApp contactable ──────────────────────────────────────────────
  -- Regla de la casa (mig 198): en Paraguay el canal real es WhatsApp, y un
  -- registrado sin número es un registrado perdido. Vive acá y no sólo en el
  -- HTML porque el HTML se saltea posteando directo.
  IF length(regexp_replace(COALESCE(v_wa,''), '\D', '', 'g')) < 8 THEN
    RAISE EXCEPTION 'Ingresá un WhatsApp válido para poder contactarte.' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(btrim(v_nombre),'') = '' THEN
    RAISE EXCEPTION 'Ingresá tu nombre.' USING ERRCODE = '22023';
  END IF;

  -- ── Ya respondió ──────────────────────────────────────────────────────
  -- El chequeo explícito es sólo para dar un mensaje entendible; quien de
  -- verdad lo garantiza es el índice único `uniq_pfs_form_whatsapp`, que
  -- también cubre la carrera de dos envíos simultáneos con el mismo número
  -- (el EXCEPTION de abajo la atrapa y la traduce al mismo texto).
  IF EXISTS (
    SELECT 1 FROM public.public_form_submissions s
     WHERE s.form_id = v_f.id
       AND s.whatsapp_digits = regexp_replace(v_wa, '\D', '', 'g')
  ) THEN
    RAISE EXCEPTION 'Ya tenemos tu respuesta con ese número. ¡Gracias!' USING ERRCODE = '23505';
  END IF;

  -- ── Contexto ──────────────────────────────────────────────────────────
  v_utm := CASE WHEN jsonb_typeof(COALESCE(payload->'utm','{}'::jsonb)) = 'object'
                THEN payload->'utm' ELSE '{}'::jsonb END;
  v_ua  := left(NULLIF(btrim(COALESCE(payload->>'user_agent','')),''), 400);
  v_dev := NULLIF(btrim(COALESCE(payload->>'device','')),'');
  IF v_dev IS NOT NULL AND v_dev NOT IN ('movil','tablet','escritorio') THEN v_dev := NULL; END IF;

  BEGIN
    INSERT INTO public.public_form_submissions (
      form_id, nombre, whatsapp, ciudad, answers,
      utm, referrer, landing_path, user_agent, device, ip
    ) VALUES (
      v_f.id,
      left(v_nombre, 120),
      left(v_wa, 40),
      left(v_ciudad, 80),
      v_ans,
      v_utm,
      left(NULLIF(btrim(COALESCE(payload->>'referrer','')),''), 300),
      left(NULLIF(btrim(COALESCE(payload->>'landing_path','')),''), 200),
      v_ua,
      v_dev,
      left(v_ip, 60)
    );
  EXCEPTION WHEN unique_violation THEN
    -- Dos envíos simultáneos con el mismo número: el EXISTS de arriba los dejó
    -- pasar a los dos y el índice frenó al segundo. Mismo texto, no un 23505
    -- crudo que el visitante no puede interpretar.
    RAISE EXCEPTION 'Ya tenemos tu respuesta con ese número. ¡Gracias!' USING ERRCODE = '23505';
  END;

  RETURN jsonb_build_object('ok', true,
    'title',   v_f.success_title,
    'message', v_f.success_message);
END;
$$;

REVOKE ALL ON FUNCTION public.public_form_submit(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_form_submit(text, jsonb) TO anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 7) public_form_stats — el reporte, agregado del lado de la BASE
-- ════════════════════════════════════════════════════════════════════════
-- Tercera vez que se escribe esta nota y la razón no cambia (migs 197, 198 y
-- 200): agrupar en el navegador un listado que se carga con .limit() da un
-- número que EMPEORA cuanto más crece el negocio. El panel dibuja barras con
-- lo que devuelve esto, no con lo que tenga en memoria.
--
-- Devuelve un conteo por CADA opción del catálogo, incluidas las que nadie
-- eligió — que son justamente las que hay que mirar: una opción en cero puede
-- significar que sobra… o que está mal redactada.
CREATE OR REPLACE FUNCTION public.public_form_stats(
  p_slug text,
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
  v_f      public.public_forms%ROWTYPE;
  v_total  int;
  v_counts jsonb;
  v_otros  jsonb;
  v_texts  jsonb;
  v_ctx    jsonb;
BEGIN
  IF public.get_my_role() IS DISTINCT FROM 'superadmin' THEN
    RAISE EXCEPTION 'solo superadmin' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_f FROM public.public_forms WHERE slug = p_slug;
  IF v_f.id IS NULL THEN
    RETURN jsonb_build_object('disponible', false);
  END IF;

  SELECT count(*) INTO v_total
    FROM public.public_form_submissions s
   WHERE s.form_id = v_f.id
     AND (p_from IS NULL OR s.created_at >= p_from)
     AND (p_to   IS NULL OR s.created_at <  p_to);

  -- Conteos de las preguntas de opción. El LEFT JOIN LATERAL sobre el array de
  -- `multi` hace que quien no marcó NADA cuente como '__none__' en vez de
  -- desaparecer de la pregunta (mismo truco que form_analytics, mig 198).
  WITH src AS (
    SELECT s.* FROM public.public_form_submissions s
     WHERE s.form_id = v_f.id
       AND (p_from IS NULL OR s.created_at >= p_from)
       AND (p_to   IS NULL OR s.created_at <  p_to)
  ), q AS (
    SELECT * FROM public.public_form_questions
     WHERE form_id = v_f.id AND qtype IN ('single','multi')
  ), raw AS (
    SELECT q.qkey AS k,
           CASE WHEN q.qtype = 'multi'
                THEN COALESCE(e.v, '__none__')
                ELSE COALESCE(NULLIF(btrim(src.answers->>q.qkey), ''), '__none__')
           END AS o
      FROM q
      CROSS JOIN src
      LEFT JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN q.qtype = 'multi'
              AND jsonb_typeof(COALESCE(src.answers->q.qkey, '[]'::jsonb)) = 'array'
             THEN src.answers->q.qkey ELSE '[]'::jsonb END) e(v) ON true
  ), pairs AS (
    -- Las respuestas de "Otra" llegan como 'otro:<lo que escribió>'. Se cuentan
    -- todas juntas bajo 'otro': si no, cada texto distinto sería una barra
    -- propia y el gráfico se volvería una lista de respuestas sueltas en vez de
    -- un reporte. El texto no se pierde — sale en `otros`, que es donde de
    -- verdad se lee: esa lista son las opciones que le faltan al formulario.
    SELECT k, CASE WHEN o LIKE 'otro:%' THEN 'otro' ELSE o END AS o FROM raw
  ), counts AS (
    SELECT COALESCE(jsonb_object_agg(k, opts), '{}'::jsonb) AS j
      FROM (SELECT k, jsonb_object_agg(o, c) AS opts
              FROM (SELECT k, o, count(*) AS c FROM pairs GROUP BY 1,2) z
             GROUP BY k) y
  ), otros AS (
    SELECT COALESCE(jsonb_object_agg(k, arr), '{}'::jsonb) AS j
      FROM (SELECT k, jsonb_agg(jsonb_build_object('texto', txt, 'veces', c)
                                ORDER BY c DESC, txt) AS arr
              FROM (SELECT k, substr(o, 6) AS txt, count(*) AS c
                      FROM raw WHERE o LIKE 'otro:%' GROUP BY 1,2) t
             GROUP BY k) u
  )
  -- Los dos salen de la MISMA sentencia: el alcance de un CTE muere con su
  -- statement, así que un segundo SELECT sobre `raw` no compilaría.
  SELECT counts.j, otros.j INTO v_counts, v_otros FROM counts, otros;

  -- Respuestas abiertas. No se agregan en barras: se leen. Es la pregunta que
  -- más suele valer de toda la encuesta ("si pudieras cambiar una sola cosa…"),
  -- y un conteo de textos únicos no dice nada.
  --
  -- Tope de 200 por pregunta, con `row_number()` y no un LIMIT suelto: sin eso
  -- el reporte crecería sin techo y una encuesta con 5.000 respuestas devolvería
  -- un jsonb de megabytes cada vez que alguien abre la pestaña. Las 200 más
  -- recientes alcanzan para leer; para tenerlas TODAS está el export a Excel.
  SELECT COALESCE(jsonb_object_agg(k, arr), '{}'::jsonb) INTO v_texts
    FROM (
      SELECT k, jsonb_agg(jsonb_build_object(
               'texto',  texto, 'nombre', nombre, 'ciudad', ciudad, 'fecha', fecha
             ) ORDER BY fecha DESC) AS arr
        FROM (
          SELECT q.qkey AS k,
                 src.answers->>q.qkey AS texto,
                 src.nombre, src.ciudad, src.created_at AS fecha,
                 row_number() OVER (PARTITION BY q.qkey ORDER BY src.created_at DESC) AS rn
            FROM public.public_form_questions q
            JOIN public.public_form_submissions src ON src.form_id = q.form_id
           WHERE q.form_id = v_f.id
             AND q.qtype IN ('short_text','long_text','number')
             -- Las tres reservadas quedan afuera: `nombre` y `whatsapp` son
             -- short_text, así que sin esto el reporte de opinión vendría con
             -- la agenda de contactos entera adentro. Para eso está la pestaña
             -- Respuestas, que es donde se los va a buscar a propósito.
             AND q.qkey NOT IN ('nombre','whatsapp','ciudad')
             AND COALESCE(btrim(src.answers->>q.qkey), '') <> ''
             AND (p_from IS NULL OR src.created_at >= p_from)
             AND (p_to   IS NULL OR src.created_at <  p_to)
        ) r
       WHERE r.rn <= 200
       GROUP BY k
    ) t;

  -- De dónde vino la gente: la mitad del valor de tener el formulario en casa.
  WITH src AS (
    SELECT s.* FROM public.public_form_submissions s
     WHERE s.form_id = v_f.id
       AND (p_from IS NULL OR s.created_at >= p_from)
       AND (p_to   IS NULL OR s.created_at <  p_to)
  ), pairs AS (
    SELECT 'utm_source' AS k, COALESCE(NULLIF(btrim(utm->>'utm_source'),''), '__none__') AS o FROM src
    UNION ALL SELECT 'utm_campaign', COALESCE(NULLIF(btrim(utm->>'utm_campaign'),''), '__none__') FROM src
    UNION ALL SELECT 'device',       COALESCE(NULLIF(btrim(device),''), '__none__')               FROM src
    UNION ALL SELECT 'ciudad',       COALESCE(NULLIF(btrim(ciudad),''), '__none__')               FROM src
    UNION ALL SELECT 'estado',       estado                                                       FROM src
  )
  SELECT COALESCE(jsonb_object_agg(k, opts), '{}'::jsonb) INTO v_ctx
    FROM (SELECT k, jsonb_object_agg(o, c) AS opts
            FROM (SELECT k, o, count(*) AS c FROM pairs GROUP BY 1,2) z
           GROUP BY k) y;

  RETURN jsonb_build_object(
    'disponible',   true,
    'generated_at', now(),
    'slug',         v_f.slug,
    'title',        v_f.title,
    'is_open',      v_f.is_open,
    'total',        v_total,
    'counts',       v_counts,
    'otros',        v_otros,
    'abiertas',     v_texts,
    'contexto',     v_ctx
  );
END;
$$;

REVOKE ALL ON FUNCTION public.public_form_stats(text, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_form_stats(text, timestamptz, timestamptz) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 8) public_form_export — todas las respuestas, para Excel/PDF
-- ════════════════════════════════════════════════════════════════════════
-- Devuelve UN jsonb con todas las filas y no un SELECT normal a propósito:
-- PostgREST le pone tope de filas a una tabla, no a un valor escalar. Sin esto
-- el "Exportar Excel" del panel exportaría las primeras 1000 y nadie se
-- enteraría — el mismo error silencioso que las migs 197 y 198 tuvieron que
-- arreglar dos veces. El tope duro de 5000 está para que la respuesta no
-- crezca sin límite; si se alcanza, `truncado` avisa en pantalla.
CREATE OR REPLACE FUNCTION public.public_form_export(
  p_slug text,
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
  v_f    public.public_forms%ROWTYPE;
  v_rows jsonb;
  v_n    int;
BEGIN
  IF public.get_my_role() IS DISTINCT FROM 'superadmin' THEN
    RAISE EXCEPTION 'solo superadmin' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_f FROM public.public_forms WHERE slug = p_slug;
  IF v_f.id IS NULL THEN RETURN jsonb_build_object('disponible', false); END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb), count(*)
    INTO v_rows, v_n
    FROM (
      SELECT s.id, s.created_at, s.nombre, s.whatsapp, s.ciudad, s.estado,
             s.answers, s.utm, s.referrer, s.landing_path, s.device, s.notas_internas
        FROM public.public_form_submissions s
       WHERE s.form_id = v_f.id
         AND (p_from IS NULL OR s.created_at >= p_from)
         AND (p_to   IS NULL OR s.created_at <  p_to)
       ORDER BY s.created_at DESC
       LIMIT 5000
    ) t;

  RETURN jsonb_build_object(
    'disponible', true,
    'slug',       v_f.slug,
    'title',      v_f.title,
    'rows',       v_rows,
    'truncado',   v_n >= 5000,
    -- Las columnas del Excel salen del formulario, en su orden, para que la
    -- planilla se lea igual que el formulario. Van CON las opciones: adentro de
    -- `answers` está guardado el value ('mas_300k'), y una planilla llena de
    -- slugs no la puede leer nadie — el panel traduce cada valor a su etiqueta
    -- ('Más de ₲ 300.000') con esto.
    'columns',    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'qkey', q.qkey, 'label', q.label, 'qtype', q.qtype, 'options', q.options)
                       ORDER BY q.sort_order, q.created_at)
        FROM public.public_form_questions q WHERE q.form_id = v_f.id
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.public_form_export(text, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_form_export(text, timestamptz, timestamptz) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 9) Cerrar el alta real mientras corre la encuesta
-- ════════════════════════════════════════════════════════════════════════
-- Decisión de Renato (2026-08-06): mientras se mide la demanda, nadie se da de
-- alta en serio. Todo el mundo pasa por la encuesta y no quedan postulaciones a
-- medio completar que después haya que depurar a mano.
--
-- RIDERS: se usa el interruptor que YA existe y YA se enforca en la base
-- (`ensure_my_rider`, mig 207). Deliberadamente NO se crea un segundo flag: la
-- lección de `is_public` vs `public_browse_enabled` en /clientes es que dos
-- interruptores parecidos para lo mismo terminan contradiciéndose sin que
-- ninguna pantalla lo avise.
UPDATE public.mythos_rider_config
   SET registration_open = false,
       closed_message = 'Todavía no abrimos el registro. Dejanos tus datos en el formulario y te escribimos apenas arranquemos en tu ciudad.'
 WHERE id;

-- PROVEEDORES: no existía interruptor, así que se crea uno — en
-- `marketing_config`, que es el key/value del sitio público que ya edita el
-- superadmin, en vez de una tabla nueva para un booleano.
INSERT INTO public.marketing_config (key, value, is_public)
VALUES ('supplier_signup',
        jsonb_build_object(
          'open', false,
          'closed_message', 'Todavía no abrimos el alta de proveedores. Dejanos tus datos y te avisamos apenas empecemos.'),
        true)
ON CONFLICT (key) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════
-- 10) submit_supplier_application — respeta el interruptor
-- ════════════════════════════════════════════════════════════════════════
-- VERBATIM de la mig 198 §3 con UN cambio marcado "-- 211": el gate del alta.
-- Va al principio, antes de cualquier validación, para que el visitante reciba
-- el mensaje de "todavía no abrimos" y no un error de campo.
CREATE OR REPLACE FUNCTION public.submit_supplier_application(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
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
  v_gate   jsonb;                                   -- 211
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload) <> 'object' THEN
    RAISE EXCEPTION 'solicitud inválida' USING ERRCODE = '22023';
  END IF;

  -- 211: el alta puede estar cerrada mientras corre la encuesta de demanda.
  -- Sin fila en marketing_config el alta queda ABIERTA (comportamiento previo).
  SELECT value INTO v_gate FROM public.marketing_config WHERE key = 'supplier_signup';
  IF v_gate IS NOT NULL AND NOT COALESCE((v_gate->>'open')::boolean, true) THEN
    RAISE EXCEPTION '%', COALESCE(NULLIF(btrim(v_gate->>'closed_message'),''),
                                  'El alta de proveedores está cerrada por ahora.')
      USING ERRCODE = '22023';
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

  IF v_plan IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.marketplace_supplier_plans WHERE slug = v_plan
  ) THEN
    v_plan := NULL;
  END IF;

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
-- 11) SEED — los dos formularios
-- ════════════════════════════════════════════════════════════════════════
-- Nacen CERRADOS (is_open = false). Se prenden desde Superadmin cuando la
-- landing esté lista, no al aplicar la migración.
--
-- ON CONFLICT DO NOTHING en todos lados: re-correr la migración no pisa nada
-- de lo que se haya editado desde el panel. Si hace falta volver al texto
-- original, se borra la pregunta y se re-corre.
INSERT INTO public.public_forms
  (slug, audience, title, description, accent, sort_order, success_title, success_message)
VALUES
  ('delivery-partners', 'delivery',
   'Postulate para ser Delivery Partner de Mythos',
   'Estamos creando una plataforma donde el delivery paga una suscripción fija mensual y el resto de sus ganancias son completamente suyas. Queremos conocer a los repartidores interesados para darles acceso anticipado.',
   '#FF9500', 1,
   '¡Listo! Ya estás en la lista',
   'Te vamos a escribir por WhatsApp apenas abramos la red en tu ciudad. Sos de los primeros.'),
  ('proveedores-interes', 'proveedores',
   'Registro para Proveedores de Mythos',
   'Queremos conectar restaurantes con proveedores sin cobrar comisión por cada venta. Contanos un poco sobre tu negocio.',
   '#AF52DE', 2,
   '¡Gracias! Ya te tenemos anotado',
   'Te vamos a escribir por WhatsApp apenas abramos el alta de proveedores.')
ON CONFLICT (slug) DO NOTHING;

-- ── Preguntas · Delivery ──────────────────────────────────────────────────
-- El orden es EL DEL FORMULARIO. Las tres primeras son las qkey reservadas
-- (nombre/whatsapp/ciudad): se promueven a columna al guardar.
INSERT INTO public.public_form_questions
  (form_id, qkey, label, help, qtype, required, options, allow_other, max_len, placeholder, sort_order)
SELECT f.id, x.qkey, x.label, x.help, x.qtype, x.required, x.options, x.allow_other, x.max_len, x.placeholder, x.sort_order
  FROM public.public_forms f, (VALUES
  ('nombre', 'Nombre y apellido', NULL, 'short_text', true, '[]'::jsonb, false, 120, 'Juan Pérez', 10),
  ('whatsapp', 'Número de WhatsApp', 'Es por donde te vamos a escribir.', 'short_text', true, '[]'::jsonb, false, 40, '0981 123 456', 20),
  ('ciudad', 'Ciudad donde trabajás', NULL, 'single', true, '[
     {"value":"asuncion","label":"Asunción"},
     {"value":"san_lorenzo","label":"San Lorenzo"},
     {"value":"luque","label":"Luque"},
     {"value":"capiata","label":"Capiatá"},
     {"value":"lambare","label":"Lambaré"},
     {"value":"fernando_de_la_mora","label":"Fernando de la Mora"},
     {"value":"limpio","label":"Limpio"},
     {"value":"nemby","label":"Ñemby"},
     {"value":"itaugua","label":"Itauguá"},
     {"value":"mariano_roque_alonso","label":"Mariano Roque Alonso"},
     {"value":"villa_elisa","label":"Villa Elisa"},
     {"value":"san_antonio","label":"San Antonio"},
     {"value":"encarnacion","label":"Encarnación"},
     {"value":"ciudad_del_este","label":"Ciudad del Este"},
     {"value":"pedro_juan_caballero","label":"Pedro Juan Caballero"},
     {"value":"coronel_oviedo","label":"Coronel Oviedo"},
     {"value":"villarrica","label":"Villarrica"},
     {"value":"concepcion","label":"Concepción"}
   ]'::jsonb, true, 80, NULL, 30),
  ('trabaja_hoy', '¿Actualmente trabajás como delivery?', NULL, 'single', true, '[
     {"value":"si","label":"Sí"},
     {"value":"quiero_empezar","label":"No, pero quiero comenzar"}
   ]'::jsonb, false, 40, NULL, 40),
  ('plataformas', '¿En qué plataformas trabajás?', 'Podés marcar varias.', 'multi', false, '[
     {"value":"pedidosya","label":"PedidosYa"},
     {"value":"monchis","label":"Monchis"},
     {"value":"uber_eats","label":"Uber Eats"},
     {"value":"bolt_food","label":"Bolt Food"},
     {"value":"independiente","label":"Independiente"}
   ]'::jsonb, true, 60, NULL, 50),
  ('antiguedad', '¿Hace cuánto trabajás como delivery?', NULL, 'single', false, '[
     {"value":"menos_3m","label":"Menos de 3 meses"},
     {"value":"3_6m","label":"3 a 6 meses"},
     {"value":"6m_1a","label":"6 meses a 1 año"},
     {"value":"mas_1a","label":"Más de 1 año"}
   ]'::jsonb, false, 40, NULL, 60),
  ('horas_dia', '¿Cuántas horas trabajás por día?', NULL, 'single', false, '[
     {"value":"menos_4","label":"Menos de 4"},
     {"value":"4_6","label":"4 a 6"},
     {"value":"6_8","label":"6 a 8"},
     {"value":"mas_8","label":"Más de 8"}
   ]'::jsonb, false, 40, NULL, 70),
  ('horarios', '¿En qué horarios trabajás normalmente?', 'Podés marcar varios.', 'multi', false, '[
     {"value":"manana","label":"Mañana"},
     {"value":"mediodia","label":"Mediodía"},
     {"value":"tarde","label":"Tarde"},
     {"value":"noche","label":"Noche"},
     {"value":"madrugada","label":"Madrugada"}
   ]'::jsonb, false, 40, NULL, 80),
  ('ganancia_dia', 'En un día normal, ¿cuánto ganás aproximadamente?', 'En guaraníes, después de descuentos.', 'single', false, '[
     {"value":"menos_100k","label":"Menos de ₲ 100.000"},
     {"value":"100_150k","label":"₲ 100.000 a 150.000"},
     {"value":"150_200k","label":"₲ 150.000 a 200.000"},
     {"value":"200_300k","label":"₲ 200.000 a 300.000"},
     {"value":"mas_300k","label":"Más de ₲ 300.000"}
   ]'::jsonb, false, 40, NULL, 90),
  ('comision', '¿Sabés aproximadamente qué porcentaje de comisión te descuentan?', NULL, 'single', false, '[
     {"value":"no_se","label":"No lo sé"},
     {"value":"menos_10","label":"Menos del 10%"},
     {"value":"10_20","label":"10% a 20%"},
     {"value":"20_30","label":"20% a 30%"},
     {"value":"mas_30","label":"Más del 30%"}
   ]'::jsonb, false, 40, NULL, 100),
  ('molestias', '¿Qué es lo que más te molesta de las plataformas actuales?', 'Podés marcar varias.', 'multi', false, '[
     {"value":"comisiones","label":"Comisiones altas"},
     {"value":"pocos_pedidos","label":"Pocos pedidos"},
     {"value":"penalizaciones","label":"Penalizaciones"},
     {"value":"soporte","label":"Soporte lento"},
     {"value":"distancia","label":"Distancia de los pedidos"},
     {"value":"pagos","label":"Pagos"}
   ]'::jsonb, true, 60, NULL, 110),
  ('interes_suscripcion', 'Si pagaras una suscripción mensual y no te descontaran comisiones por pedido, ¿te interesaría?', NULL, 'single', true, '[
     {"value":"si","label":"Sí"},
     {"value":"tal_vez","label":"Tal vez"},
     {"value":"no","label":"No"}
   ]'::jsonb, false, 40, NULL, 120),
  ('valor_justo', '¿Qué valor mensual considerarías justo?', 'En guaraníes. Escribí el número que te parezca.', 'number', false, '[]'::jsonb, false, 40, 'Ej.: 150.000', 130),
  ('vehiculo', '¿Con qué te movés?', 'Podés marcar varios.', 'multi', true, '[
     {"value":"moto","label":"Moto"},
     {"value":"bicicleta","label":"Bicicleta"},
     {"value":"auto","label":"Auto"}
   ]'::jsonb, false, 40, NULL, 140),
  ('quiere_probar', '¿Querés ser uno de los primeros en probar Mythos?', NULL, 'single', true, '[
     {"value":"si","label":"Sí"},
     {"value":"no","label":"No"}
   ]'::jsonb, false, 40, NULL, 150),
  -- La pregunta abierta va ÚLTIMA a propósito: es la que más suele valer y la
  -- que más cuesta contestar. Pedirla antes hace abandonar el formulario.
  ('cambio_unico', 'Si pudieras cambiar UNA sola cosa de las plataformas que usás hoy, ¿qué cambiarías y por qué?',
   'Escribí con tus palabras. Esto es lo que más nos sirve.', 'long_text', false, '[]'::jsonb, false, 1500,
   'Lo que más me cambiaría el día a día sería…', 160)
) AS x(qkey, label, help, qtype, required, options, allow_other, max_len, placeholder, sort_order)
WHERE f.slug = 'delivery-partners'
ON CONFLICT (form_id, qkey) DO NOTHING;

-- ── Preguntas · Proveedores ───────────────────────────────────────────────
INSERT INTO public.public_form_questions
  (form_id, qkey, label, help, qtype, required, options, allow_other, max_len, placeholder, sort_order)
SELECT f.id, x.qkey, x.label, x.help, x.qtype, x.required, x.options, x.allow_other, x.max_len, x.placeholder, x.sort_order
  FROM public.public_forms f, (VALUES
  ('empresa', 'Nombre de la empresa', NULL, 'short_text', true, '[]'::jsonb, false, 120, 'Distribuidora San Miguel', 10),
  ('nombre', 'Nombre del responsable', NULL, 'short_text', true, '[]'::jsonb, false, 120, 'María González', 20),
  ('whatsapp', 'WhatsApp', 'Es por donde te vamos a escribir.', 'short_text', true, '[]'::jsonb, false, 40, '0981 123 456', 30),
  ('ciudad', 'Ciudad', NULL, 'single', true, '[
     {"value":"asuncion","label":"Asunción"},
     {"value":"san_lorenzo","label":"San Lorenzo"},
     {"value":"luque","label":"Luque"},
     {"value":"capiata","label":"Capiatá"},
     {"value":"lambare","label":"Lambaré"},
     {"value":"fernando_de_la_mora","label":"Fernando de la Mora"},
     {"value":"limpio","label":"Limpio"},
     {"value":"nemby","label":"Ñemby"},
     {"value":"itaugua","label":"Itauguá"},
     {"value":"mariano_roque_alonso","label":"Mariano Roque Alonso"},
     {"value":"villa_elisa","label":"Villa Elisa"},
     {"value":"san_antonio","label":"San Antonio"},
     {"value":"encarnacion","label":"Encarnación"},
     {"value":"ciudad_del_este","label":"Ciudad del Este"},
     {"value":"pedro_juan_caballero","label":"Pedro Juan Caballero"},
     {"value":"coronel_oviedo","label":"Coronel Oviedo"},
     {"value":"villarrica","label":"Villarrica"},
     {"value":"concepcion","label":"Concepción"}
   ]'::jsonb, true, 80, NULL, 40),
  ('productos', '¿Qué tipo de productos vendés?', 'Podés marcar varios.', 'multi', true, '[
     {"value":"carnes","label":"Carnes"},
     {"value":"verduras","label":"Verduras"},
     {"value":"frutas","label":"Frutas"},
     {"value":"bebidas","label":"Bebidas"},
     {"value":"lacteos","label":"Lácteos"},
     {"value":"panificados","label":"Panificados"},
     {"value":"limpieza","label":"Limpieza"},
     {"value":"envases","label":"Envases"},
     {"value":"congelados","label":"Congelados"}
   ]'::jsonb, true, 60, NULL, 50),
  ('local_fisico', '¿Contás con local físico?', NULL, 'single', false, '[
     {"value":"si","label":"Sí"},
     {"value":"no","label":"No"}
   ]'::jsonb, false, 40, NULL, 60),
  ('hace_entregas', '¿Realizás entregas?', NULL, 'single', false, '[
     {"value":"si","label":"Sí"},
     {"value":"no","label":"No"}
   ]'::jsonb, false, 40, NULL, 70),
  ('como_entrega', 'Si hacés entregas, ¿cómo las realizás?', NULL, 'single', false, '[
     {"value":"propios","label":"Vehículos propios"},
     {"value":"tercerizado","label":"Delivery tercerizado"},
     {"value":"ambos","label":"Ambos"}
   ]'::jsonb, false, 40, NULL, 80),
  ('por_mayor', '¿Vendés al por mayor?', NULL, 'single', false, '[
     {"value":"si","label":"Sí"},
     {"value":"no","label":"No"}
   ]'::jsonb, false, 40, NULL, 90),
  ('minimo', '¿Tenés un monto mínimo de compra?', NULL, 'single', false, '[
     {"value":"no","label":"No"},
     {"value":"si","label":"Sí"}
   ]'::jsonb, false, 40, NULL, 100),
  ('minimo_monto', 'Si tenés mínimo, ¿de cuánto es?', 'En guaraníes. Dejalo vacío si no tenés.', 'number', false, '[]'::jsonb, false, 40, 'Ej.: 500.000', 110),
  ('cuantos_restaurantes', '¿A cuántos restaurantes abastecés actualmente?', NULL, 'single', false, '[
     {"value":"ninguno","label":"Ninguno"},
     {"value":"1_10","label":"1 a 10"},
     {"value":"11_30","label":"11 a 30"},
     {"value":"31_50","label":"31 a 50"},
     {"value":"mas_50","label":"Más de 50"}
   ]'::jsonb, false, 40, NULL, 120),
  ('capta_clientes', '¿Cómo conseguís actualmente nuevos clientes?', 'Podés marcar varias.', 'multi', false, '[
     {"value":"recomendaciones","label":"Recomendaciones"},
     {"value":"facebook","label":"Facebook"},
     {"value":"instagram","label":"Instagram"},
     {"value":"whatsapp","label":"WhatsApp"},
     {"value":"vendedores","label":"Vendedores"}
   ]'::jsonb, true, 60, NULL, 130),
  ('dificultad', '¿Cuál es hoy tu mayor dificultad para vender más?', 'Podés marcar varias.', 'multi', false, '[
     {"value":"nuevos_clientes","label":"Conseguir nuevos clientes"},
     {"value":"cobros","label":"Cobros"},
     {"value":"logistica","label":"Logística"},
     {"value":"competencia","label":"Competencia"},
     {"value":"publicidad","label":"Publicidad"}
   ]'::jsonb, true, 60, NULL, 140),
  ('interes_suscripcion', 'Si pagaras una suscripción fija y pudieras recibir pedidos sin comisión por venta, ¿te interesaría?', NULL, 'single', true, '[
     {"value":"si","label":"Sí"},
     {"value":"tal_vez","label":"Tal vez"},
     {"value":"no","label":"No"}
   ]'::jsonb, false, 40, NULL, 150),
  ('quiere_probar', '¿Querés ser uno de los primeros proveedores de Mythos?', NULL, 'single', true, '[
     {"value":"si","label":"Sí"},
     {"value":"no","label":"No"}
   ]'::jsonb, false, 40, NULL, 160),
  ('cambio_unico', 'Si pudieras cambiar UNA sola cosa de cómo vendés hoy a restaurantes, ¿qué cambiarías y por qué?',
   'Escribí con tus palabras. Esto es lo que más nos sirve.', 'long_text', false, '[]'::jsonb, false, 1500,
   'Lo que más me cambiaría el negocio sería…', 170)
) AS x(qkey, label, help, qtype, required, options, allow_other, max_len, placeholder, sort_order)
WHERE f.slug = 'proveedores-interes'
ON CONFLICT (form_id, qkey) DO NOTHING;

COMMIT;

-- Recargar el cache de esquema de PostgREST (tablas, policies y funciones nuevas).
NOTIFY pgrst, 'reload schema';

SELECT 'migración 211 aplicada — motor de formularios públicos + alta real cerrada (riders y proveedores)' AS status;
