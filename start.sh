#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
[ -d node_modules ] || npm install --silent 2>/dev/null
[ -f build/server.js ] || npx tsc --silent 2>/dev/null
exec node build/server.js
