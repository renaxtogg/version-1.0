-- Agrega pos_x, pos_y para posicionamiento drag-and-drop en el canvas de mesas
ALTER TABLE tables
  ADD COLUMN IF NOT EXISTS pos_x integer DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS pos_y integer DEFAULT NULL;
