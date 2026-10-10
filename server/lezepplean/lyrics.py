"""Find time-synced lyrics for an identified track (LRCLIB), matched to the exact recording.

Timings only line up if the lyrics were timed against the same recording that was
identified (a remix, radio edit or live take has different timings). So we look up the
track length from Apple's catalogue and ask LRCLIB for lyrics of that length: its
/api/get endpoint only answers when the stored duration is within about 2 seconds.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher

import httpx

LRCLIB = "https://lrclib.net/api"
ITUNES_LOOKUP = "https://itunes.apple.com/lookup"
USER_AGENT = "LeZeppLean/0.2 (personal smartwatch lyrics project)"
DURATION_TOLERANCE_S = 3.0

_TIMESTAMP = re.compile(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")
_OFFSET_TAG = re.compile(r"^\[offset:\s*([+-]?\d+)\s*\]", re.IGNORECASE)
_FEATURING = re.compile(r"\s*[(\[](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]", re.IGNORECASE)


@dataclass
class Lyrics:
    kind: str                          # "synced" | "plain" | "none"
    lines: list[tuple[int, str]] = field(default_factory=list)  # (start_ms, text); "" marks an instrumental gap
    plain: str | None = None
    source: str | None = None
    source_id: int | None = None
    duration_s: float | None = None    # duration of the recording the lyrics were timed against
    definite: bool = True              # False: LRCLIB couldn't be asked properly; "none" may not mean none


def parse_lrc(text: str) -> list[tuple[int, str]]:
    """Parse LRC into sorted (start_ms, text) pairs.

    Handles several timestamps per line ("[00:12.00][01:30.00]chorus"), 1-3 digit fractions,
    metadata tags such as [ar:...] (skipped), and the [offset:ms] tag, where a positive
    offset means the lyrics should appear earlier.
    """
    offset_ms = 0
    out: list[tuple[int, str]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        tag = _OFFSET_TAG.match(line)
        if tag:
            offset_ms = int(tag.group(1))
            continue
        stamps: list[int] = []
        pos = 0
        while (m := _TIMESTAMP.match(line, pos)) is not None:
            minutes, seconds, frac = m.groups()
            fraction_ms = int(frac.ljust(3, "0")[:3]) if frac else 0
            stamps.append((int(minutes) * 60 + int(seconds)) * 1000 + fraction_ms)
            pos = m.end()
        if not stamps:
            continue
        lyric = line[pos:].strip()
        if lyric in {"♪", "♫", "♬"}:
            lyric = ""
        out.extend((max(0, ms - offset_ms), lyric) for ms in stamps)
    out.sort(key=lambda item: item[0])
    return out


def primary_artist(artist: str) -> str:
    """'The Weeknd & ROSALÍA' -> 'The Weeknd' (used only as a looser search fallback)."""
    return re.split(r"\s+(?:&|x|and|feat\.?|ft\.?)\s+|,\s*", artist, maxsplit=1, flags=re.IGNORECASE)[0].strip()


def _similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a.casefold(), b.casefold()).ratio()


def _lyrics_from_record(record: dict) -> Lyrics:
    synced = record.get("syncedLyrics")
    if synced:
        return Lyrics(kind="synced", lines=parse_lrc(synced), plain=record.get("plainLyrics"),
                      source="lrclib", source_id=record.get("id"), duration_s=record.get("duration"))
    if record.get("plainLyrics"):
        return Lyrics(kind="plain", plain=record["plainLyrics"], source="lrclib",
                      source_id=record.get("id"), duration_s=record.get("duration"))
    return Lyrics(kind="none")


class LyricsFinder:
    def __init__(self, client: httpx.AsyncClient):
        self._client = client
        self._cache: dict[tuple, Lyrics] = {}

    async def itunes_duration_s(self, apple_id: str | None) -> float | None:
        return (await self.itunes_lookup(apple_id))[0]

    async def itunes_lookup(self, apple_id: str | None) -> tuple[float | None, bool]:
        """(track length in s, whether the lookup worked). Without a length, LRCLIB's
        same-recording check can't be made, so callers need to know a failure from a miss."""
        if not apple_id:
            return None, True
        try:
            r = await self._client.get(ITUNES_LOOKUP, params={"id": apple_id}, timeout=4)
            if r.status_code != 200:
                return None, False
            results = r.json().get("results") or []
            millis = results[0].get("trackTimeMillis") if results else None
            return (millis / 1000 if millis else None), True
        except (httpx.HTTPError, ValueError):
            return None, False

    async def find(self, title: str, artist: str, album: str | None, duration_s: float | None) -> Lyrics:
        key = (title.casefold(), artist.casefold(), round(duration_s) if duration_s else None)
        if key in self._cache:
            return self._cache[key]
        errors: list[str] = []
        result = await self._find_uncached(title, artist, album, duration_s, errors)
        if result.kind != "synced" and errors:
            # A timeout or a 5xx is not "this song has no lyrics": say so, so it is asked again.
            result.definite = False
        if result.kind != "none" and result.definite:
            self._cache[key] = result
        return result

    async def _find_uncached(self, title: str, artist: str, album: str | None, duration_s: float | None,
                             errors: list[str]) -> Lyrics:
        # 1. Exact lookup: LRCLIB only answers when its stored duration is within ~2 s of ours.
        if duration_s:
            for params in (
                {"track_name": title, "artist_name": artist, "album_name": album or "", "duration": round(duration_s)},
                {"track_name": title, "artist_name": artist, "duration": round(duration_s)},
            ):
                record = await self._get_json("/get", params, errors)
                if isinstance(record, dict) and record.get("syncedLyrics"):
                    return _lyrics_from_record(record)

        # 2. Search, then keep only candidates timed against a recording of the same length.
        clean_title = _FEATURING.sub("", title).strip()
        candidates: list[dict] = []
        for params in (
            {"track_name": clean_title, "artist_name": artist},
            {"track_name": clean_title, "artist_name": primary_artist(artist)},
            {"q": f"{clean_title} {primary_artist(artist)}"},
        ):
            found = await self._get_json("/search", params, errors)
            if isinstance(found, list) and found:
                candidates = found
                break

        def duration_ok(c: dict) -> bool:
            return duration_s is None or (c.get("duration") and abs(c["duration"] - duration_s) <= DURATION_TOLERANCE_S)

        def score(c: dict) -> float:
            s = _similar(c.get("trackName", ""), clean_title) + 0.5 * _similar(c.get("artistName", ""), artist)
            if duration_s and c.get("duration"):
                s -= abs(c["duration"] - duration_s) / 10
            return s

        synced = sorted((c for c in candidates if c.get("syncedLyrics") and duration_ok(c)), key=score, reverse=True)
        if synced:
            return _lyrics_from_record(synced[0])
        plain = sorted((c for c in candidates if c.get("plainLyrics")), key=score, reverse=True)
        if plain:
            return Lyrics(kind="plain", plain=plain[0]["plainLyrics"], source="lrclib",
                          source_id=plain[0].get("id"), duration_s=plain[0].get("duration"))
        return Lyrics(kind="none")

    async def _get_json(self, path: str, params: dict, errors: list[str]):
        try:
            r = await self._client.get(LRCLIB + path, params=params, headers={"User-Agent": USER_AGENT}, timeout=5)
        except httpx.HTTPError as e:
            errors.append(f"{path}: {type(e).__name__}")
            return None
        if r.status_code == 404:
            return None  # LRCLIB's "no such lyrics": a real answer
        if r.status_code != 200:
            errors.append(f"{path}: HTTP {r.status_code}")
            return None
        try:
            return r.json()
        except ValueError:
            errors.append(f"{path}: bad JSON")
            return None
