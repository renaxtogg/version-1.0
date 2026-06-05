// ============================================================
// Mesa App v1.0 — Ejemplo de configuración Supabase
// Copiá este archivo a config.js y reemplazá los valores.
// ============================================================
window.SUPABASE_CONFIG = {
  url: 'https://TU_PROJECT_ID.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  // Dejar vacío para multi-restaurante (el cliente llega por QR con ?r=<id>).
  // Para un deploy de UN SOLO local, poné acá el UUID real del restaurante.
  restaurantId: ''
};
