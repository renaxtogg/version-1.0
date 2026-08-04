-- ════════════════════════════════════════════════════════════════════════
-- 200 · COMENSAL — identidad, experiencia (XP), reseñas verificadas,
--       reputación, insignias, colecciones, retos y app /clientes
-- ────────────────────────────────────────────────────────────────────────
-- [PARA PEGAR EN SUPABASE]  ·  rol postgres, SQL Editor en INGLÉS.
-- Implementa `docs/design/identidad-comensal-app-clientes.md` (aprobado
-- 2026-08-03) y lo que Renato sumó encima: reputación gastronómica.
--
-- EL EJE NUEVO DEL MODELO
--   hoy:    plataforma → restaurante → datos   (todo dato tiene dueño)
--   acá:    plataforma → persona     → N restaurantes
-- Un comensal no pertenece a ningún local: los atraviesa. Por eso esta capa
-- va ARRIBA de `customers` y no la modifica: tocar `customers` rompería el
-- CRM, su RLS y las migs 196/197.
--
-- QUÉ NO HACE (garantía de que no rompe nada — §7 del diseño)
--   • NO modifica customers, orders, user_roles, auth.users ni restaurants.
--     (la única excepción es REEMPLAZAR create_order para que acepte
--      `payload.diner_token`; el resto de su cuerpo queda igual y sin el
--      campo se comporta exactamente como hoy).
--   • NO agrega ningún rol 'cliente' a user_roles. NUNCA. get_my_role()
--     (mig 029) devuelve UN rol con LIMIT 1 y de él cuelga la RLS de ~25
--     tablas: un rol nuevo empatado en el ELSE 3 dejaría indefinido cuál
--     gana. La identidad de comensal vive SOLO en `diners`.
--   • NO vincula nada automáticamente: el día que se aplica, las tablas
--     nuevas quedan vacías y para los registrados de hoy no cambia un campo.
--   • Es reversible: DROP de las tablas nuevas deja el sistema como estaba
--     (salvo create_order, que hay que reponer desde la mig 196).
--
-- BETA CERRADA — la app NO está abierta al público
--   `diner_app_config.is_public = false` + allowlist `diner_app_access`.
--   El portero está en la BASE (ensure_my_diner falla si no estás en la
--   lista), no sólo en el front: esconder el botón nunca es la única
--   defensa. Se siembra con los dos correos de Renato.
--
-- DOS DESVÍOS RESPECTO DEL DOCUMENTO, con su motivo:
--
--   1) `xp_ledger` lleva `diner_id` Y `customer_id` (el §4.4 pedía sólo
--      customer_id). Motivo: reseñar, subir una foto o responder el registro
--      son actos de la PERSONA y pueden ocurrir sin ficha local. Con sólo
--      customer_id ese XP no tendría dónde anotarse. Se conserva intacto lo
--      que el §4.4 buscaba —que vincular una ficha absorba el historial
--      viejo con un solo INSERT en el puente— porque el total suma las filas
--      propias MÁS las de las fichas vinculadas, sin reescribir el libro.
--
--   2) El QR de mesa y el delivery NO comparten el storageKey de sesión con
--      /clientes (el §5.2 lo proponía). Motivo verificado en el código: la
--      policy `mi_auth_select` de menu_items (mig 086) exige
--      `restaurant_id = get_my_restaurant_id()`, y un comensal autenticado
--      NO tiene fila en user_roles → esa función devuelve NULL → el menú
--      sale VACÍO. Compartir la sesión rompería el pedido, que es lo único
--      que no se puede romper. En su lugar el Camino A viaja por
--      `diner_link_tokens` (kind='device'): el panel del QR sigue corriendo
--      como anon y manda el token dentro del payload de create_order.
--
-- Todo ADITIVO e idempotente. Sin aplicar: /clientes muestra "app no
-- disponible" y el resto del sistema no cambia en nada.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- 0) CONFIGURACIÓN DE LA APP + PORTERO DE LA BETA
-- ════════════════════════════════════════════════════════════════════════
-- Fila única (id=true). Mismo molde que marketing_config (mig 110):
-- lectura pública, escritura sólo de superadmin.
CREATE TABLE IF NOT EXISTS public.diner_app_config (
  id                    BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),

  -- Portero. false = sólo los correos de diner_app_access pueden entrar.
  is_public             BOOLEAN NOT NULL DEFAULT false,
  closed_message        TEXT NOT NULL DEFAULT 'La app de comensales está en pruebas cerradas. Pronto la abrimos.',

  -- Módulos: cada uno se prende por separado desde el superadmin.
  reviews_enabled       BOOLEAN NOT NULL DEFAULT true,
  photos_enabled        BOOLEAN NOT NULL DEFAULT true,
  ranking_enabled       BOOLEAN NOT NULL DEFAULT true,
  badges_enabled        BOOLEAN NOT NULL DEFAULT true,
  collections_enabled   BOOLEAN NOT NULL DEFAULT true,
  challenges_enabled    BOOLEAN NOT NULL DEFAULT true,
  discovery_enabled     BOOLEAN NOT NULL DEFAULT true,

  -- Reseñas
  review_min_chars      INT NOT NULL DEFAULT 0,      -- 0 = comentario opcional
  review_max_photos     INT NOT NULL DEFAULT 4,
  review_edit_hours     INT NOT NULL DEFAULT 24,     -- ventana para corregir
  review_auto_approve   BOOLEAN NOT NULL DEFAULT true,   -- false = cola de moderación
  photo_auto_approve    BOOLEAN NOT NULL DEFAULT false,  -- la foto SIEMPRE conviene mirarla

  -- Índice de credibilidad: los pesos son configurables porque son un juicio
  -- de negocio, no una constante. Cada componente aporta como máximo su peso.
  cred_w_orders         NUMERIC NOT NULL DEFAULT 25,  -- pedidos verificados
  cred_w_diversity      NUMERIC NOT NULL DEFAULT 20,  -- restaurantes distintos
  cred_w_helpful        NUMERIC NOT NULL DEFAULT 25,  -- votos útiles recibidos
  cred_w_photos         NUMERIC NOT NULL DEFAULT 10,  -- fotos aprobadas
  cred_w_age            NUMERIC NOT NULL DEFAULT 10,  -- antigüedad de la cuenta
  cred_w_consistency    NUMERIC NOT NULL DEFAULT 10,  -- meses con actividad
  cred_full_orders      INT NOT NULL DEFAULT 60,      -- cuántos pedidos "llenan" ese componente
  cred_full_diversity   INT NOT NULL DEFAULT 20,
  cred_full_helpful     INT NOT NULL DEFAULT 80,
  cred_full_photos      INT NOT NULL DEFAULT 30,
  cred_full_age_days    INT NOT NULL DEFAULT 730,
  cred_full_months      INT NOT NULL DEFAULT 12,
  cred_min_percent      INT NOT NULL DEFAULT 5,       -- piso: nadie arranca en 0

  -- La reseña pesa en la nota del restaurante según nivel × credibilidad.
  -- Con esto en false, todas las reseñas pesan 1 (promedio simple).
  weighted_rating_enabled BOOLEAN NOT NULL DEFAULT true,

  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.diner_app_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.diner_app_config IS
  'Config global de la app de comensales (/clientes). Fila única. is_public=false ⇒ beta cerrada por allowlist. Se edita en Superadmin › Comensales.';

