"""
Tall pine — a mature stand conifer carrying its foliage high on a bare lower trunk.

    python Slopesmith/tools/prop-recipes/trees/conifer_atlas.py   # paint the shared atlas
    exec(open(P).read(), {'__file__': P})                         # build (inside Blender)

## Species

`_species.TALL_PINE`, and the one parameter that makes this tree is `crown_ratio=0.62`. Foliage
persists only where it pays for itself, so in a closed stand the side-shaded lower branches are shed
and the live crown retreats up the stem. A tree whose foliage starts at the ground reads as a sapling
however tall you make it — the bare lower trunk is what says the tree grew up in company.

Two consequences follow from the same fact and both are in the spec. `branches=(4, 6, 3)` peaks in the
MID-crown rather than at its base — the lowest live whorls are the ones already dying back in the
shade, and the vigour is in the middle — so the mass looks loaded rather than merely present. And
`spread_ratio=0.34` keeps it slender, because a wide crown on a stem this tall would be an open-grown
tree and this is not one.

## Frame

+Z up, base at z=0. About 2.5 m across and 8.1 m tall, 376 tris — the top of the range for a tree prop,
which is the right end for the largest in the family. `python trees/_species.py tall_pine` prints the
ladder; nothing below decides a proportion.
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
TEX = os.path.join(BUILD, 'conifer.png')          # shared with frosted_pine and bushy_pine
GLB = os.path.join(PROPS, 'TallPine.glb')
NAME = 'TallPine'

SPECIES = _species.TALL_PINE
SEED = 60614                            # which individual pine you get; changing it is free

GRID = panels(2, 4)
# The atlas's LEFT column is the pine one — needles held 2-4 years, so a tuft on a bare stick. Long
# cells low and short cells high puts the painted frond length in step with the card length instead of
# cycling at random against it.
LONG_PANELS = [GRID[0][0], GRID[1][0]]
SHORT_PANELS = [GRID[1][0], GRID[2][0]]
P_TIP = GRID[2][0]
P_BARK, P_CLUMP = GRID[3][0], GRID[3][1]

BODY = SPECIES.body()
SPLIT = len(BODY) // 2                  # where the ladder changes to the shorter atlas cells

b = Build()

with b.part('trunk'):
    tapered_trunk(b, SPECIES.trunk_sides, SPECIES.trunk_rings, 0.0, SPECIES.trunk_top,
                  SPECIES.r0, SPECIES.r1, P_BARK)

with b.part('boughs'):
    # One continuous stagger across both bands: `ring0` carries the golden-angle count over, so the
    # first short-celled whorl does not land back on top of the first long-celled one.
    whorls(b, BODY[:SPLIT], LONG_PANELS, attach=SPECIES.attach,
           height_ratio=SPECIES.height_ratio, jitter=SPECIES.jitter, seed=SEED)
    whorls(b, BODY[SPLIT:], SHORT_PANELS, ring0=SPLIT, attach=SPECIES.attach,
           height_ratio=SPECIES.height_ratio, jitter=SPECIES.jitter, seed=SEED + 1)

with b.part('crown'):
    whorls(b, SPECIES.tips(), [P_TIP], ring0=len(BODY),
           attach=SPECIES.attach, height_ratio=0.72, segments=1)
    skirt(b, 6, SPECIES.height, SPECIES.trunk_top, 0.02, 0.11, P_CLUMP, wobble(6, 1301, 0.14))

finish(b, NAME, TEX, GLB, closed=False, alpha=True)
