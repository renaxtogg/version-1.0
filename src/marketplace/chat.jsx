// ════════════════════════════════════════════════════════════════════
// PR-MKT-2 — Chat del marketplace B2B (módulo COMPARTIDO).
// Lo consumen src/proveedor (side='supplier') y el módulo Marketplace de
// admin/gerente (side='restaurant') vía factory: cada panel le inyecta sus
// primitivos UI (paleta C reactiva al tema, Icon, toast, Btn) para que las
// burbujas hereden el look del panel anfitrión.
//
// Reglas de datos (mig 142 + 143 — NO cambiar):
//   · marketplace_conversations: los contadores unread los INCREMENTA el
//     trigger DEFINER de marketplace_messages. La UI solo resetea el propio
//     vía RPC marketplace_mark_read (el supplier no tiene UPDATE directo), y
//     SOLO cuando el usuario realmente está mirando (pestaña visible).
//   · Nombres de contraparte: RPC get_my_marketplace_conversations_info
//     (el supplier no puede leer restaurants; el restaurante no puede leer
//     suppliers pausados).
//   · Mensajes: INSERT con sender = lado propio y sender_user = auth.uid()
//     (la RLS rechaza spoofing) — solo texto en esta fase (sin adjuntos:
//     el bucket supplier-files está scoped por carpeta del supplier y NO se
//     debilitan sus policies para adjuntos de restaurante).
//   · Se muestran los ÚLTIMOS 300 mensajes del hilo (desc + reverse: pedir
//     asc+limit devolvería los 300 más VIEJOS y congelaría el chat).
//   · Realtime en marketplace_messages (publication de la 142) + polling
//     de respaldo cada 15s (patrón delivery).
// ════════════════════════════════════════════════════════════════════

