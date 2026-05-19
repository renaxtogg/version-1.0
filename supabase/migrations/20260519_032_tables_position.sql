-- Migración 032: campos pos_x / pos_y en tables para canvas drag-and-drop del admin

ALTER TABLE tables
  ADD COLUMN IF NOT EXISTS pos_x integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pos_y integer NOT NULL DEFAULT 0;
