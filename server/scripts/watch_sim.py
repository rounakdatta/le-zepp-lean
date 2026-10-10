"""What the watch would hear: a song played in a room, picked up at a distance, encoded
by the recorder (SILK wideband, 60 ms packets, ~17 kbps).

Used to test fast re-sync and the loudness track without a watch:

    from watch_sim import room, watch_codec
    heard = watch_codec(room(song_16k, rt60=0.5, level_db=-28))

The room is a synthetic impulse response (direct sound plus an exponentially decaying
tail), a speaker that rolls off the bass, a distance loss, and a noise floor. None of it
is a measured T-Rex 3 room; the thresholds it informs leave margin for that, and the
real recordings in server/captures/ are the check that matters.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lezepplean import silk, zepp_opus  # noqa: E402

SR = 16_000


def room(audio: np.ndarray, rt60: float = 0.45, level_db: float = -26.0, noise_db: float = -62.0,
         seed: int = 0, talk: np.ndarray | None = None) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n_ir = int(rt60 * SR)
    t = np.arange(n_ir) / SR
    tail = rng.standard_normal(n_ir) * np.exp(-6.9 * t / rt60) * 0.12
    tail[: int(0.004 * SR)] = 0           # first reflections arrive a few ms after the direct sound
    ir = tail
    ir[0] = 1.0
    # small speaker: a one-pole high-pass around 150 Hz, folded into the (short) impulse response
    a = np.exp(-2 * np.pi * 150 / SR)
    hp = np.empty_like(ir)
    prev_x = prev_y = 0.0
    for i, x in enumerate(ir):
        y = a * (prev_y + x - prev_x)
        hp[i] = y
        prev_x, prev_y = x, y
    wet = _fft_convolve(audio.astype(np.float64), hp)[: len(audio)]
    out = wet * 10 ** (level_db / 20)
    out += rng.standard_normal(len(out)) * 10 ** (noise_db / 20)
    if talk is not None:
        out[: len(talk)] += talk[: len(out)]
    return np.clip(out, -1, 1).astype(np.float32)


def watch_codec(audio: np.ndarray) -> np.ndarray:
    """Round trip through the recorder's codec, as the server receives it."""
    packets = silk.encode_like_watch(audio)
    framed = b"".join(len(p).to_bytes(4, "big") + b"\0\0\0\0" + p for p in packets)
    pcm = zepp_opus.decode(framed).pcm
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768


def watch_packets(audio: np.ndarray) -> list[bytes]:
    return silk.encode_like_watch(audio)


def _fft_convolve(x: np.ndarray, h: np.ndarray) -> np.ndarray:
    n = len(x) + len(h) - 1
    size = 1 << int(np.ceil(np.log2(n)))
    return np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(h, size), size)[:n]
