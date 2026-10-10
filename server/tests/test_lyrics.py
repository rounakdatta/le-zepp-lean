"""LRCLIB lookups: a real "no lyrics" is told apart from a lookup that didn't work."""
import asyncio

import httpx

from lezepplean.lyrics import LyricsFinder


def finder(handler) -> LyricsFinder:
    return LyricsFinder(httpx.AsyncClient(transport=httpx.MockTransport(handler)))


def test_lrclib_timing_out_is_not_no_lyrics():
    def handler(request):
        raise httpx.ConnectTimeout("timed out", request=request)

    got = asyncio.run(finder(handler).find("Song", "Band", None, 200.0))
    assert got.kind == "none" and got.definite is False


def test_lrclib_failing_is_not_no_lyrics():
    got = asyncio.run(finder(lambda r: httpx.Response(503)).find("Song", "Band", None, 200.0))
    assert got.kind == "none" and got.definite is False


def test_lrclib_saying_there_are_none_is_an_answer():
    def handler(request):
        if request.url.path.endswith("/get"):
            return httpx.Response(404, json={"code": 404})
        return httpx.Response(200, json=[])

    got = asyncio.run(finder(handler).find("Song", "Band", None, 200.0))
    assert got.kind == "none" and got.definite is True


def test_synced_lyrics_found_are_definite_even_after_an_error():
    def handler(request):
        if request.url.path.endswith("/get"):
            return httpx.Response(500)
        return httpx.Response(200, json=[{"id": 1, "trackName": "Song", "artistName": "Band", "duration": 200,
                                          "syncedLyrics": "[00:01.00] Hello"}])

    got = asyncio.run(finder(handler).find("Song", "Band", None, 200.0))
    assert got.kind == "synced" and got.definite is True


def test_itunes_failing_is_told_apart_from_no_length():
    f = finder(lambda r: httpx.Response(503))
    assert asyncio.run(f.itunes_lookup("123")) == (None, False)
    f = finder(lambda r: httpx.Response(200, json={"results": []}))
    assert asyncio.run(f.itunes_lookup("123")) == (None, True)
