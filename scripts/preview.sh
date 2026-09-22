#!/usr/bin/env bash
set -Eeuo pipefail

PORT="${PORT:-3001}"
HOST="${HOST:-127.0.0.1}"
LOG_FILE="$(mktemp -t rawroute-preview.XXXXXX.log)"

cleanup() {
  trap - EXIT INT TERM
  [[ -n "${APP_PID:-}" ]] && kill "$APP_PID" 2>/dev/null || true
  [[ -n "${TUNNEL_PID:-}" ]] && kill "$TUNNEL_PID" 2>/dev/null || true
  rm -f "$LOG_FILE"
}
trap cleanup EXIT INT TERM

echo "Starting Bun app on http://${HOST}:${PORT}..."
BUN_PUBLIC_SPACETIMEDB_HOST="${BUN_PUBLIC_SPACETIMEDB_HOST:-ws://localhost:3000}" \
BUN_PUBLIC_SPACETIMEDB_DB_NAME="${BUN_PUBLIC_SPACETIMEDB_DB_NAME:-rawroute-simple}" \
bun run build >"$LOG_FILE" 2>&1
PORT="$PORT" \
BUN_PUBLIC_SPACETIMEDB_HOST="${BUN_PUBLIC_SPACETIMEDB_HOST:-ws://localhost:3000}" \
BUN_PUBLIC_SPACETIMEDB_DB_NAME="${BUN_PUBLIC_SPACETIMEDB_DB_NAME:-rawroute-simple}" \
bun run start >>"$LOG_FILE" 2>&1 &
APP_PID=$!

for _ in {1..30}; do
  if curl --silent --fail "http://${HOST}:${PORT}/api/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    cat "$LOG_FILE"
    echo "Bun app stopped unexpectedly." >&2
    exit 1
  fi
  sleep 0.2
done

if ! curl --silent --fail "http://${HOST}:${PORT}/api/health" >/dev/null 2>&1; then
  cat "$LOG_FILE"
  echo "Bun app did not become ready on port ${PORT}." >&2
  exit 1
fi

echo "Opening Cloudflare Quick Tunnel..."
cloudflared tunnel --url "http://${HOST}:${PORT}" --http-host-header "${HOST}:${PORT}" 2>&1 | while IFS= read -r line; do
  echo "$line"
  if [[ "$line" =~ https://[-a-zA-Z0-9]+\.trycloudflare\.com ]]; then
    echo
    echo "Preview URL: ${BASH_REMATCH[0]}"
    echo "Press Ctrl+C to stop the app and tunnel."
  fi
done &
TUNNEL_PID=$!

wait "$TUNNEL_PID"
