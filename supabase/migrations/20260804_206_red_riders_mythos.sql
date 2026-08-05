-- ════════════════════════════════════════════════════════════════════════
-- 206 · RED DE RIDERS MYTHOS — identidad, documentos, contrato de adhesión,
--       locales socios, despacho por oferta, reputación, disciplina,
--       expedientes y liquidaciones.
-- ────────────────────────────────────────────────────────────────────────
-- [PARA PEGAR EN SUPABASE]  ·  rol postgres, SQL Editor en INGLÉS.
-- Aplicar DESPUÉS de la 205.
--
-- EL EJE NUEVO
--   hoy:   restaurante → sus riders          (un rider pertenece a UN local)
--   acá:   persona     → N restaurantes      (el rider los atraviesa)
-- Es el mismo movimiento que la mig 200 hizo con el comensal, y por las mismas
-- razones. Por eso copia sus decisiones, no inventa otras.
--
-- LO QUE **NO** HACE — y es lo que garantiza que no rompe el delivery de hoy
--   • NO crea un rol nuevo en `user_roles`. get_my_role() (mig 029) devuelve UN
--     rol con LIMIT 1 y de él cuelga la RLS de ~25 tablas. Además un rol exige
--     `restaurant_id`, y un rider de la red no tiene UNO. Su identidad vive
--     SÓLO en `mythos_riders` (RLS `auth_user_id = auth.uid()`), igual que
--     `diners`. El rider "propio" que un local contrata sigue EXACTAMENTE como
--     hoy: cuenta por cédula, rol 'rider' en user_roles, ficha en
--     delivery_riders. Los dos conviven.
--   • NO reimplementa el despacho. `assign_delivery_order`,
--     `rebalance_delivery_dispatch`, `transfer_delivery_order` y el rescate de
--     huérfanos (migs 156/189) se conservan; sólo se les agrega UN filtro
--     (`dispatch_auto`) para que un rider en modo oferta no reciba pedidos sin
--     haberlos aceptado. Un local que no entra a la red no cambia en nada.
--   • NO reimplementa el panel de trabajo. El rider de la red trabaja en el
--     mismo `/delivery-rider` que ya existe: la red se materializa como una
--     fila de `delivery_riders` POR CADA local — o sea, el vínculo ES la ficha
--     que el despacho ya sabe leer. Cero código de reparto duplicado.
--   • NO toca el dinero del pedido. Mythos no cobra ni liquida: registra lo que
--     el local le debe al rider y el local marca cuándo pagó.
--
-- CÓMO ENTRA UN PEDIDO A LA RED (extensión, no reemplazo)
--   El despacho de hoy termina en "no_rider" → el pedido queda HUÉRFANO y lo
--   rescata el trigger cuando alguien se conecta (mig 189). La red se engancha
--   JUSTO AHÍ: si el local es socio activo y quedaron huérfanos, se ofrecen a
--   los riders de la red, de a uno, con tiempo para aceptar. Es decir: la red
--   es lo que pasa cuando el local se queda sin repartidor propio. Un local sin
--   convenio nunca llega a esa rama.
--
-- Todo ADITIVO e idempotente. Sin aplicar: `/riders` avisa que la red no está
-- disponible, el módulo Delivery del admin muestra la tarjeta de "Red Mythos"
-- en modo informativo y NADA del delivery actual cambia.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- 1) CONFIGURACIÓN GLOBAL DE LA RED
-- ════════════════════════════════════════════════════════════════════════
-- Fila única (id=true), mismo molde que diner_app_config (mig 200) y
-- marketing_config (mig 110): lectura pública, escritura sólo de superadmin.
-- TODO lo que gobierna la red se edita acá desde Superadmin › Riders, sin
-- migración: tiempos, distancias, penalizaciones, avisos de vencimiento y el
-- copy de la landing.
CREATE TABLE IF NOT EXISTS public.mythos_rider_config (
  id                      BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),

  -- Portero. La red nace APAGADA: prenderla es una decisión de negocio, no un
  -- efecto de aplicar la migración (mismo criterio que Marketing en la 197).
  network_enabled         BOOLEAN NOT NULL DEFAULT false,
  registration_open       BOOLEAN NOT NULL DEFAULT true,
  closed_message          TEXT NOT NULL DEFAULT 'Las postulaciones para riders están cerradas por ahora. Volvé pronto.',

  -- Requisitos del alta
  min_age                 INT     NOT NULL DEFAULT 18,
  require_selfie          BOOLEAN NOT NULL DEFAULT true,
  require_bank            BOOLEAN NOT NULL DEFAULT true,
  require_training        BOOLEAN NOT NULL DEFAULT false,
  training_url            TEXT,
  auto_approve            BOOLEAN NOT NULL DEFAULT false,

  -- Despacho por oferta
  accept_seconds          INT     NOT NULL DEFAULT 60 CHECK (accept_seconds BETWEEN 10 AND 900),
  max_distance_km         NUMERIC NOT NULL DEFAULT 10 CHECK (max_distance_km > 0),
  offer_max_riders        INT     NOT NULL DEFAULT 6  CHECK (offer_max_riders BETWEEN 1 AND 50),

  -- Geolocalización: NUNCA si el rider está desconectado (se enforca en la RPC).
  geo_enabled             BOOLEAN NOT NULL DEFAULT true,
  geo_interval_seconds    INT     NOT NULL DEFAULT 60 CHECK (geo_interval_seconds BETWEEN 15 AND 900),

  -- Disciplina
  max_rejections_per_day    INT   NOT NULL DEFAULT 5,
  warnings_before_suspension INT  NOT NULL DEFAULT 3,
  suspension_days           INT   NOT NULL DEFAULT 7,

  -- Vencimientos: a cuántos días antes se avisa.
  expiry_warn_days        INT[]   NOT NULL DEFAULT '{30,15,7,1}',
  auto_suspend_on_expiry  BOOLEAN NOT NULL DEFAULT true,

  -- Copy de la landing pública. JSONB y no columnas, por el mismo motivo que
  -- `diner_app_config.site_texts` (mig 204): agregar una frase no puede exigir
  -- una migración.
  site_texts              JSONB   NOT NULL DEFAULT '{}'::jsonb,
  hero_image_url          TEXT,

  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.mythos_rider_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.mythos_rider_config IS
  'Config global de la Red de Riders Mythos. Fila única. network_enabled=false ⇒ la red no existe para nadie. Se edita en Superadmin › Riders › Configuración.';


-- ════════════════════════════════════════════════════════════════════════
-- 2) CATÁLOGO DE DOCUMENTOS EXIGIDOS
-- ════════════════════════════════════════════════════════════════════════
-- Editable por el superadmin: qué papeles se piden, a qué vehículos aplican,
-- cuáles vencen y cuáles son obligatorios. Renato pidió explícitamente poder
-- revisarlo antes del lanzamiento — por eso es una tabla y no una constante.
CREATE TABLE IF NOT EXISTS public.mythos_rider_doc_types (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL,
  label       TEXT NOT NULL,
  help        TEXT,
  required    BOOLEAN NOT NULL DEFAULT true,
  -- Vacío = aplica a todos los vehículos. Si no, sólo a los listados
  -- (la licencia no se le pide a quien reparte en bici).
  vehicles    TEXT[]  NOT NULL DEFAULT '{}',
  has_expiry  BOOLEAN NOT NULL DEFAULT false,
  sort_order  INT     NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_rider_doc_types_slug
  ON public.mythos_rider_doc_types (lower(btrim(slug)));

INSERT INTO public.mythos_rider_doc_types (slug, label, help, required, vehicles, has_expiry, sort_order)
VALUES
  ('cedula_frente', 'Cédula de identidad — frente', 'Vigente y legible.',                     true,  '{}',                 true,  10),
  ('cedula_dorso',  'Cédula de identidad — dorso',  'Vigente y legible.',                     true,  '{}',                 true,  20),
  ('licencia',      'Licencia de conducir',         'Sólo si manejás moto o auto. Vigente.',  true,  '{moto,auto}',        true,  30),
  ('foto_vehiculo', 'Foto del vehículo',            'Que se vea la chapa/patente.',           true,  '{moto,auto}',        false, 40),
  ('cedula_verde',  'Cédula verde o título',        'Documento de propiedad del vehículo.',   false, '{moto,auto}',        true,  50),
  ('seguro',        'Seguro vigente',               'Si tu vehículo lo requiere.',            false, '{moto,auto}',        true,  60),
  ('antecedentes',  'Certificado de antecedentes',  'Según lo que exija la normativa.',       false, '{}',                 true,  70)
ON CONFLICT DO NOTHING;

COMMENT ON TABLE public.mythos_rider_doc_types IS
  'Qué documentos se le exigen a un rider. Editable en Superadmin › Riders › Configuración: cambiar los requisitos NO pide migración.';


-- ════════════════════════════════════════════════════════════════════════
-- 3) EL RIDER — identidad de plataforma
-- ════════════════════════════════════════════════════════════════════════
-- Una persona = un usuario de Auth = una fila acá. No pertenece a ningún local.
-- El vínculo con cada local vive en `delivery_riders` (ver bloque 8).
CREATE TABLE IF NOT EXISTS public.mythos_riders (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id   UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,

  -- ── Datos personales ──
  first_name     TEXT,
  last_name      TEXT,
  birth_date     DATE,
  gender         TEXT,                 -- opcional, texto libre a propósito
  doc_number     TEXT,                 -- cédula / documento de identidad
  nationality    TEXT,
  email          TEXT,
  phone          TEXT,
  whatsapp       TEXT,
  address        TEXT,
  city           TEXT,
  department     TEXT,
  photo_url      TEXT,                 -- foto de perfil (bucket público)
  selfie_path    TEXT,                 -- selfie de validación (bucket PRIVADO)

  -- ── Vehículo ──
  vehicle_type   TEXT NOT NULL DEFAULT 'moto'
                 CHECK (vehicle_type IN ('moto','bici','auto','otro')),
  vehicle_brand  TEXT,
  vehicle_model  TEXT,
  vehicle_color  TEXT,
  vehicle_year   INT,
  vehicle_plate  TEXT,
  vehicle_chassis TEXT,
  vehicle_engine  TEXT,

  -- ── Datos bancarios: para que el RESTAURANTE le transfiera. Mythos no toca
  --    esta plata; sólo transporta el dato para que el pago sea posible. ──
  bank_holder    TEXT,
  bank_name      TEXT,
  bank_account   TEXT,
  bank_alias     TEXT,
  bank_account_type TEXT,

  -- ── Estado (la máquina que pidió Renato) ──
  --   borrador   → está completando la solicitud
  --   pendiente  → solicitud enviada, esperando revisión
  --   observado  → le faltan papeles o hay una observación que corregir
  --   rechazado  → no se aprueba
  --   aprobado   → pasó la revisión; si hay capacitación obligatoria, la debe
  --                hacer antes de operar
  --   activo     → puede recibir pedidos
  --   suspendido → temporal (mora documental o sanción), reversible
  --   bloqueado  → definitivo por decisión de Mythos
  --   baja       → se fue por decisión propia
  status         TEXT NOT NULL DEFAULT 'borrador'
                 CHECK (status IN ('borrador','pendiente','observado','rechazado',
                                   'aprobado','activo','suspendido','bloqueado','baja')),
  status_reason  TEXT,
  status_changed_at TIMESTAMPTZ,
  suspended_until   TIMESTAMPTZ,

  -- ── Operativo ──
  availability   TEXT NOT NULL DEFAULT 'desconectado'
                 CHECK (availability IN ('disponible','ocupado','pausado','desconectado')),
  last_lat       NUMERIC,
  last_lng       NUMERIC,
  last_location_at TIMESTAMPTZ,
  last_seen_at   TIMESTAMPTZ,

  -- ── Reputación / desempeño (denormalizado, lo recalculan las RPC) ──
  deliveries_count INT NOT NULL DEFAULT 0,
  rating_avg     NUMERIC,
  rating_count   INT NOT NULL DEFAULT 0,
  avg_minutes    NUMERIC,
  compliance_pct NUMERIC,               -- entregados / (entregados + rechazados+vencidos)
  warnings_count INT NOT NULL DEFAULT 0,

  training_done_at TIMESTAMPTZ,
  submitted_at   TIMESTAMPTZ,
  approved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sólo dígitos, para deduplicar teléfono y documento como hace `customers`
-- (mig 196): "0981 123 456" y "0981123456" son la misma persona.
ALTER TABLE public.mythos_riders
  ADD COLUMN IF NOT EXISTS phone_digits TEXT
    GENERATED ALWAYS AS (regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g')) STORED,
  ADD COLUMN IF NOT EXISTS doc_digits TEXT
    GENERATED ALWAYS AS (regexp_replace(COALESCE(doc_number,''), '[^0-9]', '', 'g')) STORED;

-- Las tres validaciones "duplicado" que pidió Renato, en la BASE. El front las
-- repite para dar un mensaje amable, pero la que manda es ésta: un asterisco en
-- el HTML no es una validación (misma doctrina que la mig 198).
-- Se excluye a los dados de baja/rechazados: si no, una baja bloquearía para
-- siempre la cédula de esa persona.
CREATE UNIQUE INDEX IF NOT EXISTS ux_mythos_riders_doc
  ON public.mythos_riders (doc_digits)
  WHERE doc_digits <> '' AND status NOT IN ('baja','rechazado');
CREATE UNIQUE INDEX IF NOT EXISTS ux_mythos_riders_phone
  ON public.mythos_riders (phone_digits)
  WHERE phone_digits <> '' AND status NOT IN ('baja','rechazado');
CREATE UNIQUE INDEX IF NOT EXISTS ux_mythos_riders_plate
  ON public.mythos_riders (upper(regexp_replace(COALESCE(vehicle_plate,''), '[^A-Za-z0-9]', '', 'g')))
  WHERE COALESCE(vehicle_plate,'') <> '' AND status NOT IN ('baja','rechazado');

CREATE INDEX IF NOT EXISTS ix_mythos_riders_status ON public.mythos_riders (status);
CREATE INDEX IF NOT EXISTS ix_mythos_riders_city   ON public.mythos_riders (lower(btrim(COALESCE(city,''))));
CREATE INDEX IF NOT EXISTS ix_mythos_riders_avail  ON public.mythos_riders (availability) WHERE status = 'activo';

COMMENT ON TABLE public.mythos_riders IS
  'Rider de la Red Mythos: identidad de PLATAFORMA, no de un restaurante. Trabaja para N locales. Concentra PII (documento, domicilio, datos bancarios): ni anon ni el staff de un local la leen — ver RLS.';


-- ════════════════════════════════════════════════════════════════════════
-- 4) DOCUMENTOS DEL RIDER
-- ════════════════════════════════════════════════════════════════════════
-- Los archivos viven en el bucket PRIVADO `rider-docs`. Acá va el asiento, la
-- vigencia y la revisión. Un documento aprobado NO se puede reemplazar en
-- silencio: subir uno nuevo archiva el anterior y vuelve a 'pendiente'
-- (requisito explícito de Renato — "toda actualización vuelve a revisión").
CREATE TABLE IF NOT EXISTS public.mythos_rider_documents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id     UUID NOT NULL REFERENCES public.mythos_riders(id) ON DELETE CASCADE,
  doc_slug     TEXT NOT NULL,
  file_path    TEXT NOT NULL,
  mime         TEXT,
  issued_at    DATE,
  expires_at   DATE,
  status       TEXT NOT NULL DEFAULT 'pendiente'
               CHECK (status IN ('pendiente','aprobado','rechazado','vencido')),
  review_note  TEXT,
  reviewed_by  UUID,
  reviewed_at  TIMESTAMPTZ,
  -- Aviso de vencimiento ya enviado (evita repetir el mismo umbral).
  warned_days  INT,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  replaced_at  TIMESTAMPTZ
);

-- Un documento VIGENTE por tipo y rider. Los reemplazados quedan como historial
-- (nunca se borran: son la prueba de qué se aprobó y cuándo).
CREATE UNIQUE INDEX IF NOT EXISTS ux_rider_documents_current
  ON public.mythos_rider_documents (rider_id, doc_slug)
  WHERE replaced_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_rider_documents_expiry
  ON public.mythos_rider_documents (expires_at)
  WHERE replaced_at IS NULL AND expires_at IS NOT NULL;


-- ════════════════════════════════════════════════════════════════════════
-- 5) CONTRATO DIGITAL DE ADHESIÓN
-- ════════════════════════════════════════════════════════════════════════
-- El punto que Renato marcó como "muy importante": antes de habilitar al primer
-- rider tiene que existir la aceptación registrada con fecha, hora, IP y
-- VERSIÓN del documento. El texto es versionado para que una redacción nueva no
-- reescriba lo que las personas ya aceptaron: la prueba se rompería.
CREATE TABLE IF NOT EXISTS public.mythos_rider_contract_versions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version      TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  is_current   BOOLEAN NOT NULL DEFAULT false,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID
);

-- Una sola versión vigente a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS ux_rider_contract_current
  ON public.mythos_rider_contract_versions ((is_current)) WHERE is_current;

CREATE TABLE IF NOT EXISTS public.mythos_rider_contracts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id     UUID NOT NULL REFERENCES public.mythos_riders(id) ON DELETE CASCADE,
  version      TEXT NOT NULL,
  body_hash    TEXT,                    -- huella del texto aceptado
  accepted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip           TEXT,
  user_agent   TEXT
);

CREATE INDEX IF NOT EXISTS ix_rider_contracts_rider ON public.mythos_rider_contracts (rider_id);

COMMENT ON TABLE public.mythos_rider_contracts IS
  'Comprobante de aceptación del contrato de adhesión y de la declaración de prestador independiente. Inmutable: no tiene policy de UPDATE ni de DELETE — es prueba, no un dato editable.';

-- Semilla del contrato. La redacción DEFINITIVA la tiene que revisar un
-- abogado según la legislación paraguaya (así lo pidió Renato); lo que la
-- arquitectura garantiza desde el día uno es que exista, esté versionado y
-- quede auditado quién lo aceptó, cuándo y desde dónde.
INSERT INTO public.mythos_rider_contract_versions (version, title, body, is_current)
SELECT 'v1-borrador', 'Términos de la Red de Riders Mythos',
$CT$BORRADOR SUJETO A REVISIÓN LEGAL — no publicar sin la validación de un
abogado matriculado en la República del Paraguay.

1. OBJETO. Mythos es una plataforma tecnológica que conecta a repartidores
independientes con restaurantes que utilizan sus servicios. Mythos no presta
por sí el servicio de reparto.

2. DECLARACIÓN DE PRESTADOR INDEPENDIENTE. El Rider declara que utiliza la
plataforma para vincularse con restaurantes por cuenta y riesgo propios, con
sus propios medios y organizando libremente su tiempo. No existe relación de
dependencia, exclusividad ni horario obligatorio con Mythos.

3. PAGOS. El pago del servicio de reparto lo realiza DIRECTAMENTE el
restaurante al Rider, según los términos que cada restaurante publique en la
plataforma. Mythos NO administra, retiene ni intermedia el dinero del pedido
ni la contraprestación del reparto.

4. DOCUMENTACIÓN. El Rider se obliga a mantener vigente la documentación
exigida (identidad, licencia, seguro y la que corresponda a su vehículo). El
vencimiento de un documento obligatorio suspende su participación hasta
regularizarlo.

5. CONDUCTA. El Rider se obliga a tratar con respeto a clientes y personal de
los restaurantes, a cuidar el pedido y a cumplir las entregas aceptadas. Los
incumplimientos pueden derivar en advertencias, suspensiones o bloqueo.

6. DATOS PERSONALES. Mythos trata los datos del Rider para verificar su
identidad, habilitar su participación y permitir que el restaurante le pague.
Los documentos se almacenan de forma privada y no se comparten con terceros
fuera de ese fin.

