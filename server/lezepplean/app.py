"""HTTP API used by the watch app's phone-side service.

POST /identify  body: {"audio": <base64 Zepp recorder file>, "clipMs": 5000, "client": {...diagnostics}}
GET  /health    connectivity check used by the phone settings screen
GET  /recent    the last requests, for debugging from a browser

Set LEZEPPLEAN_TOKEN to require "Authorization: Bearer <token>" (do this before exposing
the server through a public tunnel).
"""

from __future__ import annotations

import asyncio
import audioop
import base64
import json
import logging
import math
import os
import time
from collections import deque
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from . import __version__, zepp_opus
from .lyrics import LyricsFinder
from .recognize import Recognizer

log = logging.getLogger("lezepplean")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

TOKEN = os.environ.get("LEZEPPLEAN_TOKEN") or None
CAPTURES = Path(os.environ.get("LEZEPPLEAN_CAPTURES", Path(__file__).resolve().parent.parent / "captures"))
KEEP_CAPTURES = int(os.environ.get("LEZEPPLEAN_KEEP_CAPTURES", "50"))
RECOGNIZE_TIMEOUT_S = 6.0  # the phone-side fetch is reported to be cut after ~10 s of silence

app = FastAPI(title="LeZeppLean", version=__version__)
_http = httpx.AsyncClient(follow_redirects=True)
_recognizer = Recognizer()
_lyrics = LyricsFinder(_http)
_recent: deque[dict] = deque(maxlen=30)


class IdentifyRequest(BaseModel):
    audio: str
    format: str = "zepp-opus"
    clipMs: int | None = None
    client: dict | None = None


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
    try:
        CAPTURES.mkdir(parents=True, exist_ok=True)
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


@app.get("/health")
async def health(authorization: str | None = Header(None)) -> dict:
    _check_token(authorization)
    return {"ok": True, "service": "lezepplean", "version": __version__, "time": time.time()}


@app.get("/recent")
async def recent(authorization: str | None = Header(None)) -> list[dict]:
    _check_token(authorization)
    return list(_recent)


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

        try:
            match = await asyncio.wait_for(_recognizer.recognize(wav), RECOGNIZE_TIMEOUT_S)
        except asyncio.TimeoutError:
            response.update(reason="recognizer_timeout")
            return response
        except Exception as e:  # ShazamIO is an unofficial client; surface its failures instead of a 500
            log.exception("recognizer failed")
            response.update(reason="recognizer_error", message=f"{type(e).__name__}: {e}")
            return response
        t = lap("recognizeMs", t)
        if match is None:
            response.update(reason="no_match")
            return response

        duration_s = await _lyrics.itunes_duration_s(match.apple_id)
        lyrics = await _lyrics.find(match.title, match.artist, match.album, duration_s)
        lap("lyricsMs", t)

        response.update(
            ok=True,
            track={"title": match.title, "artist": match.artist, "album": match.album,
                   "durationMs": round((duration_s or lyrics.duration_s or 0) * 1000) or None},
            match={"offsetMs": round(match.offset_ms, 1), "skew": match.timeskew},
            lyrics={"kind": lyrics.kind, "source": lyrics.source, "sourceId": lyrics.source_id,
                    "lines": [[ms, text] for ms, text in lyrics.lines]},
        )
        return response
    finally:
        timing["totalMs"] = round((time.perf_counter() - started) * 1000)
        response["timing"] = timing
        summary = {k: v for k, v in response.items() if k != "lyrics"}
        summary["lyricsLines"] = len((response.get("lyrics") or {}).get("lines") or [])
        summary["client"] = req.client
        summary["clipMsClaimed"] = req.clipMs
        _recent.appendleft(summary)
        _save_capture(request_id, raw, wav, summary)
        track = response.get("track") or {}
        log.info("identify %s ok=%s reason=%s track=%r offset=%s lines=%s timing=%s client=%s",
                 request_id, response["ok"], response.get("reason"), track.get("title"),
                 (response.get("match") or {}).get("offsetMs"), summary["lyricsLines"], timing, req.client)
