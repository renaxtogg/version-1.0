const fs = require('fs');
const path = require('path');

// Mapeo de colores: dark theme → Mythos light theme
// Orden importa: más específico primero
const LIGHT_MAP = [
  // Fondos oscuros → blanco/gris claro
  ["'#0A0A0A'", "'#FFFFFF'"],
  ['"#0A0A0A"', '"#FFFFFF"'],
  ["'#0d0d0d'", "'#F5F5F7'"],
  ['"#0d0d0d"', '"#F5F5F7"'],
  ["'#080810'", "'#FFFFFF'"],
  ['"#080810"', '"#FFFFFF"'],
  ["'#111111'", "'#F5F5F7'"],
  ['"#111111"', '"#F5F5F7"'],
  ["'#111'", "'#F5F5F7'"],
  ['"#111"', '"#F5F5F7"'],
  ["'#1a1a1a'", "'#FFFFFF'"],
  ['"#1a1a1a"', '"#FFFFFF"'],
  ["'#1a1a24'", "'#F5F5F7'"],
  ['"#1a1a24"', '"#F5F5F7"'],
  ["'#2a2a2a'", "'#F5F5F7'"],
  ['"#2a2a2a"', '"#F5F5F7"'],
  ["'#0f172a'", "'#F5F5F7'"],  // mozo dark bg
  ['"#0f172a"', '"#F5F5F7"'],

  // Bordes oscuros → borde claro Mythos
  ["'#222'", "'#D2D2D7'"],
  ['"#222"', '"#D2D2D7"'],
  ["'#2a2a40'", "'#D2D2D7'"],
  ['"#2a2a40"', '"#D2D2D7"'],
  ["'#333'", "'#D2D2D7'"],
  ['"#333"', '"#D2D2D7"'],
  ["'#334155'", "'#D2D2D7'"],  // mozo dark border
  ['"#334155"', '"#D2D2D7"'],
  ["'#444'", "'#86868B'"],
  ['"#444"', '"#86868B"'],
  ["'#1e1e30'", "'#D2D2D7'"],
  ['"#1e1e30"', '"#D2D2D7"'],

  // Texto claro sobre fondo oscuro → texto oscuro sobre fondo claro
  ["'#e8e8f0'", "'#1D1D1F'"],
  ['"#e8e8f0"', '"#1D1D1F"'],
  ["'#f8fafc'", "'#1D1D1F'"],
  ['"#f8fafc"', '"#1D1D1F"'],

  // Texto secundario/terciario
  ["'#555'", "'#6E6E73'"],
  ['"#555"', '"#6E6E73"'],
  ["'#666'", "'#6E6E73'"],
  ['"#666"', '"#6E6E73"'],
  ["'#888'", "'#86868B'"],
  ['"#888"', '"#86868B"'],
  ["'#8888a8'", "'#6E6E73'"],
  ['"#8888a8"', '"#6E6E73"'],
  ["'#aaa'", "'#AEAEB2'"],
  ['"#aaa"', '"#AEAEB2"'],
  ["'#94a3b8'", "'#86868B'"],
  ['"#94a3b8"', '"#86868B"'],
  ["'#44445a'", "'#AEAEB2'"],
  ['"#44445a"', '"#AEAEB2"'],

  // Acentos morados/índigo → negro (branding Mythos)
  ["'#6366f1'", "'#000000'"],
  ['"#6366f1"', '"#000000"'],
  ["'#4f46e5'", "'#000000'"],
  ['"#4f46e5"', '"#000000"'],
  ["'#818cf8'", "'#1D1D1F'"],
  ['"#818cf8"', '"#1D1D1F"'],

  // Colores semánticos → tokens Mythos (se mantienen, solo normalizamos hex)
  ["'#ef4444'", "'#FF3B30'"],
  ['"#ef4444"', '"#FF3B30"'],
  ["'#dc2626'", "'#FF3B30'"],
  ['"#dc2626"', '"#FF3B30"'],
  ["'#f87171'", "'#FF3B30'"],
  ['"#f87171"', '"#FF3B30"'],
  ["'#22c55e'", "'#34C759'"],
  ['"#22c55e"', '"#34C759"'],
  ["'#16a34a'", "'#34C759'"],
  ['"#16a34a"', '"#34C759"'],
  ["'#4ade80'", "'#34C759'"],
  ['"#4ade80"', '"#34C759"'],
  ["'#f59e0b'", "'#FF9500'"],
  ['"#f59e0b"', '"#FF9500"'],
  ["'#f97316'", "'#FF9500'"],
  ['"#f97316"', '"#FF9500"'],
  ["'#ea580c'", "'#FF9500'"],
  ['"#ea580c"', '"#FF9500"'],
  ["'#3b82f6'", "'#007AFF'"],
  ['"#3b82f6"', '"#007AFF"'],
  ["'#2563eb'", "'#007AFF'"],
  ['"#2563eb"', '"#007AFF"'],
];

// Archivos a transformar al tema LIGHT (todos excepto cocina)
const LIGHT_FILES = [
  'public/admin.html',
  'public/caja.html',
  'public/superadmin.html',
  'public/mozo.html',
  'public/index.html',
  'public/login.html',
];

// Reemplazos específicos para cocina.html (dark mode limpio)
const COCINA_MAP = [
  // Fuente → system-ui
  ["'Plus Jakarta Sans',sans-serif", "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"],
  ['"Plus Jakarta Sans",sans-serif', 'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'],
  // Normalizar dark tokens de cocina
  ["'#0A0A0A'", "'#000000'"],
  ['"#0A0A0A"', '"#000000"'],
  ["'#333'", "'#38383A'"],
  ['"#333"', '"#38383A"'],
  ["'#555'", "'#636366'"],
  ['"#555"', '"#636366"'],
];

function applyMap(content, map) {
  let result = content;
  for (const [from, to] of map) {
    result = result.split(from).join(to);
  }
  return result;
}

// Reemplazo de fuente para archivos light
function applyFontReplacement(content) {
  return content
    .split("'Plus Jakarta Sans',sans-serif").join("system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif")
    .split('"Plus Jakarta Sans",sans-serif').join('system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif')
    .split("'Plus Jakarta Sans'").join('system-ui')
    .split('"Plus Jakarta Sans"').join('system-ui')
    .split("'JetBrains Mono'").join("'SF Mono',ui-monospace,monospace")
    .split('"JetBrains Mono"').join('"SF Mono",ui-monospace,monospace');
}

// Procesar archivos light
for (const file of LIGHT_FILES) {
  const filePath = path.join(process.cwd(), file);
  if (!fs.existsSync(filePath)) { console.log(`SKIP (no existe): ${file}`); continue; }
  let content = fs.readFileSync(filePath, 'utf8');
  content = applyMap(content, LIGHT_MAP);
  content = applyFontReplacement(content);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`✓ Light theme aplicado: ${file}`);
}

// Procesar cocina (dark mode limpio)
const cocinaPath = path.join(process.cwd(), 'public/cocina.html');
if (fs.existsSync(cocinaPath)) {
  let content = fs.readFileSync(cocinaPath, 'utf8');
  content = applyMap(content, COCINA_MAP);
  fs.writeFileSync(cocinaPath, content, 'utf8');
  console.log('✓ Dark mode limpio aplicado: cocina.html');
}

console.log('\n✅ Script completado. Revisá los archivos manualmente para ajustes finos.');