7. VIGENCIA. La aceptación de estos términos queda registrada con fecha, hora,
dirección IP y versión del documento, y podrá ser consultada para auditoría.$CT$,
       true
WHERE NOT EXISTS (SELECT 1 FROM public.mythos_rider_contract_versions);

-- ════════════════════════════════════════════════════════════════════════
-- 6) LOCALES SOCIOS — "trabajar con Mythos Delivery"
-- ════════════════════════════════════════════════════════════════════════
-- Un restaurante NO entra a la red por defecto. La solicita desde
-- Admin › Delivery › Riders › Red Mythos y el superadmin la aprueba. Mientras
-- no sea socio activo, nada de esta migración lo alcanza.
CREATE TABLE IF NOT EXISTS public.mythos_delivery_partners (
  restaurant_id  UUID PRIMARY KEY REFERENCES public.restaurants(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'pendiente'
                 CHECK (status IN ('pendiente','activo','pausado','rechazado')),

  -- Qué le paga el local al rider por entrega. Es lo que el rider ve ANTES de
  -- aceptar: sin esto, "Pago Delivery" en la oferta sería un campo vacío.
  pay_type       TEXT NOT NULL DEFAULT 'fixed' CHECK (pay_type IN ('pct','fixed')),
  pay_value      NUMERIC NOT NULL DEFAULT 0,
  pay_method     TEXT NOT NULL DEFAULT 'transferencia'
                 CHECK (pay_method IN ('transferencia','efectivo','ambos')),

  -- 'auto'   = el rider de la red entra al despacho normal, como uno propio.
  -- 'oferta' = se le ofrece el pedido y tiene que aceptarlo (flujo del brief).
  dispatch_mode  TEXT NOT NULL DEFAULT 'oferta'
                 CHECK (dispatch_mode IN ('auto','oferta')),

  -- Cupo y puerta de entrada de riders.
  max_riders     INT,
  auto_accept_riders BOOLEAN NOT NULL DEFAULT true,

  contact_name   TEXT,
  contact_phone  TEXT,
  note           TEXT,
  review_note    TEXT,
  requested_by   UUID,
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by    UUID,
  reviewed_at    TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.mythos_delivery_partners IS
  'Restaurantes que trabajan con la Red de Riders Mythos. Sin fila = no participa y el despacho de la red nunca lo mira.';


-- ════════════════════════════════════════════════════════════════════════
-- 7) EL VÍNCULO rider ↔ local ES una fila de delivery_riders
-- ════════════════════════════════════════════════════════════════════════
-- Decisión central de la migración. Se podría haber creado una tabla
-- `rider_links` nueva, pero entonces `assign_delivery_order`, el rebalanceo, el
-- rescate de huérfanos, la pestaña Riders del admin, cocina, caja y el panel
-- del repartidor tendrían que aprender a leer DOS fuentes de riders — y el
-- primer olvido deja pedidos sin repartir. Materializando el vínculo como la
-- ficha que el sistema YA lee, todo eso sigue funcionando sin tocarse.
--   · mythos_rider_id NULL  → rider PROPIO del local (todo como hoy).
--   · mythos_rider_id lleno → rider de la red trabajando en ese local.
ALTER TABLE public.delivery_riders
  ADD COLUMN IF NOT EXISTS mythos_rider_id UUID REFERENCES public.mythos_riders(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS source          TEXT NOT NULL DEFAULT 'propio'
                                           CHECK (source IN ('propio','mythos')),
  ADD COLUMN IF NOT EXISTS link_status     TEXT NOT NULL DEFAULT 'activo'
                                           CHECK (link_status IN ('activo','pausado')),
  -- Filtro nuevo del despacho automático: un rider en modo oferta NO puede
  -- recibir pedidos sin haberlos aceptado. Default true ⇒ los riders propios
  -- de hoy se comportan EXACTAMENTE igual que antes de esta migración.
  ADD COLUMN IF NOT EXISTS dispatch_auto   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS linked_at       TIMESTAMPTZ NOT NULL DEFAULT now();

-- La 101 puso UNIQUE(user_id): un usuario = UNA ficha de rider = un solo local.
-- Esa es exactamente la restricción que impide la red. Se reemplaza por
-- UNIQUE(restaurant_id, user_id), que sigue impidiendo lo que aquella evitaba
-- —dos fichas de la misma persona en el MISMO local— y habilita las N locales.
DROP INDEX IF EXISTS public.uniq_delivery_riders_user;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_delivery_riders_user_rest
  ON public.delivery_riders (restaurant_id, user_id) WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_delivery_riders_mythos
  ON public.delivery_riders (mythos_rider_id) WHERE mythos_rider_id IS NOT NULL;

COMMENT ON COLUMN public.delivery_riders.mythos_rider_id IS
  'NULL = rider propio del local (como siempre). Lleno = fila-vínculo de un rider de la Red Mythos: la ficha que el despacho ya sabe leer.';
COMMENT ON COLUMN public.delivery_riders.dispatch_auto IS
  'false = no recibe pedidos por asignación automática; sólo por oferta aceptada. Los riders propios lo tienen en true.';


-- ════════════════════════════════════════════════════════════════════════
-- 8) OFERTAS DE PEDIDO (aceptar / rechazar, con tiempo)
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.mythos_rider_offers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_order_id UUID NOT NULL REFERENCES public.delivery_orders(id) ON DELETE CASCADE,
  rider_id          UUID NOT NULL REFERENCES public.mythos_riders(id)  ON DELETE CASCADE,
  restaurant_id     UUID NOT NULL REFERENCES public.restaurants(id)    ON DELETE CASCADE,
  link_id           UUID REFERENCES public.delivery_riders(id) ON DELETE SET NULL,
  seq               INT  NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'pendiente'
                    CHECK (status IN ('pendiente','aceptada','rechazada','vencida','cancelada')),
  distance_km       NUMERIC,
  pay_estimate      NUMERIC,
  offered_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  responded_at      TIMESTAMPTZ
);

-- Una oferta PENDIENTE por pedido: el reparto es secuencial (si vence, pasa al
-- siguiente). Sin esto, dos riders podrían aceptar el mismo pedido.
CREATE UNIQUE INDEX IF NOT EXISTS ux_rider_offers_one_pending
  ON public.mythos_rider_offers (delivery_order_id) WHERE status = 'pendiente';
-- No se le ofrece dos veces el mismo pedido a la misma persona.
CREATE UNIQUE INDEX IF NOT EXISTS ux_rider_offers_once
  ON public.mythos_rider_offers (delivery_order_id, rider_id);
CREATE INDEX IF NOT EXISTS ix_rider_offers_rider
  ON public.mythos_rider_offers (rider_id, status);


-- ════════════════════════════════════════════════════════════════════════
-- 9) REPUTACIÓN — no sólo estrellas
-- ════════════════════════════════════════════════════════════════════════
-- Renato pidió separar por aspecto. Las dimensiones son un CATÁLOGO editable,
-- igual que `review_dimensions` de la mig 200: agregar "cuidado del pedido" no
-- puede exigir una migración.
CREATE TABLE IF NOT EXISTS public.mythos_rider_rating_dimensions (
  slug       TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO public.mythos_rider_rating_dimensions (slug, label, sort_order) VALUES
  ('puntualidad',  'Puntualidad',        10),
  ('presentacion', 'Presentación',       20),
  ('comunicacion', 'Comunicación',       30),
  ('cuidado',      'Cuidado del pedido', 40),
  ('cumplimiento', 'Cumplimiento',       50)
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.mythos_rider_ratings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id          UUID NOT NULL REFERENCES public.mythos_riders(id) ON DELETE CASCADE,
  restaurant_id     UUID REFERENCES public.restaurants(id) ON DELETE SET NULL,
  delivery_order_id UUID REFERENCES public.delivery_orders(id) ON DELETE SET NULL,
  source            TEXT NOT NULL DEFAULT 'restaurante'
                    CHECK (source IN ('restaurante','cliente','mythos')),
  stars             INT  NOT NULL CHECK (stars BETWEEN 1 AND 5),
  -- {puntualidad:5, comunicacion:4, ...} — validado contra el catálogo en la RPC.
  scores            JSONB NOT NULL DEFAULT '{}'::jsonb,
  comment           TEXT,
  created_by        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Una calificación por pedido y origen: el local califica una vez, el cliente
-- una vez. Sin esto, un local enojado podría hundir a un rider a repetición.
CREATE UNIQUE INDEX IF NOT EXISTS ux_rider_ratings_once
  ON public.mythos_rider_ratings (delivery_order_id, source)
  WHERE delivery_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_rider_ratings_rider ON public.mythos_rider_ratings (rider_id);


-- ════════════════════════════════════════════════════════════════════════
-- 10) DISCIPLINA — advertencia → suspensión → bloqueo, todo auditado
-- ════════════════════════════════════════════════════════════════════════
-- "Nunca borrar historial" (Renato). Por eso esta tabla NO tiene policy de
-- UPDATE ni de DELETE para nadie, ni siquiera para el superadmin: una sanción
-- se corrige agregando otra fila (una reactivación), no reescribiendo la vieja.
CREATE TABLE IF NOT EXISTS public.mythos_rider_incidents (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id   UUID NOT NULL REFERENCES public.mythos_riders(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL
             CHECK (kind IN ('observacion','advertencia','suspension','bloqueo',
                             'reactivacion','baja','nota','aprobacion','rechazo')),
  reason     TEXT,
  detail     TEXT,
  days       INT,
  effective_until TIMESTAMPTZ,
  case_id    UUID,
  automatic  BOOLEAN NOT NULL DEFAULT false,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_rider_incidents_rider
  ON public.mythos_rider_incidents (rider_id, created_at DESC);


-- ════════════════════════════════════════════════════════════════════════
-- 11) EXPEDIENTES — cuando hay conflicto
-- ════════════════════════════════════════════════════════════════════════
-- Participan cliente, restaurante, rider y administrador; cada uno adjunta su
-- evidencia; el superadmin resuelve y la resolución queda firmada.
CREATE TABLE IF NOT EXISTS public.mythos_rider_cases (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code              TEXT NOT NULL UNIQUE,
  rider_id          UUID REFERENCES public.mythos_riders(id) ON DELETE SET NULL,
  restaurant_id     UUID REFERENCES public.restaurants(id)   ON DELETE SET NULL,
  delivery_order_id UUID REFERENCES public.delivery_orders(id) ON DELETE SET NULL,
  subject           TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'abierto'
                    CHECK (status IN ('abierto','en_revision','esperando','resuelto','cerrado')),
  resolution        TEXT,
  opened_by         UUID,
  opened_role       TEXT,
  resolved_by       UUID,
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mythos_rider_case_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     UUID NOT NULL REFERENCES public.mythos_rider_cases(id) ON DELETE CASCADE,
  author_id   UUID,
  author_role TEXT NOT NULL CHECK (author_role IN ('cliente','restaurante','rider','admin')),
  author_name TEXT,
  body        TEXT,
  file_path   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_rider_case_messages_case
  ON public.mythos_rider_case_messages (case_id, created_at);


-- ════════════════════════════════════════════════════════════════════════
-- 12) NOTIFICACIONES
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.mythos_rider_notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id   UUID NOT NULL REFERENCES public.mythos_riders(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'info',
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_rider_notifications_rider
  ON public.mythos_rider_notifications (rider_id, created_at DESC);


-- ════════════════════════════════════════════════════════════════════════
-- 13) LIQUIDACIONES — el restaurante le paga al rider
-- ════════════════════════════════════════════════════════════════════════
-- Mythos NO administra este dinero: registra lo que el local le debe al rider
-- por un período y el local marca cuándo lo pagó. Es un libro, no una billetera.
CREATE TABLE IF NOT EXISTS public.mythos_rider_settlements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id      UUID NOT NULL REFERENCES public.mythos_riders(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id)   ON DELETE CASCADE,
  period_from   DATE NOT NULL,
  period_to     DATE NOT NULL,
  deliveries    INT  NOT NULL DEFAULT 0,
  amount        NUMERIC NOT NULL DEFAULT 0,
  method        TEXT,
  reference     TEXT,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','pagado')),
  paid_at       TIMESTAMPTZ,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_rider_settlements_rider
  ON public.mythos_rider_settlements (rider_id, period_to DESC);

-- ════════════════════════════════════════════════════════════════════════
-- 14) ALMACENAMIENTO — dos buckets, y uno de ellos NUNCA es público
-- ════════════════════════════════════════════════════════════════════════
-- `rider-docs` es PRIVADO: guarda cédulas, licencias, seguros y la selfie de
-- validación. Un bucket público acá sería una filtración de documentos de
-- identidad a un fetch de distancia. Mismo criterio que `comprobantes` (183).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('rider-docs','rider-docs', false, 8388608,
        ARRAY['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
ON CONFLICT (id) DO UPDATE
  SET public             = false,
      file_size_limit    = 8388608,
      allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/heic','application/pdf'];

-- La carpeta raíz de cada archivo es el auth.uid() del rider: eso es lo que
-- hace que "lo mío" sea verificable sin consultar otra tabla.
DROP POLICY IF EXISTS riderdocs_own_insert ON storage.objects;
CREATE POLICY riderdocs_own_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'rider-docs' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS riderdocs_own_select ON storage.objects;
CREATE POLICY riderdocs_own_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'rider-docs' AND (
           (storage.foldername(name))[1] = auth.uid()::text
           OR public.get_my_role() = 'superadmin'));

DROP POLICY IF EXISTS riderdocs_own_update ON storage.objects;
CREATE POLICY riderdocs_own_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'rider-docs' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS riderdocs_admin_delete ON storage.objects;
CREATE POLICY riderdocs_admin_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'rider-docs' AND (
           (storage.foldername(name))[1] = auth.uid()::text
           OR public.get_my_role() = 'superadmin'));

-- `riders` es PÚBLICO y guarda SÓLO la foto de perfil: la ve el cliente que
-- espera su pedido y el local que despacha. Nada más va acá.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('riders','riders', true, 3145728, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public             = true,
      file_size_limit    = 3145728,
      allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp'];

DROP POLICY IF EXISTS riders_public_read ON storage.objects;
CREATE POLICY riders_public_read ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = 'riders');

DROP POLICY IF EXISTS riders_own_write ON storage.objects;
CREATE POLICY riders_own_write ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'riders' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS riders_own_update ON storage.objects;
CREATE POLICY riders_own_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'riders' AND (
           (storage.foldername(name))[1] = auth.uid()::text
           OR public.get_my_role() = 'superadmin'));


-- ════════════════════════════════════════════════════════════════════════
-- 15) HELPER — "¿cuál es MI ficha de rider?"
-- ════════════════════════════════════════════════════════════════════════
-- SECURITY DEFINER a propósito: se usa dentro de las policies de las otras
-- tablas y, si leyera mythos_riders con RLS puesta, se mordería la cola (el
-- mismo problema que la mig 029 resolvió para user_roles).
CREATE OR REPLACE FUNCTION public.my_mythos_rider_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT id FROM public.mythos_riders WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.my_mythos_rider_id() TO authenticated;


-- ════════════════════════════════════════════════════════════════════════
-- 16) RLS
-- ════════════════════════════════════════════════════════════════════════
-- REGLA QUE NO SE NEGOCIA: `mythos_riders` concentra el documento de
-- identidad, el domicilio y la cuenta bancaria de TODOS los riders de la
-- plataforma. Ni `anon` ni el staff de un local la tocan. El restaurante ve del
-- rider lo que necesita para despachar —nombre, foto, vehículo, teléfono— y eso
-- ya vive en su fila de `delivery_riders`. Que alguien reparta para tres
-- locales no puede ser deducible desde ninguno de ellos.
ALTER TABLE public.mythos_rider_config             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mythos_rider_doc_types          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mythos_riders                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mythos_rider_documents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mythos_rider_contract_versions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mythos_rider_contracts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mythos_delivery_partners        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mythos_rider_offers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mythos_rider_rating_dimensions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mythos_rider_ratings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mythos_rider_incidents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mythos_rider_cases              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mythos_rider_case_messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mythos_rider_notifications      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mythos_rider_settlements        ENABLE ROW LEVEL SECURITY;

-- ── Config y catálogos: lectura para cualquier autenticado (no hay nada
--    sensible: son reglas de juego), escritura sólo superadmin. La landing
--    pública NO lee estas tablas: va por rider_public_config().
DROP POLICY IF EXISTS mrcfg_read ON public.mythos_rider_config;
CREATE POLICY mrcfg_read ON public.mythos_rider_config
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS mrcfg_write ON public.mythos_rider_config;
CREATE POLICY mrcfg_write ON public.mythos_rider_config
  FOR ALL TO authenticated
  USING (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

DROP POLICY IF EXISTS mrdt_read ON public.mythos_rider_doc_types;
CREATE POLICY mrdt_read ON public.mythos_rider_doc_types
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS mrdt_write ON public.mythos_rider_doc_types;
CREATE POLICY mrdt_write ON public.mythos_rider_doc_types
  FOR ALL TO authenticated
  USING (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

DROP POLICY IF EXISTS mrdim_read ON public.mythos_rider_rating_dimensions;
CREATE POLICY mrdim_read ON public.mythos_rider_rating_dimensions
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS mrdim_write ON public.mythos_rider_rating_dimensions;
CREATE POLICY mrdim_write ON public.mythos_rider_rating_dimensions
  FOR ALL TO authenticated
  USING (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

DROP POLICY IF EXISTS mrcv_read ON public.mythos_rider_contract_versions;
CREATE POLICY mrcv_read ON public.mythos_rider_contract_versions
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS mrcv_write ON public.mythos_rider_contract_versions;
CREATE POLICY mrcv_write ON public.mythos_rider_contract_versions
  FOR ALL TO authenticated
  USING (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- ── El rider y su ficha ──
-- Lee y edita LA SUYA. El cambio de `status` no pasa por acá: lo hace la RPC de
-- revisión (SECURITY DEFINER). Una policy no filtra COLUMNAS, así que dejar el
-- UPDATE abierto sería dejar que el postulante se apruebe solo — el mismo
-- razonamiento por el que las reseñas de la mig 200 no tienen policy de UPDATE.
DROP POLICY IF EXISTS mr_self_read ON public.mythos_riders;
CREATE POLICY mr_self_read ON public.mythos_riders
  FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid() OR public.get_my_role() = 'superadmin');

DROP POLICY IF EXISTS mr_superadmin_write ON public.mythos_riders;
CREATE POLICY mr_superadmin_write ON public.mythos_riders
  FOR ALL TO authenticated
  USING (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

DROP POLICY IF EXISTS mrdoc_self ON public.mythos_rider_documents;
CREATE POLICY mrdoc_self ON public.mythos_rider_documents
  FOR SELECT TO authenticated
  USING (rider_id = public.my_mythos_rider_id() OR public.get_my_role() = 'superadmin');
DROP POLICY IF EXISTS mrdoc_superadmin ON public.mythos_rider_documents;
CREATE POLICY mrdoc_superadmin ON public.mythos_rider_documents
  FOR ALL TO authenticated
  USING (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- El comprobante del contrato se lee, no se escribe ni se corrige: es prueba.
DROP POLICY IF EXISTS mrc_self_read ON public.mythos_rider_contracts;
CREATE POLICY mrc_self_read ON public.mythos_rider_contracts
  FOR SELECT TO authenticated
  USING (rider_id = public.my_mythos_rider_id() OR public.get_my_role() = 'superadmin');

-- Historial disciplinario: el rider VE lo suyo (tiene derecho a saber por qué
-- lo sancionaron) y nadie lo edita ni lo borra. Sin policy de UPDATE/DELETE.
DROP POLICY IF EXISTS mri_self_read ON public.mythos_rider_incidents;
CREATE POLICY mri_self_read ON public.mythos_rider_incidents
  FOR SELECT TO authenticated
  USING (rider_id = public.my_mythos_rider_id() OR public.get_my_role() = 'superadmin');

DROP POLICY IF EXISTS mrn_self_read ON public.mythos_rider_notifications;
CREATE POLICY mrn_self_read ON public.mythos_rider_notifications
  FOR SELECT TO authenticated
  USING (rider_id = public.my_mythos_rider_id() OR public.get_my_role() = 'superadmin');

-- ── Locales socios: los ve el staff de SU local y el superadmin ──
DROP POLICY IF EXISTS mdp_read ON public.mythos_delivery_partners;
CREATE POLICY mdp_read ON public.mythos_delivery_partners
  FOR SELECT TO authenticated
  USING (public.get_my_role() = 'superadmin'
         OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));
DROP POLICY IF EXISTS mdp_superadmin ON public.mythos_delivery_partners;
CREATE POLICY mdp_superadmin ON public.mythos_delivery_partners
  FOR ALL TO authenticated
  USING (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- ── Ofertas, calificaciones, expedientes y liquidaciones: los ven las dos
--    partes (el rider involucrado y el local involucrado) más el superadmin.
DROP POLICY IF EXISTS mro_read ON public.mythos_rider_offers;
CREATE POLICY mro_read ON public.mythos_rider_offers
  FOR SELECT TO authenticated
  USING (public.get_my_role() = 'superadmin'
         OR rider_id = public.my_mythos_rider_id()
         OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));

DROP POLICY IF EXISTS mrr_read ON public.mythos_rider_ratings;
CREATE POLICY mrr_read ON public.mythos_rider_ratings
  FOR SELECT TO authenticated
  USING (public.get_my_role() = 'superadmin'
         OR rider_id = public.my_mythos_rider_id()
         OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));

DROP POLICY IF EXISTS mrcase_read ON public.mythos_rider_cases;
CREATE POLICY mrcase_read ON public.mythos_rider_cases
  FOR SELECT TO authenticated
  USING (public.get_my_role() = 'superadmin'
         OR rider_id = public.my_mythos_rider_id()
         OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));

DROP POLICY IF EXISTS mrcasemsg_read ON public.mythos_rider_case_messages;
CREATE POLICY mrcasemsg_read ON public.mythos_rider_case_messages
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.mythos_rider_cases c
     WHERE c.id = case_id
       AND (public.get_my_role() = 'superadmin'
            OR c.rider_id = public.my_mythos_rider_id()
            OR c.restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))));

