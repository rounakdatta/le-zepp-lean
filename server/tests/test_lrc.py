from lezepplean.lyrics import parse_lrc, primary_artist


def test_parses_lines_and_fractions():
    assert parse_lrc("[00:13.13] Yeah\n[00:16.5]Next\n[01:02.345] Third") == [
        (13130, "Yeah"), (16500, "Next"), (62345, "Third"),
    ]


def test_multiple_timestamps_and_sorting():
    assert parse_lrc("[00:30.00][00:10.00] Chorus\n[00:20.00] Verse") == [
        (10000, "Chorus"), (20000, "Verse"), (30000, "Chorus"),
    ]


def test_metadata_skipped_and_offset_applied():
    # A positive [offset:] makes lyrics appear earlier.
    assert parse_lrc("[ar:Someone]\n[offset:+500]\n[00:10.00] Hi") == [(9500, "Hi")]


def test_music_note_becomes_gap():
    assert parse_lrc("[00:16.56] ♪\n[00:20.00]") == [(16560, ""), (20000, "")]


def test_primary_artist():
    assert primary_artist("The Weeknd & ROSALÍA") == "The Weeknd"
    assert primary_artist("Calvin Harris, Dua Lipa") == "Calvin Harris"
    assert primary_artist("Arijit Singh") == "Arijit Singh"
