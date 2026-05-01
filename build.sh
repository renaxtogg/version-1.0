#!/bin/bash
set -e

# Strip UTF-8 BOM (EF BB BF) that can appear when pasting values into Vercel dashboard
strip_bom() { printf '%s' "$1" | sed 's/^\xef\xbb\xbf//'; }
SUPABASE_URL=$(strip_bom "${SUPABASE_URL}")
SUPABASE_ANON_KEY=$(strip_bom "${SUPABASE_ANON_KEY}")
RESTAURANT_ID=$(strip_bom "${RESTAURANT_ID:-00000000-0000-0000-0000-000000000001}")

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_ANON_KEY" ]; then
  echo "SUPABASE_URL/ANON_KEY no configuradas — deploy en modo DEMO"
  SUPABASE_URL=""
  SUPABASE_ANON_KEY=""
fi

cat > public/config.js << CONF
window.SUPABASE_CONFIG = { url: '${SUPABASE_URL}', anonKey: '${SUPABASE_ANON_KEY}', restaurantId: '${RESTAURANT_ID}' };
CONF

echo "Build OK"
