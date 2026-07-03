-- ════════════════════════════════════════════════════════════════════
-- 142 · marketplace_proveedores — Marketplace B2B "Proveedores" FASE 1
-- ────────────────────────────────────────────────────────────────────
-- PR-MKT-1. Fundación de datos del marketplace que conecta restaurantes
-- (compradores) con proveedores gastronómicos (vendedores). Mythos es SOLO
-- puente: leads, cotizaciones y chat. Sin pagos, sin carrito, sin garantías.
-- El contacto del proveedor NUNCA se lee directo: se revela vía RPC
-- request_supplier_contact() que registra el lead primero (core del negocio);
-- después del primer lead, la RLS de marketplace_supplier_contacts permite
-- la lectura directa a ese restaurante (y solo a ese).
--
-- ⚠️ NAMING: el spec original pedía tablas `suppliers`, `supplier_contacts`,
-- etc., pero public.suppliers / public.supplier_contacts YA EXISTEN desde la
-- migración 072 (proveedores internos del panel gerente, otro dominio).
-- Para no colisionar, TODAS las tablas nuevas llevan prefijo `marketplace_`.
-- Las RPCs, el rol 'supplier' y los buckets mantienen los nombres del spec.
--
-- Contenido:
--   1. Rol 'supplier' en user_roles (constraint 049 recreado) + admin_update_user_role
--   2. 14 tablas marketplace_* (RLS habilitada en todas)
--   3. get_my_supplier_id() + triggers (updated_at, guards fail-closed, contadores chat)
--   4. RLS fail-closed (patrón migs 129-134): anon CERO acceso; supplier solo lo suyo;
--      restaurante scoped por get_my_company_restaurant_ids(); superadmin todo
--   5. RPCs SECURITY DEFINER (patrón 131/135): submit_supplier_application (única
--      puerta anon), request_supplier_contact, create_supplier_quote,
--      get_my_supplier_leads_info
--   6. Storage: buckets supplier-images (público) y supplier-files (privado),
--      escritura scoped por carpeta = supplier_id
--   7. Realtime: marketplace_messages
--   8. Seed: 16 categorías + demo QA [SIM] (application pendiente + supplier activo
--      con 6 productos). El usuario Auth del demo NO se crea acá: se crea al
--      aprobar la application vía POST /api/approve-supplier.
--
-- PREPARED — NOT APPLIED: aplicar A MANO en el SQL Editor del dashboard
-- (idioma en inglés) después de un backup. Idempotente (re-ejecutable).
-- Revertir: DROP de las tablas/funciones/policies marketplace_* + restaurar
-- constraint de roles de la mig 049 (el rol 'supplier' no se usa en tablas core).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. Rol 'supplier' ──────────────────────────────────────────────
-- Suppliers usan restaurant_id = NULL (como superadmin). Con eso:
--   · get_my_restaurant_id() → NULL (no ve datos de ningún restaurante)
--   · get_my_company_restaurant_ids() → conjunto vacío (fail-closed, mig 092)

ALTER TABLE public.user_roles
  DROP CONSTRAINT IF EXISTS user_roles_role_check;

ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_role_check
  CHECK (role IN ('cocina','admin','superadmin','cajero','mozo','delivery','rider','supervisor_local','supplier'));

