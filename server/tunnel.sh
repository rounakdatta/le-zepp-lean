#!/usr/bin/env bash
# Expose the local server on a temporary public HTTPS URL (Cloudflare quick tunnel, no account).
# The URL changes every time this starts; paste the new one into the LeZeppLean settings in the Zepp app.
set -euo pipefail
exec nix run nixpkgs#cloudflared -- tunnel --no-autoupdate --url "http://localhost:${PORT:-8787}"
