"""The HTTP API end to end, with Shazam, LRCLIB and the preparation pipeline stubbed out."""
import base64
import importlib
import os

import numpy as np
import pytest
from fastapi.testclient import TestClient

from lezepplean import silk, track
from lezepplean.lyrics import Lyrics
from lezepplean.recognize import Match

SR = 16_000


def music(seconds: float, seed: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    out = np.zeros(int(seconds * SR), dtype=np.float32)
    t = 0
    while t < len(out):
        n = int(rng.uniform(0.15, 0.6) * SR)
        k = np.arange(min(n, len(out) - t))
        out[t:t + len(k)] += (np.sin(2 * np.pi * rng.uniform(150, 2000) * k / SR) * np.exp(-k / 4800)).astype(np.float32) * 0.5
        t += n
    return out


def watch_file(x: np.ndarray) -> str:
    framed = b"".join(len(p).to_bytes(4, "big") + b"\0\0\0\0" + p for p in silk.encode_like_watch(x))
    return base64.b64encode(framed).decode()


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("LEZEPPLEAN_DATA", str(tmp_path / "data"))
    monkeypatch.setenv("LEZEPPLEAN_CAPTURES", str(tmp_path / "captures"))
    monkeypatch.setenv("LEZEPPLEAN_WARM", "0")
    monkeypatch.delenv("LEZEPPLEAN_TOKEN", raising=False)
    from lezepplean import app as app_module
    app_module = importlib.reload(app_module)
    calls = {"shazam": 0, "ensure": []}

    async def recognize(_wav):
        calls["shazam"] += 1
        return Match(title="Song", artist="Band", album="LP", offset_ms=30_000.0, timeskew=0.0, apple_id="1",
                     isrc=None, shazam_key="k1", cover_url=None)

    async def duration(_id):
        return 60.0

    async def find(*_a):
        return Lyrics(kind="synced", lines=[(1000, "Hello  world"), (5000, ""), (9000, "Good night")], source="lrclib", source_id=7)

    monkeypatch.setattr(app_module._recognizer, "recognize", recognize)
    monkeypatch.setattr(app_module._lyrics, "itunes_duration_s", duration)
    monkeypatch.setattr(app_module._lyrics, "find", find)
    monkeypatch.setattr(app_module._preparer, "ensure", lambda song, pos: calls["ensure"].append((song.id, pos)))
    with TestClient(app_module.app) as client:
        yield client, app_module, calls


def test_a_new_song_comes_back_with_lyrics_and_starts_preparing(api):
    client, _, calls = api
    r = client.post("/identify", json={"audio": watch_file(music(5)), "purpose": "find"}).json()
    assert r["ok"] and r["song"]["id"] == "k1" and r["match"]["method"] == "shazam"
    assert r["lyrics"]["lines"][0] == [1000, "Hello world", None, None]   # whitespace normalised for the watch
    assert r["words"]["status"] == "pending"
    assert "envelope" not in r                                          # not computed yet
    assert calls["ensure"] and calls["ensure"][0][0] == "k1"


def test_lyrics_the_watch_already_has_are_not_sent_again(api):
    client, _, _ = api
    first = client.post("/identify", json={"audio": watch_file(music(5))}).json()
    v = first["lyrics"]["version"]
    again = client.post("/identify", json={"audio": watch_file(music(5)), "purpose": "sync", "song": "k1",
                                           "expectMs": 35_000, "known": {"lyrics": v}}).json()
    assert again["ok"] and "lyrics" not in again
    other = client.post("/identify", json={"audio": watch_file(music(5)), "purpose": "sync", "song": "k1",
                                           "known": {"lyrics": "stale"}}).json()
    assert other["lyrics"]["version"] == v


def test_a_known_song_is_re_synced_from_its_own_audio_without_shazam(api):
    client, app_module, calls = api
    client.post("/identify", json={"audio": watch_file(music(5))})
    store = app_module._store
    song = store.get("k1")
    x = music(60, seed=3)
    np.save(store.dir("k1") / "features.npy", track.features(x).astype(np.float16))
    song.reference = {"file": "reference.m4a", "map": {"aMs": 250.0, "b": 0.0, "agreement": "5/5", "residualMs": 1}}
    song.reference_status = "ready"
    store.put(song)
    before = calls["shazam"]
    window = x[int(20 * SR): int(23 * SR)] * 0.2
    r = client.post("/identify", json={"audio": watch_file(window), "purpose": "sync", "song": "k1", "expectMs": 20_250 + 800}).json()
    assert r["ok"] and r["match"]["method"] == "track"
    assert abs(r["match"]["offsetMs"] - (20_000 + 250)) < 30            # reference time mapped onto the watch's
    assert calls["shazam"] == before
    assert r["timing"]["totalMs"] < 500


def test_word_polls_get_new_word_timings_once(api):
    client, app_module, _ = api
    v0 = client.post("/identify", json={"audio": watch_file(music(5))}).json()["lyrics"]["version"]
    song = app_module._store.get("k1")
    song.words = {"status": "ready", "lines": {"0": [1020, [1020, 1500], 2100, 0.5]}}
    app_module._store.put(song)
    r = client.post("/lyrics", json={"song": "k1", "known": {"lyrics": v0}}).json()
    assert r["lyrics"]["lines"][0] == [1020, "Hello world", [1020, 1500], 2100]
    assert r["words"]["status"] == "ready"
    r2 = client.post("/lyrics", json={"song": "k1", "known": {"lyrics": r["lyrics"]["version"]}}).json()
    assert "lyrics" not in r2


def test_lrclib_being_down_does_not_save_a_song_as_lyric_less_forever(api, monkeypatch):
    client, app_module, _ = api
    down = {"on": True}

    async def find(*_a):
        if down["on"]:
            return Lyrics(kind="none", definite=False)
        return Lyrics(kind="synced", lines=[(1000, "Hello world")], source="lrclib", source_id=7)

    monkeypatch.setattr(app_module._lyrics, "find", find)
    r = client.post("/identify", json={"audio": watch_file(music(5))}).json()
    assert r["lyrics"]["kind"] == "none"
    song = app_module._store.get("k1")
    assert song.lyrics_retry_at > 0                     # asked again later, not "none" for good
    down["on"] = False
    song.lyrics_retry_at = 1.0                         # the retry time has come
    app_module._store.put(song)
    client.post("/lyrics", json={"song": "k1"})         # starts the lookup, in the background
    import time
    for _ in range(100):
        if app_module._store.get("k1").lyrics_kind == "synced":
            break
        time.sleep(0.02)
    r = client.post("/lyrics", json={"song": "k1"}).json()
    assert r["lyrics"]["kind"] == "synced"
    assert r["words"]["status"] == "pending"


def test_a_slow_lrclib_does_not_hold_up_the_answer(api, monkeypatch):
    import asyncio
    import time

    client, app_module, _ = api
    client.post("/identify", json={"audio": watch_file(music(5))})
    song = app_module._store.get("k1")
    song.lyrics_retry_at = 1.0
    app_module._store.put(song)

    async def slow(*_a):
        await asyncio.sleep(2)
        return Lyrics(kind="synced", lines=[(1000, "Hello world")], source="lrclib", source_id=7)

    monkeypatch.setattr(app_module._lyrics, "find", slow)
    t = time.perf_counter()
    r = client.post("/lyrics", json={"song": "k1"})
    assert r.status_code == 200 and time.perf_counter() - t < 1.0   # the phone gives up after 9.5 s
    assert app_module._store.get("k1").lyrics_retry_at > time.time() + 60  # and a second request won't start a second lookup


def test_lyrics_chosen_without_the_track_length_are_checked_again(api, monkeypatch):
    client, app_module, _ = api

    async def itunes_down(_id):
        return None, False

    monkeypatch.setattr(app_module._lyrics, "itunes_lookup", itunes_down)
    async def find_with_length(*_a):
        return Lyrics(kind="synced", lines=[(1000, "Hello world")], source="lrclib", source_id=7, duration_s=187.0)

    monkeypatch.setattr(app_module._lyrics, "find", find_with_length)
    r = client.post("/identify", json={"audio": watch_file(music(5))}).json()
    assert r["lyrics"]["kind"] == "synced"
    # synced lyrics, but picked without the same-recording check: ask again later
    assert app_module._store.get("k1").lyrics_retry_at > 0
    # meanwhile the watch still gets a length (LRCLIB's), or it couldn't tell when the song ends
    assert r["song"]["durationMs"] == 187_000


def test_the_watch_is_told_when_short_windows_are_enough(api):
    client, app_module, _ = api
    r = client.post("/identify", json={"audio": watch_file(music(5))}).json()
    assert r["sync"] == {"fast": False}                 # no reference audio yet: send enough for Shazam
    store = app_module._store
    song = store.get("k1")
    np.save(store.dir("k1") / "features.npy", track.features(music(30)).astype(np.float16))
    song.reference = {"file": "reference.m4a", "map": {"aMs": 0.0, "b": 0.0, "agreement": "5/5", "residualMs": 1}}
    song.reference_status = "ready"
    store.put(song)
    r = client.post("/lyrics", json={"song": "k1"}).json()
    assert r["sync"] == {"fast": True}


def test_the_loudness_track_is_sent_once_and_again_only_when_it_changes(api):
    client, app_module, _ = api
    client.post("/identify", json={"audio": watch_file(music(5))})
    song = app_module._store.get("k1")
    song.envelope = {"version": "e1", "startMs": -100.0, "stepMs": 60.0, "data": "ABC"}
    app_module._store.put(song)
    first = client.post("/lyrics", json={"song": "k1"}).json()
    assert first["envelope"]["data"] == "ABC"
    again = client.post("/lyrics", json={"song": "k1", "known": {"lyrics": first["lyrics"]["version"], "envelope": "e1"}}).json()
    assert "envelope" not in again and "lyrics" not in again
    song.envelope = {"version": "e2", "startMs": -100.0, "stepMs": 60.0, "data": "ABD"}
    app_module._store.put(song)
    changed = client.post("/lyrics", json={"song": "k1", "known": {"envelope": "e1"}}).json()
    assert changed["envelope"]["version"] == "e2"


def test_unusable_audio_is_reported_not_crashed_on(api):
    client, _, _ = api
    r = client.post("/identify", json={"audio": base64.b64encode(b"OggS" + b"\0" * 40).decode()}).json()
    assert r["ok"] is False and r["reason"] == "bad_audio"


def test_the_token_is_required_when_set(api, monkeypatch):
    client, app_module, _ = api
    monkeypatch.setattr(app_module, "TOKEN", "s3cret")
    assert client.get("/health").status_code == 401
    assert client.get("/health", headers={"Authorization": "Bearer s3cret"}).status_code == 200
    for path in ("/recent", "/songs"):
        assert client.get(path).status_code == 401, path
    assert client.post("/lyrics", json={"song": "x"}).status_code == 401


def test_the_kubelet_probe_needs_no_token_and_learns_nothing(api, monkeypatch):
    client, app_module, _ = api
    monkeypatch.setattr(app_module, "TOKEN", "s3cret")
    r = client.get("/livez")
    assert r.status_code == 200 and r.json() == {"ok": True}
