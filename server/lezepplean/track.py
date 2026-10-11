"""Fast re-sync: find where a short watch recording sits inside a song we already know.

Shazam answers "which song, and where" in ~500 ms from ~4 s of audio. Once the song is
known and its own audio is on disk, "where exactly, near here?" is a much smaller
question: compare the watch's window with the reference around the predicted position
and take the best lag. That takes milliseconds and works with 2 s of audio, which is
what makes a resume confirmable while the music is still in the first bar.

Both sides become log-mel spectrograms (40 bands, 10 ms hop). Each band is normalised
over time, which removes what the room and the 17 kbps SILK codec do to the level and
tone, and keeps what doesn't change: which bands rise and fall when. The score of a lag
is the correlation of the two normalised spectrograms; its height and how far it stands
out from the other lags say whether to believe it.

That score has a blind spot: a rise in every band at once (a quiet clip that gets louder, a
knock in a quiet room) dominates it, and matches wherever the song itself rises (its start
after the silence before it, a drop). So the spectrum's shape can be compared on its own
(`shape=True`: each frame's level across all bands taken out), and a placement must agree in
shape too (`agreement`). On room audio of 4 songs (scripts/eval_wrong_song.py, 11 Oct 2026),
the level alone placed another song inside the one on screen in 283 of 1,440 clips (275 of
the 480 where the music came in after a quiet start: a song switch looks just like that), and
the right song at the wrong place in 124 of 720. Checked by shape: 1 and 7, and the right
song was placed right 427 times instead of 276.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

SAMPLE_RATE = 16_000
N_FFT = 512
HOP = 160            # 10 ms
BANDS = 40
FMIN, FMAX = 120.0, 7600.0
FRAME_MS = HOP * 1000 / SAMPLE_RATE
# Reference frames whose loudest band is this far below the song's typical loudest band (~40
# dB), or within ~13 dB of the features' floor (log 1e-8: digital silence, whatever the song's
# level), are silence: before and after the song, or between its parts. No window is placed
# over them (see above: silence turning into music is the steepest rise there is).
SILENT_DROP = 9.2
SILENT_FLOOR = -15.4

_window = np.hanning(N_FFT + 1)[:-1].astype(np.float32)


def _mel(f):
    return 2595.0 * np.log10(1.0 + f / 700.0)


def _mel_inv(m):
    return 700.0 * (10 ** (m / 2595.0) - 1.0)


def _filterbank() -> np.ndarray:
    freqs = np.fft.rfftfreq(N_FFT, 1 / SAMPLE_RATE)
    edges = _mel_inv(np.linspace(_mel(FMIN), _mel(FMAX), BANDS + 2))
    fb = np.zeros((BANDS, len(freqs)), dtype=np.float32)
    for b in range(BANDS):
        lo, mid, hi = edges[b], edges[b + 1], edges[b + 2]
        up = (freqs - lo) / (mid - lo)
        down = (hi - freqs) / (hi - mid)
        fb[b] = np.clip(np.minimum(up, down), 0, None)
    return fb


_FB = _filterbank()


def features(audio: np.ndarray) -> np.ndarray:
    """(frames, BANDS) float32 log-mel energies, frame i centred at i * 10 ms + 16 ms."""
    x = np.asarray(audio, dtype=np.float32)
    if len(x) < N_FFT:
        return np.zeros((0, BANDS), dtype=np.float32)
    n = 1 + (len(x) - N_FFT) // HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n)[:, None]
    spec = np.abs(np.fft.rfft(x[idx] * _window, axis=1)) ** 2
    return np.log(spec @ _FB.T + 1e-8).astype(np.float32)


def _normalise(f: np.ndarray) -> np.ndarray:
    f = f - f.mean(axis=0, keepdims=True)
    return f / (f.std(axis=0, keepdims=True) + 1e-3)


def _shape(f: np.ndarray) -> np.ndarray:
    """Each frame's spectrum without its overall level: how the bands stand to each other."""
    return f - f.mean(axis=1, keepdims=True)


@dataclass
class Located:
    offset_ms: float     # reference time at which the window starts
    score: float         # correlation at the best lag (0..1)
    margin: float        # best score minus the best score at least 400 ms away
    searched_ms: tuple[float, float]


