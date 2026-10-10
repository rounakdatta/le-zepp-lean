# LeZeppLean server

It receives a watch mic clip from the phone and answers with the song, the position in the song where the clip started, and time-synced lyrics.

```sh
cd server
./run.sh        # port 8787 on all interfaces; requires the token in .token if that file exists
./tunnel.sh     # optional: temporary public HTTPS URL (Cloudflare quick tunnel via nix, no account)
uv run pytest   # unit tests
```

The first `./run.sh` needs `uv`, which creates `.venv` from `pyproject.toml`.

## How it works

1. **Decode.** The Zepp recorder writes raw Opus packets in `opus_demo` framing: a 4-byte length, a 4-byte final range, then the packet. The audio is 16 kHz mono. `lezepplean/zepp_opus.py` decodes it with the libopus bundled in PyAV.
2. **Recognize.** `lezepplean/recognize.py` calls ShazamIO.
   - ShazamIO returns `matches[0].offset`, the song position at the start of the clip. Two cuts taken 10.000 s apart came back 9.9997 s apart.
   - ShazamIO is an unofficial client for Shazam's private API. It can break, and using it is against Shazam's terms. It lives behind one small class, so it can be swapped for ACRCloud.
3. **Lyrics.** `lezepplean/lyrics.py` gets the track's exact length from Apple's catalogue, using the Apple Music ID Shazam returns. It then asks LRCLIB for synced lyrics of that length, so a remix or radio edit never gets another version's timings.
   - If that fails, it searches LRCLIB and keeps only candidates within 3 s of the length.

Typical server time is about 1–1.5 s: about 0.5 s for Shazam and 0.5–0.9 s for lyrics, and repeat songs are cached.

## API

`POST /identify` with `Authorization: Bearer <token>` if a token is set.

Request body:

```json
{ "audio": "<base64 of the watch's .opus file>", "clipMs": 5000, "client": { "...": "watch diagnostics" } }
```

Response on a match:

```json
{
  "ok": true,
  "track":  { "title": "...", "artist": "...", "album": "...", "durationMs": 200046 },
  "match":  { "offsetMs": 151052.9, "skew": 0.001 },
  "lyrics": { "kind": "synced", "source": "lrclib", "lines": [[13130, "Yeah"], [16560, ""]] },
  "clip":   { "bytes": 17818, "packets": 251, "ms": 5020, "peakDb": 0.0, "rmsDb": -10.0 },
  "timing": { "decodeMs": 10, "recognizeMs": 450, "lyricsMs": 853, "totalMs": 1313 }
}
```

When something fails, the response is `{"ok": false, "reason": "no_match" | "bad_audio" | "recognizer_timeout" | "recognizer_error"}`.

The other endpoints:

- `GET /health` is the connectivity check behind the settings screen's "Test connection".
- `GET /recent` shows the last 30 requests.

## Debugging

- Every request is saved to `captures/` as the raw clip, a `.wav` you can listen to, and a JSON summary. The last 50 are kept. This is the fastest way to see what the watch actually heard.
- `scripts/fake_watch.py song.m4a --start 42` sends a clip exactly as the phone would. Pass a `.zepp.opus` file from `captures/` to replay a real watch take.