DROP POLICY IF EXISTS mrs_read ON public.mythos_rider_settlements;
CREATE POLICY mrs_read ON public.mythos_rider_settlements
  FOR SELECT TO authenticated
  USING (public.get_my_role() = 'superadmin'
         OR rider_id = public.my_mythos_rider_id()
         OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));


-- ════════════════════════════════════════════════════════════════════════
-- 17) delivery_riders / delivery_orders — el rider de la red NO es staff
-- ════════════════════════════════════════════════════════════════════════
-- Las policies de las migs 103 y 092 scopean por `get_my_company_restaurant_ids()`,
-- que sale de `user_roles`. Un rider de la red NO tiene fila ahí ⇒ hoy no podría
-- ver ni su propia ficha ni el pedido que le asignaron. Se agregan policies de
-- ALCANCE PROPIO: estrictamente más angostas que las existentes (una fila cuyo
-- user_id es el suyo, un pedido cuyo rider es él). No abren nada cross-tenant.
--
-- Y son de SELECT solamente: todo cambio de estado del pedido pasa por RPC
-- (rider_update_order), porque RLS filtra filas y no columnas — con un UPDATE
-- abierto, alguien que no es del local podría reescribir el total del pedido.
DROP POLICY IF EXISTS delivery_riders_self_select ON public.delivery_riders;
CREATE POLICY delivery_riders_self_select ON public.delivery_riders
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS dord_rider_self_select ON public.delivery_orders;
CREATE POLICY dord_rider_self_select ON public.delivery_orders
  FOR SELECT TO authenticated
  USING (rider_id IN (SELECT id FROM public.delivery_riders WHERE user_id = auth.uid()));


-- ════════════════════════════════════════════════════════════════════════
-- 18) GRANTS de tabla (anon: CERO en todo lo nuevo)
-- ════════════════════════════════════════════════════════════════════════
GRANT SELECT ON
  public.mythos_rider_config, public.mythos_rider_doc_types,
  public.mythos_rider_rating_dimensions, public.mythos_rider_contract_versions,
  public.mythos_riders, public.mythos_rider_documents, public.mythos_rider_contracts,
  public.mythos_delivery_partners, public.mythos_rider_offers,
  public.mythos_rider_ratings, public.mythos_rider_incidents,
  public.mythos_rider_cases, public.mythos_rider_case_messages,
  public.mythos_rider_notifications, public.mythos_rider_settlements
TO authenticated;

-- Escritura directa SÓLO para lo que el superadmin edita a mano desde su panel
-- (config, catálogos y contrato). Todo lo demás entra por RPC.
GRANT INSERT, UPDATE, DELETE ON
  public.mythos_rider_config, public.mythos_rider_doc_types,
  public.mythos_rider_rating_dimensions, public.mythos_rider_contract_versions,
  public.mythos_riders, public.mythos_rider_documents,
  public.mythos_delivery_partners
TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 19) LANDING PÚBLICA — lo único que ve alguien sin cuenta
-- ════════════════════════════════════════════════════════════════════════
-- Devuelve las reglas del juego y el texto del contrato. Nada de riders, nada
-- de locales, nada de pedidos: la landing no necesita saber quién reparte.
CREATE OR REPLACE FUNCTION public.rider_public_config()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_cfg  public.mythos_rider_config%ROWTYPE;
  v_ct   public.mythos_rider_contract_versions%ROWTYPE;
  v_docs jsonb;
