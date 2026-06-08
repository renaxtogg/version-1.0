// ──────────────────────────────────────────────────────────────────────────────
// Mythos — Auditoría completa del sistema
// Genera analisis_mythos_v1.pdf con el estado integral del producto
// ──────────────────────────────────────────────────────────────────────────────
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'analisis_mythos_v1.pdf');
const doc = new PDFDocument({
  size: 'A4',
  margins: { top: 56, bottom: 56, left: 56, right: 56 },
  bufferPages: true,
  info: {
    Title: 'Mythos · Auditoría integral del sistema',
    Author: 'Mythos',
    Subject: 'Análisis técnico completo y roadmap a producción',
    Keywords: 'Mythos, SaaS gastronómico, Supabase',
  },
});
doc.pipe(fs.createWriteStream(OUT));

// ── PALETA ────────────────────────────────────────────────────────────────────
const C = {
  ink:    '#0E0E10',
  body:   '#1D1D1F',
  mid:    '#6E6E73',
  dim:    '#86868B',
  line:   '#D2D2D7',
  bgSoft: '#F5F5F7',
  accent: '#0A84FF',
  ok:     '#16A34A',
  warn:   '#F59E0B',
  bad:    '#DC2626',
  crit:   '#7F1D1D',
  brand:  '#000000',
  gold:   '#B45309',
  purple: '#7C3AED',
};

// ── HELPERS DE LAYOUT ─────────────────────────────────────────────────────────
const A4 = { w: 595.28, h: 841.89 };
const M = { l: 56, r: 56, t: 56, b: 56 };
const innerW = A4.w - M.l - M.r;

function ensureSpace(h) {
  if (doc.y + h > A4.h - M.b - 24) doc.addPage();
}

function h1(text, opts = {}) {
  ensureSpace(50);
  doc.moveDown(0.6);
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(22).text(text, { align: opts.align || 'left' });
  doc.moveTo(M.l, doc.y + 4).lineTo(M.l + 64, doc.y + 4).strokeColor(C.brand).lineWidth(2.4).stroke();
  doc.moveDown(0.9);
}

function h2(text) {
  ensureSpace(38);
  doc.moveDown(0.5);
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(15).text(text);
  doc.moveDown(0.4);
}

function h3(text) {
  ensureSpace(24);
  doc.moveDown(0.3);
  doc.fillColor(C.body).font('Helvetica-Bold').fontSize(11.5).text(text);
  doc.moveDown(0.2);
}

function p(text, opts = {}) {
  ensureSpace(14);
  doc.fillColor(opts.color || C.body).font('Helvetica').fontSize(opts.size || 10.2)
    .text(text, { align: opts.align || 'justify', lineGap: 1.2 });
  doc.moveDown(0.35);
}

function pBold(text) {
  ensureSpace(14);
  doc.fillColor(C.body).font('Helvetica-Bold').fontSize(10.2).text(text, { align: 'justify', lineGap: 1.2 });
  doc.moveDown(0.2);
}

function bullet(text, opts = {}) {
  ensureSpace(14);
  const bx = M.l + 4;
  const tx = M.l + 16;
  const startY = doc.y;
  doc.circle(bx + 2, startY + 5, 1.6).fill(opts.color || C.brand);
  doc.fillColor(opts.color || C.body).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10.2)
    .text(text, tx, startY, { width: innerW - 16, lineGap: 1.2, align: 'left' });
  doc.moveDown(0.15);
}

function pillRow(items) {
  ensureSpace(28);
  let x = M.l;
  const y = doc.y;
  const padX = 8, padY = 4;
  items.forEach(([label, color]) => {
    doc.font('Helvetica-Bold').fontSize(8.5);
    const w = doc.widthOfString(label) + padX * 2;
    if (x + w > M.l + innerW) { x = M.l; doc.moveDown(1.4); }
    doc.roundedRect(x, doc.y, w, 14, 4).fill(color);
    doc.fillColor('#fff').text(label, x + padX, doc.y + 3, { width: w - padX * 2, align: 'center' });
    x += w + 6;
    doc.y -= 14 + padY; // mantener línea
    doc.y += 0;
  });
  doc.moveDown(1.4);
}

function kvRow(rows, opts = {}) {
  ensureSpace(rows.length * 16 + 6);
  const colK = opts.colK || 170;
  rows.forEach(([k, v]) => {
    ensureSpace(16);
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9.8).fillColor(C.mid).text(k, M.l, y, { width: colK });
    doc.font('Helvetica').fontSize(9.8).fillColor(C.body).text(v, M.l + colK, y, { width: innerW - colK });
    doc.moveDown(0.2);
  });
  doc.moveDown(0.4);
}

function table(headers, rows, widths) {
  const total = widths.reduce((s, w) => s + w, 0);
  const scale = innerW / total;
  const cols = widths.map(w => Math.floor(w * scale));

  function drawRow(values, isHead = false, zebra = false) {
    const rowH = Math.max(...values.map((v, i) => {
      doc.font(isHead ? 'Helvetica-Bold' : 'Helvetica').fontSize(isHead ? 9 : 9);
      return doc.heightOfString(String(v ?? ''), { width: cols[i] - 10 });
    })) + 8;

    ensureSpace(rowH + 4);

    let x = M.l;
    const y = doc.y;
    if (isHead) {
      doc.rect(M.l, y, innerW, rowH).fill(C.ink);
    } else if (zebra) {
      doc.rect(M.l, y, innerW, rowH).fill(C.bgSoft);
    }
    values.forEach((v, i) => {
      doc.fillColor(isHead ? '#fff' : C.body)
        .font(isHead ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(isHead ? 9 : 9)
        .text(String(v ?? ''), x + 6, y + 4, { width: cols[i] - 10, lineGap: 1 });
      x += cols[i];
    });
    doc.y = y + rowH;
  }

  drawRow(headers, true);
  rows.forEach((r, idx) => drawRow(r, false, idx % 2 === 1));
  doc.moveDown(0.6);
}

function box(title, body, color) {
  ensureSpace(60);
  const y0 = doc.y;
  const padX = 12, padY = 10;
  const boxW = innerW;

  doc.font('Helvetica-Bold').fontSize(10.5);
  const titleH = doc.heightOfString(title, { width: boxW - padX * 2 });
  doc.font('Helvetica').fontSize(9.8);
  const bodyH = doc.heightOfString(body, { width: boxW - padX * 2, lineGap: 1.2 });
  const totalH = titleH + bodyH + padY * 2 + 4;

  ensureSpace(totalH + 6);
  const yStart = doc.y;
  doc.save();
  doc.roundedRect(M.l, yStart, boxW, totalH, 6).fill(color.bg);
  doc.rect(M.l, yStart, 4, totalH).fill(color.bar);
  doc.restore();

  doc.fillColor(color.bar).font('Helvetica-Bold').fontSize(10.5)
    .text(title, M.l + padX, yStart + padY, { width: boxW - padX * 2 });
  doc.fillColor(C.body).font('Helvetica').fontSize(9.8)
    .text(body, M.l + padX, yStart + padY + titleH + 4, { width: boxW - padX * 2, lineGap: 1.2, align: 'justify' });

  doc.y = yStart + totalH + 8;
}

function severity(label) {
  const m = {
    critico:  { bg: '#FEE2E2', bar: C.crit, txt: 'CRÍTICO' },
    alto:     { bg: '#FEF3C7', bar: C.bad,  txt: 'ALTO' },
    medio:    { bg: '#FEF9C3', bar: C.warn, txt: 'MEDIO' },
    bajo:     { bg: '#DCFCE7', bar: C.ok,   txt: 'BAJO' },
    info:     { bg: '#DBEAFE', bar: C.accent, txt: 'INFO' },
  };
  return m[label] || m.info;
}

function bugCard({ id, titulo, sev, archivo, descripcion, impacto, fix }) {
  const s = severity(sev);
  ensureSpace(90);
  const yStart = doc.y;
  const padX = 12, padY = 10;
  const boxW = innerW;

  doc.font('Helvetica-Bold').fontSize(10.8);
  const titleH = doc.heightOfString(`${id} · ${titulo}`, { width: boxW - padX * 2 - 80 });
  doc.font('Helvetica').fontSize(9.4);
  const lines = [
    ['Archivo', archivo],
    ['Descripción', descripcion],
    ['Impacto', impacto],
    ['Solución sugerida', fix],
  ];
  let bodyH = 0;
  lines.forEach(([k, v]) => {
    bodyH += doc.heightOfString(`${k}: ${v}`, { width: boxW - padX * 2, lineGap: 1 }) + 2;
  });
  const totalH = titleH + bodyH + padY * 2 + 10;
  ensureSpace(totalH + 8);

  doc.save();
  doc.roundedRect(M.l, doc.y, boxW, totalH, 6).fill('#FFFFFF');
  doc.roundedRect(M.l, doc.y, boxW, totalH, 6).lineWidth(0.6).strokeColor(C.line).stroke();
  doc.rect(M.l, doc.y, 4, totalH).fill(s.bar);
  doc.restore();

  const ys = doc.y;
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(10.8)
    .text(`${id} · ${titulo}`, M.l + padX, ys + padY, { width: boxW - padX * 2 - 80 });

  // chip de severidad arriba a la derecha
  doc.save();
  const chipText = s.txt;
  doc.font('Helvetica-Bold').fontSize(8);
  const chipW = doc.widthOfString(chipText) + 14;
  doc.roundedRect(M.l + boxW - padX - chipW, ys + padY, chipW, 14, 4).fill(s.bar);
  doc.fillColor('#fff').text(chipText, M.l + boxW - padX - chipW, ys + padY + 3, { width: chipW, align: 'center' });
  doc.restore();

  let yc = ys + padY + titleH + 8;
  lines.forEach(([k, v]) => {
    doc.fillColor(C.mid).font('Helvetica-Bold').fontSize(8.6).text(k.toUpperCase(), M.l + padX, yc, { width: boxW - padX * 2 });
    yc = doc.y;
    doc.fillColor(C.body).font('Helvetica').fontSize(9.4).text(v, M.l + padX, yc, { width: boxW - padX * 2, lineGap: 1 });
    yc = doc.y + 2;
  });

  doc.y = ys + totalH + 8;
}

function progressBar(label, pct, color = C.accent) {
  ensureSpace(28);
  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(9.6).fillColor(C.body).text(label, M.l, y, { width: innerW - 60 });
  doc.font('Helvetica-Bold').fontSize(9.6).fillColor(color).text(`${pct}%`, M.l, y, { width: innerW, align: 'right' });
  const y2 = doc.y + 2;
  doc.roundedRect(M.l, y2, innerW, 8, 4).fill(C.bgSoft);
  doc.roundedRect(M.l, y2, Math.max(4, innerW * pct / 100), 8, 4).fill(color);
  doc.y = y2 + 14;
}

function quote(text) {
  ensureSpace(40);
  const yStart = doc.y;
  doc.font('Helvetica-Oblique').fontSize(10).fillColor(C.mid);
  const h = doc.heightOfString(text, { width: innerW - 18, lineGap: 1.2 });
  doc.rect(M.l, yStart, 3, h + 8).fill(C.brand);
  doc.fillColor(C.body).font('Helvetica-Oblique').fontSize(10)
    .text(text, M.l + 14, yStart + 2, { width: innerW - 18, lineGap: 1.2 });
  doc.moveDown(0.8);
}

// ─────────────────────────────────────────────────────────────────────────────
// PÁGINA 1 — PORTADA
// ─────────────────────────────────────────────────────────────────────────────
function cover() {
  // Fondo negro de cabecera
  doc.rect(0, 0, A4.w, 280).fill(C.brand);
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(48).text('Mythos', M.l, 110);
  doc.font('Helvetica').fontSize(12).fillColor('#D2D2D7')
    .text('Sistema gastronómico multi-restaurante  ·  Auditoría integral v1.0', M.l, 168);

  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(18).text('Análisis completo del sistema', M.l, 210);
  doc.font('Helvetica').fontSize(10).fillColor('#86868B')
    .text('Estado actual · módulos por panel · bugs detectados · roadmap a producción', M.l, 235);

  // Bloque inferior
  doc.fillColor(C.body).font('Helvetica-Bold').fontSize(11).text('Restaurante demo', M.l, 320);
  doc.font('Helvetica').fontSize(10).fillColor(C.mid).text('Tu Restaurante — Asunción, Paraguay', M.l, 338);

  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.body).text('Stack', M.l, 366);
  doc.font('Helvetica').fontSize(10).fillColor(C.mid)
    .text('React 18 (CDN) + Babel Standalone · Supabase (PostgreSQL + Auth + Realtime + Storage + RLS) · Vercel estático', M.l, 384, { width: innerW });

  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.body).text('Cobertura del análisis', M.l, 430);
  const cov = [
    '9 paneles HTML (~25.000 líneas)', '73 migraciones SQL',
    '~25 tablas Supabase', '1 Edge Function (gestión de usuarios)',
    'Flujos: cliente QR, delivery, mozo, cocina, caja, admin, gerente, superadmin',
  ];
  cov.forEach((c, i) => {
    doc.fillColor(C.brand).circle(M.l + 3, 450 + i * 18 + 5, 1.8).fill();
    doc.fillColor(C.body).font('Helvetica').fontSize(10).text(c, M.l + 14, 450 + i * 18);
  });

  // Caja resumen ejecutivo en footer
  const yBox = 590;
  doc.roundedRect(M.l, yBox, innerW, 180, 10).fill(C.bgSoft);
  doc.fillColor(C.body).font('Helvetica-Bold').fontSize(12).text('Veredicto rápido', M.l + 18, yBox + 16);
  doc.font('Helvetica').fontSize(10).fillColor(C.body)
    .text(
      'Mythos es un sistema sorprendentemente completo para una v1: cubre el ciclo completo cliente → cocina → mozo → ' +
      'caja con paneles adicionales para administración, supervisión, multi-restaurante y delivery. El producto está en ' +
      '~70 % de “listo para producción seria”. Los huecos que separan el demo de un SaaS estable son tres: (1) seguridad RLS multi-tenant, ' +
      '(2) pasarela de pagos real (Bancard), (3) automatizaciones de operación (impresión, WhatsApp, Google APIs).',
      M.l + 18, yBox + 38, { width: innerW - 36, lineGap: 1.3, align: 'justify' }
    );
  doc.font('Helvetica-Bold').fontSize(10).fillColor(C.brand)
    .text('Completitud estimada · 70 % (MVP avanzado, listo para piloto controlado, no para flota)', M.l + 18, yBox + 144, { width: innerW - 36 });

  doc.fillColor(C.dim).font('Helvetica').fontSize(8.5)
    .text('Generado automáticamente · revisión técnica completa', M.l, A4.h - M.b - 12);
  doc.fillColor(C.dim).text(new Date().toLocaleDateString('es-PY', { day: '2-digit', month: 'long', year: 'numeric' }), M.l, A4.h - M.b - 12, { width: innerW, align: 'right' });

  doc.addPage();
}

