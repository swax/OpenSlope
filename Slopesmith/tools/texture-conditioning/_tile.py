"""Shared bitmap operations for generated terrain tiles."""

from __future__ import annotations

import math
import random
from pathlib import Path

from PIL import Image


def _line_diff(a, b) -> float:
    return sum(abs(p[c] - q[c]) for p, q in zip(a, b) for c in range(3)) / (len(a) * 3)


def seam_stats(im: Image.Image) -> dict[str, float]:
    """Return horizontal/vertical wrap ratios and directional interior variation."""
    im = im.convert("RGB")
    w, h = im.size
    px = im.load()
    row = lambda y: [px[x, y] for x in range(w)]
    col = lambda x: [px[x, y] for y in range(h)]
    sx = max(1, w // 36)
    sy = max(1, h // 36)
    inner_h = sum(_line_diff(col(x), col(x + 1)) for x in range(0, w - 1, sx)) / len(range(0, w - 1, sx))
    inner_v = sum(_line_diff(row(y), row(y + 1)) for y in range(0, h - 1, sy)) / len(range(0, h - 1, sy))
    # Flooring the denominator prevents near-flat art from producing meaningless ratios without hiding a
    # real edge mismatch in the numerator.
    h_ratio = _line_diff(col(w - 1), col(0)) / max(inner_h, 0.5)
    v_ratio = _line_diff(row(h - 1), row(0)) / max(inner_v, 0.5)
    return {
        "h_ratio": h_ratio,
        "v_ratio": v_ratio,
        "directionality": inner_h / max(inner_v, 1e-9),
    }


def verdict(stats: dict[str, float]) -> str:
    worst = max(stats["h_ratio"], stats["v_ratio"])
    if worst < 1.6:
        return "SEAMLESS"
    if worst < 2.5:
        return "slight seam"
    return "VISIBLE SEAM"


def seamless_resize(im: Image.Image, size: int) -> Image.Image:
    """Resize a wrapping image with real neighbours available to the edge filter."""
    im = im.convert("RGB")
    w, h = im.size
    tiled = Image.new("RGB", (w * 3, h * 3))
    for y in range(3):
        for x in range(3):
            tiled.paste(im, (x * w, y * h))
    tiled = tiled.resize((size * 3, size * 3), Image.Resampling.LANCZOS)
    return tiled.crop((size, size, size * 2, size * 2))


def repair_wrap(im: Image.Image, band: float = 0.25) -> Image.Image:
    """Apply Slopesmith's half-offset edge blend to slightly seamy organic art."""
    im = im.convert("RGB")
    w, h = im.size
    if w < 8 or h < 8:
        return im

    def weights(length: int) -> list[float]:
        reach = max(1.0, length * band)
        result = []
        for i in range(length):
            t = min(1.0, min(i, length - 1 - i) / reach)
            result.append(t * t * (3 - 2 * t))
        return result

    wx, wy = weights(w), weights(h)
    source = im.load()
    out = Image.new("RGB", im.size)
    target = out.load()
    half_x, half_y = w // 2, h // 2
    for y in range(h):
        oy = (y + half_y) % h
        for x in range(w):
            ox = (x + half_x) % w
            mix = wx[x] * wy[y]
            target[x, y] = tuple(round(source[x, y][c] * mix + source[ox, oy][c] * (1 - mix))
                                 for c in range(3))
    return out


def direction_to_axis(im: Image.Image, wanted: str | None) -> tuple[Image.Image, bool]:
    """Rotate directional artwork when its measured stripe axis differs from `wanted`."""
    if not wanted:
        return im, False
    d = seam_stats(im)["directionality"]
    wrong = (wanted == "vertical" and d < 1.0) or (wanted == "horizontal" and d > 1.0)
    return (im.transpose(Image.Transpose.ROTATE_90), True) if wrong else (im, False)


def fit_periodic_stripes(im: Image.Image) -> Image.Image:
    """Rebuild regular vertical stripes from one autocorrelated period."""
    im = im.convert("RGB")
    w, h = im.size
    px = im.load()
    sample_y = range(0, h, max(1, h // 256))
    profile = [sum(sum(px[x, y]) for y in sample_y) / (3 * len(sample_y)) for x in range(w)]
    mean = sum(profile) / w
    dev = [v - mean for v in profile]
    lo, hi = max(8, w // 128), max(9, w // 4)
    period = max(range(lo, hi), key=lambda p: sum(dev[i] * dev[i + p] for i in range(w - p)) / (w - p))
    start = min(range(period), key=lambda x: profile[x])
    count = max(1, round(w / period))
    stripe = im.transform((period, h), Image.Transform.AFFINE, (1, 0, start, 0, 1, 0))
    out = Image.new("RGB", (period * count, h))
    for x in range(count):
        out.paste(stripe, (x * period, 0))
    return out


def _luma_profile(im: Image.Image, axis: int) -> list[float]:
    """Mean brightness per column (axis 0) or row (axis 1)."""
    im = im.convert("RGB")
    w, h = im.size
    px = im.load()
    if axis == 0:
        sample = range(0, h, max(1, h // 256))
        return [sum(sum(px[x, y]) for y in sample) / (3 * len(sample)) for x in range(w)]
    sample = range(0, w, max(1, w // 256))
    return [sum(sum(px[x, y]) for x in sample) / (3 * len(sample)) for y in range(h)]


def _best_period(profile: list[float]) -> int:
    """Smallest lag near the strongest normalized autocorrelation peak."""
    length = len(profile)
    lo, hi = max(4, length // 128), max(5, length // 3)
    mean = sum(profile) / max(1, length)
    dev = [value - mean for value in profile]
    if sum(value * value for value in dev) < 1e-8:
        raise ValueError("periodic lattice has no measurable brightness variation")
    scores: list[tuple[int, float]] = []
    for lag in range(lo, hi):
        left, right = dev[:-lag], dev[lag:]
        denominator = math.sqrt(sum(value * value for value in left) * sum(value * value for value in right))
        scores.append((lag, sum(a * b for a, b in zip(left, right)) / max(denominator, 1e-12)))
    best = max(score for _, score in scores)
    # A periodic profile produces equally good peaks at k, 2k, 3k...; selecting the smallest near-best lag
    # retains the fundamental cell instead of arbitrarily choosing a larger harmonic.
    return next(lag for lag, score in scores if score >= best - 0.02)


def fit_periodic_lattice(im: Image.Image) -> Image.Image:
    """Crop a two-axis regular grid to a whole number of measured periods.

    Unlike ``fit_periodic_stripes``, this retains variation from cell to cell. It only removes the fractional
    row and column at the far edges that makes a waffle/grid pattern change phase when it wraps.
    """
    im = im.convert("RGB")
    period_x = _best_period(_luma_profile(im, 0))
    period_y = _best_period(_luma_profile(im, 1))
    cells_x, cells_y = max(1, im.width // period_x), max(1, im.height // period_y)
    width, height = cells_x * period_x, cells_y * period_y
    if width < 4 or height < 4:
        raise ValueError("measured lattice period leaves no usable image")
    return im.crop((0, 0, width, height))


def condition(im: Image.Image, size: int, density: int = 1, axis: str | None = None,
              stripes: bool = False, repair: bool = False, lattice: bool = False) -> tuple[Image.Image, bool]:
    if density < 1 or size % density:
        raise ValueError(f"density {density} must be a positive divisor of output size {size}")
    if stripes and lattice:
        raise ValueError("stripes and lattice are alternative periodic fits")
    im = repair_wrap(im) if repair else im.convert("RGB")
    im, rotated = direction_to_axis(im, axis)
    if stripes:
        im = fit_periodic_stripes(im)
    elif lattice:
        im = fit_periodic_lattice(im)
    sub = seamless_resize(im, size // density)
    if density == 1:
        return sub, rotated
    out = Image.new("RGB", (size, size))
    for y in range(density):
        for x in range(density):
            out.paste(sub, (x * sub.width, y * sub.height))
    return out, rotated


def organic_boundary(length: int, cross_size: int, seed: int, amplitude: float = 1.0) -> list[float]:
    """Periodic, multi-scale boundary coordinates with a few rounded syrup lobes."""
    rng = random.Random(seed)
    harmonics = ((1, 0.15), (2, 0.08), (3, 0.045), (5, 0.025))
    phases = [rng.random() * math.tau for _ in harmonics]
    lobes = [(rng.random(), 0.055 + 0.05 * rng.random(), 0.045 + 0.06 * rng.random()) for _ in range(3)]
    result: list[float] = []
    for i in range(length):
        # The two endpoint samples are deliberately identical. A transition is chained along this axis, so
        # an almost-periodic mask still shows as a small material-width step at every quad boundary.
        u = i / max(1, length - 1)
        p = 0.5
        for (frequency, weight), phase in zip(harmonics, phases):
            p += weight * math.sin(math.tau * frequency * u + phase)
        for center, width, depth in lobes:
            distance = min(abs(u - center), 1 - abs(u - center))
            if distance < width:
                p += depth * (0.5 + 0.5 * math.cos(math.pi * distance / width))
        result.append((0.5 + (min(0.80, max(0.20, p)) - 0.5) * amplitude) * cross_size)
    return result


def make_transition(a: Image.Image, b: Image.Image, axis: str, seed: int, softness: float = 3.0,
                    keep: int = 5, amplitude: float = 1.0) -> Image.Image:
    """Mix wrapping base tiles across a deterministic organic boundary."""
    a = a.convert("RGB")
    b = b.convert("RGB")
    if a.size != b.size or a.width != a.height:
        raise ValueError("transition inputs must be equal-size square images")
    size = a.width
    boundary = organic_boundary(size, size, seed, amplitude)
    out = Image.new("RGB", a.size)
    ap, bp, op = a.load(), b.load(), out.load()
    for y in range(size):
        for x in range(size):
            along, cross = (x, y) if axis == "horizontal" else (y, x)
            t = min(1.0, max(0.0, (cross - boundary[along]) / softness + 0.5))
            if cross < keep:
                t = 0.0
            elif cross >= size - keep:
                t = 1.0
            op[x, y] = tuple(round(ap[x, y][c] * (1 - t) + bp[x, y][c] * t) for c in range(3))
    return out


def open_rgb(path: str | Path) -> Image.Image:
    return Image.open(path).convert("RGB")
