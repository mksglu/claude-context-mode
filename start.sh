#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Bundle exists (CI-built) — only need native module
if [ -f server.bundle.mjs ]; then
  [ -d node_modules/better-sqlite3 ] || npm install better-sqlite3 --no-package-lock --ignore-scripts=false --silent 2>/dev/null
  exec node server.bundle.mjs
fi

# Fallback: no bundle (dev or npm install) — full build
[ -d node_modules ] || npm install --silent 2>/dev/null
[ -f build/server.js ] || npx tsc --silent 2>/dev/null
exec node build/server.js
