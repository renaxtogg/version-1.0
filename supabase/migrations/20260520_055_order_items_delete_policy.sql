-- Política RLS para DELETE en order_items
-- Sin esta política, los mozos no pueden eliminar ítems (RLS bloquea silenciosamente)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'order_items' AND policyname = 'delete_order_items'
  ) THEN
    EXECUTE 'CREATE POLICY "delete_order_items" ON order_items FOR DELETE USING (true)';
  END IF;
END$$;

-- También aseguramos el permiso a nivel de tabla para los roles de Supabase
GRANT DELETE ON public.order_items TO anon, authenticated;
GRANT UPDATE ON public.order_items TO anon, authenticated;
