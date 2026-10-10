"""CTC forced alignment of a whole song's lyrics, held inside each line's LRC window.

Standard CTC Viterbi: the transcript becomes the state chain
    blank, t1, blank, t2, blank, ... tK, blank
and the best path through the per-frame letter probabilities says which frames each
letter was sung on. Two things make it work on whole songs rather than sentences:

- **Line windows.** LRCLIB already says roughly when each line starts. A line's letters
  may only be placed between (its start - slack) and (the next line's start + slack).
  That keeps a chorus from sliding onto the identical chorus a minute later, keeps
  backing vocals from capturing the next line, and shrinks the work to a band a few
  lines wide instead of the whole song.
- **One global path.** Lines are aligned together, not one by one, so the end of one
  line and the start of the next can never overlap or swap.

Because both window edges only move forward along the chain, the states allowed at any
frame form one contiguous range, and the trellis is computed on that band alone.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

NEG = np.float32(-1e30)


@dataclass
class Chain:
    tokens: np.ndarray     # (S,) token id per state
    skip: np.ndarray       # (S,) bool: may enter this state from s-2 (non-blank, differs from s-2)
    lo: np.ndarray         # (S,) first frame the state may occupy
    hi: np.ndarray         # (S,) last frame the state may occupy
    word: np.ndarray       # (S,) global word index of a letter state, -1 for blanks/separators
    cost: np.ndarray       # (S,) log-prob charged per frame spent in the state


def build_chain(words: list[tuple[int, list[str]]], line_windows: list[tuple[int, int]], letters: dict[str, int],
                blank: int, separator: int, frames: int, gap_cost: float = 0.0, separators: bool = True) -> Chain:
    """words: (line index, speakable parts) per alignable word, in song order.

    line_windows: (first frame, last frame) allowed per line index.
    gap_cost: charged per frame of silence *between words of one line*. Singers rarely
    stop for long mid-line, but with weak evidence the cheapest path smears a line's
    words across a whole instrumental break; this makes that cost something.
    """
    tokens: list[int] = []
    lo: list[int] = []
    hi: list[int] = []
    word: list[int] = []
    cost: list[float] = []

    def add(tok: int, a: int, b: int, w: int, c: float = 0.0) -> None:
        tokens.append(tok)
        lo.append(a)
        hi.append(b)
        word.append(w)
        cost.append(c)

    first_line = words[0][0] if words else 0
    add(blank, 0, line_windows[first_line][1], -1)
    for wi, (line, parts) in enumerate(words):
        a, b = line_windows[line]
        if wi > 0:
            prev_line = words[wi - 1][0]
            if prev_line != line:  # the gap between two lines may sit anywhere in either window
                ga, gb, gc = line_windows[prev_line][0], b, 0.0
                # the blank after the previous line's last letter is that line's trailing silence: free
                cost[-1] = 0.0
            else:
                ga, gb, gc = a, b, gap_cost
                cost[-1] = gap_cost  # the blank after the previous word's last letter is a mid-line gap
            if separators:
                add(separator, ga, gb, -1, gc)
                add(blank, ga, gb, -1, gc)
        for pi, part in enumerate(parts):
            if pi > 0:
                if separators:
                    add(separator, a, b, -1)
                    add(blank, a, b, -1)
            for ch in part:
                add(letters[ch], a, b, wi)
                add(blank, a, b, -1)
    if words:
        lo[-1] = line_windows[words[-1][0]][0]
        hi[-1] = frames - 1
    toks = np.array(tokens, dtype=np.int64)
    skip = np.zeros(len(toks), dtype=bool)
    skip[2:] = (toks[2:] != blank) & (toks[2:] != toks[:-2])
    lo_a = np.maximum.accumulate(np.clip(np.array(lo), 0, frames - 1))
    hi_a = np.minimum.accumulate(np.clip(np.array(hi), 0, frames - 1)[::-1])[::-1]
    return Chain(toks, skip, lo_a, hi_a, np.array(word, dtype=np.int64), np.array(cost, dtype=np.float32))


def viterbi(log_probs: np.ndarray, chain: Chain) -> np.ndarray | None:
    """Best state per frame (shape (frames,)), or None when no path fits the windows."""
    T = log_probs.shape[0]
    S = len(chain.tokens)
    if T == 0 or S == 0:
        return None
    # Frame t may hold states [first[t], last[t]]: those whose window contains t.
    first = np.searchsorted(chain.hi, np.arange(T), side="left")
    last = np.searchsorted(chain.lo, np.arange(T), side="right") - 1
    if np.any(first > last) or first[0] != 0:
        return None

    tokens = chain.tokens
    skip = chain.skip
    cost = chain.cost
    prev = np.full(S + 2, NEG, dtype=np.float32)  # two guard cells in front: index s+2 holds state s
    back: list[np.ndarray] = []
    for t in range(T):
        l, h = int(first[t]), int(last[t])
        cur = np.full(S + 2, NEG, dtype=np.float32)
        emit = log_probs[t, tokens[l: h + 1]] - cost[l: h + 1]  # only the band: a (frames x states) matrix would be ~250 MB
        if t == 0:
            cur[2] = emit[0]
            if h >= 1:
                cur[3] = emit[1]
            back.append(np.zeros(h - l + 1, dtype=np.int8))
        else:
            stay = prev[l + 2: h + 3]
            one = prev[l + 1: h + 2]
            two = np.where(skip[l: h + 1], prev[l: h + 1], NEG)
            cand = np.stack([stay, one, two])
            arg = cand.argmax(axis=0)
            cur[l + 2: h + 3] = cand[arg, np.arange(h - l + 1)] + emit
            back.append(arg.astype(np.int8))
        prev = cur
    tail = [S - 1, S - 2] if S > 1 else [S - 1]
    end = max(tail, key=lambda s: prev[s + 2])
    if prev[end + 2] <= NEG / 2:
        return None
    path = np.empty(T, dtype=np.int64)
    s = end
    for t in range(T - 1, -1, -1):
        path[t] = s
        s -= int(back[t][s - int(first[t])]) if t > 0 else 0
    return path


@dataclass
class WordSpan:
    start: int        # first frame of the word's first letter
    end: int          # one past the last frame of its last letter
    confidence: float # mean over its letters of the best probability on their frames


def word_spans(log_probs: np.ndarray, chain: Chain, path: np.ndarray, n_words: int) -> list[WordSpan | None]:
    spans: list[WordSpan | None] = [None] * n_words
    starts = np.full(n_words, -1)
    ends = np.full(n_words, -1)
    best: dict[int, float] = {}
    for t, s in enumerate(path):
        w = chain.word[s]
        if w < 0:
            continue
        if starts[w] < 0:
            starts[w] = t
        ends[w] = t + 1
        p = float(np.exp(log_probs[t, chain.tokens[s]]))
        if p > best.get(s, -1.0):
            best[s] = p
    per_word: dict[int, list[float]] = {}
    for s, p in best.items():
        per_word.setdefault(int(chain.word[s]), []).append(p)
    for w in range(n_words):
        if starts[w] >= 0:
            probs = per_word.get(w, [0.0])
            spans[w] = WordSpan(int(starts[w]), int(ends[w]), float(np.mean(probs)))
    return spans
