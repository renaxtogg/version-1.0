// ════════════════════════════════════════════════════════════════════
// Armado del JSON de un Documento Electrónico (DE) — SIFEN/FacturaSend.
// ────────────────────────────────────────────────────────────────────
// Funciones PURAS (sin IO, sin secretos): mapean una orden de Mythos al objeto
// `data` que espera la API REST de FacturaSend para una FACTURA (tipoDocumento=1).
// El emisor (RUC, timbrado, establecimiento) ya vive en la config de la cuenta
// FacturaSend + en fiscal_config (mig 137); acá sólo va lo variable del documento.
//
// Reglas verificadas (doc FacturaSend / facturacionelectronicapy-xmlgen):
//   • Guaraní (PYG) SIN decimales → montos enteros.
//   • precioUnitario = precio CON IVA incluido (FacturaSend desglosa el impuesto).
//   • unidadMedida 77 = UNIDAD. ivaTipo 1=gravado / 3=exento. iva 10|5|0.
//     ivaProporcion 100=gravado total, 0=exento.
//   • order_items.total_price YA incluye extras y cantidad (ver src/index/main.jsx:
//     total = (item.price + Σextras) * qty) → precioUnitario = total_price/quantity.
//   • condicion.tipo 1=contado; la suma de entregas debe igualar el total.
//   • cliente consumidor final: contribuyente=false, tipoOperacion=2,
//     documentoTipo=5 ("Innominado"), documentoNumero="0".
//   • fecha: hora LOCAL del emisor (America/Asunción, UTC-3 fijo) en ISO sin zona,
//     nunca futura (para tipoEmision=1).
// ════════════════════════════════════════════════════════════════════

const UNIDAD_MEDIDA = 77;   // UNI
const IVA_DEFAULT   = 10;   // gastronomía PY: 10% incluido (no hay dato por ítem en la DB)
const ASUNCION_UTC_OFFSET_H = -3;  // Paraguay quitó el horario de verano (UTC-3 fijo)

function pad(n, len) { return String(n).padStart(len, '0'); }

// Número de comprobante a 7 dígitos ("0000001").
export function formatNumero(n) { return pad(Number(n), 7); }

// Código de establecimiento / punto a 3 dígitos ("001").
export function formatCodigo3(v) { return pad(String(v == null ? '1' : v).replace(/\D/g, '') || '1', 3); }

