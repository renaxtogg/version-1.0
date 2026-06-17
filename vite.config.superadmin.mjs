// ════════════════════════════════════════════════════════════════════
// Vite config — panel superadmin (PR-5 batch). Reutiliza la factory de
// vite.config.mjs. emptyOutDir:false → NO borra bundles ya emitidos.
// XLSX sigue como global UMD del shell (window.XLSX).
// ════════════════════════════════════════════════════════════════════
import { panelConfig } from './vite.config.mjs';

export default panelConfig('superadmin', 'MythosSuperadmin', { emptyOutDir: false });
