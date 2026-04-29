#!/bin/bash
# ============================================================
# Mesa App v1.0 — Build Script para Vercel
# Las credenciales de Supabase vienen de las env vars de Vercel,
# nunca de un archivo en el repo o en la carpeta pública.
# ============================================================

set -e

echo "Building Mesa App v1.0..."

# Verificar que las variables de entorno existen
if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_ANON_KEY" ]; then
  echo "⚠️  ADVERTENCIA: SUPABASE_URL o SUPABASE_ANON_KEY no están configuradas."
  echo "   La app se despliega en modo DEMO (datos hardcodeados)."
  echo "   Para activar Supabase, agregar las env vars en Vercel Dashboard."
  # Generar config.js en modo demo (sin credenciales reales)
  cat > public/config.js << 'CONF'
// Modo DEMO — configurar SUPABASE_URL y SUPABASE_ANON_KEY en Vercel
window.SUPABASE_CONFIG = { url: '', anonKey: '', restaurantId: '00000000-0000-0000-0000-000000000001' };
CONF
else
  echo "✅ Credenciales Supabase encontradas — generando config.js desde env vars..."
  # Generar config.js inyectando las credenciales desde las env vars de Vercel
  # NOTA: El anon key de Supabase está diseñado para ser usado en el browser (con RLS).
  # El service_role key NUNCA se incluye aquí.
  cat > public/config.js << CONF
// Generado automáticamente en el build — NO editar manualmente
window.SUPABASE_CONFIG = {
  url: '${SUPABASE_URL}',
  anonKey: '${SUPABASE_ANON_KEY}',
  restaurantId: '${RESTAURANT_ID:-00000000-0000-0000-0000-000000000001}'
};
CONF
  echo "✅ config.js generado correctamente."
fi

echo "Build completo."
