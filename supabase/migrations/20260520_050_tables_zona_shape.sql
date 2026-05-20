-- Agrega zona y shape a la tabla tables para gestión visual del mapa de mesas
ALTER TABLE tables
  ADD COLUMN IF NOT EXISTS zona text DEFAULT 'salon',
  ADD COLUMN IF NOT EXISTS shape text DEFAULT 'square';

-- Valores permitidos orientativos (sin constraint para flexibilidad futura):
-- zona: salon | terraza | bar | privado | exterior
-- shape: square | round | rectangle
