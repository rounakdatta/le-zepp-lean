# LeZeppLean

Time-synced lyrics for the music playing around you, on an Amazfit T-Rex 3 (Zepp OS 6, API level 4.4).

Hold the watch near the music. It identifies the song and shows the lyrics in time with it.

```
Watch (LeZeppLean app)                  Phone (Zepp app)              This Mac (server/)
 mic → 5 s Opus clip (~14 KB) ──BLE──►  phone-side service  ──HTTP──►  decode → Shazam → song + position
 lyrics, line by line, in time ◄─BLE─◄  JSON ◄───────────────────────  LRCLIB synced lyrics (length-matched)
```

The recognizer reports where in the song the clip started, to sub-millisecond precision. The watch knows when it started recording, so it can compute the current song position: `offset + time elapsed since recording`. The seconds spent identifying don't affect the sync. The app listens again every 20–45 s to stay in sync and to notice the next song.

| Folder | What it is |
|---|---|
| [`watch-app/`](watch-app) | Zepp OS app: watch UI and recorder, the phone-side relay (`app-side/`) and the settings screen (`setting/`) |
| [`server/`](server) | Python service: decodes the watch's raw Opus clip, identifies it with ShazamIO, fetches synced lyrics from LRCLIB |
| [`tests/`](tests) | Node tests for the watch's timing logic (`node --test tests/`) |
| [`docs/research/`](docs/research/README.md) | Platform research: what the T-Rex 3 can and can't do |

## Running it

1. **Server** (on this Mac): run `tools/serve.sh` in its own terminal window and leave it open. It starts the server and a public HTTPS tunnel, prints the Mac's Wi-Fi address, and keeps the Mac awake. Ctrl-C stops everything. See [server/README.md](server/README.md) for the pieces.
2. **Watch app:** run `tools/install-watch.sh`. It does three things:
   - signs in to Zepp if needed (an email + password account);
   - builds the app with the running tunnel's URL and the server token built in;
   - shows an install QR code in the terminal and in the browser. The code is valid for 7 days.

   On the phone, once: Zepp app → Profile → Settings → About → tap the Zepp icon 7 times to turn on Developer Mode. Then Developer Mode → **Scan**.
3. **Settings** are optional. A server URL or token entered in the Zepp app (your watch → LeZeppLean) overrides the built-in ones. For example, use `http://<mac-lan-ip>:8787` on home Wi-Fi. **Test connection** checks whichever server is in use.

Re-run `tools/install-watch.sh` whenever the tunnel restarts, because its URL changes each time.

**On the watch:**

| Input | Action |
|---|---|
| SELECT, or a tap on the screen | Listen now |
| UP / DOWN | Move lyrics 0.1 s earlier / later (remembered) |
| Hold SELECT | Diagnostics |
| BACK | Exit |
