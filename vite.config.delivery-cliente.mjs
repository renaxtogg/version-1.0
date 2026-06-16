// ════════════════════════════════════════════════════════════════════
// Vite config — panel delivery-cliente (PR-12). Reutiliza la factory de
// vite.config.mjs. emptyOutDir:false → corre DESPUÉS del build del rider y
// NO borra public/build/delivery-rider.js. Ver `npm run build`.
// ════════════════════════════════════════════════════════════════════
import { panelConfig } from './vite.config.mjs';

export default panelConfig('delivery-cliente', 'MythosDeliveryCliente', { emptyOutDir: false });
