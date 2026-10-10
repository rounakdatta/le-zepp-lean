"""The preparation queue: each step once per song, the newest song's urgent steps first."""
import asyncio

from lezepplean import prepare
from lezepplean.songs import Song, SongStore


def song(sid: str) -> Song:
    return Song(id=sid, title="T", artist="A", lyrics_kind="synced", lrc=[[1000, "a b"], [5000, "c d"]],
                words={"status": "pending"}, reference_status="ready",
                reference={"file": "reference.m4a", "map": {"aMs": 0.0, "b": 0.0, "agreement": "5/5", "residualMs": 0}})


def test_a_step_is_not_queued_again_while_it_runs(tmp_path):
    store = SongStore(tmp_path)
    store.put(song("s1"))
    p = prepare.Preparer(store, recognize=None)
    started = []
    release = asyncio.Event()

    async def fake_run(job):
        started.append(job.kind)
        await release.wait()

    async def scenario():
        p._run = fake_run
        p.ensure(store.get("s1"), 10_000)
        await asyncio.sleep(0.01)            # the first job ("assets") is running now
        for _ in range(3):                    # every request calls ensure() again
            p.ensure(store.get("s1"), 12_000)
            await asyncio.sleep(0)
        release.set()
        await asyncio.sleep(0.05)
        p._consumer.cancel()

    asyncio.run(scenario())
    assert started.count("assets") == 1, started
    assert started.count("rest") == 1, started


def test_a_newly_heard_song_jumps_the_queue(tmp_path):
    store = SongStore(tmp_path)
    store.put(song("old"))
    store.put(song("new"))
    p = prepare.Preparer(store, recognize=None)
    order = []
    gate = asyncio.Event()

    async def fake_run(job):
        order.append((job.song_id, job.kind))
        if len(order) == 1:
            await gate.wait()

    async def scenario():
        p._run = fake_run
        p.ensure(store.get("old"), 10_000)
        await asyncio.sleep(0.01)             # old's first step is running
        p.ensure(store.get("new"), 20_000)
        gate.set()
        await asyncio.sleep(0.05)
        p._consumer.cancel()

    asyncio.run(scenario())
    kinds = [k for k in order]
    assert kinds.index(("new", "near")) < kinds.index(("old", "rest")), kinds


def test_a_dead_worker_is_replaced_and_its_step_waits_before_running_again(tmp_path):
    import time
    from concurrent.futures.process import BrokenProcessPool

    store = SongStore(tmp_path)
    store.put(song("s1"))
    p = prepare.Preparer(store, recognize=None)
    p._executor = object()  # stands in for the pool that just broke
    calls = []

    async def dies(job):
        calls.append(job.kind)
        if job.kind == "assets":
            raise BrokenProcessPool("worker killed (out of memory)")

    async def scenario():
        p._run = dies
        p.ensure(store.get("s1"), 10_000)
        await asyncio.sleep(0.05)
        p._consumer.cancel()

    asyncio.run(scenario())
    assert p._executor is None                     # the broken pool is dropped; a new one starts next time
    assert calls.count("assets") == 1              # not straight again: it may be what killed the worker
    rec = store.get("s1").jobs["assets"]
    assert rec["tries"] == 1 and rec["retryAt"] > time.time() + 30
    assert store.get("s1").words["status"] == "pending"   # never saved as word-less for our own trouble
    assert "near" in calls                         # the other steps still ran


def test_a_step_that_keeps_failing_is_not_rerun_on_every_request_or_restart(tmp_path):
    store = SongStore(tmp_path)
    store.put(song("s1"))
    runs = []

    async def always_fails(job):
        runs.append(job.kind)
        raise MemoryError("too big")

    async def scenario(p):
        p._run = always_fails
        for _ in range(7):                         # a watch polling for words every few seconds
            p.ensure(store.get("s1"), 10_000)
            await asyncio.sleep(0.01)
        p._consumer.cancel()

    asyncio.run(scenario(prepare.Preparer(store, recognize=None)))
    assert runs.count("assets") == 1, runs
    restarted = SongStore(tmp_path)                # the server restarts (or was killed mid-step)
    runs.clear()
    asyncio.run(scenario(prepare.Preparer(restarted, recognize=None)))
    assert runs == [], runs


def test_a_step_cut_short_by_the_process_dying_is_not_rerun_at_once_on_restart(tmp_path):
    store = SongStore(tmp_path)
    store.put(song("s1"))
    p = prepare.Preparer(store, recognize=None)
    from lezepplean.prepare import Job
    p._mark_started(Job(0, 0, "s1", "assets", 0))  # ...and the process died here: nothing else was recorded
    runs = []

    async def run(job):
        runs.append(job.kind)

    async def scenario():
        q = prepare.Preparer(SongStore(tmp_path), recognize=None)
        q._run = run
        q.ensure(q.store.get("s1"), 10_000)
        await asyncio.sleep(0.05)
        q._consumer.cancel()

    asyncio.run(scenario())
    assert "assets" not in runs and "near" in runs


