"""What the phone is playing, from the LeZeppLean helper app on it.

Every Android player (YouTube, YouTube Music, Spotify, ...) publishes a media session: the
track, where in it, and whether it plays. The helper sends it here the moment any of that
changes, and every 10 s while playing. With music in earphones the watch's mic hears
nothing; with music from the phone's speaker this is exact where the mic is an estimate.

The phone's clock and the server's differ by an unknown amount, and each update spends a
different time on the network. The fastest delivery seen bounds the difference best: the
offset is the smallest (received - sent) of the recent updates, and an update that took
longer than that is moved on by the difference while the music plays.
"""

from __future__ import annotations

import asyncio
import re
import time
from collections import deque
from dataclasses import dataclass, field

STALE_S = 35.0  # no word from the helper this long while "playing" (it heartbeats every 10 s): don't trust it
OFFSET_SAMPLES = 40
HEARD_FRESH_S = 20.0  # what the phone's mic named (listen.py) is offered to the watch this long


@dataclass
class Snapshot:
    version: int = 0
    app: str = ""
    title: str = ""
    artist: str = ""
    album: str | None = None
    duration_ms: int | None = None
    playing: bool = False
    buffering: bool = False   # skipping, or the stream stalled: still this player's music, just no sound yet
    position_ms: float = 0.0  # where the track was at server time `at`
    at: float = 0.0           # time.time()
    speed: float = 1.0
    updated: float = 0.0      # when the helper last spoke
    song_id: str | None = None
    track: tuple = field(default_factory=tuple)  # what identifies the track, to notice a new one


class Phone:
    def __init__(self) -> None:
        self.now = Snapshot()
        self._changed = asyncio.Event()
        self._lags: deque[float] = deque(maxlen=OFFSET_SAMPLES)
        self.heard: dict | None = None
        self.heard_at = 0.0

    def clock(self, sent_ms, received: float) -> float:
        """Add this to a time on the phone's clock (ms) for the server's. The fastest delivery
        seen bounds the difference best."""
        if isinstance(sent_ms, (int, float)) and sent_ms > 0:
            self._lags.append(received * 1000 - sent_ms)
        return min(self._lags) if self._lags else 0.0

    def hear(self, heard: dict, t: float) -> None:
        """The phone's mic named a song (listen.py): the watch hears of it like any change.
        `heard` holds where the song was at `t`."""
        self.heard, self.heard_at = heard, t
        self.bump()

    def position(self, t: float) -> float:
        s = self.now
        return s.position_ms + ((t - s.at) * 1000 * s.speed if s.playing else 0.0)

    def expire(self, t: float) -> None:
        """A helper silent for STALE_S while "playing" (killed, or its phone asleep) isn't
        trusted to be playing: its track is paused where it had got to by then, under a new
        version, so that the watch hears of it (only the view used to say so, and the watch,
        seeing no new version, followed the old one for good)."""
        s = self.now
        if (s.playing or s.buffering) and t - s.updated > STALE_S:
            at = s.updated + STALE_S
            s.position_ms, s.at, s.playing, s.buffering = self.position(at), at, False, False
            self.bump()

    def update(self, body: dict, received: float) -> bool:
        """Take an update from the helper. True when it is a different track."""
        sent = body.get("sentAt")
        late_ms = 0.0
        if isinstance(sent, (int, float)) and sent > 0:
            late_ms = max(0.0, received * 1000 - sent - self.clock(sent, received))
        title = str(body.get("title") or "").strip()
        artist = str(body.get("artist") or "").strip()
        app = str(body.get("app") or "")
        duration = body.get("durationMs")
        duration = int(duration) if isinstance(duration, (int, float)) and duration > 0 else None
        playing = body.get("state") == "playing"
        buffering = body.get("state") == "buffering"
        speed = float(body.get("speed") or 1.0) or 1.0
        position = float(body.get("positionMs") or 0.0) + (late_ms * speed if playing else 0.0)
        track = (app, name_key(title), name_key(artist), round(duration / 1000) if duration else None)
        s = self.now
        new_track = track != s.track
        moved = abs(position - self.position(received)) > 250
        changed = (new_track or playing != s.playing or buffering != s.buffering or (playing and moved)
                   or (not playing and abs(position - s.position_ms) > 250))
        s.app, s.title, s.artist, s.album = app, title, artist, (body.get("album") or None)
        s.duration_ms = duration
        s.playing, s.buffering, s.speed, s.position_ms, s.at, s.updated = playing, buffering, speed, position, received, received
        if new_track:
            s.track = track
            s.song_id = None
        if changed:
            self.bump()
        return new_track

    def bump(self) -> None:
        self.now.version += 1
        self._changed.set()
        self._changed = asyncio.Event()

    async def wait(self, since: int, timeout: float) -> Snapshot:
        """The state once its version differs from `since`, or after `timeout` whatever it is.
        A helper going quiet is a change too: the wait ends the moment it counts as gone."""
        self.expire(now())
        if self.now.version != since:
            return self.now
        if self.now.playing or self.now.buffering:
            timeout = min(timeout, max(0.0, self.now.updated + STALE_S - now()) + 0.01)
        changed = self._changed
        try:
            await asyncio.wait_for(changed.wait(), timeout)
        except asyncio.TimeoutError:
            pass
        self.expire(now())
        return self.now

    def view(self, t: float) -> dict:
        """What the watch gets: everything, with the position as of `t`."""
        self.expire(t)
        s = self.now
        return {
            "version": s.version,
            "app": s.app,
            "title": s.title,
            "artist": s.artist,
            "durationMs": s.duration_ms,
            "playing": s.playing,
            "active": s.playing or s.buffering,  # the player's music, sounding or about to: it comes first
            "positionMs": round(self.position(t)),
            "speed": s.speed,
            "songId": s.song_id,
            "ageMs": round((t - s.updated) * 1000) if s.updated else None,
            "heard": ({**self.heard, "positionMs": round(self.heard["positionMs"] + (t - self.heard_at) * 1000)}
                      if self.heard and t - self.heard_at < HEARD_FRESH_S else None),
        }


