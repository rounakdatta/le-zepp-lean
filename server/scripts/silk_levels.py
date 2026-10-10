"""Read the per-packet SILK gain index (a loudness proxy) and VAD flags from Zepp recorder
clips, without decoding audio. Reference implementation for watch-app/lib/silk.js.

    uv run python scripts/silk_levels.py captures/*.zepp.opus
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lezepplean import zepp_opus  # noqa: E402

TYPE_VAD = [232, 158, 10, 0]
TYPE_NO_VAD = [230, 0]
GAIN = [[224, 112, 44, 15, 3, 2, 1, 0], [254, 237, 192, 132, 70, 23, 4, 0], [255, 252, 226, 155, 61, 11, 2, 0]]
UNIFORM8 = [224, 192, 160, 128, 96, 64, 32, 0]


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


if __name__ == "__main__":
    for path in sys.argv[1:]:
        packets, _ = zepp_opus.split_packets(Path(path).read_bytes())
        levels = [silk_level(p) for p in packets]
        print(Path(path).name, " ".join(str(l[0]) if l else "-" for l in levels))
