"""
Shared machinery for the snow tiles — what `prop-recipes/_atlas.py` is to a prop page, this is to a
terrain tile.

Everything here came out of `measure.py`, run over the ten snow pages the shipped levels actually
paint their mountains with. Four facts do all the work, and none of them is obvious from looking at
a snow tile:

**A snow tile is a scalar field pushed through ONE colour ramp.** Principal-component analysis of
every shipped page puts **99.6-100% of its colour variance on a single axis**, and that axis is the
same one every time: `(0.742, 0.511, 0.431)`. Snow has no hue variation at all — it has depth of
shadow, and shadow is skylight, so the red channel falls fastest and the blue barely moves. So there
is no "painting" here in the atlas sense. There is a height/shadow field, and a two-colour ramp.

**Its palette is tiny — 19 to 94 colours on a 128x128 page**, and every channel value is ODD. The
extracted pages live on a 7-bit lattice (`0, 1, 3, 5, … 253`); pure white 255 never appears, and
neither does any even value. That is what `seven_bit` and `ladder` reproduce, and it is most of why
a hand-rolled noise texture reads as modern and these read as PS2: a naive generator emits tens of
thousands of colours where retail emits twenty.

**One tile covers 15-30 metres of mountain.** Measured across SNOW's 1103 snow patches, a tile
repeat spans 23 m along `u` and 16 m along `v`; an authored Slopesmith mountain defaults to 30 m
grid spacing. Call it **20 m**, so the page runs about **16 cm/px**. This is the number that decides
what can be drawn: a snowboard's edge cut is 15 cm and lands on ONE pixel, a boot print is
sub-pixel, and the smallest thing that can actually read is a 2-3 m drift. `bands` is therefore
written in metres, not in octaves or pixels.

**The histogram always leans to the light.** Skew along the colour axis runs -0.10 to -1.44 across
every page measured, never positive. Snow is a bright surface with shadow cut into it, not a grey
surface with highlights added — that is the `gamma` knob, and leaving it at 1.0 (as the plain open
field does) is the exception rather than the rule.

**Anything directional runs down the image, because texture V is the fall line.** Measured over
SNOW's patches by comparing each texture axis against the downhill direction in the patch's own
plane, V wins every time — 0.85 on `0045`, 0.86 on `0047`, 0.99 on `0053` against 0.52-0.69 for U.
Every streaked page is drawn as vertical stripes, so those stripes point down the hill. `stretch`
elongates along V for the same reason, and a recipe that wants a mark across the slope draws it
horizontally.

Seamlessness is not a knob. `field` builds its noise in the frequency domain, so it is periodic by
construction and there is no edge to blend, no mirroring, and no offset-and-heal pass. `check.py`
still measures the wrap, because a later step (a gradient, a drawn mark) can break what the noise
guarantees.
"""

import os

import numpy as np
from PIL import Image

TILE = 128
METRES = 20.0                                  # what one tile repeat covers on the mountain
CM_PER_PX = 100.0 * METRES / TILE              # 15.6 cm — the scale every band is judged against

# The single axis every shipped snow page's colour variance lies on. Kept as a unit vector: a colour
# projected onto it reads in ordinary 0-255 units, so `grain` below is directly comparable to a
# channel standard deviation.
AXIS = np.array([0.742, 0.511, 0.431])
AXIS = AXIS / np.linalg.norm(AXIS)

# The retail envelope, measured over SNOW 0045-0048 + 0053, GARI 0012 + 0019, ELYSIUM 0052 + 0059
# and MERQUER 0006 — every page those levels paint more than a handful of terrain patches with.
# `check.py` reports against these and the guards below fail outside them.
RETAIL = {
    'mean R': (211, 229), 'mean G': (219, 234), 'mean B': (225, 236),
    'grain': (11.6, 26.8),          # standard deviation along AXIS
    'skew': (-1.44, -0.10),         # always negative: mostly bright, tail into shadow
    'colours': (19, 94),
    'axis share': (99.55, 100.0),   # % of colour variance on the first principal axis
    'seam': (0.57, 1.25),           # wrap difference / neighbouring-pixel difference
}

