#!/usr/bin/env bash
# Install LeZeppLean on the watch in one step:
#   1. signs in to Zepp if needed (a browser window opens; use an email + password Zepp account),
#   2. builds the app with the running server's address and token built in, so there is
#      nothing to type in the Zepp app (set LEZEPPLEAN_SERVER_URL to use another server),
#   3. uploads a preview build to Zepp and shows the install QR code, in the terminal and
#      as a large image in the browser.
# Then on the phone: Zepp app → Profile → Developer Mode → Scan.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/watch-app"
DEFAULTS="$APP/app-side/defaults.js"

cd "$APP"
[ -d node_modules/@zeppos/zeus-cli ] || npm install --no-fund --no-audit

if npx zeus status 2>/dev/null | grep -q 'no login'; then
  echo "Opening the Zepp sign-in page in your browser (use an email + password Zepp account)…"
  npx zeus login
fi

server_url="${LEZEPPLEAN_SERVER_URL:-}"
if [ -z "$server_url" ]; then
  # A running quick tunnel (server/tunnel.sh) reports its hostname on cloudflared's metrics port.
  for port in 20241 20242 20243 20244 20245; do
    host="$(curl -s --max-time 1 "http://127.0.0.1:$port/quicktunnel" | sed -n 's/.*"hostname":"\([^"]*\)".*/\1/p' || true)"
    if [ -n "$host" ]; then
      server_url="https://$host"
      break
    fi
  done
fi
token="$(tr -d '[:space:]' < "$ROOT/server/.token" 2>/dev/null || true)"

if [ -n "$server_url" ]; then
  echo "Building with server $server_url"
  backup="$(mktemp)"
  cp "$DEFAULTS" "$backup"
  trap 'cp "$backup" "$DEFAULTS"; rm -f "$backup"' EXIT
  {
    echo "// Written by tools/install-watch.sh for this build; restored when it finishes."
    echo "export const DEFAULT_SERVER_URL = '$server_url'"
    echo "export const DEFAULT_TOKEN = '$token'"
  } > "$DEFAULTS"
else
  echo "No running tunnel found and LEZEPPLEAN_SERVER_URL is not set."
  echo "After installing, enter the server in the Zepp app: your watch → LeZeppLean settings."
fi

export LEZEPPLEAN_QR_OUT="${TMPDIR:-/tmp}/lezepplean-install-qr.html"
NODE_OPTIONS="--require $ROOT/tools/qr-hook.cjs" npx zeus preview -t "Amazfit T-Rex 3"
