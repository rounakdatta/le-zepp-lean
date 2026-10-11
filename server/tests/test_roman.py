"""Lyrics in a script the watch can't draw go out in English letters, timed word by word in them."""

import asyncio
import time

from lezepplean import prepare, reference, roman
from lezepplean.lyrics import Lyrics
from lezepplean.songs import Song, SongStore, lyrics_payload
from test_api import api, music, watch_file  # noqa: F401  (the api fixture)

HINDI = [(1000, "मुझको इतना बताए कोई"), (4000, ""), (6000, "कैसे तुझसे दिल ना लगाए कोई")]
ROMAN = ["mujhko itna bataye koi", "", "kaise tujhse dil na lagaye koi"]


def test_the_script_is_the_one_most_letters_are_in():
    assert roman.script_of(["मुझको इतना बताए कोई"]) == "Devanagari"
    assert roman.script_of(["তোমার নামের রোদ্দুরে"]) == "Bengali"
    assert roman.script_of(["Tum hi ho, ab tum hi ho"]) is None
    assert roman.script_of(["I wanna dance with you tonight, baby, all night long", "दिल"]) is None, "mostly English"


def test_a_hindi_song_says_pending_until_it_is_in_english_letters(api, monkeypatch):
    client, app_module, _ = api

    async def find(*_a):
        return Lyrics(kind="synced", lines=HINDI, source="lrclib", source_id=7)

    async def slow_romanize(_client, lines, title, artist):
        await asyncio.sleep(0.4)
        return ROMAN

    monkeypatch.setattr(app_module._lyrics, "find", find)
    monkeypatch.setattr(roman, "romanize", slow_romanize)
    r = client.post("/identify", json={"audio": watch_file(music(5)), "purpose": "find"}).json()
    assert r["lyrics"]["kind"] == "pending", "never the Devanagari the watch would draw wrong"
    for _ in range(40):
        r2 = client.post("/lyrics", json={"song": "k1"}).json()
        if r2["lyrics"]["kind"] == "synced":
            break
        time.sleep(0.05)
    assert [l[1] for l in r2["lyrics"]["lines"]] == ROMAN


def test_a_gateway_that_fails_is_asked_again(api, monkeypatch):
    client, app_module, _ = api
    monkeypatch.setattr(app_module, "ROMAN_RETRY_S", (0.2, 0.2))
    tries = {"n": 0}

    async def find(*_a):
        return Lyrics(kind="synced", lines=HINDI, source="lrclib", source_id=7)

    async def flaky(_client, lines, title, artist):
        tries["n"] += 1
        return None if tries["n"] == 1 else ROMAN

    monkeypatch.setattr(app_module._lyrics, "find", find)
    monkeypatch.setattr(roman, "romanize", flaky)
    client.post("/identify", json={"audio": watch_file(music(5)), "purpose": "find"})
    for _ in range(40):
        r = client.post("/lyrics", json={"song": "k1"}).json()
        if r["lyrics"]["kind"] == "synced":
            break
        time.sleep(0.05)
    assert r["lyrics"]["kind"] == "synced" and tries["n"] == 2


def test_word_timing_is_done_on_the_words_the_watch_shows(tmp_path):
    store = SongStore(tmp_path)
    song = Song(id="s", title="Kesariya", artist="Arijit Singh", lyrics_kind="synced", lrc=[list(x) for x in HINDI],
                script="Devanagari", roman=list(ROMAN), reference_status="ready",
                reference={"file": "reference.m4a", "map": {"aMs": 0.0, "b": 0.0, "agreement": "5/5", "residualMs": 1}})
    song.words = {"status": "pending"}
    store.put(song)
    seen = {}

    async def call(fn, *args):
        seen["texts"] = [t for _, t in args[2]]
        return {"lines": {}, "seconds": 0.1, "modelSeconds": 0.1}

    p = prepare.Preparer(store, recognize=None)
    p._call = call
    asyncio.run(p._run(prepare.Job(3, 0, "s", "rest", None)))
    assert seen["texts"] == ROMAN


