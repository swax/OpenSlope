"""
Aspen — a chalk-white column with a narrow crown right at the top. Bare for the winter.

    python Slopesmith/tools/prop-recipes/trees/aspen_atlas.py   # paint the atlas (system Python)
    exec(open(P).read(), {'__file__': P})                       # build (inside Blender)

## Species

`_species.ASPEN`, and `crown_ratio=0.41` is the whole design. Live crown over height runs 0.70-0.90 on
an open-grown tree and 0.30-0.40 on a forest-grown one, because side shading kills the lower branches.
Aspen grows in dense clonal groves — every stem shading every other — so it sits at the bottom of that
range, and the result is the most extreme proportion in the library: a 1:5 column where `medium_fir` is
1:1.6, mostly trunk, with the crown only at the top.

That also makes it cheap. There is barely any crown to build, so 228 triangles buys a tree nearly three
times the height of the 286-triangle `bushy_pine`.

Being a clonal grove tree, it wants PLACING in stands of five or ten rather than singly — a lone aspen
looks like a mistake in a way a lone spruce does not.

## Against the birch

The other white-trunked tree here, and they have to be told apart at distance. Both are decurrent, so
both sweep upward; the separation is where the crown sits and how wide it gets.

    birch    spread 0.45, widest halfway up a crown that is 62% of the tree, weeping twigs,
             warm white with fine lenticels
    aspen    spread 0.19, widest a third up a crown that is 41% of it, ASCENDING twigs,
             cool green-white with black eye scars

`rise=(42, 62)` is the steepest in the library and climbs with height, which is what keeps the crown a
narrow oval instead of letting it spread into the birch's dome.

## Frame

+Z up, base at z=0. About 1.3 m across and 7.9 m tall, 228 tris — below the usual range for a tree
prop, which is right for one that is mostly trunk.
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
from _lib import Build, cylinder, finish, panels, tapered_trunk, whorls   # noqa: E402

BUILD = os.path.join(ROOT, 'build')
PROPS = os.path.join(ROOT, 'props')     # the GLBs are CHECKED IN: rebuilding one needs Blender,
                                        # so build/ stays scratch and this is the deliverable
TEX = os.path.join(BUILD, 'aspen.png')
GLB = os.path.join(PROPS, 'Aspen.glb')
NAME = 'Aspen'

SPECIES = _species.ASPEN
SEED = 41776                            # which individual aspen you get; changing it is free

GRID = panels(2, 4)
SPRAYS = [GRID[0][0], GRID[0][1], GRID[1][0], GRID[1][1], GRID[2][0], GRID[2][1]]
P_TIP = GRID[2][1]
P_BARK, P_BASE = GRID[3][0], GRID[3][1]

TRUNK_BASE_TOP = 1.30                   # the dark furrowed skirt an old aspen grows at its foot

b = Build()

with b.part('trunk'):
    # Two panels up the height: the dark furrowed base an old aspen grows, then the pale scarred column
    # above it. Splitting the trunk is what lets one atlas carry both without a gradient.
    cylinder(b, SPECIES.trunk_sides, 0.0, TRUNK_BASE_TOP,
             SPECIES.r0, SPECIES.radius(TRUNK_BASE_TOP), P_BASE)
    tapered_trunk(b, SPECIES.trunk_sides, SPECIES.trunk_rings - 1, TRUNK_BASE_TOP, SPECIES.trunk_top,
                  SPECIES.radius(TRUNK_BASE_TOP), SPECIES.r1, P_BARK)

with b.part('canopy'):
    whorls(b, SPECIES.body(), SPRAYS, attach=SPECIES.attach,
           height_ratio=SPECIES.height_ratio, jitter=SPECIES.jitter, seed=SEED)

with b.part('crown'):
    # No snow cap: a broadleaf has no conical tip to cap, so the top is bare upright twig cards.
    whorls(b, SPECIES.tips(), [P_TIP], ring0=len(SPECIES.body()), attach=SPECIES.attach,
           height_ratio=SPECIES.height_ratio, jitter=SPECIES.jitter, seed=SEED + 1)

finish(b, NAME, TEX, GLB, closed=False, alpha=True)
