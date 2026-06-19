// ============================================================
// Mesa App v1.0 — Ejemplo de configuración Supabase
// Copiá este archivo a config.js y reemplazá los valores.
// ============================================================
window.SUPABASE_CONFIG = {
  url: 'https://TU_PROJECT_ID.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  // Dejar vacío para multi-restaurante (el cliente llega por QR con ?r=<id>).
  // Para un deploy de UN SOLO local, poné acá el UUID real del restaurante.
  restaurantId: '',
  // WhatsApp de ventas Mythos (solo dígitos, con código de país, sin + ni espacios).
  // Lo usan las tarjetas de "Mejorar mi plan" del módulo Paneles y los paywalls.
  // Ej: '595981123456'. Si lo dejás vacío, se usa un número de ejemplo.
  salesWhatsapp: ''
};

// ============================================================
// Integraciones externas (Google Maps + Login social)
// ------------------------------------------------------------
// En producción este objeto lo GENERA build.sh desde env vars de Vercel
// (Settings → Environment Variables). NUNCA pegar claves reales acá ni en
// config.js: este archivo es de ejemplo y config.js está gitignored.
//
// Env vars que lee build.sh:
//   GOOGLE_MAPS_API_KEY   → googleMapsApiKey      (clave de Google Maps JS/Places)
//   MYTHOS_AUTH_GOOGLE    → authProviders.google  ("true" para habilitar)
//   MYTHOS_AUTH_FACEBOOK  → authProviders.facebook ("true" para habilitar)
//
// Importante: los flags authProviders SOLO se ponen en "true" DESPUÉS de
// configurar el proveedor en Supabase → Authentication → Providers. Si no,
// el botón intentará un OAuth que el backend rechaza. Con flag en false el
// botón aparece en estado "pendiente de configuración" (no rompe el login).
//
// Si este objeto falta o un campo está vacío, el sistema degrada con gracia:
//   - Maps sin key  → el cliente usa GPS (navigator.geolocation) + deep-links a
//                     google.com/maps; el rider abre rutas con deep-links.
//   - OAuth en false → login sigue funcionando solo con correo + contraseña.
window.MYTHOS_CONFIG = {
  googleMapsApiKey: '',                                   // ej: 'AIzaSy...'  (vacío = sin mapa embebido)
  authProviders: { google: false, facebook: false }      // poner true solo tras configurar el provider en Supabase
};
