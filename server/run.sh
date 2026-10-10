#!/usr/bin/env bash
# Start the LeZeppLean server on port 8787, on all interfaces so the phone can reach it over Wi-Fi.
# If server/.token exists, requests must send "Authorization: Bearer <token>".
set -euo pipefail
cd "$(dirname "$0")"
if [ -s .token ]; then
  LEZEPPLEAN_TOKEN="$(tr -d '[:space:]' < .token)"
  export LEZEPPLEAN_TOKEN
fi
exec uv run python -W ignore -m uvicorn lezepplean.app:app --host 0.0.0.0 --port "${PORT:-8787}"