BEGIN
  SELECT * INTO v_cfg FROM public.mythos_rider_config WHERE id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'slug', d.slug, 'label', d.label, 'help', d.help,
           'required', d.required, 'vehicles', d.vehicles, 'has_expiry', d.has_expiry
         ) ORDER BY d.sort_order, d.label), '[]'::jsonb)
    INTO v_docs
    FROM public.mythos_rider_doc_types d
   WHERE d.is_active;

  SELECT * INTO v_ct FROM public.mythos_rider_contract_versions WHERE is_current LIMIT 1;

  RETURN jsonb_build_object(
    'enabled',            COALESCE(v_cfg.network_enabled, false),
    'registration_open',  COALESCE(v_cfg.registration_open, false),
    'closed_message',     COALESCE(v_cfg.closed_message, ''),
    'min_age',            COALESCE(v_cfg.min_age, 18),
    'require_selfie',     COALESCE(v_cfg.require_selfie, true),
    'require_bank',       COALESCE(v_cfg.require_bank, true),
    'require_training',   COALESCE(v_cfg.require_training, false),
    'training_url',       v_cfg.training_url,
    'geo_interval',       COALESCE(v_cfg.geo_interval_seconds, 60),
    'accept_seconds',     COALESCE(v_cfg.accept_seconds, 60),
    'site',               COALESCE(v_cfg.site_texts, '{}'::jsonb)
                            || jsonb_build_object('hero_image', v_cfg.hero_image_url),
    'doc_types',          v_docs,
    'contract',           CASE WHEN v_ct.version IS NULL THEN NULL ELSE jsonb_build_object(
                            'version', v_ct.version, 'title', v_ct.title, 'body', v_ct.body) END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rider_public_config() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rider_public_config() TO anon, authenticated;


-- ════════════════════════════════════════════════════════════════════════
-- 20) MI FICHA — crear, completar, enviar
-- ════════════════════════════════════════════════════════════════════════
-- El postulante ya tiene cuenta de Auth cuando llega acá (se registra con
-- correo y contraseña en /riders). Esto es deliberado: sin `auth.uid()` no hay
-- forma de que suba documentos a una carpeta que sea suya y de nadie más, y la
-- alternativa —permitirle a `anon` escribir documentos de identidad— es
-- exactamente lo que las migs 102/103 pasaron meses cerrando.
CREATE OR REPLACE FUNCTION public.ensure_my_rider()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_cfg  public.mythos_rider_config%ROWTYPE;
  v_id   UUID;
  v_mail TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'necesitás iniciar sesión' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_cfg FROM public.mythos_rider_config WHERE id;
  SELECT id INTO v_id FROM public.mythos_riders WHERE auth_user_id = v_uid;

  -- El portero está en la BASE, no sólo en la pantalla: con la red apagada o
  -- las postulaciones cerradas, no nace ninguna ficha nueva. Quien YA es rider
  -- sigue entrando (cerrar el registro no puede dejar a nadie afuera de su
  -- propio trabajo).
  IF v_id IS NULL THEN
    IF NOT COALESCE(v_cfg.network_enabled, false) THEN
      RAISE EXCEPTION 'la red de riders no está disponible' USING ERRCODE = '22023';
    END IF;
    IF NOT COALESCE(v_cfg.registration_open, false) THEN
      RAISE EXCEPTION '%', COALESCE(v_cfg.closed_message, 'las postulaciones están cerradas')
        USING ERRCODE = '22023';
    END IF;
    SELECT email INTO v_mail FROM auth.users WHERE id = v_uid;
    INSERT INTO public.mythos_riders (auth_user_id, email, status)
    VALUES (v_uid, v_mail, 'borrador')
    RETURNING id INTO v_id;
  END IF;

  UPDATE public.mythos_riders SET last_seen_at = now() WHERE id = v_id;
  RETURN jsonb_build_object('ok', true, 'rider_id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_my_rider() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_my_rider() TO authenticated;


-- Guardar el borrador. Sólo campos del postulante: `status`, `availability` y
-- todo lo disciplinario quedan FUERA a propósito — se cambian por las RPC de
-- revisión. Editable mientras la solicitud no esté aprobada; si el superadmin
-- la dejó 'observado', se puede corregir SIN empezar de cero (lo pidió Renato).
CREATE OR REPLACE FUNCTION public.save_my_rider_draft(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_id     UUID := public.my_mythos_rider_id();
  v_status TEXT;
  v_wa     TEXT := regexp_replace(COALESCE(payload->>'whatsapp',''), '[^0-9]', '', 'g');
  v_doc    TEXT := regexp_replace(COALESCE(payload->>'doc_number',''), '[^0-9]', '', 'g');
  v_ph     TEXT := regexp_replace(COALESCE(payload->>'phone',''), '[^0-9]', '', 'g');
  v_plate  TEXT := upper(regexp_replace(COALESCE(payload->>'vehicle_plate',''), '[^A-Za-z0-9]', '', 'g'));
BEGIN
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'no tenés una ficha de rider' USING ERRCODE = '22023';
  END IF;
  SELECT status INTO v_status FROM public.mythos_riders WHERE id = v_id;
  IF v_status NOT IN ('borrador','observado','rechazado') THEN
    RAISE EXCEPTION 'tu solicitud ya fue enviada: para cambiar tus datos pedí una revisión'
      USING ERRCODE = '22023';
  END IF;

  -- WhatsApp con el MISMO umbral que el resto de los formularios públicos
  -- (mig 198): en Paraguay un rider sin WhatsApp es un rider incontactable.
  IF v_wa <> '' AND length(v_wa) < 8 THEN
    RAISE EXCEPTION 'el WhatsApp no parece completo' USING ERRCODE = '22023';
  END IF;

  -- Los tres duplicados que pide el brief, con mensaje entendible. El índice
  -- único de abajo es el que realmente garantiza; esto es para que la persona
  -- sepa QUÉ corregir en vez de recibir un error de base de datos.
  IF v_doc <> '' AND EXISTS (
       SELECT 1 FROM public.mythos_riders r
        WHERE r.doc_digits = v_doc AND r.id <> v_id
          AND r.status NOT IN ('baja','rechazado')) THEN
    RAISE EXCEPTION 'ese documento ya está registrado en la red' USING ERRCODE = '23505';
  END IF;
  IF v_ph <> '' AND EXISTS (
       SELECT 1 FROM public.mythos_riders r
        WHERE r.phone_digits = v_ph AND r.id <> v_id
          AND r.status NOT IN ('baja','rechazado')) THEN
    RAISE EXCEPTION 'ese teléfono ya está registrado en la red' USING ERRCODE = '23505';
  END IF;
  IF v_plate <> '' AND EXISTS (
       SELECT 1 FROM public.mythos_riders r
        WHERE upper(regexp_replace(COALESCE(r.vehicle_plate,''), '[^A-Za-z0-9]', '', 'g')) = v_plate
          AND r.id <> v_id AND r.status NOT IN ('baja','rechazado')) THEN
    RAISE EXCEPTION 'esa patente ya está registrada en la red' USING ERRCODE = '23505';
  END IF;

  UPDATE public.mythos_riders SET
    first_name   = COALESCE(left(NULLIF(btrim(payload->>'first_name'),''), 80),   first_name),
    last_name    = COALESCE(left(NULLIF(btrim(payload->>'last_name'),''), 80),    last_name),
    birth_date   = COALESCE(NULLIF(btrim(payload->>'birth_date'),'')::date,       birth_date),
    gender       = COALESCE(left(NULLIF(btrim(payload->>'gender'),''), 40),       gender),
    doc_number   = COALESCE(left(NULLIF(btrim(payload->>'doc_number'),''), 40),   doc_number),
    nationality  = COALESCE(left(NULLIF(btrim(payload->>'nationality'),''), 60),  nationality),
    phone        = COALESCE(left(NULLIF(btrim(payload->>'phone'),''), 40),        phone),
    whatsapp     = COALESCE(left(NULLIF(btrim(payload->>'whatsapp'),''), 40),     whatsapp),
    address      = COALESCE(left(NULLIF(btrim(payload->>'address'),''), 200),     address),
    city         = COALESCE(left(NULLIF(btrim(payload->>'city'),''), 80),         city),
    department   = COALESCE(left(NULLIF(btrim(payload->>'department'),''), 80),   department),
    photo_url    = COALESCE(left(NULLIF(btrim(payload->>'photo_url'),''), 400),   photo_url),
    selfie_path  = COALESCE(left(NULLIF(btrim(payload->>'selfie_path'),''), 400), selfie_path),
    vehicle_type = COALESCE(NULLIF(btrim(payload->>'vehicle_type'),''),           vehicle_type),
    vehicle_brand   = COALESCE(left(NULLIF(btrim(payload->>'vehicle_brand'),''), 60),   vehicle_brand),
    vehicle_model   = COALESCE(left(NULLIF(btrim(payload->>'vehicle_model'),''), 60),   vehicle_model),
    vehicle_color   = COALESCE(left(NULLIF(btrim(payload->>'vehicle_color'),''), 40),   vehicle_color),
    vehicle_year    = COALESCE(NULLIF(btrim(payload->>'vehicle_year'),'')::int,         vehicle_year),
    vehicle_plate   = COALESCE(left(NULLIF(btrim(payload->>'vehicle_plate'),''), 20),   vehicle_plate),
    vehicle_chassis = COALESCE(left(NULLIF(btrim(payload->>'vehicle_chassis'),''), 40), vehicle_chassis),
    vehicle_engine  = COALESCE(left(NULLIF(btrim(payload->>'vehicle_engine'),''), 40),  vehicle_engine),
    bank_holder     = COALESCE(left(NULLIF(btrim(payload->>'bank_holder'),''), 120), bank_holder),
    bank_name       = COALESCE(left(NULLIF(btrim(payload->>'bank_name'),''), 80),   bank_name),
    bank_account    = COALESCE(left(NULLIF(btrim(payload->>'bank_account'),''), 60), bank_account),
    bank_alias      = COALESCE(left(NULLIF(btrim(payload->>'bank_alias'),''), 60),  bank_alias),
    bank_account_type = COALESCE(left(NULLIF(btrim(payload->>'bank_account_type'),''), 40), bank_account_type),
    updated_at   = now()
  WHERE id = v_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.save_my_rider_draft(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_my_rider_draft(jsonb) TO authenticated;


-- Registrar un documento subido. Subir uno nuevo ARCHIVA el anterior y vuelve a
-- 'pendiente': "no permitir modificar documentos aprobados sin volver a
-- revisión" es un requisito explícito del brief, y acá es donde se cumple —
-- no en la pantalla.
CREATE OR REPLACE FUNCTION public.rider_register_document(
  p_slug text, p_path text, p_mime text DEFAULT NULL,
  p_issued_at date DEFAULT NULL, p_expires_at date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_id  UUID := public.my_mythos_rider_id();
  v_uid UUID := auth.uid();
  v_st  TEXT;
BEGIN
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'no tenés una ficha de rider' USING ERRCODE = '22023';
  END IF;
  IF NULLIF(btrim(COALESCE(p_slug,'')),'') IS NULL OR NULLIF(btrim(COALESCE(p_path,'')),'') IS NULL THEN
    RAISE EXCEPTION 'documento inválido' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.mythos_rider_doc_types
                  WHERE lower(btrim(slug)) = lower(btrim(p_slug)) AND is_active) THEN
    RAISE EXCEPTION 'ese tipo de documento no se pide' USING ERRCODE = '22023';
  END IF;
  -- El archivo tiene que estar en la carpeta del propio rider. Sin este
  -- chequeo, alguien podría apuntar su ficha al documento de otra persona.
  IF split_part(p_path, '/', 1) <> v_uid::text THEN
    RAISE EXCEPTION 'ruta de archivo inválida' USING ERRCODE = '22023';
  END IF;

  SELECT status INTO v_st FROM public.mythos_riders WHERE id = v_id;
  IF v_st IN ('bloqueado','baja') THEN
    RAISE EXCEPTION 'tu cuenta no admite cambios' USING ERRCODE = '22023';
  END IF;

  UPDATE public.mythos_rider_documents
     SET replaced_at = now()
   WHERE rider_id = v_id AND doc_slug = p_slug AND replaced_at IS NULL;

  INSERT INTO public.mythos_rider_documents
    (rider_id, doc_slug, file_path, mime, issued_at, expires_at, status)
  VALUES (v_id, p_slug, p_path, p_mime, p_issued_at, p_expires_at, 'pendiente');

  -- Reponer un papel de alguien suspendido por vencimiento lo devuelve a la
  -- cola de revisión, no lo reactiva solo: lo reactiva quien lo aprueba.
  IF v_st = 'suspendido' THEN
    UPDATE public.mythos_riders
       SET status = 'observado', status_reason = 'documentación actualizada, en revisión',
           status_changed_at = now(), updated_at = now()
     WHERE id = v_id;
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.rider_register_document(text,text,text,date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rider_register_document(text,text,text,date,date) TO authenticated;


-- Enviar la solicitud: valida que esté completa, registra la aceptación del
-- contrato con fecha/IP/versión y la pone en la cola del superadmin.
CREATE OR REPLACE FUNCTION public.submit_my_rider_application(
  p_contract_version text, p_accept boolean DEFAULT false,
  p_ip text DEFAULT NULL, p_user_agent text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_id   UUID := public.my_mythos_rider_id();
  v_r    public.mythos_riders%ROWTYPE;
  v_cfg  public.mythos_rider_config%ROWTYPE;
  v_ct   public.mythos_rider_contract_versions%ROWTYPE;
  v_miss TEXT[] := '{}';
  v_d    RECORD;
BEGIN
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'no tenés una ficha de rider' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_r   FROM public.mythos_riders WHERE id = v_id;
  SELECT * INTO v_cfg FROM public.mythos_rider_config WHERE id;

  IF v_r.status NOT IN ('borrador','observado','rechazado') THEN
    RAISE EXCEPTION 'tu solicitud ya está enviada' USING ERRCODE = '22023';
  END IF;

  IF NOT COALESCE(p_accept, false) THEN
    RAISE EXCEPTION 'tenés que aceptar los términos para enviar la solicitud'
      USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_ct FROM public.mythos_rider_contract_versions WHERE is_current LIMIT 1;
  IF v_ct.version IS NULL OR v_ct.version <> COALESCE(p_contract_version,'') THEN
    RAISE EXCEPTION 'los términos cambiaron: volvé a leerlos y aceptá la versión vigente'
      USING ERRCODE = '22023';
  END IF;

  -- Campos obligatorios
  IF NULLIF(btrim(COALESCE(v_r.first_name,'')),'') IS NULL THEN v_miss := v_miss || 'nombre'; END IF;
  IF NULLIF(btrim(COALESCE(v_r.last_name,'')),'')  IS NULL THEN v_miss := v_miss || 'apellido'; END IF;
  IF COALESCE(v_r.doc_digits,'') = ''              THEN v_miss := v_miss || 'documento de identidad'; END IF;
  IF COALESCE(v_r.phone_digits,'') = ''            THEN v_miss := v_miss || 'celular'; END IF;
  IF NULLIF(btrim(COALESCE(v_r.city,'')),'')       IS NULL THEN v_miss := v_miss || 'ciudad'; END IF;
  IF v_r.birth_date IS NULL                        THEN v_miss := v_miss || 'fecha de nacimiento'; END IF;
  IF COALESCE(v_cfg.require_selfie, true) AND NULLIF(btrim(COALESCE(v_r.selfie_path,'')),'') IS NULL THEN
    v_miss := v_miss || 'selfie de validación';
  END IF;
  IF COALESCE(v_cfg.require_bank, true) AND (
       NULLIF(btrim(COALESCE(v_r.bank_holder,'')),'') IS NULL
       OR NULLIF(btrim(COALESCE(v_r.bank_account,'')),'') IS NULL) THEN
    v_miss := v_miss || 'datos bancarios';
  END IF;
  IF v_r.vehicle_type IN ('moto','auto')
     AND NULLIF(btrim(COALESCE(v_r.vehicle_plate,'')),'') IS NULL THEN
    v_miss := v_miss || 'patente del vehículo';
  END IF;

  IF v_r.birth_date IS NOT NULL
     AND v_r.birth_date > (now() AT TIME ZONE 'America/Asuncion')::date
                          - (COALESCE(v_cfg.min_age,18) || ' years')::interval THEN
    RAISE EXCEPTION 'tenés que ser mayor de % años para postularte', COALESCE(v_cfg.min_age,18)
      USING ERRCODE = '22023';
  END IF;

  -- Documentos obligatorios para SU tipo de vehículo (el catálogo manda).
  FOR v_d IN
    SELECT t.slug, t.label FROM public.mythos_rider_doc_types t
     WHERE t.is_active AND t.required
       AND (COALESCE(array_length(t.vehicles,1),0) = 0 OR v_r.vehicle_type = ANY(t.vehicles))
     ORDER BY t.sort_order
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.mythos_rider_documents d
                    WHERE d.rider_id = v_id AND d.doc_slug = v_d.slug
                      AND d.replaced_at IS NULL) THEN
      v_miss := v_miss || v_d.label;
    END IF;
  END LOOP;

  IF COALESCE(array_length(v_miss,1),0) > 0 THEN
    RAISE EXCEPTION 'te falta cargar: %', array_to_string(v_miss, ', ') USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.mythos_rider_contracts (rider_id, version, body_hash, ip, user_agent)
  -- md5() y no digest(): es built-in de PostgreSQL. Con pgcrypto la huella
  -- sería más fuerte, pero acá sólo sirve para probar que el texto aceptado es
  -- el mismo que quedó guardado — y una migración no puede depender de que una
  -- extensión esté instalada en este proyecto.
  VALUES (v_id, v_ct.version, md5(v_ct.body),
          left(COALESCE(p_ip,''), 60), left(COALESCE(p_user_agent,''), 400));

  UPDATE public.mythos_riders
     SET status = CASE WHEN COALESCE(v_cfg.auto_approve, false) THEN 'aprobado' ELSE 'pendiente' END,
         status_reason = NULL, status_changed_at = now(),
         submitted_at = now(),
         approved_at = CASE WHEN COALESCE(v_cfg.auto_approve, false) THEN now() ELSE NULL END,
         updated_at = now()
   WHERE id = v_id;

  INSERT INTO public.mythos_rider_notifications (rider_id, kind, title, body)
  VALUES (v_id, 'solicitud', 'Solicitud enviada',
          'Recibimos tu postulación. Te avisamos apenas la revisemos.');

  RETURN jsonb_build_object('ok', true, 'status',
    (SELECT status FROM public.mythos_riders WHERE id = v_id));
END;
$$;

REVOKE ALL ON FUNCTION public.submit_my_rider_application(text,boolean,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_my_rider_application(text,boolean,text,text) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 21) UN SOLO INTERRUPTOR — la disponibilidad se propaga a todos los locales
-- ════════════════════════════════════════════════════════════════════════
-- El rider tiene UN estado, no uno por restaurante: ponerse "disponible" tres
-- veces porque trabaja para tres locales sería absurdo, y peor, quedaría
-- disponible en uno y offline en otro. El trigger empuja su estado a todas sus
-- fichas, y a partir de ahí el despacho de siempre (mig 156) hace su trabajo
-- sin enterarse de que existe una red.
CREATE OR REPLACE FUNCTION public._mythos_rider_sync_links()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_st TEXT;
BEGIN
  v_st := CASE
            WHEN NEW.status <> 'activo'            THEN 'offline'
            WHEN NEW.availability = 'disponible'   THEN 'disponible'
            WHEN NEW.availability = 'ocupado'      THEN 'en_ruta'
            ELSE 'offline'
          END;

  UPDATE public.delivery_riders dr
     SET current_status = v_st,
         active = (NEW.status = 'activo' AND dr.link_status = 'activo'),
         name   = COALESCE(NULLIF(btrim(COALESCE(NEW.first_name,'') || ' ' || COALESCE(NEW.last_name,'')),''), dr.name),
         phone  = COALESCE(NEW.phone, dr.phone),
         photo_url = COALESCE(NEW.photo_url, dr.photo_url)
   WHERE dr.mythos_rider_id = NEW.id
     AND (dr.current_status IS DISTINCT FROM v_st
          OR dr.active IS DISTINCT FROM (NEW.status = 'activo' AND dr.link_status = 'activo')
          OR dr.photo_url IS DISTINCT FROM COALESCE(NEW.photo_url, dr.photo_url));

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_mythos_rider_sync_links ON public.mythos_riders;
CREATE TRIGGER trg_mythos_rider_sync_links
AFTER UPDATE OF availability, status, first_name, last_name, phone, photo_url
ON public.mythos_riders
FOR EACH ROW EXECUTE FUNCTION public._mythos_rider_sync_links();


CREATE OR REPLACE FUNCTION public.rider_set_availability(p_status text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_id UUID := public.my_mythos_rider_id();
  v_st TEXT;
BEGIN
  IF v_id IS NULL THEN RAISE EXCEPTION 'no sos rider de la red' USING ERRCODE = '22023'; END IF;
  IF p_status NOT IN ('disponible','ocupado','pausado','desconectado') THEN
    RAISE EXCEPTION 'estado inválido' USING ERRCODE = '22023';
  END IF;
  SELECT status INTO v_st FROM public.mythos_riders WHERE id = v_id;
  IF p_status = 'disponible' AND v_st <> 'activo' THEN
    RAISE EXCEPTION 'tu cuenta todavía no está activa' USING ERRCODE = '22023';
  END IF;

  UPDATE public.mythos_riders
     SET availability = p_status,
         last_seen_at = now(),
         -- Al desconectarse se BORRA la última posición. "Nunca si está
         -- desconectado" (brief) no puede significar sólo "dejar de actualizar":
         -- la última coordenada seguiría ahí, y eso es seguir informando dónde
         -- vive alguien que se fue a su casa.
         last_lat = CASE WHEN p_status = 'desconectado' THEN NULL ELSE last_lat END,
         last_lng = CASE WHEN p_status = 'desconectado' THEN NULL ELSE last_lng END,
         last_location_at = CASE WHEN p_status = 'desconectado' THEN NULL ELSE last_location_at END,
         updated_at = now()
   WHERE id = v_id;

  RETURN jsonb_build_object('ok', true, 'availability', p_status);
END;
$$;

REVOKE ALL ON FUNCTION public.rider_set_availability(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rider_set_availability(text) TO authenticated;


CREATE OR REPLACE FUNCTION public.rider_ping_location(p_lat numeric, p_lng numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_id  UUID := public.my_mythos_rider_id();
  v_cfg public.mythos_rider_config%ROWTYPE;
  v_av  TEXT;
BEGIN
  IF v_id IS NULL THEN RETURN jsonb_build_object('ok', false); END IF;
  SELECT * INTO v_cfg FROM public.mythos_rider_config WHERE id;
  IF NOT COALESCE(v_cfg.geo_enabled, true) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'geo_off');
  END IF;
  SELECT availability INTO v_av FROM public.mythos_riders WHERE id = v_id;
  -- El servidor RECHAZA la posición de quien está desconectado. Si esto viviera
  -- sólo en el front, bastaría con un fetch a mano para seguir rastreando.
  IF v_av = 'desconectado' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'offline');
  END IF;
  IF p_lat IS NULL OR p_lng IS NULL
     OR p_lat < -90 OR p_lat > 90 OR p_lng < -180 OR p_lng > 180 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'coords');
  END IF;

  UPDATE public.mythos_riders
     SET last_lat = p_lat, last_lng = p_lng,
         last_location_at = now(), last_seen_at = now()
   WHERE id = v_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.rider_ping_location(numeric,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rider_ping_location(numeric,numeric) TO authenticated;


-- ════════════════════════════════════════════════════════════════════════
-- 22) MI PERFIL COMPLETO — una sola llamada
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.my_rider_profile()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_id    UUID := public.my_mythos_rider_id();
  v_r     public.mythos_riders%ROWTYPE;
  v_cfg   public.mythos_rider_config%ROWTYPE;
  v_docs  jsonb; v_links jsonb; v_inc jsonb; v_notif jsonb; v_ct jsonb;
  v_dims  jsonb; v_stats jsonb; v_cases jsonb;
BEGIN
  IF v_id IS NULL THEN RETURN jsonb_build_object('exists', false); END IF;
  SELECT * INTO v_r   FROM public.mythos_riders WHERE id = v_id;
  SELECT * INTO v_cfg FROM public.mythos_rider_config WHERE id;

  -- Documentos: el estado que importa es "¿me sirve HOY?", así que el vencido
  -- se calcula contra la fecha de Paraguay y no contra lo que diga la columna.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'slug', t.slug, 'label', t.label, 'help', t.help,
           'required', t.required, 'has_expiry', t.has_expiry,
           'doc_id', d.id, 'file_path', d.file_path,
           'status', CASE
                       WHEN d.id IS NULL THEN 'faltante'
                       WHEN d.expires_at IS NOT NULL
                            AND d.expires_at < (now() AT TIME ZONE 'America/Asuncion')::date THEN 'vencido'
                       ELSE d.status END,
           'expires_at', d.expires_at, 'review_note', d.review_note,
           'days_left', CASE WHEN d.expires_at IS NULL THEN NULL
                             ELSE d.expires_at - (now() AT TIME ZONE 'America/Asuncion')::date END
         ) ORDER BY t.sort_order), '[]'::jsonb)
    INTO v_docs
    FROM public.mythos_rider_doc_types t
    LEFT JOIN public.mythos_rider_documents d
           ON d.rider_id = v_id AND d.doc_slug = t.slug AND d.replaced_at IS NULL
   WHERE t.is_active
     AND (COALESCE(array_length(t.vehicles,1),0) = 0 OR v_r.vehicle_type = ANY(t.vehicles));

  -- Locales donde trabaja. El nombre y la dirección salen de acá porque el
  -- rider NO puede leer `restaurants` (tenant-scoped desde la mig 103).
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'link_id', dr.id, 'restaurant_id', r.id, 'name', r.name,
           'city', r.city, 'address', r.address, 'logo_url', r.logo_url,
           'link_status', dr.link_status, 'dispatch_auto', dr.dispatch_auto,
           'pay_type', p.pay_type, 'pay_value', p.pay_value, 'pay_method', p.pay_method,
           'partner_status', p.status
         ) ORDER BY r.name), '[]'::jsonb)
    INTO v_links
    FROM public.delivery_riders dr
    JOIN public.restaurants r ON r.id = dr.restaurant_id
    LEFT JOIN public.mythos_delivery_partners p ON p.restaurant_id = dr.restaurant_id
   WHERE dr.mythos_rider_id = v_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', i.id, 'kind', i.kind, 'reason', i.reason, 'detail', i.detail,
           'days', i.days, 'effective_until', i.effective_until,
           'automatic', i.automatic, 'created_at', i.created_at
         ) ORDER BY i.created_at DESC), '[]'::jsonb)
    INTO v_inc
    FROM (SELECT * FROM public.mythos_rider_incidents
           WHERE rider_id = v_id ORDER BY created_at DESC LIMIT 50) i;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', n.id, 'kind', n.kind, 'title', n.title, 'body', n.body,
           'link', n.link, 'read_at', n.read_at, 'created_at', n.created_at
         ) ORDER BY n.created_at DESC), '[]'::jsonb)
    INTO v_notif
    FROM (SELECT * FROM public.mythos_rider_notifications
           WHERE rider_id = v_id ORDER BY created_at DESC LIMIT 40) n;

  SELECT jsonb_build_object('version', c.version, 'accepted_at', c.accepted_at)
    INTO v_ct
    FROM public.mythos_rider_contracts c
   WHERE c.rider_id = v_id ORDER BY c.accepted_at DESC LIMIT 1;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', k.id, 'code', k.code, 'subject', k.subject, 'status', k.status,
           'resolution', k.resolution, 'created_at', k.created_at
         ) ORDER BY k.created_at DESC), '[]'::jsonb)
    INTO v_cases
    FROM public.mythos_rider_cases k WHERE k.rider_id = v_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('slug', dm.slug, 'label', dm.label,
           'avg', (SELECT round(avg((rt.scores->>dm.slug)::numeric), 2)
                     FROM public.mythos_rider_ratings rt
                    WHERE rt.rider_id = v_id AND rt.scores ? dm.slug))
         ORDER BY dm.sort_order), '[]'::jsonb)
    INTO v_dims
    FROM public.mythos_rider_rating_dimensions dm WHERE dm.is_active;

  SELECT jsonb_build_object(
    'deliveries',  COALESCE(v_r.deliveries_count, 0),
    'rating_avg',  v_r.rating_avg,
    'rating_count',COALESCE(v_r.rating_count, 0),
    'avg_minutes', v_r.avg_minutes,
    'compliance',  v_r.compliance_pct,
    'warnings',    COALESCE(v_r.warnings_count, 0),
    'unread',      (SELECT count(*) FROM public.mythos_rider_notifications
                     WHERE rider_id = v_id AND read_at IS NULL),
    'open_cases',  (SELECT count(*) FROM public.mythos_rider_cases
                     WHERE rider_id = v_id AND status IN ('abierto','en_revision','esperando'))
  ) INTO v_stats;

  RETURN jsonb_build_object(
    'exists', true,
    'rider',  to_jsonb(v_r) - 'phone_digits' - 'doc_digits',
    'docs',   v_docs,
    'links',  v_links,
    'incidents', v_inc,
    'cases',  v_cases,
    'notifications', v_notif,
    'contract', v_ct,
    'dimensions', v_dims,
    'stats',  v_stats,
    'config', jsonb_build_object(
      'geo_enabled',      COALESCE(v_cfg.geo_enabled, true),
      'geo_interval',     COALESCE(v_cfg.geo_interval_seconds, 60),
      'accept_seconds',   COALESCE(v_cfg.accept_seconds, 60),
      'require_training', COALESCE(v_cfg.require_training, false),
      'training_url',     v_cfg.training_url)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.my_rider_profile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_rider_profile() TO authenticated;


-- ════════════════════════════════════════════════════════════════════════
-- 23) LOCALES DE LA RED — mirar y sumarse
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.rider_network_places(p_search text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_id UUID := public.my_mythos_rider_id(); v_rows jsonb;
BEGIN
  IF v_id IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'name'), '[]'::jsonb) INTO v_rows FROM (
    SELECT jsonb_build_object(
      'restaurant_id', r.id, 'name', r.name, 'city', r.city, 'address', r.address,
      'logo_url', r.logo_url,
      'pay_type', p.pay_type, 'pay_value', p.pay_value, 'pay_method', p.pay_method,
      'dispatch_mode', p.dispatch_mode,
      'auto_accept', p.auto_accept_riders,
      'linked', (dr.id IS NOT NULL),
      'link_status', dr.link_status,
      'full', (p.max_riders IS NOT NULL AND (
                 SELECT count(*) FROM public.delivery_riders d2
                  WHERE d2.restaurant_id = r.id AND d2.mythos_rider_id IS NOT NULL
                    AND d2.link_status = 'activo') >= p.max_riders)
    ) AS x
      FROM public.mythos_delivery_partners p
      JOIN public.restaurants r ON r.id = p.restaurant_id
      LEFT JOIN public.delivery_riders dr
             ON dr.restaurant_id = r.id AND dr.mythos_rider_id = v_id
     WHERE p.status = 'activo'
       AND COALESCE(r.is_active, true) = true
       AND COALESCE(r.status, 'active') NOT IN ('deleted','suspended')
       AND (p_search IS NULL OR btrim(p_search) = ''
            OR r.name ILIKE '%'||btrim(p_search)||'%'
            OR COALESCE(r.city,'') ILIKE '%'||btrim(p_search)||'%')
  ) q;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.rider_network_places(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rider_network_places(text) TO authenticated;


-- Sumarse a un local: crea la fila de `delivery_riders` — o sea, se vuelve un
-- rider más para el despacho de ese restaurante, sin que el despacho tenga que
-- aprender nada nuevo.
CREATE OR REPLACE FUNCTION public.rider_join_place(p_restaurant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_id  UUID := public.my_mythos_rider_id();
  v_r   public.mythos_riders%ROWTYPE;
  v_p   public.mythos_delivery_partners%ROWTYPE;
  v_cnt INT;
  v_lid UUID;
BEGIN
  IF v_id IS NULL THEN RAISE EXCEPTION 'no sos rider de la red' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_r FROM public.mythos_riders WHERE id = v_id;
  IF v_r.status <> 'activo' THEN
    RAISE EXCEPTION 'tu cuenta tiene que estar activa para sumarte a un local' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_p FROM public.mythos_delivery_partners
   WHERE restaurant_id = p_restaurant_id FOR UPDATE;
  IF v_p.restaurant_id IS NULL OR v_p.status <> 'activo' THEN
    RAISE EXCEPTION 'ese local no está trabajando con la red' USING ERRCODE = '22023';
  END IF;

  IF v_p.max_riders IS NOT NULL THEN
    SELECT count(*) INTO v_cnt FROM public.delivery_riders
     WHERE restaurant_id = p_restaurant_id AND mythos_rider_id IS NOT NULL
       AND link_status = 'activo';
    IF v_cnt >= v_p.max_riders THEN
      RAISE EXCEPTION 'ese local ya cubrió su cupo de riders de la red' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT id INTO v_lid FROM public.delivery_riders
   WHERE restaurant_id = p_restaurant_id AND mythos_rider_id = v_id;

  IF v_lid IS NULL THEN
    INSERT INTO public.delivery_riders (
      restaurant_id, user_id, mythos_rider_id, source, name, phone, photo_url,
      vehicle, commission_type, commission_value,
      current_status, active, link_status, dispatch_auto)
    VALUES (
      p_restaurant_id, v_r.auth_user_id, v_id, 'mythos',
      NULLIF(btrim(COALESCE(v_r.first_name,'') || ' ' || COALESCE(v_r.last_name,'')),''),
      v_r.phone, v_r.photo_url,
      CASE WHEN v_r.vehicle_type = 'otro' THEN 'pie' ELSE v_r.vehicle_type END,
      v_p.pay_type, v_p.pay_value,
      -- Nace OFFLINE por el mismo motivo que la mig 158: nadie recibe pedidos
      -- antes de decir que está trabajando.
      'offline',
      CASE WHEN v_p.auto_accept_riders THEN true ELSE false END,
      CASE WHEN v_p.auto_accept_riders THEN 'activo' ELSE 'pausado' END,
      (v_p.dispatch_mode = 'auto'))
    RETURNING id INTO v_lid;
  ELSE
    UPDATE public.delivery_riders
       SET link_status = CASE WHEN v_p.auto_accept_riders THEN 'activo' ELSE 'pausado' END,
           active      = v_p.auto_accept_riders,
           dispatch_auto = (v_p.dispatch_mode = 'auto')
     WHERE id = v_lid;
  END IF;

  RETURN jsonb_build_object('ok', true, 'link_id', v_lid,
    'pending', NOT v_p.auto_accept_riders);
END;
$$;

REVOKE ALL ON FUNCTION public.rider_join_place(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rider_join_place(uuid) TO authenticated;


CREATE OR REPLACE FUNCTION public.rider_leave_place(p_restaurant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_id UUID := public.my_mythos_rider_id(); v_pend INT;
BEGIN
  IF v_id IS NULL THEN RAISE EXCEPTION 'no sos rider de la red' USING ERRCODE = '22023'; END IF;
  -- No se puede abandonar un local con pedidos en la mano: el pedido quedaría
  -- sin repartidor y el cliente esperando.
  SELECT count(*) INTO v_pend
    FROM public.delivery_orders o
    JOIN public.delivery_riders dr ON dr.id = o.rider_id
   WHERE dr.mythos_rider_id = v_id AND dr.restaurant_id = p_restaurant_id
     AND o.rider_status IN ('confirmed','picked_up','on_way');
  IF v_pend > 0 THEN
    RAISE EXCEPTION 'terminá tus % entrega(s) pendientes antes de salir de ese local', v_pend
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.delivery_riders
   WHERE restaurant_id = p_restaurant_id AND mythos_rider_id = v_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.rider_leave_place(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rider_leave_place(uuid) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 24) LA COLA DEL REPARTIDOR — una sola RPC para los dos tipos de rider
-- ════════════════════════════════════════════════════════════════════════
-- Se indexa por `delivery_riders.user_id = auth.uid()`, así que sirve igual al
-- rider propio de un local y al de la red (que tiene N fichas). El panel
-- termina con UN camino de código en vez de dos que se desincronizan.
-- Devuelve también el nombre del local: el rider de la red no puede leer
-- `restaurants` y sin esto vería "entregar en …" sin saber dónde retirar.
CREATE OR REPLACE FUNCTION public.rider_my_orders()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_uid UUID := auth.uid(); v_rows jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at'), '[]'::jsonb) INTO v_rows FROM (
    SELECT jsonb_build_object(
      'id', o.id, 'order_id', o.order_id, 'restaurant_id', o.restaurant_id,
      'restaurant_name', r.name, 'restaurant_address', r.address,
      'restaurant_lat', r.lat, 'restaurant_lng', r.lng, 'restaurant_phone', r.phone,
      'rider_id', o.rider_id, 'rider_status', o.rider_status,
      'customer_name', o.customer_name, 'customer_phone', o.customer_phone,
      'delivery_address', o.delivery_address, 'delivery_detail', o.delivery_detail,
      'delivery_lat', o.delivery_lat, 'delivery_lng', o.delivery_lng,
      'order_total', o.order_total, 'delivery_fee', o.delivery_fee,
      -- `payment_method` vive en `orders`, no en `delivery_orders`: el rider
      -- necesita saber si cobra en efectivo para llevar vuelto.
      'cash_amount', o.cash_amount, 'payment_method', ord.payment_method,
      'delivery_notes', o.delivery_notes,
      'picked_up_at', o.picked_up_at, 'created_at', o.created_at,
      'kitchen_status', ord.status, 'order_number', ord.order_number
    ) AS x
      FROM public.delivery_orders o
      JOIN public.delivery_riders dr ON dr.id = o.rider_id
      JOIN public.restaurants r      ON r.id  = o.restaurant_id
      LEFT JOIN public.orders ord    ON ord.id = o.order_id
     WHERE dr.user_id = v_uid
       AND o.rider_status IN ('confirmed','picked_up','on_way')
  ) q;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.rider_my_orders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rider_my_orders() TO authenticated;


-- Cambiar el estado de un pedido propio. Carril chico y controlado (mismo
-- criterio que attach_payment_proof, mig 183): toca 4 columnas y sólo en un
-- pedido que YA está asignado a quien llama. Con una policy de UPDATE abierta,
-- alguien que no es del local podría reescribir el total del pedido.
CREATE OR REPLACE FUNCTION public.rider_update_order(p_order_id uuid, p_action text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_o    public.delivery_orders%ROWTYPE;
  v_dr   public.delivery_riders%ROWTYPE;
  v_left INT;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'sin sesión' USING ERRCODE = '28000'; END IF;
  SELECT * INTO v_o FROM public.delivery_orders WHERE id = p_order_id FOR UPDATE;
  IF v_o.id IS NULL THEN RAISE EXCEPTION 'pedido inexistente' USING ERRCODE = '22023'; END IF;

  SELECT * INTO v_dr FROM public.delivery_riders WHERE id = v_o.rider_id;
  IF v_dr.id IS NULL OR v_dr.user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'ese pedido no es tuyo' USING ERRCODE = '42501';
  END IF;

  IF p_action = 'pickup' THEN
    IF v_o.rider_status <> 'confirmed' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'estado no válido');
    END IF;
    UPDATE public.delivery_orders
       SET rider_status = 'on_way', picked_up_at = COALESCE(picked_up_at, now())
     WHERE id = p_order_id;
    UPDATE public.delivery_riders SET current_status = 'en_ruta' WHERE id = v_dr.id;
    IF v_dr.mythos_rider_id IS NOT NULL THEN
      UPDATE public.mythos_riders SET availability = 'ocupado', updated_at = now()
       WHERE id = v_dr.mythos_rider_id AND availability <> 'ocupado';
    END IF;

  ELSIF p_action = 'deliver' THEN
    IF v_o.rider_status NOT IN ('confirmed','picked_up','on_way') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'estado no válido');
    END IF;
    UPDATE public.delivery_orders
       SET rider_status = 'delivered', status = 'delivered', delivered_at = now()
     WHERE id = p_order_id;
    -- Que caja y el cliente vean el pedido entregado (lo hacía el panel a mano).
    IF v_o.order_id IS NOT NULL THEN
      UPDATE public.orders SET status = 'delivered' WHERE id = v_o.order_id;
    END IF;

    UPDATE public.mythos_riders
       SET deliveries_count = deliveries_count + 1, updated_at = now()
     WHERE id = v_dr.mythos_rider_id;

    -- ¿Le queda algo en la mano, en CUALQUIERA de sus locales? Si no, vuelve a
    -- estar disponible. Preguntarlo por local dejaría a un rider de la red
    -- "ocupado" para siempre en el local donde terminó primero.
    SELECT count(*) INTO v_left
      FROM public.delivery_orders o2
      JOIN public.delivery_riders d2 ON d2.id = o2.rider_id
     WHERE d2.user_id = v_uid AND o2.rider_status IN ('confirmed','picked_up','on_way');

    IF v_left = 0 THEN
      IF v_dr.mythos_rider_id IS NOT NULL THEN
        UPDATE public.mythos_riders SET availability = 'disponible', updated_at = now()
         WHERE id = v_dr.mythos_rider_id AND status = 'activo';
      ELSE
        UPDATE public.delivery_riders SET current_status = 'disponible' WHERE id = v_dr.id;
      END IF;
    END IF;
  ELSE
    RAISE EXCEPTION 'acción inválida' USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.rider_update_order(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rider_update_order(uuid,text) TO authenticated;


-- ════════════════════════════════════════════════════════════════════════
-- 25) DESPACHO POR OFERTA
-- ════════════════════════════════════════════════════════════════════════
-- Distancia en línea recta. Alcanza para ordenar candidatos y para el corte de
-- "no le ofrezcas a alguien que está a 40 km"; no pretende ser la distancia de
-- manejo (eso necesitaría un servicio de ruteo, y está listado como futuro).
CREATE OR REPLACE FUNCTION public._rider_km(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT CASE WHEN lat1 IS NULL OR lng1 IS NULL OR lat2 IS NULL OR lng2 IS NULL THEN NULL
    ELSE round((6371 * 2 * asin(sqrt(
      power(sin(radians(lat2-lat1)/2), 2) +
      cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2-lng1)/2), 2)
    )))::numeric, 2) END;
