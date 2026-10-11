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
    monkeypatch.setattr(recognize.time, "monotonic", lambda: clock[0])
    r = recognize.Recognizer()
    r._shazam = FakeShazam(answers)
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



def test_no_burst_of_calls_goes_out_however_many_searches_come_in(monkeypatch):
    clock = [0.0]
    r = recognizer([{"matches": []}] * 40, monkeypatch, clock)
    sent = 0
    for _ in range(40):  # 40 searches at once: only a burst's worth reach Shazam
        try:
            asyncio.run(r.recognize(b""))
            sent += 1
        except recognize.RecognizerBusy as e:
            assert 0 < e.retry_in <= recognize.REFILL_S
    assert sent == recognize.BURST
    clock[0] += 60  # a minute later: the budget is back
    asyncio.run(r.recognize(b""))
    assert r._shazam.calls == recognize.BURST + 1

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


def test_background_work_waits_its_turn_instead_of_failing(monkeypatch):
    clock = [0.0]
    r = recognizer([{"matches": []}] * (recognize.BURST + 1), monkeypatch, clock)
    slept = []

    async def sleep(s):
        slept.append(s)
        clock[0] += s

    monkeypatch.setattr(recognize.asyncio, "sleep", sleep)
    for _ in range(recognize.BURST):
        asyncio.run(r.recognize(b""))
    with pytest.raises(recognize.RecognizerBusy) as e:  # a search can't wait: it is told how long
        asyncio.run(r.recognize(b""))
    assert e.value.refused is False and e.value.retry_in <= recognize.REFILL_S
    assert asyncio.run(r.recognize(b"", wait=True)) is None  # a reference check waits for its turn
    assert 0 < sum(slept) <= recognize.REFILL_S


def test_refusals_of_calls_sent_together_count_once(monkeypatch):
    clock = [0.0]
    r = recognizer([], monkeypatch, clock)
    gate = asyncio.Event()

    class Together:
        async def recognize(self, _wav):
            await gate.wait()  # all three are out before the first refusal comes back
            raise recognize._Refused(429, None)

    r._shazam = Together()

    async def three():
        calls = [asyncio.ensure_future(r.recognize(b"")) for _ in range(3)]
        await asyncio.sleep(0)
        gate.set()
        return await asyncio.gather(*calls, return_exceptions=True)

    outcomes = asyncio.run(three())
    assert all(isinstance(o, recognize.RecognizerBusy) for o in outcomes)
    assert r._refusals == 1, "one episode: the shortest cool-down, not 120 s"
    assert 0 < r.cooling() <= recognize.COOL_S[0]


def test_a_403_is_a_refusal_and_other_errors_are_not_a_song_not_found():
    from aiohttp import web

    async def main(status):
        app = web.Application()
        app.router.add_post("/tag", lambda _req: web.json_response({}, status=status))
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        try:
            await recognize._Http().request("POST", f"http://127.0.0.1:{port}/tag", json={})
        finally:
            await runner.cleanup()

    with pytest.raises(recognize._Refused):
        asyncio.run(main(403))
    with pytest.raises(RuntimeError):
        asyncio.run(main(400))
