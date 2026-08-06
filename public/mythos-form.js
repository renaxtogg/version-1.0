/* ════════════════════════════════════════════════════════════════════
   MYTHOS · mythos-form.js — renderer único de los formularios públicos
   ────────────────────────────────────────────────────────────────────
   Dibuja cualquier formulario del motor de la migración 211: pide la
   definición con `public_form_get`, la pinta, valida y la manda con
   `public_form_submit`. Las preguntas NO están acá — viven en la base y se
   editan desde Superadmin › Sitio web › Formularios › Encuestas.

   POR QUÉ ES UN SCRIPT PLANO Y NO UN COMPONENTE DE REACT
   Los dos lugares donde se usa viven en mundos distintos: `/riders` es un panel
   Vite (src/riders/main.jsx) y `/proveedores` es HTML+JS plano sin bundle. Un
   .jsx compartido sólo serviría en el primero, y una segunda copia para el
   segundo se desincroniza en el primer cambio de validación — que es
   exactamente el bug que después aparece como "el formulario de proveedores
   acepta cosas que el de riders rechaza". Mismo criterio y mismo patrón que
   `mythos-receipt.js`, compartido entre caja (Vite) y admin (Vite) sin ser
   módulo de ninguno de los dos.

   USO
     MythosForm.mount(elemento, {
       slug: 'delivery-partners',
       db:   clienteSupabase,        // opcional: si falta, lo busca solo
       onState: function (estado) {} // 'cargando'|'abierto'|'cerrado'|'enviado'|'error'
     });
   Devuelve { destroy: fn }.

   ESTILOS
   Todo sale de tokens.css (`var(--…)`), así que la misma pantalla se ve bien
   en `/riders` y en `/proveedores` sin que ninguna página agregue CSS, y el
   tema oscuro llega solo. Los botones reusan `.btn` de web-marketing.css para
   que sean los botones del sitio y no unos parecidos.

   LA VALIDACIÓN DE ACÁ NO ES LA VALIDACIÓN
   Lo de este archivo es para que la persona vea el error al lado del campo. La
   que manda es la de `public_form_submit` en la base: cualquiera puede postear
   contra PostgREST con la anon key salteándose esta pantalla entera. Si se
   cambia una regla acá, se cambia también allá (o al revés, el envío rebota
   con un mensaje que el visitante no puede corregir).
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var OTHER = '__other__';        // opción "Otra" que agrega la UI
  var STYLE_ID = 'mythos-form-css';

  /* ── Estilos, una sola vez por página ───────────────────────────── */
  function injectCSS() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.mf{max-width:720px;margin:0 auto;text-align:left}',
      '.mf *{box-sizing:border-box}',
      '.mf-head{margin-bottom:22px}',
      '.mf-head h3{margin:0 0 8px;font-size:22px;line-height:1.25;color:var(--text-primary)}',
      '.mf-head p{margin:0;font-size:14px;line-height:1.6;color:var(--text-secondary)}',

      '.mf-prog{position:sticky;top:0;z-index:5;padding:12px 0 14px;margin-bottom:6px;',
      '  background:var(--bg);border-bottom:1px solid var(--border)}',
      '.mf-prog-row{display:flex;justify-content:space-between;align-items:center;gap:12px;',
      '  font-size:12px;color:var(--text-secondary);margin-bottom:7px}',
      '.mf-prog-bar{height:6px;border-radius:4px;background:var(--bg-subtle);overflow:hidden}',
      '.mf-prog-fill{height:100%;border-radius:4px;background:var(--text-primary);transition:width .35s ease}',

      '.mf-q{border:1px solid var(--border);border-radius:14px;background:var(--surface);',
      '  padding:18px 18px 16px;margin-bottom:14px;scroll-margin-top:90px}',
      '.mf-q.mf-bad{border-color:var(--error)}',
      '.mf-q-label{display:block;font-size:14.5px;font-weight:600;line-height:1.4;',
      '  color:var(--text-primary);margin-bottom:4px}',
      '.mf-req{color:var(--error);margin-left:3px}',
      '.mf-q-help{font-size:12.5px;line-height:1.5;color:var(--text-tertiary);margin:0 0 12px}',
      '.mf-q-err{font-size:12.5px;color:var(--error);margin-top:9px;display:none}',
      '.mf-q.mf-bad .mf-q-err{display:block}',

      '.mf-opts{display:flex;flex-direction:column;gap:8px;margin-top:10px}',
      '.mf-opt{display:flex;align-items:center;gap:11px;padding:11px 14px;border-radius:11px;',
      '  border:1px solid var(--border);cursor:pointer;font-size:14px;line-height:1.35;',
      '  color:var(--text-primary);transition:border-color .12s,background .12s}',
      '.mf-opt:hover{border-color:var(--text-tertiary)}',
      '.mf-opt input{accent-color:var(--text-primary);width:17px;height:17px;flex:none;margin:0;cursor:pointer}',
      '.mf-opt.on{border-color:var(--text-primary);background:var(--bg-subtle)}',

      '.mf-in,.mf-ta{width:100%;padding:12px 14px;border-radius:11px;border:1px solid var(--border);',
      '  background:var(--surface);color:var(--text-primary);font-size:15px;font-family:inherit;',
      '  line-height:1.45;margin-top:10px}',
      '.mf-in:focus,.mf-ta:focus{outline:none;border-color:var(--text-primary)}',
      '.mf-ta{min-height:110px;resize:vertical}',
      '.mf-other{margin-top:9px;margin-left:28px;max-width:calc(100% - 28px)}',

      '.mf-alert{border-radius:12px;padding:13px 15px;font-size:13.5px;line-height:1.55;margin-bottom:16px}',
      '.mf-alert-bad{background:color-mix(in srgb,var(--error) 10%,transparent);color:var(--error);',
      '  border:1px solid color-mix(in srgb,var(--error) 32%,transparent)}',
      '.mf-alert-warn{background:color-mix(in srgb,var(--warning) 14%,transparent);',
      '  color:var(--text-primary);border:1px solid color-mix(in srgb,var(--warning) 38%,transparent)}',

      '.mf-foot{margin-top:20px;display:flex;flex-direction:column;gap:11px;align-items:stretch}',
      '.mf-note{font-size:12px;color:var(--text-tertiary);line-height:1.55;text-align:center;margin:0}',

      '.mf-state{text-align:center;padding:48px 20px;color:var(--text-secondary);font-size:14px}',
      '.mf-done{text-align:center;padding:44px 24px;border:1px solid var(--border);',
      '  border-radius:18px;background:var(--surface)}',
      '.mf-done-ic{width:60px;height:60px;border-radius:50%;margin:0 auto 18px;display:flex;',
      '  align-items:center;justify-content:center;font-size:29px;',
      '  background:color-mix(in srgb,var(--success) 15%,transparent);color:var(--success)}',
      '.mf-done h3{margin:0 0 10px;font-size:21px;color:var(--text-primary)}',
      '.mf-done p{margin:0;font-size:14.5px;line-height:1.65;color:var(--text-secondary)}',

      '@media (max-width:640px){',
      '  .mf-head h3{font-size:19px}',
      '  .mf-q{padding:15px 14px 14px;border-radius:12px}',
      '  .mf-opt{padding:12px;font-size:14.5px}',
      '}'
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ── Utilidades ─────────────────────────────────────────────────── */
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  function digits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

  function resolveDb(given) {
    if (given) return given;
    if (window.__mythosDb) return window.__mythosDb;
    try {
      var cfg = window.SUPABASE_CONFIG;
      if (cfg && cfg.url && cfg.anonKey && window.supabase) {
        window.__mythosDb = window.supabase.createClient(cfg.url, cfg.anonKey);
        return window.__mythosDb;
      }
    } catch (e) {}
    return null;
  }

  // De qué campaña vino. Se guarda en sessionStorage porque la persona puede
  // entrar por /riders?utm_source=instagram, navegar a otra sección y recién
  // ahí completar: sin esto, la respuesta quedaría sin origen y el formulario
  // perdería justo el dato que no se puede preguntar.
  function captureUTM() {
    var keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid'];
    var out = {}, found = false;
    try {
      var qs = new URLSearchParams(window.location.search);
      keys.forEach(function (k) {
        var v = qs.get(k);
        if (v) { out[k] = String(v).slice(0, 120); found = true; }
      });
      if (found) sessionStorage.setItem('mythos_utm', JSON.stringify(out));
      else {
        var saved = sessionStorage.getItem('mythos_utm');
        if (saved) out = JSON.parse(saved) || {};
      }
    } catch (e) { /* sessionStorage bloqueado: se manda sin UTM, no se rompe */ }
    return out;
  }

  function detectDevice() {
    var ua = navigator.userAgent || '';
    if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
    if (/Mobi|Android|iPhone|iPod|Windows Phone/i.test(ua)) return 'movil';
    return 'escritorio';
  }

  /* ── Una pregunta ───────────────────────────────────────────────── */
  // Devuelve { node, read, validate, focus } — el estado vive en el closure y
  // no en un objeto global, así que dos formularios en la misma página no se
  // pisan.
  function buildQuestion(q, onChange) {
    var node = el('div', 'mf-q');
    node.setAttribute('data-qkey', q.qkey);

    var lab = el('label', 'mf-q-label');
    lab.appendChild(document.createTextNode(q.label));
    if (q.required) { var r = el('span', 'mf-req', '*'); lab.appendChild(r); }
    node.appendChild(lab);

    if (q.help) node.appendChild(el('p', 'mf-q-help', q.help));

    var errBox = el('div', 'mf-q-err', '');
    var opts = Array.isArray(q.options) ? q.options : [];
    var isChoice = q.qtype === 'single' || q.qtype === 'multi';
    var multi = q.qtype === 'multi';

    var selected = multi ? [] : null;
    var otherText = '';
    var otherInput = null;
    var rows = [];

    function clearErr() { node.classList.remove('mf-bad'); }
    function otherPicked() {
      return multi ? selected.indexOf(OTHER) >= 0 : selected === OTHER;
    }

    function paint() {
      rows.forEach(function (row) {
        var on = multi ? selected.indexOf(row.value) >= 0 : selected === row.value;
        row.wrap.classList.toggle('on', on);
        row.input.checked = on;
      });
      if (otherInput) {
        var otherOn = multi ? selected.indexOf(OTHER) >= 0 : selected === OTHER;
        otherInput.style.display = otherOn ? '' : 'none';
      }
    }

    if (isChoice) {
      var list = el('div', 'mf-opts');
      var choices = opts.slice();
      // La opción "Otra" la agrega la UI, no la base: así el texto libre entra
      // como 'otro:<lo que escribió>' y el reporte lo puede contar junto sin
      // perder lo escrito. Por eso el seed de la 211 NO trae una opción "Otro"
      // muda en las preguntas con allow_other.
      if (q.allow_other) choices.push({ value: OTHER, label: 'Otra — escribila' });

      choices.forEach(function (o) {
        var wrap = el('label', 'mf-opt');
        var input = document.createElement('input');
        input.type = multi ? 'checkbox' : 'radio';
        input.name = 'mf_' + q.qkey;
        input.value = o.value;
        wrap.appendChild(input);
        wrap.appendChild(document.createTextNode(o.label));
        input.addEventListener('change', function () {
          if (multi) {
            var i = selected.indexOf(o.value);
            if (i >= 0) selected.splice(i, 1); else selected.push(o.value);
          } else {
            selected = o.value;
          }
          clearErr(); paint(); onChange();
        });
        list.appendChild(wrap);
        rows.push({ value: o.value, wrap: wrap, input: input });
      });
      node.appendChild(list);

      if (q.allow_other) {
        otherInput = document.createElement('input');
        otherInput.type = 'text';
        otherInput.className = 'mf-in mf-other';
        otherInput.placeholder = 'Contanos cuál';
        otherInput.maxLength = Math.max(1, (q.max_len || 60) - 5);   // 'otro:' ocupa 5
        otherInput.style.display = 'none';
        otherInput.addEventListener('input', function () {
          otherText = otherInput.value; clearErr(); onChange();
        });
        node.appendChild(otherInput);
      }

    } else if (q.qtype === 'long_text') {
      var ta = document.createElement('textarea');
      ta.className = 'mf-ta';
      ta.maxLength = q.max_len || 1500;
      if (q.placeholder) ta.placeholder = q.placeholder;
      ta.addEventListener('input', function () { clearErr(); onChange(); });
      node.appendChild(ta);
      rows.push({ input: ta });

    } else {
      var inp = document.createElement('input');
      inp.className = 'mf-in';
      inp.maxLength = q.max_len || 120;
      if (q.placeholder) inp.placeholder = q.placeholder;
      // El teclado numérico ayuda, pero el `type` sigue siendo `text`: un
      // `type=number` en el WhatsApp le come el 0 inicial de "0981…" y en el
      // monto rechaza el punto de miles que la gente escribe igual.
      if (q.qkey === 'whatsapp') { inp.type = 'tel'; inp.inputMode = 'tel'; inp.autocomplete = 'tel'; }
      else if (q.qtype === 'number') { inp.inputMode = 'numeric'; }
      else if (q.qkey === 'nombre') { inp.autocomplete = 'name'; }
      inp.addEventListener('input', function () { clearErr(); onChange(); });
      node.appendChild(inp);
      rows.push({ input: inp });
    }

    node.appendChild(errBox);

    function read() {
      if (multi) {
        var out = [];
        selected.forEach(function (v) {
          if (v === OTHER) { if (otherText.trim()) out.push('otro:' + otherText.trim()); }
          else out.push(v);
        });
        return out;
      }
      if (q.qtype === 'single') {
        if (selected === OTHER) return otherText.trim() ? 'otro:' + otherText.trim() : '';
        return selected || '';
      }
      return (rows[0] && rows[0].input.value || '').trim();
    }

    function answered() {
      var v = read();
      return multi ? v.length > 0 : String(v).length > 0;
    }

    function validate() {
      var v = read();
      var msg = '';
      // El chequeo de "Otra" va PRIMERO: si sólo mirásemos `required`, alguien
      // que marcó "Otra" junto a otra opción y no escribió nada pasaría la
      // validación y perdería su respuesta en silencio — read() la descarta por
      // vacía. Y si "Otra" era lo único marcado, el mensaje sería el genérico
      // "elegí una opción", que no dice qué falta.
      if (isChoice && otherPicked() && !otherText.trim()) {
        msg = 'Escribí cuál.';
      } else if (q.required && !answered()) {
        msg = multi ? 'Elegí al menos una opción.'
            : isChoice ? 'Elegí una opción.' : 'Completá este campo.';
      } else if (q.qkey === 'whatsapp' && digits(v).length < 8) {
        // Mismo umbral que la base (mig 198 y 211): un celular paraguayo sin
        // prefijo ya son 10 dígitos y una línea fija 9.
        msg = 'Escribí un número de WhatsApp válido, con el código de ciudad.';
      } else if (q.qkey === 'nombre' && String(v).trim().length < 2) {
        msg = 'Escribí tu nombre.';
      } else if (q.qtype === 'number' && v && !/\d/.test(v)) {
        msg = 'Escribí un número.';
      }
      if (msg) { errBox.textContent = msg; node.classList.add('mf-bad'); return false; }
      clearErr();
      return true;
    }

    function focus() {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      var first = otherInput && otherInput.style.display !== 'none' ? otherInput
                : (rows[0] && rows[0].input);
      if (first && first.focus) { try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); } }
    }

    return { node: node, read: read, answered: answered, validate: validate, focus: focus, q: q };
  }

  /* ── Montaje ────────────────────────────────────────────────────── */
  function mount(host, opts) {
    opts = opts || {};
    injectCSS();

    var db = resolveDb(opts.db);
    var slug = opts.slug;
    var notify = typeof opts.onState === 'function' ? opts.onState : function () {};
    var alive = true;

    var root = el('div', 'mf');
    host.innerHTML = '';
    host.appendChild(root);

    function state(html) { root.innerHTML = ''; root.appendChild(html); }

    if (!db) {
      notify('error');
      state(el('div', 'mf-state', 'No pudimos conectarnos. Recargá la página e intentá de nuevo.'));
      return { destroy: function () { alive = false; } };
    }

    notify('cargando');
    state(el('div', 'mf-state', 'Cargando el formulario…'));

    db.rpc('public_form_get', { p_slug: slug }).then(function (res) {
      if (!alive) return;
      var f = res && res.data;
      if (res && res.error) throw res.error;
      if (!f || !f.found) {
        notify('error');
        state(el('div', 'mf-state', 'Este formulario no está disponible.'));
        return;
      }
      if (!f.is_open) {
        notify('cerrado');
        var warn = el('div', 'mf-alert mf-alert-warn', f.closed_message || 'Este formulario está cerrado por ahora.');
        state(warn);
        return;
      }
      render(f);
    }).catch(function () {
      if (!alive) return;
      notify('error');
      state(el('div', 'mf-state', 'No pudimos cargar el formulario. Revisá tu conexión e intentá de nuevo.'));
    });

    function render(f) {
      notify('abierto');
      root.innerHTML = '';

      if (opts.showHeader !== false) {
        var head = el('div', 'mf-head');
        head.appendChild(el('h3', null, f.title));
        if (f.description) head.appendChild(el('p', null, f.description));
        root.appendChild(head);
      }

      var alertBox = el('div', 'mf-alert mf-alert-bad');
      alertBox.style.display = 'none';
      root.appendChild(alertBox);

      // Progreso. En una encuesta de 16 preguntas es la diferencia entre
      // "esto no termina más" y "me faltan tres".
      var prog = el('div', 'mf-prog');
      var progRow = el('div', 'mf-prog-row');
      var progTxt = el('span', null, '');
      var progPct = el('span', null, '');
      progRow.appendChild(progTxt); progRow.appendChild(progPct);
      var bar = el('div', 'mf-prog-bar');
      var fill = el('div', 'mf-prog-fill');
      fill.style.width = '0%';
      bar.appendChild(fill);
      prog.appendChild(progRow); prog.appendChild(bar);
      root.appendChild(prog);

      var qs = Array.isArray(f.questions) ? f.questions : [];
      var built = [];

      function refreshProgress() {
        var done = 0;
        built.forEach(function (b) { if (b.answered()) done++; });
        var pct = qs.length ? Math.round((done / qs.length) * 100) : 0;
        progTxt.textContent = done + ' de ' + qs.length + ' respondidas';
        progPct.textContent = pct + '%';
        fill.style.width = pct + '%';
      }

      var body = el('div');
      qs.forEach(function (q) {
        var b = buildQuestion(q, refreshProgress);
        built.push(b);
        body.appendChild(b.node);
      });
      root.appendChild(body);

      var foot = el('div', 'mf-foot');
      var send = el('button', 'btn btn-primary btn-lg', 'Enviar mis respuestas');
      send.type = 'button';
      foot.appendChild(send);
      foot.appendChild(el('p', 'mf-note',
        'Usamos tus datos sólo para contactarte por esta postulación. No los compartimos con nadie.'));
      root.appendChild(foot);

      refreshProgress();

      send.addEventListener('click', function () {
        alertBox.style.display = 'none';

        var firstBad = null;
        built.forEach(function (b) { if (!b.validate() && !firstBad) firstBad = b; });
        if (firstBad) {
          alertBox.textContent = 'Faltan algunos datos. Te los marcamos abajo.';
          alertBox.style.display = '';
          firstBad.focus();
          return;
        }

        var answers = {};
        built.forEach(function (b) {
          var v = b.read();
          if (Array.isArray(v) ? v.length : String(v).length) answers[b.q.qkey] = v;
        });

        var payload = {
          answers: answers,
          utm: captureUTM(),
          referrer: document.referrer || '',
          landing_path: window.location.pathname + window.location.search,
          user_agent: navigator.userAgent || '',
          device: detectDevice()
        };

        send.disabled = true;
        var prev = send.textContent;
        send.textContent = 'Enviando…';

        db.rpc('public_form_submit', { p_slug: slug, payload: payload }).then(function (res) {
          if (!alive) return;
          if (res && res.error) throw res.error;
          notify('enviado');
          if (window.MythosWeb && MythosWeb.track) {
            try { MythosWeb.track('public_form_submit', { slug: slug }); } catch (e) {}
          }
          var d = (res && res.data) || {};
          var done = el('div', 'mf-done');
          done.appendChild(el('div', 'mf-done-ic', '✓'));
          done.appendChild(el('h3', null, d.title || f.success_title || '¡Listo!'));
          done.appendChild(el('p', null, d.message || f.success_message || 'Gracias por responder.'));
          root.innerHTML = '';
          root.appendChild(done);
          done.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }).catch(function (e) {
          if (!alive) return;
          send.disabled = false;
          send.textContent = prev;
          // Los mensajes de la RPC están escritos para que los lea el visitante
          // ("Ya tenemos tu respuesta con ese número"), así que se muestran tal
          // cual. Sólo se reemplazan los errores de infraestructura.
          var msg = (e && (e.message || e.hint)) || '';
          if (!msg || /fetch|network|failed/i.test(msg)) {
            msg = 'No pudimos enviar tus respuestas. Revisá tu conexión e intentá de nuevo.';
          }
          alertBox.textContent = msg;
          alertBox.style.display = '';
          alertBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      });
    }

    return { destroy: function () { alive = false; host.innerHTML = ''; } };
  }

  window.MythosForm = { mount: mount };
})();
