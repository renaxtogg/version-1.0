// ════════════════════════════════════════════════════════════════════
// Vite config — panel mozo (PR-5 batch). Reutiliza la factory de
// vite.config.mjs. emptyOutDir:false → NO borra bundles ya emitidos.
// ════════════════════════════════════════════════════════════════════
import { panelConfig } from './vite.config.mjs';

export default panelConfig('mozo', 'MythosMozo', { emptyOutDir: false });
