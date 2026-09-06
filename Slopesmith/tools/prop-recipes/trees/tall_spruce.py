"""
Tall spruce — a narrow drooping spire, the largest tree in the family.

    python Slopesmith/tools/prop-recipes/trees/conifer_atlas.py   # paint the shared atlas
    exec(open(P).read(), {'__file__': P})                         # build (inside Blender)

## Species

`_species.TALL_SPRUCE`. A spruce, not a pine, and the difference is the sign of `rise`: its boughs
leave the trunk angled DOWN (-10 to -4) and the tips sweep back up, which is what makes a spire rather
than a bottlebrush. Narrow with it — `spread_ratio` 0.30, so 2.4 m across on 9.0 m tall against the
fir's 3.2 on 5.8 — and foliated to within a metre of the ground at `crown_ratio` 0.90.

`tall_pine` is the other reading of "tall": a forest-grown stem that has lost its lower crown to shade
and carries what is left up top. This one grew in the open.

## Jitter

`SPECIES.jitter` is 0.85 here, the highest of the foliated conifers. A table alone gives every sprig in
a ring one height, one length, one tilt and an exact 1/n of a turn, and the eye reads that regularity
before it reads the needles. Past about 0.9 the rings stop reading as rings at all and the tree turns
into a bush — the whorl structure is what says conifer, and jitter is meant to rough it up, not
dissolve it. `SEED` picks a different individual of the same species: change it, rebuild, keep the one
you like.

## Frame

+Z up, base at z=0. About 2.4 m across and 9.0 m tall, 338 tris — the top of the range for a tree prop,
which is where the biggest one in a family belongs.
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
TEX = os.path.join(BUILD, 'conifer.png')          # shared with the rest of the conifers
GLB = os.path.join(PROPS, 'TallSpruce.glb')
NAME = 'TallSpruce'

SPECIES = _species.TALL_SPRUCE
SEED = 20260726                         # which individual spruce you get; changing it is free

GRID = panels(2, 4)
# The atlas's RIGHT column is the fir/spruce one — needles held 5-10 years, so green nearly to the
# trunk, against the pines' bare inner branch. See `conifer_atlas.STYLE`.
BOUGHS = [GRID[0][1], GRID[1][1], GRID[2][1]]
P_TIP = GRID[2][1]
P_BARK, P_CLUMP = GRID[3][0], GRID[3][1]

b = Build()

with b.part('trunk'):
    tapered_trunk(b, SPECIES.trunk_sides, SPECIES.trunk_rings, 0.0, SPECIES.trunk_top,
                  SPECIES.r0, SPECIES.r1, P_BARK)

with b.part('boughs'):
    whorls(b, SPECIES.body(), BOUGHS, attach=SPECIES.attach,
           height_ratio=SPECIES.height_ratio, jitter=SPECIES.jitter, seed=SEED)

with b.part('crown'):
    # The tip stays unjittered: it is three short cards under a cap, and shaking those only makes the
    # spire look broken rather than natural.
    whorls(b, SPECIES.tips(), [P_TIP], ring0=len(SPECIES.body()),
           attach=SPECIES.attach, height_ratio=0.72, segments=1)
    skirt(b, 6, SPECIES.height, SPECIES.trunk_top, 0.02, 0.10, P_CLUMP, wobble(6, 3407, 0.16))

finish(b, NAME, TEX, GLB, closed=False, alpha=True)
