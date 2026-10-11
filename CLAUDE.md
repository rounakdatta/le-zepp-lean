# CLAUDE.md: LeZeppLean

LeZeppLean is an Amazfit T-Rex 3 (Zepp OS) app. It listens to music playing nearby, identifies the song and shows the lyrics in time with it, **word by word**. When the music stops, the lyrics stop on the word it stopped on; when it comes back, they carry on from there. Skips and the next song are followed. With earphones in, the mic hears nothing, so the watch follows the phone's player instead, through a small Android helper (`android/`). Lyrics in a script the user doesn't read, or that the watch can't draw, are shown in English letters.

The user's bar is **sub-second latency for everything interactive**. Identifying a song inherently needs ~3–5 s of audio; everything else (pause and resume reactions, word highlights, re-sync corrections) must feel instant. Production will run on a **homelab: CPU-only Linux, keep it lean**. No GPU, no PyTorch in the serving path.

Platform research, with sources, is in `docs/research/` (start at `docs/research/README.md`). The sections below are the findings that matter day to day.

## Layout

| Path | What |
|---|---|
| `watch-app/` | The Zepp OS app: watch page, `app-side/` (relay inside the Zepp phone app), `setting/` (settings screen in the Zepp app) |
| `watch-app/lib/` | `recorder.js` (back-to-back takes, what the T-Rex 3 runs on, and the one shared recorder), `live.js` (one continuous recording read while it's written, for firmware that allows it; the T-Rex 3 doesn't), `stream.js` (packet framing), `silk.js` (loudness from packet bytes), `activity.js` (playing / stopped), `envelope.js` (the song's own loudness track), `clock.js` (song clock: matches, pauses, playback speed), `session.js` (all the decisions: what to send, what changed, earphones mode; pure), `sync.js` (line and word at a position), `layout.js` (word-by-word layout), `view.js` (screen), `prefs.js` |
| `server/lezepplean/` | `app.py` (API), `recognize.py` (ShazamIO), `lyrics.py` (LRCLIB), `songs.py` (per-song store on disk), `prepare.py` (what gets computed, in what order), `worker.py` (the CPU steps, in a separate low-priority process), `reference.py` (the song's own audio from YouTube, mapped onto Shazam's timeline), `track.py` (fast re-sync), `silk.py` (loudness reader + the song's loudness track), `phone.py` (the phone player's clock, for earphones mode, and what the phone's mic named), `listen.py` (the phone's mic: what it hears, asked of Shazam as it grows), `roman.py` (lyrics in English letters, through auth2api), `visual.py` (native script reordered for a font that can't shape it), `audio.py`, `zepp_opus.py` |
| `android/` | The helper for earphones mode: reads the playing media session (Android shows it only to apps with notification access) and posts it to `/phone`. `ListenService` (opt-in) listens with the phone's mic when the watch asks; `Listening` is its plain-Java core, tested on the JVM (`app/src/test`). `.github/workflows/android.yml` builds it; a `helper-v*` tag publishes the signed APK as a GitHub release |
| `server/lezepplean/align/` | Word timing: `text.py` (lyrics → letters), `separate.py` (Spleeter vocals, ONNX), `ctc.py` (wav2vec 2.0 letter probabilities, ONNX int8), `forced.py` (banded CTC forced alignment), `__init__.py` (`align_lyrics`, measured settings) |
| `server/scripts/` | `fake_watch.py` (send a clip like the phone does), `eval_align.py` / `eval_track.py` (benchmarks), `watch_sim.py` + `sim_stream.py` (what the watch would record), `silk_levels.py` |
| `tests/watch/` | Node tests for the watch's logic, and for the page itself (`page.test.mjs`) |
| `tests/sim/simulate.mjs` | Replays a simulated listening session through the real session logic against a running server, in simulated time, and measures what the person would see |
| `tests/render/` | Stand-ins for Zepp OS: `zos-ui.mjs` records widgets, so `view.js` screens can be drawn (Pillow) and looked at; with `zos-stubs.mjs` the page runs under Node |
| `tools/` | `serve.sh` (server, tunnel and keep-awake), `install-watch.sh` (sign-in, build, install QR), `qr-hook.cjs` |
| `charts/lezepplean/`, `.github/workflows/docker.yml` | The server's Helm chart and its CI (tests, then image + chart to GHCR), in texas-fold-em's shape |
| `docs/research/` | Platform research (6 detailed reports plus a summary) |
| `brand/`, `tools/brand.py` | The logo as drawn (`logo-source.png`) and everything made from it: the watch's round app icon and listening-screen mark, the Zepp settings header, the Android helper's adaptive icon, the server's page and favicon, the README's. Change the logo by replacing the source and running `uv run --no-project --with pillow --with numpy --with scipy python tools/brand.py`. Its colours (navy #0E1931→#03030A, cream #F8F4EB, coral #FE5641) are the watch's too: coral ring while a song plays, cream while listening and for the sung word |

Keep `watch-app/` self-contained. `zeus build` compiles every `.js` file in it, and production builds embed every non-dot file into the uploaded package (`.ip-package`, which ignores `.gitignore`). That is why watch tests and tools live outside it. Local imports inside `watch-app/` carry the `.js` extension, so Node can load the same files the watch runs.

## Production

The server runs on the homelab: **https://lezepplean.taptappers.club** (DNS in `oh-my-dns`, `A lezepplean`), deployed by `homelab.setup/kubernetes/apps/lezepplean` from the image `ghcr.io/rounakdatta/le-zepp-lean` and the chart `oci://ghcr.io/rounakdatta/charts/lezepplean`. The bearer token is the Bitwarden item `lezepplean/token` (and `pass api-keys/lezepplean/token`); `tools/install-watch.sh` builds the watch app against it unless a local tunnel is running.

Releasing: bump `charts/lezepplean/Chart.yaml` `version` + `appVersion` and `values.yaml` `image.tag` together, merge to `main`, push an annotated tag `vX.Y.Z` (CI: tests, then image + chart at that version; the image reports the tag on `/health`), then bump `homelab.setup` (kustomization `version`, values `image.tag`, re-render the vendored chart, `charts.lock`) and deploy that branch with `deploy-stuff.yml` before merging it. The pod is pinned to the control plane, takes no CPU request (the node's requests are full; its usage isn't), and its `/data` volume is left out of Velero's nightly backup: everything on it can be rebuilt. Lyrics in English letters need `LEZEPPLEAN_LLM_KEY`: on the homelab, the `auth2api-credentials` secret through the chart's `extraEnv`.

The helper: bump `versionCode` and `versionName` in `android/app/build.gradle`, merge, push a tag `helper-vX.Y.Z`. CI signs every build with the same key (repo secrets `ANDROID_KEYSTORE_B64` and `ANDROID_KEYSTORE_PASSWORD`; a copy is in pass, `api-keys/lezepplean/android-keystore`), so a new APK installs over the old one and keeps its settings.

## Commands

```sh
tools/serve.sh                          # server :8787 + Cloudflare quick tunnel + caffeinate; run in your own terminal
tools/install-watch.sh                  # zeus login if needed, build with the tunnel URL+token baked in, show install QR
node --test 'tests/**/*.test.mjs'       # watch logic tests (repo root; the bare `tests/` form fails on Node 24)
cd server && uv run pytest              # server tests
cd server && uv run python scripts/fake_watch.py song.m4a --start 42 --server URL --token T   # simulate the watch
cd server && uv run python scripts/fake_watch.py --lyrics <song id> --server URL               # what a word poll gets
cd watch-app && npx zeus build          # build only; also compiles to QuickJS bytecode, a useful syntax check
```

Benchmarks and the end-to-end simulation (run when changing the aligner, re-sync or the session logic):

```sh
cd server && uv run python scripts/eval_align.py --jamendo <jamendolyrics clone> --separate   # word timing accuracy
cd server && uv run python scripts/eval_track.py --jamendo <jamendolyrics clone>              # fast re-sync accuracy
cd server && uv run python scripts/sim_stream.py song.m4a --out /tmp/s.json --level-db -47 --noise-db -73 \
    --script "play 50 40, silence 6, play 90 35, play 150 25, silence 4, play 175 20"         # needs Shazam to know the song
node tests/sim/simulate.mjs --stream /tmp/s.json --server http://127.0.0.1:8787               # server must be running
node --import ./tests/render/register.mjs tests/render/screens.mjs /tmp/shots.json && python tests/render/render.py draw /tmp/shots.json /tmp/shots
```

JamendoLyrics: `github.com/f90/jamendolyrics` (the 20 English songs, with word annotations). The render script needs Pillow and a TTF; set `LEZEPPLEAN_FONT` if it can't find one.

The server token lives in `server/.token` (git-ignored). Each request is saved to `server/captures/` as the raw clip, a `.wav` and a JSON summary (with the watch's diagnostics under `client`); that is the fastest way to see what the watch heard. The captures are the user's room audio: keep them private. Songs the server has prepared live in `server/data/songs/<shazam key>/`; models download on first use into `server/models/` (~170 MB).

On a nix-based Linux box, the PyAV, onnxruntime and numpy wheels need libstdc++ and zlib on `LD_LIBRARY_PATH`.

## How v0.2 works

```
watch: mic ─► back-to-back takes, 250 ms apart (recorder.js): 5 s while finding the song,
             3 s when the take will be sent, 2 s while following; each is read when it stops
             └─ every 60 ms packet: loudness from the SILK gain index (silk.js)
                  ├─ activity.js: stopped? back? (+ the song's loudness track: quiet passage or pause?)
                  ├─ clock.js: pause/resume the song clock *on the packet it happened*
                  └─ session.js: is the room still the song? (a resume is matched against the
                     loudness track on the watch first) when to ask the server, and what
       the takes worth sending (5 s to find, 2–3 s to place) ─BLE─► phone ─► server
server: known song + its audio on disk?  track.py: place the window near the clock's guess (~30 ms)
        otherwise:                       Shazam (~0.5 s) → song now, LRCLIB lyrics within 1.5 s
                                         or "pending" (the watch polls) → start preparing
        a script the user doesn't read:  English letters, once per song (roman.py, ~3–4 s)
        preparing (prepare.py → worker.py, once per song, kept on disk):
          YouTube audio → Shazam-checked + mapped → loudness track + re-sync features
          → Spleeter vocals → wav2vec 2.0 letters → forced alignment → word timings
          (the next 30 s first, then the next 45 s, then the whole song; in English letters
          for a song shown in them)
earphones: helper (android/) ─ the player's state, on every change (+ every 10 s while playing) ─► POST /phone
           side service ◄─ GET /phone/next (long poll, 8 s) ─ pushes each change to the watch,
           whose song clock follows the player's with the mic off
phone mic: the watch looking for a song ─ askPhone {listen} ─► side service ─ POST 127.0.0.1:47391/listen
           ─► helper's ListenService: up to 8 s, 0.5 s pieces ─► POST /listen/audio ─► Shazam at
           2.5, 4, 6 s ─► `heard` in the phone view ─► the watch starts the song (if still looking)
priority:  the phone's player playing > a song followed in the room > both mics looking
watch: lines [start, text, wordStarts|null, end|null]; the current line is one widget per
       word, lit as sung; timers fire at the exact next word or line change
```

## Verified facts: watch and Zepp OS

**Device**
- The docs device table is stale: it says API_LEVEL 4.0.
- Zepp's Zeus registry says Zepp OS 6.0 / API 4.4.
- The user's watch, measured 2026-10-10: **firmware 6.4.16.3, `getSystemInfo().minAPI` = "5.0"**.
- Round 480×480 screen. Keys: UP and DOWN on the left, SELECT and BACK on the right. No crown.
- It has a mic but no speaker (buzzer and vibration only). Wi-Fi exists but apps can't use it.
- `hmSensor` is undefined for apps, so there is no music sensor: the watch can't see what the phone plays (hence the helper).
- ZML registers the one `@zos/ble` connection listener there is (`addListener` takes one callback; `removeListener()` no arguments): adding our own would replace ZML's and break its reconnecting. The page polls `connectStatus()` instead. ZML rejects a request at once (code 2) while the link is down, and re-handshakes on the first request after it is back (`docs/research/C-connectivity.md`).
- The system font has Devanagari, Bengali, Tamil, Malayalam, Kannada and Arabic glyphs but **no shaping**: vowel signs land on the wrong side of their consonant and conjuncts fall apart (`visual.py` reorders the letters to compensate). Telugu, Gurmukhi, Gujarati and Odia have no glyphs at all (11 Oct 2026).

**Recorder** (`@zos/media`, `create(id.RECORDER)`)
- Requires the undocumented permission `device:os.mic`; without it the recorder throws PERMISSION DENIED.
- Output is **raw Opus packets in opus_demo framing**: `[4-byte BE length][4-byte final range][packet]`, not Ogg.
- The encoding is **SILK wideband, 16 kHz mono, 60 ms single-frame packets** (TOC config 11, code 0), ~17 kbps, so about 10 KB per 5 s. libopus reproduces exactly this at 16–20 kbps with `application=voip`, `frame_duration=60` (`server/lezepplean/silk.py`).
- Capture starts ~0.33–0.35 s after `start()`: 4680 ms is decoded from a ~5010 ms window, and a 2 s take holds 28 packets. So a take is timed back from `stop()` by its packet count (page `onTake`).
- **On the T-Rex 3 the file is handed over only at `stop()`**: nothing can be read while it records (6.4.16.3, 10 Oct 2026). So the app runs on back-to-back takes; `live.js` still probes at runtime and is used where the file grows.
- **One recorder at a time.** A second `create()` returns undefined until the first is garbage collected, so everything shares one (`recorder.microphone()`).
- The START and STOP events arrive within ~5 ms on the T-Rex 3. Some firmware lacks them and `getStatus`, so `recorder.js` falls back to watching the file size.
- Forum #556 reports a take started soon after a `stop()` (or a very short take) producing a 0-byte file and locking the mic until reboot. A T-Rex 3 (6.4.16.3) took 20 takes in a row 250 ms apart, each a full 28 packets, none empty (10 Oct 2026).

**Loudness from packet bytes**
- Packet sizes do not track loudness: the stream is near-constant bitrate (~120 B music vs ~108 B silence).
- **The SILK first-subframe gain index does.** It correlated with frame loudness at r = 0.87 over 936 real packets. Clip means were 22–31 with music and 15.6–18.4 in silence.
- `watch-app/lib/silk.js` reads it from raw bytes with a tiny range decoder. `server/lezepplean/silk.py` is the reference implementation, and the tests compare the two packet by packet.
- Inside music the gain never stayed below 20 for more than 2 packets (120 ms). So a **pause is 4 quiet packets (240 ms)**.
- Room noise and talking can look loud for up to ~600 ms. So a **resume is provisional until the server confirms** it.
- SILK voice-activity flags alone are too weak: 10–55% active even during silence.

**JS runtime and app model**
- QuickJS; the build targets ES2020. `Promise` works; **`async/await` does not** on the device. No `fetch`, `eval`, `TextEncoder` or `Intl`. `Buffer` exists.
- **Any `export` in an entry file** (`app.js`, pages, services) gives a black screen. Errors in lifecycle hooks are swallowed, so wrap hooks (see `guard` in the page).
- A foreground page is killed ~10 s after the screen goes off unless kept awake (`setPageBrightTime`, `pauseDropWristScreenOff`). Apps can't draw on AOD.
- Background App Services can't use the mic, GPS, IMU, BLE central or timers, and only one store app may run in the background at a time. So listening only happens while the app is open.
- LocalStorage returned empty reads 27–67% of the time on a T-Rex 3. Use `@zos/fs` files (`lib/prefs.js`).
- `Vibrator` takes `start({ mode })` / `setMode({ mode })`, not a bare constant.
- The `@zeppos/device-types` 4.0.0 typings miss `@zos/media`, the named export `getTextLayout`, and ARC's `color` and `radius`. Trust the docs.
- TEXT widgets take `color` (and position, size, text) through `setProperty(prop.MORE, {...})`; `VISIBLE` only through `setProperty(prop.VISIBLE, bool)` on its own. `getTextLayout(text, { text_size, text_width: 0, wrapped: 0 })` gives a single-line width (API 2.0).

**Phone link**
- The watch has no internet. All traffic goes watch → BLE (ZML `request`, about 3.6 KB frames) → the side service inside the Zepp phone app → `fetch`.
- The phone can't push unless the watch talked first. Once it has, the side service pushes with ZML `call`. Earphones mode relies on this: while the watch asks every 20 s, the side service long-polls `GET /phone/next` (8 s, inside the ~10 s limit below) and pushes each change of the player.
- The first request after launch can fail while the side service cold-starts; the app retries.
- Android side-service fetches reportedly drop after ~10 s of silence, so the server must answer in under 9 s. Self-signed HTTPS is rejected.
- Plain `http://` to the LAN is reported to work but is unverified on the user's phone.

## Verified facts: server

**Recognition (ShazamIO)**
- `matches[0].offset` is the **song position at the clip's start**. On clean cuts it is precise to well under 1 ms; on simulated room recordings it was 18–30 ms early, like every other method (the codec and the room delay the audio).
- `matches[0].timeskew` is the playback speed error: a copy 1% fast reads +0.0097, 1% slow −0.0097. It is noisy: ±0.0006 on clean audio, and **−0.0042 on a quiet room recording of a normal copy** (the lyrics then drifted 4 ms/s). The clock only believes it beyond 0.6%.
- Calls take ~0.35–0.55 s. It is unofficial and against Shazam's terms; the user accepted that. It is isolated in `recognize.py` so it can be swapped for ACRCloud.

**Lyrics**
- LRCLIB `/api/get` with duration (±2 s) returns lyrics timed for the *same recording*, so a remix doesn't get the original's timings.
- The duration comes from the Apple Music ID in Shazam's `hub.actions`, via an iTunes lookup.
- If that fails, search and keep candidates within 3 s of the duration.
- **Free word timings basically don't exist:** LRCLIB `hasWordSync` was 0 of 13 popular songs, and Unison was 0 of 5. So we compute them, from each song's audio fetched from YouTube with yt-dlp; the user accepted that this is against YouTube's terms.

**Shazam's limits (recognize.py)**
- Shazam rate-limits by address. On 11 Oct 2026 ~100 calls in a minute from agentfest, which shares the homelab's address with production, got HTTP 429s that lasted hours, and every production search failed meanwhile. ShazamIO's default client retries a 429 up to 20 times, so each search kept the limit going.
- Since 0.2.10: one request per call (no retries), a 429 or 5xx is a refusal, then a cool-down of 30 s → 10 min (or Retry-After), and a budget of 10 calls a minute. The watch holds its searches for the `retryInMs` the server gives.
- Never measure against Shazam in bursts from the homelab.

**Lyrics in English letters (roman.py)**
- Written by Claude Haiku 5.5 through the homelab's auth2api: a forced tool call per 25 lines, the calls in parallel, the line count checked. 2.7–3.9 s a song, kept with it; Kesariya was identified in production in 1.4 s and its lyrics were in English letters ~4 s later (11 Oct 2026).
- The prompt asks for fans' everyday spellings ("tujhe dekha toh"), not scholarly transliteration ("tujhe dekhā to"): that is what people can sing from.

**The song's own audio (reference.py), measured 2026-10-10**
- yt-dlp needs a JavaScript runtime for YouTube (Deno or Node; set in `reference._JS`). Without one it warns, offers fewer formats and gets intermittent HTTP 403s.
- Copies on YouTube are offset from Shazam's timeline: a lyrics video of Wonderwall by +425 ms, Blinding Lights' by +113 ms. A remaster can even run at a different speed: "Wonderwall (Remastered)" drifts 0.033% (67 ms over 3 minutes) against Shazam's copy. So every reference is checked and mapped with **five Shazam cuts and a line fit**; the residuals were 2–6 ms.
- First play of a song never heard before, from the identify answer: reference ready +5–9 s, loudness track +9 s, words for the next 30 s **+18 s**, the next 45 s +29 s, the whole song +66 s (2 threads). Every later play: instant, from disk.

**Word timing (align/), benchmarked on JamendoLyrics (20 English songs, 5,693 words, hand-marked word starts), LRC line starts simulated 100 ms early ±250 ms**

| | median error | within 100 ms | within 300 ms |
|---|---|---|---|
| no audio (syllables from the line start) | 275 ms | 20% | 53% |
| wav2vec 2.0 on the mix | 78 ms | 56% | 72% |
| on Spleeter vocals (shipped) | 46 ms | 76% | 90% |
| shipped, lines with confidence ≥ 0.10 only (91% of words) | — | 81% | 94% |

- Lines below confidence 0.10 were right within 300 ms only ~40% of the time, so they are sent without word timings and shown line by line.
- CTC letters fire ~30 ms after the sung onset (median); `WORD_BIAS_MS = -30` corrects it.
- Without a cap on how long a line can last, a line followed by a long instrumental break got its words smeared across the break. 99% of lines are sung within 3 s + 0.8 s per syllable of their start.
- Cost per 4-minute song, AMD EPYC, 3 threads: Spleeter ~7 s, wav2vec 2.0 ~26 s. Peak memory ~1.15 GB in the worker over a new song's four steps. ONNX Runtime's default memory pool took it to 2.1 GB and kept it, which ran the 2 GiB pod out of memory on its first song (10 Oct). Spleeter runs one block at a time (four at a time: 2 GB).

**Fast re-sync (track.py)**
- On simulated room+codec audio: 2 s windows placed with a median error of 23 ms (a constant shift: −7.6 ms codec-only, ~−20 ms with room); 0 of 400 more than 300 ms off; 3–5 ms per search.
- The trap is the *same song* at the wrong place: with the clock 25 s off after a missed skip, the best spot near the clock's guess scored 0.43 while the true spot, anywhere in the song, scored 0.65 (songs repeat). So both searches always run, and a near match only counts when nothing elsewhere beats it.

## Simulated sessions (tests/sim, 2026-10-10)

Blinding Lights in a simulated room calibrated to the watch's real levels (music gain ~27, silence ~16), recorder flushing every 240 ms, the phone link modelled as 700 ms + 4 KB/s each way:

| | result |
|---|---|
| song identified | 11.7 s after opening (5 s of audio + Shazam + link) |
| music stops → lyrics freeze | 0.58 s later, frozen 31–93 ms from where it stopped |
| music back → lyrics carry on | 0.36–0.38 s later, 7–69 ms off; confirmed by the server ~2.5 s later |
| skip inside the song | noticed from the loudness track in 2–2.6 s, followed in ~10.5 s |
| next song | old song ends cleanly; new one shown 11.5 s after it starts |
| someone talking at the watch during a pause (as loud as the music) | the lyrics move ~4.5 s on the provisional resume, then freeze back exactly where the music stopped; the real resume later is confirmed with no outage |
| while playing | lyrics a median 23 ms from the music, within 100 ms 90% of the time |
| word lit = word being sung | 82% (Blinding Lights), 95% (Wonderwall), 93% (a turntable 1% fast) |

Takes mode, which is what the T-Rex 3 runs (`simulate.mjs --takes`, same song and room: a pause, talking during a pause, resumes; 11 Oct 2026, 0.2.9):

| | |
|---|---|
| lyrics frozen at the stop | 99 / 157 / 137 ms off |
| after resuming | 17–63 ms off |
| within 100 ms of the music | 100% |
| word lit = word sung | 96% |

These scenarios are `play/silence/talk/next` scripts for `server/scripts/sim_stream.py`; re-run them after touching `session.js`, `clock.js`, `activity.js` or `track.py`.

## Tooling gotchas

- **Installing Zeus.** zeus-cli 1.9.3 crashes with `Cannot find module 'zeppos-app-utils'` under `npx @zeppos/zeus-cli` or a hoisted install. `watch-app/.npmrc` sets `install-strategy=nested`, which fixes it.
- **Zepp login.** It needs an email + password Zepp account; Google or Apple sign-in doesn't work.
- **Installing on the watch.** `zeus preview` goes through Zepp's cloud and the QR code lasts 7 days. Fallback: Zepp app → Developer Mode → Bridge, then `npx zeus bridge`. The bridge drops after every install: reconnect before the next one, and trust only "Install lite app result: success".
- **Targeting.** Use `platforms: [{ st: 'r', dw: 480 }]`, not `deviceSource`, which breaks the `zosLoader` per-screen layouts.
- **Simulator.** Its T-Rex 3 image is API 4.0 only, with no BLE and a flaky side service, and media is likely unsupported. Test on the watch; for logic, use `tests/sim`.
- **Background tasks.** Claude Code kills them after ~30 min. Long-running servers belong in the user's own terminal (`tools/serve.sh`).
- **Tunnel URLs.** A quick tunnel's URL changes on every start. `install-watch.sh` reads it from cloudflared's metrics endpoint (`127.0.0.1:20241/quicktunnel`) and bakes it, with the token, into `app-side/defaults.js` for that build only; the file is restored afterwards. A LAN URL typed into the Zepp settings survives tunnel restarts.
- **Telemetry.** The Zeus CLI sends telemetry on every command.

## Decisions

| Decision | Why |
|---|---|
| Music from speakers nearby; music in earphones through the phone's player; the phone is Android | The user's choice. The mic can't hear earphones and the watch can't see the phone's player, so a helper on the phone reports it (any player with a media session: Spotify, YouTube Music, YouTube) |
| ShazamIO; the server on the homelab (`charts/lezepplean`), the Mac only for working on it (`tools/serve.sh`) | The user's choice |
| Back-to-back takes, 250 ms apart: 5 s while finding the song, 3 s when the take will be sent, 2 s while following | The T-Rex 3 hands over a recording only when it stops, so a take's length is how late a pause or a resume can be noticed. 2 s is the shortest the server can place inside a song (1.56 s couldn't be) |
| A take is sent only when an answer is needed, and never replaces a request in flight | Replacing it left the watch on "Listening…" while the answers kept arriving for takes already replaced |
| A resume moves the lyrics only once the sound is shown to be the song where it stopped: first on the watch (the take's loudness against the song's loudness track near the expected position: r ≥ 0.6 over ≥ 23 packets, ≥ 0.7 over 17–22), otherwise by the server. The watch's check never waits for the server, and the question stays open until an answer settles it | In a simulated room, 1.4 s of the real song correlated ≥ 0.72 nine times in ten and was placed within a packet; talking never passed 0.47. Closed when the question was sent, one lost answer left the lyrics frozen while the music played |
| A pause is dated from the first quiet packet of its stretch, or the middle of the gap between takes | Packets forgiven as noise used to restart the count, and a stop was dated 1.4 s late |
| Pause/resume decided on the watch from the SILK gain, backdated to the packet | No round trip: the lyrics stop on the right word as soon as the watch has the audio (at the end of the take; ~0.6 s with a continuous recording) |
| Thresholds measured on real recordings until the room's floor is known, then relative to floor and music | Fixed thresholds failed in a room with a louder floor; relative ones from the start were more sensitive than the real recordings justify |
| The song's loudness track (envelope) sent to the watch, one character per 60 ms | Tells a quiet passage from a pause, catches a pause in a loud room, and notices skips without a request |
| Song clock = line fit through matches in *playing time* (pauses cut out), Theil-Sen speed once matches span 30 s | Turntables run fast or slow; least squares let one outlier tilt the lyrics 85 ms |
| The first match after a pause re-anchors every earlier one | Otherwise the old matches outvoted it for minutes and the lyrics stayed 60–90 ms off after each pause |
| Word timing = Spleeter vocals → wav2vec 2.0 (ONNX int8) → banded forced alignment | Best accuracy measured that runs on a CPU: separation took within-300 ms from 72% to 90% |
| Words only for lines with confidence ≥ 0.10 | A highlight that is wrong half the time is worse than a line shown whole |
| Lines about to be sung are aligned first | First play of a song gets words ~18 s after it is identified instead of ~66 s |
| `known` versions for lyrics and envelope | Re-syncs every 30 s would otherwise resend ~10 KB over a link that carries a few KB/s |
| The server says `sync.fast` when it has the song's audio; the watch sends 2–3 s windows only then, 5 s otherwise | Shazam can't place 2 s of room audio, and those misses used to read as "not the song" |
| A resume the server can't place re-freezes the lyrics and enters a "doubt" state that re-asks with 5 s while the room stays loud; a timeout keeps the lyrics running | The first version raised the resume bar above the "noise" for good, and real music could then never resume |
| Answers are only applied to what they are about: not to a song that has since ended, not to audio from before a pause, not to a stretch of music that has since been replaced | Each of these, found in review, put the lyrics seconds off or restarted an ended song |
| A line stays on screen until its last word has been lit for 180 ms (never costing the next line its first word) | With a fixed 300 ms lead, a word sung less than ~260 ms before the next line was never lit |
| Temporary failures (LRCLIB down, YouTube 403, Shazam errors, a killed worker) are retried, never saved as "no lyrics" / "no audio" / "no words" | Saved, they were permanent |
| A step is recorded as tried *before* it runs, and waits 1 min, 4, 16 … 6 h after a failure, across restarts | A step that runs the worker out of memory was otherwise re-run on every word poll (14 worker deaths in 7 requests), and after each restart |
| Nothing is learned about the room while a resume is unconfirmed; a rejected resume restores the music level from before the pause; the room's floor is learned only from sound near it | Talking at the wrist during a pause taught it a music level of 38 where the music was 28, and the music could then never resume; and music held back by the raised bar was learned as "room", after which quiet beats read as pauses (51 times in 40 simulated sessions) |
| The worker process starts when a new song's audio starts downloading and exits after 5 idle minutes | Its models hold ~340 MB; idle, the server is ~130 MB. Loading them during the download costs no latency |
| The speech model's ONNX memory pool is sized exactly and emptied after each chunk; the separator keeps the default pool | The default pool grows by doubling and keeps everything: 2.1 GB after one new song, which killed the pod. Now 1.15 GB, identical output, ~3% more time. The separator's blocks are all one size, so its pool stops at ~300 MB, and the exact pool would cost it 20% |
| Fast re-sync on the song's own audio, Shazam as fallback | ~30 ms instead of ~500 ms, works on 2 s, and is more consistent than Shazam on room audio |
| Display timing: a line appears 300 ms early, a word lights 40 ms early, timers at exact change times | Reading ahead; drawing time |
| A new song's name goes out within 1.5 s; its lyrics, if LRCLIB hasn't answered, as "pending", which the watch polls (1.5 s, then ×1.5 up to 10 s) | Lyrics first, words later. A slow LRCLIB used to hold the whole answer, and one failure showed as "no lyrics" for good |
| The phone's player comes first: while it plays, the watch follows it with the mic off, and nothing either mic hears replaces it. When it doesn't play (paused too), both mics look for a song at once; a paused phone song stays on screen until something replaces it, or for a minute | The user's rule. Music in the earphones is what the person hears; the room matters only when the phone is quiet |
| The phone listens too, opt-in: a foreground service armed from the helper's screen, triggered on 127.0.0.1 by the side service, recording up to 8 s while the watch looks for a song (at most every 20 s; a silent first second sends nothing); never while the phone plays or buffers | A far better mic than the watch's, and not on a moving wrist. Android lets an app use the mic in the background only from a foreground service started while it was on screen. The loopback trigger costs nothing until used (a long poll would keep the radio awake) |
| The trigger is signed (`LZL <ms>.<HMAC-SHA256(token, lezepplean-listen:<ms>)>`, `app-side/sign.js`, checked by `Listening.verify`: fresh, never reused), never the token itself | Any app holding that port while the helper isn't (it is off by default) would have had the server's token |
| A song only the phone's mic has heard isn't paused by the watch's own quiet: the phone keeps listening for it and its news re-times it, until the watch's mic places it | The phone's mic is there because the watch's can't hear: its silence froze such a song at the first take |
| A request out when Bluetooth drops is let go when the link is back; its late failure is ignored | ZML never rejects it: it timed out 25 s later and held everything up meanwhile |
| Songs are named by Shazam, not by matching the audio of songs already on the server | Fast (1 s of audio) and right 88-100% of the time for songs in the library, but a clip of a remix or a cover matched its original 8-23 times in 40 (11 Oct 2026): the wrong song, timed wrong |
| A song's length must be one it can have: past its lyrics' last line and where it was just heard, and 30 s or more; else LRCLIB's (if that can be right) or none, and its audio is looked for again | A bad catalog entry gave "Nobody" 4 s (11 Oct 2026): the watch ended it every time it was found ("Song ended", over and over), and no copy of that length was found to time its words |
| A player with no track, or buffering with no word for 35 s, is not the phone's music | An idle Spotify said "buffering", no title, at 0: the phone's mic was turned away as if music played |
| Nothing is sent while the Bluetooth link is down; the moment it is back, holds are cleared and the phone is asked at once | Failed requests counted as errors and held the next one back for up to 24 s after the link was back |
| Earphones mode: the phone's position, not audio. The server keeps the player's clock (offset = the fastest delivery among the recent updates), the side service long-polls and pushes, and the mic is off; after 60 s paused, the room is listened to again | Exact where the mic is an estimate, and pushed: a change reaches the watch without it asking. The mic would only hear the room |
| In earphones mode the phone ends its songs, not the watch's clock. A helper silent for 35 s while its music plays is marked `stale` (a new version): the music is taken to play on, and if the song then ends with no word, the watch lets it go | Ended on the watch's clock, a song left the watch following the phone with nothing to follow and its mic off. Marked paused instead (0.2.9-0.3.0), the lyrics froze while YouTube Music played on: Android holds the helper back while the screen is off (`GET /phone/recent` shows what it said lately) |
| Lyrics in a script the user doesn't read, or the watch can't draw, are written in English letters once per song by an LLM, and their words are timed in those letters | Fans sing from everyday spellings (dil, pyaar), which rule-based transliteration doesn't produce. One call per song costs ~3 s, once |
| Native script only for the scripts ticked in the settings that the watch can draw, its letters reordered by `visual.py` (Tamil per consonant); Urdu without word timings | The font has the glyphs but doesn't shape them, and one widget per word would set Urdu's right-to-left words out left to right. Telugu, Punjabi, Gujarati and Odia always go out in English letters |

## Status

**0.2.9 is live** on the homelab and runs on the user's T-Rex 3: takes with resumes checked on the watch, word-by-word karaoke, pauses, resumes, skips and next songs followed, earphones mode with the helper (0.1.2), lyrics in English letters or in the scripts the user reads. Before it reached the watch, four rounds of independent review found 12 bugs (and 6 risks), then 8, 3 and 1 more in the previous round's fixes, that the green suites had missed; a fifth round found nothing. All but one now have a test that failed before its fix; the exception (takes mode anchoring an answer on the wrong take) is in `page/home/index.js`, which Node couldn't load then, and was fixed by reading. A sixth review, of the code that took it onto the real watch (0.2.3–0.2.8), found 15 more: four could leave the watch frozen, stuck on "Loading lyrics…" or deaf until restarted. 0.2.9 fixes them, each with a test that failed before its fix (the page runs under Node now) except two found by reading: a resume heard partway through a take anchored to the take's start (the page re-anchored windows the session had already timed), and plain-http servers refused by the helper.

**Open:**
1. The phone listening too (0.3.0) is built but unverified on the phone: whether the Zepp app's `fetch` reaches `http://127.0.0.1` (the side service logs "phone mic asked …" or "… not reached" in the bridge log), and how fast songs are named from the phone's mic. Finds now use 3.5 s takes, on the measurement that Shazam named 3–4.7 s room clips equally often; the time to first lyrics is still to be measured on the watch.
2. YouTube music videos in earphones mode: the player's position is the video's, so a video with an intro runs the lyrics early. It needs the video mapped onto the song, as `reference.py` maps its own copies.
3. Karaoke: someone singing over a track with no vocals.
4. Not measured on the watch yet: the BLE throughput (the simulator assumes 4 KB/s + 700 ms), pause thresholds in more rooms, `getTextLayout` with 24 word widgets.

## Conventions

- **Watch tests** live in `tests/` (Node, ESM, no Zepp APIs); keep logic pure so it can be tested there. The page itself runs under Node with the stand-ins in `tests/render` (`tests/watch/page.test.mjs`): test what the page does there. `session.js` takes time as an argument for the same reason.
- **Server tests** are in `server/tests/`, run with `uv run pytest`. Nothing in them touches the network.
- **Commits** never include `server/.token`, `server/captures/`, `server/data/`, `server/models/`, caches or build output; they are git-ignored.
- **Research before building.** Check the minimum API_LEVEL of any Zepp OS API before using it. The docs source is `github.com/zepp-health/zeppos-docs`; clone and grep it. Community answers are at `github.com/orgs/zepp-health/discussions`.
- **Measure before tuning.** Thresholds in this repo cite what they were measured on; when changing one, re-run the benchmark or simulator it came from and update the numbers.
