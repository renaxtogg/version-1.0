-- ============================================================
-- Migración 005: Habilitar Realtime para tablas de superadmin
-- ============================================================

-- Las tablas de la migración 004 no estaban en la publicación
-- de Supabase Realtime, por eso el superadmin no recibía eventos.
ALTER PUBLICATION supabase_realtime ADD TABLE restaurants;
ALTER PUBLICATION supabase_realtime ADD TABLE subscriptions;
ALTER PUBLICATION supabase_realtime ADD TABLE platform_events;

-- Fix: la migración 004 referencia auto_updated_at() que no existe —
-- el proyecto usa set_updated_at() (definida en migración 001).
DROP TRIGGER IF EXISTS subscriptions_updated_at ON subscriptions;
CREATE TRIGGER subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
