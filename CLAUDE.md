# CLAUDE.md: LeZeppLean

LeZeppLean is an Amazfit T-Rex 3 (Zepp OS) app. It listens to music playing nearby, identifies the song and shows the lyrics in time with it. Today that is line by line; word-by-word karaoke and pause/resume are in progress.

The user's bar is **sub-second latency for everything interactive**. Identifying a song inherently needs ~3–4 s of audio; everything else (pause and resume reactions, word highlights, re-sync corrections) must feel instant. Production will run on a **homelab: CPU-only Linux, keep it lean**. No GPU or heavyweight ML in the serving path.

Platform research, with sources, is in `docs/research/` (start at `docs/research/README.md`). The sections below are the findings that matter day to day.

## Layout

| Path | What |
|---|---|
| `watch-app/` | The Zepp OS app: watch pages, `app-side/` (relay inside the Zepp phone app), `setting/` (settings screen in the Zepp app) |
| `watch-app/lib/` | `recorder.js` (5 s takes), `sync.js` (song clock and timing), `view.js` (screen), `prefs.js`, and v0.2 work: `live.js`, `silk.js`, `activity.js`, `stream.js`, `layout.js` |
| `server/` | Python/FastAPI (uv): decodes the watch's Opus → ShazamIO → LRCLIB synced lyrics. `server/lezepplean/align/` (word timing) is in progress |
| `tests/` | Node tests for the watch's pure logic (`node --test tests/`) and fixtures |
| `tools/` | `serve.sh` (server, tunnel and keep-awake), `install-watch.sh` (sign-in, build, install QR), `qr-hook.cjs` |
| `docs/research/` | Platform research (6 detailed reports plus a summary) |

Keep `watch-app/` self-contained. `zeus build` compiles every `.js` file in it, and production builds embed every non-dot file into the uploaded package (`.ip-package`, which ignores `.gitignore`). That is why watch tests and tools live outside it.

## Commands

```sh
tools/serve.sh                          # server :8787 + Cloudflare quick tunnel + caffeinate; run in your own terminal
tools/install-watch.sh                  # zeus login if needed, build with the tunnel URL+token baked in, show install QR
node --test tests/                      # watch logic tests (repo root)
cd server && uv run pytest              # server tests
cd server && uv run python scripts/fake_watch.py song.m4a --start 42 --server URL --token T   # simulate the watch
cd watch-app && npx zeus build          # build only (npx works here thanks to .npmrc; see gotchas)
```

The server token lives in `server/.token` (git-ignored). Each request is saved to `server/captures/` as the raw clip, a `.wav` and a JSON summary; that is the fastest way to see what the watch heard. The captures are the user's room audio: keep them private.

## Verified facts: watch and Zepp OS

**Device**
- The docs device table is stale: it says API_LEVEL 4.0.
- Zepp's Zeus registry says Zepp OS 6.0 / API 4.4.
- The user's watch, measured 2026-10-10: **firmware 6.4.16.3, `getSystemInfo().minAPI` = "5.0"**.
- Round 480×480 screen. Keys: UP and DOWN on the left, SELECT and BACK on the right. No crown.
- It has a mic but no speaker (buzzer and vibration only). Wi-Fi exists but apps can't use it.

