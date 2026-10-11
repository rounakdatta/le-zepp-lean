"""Getting a song ready after it is first heard, in the order the watch needs things.

1. **Reference** (network, ~5 s): the song's own audio, checked by Shazam and mapped onto
   the watch's timeline (reference.py).
2. **Assets** (~3 s of CPU): the loudness track the watch follows to tell a quiet passage
   from a pause, and the features fast re-sync compares against.
3. **Words near now** (~6 s): separation, the acoustic model and alignment for the next
   30 s of the song, so the lines about to be sung get their word timings first; then
   the 45 s after that ("next").
4. **Words for the rest** (~30 s): everything else, then one global alignment.

The CPU steps run one at a time in a separate low-priority process (worker.py), in
priority order: a newly heard song's first three steps go ahead of an older song's
"rest of the song". Everything is saved, so each song is prepared once.
"""

from __future__ import annotations

import asyncio
import heapq
import itertools
import logging
import multiprocessing
import time
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass, field

from . import reference, worker
from .songs import Song, SongStore

log = logging.getLogger("lezepplean.prepare")

# Regions around the position the song had when it was identified (watch timeline).
REGIONS = {"near": (-3000, 30000), "next": (30000, 75000)}
# Seconds of CPU per second of song, measured on the homelab's EPYC with 2 threads; only
# used to tell the watch when to ask again.
SECONDS_PER_SONG_SECOND = 0.2
# A reference that couldn't be fetched for a passing reason (network, YouTube, Shazam
# trouble) is tried again after this, doubling; one that doesn't exist, after a week.
RETRY_FIRST_S = 300
RETRY_MAX_S = 6 * 3600
RETRY_ABSENT_S = 7 * 24 * 3600
# The worker holds both models (~340 MB) while it lives. It starts when a new song's
# audio starts downloading, so the models load in the seconds the download takes anyway,
# and it is let go after this long with nothing to do: idle, the server is ~130 MB.
IDLE_RELEASE_S = 300
# A step that fails (or is cut short: the process died) waits before it runs again: 1 min,
# 4, 16, ... 6 h. Saved with the song, so a step that kills the server isn't re-run on every
# request, nor at once after each restart.
STEP_RETRY_FIRST_S = 60
STEP_RETRY_FACTOR = 4


@dataclass(order=True)
class Job:
    priority: int
    seq: int
    song_id: str = field(compare=False)
    kind: str = field(compare=False)            # assets | near | next | rest
    position_ms: float | None = field(compare=False, default=None)