-- admin_update_user_role valida la misma lista server-side (mig 049) → recrear con 'supplier'.
CREATE OR REPLACE FUNCTION public.admin_update_user_role(
  p_user_id       UUID,
  p_role          TEXT,
  p_restaurant_id UUID DEFAULT NULL,
  p_display_name  TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.get_my_role() <> 'superadmin' THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  IF p_role NOT IN ('cocina','admin','superadmin','cajero','mozo','delivery','rider','supervisor_local','supplier') THEN
    RAISE EXCEPTION 'Rol inválido: %', p_role;
  END IF;

  UPDATE public.user_roles
  SET    role          = p_role,
         restaurant_id = p_restaurant_id,
         display_name  = COALESCE(p_display_name, display_name)
  WHERE  user_id = p_user_id;

  RETURN json_build_object('user_id', p_user_id, 'role', p_role);
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_update_user_role TO authenticated;

-- ─── 2. Tablas ──────────────────────────────────────────────────────

-- 2.1 Solicitudes públicas del formulario web (molde: leads_prospectos, mig 117)
CREATE TABLE IF NOT EXISTS public.marketplace_applications (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre_comercial       text NOT NULL,
  razon_social           text,
  ruc                    text,
  tipo_proveedor         text CHECK (tipo_proveedor IS NULL OR tipo_proveedor IN
                           ('productor','distribuidor','mayorista','minorista','importador','fabricante','servicio')),
  rubro_principal        text,
  anhos_mercado          int,
  ciudad                 text,
  departamento           text,
  direccion              text,
  web_redes              text,
  contacto_nombre        text,
  contacto_cargo         text,
  telefono               text,
  whatsapp               text,
  email                  text,
  categorias             text[] NOT NULL DEFAULT '{}',
  productos_principales  text,
  marcas                 text,
  vende_mayor            boolean NOT NULL DEFAULT false,
  vende_menor            boolean NOT NULL DEFAULT false,
  zonas_entrega          text[] NOT NULL DEFAULT '{}',
  delivery_propio        boolean NOT NULL DEFAULT false,
  retiro_local           boolean NOT NULL DEFAULT false,
  dias_entrega           text,
  pedido_minimo          text,
  entrega_urgente        boolean NOT NULL DEFAULT false,
  acepta_credito         boolean NOT NULL DEFAULT false,
  emite_factura          boolean NOT NULL DEFAULT false,
  precio_visible         boolean NOT NULL DEFAULT false,
  acepta_nuevos_clientes boolean NOT NULL DEFAULT true,
  catalogo_url           text,
  mensaje                text,
  acepta_terminos        boolean NOT NULL DEFAULT false,
  estado                 text NOT NULL DEFAULT 'pendiente' CHECK (estado IN
                           ('pendiente','en_revision','falta_info','aprobada','rechazada')),
  notas_internas         text,
  origen                 text NOT NULL DEFAULT 'web',
  reviewed_at            timestamptz,
  reviewed_by            uuid,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mkp_applications_estado
  ON public.marketplace_applications (estado, created_at DESC);

-- 2.2 Categorías del marketplace
CREATE TABLE IF NOT EXISTS public.marketplace_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  nombre      text NOT NULL,
  orden       int NOT NULL DEFAULT 0,
  activa      boolean NOT NULL DEFAULT true,
  parent_slug text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 2.3 Perfil de tienda aprobada
CREATE TABLE IF NOT EXISTS public.marketplace_suppliers (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                    text NOT NULL UNIQUE,
  nombre_comercial        text NOT NULL,
  razon_social            text,
  ruc                     text,
  tipo_proveedor          text CHECK (tipo_proveedor IS NULL OR tipo_proveedor IN
                            ('productor','distribuidor','mayorista','minorista','importador','fabricante','servicio')),
  descripcion             text,
  logo_url                text,
  banner_url              text,
  ciudad                  text,
  departamento            text,
  categorias              text[] NOT NULL DEFAULT '{}',   -- slugs de marketplace_categories
  zonas_entrega           text[] NOT NULL DEFAULT '{}',
  dias_entrega            text,
  horario_atencion        text,
  pedido_minimo           text,
  delivery_propio         boolean NOT NULL DEFAULT false,
  retiro_local            boolean NOT NULL DEFAULT false,
  entrega_urgente         boolean NOT NULL DEFAULT false,
  acepta_credito          boolean NOT NULL DEFAULT false,
  emite_factura           boolean NOT NULL DEFAULT false,
  condiciones_comerciales text,
  verificado              boolean NOT NULL DEFAULT false,
  destacado               boolean NOT NULL DEFAULT false,
  plan                    text NOT NULL DEFAULT 'fundador' CHECK (plan IN ('fundador','basico','pro')),
  estado                  text NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','pausado','suspendido')),
  application_id          uuid REFERENCES public.marketplace_applications(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mkp_suppliers_estado
  ON public.marketplace_suppliers (estado, destacado DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mkp_suppliers_categorias
  ON public.marketplace_suppliers USING gin (categorias);

-- 2.4 Contacto del proveedor — tabla SEPARADA a propósito: RLS más dura que
--     marketplace_suppliers (solo se lee tras registrar un lead).
CREATE TABLE IF NOT EXISTS public.marketplace_supplier_contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id     uuid NOT NULL UNIQUE REFERENCES public.marketplace_suppliers(id) ON DELETE CASCADE,
  telefono        text,
  whatsapp        text,
  email_comercial text,
  contacto_nombre text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 2.5 Usuarios del proveedor (login con rol 'supplier', restaurant_id NULL)
CREATE TABLE IF NOT EXISTS public.marketplace_supplier_users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES public.marketplace_suppliers(id) ON DELETE CASCADE,
  rol_interno text NOT NULL DEFAULT 'owner' CHECK (rol_interno IN ('owner','ventas')),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mkp_supplier_users_supplier
  ON public.marketplace_supplier_users (supplier_id);

-- 2.6 Productos del catálogo
CREATE TABLE IF NOT EXISTS public.marketplace_products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id    uuid NOT NULL REFERENCES public.marketplace_suppliers(id) ON DELETE CASCADE,
  nombre         text NOT NULL,
  categoria_slug text,                                    -- FK-like a marketplace_categories.slug
  etiquetas      text[] NOT NULL DEFAULT '{}',
  marca          text,
  presentacion   text,                                    -- ej. "caja 20 kg"
  unidad         text CHECK (unidad IS NULL OR unidad IN
                   ('kg','unidad','caja','pack','bolsa','litro','bidon','docena','otro')),
  precio         numeric,
  precio_tipo    text NOT NULL DEFAULT 'cotizar' CHECK (precio_tipo IN ('visible','desde','cotizar')),
  pedido_minimo  text,
  disponibilidad text,
  imagen_url     text,
  descripcion    text,
  estado         text NOT NULL DEFAULT 'borrador' CHECK (estado IN
                   ('borrador','publicado','pausado','oculto_admin')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mkp_products_supplier
  ON public.marketplace_products (supplier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mkp_products_publicados
  ON public.marketplace_products (categoria_slug, created_at DESC) WHERE estado = 'publicado';

-- 2.7 Archivos de catálogo (PDF/Excel/imagen subidos al bucket supplier-files)
CREATE TABLE IF NOT EXISTS public.marketplace_catalog_files (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES public.marketplace_suppliers(id) ON DELETE CASCADE,
  nombre      text NOT NULL,
  file_url    text NOT NULL,
  tipo        text NOT NULL DEFAULT 'otro' CHECK (tipo IN ('pdf','excel','imagen','otro')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mkp_catalog_files_supplier
  ON public.marketplace_catalog_files (supplier_id);

-- 2.8 Leads — EL NÚCLEO del modelo de negocio
CREATE TABLE IF NOT EXISTS public.marketplace_leads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  supplier_id    uuid NOT NULL REFERENCES public.marketplace_suppliers(id) ON DELETE CASCADE,
  tipo           text NOT NULL CHECK (tipo IN ('contacto','cotizacion')),
  product_id     uuid REFERENCES public.marketplace_products(id) ON DELETE SET NULL,
  producto_texto text,
  cantidad       text,
  frecuencia     text CHECK (frecuencia IS NULL OR frecuencia IN ('unica','semanal','mensual','a_definir')),
  mensaje        text,
  canal          text NOT NULL DEFAULT 'marketplace',
  estado         text NOT NULL DEFAULT 'nueva' CHECK (estado IN
                   ('nueva','respondida','negociando','cerrada','perdida','archivada')),
  created_by     uuid,                                    -- auth.uid del staff que originó el lead
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mkp_leads_supplier
  ON public.marketplace_leads (supplier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mkp_leads_restaurant
  ON public.marketplace_leads (restaurant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mkp_leads_supplier_estado
  ON public.marketplace_leads (supplier_id, estado);

-- 2.9 Conversaciones (1 por par proveedor-restaurante)
CREATE TABLE IF NOT EXISTS public.marketplace_conversations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id       uuid NOT NULL REFERENCES public.marketplace_suppliers(id) ON DELETE CASCADE,
  restaurant_id     uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  last_message_at   timestamptz,
  restaurant_unread int NOT NULL DEFAULT 0,
  supplier_unread   int NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, restaurant_id)
);

CREATE INDEX IF NOT EXISTS idx_mkp_conversations_restaurant
  ON public.marketplace_conversations (restaurant_id, last_message_at DESC);

-- 2.10 Mensajes del chat
CREATE TABLE IF NOT EXISTS public.marketplace_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.marketplace_conversations(id) ON DELETE CASCADE,
  sender          text NOT NULL CHECK (sender IN ('restaurant','supplier')),
  sender_user     uuid,
  body            text NOT NULL,
  attachment_url  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mkp_messages_conversation
  ON public.marketplace_messages (conversation_id, created_at);

-- 2.11 Guardados / favoritos del restaurante
CREATE TABLE IF NOT EXISTS public.marketplace_saved (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  supplier_id   uuid NOT NULL REFERENCES public.marketplace_suppliers(id) ON DELETE CASCADE,
  product_id    uuid REFERENCES public.marketplace_products(id) ON DELETE CASCADE,
  nota_interna  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- UNIQUE(restaurant_id, supplier_id, product_id) del spec: con product_id NULL
-- Postgres permitiría duplicados → dos índices únicos parciales.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mkp_saved_supplier
  ON public.marketplace_saved (restaurant_id, supplier_id) WHERE product_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mkp_saved_product
  ON public.marketplace_saved (restaurant_id, supplier_id, product_id) WHERE product_id IS NOT NULL;

-- 2.12 Reseñas (privadas por ahora: solo superadmin las lee; visible=false)
CREATE TABLE IF NOT EXISTS public.marketplace_reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  supplier_id   uuid NOT NULL REFERENCES public.marketplace_suppliers(id) ON DELETE CASCADE,
  rating        int NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comentario    text,
  visible       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, supplier_id)
);

-- 2.13 Reportes / denuncias
CREATE TABLE IF NOT EXISTS public.marketplace_reports (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_restaurant_id  uuid REFERENCES public.restaurants(id) ON DELETE SET NULL,
  reporter_supplier_id    uuid REFERENCES public.marketplace_suppliers(id) ON DELETE SET NULL,
  target_supplier_id      uuid REFERENCES public.marketplace_suppliers(id) ON DELETE SET NULL,
  target_product_id       uuid REFERENCES public.marketplace_products(id) ON DELETE SET NULL,
  tipo                    text NOT NULL CHECK (tipo IN
                            ('info_falsa','precio_enganoso','no_responde','mala_calidad',
                             'no_entrego','trato_indebido','spam','otro')),
  detalle                 text,
  estado                  text NOT NULL DEFAULT 'abierto' CHECK (estado IN
                            ('abierto','en_revision','resuelto','desestimado')),
  resolucion              text,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mkp_reports_estado
  ON public.marketplace_reports (estado, created_at DESC);

-- 2.14 Eventos (auditoría/stats del marketplace)
CREATE TABLE IF NOT EXISTS public.marketplace_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    text NOT NULL,
  supplier_id   uuid REFERENCES public.marketplace_suppliers(id) ON DELETE SET NULL,
  restaurant_id uuid REFERENCES public.restaurants(id) ON DELETE SET NULL,
  actor_user    uuid,
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mkp_events_supplier
  ON public.marketplace_events (supplier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mkp_events_type
  ON public.marketplace_events (event_type, created_at DESC);

-- ─── 3. Helpers y triggers ──────────────────────────────────────────

-- Identidad del proveedor logueado (NULL si el usuario no es supplier activo).
CREATE OR REPLACE FUNCTION public.get_my_supplier_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT su.supplier_id
  FROM public.marketplace_supplier_users su
  WHERE su.user_id = auth.uid() AND su.is_active = true
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.get_my_supplier_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_supplier_id() TO authenticated;

-- updated_at automático (helper set_updated_at de la mig 001)
DROP TRIGGER IF EXISTS trg_mkp_suppliers_updated_at ON public.marketplace_suppliers;
CREATE TRIGGER trg_mkp_suppliers_updated_at
  BEFORE UPDATE ON public.marketplace_suppliers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_mkp_products_updated_at ON public.marketplace_products;
CREATE TRIGGER trg_mkp_products_updated_at
  BEFORE UPDATE ON public.marketplace_products
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_mkp_leads_updated_at ON public.marketplace_leads;
CREATE TRIGGER trg_mkp_leads_updated_at
  BEFORE UPDATE ON public.marketplace_leads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Guard fail-closed: el proveedor edita su perfil pero NO los campos
-- administrados por la plataforma (identidad fiscal, plan, verificado,
-- destacado, slug) ni puede salir/entrar de 'suspendido'. SECURITY INVOKER
-- a propósito: current_user refleja el rol real (service_role/postgres pasan).
CREATE OR REPLACE FUNCTION public.marketplace_suppliers_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('postgres','supabase_admin','service_role')
     OR COALESCE(public.get_my_role() = 'superadmin', false) THEN
    RETURN NEW;
  END IF;

  IF NEW.slug             IS DISTINCT FROM OLD.slug
     OR NEW.nombre_comercial IS DISTINCT FROM OLD.nombre_comercial
     OR NEW.razon_social   IS DISTINCT FROM OLD.razon_social
     OR NEW.ruc            IS DISTINCT FROM OLD.ruc
     OR NEW.tipo_proveedor IS DISTINCT FROM OLD.tipo_proveedor
     OR NEW.verificado     IS DISTINCT FROM OLD.verificado
     OR NEW.destacado      IS DISTINCT FROM OLD.destacado
     OR NEW.plan           IS DISTINCT FROM OLD.plan
     OR NEW.application_id IS DISTINCT FROM OLD.application_id THEN
    RAISE EXCEPTION 'campo administrado por Mythos' USING ERRCODE = '42501';
  END IF;

  IF NEW.estado IS DISTINCT FROM OLD.estado
     AND (OLD.estado = 'suspendido' OR NEW.estado = 'suspendido') THEN
    RAISE EXCEPTION 'estado suspendido administrado por Mythos' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mkp_suppliers_guard ON public.marketplace_suppliers;
CREATE TRIGGER trg_mkp_suppliers_guard
  BEFORE UPDATE ON public.marketplace_suppliers
  FOR EACH ROW EXECUTE FUNCTION public.marketplace_suppliers_guard();

-- Guard de leads: el lado proveedor solo puede cambiar `estado` (gestión del
-- lead); el resto de los datos pertenecen al restaurante que lo creó.
CREATE OR REPLACE FUNCTION public.marketplace_leads_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('postgres','supabase_admin','service_role')
     OR COALESCE(public.get_my_role() = 'superadmin', false) THEN
    RETURN NEW;
  END IF;

  IF public.get_my_supplier_id() = OLD.supplier_id THEN
    IF (to_jsonb(NEW) - 'estado' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'estado' - 'updated_at') THEN
      RAISE EXCEPTION 'el proveedor solo puede actualizar el estado del lead' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mkp_leads_guard ON public.marketplace_leads;
CREATE TRIGGER trg_mkp_leads_guard
  BEFORE UPDATE ON public.marketplace_leads
  FOR EACH ROW EXECUTE FUNCTION public.marketplace_leads_guard();

-- Contadores del chat: cada mensaje toca last_message_at y el unread del lado
-- contrario. SECURITY DEFINER: el proveedor no tiene UPDATE directo sobre
-- marketplace_conversations y aun así su mensaje debe actualizar contadores.
CREATE OR REPLACE FUNCTION public.marketplace_messages_bump()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.marketplace_conversations
     SET last_message_at   = COALESCE(NEW.created_at, now()),
         restaurant_unread = restaurant_unread + (CASE WHEN NEW.sender = 'supplier'   THEN 1 ELSE 0 END),
         supplier_unread   = supplier_unread   + (CASE WHEN NEW.sender = 'restaurant' THEN 1 ELSE 0 END)
   WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mkp_messages_bump ON public.marketplace_messages;
CREATE TRIGGER trg_mkp_messages_bump
  AFTER INSERT ON public.marketplace_messages
  FOR EACH ROW EXECUTE FUNCTION public.marketplace_messages_bump();

-- ─── 4. RLS ─────────────────────────────────────────────────────────
-- anon: CERO acceso (única puerta anon = RPC submit_supplier_application).
-- Defensa en 2 capas (patrón 132): REVOKE de privilegio + sin policy anon.

ALTER TABLE public.marketplace_applications      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_categories        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_suppliers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_supplier_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_supplier_users    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_products          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_catalog_files     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_leads             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_conversations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_saved             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_reviews           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_reports           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_events            ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.marketplace_applications      FROM anon;
REVOKE ALL ON public.marketplace_categories        FROM anon;
REVOKE ALL ON public.marketplace_suppliers         FROM anon;
REVOKE ALL ON public.marketplace_supplier_contacts FROM anon;
REVOKE ALL ON public.marketplace_supplier_users    FROM anon;
REVOKE ALL ON public.marketplace_products          FROM anon;
REVOKE ALL ON public.marketplace_catalog_files     FROM anon;
REVOKE ALL ON public.marketplace_leads             FROM anon;
REVOKE ALL ON public.marketplace_conversations     FROM anon;
REVOKE ALL ON public.marketplace_messages          FROM anon;
REVOKE ALL ON public.marketplace_saved             FROM anon;
REVOKE ALL ON public.marketplace_reviews           FROM anon;
REVOKE ALL ON public.marketplace_reports           FROM anon;
REVOKE ALL ON public.marketplace_events            FROM anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketplace_applications      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketplace_categories        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketplace_suppliers         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketplace_supplier_contacts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketplace_supplier_users    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketplace_products          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketplace_catalog_files     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketplace_leads             TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketplace_conversations     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketplace_messages          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketplace_saved             TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketplace_reviews           TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketplace_reports           TO authenticated;
-- events: append-only vía funciones DEFINER/service_role; authenticated solo lee (RLS filtra).
REVOKE ALL ON public.marketplace_events FROM authenticated;
GRANT SELECT ON public.marketplace_events TO authenticated;

-- 4.1 applications — solo superadmin (el INSERT público entra por la RPC)
DROP POLICY IF EXISTS "mkp_applications_superadmin_all" ON public.marketplace_applications;
CREATE POLICY "mkp_applications_superadmin_all" ON public.marketplace_applications
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- 4.2 categories — catálogo legible por todo authenticated; gestión superadmin
DROP POLICY IF EXISTS "mkp_categories_auth_select" ON public.marketplace_categories;
CREATE POLICY "mkp_categories_auth_select" ON public.marketplace_categories
  FOR SELECT TO authenticated
  USING (activa = true OR public.get_my_role() = 'superadmin');

DROP POLICY IF EXISTS "mkp_categories_superadmin_all" ON public.marketplace_categories;
CREATE POLICY "mkp_categories_superadmin_all" ON public.marketplace_categories
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- 4.3 suppliers — supplier ve/edita SOLO su fila; restaurante ve solo activos;
--     un supplier NUNCA ve otros suppliers (no hay rama para él en el select
--     de restaurantes: get_my_company_restaurant_ids() le devuelve vacío).
DROP POLICY IF EXISTS "mkp_suppliers_supplier_select" ON public.marketplace_suppliers;
CREATE POLICY "mkp_suppliers_supplier_select" ON public.marketplace_suppliers
  FOR SELECT TO authenticated
  USING (id = public.get_my_supplier_id());

DROP POLICY IF EXISTS "mkp_suppliers_restaurant_select" ON public.marketplace_suppliers;
CREATE POLICY "mkp_suppliers_restaurant_select" ON public.marketplace_suppliers
  FOR SELECT TO authenticated
  USING (
    estado = 'activo'
    AND EXISTS (SELECT 1 FROM public.get_my_company_restaurant_ids())
  );

DROP POLICY IF EXISTS "mkp_suppliers_supplier_update" ON public.marketplace_suppliers;
CREATE POLICY "mkp_suppliers_supplier_update" ON public.marketplace_suppliers
  FOR UPDATE TO authenticated
  USING      (id = public.get_my_supplier_id())
  WITH CHECK (id = public.get_my_supplier_id());

DROP POLICY IF EXISTS "mkp_suppliers_superadmin_all" ON public.marketplace_suppliers;
CREATE POLICY "mkp_suppliers_superadmin_all" ON public.marketplace_suppliers
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- 4.4 supplier_contacts — CORE: restaurante SOLO lee si ya existe un lead suyo
--     hacia ese proveedor (el primer contacto SIEMPRE pasa por la RPC).
DROP POLICY IF EXISTS "mkp_contacts_supplier_all" ON public.marketplace_supplier_contacts;
CREATE POLICY "mkp_contacts_supplier_all" ON public.marketplace_supplier_contacts
  FOR ALL TO authenticated
  USING      (supplier_id = public.get_my_supplier_id())
  WITH CHECK (supplier_id = public.get_my_supplier_id());

DROP POLICY IF EXISTS "mkp_contacts_restaurant_select" ON public.marketplace_supplier_contacts;
CREATE POLICY "mkp_contacts_restaurant_select" ON public.marketplace_supplier_contacts
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.marketplace_leads l
      WHERE l.supplier_id = marketplace_supplier_contacts.supplier_id
        AND l.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  );

DROP POLICY IF EXISTS "mkp_contacts_superadmin_all" ON public.marketplace_supplier_contacts;
CREATE POLICY "mkp_contacts_superadmin_all" ON public.marketplace_supplier_contacts
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- 4.5 supplier_users — cada usuario ve su propio vínculo; gestión superadmin
DROP POLICY IF EXISTS "mkp_supplier_users_own_select" ON public.marketplace_supplier_users;
CREATE POLICY "mkp_supplier_users_own_select" ON public.marketplace_supplier_users
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "mkp_supplier_users_superadmin_all" ON public.marketplace_supplier_users;
CREATE POLICY "mkp_supplier_users_superadmin_all" ON public.marketplace_supplier_users
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- 4.6 products — supplier CRUD de lo suyo (nunca toca 'oculto_admin', estado
--     que solo administra la plataforma); restaurante ve publicados de
--     proveedores activos.
DROP POLICY IF EXISTS "mkp_products_supplier_select" ON public.marketplace_products;
CREATE POLICY "mkp_products_supplier_select" ON public.marketplace_products
  FOR SELECT TO authenticated
  USING (supplier_id = public.get_my_supplier_id());

DROP POLICY IF EXISTS "mkp_products_restaurant_select" ON public.marketplace_products;
CREATE POLICY "mkp_products_restaurant_select" ON public.marketplace_products
  FOR SELECT TO authenticated
  USING (
    estado = 'publicado'
    AND EXISTS (SELECT 1 FROM public.marketplace_suppliers s
                WHERE s.id = supplier_id AND s.estado = 'activo')
    AND EXISTS (SELECT 1 FROM public.get_my_company_restaurant_ids())
  );

DROP POLICY IF EXISTS "mkp_products_supplier_insert" ON public.marketplace_products;
CREATE POLICY "mkp_products_supplier_insert" ON public.marketplace_products
  FOR INSERT TO authenticated
  WITH CHECK (supplier_id = public.get_my_supplier_id() AND estado <> 'oculto_admin');

DROP POLICY IF EXISTS "mkp_products_supplier_update" ON public.marketplace_products;
CREATE POLICY "mkp_products_supplier_update" ON public.marketplace_products
  FOR UPDATE TO authenticated
  USING      (supplier_id = public.get_my_supplier_id() AND estado <> 'oculto_admin')
  WITH CHECK (supplier_id = public.get_my_supplier_id() AND estado <> 'oculto_admin');

DROP POLICY IF EXISTS "mkp_products_supplier_delete" ON public.marketplace_products;
CREATE POLICY "mkp_products_supplier_delete" ON public.marketplace_products
  FOR DELETE TO authenticated
  USING (supplier_id = public.get_my_supplier_id() AND estado <> 'oculto_admin');

DROP POLICY IF EXISTS "mkp_products_superadmin_all" ON public.marketplace_products;
CREATE POLICY "mkp_products_superadmin_all" ON public.marketplace_products
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- 4.7 catalog_files — supplier CRUD de lo suyo; restaurante lee de activos
DROP POLICY IF EXISTS "mkp_files_supplier_all" ON public.marketplace_catalog_files;
CREATE POLICY "mkp_files_supplier_all" ON public.marketplace_catalog_files
  FOR ALL TO authenticated
  USING      (supplier_id = public.get_my_supplier_id())
  WITH CHECK (supplier_id = public.get_my_supplier_id());

DROP POLICY IF EXISTS "mkp_files_restaurant_select" ON public.marketplace_catalog_files;
CREATE POLICY "mkp_files_restaurant_select" ON public.marketplace_catalog_files
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.marketplace_suppliers s
            WHERE s.id = supplier_id AND s.estado = 'activo')
    AND EXISTS (SELECT 1 FROM public.get_my_company_restaurant_ids())
  );

DROP POLICY IF EXISTS "mkp_files_superadmin_all" ON public.marketplace_catalog_files;
CREATE POLICY "mkp_files_superadmin_all" ON public.marketplace_catalog_files
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- 4.8 leads — restaurante gestiona los suyos; supplier ve los que le llegan y
--     solo puede cambiar estado (guard trigger).
DROP POLICY IF EXISTS "mkp_leads_restaurant_all" ON public.marketplace_leads;
CREATE POLICY "mkp_leads_restaurant_all" ON public.marketplace_leads
  FOR ALL TO authenticated
  USING      (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  WITH CHECK (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));

DROP POLICY IF EXISTS "mkp_leads_supplier_select" ON public.marketplace_leads;
CREATE POLICY "mkp_leads_supplier_select" ON public.marketplace_leads
  FOR SELECT TO authenticated
  USING (supplier_id = public.get_my_supplier_id());

DROP POLICY IF EXISTS "mkp_leads_supplier_update" ON public.marketplace_leads;
CREATE POLICY "mkp_leads_supplier_update" ON public.marketplace_leads
  FOR UPDATE TO authenticated
  USING      (supplier_id = public.get_my_supplier_id())
  WITH CHECK (supplier_id = public.get_my_supplier_id());

DROP POLICY IF EXISTS "mkp_leads_superadmin_all" ON public.marketplace_leads;
CREATE POLICY "mkp_leads_superadmin_all" ON public.marketplace_leads
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- 4.9 conversations — restaurante gestiona las suyas; supplier solo lee las
--     suyas (los contadores los toca el trigger DEFINER).
DROP POLICY IF EXISTS "mkp_conversations_restaurant_all" ON public.marketplace_conversations;
CREATE POLICY "mkp_conversations_restaurant_all" ON public.marketplace_conversations
  FOR ALL TO authenticated
  USING      (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  WITH CHECK (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));

DROP POLICY IF EXISTS "mkp_conversations_supplier_select" ON public.marketplace_conversations;
CREATE POLICY "mkp_conversations_supplier_select" ON public.marketplace_conversations
  FOR SELECT TO authenticated
  USING (supplier_id = public.get_my_supplier_id());

DROP POLICY IF EXISTS "mkp_conversations_superadmin_all" ON public.marketplace_conversations;
CREATE POLICY "mkp_conversations_superadmin_all" ON public.marketplace_conversations
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- 4.10 messages — cada lado lee sus conversaciones e inserta SOLO con su
--      sender (anti-spoofing); sin UPDATE/DELETE de participantes (integridad
--      del chat; moderación = superadmin).
DROP POLICY IF EXISTS "mkp_messages_select" ON public.marketplace_messages;
CREATE POLICY "mkp_messages_select" ON public.marketplace_messages
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() = 'superadmin'
    OR EXISTS (
      SELECT 1 FROM public.marketplace_conversations c
      WHERE c.id = conversation_id
        AND (c.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
             OR c.supplier_id = public.get_my_supplier_id())
    )
  );

DROP POLICY IF EXISTS "mkp_messages_restaurant_insert" ON public.marketplace_messages;
CREATE POLICY "mkp_messages_restaurant_insert" ON public.marketplace_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    sender = 'restaurant'
    AND sender_user = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.marketplace_conversations c
      WHERE c.id = conversation_id
        AND c.restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    )
  );

DROP POLICY IF EXISTS "mkp_messages_supplier_insert" ON public.marketplace_messages;
CREATE POLICY "mkp_messages_supplier_insert" ON public.marketplace_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    sender = 'supplier'
    AND sender_user = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.marketplace_conversations c
      WHERE c.id = conversation_id
        AND c.supplier_id = public.get_my_supplier_id()
    )
  );

DROP POLICY IF EXISTS "mkp_messages_superadmin_all" ON public.marketplace_messages;
CREATE POLICY "mkp_messages_superadmin_all" ON public.marketplace_messages
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- 4.11 saved — solo del restaurante
DROP POLICY IF EXISTS "mkp_saved_restaurant_all" ON public.marketplace_saved;
CREATE POLICY "mkp_saved_restaurant_all" ON public.marketplace_saved
  FOR ALL TO authenticated
  USING      (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  WITH CHECK (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()));

DROP POLICY IF EXISTS "mkp_saved_superadmin_all" ON public.marketplace_saved;
CREATE POLICY "mkp_saved_superadmin_all" ON public.marketplace_saved
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- 4.12 reviews — privadas: el restaurante escribe/ve las suyas y NO puede
--      publicarlas (visible siempre false para él); solo superadmin modera.
DROP POLICY IF EXISTS "mkp_reviews_restaurant_all" ON public.marketplace_reviews;
CREATE POLICY "mkp_reviews_restaurant_all" ON public.marketplace_reviews
  FOR ALL TO authenticated
  USING      (restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  WITH CHECK (
    restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    AND visible = false
  );

DROP POLICY IF EXISTS "mkp_reviews_superadmin_all" ON public.marketplace_reviews;
CREATE POLICY "mkp_reviews_superadmin_all" ON public.marketplace_reviews
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- 4.13 reports — cada lado crea/ve sus reportes; triage superadmin
DROP POLICY IF EXISTS "mkp_reports_restaurant_all" ON public.marketplace_reports;
CREATE POLICY "mkp_reports_restaurant_all" ON public.marketplace_reports
  FOR ALL TO authenticated
  USING      (reporter_restaurant_id IN (SELECT public.get_my_company_restaurant_ids()))
  WITH CHECK (
    reporter_restaurant_id IN (SELECT public.get_my_company_restaurant_ids())
    AND reporter_supplier_id IS NULL
  );

DROP POLICY IF EXISTS "mkp_reports_supplier_select" ON public.marketplace_reports;
CREATE POLICY "mkp_reports_supplier_select" ON public.marketplace_reports
  FOR SELECT TO authenticated
  USING (reporter_supplier_id = public.get_my_supplier_id());

DROP POLICY IF EXISTS "mkp_reports_supplier_insert" ON public.marketplace_reports;
CREATE POLICY "mkp_reports_supplier_insert" ON public.marketplace_reports
  FOR INSERT TO authenticated
  WITH CHECK (
    reporter_supplier_id = public.get_my_supplier_id()
    AND reporter_restaurant_id IS NULL
  );

DROP POLICY IF EXISTS "mkp_reports_superadmin_all" ON public.marketplace_reports;
CREATE POLICY "mkp_reports_superadmin_all" ON public.marketplace_reports
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- 4.14 events — supplier ve SOLO sus eventos (métricas del dashboard);
--      superadmin ve todo. Escritura solo por funciones DEFINER/service_role.
DROP POLICY IF EXISTS "mkp_events_supplier_select" ON public.marketplace_events;
CREATE POLICY "mkp_events_supplier_select" ON public.marketplace_events
  FOR SELECT TO authenticated
  USING (supplier_id = public.get_my_supplier_id());

DROP POLICY IF EXISTS "mkp_events_superadmin_all" ON public.marketplace_events;
CREATE POLICY "mkp_events_superadmin_all" ON public.marketplace_events
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- ─── 5. RPCs SECURITY DEFINER (patrón 131/135, fail-closed) ─────────

-- 5.1 submit_supplier_application — ÚNICA función con GRANT a anon.
--     Valida server-side, dedupe blando por ruc/email, NO devuelve el id.
CREATE OR REPLACE FUNCTION public.submit_supplier_application(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
  IF v_tel IS NULL AND v_wa IS NULL THEN
    RAISE EXCEPTION 'indicá teléfono o WhatsApp' USING ERRCODE = '22023';
  END IF;
  IF NOT v_acepta THEN
    RAISE EXCEPTION 'debés aceptar los términos y condiciones' USING ERRCODE = '22023';
  END IF;
  IF v_tipo IS NOT NULL AND v_tipo NOT IN
     ('productor','distribuidor','mayorista','minorista','importador','fabricante','servicio') THEN
    RAISE EXCEPTION 'tipo_proveedor inválido' USING ERRCODE = '22023';
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
    estado, origen
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
    'pendiente',
    'web'
  );

  INSERT INTO public.marketplace_events (event_type, metadata)
  VALUES ('application_submitted', jsonb_build_object('nombre_comercial', v_nombre));

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_supplier_application(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_supplier_application(jsonb) TO anon, authenticated;

-- 5.2 request_supplier_contact — CORE del negocio: registra el lead ANTES de
--     revelar el contacto. Dedupe de lead: 1 por restaurante-proveedor cada
--     30 días (el evento contact_revealed se registra SIEMPRE).
CREATE OR REPLACE FUNCTION public.request_supplier_contact(p_supplier_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := COALESCE(public.get_my_role(), '');
  v_rid  uuid := public.get_my_restaurant_id();
  v_sup  record;
  v_cont record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT s.id, s.nombre_comercial, s.estado INTO v_sup
    FROM public.marketplace_suppliers s WHERE s.id = p_supplier_id;
  IF v_sup.id IS NULL THEN
    RAISE EXCEPTION 'proveedor inexistente' USING ERRCODE = '22023';
  END IF;

  IF v_role <> 'superadmin' THEN
    -- Fail-closed: solo staff con restaurante asignado (un supplier tiene
    -- restaurant_id NULL → no puede cosechar contactos de otros proveedores).
    IF v_rid IS NULL THEN
      RAISE EXCEPTION 'solo el staff de un restaurante puede solicitar contacto' USING ERRCODE = '42501';
    END IF;
    IF v_sup.estado <> 'activo' THEN
      RAISE EXCEPTION 'proveedor no disponible' USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.marketplace_leads l
      WHERE l.supplier_id = p_supplier_id
        AND l.restaurant_id = v_rid
        AND l.tipo = 'contacto'
        AND l.created_at > now() - interval '30 days'
    ) THEN
      INSERT INTO public.marketplace_leads (restaurant_id, supplier_id, tipo, canal, estado, created_by)
      VALUES (v_rid, p_supplier_id, 'contacto', 'marketplace', 'nueva', auth.uid());
    END IF;

    INSERT INTO public.marketplace_events (event_type, supplier_id, restaurant_id, actor_user)
    VALUES ('contact_revealed', p_supplier_id, v_rid, auth.uid());
  END IF;

  SELECT c.telefono, c.whatsapp, c.email_comercial, c.contacto_nombre INTO v_cont
    FROM public.marketplace_supplier_contacts c WHERE c.supplier_id = p_supplier_id;

  RETURN jsonb_build_object(
    'ok', true,
    'nombre_comercial', v_sup.nombre_comercial,
    'telefono',         v_cont.telefono,
    'whatsapp',         v_cont.whatsapp,
    'email_comercial',  v_cont.email_comercial,
    'contacto_nombre',  v_cont.contacto_nombre
  );
END;
$$;

REVOKE ALL ON FUNCTION public.request_supplier_contact(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_supplier_contact(uuid) TO authenticated;

-- 5.3 create_supplier_quote — lead de cotización + conversación + 1er mensaje
CREATE OR REPLACE FUNCTION public.create_supplier_quote(
  p_supplier_id    uuid,
  p_product_id     uuid    DEFAULT NULL,
  p_producto_texto text    DEFAULT NULL,
  p_cantidad       text    DEFAULT NULL,
  p_frecuencia     text    DEFAULT NULL,
  p_mensaje        text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rid         uuid := public.get_my_restaurant_id();
  v_sup         record;
  v_prod_nombre text;
  v_texto       text;
  v_frec    text := NULLIF(btrim(COALESCE(p_frecuencia,'')),'');
  v_cant    text := left(NULLIF(btrim(COALESCE(p_cantidad,'')),''), 120);
  v_msg     text := left(NULLIF(btrim(COALESCE(p_mensaje,'')),''), 3000);
  v_lead_id uuid;
  v_conv_id uuid;
  v_body    text;
BEGIN
  IF auth.uid() IS NULL OR v_rid IS NULL THEN
    RAISE EXCEPTION 'solo el staff de un restaurante puede pedir cotización' USING ERRCODE = '42501';
  END IF;

  SELECT s.id, s.nombre_comercial, s.estado INTO v_sup
    FROM public.marketplace_suppliers s WHERE s.id = p_supplier_id;
  IF v_sup.id IS NULL OR v_sup.estado <> 'activo' THEN
    RAISE EXCEPTION 'proveedor no disponible' USING ERRCODE = '22023';
  END IF;

  IF p_product_id IS NOT NULL THEN
    SELECT p.nombre INTO v_prod_nombre
      FROM public.marketplace_products p
     WHERE p.id = p_product_id AND p.supplier_id = p_supplier_id AND p.estado = 'publicado';
    IF v_prod_nombre IS NULL THEN
      RAISE EXCEPTION 'producto inválido' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_texto := COALESCE(left(NULLIF(btrim(COALESCE(p_producto_texto,'')),''), 200), v_prod_nombre);
  IF v_texto IS NULL THEN
    RAISE EXCEPTION 'indicá el producto a cotizar' USING ERRCODE = '22023';
  END IF;

  IF v_frec IS NOT NULL AND v_frec NOT IN ('unica','semanal','mensual','a_definir') THEN
    RAISE EXCEPTION 'frecuencia inválida' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.marketplace_leads (
    restaurant_id, supplier_id, tipo, product_id, producto_texto,
    cantidad, frecuencia, mensaje, canal, estado, created_by
  ) VALUES (
    v_rid, p_supplier_id, 'cotizacion', p_product_id, v_texto,
    v_cant, v_frec, v_msg, 'marketplace', 'nueva', auth.uid()
  ) RETURNING id INTO v_lead_id;

  INSERT INTO public.marketplace_conversations (supplier_id, restaurant_id)
  VALUES (p_supplier_id, v_rid)
  ON CONFLICT (supplier_id, restaurant_id) DO UPDATE SET supplier_id = EXCLUDED.supplier_id
  RETURNING id INTO v_conv_id;

  v_body := concat_ws(E'\n',
    'Solicitud de cotización',
    'Producto: ' || v_texto,
    CASE WHEN v_cant IS NOT NULL THEN 'Cantidad: ' || v_cant END,
    CASE WHEN v_frec IS NOT NULL THEN 'Frecuencia: ' || v_frec END,
    v_msg
  );

  INSERT INTO public.marketplace_messages (conversation_id, sender, sender_user, body)
  VALUES (v_conv_id, 'restaurant', auth.uid(), v_body);

  INSERT INTO public.marketplace_events (event_type, supplier_id, restaurant_id, actor_user, metadata)
  VALUES ('quote_created', p_supplier_id, v_rid, auth.uid(), jsonb_build_object('lead_id', v_lead_id));

  RETURN jsonb_build_object('ok', true, 'lead_id', v_lead_id, 'conversation_id', v_conv_id);
END;
$$;

REVOKE ALL ON FUNCTION public.create_supplier_quote(uuid, uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_supplier_quote(uuid, uuid, text, text, text, text) TO authenticated;

-- 5.4 get_my_supplier_leads_info — el panel proveedor necesita el nombre del
--     restaurante de cada lead, pero la RLS de restaurants no le da lectura
--     (get_my_company_restaurant_ids() = vacío). RPC mínima fail-closed que
--     expone SOLO nombre y dirección de los restaurantes de SUS leads.
CREATE OR REPLACE FUNCTION public.get_my_supplier_leads_info()
RETURNS TABLE (lead_id uuid, restaurant_name text, restaurant_address text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT l.id, r.name, r.address
  FROM public.marketplace_leads l
  JOIN public.restaurants r ON r.id = l.restaurant_id
  WHERE l.supplier_id = public.get_my_supplier_id();
$$;

REVOKE ALL ON FUNCTION public.get_my_supplier_leads_info() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_supplier_leads_info() TO authenticated;

-- ─── 6. Storage (patrón migs 011/015 + scoping por carpeta) ─────────
-- supplier-images: público (logos/banners/fotos de producto). Escritura solo
-- bajo la carpeta del propio supplier: <supplier_id>/archivo.ext
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('supplier-images','supplier-images', true, 5242880,
        ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET
  public = true, file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp'];

DROP POLICY IF EXISTS "supplier_images_public_read" ON storage.objects;
CREATE POLICY "supplier_images_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'supplier-images');

DROP POLICY IF EXISTS "supplier_images_supplier_insert" ON storage.objects;
CREATE POLICY "supplier_images_supplier_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'supplier-images'
    AND (public.get_my_role() = 'superadmin'
         OR (storage.foldername(name))[1] = public.get_my_supplier_id()::text)
  );

DROP POLICY IF EXISTS "supplier_images_supplier_update" ON storage.objects;
CREATE POLICY "supplier_images_supplier_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'supplier-images'
    AND (public.get_my_role() = 'superadmin'
         OR (storage.foldername(name))[1] = public.get_my_supplier_id()::text)
  );

DROP POLICY IF EXISTS "supplier_images_supplier_delete" ON storage.objects;
CREATE POLICY "supplier_images_supplier_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'supplier-images'
    AND (public.get_my_role() = 'superadmin'
         OR (storage.foldername(name))[1] = public.get_my_supplier_id()::text)
  );

-- supplier-files: privado (catálogos PDF/Excel). Lectura: cualquier usuario
-- autenticado (restaurantes en Fase 2); escritura scoped por carpeta.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('supplier-files','supplier-files', false, 5242880,
        ARRAY['application/pdf','application/vnd.ms-excel',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET
  public = false, file_size_limit = 5242880,
  allowed_mime_types = ARRAY['application/pdf','application/vnd.ms-excel',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'image/jpeg','image/png','image/webp'];

DROP POLICY IF EXISTS "supplier_files_auth_read" ON storage.objects;
CREATE POLICY "supplier_files_auth_read"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'supplier-files');

DROP POLICY IF EXISTS "supplier_files_supplier_insert" ON storage.objects;
CREATE POLICY "supplier_files_supplier_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'supplier-files'
    AND (public.get_my_role() = 'superadmin'
         OR (storage.foldername(name))[1] = public.get_my_supplier_id()::text)
  );

DROP POLICY IF EXISTS "supplier_files_supplier_update" ON storage.objects;
CREATE POLICY "supplier_files_supplier_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'supplier-files'
    AND (public.get_my_role() = 'superadmin'
         OR (storage.foldername(name))[1] = public.get_my_supplier_id()::text)
  );

DROP POLICY IF EXISTS "supplier_files_supplier_delete" ON storage.objects;
CREATE POLICY "supplier_files_supplier_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'supplier-files'
    AND (public.get_my_role() = 'superadmin'
         OR (storage.foldername(name))[1] = public.get_my_supplier_id()::text)
  );

-- ─── 7. Realtime: chat del marketplace ──────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'marketplace_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.marketplace_messages;
  END IF;
END $$;

-- ─── 8. Seed ────────────────────────────────────────────────────────

-- 8.1 Categorías
INSERT INTO public.marketplace_categories (slug, nombre, orden) VALUES
  ('carnes',       'Carnes',        1),
  ('pollos',       'Pollos',        2),
  ('embutidos',    'Embutidos',     3),
  ('verduras',     'Verduras',      4),
  ('frutas',       'Frutas',        5),
  ('bebidas',      'Bebidas',       6),
  ('lacteos',      'Lácteos',       7),
  ('panificados',  'Panificados',   8),
  ('congelados',   'Congelados',    9),
  ('almacen',      'Almacén',      10),
  ('descartables', 'Descartables', 11),
  ('limpieza',     'Limpieza',     12),
  ('equipamiento', 'Equipamiento', 13),
  ('packaging',    'Packaging',    14),
  ('uniformes',    'Uniformes',    15),
  ('servicios',    'Servicios',    16)
ON CONFLICT (slug) DO NOTHING;

-- 8.2 Demo QA (reglas de simulación: prefijo [SIM] + emails @mythos.test).
--     Application pendiente — se aprueba vía POST /api/approve-supplier
--     (eso crea el usuario Auth; acá NO se toca auth.users).
INSERT INTO public.marketplace_applications (
  id, nombre_comercial, razon_social, ruc, tipo_proveedor, rubro_principal,
  anhos_mercado, ciudad, departamento, contacto_nombre, contacto_cargo,
  telefono, whatsapp, email, categorias, productos_principales,
  vende_mayor, vende_menor, zonas_entrega, delivery_propio, retiro_local,
  dias_entrega, pedido_minimo, entrega_urgente, acepta_credito, emite_factura,
  precio_visible, acepta_nuevos_clientes, mensaje, acepta_terminos, estado, origen
)
SELECT
  'a1b20003-0000-4000-8000-000000000003',
  '[SIM] Distribuidora Guaraní', 'Distribuidora Guaraní S.R.L. (SIMULACRO)', '80099999-1',
  'distribuidor', 'Distribución mayorista de alimentos',
  8, 'Asunción', 'Central', 'Juan Demo', 'Ventas',
  '+595 21 000 000', '+595 981 000 000', 'demo-proveedor@mythos.test',
  ARRAY['almacen','bebidas','descartables'], 'Aceites, harinas, bebidas, descartables',
  true, false, ARRAY['Asunción','Gran Asunción'], true, true,
  'Lun-Vie', '₲ 500.000', false, true, true,
  false, true, 'Solicitud de demostración (simulacro QA)', true, 'pendiente', 'seed_qa'
WHERE NOT EXISTS (
  SELECT 1 FROM public.marketplace_applications WHERE email = 'demo-proveedor@mythos.test'
);

-- 8.3 Supplier demo activo con 6 productos publicados (2 visible, 2 desde, 2 cotizar)
INSERT INTO public.marketplace_suppliers (
  id, slug, nombre_comercial, razon_social, ruc, tipo_proveedor, descripcion,
  ciudad, departamento, categorias, zonas_entrega, dias_entrega, horario_atencion,
  pedido_minimo, delivery_propio, retiro_local, entrega_urgente, acepta_credito,
  emite_factura, condiciones_comerciales, verificado, plan, estado
) VALUES (
  'a1b20001-0000-4000-8000-000000000001',
  'sim-frigorifico-central',
  '[SIM] Frigorífico Central', 'Frigorífico Central S.A. (SIMULACRO)', '80088888-2',
  'productor', 'Frigorífico demo del simulacro QA: cortes vacunos, pollo, embutidos y congelados.',
  'Asunción', 'Central',
  ARRAY['carnes','pollos','embutidos','congelados','lacteos','almacen'],
  ARRAY['Asunción','Central'], 'Lun-Sáb', '07:00-17:00',
  '₲ 300.000', true, true, true, true,
  true, 'Crédito a 15 días para clientes recurrentes (demo).', true, 'fundador', 'activo'
)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.marketplace_supplier_contacts (
  id, supplier_id, telefono, whatsapp, email_comercial, contacto_nombre
) VALUES (
  'a1b20002-0000-4000-8000-000000000002',
  'a1b20001-0000-4000-8000-000000000001',
  '+595 21 555 111', '+595 982 555 111', 'frigorifico-demo@mythos.test', 'María Demo'
)
ON CONFLICT (supplier_id) DO NOTHING;

INSERT INTO public.marketplace_products (
  id, supplier_id, nombre, categoria_slug, marca, presentacion, unidad,
  precio, precio_tipo, pedido_minimo, disponibilidad, descripcion, estado
) VALUES
  ('a1b20011-0000-4000-8000-000000000011', 'a1b20001-0000-4000-8000-000000000001',
   'Costilla vacuna premium', 'carnes', 'FC', 'caja 20 kg', 'caja',
   1450000, 'visible', '1 caja', 'En stock', 'Costilla vacuna seleccionada, corte parrillero (demo).', 'publicado'),
  ('a1b20012-0000-4000-8000-000000000012', 'a1b20001-0000-4000-8000-000000000001',
   'Pollo entero congelado', 'pollos', 'FC', 'bolsa 10 unidades', 'bolsa',
   380000, 'visible', '2 bolsas', 'En stock', 'Pollo entero congelado calibre 2,2 kg (demo).', 'publicado'),
  ('a1b20013-0000-4000-8000-000000000013', 'a1b20001-0000-4000-8000-000000000001',
   'Chorizo parrillero', 'embutidos', 'FC', 'pack 5 kg', 'pack',
   260000, 'desde', '1 pack', 'En stock', 'Chorizo parrillero artesanal, precio según volumen (demo).', 'publicado'),
  ('a1b20014-0000-4000-8000-000000000014', 'a1b20001-0000-4000-8000-000000000001',
   'Hamburguesas premoldeadas', 'congelados', 'FC', 'caja 100 unidades', 'caja',
   420000, 'desde', '1 caja', 'En stock', 'Medallones de carne 120 g, precio según volumen (demo).', 'publicado'),
  ('a1b20015-0000-4000-8000-000000000015', 'a1b20001-0000-4000-8000-000000000001',
   'Queso Paraguay horma', 'lacteos', 'FC', 'horma 3 kg', 'unidad',
   NULL, 'cotizar', '2 hormas', 'A pedido', 'Queso Paraguay artesanal de tambo asociado (demo).', 'publicado'),
  ('a1b20016-0000-4000-8000-000000000016', 'a1b20001-0000-4000-8000-000000000001',
   'Grasa bovina refinada', 'almacen', 'FC', 'bidón 20 L', 'bidon',
   NULL, 'cotizar', '1 bidón', 'A pedido', 'Grasa bovina refinada para cocina industrial (demo).', 'publicado')
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- Recargar el cache de esquema de PostgREST (tablas/funciones/privilegios nuevos)
NOTIFY pgrst, 'reload schema';

SELECT 'migracion 142 aplicada (marketplace proveedores FASE 1: rol supplier + 14 tablas + RLS + RPCs + storage + seed)' AS status;
