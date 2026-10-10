"""The forced aligner on synthetic letter probabilities, where the right answer is known."""
import numpy as np

from lezepplean.align import align_lyrics, line_windows_ms
from lezepplean.align.ctc import Emissions

LETTERS = {ch: i + 5 for i, ch in enumerate("ABCDEFGHIJKLMNOPQRSTUVWXYZ'")}
BLANK, SEP = 0, 4


def synthetic(frames: int, sung: list[tuple[int, str]]) -> Emissions:
    """Blank everywhere, except each word's letters peak on consecutive frames from its start."""
    lp = np.full((frames, 40), -12.0, dtype=np.float32)
    lp[:, BLANK] = -0.01
    for start_frame, word in sung:
        for k, ch in enumerate(word.upper()):
            f = start_frame + 2 * k
            lp[f, :] = -12.0
            lp[f, LETTERS[ch]] = -0.01
    return Emissions(lp, BLANK, SEP, LETTERS, 0.0)


def test_words_are_found_where_they_were_sung():
    # "hello world" sung at 1.00 s and 1.50 s; "good night" at 4.00 s and 4.60 s (20 ms frames)
    em = synthetic(400, [(50, "hello"), (75, "world"), (200, "good"), (230, "night")])
    # LRC starts are a little early and a little late, as in real files
    res = align_lyrics(np.zeros(0, np.float32), [(800, "Hello world"), (4200, "Good night")], emissions=em, bias_ms=0,
                       min_confidence=0.0)
    assert res.lines[0].words == [1000, 1500]
    assert res.lines[1].words == [4000, 4600]
    assert res.lines[0].start_ms == 1000            # the line start is refined to its first word
    assert res.lines[0].method == "ctc"


def test_a_line_cannot_slide_into_a_repeat_of_itself():
    # The same line is sung twice; each LRC line must take its own occurrence.
    em = synthetic(800, [(50, "yeah"), (500, "yeah")])
    res = align_lyrics(np.zeros(0, np.float32), [(1000, "Yeah"), (10_000, "Yeah")], emissions=em, bias_ms=0,
                       min_confidence=0.0)
    assert res.lines[0].words == [1000]
    assert res.lines[1].words == [10_000]


def test_unsure_lines_come_back_without_words():
    em = synthetic(400, [(50, "hello"), (75, "world")])
    em.log_probs[:, :] = np.log(1 / 40)  # no evidence at all: every frame says nothing
    res = align_lyrics(np.zeros(0, np.float32), [(1000, "Hello world")], emissions=em, min_confidence=0.10)
    assert res.lines[0].words is None
    assert res.lines[0].start_ms == 1000            # the line keeps its LRC timing


def test_words_with_nothing_to_sing_get_neighbouring_times():
    em = synthetic(300, [(50, "hey"), (90, "you")])
    res = align_lyrics(np.zeros(0, np.float32), [(900, "Hey — you")], emissions=em, bias_ms=0, min_confidence=0.0)
    w = res.lines[0].words
    assert len(w) == 3 and w[0] == 1000 and w[2] == 1800
    assert w[0] <= w[1] <= w[2]


def test_instrumental_gap_lines_are_left_alone():
    em = synthetic(400, [(50, "hello")])
    res = align_lyrics(np.zeros(0, np.float32), [(900, "Hello"), (3000, "")], emissions=em, bias_ms=0, min_confidence=0.0)
    assert res.lines[1].words is None and res.lines[1].text == ""


def test_long_breaks_do_not_stretch_a_line():
    # Without a cap, the window of a line followed by a 30 s break is 30 s long.
    w = line_windows_ms([1000, 31_000], 60_000, 1000, 1200, caps=[3000 + 800 * 2, 3000 + 800 * 2])
    assert w[0] == (0, 1000 + 1000 + 4600)
