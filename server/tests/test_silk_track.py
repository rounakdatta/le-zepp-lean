"""The loudness track the watch follows, made with the watch's own codec settings."""
import numpy as np

from lezepplean import silk

SR = 16_000


def test_packets_are_the_watch_recorders_kind():
    t = np.arange(SR * 2) / SR
    packets = silk.encode_like_watch((0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32))
    assert len(packets) == 33                      # 2 s of 60 ms packets
    assert {(p[0] >> 3, p[0] & 3) for p in packets} == {(11, 0)}  # SILK wideband, 60 ms, one frame


def test_the_track_is_loud_where_the_song_is_and_quiet_where_it_is_not():
    t = np.arange(SR * 3) / SR
    x = (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    x[SR: 2 * SR] *= 0.003                          # a near-silent second in the middle
    g = silk.gain_track(x).astype(int)
    assert len(g) == 50
    loud = np.r_[g[3:14], g[37:47]].mean()
    quiet = g[20:31].mean()
    assert loud - quiet > 20                        # ~1.37 dB per step: the 50 dB dip shows


def test_text_round_trip_one_character_per_packet():
    g = np.array([0, 17, 31, 63, 5], dtype=np.uint8)
    s = silk.to_text(g)
    assert len(s) == 5
    assert (silk.from_text(s) == g).all()
