"""HTTP API used by the watch app's phone-side service.

POST /identify  a watch recording: which song, and where in it the recording started
POST /lyrics    a song's lyrics and word timings, when they have changed
GET  /health    connectivity check used by the phone settings screen
GET  /livez     liveness for the kubelet: no token, says nothing but "ok"
GET  /recent    the last requests, for debugging from a browser
GET  /songs, GET /songs/{id}   what the server knows, for debugging

/identify body:
    {"audio": <base64 Zepp recorder file>, "clipMs": 5000, "client": {...diagnostics},
     "purpose": "find" | "sync" | "resume" | "check",
     "song": <id the watch is following, or null>, "expectMs": <where the watch thinks
     the recording started>, "known": {"lyrics": <version>, "envelope": <version>}}

When the watch is following a song the server already has the audio of ("sync",
"resume"), the recording is placed by comparing it with that audio near `expectMs`
(track.py, a few ms). Otherwise, or if that comparison isn't convincing, Shazam decides.

Lyrics and the loudness track are left out of the answer when the watch already has the
same version: the phone link carries a few KB/s, and re-syncs come every 30 s.

Set LEZEPPLEAN_TOKEN to require "Authorization: Bearer <token>" (do this before exposing
the server through a public tunnel).
"""

from __future__ import annotations

import asyncio
import audioop
import base64
import hashlib
import json
import logging
import math
import os
import time
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import httpx
import numpy as np
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel

from . import __version__, listen, phone, roman, track, zepp_opus
from .align import MIN_LINE_CONFIDENCE
from .lyrics import LyricsFinder
from .prepare import Preparer
from .recognize import Recognizer, RecognizerBusy
from .reference import Mapping
from .songs import Song, SongStore, lyrics_payload, words_status

log = logging.getLogger("lezepplean")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

ROOT = Path(__file__).resolve().parent.parent
TOKEN = os.environ.get("LEZEPPLEAN_TOKEN") or None
DATA = Path(os.environ.get("LEZEPPLEAN_DATA", ROOT / "data"))
CAPTURES = Path(os.environ.get("LEZEPPLEAN_CAPTURES", ROOT / "captures"))
KEEP_CAPTURES = int(os.environ.get("LEZEPPLEAN_KEEP_CAPTURES", "50"))
# The captures are the user's room audio. Locally they are the fastest way to see what the
# watch heard; on a shared server keep only the JSON summaries (LEZEPPLEAN_CAPTURE_AUDIO=0).
CAPTURE_AUDIO = os.environ.get("LEZEPPLEAN_CAPTURE_AUDIO", "1") == "1"
THREADS = int(os.environ.get("LEZEPPLEAN_THREADS", "2"))
RECOGNIZE_TIMEOUT_S = 6.0  # the phone-side fetch is reported to be cut after ~10 s of silence
LYRICS_RETRY_S = 120       # LRCLIB couldn't be asked properly: ask again after this
# A song heard for the first time goes to the watch by then, its lyrics or not: LRCLIB has
# taken 6.5 s, and the watch waited on "Listening…" all that time. Its lyrics follow on the
# watch's next poll ("pending" until then).
LYRICS_WAIT_S = 1.5
# A song playing on the phone whose lyrics lookup failed (LRCLIB down or slow) is asked about
# again this soon, while it plays, instead of in 2 minutes when the watch next asks: a first
# lookup that failed left "Sorry if I Hurt You" without lyrics until someone asked again.
PHONE_LYRICS_RETRY_S = (5, 10, 20, 40, 60)

# Fast re-sync must be sure before it overrules Shazam. Measured on simulated room
# recordings (scripts/eval_track.py, scripts/sim_stream.py): a right placement scores
# ~0.6-0.75; another song's best lag at most 0.41. The dangerous case is the *same* song at
# the wrong place: with the clock 25 s off after a missed skip, the best lag near the
# clock's guess scored 0.43 (Blinding Lights repeats itself), while the true place, found
# by searching the whole song, scored 0.65. So both searches always run (the whole song
# costs ~10 ms), and a near match is only trusted when nothing elsewhere beats it.
TRACK_MIN_SCORE = 0.45
TRACK_MIN_MARGIN = 0.08      # near search: best lag vs any lag 400 ms+ away (within +-3 s)
TRACK_WIDE_BETTER = 0.10     # a place elsewhere this much better wins (the music was skipped)
TRACK_TIE = 0.03             # within this, a repeat: the clock's guess breaks the tie
TRACK_RADIUS_MS = 3000
# ...but rooms are rarely that kind. A quiet clip that gets louder, or a knock in a quiet
# room, rises in every band at once and matched wherever the song rises (its first second, a
# drop): in 283 of 1,440 clips another song was placed in the one on screen (the lyrics went
# back to its start, and a new song went unnoticed), the right song at the wrong place in 124
# of 720. So a placement must also agree in the spectrum's shape there; failing that, the
# shape alone decides, with a slightly lower bar, and a place elsewhere in the song must
# stand out as a near one does: 1 and 7 (scripts/eval_wrong_song.py, room audio at -55 to
# -30 dB, 11 Oct 2026).
TRACK_SHAPE_AGREE = 0.25
TRACK_SHAPE_MIN_SCORE = 0.40