**Recorder** (`@zos/media`, `create(id.RECORDER)`)
- Requires the undocumented permission `device:os.mic`; without it the recorder throws PERMISSION DENIED.
- Output is **raw Opus packets in opus_demo framing**: `[4-byte BE length][4-byte final range][packet]`, not Ogg.
- The encoding is **SILK wideband, 16 kHz mono, 60 ms single-frame packets** (TOC config 11, code 0), ~17 kbps, so about 10 KB per 5 s.
- Capture starts ~0.33–0.35 s after `start()`: 4680 ms is decoded from a ~5010 ms window. So clip timing is anchored on `stop()` (`sync.clipStartMs`).
- Some firmware lacks the recorder events and `getStatus`, so don't rely on them.
- A take started soon after a `stop()` (or a very short take) can produce a 0-byte file and lock the mic system-wide until reboot (forum #556). Keep takes ≥ 4 s and ≥ 8 s apart, or record continuously.
- **Unknown, the key v0.2 question:** whether the recording file is readable while recording is still running. `lib/live.js` probes this at runtime and falls back to takes if it isn't.

**Loudness from packet bytes**
- Packet sizes do not track loudness: the stream is near-constant bitrate (~120 B music vs ~108 B silence).
- **The SILK first-subframe gain index does.** It correlated with frame loudness at r = 0.87 over 936 real packets. Clip means were 22–31 with music and 15.6–18.4 in silence.
- `watch-app/lib/silk.js` reads it from raw bytes with a tiny range decoder. `server/scripts/silk_levels.py` is the reference implementation, and the tests compare the two packet by packet.
- Inside music the gain never stayed below 20 for more than 2 packets (120 ms). So a **pause is 4 quiet packets (240 ms)**.
- Room noise and talking can look loud for up to ~600 ms. So a **resume is provisional until the server confirms** it (`lib/activity.js`).
- SILK voice-activity flags alone are too weak: 10–55% active even during silence.

**JS runtime and app model**
- QuickJS; the build targets ES2020. `Promise` works; **`async/await` does not** on the device. No `fetch`, `eval`, `TextEncoder` or `Intl`. `Buffer` exists.
- **Any `export` in an entry file** (`app.js`, pages, services) gives a black screen. Errors in lifecycle hooks are swallowed, so wrap hooks (see `guard` in the page).
- A foreground page is killed ~10 s after the screen goes off unless kept awake (`setPageBrightTime`, `pauseDropWristScreenOff`). Apps can't draw on AOD.
- Background App Services can't use the mic, GPS, IMU, BLE central or timers, and only one store app may run in the background at a time. So listening only happens while the app is open.
- LocalStorage returned empty reads 27–67% of the time on a T-Rex 3. Use `@zos/fs` files (`lib/prefs.js`).
- `Vibrator` takes `start({ mode })` / `setMode({ mode })`, not a bare constant.
- The `@zeppos/device-types` 4.0.0 typings miss `@zos/media`, the named export `getTextLayout`, and ARC's `color` and `radius`. Trust the docs.

**Phone link**
- The watch has no internet. All traffic goes watch → BLE (ZML `request`, about 3.6 KB frames) → the side service inside the Zepp phone app → `fetch`.
- The phone can't push unless the watch talked first.
- The first request after launch can fail while the side service cold-starts; the app retries.
- Android side-service fetches reportedly drop after ~10 s of silence, so the server must answer in under 9 s. Self-signed HTTPS is rejected.
- Plain `http://` to the LAN is reported to work but is unverified on the user's phone.

## Verified facts: server

**Recognition (ShazamIO)**
- `matches[0].offset` is the **song position at the clip's start**, precise to well under 1 ms. Cuts 10.000 s apart came back 9.9997 s and 10.0006 s apart.
- Calls take ~0.45–0.55 s.
- It is unofficial and against Shazam's terms; the user accepted that. It is isolated in `recognize.py` so it can be swapped for ACRCloud.

**Lyrics**
- LRCLIB `/api/get` with duration (±2 s) returns lyrics timed for the *same recording*, so a remix doesn't get the original's timings.
- The duration comes from the Apple Music ID in Shazam's `hub.actions`, via an iTunes lookup.
- If that fails, search and keep candidates within 3 s of the duration.
- **Word timings are basically unavailable for free:** LRCLIB `hasWordSync` was 0 of 13 popular songs, and Unison was 0 of 5. So we compute them. The user approved fetching each song's audio from YouTube (yt-dlp) for this, accepting it's against YouTube's terms.

**Stack and speed**
- Python 3.13 needs `audioop-lts` (pydub). PyAV 18 bundles libopus for both decode and encode.
- Server time is 0.5–1.4 s per identify (decode ~25 ms, Shazam ~0.5 s, lyrics ~0.5–0.9 s, cached lyrics ~0).

**Real-watch session, 2026-10-10**
- Wonderwall was identified 5 times. Back-to-back re-syncs agreed to within arrival-time resolution, and a song restart was detected correctly.
- Silent clips (−53 to −69 dB RMS) returned no match, as they should.

## Tooling gotchas

- **Installing Zeus.** zeus-cli 1.9.3 crashes with `Cannot find module 'zeppos-app-utils'` under `npx @zeppos/zeus-cli` or a hoisted install. `watch-app/.npmrc` sets `install-strategy=nested`, which fixes it.
- **Zepp login.** It needs an email + password Zepp account; Google or Apple sign-in doesn't work.
- **Installing on the watch.** `zeus preview` goes through Zepp's cloud and the QR code lasts 7 days. Fallback: Zepp app → Developer Mode → Bridge, then `npx zeus bridge`.
- **Targeting.** Use `platforms: [{ st: 'r', dw: 480 }]`, not `deviceSource`, which breaks the `zosLoader` per-screen layouts.
- **Simulator.** Its T-Rex 3 image is API 4.0 only, with no BLE and a flaky side service, and media is likely unsupported. Test on the watch.
- **Background tasks.** Claude Code kills them after ~30 min. Long-running servers belong in the user's own terminal (`tools/serve.sh`).
- **Tunnel URLs.** A quick tunnel's URL changes on every start. `install-watch.sh` reads it from cloudflared's metrics endpoint (`127.0.0.1:20241/quicktunnel`) and bakes it, with the token, into `app-side/defaults.js` for that build only; the file is restored afterwards. A LAN URL typed into the Zepp settings survives tunnel restarts.
- **Telemetry.** The Zeus CLI sends telemetry on every command.

## Decisions

| Decision | Why |
|---|---|
| Music from speakers nearby, phone is Android | The user's choice. Earbud audio can't be heard by the watch mic, so a Spotify mode would be a separate feature |
| ShazamIO, server on the user's Mac for now, then a lean homelab deploy | The user's choice |
| Song clock: `songStart = clipStart − offset`, median of the last 5 re-sync estimates | A jump over 1.5 s resets it (seek or restart). A pause shifts the start by the pause length (`pauseClock` / `resumeClock`) |
| Display timing | Lines appear 300 ms early so you can read ahead. Words light up 40 ms early to cover drawing time. Timers fire at exact change times, not on a polling tick |
| `known` lyrics version (planned) | Re-syncs shouldn't resend lyrics; the server only sends them when the version changes (e.g. word timings arrive) |
| Fast re-sync (planned, `server/lezepplean/track.py`) | Cross-correlate watch windows against the cached reference audio near the predicted position (~30 ms, numpy) instead of Shazam (~500 ms) |

## Status

**v0.1, working on the watch:**
- 5 s takes and line-synced lyrics;
- a re-sync every 20–45 s;
- UP/DOWN nudge by 0.1 s, remembered;
- hold SELECT for diagnostics;
- the next song is picked up automatically.

**v0.2, in progress:**
- `live.js`: continuous listening that reads the recording while it's written. Unverified on the device; it falls back to takes.
- `silk.js` and `activity.js`: on-watch pause and resume.
- `layout.js`: word-by-word karaoke layout. The `view.js` widget pool and page wiring are not done yet.
- `server/lezepplean/align/`: a lean, CPU-only word-timing aligner, which onset-snaps syllable estimates on the reference audio. Being written; it may still contain an earlier heavy MLX/Demucs prototype that is benchmark-only.
- `track.py`: fast re-sync, planned.
- Server API changes, planned: a per-line word start array `[startMs, text, [wordStartMs…], endMs]` with words split like Python's `str.split()`, plus the `known` version handshake.

## Conventions

- **Watch tests** live in `tests/` (Node, ESM, no Zepp APIs); keep logic pure so it can be tested there.
- **Server tests** are in `server/tests/`, run with `uv run pytest`.
- **Commits** never include `server/.token`, `server/captures/`, caches or build output; they are git-ignored.
- **Research before building.** Check the minimum API_LEVEL of any Zepp OS API before using it. The docs source is `github.com/zepp-health/zeppos-docs`; clone and grep it. Community answers are at `github.com/orgs/zepp-health/discussions`.
