/* ════════════════════════════════════════════════════════════
   mythos-receipt.js — Renderer de comprobantes 80mm (compartido)
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

   FIX CLAVE (por qué antes imprimía mal en térmica):
     @page { size: <ancho>mm auto; margin: 0 }
     Sin esto el navegador asume hoja A4 y la impresora 80mm alimenta papel
     en blanco / recorta. Con esto, la página es una tira del ancho del rollo.
   ════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── helpers autocontenidos (no dependen de ningún panel) ──────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(n) { return '₲ ' + (Number(n) || 0).toLocaleString('es-PY'); }

  var METODOS = {
    efectivo: 'Efectivo', tarjeta_credito: 'Tarjeta Crédito', tarjeta_debito: 'Tarjeta Débito',
    qr: 'QR / Transferencia', mixto: 'Mixto'
  };

  // ── Config por defecto: sin config guardada, imprime un ticket
  //    completo y bien dimensionado en 80mm (todos los campos ON). ──
  var defaultConfig = {
    paperWidth: 80,            // 58 | 80 (mm)
    charsPerLine: 32,          // informativo / futuro wrap
    showLogo: false,           // off por defecto (drivers térmicos rinden mal las imágenes)
    fields: {
      orderNumber: true, customerName: true, table: true, cashier: true,
      dateTime: true, paymentMethod: true, change: true, ruc: true
    },
    header: {
      showName: true, showAddress: true, showPhone: true,
      showInstagram: true, showFacebook: false, showRuc: true
    },
    footer: '¡Gracias por su visita!',
    legalNote: 'COMPROBANTE DE CONSUMO\nNo válido como factura legal',
    social: { facebook: '' }
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
      { item_name: 'Lomito completo', quantity: 2, unit_price: 35000 },
      { item_name: 'Coca-Cola 500ml', quantity: 2, unit_price: 8000 },
      { item_name: 'Papas fritas', quantity: 1, unit_price: 18000 }
    ],
    total: 104000,
    metodo: 'efectivo',
    cambio: 16000,
    isOffline: false
  };

  function mergeConfig(config) {
    config = config || {};
    var pw = (config.paperWidth === 58 ? 58 : 80);
    return {
      paperWidth: pw,
      charsPerLine: config.charsPerLine || (pw === 58 ? 24 : 32),
      showLogo: !!config.showLogo,
      fields: Object.assign({}, defaultConfig.fields, config.fields || {}),
      header: Object.assign({}, defaultConfig.header, config.header || {}),
      footer: (config.footer != null ? config.footer : defaultConfig.footer),
      legalNote: (config.legalNote != null ? config.legalNote : defaultConfig.legalNote),
      social: Object.assign({}, defaultConfig.social, config.social || {}),
      business: config.business || {}
    };
  }

  function dateStr(data) {
    if (data.dateTime) return data.dateTime;
    var d = data.createdAt ? new Date(data.createdAt) : new Date();
    return d.toLocaleString('es-PY', { dateStyle: 'short', timeStyle: 'short' });
  }

  // Devuelve un documento HTML completo (markup + <style>). SIN auto-print.
  function buildHTML(data, config) {
    data = data || {};
    var c = mergeConfig(config);
    var b = c.business || {};
    var w = c.paperWidth;

    // ── encabezado del negocio ──
    var head = [];
    if (c.showLogo && b.logoUrl) head.push('<div class="c"><img class="logo" src="' + esc(b.logoUrl) + '" alt=""/></div>');
    if (c.header.showName && b.name) head.push('<div class="c big">' + esc(b.name) + '</div>');
    if (c.header.showRuc && (b.ruc || b.legalName)) {
      head.push('<div class="c sm">' + esc(b.legalName || b.name || '') + (b.ruc ? ' — RUC ' + esc(b.ruc) : '') + '</div>');
    }
    if (c.header.showAddress && b.address) head.push('<div class="c sm">' + esc(b.address) + '</div>');
    if (c.header.showPhone && b.phone) head.push('<div class="c sm">Tel: ' + esc(b.phone) + '</div>');
    if (c.header.showInstagram && b.instagram) head.push('<div class="c sm">IG: ' + esc(b.instagram) + '</div>');
    var fb = (c.social && c.social.facebook) || b.facebook;
    if (c.header.showFacebook && fb) head.push('<div class="c sm">FB: ' + esc(fb) + '</div>');

    // ── nota legal / tipo de comprobante ──
    var legal = (c.legalNote || '').split('\n').map(function (l, i) {
      return '<div class="c ' + (i === 0 ? 'b' : 'sm') + '">' + esc(l) + '</div>';
    }).join('');

    // ── meta (pedido / fecha / mesa / cliente / cajero) ──
    var meta = [];
    if (c.fields.orderNumber && data.orderNumber != null) {
      meta.push('<div class="c b big2">Pedido #' + esc(data.orderNumber) + (data.isOffline ? ' <span class="sm">(LOCAL)</span>' : '') + '</div>');
    }
    var info = [];
    if (c.fields.dateTime) info.push('Fecha: ' + esc(dateStr(data)));
    if (c.fields.table && data.tableLabel) info.push(esc(data.tableLabel));
    if (c.fields.customerName) info.push('Cliente: ' + esc(data.customerName || 'Anónimo'));
    if (c.fields.ruc && data.customerRuc) info.push('RUC Cliente: ' + esc(data.customerRuc));
    if (c.fields.cashier && data.cashier) info.push('Cajero: ' + esc(data.cashier));
    var infoHtml = info.map(function (l) { return '<div class="c sm">' + l + '</div>'; }).join('');

    // ── ítems ──
    var rows = (data.items || []).map(function (it) {
      var precio = (it.unit_price || it.price_guarani || 0);
      var qty = it.quantity || 1;
      return '<tr><td>' + qty + '× ' + esc(it.item_name || it.name || '') + '</td>'
           + '<td class="r">' + fmt(precio * qty) + '</td></tr>';
    }).join('');

    // ── pie de pago ──
    var pay = [];
    if (c.fields.paymentMethod && data.metodo) pay.push('<div>Método: ' + esc(METODOS[data.metodo] || data.metodo) + '</div>');
    if (c.fields.change && Number(data.cambio) > 0) pay.push('<div class="vuelto">Vuelto: ' + fmt(data.cambio) + '</div>');

    var footer = (c.footer || '').trim();

    return '<!DOCTYPE html><html><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>Comprobante' + (data.orderNumber != null ? ' #' + esc(data.orderNumber) : '') + '</title>'
      + '<style>'
      + '@page{size:' + w + 'mm auto;margin:0}'                     /* ← FIX CLAVE térmica */
      + '*{margin:0;padding:0;box-sizing:border-box}'
      + 'html,body{width:' + w + 'mm;background:#fff;color:#000}'
      + 'body{font-family:\'Courier New\',Courier,monospace;font-size:12px;line-height:1.32;padding:2mm 3mm}'
      + '.c{text-align:center}.b{font-weight:bold}.r{text-align:right;white-space:nowrap}'
      + '.big{font-size:15px;font-weight:bold}.big2{font-size:13px}.sm{font-size:10px}'
      + 'img.logo{max-width:40mm;max-height:24mm;object-fit:contain;margin:0 auto 3px;display:block;filter:grayscale(1) contrast(1.1)}'
      + 'hr{border:none;border-top:1px dashed #000;margin:5px 0}'
      + 'table{width:100%;border-collapse:collapse}td{padding:1px 0;vertical-align:top}'
      + '.tot td{font-weight:bold;font-size:14px;border-top:1px solid #000;padding-top:3px}'
      + '.vuelto{font-size:13px;font-weight:bold;margin-top:2px}'
      + '</style></head><body>'
      + head.join('')
      + (head.length ? '<hr>' : '')
      + legal
      + '<hr>'
      + meta.join('') + infoHtml
      + '<hr>'
      + '<table>' + rows + '<tr class="tot"><td>TOTAL</td><td class="r">' + fmt(data.total) + '</td></tr></table>'
      + (pay.length ? '<hr>' + pay.join('') : '')
      + (footer ? '<hr><div class="c sm" style="margin-top:3px">' + esc(footer) + '</div>' : '')
      + '</body></html>';
  }

  // Abre una ventana, escribe el comprobante e inyecta el auto-print.
  // Es el ÚNICO punto que imprime. Devuelve false si el popup fue bloqueado.
  function print(data, config) {
    var html = buildHTML(data, config);
    var printScript = '<scr' + 'ipt>window.onload=function(){window.focus();window.print();};'
      + 'window.onafterprint=function(){setTimeout(function(){window.close();},300);}<\/scr' + 'ipt>';
    var doc = html.indexOf('</body>') >= 0
      ? html.replace('</body>', printScript + '</body>')
      : html + printScript;
    var w = window.open('', '_blank', 'width=360,height=720,menubar=no,toolbar=no,scrollbars=yes');
    if (!w) {
      try { if (window.toast) window.toast('Permití ventanas emergentes para imprimir', false); else alert('Permití ventanas emergentes para imprimir.'); } catch (e) {}
      return false;
    }
    w.document.open();
    w.document.write(doc);
    w.document.close();
    return true;
  }

  window.MythosReceipt = {
    defaultConfig: defaultConfig,
    sampleData: sampleData,
    mergeConfig: mergeConfig,
    buildHTML: buildHTML,
    print: print
  };
})();