# How warm a tile is allowed to be — mean red minus mean blue — and the one measurement that depends
# on WHICH ground a recipe is making rather than on the ten-page snow set. Snow is lit by skylight
# and is never warm: every reference page above measures blue at or above red, and half a lattice
# step of slack is there because MERQUER/0006 is exactly neutral. Bare ground is a different family
# and the shipped levels paint plenty of it: MESA covers 869 of its patches with `0054` (468) and
# `0058` (401), whose means are (175, 122, 87) and (170, 118, 85) — red 87 and 85 units over blue.
# So `rock` is bounded by `0054`, the warmest page retail paints ground with that is still ONE ramp
# (98.50% on its first axis); the two pages that go warmer, SNOW/0092 at +92 and `0094` at +139, are
# multi-hue mud that the axis guard rejects anyway. A recipe declares its family through `finish` and
# the default is `snow`, so an ordinary tile that has quietly drifted warm still fails.
WARMTH = {'snow': 1.0, 'rock': 87.0}


def field(seed, bands, size=TILE, metres=METRES, bandwidth=0.5, stretch=1.0):
    """A seamless scalar field, zero mean and unit standard deviation.

    `bands` is the recipe: `(feature_size_in_metres, share_of_the_tile's_variation)` pairs. Shares are
    normalised, so they read as fractions of the whole — and they are the same numbers `check.py`
    prints back, which is the point. Writing the spectrum in metres rather than in octaves is what
    keeps a recipe arguable: "3% of this tile happens at 7 m" is a claim about snow, where "octave 2
    weight 0.16" is a claim about nothing.

    `stretch` elongates every feature along V — down the fall line — by that factor, which is the
    whole difference between open snow and the skied-out family. At `stretch` above 1 a band's size
    is its width ACROSS the slope and its length along the slope is `stretch` times that. The
    shipped streaked pages measure a direction ratio of 2.8-4.0, which `stretch` around 6-10
    reproduces (the ratio is energy, not extent, and the grain mixed in on top dilutes it further).

    Built by shaping white noise in the frequency domain, which makes it periodic — a tile out of
    here butts against itself on all four edges with no seam to hide. Each band is a log-normal lobe
    about its own frequency; at `bandwidth=0.5` the lobes are wide enough to overlap, so a share
    lands within a few points of what it asks for rather than exactly on it.

    The `/k0` is not a fudge. A shell at radius `k0` has area proportional to `k0` and the lobe's
    width scales with `k0` too, so its energy goes as `(w·k0)²` — dividing by `k0` is what makes
    `share` mean the share of variance instead of a bare filter gain. `stretch` needs no such term:
    it scales every band's lobe by the same factor and the unit-variance normalisation at the end
    divides it straight back out.
    """
    return _shaped(seed, bands, size, metres, bandwidth, stretch)


def _shaped(seed, bands, size=TILE, metres=METRES, bandwidth=0.5, stretch=1.0):
    """`field`'s body, reached directly by the functions that DRAW with a field rather than
    contribute one. `check.py` intercepts `field` to follow a recipe's bands into its asks/measures
    table; a field that only exists inside `crackle` never reaches `mix` and has no share of the
    page to report, so it goes through here and shows up in the drawn shortfall like `grooves` does.
    """
    rng = np.random.default_rng(seed)
    spectrum = np.fft.fft2(rng.standard_normal((size, size)))
    axis = np.fft.fftfreq(size) * size                     # cycles per tile, signed
    ky, kx = np.meshgrid(axis, axis, indexing='ij')
    # ky is the frequency down the image, so weighting it up starves the field of anything that
    # varies quickly in V and what is left runs in long lines down the hill.
    k = np.hypot(kx, ky * stretch)

    total = sum(share for _, share in bands)
    if total <= 0:
        raise RuntimeError('field() needs at least one band with a positive share')
    filt = np.zeros_like(k)
    for size_m, share in bands:
        k0 = metres / size_m
        if k0 > size / 2:
            raise RuntimeError(f'band {size_m} m is {metres / k0 * 100 / CM_PER_PX:.1f} px - finer '
                               f'than the {size}px page can carry (Nyquist is {2 * CM_PER_PX:.0f} cm)')
        filt += ((share / total) ** 0.5 / k0) * np.exp(
            -(np.log(np.maximum(k, 1e-9) / k0) ** 2) / (2 * bandwidth ** 2))
    filt[0, 0] = 0.0                                       # no DC: the ramp's centre sets the mean

    out = np.real(np.fft.ifft2(spectrum * filt))
    return (out - out.mean()) / out.std()


