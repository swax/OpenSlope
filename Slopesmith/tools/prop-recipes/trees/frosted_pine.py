"""
Frosted pine — a snow-laden conifer for the ski-resort library, the mid-size one of the family.

    python Slopesmith/tools/prop-recipes/trees/conifer_atlas.py   # paint the shared atlas
    exec(open(P).read(), {'__file__': P})                         # build (inside Blender)

## Species

`_species.FROSTED_PINE` is the design: height, crown ratio, spread, annual increment, branch angle.
Everything below is which ATLAS CELLS the cards are drawn from and how the tip is capped — no
proportion is decided here. `python trees/_species.py frosted_pine` prints the ladder it generates.

An open-grown pine, so the boughs leave the trunk level, the crown is carried nearly to the ground, and
strong apical dominance keeps the outline a cone. `medium_fir` and `tall_spruce` are the same skeleton
with the branch angle swept up and down instead, and all three share this atlas page.

## Cutout cards, not solid geometry

Foliage is one single-sided sheet per bough with the shape in the alpha channel, which is the only
thing that expresses a conifer at this budget — a cone modelled at 280 triangles reads as a cone. It is
the supported path rather than a workaround: Slopesmith builds every prop material as
`MeshLambertMaterial({ side: DoubleSide, alphaTest: 0.4 })` (`props/textures.ts:288`) and
`props/texture-alpha.ts` classifies cutout straight off the PNG. Pass `finish(alpha=True)` and paint on
a transparent page.

No doubled reversed twin behind each card: lighting is per-vertex from the authored normal and both
sides show identically, so a twin costs triangles and changes nothing.

## Frame

+Z up, base at z=0. About 3.1 m across and 5.6 m tall, 272 tris — mid-range for a tree prop against the
budget table in the README.
"""

import os
import sys

# Derived, not hardcoded, so the folders can move. `exec(open(p).read(), {'__file__': p})` is
# what makes this work — a bare exec() defines no __file__.
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # _lib, _atlas, build/ and props/ live one level up, shared by every prop
for _p in (ROOT, HERE):               # HERE too: `_species` is shared by the trees but by nothing else
    if _p not in sys.path:
        sys.path.insert(0, _p)
import importlib          # noqa: E402
import _lib               # noqa: E402
import _species           # noqa: E402
importlib.reload(_lib)    # Blender stays open between runs and would otherwise hold a stale library
importlib.reload(_species)
from _lib import Build, finish, panels, skirt, tapered_trunk, whorls, wobble   # noqa: E402

BUILD = os.path.join(ROOT, 'build')
PROPS = os.path.join(ROOT, 'props')     # the GLBs are CHECKED IN: rebuilding one needs Blender,
                                        # so build/ stays scratch and this is the deliverable
TEX = os.path.join(BUILD, 'conifer.png')          # shared with bushy_pine and tall_pine
GLB = os.path.join(PROPS, 'FrostedPine.glb')
NAME = 'FrostedPine'

SPECIES = _species.FROSTED_PINE
SEED = 90210                            # which individual pine you get; changing it is free

GRID = panels(2, 4)
# The atlas splits by column and the LEFT one is the pines'. A pine holds its needles only 2-4 years
# against a fir's 5-10, so the inner two-thirds of an established bough has already shed and the
# foliage sits as a tuft out at the end of a bare stick. See `conifer_atlas.STYLE`.
BOUGH_PANELS = [GRID[0][0], GRID[1][0], GRID[2][0]]
P_BARK, P_CLUMP = GRID[3][0], GRID[3][1]

b = Build()

with b.part('trunk'):
    tapered_trunk(b, SPECIES.trunk_sides, SPECIES.trunk_rings, 0.0, SPECIES.trunk_top,
                  SPECIES.r0, SPECIES.r1, P_BARK)

with b.part('boughs'):
    whorls(b, SPECIES.body(), BOUGH_PANELS, attach=SPECIES.attach,
           height_ratio=SPECIES.height_ratio, jitter=SPECIES.jitter, seed=SEED)

with b.part('crown'):
    # The terminal tuft: one segment, a taller card for its length, and no jitter — shaking three short
    # cards under a cap reads as broken rather than natural. Two rings rather than one, because a
    # single ring leaves bare trunk showing under what then looks like a floating white dart.
    whorls(b, SPECIES.tips(), [BOUGH_PANELS[2]], ring0=len(SPECIES.body()),
           attach=SPECIES.attach, height_ratio=0.72, segments=1)
    skirt(b, 6, SPECIES.height, SPECIES.trunk_top, 0.02, 0.13, P_CLUMP, wobble(6, 808, 0.14))

finish(b, NAME, TEX, GLB, closed=False, alpha=True)
