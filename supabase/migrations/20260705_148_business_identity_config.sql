-- ════════════════════════════════════════════════════════════════════════
-- 148 · IDENTIDAD DEL NEGOCIO EDITABLE (fuente única para sitio + legales)
-- ────────────────────────────────────────────────────────────────────────
-- (PREPARED — NOT APPLIED: aplicar manualmente tras backup nuevo, SQL Editor
--  en INGLÉS. Claude Code NO la aplica.)
--
-- Extiende la config pública existente (marketing_config, mig 110) con las
-- claves de identidad/contacto/redes/legales que alimentan el sitio, el footer,
-- el WhatsApp, las páginas legales y el banner de cookies. Nada hardcodeado.
--
-- • Las claves son is_public=true → anon las lee (las usa el sitio público).
--   No son sensibles (son datos que se muestran en el pie/legales).
-- • ESCRITURA solo superadmin: ya lo garantiza la RLS de mig 110
--   (marketing_config_superadmin_all, WITH CHECK get_my_role()='superadmin').
--   Además se agrega una RPC dedicada fail-closed con whitelist de claves, que
--   es la que usa el editor "Identidad y redes" del superadmin.
-- • 100% ADITIVA: seed idempotente (ON CONFLICT DO NOTHING, no pisa lo que
--   Renato ya haya editado) + 1 función nueva. No toca RLS ni datos existentes.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1) Seed idempotente de las claves de identidad ───────────────────────
-- Defaults presentables (Renato los edita desde el panel). Los vacíos ("")
-- hacen que el sitio muestre "—" o esconda el ícono, nunca un placeholder roto.
INSERT INTO public.marketing_config (key, value, is_public) VALUES
  ('legal_name',           '"MYTHOS EAS"'::jsonb,            true),
  ('ruc',                  '""'::jsonb,                      true),
  ('legal_address',        '"Asunción, Paraguay"'::jsonb,    true),
  ('contact_email',        '"hola@mythos.com.py"'::jsonb,    true),
  ('instagram_url',        '""'::jsonb,                      true),
  ('facebook_url',         '""'::jsonb,                      true),
  ('tiktok_url',           '""'::jsonb,                      true),
  ('website_domain',       '"mythos-pos.vercel.app"'::jsonb, true),
  ('legal_effective_date', '"5 de julio de 2026"'::jsonb,    true)
ON CONFLICT (key) DO NOTHING;

-- WhatsApp unificado: si ya existe sales_whatsapp (número que Renato pudo haber
-- cargado), lo hereda; si no, queda vacío (el sitio degrada al placeholder).
INSERT INTO public.marketing_config (key, value, is_public)
VALUES ('whatsapp',
        COALESCE((SELECT value FROM public.marketing_config WHERE key = 'sales_whatsapp'), '""'::jsonb),
        true)
ON CONFLICT (key) DO NOTHING;

-- ── 2) RPC fail-closed: fijar las claves de identidad (atómica) ──────────
-- Recibe un objeto jsonb {clave: valor}. Solo escribe claves de la whitelist
-- (defensa en profundidad: un superadmin no puede publicar por accidente una
-- clave sensible) y siempre con is_public=true.
CREATE OR REPLACE FUNCTION public.superadmin_set_marketing_identity(p_values jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_allowed text[] := ARRAY[
    'legal_name','ruc','legal_address','contact_email','whatsapp',
    'instagram_url','facebook_url','tiktok_url','website_domain','legal_effective_date'
  ];
  k text;
  v jsonb;
BEGIN
  IF public.get_my_role() IS DISTINCT FROM 'superadmin' THEN
    RAISE EXCEPTION 'forbidden: solo el superadmin' USING ERRCODE = '42501';
  END IF;

  FOR k, v IN SELECT key, value FROM jsonb_each(COALESCE(p_values, '{}'::jsonb))
  LOOP
    IF k = ANY(v_allowed) THEN
      INSERT INTO public.marketing_config (key, value, is_public, updated_at)
      VALUES (k, v, true, now())
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, is_public = true, updated_at = now();
    END IF;
  END LOOP;
END;
$$;

-- Permisos: fail-closed (nunca PUBLIC/anon; solo authenticated, y la función
-- valida superadmin adentro).
REVOKE ALL ON FUNCTION public.superadmin_set_marketing_identity(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.superadmin_set_marketing_identity(jsonb) TO authenticated;

COMMIT;

-- Recargar el cache de esquema de PostgREST (nueva función visible).
NOTIFY pgrst, 'reload schema';

SELECT 'migration 148 applied — business identity config keys + RPC' AS status;
