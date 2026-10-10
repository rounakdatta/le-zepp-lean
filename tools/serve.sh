#!/usr/bin/env bash
# Run everything the watch needs on this Mac: the LeZeppLean server and its public HTTPS
# tunnel, and keep the Mac from idle-sleeping meanwhile. Run it in its own terminal window
# and leave it open while you use the watch; Ctrl-C stops it all.
#
# The phone can reach the server two ways:
#   - on the same Wi-Fi: http://<this Mac's address>:8787 (printed below; enter it once in
#     the Zepp app → your watch → LeZeppLean settings, and it survives tunnel restarts)
#   - from anywhere: the https://….trycloudflare.com URL printed by the tunnel. It changes on
#     every start, so re-run tools/install-watch.sh afterwards to build it into the app.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

caffeinate -is -w $$ &

"$ROOT/server/run.sh" &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT

lan="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
echo
echo "LeZeppLean server starting on port 8787."
[ -n "$lan" ] && echo "Same Wi-Fi address for the Zepp app settings: http://$lan:8787"
echo "Public HTTPS URL: look for https://….trycloudflare.com in the tunnel output below."
echo

"$ROOT/server/tunnel.sh"
