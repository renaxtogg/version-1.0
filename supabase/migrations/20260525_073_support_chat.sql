-- ════════════════════════════════════════════════════════════════════════════
-- Migration 073 — Soporte (chat Gerente/Admin ↔ Superadmin)
-- ════════════════════════════════════════════════════════════════════════════
-- Permite que Gerente y Admin de cada restaurante abran tickets de soporte
-- y mantengan una conversación con el equipo Superadmin (Mythos).
--
-- Tablas nuevas:
--   • support_tickets   — hilo de soporte (uno por consulta/problema)
--   • support_messages  — mensajes individuales del hilo
--
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. SUPPORT TICKETS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id         UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  restaurant_name       TEXT,                              -- snapshot legible

  -- Quien abre el ticket (Gerente o Admin)
  created_by_user_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name       TEXT,                              -- display_name
  created_by_username   TEXT,                              -- username
  created_by_role       TEXT,                              -- 'admin','supervisor_local','superadmin'
  created_by_email      TEXT,
  created_by_phone      TEXT,

  -- Datos del ticket
  subject               TEXT NOT NULL,
  category              TEXT NOT NULL DEFAULT 'consulta'
                          CHECK (category IN ('problema_tecnico','consulta','facturacion','sugerencia','urgente','otro')),
  priority              TEXT NOT NULL DEFAULT 'normal'
                          CHECK (priority IN ('baja','normal','alta','urgente')),
  status                TEXT NOT NULL DEFAULT 'abierto'
                          CHECK (status IN ('abierto','en_curso','esperando_cliente','resuelto','cerrado')),

  -- Tracking de actividad
  last_message_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_preview  TEXT,
  last_message_by_side  TEXT,                              -- 'client' | 'support'
  unread_for_super      INTEGER NOT NULL DEFAULT 0,
  unread_for_client     INTEGER NOT NULL DEFAULT 0,
  total_messages        INTEGER NOT NULL DEFAULT 0,

  -- Asignación (superadmin que atiende)
  assigned_to_user_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_to_name      TEXT,

  -- Cierre
  closed_at             TIMESTAMPTZ,
  closed_by_user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  closed_by_name        TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_restaurant ON public.support_tickets(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status     ON public.support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_last_msg   ON public.support_tickets(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_open       ON public.support_tickets(status, last_message_at DESC)
  WHERE status IN ('abierto','en_curso','esperando_cliente');

-- ─── 2. SUPPORT MESSAGES ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.support_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,

  -- Quien escribió
  author_user_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  author_name     TEXT,
  author_role     TEXT,                                    -- 'admin','supervisor_local','superadmin'
  author_side     TEXT NOT NULL DEFAULT 'client'
                    CHECK (author_side IN ('client','support','system')),

  -- Contenido
  body            TEXT NOT NULL,
  attachments     JSONB DEFAULT '[]',                      -- [{url,name,type,size}]

  -- Cambios automáticos de estado (cuando author_side='system')
  system_event    TEXT,                                    -- 'status_change','assigned','closed','reopened'

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON public.support_messages(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_support_messages_date   ON public.support_messages(created_at DESC);

-- ─── 3. TRIGGER: actualizar ticket cuando llega un mensaje nuevo ───────────
CREATE OR REPLACE FUNCTION public.support_message_after_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_preview TEXT;
BEGIN
  -- Eventos de sistema no cuentan como mensaje real
  IF NEW.author_side = 'system' THEN
    UPDATE public.support_tickets
       SET updated_at = NOW()
     WHERE id = NEW.ticket_id;
    RETURN NEW;
  END IF;

  v_preview := substring(NEW.body from 1 for 140);

  UPDATE public.support_tickets t
     SET last_message_at       = NEW.created_at,
         last_message_preview  = v_preview,
         last_message_by_side  = NEW.author_side,
         total_messages        = COALESCE(t.total_messages,0) + 1,
         -- Si el mensaje viene del cliente, incrementar pendiente para super
         unread_for_super      = CASE WHEN NEW.author_side='client'  THEN COALESCE(t.unread_for_super,0)+1  ELSE t.unread_for_super  END,
         unread_for_client     = CASE WHEN NEW.author_side='support' THEN COALESCE(t.unread_for_client,0)+1 ELSE t.unread_for_client END,
         -- Si estaba resuelto/cerrado y el cliente responde, reabrir
         status                = CASE
                                   WHEN NEW.author_side='client' AND t.status IN ('resuelto','cerrado') THEN 'abierto'
                                   WHEN NEW.author_side='support' AND t.status = 'abierto' THEN 'en_curso'
                                   ELSE t.status
                                 END,
         updated_at            = NOW()
   WHERE t.id = NEW.ticket_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_support_message_after_insert ON public.support_messages;
CREATE TRIGGER trg_support_message_after_insert
  AFTER INSERT ON public.support_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.support_message_after_insert();

-- ─── 4. RPC: marcar mensajes leídos (resetea contador correspondiente) ─────
CREATE OR REPLACE FUNCTION public.support_mark_read(p_ticket_id UUID, p_side TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_side = 'support' THEN
    UPDATE public.support_tickets SET unread_for_super  = 0, updated_at = NOW() WHERE id = p_ticket_id;
  ELSIF p_side = 'client' THEN
    UPDATE public.support_tickets SET unread_for_client = 0, updated_at = NOW() WHERE id = p_ticket_id;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.support_mark_read(UUID, TEXT) TO authenticated;

-- ─── 5. RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE public.support_tickets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "support_tickets_all"  ON public.support_tickets;
DROP POLICY IF EXISTS "support_messages_all" ON public.support_messages;

CREATE POLICY "support_tickets_all"  ON public.support_tickets  USING (true) WITH CHECK (true);
CREATE POLICY "support_messages_all" ON public.support_messages USING (true) WITH CHECK (true);

-- ─── 6. REALTIME ───────────────────────────────────────────────────────────
DO $$ BEGIN
  PERFORM 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='support_tickets';
  IF NOT FOUND THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.support_tickets;
  END IF;
END $$;

DO $$ BEGIN
  PERFORM 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='support_messages';
  IF NOT FOUND THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.support_messages;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Fin migration 073
-- ════════════════════════════════════════════════════════════════════════════
