"""A character CTC acoustic model (wav2vec 2.0) run with ONNX Runtime on the CPU.

The model turns 16 kHz audio into, every 20 ms, a probability for each letter, the
apostrophe, the word separator `|` and the CTC "blank". The aligner only needs those
probabilities, never a transcript, so a small English speech model does the job.

ONNX Runtime keeps the server lean: no PyTorch, one ~95 MB int8 model file, and a
thread count we choose, so a song's alignment never takes the whole homelab CPU.
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import numpy as np

log = logging.getLogger("lezepplean.align")

SAMPLE_RATE = 16_000
HOP = 320            # samples per output frame (20 ms)
RECEPTIVE = 400      # samples seen by one output frame
FRAME_MS = HOP * 1000 / SAMPLE_RATE

# Xenova's ONNX export of facebook/wav2vec2-base-960h (Apache-2.0).
DEFAULT_REPO = "https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/main"
DEFAULT_FILES = {"model": "onnx/model_quantized.onnx", "vocab": "vocab.json"}


@dataclass
class Emissions:
    log_probs: np.ndarray  # (frames, vocab) float32, log-softmax
    blank: int
    separator: int
    letters: dict[str, int]
    seconds: float         # compute time, for the logs

    @property
    def frames(self) -> int:
        return self.log_probs.shape[0]


def model_dir() -> Path:
    return Path(os.environ.get("LEZEPPLEAN_MODELS", Path(__file__).resolve().parents[2] / "models")) / "wav2vec2-base-960h"


def ensure_model(directory: Path | None = None) -> Path:
    """Download the model on first use (about 95 MB). Returns the directory holding it."""
    directory = directory or model_dir()
    for key, rel in DEFAULT_FILES.items():
        target = directory / Path(rel).name
        if target.exists() and target.stat().st_size > 0:
            continue
        directory.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(target.suffix + ".part")
        log.info("downloading %s → %s", rel, target)
        urllib.request.urlretrieve(f"{DEFAULT_REPO}/{rel}", tmp)
        tmp.replace(target)
    return directory


class CtcModel:
    def __init__(self, directory: Path | None = None, threads: int = 2):
        import onnxruntime as ort

        directory = ensure_model(directory)
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        model = directory / Path(DEFAULT_FILES["model"]).name
        self._session = ort.InferenceSession(str(model), options, providers=["CPUExecutionProvider"])
        self._input = self._session.get_inputs()[0].name
        vocab: dict[str, int] = json.loads((directory / "vocab.json").read_text())
        self.blank = vocab["<pad>"]
        self.separator = vocab["|"]
        self.letters = {k: v for k, v in vocab.items() if len(k) == 1 and (k.isalpha() or k == "'")}

    def emissions(self, audio: np.ndarray, chunk_s: float = 20.0, context_s: float = 2.0) -> Emissions:
        """Log-probabilities for 16 kHz mono float audio, computed in overlapping chunks.

        The transformer attends over its whole input, and its convolutional front end
        holds ~2 KB per input sample per channel layer: a whole 4-minute song in one go
        needs gigabytes. Chunks of 20 s with 2 s of context either side keep the peak
        near 200 MB and give every kept frame the context it would have had anyway.
        """
        started = time.perf_counter()
        n = len(audio)
        total = max(0, (n - RECEPTIVE) // HOP + 1)
        chunk = int(chunk_s * SAMPLE_RATE / HOP)
        context = int(context_s * SAMPLE_RATE / HOP)
        out: np.ndarray | None = None
        for f0 in range(0, total, chunk):
            f1 = min(total, f0 + chunk)
            a = max(0, f0 - context)
            b = min(total, f1 + context)
            piece = audio[a * HOP: (b - 1) * HOP + RECEPTIVE].astype(np.float32)
            piece = (piece - piece.mean()) / np.sqrt(piece.var() + 1e-7)
            logits = self._session.run(None, {self._input: piece[None, :]})[0][0]
            if out is None:
                out = np.empty((total, logits.shape[1]), dtype=np.float32)
            got = logits[f0 - a: f0 - a + (f1 - f0)]
            out[f0: f0 + len(got)] = got
            if len(got) < f1 - f0:  # the model can return a frame fewer than the formula at the very end
                out[f0 + len(got): f1] = got[-1]
        if out is None:
            out = np.zeros((0, 32), dtype=np.float32)
        out = out - out.max(axis=1, keepdims=True)
        out = out - np.log(np.exp(out).sum(axis=1, keepdims=True))
        return Emissions(out, self.blank, self.separator, self.letters, time.perf_counter() - started)
