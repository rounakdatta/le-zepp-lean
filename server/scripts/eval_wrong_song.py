"""Does fast re-sync place room audio where it belongs, and only there? Clips of each song, as
the watch hears it in a room, are placed inside that song (the clock ~300 ms off) and inside
the other songs (it must refuse). Three kinds of clip: plain music, music that comes in after
a quiet start (a take where the music came back, or a new song began), and music with a knock
in it. The server's own `_locate` decides.

    uv run python scripts/eval_wrong_song.py --data /path/to/data          # a server's data dir
    uv run python scripts/eval_wrong_song.py --data /path/to/data --level-only   # before 0.3.3

Songs need features.npy, reference.m4a and a reference map (prepared by the server). Songs
whose titles share their first 8 characters (a song and its remix) are never compared.
"""
from __future__ import annotations

import argparse
import importlib
import os
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lezepplean import audio as aio  # noqa: E402
from watch_sim import room, watch_codec  # noqa: E402

SR = 16_000
KINDS = ("plain", "quiet-start", "knock")
LEVELS = (-55, -50, -45, -40, -30)


def clip(heard: np.ndarray, kind: str, seconds: float, level: float, rng: np.random.Generator) -> tuple[np.ndarray, float]:
    start = rng.uniform(5, len(heard) / SR - 10)
    win = heard[int(start * SR): int((start + seconds) * SR)].copy()
    if kind == "quiet-start":
        q = int(rng.uniform(0.3, 1.0) * SR)
        win[:q] = watch_codec(room(np.zeros(q + 4000, np.float32), level_db=level, seed=int(rng.integers(1e6))))[:q]
    elif kind == "knock":
        at, n = int(rng.uniform(0.2, seconds - 0.3) * SR), int(0.15 * SR)
        win[at: at + n] += (rng.standard_normal(n) * 10 ** ((level + 25) / 20) * np.hanning(n)).astype(np.float32)
    return win, start


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True, help="a server data dir (holding songs/)")
    ap.add_argument("--clips", type=int, default=12, help="per song pair, kind and level")
    ap.add_argument("--level-only", action="store_true", help="each band's level alone decides (before 0.3.3)")
    args = ap.parse_args()
    os.environ["LEZEPPLEAN_DATA"] = str(args.data)
    os.environ["LEZEPPLEAN_CAPTURES"] = tempfile.mkdtemp()
    from lezepplean import app
    app = importlib.reload(app)
    if args.level_only:
        app.TRACK_SHAPE_AGREE = -2.0
        app.TRACK_SHAPE_MIN_SCORE = 9.0
    songs = []
    for d in sorted((args.data / "songs").iterdir()):
        song = app._store.get(d.name)
        if song and song.reference and (d / "features.npy").exists() and (d / song.reference["file"]).exists():
            songs.append((song, aio.load(str(d / song.reference["file"]), SR, 1)[0]))
    print(f"{len(songs)} songs: " + ", ".join(s.title for s, _ in songs))
    rng = np.random.default_rng(11)
    wrong = defaultdict(lambda: [0, 0])
    right = defaultdict(lambda: [0, 0, 0])  # placed right, placed wrong, clips
    for level in LEVELS:
        for x, clean in songs:
            heard = watch_codec(room(clean, rt60=rng.uniform(0.3, 0.7), level_db=level, seed=int(rng.integers(1e6))))
            m = app.Mapping.from_dict(x.reference["map"])
            for y, _ in songs:
                if y.id != x.id and y.title[:8] == x.title[:8]:
                    continue
                for k in range(args.clips * len(KINDS)):
                    kind = KINDS[k % len(KINDS)]
                    win, start = clip(heard, kind, float(rng.choice([2.0, 2.7, 3.2])), level, rng)
                    pcm = (np.clip(win, -1, 1) * 32767).astype(np.int16).tobytes()
                    if y.id == x.id:
                        true_ms = m.to_canonical(start * 1000)
                        got = app._locate(y, pcm, true_ms + rng.normal(0, 300), True)
                        r = right[(kind, level)]
                        r[2] += 1
                        if got is not None:
                            r[0 if abs(got["offsetMs"] - true_ms) < 150 else 1] += 1
                    else:
                        my = app.Mapping.from_dict(y.reference["map"])
                        got = app._locate(y, pcm, rng.uniform(5000, my.to_canonical(len(app._store.features(y.id)) * 10 - 10000)), True)
                        w = wrong[kind]
                        w[1] += 1
                        w[0] += got is not None
        print(f"  {level} dB done", flush=True)
    print("another song placed: " + "  ".join(f"{k} {wrong[k][0]}/{wrong[k][1]}" for k in KINDS))
    for kind in KINDS:
        cells = []
        for level in LEVELS:
            ok, bad, n = right[(kind, level)]
            cells.append(f"{level} dB {ok}/{n}" + (f" (WRONG PLACE {bad})" if bad else ""))
        print(f"its own song, {kind:11s}: " + "  ".join(cells))


if __name__ == "__main__":
    main()
