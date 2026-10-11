"""Indic text rewritten in the order the watch draws it.

The watch's font has the glyphs for several Indic scripts but no shaping: it draws each
character where it comes. Vowel signs that belong before their consonant (Hindi ि, Bengali
ি ে ৈ, Tamil ெ ே ை, ...) therefore land after it, and two-part vowels (Bengali ো, Tamil ொ)
lose their first half. Storing those signs where they are seen fixes the reading order;
conjuncts still show their joining mark (क्ष as क्‍ष), which readers of the script follow.
"""

from __future__ import annotations

# script: (consonant ranges, nukta, virama, signs drawn before the cluster, two-part signs -> (before, after))
_SCRIPTS = {
    "Devanagari": (((0x0915, 0x0939), (0x0958, 0x095F)), 0x093C, 0x094D, {0x093F}, {}),
    # with Assamese ৰ and ৱ (the "Bengali, Assamese" setting)
    "Bengali": (((0x0995, 0x09B9), (0x09DC, 0x09DF), (0x09F0, 0x09F1)), 0x09BC, 0x09CD, {0x09BF, 0x09C7, 0x09C8},
                {0x09CB: (0x09C7, 0x09BE), 0x09CC: (0x09C7, 0x09D7)}),
    "Gurmukhi": (((0x0A15, 0x0A39), (0x0A59, 0x0A5E)), 0x0A3C, 0x0A4D, {0x0A3F}, {}),
    "Gujarati": (((0x0A95, 0x0AB9),), 0x0ABC, 0x0ACD, {0x0ABF}, {}),
    "Tamil": (((0x0B95, 0x0BB9),), None, 0x0BCD, {0x0BC6, 0x0BC7, 0x0BC8},
              {0x0BCA: (0x0BC6, 0x0BBE), 0x0BCB: (0x0BC7, 0x0BBE), 0x0BCC: (0x0BC6, 0x0BD7)}),
    "Malayalam": (((0x0D15, 0x0D39),), None, 0x0D4D, {0x0D46, 0x0D47, 0x0D48},
                  {0x0D4A: (0x0D46, 0x0D3E), 0x0D4B: (0x0D47, 0x0D3E), 0x0D4C: (0x0D46, 0x0D57)}),
}


def reorder(text: str, script: str) -> str:
    """`text` with each pre-base vowel sign moved in front of its consonant cluster."""
    spec = _SCRIPTS.get(script)
    if spec is None:
        return text
    ranges, nukta, virama, before, split = spec

    def consonant(o: int) -> bool:
        return any(lo <= o <= hi for lo, hi in ranges)

    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        o = ord(text[i])
        if not consonant(o):
            out.append(text[i])
            i += 1
            continue
        # a cluster: consonant (+ nukta) (+ virama + consonant (+ nukta))*. Tamil writes its
        # virama out and doesn't join consonants: there a vowel sign is the last one's alone.
        j = i + 1
        while j < n:
            oj = ord(text[j])
            if nukta is not None and oj == nukta:
                j += 1
            elif oj == virama and j + 1 < n and consonant(ord(text[j + 1])):
                if script == "Tamil":
                    out.append(text[i:j + 1])  # this consonant and its pulli stand alone
                    i = j + 1
                j += 2
            else:
                break
        cluster = text[i:j]
        if not cluster:
            continue
        if j < n and ord(text[j]) in before:
            out.append(text[j] + cluster)
            j += 1
        elif j < n and ord(text[j]) in split:
            pre, post = split[ord(text[j])]
            out.append(chr(pre) + cluster + chr(post))
            j += 1
        else:
            out.append(cluster)
        i = j
    return "".join(out)
