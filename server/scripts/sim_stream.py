"""Make the packet stream a watch would record during a scripted listening session.

    uv run python scripts/sim_stream.py song.m4a --out /tmp/stream.json \\
        --script "play 50 40, silence 6, play 90 30, play 150 25, silence 5"

Each step is `play <song second> <seconds>` (the song from that position),
`next <song second> <seconds>` (the second song, --song2, from that position),
`silence <seconds>` (the music stopped) or `talk <seconds>` (the music stopped and someone
talks near the watch, about as loud as the music was). Jumping to a different song position between two
plays is a skip. The audio goes through the simulated room (watch_sim.room) and the
watch's codec, and comes out as SILK packets, one per 60 ms, with the true song position
of every packet (null while silent). tests/sim/simulate.mjs replays it through the watch's
session logic against a running server.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lezepplean import audio as aio, silk  # noqa: E402
from watch_sim import room  # noqa: E402

SR = 16_000
PACKET = 960


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("song")
    ap.add_argument("--song2", help="a second song, for `next` steps")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--script", required=True)
    ap.add_argument("--rt60", type=float, default=0.45)
    ap.add_argument("--level-db", type=float, default=-26)
    ap.add_argument("--noise-db", type=float, default=-62)
    ap.add_argument("--talk-db", type=float, default=6, help="talking this much louder than the music (it's closer)")
    ap.add_argument("--speed", type=float, default=1.0, help="playback speed (a turntable 1%% fast: 1.01)")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    songs = [aio.load(args.song, SR, 1)[0]]
    if args.song2:
        songs.append(aio.load(args.song2, SR, 1)[0])
    parts, truth, which, talks = [], [], [], []
    for step in [s.strip() for s in args.script.split(",") if s.strip()]:
        kind, *nums = step.split()
        if kind in ("play", "next"):
            k = 0 if kind == "play" else 1
            x = songs[k]
            start_s, dur_s = float(nums[0]), float(nums[1])
            n = int(round(dur_s * SR / PACKET)) * PACKET
            src = start_s * SR + np.arange(n) * args.speed
            seg = np.interp(src, np.arange(len(x)), x, right=0.0).astype(np.float32)
            parts.append(seg)
            truth += [start_s * 1000 + i * PACKET / SR * 1000 * args.speed for i in range(n // PACKET)]
            which += [k] * (n // PACKET)
        elif kind == "silence":
            n = int(round(float(nums[0]) * SR / PACKET)) * PACKET
            parts.append(np.zeros(n, dtype=np.float32))
            truth += [None] * (n // PACKET)
            which += [None] * (n // PACKET)
        elif kind == "talk":
            n = int(round(float(nums[0]) * SR / PACKET)) * PACKET
            start = sum(len(x) for x in parts)
            parts.append(np.zeros(n, dtype=np.float32))  # the music is off...
            talks.append((start, _talk(n, rng_seed=len(parts))))  # ...and someone near the watch talks
            truth += [None] * (n // PACKET)
            which += [None] * (n // PACKET)
        else:
            raise SystemExit(f"unknown step {step!r}")
    # Truth on the watch's timeline: this file and Shazam's copy of the recording can be a
    # few hundred ms (and a fraction of a percent of speed) apart, exactly as the server's
    # reference can. Map it the same way the server does, or every error is off by that.
    import asyncio
    from lezepplean import reference
    from lezepplean.recognize import Recognizer
    rec = Recognizer()
    ids, maps = [], []
    for x in songs:
        first = asyncio.run(rec.recognize(_wav(x[int(30 * SR): int(36 * SR)])))
        mapping = asyncio.run(reference.measure_mapping(x, rec.recognize, first.shazam_key if first else None, first.title if first else ""))
        if mapping is None:
            raise SystemExit("Shazam doesn't recognise this file well enough to map it")
        ids.append(first.shazam_key)
        maps.append(mapping)
        print(f"{first.title}: file -> Shazam timeline: {mapping.as_dict()}")
    truth = [None if t is None else maps[k].to_canonical(t) for t, k in zip(truth, which)]
    played = np.concatenate(parts)
    heard = room(played, rt60=args.rt60, level_db=args.level_db, noise_db=args.noise_db, seed=args.seed)
    for start, sig in talks:  # close to the watch: barely any room in it, and louder
        heard[start: start + len(sig)] += sig * 10 ** ((args.level_db + args.talk_db) / 20)
    packets = silk.encode_like_watch(heard)
    n = min(len(packets), len(truth))
    args.out.write_text(json.dumps({
        "packetMs": 60,
        "script": args.script,
        "packets": [base64.b64encode(p).decode() for p in packets[:n]],
        "truth": truth[:n],
        "song": [None if k is None else ids[k] for k in which[:n]],
    }))
    print(f"{n} packets ({n * 0.06:.1f} s) -> {args.out}")


def _talk(n: int, rng_seed: int) -> np.ndarray:
    """Speech-like noise: voiced buzz at a wandering pitch, in syllable bursts (~4 a second),
    band-limited like a voice, about as loud as the songs here."""
    rng = np.random.default_rng(rng_seed)
    t = np.arange(n) / SR
    pitch = 120 + 40 * np.sin(2 * np.pi * 0.7 * t + rng.uniform(0, 6))
    phase = 2 * np.pi * np.cumsum(pitch) / SR
    voiced = sum(np.sin(k * phase) / k for k in range(1, 12))
    syllables = np.clip(np.sin(2 * np.pi * 4.2 * t + rng.uniform(0, 6)), 0, None) ** 1.5
    pauses = (rng.uniform(size=int(n / SR * 2) + 2) > 0.25).repeat(SR // 2 + 1)[:n]
    sig = voiced * syllables * pauses + 0.05 * rng.standard_normal(n)
    return (0.9 * sig / (np.abs(sig).max() + 1e-9)).astype(np.float32)


def _wav(x):
    from lezepplean import zepp_opus
    return zepp_opus.pcm_to_wav((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())


if __name__ == "__main__":
    main()
