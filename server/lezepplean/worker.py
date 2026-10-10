"""The CPU-heavy steps, run in a separate low-priority process (see prepare.py).

Everything here is a plain function of files on disk, so a crash or an out-of-memory in
the worker never takes the server down, and the server never blocks on it. The models
load once per worker process and stay warm.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path

import numpy as np

log = logging.getLogger("lezepplean.worker")

_threads = 2
_separator = None
_ctc = None

SEP_RATE = 44_100
CTC_RATE = 16_000
SEP_PER_FRAME = 882          # 20 ms at 44.1 kHz: one CTC frame
MARGIN_FRAMES = 100          # 2 s of context on each side of a region


def init(threads: int) -> None:
    global _threads
    _threads = threads
    try:
        os.nice(10)  # word timing can wait; the homelab's other work shouldn't
    except OSError:
        pass
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s worker %(message)s")


def warm() -> bool:
    """Load the models now, so the first song heard doesn't wait for them."""
    _models()
    return True


def _models():
    global _separator, _ctc
    from .align.ctc import CtcModel
    from .align.separate import Separator

    if _separator is None:
        _separator = Separator(threads=_threads)
    if _ctc is None:
        _ctc = CtcModel(threads=_threads)
    return _separator, _ctc


def reference_assets(song_dir: str, reference_file: str, map_a_ms: float, map_b: float) -> dict:
    """Re-sync features and the loudness track of the song's own audio."""
    from . import audio, silk, track

    started = time.perf_counter()
    d = Path(song_dir)
    x16 = audio.load(str(d / reference_file), CTC_RATE, 1)[0]
    feats = track.features(x16)
    tmp = d / "features.tmp.npy"
    np.save(tmp, feats.astype(np.float16))
    os.replace(tmp, d / "features.npy")
    gains = silk.gain_track(x16)
    return {
        "envelope": {"startMs": round(map_a_ms, 1), "stepMs": silk.PACKET_MS * (1 + map_b), "data": silk.to_text(gains)},
        "seconds": round(time.perf_counter() - started, 2),
        "durationMs": round(len(x16) / CTC_RATE * 1000),
    }


def _gaps(covered: np.ndarray, f0: int, f1: int, min_frames: int = 1) -> list[tuple[int, int]]:
    """Runs of frames in [f0, f1) not computed yet, as (start, end)."""
    out = []
    i = f0
    while i < f1:
        if covered[i]:
            i += 1
            continue
        j = i
        while j < f1 and not covered[j]:
            j += 1
        if j - i >= min_frames:
            out.append((i, j))
        i = j
    return out


def _load_emissions(path: Path, frames: int) -> tuple[np.ndarray, np.ndarray]:
    if path.exists():
        try:
            z = np.load(path)
            lp, covered = z["lp"].astype(np.float32), z["covered"]
            if len(lp) == frames:
                return lp, covered
        except (OSError, ValueError, KeyError):
            pass
    return np.zeros((frames, 0), dtype=np.float32), np.zeros(frames, dtype=bool)


def align_words(song_dir: str, reference_file: str, lrc_ref: list, region_ms: tuple[float, float] | None,
                line_indices: list[int] | None) -> dict:
    """Word timings for LRC lines (on the reference's timeline), computing what is missing.

    region_ms: the part of the song to make sure is computed (None: all of it).
    line_indices: which lines to align (None: every line, in one global pass).
    Returns {"lines": {index: [start, [word starts], end, confidence]}, "seconds", "covered"}.
    """
    from . import audio
    from .align import align_lyrics
    from .align.ctc import Emissions

    started = time.perf_counter()
    d = Path(song_dir)
    sep, ctc = _models()
    stereo = audio.load(str(d / reference_file), SEP_RATE, 2)
    frames = max(0, (int(stereo.shape[1] * CTC_RATE / SEP_RATE) - 400) // 320 + 1)
    path = d / "emissions.npz"
    lp, covered = _load_emissions(path, frames)

    f0, f1 = 0, frames
    if region_ms is not None:
        f0 = max(0, int(region_ms[0] / 20))
        f1 = min(frames, int(region_ms[1] / 20) + 1)
    model_s = 0.0
    letters, blank, separator = ctc.letters, ctc.blank, ctc.separator
    # Each stretch not computed yet, on its own: one span from the first gap to the last
    # redid the "near" and "next" regions inside it, ~30% of a song's CPU for nothing.
    for a, b in _gaps(covered, f0, f1):
        a0, b0 = max(0, a - MARGIN_FRAMES), min(frames, b + MARGIN_FRAMES)
        piece = stereo[:, a0 * SEP_PER_FRAME: b0 * SEP_PER_FRAME + 2 * SEP_PER_FRAME]
        vocals = sep.vocals(piece)
        v16 = audio.resample(vocals, SEP_RATE, CTC_RATE)
        em = ctc.emissions(v16)
        model_s += em.seconds
        if lp.shape[1] == 0:
            lp = np.zeros((frames, em.log_probs.shape[1]), dtype=np.float32)
            lp[:, :] = -30.0
            lp[:, em.blank] = 0.0  # frames not computed yet read as silence
        got = em.log_probs[a - a0: a - a0 + (b - a)]
        lp[a: a + len(got)] = got
        covered[a: a + len(got)] = True
        tmp = d / "emissions.tmp.npz"
        np.savez(tmp, lp=lp.astype(np.float16), covered=covered)
        os.replace(tmp, path)

    indices = list(range(len(lrc_ref))) if line_indices is None else [i for i in line_indices if 0 <= i < len(lrc_ref)]
    # Only lines whose whole window has been computed: aligning against frames that read
    # as silence would force their words somewhere wrong.
    usable = []
    for i in indices:
        start = lrc_ref[i][0]
        end = lrc_ref[i + 1][0] if i + 1 < len(lrc_ref) else start + 30_000
        lo, hi = max(0, int((start - 2000) / 20)), min(frames, int((end + 2000) / 20))
        if hi > lo and covered[lo:hi].all():
            usable.append(i)
    result: dict[str, list] = {}
    if usable:
        emissions = Emissions(lp, blank, separator, letters, 0.0)
        subset = [(int(lrc_ref[i][0]), lrc_ref[i][1]) for i in usable]
        aligned = align_lyrics(np.zeros(0, np.float32), subset, emissions=emissions, min_confidence=0.0)
        for i, line in zip(usable, aligned.lines):
            if line.words is not None:
                result[str(i)] = [line.start_ms, line.words, line.end_ms, line.confidence]
    return {"lines": result, "seconds": round(time.perf_counter() - started, 2), "modelSeconds": round(model_s, 2),
            "covered": round(float(covered.mean()), 3) if frames else 0.0, "frames": frames}