-- ── Allowlist de la beta ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.diner_app_access (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL,
  note       TEXT,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  added_by   UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_diner_app_access_email
  ON public.diner_app_access (lower(btrim(email)));

-- Los dos correos de Renato. Ya tienen perfil de admin/superadmin: por §8.1
-- del diseño eso NO estorba — el perfil de comensal convive con un rol de
-- negocio en la misma cuenta porque `diners` no usa get_my_role().
INSERT INTO public.diner_app_access (email, note) VALUES
  ('mancuellorenato@gmail.com',  'Renato — cuenta oficial protegida'),
  ('mancuelloempresas@gmail.com','Renato — cuenta de empresas')
ON CONFLICT (lower(btrim(email))) DO NOTHING;

COMMENT ON TABLE public.diner_app_access IS
  'Allowlist de la beta cerrada de /clientes. Con diner_app_config.is_public=false, sólo estos correos pueden crear perfil de comensal.';

-- ════════════════════════════════════════════════════════════════════════
-- 1) LA PERSONA
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.diners (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id      UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name      TEXT,
  email             TEXT,                 -- copia desnormalizada de auth.users
  email_verified_at TIMESTAMPTZ,
  avatar_url        TEXT,
  bio               TEXT,
  city              TEXT,                 -- para el ranking por ciudad
  department        TEXT,                 -- para el ranking por departamento
  birth_date        DATE,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','pending_recovery')),
  onboarded_at      TIMESTAMPTZ,          -- terminó el registro de gustos
  last_seen_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_diners_city   ON public.diners (lower(city));
CREATE INDEX IF NOT EXISTS idx_diners_status ON public.diners (status);

COMMENT ON TABLE public.diners IS
  'La PERSONA, por encima de los restaurantes. Es el dato más sensible de la plataforma: concentra nombre, correo y hábitos de todos los comensales. El staff de un local NO la ve (ver RLS).';

-- ── Teléfonos ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.diner_phones (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diner_id     UUID NOT NULL REFERENCES public.diners(id) ON DELETE CASCADE,
  phone        TEXT NOT NULL,
  phone_digits TEXT GENERATED ALWAYS AS
                 (regexp_replace(coalesce(phone,''), '\D', '', 'g')) STORED,
  is_primary   BOOLEAN NOT NULL DEFAULT false,
  verified_at  TIMESTAMPTZ,
  released_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- El índice PARCIAL es el corazón del diseño (§4.2): implementa a la vez la
-- unicidad, los candidatos sin verificar y el reciclado de números por la
-- operadora. Un número verificado y vigente es de una sola persona; los no
-- verificados y los liberados no bloquean a nadie.
CREATE UNIQUE INDEX IF NOT EXISTS ux_diner_phones_active
  ON public.diner_phones (phone_digits)
  WHERE verified_at IS NOT NULL AND released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_diner_phones_diner  ON public.diner_phones (diner_id);
CREATE INDEX IF NOT EXISTS idx_diner_phones_digits ON public.diner_phones (phone_digits);

-- ── El puente persona ↔ ficha local ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.diner_customer_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diner_id      UUID NOT NULL REFERENCES public.diners(id)      ON DELETE CASCADE,
  customer_id   UUID NOT NULL REFERENCES public.customers(id)   ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  linked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  linked_via    TEXT NOT NULL
                CHECK (linked_via IN ('order_claim','counter_claim','phone_otp','manual_support')),
  UNIQUE (diner_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_dcl_diner ON public.diner_customer_links (diner_id);
CREATE INDEX IF NOT EXISTS idx_dcl_cust  ON public.diner_customer_links (customer_id);

COMMENT ON COLUMN public.diner_customer_links.restaurant_id IS
  'Desnormalizado a propósito: la RLS no puede pagar un join a customers en cada fila.';

-- ── Tokens de vinculación (Camino A y Camino B del §5.2) ───────────────
-- Una sola tabla para los dos caminos, porque son el mismo hecho: "probá que
-- sos vos" sin gastar un guaraní en SMS.
--   kind='device'  → token largo, 30 días, multiuso. Lo escribe /clientes en
--                    localStorage y lo manda el QR/delivery dentro de
--                    create_order. Verificación: es el mismo dispositivo.
--   kind='counter' → código de 6 dígitos, 10 min, un solo uso. La persona se
--                    lo dicta al cajero. Verificación: presencia física, que
--                    acá es más fuerte que un SMS (el cajero la está mirando).
CREATE TABLE IF NOT EXISTS public.diner_link_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diner_id    UUID NOT NULL REFERENCES public.diners(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('device','counter')),
  token       TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_diner_link_tokens_token ON public.diner_link_tokens (token);
CREATE INDEX IF NOT EXISTS idx_diner_link_tokens_diner ON public.diner_link_tokens (diner_id, kind);
-- Un solo código de mostrador vivo por persona: si pide otro, el anterior muere.
CREATE UNIQUE INDEX IF NOT EXISTS ux_diner_counter_live
  ON public.diner_link_tokens (diner_id)
  WHERE kind = 'counter' AND used_at IS NULL AND revoked_at IS NULL;

-- ── Recuperación de cuenta (la salida de emergencia, §4.5) ─────────────
CREATE TABLE IF NOT EXISTS public.diner_recovery_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diner_id      UUID REFERENCES public.diners(id) ON DELETE SET NULL,
  claimed_email TEXT,
  claimed_phone TEXT,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected')),
  reviewed_by   UUID,
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.diner_recovery_requests IS
  'Va desde el día uno: sin esto, quien pierde todos sus canales queda encerrado y te enterás por un reclamo.';

-- ════════════════════════════════════════════════════════════════════════
-- 2) EXPERIENCIA — reglas, niveles y libro
-- ════════════════════════════════════════════════════════════════════════
-- Ninguna regla de XP va cableada en el código. Las dos tablas se
-- administran desde Superadmin › Comensales › Experiencia.
CREATE TABLE IF NOT EXISTS public.xp_rules (
  code          TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  description   TEXT,
  xp_fixed      INT     NOT NULL DEFAULT 0,   -- XP fijo por evento
  xp_per_1000   NUMERIC NOT NULL DEFAULT 0,   -- XP por cada ₲1.000 gastados
  xp_per_unit   INT     NOT NULL DEFAULT 0,   -- XP por unidad (dimensión, foto…)
  per_event_cap INT,                          -- tope por evento (NULL = sin tope)
  daily_cap     INT,                          -- techo diario (NULL = sin techo)
  is_active     BOOLEAN NOT NULL DEFAULT true,
  sort_order    INT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.xp_rules.daily_cap IS
  'No es un detalle: sin techo, el XP por gasto convierte al que más gasta en el que más influye sobre el ranking.';

CREATE TABLE IF NOT EXISTS public.xp_levels (
  level         INT PRIMARY KEY,
  name          TEXT NOT NULL,       -- el TÍTULO: Novato, Explorador, Catador…
  min_xp        INT  NOT NULL,
  review_weight NUMERIC NOT NULL DEFAULT 1,   -- el "poder de crítica"
  perks         JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.xp_levels.review_weight IS
  'Cuánto pesa la reseña de alguien de este nivel en la nota del restaurante. Es el "poder de crítica" del diseño.';

-- El libro. SÓLO DE SUMA: no hay redeem, no hay saldo que baje. Una
-- corrección se hace con una fila negativa (rule_code='adjust'), nunca
-- borrando — si no, el historial deja de ser auditable.
CREATE TABLE IF NOT EXISTS public.xp_ledger (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Desvío documentado arriba: llevan los DOS. Una acción de la app (reseña,
  -- foto, registro) es de la persona y puede no tener ficha local.
  diner_id          UUID REFERENCES public.diners(id)            ON DELETE CASCADE,
  customer_id       UUID REFERENCES public.customers(id)         ON DELETE CASCADE,
  restaurant_id     UUID REFERENCES public.restaurants(id)       ON DELETE CASCADE,
  order_id          UUID REFERENCES public.orders(id)            ON DELETE SET NULL,
  delivery_order_id UUID REFERENCES public.delivery_orders(id)   ON DELETE SET NULL,
  review_id         UUID,
  xp                INT  NOT NULL,
  rule_code         TEXT NOT NULL,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT xp_ledger_has_owner CHECK (diner_id IS NOT NULL OR customer_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_xp_diner ON public.xp_ledger (diner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_xp_cust  ON public.xp_ledger (customer_id);
CREATE INDEX IF NOT EXISTS idx_xp_rest  ON public.xp_ledger (restaurant_id);

-- Idempotencia: un pedido acredita XP UNA sola vez, se corra el backfill las
-- veces que se corra. Es lo que hace seguro re-ejecutar esta migración.
CREATE UNIQUE INDEX IF NOT EXISTS ux_xp_order
  ON public.xp_ledger (order_id, rule_code) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_xp_delivery
  ON public.xp_ledger (delivery_order_id, rule_code) WHERE delivery_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_xp_review
  ON public.xp_ledger (review_id, rule_code) WHERE review_id IS NOT NULL;

-- Sin FK de rule_code → xp_rules a propósito: si la hubiera, borrar una regla
-- desde el superadmin quedaría bloqueada por el historial (o peor, lo
-- arrastraría en cascada). El libro es un registro contable: sobrevive a que
-- la regla que lo originó deje de existir.

-- ── Seed de reglas (los números que definió Renato el 2026-08-03) ──────
-- Nota: el borrador §11.2 del documento manejaba otra escala (reseña 1.000 /
-- dimensión 100 / foto 300). Se siembra con la lista de Renato, que es
-- posterior y self-consistente. Cambiar de escala es un renglón en
-- Superadmin › Comensales › Experiencia, no una migración.
INSERT INTO public.xp_rules (code, label, description, xp_fixed, xp_per_unit, per_event_cap, daily_cap, sort_order) VALUES
  ('first_order',     'Primer pedido',                'Una sola vez en la vida de la cuenta.',                   50,   0, NULL, NULL,  1),
  ('order_dine_in',   'Comer en el local',            'Pedido con servicio en mesa o mostrador.',                30,   0, NULL,  120,  2),
  ('order_pickup',    'Retiro en el local (pickup)',  'Pedido para llevar.',                                     20,   0, NULL,  120,  3),
  ('order_delivery',  'Delivery',                     'Pedido a domicilio.',                                     20,   0, NULL,  120,  4),
  ('new_restaurant',  'Restaurante nuevo visitado',   'Primera vez que pedís en ese local.',                     70,   0, NULL, NULL,  5),
  ('review',          'Reseña verificada',            'Base + XP por cada dimensión calificada (completitud).',  80,  10,  200,  400,  6),
  ('review_photo',    'Foto aprobada',                'Por cada foto que pasa moderación.',                       0,  40,  120,  240,  7),
  ('helpful_vote',    'Voto útil recibido',           'Otro comensal marcó tu reseña como útil.',                 0,   5, NULL,  100,  8),
  ('survey',          'Registro de gustos',           'Responder el cuestionario de preferencias.',              15,   0, NULL, NULL,  9),
  ('badge',           'Insignia desbloqueada',        'El XP lo define cada insignia.',                           0,   0, NULL, NULL, 10),
  ('challenge',       'Reto completado',              'El XP lo define cada reto.',                               0,   0, NULL, NULL, 11),
  ('adjust',          'Ajuste manual',                'Corrección de soporte. Puede ser negativo.',               0,   0, NULL, NULL, 99)
ON CONFLICT (code) DO NOTHING;

-- ── Seed de niveles ─────────────────────────────────────────────────────
-- 30 niveles numéricos con 8 títulos: el número da progresión constante
-- ("Nivel 18") y el título da identidad ("Crítico"). Editable entero.
INSERT INTO public.xp_levels (level, name, min_xp, review_weight) VALUES
  ( 1,'Novato',                     0, 1.00),
  ( 2,'Novato',                   150, 1.00),
  ( 3,'Novato',                   400, 1.05),
  ( 4,'Explorador',               800, 1.10),
  ( 5,'Explorador',              1400, 1.15),
  ( 6,'Explorador',              2200, 1.20),
  ( 7,'Explorador',              3200, 1.25),
  ( 8,'Catador',                 4500, 1.35),
  ( 9,'Catador',                 6000, 1.42),
  (10,'Catador',                 7800, 1.50),
  (11,'Catador',                 9900, 1.58),
  (12,'Crítico',                12300, 1.70),
  (13,'Crítico',                15000, 1.78),
  (14,'Crítico',                18000, 1.86),
  (15,'Crítico',                21500, 1.95),
  (16,'Experto',                25500, 2.05),
  (17,'Experto',                30000, 2.12),
  (18,'Experto',                35000, 2.20),
  (19,'Experto',                40500, 2.28),
  (20,'Inspector',              46500, 2.40),
  (21,'Inspector',              53000, 2.47),
  (22,'Inspector',              60000, 2.54),
  (23,'Inspector',              67500, 2.62),
  (24,'Embajador',              75500, 2.72),
  (25,'Embajador',              84000, 2.79),
  (26,'Embajador',              93000, 2.86),
  (27,'Embajador',             102500, 2.93),
  (28,'Leyenda Gastronómica',  112500, 3.00),
  (29,'Leyenda Gastronómica',  123000, 3.00),
  (30,'Leyenda Gastronómica',  134000, 3.00)
ON CONFLICT (level) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════
-- 3) RESEÑAS VERIFICADAS Y MULTIDIMENSIONALES
-- ════════════════════════════════════════════════════════════════════════
-- Las dimensiones son un CATÁLOGO, no una lista cableada: cada cambio de
-- criterio pediría una migración si no (§11.2 del diseño). Son de plataforma
-- (iguales para todos los locales) para que la nota sea comparable.
CREATE TABLE IF NOT EXISTS public.review_dimensions (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  emoji       TEXT,
  description TEXT,
  applies_to  TEXT NOT NULL DEFAULT 'all'
              CHECK (applies_to IN ('all','dine_in','delivery','pickup')),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  sort_order  INT NOT NULL DEFAULT 0
);

INSERT INTO public.review_dimensions (code, label, emoji, description, applies_to, sort_order) VALUES
  ('comida',       'Calidad de la comida', '🍽',  'El sabor y el punto.',                       'all',      1),
  ('presentacion', 'Presentación',         '✨',  'Cómo llegó el plato.',                       'all',      2),
  ('atencion',     'Atención',             '🙋',  'El trato del personal.',                     'all',      3),
  ('tiempo',       'Tiempo de espera',     '⏱',  'Cuánto tardó.',                              'all',      4),
  ('precio',       'Relación precio',      '💵',  'Si valió lo que costó.',                     'all',      5),
  ('limpieza',     'Limpieza',             '🧼',  'Del salón, la mesa y el baño.',              'dine_in',  6),
  ('ambiente',     'Ambiente',             '🎵',  'Música, luz, comodidad.',                    'dine_in',  7),
  ('delivery',     'Delivery',             '🛵',  'El repartidor y el estado en que llegó.',    'delivery', 8)
ON CONFLICT (code) DO NOTHING;

-- ── La reseña ───────────────────────────────────────────────────────────
-- ANTIFRAUDE (§3.2): para reseñar hace falta un PEDIDO PAGADO en ese local, y
-- una sola reseña por pedido. Las cuentas falsas siguen siendo gratis; las
-- reseñas falsas pasan a costar cenas reales. Es lo que Google Maps
-- estructuralmente no puede hacer, porque no ve la transacción. Y acá importa
-- más que en cualquier otra plataforma: Google no le cobra suscripción al
-- restaurante que rankea; Mythos sí. Si a un cliente que paga lo hunden con
-- reseñas falsas, el reclamo viene a Mythos.
CREATE TABLE IF NOT EXISTS public.diner_reviews (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diner_id          UUID NOT NULL REFERENCES public.diners(id)      ON DELETE CASCADE,
  restaurant_id     UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  customer_id       UUID REFERENCES public.customers(id)            ON DELETE SET NULL,
  order_id          UUID REFERENCES public.orders(id)               ON DELETE SET NULL,
  delivery_order_id UUID REFERENCES public.delivery_orders(id)      ON DELETE SET NULL,

  service_type      TEXT NOT NULL DEFAULT 'dine_in'
                    CHECK (service_type IN ('dine_in','delivery','pickup')),
  stars             INT  NOT NULL CHECK (stars BETWEEN 1 AND 5),   -- nota general
  comment           TEXT,

  status            TEXT NOT NULL DEFAULT 'approved'
                    CHECK (status IN ('pending','approved','rejected','hidden')),
  moderation_note   TEXT,
  moderated_by      UUID,
  moderated_at      TIMESTAMPTZ,

  -- Contadores denormalizados: la lista de reseñas se ordena por utilidad y
  -- no puede pagar un COUNT por fila.
  helpful_count     INT NOT NULL DEFAULT 0,
  detailed_count    INT NOT NULL DEFAULT 0,
  decided_count     INT NOT NULL DEFAULT 0,

  -- Peso con el que entró en la nota del local (nivel × credibilidad),
  -- congelado al publicar: recalcularlo cambiaría notas viejas al azar.
  weight            NUMERIC NOT NULL DEFAULT 1,

  restaurant_reply  TEXT,
  replied_at        TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Una reseña por pedido. Índices parciales porque un pedido de salón no tiene
-- delivery_order_id y viceversa.
CREATE UNIQUE INDEX IF NOT EXISTS ux_review_order
  ON public.diner_reviews (order_id) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_review_delivery
  ON public.diner_reviews (delivery_order_id) WHERE delivery_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reviews_rest  ON public.diner_reviews (restaurant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_diner ON public.diner_reviews (diner_id, created_at DESC);

-- Puntaje por dimensión
CREATE TABLE IF NOT EXISTS public.diner_review_scores (
  review_id UUID NOT NULL REFERENCES public.diner_reviews(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL REFERENCES public.review_dimensions(code) ON DELETE CASCADE,
  stars     INT  NOT NULL CHECK (stars BETWEEN 1 AND 5),
  PRIMARY KEY (review_id, dimension)
);

-- Fotos (moderadas de a una: una foto es lo que más rápido puede arruinar
-- la reputación de un local, y también lo que más ayuda a decidir)
CREATE TABLE IF NOT EXISTS public.diner_review_photos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id   UUID NOT NULL REFERENCES public.diner_reviews(id) ON DELETE CASCADE,
  diner_id    UUID NOT NULL REFERENCES public.diners(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  caption     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','approved','rejected')),
  moderated_by UUID,
  moderated_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_review_photos_review ON public.diner_review_photos (review_id);
CREATE INDEX IF NOT EXISTS idx_review_photos_status ON public.diner_review_photos (status) WHERE status = 'pending';

-- Utilidad: otros comensales marcan la reseña. Sube la reputación del crítico.
CREATE TABLE IF NOT EXISTS public.diner_review_votes (
  review_id UUID NOT NULL REFERENCES public.diner_reviews(id) ON DELETE CASCADE,
  diner_id  UUID NOT NULL REFERENCES public.diners(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL CHECK (kind IN ('helpful','detailed','decided')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, diner_id, kind)
);

-- ════════════════════════════════════════════════════════════════════════
-- 4) INSIGNIAS, COLECCIONES Y RETOS
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.diner_badges_catalog (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  emoji         TEXT NOT NULL DEFAULT '🏅',
  description   TEXT,
  -- Qué se mide para ganarla.
  criteria_type TEXT NOT NULL
                CHECK (criteria_type IN ('orders_total','restaurants_total','reviews_total',
                                         'photos_total','helpful_total','level',
                                         'orders_by_type','restaurants_by_type','restaurants_by_city')),
  criteria_value  INT NOT NULL DEFAULT 1,
  match_types     TEXT[] NOT NULL DEFAULT '{}',   -- restaurants.business_type a matchear
  match_city      TEXT,
  xp_reward       INT NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.diner_badges_catalog IS
  'Catálogo de insignias, editable en Superadmin › Comensales › Insignias. Se llama _catalog para no chocar con un futuro `badges` de otro dominio.';

CREATE TABLE IF NOT EXISTS public.diner_badges (
  diner_id  UUID NOT NULL REFERENCES public.diners(id) ON DELETE CASCADE,
  badge_id  UUID NOT NULL REFERENCES public.diner_badges_catalog(id) ON DELETE CASCADE,
  earned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (diner_id, badge_id)
);

INSERT INTO public.diner_badges_catalog (code, name, emoji, description, criteria_type, criteria_value, match_types, xp_reward, sort_order) VALUES
  ('primer_pedido',   'Primer pedido',          '🎉', 'Rompiste el hielo.',                         'orders_total',       1,  '{}', 50,  1),
  ('diez_pedidos',    '10 pedidos',             '🔟', 'Ya sos de la casa.',                         'orders_total',      10,  '{}', 120, 2),
  ('cien_pedidos',    '100 pedidos',            '💯', 'Cien veces elegiste bien.',                  'orders_total',     100,  '{}', 800, 3),
  ('diez_locales',    '10 restaurantes',        '🗺', 'Diez lugares distintos.',                    'restaurants_total', 10,  '{}', 200, 4),
  ('cien_resenas',    '100 reseñas',            '📝', 'Tu opinión ya mueve la aguja.',              'reviews_total',    100,  '{}', 900, 5),
  ('cincuenta_fotos', '50 fotos',               '📸', 'Cincuenta fotos aprobadas.',                 'photos_total',      50,  '{}', 500, 6),
  ('experto_pizza',   'Experto en pizzas',      '🍕', 'Cinco pizzerías distintas.',                 'restaurants_by_type', 5, '{pizzeria,pizzería,pizza}', 150, 7),
  ('maestro_burger',  'Maestro Hamburguesero',  '🍔', 'Cinco hamburgueserías distintas.',           'restaurants_by_type', 5, '{hamburgueseria,hamburguesería,burger}', 150, 8),
  ('amante_cafe',     'Amante del Café',        '☕', 'Cinco cafeterías distintas.',                'restaurants_by_type', 5, '{cafeteria,cafetería,cafe,café}', 150, 9),
  ('parrillas',       'Especialista en Parrillas','🥩','Cinco parrillas distintas.',                'restaurants_by_type', 5, '{parrilla,parrillada,asador}', 150, 10),
  ('fan_sushi',       'Fan del Sushi',          '🍣', 'Cinco lugares de sushi.',                    'restaurants_by_type', 5, '{sushi,japonesa,japones,japonés}', 150, 11),
  ('mexicana',        'Comida Mexicana',        '🌮', 'Cinco mexicanos distintos.',                 'restaurants_by_type', 5, '{mexicana,mexicano,tacos}', 150, 12),
  ('ramen',           'Ramen',                  '🍜', 'Cinco lugares de ramen o asiática.',         'restaurants_by_type', 5, '{ramen,asiatica,asiática,china}', 150, 13),
  ('critico_util',    'Crítico útil',           '👍', 'Cien votos útiles recibidos.',               'helpful_total',    100,  '{}', 600, 14),
  ('nivel_diez',      'Nivel 10',               '⭐', 'Llegaste al nivel 10.',                      'level',             10,  '{}', 0,   15)
ON CONFLICT (code) DO NOTHING;

-- ── Colecciones ─────────────────────────────────────────────────────────
-- "Visitaste 18 de 35 hamburgueserías". El denominador es REAL: se cuenta
-- cuántos locales activos matchean, no un número inventado.
CREATE TABLE IF NOT EXISTS public.diner_collections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  emoji       TEXT NOT NULL DEFAULT '📚',
  description TEXT,
  match_types TEXT[] NOT NULL DEFAULT '{}',
  match_city  TEXT,
  -- NULL = el total es "todos los locales que matchean" (se calcula solo).
  target_count INT,
  reward_xp   INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.diner_collections (code, name, emoji, description, match_types, reward_xp, sort_order) VALUES
  ('hamburgueserias','Hamburgueserías','🍔','Todas las hamburgueserías de Mythos.','{hamburgueseria,hamburguesería,burger}', 300, 1),
  ('pizzerias',      'Pizzerías',      '🍕','La ruta de la pizza.',                 '{pizzeria,pizzería,pizza}',              300, 2),
  ('ruta_cafe',      'Ruta del Café',  '☕','Cafeterías y casas de café.',          '{cafeteria,cafetería,cafe,café}',        300, 3),
  ('parrillas',      'Parrillas',      '🥩','Asado, brasa y punto.',                '{parrilla,parrillada,asador}',           300, 4)
ON CONFLICT (code) DO NOTHING;

-- ── Retos (semanales / mensuales) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.diner_challenges (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  emoji         TEXT NOT NULL DEFAULT '🎯',
  description   TEXT,
  period        TEXT NOT NULL DEFAULT 'month' CHECK (period IN ('week','month','once')),
  goal_type     TEXT NOT NULL
                CHECK (goal_type IN ('orders','restaurants','reviews','photos','restaurants_by_type')),
  goal_value    INT NOT NULL DEFAULT 1,
  match_types   TEXT[] NOT NULL DEFAULT '{}',
  reward_xp     INT NOT NULL DEFAULT 0,
  reward_badge_id UUID REFERENCES public.diner_badges_catalog(id) ON DELETE SET NULL,
  reward_text   TEXT,
  starts_at     TIMESTAMPTZ,
  ends_at       TIMESTAMPTZ,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  sort_order    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- period_key ('2026-W32' / '2026-08' / 'once') hace el reclamo idempotente
-- por período: correr el motor dos veces no reparte dos veces.
CREATE TABLE IF NOT EXISTS public.diner_challenge_claims (
  diner_id     UUID NOT NULL REFERENCES public.diners(id) ON DELETE CASCADE,
  challenge_id UUID NOT NULL REFERENCES public.diner_challenges(id) ON DELETE CASCADE,
  period_key   TEXT NOT NULL,
  claimed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (diner_id, challenge_id, period_key)
);

INSERT INTO public.diner_challenges (code, name, emoji, description, period, goal_type, goal_value, match_types, reward_xp, sort_order) VALUES
  ('cafes_mes',    'Ruta del café',      '☕','Visitá 5 cafeterías este mes.',        'month','restaurants_by_type', 5, '{cafeteria,cafetería,cafe,café}', 400, 1),
  ('explorador_mes','Explorador del mes','🧭','Pedí en 3 restaurantes nuevos.',       'month','restaurants',        3, '{}',                              350, 2),
  ('critico_semana','Crítico de la semana','📝','Escribí 3 reseñas esta semana.',     'week', 'reviews',            3, '{}',                              200, 3)
ON CONFLICT (code) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════
-- 5) REGISTRO DE GUSTOS — cuestionario configurable + respuestas
-- ════════════════════════════════════════════════════════════════════════
-- El alta no puede ser sólo "nombre y correo": lo que el local necesita saber
-- es qué come esta persona. Las preguntas son DATOS, no código, para poder
-- cambiarlas sin migración — igual que FORM_SPECS de la mig 198, pero acá el
-- catálogo vive en la base porque el formulario lo dibuja la app.
CREATE TABLE IF NOT EXISTS public.diner_profile_questions (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  help        TEXT,
  kind        TEXT NOT NULL DEFAULT 'multi'
              CHECK (kind IN ('single','multi','text','number','date','scale')),
  options     JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{value,label,emoji}]
  is_required BOOLEAN NOT NULL DEFAULT false,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  step        INT NOT NULL DEFAULT 1,               -- pantalla del wizard
  sort_order  INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.diner_profile_answers (
  diner_id   UUID NOT NULL REFERENCES public.diners(id) ON DELETE CASCADE,
  code       TEXT NOT NULL REFERENCES public.diner_profile_questions(code) ON DELETE CASCADE,
  value      JSONB NOT NULL,                        -- string | number | array
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (diner_id, code)
);

-- Seed: el cuestionario estándar de las plataformas gastronómicas (cocinas,
-- restricciones, picante, ticket habitual, ocasión, compañía, momento,
-- frecuencia, canal y descubrimiento). Todo editable desde el superadmin.
INSERT INTO public.diner_profile_questions (code, label, help, kind, options, is_required, step, sort_order) VALUES
  ('cocinas', 'Qué cocinas te gustan', 'Elegí todas las que quieras.', 'multi',
   '[{"value":"hamburguesas","label":"Hamburguesas","emoji":"🍔"},{"value":"pizza","label":"Pizza","emoji":"🍕"},{"value":"parrilla","label":"Parrilla / asado","emoji":"🥩"},{"value":"sushi","label":"Sushi / japonesa","emoji":"🍣"},{"value":"asiatica","label":"Asiática","emoji":"🍜"},{"value":"mexicana","label":"Mexicana","emoji":"🌮"},{"value":"italiana","label":"Italiana","emoji":"🍝"},{"value":"paraguaya","label":"Paraguaya","emoji":"🇵🇾"},{"value":"pollo","label":"Pollo / frito","emoji":"🍗"},{"value":"empanadas","label":"Empanadas","emoji":"🥟"},{"value":"vegetariana","label":"Vegetariana","emoji":"🥗"},{"value":"cafe","label":"Café / brunch","emoji":"☕"},{"value":"postres","label":"Postres / helados","emoji":"🍰"},{"value":"mariscos","label":"Pescados y mariscos","emoji":"🦐"}]'::jsonb,
   true, 1, 1),

  ('restricciones', 'Tenés alguna restricción', 'Nos sirve para no recomendarte lo que no podés comer.', 'multi',
   '[{"value":"ninguna","label":"Ninguna","emoji":"✅"},{"value":"vegetariano","label":"Vegetariano","emoji":"🥬"},{"value":"vegano","label":"Vegano","emoji":"🌱"},{"value":"sin_gluten","label":"Sin gluten / celíaco","emoji":"🌾"},{"value":"sin_lactosa","label":"Sin lactosa","emoji":"🥛"},{"value":"sin_cerdo","label":"Sin cerdo","emoji":"🚫"},{"value":"diabetes","label":"Bajo en azúcar","emoji":"🩺"},{"value":"alergia_mani","label":"Alergia al maní / frutos secos","emoji":"🥜"},{"value":"alergia_mariscos","label":"Alergia a mariscos","emoji":"🦐"}]'::jsonb,
   false, 1, 2),

  ('picante', 'Qué tan picante te gusta', NULL, 'single',
   '[{"value":"nada","label":"Nada","emoji":"🥛"},{"value":"suave","label":"Suave","emoji":"🌶"},{"value":"medio","label":"Medio","emoji":"🌶🌶"},{"value":"fuerte","label":"Fuerte","emoji":"🌶🌶🌶"}]'::jsonb,
   false, 2, 3),

  ('ticket', 'Cuánto solés gastar por persona', NULL, 'single',
   '[{"value":"h50","label":"Hasta ₲50.000"},{"value":"50a100","label":"₲50.000 a ₲100.000"},{"value":"100a200","label":"₲100.000 a ₲200.000"},{"value":"m200","label":"Más de ₲200.000"}]'::jsonb,
   false, 2, 4),

  ('canal', 'Cómo preferís pedir', 'Elegí todas las que uses.', 'multi',
   '[{"value":"local","label":"Comer en el local","emoji":"🍽"},{"value":"delivery","label":"Delivery","emoji":"🛵"},{"value":"pickup","label":"Retiro / pickup","emoji":"🥡"}]'::jsonb,
   true, 2, 5),

  ('frecuencia', 'Con qué frecuencia comés afuera o pedís', NULL, 'single',
   '[{"value":"diario","label":"Casi todos los días"},{"value":"semanal","label":"Varias veces por semana"},{"value":"quincenal","label":"Una vez por semana"},{"value":"mensual","label":"Un par de veces al mes"},{"value":"ocasional","label":"Ocasionalmente"}]'::jsonb,
   false, 3, 6),

  ('momento', 'En qué momento pedís más', NULL, 'multi',
   '[{"value":"desayuno","label":"Desayuno","emoji":"🥐"},{"value":"almuerzo","label":"Almuerzo","emoji":"🍛"},{"value":"merienda","label":"Merienda","emoji":"☕"},{"value":"cena","label":"Cena","emoji":"🌙"},{"value":"madrugada","label":"Después de medianoche","emoji":"🌃"}]'::jsonb,
   false, 3, 7),

  ('compania', 'Con quién solés comer', NULL, 'multi',
   '[{"value":"solo","label":"Solo/a","emoji":"🧍"},{"value":"pareja","label":"En pareja","emoji":"💑"},{"value":"familia","label":"En familia","emoji":"👨‍👩‍👧"},{"value":"amigos","label":"Con amigos","emoji":"🎉"},{"value":"trabajo","label":"Por trabajo","emoji":"💼"}]'::jsonb,
   false, 3, 8),

  ('ocasion', 'Qué buscás normalmente', NULL, 'multi',
   '[{"value":"rapido","label":"Algo rápido","emoji":"⚡"},{"value":"barato","label":"Buen precio","emoji":"💵"},{"value":"calidad","label":"Calidad ante todo","emoji":"⭐"},{"value":"ambiente","label":"Buen ambiente","emoji":"🎶"},{"value":"novedad","label":"Probar algo nuevo","emoji":"🧭"},{"value":"saludable","label":"Comer sano","emoji":"🥗"}]'::jsonb,
   false, 3, 9),

  ('ciudad', 'En qué ciudad estás', 'Sirve para el ranking y para mostrarte lo que tenés cerca.', 'text',
   '[]'::jsonb, true, 4, 10),

  ('cumple', 'Cuándo cumplís años', 'Los locales pueden mandarte algo ese día.', 'date',
   '[]'::jsonb, false, 4, 11),

  ('descubrimiento', 'Cómo llegaste a Mythos', NULL, 'single',
   '[{"value":"qr","label":"Escaneé un QR en un restaurante"},{"value":"amigo","label":"Me lo recomendó alguien"},{"value":"redes","label":"Redes sociales"},{"value":"google","label":"Buscando en Google"},{"value":"otro","label":"Otro"}]'::jsonb,
   false, 4, 12)
ON CONFLICT (code) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════
-- 6) FAVORITOS
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.diner_favorites (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diner_id      UUID NOT NULL REFERENCES public.diners(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  item_id       INT,                       -- NULL = el restaurante entero
  label         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_diner_fav
  ON public.diner_favorites (diner_id, restaurant_id, COALESCE(item_id, -1));

-- ════════════════════════════════════════════════════════════════════════
-- 7) updated_at automático
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.touch_diner_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_diners_touch ON public.diners;
CREATE TRIGGER trg_diners_touch BEFORE UPDATE ON public.diners
  FOR EACH ROW EXECUTE FUNCTION public.touch_diner_updated_at();

DROP TRIGGER IF EXISTS trg_reviews_touch ON public.diner_reviews;
CREATE TRIGGER trg_reviews_touch BEFORE UPDATE ON public.diner_reviews
  FOR EACH ROW EXECUTE FUNCTION public.touch_diner_updated_at();

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- 8) RLS
-- ────────────────────────────────────────────────────────────────────────
-- `diners` concentra nombre, correo, teléfonos y vínculos de TODOS los
-- comensales de la plataforma. Es el dato más sensible que Mythos va a tener
-- — bastante más que cualquier ficha local suelta.
--
--   anon               → sin acceso a NINGUNA de estas tablas.
--   comensal           → sólo lo suyo.
--   staff de un local  → SIN acceso a la identidad. Ve el XP de SU ficha y
--                        las reseñas de SU restaurante, nada más.
--   superadmin         → lectura y moderación.
--
-- Regla que hay que sostener cuando se agreguen reportes (§8.1.2): el
-- teléfono es un dato compartido entre perfiles, pero NINGUNA consulta puede
-- usarlo para correlacionarlos. Que el mozo Juan sea también comensal no
-- puede ser deducible desde ningún panel.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- Helper: mi diner_id (STABLE, se usa en casi todas las policies).
CREATE OR REPLACE FUNCTION public.my_diner_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT d.id FROM public.diners d WHERE d.auth_user_id = auth.uid() LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.my_diner_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_diner_id() TO authenticated;

ALTER TABLE public.diners                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diner_phones            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diner_customer_links    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diner_link_tokens       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diner_recovery_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.xp_ledger               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.xp_rules                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.xp_levels               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_dimensions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diner_reviews           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diner_review_scores     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diner_review_photos     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diner_review_votes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diner_badges_catalog    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diner_badges            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diner_collections       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diner_challenges        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diner_challenge_claims  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diner_profile_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diner_profile_answers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diner_favorites         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diner_app_config        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diner_app_access        ENABLE ROW LEVEL SECURITY;

-- anon: fuera de todo.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'diners','diner_phones','diner_customer_links','diner_link_tokens',
    'diner_recovery_requests','xp_ledger','xp_rules','xp_levels',
    'review_dimensions','diner_reviews','diner_review_scores','diner_review_photos',
    'diner_review_votes','diner_badges_catalog','diner_badges','diner_collections',
    'diner_challenges','diner_challenge_claims','diner_profile_questions',
    'diner_profile_answers','diner_favorites','diner_app_config','diner_app_access']
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
  END LOOP;
END$$;

-- ── Identidad: sólo su fila ────────────────────────────────────────────
DROP POLICY IF EXISTS diners_self ON public.diners;
CREATE POLICY diners_self ON public.diners
  FOR ALL TO authenticated
  USING      (auth_user_id = auth.uid() OR public.get_my_role() = 'superadmin')
  WITH CHECK (auth_user_id = auth.uid() OR public.get_my_role() = 'superadmin');

DROP POLICY IF EXISTS diner_phones_self ON public.diner_phones;
CREATE POLICY diner_phones_self ON public.diner_phones
  FOR ALL TO authenticated
  USING      (diner_id = public.my_diner_id() OR public.get_my_role() = 'superadmin')
  WITH CHECK (diner_id = public.my_diner_id() OR public.get_my_role() = 'superadmin');

DROP POLICY IF EXISTS dcl_self ON public.diner_customer_links;
CREATE POLICY dcl_self ON public.diner_customer_links
  FOR ALL TO authenticated
  USING      (diner_id = public.my_diner_id() OR public.get_my_role() = 'superadmin')
  WITH CHECK (diner_id = public.my_diner_id() OR public.get_my_role() = 'superadmin');

DROP POLICY IF EXISTS dlt_self ON public.diner_link_tokens;
CREATE POLICY dlt_self ON public.diner_link_tokens
  FOR ALL TO authenticated
  USING      (diner_id = public.my_diner_id() OR public.get_my_role() = 'superadmin')
  WITH CHECK (diner_id = public.my_diner_id() OR public.get_my_role() = 'superadmin');

DROP POLICY IF EXISTS drr_self ON public.diner_recovery_requests;
CREATE POLICY drr_self ON public.diner_recovery_requests
  FOR ALL TO authenticated
  USING      (diner_id = public.my_diner_id() OR public.get_my_role() = 'superadmin')
  WITH CHECK (diner_id = public.my_diner_id() OR public.get_my_role() = 'superadmin');

-- ── XP: el comensal ve el suyo; el local ve el de SU restaurante ───────
-- El local necesita ver el saldo de su ficha (lo usa el mostrador), pero
-- nunca la identidad global ni en qué otros locales come esa persona.
DROP POLICY IF EXISTS xp_ledger_read ON public.xp_ledger;
CREATE POLICY xp_ledger_read ON public.xp_ledger
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR diner_id = public.my_diner_id()
    OR customer_id IN (SELECT l.customer_id FROM public.diner_customer_links l
                        WHERE l.diner_id = public.my_diner_id())
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

DROP POLICY IF EXISTS xp_ledger_super ON public.xp_ledger;
CREATE POLICY xp_ledger_super ON public.xp_ledger
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- ── Catálogos: los lee cualquier autenticado, los edita el superadmin ──
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['xp_rules','xp_levels','review_dimensions',
                           'diner_badges_catalog','diner_collections',
                           'diner_challenges','diner_profile_questions']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)$p$, t || '_read', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_super', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR ALL TO authenticated
                      USING (public.get_my_role() = 'superadmin')
                      WITH CHECK (public.get_my_role() = 'superadmin')$p$, t || '_super', t);
  END LOOP;
END$$;

-- Config y allowlist: SOLO superadmin. La config la lee el comensal por RPC
-- (diner_bootstrap), no directo: si la allowlist fuera legible, cualquier
-- autenticado tendría la lista de correos de la beta.
DROP POLICY IF EXISTS diner_app_config_super ON public.diner_app_config;
CREATE POLICY diner_app_config_super ON public.diner_app_config
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

DROP POLICY IF EXISTS diner_app_access_super ON public.diner_app_access;
CREATE POLICY diner_app_access_super ON public.diner_app_access
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- ── Reseñas ────────────────────────────────────────────────────────────
-- Aprobadas: las lee cualquier comensal (son públicas dentro de la app) y el
-- local afectado. Las propias, siempre. Escritura: sólo la propia y sólo por
-- RPC verificada (el GRANT existe, pero la policy exige ser el autor).
DROP POLICY IF EXISTS reviews_read ON public.diner_reviews;
CREATE POLICY reviews_read ON public.diner_reviews
  FOR SELECT TO authenticated
  USING (
    status = 'approved'
    OR diner_id = public.my_diner_id()
    OR public.get_my_role() = 'superadmin'
    OR restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
  );

DROP POLICY IF EXISTS reviews_super ON public.diner_reviews;
CREATE POLICY reviews_super ON public.diner_reviews
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- ⚠ NO hay policy de UPDATE para el comensal ni para el restaurante, y es a
-- propósito. La RLS filtra FILAS, no COLUMNAS: una policy "el local puede
-- editar las reseñas de su restaurante" le habilitaría también `stars` y
-- `status`, o sea ponerse 5 estrellas solo. Y una "el autor edita la suya" le
-- habilitaría `status` y `weight` — aprobarse una reseña en moderación y
-- subirse el peso de su propia crítica.
-- Publicar, responder y moderar pasan por RPC (diner_submit_review,
-- restaurant_reply_review, superadmin_moderate), que escriben exactamente
-- las columnas que corresponden a cada uno.
DROP POLICY IF EXISTS reviews_own_write ON public.diner_reviews;
DROP POLICY IF EXISTS reviews_reply     ON public.diner_reviews;

DROP POLICY IF EXISTS review_scores_read ON public.diner_review_scores;
CREATE POLICY review_scores_read ON public.diner_review_scores
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.diner_reviews r WHERE r.id = review_id));

DROP POLICY IF EXISTS review_scores_super ON public.diner_review_scores;
CREATE POLICY review_scores_super ON public.diner_review_scores
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

DROP POLICY IF EXISTS review_photos_read ON public.diner_review_photos;
CREATE POLICY review_photos_read ON public.diner_review_photos
  FOR SELECT TO authenticated
  USING (
    status = 'approved'
    OR diner_id = public.my_diner_id()
    OR public.get_my_role() = 'superadmin'
    OR EXISTS (SELECT 1 FROM public.diner_reviews r
                WHERE r.id = review_id
                  AND r.restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  );

-- El comensal sube y borra sus fotos, pero NO las actualiza: con un UPDATE
-- propio se aprobaría sus fotos solo (status='approved') y cobraría el XP sin
-- pasar por moderación. Aprobar es de superadmin, por RPC.
DROP POLICY IF EXISTS review_photos_own ON public.diner_review_photos;
CREATE POLICY review_photos_own ON public.diner_review_photos
  FOR INSERT TO authenticated
  WITH CHECK (diner_id = public.my_diner_id());

DROP POLICY IF EXISTS review_photos_del ON public.diner_review_photos;
CREATE POLICY review_photos_del ON public.diner_review_photos
  FOR DELETE TO authenticated
  USING (diner_id = public.my_diner_id());

DROP POLICY IF EXISTS review_photos_super ON public.diner_review_photos;
CREATE POLICY review_photos_super ON public.diner_review_photos
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

DROP POLICY IF EXISTS review_votes_self ON public.diner_review_votes;
CREATE POLICY review_votes_self ON public.diner_review_votes
  FOR ALL TO authenticated
  USING      (diner_id = public.my_diner_id() OR public.get_my_role() = 'superadmin')
  WITH CHECK (diner_id = public.my_diner_id() OR public.get_my_role() = 'superadmin');

-- ── Logros y preferencias: sólo lo propio ──────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['diner_badges','diner_challenge_claims',
                           'diner_profile_answers','diner_favorites']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_self', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR ALL TO authenticated
                      USING (diner_id = public.my_diner_id() OR public.get_my_role() = 'superadmin')
                      WITH CHECK (diner_id = public.my_diner_id() OR public.get_my_role() = 'superadmin')$p$,
                   t || '_self', t);
  END LOOP;
END$$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- 9) FUNCIONES — alta, XP, nivel, credibilidad
-- ────────────────────────────────────────────────────────────────────────
-- Todas SECURITY DEFINER con search_path fijo (regla de la mig 195: sin eso
-- heredan el search_path del llamador y quien pueda crear objetos en public
-- shadowea una tabla sin calificar y ejecuta código como postgres).
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── El portero ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.diner_access_allowed(p_email text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_public boolean;
BEGIN
  SELECT is_public INTO v_public FROM public.diner_app_config WHERE id;
  IF COALESCE(v_public, false) THEN RETURN true; END IF;
  IF p_email IS NULL THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.diner_app_access a
     WHERE a.is_active = true
       AND lower(btrim(a.email)) = lower(btrim(p_email))
  );
END;
$$;

-- ── Nivel a partir del XP (no se guarda: se deriva) ────────────────────
-- Así, cambiar la escalera desde el superadmin recalcula a todos sin migrar
-- un solo dato.
CREATE OR REPLACE FUNCTION public.xp_level_of(p_xp int)
RETURNS TABLE (level int, name text, min_xp int, next_min_xp int, review_weight numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT l.level, l.name, l.min_xp,
         (SELECT min(n.min_xp) FROM public.xp_levels n WHERE n.min_xp > l.min_xp),
         l.review_weight
    FROM public.xp_levels l
   WHERE l.min_xp <= GREATEST(COALESCE(p_xp,0), 0)
   ORDER BY l.min_xp DESC
   LIMIT 1;
$$;

-- ── XP total de una persona ────────────────────────────────────────────
-- Suma lo anotado a su nombre MÁS lo anotado contra cualquiera de sus fichas
-- locales. Ese OR es lo que hace que vincular una ficha vieja absorba de
-- golpe todo el XP que la persona venía juntando sin saberlo (§3.6.1) con un
-- solo INSERT en el puente, sin reescribir el libro.
CREATE OR REPLACE FUNCTION public.diner_total_xp(p_diner uuid)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT COALESCE(sum(x.xp), 0)::int
    FROM public.xp_ledger x
   WHERE p_diner IS NOT NULL
     AND (x.diner_id = p_diner
       OR x.customer_id IN (SELECT l.customer_id FROM public.diner_customer_links l
                             WHERE l.diner_id = p_diner));
$$;

-- ── Acreditar XP ───────────────────────────────────────────────────────
-- Best-effort por contrato: quien la llama la envuelve en BEGIN/EXCEPTION.
-- Un fallo del libro de XP jamás puede frenar un cobro, igual que el CRM.
CREATE OR REPLACE FUNCTION public.award_xp(
  p_rule       text,
  p_diner      uuid DEFAULT NULL,
  p_customer   uuid DEFAULT NULL,
  p_restaurant uuid DEFAULT NULL,
  p_order      uuid DEFAULT NULL,
  p_delivery   uuid DEFAULT NULL,
  p_review     uuid DEFAULT NULL,
  p_units      int  DEFAULT 0,
  p_amount     numeric DEFAULT 0,
  p_note       text DEFAULT NULL
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  r        record;
  v_xp     int;
  v_today  int;
BEGIN
  IF p_diner IS NULL AND p_customer IS NULL THEN RETURN 0; END IF;

  SELECT * INTO r FROM public.xp_rules WHERE code = p_rule AND is_active = true;
  IF NOT FOUND THEN RETURN 0; END IF;

  v_xp := COALESCE(r.xp_fixed,0)
        + COALESCE(r.xp_per_unit,0) * GREATEST(COALESCE(p_units,0),0)
        + floor(COALESCE(r.xp_per_1000,0) * GREATEST(COALESCE(p_amount,0),0) / 1000.0)::int;

  IF r.per_event_cap IS NOT NULL THEN v_xp := LEAST(v_xp, r.per_event_cap); END IF;
  IF v_xp <= 0 THEN RETURN 0; END IF;

  -- Techo diario: sin esto, el que más actividad genera compra el voto más
  -- pesado sobre el ranking, que es justo lo que el diseño quiere evitar.
  IF r.daily_cap IS NOT NULL AND p_diner IS NOT NULL THEN
    SELECT COALESCE(sum(x.xp),0) INTO v_today
      FROM public.xp_ledger x
     WHERE x.diner_id = p_diner AND x.rule_code = p_rule
       AND x.created_at >= date_trunc('day', now() AT TIME ZONE 'America/Asuncion')
                           AT TIME ZONE 'America/Asuncion';
    IF v_today >= r.daily_cap THEN RETURN 0; END IF;
    v_xp := LEAST(v_xp, r.daily_cap - v_today);
    IF v_xp <= 0 THEN RETURN 0; END IF;
  END IF;

  BEGIN
    INSERT INTO public.xp_ledger (diner_id, customer_id, restaurant_id, order_id,
                                  delivery_order_id, review_id, xp, rule_code, note)
    VALUES (p_diner, p_customer, p_restaurant, p_order, p_delivery, p_review, v_xp, p_rule, p_note);
  EXCEPTION WHEN unique_violation THEN
    -- Ya estaba acreditado (los índices únicos parciales del §2). Idempotente.
    RETURN 0;
  END;

  RETURN v_xp;
END;
$$;

-- ── Índice de credibilidad ─────────────────────────────────────────────
-- No todas las opiniones deben pesar igual. Cada componente aporta como
-- máximo su peso y satura en su "full": 300 pedidos no valen 5 veces más que
-- 60, porque si no la reputación se compra con volumen.
CREATE OR REPLACE FUNCTION public.diner_credibility(p_diner uuid)
RETURNS int
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  c            record;
  v_orders     int := 0;
  v_diversity  int := 0;
  v_helpful    int := 0;
  v_photos     int := 0;
  v_age_days   int := 0;
  v_months     int := 0;
  v_score      numeric := 0;
BEGIN
  IF p_diner IS NULL THEN RETURN 0; END IF;
  SELECT * INTO c FROM public.diner_app_config WHERE id;
  IF NOT FOUND THEN RETURN 0; END IF;

  SELECT count(*), count(DISTINCT x.restaurant_id)
    INTO v_orders, v_diversity
    FROM public.xp_ledger x
   WHERE x.diner_id = p_diner
     AND x.rule_code IN ('order_dine_in','order_pickup','order_delivery');

  SELECT COALESCE(sum(r.helpful_count + r.detailed_count + r.decided_count), 0)
    INTO v_helpful
    FROM public.diner_reviews r
   WHERE r.diner_id = p_diner AND r.status = 'approved';

  SELECT count(*) INTO v_photos
    FROM public.diner_review_photos p
   WHERE p.diner_id = p_diner AND p.status = 'approved';

  SELECT GREATEST(0, EXTRACT(day FROM now() - d.created_at)::int) INTO v_age_days
    FROM public.diners d WHERE d.id = p_diner;

  SELECT count(DISTINCT date_trunc('month', x.created_at)) INTO v_months
    FROM public.xp_ledger x WHERE x.diner_id = p_diner;

  v_score :=
      c.cred_w_orders      * LEAST(1.0, v_orders    ::numeric / GREATEST(c.cred_full_orders   ,1))
    + c.cred_w_diversity   * LEAST(1.0, v_diversity ::numeric / GREATEST(c.cred_full_diversity,1))
    + c.cred_w_helpful     * LEAST(1.0, v_helpful   ::numeric / GREATEST(c.cred_full_helpful  ,1))
    + c.cred_w_photos      * LEAST(1.0, v_photos    ::numeric / GREATEST(c.cred_full_photos   ,1))
    + c.cred_w_age         * LEAST(1.0, v_age_days  ::numeric / GREATEST(c.cred_full_age_days ,1))
    + c.cred_w_consistency * LEAST(1.0, v_months    ::numeric / GREATEST(c.cred_full_months   ,1));

  RETURN GREATEST(c.cred_min_percent, LEAST(100, round(v_score)::int));
END;
$$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- 10) RPCs DE LA APP
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── Arranque: config + si puedo entrar + mi perfil si existe ───────────
CREATE OR REPLACE FUNCTION public.diner_bootstrap()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_email  text;
  v_cfg    record;
  v_diner  record;
  v_xp     int := 0;
  v_lvl    record;
BEGIN
  SELECT * INTO v_cfg FROM public.diner_app_config WHERE id;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('signed_in', false, 'allowed', false,
                              'closed_message', COALESCE(v_cfg.closed_message,''),
                              'is_public', COALESCE(v_cfg.is_public,false));
  END IF;

  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = v_uid;
  SELECT * INTO v_diner FROM public.diners WHERE auth_user_id = v_uid;

  IF FOUND THEN v_xp := public.diner_total_xp(v_diner.id); END IF;
  -- El nivel se resuelve SIEMPRE (con 0 XP da el nivel 1). plpgsql sustituye
  -- las variables como parámetros ANTES de ejecutar la consulta, así que un
  -- record sin asignar rompe aunque esté dentro de un CASE que no se evalúa.
  SELECT * INTO v_lvl FROM public.xp_level_of(v_xp);

  RETURN jsonb_build_object(
    'signed_in', true,
    'email',     v_email,
    'allowed',   public.diner_access_allowed(v_email),
    'is_public', COALESCE(v_cfg.is_public,false),
    'closed_message', COALESCE(v_cfg.closed_message,''),
    'modules', jsonb_build_object(
      'reviews',     COALESCE(v_cfg.reviews_enabled,false),
      'photos',      COALESCE(v_cfg.photos_enabled,false),
      'ranking',     COALESCE(v_cfg.ranking_enabled,false),
      'badges',      COALESCE(v_cfg.badges_enabled,false),
      'collections', COALESCE(v_cfg.collections_enabled,false),
      'challenges',  COALESCE(v_cfg.challenges_enabled,false),
      'discovery',   COALESCE(v_cfg.discovery_enabled,false)),
    'review_min_chars',  COALESCE(v_cfg.review_min_chars,0),
    'review_max_photos', COALESCE(v_cfg.review_max_photos,4),
    'diner', CASE WHEN v_diner.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id',            v_diner.id,
        'display_name',  v_diner.display_name,
        'email',         v_diner.email,
        'avatar_url',    v_diner.avatar_url,
        'city',          v_diner.city,
        'status',        v_diner.status,
        'onboarded',     v_diner.onboarded_at IS NOT NULL,
        'member_since',  to_char(v_diner.created_at, 'YYYY'),
        'xp',            v_xp,
        'level',         v_lvl.level,
        'level_name',    v_lvl.name,
        'level_min_xp',  v_lvl.min_xp,
        'next_level_xp', v_lvl.next_min_xp,
        'credibility',   public.diner_credibility(v_diner.id)) END
  );
END;
$$;

-- ── Alta / actualización del perfil ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ensure_my_diner(
  p_display_name text DEFAULT NULL,
  p_avatar_url   text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_email text;
  v_id    uuid;
  v_conf  timestamptz;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'sin sesión' USING ERRCODE='28000'; END IF;

  SELECT u.email, u.email_confirmed_at INTO v_email, v_conf FROM auth.users u WHERE u.id = v_uid;

  -- El portero vive ACÁ, no en el front. Esconder el botón nunca es la única
  -- defensa: sin esto, cualquiera con la anon key se crea perfil de comensal.
  IF NOT public.diner_access_allowed(v_email) THEN
    RAISE EXCEPTION 'La app de comensales está en pruebas cerradas.' USING ERRCODE='42501';
  END IF;

  SELECT id INTO v_id FROM public.diners WHERE auth_user_id = v_uid;
  IF v_id IS NOT NULL THEN
    UPDATE public.diners SET
      display_name = COALESCE(NULLIF(btrim(coalesce(p_display_name,'')),''), display_name),
      avatar_url   = COALESCE(NULLIF(btrim(coalesce(p_avatar_url,'')),''),   avatar_url),
      email        = COALESCE(v_email, email),
      email_verified_at = COALESCE(email_verified_at, v_conf),
      last_seen_at = now()
    WHERE id = v_id;
    RETURN v_id;
  END IF;

  INSERT INTO public.diners (auth_user_id, display_name, email, email_verified_at, avatar_url, last_seen_at)
  VALUES (v_uid,
          NULLIF(btrim(coalesce(p_display_name,'')),''),
          v_email, v_conf,
          NULLIF(btrim(coalesce(p_avatar_url,'')),''),
          now())
  ON CONFLICT (auth_user_id) DO UPDATE SET last_seen_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ── Guardar el registro de gustos ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.diner_save_profile(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_id      uuid := public.my_diner_id();
  v_answers jsonb := COALESCE(p_payload->'answers', '{}'::jsonb);
  v_key     text;
  v_first   boolean;
  v_xp      int := 0;
BEGIN
  IF v_id IS NULL THEN RAISE EXCEPTION 'sin perfil de comensal' USING ERRCODE='28000'; END IF;

  v_first := NOT EXISTS (SELECT 1 FROM public.diners WHERE id = v_id AND onboarded_at IS NOT NULL);

  UPDATE public.diners SET
    display_name = COALESCE(NULLIF(btrim(coalesce(p_payload->>'display_name','')),''), display_name),
    city         = COALESCE(NULLIF(btrim(coalesce(p_payload->>'city','')),''),         city),
    department   = COALESCE(NULLIF(btrim(coalesce(p_payload->>'department','')),''),   department),
    bio          = COALESCE(NULLIF(btrim(coalesce(p_payload->>'bio','')),''),          bio),
    birth_date   = COALESCE(NULLIF(p_payload->>'birth_date','')::date,                 birth_date),
    onboarded_at = COALESCE(onboarded_at, now())
  WHERE id = v_id;

  FOR v_key IN SELECT jsonb_object_keys(v_answers)
  LOOP
    IF EXISTS (SELECT 1 FROM public.diner_profile_questions q WHERE q.code = v_key) THEN
      INSERT INTO public.diner_profile_answers (diner_id, code, value)
      VALUES (v_id, v_key, v_answers->v_key)
      ON CONFLICT (diner_id, code) DO UPDATE
        SET value = EXCLUDED.value, updated_at = now();
    END IF;
  END LOOP;

  -- La ciudad de la respuesta manda sobre la columna (es la que el ranking usa).
  UPDATE public.diners d SET city = COALESCE(NULLIF(btrim(a.value #>> '{}'),''), d.city)
    FROM public.diner_profile_answers a
   WHERE a.diner_id = d.id AND a.code = 'ciudad' AND d.id = v_id;

  IF v_first THEN
    BEGIN v_xp := public.award_xp('survey', v_id); EXCEPTION WHEN OTHERS THEN v_xp := 0; END;
  END IF;

  RETURN jsonb_build_object('ok', true, 'xp', v_xp);
END;
$$;

-- ── Tokens de vinculación ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.diner_issue_token(p_kind text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_id    uuid := public.my_diner_id();
  v_tok   text;
  v_exp   timestamptz;
BEGIN
  IF v_id IS NULL THEN RAISE EXCEPTION 'sin perfil de comensal' USING ERRCODE='28000'; END IF;
  IF p_kind NOT IN ('device','counter') THEN RAISE EXCEPTION 'kind inválido' USING ERRCODE='22023'; END IF;

  IF p_kind = 'device' THEN
    -- Multiuso, 30 días: identifica el navegador de la persona ante el QR.
    v_tok := encode(extensions.gen_random_bytes(24), 'hex');
    v_exp := now() + interval '30 days';
  ELSE
    -- 6 dígitos, 10 minutos, un solo uso. Se dicta en el mostrador.
    -- Se revoca el anterior: dos códigos vivos a la vez confunden al cajero
    -- y duplican la superficie de adivinación.
    UPDATE public.diner_link_tokens
       SET revoked_at = now()
     WHERE diner_id = v_id AND kind = 'counter' AND used_at IS NULL AND revoked_at IS NULL;
    v_tok := lpad((floor(random()*1000000))::int::text, 6, '0');
    v_exp := now() + interval '10 minutes';
  END IF;

  INSERT INTO public.diner_link_tokens (diner_id, kind, token, expires_at)
  VALUES (v_id, p_kind, v_tok, v_exp);

  RETURN jsonb_build_object('token', v_tok, 'expires_at', v_exp, 'kind', p_kind);
END;
$$;

-- Camino B (§5.2): el cajero tipea el código que le dicta la persona y la
-- ficha de ESE local queda vinculada. La verificación es la presencia física
-- —el cajero la está mirando—, que para este caso es más fuerte que un SMS.
CREATE OR REPLACE FUNCTION public.staff_link_diner_code(p_code text, p_customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_tok  record;
  v_cust record;
  v_xp   int := 0;
BEGIN
  SELECT * INTO v_cust FROM public.customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'Ficha inexistente.'); END IF;

  -- El cajero sólo puede vincular fichas de SU restaurante.
  IF v_cust.restaurant_id NOT IN (SELECT public.get_my_company_restaurant_ids())
     AND public.get_my_role() <> 'superadmin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'La ficha no es de tu local.');
  END IF;

  SELECT * INTO v_tok FROM public.diner_link_tokens
   WHERE kind = 'counter' AND token = btrim(p_code)
     AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now();
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Código inválido o vencido.');
  END IF;

  INSERT INTO public.diner_customer_links (diner_id, customer_id, restaurant_id, linked_via)
  VALUES (v_tok.diner_id, p_customer_id, v_cust.restaurant_id, 'counter_claim')
  ON CONFLICT (diner_id, customer_id) DO NOTHING;

  UPDATE public.diner_link_tokens SET used_at = now() WHERE id = v_tok.id;

  -- Al vincular, el XP que la ficha venía juntando pasa a contar solo (el OR
  -- de diner_total_xp). Devolvemos el total para que Caja pueda mostrarlo.
  v_xp := public.diner_total_xp(v_tok.diner_id);

  RETURN jsonb_build_object('ok', true, 'diner_id', v_tok.diner_id, 'total_xp', v_xp);
END;
$$;

-- Camino A: resuelve el token de dispositivo y deja el pedido vinculado.
-- La llama create_order (abajo) dentro de un bloque a prueba de excepciones.
CREATE OR REPLACE FUNCTION public.diner_claim_order(
  p_token text, p_restaurant uuid, p_customer uuid,
  p_order uuid, p_delivery uuid, p_service text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_diner uuid;
  v_rule  text;
  v_new   boolean;
BEGIN
  IF p_token IS NULL OR btrim(p_token) = '' THEN RETURN NULL; END IF;

  SELECT t.diner_id INTO v_diner
    FROM public.diner_link_tokens t
   WHERE t.kind = 'device' AND t.token = btrim(p_token)
     AND t.revoked_at IS NULL AND t.expires_at > now();
  IF v_diner IS NULL THEN RETURN NULL; END IF;

  IF p_customer IS NOT NULL THEN
    INSERT INTO public.diner_customer_links (diner_id, customer_id, restaurant_id, linked_via)
    VALUES (v_diner, p_customer, p_restaurant, 'order_claim')
    ON CONFLICT (diner_id, customer_id) DO NOTHING;
  END IF;

  -- ¿Primer pedido de esta persona en este local? (antes de anotar el de hoy)
  v_new := NOT EXISTS (
    SELECT 1 FROM public.xp_ledger x
     WHERE x.diner_id = v_diner AND x.restaurant_id = p_restaurant
       AND x.rule_code IN ('order_dine_in','order_pickup','order_delivery'));

  v_rule := CASE lower(coalesce(p_service,''))
              WHEN 'delivery' THEN 'order_delivery'
              WHEN 'pickup'   THEN 'order_pickup'
              WHEN 'llevar'   THEN 'order_pickup'
              ELSE 'order_dine_in' END;

  PERFORM public.award_xp(v_rule, v_diner, p_customer, p_restaurant, p_order, p_delivery, NULL, 0, 0, NULL);

  IF v_new THEN
    PERFORM public.award_xp('new_restaurant', v_diner, p_customer, p_restaurant, p_order, p_delivery, NULL, 0, 0, NULL);
  END IF;

  -- Primer pedido de la vida: se acredita una sola vez porque el índice único
  -- sobre (order_id, rule_code) más este NOT EXISTS lo hacen idempotente.
  IF NOT EXISTS (SELECT 1 FROM public.xp_ledger x WHERE x.diner_id = v_diner AND x.rule_code = 'first_order') THEN
    PERFORM public.award_xp('first_order', v_diner, p_customer, p_restaurant, p_order, p_delivery, NULL, 0, 0, NULL);
  END IF;

  RETURN v_diner;
END;
$$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- 11) DESCUBRIMIENTO, PEDIDOS Y RESEÑAS — todo server-side
-- ────────────────────────────────────────────────────────────────────────
-- Por qué RPC y no un .select() desde el navegador: `restaurants` está
-- tenant-scoped para authenticated (mig 103) y el comensal NO tiene fila en
-- user_roles → un SELECT directo le devolvería CERO restaurantes. Además,
-- agregar en el navegador sobre un .limit() es el error que las migs 197/198
-- ya tuvieron que arreglar dos veces: el número empeora cuanto más crece el
-- negocio. Acá se agrega del lado de la base desde el día uno.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE OR REPLACE FUNCTION public.diner_discover(
  p_search  text DEFAULT NULL,
  p_city    text DEFAULT NULL,
  p_service text DEFAULT NULL,     -- dine_in | delivery | pickup
  p_type    text DEFAULT NULL,     -- business_type
  p_limit   int  DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_me     uuid := public.my_diner_id();
  v_rows   jsonb;
  v_cities jsonb;
  v_types  jsonb;
BEGIN
  IF NOT COALESCE((SELECT discovery_enabled FROM public.diner_app_config WHERE id), false) THEN
    RETURN jsonb_build_object('enabled', false, 'rows', '[]'::jsonb);
  END IF;

  WITH base AS (
    SELECT r.id, r.name, r.city, r.address, r.logo_url, r.cover_image_url,
           r.business_type, r.is_open, r.lat, r.lng,
           r.logo_initials, r.whatsapp, r.phone,
           -- `service_mode` lo agrega la mig 173, que puede NO estar aplicada.
           -- Leerlo como `r.service_mode` haría fallar el descubrimiento entero
           -- en runtime con un "column does not exist". Vía to_jsonb, una
           -- columna que no existe simplemente no aparece en el objeto y cae al
           -- default 'salon' (que es el comportamiento correcto), y el día que
           -- se aplique la 173 esto empieza a leer el valor real solo, sin
           -- tocar nada. Esta migración NO modifica `restaurants`.
           COALESCE(to_jsonb(r)->>'service_mode', 'salon') AS service_mode
      FROM public.restaurants r
     WHERE COALESCE(r.is_active, true) = true
       AND COALESCE(r.status,'active') NOT IN ('deleted','suspended')
  ), scored AS (
    SELECT b.*,
           (SELECT count(*) FROM public.diner_reviews rv
             WHERE rv.restaurant_id = b.id AND rv.status = 'approved')            AS review_count,
           (SELECT round(avg(rv.stars)::numeric, 2) FROM public.diner_reviews rv
             WHERE rv.restaurant_id = b.id AND rv.status = 'approved')            AS rating,
           EXISTS (SELECT 1 FROM public.diner_favorites f
                    WHERE f.diner_id = v_me AND f.restaurant_id = b.id AND f.item_id IS NULL) AS is_favorite,
           EXISTS (SELECT 1 FROM public.xp_ledger x
                    WHERE x.diner_id = v_me AND x.restaurant_id = b.id)           AS visited
      FROM base b
  )
  -- El filtrado y el corte van al SERVIDOR. Traer todo y filtrar en el
  -- navegador sobre un .limit() es lo que la mig 199 tuvo que arreglar en la
  -- vitrina de proveedores: el resultado empeora cuanto más locales hay.
  SELECT COALESCE(jsonb_agg(to_jsonb(f) ORDER BY f.is_favorite DESC, f.rating DESC NULLS LAST, f.name), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT s.* FROM scored s
       WHERE (p_search IS NULL OR btrim(p_search) = ''
              OR s.name ILIKE '%'||btrim(p_search)||'%'
              OR COALESCE(s.business_type,'') ILIKE '%'||btrim(p_search)||'%')
         AND (p_city IS NULL OR btrim(p_city) = '' OR lower(COALESCE(s.city,'')) = lower(btrim(p_city)))
         AND (p_type IS NULL OR btrim(p_type) = '' OR lower(COALESCE(s.business_type,'')) = lower(btrim(p_type)))
         -- service_mode (mig 173/175): 'delivery' = local sólo delivery,
         -- 'salon_sin_delivery' = local que no reparte. El resto acepta todo.
         AND (p_service IS NULL OR p_service = ''
              OR (p_service = 'delivery' AND COALESCE(s.service_mode,'salon') <> 'salon_sin_delivery')
              OR (p_service <> 'delivery' AND COALESCE(s.service_mode,'salon') <> 'delivery'))
       ORDER BY s.is_favorite DESC, s.rating DESC NULLS LAST, s.name
       LIMIT GREATEST(COALESCE(p_limit, 60), 1)
    ) f;

  SELECT COALESCE(jsonb_agg(DISTINCT c), '[]'::jsonb) INTO v_cities
    FROM (SELECT NULLIF(btrim(r.city),'') AS c FROM public.restaurants r
           WHERE COALESCE(r.is_active,true) AND NULLIF(btrim(r.city),'') IS NOT NULL) q;

  SELECT COALESCE(jsonb_agg(DISTINCT t), '[]'::jsonb) INTO v_types
    FROM (SELECT NULLIF(btrim(r.business_type),'') AS t FROM public.restaurants r
           WHERE COALESCE(r.is_active,true) AND NULLIF(btrim(r.business_type),'') IS NOT NULL) q;

  RETURN jsonb_build_object('enabled', true, 'rows', v_rows,
                            'cities', v_cities, 'types', v_types);
END;
$$;

-- ── Mis pedidos, cruzados entre locales ────────────────────────────────
-- Esto es lo que ningún restaurante puede darle solo al comensal: su
-- historial atraviesa los locales. Incluye si ya reseñó, para que la app
-- pueda ofrecer calificar exactamente una vez por pedido.
CREATE OR REPLACE FUNCTION public.diner_my_orders(p_limit int DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_me   uuid := public.my_diner_id();
  v_rows jsonb;
BEGIN
  IF v_me IS NULL THEN RETURN '[]'::jsonb; END IF;

  WITH mine AS (
    SELECT DISTINCT o.id
      FROM public.orders o
     WHERE o.customer_id IN (SELECT l.customer_id FROM public.diner_customer_links l WHERE l.diner_id = v_me)
        OR o.id IN (SELECT x.order_id FROM public.xp_ledger x WHERE x.diner_id = v_me AND x.order_id IS NOT NULL)
  )
  SELECT COALESCE(jsonb_agg(row_to_json(q)::jsonb ORDER BY q.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT o.id, o.order_number, o.status, o.payment_status, o.order_type,
             o.total, o.created_at, o.restaurant_id,
             r.name AS restaurant_name, r.logo_url, r.business_type, r.city,
             d.id AS delivery_order_id, d.rider_status, d.rider_name,
             EXISTS (SELECT 1 FROM public.diner_reviews rv WHERE rv.order_id = o.id) AS reviewed,
             (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                        'name', oi.item_name, 'qty', oi.quantity)), '[]'::jsonb)
                FROM public.order_items oi WHERE oi.order_id = o.id) AS items
        FROM public.orders o
        JOIN mine m           ON m.id = o.id
        JOIN public.restaurants r ON r.id = o.restaurant_id
        LEFT JOIN public.delivery_orders d ON d.order_id = o.id
       ORDER BY o.created_at DESC
       LIMIT GREATEST(COALESCE(p_limit,60), 1)
    ) q;

  RETURN v_rows;
END;
$$;

-- ── Publicar una reseña ────────────────────────────────────────────────
-- LA REGLA: sólo reseña quien realmente pidió y pagó ahí, y una sola vez por
-- pedido. Las cuentas falsas siguen siendo gratis; las reseñas falsas pasan a
-- costar cenas reales. Sin esto, el ranking no le sirve a nadie y el reclamo
-- del restaurante que paga suscripción viene a Mythos.
CREATE OR REPLACE FUNCTION public.diner_submit_review(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_me      uuid := public.my_diner_id();
  v_order   uuid := NULLIF(p_payload->>'order_id','')::uuid;
  v_stars   int  := COALESCE((p_payload->>'stars')::int, 0);
  v_comment text := NULLIF(btrim(coalesce(p_payload->>'comment','')),'');
  v_scores  jsonb := COALESCE(p_payload->'scores','{}'::jsonb);
  v_cfg     record;
  v_ord     record;
  v_deliv   uuid;
  v_service text;
  v_review  uuid;
  v_dims    int := 0;
  v_key     text;
  v_xp      int := 0;
  v_lvl     record;
  v_weight  numeric := 1;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Necesitás tu cuenta de comensal.'); END IF;
  SELECT * INTO v_cfg FROM public.diner_app_config WHERE id;
  IF NOT COALESCE(v_cfg.reviews_enabled,false) THEN
    RETURN jsonb_build_object('ok',false,'error','Las reseñas están desactivadas.');
  END IF;
  IF v_stars < 1 OR v_stars > 5 THEN
    RETURN jsonb_build_object('ok',false,'error','Elegí una calificación general.');
  END IF;
  IF v_cfg.review_min_chars > 0 AND length(COALESCE(v_comment,'')) < v_cfg.review_min_chars THEN
    RETURN jsonb_build_object('ok',false,'error',
      format('Contanos un poco más (mínimo %s caracteres).', v_cfg.review_min_chars));
  END IF;

  SELECT o.id, o.restaurant_id, o.customer_id, o.status, o.payment_status, o.order_type
    INTO v_ord FROM public.orders o WHERE o.id = v_order;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','Pedido inexistente.'); END IF;

  -- ANTIFRAUDE 1 — el pedido tiene que estar PAGADO.
  IF NOT (COALESCE(v_ord.payment_status,'') = 'paid'
          OR v_ord.status IN ('paid','kitchen_received','cooking','ready','delivered')) THEN
    RETURN jsonb_build_object('ok',false,'error','Sólo se puede calificar un pedido pagado.');
  END IF;

  -- ANTIFRAUDE 2 — el pedido tiene que ser TUYO.
  IF NOT (
      (v_ord.customer_id IS NOT NULL AND v_ord.customer_id IN
         (SELECT l.customer_id FROM public.diner_customer_links l WHERE l.diner_id = v_me))
      OR EXISTS (SELECT 1 FROM public.xp_ledger x WHERE x.diner_id = v_me AND x.order_id = v_ord.id)
  ) THEN
    RETURN jsonb_build_object('ok',false,'error','Ese pedido no figura como tuyo.');
  END IF;

  SELECT d.id INTO v_deliv FROM public.delivery_orders d WHERE d.order_id = v_ord.id LIMIT 1;
  v_service := CASE
                 WHEN v_deliv IS NOT NULL AND v_ord.order_type = 'delivery' THEN 'delivery'
                 WHEN v_ord.order_type IN ('pickup','llevar','take') THEN 'pickup'
                 ELSE 'dine_in' END;

  -- Peso de la crítica: nivel × credibilidad, congelado al publicar.
  -- Recalcularlo después movería notas viejas al azar.
  IF COALESCE(v_cfg.weighted_rating_enabled,false) THEN
    SELECT * INTO v_lvl FROM public.xp_level_of(public.diner_total_xp(v_me));
    v_weight := round(COALESCE(v_lvl.review_weight,1)
                      * (public.diner_credibility(v_me)::numeric / 100.0), 3);
    v_weight := GREATEST(v_weight, 0.1);
  END IF;

  INSERT INTO public.diner_reviews (
    diner_id, restaurant_id, customer_id, order_id, delivery_order_id,
    service_type, stars, comment, status, weight)
  VALUES (
    v_me, v_ord.restaurant_id, v_ord.customer_id, v_ord.id, v_deliv,
    v_service, v_stars, v_comment,
    CASE WHEN COALESCE(v_cfg.review_auto_approve,true) THEN 'approved' ELSE 'pending' END,
    v_weight)
  ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_review;

  IF v_review IS NULL THEN
    RETURN jsonb_build_object('ok',false,'error','Ya calificaste este pedido.');
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(v_scores)
  LOOP
    IF EXISTS (SELECT 1 FROM public.review_dimensions d WHERE d.code = v_key AND d.is_active)
       AND COALESCE((v_scores->>v_key)::int, 0) BETWEEN 1 AND 5 THEN
      INSERT INTO public.diner_review_scores (review_id, dimension, stars)
      VALUES (v_review, v_key, (v_scores->>v_key)::int)
      ON CONFLICT (review_id, dimension) DO UPDATE SET stars = EXCLUDED.stars;
      v_dims := v_dims + 1;
    END IF;
  END LOOP;

  -- El XP premia la COMPLETITUD: 9 de 10 dimensiones dan menos que 10 de 10.
  BEGIN
    v_xp := public.award_xp('review', v_me, v_ord.customer_id, v_ord.restaurant_id,
                            NULL, NULL, v_review, v_dims, 0, NULL);
  EXCEPTION WHEN OTHERS THEN v_xp := 0; END;

  RETURN jsonb_build_object('ok', true, 'review_id', v_review, 'xp', v_xp, 'dimensions', v_dims);
END;
$$;

-- ── Votar una reseña ───────────────────────────────────────────────────
-- La utilidad sube la reputación del crítico: por eso el XP se acredita al
-- AUTOR, no al que vota (y con techo diario, para que no se farmee con
-- cuentas amigas).
CREATE OR REPLACE FUNCTION public.diner_vote_review(p_review uuid, p_kind text, p_on boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_me     uuid := public.my_diner_id();
  v_author uuid;
  v_rest   uuid;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok',false); END IF;
  IF p_kind NOT IN ('helpful','detailed','decided') THEN
    RETURN jsonb_build_object('ok',false,'error','Voto inválido.');
  END IF;

  SELECT r.diner_id, r.restaurant_id INTO v_author, v_rest
    FROM public.diner_reviews r WHERE r.id = p_review AND r.status = 'approved';
  IF v_author IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Reseña no disponible.'); END IF;
  IF v_author = v_me THEN RETURN jsonb_build_object('ok',false,'error','No podés votar tu propia reseña.'); END IF;

  IF p_on THEN
    INSERT INTO public.diner_review_votes (review_id, diner_id, kind)
    VALUES (p_review, v_me, p_kind) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM public.diner_review_votes
     WHERE review_id = p_review AND diner_id = v_me AND kind = p_kind;
  END IF;

  UPDATE public.diner_reviews r SET
    helpful_count  = (SELECT count(*) FROM public.diner_review_votes v WHERE v.review_id = r.id AND v.kind='helpful'),
    detailed_count = (SELECT count(*) FROM public.diner_review_votes v WHERE v.review_id = r.id AND v.kind='detailed'),
    decided_count  = (SELECT count(*) FROM public.diner_review_votes v WHERE v.review_id = r.id AND v.kind='decided')
   WHERE r.id = p_review;

  IF p_on AND p_kind = 'helpful' THEN
    BEGIN PERFORM public.award_xp('helpful_vote', v_author, NULL, v_rest, NULL, NULL, NULL, 1, 0, NULL);
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ── Reseñas de un restaurante (para la app) ────────────────────────────
CREATE OR REPLACE FUNCTION public.diner_restaurant_reviews(p_restaurant uuid, p_limit int DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_me   uuid := public.my_diner_id();
  v_rows jsonb;
  v_dims jsonb;
  v_avg  numeric;
  v_wavg numeric;
  v_n    int;
BEGIN
  SELECT count(*), round(avg(stars)::numeric,2),
         CASE WHEN sum(weight) > 0 THEN round((sum(stars*weight)/sum(weight))::numeric,2) END
    INTO v_n, v_avg, v_wavg
    FROM public.diner_reviews WHERE restaurant_id = p_restaurant AND status = 'approved';

  SELECT COALESCE(jsonb_object_agg(d.dimension, d.avg_stars), '{}'::jsonb) INTO v_dims
    FROM (SELECT s.dimension, round(avg(s.stars)::numeric,2) AS avg_stars
            FROM public.diner_review_scores s
            JOIN public.diner_reviews r ON r.id = s.review_id
           WHERE r.restaurant_id = p_restaurant AND r.status = 'approved'
           GROUP BY s.dimension) d;

  SELECT COALESCE(jsonb_agg(row_to_json(q)::jsonb ORDER BY q.helpful_count DESC, q.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT r.id, r.stars, r.comment, r.created_at, r.service_type,
             r.helpful_count, r.detailed_count, r.decided_count,
             r.restaurant_reply, r.replied_at,
             COALESCE(dn.display_name,'Comensal') AS author,
             dn.avatar_url AS author_avatar,
             public.diner_credibility(r.diner_id) AS author_credibility,
             (SELECT lv.name FROM public.xp_level_of(public.diner_total_xp(r.diner_id)) lv) AS author_level_name,
             (SELECT lv.level FROM public.xp_level_of(public.diner_total_xp(r.diner_id)) lv) AS author_level,
             (r.diner_id = v_me) AS is_mine,
             (SELECT COALESCE(jsonb_object_agg(s.dimension, s.stars), '{}'::jsonb)
                FROM public.diner_review_scores s WHERE s.review_id = r.id) AS scores,
             (SELECT COALESCE(jsonb_agg(p.storage_path), '[]'::jsonb)
                FROM public.diner_review_photos p WHERE p.review_id = r.id AND p.status='approved') AS photos,
             (SELECT COALESCE(jsonb_agg(v.kind), '[]'::jsonb)
                FROM public.diner_review_votes v WHERE v.review_id = r.id AND v.diner_id = v_me) AS my_votes
        FROM public.diner_reviews r
        LEFT JOIN public.diners dn ON dn.id = r.diner_id
       WHERE r.restaurant_id = p_restaurant AND r.status = 'approved'
       ORDER BY r.helpful_count DESC, r.created_at DESC
       LIMIT GREATEST(COALESCE(p_limit,30),1)
    ) q;

  RETURN jsonb_build_object('count', COALESCE(v_n,0), 'avg', v_avg,
                            'weighted_avg', v_wavg, 'dimensions', v_dims, 'rows', v_rows);
END;
$$;

-- ── El restaurante responde una reseña ─────────────────────────────────
-- Por RPC y no por policy: la RLS filtra filas, no columnas, así que una
-- policy de UPDATE para el local le habilitaría también `stars` y `status`.
-- Acá se escriben EXACTAMENTE las dos columnas de la respuesta.
CREATE OR REPLACE FUNCTION public.restaurant_reply_review(p_review uuid, p_reply text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_rest uuid;
BEGIN
  SELECT r.restaurant_id INTO v_rest FROM public.diner_reviews r WHERE r.id = p_review;
  IF v_rest IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Reseña inexistente.'); END IF;
  IF public.get_my_role() <> 'superadmin'
     AND v_rest NOT IN (SELECT public.get_my_company_restaurant_ids()) THEN
    RETURN jsonb_build_object('ok',false,'error','Esa reseña no es de tu local.');
  END IF;

  UPDATE public.diner_reviews
     SET restaurant_reply = NULLIF(btrim(left(coalesce(p_reply,''), 1200)),''),
         replied_at = CASE WHEN NULLIF(btrim(coalesce(p_reply,'')),'') IS NULL THEN NULL ELSE now() END
   WHERE id = p_review;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ── Reseñas que le llegan a UN restaurante (Admin / Gerente) ───────────
CREATE OR REPLACE FUNCTION public.restaurant_reviews_inbox(p_restaurant uuid, p_limit int DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF public.get_my_role() <> 'superadmin'
     AND p_restaurant NOT IN (SELECT public.get_my_company_restaurant_ids()) THEN
    RAISE EXCEPTION 'sin acceso a ese restaurante' USING ERRCODE='42501';
  END IF;

  RETURN jsonb_build_object(
    'avg',   (SELECT round(avg(stars)::numeric,2) FROM public.diner_reviews
               WHERE restaurant_id = p_restaurant AND status='approved'),
    'count', (SELECT count(*) FROM public.diner_reviews
               WHERE restaurant_id = p_restaurant AND status='approved'),
    'dimensions', (SELECT COALESCE(jsonb_object_agg(d.dimension, d.avg_stars),'{}'::jsonb)
       FROM (SELECT s.dimension, round(avg(s.stars)::numeric,2) AS avg_stars
               FROM public.diner_review_scores s
               JOIN public.diner_reviews r ON r.id = s.review_id
              WHERE r.restaurant_id = p_restaurant AND r.status='approved'
              GROUP BY s.dimension) d),
    'rows', (SELECT COALESCE(jsonb_agg(q ORDER BY q.created_at DESC), '[]'::jsonb) FROM (
        SELECT r.id, r.stars, r.comment, r.created_at, r.service_type,
               r.helpful_count, r.restaurant_reply, r.replied_at,
               -- El local ve el NOMBRE del crítico y su nivel, nunca su correo
               -- ni en qué otros restaurantes come (§6 y §8.1.2 del diseño).
               COALESCE(dn.display_name,'Comensal') AS author,
               (SELECT lv.name FROM public.xp_level_of(public.diner_total_xp(r.diner_id)) lv) AS author_level_name,
               public.diner_credibility(r.diner_id) AS author_credibility,
               (SELECT COALESCE(jsonb_object_agg(s.dimension, s.stars),'{}'::jsonb)
                  FROM public.diner_review_scores s WHERE s.review_id = r.id) AS scores
          FROM public.diner_reviews r
          LEFT JOIN public.diners dn ON dn.id = r.diner_id
         WHERE r.restaurant_id = p_restaurant AND r.status = 'approved'
         ORDER BY r.created_at DESC LIMIT GREATEST(COALESCE(p_limit,50),1)) q));
END;
$$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- 11.b) BUCKET DE FOTOS DE RESEÑA
-- ────────────────────────────────────────────────────────────────────────
-- PÚBLICO a propósito, al revés que `comprobantes` (mig 183, privado): una
-- foto de un plato no es PII y la app la muestra a todo el mundo. Lo que
-- controla qué se ve NO es el bucket sino `diner_review_photos.status`: la
-- foto se sube antes de aprobarse, así que si el bucket fuera privado haría
-- falta firmar URLs para algo que igual va a ser público en un rato.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('resenas', 'resenas', true, 5242880,
        ARRAY['image/jpeg','image/png','image/webp','image/heic'])
ON CONFLICT (id) DO NOTHING;

-- Sube sólo un autenticado, y sólo dentro de SU carpeta (primer segmento del
-- path = su auth uid). Sin eso, cualquiera pisa la foto de cualquiera.
DROP POLICY IF EXISTS resenas_insert_own ON storage.objects;
CREATE POLICY resenas_insert_own ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'resenas' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS resenas_read_all ON storage.objects;
CREATE POLICY resenas_read_all ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (bucket_id = 'resenas');

DROP POLICY IF EXISTS resenas_delete_own ON storage.objects;
CREATE POLICY resenas_delete_own ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'resenas'
         AND ((storage.foldername(name))[1] = auth.uid()::text
              OR public.get_my_role() = 'superadmin'));

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- 12) PERFIL, LOGROS Y RANKING
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- Recalcula insignias, colecciones y retos. Idempotente: correrlo dos veces
-- no reparte dos veces (PK sobre (diner,badge) y (diner,challenge,período)).
CREATE OR REPLACE FUNCTION public.diner_refresh_achievements()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_me      uuid := public.my_diner_id();
  v_orders  int; v_rests int; v_reviews int; v_photos int; v_helpful int; v_level int;
  b         record;
  ch        record;
  v_done    int;
  v_key     text;
  v_from    timestamptz;
  v_new     jsonb := '[]'::jsonb;
  v_prog    int;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('new', v_new); END IF;

  SELECT count(*), count(DISTINCT x.restaurant_id) INTO v_orders, v_rests
    FROM public.xp_ledger x
   WHERE x.diner_id = v_me AND x.rule_code IN ('order_dine_in','order_pickup','order_delivery');

  SELECT count(*) INTO v_reviews FROM public.diner_reviews
   WHERE diner_id = v_me AND status = 'approved';
  SELECT count(*) INTO v_photos  FROM public.diner_review_photos
   WHERE diner_id = v_me AND status = 'approved';
  SELECT COALESCE(sum(helpful_count),0) INTO v_helpful FROM public.diner_reviews
   WHERE diner_id = v_me AND status = 'approved';
  SELECT lv.level INTO v_level FROM public.xp_level_of(public.diner_total_xp(v_me)) lv;

  -- ── Insignias ──
  FOR b IN SELECT * FROM public.diner_badges_catalog WHERE is_active ORDER BY sort_order
  LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.diner_badges g WHERE g.diner_id = v_me AND g.badge_id = b.id);

    v_prog := CASE b.criteria_type
      WHEN 'orders_total'      THEN v_orders
      WHEN 'restaurants_total' THEN v_rests
      WHEN 'reviews_total'     THEN v_reviews
      WHEN 'photos_total'      THEN v_photos
      WHEN 'helpful_total'     THEN v_helpful
      WHEN 'level'             THEN COALESCE(v_level,0)
      WHEN 'orders_by_type'    THEN (
        SELECT count(*) FROM public.xp_ledger x JOIN public.restaurants r ON r.id = x.restaurant_id
         WHERE x.diner_id = v_me AND x.rule_code IN ('order_dine_in','order_pickup','order_delivery')
           AND lower(COALESCE(r.business_type,'')) IN (SELECT lower(mt.v) FROM unnest(b.match_types) AS mt(v)))
      WHEN 'restaurants_by_type' THEN (
        SELECT count(DISTINCT x.restaurant_id) FROM public.xp_ledger x JOIN public.restaurants r ON r.id = x.restaurant_id
         WHERE x.diner_id = v_me AND x.rule_code IN ('order_dine_in','order_pickup','order_delivery')
           AND lower(COALESCE(r.business_type,'')) IN (SELECT lower(mt.v) FROM unnest(b.match_types) AS mt(v)))
      WHEN 'restaurants_by_city' THEN (
        SELECT count(DISTINCT x.restaurant_id) FROM public.xp_ledger x JOIN public.restaurants r ON r.id = x.restaurant_id
         WHERE x.diner_id = v_me AND x.rule_code IN ('order_dine_in','order_pickup','order_delivery')
           AND lower(COALESCE(r.city,'')) = lower(COALESCE(b.match_city,'')))
      ELSE 0 END;

    IF v_prog >= b.criteria_value THEN
      INSERT INTO public.diner_badges (diner_id, badge_id) VALUES (v_me, b.id)
      ON CONFLICT DO NOTHING;
      -- El XP lo define CADA insignia (por eso la regla 'badge' tiene
      -- xp_fixed=0), así que se anota directo en vez de pasar por award_xp:
      -- una insignia se gana una sola vez en la vida y no debe caer bajo el
      -- techo diario de una regla genérica.
      IF b.xp_reward > 0 THEN
        BEGIN
          INSERT INTO public.xp_ledger (diner_id, xp, rule_code, note)
          VALUES (v_me, b.xp_reward, 'badge', b.code);
        EXCEPTION WHEN OTHERS THEN NULL; END;
      END IF;
      v_new := v_new || jsonb_build_object('type','badge','name',b.name,'emoji',b.emoji);
    END IF;
  END LOOP;

  -- ── Retos ──
  FOR ch IN SELECT * FROM public.diner_challenges WHERE is_active ORDER BY sort_order
  LOOP
    v_key  := CASE ch.period
                WHEN 'week'  THEN to_char(now() AT TIME ZONE 'America/Asuncion', 'IYYY"-W"IW')
                WHEN 'month' THEN to_char(now() AT TIME ZONE 'America/Asuncion', 'YYYY-MM')
                ELSE 'once' END;
    v_from := CASE ch.period
                WHEN 'week'  THEN date_trunc('week',  now() AT TIME ZONE 'America/Asuncion') AT TIME ZONE 'America/Asuncion'
                WHEN 'month' THEN date_trunc('month', now() AT TIME ZONE 'America/Asuncion') AT TIME ZONE 'America/Asuncion'
                ELSE COALESCE(ch.starts_at, '-infinity'::timestamptz) END;

    CONTINUE WHEN EXISTS (SELECT 1 FROM public.diner_challenge_claims c
                           WHERE c.diner_id = v_me AND c.challenge_id = ch.id AND c.period_key = v_key);

    v_done := CASE ch.goal_type
      WHEN 'orders' THEN (SELECT count(*) FROM public.xp_ledger x
                           WHERE x.diner_id = v_me AND x.created_at >= v_from
                             AND x.rule_code IN ('order_dine_in','order_pickup','order_delivery'))
      WHEN 'restaurants' THEN (SELECT count(DISTINCT x.restaurant_id) FROM public.xp_ledger x
                                WHERE x.diner_id = v_me AND x.created_at >= v_from
                                  AND x.rule_code IN ('order_dine_in','order_pickup','order_delivery'))
      WHEN 'reviews' THEN (SELECT count(*) FROM public.diner_reviews r
                            WHERE r.diner_id = v_me AND r.created_at >= v_from AND r.status='approved')
      WHEN 'photos'  THEN (SELECT count(*) FROM public.diner_review_photos p
                            WHERE p.diner_id = v_me AND p.created_at >= v_from AND p.status='approved')
      WHEN 'restaurants_by_type' THEN (
        SELECT count(DISTINCT x.restaurant_id) FROM public.xp_ledger x
          JOIN public.restaurants r ON r.id = x.restaurant_id
         WHERE x.diner_id = v_me AND x.created_at >= v_from
           AND x.rule_code IN ('order_dine_in','order_pickup','order_delivery')
           AND lower(COALESCE(r.business_type,'')) IN (SELECT lower(mt.v) FROM unnest(ch.match_types) AS mt(v)))
      ELSE 0 END;

    IF v_done >= ch.goal_value THEN
      INSERT INTO public.diner_challenge_claims (diner_id, challenge_id, period_key)
      VALUES (v_me, ch.id, v_key) ON CONFLICT DO NOTHING;
      IF ch.reward_xp > 0 THEN
        BEGIN
          INSERT INTO public.xp_ledger (diner_id, xp, rule_code, note)
          VALUES (v_me, ch.reward_xp, 'challenge', ch.code);
        EXCEPTION WHEN OTHERS THEN NULL; END;
      END IF;
      IF ch.reward_badge_id IS NOT NULL THEN
        INSERT INTO public.diner_badges (diner_id, badge_id) VALUES (v_me, ch.reward_badge_id)
        ON CONFLICT DO NOTHING;
      END IF;
      v_new := v_new || jsonb_build_object('type','challenge','name',ch.name,'emoji',ch.emoji,'xp',ch.reward_xp);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('new', v_new);
END;
$$;

-- ── Mi perfil completo ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.diner_profile()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_me     uuid := public.my_diner_id();
  v_d      record;
  v_xp     int;
  v_lvl    record;
  v_stats  jsonb;
  v_badges jsonb;
  v_coll   jsonb;
  v_chal   jsonb;
  v_rank   jsonb;
  v_fav    jsonb;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false); END IF;
  SELECT * INTO v_d FROM public.diners WHERE id = v_me;
  v_xp := public.diner_total_xp(v_me);
  SELECT * INTO v_lvl FROM public.xp_level_of(v_xp);

  SELECT jsonb_build_object(
      'orders',      (SELECT count(*) FROM public.xp_ledger x WHERE x.diner_id=v_me
                       AND x.rule_code IN ('order_dine_in','order_pickup','order_delivery')),
      'restaurants', (SELECT count(DISTINCT x.restaurant_id) FROM public.xp_ledger x WHERE x.diner_id=v_me
                       AND x.rule_code IN ('order_dine_in','order_pickup','order_delivery')),
      'reviews',     (SELECT count(*) FROM public.diner_reviews  WHERE diner_id=v_me AND status='approved'),
      'photos',      (SELECT count(*) FROM public.diner_review_photos WHERE diner_id=v_me AND status='approved'),
      'helpful',     (SELECT COALESCE(sum(helpful_count+detailed_count+decided_count),0)
                        FROM public.diner_reviews WHERE diner_id=v_me AND status='approved'),
      'spent',       (SELECT COALESCE(sum(o.total),0) FROM public.orders o
                       WHERE o.customer_id IN (SELECT l.customer_id FROM public.diner_customer_links l WHERE l.diner_id=v_me)),
      'top_restaurant', (SELECT r.name FROM public.xp_ledger x JOIN public.restaurants r ON r.id=x.restaurant_id
                          WHERE x.diner_id=v_me AND x.rule_code IN ('order_dine_in','order_pickup','order_delivery')
                          GROUP BY r.name ORDER BY count(*) DESC LIMIT 1),
      'top_type',    (SELECT r.business_type FROM public.xp_ledger x JOIN public.restaurants r ON r.id=x.restaurant_id
                       WHERE x.diner_id=v_me AND x.rule_code IN ('order_dine_in','order_pickup','order_delivery')
                         AND NULLIF(btrim(r.business_type),'') IS NOT NULL
                       GROUP BY r.business_type ORDER BY count(*) DESC LIMIT 1),
      'top_city',    (SELECT r.city FROM public.xp_ledger x JOIN public.restaurants r ON r.id=x.restaurant_id
                       WHERE x.diner_id=v_me AND x.rule_code IN ('order_dine_in','order_pickup','order_delivery')
                         AND NULLIF(btrim(r.city),'') IS NOT NULL
                       GROUP BY r.city ORDER BY count(*) DESC LIMIT 1),
      'top_hour',    (SELECT to_char(date_trunc('hour', x.created_at AT TIME ZONE 'America/Asuncion'),'HH24":00"')
                        FROM public.xp_ledger x WHERE x.diner_id=v_me
                         AND x.rule_code IN ('order_dine_in','order_pickup','order_delivery')
                       GROUP BY 1 ORDER BY count(*) DESC LIMIT 1)
  ) INTO v_stats;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'code',b.code,'name',b.name,'emoji',b.emoji,'description',b.description,
           'earned', g.diner_id IS NOT NULL, 'earned_at', g.earned_at) ORDER BY b.sort_order), '[]'::jsonb)
    INTO v_badges
    FROM public.diner_badges_catalog b
    LEFT JOIN public.diner_badges g ON g.badge_id = b.id AND g.diner_id = v_me
   WHERE b.is_active;

  -- Colecciones: el denominador es real (locales activos que matchean), no
  -- un número inventado. Una colección que dice "18 de 35" y no existen 35
  -- locales es una promesa que la app no puede cumplir.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'code',c.code,'name',c.name,'emoji',c.emoji,'description',c.description,
           'done', (SELECT count(DISTINCT x.restaurant_id) FROM public.xp_ledger x
                     JOIN public.restaurants r ON r.id = x.restaurant_id
                    WHERE x.diner_id = v_me
                      AND x.rule_code IN ('order_dine_in','order_pickup','order_delivery')
                      AND lower(COALESCE(r.business_type,'')) IN (SELECT lower(mt.v) FROM unnest(c.match_types) AS mt(v))
                      AND (c.match_city IS NULL OR lower(COALESCE(r.city,'')) = lower(c.match_city))),
           'total', COALESCE(c.target_count, (SELECT count(*) FROM public.restaurants r
                     WHERE COALESCE(r.is_active,true)
                       AND lower(COALESCE(r.business_type,'')) IN (SELECT lower(mt.v) FROM unnest(c.match_types) AS mt(v))
                       AND (c.match_city IS NULL OR lower(COALESCE(r.city,'')) = lower(c.match_city))))
         ) ORDER BY c.sort_order), '[]'::jsonb)
    INTO v_coll FROM public.diner_collections c WHERE c.is_active;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'code',ch.code,'name',ch.name,'emoji',ch.emoji,'description',ch.description,
           'period',ch.period,'goal',ch.goal_value,'reward_xp',ch.reward_xp,
           'claimed', EXISTS (SELECT 1 FROM public.diner_challenge_claims cc
                               WHERE cc.diner_id=v_me AND cc.challenge_id=ch.id
                                 AND cc.period_key = CASE ch.period
                                       WHEN 'week'  THEN to_char(now() AT TIME ZONE 'America/Asuncion','IYYY"-W"IW')
                                       WHEN 'month' THEN to_char(now() AT TIME ZONE 'America/Asuncion','YYYY-MM')
                                       ELSE 'once' END)
         ) ORDER BY ch.sort_order), '[]'::jsonb)
    INTO v_chal FROM public.diner_challenges ch WHERE ch.is_active;

  -- El puesto sale de UNA pasada agregada. Llamar diner_total_xp() por cada
  -- comensal (que a su vez consulta el libro) daría el número correcto hoy y
  -- se volvería impagable en cuanto la comunidad crezca — justo el error que
  -- las migs 197 y 198 ya tuvieron que arreglar dos veces.
  WITH tot AS (
    SELECT d2.id, d2.city,
           COALESCE((SELECT sum(x.xp) FROM public.xp_ledger x
                      WHERE x.diner_id = d2.id
                         OR x.customer_id IN (SELECT l.customer_id
                                                FROM public.diner_customer_links l
                                               WHERE l.diner_id = d2.id)), 0) AS xp
      FROM public.diners d2
     WHERE d2.status = 'active'
  )
  SELECT jsonb_build_object(
    'country', (SELECT count(*)+1 FROM tot WHERE tot.xp > v_xp),
    'city',    CASE WHEN v_d.city IS NULL THEN NULL ELSE
                 (SELECT count(*)+1 FROM tot
                   WHERE lower(COALESCE(tot.city,'')) = lower(v_d.city) AND tot.xp > v_xp) END,
    'city_name', v_d.city
  ) INTO v_rank;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'restaurant_id', f.restaurant_id, 'item_id', f.item_id,
           'name', r.name, 'logo_url', r.logo_url, 'label', f.label)), '[]'::jsonb)
    INTO v_fav FROM public.diner_favorites f
    JOIN public.restaurants r ON r.id = f.restaurant_id
   WHERE f.diner_id = v_me;

  RETURN jsonb_build_object(
    'ok', true,
    'diner', jsonb_build_object(
      'id', v_d.id, 'display_name', v_d.display_name, 'avatar_url', v_d.avatar_url,
      'city', v_d.city, 'bio', v_d.bio, 'member_since', to_char(v_d.created_at,'YYYY'),
      'email', v_d.email),
    'xp', v_xp,
    'level', v_lvl.level, 'level_name', v_lvl.name,
    'level_min_xp', v_lvl.min_xp, 'next_level_xp', v_lvl.next_min_xp,
    'review_weight', v_lvl.review_weight,
    'credibility', public.diner_credibility(v_me),
    'stats', v_stats, 'badges', v_badges, 'collections', v_coll,
    'challenges', v_chal, 'rank', v_rank, 'favorites', v_fav);
