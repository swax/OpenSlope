"""
Species parameters in, ladder of whorls out. A tree recipe declares what KIND of tree it is.

    python Slopesmith/tools/prop-recipes/trees/_species.py             # every species, side by side
    python Slopesmith/tools/prop-recipes/trees/_species.py medium_fir  # one, ring by ring

## Why a model rather than a table

A hand-authored ladder is a column of magic numbers, and nothing in it says which of them carry the
species and which are arbitrary. Change the height and every row has to be re-tuned by eye; change the
budget and it has to be re-tuned again. Here a recipe states the dozen quantities a forester would use
to describe a tree and the rings fall out of them, so `height=7.4` is a one-line edit and the crown,
the spacing, the branch lengths, the bough angles and the trunk all move together.

It also makes the shape ARGUABLE. A row that reads `(2.30, 5, 1.46, 0.32, 40.0, 10.0)` can only be
defended as "it looked right"; `crown_ratio=0.86, rise=(8, 13)` is a claim about a fir that is either
true of firs or not, and `check.py` measures the built mesh back against it.

## The parameters, and the ranges they are chosen from

Every field is a real quantity that forestry or dendrology already measures:

- **`crown_ratio`** — live crown / total height. Runs ~0.70-0.90 on an open-grown tree, higher still
  on a treeline shrub that has never been shaded at all, and ~0.30-0.40 on a forest-grown one: foliage persists only where it pays for itself, so side shading in a dense
  stand kills the lower branches and the crown retreats up the stem. This one ratio does more for
  "which tree is this" than height does. Measured on the FOLIAGE, the way a forester measures it —
  the lowest live needle, not the branch's attachment. A card hangs half its height below the point it
  is pinned to the trunk, so those are half a metre apart on a big bough, and only the first is
  visible. `_ensure()` solves the whorl origins to put the foliage where this asks for it, and
  `check.py` measures the built mesh back against the same definition.
- **`spread_ratio`** — crown diameter / height, measured HORIZONTALLY, the way a forester measures
  crown spread. ~0.25-0.35 for a spire-form spruce, ~0.5-0.7 for a fir or an open-grown pine, over 1.0
  for a wind-flagged treeline shrub-pine, and as little as 0.2 for a stem in a clonal aspen grove.
  Branch LENGTH is then a consequence of this and the insertion angle rather than a parameter of its
  own: a limb ascending at 50 degrees has to be half again as long as a level one to reach the same
  width, which is why the broadleaves carry longer branches on narrower crowns.
- **`widest_at`** — where the crown is widest, as a fraction UP the live crown. This is the excurrent/
  decurrent axis and it is the single most legible thing about a tree. Strong apical dominance keeps
  growth on one leader, the laterals stay subordinate, and the crown is widest at its base and tapers
  all the way up: a cone, `widest_at` near 0. Weak apical dominance lets the leader lose out partway
  up, the crown forks and spreads, and it is widest in the MIDDLE: a dome, `widest_at` near 0.5.
- **`swell` / `taper` / `foot` / `tip`** — the silhouette either side of the widest ring. `foot` and
  `tip` are the branch length at the bottom and top of the crown as a fraction of the longest; `swell`
  and `taper` are the exponents between. A cone is `widest_at=0, foot=1, taper=1`; an ellipsoid is
  `widest_at≈0.5, swell=taper≈0.55`.
- **`increment`** — mean annual height increment, in metres. Conifers put out one true whorl of
  branches per YEAR, so whorl spacing IS the year's growth: evenly spaced rings read as a young tree,
  and `increment_falloff` compresses them toward the top as the leader slows. The number of rings is
  therefore not chosen — it is the age of the live crown, and it falls out of crown length ÷ increment.
- **`branches`** — branches per whorl at the crown base and at the tip. Real whorls carry 4-7; the
  topmost are the youngest and have not put out a full complement. Floored at 3, below which a jittered
  ring leaves bare trunk showing through the canopy.
- **`rise`** — branch insertion angle above horizontal at the crown base and at the tip. Ascending
  (fir, +8 to +15), level (pine, ~0), or declining with the tips sweeping back up (spruce, -5 to -12).
  Broadleaves run far steeper, +35 to +60. Three signs of one number read as three species even when
  they share a texture page.
- **`droop`** — tip sag as a fraction of branch length. Mechanical, not stylistic: a branch is a
  cantilever and a snow-loaded one sags harder.
- **`slenderness`** — height / basal diameter, the H/D ratio. Real forest conifers run 50-100. The
  props here run 20-30, and that is a RENDERING constraint rather than a botanical one: on a 128px
  page a true-scale trunk is under two pixels wide and disappears, and the trunk is also the surface
  the cards attach into. It is the one parameter deliberately off its natural range.
- **`tilt`** — how far the card is rolled off vertical, at zero length and at full length. Also not
  botany: a sheet is lit from its single authored normal, so a card left edge-on to the key light ships
  flat. Long lower boughs take the most roll because they are the ones seen face-on from below.

`jitter` lives here too, because how ragged a crown is varies by species — a sparse larch can take more
disorder than a dense fir before its rings stop reading as rings. The `SEED` beside it in each recipe
does not: that picks WHICH INDIVIDUAL of the species you get, and changing it is free.

## Ground clearance is solved, not tuned

A card hangs half its height below its origin and then droops, and `whorls(jitter=)` lengthens it up to
22%, deepens the droop 30%, drops its height and flattens its tilt 13 degrees. If the lowest bough dips
under z=0 the importer does not sink it into the snow — it stands the prop on that vertex and lifts the
whole trunk off the terrain, and the tree floats.

That is a question about a DISTRIBUTION, not about a worst case: the five jitter terms are independent
uniforms drawn per card, and all five landing at their adverse extreme together is a draw no seed will
ever produce. Assuming it does costs half a metre of crown. So `clearance()` simulates instead — the
whole bottom whorl, over many seeds — and reports the depth that 90% of seeds stay above. That is the
honest reading of "changing `SEED` is free": the tree has to stand up for nine seeds in ten, not for a
draw that does not exist.

The same number then places the crown. `_ensure()` moves the whorl origins until the simulated foliage
line lands where `crown_ratio` asked for it, or at the ground if that is higher — so a bottom row can
neither float the prop nor quietly ship a crown ratio other than the one it declares.
"""

