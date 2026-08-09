// ════════════════════════════════════════════════════════════════════
// Copia pdf.js a public/vendor/pdfjs/ para servirlo DESDE NUESTRO DOMINIO.
// ────────────────────────────────────────────────────────────────────
// Por qué vendorizado y no por CDN, aunque el CSP permita cdnjs/jsdelivr:
// pdf.js corre su parser dentro de un Web Worker, y nuestro CSP declara
// `worker-src 'self'`. Un worker traído de un CDN queda BLOQUEADO por el
// navegador, y el fallback a main-thread congelaría la pestaña con un PDF
// grande. Sirviéndolo local, `script-src 'self'` y `worker-src 'self'` pasan
// los dos sin tocar el CSP — que es justo lo que no queremos aflojar.
//
// Va a public/vendor/ (gitignored, como public/build/) y lo regenera Vercel en
// cada deploy a partir de la dependencia de package.json. Así la versión queda
// fijada por el lockfile y no por un archivo binario commiteado a mano.
//
// SEGURIDAD — la versión importa: pdfjs-dist <= 4.1.392 permite EJECUTAR
// JavaScript arbitrario al abrir un PDF malicioso (GHSA-wgrm-67xf-hhpq). Acá se
// usa 4.10.38. Si algún día alguien baja la versión, este script falla a
// propósito antes de copiar nada.
// ════════════════════════════════════════════════════════════════════
import { mkdirSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz   = join(dirname(fileURLToPath(import.meta.url)), '..');
const origen = join(raiz, 'node_modules', 'pdfjs-dist', 'build');
const destino= join(raiz, 'public', 'vendor', 'pdfjs');

const MIN_SEGURA = [4, 2, 67];   // primera versión sin GHSA-wgrm-67xf-hhpq

function versionInstalada() {
  const pkg = join(raiz, 'node_modules', 'pdfjs-dist', 'package.json');
  if (!existsSync(pkg)) return null;
  return JSON.parse(readFileSync(pkg, 'utf8')).version;
}

function esSegura(v) {
  const p = String(v).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((p[i] || 0) > MIN_SEGURA[i]) return true;
    if ((p[i] || 0) < MIN_SEGURA[i]) return false;
  }
  return true;
}

const v = versionInstalada();
if (!v) {
  console.error('[vendor-pdfjs] pdfjs-dist no está instalado. Corré npm install.');
  process.exit(1);
}
if (!esSegura(v)) {
  console.error(`[vendor-pdfjs] pdfjs-dist ${v} tiene la vulnerabilidad de ejecución`);
  console.error('               de JavaScript arbitrario (GHSA-wgrm-67xf-hhpq).');
  console.error(`               Se requiere ${MIN_SEGURA.join('.')} o superior. Build abortado.`);
  process.exit(1);
}

mkdirSync(destino, { recursive: true });
for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  const src = join(origen, f);
  if (!existsSync(src)) {
    console.error(`[vendor-pdfjs] falta ${f} en pdfjs-dist ${v}. Build abortado.`);
    process.exit(1);
  }
  copyFileSync(src, join(destino, f));
}
console.log(`[vendor-pdfjs] pdf.js ${v} copiado a public/vendor/pdfjs/`);