def test_without_its_romanization_a_hindi_song_is_not_aligned_at_all(tmp_path):
    store = SongStore(tmp_path)
    song = Song(id="s", title="Kesariya", artist="Arijit Singh", lyrics_kind="synced", lrc=[list(x) for x in HINDI],
                script="Devanagari", reference_status="ready",
                reference={"file": "reference.m4a", "map": {"aMs": 0.0, "b": 0.0, "agreement": "5/5", "residualMs": 1}})
    song.words = {"status": "pending"}
    song.envelope = {"version": "x"}
    p = prepare.Preparer(store, recognize=None)
    p._plan(song, 10_000)
    assert not p._queue, "an aligner of English letters can't read Devanagari: wait for the romanization"
    assert lyrics_payload(song, 0.1)["kind"] == "pending"


def test_a_language_the_person_reads_comes_in_its_own_script_reordered_for_the_watch():
    song = Song(id="s", title="Kesariya", artist="Arijit Singh", lyrics_kind="synced", lrc=[list(x) for x in HINDI], script="Devanagari")
    p = lyrics_payload(song, 0.1, read=["Devanagari"])
    assert p["kind"] == "synced", "no wait for a romanization they don't need"
    assert p["lines"][2][1] == "कैसे तुझसे िदल ना लगाए कोई", "दिल with its i-sign first: the watch draws letters where they come"
    assert lyrics_payload(song, 0.1, read=["Bengali"])["kind"] == "pending", "not one they read: English letters, once they exist"


def test_a_script_the_watch_has_no_letters_for_is_always_in_english_letters():
    telugu = [(1000, "ఏ నాటు నాటు సరుకేరో")]
    song = Song(id="s", title="Naatu Naatu", artist="Rahul Sipligunj", lyrics_kind="synced", lrc=[list(x) for x in telugu],
                script="Telugu", roman=["Ye naatu naatu sarukero"])
    assert lyrics_payload(song, 0.1, read=["Telugu"])["lines"][0][1] == "Ye naatu naatu sarukero"


def test_word_timings_follow_whichever_text_is_shown_and_urdu_goes_as_whole_lines():
    words = {"lines": {"0": [1000, [1000, 1400, 1800, 2200], 3000, 0.9]}}
    hindi = Song(id="s", title="t", artist="a", lyrics_kind="synced", lrc=[[1000, "मुझको इतना बताए कोई"]], script="Devanagari",
                 roman=["mujhko itna bataye koi"], words=words)
    assert lyrics_payload(hindi, 0.1)["lines"][0][2] == [1000, 1400, 1800, 2200], "lit word by word in English letters"
    assert lyrics_payload(hindi, 0.1, read=["Devanagari"])["lines"][0][2] == [1000, 1400, 1800, 2200], "and in Devanagari: same words"
    urdu = Song(id="u", title="t", artist="a", lyrics_kind="synced", lrc=[[1000, "دل دل پاکستان جان جان"]], script="Arabic",
                roman=["dil dil pakistan jaan"], words=words)
    assert lyrics_payload(urdu, 0.1, read=["Arabic"])["lines"][0][2] is None


def test_letters_for_lyrics_that_changed_meanwhile_are_not_kept_and_the_new_ones_get_theirs(api, monkeypatch):
    """A refresh brought other lyrics while the gateway was still writing the old ones in English
    letters: those letters were stored on the new lyrics, and the song said "pending" for good."""
    client, app_module, _ = api
    lines = {"now": HINDI}

    async def find(*_a):
        return Lyrics(kind="synced", lines=lines["now"], source="lrclib", source_id=7)

    async def slow_romanize(_client, texts, title, artist):
        await asyncio.sleep(0.4)
        return ["x%d" % i if t else "" for i, t in enumerate(texts)]

    monkeypatch.setattr(app_module._lyrics, "find", find)
    monkeypatch.setattr(roman, "romanize", slow_romanize)
    client.post("/identify", json={"audio": watch_file(music(5)), "purpose": "find"})  # lyrics, and their letters on the way
    song = app_module._store.get("k1")
    time.sleep(0.1)
    lines["now"] = HINDI + [(9000, "दिल ना लगाए कोई")]  # LRCLIB answers differently on a refresh
    song.lyrics_retry_at = time.time() - 1
    client.post("/lyrics", json={"song": "k1"})
    time.sleep(1.5)
    r = client.post("/lyrics", json={"song": "k1"}).json()["lyrics"]
    assert r["kind"] == "synced", "stuck on pending"
    assert len(song.roman) == len(song.lrc) == 4
    assert [line[1] for line in r["lines"]] == ["x0", "", "x2", "x3"]
