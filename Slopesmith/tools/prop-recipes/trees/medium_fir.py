"""
Medium fir — a broad, full, upswept conifer, the middleweight of the family.

    python Slopesmith/tools/prop-recipes/trees/conifer_atlas.py   # paint the shared atlas
    exec(open(P).read(), {'__file__': P})                         # build (inside Blender)

## Species

`_species.MEDIUM_FIR`. A fir, so its boughs sweep UP (`rise` +8 to +13) where `tall_spruce` declines
and `frosted_pine` runs level. Those three signs of one number are most of what separates the conifers
at a glance — far more than height is — and all three share a single atlas page.

Broad with it: `spread_ratio` 0.63 against the spruce's 0.30, so 3.2 m across on 5.8 m tall where the
spruce is 2.4 on 9.0. This is the tree that fills a gap in a treeline; the spruce punctuates one.

## Frame

+Z up, base at z=0. About 3.2 m across and 5.8 m tall, 294 tris. `python trees/_species.py medium_fir`
prints the ladder; nothing below decides a proportion.
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
GLB = os.path.join(PROPS, 'MediumFir.glb')
NAME = 'MediumFir'

SPECIES = _species.MEDIUM_FIR
SEED = 8675309                          # which individual fir you get; changing it is free

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
    # The tip stays unjittered: shaking three short cards under a cap reads as broken, not natural.
    whorls(b, SPECIES.tips(), [P_TIP], ring0=len(SPECIES.body()),
           attach=SPECIES.attach, height_ratio=0.72, segments=1)
    skirt(b, 6, SPECIES.height, SPECIES.trunk_top, 0.02, 0.13, P_CLUMP, wobble(6, 2029, 0.15))

finish(b, NAME, TEX, GLB, closed=False, alpha=True)
