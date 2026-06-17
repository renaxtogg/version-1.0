// ════════════════════════════════════════════════════════════════════
// Vite config — panel cocina / KDS (PR-5). Reutiliza la factory de
// vite.config.mjs. emptyOutDir:false → corre DESPUÉS del build del rider y
// NO borra los bundles ya emitidos en public/build/. Ver `npm run build`.
// ════════════════════════════════════════════════════════════════════
import { panelConfig } from './vite.config.mjs';

export default panelConfig('cocina', 'MythosCocina', { emptyOutDir: false });