_http = httpx.AsyncClient(follow_redirects=True)
_recognizer = Recognizer()
_lyrics = LyricsFinder(_http)
_store = SongStore(DATA / "songs")
_preparer = Preparer(_store, lambda wav: _recognizer.recognize(wav, wait=True), threads=THREADS)
_phone = phone.Phone()
_listening = listen.Recordings()
_recent: deque[dict] = deque(maxlen=30)


@asynccontextmanager
async def lifespan(_app):
    yield
    _preparer.close()


# No /docs or /openapi.json: the API is for the watch's relay, and the page at / says what this is.
app = FastAPI(title="LeZeppLean", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
STATIC = Path(__file__).resolve().parent / "static"
HOME = """<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0E1931">
<title>LeZeppLean</title>
<link rel="icon" type="image/png" href="/favicon.png">
<style>
  html { background: #03030A; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; text-align: center;
         background: linear-gradient(#0E1931, #03030A); color: #F8F4EB;
         font: 17px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { padding: 48px 24px; max-width: 30rem; }
  img { width: 128px; height: 128px; }
  h1 { font-size: 28px; margin: 20px 0 6px; letter-spacing: 0.01em; }
  p { margin: 0; color: #B9B3A8; }
  a { color: #FE5641; text-decoration: none; }
  a:hover, a:focus-visible { text-decoration: underline; }
  .more { margin-top: 28px; font-size: 15px; }
</style>
<main>
  <img src="/logo.png" alt="">
  <h1>LeZeppLean</h1>
  <p>Lyrics on your wrist, word by word, in time with the music around you or in your earphones.</p>
  <p class="more"><a href="https://github.com/rounakdatta/le-zepp-lean">github.com/rounakdatta/le-zepp-lean</a></p>
</main>
</html>
"""


class IdentifyRequest(BaseModel):
    audio: str
    format: str = "zepp-opus"
    clipMs: int | None = None
    client: dict | None = None
    purpose: str = "find"
    song: str | None = None
    expectMs: float | None = None
    known: dict | None = None
    read: list[str] | None = None  # scripts the person reads: their songs in their own script


class PhoneUpdate(BaseModel):
    """The phone's media session, from the LeZeppLean helper app (android/)."""
    app: str = ""            # the player's package, e.g. com.spotify.music
    title: str = ""
    artist: str = ""
    album: str | None = None
    durationMs: float | None = None
    state: str = "stopped"   # playing | paused | stopped | buffering
    positionMs: float = 0.0  # where the track was at sentAt
    speed: float = 1.0
    sentAt: float | None = None  # the phone's clock, ms since 1970


class ListenChunk(BaseModel):
    """A piece of what the phone's mic hears, from the LeZeppLean helper (android/)."""
    session: str
    startedAt: float          # the phone's clock (ms since 1970) at the recording's first sample
    offset: int               # this piece's first sample, counted from the recording's first
    rate: int = listen.RATE
    pcm: str = ""             # base64, 16-bit little-endian mono
    sentAt: float | None = None  # the phone's clock when this was sent
    quiet: bool = False       # the phone hears nothing (its first second was silent): no audio comes


class LyricsRequest(BaseModel):
    song: str
    known: dict | None = None
    read: list[str] | None = None  # scripts the person reads: their songs in their own script


def _check_token(authorization: str | None) -> None:
    if TOKEN and authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="bad or missing token")


def _level_dbfs(pcm: bytes) -> dict:
    """Peak and RMS level of the clip: tells silence/muffled mic apart from a recognition miss."""
    if not pcm:
        return {"peakDb": None, "rmsDb": None}
    peak = audioop.max(pcm, 2) or 1
    rms = audioop.rms(pcm, 2) or 1
    return {"peakDb": round(20 * math.log10(peak / 32768), 1), "rmsDb": round(20 * math.log10(rms / 32768), 1)}


