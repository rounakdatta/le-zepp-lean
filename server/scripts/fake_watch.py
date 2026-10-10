"""Pretend to be the watch: cut a clip from any audio file, encode it the way the Zepp
recorder does, and POST it to the server exactly like the phone-side service will.

    uv run python scripts/fake_watch.py song.m4a --start 42 --seconds 5
    uv run python scripts/fake_watch.py clip.zepp.opus          # replay a real watch capture
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lezepplean import zepp_opus  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", help="audio file/URL, or a .zepp.opus capture to replay")
    ap.add_argument("--start", type=float, default=0.0, help="clip start within the file, seconds")
    ap.add_argument("--seconds", type=float, default=5.0)
    ap.add_argument("--server", default="http://127.0.0.1:8787")
    ap.add_argument("--token")
    args = ap.parse_args()

    if args.audio.endswith(".zepp.opus"):
        framed = Path(args.audio).read_bytes()
    else:
        framed = zepp_opus.encode(zepp_opus.load_audio_as_pcm(args.audio, args.start, args.seconds))

    body = {"audio": base64.b64encode(framed).decode(), "clipMs": round(args.seconds * 1000),
            "client": {"source": "fake_watch", "fileStart": args.start}}
    headers = {"Authorization": f"Bearer {args.token}"} if args.token else {}
    t = time.perf_counter()
    r = httpx.post(args.server + "/identify", json=body, headers=headers, timeout=30)
    elapsed = (time.perf_counter() - t) * 1000
    r.raise_for_status()
    out = r.json()
    lines = (out.get("lyrics") or {}).get("lines") or []
    print(json.dumps({k: v for k, v in out.items() if k != "lyrics"}, indent=1, ensure_ascii=False))
    print(f"lyrics: {(out.get('lyrics') or {}).get('kind')} with {len(lines)} lines; round trip {elapsed:.0f} ms")
    if out.get("ok") and lines:
        pos = out["match"]["offsetMs"]
        current = [l for l in lines if l[0] <= pos]
        upcoming = [l for l in lines if l[0] > pos][:2]
        print(f"at clip start (song {pos / 1000:.2f}s): current={current[-1] if current else None} next={upcoming}")


if __name__ == "__main__":
    main()
