-- Eliminar el trigger que liberaba la mesa automáticamente al marcar delivered.
-- La mesa ahora solo se libera cuando el mozo o la caja hacen clic en "Liberar mesa".
DROP TRIGGER IF EXISTS trg_release_table_on_delivered ON public.orders;
DROP FUNCTION IF EXISTS public.fn_auto_release_table_on_delivered();
