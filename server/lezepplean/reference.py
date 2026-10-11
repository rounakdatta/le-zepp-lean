"""The song's own audio, fetched once, as the reference for everything after recognition.

Word timing, fast re-sync and the loudness track the watch follows all need the clean
recording, not the watch's 17 kbps room recording. It comes from YouTube via yt-dlp
(the user accepted that this is against YouTube's terms). Every candidate must:

1. be the same length as the identified recording (within 3 s), which rules out live
   takes, radio edits and music videos with a spoken intro; and
2. pass a check by Shazam itself: cuts from across it must be recognised as the same
   track. Shazam's offsets for those cuts also map this copy onto the timeline the watch
   runs on. Uploads of one recording differ by a few hundred ms of leading silence, and a
   remaster can even run at a fractionally different speed: Oasis' "Wonderwall
   (Remastered)" drifts 0.033% against Shazam's copy, 67 ms over three minutes. So the
   map is a line, canonical = a + (1 + b) * reference, fitted to five cuts.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np

from .phone import name_key
from . import zepp_opus

log = logging.getLogger("lezepplean.reference")

DURATION_TOLERANCE_S = 3.0
VERIFY_CUTS = (0.15, 0.35, 0.5, 0.65, 0.85)   # where in the song the Shazam check listens
VERIFY_SECONDS = 6.0
# YouTube's player needs JavaScript solved before it hands out audio; without a runtime,
# yt-dlp gets fewer formats and intermittent HTTP 403s. Whichever of these is installed.
_JS = {"deno": {}, "node": {}}
_BAD = re.compile(r"\b(live|cover|remix|karaoke|instrumental|sped[ -]?up|slowed|reverb|8d|nightcore|acoustic|piano|"
                  r"reaction|tutorial|lesson|mashup|edit|extended|loop|1 hour)\b", re.IGNORECASE)


class TransientError(Exception):
    """Couldn't find out (network, YouTube, Shazam trouble): try again later, don't conclude."""


@dataclass
class Candidate:
    id: str
    title: str
    channel: str
    duration_s: float
    score: float


@dataclass
class Mapping:
    """canonical (watch/LRC) ms = a_ms + (1 + b) * reference ms"""
    a_ms: float
    b: float
    agreement: str           # e.g. "5/5": Shazam cuts that named the song
    residual_ms: float       # worst distance of a cut from the line

    def to_canonical(self, ref_ms: float) -> float:
        return self.a_ms + (1 + self.b) * ref_ms

    def to_reference(self, canonical_ms: float) -> float:
        return (canonical_ms - self.a_ms) / (1 + self.b)

    def as_dict(self) -> dict:
        return {"aMs": round(self.a_ms, 2), "b": self.b, "agreement": self.agreement, "residualMs": round(self.residual_ms, 1)}

    @classmethod
    def from_dict(cls, d: dict) -> "Mapping":
        return cls(float(d["aMs"]), float(d["b"]), d.get("agreement", ""), float(d.get("residualMs", 0)))


def score_candidate(c: dict, title: str, artist: str, duration_s: float | None) -> float | None:
    dur = c.get("duration")
    if duration_s and (not dur or abs(dur - duration_s) > DURATION_TOLERANCE_S):
        return None
    name = (c.get("title") or "")
    channel = (c.get("channel") or c.get("uploader") or "")
    s = SequenceMatcher(None, title.casefold(), name.casefold()).ratio()
    for bad in _BAD.findall(name):
        if bad.casefold() not in title.casefold():
            s -= 1.0
    if channel.casefold().endswith(" - topic"):
        s += 0.6  # YouTube's auto-generated "art track": the album recording itself
    if artist and artist.casefold().split(" & ")[0] in channel.casefold():
        s += 0.4
    if re.search(r"official (audio|visualizer)|provided to youtube", name, re.IGNORECASE):
        s += 0.3
    if dur and duration_s:
        s -= abs(dur - duration_s) / 10
    return s


def search(title: str, artist: str, duration_s: float | None, limit: int = 8) -> list[Candidate] | None:
    """Candidates for the recording, best first; None if YouTube couldn't be searched at all
    (blocking: run it in a thread)."""
    import yt_dlp

    seen: dict[str, Candidate] = {}
    opts = {"quiet": True, "no_warnings": True, "extract_flat": True, "skip_download": True, "js_runtimes": _JS}
    searched = False
    for query in (f"{artist} - {title}", f"{title} {artist} audio"):
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                found = ydl.extract_info(f"ytsearch{limit}:{query}", download=False) or {}
            searched = True
        except Exception as e:  # network, YouTube changes: try the other query, then later
            log.warning("youtube search failed for %r: %s", query, e)
            continue
        for entry in found.get("entries") or []:
            if not entry or entry.get("id") in seen:
                continue
            s = score_candidate(entry, title, artist, duration_s)
            if s is not None:
                seen[entry["id"]] = Candidate(entry["id"], entry.get("title") or "", entry.get("channel") or "",
                                              float(entry.get("duration") or 0), s)
        if seen:
            break
    if not searched:
        return None
    return sorted(seen.values(), key=lambda c: c.score, reverse=True)


def download(video_id: str, directory: Path) -> Path:
    """Best audio-only stream (usually 128 kbps AAC, ~4 MB). Blocking."""
    import yt_dlp

    directory.mkdir(parents=True, exist_ok=True)
    opts = {"quiet": True, "no_warnings": True, "format": "bestaudio[ext=m4a]/bestaudio", "js_runtimes": _JS,
            "outtmpl": str(directory / "reference.%(ext)s"), "overwrites": True, "noprogress": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=True)
        return Path(ydl.prepare_filename(info))


def load_16k(path: Path) -> np.ndarray:
    """Mono float32 at 16 kHz in [-1, 1]."""
    pcm = zepp_opus.load_audio_as_pcm(str(path))
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768


async def measure_mapping(audio: np.ndarray, recognize, song_key: str | None, title: str) -> Mapping | None:
    """Shazam five cuts of the reference and fit the line from this copy to the watch's timeline.

    `recognize(wav_bytes)` is the server's recognizer. A cut counts when Shazam names the
    same track (by key, or by title when the key is missing). None when fewer than three
    cuts agree, or they don't lie on one line: then this is a different edit (a cut verse,
    a longer intro) that merely has the same length.
    """
    sr = zepp_opus.SAMPLE_RATE
    total_s = len(audio) / sr
    cuts = [max(0.0, min(total_s - VERIFY_SECONDS, total_s * f)) for f in VERIFY_CUTS]

    failures = 0

    async def one(start_s: float):
        nonlocal failures
        a = int(start_s * sr)
        clip = (np.clip(audio[a: a + int(VERIFY_SECONDS * sr)], -1, 1) * 32767).astype(np.int16)
        try:
            return start_s, await recognize(zepp_opus.pcm_to_wav(clip.tobytes()))
        except Exception as e:
            log.warning("reference check failed at %.1fs: %s", start_s, e)
            failures += 1
            return start_s, None

    # One at a time: five at once is the kind of burst an unofficial API rate-limits.
    results = [await one(s) for s in cuts]
    xs, ds = [], []
    for start_s, match in results:
        if match is None:
            continue
        # a song named by the phone's player has no Shazam key: then the name decides
        same = (song_key and match.shazam_key == song_key) or (not song_key and name_key(match.title) == name_key(title))
        if same:
            xs.append(start_s * 1000)
            ds.append(match.offset_ms - start_s * 1000)
    agreement = f"{len(xs)}/{len(cuts)}"
    if len(xs) < 3:
        if failures and len(xs) + failures >= 3:
            raise TransientError(f"Shazam failed on {failures} of {len(cuts)} cuts")
        return None
    x, d = np.array(xs), np.array(ds)
    b, a = np.polyfit(x, d, 1)
    if abs(b) > 0.005:  # more than 0.5% speed difference: not the same recording
        return None
    residual = float(np.max(np.abs(d - (a + b * x))))
    if residual > 60:
        return None
    return Mapping(float(a), float(b), agreement, residual)
