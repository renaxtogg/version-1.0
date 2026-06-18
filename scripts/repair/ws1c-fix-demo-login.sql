-- ════════════════════════════════════════════════════════════════════
-- MYTHOS · FASE C / WS1-C — Desbloqueo de login de cuentas demo Starter/Pro
-- ────────────────────────────────────────────────────────────────────
-- QA (WS1-B) quedó BLOCKED: las 4 cuentas demo creadas por el seed WS0-B
-- (_simulacion/07_ws0b_accounts.sql) dan HTTP 500 "Database error querying
-- schema" en POST /auth/v1/token. Las cuentas Enterprise (*.carlos, del seed
-- viejo 02_staff.sql) sí loguean.
--
-- CAUSA RAÍZ (no es el gating, no es la mig 109, no es login.html):
--   Un 500 "Database error querying schema" = el usuario EXISTE y la clave
--   coincide, pero GoTrue NO pudo escanear la fila de auth.users. El patrón
--   clásico es NULL en columnas de token tipo string que GoTrue lee como
--   texto (no nullable en su modelo): confirmation_token, recovery_token,
--   email_change, email_change_token_new/current, phone_change(_token),
--   reauthentication_token. Al insertar auth.users a mano por SQL, esas
--   columnas quedan NULL → GoTrue moderno rompe al leerlas. Las cuentas
--   viejas (*.carlos) ya quedaron normalizadas a '' por uso previo.
--
-- FIX (PART B): normalizar esas columnas a '' SOLO para los 4 emails demo.
-- Idempotente · acotado a 4 emails · sin DELETE · NO toca Renato ni *.carlos
-- ni pedidos/planes/RLS. Correr en SQL Editor (Dashboard en INGLÉS, rol postgres).
-- ════════════════════════════════════════════════════════════════════


-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ PART A — VERIFICACIÓN (SOLO SELECT, read-only). Correr primero.    ║
-- ╚══════════════════════════════════════════════════════════════════╝
-- Compara las 4 cuentas que fallan vs las 2 *.carlos que funcionan.
-- Esperado: las 4 demo con *_tok_null = true (NULL) y *.carlos con false ('').
SELECT u.email,
       (u.email_confirmed_at IS NOT NULL)   AS confirmed,
       (u.confirmation_token IS NULL)       AS conf_tok_null,
       (u.recovery_token IS NULL)           AS rec_tok_null,
       (u.email_change IS NULL)             AS email_change_null,
       (u.email_change_token_new IS NULL)   AS ect_new_null,
       (u.reauthentication_token IS NULL)   AS reauth_tok_null,
       (SELECT count(*) FROM auth.identities i WHERE i.user_id = u.id AND i.provider='email') AS email_identities,
       ur.role, ur.restaurant_id,
       (SELECT count(*) FROM public.delivery_riders dr WHERE dr.user_id = u.id) AS rider_ficha
FROM auth.users u
LEFT JOIN public.user_roles ur ON ur.user_id = u.id
WHERE u.email IN ('gerente.napoli@mythos.test','rider1.napoli@mythos.test',
                  'gerente.sakura@mythos.test','rider1.sakura@mythos.test',
                  'gerente.carlos@mythos.test','rider1.carlos@mythos.test')
ORDER BY u.email;


-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ PART B — REPARACIÓN (idempotente). Correr tras revisar PART A.     ║
-- ╚══════════════════════════════════════════════════════════════════╝
BEGIN;

-- B.1 · FIX PRINCIPAL: normalizar columnas de token NULL → '' (GoTrue scan).
--      COALESCE = no-op si ya están en '' → idempotente. Solo los 4 emails demo.
--      (Si algún proyecto no tuviera alguna columna, quitá esa línea.)
UPDATE auth.users
   SET confirmation_token         = COALESCE(confirmation_token, ''),
       recovery_token             = COALESCE(recovery_token, ''),
       email_change               = COALESCE(email_change, ''),
       email_change_token_new     = COALESCE(email_change_token_new, ''),
       email_change_token_current = COALESCE(email_change_token_current, ''),
       phone_change               = COALESCE(phone_change, ''),
       phone_change_token         = COALESCE(phone_change_token, ''),
       reauthentication_token     = COALESCE(reauthentication_token, ''),
       email_confirmed_at         = COALESCE(email_confirmed_at, now()),
       updated_at                 = now()
 WHERE email IN ('gerente.napoli@mythos.test','rider1.napoli@mythos.test',
                 'gerente.sakura@mythos.test','rider1.sakura@mythos.test');

