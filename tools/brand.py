"""Every place the LeZeppLean logo appears, made from brand/logo-source.png (the design as drawn).

    uv run --no-project --with pillow --with numpy --with scipy python tools/brand.py

The zeppelin is lifted off its background once (the dark background and the dark outline
around the zeppelin are one connected region; everything inside the outline stays), then
every format is composed from it and the logo's own gradient: a rounded square (README,
web page), a circle (the watch draws app icons round), Android's adaptive-icon layers.
"""

from __future__ import annotations

import base64
import io
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "brand" / "logo-source.png"
TOP, BOTTOM = (0x0E, 0x19, 0x31), (0x03, 0x03, 0x0A)  # the background gradient, sampled
INNER = (83, 84, 1169, 1162)  # the drawn rounded square inside the source's frame
DARK = 64  # brighter than this in any channel is the zeppelin


def zeppelin() -> Image.Image:
    """The zeppelin alone, transparent around it, cropped tight."""
    im = Image.open(SRC).convert("RGB").crop(INNER)
    a = np.asarray(im)
    dark = a.max(axis=2) < DARK
    labels, _ = ndimage.label(dark)
    edge = set(np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))) - {0}
    background = np.isin(labels, list(edge))
    # the zeppelin is where its cream and coral are (a dark band along the drawn square's
    # top edge isn't connected to the background around it, and isn't part of it either)
    ys, xs = np.nonzero(a.max(axis=2) >= 128)
    box = (max(0, xs.min() - 12), max(0, ys.min() - 12), min(a.shape[1], xs.max() + 13), min(a.shape[0], ys.max() + 13))
    keep = np.zeros(dark.shape, bool)
    keep[box[1]:box[3], box[0]:box[2]] = True
    alpha = Image.fromarray(np.where(background | ~keep, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8))
    out = im.convert("RGBA")
    out.putalpha(alpha)
    return out.crop(box)


def gradient(size: int) -> Image.Image:
    t = np.linspace(0, 1, size)[:, None, None]
    rows = (np.array(TOP) * (1 - t) + np.array(BOTTOM) * t).astype(np.uint8)
    return Image.fromarray(np.repeat(rows, size, axis=1), "RGB").convert("RGBA")


def compose(size: int, shape: str, width: float, z: Image.Image) -> Image.Image:
    """The zeppelin `width` of the canvas wide, centred (a touch high, as drawn), on the
    gradient inside `shape`: "square" (rounded) or "circle"."""
    canvas = gradient(size)
    w = round(size * width)
    h = round(z.height * w / z.width)
    canvas.alpha_composite(z.resize((w, h), Image.LANCZOS), ((size - w) // 2, round(size * 0.48 - h / 2)))
    mask = Image.new("L", (size * 4, size * 4), 0)
    d = ImageDraw.Draw(mask)
    if shape == "circle":
        d.ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    else:
        d.rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1), radius=round(size * 4 * 0.225), fill=255)
    canvas.putalpha(mask.resize((size, size), Image.LANCZOS))
    return canvas


def save(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)
    print(f"{path.relative_to(ROOT)}: {img.width}x{img.height}, {path.stat().st_size} bytes")


def main() -> None:
    z = zeppelin()
    save(z, ROOT / "brand" / "zeppelin.png")
    save(compose(512, "square", 0.80, z), ROOT / "brand" / "logo-512.png")
    save(compose(1024, "circle", 0.70, z), ROOT / "brand" / "icon-round-1024.png")
    # the watch: its app icon (zeus resizes it to 124) and the listening screen's mark
    save(compose(248, "circle", 0.70, z), ROOT / "watch-app" / "assets" / "default.r" / "icon.png")
    save(compose(96, "circle", 0.70, z), ROOT / "watch-app" / "assets" / "default.r" / "logo-96.png")
    # the server: its page, and the browser tab
    save(compose(256, "square", 0.80, z), ROOT / "server" / "lezepplean" / "static" / "logo.png")
    save(compose(64, "circle", 0.74, z), ROOT / "server" / "lezepplean" / "static" / "favicon.png")
    # Android: the adaptive icon's foreground layer, 108 dp at 4x, the zeppelin inside the
    # 66 dp the launcher's mask always shows; the gradient is drawn in XML behind it.
    fg = Image.new("RGBA", (432, 432), (0, 0, 0, 0))
    w = round(432 * 0.60)
    h = round(z.height * w / z.width)
    fg.alpha_composite(z.resize((w, h), Image.LANCZOS), ((432 - w) // 2, round(432 * 0.48 - h / 2)))
    res = ROOT / "android" / "app" / "src" / "main" / "res"
    save(fg, res / "drawable-nodpi" / "ic_launcher_foreground.png")
    save(compose(192, "square", 0.80, z), res / "drawable-nodpi" / "logo.png")
    # the Zepp app's settings page takes an image as base64
    buf = io.BytesIO()
    compose(160, "circle", 0.70, z).save(buf, format="PNG", optimize=True)
    js = ROOT / "watch-app" / "setting" / "logo.js"
    js.write_text("// Made by tools/brand.py from brand/logo-source.png.\nexport const LOGO = 'data:image/png;base64,"
                  + base64.b64encode(buf.getvalue()).decode() + "'\n")
    print(f"{js.relative_to(ROOT)}: {js.stat().st_size} bytes")


if __name__ == "__main__":
    main()
