// ════════════════════════════════════════════════════════════════════
// PR-MKT-2 — Módulo "Marketplace" (lado RESTAURANTE), COMPARTIDO por los
// paneles admin y gerente vía factory: cada panel inyecta sus primitivos UI
// (paleta C reactiva, Modal, Btn, Inp, Sel, Lbl, Th, Td, Empty, Icon, toast)
// y su RID. Usa SOLO el subconjunto de props común a ambos paneles.
//
// Dominio: marketplace_* (mig 142/143). NO confundir con public.suppliers /
// supplier_contacts (proveedores INTERNOS de compras del admin, mig 072).
//
// REGLA DE ORO (modelo de negocio): el contacto del proveedor solo se muestra
// si (a) la RLS ya lo deja leer porque existe un lead previo de mi restaurante
// ("Ya contactado") o (b) el usuario toca CONTACTAR → RPC
// request_supplier_contact que registra el lead primero. Nunca por otra vía.
// Sin pagos, sin carrito: Mythos solo conecta.
// ════════════════════════════════════════════════════════════════════
import { createMarketplaceChat } from './chat.jsx';

// ctx.InternalSuppliers (OPCIONAL) — componente del panel anfitrión con la agenda
// de proveedores INTERNOS (public.suppliers / supplier_purchases, mig 072). Si viene,
// se renderiza arriba de "Mis proveedores" y el panel deja de necesitar un módulo de
// nav propio (obs. Renato 2026-07-30). Si no viene (panel gerente), la pestaña
// muestra solo los guardados del marketplace, como antes.
export function createRestaurantMarketplace(ctx) {
  const { React, db, rid, C, Icon, toast, Modal, Btn, Inp, Sel, Lbl, Th, Td, Empty, shouldPause, InternalSuppliers } = ctx;
  const { useState, useEffect, useRef, useCallback, useMemo } = React;
  const ChatSection = createMarketplaceChat(ctx);

  /* ── utils locales (el módulo no asume helpers del panel anfitrión) ── */
  const fmt     = n => '₲ ' + (Math.round(n) || 0).toLocaleString('es-PY');
  const fmtDate = d => d ? new Date(d).toLocaleDateString('es-PY', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—';
  const paused  = () => (typeof shouldPause === 'function' ? shouldPause() : false);
  const precioLabel = p =>
    p.precio_tipo === 'cotizar' ? 'A cotizar'
    : p.precio_tipo === 'desde' ? `Desde ${fmt(p.precio)}`
    : fmt(p.precio);
  const waLink = num => {
    const digits = String(num || '').replace(/\D/g, '');
    return digits ? `https://wa.me/${digits}?text=${encodeURIComponent('Hola, te encontré en el marketplace de Mythos')}` : null;
  };
  // Sanitiza términos para el filtro or() de PostgREST (coma/paréntesis rompen la sintaxis del filtro)
  const ilikeSafe = s => String(s || '').replace(/[,()]/g, ' ').trim();

  const LEAD_TIPO   = { contacto: 'Contacto', cotizacion: 'Cotización' };
  const LEAD_ESTADO = { nueva: 'Enviada', respondida: 'Respondida', negociando: 'Negociando', cerrada: 'Cerrada', perdida: 'Perdida', archivada: 'Archivada' };
  const LEAD_ESTADOS_RESTAURANTE = ['negociando', 'cerrada', 'perdida', 'archivada']; // estados que el restaurante puede setear
  const FRECUENCIAS = [['', 'Sin definir'], ['unica', 'Única'], ['semanal', 'Semanal'], ['mensual', 'Mensual'], ['a_definir', 'A definir']];
  const REPORT_TIPOS = [
    ['info_falsa', 'Información falsa'], ['precio_enganoso', 'Precio engañoso'], ['no_responde', 'No responde'],
    ['mala_calidad', 'Mala calidad'], ['no_entrego', 'No entregó'], ['trato_indebido', 'Trato indebido'],
    ['spam', 'Spam'], ['otro', 'Otro'],
  ];

  /* ── primitivos propios (APIs de Badge/Txt difieren entre paneles) ── */
  function MkBadge({ color, children }) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', fontSize: 10.5, fontWeight: 700, background: color + '22', color, border: `1px solid ${color}44`, borderRadius: 5, whiteSpace: 'nowrap' }}>
        {children}
      </span>
    );
  }
  function MkTxt({ value, onChange, placeholder, rows = 3 }) {
    return <textarea value={value || ''} onChange={onChange} placeholder={placeholder} rows={rows}
      style={{ width: '100%', padding: '9px 11px', fontSize: 13, borderRadius: 6, resize: 'vertical', fontFamily: 'inherit' }} />;
  }
  function Chip({ on, onClick, children }) {
    return (
      <button type="button" onClick={onClick} style={{
        padding: '5px 12px', borderRadius: 14, fontSize: 12, fontWeight: 600, cursor: 'pointer',
        border: `1px solid ${on ? C.ink : C.border}`, background: on ? C.ink : 'transparent', color: on ? C.sidebar : C.ink,
      }}>{children}</button>
    );
  }
  function MkCard({ children, style: sx }) {
    return <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, ...sx }}>{children}</div>;
  }
  function SupplierBadges({ s, zonaMatch }) {
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {s.verificado && <MkBadge color={C.blue}>Verificado</MkBadge>}
        {s.destacado && <MkBadge color={C.orange}>Destacado</MkBadge>}
        {s.emite_factura && <MkBadge color={C.green}>Factura</MkBadge>}
        {zonaMatch && <MkBadge color={C.ink}>Entrega en tu zona</MkBadge>}
      </div>
    );
  }

  function SupplierCard({ s, catName, zonaMatch, onOpen }) {
    return (
      <MkCard style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 260 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 44, height: 44, borderRadius: 10, border: `1px solid ${C.border}`, overflow: 'hidden', flexShrink: 0, background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {s.logo_url
              ? <img src={s.logo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <Icon name="store" size={18} style={{ color: C.dim }} />}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.nombre_comercial}</div>
            <div style={{ fontSize: 11, color: C.dim }}>{s.ciudad || '—'}{s.departamento ? ` · ${s.departamento}` : ''}</div>
          </div>
        </div>
        <SupplierBadges s={s} zonaMatch={zonaMatch} />
        <div style={{ fontSize: 11, color: C.mid, minHeight: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {(s.categorias || []).map(catName).filter(Boolean).slice(0, 4).join(' · ') || 'Sin categorías'}
        </div>
        <Btn variant="secondary" small onClick={() => onOpen(s)}>Ver perfil</Btn>
      </MkCard>
    );
  }

  function ProductCard({ p, supplierName, onOpenSupplier, onQuote }) {
    return (
      <MkCard style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 220 }}>
        <div style={{ height: 96, borderRadius: 8, border: `1px solid ${C.border}`, overflow: 'hidden', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {p.imagen_url
            ? <img src={p.imagen_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <Icon name="package" size={22} style={{ color: C.dim }} />}
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{p.nombre}</div>
          <div style={{ fontSize: 11, color: C.dim }}>{p.presentacion || p.marca || '—'}</div>
        </div>
        <div style={{ fontSize: 13, fontWeight: 800, fontFamily: "'SF Mono',ui-monospace,monospace", color: C.ink }}>{precioLabel(p)}</div>
        {supplierName && <div style={{ fontSize: 11, color: C.mid }}>{supplierName}</div>}
        <div style={{ display: 'flex', gap: 6 }}>
          <Btn variant="secondary" small onClick={onOpenSupplier} style={{ flex: 1 }}>Ver proveedor</Btn>
          {onQuote && <Btn small onClick={onQuote}>Cotizar</Btn>}
        </div>
      </MkCard>
    );
  }

  /* ════════════════ EXPLORAR ════════════════ */
  function Explorar({ cats, suppliers, loadingSup, onOpenSupplier }) {
    const [q, setQ] = useState('');
    const [selCat, setSelCat] = useState('');
    const [fCiudad, setFCiudad] = useState('');
    const [fZona, setFZona] = useState('');
    const [fFactura, setFFactura] = useState(false);
    const [fVerificado, setFVerificado] = useState(false);
    const [fDestacado, setFDestacado] = useState(false);
    const [products, setProducts] = useState([]);
    const [searching, setSearching] = useState(false);

    const catName = slug => (cats.find(c => c.slug === slug)?.nombre) || slug;
    const supById = useMemo(() => { const m = {}; suppliers.forEach(s => { m[s.id] = s; }); return m; }, [suppliers]);
    const hasSearch = !!(q.trim() || selCat);

    // Búsqueda de productos server-side (ILIKE), debounce 350ms
    useEffect(() => {
      if (!db) return;
      if (!hasSearch) { setProducts([]); return; }
      let on = true;
      setSearching(true);
      const t = setTimeout(async () => {
        let query = db.from('marketplace_products').select('*')
          .eq('estado', 'publicado').order('created_at', { ascending: false }).limit(60);
        if (selCat) query = query.eq('categoria_slug', selCat);
        const term = ilikeSafe(q);
        if (term) query = query.or(`nombre.ilike.%${term}%,descripcion.ilike.%${term}%,marca.ilike.%${term}%`);
        const { data } = await query;
        if (on) { setProducts(data || []); setSearching(false); }
      }, 350);
      return () => { on = false; clearTimeout(t); };
    }, [q, selCat, hasSearch]);

    const filtered = suppliers.filter(s => {
      if (selCat && !(s.categorias || []).includes(selCat)) return false;
      if (q.trim()) {
        const hay = `${s.nombre_comercial} ${s.descripcion || ''} ${(s.categorias || []).join(' ')}`.toLowerCase();
        if (!hay.includes(q.trim().toLowerCase())) return false;
      }
      if (fCiudad && !(`${s.ciudad || ''} ${s.departamento || ''}`).toLowerCase().includes(fCiudad.toLowerCase())) return false;
      if (fZona && !(s.zonas_entrega || []).some(z => z.toLowerCase().includes(fZona.toLowerCase()))) return false;
      if (fFactura && !s.emite_factura) return false;
      if (fVerificado && !s.verificado) return false;
      if (fDestacado && !s.destacado) return false;
      return true;
    });
    const zonaMatch = s => !!(fZona && (s.zonas_entrega || []).some(z => z.toLowerCase().includes(fZona.toLowerCase())));
    const destacados = suppliers.filter(s => s.destacado);
    const showDestacados = !hasSearch && !fCiudad && !fZona && !fFactura && !fVerificado && !fDestacado && destacados.length > 0;

    return (
      <div>
        {/* Buscador protagonista */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: C.dim, display: 'inline-flex' }}><Icon name="search" size={15} /></span>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscá productos o proveedores (ej: costilla, congelados, descartables…)"
              style={{ width: '100%', padding: '13px 14px 13px 36px', fontSize: 14, borderRadius: 10 }} />
          </div>
        </div>

        {/* Chips de categorías */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          <Chip on={!selCat} onClick={() => setSelCat('')}>Todas</Chip>
          {cats.map(c => <Chip key={c.slug} on={selCat === c.slug} onClick={() => setSelCat(selCat === c.slug ? '' : c.slug)}>{c.nombre}</Chip>)}
        </div>

        {/* Filtros adicionales */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 18 }}>
          <div style={{ width: 140 }}><Inp value={fCiudad} onChange={e => setFCiudad(e.target.value)} placeholder="Ciudad" /></div>
          <div style={{ width: 170 }}><Inp value={fZona} onChange={e => setFZona(e.target.value)} placeholder="Zona de entrega" /></div>
          <Chip on={fFactura} onClick={() => setFFactura(!fFactura)}>Emite factura</Chip>
          <Chip on={fVerificado} onClick={() => setFVerificado(!fVerificado)}>Verificados</Chip>
          <Chip on={fDestacado} onClick={() => setFDestacado(!fDestacado)}>Destacados</Chip>
        </div>

        {showDestacados && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.ink, letterSpacing: .5, textTransform: 'uppercase', marginBottom: 10 }}>Destacados</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              {destacados.map(s => <SupplierCard key={s.id} s={s} catName={catName} zonaMatch={false} onOpen={onOpenSupplier} />)}
            </div>
          </div>
        )}

        {/* Proveedores */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.ink, letterSpacing: .5, textTransform: 'uppercase', marginBottom: 10 }}>
            Proveedores {loadingSup ? '' : `(${filtered.length})`}
          </div>
          {loadingSup
            ? <div style={{ padding: 20, color: C.dim, fontSize: 13 }}>Cargando proveedores…</div>
            : filtered.length === 0
              ? <div style={{ padding: 20, color: C.dim, fontSize: 13 }}>Sin proveedores para esos filtros.</div>
              : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                  {filtered.map(s => <SupplierCard key={s.id} s={s} catName={catName} zonaMatch={zonaMatch(s)} onOpen={onOpenSupplier} />)}
                </div>}
        </div>

        {/* Productos (solo con búsqueda/categoría activa) */}
        {hasSearch && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.ink, letterSpacing: .5, textTransform: 'uppercase', marginBottom: 10 }}>
              Productos {searching ? '' : `(${products.length})`}
            </div>
            {searching
              ? <div style={{ padding: 20, color: C.dim, fontSize: 13 }}>Buscando…</div>
              : products.length === 0
                ? <div style={{ padding: 20, color: C.dim, fontSize: 13 }}>Sin productos publicados que coincidan.</div>
                : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                    {products.map(p => (
                      <ProductCard key={p.id} p={p} supplierName={supById[p.supplier_id]?.nombre_comercial}
                        onOpenSupplier={async () => {
                          const s = supById[p.supplier_id] || (await db.from('marketplace_suppliers').select('*').eq('id', p.supplier_id).maybeSingle()).data;
                          if (s) onOpenSupplier(s); else toast('Proveedor no disponible', false);
                        }} />
                    ))}
                  </div>}
          </div>
        )}
      </div>
    );
  }

  /* ════════════════ PERFIL DE PROVEEDOR ════════════════ */
  function PerfilProveedor({ s, cats, onBack, onOpenChatSupplier }) {
    const [prods, setProds] = useState([]);
    const [files, setFiles] = useState([]);
    const [saved, setSaved] = useState(null);
    const [nota, setNota] = useState('');
    const [contactData, setContactData] = useState(null);   // {telefono, whatsapp, email_comercial, contacto_nombre, prev}
    const [loadingContact, setLoadingContact] = useState(false);
    const [quoteOpen, setQuoteOpen] = useState(null);        // null | {product?}
    const [reportOpen, setReportOpen] = useState(false);
    const catName = slug => (cats.find(c => c.slug === slug)?.nombre) || slug;

    const load = useCallback(async () => {
      if (!db) return;
      const [p, f, sv] = await Promise.all([
        db.from('marketplace_products').select('*').eq('supplier_id', s.id).eq('estado', 'publicado').order('created_at', { ascending: false }),
        db.from('marketplace_catalog_files').select('*').eq('supplier_id', s.id).order('created_at', { ascending: false }),
        db.from('marketplace_saved').select('*').eq('restaurant_id', rid).eq('supplier_id', s.id).is('product_id', null).maybeSingle(),
      ]);
      setProds(p.data || []); setFiles(f.data || []);
      setSaved(sv.data || null); setNota(sv.data?.nota_interna || '');
    }, [s.id]);
    useEffect(() => { load(); }, [load]);

    async function toggleSave() {
      if (saved) {
        const { error } = await db.from('marketplace_saved').delete().eq('id', saved.id);
        if (error) { toast(error.message || 'No se pudo quitar', false); return; }
        setSaved(null); setNota(''); toast('Proveedor quitado de guardados');
      } else {
        // Índice único parcial (restaurant, supplier) WHERE product_id IS NULL:
        // chequeo previo + tolerancia al 23505 si otra pestaña ganó la carrera.
        const { data, error } = await db.from('marketplace_saved')
          .insert({ restaurant_id: rid, supplier_id: s.id }).select().single();
        if (error) {
          if (String(error.code) === '23505') { load(); return; }
          toast(error.message || 'No se pudo guardar', false); return;
        }
        setSaved(data); toast('Proveedor guardado');
      }
    }

    async function saveNota() {
      if (!saved) return;
      const { error } = await db.from('marketplace_saved').update({ nota_interna: nota || null }).eq('id', saved.id);
      if (error) { toast(error.message || 'No se pudo guardar la nota', false); return; }
      toast('Nota guardada');
    }

    // REGLA DE ORO: el contacto SIEMPRE sale de la RPC request_supplier_contact,
    // que registra el evento contact_revealed en cada reveal y renueva el lead
    // a los 30 días (dedupe server-side). El probe directo por RLS se usa SOLO
    // para el banner "Ya contactado" — si decidiera el contacto, los reveals
    // repetidos dejarían de contar en las métricas del proveedor.
    async function contactar() {
      setLoadingContact(true);
      try {
        const isSuperadmin = (localStorage.getItem('mythos_role') || '').trim() === 'superadmin';
        let prev = false;
        if (!isSuperadmin) {
          // legible solo si ya existe un lead de mi restaurante (RLS de la 142)
          const { data: direct } = await db.from('marketplace_supplier_contacts')
            .select('supplier_id').eq('supplier_id', s.id).maybeSingle();
          prev = !!direct;
        }
        const { data, error } = await db.rpc('request_supplier_contact', { p_supplier_id: s.id });
        if (error || !data || data.ok === false) {
          toast((error && error.message) || 'No se pudo obtener el contacto', false); return;
        }
        setContactData({ telefono: data.telefono, whatsapp: data.whatsapp, email_comercial: data.email_comercial, contacto_nombre: data.contacto_nombre, prev });
      } finally { setLoadingContact(false); }
    }

    async function openFile(f) {
      try {
        const { data, error } = await db.storage.from('supplier-files').createSignedUrl(f.file_url, 3600);
        if (error || !data?.signedUrl) throw error || new Error('sin URL');
        window.open(data.signedUrl, '_blank', 'noopener');
      } catch (_) { toast('No se pudo abrir el archivo', false); }
    }

    const wa = contactData ? waLink(contactData.whatsapp) : null;
    return (
      <div>
        <div style={{ marginBottom: 12 }}>
          <Btn variant="ghost" small onClick={onBack}>Volver al listado</Btn>
        </div>

        {/* Banner + identidad */}
        <MkCard style={{ padding: 0, overflow: 'hidden', marginBottom: 14 }}>
          <div style={{ height: 120, background: C.bg, borderBottom: `1px solid ${C.border}` }}>
            {s.banner_url && <img src={s.banner_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
          </div>
          <div style={{ padding: 16, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ width: 64, height: 64, borderRadius: 14, border: `1px solid ${C.border}`, overflow: 'hidden', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: -40, boxShadow: '0 2px 8px rgba(0,0,0,.15)' }}>
              {s.logo_url
                ? <img src={s.logo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <Icon name="store" size={24} style={{ color: C.dim }} />}
            </div>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 17, fontWeight: 800, color: C.ink }}>{s.nombre_comercial}</div>
                <SupplierBadges s={s} zonaMatch={false} />
              </div>
              <div style={{ fontSize: 12, color: C.dim, marginTop: 2 }}>
                {s.ciudad || '—'}{s.departamento ? ` · ${s.departamento}` : ''}{s.tipo_proveedor ? ` · ${s.tipo_proveedor}` : ''}
              </div>
              {s.descripcion && <div style={{ fontSize: 13, color: C.mid, marginTop: 8, lineHeight: 1.55, maxWidth: 640 }}>{s.descripcion}</div>}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
                {(s.categorias || []).map(slug => <MkBadge key={slug} color={C.mid}>{catName(slug)}</MkBadge>)}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 190 }}>
              <Btn small onClick={contactar} disabled={loadingContact}>{loadingContact ? 'Consultando…' : 'Contactar'}</Btn>
              <Btn variant="secondary" small onClick={() => setQuoteOpen({})}>Solicitar cotización</Btn>
              <Btn variant="secondary" small onClick={() => onOpenChatSupplier(s.id)}>Abrir chat</Btn>
              <Btn variant="ghost" small onClick={toggleSave}>{saved ? 'Quitar de guardados' : 'Guardar proveedor'}</Btn>
              <Btn variant="ghost" small onClick={() => setReportOpen(true)} style={{ color: C.red }}>Reportar</Btn>
            </div>
          </div>
        </MkCard>

        {saved && (
          <MkCard style={{ marginBottom: 14, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <Lbl>Nota interna (solo la ve tu equipo)</Lbl>
              <Inp value={nota} onChange={e => setNota(e.target.value)} placeholder="Ej: pedirle lista de precios los lunes" />
            </div>
            <Btn variant="secondary" small onClick={saveNota}>Guardar nota</Btn>
          </MkCard>
        )}

        {/* Condiciones comerciales */}
        <MkCard style={{ marginBottom: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 12 }}>
            <div><Lbl>Zonas de entrega</Lbl><div style={{ fontSize: 13, color: C.ink }}>{(s.zonas_entrega || []).join(', ') || '—'}</div></div>
            <div><Lbl>Días de entrega</Lbl><div style={{ fontSize: 13, color: C.ink }}>{s.dias_entrega || '—'}</div></div>
            <div><Lbl>Horario</Lbl><div style={{ fontSize: 13, color: C.ink }}>{s.horario_atencion || '—'}</div></div>
            <div><Lbl>Pedido mínimo</Lbl><div style={{ fontSize: 13, color: C.ink }}>{s.pedido_minimo || '—'}</div></div>
            <div><Lbl>Modalidades</Lbl><div style={{ fontSize: 13, color: C.ink }}>
              {[s.delivery_propio && 'Delivery propio', s.retiro_local && 'Retiro en local', s.entrega_urgente && 'Entrega urgente', s.acepta_credito && 'Acepta crédito'].filter(Boolean).join(' · ') || '—'}
            </div></div>
          </div>
          {s.condiciones_comerciales && (
            <div style={{ marginTop: 12 }}><Lbl>Condiciones comerciales</Lbl>
              <div style={{ fontSize: 13, color: C.mid, lineHeight: 1.5 }}>{s.condiciones_comerciales}</div>
            </div>
          )}
        </MkCard>

        {/* Catálogo */}
        <div style={{ fontSize: 12, fontWeight: 700, color: C.ink, letterSpacing: .5, textTransform: 'uppercase', marginBottom: 10 }}>Catálogo ({prods.length})</div>
        {prods.length === 0
          ? <div style={{ padding: 16, color: C.dim, fontSize: 13 }}>Este proveedor todavía no publicó productos.</div>
          : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
              {prods.map(p => <ProductCard key={p.id} p={p} supplierName={null}
                onOpenSupplier={() => {}} onQuote={() => setQuoteOpen({ product: p })} />)}
            </div>}

        {files.length > 0 && (
          <MkCard style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.ink, letterSpacing: .5, textTransform: 'uppercase', marginBottom: 10 }}>Archivos de catálogo</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {files.map(f => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', border: `1px solid ${C.border}`, borderRadius: 8 }}>
                  <Icon name="fileText" size={16} style={{ color: C.mid }} />
                  <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.nombre}</div>
                  <div style={{ fontSize: 11, color: C.dim }}>{(f.tipo || '').toUpperCase()}</div>
                  <Btn variant="ghost" small onClick={() => openFile(f)}>Descargar</Btn>
                </div>
              ))}
            </div>
          </MkCard>
        )}

        {/* Modal CONTACTO — la única vía de ver el contacto (regla de oro) */}
        {contactData && (
          <Modal title={`Contacto · ${s.nombre_comercial}`} onClose={() => setContactData(null)} width={420}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {contactData.prev && (
                <div style={{ fontSize: 12, color: C.mid, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px' }}>
                  Ya contactaste a este proveedor anteriormente — estos datos están en tu historial.
                </div>
              )}
              {contactData.contacto_nombre && <div><Lbl>Persona de contacto</Lbl><div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{contactData.contacto_nombre}</div></div>}
              {contactData.telefono && (
                <div><Lbl>Teléfono</Lbl>
                  <a href={`tel:${String(contactData.telefono).replace(/\s/g, '')}`} style={{ fontSize: 14, color: C.ink, fontFamily: "'SF Mono',ui-monospace,monospace" }}>{contactData.telefono}</a>
                </div>
              )}
              {contactData.whatsapp && (
                <div><Lbl>WhatsApp</Lbl>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 14, color: C.ink, fontFamily: "'SF Mono',ui-monospace,monospace" }}>{contactData.whatsapp}</span>
                    {wa && <Btn variant="secondary" small onClick={() => window.open(wa, '_blank', 'noopener')}>Abrir WhatsApp</Btn>}
                  </div>
                </div>
              )}
              {contactData.email_comercial && (
                <div><Lbl>Email</Lbl>
                  <a href={`mailto:${contactData.email_comercial}`} style={{ fontSize: 14, color: C.ink }}>{contactData.email_comercial}</a>
                </div>
              )}
              <div style={{ fontSize: 11, color: C.dim, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                Contacto registrado en tu historial (Mis proveedores).
              </div>
            </div>
          </Modal>
        )}

        {/* Modal COTIZACIÓN */}
        {quoteOpen && (
          <QuoteModal s={s} prods={prods} initialProduct={quoteOpen.product || null}
            onClose={() => setQuoteOpen(null)}
            onCreated={convId => { setQuoteOpen(null); onOpenChatSupplier(null, convId); }} />
        )}

        {/* Modal REPORTE */}
        {reportOpen && (
          <ReportModal s={s} onClose={() => setReportOpen(false)} />
        )}
      </div>
    );
  }

  function QuoteModal({ s, prods, initialProduct, onClose, onCreated }) {
    const [prodId, setProdId] = useState(initialProduct?.id || '');
    const [texto, setTexto] = useState('');
    const [cant, setCant] = useState('');
    const [frec, setFrec] = useState('');
    const [msg, setMsg] = useState('');
    const [saving, setSaving] = useState(false);

    async function submit() {
      if (!prodId && !texto.trim()) { toast('Elegí un producto o escribí qué necesitás cotizar', false); return; }
      setSaving(true);
      const { data, error } = await db.rpc('create_supplier_quote', {
        p_supplier_id: s.id,
        p_product_id: prodId || null,
        p_producto_texto: texto.trim() || null,
        p_cantidad: cant.trim() || null,
        p_frecuencia: frec || null,
        p_mensaje: msg.trim() || null,
      });
      setSaving(false);
      if (error || !data || data.ok === false) { toast((error && error.message) || 'No se pudo enviar la cotización', false); return; }
      toast('Cotización enviada al proveedor');
      onCreated(data.conversation_id || null);
    }

    return (
      <Modal title={`Cotización · ${s.nombre_comercial}`} onClose={onClose} width={480}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Lbl>Producto del catálogo</Lbl>
            <Sel value={prodId} onChange={e => setProdId(e.target.value)}>
              <option value="">Otro (texto libre)</option>
              {prods.map(p => <option key={p.id} value={p.id}>{p.nombre}{p.presentacion ? ` — ${p.presentacion}` : ''}</option>)}
            </Sel>
          </div>
          <div>
            <Lbl>{prodId ? 'Detalle adicional (opcional)' : 'Qué necesitás cotizar *'}</Lbl>
            <Inp value={texto} onChange={e => setTexto(e.target.value)} placeholder="Ej: costilla vacuna en caja de 20 kg" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><Lbl>Cantidad</Lbl><Inp value={cant} onChange={e => setCant(e.target.value)} placeholder="Ej: 3 cajas" /></div>
            <div>
              <Lbl>Frecuencia</Lbl>
              <Sel value={frec} onChange={e => setFrec(e.target.value)}>
                {FRECUENCIAS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Sel>
            </div>
          </div>
          <div><Lbl>Mensaje</Lbl><MkTxt value={msg} onChange={e => setMsg(e.target.value)} rows={3} placeholder="Contale al proveedor lo que necesitás" /></div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <Btn variant="ghost" small onClick={onClose}>Cancelar</Btn>
            <Btn small onClick={submit} disabled={saving}>{saving ? 'Enviando…' : 'Enviar cotización'}</Btn>
          </div>
        </div>
      </Modal>
    );
  }

  function ReportModal({ s, onClose }) {
    const [tipo, setTipo] = useState('info_falsa');
    const [detalle, setDetalle] = useState('');
    const [saving, setSaving] = useState(false);
    async function submit() {
      setSaving(true);
      const { error } = await db.from('marketplace_reports').insert({
        reporter_restaurant_id: rid, target_supplier_id: s.id, tipo, detalle: detalle.trim() || null,
      });
      setSaving(false);
      if (error) { toast(error.message || 'No se pudo enviar el reporte', false); return; }
      toast('Reporte enviado al equipo de Mythos');
      onClose();
    }
    return (
      <Modal title={`Reportar · ${s.nombre_comercial}`} onClose={onClose} width={420}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Lbl>Motivo</Lbl>
            <Sel value={tipo} onChange={e => setTipo(e.target.value)}>
              {REPORT_TIPOS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Sel>
          </div>
          <div><Lbl>Detalle</Lbl><MkTxt value={detalle} onChange={e => setDetalle(e.target.value)} rows={3} placeholder="Contanos qué pasó" /></div>
          <div style={{ fontSize: 11, color: C.dim }}>El reporte lo revisa el equipo de Mythos. No se comparte con el proveedor.</div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <Btn variant="ghost" small onClick={onClose}>Cancelar</Btn>
            <Btn variant="danger" small onClick={submit} disabled={saving}>{saving ? 'Enviando…' : 'Enviar reporte'}</Btn>
          </div>
        </div>
      </Modal>
    );
  }

  /* ════════════════ MIS PROVEEDORES ════════════════ */
  function MisProveedores({ onOpenSupplier, onOpenChatSupplier }) {
    const [saved, setSaved] = useState([]);
    const [leads, setLeads] = useState([]);
    const [supNames, setSupNames] = useState({});
    const [notas, setNotas] = useState({});
    const [loading, setLoading] = useState(true);

    const load = useCallback(async (force) => {
      if (!db) return;
      if (!force && paused()) return;
      // .eq(restaurant_id, rid) explícito: la RLS es la garantía de seguridad,
      // pero bajo superadmin (?r=) las policies *_superadmin_all devolverían
      // leads/conversaciones de TODA la plataforma (y en multi-sucursal se
      // mezclarían locales sin etiqueta).
      const [{ data: sv }, { data: ls }, { data: info }, { data: convs }] = await Promise.all([
        db.from('marketplace_saved').select('*').eq('restaurant_id', rid).order('created_at', { ascending: false }),
        db.from('marketplace_leads').select('*').eq('restaurant_id', rid).order('created_at', { ascending: false }).limit(200),
        db.rpc('get_my_marketplace_conversations_info'),
        db.from('marketplace_conversations').select('id,supplier_id').eq('restaurant_id', rid),
      ]);
      setSaved(sv || []); setLeads(ls || []);
      setNotas(n => { const m = { ...n }; (sv || []).forEach(r => { if (!(r.id in m)) m[r.id] = r.nota_interna || ''; }); return m; });
      // Nombres: los suppliers activos salen del select directo; los pausados/
      // suspendidos (invisibles por RLS) se resuelven vía la RPC de
      // conversaciones (mig 143), que fue creada justamente para eso.
      const m = {};
      const nameByConv = {};
      (info || []).forEach(r => { nameByConv[r.conversation_id] = r.counterpart_name; });
      (convs || []).forEach(c => { if (nameByConv[c.id]) m[c.supplier_id] = nameByConv[c.id]; });
      const ids = Array.from(new Set([...(sv || []).map(r => r.supplier_id), ...(ls || []).map(l => l.supplier_id)]));
      if (ids.length) {
        const { data: sup } = await db.from('marketplace_suppliers').select('id,nombre_comercial').in('id', ids);
        (sup || []).forEach(x => { m[x.id] = x.nombre_comercial; });
      }
      setSupNames(m);
      setLoading(false);
    }, []);
    useEffect(() => { load(true); const id = setInterval(() => load(false), 30000); return () => clearInterval(id); }, [load]);

    async function saveNota(row) {
      const { error } = await db.from('marketplace_saved').update({ nota_interna: notas[row.id] || null }).eq('id', row.id);
      if (error) { toast(error.message || 'No se pudo guardar la nota', false); return; }
      toast('Nota guardada');
    }
    async function quitar(row) {
      const { error } = await db.from('marketplace_saved').delete().eq('id', row.id);
      if (error) { toast(error.message || 'No se pudo quitar', false); return; }
      load();
    }
    async function verPerfil(supplierId) {
      const { data: s } = await db.from('marketplace_suppliers').select('*').eq('id', supplierId).maybeSingle();
      if (s) onOpenSupplier(s); else toast('Proveedor no disponible actualmente', false);
    }
    async function setLeadEstado(lead, estado) {
      const { error } = await db.from('marketplace_leads').update({ estado }).eq('id', lead.id);
      if (error) { toast(error.message || 'No se pudo actualizar', false); return; }
      // Actualización optimista: load() se auto-cancela por paused() mientras
      // el <select> conserva el foco, y el Sel controlado "rebotaría" al valor
      // viejo aunque el UPDATE haya sido exitoso.
      setLeads(ls => ls.map(x => x.id === lead.id ? { ...x, estado } : x));
      toast('Estado actualizado');
    }

    return (
      <div>
        {/* Agenda de proveedores propios del local (inyectada por el panel anfitrión).
            Va PRIMERO: "mis proveedores" son los que ya le compro, no los guardados. */}
        {InternalSuppliers && (
          <div style={{ marginBottom: 26, paddingBottom: 26, borderBottom: `1px solid ${C.border}` }}>
            <InternalSuppliers embedded />
          </div>
        )}

        <div style={{ fontSize: 12, fontWeight: 700, color: C.ink, letterSpacing: .5, textTransform: 'uppercase', marginBottom: 4 }}>Guardados del marketplace ({saved.length})</div>
        <div style={{ fontSize: 11.5, color: C.dim, marginBottom: 10 }}>Proveedores que marcaste desde Explorar. Todavía no son proveedores tuyos: son candidatos.</div>
        {loading ? <div style={{ padding: 16, color: C.dim, fontSize: 13 }}>Cargando…</div>
          : saved.length === 0
            ? <div style={{ padding: 16, color: C.dim, fontSize: 13, marginBottom: 16 }}>Todavía no guardaste proveedores. Guardalos desde su perfil para tenerlos a mano.</div>
            : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
                {saved.map(r => (
                  <MkCard key={r.id} style={{ width: 280, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: C.ink }}>{supNames[r.supplier_id] || 'Proveedor'}</div>
                    {r.product_id && <div style={{ fontSize: 11, color: C.dim }}>Producto guardado</div>}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Inp value={notas[r.id] || ''} onChange={e => setNotas(n => ({ ...n, [r.id]: e.target.value }))} placeholder="Nota interna" />
                      </div>
                      <Btn variant="secondary" small onClick={() => saveNota(r)}>OK</Btn>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <Btn variant="secondary" small onClick={() => verPerfil(r.supplier_id)}>Ver perfil</Btn>
                      <Btn variant="secondary" small onClick={() => onOpenChatSupplier(r.supplier_id)}>Abrir chat</Btn>
                      <Btn variant="ghost" small onClick={() => quitar(r)}>Quitar</Btn>
                    </div>
                  </MkCard>
                ))}
              </div>
            )}

        <div style={{ fontSize: 12, fontWeight: 700, color: C.ink, letterSpacing: .5, textTransform: 'uppercase', marginBottom: 10 }}>Historial de solicitudes</div>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
              <thead><tr style={{ borderBottom: `1px solid ${C.border}` }}>
                <Th>Fecha</Th><Th>Proveedor</Th><Th>Tipo</Th><Th>Producto</Th><Th>Estado</Th><Th right>Chat</Th>
              </tr></thead>
              <tbody>
                {loading ? <Empty cols={6} label="Cargando…" />
                  : leads.length === 0 ? <Empty cols={6} label="Sin solicitudes todavía: pedí una cotización o un contacto desde Explorar." />
                  : leads.map(l => (
                    <tr key={l.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <Td dim>{fmtDate(l.created_at)}</Td>
                      <Td><span style={{ fontWeight: 700 }}>{supNames[l.supplier_id] || 'Proveedor'}</span></Td>
                      <Td>{LEAD_TIPO[l.tipo] || l.tipo}</Td>
                      <Td dim>{l.producto_texto || '—'}</Td>
                      <Td>
                        <Sel value={l.estado} onChange={e => setLeadEstado(l, e.target.value)} style={{ width: 130, padding: '5px 8px', fontSize: 12 }}>
                          {!LEAD_ESTADOS_RESTAURANTE.includes(l.estado) && <option value={l.estado}>{LEAD_ESTADO[l.estado] || l.estado}</option>}
                          {LEAD_ESTADOS_RESTAURANTE.map(k => <option key={k} value={k}>{LEAD_ESTADO[k]}</option>)}
                        </Sel>
                      </Td>
                      <Td right><Btn variant="ghost" small onClick={() => onOpenChatSupplier(l.supplier_id)}>Abrir</Btn></Td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  /* ════════════════ ROOT ════════════════ */
  function Marketplace() {
    // Si el panel inyectó su agenda de proveedores propios (admin), la entrada de nav
    // se llama "Proveedores" → abrir en "Mis proveedores", que es lo que el dueño
    // viene a ver. Sin inyección (gerente) el módulo es puro marketplace → "Explorar".
    const [tab, setTab] = useState(InternalSuppliers ? 'mis' : 'explorar');   // explorar | mis | mensajes
    const [selSupplier, setSelSupplier] = useState(null);
    const [chatTarget, setChatTarget] = useState(null);
    const [unread, setUnread] = useState(0);
    const [cats, setCats] = useState([]);
    const [suppliers, setSuppliers] = useState([]);
    const [loadingSup, setLoadingSup] = useState(true);

    useEffect(() => {
      if (!db) return;
      (async () => {
        const [{ data: c }, { data: s }] = await Promise.all([
          db.from('marketplace_categories').select('slug,nombre').eq('activa', true).order('orden'),
          db.from('marketplace_suppliers').select('*').eq('estado', 'activo')
            .order('destacado', { ascending: false }).order('created_at', { ascending: false }).limit(300),
        ]);
        setCats(c || []); setSuppliers(s || []); setLoadingSup(false);
      })();
    }, []);

    // Badge de mensajes sin leer (cuando NO estoy en la pestaña de mensajes,
    // el ChatSection no está montado → poll liviano propio).
    useEffect(() => {
      if (!db || tab === 'mensajes') return;
      let on = true;
      const check = async () => {
        if (paused()) return;
        let q = db.from('marketplace_conversations').select('restaurant_unread');
        if (rid) q = q.eq('restaurant_id', rid); // scoping UI (superadmin ?r= / multi-sucursal)
        const { data } = await q;
        if (on && Array.isArray(data)) setUnread(data.reduce((s, c) => s + (c.restaurant_unread || 0), 0));
      };
      check();
      const id = setInterval(check, 30000);
      return () => { on = false; clearInterval(id); };
    }, [tab]);

    const openChat = convId => { setChatTarget(convId || null); setSelSupplier(null); setTab('mensajes'); };
    // Abre (o crea) la conversación con un proveedor. Si ya viene un
    // conversation_id (cotización recién creada), va directo. Busca primero la
    // conversación existente: ensure_conversation exige proveedor ACTIVO, y un
    // chat ya iniciado con un proveedor hoy pausado debe seguir abrible.
    async function openChatSupplier(supplierId, convId) {
      if (convId) { openChat(convId); return; }
      if (!supplierId) { openChat(null); return; }
      if (!rid) { toast('Sin restaurante activo (superadmin: abrí el panel con ?r=)', false); return; }
      const { data: existing } = await db.from('marketplace_conversations')
        .select('id').eq('restaurant_id', rid).eq('supplier_id', supplierId).maybeSingle();
      if (existing) { openChat(existing.id); return; }
      const { data, error } = await db.rpc('ensure_conversation', { p_supplier_id: supplierId, p_restaurant_id: rid });
      if (error || !data) { toast((error && error.message) || 'No se pudo abrir el chat', false); return; }
      openChat(data);
    }

    const TABS = [['explorar', 'Explorar'], ['mis', 'Mis proveedores'], ['mensajes', 'Mensajes']];

    return (
      <div className="page">
        <div style={{ marginBottom: 4, fontSize: 18, fontWeight: 800, color: C.ink }}>Marketplace de proveedores</div>
        <div style={{ fontSize: 12, color: C.mid, marginBottom: 14 }}>
          Encontrá proveedores gastronómicos, pedí cotizaciones y coordiná por chat. Mythos solo conecta: sin pagos ni comisiones.
        </div>

        <div style={{ display: 'flex', gap: 6, borderBottom: `1px solid ${C.border}`, marginBottom: 16 }}>
          {TABS.map(([k, l]) => (
            <button key={k} onClick={() => { setTab(k); setSelSupplier(null); }} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '10px 16px', background: 'none', border: 'none',
              borderBottom: `2px solid ${tab === k && !selSupplier ? C.ink : 'transparent'}`,
              color: tab === k && !selSupplier ? C.ink : C.dim, fontSize: 13, fontWeight: tab === k ? 700 : 500, cursor: 'pointer', marginBottom: -1,
            }}>
              {l}
              {k === 'mensajes' && unread > 0 && (
                <span style={{ background: C.red, color: C.sidebar, fontSize: 10, fontWeight: 800, padding: '1px 6px', borderRadius: 9, minWidth: 16, textAlign: 'center' }}>{unread}</span>
              )}
            </button>
          ))}
        </div>

        {selSupplier
          ? <PerfilProveedor s={selSupplier} cats={cats} onBack={() => setSelSupplier(null)} onOpenChatSupplier={openChatSupplier} />
          : tab === 'explorar'
            ? <Explorar cats={cats} suppliers={suppliers} loadingSup={loadingSup} onOpenSupplier={setSelSupplier} />
            : tab === 'mis'
              ? <MisProveedores onOpenSupplier={s => { setSelSupplier(s); }} onOpenChatSupplier={openChatSupplier} />
              : <ChatSection side="restaurant" openConversationId={chatTarget}
                  onOpened={() => setChatTarget(null)} onUnreadTotal={setUnread} />}
      </div>
    );
  }

  return Marketplace;
}
