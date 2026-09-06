"""
Skied-out snow — a piste that has been ridden all morning.

    python Slopesmith/tools/texture-recipes/surface/tracks.py

The counterpart to `powder`, and the family that gives a mountain its direction. SNOW paints
`0045`/`0047` on 291 patches and GARI `0012` on 378, and all three measure the same way: a third or
more of the tile survives being averaged down every column, which means the pattern runs the WHOLE
way down the page rather than being elongated blobs.

**Down the page is down the hill.** Comparing each texture axis against the downhill direction in its
own patch plane, across SNOW's patches, V wins every time — 0.85 on `0045`, 0.99 on `0053`, against
0.52-0.69 for U. Every shipped streaked page is drawn as vertical stripes, so those stripes are the
fall line. Tracks here run down the image for the same reason, and a cell aims them with its D4
orientation (the F overlay is the instrument).

Three things stacked, because the shipped pages only get you two of them:

- **lanes** — the broad skied-out banding, a stretched field. This is what retail actually has, and
  it is very broad: 95% of `SNOW/0045`'s streak profile is 5 m and wider. A lane is where dozens of
  tracks have merged into scoured snow, not a track.
- **cuts** — the tracks themselves, drawn by `grooves`. Retail has nothing like these, and the reason
  is the page scale rather than taste: a ski edge cuts 10-15 cm and a board's trench 20-40 cm, which
  at 16 cm/px is one to three pixels. A mark that thin has no octave to live in, so no band will ever
  produce one — it has to be drawn.
- **grain** — the same open-snow roughness `powder` is made of, which is still most of the tile.

The result is more legible as tracks than any shipped page and still lands inside their envelope on
every measured axis. Where it deliberately parts company is the coarse end: `0045` puts 28% of its
energy into a single 10-20 m band, which on a 20 m tile is one shadow across the whole page. That
reads as weather, not as skiing, so the lanes here top out at 12 m and most of them sit at 3-6 m,
which is roughly where GARI's `0012` puts its own.
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
import _texture                                                                  # noqa: E402

NAME = 'tracks'
OUT = os.path.join(ROOT, 'build', f'{NAME}.png')
SEED = 4180

# The banding, as widths ACROSS the slope. STRETCH makes each one 26x longer than it is wide, so a
# 3 m lane runs 78 m - well past the tile, which is what puts a third of the page into the streak
# column. Stretch is the knob that decides whether a lane runs the whole way down or peters out
# halfway, and only the ones that run the whole way read as skiing.
STRETCH = 26
LANES = [
    (12.0, 0.30),     # the broad scoured band beside the trees
    (6.0, 0.40),      # a lane several riders wide
    (3.0, 0.22),      # one rider's worth of chopped snow
    (1.5, 0.08),
]

# Open snow underneath, unchanged in kind from `powder` but carrying more mid-scale mottle. That
# extra 1.5-6 m content is doing a specific job: it is ISOTROPIC, so it dilutes the direction ratio
# back into the shipped 2.8-4.0 that the lanes and cuts on their own overshoot.
GRAIN = [(6.0, 0.10), (3.0, 0.12), (1.5, 0.14), (0.8, 0.26), (0.4, 0.38)]

# 20 cuts across 20 m is one every metre - a piste that has been ridden hard but is not moguled.
# WIDTH is the trench's half-width in PIXELS: 1.2 px is 19 cm, a board's edge. WANDER is the lateral
# drift over the tile's whole height, also in pixels, and 7 px (1.1 m over 20 m of fall line) is far
# straighter than a real carve. It has to be: a track that swings returns to the same place at the
# tile edge and does it on every cell of the slope, so a big swing paints a braid down the mountain.
# The shipped pages measure 6-9 px of drift, which is the number this answers to.
COUNT, WIDTH, WANDER = 20, 1.2, 7.0

# Shares of the finished tile's variation. Raising CUTS at a fixed COUNT deepens every trench; raising
# COUNT at a fixed share makes each one shallower, because the share belongs to the whole system.
LANE_SHARE, CUT_SHARE = 0.30, 0.18

# `SNOW/0045`'s own palette, ends and count: white at 249 and bottoming out in a real blue at 159,
# across 24 colours. This is a much longer ramp than `powder`'s and it is the whole reason a track
# can be seen at all - a 2-step trench on this ladder is 8 units of shadow.
LIT, SHADE, STEPS = (249, 251, 251), (159, 187, 197), 24

# 2.6 rather than the default 3.5: `0045` uses more of its ramp than a Gaussian clipped at 3.5 sigma
# does, and 2.6 lands the grain at its measured 26. GAMMA 1.6 buys the -0.7 skew it also measures -
# the sun has bleached the flats and the shadow is only in the cuts.
SPREAD, GAMMA = 2.6, 1.6


def build():
    return _texture.paint(
        _texture.mix((_texture.field(SEED, LANES, stretch=STRETCH), LANE_SHARE),
                     (_texture.grooves(SEED + 1, count=COUNT, width=WIDTH, wander=WANDER), CUT_SHARE),
                     (_texture.field(SEED + 2, GRAIN), 1.0 - LANE_SHARE - CUT_SHARE)),
        _texture.ladder(LIT, SHADE, STEPS), spread=SPREAD, gamma=GAMMA)


def main():
    tile = _texture.finish(build(), NAME, OUT)
    _texture.preview(tile, os.path.join(ROOT, 'build', f'_preview_{NAME}.png'))


if __name__ == '__main__':
    main()
