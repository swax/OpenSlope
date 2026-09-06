#!/usr/bin/env python3
"""Recover a fog's OPACITY, its COLOUR, and the blend mode that composited it, from a screenshot.

The question this exists for is a port question: our fog banks are drawn one way in Unity
(`OpenSlope/Particle`, alpha-over) and another in Slopesmith, and nobody has measured what the PS2 actually
does. "Compare the screenshots" is not an answer — a fog puff over snow and a fog puff over rock differ
by the snow and the rock, and eyeballing two washed-out images says which is whiter, not which is right.

The instrument is one idea: photograph a backdrop of KNOWN CONTRAST through the fog, and read the fog off
what it did to that contrast rather than off any absolute colour. Two patches of the same surface at the
same depth under the same light, one dark and one light:

    alpha-over   obs = (1-a)*bg + a*C      contrast shrinks by (1-a),  midpoint moves toward C
    additive     obs = bg + A              contrast UNCHANGED,         midpoint moves up by A
    darkening    obs = bg * (1-a)          contrast shrinks by (1-a),  midpoint moves toward 0

Every unknown that plagues an absolute reading — the panel's albedo, the lightmap on it, the exposure, an
unrelated tint — is common to both patches of a pair, so it divides out of the contrast and the mode falls
out of two numbers. Note the third row: contrast alone CANNOT separate alpha-over from darkening (both
scale by 1-a), which is why the midpoint is carried too. That is the whole measurement.

    python tools/autotest/fog_meter.py selftest                     prove the algebra against known fog
    python tools/autotest/fog_meter.py measure shot.png --layout photometer.json
    python tools/autotest/fog_meter.py measure shot.png \
        --ref  dark=40,300,60,80  light=120,300,60,80 \
        --fog  dark=40,520,60,80  light=120,520,60,80 --transfer srgb
    python tools/autotest/fog_meter.py annotate shot.png out.png --layout photometer.json

`--transfer` is not decoration and getting it wrong is the quiet way to be wrong here. The algebra above is
linear in whatever space the RENDERER BLENDED IN. The PS2 blends 8-bit framebuffer values directly, so a
PCSX2 screenshot is already in its blend space (`linear`). Unity in linear colour space and three.js with an
sRGB output both blend in linear light and encode on the way out, so their PNGs must be DECODED first
(`srgb`) or a 50% fog reads as about 73%.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover - the import error IS the message
    print("fog_meter needs Pillow: python -m pip install pillow", file=sys.stderr)
    raise

#: Code values this close to the rails are refused rather than measured. A clipped patch is the failure this
#: instrument is most exposed to -- additive fog over a white panel saturates, and a saturated patch reports a
#: contrast that shrank when what actually happened is that the top of it was cut off. Silent, and it biases
#: every derived number in the same direction, so it is a hard error rather than a warning.
CLIP_LOW, CLIP_HIGH = 2.0, 253.0

#: Fraction trimmed from each tail of a patch before averaging. The mean is the right estimator for a
#: dithered framebuffer (dithering preserves it by construction, which is what dithering is FOR), but a patch
#: that catches a HUD pixel or a panel edge needs the tails gone. Small, because it must not eat real signal.
TRIM = 0.10

#: The error floor on any patch mean, in code values, and the reason it exists is worth stating: pixel
#: scatter is NOT the whole error. A perfectly flat patch has zero scatter and an apparently perfect mean,
#: but the renderer still rounded every one of those pixels to the same 8-bit value, and that rounding does
#: not average away with more pixels -- it is a shared offset, not noise. sd/sqrt(N) alone therefore reports
#: unbounded confidence on exactly the flat patches this instrument is built to sample. Rounding error is
#: uniform on [-0.5, +0.5] -- a span of ONE code value, so its sd is 1/sqrt(12), not 0.5/sqrt(12).
QUANT_SIGMA = 1.0 / (12 ** 0.5)


def srgb_to_linear(v: np.ndarray) -> np.ndarray:
    """Decode 0..255 sRGB code values to 0..255-scaled linear light."""
    s = np.asarray(v, dtype=np.float64) / 255.0
    lin = np.where(s <= 0.04045, s / 12.92, ((s + 0.055) / 1.055) ** 2.4)
    return lin * 255.0


TRANSFERS = {
    # The PS2 blends the bytes it is about to store, so its framebuffer IS the blend space. Also correct for
    # a Unity project in Gamma colour space, where the blend happens on sRGB-encoded values too.
    "linear": lambda v: np.asarray(v, dtype=np.float64),
    # Blended in linear light, encoded on output: Unity in Linear colour space, three.js with an sRGB output
    # colour space. Tone mapping must be OFF -- it is not invertible here and no transfer flag can undo it.
    "srgb": srgb_to_linear,
}


@dataclass(frozen=True)
class Patch:
    """One sampled rectangle: its mean in blend space, and how well that mean is known."""
    name: str
    rect: tuple[int, int, int, int]
    mean: np.ndarray          # (3,) blend-space value per channel
    sigma: np.ndarray         # (3,) standard error OF THE MEAN, per channel
    spread: np.ndarray        # (3,) pixel standard deviation, for reporting
    pixels: int

    def describe(self) -> str:
        m, s = self.mean, self.spread
        return (f"{self.name:<12} rect={self.rect}  mean=({m[0]:7.3f},{m[1]:7.3f},{m[2]:7.3f})"
                f"  sd=({s[0]:5.2f},{s[1]:5.2f},{s[2]:5.2f})  n={self.pixels}")


def sample(image: np.ndarray, name: str, rect: tuple[int, int, int, int],
           transfer: str = "linear", block: int = 1) -> Patch:
    """Read one rectangle out of an RGB image and reduce it to a mean in blend space.

    `block` is the renderer's upscale factor, and it exists because the obvious standard error is a lie.
    PCSX2 at `upscale_multiplier = 2` emits each rendered pixel as a 2x2 output block, and a presentation
    filter correlates neighbours further, so sd/sqrt(N) over output pixels overstates how much independent
    evidence a patch holds by the block area. Dividing the count by block^2 is crude and it is the right
    direction; the alternative is an over-confident sigma, which is what turns a coin-flip into a claim.
    """
    x, y, w, h = rect
    height, width, _ = image.shape
    if x < 0 or y < 0 or x + w > width or y + h > height or w <= 0 or h <= 0:
        raise ValueError(f"patch {name!r} rect {rect} falls outside the {width}x{height} image")
    region = image[y:y + h, x:x + w, :].reshape(-1, 3).astype(np.float64)

    low, high = region.min(axis=0), region.max(axis=0)
    if (low <= CLIP_LOW).any() or (high >= CLIP_HIGH).any():
        raise ValueError(
            f"patch {name!r} is clipped (min={low.tolist()}, max={high.tolist()}); the algebra reads a "
            "clipped patch as one whose contrast shrank, which is the same signature as opacity. Re-shoot "
            "with a backdrop pair that leaves headroom -- mid-grey and dark grey, not white and black.")

    keep = max(1, int(round(region.shape[0] * (1 - 2 * TRIM))))
    ordered = np.sort(region, axis=0)
    start = (region.shape[0] - keep) // 2
    trimmed = ordered[start:start + keep, :]

    coded_mean = trimmed.mean(axis=0)
    spread = trimmed.std(axis=0)
    # Convert AFTER averaging: the transfer is applied to the patch's representative value, not per pixel,
    # because averaging dither noise is a linear operation on the code values the renderer actually wrote.
    mean = TRANSFERS[transfer](coded_mean)
    # Propagate the pixel spread through the same transfer as a first-order step, so sigma lands in the same
    # space as the mean and the two are comparable.
    effective = max(1.0, keep / max(1, block * block))
    step = np.maximum(spread / np.sqrt(effective), QUANT_SIGMA)
    sigma = np.abs(TRANSFERS[transfer](coded_mean + step) - mean)
    return Patch(name, rect, mean, sigma, spread, int(keep))


@dataclass
class Reading:
    """What one (reference pair, fogged pair) comparison recovered."""
    mode: str
    opacity: np.ndarray            # (3,) attenuation of the backdrop, 0..1; ~0 for additive
    colour: np.ndarray | None      # (3,) fog colour in blend space, or None when not separable
    added: np.ndarray | None       # (3,) premultiplied contribution, for additive
    retention: np.ndarray          # (3,) contrast kept, = 1 - opacity
    opacity_sigma: np.ndarray      # (3,)
    colour_sigma: np.ndarray | None = None   # (3,) and it blows up as opacity -> 0, on purpose
    notes: list[str] = field(default_factory=list)


def measure(ref_dark: Patch, ref_light: Patch, fog_dark: Patch, fog_light: Patch,
            sigmas: float = 3.0) -> Reading:
    """Compare an unfogged backdrop pair with the same pair seen through fog.

    Both pairs must be the SAME two albedos under the SAME light. That is the fixture's whole job: a
    reference pair whose only difference from the fogged pair is the fog in front of it. Anything else that
    differs -- a different panel, a different distance, a lightmap seam -- lands in the answer as opacity.
    """
    ref_contrast = ref_light.mean - ref_dark.mean
    fog_contrast = fog_light.mean - fog_dark.mean
    ref_mid = (ref_light.mean + ref_dark.mean) / 2.0
    fog_mid = (fog_light.mean + fog_dark.mean) / 2.0

    notes: list[str] = []
    # Standard error on each derived quantity, propagated from the four patch means in quadrature.
    contrast_sigma = np.sqrt(fog_light.sigma ** 2 + fog_dark.sigma ** 2
                             + ref_light.sigma ** 2 + ref_dark.sigma ** 2)
    shift_sigma = contrast_sigma / 2.0

    weak = np.abs(ref_contrast) < np.maximum(4.0 * contrast_sigma, 1.0)
    if weak.all():
        raise ValueError(
            f"the reference pair has no usable contrast ({ref_contrast.tolist()}); the dark and light "
            "patches are reading the same value, so there is nothing for the fog to attenuate. Check the "
            "rects land on the two DIFFERENT panels.")
    if weak.any():
        notes.append(f"channels {np.flatnonzero(weak).tolist()} have too little reference contrast to "
                     "measure; their opacity is not meaningful")

    safe = np.where(np.abs(ref_contrast) < 1e-6, 1e-6, ref_contrast)
    retention = fog_contrast / safe
    opacity = 1.0 - retention
    opacity_sigma = np.abs(contrast_sigma / safe)
    shift = fog_mid - ref_mid

    # THE TRANSFER-FUNCTION CHECK, and it earns its place: alpha is ONE scalar, so a real alpha-over blend
    # must attenuate all three channels by the same factor. Channels that disagree by far more than their
    # own error bars mean the algebra is being done in the wrong space -- the numbers still come out, still
    # look plausible, and are wrong. Measured on Slopesmith, reading a gamma-space blend as linear returned
    # per-channel opacities of 0.107 / 0.085 / 0.057 where the truth was a flat 0.188.
    if float(np.max(opacity)) > 0.02:
        spread_between = float(np.max(opacity) - np.min(opacity))
        allowed = float(np.max(opacity_sigma)) * 4.0
        if spread_between > max(allowed, 0.02):
            notes.append(
                f"channel opacities disagree by {spread_between:.3f} (error bars allow {allowed:.3f}) -- "
                f"alpha is a single scalar, so this almost always means --transfer is wrong for this "
                f"renderer. Try the other one: a target that blends in gamma space reads as 'linear', one "
                f"that blends in linear light and encodes on output reads as 'srgb'.")

    # THE SAME-BACKDROP CHECK. No blend on offer can INCREASE contrast: additive leaves it exactly alone and
    # the other two scale it by (1-a) <= 1. So a retention meaningfully above 1 does not describe a fog at
    # all, it says the reference pair and the fogged pair are not looking at the same backdrop -- which is
    # the one assumption this whole instrument rests on and the easiest to violate in a real scene. Caught
    # on the first PS2 attempt: two patches of rock 100 px apart returned retention 1.9 and a confident
    # "additive", off nothing but the second piece of rock having more contrast than the first.
    excess = float(np.max(retention)) - 1.0
    if excess > max(4.0 * float(np.max(opacity_sigma)), 0.08):
        raise ValueError(
            f"the fogged pair has MORE contrast than the reference pair (retention up to "
            f"{float(np.max(retention)):.2f}); no blend can do that, so the two pairs are not the same "
            "backdrop under the same light. Use a backdrop that is genuinely uniform across both regions -- "
            "one authored panel or checkerboard, not two pieces of scenery that merely look alike.")

    # Which mode? Two independent yes/no questions, each asked against this measurement's own noise rather
    # than a tuned constant, so a thin reading declines to classify instead of guessing.
    attenuated = (opacity > sigmas * opacity_sigma).any()
    brightened = (shift > sigmas * shift_sigma).any()

    if not attenuated and not brightened:
        return Reading("none", opacity, None, None, retention, opacity_sigma, None,
                       notes + ["no fog detected: contrast and midpoint both unchanged within noise"])
    if not attenuated:
        # Contrast survived intact, so nothing replaced the backdrop -- the fog only ADDED light. What is
        # recoverable is the product (colour x alpha) the GS wrote, not the two factors: `Cs*As + Cd` is one
        # number per channel and no backdrop can split it. That is a property of additive blending, not a
        # shortcoming here, and it is exactly the number a port has to match.
        return Reading("additive", opacity, None, shift, retention, opacity_sigma, None,
                       notes + ["additive: contrast intact, so `added` is the premultiplied Cs*As the "
                                "framebuffer gained; colour and alpha are not separable from one backdrop"])

    usable = opacity > np.maximum(sigmas * opacity_sigma, 1e-3)
    colour = np.full(3, np.nan)
    colour[usable] = ref_mid[usable] + shift[usable] / opacity[usable]
    # The colour is a QUOTIENT by the opacity, so a thin fog determines it badly however clean the pixels
    # are: at a=0.15 a half-code-value wobble in the midpoint is a 3-unit swing in the recovered colour, and
    # at a=0.02 it is 25. That is a real property of the measurement rather than a defect, and the only
    # dishonest thing would be to print the quotient without it.
    mid_sigma = np.sqrt(ref_light.sigma ** 2 + ref_dark.sigma ** 2) / 2.0
    colour_sigma = np.full(3, np.inf)
    o = opacity[usable]
    colour_sigma[usable] = np.sqrt(
        mid_sigma[usable] ** 2
        + (shift_sigma[usable] / o) ** 2
        + (shift[usable] * opacity_sigma[usable] / (o * o)) ** 2)
    # Darkening multiplies by (1-a) and ignores the sprite colour entirely, which is the same contrast
    # signature as an alpha-over fog whose colour happens to be black. They are the same measurement; the
    # honest report says the recovered colour is black and names the ambiguity.
    bar = np.maximum(2.0, sigmas * np.nan_to_num(colour_sigma, posinf=1e6))
    if np.all(np.abs(np.nan_to_num(colour)) < bar):
        return Reading("darkening", opacity, colour, None, retention, opacity_sigma, colour_sigma,
                       notes + ["recovered colour is black, which alpha-over and the GS darkening blend "
                                "produce identically; a second backdrop luminance would separate them"])
    return Reading("alpha-over", opacity, colour, None, retention, opacity_sigma, colour_sigma, notes)


def report(reading: Reading, patches: list[Patch], transfer: str) -> str:
    lines = [f"transfer: {transfer}  (the space the algebra assumes the renderer blended in)", ""]
    lines += ["  " + p.describe() for p in patches]
    o, s = reading.opacity, reading.opacity_sigma
    lines += ["", f"  blend mode      {reading.mode}",
              f"  opacity         ({o[0]:6.3f},{o[1]:6.3f},{o[2]:6.3f})"
              f"  +/- ({s[0]:.3f},{s[1]:.3f},{s[2]:.3f})",
              f"  contrast kept   ({reading.retention[0]:6.3f},{reading.retention[1]:6.3f},"
              f"{reading.retention[2]:6.3f})"]
    if reading.colour is not None:
        c = reading.colour
        cs = reading.colour_sigma if reading.colour_sigma is not None else np.full(3, np.nan)
        lines.append(f"  fog colour      ({c[0]:7.2f},{c[1]:7.2f},{c[2]:7.2f})  in blend space, 0..255"
                     f"  +/- ({cs[0]:.2f},{cs[1]:.2f},{cs[2]:.2f})")
    if reading.added is not None:
        a = reading.added
        lines.append(f"  added Cs*As     ({a[0]:7.2f},{a[1]:7.2f},{a[2]:7.2f})  in blend space, 0..255")
    for note in reading.notes:
        lines.append(f"  note: {note}")
    return "\n".join(lines)


# ---- the two methods that survived validation ------------------------------------------------------------
# A single dark/light patch pair is the obvious instrument and it is not good enough. `fog0` is a CLOUDY
# texture rather than a smooth blob: measured against the exact map below, its alpha varies by +/-0.04
# between neighbouring points on a signal of 0.19, so any one pair scatters by a quarter of the quantity it
# is measuring. Two things fix it, and which one is available depends on whether the scene can be re-rendered.


def opacity_map(dark_fog: np.ndarray, light_fog: np.ndarray, dark_clear: np.ndarray,
                light_clear: np.ndarray, transfer: str = "linear") -> np.ndarray:
    """Per-pixel opacity, from the same scene over two backdrops, fogged and clear. The gold standard.

    At one pixel the fog's alpha is a single number, so with two known backdrops the alpha-over algebra
    solves exactly and assumes NOTHING -- no symmetry, no smoothness, no knowledge of the texture. It needs
    four renders of one viewpoint, so it is available in Unity and Slopesmith and never on a console.
    """
    f = TRANSFERS[transfer]
    ref = f(light_clear) - f(dark_clear)
    return 1.0 - (f(light_fog) - f(dark_fog)) / np.where(np.abs(ref) < 1e-6, 1e-6, ref)


def checker_patch(image: np.ndarray, name: str, rect: tuple[int, int, int, int], want_light: bool,
                  transfer: str = "linear", block: int = 1, edge_guard: float = 0.25) -> Patch:
    """Mean of just the light (or dark) cells of a CHECKERBOARD backdrop inside `rect`.

    This is the console-viable half. A console gives one frame and no way to switch the fog off, so the two
    backdrop luminances have to be present in that frame at once and interleaved finely enough that both are
    sampled under the same fog. Two properties make it work:

    - **The cells are classified from the frame being measured**, not from a clear reference, so no second
      render is needed. Validated against clear-frame classification: identical to four decimal places at
      every radius, which it should be — the fog attenuates both cell families but leaves them separable.
    - **Averaging many cells over a region beats any single pair.** Against the exact map this lands within
      0.003 at every radius, where single pairs scatter by 0.05. The texture structure that defeats one pair
      is uncorrelated between cells, so it averages down; what does not average down is anything that varies
      systematically across the region, which is why a region should be an annulus or a small box rather
      than a swathe crossing the whole puff.

    `edge_guard` drops the middle band of the luminance range, i.e. the pixels on cell boundaries where
    filtering has mixed the two.
    """
    x, y, w, h = rect
    height, width, _ = image.shape
    if x < 0 or y < 0 or x + w > width or y + h > height or w <= 0 or h <= 0:
        raise ValueError(f"patch {name!r} rect {rect} falls outside the {width}x{height} image")
    window = image[y:y + h, x:x + w, :].reshape(-1, 3).astype(np.float64)
    lum = window.mean(axis=1)
    lo, hi = float(lum.min()), float(lum.max())
    if hi - lo < 8.0:
        raise ValueError(
            f"patch {name!r} spans no checkerboard contrast ({lo:.1f}..{hi:.1f}); the rect is inside a "
            "single cell, or the backdrop there is not a checkerboard")
    keep = lum > lo + (1 - edge_guard) * (hi - lo) if want_light else lum < lo + edge_guard * (hi - lo)
    if int(keep.sum()) < 16:
        raise ValueError(f"patch {name!r}: only {int(keep.sum())} pixels survived cell classification; "
                         "widen the rect or lower --edge-guard")
    selected = window[keep]
    if (selected.min() <= CLIP_LOW) or (selected.max() >= CLIP_HIGH):
        raise ValueError(f"patch {name!r} is clipped; see the note in `sample`")
    coded = selected.mean(axis=0)
    spread = selected.std(axis=0)
    mean = TRANSFERS[transfer](coded)
    effective = max(1.0, len(selected) / max(1, block * block))
    step = np.maximum(spread / np.sqrt(effective), QUANT_SIGMA)
    sigma = np.abs(TRANSFERS[transfer](coded + step) - mean)
    return Patch(name, rect, mean, sigma, spread, int(len(selected)))


# ---- layouts ---------------------------------------------------------------------------------------------
# A layout names the four rects once so the fixture that BUILT the shot can hand them to the tool that reads
# it, and so the same file can drive the Slopesmith and Unity captures. Keeping them out of the command line
# is what makes the three-renderer comparison a repeat of one measurement rather than three.

def load_layout(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    for key in ("refDark", "refLight", "fogDark", "fogLight"):
        if key not in data:
            raise ValueError(f"{path}: layout is missing {key!r}")
    return data


def rects_from(args: argparse.Namespace) -> tuple[dict[str, tuple[int, int, int, int]], str, int]:
    def parse(text: str) -> tuple[int, int, int, int]:
        parts = [int(p) for p in text.split(",")]
        if len(parts) != 4:
            raise ValueError(f"rect {text!r} must be x,y,w,h")
        return tuple(parts)  # type: ignore[return-value]

    if args.layout:
        data = load_layout(Path(args.layout))
        rects = {k: tuple(data[v]) for k, v in
                 (("ref-dark", "refDark"), ("ref-light", "refLight"),
                  ("fog-dark", "fogDark"), ("fog-light", "fogLight"))}
        return rects, data.get("transfer", args.transfer), int(data.get("block", args.block))  # type: ignore[return-value]

    def pair(items: list[str], prefix: str) -> dict[str, tuple[int, int, int, int]]:
        out = {}
        for item in items or []:
            key, _, value = item.partition("=")
            if key not in ("dark", "light"):
                raise ValueError(f"--{prefix} takes dark=… and light=…, got {key!r}")
            out[f"{prefix}-{key}"] = parse(value)
        if len(out) != 2:
            raise ValueError(f"--{prefix} needs both dark= and light=")
        return out

    rects = {**pair(args.ref, "ref"), **pair(args.fog, "fog")}
    return rects, args.transfer, args.block


# ---- self test -------------------------------------------------------------------------------------------

def _synthetic(bg_dark: float, bg_light: float, mode: str, alpha: float,
               colour: tuple[float, float, float], encode: bool) -> np.ndarray:
    """Render a 2x2-panel test card with fog composited by a KNOWN rule, so the reader can be graded.

    Top row is the clear reference pair, bottom row the same two albedos with fog over them. Values are
    computed in linear blend space and optionally sRGB-ENCODED on the way out, which is how a real renderer
    hands over a PNG -- so the round trip exercises the transfer flag rather than assuming it away.
    """
    card = np.zeros((200, 200, 3), dtype=np.float64)
    card[:100, :100, :] = bg_dark
    card[:100, 100:, :] = bg_light
    fogged = np.zeros((100, 200, 3))
    fogged[:, :100, :] = bg_dark
    fogged[:, 100:, :] = bg_light
    tint = np.asarray(colour, dtype=np.float64)
    if mode == "alpha-over":
        fogged = (1 - alpha) * fogged + alpha * tint
    elif mode == "additive":
        fogged = fogged + alpha * tint
    elif mode == "darkening":
        fogged = fogged * (1 - alpha)
    elif mode == "none":
        pass
    else:
        raise ValueError(mode)
    card[100:, :, :] = fogged
    card = np.clip(card, 0, 255)
    if encode:
        s = card / 255.0
        card = np.where(s <= 0.0031308, s * 12.92, 1.055 * s ** (1 / 2.4) - 0.055) * 255.0
    # Quantise like a real framebuffer, so the test also proves the reader survives 8-bit rounding.
    return np.round(card).astype(np.uint8).astype(np.float64)


def selftest(verbose: bool = True) -> int:
    """Grade the reader against fog it cannot get wrong by luck."""
    rects = {"ref-dark": (10, 10, 80, 80), "ref-light": (110, 10, 80, 80),
             "fog-dark": (10, 110, 80, 80), "fog-light": (110, 110, 80, 80)}
    # Mid-grey and light-grey rather than black and white: an additive case over a white backdrop clips, and
    # the reader is supposed to REFUSE that rather than measure it (covered as its own case below).
    cases = [
        ("alpha-over", 0.50, (230.0, 235.0, 240.0)),
        ("alpha-over", 0.15, (230.0, 235.0, 240.0)),
        ("alpha-over", 0.85, (200.0, 100.0, 60.0)),
        ("additive", 0.30, (120.0, 120.0, 120.0)),
        ("additive", 0.10, (150.0, 130.0, 110.0)),
        ("darkening", 0.40, (0.0, 0.0, 0.0)),
        ("none", 0.0, (0.0, 0.0, 0.0)),
    ]
    failures = 0
    for encode, transfer in ((False, "linear"), (True, "srgb")):
        for mode, alpha, colour in cases:
            card = _synthetic(60.0, 150.0, mode, alpha, colour, encode)
            patches = [sample(card, name, rects[name], transfer, block=1)
                       for name in ("ref-dark", "ref-light", "fog-dark", "fog-light")]
            reading = measure(*patches)
            ok = reading.mode == mode
            detail = ""
            if mode in ("alpha-over", "darkening"):
                got = float(np.nanmean(reading.opacity))
                ok = ok and abs(got - alpha) < 0.02
                detail = f"opacity {got:.4f} vs {alpha:.4f}"
                if mode == "alpha-over" and reading.colour is not None:
                    err = float(np.nanmax(np.abs(reading.colour - np.asarray(colour))))
                    # Graded against the error bar the reading itself published, not a flat constant. A
                    # thin fog genuinely cannot pin its colour, and a tolerance that ignored that would
                    # either fail the honest low-opacity case or pass a wildly wrong high-opacity one.
                    bar = 3.0 * float(np.nanmax(reading.colour_sigma))
                    ok = ok and err < max(1.0, bar)
                    detail += f", colour err {err:.2f} (3 sigma = {bar:.2f})"
            elif mode == "additive":
                want = alpha * np.asarray(colour)
                err = float('inf') if reading.added is None else float(np.max(np.abs(reading.added - want)))
                ok = ok and err < 2.0
                detail = f"added err {err:.2f}"
            failures += 0 if ok else 1
            if verbose or not ok:
                flag = "ok  " if ok else "FAIL"
                print(f"  {flag} {transfer:<6} {mode:<11} a={alpha:.2f}  -> {reading.mode:<11} {detail}")

    # The refusals matter as much as the readings: each of these yields a plausible wrong number if it is
    # measured rather than rejected.
    for label, build in (
        ("clipped white backdrop", lambda: _synthetic(60.0, 250.0, "additive", 0.9, (200.0,) * 3, False)),
        ("no reference contrast", lambda: _synthetic(120.0, 120.0, "alpha-over", 0.5, (240.0,) * 3, False)),
    ):
        card = build()
        try:
            patches = [sample(card, n, rects[n], "linear", 1) for n in
                       ("ref-dark", "ref-light", "fog-dark", "fog-light")]
            measure(*patches)
        except ValueError as exc:
            print(f"  ok   refused  {label:<22} -> {str(exc).split(';')[0]}")
        else:
            failures += 1
            print(f"  FAIL refused  {label:<22} -> measured it anyway")

    print(f"\n{'PASS' if not failures else f'{failures} FAILURE(S)'}")
    return 1 if failures else 0


# ---- cli -------------------------------------------------------------------------------------------------

def cmd_measure(args: argparse.Namespace) -> int:
    rects, transfer, block = rects_from(args)
    image = np.asarray(Image.open(args.image).convert("RGB")).astype(np.float64)
    patches = [sample(image, name, rects[name], transfer, block)
               for name in ("ref-dark", "ref-light", "fog-dark", "fog-light")]
    reading = measure(*patches, sigmas=args.sigmas)
    print(f"{args.image}  {image.shape[1]}x{image.shape[0]}")
    print(report(reading, patches, transfer))
    if args.json:
        Path(args.json).write_text(json.dumps({
            "image": str(args.image), "transfer": transfer, "mode": reading.mode,
            "opacity": reading.opacity.tolist(), "opacitySigma": reading.opacity_sigma.tolist(),
            "retention": reading.retention.tolist(),
            "colour": None if reading.colour is None else np.nan_to_num(reading.colour).tolist(),
            "added": None if reading.added is None else reading.added.tolist(),
            "patches": {p.name: {"rect": list(p.rect), "mean": p.mean.tolist()} for p in patches},
            "notes": reading.notes,
        }, indent=2), encoding="utf-8")
        print(f"\nwrote {args.json}")
    return 0


def cmd_checker(args: argparse.Namespace) -> int:
    """Read the fog off ONE frame of a checkerboard backdrop — the console-viable method."""
    image = np.asarray(Image.open(args.image).convert("RGB")).astype(np.float64)

    def rect(text: str) -> tuple[int, int, int, int]:
        parts = [int(p) for p in text.split(",")]
        if len(parts) != 4:
            raise ValueError(f"rect {text!r} must be x,y,w,h")
        return tuple(parts)  # type: ignore[return-value]

    fog_rect, ref_rect = rect(args.fog), rect(args.ref)
    patches = [
        checker_patch(image, "ref-dark", ref_rect, False, args.transfer, args.block, args.edge_guard),
        checker_patch(image, "ref-light", ref_rect, True, args.transfer, args.block, args.edge_guard),
        checker_patch(image, "fog-dark", fog_rect, False, args.transfer, args.block, args.edge_guard),
        checker_patch(image, "fog-light", fog_rect, True, args.transfer, args.block, args.edge_guard),
    ]
    reading = measure(*patches, sigmas=args.sigmas)
    print(f"{args.image}  {image.shape[1]}x{image.shape[0]}")
    print(f"  fog region {fog_rect}   reference region {ref_rect} (must be clear of the fog)")
    print(report(reading, patches, args.transfer))
    return 0


def cmd_map(args: argparse.Namespace) -> int:
    """Solve opacity at every pixel from a backdrop swap, and report its structure."""
    load = lambda p: np.asarray(Image.open(p).convert("RGB")).astype(np.float64)
    dark_fog, light_fog = load(args.dark_fog), load(args.light_fog)
    dark_clear, light_clear = load(args.dark_clear), load(args.light_clear)
    f = TRANSFERS[args.transfer]
    separation = (f(light_clear) - f(dark_clear))
    print(f"backdrop separation: mean {separation.mean():.3f}, sd {separation.std():.4f}"
          f"   (a large sd means the two clear renders differ by more than their backdrop)")
    if separation.mean() < 8.0:
        print("fog_meter: the two backdrops are too close together to divide by", file=sys.stderr)
        return 2
    full = opacity_map(dark_fog, light_fog, dark_clear, light_clear, args.transfer)
    grey = full.mean(axis=2)
    print(f"opacity: min {grey.min():.4f}  max {grey.max():.4f}  mean {grey.mean():.4f}")
    if args.out:
        scale = args.scale if args.scale > 0 else max(1e-6, float(grey.max()))
        Image.fromarray(np.clip(grey / scale * 255, 0, 255).astype(np.uint8)).save(args.out)
        print(f"wrote {args.out}  (white = opacity {scale:.3f})")
    if args.centre:
        cx, cy, radius = (float(v) for v in args.centre.split(","))
        h, w = grey.shape
        ys, xs = np.mgrid[0:h, 0:w]
        r = np.hypot(xs - cx, ys - cy)
        print(f"\n{'r/R':>6} {'mean a':>9} {'sd in annulus':>15}")
        for k in range(11):
            band = (r >= k * 0.1 * radius) & (r < (k + 1) * 0.1 * radius)
            if band.sum() < 50:
                continue
            print(f"{(k + 0.5) * 0.1:6.2f} {grey[band].mean():9.4f} {grey[band].std():15.4f}")
        outside = r > radius * 1.1
        if outside.any():
            print(f"\noutside the puff: mean {grey[outside].mean():.5f} sd {grey[outside].std():.5f}"
                  f"   (both must be ~0, or the two 'clear' renders were not identical)")
    return 0


def cmd_annotate(args: argparse.Namespace) -> int:
    """Draw the sample rects onto a copy of the shot.

    Cheap and load-bearing: every wrong number this instrument has produced would have been visible in one
    glance at this image, and a rect that has slid off its panel is invisible in the numbers alone.
    """
    rects, _, _ = rects_from(args)
    image = Image.open(args.image).convert("RGB")
    draw = ImageDraw.Draw(image)
    for name, (x, y, w, h) in rects.items():
        colour = (255, 64, 64) if name.startswith("ref") else (64, 200, 255)
        draw.rectangle([x, y, x + w - 1, y + h - 1], outline=colour, width=2)
        draw.text((x + 3, max(0, y - 12)), name, fill=colour)
    image.save(args.out)
    print(f"wrote {args.out}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    def add_rect_args(p: argparse.ArgumentParser) -> None:
        p.add_argument("image")
        p.add_argument("--layout", help="JSON naming the four rects (and optionally transfer/block)")
        p.add_argument("--ref", nargs="*", metavar="dark=x,y,w,h",
                       help="the CLEAR backdrop pair")
        p.add_argument("--fog", nargs="*", metavar="dark=x,y,w,h",
                       help="the same pair seen THROUGH the fog")
        p.add_argument("--transfer", choices=sorted(TRANSFERS), default="linear",
                       help="the space the renderer blended in (default: linear, i.e. PS2/PCSX2)")
        p.add_argument("--block", type=int, default=1,
                       help="renderer upscale factor; shrinks the independent-pixel count (PCSX2: 2)")

    m = sub.add_parser("measure", help="read the fog off a shot")
    add_rect_args(m)
    m.add_argument("--sigmas", type=float, default=3.0, help="separation required to name a blend mode")
    m.add_argument("--json", help="also write the reading here, for the cross-renderer table")
    m.set_defaults(func=cmd_measure)

    a = sub.add_parser("annotate", help="draw the sample rects on a copy of the shot")
    add_rect_args(a)
    a.add_argument("out")
    a.set_defaults(func=cmd_annotate)

    c = sub.add_parser("checker", help="one frame, checkerboard backdrop — the method a console allows")
    c.add_argument("image")
    c.add_argument("--fog", required=True, metavar="x,y,w,h", help="a region INSIDE the fog")
    c.add_argument("--ref", required=True, metavar="x,y,w,h", help="the same backdrop, CLEAR of the fog")
    c.add_argument("--transfer", choices=sorted(TRANSFERS), default="linear")
    c.add_argument("--block", type=int, default=1)
    c.add_argument("--edge-guard", type=float, default=0.25,
                   help="fraction of the luminance range dropped as cell-boundary bleed")
    c.add_argument("--sigmas", type=float, default=3.0)
    c.set_defaults(func=cmd_checker)

    p = sub.add_parser("map", help="per-pixel opacity from a backdrop swap — the gold standard")
    p.add_argument("dark_fog"); p.add_argument("light_fog")
    p.add_argument("dark_clear"); p.add_argument("light_clear")
    p.add_argument("--transfer", choices=sorted(TRANSFERS), default="linear")
    p.add_argument("--out", help="write the map as a PNG")
    p.add_argument("--scale", type=float, default=0.0, help="opacity mapped to white (default: the max)")
    p.add_argument("--centre", metavar="cx,cy,radius", help="also print a radial profile about this point")
    p.set_defaults(func=cmd_map)

    s = sub.add_parser("selftest", help="grade the reader against synthetic fog with known ground truth")
    s.set_defaults(func=lambda _args: selftest())

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except ValueError as exc:
        print(f"fog_meter: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
