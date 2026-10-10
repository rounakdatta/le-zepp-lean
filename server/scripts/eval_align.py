"""Measure the word aligner against hand-made word timings (JamendoLyrics, English).

JamendoLyrics is the standard lyrics-alignment benchmark: Creative Commons songs with
every word's start marked by hand (github.com/f90/jamendolyrics, 20 English songs). We
play the part of LRCLIB by giving the aligner each line's true start plus random error,
then score the word starts it returns.

    uv run python scripts/eval_align.py --jamendo /path/to/jamendolyrics [--jitter-ms 250]

Prints, per song and overall: mean absolute error of word starts, and the share of words
within 100/200/300 ms. "prior" is the no-audio baseline (syllable-proportional spacing
from the line start), which is what you would get without the acoustic model.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lezepplean import zepp_opus  # noqa: E402
from lezepplean.align import align_lyrics, prior_words  # noqa: E402
from lezepplean.align.ctc import CtcModel  # noqa: E402


def load_song(root: Path, filepath: str):
    stem = filepath.removesuffix(".mp3")
    words = [(float(r["word_start"]), float(r["word_end"])) for r in csv.DictReader(open(root / "annotations/words" / f"{stem}.csv"))]
    lines = [(float(r["start_time"]), float(r["end_time"]), r["lyrics_line"]) for r in csv.DictReader(open(root / "annotations/lines" / f"{stem}.csv"))]
    return stem, words, lines


def score(errors_ms: list[float]) -> dict:
    a = np.abs(np.array(errors_ms))
    if not len(a):
        return {}
    return {"n": len(a), "mae": round(float(a.mean())), "median": round(float(np.median(a))),
            "<100": round(float((a < 100).mean()) * 100, 1), "<200": round(float((a < 200).mean()) * 100, 1),
            "<300": round(float((a < 300).mean()) * 100, 1), "bias": round(float(np.mean(errors_ms)))}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--jamendo", type=Path, required=True)
    ap.add_argument("--language", default="English")
    ap.add_argument("--jitter-ms", type=float, default=250, help="std-dev of the simulated LRC line-start error")
    ap.add_argument("--lead-ms", type=float, default=100, help="LRC lines tend to start this much early")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--cache", type=Path, default=Path("/tmp/lzl-emissions"))
    ap.add_argument("--songs", type=int, default=0)
    ap.add_argument("--bias-ms", type=int, default=None)
    ap.add_argument("--min-confidence", type=float, default=0.0, help="score every line (0) or only confident ones")
    ap.add_argument("--slack", default=None, help="before,after in ms")
    ap.add_argument("--json", type=Path)
    ap.add_argument("--dump", type=Path, help="per-line CSV for error analysis")
    ap.add_argument("--separate", action="store_true", help="align on Spleeter vocals instead of the mix")
    ap.add_argument("--only", default="", help="comma-separated substrings of song names")
    ap.add_argument("--gap-cost", type=float, default=None)
    ap.add_argument("--no-separators", action="store_true")
    args = ap.parse_args()

    rows = [r for r in csv.DictReader(open(args.jamendo / "JamendoLyrics.csv")) if r["Language"] == args.language]
    if args.songs:
        rows = rows[: args.songs]
    if args.only:
        rows = [r for r in rows if any(o in r["Filepath"] for o in args.only.split(","))]
    separator = None
    rng = random.Random(args.seed)
    model = None
    args.cache.mkdir(parents=True, exist_ok=True)
    kw = {}
    if args.bias_ms is not None:
        kw["bias_ms"] = args.bias_ms
    if args.slack:
        kw["slack"] = tuple(int(x) for x in args.slack.split(","))
    kw["min_confidence"] = args.min_confidence
    if args.gap_cost is not None:
        kw["gap_cost"] = args.gap_cost
    if args.no_separators:
        kw["separators"] = False

    all_ctc, all_prior, report, dump = [], [], [], []
    model_s = align_s = audio_s = 0.0
    for r in rows:
        stem, gt_words, gt_lines = load_song(args.jamendo, r["Filepath"])
        cache = args.cache / f"{stem}.npz"
        if cache.exists():
            em = np.load(cache)
            from lezepplean.align.ctc import Emissions
            meta = json.loads(str(em["meta"]))
            emissions = Emissions(em["lp"], meta["blank"], meta["sep"], meta["letters"], meta["seconds"])
        else:
            if model is None:
                model = CtcModel(threads=args.threads)
            path = str(args.jamendo / "mp3" / r["Filepath"])
            if args.separate:
                from lezepplean import audio as audio_io
                from lezepplean.align.separate import Separator, SAMPLE_RATE as SEP_RATE
                if separator is None:
                    separator = Separator(threads=args.threads)
                vocals = separator.vocals(audio_io.load(path, SEP_RATE, 2))
                audio = audio_io.resample(vocals, SEP_RATE, 16_000)
            else:
                pcm = zepp_opus.load_audio_as_pcm(path)
                audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768
            emissions = model.emissions(audio)
            np.savez(cache, lp=emissions.log_probs, meta=json.dumps({"blank": emissions.blank, "sep": emissions.separator,
                                                                     "letters": emissions.letters, "seconds": emissions.seconds}))
        model_s += emissions.seconds
        audio_s += emissions.frames * 0.02

        # Simulated LRC: each line's true start, early by lead-ms on average, plus noise.
        lrc = []
        for start, _end, text in gt_lines:
            err = -args.lead_ms + rng.gauss(0, args.jitter_ms)
            lrc.append((max(0, int(start * 1000 + err)), text))
        order = sorted(range(len(lrc)), key=lambda i: lrc[i][0])
        lrc_sorted = [lrc[i] for i in order]
        t = time.perf_counter()
        result = align_lyrics(np.zeros(0, np.float32), lrc_sorted, emissions=emissions, **kw)
        align_s += time.perf_counter() - t

        # Map back to annotation order and compare word starts.
        n_words = [len(text.split()) for _, _, text in gt_lines]
        offsets = np.cumsum([0] + n_words)
        assert offsets[-1] == len(gt_words), f"{stem}: {offsets[-1]} words in lines vs {len(gt_words)} annotated"
        song_ctc, song_prior = [], []
        for pos, li in enumerate(order):
            line = result.lines[pos]
            truth = [gt_words[offsets[li] + k][0] * 1000 for k in range(n_words[li])]
            nxt = lrc_sorted[pos + 1][0] if pos + 1 < len(lrc_sorted) else line.lrc_ms + 8000
            prior = prior_words(line.lrc_ms, nxt, line.text)
            song_prior += [p - g for p, g in zip(prior, truth)]
            words = line.words if line.words is not None else prior
            song_ctc += [p - g for p, g in zip(words, truth)]
            errs = [abs(p - g) for p, g in zip(words, truth)]
            dump.append({"song": stem, "line": li, "words": len(truth), "conf": line.confidence, "method": line.method,
                         "lrc_err": line.lrc_ms - truth[0] if truth else 0, "first_err": (words[0] - truth[0]) if truth else 0,
                         "mae": round(float(np.mean(errs))) if errs else 0, "max": round(max(errs)) if errs else 0,
                         "dur_pred": (line.end_ms - line.start_ms) if line.end_ms else None,
                         "dur_true": round(gt_words[offsets[li] + n_words[li] - 1][1] * 1000 - truth[0]) if truth else 0,
                         "window": nxt - line.lrc_ms, "text": line.text})
        all_ctc += song_ctc
        all_prior += song_prior
        s1, s2 = score(song_ctc), score(song_prior)
        report.append({"song": stem, "ctc": s1, "prior": s2, "aligned": f"{result.aligned_lines}/{len(result.lines)}"})
        print(f"{stem[:38]:38} ctc mae {s1['mae']:5} <300 {s1['<300']:5}%  | prior mae {s2['mae']:5} <300 {s2['<300']:5}%  lines {result.aligned_lines}/{len(result.lines)}", flush=True)

    total_ctc, total_prior = score(all_ctc), score(all_prior)
    print("\nALL ctc  ", total_ctc)
    print("ALL prior", total_prior)
    if separator is not None:
        print(f"separation {separator.seconds:.1f}s")
    print(f"model {model_s:.1f}s for {audio_s / 60:.1f} min of audio ({model_s / max(audio_s, 1e-9):.3f} x real time); alignment {align_s:.1f}s")
    if args.dump:
        with open(args.dump, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(dump[0].keys()))
            w.writeheader()
            w.writerows(dump)
    if args.json:
        args.json.write_text(json.dumps({"args": {k: str(v) for k, v in vars(args).items()}, "ctc": total_ctc, "prior": total_prior, "songs": report}, indent=1))


if __name__ == "__main__":
    main()
