#!/usr/bin/env sh
# QrSiparis Control Center — Next.js app entrypoint
#
# This script is the canonical "start the server" hook. The Docker `app` stage's
# CMD calls `node server.js` directly (Next.js standalone output), but local /
# Coolify environments may invoke this wrapper for additional pre-start hooks.

set -eu

: "${PORT:=3001}"
: "${NODE_ENV:=production}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[start-server] FATAL: DATABASE_URL is required" >&2
  exit 1
fi
if [ -z "${REDIS_URL:-}" ]; then
  echo "[start-server] FATAL: REDIS_URL is required" >&2
  exit 1
fi
if [ -z "${MASTER_KEY:-}" ]; then
  echo "[start-server] FATAL: MASTER_KEY is required (32-byte hex for AES-256-GCM)" >&2
  exit 1
fi

echo "[start-server] Starting Control Center app on port ${PORT}..."
echo "[start-server] APP_VERSION=${APP_VERSION:-dev} GIT_COMMIT=${GIT_COMMIT:-unknown}"

# Run any pending Drizzle migrations (idempotent). Worker also runs this on boot.
# H1 phase will own the actual migration runner; this is a placeholder.
# pnpm db:migrate || { echo "[start-server] Migrations failed"; exit 1; }

exec node server.js
