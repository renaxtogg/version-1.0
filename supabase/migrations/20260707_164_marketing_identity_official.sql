-- ════════════════════════════════════════════════════════════════════════
-- 164 · IDENTIDAD PÚBLICA OFICIAL (lanzamiento) — fija los datos del negocio
--       en marketing_config y oculta RUC / razón social
-- ────────────────────────────────────────────────────────────────────────
-- [PARA PEGAR EN SUPABASE]  ·  rol postgres, SQL Editor en INGLÉS.
--
-- Publica la identidad OFICIAL de MYTHOS (07-jul-2026) que alimenta el pie del
-- sitio y las páginas legales (/terminos, /privacidad, /cookies):
--   marca MYTHOS · Fernando de la Mora, Paraguay · mancuellorenato@gmail.com ·
--   WhatsApp 595 987 436592 · mythos-pos.vercel.app.
--
-- Fix L2: `ruc` y `legal_name` (razón social) quedan VACÍOS a propósito → el
-- sitio NO los muestra (el bloque de identidad oculta/omite los campos vacíos;
-- ya no aparece "RUC —"). El resto son públicos y no sensibles (se ven en el
-- pie/legales).
--
-- AUTOSUFICIENTE respecto de la mig 148 (que sigue PENDIENTE de aplicar):
--   • Los INSERT usan ON CONFLICT (key) → crean la clave si falta y ACTUALIZAN
--     su valor si ya existía (mig 148 seedeaba defaults viejos con DO NOTHING).
--   • Re-declara (CREATE OR REPLACE) la RPC fail-closed del editor "Identidad y
--     redes" para que ese panel funcione aunque la 148 no se haya corrido.
-- Idempotente. Solo toca claves de identidad; nada de RLS ni otras filas.
--
-- Nota (WhatsApp): se guarda en DÍGITOS (contrato del editor del superadmin,
-- validación /^\d{6,15}$/). El sitio lo formatea para mostrar "+595 987 436592"
-- y sanea el número al armar el enlace wa.me.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1) Claves autoritativas (DO UPDATE: fija el valor oficial) ───────────
INSERT INTO public.marketing_config (key, value, is_public, updated_at) VALUES
  ('legal_name',           '""'::jsonb,                             true, now()),  -- razón social: VACÍA (no se muestra)
  ('ruc',                  '""'::jsonb,                             true, now()),  -- RUC: VACÍO (no se muestra)
  ('legal_address',        '"Fernando de la Mora, Paraguay"'::jsonb, true, now()),
  ('contact_email',        '"mancuellorenato@gmail.com"'::jsonb,    true, now()),
  ('whatsapp',             '"595987436592"'::jsonb,                 true, now()),
  ('website_domain',       '"mythos-pos.vercel.app"'::jsonb,        true, now()),
  ('legal_effective_date', '"7 de julio de 2026"'::jsonb,           true, now())
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, is_public = true, updated_at = now();

-- ── 2) Redes: crear vacías si faltan, NO pisar lo que Renato haya cargado ─
INSERT INTO public.marketing_config (key, value, is_public) VALUES
  ('instagram_url', '""'::jsonb, true),
  ('facebook_url',  '""'::jsonb, true),
  ('tiktok_url',    '""'::jsonb, true)
ON CONFLICT (key) DO NOTHING;

-- ── 3) RPC del editor "Identidad y redes" (self-contained; = mig 148) ────
-- Recibe {clave: valor}. Solo escribe claves de la whitelist y fuerza
-- is_public=true. Fail-closed: solo superadmin.
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

REVOKE ALL ON FUNCTION public.superadmin_set_marketing_identity(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.superadmin_set_marketing_identity(jsonb) TO authenticated;

COMMIT;

-- Recargar el cache de esquema de PostgREST (RPC visible).
NOTIFY pgrst, 'reload schema';

-- ── Verificación (correr aparte) ─────────────────────────────────────────
--   SELECT key, value FROM public.marketing_config
--   WHERE key IN ('legal_name','ruc','legal_address','contact_email',
--                 'whatsapp','website_domain','legal_effective_date')
--   ORDER BY key;
-- Esperado: legal_name="" · ruc="" · legal_address="Fernando de la Mora, Paraguay"
--   · contact_email="mancuellorenato@gmail.com" · whatsapp="595987436592"
--   · website_domain="mythos-pos.vercel.app" · legal_effective_date="7 de julio de 2026".
SELECT 'migration 164 applied — official public identity (RUC/razón social hidden)' AS status;
