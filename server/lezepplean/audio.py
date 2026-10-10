"""Decoding and resampling to plain float arrays (PyAV, which bundles FFmpeg)."""

from __future__ import annotations

import av
import numpy as np


def load(path: str, rate: int = 16_000, channels: int = 1) -> np.ndarray:
    """Any audio file (m4a, mp3, webm, wav...) -> float32 (channels, samples) in [-1, 1]."""
    layout = "mono" if channels == 1 else "stereo"
    resampler = av.AudioResampler(format="fltp", layout=layout, rate=rate)
    parts: list[np.ndarray] = []
    with av.open(path) as container:
        stream = container.streams.audio[0]
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                parts.append(out.to_ndarray())
    for out in resampler.resample(None):
        parts.append(out.to_ndarray())
    if not parts:
        return np.zeros((channels, 0), dtype=np.float32)
    return np.concatenate(parts, axis=1).astype(np.float32, copy=False)


def resample(x: np.ndarray, rate_in: int, rate_out: int) -> np.ndarray:
    """Mono float32 -> mono float32 at another rate."""
    if rate_in == rate_out:
        return x.astype(np.float32, copy=False)
    resampler = av.AudioResampler(format="fltp", layout="mono", rate=rate_out)
    frame = av.AudioFrame.from_ndarray(np.ascontiguousarray(x, dtype=np.float32)[None, :], format="fltp", layout="mono")
    frame.sample_rate = rate_in
    parts = [f.to_ndarray() for f in resampler.resample(frame)] + [f.to_ndarray() for f in resampler.resample(None)]
    return np.concatenate(parts, axis=1)[0] if parts else np.zeros(0, dtype=np.float32)