def test_a_reference_that_failed_for_a_passing_reason_is_tried_again_later(tmp_path):
    import time

    from lezepplean import reference

    store = SongStore(tmp_path)
    s = song("s1")
    s.reference_status = "pending"
    s.reference = None
    store.put(s)

    async def down(_song):
        raise reference.TransientError("Shazam failed on 3 of 5 cuts")

    async def scenario():
        p = prepare.Preparer(store, recognize=None, fetch_reference=down)
        p.ensure(store.get("s1"), 0)
        await asyncio.sleep(0.05)
        p._consumer.cancel()

    asyncio.run(scenario())
    got = store.get("s1")
    assert got.reference_status == "pending"
    assert got.reference_retry_at > time.time() + 60
    assert got.words["status"] == "pending"


def test_a_recording_that_is_not_on_youtube_is_an_answer(tmp_path):
    store = SongStore(tmp_path)
    s = song("s1")
    s.reference_status = "pending"
    s.reference = None
    store.put(s)

    async def absent(_song):
        return None

    async def scenario():
        p = prepare.Preparer(store, recognize=None, fetch_reference=absent)
        p.ensure(store.get("s1"), 0)
        await asyncio.sleep(0.05)
        p._consumer.cancel()

    asyncio.run(scenario())
    got = store.get("s1")
    assert got.reference_status == "unavailable"
    assert got.words["status"] == "unavailable"


def test_only_the_stretches_not_computed_yet_are_computed():
    import numpy as np

    from lezepplean.worker import _gaps

    covered = np.zeros(100, dtype=bool)
    covered[30:50] = True   # "near" done
    covered[60:70] = True   # "next" done
    assert _gaps(covered, 0, 100) == [(0, 30), (50, 60), (70, 100)]
    assert _gaps(covered, 30, 50) == []


def test_a_running_step_does_not_look_like_a_retry_wait(tmp_path):
    store = SongStore(tmp_path)
    store.put(song("s1"))
    p = prepare.Preparer(store, recognize=None)
    gate = asyncio.Event()
    seen = {}

    async def slow(job):
        seen.setdefault("eta", p.eta_ms(store.get("s1")))
        await gate.wait()

    async def scenario():
        p._run = slow
        p.ensure(store.get("s1"), 10_000)
        await asyncio.sleep(0.02)
        gate.set()
        await asyncio.sleep(0.02)
        p._consumer.cancel()

    asyncio.run(scenario())
    assert seen["eta"] is not None and seen["eta"] <= 30_000, seen   # the watch keeps polling


def test_timings_for_old_lyrics_are_not_written_into_new_ones(tmp_path):
    store = SongStore(tmp_path)
    store.put(song("s1"))
    p = prepare.Preparer(store, recognize=None)

    async def worker_call(fn, *args):
        # while the worker aligned the old lines, a refresh brought different lyrics
        s = store.get("s1")
        s.lrc = [[1200, "new words"], [5200, "other words"]]
        s.lyrics_rev += 1
        s.words = {"status": "pending"}
        store.put(s)
        return {"lines": {"0": [1000, [1000, 1300], 1600, 0.5]}, "seconds": 1.0, "modelSeconds": 1.0}

    async def scenario():
        p._call = worker_call
        from lezepplean.prepare import Job
        await p._run(Job(3, 0, "s1", "rest", 0))

    asyncio.run(scenario())
    w = store.get("s1").words
    assert w.get("status") == "pending" and not w.get("lines"), w


def test_the_worker_is_let_go_when_idle_and_started_again_when_a_song_arrives(tmp_path, monkeypatch):
    from concurrent.futures import Future

    monkeypatch.setattr(prepare, "IDLE_RELEASE_S", 0.05)
    store = SongStore(tmp_path)
    for sid in ("s1", "s2"):
        s = song(sid)
        s.reference_status = "pending"
        s.reference = None
        store.put(s)
    events = []

    class Pool:
        def submit(self, fn, *args):
            events.append(fn.__name__)
            f = Future()
            f.set_result(True)
            return f

        def shutdown(self, **_kw):
            events.append("released")

    async def slow_and_nothing_found(_song):
        await asyncio.sleep(0.12)         # longer than the idle time: a download is work too
        events.append("fetched")
        return None

    p = prepare.Preparer(store, recognize=None, fetch_reference=slow_and_nothing_found)

    def pool():
        if p._executor is None:
            p._executor = Pool()
        return p._executor

    p._pool = pool

    async def scenario():
        p.ensure(store.get("s1"), 0)     # a new song: the worker starts while its audio downloads
        await asyncio.sleep(0.5)          # nothing to do afterwards: let go
        p.ensure(store.get("s2"), 0)     # the next new song starts it again
        await asyncio.sleep(0.01)
        p._consumer.cancel()

    asyncio.run(scenario())
    assert events == ["warm", "fetched", "released", "warm"], events
