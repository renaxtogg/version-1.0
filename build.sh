#!/bin/bash
set -e

RESTAURANT_ID="${RESTAURANT_ID:-00000000-0000-0000-0000-000000000001}"

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_ANON_KEY" ]; then
  echo "SUPABASE_URL/ANON_KEY no configuradas — deploy en modo DEMO"
  SUPABASE_URL=""
  SUPABASE_ANON_KEY=""
fi

cat > public/config.js << CONF
window.SUPABASE_CONFIG = { url: '${SUPABASE_URL}', anonKey: '${SUPABASE_ANON_KEY}', restaurantId: '${RESTAURANT_ID}' };
CONF

echo "Build OK"