$$;


-- Ofrecer un pedido al SIGUIENTE candidato. Secuencial y con tope: si nadie lo
-- toma después de `offer_max_riders`, el pedido queda huérfano y lo ve el local
-- (que puede asignarlo a mano), en vez de girar para siempre entre riders.
CREATE OR REPLACE FUNCTION public._rider_offer_next(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_o    public.delivery_orders%ROWTYPE;
  v_cfg  public.mythos_rider_config%ROWTYPE;
  v_p    public.mythos_delivery_partners%ROWTYPE;
  v_rest RECORD;
  v_cand RECORD;
  v_seq  INT;
  v_pay  NUMERIC;
BEGIN
  SELECT * INTO v_cfg FROM public.mythos_rider_config WHERE id;
  IF NOT COALESCE(v_cfg.network_enabled, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'network_off');
  END IF;

  SELECT * INTO v_o FROM public.delivery_orders WHERE id = p_order_id FOR UPDATE;
  IF v_o.id IS NULL OR v_o.rider_id IS NOT NULL
     OR v_o.rider_status NOT IN ('pending','confirmed')
     OR COALESCE(v_o.order_type, 'delivery') <> 'delivery' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_offerable');
  END IF;

  SELECT * INTO v_p FROM public.mythos_delivery_partners WHERE restaurant_id = v_o.restaurant_id;
  IF v_p.restaurant_id IS NULL OR v_p.status <> 'activo' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_partner');
  END IF;

  -- Ya hay una oferta viva para este pedido: no se duplica.
  IF EXISTS (SELECT 1 FROM public.mythos_rider_offers
              WHERE delivery_order_id = p_order_id AND status = 'pendiente') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_offered');
  END IF;

  SELECT count(*) + 1 INTO v_seq FROM public.mythos_rider_offers
   WHERE delivery_order_id = p_order_id;
  IF v_seq > COALESCE(v_cfg.offer_max_riders, 6) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'exhausted');
  END IF;

  SELECT r.lat, r.lng INTO v_rest FROM public.restaurants r WHERE r.id = v_o.restaurant_id;

  v_pay := CASE WHEN v_p.pay_type = 'pct'
                THEN round(COALESCE(v_o.order_total,0) * COALESCE(v_p.pay_value,0) / 100.0)
                ELSE COALESCE(v_p.pay_value, 0) END;

  -- Candidato: rider ACTIVO y DISPONIBLE, vinculado a este local, que no haya
  -- visto ya este pedido y que no tenga otro en la mano. Se prefiere al más
  -- cercano; los que no comparten ubicación van después, no quedan excluidos
  -- (si no, apagar el GPS sería quedarse sin trabajo).
  SELECT dr.id AS link_id, mr.id AS rider_id,
         public._rider_km(mr.last_lat, mr.last_lng, v_rest.lat, v_rest.lng) AS km
    INTO v_cand
    FROM public.delivery_riders dr
    JOIN public.mythos_riders   mr ON mr.id = dr.mythos_rider_id
   WHERE dr.restaurant_id = v_o.restaurant_id
     AND dr.mythos_rider_id IS NOT NULL
     AND dr.link_status = 'activo'
     AND dr.active IS NOT FALSE
     AND mr.status = 'activo'
     AND mr.availability = 'disponible'
     AND NOT EXISTS (SELECT 1 FROM public.mythos_rider_offers of2
                      WHERE of2.delivery_order_id = p_order_id AND of2.rider_id = mr.id)
     AND NOT EXISTS (SELECT 1 FROM public.delivery_orders o2
                      JOIN public.delivery_riders d2 ON d2.id = o2.rider_id
                     WHERE d2.user_id = mr.auth_user_id
                       AND o2.rider_status IN ('confirmed','picked_up','on_way'))
     AND (public._rider_km(mr.last_lat, mr.last_lng, v_rest.lat, v_rest.lng) IS NULL
          OR public._rider_km(mr.last_lat, mr.last_lng, v_rest.lat, v_rest.lng)
             <= COALESCE(v_cfg.max_distance_km, 10))
   ORDER BY public._rider_km(mr.last_lat, mr.last_lng, v_rest.lat, v_rest.lng) ASC NULLS LAST,
            mr.rating_avg DESC NULLS LAST,
            mr.deliveries_count ASC
   LIMIT 1;

  IF v_cand.rider_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_candidate');
  END IF;

  INSERT INTO public.mythos_rider_offers (
    delivery_order_id, rider_id, restaurant_id, link_id, seq,
    distance_km, pay_estimate, expires_at)
  VALUES (p_order_id, v_cand.rider_id, v_o.restaurant_id, v_cand.link_id, v_seq,
          v_cand.km, v_pay, now() + (COALESCE(v_cfg.accept_seconds, 60) || ' seconds')::interval);

  INSERT INTO public.mythos_rider_notifications (rider_id, kind, title, body)
  VALUES (v_cand.rider_id, 'pedido', 'Nuevo pedido disponible',
          'Tenés un pedido para aceptar. Entrá al panel antes de que expire.');

  RETURN jsonb_build_object('ok', true, 'rider_id', v_cand.rider_id, 'seq', v_seq);
END;
$$;


-- Vencer ofertas y pasar al siguiente. Se llama sola desde el panel del rider y
-- desde el barrido de despacho: es autosuficiente A PROPÓSITO, para no depender
-- de un cron por minuto (Vercel no da esa granularidad de forma barata) y que
-- un pedido no quede colgado esperando un reloj externo.
CREATE OR REPLACE FUNCTION public.expire_rider_offers()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_oid UUID; v_n INT := 0;
BEGIN
  FOR v_oid IN
    SELECT delivery_order_id FROM public.mythos_rider_offers
     WHERE status = 'pendiente' AND expires_at < now()
     LIMIT 200
  LOOP
    UPDATE public.mythos_rider_offers
       SET status = 'vencida', responded_at = now()
     WHERE delivery_order_id = v_oid AND status = 'pendiente' AND expires_at < now();
    v_n := v_n + 1;
    BEGIN
      PERFORM public._rider_offer_next(v_oid);
    EXCEPTION WHEN OTHERS THEN NULL;   -- best-effort: nunca frenar el barrido
    END;
  END LOOP;
  RETURN jsonb_build_object('expired', v_n);
END;
$$;

REVOKE ALL ON FUNCTION public.expire_rider_offers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expire_rider_offers() TO authenticated;


-- Lo que ve el rider cuando le suena el teléfono.
CREATE OR REPLACE FUNCTION public.rider_my_offers()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_id UUID := public.my_mythos_rider_id(); v_rows jsonb;
BEGIN
  IF v_id IS NULL THEN RETURN '[]'::jsonb; END IF;
  PERFORM public.expire_rider_offers();

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', f.id, 'order_id', f.delivery_order_id,
           'restaurant_id', f.restaurant_id, 'restaurant_name', r.name,
           'restaurant_address', r.address,
           'customer_name', o.customer_name,
           'delivery_address', o.delivery_address,
           'order_total', o.order_total, 'delivery_fee', o.delivery_fee,
           'payment_method', ord.payment_method, 'cash_amount', o.cash_amount,
           'distance_km', f.distance_km, 'pay_estimate', f.pay_estimate,
           'expires_at', f.expires_at,
           'seconds_left', GREATEST(0, floor(extract(epoch FROM (f.expires_at - now()))))
         ) ORDER BY f.offered_at), '[]'::jsonb)
    INTO v_rows
    FROM public.mythos_rider_offers f
    JOIN public.delivery_orders o ON o.id = f.delivery_order_id
    JOIN public.restaurants     r ON r.id = f.restaurant_id
    LEFT JOIN public.orders   ord ON ord.id = o.order_id
   WHERE f.rider_id = v_id AND f.status = 'pendiente' AND f.expires_at > now();

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.rider_my_offers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rider_my_offers() TO authenticated;


