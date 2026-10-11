"""Shazam refusing calls (a 429) is waited out, never hammered."""

import asyncio

import pytest

from lezepplean import recognize


class FakeShazam:
    def __init__(self, answers):
        self.answers = list(answers)
        self.calls = 0

    async def recognize(self, _wav):
        self.calls += 1
        a = self.answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a


def recognizer(answers, monkeypatch, clock):
    r = recognize.Recognizer()
    r._shazam = FakeShazam(answers)
    monkeypatch.setattr(recognize.time, "monotonic", lambda: clock[0])
    return r


def test_a_refusal_stops_every_call_until_it_wears_off_and_each_new_one_waits_longer(monkeypatch):
    clock = [1000.0]
    refused = recognize._Refused(429, None)
    r = recognizer([refused, refused, {"matches": []}], monkeypatch, clock)
    with pytest.raises(recognize.RecognizerBusy):
        asyncio.run(r.recognize(b""))
    for _ in range(5):  # searches meanwhile send nothing
        with pytest.raises(recognize.RecognizerBusy) as e:
            asyncio.run(r.recognize(b""))
    assert r._shazam.calls == 1
    assert 0 < e.value.retry_in <= recognize.COOL_S[0]
    clock[0] += recognize.COOL_S[0] + 1
    with pytest.raises(recognize.RecognizerBusy) as e:  # refused again: twice as long
        asyncio.run(r.recognize(b""))
    assert e.value.retry_in == recognize.COOL_S[1]
    clock[0] += recognize.COOL_S[1] + 1
    assert asyncio.run(r.recognize(b"")) is None  # answered: back to normal
    assert r._refusals == 0 and r._shazam.calls == 3


def test_shazams_own_retry_after_is_respected(monkeypatch):
    clock = [0.0]
    r = recognizer([recognize._Refused(429, 900.0)], monkeypatch, clock)
    with pytest.raises(recognize.RecognizerBusy) as e:
        asyncio.run(r.recognize(b""))
    assert e.value.retry_in == 900.0


def test_a_search_while_shazam_refuses_is_answered_at_once(api, monkeypatch):
    client, app_module, _ = api

    async def busy(_wav):
        raise recognize.RecognizerBusy(42.0)

    monkeypatch.setattr(app_module._recognizer, "recognize", busy)
    r = client.post("/identify", json={"audio": watch_file(music(5)), "purpose": "find"}).json()
    assert r["ok"] is False and r["reason"] == "recognizer_busy" and r["retryInMs"] == 42_000



def test_a_429_is_a_refusal_even_with_a_json_body_never_a_song_not_found():
    from aiohttp import web

    async def main():
        app = web.Application()
        app.router.add_post("/tag", lambda _req: web.json_response({"error": "slow down"}, status=429))
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        try:
            with pytest.raises(recognize._Refused):
                await recognize._Http().request("POST", f"http://127.0.0.1:{port}/tag", json={})
        finally:
            await runner.cleanup()

    asyncio.run(main())

from test_api import api, music, watch_file  # noqa: E402,F401  (the api fixture)