class Preparer:
    def __init__(self, store: SongStore, recognize, threads: int = 2, fetch_reference=None):
        self.store = store
        self.recognize = recognize
        self.threads = threads
        self._fetch_reference = fetch_reference or self._default_fetch
        self._executor: ProcessPoolExecutor | None = None
        self._queue: list[Job] = []
        self._seq = itertools.count()
        self._wake = asyncio.Event()
        self._fetching: dict[str, asyncio.Task] = {}
        self._queued: set[tuple[str, str]] = set()
        self._consumer: asyncio.Task | None = None
        self._idle: asyncio.TimerHandle | None = None
        self.busy: str | None = None

    # ---- what the API calls ---------------------------------------------------------

    def ensure(self, song: Song, position_ms: float | None) -> None:
        """Make sure everything this song can have is on its way. Cheap to call on every request."""
        if self._consumer is None or self._consumer.done():
            self._consumer = asyncio.get_running_loop().create_task(self._consume())
        due = time.time() >= (song.reference_retry_at or 0)
        if song.reference_status in ("pending", "unavailable") and due and song.id not in self._fetching:
            self._warm()  # CPU work follows the download: start the worker now, in parallel
            task = asyncio.get_running_loop().create_task(self._reference(song.id, position_ms))
            self._fetching[song.id] = task
            task.add_done_callback(lambda _t, sid=song.id: self._fetching.pop(sid, None))
        elif song.reference_status == "ready":
            self._plan(song, position_ms)

    def eta_ms(self, song: Song) -> int | None:
        """When word timings near the current position should be ready, roughly."""
        w = song.words or {}
        if w.get("status") != "pending":
            return None
        now = time.time()
        # A step queued or running has a retryAt too (written before it starts, in case the
        # process dies): that is not a wait, and treating it as one stopped the watch polling.
        waits = [song.reference_retry_at - now] + [j.get("retryAt", 0) - now for k, j in song.jobs.items()
                                                   if k != "rest" and (song.id, k) not in self._queued]
        if max(waits) > 0:
            return int(max(waits) * 1000) + 20000  # waiting to retry: the watch won't poll, re-syncs will carry it
        backlog = sum(1 for j in self._queue if j.kind != "rest")
        fetch = 6000 if song.reference_status == "pending" else 0
        a, b = REGIONS["near"]
        near = int((b - a) * SECONDS_PER_SONG_SECOND)
        assets = 3000 if not song.envelope else 0
        return fetch + assets + near * (1 + backlog)

    # ---- the steps -----------------------------------------------------------------

    async def _reference(self, song_id: str, position_ms: float | None) -> None:
        song = self.store.get(song_id)
        if song is None:
            return
        try:
            found = await self._fetch_reference(song)
        except Exception as e:  # network, YouTube, Shazam: not an answer. Try again later.
            log.warning("reference fetch for %s failed for now: %s: %s", song_id, type(e).__name__, e)
            song = self.store.get(song_id) or song
            song.reference_retry_at = time.time() + min(RETRY_MAX_S, RETRY_FIRST_S * 2 ** song.reference_attempts)
            song.reference_attempts += 1
            song.notes.append(f"reference (will retry): {type(e).__name__}: {e}"[:300])
            self.store.put(song)
            return
        song = self.store.get(song_id) or song
        if found is None:
            # Looked properly and no copy of this recording exists: that is an answer. Words
            # need it, so they can't be had either; look again in a week, uploads change.
            song.reference_status = "unavailable"
            song.reference_retry_at = time.time() + RETRY_ABSENT_S
            if song.words.get("status") == "pending":
                song.words["status"] = "unavailable"
            self.store.put(song)
            return
        song.reference = found
        song.reference_status = "ready"
        song.reference_retry_at = 0.0
        song.reference_attempts = 0
        if song.lyrics_kind == "synced" and song.words.get("status") == "unavailable":
            song.words["status"] = "pending"  # found on a later try
        self.store.put(song)
        self._plan(song, position_ms)

    async def _default_fetch(self, song: Song) -> dict | None:
        """Search, download, decode and Shazam-check candidates until one maps cleanly."""
        duration_s = song.duration_ms / 1000 if song.duration_ms else None
        candidates = await asyncio.to_thread(reference.search, song.title, song.artist, duration_s)
        if candidates is None:
            raise reference.TransientError("YouTube search failed")
        d = self.store.dir(song.id)
        trouble = None
        for cand in candidates[:3]:
            try:
                path = await asyncio.to_thread(reference.download, cand.id, d)
                audio = await asyncio.to_thread(reference.load_16k, path)
            except Exception as e:
                log.warning("download %s failed: %s", cand.id, e)
                song.notes.append(f"download {cand.id}: {e}"[:300])
                trouble = e
                continue
            try:
                mapping = await reference.measure_mapping(audio, self.recognize, song.shazam_key, song.title)
            except reference.TransientError as e:
                trouble = e
                continue
            if mapping is None:
                song.notes.append(f"{cand.id} ({cand.title!r}) is not the identified recording")
                path.unlink(missing_ok=True)
                continue
            return {"videoId": cand.id, "title": cand.title, "channel": cand.channel, "durationS": cand.duration_s,
                    "file": path.name, "map": mapping.as_dict()}
        if trouble is not None:
            raise reference.TransientError(f"{type(trouble).__name__}: {trouble}")
        return None

    def _plan(self, song: Song, position_ms: float | None) -> None:
        now = time.time()

        def waiting(kind: str) -> bool:
            return song.jobs.get(kind, {}).get("retryAt", 0) > now

        if not song.envelope and not waiting("assets"):
            self._push(song.id, "assets", 0, position_ms)
        # lyrics in a script the aligner (English letters) can't read wait for their romanization
        waiting_roman = bool(song.script) and not song.roman
        if song.lyrics_kind == "synced" and song.words.get("status") not in ("ready", "unavailable") and not waiting_roman:
            done = song.words.get("done") or []
            if position_ms is not None:
                for priority, kind in ((1, "near"), (2, "next")):
                    if kind not in done and not waiting(kind):
                        self._push(song.id, kind, priority, position_ms)
            if not waiting("rest"):
                self._push(song.id, "rest", 3, position_ms)

    def _push(self, song_id: str, kind: str, priority: int, position_ms: float | None) -> None:
        # A job stays in `_queued` until it has finished, not just until it starts: every
        # request calls ensure(), and the step that was running got queued and run twice.
        if (song_id, kind) in self._queued:
            return
        self._queued.add((song_id, kind))
        heapq.heappush(self._queue, Job(priority, next(self._seq), song_id, kind, position_ms))
        self._wake.set()

    def _mark_started(self, job: Job) -> None:
        # Before the step runs, as if it will fail: if the process dies mid-step there is
        # nobody left to record the failure, and the next start would run it straight away.
        song = self.store.get(job.song_id)
        if song is None:
            return
        rec = dict(song.jobs.get(job.kind) or {})
        rec["tries"] = int(rec.get("tries", 0)) + 1
        rec["retryAt"] = time.time() + min(RETRY_MAX_S, STEP_RETRY_FIRST_S * STEP_RETRY_FACTOR ** (rec["tries"] - 1))
        song.jobs[job.kind] = rec
        self.store.put(song)

    def _mark_done(self, job: Job) -> None:
        song = self.store.get(job.song_id)
        if song is not None and job.kind in song.jobs:
            song.jobs.pop(job.kind)
            self.store.put(song)

    async def _consume(self) -> None:
        while True:
            while not self._queue:
                self._wake.clear()
                await self._wake.wait()
            job = heapq.heappop(self._queue)
            self.busy = f"{job.kind}:{job.song_id}"
            self._mark_started(job)
            try:
                await self._run(job)
                self._mark_done(job)
            except BrokenProcessPool:
                # The worker died (out of memory, killed). A broken pool stays broken: replace
                # it, or every later song fails too. The step itself waits (see _mark_started):
                # if it was what killed the worker, running it again at once would kill it again.
                log.warning("worker died during %s for %s; restarting it", job.kind, job.song_id)
                self._executor = None
                self._note(job, "the worker died")
            except Exception as e:
                log.exception("job %s for %s failed", job.kind, job.song_id)
                self._note(job, f"{type(e).__name__}: {e}")
            finally:
                self._queued.discard((job.song_id, job.kind))
                self.busy = None
                self._touch()

    def _note(self, job: Job, what: str) -> None:
        # The song stays "pending": never saved as word-less because of the server's own trouble.
        song = self.store.get(job.song_id)
        if song is not None:
            rec = song.jobs.get(job.kind) or {}
            song.notes.append(f"{job.kind} failed ({what}); retrying in {int(rec.get('retryAt', 0) - time.time())} s"[:300])
            self.store.put(song)

    def _pool(self) -> ProcessPoolExecutor:
        if self._executor is None:
            self._executor = ProcessPoolExecutor(max_workers=1, mp_context=multiprocessing.get_context("spawn"),
                                                 initializer=worker.init, initargs=(self.threads,))
        return self._executor

    async def _call(self, fn, *args):
        return await asyncio.wrap_future(self._pool().submit(fn, *args))

    async def _run(self, job: Job) -> None:
        song = self.store.get(job.song_id)
        if song is None or not song.reference:
            return
        m = reference.Mapping.from_dict(song.reference["map"])
        d = str(self.store.dir(song.id))
        started = time.perf_counter()
        rev = song.lyrics_rev
        if job.kind == "assets":
            out = await self._call(worker.reference_assets, d, song.reference["file"], m.a_ms, m.b)
            song.envelope = {"version": _short_hash(out["envelope"]["data"]), **out["envelope"]}
            self.store.forget_features(song.id)
            self.store.put(song)
            log.info("assets for %s in %.1fs", song.id, time.perf_counter() - started)
            return
        # timed word by word in the words the watch shows: English letters for other scripts
        texts = song.roman if song.script and song.roman and len(song.roman) == len(song.lrc) else [t for _, t in song.lrc]
        lrc_ref = [[m.to_reference(ms), text] for (ms, _), text in zip(song.lrc, texts)]
        if job.kind in REGIONS:
            a, b = REGIONS[job.kind]
            pos = job.position_ms or 0
            done = list(song.words.get("done") or []) + [job.kind]
            idx = [i for i, (ms, _) in enumerate(song.lrc) if pos + a <= ms < pos + b and song.lrc[i][1]]
            if not idx:
                song.words["done"] = done
                self.store.put(song)
                return
            lo = lrc_ref[idx[0]][0] - 2500
            nxt = lrc_ref[idx[-1] + 1][0] if idx[-1] + 1 < len(lrc_ref) else lrc_ref[idx[-1]][0] + 30_000
            out = await self._call(worker.align_words, d, song.reference["file"], lrc_ref, (max(0, lo), nxt + 2500), idx)
            song = self.store.get(job.song_id) or song
            if song.lyrics_rev != rev:
                return  # the lyrics changed while this ran: these timings are for lines that are gone
            if song.words.get("status") == "ready":
                return  # the full alignment finished first: it is the better answer
            lines = dict(song.words.get("lines") or {})
            lines.update(_to_canonical(out["lines"], m))
            song.words.update(lines=lines, done=done, aligned=len(lines), of=len(song.lrc))
        else:
            out = await self._call(worker.align_words, d, song.reference["file"], lrc_ref, None, None)
            song = self.store.get(job.song_id) or song
            if song.lyrics_rev != rev:
                return  # the lyrics changed while this ran: these timings are for lines that are gone
            lines = _to_canonical(out["lines"], m)
            song.words.update(lines=lines, status="ready", aligned=len(lines), of=len(song.lrc), done=["near", "next", "rest"])
        song.words["seconds"] = round(song.words.get("seconds", 0) + out["seconds"], 1)
        self.store.put(song)
        log.info("%s words for %s: %d lines in %.1fs (model %.1fs)", job.kind, song.id, len(out["lines"]), out["seconds"], out["modelSeconds"])

    def _warm(self) -> None:
        self._touch()
        if self._executor is None:
            self._pool().submit(worker.warm)

    def _touch(self) -> None:
        if self._idle is not None:
            self._idle.cancel()
        self._idle = asyncio.get_running_loop().call_later(IDLE_RELEASE_S, self._release_if_idle)

    def _release_if_idle(self) -> None:
        if self._queue or self.busy or self._fetching:
            self._touch()  # still working: look again later
        elif self._executor is not None:
            log.info("worker idle for %ds: releasing it and its models", IDLE_RELEASE_S)
            self._executor.shutdown(wait=False)
            self._executor = None

    def close(self) -> None:
        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)


def _to_canonical(lines: dict, m: reference.Mapping) -> dict:
    out = {}
    for i, (start, words, end, conf) in lines.items():
        out[i] = [round(m.to_canonical(start)), [round(m.to_canonical(w)) for w in words],
                  round(m.to_canonical(end)) if end is not None else None, conf]
    return out


def _short_hash(s: str) -> str:
    import hashlib

    return hashlib.sha1(s.encode()).hexdigest()[:10]