-- Aceptar o rechazar. Aceptar ASIGNA con la misma forma que
-- assign_delivery_order (mig 156) — mismo estado, mismas columnas — así cocina,
-- caja y el panel del local ven exactamente lo que ven siempre.
CREATE OR REPLACE FUNCTION public.rider_respond_offer(p_offer_id uuid, p_accept boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_id   UUID := public.my_mythos_rider_id();
  v_f    public.mythos_rider_offers%ROWTYPE;
  v_o    public.delivery_orders%ROWTYPE;
  v_name TEXT;
  v_cfg  public.mythos_rider_config%ROWTYPE;
  v_rej  INT;
BEGIN
  IF v_id IS NULL THEN RAISE EXCEPTION 'no sos rider de la red' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_cfg FROM public.mythos_rider_config WHERE id;

  SELECT * INTO v_f FROM public.mythos_rider_offers WHERE id = p_offer_id FOR UPDATE;
  IF v_f.id IS NULL OR v_f.rider_id <> v_id THEN
    RAISE EXCEPTION 'esa oferta no es tuya' USING ERRCODE = '42501';
  END IF;
  IF v_f.status <> 'pendiente' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ya respondida');
  END IF;
  IF v_f.expires_at < now() THEN
    UPDATE public.mythos_rider_offers SET status = 'vencida', responded_at = now() WHERE id = p_offer_id;
    PERFORM public._rider_offer_next(v_f.delivery_order_id);
    RETURN jsonb_build_object('ok', false, 'reason', 'expirada');
  END IF;

  IF NOT COALESCE(p_accept, false) THEN
    UPDATE public.mythos_rider_offers SET status = 'rechazada', responded_at = now()
     WHERE id = p_offer_id;

    -- Rechazar mucho tiene costo. Es lo que pidió el brief y también lo que
    -- hace que el sistema funcione: sin esto, la oferta se pasea por toda la
    -- red mientras la comida se enfría.
    SELECT count(*) INTO v_rej FROM public.mythos_rider_offers
     WHERE rider_id = v_id AND status IN ('rechazada','vencida')
       AND (responded_at AT TIME ZONE 'America/Asuncion')::date
           = (now() AT TIME ZONE 'America/Asuncion')::date;
    IF v_rej = COALESCE(v_cfg.max_rejections_per_day, 5) THEN
      INSERT INTO public.mythos_rider_incidents (rider_id, kind, reason, detail, automatic)
      VALUES (v_id, 'advertencia', 'Rechazos',
              'Superaste los ' || COALESCE(v_cfg.max_rejections_per_day,5) ||
              ' pedidos sin tomar en un día.', true);
      UPDATE public.mythos_riders SET warnings_count = warnings_count + 1, updated_at = now()
       WHERE id = v_id;
      INSERT INTO public.mythos_rider_notifications (rider_id, kind, title, body)
      VALUES (v_id, 'sancion', 'Advertencia',
              'Registramos muchos pedidos sin tomar hoy. Si podés, pasá a "Pausado" en vez de rechazar.');
    END IF;

    PERFORM public._rider_offer_next(v_f.delivery_order_id);
    RETURN jsonb_build_object('ok', true, 'accepted', false);
  END IF;

  -- ── Aceptar ──
  SELECT * INTO v_o FROM public.delivery_orders WHERE id = v_f.delivery_order_id FOR UPDATE;
  IF v_o.rider_id IS NOT NULL THEN
    UPDATE public.mythos_rider_offers SET status = 'cancelada', responded_at = now() WHERE id = p_offer_id;
    RETURN jsonb_build_object('ok', false, 'reason', 'otro rider ya lo tomó');
  END IF;

  SELECT name INTO v_name FROM public.delivery_riders WHERE id = v_f.link_id;

  UPDATE public.delivery_orders SET
    rider_id     = v_f.link_id,
    rider_name   = v_name,
    rider_status = 'confirmed',
    status       = 'assigned',
    assigned_at  = now()
  WHERE id = v_f.delivery_order_id;

  UPDATE public.mythos_rider_offers SET status = 'aceptada', responded_at = now() WHERE id = p_offer_id;
  UPDATE public.mythos_rider_offers SET status = 'cancelada', responded_at = now()
   WHERE delivery_order_id = v_f.delivery_order_id AND status = 'pendiente';

  RETURN jsonb_build_object('ok', true, 'accepted', true, 'order_id', v_f.delivery_order_id);
END;
$$;

REVOKE ALL ON FUNCTION public.rider_respond_offer(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rider_respond_offer(uuid,boolean) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 26) EL DESPACHO DE SIEMPRE, CON UN FILTRO MÁS
-- ════════════════════════════════════════════════════════════════════════
-- Se reponen las funciones de las migs 156 y 189 con DOS cambios y ninguno más:
--   (a) `AND COALESCE(r.dispatch_auto, true)` — un rider que trabaja por oferta
--       no puede recibir un pedido que no aceptó. Para los riders propios la
--       columna es true, así que su comportamiento es idéntico al de ayer.
--   (b) `SET search_path` completo (regla de la mig 195: estas venían con
--       `SET search_path = public` a secas).
-- El resto del cuerpo es el de la 156, verificado en producción. No se toca el
-- orden de preferencia, ni el desempate, ni el criterio de transferibilidad:
-- eso es lo único que hoy hace que los pedidos lleguen.
CREATE OR REPLACE FUNCTION public.assign_delivery_order(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_ord    delivery_orders%ROWTYPE;
  v_rid    uuid;
  v_rname  text;
  v_reason text := 'disponible';
BEGIN
  SELECT * INTO v_ord FROM delivery_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_ord.rider_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_assigned',
                              'rider_id', v_ord.rider_id, 'rider_name', v_ord.rider_name);
  END IF;

  IF v_ord.rider_status NOT IN ('pending', 'confirmed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_assignable',
                              'rider_status', v_ord.rider_status);
  END IF;

  -- 1) Preferir un rider DISPONIBLE. Desempate: menos pedidos HOY, luego menor
  --    carga activa, luego id (determinista). Hora local de Paraguay.
  SELECT r.id, r.name INTO v_rid, v_rname
  FROM delivery_riders r
  WHERE r.restaurant_id = v_ord.restaurant_id
    AND r.active IS NOT FALSE
    AND COALESCE(r.dispatch_auto, true)
    AND COALESCE(r.current_status, 'disponible') = 'disponible'
  ORDER BY
    (SELECT count(*) FROM delivery_orders o2
       WHERE o2.rider_id = r.id AND o2.assigned_at IS NOT NULL
         AND (o2.assigned_at AT TIME ZONE 'America/Asuncion')::date
             = (now() AT TIME ZONE 'America/Asuncion')::date) ASC,
    (SELECT count(*) FROM delivery_orders o3
       WHERE o3.rider_id = r.id AND o3.rider_status IN ('confirmed', 'on_way')) ASC,
    r.id ASC
  LIMIT 1;

  -- 2) Sin disponible → al rider EN RUTA (cola "próximo viaje").
  IF v_rid IS NULL THEN
    v_reason := 'en_ruta';
    SELECT r.id, r.name INTO v_rid, v_rname
    FROM delivery_riders r
    WHERE r.restaurant_id = v_ord.restaurant_id
      AND r.active IS NOT FALSE
      AND COALESCE(r.dispatch_auto, true)
      AND COALESCE(r.current_status, 'disponible') = 'en_ruta'
    ORDER BY
      (SELECT count(*) FROM delivery_orders o2
         WHERE o2.rider_id = r.id AND o2.assigned_at IS NOT NULL
           AND (o2.assigned_at AT TIME ZONE 'America/Asuncion')::date
               = (now() AT TIME ZONE 'America/Asuncion')::date) ASC,
      (SELECT count(*) FROM delivery_orders o3
         WHERE o3.rider_id = r.id AND o3.rider_status IN ('confirmed', 'on_way')) ASC,
      r.id ASC
    LIMIT 1;
  END IF;

  IF v_rid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_rider');
  END IF;

  UPDATE delivery_orders SET
    rider_id     = v_rid,
    rider_name   = v_rname,
    rider_status = 'confirmed',
    status       = 'assigned',
    assigned_at  = now()
  WHERE id = p_order_id;

  RETURN jsonb_build_object('ok', true, 'reason', v_reason,
                            'rider_id', v_rid, 'rider_name', v_rname);
END;
$$;