END;
$$;

-- ── Ranking ────────────────────────────────────────────────────────────
-- Se agrega en la BASE, nunca en el navegador: la app carga con .limit() y
-- ordenar eso del lado del cliente daría un ranking que empeora cuanto más
-- crece la comunidad — el mismo error que las migs 197 y 198 tuvieron que
-- arreglar. Sólo aparece quien tiene actividad: un ranking lleno de cuentas
-- en cero no es un ranking.
CREATE OR REPLACE FUNCTION public.diner_leaderboard(
  p_scope  text DEFAULT 'country',   -- country | city
  p_period text DEFAULT 'all',       -- all | month
  p_city   text DEFAULT NULL,
  p_limit  int  DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_me    uuid := public.my_diner_id();
  v_from  timestamptz := CASE WHEN p_period = 'month'
             THEN date_trunc('month', now() AT TIME ZONE 'America/Asuncion') AT TIME ZONE 'America/Asuncion'
             ELSE '-infinity'::timestamptz END;
  v_city  text := COALESCE(NULLIF(btrim(p_city),''), (SELECT city FROM public.diners WHERE id = v_me));
  v_rows  jsonb;
  v_mine  jsonb;
  v_total int;
BEGIN
  IF NOT COALESCE((SELECT ranking_enabled FROM public.diner_app_config WHERE id), false) THEN
    RETURN jsonb_build_object('enabled', false, 'rows', '[]'::jsonb);
  END IF;

  -- Todo en CTEs, sin tabla temporal: una TEMP TABLE es DDL y PostgreSQL la
  -- rechaza dentro de una función no-VOLATILE ("INSERT is not allowed in a
  -- non-volatile function"). Y bajarla a VOLATILE sería peor: perdería el
  -- caching del planificador en una consulta que se lee mucho más de lo que
  -- cambia.
  WITH board AS (
    SELECT d.id AS diner_id,
           COALESCE(d.display_name,'Comensal') AS name,
           d.avatar_url AS avatar, d.city,
           COALESCE((SELECT sum(x.xp) FROM public.xp_ledger x
                      WHERE (x.diner_id = d.id
                             OR x.customer_id IN (SELECT l.customer_id
                                                    FROM public.diner_customer_links l
                                                   WHERE l.diner_id = d.id))
                        AND x.created_at >= v_from), 0)::int AS xp,
           COALESCE((SELECT count(*) FROM public.diner_reviews r
                      WHERE r.diner_id = d.id AND r.status='approved'
                        AND r.created_at >= v_from), 0)::int AS reviews
      FROM public.diners d
     WHERE d.status = 'active'
       AND (p_scope <> 'city' OR (v_city IS NOT NULL AND lower(COALESCE(d.city,'')) = lower(v_city)))
  ), ranked AS (
    SELECT b.*, row_number() OVER (ORDER BY b.xp DESC, b.reviews DESC, b.name) AS pos
      FROM board b
     WHERE b.xp > 0     -- un ranking lleno de cuentas en cero no es un ranking
  )
  SELECT
    (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'position', t.pos, 'diner_id', t.diner_id, 'name', t.name,
        'avatar', t.avatar, 'city', t.city, 'xp', t.xp, 'reviews', t.reviews,
        'level',      (SELECT lv.level FROM public.xp_level_of(t.xp) lv),
        'level_name', (SELECT lv.name  FROM public.xp_level_of(t.xp) lv),
        'is_me', t.diner_id = v_me) ORDER BY t.pos), '[]'::jsonb)
       FROM (SELECT * FROM ranked ORDER BY pos LIMIT GREATEST(COALESCE(p_limit,50),1)) t),
    (SELECT jsonb_build_object('position', m.pos, 'xp', m.xp, 'reviews', m.reviews)
       FROM ranked m WHERE m.diner_id = v_me),
    (SELECT count(*) FROM ranked)
  INTO v_rows, v_mine, v_total;

  RETURN jsonb_build_object('enabled', true, 'scope', p_scope, 'period', p_period,
                            'city', v_city, 'rows', COALESCE(v_rows,'[]'::jsonb),
                            'me', v_mine, 'total', COALESCE(v_total,0));
