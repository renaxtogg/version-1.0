// ════════════════════════════════════════════════════════════════════
// Vite config — panel admin (PR-5 batch). Reutiliza la factory de
// vite.config.mjs. emptyOutDir:false → NO borra bundles ya emitidos.
// XLSX y Leaflet siguen como globales UMD del shell (window.XLSX / window.L).
// ════════════════════════════════════════════════════════════════════
import { panelConfig } from './vite.config.mjs';

export default panelConfig('admin', 'MythosAdmin', { emptyOutDir: false });
