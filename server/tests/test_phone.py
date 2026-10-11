"""What the phone is playing (the helper app's media-session updates) and how it reaches the watch."""

import asyncio
import threading
import time

from lezepplean import phone
from lezepplean.lyrics import Lyrics
from test_api import api, music, watch_file  # noqa: F401  (the api fixture)

SPOTIFY = "com.spotify.music"


def update(**kw):
    body = {"app": SPOTIFY, "title": "Song", "artist": "Band", "durationMs": 200_000, "state": "playing", "positionMs": 10_000, "speed": 1.0}
    body.update(kw)
    return body


def test_a_late_update_is_moved_on_by_how_late_it_was():
    p = phone.Phone()
    # two deliveries: the first fast (it sets the clock offset), the second 300 ms slower
    p.update(update(positionMs=10_000, sentAt=1_000_000), 1_000.050)
    p.update(update(positionMs=20_000, sentAt=1_010_000), 1_010.350)
    assert abs(p.position(1_010.350) - 20_300) < 1, "it was playing for those 300 ms"


def test_a_heartbeat_wakes_nobody_but_a_pause_a_seek_or_a_new_track_does():
    p = phone.Phone()
    p.update(update(positionMs=10_000), 100.0)
    v = p.now.version
    p.update(update(positionMs=20_000), 110.0)              # 10 s later, 10 s on: nothing new
    assert p.now.version == v
    p.update(update(positionMs=20_100, state="paused"), 110.1)
    assert p.now.version == v + 1 and not p.now.playing
    p.update(update(positionMs=60_000, state="paused"), 112.0)   # dragged while paused
    assert p.now.version == v + 2
    assert p.update(update(title="Other Song", positionMs=0), 113.0) is True
    assert p.now.version == v + 3 and p.now.song_id is None


def test_a_helper_gone_quiet_is_marked_stale_and_its_music_taken_to_play_on():
    """Android holds the helper back while the phone's screen is off: marked paused (as at
    first), the lyrics froze while YouTube Music played on."""
    p = phone.Phone()
    p.update(update(), 100.0)
    v = p.view(120.0)
    assert v["playing"] is True and v["stale"] is False
    late = p.view(100.0 + phone.STALE_S + 5)
    assert late["playing"] is True and late["stale"] is True and late["version"] == v["version"] + 1
    assert late["positionMs"] == 10_000 + round((phone.STALE_S + 5) * 1000), "and its position runs on"
    p.update(update(positionMs=60_000), 100.0 + phone.STALE_S + 10)
    fresh = p.view(100.0 + phone.STALE_S + 10)
    assert fresh["stale"] is False and fresh["version"] == late["version"] + 1, "it spoke: the watch hears so"


def test_names_from_any_source_meet():
    assert phone.name_key("Here Comes the Sun - Remastered 2009") == phone.name_key("here comes the sun")
    assert phone.name_key("Señorita (feat. Camila Cabello)") == phone.name_key("Señorita")
    assert phone.name_key("Dancing with Myself") == "dancing with myself"
    assert phone.artist_key("OasisVEVO") == phone.artist_key("Oasis - Topic") == "oasis"
    assert phone.artist_key("Daft Punk & Pharrell Williams") == "daft punk"
    assert phone.from_youtube("Oasis - Wonderwall (Official Video)", "OasisVEVO") == ("Wonderwall (Official Video)", "Oasis")
    assert phone.from_youtube("Wonderwall - Remastered", "Oasis - Topic") == ("Wonderwall - Remastered", "Oasis")


def test_the_watch_hears_of_a_change_the_moment_it_happens(api):
    client, app_module, _ = api
    client.post("/phone", json=update())
    first = client.get("/phone/next", params={"since": -1}).json()
    got = {}

    def ask():
        t = time.perf_counter()
        got["state"] = client.get("/phone/next", params={"since": first["version"], "wait": 8}).json()
        got["waited"] = time.perf_counter() - t

    asker = threading.Thread(target=ask)
    asker.start()
    time.sleep(0.5)
    client.post("/phone", json=update(state="paused", positionMs=10_600))
    asker.join(10)
    assert got["state"]["playing"] is False
    assert got["waited"] < 2.0, "answered on the change, not at the end of the wait"


