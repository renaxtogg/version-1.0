-- Migración 065: agregar cash_amount a delivery_orders
-- Guarda el monto con el que el cliente dice que va a pagar (para que el rider
-- lleve vuelto exacto). Nullable: solo se llena si eligió "necesito vuelto".

ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS cash_amount INTEGER DEFAULT NULL;

NOTIFY pgrst, 'reload schema';
