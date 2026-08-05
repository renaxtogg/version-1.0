/* ════════════════════════════════════════════════════════════
   mythos-receipt.js — Renderer de comprobantes térmicos (compartido)
   ────────────────────────────────────────────────────────────
   Módulo global (window.MythosReceipt), cargado como <script> normal
   (igual que mythos-gating.js). Lo usan:
     · caja  → imprimir el ticket al cobrar (MythosReceipt.print)
     · admin → vista previa en vivo del diseñador (MythosReceipt.buildHTML)
   Así "lo que se ve en la preview = lo que se imprime".

   CONTRATO DURO:
     · buildHTML(data, config) → SOLO devuelve el documento HTML (markup +
       <style>). NUNCA llama window.print() ni inyecta onload. Esto permite
       usarlo en un <iframe srcDoc> sin que imprima solo.
     · print(data, config) → es el ÚNICO que inyecta el auto-print.
     · buildText(data, config) → el MISMO ticket en texto plano (debug /
       futuro agente ESC/POS). El HTML es este texto + estilos.

   ── POR QUÉ ESTÁ ESCRITO COMO UNA GRILLA DE CARACTERES ──────
   Caso Nativa Gastronomía (2026-08-01): el ticket salió con "?" donde iba
   el guaraní, sin separadores, sin centrado y con el precio pegado al
   nombre ("1x Papas fritas? 18.000"). Causa: el driver de la térmica
   imprimió en MODO TEXTO, no como gráfico. En modo texto el navegador
   entrega sólo el texto y se pierde TODO el CSS (centrado, bordes,
   columnas de la <table>), y cada carácter que no está en la code page
   de la impresora sale como "?".

   Dos consecuencias que rigen este archivo:
     1. NADA de lo que se imprime puede depender de CSS para ser legible.
        El ticket se arma como líneas de ancho fijo (charsPerLine) con
        relleno de ESPACIOS REALES: centrado y columna de importes se
        sostienen igual en modo gráfico y en modo texto. El CSS ya sólo
        aporta énfasis (negrita / tamaño), nunca posición.
     2. Todo texto pasa por sane(): el glifo ₲ (U+20B2) NO existe en
        NINGUNA code page ESC/POS — se emite "Gs." (configurable en
        settings_json.receipt.currency).

     3. El @page declara SIEMPRE las dos medidas: `size: <ancho>mm <alto>mm`.
        `size: <ancho>mm auto` —que es lo que había acá antes— NO es CSS
        válido: la gramática es <length>{1,2} | auto | <page-size>, y `auto`
        no se combina con una medida. Chrome descartaba la regla entera y
        usaba el papel del diálogo (A4): el ticket se partía en páginas y
        entre uno y otro salían ~20cm de papel en blanco. El alto se calcula
        desde la grilla en buildHTML().
   ════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var MM = 96 / 25.4;          // 1mm en px CSS
  // Avance de un glifo monoespaciado: Consolas 0.55em, Courier New 0.60em. Se
  // calcula con 0.62 a propósito — quedarse corto deja un margen extra a los
  // costados (invisible), pasarse empuja el último carácter fuera del papel.
  var MONO_RATIO = 0.62;

  // Métricas verticales. Son a la vez CSS y la fórmula del alto de página, así
  // que viven acá una sola vez: si se tocan en el <style> y no acá, el alto
  // calculado deja de coincidir con lo que se dibuja y el ticket se parte.
  var LINE_H = 1.28;                        // line-height sin unidad
  var SCALE = { md: 1.15, lg: 1.35 };       // font-size de las líneas destacadas, en em
  var LOGO_MAX_MM = 22;

  // ── helpers autocontenidos (no dependen de ningún panel) ──────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── Sanitizado para térmicas ──────────────────────────────────────
  // Mapea los glifos que las code pages ESC/POS (CP437/CP850/CP858/WPC1252)
  // NO tienen. Los acentos y ¡¿ SÍ están en CP1252/CP858 → se respetan salvo
  // que el local active asciiOnly (impresoras con code page rara).
  var SUB = {
    '₲': 'Gs.', /* ₲ */ '×': 'x',   /* × */ '—': '-', /* — */
    '–': '-',   /* – */ '−': '-',   /* − */ '‘': "'",
    '’': "'",   '“': '"',   '”': '"',   '…': '...',
    ' ': ' ',   '•': '*',   '–': '-',   '✓': 'OK',
    '→': '->',  '€': 'EUR', '·': '.',   '′': "'"
  };
  var SUB_RE = /[₲×—–−‘’“”… •✓→€·′]/g;

  function sane(s, asciiOnly) {
    s = String(s == null ? '' : s).replace(SUB_RE, function (c) { return SUB[c] || ' '; });
    if (asciiOnly) {
      // NFD + quitar diacríticos: María → Maria, Ñ → N.
      try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
      s = s.replace(/¡/g, '').replace(/¿/g, '')      // ¡ ¿
           .replace(/[^\x20-\x7E\n]/g, '');                     // resto no-ASCII fuera
    }
    return s.replace(/[\t\r]/g, ' ');
  }

  // ── grilla de caracteres ──────────────────────────────────────────
  function rep(ch, n) { return n > 0 ? new Array(n + 1).join(ch) : ''; }
  function padR(s, n) { s = String(s); return s.length >= n ? s : s + rep(' ', n - s.length); }
  function center(s, n) {
    s = String(s);
    if (s.length >= n) return s;
    return rep(' ', Math.floor((n - s.length) / 2)) + s;   // sin relleno a la derecha: no aporta y gasta papel
  }
  // Izquierda + derecha en una línea de n caracteres (columna de importes).
  function two(l, r, n) {
    l = String(l); r = String(r);
    var room = n - r.length;
    if (room < 1) return (l + ' ' + r).slice(0, n);
    if (l.length > room - 1) l = l.slice(0, room - 1);
    return padR(l, room) + r;
  }
  // Corta por palabras respetando \n. Parte palabras más largas que n.
  function wrap(s, n) {
    var out = [];
    String(s).split('\n').forEach(function (par) {
      var words = par.split(/\s+/).filter(Boolean), cur = '';
      if (!words.length) { out.push(''); return; }
      words.forEach(function (w) {
        while (w.length > n) {
          // Palabra más larga que la línea: se parte. Primero se completa lo
          // que quede de la línea en curso, si no queda un renglón casi vacío
          // ("1x" solo, con el nombre entero empujado abajo).
          if (cur) {
            var room = n - cur.length - 1;
            if (room > 3) { cur += ' ' + w.slice(0, room); w = w.slice(room); }
            out.push(cur); cur = '';
          } else { out.push(w.slice(0, n)); w = w.slice(n); }
        }
        if (!cur) cur = w;
        else if (cur.length + 1 + w.length <= n) cur += ' ' + w;
        else { out.push(cur); cur = w; }
      });
      if (cur) out.push(cur);
    });
    return out;
  }

  // Miles con punto, determinista (no depende del locale del navegador de caja).
  function miles(n) {
    n = Math.round(Number(n) || 0);
    var neg = n < 0; n = Math.abs(n);
    return (neg ? '-' : '') + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }
  function money(n, cur) { return cur ? cur + ' ' + miles(n) : miles(n); }

  // Los acentos se dejan escritos bien: sane() los conserva (CP1252/CP858 los
  // tiene) y sólo los pela si el local activa asciiOnly.
  var METODOS = {
    efectivo: 'Efectivo', tarjeta_credito: 'Tarjeta Crédito', tarjeta_debito: 'Tarjeta Débito',
    qr: 'QR / Transferencia', transferencia: 'Transferencia', mixto: 'Mixto',
    gift_card: 'Gift card', cuenta_corriente: 'Cuenta corriente'
  };

  // ── Config por defecto: sin config guardada, imprime un ticket
  //    completo y bien dimensionado en 80mm (todos los campos ON). ──
  var defaultConfig = {
    paperWidth: 80,            // 58 | 80 (mm)
    // Grilla real del ticket: define el tamaño de fuente Y cuánto del rollo se
    // aprovecha. 48 en 80mm y 32 en 58mm son las columnas de la Font A de
    // cualquier térmica ESC/POS: con menos, el driver en modo texto imprime la
    // misma cantidad de columnas y sobra papel a la derecha.
    charsPerLine: 48,
    currency: 'Gs.',           // ← ASCII. Con '₲' la térmica en modo texto imprime "?"
    asciiOnly: false,          // true = sin acentos ni ¡¿ (code pages viejas)
    feedLines: 3,              // líneas en blanco al final para poder cortar el papel
    showLogo: false,           // off por defecto (drivers térmicos rinden mal las imágenes)
    fields: {
      orderNumber: true, customerName: true, table: true, cashier: true,
      dateTime: true, paymentMethod: true, change: true, ruc: true,
      // Off por defecto: agrega un renglón por ítem y el "@" se lee como un
      // error de impresión (lo pidió sacar Nativa Gastronomía). Quien lo quiera
      // lo prende en Admin → Comprobante.
      unitPrice: false
    },
    header: {
      showName: true, showAddress: true, showPhone: true,
      showInstagram: true, showFacebook: false, showRuc: true
    },
    footer: '¡Gracias por su visita!',
    legalNote: 'COMPROBANTE DE CONSUMO\nNo válido como factura legal',
    social: { facebook: '' },

    // ── QUÉ SE IMPRIME EN CADA VENTA ────────────────────────────────
    // Hasta ahora el sistema imprimía UN solo papel: el del cliente. Ahora son
    // tres documentos distintos y cada local elige cuáles usa. Los defaults
    // dejan el comportamiento de siempre: sólo el del cliente.
    //   cliente → el comprobante que se entrega
    //   interno → la misma venta, marcada como copia de control del local
    //   comanda → el papel de cocina (sin precios)
    prints: { cliente: true, interno: false, comanda: false },

    // ── COMANDA (papel de cocina) ───────────────────────────────────
    // Un local que no usa el KDS necesita que la cocina se entere del pedido:
    // sin este papel, el cocinero no sabe qué cocinar. Es OTRO documento, no
    // otro formato del ticket — comparte la impresora y la grilla, nada más.
    // Todo apagado por defecto: el que usa KDS no quiere papel saliendo solo.
    comanda: {
      autoPrint: false,      // imprimir sola al entrar un pedido nuevo (panel caja)
      copies: 1,             // 2 = una para la cocina y otra para el mostrador
      upperItems: true,      // MAYÚSCULAS: se leen de lejos en una cocina
      showWaiter: true,
      showCustomer: false,   // la cocina no necesita el nombre del cliente
      showTime: true,
      note: ''               // aviso fijo del local ("revisar alergias", etc.)
    }
  };

  // Datos de ejemplo para la vista previa / "Imprimir prueba" en admin.
  var sampleData = {
    orderNumber: '1042',
    customerName: 'María González',
    customerRuc: '',
    tableLabel: 'Mesa 5',
    cashier: 'Cajero Demo',
    createdAt: null,
    items: [
      { item_name: 'Lomito completo', quantity: 2, unit_price: 35000, total_price: 70000 },
      { item_name: 'Coca-Cola 500ml', quantity: 2, unit_price: 8000, total_price: 16000 },
      { item_name: 'Papas fritas', quantity: 1, unit_price: 18000, total_price: 18000 }
    ],
    total: 104000,
    metodo: 'efectivo',
    cambio: 16000,
    isOffline: false
  };

  function clamp(n, lo, hi) { n = Number(n); return isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo; }

  function mergeConfig(config) {
    config = config || {};
    var pw = (Number(config.paperWidth) === 58 ? 58 : 80);
    return {
      paperWidth: pw,
      charsPerLine: clamp(config.charsPerLine || (pw === 58 ? 32 : 48), 20, 64),
      // OJO: la moneda NO pasa por sane() — es justamente la perilla para que un
      // local con impresora en modo gráfico pueda elegir '₲' a sabiendas.
      currency: (config.currency != null ? String(config.currency).trim().slice(0, 6) : defaultConfig.currency),
      asciiOnly: !!config.asciiOnly,
      feedLines: clamp(config.feedLines != null ? config.feedLines : defaultConfig.feedLines, 0, 12),
      showLogo: !!config.showLogo,
      fields: Object.assign({}, defaultConfig.fields, config.fields || {}),
      header: Object.assign({}, defaultConfig.header, config.header || {}),
      footer: (config.footer != null ? config.footer : defaultConfig.footer),
      legalNote: (config.legalNote != null ? config.legalNote : defaultConfig.legalNote),
      social: Object.assign({}, defaultConfig.social, config.social || {}),
      prints: Object.assign({}, defaultConfig.prints, config.prints || {}),
      comanda: Object.assign({}, defaultConfig.comanda, config.comanda || {}),
      business: config.business || {}
    };
  }

  // dd/mm/aa hh:mm en hora del equipo de caja. A mano y no con toLocaleString:
  // es-PY devuelve "1/8/26, 8:09 p. m." — 18 caracteres que rompen la línea en
  // un rollo de 58mm y encima cambian según el navegador.
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function dateStr(data) {
    if (data.dateTime) return data.dateTime;
    var d = data.createdAt ? new Date(data.createdAt) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + String(d.getFullYear()).slice(2)
         + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  // Precio efectivo de la línea: total_price ya incluye extras/variantes
  // (mig 128+). Sin él, unit_price × cantidad.
  function lineTotal(it) {
    var qty = Number(it.quantity) || 1;
    var tp = Number(it.total_price) || 0;
    if (tp > 0) return tp;
    return (Number(it.unit_price || it.price_guarani) || 0) * qty;
  }

  /* ── Armado del ticket como lista de líneas ────────────────────────
     Cada entrada: { s: <texto ya rellenado con espacios>, k: clase }
       k = ''   → cuerpo (tamaño base, la grilla vale)
           'b'  → negrita, tamaño base
           'md' → 1.15em  · 'lg' → 1.35em (centradas a ancho reducido,
                  así el centrado por espacios también cae bien)      */
  function buildLines(data, c) {
    // La comanda es OTRO documento, no otro formato del ticket. Comparte
    // impresora, grilla y sanitizado; el contenido no tiene nada que ver.
    if (data && data.kind === 'comanda') return buildComandaLines(data, c);
    // COPIA INTERNA: el mismo ticket, pero es del local. Se marca fuerte y sin
    // el pie de cortesía — si sale igual que el del cliente, en el arqueo nadie
    // distingue la copia del original y se cuenta la venta dos veces.
    var INT = !!(data && data.kind === 'interno');
    var W = c.charsPerLine;
    var A = c.asciiOnly;
    var cur = c.currency;
    var b = c.business || {};
    var out = [];
    var S = function (x) { return sane(x, A); };
    var push = function (s, k) { out.push({ s: s, k: k || '' }); };
    var rule = function (ch) { push(rep(ch || '-', W)); };
    var block = function (txt, k, w) {          // texto centrado, multilínea
      w = w || W;
      wrap(S(txt), w).forEach(function (l) { push(center(l, w), k); });
    };
    var left = function (txt) { wrap(S(txt), W).forEach(function (l) { push(l); }); };

    // ── encabezado del negocio ──
    var head0 = out.length;
    if (c.header.showName && b.name) block(b.name, 'lg', Math.floor(W / 1.35));
    if (c.header.showRuc && (b.ruc || b.legalName)) {
      block((b.legalName || b.name || '') + (b.ruc ? ' - RUC ' + b.ruc : ''));
    }
    if (c.header.showAddress && b.address) block(b.address);
    if (c.header.showPhone && b.phone) block('Tel: ' + b.phone);
    if (c.header.showInstagram && b.instagram) block('IG: ' + b.instagram);
    var fb = (c.social && c.social.facebook) || b.facebook;
    if (c.header.showFacebook && fb) block('FB: ' + fb);
    if (out.length > head0) rule();

    // ── nota legal / tipo de comprobante ──
    var legalLines = String(
      INT ? 'COPIA INTERNA\nControl del local — no entregar al cliente' : (c.legalNote || '')
    ).split('\n').filter(function (l) { return l.trim(); });
    if (legalLines.length) {
      legalLines.forEach(function (l, i) { block(l, i === 0 ? 'b' : ''); });
      rule();
    }

    // ── meta (pago parcial / pedido / fecha / mesa / cliente / cajero) ──
    var meta0 = out.length;
    if (data.partial) block('** PAGO PARCIAL **', 'b');
    if (c.fields.orderNumber && data.orderNumber != null) {
      block('Pedido #' + data.orderNumber + (data.isOffline ? ' (LOCAL)' : ''), 'md', Math.floor(W / 1.15));
    }
    if (c.fields.dateTime) left('Fecha: ' + dateStr(data));
    if (c.fields.table && data.tableLabel) left(String(data.tableLabel));
    if (c.fields.customerName) left('Cliente: ' + (data.customerName || 'Anónimo'));
    if (c.fields.ruc && data.customerRuc) left('RUC Cliente: ' + data.customerRuc);
    // En la copia interna el cajero va SIEMPRE: es una copia de control, y sin
    // saber quién cobró no sirve para arquear.
    if ((c.fields.cashier || INT) && data.cashier) left('Cajero: ' + data.cashier);
    if (out.length > meta0) rule();

    // ── ítems: nombre a la izquierda, importe en columna derecha ──
    var items = (data.items || []).filter(Boolean);
    var amounts = items.map(lineTotal);
    // Ancho de la columna de importes = el número más largo (mín. 7 = "100.000").
    var amtW = amounts.reduce(function (m, n) { return Math.max(m, miles(n).length); }, 7);
    amtW = Math.min(amtW, Math.floor(W / 2));
    var nameW = W - amtW - 1;

    items.forEach(function (it, i) {
      var qty = Number(it.quantity) || 1;
      var name = qty + 'x ' + S(it.item_name || it.name || '');
      var ls = wrap(name, nameW);
      push(two(ls[0], miles(amounts[i]), W));
      for (var j = 1; j < ls.length; j++) push('   ' + ls[j]);
      // Precio unitario cuando hay más de uno (opt-in): el comensal controla la cuenta.
      if (c.fields.unitPrice && qty > 1) push('   ' + miles(Math.round(amounts[i] / qty)) + ' c/u');
      // Extras / variantes: ya vienen sumados en total_price, se listan sin precio.
      var ex = it.order_item_extras || it.extras || [];
      (Array.isArray(ex) ? ex : []).forEach(function (x) {
        var n = S(x.extra_name || x.name || x);
        if (n) wrap('+ ' + n, nameW).forEach(function (l, k) { push('   ' + (k ? '  ' : '') + l); });
      });
      if (it.observations) wrap('* ' + S(it.observations), nameW).forEach(function (l, k) { push('   ' + (k ? '  ' : '') + l); });
    });
    if (items.length) rule();

    // ── totales ──
    var fee = Number(data.deliveryFee) || 0;
    if (fee > 0) {
      push(two('Subtotal', miles((Number(data.total) || 0) - fee), W));
      push(two('Delivery', miles(fee), W));
    }
    push(two('TOTAL', money(data.total, cur), W), 'b');

    // ── gift card (mig 197) ──
    // El saldo restante va impreso porque es lo único que el comensal se lleva:
    // si no, tiene que volver a preguntar en el mostrador cuánto le queda.
    var gc = data.giftCard;
    if (gc && Number(gc.applied) > 0) {
      rule();
      push(two('Gift card ' + sane(gc.code), '-' + money(gc.applied, cur), W));
      if (Number(gc.balance) > 0) left('Saldo restante: ' + money(gc.balance, cur));
      var resto = (Number(data.total) || 0) - Number(gc.applied);
      if (resto > 0) push(two('A pagar', money(resto, cur), W), 'b');
    }

    // ── pago ──
    var pay0 = out.length;
    if (c.fields.paymentMethod && data.metodo) { rule('='); left('Método: ' + (METODOS[data.metodo] || data.metodo)); }
    if (c.fields.change && Number(data.cambio) > 0) {
      if (out.length === pay0) rule('=');
      push(two('Vuelto', money(data.cambio, cur), W), 'b');
    }

    // ── pie ──
    // El "¡Gracias por su visita!" es para el cliente. En la copia interna sólo
    // gastaría papel y la haría más parecida al original.
    var footer = INT ? '' : String(c.footer || '').trim();
    if (footer) { rule(); block(footer); }

    // Avance final: sin esto el corte manual se come el pie del ticket.
    for (var f = 0; f < c.feedLines; f++) push('');

    return out;
  }

  /* ── COMANDA: el papel que va a la cocina ──────────────────────────
     NO lleva precios ni totales, y no es una decisión estética: una comanda
     con importes se termina entregando como si fuera la cuenta, y encima
     obliga al cocinero a saltear números para encontrar el plato.
     Lo que la cocina necesita, en este orden: a dónde va, qué se cocina y qué
     tiene de especial. Todo lo demás es ruido que gasta papel.
     Las líneas grandes se envuelven al ancho que les corresponde (W / escala):
     con el ancho normal, un nombre largo en 'lg' se sale del rollo. */
  function buildComandaLines(data, c) {
    var W = c.charsPerLine;
    var A = c.asciiOnly;
    var k = c.comanda || {};
    var out = [];
    var S = function (x) { return sane(x, A); };
    var push = function (s, kk) { out.push({ s: s, k: kk || '' }); };
    var rule = function (ch) { push(rep(ch || '-', W)); };
    var wLG = Math.floor(W / SCALE.lg);
    var wMD = Math.floor(W / SCALE.md);
    var block = function (txt, kk, w) {
      w = w || W;
      wrap(S(txt), w).forEach(function (l) { push(center(l, w), kk); });
    };
    var left = function (txt) { wrap(S(txt), W).forEach(function (l) { push(l); }); };

    rule('=');
    // "REIMPRESIÓN" bien visible: sin esa marca, una comanda repetida se cocina
    // de nuevo y salen dos platos que nadie pidió.
    block(data.reprint ? 'COMANDA · REIMPRESIÓN' : 'COMANDA', 'md', wMD);
    rule('=');

    // El destino va primero y en grande: es el dato con el que se levanta el
    // plato, y el que evita que termine en la mesa equivocada.
    var dest = data.tableLabel || data.destino || '';
    if (dest) block(dest, 'lg', wLG);
    if (data.orderNumber != null) block('Pedido #' + data.orderNumber, 'md', wMD);
    rule();

    var meta0 = out.length;
    if (k.showTime !== false) left('Hora: ' + dateStr(data));
    if (k.showWaiter !== false && data.waiter) left('Pidió: ' + data.waiter);
    if (k.showCustomer && data.customerName) left('Cliente: ' + data.customerName);
    if (out.length > meta0) rule();

    var items = (data.items || []).filter(Boolean);
    items.forEach(function (it, i) {
      if (i) rule();   // raya entre platos: dos pegados se leen como uno solo
      var qty = Number(it.quantity) || 1;
      var nm = S(it.item_name || it.name || '');
      if (k.upperItems !== false) nm = nm.toUpperCase();
      wrap(qty + 'x ' + nm, wLG).forEach(function (l, j) { push(j ? '  ' + l : l, 'lg'); });
      var ex = it.order_item_extras || it.extras || [];
      (Array.isArray(ex) ? ex : []).forEach(function (x) {
        var n = S(x.extra_name || x.name || x);
        if (n) wrap('+ ' + n, wMD - 2).forEach(function (l, j) { push('  ' + (j ? '  ' : '') + l, 'md'); });
      });
      // La observación es el motivo por el que la comanda existe en papel:
      // "sin cebolla" mal leído es un plato devuelto.
      if (it.observations) {
        wrap('** ' + S(it.observations), wMD - 2).forEach(function (l, j) { push('  ' + (j ? '   ' : '') + l, 'md'); });
      }
    });
    if (items.length) {
      rule('=');
      var totQ = items.reduce(function (s, it) { return s + (Number(it.quantity) || 1); }, 0);
      left('Total: ' + items.length + ' línea' + (items.length !== 1 ? 's' : '')
           + ' / ' + totQ + ' ítem' + (totQ !== 1 ? 's' : ''));
    }

    if (data.orderNote) { rule(); left('NOTA: ' + data.orderNote); }
    var note = String(k.note || '').trim();
    if (note) { rule(); block(note); }

    for (var f = 0; f < c.feedLines; f++) push('');
    return out;
  }

  // Ticket en texto plano (debug / futuro agente ESC/POS).
  function buildText(data, config) {
    return buildLines(data || {}, mergeConfig(config)).map(function (l) { return l.s; }).join('\n');
  }

  // Geometría del ticket: tamaño de fuente, líneas y alto de página en mm.
  // La usan buildHTML (para el @page) y measure() (para mostrarle al local
  // cuánto papel gasta cada configuración).
  function _metrics(data, c) {
    var b = c.business || {};
    var w = c.paperWidth;
    var padMM = (w >= 80 ? 3 : 2);
    var padTB = 2;                       // padding vertical del body, en mm

    // Tamaño de fuente derivado de la grilla: charsPerLine caracteres tienen
    // que entrar EXACTO en el ancho imprimible. Si no, el navegador parte
    // líneas donde no corresponde y la columna de importes se descuadra.
    var fs = ((w - 2 * padMM) * MM) / c.charsPerLine / MONO_RATIO;
    fs = Math.min(24, Math.max(7, Math.round(fs * 10) / 10));

    var lines = buildLines(data, c);
    // La comanda no lleva logo: es papel interno y las térmicas rinden mal las
    // imágenes — gastaría 22mm de rollo por pedido para nada.
    var logoOn = !!(c.showLogo && b.logoUrl && data.kind !== 'comanda');

    // ── ALTO EXACTO DE LA PÁGINA ──────────────────────────────────
    // `@page{size:80mm auto}` NO es CSS válido: la gramática de `size` es
    // <length>{1,2} | auto | <page-size>, y `auto` no se combina con una
    // medida. Chrome descartaba la declaración entera y caía al tamaño de
    // papel del diálogo (A4 por defecto) → el ticket se partía en páginas
    // y entre ticket y ticket salían ~20cm de papel en blanco. Reportado
    // por Nativa Gastronomía: "se corta y no muestra el todo, tengo que
    // poner en otro tamaño de hoja".
    // Como el layout es una grilla propia, el alto se calcula exacto: cada
    // línea mide line-height × font-size (el line-height sin unidad hereda
    // como número, así que las líneas grandes escalan con su em).
    var hPx = 0;
    lines.forEach(function (l) { hPx += LINE_H * fs * (SCALE[l.k] || 1); });
    if (logoOn) hPx += (LOGO_MAX_MM + 2) * MM;
    var hMM = Math.ceil(hPx / MM) + 2 * padTB + 3;   // +3mm de holgura: sobrar papel es gratis, faltar corta el ticket
    hMM = Math.max(30, Math.min(3000, hMM));

    return { fs: fs, lines: lines, logoOn: logoOn, padMM: padMM, padTB: padTB, widthMM: w, heightMM: hMM };
  }

  // Medidas del ticket sin construir el HTML (panel de impresora en admin).
  function measure(data, config) {
    var m = _metrics(data || {}, mergeConfig(config));
    return { widthMM: m.widthMM, heightMM: m.heightMM, lines: m.lines.length, fontPx: m.fs };
  }

  // Devuelve un documento HTML completo (markup + <style>). SIN auto-print.
  function buildHTML(data, config) {
    data = data || {};
    var c = mergeConfig(config);
    var b = c.business || {};
    var m = _metrics(data, c);
    var w = m.widthMM, fs = m.fs, lines = m.lines, padMM = m.padMM, padTB = m.padTB, hMM = m.heightMM;

    var body = lines.map(function (l) {
      return '<div class="l' + (l.k ? ' ' + l.k : '') + '">' + (l.s ? esc(l.s) : '&#160;') + '</div>';
    }).join('');

    var logo = m.logoOn
      ? '<div class="lg-wrap"><img class="logo" src="' + esc(b.logoUrl) + '" alt=""/></div>' : '';

    return '<!DOCTYPE html><html><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>' + (data.kind === 'comanda' ? 'Comanda' : data.kind === 'interno' ? 'Copia interna' : 'Comprobante')
      +   (data.orderNumber != null ? ' #' + esc(data.orderNumber) : '') + '</title>'
      + '<style>'
      + '@page{size:' + w + 'mm ' + hMM + 'mm;margin:0}'            /* ← ambas medidas, si no la regla no vale */
      + '*{margin:0;padding:0;box-sizing:border-box}'
      /* Contraste térmico: TODO en negrita + sin anti-aliasing. El navegador
         rasteriza el texto (no es ESC/POS), así que cuanto más sólido el
         glifo, más negro sale. */
      + 'html,body{width:' + w + 'mm;background:#fff;color:#000}'
      + 'body{font-family:Consolas,\'Courier New\',Courier,monospace;font-weight:700;'
      +   'font-size:' + fs + 'px;line-height:' + LINE_H + ';padding:' + padTB + 'mm ' + padMM + 'mm;'
      +   '-webkit-font-smoothing:none;text-rendering:geometricPrecision;'
      +   '-webkit-print-color-adjust:exact;print-color-adjust:exact}'
      /* white-space:pre → los espacios de relleno SON el layout. Sin esto el
         navegador los colapsa y se pierde el centrado y la columna de precios. */
      /* +2px de holgura: sin eso una línea de exactamente charsPerLine
         caracteres puede desbordar por redondeo sub-pixel. */
      + '.g{width:calc(' + c.charsPerLine + 'ch + 2px);max-width:100%;margin:0 auto}'
      + '.l{white-space:pre}'
      + '.b{font-weight:900}'
      + '.md{font-size:' + SCALE.md + 'em;font-weight:900}'
      + '.lg{font-size:' + SCALE.lg + 'em;font-weight:900;letter-spacing:.02em}'
      + '.lg-wrap{text-align:center;margin-bottom:2mm}'
      + 'img.logo{max-width:36mm;max-height:' + LOGO_MAX_MM + 'mm;object-fit:contain;display:inline-block;filter:grayscale(1) contrast(1.6)}'
      + '</style></head><body><div class="g">'
      + logo + body
      + '</div></body></html>';
  }

  // Imprime el comprobante SIN abrir ventana emergente: usa un <iframe>
  // oculto en la misma página (menos fricción, sin bloqueo de popups, sin
  // ventana que parpadea). El diálogo del navegador igual aparece salvo que
  // Chrome corra con --kiosk-printing (ver nota en el panel Impresora).
  // Devuelve true salvo que ni siquiera se pueda crear el iframe.
  function _printViaIframe(html, onDone) {
    if (!document || !document.body) return false;
    var iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(iframe);
    var cleaned = false;
    function cleanup() {
      if (cleaned) return; cleaned = true;
      setTimeout(function () { try { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); } catch (e) {} }, 500);
      // Encadena el documento siguiente. El guard `cleaned` garantiza que corre
      // una sola vez, venga de onafterprint, del catch o del backstop.
      if (onDone) { try { onDone(); } catch (e) {} }
    }
    var win = iframe.contentWindow;
    var idoc = win.document;
    idoc.open(); idoc.write(html); idoc.close();
    function fire() {
      try { win.focus(); win.onafterprint = cleanup; win.print(); }
      catch (e) { cleanup(); }
    }
    if (idoc.readyState === 'complete') setTimeout(fire, 60);
    else iframe.onload = function () { setTimeout(fire, 60); };
    setTimeout(cleanup, 60000); // backstop por si afterprint no dispara
    return true;
  }

  // Fallback (entornos raros sin document.body): ventana emergente clásica.
  function _printViaPopup(html) {
    var printScript = '<scr' + 'ipt>window.onload=function(){window.focus();window.print();};'
      + 'window.onafterprint=function(){setTimeout(function(){window.close();},300);}<\/scr' + 'ipt>';
    var doc = html.indexOf('</body>') >= 0 ? html.replace('</body>', printScript + '</body>') : html + printScript;
    var w = window.open('', '_blank', 'width=360,height=720,menubar=no,toolbar=no,scrollbars=yes');
    if (!w) {
      try { if (window.toast) window.toast('Permití ventanas emergentes para imprimir', false); else alert('Permití ventanas emergentes para imprimir.'); } catch (e) {}
      return false;
    }
    w.document.open(); w.document.write(doc); w.document.close();
    return true;
  }

  // Único punto que imprime. buildHTML NO imprime (es seguro para la preview).
  function print(data, config) {
    var html = buildHTML(data, config);
    try { if (_printViaIframe(html)) return true; } catch (e) {}
    return _printViaPopup(html);
  }

  /* Varios documentos en UNA operación. Van EN SECUENCIA, esperando el
     afterprint de cada uno: tres iframes a la vez abren tres diálogos
     superpuestos y el cajero termina cancelando el que no era. */
  function printMany(docs, config) {
    var list = (docs || []).filter(Boolean);
    if (!list.length) return false;
    var i = 0;
    function next() {
      if (i >= list.length) return;
      var html = buildHTML(list[i++], config);
      var ok = false;
      try { ok = _printViaIframe(html, next); } catch (e) { ok = false; }
      // Sin iframe queda la ventana emergente, que no encadena: se abren todas
      // juntas. Es el camino raro (entorno sin document.body), no el normal.
      if (!ok) { _printViaPopup(html); next(); }
    }
    next();
    return true;
  }

  /* Los papeles de UNA venta, según lo que esté marcado.
     El orden no es casual: primero la comanda (la cocina tiene que arrancar
     ya), después el del cliente (que está esperando en el mostrador) y al
     final la copia interna, que no la espera nadie. */
  function printSet(data, config, which) {
    var c = mergeConfig(config);
    var w = which || c.prints;
    var docs = [];
    if (w.comanda) {
      var n = clamp((c.comanda && c.comanda.copies) || 1, 1, 3);
      for (var i = 0; i < n; i++) docs.push(Object.assign({}, data, { kind: 'comanda' }));
    }
    if (w.cliente) docs.push(Object.assign({}, data, { kind: 'cliente' }));
    if (w.interno)  docs.push(Object.assign({}, data, { kind: 'interno' }));
    if (!docs.length) return false;   // nada marcado: no es un error, es una elección
    return printMany(docs, config);
  }

  window.MythosReceipt = {
    defaultConfig: defaultConfig,
    sampleData: sampleData,
    mergeConfig: mergeConfig,
    buildLines: buildLines,
    buildText: buildText,
    measure: measure,
    buildHTML: buildHTML,
    print: print,
    printMany: printMany,
    printSet: printSet
  };
})();
