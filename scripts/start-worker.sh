#!/usr/bin/env sh
# QrSiparis Control Center — BullMQ deployment worker entrypoint
#
# Per Doc 18 + IMPL_NOTES: control-center-worker runs as a SEPARATE process
# from the Next.js app. Concurrency 3, limiter 5/min, attempts 1, timeout 10min.

set -eu

: "${NODE_ENV:=production}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[start-worker] FATAL: DATABASE_URL is required" >&2
  exit 1
fi
if [ -z "${REDIS_URL:-}" ]; then
  echo "[start-worker] FATAL: REDIS_URL is required" >&2
  exit 1
fi
if [ -z "${MASTER_KEY:-}" ]; then
  echo "[start-worker] FATAL: MASTER_KEY is required (32-byte hex)" >&2
  exit 1
fi

echo "[start-worker] Starting deployment worker..."
echo "[start-worker] APP_VERSION=${APP_VERSION:-dev} GIT_COMMIT=${GIT_COMMIT:-unknown}"

# Use tsx to execute the TypeScript entry directly. In production we may want a
# pre-compiled JS bundle, but tsx is fine for V1 (Phase H6 may revisit).
exec pnpm run worker
