"""What the server knows about each song, kept on disk.

A song heard once is instant the second time: lyrics, word timings, the loudness track
and the re-sync features are all saved under `<data>/songs/<id>/`:

    meta.json       everything below except the arrays
    reference.*     the song's own audio (~4 MB)
    features.npy    log-mel features of the reference, for fast re-sync
    emissions.npz   the acoustic model's letter probabilities, so a re-alignment is cheap

The id is Shazam's track key, which is stable per recording.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
from collections import OrderedDict
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np


@dataclass
class Song:
    id: str
    title: str
    artist: str
    album: str | None = None
    duration_ms: int | None = None
    apple_id: str | None = None
    isrc: str | None = None
    shazam_key: str | None = None
    lyrics_kind: str = "none"                      # synced | plain | none
    lrc: list = field(default_factory=list)        # [[start_ms, text]] on the watch's timeline
    lyrics_source: dict = field(default_factory=dict)
    reference: dict | None = None                  # {videoId, title, channel, durationS, file, map: {...}}
    reference_status: str = "pending"              # pending | ready | unavailable
    reference_retry_at: float = 0.0                # epoch s: don't try to fetch the reference before this
    reference_attempts: int = 0                    # passing failures so far (the retry wait doubles)
    lyrics_retry_at: float = 0.0                   # epoch s: LRCLIB couldn't be asked properly; ask again after this
    words: dict = field(default_factory=dict)      # {status, lines: {i: [start, [words], end, conf]}, aligned, of, ...}
    envelope: dict | None = None                   # {version, startMs, stepMs, data}
    jobs: dict = field(default_factory=dict)       # {step: {tries, retryAt}} for steps that failed or were cut short
    lyrics_rev: int = 0                            # bumped when the lyrics change: word timings for older ones are dropped
    length_checked: bool = False                   # duration_ms came from Apple (the same-recording check was possible)
    notes: list = field(default_factory=list)      # what went wrong, for /songs/<id>


def lyrics_payload(song: Song, min_confidence: float) -> dict:
    """Lines as the watch wants them: [startMs, text, wordStarts | null, endMs | null].

    Word timings only for lines the aligner is sure about; the rest stay line by line.
    """
    words = (song.words or {}).get("lines") or {}
    lines = []
    for i, (start, text) in enumerate(song.lrc):
        w = words.get(str(i))
        if w and w[1] and w[3] >= min_confidence and len(w[1]) == len(text.split()):
            lines.append([int(w[0]), text, [int(x) for x in w[1]], int(w[2]) if w[2] is not None else None])
        else:
            lines.append([int(start), text, None, None])
    body = {"kind": song.lyrics_kind, "lines": lines}
    version = hashlib.sha1(json.dumps(body, separators=(",", ":")).encode()).hexdigest()[:10]
    return {"version": version, **body}


def words_status(song: Song) -> dict:
    w = song.words or {}
    out = {"status": w.get("status", "pending")}
    for k in ("aligned", "of", "etaMs"):
        if w.get(k) is not None:
            out[k] = w[k]
    return out


class SongStore:
    def __init__(self, root: Path, keep_features: int = 8):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._songs: dict[str, Song] = {}
        self._features: OrderedDict[str, np.ndarray] = OrderedDict()
        self._keep = keep_features
        self._lock = threading.Lock()

    def dir(self, song_id: str) -> Path:
        safe = "".join(ch for ch in song_id if ch.isalnum() or ch in "-_")
        return self.root / safe

    def get(self, song_id: str) -> Song | None:
        with self._lock:
            song = self._songs.get(song_id)
            if song is not None:
                return song
        meta = self.dir(song_id) / "meta.json"
        if not meta.exists():
            return None
        try:
            data = json.loads(meta.read_text())
            song = Song(**{k: v for k, v in data.items() if k in Song.__dataclass_fields__})
        except (OSError, ValueError, TypeError):
            return None
        with self._lock:
            self._songs[song_id] = song
        return song

    def put(self, song: Song) -> None:
        song.notes = song.notes[-20:]  # what went wrong lately, not forever
        d = self.dir(song.id)
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / "meta.json.tmp"
        tmp.write_text(json.dumps(asdict(song), ensure_ascii=False))
        os.replace(tmp, d / "meta.json")
        with self._lock:
            self._songs[song.id] = song

    def features(self, song_id: str) -> np.ndarray | None:
        with self._lock:
            f = self._features.get(song_id)
            if f is not None:
                self._features.move_to_end(song_id)
                return f
        path = self.dir(song_id) / "features.npy"
        if not path.exists():
            return None
        try:
            f = np.load(path).astype(np.float32)
        except (OSError, ValueError):
            return None
        with self._lock:
            self._features[song_id] = f
            while len(self._features) > self._keep:
                self._features.popitem(last=False)
        return f

    def forget_features(self, song_id: str) -> None:
        with self._lock:
            self._features.pop(song_id, None)

    def all(self) -> list[Song]:
        out = []
        for meta in sorted(self.root.glob("*/meta.json")):
            song = self.get(meta.parent.name)
            if song:
                out.append(song)
        return out
