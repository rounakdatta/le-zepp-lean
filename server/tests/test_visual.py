"""Indic text in the order the watch draws it (checked on a T-Rex 3: the reordered lines read right)."""

from lezepplean.visual import reorder


def test_a_vowel_sign_written_before_its_consonant_is_stored_there():
    assert reorder("दिल", "Devanagari") == "िदल"
    assert reorder("আমি", "Bengali") == "আিম"


def test_it_goes_before_the_whole_conjunct_in_scripts_that_join():
    assert reorder("स्थिति", "Devanagari") == "िस्थित"


def test_two_part_vowels_are_split_around_their_consonant():
    assert reorder("তোমাকে", "Bengali") == "েতামােক"
    assert reorder("கொஞ்சம்", "Tamil") == "ெகாஞ்சம்"


def test_tamil_does_not_join_consonants_so_the_sign_is_the_last_ones_alone():
    assert reorder("பெண்ணே", "Tamil") == "ெபண்ேண"


def test_everything_else_is_left_alone():
    assert reorder("कोई", "Devanagari") == "कोई"
    assert reorder("Tum hi ho", "Devanagari") == "Tum hi ho"
    assert reorder("నాటు", "Telugu") == "నాటు"


def test_assamese_letters_take_their_vowel_sign_in_front_too():
    # ৰ (ra) and ৱ (wa) are Assamese-only consonants: "Bengali, Assamese" in the settings
    assert reorder("ৰি", "Bengali") == "িৰ"
    assert reorder("ৱে", "Bengali") == "েৱ"
    assert reorder("ৰো", "Bengali") == "েৰা"
    assert reorder("প্ৰি", "Bengali") == "িপ্ৰ"
