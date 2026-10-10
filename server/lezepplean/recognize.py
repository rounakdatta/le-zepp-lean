"""Song recognition via ShazamIO (an unofficial client for Shazam's private API).

Shazam returns `matches[0].offset`: the position in the song, in seconds, where the
submitted clip *starts*. In local tests two cuts taken 10.000 s apart came back
9.9997 s apart, so the offset is precise to well under a millisecond. That offset is
what lets the watch sync lyrics despite the seconds spent recording and identifying.

ShazamIO is unofficial: it can break when Shazam changes its API, and using it is
against Shazam's terms. Keep this module the only place that knows about it, so another
recognizer (e.g. ACRCloud, which reports `play_offset_ms`) can replace it.
"""

from __future__ import annotations

from dataclasses import dataclass

from shazamio import Shazam


@dataclass
class Match:
    title: str
    artist: str
    album: str | None
    offset_ms: float        # song position at the start of the clip
    timeskew: float | None  # Shazam's estimate of playback-speed difference
    apple_id: str | None
    isrc: str | None
    shazam_key: str | None
    cover_url: str | None


class Recognizer:
    def __init__(self) -> None:
        self._shazam = Shazam()

    async def recognize(self, wav: bytes) -> Match | None:
        result = await self._shazam.recognize(wav)
        matches = result.get("matches") or []
        track = result.get("track")
        if not matches or not track:
            return None
        best = matches[0]
        return Match(
            title=track.get("title") or "",
            artist=track.get("subtitle") or "",
            album=_album(track),
            offset_ms=float(best.get("offset") or 0.0) * 1000,
            timeskew=best.get("timeskew"),
            apple_id=_apple_id(track),
            isrc=track.get("isrc"),
            shazam_key=track.get("key"),
            cover_url=(track.get("images") or {}).get("coverart"),
        )


def _album(track: dict) -> str | None:
    for section in track.get("sections") or []:
        if section.get("type") == "SONG":
            for item in section.get("metadata") or []:
                if item.get("title") == "Album":
                    return item.get("text")
    return None


def _apple_id(track: dict) -> str | None:
    for action in (track.get("hub") or {}).get("actions") or []:
        if action.get("type") == "applemusicplay" and action.get("id"):
            return str(action["id"])
    return None