// ─────────────────────────────────────────────────────────────────────────────
// PÁGINA 2 — ÍNDICE
// ─────────────────────────────────────────────────────────────────────────────
function tableOfContents() {
  h1('Índice');

  const sec = [
    ['1.', 'Resumen ejecutivo y veredicto'],
    ['2.', 'Arquitectura y stack técnico'],
    ['3.', 'Componentes compartidos entre paneles'],
    ['4.', 'Panel Cliente QR  (index.html)'],
    ['5.', 'Panel Cliente Delivery  (delivery-cliente.html)'],
    ['6.', 'Panel Rider  (delivery-rider.html)'],
    ['7.', 'Panel Cocina · KDS  (cocina.html)'],
    ['8.', 'Panel Mozo  (mozo.html)'],
    ['9.', 'Panel Caja  (caja.html)'],
    ['10.', 'Panel Administrador del local  (admin.html) — 18 submódulos'],
    ['11.', 'Panel Gerente / Supervisor local  (gerente.html)'],
    ['12.', 'Panel Superadmin · plataforma SaaS  (superadmin.html)'],
    ['13.', 'Base de datos · esquema, RLS y migraciones'],
    ['14.', 'Bugs detectados · catálogo priorizado'],
    ['15.', 'Cómo descubrir más bugs · metodología'],
    ['16.', 'Seguridad · riesgos y plan de mitigación'],
    ['17.', 'Próximas integraciones (Bancard, APIs, Google, WhatsApp…)'],
    ['18.', 'Mejoras · cambios · obsoletos'],
    ['19.', 'Roadmap a producción real'],
    ['20.', 'Crítica final y % de completitud detallado'],
  ];
  sec.forEach(([n, t]) => {
    ensureSpace(18);
    const y = doc.y;
    doc.fillColor(C.mid).font('Helvetica-Bold').fontSize(10).text(n, M.l, y, { width: 30 });
    doc.fillColor(C.body).font('Helvetica').fontSize(10.4).text(t, M.l + 30, y, { width: innerW - 30 });
    doc.moveDown(0.25);
  });

  doc.addPage();
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. RESUMEN EJECUTIVO
// ─────────────────────────────────────────────────────────────────────────────
function resumenEjecutivo() {
  h1('1 · Resumen ejecutivo');

  p(
    'Mythos es un ecosistema SaaS gastronómico multi-restaurante construido sobre un patrón intencional de ' +
    '“React por CDN + Babel Standalone + Supabase”: cada panel es un archivo HTML autocontenido con su propio ' +
    'estado, sin bundler, lo que reduce fricción de despliegue y permite iterar muy rápido. El sistema está ' +
    'preparado para multi-tenant (columna restaurant_id por tabla, panel superadmin completo, soporte chat ' +
    'Admin/Gerente ↔ Superadmin), pero todavía no se comporta como multi-tenant porque la mayoría de políticas ' +
    'RLS usan USING(true), lo que en producción real expondría datos entre restaurantes.'
  );

  h2('Lo que sorprende positivamente');
  bullet('Cobertura de roles muy completa: cliente QR, cliente delivery, rider, mozo, cocina, caja, admin, gerente, superadmin.', { color: C.ok });
  bullet('Flujo de caja con turnos reales (apertura/cierre, fondo fijo configurable, retiro automático del excedente, cancelaciones, quejas, ingresos/egresos).', { color: C.ok });
  bullet('Sistema de cocina con estaciones de despacho independientes por categoría + zona, con token compartible por estación.', { color: C.ok });
  bullet('Reservas migradas de localStorage a la tabla reservations, con zona preferida.', { color: C.ok });
  bullet('Edge Function /api/create-user.js: el service_role ya salió del frontend (riesgo de seguridad crítico resuelto).', { color: C.ok });
  bullet('Tracking del cliente con Realtime + polling de respaldo cada 10s y reconexión en visibilitychange — robusto en iOS.', { color: C.ok });
  bullet('Soporte 1-a-1 Gerente/Admin ↔ Superadmin con metadata automática (canal, restaurante, autor).', { color: C.ok });
  bullet('Diseño visual consistente (Apple-like, tipografía system, sombras suaves) sin un design system pesado.', { color: C.ok });

  h2('Lo que falta para llamarlo “listo para flota”');
  bullet('RLS real multi-restaurante: hoy 112 políticas con USING(true) en 24 migraciones.', { color: C.bad });
  bullet('Pasarela de pagos local (Bancard / Tigo Money / Pago Móvil) — hoy el pago en el cliente es declarativo.', { color: C.bad });
  bullet('Login por PIN del rider sin rate limiting ni hash — riesgo de fuerza bruta.', { color: C.bad });
  bullet('Integración con impresoras térmicas y comandera física (ESC/POS).', { color: C.warn });
  bullet('Salidas a aplicaciones de delivery (PedidosYa, Bolt Food, Rappi) o al menos webhook genérico.', { color: C.warn });
  bullet('WhatsApp Business o Twilio para confirmar pedidos/reservas y enviar QR del ticket.', { color: C.warn });
  bullet('CRM/Customers — hoy los clientes no se persisten como entidad consultable; van como snapshot dentro de orders.', { color: C.warn });
  bullet('Pruebas automatizadas: el sistema no tiene tests; toda la validación es manual.', { color: C.warn });

  h2('Distribución de completitud por área');
  progressBar('Cliente QR — flujo de pedido en mesa',                    92, C.ok);
  progressBar('Cliente Delivery — UX y zonas',                            85, C.ok);
  progressBar('Rider — gestión de rutas',                                 78, C.ok);
  progressBar('Cocina · KDS — estaciones, urgencia, audio',               88, C.ok);
  progressBar('Mozo · salón, llamadas, asignar pedido',                    82, C.ok);
  progressBar('Caja · turnos, cobros, fondo fijo, cancelaciones',         84, C.ok);
  progressBar('Admin local · 18 submódulos',                              78, C.warn);
  progressBar('Gerente / Supervisor local',                               72, C.warn);
  progressBar('Superadmin · plataforma SaaS',                             65, C.warn);
  progressBar('Seguridad RLS multi-tenant',                               35, C.bad);
  progressBar('Pagos reales (gateway local)',                              0, C.bad);
  progressBar('Integraciones externas (Google/WhatsApp/POS/Apps delivery)', 5, C.bad);
  progressBar('CRM / Customers',                                          10, C.bad);
  progressBar('Testing automatizado',                                      0, C.bad);

  doc.moveDown(0.5);
  box('Lectura del estado general',
    'Mythos es claramente un MVP avanzado, no un sistema demo. Tiene volumen real de código, persistencia ' +
    'cuidada y flujo operativo completo. La distancia con un producto SaaS comercial es operativa (pagos, ' +
    'WhatsApp, impresión, multi-tenant seguro) y no de funcionalidad de fondo. En un piloto controlado en ' +
    'Tu Restaurante podría estar funcionando hoy con supervisión humana; para vender a otros restaurantes hacen ' +
    'falta las piezas críticas que faltan.',
    { bg: '#E0F2FE', bar: C.accent }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. ARQUITECTURA
// ─────────────────────────────────────────────────────────────────────────────
function arquitectura() {
  doc.addPage();
  h1('2 · Arquitectura y stack técnico');

  h2('Visión general');
  p(
    'No hay servidor propio: el frontend es estático en Vercel y todo el backend vive en Supabase. La única ' +
    'pieza serverless es una función Vercel (api/create-user.js) que actúa como puente cuando hace falta ' +
    'service_role (creación segura de usuarios). El cliente carga React desde CDN y compila JSX en el ' +
    'navegador con Babel Standalone — lo cual significa: cero build step, pero un costo de carga inicial ' +
    'que importa cuando el local tenga Wi-Fi inestable.'
  );

  h2('Pilares');
  kvRow([
    ['Frontend',         'React 18 UMD (CDN) + Babel Standalone, CSS-in-JS inline. Sin bundler. design-system.css para variables compartidas.'],
    ['Backend',          'Supabase: PostgreSQL + Auth + Realtime + Storage + Row Level Security.'],
    ['Auth',             'Login unificado en /login.html con username (no email). Función SECURITY DEFINER get_user_email convierte username → email interno @mythos.internal.'],
    ['Roles',            'superadmin · admin · supervisor_local (gerente) · cajero · mozo · cocina · rider.'],
    ['Realtime',         'Suscripciones por canal en orders, waiter_calls, delivery_orders, support_messages.'],
    ['Storage',          'menu-images (Storage bucket Supabase) para fotos de platos y portadas de restaurante.'],
    ['Deploy',           'Vercel estático con outputDirectory: public/. PR/preview por push.'],
    ['Configuración',    'config.js gitignored. window.SUPABASE_CONFIG con url, anonKey y restaurantId.'],
    ['Serverless',       '/api/create-user.js — gestión segura de usuarios (admin de auth.users + user_roles).'],
  ]);

  h2('Patrones intencionales que NO se deben tocar');
  bullet('No introducir Vite/Next/Webpack: rompe el patrón "edición en caliente" que es la ventaja del proyecto.');
  bullet('No usar import/export: todo el código vive en window.* o en scripts globales.');
  bullet('Comentarios /*EDITMODE-BEGIN*/ y /*EDITMODE-END*/ son delimitadores del panel de tweaks visual; no borrar.');
  bullet('RESTAURANT_ID fijo (00000000-0000-0000-0000-000000000001) durante el demo; en multi-tenant real vendrá del JWT/profile.');

  h2('Diagrama mental del flujo principal');
  p(
    '[cliente QR] → Supabase.insert(orders, order_items) → [tracking realtime] ↔ [cocina KDS] (avanza status) → ' +
    '[mozo] (entrega, marca delivered_to_table_at) → [caja] (cobra, registra movimiento, libera mesa).'
  );
  p(
    '[delivery-cliente] → orders (order_type=delivery) + delivery_orders (rider_status) → [admin Delivery] (asigna rider) → ' +
    '[delivery-rider] (recoge, on_way, delivered).'
  );
  p(
    '[admin] (ABM) ↔ Supabase.* · [gerente] supervisa, aprueba, registra incidencias · [superadmin] gestiona ' +
    'restaurantes, planes, suscripciones, pagos y soporte.'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. COMPONENTES COMPARTIDOS
// ─────────────────────────────────────────────────────────────────────────────
function compartidos() {
  doc.addPage();
  h1('3 · Componentes compartidos entre paneles');

  p(
    'Aunque cada panel es un HTML aislado, hay piezas que se repiten y deberían tratarse como contrato común. ' +
    'Documentarlas evita inconsistencias y facilita extraer un módulo común más adelante.'
  );

  h2('3.1 · Cliente Supabase (_initDB)');
  kvRow([
    ['Dónde vive',  'En cada panel HTML. Función _initDB() que lee window.SUPABASE_CONFIG.'],
    ['Limpia BOM',  'Hace .replace(/^﻿/, "").trim() porque el Dashboard Supabase a veces inyecta caracteres invisibles.'],
    ['Caída elegante', 'Si no hay config retorna null y los paneles entran a modo demo (con datos estáticos en index.html / cocina.html).'],
    ['Mejora sugerida', 'Extraer a /public/lib/db.js para evitar 9 copias divergentes del mismo bloque.'],
  ]);

  h2('3.2 · Login unificado  (/login.html)');
  kvRow([
    ['Auth',          'Supabase Auth con email/password, pero el usuario tipea un username.'],
    ['Conversión',    'RPC get_user_email(username) — SECURITY DEFINER, accesible sin auth — devuelve email interno.'],
    ['Redirect',      'redirectByRole(): superadmin → superadmin.html, admin → admin.html, supervisor_local → gerente.html, cajero → caja.html, mozo → mozo.html, rider → delivery-rider.html, cocina → cocina.html.'],
    ['Posible añadido','Recordar último usuario (localStorage), "olvidé mi contraseña" interno para el admin, 2FA opcional para superadmin.'],
  ]);

  h2('3.3 · Diseño visual común');
  kvRow([
    ['Paleta',  '#000 / #1D1D1F / #6E6E73 / #D2D2D7 / #F5F5F7. Acento #0A84FF. Estados: ok #16A34A, warn #F59E0B, danger #FF3B30/#DC2626.'],
    ['Tipografía', 'system-ui · SF Mono para números. Headings 800. Body 13–14.'],
    ['Toasts', 'Función toast(msg, ok) presente en admin, caja, mozo, gerente. Sin contrato unificado.'],
    ['Modal', 'Componente Modal({title, onClose, children, width}) replicado en cada panel.'],
    ['Mejora sugerida', 'Extraer Btn, Modal, Toast, Kpi, Badge, Inp, Sel a design-system.js (no romper el patrón CDN — basta un <script type="text/babel" src="lib/ui.jsx">).'],
  ]);

  h2('3.4 · Realtime y reconexión');
  p(
    'El patrón que mejor funciona — usado en index.html para tracking — es: suscripción a canal + polling de ' +
    'respaldo cada 10 s + reconexión en visibilitychange. Vale la pena estandarizarlo en todos los paneles que ' +
    'dependen de realtime (cocina, mozo, caja, rider). Hoy algunos solo se suscriben.'
  );

  h2('3.5 · Constantes que deberían estar en una sola tabla');
  bullet('RESTAURANT_ID hardcodeado en cada panel — deberá venir del JWT cuando arranque multi-tenant real.');
  bullet('TABLE_NUM por URL ?mesa=4. Pendiente: token único por mesa para QR real.');
  bullet('METODOS_PAGO: efectivo, tarjeta_credito, tarjeta_debito, qr, mixto — repetido en caja y admin.');
  bullet('SL / SC (status label/color de orders): repetido literal en gerente, mozo, caja, cocina.');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. CLIENTE QR
// ─────────────────────────────────────────────────────────────────────────────
function panelClienteQR() {
  doc.addPage();
  h1('4 · Panel Cliente QR  (public/index.html)');

  kvRow([
    ['Tamaño',    '1.724 líneas · React 18 + Babel.'],
    ['Rol',       'Cliente final escanea QR en mesa y pide sin necesidad de mozo.'],
    ['Persistencia', 'Inserta directamente en orders, order_items, order_item_extras, order_status_history. Coupon validado vía RPC. Reservation insertada en reservations.'],
    ['Modo demo', 'Sin config funciona con menú estático (MENU_STATIC) y cupón MESA10 falso.'],
  ]);

  h2('Pantallas');
  table(
    ['#', 'Pantalla', 'Función'],
    [
      ['1', 'QRScreen',          'Splash inicial, simula escaneo.'],
      ['2', 'ProfileScreen',     'Selector idioma, comer aquí / para llevar, botón "llamar mozo", reserva.'],
      ['3', 'MenuScreen',        'Categorías, ítems, badges de promo (pizza_corrida, tenedor_libre…).'],
      ['4', 'ProductModal',      'Detalle con extras y observaciones.'],
      ['5', 'CartScreen',        'Editar, eliminar, cupón, partir cuenta (SplitBillModal).'],
      ['6', 'PayScreen',         'Método de pago + datos de factura (RUC/CI/correo).'],
      ['7', 'TrackingScreen',    'Pasos en vivo (Realtime + polling fallback).'],
      ['8', 'RatingScreen',      'Estrellas + razones + comentario.'],
      ['9', 'ReservationScreen', 'Reserva con zona, ocasión, observaciones.'],
    ],
    [22, 110, 220]
  );

  h2('Qué se le puede agregar');
  bullet('Login social opcional para clientes recurrentes (auth.signInWithOAuth Google) → arranca el CRM real.');
  bullet('Historial del propio cliente (últimos pedidos en este restaurante / en todos los Mythos).');
  bullet('“Mi cuenta dentro de la mesa” (mesa compartida con varios celulares — items por persona dentro del mismo order_number).');
  bullet('Idioma real: hoy lang viaja en orders.language pero los textos están en español; añadir i18n por archivo JSON.');
  bullet('Modo offline-first: cachear menú con Service Worker (PWA) — clave en zonas con Wi-Fi débil.');
  bullet('Carrito persistente en localStorage si se cierra la pestaña.');
  bullet('Pagos reales con Bancard QR / Pago Móvil / Tigo Money (ver sección 17).');
  bullet('Botón “ya estoy aquí” cuando hay reserva → notifica al mozo automáticamente.');
  bullet('Mejoras de accesibilidad: aria-labels, contrastes en modo claro, fuente +1 para personas mayores.');
  bullet('Mostrar en tracking el nombre del mozo asignado y/o foto.');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. CLIENTE DELIVERY
// ─────────────────────────────────────────────────────────────────────────────
function panelClienteDelivery() {
  doc.addPage();
  h1('5 · Panel Cliente Delivery  (public/delivery-cliente.html)');

  kvRow([
    ['Tamaño',  '1.941 líneas.'],
    ['Rol',     'Cliente que pide a domicilio desde la web pública (no QR).'],
    ['Cálculo de zona', 'haversineKm() + calcDeliveryFee() con tabla delivery_zones (color, precio, distancia)'],
    ['Canal',   'Parametro ?canal=web (también podría ser whatsapp, ig, telefono — se guarda en orders.channel).'],
  ]);

  h2('Pantallas');
  bullet('WelcomeScreen — elige delivery o pickup o reserva.');
  bullet('CoverageScreen — ingresa dirección/ubicación, valida zona, muestra fee.');
  bullet('CustomerDataScreen — nombre, teléfono, observación.');
  bullet('MenuScreen / ProductModal / CartScreen — análogos al cliente QR pero con order_type=delivery.');
  bullet('Tracking simplificado (sin sub-pasos cocina pero con estado del rider).');

  h2('Mejoras sugeridas');
  bullet('Google Maps Places Autocomplete + selector visual sobre el mapa → precisión del domicilio.');
  bullet('Geocoding inverso: pegar coordenadas → dirección legible para el rider.');
  bullet('Estimar ETA basado en distancia + tráfico (Google Distance Matrix).');
  bullet('Login con número de teléfono + OTP (Supabase phone auth) — habilita historial de cliente.');
  bullet('Cupones de delivery (descuento de fee si es la primera compra, por zona, por horario).');
  bullet('Push notifications (PWA) cuando el pedido sale a la calle.');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. RIDER
// ─────────────────────────────────────────────────────────────────────────────
function panelRider() {
  doc.addPage();
  h1('6 · Panel Rider  (public/delivery-rider.html)');

  kvRow([
    ['Tamaño',     '749 líneas.'],
    ['Rol',        'Repartidor (interno o externo). Login por PIN numérico.'],
    ['Datos',      'Tabla delivery_riders (rider_pin, current_status: disponible/en_ruta/offline, vehicle, foto).'],
    ['Flujo',      'Login PIN → Home (pedidos asignados) → Iniciar ruta → cambiar rider_status pickup→on_way→delivered.'],
  ]);

  h2('Mejoras sugeridas');
  bullet('Hash del PIN (bcrypt) + rate limiting + bloqueo tras N intentos — hoy el PIN se compara en texto plano.');
  bullet('Geolocalización en vivo: al iniciar ruta, navigator.geolocation.watchPosition() → upsert en delivery_rider_positions cada N segundos para que admin/cliente vea ubicación.');
  bullet('Ruta optimizada multi-pedido (Google Directions API).');
  bullet('“Llamar cliente” con tel: + mostrar referencia del domicilio.');
  bullet('Foto del entregado (delivery_orders.proof_photo_url) — confirma entrega y zanja disputas.');
  bullet('Estadísticas históricas (km, ingresos, propinas) más completas que las actuales.');
  bullet('Modo bici/moto con velocímetro y registro de horas trabajadas (employee_shifts).');
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. COCINA
// ─────────────────────────────────────────────────────────────────────────────
function panelCocina() {
  doc.addPage();
  h1('7 · Panel Cocina · KDS  (public/cocina.html)');

  kvRow([
    ['Tamaño',     '1.789 líneas.'],
    ['Rol',        'Kitchen Display System. Vista kanban: nuevo / preparando / listo.'],
    ['Realtime',   'Subscripción a INSERT y UPDATE en orders.'],
    ['Estaciones', 'Filtra tickets por estación (kitchen_stations) — cada categoría puede estar asignada a una estación distinta. Link compartible por token.'],
  ]);

  h2('Submódulos detectados');
  bullet('TicketCard — temporizador, urgencia (verde/amarillo/rojo), badges (delivery, alergia, observación).');
  bullet('StationTabs — pestañas por estación, conteo de tickets pendientes por cada una.');
  bullet('OrderTypeFilterTabs — filtra todos / mesa / delivery / takeaway.');
  bullet('StatsPanel — promedio de tiempo, top items, total atendido hoy.');
  bullet('ConfigDrawer — sonido on/off, modo compacto, audio para alérgenos.');
  bullet('FelicitacionesPanel — mensajes motivacionales (gamificación liviana).');
  bullet('KitchenMessageBanner — banner editable desde admin para avisos al equipo.');

  h2('Qué se le puede agregar');
  bullet('Impresión automática del comanda al pasar a “preparando” (ESC/POS via QZ Tray o nube).');
  bullet('Métricas SLA por estación (% tickets servidos en <X minutos).');
  bullet('“Pausa de estación”: marcar 86 (sin stock) un plato y bloquearlo en el menú del cliente automáticamente — hoy 86 está parcialmente en gerente.html (item_86_list).');
  bullet('Voz / TTS para alergias (lectura en voz alta).');
  bullet('Vista de “línea” (mise en place) con conteo agregado de ingredientes por estación.');
  bullet('Métrica de carga (tickets/min) y alerta de saturación.');
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. MOZO
// ─────────────────────────────────────────────────────────────────────────────
function panelMozo() {
  doc.addPage();
  h1('8 · Panel Mozo  (public/mozo.html)');

  kvRow([
    ['Tamaño',  '3.139 líneas.'],
    ['Rol',     'Mozo del salón. Ve mesas, ocupación, llamadas, asigna pedidos, marca entrega.'],
    ['Salón visual', 'ZonaMozo dibuja el plano del local con zonas y mesas con coordenadas virtuales (vx/vy normalizados 0–100). Forma rectangular/redonda/cuadrada.'],
    ['Sonidos / vibración', 'initAudio(), playAlertSound(), vibrateDevice() para llamadas.'],
  ]);

  h2('Estados resueltos por mesa');
  p('getMesaStatus combina ordersMap, callsMap y reservationByTable para devolver: libre · ocupada · llamando · paid_pendiente · reservada (con ventana de alerta).');

  h2('Mejoras sugeridas');
  bullet('Dividir cuenta entre comensales (SplitBillModal del cliente, en mozo, persistido en DB).');
  bullet('Recordatorio automático si una mesa lleva X minutos sin actualización (probable abandonada).');
  bullet('Acción “transferir mesa” a otro mozo (turno cruzado).');
  bullet('Vista “mis mesas” vs “todas” (cuando hay varios mozos en piso).');
  bullet('Mini-chat con cocina (canal de waiter_calls extendido con type=chat).');
  bullet('Tablero de propinas (employee_shifts.propinas) y resumen al final del turno.');
  bullet('Login por PIN/QR del propio mozo (en lugar de username/password) para mayor velocidad.');
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. CAJA
// ─────────────────────────────────────────────────────────────────────────────
function panelCaja() {
  doc.addPage();
  h1('9 · Panel Caja  (public/caja.html)');

  kvRow([
    ['Tamaño',  '3.549 líneas.'],
    ['Rol',     'Cajero. Apertura/cierre de turno, cobros, cancelaciones, movimientos, quejas, retiros.'],
    ['Persistencia', 'turnos_caja, movimientos_caja, cancelaciones_caja, quejas_sugerencias.'],
    ['Fondo fijo', 'Configurable por restaurante (cash_mode_default, cash_fondo_fijo, cash_diff_umbral, cash_auto_retiro_excedente).'],
  ]);

  h2('Submódulos');
  bullet('AperturaTurnoScreen — abre turno con monto inicial (sugerido = fondo fijo si modo=fijo).');
  bullet('CobrosPanel — lista pedidos pendientes de cobro. CobroModal con métodos: efectivo, tarjeta_cred/déb, QR, mixto. Calcula cambio y muestra denominaciones.');
  bullet('CancelacionesPanel — registra anulaciones con motivo y aprobación.');
  bullet('IngresosEgresosPanel — caja chica manual.');
  bullet('QuejasPanel — registra queja/sugerencia que después aparece en Gerente.');
  bullet('RetiroPanel — sangrías parciales del cajón.');
  bullet('TomarPedidoPanel — caja también puede tomar pedido (modo mostrador / barra) con PagarAntesDeEnviarModal.');
  bullet('SalonPanel — plano completo del salón con totales por mesa.');
  bullet('CierreCajaPanel — arqueo final, calcula diferencia vs. esperado, exige justificación si excede cash_diff_umbral, genera retiro automático del excedente si está configurado.');
  bullet('CalculadoraFlotante — herramienta para conteo de denominaciones.');

  h2('Qué se le puede agregar');
  bullet('Impresión real del ticket fiscal (Bancard / SET integration).');
  bullet('Conciliación nocturna automática vs Bancard webhook.');
  bullet('Lectura de QR del cliente para identificar mesa al cobrar (acelera CobroModal).');
  bullet('Modo “mostrador” permanente con teclado numérico y atajos para barra.');
  bullet('Historial de turno con búsqueda por nº de pedido / cliente.');
  bullet('Bitácora visible: arqueo previo, observación del cajero entrante.');
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. ADMIN
// ─────────────────────────────────────────────────────────────────────────────
function panelAdmin() {
  doc.addPage();
  h1('10 · Panel Administrador del local  (admin.html) · 18 submódulos');

  p('El panel admin es el más grande del sistema (8.036 líneas). Concentra toda la administración del local. Lo desgloso por submódulo con su estado y mejoras propuestas.');

  table(
    ['Submódulo', 'Estado', 'Observaciones'],
    [
      ['Dashboard',     'OK',    'KPIs ventas, pedidos, ratings, tickets activos.'],
      ['Pedidos',       'OK',    'Listado, filtros, detalle.'],
      ['Menú',          'OK',    'Categorías, ítems, extras, ImageUploader.'],
      ['Mesas',         'OK',    'Plano editable, zonas, forma, vx/vy.'],
      ['Personal',      'OK',    'ABM users con Edge Function.'],
      ['Clientes',      'parc.', 'Lista derivada de orders (no hay tabla customers todavía).'],
      ['Caja',          'OK',    'Resumen de turnos cerrados, exportar.'],
      ['Finanzas',      'OK',    'Reportes de ingresos / costos, expenses.'],
      ['Marketing',     'OK',    'Cupones, métricas de uso.'],
      ['Ratings',       'OK',    'Estrellas, comentarios, moderación pendiente.'],
      ['Stock',         'OK',    'ingredients, recipes, movements, alertas.'],
      ['Reportes',      'OK',    'Filtros de fecha, agrupaciones, export.'],
      ['Estaciones',    'OK',    'Kitchen_stations, mapeo categoría↔estación, token compartible, audit.'],
      ['Config',        'OK',    'Datos del restaurante, horarios, portada, ubicación.'],
      ['Delivery',      'OK',    'Dashboard delivery, pedidos, riders, zones (MapEditor).'],
      ['Reservas',      'OK',    'CRUD reservations, ventana de alerta.'],
      ['Proveedores',   'NUEVO', 'Suppliers + contactos + compras (072).'],
      ['Soporte',       'NUEVO', 'Chat con superadmin (073).'],
    ],
    [120, 60, 360]
  );

  h2('Hallazgos finos por submódulo');
  bullet('Menú — falta versión “a granel” para activar/desactivar muchos ítems a la vez (86 list rápido). El ImageUploader podría comprimir en cliente antes de subir.');
  bullet('Mesas — el MapEditor podría exportar/importar plano (JSON) y permitir snap a grid.');
  bullet('Personal — no muestra historial de turnos por empleado fuera de employee_shifts; agregar “informe nómina”.');
  bullet('Clientes — empezar a poblar customers (id, phone, email, n_pedidos, ticket_promedio) con un upsert al cerrar cada orders. Crítico para retención.');
  bullet('Finanzas — separar “costo estimado por receta” real cuando recipes esté completo; hoy se acerca por margen plano.');
  bullet('Marketing — falta segmentación (por zona, por horario, por cliente top); cupones por código QR físico.');
  bullet('Ratings — moderación pendiente (la auditoria_contexto_ia.md lo marca explícito); aplicar visibilidad pública/privada.');
  bullet('Stock — los movimientos automáticos al cerrar pedido (descuento de receta) deberían validarse con un test masivo.');
  bullet('Delivery → MapEditor — ya soporta polígonos por color. Faltaría preview en cliente mostrando si su pin cae en zona antes de pedir dirección exacta.');
  bullet('Soporte — al cerrar ticket, mandar email/WhatsApp al admin con resumen.');
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. GERENTE
// ─────────────────────────────────────────────────────────────────────────────
function panelGerente() {
  doc.addPage();
  h1('11 · Panel Gerente · Supervisor local  (gerente.html)');

  kvRow([
    ['Tamaño',  '1.712 líneas.'],
    ['Rol',     'Supervisor del piso. Toma decisiones que afectan al turno sin tocar configuración del restaurante.'],
    ['Tablas que usa', 'shift_logs, manager_approvals, item_86_list, quejas_sugerencias, ratings, support_tickets, orders.'],
  ]);

  h2('Módulos detectados');
  bullet('Dashboard — KPIs del día, alertas, ticket promedio, productividad por mozo.');
  bullet('SupervisionTurno — vista del salón en vivo, asistencia, propinas, transferencias.');
  bullet('Aprobaciones — solicitudes de descuento, cortesía, anulación con motivos.');
  bullet('QuejasYRatings — vista de quejas y reseñas pendientes de revisión.');
  bullet('Stock86 — marcar/desmarcar “sin stock” un plato en caliente (ítem_86_list).');
  bullet('Bitácora — shift_logs (categorías: nota, incidencia, tarea, traspaso, cliente, personal, equipo, limpieza).');
  bullet('Soporte — abrir/responder tickets al superadmin (chat).');

  h2('Mejoras sugeridas');
  bullet('Aprobaciones con notificación push al admin cuando se rechaza/aprueba.');
  bullet('Reglas automáticas (ej. cortesía gratis si rating <2 con motivo “tiempo”).');
  bullet('Indicadores de cumplimiento (cuántas incidencias se resolvieron en N horas).');
  bullet('“Cierre de turno gerente”: snapshot legible de bitácora del día (PDF/Mail al admin).');
  bullet('Sincronía con Stock86 → cuando un ítem queda en 86, ocultarlo del cliente automáticamente.');
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. SUPERADMIN
// ─────────────────────────────────────────────────────────────────────────────
function panelSuperadmin() {
  doc.addPage();
  h1('12 · Panel Superadmin  (superadmin.html)');

  kvRow([
    ['Tamaño',  '2.372 líneas.'],
    ['Rol',     'Plataforma SaaS. Gestiona los restaurantes cliente, planes, suscripciones, pagos, eventos.'],
    ['Tablas',  'restaurants, subscription_plans, subscriptions, payments, platform_events, support_tickets.'],
  ]);

  h2('Páginas');
  table(
    ['Página', 'Función'],
    [
      ['Dashboard',       'KPIs globales: MRR, restaurantes activos, tickets atendidos, NPS agregado.'],
      ['Restaurantes',    'ABM restaurantes (alta, baja, cambio de plan, banner de mantenimiento).'],
      ['Facturación',     'Listado de subscriptions y payments. Estado: activa, en mora, cancelada.'],
      ['Usuarios',        'Listado de usuarios por restaurante y rol. Crea via Edge Function.'],
      ['Configuración',   'Configuración global de plataforma, planes, parámetros de demo.'],
      ['Reportes',        'Cohortes, churn, ARPU; gráfico MRRChart por mes.'],
      ['Actividad',       'platform_events — log inmutable del SaaS.'],
      ['Soporte',         'Inbox unificado de tickets (Gerente/Admin → Superadmin) con asignación.'],
    ],
    [110, 410]
  );

  h2('Mejoras sugeridas');
  bullet('Onboarding asistido: alta de nuevo restaurante con wizard (plantillas de menú, mesas, zonas).');
  bullet('Pagos automáticos de suscripción (Bancard recurrente / Stripe internacional).');
  bullet('Métricas de uso por restaurante (pedidos / día, % de paneles activos) para detectar early churn.');
  bullet('Hot-toggle de features por restaurante (delivery, estaciones, gerente, reservas).');
  bullet('Banner global y modo “mantenimiento” por restaurante (ya está parcialmente: 031 maintenance_banner).');
  bullet('Audit log de cambios sensibles (qué superadmin cambió qué plan a quién).');
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. DATABASE
// ─────────────────────────────────────────────────────────────────────────────
function database() {
  doc.addPage();
  h1('13 · Base de datos · esquema, RLS, migraciones');

  kvRow([
    ['Motor',  'PostgreSQL 15 (Supabase).'],
    ['Migraciones', '73 archivos numerados en /supabase/migrations/.'],
    ['Tablas centrales', '~25 (operativas, SaaS y soporte).'],
    ['Storage', 'menu-images.'],
  ]);

  h2('Tablas principales (por dominio)');
  table(
    ['Dominio', 'Tablas'],
    [
      ['Tenancy',        'restaurants, user_roles, subscription_plans, subscriptions, payments, platform_events'],
      ['Menú',           'menu_categories, menu_items, menu_item_extras, coupons, ingredients, recipes, stock_movements, stock_alerts'],
      ['Operación',      'tables, orders, order_items, order_item_extras, order_status_history, waiter_calls, ratings, reservations, expenses'],
      ['Caja',           'turnos_caja, movimientos_caja, cancelaciones_caja, quejas_sugerencias'],
      ['Empleados',      'employee_shifts'],
      ['Delivery',       'delivery_orders, delivery_zones, delivery_riders'],
      ['Cocina',         'kitchen_stations, kitchen_station_categories, kitchen_station_zonas, order_item_station_log'],
      ['Gerencia',       'shift_logs, manager_approvals, item_86_list'],
      ['Compras',        'suppliers, supplier_contacts, supplier_purchases'],
      ['Soporte',        'support_tickets, support_messages'],
    ],
    [110, 440]
  );

  h2('Migraciones por etapa');
  bullet('001–016: bootstrap, login interno, fix sequences, storage de imágenes.');
  bullet('017–021: stock, turnos de caja, session de mesa.');
  bullet('022–029: mejoras KDS, fixes admin, mozo v1, RLS recursion (29).');
  bullet('030–044: delivery tipologías, employee_shifts, riders, kitchen_station inicial, admin_v2, mozo v2, customer fields, reservations, menu promos, waiter paid fields.');
  bullet('045–055: dev_reset, delivery_zones color, restaurant lat/lng, tables_zona_shape, rider_pin_system, tables_pos_xy, payment_status, no_auto_release_mesa, order_items_delete_policy.');
  bullet('056–067: waiter debts & payroll, delivery_flow_v2, fix constraints, delivery_full_fix, delivery_cash_amount, tables_virtual_coords, orders_delivered_to_table.');
  bullet('068–073: superadmin_dev_tools, kitchen_stations definitivo, reservations zona + settings, caja fondo fijo, gerente_panel completo, support_chat.');

  h2('Calidad del esquema');
  bullet('Buen uso de FK con ON DELETE CASCADE / SET NULL.', { color: C.ok });
  bullet('Snapshots de texto en columnas como customer_name, supplier_name, restaurant_name (mitiga borrados duros).', { color: C.ok });
  bullet('Constraints CHECK en status, priority, category → previenen valores inválidos.', { color: C.ok });
  bullet('Faltan índices en algunas FK calientes (orders.table_id, order_items.order_id ya están, pero conviene auditar para delivery_orders y support_messages).', { color: C.warn });
  bullet('No hay particionado de orders, lo cual está OK ahora pero será necesario al pasar de ~1M filas.', { color: C.warn });
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. BUGS
// ─────────────────────────────────────────────────────────────────────────────
function bugs() {
  doc.addPage();
  h1('14 · Bugs y procesos erróneos detectados');

  p(
    'Catálogo priorizado con el resultado del análisis del código en este árbol (no es una corrida de QA en producción). ' +
    'Cada hallazgo incluye archivo, descripción técnica, impacto operativo y solución sugerida.'
  );

  bugCard({
    id: 'B-01',
    sev: 'critico',
    titulo: 'RLS abierta: 112 políticas con USING(true)',
    archivo: 'supabase/migrations/* (24 archivos)',
    descripcion: 'Casi todas las tablas tienen políticas con USING(true) y/o WITH CHECK (true), incluso después de la 029 que arregló la recursión. En consecuencia, cualquier cliente con el anon key (que está en el frontend) puede leer/escribir filas de otros restaurantes apenas conozca un restaurant_id.',
    impacto: 'Bloqueador para multi-tenant real: un restaurante podría leer pedidos de otro. También facilita scraping del menú de la competencia y manipulación de orders por terceros.',
    fix: 'Reescribir políticas: filtrar por (restaurant_id = (SELECT restaurant_id FROM user_roles WHERE user_id = auth.uid())). Crear vistas/RPC SECURITY DEFINER solo para endpoints públicos (menu, restaurants básicos). El anon key debe pasar a permisos muy limitados (RPCs públicas).',
  });

  bugCard({
    id: 'B-02',
    sev: 'critico',
    titulo: 'PIN del rider en texto plano + sin rate limiting',
    archivo: 'public/delivery-rider.html  ·  supabase/migrations/20260520_051_rider_pin_system.sql',
    descripcion: 'rider_pin se guarda como TEXT y se compara directo con eq("rider_pin", trimmed). Si alguien obtiene el anon key (está en el HTML), puede iterar PINs vía REST hasta encontrar un match.',
    impacto: 'Cualquiera con el link público podría loguearse como rider y aceptar/“entregar” pedidos ajenos.',
    fix: 'Sustituir por RPC SECURITY DEFINER rider_login(pin) que valide con pgcrypto.crypt + intentos fallidos por IP (tabla rider_login_attempts). Considerar PIN de 6 dígitos + bloqueo por 15 min tras 5 fallos.',
  });

  bugCard({
    id: 'B-03',
    sev: 'alto',
    titulo: 'Mesa ? / Mesa — en órdenes con table_id NULL',
    archivo: 'public/index.html  ·  public/mozo.html  ·  public/caja.html',
    descripcion: 'En dbSubmitOrder, si _initTableUUID() no resolvió aún, table_id se inserta como null. Después varios paneles muestran “Mesa ?” porque hacen orders.tables?.number y no hay relación.',
    impacto: 'Mozo/caja no saben a qué mesa pertenece el pedido. En takeaway y delivery es esperado, pero en consumo en sitio rompe la UX.',
    fix: 'Bloquear el botón “Confirmar pedido” hasta que _tableUUID esté resuelto, o leer la mesa por TABLE_NUM + restaurant_id sincrónicamente antes de insertar. Fallback: rellenar table_id en background si quedó null en una orden marcada dine_in.',
  });

  bugCard({
    id: 'B-04',
    sev: 'alto',
    titulo: 'Cobro puede salir ₲0 si order.total = 0',
    archivo: 'public/caja.html (CobroModal)',
    descripcion: 'Hoy ya hay un workaround (calcular totalReal desde items si order.total es 0). Pero el “bug raíz” es que en algunos flujos orders.total se guarda como 0 inicialmente (se actualiza recién al cobrar). Si los items aún no llegaron a CobroModal en el useEffect, totalReal puede caer a 0 si se confirma en menos de un tick.',
    impacto: 'Riesgo de cobrar 0 si el cajero hace clic muy rápido. Pérdida directa de ingresos.',
    fix: 'No abrir CobroModal hasta que los items estén cargados (botón Confirmar deshabilitado mientras items.length === 0 && order.total === 0). Servir totals como SUM(order_items) vía vista order_totals_v.',
  });

  bugCard({
    id: 'B-05',
    sev: 'alto',
    titulo: 'Anon key expuesto en HTML público',
    archivo: 'public/config.js  +  todos los paneles',
    descripcion: 'El anon key se entrega al navegador. Es legítimo, pero su poder depende 100% de las RLS — y como las RLS hoy son abiertas (B-01), el anon key efectivamente da acceso amplio.',
    impacto: 'Se vuelve crítico solo en conjunto con B-01. Aislado, no es problema.',
    fix: 'Una vez B-01 resuelto, este punto cae solo. Mientras tanto, rotar el anon key si se sospecha exposición.',
  });

  bugCard({
    id: 'B-06',
    sev: 'medio',
    titulo: 'tables.is_occupied desincronizado',
    archivo: 'public/mozo.html · public/caja.html · public/admin.html · trigger eliminado en 054',
    descripcion: 'En la migración 054 se eliminó el trigger que liberaba la mesa automáticamente al marcar delivered. Ahora la mesa solo se libera con clic explícito. Pero no hay tarea de fondo que sincronice si un cajero olvidó liberarla.',
    impacto: 'Mesas que aparecen ocupadas pero ya no tienen orden activa.',
    fix: 'Vista mv_tables_occupancy_v calculada (SELECT EXISTS … active orders) o un cron job nocturno que libere mesas sin orders activos. Botón “sincronizar mesas” en admin.',
  });

  bugCard({
    id: 'B-07',
    sev: 'medio',
    titulo: 'Race condition al insertar order_items en bucle',
    archivo: 'public/index.html dbSubmitOrder',
    descripcion: 'Los inserts de order_items se hacen en serie con await dentro de for. Si el cliente cierra la pestaña entre el insert del order y el de los items, queda un pedido “fantasma” sin ítems. No hay transacción.',
    impacto: 'Pedido aparece en cocina con ₲0 y sin contenido — el cajero/cocinero no sabe qué hacer.',
    fix: 'Mover dbSubmitOrder a un RPC create_order(p_order JSON, p_items JSON[]) SECURITY DEFINER dentro de una transacción Postgres. Beneficio extra: atómico y controlado.',
  });

  bugCard({
    id: 'B-08',
    sev: 'medio',
    titulo: 'Polling de respaldo sin backoff',
    archivo: 'public/index.html TrackingScreen · varios paneles',
    descripcion: 'fetchStatus se llama cada 10 s siempre, también cuando ya hay realtime activo. En 50 clientes simultáneos son 5 req/s solo de tracking.',
    impacto: 'Costo Supabase + saturación de PostgREST.',
    fix: 'Polling solo si subscribe entra a CHANNEL_ERROR/TIMED_OUT. Incremento exponencial 10s → 20s → 40s.',
  });

  bugCard({
    id: 'B-09',
    sev: 'medio',
    titulo: 'Bookings (reservations) sin solapamiento controlado',
    archivo: 'supabase/migrations/20260520_040_reservations_table.sql',
    descripcion: 'No hay constraint UNIQUE ni exclusión que impida reservar la misma mesa, mismo horario, dos veces. Tampoco un check de capacity (guests > capacity).',
    impacto: 'Dos reservas sobre la misma mesa al mismo horario; mozo se entera al llegar el cliente.',
    fix: 'EXCLUDE USING gist con tstzrange(reservation_date+time, +90min) por table_id. CHECK guests <= 12 (o capacity vía trigger).',
  });

  bugCard({
    id: 'B-10',
    sev: 'medio',
    titulo: 'Login redirige por rol al cargar pero NO valida vencimiento',
    archivo: 'public/login.html',
    descripcion: 'getSession().then redirige si hay sesión. No invalida si el rol cambió en el servidor (por ej. un usuario que ya fue dado de baja pero su token aún no expiró).',
    impacto: 'Empleado despedido puede entrar mientras dure el token.',
    fix: 'En la redirección, validar también que user_roles.is_active = true. Idealmente RPC get_my_profile devuelve is_active y se fuerza signOut() en caso de false.',
  });

  bugCard({
    id: 'B-11',
    sev: 'bajo',
    titulo: 'Toasts duplicados / paneles cierran modales con click fuera sin confirmar',
    archivo: 'admin.html · caja.html · superadmin.html',
    descripcion: 'En varios modals, el overlay no bloquea click-outside cuando hay datos sin guardar. El usuario pierde lo escrito.',
    impacto: 'Frustración del cajero/admin al cargar un proveedor largo.',
    fix: 'Hook useDirtyGuard() con confirm("Tenés cambios sin guardar…") antes de cerrar.',
  });

  bugCard({
    id: 'B-12',
    sev: 'bajo',
    titulo: 'Fórmulas inline en cobro de delivery',
    archivo: 'public/caja.html CobroModal',
    descripcion: 'cashChangeNum = cashAmountNum - (totalReal + deliveryFeeNum). Si delivery está pagado con tarjeta y el efectivo es solo de delivery, el cálculo se mezcla.',
    impacto: 'Cambio mal calculado en pagos mixtos delivery + efectivo.',
    fix: 'Modelar pagos como array (orders → order_payments) con monto, método, ref. Una fila por método.',
  });

  bugCard({
    id: 'B-13',
    sev: 'bajo',
    titulo: 'Comentarios obsoletos en docs/auditoria_contexto_ia.md',
    archivo: 'docs/auditoria_contexto_ia.md',
    descripcion: 'Lista 8 bugs críticos y 4 ya están parcial/totalmente resueltos (tracking realtime sí está; create-user ya es Edge Function; reservas migradas; logout caja con cierre).',
    impacto: 'Falsa percepción del estado.',
    fix: 'Reescribir el archivo (o usar este PDF como nueva línea base) y dejar solo los bugs vigentes.',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 15. CÓMO ENCONTRAR MÁS BUGS
// ─────────────────────────────────────────────────────────────────────────────
function comoEncontrarMas() {
  doc.addPage();
  h1('15 · Cómo descubrir más bugs · metodología');

  p('Una auditoría estática (como esta) cubre código y patrones. Para llegar al 95 % hay que combinarla con pruebas dinámicas y telemetría. Recomendación de ejecución, en orden:');

  h2('A · Pruebas manuales guiadas (1–2 días)');
  bullet('Script de QA por panel: 10 caminos felices + 10 caminos rotos por panel (ver Apéndice 19 / Roadmap).');
  bullet('Prueba “tres celulares + caja + cocina” simultánea — descubre la mayoría de bugs de realtime y mesa.');
  bullet('Test de carga manual: 50 pedidos en 15 minutos. Mide latencia y Supabase rate limit.');
  bullet('“Día completo de servicio en laboratorio”: abrir turno → vender 30 órdenes → cerrar turno → arqueo.');

  h2('B · Linting y análisis estático (1 día)');
  bullet('Pasar ESLint con un config básico (no-unused-vars, no-undef, react/no-array-index-key) — el código no tiene linting hoy.');
  bullet('Análisis SQL: ejecutar supabase db lint o pg_lint para detectar índices faltantes y políticas RLS abiertas.');
  bullet('Auditoría de dependencias CDN (versiones, integrity).');

  h2('C · Telemetría en producción (continuo)');
  bullet('Sentry (o LogRocket / Highlight) — captura runtime errors. Hoy todos los catch silencian con console.warn.');
  bullet('Supabase logs → tabla error_log con ON ERROR triggers en RPCs críticos.');
  bullet('Cron diario que compare orders.total vs SUM(order_items.total_price) — detecta B-04 antes de que cobren ₲0.');
  bullet('Dashboards de salud: % pedidos con table_id null, mesas marcadas ocupadas sin orden activa, ratings sin moderar.');

  h2('D · Pruebas automatizadas (medio plazo)');
  bullet('Playwright headless: 1 test por flujo crítico (qr → pedido → cocina → cobro). Corre en CI antes de cada deploy.');
  bullet('Snapshot tests para UI clave (cliente QR Tracking, cocina TicketCard).');
  bullet('pgTAP para RLS — verificar que un cliente con restaurant_id ≠ no ve filas ajenas.');

  h2('E · Auditoría de seguridad (antes de salir a producción)');
  bullet('Pentest dirigido a anon key + REST Supabase: intentar escalar privilegios.');
  bullet('Revisión de Edge Function: confirmar que el JWT viene firmado y no aceptar tokens locales.');
  bullet('Headers HTTP (CSP, X-Frame-Options, Permissions-Policy) — no hay vercel.json header config hoy.');
}

// ─────────────────────────────────────────────────────────────────────────────
// 16. SEGURIDAD
// ─────────────────────────────────────────────────────────────────────────────
function seguridad() {
  doc.addPage();
  h1('16 · Seguridad · riesgos y plan');

  h2('Top 3 riesgos hoy');
  box('R-1  RLS abierta (USING(true))',
    'Es el bloqueador #1 para vender a otros restaurantes. Hasta que se cierre, el modelo es “un solo restaurante a la vez”.',
    { bg: '#FEE2E2', bar: C.crit });

  box('R-2  PIN del rider en texto plano',
    'Permite que cualquier persona se haga pasar por un rider y manipule entregas.',
    { bg: '#FEF3C7', bar: C.bad });

  box('R-3  Sin políticas de headers HTTP',
    'vercel.json no fija CSP/X-Frame/HSTS. Susceptible a clickjacking y XSS si algún día se sube contenido de terceros.',
    { bg: '#FEF9C3', bar: C.warn });

  h2('Plan de mitigación');
  bullet('Sprint Seguridad #1 (1 semana): cerrar RLS por restaurante. Tests pgTAP por tabla. Migración 074 reemplaza políticas abiertas.');
  bullet('Sprint Seguridad #2 (3 días): rider_login RPC con hash + intentos por IP. Migración 075.');
  bullet('Endurecer Vercel: Content-Security-Policy: default-src \'self\'; img-src https: data:; script-src \'self\' cdn.jsdelivr.net unpkg.com; connect-src https://*.supabase.co.');
  bullet('Auditar create-user.js: rate limit por IP, validar que el JWT esté firmado contra el JWT secret real (hoy solo decodifica payload).');
  bullet('Rotación automática de service_role (en Vercel env) cada N días.');
  bullet('2FA opcional para superadmin (TOTP).');
  bullet('Backup automático Supabase + ejercicio de restore semestral.');
}

// ─────────────────────────────────────────────────────────────────────────────
// 17. INTEGRACIONES
// ─────────────────────────────────────────────────────────────────────────────
function integraciones() {
  doc.addPage();
  h1('17 · Próximas integraciones');

  p('Lista priorizada por impacto operativo, dificultad y dependencia con otras piezas.');

  h2('Pagos (Paraguay)');
  table(
    ['Integración', 'Uso', 'Dificultad'],
    [
      ['Bancard Marketplace / Vpos',  'Cobro con tarjeta en caja + delivery. Captura, anulación, conciliación.', 'Alta — KYC + entorno de pruebas + webhook.'],
      ['Bancard QR (Aqua)',           'QR dinámico en caja y cliente (pagás escaneando con app de banco).', 'Media.'],
      ['Tigo Money',                  'Billetera móvil más usada en PY. Cobro directo y delivery.', 'Media.'],
      ['Pago Móvil (BNF / Ueno) ',    'Alternativa para mercado popular.', 'Media.'],
      ['Stripe / Mercado Pago',       'Solo para suscripciones del SaaS (superadmin → cobro a restaurantes).', 'Baja — fácil pero requiere KYC SaaS.'],
    ],
    [160, 280, 100]
  );

  h2('Apps de delivery');
  bullet('PedidosYa / Bolt Food / Rappi — la integración formal exige certificación. Mientras tanto, webhook genérico (POST /api/intake-order) que cualquier marketplace pueda llamar para crear orden en Mythos. Esto desbloquea integradores como SocketFood o ChefDigital.');
  bullet('Menú maestro exportable a JSON estándar (Open Food Format) para subir a marketplaces.');

  h2('Google APIs');
  bullet('Maps Places Autocomplete  → exacto en delivery-cliente.');
  bullet('Geocoding / Reverse Geocoding → traducir lat/lng a direcciones legibles para el rider.');
  bullet('Distance Matrix → ETA realista con tráfico.');
  bullet('Directions → ruta multi-pedido para rider.');
  bullet('Sheets → exportar reportes financieros al Sheet del contador.');
  bullet('Google Reviews → traer ratings públicos al panel de marketing.');

  h2('Mensajería');
  bullet('Twilio WhatsApp Business API → confirmación de pedido, recordatorio de reserva, encuesta post-servicio.');
  bullet('Alternativa Paraguay: WhaTicket / Wapp / Z-API si Twilio no aprueba el número.');
  bullet('Emails transaccionales con Resend / Postmark → factura electrónica, reset de password.');
  bullet('SMS de respaldo (Twilio SMS o Infobip) cuando no hay WhatsApp.');

  h2('Hardware / POS');
  bullet('Impresión ESC/POS por LAN (Epson TM-m30, Bematech): puente Node local o QZ Tray. Sin esto, el flujo papel no funciona.');
  bullet('Cajón monedero (apertura por trigger del impresor).');
  bullet('Lector de QR físico para cobro Aqua (Bancard).');
  bullet('Balanza para items por peso (ej. tenedor libre).');

  h2('Facturación electrónica Paraguay');
  bullet('SIFEN (DNIT) — emisión de factura electrónica. Existen integradores como FactSet PY, Marangatu, Bilatu.');
  bullet('Reglas de timbrado, RUC, kude para factura.');
  bullet('Pendiente legal: validar fechas de obligatoriedad por categoría de contribuyente.');

  h2('Productividad');
  bullet('Slack / Discord webhook para notificar al equipo: nuevo rating <3, queja de cliente, mesa con espera >30 min.');
  bullet('Calendar (Google Calendar) → sincronizar reservas con el calendario del salón.');
  bullet('iCal feed por restaurante para que el dueño suscriba sus reservas.');
  bullet('Notion / Airtable export — reportes semanales auto-enviados.');

  h2('IA / Asistentes');
  bullet('Resumen diario por IA (Claude API) enviado al admin: 3 highlights, 3 alertas, top 3 platos.');
  bullet('Sugerencia de menú dinámico (qué promo levantar hoy según clima/dia).');
  bullet('Asistente de quejas: clasificar automáticamente (servicio, cocina, ambiente) y rutear al gerente.');
  bullet('Voz a texto para que el mozo dicte observaciones (Web Speech API + Whisper fallback).');
}

// ─────────────────────────────────────────────────────────────────────────────
// 18. MEJORAS / CAMBIOS / OBSOLETO
// ─────────────────────────────────────────────────────────────────────────────
function mejoras() {
  doc.addPage();
  h1('18 · Mejoras · cambios · obsoletos');

  h2('Para QUITAR (obsoleto / muerto)');
  bullet('Mesa_App.html en la raíz — versión vieja monolítica (110 KB), reemplazada por public/. Borrar tras backup.');
  bullet('design.gz / design_extracted/ — assets de diseño antiguos, no se referencian.');
  bullet('public/diag.html — herramienta de diagnóstico pequeña. Mover a /tools/ y proteger con login si va a quedar en producción.');
  bullet('Comentarios console.error sin manejo en 88 puntos: o reemplazar por Sentry, o limpiar.');
  bullet('Migraciones duplicadas con mismo número (036, 051, 069 tienen dos archivos) — renombrar para evitar confusión.');

  h2('Para REEMPLAZAR');
  bullet('Babel Standalone en producción → preprocesar con esbuild antes de subir a Vercel (compatible con el patrón CDN: solo cambia el script src).');
  bullet('Comentarios de tipos sueltos → migrar gradualmente a JSDoc con //@ts-check para detección temprana.');
  bullet('localStorage del tema → preference en user_profile (sync entre dispositivos).');
  bullet('SplitBillModal del cliente → mover al mozo / caja (es donde más se usa en la práctica).');

  h2('Para MEJORAR (sin reescribir)');
  bullet('Centralizar helpers fmt/fmtTime/SL/SC en /public/lib/format.js — hoy duplicados.');
  bullet('design-system.css ya existe pero está infrautilizado: empujar más estilos hacia ahí.');
  bullet('Loader / skeleton consistente en todos los paneles (hoy varía panel a panel).');
  bullet('Modo oscuro completo: muchos paneles ya tienen toggle pero algunos pantallazos quedan claros.');
  bullet('Onboarding del cliente nuevo: tooltip “bienvenido a Tu Restaurante”, animación de marca.');
  bullet('Compresión de imágenes con browser-image-compression antes de subir a Storage.');
  bullet('Caching de menu con stale-while-revalidate (1 carga, fondo refresh, fallback a localStorage).');
  bullet('Versión PWA (manifest.json + service worker) — al menos para el cliente QR.');

  h2('Para AÑADIR (oportunidades de producto)');
  bullet('Loyalty: puntos por pedido, niveles, recompensas. Tabla loyalty_accounts + loyalty_movements.');
  bullet('Encuesta NPS automática 24h post-visita por WhatsApp.');
  bullet('Reservas con depósito (señal) — bloquea no-shows.');
  bullet('Catering / eventos: tipo de orden “evento”, hoja de cálculo, anticipo.');
  bullet('Receta visual para el cocinero: foto del plato + pasos en la TicketCard al hacer “preparando”.');
  bullet('Modo Sala Privada: bloquear mesas para evento, marcar “grupo de N personas” → vista especial en mozo.');
}

// ─────────────────────────────────────────────────────────────────────────────
// 19. ROADMAP A PRODUCCIÓN
// ─────────────────────────────────────────────────────────────────────────────
function roadmap() {
  doc.addPage();
  h1('19 · Roadmap a producción real');

  h2('Sprint 1 (semana 1) · seguridad y datos');
  bullet('Cerrar RLS por restaurante (B-01) con tests pgTAP. Migración 074.');
  bullet('Rider login con hash + rate limit (B-02). Migración 075.');
  bullet('Headers HTTP en vercel.json (CSP, HSTS).');
  bullet('Rotar anon key y service_role; revisar SENSITIVE_DATA.md.');

  h2('Sprint 2 (semana 2) · estabilidad operativa');
  bullet('RPC create_order transaccional (resuelve B-04 y B-07).');
  bullet('Sincronización de tables.is_occupied (B-06) con vista calculada.');
  bullet('Cron diario de validaciones: orders huérfanos, totales 0, mesas inconsistentes.');
  bullet('Snapshot tests Playwright para 5 flujos (qr, delivery, cocina, mozo, caja).');

  h2('Sprint 3 (semana 3) · pagos');
  bullet('Integración Bancard Vpos (cobro tarjeta caja).');
  bullet('Integración Bancard QR (cliente).');
  bullet('Integración Tigo Money (opcional, prioridad media).');
  bullet('order_payments table + UI mixta correcta (resuelve B-12).');

  h2('Sprint 4 (semana 4) · operaciones físicas');
  bullet('Impresión ESC/POS: ticket cocina + ticket cliente.');
  bullet('SIFEN factura electrónica (al menos sandbox).');
  bullet('Apertura cajón monedero por trigger del impresor.');

  h2('Sprint 5 (semana 5) · CRM y comunicación');
  bullet('Tabla customers + upsert al cerrar pedido.');
  bullet('WhatsApp Business: confirmación de pedido + recordatorio de reserva.');
  bullet('Encuesta NPS 24 h después de la visita.');

  h2('Sprint 6 (semana 6) · multi-restaurante real');
  bullet('Onboarding wizard en superadmin: alta restaurante + plantillas.');
  bullet('Feature flags por restaurante (delivery on/off, gerente on/off, …).');
  bullet('Hot toggle de banner de mantenimiento por restaurante (ya está parcial — terminar).');
  bullet('Métricas de uso por restaurante para early churn detection.');

  h2('Sprint 7+ (opcional) · diferenciación');
  bullet('App rider nativa (Capacitor) + push notifications.');
  bullet('PWA cliente con offline catalog.');
  bullet('IA: resumen diario del dueño + asistente de queja.');
  bullet('Integración apps delivery (PedidosYa / Bolt / Rappi).');
}

// ─────────────────────────────────────────────────────────────────────────────
// 20. CRÍTICA FINAL
// ─────────────────────────────────────────────────────────────────────────────
function criticaFinal() {
  doc.addPage();
  h1('20 · Crítica final y % de completitud');

  h2('Crítica honesta (lo que diría un revisor externo)');
  quote(
    'Mythos demuestra ambición y oficio raros en una v1: cubre un dominio enorme con poco código de andamiaje, ' +
    'mantiene UX consistente entre nueve paneles y resuelve cuestiones difíciles como turnos de caja, kitchen ' +
    'stations y multi-tenant SaaS. Su mayor virtud — la simplicidad CDN + Supabase — es también su mayor ' +
    'limitación cuando empiezan los problemas de escala: sin RLS estricta, sin transacciones explícitas, sin ' +
    'tests, todo descansa en disciplina humana al revisar. El siguiente paso natural no es reescribir, sino ' +
    'reforzar cimientos: seguridad, pagos, telemetría.'
  );

  h2('Lo que está MUY BIEN');
  bullet('Cobertura de roles y casos de uso — solo le falta operador de central telefónica.');
  bullet('Panel de caja con turnos, fondo fijo, cancelaciones, quejas — nivel de detalle poco común en v1.');
  bullet('Sistema de cocina por estaciones con token compartible — apenas hay competidores PY con eso.');
  bullet('Soporte chat embebido (Gerente/Admin ↔ Superadmin) — pieza pro de un SaaS maduro.');
  bullet('Migraciones bien numeradas y comentadas, fáciles de auditar.');
  bullet('Decisión de Edge Function para gestión de usuarios — corrigió un riesgo crítico.');

  h2('Lo que está MUY MAL');
  bullet('RLS de 112 USING(true). Esto, hoy, hace que “multi-tenant” sea solo de fachada.');
  bullet('Sin pagos reales. El cliente “elige método” y se confía en el cajero — esto no escala.');
  bullet('PIN rider sin hash + sin rate limit.');
  bullet('Cero tests. Cualquier refactor importante es caminar a oscuras.');
  bullet('Documentación parcialmente desactualizada (auditoria_contexto_ia.md).');

  h2('Veredicto numérico — ponderación por área');
  table(
    ['Área', 'Peso', 'Madurez', 'Contribución'],
    [
      ['Funcionalidad de paneles',         '25%', '85%', '21.25'],
      ['Base de datos y migraciones',      '15%', '80%', '12.00'],
      ['UX visual',                        '10%', '85%', '8.50'],
      ['Multi-tenancy real (RLS)',         '10%', '30%', '3.00'],
      ['Seguridad (PIN, headers, JWT)',    '7%',  '35%', '2.45'],
      ['Pagos reales',                     '8%',  '0%',  '0.00'],
      ['Integraciones externas',           '7%',  '5%',  '0.35'],
      ['CRM / Clientes',                   '5%',  '10%', '0.50'],
      ['Testing y telemetría',             '5%',  '0%',  '0.00'],
      ['Documentación operativa',          '4%',  '60%', '2.40'],
      ['Hardware POS / impresión',         '4%',  '0%',  '0.00'],
      ['Total ponderado',                  '100%','—',  '50.45'],
    ],
    [170, 60, 70, 110]
  );

  p(
    'La suma ponderada estricta da ~50 % de “producto SaaS comercial completo”. La razón por la que el veredicto ' +
    'subjetivo del resumen ejecutivo es más alto (~70 %) es que las áreas con peso real para un piloto en un solo ' +
    'restaurante (funcionalidad + DB + UX) están bien resueltas. Cuando el objetivo cambia a “vender a 50 ' +
    'restaurantes”, las áreas con 0–35 % de madurez se vuelven bloqueantes y el número correcto es el ponderado.'
  );

  h2('Mi recomendación');
  box('Próxima decisión estratégica',
    '1. Si el plan es PILOTO en Tu Restaurante (un único restaurante): el sistema está listo, salvo Bancard. Cuatro ' +
    'semanas de trabajo a ritmo normal lo dejan en producción real.\n\n' +
    '2. Si el plan es SaaS multi-restaurante: hay ~10 semanas de trabajo serio antes de salir a vender. La ' +
    'mitad de ese tiempo es seguridad y multi-tenant; la otra mitad pagos, impresión y CRM.\n\n' +
    'En ambos casos, antes de la primera venta externa: cerrar B-01, B-02, B-03, B-04 y B-07. Son los cinco ' +
    'puntos que separan “demo robusta” de “producto operativo confiable”.',
    { bg: '#DBEAFE', bar: C.accent }
  );

  doc.moveDown(0.4);
  p('Fin del informe.', { color: C.dim });
}

// ─────────────────────────────────────────────────────────────────────────────
// FOOTER / NUMERACIÓN
// ─────────────────────────────────────────────────────────────────────────────
function addFooters() {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    if (i === 0) continue; // portada sin footer
    const y = A4.h - 30;
    doc.font('Helvetica').fontSize(8).fillColor(C.dim);
    doc.text('Mythos · Auditoría integral · v1.0', M.l, y, { width: innerW, align: 'left' });
    doc.text(`Página ${i + 1} de ${range.count}`, M.l, y, { width: innerW, align: 'right' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
cover();
tableOfContents();
resumenEjecutivo();
arquitectura();
compartidos();
panelClienteQR();
panelClienteDelivery();
panelRider();
panelCocina();
panelMozo();
panelCaja();
panelAdmin();
panelGerente();
panelSuperadmin();
database();
bugs();
comoEncontrarMas();
seguridad();
integraciones();
mejoras();
roadmap();
criticaFinal();

addFooters();
doc.end();

doc.on('end', () => console.log('PDF generado en', OUT));
