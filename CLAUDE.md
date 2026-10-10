# CLAUDE.md: LeZeppLean

LeZeppLean is an Amazfit T-Rex 3 (Zepp OS) app. It listens to music playing nearby, identifies the song and shows the lyrics in time with it, **word by word**. When the music stops, the lyrics stop on the word it stopped on; when it comes back, they carry on from there. Skips and the next song are followed.

The user's bar is **sub-second latency for everything interactive**. Identifying a song inherently needs ~3–5 s of audio; everything else (pause and resume reactions, word highlights, re-sync corrections) must feel instant. Production will run on a **homelab: CPU-only Linux, keep it lean**. No GPU, no PyTorch in the serving path.

Platform research, with sources, is in `docs/research/` (start at `docs/research/README.md`). The sections below are the findings that matter day to day.

## Layout

| Path | What |
|---|---|
| `watch-app/` | The Zepp OS app: watch page, `app-side/` (relay inside the Zepp phone app), `setting/` (settings screen in the Zepp app) |
| `watch-app/lib/` | `live.js` (one continuous recording, read while it's written), `stream.js` (packet framing), `silk.js` (loudness from packet bytes), `activity.js` (playing / stopped), `envelope.js` (the song's own loudness track), `clock.js` (song clock: matches, pauses, playback speed), `session.js` (all the decisions: what to send, what changed; pure), `sync.js` (line and word at a position), `layout.js` (word-by-word layout), `view.js` (screen), `recorder.js` (5 s takes, the fallback), `prefs.js` |
| `server/lezepplean/` | `app.py` (API), `recognize.py` (ShazamIO), `lyrics.py` (LRCLIB), `songs.py` (per-song store on disk), `prepare.py` (what gets computed, in what order), `worker.py` (the CPU steps, in a separate low-priority process), `reference.py` (the song's own audio from YouTube, mapped onto Shazam's timeline), `track.py` (fast re-sync), `silk.py` (loudness reader + the song's loudness track), `audio.py`, `zepp_opus.py` |
| `server/lezepplean/align/` | Word timing: `text.py` (lyrics → letters), `separate.py` (Spleeter vocals, ONNX), `ctc.py` (wav2vec 2.0 letter probabilities, ONNX int8), `forced.py` (banded CTC forced alignment), `__init__.py` (`align_lyrics`, measured settings) |
| `server/scripts/` | `fake_watch.py` (send a clip like the phone does), `eval_align.py` / `eval_track.py` (benchmarks), `watch_sim.py` + `sim_stream.py` (what the watch would record), `silk_levels.py` |
| `tests/watch/` | Node tests for the watch's pure logic |
| `tests/sim/simulate.mjs` | Replays a simulated listening session through the real session logic against a running server, in simulated time, and measures what the person would see |
| `tests/render/` | A `@zos/ui` stand-in that records widgets, so `view.js` screens can be drawn (Pillow) and looked at |
| `tools/` | `serve.sh` (server, tunnel and keep-awake), `install-watch.sh` (sign-in, build, install QR), `qr-hook.cjs` |
| `charts/lezepplean/`, `.github/workflows/docker.yml` | The server's Helm chart and its CI (tests, then image + chart to GHCR), in texas-fold-em's shape |
| `docs/research/` | Platform research (6 detailed reports plus a summary) |

Keep `watch-app/` self-contained. `zeus build` compiles every `.js` file in it, and production builds embed every non-dot file into the uploaded package (`.ip-package`, which ignores `.gitignore`). That is why watch tests and tools live outside it. Local imports inside `watch-app/` carry the `.js` extension, so Node can load the same files the watch runs.

## Production

The server runs on the homelab: **https://lezepplean.taptappers.club** (DNS in `oh-my-dns`, `A lezepplean`), deployed by `homelab.setup/kubernetes/apps/lezepplean` from the image `ghcr.io/rounakdatta/le-zepp-lean` and the chart `oci://ghcr.io/rounakdatta/charts/lezepplean`. The bearer token is the Bitwarden item `lezepplean/token` (and `pass api-keys/lezepplean/token`); `tools/install-watch.sh` builds the watch app against it unless a local tunnel is running.

Releasing: bump `charts/lezepplean/Chart.yaml` `version` + `appVersion` and `values.yaml` `image.tag` together, merge to `main`, push an annotated tag `vX.Y.Z` (CI: tests, then image + chart at that version), then bump `homelab.setup` (kustomization `version`, values `image.tag`, re-render the vendored chart, `charts.lock`) and deploy that branch with `deploy-stuff.yml` before merging it. The pod is pinned to the control plane, takes no CPU request (the node's requests are full; its usage isn't), and its `/data` volume is left out of Velero's nightly backup: everything on it can be rebuilt.

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
watch: mic ─► one continuous recording, read every 100 ms (live.js)
             └─ every 60 ms packet: loudness from the SILK gain index (silk.js)
                  ├─ activity.js: stopped? back? (+ the song's loudness track: quiet passage or pause?)
                  ├─ clock.js: pause/resume the song clock *on the packet it happened*
                  └─ session.js: is the room still the song? when to ask the server, and what
       short windows (5 s find, 3 s re-sync, 2 s after a resume) ─BLE─► phone ─► server
server: known song + its audio on disk?  track.py: place the window near the clock's guess (~30 ms)
        otherwise:                       Shazam (~0.5 s) → song + LRCLIB lyrics → start preparing
        preparing (prepare.py → worker.py, once per song, kept on disk):
          YouTube audio → Shazam-checked + mapped → loudness track + re-sync features
          → Spleeter vocals → wav2vec 2.0 letters → forced alignment → word timings
          (the next 30 s first, then the next 45 s, then the whole song)
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

**Recorder** (`@zos/media`, `create(id.RECORDER)`)
- Requires the undocumented permission `device:os.mic`; without it the recorder throws PERMISSION DENIED.
- Output is **raw Opus packets in opus_demo framing**: `[4-byte BE length][4-byte final range][packet]`, not Ogg.
- The encoding is **SILK wideband, 16 kHz mono, 60 ms single-frame packets** (TOC config 11, code 0), ~17 kbps, so about 10 KB per 5 s. libopus reproduces exactly this at 16–20 kbps with `application=voip`, `frame_duration=60` (`server/lezepplean/silk.py`).
- Capture starts ~0.33–0.35 s after `start()`: 4680 ms is decoded from a ~5010 ms window. So clip timing is anchored on `stop()` (`sync.clipStartMs`).
- Some firmware lacks the recorder events and `getStatus`, so don't rely on them.
- A take started soon after a `stop()` (or a very short take) can produce a 0-byte file and lock the mic system-wide until reboot (forum #556). Keep takes ≥ 4 s and ≥ 8 s apart, or record continuously.
- **Still unknown, and v0.2 depends on it:** whether the recording file is readable while recording is still running, and in what bursts. `lib/live.js` probes this at runtime (`firstGrowthMs`, `growths`, `probe` go to the server in every request's diagnostics, so `server/captures/*.json` answers it after the first session) and falls back to takes if it isn't.

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
- The phone can't push unless the watch talked first.
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
- Cost per 4-minute song, AMD EPYC, 3 threads: Spleeter ~7 s, wav2vec 2.0 ~26 s. Peak memory ~1 GB in the worker process (Spleeter one block at a time: 940 MB; four at a time: 2 GB).

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

These scenarios are `play/silence/talk/next` scripts for `server/scripts/sim_stream.py`; re-run them after touching `session.js`, `clock.js`, `activity.js` or `track.py`.

## Tooling gotchas

- **Installing Zeus.** zeus-cli 1.9.3 crashes with `Cannot find module 'zeppos-app-utils'` under `npx @zeppos/zeus-cli` or a hoisted install. `watch-app/.npmrc` sets `install-strategy=nested`, which fixes it.
- **Zepp login.** It needs an email + password Zepp account; Google or Apple sign-in doesn't work.
- **Installing on the watch.** `zeus preview` goes through Zepp's cloud and the QR code lasts 7 days. Fallback: Zepp app → Developer Mode → Bridge, then `npx zeus bridge`.
- **Targeting.** Use `platforms: [{ st: 'r', dw: 480 }]`, not `deviceSource`, which breaks the `zosLoader` per-screen layouts.
- **Simulator.** Its T-Rex 3 image is API 4.0 only, with no BLE and a flaky side service, and media is likely unsupported. Test on the watch; for logic, use `tests/sim`.
- **Background tasks.** Claude Code kills them after ~30 min. Long-running servers belong in the user's own terminal (`tools/serve.sh`).
- **Tunnel URLs.** A quick tunnel's URL changes on every start. `install-watch.sh` reads it from cloudflared's metrics endpoint (`127.0.0.1:20241/quicktunnel`) and bakes it, with the token, into `app-side/defaults.js` for that build only; the file is restored afterwards. A LAN URL typed into the Zepp settings survives tunnel restarts.
- **Telemetry.** The Zeus CLI sends telemetry on every command.

## Decisions

| Decision | Why |
|---|---|
| Music from speakers nearby, phone is Android | The user's choice. Earbud audio can't be heard by the watch mic, so a Spotify mode would be a separate feature |
| ShazamIO; the server on the homelab (`charts/lezepplean`), the Mac only for working on it (`tools/serve.sh`) | The user's choice |
| One continuous recording, read while written; takes only as a fallback | Takes leave 8 s gaps (mic-lock bug), so a pause could go unnoticed for 13 s |
| Pause/resume decided on the watch from the SILK gain, backdated to the packet | No round trip: the lyrics stop within ~0.6 s and on the right word; a resume is confirmed by the server after 2 s of music |
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
| Fast re-sync on the song's own audio, Shazam as fallback | ~30 ms instead of ~500 ms, works on 2 s, and is more consistent than Shazam on room audio |
| Display timing: a line appears 300 ms early, a word lights 40 ms early, timers at exact change times | Reading ahead; drawing time |

## Status

**v0.2 is built and tested off the watch:** continuous listening with takes as fallback; word-by-word karaoke; pauses, resumes, skips and next songs followed; word timings computed on the server (CPU only); fast re-sync; the `known` handshake. 71 Node tests, 65 server tests, the JamendoLyrics benchmark, and the session simulator above. Four rounds of independent review found 12 bugs (and 6 risks), then 8, 3 and 1 more in the previous round's fixes, that the green suites had missed; a fifth round found nothing. All but one now have a test that failed before its fix; the exception (takes mode anchoring an answer on the wrong take) is in `page/home/index.js`, which Node can't load, and was fixed by reading.

**Needs the watch (none of this could be measured here):**
1. Whether `live.js` sees the file grow while recording (check `client.firstGrowthMs` / `client.mode` in `server/captures/*.json`). If it doesn't, everything works in takes mode, with pauses noticed at the next take.
2. The recorder's real flush cadence (the simulator assumed 240 ms) and the BLE throughput (it assumed 4 KB/s + 700 ms).
3. Pause thresholds and the loudness-track comparison in real rooms. `node --test` on the Mac runs the local-only tests against `server/captures/`; they skip elsewhere.
4. 24 word widgets and `getTextLayout` speed on the device; the layout cache and next-line preparation are there in case.
5. The watch font's real widths (the screens in `tests/render` use Liberation Sans).

## Conventions

- **Watch tests** live in `tests/` (Node, ESM, no Zepp APIs); keep logic pure so it can be tested there. `session.js` takes time as an argument for the same reason.
- **Server tests** are in `server/tests/`, run with `uv run pytest`. Nothing in them touches the network.
- **Commits** never include `server/.token`, `server/captures/`, `server/data/`, `server/models/`, caches or build output; they are git-ignored.
- **Research before building.** Check the minimum API_LEVEL of any Zepp OS API before using it. The docs source is `github.com/zepp-health/zeppos-docs`; clone and grep it. Community answers are at `github.com/orgs/zepp-health/discussions`.
- **Measure before tuning.** Thresholds in this repo cite what they were measured on; when changing one, re-run the benchmark or simulator it came from and update the numbers.
