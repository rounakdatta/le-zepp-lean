import math
import struct

import pytest

from lezepplean import zepp_opus


def _tone(seconds: float, freq: float = 440.0) -> bytes:
    n = int(seconds * zepp_opus.SAMPLE_RATE)
    return b"".join(
        struct.pack("<h", int(12000 * math.sin(2 * math.pi * freq * i / zepp_opus.SAMPLE_RATE))) for i in range(n)
    )


def test_round_trip_keeps_duration():
    framed = zepp_opus.encode(_tone(2.0))
    clip = zepp_opus.decode(framed)
    assert clip.packets == 101  # 100 x 20 ms frames + encoder flush
    assert abs(clip.duration_ms - 2000) <= 40
    assert clip.trailing_bytes == 0


def test_truncated_last_packet_is_ignored():
    framed = zepp_opus.encode(_tone(1.0))
    clip = zepp_opus.decode(framed[:-5])
    assert clip.trailing_bytes > 0
    assert clip.packets == zepp_opus.decode(framed).packets - 1


def test_rejects_non_zepp_data():
    with pytest.raises(zepp_opus.ZeppOpusError):
        zepp_opus.decode(b"OggS" + b"\x00" * 60)


def test_rejects_empty_recording():
    # The recorder can leave a 0-byte file when the mic is locked (zepp-health discussion #556).
    with pytest.raises(zepp_opus.ZeppOpusError):
        zepp_opus.decode(b"")
