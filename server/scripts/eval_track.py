"""How well fast re-sync places watch-like audio inside the right song, and how rarely it
believes audio from the wrong one. Uses JamendoLyrics songs and the simulated room+codec.

    uv run python scripts/eval_track.py --jamendo /path/to/jamendolyrics
"""
from __future__ import annotations

import argparse
import csv
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lezepplean import audio as aio  # noqa: E402
from lezepplean import track  # noqa: E402
from watch_sim import room, watch_codec  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--jamendo", type=Path, required=True)
    ap.add_argument("--songs", type=int, default=8)
    ap.add_argument("--windows", type=int, default=25)
    ap.add_argument("--speed", type=float, default=1.0, help="playback speed of the room copy")
    args = ap.parse_args()
    rows = [r for r in csv.DictReader(open(args.jamendo / "JamendoLyrics.csv")) if r["Language"] == "English"][: args.songs]
    rng = np.random.default_rng(1)
    songs = []
    for r in rows:
        clean = aio.load(str(args.jamendo / "mp3" / r["Filepath"]), 16_000, 1)[0]
        played = clean
        if args.speed != 1.0:
            src = np.arange(0, len(clean) - 1, args.speed)
            played = np.interp(src, np.arange(len(clean)), clean).astype(np.float32)
        heard = watch_codec(room(played, rt60=rng.uniform(0.3, 0.7), level_db=rng.uniform(-32, -22), seed=int(rng.integers(1e6))))
        songs.append((r["Filepath"][:30], track.features(clean), heard))
    for seconds in (2.0, 3.0):
        n = int(seconds * 16_000)
        pos_err, pos_score, pos_margin, neg_score, neg_margin, times = [], [], [], [], [], []
        for si, (name, ref, heard) in enumerate(songs):
            for _ in range(args.windows):
                start = rng.uniform(10, len(heard) / 16_000 - 15)
                win = heard[int(start * 16_000): int(start * 16_000) + n]
                true_ms = start * 1000 * args.speed
                guess = true_ms + rng.normal(0, 300)
                t = time.perf_counter()
                got = track.locate(win, ref, guess)
                times.append(time.perf_counter() - t)
                pos_err.append(abs(got.offset_ms - true_ms))
                pos_score.append(got.score)
                pos_margin.append(got.margin)
                other = songs[(si + 1) % len(songs)][1]
                bad = track.locate(win, other, rng.uniform(5_000, len(other) * 10 - 10_000))
                neg_score.append(bad.score)
                neg_margin.append(bad.margin)
        e = np.array(pos_err)
        print(f"{seconds:.0f} s windows: |error| median {np.median(e):.1f} ms, p90 {np.percentile(e, 90):.1f}, "
              f"<30 ms {np.mean(e < 30) * 100:.0f}%, >300 ms {np.mean(e > 300) * 100:.1f}%  | {np.mean(times) * 1000:.1f} ms per locate")
        ps, pm, ns, nm = map(np.array, (pos_score, pos_margin, neg_score, neg_margin))
        print(f"   right song: score p5 {np.percentile(ps, 5):.3f} median {np.median(ps):.3f}; margin p5 {np.percentile(pm, 5):.3f}")
        print(f"   wrong song: score p95 {np.percentile(ns, 95):.3f} max {ns.max():.3f}; margin p95 {np.percentile(nm, 95):.3f} max {nm.max():.3f}")
        for thr_s, thr_m in ((0.15, 0.03), (0.2, 0.04), (0.25, 0.05), (0.3, 0.06)):
            ok_pos = np.mean((ps >= thr_s) & (pm >= thr_m) & (e < 300))
            ok_neg = np.mean((ns >= thr_s) & (nm >= thr_m))
            print(f"   accept score>={thr_s} margin>={thr_m}: right song accepted {ok_pos * 100:.1f}%, wrong song accepted {ok_neg * 100:.1f}%")


if __name__ == "__main__":
    main()
