"""
Birch — a slender white-barked broadleaf, the odd one out in a family of conifers.

    python Slopesmith/tools/prop-recipes/trees/birch_atlas.py   # paint the atlas (system Python)
    exec(open(P).read(), {'__file__': P})                       # build (inside Blender)

## Species

`_species.BIRCH`, and it is a DECURRENT crown, which is the whole difference from everything else here.
Apical dominance is weak in a broadleaf: the leader loses out partway up, the crown forks and spreads,
and the result is widest in the MIDDLE — `widest_at=0.50` against a conifer's 0.03-0.13. Built at a
conifer's `widest_at` and `rise` this is a pale spruce however carefully its bark is painted.

Three more parameters carry the species:

- **`rise=(22, 52)`.** A birch's limbs sweep steeply UP and steepen further with height. Level boughs
  stacked in rings give a cone; these give a dome.
- **`droop=0.29`** with the cards close to vertical (`tilt` 11-17 against the conifers' 20-45), so the
  twigs weep and the crown reads as a hanging mass rather than as flat horizontal sprays.
- **`slenderness=29`**, the highest in the library after the aspen. A birch is a pole, not a spire: the
  trunk stays slender the whole way up where a conifer's tapers hard.

No snow cap. The conifers finish with a `skirt` cone because they come to a point; a birch has no
conical tip to cap, so the top is three bare upright twig cards.

## Why it cannot share the conifer page

The bark. White banded with dark lenticels, and the one feature recognisable at any distance — so this
prop gets its own atlas rather than hanging cards on the shared conifer page.

## Frame

+Z up, base at z=0. About 2.9 m across and 6.5 m tall, 238 tris.
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
from _lib import Build, finish, panels, tapered_trunk, whorls   # noqa: E402

BUILD = os.path.join(ROOT, 'build')
PROPS = os.path.join(ROOT, 'props')     # the GLBs are CHECKED IN: rebuilding one needs Blender,
                                        # so build/ stays scratch and this is the deliverable
TEX = os.path.join(BUILD, 'birch.png')
GLB = os.path.join(PROPS, 'Birch.glb')
NAME = 'Birch'

SPECIES = _species.BIRCH
SEED = 4471                             # which individual birch you get; changing it is free

GRID = panels(2, 4)
# All six sprays cycle through the body. Unlike a conifer, spray length here is not monotonic with
# height — it swells to the middle of the crown and falls off both ways — so pairing panel length to
# card length has nothing to track.
SPRAYS = [GRID[0][0], GRID[0][1], GRID[1][0], GRID[1][1], GRID[2][0], GRID[2][1]]
P_BARK, P_CROWN = GRID[3][0], GRID[3][1]

b = Build()

with b.part('trunk'):
    tapered_trunk(b, SPECIES.trunk_sides, SPECIES.trunk_rings, 0.0, SPECIES.trunk_top,
                  SPECIES.r0, SPECIES.r1, P_BARK)

with b.part('canopy'):
    whorls(b, SPECIES.body(), SPRAYS, attach=SPECIES.attach,
           height_ratio=SPECIES.height_ratio, jitter=SPECIES.jitter, seed=SEED)

with b.part('crown'):
    # `ring0` continues the golden-angle count, so the first crown ring does not land back on top of
    # the first body ring.
    whorls(b, SPECIES.tips(), [P_CROWN], ring0=len(SPECIES.body()), attach=SPECIES.attach,
           height_ratio=SPECIES.height_ratio, jitter=SPECIES.jitter, seed=SEED + 1)

finish(b, NAME, TEX, GLB, closed=False, alpha=True)
