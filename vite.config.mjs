// ════════════════════════════════════════════════════════════════════
// Vite config — migración incremental del frontend fuera de Babel-en-navegador.
// ────────────────────────────────────────────────────────────────────
// Cada panel migrado se compila a un bundle IIFE autocontenido en
// public/build/<panel>.js (reemplaza React/ReactDOM UMD + @babel/standalone
// + el script JSX inline). Los paneles no migrados siguen sirviéndose tal cual.
//
// NOTA (PR-12): Rollup NO emite varios bundles IIFE en un solo build (IIFE no
// soporta multi-input/code-splitting). Para mantener cada panel como un IIFE
// autocontenido y NO re-tocar paneles ya migrados, cada panel tiene su propio
// build: este archivo es el del piloto `delivery-rider` (default export) y se
// expone `panelConfig` para los demás (ver vite.config.delivery-cliente.mjs).
// `npm run build` encadena un `vite build` por panel.
//
//  • publicDir:false → no toca los HTML existentes en public/.
//  • define process.env.NODE_ENV → en modo lib Vite no lo reemplaza; React de
//    producción lo referencia y sin esto rompe con "process is not defined".
//  • React/ReactDOM se bundlean. Supabase sigue UMD CDN (window.supabase).
// ════════════════════════════════════════════════════════════════════
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Factory: config de un panel migrado (bundle IIFE autocontenido).
//   panel       : nombre/carpeta del panel (src/<panel>/main.jsx → build/<panel>.js)
//   globalName  : nombre global del IIFE (no se usa en runtime, requerido por Rollup)
//   emptyOutDir : true solo en el PRIMER build de la cadena (limpia public/build);
//                 false en los siguientes para no borrar los bundles ya emitidos.
export function panelConfig(panel, globalName, { emptyOutDir }) {
  return defineConfig({
    plugins: [react()],
    publicDir: false,
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    build: {
      outDir: resolve(__dirname, 'public/build'),
      emptyOutDir,
      minify: 'esbuild',
      sourcemap: false,
      lib: {
        entry: resolve(__dirname, `src/${panel}/main.jsx`),
        formats: ['iife'],
        name: globalName,
        fileName: () => `${panel}.js`,
      },
    },
  });
}

// Default: piloto delivery-rider (PR-11). Limpia public/build (primer build).
export default panelConfig('delivery-rider', 'MythosDeliveryRider', { emptyOutDir: true });