-- B.2 · DEFENSIVO (idempotente): asegurar identity de email si faltara.
INSERT INTO auth.identities (id, user_id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at)
SELECT gen_random_uuid(), u.id, 'email', u.id::text,
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true, 'phone_verified', false),
       now(), now(), now()
FROM auth.users u
WHERE u.email IN ('gerente.napoli@mythos.test','rider1.napoli@mythos.test',
                  'gerente.sakura@mythos.test','rider1.sakura@mythos.test')
  AND NOT EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id AND i.provider = 'email')
ON CONFLICT DO NOTHING;

-- B.3 · DEFENSIVO (idempotente): asegurar user_roles si faltara (mapping WS0-B).
INSERT INTO public.user_roles (user_id, restaurant_id, role, username, display_name, email, is_active)
SELECT u.id, m.rid, m.role, m.username, m.display_name, u.email, true
FROM auth.users u
JOIN (VALUES
  ('gerente.napoli@mythos.test','a1a10000-0000-4000-8000-000000000001'::uuid,'supervisor_local','gerente.napoli','Gerente Napoli (demo)'),
  ('rider1.napoli@mythos.test', 'a1a10000-0000-4000-8000-000000000001'::uuid,'rider','rider1.napoli','Rider Napoli (demo)'),
  ('gerente.sakura@mythos.test','b2b20000-0000-4000-8000-000000000002'::uuid,'supervisor_local','gerente.sakura','Gerente Sakura (demo)'),
  ('rider1.sakura@mythos.test', 'b2b20000-0000-4000-8000-000000000002'::uuid,'rider','rider1.sakura','Rider Sakura (demo)')
) AS m(email, rid, role, username, display_name) ON m.email = u.email
WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = u.id)
ON CONFLICT DO NOTHING;

-- B.4 · DEFENSIVO (idempotente): asegurar ficha delivery_riders de los 2 riders.
INSERT INTO public.delivery_riders (id, restaurant_id, name, phone, vehicle, vehicle_type, current_status, status, is_active, active, user_id, rider_pin, commission_type, commission_value)
SELECT gen_random_uuid(), m.rid, m.name, m.phone, 'moto','moto','disponible','disponible', true, true, u.id, NULL, 'fixed', 5000
FROM auth.users u
JOIN (VALUES
  ('rider1.napoli@mythos.test','a1a10000-0000-4000-8000-000000000001'::uuid,'Rider Napoli (demo)','+595 981 000111'),
  ('rider1.sakura@mythos.test','b2b20000-0000-4000-8000-000000000002'::uuid,'Rider Sakura (demo)','+595 981 000222')
) AS m(email, rid, name, phone) ON m.email = u.email
WHERE NOT EXISTS (SELECT 1 FROM public.delivery_riders dr WHERE dr.user_id = u.id)
ON CONFLICT DO NOTHING;

COMMIT;


-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ PART C — POST-CHECK (read-only). Re-correr PART A: las 4 deben      ║
-- ║ quedar con *_tok_null = false. Luego probar login real en el preview.║
-- ╚══════════════════════════════════════════════════════════════════╝
SELECT u.email,
       (u.confirmation_token IS NOT NULL AND u.recovery_token IS NOT NULL
        AND u.email_change IS NOT NULL AND u.email_change_token_new IS NOT NULL
        AND u.reauthentication_token IS NOT NULL) AS tokens_ok
FROM auth.users u
WHERE u.email IN ('gerente.napoli@mythos.test','rider1.napoli@mythos.test',
                  'gerente.sakura@mythos.test','rider1.sakura@mythos.test')
ORDER BY u.email;
