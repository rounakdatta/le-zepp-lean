"""Word timings for line-synced lyrics, computed on the CPU from the song's audio.

Free word-synced lyrics basically don't exist (LRCLIB had word timing for 0 of 13
popular songs), so the server makes its own: LRCLIB gives each line's start, a small
wav2vec 2.0 speech model (ONNX, int8) gives letter probabilities every 20 ms, and a
forced alignment held inside each line's window says when every word starts.

    lines = align_lyrics(audio_16k, [(13130, "Today is gonna be the day"), ...], model)

Every line keeps working without word timings: a line the aligner isn't sure about
comes back with `words=None` and the watch shows it line by line, as in v0.1.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import numpy as np

from . import forced
from .ctc import FRAME_MS, CtcModel, Emissions
from .text import syllables, tokenize_line

log = logging.getLogger("lezepplean.align")

# Measured on JamendoLyrics, 20 English songs, 5,693 words (scripts/eval_align.py), with
# LRC line starts simulated 100 ms early +- 250 ms. On Spleeter vocals, with these settings:
# median error 46 ms; 76% of words within 100 ms, 90% within 300 ms. Showing words only
# for lines at MIN_LINE_CONFIDENCE or above keeps 91% of words, of which 81% are within
# 100 ms and 94% within 300 ms; below it only ~40% are, so those lines stay line by line.
# (On the plain mix: median 78 ms, 56% within 100 ms, 72% within 300 ms.)
SLACK_BEFORE_MS = 1000
SLACK_AFTER_MS = 1200
WORD_BIAS_MS = -30        # CTC letters fire ~30 ms after the sung onset (median, measured)
MIN_LINE_CONFIDENCE = 0.10
GAP_COST = 0.05           # per 20 ms frame of silence between two words of one line


@dataclass
class AlignedLine:
    lrc_ms: int                    # start time from the LRC file
    text: str
    start_ms: int                  # when the line starts (its first word, if aligned)
    words: list[int] | None        # start of each display word (text.split()), or None
    end_ms: int | None             # end of the last word, if aligned
    confidence: float = 0.0
    method: str = "lrc"            # "ctc" | "lrc"


@dataclass
class Alignment:
    lines: list[AlignedLine]
    seconds: float = 0.0
    model_seconds: float = 0.0
    notes: list[str] = field(default_factory=list)

    @property
    def aligned_lines(self) -> int:
        return sum(1 for line in self.lines if line.words is not None)


# A line is sung within CAP_BASE + CAP_PER_SYLLABLE x syllables of its start: true for
# 99% of the 868 JamendoLyrics lines. Without this, a line followed by a long instrumental
# break (or the song's last line) gets a window tens of seconds long, and with weak
# evidence its words get smeared across all of it.
CAP_BASE_MS = 3000
CAP_PER_SYLLABLE_MS = 800


def line_windows_ms(starts: list[int], song_ms: int, before: int, after: int,
                    caps: list[int] | None = None) -> list[tuple[int, int]]:
    windows = []
    for i, s in enumerate(starts):
        nxt = starts[i + 1] if i + 1 < len(starts) else song_ms
        end = nxt + after
        if caps is not None:
            end = min(end, s + before + caps[i])
        windows.append((max(0, s - before), min(song_ms, max(end, s + 1))))
    return windows


def align_lyrics(audio: np.ndarray, lrc: list[tuple[int, str]], model: CtcModel | None = None,
                 emissions: Emissions | None = None, slack: tuple[int, int] = (SLACK_BEFORE_MS, SLACK_AFTER_MS),
                 bias_ms: int = WORD_BIAS_MS, min_confidence: float = MIN_LINE_CONFIDENCE,
                 gap_cost: float = GAP_COST, separators: bool = True,
                 cap: tuple[int, int] | None = (CAP_BASE_MS, CAP_PER_SYLLABLE_MS)) -> Alignment:
    """Align LRC lines [(start_ms, text)] (sorted; "" = instrumental gap) against 16 kHz audio."""
    import time

    started = time.perf_counter()
    if emissions is None:
        if model is None:
            model = CtcModel()
        emissions = model.emissions(audio)
    frames = emissions.frames
    song_ms = int(frames * FRAME_MS)
    starts = [ms for ms, _ in lrc]
    out = [AlignedLine(lrc_ms=ms, text=text, start_ms=ms, words=None, end_ms=None) for ms, text in lrc]

    # Every alignable display word, in song order: (line index, word index in line, speakable parts)
    plan: list[tuple[int, int, list[str]]] = []
    tokens = []
    for li, (_, text) in enumerate(lrc):
        lt = tokenize_line(text)
        tokens.append(lt)
        for wi, parts in enumerate(lt.spoken):
            if parts and all(ch in emissions.letters for p in parts for ch in p):
                plan.append((li, wi, parts))
    if not plan:
        return Alignment(out, time.perf_counter() - started, emissions.seconds, ["nothing to align"])
    caps = None
    if cap is not None:
        caps = [cap[0] + cap[1] * sum(syllables(p) for parts in lt.spoken for p in parts) for lt in tokens]

    path = None
    chain = None
    # A badly timed LRC line can leave too few frames for its letters: widen, then drop the cap.
    for widen, use_caps in ((1, True), (2, True), (2, False)):
        windows = line_windows_ms(starts, song_ms, slack[0] * widen, slack[1] * widen,
                                  [c * widen for c in caps] if caps and use_caps else None)
        frame_windows = [(int(a / FRAME_MS), int(b / FRAME_MS)) for a, b in windows]
        chain = forced.build_chain([(li, parts) for li, _, parts in plan], frame_windows, emissions.letters,
                                   emissions.blank, emissions.separator, frames, gap_cost, separators)
        path = forced.viterbi(emissions.log_probs, chain)
        if path is not None:
            break
    notes = []
    if path is None:
        notes.append("no alignment fits the line windows")
        return Alignment(out, time.perf_counter() - started, emissions.seconds, notes)

    spans = forced.word_spans(emissions.log_probs, chain, path, len(plan))
    per_line: dict[int, dict[int, forced.WordSpan]] = {}
    for (li, wi, _), span in zip(plan, spans):
        if span is not None:
            per_line.setdefault(li, {})[wi] = span

    for li, line in enumerate(out):
        lt = tokens[li]
        got = per_line.get(li)
        if not lt.words or not got:
            continue
        confidence = float(np.mean([s.confidence for s in got.values()]))
        line.confidence = round(confidence, 3)
        if confidence < min_confidence:
            continue
        starts_ms: list[int | None] = [None] * len(lt.words)
        ends_ms: list[int | None] = [None] * len(lt.words)
        for wi, span in got.items():
            starts_ms[wi] = int(round(span.start * FRAME_MS)) + bias_ms
            ends_ms[wi] = int(round(span.end * FRAME_MS)) + bias_ms
        filled = _fill_gaps(starts_ms, ends_ms, line.lrc_ms)
        line.words = filled
        line.start_ms = filled[0]
        line.end_ms = max(e for e in ends_ms if e is not None)
        line.method = "ctc"
    return Alignment(out, time.perf_counter() - started, emissions.seconds, notes)


def _fill_gaps(starts: list[int | None], ends: list[int | None], fallback: int) -> list[int]:
    """Words with nothing speakable (a dash, an emoji) start where the previous word ended,
    or just before the next one; the result never goes backwards."""
    n = len(starts)
    out: list[int] = []
    for i in range(n):
        s = starts[i]
        if s is None:
            prev_end = next((ends[j] for j in range(i - 1, -1, -1) if ends[j] is not None), None)
            next_start = next((starts[j] for j in range(i + 1, n) if starts[j] is not None), None)
            s = prev_end if prev_end is not None else (next_start if next_start is not None else fallback)
        if out and s < out[-1]:
            s = out[-1]
        out.append(int(s))
    return out


def prior_words(start_ms: int, end_ms: int, text: str, ms_per_syllable: int = 260) -> list[int]:
    """No-audio estimate: words spread by syllable count from the line start. Used only to
    measure what the acoustic model adds (scripts/eval_align.py), never shown on the watch:
    a highlight that is wrong half the time is worse than none."""
    lt = tokenize_line(text)
    counts = [sum(syllables(p) for p in parts) if parts else 1 for parts in lt.spoken]
    total = sum(counts) or 1
    span = min(end_ms - start_ms, total * ms_per_syllable)
    out, acc = [], 0
    for c in counts:
        out.append(int(start_ms + span * acc / total))
        acc += c
    return out