def test_a_track_from_the_phone_gets_its_lyrics_and_word_timing(api):
    client, app_module, calls = api
    client.post("/phone", json=update())
    for _ in range(50):
        view = client.get("/phone/next", params={"since": -1}).json()
        song = app_module._store.get(view["songId"]) if view["songId"] else None
        if song is not None and song.lyrics_kind == "synced":
            break
        time.sleep(0.05)
    assert view["title"] == "Song" and view["playing"] is True and view["songId"].startswith("p")
    assert song.lyrics_kind == "synced" and song.duration_ms == 200_000
    assert any(sid == view["songId"] for sid, _ in calls["ensure"]), "word timing is on its way"
    r = client.post("/lyrics", json={"song": view["songId"]}).json()
    assert r["lyrics"]["lines"][0][1] == "Hello world"


def test_a_song_heard_in_the_room_is_the_same_song_on_the_phone(api):
    client, app_module, _ = api
    client.post("/identify", json={"audio": watch_file(music(5)), "purpose": "find"})   # Shazam: "Song" by "Band", id k1
    song = app_module._store.get("k1")
    song.duration_ms = 200_500
    app_module._store.put(song)
    client.post("/phone", json=update(title="Song (Remastered)", artist="Band - Topic"))
    for _ in range(50):
        view = client.get("/phone/next", params={"since": -1}).json()
        if view["songId"]:
            break
        time.sleep(0.05)
    assert view["songId"] == "k1", "its lyrics and word timings are already here"


def test_youtube_videos_are_named_by_their_title(api, monkeypatch):
    client, app_module, _ = api
    seen = {}

    async def find(title, artist, album, duration_s):
        seen["asked"] = (title, artist)
        return Lyrics(kind="synced", lines=[(1000, "Hello world")], source="lrclib", source_id=7)

    monkeypatch.setattr(app_module._lyrics, "find", find)
    client.post("/phone", json=update(app=phone.YOUTUBE, title="Oasis - Wonderwall (Official Video)", artist="OasisVEVO"))
    for _ in range(50):
        if "asked" in seen:
            break
        time.sleep(0.05)
    assert seen["asked"] == ("Wonderwall (Official Video)", "Oasis")


def test_a_lyrics_lookup_that_fails_is_retried_while_the_song_plays(api, monkeypatch):
    client, app_module, _ = api
    monkeypatch.setattr(app_module, "PHONE_LYRICS_RETRY_S", (0.2, 0.2, 0.2))
    tries = {"n": 0}

    async def flaky(title, artist, album, duration_s):
        tries["n"] += 1
        if tries["n"] == 1:   # LRCLIB timed out: not an answer
            return Lyrics(kind="none", definite=False)
        return Lyrics(kind="synced", lines=[(1000, "Hello world")], source="lrclib", source_id=7)

    monkeypatch.setattr(app_module._lyrics, "find", flaky)
    client.post("/phone", json=update(title="Sorry if I Hurt You", artist="Charli xcx", durationMs=161_000))
    seen = set()
    for _ in range(60):
        view = client.get("/phone/next", params={"since": -1}).json()
        if view["songId"]:
            kind = client.post("/lyrics", json={"song": view["songId"]}).json()["lyrics"]["kind"]
            seen.add(kind)
            if kind == "synced":
                break
        time.sleep(0.05)
    assert kind == "synced", "found on the retry, without anyone asking"
    assert "none" not in seen, "the watch was never told there are no lyrics"


def test_a_helper_gone_quiet_is_heard_of_at_once(monkeypatch):
    """After STALE_S of silence it is marked stale under a new version, and a long poll waiting
    for news gets that then (only the view used to say anything, and nothing passed it on)."""
    monkeypatch.setattr(phone, "STALE_S", 0.3)
    p = phone.Phone()
    p.update(update(), time.time())
    v = p.now.version

    async def poll():
        t = time.perf_counter()
        snap = await p.wait(v, 5.0)
        return snap, time.perf_counter() - t

    snap, waited = asyncio.run(poll())
    assert snap.version == v + 1 and snap.stale and snap.playing
    assert waited < 1.0, "woken as the helper went quiet, not at the end of the poll"


def test_what_the_helper_said_lately_can_be_looked_at(api):
    client, app_module, _ = api
    client.post("/phone", json={"app": SPOTIFY, "title": "Song", "artist": "Band", "state": "playing", "positionMs": 1000,
                                "sentAt": time.time() * 1000})
    client.post("/phone", json={"app": SPOTIFY, "title": "Song", "artist": "Band", "state": "paused", "positionMs": 2000,
                                "sentAt": time.time() * 1000})
    recent = client.get("/phone/recent").json()
    assert [r["state"] for r in recent[:2]] == ["paused", "playing"]
    assert recent[0]["title"] == "Song" and recent[0]["agoS"] >= 0
