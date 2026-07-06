-- ════════════════════════════════════════════════════════════════════
-- 152 · CICLO DE VIDA DE PLANES — status 'active'|'inactive'|'archived'
--       en subscription_plans, sin romper las lecturas basadas en is_active.
-- ────────────────────────────────────────────────────────────────────
-- Contexto: hasta hoy el "estar disponible" de un plan era un único flag
-- booleano (is_active). El superadmin necesita 3 estados + eliminar:
--   • ACTIVO    (status='active')   → se ofrece (sitio de precios + selectores)
--   • PAUSADO   (status='inactive') → NO se ofrece, reversible ("Activar")
--   • ARCHIVADO (status='archived') → NO se ofrece, retirado a "Archivados"
-- Regla de oro: pausar/archivar NO tocan las suscripciones existentes; los
-- restaurantes que ya están en ese plan siguen operando igual.
--
-- COMPATIBILIDAD (crítico): TODA lectura existente que filtra por is_active
--   (vidriera pública vía marketing_plans, catálogo en admin.html, selectores)
--   sigue funcionando porque un trigger mantiene la invariante
--   is_active = (status = 'active'). Pausado y archivado ⇒ is_active=false ⇒
--   ocultos exactamente como antes. Nada que lea is_active necesita cambiar.
--
-- SEGURIDAD / RLS:
--   • 100% aditiva sobre el esquema (ADD COLUMN IF NOT EXISTS + CHECK + trigger).
--   • Re-asegura la policy fail-closed del superadmin (FOR ALL ⇒ cubre DELETE)
--     para que "Eliminar plan" funcione bajo RLS. anon sigue sin acceso (mig 103).
--
-- IDEMPOTENTE: reejecutable sin efectos colaterales. El backfill solo corrige
--   el artefacto del DEFAULT (is_active=false que quedó con status='active');
--   en una re-corrida no vuelve a tocar planes ya pausados/archivados.
--
-- Aplicar en el SQL Editor del dashboard en INGLÉS, tras backup, rol postgres.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1) Columna status + CHECK ────────────────────────────────────────
ALTER TABLE public.subscription_plans
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'subscription_plans_status_chk'
       AND conrelid = 'public.subscription_plans'::regclass
  ) THEN
    ALTER TABLE public.subscription_plans
      ADD CONSTRAINT subscription_plans_status_chk
      CHECK (status IN ('active','inactive','archived'));
  END IF;
END $$;

-- ── 2) Backfill desde is_active (solo el artefacto del DEFAULT) ───────
--    Al agregar la columna, TODAS las filas quedaron 'active' por default,
--    incluidas las que tenían is_active=false. Las corregimos a 'inactive'
--    (pausadas). La condición `status='active' AND is_active=false` hace que
--    en una RE-corrida no se toque nada ya pausado/archivado (idempotencia):
--    esas filas ya tienen status<>'active'.
UPDATE public.subscription_plans
   SET status = 'inactive'
 WHERE is_active = false
   AND status = 'active';

-- ── 3) Invariante is_active = (status='active') vía trigger ──────────
--    Fuente de verdad = status. is_active se deriva SIEMPRE, así ninguna
--    escritura (app, SQL manual, otra migración) puede desincronizarlos y
--    todas las lecturas legacy por is_active siguen siendo correctas.
CREATE OR REPLACE FUNCTION public.sync_plan_is_active()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.is_active := (NEW.status = 'active');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_plan_is_active ON public.subscription_plans;
CREATE TRIGGER trg_sync_plan_is_active
  BEFORE INSERT OR UPDATE ON public.subscription_plans
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_plan_is_active();

-- Normaliza cualquier fila cuyo is_active no coincida con su status (defensivo,
-- p.ej. filas escritas entre el paso 2 y la creación del trigger).
UPDATE public.subscription_plans
   SET is_active = (status = 'active')
 WHERE is_active IS DISTINCT FROM (status = 'active');

-- ── 4) RLS: re-asegura escritura fail-closed del superadmin (cubre DELETE) ──
--    plans_superadmin_all es FOR ALL ⇒ ya incluye DELETE; la re-declaramos
--    idempotentemente para garantizar que "Eliminar plan" opere bajo RLS.
--    La lectura del catálogo (plans_auth_select) NO se toca.
DROP POLICY IF EXISTS "plans_superadmin_all" ON public.subscription_plans;
CREATE POLICY "plans_superadmin_all" ON public.subscription_plans
  FOR ALL TO authenticated
  USING      (public.get_my_role() = 'superadmin')
  WITH CHECK (public.get_my_role() = 'superadmin');

COMMIT;

-- Recargar el cache de esquema de PostgREST (nueva columna `status` visible).
NOTIFY pgrst, 'reload schema';

SELECT 'migration 152 applied — subscription_plans.status (active/inactive/archived) + is_active sync trigger + superadmin DELETE policy' AS status;
