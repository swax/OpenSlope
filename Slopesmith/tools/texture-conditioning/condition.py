"""Condition one generated source into a terrain-ready RGB PNG."""

from __future__ import annotations

import argparse
from pathlib import Path

from _tile import condition, open_rgb, seam_stats, verdict


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--size", type=int, default=128)
    parser.add_argument("--density", type=int, default=1)
    parser.add_argument("--axis", choices=("vertical", "horizontal"))
    parser.add_argument("--stripes", action="store_true")
    parser.add_argument("--lattice", action="store_true")
    parser.add_argument("--repair", action="store_true")
    args = parser.parse_args()
    source = open_rgb(args.source)
    before = seam_stats(source)
    output, rotated = condition(
        source, args.size, args.density, args.axis, args.stripes, args.repair, args.lattice,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    output.save(args.output, "PNG", optimize=True)
    after = seam_stats(output)
    print(f'{args.source.name}: {before["h_ratio"]:.2f}/{before["v_ratio"]:.2f} -> '
          f'{after["h_ratio"]:.2f}/{after["v_ratio"]:.2f} {verdict(after)}'
          f'{" rot90" if rotated else ""}; {output.width}x{output.height} RGB')


if __name__ == "__main__":
    main()
