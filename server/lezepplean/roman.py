"""Lyrics in English letters, so a song in a script you can't read (or the watch can't
draw) can still be sung along with.

The watch's font has no shaping for Indic scripts: Hindi and Bengali vowel signs land on the
wrong side of their consonant and conjuncts fall apart, and Telugu, Punjabi, Gujarati and
Odia have no glyphs at all (measured on a T-Rex 3, 11 Oct 2026). So such lyrics are
written the way fans type them ("tujhe dekha toh", not the scholarly "tujhe dekhā to")
by Claude, through the homelab's auth2api gateway: one call per song (two halves in
parallel: a 39-line song took 2.7 s), kept with the song for good.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os

import httpx

log = logging.getLogger("lezepplean.roman")

LLM_URL = os.environ.get("LEZEPPLEAN_LLM_URL", "http://auth2api.apps.svc.cluster.local:8317").rstrip("/")
LLM_KEY = os.environ.get("LEZEPPLEAN_LLM_KEY") or None
MODEL = os.environ.get("LEZEPPLEAN_ROMAN_MODEL", "claude-haiku-5-5")
CHUNK = 25  # lines per call; a song's chunks go in parallel

SYSTEM = ("You write song lyrics in English letters so that someone who can't read the script can sing along. "
          "Write them the way fans casually type them (Hinglish, Banglish, Tanglish...): no diacritics, the common "
          "everyday spellings (dil, pyaar, hai, kya, toh, nahi), every word kept, in order, nothing translated. "
          "Words already in English letters stay as they are. Exactly one output line per input line, in the same order.")
TOOL = {
    "name": "romanized",
    "description": "The lyrics in English letters, one string per input line.",
    "input_schema": {"type": "object", "properties": {"lines": {"type": "array", "items": {"type": "string"}}}, "required": ["lines"]},
}

# Unicode blocks of the scripts that need it. Latin (and anything not listed) doesn't.
SCRIPTS = (
    ("Devanagari", 0x0900, 0x097F), ("Bengali", 0x0980, 0x09FF), ("Gurmukhi", 0x0A00, 0x0A7F),
    ("Gujarati", 0x0A80, 0x0AFF), ("Odia", 0x0B00, 0x0B7F), ("Tamil", 0x0B80, 0x0BFF), ("Telugu", 0x0C00, 0x0C7F),
    ("Kannada", 0x0C80, 0x0CFF), ("Malayalam", 0x0D00, 0x0D7F), ("Sinhala", 0x0D80, 0x0DFF), ("Arabic", 0x0600, 0x06FF),
    ("Hebrew", 0x0590, 0x05FF), ("Thai", 0x0E00, 0x0E7F), ("Cyrillic", 0x0400, 0x04FF), ("Greek", 0x0370, 0x03FF),
    ("Hangul", 0xAC00, 0xD7AF), ("Kana", 0x3040, 0x30FF), ("Han", 0x4E00, 0x9FFF),
)


def script_of(lines: list[str]) -> str | None:
    """The script the lyrics are mostly written in, when it isn't Latin; None when it is."""
    counts: dict[str, int] = {}
    latin = 0
    for text in lines:
        for ch in text:
            if not ch.isalpha():
                continue
            o = ord(ch)
            if o < 0x0250:
                latin += 1
                continue
            for name, lo, hi in SCRIPTS:
                if lo <= o <= hi:
                    counts[name] = counts.get(name, 0) + 1
                    break
    if not counts:
        return None
    name, n = max(counts.items(), key=lambda kv: kv[1])
    return name if n > 0.3 * (n + latin) else None


async def romanize(client: httpx.AsyncClient, lines: list[str], title: str, artist: str) -> list[str] | None:
    """The same lines in English letters (empty lines stay empty), or None when it can't be done
    now (no gateway configured, or it failed: the caller tries again later)."""
    if not LLM_KEY:
        return None
    todo = [i for i, t in enumerate(lines) if t.strip()]
    chunks = [todo[k:k + CHUNK] for k in range(0, len(todo), CHUNK)]
    try:
        results = await asyncio.gather(*(_call(client, [lines[i] for i in c], title, artist) for c in chunks))
    except Exception as e:
        log.warning("romanizing %r failed: %s: %s", title, type(e).__name__, e)
        return None
    out = list(lines)
    for c, got in zip(chunks, results):
        if got is None:
            return None
        for i, text in zip(c, got):
            out[i] = " ".join(str(text).split())
    return out


async def _call(client: httpx.AsyncClient, lines: list[str], title: str, artist: str) -> list[str] | None:
    body = {
        "model": MODEL,
        "max_tokens": 4000,
        "system": SYSTEM,
        "tools": [TOOL],
        "tool_choice": {"type": "tool", "name": "romanized"},
        "messages": [{"role": "user", "content": json.dumps({"song": title, "artist": artist, "lines": lines}, ensure_ascii=False)}],
    }
    for attempt in range(2):
        r = await client.post(LLM_URL + "/v1/messages", json=body, timeout=60,
                              headers={"x-api-key": LLM_KEY, "anthropic-version": "2023-06-01"})
        r.raise_for_status()
        use = next((b for b in r.json().get("content", []) if b.get("type") == "tool_use"), None)
        got = (use or {}).get("input", {}).get("lines")
        if isinstance(got, list) and len(got) == len(lines):
            return got
        log.warning("romanizing %r: %s lines back for %d (try %d)", title, len(got) if isinstance(got, list) else "no", len(lines), attempt + 1)
    return None