def _save_capture(request_id: str, raw: bytes, wav: bytes | None, summary: dict) -> None:
    if KEEP_CAPTURES <= 0:
        return
    try:
        CAPTURES.mkdir(parents=True, exist_ok=True)
        if CAPTURE_AUDIO:
            (CAPTURES / f"{request_id}.zepp.opus").write_bytes(raw)
            if wav:
                (CAPTURES / f"{request_id}.wav").write_bytes(wav)
        (CAPTURES / f"{request_id}.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False))
        files = sorted(CAPTURES.glob("*.json"))
        for old in files[:-KEEP_CAPTURES]:
            for sibling in CAPTURES.glob(old.name.removesuffix(".json") + ".*"):
                sibling.unlink(missing_ok=True)
    except OSError as e:
        log.warning("could not save capture %s: %s", request_id, e)


def _song_info(song: Song) -> dict:
    return {"id": song.id, "title": song.title, "artist": song.artist, "album": song.album, "durationMs": song.duration_ms}


def _song_data(song: Song, known: dict | None, read: list[str] | None = None) -> dict:
    """Lyrics and loudness track unless the watch has these versions, plus the words status.
    `read`: the scripts the person reads (the Zepp app's settings), for songs in other scripts."""
    known = known or {}
    out: dict = {}
    payload = lyrics_payload(song, MIN_LINE_CONFIDENCE, read)
    if known.get("lyrics") != payload["version"]:
        out["lyrics"] = payload
    if song.envelope and known.get("envelope") != song.envelope.get("version"):
        out["envelope"] = song.envelope
    w = words_status(song)
    eta = _preparer.eta_ms(song)
    if eta is not None:
        w["etaMs"] = eta
    out["words"] = w
    # Whether a short window can be placed (the song's own audio is here): the watch sends
    # 2-3 s when it can, 5 s (enough for Shazam) when it can't.
    out["sync"] = {"fast": song.reference_status == "ready" and (_store.dir(song.id) / "features.npy").exists()}
    return out


async def _lookup_lyrics(song: Song, length_ok: bool = True, retry_length: bool = False) -> None:
    """(Re)fill a song's lyrics from LRCLIB. A failed lookup is not saved as "no lyrics":
    v0.1 never cached "none", and a stored "none" would have been forever. Neither are lyrics
    picked without the track's length (iTunes failed): they may be timed for a remix."""
    if retry_length and not song.length_checked and song.apple_id:
        duration_s, length_ok = await _lyrics.itunes_lookup(song.apple_id)
        if duration_s:
            song.duration_ms = round(duration_s * 1000)
            song.length_checked = True
    duration_s = song.duration_ms / 1000 if song.duration_ms and song.length_checked else None
    lyrics = await _lyrics.find(song.title, song.artist, song.album, duration_s)
    if not lyrics.definite and song.lyrics_kind == "synced":
        # LRCLIB couldn't be asked: keep the lyrics there are (a refresh during an outage
        # used to swap them for none, mid-song) and ask again later.
        song.lyrics_retry_at = time.time() + LYRICS_RETRY_S
        return
    definite = lyrics.definite and length_ok
    new_lrc = [[ms, " ".join(text.split())] for ms, text in lyrics.lines]  # one space: the watch splits on whitespace runs
    if new_lrc != song.lrc:
        # Different lyrics (or the first ones): any word timings were for the old lines, and a
        # step still running for them must not write them in (lyrics_rev, see prepare._run).
        song.words = {"status": "pending" if lyrics.kind == "synced" and song.reference_status != "unavailable" else "unavailable"}
        song.jobs = {k: v for k, v in song.jobs.items() if k == "assets"}
        song.lyrics_rev += 1
    if new_lrc != song.lrc or song.script is None and new_lrc:
        song.script = roman.script_of([t for _, t in new_lrc]) if lyrics.kind == "synced" else None
        song.roman = None
        song.roman_retry_at = 0.0
    song.lyrics_kind = lyrics.kind
    song.lrc = new_lrc
    song.lyrics_source = {"source": lyrics.source, "id": lyrics.source_id, "durationS": lyrics.duration_s}
    song.lyrics_retry_at = 0.0 if definite else time.time() + LYRICS_RETRY_S
    _romanize_if_due(song)
    if not song.length_checked and lyrics.duration_s:
        # Apple didn't answer: LRCLIB's length, for now. Without any length the watch can't
        # tell when the song ends, and a gapless next song took 30-50 s to be noticed.
        song.duration_ms = round(lyrics.duration_s * 1000)
    _check_length(song)


MIN_SONG_MS = 30_000


def _check_length(song: Song, heard_at_ms: float | None = None) -> bool:
    """A song's length must be one it can have: past its lyrics' last line, past where it was
    just heard, and a song's, not a jingle's. A bad catalog entry gave "Nobody" 4 s: the watch
    ended it every time it was found, and no copy of that length was found to time its words.
    A wrong one gives way to LRCLIB's, if that one can be right, else to none (no length beats
    a wrong one), and the song's audio is looked for again. True when it was wrong."""
    if not song.duration_ms:
        return False
    last = max((ms for ms, text in (song.lrc or []) if text), default=0)
    floor = max(MIN_SONG_MS, last + 1000, (heard_at_ms or 0) + 1000)
    if song.duration_ms >= floor:
        return False
    other = (song.lyrics_source or {}).get("durationS")
    log.warning("%s: %d ms can't be its length (lyrics to %d ms, heard at %s ms)", song.id, song.duration_ms, last, heard_at_ms)
    song.duration_ms = round(other * 1000) if other and other * 1000 >= floor else None
    song.length_checked = True  # don't ask Apple again: it gave this one
    song.notes.append(f"a length the song outlasts was dropped (lyrics to {last} ms)")
    if song.reference_status == "unavailable":
        song.reference_retry_at = 0.0  # looked for with that length: look again
    return True


_romanizing: set[str] = set()
ROMAN_RETRY_S = (5, 15, 60)


def _romanize_if_due(song: Song) -> None:
    """Lyrics in a script the watch can't draw: write them in English letters, in the background."""
    if song.script is None and song.lyrics_kind == "synced" and song.lrc:
        song.script = roman.script_of([t for _, t in song.lrc])  # a song stored before this existed
    if not song.script or song.roman or song.id in _romanizing or time.time() < song.roman_retry_at or not song.lrc:
        return
    _romanizing.add(song.id)

    lrc = list(song.lrc)

    async def run() -> None:
        try:
            for wait in (0,) + ROMAN_RETRY_S:
                if wait:
                    await asyncio.sleep(wait)
                if song.lrc != lrc:
                    return  # the lyrics changed meanwhile: their own turn comes (below)
                out = await roman.romanize(_http, [t for _, t in lrc], song.title, song.artist)
                if song.lrc != lrc:
                    return  # ...even during the call: these are the old lines' letters
                if out is not None:
                    song.roman = out
                    _store.put(song)
                    log.info("%s romanized (%s, %d lines)", song.id, song.script, len(out))
                    playing = _phone.now.song_id == song.id
                    _preparer.ensure(song, _phone.position(time.time()) if playing else None)  # word timing, on these words
                    if playing:
                        _phone.bump()  # the watch asks for the lyrics when it hears of a change
                    return
            song.roman_retry_at = time.time() + 300
            _store.put(song)
        except Exception:
            log.exception("romanizing %s failed", song.id)
        finally:
            _romanizing.discard(song.id)
            if song.lrc != lrc:
                _romanize_if_due(song)  # the new lines, now that this run is out of the way

    asyncio.get_running_loop().create_task(run())


_refreshing: set[str] = set()


def _refresh_lyrics_if_due(song: Song) -> None:
    """Ask LRCLIB again in the background (it can take 25 s when slow: the phone gives up
    after 9.5). The retry time moves on first, so a second request doesn't start a second lookup.
    A song still "pending" with no lookup under way is due too: its first one was cut off (the
    process died), and it used to stay "Loading lyrics…" for good."""
    due = song.lyrics_retry_at or song.lyrics_kind == "pending"
    if not due or time.time() < song.lyrics_retry_at or song.id in _refreshing:
        return
    song.lyrics_retry_at = time.time() + LYRICS_RETRY_S
    _store.put(song)
    _refreshing.add(song.id)

    async def refresh() -> None:
        try:
            fresh = _store.get(song.id)
            if fresh is not None:
                await _lookup_lyrics(fresh, length_ok=fresh.length_checked or not fresh.apple_id, retry_length=True)
                _store.put(fresh)
        except Exception:
            log.exception("lyrics refresh for %s failed", song.id)
        finally:
            _refreshing.discard(song.id)

    asyncio.get_running_loop().create_task(refresh())


async def _song_for(match, position_ms: float | None = None, wait_s: float = LYRICS_WAIT_S) -> Song:
    """The stored song for a Shazam match, created (with its lyrics) on first sight."""
    # Shazam's key is stable per recording; without one, a hash of the names (never hash():
    # it changes with every process, and the song would be "new" after each restart)
    song_id = match.shazam_key or "t" + hashlib.sha1(f"{match.title}|{match.artist}".casefold().encode()).hexdigest()[:12]
    song = _store.get(song_id)
    if song is not None:
        _refresh_lyrics_if_due(song)
        _romanize_if_due(song)
        return song
    song = Song(
        id=song_id, title=match.title, artist=match.artist, album=match.album,
        apple_id=match.apple_id, isrc=match.isrc, shazam_key=match.shazam_key, lyrics_kind="pending",
    )
    _store.put(song)
    _refreshing.add(song.id)  # the first lookup is one under way (see _refresh_lyrics_if_due)
    lookup = asyncio.get_running_loop().create_task(_first_lyrics(song, position_ms))
    try:
        await asyncio.wait_for(asyncio.shield(lookup), wait_s)
    except asyncio.TimeoutError:
        log.info("lyrics for %s still coming after %.1f s: answering with its name", song_id, LYRICS_WAIT_S)
    return song


async def _first_lyrics(song: Song, position_ms: float | None) -> None:
    """A new song's length (iTunes) and lyrics (LRCLIB). Its word timings can only be planned
    once there are lyrics: if they came after the answer, start them here."""
    asked = time.monotonic()
    try:
        duration_s, length_ok = await _lyrics.itunes_lookup(song.apple_id)
        if duration_s:
            song.duration_ms = round(duration_s * 1000)
            song.length_checked = True
        await _lookup_lyrics(song, length_ok)  # (which checks the length against the lyrics)
    except Exception:
        log.exception("lyrics for %s failed", song.id)
        song.lyrics_kind = "none"
        song.lyrics_retry_at = time.time() + LYRICS_RETRY_S
    finally:
        _refreshing.discard(song.id)
    _store.put(song)
    if song.lyrics_kind == "synced" and position_ms is not None:
        _preparer.ensure(song, position_ms + (time.monotonic() - asked) * 1000)


def _locate(song: Song, pcm: bytes, expect_ms: float | None, may_jump: bool) -> dict | None:
    """Place the recording inside the song's own audio (fast re-sync), or None if unsure."""
    feats = _store.features(song.id)
    if feats is None or not song.reference:
        return None
    m = Mapping.from_dict(song.reference["map"])
    x = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768
    center = m.to_reference(expect_ms) if expect_ms is not None else None
    found, method = _place(x, feats, center, may_jump, TRACK_MIN_SCORE, False)
    if found is not None and track.agreement(x, feats, found.offset_ms) < TRACK_SHAPE_AGREE:
        found = None                                            # a rise in the room met a rise in the song
    if found is None:
        found, method = _place(x, feats, center, may_jump, TRACK_SHAPE_MIN_SCORE, True)
        method = method and method.replace("track", "track-shape")
    if found is None:
        return None
    return {"offsetMs": round(m.to_canonical(found.offset_ms), 1), "skew": m.b, "method": method,
            "score": round(found.score, 3), "margin": round(found.margin, 3)}


def _place(x: np.ndarray, feats: np.ndarray, center: float | None, may_jump: bool, min_score: float,
           shape: bool) -> tuple[track.Located | None, str | None]:
    wide = track.locate(x, feats, None, shape=shape)
    if wide is None:
        return None, None
    near = track.locate(x, feats, center, TRACK_RADIUS_MS, shape=shape) if center is not None else None
    if near is not None and abs(near.offset_ms - wide.offset_ms) < 400:
        if near.score >= min_score and near.margin >= TRACK_MIN_MARGIN:
            return near, "track"                                # the clock was right, and nothing beats it
    elif wide.score >= min_score + 0.05 and (near is None or wide.score >= near.score + TRACK_WIDE_BETTER):
        if (may_jump or near is None) and (not shape or wide.margin >= TRACK_MIN_MARGIN):
            return wide, "track-wide"                           # the music is somewhere else in the song
    elif near is not None and near.score >= min_score + 0.05 and near.score >= wide.score - TRACK_TIE:
        return near, "track"                                    # a repeat: near the clock's guess wins the tie
    return None, None


@app.get("/", response_class=HTMLResponse, include_in_schema=False)
async def home() -> str:
    """What this is, for anyone who opens the address in a browser."""
    return HOME


@app.get("/logo.png", include_in_schema=False)
async def logo() -> FileResponse:
    return FileResponse(STATIC / "logo.png", media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/favicon.png", include_in_schema=False)
@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> FileResponse:
    return FileResponse(STATIC / "favicon.png", media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/livez")
async def livez() -> dict:
    """For the kubelet's probes, which carry no token. /health needs one (it answers the
    settings screen's "Test connection", which should fail on a wrong token)."""
    return {"ok": True}


@app.get("/health")
async def health(authorization: str | None = Header(None)) -> dict:
    _check_token(authorization)
    return {"ok": True, "service": "lezepplean", "version": __version__, "time": time.time(), "busy": _preparer.busy}


@app.get("/recent")
async def recent(authorization: str | None = Header(None)) -> list[dict]:
    _check_token(authorization)
    return list(_recent)


@app.get("/songs")
async def songs(authorization: str | None = Header(None)) -> list[dict]:
    _check_token(authorization)
    return [{**_song_info(s), "lyrics": s.lyrics_kind, "reference": s.reference_status, "words": words_status(s)}
            for s in _store.all()]


@app.get("/songs/{song_id}")
async def song_detail(song_id: str, authorization: str | None = Header(None)) -> dict:
    _check_token(authorization)
    song = _store.get(song_id)
    if song is None:
        raise HTTPException(status_code=404, detail="unknown song")
    payload = lyrics_payload(song, MIN_LINE_CONFIDENCE)
    return {**_song_info(song), "reference": song.reference, "referenceStatus": song.reference_status,
            "words": {k: v for k, v in song.words.items() if k != "lines"}, "notes": song.notes,
            "lyrics": payload, "envelope": bool(song.envelope)}


@app.post("/lyrics")
async def lyrics(req: LyricsRequest, authorization: str | None = Header(None)) -> dict:
    _check_token(authorization)
    song = _store.get(req.song)
    if song is None:
        return {"ok": False, "reason": "unknown_song"}
    _refresh_lyrics_if_due(song)
    _romanize_if_due(song)
    _preparer.ensure(song, None)
    return {"ok": True, "song": _song_info(song), **_song_data(song, req.known, req.read)}


@app.post("/phone")
async def phone_update(req: PhoneUpdate, authorization: str | None = Header(None)) -> dict:
    """The helper app on the phone: what its player is playing, the moment that changes."""
    _check_token(authorization)
    t = time.time()
    if _phone.update(req.model_dump(), t) and req.title:
        snap = _phone.now
        asyncio.get_running_loop().create_task(_resolve_phone_track(snap.track, snap.app, snap.title, snap.artist, snap.album, snap.duration_ms))
    return {"ok": True, "version": _phone.now.version, "songId": _phone.now.song_id}


@app.post("/listen/audio")
async def listen_audio(req: ListenChunk, authorization: str | None = Header(None)) -> dict:
    """What the phone hears while the watch looks for a song. `done` tells the helper to stop."""
    _check_token(authorization)
    if req.rate != listen.RATE:
        raise HTTPException(status_code=422, detail=f"{listen.RATE} Hz only")
    if req.offset < 0:
        raise HTTPException(status_code=422, detail="offset < 0")
    t = time.time()
    rec = _listening.get(req.session[:64], (req.startedAt + _phone.clock(req.sentAt, t)) / 1000, t)
    _phone.expire(t)
    if not rec.done and _phone.music_playing(t):
        rec.finish("phone_playing")  # the phone's own player comes first: it is followed, not heard
    if not rec.done and req.quiet and t - rec.start_at <= listen.MAX_AGE_S:
        rec.finish("quiet")  # needs no Shazam call: passed on even while Shazam refuses
        _phone.hear({"id": rec.id, "quiet": True, "startedAt": rec.start_at}, t)  # a song only the phone heard has stopped
    if not rec.done and _recognizer.cooling():
        rec.finish("busy")  # Shazam is refusing calls: no point sending more
    if not rec.done and t - rec.start_at > listen.MAX_AGE_S:
        rec.finish("stale")  # held up somewhere: too old to name as what plays now
    if not rec.done:
        rec.put(req.offset, base64.b64decode(req.pcm))
        if rec.due():
            rec.asking = True
            asyncio.get_running_loop().create_task(_hear(rec))
    return {"ok": True, "done": rec.done or rec.seconds >= listen.MAX_S, "reason": rec.reason}


async def _hear(rec: listen.Listening) -> None:
    """Ask Shazam about what the phone has heard so far. Named: the watch hears of it at once."""
    found = None
    try:
        pcm = bytes(rec.pcm)
        level = _level_dbfs(pcm)["rmsDb"]
        if level is not None and level < listen.QUIET_DB:
            log.info("listening %s: quiet (%.0f dBFS), Shazam not asked", rec.id, level)
            if rec.asked == 0:  # silence from the start: say so (it stops a song only the phone heard)
                rec.finish("quiet")
                _phone.hear({"id": rec.id, "quiet": True, "startedAt": rec.start_at}, time.time())
        else:
            found = await asyncio.wait_for(_recognizer.recognize(zepp_opus.pcm_to_wav(pcm), wait=True), RECOGNIZE_TIMEOUT_S)
    except RecognizerBusy:
        rec.finish("busy")  # Shazam is refusing calls: asking again with more audio won't help
    except Exception as e:  # noqa: BLE001  a timeout, or ShazamIO failing: maybe with more audio
        log.warning("listening %s: %s: %s", rec.id, type(e).__name__, e)
    finally:
        rec.asking = False
        rec.asked += 1
    if rec.done:
        return
    if found is None:
        if rec.asked >= len(listen.ASK_AT_S):
            rec.finish("no_match")
        elif rec.due():  # more came in meanwhile
            rec.asking = True
            await _hear(rec)
        return
    rec.finish("found")
    song = await _song_for(found, found.offset_ms + (time.time() - rec.start_at) * 1000 + 3000, wait_s=0)
    if _check_length(song, found.offset_ms):
        _store.put(song)
    t = time.time()
    _phone.hear({"id": rec.id, "songId": song.id, "title": song.title, "artist": song.artist,
                 "durationMs": song.duration_ms, "positionMs": found.offset_ms + (t - rec.start_at) * 1000,
                 "startedAt": rec.start_at}, t)
    log.info("the phone heard %s (%s)", song.id, rec.id)


@app.get("/phone/recent")
async def phone_recent(authorization: str | None = Header(None)) -> list[dict]:
    """What the helper said lately, newest first: for working out why the watch did what it did."""
    _check_token(authorization)
    t = time.time()
    return [{**h, "at": None, "agoS": round(t - h["at"], 1)} for h in reversed(_phone.history)]


@app.get("/phone/next")
async def phone_next(since: int = -1, wait: float = 8.0, authorization: str | None = Header(None)) -> dict:
    """The watch's relay asks what the phone is playing; when it already knows `since`, the
    answer waits (up to 8 s: the phone's HTTP client drops a request after ~10 s) for a change."""
    _check_token(authorization)
    await _phone.wait(since, max(0.0, min(wait, 8.0)))
    return _phone.view(time.time())


def _song_by_name(title: str, artist: str, duration_ms: int | None) -> Song | None:
    """A song already here under this name (heard in the room, or played on the phone before)."""
    t, a = phone.name_key(title), phone.artist_key(artist)
    if not t:
        return None
    best = None
    for s in _store.all():
        if phone.name_key(s.title) != t or phone.artist_key(s.artist) != a:
            continue
        if duration_ms and s.duration_ms and abs(s.duration_ms - duration_ms) > 3000:
            continue  # another recording of it (a live version, an edit): timed differently
        if best is None or (s.lyrics_kind == "synced") > (best.lyrics_kind == "synced"):
            best = s
    return best


async def _resolve_phone_track(track: tuple, app_id: str, title: str, artist: str, album: str | None, duration_ms: int | None) -> None:
    """Which song the phone is playing, and its lyrics and word timings on their way."""
    try:
        if app_id == phone.YOUTUBE:
            title, artist = phone.from_youtube(title, artist)
        song = _song_by_name(title, artist, duration_ms)
        if song is None:
            key = f"{phone.name_key(title)}|{phone.artist_key(artist)}|{round((duration_ms or 0) / 1000)}"
            song = Song(id="p" + hashlib.sha1(key.encode()).hexdigest()[:12], title=title, artist=artist, album=album,
                        duration_ms=duration_ms, length_checked=bool(duration_ms), lyrics_kind="pending")
            _store.put(song)
        if _phone.now.track == track:
            _phone.now.song_id = song.id
            _phone.bump()
        if song.lyrics_kind == "pending" and song.id not in _refreshing:
            # the player's own length: the lyrics are timed for this recording or not at all
            _refreshing.add(song.id)
            try:
                for wait in (0,) + PHONE_LYRICS_RETRY_S:
                    if wait:
                        await asyncio.sleep(wait)
                        if _phone.now.track != track:
                            break  # another song now: it is looked up the next time it plays
                    await _lookup_lyrics(song, length_ok=bool(duration_ms))
                    if song.lyrics_kind == "synced" or not song.lyrics_retry_at:
                        break  # found, or LRCLIB answered that it has none
                    song.lyrics_kind = "pending"  # LRCLIB couldn't be asked: still coming, not "none"
                    _store.put(song)
            finally:
                _refreshing.discard(song.id)
            if song.lyrics_kind == "pending":
                song.lyrics_kind = "none"
            _store.put(song)
            if _phone.now.track == track:
                _phone.bump()  # the watch asks for the lyrics when it hears of a change
        elif song.lyrics_kind != "pending":
            _refresh_lyrics_if_due(song)
            _romanize_if_due(song)
        _preparer.ensure(song, _phone.position(time.time()) if _phone.now.track == track else None)
    except Exception:
        log.exception("could not resolve %r by %r from the phone", title, artist)


@app.post("/identify")
async def identify(req: IdentifyRequest, authorization: str | None = Header(None)) -> dict:
    _check_token(authorization)
    started = time.perf_counter()
    request_id = datetime.now().strftime("%Y%m%d-%H%M%S-") + os.urandom(2).hex()
    timing: dict[str, int] = {}

    def lap(name: str, since: float) -> float:
        now = time.perf_counter()
        timing[name] = round((now - since) * 1000)
        return now

    try:
        raw = base64.b64decode(req.audio, validate=True)
    except ValueError:
        raise HTTPException(status_code=400, detail="audio is not valid base64")

    response: dict = {"ok": False, "id": request_id}
    wav = None
    try:
        t = time.perf_counter()
        try:
            clip = zepp_opus.decode(raw)
        except zepp_opus.ZeppOpusError as e:
            response.update(reason="bad_audio", message=str(e), clip={"bytes": len(raw)})
            return response
        wav = zepp_opus.pcm_to_wav(clip.pcm)
        response["clip"] = {"bytes": len(raw), "packets": clip.packets, "ms": round(clip.duration_ms),
                            **_level_dbfs(clip.pcm)}
        t = lap("decodeMs", t)

        song: Song | None = None
        match: dict | None = None
        if req.song and req.purpose in ("sync", "resume", "check"):
            following = _store.get(req.song)
            if following is not None:
                # after a pause or a mismatch, the music may have been skipped anywhere in the song
                match = await asyncio.to_thread(_locate, following, clip.pcm, req.expectMs, req.purpose in ("resume", "check", "sync"))
                if match is not None:
                    song = following
                t = lap("trackMs", t)

        if match is None:
            try:
                found = await asyncio.wait_for(_recognizer.recognize(wav), RECOGNIZE_TIMEOUT_S)
            except asyncio.TimeoutError:
                response.update(reason="recognizer_timeout")
                return response
            except RecognizerBusy as e:  # Shazam is refusing calls: none are sent until it stops
                response.update(reason="recognizer_busy", retryInMs=round(e.retry_in * 1000))
                return response
            except Exception as e:  # ShazamIO is an unofficial client; surface its failures instead of a 500
                log.exception("recognizer failed")
                response.update(reason="recognizer_error", message=f"{type(e).__name__}: {e}")
                return response
            t = lap("recognizeMs", t)
            if found is None:
                response.update(reason="no_match")
                return response
            # where the song will be when the answer reaches the watch (see ensure below)
            song = await _song_for(found, found.offset_ms + (clip.duration_ms or 0) + 3000)
            if _check_length(song, found.offset_ms):
                _store.put(song)
            match = {"offsetMs": round(found.offset_ms, 1), "skew": found.timeskew, "method": "shazam"}
            t = lap("lyricsMs", t)

        # Roughly where the song will be when this answer reaches the watch: start of the
        # recording + its length + the trip back. Used to align the lines about to be sung first.
        _preparer.ensure(song, match["offsetMs"] + (clip.duration_ms or 0) + 3000)
        known = req.known if req.known is not None and song.id == req.song else None
        info = _song_info(song)
        response.update(ok=True, song=info, track=info, match=match, **_song_data(song, known, req.read))
        return response
    finally:
        timing["totalMs"] = round((time.perf_counter() - started) * 1000)
        response["timing"] = timing
        summary = {k: v for k, v in response.items() if k not in ("lyrics", "envelope")}
        summary["lyricsLines"] = len((response.get("lyrics") or {}).get("lines") or [])
        summary["sentEnvelope"] = "envelope" in response
        summary["client"] = req.client
        summary["purpose"] = req.purpose
        summary["expectMs"] = req.expectMs
        summary["clipMsClaimed"] = req.clipMs
        _recent.appendleft(summary)
        _save_capture(request_id, raw, wav, summary)
        log.info("identify %s %s ok=%s reason=%s song=%r offset=%s method=%s timing=%s",
                 request_id, req.purpose, response["ok"], response.get("reason"), (response.get("song") or {}).get("title"),
                 (response.get("match") or {}).get("offsetMs"), (response.get("match") or {}).get("method"), timing)
