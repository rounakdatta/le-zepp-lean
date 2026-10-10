"""Print the per-packet SILK gain index (a loudness proxy) of Zepp recorder clips.

    uv run python scripts/silk_levels.py captures/*.zepp.opus

The reader itself is lezepplean/silk.py, the reference for watch-app/lib/silk.js.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lezepplean import zepp_opus  # noqa: E402
from lezepplean.silk import silk_level  # noqa: E402

if __name__ == "__main__":
    for path in sys.argv[1:]:
        packets, _ = zepp_opus.split_packets(Path(path).read_bytes())
        levels = [silk_level(p) for p in packets]
        print(Path(path).name, " ".join(str(lv[0]) if lv else "-" for lv in levels))
