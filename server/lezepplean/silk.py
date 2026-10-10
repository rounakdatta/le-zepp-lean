"""Loudness straight from SILK packets, and the loudness track a song *should* produce.

The watch can't afford to decode audio, so it reads one number per 60 ms packet: the
gain index of the packet's first 5 ms subframe (0..63, ~1.37 dB per step). On real
T-Rex 3 recordings it tracked loudness at r = 0.87. This module is the reference
implementation of that reader (watch-app/lib/silk.js must agree with it packet by
packet), plus `gain_track`: the same reader run over the song's own audio, encoded the
way the watch's recorder encodes (SILK wideband, 16 kHz, 60 ms packets, ~17 kbps).

The watch compares what it hears with that track. When the song itself goes quiet, a
quiet room is expected and the lyrics keep running; when the song should be loud and
the room is silent, the music has stopped.
"""

from __future__ import annotations

from fractions import Fraction

import numpy as np

TYPE_VAD = [232, 158, 10, 0]
TYPE_NO_VAD = [230, 0]
GAIN = [[224, 112, 44, 15, 3, 2, 1, 0], [254, 237, 192, 132, 70, 23, 4, 0], [255, 252, 226, 155, 61, 11, 2, 0]]
UNIFORM8 = [224, 192, 160, 128, 96, 64, 32, 0]

PACKET_MS = 60
# One character per 60 ms packet: a 4-minute song is 4,000 characters.
ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"


class RangeDecoder:
    """Minimal port of libopus ec_dec (RFC 6716 §4.1)."""

    def __init__(self, buf: bytes):
        self.buf, self.pos, self.rng = buf, 0, 128
        self.rem = self._byte()
        self.val = self.rng - 1 - (self.rem >> 1)
        self._normalize()

    def _byte(self) -> int:
        b = self.buf[self.pos] if self.pos < len(self.buf) else 0
        self.pos += 1
        return b

    def _normalize(self) -> None:
        while self.rng <= (1 << 23):
            self.rng <<= 8
            sym = self.rem
            self.rem = self._byte()
            sym = ((sym << 8) | self.rem) >> 1
            self.val = ((self.val << 8) + (255 & ~sym)) & ((1 << 31) - 1)

    def bit_logp(self, logp: int) -> int:
        s = self.rng >> logp
        ret = self.val < s
        if not ret:
            self.val -= s
        self.rng = s if ret else self.rng - s
        self._normalize()
        return int(ret)

    def icdf(self, table: list[int]) -> int:
        s, d = self.rng, self.val
        r = s >> 8
        ret = -1
        while True:
            t = s
            ret += 1
            s = r * table[ret]
            if not d < s:
                break
        self.val = d - s
        self.rng = t - s
        self._normalize()
        return ret


def silk_level(packet: bytes) -> tuple[int, int] | None:
    """(first-subframe gain index 0..63, number of VAD-active 20 ms frames) or None if not plain SILK."""
    if len(packet) < 2:
        return None
    toc = packet[0]
    config = toc >> 3
    if config > 11 or toc & 3:
        return None
    frame_ms = (10, 20, 40, 60)[config & 3]
    frames = 1 if frame_ms <= 20 else frame_ms // 20
    rd = RangeDecoder(packet[1:])
    vad = [rd.bit_logp(1) for _ in range(frames)]
    if rd.bit_logp(1):  # LBRR (in-band FEC) data would come first; not used by the watch recorder
        return None
    ix = rd.icdf(TYPE_VAD) + 2 if vad[0] else rd.icdf(TYPE_NO_VAD)
    gain = (rd.icdf(GAIN[ix >> 1]) << 3) + rd.icdf(UNIFORM8)
    return gain, sum(vad)


def encode_like_watch(audio: np.ndarray, bitrate: int = 17_000) -> list[bytes]:
    """16 kHz mono float audio -> Opus packets as the watch recorder makes them
    (libopus picks SILK wideband 60 ms single-frame packets at this rate in VoIP mode)."""
    import av

    enc = av.CodecContext.create("libopus", "w")
    enc.sample_rate = 16_000
    enc.layout = "mono"
    enc.format = "s16"
    enc.bit_rate = bitrate
    enc.time_base = Fraction(1, 16_000)
    enc.options = {"frame_duration": str(PACKET_MS), "application": "voip"}
    spf = 16 * PACKET_MS
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    n = len(pcm) // spf * spf
    packets: list[bytes] = []
    pts = 0
    for i in range(0, n, spf):
        frame = av.AudioFrame(format="s16", layout="mono", samples=spf)
        frame.planes[0].update(pcm[i:i + spf].tobytes())
        frame.sample_rate = 16_000
        frame.pts = pts
        pts += spf
        packets.extend(bytes(p) for p in enc.encode(frame))
    packets.extend(bytes(p) for p in enc.encode(None))
    return packets[: n // spf]


def gain_track(audio: np.ndarray) -> np.ndarray:
    """Gain index per 60 ms packet of `audio` as the watch would read it (uint8, 0..63)."""
    gains = []
    last = 0
    for p in encode_like_watch(audio):
        level = silk_level(p)
        last = level[0] if level else last  # a rare non-SILK packet repeats its neighbour
        gains.append(last)
    return np.array(gains, dtype=np.uint8)


def to_text(gains: np.ndarray) -> str:
    return "".join(ALPHABET[int(g) & 63] for g in gains)


def from_text(text: str) -> np.ndarray:
    lookup = {c: i for i, c in enumerate(ALPHABET)}
    return np.array([lookup[c] for c in text], dtype=np.uint8)
