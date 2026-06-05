-- ───────────────────────────────────────────────────────────────────
-- 097 · Precios de planes y add-ons en guaraníes (₲)
-- ───────────────────────────────────────────────────────────────────
-- La columna sigue llamándose `price_usd` por compatibilidad histórica,
-- pero a partir de ahora SIEMPRE representa guaraníes (moneda única de
-- la plataforma). La UI muestra ₲ y los montos pasan a valores PYG
-- redondeados y realistas para el mercado paraguayo.
--   USD ref. → PYG:  Starter $29→₲200.000 · Pro $59→₲400.000 · Enterprise $119→₲800.000
-- ───────────────────────────────────────────────────────────────────

-- ─── Planes ────────────────────────────────────────────────────────
UPDATE public.subscription_plans SET price_usd = 200000 WHERE name = 'Starter';
UPDATE public.subscription_plans SET price_usd = 400000 WHERE name = 'Pro';
UPDATE public.subscription_plans SET price_usd = 800000 WHERE name = 'Enterprise';

-- ─── Add-ons ───────────────────────────────────────────────────────
UPDATE public.plan_addons SET price_usd = 100000 WHERE key = 'delivery_cliente';
UPDATE public.plan_addons SET price_usd =  70000 WHERE key = 'delivery_rider';
UPDATE public.plan_addons SET price_usd =  90000 WHERE key = 'kds_cocina';
UPDATE public.plan_addons SET price_usd = 180000 WHERE key = 'sucursal_extra';

-- ─── Suscripciones / add-ons ya contratados: re-sincronizar montos ──
-- (tras el reset de fábrica no debería haber filas, pero por las dudas)
UPDATE public.subscriptions s
SET    monthly_amount = sp.price_usd
FROM   public.subscription_plans sp
WHERE  s.plan_id = sp.id
  AND  s.monthly_amount < 10000;   -- montos viejos en USD (< ₲10.000)

UPDATE public.restaurant_addons ra
SET    price_usd = pa.price_usd
FROM   public.plan_addons pa
WHERE  ra.addon_key = pa.key
  AND  ra.price_usd < 10000;
