"""Draw the watch screens recorded by screens.mjs, as 480x480 PNGs with the round mask.

    python render.py widths              # write widths.json (font metrics for the stand-in)
    python render.py draw shots.json out/
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent


def _find_font() -> str:
    """LEZEPPLEAN_FONT, else an Arial-like sans: the watch's own font isn't available."""
    if os.environ.get("LEZEPPLEAN_FONT"):
        return os.environ["LEZEPPLEAN_FONT"]
    if shutil.which("fc-match"):
        found = subprocess.run(["fc-match", "-f", "%{file}", "Liberation Sans"], capture_output=True, text=True).stdout
        if found and Path(found).exists():
            return found
    for p in ("/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if Path(p).exists():
            return p
    raise SystemExit("no font found: set LEZEPPLEAN_FONT to a .ttf")


FONT = _find_font()


def font(size):
    return ImageFont.truetype(FONT, size)


def widths():
    f = font(100)
    chars = [chr(c) for c in range(32, 127)] + list("’‘“”…•—–▲▼●éèáíóúñçöüäß")
    out = {"size": 100, "fallback": round(f.getlength("n")), "widths": {ch: f.getlength(ch) for ch in chars}}
    (HERE / "widths.json").write_text(json.dumps(out))


def rgb(c):
    return ((c >> 16) & 255, (c >> 8) & 255, c & 255)


def wrap(text, f, width):
    rows = []
    for para in text.split("\n"):
        row = ""
        for w in para.split():
            nxt = (row + " " + w) if row else w
            if row and f.getlength(nxt) > width:
                rows.append(row)
                row = w
            else:
                row = nxt
        rows.append(row)
    return rows


def draw(shots, out):
    out.mkdir(parents=True, exist_ok=True)
    for name, ws in shots.items():
        im = Image.new("RGB", (480, 480), (0, 0, 0))
        d = ImageDraw.Draw(im)
        for w in ws:
            if not w.get("visible", True):
                continue
            t = w["type"]
            if t == "FILL_RECT" and w["w"] > 0 and w["h"] > 0:
                d.rounded_rectangle([w["x"], w["y"], w["x"] + w["w"], w["y"] + w["h"]], radius=w.get("radius", 0), fill=rgb(w.get("color", 0)))
            elif t == "ARC":
                r = w["radius"]
                cx, cy = w["x"] + w["w"] / 2, w["y"] + w["h"] / 2
                d.arc([cx - r, cy - r, cx + r, cy + r], w["start_angle"], w["end_angle"], fill=rgb(w.get("color", 0)), width=w.get("line_width", 1))
            elif t == "TEXT" and w.get("text"):
                f = font(int(w.get("text_size", 20)))
                lh = int(w.get("text_size", 20) * 1.25)
                style = w.get("text_style")
                rows = wrap(w["text"], f, w["w"]) if style == "wrap" else [w["text"]]
                if style == "ellipsis" and f.getlength(rows[0]) > w["w"]:
                    s = rows[0]
                    while s and f.getlength(s + "…") > w["w"]:
                        s = s[:-1]
                    rows = [s + "…"]
                total = lh * len(rows)
                y = w["y"] + (w["h"] - total) / 2 if w.get("align_v") == "center_v" else w["y"]
                for row in rows:
                    tw = f.getlength(row)
                    x = w["x"] + (w["w"] - tw) / 2 if w.get("align_h") == "center_h" else w["x"]
                    d.text((x, y + (lh - w.get("text_size", 20)) / 2), row, font=f, fill=rgb(w.get("color", 0xFFFFFF)))
                    y += lh
        mask = Image.new("L", (480, 480), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, 479, 479], fill=255)
        bg = Image.new("RGB", (480, 480), (40, 40, 40))
        bg.paste(im, (0, 0), mask)
        bg.save(out / f"{name}.png")
    print(f"{len(shots)} screens -> {out}")


if __name__ == "__main__":
    if sys.argv[1] == "widths":
        widths()
    else:
        draw(json.loads(Path(sys.argv[2]).read_text()), Path(sys.argv[3]))
