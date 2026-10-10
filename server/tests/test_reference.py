import asyncio
from dataclasses import dataclass

import numpy as np

from lezepplean import reference


def test_candidates_must_be_the_same_length_and_not_a_live_take():
    ok = reference.score_candidate({"title": "Wonderwall (Remastered)", "channel": "Oasis", "duration": 259}, "Wonderwall", "Oasis", 258.9)
    live = reference.score_candidate({"title": "Wonderwall (Live at Knebworth)", "channel": "Oasis", "duration": 259}, "Wonderwall", "Oasis", 258.9)
    long = reference.score_candidate({"title": "Wonderwall (Official Video)", "channel": "Oasis", "duration": 280}, "Wonderwall", "Oasis", 258.9)
    topic = reference.score_candidate({"title": "Wonderwall", "channel": "Oasis - Topic", "duration": 258}, "Wonderwall", "Oasis", 258.9)
    assert long is None
    assert ok > live
    assert topic > ok


@dataclass
class FakeMatch:
    offset_ms: float
    shazam_key: str
    title: str = "Song"


def recognizer(a_ms: float, b: float, key: str = "k", bad_cut: float | None = None):
    """A Shazam stand-in: answers from where the cut was taken (it measures the cut's
    position from the audio's sample index, which we encode in the signal)."""
    async def recognize(wav: bytes):
        import io
        import wave
        with wave.open(io.BytesIO(wav)) as w:
            first = np.frombuffer(w.readframes(1), dtype=np.int16)[0]
        start_ms = first * 1000.0  # the test signal holds "seconds" as the sample value
        if bad_cut is not None and abs(start_ms - bad_cut) < 500:
            return FakeMatch(0.0, "other")
        return FakeMatch(a_ms + (1 + b) * start_ms, key)
    return recognize


def staircase(seconds: int) -> np.ndarray:
    # sample value = whole seconds elapsed, in int16 steps (+0.5 so the float->int16
    # truncation in measure_mapping recovers it exactly)
    return ((np.repeat(np.arange(seconds), 16_000) + 0.5) / 32767).astype(np.float32)


def test_the_map_from_this_copy_to_the_watch_timeline_is_a_line():
    m = asyncio.run(reference.measure_mapping(staircase(240), recognizer(-425.0, 0.0003), "k", "Song"))
    assert m is not None and m.agreement == "5/5"
    assert abs(m.a_ms - -425) < 2 and abs(m.b - 0.0003) < 1e-5
    assert abs(m.to_canonical(100_000) - (100_000 * 1.0003 - 425)) < 2
    assert abs(m.to_reference(m.to_canonical(123_456)) - 123_456) < 1e-6


def test_a_copy_shazam_does_not_recognise_is_rejected():
    assert asyncio.run(reference.measure_mapping(staircase(240), recognizer(0, 0, key="else"), "k", "Song")) is None


def test_shazam_failing_on_the_cuts_is_not_a_verdict():
    async def broken(_wav):
        raise RuntimeError("rate limited")

    try:
        asyncio.run(reference.measure_mapping(staircase(240), broken, "k", "Song"))
    except reference.TransientError:
        pass
    else:
        raise AssertionError("expected TransientError")


def test_a_download_that_fails_is_tried_again_later_not_declared_absent(tmp_path, monkeypatch):
    from lezepplean import prepare
    from lezepplean.songs import Song, SongStore

    monkeypatch.setattr(reference, "search", lambda *a, **k: [reference.Candidate("vid", "Song", "Band", 200.0, 1.0)])

    def forbidden(*_a, **_k):
        raise RuntimeError("HTTP Error 403: Forbidden")

    monkeypatch.setattr(reference, "download", forbidden)
    p = prepare.Preparer(SongStore(tmp_path), recognize=None)
    try:
        asyncio.run(p._default_fetch(Song(id="s", title="Song", artist="Band", duration_ms=200_000)))
    except reference.TransientError:
        pass
    else:
        raise AssertionError("expected TransientError")


def test_youtube_not_answering_at_all_is_not_no_copies(monkeypatch):
    import yt_dlp

    class Down:
        def __init__(self, *_a, **_k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_a):
            return False

        def extract_info(self, *_a, **_k):
            raise RuntimeError("network unreachable")

    monkeypatch.setattr(yt_dlp, "YoutubeDL", Down)
    assert reference.search("Song", "Band", 200.0) is None
