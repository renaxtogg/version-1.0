-- Mesa App v1.0 — Migración 082: is_open en restaurants
-- Permite al superadmin ver y toggle el estado abierto/cerrado de cada restaurante
-- Ejecutar en Supabase SQL Editor (en inglés)

ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS is_open BOOLEAN DEFAULT false;

-- Seed: marcar La Huaca como abierta por defecto (restaurante demo activo)
UPDATE restaurants
SET is_open = true
WHERE id = '00000000-0000-0000-0000-000000000001';
