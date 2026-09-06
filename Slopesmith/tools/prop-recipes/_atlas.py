"""
Shared machinery for painting the prop atlases — the system-Python twin of `_lib.py`.

Needs Pillow, which Blender's bundled interpreter does NOT have, which is why the painting and the
modelling live in separate processes and talk through a PNG on disk.

The house style, and the page size the platform itself uses: a whole machine family — base, head and
both pipe runs — shares ONE 128x128 RGBA page holding a yellow band, a grey plate and a dark fan
housing. A handful of flat, slightly desaturated regions with crumb noise on top. Saturation and smooth
gradients are what make hand-painted low-poly art read as a modern render instead of a PS2 prop.

`panels(cols, rows)` here and `panels(cols, rows)` in `_lib` describe the SAME grid — one in image
pixels, one in UV space. Both are generated from the same two numbers rather than written out by hand,
because a mismatch between them is a silent texture-offset bug that only shows on the model.
"""

import math
import random

from PIL import Image, ImageDraw


def panels(size, cols, rows):
    """The atlas grid as (x0, y0, x1, y1) pixel rects, indexed [row][col] from the image's top-left —
    the same order `_lib.panels` returns its UV rects in."""
    w, h = size // cols, size // rows
    return [[(c * w, r * h, (c + 1) * w, (r + 1) * h) for c in range(cols)] for r in range(rows)]


def blob(draw, rnd, cx, cy, rx, ry, fill, lobes=7):
    """An irregular rounded splat. Deliberately not an ellipse: a cap panel is mapped RADIALLY, so
    anything truly circular in texture space lands as a circle on the prop and reads as a target."""
    pts = []
    for i in range(lobes):
        a = 2 * math.pi * i / lobes
        wob = rnd.uniform(0.72, 1.22)
        pts.append((cx + rx * wob * math.cos(a), cy + ry * wob * math.sin(a)))
    draw.polygon(pts, fill=fill)


def speckle(draw, rnd, rect, n, colours, size=(1, 2)):
    """Crumb noise inside one panel, kept strictly in bounds so nothing bleeds across a panel seam."""
    x0, y0, x1, y1 = rect
    for _ in range(n):
        x = rnd.randint(x0, x1 - 1)
        y = rnd.randint(y0, y1 - 1)
        r = rnd.randint(*size)
        draw.ellipse((x, y, min(x + r, x1 - 1), min(y + r, y1 - 1)), fill=rnd.choice(colours))


def scatter_blobs(draw, rnd, rect, n, colour, radius, lobes=9, margin=4):
    """n irregular patches spread over a panel — bake blooms, wear, dirt, tread scuffing."""
    x0, y0, x1, y1 = rect
    for _ in range(n):
        # Centre, then radius, then the y-factor. The order is part of the contract: every draw here
        # consumes the seeded stream, so changing it repaints every atlas that calls this.
        cx = rnd.uniform(x0 + margin, x1 - margin)
        cy = rnd.uniform(y0 + margin, y1 - margin)
        r = rnd.uniform(*radius)
        blob(draw, rnd, cx, cy, r, r * rnd.uniform(0.7, 1.3), colour, lobes=lobes)


def stripes(draw, rect, colour, count, horizontal=False, width=(1.0, 3.2), rnd=None):
    """Streaks across a panel — drips down ice cream, tread bars across a track, brushed metal."""
    x0, y0, x1, y1 = rect
    rnd = rnd or random.Random(0)
    for _ in range(count):
        if horizontal:
            y = rnd.uniform(y0 + 1, y1 - 2)
            draw.rectangle((x0, y, x1 - 1, y + rnd.uniform(*width)), fill=colour)
        else:
            x = rnd.uniform(x0 + 1, x1 - 2)
            draw.rectangle((x, y0, x + rnd.uniform(*width), y1 - 1), fill=colour)


def bars(draw, rect, colour, count, thickness, horizontal=True):
    """Evenly spaced bars — a snowmobile track's cleats, a grille, a ladder. Regular on purpose, unlike
    `stripes`."""
    x0, y0, x1, y1 = rect
    span = (y1 - y0) if horizontal else (x1 - x0)
    for k in range(count):
        t = y0 + span * (k + 0.5) / count if horizontal else x0 + span * (k + 0.5) / count
        if horizontal:
            draw.rectangle((x0, t - thickness / 2, x1 - 1, t + thickness / 2), fill=colour)
        else:
            draw.rectangle((t - thickness / 2, y0, t + thickness / 2, y1 - 1), fill=colour)


def hazard(draw, rect, stripe, pitch=12, thickness=5, lean=0.34):
    """Leaning hazard bars, clipped to their own panel.

    Drawn as per-row spans rather than as polygons, because ImageDraw does NOT clip a polygon to
    anything — a bar that leans out of its cell is simply drawn into the neighbour. That is invisible
    on the page at 1x and invisible in the recipe, and it surfaces as another prop's paint appearing
    on this one: black diagonals across a lamp cell put the dark stripes on everything the lamp
    panel dresses. Every other helper here stays inside `rect` for the same reason, so this one does
    too rather than leaving the caller to remember.

    `lean` is x per y — 0.34 leans a bar 11 px across a 32 px cell.
    """
    x0, y0, x1, y1 = rect
    reach = int(lean * (y1 - y0)) + thickness
    for k in range(-(reach // pitch) - 1, (x1 - x0) // pitch + 2):
        for y in range(y0, y1):
            left = x0 + k * pitch - lean * (y - y0)
            a, b = max(x0, round(left)), min(x1 - 1, round(left + thickness) - 1)
            if a <= b:
                draw.rectangle((a, y, b, y), fill=stripe)


def filmstrip(pages):
    """Stack square frame pages into one flipbook page, top to bottom.

    A flipbook material's art is a FILMSTRIP: every frame carries the identical panel layout and differs
    only in paint, which is what lets the model's UVs be authored against one frame and address all of
    them. So each frame is painted by the same routine into an ordinary `new_atlas` page — `panels()` and
    `_lib.panels()` still describe one band — and this only stacks the results. `_lib.surface(frames=N)`
    / `finish(frames=N)` declares the count, and Slopesmith's importer cuts the strip back into N tiles.
    """
    if not pages:
        raise ValueError('a filmstrip needs at least one frame page')
    size = pages[0].size[0]
    if any(page.size != (size, size) for page in pages):
        raise ValueError('every frame of a filmstrip must be the same square page')
    strip = Image.new('RGBA', (size, size * len(pages)))
    for index, page in enumerate(pages):
        strip.paste(page, (0, size * index))
    return strip


def new_atlas(size, bg=(0, 0, 0, 255)):
    """A blank page. For an alpha-CUTOUT atlas pass a transparent background whose RGB still carries the
    art's own colour — e.g. `(54, 86, 62, 0)` for foliage.

    Transparent-BLACK is the classic mistake: alpha is tested after filtering, so mip levels and bilinear
    taps blend the invisible pixels' RGB into the visible edge and every needle gets a dark halo. Same
    colour, zero alpha, no halo.
    """
    img = Image.new('RGBA', (size, size), bg)
    return img, ImageDraw.Draw(img)
