#!/usr/bin/env bash
set -Eeuo pipefail

PORT="${PORT:-3001}"
HOST="${HOST:-127.0.0.1}"
LOG_FILE="$(mktemp -t rawroute-preview.XXXXXX.log)"
PREVIEW_NONCE="$$-${RANDOM}-${RANDOM}"

preview_health() {
  PORT="$PORT" HOST="$HOST" RAWROUTE_PREVIEW_PROBE="$PREVIEW_NONCE" bun -e '
    try {
      const response = await fetch(`http://${Bun.env.HOST}:${Bun.env.PORT}/api/health`);
      const body = await response.json();
      process.exit(response.ok && body.previewProbe === Bun.env.RAWROUTE_PREVIEW_PROBE ? 0 : 1);
    } catch { process.exit(1); }
  ' >/dev/null 2>&1
}

cleanup() {
  trap - EXIT INT TERM
  [[ -n "${APP_PID:-}" ]] && kill "$APP_PID" 2>/dev/null || true
  [[ -n "${TUNNEL_PID:-}" ]] && kill "$TUNNEL_PID" 2>/dev/null || true
  rm -f "$LOG_FILE"
}
trap cleanup EXIT INT TERM

echo "Starting Bun app on http://${HOST}:${PORT}..."
PORT="$PORT" \
AUTH_SHOW_DEFAULT_PASSWORD_HINT=false \
RAWROUTE_PREVIEW_PROBE="$PREVIEW_NONCE" \
bun run dev >"$LOG_FILE" 2>&1 &
APP_PID=$!

for _ in {1..30}; do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    cat "$LOG_FILE"
    echo "Bun app stopped unexpectedly." >&2
    exit 1
  fi
  if preview_health; then
    break
  fi
  sleep 0.2
done

if ! kill -0 "$APP_PID" 2>/dev/null || ! preview_health; then
  cat "$LOG_FILE"
  echo "Bun app did not become ready on port ${PORT}, or another server owns the port." >&2
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
