"""Pretend to be the watch: cut a clip from any audio file, encode it the way the Zepp
recorder does (SILK wideband, 60 ms packets), and POST it to the server exactly like the
phone-side service will.

    uv run python scripts/fake_watch.py song.m4a --start 42 --seconds 5
    uv run python scripts/fake_watch.py song.m4a --start 80 --seconds 3 --purpose sync --song <id> --expect 80000
    uv run python scripts/fake_watch.py clip.zepp.opus          # replay a real watch capture
    uv run python scripts/fake_watch.py --lyrics <song id>      # what the watch's word poll gets
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
from pathlib import Path

import httpx
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lezepplean import silk, zepp_opus  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", nargs="?", help="audio file/URL, or a .zepp.opus capture to replay")
    ap.add_argument("--start", type=float, default=0.0, help="clip start within the file, seconds")
    ap.add_argument("--seconds", type=float, default=5.0)
    ap.add_argument("--server", default="http://127.0.0.1:8787")
    ap.add_argument("--token")
    ap.add_argument("--purpose", default="find", choices=["find", "sync", "resume"])
    ap.add_argument("--song", help="the song the watch is following")
    ap.add_argument("--expect", type=float, help="where the watch thinks the clip starts, ms")
    ap.add_argument("--known-lyrics")
    ap.add_argument("--room", action="store_true", help="play it through the simulated room first")
    ap.add_argument("--lyrics", metavar="SONG", help="ask for a song's lyrics instead of identifying")
    args = ap.parse_args()
    headers = {"Authorization": f"Bearer {args.token}"} if args.token else {}

    if args.lyrics:
        r = httpx.post(args.server + "/lyrics", json={"song": args.lyrics, "known": None}, headers=headers, timeout=30)
        out = r.json()
        lines = (out.get("lyrics") or {}).get("lines") or []
        print(json.dumps({k: v for k, v in out.items() if k not in ("lyrics", "envelope")}, indent=1, ensure_ascii=False))
        print(f"{len(lines)} lines, {sum(1 for l in lines if l[2])} with word timings; envelope: {bool(out.get('envelope'))}")
        for l in lines[:6]:
            print("  ", l)
        return

    if args.audio.endswith(".zepp.opus"):
        framed = Path(args.audio).read_bytes()
    else:
        pcm = zepp_opus.load_audio_as_pcm(args.audio, args.start, args.seconds)
        x = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768
        if args.room:
            from watch_sim import room
            x = room(x)
        framed = b"".join(len(p).to_bytes(4, "big") + b"\0\0\0\0" + p for p in silk.encode_like_watch(x))

    body = {"audio": base64.b64encode(framed).decode(), "clipMs": round(args.seconds * 1000), "purpose": args.purpose,
            "song": args.song, "expectMs": args.expect, "known": {"lyrics": args.known_lyrics} if args.known_lyrics else None,
            "client": {"source": "fake_watch", "fileStart": args.start}}
    t = time.perf_counter()
    r = httpx.post(args.server + "/identify", json=body, headers=headers, timeout=30)
    elapsed = (time.perf_counter() - t) * 1000
    r.raise_for_status()
    out = r.json()
    lines = (out.get("lyrics") or {}).get("lines") or []
    print(json.dumps({k: v for k, v in out.items() if k not in ("lyrics", "envelope", "track")}, indent=1, ensure_ascii=False))
    print(f"lyrics: {(out.get('lyrics') or {}).get('kind')} with {len(lines)} lines "
          f"({sum(1 for l in lines if l[2])} word-timed); envelope sent: {bool(out.get('envelope'))}; round trip {elapsed:.0f} ms")
    if out.get("ok") and lines:
        pos = out["match"]["offsetMs"]
        current = [l for l in lines if l[0] <= pos]
        upcoming = [l for l in lines if l[0] > pos][:2]
        print(f"at clip start (song {pos / 1000:.2f}s): current={current[-1] if current else None} next={upcoming}")


if __name__ == "__main__":
    main()
