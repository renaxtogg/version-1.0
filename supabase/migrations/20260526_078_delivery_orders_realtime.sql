-- delivery_orders nunca fue agregada a la publicación supabase_realtime.
-- Sin esto, ninguna suscripción postgres_changes funciona para esta tabla.
ALTER PUBLICATION supabase_realtime ADD TABLE delivery_orders;
