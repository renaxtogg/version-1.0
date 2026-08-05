// ════════════════════════════════════════════════════════════════════
// Vite config — /riders (Red de Riders Mythos, mig 206).
// Reutiliza la factory de vite.config.mjs. emptyOutDir:false → NO borra
// los bundles ya emitidos por los builds anteriores de la cadena.
// ════════════════════════════════════════════════════════════════════
import { panelConfig } from './vite.config.mjs';

export default panelConfig('riders', 'MythosRiders', { emptyOutDir: false });