def mix(*parts):
    """Combine independent unit-variance fields by share of the finished tile's variation.

    `mix((streaks, 0.42), (grain, 0.58))` reads as what it does, and reads in the same currency as
    `bands` and as everything `check.py` prints. The weights are square roots because the parts are
    independent, so their VARIANCES add and their amplitudes do not — mixing two fields half and half
    by amplitude gives each of them 50% of the amplitude and 25% of the variance, which is how a
    carefully balanced tile ends up looking like only one of its ingredients.
    """
    total = sum(share for _, share in parts)
    if total <= 0:
        raise RuntimeError('mix() needs at least one part with a positive share')
    out = sum(f * (share / total) ** 0.5 for f, share in parts)
    return (out - out.mean()) / out.std()


def grooves(seed, size=TILE, count=18, width=1.6, wander=6.0, lip=0.5, metres=METRES):
    """Cuts down the fall line: `count` soft trenches, each with the snow it pushed up beside it.

    One of the two things in the library that DRAW rather than filter (`crackle` is the other), and
    the reason it has to is the page scale. A ski edge cuts 10-15 cm and a board's trench 20-40 cm, which at 16 cm/px is one
    to three pixels — a mark that thin has no octave to live in, so no band will ever produce it. The
    shipped streaked pages have nothing like it: 95% of `SNOW/0045`'s streak profile is 5 m and
    wider, and what it calls a track is really a broad scoured band. Both belong on a track tile,
    which is why a recipe `mix`es this with a stretched `field` rather than choosing.

    `wander` is in PIXELS of lateral drift over the tile's whole height, and it is deliberately
    small. A carving turn really does swing several metres across 20 m of fall line, but a track that
    swings returns to the same place at the tile's edge and does it on every cell of the slope, so a
    big swing paints a visible repeating braid down the mountain. The shipped pages measure 6-9 px of
    drift over their full height and that is the number to answer to. It is a sum of whole-number
    sine cycles, so it closes on itself exactly and the tile still wraps.

    Returns a unit-variance field like `field` does, so `count` and the share passed to `mix` are not
    independent: at a fixed share, more cuts means each one is shallower. The share belongs to the
    whole system of cuts, not to one of them.
    """
    rng = np.random.default_rng(seed)
    y = np.arange(size)[:, None]
    x = np.arange(size)[None, :]
    out = np.zeros((size, size))
    for i in range(count):
        # Jittered even spacing rather than uniform-random placement: independent draws clump, and a
        # clump of cuts reads as one wide smear while the gap beside it reads as untouched snow.
        path = (i + rng.uniform(0.15, 0.85)) * size / count
        for cycles, amp in ((1, 1.0), (2, 0.45), (3, 0.25)):
            path = path + wander * (amp / 1.7) * np.sin(2 * np.pi * cycles * y / size
                                                        + rng.uniform(0, 2 * np.pi))
        # Signed distance to the cut, wrapped: a track leaving one side comes back on the other.
        d = (x - path + size / 2) % size - size / 2
        w = width * rng.uniform(0.7, 1.4)
        depth = rng.uniform(0.6, 1.0)
        out += depth * np.exp(-(d / w) ** 2)                          # the trench: darker
        out -= depth * lip * np.exp(-((d - 1.7 * w) / w) ** 2)        # its spoil ridge: brighter
    if out.std() < 1e-9:
        raise RuntimeError('grooves() produced a flat field - check count, width and depth')
    return (out - out.mean()) / out.std()


