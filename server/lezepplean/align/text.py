"""Lyric text → what the acoustic model can align, word by word.

The watch highlights *display* words: a lyric line split exactly like Python's
`str.split()` (the watch splits the same way). The CTC model only knows the letters
A-Z, the apostrophe and a word separator, so every display word is turned into a
"spoken" spelling: accents dropped, digits read out, other scripts romanized. A
display word with nothing speakable left (a dash, an ellipsis, a lone "♪") gets no
tokens; its time is interpolated from its neighbours afterwards.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache

_SPEAKABLE = re.compile(r"[A-Z']+")
_DIGITS = re.compile(r"\d+")
_LATIN_OR_COMMON = re.compile(r"^[\u0000-ɏḀ-ỿ -⁯←-⯿　-〿＀-￯]*$")

_ONES = "ZERO ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT NINE TEN ELEVEN TWELVE THIRTEEN FOURTEEN FIFTEEN SIXTEEN SEVENTEEN EIGHTEEN NINETEEN".split()
_TENS = "_ _ TWENTY THIRTY FORTY FIFTY SIXTY SEVENTY EIGHTY NINETY".split()


def display_words(text: str) -> list[str]:
    """The words of a line as the watch shows them (Python str.split semantics)."""
    return text.split()


def number_words(n: int) -> str:
    """Cardinal number in words, the way it is usually sung ("1999" -> nineteen ninety nine)."""
    if n < 20:
        return _ONES[n]
    if n < 100:
        return _TENS[n // 10] + ("" if n % 10 == 0 else " " + _ONES[n % 10])
    if 1100 <= n <= 1999 or 2010 <= n <= 2099:  # years are sung as two pairs
        hi, lo = divmod(n, 100)
        return number_words(hi) + " " + ("HUNDRED" if lo == 0 else ("OH " + _ONES[lo] if lo < 10 else number_words(lo)))
    if n < 1000:
        hi, lo = divmod(n, 100)
        return _ONES[hi] + " HUNDRED" + ("" if lo == 0 else " " + number_words(lo))
    if n < 1_000_000:
        hi, lo = divmod(n, 1000)
        return number_words(hi) + " THOUSAND" + ("" if lo == 0 else " " + number_words(lo))
    return " ".join(_ONES[int(d)] for d in str(n))


@lru_cache(maxsize=1)
def _uroman():
    try:
        import uroman  # optional: only needed for lyrics in non-Latin scripts

        return uroman.Uroman()
    except Exception:  # not installed, or its data failed to load: those words are interpolated
        return None


def romanize(word: str) -> str:
    if _LATIN_OR_COMMON.match(word):
        return word
    ur = _uroman()
    if ur is None:
        return word
    try:
        return str(ur.romanize_string(word))
    except Exception:
        return word


def spoken(word: str) -> list[str]:
    """Speakable parts of one display word: ["DONT"], ["TWENTY", "FOUR", "SEVEN"], or [] if none."""
    w = romanize(word)
    w = w.replace("’", "'").replace("‘", "'").replace("`", "'").replace("&", " AND ")
    w = _DIGITS.sub(lambda m: " " + number_words(int(m.group())) + " ", w)
    w = unicodedata.normalize("NFKD", w)
    w = "".join(ch for ch in w if not unicodedata.combining(ch)).upper()
    parts = []
    for p in _SPEAKABLE.findall(w):
        p = p.strip("'")  # quotes, not elisions ("'cause" keeps its letters, the quote is not sung)
        if p:
            parts.append(p)
    return parts


@dataclass
class LineTokens:
    words: list[str]               # display words
    spoken: list[list[str]]        # speakable parts per display word ([] = nothing to align)


def tokenize_line(text: str) -> LineTokens:
    words = display_words(text)
    return LineTokens(words=words, spoken=[spoken(w) for w in words])


_VOWEL_GROUPS = re.compile(r"[AEIOUY]+")


def syllables(part: str) -> int:
    """Rough syllable count of one speakable part, for the no-audio fallback."""
    n = len(_VOWEL_GROUPS.findall(part))
    if part.endswith("E") and not part.endswith(("LE", "EE")) and n > 1:
        n -= 1  # silent final e
    return max(1, n)
