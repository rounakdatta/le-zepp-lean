"""Pull the vocals out of the song before aligning words to them (Spleeter 2-stems, ONNX).

A speech model listening to a full band mix hears mostly guitars and drums: on the
JamendoLyrics benchmark the aligner was right to within 300 ms for 72% of words on the
mix. Deezer's Spleeter estimates the vocal and accompaniment spectrograms; their ratio
masks the song's own STFT, and the aligner gets something much closer to a dry vocal.

Spleeter is the smallest separator that does the job: a U-Net over 512-frame blocks of
a 4096-point STFT at 44.1 kHz, ~37 MB per stem as ONNX, a few seconds per song on two
cores. Blocks are independent, so the song is processed a few blocks at a time and the
memory stays flat however long the song is.

Models: k2-fsa/sherpa-onnx's ONNX export of deezer/spleeter (MIT).
"""

from __future__ import annotations

import logging
import os
import tarfile
import time
import urllib.request
from pathlib import Path

import numpy as np

log = logging.getLogger("lezepplean.align")

SAMPLE_RATE = 44_100
N_FFT = 4096
HOP = 1024
BINS = 1024          # the model sees the lowest 1024 bins (up to ~11 kHz)
BLOCK = 512          # frames per model block
URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/source-separation-models/sherpa-onnx-spleeter-2stems.tar.bz2"


def model_dir() -> Path:
    return Path(os.environ.get("LEZEPPLEAN_MODELS", Path(__file__).resolve().parents[2] / "models")) / "spleeter-2stems"


def ensure_model(directory: Path | None = None) -> Path:
    directory = directory or model_dir()
    if (directory / "vocals.onnx").exists() and (directory / "accompaniment.onnx").exists():
        return directory
    directory.mkdir(parents=True, exist_ok=True)
    archive = directory / "spleeter.tar.bz2"
    log.info("downloading %s", URL)
    urllib.request.urlretrieve(URL, archive)
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            name = Path(member.name).name
            if name in ("vocals.onnx", "accompaniment.onnx"):
                member.name = name
                tar.extract(member, directory, filter="data")
    archive.unlink(missing_ok=True)
    return directory


class Separator:
    def __init__(self, directory: Path | None = None, threads: int = 2):
        import onnxruntime as ort

        directory = ensure_model(directory)
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        self._vocals = ort.InferenceSession(str(directory / "vocals.onnx"), options, providers=["CPUExecutionProvider"])
        self._accomp = ort.InferenceSession(str(directory / "accompaniment.onnx"), options, providers=["CPUExecutionProvider"])
        self._window = np.hanning(N_FFT + 1)[:-1].astype(np.float32)  # periodic Hann
        self.seconds = 0.0

    def vocals(self, stereo: np.ndarray, blocks_per_run: int = 1) -> np.ndarray:
        """(2, samples) float32 at 44.1 kHz -> mono vocals, same rate and length."""
        started = time.perf_counter()
        n = stereo.shape[1]
        frames = max(1, 1 + (n - N_FFT + HOP - 1) // HOP)
        padded = np.zeros((2, (frames - 1) * HOP + N_FFT), dtype=np.float32)
        padded[:, :n] = stereo
        out = np.zeros(padded.shape[1], dtype=np.float32)
        norm = np.zeros(padded.shape[1], dtype=np.float32)
        step = BLOCK * blocks_per_run
        for f0 in range(0, frames, step):
            f1 = min(frames, f0 + step)
            spec = self._stft(padded, f0, f1)                       # (2, f, N_FFT//2+1) complex
            mag = np.abs(spec[:, :, :BINS]).astype(np.float32)
            used = f1 - f0
            blocks = -(-used // BLOCK)
            x = np.zeros((2, blocks * BLOCK, BINS), dtype=np.float32)
            x[:, :used] = mag
            x = x.reshape(2, blocks, BLOCK, BINS)
            v = self._vocals.run(None, {"x": x})[0].reshape(2, blocks * BLOCK, BINS)[:, :used]
            a = self._accomp.run(None, {"x": x})[0].reshape(2, blocks * BLOCK, BINS)[:, :used]
            mask = (v * v + 5e-11) / (v * v + a * a + 1e-10)
            masked = spec[:, :, :BINS] * mask                      # bins above ~11 kHz dropped: we only keep 8 kHz
            mono = masked.mean(axis=0)
            full = np.zeros((used, N_FFT // 2 + 1), dtype=np.complex64)
            full[:, :BINS] = mono
            frames_td = np.fft.irfft(full, n=N_FFT, axis=1).astype(np.float32) * self._window
            for i in range(used):
                s = (f0 + i) * HOP
                out[s: s + N_FFT] += frames_td[i]
                norm[s: s + N_FFT] += self._window * self._window
        out = out / np.maximum(norm, 1e-6)
        self.seconds += time.perf_counter() - started
        return out[:n]

    def _stft(self, x: np.ndarray, f0: int, f1: int) -> np.ndarray:
        idx = (np.arange(f0, f1) * HOP)[:, None] + np.arange(N_FFT)[None, :]
        frames = x[:, idx] * self._window                          # (2, f, N_FFT)
        return np.fft.rfft(frames, axis=2).astype(np.complex64)
