#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
backend_dir="$(pwd)"
runtime_dir="$backend_dir/.local-openapi/runtime"
redis_url="${REDIS_URL:-redis://127.0.0.1:6379}"
port="${PORT:-3091}"

npm run build
mkdir -p "$runtime_dir"
cp package.json package-lock.json "$runtime_dir/"
cd "$runtime_dir"

# Do not inherit the main application's database or service credentials.
exec env -i PATH="$PATH" HOME="$HOME" NODE_ENV=development OPENAPI_ENABLED=true \
  PORT="$port" DATABASE_PATH="$runtime_dir/lawcast.db" \
  REDIS_URL="$redis_url" REDIS_KEY_PREFIX="lawcast-openapi-$port:" \
  CRAWLING_PAL_ENABLED=false CRAWLING_NSM_ENABLED=true \
  OLLAMA_ENABLED=false SEMANTIC_SEARCH_ENABLED=false \
  DISCORD_BRIDGE_ENABLED=false WEB_PUSH_ENABLED=false \
  node "$backend_dir/dist/main.js"
