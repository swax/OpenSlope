"""
Paint the flipbook atlas for the ride-over button prop.

A FILMSTRIP: two 128x128 frames stacked into one 128x256 RGBA page. Both frames carry the identical
2x2 grid of 64px panels, so the model's UVs are authored against one frame and address both; only the
lamp changes.

    [0][0] lamp        [0][1] lamp rim
    [1][0] plate top   [1][1] plate rim

    frame 0  lamp GREEN — the resting state, and what the placed material shows
    frame 1  lamp RED   — what a crossing pulses to

Nothing here says how the frames play, and that is the point: a frame list is a STATE list. The
`Ride-over button` effect template makes crossing the prop flash frame 1 and settle back; without an
effect the prop just holds frame 0. The same page would serve a two-state warning sign driven by a
dwell flipbook.

`_lib.panels(2, 2)` describes the same grid in UV space; both come from the same two numbers so they
cannot drift apart. Everything is painted from one fixed seed, so a re-run reproduces the page byte for
byte and a tweak is a diff rather than a repaint.

Run with the system Python (needs Pillow) — NOT inside Blender, whose bundled Python has none:
    python Slopesmith/tools/prop-recipes/misc/ride_button_atlas.py
"""

import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from _atlas import bars, filmstrip, hazard, new_atlas, panels, speckle   # noqa: E402

SIZE = 128
FRAMES = 2
OUT = os.path.join(ROOT, 'build', 'ride_button.png')

GRID = panels(SIZE, 2, 2)
LAMP, LAMP_RIM = GRID[0][0], GRID[0][1]
PLATE, PLATE_RIM = GRID[1][0], GRID[1][1]

# The housing is the same in both frames — a scuffed steel plate with a hazard-striped edge, which is
# what a floor fixture riders are meant to aim at looks like. Only the lamp carries the state.
STEEL = (108, 112, 118)
STEEL_LIGHT = (136, 141, 148)
STEEL_DARK = (74, 78, 84)
GRIME = (58, 60, 64)
HAZARD_YELLOW = (198, 162, 44)
HAZARD_DARK = (46, 44, 40)

# Both lamp states at the same value, so a crossing reads as a COLOUR change rather than a brightness
# one — the frames have to be legible apart at a glance and from a distance.
LAMP_STATES = {
    'rest': {'glass': (58, 176, 96), 'hot': (128, 222, 150), 'shade': (32, 118, 62)},
    'pulse': {'glass': (206, 62, 54), 'hot': (240, 132, 116), 'shade': (140, 32, 30)},
}


def paint_lamp(draw, rnd, state):
    """The hero face. Painted as concentric bands on purpose: a cap panel is mapped RADIALLY
    (`_lib.radial_uv`), so rings in texture space land as rings on the disc — the one case where the
    usual warning about concentric art inverts, because a button IS concentric."""
    x0, y0, x1, y1 = LAMP
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    outer = (x1 - x0) / 2
    for k, (radius, fill) in enumerate((
        (outer * 0.98, state['shade']),
        (outer * 0.86, state['glass']),
        (outer * 0.52, state['hot']),
    )):
        draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=fill)
        if k == 0:
            # a thin dark seat under the glass, so the lamp reads as set INTO the plate
            draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), outline=HAZARD_DARK)
    speckle(draw, rnd, LAMP, 26, (state['shade'], state['hot']), size=(1, 1))


def paint_lamp_rim(draw, rnd, state):
    """The lamp's short side wall — the lit colour at its shaded value, so the edge does not read as a
    separate object when the lamp changes state."""
    draw.rectangle(LAMP_RIM, fill=state['shade'])
    bars(draw, LAMP_RIM, HAZARD_DARK, 4, 2, horizontal=False)
    speckle(draw, rnd, LAMP_RIM, 18, (state['glass'], HAZARD_DARK))


def paint_plate(draw, rnd):
    """The housing's top: the annulus of steel around the lamp. Radially mapped like the lamp, so the
    tread bands land as rings rather than as a stripe pattern sliding across the disc."""
    x0, y0, x1, y1 = PLATE
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    outer = (x1 - x0) / 2
    for radius, fill in ((outer * 0.98, STEEL_DARK), (outer * 0.90, STEEL),
                         (outer * 0.66, STEEL_LIGHT), (outer * 0.54, STEEL)):
        draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=fill)
    speckle(draw, rnd, PLATE, 90, (GRIME, STEEL_DARK, STEEL_LIGHT))


def paint_plate_rim(draw, rnd):
    """The housing's side wall: hazard stripes, the one thing that says "aim at this" from far enough
    away that neither the lamp colour nor the tread is legible."""
    draw.rectangle(PLATE_RIM, fill=HAZARD_DARK)
    hazard(draw, PLATE_RIM, HAZARD_YELLOW, pitch=14, thickness=6, lean=0.30)
    speckle(draw, rnd, PLATE_RIM, 30, (GRIME, STEEL_DARK))


def paint_frame(state):
    """One square frame of the strip: the whole prop, with the lamp in `state`."""
    img, draw = new_atlas(SIZE, bg=(0, 0, 0, 255))
    # One seed per PAGE, not per frame: the grime, scuffs and stripes must land in exactly the same
    # pixels in every frame, or the housing crawls when the lamp switches.
    rnd = random.Random(20260805)
    paint_lamp(draw, rnd, state)
    paint_lamp_rim(draw, rnd, state)
    paint_plate(draw, rnd)
    paint_plate_rim(draw, rnd)
    return img


def main():
    strip = filmstrip([paint_frame(LAMP_STATES['rest']), paint_frame(LAMP_STATES['pulse'])])
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    strip.save(OUT)
    print(f'wrote {OUT}  {strip.size[0]}x{strip.size[1]}  ({FRAMES} frames)')


if __name__ == '__main__':
    main()