def locate(window: np.ndarray, reference: np.ndarray, center_ms: float | None, radius_ms: float = 3000.0,
           shape: bool = False) -> Located | None:
    """Where `window` (watch audio, 16 kHz) starts inside `reference` (its features).

    center_ms: predicted reference time of the window start (None: search the whole song).
    shape: compare the spectrum's shape only, not how loud each band is.
    """
    f = features(window)
    w = _normalise(_shape(f) if shape else f)
    if len(w) < 50 or len(reference) < len(w):
        return None
    reference = np.asarray(reference, dtype=np.float32)  # (float16 sums went out of range)
    n = len(w)
    total = len(reference) - n + 1
    if center_ms is None:
        lo, hi = 0, total
    else:
        c = int(round(center_ms / FRAME_MS))
        r = int(round(radius_ms / FRAME_MS))
        lo, hi = max(0, c - r), min(total, c + r + 1)
    if hi - lo < 3:
        return None
    seg = reference[lo: hi + n - 1]
    scores = _sliding_correlation(w, _shape(seg) if shape else seg)
    silent = np.concatenate([[0], np.cumsum(seg.max(axis=1) < _silence_below(reference))])
    over_silence = silent[n:] - silent[:-n] > 0
    if over_silence.all():
        return None
    scores[over_silence] = -1.0
    best = int(np.argmax(scores))
    peak = float(scores[best])
    # sub-frame peak position from the parabola through the best lag and its neighbours
    frac = 0.0
    if 0 < best < len(scores) - 1:
        a, b, c3 = scores[best - 1], scores[best], scores[best + 1]
        denom = a - 2 * b + c3
        if denom < 0:
            frac = float(np.clip(0.5 * (a - c3) / denom, -0.5, 0.5))
    away = int(round(400 / FRAME_MS))
    mask = np.ones(len(scores), dtype=bool)
    mask[max(0, best - away): best + away + 1] = False
    second = float(scores[mask].max()) if mask.any() else 0.0
    return Located(offset_ms=(lo + best + frac) * FRAME_MS, score=peak, margin=peak - second,
                   searched_ms=(lo * FRAME_MS, hi * FRAME_MS))


def agreement(window: np.ndarray, reference: np.ndarray, offset_ms: float) -> float:
    """How well the window's spectral shape matches the reference's at offset_ms: the shape score
    of that one lag (-1 if it doesn't fit inside the song)."""
    w = _normalise(_shape(features(window)))
    i = int(round(offset_ms / FRAME_MS))
    if len(w) < 50 or i < 0 or i + len(w) > len(reference):
        return -1.0
    return float(_sliding_correlation(w, _shape(np.asarray(reference[i: i + len(w)], dtype=np.float32)))[0])


def _silence_below(reference: np.ndarray) -> float:
    return max(float(np.median(reference[::10].max(axis=1))) - SILENT_DROP, SILENT_FLOOR)


def _sliding_correlation(w: np.ndarray, seg: np.ndarray) -> np.ndarray:
    """Pearson correlation of w (n, B) with every n-frame slice of seg, each slice normalised
    on its own (so a loud chorus can't outscore the right, quieter verse)."""
    n, bands = w.shape
    lags = len(seg) - n + 1
    # Per band: correlate w with seg via FFT, and get each slice's mean/std via cumulative sums.
    size = 1 << int(np.ceil(np.log2(len(seg) + n)))
    W = np.fft.rfft(w[::-1], size, axis=0)
    S = np.fft.rfft(seg, size, axis=0)
    raw = np.fft.irfft(W * S, size, axis=0)[n - 1: n - 1 + lags]           # (lags, B): sum_t w[t] * seg[lag + t]
    c1 = np.concatenate([np.zeros((1, bands)), np.cumsum(seg, axis=0)])
    c2 = np.concatenate([np.zeros((1, bands)), np.cumsum(seg.astype(np.float64) ** 2, axis=0)])
    s1 = c1[n:n + lags] - c1[:lags]
    s2 = c2[n:n + lags] - c2[:lags]
    mean = s1 / n
    std = np.sqrt(np.maximum(s2 / n - mean ** 2, 1e-6))
    # w is zero-mean per band, so sum_t w (seg - mean) = raw; divide by slice std and n
    corr = raw / (std * n)
    return corr.mean(axis=1).astype(np.float32)
