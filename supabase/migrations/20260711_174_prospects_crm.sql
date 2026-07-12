-- ════════════════════════════════════════════════════════════════════════════
-- Migración 174 — CRM de Prospección (outbound): tabla `prospects`
-- ----------------------------------------------------------------------------
-- Respalda el módulo "Clientes contactados" del panel Superadmin. Guarda los
-- RESTAURANTES y PROVEEDORES que el equipo de Mythos sale a contactar (outbound),
-- con pipeline de estados, geolocalización (lat/lng para el mapa Leaflet+Carto) y
-- enlace opcional al restaurante real creado cuando el prospecto se convierte en
-- cliente. NO se confunde con `marketing_leads` (mig 110) ni `leads_prospectos`
-- (mig 117), que son leads INBOUND (gente que se registró sola en la web).
--
-- Seguridad: tabla NUEVA, SOLO-superadmin vía get_my_role()='superadmin' (mismo
-- patrón que la mig 147 platform_finance). `anon` sin ningún acceso. No toca la
-- RLS multi-tenant ni los agujeros pendientes del Sprint 1.
--
-- ⚠️ PREPARED — NOT APPLIED. Aplicar a mano en el SQL Editor de Supabase (idioma
--    en INGLÉS) después de un backup. Claude Code NO la aplica.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS public.prospects (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                    text NOT NULL DEFAULT 'restaurant'
                            CHECK (kind IN ('restaurant','supplier')),
  name                    text NOT NULL,
  owner_name              text,                 -- persona de contacto (dueño/encargado)
  contact_phone           text,
  contact_email           text,
  city                    text,
  zone                    text,                 -- barrio / zona
  address                 text,
  lat                     double precision,     -- pin en el mapa (nullable)
  lng                     double precision,
  status                  text NOT NULL DEFAULT 'nuevo'
                            CHECK (status IN ('nuevo','contactado','en_conversacion','negociacion','activo','descartado')),
  notes                   text,                 -- bitácora libre de la conversación
  last_contact_at         date,
  next_followup_at        date,
  discard_reason          text,
  converted_restaurant_id uuid REFERENCES public.restaurants(id) ON DELETE SET NULL,
  created_by              uuid DEFAULT auth.uid(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prospects_kind   ON public.prospects (kind);
CREATE INDEX IF NOT EXISTS idx_prospects_status ON public.prospects (status);
CREATE INDEX IF NOT EXISTS idx_prospects_city   ON public.prospects (city);

-- updated_at automático en cada UPDATE.
CREATE OR REPLACE FUNCTION public.prospects_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prospects_updated_at ON public.prospects;
CREATE TRIGGER trg_prospects_updated_at
  BEFORE UPDATE ON public.prospects
  FOR EACH ROW EXECUTE FUNCTION public.prospects_touch_updated_at();

-- RLS: SOLO superadmin (defensa en profundidad — igual que las tablas de plataforma).
ALTER TABLE public.prospects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "prospects_superadmin_all" ON public.prospects;
CREATE POLICY "prospects_superadmin_all"
  ON public.prospects FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

-- anon nunca; authenticated pasa por RLS (solo el superadmin ve/escribe).
REVOKE ALL ON public.prospects FROM anon;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.prospects TO authenticated;

COMMIT;

-- Recargar el cache de esquema de PostgREST (nueva tabla visible por la API REST).
NOTIFY pgrst, 'reload schema';