// Fecha de emisión SIFEN: hora local de Asunción, ISO "YYYY-MM-DDTHH:MM:SS", con
// un colchón de 60s hacia atrás para nunca quedar en el futuro por skew de reloj.
export function fechaEmisionSIFEN(now = new Date()) {
  const shifted = new Date(now.getTime() + ASUNCION_UTC_OFFSET_H * 3600 * 1000 - 60 * 1000);
  const p = (x) => pad(x, 2);
  return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}` +
         `T${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}`;
}

// Forma de pago (condicion.entregas[].tipo) desde orders.payment_method.
function tipoEntrega(paymentMethod) {
  switch ((paymentMethod || '').toLowerCase()) {
    case 'efectivo': return 1;   // Efectivo
    case 'tarjeta':
    case 'pos':      return 3;   // Tarjeta de crédito
    case 'qr':       return 5;   // Transferencia
    default:         return 1;   // por defecto, efectivo
  }
}

// cliente: consumidor final innominado, o con cédula, o contribuyente con RUC.
export function buildCliente(order) {
  const doc = order && order.customer_ruc ? String(order.customer_ruc).trim() : '';
  const name = order && order.customer_name ? String(order.customer_name).trim() : '';
  const email = order && order.customer_email ? String(order.customer_email).trim() : '';
  const base = { pais: 'PRY', paisDescripcion: 'Paraguay', codigo: '00001' };
  if (email) base.email = email;

  if (doc && doc.includes('-')) {
    // RUC con dígito verificador → contribuyente.
    return { ...base, contribuyente: true, ruc: doc,
      razonSocial: name || 'SIN NOMBRE', tipoOperacion: 1, tipoContribuyente: 1 };
  }
  if (doc) {
    // Documento sin guión → cédula: consumidor final identificado.
    return { ...base, contribuyente: false, razonSocial: name || 'CONSUMIDOR FINAL',
      tipoOperacion: 2, documentoTipo: 1, documentoNumero: doc };
  }
  // Consumidor final anónimo (innominado).
  return { ...base, contribuyente: false, razonSocial: name || 'CONSUMIDOR FINAL',
    tipoOperacion: 2, documentoTipo: 5, documentoNumero: '0' };
}

// order_items → items[] del DE. precioUnitario incluye extras (total_price/quantity).
function buildItems(items) {
  return (items || []).map((it, idx) => {
    const qty = Number(it.quantity) || 1;
    const lineTotal = Number(it.total_price) || 0;
    const precioUnitario = qty > 0 ? Math.round(lineTotal / qty) : lineTotal;
    const extras = (it.order_item_extras || [])
      .map((e) => e && e.extra_name).filter(Boolean).join(', ');
    const desc = (it.item_name || 'Item') + (extras ? ` (${extras})` : '');
    return {
      codigo: it.item_id != null ? String(it.item_id) : `ITEM-${idx + 1}`,
      descripcion: desc.slice(0, 120),
      unidadMedida: UNIDAD_MEDIDA,
      cantidad: qty,
      precioUnitario,
      ivaTipo: 1,
      ivaProporcion: 100,
      iva: IVA_DEFAULT,
    };
  });
}

// FACTURA (tipoDocumento=1) desde una orden real de Mythos.
// cfg: fila fiscal_config (establecimiento, punto_expedicion). numero: entero reservado.
export function buildFacturaDEFromOrder({ order, items, cfg, numero, fecha }) {
  const establecimiento = formatCodigo3(cfg && cfg.establecimiento);
  const punto = formatCodigo3(cfg && cfg.punto_expedicion);
  const lineItems = buildItems(items);
  if (lineItems.length === 0) throw new Error('la orden no tiene items para facturar');

  const itemsSum = lineItems.reduce((s, li) => s + li.precioUnitario * li.cantidad, 0);
  const total = Number(order && order.total) > 0 ? Number(order.total) : itemsSum;

  const de = {
    tipoDocumento: 1,
    establecimiento,
    punto,
    numero: formatNumero(numero),
    fecha,
    tipoEmision: 1,
    tipoTransaccion: 1,
    tipoImpuesto: 1,
    moneda: 'PYG',
    cliente: buildCliente(order),
    factura: { presencia: (order && order.order_type === 'delivery') ? 4 : 1 },
    condicion: {
      tipo: 1,
      entregas: [{ tipo: tipoEntrega(order && order.payment_method), monto: String(total), moneda: 'PYG', cambio: 0 }],
    },
    items: lineItems,
  };

  // Reconciliar el total de líneas con el total realmente cobrado (descuentos/cupón/envío).
  const diff = itemsSum - total;
  if (diff > 0) {
    de.descuentoGlobal = diff;                 // descuento/cupón a nivel documento
  } else if (diff < 0) {
    de.items.push({                            // cargo extra (envío u otros) para cuadrar
      codigo: 'OTROS', descripcion: 'Otros conceptos', unidadMedida: UNIDAD_MEDIDA,
      cantidad: 1, precioUnitario: -diff, ivaTipo: 1, ivaProporcion: 100, iva: IVA_DEFAULT,
    });
  }
  return de;
}

// DE de EJEMPLO (consumidor final, contado, PYG) para validar el pipeline
// lote/create → APROBADO → CDC sin depender del mapeo desde una orden.
export function buildEjemploDE({ numero, establecimiento = '001', punto = '001', fecha }) {
  const items = [
    { codigo: 'DEMO-001', descripcion: 'Pizza Napolitana', unidadMedida: UNIDAD_MEDIDA, cantidad: 1, precioUnitario: 88000, ivaTipo: 1, ivaProporcion: 100, iva: 10 },
    { codigo: 'DEMO-002', descripcion: 'Gaseosa 500ml',    unidadMedida: UNIDAD_MEDIDA, cantidad: 2, precioUnitario: 8500,  ivaTipo: 1, ivaProporcion: 100, iva: 10 },
  ];
  const total = items.reduce((s, i) => s + i.precioUnitario * i.cantidad, 0);
  return {
    tipoDocumento: 1,
    establecimiento: formatCodigo3(establecimiento),
    punto: formatCodigo3(punto),
    numero: formatNumero(numero),
    fecha,
    tipoEmision: 1,
    tipoTransaccion: 1,
    tipoImpuesto: 1,
    moneda: 'PYG',
    cliente: { contribuyente: false, razonSocial: 'CONSUMIDOR FINAL', tipoOperacion: 2,
      documentoTipo: 5, documentoNumero: '0', pais: 'PRY', paisDescripcion: 'Paraguay', codigo: '00001' },
    factura: { presencia: 1 },
    condicion: { tipo: 1, entregas: [{ tipo: 1, monto: String(total), moneda: 'PYG', cambio: 0 }] },
    items,
  };
}

// situacion numérica (o estado texto) de FacturaSend → estado de documentos_electronicos.
//
// hasCdc: si el DE ya tiene CDC (XML generado). En modo DESCONECTADO de SIFEN el
// estado terminal es GENERADO (XML+CDC+KuDE existen) — APROBADO sólo llega
// conectado (cert F1 + timbrado). Por eso "generado/enviado en lote" CON CDC se
// mapea a GENERADO (éxito terminal), y SIN CDC a ENVIADO (transitorio, aún sin
// documento). Un /estado posterior conectado a SIFEN puede subir GENERADO→APROBADO.
export function mapSituacionToEstado(situacion, estadoText, hasCdc = false) {
  const generadoOEnviado = hasCdc ? 'GENERADO' : 'ENVIADO';
  // Sólo usar la rama numérica si situacion es un número real (no null/''/undefined).
  const s = (situacion == null || situacion === '') ? NaN : Number(situacion);
  if (Number.isFinite(s)) {
    if (s === 2 || s === 3) return 'APROBADO';   // Aprobado / Aprobado con observación
    if (s === 4) return 'RECHAZADO';
    if (s === 99) return 'CANCELADO';
    if (s === 0 || s === 1) return generadoOEnviado;  // Generado / Enviado en lote
  }
  const t = (estadoText || '').toLowerCase();
  if (t.startsWith('aprob')) return 'APROBADO';
  if (t.startsWith('rechaz')) return 'RECHAZADO';
  if (t.startsWith('cancel')) return 'CANCELADO';
  if (t.startsWith('inutil')) return 'INUTILIZADO';
  if (t.startsWith('gener'))  return hasCdc ? 'GENERADO' : 'ENVIADO';
  return generadoOEnviado;
}
