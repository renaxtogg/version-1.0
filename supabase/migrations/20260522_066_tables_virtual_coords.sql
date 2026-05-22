-- Mesas: migración a sistema de coordenadas virtuales (0-1000)
-- Antes: pos_x/pos_y se guardaban en píxeles, lo que generaba layouts
-- inconsistentes entre admin (canvas ancho) y mozo (canvas mobile).
-- Ahora: pos_x/pos_y representan posición virtual 0-1000 en ambos ejes,
-- y cada panel mapea a píxeles reales según el ancho disponible.
-- Reseteamos todas las posiciones existentes (estaban en px, no son válidas
-- en el nuevo sistema). El layout por defecto se calcula como grid auto.

UPDATE tables
   SET pos_x = NULL,
       pos_y = NULL
 WHERE pos_x IS NOT NULL
    OR pos_y IS NOT NULL;