def crackle(seed, size=TILE, spacing=6.0, width=1.4, metres=METRES):
    """A fracture network: thin dark lines along the zero contour of a smooth field.

    The second thing in the library that draws rather than filters, and it is here for the same
    arithmetic that puts `grooves` here. A crack in ice is centimetres to a metre across, which at 16
    cm/px is a fraction of a pixel to six pixels; a band asked for at that size produces speckle,
    because a filter shapes how FAST the field varies and not what shape the variation takes. A line
    is a shape. It has to be drawn.

    `spacing` is the size of a slab between cracks, in metres, and `width` is the crack's own
    half-width in PIXELS. The lines are the zero contour of a smooth periodic field, which buys three
    things at once: the network is irregular and closed the way a fracture pattern is, it wraps
    exactly because the field does, and it has no identifiable motif to become a polka-dot grid
    across a slope — the trap that rules out drawing a crack a person could recognise twice.

    Dividing the field by its own gradient before the falloff is what keeps the line a constant width
    in pixels. Without it a crack is thin where the field is steep and a smear where it is flat, so a
    tile ends up with a few fat blotches, which is the shape a base page must not have. The gradient
    is taken with `roll` rather than `np.gradient` for the same reason everything else here is
    periodic: a one-sided difference at the edge would thicken the cracks that cross the wrap.

    Returns a unit-variance field like `field` does, positive along the cracks, so `paint` maps them
    to the dark end of the ramp and the page reads as a bright surface with fractures cut into it —
    which is also what keeps the skew negative.
    """
    h = _shaped(seed, [(spacing, 1.0)], size=size, metres=metres)
    gx = 0.5 * (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1))
    gy = 0.5 * (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0))
    out = np.exp(-(np.abs(h) / np.maximum(np.hypot(gx, gy), 1e-9) / width) ** 2)
    if out.std() < 1e-9:
        raise RuntimeError('crackle() produced a flat field - check spacing and width')
    return (out - out.mean()) / out.std()


def seven_bit(rgb):
    """Snap to the lattice the extracted pages live on: every channel odd, 1 to 253, never 255.

    The console stores 7 bits per component and the extractor expands them as `2v+1`, so retail's
    whitest white is 253 and no even value exists anywhere in a shipped page. Reproducing that is
    free and it is half of why these tiles look like the game's.
    """
    return np.minimum(np.round(np.clip(np.asarray(rgb, float), 0, 255) / 2), 126) * 2 + 1


def ladder(lit, shade, steps):
    """The tile's whole palette: `steps` colours evenly spaced from its brightest to its deepest.

    Both ends are colours a recipe MEASURED off a page it is answering to, not invented — `lit` is
    very nearly neutral white, `shade` is the blue the tile bottoms out at. Everything between is
    interpolation, because the shipped data says there is nothing else there (99.6%+ of variance on
    one axis).

    `steps` is what `check.py` reports as the colour count, and it lands in retail's 19-94 by being
    set to a number in that range rather than by luck.
    """
    if steps < 2:
        raise RuntimeError('a ladder needs at least two colours')
    t = np.linspace(0.0, 1.0, steps)[:, None]
    return seven_bit(np.array(lit, float) + t * (np.array(shade, float) - np.array(lit, float)))


def paint(h, rungs, spread=3.5, gamma=1.0):
    """Map the field onto the ladder.

    `spread` is how many standard deviations of the field the ladder covers, so it sets which pixels
    are allowed to reach the extreme colours. The default 3.5 puts the ends at about one pixel in
    5000 — which is what the shipped pages measure: SNOW/0048's brightest and darkest entries are
    0.02% of the page each. Turning it down raises contrast and starts clipping into flat clumps at
    both ends.

    `gamma` bends the ramp. Above 1.0 it pushes most of the page toward `lit` while leaving the dark
    tail where it is — the negative skew every shipped page has. 1.0 is the symmetric case and the
    open snow field is the one tile that measures that way.
    """
    t = np.clip(0.5 + h / (2.0 * spread), 0.0, 1.0) ** gamma
    index = np.clip(np.round(t * (len(rungs) - 1)).astype(int), 0, len(rungs) - 1)
    return rungs[index].astype(np.uint8)


