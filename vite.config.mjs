// ════════════════════════════════════════════════════════════════════
// Vite config — PR-11 piloto: migración del frontend fuera de Babel-en-navegador.
// ────────────────────────────────────────────────────────────────────
// Estrategia INCREMENTAL: se compila UN solo panel piloto (delivery-rider)
// a un bundle IIFE precompilado. Los otros 8 paneles siguen sirviéndose
// tal cual desde public/*.html (sin tocar) hasta migrarse en PRs futuros.
//
//  • publicDir:false  → Vite NO trata public/ como passthrough; no copia
//    ni transforma los HTML existentes (siguen siendo el output de Vercel).
//  • build.lib IIFE   → un único <script> autoejecutable que reemplaza a
//    React UMD + ReactDOM UMD + @babel/standalone + el <script type="text/babel">.
//  • outDir public/build → el bundle queda dentro del output de Vercel
//    (outputDirectory:public) sin mezclarse con los HTML. Carpeta gitignored.
//  • React/ReactDOM se BUNDLEAN (reemplazan al CDN). Supabase sigue como
//    UMD CDN (window.supabase) — diferido por bajo riesgo, sin refactor.
// ════════════════════════════════════════════════════════════════════
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: resolve(__dirname, 'public/build'),
    emptyOutDir: true,
    minify: 'esbuild',
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, 'src/delivery-rider/main.jsx'),
      formats: ['iife'],
      name: 'MythosDeliveryRider',
      fileName: () => 'delivery-rider.js',
    },
  },
});
