# LeZeppLean server

It receives short recordings from the watch (through the phone), says which song they are and exactly where in it they started, and sends lyrics timed word by word.

```sh
cd server
./run.sh        # port 8787 on all interfaces; requires the token in .token if that file exists
./tunnel.sh     # optional: temporary public HTTPS URL (Cloudflare quick tunnel via nix, no account)
uv run pytest   # unit tests (no network)
```

The first `./run.sh` needs `uv`, which creates `.venv` from `pyproject.toml`. Two models download on first use (~170 MB, into `models/`). yt-dlp needs Node or Deno on the PATH.

## How it works

1. **Decode.** The Zepp recorder writes raw Opus packets in `opus_demo` framing: a 4-byte length, a 4-byte final range, then the packet. The audio is 16 kHz mono SILK. `lezepplean/zepp_opus.py` decodes it with the libopus bundled in PyAV.
2. **Place the recording.**
   - When the watch is following a song whose audio the server already has, `track.py` compares the recording with that audio: near where the watch's clock says it should be, and across the whole song in case the music was skipped. This takes ~30 ms and works with 2 s of audio.
   - Otherwise, or when that isn't convincing, `recognize.py` asks ShazamIO. Its `offset` is the song position where the recording starts. It is an unofficial client for Shazam's private API, against Shazam's terms, and lives behind one small class so it can be swapped for ACRCloud.
3. **Lyrics.** `lyrics.py` gets the track's exact length from Apple's catalogue, using the Apple Music ID Shazam returns, and asks LRCLIB for synced lyrics of that length, so a remix or radio edit never gets another version's timings. If that fails, it searches LRCLIB and keeps only candidates within 3 s of the length.
4. **Prepare the song** (once, in the background; `prepare.py` decides the order, `worker.py` does the CPU work in a separate low-priority process):
   1. `reference.py` finds the recording on YouTube (yt-dlp; same length within 3 s, no live takes or covers), downloads its audio, and has Shazam check five cuts of it. The cuts must name the same track, and their offsets give a straight-line map from this copy onto Shazam's timeline (copies differ by hundreds of ms; a remaster can even differ in speed).
   2. From that audio: the features fast re-sync compares against, and the **loudness track**: the gain the watch's recorder would read every 60 ms, which the watch uses to tell a quiet passage from a pause and to notice skips.
   3. **Word timings** (`align/`): Spleeter separates the vocals, wav2vec 2.0 gives letter probabilities every 20 ms, and a forced alignment held inside each LRC line's window finds when every word starts. The lines about to be sung go first. On the JamendoLyrics benchmark, 90% of word starts land within 300 ms of the hand-marked ones (76% within 100 ms); lines the aligner isn't sure about are sent without word timings.

