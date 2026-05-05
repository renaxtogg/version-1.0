-- ============================================================
-- Migración 018: Fix trigger de descuento de stock
-- ============================================================
-- Bug: el trigger en `orders` disparaba ANTES de que los
-- order_items existieran (el cliente hace inserts separados).
-- Fix: mover el trigger a `order_status_history` que se inserta
-- ÚLTIMO en el flujo del cliente, cuando ya existen todos los items.
-- ============================================================

-- Eliminar trigger anterior (incorrecto)
DROP TRIGGER IF EXISTS trg_deduct_stock_on_paid ON public.orders;
DROP FUNCTION IF EXISTS public.trigger_deduct_stock_on_paid();

-- Nuevo trigger: dispara cuando llega el historial con status='paid'
CREATE OR REPLACE FUNCTION public.trigger_deduct_stock_on_status_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'paid' THEN
    PERFORM public.deduct_stock_for_order(NEW.order_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deduct_stock_on_status_history ON public.order_status_history;
CREATE TRIGGER trg_deduct_stock_on_status_history
  AFTER INSERT ON public.order_status_history
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_deduct_stock_on_status_history();
