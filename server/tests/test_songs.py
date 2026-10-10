from lezepplean.songs import Song, SongStore, lyrics_payload, words_status


def song(**kw):
    base = dict(id="s1", title="T", artist="A", lyrics_kind="synced",
                lrc=[[1000, "hello there"], [4000, ""], [6000, "general kenobi"]], words={"status": "pending"})
    base.update(kw)
    return Song(**base)


def test_lines_without_words_go_out_line_by_line():
    p = lyrics_payload(song(), 0.1)
    assert p["lines"] == [[1000, "hello there", None, None], [4000, "", None, None], [6000, "general kenobi", None, None]]


def test_words_only_for_lines_the_aligner_was_sure_about():
    w = {"status": "ready", "lines": {"0": [1050, [1050, 1400], 1900, 0.42], "2": [6100, [6100, 6500], 7000, 0.04]}}
    p = lyrics_payload(song(words=w), 0.1)
    assert p["lines"][0] == [1050, "hello there", [1050, 1400], 1900]
    assert p["lines"][2] == [6000, "general kenobi", None, None]  # 0.04 < 0.1: line by line


def test_version_changes_exactly_when_the_watch_would_see_a_difference():
    a = lyrics_payload(song(), 0.1)["version"]
    assert lyrics_payload(song(), 0.1)["version"] == a
    w = {"status": "pending", "lines": {"0": [1050, [1050, 1400], 1900, 0.5]}}
    assert lyrics_payload(song(words=w), 0.1)["version"] != a


def test_store_round_trip(tmp_path):
    store = SongStore(tmp_path)
    store.put(song(words={"status": "ready", "lines": {"0": [1, [1, 2], 3, 0.5]}}))
    fresh = SongStore(tmp_path)  # as after a restart
    got = fresh.get("s1")
    assert got.lrc[0] == [1000, "hello there"]
    assert words_status(got) == {"status": "ready"}