CREATE OR REPLACE FUNCTION public.rebalance_delivery_dispatch(p_restaurant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_moved      int := 0;
  v_recv       uuid;
  v_recv_name  text;
  v_recv_load  int;
  v_oid        uuid;
  v_owner_load int;
  i            int;
BEGIN
  IF NOT (
    public.get_my_role() = 'superadmin'
    OR public.get_my_restaurant_id() = p_restaurant_id
    OR EXISTS (SELECT 1 FROM delivery_riders
                 WHERE user_id = auth.uid() AND restaurant_id = p_restaurant_id)
  ) THEN
    RETURN jsonb_build_object('moved', 0, 'reason', 'forbidden');
  END IF;

  -- Rescatar huérfanos antes de rebalancear (mig 189) — incluye ahora el
  -- ofrecimiento a la red si el local es socio.
  BEGIN
    PERFORM public._sweep_unassigned_delivery(p_restaurant_id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  FOR i IN 1..200 LOOP
    SELECT r.id, r.name,
           (SELECT count(*) FROM delivery_orders o
              WHERE o.rider_id = r.id AND o.rider_status IN ('confirmed', 'on_way'))
      INTO v_recv, v_recv_name, v_recv_load
    FROM delivery_riders r
    WHERE r.restaurant_id = p_restaurant_id
      AND r.active IS NOT FALSE
      AND COALESCE(r.dispatch_auto, true)
      AND COALESCE(r.current_status, 'disponible') = 'disponible'
    ORDER BY
      (SELECT count(*) FROM delivery_orders o
         WHERE o.rider_id = r.id AND o.rider_status IN ('confirmed', 'on_way')) ASC,
      (SELECT count(*) FROM delivery_orders o2
         WHERE o2.rider_id = r.id AND o2.assigned_at IS NOT NULL
           AND (o2.assigned_at AT TIME ZONE 'America/Asuncion')::date
               = (now() AT TIME ZONE 'America/Asuncion')::date) ASC,
      r.id ASC
    LIMIT 1;

    EXIT WHEN v_recv IS NULL;

    SELECT o.id, ld.owner_load INTO v_oid, v_owner_load
    FROM delivery_orders o
    JOIN delivery_riders rr ON rr.id = o.rider_id
    CROSS JOIN LATERAL (
      SELECT count(*) AS owner_load FROM delivery_orders o2
       WHERE o2.rider_id = o.rider_id AND o2.rider_status IN ('confirmed', 'on_way')
    ) ld
    WHERE o.restaurant_id = p_restaurant_id
      AND o.rider_status = 'confirmed'
      AND o.picked_up_at IS NULL
      AND rr.active IS NOT FALSE
      AND COALESCE(rr.current_status, 'disponible') = 'en_ruta'
      -- Un pedido que un rider de la red ACEPTÓ no se le saca para dárselo a
      -- otro: aceptó un compromiso, no entró a una cola compartida.
      AND rr.mythos_rider_id IS NULL
    ORDER BY ld.owner_load DESC, o.created_at ASC
    LIMIT 1;

    EXIT WHEN v_oid IS NULL;
    EXIT WHEN v_owner_load <= v_recv_load + 1;

    UPDATE delivery_orders SET
      rider_id    = v_recv,
      rider_name  = v_recv_name,
      assigned_at = now()
    WHERE id = v_oid;

    v_moved := v_moved + 1;
  END LOOP;

  RETURN jsonb_build_object('moved', v_moved);
END;
$$;


-- ════════════════════════════════════════════════════════════════════════
-- 27) DONDE LA RED SE ENGANCHA: el pedido que nadie del local puede tomar
-- ════════════════════════════════════════════════════════════════════════
-- Se repone `_sweep_unassigned_delivery` (mig 189) con UNA rama nueva al final:
-- lo que quedó huérfano después de intentar con los riders del local se ofrece
-- a la red — pero SÓLO si el local es socio activo. Un restaurante que no entró
-- a la red nunca llega a esta rama y su comportamiento es idéntico al de hoy.
CREATE OR REPLACE FUNCTION public._sweep_unassigned_delivery(p_restaurant_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_oid     uuid;
  v_res     jsonb;
  v_claimed int := 0;
  v_partner boolean;
BEGIN
  FOR v_oid IN
    SELECT o.id
      FROM delivery_orders o
     WHERE o.restaurant_id = p_restaurant_id
       AND o.rider_id IS NULL
       AND o.order_type = 'delivery'
       AND o.rider_status IN ('pending', 'confirmed')
     ORDER BY o.created_at ASC
  LOOP
    v_res := public.assign_delivery_order(v_oid);
    IF COALESCE((v_res->>'ok')::boolean, false) THEN
      v_claimed := v_claimed + 1;
    ELSIF (v_res->>'reason') = 'no_rider' THEN
      EXIT;
    END IF;
  END LOOP;

  -- ── Rama nueva: ofrecer a la Red Mythos lo que siguió huérfano ──
  SELECT EXISTS (SELECT 1 FROM public.mythos_delivery_partners
                  WHERE restaurant_id = p_restaurant_id AND status = 'activo')
    INTO v_partner;

  IF v_partner THEN
    BEGIN
      PERFORM public.expire_rider_offers();
      FOR v_oid IN
        SELECT o.id
          FROM delivery_orders o
         WHERE o.restaurant_id = p_restaurant_id
           AND o.rider_id IS NULL
           AND o.order_type = 'delivery'
           AND o.rider_status IN ('pending', 'confirmed')
           AND NOT EXISTS (SELECT 1 FROM public.mythos_rider_offers f
                            WHERE f.delivery_order_id = o.id AND f.status = 'pendiente')
         ORDER BY o.created_at ASC
         LIMIT 30
      LOOP
        PERFORM public._rider_offer_next(v_oid);
      END LOOP;
    EXCEPTION WHEN OTHERS THEN NULL;   -- la red nunca puede frenar el despacho propio
    END;
  END IF;

  RETURN v_claimed;
END;
$$;


-- Barrido de la red disparado desde afuera (el panel del local, el del rider o
-- un cron). Con chequeo de autorización, a diferencia del `_sweep` interno.
CREATE OR REPLACE FUNCTION public.network_dispatch_sweep(p_restaurant_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_rid uuid; v_n int := 0;
BEGIN
  PERFORM public.expire_rider_offers();
  IF p_restaurant_id IS NOT NULL THEN
    IF NOT (public.get_my_role() = 'superadmin'
            OR public.get_my_restaurant_id() = p_restaurant_id
            OR EXISTS (SELECT 1 FROM public.delivery_riders
                        WHERE user_id = auth.uid() AND restaurant_id = p_restaurant_id)) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
    END IF;
    PERFORM public._sweep_unassigned_delivery(p_restaurant_id);
    RETURN jsonb_build_object('ok', true, 'scope', 'one');
  END IF;

  -- Sin restaurante: sólo el rider de la red (barre los locales donde trabaja)
  -- o el superadmin.
  IF public.get_my_role() = 'superadmin' THEN
    FOR v_rid IN SELECT restaurant_id FROM public.mythos_delivery_partners WHERE status = 'activo' LOOP
      PERFORM public._sweep_unassigned_delivery(v_rid); v_n := v_n + 1;
    END LOOP;
  ELSE
    FOR v_rid IN SELECT DISTINCT restaurant_id FROM public.delivery_riders WHERE user_id = auth.uid() LOOP
      PERFORM public._sweep_unassigned_delivery(v_rid); v_n := v_n + 1;
    END LOOP;
  END IF;
  RETURN jsonb_build_object('ok', true, 'restaurants', v_n);
END;
$$;

REVOKE ALL ON FUNCTION public.network_dispatch_sweep(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.network_dispatch_sweep(uuid) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 28) EL LOCAL — pedir entrar a la red y administrar sus riders de red
-- ════════════════════════════════════════════════════════════════════════
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


-- Lo que ve Admin › Delivery › Riders › Red Mythos.
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
  v_riders jsonb; v_offers jsonb;
BEGIN
  IF NOT (public.get_my_role() = 'superadmin'
          OR p_restaurant_id IN (SELECT public.get_my_company_restaurant_ids())) THEN
    RAISE EXCEPTION 'sin permiso' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_cfg FROM public.mythos_rider_config WHERE id;
  SELECT * INTO v_p   FROM public.mythos_delivery_partners WHERE restaurant_id = p_restaurant_id;

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
    'partner', CASE WHEN v_p.restaurant_id IS NULL THEN NULL ELSE to_jsonb(v_p) END,
    'riders',  v_riders,
    'offers',  v_offers
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mythos_partner_panel(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mythos_partner_panel(uuid) TO authenticated;


-- Pausar / reactivar / quitar a un rider de la red EN ESTE LOCAL. No lo
-- sanciona en la red: un local puede no querer trabajar con alguien sin que eso
-- sea una sanción de plataforma. Las sanciones las decide el superadmin.
CREATE OR REPLACE FUNCTION public.partner_set_rider_link(
  p_restaurant_id uuid, p_link_id uuid, p_action text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_active INT;
BEGIN
  IF NOT (public.get_my_role() = 'superadmin'
          OR (public.get_my_role() IN ('admin','supervisor_local')
              AND p_restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))) THEN
    RAISE EXCEPTION 'sin permiso' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.delivery_riders
                  WHERE id = p_link_id AND restaurant_id = p_restaurant_id
                    AND mythos_rider_id IS NOT NULL) THEN
    RAISE EXCEPTION 'ese rider no es de la red en este local' USING ERRCODE = '22023';
  END IF;

  IF p_action = 'pausar' THEN
    UPDATE public.delivery_riders
       SET link_status = 'pausado', active = false, current_status = 'offline'
     WHERE id = p_link_id;
  ELSIF p_action = 'activar' THEN
    UPDATE public.delivery_riders dr
       SET link_status = 'activo',
           active = (SELECT mr.status = 'activo' FROM public.mythos_riders mr
                      WHERE mr.id = dr.mythos_rider_id)
     WHERE dr.id = p_link_id;
  ELSIF p_action = 'quitar' THEN
    SELECT count(*) INTO v_active FROM public.delivery_orders
     WHERE rider_id = p_link_id AND rider_status IN ('confirmed','picked_up','on_way');
    IF v_active > 0 THEN
      RAISE EXCEPTION 'ese rider tiene % pedido(s) en curso: esperá o transferilos primero', v_active
        USING ERRCODE = '22023';
    END IF;
    DELETE FROM public.delivery_riders WHERE id = p_link_id;
  ELSE
    RAISE EXCEPTION 'acción inválida' USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.partner_set_rider_link(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.partner_set_rider_link(uuid,uuid,text) TO authenticated;


-- ════════════════════════════════════════════════════════════════════════
-- 29) REPUTACIÓN — el local califica la entrega
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.rate_rider(
  p_delivery_order_id uuid, p_stars int, p_scores jsonb DEFAULT '{}'::jsonb,
  p_comment text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_o   public.delivery_orders%ROWTYPE;
  v_mid UUID;
  v_cl  jsonb := '{}'::jsonb;
  v_k   TEXT;
BEGIN
  SELECT * INTO v_o FROM public.delivery_orders WHERE id = p_delivery_order_id;
  IF v_o.id IS NULL THEN RAISE EXCEPTION 'pedido inexistente' USING ERRCODE = '22023'; END IF;
  IF NOT (public.get_my_role() = 'superadmin'
          OR v_o.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())) THEN
    RAISE EXCEPTION 'sin permiso' USING ERRCODE = '42501';
  END IF;
  IF p_stars IS NULL OR p_stars < 1 OR p_stars > 5 THEN
    RAISE EXCEPTION 'la calificación va de 1 a 5' USING ERRCODE = '22023';
  END IF;
  -- Sólo se califica lo que efectivamente se entregó: si no, una discusión
  -- previa a la entrega se resolvería bajándole las estrellas al rider.
  IF v_o.rider_status <> 'delivered' THEN
    RAISE EXCEPTION 'sólo se califica un pedido entregado' USING ERRCODE = '22023';
  END IF;

  SELECT mythos_rider_id INTO v_mid FROM public.delivery_riders WHERE id = v_o.rider_id;
  IF v_mid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no es un rider de la red');
  END IF;

  -- Se aceptan SÓLO las dimensiones del catálogo activo: una clave inventada
  -- ensuciaría los promedios de por vida.
  FOR v_k IN SELECT slug FROM public.mythos_rider_rating_dimensions WHERE is_active LOOP
    IF p_scores ? v_k AND (p_scores->>v_k) ~ '^[1-5]$' THEN
      v_cl := v_cl || jsonb_build_object(v_k, (p_scores->>v_k)::int);
    END IF;
  END LOOP;

  INSERT INTO public.mythos_rider_ratings (
    rider_id, restaurant_id, delivery_order_id, source, stars, scores, comment, created_by)
  VALUES (v_mid, v_o.restaurant_id, p_delivery_order_id, 'restaurante',
          p_stars, v_cl, left(NULLIF(btrim(COALESCE(p_comment,'')),''), 1000), auth.uid())
  -- El WHERE repite el predicado del índice PARCIAL: sin él PostgreSQL no puede
  -- inferir cuál índice resuelve el conflicto y el INSERT falla.
  ON CONFLICT (delivery_order_id, source) WHERE delivery_order_id IS NOT NULL
  DO UPDATE SET stars = EXCLUDED.stars, scores = EXCLUDED.scores, comment = EXCLUDED.comment;

  PERFORM public._recalc_rider_stats(v_mid);
  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.rate_rider(uuid,int,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rate_rider(uuid,int,jsonb,text) TO authenticated;


-- Recalcula desde la BASE, sobre todo el historial. Nunca desde un array del
-- navegador: es el error que las migs 197 y 198 ya tuvieron que arreglar dos
-- veces, y acá el número que sale de acá decide sanciones.
CREATE OR REPLACE FUNCTION public._recalc_rider_stats(p_rider_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_del INT; v_ok NUMERIC; v_tot INT;
BEGIN
  SELECT count(*),
         round(avg(EXTRACT(EPOCH FROM (o.delivered_at - o.picked_up_at))/60.0)::numeric, 1)
    INTO v_del, v_ok
    FROM public.delivery_orders o
    JOIN public.delivery_riders dr ON dr.id = o.rider_id
   WHERE dr.mythos_rider_id = p_rider_id AND o.rider_status = 'delivered';

  -- Índice de cumplimiento: entregas sobre (entregas + ofertas que dejó pasar).
  SELECT count(*) INTO v_tot FROM public.mythos_rider_offers
   WHERE rider_id = p_rider_id AND status IN ('rechazada','vencida');

  UPDATE public.mythos_riders SET
    deliveries_count = COALESCE(v_del, 0),
    avg_minutes      = v_ok,
    rating_avg       = (SELECT round(avg(stars)::numeric, 2) FROM public.mythos_rider_ratings
                         WHERE rider_id = p_rider_id),
    rating_count     = (SELECT count(*) FROM public.mythos_rider_ratings WHERE rider_id = p_rider_id),
    compliance_pct   = CASE WHEN COALESCE(v_del,0) + COALESCE(v_tot,0) = 0 THEN NULL
                            ELSE round(100.0 * COALESCE(v_del,0)
                                       / (COALESCE(v_del,0) + COALESCE(v_tot,0)), 1) END,
    updated_at = now()
  WHERE id = p_rider_id;
END;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 30) EXPEDIENTES — abrir, aportar evidencia, resolver
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.open_rider_case(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_rest UUID := NULLIF(btrim(payload->>'restaurant_id'),'')::uuid;
  v_rid  UUID := NULLIF(btrim(payload->>'rider_id'),'')::uuid;
  v_ord  UUID := NULLIF(btrim(payload->>'delivery_order_id'),'')::uuid;
  v_role TEXT;
  v_my   UUID := public.my_mythos_rider_id();
  v_id   UUID;
  v_code TEXT;
BEGIN
  IF NULLIF(btrim(COALESCE(payload->>'subject','')),'') IS NULL THEN
    RAISE EXCEPTION 'contá en una línea de qué se trata' USING ERRCODE = '22023';
  END IF;

  IF public.get_my_role() = 'superadmin' THEN
    v_role := 'admin';
  ELSIF v_rest IS NOT NULL AND v_rest IN (SELECT public.get_my_company_restaurant_ids()) THEN
    v_role := 'restaurante';
  ELSIF v_my IS NOT NULL THEN
    v_role := 'rider';
    v_rid  := v_my;   -- un rider sólo abre expedientes sobre sí mismo
  ELSE
    RAISE EXCEPTION 'sin permiso' USING ERRCODE = '42501';
  END IF;

  -- Si viene por un pedido, el rider y el local salen del pedido: así el
  -- expediente no puede apuntar a alguien que no participó.
  IF v_ord IS NOT NULL THEN
    SELECT o.restaurant_id, dr.mythos_rider_id INTO v_rest, v_rid
      FROM public.delivery_orders o
      LEFT JOIN public.delivery_riders dr ON dr.id = o.rider_id
     WHERE o.id = v_ord;
  END IF;

  v_code := 'EXP-' || to_char(now() AT TIME ZONE 'America/Asuncion', 'YYMMDD') || '-' ||
            upper(substr(md5(gen_random_uuid()::text), 1, 4));

  INSERT INTO public.mythos_rider_cases (
    code, rider_id, restaurant_id, delivery_order_id, subject, description,
    opened_by, opened_role)
  VALUES (v_code, v_rid, v_rest, v_ord,
          left(btrim(payload->>'subject'), 200),
          left(NULLIF(btrim(payload->>'description'),''), 4000),
          auth.uid(), v_role)
  RETURNING id INTO v_id;

  IF v_rid IS NOT NULL THEN
    INSERT INTO public.mythos_rider_notifications (rider_id, kind, title, body)
    VALUES (v_rid, 'expediente', 'Se abrió un expediente ' || v_code,
            'Podés adjuntar tu versión y tus pruebas desde tu perfil.');
  END IF;

  RETURN jsonb_build_object('ok', true, 'case_id', v_id, 'code', v_code);
END;
$$;

REVOKE ALL ON FUNCTION public.open_rider_case(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.open_rider_case(jsonb) TO authenticated;


CREATE OR REPLACE FUNCTION public.add_rider_case_message(
  p_case_id uuid, p_body text, p_file_path text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_c    public.mythos_rider_cases%ROWTYPE;
  v_my   UUID := public.my_mythos_rider_id();
  v_role TEXT; v_name TEXT;
BEGIN
  SELECT * INTO v_c FROM public.mythos_rider_cases WHERE id = p_case_id;
  IF v_c.id IS NULL THEN RAISE EXCEPTION 'expediente inexistente' USING ERRCODE = '22023'; END IF;
  IF v_c.status IN ('resuelto','cerrado') THEN
    RAISE EXCEPTION 'ese expediente ya está cerrado' USING ERRCODE = '22023';
  END IF;

  IF public.get_my_role() = 'superadmin' THEN v_role := 'admin';
  ELSIF v_c.restaurant_id IS NOT NULL
        AND v_c.restaurant_id IN (SELECT public.get_my_company_restaurant_ids()) THEN v_role := 'restaurante';
  ELSIF v_my IS NOT NULL AND v_c.rider_id = v_my THEN v_role := 'rider';
  ELSE RAISE EXCEPTION 'sin permiso' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(display_name, username) INTO v_name FROM public.user_roles
   WHERE user_id = auth.uid() AND is_active LIMIT 1;
  IF v_role = 'rider' THEN
    SELECT NULLIF(btrim(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),'')
      INTO v_name FROM public.mythos_riders WHERE id = v_my;
  END IF;

  INSERT INTO public.mythos_rider_case_messages (case_id, author_id, author_role, author_name, body, file_path)
  VALUES (p_case_id, auth.uid(), v_role, v_name,
          left(NULLIF(btrim(COALESCE(p_body,'')),''), 4000),
          left(NULLIF(btrim(COALESCE(p_file_path,'')),''), 400));

  UPDATE public.mythos_rider_cases SET status = 'en_revision'
   WHERE id = p_case_id AND status = 'abierto';

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.add_rider_case_message(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_rider_case_message(uuid,text,text) TO authenticated;


CREATE OR REPLACE FUNCTION public.rider_case_detail(p_case_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_c public.mythos_rider_cases%ROWTYPE; v_my UUID := public.my_mythos_rider_id(); v_msgs jsonb;
BEGIN
  SELECT * INTO v_c FROM public.mythos_rider_cases WHERE id = p_case_id;
  IF v_c.id IS NULL THEN RETURN jsonb_build_object('ok', false); END IF;
  IF NOT (public.get_my_role() = 'superadmin'
          OR (v_c.rider_id IS NOT NULL AND v_c.rider_id = v_my)
          OR (v_c.restaurant_id IS NOT NULL
              AND v_c.restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))) THEN
    RAISE EXCEPTION 'sin permiso' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.created_at), '[]'::jsonb) INTO v_msgs
    FROM public.mythos_rider_case_messages m WHERE m.case_id = p_case_id;

  RETURN jsonb_build_object('ok', true, 'case', to_jsonb(v_c), 'messages', v_msgs);
END;
$$;

REVOKE ALL ON FUNCTION public.rider_case_detail(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rider_case_detail(uuid) TO authenticated;


-- ════════════════════════════════════════════════════════════════════════
-- 31) LIQUIDACIONES — Mythos lleva el libro, el local paga
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.rider_settlement_preview(
  p_restaurant_id uuid, p_rider_id uuid, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_p public.mythos_delivery_partners%ROWTYPE; v_n INT; v_amt NUMERIC; v_bank jsonb;
BEGIN
  IF NOT (public.get_my_role() = 'superadmin'
          OR p_restaurant_id IN (SELECT public.get_my_company_restaurant_ids())) THEN
    RAISE EXCEPTION 'sin permiso' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_p FROM public.mythos_delivery_partners WHERE restaurant_id = p_restaurant_id;

  SELECT count(*),
         COALESCE(sum(CASE WHEN v_p.pay_type = 'pct'
                           THEN round(COALESCE(o.order_total,0) * COALESCE(v_p.pay_value,0) / 100.0)
                           ELSE COALESCE(v_p.pay_value,0) END), 0)
    INTO v_n, v_amt
    FROM public.delivery_orders o
    JOIN public.delivery_riders dr ON dr.id = o.rider_id
   WHERE dr.restaurant_id = p_restaurant_id
     AND dr.mythos_rider_id = p_rider_id
     AND o.rider_status = 'delivered'
     AND (o.delivered_at AT TIME ZONE 'America/Asuncion')::date BETWEEN p_from AND p_to;

  -- Los datos bancarios se revelan SÓLO acá, y sólo del rider que trabajó para
  -- este local en el período: es el único momento en que el local los necesita.
  SELECT jsonb_build_object('holder', mr.bank_holder, 'bank', mr.bank_name,
                            'account', mr.bank_account, 'alias', mr.bank_alias,
                            'type', mr.bank_account_type,
                            'name', NULLIF(btrim(COALESCE(mr.first_name,'')||' '||COALESCE(mr.last_name,'')),''),
                            'phone', mr.phone)
    INTO v_bank FROM public.mythos_riders mr WHERE mr.id = p_rider_id;

  RETURN jsonb_build_object('ok', true, 'deliveries', v_n, 'amount', v_amt,
    'pay_type', v_p.pay_type, 'pay_value', v_p.pay_value, 'pay_method', v_p.pay_method,
    'rider', v_bank);
END;
$$;

REVOKE ALL ON FUNCTION public.rider_settlement_preview(uuid,uuid,date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rider_settlement_preview(uuid,uuid,date,date) TO authenticated;


CREATE OR REPLACE FUNCTION public.register_rider_settlement(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_rest UUID := NULLIF(btrim(payload->>'restaurant_id'),'')::uuid;
  v_rid  UUID := NULLIF(btrim(payload->>'rider_id'),'')::uuid;
  v_id   UUID;
BEGIN
  IF NOT (public.get_my_role() = 'superadmin'
          OR (public.get_my_role() IN ('admin','supervisor_local')
              AND v_rest IN (SELECT public.get_my_company_restaurant_ids()))) THEN
    RAISE EXCEPTION 'sin permiso' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.mythos_rider_settlements (
    rider_id, restaurant_id, period_from, period_to, deliveries, amount,
    method, reference, note, status, paid_at, created_by)
  VALUES (v_rid, v_rest,
          (payload->>'period_from')::date, (payload->>'period_to')::date,
          COALESCE(NULLIF(btrim(payload->>'deliveries'),'')::int, 0),
          COALESCE(NULLIF(btrim(payload->>'amount'),'')::numeric, 0),
          left(NULLIF(btrim(payload->>'method'),''), 40),
          left(NULLIF(btrim(payload->>'reference'),''), 120),
          left(NULLIF(btrim(payload->>'note'),''), 1000),
          'pagado', now(), auth.uid())
  RETURNING id INTO v_id;

  INSERT INTO public.mythos_rider_notifications (rider_id, kind, title, body)
  VALUES (v_rid, 'pago', 'Te registraron un pago',
          'Un local registró el pago de tus entregas. Revisalo en tu historial.');

  RETURN jsonb_build_object('ok', true, 'settlement_id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.register_rider_settlement(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_rider_settlement(jsonb) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 32) SUPERADMIN — la mesa de control de la red
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.superadmin_rider_dashboard()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_today DATE := (now() AT TIME ZONE 'America/Asuncion')::date;
BEGIN
  IF public.get_my_role() <> 'superadmin' THEN
    RAISE EXCEPTION 'sin permiso' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'total',       (SELECT count(*) FROM public.mythos_riders WHERE status <> 'borrador'),
    'borradores',  (SELECT count(*) FROM public.mythos_riders WHERE status = 'borrador'),
    'pendientes',  (SELECT count(*) FROM public.mythos_riders WHERE status IN ('pendiente','observado')),
    'aprobados',   (SELECT count(*) FROM public.mythos_riders WHERE status = 'aprobado'),
    'activos',     (SELECT count(*) FROM public.mythos_riders WHERE status = 'activo'),
    'suspendidos', (SELECT count(*) FROM public.mythos_riders WHERE status = 'suspendido'),
    'bloqueados',  (SELECT count(*) FROM public.mythos_riders WHERE status = 'bloqueado'),
    'en_linea',    (SELECT count(*) FROM public.mythos_riders
                     WHERE status = 'activo' AND availability IN ('disponible','ocupado')),
    'entregas_hoy',(SELECT count(*) FROM public.delivery_orders o
                     JOIN public.delivery_riders dr ON dr.id = o.rider_id
                    WHERE dr.mythos_rider_id IS NOT NULL AND o.rider_status = 'delivered'
                      AND (o.delivered_at AT TIME ZONE 'America/Asuncion')::date = v_today),
    'socios',      (SELECT count(*) FROM public.mythos_delivery_partners WHERE status = 'activo'),
    'socios_pend', (SELECT count(*) FROM public.mythos_delivery_partners WHERE status = 'pendiente'),
    'docs_por_vencer', (SELECT count(*) FROM public.mythos_rider_documents
                         WHERE replaced_at IS NULL AND expires_at IS NOT NULL
                           AND expires_at BETWEEN v_today AND v_today + 30),
    'docs_vencidos', (SELECT count(*) FROM public.mythos_rider_documents
                       WHERE replaced_at IS NULL AND expires_at IS NOT NULL AND expires_at < v_today),
    'casos_abiertos', (SELECT count(*) FROM public.mythos_rider_cases
                        WHERE status IN ('abierto','en_revision','esperando'))
  );
END;
$$;

REVOKE ALL ON FUNCTION public.superadmin_rider_dashboard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.superadmin_rider_dashboard() TO authenticated;


CREATE OR REPLACE FUNCTION public.superadmin_rider_list(
  p_status text DEFAULT NULL, p_search text DEFAULT NULL,
  p_city text DEFAULT NULL, p_limit int DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_rows jsonb;
BEGIN
  IF public.get_my_role() <> 'superadmin' THEN
    RAISE EXCEPTION 'sin permiso' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'submitted_at') DESC NULLS LAST), '[]'::jsonb)
    INTO v_rows FROM (
    SELECT jsonb_build_object(
      'id', r.id, 'name', NULLIF(btrim(COALESCE(r.first_name,'')||' '||COALESCE(r.last_name,'')),''),
      'photo_url', r.photo_url, 'city', r.city, 'department', r.department,
      'phone', r.phone, 'email', r.email, 'doc_number', r.doc_number,
      'vehicle_type', r.vehicle_type, 'status', r.status, 'availability', r.availability,
      'submitted_at', r.submitted_at, 'created_at', r.created_at,
      'deliveries', r.deliveries_count, 'rating_avg', r.rating_avg,
      'warnings', r.warnings_count,
      'places', (SELECT count(*) FROM public.delivery_riders d WHERE d.mythos_rider_id = r.id),
      'docs_pend', (SELECT count(*) FROM public.mythos_rider_documents d
                     WHERE d.rider_id = r.id AND d.replaced_at IS NULL AND d.status = 'pendiente'),
      'docs_venc', (SELECT count(*) FROM public.mythos_rider_documents d
                     WHERE d.rider_id = r.id AND d.replaced_at IS NULL
                       AND d.expires_at IS NOT NULL
                       AND d.expires_at < (now() AT TIME ZONE 'America/Asuncion')::date)
    ) AS x
      FROM public.mythos_riders r
     WHERE (p_status IS NULL OR btrim(p_status) = '' OR r.status = btrim(p_status))
       AND (p_city IS NULL OR btrim(p_city) = '' OR lower(COALESCE(r.city,'')) = lower(btrim(p_city)))
       AND (p_search IS NULL OR btrim(p_search) = ''
            OR COALESCE(r.first_name,'')||' '||COALESCE(r.last_name,'') ILIKE '%'||btrim(p_search)||'%'
            OR COALESCE(r.doc_number,'') ILIKE '%'||btrim(p_search)||'%'
            OR COALESCE(r.phone,'')      ILIKE '%'||btrim(p_search)||'%'
            OR COALESCE(r.email,'')      ILIKE '%'||btrim(p_search)||'%'
            OR COALESCE(r.vehicle_plate,'') ILIKE '%'||btrim(p_search)||'%')
     ORDER BY r.submitted_at DESC NULLS LAST
     LIMIT GREATEST(COALESCE(p_limit, 100), 1)
  ) q;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.superadmin_rider_list(text,text,text,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.superadmin_rider_list(text,text,text,int) TO authenticated;


CREATE OR REPLACE FUNCTION public.superadmin_rider_detail(p_rider_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_r public.mythos_riders%ROWTYPE; v_docs jsonb; v_links jsonb;
        v_inc jsonb; v_cases jsonb; v_ct jsonb; v_rat jsonb; v_set jsonb;
BEGIN
  IF public.get_my_role() <> 'superadmin' THEN
    RAISE EXCEPTION 'sin permiso' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_r FROM public.mythos_riders WHERE id = p_rider_id;
  IF v_r.id IS NULL THEN RETURN jsonb_build_object('ok', false); END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', d.id, 'slug', d.doc_slug, 'label', t.label, 'required', t.required,
           'file_path', d.file_path, 'status', d.status, 'issued_at', d.issued_at,
           'expires_at', d.expires_at, 'review_note', d.review_note,
           'uploaded_at', d.uploaded_at, 'replaced_at', d.replaced_at
         ) ORDER BY t.sort_order, d.uploaded_at DESC), '[]'::jsonb)
    INTO v_docs
    FROM public.mythos_rider_documents d
    LEFT JOIN public.mythos_rider_doc_types t ON t.slug = d.doc_slug
   WHERE d.rider_id = p_rider_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'link_id', dr.id, 'restaurant_id', r.id, 'name', r.name,
           'link_status', dr.link_status, 'linked_at', dr.linked_at,
           'deliveries', (SELECT count(*) FROM public.delivery_orders o
                           WHERE o.rider_id = dr.id AND o.rider_status = 'delivered')
         ) ORDER BY r.name), '[]'::jsonb)
    INTO v_links
    FROM public.delivery_riders dr JOIN public.restaurants r ON r.id = dr.restaurant_id
   WHERE dr.mythos_rider_id = p_rider_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.created_at DESC), '[]'::jsonb) INTO v_inc
    FROM public.mythos_rider_incidents i WHERE i.rider_id = p_rider_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.created_at DESC), '[]'::jsonb) INTO v_cases
    FROM public.mythos_rider_cases c WHERE c.rider_id = p_rider_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(k) ORDER BY k.accepted_at DESC), '[]'::jsonb) INTO v_ct
    FROM public.mythos_rider_contracts k WHERE k.rider_id = p_rider_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'stars', rt.stars, 'scores', rt.scores, 'comment', rt.comment,
           'source', rt.source, 'created_at', rt.created_at,
           'restaurant', (SELECT name FROM public.restaurants WHERE id = rt.restaurant_id)
         ) ORDER BY rt.created_at DESC), '[]'::jsonb)
    INTO v_rat
    FROM (SELECT * FROM public.mythos_rider_ratings
           WHERE rider_id = p_rider_id ORDER BY created_at DESC LIMIT 50) rt;

  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.period_to DESC), '[]'::jsonb) INTO v_set
    FROM public.mythos_rider_settlements s WHERE s.rider_id = p_rider_id;

  RETURN jsonb_build_object('ok', true, 'rider', to_jsonb(v_r),
    'docs', v_docs, 'links', v_links, 'incidents', v_inc, 'cases', v_cases,
    'contracts', v_ct, 'ratings', v_rat, 'settlements', v_set);
END;
$$;

