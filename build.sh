#!/bin/bash
set -e

# Strip UTF-8 BOM (EF BB BF) that can appear when pasting values into Vercel dashboard
strip_bom() { printf '%s' "$1" | sed 's/^\xef\xbb\xbf//'; }
SUPABASE_URL=$(strip_bom "${SUPABASE_URL}")
SUPABASE_ANON_KEY=$(strip_bom "${SUPABASE_ANON_KEY}")
# Sin default cableado: el restaurante se resuelve por contexto (?r= del QR/link,
# localStorage del login, o RESTAURANT_ID env para un deploy de un solo local).
# El UUID …0001 fue eliminado en la migración 096 — NO volver a usarlo como fallback.
RESTAURANT_ID=$(strip_bom "${RESTAURANT_ID:-}")

# Integraciones externas (preparación) — todas opcionales, sin default cableado.
# Si la env var falta, el frontend degrada con gracia (Maps usa GPS+deep-links;
# el login social muestra "pendiente de configuración"). NUNCA hardcodear claves acá:
# se inyectan por Vercel → Settings → Environment Variables.
GOOGLE_MAPS_API_KEY=$(strip_bom "${GOOGLE_MAPS_API_KEY:-}")
AUTH_GOOGLE_RAW=$(strip_bom "${MYTHOS_AUTH_GOOGLE:-}")
AUTH_FACEBOOK_RAW=$(strip_bom "${MYTHOS_AUTH_FACEBOOK:-}")

# Normaliza "true/1/yes/on" → true (booleano JS literal); cualquier otra cosa → false.
to_bool() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    true|1|yes|on) printf 'true' ;;
    *) printf 'false' ;;
  esac
}
AUTH_GOOGLE=$(to_bool "$AUTH_GOOGLE_RAW")
AUTH_FACEBOOK=$(to_bool "$AUTH_FACEBOOK_RAW")

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_ANON_KEY" ]; then
  echo "SUPABASE_URL/ANON_KEY no configuradas — deploy en modo DEMO"
  SUPABASE_URL=""
  SUPABASE_ANON_KEY=""
fi

cat > public/config.js << CONF
window.SUPABASE_CONFIG = { url: '${SUPABASE_URL}', anonKey: '${SUPABASE_ANON_KEY}', restaurantId: '${RESTAURANT_ID}' };
window.MYTHOS_CONFIG = { googleMapsApiKey: '${GOOGLE_MAPS_API_KEY}', authProviders: { google: ${AUTH_GOOGLE}, facebook: ${AUTH_FACEBOOK} } };
CONF

echo "Build OK"