# ---- names --------------------------------------------------------------------------

_BRACKETS = re.compile(r"\s*[(\[][^)\]]*[)\]]")
_DASH_TAIL = re.compile(r"\s+-\s+(?:remaster(?:ed)?(?:\s+\d{4})?|\d{4}\s+remaster(?:ed)?|live|radio edit|single version|official (?:video|audio))\b.*$", re.I)
_FEAT = re.compile(r"\s+(?:\bfeat\b\.?|\bft\b\.?|\bfeaturing\b)\s.*$", re.I)  # not "with": "Dancing with Myself"
_NOT_WORD = re.compile(r"[^\w]+")
_CHANNEL = re.compile(r"\s*(?:-\s*topic|vevo|official)$", re.I)


def name_key(name: str) -> str:
    """A name as the same song's name from any source would read: "Wonderwall (Remastered)"
    and "wonderwall" are one song."""
    n = _BRACKETS.sub("", name or "")
    n = _DASH_TAIL.sub("", n)
    n = _FEAT.sub("", n)
    return _NOT_WORD.sub(" ", n.casefold()).strip()


def artist_key(artist: str) -> str:
    """The first artist, without a channel's decoration ("OasisVEVO", "Oasis - Topic")."""
    a = re.split(r"\s*(?:,|&|\bx\b|\bfeat\b\.?|\bft\b\.?)\s*", _CHANNEL.sub("", artist or ""), maxsplit=1, flags=re.I)[0]
    return name_key(a)


_VERSION_ONLY = re.compile(r"^(?:remaster(?:ed)?(?:\s+\d{4})?|\d{4}\s+remaster(?:ed)?|live\b.*|radio edit|single version|official (?:video|audio)|lyrics?|audio)\b", re.I)

YOUTUBE = "com.google.android.youtube"


def from_youtube(title: str, channel: str) -> tuple[str, str]:
    """YouTube's media session gives the video title and the channel: "Oasis - Wonderwall
    (Official Video)" from "OasisVEVO". Music videos read "Artist - Song", unless what follows
    the dash is only a version ("Wonderwall - Remastered")."""
    artist = _CHANNEL.sub("", channel or "").strip()
    if " - " in title:
        left, right = title.split(" - ", 1)
        if not _VERSION_ONLY.match(right.strip()):
            return right.strip(), left.strip()
    return title, artist


def now() -> float:
    return time.time()
