"""
Open snow — the undisturbed field a mountain is mostly made of.

    python Slopesmith/tools/texture-recipes/surface/powder.py

This answers to `SNOW/0048.png`, which SNOW paints on **657 terrain patches** — 40% of the level, and
more than its next four pages together. ELYSIUM ships the same page as `0052.png`. It is the tile the
mountain is made of and the one every other snow tile is a variation on, so it is the one to build
first, and its job is to be uninteresting: whatever is distinctive about a tile repeats every 20 m
across an entire slope, so on the page that covers the most ground, distinctive is a defect.

Two things make it not merely flat. It is COOL — 224, 234, 236 mean, a blue-white, and the ramp
darkens toward more blue rather than toward grey. And it is FINE — three quarters of its variation
happens below 1.2 m, which at 16 cm/px is under 8 pixels. Nothing here is drawn; there is nothing on
open snow at 20 m across that a person would call a feature.
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
import _texture                                                                  # noqa: E402

NAME = 'powder'
OUT = os.path.join(ROOT, 'build', f'{NAME}.png')
SEED = 20250727

# Feature size in metres, and how much of the tile's variation happens at that size. Read against
# 16 cm/px: the 0.4 m band is a 2-3 pixel grain and carries most of the page, which is exactly what
# SNOW/0048 measures (50% of its energy between 30 and 60 cm). Nothing above 7 m — at 20 m per tile
# a broader feature than that has nowhere to repeat and simply tints one corner.
BANDS = [
    (7.0, 0.02),      # a drift swell, most of a tile wide
    (3.3, 0.03),      # wind-scoured patches
    (1.7, 0.05),      # sastrugi
    (0.85, 0.25),     # ripple
    (0.42, 0.65),     # the surface's own roughness
]

# Both ends measured off SNOW/0048's own palette: it is white at 253 (the 7-bit lattice's ceiling —
# 255 does not exist in a shipped page) and bottoms out around 189, 209, 215. Backing the shade end
# off by two lattice steps lands the grain at retail's 11.6 rather than a shade over it.
LIT = (253, 253, 253)
SHADE = (193, 211, 217)
STEPS = 19            # SNOW/0048 carries exactly 19 colours

# 1.0 — no bend. This is the one shipped snow page whose histogram is symmetric (skew -0.10); the
# mottled and streaked ones all lean hard to the light and want gamma above 1.
GAMMA = 1.0


def build():
    return _texture.paint(_texture.field(SEED, BANDS), _texture.ladder(LIT, SHADE, STEPS), gamma=GAMMA)


def main():
    tile = _texture.finish(build(), NAME, OUT)
    _texture.preview(tile, os.path.join(ROOT, 'build', f'_preview_{NAME}.png'))


if __name__ == '__main__':
    main()
