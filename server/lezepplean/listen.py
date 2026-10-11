"""The phone listening too.

When the watch looks for a song, the LeZeppLean helper on the phone records as well: a far
better mic than the watch's, and not on a moving wrist. It streams what it hears here in
half-second pieces. Shazam is asked once there are 2.5 s of it, and again with more. The
first answer reaches the watch through the phone channel (phone.py, `heard`), where the
watch's own search may already have got there: whichever is first wins.

Every piece says where its first sample sits in the recording, so a piece sent twice lands
in the same place, and a lost one leaves silence instead of shifting what follows (the song's
position is counted from the recording's first sample).
"""

from __future__ import annotations

from dataclasses import dataclass, field

RATE = 16_000
ASK_AT_S = (2.5, 4.0, 6.0)  # seconds of audio at which Shazam is asked (within its budget)
MAX_S = 8.0                 # the helper stops listening after this much
KEEP_S = 60.0               # a recording nothing has been added to for this long is forgotten
MAX_AGE_S = MAX_S + 20      # audio that began longer ago than this is too old to name as playing now
LIMIT = int((MAX_S + 2) * RATE) * 2  # bytes: no recording grows past this, whatever a piece claims
QUIET_DB = -55.0            # quieter than this (RMS, dBFS) is no music to name: no Shazam call spent on it


@dataclass
class Listening:
    id: str
    start_at: float           # server time of the recording's first sample
    pcm: bytearray = field(default_factory=bytearray)
    asked: int = 0            # how many of ASK_AT_S have been asked
    asking: bool = False
    done: bool = False
    reason: str | None = None  # found | no_match | busy | phone_playing
    updated: float = 0.0

    @property
    def seconds(self) -> float:
        return len(self.pcm) / 2 / RATE

    def put(self, offset: int, data: bytes) -> None:
        """16-bit samples from `offset` (counted from the recording's first) on. Nothing past
        LIMIT: a piece claiming a far offset used to zero-fill the buffer up to it."""
        a = offset * 2
        if offset < 0 or a >= LIMIT:
            return
        data = data[: min(len(data), LIMIT - a) // 2 * 2]  # whole samples only
        if a > len(self.pcm):
            self.pcm.extend(bytes(a - len(self.pcm)))
        self.pcm[a: a + len(data)] = data

    def due(self) -> bool:
        """Enough new audio to ask Shazam again."""
        return not self.done and not self.asking and self.asked < len(ASK_AT_S) and self.seconds >= ASK_AT_S[self.asked]

    def finish(self, reason: str) -> None:
        self.done, self.reason = True, reason


class Recordings:
    def __init__(self) -> None:
        self._all: dict[str, Listening] = {}

    def get(self, rid: str, start_at: float, now: float) -> Listening:
        for k in [k for k, v in self._all.items() if now - v.updated > KEEP_S]:
            del self._all[k]
        r = self._all.get(rid)
        if r is None:
            r = self._all[rid] = Listening(rid, start_at)
        r.updated = now
        return r
