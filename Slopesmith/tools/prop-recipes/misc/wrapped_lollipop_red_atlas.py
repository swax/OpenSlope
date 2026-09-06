"""Paint the shared atlas for the wrapped-lollipop prototype.

The candy face starts from generated source art derived from the user's reference photo. The stick, candy
edge, and clear heat-sealed wrapper are deterministic Pillow work so the prop can be rebuilt byte-for-byte.

    [0][0] swirl candy face [0][1] swirl candy edge
    [1][0] white stick      [1][1] clear wrapper

Run with system Python:
    python Slopesmith/tools/prop-recipes/misc/wrapped_lollipop_red_atlas.py
"""

import os
import random
import sys

from PIL import Image, ImageDraw, ImageEnhance

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from _atlas import new_atlas, panels, speckle  # noqa: E402

SIZE = 256
SOURCE = os.path.join(ROOT, 'assets', 'wrapped_lollipop_red_source.png')
OUT = os.path.join(ROOT, 'build', 'wrapped_lollipop_red.png')

GRID = panels(SIZE, 2, 2)
CANDY_FACE, CANDY_EDGE = GRID[0]
STICK, WRAPPER = GRID[1]


def paste_panel(atlas, source, rect):
    x0, y0, x1, y1 = rect
    art = source.resize((x1 - x0, y1 - y0), Image.Resampling.LANCZOS)
    atlas.paste(art, (x0, y0))


def main():
    if not os.path.exists(SOURCE):
        raise FileNotFoundError(f'missing generated candy source: {SOURCE}')
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    atlas, draw = new_atlas(SIZE)
    source = Image.open(SOURCE).convert('RGBA')
    source = ImageEnhance.Contrast(source).enhance(1.08)
    source = ImageEnhance.Color(source).enhance(0.92)
    paste_panel(atlas, source, CANDY_FACE)

    # A narrow equatorial sample carries the same red/yellow/green flow around the candy's thickness.
    sx0, sy0, sx1, sy1 = 0, round(source.height * 0.43), source.width, round(source.height * 0.57)
    edge_art = source.crop((sx0, sy0, sx1, sy1))
    paste_panel(atlas, edge_art, CANDY_EDGE)

    rnd = random.Random(20260808)
    x0, y0, x1, y1 = CANDY_EDGE
    for _ in range(7):
        y = rnd.randint(y0 + 2, y1 - 3)
        tone = rnd.choice(((255, 244, 176, 255), (112, 151, 31, 255), (195, 35, 37, 255)))
        draw.line((x0, y, x1 - 1, y + rnd.randint(-2, 2)), fill=tone, width=1)
    speckle(draw, rnd, CANDY_EDGE, 75,
            ((255, 255, 213, 255), (118, 74, 10, 255), (255, 115, 79, 255)), size=(1, 2))

    x0, y0, x1, y1 = STICK
    draw.rectangle(STICK, fill=(235, 233, 217, 255))
    draw.rectangle((x0, y0, x0 + 18, y1 - 1), fill=(255, 255, 246, 255))
    draw.rectangle((x1 - 23, y0, x1 - 1, y1 - 1), fill=(190, 193, 184, 255))
    for _ in range(30):
        x = rnd.randint(x0 + 8, x1 - 9)
        draw.line((x, y0, x + rnd.randint(-2, 2), y1 - 1),
                  fill=(214, 216, 207, rnd.randint(70, 125)), width=1)

    # No fully transparent pixels: Slopesmith classifies this as genuine translucent alpha rather than a
    # leaf-like cutout. The candy and stick panels stay alpha 255 on the same page.
    x0, y0, x1, y1 = WRAPPER
    # Clear-plastic film follows GARI/0050's dominant window alpha: 64/255. Candy and stick stay alpha 255,
    # and the whole page remains one continuously blended atlas rather than a binary cutout mask.
    draw.rectangle(WRAPPER, fill=(218, 240, 246, 64))
    seal = (232, 250, 252, 90)
    seal_hi = (255, 255, 255, 145)
    for inset in (4, 8, 13):
        draw.rectangle((x0 + inset, y0 + inset, x1 - inset - 1, y1 - inset - 1), outline=seal, width=2)
    # Heat-seal ribs along the square perimeter, like the reference photo's little crimp lines.
    for k in range(10, 119, 8):
        draw.line((x0 + k, y0 + 3, x0 + k - 4, y0 + 15), fill=seal_hi, width=2)
        draw.line((x0 + k, y1 - 4, x0 + k + 3, y1 - 16), fill=seal, width=2)
        draw.line((x0 + 3, y0 + k, x0 + 15, y0 + k - 4), fill=seal, width=2)
        draw.line((x1 - 4, y0 + k, x1 - 16, y0 + k + 3), fill=seal_hi, width=2)
    # A handful of asymmetrical folds keep the bag from reading as a glass pane.
    folds = [
        [(x0 + 15, y0 + 26), (x0 + 52, y0 + 48), (x0 + 85, y0 + 34)],
        [(x0 + 18, y0 + 99), (x0 + 45, y0 + 74), (x0 + 109, y0 + 88)],
        [(x0 + 67, y0 + 16), (x0 + 58, y0 + 56), (x0 + 97, y0 + 111)],
    ]
    for points in folds:
        draw.line(points, fill=(250, 255, 255, 120), width=2)
        draw.line([(x + 2, y + 1) for x, y in points], fill=(151, 199, 208, 60), width=1)

    atlas.save(OUT)
    print(f'wrote {OUT} {atlas.size} {atlas.mode}')


if __name__ == '__main__':
    main()