END;
$$;

-- ── Favoritos ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.diner_toggle_favorite(p_restaurant uuid, p_item int DEFAULT NULL, p_label text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_me uuid := public.my_diner_id(); v_del int;
BEGIN
  IF v_me IS NULL THEN RETURN false; END IF;
  DELETE FROM public.diner_favorites
   WHERE diner_id = v_me AND restaurant_id = p_restaurant
     AND COALESCE(item_id,-1) = COALESCE(p_item,-1);
  GET DIAGNOSTICS v_del = ROW_COUNT;
  IF v_del > 0 THEN RETURN false; END IF;
  INSERT INTO public.diner_favorites (diner_id, restaurant_id, item_id, label)
  VALUES (v_me, p_restaurant, p_item, p_label);
  RETURN true;
END;
$$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- 13) SUPERADMIN — todo lo del panel de clientes se ve y se edita desde acá
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE OR REPLACE FUNCTION public.superadmin_diner_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_out jsonb;
BEGIN
  IF public.get_my_role() <> 'superadmin' THEN
    RAISE EXCEPTION 'solo superadmin' USING ERRCODE='42501';
  END IF;

  SELECT jsonb_build_object(
    'diners_total',    (SELECT count(*) FROM public.diners),
    'diners_active',   (SELECT count(*) FROM public.diners WHERE status='active'),
    'diners_onboarded',(SELECT count(*) FROM public.diners WHERE onboarded_at IS NOT NULL),
    'diners_30d',      (SELECT count(*) FROM public.diners WHERE created_at >= now() - interval '30 days'),
    'links_total',     (SELECT count(*) FROM public.diner_customer_links),
    'xp_total',        (SELECT COALESCE(sum(xp),0) FROM public.xp_ledger),
    'reviews_total',   (SELECT count(*) FROM public.diner_reviews),
    'reviews_pending', (SELECT count(*) FROM public.diner_reviews WHERE status='pending'),
    'photos_pending',  (SELECT count(*) FROM public.diner_review_photos WHERE status='pending'),
    'recovery_pending',(SELECT count(*) FROM public.diner_recovery_requests WHERE status='pending'),
    'avg_stars',       (SELECT round(avg(stars)::numeric,2) FROM public.diner_reviews WHERE status='approved'),
    'top_diners', (SELECT COALESCE(jsonb_agg(q), '[]'::jsonb) FROM (
        SELECT d.id, d.display_name, d.email, d.city,
               public.diner_total_xp(d.id) AS xp,
               public.diner_credibility(d.id) AS credibility,
               (SELECT lv.name FROM public.xp_level_of(public.diner_total_xp(d.id)) lv) AS level_name,
               (SELECT count(*) FROM public.diner_reviews r WHERE r.diner_id=d.id AND r.status='approved') AS reviews
          FROM public.diners d
         ORDER BY public.diner_total_xp(d.id) DESC LIMIT 25) q),
    'by_city', (SELECT COALESCE(jsonb_agg(q), '[]'::jsonb) FROM (
        SELECT COALESCE(NULLIF(btrim(city),''),'(sin ciudad)') AS city, count(*) AS n
          FROM public.diners GROUP BY 1 ORDER BY n DESC LIMIT 15) q)
  ) INTO v_out;

  RETURN v_out;