REVOKE ALL ON FUNCTION public.superadmin_rider_detail(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.superadmin_rider_detail(uuid) TO authenticated;


-- Toda decisión sobre un rider pasa por acá: cambia el estado Y deja el asiento
-- disciplinario en la misma transacción. Si el estado se pudiera cambiar por
-- fuera, el historial —que es lo que sostiene una suspensión si alguien la
-- discute— quedaría con agujeros.
CREATE OR REPLACE FUNCTION public.superadmin_review_rider(
  p_rider_id uuid, p_action text, p_note text DEFAULT NULL, p_days int DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_cfg  public.mythos_rider_config%ROWTYPE;
  v_new  TEXT; v_kind TEXT; v_until TIMESTAMPTZ; v_title TEXT; v_body TEXT;
BEGIN
  IF public.get_my_role() <> 'superadmin' THEN
    RAISE EXCEPTION 'sin permiso' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_cfg FROM public.mythos_rider_config WHERE id;

  CASE p_action
    WHEN 'aprobar' THEN
      v_new := CASE WHEN COALESCE(v_cfg.require_training, false)
                      AND (SELECT training_done_at FROM public.mythos_riders WHERE id = p_rider_id) IS NULL
                    THEN 'aprobado' ELSE 'activo' END;
      v_kind := 'aprobacion';
      v_title := 'Tu solicitud fue aprobada';
      v_body  := CASE WHEN v_new = 'aprobado'
                      THEN 'Te falta completar la capacitación para empezar a recibir pedidos.'
                      ELSE 'Ya podés sumarte a los locales de la red y recibir pedidos.' END;
    WHEN 'activar' THEN
      v_new := 'activo'; v_kind := 'reactivacion';
      v_title := 'Tu cuenta está activa'; v_body := 'Ya podés recibir pedidos.';
    WHEN 'observar' THEN
      v_new := 'observado'; v_kind := 'observacion';
      v_title := 'Necesitamos que corrijas algo';
      v_body  := COALESCE(p_note, 'Revisá tu solicitud y volvé a enviarla.');
    WHEN 'rechazar' THEN
      v_new := 'rechazado'; v_kind := 'rechazo';
      v_title := 'Tu solicitud no fue aprobada'; v_body := p_note;
    WHEN 'suspender' THEN
      v_new := 'suspendido'; v_kind := 'suspension';
      v_until := now() + (COALESCE(p_days, v_cfg.suspension_days, 7) || ' days')::interval;
      v_title := 'Tu cuenta fue suspendida'; v_body := p_note;
    WHEN 'bloquear' THEN
      v_new := 'bloqueado'; v_kind := 'bloqueo';
      v_title := 'Tu cuenta fue bloqueada'; v_body := p_note;
    WHEN 'advertir' THEN
      v_kind := 'advertencia';
      v_title := 'Recibiste una advertencia'; v_body := p_note;
    WHEN 'baja' THEN
      v_new := 'baja'; v_kind := 'baja';
      v_title := 'Tu cuenta fue dada de baja'; v_body := p_note;
    WHEN 'nota' THEN
      v_kind := 'nota';
    ELSE
      RAISE EXCEPTION 'acción inválida' USING ERRCODE = '22023';
  END CASE;

  INSERT INTO public.mythos_rider_incidents (rider_id, kind, reason, detail, days, effective_until, created_by)
  VALUES (p_rider_id, v_kind, p_action, left(COALESCE(p_note,''), 2000),
          CASE WHEN p_action = 'suspender' THEN COALESCE(p_days, v_cfg.suspension_days, 7) END,
          v_until, auth.uid());

  IF p_action = 'advertir' THEN
    UPDATE public.mythos_riders SET warnings_count = warnings_count + 1, updated_at = now()
     WHERE id = p_rider_id;
    -- Escalada automática: la advertencia número N suspende sola. El brief pide
    -- una progresión, y una progresión que depende de que alguien se acuerde de
    -- aplicarla no es una progresión.
    IF (SELECT warnings_count FROM public.mythos_riders WHERE id = p_rider_id)
       >= COALESCE(v_cfg.warnings_before_suspension, 3) THEN
      UPDATE public.mythos_riders
         SET status = 'suspendido', availability = 'desconectado',
             suspended_until = now() + (COALESCE(v_cfg.suspension_days,7) || ' days')::interval,
             status_reason = 'acumulación de advertencias', status_changed_at = now(), updated_at = now()
       WHERE id = p_rider_id AND status = 'activo';
      INSERT INTO public.mythos_rider_incidents (rider_id, kind, reason, detail, days, automatic, created_by)
      VALUES (p_rider_id, 'suspension', 'Acumulación de advertencias',
              'Se alcanzó el máximo de advertencias configurado.',
              COALESCE(v_cfg.suspension_days,7), true, auth.uid());
    END IF;
  ELSIF v_new IS NOT NULL THEN
    UPDATE public.mythos_riders SET
      status = v_new,
      status_reason = left(COALESCE(p_note,''), 500),
      status_changed_at = now(),
      suspended_until = CASE WHEN p_action = 'suspender' THEN v_until ELSE NULL END,
      approved_at = CASE WHEN p_action IN ('aprobar','activar') THEN COALESCE(approved_at, now()) ELSE approved_at END,
      availability = CASE WHEN v_new IN ('suspendido','bloqueado','baja','rechazado','observado')
                          THEN 'desconectado' ELSE availability END,
      warnings_count = CASE WHEN p_action = 'activar' THEN 0 ELSE warnings_count END,
      updated_at = now()
    WHERE id = p_rider_id;
  END IF;

  IF v_title IS NOT NULL THEN
    INSERT INTO public.mythos_rider_notifications (rider_id, kind, title, body)
    VALUES (p_rider_id, v_kind, v_title, v_body);
  END IF;

  RETURN jsonb_build_object('ok', true, 'status',
    (SELECT status FROM public.mythos_riders WHERE id = p_rider_id));
END;
$$;

REVOKE ALL ON FUNCTION public.superadmin_review_rider(uuid,text,text,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.superadmin_review_rider(uuid,text,text,int) TO authenticated;


CREATE OR REPLACE FUNCTION public.superadmin_review_document(
  p_doc_id uuid, p_action text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_rid UUID; v_label TEXT;
BEGIN
  IF public.get_my_role() <> 'superadmin' THEN
    RAISE EXCEPTION 'sin permiso' USING ERRCODE = '42501';
  END IF;
  IF p_action NOT IN ('aprobar','rechazar') THEN
    RAISE EXCEPTION 'acción inválida' USING ERRCODE = '22023';
  END IF;

  UPDATE public.mythos_rider_documents
     SET status = CASE WHEN p_action = 'aprobar' THEN 'aprobado' ELSE 'rechazado' END,
         review_note = left(COALESCE(p_note,''), 1000),
         reviewed_by = auth.uid(), reviewed_at = now()
   WHERE id = p_doc_id
  RETURNING rider_id, doc_slug INTO v_rid, v_label;

  IF v_rid IS NULL THEN RAISE EXCEPTION 'documento inexistente' USING ERRCODE = '22023'; END IF;

  INSERT INTO public.mythos_rider_notifications (rider_id, kind, title, body)
  VALUES (v_rid, 'documento',
          CASE WHEN p_action = 'aprobar' THEN 'Documento aprobado' ELSE 'Documento rechazado' END,
          COALESCE(p_note, v_label));

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.superadmin_review_document(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.superadmin_review_document(uuid,text,text) TO authenticated;


CREATE OR REPLACE FUNCTION public.superadmin_review_partner(
  p_restaurant_id uuid, p_action text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_new TEXT;
BEGIN
  IF public.get_my_role() <> 'superadmin' THEN
    RAISE EXCEPTION 'sin permiso' USING ERRCODE = '42501';
  END IF;
  v_new := CASE p_action
             WHEN 'aprobar'  THEN 'activo'
             WHEN 'pausar'   THEN 'pausado'
             WHEN 'rechazar' THEN 'rechazado'
             ELSE NULL END;
  IF v_new IS NULL THEN RAISE EXCEPTION 'acción inválida' USING ERRCODE = '22023'; END IF;

  UPDATE public.mythos_delivery_partners
     SET status = v_new, review_note = left(COALESCE(p_note,''), 1000),
         reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
   WHERE restaurant_id = p_restaurant_id;

  -- Pausar/rechazar al local apaga a sus riders de red AHÍ, no en toda la red.
  IF v_new <> 'activo' THEN
    UPDATE public.delivery_riders
       SET active = false, current_status = 'offline', link_status = 'pausado'
     WHERE restaurant_id = p_restaurant_id AND mythos_rider_id IS NOT NULL;
  END IF;

  RETURN jsonb_build_object('ok', true, 'status', v_new);
END;
$$;

REVOKE ALL ON FUNCTION public.superadmin_review_partner(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.superadmin_review_partner(uuid,text,text) TO authenticated;


CREATE OR REPLACE FUNCTION public.superadmin_resolve_case(
  p_case_id uuid, p_status text, p_resolution text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_rid UUID; v_code TEXT;
BEGIN
  IF public.get_my_role() <> 'superadmin' THEN
    RAISE EXCEPTION 'sin permiso' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('abierto','en_revision','esperando','resuelto','cerrado') THEN
    RAISE EXCEPTION 'estado inválido' USING ERRCODE = '22023';
  END IF;

  UPDATE public.mythos_rider_cases
     SET status = p_status,
         resolution = COALESCE(left(NULLIF(btrim(COALESCE(p_resolution,'')),''), 4000), resolution),
         resolved_by = CASE WHEN p_status IN ('resuelto','cerrado') THEN auth.uid() ELSE resolved_by END,
         resolved_at = CASE WHEN p_status IN ('resuelto','cerrado') THEN now() ELSE resolved_at END
   WHERE id = p_case_id
  RETURNING rider_id, code INTO v_rid, v_code;

  IF v_rid IS NOT NULL AND p_status IN ('resuelto','cerrado') THEN
    INSERT INTO public.mythos_rider_notifications (rider_id, kind, title, body)
    VALUES (v_rid, 'expediente', 'Expediente ' || v_code || ' resuelto', p_resolution);
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.superadmin_resolve_case(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.superadmin_resolve_case(uuid,text,text) TO authenticated;


-- ════════════════════════════════════════════════════════════════════════
-- 33) VENCIMIENTOS — el módulo que evita que alguien reparta sin papeles
-- ════════════════════════════════════════════════════════════════════════
-- Lo dispara el cron diario /api/cron/rider-docs. Avisa en los umbrales
-- configurados y, cuando un documento OBLIGATORIO vence, suspende. La
-- suspensión es reversible por definición: se levanta reponiendo el papel y
-- aprobándolo — no es una sanción, es una habilitación que caducó.
CREATE OR REPLACE FUNCTION public.expire_rider_documents()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_cfg    public.mythos_rider_config%ROWTYPE;
  v_today  DATE := (now() AT TIME ZONE 'America/Asuncion')::date;
  v_d      RECORD;
  v_warned INT := 0; v_expired INT := 0; v_susp INT := 0;
BEGIN
  SELECT * INTO v_cfg FROM public.mythos_rider_config WHERE id;

  -- 1) Avisos previos
  FOR v_d IN
    SELECT d.id, d.rider_id, d.doc_slug, d.expires_at, t.label,
           (d.expires_at - v_today) AS days_left
      FROM public.mythos_rider_documents d
      LEFT JOIN public.mythos_rider_doc_types t ON t.slug = d.doc_slug
     WHERE d.replaced_at IS NULL AND d.expires_at IS NOT NULL
       AND d.expires_at >= v_today
       AND (d.expires_at - v_today) = ANY (COALESCE(v_cfg.expiry_warn_days, '{30,15,7,1}'))
       AND (d.warned_days IS NULL OR d.warned_days > (d.expires_at - v_today))
  LOOP
    INSERT INTO public.mythos_rider_notifications (rider_id, kind, title, body)
    VALUES (v_d.rider_id, 'vencimiento',
            'Tu ' || COALESCE(v_d.label, v_d.doc_slug) || ' vence en ' || v_d.days_left || ' día(s)',
            'Subí el documento actualizado desde tu perfil para no quedar suspendido.');
    UPDATE public.mythos_rider_documents SET warned_days = v_d.days_left WHERE id = v_d.id;
    v_warned := v_warned + 1;
  END LOOP;

  -- 2) Vencidos
  UPDATE public.mythos_rider_documents
     SET status = 'vencido'
   WHERE replaced_at IS NULL AND expires_at IS NOT NULL
     AND expires_at < v_today AND status <> 'vencido';
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  -- 3) Suspensión automática si el vencido era OBLIGATORIO para su vehículo
  IF COALESCE(v_cfg.auto_suspend_on_expiry, true) THEN
    FOR v_d IN
      SELECT DISTINCT r.id AS rider_id
        FROM public.mythos_riders r
        JOIN public.mythos_rider_documents d ON d.rider_id = r.id AND d.replaced_at IS NULL
        JOIN public.mythos_rider_doc_types t ON t.slug = d.doc_slug
       WHERE r.status = 'activo' AND t.required AND t.is_active
         AND (COALESCE(array_length(t.vehicles,1),0) = 0 OR r.vehicle_type = ANY(t.vehicles))
         AND d.expires_at IS NOT NULL AND d.expires_at < v_today
    LOOP
      UPDATE public.mythos_riders
         SET status = 'suspendido', availability = 'desconectado',
             status_reason = 'documentación vencida', status_changed_at = now(), updated_at = now()
       WHERE id = v_d.rider_id;
      INSERT INTO public.mythos_rider_incidents (rider_id, kind, reason, detail, automatic)
      VALUES (v_d.rider_id, 'suspension', 'Documentación vencida',
              'Suspensión automática hasta regularizar la documentación.', true);
      INSERT INTO public.mythos_rider_notifications (rider_id, kind, title, body)
      VALUES (v_d.rider_id, 'vencimiento', 'Cuenta suspendida por documentación vencida',
              'Subí el documento actualizado y lo revisamos para reactivarte.');
      v_susp := v_susp + 1;
    END LOOP;
  END IF;

  -- 4) Vencer suspensiones temporales cumplidas (sanciones con plazo).
  UPDATE public.mythos_riders
     SET status = 'activo', suspended_until = NULL, warnings_count = 0,
         status_reason = NULL, status_changed_at = now(), updated_at = now()
   WHERE status = 'suspendido' AND suspended_until IS NOT NULL AND suspended_until < now()
     AND status_reason IS DISTINCT FROM 'documentación vencida';

  RETURN jsonb_build_object('ok', true, 'warned', v_warned,
                            'expired', v_expired, 'suspended', v_susp);
END;
$$;

REVOKE ALL ON FUNCTION public.expire_rider_documents() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expire_rider_documents() TO authenticated;


-- ════════════════════════════════════════════════════════════════════════
-- 34) RANKING E HISTORIAL — agregados del lado del servidor
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.rider_leaderboard(
  p_scope text DEFAULT 'mes', p_city text DEFAULT NULL, p_limit int DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_from DATE; v_rows jsonb; v_today DATE := (now() AT TIME ZONE 'America/Asuncion')::date;
BEGIN
  v_from := CASE p_scope
              WHEN 'mes'      THEN date_trunc('month', v_today)::date
              WHEN 'semana'   THEN (v_today - 6)
              ELSE NULL END;   -- 'historico'

  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'deliveries')::int DESC,
                                       (x->>'rating')::numeric DESC NULLS LAST), '[]'::jsonb)
    INTO v_rows FROM (
    SELECT jsonb_build_object(
      'rider_id', r.id,
      'name', NULLIF(btrim(COALESCE(r.first_name,'')||' '||COALESCE(r.last_name,'')),''),
      'photo_url', r.photo_url, 'city', r.city, 'vehicle', r.vehicle_type,
      'rating', r.rating_avg,
      'deliveries', (SELECT count(*) FROM public.delivery_orders o
                       JOIN public.delivery_riders dr ON dr.id = o.rider_id
                      WHERE dr.mythos_rider_id = r.id AND o.rider_status = 'delivered'
                        AND (v_from IS NULL
                             OR (o.delivered_at AT TIME ZONE 'America/Asuncion')::date >= v_from))
    ) AS x
      FROM public.mythos_riders r
     WHERE r.status = 'activo'
       AND (p_city IS NULL OR btrim(p_city) = '' OR lower(COALESCE(r.city,'')) = lower(btrim(p_city)))
  ) q
   WHERE (q.x->>'deliveries')::int > 0;

  RETURN jsonb_build_object('scope', p_scope, 'from', v_from,
    'rows', (SELECT jsonb_agg(e) FROM (
       SELECT e FROM jsonb_array_elements(v_rows) e LIMIT GREATEST(COALESCE(p_limit,20),1)) s));
END;
$$;

REVOKE ALL ON FUNCTION public.rider_leaderboard(text,text,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rider_leaderboard(text,text,int) TO authenticated;


CREATE OR REPLACE FUNCTION public.rider_my_history(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_id  UUID := public.my_mythos_rider_id();
  v_f   DATE := COALESCE(p_from, (now() AT TIME ZONE 'America/Asuncion')::date);
  v_t   DATE := COALESCE(p_to,   (now() AT TIME ZONE 'America/Asuncion')::date);
  v_rows jsonb; v_sets jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('rows','[]'::jsonb); END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', o.id, 'restaurant', r.name, 'restaurant_id', o.restaurant_id,
           'customer_name', o.customer_name, 'delivery_address', o.delivery_address,
           'order_total', o.order_total, 'delivery_fee', o.delivery_fee,
           'picked_up_at', o.picked_up_at, 'delivered_at', o.delivered_at,
           'minutes', CASE WHEN o.picked_up_at IS NOT NULL AND o.delivered_at IS NOT NULL
                           THEN round(EXTRACT(EPOCH FROM (o.delivered_at - o.picked_up_at))/60.0)
                           END,
           'pay', CASE WHEN p.pay_type = 'pct'
                       THEN round(COALESCE(o.order_total,0) * COALESCE(p.pay_value,0) / 100.0)
                       WHEN p.pay_type = 'fixed' THEN COALESCE(p.pay_value,0)
                       WHEN dr.commission_type = 'pct'
                       THEN round(COALESCE(o.order_total,0) * COALESCE(dr.commission_value,0) / 100.0)
                       WHEN dr.commission_type = 'fixed' THEN COALESCE(dr.commission_value,0)
                       END
         ) ORDER BY o.delivered_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM public.delivery_orders o
    JOIN public.delivery_riders dr ON dr.id = o.rider_id
    JOIN public.restaurants     r  ON r.id  = o.restaurant_id
    LEFT JOIN public.mythos_delivery_partners p ON p.restaurant_id = o.restaurant_id
   WHERE dr.user_id = v_uid AND o.rider_status = 'delivered'
     AND (o.delivered_at AT TIME ZONE 'America/Asuncion')::date BETWEEN v_f AND v_t;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', s.id, 'restaurant', r.name, 'period_from', s.period_from,
           'period_to', s.period_to, 'deliveries', s.deliveries, 'amount', s.amount,
           'method', s.method, 'status', s.status, 'paid_at', s.paid_at
         ) ORDER BY s.period_to DESC), '[]'::jsonb)
    INTO v_sets
    FROM public.mythos_rider_settlements s
    JOIN public.restaurants r ON r.id = s.restaurant_id
   WHERE s.rider_id = v_id;

  RETURN jsonb_build_object('from', v_f, 'to', v_t, 'rows', v_rows, 'settlements', v_sets);
END;
$$;

REVOKE ALL ON FUNCTION public.rider_my_history(date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rider_my_history(date,date) TO authenticated;


CREATE OR REPLACE FUNCTION public.rider_mark_notifications_read()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_id UUID := public.my_mythos_rider_id();
BEGIN
  IF v_id IS NULL THEN RETURN jsonb_build_object('ok', false); END IF;
  UPDATE public.mythos_rider_notifications SET read_at = now()
   WHERE rider_id = v_id AND read_at IS NULL;
  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.rider_mark_notifications_read() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rider_mark_notifications_read() TO authenticated;


CREATE OR REPLACE FUNCTION public.rider_mark_training_done()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_id UUID := public.my_mythos_rider_id();
BEGIN
  IF v_id IS NULL THEN RETURN jsonb_build_object('ok', false); END IF;
  UPDATE public.mythos_riders
     SET training_done_at = COALESCE(training_done_at, now()),
         -- La capacitación completa el trámite de alguien YA aprobado; no
         -- aprueba a nadie por su cuenta.
         status = CASE WHEN status = 'aprobado' THEN 'activo' ELSE status END,
         status_changed_at = CASE WHEN status = 'aprobado' THEN now() ELSE status_changed_at END,
         updated_at = now()
   WHERE id = v_id;
  RETURN jsonb_build_object('ok', true,
    'status', (SELECT status FROM public.mythos_riders WHERE id = v_id));
END;
$$;

REVOKE ALL ON FUNCTION public.rider_mark_training_done() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rider_mark_training_done() TO authenticated;


-- Exponer las RPC nuevas de inmediato.
NOTIFY pgrst, 'reload schema';

COMMIT;
