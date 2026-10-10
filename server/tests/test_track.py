"""Fast re-sync: placing a short recording inside a known song."""
import numpy as np

from lezepplean import track

SR = 16_000


def song(seconds: float, seed: int) -> np.ndarray:
    """Something with musical structure: notes with onsets and a changing spectrum."""
    rng = np.random.default_rng(seed)
    out = np.zeros(int(seconds * SR), dtype=np.float32)
    t = 0
    while t < len(out):
        n = int(rng.uniform(0.15, 0.6) * SR)
        f = rng.uniform(150, 2000)
        k = np.arange(min(n, len(out) - t))
        out[t:t + len(k)] += (np.sin(2 * np.pi * f * k / SR) * np.exp(-k / (0.3 * SR))).astype(np.float32) * rng.uniform(0.2, 0.8)
        t += n
    return out + rng.standard_normal(len(out)).astype(np.float32) * 0.01


def test_a_window_is_placed_to_within_a_frame_of_where_it_was_cut():
    x = song(60, 1)
    ref = track.features(x)
    for start_s in (5.0, 21.37, 40.5):
        win = x[int(start_s * SR): int((start_s + 2.0) * SR)] * 0.3  # quieter, as in a room
        got = track.locate(win, ref, start_s * 1000 + 700)          # the clock was 700 ms off
        assert abs(got.offset_ms - start_s * 1000) < 12, (start_s, got)
        assert got.score > 0.6 and got.margin > 0.2


def test_another_song_is_not_believed():
    a, b = song(60, 1), song(60, 2)
    got = track.locate(b[SR * 10: SR * 12], track.features(a), 10_000)
    assert got.score < 0.35 or got.margin < 0.08


def test_without_a_prediction_the_whole_song_is_searched():
    x = song(60, 3)
    got = track.locate(x[SR * 47: SR * 50], track.features(x), None)
    assert abs(got.offset_ms - 47_000) < 12


def test_too_little_audio_is_not_placed():
    x = song(20, 4)
    assert track.locate(x[: SR // 4], track.features(x), 0) is None