END;
$$;

-- Analítica del registro de gustos. MISMO criterio que form_analytics de la
-- mig 198: se dibuja el formulario con su forma original —todas las opciones,
-- incluidas las que nadie eligió— y los conteos salen de la BASE. Agrupar en
-- el navegador daría un número que empeora cuanto más crece el negocio.
CREATE OR REPLACE FUNCTION public.diner_profile_analytics(
  p_from timestamptz DEFAULT NULL,
  p_to   timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_from timestamptz := COALESCE(p_from, '-infinity'::timestamptz);
  v_to   timestamptz := COALESCE(p_to,   'infinity'::timestamptz);
  v_out  jsonb;
BEGIN
  IF public.get_my_role() <> 'superadmin' THEN
    RAISE EXCEPTION 'solo superadmin' USING ERRCODE='42501';
  END IF;

  WITH scope AS (
    SELECT d.id FROM public.diners d WHERE d.created_at BETWEEN v_from AND v_to
  ),
  -- Una respuesta 'multi' es un array: se desarma para contar por opción.
  -- Va como UNION y no como CASE porque jsonb_array_elements_text() devuelve
  -- un CONJUNTO y PostgreSQL no admite funciones que devuelven conjuntos
  -- dentro de un CASE ("set-returning functions are not allowed in CASE").
  flat AS (
    SELECT a.code, jsonb_array_elements_text(a.value) AS opt
      FROM public.diner_profile_answers a
      JOIN scope s ON s.id = a.diner_id
     WHERE jsonb_typeof(a.value) = 'array'
    UNION ALL
    SELECT a.code, a.value #>> '{}' AS opt
      FROM public.diner_profile_answers a
      JOIN scope s ON s.id = a.diner_id
     WHERE jsonb_typeof(a.value) <> 'array'
  ),
  counted AS (
    SELECT code, COALESCE(NULLIF(btrim(opt),''),'(vacío)') AS opt, count(*) AS n
      FROM flat GROUP BY 1,2
  )
  SELECT jsonb_build_object(
    'answered', (SELECT count(DISTINCT diner_id) FROM public.diner_profile_answers a
                  JOIN scope s ON s.id = a.diner_id),
    'total',    (SELECT count(*) FROM scope),
    'questions', COALESCE(jsonb_agg(jsonb_build_object(
        'code', q.code, 'label', q.label, 'kind', q.kind, 'step', q.step,
        'answers', (SELECT COALESCE(sum(c.n),0) FROM counted c WHERE c.code = q.code),
        'options', CASE
          WHEN q.kind IN ('single','multi') THEN (
            -- Las opciones definidas SIEMPRE aparecen, con 0 si nadie las eligió:
            -- una opción que nadie usa es información, no una fila que falta.
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                     'value', o->>'value', 'label', o->>'label', 'emoji', o->>'emoji',
                     'n', COALESCE((SELECT c.n FROM counted c WHERE c.code=q.code AND c.opt = o->>'value'),0))
                   ORDER BY COALESCE((SELECT c.n FROM counted c WHERE c.code=q.code AND c.opt = o->>'value'),0) DESC), '[]'::jsonb)
              FROM jsonb_array_elements(q.options) o)
          ELSE (
            SELECT COALESCE(jsonb_agg(jsonb_build_object('value', c.opt, 'label', c.opt, 'n', c.n)
                   ORDER BY c.n DESC), '[]'::jsonb)
              FROM (SELECT * FROM counted c2 WHERE c2.code = q.code ORDER BY c2.n DESC LIMIT 20) c)
          END
      ) ORDER BY q.step, q.sort_order), '[]'::jsonb)
  ) INTO v_out
  FROM public.diner_profile_questions q
  WHERE q.is_active;

  RETURN v_out;