export function createMarketplaceChat(ctx) {
  const { React, db, C, Icon, toast, Btn, shouldPause, rid } = ctx;
  const { useState, useEffect, useRef, useCallback } = React;

  const MSG_LIMIT = 300;
  const fmtTime = d => d ? new Date(d).toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' }) : '';
  const fmtDay  = d => d ? new Date(d).toLocaleDateString('es-PY', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '';
  const paused  = () => (typeof shouldPause === 'function' ? shouldPause() : false);
  const visible = () => !document.hidden;

  /* Burbuja de mensaje. `mine` = lo escribió mi lado → derecha, tinta plena. */
  function Bubble({ m, mine }) {
    return (
      <div style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', padding: '2px 0' }}>
        <div style={{
          maxWidth: '72%', padding: '8px 12px', borderRadius: 12, fontSize: 13, lineHeight: 1.45,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          background: mine ? C.ink : C.surface,
          color: mine ? C.sidebar : C.ink,
          border: mine ? 'none' : `1px solid ${C.border}`,
          borderBottomRightRadius: mine ? 4 : 12,
          borderBottomLeftRadius: mine ? 12 : 4,
        }}>
          {m.body}
          <div style={{ fontSize: 10, marginTop: 4, textAlign: 'right', color: mine ? C.sidebar : C.dim, opacity: mine ? .7 : 1 }}>
            {fmtTime(m.created_at)}
          </div>
        </div>
      </div>
    );
  }

  /**
   * ChatSection — lista de conversaciones + hilo activo.
   *   side: 'restaurant' | 'supplier' (mi lado: burbujas a la derecha, unread propio)
   *   openConversationId: uuid opcional — abre esa conversación al montar/cambiar
   *   onOpened: callback para limpiar el pedido de apertura del padre
   *   onUnreadTotal: callback(total) — suma de unread propios (badge del padre)
   */
  function ChatSection({ side, openConversationId, onOpened, onUnreadTotal }) {
    const [convs, setConvs] = useState([]);
    const [names, setNames] = useState({});
    const [sel, setSel] = useState(null);
    const [msgs, setMsgs] = useState([]);
    const [text, setText] = useState('');
    const [uid, setUid] = useState(null);
    const [loading, setLoading] = useState(true);
    const [sending, setSending] = useState(false);
    const listRef = useRef(null);
    const selRef = useRef(null);
    selRef.current = sel;                 // guard anti-respuestas-obsoletas
    const convsRef = useRef([]);
    convsRef.current = convs;
    const lastScrollKeyRef = useRef('');
    const myUnread = c => side === 'supplier' ? (c.supplier_unread || 0) : (c.restaurant_unread || 0);

    useEffect(() => {
      if (!db) return;
      db.auth.getSession().then(({ data: { session } }) => setUid(session?.user?.id || null));
    }, []);

    // force=true en cargas iniciadas por el usuario (mount, apertura, mark_read):
    // el paused() solo debe frenar el POLLING, no la primera pintura.
    const loadConvs = useCallback(async (force) => {
      if (!db) return;
      if (!force && paused()) return;
      let q = db.from('marketplace_conversations').select('*')
        .order('last_message_at', { ascending: false, nullsFirst: false });
      // Scoping explícito de UI (la RLS sigue siendo la garantía de seguridad):
      // bajo superadmin (?r=) las policies *_superadmin_all devolverían TODAS
      // las conversaciones de la plataforma.
      if (side === 'restaurant' && rid) q = q.eq('restaurant_id', rid);
      const [{ data: cs }, { data: info }] = await Promise.all([
        q,
        db.rpc('get_my_marketplace_conversations_info'),
      ]);
      setConvs(cs || []);
      const m = {};
      (info || []).forEach(r => { m[r.conversation_id] = r.counterpart_name; });
      setNames(m);
      setLoading(false);
      if (onUnreadTotal) onUnreadTotal((cs || []).reduce((s, c) => s + myUnread(c), 0));
    }, [onUnreadTotal]);

    useEffect(() => {
      loadConvs(true);
      const id = setInterval(() => loadConvs(false), 15000);
      return () => clearInterval(id);
    }, [loadConvs]);

    // Apertura pedida desde afuera (Responder / cotización recién creada)
    useEffect(() => {
      if (openConversationId) {
        setSel(openConversationId);
        loadConvs(true);
        if (onOpened) onOpened();
      }
    }, [openConversationId]); // eslint-disable-line react-hooks/exhaustive-deps

    // Últimos N mensajes (desc + reverse). Descarta respuestas obsoletas si el
    // usuario ya cambió de conversación, y evita setMsgs si nada cambió (para
    // no re-disparar el efecto de autoscroll en cada poll).
    const loadMsgs = useCallback(async (cid) => {
      if (!db) return;
      const { data } = await db.from('marketplace_messages').select('*')
        .eq('conversation_id', cid).order('created_at', { ascending: false }).limit(MSG_LIMIT);
      if (selRef.current !== cid) return;
      const next = (data || []).reverse();
      setMsgs(prev => {
        if (prev.length === next.length
            && prev[prev.length - 1]?.id === next[next.length - 1]?.id
            && prev[0]?.id === next[0]?.id) return prev;
        return next;
      });
    }, []);

    const markRead = useCallback((cid) => {
      if (!db || !cid) return;
      db.rpc('marketplace_mark_read', { p_conversation_id: cid }).then(() => loadConvs(true));
    }, [loadConvs]);

    // Conversación activa: mensajes + realtime + polling fallback + mark read.
    // mark_read SOLO con la pestaña visible: "leído" = el usuario lo vio, no
    // "el hilo estaba montado en una pestaña en background".
    useEffect(() => {
      if (!sel || !db) { setMsgs([]); return; }
      let on = true;
      loadMsgs(sel);
      if (visible()) markRead(sel);
      const ch = db.channel(`mkp-chat-${sel}`)
        .on('postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'marketplace_messages', filter: `conversation_id=eq.${sel}` },
          payload => {
            if (!on || !payload?.new) return;
            setMsgs(p => p.some(m => m.id === payload.new.id) ? p : [...p, payload.new]);
            if (visible()) markRead(sel);
          })
        .subscribe();
      // Poll de respaldo (Realtime caído): también debe limpiar el unread que
      // el trigger incrementó, si el usuario está mirando el hilo.
      const id = setInterval(() => {
        if (paused()) return;
        loadMsgs(sel);
        if (visible()) {
          const c = convsRef.current.find(x => x.id === sel);
          if (c && myUnread(c) > 0) markRead(sel);
        }
      }, 15000);
      // Volver a la pestaña con el hilo abierto = ahora sí lo vio.
      const onVis = () => { if (on && visible()) markRead(sel); };
      document.addEventListener('visibilitychange', onVis);
      return () => {
        on = false;
        db.removeChannel(ch);
        clearInterval(id);
        document.removeEventListener('visibilitychange', onVis);
      };
    }, [sel, loadMsgs, markRead]);

    // Autoscroll: solo cuando el contenido realmente cambió Y el usuario está
    // cerca del fondo (o es la primera pintura del hilo) — leer historial
    // scrolleado arriba no debe "arrastrar" al fondo en cada poll.
    useEffect(() => {
      const el = listRef.current;
      if (!el) return;
      const key = `${sel}:${msgs.length}:${msgs[msgs.length - 1]?.id || ''}`;
      if (key === lastScrollKeyRef.current) return;
      const firstPaint = !lastScrollKeyRef.current.startsWith(`${sel}:`);
      lastScrollKeyRef.current = key;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
      if (firstPaint || nearBottom) el.scrollTop = el.scrollHeight;
    }, [msgs, sel]);

    async function send() {
      const body = text.trim();
      if (!body || !sel || sending || !uid) return;
      setSending(true);
      const { error } = await db.from('marketplace_messages')
        .insert({ conversation_id: sel, sender: side, sender_user: uid, body });
      setSending(false);
      if (error) { toast(error.message || 'No se pudo enviar el mensaje', false); return; }
      setText('');
      loadMsgs(sel);
      loadConvs(true);
    }

    return (
      <div style={{ display: 'flex', gap: 0, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden', background: C.surface, minHeight: 480, height: 'calc(100vh - 220px)' }}>
        {/* Lista de conversaciones */}
        <div style={{ width: 280, flexShrink: 0, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '12px 14px', borderBottom: `1px solid ${C.border}`, fontSize: 12, fontWeight: 700, color: C.ink, letterSpacing: .5, textTransform: 'uppercase' }}>
            Conversaciones
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading ? (
              <div style={{ padding: 20, textAlign: 'center', color: C.dim, fontSize: 12 }}>Cargando…</div>
            ) : convs.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', color: C.dim, fontSize: 12, lineHeight: 1.6 }}>
                {side === 'supplier'
                  ? 'Sin conversaciones todavía. Se crean cuando un restaurante te pide una cotización (o al responder una solicitud).'
                  : 'Sin conversaciones todavía. Pedí una cotización a un proveedor para iniciar una.'}
              </div>
            ) : convs.map(c => {
              const un = myUnread(c);
              const active = c.id === sel;
              return (
                <button key={c.id} onClick={() => setSel(c.id)} style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                  padding: '11px 14px', background: active ? C.ink : 'transparent',
                  borderBottom: `1px solid ${C.border}`, cursor: 'pointer',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: un > 0 ? 800 : 600, color: active ? C.sidebar : C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {names[c.id] || (side === 'supplier' ? 'Restaurante' : 'Proveedor')}
                    </div>
                    <div style={{ fontSize: 11, color: active ? C.sidebar : C.dim, opacity: active ? .75 : 1 }}>
                      {c.last_message_at ? `${fmtDay(c.last_message_at)} ${fmtTime(c.last_message_at)}` : 'Sin mensajes'}
                    </div>
                  </div>
                  {un > 0 && (
                    <span style={{ background: active ? C.sidebar : C.red, color: active ? C.red : C.sidebar, fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 10, minWidth: 18, textAlign: 'center', flexShrink: 0 }}>
                      {un}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Hilo activo */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {!sel ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, color: C.dim }}>
              <Icon name="chat" size={28} />
              <div style={{ fontSize: 13 }}>Elegí una conversación</div>
            </div>
          ) : (
            <>
              <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>
                  {names[sel] || (side === 'supplier' ? 'Restaurante' : 'Proveedor')}
                </div>
                {msgs.length >= MSG_LIMIT && (
                  <div style={{ fontSize: 10.5, color: C.dim }}>mostrando los últimos {MSG_LIMIT} mensajes</div>
                )}
              </div>
              <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', background: C.bg }}>
                {msgs.length === 0
                  ? <div style={{ textAlign: 'center', color: C.dim, fontSize: 12, paddingTop: 30 }}>Sin mensajes en esta conversación.</div>
                  : msgs.map(m => <Bubble key={m.id} m={m} mine={m.sender === side} />)}
              </div>
              <div style={{ padding: 12, borderTop: `1px solid ${C.border}`, display: 'flex', gap: 8 }}>
                <input
                  value={text}
                  onChange={e => setText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                  placeholder="Escribí un mensaje…"
                  style={{ flex: 1, padding: '10px 12px', fontSize: 13, borderRadius: 8 }}
                />
                <Btn small onClick={send} disabled={sending || !text.trim() || !uid}>
                  {sending ? 'Enviando…' : 'Enviar'}
                </Btn>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return ChatSection;
}
