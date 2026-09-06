"""
Bushy pine — a short, wide, snow-loaded treeline conifer, the squat one of the family.

    python Slopesmith/tools/prop-recipes/trees/conifer_atlas.py   # paint the shared atlas
    exec(open(P).read(), {'__file__': P})                         # build (inside Blender)

## Species

`_species.BUSHY_PINE`. Not a scaled-down `frosted_pine` — a different form, and three parameters say
so:

- **`spread_ratio=1.21`**, so it is WIDER than it is tall. A conifer taller than it is wide reads as a
  young tree at any size; one wider than tall reads as a wind-flagged shrub-pine, which is what belongs
  at the treeline beside a piste.
- **`crown_ratio=0.97`**. Nothing has ever shaded it, so it has shed nothing and is foliated to the
  snow. That is above the open-grown range on purpose: krummholz is not a forest form.
- **`increment=0.185`**. Growth at the treeline is measured in centimetres a year, and whorl spacing IS
  the annual increment — a decade of it stacks the rings close enough that the tree reads as dense
  rather than sparse, on the same branch count as anything else here.

Boughs also lie flatter (`tilt` up to 50 deg against the mid-size pine's 42): a low snow-loaded bough
sits closer to horizontal, and the flatter card catches the key light on its face instead of edge-on.

## Frame

+Z up, base at z=0. About 3.3 m across and 2.9 m tall, 286 tris — near the bottom of the range for a
tree prop, which is right for the smallest in the family.
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
TEX = os.path.join(BUILD, 'conifer.png')          # shared with frosted_pine and tall_pine
GLB = os.path.join(PROPS, 'BushyPine.glb')
NAME = 'BushyPine'

SPECIES = _species.BUSHY_PINE
SEED = 33124                            # which individual pine you get; changing it is free

GRID = panels(2, 4)
# The atlas runs long sprigs to short ones; drawing the long cells low and the short cells high puts
# the painted frond length in step with the card length instead of cycling at random against it.
#
# The RIGHT column — the needled-to-the-trunk one — even though this is a pine. The bare inner branch
# on the pine cells is a consequence of branch AGE: needles are held 2-4 years, so the inner two-thirds
# of a long-established bough has already shed. This tree is short, open-grown and slow, and every
# branch on it is within that window. Using the pine column here just makes a scraggly small tree.
LONG_PANELS = [GRID[0][1], GRID[1][1]]
SHORT_PANELS = [GRID[1][1], GRID[2][1]]
P_TIP = GRID[2][1]
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
    skirt(b, 6, SPECIES.height, SPECIES.trunk_top, 0.02, 0.14, P_CLUMP, wobble(6, 511, 0.15))

finish(b, NAME, TEX, GLB, closed=False, alpha=True)
