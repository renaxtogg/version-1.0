-- Activar REPLICA IDENTITY FULL en delivery_orders.
-- Sin esto, Supabase Realtime no dispara eventos UPDATE filtrados cuando
-- el campo filtrado (rider_id) cambia de NULL a un valor — el panel del
-- rider no recibía el pedido hasta hacer F5.
ALTER TABLE delivery_orders REPLICA IDENTITY FULL;