END;
$$;

-- Cola de moderación (reseñas y fotos) para Superadmin › Comensales.
CREATE OR REPLACE FUNCTION public.superadmin_review_queue(p_status text DEFAULT 'pending', p_limit int DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF public.get_my_role() <> 'superadmin' THEN
    RAISE EXCEPTION 'solo superadmin' USING ERRCODE='42501';
  END IF;

  RETURN jsonb_build_object(
    'reviews', (SELECT COALESCE(jsonb_agg(q ORDER BY q.created_at DESC), '[]'::jsonb) FROM (
        SELECT r.id, r.stars, r.comment, r.status, r.created_at, r.service_type,
               r.helpful_count, r.weight, r.restaurant_reply,
               rest.name AS restaurant_name,
               COALESCE(d.display_name,'Comensal') AS author, d.email AS author_email,
               public.diner_credibility(r.diner_id) AS author_credibility,
               (SELECT COALESCE(jsonb_object_agg(s.dimension, s.stars),'{}'::jsonb)
                  FROM public.diner_review_scores s WHERE s.review_id = r.id) AS scores
          FROM public.diner_reviews r
          JOIN public.restaurants rest ON rest.id = r.restaurant_id
          LEFT JOIN public.diners d ON d.id = r.diner_id
         WHERE p_status = 'all' OR r.status = p_status
         ORDER BY r.created_at DESC LIMIT GREATEST(COALESCE(p_limit,100),1)) q),
    'photos', (SELECT COALESCE(jsonb_agg(q ORDER BY q.created_at DESC), '[]'::jsonb) FROM (
        SELECT p.id, p.storage_path, p.caption, p.status, p.created_at,
               rest.name AS restaurant_name, COALESCE(d.display_name,'Comensal') AS author
          FROM public.diner_review_photos p
          JOIN public.diner_reviews r ON r.id = p.review_id
          JOIN public.restaurants rest ON rest.id = r.restaurant_id
          LEFT JOIN public.diners d ON d.id = p.diner_id
         WHERE p_status = 'all' OR p.status = p_status
         ORDER BY p.created_at DESC LIMIT GREATEST(COALESCE(p_limit,100),1)) q)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.superadmin_moderate(
  p_kind text, p_id uuid, p_status text, p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_diner uuid; v_rest uuid;
BEGIN
  IF public.get_my_role() <> 'superadmin' THEN
    RAISE EXCEPTION 'solo superadmin' USING ERRCODE='42501';
  END IF;

  IF p_kind = 'review' THEN
    IF p_status NOT IN ('approved','rejected','hidden','pending') THEN
      RETURN jsonb_build_object('ok',false,'error','estado inválido');
    END IF;
    UPDATE public.diner_reviews
       SET status = p_status, moderation_note = p_note,
           moderated_by = auth.uid(), moderated_at = now()
     WHERE id = p_id;
  ELSIF p_kind = 'photo' THEN
    IF p_status NOT IN ('approved','rejected','pending') THEN
      RETURN jsonb_build_object('ok',false,'error','estado inválido');
    END IF;
    UPDATE public.diner_review_photos
       SET status = p_status, moderated_by = auth.uid(), moderated_at = now()
     WHERE id = p_id
    RETURNING diner_id INTO v_diner;
    -- El XP por foto se acredita SÓLO al aprobarla: si no, subir basura pagaría.
    IF p_status = 'approved' AND v_diner IS NOT NULL THEN
      SELECT r.restaurant_id INTO v_rest FROM public.diner_review_photos p
        JOIN public.diner_reviews r ON r.id = p.review_id WHERE p.id = p_id;
      BEGIN PERFORM public.award_xp('review_photo', v_diner, NULL, v_rest, NULL, NULL, NULL, 1, 0, p_id::text);
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;
  ELSE
    RETURN jsonb_build_object('ok',false,'error','tipo inválido');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Ajuste manual de XP (soporte). Se anota como fila, nunca se edita el pasado.
CREATE OR REPLACE FUNCTION public.superadmin_adjust_xp(p_diner uuid, p_xp int, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF public.get_my_role() <> 'superadmin' THEN
    RAISE EXCEPTION 'solo superadmin' USING ERRCODE='42501';
  END IF;
  IF p_xp = 0 THEN RETURN jsonb_build_object('ok',false,'error','El ajuste no puede ser 0.'); END IF;
  INSERT INTO public.xp_ledger (diner_id, xp, rule_code, note)
  VALUES (p_diner, p_xp, 'adjust', COALESCE(p_note,'ajuste de soporte'));
  RETURN jsonb_build_object('ok', true, 'total', public.diner_total_xp(p_diner));
END;
$$;

-- Top clientes de UN restaurante — para Admin/Gerente. Es el incentivo del
-- lado del local: ver quiénes son sus mejores comensales para poder premiarlos.
-- Devuelve la ficha LOCAL, nunca la identidad global (§6): el local no puede
-- saber en qué otros restaurantes come esa persona.
CREATE OR REPLACE FUNCTION public.restaurant_top_diners(p_restaurant uuid, p_limit int DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF public.get_my_role() <> 'superadmin'
     AND p_restaurant NOT IN (SELECT public.get_my_company_restaurant_ids()) THEN
    RAISE EXCEPTION 'sin acceso a ese restaurante' USING ERRCODE='42501';
  END IF;

  RETURN (SELECT COALESCE(jsonb_agg(q ORDER BY q.xp_local DESC), '[]'::jsonb) FROM (
    SELECT c.id AS customer_id, c.full_name, c.phone,
           COALESCE(sum(x.xp),0)::int AS xp_local,
           count(DISTINCT x.order_id) AS orders,
           (SELECT count(*) FROM public.diner_reviews r
             WHERE r.customer_id = c.id AND r.status='approved') AS reviews,
           EXISTS (SELECT 1 FROM public.diner_customer_links l WHERE l.customer_id = c.id) AS has_app
      FROM public.customers c
      LEFT JOIN public.xp_ledger x ON x.customer_id = c.id AND x.restaurant_id = p_restaurant
     WHERE c.restaurant_id = p_restaurant AND c.is_active
     GROUP BY c.id, c.full_name, c.phone
     HAVING COALESCE(sum(x.xp),0) > 0
     ORDER BY xp_local DESC
     LIMIT GREATEST(COALESCE(p_limit,20),1)) q);
END;
$$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- 14) GRANTS
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'diner_bootstrap()',
    'ensure_my_diner(text,text)',
    'diner_save_profile(jsonb)',
    'diner_issue_token(text)',
    'diner_discover(text,text,text,text,int)',
    'diner_my_orders(int)',
    'diner_submit_review(jsonb)',
    'diner_vote_review(uuid,text,boolean)',
    'diner_restaurant_reviews(uuid,int)',
    'restaurant_reply_review(uuid,text)',
    'restaurant_reviews_inbox(uuid,int)',
    'diner_refresh_achievements()',
    'diner_profile()',
    'diner_leaderboard(text,text,text,int)',
    'diner_toggle_favorite(uuid,int,text)',
    'staff_link_diner_code(text,uuid)',
    'restaurant_top_diners(uuid,int)',
    'superadmin_diner_overview()',
    'diner_profile_analytics(timestamptz,timestamptz)',
    'superadmin_review_queue(text,int)',
    'superadmin_moderate(text,uuid,text,text)',
    'superadmin_adjust_xp(uuid,int,text)',
    'diner_total_xp(uuid)',
    'diner_credibility(uuid)',
    'xp_level_of(int)',
    'diner_access_allowed(text)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
  END LOOP;
END$$;

-- award_xp y diner_claim_order NO se otorgan a nadie: sólo las llaman otras
-- funciones SECURITY DEFINER (create_order, moderación). Si un cliente
-- pudiera invocarlas se regalaría XP a sí mismo.
REVOKE ALL ON FUNCTION public.award_xp(text,uuid,uuid,uuid,uuid,uuid,uuid,int,numeric,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.diner_claim_order(text,uuid,uuid,uuid,uuid,text) FROM PUBLIC;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- 15) CAMINO A (§5.2) — el pedido queda vinculado apenas se crea
-- ────────────────────────────────────────────────────────────────────────
-- Si la persona está logueada en /clientes cuando pide (por el QR de la mesa
-- o por delivery), no hace falta verificar nada: está demostrablemente
-- haciendo el pedido. Costo cero, fricción cero, y es el camino que apaga
-- solo el problema del historial viejo con el paso del tiempo.
--
-- CÓMO VIAJA EL TOKEN — y por qué NO de las dos maneras obvias:
--
--   ✗ Compartir el storageKey de sesión con el QR (lo que proponía el §5.2).
--     Verificado en el código: `mi_auth_select` de menu_items (mig 086) exige
--     restaurant_id = get_my_restaurant_id(), y un comensal NO tiene fila en
--     user_roles → esa función devuelve NULL → el menú sale VACÍO. Rompería
--     el pedido, que es lo único que no se puede romper.
--
--   ✗ set_config() en una RPC previa + trigger que lo lee. PostgREST reusa
--     conexiones de un pool: con is_local=false el valor sobrevive al request
--     y el token de una persona se le aplicaría al pedido de OTRA. Con
--     is_local=true no sobrevive a la transacción, así que el trigger nunca
--     lo vería. No hay variante segura de esa idea.
--
--   ✓ Reclamo EXPLÍCITO después de crear el pedido. El panel ya recibe el id
--     del pedido de create_order; llama a esta RPC con su token de
--     dispositivo. Es una llamada más, best-effort: si falla, el pedido ya
--     entró y lo único que se pierde es el XP de esa vez. Un fallo de la capa
--     de identidad JAMÁS puede frenar un cobro — misma regla que el CRM.
--
-- Y NO reescribe create_order, que cambió en las migs 140/180/196: copiar su
-- cuerpo acá para agregarle un parámetro es la forma más fácil de pisar una
-- versión nueva con una vieja.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE OR REPLACE FUNCTION public.diner_claim_my_order(p_token text, p_order uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_ord   record;
  v_deliv uuid;
  v_svc   text;
  v_diner uuid;
BEGIN
  IF p_token IS NULL OR btrim(p_token) = '' OR p_order IS NULL THEN
    RETURN jsonb_build_object('ok', false);
  END IF;

  SELECT o.id, o.restaurant_id, o.customer_id, o.order_type, o.status,
         o.payment_status, o.created_at
    INTO v_ord FROM public.orders o WHERE o.id = p_order;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false); END IF;

  -- Ventana de reclamo. El id del pedido es un UUID (no se adivina), pero si
  -- alguno se filtra —una captura de pantalla, un link compartido— sin esta
  -- ventana quedaría reclamable para siempre.
  IF v_ord.created_at < now() - interval '6 hours' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'vencido');
  END IF;

  -- Ya reclamado por otra persona: no se roba un pedido ajeno.
  IF EXISTS (SELECT 1 FROM public.xp_ledger x
              WHERE x.order_id = p_order AND x.diner_id IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ya_reclamado');
  END IF;

  IF NOT (v_ord.status IN ('paid','confirmed','kitchen_received','cooking','ready','delivered')
          OR COALESCE(v_ord.payment_status,'') = 'paid') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_pagado');
  END IF;

  SELECT d.id INTO v_deliv FROM public.delivery_orders d WHERE d.order_id = p_order LIMIT 1;
  v_svc := CASE
             WHEN v_ord.order_type = 'delivery' THEN 'delivery'
             WHEN v_ord.order_type IN ('pickup','llevar','take') THEN 'pickup'
             ELSE 'dine_in' END;

  BEGIN
    v_diner := public.diner_claim_order(btrim(p_token), v_ord.restaurant_id,
                                        v_ord.customer_id, p_order, v_deliv, v_svc);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false);
  END;

  IF v_diner IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'token'); END IF;

  RETURN jsonb_build_object('ok', true, 'xp_total', public.diner_total_xp(v_diner));
END;
$$;

-- anon TAMBIÉN puede llamarla: el QR de mesa y el delivery corren como anon
-- (ver arriba por qué no se les cambia la sesión). La autorización no la da
-- el rol sino el TOKEN, que sólo tiene el navegador de esa persona.
REVOKE ALL ON FUNCTION public.diner_claim_my_order(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.diner_claim_my_order(text,uuid) TO anon, authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- 16) VERIFICACIÓN (correr después de aplicar)
-- ════════════════════════════════════════════════════════════════════════
-- 1) Tablas creadas (esperado: 23)
--    SELECT count(*) FROM information_schema.tables
--     WHERE table_schema='public'
--       AND (table_name LIKE 'diner%' OR table_name LIKE 'xp_%' OR table_name='review_dimensions');
--
-- 2) anon NO llega a nada de esto (esperado: 0 filas)
--    SELECT table_name, privilege_type FROM information_schema.role_table_grants
--     WHERE grantee='anon'
--       AND (table_name LIKE 'diner%' OR table_name LIKE 'xp_%' OR table_name='review_dimensions');
--
-- 3) Toda función nueva con search_path fijo (esperado: 0 filas)
--    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--     WHERE n.nspname='public' AND p.prosecdef
--       AND (p.proname LIKE 'diner%' OR p.proname LIKE 'xp_%' OR p.proname='award_xp')
--       AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) c WHERE c LIKE 'search_path=%');
--
-- 4) La beta está cerrada y con los dos correos
--    SELECT is_public FROM diner_app_config;                     -- false
--    SELECT email, is_active FROM diner_app_access ORDER BY email;
--
-- 5) Nada se movió: las tablas nuevas arrancan vacías
--    SELECT (SELECT count(*) FROM diners)     AS diners,
--           (SELECT count(*) FROM xp_ledger)  AS xp,
--           (SELECT count(*) FROM diner_reviews) AS reviews;     -- 0, 0, 0
--
-- 6) Catálogos sembrados
--    SELECT count(*) FROM xp_rules;                 -- 12
--    SELECT count(*) FROM xp_levels;                -- 30
--    SELECT count(*) FROM review_dimensions;        -- 8
--    SELECT count(*) FROM diner_profile_questions;  -- 12
-- ════════════════════════════════════════════════════════════════════════