def measure(rgb):
    """Everything `check.py` and `measure.py` report, for a generated tile or a shipped one alike."""
    a = np.asarray(rgb)[..., :3].astype(float)
    flat = a.reshape(-1, 3)
    mean = flat.mean(0)
    centred = flat - mean
    eig = np.linalg.eigvalsh(np.cov(centred.T))
    projected = flat @ AXIS
    grain = projected.std()
    # Opposite edges against ordinary neighbours: 1.0 means the wrap is as smooth as the inside of
    # the tile, which is what a seamless page measures. A page that does not tile runs 3-10x.
    seam_u = np.abs(a[:, 0, :] - a[:, -1, :]).mean() / max(np.abs(a[:, 1:] - a[:, :-1]).mean(), 1e-9)
    seam_v = np.abs(a[0] - a[-1]).mean() / max(np.abs(a[1:] - a[:-1]).mean(), 1e-9)
    return {
        'mean': mean,
        'grain': grain,
        'skew': float(((projected - projected.mean()) ** 3).mean() / grain ** 3) if grain > 1e-9 else 0.0,
        'colours': len({tuple(c) for c in flat.astype(int)}),
        'axis share': 100.0 * eig.max() / eig.sum(),
        'seam': (seam_u, seam_v),
        'odd': float((np.asarray(rgb)[..., :3].astype(int) % 2 == 1).mean()),
        'octaves': octaves(a),
        'aniso': aniso(a),
        'streaks': streaks(a),
    }


def streaks(a):
    """How much of the tile survives being averaged down every column, as a percentage.

    `aniso` says the tile has a direction; this says the direction runs the WHOLE way down. Averaging
    a column erases anything that stops partway, so an elongated blob scores near the 1% an
    isotropic field gets by chance and a full-length cut scores its whole share. The shipped set
    splits on it far more sharply than on direction: `SNOW/0048` 1%, `0046` 3%, `0053` 5%, then
    `GARI/0012` at 29% and `SNOW/0045` at 40%.
    """
    lum = (np.asarray(a)[..., :3].astype(float) @ AXIS)
    return float(100.0 * lum.mean(0).var() / max(lum.var(), 1e-9))


def octaves(a, metres=METRES):
    """Where the tile's variation actually happens, by feature size in metres.

    The recipe's `bands` are a request; this is what the page came out at, and the two are worth
    reading side by side. Shipped snow is startlingly fine — SNOW/0048 puts half its energy into
    features between 30 and 60 cm, which at 16 cm/px is 2-4 pixels.
    """
    lum = a @ AXIS
    lum = lum - lum.mean()
    power = np.abs(np.fft.fft2(lum)) ** 2
    n = lum.shape[0]
    axis = np.fft.fftfreq(n) * n
    ky, kx = np.meshgrid(axis, axis, indexing='ij')
    k = np.hypot(kx, ky)
    total = max(power.sum() - power[0, 0], 1e-9)
    out = {}
    lo = 1
    while lo < n // 2:
        out[(metres / (lo * 2), metres / lo)] = 100.0 * power[(k >= lo) & (k < lo * 2)].sum() / total
        lo *= 2
    return out


