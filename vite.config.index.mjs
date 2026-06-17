// ════════════════════════════════════════════════════════════════════
// Vite config — panel index / cliente QR (PR-5 batch). Reutiliza la factory
// de vite.config.mjs. emptyOutDir:false → NO borra bundles ya emitidos.
// Incluye el tweaks-panel (EDITMODE) bundleado vía src/index/tweaks-panel.jsx.
// ════════════════════════════════════════════════════════════════════
import { panelConfig } from './vite.config.mjs';

export default panelConfig('index', 'MythosIndex', { emptyOutDir: false });
