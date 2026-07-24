-- ════════════════════════════════════════════════════════════════════
-- 188 — Límite de usuarios por rol/plan: genérico para TODOS los puestos
-- ────────────────────────────────────────────────────────────────────
-- Contexto: el hard-limit por plan (subscription_plans.max_users_by_role,
-- JSONB {"rol": n}) sólo enforcaba una allowlist fija de 4 roles
-- ('mozo','cajero','cocina','rider'). En la práctica **rider** no tenía UI
-- para fijar su tope y **gerente** (rol real `supervisor_local`) quedaba
-- SIEMPRE ilimitado porque ni siquiera entraba al guard del trigger.
--
-- Instrucción de Renato (2026-07-24): TODO puesto de personal debe poder
-- limitarse por cantidad y por plan, ajustable desde el superadmin — y que
-- valga para roles que se agreguen en el futuro sin re-tocar la DB.
--
-- Fix (este archivo): CREATE OR REPLACE de enforce_role_user_limit() con el
-- MISMO cuerpo funcional de la mig 160 (resuelve el plan habilitante con
-- resolve_entitled_plan_id), cambiando SÓLO el guard: en vez de una
-- allowlist de roles, se enforca para CUALQUIER rol que NO sea de
-- plataforma/dueño ('superadmin','admin') y que tenga un tope numérico
-- configurado en max_users_by_role. Semántica conservada:
--   · rol ausente del JSON  → v_limit NULL → ilimitado (RETURN NEW).
--   · is_active = false      → no cuenta ni se limita (RETURN NEW).
-- Con esto, agregar un rol de empleado nuevo lo vuelve limitable con sólo
-- ponerle un número en el plan; no requiere otra migración.
--
-- No toca RLS, GRANTs, pricing, planes ni ninguna otra función. El trigger
-- trg_enforce_role_user_limit (BEFORE INSERT ON user_roles, mig 090) sigue
-- apuntando a esta función por nombre — no hace falta recrearlo.
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.enforce_role_user_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_limit INT;
  v_count INT;
BEGIN
  -- Roles de plataforma/dueño no consumen cupo de puesto (se aprovisionan
  -- por onboarding, no desde la gestión de personal). Cualquier otro rol es
  -- limitable: el tope se aplica sólo si el plan lo define numéricamente.
  IF NEW.restaurant_id IS NULL
     OR NEW.role IN ('superadmin','admin','owner')
     OR COALESCE(NEW.is_active, true) = false THEN
    RETURN NEW;
  END IF;

  SELECT (sp.max_users_by_role ->> NEW.role)::INT
    INTO v_limit
    FROM public.subscription_plans sp
   WHERE sp.id = public.resolve_entitled_plan_id(NEW.restaurant_id);

  IF v_limit IS NULL THEN
    RETURN NEW;   -- plan sin tope para este rol → ilimitado
  END IF;

  SELECT COUNT(*) INTO v_count
    FROM public.user_roles
   WHERE restaurant_id = NEW.restaurant_id
     AND role = NEW.role
     AND is_active = true;

  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'Límite de % alcanzado para el plan actual (máx %)', NEW.role, v_limit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

SELECT 'migration 188 applied — role user-limit enforced generically for all staff roles' AS status;