Everything about a song is saved in `data/songs/<id>/`, so it is prepared once. Only definite outcomes are saved as such: an LRCLIB timeout, a YouTube 403, Shazam trouble or a killed worker leave the song "pending" and are retried (lyrics after 2 minutes; the reference after 5 minutes, doubling to 6 hours; a recording that isn't on YouTube after a week).

## API

`POST /identify` with `Authorization: Bearer <token>` if a token is set.

```json
{ "audio": "<base64 of the watch's recording>", "clipMs": 3000, "client": { "...": "watch diagnostics" },
  "purpose": "find | sync | resume | check", "song": "<id the watch is following>", "expectMs": 81000,
  "known": { "lyrics": "<version the watch has>", "envelope": "<version>" } }
```

Response on a match:

```json
{
  "ok": true,
  "song":   { "id": "41264647", "title": "Wonderwall", "artist": "Oasis", "album": "...", "durationMs": 258907 },
  "match":  { "offsetMs": 79884.4, "skew": 0.00005, "method": "track", "score": 0.65 },
  "lyrics": { "version": "a1b2c3d4e5", "kind": "synced",
              "lines": [[22406, "Today is gonna be the day ...", [22406, 23366, 23506], 26326], [40270, "", null, null]] },
  "envelope": { "version": "...", "startMs": -425.2, "stepMs": 60.0034, "data": "ABCD..." },
  "words":  { "status": "pending | ready | unavailable", "aligned": 30, "of": 45, "etaMs": 9000 },
  "sync":   { "fast": true },
  "clip":   { "bytes": 6250, "packets": 50, "ms": 3000, "peakDb": -12.0, "rmsDb": -31.0 },
  "timing": { "decodeMs": 14, "trackMs": 20, "totalMs": 34 }
}
```

- `lines`: `[startMs, text, wordStarts | null, endMs | null]`. Words split like Python's `str.split()`, which the watch matches. `null` word starts: show that line whole.
- `lyrics` and `envelope` are left out when `known` already has their version.
- `match.method`: `shazam`, `track` (near the watch's guess) or `track-wide` (elsewhere in the song: a skip).
- `envelope.data`: one character per 60 ms packet (base64url alphabet, value 0–63 = SILK gain index), mapped onto the watch's timeline by `startMs` and `stepMs`.
- `sync.fast`: the server has this song's audio, so 2–3 s windows can be placed; when false the watch sends 5 s (enough for Shazam).

When something fails: `{"ok": false, "reason": "no_match" | "bad_audio" | "recognizer_timeout" | "recognizer_error"}`.

`POST /lyrics` with `{"song": "<id>", "known": {...}}` returns the same `song`, `lyrics`, `envelope` and `words` fields, with no audio. The watch uses it to collect word timings when `words.etaMs` says they should be ready.

The other endpoints:

- `GET /health` is the connectivity check behind the settings screen's "Test connection".
- `GET /recent` shows the last 30 requests.
- `GET /songs` and `GET /songs/{id}` show what the server knows: reference, timeline map, words status, notes on what failed.

## Configuration

| Variable | Default | |
|---|---|---|
| `LEZEPPLEAN_TOKEN` | (none) | require `Authorization: Bearer <token>` |
| `LEZEPPLEAN_DATA` | `data/` | song store (`songs/<id>/`) |
| `LEZEPPLEAN_MODELS` | `models/` | downloaded models |
| `LEZEPPLEAN_THREADS` | `2` | threads for separation and the acoustic model (the worker also runs at nice 10) |
| `LEZEPPLEAN_CAPTURES` | `captures/` | where requests are saved |
| `LEZEPPLEAN_KEEP_CAPTURES` | `50` | how many; `0` saves none |
| `LEZEPPLEAN_CAPTURE_AUDIO` | `1` | `0` keeps only the JSON summaries (the audio is the user's room) |

## Deploying

The homelab runs it: `https://lezepplean.taptappers.club`, from `homelab.setup/kubernetes/apps/lezepplean` (values, ingress), with the token synced from the Bitwarden item `lezepplean/token` into the `lezepplean-credentials` Secret. The repo publishes what that pins:

- `.github/workflows/docker.yml` runs the tests, then builds `server/Dockerfile` into `ghcr.io/rounakdatta/le-zepp-lean` and packages `charts/lezepplean` to `oci://ghcr.io/rounakdatta/charts`. A `v*` tag publishes both at exactly the chart's version; a push to `main` publishes `<version>+<sha>`.
- To release: bump `charts/lezepplean/Chart.yaml` (`version` and `appVersion`) and `values.yaml` (`image.tag`) together, merge, and push an annotated tag `vX.Y.Z`. Then in `homelab.setup` bump `version` (kustomization) and `image.tag` (values), re-render the vendored chart, regenerate `kubernetes/charts.lock`, and deploy from the branch before merging (see that repo's notes).

**Resources** (AMD EPYC, 2–3 threads): per new 4-minute song about 35 s of CPU (Spleeter ~7 s, wav2vec 2.0 ~26 s) and ~1 GB peak in the worker; nothing for songs already prepared. Requests take ~30 ms (fast re-sync) to ~1 s (Shazam + lyrics). `Dockerfile` builds a CPU-only image (~300 MB of Python packages, no PyTorch).

## Debugging and measuring

- Every request is saved to `captures/` as the raw clip, a `.wav` you can listen to, and a JSON summary with the watch's diagnostics. The last 50 are kept.
- `scripts/fake_watch.py song.m4a --start 42` sends a clip exactly as the phone would (`--room` plays it through a simulated room first; `--purpose sync --song <id> --expect <ms>` tests fast re-sync; `--lyrics <id>` shows what a word poll gets). Pass a `.zepp.opus` file from `captures/` to replay a real watch take.
- `scripts/eval_align.py` and `scripts/eval_track.py` measure word timing and fast re-sync on JamendoLyrics; `scripts/sim_stream.py` with `tests/sim/simulate.mjs` replays whole listening sessions (see the repo's CLAUDE.md for the numbers).
