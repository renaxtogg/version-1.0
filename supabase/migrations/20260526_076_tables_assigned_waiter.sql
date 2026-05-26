-- Columna para el nombre del mozo asignado a la mesa.
-- Se escribe cuando el mozo crea la primera orden; se limpia al liberar la mesa.
ALTER TABLE tables ADD COLUMN IF NOT EXISTS assigned_waiter_name TEXT DEFAULT NULL;
