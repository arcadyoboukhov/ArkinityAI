#!/usr/bin/env sh
set -eu

APP_BIN="/app/arcinity/Arcinity"

if [ ! -x "$APP_BIN" ]; then
  echo "Arcinity binary not found at: $APP_BIN" >&2
  exit 1
fi

exec zypak-wrapper "$APP_BIN" --no-sandbox "$@"