import math
import random

# What `whorls`/`card` do to a row downstream, mirrored here so the clearance solve models the real
# worst case. Keep in step with `_lib.whorls` if its jitter scales change.
J_HEIGHT, J_LENGTH, J_DROOP, J_TILT, J_RISE = 0.12, 0.22, 0.30, 13.0, 11.0
CARD_TAPER = 0.62          # `_lib.card`'s default: the frond narrows to 62% at its tip
GROUND = 0.02              # keep this much air under the lowest bough
SEEDS, KEEP = 400, 0.90    # how many seeds `clearance()` simulates, and the share that must clear


def _ramp(points, t):
    """Interpolate a 2- or 3-point ramp over `t` in 0..1.

    Two points is a straight run from the crown base to the tip, which is what most of these do. Three
    lets a quantity PEAK in the mid-crown, which `branches` needs: in a forest-grown tree the lowest
    live whorls are already dying back in the shade while the vigorous middle carries a full
    complement, so branch count climbs before it thins.
    """
    n = len(points) - 1
    x = min(max(t, 0.0), 1.0) * n
    i = min(int(x), n - 1)
    return points[i] + (points[i + 1] - points[i]) * (x - i)


class Species:
    """One species' form. Fields are described in the module docstring; only the first eight are
    normally worth thinking about, and the rest have defaults that suit a conifer."""

    def __init__(self, name, height, crown_ratio, spread_ratio, widest_at, increment,
                 branches, rise, droop=0.22, slenderness=25.0, tilt=(20.0, 44.0),
                 foot=1.0, tip=0.10, swell=0.5, taper=1.0, increment_falloff=0.45,
                 cap=0.0, bury=0.70, trunk_taper=0.30, trunk_rings=None, trunk_sides=5,
                 height_ratio=0.60, jitter=0.80, tip_rings=2):
        self.name = name
        self.height = height
        self.crown_ratio = crown_ratio
        self.spread_ratio = spread_ratio
        self.widest_at = widest_at
        self.increment = increment
        self.branches = branches
        self.rise = rise
        self.droop = droop
        self.slenderness = slenderness
        self.tilt = tilt
        self.foot = foot
        self.tip = tip
        self.swell = swell
        self.taper = taper
        self.increment_falloff = increment_falloff
        self.height_ratio = height_ratio
        self.jitter = jitter
        self.tip_rings = tip_rings

        # The woody stem stops below the drawn height by whatever caps it — a snow cone on a conifer,
        # or just the reach of the terminal tuft on a bare broadleaf.
        self.trunk_top = height - cap
        self.r0 = height / slenderness / 2.0
        self.r1 = self.r0 * trunk_taper
        # About one ring per 1.25 m of stem. The segments are not there for roundness — five sides
        # already reads as round at this size — they are what makes the taper show in silhouette and
        # what gives per-vertex lighting something to vary over up the height.
        self.trunk_rings = trunk_rings or max(3, round(height / 1.25))
        self.trunk_sides = trunk_sides
        self.bury = bury * self.r0

        # Where the lowest foliage should reach, never below the ground: the importer stands a prop on
        # its lowest vertex, so a bough under z=0 does not sink into the snow, it lifts the whole
        # trunk off the terrain.
        self.floor = max(GROUND, height * (1.0 - crown_ratio))
        # How far above that line the first whorl's ORIGIN has to sit. Solved on first use rather than
        # here: `LIBRARY` builds all eight of these at import and only one is ever asked for.
        self.hang, self._solved = 0.0, False
        self.scale = 1.0                     # correction on `reach`, likewise solved on first use

    # ------------------------------------------------------------------ form

    @property
    def reach(self):
        """Horizontal radius of the widest whorl, solved so the BUILT crown spread matches
        `spread_ratio` — jitter lengthens individual branches, and a bounding box takes the largest
        draw anywhere in the crown, so the tabled radius has to sit under the target for the built one
        to land on it."""
        return self.spread_ratio * self.height / 2.0 * self.scale

    def radius(self, z):
        """Trunk radius at height z. Linear, which is what `tapered_trunk` builds."""
        return self.r0 + (self.r1 - self.r0) * (z / self.trunk_top)

    def attach(self, z):
        """Where a card's inner edge starts: inside the bark, so it is buried rather than floating."""
        return self.radius(z) - self.bury

    def profile(self, t):
        """Branch length at height fraction `t` up the live crown, as a fraction of the longest.

        Two power curves meeting at `widest_at`. Everything about a crown's outline that is not its
        size lives in these four numbers.
        """
        w = self.widest_at
        if t <= w:
            u = 1.0 if w <= 1e-9 else t / w
            return self.foot + (1.0 - self.foot) * u ** self.swell
        u = (1.0 - t) / (1.0 - w)
        return self.tip + (1.0 - self.tip) * u ** self.taper

    @property
    def crown_base(self):
        """Height of the lowest whorl's ORIGIN. The foliage it carries reaches `hang` metres lower."""
        return self.floor + self.hang

    def heights(self):
        """The whorl heights: one per year of live crown, each gap the leader's growth that year."""
        base, top = self.crown_base, self.trunk_top
        span = top - base
        zs, z = [], base
        while z <= top + 1e-9:
            zs.append(z)
            z += self.increment * (1.0 - self.increment_falloff * (z - base) / span)
        return zs

    def _rows(self):
        """The ladder at the current `hang` and `scale`. `rows()` is this after `_ensure()` has
        settled both, and is what a recipe should call."""
        base, span = self.crown_base, self.trunk_top - self.crown_base
        zs = self.heights()
        lengths = [(self.reach * self.profile((z - base) / span) - self.attach(z))
                   / math.cos(math.radians(_ramp(self.rise, (z - base) / span))) for z in zs]
        longest = max(lengths) or 1.0
        out = []
        for z, length in zip(zs, lengths):
            t = (z - base) / span
            out.append((round(z, 2),
                        max(3, round(_ramp(self.branches, t))),
                        round(length, 2),
                        round(self.droop * length, 2),
                        round(_ramp(self.tilt, length / longest), 1),
                        round(_ramp(self.rise, t), 1)))
        return out

    def rows(self):
        """`(z, count, length, droop, tilt_deg, rise_deg)` per whorl — what `whorls()` consumes.

        Split with `body()`/`tips()`: the last few rings are the terminal tuft, and a recipe builds
        those flatter and cheaper under the snow cap.
        """
        self._ensure()
        return self._rows()

    def body(self):
        return tuple(self.rows()[:-self.tip_rings] if self.tip_rings else self.rows())

    def tips(self):
        return tuple(self.rows()[-self.tip_rings:]) if self.tip_rings else ()

    # ------------------------------------------------------- clearance and cost

    def _card_low(self, z, length, droop, tilt, rise):
        """The lowest vertex of one card, sampled along the strip.

        A rising bough bottoms out at its root and a declining one at its tip, so neither end alone
        answers it. Mirrors `_lib.card`: the strip hangs half its (tapering) height either side of an
        axis that climbs by `rise` and sags by `droop * t**1.6`.
        """
        upz = math.cos(tilt) * math.cos(rise)
        return min(z + math.sin(rise) * length * (k / 8.0)
                   - droop * (k / 8.0) ** 1.6
                   - length * self.height_ratio * 0.5
                   * (1.0 - (1.0 - CARD_TAPER) * (k / 8.0)) * upz
                   for k in range(9))

    def clearance(self, row):
        """How low the whole whorl reaches, at the seed 90% of seeds do better than.

        `whorls` draws five independent uniforms per card. Taking all five adverse at once is a worst
        case no seed produces and it costs half a metre of crown, so this simulates the ring instead:
        `SEEDS` alternative trees, the lowest vertex anywhere in the whorl recorded for each, and the
        10th-percentile answer returned. Its own RNG, seeded fixed, so a spec is deterministic.
        """
        z, count, length, droop, tilt, rise = row
        j = self.jitter
        rnd = random.Random(20260804)
        worst = []
        for _ in range(SEEDS):
            worst.append(min(
                self._card_low(z + rnd.uniform(-j, j) * J_HEIGHT * length,
                               length * (1.0 + rnd.uniform(-j, j) * J_LENGTH),
                               droop * (1.0 + rnd.uniform(-j, j) * J_DROOP),
                               math.radians(max(5.0, tilt + rnd.uniform(-j, j) * J_TILT)),
                               math.radians(rise + rnd.uniform(-j, j) * J_RISE))
                for _ in range(count)))
        worst.sort()
        return worst[int((1.0 - KEEP) * len(worst))]

    def foliage_base(self):
        """Where the lowest live foliage actually reaches — the forester's crown base."""
        return min(self.clearance(r) for r in self._rows()[:2])

    def crown_radius(self):
        """How wide the crown actually gets, at the seed 90% of seeds stay within.

        The counterpart to `clearance()`, and simulated for the same reason: what shows is the largest
        draw anywhere in the crown, not the tabled radius, and over fifty-odd cards that is a long way
        out into the tail.

        This is crown DIAMETER through the stem, which is what a forester measures and roughly 10%
        more than the axis-aligned bounding box `check.py` prints. The two differ because a crown has a
        finite number of branches: the widest one has to have a partner pointing the opposite way for
        the box to catch it, and with four to six cards in a ring it usually does not.
        """
        rnd = random.Random(20260805)
        j = self.jitter
        widest = []
        for _ in range(SEEDS // 2):
            far = 0.0
            for z, count, length, droop, tilt, rise in self._rows():
                for _ in range(count):
                    ln = length * (1.0 + rnd.uniform(-j, j) * J_LENGTH)
                    rs = math.radians(rise + rnd.uniform(-j, j) * J_RISE)
                    tl = math.radians(max(5.0, tilt + rnd.uniform(-j, j) * J_TILT))
                    half = ln * self.height_ratio * 0.5
                    far = max(far, math.hypot(self.attach(z) + ln * math.cos(rs),
                                              half * math.sin(tl)))
            widest.append(far)
        widest.sort()
        return widest[int(KEEP * (len(widest) - 1))]

    def _ensure(self):
        """Settle the two solved quantities, once, on first use.

        Both exist because a spec declares what the tree should MEASURE and the ladder only controls
        what it is built from, and the two are a card's width apart:

        - **`hang`** places the whorl origins so the foliage lands where `crown_ratio` asked. A card is
          pinned to the trunk at its centre-line and hangs half its height below that, then droops, so
          the boughs reach well under the ring they belong to.
        - **`scale`** trims the tabled crown radius so the BUILT spread lands on `spread_ratio`. Jitter
          only ever lengthens the branch that happens to be the longest, so the crown finishes wider
          than any row says.

        Neither is derived in closed form because they interact — moving the origins shortens the
        bottom rows, since the profile is anchored to the live crown rather than to the stem, and
        scaling the branches changes how far those rows hang. Alternating converges in three or four
        passes.
        """
        if self._solved:
            return
        self._solved = True
        target = self.spread_ratio * self.height / 2.0
        for _ in range(40):
            if not self._rows():
                return
            error = self.floor - self.foliage_base()
            self.hang += error
            got = self.crown_radius()
            self.scale *= target / got
            # The two interact: moving the origins changes branch length, and scaling the branches
            # changes how far the bottom row hangs. Alternating converges in three or four passes.
            if abs(error) <= 5e-3 and abs(got / target - 1.0) <= 0.01:
                return

    def tris(self, skirt_sides=6):
        """The triangle bill, so a spec can be costed before Blender is opened."""
        body = sum(r[1] for r in self.body()) * 4      # segments=2 -> two quads
        tips = sum(r[1] for r in self.tips()) * 2      # segments=1 -> one quad
        trunk = self.trunk_sides * self.trunk_rings * 2
        return trunk + body + tips + (skirt_sides * 2 if skirt_sides else 0)

    # ------------------------------------------------------------------ report

    def report(self):
        rows = self.rows()
        base, span = self.crown_base, self.trunk_top - self.crown_base
        widest = max(rows, key=lambda r: r[2])
        built = 2.0 * self.crown_radius() / self.height
        low = self.foliage_base()
        grounded = ' (ground-limited)' if self.floor <= GROUND + 1e-9 else ''
        return (
            f'{self.name}  {self.height:.2f} m, {self.tris()} tris\n'
            f'    crown    {len(rows)} whorls, ratio {(self.height - low) / self.height:.0%} '
            f'(asked {self.crown_ratio:.0%}){grounded}, spread {built:.2f} '
            f'(asked {self.spread_ratio:.2f})\n'
            f'    widest   z={widest[0]:.2f}, {max(0.0, (widest[0] - base) / span):.0%} up the crown, '
            f'branch {widest[2]:.2f} m\n'
            f'    trunk    r {self.r0:.3f} -> {self.r1:.3f} m over {self.trunk_rings} rings, '
            f'H/D {self.slenderness:.0f}\n'
            f'    foliage  reaches z={low:+.2f} at the {1 - KEEP:.0%} seed, '
            f'{self.hang:.2f} m under the lowest whorl at z={base:.2f}')


def table(rows):
    """A `rows()` list as the literal a recipe would otherwise have held — for eyeballing a spec."""
    return '\n'.join(f'    ({z:.2f}, {n}, {ln:.2f}, {dr:.2f}, {tl:.1f}, {rs:.1f}),'
                     for z, n, ln, dr, tl, rs in rows)


# Every tree in the library, so one run shows the whole family against each other. A recipe imports
# its own entry by name; nothing here is used at build time except the one it asks for.
LIBRARY = {}


def _register(sp):
    LIBRARY[sp.name] = sp
    return sp


# --- conifers -------------------------------------------------------------------------------------
#
# Pines hold their needles 2-4 years against spruce and fir's 5-10, which is why the pine cells on the
# shared atlas are a tuft on a bare stick and the fir cells are green nearly to the trunk. It does not
# change the geometry, only which column of the page the cards are drawn from.

FROSTED_PINE = _register(Species(
    'frosted_pine', height=5.62, crown_ratio=0.92, spread_ratio=0.61, widest_at=0.03,
    increment=0.40, increment_falloff=0.42, branches=(6, 3), rise=(1.0, -1.0), droop=0.26,
    slenderness=27.0, tilt=(16.0, 42.0), foot=0.98, tip=0.16, taper=0.95,
    cap=0.26, bury=0.85, trunk_taper=0.33, trunk_rings=4, jitter=0.80))

BUSHY_PINE = _register(Species(
    # Treeline shrub-pine: wider than it is tall, foliated nearly to the snow. Open-grown, so the crown
    # ratio sits at the top of the range and the boughs lie flat under their own snow load. The
    # increment is the other half of the story — growth at the treeline is measured in centimetres a
    # year, and a decade of it stacks the whorls close enough that the tree reads as dense, not sparse.
    'bushy_pine', height=2.90, crown_ratio=0.97, spread_ratio=1.21, widest_at=0.09,
    increment=0.185, increment_falloff=0.40, branches=(7, 3), rise=(0.0, -2.0), droop=0.17,
    slenderness=25.0, tilt=(20.0, 50.0), foot=0.92, tip=0.14, taper=0.90,
    cap=0.26, bury=0.75, trunk_taper=0.39, trunk_rings=3, jitter=0.80))

TALL_PINE = _register(Species(
    # A mature stand pine: forest-grown, so the crown has retreated up a bare stem and the mass it has
    # left is carried high. Slender with it — a wide crown on a stem this tall would be an open-grown
    # tree, and this is not one.
    # Branch count peaks in the mid-crown rather than at its base: the lowest live whorls on a stand
    # tree are the ones already dying back in the shade, and the vigour is in the middle.
    'tall_pine', height=8.12, crown_ratio=0.62, spread_ratio=0.34, widest_at=0.18,
    increment=0.32, increment_falloff=0.40, branches=(4, 6, 3), rise=(2.0, 0.0), droop=0.26,
    slenderness=25.0, tilt=(18.0, 45.0), foot=0.80, tip=0.18, swell=0.55, taper=0.95,
    cap=0.26, bury=0.55, trunk_taper=0.26, trunk_rings=6, jitter=0.80))

MEDIUM_FIR = _register(Species(
    # Ascending boughs and a broad, dense crown held nearly to the ground: the gap-filler of a treeline.
    'medium_fir', height=5.78, crown_ratio=0.92, spread_ratio=0.63, widest_at=0.08,
    increment=0.41, increment_falloff=0.45, branches=(6, 3), rise=(8.0, 13.0), droop=0.21,
    slenderness=23.0, tilt=(20.0, 42.0), foot=0.94, tip=0.16, taper=1.0,
    cap=0.28, bury=0.76, trunk_taper=0.30, trunk_rings=5, jitter=0.80))

TALL_SPRUCE = _register(Species(
    # The spire form: declining boughs whose tips sweep back up, a narrow crown carried almost to the
    # ground. Spread is the whole point — a spruce is the tree that punctuates a treeline.
    'tall_spruce', height=8.98, crown_ratio=0.90, spread_ratio=0.30, widest_at=0.13,
    increment=0.52, increment_falloff=0.40, branches=(5, 3), rise=(-10.0, -4.0), droop=0.28,
    slenderness=28.0, tilt=(18.0, 45.0), foot=0.90, tip=0.13, taper=0.92,
    cap=0.26, bury=0.63, trunk_taper=0.24, trunk_rings=7, jitter=0.85))

LARCH = _register(Species(
    # Deciduous conifer, bare for the winter. Being see-through is the point, so it runs 3-4 branches
    # to a ring where a foliated conifer needs 5-6 to hide its own trunk, and it can take more jitter:
    # heavy disorder dissolves a DENSE crown into a bush, but a sparse one keeps its rings legible.
    'larch', height=7.30, crown_ratio=0.82, spread_ratio=0.38, widest_at=0.07,
    increment=0.40, increment_falloff=0.42, branches=(4, 3), rise=(-4.0, -1.0), droop=0.17,
    slenderness=25.0, tilt=(14.0, 26.0), foot=0.94, tip=0.15, taper=1.0,
    cap=0.28, bury=0.62, trunk_taper=0.24, trunk_rings=6, jitter=0.90))

# --- broadleaves ----------------------------------------------------------------------------------
#
# Weak apical dominance is the whole difference: the leader loses out partway up, so the crown is
# widest in the MIDDLE and the limbs sweep steeply upward. Built at conifer angles these read as pale
# spruces however their bark is painted. Neither takes a snow cap, having no conical tip to cap.

BIRCH = _register(Species(
    # Decurrent and weeping: an ellipsoid crown on a slender pole, with the twigs hanging off it.
    'birch', height=6.62, crown_ratio=0.62, spread_ratio=0.45, widest_at=0.50,
    increment=0.35, increment_falloff=0.30, branches=(4, 5, 3), rise=(22.0, 52.0), droop=0.29,
    slenderness=29.0, tilt=(11.0, 17.0), foot=0.46, tip=0.34, swell=0.55, taper=0.60,
    # A steeply ascending tip card reaches well above the stem it leaves, so the woody trunk stops
    # further below the drawn height here than on a conifer, where the cap is a snow cone on the point.
    cap=0.62, bury=0.48, trunk_taper=0.26, trunk_rings=5, height_ratio=0.66, jitter=0.72))

ASPEN = _register(Species(
    # A stem in a clonal grove — every neighbour shading every other, so the crown ratio sits at the
    # forest-grown bottom of the range and the result is the narrowest thing in the library. Branches
    # ascend steeply and steepen further with height, which keeps the crown an oval instead of letting
    # it spread into the birch's dome.
    'aspen', height=7.90, crown_ratio=0.41, spread_ratio=0.19, widest_at=0.30,
    increment=0.30, increment_falloff=0.35, branches=(4, 3), rise=(42.0, 62.0), droop=0.22,
    slenderness=34.0, tilt=(13.0, 18.0), foot=0.62, tip=0.26, swell=0.55, taper=0.85,
    cap=0.30, bury=0.44, trunk_taper=0.30, trunk_rings=6, jitter=0.85))


def main():
    import sys
    names = sys.argv[1:] or list(LIBRARY)
    unknown = [n for n in names if n not in LIBRARY]
    if unknown:
        raise SystemExit(f'no such species: {", ".join(unknown)}\nknown: {", ".join(LIBRARY)}')
    for name in names:
        sp = LIBRARY[name]
        print(sp.report())
        if len(names) == 1:
            print(f'    body ({len(sp.body())} rings)\n{table(sp.body())}')
            print(f'    tips ({len(sp.tips())} rings)\n{table(sp.tips())}')
        print()


if __name__ == '__main__':
    main()
