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


def test_the_silence_before_a_song_is_never_where_a_window_goes():
    # Copies of songs start after a moment of digital silence. A take that is quiet and then
    # loud (the music came back, or another song came in) rises in every band at once, as the
    # song does there, and was placed there: the lyrics jumped back to the song's start.
    x = np.concatenate([np.zeros(SR, np.float32), song(60, 5)])
    quiet = np.random.default_rng(0).standard_normal(SR // 2).astype(np.float32) * 1e-3
    take = np.concatenate([quiet, song(10, 6)[: int(2.2 * SR)] * 0.3])
    ref = track.features(x)
    got = track.locate(take, ref, None)
    assert got is None or got.offset_ms >= 990
    # while the song itself, just after its silence, is placed there
    own = track.locate(x[int(1.2 * SR): int(3.4 * SR)] * 0.3, ref, None)
    assert abs(own.offset_ms - 1200) < 12


def test_a_place_must_agree_in_the_shape_of_the_spectrum():
    x = song(60, 7)
    ref = track.features(x)
    win = x[int(21.37 * SR): int(23.37 * SR)] * 0.3
    assert track.agreement(win, ref, 21_370) > 0.5                       # the right place
    assert track.agreement(win, ref, 33_000) < 0.25                      # another
    assert track.agreement(song(10, 8)[: 2 * SR], ref, 21_370) < 0.25    # another song
    assert track.agreement(win, ref, 59_500) == -1.0                     # past the end
