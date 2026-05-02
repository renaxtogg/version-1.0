-- Mesa App v1.0 — Migración 009: cover_image_url y opening_hours
-- Ejecutar en Supabase SQL Editor (en inglés)

ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS cover_image_url TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS opening_hours JSONB DEFAULT '[]'::jsonb;

-- Seed: horarios por defecto para La Huaca
UPDATE restaurants
SET opening_hours = '[
  {"day":"Lun–Vie","hours":"12:00–15:00 · 19:00–23:00"},
  {"day":"Sábados","hours":"12:00–23:30"},
  {"day":"Domingos","hours":"12:00–16:00"}
]'::jsonb
WHERE id = '00000000-0000-0000-0000-000000000001'
  AND (opening_hours IS NULL OR opening_hours = '[]'::jsonb);
