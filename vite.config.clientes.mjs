// ════════════════════════════════════════════════════════════════════
// Vite config — panel /clientes (app de comensales, mig 200).
// Reutiliza la factory de vite.config.mjs. emptyOutDir:false → NO borra
// bundles ya emitidos por los builds anteriores de la cadena.
// ════════════════════════════════════════════════════════════════════
import { panelConfig } from './vite.config.mjs';

export default panelConfig('clientes', 'MythosClientes', { emptyOutDir: false });