def aniso(a):
    """Energy varying across `u` over energy varying across `v` — 1.0 is directionless.

    The shipped set splits cleanly on this: the open field sits at 0.4-0.7 and every page with
    visible track or wind streaking in it runs 2.8-4.0.
    """
    lum = a @ AXIS
    power = np.abs(np.fft.fft2(lum - lum.mean())) ** 2
    n = lum.shape[0]
    axis = np.fft.fftfreq(n) * n
    ky, kx = np.meshgrid(axis, axis, indexing='ij')
    k = np.hypot(kx, ky)
    band = (k >= 1) & (k < n // 4)
    return float(power[band & (np.abs(kx) > np.abs(ky))].sum()
                 / max(power[band & (np.abs(ky) > np.abs(kx))].sum(), 1e-9))


def guards(rgb, family='snow'):
    """The claims a terrain tile has to be able to make. Returns the failures, empty if it is sound.

    Each one is a shipped-data measurement rather than a preference, and each catches a mistake that
    is invisible on the page and obvious on the mountain. `family` picks which ground the last one
    holds the tile to — see `WARMTH`; everything else is measured over the whole shipped set and does
    not care what the recipe thinks it is making.
    """
    a = np.asarray(rgb)
    fails = []
    if family not in WARMTH:
        fails.append(f'family {family!r} - a tile is one of {", ".join(sorted(WARMTH))}')
    if a.ndim != 3 or a.shape[0] != a.shape[1] or a.shape[2] not in (3, 4):
        return [f'shape {a.shape} - a tile is a square RGB or RGBA image']
    n = a.shape[0]
    if n & (n - 1) or not 32 <= n <= 512:
        # The importer caps at 512 per edge, and a non-power-of-two page has no mip chain.
        fails.append(f'{n}x{n} - a tile must be a power of two between 32 and 512')
    if a.shape[2] == 4 and a[..., 3].min() != 255:
        # Terrain is opaque. A page with any transparency in it is classified cutout or translucent
        # by `props/texture-alpha.ts` and the mountain shows through it.
        fails.append(f'alpha dips to {a[..., 3].min()} - a terrain tile is opaque everywhere')

    m = measure(a)
    if max(m['seam']) > 1.6:
        fails.append(f'seam u {m["seam"][0]:.2f} v {m["seam"][1]:.2f} - the wrap is rougher than the '
                     f'inside of the tile, so it will read as a grid on the mountain '
                     f'(shipped pages run {RETAIL["seam"][0]}-{RETAIL["seam"][1]})')
    if m['axis share'] < 99.0:
        fails.append(f'{m["axis share"]:.2f}% of colour variance on one axis - snow has no hue '
                     f'variation, and every shipped page measures {RETAIL["axis share"][0]}%+')
    if m['odd'] < 1.0:
        fails.append(f'{100 * (1 - m["odd"]):.1f}% of channel values are even - a shipped page is '
                     f'entirely odd (7-bit lattice); pass the art through seven_bit()')
    if m['skew'] > 0.0:
        fails.append(f'skew {m["skew"]:+.2f} - the histogram leans dark. Snow is a bright surface '
                     f'with shadow cut into it; every shipped page measures negative')
    warmth = m['mean'][0] - m['mean'][2]
    if warmth > WARMTH.get(family, 1.0):
        fails.append(f'mean {m["mean"].round(0)} - red {warmth:.0f} over blue, and a {family} tile is '
                     f'allowed {WARMTH.get(family, 1.0):.0f}. Snow shadow is skylight and no shipped '
                     f'snow page is warm at all; the warmest ground retail paints is MESA/0054 at +87')
    return fails


def finish(rgb, name, out, family='snow'):
    """Run the guards, write the page, print what it measured. A recipe's last statement.

    The alpha channel is written out as a solid 255 rather than left off: `TextureBundle.cs`
    classifies every page's alpha on the way into a level, and an RGB PNG and an opaque RGBA one
    are not the same file to it.

    `family` is the one thing a recipe has to say about itself that the pixels cannot: which of the
    two grounds the shipped levels paint it is answering to (`WARMTH`). It stays out of the way of
    every other guard.
    """
    fails = guards(rgb, family)
    if fails:
        raise RuntimeError(f'{name}: ' + '\n      '.join(fails))

    a = np.asarray(rgb)
    if a.shape[2] == 3:
        a = np.dstack([a, np.full(a.shape[:2], 255, np.uint8)])
    if os.path.dirname(out):
        os.makedirs(os.path.dirname(out), exist_ok=True)
    Image.fromarray(a, 'RGBA').save(out)

    m = measure(a)
    print(f'wrote {out}  {a.shape[1]}x{a.shape[0]} RGBA')
    print(f'    mean {m["mean"].round(0)}  grain {m["grain"]:.1f}  skew {m["skew"]:+.2f}  '
          f'{m["colours"]} colours  axis {m["axis share"]:.2f}%  '
          f'seam u {m["seam"][0]:.2f} v {m["seam"][1]:.2f}')
    return a


def preview(rgb, out, scale=4, repeat=2):
    """A `repeat`x`repeat` block of the tile, magnified — the only honest way to look at one.

    A 128px page shown at 1:1 tells you nothing about the two things that matter: whether it tiles,
    and whether it has a feature distinctive enough to become a polka-dot grid across a slope. Both
    only appear once the page is next to a copy of itself.
    """
    a = np.asarray(rgb)[..., :3].astype(np.uint8)
    n = a.shape[0]
    block = np.tile(a, (repeat, repeat, 1))
    if os.path.dirname(out):
        os.makedirs(os.path.dirname(out), exist_ok=True)
    img = Image.fromarray(block).resize((n * repeat * scale,) * 2, Image.NEAREST)
    img.save(out)
    print(f'wrote {out}  {repeat}x{repeat} tiled at {scale}x')
