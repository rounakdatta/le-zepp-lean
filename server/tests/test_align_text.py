from lezepplean.align.text import number_words, spoken, syllables, tokenize_line


def test_display_words_split_like_the_watch():
    lt = tokenize_line("  Today  is\tgonna ")
    assert lt.words == ["Today", "is", "gonna"]


def test_spoken_spelling():
    assert spoken("Don't") == ["DON'T"]
    assert spoken("'cause") == ["CAUSE"]          # a quote is not sung; the letters are
    assert spoken("café") == ["CAFE"]             # accents dropped
    assert spoken("24/7") == ["TWENTY", "FOUR", "SEVEN"]
    assert spoken("rock&roll") == ["ROCK", "AND", "ROLL"]
    assert spoken("—") == []                       # nothing to sing: interpolated later
    assert spoken("(yeah)") == ["YEAH"]


def test_numbers_read_the_way_they_are_sung():
    assert number_words(1999) == "NINETEEN NINETY NINE"
    assert number_words(2024) == "TWENTY TWENTY FOUR"
    assert number_words(1900) == "NINETEEN HUNDRED"
    assert number_words(42) == "FORTY TWO"
    assert number_words(300) == "THREE HUNDRED"


def test_other_scripts_are_romanized():
    parts = spoken("दिल")  # Hindi "heart"
    assert parts and all(p.isalpha() for p in parts)


def test_syllables_roughly():
    assert syllables("TODAY") == 2
    assert syllables("THE") == 1
    assert syllables("TIME") == 1
