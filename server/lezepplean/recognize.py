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

import asyncio
import logging
import time
from dataclasses import dataclass

import aiohttp
from shazamio import Shazam
from shazamio.interfaces.client import HTTPClientInterface

log = logging.getLogger("lezepplean.recognize")

# After Shazam refuses (a 429, a 5xx), nothing is sent to it for this long, longer each
# time it refuses again. ShazamIO's own client retried a 429 up to 20 times instead: on
# 11 Oct 2026 a burst of ~100 calls got the homelab's address rate-limited, and every
# song search the watch then made (several requests each) kept the limit going.
COOL_S = (30, 60, 120, 300, 600)


class RecognizerBusy(Exception):
    """Shazam is refusing calls for now: try again in `retry_in` seconds."""

    def __init__(self, retry_in: float):
        super().__init__(f"Shazam is refusing calls; again in {retry_in:.0f} s")
        self.retry_in = retry_in


class _Refused(Exception):
    def __init__(self, status: int, retry_after: float | None):
        super().__init__(f"HTTP {status}")
        self.status = status
        self.retry_after = retry_after


class _Http(HTTPClientInterface):
    """One request per call, no retries, and one connection kept (a TLS handshake to
    Shazam costs ~0.1-0.2 s of every song search otherwise)."""

    def __init__(self) -> None:
        self._session: aiohttp.ClientSession | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    async def request(self, method: str, url: str, *args, **kwargs):
        loop = asyncio.get_running_loop()
        if self._session is None or self._loop is not loop or self._session.closed:
            self._session, self._loop = aiohttp.ClientSession(), loop
        async with self._session.request(method, url, **kwargs) as resp:
            if resp.status == 429 or resp.status >= 500:
                after = resp.headers.get("Retry-After")
                raise _Refused(resp.status, float(after) if after and after.isdigit() else None)
            return await resp.json(content_type=None)


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
        self._shazam = Shazam(http_client=_Http())
        self._cool_until = 0.0
        self._refusals = 0

    async def recognize(self, wav: bytes) -> Match | None:
        """The song in `wav`, None when Shazam doesn't know it. RecognizerBusy while Shazam is
        refusing calls: then nothing is sent at all, so the refusal can wear off."""
        wait = self._cool_until - time.monotonic()
        if wait > 0:
            raise RecognizerBusy(wait)
        try:
            result = await self._shazam.recognize(wav)
        except _Refused as e:
            self._refusals += 1
            wait = max(COOL_S[min(self._refusals, len(COOL_S)) - 1], e.retry_after or 0)
            self._cool_until = time.monotonic() + wait
            log.warning("Shazam refused a call (%s): none sent for %d s", e, wait)
            raise RecognizerBusy(wait) from e
        self._refusals = 0
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
