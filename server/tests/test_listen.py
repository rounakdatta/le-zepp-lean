"""The phone listening too: what its mic hears is named, and reaches the watch with the song
where it is now."""

import base64
import threading
import time

import numpy as np

from lezepplean import listen
from lezepplean.recognize import Match, RecognizerBusy
from test_api import api, music, watch_file  # noqa: F401  (the api fixture)

HALF_S = listen.RATE // 2


def piece(seconds=0.5, seed=0):
    x = (np.random.default_rng(seed).standard_normal(int(listen.RATE * seconds)) * 3000).astype(np.int16)
    return base64.b64encode(x.tobytes()).decode()


def match(offset_ms=30_000.0):
    return Match(title="Song", artist="Band", album="LP", offset_ms=offset_ms, timeskew=0.0, apple_id="1",
                 isrc=None, shazam_key="k1", cover_url=None)


def stream(client, n, started_ms, session="r1", first=0):
    out = []
    for i in range(first, first + n):
        body = {"session": session, "startedAt": started_ms, "offset": i * HALF_S, "pcm": piece(seed=i),
                "sentAt": time.time() * 1000}
        out.append(client.post("/listen/audio", json=body).json())
    return out


def settle(cond, seconds=3.0):
    end = time.time() + seconds
    while time.time() < end and not cond():
        time.sleep(0.02)
    return cond()


def test_what_the_phone_hears_is_named_and_the_watch_gets_the_song_where_it_is_now(api, monkeypatch):
    client, app_module, _ = api
    asked = []

    async def recognize(wav):
        asked.append(len(wav))
        return match(30_000)

    monkeypatch.setattr(app_module._recognizer, "recognize", recognize)
    started = time.time() * 1000 - 2500  # the recording began 2.5 s ago
    replies = stream(client, 5, started)  # 2.5 s of it: Shazam is asked
    assert not replies[3]["done"]
    assert settle(lambda: app_module._phone.heard is not None)
    view = client.get("/phone/next?since=-1&wait=0").json()
    heard = view["heard"]
    assert heard["songId"] == "k1" and heard["title"] == "Song"
    # where the song is now: where the recording began, plus how long ago that was
    now_ms = time.time() * 1000
    assert abs(heard["positionMs"] - (30_000 + now_ms - started)) < 400
    assert len(asked) == 1
    assert stream(client, 1, started, first=5)[0]["done"], "named: the phone stops listening"


def test_not_named_from_the_first_seconds_it_is_asked_again_with_more(api, monkeypatch):
    client, app_module, _ = api
    answers = [None, match()]

    async def recognize(_wav):
        return answers.pop(0)

    monkeypatch.setattr(app_module._recognizer, "recognize", recognize)
    started = time.time() * 1000
    stream(client, 5, started)
    assert settle(lambda: len(answers) == 1)
    assert app_module._phone.heard is None
    stream(client, 3, started, first=5)  # 4 s now
    assert settle(lambda: app_module._phone.heard is not None)


def test_while_the_phone_plays_music_its_mic_is_never_used(api, monkeypatch):
    client, app_module, _ = api
    asked = []

    async def recognize(_wav):
        asked.append(1)
        return match()

    monkeypatch.setattr(app_module._recognizer, "recognize", recognize)
    client.post("/phone", json={"app": "com.spotify.music", "title": "Other", "artist": "X", "state": "playing",
                                "positionMs": 1000, "sentAt": time.time() * 1000})
    replies = stream(client, 6, time.time() * 1000)
    assert replies[0]["done"] and replies[0]["reason"] == "phone_playing"
    time.sleep(0.2)
    assert asked == []


def test_shazam_refusing_ends_the_listening_after_one_try(api, monkeypatch):
    client, app_module, _ = api
    asked = []

    async def busy(_wav):
        asked.append(1)
        raise RecognizerBusy(30)

    monkeypatch.setattr(app_module._recognizer, "recognize", busy)
    started = time.time() * 1000
    stream(client, 5, started)
    assert settle(lambda: stream(client, 1, started, "r1")[0]["done"])
    stream(client, 4, started)
    assert asked == [1]


def test_a_piece_sent_twice_or_lost_never_shifts_the_timing():
    r = listen.Listening("r", 0.0)
    a, b, c = b"\x01\x00" * HALF_S, b"\x02\x00" * HALF_S, b"\x03\x00" * HALF_S
    r.put(0, a)
    r.put(HALF_S, b)
    r.put(HALF_S, b)  # sent again: it lands where it was
    assert r.seconds == 1.0
    r.put(3 * HALF_S, c)  # the third piece was lost: silence where it was, the fourth in place
    assert r.seconds == 2.0
    assert bytes(r.pcm[2 * HALF_S * 2: 3 * HALF_S * 2]) == bytes(HALF_S * 2)
    assert bytes(r.pcm[3 * HALF_S * 2:]) == c


def test_the_watch_hears_of_it_the_moment_it_is_named(api, monkeypatch):
    client, app_module, _ = api

    async def recognize(_wav):
        return match()

    monkeypatch.setattr(app_module._recognizer, "recognize", recognize)
    since = client.get("/phone/next?since=-1&wait=0").json()["version"]
    got = {}

    def poll():
        t = time.perf_counter()
        got["view"] = client.get(f"/phone/next?since={since}&wait=8").json()
        got["s"] = time.perf_counter() - t

    th = threading.Thread(target=poll)
    th.start()
    time.sleep(0.2)
    stream(client, 5, time.time() * 1000)
    th.join(10)
    assert got["view"]["heard"]["songId"] == "k1"
    assert got["s"] < 3, "woken by the news, not at the end of the poll"


def test_silence_is_not_asked_about(api, monkeypatch):
    client, app_module, _ = api
    asked = []

    async def recognize(_wav):
        asked.append(1)
        return match()

    monkeypatch.setattr(app_module._recognizer, "recognize", recognize)
    started = time.time() * 1000
    quiet = base64.b64encode(bytes(HALF_S * 2)).decode()
    for i in range(12):
        client.post("/listen/audio", json={"session": "q", "startedAt": started, "offset": i * HALF_S, "pcm": quiet})
    time.sleep(0.3)
    assert asked == [], "no Shazam call spent on a silent room"
