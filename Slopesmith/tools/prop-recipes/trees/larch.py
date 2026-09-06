"""
Larch — the deciduous conifer, bare for the winter. The only see-through tree in the library.

    python Slopesmith/tools/prop-recipes/trees/larch_atlas.py   # paint the atlas (system Python)
    exec(open(P).read(), {'__file__': P})                       # build (inside Blender)

## Why it earns a slot

Every other conifer here is a solid mass of foliage, so they differ only in outline. A larch drops its
needles: the same whorled conical frame, but in winter it is a bare gold-brown lattice you can see the
mountain through. That is a genuinely different read at distance, and it is the tree that dominates
European alpine treelines — the band a ski area sits in.

## Species

`_species.LARCH`. Being deciduous frees it from the constraint the others work under. A foliated
conifer has to carry enough cards to hide its own trunk; this one is *supposed* to show trunk, so
`branches=(4, 3)` runs 3-4 to a ring where the fir runs 5-6, and it reads better for it.

Branches are level to slightly declining (`rise` -4 to -1) rather than swept either way, and the
branchlets hang off them almost vertically — which is why `tilt` stays low, 14-26 deg against the fir's
20-42. A rolled card would swing those pendulous strokes sideways and lose the one thing the art does.

`jitter` is 0.90, above the 0.85 the foliated conifers stop at. The usual limit exists because heavy
jitter dissolves the ring structure into a bush, but that failure needs a dense canopy to hide in. On a
sparse tree the rings stay legible as rings, and a larch is a gnarly, irregular thing anyway.

## Frame

+Z up, base at z=0. About 2.4 m across and 7.3 m tall, 280 tris — mid-range for a tree prop.
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
TEX = os.path.join(BUILD, 'larch.png')
GLB = os.path.join(PROPS, 'Larch.glb')
NAME = 'Larch'

SPECIES = _species.LARCH
SEED = 1852                             # which individual larch you get; changing it is free

GRID = panels(2, 4)
SPRAYS = [GRID[0][0], GRID[0][1], GRID[1][0], GRID[1][1], GRID[2][0], GRID[2][1]]
P_TIP = GRID[2][1]
P_BARK, P_CLUMP = GRID[3][0], GRID[3][1]

b = Build()

with b.part('trunk'):
    tapered_trunk(b, SPECIES.trunk_sides, SPECIES.trunk_rings, 0.0, SPECIES.trunk_top,
                  SPECIES.r0, SPECIES.r1, P_BARK)

with b.part('boughs'):
    whorls(b, SPECIES.body(), SPRAYS, attach=SPECIES.attach,
           height_ratio=SPECIES.height_ratio, jitter=SPECIES.jitter, seed=SEED)

with b.part('crown'):
    # The tip stays unjittered: shaking three short cards under a cap reads as broken, not natural.
    whorls(b, SPECIES.tips(), [P_TIP], ring0=len(SPECIES.body()),
           attach=SPECIES.attach, height_ratio=0.72, segments=1)
    skirt(b, 6, SPECIES.height, SPECIES.trunk_top, 0.02, 0.09, P_CLUMP, wobble(6, 5077, 0.17))

finish(b, NAME, TEX, GLB, closed=False, alpha=True)
