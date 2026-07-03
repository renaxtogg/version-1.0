// ════════════════════════════════════════════════════════════════════
// Vite config — panel proveedor (PR-MKT-1, marketplace B2B). Reutiliza la
// factory de vite.config.mjs. emptyOutDir:false → NO borra bundles ya emitidos.
// ════════════════════════════════════════════════════════════════════
import { panelConfig } from './vite.config.mjs';

export default panelConfig('proveedor', 'MythosProveedor', { emptyOutDir: false });
