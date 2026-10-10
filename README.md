# LeZeppLean

Time-synced lyrics for the music playing around you, word by word, on an Amazfit T-Rex 3 (Zepp OS 6).

Hold the watch near the music. It identifies the song and lights each word as it is sung. Stop the music and the lyrics stop on that word; start it again and they carry on. Skip ahead, or let the next song start, and the watch follows.

```
Watch (LeZeppLean app)                     Phone (Zepp app)            Server (CPU only)
 mic, recording continuously               phone-side service           Shazam: which song, where
  ├ every 60 ms: still the music? ─┐        relays requests     ──HTTP─► the song's own audio: re-sync in ~30 ms
  │  stopped / back / skipped       │                                     LRCLIB lyrics + word timings it computes:
  │  (decided on the watch)         └─ short windows ─BLE─►                Spleeter vocals → wav2vec 2.0 → alignment
  └ lyrics, word by word, in time  ◄────────────── lyrics, word timings, the song's loudness track
```

The watch knows when every 60 ms packet of its recording started, and the server says where in the song a window of them starts, so the seconds spent on Bluetooth and the network don't affect the timing. Between server answers the watch keeps its own song clock, and it reads loudness straight out of the compressed audio, so it notices the music stopping or coming back within about half a second without asking anyone.

The first time a song is heard, the server fetches the song's audio and works out when every word is sung: the lines about to be sung come first (about 18 s after the song is identified), the whole song within about a minute. Until then those lines show line by line. After that the song is instant.

| Folder | What it is |
|---|---|
| [`watch-app/`](watch-app) | Zepp OS app: watch UI and listening logic, the phone-side relay (`app-side/`) and the settings screen (`setting/`) |
| [`server/`](server) | Python service: recognition, lyrics, word timing, fast re-sync. See [server/README.md](server/README.md) |
| [`tests/`](tests) | Node tests for the watch logic, a session simulator, and a screen renderer |
| [`docs/research/`](docs/research/README.md) | Platform research: what the T-Rex 3 can and can't do |

## Running it

The server runs on the homelab at **https://lezepplean.taptappers.club** (image `ghcr.io/rounakdatta/le-zepp-lean`, chart `oci://ghcr.io/rounakdatta/charts/lezepplean`, deployed by `homelab.setup`). Its token is the Bitwarden item `lezepplean/token`, also in `pass` as `api-keys/lezepplean/token`.

1. **Watch app:** run `tools/install-watch.sh`. It does three things:
   - signs in to Zepp if needed (an email + password account);
   - builds the app with the server's URL and token built in: the homelab, unless a local server's tunnel is running (step 2);
   - shows an install QR code in the terminal and in the browser. The code is valid for 7 days.

   On the phone, once: Zepp app → Profile → Settings → About → tap the Zepp icon 7 times to turn on Developer Mode. Then Developer Mode → **Scan**.
2. **A server on this Mac instead** (for working on the server): run `tools/serve.sh` in its own terminal window and leave it open. It starts the server and a public HTTPS tunnel, prints the Mac's Wi-Fi address, and keeps the Mac awake; Ctrl-C stops everything. The first run downloads two models (~170 MB), and word timing needs Node or Deno installed (yt-dlp uses it to read YouTube). Re-run `tools/install-watch.sh` whenever the tunnel restarts, because its URL changes each time.
3. **Settings** are optional. A server URL or token entered in the Zepp app (your watch → LeZeppLean) overrides the built-in ones. **Test connection** checks whichever server is in use.

**On the watch:**

| Input | Action |
|---|---|
| SELECT, or a tap on the screen | Re-sync now |
| UP / DOWN | Move lyrics 0.1 s earlier / later (remembered) |
| Hold SELECT | Diagnostics |
| BACK | Exit |
